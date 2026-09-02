#!/usr/bin/env bun
/**
 * Phase 7 — driving the packaged candidate through its own lifecycle on a real Windows host.
 *
 * This probe no longer hand-rolls a broker launch. It issues the commands an operator issues and reads
 * the product's own answers, because the earlier version measured things the product does not do:
 * it spawned `cosyncing broker` in the foreground *while setup's service was already running*, so its
 * "start-to-health" timed an existing listener rather than a start.
 *
 * The lifecycle, in order, each step asserted before the next begins:
 *
 *   1. setup            — installs and starts the owned service; `status` must report it healthy.
 *   2. stop             — the endpoint must actually close, proven by refused TCP connects.
 *   3. start            — a genuinely cold start, so start-to-health is a real number.
 *   4. setup + repair   — run again against a healthy install; both must reconcile without drift.
 *   5. uninstall ACTIVE — the service is deliberately left running. Removing a scheduled task does not
 *                         stop the process it spawned, so this is the case that stranded a broker and
 *                         half-removed an install until uninstall learned to stop before removing.
 *   6. residue          — zero owned tasks, folders, processes, listeners, state, cache, staged files.
 *
 * ISOLATION IS THE POINT. This runs on a machine with a real cosyncing install. The state home, the
 * cache and the USER home all live under the disposable run root — setup derives agent-skill and shim
 * targets from the user home, so isolating cosyncing's own state is not enough — and the port is
 * reserved from the OS rather than defaulted, because the default 7734 belongs to the live install.
 *
 * CLEANUP FAILS CLOSED. The run root is deleted only when every removal is *proven*: uninstall reported
 * success, the scheduler is provably empty, the process scan itself succeeded, and a re-inspection after
 * any termination came back clean. If any of those is false or merely unknown, the root and a receipt
 * are retained for recovery — deleting the evidence while a scheduler object may still exist is how a
 * failure becomes unrecoverable.
 *
 * REPORT DISCIPLINE. Counts, booleans and durations only. Scheduler paths carry the user's SID, so they
 * are redacted to `<sid>`; no path outside the disposable root is emitted.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { win32 } from 'node:path';
import { windowsNativeMachineArchitecture } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../../packages/typescript/broker/src/runtime/configuration.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 7 candidate probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const candidateRoot = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_CANDIDATE_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') throw new Error('Phase 7 candidate probe requires its native Windows runner');
if (!win32.isAbsolute(candidateRoot) || candidateRoot.startsWith('\\\\')) {
  throw new Error('Phase 7 candidate probe requires a local-disk candidate root');
}

const artifactDir = win32.join(candidateRoot, '.staged-artifact');
const tarball = existsSync(artifactDir)
  ? readdirSync(artifactDir).filter((name) => name.endsWith('.tgz'))[0]
  : undefined;
const npmPrefix = win32.join(root, 'prefix');
const stateHome = win32.join(root, 'state');
const cacheHome = win32.join(root, 'cache');
const isolatedHome = win32.join(root, 'home');
for (const directory of [npmPrefix, stateHome, isolatedHome]) mkdirSync(directory, { recursive: true });

const shim = win32.join(npmPrefix, 'cosyncing.cmd');
// USERPROFILE and HOME too, not just the cosyncing state home: setup's agent-skill and shim targets are
// derived from the USER home, and this machine's real home holds the operator's actual agent directories.
const isolated = {
  COSYNCING_HOME: stateHome,
  COSYNCING_CACHE_DIR: cacheHome,
  USERPROFILE: isolatedHome,
  HOME: isolatedHome,
};

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

async function run(
  command: string[],
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(command, {
    cwd: candidateRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', ...(options.env ?? {}) },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // The shim is cmd.exe and the product is its CHILD, so the tree is what has to go.
    try {
      Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
    } catch { /* gone */ }
  }, options.timeoutMs ?? 300_000);
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

/** Bounded tails only: the product's own diagnostics, never host paths beyond the disposable root. */
function tail(result: RunResult | null, channel: 'stdout' | 'stderr', bytes = 400): string {
  return (result?.[channel] ?? '').trim().slice(-bytes);
}

