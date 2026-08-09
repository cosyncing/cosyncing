#!/usr/bin/env bun
/**
 * One-shot, round-agnostic repository evaluation.
 *
 * This is the default gate after any implementation:
 *
 *   bun run check
 *
 * It mirrors the deterministic parts of CI that can run on the current host,
 * continues after failures, and writes complete logs plus JSON/Markdown
 * summaries under output/check/. Release publication, runtime replacement,
 * cross-platform builds, and physical evidence remain separate gates.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import {
  gatesForProfile,
  loadVerificationGraph,
  sourceFingerprint,
  verificationEnvironment,
  validateVerificationGraph,
  type SourceFingerprint,
  type VerificationGate,
} from './verification/verification-graph.ts';
import { runSupervised } from './verification/supervised-process.ts';
import {
  gateOutcome,
  type BaselineOutcome,
} from './verification/gate-outcome.ts';
import { gatesForChangedPaths } from './verification/changed-gates.ts';
import {
  allowsBrowserBrokerOverlap,
  fillSchedulingBatch,
  strayGraceMsFor,
} from './verification/check-scheduler-policy.ts';

const checkStartedAt = new Date();
const checkStartedPerformance = performance.now();

const ROOT = resolve(import.meta.dir, '..');
const OUTPUT = join(ROOT, 'output', 'check');
const LOGS = join(OUTPUT, 'logs');
const BROKER_REPORT = join(OUTPUT, 'broker', 'report.json');
const BROKER_AUDIT = join(OUTPUT, 'broker', 'report.md');
const BROKER_LOGS = join(LOGS, 'broker');
const ADVISORY_BASELINES = join(
  ROOT,
  'scripts',
  'check-advisory-baselines.json',
);
/**
 * What each declared `timeoutClass` is actually worth, in milliseconds.
 *
 * Every gate used to get a flat 30 minutes, so one wedged `short` gate — the
 * kind that normally finishes in under a second — cost half an hour before the
 * run could even report it. The graph has always declared a class per gate;
 * nothing read it.
 *
 * The numbers are observed-worst-case with a wide margin, not aspirations.
 * `cumulative` is deliberately *below* `long`: cumulative gates aggregate
 * suites that each carry their own inner timeout, so this outer bound only has
 * to catch an aggregate that is wedged as a whole, whereas `long` covers a
 * single monolithic build-and-verify with no inner bound of its own.
 */
const TIMEOUT_MS_BY_CLASS: Record<VerificationGate['timeoutClass'], number> = {
  short: 2 * 60_000,
  medium: 15 * 60_000,
  cumulative: 20 * 60_000,
  long: 30 * 60_000,
};
/** Slow or loaded hosts can widen every bound without editing the policy. */
const TIMEOUT_SCALE = (() => {
  const raw = process.env.COSYNCING_CHECK_TIMEOUT_SCALE?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
    console.error(
      'FAIL check-initialization: COSYNCING_CHECK_TIMEOUT_SCALE must be a number from 1 to 10',
    );
    process.exit(1);
  }
  return parsed;
})();

function gateTimeoutMs(gate: VerificationGate): number {
  return Math.round(TIMEOUT_MS_BY_CLASS[gate.timeoutClass] * TIMEOUT_SCALE);
}

const MAX_BUFFER_BYTES = 64 << 20;

type Requirement = 'required' | 'advisory';

interface BaselineComparison {
  status: 'match' | 'changed';
  expectedCount: number;
  actualCount: number;
  added: string[];
  removed: string[];
}

interface SubResult {
  id: string;
  status: 'pass' | 'fail';
  summary: string;
  log: string;
}

interface Result {
  id: string;
  claim: string;
  command: string[];
  requirement: Requirement;
  status: 'pass' | 'fail';
  exitCode: number;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  /** The gate exited but left processes behind, which the runner reaped. */
  strays: boolean;
  summary: string;
  log: string;
  baseline?: BaselineComparison;
  subResults?: SubResult[];
}

