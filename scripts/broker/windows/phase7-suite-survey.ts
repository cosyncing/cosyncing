#!/usr/bin/env bun
/**
 * Phase 7 survey — which broker suites actually pass on native Windows.
 *
 * Phase 7 step 2 says to start the Windows CI lane with "a small required lane covering host
 * primitives, secure files, service lifecycle, transactional setup, doctor, broker lifecycle, and
 * the qualified adapters", then expand toward the deterministic aggregate "after removing POSIX-only
 * fixtures". Which suites belong in that first lane is a question about this machine, not about the
 * names of the scripts, so it is MEASURED here rather than chosen by reading titles.
 *
 * Every suite runs against a disposable COSYNCING_HOME and cache directory, so a suite that writes
 * durable state writes it here and nothing reaches the operator's install. Suites are run one at a
 * time: the point is to learn each one's own verdict, and a parallel run would let a readiness
 * timeout in one be blamed on another.
 *
 * Output is a verdict per suite — exit code, duration, whether it hit the bound, and a CLASSIFIED
 * failure shape. Suite output is never quoted: these spawn real brokers and fake agents, and a
 * report that carries their stdout would carry whatever those printed.
 */
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { win32 } from 'node:path';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 7 survey requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') throw new Error('Phase 7 survey requires its native Windows runner');

/** Per-suite ceiling. Generous: a suite that needs longer than this is not first-lane material anyway. */
const SUITE_TIMEOUT_MS = Number(process.env.COSYNCING_PHASE7_SUITE_TIMEOUT_MS ?? 180_000);
/** Optional filter so a follow-up run can re-measure just the interesting ones. */
const only = (process.env.COSYNCING_PHASE7_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * Opt-in, suite-scoped: carry a bounded tail of a failing suite's output into the report.
 *
 * The default of never quoting output is the right one for a report that gets committed, but a
 * classifier can only report shapes it was taught, and the first Windows run of this survey failed
 * 54 of 55 suites on a shape no marker explained. A report naming the suites it may quote, and
 * capping how much, is how that question gets answered without turning every future run into a
 * transcript. Runs using this are diagnostic and are not the committed evidence.
 */
const diagnose = (process.env.COSYNCING_PHASE7_DIAGNOSE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DIAGNOSE_TAIL_BYTES = 1_200;
const DIAGNOSE_MAX_FAIL_LINES = 25;
const DIAGNOSE_MAX_LINE_CHARS = 400;

/**
 * The lines that say what actually failed.
 *
 * A tail is the wrong instrument for these suites: they keep printing after a failed check, so the
 * one line worth reading sits in the middle. `codex-permissions` put its FAIL on line 27 of sixty.
 */
function failLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /^\s*(FAIL|✗|AssertionError|error:)/.test(line))
    .slice(0, DIAGNOSE_MAX_FAIL_LINES)
    .map((line) => line.trim().slice(0, DIAGNOSE_MAX_LINE_CHARS));
}

/**
 * The staged NTFS tree, named by the runner.
 *
 * Not `process.cwd()`: the probe inherits its working directory across the WSL boundary, so cwd is
 * the WSL checkout reached over \\wsl.localhost. Surveying from there measured the wrong tree over a
 * network redirector and every suite died on ENOENT resolving a workspace link.
 */
const candidateRoot = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_CANDIDATE_ROOT');
/** The lane's pinned runtime. `bun` on PATH is the host's own install and is not what a lane means. */
const laneBun = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_BUN');
// Fail closed rather than survey a share: a UNC candidate is the exact defect above, and its
// verdicts look like ordinary suite failures.
if (!win32.isAbsolute(candidateRoot) || candidateRoot.startsWith('\\\\')) {
  throw new Error('Phase 7 survey requires a local-disk candidate root');
}
const stateHome = win32.join(root, 'cosyncing-home');
const cacheDir = win32.join(root, 'cache');
for (const dir of [stateHome, cacheDir]) mkdirSync(dir, { recursive: true });

const manifest = await Bun.file(win32.join(candidateRoot, 'package.json')).json() as {
  scripts: Record<string, string>;
};
const suites = Object.keys(manifest.scripts)
  .filter((name) => name.startsWith('test:broker'))
  .filter((name) => only.length === 0 || only.includes(name))
  .sort();

/** A fixed marker set; the suite's own text never enters the report. */
const MARKERS: Record<string, RegExp> = {
  brokerNotHealthy: /did not become healthy|broker did not start/i,
  posixOnlySignal: /EPERM|EACCES|chmod|getuid|\/proc|lsof|systemd|launchd/i,
  pathShape: /ENOENT|no such file or directory|cannot find module/i,
  spawnFailure: /spawn|ENOEXEC|not recognized as an internal or external command/i,
  portInUse: /EADDRINUSE|address already in use/i,
  assertion: /AssertionError|FAIL\b|expected/i,
};

/**
 * Where this run says how far it has got.
 *
 * The report is written once, at the end, and a run over the whole manifest can take an hour. With
 * no progress anywhere, a wedged survey and a working one look exactly the same from outside — which
 * is how one of these sat for 74 minutes having produced nothing. Appended after each suite, inside
 * the run's own disposable root, and carrying verdicts only.
 */