const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
const powershellPath = systemRoot
  ? win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : undefined;

/** Every scan reports whether it SUCCEEDED, so "found nothing" is never confused with "could not look". */
interface Scan<T> { probed: boolean; value: T }

function powershell(script: string, env: Record<string, string> = {}): Scan<string> {
  if (!powershellPath) return { probed: false, value: '' };
  const result = Bun.spawnSync([powershellPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { probed: result.exitCode === 0, value: result.stdout.toString() };
}

/**
 * Every scheduler object under the product's root folder, walked recursively.
 *
 * The task path is `\Cosyncing\<SID>\Broker` — keyed on the USER SID, not the installation, so this is
 * the whole of what any install for this user can own. A pre-existing folder therefore belongs to
 * someone else's install and this probe refuses to install over it rather than colliding.
 */
const SCHEDULER_SCAN = `$ErrorActionPreference='Stop'
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$found = New-Object System.Collections.ArrayList
function Walk($folder) {
  foreach ($task in $folder.GetTasks(1)) { [void] $found.Add('task:' + $task.Path) }
  foreach ($child in $folder.GetFolders(0)) { [void] $found.Add('folder:' + $child.Path); Walk $child }
}
$root = $null
try { $root = $service.GetFolder('\\Cosyncing') } catch { $root = $null }
if ($root) { [void] $found.Add('folder:' + $root.Path); Walk $root }
$found -join [Environment]::NewLine
`;

const SID_PATTERN = /S-1-5-21-[0-9-]+/g;
function schedulerObjects(): Scan<string[]> {
  const scan = powershell(SCHEDULER_SCAN);
  const value = scan.value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    // The SID identifies the operator's account. Counts and shapes are the finding; the identifier is not.
    .map((line) => line.replace(SID_PATTERN, '<sid>'));
  return { probed: scan.probed, value };
}

/**
 * A process this run is responsible for: its identity is the pair, not the number. A PID alone is not an
 * identity on Windows — the OS reuses them, and the gap between listing one and killing it is exactly
 * where a reused PID becomes someone else's process.
 */
interface OwnedProcess { pid: number; startedAt: string }

/**
 * Matching a command line against this run's root, the way Windows actually compares paths.
 *
 * Case-INSENSITIVELY, because `String.Contains` is not and Windows paths are: a service registered with
 * a differently-cased path is the same path, and a case-sensitive scan simply fails to see it.
 *
 * And only on a path BOUNDARY, so a sibling root whose name merely extends this one — `...\run-1` beside
 * `...\run-10` — can never match. Both matter here for the same reason: this predicate decides what gets
 * terminated.
 */
const ROOTED_PREDICATE = `function Test-RootedIn([string] $line, [string] $needle) {
  $lower = $line.ToLowerInvariant()
  $target = $needle.ToLowerInvariant()
  $index = $lower.IndexOf($target)
  while ($index -ge 0) {
    $after = $index + $target.Length
    if ($after -ge $lower.Length) { return $true }
    $next = $lower[$after]
    if ($next -eq '\\' -or $next -eq '/' -or $next -eq '"' -or $next -eq "'" -or $next -eq ' ') { return $true }
    $index = $lower.IndexOf($target, $index + 1)
  }
  return $false
}
`;

function processesRootedInRunRoot(): Scan<OwnedProcess[]> {
  const scan = powershell(
    `$ErrorActionPreference='Stop'
$needle = [Environment]::GetEnvironmentVariable('COSYNCING_PROBE_RUN_ROOT','Process')
# An absent needle would match EVERY process on the host, in a scan whose caller terminates what it
# returns. Refusing is the only safe answer; the caller reads the failure as "unproven".
if (-not $needle) { throw 'COSYNCING_PROBE_RUN_ROOT is required' }
${ROOTED_PREDICATE}
# The pipes TRAIL. Windows PowerShell 5.1 rejects a line that begins with '|' as an empty pipe element,
# and the version of this scan that led with them exited 1 on every run — so it never listed a process,
# the probe read that as "no orphans", and the two it had actually stranded were found by hand.
Get-CimInstance Win32_Process |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and (Test-RootedIn $_.CommandLine $needle) } |
  ForEach-Object { '{0}|{1}' -f $_.ProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { 'unknown' }) }
`,
    { COSYNCING_PROBE_RUN_ROOT: root },
  );
  const value = scan.value.split(/\r?\n/).flatMap((line): OwnedProcess[] => {
    const [rawPid, startedAt] = line.trim().split('|');
    const pid = Number.parseInt(rawPid ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !startedAt) return [];
    return [{ pid, startedAt }];
  });
  return { probed: scan.probed, value };
}

/**
 * Terminate one process, but only after proving — in the same PowerShell invocation that does the
 * killing — that it is still the process that was listed. Revalidating from here instead would reopen
 * the race it is meant to close.
 */
function terminateIfStillOurs(target: OwnedProcess): 'terminated' | 'gone' | 'foreign' | 'reused' | 'unknown' {
  const scan = powershell(
    `$ErrorActionPreference='Stop'
$needle = [Environment]::GetEnvironmentVariable('COSYNCING_PROBE_RUN_ROOT','Process')
$wantedPid = [int] [Environment]::GetEnvironmentVariable('COSYNCING_PROBE_PID','Process')
$wantedStart = [Environment]::GetEnvironmentVariable('COSYNCING_PROBE_START','Process')
if (-not $needle) { throw 'COSYNCING_PROBE_RUN_ROOT is required' }
${ROOTED_PREDICATE}
$found = Get-CimInstance Win32_Process -Filter "ProcessId = $wantedPid" -ErrorAction SilentlyContinue
if (-not $found) { 'gone'; exit 0 }
if (-not $found.CommandLine -or -not (Test-RootedIn $found.CommandLine $needle)) { 'foreign'; exit 0 }
$actualStart = $(if ($found.CreationDate) { $found.CreationDate.ToString('o') } else { 'unknown' })
# The PID was reused between listing and now, so this is a different process wearing the same number.
if ($actualStart -ne $wantedStart) { 'reused'; exit 0 }
# The shim is cmd.exe and the product is its CHILD, so the tree is what has to go.
& taskkill /PID $wantedPid /T /F | Out-Null
'terminated'
`,
    { COSYNCING_PROBE_RUN_ROOT: root, COSYNCING_PROBE_PID: String(target.pid), COSYNCING_PROBE_START: target.startedAt },
  );
  const verdict = scan.value.trim().split(/\r?\n/).pop()?.trim();
  return scan.probed && (verdict === 'terminated' || verdict === 'gone' || verdict === 'foreign' || verdict === 'reused')
    ? verdict
    : 'unknown';
}

/** A port the OS says is free right now, so this never contends with the live install's 7734. */
function reservePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const { port } = server;
  server.stop(true);
  if (typeof port !== 'number') throw new Error('the OS did not report an ephemeral port');
  return port;
}

const brokerPort = reservePort();

/**
 * Whether anything accepts a TCP connection on the port. This — not an HTTP status — is what "the
 * endpoint is closed" means: a refused connect proves no listener, where an HTTP error only proves the
 * broker disliked the request.
 */
function endpointAccepts(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (accepted: boolean): void => { socket.destroy(); resolve(accepted); };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/** `/api/health` is a PUBLIC route, so this needs no token and stays a fine-grained clock. */
async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch { return false; }
}

/** Returns the INSTANT health was observed, not an elapsed time: the caller owns the origin. */
async function waitForHealthAt(port: number, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port)) return Date.now();
    await Bun.sleep(50);
  }
  return null;
}