const graph = loadVerificationGraph(ROOT);
const graphErrors = validateVerificationGraph(graph, ROOT);
if (graphErrors.length > 0) {
  for (const error of graphErrors) console.error(`FAIL verification-graph: ${error}`);
  process.exit(1);
}
const claims = new Map(graph.claims.map((claim) => [claim.id, claim.description]));
const allSuites = gatesForProfile(graph, 'check').filter(
  (gate) => gate.id !== 'source-stability',
);

function gateClaim(gate: VerificationGate): string {
  return gate.claimIds.map((id) => claims.get(id) ?? id).join(' ');
}

function usage(): never {
  console.log(
    'Usage: bun run check [--changed [BASE]]\n\n'
      + 'Runs the round-agnostic deterministic current-host repository gate.\n'
      + '--changed runs only safely attributable gates since BASE (default: origin/main).\n'
      + 'Changed-only reports are not valid release-checkpoint evidence.\n'
      + 'Reports are written to output/check/.',
  );
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) usage();
if (argv.length > 2 || (argv.length > 0 && argv[0] !== '--changed')) {
  console.error('Usage: bun run check [--changed [BASE]]');
  process.exit(2);
}
const checkMode: 'complete' | 'changed' = argv[0] === '--changed' ? 'changed' : 'complete';

