import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WINDOWS_SNAPSHOT_TTL_MS = 250;
const PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_MAX_BUFFER = 4 * 1024 * 1024;

export interface HostProcessIdentity {
  pid: number;
  start: string;
  boot: string;
  comm: string;
  /** Live executable evidence when the OS exposes it; required by the Windows provider. */
  executable?: string;
}

export type HostProcessRead =
  | { state: 'running'; identity: HostProcessIdentity }
  | { state: 'absent' }
  | { state: 'unknown' };

export type HostListenerRead =
  | { state: 'identified'; pid: number }
  | { state: 'absent' }
  | { state: 'unknown' };

export interface WindowsProcessEntry {
  pid: number;
  /** 0 when the OS did not report one. Only meaningful together with `start`: a parent pid can be
   *  reused, so a "parent" that started after its child is not that child's parent. */
  parentPid: number;
  start: string;
  name: string;
  executable: string | null;
}

export interface WindowsListenerEntry {
  port: number;
  pid: number;
  address: string;
}

export interface WindowsProcessSnapshot {
  processesOk: boolean;
  listenersOk: boolean;
  processes: WindowsProcessEntry[];
  listeners: WindowsListenerEntry[];
}

const WINDOWS_SNAPSHOT_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$processesOk = $true
try {
  $processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {
    $created = $null
    if ($null -ne $_.CreationDate) {
      $created = $_.CreationDate.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    [ordered]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      start = $created
      name = [string]$_.Name
      executable = if ($null -eq $_.ExecutablePath) { $null } else { [string]$_.ExecutablePath }
    }
  })
} catch { $processesOk = $false; $processes = @() }
$listenersOk = $true
try {
  $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -gt 0 -and $_.LocalPort -gt 0 } | ForEach-Object {
    [ordered]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress }
  })
} catch { $listenersOk = $false; $listeners = @() }
[ordered]@{
  processesOk = $processesOk
  listenersOk = $listenersOk
  processes = $processes
  listeners = $listeners
} | ConvertTo-Json -Compress -Depth 5
`;

const ENCODED_WINDOWS_SNAPSHOT = Buffer.from(WINDOWS_SNAPSHOT_SOURCE, 'utf16le').toString('base64');

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseWindowsProcessSnapshot(raw: string): WindowsProcessSnapshot | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.processesOk !== 'boolean' || typeof record.listenersOk !== 'boolean') return null;
    if (!Array.isArray(record.processes) || !Array.isArray(record.listeners)) return null;
    const processes: WindowsProcessEntry[] = [];
    for (const item of record.processes) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      if (!positiveInteger(entry.pid)) return null;
      if (typeof entry.parentPid !== 'number' || !Number.isInteger(entry.parentPid) || entry.parentPid < 0) return null;
      if (entry.start !== null && typeof entry.start !== 'string') return null;
      if (typeof entry.name !== 'string') return null;
      if (entry.executable !== null && typeof entry.executable !== 'string') return null;
      processes.push({
        pid: entry.pid,
        parentPid: entry.parentPid,
        start: entry.start ?? '',
        name: entry.name,
        executable: entry.executable,
      });
    }
    const listeners: WindowsListenerEntry[] = [];
    for (const item of record.listeners) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      if (!positiveInteger(entry.pid) || !positiveInteger(entry.port) || entry.port > 65_535) return null;
      if (typeof entry.address !== 'string' || entry.address.length === 0) return null;
      listeners.push({ port: entry.port, pid: entry.pid, address: entry.address });
    }
    return { processesOk: record.processesOk, listenersOk: record.listenersOk, processes, listeners };
  } catch {
    return null;
  }
}

export type WindowsProcessSnapshotRunner = () => WindowsProcessSnapshot | null;

function windowsExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  return systemRoot ? join(systemRoot, 'System32', name) : null;
}

export function captureWindowsProcessSnapshot(): WindowsProcessSnapshot | null {
  const executable = windowsExecutable(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env);
  if (!executable) return null;
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_WINDOWS_SNAPSHOT],
    {
      encoding: 'utf8', env: { ...process.env }, maxBuffer: WINDOWS_MAX_BUFFER,
      timeout: PROBE_TIMEOUT_MS, windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.signal !== null) return null;
  return parseWindowsProcessSnapshot(result.stdout.trim());
}

export interface HostProcessProviderOptions {
  platform?: NodeJS.Platform;
  runWindowsSnapshot?: WindowsProcessSnapshotRunner;
  now?: () => number;
  windowsSnapshotTtlMs?: number;
}

/** Shared, fail-closed process identity and listener attribution provider. */
export class HostProcessProvider {
  private readonly platform: NodeJS.Platform;
  private readonly runWindowsSnapshot: WindowsProcessSnapshotRunner;
  private readonly now: () => number;
  private readonly windowsSnapshotTtlMs: number;
  private windowsCache: { at: number; value: WindowsProcessSnapshot | null } | null = null;
  private bootId: string | undefined;

  constructor(options: HostProcessProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runWindowsSnapshot = options.runWindowsSnapshot ?? captureWindowsProcessSnapshot;
    this.now = options.now ?? (() => Date.now());
    this.windowsSnapshotTtlMs = options.windowsSnapshotTtlMs ?? WINDOWS_SNAPSHOT_TTL_MS;
  }

  private windowsSnapshot(fresh: boolean): WindowsProcessSnapshot | null {
    const at = this.now();
    if (!fresh && this.windowsCache && at - this.windowsCache.at <= this.windowsSnapshotTtlMs) {
      return this.windowsCache.value;
    }
    // One retry. Taking this snapshot means spawning PowerShell, which loses to a busy host often
    // enough to matter, and an unanswered snapshot is indistinguishable from "this machine will not
    // say" — which makes a broker preserve a serve it could have proven, and abandon a reclaim it
    // was entitled to make. Observed exactly that on a loaded host. A genuinely unavailable snapshot
    // still reports unknown; it just is not decided by one lost race.
    let value = this.runWindowsSnapshot();
    if (!value || !value.processesOk || !value.listenersOk) {
      const retried = this.runWindowsSnapshot();
      if (retried && retried.processesOk && retried.listenersOk) value = retried;
      else value = value ?? retried;
    }
    this.windowsCache = { at: this.now(), value };
    return value;
  }

  private readBootId(): string {
    if (this.bootId !== undefined) return this.bootId;
    try { this.bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { this.bootId = ''; }
    return this.bootId;
  }

  liveProcess(pid: number, options: { fresh?: boolean } = {}): HostProcessRead {
    if (!positiveInteger(pid)) return { state: 'unknown' };
    if (this.platform === 'win32') {
      const snapshot = this.windowsSnapshot(options.fresh === true);
      if (!snapshot || !snapshot.processesOk) return { state: 'unknown' };
      const matches = snapshot.processes.filter((entry) => entry.pid === pid);
      if (matches.length === 0) return { state: 'absent' };
      if (matches.length !== 1) return { state: 'unknown' };
      const entry = matches[0]!;
      // ExecutablePath may be withheld. A partial identity never authorizes termination.
      if (!entry.start || !entry.name || !entry.executable) return { state: 'unknown' };
      return {
        state: 'running',
        identity: { pid, start: entry.start, boot: '', comm: entry.name, executable: entry.executable },
      };
    }
    if (this.platform === 'linux') {
      const boot = this.readBootId();
      if (!boot) return { state: 'unknown' };
      let stat: string;
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (error) {
        return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { state: 'absent' } : { state: 'unknown' };
      }
      const rparen = stat.lastIndexOf(')');
      if (rparen < 0) return { state: 'unknown' };
      const start = stat.slice(rparen + 1).trim().split(/\s+/)[19];
      let comm = '';
      try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* classified below */ }
      return start && comm
        ? { state: 'running', identity: { pid, start, boot, comm } }
        : { state: 'unknown' };
    }
    const ps = Bun.which('ps');
    if (!ps) return { state: 'unknown' };
    const field = (format: string): { value?: string; absent: boolean } => {
      try {
        const result = Bun.spawnSync([ps, '-o', format, '-p', String(pid)], {
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, timeout: 3_000,
        });
        const value = new TextDecoder().decode(result.stdout).trim();
        const noise = new TextDecoder().decode(result.stderr).trim();
        return result.exitCode === 0 && value
          ? { value, absent: false }
          : { absent: result.exitCode === 1 && !value && !noise };
      } catch { return { absent: false }; }
    };
    const start = field('lstart=');
    if (!start.value) return start.absent ? { state: 'absent' } : { state: 'unknown' };
    const comm = field('comm=');
    if (!comm.value) return comm.absent ? { state: 'absent' } : { state: 'unknown' };
    return { state: 'running', identity: { pid, start: start.value, boot: '', comm: comm.value } };
  }

  /**
   * Is `pid` a descendant of `ancestorPid`? Answers 'unknown' rather than guessing, because the only
   * caller uses this to decide whether a process may later be SIGNALLED, and an unproven yes is how
   * a broker ends up killing something that was never its own.
   *
   * A Windows npm launcher is a batch shim: the broker spawns `cmd.exe`, which CALLS the real
   * executable, so the process holding a port is the spawned shell's child rather than the shell.
   * Ancestry is what connects the two.
   *
   * Each hop must resolve, and each parent must have started no LATER than its child: parent pids
   * are reused, and a recycled pid that started afterwards is not the parent it appears to be.
   */
  descendsFrom(pid: number, ancestorPid: number, options: { fresh?: boolean } = {}): 'yes' | 'no' | 'unknown' {
    if (!positiveInteger(pid) || !positiveInteger(ancestorPid)) return 'unknown';
    if (pid === ancestorPid) return 'yes';
    if (this.platform !== 'win32') return 'unknown';
    const snapshot = this.windowsSnapshot(options.fresh === true);
    if (!snapshot || !snapshot.processesOk) return 'unknown';
    const byPid = new Map<number, WindowsProcessEntry>();
    for (const entry of snapshot.processes) {
      // A pid appearing twice in one snapshot makes every answer about it indeterminate.
      if (byPid.has(entry.pid)) return 'unknown';
      byPid.set(entry.pid, entry);
    }
    let current = byPid.get(pid);
    if (!current) return 'unknown';
    // Bounded: a cycle or a pathological chain must not spin.
    for (let hop = 0; hop < 32; hop += 1) {
      if (!current.parentPid) return 'no';
      const parent = byPid.get(current.parentPid);
      // The parent is gone: this process has been reparented, so nothing can be proven about it.
      if (!parent) return 'unknown';
      if (!parent.start || !current.start) return 'unknown';
      if (parent.start > current.start) return 'no';
      if (parent.pid === ancestorPid) return 'yes';
      current = parent;
    }
    return 'unknown';
  }

  listener(port: number, options: { fresh?: boolean } = {}): HostListenerRead {
    if (!positiveInteger(port) || port > 65_535) return { state: 'unknown' };
    if (this.platform === 'win32') {
      const snapshot = this.windowsSnapshot(options.fresh === true);
      if (!snapshot || !snapshot.listenersOk) return { state: 'unknown' };
      const pids = new Set(snapshot.listeners.filter((entry) => entry.port === port).map((entry) => entry.pid));
      if (pids.size === 0) return { state: 'absent' };
      return pids.size === 1 ? { state: 'identified', pid: [...pids][0]! } : { state: 'unknown' };
    }
    const lsof = Bun.which('lsof');
    if (!lsof) return { state: 'unknown' };
    try {
      const result = Bun.spawnSync([lsof, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, timeout: 3_000,
      });
      const pids = new Set(new TextDecoder().decode(result.stdout).trim().split(/\s+/)
        .filter(Boolean).map(Number).filter(positiveInteger));
      const noise = new TextDecoder().decode(result.stderr).trim();
      if (result.exitCode !== 0) {
        return result.exitCode === 1 && pids.size === 0 && !noise ? { state: 'absent' } : { state: 'unknown' };
      }
      return pids.size === 1 ? { state: 'identified', pid: [...pids][0]! } : { state: 'unknown' };
    } catch { return { state: 'unknown' }; }
  }
}

/** Terminate one proven PID tree without a shell; the caller must re-prove identity first. */
export function terminateHostProcessTree(pid: number, force: boolean): void {
  if (!positiveInteger(pid)) return;
  if (process.platform === 'win32') {
    const executable = windowsExecutable('taskkill.exe', process.env);
    if (!executable) return;
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try {
      spawnSync(executable, args, {
        encoding: 'utf8', env: { ...process.env }, maxBuffer: 64 * 1024,
        timeout: PROBE_TIMEOUT_MS, windowsHide: true,
      });
    } catch { /* the caller verifies the result */ }
    return;
  }
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
}
