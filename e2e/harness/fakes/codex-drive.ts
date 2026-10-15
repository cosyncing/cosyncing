/**
 * A fake `codex` whose `app-server --stdio` is a drivable Resume owner, and
 * the native rollouts it serves.
 *
 * With sync-server mode off, the broker's Codex adapter drives a session by
 * starting its own `codex app-server --stdio` (the Resume owner) and runs a
 * short-lived one for a native rename or fork. This fake answers what those
 * need: `initialize`, `thread/resume`, `turn/start` (then completes the turn),
 * `thread/name/set` and `thread/fork` (which writes the fork's rollout, as
 * Codex does). Every process it starts and every request it answers lands in
 * an event ledger, so a test can say how many Resume owners the broker
 * started, which one a prompt reached, and when one exited.
 *
 *   const codex = installCodexDriveFake(paths);
 *   const session = codex.rollout('work');
 *   codex.owners(session.threadId)    // pids, one per Resume owner started for it
 *   codex.prompts()                   // [{ pid, text }]
 *   codex.holdStop(true)              // SIGTERM is acknowledged but the process stays up …
 *   codex.releaseStop()               // … until this
 *
 * A competing terminal is staged in a fake `/proc` (the broker reads it
 * through `COSYNCING_CODEX_PROC_ROOT`), so presence arbitration sees exactly
 * what the test wrote and never the host's real processes.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePaths } from '../broker.ts';
import { installFakeCommand } from './command.ts';

export interface CodexDriveEvent {
  pid: number;
  event: 'spawn' | 'request' | 'sigterm' | 'sigterm-held' | 'exit';
  argv?: string[];
  method?: string;
  params?: any;
}

export interface CodexRollout {
  /** The native thread id (the rollout's `session_meta.id`). */
  threadId: string;
  path: string;
  /** The broker's session id: the rollout path, base64url. */
  id: string;
  cwd: string;
}

/** The fake's program. `argv`, `ledgerPath` are in scope (see command.ts). */
const PROGRAM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(ledgerPath);
const events = path.join(dir, 'codex.events.jsonl');
const control = path.join(dir, 'codex.control.json');
const release = path.join(dir, 'codex.release');
const record = (entry) => fs.appendFileSync(events, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
const controlState = () => {
  try { return JSON.parse(fs.readFileSync(control, 'utf8')); } catch { return {}; }
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.150.0\n');
  process.exit(0);
}
if (!(argv[0] === 'app-server' && argv.includes('--stdio'))) process.exit(0);

record({ event: 'spawn', argv });
let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  record({ event: 'exit' });
  process.exit(0);
};
process.on('SIGTERM', () => {
  if (!controlState().holdStop) {
    record({ event: 'sigterm' });
    exit();
    return;
  }
  // Acknowledge the stop, then stay up until the test releases it.
  record({ event: 'sigterm-held' });
  const timer = setInterval(() => {
    if (fs.existsSync(release)) {
      clearInterval(timer);
      exit();
    }
  }, 20);
});