function gitText(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (!result.success) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function changedPathsSince(requestedBase?: string): { base: string; paths: string[] } {
  const candidates = requestedBase ? [requestedBase] : ['origin/main', 'main'];
  const base = candidates.find((candidate) =>
    Bun.spawnSync(['git', 'rev-parse', '--verify', `${candidate}^{commit}`], {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
    }).success
  );
  if (!base) throw new Error(`no changed-check base resolves (${candidates.join(', ')})`);
  const mergeBase = gitText(['merge-base', 'HEAD', base]).trim();
  const split = (value: string): string[] => value.split('\0').filter(Boolean);
  const paths = new Set([
    ...split(gitText(['diff', '--name-only', '-z', mergeBase, 'HEAD', '--'])),
    ...split(gitText(['diff', '--name-only', '-z', 'HEAD', '--'])),
    ...split(gitText(['ls-files', '-z', '--others', '--exclude-standard'])),
  ]);
  return { base: `${base}@${mergeBase}`, paths: [...paths].sort() };
}

let changedCoverage: { base: string; paths: string[] } | null = null;
let suites = allSuites;
if (checkMode === 'changed') {
  try {
    changedCoverage = changedPathsSince(argv[1]);
    const selected = gatesForChangedPaths(changedCoverage.paths);
    if (selected === null) {
      console.log('changed-gate attribution is incomplete; running the complete check');
    } else {
      // Pull in every upstream dependency required by a selected gate.
      const byId = new Map(allSuites.map((suite) => [suite.id, suite]));
      const include = (id: string): void => {
        if (selected.has(id)) {
          for (const dependency of byId.get(id)?.dependencies ?? []) include(dependency);
          return;
        }
        selected.add(id);
        for (const dependency of byId.get(id)?.dependencies ?? []) include(dependency);
      };
      for (const id of [...selected]) include(id);
      suites = allSuites.filter((suite) => selected.has(suite.id));
      console.log(
        `changed check from ${changedCoverage.base}: ${changedCoverage.paths.length} path(s), `
          + `${suites.length}/${allSuites.length} gate(s)`,
      );
    }
  } catch (error) {
    console.error(`FAIL changed-check-initialization: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function safeSummary(
  stdout: string,
  stderr: string,
  exitCode: number,
): string {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = [...lines].reverse().find(
    (line) => /^(?:PASS|FAIL|error:|All tests passed|No issues found)/i.test(line),
  ) ?? `${exitCode === 0 ? 'PASS' : 'FAIL'} exit ${exitCode}`;
  return selected.replaceAll(ROOT, '<repo>').slice(0, 300);
}

function policyFindings(stdout: string, stderr: string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll(ROOT, '<repo>'))
    .filter((line) => line.startsWith('FAIL:'))
    .sort();
}

function findingFingerprint(finding: string): string {
  return `sha256:${
    createHash('sha256').update(finding).digest('hex')
  }`;
}

function multisetDifference(left: string[], right: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of right) {
    remaining.set(item, (remaining.get(item) ?? 0) + 1);
  }
  const difference: string[] = [];
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count === 0) difference.push(item);
    else remaining.set(item, count - 1);
  }
  return difference;
}

function loadAdvisoryBaselines(): Record<string, string[]> {
  const parsed = JSON.parse(readFileSync(ADVISORY_BASELINES, 'utf8')) as {
    schemaVersion?: unknown;
    suites?: unknown;
  };
  if (parsed.schemaVersion !== 1
      || !parsed.suites || typeof parsed.suites !== 'object') {
    throw new Error('invalid advisory policy baseline');
  }
  const baselines: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(parsed.suites)) {
    if (!Array.isArray(value)
        || value.some((finding) =>
          typeof finding !== 'string'
          || !/^sha256:[a-f0-9]{64}$/.test(finding)
        )) {
      throw new Error(`invalid advisory policy baseline for ${id}`);
    }
    baselines[id] = [...value].sort();
  }
  return baselines;
}

function readBrokerSubResults(): SubResult[] {
  if (!existsSync(BROKER_REPORT)) return [];
  const parsed = JSON.parse(readFileSync(BROKER_REPORT, 'utf8')) as {
    suites?: Array<{
      id?: unknown;
      status?: unknown;
      summary?: unknown;
      log?: unknown;
    }>;
  };
  if (!Array.isArray(parsed.suites)) return [];
  return parsed.suites.flatMap((suite) => {
    if (typeof suite.id !== 'string'
        || (suite.status !== 'pass' && suite.status !== 'fail')
        || typeof suite.summary !== 'string'
        || typeof suite.log !== 'string') {
      return [];
    }
    const absoluteLog = resolve(dirname(BROKER_AUDIT), suite.log);
    return [{
      id: suite.id,
      status: suite.status,
      summary: suite.summary,
      log: relative(OUTPUT, absoluteLog),
    }];
  });
}

let sourceBefore: SourceFingerprint;
let advisoryBaselines: Record<string, string[]>;
try {
  sourceBefore = sourceFingerprint(ROOT);
  advisoryBaselines = loadAdvisoryBaselines();
} catch (error) {
  console.error(
    `FAIL source-check-initialization: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

mkdirSync(LOGS, { recursive: true });
const results: Result[] = [];
const childEnvironment = verificationEnvironment();

async function runGate(suite: VerificationGate): Promise<Result> {
  const declaredRequirement = suite.requirement ?? 'required';
  if (suite.id === 'broker-deterministic') {
    rmSync(BROKER_REPORT, { force: true });
    rmSync(BROKER_AUDIT, { force: true });
    rmSync(BROKER_LOGS, { recursive: true, force: true });
  }
  const timeoutMs = gateTimeoutMs(suite);
  const child = await runSupervised(suite.command, {
    cwd: suite.cwd ? resolve(ROOT, suite.cwd) : ROOT,
    env: childEnvironment,
    timeoutMs,
    strayGraceMs: strayGraceMsFor(suite.command),
    maxBufferBytes: MAX_BUFFER_BYTES,
  });
  const { stdout, stderr, exitCode, timedOut, strays } = child;
  let baseline: BaselineComparison | undefined;
  let baselineOutcome: BaselineOutcome | undefined;
  if (suite.advisoryBaseline) {
    const expected = advisoryBaselines[suite.advisoryBaseline];
    if (!expected) {
      throw new Error(
        `missing advisory policy baseline ${suite.advisoryBaseline}`,
      );
    }
    const actual = policyFindings(stdout, stderr)
      .map(findingFingerprint)
      .sort();
    const added = multisetDifference(actual, expected);
    const removed = multisetDifference(expected, actual);
    // A baseline only "matches" if the gate failed in the known way. A gate
    // that passed, or timed out, has not reproduced its recorded findings.
    const matches = added.length === 0 && removed.length === 0
      && !child.success && !timedOut;
    baseline = {
      status: matches ? 'match' : 'changed',
      expectedCount: expected.length,
      actualCount: actual.length,
      added,
      removed,
    };
    baselineOutcome = {
      matches,
      added: added.length,
      removed: removed.length,
      expectedCount: expected.length,
      actualCount: actual.length,
    };
  }
  const logName = `${suite.id}.log`;
  writeFileSync(
    join(LOGS, logName),
    [
      `$ ${suite.command.join(' ')}`,
      `cwd: ${suite.cwd ? resolve(ROOT, suite.cwd) : ROOT}`,
      `timeout: ${timeoutMs}ms (${suite.timeoutClass})`,
      ...(strays
        ? ['strays: the gate left processes behind; the runner reaped them']
        : []),
      ...(child.truncated ? [`output truncated at ${MAX_BUFFER_BYTES} bytes`] : []),
      '',
      stdout,
      stderr,
      ...(baseline ? [
        '',
        '--- advisory baseline ---',
        JSON.stringify(baseline, null, 2),
      ] : []),
    ].join('\n'),
  );
  const missingArtifacts = suite.expectedArtifacts
    .map((artifact) => artifact.path)
    .filter((path) => !existsSync(resolve(ROOT, path)));
  const { requirement, status, summary } = gateOutcome({
    declaredRequirement,
    success: child.success,
    timedOut,
    strays,
    timeoutMs,
    timeoutClass: suite.timeoutClass,
    observedSummary: safeSummary(stdout, stderr, exitCode),
    baseline: baselineOutcome,
    missingArtifacts,
  });
  return {
    id: suite.id,
    claim: gateClaim(suite),
    command: suite.command,
    requirement,
    status,
    exitCode,
    durationMs: child.durationMs,
    timeoutMs,
    timedOut,
    strays,
    summary,
    log: `logs/${logName}`,
    ...(baseline ? { baseline } : {}),
    ...(suite.id === 'broker-deterministic'
      ? { subResults: readBrokerSubResults() }
      : {}),
  };
}

/**
 * Run the gates concurrently without letting two of them invalidate each other.
 *
 * The order `gatesForProfile` returns is a valid serial order, and running it
 * as one took the whole wall clock even though most gates are independent and
 * the host sat ~90% idle. What may overlap is read from the inventory, never
 * inferred:
 *
 * - declared dependencies, so a consumer never starts before its producer;
 * - a group's `mode`, so gates in a serial group never overlap each other;
 * - `resourceClass: heavyweight`, which means the gate needs the host to
 *   itself. `client` and `broker-deterministic` are both heavyweight because
 *   the broker suites wait a fixed number of seconds for a broker to report
 *   healthy — merely running the browser gate alongside was enough to produce
 *   "broker did not start".
 *
 * `timeoutClass` deliberately plays no part here: it bounds how long a gate may
 * take, which is a different question from what it may share the host with.
 *
 * A gate whose dependency failed is reported blocked rather than run. It used
 * to run anyway: when `client` failed before building the web release,
 * `web-browser` still "passed" — against the previous run's stale build.
 */
function checkConcurrency(): number {
  const raw = process.env.COSYNCING_CHECK_CONCURRENCY?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
      console.error(
        'FAIL check-initialization: COSYNCING_CHECK_CONCURRENCY must be an integer from 1 to 16',
      );
      process.exit(1);
    }
    return parsed;
  }
  return Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency ?? 4) / 6)));
}

