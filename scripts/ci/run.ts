#!/usr/bin/env bun
/**
 * Run the test suites (see suites.ts). Locally and in CI this is the same command.
 *
 *   bun run check                        every suite this host can run
 *   bun run check broker adapters        selected suites
 *   bun run check client --shard 2/3     one CI shard
 *   bun run check broker --only pairing  tasks whose id contains "pairing"
 *   bun run check adapters --repeat 5    flake hunt: every task 5x, no retries
 *   bun run check --list                 print the plan and exit
 *
 * Output: output/check/report.json, report.md, logs/<suite>/<task>.log.
 * Exit 1 when any task failed. A task that fails, then passes on its one
 * retry, is FLAKY: reported and annotated, never a failure.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { runSupervised, testEnvironment, type SupervisedResult } from './lib/process.ts';
import {
  DEFAULT_TIMEOUT_MS,
  suiteRunsOn,
  suites,
  type Suite,
  type SuiteId,
  type Task,
} from './suites.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const OUTPUT = join(ROOT, 'output', 'check');
const IN_CI = process.env.GITHUB_ACTIONS === 'true';
const HOST = platform();

// ---------------------------------------------------------------- arguments

interface Options {
  suites: SuiteId[];
  shard?: { index: number; total: number };
  only?: string[];
  repeat: number;
  concurrency: number;
  retry: boolean;
  list: boolean;
}

function usage(code: number): never {
  console.log(
    'Usage: bun run check [SUITE...] [--shard I/N] [--only TEXT[,TEXT]] [--repeat N]\n'
      + '                     [--concurrency N] [--no-retry] [--list]\n\n'
      + `Suites: ${suites.map((suite) => suite.id).join(', ')}`,
  );
  process.exit(code);
}

function parseOptions(argv: string[]): Options {
  const known = new Set(suites.map((suite) => suite.id));
  const options: Options = {
    suites: [],
    repeat: 1,
    concurrency: defaultConcurrency(),
    retry: true,
    list: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) usage(2);
      return next;
    };
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--list') options.list = true;
    else if (arg === '--suites') {
      for (const suite of suites) console.log(suite.id);
      process.exit(0);
    }
    else if (arg === '--no-retry') options.retry = false;
    else if (arg === '--only') options.only = value().split(',').filter(Boolean);
    else if (arg === '--repeat') options.repeat = boundedInteger(value(), 1, 50, '--repeat');
    else if (arg === '--concurrency') options.concurrency = boundedInteger(value(), 1, 32, '--concurrency');
    else if (arg === '--shard') {
      const match = /^(\d+)\/(\d+)$/.exec(value());
      if (!match) usage(2);
      const shard = { index: Number(match[1]), total: Number(match[2]) };
      if (shard.total < 1 || shard.index < 1 || shard.index > shard.total) usage(2);
      options.shard = shard;
    } else if (known.has(arg as SuiteId)) options.suites.push(arg as SuiteId);
    else {
      console.error(`check: unknown argument ${arg}`);
      usage(2);
    }
  }
  if (options.suites.length === 0) {
    options.suites = suites.filter((suite) => suiteRunsOn(suite, HOST)).map((suite) => suite.id);
  }
  // Repeating is for finding flakes; a retry would hide exactly what it looks for.
  if (options.repeat > 1) options.retry = false;
  return options;
}

function boundedInteger(raw: string, min: number, max: number, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    console.error(`check: ${name} must be an integer from ${min} to ${max}`);
    process.exit(2);
  }
  return parsed;
}

function defaultConcurrency(): number {
  const raw = process.env.COSYNCING_CHECK_CONCURRENCY?.trim();
  if (raw) return boundedInteger(raw, 1, 32, 'COSYNCING_CHECK_CONCURRENCY');
  const cores = cpus().length || 4;
  return Math.max(2, Math.min(8, Math.floor(cores * 0.75)));
}

// ---------------------------------------------------------------- planning

interface PlannedTask {
  suite: Suite;
  task: Task;
  iteration: number;
}

/** Longest-processing-time-first assignment of tasks to N shards. */
function shardOf(tasks: Task[], shard: { index: number; total: number }): Set<string> {
  const loads = Array.from({ length: shard.total }, () => ({ ms: 0, ids: new Set<string>() }));
  const ordered = [...tasks].sort((a, b) =>
    estimate(b) - estimate(a) || a.id.localeCompare(b.id)
  );
  for (const task of ordered) {
    const lightest = loads.reduce((best, load) => (load.ms < best.ms ? load : best));
    lightest.ms += estimate(task);
    lightest.ids.add(task.id);
  }
  return loads[shard.index - 1]!.ids;
}

function estimate(task: Task): number {
  return task.estimateMs ?? (task.run[1] === 'test' ? 60_000 : 20_000);
}

