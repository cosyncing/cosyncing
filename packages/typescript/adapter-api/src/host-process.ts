import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WINDOWS_SNAPSHOT_TTL_MS = 250;
/** Budget for a probe that READS something (an ACL, a process table). Exported so a claim can hold
 *  the machine probe's own budget above it rather than restating a number. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * The native-machine probe's own budget, which is not comparable to the others'.
 *
 * The probes above ask PowerShell to read something. This one asks it to COMPILE something:
 * `Add-Type -MemberDefinition` builds a C# assembly at runtime to reach `IsWow64Process2`, and that
 * runs csc. On top of it, a PowerShell host whose `%LOCALAPPDATA%` has no module-analysis cache -- a
 * fresh profile, which every isolated test fixture creates and a service account can have too --
 * rebuilds that cache on the same call.
 *
 * Both costs land on the ONE call that decides whether this host is qualified at all. Under the
 * shared 5s budget the Windows broker lane's isolated fixtures exited at startup with
 * `windows-machine-architecture-unverified`, each suite ending 5.39-5.50s after it began, against a
 * budget of exactly 5.000. A refusal is the failure this probe exists to produce for an unqualified
 * machine, so spending it on a slow compile is the worst way to be wrong: a supported host is
 * declined and the operator is told their machine is unverified. Timing out remains possible -- this
 * is a bound, not its removal -- but a bound wide enough that reaching it means something is wrong
 * with the host rather than busy on it.
 */
export const WINDOWS_MACHINE_PROBE_TIMEOUT_MS = 20_000;
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

/**
 * The environment for a Windows PowerShell 5.1 child, with its module path pinned to the system store.
 *
 * Every PowerShell spawn in this repository names 5.1 explicitly, by absolute path. A host with
 * PowerShell 7 installed -- every GitHub-hosted Windows runner, and most developer machines --
 * exports a `PSModulePath` naming 7's module roots, and 5.1 inheriting that cannot auto-load its own
 * `Microsoft.PowerShell.Security`. `Get-Acl` then does not resolve, the probe that needed it exits
 * non-zero, and a caller that requires a definite answer about who owns a file gets `unknown` and
 * declines. Pinning the system store additionally stops a user-writable module directory from
 * shadowing a cmdlet whose whole job is deciding who may read a secret.
 *
 * Every module these probes use -- Security, Utility, CimCmdlets, NetTCPIP, ScheduledTasks -- ships in
 * that one directory, so pinning it costs nothing any of them needs.
 *
 * Returns a plain copy when `SystemRoot` is absent: a caller that cannot name the system store is in
 * no position to pin it, and the executable lookup above has already failed for the same reason.
 */
export function windowsPowerShellChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) return { ...env };
  return {
    ...env,
    PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  };
}

