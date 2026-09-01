#!/usr/bin/env bun
/**
 * Phase 6 DSH slice 2 — the managed host lifecycle on native Windows.
 *
 * Slice 1 could not run this, because the launch the adapter described took no port flag and so was
 * only offered at the documented default `http://127.0.0.1:3080` — an address held on this host by
 * a WSL-side `dsh web` forwarded by `wslrelay.exe`. That restriction is now gone: `--port` is
 * documented by `dsh --profile web --help` and the descriptor names the port it was described for,
 * so a managed host can be started anywhere on loopback.
 *
 * This probe therefore runs on a NON-DEFAULT port, and that is a second thing worth proving rather
 * than a workaround. It means the trace never contends with whatever holds 3080, and it exercises
 * the case an operator hits whenever the default is taken: the port the descriptor advertises, the
 * port the child is told to serve, the port the locator watches, and the port ownership is proved
 * against all have to be the same number, and nothing may quietly fall back to 3080.
 *
 * What is checked, against a real `dsh web` started by the product's own managed path:
 *
 *   - the address is genuinely EMPTY first. A managed start that ran while somebody still held the
 *     port would prove nothing about starting, so absence is asserted rather than assumed.
 *   - `ensureManagedHost` starts the host and proves it is the one serving, which on Windows means
 *     adopting the port holder underneath the `dsh.cmd` shim.
 *   - the durable ownership record classifies `owned` against the pid that holds the port — the
 *     proof the stop path requires before it signals anything.
 *   - Observe reaches the started host over the documented RPC dialect.
 *   - release stops it, frees the port, and leaves nothing behind.
 *
 * No model is ever asked anything: only `host.describe` and `session.list`, both local. The
 * operator's real DSH credentials are configured on this machine and are neither spent nor read; a
 * disposable DSH_HOME and COSYNCING_HOME keep the profile, the ownership record, and the config
 * root separate from theirs.
 *
 * This probe binds the DEFAULT port, so it must never run beside anything else that wants it.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
  if (!value) throw new Error(`Phase 6 DSH managed probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 DSH managed probe requires its native Windows runner environment');
}

/**
 * Deliberately NOT dsh's documented default.
 *
 * Two reasons, and the second is the point of the slice: the default is contended on this host, and
 * a managed host that only ever ran on the default would not have shown that the configured port is
 * honoured end to end.
 */
const MANAGED_PORT: number = 3091;
const BASE_URL = `http://127.0.0.1:${MANAGED_PORT}`;
const DSH_DOCUMENTED_DEFAULT_PORT: number = 3080;
const dshHome = win32.join(root, 'dsh-home');
const stateHome = win32.join(root, 'cosyncing-home');
for (const dir of [dshHome, stateHome]) mkdirSync(dir, { recursive: true });

const observations: Record<string, unknown> = {};
const findings: string[] = [];
const note = (message: string): void => { if (!findings.includes(message)) findings.push(message); };

const REQUIRED_ASSERTIONS = [
  'precondition.configuredAddressIsEmpty',
  'port.theDocumentedDefaultWasNeverTaken',
  'install.resolvesThroughABatchShim',
  'start.hostStarted',
  'start.provedItIsTheProcessNowServing',
  'start.adoptedThePortHolderUnderTheShim',
  'ownership.recordClassifiesOwnedAgainstTheServingPid',
  'observe.rpcReachable',
  'observe.sessionsListed',
  'release.hostStopped',
  'release.portFreed',
  'teardown.noSurvivingHostProcess',
  'cleanup.disposableRootRemoved',
] as const;
const required: Record<string, boolean> = {};
const assertRequired = (name: (typeof REQUIRED_ASSERTIONS)[number], held: boolean): boolean => {
  required[name] = held;
  return held;
};

const hostProcesses = new HostProcessProvider();
const ourPids = new Set<number>();