const progressPath = win32.join(root, '..', 'phase7-survey-progress.log');
function recordProgress(line: string): void {
  try {
    appendFileSync(progressPath, `${line}\n`);
  } catch {
    // Progress is an aid, never a reason to fail a run.
  }
}
recordProgress(`start ${suites.length} suite(s) timeout=${SUITE_TIMEOUT_MS}ms`);

/**
 * Stop a suite that has run out of time, and everything it started.
 *
 * `proc.kill()` signals the suite alone. These suites spawn brokers and fake agents, which inherit
 * the pipes being read below, so killing the suite leaves its children holding stdout and stderr
 * open — and the reads never settle. That is not a hypothesis: it is the same inherited-handle
 * shape this repository already documents for Windows batch shims, and it wedged this survey
 * indefinitely on the first suite that left a child behind.
 */
function terminateTree(pid: number): void {
  try {
    Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** Read a stream, but never wait past the deadline: a held pipe must not outlive the suite. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, budgetMs: number): Promise<string> {
  if (!stream) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(''), budgetMs);
  });
  try {
    return await Promise.race([new Response(stream).text().catch(() => ''), abandon]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A passing suite's own verdict line, when it can be carried safely.
 *
 * Exit zero is not coverage. Several suites pass on Windows in under 200ms, which for a suite that
 * spawns brokers means it decided there was nothing to do — and a suite that no-ops into a required
 * lane is worse than an absent one, because the lane then reports coverage it does not have. These
 * suites end by printing their own check count, which is the cheapest way to tell 249 assertions
 * from none.
 *
 * Carried ONLY when the line cannot be a path: no backslash anywhere, and no slash adjacent to a
 * letter, so `PASS 249/249 kimi checks` is kept and anything naming a directory is dropped rather
 * than sanitised. The default of not quoting suite output stands; this is a narrow, shape-checked
 * exception for the one line that answers the question.
 */
function safeVerdictLine(output: string): string | undefined {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
  if (line.length === 0 || line.length > 160) return undefined;
  if (!/^PASS\b/.test(line)) return undefined;
  if (line.includes('\\')) return undefined;
  if (/[A-Za-z]\/|\/[A-Za-z]/.test(line)) return undefined;
  return line;
}

const results: Array<Record<string, unknown>> = [];
for (const suite of suites) {
  const startedAt = Date.now();
  const proc = Bun.spawn([laneBun, 'run', suite], {
    cwd: candidateRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      CI: 'true',
      COSYNCING_HOME: stateHome,
      COSYNCING_CACHE_DIR: cacheDir,
      // Anything parsing a spawned child's stdout breaks under colour codes.
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; terminateTree(proc.pid); }, SUITE_TIMEOUT_MS);
  // The grace is what a killed tree needs to release the pipes, not a second budget for the suite.
  const readBudget = SUITE_TIMEOUT_MS + 15_000;
  const [stdout, stderr] = await Promise.all([
    readBounded(proc.stdout as ReadableStream<Uint8Array> | null, readBudget),
    readBounded(proc.stderr as ReadableStream<Uint8Array> | null, readBudget),
  ]);
  clearTimeout(timer);
  // A tree that survived its own kill still holds this process's pipes; take it down before waiting.
  if (timedOut) terminateTree(proc.pid);
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => { setTimeout(() => resolve(-1), 10_000); }),
  ]);
  const combined = `${stdout}\n${stderr}`;
  const markers = Object.entries(MARKERS).filter(([, re]) => re.test(combined)).map(([name]) => name);
  results.push({
    suite,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    outputBytes: combined.length,
    markers: exitCode === 0 ? [] : markers,
    /** -1 means the suite never reported an exit even after its tree was taken down. */
    unreaped: exitCode === -1,
    ...(exitCode === 0 ? { verdict: safeVerdictLine(stdout) ?? null } : {}),
    ...(exitCode !== 0 && diagnose.includes(suite)
      ? { failLines: failLines(combined), outputTail: combined.trim().slice(-DIAGNOSE_TAIL_BYTES) }
      : {}),
  });
  recordProgress(
    `${exitCode === 0 ? 'pass' : 'fail'} ${suite} ${Date.now() - startedAt}ms`
      + `${timedOut ? ' timed-out' : ''}${exitCode === -1 ? ' unreaped' : ''}`,
  );
}
recordProgress('done');

const passed = results.filter((r) => r.exitCode === 0);
const failed = results.filter((r) => r.exitCode !== 0);

let removed = false;
try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  runId,
  slice: 'phase7-windows-suite-survey',
  source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
  host: { platform: process.platform, arch: process.arch },
  runtime: { bun: Bun.version },
  candidateRootIsLocalDisk: true,
  suiteTimeoutMs: SUITE_TIMEOUT_MS,
  counts: { total: results.length, passed: passed.length, failed: failed.length },
  passing: passed.map((r) => ({ suite: r.suite, durationMs: r.durationMs, verdict: r.verdict ?? null })),
  failing: failed.map((r) => ({
    suite: r.suite,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    unreaped: r.unreaped,
    markers: r.markers,
    durationMs: r.durationMs,
    ...(r.failLines === undefined ? {} : { failLines: r.failLines }),
    ...(r.outputTail === undefined ? {} : { outputTail: r.outputTail }),
  })),
  slowestPassingMs: passed.map((r) => r.durationMs as number).sort((a, b) => b - a).slice(0, 5),
  cleanup: { disposableRootRemoved: removed },
  result: 'survey',
})}\n`);
process.exit(0);