const scheduled = new Set(suites.map((suite) => suite.id));
const completed = new Map<string, Result>();
const started = new Set<string>();
const concurrency = checkConcurrency();
/** Which execution group owns each gate, and whether that group is serial. */
const groupOfGate = new Map<string, { id: string; serial: boolean }>();
for (const group of graph.executionGroups) {
  for (const gateId of group.gates) {
    groupOfGate.set(gateId, { id: group.id, serial: group.mode === 'serial' });
  }
}
const busySerialGroups = new Set<string>();
let exclusiveBusy = false;

function blockedBy(suite: VerificationGate): string[] {
  return suite.dependencies
    .filter((id) => scheduled.has(id))
    .filter((id) => completed.get(id)?.status === 'fail');
}

/** Dependencies satisfied — whether or not the host is free to take it. */
function unblocked(suite: VerificationGate): boolean {
  if (started.has(suite.id)) return false;
  return suite.dependencies
    .filter((id) => scheduled.has(id))
    .every((id) => completed.has(id));
}

/**
 * How many gates deep the dependency chain behind this one runs.
 *
 * A tie-break between exclusive gates, and only that. `client` and
 * `broker-deterministic` cost about the same; `web-browser`, `web-cache` and
 * `web-update-handoff` wait on `client` while nothing waits on the broker lane,
 * so unblocking `client` first releases work sooner.
 *
 * It does not make the full client and broker gates overlap. The separately
 * bounded browser/broker exception below starts only after client completes.
 * This counts gates, not their expected duration, so it says which chain is
 * longer and nothing about which is slower.
 */
