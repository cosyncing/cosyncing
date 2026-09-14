#!/usr/bin/env bun
export {};
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@cosyncing/adapter-api';
import type { GrokDriveConnection } from '../src/drive.ts';
import { GrokAdapter } from '../src/implementation.ts';
import { grokAuthMethod } from '../src/auth.ts';
import {
  GROK_MEASURED_VERSIONS,
  GROK_MINIMUM_SUPPORTED_VERSION,
  discoverGrokStore,
  grokHistorySourceIdentity,
} from '../src/store.ts';
import { writeFakeGrokBinary } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-grok-identity-'));
const store = join(root, 'home');
const cwd = join(root, 'workspace');
const bin = join(root, 'bin');
mkdirSync(store, { recursive: true });
mkdirSync(cwd, { recursive: true });
try {
  let missingAuthRefused = false;
  let malformedAuthRefused = false;
  let interactiveOnlyRefused = false;
  let overLimitAuthRefused = false;
  try { grokAuthMethod({ authMethods: [] }); } catch { missingAuthRefused = true; }
  try { grokAuthMethod({ authMethods: [{ id: '' }] }); } catch { malformedAuthRefused = true; }
  try { grokAuthMethod({ authMethods: [{ id: 'grok.com' }] }); } catch { interactiveOnlyRefused = true; }
  try {
    grokAuthMethod({ authMethods: Array.from({ length: 33 }, (_, index) => ({ id: `method-${index}` })) });
  } catch { overLimitAuthRefused = true; }
  check('auth readiness fails closed for missing, malformed, interactive-only, and over-limit catalogs',
    missingAuthRefused && malformedAuthRefused && interactiveOnlyRefused && overLimitAuthRefused);
  check('auth readiness selects only the measured reusable cached token by default',
    grokAuthMethod({ authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }] }) === 'cached_token');

  const fake = writeFakeGrokBinary(bin, store);
  const adapter = new GrokAdapter({ command: fake.path, env: fake.env, homeDir: root, requestTimeoutMs: 2_000, testOnlyEnableUnverifiedDrive: true });
  check('the exact fake binary is available, authenticated, and create-enabled',
    await adapter.isAvailable() && await adapter.canCreateSession());

  const models = await adapter.listModels();
  check('pre-session model discovery reads initialize modelState without creating a session',
    models.length === 2
      && models[0]?.label === 'Grok 4.6'
      && models[0]?.reasoningEfforts?.some((effort) => effort.effort === 'high') === true,
    JSON.stringify(models));

  const created = await adapter.createSession({
    directory: cwd,
    title: 'Requested Grok title',
    model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'high' },
    permissionMode: 'default',
  });
  check('create re-derives id, cwd, model, and title from the durable store row',
    created.id === created.nativeId
      && created.cwd === cwd
      && created.title === 'Requested Grok title'
      && created.currentModel?.modelID === 'grok-4.6'
      && created.currentModel?.label === 'Grok 4.6'
      && created.attachMode === 'resume',
    JSON.stringify(created));
  check('create records Drive eligibility only after the durable row appears', created.control?.drive.supported === true);

  const collisionAdapter = new GrokAdapter({ command: fake.path, env: fake.env, requestTimeoutMs: 2_000, testOnlyEnableUnverifiedDrive: true });
  let collisionRefused = false;
  try { await collisionAdapter.createSession({ directory: cwd }); } catch { collisionRefused = true; }
  let collisionResumeRefused = false;
  try { await collisionAdapter.attach(created.id, 'resume'); } catch { collisionResumeRefused = true; }
  check('session/new cannot turn a pre-existing durable UUID into broker-owned Drive eligibility',
    collisionRefused && collisionResumeRefused);

  const spawnsBeforeObserve = fake.spawnCount();
  const observe = await adapter.attach(created.id, 'observe');
  check('Observe is read-only and reports the connection actually opened',
    fake.spawnCount() === spawnsBeforeObserve && observe.info.attachMode === 'observe');
  await observe.close();

  const childId = '019f9d70-e38e-7591-9a24-74a06ad89482';
  const groupDir = join(store, 'sessions', encodeURIComponent(cwd));
  const childDir = join(groupDir, childId);
  const childMetaRoot = join(groupDir, created.id, 'subagents');
  const childMetaDir = join(childMetaRoot, childId);
  mkdirSync(childDir, { recursive: true });
  mkdirSync(childMetaDir, { recursive: true });
  writeFileSync(join(childDir, 'summary.json'), `${JSON.stringify({
    info: { id: childId, cwd },
    session_kind: 'subagent',
    session_summary: 'Adapter child fixture',
    current_model_id: 'grok-4.6',
    reasoning_effort: 'high',
    agent_name: 'general-purpose',
  })}\n`);
  writeFileSync(join(childMetaDir, 'meta.json'), `${JSON.stringify({
    child_session_id: childId,
    subagent_id: childId,
    parent_session_id: created.id,
    child_cwd: cwd,
  })}\n`);
  const childRoster = await adapter.discoverSessions();
  const childRow = childRoster.find((row) => row.id === childId);
  const childParent = childRoster.find((row) => row.id === created.id);
  const childObserve = await adapter.attach(childId, 'observe');
  let childResumeRefused = false;
  try { await adapter.attach(childId, 'resume'); } catch { childResumeRefused = true; }
  check('Grok projects measured children with parent native lineage and Observe-only control',
    childRow?.origin === 'subagent'
      && childRow.parentThreadId === childParent?.nativeId
      && childRow.nativeId === childId
      && childRow.attachMode === 'observe'
      && childRow.control?.drive.supported === false
      && childRow.terminalSyncHint === undefined
      && childObserve.info.origin === 'subagent'
      && childResumeRefused,
    JSON.stringify(childRow));
  await childObserve.close();
  rmSync(childDir, { recursive: true, force: true });
  rmSync(childMetaRoot, { recursive: true, force: true });

  const laggedStore = join(root, 'lagged-home');
  const laggedFake = writeFakeGrokBinary(join(root, 'lagged-bin'), laggedStore);
  laggedFake.env.FAKE_GROK_SUMMARY_EFFORT_OVERRIDE = 'high';
  const laggedAdapter = new GrokAdapter({
    command: laggedFake.path,
    env: laggedFake.env,
    homeDir: root,
    requestTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
  });
  const laggedCreated = await laggedAdapter.createSession({
    directory: cwd,
    model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'xhigh' },
    permissionMode: 'default',
  });
  const laggedDrive = await laggedAdapter.attach(laggedCreated.id, 'resume') as GrokDriveConnection;
  await laggedDrive.listCommands();
  check('promptless durable effort lag is accepted only after session/load confirms the requested effort',
    laggedCreated.currentModel?.reasoningEffort === 'xhigh'
      && laggedDrive.info.currentModel?.reasoningEffort === 'xhigh'
      && laggedDrive.driving,
    JSON.stringify(laggedDrive.info));
  await laggedDrive.close();

  const mismatchedStore = join(root, 'mismatched-home');
  const mismatchedFake = writeFakeGrokBinary(join(root, 'mismatched-bin'), mismatchedStore);
  mismatchedFake.env.FAKE_GROK_SUMMARY_EFFORT_OVERRIDE = 'high';
  mismatchedFake.env.FAKE_GROK_LOAD_EFFORT_OVERRIDE = 'high';
  const mismatchedAdapter = new GrokAdapter({
    command: mismatchedFake.path,
    env: mismatchedFake.env,
    homeDir: root,
    requestTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
  });
  let unconfirmedEffortRefused = false;
  try {
    await mismatchedAdapter.createSession({
      directory: cwd,
      model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'xhigh' },
      permissionMode: 'default',
    });
  } catch { unconfirmedEffortRefused = true; }
  check('create refuses an effort that session/load does not confirm', unconfirmedEffortRefused);

  const drive = await adapter.attach(created.id, 'resume') as GrokDriveConnection;
  const spawnsBeforePrompt = fake.spawnCount();
  const live: AgentMessage[] = [];
  const stop = drive.subscribe((message) => live.push(message));
  fake.env.FAKE_GROK_PERMISSION_BEFORE_EXIT = '1';
  const firstTurn = drive.sendPrompt({ text: 'first fake turn', clientMessageId: 'client-first' });
  for (let attempt = 0; attempt < 100
    && !drive.getPending().some((message) => message.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(10);
  }
  const firstPermission = drive.getPending().find((message) => message.type === 'permission-request');
  const activeRoster = await adapter.discoverSessions();
  const activeObserve = await adapter.attach(created.id, 'observe');
  check('roster discovery and Observe attach during an active durable append preserve Drive eligibility',
    firstPermission?.type === 'permission-request'
      && drive.driving
      && activeRoster.find((row) => row.id === created.id)?.control?.drive.state === 'driving'
      && activeObserve.info.attachMode === 'observe');
  await drive.respondPermission(firstPermission!.requestId, 'approve');
  await firstTurn;
  const history = await drive.getHistory();
  const first = history.find((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
    message.type === 'user-message' && message.text === 'first fake turn');
  check('lazy Resume starts one stdio child, session/loads the exact id, and preserves event correlation',
    fake.spawnCount() === spawnsBeforePrompt + 1
      && first?.clientKey === 'client-first'
      && first.queued === false,
    JSON.stringify({ first, events: fake.events() }));
  const activeObserveHistory = await activeObserve.getHistory();
  check('Observe opened during the active append reuses the writer correlation registry',
    activeObserveHistory.filter((message) => message.type === 'user-message'
      && message.text === 'first fake turn').length === 1
      && activeObserveHistory.some((message) => message.type === 'user-message'
        && message.text === 'first fake turn'
        && message.key === first?.key
        && message.clientKey === 'client-first'));
  await activeObserve.close();
  delete fake.env.FAKE_GROK_PERMISSION_BEFORE_EXIT;
  const driveSpawn = fake.events().find((event) => event.kind === 'spawn'
    && Array.isArray(event.argv)
    && (event.argv as unknown[]).includes('--permission-mode'));
  check('Drive child is launched without always-approve and with the owned permission mode',
    Array.isArray(driveSpawn?.argv)
      && !(driveSpawn.argv as unknown[]).includes('--always-approve')
      && (driveSpawn.argv as unknown[]).includes('--permission-mode')
      && (driveSpawn.argv as unknown[]).includes('default')
      && (driveSpawn.argv as unknown[]).indexOf('--permission-mode') < (driveSpawn.argv as unknown[]).indexOf('agent')
      && (driveSpawn.argv as unknown[]).indexOf('--model') > (driveSpawn.argv as unknown[]).indexOf('agent')
      && (driveSpawn.argv as unknown[]).indexOf('--reasoning-effort') > (driveSpawn.argv as unknown[]).indexOf('agent')
      && (driveSpawn.argv as unknown[]).indexOf('--reasoning-effort') < (driveSpawn.argv as unknown[]).indexOf('stdio'),
    JSON.stringify(driveSpawn));

  // Grok updates itself in place during an ACP bring-up. The version gate
  // detects that afterwards and revokes ownership, but detection is not
  // prevention: an unattended broker drifted the binary eleven releases, and
  // every Drive leg was refused until it was reinstalled by hand. Assert on
  // EVERY start, because one unguarded start is enough to move the binary.
  //
  // Version probes are included deliberately. `--version` was measured NOT to
  // trigger an update, but that is a property of one release of an updater we
  // do not control, and the probe runs on every Drive-eligibility question --
  // so it is both the most frequent start and the easiest to forget. It ran
  // with a bare environment while `drive.ts` wrapped the identical probe.
  const starts = fake.events().filter((event) =>
    event.kind === 'spawn' || event.kind === 'version-probe');
  const acpChildren = starts.filter((event) => event.kind === 'spawn');
  const versionProbes = starts.filter((event) => event.kind === 'version-probe');
  check('every Grok child start suppresses the in-place self-updater',
    acpChildren.length > 0 && versionProbes.length > 0
      && starts.every((event) => event.autoUpdateDisabled === '1'),
    JSON.stringify({
      acpChildren: acpChildren.length,
      versionProbes: versionProbes.length,
      unguarded: starts.filter((event) => event.autoUpdateDisabled !== '1')
        .map((event) => ({ kind: event.kind, argv: event.argv })),
    }));

  const spawnsBeforeSwitch = fake.spawnCount();
  fake.env.FAKE_GROK_DONE_METHOD = 'x.ai/session/update';
  await drive.sendPrompt({
    text: 'model-switched fake turn',
    model: { providerID: 'xai', modelID: 'grok-4.5' },
    permissionMode: 'default',
  });
  check('existing-session model/mode switch relaunches one child and reloads the same durable id',
    fake.spawnCount() === spawnsBeforeSwitch + 1
      && drive.info.currentModel?.modelID === 'grok-4.5'
      && drive.info.currentMode === 'default'
      && (await drive.getHistory()).some((message) => message.type === 'run-summary' && message.status === 'done')
      && fake.events().filter((event) => event.kind === 'frame'
        && (event.frame as { method?: unknown } | undefined)?.method === 'session/load').length >= 2,
    JSON.stringify({ info: drive.info, spawns: fake.events().filter((event) => event.kind === 'spawn') }));

  fake.env.FAKE_GROK_LOAD_MODEL_OVERRIDE = 'grok-4.5';
  let mismatchedSwitchRefused = false;
  try {
    await drive.sendPrompt({
      text: 'must not reach mismatched child',
      model: { providerID: 'xai', modelID: 'grok-4.6' },
      permissionMode: 'default',
    });
  } catch { mismatchedSwitchRefused = true; }
  const demotedRow = (await adapter.discoverSessions()).find((row) => row.id === created.id);
  let reopenAfterDemotionRefused = false;
  try { await adapter.attach(created.id, 'resume'); } catch { reopenAfterDemotionRefused = true; }
  check('a session/load model mismatch demotes once and permanently revokes process-local Drive eligibility',
    mismatchedSwitchRefused
      && drive.driving === false
      && demotedRow?.control?.drive.supported === false
      && reopenAfterDemotionRefused,
    JSON.stringify(demotedRow));
  stop();
  await drive.close();

  fake.setVersion('0.2.115');
  check('the version gate is re-read after a self-update instead of cached', !await adapter.canCreateSession());

  const evolvingStore = join(root, 'evolving-home');
  const evolvingBin = writeFakeGrokBinary(join(root, 'evolving-bin'), evolvingStore);
  const evolvingAdapter = new GrokAdapter({ command: evolvingBin.path, env: evolvingBin.env, requestTimeoutMs: 2_000, testOnlyEnableUnverifiedDrive: true });
  const evolvingCreated = await evolvingAdapter.createSession({ directory: cwd });
  const evolvingDrive = await evolvingAdapter.attach(evolvingCreated.id, 'resume');
  const spawnsBeforeUpdate = evolvingBin.spawnCount();
  evolvingBin.setVersion('0.2.115');
  let changedBeforeChildRefused = false;
  try { await evolvingDrive.sendPrompt({ text: 'must not start updated binary' }); } catch { changedBeforeChildRefused = true; }
  check('every lazy child start revalidates the native version and revokes ownership on drift',
    changedBeforeChildRefused
      && evolvingBin.spawnCount() === spawnsBeforeUpdate
      && (await evolvingAdapter.discoverSessions()).find((row) => row.id === evolvingCreated.id)?.control?.drive.supported === false);
  await evolvingDrive.close();

  fake.setVersion('1.0.13');
  let durableRevoked = false;
  const storedSession = (await discoverGrokStore({ root: store })).find((session) => session.id === created.id)!;
  const restartBoundary = await grokHistorySourceIdentity(storedSession);
  const restartedAdapter = new GrokAdapter({
    command: fake.path,
    env: fake.env,
    requestTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
    resolveStoredDriveState: (info) => info.id === created.id && !durableRevoked
      ? {
          currentModel: created.currentModel,
          currentMode: created.currentMode,
          historyBoundary: restartBoundary,
        }
      : undefined,
    revokeStoredDriveEligibility: () => { durableRevoked = true; },
  });
  const restartedRow = (await restartedAdapter.discoverSessions()).find((row) => row.id === created.id);
  const restartedDrive = await restartedAdapter.attach(created.id, 'resume');
  check('a broker restart restores only exact app-created Drive provenance and selections',
    restartedRow?.control?.drive.supported === true
      && restartedRow.currentModel?.modelID === created.currentModel?.modelID
      && restartedRow.currentMode === created.currentMode
      && restartedDrive.info.control?.drive.state === 'driving',
    JSON.stringify(restartedRow));
  await restartedDrive.close();
  restartedAdapter.releaseDriveEligibility(created.id);
  let resumeRefused = false;
  try { await restartedAdapter.attach(created.id, 'resume'); } catch { resumeRefused = true; }
  check('terminal handoff revokes both process-local and durable restart eligibility',
    durableRevoked && resumeRefused);

  durableRevoked = false;
  appendFileSync(storedSession.updatesPath, `${JSON.stringify({
    method: 'session/update',
    params: {
      sessionId: created.id,
      update: { sessionUpdate: 'user_message_chunk', content: { text: 'offline terminal write' } },
    },
  })}\n`);
  const offlineAdapter = new GrokAdapter({
    command: fake.path,
    env: fake.env,
    requestTimeoutMs: 2_000,
    resolveStoredDriveState: (info) => info.id === created.id && !durableRevoked
      ? { historyBoundary: restartBoundary }
      : undefined,
    revokeStoredDriveEligibility: () => { durableRevoked = true; },
  });
  const offlineRow = (await offlineAdapter.discoverSessions()).find((row) => row.id === created.id);
  let offlineResumeRefused = false;
  try { await offlineAdapter.attach(created.id, 'resume'); } catch { offlineResumeRefused = true; }
  check('an offline transcript change invalidates durable restart ownership before Resume',
    durableRevoked && offlineRow?.control?.drive.supported === false && offlineResumeRefused,
    JSON.stringify(offlineRow));

  const sameProcessStore = join(root, 'same-process-home');
  const sameProcessFake = writeFakeGrokBinary(join(root, 'same-process-bin'), sameProcessStore);
  let sameProcessBoundary: Awaited<ReturnType<typeof grokHistorySourceIdentity>>;
  let sameProcessRevoked = false;
  let sameProcessCreated: Awaited<ReturnType<NonNullable<typeof adapter.createSession>>> | undefined;
  const sameProcessAdapter = new GrokAdapter({
    command: sameProcessFake.path,
    env: sameProcessFake.env,
    requestTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
    resolveStoredDriveState: (info) => sameProcessBoundary && info.id === sameProcessCreated?.id
      ? { historyBoundary: sameProcessBoundary }
      : undefined,
    recordStoredDriveBoundary: (record) => { sameProcessBoundary = record.historyBoundary; },
    revokeStoredDriveEligibility: () => { sameProcessRevoked = true; },
  });
  sameProcessCreated = await sameProcessAdapter.createSession({ directory: cwd });
  const sameProcessSession = (await discoverGrokStore({ root: sameProcessStore }))
    .find((session) => session.id === sameProcessCreated!.id)!;
  appendFileSync(sameProcessSession.updatesPath, `${JSON.stringify({
    method: 'session/update',
    params: {
      sessionId: sameProcessCreated.id,
      update: { sessionUpdate: 'user_message_chunk', content: { text: 'foreign same-process write' } },
    },
  })}\n`);
  const sameProcessRow = (await sameProcessAdapter.discoverSessions())
    .find((row) => row.id === sameProcessCreated!.id);
  let sameProcessResumeRefused = false;
  try { await sameProcessAdapter.attach(sameProcessCreated.id, 'resume'); } catch { sameProcessResumeRefused = true; }
  check('a foreign write with no active connection clears process-local and durable Drive eligibility',
    sameProcessRevoked && sameProcessRow?.control?.drive.supported === false && sameProcessResumeRefused,
    JSON.stringify(sameProcessRow));

  const future = writeFakeGrokBinary(join(root, 'future-bin'), store, '0.2.115');
  const futureBoundary = await grokHistorySourceIdentity(storedSession);
  const futureAdapter = new GrokAdapter({
    command: future.path,
    env: future.env,
    testOnlyEnableUnverifiedDrive: true,
    resolveStoredDriveState: (info) => info.id === created.id
      ? { currentModel: created.currentModel, currentMode: created.currentMode, historyBoundary: futureBoundary }
      : undefined,
  });
  const futureRows = await futureAdapter.discoverSessions();
  const futureRow = futureRows.find((row) => row.id === created.id);
  let futureResumeRefused = false;
  try { await futureAdapter.attach(created.id, 'resume'); } catch { futureResumeRefused = true; }
  check('a Grok build below the measured floor remains Observe-only even with durable app-created provenance',
    !await futureAdapter.canCreateSession()
      && futureRows.length === 1
      && futureRow?.control?.drive.supported === false
      && futureResumeRefused,
    JSON.stringify(futureRow));

  // Grok updates itself and the operator does not choose when, so a gate keyed
  // to enumerated versions is one the user cannot satisfy — this box drifted
  // eleven releases unattended and Drive was refused for a build later measured
  // identical to the pinned one. Every measured build must qualify...
  for (const measured of GROK_MEASURED_VERSIONS) {
    const measuredFake = writeFakeGrokBinary(join(root, `measured-${measured}-bin`), store, measured);
    const measuredAdapter = new GrokAdapter({
      command: measuredFake.path,
      env: measuredFake.env,
      testOnlyEnableUnverifiedDrive: true,
    });
    check(`Grok ${measured} qualifies for Create because it is a measured version`,
      await measuredAdapter.canCreateSession(),
      JSON.stringify({ measured, measuredVersions: GROK_MEASURED_VERSIONS }));
  }

  // ...and so must a build NEWER than anything enumerated, which is the whole
  // point: a user who upgrades must not lose Drive until someone reruns the
  // capture. The floor is the only version comparison that gates anything; the
  // protocol, auth, store-shape and ownership checks each fail closed on their
  // own if a future build genuinely breaks the contract.
  const unmeasuredNewer = '9.9.9';
  const newerFake = writeFakeGrokBinary(join(root, 'newer-unmeasured-bin'), store, unmeasuredNewer);
  const newerAdapter = new GrokAdapter({
    command: newerFake.path,
    env: newerFake.env,
    testOnlyEnableUnverifiedDrive: true,
  });
  check('a build newer than every measured version still qualifies for Create',
    await newerAdapter.canCreateSession(),
    JSON.stringify({ unmeasuredNewer, floor: GROK_MINIMUM_SUPPORTED_VERSION }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