/**
 * The endpoint is closed only after CONSECUTIVE refusals. A single refusal can be a socket in transition;
 * a run of them, spread over time, is a closed port.
 */
async function waitForClosedEndpoint(port: number, timeoutMs: number, required = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    consecutive = await endpointAccepts(port) ? 0 : consecutive + 1;
    if (consecutive >= required) return true;
    await Bun.sleep(200);
  }
  return false;
}

interface LifecycleStatus {
  ok?: boolean;
  installation?: { committed?: boolean; detailCode?: string };
  service?: { mode?: string; supported?: boolean; active?: string; enabled?: string; definition?: string; environment?: string };
  listener?: { port?: number; ready?: boolean };
  detailCodes?: string[];
}

/**
 * `status` exits 1 whenever the installation is not healthy, which is the EXPECTED state between stop and
 * start — so the JSON body is the authority here and the exit code is only recorded.
 */
async function status(): Promise<{ result: RunResult; report: LifecycleStatus | null }> {
  const result = await run([shim, 'status', '--json'], { timeoutMs: 180_000, env: isolated });
  let report: LifecycleStatus | null = null;
  try { report = JSON.parse(result.stdout) as LifecycleStatus; } catch { report = null; }
  return { result, report };
}

async function waitForServiceHealth(timeoutMs: number): Promise<LifecycleStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let last: LifecycleStatus | null = null;
  for (;;) {
    const { report } = await status();
    last = report ?? last;
    if (report?.ok === true && report.service?.active === 'active' && report.listener?.ready === true) return report;
    if (Date.now() >= deadline) return last;
    await Bun.sleep(1_000);
  }
}

