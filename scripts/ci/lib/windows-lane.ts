/**
 * Per-run isolation for the Windows suite.
 *
 * A CI runner can be reused, and a durable name (a fixed state directory, a
 * fixed Scheduled Task) is how one run's leftovers become the next run's
 * failure. Every task gets its own state directory under one run-scoped root,
 * and everything carries the run identifier, so cleanup can only match this
 * run's own leftovers and never an operator's install.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../suites.ts';

const runId = (() => {
  const configured = process.env.COSYNCING_WINDOWS_BROKER_RUN_ID?.trim();
  const id = configured || `wb-${process.pid}-${Date.now().toString(36)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error('COSYNCING_WINDOWS_BROKER_RUN_ID is not a safe identifier');
  }
  return id;
})();

const stateRoot = join(tmpdir(), `cosyncing-windows-broker-${runId}`);

function sweepScheduledTasks(): number {
  const listed = Bun.spawnSync(['schtasks', '/Query', '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'pipe' });
  if (!listed.success) return 0;
  let removed = 0;
  const names = new Set<string>();
  for (const line of listed.stdout.toString().split(/\r?\n/)) {
    const name = line.split('","')[0]?.replace(/^"/, '');
    if (name && name.includes(runId)) names.add(name);
  }
  for (const name of names) {
    if (Bun.spawnSync(['schtasks', '/Delete', '/TN', name, '/F'], { stdout: 'ignore', stderr: 'ignore' }).success) {
      removed += 1;
    }
  }
  return removed;
}

export const windowsLane = {
  env(task: Task): Record<string, string> {
    const home = join(stateRoot, task.id.replace(/[^A-Za-z0-9]+/g, '-'));
    mkdirSync(home, { recursive: true });
    return {
      COSYNCING_HOME: join(home, 'cosyncing-home'),
      COSYNCING_CACHE_DIR: join(home, 'cache'),
      COSYNCING_WINDOWS_BROKER_RUN_ID: runId,
    };
  },
  /** Scheduled tasks first: removing the state a task points at leaves a task that fails. */
  cleanup(): void {
    const swept = process.platform === 'win32' ? sweepScheduledTasks() : 0;
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // Reported below; a leftover never turns a finished run red.
    }
    console.log(
      `windows cleanup ${runId}: ${swept} scheduled task(s) removed, state removed=${!existsSync(stateRoot)}`,
    );
  },
};
