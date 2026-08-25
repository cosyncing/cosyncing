#!/usr/bin/env bun
/** Aggregate the complete no-cost deterministic broker lane into release evidence. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  loadVerificationGraph,
  verificationEnvironment,
  type BrokerSubSuite,
  type SubSuiteGroup,
} from '../../verification/verification-graph.ts';
import {
  insideSupervisedProcessGroup,
  runSupervised,
} from '../../verification/supervised-process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const MAX_SUITE_TIMEOUT_MS = 300_000;
const SUITE_TIMEOUT_MS_BY_CLASS = {
  short: 30_000,
  medium: 180_000,
  long: 180_000,
} as const;

interface SuiteSpec {
  id: string;
  claim: string;
  command: string[];
}

interface SuiteResult {
  id: string;
  claim: string;
  status: 'pass' | 'fail';
  exitCode: number;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  /** The suite exited but left processes behind, which the lane reaped. */
  strays: boolean;
  summary: string;
  log: string;
  group: string;
  iteration: number;
}

const graph = loadVerificationGraph(ROOT);
const brokerGate = graph.gates.find((gate) => gate.id === 'broker-deterministic');
if (!brokerGate?.subSuites || !brokerGate.subSuiteGroups) {
  throw new Error('verification graph is missing broker sub-suite ownership');
}
const claims = new Map(graph.claims.map((claim) => [claim.id, claim.description]));
const subSuites = new Map<string, BrokerSubSuite>(
  brokerGate.subSuites.map((suite) => [suite.id, suite]),
);
const suiteGroups: SubSuiteGroup[] = brokerGate.subSuiteGroups;

function safeSummary(stdout: string, stderr: string, exitCode: number): string {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = [...lines].reverse().find((line) => /^(?:PASS|FAIL|error:)/i.test(line))
    ?? `${exitCode === 0 ? 'PASS' : 'FAIL'} exit ${exitCode}`;
  return selected
    .replaceAll(ROOT, '<repo>')
    .replace(/(COSYNCING_TOKEN|peerToken|token)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 240);
}

function sourceCommit(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  return result.success ? result.stdout.toString().trim() : 'unknown';
}

function suiteTimeoutOverrideMs(): number | undefined {
  const raw = process.env.COSYNCING_ACCEPTANCE_SUITE_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 30_000 || parsed > MAX_SUITE_TIMEOUT_MS) {
    throw new Error(`COSYNCING_ACCEPTANCE_SUITE_TIMEOUT_MS must be an integer from 30000 to ${MAX_SUITE_TIMEOUT_MS}`);
  }
  return parsed;
}

/**
 * How many audited suites may share the host.
 *
 * Each one spawns a broker and its adapters, so the limit is deliberately well
 * under the core count: oversubscribing turns a timing-sensitive suite into a
 * flaky one, which costs far more than the wall clock it saves.
 */
function laneConcurrency(): number {
  const raw = process.env.COSYNCING_ACCEPTANCE_CONCURRENCY?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
      throw new Error('COSYNCING_ACCEPTANCE_CONCURRENCY must be an integer from 1 to 16');
    }
    return parsed;
  }
  return Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency ?? 4) / 6)));
}

/**
 * Where per-suite durations are remembered between runs.
 *
 * Not the lane report: `check` deletes that before invoking the lane, so the
 * lane can never read its own last one. This file is a scheduling hint and
 * nothing else — it is never evidence, and losing it only costs ordering.
 */
const TIMINGS = resolve(ROOT, 'output/acceptance/suite-timings.json');

function loadDurations(): Map<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(TIMINGS, 'utf8')) as {
      durationMs?: Record<string, unknown>;
    };
    return new Map(
      Object.entries(parsed.durationMs ?? {})
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
  } catch {
    return new Map();
  }
}

/** How much of the new observation a remembered duration takes on. */
const TIMING_SMOOTHING = 0.5;

function saveDurations(previous: Map<string, number>, results: SuiteResult[]): void {
  const merged = new Map(previous);
  for (const result of results) {
    // Only healthy runs describe how long a suite takes. Keeping the maximum
    // meant one 180s timeout pinned that suite to the front of the queue
    // forever, and a run that timed out or leaked is measuring the failure,
    // not the work. Smoothing lets a genuinely slower suite move up over a few
    // runs without a single bad one deciding the order.
    if (result.status !== 'pass' || result.timedOut || result.strays) continue;
    const seen = merged.get(result.id);
    merged.set(
      result.id,
      seen === undefined
        ? result.durationMs
        : Math.round(seen + TIMING_SMOOTHING * (result.durationMs - seen)),
    );
  }
  try {
    mkdirSync(dirname(TIMINGS), { recursive: true });
    writeFileSync(
      TIMINGS,
      `${JSON.stringify({ durationMs: Object.fromEntries([...merged].sort()) }, null, 2)}\n`,
    );
  } catch {
    // A hint that cannot be written is not a reason to fail a verification run.
  }
}