// ------------------------------------------------------------------------------- 0. preflight
// Nothing is installed before an object belonging to someone else is ruled out. A pre-existing folder is
// an operator's install at the very path this candidate would claim, and the product would classify it a
// conflict; the probe stops rather than contending for it.
const schedulerBefore = schedulerObjects();
const preflightClean = schedulerBefore.probed && schedulerBefore.value.length === 0;

// ---------------------------------------------------------------- 1. acquire the exact candidate
const install = preflightClean && tarball
  ? await run(['npm.cmd', 'install', '--global', '--prefix', npmPrefix, '--no-audit', '--no-fund',
    win32.join(artifactDir, tarball)], { timeoutMs: 600_000 })
  : null;
const acquired = install?.exitCode === 0 && existsSync(shim);

// ------------------------------------------------------------ 2. the two baselines, measured apart
// `version` never loads the broker runtime — the CLI imports it lazily, only when starting the broker —
// so this is the shim-plus-Bun floor and does NOT include the host gate.
const version = acquired ? await run([shim, 'version', '--json'], { timeoutMs: 120_000 }) : null;
// The gate itself, through the product's own entry point rather than a copy of its script here.
const probeStartedAt = Date.now();
const probeAnswer = acquired ? windowsNativeMachineArchitecture() : 'unknown';
const probeDurationMs = Date.now() - probeStartedAt;

// -------------------------------------------------------------------- 3. setup, and service health
// Written with the PRODUCT's own writer, not hand-rolled JSON: a hand-written config omitted the schema
// version, so setup classified it malformed, refused to overwrite ambiguous configuration, and fell back
// to the default port 7734 — the operator's live broker.
if (acquired) {
  const candidateConfig = defaultBrokerConfig();
  candidateConfig.broker.port = brokerPort;
  candidateConfig.broker.internalUrl = `http://127.0.0.1:${brokerPort}`;
  candidateConfig.broker.machineLabel = `phase7-candidate-${runId}`;
  writeBrokerConfig(candidateConfig, stateHome);
}
// `setup` takes no --json: it accepts --yes and its consent flags and nothing else, and an unknown option
// is an exit-2 in a hundred milliseconds that reads exactly like a fast success.
const SETUP_ARGUMENTS = ['setup', '--yes', '--accept-managed-runtime-ownership',
  '--no-install-agent-skill', '--no-install-opencode-shim'];
