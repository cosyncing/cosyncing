#!/usr/bin/env bun
/**
 * The Windows broker lane.
 *
 * Phase 7 adds a `windows-broker` job to CI. What that job runs lives HERE rather than in the
 * workflow, for two reasons. The workflow audit refuses a workflow that names verification work of
 * its own — the graph is the single place a lane's contents are declared — and a suite list written
 * in YAML is a list nobody reviews next to the suites it names.
 *
 * Membership is MEASURED, not chosen by reading script names: `scripts/broker/windows/
 * phase7-suite-survey.ts` runs every `test:broker*` script one at a time on a staged native Windows
 * tree and reports a verdict for each. A suite enters this lane when that survey passes it, and the
 * note beside it says what it covers, so a later reader can tell a deliberate member from a
 * hopeful one.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface LaneSuite {
  /** package.json script name. */
  readonly suite: string;
  /** Which of Phase 7's named areas this suite is here to cover. */
  readonly area: string;
}

/**
 * The lane, by area.
 *
 * Phase 7 step 2: "Start with a small required lane covering host primitives, secure files, service
 * lifecycle, transactional setup, doctor, broker lifecycle, and the qualified adapters", widening
 * toward the deterministic aggregate as POSIX-only fixtures are removed. Small on purpose — a
 * required lane that is red for reasons nobody has characterised is worse than a narrow green one.
 *
 * Measured 2026-08-26 on a staged native Windows tree: 22 of 55 `test:broker*` suites pass. Twenty-one
 * of them are here. `test:broker-doctor-real` is the twenty-second and is deliberately NOT here: it
 * prints `"status": "skip"` and exits zero unless `COSYNCING_DOCTOR_REAL_AGENT=1` names installed
 * CLIs to check, so admitting it would report coverage the lane does not have.
 *
 * Measured again 2026-08-28, after removing the POSIX-only fixtures step 2 describes: broker lifecycle
 * and durable state now PASS natively on both Bun lanes, 103/103 and 47/47, and are members. Both had
 * previously failed for one product defect apiece rather than for anything about the suites — a shim the
 * product could not prove it owned, and state files it wrote through a creation path Windows would not
 * let it read back.
 *
 * Measured again 2026-09-02, after owner-only enforcement stopped shelling out: the lane cost 102
 * minutes and 94 of them were two suites, `test:broker-setup` at 66 and `test:broker-lifecycle` at
 * 28, against 51 seconds and 17 on POSIX. None of that was the suites. One setup run performs about
 * 4,470 owner-only filesystem operations -- counted, not estimated -- and each one spawned a
 * `powershell.exe` process to rewrite an ACL, at 271ms measured. The same operation through the
 * Windows API costs 0.143ms, so those 4,470 operations went from twenty minutes at best to under a
 * second, and the lane fits in single-digit minutes.
 *
 * Nothing was pruned to get there, and nothing should be. The cost was never in the suite list, and
 * the cheap members are not passengers: `test:broker-protocol-journal` is 60ms of pure logic that
 * caught a real Windows defect -- a temp root built at a literal `/tmp`, which on Windows is the
 * current DRIVE's root -- precisely because it RAN on Windows rather than because it tests anything
 * Windows-specific. A suite that only proves the product works on this platform at all is the
 * cheapest coverage in the lane.
 */
/**
 * What this lane is allowed to cost, as a number rather than as an intention.
 *
 * A required check nobody wants to wait for is a check people work around. Reported on every run and
 * carried in the report, so the slide back is visible in the run that starts it rather than in the
 * quarter that ends with a two-hour gate. Deliberately NOT a failure: a loaded runner having a bad
 * day is not a regression, and a gate that goes red for being slow teaches people to rerun it. The
 * job's own 20-minute timeout is the hard stop.
 */
const LANE_BUDGET_MS = 15 * 60_000;

