#!/usr/bin/env bun
/**
 * Phase 7 — the cheap native smoke, at the exact tip.
 *
 * Three questions, answered in one staged native run before any expensive work is committed to:
 *
 *  1. can the JavaScript bundle be built on Windows;
 *  2. does the packaged command launch from a disposable directory through
 *     the `.cmd` shim, the two-pid shape this whole effort is about;
 *  3. does the product state exactly the host verdict it is supposed to state.
 *
 * The required lane is deliberately NOT run here. It was, under a 15-minute budget, back when the
 * lane was twenty-one suites costing 94 seconds combined. It is now twenty-five, and transactional
 * setup alone takes 47 minutes natively against broker lifecycle's 16, so a smoke that waited for it
 * could only ever time out and report the lane red for its own budget. The lane has its own
 * 120-minute job; run it separately, and leave this probe the cheap thing its name claims.
 *
 * The third is the one worth being careful about. Before enablement it recorded the REFUSAL, so that
 * there would be a prior measurement of what the product did, taken with the same instrument; a
 * refusal nobody measured is indistinguishable afterwards from a refusal that never worked. It now
 * records the acceptance that replaced it. What it does NOT cover is the Windows ARM64 boundary: this
 * probe runs on one machine and can only report that machine, so the refusal cases are pinned as
 * verdicts in the release-policy suite instead.
 *
 * The web app is deliberately not built here. This is the cheap smoke; the packaged
 * candidate that carries the physical acceptance pass is a different artifact and must be built whole.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { windowsNativeMachineArchitecture } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { windowsLauncherText } from '../../../packages/typescript/broker/src/updates/bun-runtime-upgrade.ts';
import { win32 } from 'node:path';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 7 smoke requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const candidateRoot = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_CANDIDATE_ROOT');
const stagedBun = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_BUN');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') throw new Error('Phase 7 smoke requires its native Windows runner');
if (!win32.isAbsolute(candidateRoot) || candidateRoot.startsWith('\\\\')) {
  throw new Error('Phase 7 smoke requires a local-disk candidate root');
}

const prefix = win32.join(root, 'prefix');
mkdirSync(prefix, { recursive: true });
const application = win32.join(prefix, 'cosyncing');
const shim = win32.join(prefix, 'cosyncing.cmd');

interface Run { exitCode: number; stdout: string; stderr: string; durationMs: number; timedOut: boolean }

async function run(command: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<Run> {
  const startedAt = Date.now();
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? candidateRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  let timedOut = false;
  const budget = options.timeoutMs ?? 600_000;
  const timer = setTimeout(() => {
    timedOut = true;
    // Not proc.kill(): these spawn children that inherit the pipes being read below.
    try { Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }); } catch { /* gone */ }
  }, budget);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
  ]);
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => { setTimeout(() => resolve(-1), 10_000); }),
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut };
}

// Build the same JavaScript artifact as the signed release, then exercise a Windows command shim.
const build = await run([
  stagedBun, 'run', 'scripts/broker/build-broker-bundle.ts',
  '--outfile', application, '--commit', sourceCommit,
], { timeoutMs: 900_000 });
if (build.exitCode === 0) {
  writeFileSync(shim, windowsLauncherText(stagedBun));
}

const version = existsSync(shim) ? await run([shim, 'version', '--json'], { timeoutMs: 120_000 }) : null;
let reportedVersion: string | null = null;
if (version?.exitCode === 0) {
  try { reportedVersion = (JSON.parse(version.stdout) as { version?: string }).version ?? null; } catch { reportedVersion = null; }
}

// ------------------------------------- 3. what the host gate costs, isolated from what surrounds it
// The probe alone, through the product's own exported entry point rather than a copy of its script: a
// re-implementation here would measure this file instead of the thing that runs on every broker start.
const probeStartedAt = Date.now();
const probeAnswer = windowsNativeMachineArchitecture();
const probeDurationMs = Date.now() - probeStartedAt;

