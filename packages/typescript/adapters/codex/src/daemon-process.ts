import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { HostProcessProvider, type HostProcessIdentity } from '@cosyncing/adapter-api';
import { CODEX_TUI_PRESENCE_TTL_MS, codexNewThreadFolders, runBoundedMacCommand, type CodexMacCommandRunner, type CodexTuiScan } from './tui-presence.ts';

export interface CodexDaemonProcess extends HostProcessIdentity {
  executable: string;
  argv: string[];
  home: string;
  cli: string;
  unknownFlags?: string[];
  receiptLayouts?: CodexDaemonReceiptLayout[];
}

export type CodexDaemonReceiptLayout = 'app-server.pid' | 'daemon.pid';

export type CodexDaemonProcessRead =
  | { state: 'running'; process: CodexDaemonProcess }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

const processes = new HostProcessProvider();
const unknown = (detail: string): CodexDaemonProcessRead => ({ state: 'unknown', detail });
const normalizeStart = (value: string) => value.trim().replace(/\s+/g, ' ');

/** The receipt selects the proven daemon PID, never the broker's or a terminal's folder. */
export async function readCodexDaemonCwd(home: string, cli: string, dependencies: {
  readProcess?: typeof readCodexDaemonProcess;
  readLink?: (path: string) => string;
  liveProcess?: HostProcessProvider['liveProcess'];
  platform?: NodeJS.Platform;
  macRunner?: CodexMacCommandRunner;
} = {}): Promise<string | undefined> {
  try {
    const read = (dependencies.readProcess ?? readCodexDaemonProcess)(home, cli);
    if (read.state !== 'running') return undefined;
    const platform = dependencies.platform ?? process.platform;
    let folder: string | undefined;
    if (platform === 'linux') folder = (dependencies.readLink ?? readlinkSync)(`/proc/${read.process.pid}/cwd`);
    else if (platform === 'darwin') {
      const result = await (dependencies.macRunner ?? runBoundedMacCommand)('/usr/sbin/lsof',
        ['-a', '-p', String(read.process.pid), '-d', 'cwd', '-Fn'], { timeoutMs: 1_000, maxOutputBytes: 8_192 });
      if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) return undefined;
      const paths = result.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
      if (paths.length === 1) folder = paths[0];
    }
    // Recheck the captured process identity after the read; PID reuse is not folder evidence.
    if (!folder || !isAbsolute(folder)) return undefined;
    const after = dependencies.liveProcess
      ? dependencies.liveProcess(read.process.pid, { fresh: true })
      : processes.liveProcess(read.process.pid, { fresh: true });
    return after.state === 'running' && after.identity.start === read.process.start
      && after.identity.boot === read.process.boot ? folder : undefined;
  } catch { return undefined; }
}

