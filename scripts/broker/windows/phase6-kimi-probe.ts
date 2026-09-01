#!/usr/bin/env bun
/**
 * Phase 6 Kimi slice 1 — managed-host ownership of `kimi web` on native Windows.
 *
 * Kimi is the agent whose Windows story is entirely about the MANAGED HOST. The broker does not
 * spawn a per-session child here; it starts one long-lived `kimi web` server, proves that server is
 * the one now serving, records ownership durably, and must later be able to prove the SAME server
 * is still its own before it signals it. Every one of those steps compares process identities, and
 * on Windows `kimi` resolves through a `kimi.cmd` batch shim — so the pid the broker spawns is
 * `cmd.exe` and the pid Kimi publishes in its own instance registry is a node grandchild. That gap
 * is what this slice measures. Phase 0 flagged it as the open question in exactly those words:
 * "the registry `pid` is the node child of the `kimi.cmd` shim (not the shim pid)".
 *
 * What is checked, against a real `kimi web` started by the product's own code path:
 *
 *   - `kimi` resolves through the shared invocation boundary to a batch shim, establishing the
 *     two-pid precondition rather than assuming it.
 *   - a default-constructed adapter resolves an ABSOLUTE home on this platform. `resolveKimiHome`
 *     falls back to a homeDir the adapter reads from `process.env.HOME`, which Windows does not
 *     set, and a relative home silently reads a registry that is not the user's.
 *   - `ensureManagedHost` starts the host and proves it is the one serving (`servingProven`).
 *   - the durable ownership record still classifies as `owned` when re-read against the pid the
 *     registry publishes — the proof the stop path requires before it signals anything.
 *   - Observe reaches the started server through its per-home token.
 *   - the release path stops the host, frees its port, and leaves the registry with no live entry.
 *
 * No model is ever asked anything and no session is created, so no credentials are spent. The
 * per-home server token is read only by the adapter itself; it is never printed, copied, or
 * reported. Counts and booleans only — no session identifiers, no port-holder names, no paths
 * outside the disposable root.
 *
 * The operator may be running their own `kimi web` against their real home. That server is a
 * FOREIGN WRITER. This probe uses a disposable KIMI_CODE_HOME and a disposable COSYNCING_HOME, so
 * its registry, its ownership record, and its port are all its own; it only ever terminates pids it
 * can attribute to the host it started, and it never scans for kimi processes to tidy up.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { resolveInvocation } from '../../../packages/typescript/adapter-api/src/invocation.ts';
import {
  classifyManagedHost,
  defaultManagedHostEffects,
  ensureManagedHost,
  managedHostStore,
  readLiveProcess,
  readManagedHostOwnership,
  releaseManagedHost,
} from '../../../packages/typescript/broker/src/runtime/managed-host.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Kimi probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Kimi probe requires its native Windows runner environment');
}

const kimiHome = win32.join(root, 'kimi-home');
const stateHome = win32.join(root, 'cosyncing-home');
for (const dir of [kimiHome, stateHome]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'install.kimiResolves',
  'install.resolvesThroughABatchShim',
  'home.absoluteWithoutPosixHomeVariable',
  'start.hostStarted',
  'start.provedItIsTheProcessNowServing',
  'registry.publishesADescendantOfTheSpawnedChild',
  'ownership.recordClassifiesOwnedAgainstTheServingPid',
  'observe.serverReachableThroughItsHomeToken',
  'release.hostStopped',
  'release.portFreed',
  'release.registryHasNoLiveInstance',
  'teardown.noSurvivingHostProcess',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();
/** Every pid this probe may terminate: the spawned child and whatever the registry published. */
const ourPids = new Set<number>();
let servingPort: number | undefined;

/** The live instance records in the disposable registry, as counts and pids only. */
function readDisposableRegistry(): { files: number; pids: number[]; ports: number[] } {
  const dir = win32.join(kimiHome, 'server', 'instances');
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return { files: 0, pids: [], ports: [] }; }
  const pids: number[] = [];
  const ports: number[] = [];
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(readFileSync(win32.join(dir, name), 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.pid === 'number') pids.push(record.pid);
      if (typeof record.port === 'number') ports.push(record.port);
    } catch { /* a partially written record is not a fact */ }
  }
  return { files: names.length, pids, ports };
}