function plan(options: Options): { prepare: PlannedTask[]; tasks: PlannedTask[] } {
  const prepare: PlannedTask[] = [];
  const tasks: PlannedTask[] = [];
  for (const id of options.suites) {
    const suite = suites.find((candidate) => candidate.id === id)!;
    if (!suiteRunsOn(suite, HOST)) {
      console.error(`check: suite ${id} does not run on ${HOST}`);
      process.exit(2);
    }
    let selected = suite.tasks;
    if (options.only) {
      selected = selected.filter((task) => options.only!.some((text) => task.id.includes(text)));
    }
    if (options.shard) {
      const mine = shardOf(selected, options.shard);
      selected = selected.filter((task) => mine.has(task.id));
    }
    if (selected.length === 0) continue;
    for (const task of suite.prepare ?? []) prepare.push({ suite, task, iteration: 1 });
    for (let iteration = 1; iteration <= options.repeat; iteration += 1) {
      for (const task of selected) tasks.push({ suite, task, iteration });
    }
  }
  // Longest first, so the slowest work is never the tail nobody overlaps.
  tasks.sort((a, b) => estimate(b.task) - estimate(a.task));
  return { prepare, tasks };
}

// ---------------------------------------------------------------- execution

type Status = 'pass' | 'fail' | 'flaky' | 'blocked';

interface Attempt {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  strays: boolean;
  summary: string;
  log: string;
}

interface TaskResult {
  suite: SuiteId;
  id: string;
  iteration: number;
  command: string[];
  status: Status;
  attempts: Attempt[];
}

/** Environment every task gets: the host's, minus anything that would point a test at a real broker. */
function taskEnvironment(): NodeJS.ProcessEnv {
  return { ...testEnvironment(), ...(IN_CI ? { CI: 'true' } : {}), FORCE_COLOR: '0', NO_COLOR: '1' };
}

function summarize(result: SupervisedResult): string {
  if (result.timedOut) return `timed out after ${Math.round(result.durationMs / 1000)}s`;
  const lines = result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failure = [...lines].reverse().find((line) =>
    /^(?:FAIL|error:|Error:|✗|\(fail\))|\bfail\b.*\d+ (?:fail|error)/i.test(line)
  );
  const pick = failure ?? lines.at(-1) ?? `exit ${result.exitCode}`;
  return pick.replaceAll(ROOT, '<repo>').slice(0, 240);
}

function logPath(planned: PlannedTask, attempt: number): string {
  const suffix = [
    planned.iteration > 1 ? `.run${planned.iteration}` : '',
    attempt > 1 ? `.retry${attempt - 1}` : '',
  ].join('');
  return join('logs', planned.suite.id, `${planned.task.id.replaceAll('/', '__')}${suffix}.log`);
}