// -------------------------------------------------- 4. the host verdict this baseline is here for
const doctor = existsSync(shim) ? await run([shim, 'doctor', '--json'], { timeoutMs: 300_000 }) : null;
// `DoctorReport` carries `sections[].checks[]`, NOT a flat `checks` array. Reading the wrong shape
// here reported "the Windows refusal is gone" when the refusal was intact and the parse was wrong —
// which for a probe whose whole job is recording a baseline is the worst failure available to it.
let hostCheck: { status?: string; detailCode?: string } | null = null;
let doctorSectionIds: string[] = [];
if (doctor) {
  try {
    const report = JSON.parse(doctor.stdout) as {
      sections?: Array<{ id: string; checks?: Array<{ id: string; status: string; detailCode?: string }> }>;
    };
    doctorSectionIds = (report.sections ?? []).map((section) => section.id);
    hostCheck = (report.sections ?? [])
      .flatMap((section) => section.checks ?? [])
      .find((check) => check.id === 'host.platform') ?? null;
  } catch { hostCheck = null; }
}

// Observed BEFORE cleanup. Asserting `existsSync` after deleting the tree reported the shim as
// missing while the command it had just launched returned a version —
// the probe was measuring its own rmSync.
const shimPresent = existsSync(shim);

let removed = false;
try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }

const assertions = {
  javascriptBundleBuilt: build.exitCode === 0 && shimPresent,
  // The command itself runs here, through the `.cmd` shim and its two-pid shape.
  packagedCommandLaunches: version !== null && version.exitCode === 0 && reportedVersion !== null,
  // This host is Windows x64. An ARM64 machine — native or emulating this very process — is refused, and
  // that boundary is pinned by the release-policy verdict cases rather than by this single-host probe.
  doctorAcceptsNativeWindowsX64: hostCheck?.status === 'pass'
    && hostCheck?.detailCode === 'windows-supported',
  disposableRootRemoved: removed,
};
const findings = Object.entries(assertions).filter(([, held]) => !held).map(([name]) => name);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  runId,
  slice: 'phase7-windows-smoke',
  source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
  host: { platform: process.platform, arch: process.arch },
  runtime: { bun: Bun.version },
  bundle: {
    buildExitCode: build.exitCode,
    buildDurationMs: build.durationMs,
    shimPresent,
  },
  packagedCommand: {
    versionExitCode: version?.exitCode ?? null,
    version: reportedVersion,
    // Three separate numbers, because none of them alone is the cost of the host gate.
    //
    // `version` does NOT pay for it: the CLI imports the broker runtime lazily, only when starting the
    // broker, so this is the shim-plus-Bun baseline and nothing more. `doctor` DOES run the probe, but
    // it also runs every other doctor check, so it cannot isolate it either. The probe is therefore
    // timed directly, and the real answer — what an operator or a service unit actually waits for — is
    // the broker's own start-to-health, measured separately below.
    versionDurationMs: version?.durationMs ?? null,
    doctorDurationMs: doctor?.durationMs ?? null,
    nativeArchitectureProbeMs: probeDurationMs,
    nativeArchitectureAnswer: probeAnswer,
  },
  // Start-to-health is deliberately NOT here. A broker cannot start until setup has written config and
  // credentials, and this probe is the cheap one that runs before any of that; measuring it here would
  // mean running setup, which is the expensive pass this file exists to stay out of. It belongs to the
  // candidate measurement, together with setup, service reconciliation and uninstall.
  // The baseline, named rather than merely observed.
  windowsRefusal: {
    status: hostCheck?.status ?? null,
    detailCode: hostCheck?.detailCode ?? null,
    doctorExitCode: doctor?.exitCode ?? null,
    doctorSectionIds,
  },
  assertions,
  findings,
  result: findings.length === 0 ? 'pass' : 'fail',
})}\n`);
process.exit(0);