try {
  const snapshotBefore = await captureHostSnapshot();

  // ── Install shape ────────────────────────────────────────────────────────────────────────────
  // The two-pid precondition is MEASURED, not assumed: if a future Kimi ships a real `kimi.exe`
  // the rest of this slice still holds, and the report should say which shape it saw.
  const invocation = resolveInvocation('kimi', { env: process.env, platform: 'win32' });
  assertRequired('install.kimiResolves', invocation !== null);
  if (!invocation) throw new Error('kimi did not resolve through the shared invocation boundary');
  const target = invocation.kind === 'native' ? invocation.executable : invocation.script;
  const leaf = win32.basename(target).toLowerCase();
  observations.install = { kind: invocation.kind, leaf };
  assertRequired('install.resolvesThroughABatchShim', invocation.kind === 'batch');

  // ── Home resolution on a platform with no HOME ───────────────────────────────────────────────
  // Constructed the way the broker constructs it — no injected homeDir — but with KIMI_CODE_HOME
  // removed, which is the ordinary operator configuration. What comes back is the home every
  // derived path is built from, so a relative answer here is a registry read against the wrong
  // directory, not a cosmetic defect.
  const { KimiAdapter } = await import('../../../packages/typescript/adapters/kimi/src/implementation.ts');
  const bareEnv: Record<string, string | undefined> = { ...process.env };
  delete bareEnv.KIMI_CODE_HOME;
  const bareDescriptor = await new KimiAdapter({ env: bareEnv }).describeManagedHost();
  const defaultHome = bareDescriptor?.identityKey;
  const defaultHomeAbsolute = typeof defaultHome === 'string' && win32.isAbsolute(defaultHome);
  observations.home = {
    posixHomeVariableSet: typeof process.env.HOME === 'string' && process.env.HOME.length > 0,
    userProfileSet: typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE.length > 0,
    defaultHomeAbsolute,
    defaultHomeSegments: typeof defaultHome === 'string' ? defaultHome.split(/[\\/]/).length : 0,
  };
  assertRequired('home.absoluteWithoutPosixHomeVariable', defaultHomeAbsolute);
  if (!defaultHomeAbsolute) {
    note('a default-constructed Kimi adapter resolved a RELATIVE home on Windows: the adapter takes '
      + 'its home directory from process.env.HOME, which Windows does not set, so every derived path '
      + '— instance registry, server token, session store — is resolved against the broker working '
      + 'directory instead of the user profile');
  }

  // ── Start the managed host ───────────────────────────────────────────────────────────────────
  const adapter = new KimiAdapter({
    homeDir: root,
    env: { ...process.env, KIMI_CODE_HOME: kimiHome },
  });
  const effects = defaultManagedHostEffects();
  const store = managedHostStore(stateHome);
  const gatedEnv = { ...process.env, KIMI_CODE_HOME: kimiHome, COSYNCING_KIMI_MANAGED_HOST: '1' };

  const startedAt = Date.now();
  const started = await ensureManagedHost(adapter, effects, store, gatedEnv);
  const startMs = Date.now() - startedAt;
  const spawnPid = started.action === 'started' ? started.pid : undefined;
  if (spawnPid) ourPids.add(spawnPid);
  // The host's own output is reported by SHAPE ONLY. `kimi web` prints the URL it is serving, and
  // that URL carries the per-home server token — so the text never enters this report, and the two
  // facts that actually help diagnose a failed start (did it say anything, did it get as far as
  // announcing a loopback address) are extracted as a length and a boolean.
  const capturedOutput = 'capturedOutput' in started ? started.capturedOutput : undefined;
  observations.start = {
    action: started.action,
    elapsedMs: startMs,
    servingProven: started.action === 'started' ? started.servingProven : undefined,
    detailCode: 'detailCode' in started ? started.detailCode : undefined,
    verdict: 'verdict' in started ? started.verdict : undefined,
    outputBytes: typeof capturedOutput === 'string' ? capturedOutput.length : 0,
    announcedALoopbackAddress: typeof capturedOutput === 'string'
      && /https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(capturedOutput),
  };
  assertRequired('start.hostStarted', started.action === 'started');
  assertRequired('start.provedItIsTheProcessNowServing', started.action === 'started' && started.servingProven === true);
  if (started.action === 'already-serving') {
    note('the managed start reported `already-serving` for a host it had just spawned into an empty '
      + 'disposable home: on Windows the spawned pid is the `kimi.cmd` shim and the pid Kimi '
      + 'publishes in its registry is that shim’s node child, so the identity comparison that '
      + 'decides "is this the process now serving" can never hold, and the branch that fires stops '
      + 'the host this broker just started');
  } else if (started.action === 'start-failed') {
    note(`the managed Kimi host did not start on Windows (${'detailCode' in started ? started.detailCode : 'unknown'})`);
  } else if (started.action === 'started' && started.servingProven !== true) {
    note('the managed Kimi host started but could not be proven to be the process now serving');
  }

  // ── The two-pid shape, measured ──────────────────────────────────────────────────────────────
  const registry = readDisposableRegistry();
  // Safe to adopt UNCONDITIONALLY here, and the reason is the disposable home rather than the
  // start outcome. These pids come from `<root>/kimi-home/server/instances`, a directory this run
  // created; only a server launched with this run's KIMI_CODE_HOME writes there, so anything listed
  // is ours even when the start failed — which is exactly when it still needs reaping.
  //
  // The contrast worth keeping: a well-known PORT is the opposite situation. Anything on the machine
  // may hold one, so a port holder may only be adopted once proven to be the process we started.
  // The DSH managed probe learned that the expensive way.
  for (const pid of registry.pids) ourPids.add(pid);
  servingPort = registry.ports[0];
  const registryPid = registry.pids[0];
  // Measured from a LIVE snapshot's parent chain rather than from the start outcome's pid.
  //
  // The outcome's pid is the answer under test: once the engine adopts the serving process it
  // reports that pid, so comparing the registry pid against it would compare a number with itself
  // and pass no matter what. The parent chain is independent of the fix — it describes the process
  // tree Windows actually built — so this reads the same before and after.
  const liveSnapshot = registryPid ? await captureHostSnapshot() : null;
  const byPid = new Map((liveSnapshot?.processes ?? []).map((entry) => [entry.pid, entry]));
  const registryParent = registryPid ? byPid.get(registryPid)?.parentPid : undefined;
  const parentName = registryParent ? byPid.get(registryParent)?.name.toLowerCase() : undefined;
  const underShim = parentName === 'cmd.exe';
  observations.registry = {
    files: registry.files,
    livePids: registry.pids.length,
    snapshotReadable: liveSnapshot?.processesOk === true,
    registryPidIsTheAdoptedPid: !!registryPid && !!spawnPid && registryPid === spawnPid,
    registryPidParentIsABatchShim: underShim,
    portPublished: typeof servingPort === 'number',
  };
  assertRequired('registry.publishesADescendantOfTheSpawnedChild', underShim);
  if (registryPid && liveSnapshot?.processesOk !== true) {
    note('this machine would not say what the registry pid runs under; that is an unreadable process '
      + 'table, not a proven absence of the relationship');
  }

  // ── Ownership, re-proved the way the stop path proves it ─────────────────────────────────────
  const record = readManagedHostOwnership('kimi', stateHome);
  const servingVerdict = record && registryPid
    ? classifyManagedHost(record, readLiveProcess(registryPid, { fresh: true }), record.identityKey)
    : 'absent';
  const spawnVerdict = record && spawnPid
    ? classifyManagedHost(record, readLiveProcess(spawnPid, { fresh: true }), record.identityKey)
    : 'absent';
  // `null` where there is nothing to compare against, never `false`: a start that never produced a
  // spawn pid has not shown that the record names a different process, and reporting that absence
  // as a negative fact would read as evidence it is not.
  observations.ownership = {
    recordWritten: !!record,
    recordPidIsTheSpawnedChild: record && spawnPid ? record.pid === spawnPid : null,
    recordPidIsTheServingProcess: record && registryPid ? record.pid === registryPid : null,
    verdictAgainstServingPid: registryPid ? servingVerdict : null,
    verdictAgainstSpawnedPid: spawnPid ? spawnVerdict : null,
  };
  assertRequired('ownership.recordClassifiesOwnedAgainstTheServingPid', servingVerdict === 'owned');
  if (record && registryPid && servingVerdict !== 'owned') {
    note('the durable ownership record does not classify as `owned` against the pid Kimi publishes '
      + 'as its server: the record was written from the spawned `kimi.cmd` pid, so a later broker '
      + 'asking "is the process serving this home mine?" is told it is a stranger and declines to '
      + 'stop it — the managed host becomes unreapable');
  }

  // ── Observe ──────────────────────────────────────────────────────────────────────────────────
  // Counts only. The per-home token is read by the adapter and never leaves it.
  let reachable = false;
  let discovered = -1;
  try {
    reachable = await adapter.isAvailable();
    if (reachable) discovered = (await adapter.discoverSessions()).length;
  } catch (error) {
    note(`Observe could not reach the started Kimi server: ${String(error).split('\n')[0]!.slice(0, 160)}`);
  }
  observations.observe = { reachable, sessionsDiscovered: discovered };
  assertRequired('observe.serverReachableThroughItsHomeToken', reachable);

  // ── Release ──────────────────────────────────────────────────────────────────────────────────
  const released = await releaseManagedHost(adapter, effects, store);
  await Bun.sleep(1_500);
  const afterRegistry = readDisposableRegistry();
  const liveAfter = afterRegistry.pids.filter((pid) => readLiveProcess(pid, { fresh: true }).state === 'running');
  // `undefined` where no port was ever published — NOT 'absent'. A run whose host never registered
  // has not shown that a port was freed, and scoring that as a pass is how a start that failed
  // outright reports a clean release.
  const portHeld = typeof servingPort === 'number'
    ? hostProcesses.listener(servingPort, { fresh: true }).state
    : undefined;
  observations.release = {
    action: released.action,
    escalated: released.action === 'stopped' ? released.escalated : undefined,
    verdict: 'verdict' in released ? released.verdict : undefined,
    registryFilesAfter: afterRegistry.files,
    liveRegistryPidsAfter: liveAfter.length,
    portHolderAfter: portHeld ?? null,
    portWasEverPublished: typeof servingPort === 'number',
  };
  assertRequired('release.hostStopped', released.action === 'stopped' || released.action === 'already-gone');
  assertRequired('release.portFreed', portHeld === 'absent');
  if (portHeld === undefined) note('no serving port was ever published, so this run proves nothing about the port being freed');
  assertRequired('release.registryHasNoLiveInstance', liveAfter.length === 0);
  if (released.action === 'preserved') {
    note('the release path PRESERVED the host this probe started, because it could not prove the '
      + 'running process was its own');
  }

  observations.snapshots = { before: snapshotBefore?.processesOk === true };
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 300) };
  note('the Kimi probe stopped early; observations recorded up to that point');
} finally {
  // Only pids this probe can attribute to the host it started: the child it spawned, and whatever
  // that child's own registry published. The operator's `kimi web` is never searched for.
  let survivors = 0;
  for (const pid of ourPids) {
    if (readLiveProcess(pid, { fresh: true }).state !== 'running') continue;
    try { terminateHostProcessTree(pid, true); } catch { /* already gone */ }
  }
  if (ourPids.size > 0) await Bun.sleep(1_500);
  for (const pid of ourPids) if (readLiveProcess(pid, { fresh: true }).state === 'running') survivors += 1;
  const snapshotAfter = await captureHostSnapshot();
  observations.teardown = {
    attributedPids: ourPids.size,
    survivingAfterTeardown: survivors,
    snapshotSucceeded: snapshotAfter?.processesOk === true,
  };
  assertRequired('teardown.noSurvivingHostProcess', survivors === 0);
  if (survivors > 0) note('a Kimi host process this probe started could not be removed and was left for the owner to inspect');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'kimi-managed-host-ownership',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'a driven Kimi turn: no session is created and no prompt is sent, so nothing here claims model '
      + 'interaction, approvals, or questions on Windows',
      'Drive, which is gated off by COSYNCING_KIMI_DRIVE and is a separate slice',
      'attaching a session created by the operator’s own Kimi server, which stays a foreign writer',
      'the official-installer fallback path (`<home>/.kimi-code/bin/kimi`, with no Windows executable '
      + 'suffix) in both the adapter and its diagnostics: `kimi` is on PATH for an npm install, so '
      + 'this run never reached that branch and has no evidence for what the Windows installer lays down',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
  process.exit(0);
}
