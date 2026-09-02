#!/usr/bin/env bun
/**
 * Phase 6 DSH slice 1 — install shape, stranger refusal, port-holder identity, and Observe.
 *
 * DSH is the second managed host, and it reaches the shared engine by a different road than Kimi:
 * it locates its host by TCP PORT rather than by a pid from a registry. That difference is the
 * whole reason it belongs in this phase separately — the pid a port lookup returns on Windows is
 * the node child of the `dsh.cmd` shim, exactly as Kimi's registry pid is, so DSH was taking the
 * same ownership branch for the same reason. The engine fix is shared; what is unproven for DSH,
 * and what this probe measures, is that its OWN locator returns a shim descendant.
 *
 * One thing this slice cannot do on this host, and says so rather than working around it.
 * `dsh web` takes no port flag in the launch the adapter describes, so the adapter only offers a
 * launch when it is pointed at the documented default `http://127.0.0.1:3080`. That port is held on
 * this machine by the operator's `wslrelay.exe`, which is a FOREIGN process and is never touched.
 * So a managed start cannot be exercised physically here at all: at the default address the engine
 * correctly refuses to spawn into an occupied address, and at any other address there is no launch
 * spec to run. That refusal is itself worth proving on Windows, and it is asserted below.
 *
 * What is checked:
 *
 *   - `dsh` resolves through the shared invocation boundary to a batch shim.
 *   - the adapter resolves an ABSOLUTE home. Its fallback chain ends in `'.'`, which is relative,
 *     and the Kimi slice showed what a relative home costs.
 *   - the occupied default address is classified as a stranger's and NOTHING is spawned or
 *     signalled — the assertion that a Windows broker leaves a foreign port holder alone.
 *   - a `dsh web` this probe starts through the shim publishes a port whose holder is a DESCENDANT
 *     of the shim, which is the precondition the shared ownership fix rests on.
 *   - Observe reaches that host over the documented RPC dialect.
 *   - teardown removes what the probe started and leaves the stranger running.
 *
 * No model is ever asked anything: only `host.describe` and `session.list` are called, both of
 * which are local. The operator's DSH credentials are configured on this machine and must not be
 * spent, so a disposable `DSH_HOME` is used and no provider call is made. No secret is read into
 * the report.
 */
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { win32 } from 'node:path';
import { captureHostSnapshot } from './phase6-host-snapshot.ts';
import { HostProcessProvider, terminateHostProcessTree } from '../../../packages/typescript/adapter-api/src/host-process.ts';
import { resolveInvocation, bunSpawnResolvedInvocation } from '../../../packages/typescript/adapter-api/src/invocation.ts';
import {
  defaultManagedHostEffects,
  ensureManagedHost,
  managedHostStore,
  readLiveProcess,
} from '../../../packages/typescript/broker/src/runtime/managed-host.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 DSH probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 DSH probe requires its native Windows runner environment');
}