/** Only plain proven-shared terminals need the daemon folder; share the raw scan's TTL. */
export function createCodexNewThreadFolderScan(dependencies: {
  readFolder?: typeof readCodexDaemonCwd;
  now?: () => number;
} = {}) {
  const readFolder = dependencies.readFolder ?? readCodexDaemonCwd;
  const now = dependencies.now ?? Date.now;
  const folders = new Map<string, { at: number; folder: string | undefined }>();
  const inFlight = new Map<string, Promise<string | undefined>>();
  const cachedFolder = (key: string, home: string, cli: string): Promise<string | undefined> => {
    const hit = folders.get(key);
    if (hit && now() - hit.at < CODEX_TUI_PRESENCE_TTL_MS) return Promise.resolve(hit.folder);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const read = readFolder(home, cli).catch(() => undefined).then((folder) => {
      // Socket settings can change, so bound retained cache keys as well as their lifetime.
      if (!folders.has(key) && folders.size >= 32) folders.delete(folders.keys().next().value!);
      folders.set(key, { at: now(), folder });
      return folder;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, read);
    return read;
  };
  return async (scan: CodexTuiScan, socket: string, home: string, cli?: string): Promise<CodexTuiScan> => {
    const needsDaemonCwd = scan.candidates.some((candidate) => candidate.proof === 'shared'
      && !candidate.threadIds?.length && candidate.cwdOverride === undefined);
    const daemonCwd = needsDaemonCwd && cli
      ? await cachedFolder(JSON.stringify([socket, home, cli]), home, cli) : undefined;
    return codexNewThreadFolders(scan, daemonCwd);
  };
}

export type CodexDaemonArguments =
  | { valid: true; unknownFlags: string[] }
  | { valid: false; detail: string };

/** Structural native daemon form; new bare flags do not change the control endpoint.
 * This is only one ownership check; a matching argument list never grants ownership alone. */
export function parseManagedCodexDaemonArguments(args: readonly string[]): CodexDaemonArguments {
  // Name recognizable tokens without echoing private values or paths into restart errors.
  const refused = (token: string | undefined, reason: string): CodexDaemonArguments => {
    const flag = token?.match(/^--?[A-Za-z0-9][A-Za-z0-9_-]*/)?.[0];
    const inline = flag !== undefined && token?.startsWith(`${flag}=`);
    const value = inline ? token!.slice(flag.length + 1) : undefined;
    const label = flag
      ? `${flag}${inline ? `=${/^(?:0|1|true|false|unix:\/\/)$/.test(value!) ? value : '<value>'}` : ''}`
      : token === 'daemon' || token === 'pid-update-loop' ? token : undefined;
    return { valid: false, detail: `Codex daemon launch argument ${label ? `\`${label}\`` : 'at an unexpected position'} ${reason}.` };
  };
  if (args[0] !== 'app-server') return refused(args[0], 'must start with app-server');
  let listens = 0;
  const unknownFlags: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--listen' || token.startsWith('--listen=')) {
      if (++listens !== 1) return refused(token, 'appears more than once');
      const address = token === '--listen' ? args[++i] : token.slice('--listen='.length);
      if (address !== 'unix://') return refused(token, 'must use the default unix:// control socket');
    } else if (!/^--[a-z0-9][a-z0-9-]*$/.test(token)) {
      return refused(token, 'is not a recognized bare long flag');
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) return refused(token, 'carries a value');
      if (token !== '--remote-control' && token !== '--managed-daemon') unknownFlags.push(token);
    }
  }
  if (listens !== 1) return refused('--listen', 'is required exactly once');
  return { valid: true, unknownFlags };
}

export function managedCodexDaemonArguments(args: readonly string[]): boolean {
  return parseManagedCodexDaemonArguments(args).valid;
}

/** ps may preserve a symlinked comm path; match it or its realpath without splitting path spaces. */
export function codexDaemonCommandArguments(command: string | undefined, executable: string, comm = executable): string[] | undefined {
  if (!command) return undefined;
  const prefix = [comm, executable].find((path) => command.startsWith(path) && /\s/.test(command[path.length] ?? ''));
  if (!prefix) return undefined;
  return [prefix, ...command.slice(prefix.length).trim().split(/\s+/)];
}

function psField(pid: number, field: string): string | undefined {
  const result = Bun.spawnSync(['/bin/ps', '-o', `${field}=`, '-p', String(pid)], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 3_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

/** Updates can retarget current while the previous standalone release still owns threads. */
export function sameCodexInstallation(executable: string, cli: string, home?: string): boolean {
  if (executable === cli) return true;
  const release = dirname(dirname(executable));
  const currentRelease = dirname(dirname(cli));
  const standalone = basename(executable) === 'codex' && basename(cli) === 'codex'
    && dirname(release) === dirname(currentRelease)
    && basename(dirname(release)) === 'releases'
    && basename(dirname(dirname(release))) === 'standalone'
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(release))
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(currentRelease));
  if (standalone) return true;
  if (!home) return false;
  // New native installs give the daemon its own package. Admit only canonical release binaries
  // beside the selected standalone CLI in this CODEX_HOME, never an arbitrary sibling executable.
  const packages = join(realpathSync(home), 'packages');
  const packageBinary = (path: string, name: string) => basename(path) === 'codex'
    && basename(dirname(path)) === 'bin'
    && dirname(dirname(dirname(path))) === join(packages, name, 'releases')
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(dirname(dirname(path))));
  return packageBinary(cli, 'standalone') && packageBinary(executable, 'app-server-daemon');
}

/** How the receipt's start time is checked against the process: `ps -o lstart`. */
export type CodexDaemonStartTimeReader = (pid: number) => string | undefined;

function inspectProcess(
  pid: number, home: string, cli: string, receiptStart?: string,
  readStartTime: CodexDaemonStartTimeReader = (target) => psField(target, 'lstart'),
): CodexDaemonProcessRead {
  if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return unknown('Invalid Codex daemon PID.');
  const live = processes.liveProcess(pid, { fresh: true });
  if (live.state !== 'running') return live.state === 'absent' ? live : unknown('Codex process identity is unreadable.');
  // The provider reads a zombie as absent, so an exited daemon its parent has not reaped is gone
  // already. Any later failed read is weighed against that: the daemon can exit and be reaped
  // mid-inspection, and a daemon that exited then is gone, not unverifiable.
  const exited = (): boolean => processes.liveProcess(pid, { fresh: true }).state === 'absent';
  try {
    if (receiptStart !== undefined) {
      const start = readStartTime(pid);
      if (!start) return exited() ? { state: 'absent' } : unknown('Codex daemon process start time could not be read.');
      // A reused PID does not make an old receipt authoritative for the replacement process.
      if (normalizeStart(start) !== receiptStart) return { state: 'absent' };
    }
    let executable: string;
    let argv: string[];
    if (process.platform === 'linux') {
      if (lstatSync(`/proc/${pid}`).uid !== process.getuid?.()) return unknown('Codex daemon belongs to another user.');
      executable = realpathSync(`/proc/${pid}/exe`);
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const configuredHome = env.find((entry) => entry.startsWith('CODEX_HOME='))?.slice(11).trim();
      if (resolve(configuredHome || join(homedir(), '.codex')) !== resolve(home)) {
        return unknown('Codex daemon belongs to a different CODEX_HOME.');
      }
    } else if (process.platform === 'darwin') {
      if (Number(psField(pid, 'uid')) !== process.getuid?.()) return unknown('Codex daemon belongs to another user.');
      executable = realpathSync(live.identity.comm);
      const command = psField(pid, 'command');
      const parsed = codexDaemonCommandArguments(command, executable, live.identity.comm);
      if (!parsed) return unknown('Codex daemon launch executable could not be verified.');
      argv = parsed;
    } else {
      return unknown('Codex daemon process recovery is unavailable on this platform.');
    }
    const resolvedCli = realpathSync(cli);
    if (!sameCodexInstallation(executable, resolvedCli, home)) return unknown('Codex daemon executable does not match this installation.');
    const argumentsRead = parseManagedCodexDaemonArguments(argv.slice(1));
    if (!argumentsRead.valid) return unknown(argumentsRead.detail);
    // It may have exited while it was read (gone, or a zombie).
    const after = processes.liveProcess(pid, { fresh: true });
    if (after.state === 'absent') return { state: 'absent' };
    if (after.state !== 'running' || after.identity.start !== live.identity.start || after.identity.boot !== live.identity.boot) {
      return unknown('Codex daemon identity changed during inspection.');
    }
    return { state: 'running', process: { ...live.identity, executable, argv, home, cli: resolvedCli, unknownFlags: argumentsRead.unknownFlags } };
  } catch {
    return exited() ? { state: 'absent' } : unknown('Codex daemon executable or launch identity could not be read.');
  }
}

/** The native PID receipt survives a lost control socket. Never infer process exit from an RPC failure. */
export function readCodexDaemonProcess(home: string, cli: string, dependencies: {
  /** Test seam: the receipt start-time read, where a reap can land mid-inspection. */
  readStartTime?: CodexDaemonStartTimeReader;
} = {}): CodexDaemonProcessRead {
  const records: { layout: CodexDaemonReceiptLayout; pid: number; processStartTime: string }[] = [];
  for (const layout of ['app-server.pid', 'daemon.pid'] as const) {
    const path = join(home, 'app-server-daemon', layout);
    let record: { pid?: unknown; processStartTime?: unknown };
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
        return unknown(`Codex daemon PID receipt ${layout} has unsafe ownership or permissions.`);
      }
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return unknown(`Codex daemon PID receipt ${layout} is unreadable.`);
    }
    if (!record || typeof record.pid !== 'number' || typeof record.processStartTime !== 'string' || !record.processStartTime.trim()) {
      return unknown(`Codex daemon PID receipt ${layout} is malformed.`);
    }
    records.push({ layout, pid: record.pid, processStartTime: normalizeStart(record.processStartTime) });
  }
  const verified: { layout: CodexDaemonReceiptLayout; process: CodexDaemonProcess }[] = [];
  for (const record of records) {
    const inspected = inspectProcess(record.pid, home, cli, record.processStartTime, dependencies.readStartTime);
    if (inspected.state === 'absent') continue;
    if (inspected.state === 'unknown') return inspected;
    verified.push({ layout: record.layout, process: inspected.process });
  }
  const daemon = verified[0]?.process;
  if (!daemon) return { state: 'absent' };
  if (verified.some(({ process: other }) => other.pid !== daemon.pid || other.start !== daemon.start || other.boot !== daemon.boot)) {
    return unknown('Codex daemon PID receipts app-server.pid and daemon.pid conflict.');
  }
  return { state: 'running', process: { ...daemon, receiptLayouts: verified.map(({ layout }) => layout) } };
}

export function codexDaemonProcessState(expected: CodexDaemonProcess): 'running' | 'exited' | 'unknown' {
  const live = processes.liveProcess(expected.pid, { fresh: true });
  if (live.state === 'absent') return 'exited';
  if (live.state !== 'running') return 'unknown';
  // PID reuse proves our old process exited, but never authorizes signalling the replacement.
  if (live.identity.start !== expected.start || live.identity.boot !== expected.boot) return 'exited';
  const current = inspectProcess(expected.pid, expected.home, expected.cli);
  if (current.state === 'absent') return 'exited';
  return current.state === 'running'
    && current.process.executable === expected.executable
    && current.process.start === expected.start && current.process.boot === expected.boot
    && JSON.stringify(current.process.argv) === JSON.stringify(expected.argv) ? 'running' : 'unknown';
}

interface ProcessSignalHandle { send(signal: 'SIGTERM' | 'SIGKILL'): void; close(): void }
interface ProcessSignalDependencies {
  bind(pid: number): ProcessSignalHandle;
  state(expected: CodexDaemonProcess): 'running' | 'exited' | 'unknown';
}

let linuxSignals: { open(pid: number): number; send(fd: number, signal: number): number; close(fd: number): void } | undefined;
function bindProcessSignal(pid: number): ProcessSignalHandle {
  if (process.platform === 'linux') {
    if (!linuxSignals) {
      if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Codex process-bound signals are unavailable on this architecture.');
      const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
      const symbols = {
        // pidfd_open (434) and pidfd_send_signal (424) have the same numbers on supported Linux hosts.
        syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      } as const;
      let libc;
      try { libc = dlopen('libc.so.6', symbols); } catch {
        libc = dlopen(`/lib/ld-musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`, symbols);
      }
      linuxSignals = {
        open: (processId) => Number(libc.symbols.syscall(434, processId, 0, 0, 0)),
        send: (fd, signal) => Number(libc.symbols.syscall(424, fd, signal, 0, 0)),
        close: (fd) => { libc.symbols.close(fd); },
      };
    }
    const api = linuxSignals;
    const fd = api.open(pid);
    if (fd < 0) throw new Error('Codex daemon pidfd could not be opened; process-bound shutdown was refused.');
    return {
      send: (signal) => {
        if (api.send(fd, signal === 'SIGTERM' ? 15 : 9) !== 0) throw new Error('Codex daemon process-bound signal failed.');
      },
      close: () => api.close(fd),
    };
  }
  if (process.platform !== 'darwin') throw new Error('Codex daemon signals are unavailable on this platform.');
  // macOS has no pidfd. Keep its synchronous identity check adjacent to signalling the captured PID;
  // never delegate target selection to the mutable native daemon receipt.
  return { send: (signal) => { process.kill(pid, signal); }, close: () => {} };
}

/** Bind before rechecking identity, so a Linux PID reused during inspection can never be signalled. */
export function signalCodexDaemonProcess(
  expected: CodexDaemonProcess, signal: 'SIGTERM' | 'SIGKILL',
  deps: Partial<ProcessSignalDependencies> = {},
): void {
  const bind = deps.bind ?? bindProcessSignal;
  const stateOf = deps.state ?? codexDaemonProcessState;
  let handle: ProcessSignalHandle;
  try { handle = bind(expected.pid); } catch (error) {
    if (stateOf(expected) === 'exited') return;
    throw error;
  }
  try {
    const state = stateOf(expected);
    if (state === 'exited') return;
    if (state !== 'running') throw new Error('Codex daemon identity changed; shutdown was refused.');
    try { handle.send(signal); } catch (error) {
      if (stateOf(expected) !== 'exited') throw error;
    }
  } finally { handle.close(); }
}

export function gracefullyStopCodexDaemonProcess(expected: CodexDaemonProcess): void {
  signalCodexDaemonProcess(expected, 'SIGTERM');
}

/** Only a confirmed restart may call this, after graceful shutdown has failed. */
export function forceStopCodexDaemonProcess(expected: CodexDaemonProcess): void {
  signalCodexDaemonProcess(expected, 'SIGKILL');
}
