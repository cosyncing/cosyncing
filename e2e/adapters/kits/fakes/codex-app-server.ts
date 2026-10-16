/**
 * A fake Codex CLI: `codex app-server` (stdio and the managed daemon), the
 * daemon lifecycle commands, and the terminal clients a user runs beside it.
 *
 * The conformance kit (`kits/codex.ts`) compiles this file into a real
 * executable in a broker's `paths.bin` (`e2e/harness/fakes/executable.ts`), so
 * every process the broker inspects is a real process running a `codex`
 * binary: the daemon's PID receipt, `/proc/<pid>/exe` and argv, and a terminal's
 * `codex resume --remote unix://…` command line are what the product reads.
 * Imported, the module only exports the rollout writers the kit seeds stores
 * with, so the kit and the fake can never disagree on the store layout.
 *
 * Modes (argv after the executable):
 *   --version                         prints `codex-cli <version>`
 *   app-server --stdio                one JSON-RPC client on stdin/stdout
 *   app-server [--flags] --listen unix://
 *                                     the managed daemon: JSON-RPC over a
 *                                     WebSocket on $CODEX_HOME/app-server-control/
 *                                     app-server-control.sock, PID receipt in
 *                                     $CODEX_HOME/app-server-daemon/app-server.pid
 *   app-server daemon version|start|stop
 *   resume [--remote unix://SOCK] ID  a terminal: joins the daemon thread (with
 *                                     --remote) and stays until killed
 *   exec …                            a non-interactive run: stays until killed
 *
 * Behaviour is data, re-read on every request from the JSON config beside the
 * executable (`<executable>.json`). A prompt's own text scripts its turn:
 *
 *   [[permission]]      ask item/commandExecution/requestApproval first
 *   [[hold:TAG]]        keep the turn open until turn/interrupt or the control
 *                       file `release-TAG` appears
 *   [[background:TAG]]  start a command that outlives the turn; it finishes
 *                       when `release-TAG` appears
 *
 * The rollout is written the way Codex 0.14x writes it (session_meta, then per
 * turn task_started, turn_context, the user message pair, the assistant
 * message pair, task_complete or turn_aborted), and only for a thread started
 * with `historyMode: 'legacy'` (Codex 0.151+ writes nothing for an empty
 * thread otherwise). Everything observable goes to the ledger (JSONL): process
 * starts with argv, daemon connections, every inbound frame with the
 * connection it arrived on, and every reply to a request the fake made.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Json = Record<string, any>;

export interface FakeCodexModel {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort: string;
}

export interface FakeCodexAppServerConfig {
  /** JSONL ledger every fake process appends to. */
  ledger: string;
  /** Directory for `release-TAG` files. */
  controlDir: string;
  /** Version token printed by `--version` and reported by the daemon. */
  version: string;
  /** Replaces the whole `--version` output when set. */
  versionOutput?: string;
  /** The thread id the next `thread/start` answers with; a fresh UUIDv7 when absent. */
  nextThreadId?: string;
  /** The rollout the next `thread/start` answers with (a native that reuses a stored thread). */
  nextThreadPath?: string;
  /** The argv (after the executable) `daemon start` launches the daemon with. */
  daemonArgv: string[];
  /** `model/list`. The first entry is the default model. */
  models: FakeCodexModel[];
  /** `skills/list` for every workspace. */
  skills: Array<{ name: string; description: string }>;
  /** Fault knobs. */
  faults?: {
    /** The daemon accepts connections but answers nothing (a wedged daemon). */
    daemonSilent?: boolean;
  };
  /** A daemon outliving its fixture exits after this long (a leak guard, never a test timer). */
  daemonLifetimeMs?: number;
}

// ------------------------------------------------------------- store writers

export const DEFAULT_PROVIDER = 'openai';

