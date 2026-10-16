import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSupervised, signalSupervisedGroups } from '../../scripts/ci/lib/process.ts';

const roots: string[] = [];
// Intentional failures in nested fixture runs must not annotate the real CI job.
const fixtureEnv = { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: '' };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'check-runner-')); roots.push(path); return path; };
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('fixture did not become ready');
    await Bun.sleep(10);
  }
}
function runner(directory: string, tasks: unknown[]): string {
  const ci = join(directory, 'scripts/ci');
  mkdirSync(ci, { recursive: true });
  cpSync(resolve(import.meta.dir, '../../scripts/ci/run.ts'), join(ci, 'run.ts'));
  cpSync(resolve(import.meta.dir, '../../scripts/ci/lib'), join(ci, 'lib'), { recursive: true });
  writeFileSync(join(ci, 'suites.ts'), `export const DEFAULT_TIMEOUT_MS = 10000;
export const suiteRunsOn = () => true;
export const suites = [{id:'policy',tasks:${JSON.stringify(tasks)}}];`);
  return join(ci, 'run.ts');
}

test.skipIf(process.platform !== 'linux')('a reaped child fails the task even when its leader exits zero', async () => {
  const directory = root();
  const entry = runner(directory, [{ id: 'leak', run: ['sh', '-c', 'sleep 30 & exit 0'] }]);
  const child = Bun.spawn([process.execPath, entry, '--no-retry'], { env: fixtureEnv, stdout: 'ignore', stderr: 'pipe' });
  expect(await child.exited).toBe(1);
  const report = JSON.parse(readFileSync(join(directory, 'output/check/report.json'), 'utf8'));
  expect(report.tasks[0].status).toBe('fail');
  expect(report.tasks[0].attempts[0].strays).toBe(true);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cancelling starts neither a retry nor the next queued task', async () => {
  const directory = root();
  const marker = join(directory, 'starts');
  const fixture = join(directory, 'task.ts');
  writeFileSync(fixture, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'start\\n');
process.on('SIGTERM', () => process.exit(1)); setInterval(() => {},1000);`);
  const entry = runner(directory, ['first', 'queued'].map(id => ({ id, run: [process.execPath, fixture] })));
  const child = Bun.spawn([process.execPath, entry, '--concurrency', '1'], { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' });
  try {
    await until(() => existsSync(marker));
    child.kill('SIGTERM');
    expect(await child.exited).toBe(130);
    expect(readFileSync(marker, 'utf8')).toBe('start\n');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
}, 20_000);

test('cancellation also tracks tasks without an isolated process group', async () => {
  const directory = root();
  const ready = join(directory, 'ready');
  const task = runSupervised([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, '');setInterval(()=>{},1000)`], {
    cwd: directory, env: process.env, timeoutMs: 10_000, isolateProcessGroup: false,
  });
  await until(() => existsSync(ready));
  expect(signalSupervisedGroups('SIGTERM')).toBeGreaterThan(0);
  const result = await task;
  expect(result.timedOut).toBe(false);
  expect(result.success).toBe(false);
});