const downstreamDepth = new Map<string, number>();
function depthOf(id: string): number {
  const cached = downstreamDepth.get(id);
  if (cached !== undefined) return cached;
  downstreamDepth.set(id, 0); // cycles are rejected by the graph validator
  const depth = 1 + Math.max(
    0,
    ...suites
      .filter((gate) => gate.dependencies.includes(id))
      .map((gate) => depthOf(gate.id)),
  );
  downstreamDepth.set(id, depth);
  return depth;
}

/**
 * Heavyweight gates own the host. The browser gate also starts and restarts
 * fixture brokers, so the policy seam currently admits no browser/broker
 * exception; see check-scheduler-policy.ts.
 */
function ready(suite: VerificationGate): boolean {
  if (!unblocked(suite)) return false;
  if (blockedBy(suite).length > 0) return true;
  // An exclusive gate takes the host in both directions: it waits for an empty
  // host, and nothing else starts while it holds one.
  if (suite.resourceClass === 'heavyweight') {
    return running.size === 0
      || allowsBrowserBrokerOverlap(suite.id, runningGateIds, concurrency);
  }
  if (exclusiveBusy
      && !allowsBrowserBrokerOverlap(suite.id, runningGateIds, concurrency)) {
    return false;
  }
  // Do not start cheap work in front of an exclusive gate that is only waiting
  // for the host to empty. Launching it would extend the drain it is waiting
  // on, so the gate that everything else depends on starts later for no gain.
  if (suites.some((gate) =>
    gate.resourceClass === 'heavyweight' && unblocked(gate)
      && blockedBy(gate).length === 0
  )) {
    return false;
  }
  const group = groupOfGate.get(suite.id);
  if (group?.serial && busySerialGroups.has(group.id)) return false;
  return true;
}

function announce(result: Result): void {
  const marker = result.status === 'pass'
    ? 'PASS'
    : result.requirement === 'advisory'
    ? 'WARN'
    : 'FAIL';
  console.log(`${marker}  ${result.id} — ${result.summary}`);
  // Reaping a leak silently is how the leaks lasted: a passing gate that
  // orphaned a browser looked identical to one that cleaned up after itself.
  if (result.strays) {
    console.log(`      ^ left processes behind; the runner reaped them`);
  }
}

const running = new Set<Promise<void>>();
const runningGateIds = new Set<string>();
// Declared order decides between equals; an exclusive gate with more work
// waiting on it goes first, so the host it empties is put to use soonest.
const launchOrder = suites
  .map((suite, index) => ({ suite, index }))
  .sort((left, right) =>
    depthOf(right.suite.id) - depthOf(left.suite.id) || left.index - right.index
  )
  .map((entry) => entry.suite);

