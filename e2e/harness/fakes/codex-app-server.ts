/**
 * A running Codex, as the broker's Codex adapter meets it, for run-state tests.
 *
 * Three things make up "Codex is running a turn" from the broker's side, and this fake owns all of
 * them so a test can make them agree or disagree on purpose:
 *
 * - the shared app-server daemon (JSON-RPC over a WebSocket on a unix socket, the existing
 *   {@link FakeCodexDaemon}), serving `thread/loaded/list`, `thread/read`, `thread/turns/list` and
 *   `thread/resume` from a per-thread model, and pushing turn notifications on demand;
 * - the durable rollouts under `$CODEX_HOME/sessions/…`, which discovery, Observe tails and the
 *   repair channel read;
 * - terminals: a fake `/proc` root (`COSYNCING_CODEX_PROC_ROOT`) where a `codex resume <thread>
 *   --remote unix://<socket>` process is attributed to its thread (Linux only).
 *
 * The daemon runs in the test process, so every RPC the broker made is in `requests`.
 *
 *   const codex = await CodexAppServer.start(paths);   // in startBroker's `setup`
 *   env: () => codex.env
 *   const thread = codex.thread(THREAD, { loaded: true, status: 'idle' });
 *   const rollout = codex.writeRollout(THREAD, [codexStart('t1')]);
 *   codex.notify('turn/started', { threadId: THREAD, turn: { id: 't1' } });
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeCodexDaemon } from '../../../packages/typescript/broker/test/helpers/fake-codex-daemon.ts';
import type { FixturePaths } from '../broker.ts';

export type NativeThreadStatus = 'idle' | 'active' | 'waiting' | 'unknown';

export interface NativeTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ThreadModel {
  /** Listed by `thread/loaded/list`: the daemon holds this thread. */
  loaded: boolean;
  /** `thread.status.type` (`waiting` is `active` with `waitingOnApproval`; `unknown` reports none). */
  status: NativeThreadStatus;
  /** What `thread/read` with turns and `thread/turns/list` report, newest last. */
  turns: NativeTurn[];
  /** Replace the `thread/turns/list` answer (paging, a held page). */
  turnsList?: (params: any) => unknown | Promise<unknown>;
  /** Replace the whole `thread/read` answer (to tell the activity probe and a turns read apart). */
  read?: (params: any) => unknown | Promise<unknown>;
}

const DAY = '2026-08-03';
const at = (second: number): string => `${DAY}T00:00:${String(second).padStart(2, '0')}.000Z`;

/** One rollout record. */
export function codexRecord(type: string, payload: Record<string, unknown>, second = 1): Record<string, unknown> {
  return { timestamp: at(second), type, payload };
}
export const codexStart = (turnId: string): Record<string, unknown> =>
  codexRecord('event_msg', { type: 'task_started', turn_id: turnId }, 1);
export const codexComplete = (turnId: string): Record<string, unknown> =>
  codexRecord('event_msg', { type: 'task_complete', turn_id: turnId }, 9);
export const codexToolCall = (callId: string): Record<string, unknown> =>
  codexRecord('response_item', { type: 'function_call', call_id: callId, name: 'shell', arguments: '{}' }, 4);

export interface CodexRollout {
  readonly threadId: string;
  readonly path: string;
  /** The broker's session id for it: the rollout path, base64url. */
  readonly id: string;
  append(...records: Array<Record<string, unknown>>): void;
}

export class CodexAppServer {
  readonly socketPath: string;
  readonly codexHome: string;
  readonly procRoot: string;
  readonly workspace: string;
  readonly daemon: FakeCodexDaemon;
  readonly threads = new Map<string, ThreadModel>();
  #pid = 40_000;