const LANE: readonly LaneSuite[] = [
  { suite: 'test:broker-windows-process', area: 'host primitives' },
  { suite: 'test:broker-windows-dacl', area: 'secure files' },
  { suite: 'test:broker-windows-service', area: 'service lifecycle' },
  { suite: 'test:broker-lifecycle', area: 'broker lifecycle' },
  { suite: 'test:broker-state', area: 'durable state and secure files' },
  { suite: 'test:broker-doctor', area: 'doctor' },
  { suite: 'test:broker-setup', area: 'transactional setup' },
  { suite: 'test:broker-kimi-cross-client-join', area: 'qualified adapters' },
  { suite: 'test:broker-attach-identity', area: 'broker attach lifecycle' },
  { suite: 'test:broker-control-boundaries', area: 'control surface' },
  { suite: 'test:broker-route-authorization', area: 'route authorization' },
  { suite: 'test:broker-roster-publication', area: 'roster publication' },
  { suite: 'test:broker-status-broadcast', area: 'status broadcast' },
  { suite: 'test:broker-session-truth-conformance', area: 'session truth' },
  { suite: 'test:broker-request-resolution', area: 'request resolution' },
  { suite: 'test:broker-protocol-journal', area: 'protocol journal' },
  { suite: 'test:broker-update-contract', area: 'update contract' },
  { suite: 'test:broker-sync-degraded-integration', area: 'degraded sync' },
  { suite: 'test:broker-diff-reference-wire', area: 'diff wire' },
  { suite: 'test:broker-diff-body-reference', area: 'diff body reference' },
  { suite: 'test:broker-draft-sync-wire', area: 'draft sync wire' },
  { suite: 'test:broker-echo-correlation', area: 'echo correlation' },
  { suite: 'test:broker-history-page-cache', area: 'history page cache' },
  { suite: 'test:broker-attention-bulk', area: 'attention dismissal' },
  { suite: 'test:broker-real-host-evidence', area: 'release evidence' },
];

/**
 * Sweep without running anything.
 *
 * The lane already sweeps in a `finally`, which covers a suite that fails or throws. It does NOT
 * cover the runner being killed — a job timeout, a cancelled workflow — and that is exactly when
 * something is most likely to have been left behind. The workflow calls this from a step that runs
 * whichever way the lane ended.
 */
const sweepOnly = process.argv.includes('--sweep-only');

if (process.platform !== 'win32') {
  console.error('FAIL windows-broker: this lane runs on Windows; nothing else can stand in for it.');
  process.exit(1);
}
if (LANE.length === 0 && !sweepOnly) {
  console.error('FAIL windows-broker: the lane is empty; no survey has qualified a suite yet.');
  process.exit(1);
}

/**
 * An identifier unique to this run, carried by everything the run creates.
 *
 * A CI runner is shared with whatever else the job does, and a durable name — a fixed state
 * directory, a fixed Scheduled Task — is how one run's leftovers become the next run's failure. The
 * sweep at the end can only match names containing this, so it cannot reach anything that is not
 * this run's.
 */
