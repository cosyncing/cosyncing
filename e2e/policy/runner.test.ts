import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSupervised, signalSupervisedGroups } from '../../scripts/ci/lib/process.ts';

const roots: string[] = [];
// Intentional failures in nested fixture runs must not annotate the real CI job.
const fixtureEnv = { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: '', COSYNCING_CHECK_OUTPUT: '' };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'check-runner-')); roots.push(path); return path; };
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('fixture did not become ready');
    await Bun.sleep(10);
  }
}
function runner(directory: string, tasks: unknown[], suiteId = 'policy', platforms?: string[]): string {
  const ci = join(directory, 'scripts/ci');
  mkdirSync(ci, { recursive: true });
  cpSync(resolve(import.meta.dir, '../../scripts/ci/run.ts'), join(ci, 'run.ts'));
  cpSync(resolve(import.meta.dir, '../../scripts/ci/check-plan.ts'), join(ci, 'check-plan.ts'));
  cpSync(resolve(import.meta.dir, '../../scripts/ci/lib'), join(ci, 'lib'), { recursive: true });
  writeFileSync(join(ci, 'suites.ts'), `export const DEFAULT_TIMEOUT_MS = 10000;
export const suiteRunsOn = (suite, host) => !suite.platforms || suite.platforms.includes(host);
export const suites = [{id:${JSON.stringify(suiteId)},platforms:${JSON.stringify(platforms)},tasks:${JSON.stringify(tasks)}}];`);
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
    const report = JSON.parse(readFileSync(join(directory, 'output/check/report.json'), 'utf8'));
    expect(report.cancelled).toBe(true);
    expect(report.status).toBe('fail');
    expect(report.tasks.find((task: {id: string}) => task.id === 'queued').status).toBe('blocked');
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

test('unsupported suites and empty selections are usage errors without a stack trace', async () => {
  for (const scenario of ['unsupported', 'empty'] as const) {
    const directory = root();
    const suiteId = scenario === 'unsupported' ? 'windows' : 'policy';
    const unsupported = process.platform === 'win32' ? 'linux' : 'win32';
    const entry = runner(directory, [{id: 'present', run: [process.execPath, '-e', 'process.exit(0)']}], suiteId,
      scenario === 'unsupported' ? [unsupported] : undefined);
    const child = Bun.spawn([process.execPath, entry, suiteId, '--list', ...(scenario === 'empty' ? ['--only', 'missing'] : [])],
      {env: {...fixtureEnv, COSYNCING_CHECK_OUTPUT: ''}, stdout: 'pipe', stderr: 'pipe'});
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain(scenario === 'empty' ? 'no tasks match' : 'does not run on');
    expect(stderr).not.toContain('at planChecks');
    expect(existsSync(join(directory, 'output/check/report.json'))).toBe(false);
  }
});

test('the former Flutter shard filter still selects and runs exactly that shard', async () => {
  const directory = root();
  const marker = join(directory, 'selected');
  const entry = runner(directory, [1,2,3].map(index => ({id: `flutter-test-${index}-of-3`,
    run: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, '${index}')`]})), 'client');
  const child = Bun.spawn([process.execPath, entry, 'client', '--only', 'flutter-test-2-of-3'],
    {env: {...fixtureEnv, COSYNCING_CHECK_OUTPUT: ''}, stdout: 'pipe', stderr: 'pipe'});
  expect(await child.exited).toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe('2');
  const report = JSON.parse(readFileSync(join(directory, 'output/check/report.json'), 'utf8'));
  expect(report.counts.pass).toBe(1);
  expect(report.selection.complete).toBe(false);
});

test('an output override cannot remove the fixture source tree', async () => {
  const directory = root();
  const entry = runner(directory, [{id: 'safe', run: [process.execPath, '-e', 'process.exit(0)']}]);
  const child = Bun.spawn([process.execPath, entry], {
    env: {...fixtureEnv, COSYNCING_CHECK_OUTPUT: directory}, stdout: 'ignore', stderr: 'pipe',
  });
  expect(await child.exited).toBe(2);
  expect(existsSync(entry)).toBe(true);
});
