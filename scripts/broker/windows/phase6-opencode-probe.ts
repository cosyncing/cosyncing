#!/usr/bin/env bun
/**
 * Phase 6 OpenCode slice 1 — managed serve ownership on native Windows.
 *
 * One question, and it is a Windows question: when the broker starts `opencode serve` and later
 * restarts, can it PROVE the serve is its own?
 *
 * Ownership proof compares a durable record against the live LISTENER's identity. The record is
 * written from the spawn handle. On Windows `opencode` resolves through PATHEXT to `opencode.cmd`,
 * whose last line CALLS `opencode.exe` — batch has no exec, so the spawn handle is the shell and
 * the listener is its child. Two pids, always. If the record cannot match, a restarting broker
 * classifies its own serve as a stranger's and preserves it: an orphan on the port that no later
 * broker will ever stop, surviving shutdown and uninstall. None of this is visible on Linux, where
 * `opencode` resolves straight to an executable and the two pids are the same.
 *
 * The slice runs real broker lifetimes as separate processes, because module state is what a
 * restart clears. Every verdict comes from the product's own `classifyServeOwnership` against the
 * product's own listener resolution — never from a re-implementation that could agree with the bug.
 *
 * Isolation: a disposable `OPENCODE_DATA`, and a port the OS assigned by an actual bind rather than
 * the `--port` default of 4096, which is inside an excluded range on this host and is also where
 * the operator's own serve would live. The probe never sends a prompt and never asks a model.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { resolveInvocation } from '../../../packages/typescript/adapter-api/src/invocation.ts';
import { HostProcessProvider } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 OpenCode probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 OpenCode probe requires its native Windows runner environment');
}

const dataDir = win32.join(root, 'opencode-data');
const recordPath = win32.join(root, 'serve-ownership.json');
mkdirSync(dataDir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'install.opencodeResolves',
  'port.assignedByRealBind',
  'start.serveBecameReachable',
  'start.listenerIdentified',
  'start.ownershipRecorded',
  'start.recordProvesTheLiveServe',
  'gracefulExit.leavesNoServeBehind',
  'crash.leavesTheServeListening',
  'restart.provesItsOwnServe',
  'restart.reclaimedAndRespawned',
  'stop.portFreed',
  'stop.noListenerRemains',
  'teardown.snapshotsSucceeded',
  'teardown.noSurvivingServeProcess',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();
const leaf = (path: string): string => win32.basename(path);

/** Let the OS assign the port by actually binding one. `--port` defaults to 4096, which is inside a
 *  Windows excluded range on this host — a bind there fails WSAEACCES before any conflict check —
 *  and is also where the operator's own serve would be listening. */
function assignPortByBind(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const assigned = server.port;
  server.stop(true);
  return assigned;
}

/** The listener state, insisting on a DEFINITE answer. `unknown` means the host would not say —
 *  which is not the same as absent and must never be recorded as one. Retried, then reported as
 *  what it is. */
async function settledListenerState(): Promise<'identified' | 'absent' | 'unknown'> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = hostProcesses.listener(port, { fresh: true });
    if (read.state !== 'unknown') return read.state;
    await Bun.sleep(750);
  }
  return 'unknown';
}

let port = 0;
let baseUrl = '';
let pidsBefore = new Set<number>();
let snapshotBefore: Awaited<ReturnType<typeof captureHostSnapshot>> = null;

/** Every pid this run spawned, so teardown can prove what is its own instead of assuming. */
const helperPids: number[] = [];

/** Run one broker lifetime as its own process and return the JSON report it wrote. */
async function runBroker(mode: 'start' | 'crash' | 'restart-stop'): Promise<Record<string, unknown>> {
  const helperPath = win32.join(import.meta.dir, 'phase6-opencode-broker.ts');
  const helperReport = win32.join(root, `broker-${mode}.json`);
  observations.helper = { path: leaf(helperPath), exists: existsSync(helperPath), runner: leaf(process.execPath) };
  // The helper's output goes to FILES, never to pipes this process holds. A serve that outlives its
  // broker inherits whatever handles it was given, and a pipe handle here is a pipe handle all the
  // way up: an orphan once held the staging runner's stdout open and wedged a finished run for
  // twenty minutes with its report already on disk. A file handle wedges nothing.
  const helperOut = win32.join(root, `broker-${mode}.out.log`);
  const helperErr = win32.join(root, `broker-${mode}.err.log`);
  const outFd = openSync(helperOut, 'w');
  const errFd = openSync(helperErr, 'w');
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, helperPath],
      stdin: 'ignore',
      stdout: outFd,
      stderr: errFd,
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_URL: baseUrl,
        OPENCODE_DATA: dataDir,
        COSYNCING_PHASE6_OC_RECORD: recordPath,
        COSYNCING_PHASE6_OC_REPORT: helperReport,
        COSYNCING_PHASE6_OC_MODE: mode,
      },
    });
    if (child.pid) helperPids.push(child.pid);

    // The report is a FILE, so the deadline covers the work rather than a pipe handshake.
    await Promise.race([child.exited, Bun.sleep(180_000)]);
    if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }

    if (!existsSync(helperReport)) {
      const tail = [helperErr, helperOut]
        .map((path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } })
        .find((text) => text.length > 0)?.split('\n').filter(Boolean).at(-1) ?? 'no output';
      throw new Error(`broker (${mode}) wrote no report (exit ${child.exitCode}): ${tail.slice(0, 300)}`);
    }
    return JSON.parse(readFileSync(helperReport, 'utf8')) as Record<string, unknown>;
  } finally {
    try { closeSync(outFd); } catch { /* already closed */ }
    try { closeSync(errFd); } catch { /* already closed */ }
  }
}

