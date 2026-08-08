/**
 * Spawn a verification command under its own process group and bound its clock.
 *
 * Two problems this exists to solve:
 *
 * 1. `Bun.spawn().kill()` and `spawnSync`'s own timeout signal the direct child
 *    only. A wedged gate leaves its grandchildren running — `flutter_tester`
 *    and `chrome-headless-shell` were both observed surviving a completed
 *    check, the latter still holding a fixed CDP port and answering requests
 *    the next run would then drive by mistake.
 * 2. Killing on a timeout is not enough: a gate that *exits cleanly* can still
 *    leak. Stray processes were found on this host dating back weeks.
 *
 * Top-level commands therefore exec through `setsid`. For a child that is not
 * already a process group leader `setsid` calls `setsid(2)` and execs in place,
 * so the pid we hold becomes its own session and group leader and `kill(-pid)`
 * reaches the entire tree. After the leader exits we sweep that group, which is
 * a leak reaper: nothing else can be in it. Nested stage deadlines opt out of a
 * second `setsid`, remaining reachable by that outer sweep.
 */
import { platform } from 'node:os';

export interface SupervisedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /**
   * Start a new session/process group. Disable this only for a bounded stage
   * already running inside a runSupervised suite: keeping the inherited group
   * lets the outer supervisor reap the whole tree if the suite disappears.
   */
  isolateProcessGroup?: boolean;
  /** Time a signalled group gets to exit before it is killed outright. */
  graceMs?: number;
  /**
   * Time a group whose leader has already exited gets to finish exiting before
   * its survivors are counted as strays. Opt-in, default 0, so every caller
   * that does not ask for it keeps the original instant verdict.
   *
   * This distinguishes a teardown already in flight from a leak. A leaked
   * process does not exit on its own — the cases this file exists for held a
   * CDP port for weeks — so no finite window hides one. What it does absorb is
   * a child the leader has already asked to exit and did not outlive by more
   * than a scheduling delay. Survivors past the window are reported and reaped
   * exactly as before.
   */
  strayGraceMs?: number;
  maxBufferBytes?: number;
}

export interface SupervisedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  /** The group outlived its leader and had to be reaped. */
  strays: boolean;
  /** False means `strays` is unknown rather than false: nothing was contained. */
  groupIsolated: boolean;
  /** Output was capped; the command produced more than `maxBufferBytes`. */
  truncated: boolean;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 64 << 20;
const SUPERVISED_GROUP_ENV = 'COSYNCING_SUPERVISED_PROCESS_GROUP';

export function insideSupervisedProcessGroup(): boolean {
  return process.env[SUPERVISED_GROUP_ENV] === '1';
}

/**
 * `setsid` is util-linux. Without it there is no in-place group leader, the
 * best available cleanup is signalling the direct child, and `strays` can only
 * ever be false — not because nothing leaked, but because nothing was looked
 * at. That distinction is invisible in a report, so say it out loud once.
 */
let groupIsolation: boolean | undefined;
export function supportsGroupIsolation(): boolean {
  if (groupIsolation !== undefined) return groupIsolation;
  groupIsolation = platform() === 'linux'
    && Bun.spawnSync(['setsid', 'true'], { stdout: 'ignore', stderr: 'ignore' })
      .success;
  if (!groupIsolation) {
    console.warn(
      'WARN supervised-process: no setsid on this host, so gates run without '
        + 'process-group isolation. A timeout signals only the direct child, '
        + 'and leaked grandchildren are neither reaped nor reported.',
    );
  }
  return groupIsolation;
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** True while any process in the group is still alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Sink { text: string; truncated: boolean }

/**
 * Drain a pipe into `sink`, which stays readable even if we stop waiting.
 *
 * The caller must be able to give up on a pipe. A process group's stdout is
 * held open by *every* process in it, so one lingering grandchild keeps the
 * stream unfinished long after the leader exited — waiting for end-of-stream
 * as a condition of finishing turned a leak into a hang that only its timeout
 * could end. Accumulating into a sink lets the caller take what arrived.
 */
async function pump(
  stream: ReadableStream<Uint8Array> | number | undefined,
  limit: number,
  sink: Sink,
): Promise<void> {
  if (!stream || typeof stream === 'number') return;
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    // Keep draining past the cap: a child whose pipe fills up would block
    // forever, so the limit bounds what we keep, not what we read.
    if (total >= limit) { sink.truncated = true; continue; }
    const room = limit - total;
    const chunk = value.byteLength > room ? value.subarray(0, room) : value;
    if (chunk.byteLength < value.byteLength) sink.truncated = true;
    total += chunk.byteLength;
    sink.text += decoder.decode(chunk, { stream: true });
  }
  sink.text += decoder.decode();
}

export async function runSupervised(
  command: string[],
  options: SupervisedOptions,
): Promise<SupervisedResult> {
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const limit = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const isolated = options.isolateProcessGroup !== false && supportsGroupIsolation();
  const contained = isolated || insideSupervisedProcessGroup();
  const started = performance.now();
  const child = Bun.spawn(
    isolated ? ['setsid', ...command] : command,
    {
      cwd: options.cwd,
      env: contained
        ? { ...options.env, [SUPERVISED_GROUP_ENV]: '1' }
        : options.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  );

  let timedOut = false;
  /**
   * Terminate the group, once at a time, and never signal what is already gone.
   *
   * The timeout used to start this without anyone awaiting it, so the function
   * could return while a kill was still sleeping out its grace period — and
   * then fire an unconditional `SIGKILL` at a process-group id the kernel may
   * by that point have recycled onto somebody else's processes. Calls are
   * chained so they cannot interleave, each re-checks liveness before
   * signalling, and the caller awaits the chain before returning.
   */
  let termination = Promise.resolve();
  const terminate = (): Promise<void> => {
    termination = termination.then(async () => {
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

  const timer = setTimeout(() => { timedOut = true; void terminate(); }, options.timeoutMs);
  // Drain both pipes while the child runs; a gate that fills a pipe buffer
  // while we await its exit would deadlock instead of finishing.
  const out: Sink = { text: '', truncated: false };
  const err: Sink = { text: '', truncated: false };
  const pumps = Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array>, limit, out),
    pump(child.stderr as ReadableStream<Uint8Array>, limit, err),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);

  // The leader is gone. Anything still in its group is a leak by definition —
  // and is also still holding the pipes, so reap before waiting on them. With
  // `strayGraceMs` the "by definition" is re-checked over a bounded window
  // first, so a child that is already on its way out is not a leak.
  let strays = false;
  if (isolated && groupAlive(child.pid)) {
    const settleDeadline = Date.now() + (options.strayGraceMs ?? 0);
    while (Date.now() < settleDeadline && groupAlive(child.pid)) await Bun.sleep(50);
    if (groupAlive(child.pid)) {
      strays = true;
      await terminate();
    }
  }
  // Nothing may outlive this call: a kill still sleeping out its grace period
  // would otherwise fire after the pid could have been recycled.
  await termination;
  // Whatever arrived is the output. This wait is bounded because a pipe can
  // outlive every process we know about.
  await Promise.race([pumps, Bun.sleep(grace)]);

  return {
    stdout: out.text,
    stderr: err.text,
    exitCode,
    success: exitCode === 0 && !timedOut,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    strays,
    groupIsolated: isolated,
    truncated: out.truncated || err.truncated,
  };
}