/**
 * Longest-processing-time-first, the standard greedy list schedule.
 *
 * A suite with no recorded time is assumed to be the longest known one, so a
 * newly added suite starts early rather than becoming the tail nobody overlaps.
 */
function longestFirst(ids: string[], durations: Map<string, number>): string[] {
  const known = [...durations.values()];
  const optimistic = known.length > 0 ? Math.max(...known) : 0;
  return [...ids].sort((left, right) =>
    (durations.get(right) ?? optimistic) - (durations.get(left) ?? optimistic)
  );
}

function parseOutputArgs(
  argv: string[],
): {
  json: string;
  audit: string;
  logs: string;
  only?: Set<string>;
  repeat: number;
} {
  let json = resolve(ROOT, 'output/acceptance/deterministic-broker.json');
  let audit = resolve(ROOT, 'output/acceptance/deterministic-broker.md');
  let logs = resolve(ROOT, 'output/acceptance/deterministic-broker-logs');
  let only: Set<string> | undefined;
  let repeat = 1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--json' && value) { json = resolve(value); index += 1; }
    else if (arg === '--audit' && value) { audit = resolve(value); index += 1; }
    else if (arg === '--logs' && value) { logs = resolve(value); index += 1; }
    else if (arg === '--only' && value) {
      only = new Set(value.split(',').filter(Boolean));
      index += 1;
    } else if (arg === '--repeat' && value && /^[1-3]$/.test(value)) {
      repeat = Number(value);
      index += 1;
    }
    else {
      console.error(
        'Usage: bun run test:broker:deterministic '
        + '[--json PATH] [--audit PATH] [--logs DIR] '
        + '[--only ID[,ID...]] [--repeat 1|2|3]',
      );
      process.exit(2);
    }
  }
  if (only) {
    const unknown = [...only].filter((id) => !subSuites.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown broker suite(s): ${unknown.join(', ')}`);
    }
  }
  return { json, audit, logs, only, repeat };
}

const output = parseOutputArgs(process.argv.slice(2));
const previousDurations = loadDurations();
const timeoutOverrideMs = suiteTimeoutOverrideMs();
const results: SuiteResult[] = [];
const childEnvironment = {
  ...verificationEnvironment(),
  COSYNCING_ACCEPTANCE_LANE: 'deterministic-broker',
};
mkdirSync(output.logs, { recursive: true });
for (let iteration = 1; iteration <= output.repeat; iteration += 1) {
  for (const group of suiteGroups) {
    const selected = group.subSuites.filter(
      (id) => !output.only || output.only.has(id),
    );
    if (selected.length === 0) continue;
    console.log(
      `GROUP ${group.id} — ${group.mode}, ${group.resourceClass}, `
        + `iteration ${iteration}/${output.repeat}`,
    );
    const runSuite = async (id: string): Promise<SuiteResult> => {
      const definition = subSuites.get(id)!;
      const suite: SuiteSpec = {
        id,
        claim: claims.get(definition.claimId) ?? definition.claimId,
        command: definition.command,
      };
      const timeoutClass = definition.timeoutClass
        ?? (group.resourceClass === 'heavyweight' ? 'long' : 'medium');
      const timeoutMs = timeoutOverrideMs ?? SUITE_TIMEOUT_MS_BY_CLASS[timeoutClass];
      const child = await runSupervised(suite.command, {
        cwd: ROOT,
        env: childEnvironment,
        timeoutMs,
        maxBufferBytes: 16 << 20,
        isolateProcessGroup: !insideSupervisedProcessGroup(),
      });
      const { stdout, stderr, exitCode, timedOut, strays } = child;
      const suffix = output.repeat === 1 ? '' : `-run-${iteration}`;
      const logPath = join(output.logs, `${suite.id}${suffix}.log`);
      writeFileSync(
        logPath,
        [
          `$ ${suite.command.join(' ')}`,
          `cwd: ${ROOT}`,
          `group: ${group.id} (${group.mode}, ${group.resourceClass})`,
          `timeout: ${timeoutMs}ms (${timeoutClass})`,
          `iteration: ${iteration}/${output.repeat}`,
          ...(strays
            ? ['strays: the suite left processes behind; the lane reaped them']
            : []),
          '',
          '--- stdout ---',
          stdout,
          '',
          '--- stderr ---',
          stderr,
        ].join('\n'),
      );
      return {
        id: suite.id,
        claim: suite.claim,
        // A suite that leaves processes behind has not passed.
        //
        // Recording the stray and still calling the suite green turned the
        // lane's own backstop into cover: the leak appeared in the report and
        // in the log, and the exit code said everything was fine. A leaked
        // child of a finished suite still holds whatever it held — a port, a
        // socket, a state directory — and the suite that fails for it is some
        // later one, for no visible reason.
        status: child.success && !timedOut && !strays ? 'pass' : 'fail',
        exitCode,
        durationMs: child.durationMs,
        timeoutMs,
        timedOut,
        strays,
        summary: timedOut
          ? `FAIL timed out after ${timeoutMs}ms`
          : strays && child.success
            ? 'FAIL exited leaving processes behind; the lane reaped them'
            : safeSummary(stdout, stderr, exitCode),
        log: relative(dirname(output.audit), logPath),
        group: group.id,
        iteration,
      };
    };

    const report = (result: SuiteResult) => {
      results.push(result);
      console.log(
        `${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.id} — `
          + result.summary,
      );
      // The lane reaps leaks, but a suite that needs reaping is a suite that
      // does not shut its own children down, and that now fails for it.
      if (result.strays) {
        console.log('      ^ left processes behind; the lane reaped them');
      }
    };

    if (group.mode === 'parallel') {
      // Only suites the isolation audit cleared reach this path; everything
      // else stays in a serial group. Results are collected in declared order
      // so a parallel lane still reports identically to a serial one.
      //
      // Longest-first: declared order put the 28s suite near the end, where it
      // ran alone after the pool had drained, so the group cost far more than
      // its longest member. Timings are a hint only — a stale or missing one
      // changes what runs when, never what runs or how it is judged.
      const pending = longestFirst(selected, previousDurations);
      const collected = new Map<string, SuiteResult>();
      const workers = Array.from(
        { length: Math.min(laneConcurrency(), pending.length) },
        async () => {
          for (let id = pending.shift(); id; id = pending.shift()) {
            collected.set(id, await runSuite(id));
          }
        },
      );
      await Promise.all(workers);
      for (const id of selected) report(collected.get(id)!);
      continue;
    }
    for (const id of selected) report(await runSuite(id));
  }
}

saveDurations(previousDurations, results);
const failed = results.filter((result) => result.status === 'fail');
const report = {
  schemaVersion: 1,
  lane: 'deterministic-broker',
  effects: 'isolated-fixtures-and-loopback-only',
  modelCalls: 0,
  sourceCommit: sourceCommit(),
  generatedAt: new Date().toISOString(),
  suiteTimeoutPolicy: timeoutOverrideMs === undefined
    ? SUITE_TIMEOUT_MS_BY_CLASS
    : { override: timeoutOverrideMs },
  repeat: output.repeat,
  executionGroups: suiteGroups.map((group) => ({
    id: group.id,
    mode: group.mode,
    resourceClass: group.resourceClass,
    suites: group.subSuites,
  })),
  status: failed.length === 0 ? 'pass' : 'fail',
  summary: {
    pass: results.length - failed.length,
    fail: failed.length,
    strays: results.filter((result) => result.strays).length,
    total: results.length,
  },
  suites: results,
};
mkdirSync(dirname(output.json), { recursive: true });
mkdirSync(dirname(output.audit), { recursive: true });
writeFileSync(output.json, `${JSON.stringify(report, null, 2)}\n`);
const audit = `# Deterministic broker acceptance audit\n\n` +
  `- Status: **${report.status.toUpperCase()}**\n` +
  `- Source commit: \`${report.sourceCommit}\`\n` +
  `- Generated: ${report.generatedAt}\n` +
  `- Effects: isolated fixtures and loopback only\n` +
  `- Model calls: 0\n\n` +
  `- Per-suite timeout policy: ${
    timeoutOverrideMs === undefined
      ? Object.entries(SUITE_TIMEOUT_MS_BY_CLASS).map(([key, value]) => `${key}=${value}ms`).join(', ')
      : `override=${timeoutOverrideMs}ms`
  }\n` +
  `- Repetitions: ${output.repeat}\n` +
  `- Heavyweight suites run only in an explicit serial group.\n\n` +
  `| Suite | Status | Claim | Evidence |\n|---|---|---|---|\n` +
  results.map((result) =>
    `| \`${result.id}\` | ${result.status} | ${result.claim} | [full log](${
      result.log
    }) — ${result.summary.replaceAll('|', '\\|')} |`).join('\n') +
  `\n\nA deterministic pass does not satisfy any real-host, reboot, published-channel, or real-client gate.\n`;
writeFileSync(output.audit, audit);
console.log(
  `${report.status.toUpperCase()} ${report.summary.pass}/${report.summary.total}`
  + (report.summary.strays > 0
    ? `; suites leaking processes=${report.summary.strays}`
    : '')
  + `; JSON=${output.json}; audit=${output.audit}`,
);
if (failed.length > 0) process.exit(1);