while (completed.size < suites.length) {
  const launched = fillSchedulingBatch(
    launchOrder,
    () => running.size < concurrency,
    ready,
    (suite) => {
      started.add(suite.id);
      const blocked = blockedBy(suite);
      if (blocked.length > 0) {
        const result: Result = {
          id: suite.id,
          claim: gateClaim(suite),
          command: suite.command,
          requirement: suite.requirement ?? 'required',
          status: 'fail',
          exitCode: 1,
          durationMs: 0,
          timeoutMs: 0,
          timedOut: false,
          strays: false,
          summary: `FAIL blocked by failed dependency: ${blocked.join(', ')}`,
          log: `logs/${suite.id}.log`,
        };
        writeFileSync(
          join(LOGS, `${suite.id}.log`),
          `not run: dependency ${blocked.join(', ')} failed\n`,
        );
        completed.set(suite.id, result);
        announce(result);
        return;
      }
      const group = groupOfGate.get(suite.id);
      if (suite.resourceClass === 'heavyweight') exclusiveBusy = true;
      if (group?.serial) busySerialGroups.add(group.id);
      runningGateIds.add(suite.id);
      const task = (async () => {
        const result = await runGate(suite);
        if (suite.resourceClass === 'heavyweight') exclusiveBusy = false;
        if (group?.serial) busySerialGroups.delete(group.id);
        completed.set(suite.id, result);
        announce(result);
      })().finally(() => {
        running.delete(task);
        runningGateIds.delete(suite.id);
      });
      running.add(task);
    },
  );
  if (running.size > 0) await Promise.race(running);
  else if (launched.length === 0) {
    throw new Error('check scheduler stalled with gates still pending');
  }
}
// Report in the inventory's own order, not the order they happened to finish.
for (const suite of suites) results.push(completed.get(suite.id)!);

let sourceAfter: SourceFingerprint | undefined;
let sourceFingerprintError: string | undefined;
try {
  sourceAfter = sourceFingerprint(ROOT);
} catch (error) {
  sourceFingerprintError = error instanceof Error ? error.message : String(error);
}
const sourceStable = sourceAfter !== undefined
  && sourceAfter.sha256 === sourceBefore.sha256;
const sourceLogName = 'source-stability.log';
writeFileSync(
  join(LOGS, sourceLogName),
  [
    'Complete repository source fingerprint before and after all suites.',
    '',
    `before: ${JSON.stringify(sourceBefore, null, 2)}`,
    `after: ${JSON.stringify(sourceAfter ?? null, null, 2)}`,
    ...(sourceFingerprintError
      ? ['', `fingerprint error: ${sourceFingerprintError}`]
      : []),
  ].join('\n'),
);
const sourceResult: Result = {
  id: 'source-stability',
  claim: claims.get('repository.source-stability')
    ?? 'All suite results describe one unchanged source state.',
  command: ['internal:source-fingerprint'],
  requirement: 'required',
  status: sourceStable ? 'pass' : 'fail',
  exitCode: sourceStable ? 0 : 1,
  durationMs: 0,
  timeoutMs: 0,
  timedOut: false,
  strays: false,
  summary: sourceStable
    ? `PASS ${sourceBefore.sha256}`
    : sourceFingerprintError
    ? `FAIL source fingerprint could not be captured: ${sourceFingerprintError}`
    : `FAIL source changed from ${sourceBefore.sha256} to ${
      sourceAfter!.sha256
    }`,
  log: `logs/${sourceLogName}`,
};
results.push(sourceResult);
console.log(
  `${sourceStable ? 'PASS' : 'FAIL'}  ${sourceResult.id} — ${
    sourceResult.summary
  }`,
);

