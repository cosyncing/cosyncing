#!/usr/bin/env bun
/**
 * Phase 7 — run the CI lane itself on a staged native Windows tree.
 *
 * The survey measures suites one at a time. This runs what CI will actually run, in one process,
 * against the staged candidate: a lane that is green suite-by-suite can still fail as a lane, and a
 * required job is not worth adding on the strength of a measurement taken a different way.
 */
import { win32 } from 'node:path';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 7 lane probe requires ${name}`);
  return value;
}

const candidateRoot = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_CANDIDATE_ROOT');
const laneBun = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_BUN');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') throw new Error('Phase 7 lane probe requires its native Windows runner');
if (!win32.isAbsolute(candidateRoot) || candidateRoot.startsWith('\\\\')) {
  throw new Error('Phase 7 lane probe requires a local-disk candidate root');
}

const startedAt = Date.now();
const proc = Bun.spawn([laneBun, 'run', 'verification:windows-broker'], {
  cwd: candidateRoot,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  windowsHide: true,
  env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', COSYNCING_WINDOWS_BROKER_RUN_ID: `wb-${runId}` },
});
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text().catch(() => ''),
  new Response(proc.stderr).text().catch(() => ''),
]);
const exitCode = await proc.exited;
const combined = `${stdout}\n${stderr}`;

// The lane prints one PASS/FAIL line per suite. Those verdicts are the evidence; the suites' own
// output is not carried, for the same reason the survey does not carry it.
const verdicts = combined
  .split(/\r?\n/)
  .map((line) => /^(PASS|FAIL)\s{2}(\S+)\s\(([^,]+),\s(\d+)ms\)$/.exec(line.trim()))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => ({ suite: match[2], area: match[3], durationMs: Number(match[4]), passed: match[1] === 'PASS' }));

const report = await Bun.file(win32.join(candidateRoot, 'output', 'check', 'windows-broker', 'report.json'))
  .json()
  .catch(() => null) as { counts?: { total: number; passed: number; failed: number }; cleanup?: Record<string, unknown> } | null;

const assertions = {
  laneExitedZero: exitCode === 0,
  everySuitePassed: verdicts.length > 0 && verdicts.every((verdict) => verdict.passed),
  reportWasWritten: report !== null,
  reportAgreesWithVerdicts: report?.counts?.total === verdicts.length && report?.counts?.failed === 0,
  stateDirectoryWasRemoved: report?.cleanup?.stateRootRemoved === true,
};
const findings = Object.entries(assertions).filter(([, held]) => !held).map(([name]) => name);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  runId,
  slice: 'phase7-windows-lane',
  source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
  host: { platform: process.platform, arch: process.arch },
  runtime: { bun: Bun.version },
  lane: { exitCode, durationMs: Date.now() - startedAt, suites: verdicts.length, counts: report?.counts ?? null },
  slowestSuites: [...verdicts].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
  assertions,
  findings,
  result: findings.length === 0 ? 'pass' : 'fail',
})}\n`);
process.exit(0);