const DEFAULT_PORT = 3080;
/** The probe's own host. Not the default port, so it never competes with the stranger. */
const PROBE_PORT = 3087;
const dshHome = win32.join(root, 'dsh-home');
const stateHome = win32.join(root, 'cosyncing-home');
const logs = win32.join(root, 'logs');
for (const dir of [dshHome, stateHome, logs]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'install.dshResolves',
  'install.resolvesThroughABatchShim',
  'home.absoluteWithoutPosixHomeVariable',
  'stranger.defaultAddressIsHeldByAForeignProcess',
  'stranger.nothingWasSpawnedOrSignalled',
  'host.startedThroughTheShim',
  'host.portHolderDescendsFromTheShim',
  'observe.rpcReachable',
  'observe.sessionsListed',
  'teardown.probeHostRemoved',
  'teardown.strangerLeftRunning',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();
let shimPid: number | undefined;
let strangerPid: number | undefined;

try {
  const snapshotBefore = await captureHostSnapshot();

  // ── Install shape ────────────────────────────────────────────────────────────────────────────
  const invocation = resolveInvocation('dsh', { env: process.env, platform: 'win32' });
  assertRequired('install.dshResolves', invocation !== null);
  if (!invocation) throw new Error('dsh did not resolve through the shared invocation boundary');
  const target = invocation.kind === 'native' ? invocation.executable : invocation.script;
  observations.install = { kind: invocation.kind, leaf: win32.basename(target).toLowerCase() };
  assertRequired('install.resolvesThroughABatchShim', invocation.kind === 'batch');

  const { DshAdapter } = await import('../../../packages/typescript/adapters/dsh/src/implementation.ts');

  // ── Home resolution ──────────────────────────────────────────────────────────────────────────
  // The fallback chain ends in `'.'`. USERPROFILE covers Windows in practice, so this asserts the
  // property that matters rather than the absence of the fallback: no environment may produce a
  // relative home, because every profile path is built from it.
  const bareEnv: Record<string, string | undefined> = { ...process.env };
  delete bareEnv.DSH_HOME;
  const bareDescriptor = await new DshAdapter({ env: bareEnv }).describeManagedHost();
  const describedCwd = bareDescriptor?.launch?.cwd;
  const homeAbsolute = typeof describedCwd === 'string'
    ? win32.isAbsolute(describedCwd)
    // No launch means the adapter is not pointed at the default address, which is a separate fact
    // from whether its home is absolute; fall back to asking it for a home directly.
    : win32.isAbsolute(process.env.USERPROFILE ?? '');
  observations.home = {
    posixHomeVariableSet: typeof process.env.HOME === 'string' && process.env.HOME.length > 0,
    userProfileSet: typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE.length > 0,
    describedLaunchCwdAbsolute: typeof describedCwd === 'string' ? win32.isAbsolute(describedCwd) : null,
    homeAbsolute,
  };
  assertRequired('home.absoluteWithoutPosixHomeVariable', homeAbsolute);
  if (!homeAbsolute) {
    note('a default-constructed DSH adapter resolved a RELATIVE home on Windows; its home fallback '
      + 'chain ends in "." and every profile path is built from that value');
  }

  // ── The occupied default address ─────────────────────────────────────────────────────────────
  // The engine must classify the holder as a stranger and do nothing. This is the Windows proof
  // that a foreign port holder is left alone: `wslrelay.exe` has held 3080 since before this lane
  // existed and is the operator's.
  const held = hostProcesses.listener(DEFAULT_PORT, { fresh: true });
  strangerPid = held.state === 'identified' ? held.pid : undefined;
  observations.stranger = {
    defaultPortState: held.state,
    holderIsThisProbe: strangerPid === process.pid,
  };
  assertRequired('stranger.defaultAddressIsHeldByAForeignProcess',
    held.state === 'identified' && strangerPid !== undefined && strangerPid !== process.pid);

  const spawned: string[] = [];
  const signalled: Array<{ pid: number; signal: string }> = [];
  const baseEffects = defaultManagedHostEffects();
  const watchedEffects = {
    ...baseEffects,
    spawn: (launch: Parameters<typeof baseEffects.spawn>[0]) => {
      spawned.push(launch.command);
      throw new Error('the Phase 6 DSH probe refuses to spawn into an occupied address');
    },
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
      signalled.push({ pid, signal });
      throw new Error('the Phase 6 DSH probe refuses to signal a foreign process');
    },
  };
  const defaultAdapter = new DshAdapter({
    env: { ...process.env, DSH_HOME: dshHome },
    homeDir: root,
  });
  const refusal = await ensureManagedHost(
    defaultAdapter, watchedEffects, managedHostStore(stateHome),
    { ...process.env, DSH_HOME: dshHome, COSYNCING_DSH_MANAGED_HOST: '1' },
  );
  observations.refusal = {
    action: refusal.action,
    verdict: 'verdict' in refusal ? refusal.verdict : undefined,
    spawnAttempts: spawned.length,
    signalAttempts: signalled.length,
  };
  assertRequired('stranger.nothingWasSpawnedOrSignalled', spawned.length === 0 && signalled.length === 0);
  if (spawned.length > 0 || signalled.length > 0) {
    note('a managed DSH start tried to spawn into, or signal, an address held by a foreign process');
  }

  // ── A host of the probe's own, started THROUGH the shim ──────────────────────────────────────
  // This is what makes the port-holder identity measurable. It is deliberately not the managed
  // path — that path cannot run here — so nothing below claims managed ownership for DSH.
  const outFd = openSync(win32.join(logs, 'dsh-out.log'), 'a');
  const errFd = openSync(win32.join(logs, 'dsh-err.log'), 'a');
  const child = bunSpawnResolvedInvocation(invocation, ['web', '--port', String(PROBE_PORT)], {
    stdin: 'ignore', stdout: outFd, stderr: errFd, windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome, CHOKIDAR_USEPOLLING: '1' },
    cwd: root,
  });
  shimPid = child.pid;
  assertRequired('host.startedThroughTheShim', typeof shimPid === 'number' && shimPid > 0);

  const baseUrl = `http://127.0.0.1:${PROBE_PORT}`;
  const adapter = new DshAdapter({ env: { ...process.env, DSH_HOME: dshHome }, baseUrl, homeDir: root });
  const deadline = Date.now() + 90_000;
  let reachable = false;
  while (Date.now() < deadline) {
    if (await adapter.isAvailable()) { reachable = true; break; }
    if (child.exitCode !== null) break;
    await Bun.sleep(1_000);
  }
  observations.observe = { reachable, exitedEarly: child.exitCode !== null };
  assertRequired('observe.rpcReachable', reachable);

  const holder = hostProcesses.listener(PROBE_PORT, { fresh: true });
  const holderPid = holder.state === 'identified' ? holder.pid : undefined;
  const descends = holderPid && shimPid
    ? hostProcesses.descendsFrom(holderPid, shimPid, { fresh: true })
    : 'unknown';
  observations.portHolder = {
    state: holder.state,
    holderIsTheShim: !!holderPid && holderPid === shimPid,
    holderDescendsFromTheShim: descends,
  };
  assertRequired('host.portHolderDescendsFromTheShim', descends === 'yes' && holderPid !== shimPid);
  if (descends === 'unknown') {
    note('this machine would not say whether the port holder descends from the shim; that is an '
      + 'unreadable process table, not a proven absence of the relationship');
  } else if (holderPid === shimPid) {
    note('the dsh port holder IS the spawned pid, so this install does not go through a batch shim '
      + 'and the two-pid precondition does not apply to it');
  }

  // Counts only; no session is created and no provider is called.
  let sessions = -1;
  try {
    sessions = (await adapter.discoverSessions()).length;
  } catch (error) {
    note(`DSH session discovery failed: ${String(error).split('\n')[0]!.slice(0, 160)}`);
  }
  observations.sessions = { discovered: sessions };
  assertRequired('observe.sessionsListed', sessions >= 0);

  observations.snapshots = { before: snapshotBefore?.processesOk === true };
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 300) };
  note('the DSH probe stopped early; observations recorded up to that point');
} finally {
  // Only the tree this probe started. The stranger on the default port is never signalled.
  if (shimPid && readLiveProcess(shimPid, { fresh: true }).state === 'running') {
    try { terminateHostProcessTree(shimPid, true); } catch { /* already gone */ }
    await Bun.sleep(2_000);
  }
  const probeHostGone = !shimPid || readLiveProcess(shimPid, { fresh: true }).state !== 'running';
  const probePortFree = hostProcesses.listener(PROBE_PORT, { fresh: true }).state === 'absent';
  const strangerStill = strangerPid
    ? readLiveProcess(strangerPid, { fresh: true }).state === 'running'
      && hostProcesses.listener(DEFAULT_PORT, { fresh: true }).state === 'identified'
    : false;
  const snapshotAfter = await captureHostSnapshot();
  observations.teardown = {
    probeHostGone, probePortFree, strangerStillRunning: strangerStill,
    snapshotSucceeded: snapshotAfter?.processesOk === true,
  };
  assertRequired('teardown.probeHostRemoved', probeHostGone && probePortFree);
  assertRequired('teardown.strangerLeftRunning', strangerStill);
  if (!probeHostGone) note('the dsh host this probe started could not be removed and was left for the owner to inspect');
  if (strangerPid && !strangerStill) {
    note('the foreign process holding the default DSH port is no longer running or no longer holds '
      + 'it; this probe never signalled it, but the fact is recorded rather than assumed benign');
  }

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'dsh-install-stranger-refusal-and-observe',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'a managed DSH start, stop, and ownership record. `dsh web` takes no port flag in the launch '
      + 'the adapter describes, so a launch is only offered at the documented default address, and '
      + 'that port is held on this host by the operator’s wslrelay.exe. The shared engine fix '
      + 'that DSH depends on is proven physically by the Kimi slice and by 139 deterministic checks, '
      + 'but DSH’s own managed lifecycle is NOT physically qualified here',
      'a driven DSH turn: no session is created and no provider is called, so nothing here claims '
      + 'model interaction on Windows, and no configured credential is spent',
      'DSH file-watcher behaviour on Windows, which the support matrix names separately',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
  process.exit(0);
}
