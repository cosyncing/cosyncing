/** Validate observed results against the runner's discovered plan, without executing tasks. */
import { coverageUnits, hostSuiteIds, planChecks, taskKey, type CheckSelection, type FlutterLayout } from './check-plan.ts';
import { suites, type SuiteId } from './suites.ts';

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sameSet(actual: string[], expected: string[], label: string): void {
  requireThat(new Set(actual).size === actual.length && actual.length === expected.length
    && expected.every((item) => actual.includes(item)), `${label} differs from the discovered plan`);
}

export interface EvidenceContext {
  commit: string;
  dirty?: boolean;
  requiredSuites?: SuiteId[];
  complete?: boolean;
  bun?: string;
  platform?: NodeJS.Platform;
  provenance?: Record<string, unknown>;
}

export interface ValidatedCheck {
  report: Record<string, unknown>;
  selection: CheckSelection;
  counts: { pass: number; flaky: number; fail: number; blocked: number };
}

export function validateCheck(value: unknown, context: EvidenceContext): ValidatedCheck {
  const report = object(value, 'check report');
  requireThat(report.schemaVersion === 7 && report.kind === 'repository-check', 'unsupported check report schema');
  requireThat(report.commit === context.commit && /^[0-9a-f]{40}$/.test(context.commit), 'check commit differs from source');
  requireThat(report.dirty === (context.dirty ?? false), 'check dirty state differs from source');
  requireThat(report.status === 'pass', 'check did not pass');
  const host = object(report.host, 'check host');
  requireThat(typeof host.platform === 'string' && ['linux', 'darwin', 'win32'].includes(host.platform), 'unsupported check host');
  requireThat(!context.platform || host.platform === context.platform, 'check platform differs from required profile');
  requireThat(!context.bun || host.bun === context.bun, 'check Bun version differs from required profile');
  const raw = object(report.selection, 'check selection');
  requireThat(Array.isArray(raw.suites) && raw.suites.length > 0
    && raw.suites.every((id) => suites.some((suite) => suite.id === id)), 'unknown selected suite');
  requireThat(raw.only === null && raw.repeat === 1, 'filtered or repeated check is not release evidence');
  requireThat(raw.flutterLayout === 'combined' || raw.flutterLayout === 'serial-shards', 'unknown Flutter layout');
  let shard: CheckSelection['shard'];
  if (raw.shard !== null) {
    const match = typeof raw.shard === 'string' && /^(\d+)\/(\d+)$/.exec(raw.shard);
    requireThat(match, 'invalid check shard');
    shard = { index: Number(match[1]), total: Number(match[2]) };
    requireThat(shard.index >= 1 && shard.total <= 32 && shard.index <= shard.total, 'invalid check shard bounds');
  }
  const selection: CheckSelection = {
    suites: raw.suites as SuiteId[], repeat: 1, shard, flutterLayout: raw.flutterLayout as FlutterLayout,
  };
  requireThat(typeof raw.complete === 'boolean', 'missing check completeness');
  if (context.complete !== false) {
    requireThat(raw.complete === true && !shard, 'check is partial');
    sameSet(selection.suites, context.requiredSuites ?? hostSuiteIds(host.platform as NodeJS.Platform), 'complete suites');
  } else {
    requireThat(raw.complete === false, 'contributor must declare its partial selection');
  }
  const planned = planChecks(selection, host.platform as NodeJS.Platform, false).tasks;
  requireThat(Array.isArray(report.tasks), 'missing task results');
  const actual = report.tasks.map((value) => object(value, 'task result'));
  sameSet(actual.map((task) => `${task.suite}/${task.id}`), planned.map(taskKey), 'task results');
  const counts = { pass: 0, flaky: 0, fail: 0, blocked: 0 };
  for (const task of actual) {
    const expected = planned.find((item) => taskKey(item) === `${task.suite}/${task.id}`)!;
    requireThat(task.iteration === 1 && JSON.stringify(task.command) === JSON.stringify(expected.task.run), `unexpected command for ${task.suite}/${task.id}`);
    requireThat(task.status === 'pass' || task.status === 'flaky', `unsuccessful task ${task.suite}/${task.id}`);
    requireThat(Array.isArray(task.attempts) && task.attempts.length === (task.status === 'pass' ? 1 : 2), 'invalid task attempts');
    const attempts = task.attempts.map((value) => object(value, 'task attempt'));
    for (const attempt of attempts) {
      requireThat(Number.isInteger(attempt.exitCode) && typeof attempt.durationMs === 'number'
        && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0
        && typeof attempt.timedOut === 'boolean' && typeof attempt.strays === 'boolean'
        && (attempt.leaked === undefined || Array.isArray(attempt.leaked)
          && attempt.leaked.every((entry) => typeof entry === 'string')), 'malformed task attempt');
    }
    const last = attempts.at(-1)!;
    requireThat(last.exitCode === 0 && last.timedOut === false && last.strays === false
      && (!Array.isArray(last.leaked) || last.leaked.length === 0), 'task final attempt did not pass cleanly');
    if (task.status === 'flaky') {
      const first = attempts[0]!;
      requireThat(first.exitCode !== 0 || first.timedOut === true || first.strays === true
        || Array.isArray(first.leaked) && first.leaked.length > 0, 'flaky task has no first failure');
    }
    counts[task.status]++;
  }
  const recordedCounts = object(report.counts, 'check counts');
  for (const key of ['pass', 'flaky', 'fail', 'blocked'] as const) {
    requireThat(recordedCounts[key] === counts[key], 'check counts differ from task results');
  }
  return { report, selection, counts };
}