try {
  snapshotBefore = await captureHostSnapshot();
  pidsBefore = new Set((snapshotBefore?.processes ?? []).map((entry) => entry.pid));

  // 1. The launcher. This is the premise of the whole slice, so it is recorded rather than assumed:
  //    a batch shim means the spawn handle and the listener are different processes.
  const invocation = resolveInvocation('opencode');
  assertRequired('install.opencodeResolves', invocation !== null);
  if (!invocation) throw new Error('opencode did not resolve through the shared invocation boundary');
  const shimBody = invocation.kind === 'batch' ? readFileSync(invocation.script, 'utf8') : '';
  observations.invocation = {
    kind: invocation.kind,
    originalPath: leaf(invocation.originalPath),
    script: invocation.kind === 'batch' ? leaf(invocation.script) : undefined,
    // Batch has no exec: the shim CALLS the real executable, so the spawned pid is the shell.
    shimCallsAnExecutable: /\.exe"?\s*%\*/i.test(shimBody),
  };

  port = assignPortByBind();
  baseUrl = `http://127.0.0.1:${port}`;
  assertRequired('port.assignedByRealBind', port > 0);
  observations.port = { assignedByRealBind: port > 0, isTheOpencodeDefault: port === 4096 };
  if (port === 4096) note('the OS assigned the OpenCode default port; the probe would collide with an operator serve');

  // 2. One broker starts a serve and exits WITHOUT stopping it — a crash or a service restart, and
  //    the state a restarting broker actually meets.
  const first = await runBroker('start');
  observations.firstBroker = first;
  const listenerAfter = first.listenerAfter as { state?: string; pid?: number } | undefined;
  const recordAfter = first.recordAfter as { pid?: number } | null | undefined;
  assertRequired('start.serveBecameReachable', first.reachableAfter === true);
  assertRequired('start.listenerIdentified', listenerAfter?.state === 'identified');
  assertRequired('start.ownershipRecorded', Array.isArray(first.ownershipWrites) && (first.ownershipWrites as unknown[]).length > 0);
  // THE claim. `owned` is the product's own verdict on the serve it just started, from the record it
  // just wrote against the process actually holding the port.
  assertRequired('start.recordProvesTheLiveServe', first.verdictAfter === 'owned');
  observations.ownershipComparison = {
    spawnHandlePid: first.spawnHandlePid ?? null,
    recordedPid: recordAfter?.pid ?? null,
    listenerPid: listenerAfter?.pid ?? null,
    recordedPidIsTheSpawnHandle: recordAfter?.pid === first.spawnHandlePid,
    recordedPidHoldsTheListener: recordAfter?.pid !== undefined && recordAfter.pid === listenerAfter?.pid,
    verdict: first.verdictAfter,
  };
  if (first.verdictAfter !== 'owned') {
    note('the broker could not prove it started its own serve, so a restart preserves it as a stranger\'s '
      + 'and no later broker can ever stop it');
  }

  // 3. A graceful broker exit must leave nothing running: the module's exit teardown owns that, and
  //    on Windows it has to take the whole tree or the serve outlives the broker that started it.
  await Bun.sleep(1_000);
  const afterGraceful = await settledListenerState();
  observations.gracefulExit = { listenerState: afterGraceful };
  assertRequired('gracefulExit.leavesNoServeBehind', afterGraceful === 'absent');
  if (afterGraceful === 'identified') note('a serve outlived the broker that started it');
  if (afterGraceful === 'unknown') note('the host would not say whether a serve outlived the broker, so this run proves neither');

  // 4. Now the case the ownership record exists for: a broker that DIES without running any exit
  //    handler — a force-stopped service, a crash. The serve survives, and the next broker has to
  //    prove it is ours before it may touch it.
  const crashed = await runBroker('crash');
  observations.crashedBroker = crashed;
  await Bun.sleep(1_000);
  const afterCrash = await settledListenerState();
  observations.afterCrash = { listenerState: afterCrash };
  assertRequired('crash.leavesTheServeListening', afterCrash === 'identified');
  if (afterCrash === 'absent') note('the crash case did not leave a serve to reclaim, so the restart proves nothing');
  if (afterCrash === 'unknown') note('the host would not say whether the crashed broker left a serve, so the reclaim below proves nothing');

  // 5. The restart. `owned` here means reclaim-and-respawn; anything else means preserve, which is
  //    the orphan. A reclaim is told from a preserve by whether a NEW record was written.
  const second = await runBroker('restart-stop');
  observations.secondBroker = second;
  assertRequired('restart.provesItsOwnServe', second.verdictBefore === 'owned');
  assertRequired(
    'restart.reclaimedAndRespawned',
    Array.isArray(second.ownershipWrites) && (second.ownershipWrites as unknown[]).length > 0,
  );
  if (second.verdictBefore !== 'owned') {
    note('a restarting broker did not recognize the serve its predecessor started');
  }

  // 6. Stop, through the product's own stop.
  const afterStop = second.afterStop as { reachable?: boolean; listener?: { state?: string } } | undefined;
  assertRequired('stop.portFreed', afterStop?.reachable === false);
  assertRequired('stop.noListenerRemains', afterStop?.listener?.state === 'absent');
  if (afterStop?.reachable !== false) note('the port was still serving after the product stopped its serve');
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 200) };
  note('the OpenCode probe stopped early; observations recorded up to that point');
} finally {
  // Nothing this probe started may outlive it, including a serve the product could not prove it
  // owned. But "appeared during this run" is not proof of ownership, and this probe once acted as
  // if it were: it killed every opencode process absent from its opening snapshot, which on a host
  // the operator also uses means an unrelated TUI started at the wrong minute, and with two runs
  // overlapping it meant one run reaping the other's serve and then failing on the corpse.
  // A survivor is THIS run's only when the host says so: it holds the port this run bound, or it
  // descends from a process this run spawned. Anything else is reported and left alone — the same
  // rule the product itself follows, where unknown identity always preserves the process.
  await Bun.sleep(500);
  const listener = port ? hostProcesses.listener(port, { fresh: true }) : { state: 'absent' as const };
  const listenerPid = listener.state === 'identified' ? listener.pid : undefined;
  const isOurs = (pid: number): boolean => pid === listenerPid
    || helperPids.some((helper) => hostProcesses.descendsFrom(pid, helper) === 'yes');
  if (listenerPid !== undefined && !pidsBefore.has(listenerPid)) {
    terminateHostProcessTree(listenerPid, true);
    await Bun.sleep(1_000);
  }
  const snapshotAfter = await captureHostSnapshot();
  const appeared = (snapshotAfter?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && /^opencode(?:\.exe)?$/i.test(entry.name));
  const survivors = appeared.filter((entry) => isOurs(entry.pid));
  const unattributed = appeared.filter((entry) => !isOurs(entry.pid));
  // Remove EVERY serve this run started, not only the one still holding the port: a survivor is not
  // just untidy, it is a process the product promised it had reaped.
  const removedByProbe: number[] = [];
  for (const entry of survivors) {
    try { terminateHostProcessTree(entry.pid, true); removedByProbe.push(entry.pid); } catch { /* already gone */ }
  }
  if (removedByProbe.length) await Bun.sleep(1_000);
  const snapshotFinal = removedByProbe.length ? await captureHostSnapshot() : snapshotAfter;
  const stillThere = (snapshotFinal?.processes ?? []).filter((entry) =>
    !pidsBefore.has(entry.pid) && isOurs(entry.pid));
  const snapshotsSucceeded = snapshotBefore?.processesOk === true && snapshotAfter?.processesOk === true;
  observations.teardown = {
    snapshotsSucceeded,
    // A snapshot the probe could not take yields an empty survivor list, which reads exactly like a
    // clean teardown, so a successful snapshot is itself required at both ends.
    survivingServeProcesses: snapshotsSucceeded ? survivors.length : undefined,
    // Opencode processes that appeared during the run and are NOT attributable to it. Expected to be
    // zero: runs hold a host-wide lock, so a non-zero count means the operator started one, and it
    // is named here rather than silently folded into the product's result.
    unattributedOpencodeProcesses: snapshotsSucceeded ? unattributed.length : undefined,
    listenerHeldAtTeardown: listener.state === 'identified',
    removedByProbe: removedByProbe.length,
    leftOnTheHost: snapshotsSucceeded ? stillThere.length : undefined,
  };
  assertRequired('teardown.snapshotsSucceeded', snapshotsSucceeded);
  assertRequired('teardown.noSurvivingServeProcess', snapshotsSucceeded && survivors.length === 0);
  if (!snapshotsSucceeded) note('a process snapshot failed, so surviving serve processes are unknown');
  if (survivors.length) note('serve processes outlived the probe; the probe removed them from the host');
  if (stillThere.length) note('serve processes could not be removed and were left for the owner to inspect');
  if (unattributed.length) {
    note('opencode processes the probe could not attribute to itself were running; they were left alone');
  }

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'opencode-managed-serve-ownership',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'app Drive against a managed serve, and session create/send/abort through it',
      'terminal routing and TUI presence',
      'the upstream serve own storage location, which OPENCODE_DATA governs for the adapter but is '
      + 'not proven here to govern for the OpenCode CLI itself',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
}
