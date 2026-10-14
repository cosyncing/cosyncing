/**
 * The fake `codex` executable (compiled by `installFakeCodex`; see codex.ts).
 *
 * It implements the part of the Codex CLI a broker drives to keep the managed
 * app-server daemon fresh: `app-server daemon version|start|stop|restart`, and
 * the daemon itself (`app-server --listen unix://`), which serves the control
 * socket, writes the native PID receipt the broker verifies, and answers
 * `thread/loaded/list` and `thread/read`. What it reports comes from a config
 * file the test rewrites at will, and every invocation and daemon lifecycle
 * event is appended to a ledger the test reads.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeCodexDaemon } from '../../../packages/typescript/broker/test/helpers/fake-codex-daemon.ts';

declare const FAKE_CODEX_STATE: string;

/** `unreadable`: listed as loaded, but `thread/read` fails for it. */
export type FakeThreadStatus = 'idle' | 'working' | 'needs-input' | 'unreadable';

export interface FakeCodexConfig {
  /**
   * `managed`: a real daemon process with a PID receipt. `pretend`: the CLI
   * answers for a daemon that has no process and no receipt. `unmanaged`: a
   * legacy app server the daemon command does not manage.
   */
  mode: 'managed' | 'pretend' | 'unmanaged';
  /** The installed CLI version, and the version a daemon started now runs. */
  installed: string;
  /** `pretend`/`unmanaged`: the version the answering app server claims to run. */
  claimedRunning?: string;
  /** `pretend`: the daemon reports itself stopped. */
  claimedStopped?: boolean;
  /** `pretend`/`unmanaged`: the control-socket path the version probe reports. */
  claimedSocket?: string;
  /** `daemon start` fails. */
  startFails?: boolean;
  /** A daemon started now dies right after its first version answer. */
  dieAfterFirstAnswer?: boolean;
  /** This daemon process keeps running but its version probe stops answering (a lost control socket). */
  silentPid?: number;
  /** Daemon-loaded threads and their native status. */
  threads?: Array<{ id: string; status: FakeThreadStatus }>;
}

const state = FAKE_CODEX_STATE;
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
const receiptPath = join(codexHome, 'app-server-daemon', 'app-server.pid');
const daemonRecord = (pid: number) => join(state, `daemon-${pid}.json`);

