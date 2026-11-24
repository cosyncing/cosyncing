#!/usr/bin/env bun
export {};
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@cosyncing/adapter-api';
import type { GrokDriveConnection } from '../src/drive.ts';
import {
  GROK_AUTH_READY_TTL_MS,
  GROK_AUTH_UNREADY_TTL_MS,
  GrokAdapter,
} from '../src/implementation.ts';
import { grokAuthMethod } from '../src/auth.ts';
import {
  GROK_MEASURED_VERSIONS,
  discoverGrokStore,
  grokHistorySourceIdentity,
} from '../src/store.ts';
import { writeFakeGrokBinary } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
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

  // The auth-readiness probe as the roster asks it: how often it starts a child,
  // how that child is closed, and what it logs. Probe clients have no trace sink
  // of their own, so their lines reach console.error exactly as they reach the
  // broker log, and this block reads them there. It runs before any other Grok
  // child exists, so every exit line below belongs to a probe.
  {
    const probeFake = writeFakeGrokBinary(join(root, 'probe-bin'), join(root, 'probe-home'));
    let clock = Date.parse('2026-11-23T00:00:00.000Z');
    const probeAdapter = new GrokAdapter({
      command: probeFake.path,
      env: probeFake.env,
      requestTimeoutMs: 2_000,
      now: () => clock,
    });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const exits = () => logged.filter((line) => line.includes('child-exit op=child'));
    const probeSpawns = () => probeFake.events().filter((event) => event.kind === 'spawn');
    const ledgerOf = (pid: unknown) => probeFake.events()
      .filter((event) => event.pid === pid)
      .map((event) => String(event.kind));
    try {
      probeFake.env.FAKE_GROK_VENDOR_NOTICES = '1';
      const firstReady = await probeAdapter.canCreateSession();
      const firstExited = await waitFor(() => exits().length === 1, 10_000);
      const firstPid = probeSpawns()[0]?.pid;
      check('GK-2: a probe logs no line for Grok\'s _x.ai vendor notices and still traces other unknown notifications',
        firstReady
          && ledgerOf(firstPid).includes('vendor-notices')
          && !logged.some((line) => line.includes('op=_x.ai/'))
          && logged.some((line) => line.includes('unhandled-extension op=_vendor.test/notice'))
          && logged.some((line) => line.includes('unknown-method op=fake/unknown_notice')),
        JSON.stringify(logged));
      check('GK-1: a probe child that finishes its stdin-EOF cleanup in time exits on stdin close, with no signal',
        firstExited
          && exits()[0]?.includes('(code 0, signal null)') === true
          && ledgerOf(firstPid).includes('stdin-end')
          && !ledgerOf(firstPid).includes('sigterm'),
        JSON.stringify({ exits: exits(), ledger: ledgerOf(firstPid) }));
      delete probeFake.env.FAKE_GROK_VENDOR_NOTICES;

      clock += GROK_AUTH_READY_TTL_MS - 1;
      const reusedReady = await probeAdapter.canCreateSession();
      const spawnsInsideWindow = probeSpawns().length;
      // A real Grok usually needs longer than the 2-second stdin grace to finish
      // its EOF cleanup. The next probe child behaves that way.
      probeFake.env.FAKE_GROK_LINGER_AFTER_STDIN_END_MS = '30000';
      clock += 1;
      const renewedReady = await probeAdapter.canCreateSession();
      const answeredBeforeReap = exits().length === 1;
      check('GK-1: a ready answer is reused for the whole success window, then renewed by exactly one probe child',
        reusedReady && spawnsInsideWindow === 1 && renewedReady && probeSpawns().length === 2,
        JSON.stringify({ spawnsInsideWindow, spawns: probeSpawns().length, readyTtlMs: GROK_AUTH_READY_TTL_MS }));
      const lingerExited = await waitFor(() => exits().length === 2, 15_000);
      const lingerLedger = ledgerOf(probeSpawns()[1]?.pid);
      check('GK-1: a probe child still alive after the stdin grace gets SIGTERM, not SIGKILL, and the answer does not wait for it',
        answeredBeforeReap
          && lingerExited
          && exits()[1]?.includes('(code 143, signal null)') === true
          && lingerLedger.includes('stdin-end')
          && lingerLedger.indexOf('stdin-end') < lingerLedger.indexOf('sigterm'),
        JSON.stringify({ answeredBeforeReap, exits: exits(), ledger: lingerLedger }));
      delete probeFake.env.FAKE_GROK_LINGER_AFTER_STDIN_END_MS;

      // Signed out: Grok advertises only its interactive login.
      probeFake.env.FAKE_GROK_AUTH_METHODS = JSON.stringify([{ id: 'grok.com', name: 'Grok' }]);
      clock += GROK_AUTH_READY_TTL_MS;
      const signedOut = await probeAdapter.canCreateSession();
      clock += GROK_AUTH_UNREADY_TTL_MS - 1;
      const stillSignedOut = await probeAdapter.canCreateSession();
      const spawnsInsideFailureWindow = probeSpawns().length;
      delete probeFake.env.FAKE_GROK_AUTH_METHODS; // `grok login`
      clock += 1;
      const signedIn = await probeAdapter.canCreateSession();
      check('GK-1: a not-ready answer is reused only for the shorter failure window, so a sign-in is noticed within it',
        GROK_AUTH_UNREADY_TTL_MS < GROK_AUTH_READY_TTL_MS
          && !signedOut && !stillSignedOut && spawnsInsideFailureWindow === 3
          && signedIn && probeSpawns().length === 4,
        JSON.stringify({ spawnsInsideFailureWindow, spawns: probeSpawns().length }));
      const allExited = await waitFor(() => exits().length === 4, 10_000);
      check('GK-1: no probe child needed SIGKILL',
        allExited && !logged.some((line) => line.includes('SIGKILL')),
        JSON.stringify(exits()));
      const probeStarts = probeFake.events()
        .filter((event) => event.kind === 'spawn' || event.kind === 'version-probe');
      check('SP-1: every probe child and every version probe carries the self-updater guard',
        probeStarts.some((event) => event.kind === 'spawn')
          && probeStarts.some((event) => event.kind === 'version-probe')
          && probeStarts.every((event) => event.autoUpdateDisabled === '1'),
        JSON.stringify(probeStarts.filter((event) => event.autoUpdateDisabled !== '1')));
    } finally {
      console.error = consoleError;
    }
  }

  // Create's child and a Drive child read the same way. Grok 1.0.92 sends a dozen
  // `_x.ai/session/setup` notices per create and, during a turn, one
  // `_x.ai/session_notification` per streamed tool-argument chunk (a captured Drive session
  // traced 275). None is read, and none may become a broker log line.
  {
    const noticeFake = writeFakeGrokBinary(join(root, 'notice-bin'), join(root, 'notice-home'));
    const noticeAdapter = new GrokAdapter({ command: noticeFake.path, env: noticeFake.env, requestTimeoutMs: 2_000 });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    let noticeDrive: GrokDriveConnection | undefined;
    try {
      noticeFake.env.FAKE_GROK_VENDOR_NOTICES = '1';
      const noticeCreated = await noticeAdapter.createSession({ directory: cwd });
      noticeDrive = await noticeAdapter.attach(noticeCreated.id, 'resume') as GrokDriveConnection;
      const noticeLive: AgentMessage[] = [];
      noticeDrive.subscribe((message) => noticeLive.push(message));
      await noticeDrive.sendPrompt({ text: 'turn with vendor notices' });
      const sentAt = noticeFake.events().filter((event) => event.kind === 'vendor-notices').map((event) => event.at);
      check('Create and Drive children log no line for Grok\'s _x.ai notices and still trace other unknown ones',
        sentAt.includes('session/new')
          && sentAt.includes('session/prompt')
          && noticeLive.some((message) => message.type === 'run-summary' && message.status === 'done')
          && !logged.some((line) => line.includes('op=_x.ai/'))
          && logged.some((line) => line.includes('unhandled-extension op=_vendor.test/notice')),
        JSON.stringify({ sentAt, logged }));
    } finally {
      delete noticeFake.env.FAKE_GROK_VENDOR_NOTICES;
      await noticeDrive?.close();
      console.error = consoleError;
    }
  }

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
  // Create re-derives id/cwd/model/title from the durable row: conformance C07 (grok).
  check('create records Drive eligibility only after the durable row appears', created.control?.drive.supported === true);

  // A pre-existing durable UUID never becomes broker-owned Drive: conformance C07 (second half).

  const observe = await adapter.attach(created.id, 'observe');
  await observe.close(); // Observe is read-only and spawns nothing: conformance C03/C04.

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

  // Grok 1.0.92 renames a fresh summary.json over the old one several times around
  // session/load, some after the answer (a 2026-11-24 capture). The relaunch's durable read
  // lands in that window; a single read there found no session and revoked Drive for good.
  fake.env.FAKE_GROK_LOAD_SUMMARY_REWRITE_MS = '150';
  const spawnsBeforeRewrites = fake.spawnCount();
  let rewriteRelaunchError: unknown;
  try {
    await drive.sendPrompt({
      text: 'relaunch while Grok rewrites its summary',
      model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'low' },
      permissionMode: 'default',
    });
  } catch (error) { rewriteRelaunchError = error; }
  delete fake.env.FAKE_GROK_LOAD_SUMMARY_REWRITE_MS;
  const drivingAfterRewrites = drive.driving;
  const rewritesDone = await waitFor(
    () => fake.events().some((event) => event.kind === 'summary-rewrites-done'), 3_000);
  const rewrites = fake.events().filter((event) => event.kind === 'summary-rewrites-done');
  check('a relaunch whose session/load is followed by Grok\'s summary.json rewrites keeps Drive',
    rewriteRelaunchError === undefined
      && drivingAfterRewrites
      && fake.spawnCount() === spawnsBeforeRewrites + 1
      && drive.info.currentModel?.reasoningEffort === 'low'
      && rewritesDone
      && rewrites.some((event) => typeof event.count === 'number' && event.count > 0)
      && (await adapter.discoverSessions()).find((row) => row.id === created.id)?.control?.drive.state === 'driving',
    JSON.stringify({ error: String(rewriteRelaunchError ?? ''), rewrites, driving: drive.driving }));

  // The same saves can leave the summary from before the relaunch in place for a moment, still
  // naming the previous model. A durable read that lands there must keep reading until the
  // switched model is saved; refusing it revoked Drive for good. Own store, so the session
  // above keeps its model for the checks that follow.
  {
    const staleStore = join(root, 'stale-home');
    const staleFake = writeFakeGrokBinary(join(root, 'stale-bin'), staleStore);
    const staleAdapter = new GrokAdapter({ command: staleFake.path, env: staleFake.env, requestTimeoutMs: 2_000 });
    let staleDrive: GrokDriveConnection | undefined;
    try {
      const staleCreated = await staleAdapter.createSession({
        directory: cwd,
        model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'high' },
        permissionMode: 'default',
      });
      staleDrive = await staleAdapter.attach(staleCreated.id, 'resume') as GrokDriveConnection;
      staleFake.env.FAKE_GROK_LOAD_SUMMARY_REWRITE_MS = '300';
      staleFake.env.FAKE_GROK_LOAD_SUMMARY_STALE_MS = '200';
      let staleError: unknown;
      try {
        await staleDrive.sendPrompt({
          text: 'switch while Grok still shows the previous model',
          model: { providerID: 'xai', modelID: 'grok-4.5' },
          permissionMode: 'default',
        });
      } catch (error) { staleError = error; }
      delete staleFake.env.FAKE_GROK_LOAD_SUMMARY_REWRITE_MS;
      delete staleFake.env.FAKE_GROK_LOAD_SUMMARY_STALE_MS;
      const staleDone = await waitFor(
        () => staleFake.events().some((event) => event.kind === 'summary-rewrites-done'), 3_000);
      const staleRewrites = staleFake.events().filter((event) => event.kind === 'summary-rewrites-done');
      const staleDurable = (await discoverGrokStore({ root: staleStore })).find((row) => row.id === staleCreated.id);
      check('a session/load followed by the previous summary keeps Drive once the switched model is saved',
        staleError === undefined
          && staleDrive.driving
          && staleDrive.info.currentModel?.modelID === 'grok-4.5'
          && staleDone
          && staleRewrites.some((event) => typeof event.stale === 'number' && event.stale > 0)
          && staleDurable?.model === 'grok-4.5'
          && (await staleAdapter.discoverSessions()).find((row) => row.id === staleCreated.id)?.control?.drive.state === 'driving',
        JSON.stringify({ error: String(staleError ?? ''), staleRewrites, info: staleDrive.info }));
    } finally {
      await staleDrive?.close();
    }
  }

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

  // The version gate is re-read after a self-update (never cached): conformance C16 (cachedByBroker false).

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
  // Terminal handoff revokes restart eligibility: conformance C20 (the handed-to-the-terminal session).

  // An offline transcript change revokes restart ownership: conformance C20 (the changed-offline session).

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

  // A build below the floor stays Observe-only even with durable provenance: conformance C16 (below the floor).

  // Grok updates itself and the operator does not choose when, so a gate keyed
  // to enumerated versions is one the user cannot satisfy — this box drifted
  // eleven releases unattended and Drive was refused for a build later measured
  // identical to the pinned one. Every measured build must qualify...
  // 1.0.13 (the floor) qualifies in conformance C16 (banner-polluted current); the other measured build stays here.
  for (const measured of GROK_MEASURED_VERSIONS.filter((version) => version !== '1.0.13')) {
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

  // 1.0.13 and a build newer than any measured one qualify: conformance C16 (banner-polluted current, newer).
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