/** A canonical lowercase UUIDv7, the id shape Codex mints. */
export function codexUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) bytes[index] = Number((now >> BigInt(8 * (5 - index))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`. */
export function codexRolloutPath(codexHome: string, id: string, at = new Date()): string {
  const iso = at.toISOString();
  const [date, time] = [iso.slice(0, 10), iso.slice(11, 19).replaceAll(':', '-')];
  const [year, month, day] = date.split('-');
  return join(codexHome, 'sessions', year!, month!, day!, `rollout-${date}T${time}-${id}.jsonl`);
}

/** The broker's session id for a rollout: its path, base64url. */
export function codexSessionId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url');
}

export interface CodexThreadSettings {
  model: string;
  modelProvider: string;
  effort: string;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandboxPolicy: Json;
}

export function defaultCodexSettings(cwd: string, model = 'gpt-5.6-sol'): CodexThreadSettings {
  return {
    model,
    modelProvider: DEFAULT_PROVIDER,
    effort: 'medium',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
}

export function sessionMetaRecord(meta: {
  id: string;
  cwd: string;
  originator?: string;
  threadSource?: string;
  parentThreadId?: string;
  modelProvider?: string;
  at?: Date;
}): Json {
  const timestamp = (meta.at ?? new Date()).toISOString();
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      id: meta.id,
      timestamp,
      cwd: meta.cwd,
      originator: meta.originator ?? 'codex_cli_rs',
      cli_version: '0.162.1',
      source: meta.threadSource === 'subagent' ? { subagent: 'thread_spawn' } : 'cli',
      thread_source: meta.threadSource ?? 'user',
      ...(meta.parentThreadId ? { parent_thread_id: meta.parentThreadId } : {}),
      model_provider: meta.modelProvider ?? DEFAULT_PROVIDER,
    },
  };
}

const stamp = (): string => new Date().toISOString();

/** What a turn's opening writes: the start marker and the settings it runs with. */
export function turnOpenRecords(turnId: string, cwd: string, settings: CodexThreadSettings): Json[] {
  return [
    { timestamp: stamp(), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, model_context_window: 258_400 } },
    {
      timestamp: stamp(),
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd,
        approval_policy: settings.approvalPolicy,
        approvals_reviewer: settings.approvalsReviewer,
        sandbox_policy: snakeSandbox(settings.sandboxPolicy),
        model: settings.model,
        effort: settings.effort,
        summary: 'auto',
      },
    },
  ];
}

export function userRecords(text: string): Json[] {
  return [
    { timestamp: stamp(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp: stamp(), type: 'event_msg', payload: { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] } },
  ];
}

/** The assistant pair: the event, then the response item carrying the native id (always adjacent). */
export function answerRecords(text: string, itemId: string): Json[] {
  return [
    { timestamp: stamp(), type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } },
    { timestamp: stamp(), type: 'response_item', payload: { type: 'message', role: 'assistant', id: itemId, content: [{ type: 'output_text', text }] } },
  ];
}

export function turnCompleteRecords(turnId: string, lastAgentMessage?: string): Json[] {
  return [{ timestamp: stamp(), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: lastAgentMessage ?? null } }];
}

export function turnAbortedRecords(turnId: string): Json[] {
  return [{ timestamp: stamp(), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' } }];
}

export function appendRecords(path: string, records: Json[]): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

/** Codex keeps thread names in `$CODEX_HOME/session_index.jsonl`, newest line wins. */
export function appendThreadName(codexHome: string, id: string, name: string): void {
  appendFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: name, updated_at: stamp() })}\n`);
}

function snakeSandbox(policy: Json): Json {
  if (policy?.type === 'workspaceWrite') {
    return {
      type: 'workspace-write',
      writable_roots: policy.writableRoots ?? [],
      network_access: !!policy.networkAccess,
      exclude_tmpdir_env_var: !!policy.excludeTmpdirEnvVar,
      exclude_slash_tmp: !!policy.excludeSlashTmp,
    };
  }
  if (policy?.type === 'dangerFullAccess') return { type: 'danger-full-access' };
  if (policy?.type === 'readOnly') return { type: 'read-only' };
  return policy;
}

function camelSandbox(policy: Json | undefined, cwd: string): Json {
  const type = String(policy?.type ?? '');
  if (type === 'danger-full-access' || type === 'dangerFullAccess') return { type: 'dangerFullAccess' };
  if (type === 'read-only' || type === 'readOnly') return { type: 'readOnly', networkAccess: false };
  return {
    type: 'workspaceWrite',
    writableRoots: policy?.writable_roots ?? policy?.writableRoots ?? [cwd],
    networkAccess: !!(policy?.network_access ?? policy?.networkAccess),
    excludeTmpdirEnvVar: !!(policy?.exclude_tmpdir_env_var ?? policy?.excludeTmpdirEnvVar),
    excludeSlashTmp: !!(policy?.exclude_slash_tmp ?? policy?.excludeSlashTmp),
  };
}

// ------------------------------------------------------------------ program