// The retention marker goes down BEFORE setup runs, not after it. A setup that dies mid-transaction is
// precisely the run that leaves a scheduler object behind, and it never reaches a line placed after its
// own invocation. The marker is cleared only once removal is proven at the very end, so a probe that
// throws anywhere in between leaves it standing and the staging script keeps the tree rather than
// deleting the evidence along with the residue.
const receiptPath = win32.join(root, 'phase7-retention-receipt.json');
function writeRetentionReceipt(reason: string[], detail: Record<string, unknown> = {}): void {
  try {
    writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, runId, retainedReason: reason, ...detail }, null, 2)}\n`);
  } catch { /* the report still carries the reason */ }
}
if (acquired) writeRetentionReceipt(['lifecycle-in-progress']);
const setup = acquired ? await run([shim, ...SETUP_ARGUMENTS], { timeoutMs: 900_000, env: isolated }) : null;
const afterSetup = setup?.exitCode === 0 ? await waitForServiceHealth(180_000) : null;
const setupHealthy = afterSetup?.ok === true
  && afterSetup.service?.mode === 'task-scheduler'
  && afterSetup.service?.active === 'active'
  && afterSetup.listener?.ready === true;

// ----------------------------------------------------- 4. stop, and prove the endpoint is closed
const stop = setupHealthy ? await run([shim, 'stop', '--json'], { timeoutMs: 300_000, env: isolated }) : null;
const endpointClosed = stop?.exitCode === 0 ? await waitForClosedEndpoint(brokerPort, 60_000) : false;
const afterStop = stop?.exitCode === 0 ? (await status()).report : null;
const stoppedCleanly = stop?.exitCode === 0
  && endpointClosed
  && afterStop?.service?.active === 'inactive'
  && afterStop.listener?.ready === false;

// -------------------------------------------- 5. start, and measure a genuinely cold start-to-health
// Cold because the previous step PROVED the listener was gone. The earlier probe reported single-digit
// milliseconds here because it was timing setup's service, which had never stopped.
let startCommand: RunResult | null = null;
let startTiming = {
  /** How long `start` itself took to return. */
  startCommandMs: null as number | null,
  /** When health was first observed, measured from the same instant the command was launched. */
  healthObservedAtMs: null as number | null,
  /** Positive: the command was still returning after the broker was already healthy. */
  commandCompletionRelativeToHealthMs: null as number | null,
  /** Launch until BOTH the command returned and health was observed — when the step is fully settled. */
  totalStartToHealthMs: null as number | null,
};
if (stoppedCleanly) {
  const launchedAt = Date.now();
  // Both clocks run from the SAME instant, and the poll runs CONCURRENTLY with the command. Awaiting
  // `start` first and only then polling cannot see a broker that became healthy while the command was
  // still returning: it charges that interval to start-to-health and reports a number the product never
  // took. Which of the two finishes first is itself the finding, so both are recorded.
  const health = waitForHealthAt(brokerPort, 240_000);
  startCommand = await run([shim, 'start', '--json'], { timeoutMs: 300_000, env: isolated });
  const commandFinishedAt = Date.now();
  const healthyAt = await health;
  startTiming = {
    startCommandMs: commandFinishedAt - launchedAt,
    healthObservedAtMs: healthyAt === null ? null : healthyAt - launchedAt,
    commandCompletionRelativeToHealthMs: healthyAt === null ? null : commandFinishedAt - healthyAt,
    totalStartToHealthMs: healthyAt === null ? null : Math.max(commandFinishedAt, healthyAt) - launchedAt,
  };
}
const startedCleanly = startCommand?.exitCode === 0 && startTiming.healthObservedAtMs !== null;

// ------------------------------------------------------- 6. setup and repair again: reconciliation
// Both run against an installation that is already healthy. Setup must be idempotent and repair must
// report a complete reconcile; the installation must still be healthy afterwards.
const resetup = startedCleanly ? await run([shim, ...SETUP_ARGUMENTS], { timeoutMs: 900_000, env: isolated }) : null;
const repair = resetup?.exitCode === 0
  ? await run([shim, 'repair', '--yes', '--json'], { timeoutMs: 900_000, env: isolated })
  : null;
const afterReconcile = repair?.exitCode === 0 ? await waitForServiceHealth(180_000) : null;
const reconciled = resetup?.exitCode === 0
  && repair?.exitCode === 0
  && afterReconcile?.ok === true
  && afterReconcile.service?.active === 'active'
  && afterReconcile.listener?.ready === true;

// --------------------------------------------------------------------- 7. uninstall WHILE ACTIVE
// Deliberately not stopped first. Deleting a scheduled task does not stop the process it spawned, so an
// uninstall that removes before stopping strands a broker holding the port and every staged file, and
// then cannot remove those files — reporting cleanup-required with the install half gone.
const beforeUninstall = reconciled ? (await status()).report : null;
const activeAtUninstall = beforeUninstall?.service?.active === 'active' && beforeUninstall.listener?.ready === true;
const uninstall = activeAtUninstall
  ? await run([shim, 'uninstall', '--yes', '--purge-data', '--confirm-purge-data', '--json'],
    { timeoutMs: 600_000, env: isolated })
  : null;

// -------------------------------------- 8. recovery: product-owned, attempted whatever else failed
// The lifecycle above stops at its first failed step, and EVERY step after setup leaves an installed
// service behind. A probe that uninstalls only on the happy path therefore hands the host back with a
// running service and a scheduled task precisely when it has found a defect — which is when that is
// least welcome. It happened: a resetup that exited 1 stalled the run before uninstall, and the task,
// the listener, the state and the cache all had to be recovered by hand afterwards.
//
// This runs regardless of which assertion failed, and its result is recorded SEPARATELY so it can never
// be read as the primary uninstall it is compensating for. `stop` first, because an uninstall that
// removes a running service is the very defect this slice exists to prove fixed.
const recoveryNeeded = acquired && setup?.exitCode === 0 && uninstall?.exitCode !== 0;
let recoveryStop: RunResult | null = null;
let recoveryUninstall: RunResult | null = null;
if (recoveryNeeded) {
  recoveryStop = await run([shim, 'stop', '--json'], { timeoutMs: 300_000, env: isolated });
  recoveryUninstall = await run([shim, 'uninstall', '--yes', '--purge-data', '--confirm-purge-data', '--json'],
    { timeoutMs: 600_000, env: isolated });
}

// -------------------------------------------------------- 9. residue, inspected AFTER any recovery
let schedulerAfter = schedulerObjects();
let listenerRemaining = await endpointAccepts(brokerPort);
let survivors = processesRootedInRunRoot();

// Termination is the LAST resort, reached only where the product's own cleanup did not finish the job.
// It is not a cleanup strategy; it is what happens when the cleanup strategy failed. Every scan reports
// whether it ran, so "found nothing" and "could not look" stay different answers.
const terminations: Record<string, number> = {};
let terminationAttempted = false;
if (survivors.probed && survivors.value.length > 0) {
  terminationAttempted = true;
  for (const candidate of survivors.value) {
    const verdict = terminateIfStillOurs(candidate);
    terminations[verdict] = (terminations[verdict] ?? 0) + 1;
  }
  // Re-inspect EVERYTHING that killing a process can change. The listener above was sampled before any
  // termination, so it described a host that no longer exists; reporting it would have credited the
  // product with closing a port that a taskkill closed.
  survivors = processesRootedInRunRoot();
  listenerRemaining = await endpointAccepts(brokerPort);
  schedulerAfter = schedulerObjects();
}

const residue = {
  schedulerProbed: schedulerAfter.probed,
  schedulerObjectsRemaining: schedulerAfter.value.length,
  schedulerObjects: schedulerAfter.value,
  listenerRemaining,
  processScanProbed: survivors.probed,
  processesRemaining: survivors.value.length,
  terminationAttempted,
  terminations,
  stateHomeRemains: existsSync(stateHome),
  cacheHomeRemains: existsSync(cacheHome),
  isolatedHomeCosyncingRemains: existsSync(win32.join(isolatedHome, '.cosyncing')),
};

const productResidueClear = residue.schedulerProbed
  && residue.schedulerObjectsRemaining === 0
  && !residue.listenerRemaining
  && residue.processScanProbed
  && residue.processesRemaining === 0
  && !residue.stateHomeRemains
  && !residue.cacheHomeRemains
  && !residue.isolatedHomeCosyncingRemains;

// -------------------------------------------------------------------- 9. cleanup, failing closed
// The staged root is removed ONLY when every removal above is proven. Anything unproven — a failed
// uninstall, a scheduler that could not be read, a scan that did not run — retains the root and a
// receipt instead, because deleting the evidence while a scheduler object may remain is what turns a
// recoverable failure into an unrecoverable one.
const uninstallSucceeded = uninstall?.exitCode === 0;
/** Either uninstall may have done the removing; residue still decides whether it worked. */
const anyUninstallSucceeded = uninstallSucceeded || recoveryUninstall?.exitCode === 0;
// Residue decides. `uninstall === null` means the lifecycle never got far enough to install anything, so
// there is no removal to have failed — but the residue scans above still have to come back clean and
// PROVEN, which is what stops a failed setup that did leave an object from being quietly swept away.
const safeToRemoveStaging = productResidueClear
  && (uninstall === null ? recoveryUninstall === null || anyUninstallSucceeded : anyUninstallSucceeded);
let stagingRemoved = false;
let retainedReason: string[] = [];
if (safeToRemoveStaging) {
  // The marker goes first and only now: everything it guarded has been proven gone.
  try { rmSync(receiptPath, { force: true }); } catch { /* never existed */ }
  try { rmSync(root, { recursive: true, force: true }); stagingRemoved = !existsSync(root); } catch { stagingRemoved = false; }
} else {
  retainedReason = [
    ...(uninstall === null && recoveryUninstall === null ? [] : anyUninstallSucceeded ? [] : ['uninstall-did-not-succeed']),
    ...(residue.schedulerProbed ? [] : ['scheduler-unreadable']),
    ...(residue.schedulerObjectsRemaining > 0 ? ['scheduler-objects-remain'] : []),
    ...(residue.listenerRemaining ? ['listener-remains'] : []),
    ...(residue.processScanProbed ? [] : ['process-scan-failed']),
    ...(residue.processesRemaining > 0 ? ['processes-remain'] : []),
    ...(residue.stateHomeRemains ? ['state-home-remains'] : []),
    ...(residue.cacheHomeRemains ? ['cache-home-remains'] : []),
    ...(residue.isolatedHomeCosyncingRemains ? ['isolated-home-remains'] : []),
  ];
  // The provisional marker is replaced by the specific reasons, in the retained root where whoever
  // recovers this finds it beside the residue itself.
  writeRetentionReceipt(retainedReason.length > 0 ? retainedReason : ['lifecycle-incomplete'], {
    residue,
    uninstallExitCode: uninstall?.exitCode ?? null,
    uninstallStdoutTail: tail(uninstall, 'stdout', 600),
  });
}

const assertions = {
  // Preflight: no object belonging to another install stood where this one would go.
  schedulerClearBeforeInstall: preflightClean,
  candidateAcquired: acquired,
  packagedCommandLaunches: version?.exitCode === 0,
  nativeArchitectureProven: probeAnswer === 'x64',
  setupCommitted: setup?.exitCode === 0,
  serviceHealthyAfterSetup: setupHealthy,
  stopClosedTheEndpoint: stoppedCleanly,
  coldStartReachedHealth: startedCleanly,
  // Not a pass/fail of the product: it records that the harness handed the host back clean even when the
  // lifecycle did not finish. A run that needed recovery and got it is still a failed run.
  recoveryLeftHostClean: !recoveryNeeded || (anyUninstallSucceeded && productResidueClear),
  reconciledWithoutDrift: reconciled,
  // The case the product used to get wrong.
  uninstallSucceededWhileActive: activeAtUninstall && uninstallSucceeded,
  schedulerClearAfterUninstall: residue.schedulerProbed && residue.schedulerObjectsRemaining === 0,
  noListenerRemaining: !residue.listenerRemaining,
  noProcessesRemaining: residue.processScanProbed && residue.processesRemaining === 0,
  stateAndCachePurged: !residue.stateHomeRemains && !residue.cacheHomeRemains
    && !residue.isolatedHomeCosyncingRemains,
  stagedFilesRemoved: stagingRemoved,
};
const findings = Object.entries(assertions).filter(([, held]) => !held).map(([name]) => name);

process.stdout.write(`${JSON.stringify({
  schemaVersion: 2,
  runId,
  slice: 'phase7-windows-candidate',
  source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
  host: { platform: process.platform, arch: process.arch },
  runtime: { bun: Bun.version },
  candidate: { tarballPresent: tarball !== undefined, installExitCode: install?.exitCode ?? null },
  timings: {
    // Each measures one thing and stands in for nothing else.
    shimAndRuntimeBaselineMs: version?.durationMs ?? null,
    nativeArchitectureProbeMs: probeDurationMs,
    nativeArchitectureAnswer: probeAnswer,
    setupMs: setup?.durationMs ?? null,
    stopMs: stop?.durationMs ?? null,
    // Four numbers, because one cannot say whether the broker was healthy before or after `start`
    // returned — and the answer is the interesting part.
    ...startTiming,
    resetupMs: resetup?.durationMs ?? null,
    repairMs: repair?.durationMs ?? null,
    uninstallMs: uninstall?.durationMs ?? null,
  },
  lifecycle: {
    setupExitCode: setup?.exitCode ?? null,
    serviceModeAfterSetup: afterSetup?.service?.mode ?? null,
    serviceActiveAfterSetup: afterSetup?.service?.active ?? null,
    listenerReadyAfterSetup: afterSetup?.listener?.ready ?? null,
    stopExitCode: stop?.exitCode ?? null,
    endpointClosedAfterStop: endpointClosed,
    serviceActiveAfterStop: afterStop?.service?.active ?? null,
    startExitCode: startCommand?.exitCode ?? null,
    resetupExitCode: resetup?.exitCode ?? null,
    repairExitCode: repair?.exitCode ?? null,
    serviceActiveAfterReconcile: afterReconcile?.service?.active ?? null,
    activeAtUninstall,
    uninstallExitCode: uninstall?.exitCode ?? null,
    // The compensating path, kept apart from the primary uninstall it stands in for.
    recoveryAttempted: recoveryNeeded,
    recoveryStopExitCode: recoveryStop?.exitCode ?? null,
    recoveryUninstallExitCode: recoveryUninstall?.exitCode ?? null,
  },
  residue,
  cleanup: {
    safeToRemoveStaging,
    stagingRemoved,
    retainedForRecovery: !safeToRemoveStaging,
    retainedReason,
  },
  // Exit codes and bounded tails, because a probe that reports only durations cannot say why a step
  // failed — and a 116ms setup that was really an unknown-option rejection reads as a fast success
  // until someone goes looking. `--json` writes to STDOUT, so recording only stderr once left an
  // exit 4 unexplained: the reason was in the channel that was not read.
  // EVERY command, both channels. A hand-picked subset is how `resetup` came back as a bare exit 1 with
  // nothing to say why, stalling the lifecycle before repair and uninstall ever ran; and how a 116ms
  // unknown-option rejection once read as a fast success. `--json` writes to STDOUT, so stderr alone
  // leaves a non-zero exit unexplained.
  diagnostics: Object.fromEntries(([
    ['install', install], ['version', version], ['setup', setup], ['stop', stop],
    ['start', startCommand], ['resetup', resetup], ['repair', repair], ['uninstall', uninstall],
    ['recoveryStop', recoveryStop], ['recoveryUninstall', recoveryUninstall],
  ] as Array<[string, RunResult | null]>).flatMap(([name, result]) => [
    [`${name}ExitCode`, result?.exitCode ?? null],
    [`${name}StdoutTail`, tail(result, 'stdout', 600)],
    [`${name}StderrTail`, tail(result, 'stderr', 600)],
  ])),
  assertions,
  findings,
  result: findings.length === 0 ? 'pass' : 'fail',
}, null, 2)}\n`);