async function attemptTask(planned: PlannedTask, attempt: number, env: NodeJS.ProcessEnv): Promise<Attempt> {
  const { task } = planned;
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = resolve(ROOT, task.cwd ?? '.');
  const result = await runSupervised(task.run, {
    cwd,
    env: { ...env, ...planned.suite.env?.(task) },
    timeoutMs,
    strayGraceMs: 2_000,
  });
  const log = logPath(planned, attempt);
  mkdirSync(join(OUTPUT, 'logs', planned.suite.id), { recursive: true });
  writeFileSync(
    join(OUTPUT, log),
    [
      `$ ${task.run.join(' ')}`,
      `cwd: ${cwd}`,
      `timeout: ${timeoutMs}ms  duration: ${result.durationMs}ms  exit: ${result.exitCode}`
        + `${result.timedOut ? '  TIMED OUT' : ''}${result.strays ? '  (leaked processes reaped)' : ''}`,
      ...(result.treeAtTimeout ? ['', '--- process tree when the timeout fired ---', result.treeAtTimeout] : []),
      ...(result.truncated ? ['(output truncated)'] : []),
      '',
      result.output,
    ].join('\n'),
  );
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    strays: result.strays,
    summary: result.success ? 'ok' : summarize(result),
    log,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function label(planned: PlannedTask): string {
  return `${planned.suite.id}/${planned.task.id}${planned.iteration > 1 ? ` #${planned.iteration}` : ''}`;
}

function printFailureTail(result: TaskResult): void {
  const last = result.attempts.at(-1);
  if (!last) return;
  const tail = readFileSync(join(OUTPUT, last.log), 'utf8').split('\n').slice(-120).join('\n');
  if (IN_CI) console.log(`::group::${result.suite}/${result.id} — last 120 lines of ${last.log}`);
  else console.log(`----- ${result.suite}/${result.id}: last 120 lines of output/check/${last.log}`);
  console.log(tail);
  if (IN_CI) console.log('::endgroup::');
}

async function runTask(planned: PlannedTask, retry: boolean, env: NodeJS.ProcessEnv): Promise<TaskResult> {
  const attempts: Attempt[] = [await attemptTask(planned, 1, env)];
  const mayRetry = retry && planned.task.retry !== false;
  if (attempts[0]!.exitCode !== 0 || attempts[0]!.timedOut) {
    if (mayRetry) attempts.push(await attemptTask(planned, 2, env));
  }
  const passed = (attempt: Attempt): boolean => attempt.exitCode === 0 && !attempt.timedOut;
  const status: Status = passed(attempts[0]!)
    ? 'pass'
    : attempts.length > 1 && passed(attempts[1]!) ? 'flaky' : 'fail';
  return {
    suite: planned.suite.id,
    id: planned.task.id,
    iteration: planned.iteration,
    command: planned.task.run,
    status,
    attempts,
  };
}

function announce(planned: PlannedTask, result: TaskResult): void {
  const total = result.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
  const marker = { pass: 'PASS ', fail: 'FAIL ', flaky: 'FLAKY', blocked: 'SKIP ' }[result.status];
  const detail = result.status === 'pass' ? '' : ` — ${result.attempts[0]?.summary ?? 'prepare step failed'}`;
  const strays = result.attempts.some((attempt) => attempt.strays) ? '  (leaked processes reaped)' : '';
  console.log(`${marker} ${label(planned)}  ${seconds(total)}${detail}${strays}`);
  if (IN_CI && result.status === 'flaky') {
    console.log(
      `::warning title=FLAKY ${result.suite}/${result.id}::failed then passed on retry. `
        + `First attempt: ${result.attempts[0]!.summary.replaceAll('\n', ' ')}`,
    );
  }
  if (IN_CI && result.status === 'fail') {
    console.log(`::error title=${result.suite}/${result.id}::${result.attempts.at(-1)!.summary.replaceAll('\n', ' ')}`);
  }
}

async function runPool(tasks: PlannedTask[], options: Options, env: NodeJS.ProcessEnv): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  const pending = [...tasks];
  const running = new Set<Promise<void>>();
  let serialBusy = false;
  while (pending.length > 0 || running.size > 0) {
    while (running.size < options.concurrency) {
      const index = pending.findIndex((planned) => !(planned.task.serial && serialBusy));
      if (index < 0) break;
      const [planned] = pending.splice(index, 1);
      if (planned!.task.serial) serialBusy = true;
      const job = runTask(planned!, options.retry, env).then((result) => {
        if (planned!.task.serial) serialBusy = false;
        results.push(result);
        announce(planned!, result);
        if (result.status === 'fail') printFailureTail(result);
      });
      const tracked = job.finally(() => running.delete(tracked));
      running.add(tracked);
    }
    if (running.size > 0) await Promise.race(running);
  }
  return results;
}

// ---------------------------------------------------------------- report

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return result.success ? result.stdout.toString().trim() : '';
}