export function combineChecks(contributors: unknown[], context: EvidenceContext): Record<string, unknown> {
  requireThat(contributors.length > 0, 'no verification contributors');
  const requiredSuites = context.requiredSuites ?? hostSuiteIds('linux', true);
  const expected = planChecks({suites: requiredSuites, repeat: 1, flutterLayout: 'serial-shards'}, 'linux', false)
    .tasks.flatMap(coverageUnits);
  const observed: string[] = [];
  const counts = {pass: 0, flaky: 0, fail: 0, blocked: 0};
  for (const value of contributors) {
    const contributor = object(value, 'verification contributor');
    const meta = object(contributor.provenance, 'contributor provenance');
    requireThat(meta.schemaVersion === 1 && meta.commit === context.commit && meta.profile === 'linux-release'
      && meta.job === 'verify', 'invalid contributor provenance');
    if (context.provenance) {
      for (const key of ['repository', 'workflow', 'runId', 'commit', 'profile', 'bun']) {
        requireThat(meta[key] === context.provenance[key], `contributor ${key} differs from producer`);
      }
      requireThat(Number.isSafeInteger(meta.attempt) && Number(meta.attempt) >= 1
        && Number(meta.attempt) <= Number(context.provenance.attempt), 'invalid producing attempt');
    }
    const check = validateCheck(contributor.report, {...context, platform: 'linux', complete: false});
    observed.push(...planChecks(check.selection, 'linux', false).tasks.flatMap(coverageUnits));
    for (const key of ['pass', 'flaky', 'fail', 'blocked'] as const) counts[key] += check.counts[key];
  }
  sameSet(observed, expected, 'aggregate coverage');
  return {
    schemaVersion: 1, kind: 'repository-check-aggregate', status: 'pass',
    commit: context.commit, dirty: context.dirty ?? false, profile: 'linux-release',
    selection: {suites: requiredSuites, complete: true, shard: null, only: null, repeat: 1},
    counts, contributors, coverage: observed.sort(),
  };
}

export function validateCompleteEvidence(value: unknown, context: EvidenceContext): {counts: ValidatedCheck['counts']} {
  const report = object(value, 'check evidence');
  if (report.kind === 'repository-check') return validateCheck(report, context);
  requireThat(report.schemaVersion === 1 && report.kind === 'repository-check-aggregate'
    && report.status === 'pass' && report.commit === context.commit && report.dirty === (context.dirty ?? false)
    && report.profile === 'linux-release', 'invalid aggregate evidence identity');
  requireThat(Array.isArray(report.contributors), 'missing aggregate contributors');
  const rebuilt = combineChecks(report.contributors, context);
  for (const key of ['selection', 'counts', 'coverage']) {
    requireThat(JSON.stringify(report[key]) === JSON.stringify(rebuilt[key]), `aggregate ${key} differs from contributors`);
  }
  return {counts: rebuilt.counts as ValidatedCheck['counts']};
}
