/** The runner and release evidence validators use this same discovered plan. */
import { platform } from 'node:os';
import { DEFAULT_TIMEOUT_MS, suiteRunsOn, suites, type Suite, type SuiteId, type Task } from './suites.ts';

export type FlutterLayout = 'combined' | 'serial-shards';

export interface CheckSelection {
  suites: SuiteId[];
  shard?: { index: number; total: number };
  only?: string[];
  repeat: number;
  flutterLayout?: FlutterLayout;
}

export interface PlannedTask {
  suite: Suite;
  task: Task;
  iteration: number;
}

export function hostSuiteIds(host: NodeJS.Platform = platform(), android?: boolean): SuiteId[] {
  return suites.filter((suite) => suite.id === 'android' && android !== undefined
    ? android && (suite.platforms ?? ['linux', 'darwin']).includes(host)
    : suiteRunsOn(suite, host)).map((suite) => suite.id);
}

export function estimate(task: Task): number {
  return task.estimateMs ?? (task.run[1] === 'test' ? 60_000 : 20_000);
}

function shardOf(tasks: Task[], shard: { index: number; total: number }): Set<string> {
  const loads = Array.from({ length: shard.total }, () => ({ ms: 0, ids: new Set<string>() }));
  for (const task of [...tasks].sort((a, b) => estimate(b) - estimate(a) || a.id.localeCompare(b.id))) {
    const lightest = loads.reduce((best, load) => load.ms < best.ms ? load : best);
    lightest.ms += estimate(task);
    lightest.ids.add(task.id);
  }
  return loads[shard.index - 1]!.ids;
}

function tasksFor(suite: Suite, selection: CheckSelection): Task[] {
  if (suite.id !== 'client' || selection.shard || selection.flutterLayout !== 'combined') return suite.tasks;
  const shards = suite.tasks.filter((task) => /^flutter-test-\d+-of-\d+$/.test(task.id));
  const files = shards.flatMap((task) => task.run.slice(3)).sort();
  if (!files.length || new Set(files).size !== files.length) throw new Error('invalid Flutter file partition');
  return [
    ...suite.tasks.filter((task) => !shards.includes(task)),
    {
      id: 'flutter-test',
      run: ['flutter', 'test', '--no-pub', ...files],
      // The combined task owns all three former invocations. Preserve their
      // total bound; a benchmark target must not become a shortened hang bound.
      cwd: 'apps/client', serial: true,
      timeoutMs: shards.reduce((total, task) => total + (task.timeoutMs ?? DEFAULT_TIMEOUT_MS), 0),
      estimateMs: shards.reduce((total, task) => total + estimate(task), 0),
    },
  ];
}

export function planChecks(
  selection: CheckSelection,
  host: NodeJS.Platform = platform(),
  checkHost = true,
): { prepare: PlannedTask[]; tasks: PlannedTask[] } {
  if (new Set(selection.suites).size !== selection.suites.length) throw new Error('duplicate check suites');
  if (selection.shard && selection.flutterLayout === 'combined') throw new Error('combined Flutter layout cannot be sharded');
  const prepare: PlannedTask[] = [];
  const tasks: PlannedTask[] = [];
  for (const id of selection.suites) {
    const suite = suites.find((candidate) => candidate.id === id);
    if (!suite || checkHost && !suiteRunsOn(suite, host)) throw new Error(`suite ${id} does not run on ${host}`);
    let selected = tasksFor(suite, selection);
    if (selection.only) selected = selected.filter((task) => selection.only!.some((text) => task.id.includes(text)));
    if (selection.shard) {
      const mine = shardOf(selected, selection.shard);
      selected = selected.filter((task) => mine.has(task.id));
    }
    if (!selected.length) continue;
    for (const task of suite.prepare ?? []) prepare.push({ suite, task, iteration: 1 });
    for (let iteration = 1; iteration <= selection.repeat; iteration++) {
      for (const task of selected) tasks.push({ suite, task, iteration });
    }
  }
  tasks.sort((a, b) => estimate(b.task) - estimate(a.task));
  return { prepare, tasks };
}

export function taskKey(task: Pick<PlannedTask, 'suite' | 'task'>): string {
  return `${task.suite.id}/${task.task.id}`;
}

/** File units let combined and hosted Flutter invocations prove identical coverage. */
export function coverageUnits(task: PlannedTask): string[] {
  return task.suite.id === 'client' && /^flutter-test(?:-\d+-of-\d+)?$/.test(task.task.id)
    ? task.task.run.slice(3).map((file) => `client/flutter-file/${file}`)
    : [taskKey(task)];
}