const runId = process.env.COSYNCING_WINDOWS_BROKER_RUN_ID
  ?? `wb-${process.pid}-${Date.now().toString(36)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
  console.error('FAIL windows-broker: COSYNCING_WINDOWS_BROKER_RUN_ID is not a safe identifier.');
  process.exit(1);
}

const stateRoot = join(tmpdir(), `cosyncing-windows-broker-${runId}`);
const repositoryRoot = process.cwd();

interface SuiteResult {
  readonly suite: string;
  readonly area: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

async function runSuite(entry: LaneSuite): Promise<SuiteResult> {
  const home = join(stateRoot, entry.suite.replace(/[^A-Za-z0-9]+/g, '-'));
  mkdirSync(home, { recursive: true });
  const startedAt = Date.now();
  const proc = Bun.spawn(['bun', 'run', entry.suite], {
    cwd: repositoryRoot,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      COSYNCING_HOME: join(home, 'cosyncing-home'),
      COSYNCING_CACHE_DIR: join(home, 'cache'),
      COSYNCING_WINDOWS_BROKER_RUN_ID: runId,
      // Anything that parses a spawned child's stdout breaks under colour codes.
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  const exitCode = await proc.exited;
  return { suite: entry.suite, area: entry.area, passed: exitCode === 0, durationMs: Date.now() - startedAt };
}

/**
 * Remove every Scheduled Task this run registered.
 *
 * Nothing in the lane registers one today — the Windows installer suites assert over the PowerShell
 * a real install WOULD run, and stop there. This exists so that the first suite which does register
 * one is cleaned up by a mechanism that already works, rather than by a mechanism written after a
 * runner has been accumulating tasks for a while. Only names carrying this run's identifier are
 * matched, so it cannot reach an operator's own install.
 */
function sweepScheduledTasks(): number {
  const listed = Bun.spawnSync(['schtasks', '/Query', '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'pipe' });
  if (!listed.success) return 0;
  const names = new Set<string>();
  for (const line of new TextDecoder().decode(listed.stdout).split(/\r?\n/)) {
    const name = line.split('","')[0]?.replace(/^"/, '');
    if (name && name.includes(runId)) names.add(name);
  }
  let removed = 0;
  for (const name of names) {
    if (Bun.spawnSync(['schtasks', '/Delete', '/TN', name, '/F'], { stdout: 'ignore', stderr: 'ignore' }).success) {
      removed += 1;
    }
  }
  return removed;
}

if (sweepOnly) {
  const swept = sweepScheduledTasks();
  let removed = true;
  try {
    rmSync(stateRoot, { recursive: true, force: true });
    removed = !existsSync(stateRoot);
  } catch {
    removed = false;
  }
  console.log(`windows-broker sweep ${runId}: ${swept} scheduled task(s), state removed=${removed}`);
  // A sweep never fails the job. It runs after the lane has already decided the outcome, and
  // turning a green lane red because a leftover resisted deletion reports the wrong thing.
  process.exit(0);
}

const results: SuiteResult[] = [];
let sweptTasks = 0;
let stateRemoved = false;
try {
  mkdirSync(stateRoot, { recursive: true });
  for (const entry of LANE) {
    const result = await runSuite(entry);
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.suite} (${result.area}, ${result.durationMs}ms)`);
  }
} finally {
  // Unconditional, and in this order: tasks first, because removing the state a task points at
  // while the task still exists leaves a task that fails instead of a task that is gone.
  sweptTasks = sweepScheduledTasks();
  try {
    rmSync(stateRoot, { recursive: true, force: true });
    stateRemoved = !existsSync(stateRoot);
  } catch {
    stateRemoved = false;
  }
}

const failed = results.filter((result) => !result.passed);
const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
console.log(
  `windows-broker: ${(totalMs / 60_000).toFixed(1)} min of a ${LANE_BUDGET_MS / 60_000} min budget`
  + ` — slowest: ${slowest.map((r) => `${r.suite} ${(r.durationMs / 1000).toFixed(0)}s`).join(', ')}`,
);
if (totalMs > LANE_BUDGET_MS) {
  console.warn(
    `windows-broker: OVER BUDGET by ${((totalMs - LANE_BUDGET_MS) / 60_000).toFixed(1)} min.`
    + ' Something on the owner-only path is spawning processes again, or a suite has grown one.',
  );
}
const reportDirectory = join(repositoryRoot, 'output', 'check', 'windows-broker');
mkdirSync(reportDirectory, { recursive: true });
await Bun.write(
  join(reportDirectory, 'report.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    runId,
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    counts: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    budget: { totalMs, budgetMs: LANE_BUDGET_MS, withinBudget: totalMs <= LANE_BUDGET_MS },
    suites: results,
    cleanup: { stateRootRemoved: stateRemoved, scheduledTasksRemoved: sweptTasks },
  }, null, 2)}\n`,
);

if (!stateRemoved) {
  console.error(`FAIL windows-broker: the run's state directory survived cleanup (${stateRoot}).`);
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`FAIL windows-broker: ${failed.length}/${results.length} suite(s) failed.`);
  process.exit(1);
}
console.log(`PASS windows-broker: ${results.length}/${results.length} suites on ${process.platform}-${process.arch}.`);
