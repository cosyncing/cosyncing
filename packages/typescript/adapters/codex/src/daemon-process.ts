import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { HostProcessProvider, type HostProcessIdentity } from '@cosyncing/adapter-api';

export interface CodexDaemonProcess extends HostProcessIdentity {
  executable: string;
  argv: string[];
  home: string;
  cli: string;
}

export type CodexDaemonProcessRead =
  | { state: 'running'; process: CodexDaemonProcess }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

const processes = new HostProcessProvider();
const unknown = (detail: string): CodexDaemonProcessRead => ({ state: 'unknown', detail });
const normalizeStart = (value: string) => value.trim().replace(/\s+/g, ' ');

function psField(pid: number, field: string): string | undefined {
  const result = Bun.spawnSync(['/bin/ps', '-o', `${field}=`, '-p', String(pid)], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 3_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

/** Updates can retarget current while the previous standalone release still owns threads. */
export function sameCodexInstallation(executable: string, cli: string): boolean {
  if (executable === cli) return true;
  const release = dirname(dirname(executable));
  const currentRelease = dirname(dirname(cli));
  return basename(executable) === 'codex' && basename(cli) === 'codex'
    && dirname(release) === dirname(currentRelease)
    && basename(dirname(release)) === 'releases'
    && basename(dirname(dirname(release))) === 'standalone'
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(release))
    && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(basename(currentRelease));
}

function inspectProcess(pid: number, home: string, cli: string): CodexDaemonProcessRead {
  if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return unknown('Invalid Codex daemon PID.');
  const live = processes.liveProcess(pid, { fresh: true });
  if (live.state !== 'running') return live.state === 'absent' ? live : unknown('Codex process identity is unreadable.');
  try {
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
      const suffix = command?.match(/ (app-server(?: --remote-control)? --listen unix:\/\/)$/)?.[1];
      if (!suffix) return unknown('Codex daemon launch arguments could not be verified.');
      argv = [command!.slice(0, -suffix.length - 1), ...suffix.split(' ')];
    } else {
      return unknown('Codex daemon process recovery is unavailable on this platform.');
    }
    const resolvedCli = realpathSync(cli);
    if (!sameCodexInstallation(executable, resolvedCli)) return unknown('Codex daemon executable does not match this installation.');
    const args = argv.slice(1).join('\0');
    if (args !== 'app-server\0--remote-control\0--listen\0unix://'
      && args !== 'app-server\0--listen\0unix://') return unknown('Codex daemon launch arguments do not match the managed daemon.');
    const after = processes.liveProcess(pid, { fresh: true });
    if (after.state !== 'running' || after.identity.start !== live.identity.start || after.identity.boot !== live.identity.boot) {
      return unknown('Codex daemon identity changed during inspection.');
    }
    return { state: 'running', process: { ...live.identity, executable, argv, home, cli: resolvedCli } };
  } catch {
    return unknown('Codex daemon executable or launch identity could not be read.');
  }
}

/** The native PID receipt survives a lost control socket. Never infer process exit from an RPC failure. */
export function readCodexDaemonProcess(home: string, cli: string): CodexDaemonProcessRead {
  const path = join(home, 'app-server-daemon', 'app-server.pid');
  let record: { pid?: unknown; processStartTime?: unknown };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      return unknown('Codex daemon PID receipt has unsafe ownership or permissions.');
    }
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { state: 'absent' } : unknown('Codex daemon PID receipt is unreadable.');
  }
  if (!record || typeof record.pid !== 'number' || typeof record.processStartTime !== 'string' || !record.processStartTime.trim()) {
    return unknown('Codex daemon PID receipt is malformed.');
  }
  const inspected = inspectProcess(record.pid, home, cli);
  if (inspected.state !== 'running') return inspected;
  const start = psField(record.pid, 'lstart');
  return start && normalizeStart(start) === normalizeStart(record.processStartTime)
    ? inspected : unknown('Codex daemon PID receipt no longer matches the running process.');
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

/** Only a confirmed restart may call this, after native graceful shutdown has failed. */
export function forceStopCodexDaemonProcess(expected: CodexDaemonProcess): void {
  const state = codexDaemonProcessState(expected);
  if (state === 'exited') return;
  if (state !== 'running') throw new Error('Codex daemon identity changed; forced shutdown was refused.');
  process.kill(expected.pid, 'SIGKILL');
}
