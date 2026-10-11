import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { HostProcessProvider, type HostProcessIdentity } from '@cosyncing/adapter-api';

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

function inspectProcess(pid: number, home: string, cli: string, receiptStart?: string): CodexDaemonProcessRead {
  if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return unknown('Invalid Codex daemon PID.');
  const live = processes.liveProcess(pid, { fresh: true });
  if (live.state !== 'running') return live.state === 'absent' ? live : unknown('Codex process identity is unreadable.');
  try {
    if (receiptStart !== undefined) {
      const start = psField(pid, 'lstart');
      if (!start) return unknown('Codex daemon process start time could not be read.');
      // A reused PID does not make an old receipt authoritative for the replacement process.
      if (normalizeStart(start) !== receiptStart) return { state: 'absent' };
    }
    let executable: string;
    let argv: string[];
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/);
      if (stat[0] === 'Z') return { state: 'absent' }; // exited; a parent may not have reaped it yet
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
    const after = processes.liveProcess(pid, { fresh: true });
    if (after.state !== 'running' || after.identity.start !== live.identity.start || after.identity.boot !== live.identity.boot) {
      return unknown('Codex daemon identity changed during inspection.');
    }
    return { state: 'running', process: { ...live.identity, executable, argv, home, cli: resolvedCli, unknownFlags: argumentsRead.unknownFlags } };
  } catch {
    return unknown('Codex daemon executable or launch identity could not be read.');
  }
}

/** The native PID receipt survives a lost control socket. Never infer process exit from an RPC failure. */
export function readCodexDaemonProcess(home: string, cli: string): CodexDaemonProcessRead {
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
    const inspected = inspectProcess(record.pid, home, cli, record.processStartTime);
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