export function captureWindowsProcessSnapshot(): WindowsProcessSnapshot | null {
  const executable = windowsExecutable(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env);
  if (!executable) return null;
  const result = spawnSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_WINDOWS_SNAPSHOT],
    {
      encoding: 'utf8', env: windowsPowerShellChildEnvironment(), maxBuffer: WINDOWS_MAX_BUFFER,
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

/**
 * Whether a path's owner is the user this process is running as.
 *
 * The Windows counterpart of the `stat.uid === process.getuid()` check that
 * guards every file the product is willing to modify or delete. `process.getuid`
 * does not exist on Windows, so callers that only had the POSIX test were not
 * failing there — they were SKIPPING the ownership question entirely and then
 * treating a file of unknown provenance as their own. That is the fail-open
 * direction, on exactly the check that exists to prevent touching somebody
 * else's file.
 *
 * Compared by SID, never by account name: names are localized and renameable,
 * SIDs are neither. This is deliberately NOT the owner-only-DACL inspection used
 * for secret material — an ordinary rc file or shell script inherits its ACL and
 * would fail that test while being perfectly, unremarkably the user's own. The
 * question here is only "is this mine".
 *
 * Returns 'unknown' when the machine will not answer, which callers must treat
 * as "not proven mine" rather than as "not mine" or "mine".
 */
export function windowsPathOwnedByCurrentUser(target: string): 'yes' | 'no' | 'unknown' {
  if (process.platform !== 'win32') return 'unknown';
  if (typeof target !== 'string' || target.length === 0) return 'unknown';
  const executable = windowsExecutable(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env);
  if (!executable) return 'unknown';
  // The path travels in the ENVIRONMENT, never interpolated into the script text, so a filename
  // containing quotes or `$(...)` cannot become PowerShell source. It cannot travel in argv either:
  // `-Command` treats every remaining argument as more command TEXT rather than binding $args, so the
  // `--` separator parsed as a unary operator and powershell exited non-zero on every call, which this
  // function reported as 'unknown'. Windows ownership was therefore never provable, and callers that
  // require a definite 'yes' — the OpenCode shim's receipt proof among them — declined every time.
  const script = "$ErrorActionPreference='Stop'\n"
    + 'try {\n'
    + "  $p = [Environment]::GetEnvironmentVariable('COSYNCING_OWNER_PROBE_TARGET','Process')\n"
    + '  $acl = Get-Acl -LiteralPath $p\n'
    + '  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value\n'
    + '  $me = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value\n'
    + "  if ($owner -eq $me) { 'yes' } else { 'no' }\n"
    + "} catch { 'unknown' }\n";
  try {
    const result = spawnSync(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: { ...windowsPowerShellChildEnvironment(), COSYNCING_OWNER_PROBE_TARGET: target },
        maxBuffer: 64 * 1024,
        timeout: PROBE_TIMEOUT_MS, windowsHide: true,
      },
    );
    if (result.status !== 0) return 'unknown';
    const answer = (result.stdout ?? '').trim();
    return answer === 'yes' ? 'yes' : answer === 'no' ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The architecture of the MACHINE, as distinct from the architecture of this process.
 *
 * Windows on ARM64 runs x64 binaries under emulation, and an emulated process describes itself as x64
 * everywhere a program would normally look: `process.arch` reports the binary's architecture, and
 * `PROCESSOR_ARCHITECTURE` reports the emulated one. `PROCESSOR_ARCHITEW6432` does carry the native
 * answer, but it is ordinary process environment data that any parent can set, so it is evidence and a
 * test fixture — never the gate. `IsWow64Process2` is the documented kernel answer and reports both
 * machines in one call, which is why the question is asked of the OS rather than of the environment.
 *
 * Returns 'unknown' when the machine will not answer. Callers must treat that as unproven rather than as
 * either answer: the whole point of asking is that a host we cannot identify is not one we have qualified.
 */
export type WindowsMachineProbeResult = {
  readonly status: number | null;
  readonly stdout: string;
};

/**
 * The parsing and failure policy, separated from the spawn so it can be exercised without a Windows host.
 * The image-file machine constants are the ones IsWow64Process2 documents: 0x8664 AMD64, 0xAA64 ARM64.
 *
 * Anything that is not one of those two, and not an explicit refusal to answer, is 'other': a machine that
 * gave a real answer we do not recognise is not the same as one that could not be asked, and neither is
 * qualified. A non-zero exit, a missing status (spawn failure or timeout), or unparsable output is
 * 'unknown' — unproven rather than either answer.
 */
export function parseWindowsMachineArchitecture(
  result: WindowsMachineProbeResult,
): 'x64' | 'arm64' | 'other' | 'unknown' {
  if (result.status !== 0) return 'unknown';
  const answer = (result.stdout ?? '').trim().toLowerCase();
  switch (answer) {
    case '8664': return 'x64';
    case 'aa64': return 'arm64';
    case 'unknown': case '': return 'unknown';
    default: return /^[0-9a-f]{1,8}$/.test(answer) ? 'other' : 'unknown';
  }
}

export function windowsNativeMachineArchitecture(
  runProbe?: (executable: string, script: string) => WindowsMachineProbeResult,
): 'x64' | 'arm64' | 'other' | 'unknown' {
  if (!runProbe && process.platform !== 'win32') return 'unknown';
  const executable = runProbe
    ? 'powershell.exe'
    : windowsExecutable(join('WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env);
  if (!executable) return 'unknown';
  // Fixed text with nothing interpolated into it, as with the ownership probe above.
  const script = "$ErrorActionPreference='Stop'\n"
    + 'try {\n'
    + "  Add-Type -Namespace Cosyncing -Name Wow -MemberDefinition '\n"
    + '[DllImport(\"kernel32.dll\", SetLastError=true)]\n'
    + 'public static extern bool IsWow64Process2(IntPtr h, out ushort processMachine, out ushort nativeMachine);\n'
    + "' | Out-Null\n"
    + '  [uint16]$processMachine = 0\n'
    + '  [uint16]$nativeMachine = 0\n'
    + '  $handle = [System.Diagnostics.Process]::GetCurrentProcess().Handle\n'
    + '  if ([Cosyncing.Wow]::IsWow64Process2($handle, [ref]$processMachine, [ref]$nativeMachine)) {\n'
    + "    '{0:x4}' -f $nativeMachine\n"
    + "  } else { 'unknown' }\n"
    + "} catch { 'unknown' }\n";
  try {
    if (runProbe) return parseWindowsMachineArchitecture(runProbe(executable, script));
    const result = spawnSync(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: windowsPowerShellChildEnvironment(),
        maxBuffer: 64 * 1024,
        timeout: WINDOWS_MACHINE_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return parseWindowsMachineArchitecture({ status: result.status, stdout: result.stdout ?? '' });
  } catch {
    return 'unknown';
  }
}