const requiredFailures = results.filter(
  (result) => result.requirement === 'required' && result.status === 'fail',
);
const advisoryFailures = results.filter(
  (result) => result.requirement === 'advisory' && result.status === 'fail',
);
const checkDurationMs = Math.round(performance.now() - checkStartedPerformance);
const report = {
  schemaVersion: 5,
  kind: 'repository-check',
  verificationInventory: 'scripts/verification/verification-graph.json',
  verificationInventoryId: graph.inventoryId,
  scope: checkMode === 'complete'
    ? 'round-agnostic deterministic current-host evaluation'
    : 'opt-in changed-gate current-host evaluation',
  coverage: {
    mode: checkMode,
    base: changedCoverage?.base ?? null,
    changedPaths: changedCoverage?.paths ?? [],
    selectedGates: suites.map((suite) => suite.id),
    complete: suites.length === allSuites.length,
  },
  sourceCommit: sourceBefore.commit,
  sourceDirty: sourceBefore.dirty,
  source: {
    before: sourceBefore,
    after: sourceAfter ?? null,
    stable: sourceStable,
    error: sourceFingerprintError ?? null,
  },
  startedAt: checkStartedAt.toISOString(),
  generatedAt: new Date().toISOString(),
  durationMs: checkDurationMs,
  status: requiredFailures.length === 0 ? 'pass' : 'fail',
  summary: {
    pass: results.filter((result) => result.status === 'pass').length,
    requiredFail: requiredFailures.length,
    advisoryFail: advisoryFailures.length,
    strayGates: results.filter((result) => result.strays).length,
    total: results.length,
  },
  exclusions: graph.profiles.check.exclusions.map((id) => {
    const exclusion = graph.exclusions.find((item) => item.id === id)!;
    return `${id}: ${exclusion.description}`;
  }),
  results,
};
writeFileSync(
  join(OUTPUT, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
const markdown = [
  '# Repository check',
  '',
  `- Status: **${report.status.toUpperCase()}**`,
  `- Source commit: \`${report.sourceCommit}\``,
  `- Dirty source: ${report.sourceDirty}`,
  `- Source fingerprint: \`${report.source.before.sha256}\``,
  `- Source stable for entire run: ${report.source.stable}`,
  `- Coverage: ${report.coverage.mode}${report.coverage.complete ? ' (complete)' : ' (partial)'}`,
  ...(report.coverage.base ? [`- Changed base: \`${report.coverage.base}\``] : []),
  `- Started: ${report.startedAt}`,
  `- Generated: ${report.generatedAt}`,
  `- Wall-clock duration: ${report.durationMs}ms`,
  `- Required failures: ${report.summary.requiredFail}`,
  `- Advisory failures: ${report.summary.advisoryFail}`,
  `- Gates that leaked processes: ${report.summary.strayGates}`,
  '',
  '| Suite | Requirement | Status | Claim | Evidence |',
  '|---|---|---|---|---|',
  ...results.map((result) =>
    `| \`${result.id}\` | ${result.requirement} | ${result.status} | ${
      result.claim.replaceAll('|', '\\|')
    } | [log](${result.log}) — ${
      result.summary.replaceAll('|', '\\|')
    }${
      result.subResults?.length ? ' — [sub-suite logs](#broker-sub-suite-logs)' : ''
    } |`
  ),
  ...(results.find((result) => result.id === 'broker-deterministic')?.subResults?.length
    ? [
      '',
      '## Broker sub-suite logs',
      '',
      '| Suite | Status | Evidence |',
      '|---|---|---|',
      ...results
        .find((result) => result.id === 'broker-deterministic')!
        .subResults!
        .map((result) =>
          `| \`${result.id}\` | ${result.status} | [full log](${
            result.log
          }) — ${result.summary.replaceAll('|', '\\|')} |`
        ),
    ]
    : []),
  '',
  '## Exclusions',
  '',
  ...report.exclusions.map((item) => `- ${item}`),
  '',
].join('\n');
writeFileSync(join(OUTPUT, 'report.md'), markdown);

console.log(
  `${report.status.toUpperCase()} ${
    report.summary.pass
  }/${report.summary.total}; required failures=${
    report.summary.requiredFail
  }; advisory failures=${report.summary.advisoryFail}${
    report.summary.strayGates > 0
      ? `; gates leaking processes=${report.summary.strayGates}`
      : ''
  }`,
);
console.log(`Report: ${join(OUTPUT, 'report.md')}`);
if (requiredFailures.length > 0) process.exit(1);
