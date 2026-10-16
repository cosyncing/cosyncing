/**
 * A real zombie for tests, Linux only (it reads `/proc`). Every process here is one the fixture starts:
 * `sh` puts a short `sleep` in the background and replaces itself with a long one, which never waits
 * for children, so the short one exits and stays a zombie until {@link Zombie.reap} ends that parent
 * and the system reaps the orphan. {@link stopZombieParents} ends any parent a test left running.
 */
import { readdirSync, readFileSync } from 'node:fs';

export interface Zombie {
  pid: number;
  /** The long `sleep` that will not reap it: a live process of the fixture's own. */
  parentPid: number;
  /** End the parent; the system reaps the orphaned zombie, and this returns once it is gone. */
  reap(): void;
}

const parents: Bun.Subprocess[] = [];

/** The state letter in `/proc/<pid>/stat`, or undefined once the process is gone. */
export function procState(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    // Kernels without CONFIG_PROC_CHILDREN: find the children by their parent field.
    return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number).filter((candidate) => {
      try {
        const raw = readFileSync(`/proc/${candidate}/stat`, 'utf8');
        return Number(raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[1]) === pid;
      } catch {
        return false;
      }
    });
  }
}

/** `ps -o lstart` with its spacing normalized, as Codex daemon receipts record it. */
export function lstart(pid: number): string | undefined {
  const result = Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' }, stdout: 'pipe', stderr: 'pipe',
  });
  const value = result.stdout.toString().trim();
  return result.exitCode === 0 && value ? value.replace(/\s+/g, ' ') : undefined;
}

export function waitUntil(condition: () => boolean, what: string): void {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    Bun.sleepSync(10);
  }
}

export function startZombie(): Zombie {
  const parent = Bun.spawn(['/bin/sh', '-c', 'sleep 0.2 & exec sleep 60'], { stdio: ['ignore', 'ignore', 'ignore'] });
  parents.push(parent);
  let pid = 0;
  waitUntil(() => {
    pid = childrenOf(parent.pid)[0] ?? 0;
    return pid > 0 && procState(pid) === 'Z';
  }, 'the background sleep to become a zombie');
  return {
    pid,
    parentPid: parent.pid,
    reap: () => {
      parent.kill('SIGKILL');
      waitUntil(() => procState(pid) === undefined, `zombie ${pid} to be reaped`);
    },
  };
}

export function stopZombieParents(): void {
  for (const parent of parents.splice(0)) parent.kill('SIGKILL');
}