  private constructor(paths: FixturePaths) {
    this.socketPath = join(paths.root, 'codex.sock');
    this.codexHome = join(paths.home, '.codex');
    this.procRoot = join(paths.root, 'proc');
    this.workspace = join(paths.home, 'workspace');
    for (const directory of [join(this.codexHome, 'sessions'), this.procRoot, this.workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    const threads = this.threads;
    const model = (params: any): ThreadModel | undefined => threads.get(String(params?.threadId ?? ''));
    this.daemon = new FakeCodexDaemon(this.socketPath, {
      // Read on every `thread/loaded/list`, so the list follows the model.
      get loadedThreadIds() {
        return [...threads].filter(([, thread]) => thread.loaded).map(([id]) => id);
      },
      resumeResult: (params) => {
        const thread = model(params);
        return {
          thread: {
            id: String(params?.threadId ?? ''),
            name: 'fake thread',
            ...(thread && thread.status !== 'unknown' ? { status: nativeStatus(thread.status) } : {}),
          },
          model: 'fake-model',
          modelProvider: 'fake-provider',
        };
      },
      readResult: (params) => {
        const thread = model(params);
        if (!thread) throw new Error(`thread ${String(params?.threadId)} is not loaded`);
        if (thread.read) return thread.read(params);
        return {
          thread: {
            id: String(params.threadId),
            ...(thread.status === 'unknown' ? {} : { status: nativeStatus(thread.status) }),
            ...(params?.includeTurns ? { turns: thread.turns } : {}),
          },
        };
      },
      turnsResult: (params) => {
        const thread = model(params);
        if (thread?.turnsList) return thread.turnsList(params);
        return { data: [...(thread?.turns ?? [])].reverse(), nextCursor: null };
      },
    });
  }

  /** Start the daemon in a fixture (before the broker starts, so its first poll finds it). */
  static async start(paths: FixturePaths): Promise<CodexAppServer> {
    const server = new CodexAppServer(paths);
    await server.daemon.start();
    return server;
  }

  /** The broker environment that points the Codex adapter here, polling at its fastest. */
  get env(): Record<string, string> {
    return {
      CODEX_HOME: this.codexHome,
      COSYNCING_CODEX_SYNC_SERVER: '1',
      COSYNCING_CODEX_APP_SERVER_SOCK: this.socketPath,
      COSYNCING_CODEX_SYNC_WATCH_MS: '250',
      COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS: '1',
      COSYNCING_CODEX_PROC_ROOT: this.procRoot,
    };
  }

  /** Create or change what the daemon reports for one thread. */
  thread(threadId: string, change: Partial<ThreadModel> = {}): ThreadModel {
    const current = this.threads.get(threadId) ?? { loaded: false, status: 'idle' as const, turns: [] };
    const next = { ...current, ...change };
    this.threads.set(threadId, next);
    return next;
  }

  notify(method: string, params: unknown): void {
    this.daemon.notify(method, params);
  }

  /** RPCs the broker made, optionally only `method`, from index `since` of the ledger. */
  calls(method?: string, since = 0): Array<{ method: string; params: any }> {
    return this.daemon.requests.slice(since).filter((request) => !method || request.method === method);
  }

  /** How many RPCs the broker has made so far: a cursor for {@link calls}. */
  get mark(): number {
    return this.daemon.requests.length;
  }

  /** Repair probes (`thread/read` with turns) for one thread since `since`. */
  repairReads(threadId: string, since = 0): number {
    return this.calls('thread/read', since).filter((call) => call.params?.threadId === threadId && call.params?.includeTurns === true).length;
  }

  /** Watcher polls (`thread/loaded/list`) since `since`. */
  polls(since = 0): number {
    return this.calls('thread/loaded/list', since).length;
  }

  /**
   * A rollout for `threadId` (a UUID). `parent` makes it a subagent thread spawned by that one;
   * `guardian` uses the native automatic approval review metadata instead of a spawned worker.
   */
  writeRollout(threadId: string, records: Array<Record<string, unknown>> = [], options: { parent?: string; guardian?: boolean } = {}): CodexRollout {
    const [year, month, date] = DAY.split('-');
    const directory = join(this.codexHome, 'sessions', year!, month!, date!);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-${DAY}T00-00-00-${threadId}.jsonl`);
    const meta = {
      id: threadId,
      cwd: this.workspace,
      ...(options.guardian
        ? { originator: 'codex-tui', thread_source: 'guardian_review', parent_thread_id: options.parent, source: { subagent: { other: 'guardian' } } }
        : options.parent
        ? { thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: options.parent, depth: 1 } } } }
        : {}),
    };
    writeFileSync(path, [codexRecord('session_meta', meta, 0), ...records].map(line).join(''));
    return {
      threadId,
      path,
      id: Buffer.from(path, 'utf8').toString('base64url'),
      append: (...more) => appendFileSync(path, more.map(line).join('')),
    };
  }

  /**
   * A Codex terminal running `codex resume <threadId> --remote unix://<socket>`, as the fake `/proc`
   * shows it: joined to this daemon (`shared`), or with `private`, to another one, so the daemon
   * cannot see its turn. Returns a function that ends it.
   */
  terminal(threadId: string, options: { private?: boolean } = {}): () => void {
    const directory = join(this.procRoot, String(++this.#pid));
    mkdirSync(directory, { recursive: true });
    const remote = options.private ? `unix://${this.socketPath}.private` : `unix://${this.socketPath}`;
    writeFileSync(join(directory, 'cmdline'), ['codex', 'resume', threadId, '--remote', remote, ''].join('\0'));
    return () => rmSync(directory, { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    await this.daemon.stop();
  }
}

function nativeStatus(status: NativeThreadStatus): Record<string, unknown> {
  if (status === 'waiting') return { type: 'active', activeFlags: ['waitingOnApproval'] };
  if (status === 'active') return { type: 'active', activeFlags: [] };
  return { type: status };
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}