function runFakeCodex(): void {
  // Resolved once: a renamed (uninstalled) executable keeps serving from the config it started with.
  const configPath = `${process.execPath}.json`;
  const readConfig = (): FakeCodexAppServerConfig => JSON.parse(readFileSync(configPath, 'utf8'));
  const startConfig = readConfig();
  const ledgerPath = startConfig.ledger;
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
  const receiptPath = join(codexHome, 'app-server-daemon', 'app-server.pid');
  const args = process.argv.slice(2);

  const record = (entry: Json): void => {
    try {
      appendFileSync(ledgerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
    } catch {
      // The fixture is gone; nothing is listening any more.
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const released = (tag: string, cancelled: () => boolean): Promise<'released' | 'cancelled'> => new Promise((resolve) => {
    const tick = (): void => {
      if (cancelled()) return resolve('cancelled');
      if (existsSync(join(startConfig.controlDir, `release-${tag}`))) return resolve('released');
      setTimeout(tick, 20);
    };
    tick();
  });

  // --------------------------------------------------------------- engine

  interface Conn {
    readonly id: number;
    readonly transport: 'stdio' | 'daemon';
    send(message: Json): void;
    clientName?: string;
    /** Replies to requests this fake made, by request id. */
    readonly awaiting: Map<string, (frame: Json) => void>;
    closed: boolean;
  }

  interface Background {
    itemId: string;
    processId: string;
    command: string;
    cwd: string;
    turnId: string;
    tag: string;
    startedAtMs: number;
  }

  interface Turn {
    id: string;
    startedAt: number;
    inputs: Array<{ text: string; itemId: string; clientId?: string }>;
    interrupted: boolean;
    finished: boolean;
  }

  interface Thread {
    id: string;
    path: string;
    cwd: string;
    name?: string;
    legacyHistory: boolean;
    settings: CodexThreadSettings;
    turn?: Turn;
    history: Array<{ id: string; status: string; startedAt: number; completedAt?: number }>;
    subscribers: Set<Conn>;
    background: Map<string, Background>;
  }

  const threads = new Map<string, Thread>();
  let requestSerial = 0;
  let itemSerial = 0;

  const notify = (thread: Thread, method: string, params: Json): void => {
    for (const conn of thread.subscribers) if (!conn.closed) conn.send({ method, params: { threadId: thread.id, ...params } });
  };

  const persist = (thread: Thread, records: Json[]): void => {
    if (!thread.legacyHistory && !existsSync(thread.path)) return;
    appendRecords(thread.path, records);
  };

  const threadView = (thread: Thread, includeTurns = false): Json => ({
    id: thread.id,
    path: thread.path,
    cwd: thread.cwd,
    name: thread.name ?? null,
    modelProvider: thread.settings.modelProvider,
    status: thread.turn && !thread.turn.finished ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    turns: includeTurns ? turnsView(thread) : [],
  });

  const turnsView = (thread: Thread): Json[] => [
    ...thread.history.map((turn) => ({ id: turn.id, status: turn.status, startedAt: turn.startedAt / 1000, completedAt: (turn.completedAt ?? 0) / 1000, items: [] })),
    ...(thread.turn && !thread.turn.finished ? [{ id: thread.turn.id, status: 'inProgress', startedAt: thread.turn.startedAt / 1000, items: [] }] : []),
  ];

  const settingsView = (thread: Thread): Json => ({
    model: thread.settings.model,
    modelProvider: thread.settings.modelProvider,
    reasoningEffort: thread.settings.effort,
    approvalPolicy: thread.settings.approvalPolicy,
    approvalsReviewer: thread.settings.approvalsReviewer,
    sandbox: thread.settings.sandboxPolicy,
    cwd: thread.cwd,
  });

  /** Load a stored rollout the way `thread/resume` does: identity from session_meta, settings from the tail. */
  const loadThread = (threadId: string, path: string | undefined): Thread | undefined => {
    const known = threads.get(threadId);
    if (known) return known;
    const file = path && existsSync(path) ? path : findRollout(threadId);
    if (!file) return undefined;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const meta = lines.find((line) => line.type === 'session_meta')?.payload ?? {};
    if (String(meta.id ?? '') !== threadId) return undefined;
    const cwd = String(meta.cwd ?? process.cwd());
    const context = lines.findLast((line) => line.type === 'turn_context')?.payload;
    const settings = defaultCodexSettings(cwd, readConfig().models[0]?.id);
    if (context) {
      if (context.model) settings.model = String(context.model);
      if (context.effort) settings.effort = String(context.effort);
      if (context.approval_policy !== undefined) settings.approvalPolicy = context.approval_policy;
      if (context.approvals_reviewer) settings.approvalsReviewer = String(context.approvals_reviewer);
      if (context.sandbox_policy) settings.sandboxPolicy = camelSandbox(context.sandbox_policy, cwd);
    }
    if (meta.model_provider) settings.modelProvider = String(meta.model_provider);
    const thread: Thread = {
      id: threadId,
      path: file,
      cwd,
      legacyHistory: true,
      settings,
      history: [],
      subscribers: new Set(),
      background: new Map(),
    };
    threads.set(threadId, thread);
    return thread;
  };

  const findRollout = (threadId: string): string | undefined => {
    const root = join(codexHome, 'sessions');
    try {
      for (const entry of readdirSync(root, { recursive: true }) as string[]) {
        if (basename(entry).endsWith(`-${threadId}.jsonl`)) return join(root, entry);
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const request = (thread: Thread, method: string, params: Json): Promise<{ frame: Json; conn: Conn }> => {
    const id = `permission-${process.pid}-${++requestSerial}`;
    return new Promise((resolve) => {
      const targets = [...thread.subscribers].filter((conn) => !conn.closed);
      for (const conn of targets) {
        conn.awaiting.set(id, (frame) => {
          for (const other of targets) other.awaiting.delete(id);
          resolve({ frame, conn });
        });
        conn.send({ id, method, params: { threadId: thread.id, ...params } });
      }
    });
  };

  const emitUser = (thread: Thread, turn: Turn, input: Turn['inputs'][number]): void => {
    const item = { type: 'userMessage', id: input.itemId, ...(input.clientId ? { clientId: input.clientId } : {}), content: [{ type: 'text', text: input.text, text_elements: [] }] };
    persist(thread, userRecords(input.text));
    notify(thread, 'item/started', { turnId: turn.id, item });
    notify(thread, 'item/completed', { turnId: turn.id, item });
  };

  const answer = (thread: Thread, turn: Turn, text: string): void => {
    const itemId = `msg_${process.pid}_${++itemSerial}`;
    notify(thread, 'item/started', { turnId: turn.id, item: { type: 'agentMessage', id: itemId, text: '' } });
    notify(thread, 'item/agentMessage/delta', { turnId: turn.id, itemId, delta: text });
    persist(thread, answerRecords(text, itemId));
    notify(thread, 'item/completed', { turnId: turn.id, item: { type: 'agentMessage', id: itemId, text } });
  };

  const finishTurn = (thread: Thread, turn: Turn, status: 'completed' | 'interrupted', lastAnswer?: string): void => {
    if (turn.finished) return;
    turn.finished = true;
    const completedAt = Date.now();
    persist(thread, status === 'completed' ? turnCompleteRecords(turn.id, lastAnswer) : turnAbortedRecords(turn.id));
    thread.history.push({ id: turn.id, status, startedAt: turn.startedAt, completedAt });
    if (thread.turn === turn) thread.turn = undefined;
    notify(thread, 'turn/completed', {
      turn: { id: turn.id, status, startedAt: new Date(turn.startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(), items: [], error: null },
    });
    notify(thread, 'thread/status/changed', { status: { type: 'idle' } });
  };

  const visible = (text: string): string => text.replace(/\[\[[^\]]*\]\]/g, '').trim();

  const runTurn = async (thread: Thread, turn: Turn): Promise<void> => {
    const first = turn.inputs[0]!.text;
    let outcome = '';
    if (first.includes('[[permission]]')) {
      const itemId = `call_perm_${++itemSerial}`;
      const pending = request(thread, 'item/commandExecution/requestApproval', {
        turnId: turn.id,
        itemId,
        command: 'touch fixture.txt',
        cwd: thread.cwd,
        reason: 'The fixture asks to run one command.',
      });
      notify(thread, 'thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
      const { frame, conn } = await pending;
      // Every other client of the thread learns the request is settled (a synced terminal, another tab).
      for (const other of thread.subscribers) {
        if (other !== conn && !other.closed) other.send({ method: 'serverRequest/resolved', params: { threadId: thread.id, requestId: frame.id } });
      }
      notify(thread, 'thread/status/changed', { status: { type: 'active', activeFlags: [] } });
      const decision = frame.result?.decision;
      outcome = ` (permission ${typeof decision === 'string' ? decision : JSON.stringify(decision ?? frame.error ?? null)})`;
    }
    const background = /\[\[background:([\w-]+)\]\]/.exec(first)?.[1];
    if (background) startBackground(thread, turn, background);
    const hold = /\[\[hold:([\w-]+)\]\]/.exec(first)?.[1];
    if (hold && (await released(hold, () => turn.interrupted)) === 'cancelled') {
      finishTurn(thread, turn, 'interrupted');
      return;
    }
    if (turn.interrupted) {
      finishTurn(thread, turn, 'interrupted');
      return;
    }
    // Every input the turn received (the opening prompt, then each steer) is answered in order.
    let last = '';
    for (let index = 0; index < turn.inputs.length; index += 1) {
      last = `answer: ${visible(turn.inputs[index]!.text)}${index === 0 ? outcome : ''}`;
      answer(thread, turn, last);
    }
    finishTurn(thread, turn, 'completed', last);
  };

  const startBackground = (thread: Thread, turn: Turn, tag: string): void => {
    const entry: Background = {
      itemId: `call_bg_${++itemSerial}`,
      processId: `${10_000 + itemSerial}`,
      command: `fixture-server --tag ${tag}`,
      cwd: thread.cwd,
      turnId: turn.id,
      tag,
      startedAtMs: Date.now(),
    };
    thread.background.set(entry.itemId, entry);
    const item = { type: 'commandExecution', id: entry.itemId, processId: entry.processId, command: entry.command, cwd: entry.cwd, source: 'unifiedExecStartup', status: 'inProgress' };
    notify(thread, 'item/started', { turnId: turn.id, startedAtMs: entry.startedAtMs, item });
    notify(thread, 'item/commandExecution/outputDelta', { turnId: turn.id, itemId: entry.itemId, delta: 'listening\n' });
    void released(tag, () => false).then(() => {
      thread.background.delete(entry.itemId);
      const completedAtMs = Date.now();
      notify(thread, 'item/completed', {
        turnId: turn.id,
        completedAtMs,
        item: { ...item, status: 'completed', exitCode: 0, durationMs: completedAtMs - entry.startedAtMs, aggregatedOutput: 'listening\nstopped\n' },
      });
    });
  };

  const handle = async (conn: Conn, frame: Json): Promise<void> => {
    record({ kind: 'recv', conn: conn.id, transport: conn.transport, frame });
    if (frame.method === undefined && frame.id !== undefined) {
      const resolve = conn.awaiting.get(String(frame.id));
      conn.awaiting.delete(String(frame.id));
      resolve?.(frame);
      return;
    }
    const config = readConfig();
    if (conn.transport === 'daemon' && config.faults?.daemonSilent) return;
    const reply = (result: unknown): void => {
      if (frame.id !== undefined) conn.send({ id: frame.id, result });
    };
    const fail = (message: string, code = -32600, data?: unknown): void => {
      if (frame.id !== undefined) conn.send({ id: frame.id, error: { code, message, ...(data ? { data } : {}) } });
    };
    const params: Json = frame.params ?? {};
    const threadOf = (): Thread | undefined => threads.get(String(params.threadId ?? ''));
    switch (frame.method) {
      case 'initialize':
        conn.clientName = String(params.clientInfo?.name ?? '');
        reply({ userAgent: `codex_cli_rs/${config.version}` });
        return;
      case 'initialized':
        return;
      case 'thread/loaded/list':
        reply({ data: [...threads.keys()], nextCursor: null });
        return;
      case 'thread/unsubscribe': {
        // The connection stops receiving the thread's events; the last subscriber leaving unloads it.
        const thread = threadOf();
        if (!thread) return reply({ status: 'notLoaded' });
        if (!thread.subscribers.delete(conn)) return reply({ status: 'notSubscribed' });
        if (thread.subscribers.size === 0) threads.delete(thread.id);
        reply({ status: 'unsubscribed' });
        return;
      }
      case 'thread/read': {
        const thread = threadOf();
        if (!thread) return fail(`thread not loaded: ${String(params.threadId)}`);
        reply({ thread: threadView(thread, params.includeTurns === true) });
        return;
      }
      case 'thread/turns/list': {
        const thread = threadOf();
        if (!thread) return fail(`thread not loaded: ${String(params.threadId)}`);
        const turns = turnsView(thread);
        const ordered = params.sortDirection === 'asc' ? turns : [...turns].reverse();
        reply({ data: ordered.slice(0, Number(params.limit ?? 50)), nextCursor: null });
        return;
      }
      case 'thread/start': {
        const id = config.nextThreadId ?? codexUuid();
        const prepared = config.nextThreadPath;
        if (config.nextThreadId || config.nextThreadPath) {
          const next = readConfig();
          delete next.nextThreadId;
          delete next.nextThreadPath;
          writeConfig(next);
        }
        const cwd = String(params.cwd ?? process.cwd());
        const settings = defaultCodexSettings(cwd, params.model ? String(params.model) : config.models[0]?.id);
        if (params.modelProvider) settings.modelProvider = String(params.modelProvider);
        const thread: Thread = {
          id,
          path: prepared ?? codexRolloutPath(codexHome, id),
          cwd,
          legacyHistory: params.historyMode === 'legacy',
          settings,
          history: [],
          subscribers: new Set([conn]),
          background: new Map(),
        };
        threads.set(id, thread);
        record({ kind: 'writer', conn: conn.id, transport: conn.transport, threadId: id, cwd, argv: [process.execPath, ...args] });
        // A prepared path that already holds a rollout is a native reusing a stored thread.
        if (thread.legacyHistory && !existsSync(thread.path)) {
          appendRecords(thread.path, [sessionMetaRecord({
            id,
            cwd,
            originator: String(params.serviceName ?? conn.clientName ?? 'codex_cli_rs'),
            modelProvider: settings.modelProvider,
          })]);
        }
        const now = Math.floor(Date.now() / 1000);
        reply({ thread: { ...threadView(thread), createdAt: now, updatedAt: now }, ...settingsView(thread) });
        return;
      }
      case 'thread/name/set': {
        const thread = threadOf();
        if (!thread) return fail(`thread not loaded: ${String(params.threadId)}`);
        thread.name = String(params.name ?? '');
        appendThreadName(codexHome, thread.id, thread.name);
        reply({});
        return;
      }
      case 'thread/settings/update': {
        const thread = threadOf();
        if (!thread) return fail(`thread not loaded: ${String(params.threadId)}`);
        if (params.model) thread.settings.model = String(params.model);
        if (params.modelProvider) thread.settings.modelProvider = String(params.modelProvider);
        if (params.effort) thread.settings.effort = String(params.effort);
        if (params.approvalPolicy !== undefined) thread.settings.approvalPolicy = params.approvalPolicy;
        if (params.approvalsReviewer) thread.settings.approvalsReviewer = String(params.approvalsReviewer);
        if (params.sandboxPolicy) thread.settings.sandboxPolicy = params.sandboxPolicy;
        reply({});
        notify(thread, 'thread/settings/updated', {
          threadSettings: {
            approvalPolicy: thread.settings.approvalPolicy,
            approvalsReviewer: thread.settings.approvalsReviewer,
            sandboxPolicy: thread.settings.sandboxPolicy,
            model: thread.settings.model,
            modelProvider: thread.settings.modelProvider,
            reasoningEffort: thread.settings.effort,
          },
        });
        return;
      }
      case 'thread/resume': {
        const threadId = String(params.threadId ?? '');
        const thread = loadThread(threadId, params.path ? String(params.path) : undefined);
        if (!thread) return fail(`no rollout found for thread id ${threadId}`, -32600);
        thread.subscribers.add(conn);
        record({ kind: 'writer', conn: conn.id, transport: conn.transport, threadId, cwd: thread.cwd, argv: [process.execPath, ...args] });
        const turns = turnsView(thread);
        reply({
          thread: threadView(thread),
          ...settingsView(thread),
          initialTurnsPage: { data: turns.slice(-1), nextCursor: null },
        });
        return;
      }
      case 'turn/start': {
        const thread = threadOf();
        if (!thread) return fail(`thread not loaded: ${String(params.threadId)}`);
        if (thread.turn && !thread.turn.finished) return fail('a turn is already in progress', -32600);
        if (params.model) thread.settings.model = String(params.model);
        if (params.modelProvider) thread.settings.modelProvider = String(params.modelProvider);
        if (params.effort) thread.settings.effort = String(params.effort);
        if (params.approvalPolicy !== undefined) thread.settings.approvalPolicy = params.approvalPolicy;
        if (params.approvalsReviewer) thread.settings.approvalsReviewer = String(params.approvalsReviewer);
        if (params.sandboxPolicy) thread.settings.sandboxPolicy = params.sandboxPolicy;
        const turn: Turn = {
          id: `turn_${process.pid}_${++itemSerial}`,
          startedAt: Date.now(),
          inputs: [{ text: inputText(params.input), itemId: codexUuid(), clientId: params.clientUserMessageId }],
          interrupted: false,
          finished: false,
        };
        thread.turn = turn;
        reply({ turn: { id: turn.id, status: 'inProgress', items: [], error: null } });
        persist(thread, turnOpenRecords(turn.id, thread.cwd, thread.settings));
        notify(thread, 'thread/status/changed', { status: { type: 'active', activeFlags: [] } });
        notify(thread, 'turn/started', { turn: { id: turn.id, status: 'inProgress', startedAt: new Date(turn.startedAt).toISOString(), items: [] } });
        emitUser(thread, turn, turn.inputs[0]!);
        void runTurn(thread, turn).catch((error) => record({ kind: 'fault', message: String(error) }));
        return;
      }
      case 'turn/steer': {
        const thread = threadOf();
        const turn = thread?.turn;
        if (!thread || !turn || turn.finished || turn.id !== String(params.expectedTurnId ?? '')) {
          return fail('expected active turn does not match', -32600, { code: 'expected_active_turn' });
        }
        const input = { text: inputText(params.input), itemId: codexUuid(), clientId: params.clientUserMessageId };
        turn.inputs.push(input);
        reply({ turnId: turn.id });
        emitUser(thread, turn, input);
        return;
      }
      case 'turn/interrupt': {
        const thread = threadOf();
        const turn = thread?.turn;
        if (turn && turn.id === String(params.turnId ?? '')) turn.interrupted = true;
        reply({});
        return;
      }
      case 'thread/backgroundTerminals/list': {
        const thread = threadOf();
        const rows = [...(thread?.background.values() ?? [])].map((entry) => ({
          itemId: entry.itemId, processId: entry.processId, command: entry.command, cwd: entry.cwd,
        }));
        reply({ data: rows, nextCursor: null });
        return;
      }
      case 'thread/items/list':
        reply({ data: [], nextCursor: null });
        return;
      case 'thread/goal/get':
        reply({ goal: null });
        return;
      case 'thread/compact/start': {
        const thread = threadOf();
        reply({});
        if (thread) notify(thread, 'thread/compacted', {});
        return;
      }
      case 'skills/list':
        reply({
          data: (Array.isArray(params.cwds) ? params.cwds : [process.cwd()]).map((cwd: string) => ({
            cwd,
            skills: config.skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              shortDescription: skill.description,
              path: join(cwd, '.codex', 'skills', skill.name, 'SKILL.md'),
              enabled: true,
            })),
            errors: [],
          })),
        });
        return;
      case 'model/list':
        reply({
          data: config.models.map((model, index) => ({
            id: model.id,
            model: model.id,
            displayName: model.displayName,
            description: `${model.displayName} (fixture)`,
            supportedReasoningEfforts: model.efforts.map((effort) => ({ reasoningEffort: effort, description: effort })),
            defaultReasoningEffort: model.defaultEffort,
            isDefault: index === 0,
            hidden: false,
          })),
          nextCursor: null,
        });
        return;
      case 'config/read':
        reply({ config: { model: config.models[0]?.id, model_provider: DEFAULT_PROVIDER } });
        return;
      default:
        record({ kind: 'unimplemented', conn: conn.id, method: frame.method });
        fail(`fake codex does not implement ${String(frame.method)}`, -32601);
    }
  };

  const writeConfig = (next: FakeCodexAppServerConfig): void => {
    const pending = `${configPath}.${process.pid}`;
    writeFileSync(pending, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(pending, configPath);
  };

  const dropConn = (conn: Conn): void => {
    conn.closed = true;
    for (const thread of threads.values()) thread.subscribers.delete(conn);
  };

  // -------------------------------------------------------------- stdio mode

  const serveStdio = (): void => {
    const conn: Conn = {
      id: 1,
      transport: 'stdio',
      awaiting: new Map(),
      closed: false,
      send: (message) => {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      },
    };
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame: Json;
        try {
          frame = JSON.parse(line);
        } catch (error) {
          record({ kind: 'fault', message: String(error), line });
          continue;
        }
        void handle(conn, frame).catch((error) => record({ kind: 'fault', message: String(error) }));
      }
    });
    // The broker owns a stdio app-server through its stdin: when the pipe closes the fake exits.
    process.stdin.on('end', () => {
      dropConn(conn);
      record({ kind: 'exit', reason: 'stdin-closed' });
      process.exit(0);
    });
  };

  // ------------------------------------------------------------- daemon mode

  const runDaemon = async (): Promise<void> => {
    mkdirSync(dirname(socketPath), { recursive: true });
    rmSync(socketPath, { force: true });
    let serial = 0;
    const server = createServer((socket) => {
      const conn = webSocketConn(socket, ++serial, (frame) => {
        void handle(conn, frame).catch((error) => record({ kind: 'fault', message: String(error) }));
      }, () => dropConn(conn));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    // The receipt goes last: it is what says the daemon is up.
    mkdirSync(dirname(receiptPath), { recursive: true });
    const pending = `${receiptPath}.${process.pid}`;
    writeFileSync(pending, JSON.stringify({ pid: process.pid, processStartTime: processStartTime(process.pid) }), { mode: 0o600 });
    renameSync(pending, receiptPath);
    record({ kind: 'daemon-started', argv: process.argv.slice(1), version: startConfig.version });
    const shutdown = (): void => {
      record({ kind: 'daemon-sigterm' });
      server.close();
      rmSync(socketPath, { force: true });
      // A clean shutdown takes its receipt with it; a killed daemon leaves a stale one behind.
      try {
        if (JSON.parse(readFileSync(receiptPath, 'utf8'))?.pid === process.pid) rmSync(receiptPath, { force: true });
      } catch {
        // No receipt to clean up.
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    // Leak guard: a daemon whose fixture is gone, or that outlived any test, exits by itself.
    const bornAt = Date.now();
    const lifetime = startConfig.daemonLifetimeMs ?? 15 * 60_000;
    setInterval(() => {
      if (!existsSync(configPath) || Date.now() - bornAt > lifetime) shutdown();
    }, 1_000);
  };

  const webSocketConn = (socket: Socket, id: number, onFrame: (frame: Json) => void, onClose: () => void): Conn => {
    let ready = false;
    let handshake = Buffer.alloc(0);
    let buffer = Buffer.alloc(0);
    const conn: Conn = {
      id,
      transport: 'daemon',
      awaiting: new Map(),
      closed: false,
      send: (message) => {
        if (!ready || conn.closed) return;
        try {
          socket.write(serverFrame(Buffer.from(JSON.stringify(message), 'utf8')));
        } catch {
          // The client went away mid-push.
        }
      },
    };
    const consume = (chunk: Buffer): void => {
      if (!ready) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = handshake.subarray(0, end).toString('utf8');
        const key = /sec-websocket-key:\s*(\S+)/i.exec(header)?.[1] ?? '';
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
        ready = true;
        record({ kind: 'connect', conn: id });
        const rest = handshake.subarray(end + 4);
        if (rest.length) consume(rest);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = readClientFrame(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.bytes);
        if (parsed.opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (parsed.opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]));
          continue;
        }
        if (parsed.opcode !== 0x1) continue;
        let frame: Json;
        try {
          frame = JSON.parse(parsed.payload.toString('utf8'));
        } catch {
          continue;
        }
        onFrame(frame);
      }
    };
    socket.on('data', (chunk) => consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (conn.closed) return;
      conn.closed = true;
      record({ kind: 'disconnect', conn: id });
      onClose();
    });
    return conn;
  };

  // ------------------------------------------------------ daemon lifecycle

  const receipt = (): { pid: number } | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
      return typeof parsed?.pid === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (process.platform !== 'linux') return true;
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim()[0] !== 'Z';
    } catch {
      return false;
    }
  };

  const runningDaemon = (): number | undefined => {
    const named = receipt()?.pid;
    return named !== undefined && alive(named) && existsSync(socketPath) ? named : undefined;
  };

  const daemonCommand = async (command: string | undefined): Promise<number> => {
    record({ kind: 'cli', argv: args });
    const config = readConfig();
    if (command === 'version') {
      const pid = runningDaemon();
      if (!pid) {
        process.stderr.write('codex app-server daemon is not running\n');
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ status: 'running', cliVersion: config.version, appServerVersion: config.version, socketPath, backend: 'pid', pid })}\n`);
      return 0;
    }
    if (command === 'start') {
      if (runningDaemon()) return 0;
      const log = openSync(join(dirname(ledgerPath), 'daemon.log'), 'a');
      const child = Bun.spawn([process.execPath, ...config.daemonArgv], {
        cwd: homedir(),
        env: process.env,
        stdin: 'ignore',
        stdout: log,
        stderr: log,
      });
      child.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (receipt()?.pid === child.pid && existsSync(socketPath)) return 0;
        if (child.exitCode !== null) break;
        await sleep(20);
      }
      process.stderr.write('fake codex: the daemon did not come up\n');
      return 1;
    }
    if (command === 'stop') {
      const pid = runningDaemon();
      if (!pid) return 0;
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + 10_000;
      while (alive(pid) && Date.now() < deadline) await sleep(20);
      return alive(pid) ? 1 : 0;
    }
    // The broker never hands a restart to the native command: it verifies the receipt itself.
    process.stderr.write(`fake codex: refusing daemon ${String(command)}\n`);
    return 3;
  };

  // ---------------------------------------------------- terminal clients

  /** `codex resume [--remote unix://SOCK] ID`: a TUI. With --remote it joins the thread on that daemon. */
  const runTerminal = async (): Promise<void> => {
    const remoteIndex = args.indexOf('--remote');
    const remote = remoteIndex >= 0 ? args[remoteIndex + 1] : args.find((arg) => arg.startsWith('--remote='))?.slice(9);
    const threadId = args.filter((arg) => /^[0-9a-f-]{36}$/i.test(arg)).at(-1);
    record({ kind: 'terminal-start', argv: args, remote: remote ?? null, threadId: threadId ?? null });
    if (remote?.startsWith('unix://') && threadId) {
      const socket = connect(remote.slice('unix://'.length));
      const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
      socket.on('connect', () => {
        socket.write(['GET / HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
        const send = (message: Json): void => {
          socket.write(clientFrame(Buffer.from(JSON.stringify(message), 'utf8')));
        };
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', title: 'Codex', version: startConfig.version } } });
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/resume', params: { threadId } });
      });
      socket.on('error', (error) => record({ kind: 'terminal-error', message: String(error) }));
    }
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {
      if (!existsSync(configPath)) process.exit(0);
    }, 1_000);
  };

  // ------------------------------------------------------------- dispatch

  const main = async (): Promise<void> => {
    if (args[0] === '--version') {
      record({ kind: 'version-probe', argv: args });
      const config = readConfig();
      process.stdout.write(config.versionOutput ?? `codex-cli ${config.version}\n`);
      process.exit(0);
    }
    if (args[0] === 'app-server' && args[1] === 'daemon') process.exit(await daemonCommand(args[2]));
    if (args[0] === 'app-server' && args.includes('--listen')) {
      record({ kind: 'process-start', mode: 'daemon', argv: args, cwd: process.cwd() });
      await runDaemon();
      return;
    }
    if (args[0] === 'app-server') {
      record({ kind: 'process-start', mode: 'stdio', argv: args, cwd: process.cwd() });
      serveStdio();
      return;
    }
    if (args.includes('resume') || args[0] === 'exec') {
      await runTerminal();
      return;
    }
    record({ kind: 'unimplemented', argv: args });
    process.stderr.write(`fake codex: unsupported ${args.join(' ')}\n`);
    process.exit(2);
  };

  void main();
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input.map((part: Json) => (part?.type === 'skill' ? `/${String(part.name)}` : String(part?.text ?? ''))).filter(Boolean).join(' ');
}

function processStartTime(pid: number): string {
  if (process.platform === 'win32') return String(Date.now());
  const ps = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
  return ps.stdout.toString().trim().replace(/\s+/g, ' ');
}

function serverFrame(payload: Buffer): Buffer {
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65_536
      ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : (() => {
          const head = Buffer.alloc(10);
          head[0] = 0x81;
          head[1] = 127;
          head.writeBigUInt64BE(BigInt(payload.length), 2);
          return head;
        })();
  return Buffer.concat([head, payload]);
}

function clientFrame(payload: Buffer): Buffer {
  const mask = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, masked]);
}

function readClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; bytes: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!;
  return { opcode, payload, bytes: offset + length };
}

if (import.meta.main) runFakeCodex();