function writeReports(
  options: Options,
  results: TaskResult[],
  startedAt: Date,
  durationMs: number,
  complete: boolean,
): 'pass' | 'fail' {
  const counts = { pass: 0, fail: 0, flaky: 0, blocked: 0 };
  for (const result of results) counts[result.status] += 1;
  const status = counts.fail + counts.blocked === 0 ? 'pass' : 'fail';
  const report = {
    schemaVersion: 6,
    kind: 'repository-check',
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
    host: { platform: HOST, arch: process.arch, bun: Bun.version },
    selection: {
      suites: options.suites,
      shard: options.shard ? `${options.shard.index}/${options.shard.total}` : null,
      only: options.only ?? null,
      repeat: options.repeat,
      // Every suite this host can run, unsharded and unfiltered: the only
      // shape a release checkpoint accepts.
      complete,
    },
    startedAt: startedAt.toISOString(),
    durationMs,
    status,
    counts,
    tasks: results,
  };
  writeFileSync(join(OUTPUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const notable = results.filter((result) => result.status !== 'pass');
  const slowest = [...results]
    .sort((a, b) => b.attempts[0]!.durationMs - a.attempts[0]!.durationMs)
    .slice(0, 10);
  const markdown = [
    `### Check ${status === 'pass' ? 'passed' : 'FAILED'} — ${options.suites.join(', ')}`
      + `${options.shard ? ` (shard ${options.shard.index}/${options.shard.total})` : ''}`,
    '',
    `${counts.pass} passed · ${counts.flaky} flaky · ${counts.fail} failed · ${counts.blocked} skipped`
      + ` · ${seconds(durationMs)} wall · commit \`${report.commit.slice(0, 12)}\`${report.dirty ? ' (dirty)' : ''}`,
    '',
    ...(notable.length > 0
      ? [
        '| Task | Status | First failure |',
        '|---|---|---|',
        ...notable.map((result) =>
          `| \`${result.suite}/${result.id}\` | ${result.status} | ${
            (result.attempts[0]?.summary ?? 'prepare failed').replaceAll('|', '\\|')
          } |`
        ),
        '',
      ]
      : []),
    '<details><summary>Slowest tasks</summary>',
    '',
    '| Task | Time |',
    '|---|---|',
    ...slowest.map((result) => `| \`${result.suite}/${result.id}\` | ${seconds(result.attempts[0]!.durationMs)} |`),
    '',
    '</details>',
    '',
  ].join('\n');
  writeFileSync(join(OUTPUT, 'report.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  return status;
}

// ---------------------------------------------------------------- main

const options = parseOptions(process.argv.slice(2));
const { prepare, tasks } = plan(options);

if (options.list) {
  for (const planned of prepare) console.log(`prepare  ${planned.suite.id}/${planned.task.id}: ${planned.task.run.join(' ')}`);
  for (const planned of tasks) {
    console.log(`task     ${label(planned)}${planned.task.serial ? ' [serial]' : ''}: ${planned.task.run.join(' ')}`);
  }
  console.log(`${prepare.length} prepare step(s), ${tasks.length} task(s), concurrency ${options.concurrency}`);
  process.exit(0);
}

const startedAt = new Date();
const started = performance.now();
rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
const env = taskEnvironment();
// Bun 1.3.8 intermittently livelocks while loading a module graph or bundling: one pool thread spins,
// nothing prints, and the task hangs until its timeout. CI runs a newer Bun for that reason.
if (Bun.version === '1.3.8') {
  console.warn('check: WARNING — Bun 1.3.8 can stall loading modules; expect occasional timeouts (use 1.3.14+).');
}
console.log(
  `check: ${options.suites.join(', ')}${options.shard ? ` shard ${options.shard.index}/${options.shard.total}` : ''}`
    + ` — ${tasks.length} task(s), concurrency ${options.concurrency}`
    + `${options.retry ? ', one retry' : ', no retry'}`,
);

// Prepare steps run in order. A failed one skips its suite's tasks. A step
// another selected suite already ran (the same command in the same directory)
// runs once.
const brokenSuites = new Set<SuiteId>();
const results: TaskResult[] = [];
const prepared = new Map<string, boolean>();
for (const planned of prepare) {
  if (brokenSuites.has(planned.suite.id)) continue;
  const key = `${planned.task.cwd ?? '.'}\0${planned.task.run.join('\0')}`;
  const earlier = prepared.get(key);
  if (earlier !== undefined) {
    if (!earlier) brokenSuites.add(planned.suite.id);
    continue;
  }
  const result = await runTask(planned, true, env);
  prepared.set(key, result.status !== 'fail');
  announce(planned, result);
  if (result.status === 'fail') {
    printFailureTail(result);
    results.push(result);
    brokenSuites.add(planned.suite.id);
  }
}
const runnable = tasks.filter((planned) => !brokenSuites.has(planned.suite.id));
for (const planned of tasks.filter((candidate) => brokenSuites.has(candidate.suite.id))) {
  results.push({
    suite: planned.suite.id,
    id: planned.task.id,
    iteration: planned.iteration,
    command: planned.task.run,
    status: 'blocked',
    attempts: [],
  });
}
try {
  results.push(...await runPool(runnable, options, env));
} finally {
  for (const id of options.suites) suites.find((suite) => suite.id === id)!.cleanup?.();
}

const order = new Map(tasks.map((planned, index) => [`${planned.suite.id}/${planned.task.id}/${planned.iteration}`, index]));
results.sort((a, b) =>
  (order.get(`${a.suite}/${a.id}/${a.iteration}`) ?? -1) - (order.get(`${b.suite}/${b.id}/${b.iteration}`) ?? -1)
);
const allHostSuites = suites.filter((suite) => suiteRunsOn(suite, HOST)).map((suite) => suite.id);
const complete = !options.shard && !options.only && options.repeat === 1
  && allHostSuites.every((id) => options.suites.includes(id));
const status = writeReports(options, results, startedAt, Math.round(performance.now() - started), complete);
const flaky = results.filter((result) => result.status === 'flaky').length;
const failed = results.filter((result) => result.status === 'fail' || result.status === 'blocked').length;
console.log(
  `${status === 'pass' ? 'PASS' : 'FAIL'} ${results.length - failed - flaky} passed, ${flaky} flaky, ${failed} failed`
    + ` in ${seconds(performance.now() - started)} — report: output/check/report.md`,
);
process.exit(status === 'pass' ? 0 : 1);