let turns = 0;
let forks = 0;
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
function answer(message) {
  const params = message.params || {};
  switch (message.method) {
    case 'initialize':
      return { userAgent: 'codex-drive-fake/0.150.0' };
    case 'thread/loaded/list':
      return { data: [], nextCursor: null };
    case 'thread/resume':
      return {
        thread: { id: params.threadId, name: 'fake', status: { type: 'idle' }, turns: [] },
        model: 'fake-model',
        modelProvider: 'openai',
      };
    case 'turn/start': {
      const turnId = 'turn-' + process.pid + '-' + (++turns);
      setImmediate(() => send({
        method: 'turn/completed',
        params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } },
      }));
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    }
    case 'thread/fork': {
      const forkId = '00000000-0000-4000-8000-' + (process.pid * 100 + (++forks)).toString(16).padStart(12, '0');
      const day = path.join(codexHome, 'sessions', '2026', '07', '29');
      fs.mkdirSync(day, { recursive: true });
      const forkPath = path.join(day, 'rollout-2026-07-29T00-00-00-' + forkId + '.jsonl');
      const cwd = params.cwd || process.cwd();
      fs.writeFileSync(forkPath, JSON.stringify({
        timestamp: '2026-07-29T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: forkId, cwd, forked_from_id: params.threadId },
      }) + '\n');
      return {
        thread: { id: forkId, forkedFromId: params.threadId, path: forkPath, cwd, name: 'Forked thread', turns: [] },
        cwd,
      };
    }
    default:
      return {};
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    if (!message.method) continue;
    record({ event: 'request', method: message.method, params: message.params });
    if (message.id === undefined || message.id === null) continue;
    send({ id: message.id, result: answer(message) });
  }
});
process.stdin.on('end', exit);
process.stdin.resume();
`;

export class CodexDriveFake {
  readonly path: string;
  readonly #paths: FixturePaths;
  readonly #events: string;
  readonly #control: string;
  readonly #release: string;
  #serial = 0;

  constructor(paths: FixturePaths, path: string) {
    this.#paths = paths;
    this.path = path;
    this.#events = join(paths.bin, 'codex.events.jsonl');
    this.#control = join(paths.bin, 'codex.control.json');
    this.#release = join(paths.bin, 'codex.release');
  }

  /** The broker environment this fake needs: sync-server off, presence read from the fake `/proc`. */
  static environment(paths: FixturePaths): Record<string, string> {
    return {
      COSYNCING_CODEX_SYNC_SERVER: '0',
      // Presence arbitration scans only when a daemon socket is named; nothing listens on this one.
      COSYNCING_CODEX_APP_SERVER_SOCK: join(paths.root, 'codex-daemon.sock'),
      COSYNCING_CODEX_PROC_ROOT: fakeProcRoot(paths),
    };
  }

  events(): CodexDriveEvent[] {
    if (!existsSync(this.#events)) return [];
    return readFileSync(this.#events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Resume owners for a thread (processes asked to `thread/resume` it), oldest first. */
  owners(threadId: string): number[] {
    return this.requests('thread/resume')
      .filter((entry) => entry.params?.threadId === threadId)
      .map((entry) => entry.pid);
  }

  requests(method?: string): CodexDriveEvent[] {
    return this.events().filter((entry) => entry.event === 'request' && (!method || entry.method === method));
  }

  /** The text of every prompt a Resume owner received, with the process it reached. */
  prompts(): Array<{ pid: number; text: string }> {
    return this.requests('turn/start').map((entry) => ({
      pid: entry.pid,
      text: (entry.params?.input ?? []).map((part: any) => part?.text ?? '').join(''),
    }));
  }

  exited(pid: number): boolean {
    return this.events().some((entry) => entry.pid === pid && entry.event === 'exit');
  }

  stopHeld(pid: number): boolean {
    return this.events().some((entry) => entry.pid === pid && entry.event === 'sigterm-held');
  }

  /** While on, a Resume owner acknowledges SIGTERM but exits only on {@link releaseStop}. */
  holdStop(on: boolean): void {
    rmSync(this.#release, { force: true });
    writeFileSync(this.#control, JSON.stringify({ holdStop: on }));
  }

  releaseStop(): void {
    writeFileSync(this.#release, '');
  }

  /** A stored rollout under `$HOME/.codex/sessions`, as Codex writes one. */
  rollout(name: string, meta: Record<string, unknown> = {}): CodexRollout {
    return this.#write(name, join(this.#paths.home, '.codex', 'sessions', '2026', '07', '28'), meta);
  }

  /** A rollout outside the tree Codex discovery walks: attachable by id, never listed. */
  hiddenRollout(name: string, meta: Record<string, unknown> = {}): CodexRollout {
    return this.#write(name, join(this.#paths.root, 'elsewhere'), meta);
  }

  #write(name: string, directory: string, meta: Record<string, unknown>): CodexRollout {
    const cwd = join(this.#paths.root, 'work', name);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(directory, { recursive: true });
    const threadId = `019f5799-0000-7000-8000-${(0xd71e0000 + ++this.#serial).toString(16).padStart(12, '0')}`;
    const path = join(directory, `rollout-2026-07-28T00-00-00-${threadId}.jsonl`);
    writeFileSync(path, `${JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd, ...meta },
    })}\n`);
    return { threadId, path, id: Buffer.from(path, 'utf8').toString('base64url'), cwd };
  }

  /**
   * Stage a Codex terminal resuming `rollout` against ANOTHER app-server: a
   * competing owner the broker cannot share. Returns a function that removes it.
   */
  competingTerminal(rollout: CodexRollout, pid = 4242): () => void {
    const proc = fakeProcRoot(this.#paths);
    const directory = join(proc, String(pid));
    mkdirSync(directory, { recursive: true });
    const argv = ['codex', 'resume', '--remote', `unix://${join(this.#paths.root, 'other-daemon.sock')}`, rollout.threadId];
    writeFileSync(join(directory, 'cmdline'), `${argv.join('\0')}\0`);
    symlinkSync(rollout.cwd, join(directory, 'cwd'));
    writeFileSync(join(directory, 'stat'), `${pid} (codex) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${(BOOT_UPTIME_S - 60) * 100} 0 0`);
    return () => rmSync(directory, { recursive: true, force: true });
  }
}

const BOOT_UPTIME_S = 5_000;

function fakeProcRoot(paths: FixturePaths): string {
  const proc = join(paths.root, 'proc');
  if (!existsSync(join(proc, 'uptime'))) {
    mkdirSync(proc, { recursive: true });
    writeFileSync(join(proc, 'uptime'), `${BOOT_UPTIME_S}.00 20000.00\n`);
  }
  return proc;
}

/** Install the fake as `codex` in the fixture's `bin` (first on the broker's PATH). */
export function installCodexDriveFake(paths: FixturePaths): CodexDriveFake {
  const command = installFakeCommand(paths.bin, 'codex', PROGRAM);
  return new CodexDriveFake(paths, command.path);
}