const config = (): FakeCodexConfig => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
const ledger = (entry: Record<string, unknown>): void =>
  appendFileSync(join(state, 'ledger.jsonl'), `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    // A killed daemon nobody has reaped yet is not running.
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim()[0] !== 'Z';
  } catch {
    return false;
  }
}

function receipt(): { pid: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The running managed daemon, if the receipt names a live one this program started. */
function managedDaemon(): { pid: number; version: string; dieAfterFirstAnswer: boolean } | undefined {
  const named = receipt();
  if (!named || !alive(named.pid) || !existsSync(daemonRecord(named.pid))) return undefined;
  return { pid: named.pid, ...JSON.parse(readFileSync(daemonRecord(named.pid), 'utf8')) };
}

async function daemonVersion(): Promise<number> {
  const current = config();
  if (current.mode !== 'managed') {
    if (current.claimedStopped) {
      process.stderr.write('codex app-server daemon is not running\n');
      return 1;
    }
    print({
      status: 'running',
      cliVersion: current.installed,
      appServerVersion: current.claimedRunning ?? current.installed,
      ...(current.claimedSocket ? { socketPath: current.claimedSocket } : {}),
      ...(current.mode === 'pretend' ? { backend: 'pid' } : {}),
    });
    return 0;
  }
  const daemon = managedDaemon();
  if (!daemon || daemon.pid === current.silentPid) {
    process.stderr.write('codex app-server daemon is not running\n');
    return 1;
  }
  print({
    status: 'running',
    cliVersion: current.installed,
    appServerVersion: daemon.version,
    socketPath,
    backend: 'pid',
    pid: daemon.pid,
  });
  const answered = join(state, `answered-${daemon.pid}`);
  if (daemon.dieAfterFirstAnswer && !existsSync(answered)) {
    writeFileSync(answered, '');
    ledger({ kind: 'daemon-killed', target: daemon.pid });
    process.kill(daemon.pid, 'SIGKILL');
    const deadline = Date.now() + 5_000;
    while (alive(daemon.pid) && Date.now() < deadline) await sleep(10);
  }
  return 0;
}

async function daemonStart(): Promise<number> {
  const current = config();
  if (current.startFails) {
    process.stderr.write('fake codex: the daemon could not start\n');
    return 1;
  }
  if (managedDaemon()) return 0;
  const log = openSync(join(state, 'daemon.log'), 'a');
  const child = Bun.spawn([process.execPath, 'app-server', '--listen', 'unix://'], {
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

async function daemonStop(): Promise<number> {
  const daemon = managedDaemon();
  if (!daemon) return 0;
  process.kill(daemon.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (alive(daemon.pid) && Date.now() < deadline) await sleep(20);
  return alive(daemon.pid) ? 1 : 0;
}

function threadRead(threadId: string): unknown {
  const thread = (config().threads ?? []).find((entry) => entry.id === threadId);
  if (!thread || thread.status === 'unreadable') throw new Error(`thread ${threadId} cannot be read`);
  if (thread.status === 'idle') return { thread: { id: threadId, status: { type: 'idle' } } };
  return {
    thread: {
      id: threadId,
      status: { type: 'active', activeFlags: thread.status === 'needs-input' ? ['waitingOnApproval'] : [] },
    },
  };
}

function processStartTime(pid: number): string {
  const ps = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
  return ps.stdout.toString().trim().replace(/\s+/g, ' ');
}

async function runDaemon(): Promise<never> {
  const startedWith = config();
  writeFileSync(daemonRecord(process.pid), JSON.stringify({
    version: startedWith.installed,
    dieAfterFirstAnswer: startedWith.dieAfterFirstAnswer === true,
  }));
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  const server = new FakeCodexDaemon(socketPath, {
    get loadedThreadIds() {
      return (config().threads ?? []).map((thread) => thread.id);
    },
    readResult: async (params: any) => threadRead(String(params?.threadId ?? '')),
  });
  await server.start();
  // The receipt goes last: it is what says the daemon is up.
  mkdirSync(dirname(receiptPath), { recursive: true });
  const pending = `${receiptPath}.${process.pid}`;
  writeFileSync(pending, JSON.stringify({ pid: process.pid, processStartTime: processStartTime(process.pid) }), {
    mode: 0o600,
  });
  renameSync(pending, receiptPath);
  ledger({ kind: 'daemon-started', version: startedWith.installed });
  process.on('SIGTERM', () => {
    ledger({ kind: 'daemon-sigterm' });
    void server.stop().finally(() => {
      rmSync(socketPath, { force: true });
      // A clean shutdown takes its receipt with it; a killed daemon leaves a stale one behind.
      if (receipt()?.pid === process.pid) rmSync(receiptPath, { force: true });
      ledger({ kind: 'daemon-exit' });
      process.exit(0);
    });
  });
  for (;;) await sleep(60_000);
}

const args = process.argv.slice(2);
ledger({ kind: 'cli', argv: args });
if (args[0] === '--version') {
  process.stdout.write(`codex-cli ${config().installed}\n`);
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === 'daemon') {
  const command = args[2];
  if (command === 'version') process.exit(await daemonVersion());
  if (command === 'start') process.exit(await daemonStart());
  if (command === 'stop') process.exit(await daemonStop());
  // The broker must never hand the restart to the native command: it follows the receipt
  // again in another process, after the broker's own identity check.
  process.stderr.write(`fake codex: refusing daemon ${command}\n`);
  process.exit(3);
}
if (args[0] === 'app-server' && args.includes('--listen')) await runDaemon();
process.stderr.write(`fake codex: unsupported ${args.join(' ')}\n`);
process.exit(2);
