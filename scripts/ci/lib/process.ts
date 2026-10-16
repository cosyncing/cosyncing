/**
 * Run a command under its own process group, with a wall-clock bound.
 *
 * - The command execs through `setsid` (Linux), so `kill(-pid)` reaches every
 *   grandchild: a wedged test cannot leave a broker, a browser or a
 *   `flutter_tester` behind. On Windows the tree is killed with `taskkill /T`.
 * - On timeout the process tree is captured BEFORE it is killed, so a hang is
 *   diagnosable from the log instead of being a bare "timed out".
 * - Anything still alive in the group after the leader exits is reaped and
 *   reported as `strays`.
 * - Output is drained while the command runs, so a full pipe can never
 *   deadlock the child, and a pipe held open by a leaked grandchild cannot
 *   turn a finished command into a hang.
 *
 * A command started inside a supervised group (see
 * {@link insideSupervisedProcessGroup}) should not start a second group:
 * staying in the outer one keeps it reachable by the outer timeout.
 */
import { platform } from 'node:os';

export interface SupervisedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Start a new process group. Default true; pass false inside a supervised group. */
  isolateProcessGroup?: boolean;
  /** Time a signalled group gets to exit before SIGKILL. */
  graceMs?: number;
  /** Time a group whose leader exited gets to finish before survivors count as strays. */
  strayGraceMs?: number;
  maxBufferBytes?: number;
}

export interface SupervisedResult {
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  output: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  strays: boolean;
  /** `ps` snapshot of the group taken when the timeout fired. */
  treeAtTimeout?: string;
  truncated: boolean;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 32 << 20;
const IS_WINDOWS = platform() === 'win32';
const SUPERVISED_GROUP_ENV = 'COSYNCING_SUPERVISED_PROCESS_GROUP';

export function insideSupervisedProcessGroup(): boolean {
  return process.env[SUPERVISED_GROUP_ENV] === '1';
}

let setsidAvailable: boolean | undefined;
function canIsolateGroup(): boolean {
  if (setsidAvailable === undefined) {
    setsidAvailable = !IS_WINDOWS
      && Bun.spawnSync(['setsid', 'true'], { stdout: 'ignore', stderr: 'ignore' }).success;
  }
  return setsidAvailable;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Process groups this process started and has not yet seen the end of. */
const liveGroups = new Set<number>();

/**
 * Signal every process group {@link runSupervised} started and still owns. For a supervisor that is
 * itself being stopped: its groups are their own sessions, so a Ctrl-C or a SIGTERM that ends it
 * never reaches them, and they would run on unsupervised.
 */
export function signalSupervisedGroups(signal: NodeJS.Signals): number {
  for (const pid of liveGroups) signalGroup(pid, signal);
  return liveGroups.size;
}

/** A readable snapshot of every process in the group (the descendant tree on Windows). */
export function describeTree(pid: number, isolated: boolean): string {
  if (IS_WINDOWS) {
    const script = '$all = Get-CimInstance Win32_Process; '
      + 'function Walk($p, $d) { $all | Where-Object ParentProcessId -eq $p | ForEach-Object { '
      + `('  ' * $d) + "$($_.ProcessId) $($_.CommandLine)"; Walk $_.ProcessId ($d + 1) } }; Walk ${pid} 0`;
    const result = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.stdout.toString().trim() || '(no descendants found)';
  }
  const selector = isolated ? ['-g', String(pid)] : ['-p', String(pid)];
  const result = Bun.spawnSync(['ps', '-o', 'pid,ppid,etime,stat,rss,args', ...selector], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.stdout.toString().trim() || '(process group already empty)';
}

export async function runSupervised(
  command: string[],
  options: SupervisedOptions,
): Promise<SupervisedResult> {
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const limit = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const isolated = options.isolateProcessGroup !== false && canIsolateGroup();
  const contained = isolated || insideSupervisedProcessGroup();
  const started = performance.now();
  const child = Bun.spawn(isolated ? ['setsid', ...command] : command, {
    cwd: options.cwd,
    env: contained ? { ...options.env, [SUPERVISED_GROUP_ENV]: '1' } : options.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  if (isolated) liveGroups.add(child.pid);
  let timedOut = false;
  let treeAtTimeout: string | undefined;
  // Chained so kills never interleave, and awaited before returning so no
  // SIGKILL can fire at a process-group id the kernel has since recycled.
  let termination = Promise.resolve();
  const terminate = (): Promise<void> => {
    termination = termination.then(async () => {
      if (IS_WINDOWS) {
        Bun.spawnSync(['taskkill', '/PID', String(child.pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        return;
      }
      if (!isolated) {
        child.kill('SIGKILL');
        return;
      }
      if (!groupAlive(child.pid)) return;
      signalGroup(child.pid, 'SIGTERM');
      const deadline = Date.now() + grace;
      while (Date.now() < deadline && groupAlive(child.pid)) await Bun.sleep(100);
      if (groupAlive(child.pid)) signalGroup(child.pid, 'SIGKILL');
    });
    return termination;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    treeAtTimeout = describeTree(child.pid, isolated);
    void terminate();
  }, options.timeoutMs);

  let stdout = '';
  let stderr = '';
  let output = '';
  let total = 0;
  let truncated = false;
  const pump = async (stream: ReadableStream<Uint8Array>, which: 'stdout' | 'stderr'): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Keep draining past the cap: the cap bounds what is kept, not what is read.
      if (total >= limit) { truncated = true; continue; }
      total += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      if (which === 'stdout') stdout += text;
      else stderr += text;
      output += text;
    }
  };
  const pumps = Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array>, 'stdout'),
    pump(child.stderr as ReadableStream<Uint8Array>, 'stderr'),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);

  let strays = false;
  if (isolated && groupAlive(child.pid)) {
    const settle = Date.now() + (options.strayGraceMs ?? 0);
    while (Date.now() < settle && groupAlive(child.pid)) await Bun.sleep(50);
    if (groupAlive(child.pid)) {
      strays = true;
      await terminate();
    }
  }
  await termination;
  if (!groupAlive(child.pid)) liveGroups.delete(child.pid);
  // A pipe can outlive every process we know about, so this wait is bounded.
  await Promise.race([pumps, Bun.sleep(grace)]);

  return {
    stdout,
    stderr,
    output,
    exitCode,
    success: exitCode === 0 && !timedOut,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    strays,
    treeAtTimeout,
    truncated,
  };
}

/**
 * Test switches that only choose which assertions run, never an endpoint:
 * `COSYNCING_E2E_KNOWN_BUGS=1` asserts the pinned known bugs too.
 */
const TEST_SWITCHES = new Set(['COSYNCING_E2E_KNOWN_BUGS']);

/**
 * The host environment minus everything that could point a test at a real
 * broker or agent endpoint: every `COSYNCING_*` variable (except the
 * {@link TEST_SWITCHES}), `PORT`, `HOST`, `OPENCODE_URL`.
 */
export function testEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('COSYNCING_') && !TEST_SWITCHES.has(key)) delete environment[key];
  }
  delete environment.PORT;
  delete environment.HOST;
  delete environment.OPENCODE_URL;
  return environment;
}
