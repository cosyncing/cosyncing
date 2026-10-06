/** Stop only a child this capture started, including Windows command wrappers. */
import { HostProcessProvider, terminateHostProcessTree, type HostProcessIdentity, type HostProcessRead } from '../../packages/typescript/adapter-api/src/index.ts';

export interface CaptureChildEffects {
  read(pid: number, options: { fresh?: boolean }): HostProcessRead;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function captureChildEffects(): CaptureChildEffects {
  const processes = new HostProcessProvider();
  return {
    read: (pid, options) => processes.liveProcess(pid, options),
    signal: (pid, signal) => {
      if (process.platform === 'win32') terminateHostProcessTree(pid, signal === 'SIGKILL');
      else process.kill(pid, signal);
    },
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
  };
}

export function rememberCaptureChild(pid: number, effects: CaptureChildEffects): HostProcessIdentity {
  const process = effects.read(pid, { fresh: true });
  if (process.state !== 'running') throw new Error('capture child identity could not be proved');
  return { ...process.identity };
}

/** Reuse the supervisor's first fresh proof; never add an OS probe to startup. */
export function trackCaptureChildren<Launch, Child extends { pid: number }>(effects: {
  spawn(launch: Launch): Child;
  liveProcess(pid: number, options?: { fresh?: boolean }): HostProcessRead;
}): { launched: Set<number>; identities: Map<number, HostProcessIdentity> } {
  const launched = new Set<number>();
  const identities = new Map<number, HostProcessIdentity>();
  const spawn = effects.spawn.bind(effects);
  const read = effects.liveProcess.bind(effects);
  effects.spawn = (launch) => {
    const child = spawn(launch);
    launched.add(child.pid);
    return child;
  };
  effects.liveProcess = (pid, options) => {
    const live = read(pid, options);
    if (launched.has(pid) && !identities.has(pid) && options?.fresh && live.state === 'running') {
      identities.set(pid, { ...live.identity });
    }
    return live;
  };
  return { launched, identities };
}

export type CaptureChildStop =
  | { ok: true; state: 'stopped' | 'already-gone'; escalated: boolean }
  | { ok: false; state: 'preserved'; reason: 'unknown' | 'identity-changed' | 'still-running' };

export async function stopCaptureChild(
  owned: HostProcessIdentity, effects: CaptureChildEffects, graceMs = 3000,
): Promise<CaptureChildStop> {
  const inspect = (fresh = false): 'owned' | 'absent' | 'unknown' | 'identity-changed' => {
    const live = effects.read(owned.pid, { fresh });
    if (live.state !== 'running') return live.state;
    return live.identity.pid === owned.pid && live.identity.start === owned.start && live.identity.boot === owned.boot
      ? 'owned' : 'identity-changed';
  };
  const initial = inspect(true);
  if (initial === 'absent') return { ok: true, state: 'already-gone', escalated: false };
  if (initial !== 'owned') return { ok: false, state: 'preserved', reason: initial };
  effects.signal(owned.pid, 'SIGTERM');
  for (const deadline = effects.now() + graceMs; effects.now() < deadline;) {
    const state = inspect();
    if (state === 'absent') return { ok: true, state: 'stopped', escalated: false };
    if (state !== 'owned') return { ok: false, state: 'preserved', reason: state };
    await effects.sleep(50);
  }
  // A wrapper can disappear or its PID can be reused while waiting. Neither
  // permits escalation against the next process to receive that number.
  const beforeKill = inspect(true);
  if (beforeKill === 'absent') return { ok: true, state: 'stopped', escalated: false };
  if (beforeKill !== 'owned') return { ok: false, state: 'preserved', reason: beforeKill };
  effects.signal(owned.pid, 'SIGKILL');
  for (const deadline = effects.now() + 3000; effects.now() < deadline;) {
    const state = inspect();
    if (state === 'absent') return { ok: true, state: 'stopped', escalated: true };
    if (state !== 'owned') return { ok: false, state: 'preserved', reason: state };
    await effects.sleep(50);
  }
  return { ok: false, state: 'preserved', reason: 'still-running' };
}