try {
  const snapshotBefore = await captureHostSnapshot();

  // ── The address must be empty BEFORE anything starts ─────────────────────────────────────────
  const before = hostProcesses.listener(MANAGED_PORT, { fresh: true });
  // Recorded so the end of the run can show the documented default was left exactly as it was
  // found — whether that is empty or held by something of the operator's.
  const defaultBefore = hostProcesses.listener(DSH_DOCUMENTED_DEFAULT_PORT, { fresh: true }).state;
  observations.precondition = { configuredPortState: before.state, documentedDefaultBefore: defaultBefore };
  assertRequired('precondition.configuredAddressIsEmpty', before.state === 'absent');
  if (before.state !== 'absent') {
    note(`the configured DSH address was ${before.state} before the run, so nothing here is a proof `
      + 'about starting a host into an empty address');
  }

  const invocation = resolveInvocation('dsh', { env: process.env, platform: 'win32' });
  observations.install = { kind: invocation?.kind };
  assertRequired('install.resolvesThroughABatchShim', invocation?.kind === 'batch');

  // ── Start through the product's own managed path ─────────────────────────────────────────────
  const { DshAdapter } = await import('../../../packages/typescript/adapters/dsh/src/implementation.ts');
  const adapter = new DshAdapter({
    env: { ...process.env, DSH_HOME: dshHome },
    baseUrl: BASE_URL,
    homeDir: root,
  });
  const effects = defaultManagedHostEffects();
  const store = managedHostStore(stateHome);

  const startedAt = Date.now();
  const started = await ensureManagedHost(adapter, effects, store, {
    ...process.env, DSH_HOME: dshHome, COSYNCING_DSH_MANAGED_HOST: '1',
  });
  const adoptedPid = started.action === 'started' ? started.pid : undefined;
  if (adoptedPid) ourPids.add(adoptedPid);
  const capturedOutput = 'capturedOutput' in started ? started.capturedOutput : undefined;
  observations.start = {
    action: started.action,
    elapsedMs: Date.now() - startedAt,
    servingProven: started.action === 'started' ? started.servingProven : undefined,
    detailCode: 'detailCode' in started ? started.detailCode : undefined,
    verdict: 'verdict' in started ? started.verdict : undefined,
    outputBytes: typeof capturedOutput === 'string' ? capturedOutput.length : 0,
    // The host's own output is CLASSIFIED, never quoted. A failed start has to be diagnosable from
    // a report that carries no host text, so a fixed set of markers is matched and only which ones
    // hit is recorded.
    outputMarkers: typeof capturedOutput === 'string'
      ? Object.entries({
        usage: /\busage:/i,
        unknownOption: /unknown option|unrecognized|unexpected argument/i,
        addressInUse: /EADDRINUSE|address already in use/i,
        permission: /EACCES|EPERM|access is denied/i,
        notRecognized: /is not recognized as an internal or external command/i,
        uncPath: /UNC paths are not supported/i,
        moduleNotFound: /MODULE_NOT_FOUND|cannot find module/i,
        profile: /profile/i,
        listening: /listening|ready|serving/i,
      }).filter(([, pattern]) => pattern.test(capturedOutput)).map(([name]) => name)
      : [],
  };
  assertRequired('start.hostStarted', started.action === 'started');
  assertRequired('start.provedItIsTheProcessNowServing',
    started.action === 'started' && started.servingProven === true);
  if (started.action !== 'started') {
    note(`the managed DSH host did not start on Windows (${started.action})`);
  }

  // The adopted pid must be the PORT HOLDER, and that holder must sit under a batch shim — the
  // two-pid shape slice 1 measured, now on the managed path rather than a probe-started host.
  const holder = hostProcesses.listener(MANAGED_PORT, { fresh: true });
  const holderPid = holder.state === 'identified' ? holder.pid : undefined;
  // ONLY a holder proven to be ours may ever enter the kill list.
  //
  // This was a real defect and it cost the owner's WSL port relay. The holder was added here
  // unconditionally, so when the start correctly REFUSED a stranger's address, this line adopted
  // that stranger and teardown force-killed its tree. On Windows the holder of a WSL-forwarded port
  // is `wslrelay.exe`, so what died was the machine's localhost forwarding, not a dsh at all.
  //
  // The managed-host engine had already made the right call and preserved it; a probe must not be
  // able to undo that. "We started something" is not a licence to kill whatever is at the address —
  // it has to be the process we adopted, or proven to descend from it.
  if (holderPid && adoptedPid
    && (holderPid === adoptedPid
      || hostProcesses.descendsFrom(holderPid, adoptedPid, { fresh: true }) === 'yes')) {
    ourPids.add(holderPid);
  }
  const snapshot = await captureHostSnapshot();
  const byPid = new Map((snapshot?.processes ?? []).map((entry) => [entry.pid, entry]));
  const parentPid = holderPid ? byPid.get(holderPid)?.parentPid : undefined;
  const parentName = parentPid ? byPid.get(parentPid)?.name.toLowerCase() : undefined;
  observations.adoption = {
    portHolderState: holder.state,
    adoptedPidIsThePortHolder: !!holderPid && holderPid === adoptedPid,
    portHolderParentIsABatchShim: parentName === 'cmd.exe',
    snapshotReadable: snapshot?.processesOk === true,
  };
  assertRequired('start.adoptedThePortHolderUnderTheShim',
    !!holderPid && holderPid === adoptedPid && parentName === 'cmd.exe');
  if (holderPid && holderPid !== adoptedPid) {
    note('the managed start reported a pid that is not the process holding the port');
  }

  // ── Ownership, re-proved the way the stop path proves it ─────────────────────────────────────
  const record = readManagedHostOwnership('dsh', stateHome);
  const verdict = record && holderPid
    ? classifyManagedHost(record, readLiveProcess(holderPid, { fresh: true }), record.identityKey)
    : 'absent';
  observations.ownership = {
    recordWritten: !!record,
    recordPidIsThePortHolder: record && holderPid ? record.pid === holderPid : null,
    verdictAgainstServingPid: holderPid ? verdict : null,
  };
  assertRequired('ownership.recordClassifiesOwnedAgainstTheServingPid', verdict === 'owned');
  if (record && holderPid && verdict !== 'owned') {
    note('the durable ownership record does not classify as `owned` against the process holding the '
      + 'port, so a later broker would call its own managed host a stranger and decline to stop it');
  }

  // ── Observe ──────────────────────────────────────────────────────────────────────────────────
  let reachable = false;
  let sessions = -1;
  try {
    reachable = await adapter.isAvailable();
    if (reachable) sessions = (await adapter.discoverSessions()).length;
  } catch (error) {
    note(`Observe could not reach the managed DSH host: ${String(error).split('\n')[0]!.slice(0, 160)}`);
  }
  observations.observe = { reachable, sessionsDiscovered: sessions };
  assertRequired('observe.rpcReachable', reachable);
  assertRequired('observe.sessionsListed', sessions >= 0);

  // ── Release ──────────────────────────────────────────────────────────────────────────────────
  const released = await releaseManagedHost(adapter, effects, store);
  await Bun.sleep(2_000);
  const portAfter = hostProcesses.listener(MANAGED_PORT, { fresh: true }).state;
  observations.release = {
    action: released.action,
    escalated: released.action === 'stopped' ? released.escalated : undefined,
    verdict: 'verdict' in released ? released.verdict : undefined,
    portHolderAfter: portAfter,
  };
  assertRequired('release.hostStopped', released.action === 'stopped' || released.action === 'already-gone');
  assertRequired('release.portFreed', portAfter === 'absent');
  if (released.action === 'preserved') {
    note('the release path PRESERVED the managed host this probe started, because it could not prove '
      + 'the running process was its own');
  }

  // The configured port was honoured end to end, and nothing fell back to the documented default.
  // A managed host that silently served 3080 while the descriptor advertised 3091 would satisfy
  // every assertion above about "the host" and still be wrong in the way that matters to an
  // operator whose default is taken.
  const defaultAfter = hostProcesses.listener(DSH_DOCUMENTED_DEFAULT_PORT, { fresh: true }).state;
  observations.port = {
    managedPortIsNotTheDocumentedDefault: MANAGED_PORT !== DSH_DOCUMENTED_DEFAULT_PORT,
    documentedDefaultBefore: defaultBefore,
    documentedDefaultAfter: defaultAfter,
    unchanged: defaultBefore === defaultAfter,
  };
  assertRequired('port.theDocumentedDefaultWasNeverTaken', defaultBefore === defaultAfter);
  if (defaultBefore !== defaultAfter) {
    note(`the documented default port went from ${defaultBefore} to ${defaultAfter} across a run `
      + 'configured for a different port, so something did not honour the configured address');
  }

  observations.snapshots = { before: snapshotBefore?.processesOk === true };
} catch (error) {
  observations.aborted = { reason: String(error).split('\n')[0]!.slice(0, 300) };
  note('the DSH managed probe stopped early; observations recorded up to that point');
} finally {
  let survivors = 0;
  for (const pid of ourPids) {
    if (readLiveProcess(pid, { fresh: true }).state !== 'running') continue;
    try { terminateHostProcessTree(pid, true); } catch { /* already gone */ }
  }
  if (ourPids.size > 0) await Bun.sleep(2_000);
  for (const pid of ourPids) if (readLiveProcess(pid, { fresh: true }).state === 'running') survivors += 1;
  const snapshotAfter = await captureHostSnapshot();
  observations.teardown = {
    attributedPids: ourPids.size,
    survivingAfterTeardown: survivors,
    snapshotSucceeded: snapshotAfter?.processesOk === true,
  };
  assertRequired('teardown.noSurvivingHostProcess', survivors === 0);
  if (survivors > 0) note('a DSH host process this probe started could not be removed and was left for the owner to inspect');

  let removed = false;
  try { rmSync(root, { recursive: true, force: true }); removed = !existsSync(root); } catch { removed = false; }
  assertRequired('cleanup.disposableRootRemoved', removed);
  observations.cleanup = { disposableRootRemoved: removed };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'dsh-managed-host-lifecycle',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    required,
    requiredUnmet: REQUIRED_ASSERTIONS.filter((name) => required[name] !== true),
    findings,
    deferred: [
      'a driven DSH turn: no session is created and no provider is called, so nothing here claims '
      + 'model interaction on Windows and no configured credential is spent',
      'DSH file-watcher behaviour on Windows: the launch passes CHOKIDAR_USEPOLLING=1 but its effect '
      + 'is not measured here',
    ],
    result: REQUIRED_ASSERTIONS.every((name) => required[name] === true) && findings.length === 0
      ? 'pass'
      : 'finding',
  })}\n`);
  process.exit(0);
}
