#!/usr/bin/env bun
export {};
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import {
  mapReasonixSessionUpdate,
  mapReasonixTranscript,
  ReasonixAdapter,
  ReasonixObserveConnection,
} from '../src/index.ts';
import type { ReasonixDisplayEntry, ReasonixTranscriptRecord } from '../src/mapping.ts';
import {
  buildReasonixFixtureTree,
  writeFakeReasonixBinary,
} from './fixtures/tree.ts';
import { discoverReasonixStore } from '../src/store.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
function keys(messages: readonly AgentMessage[]): string[] {
  return messages
    .map((message) => (message as { key?: string }).key)
    .filter((key): key is string => typeof key === 'string');
}

const tree = buildReasonixFixtureTree();
try {
  const captured = JSON.parse(readFileSync(
    join(import.meta.dir, 'fixtures', 'reasonix-v1.25.2-identity.json'),
    'utf8',
  )) as {
    sessionId: string;
    records: ReasonixTranscriptRecord[];
    displayEntries: ReasonixDisplayEntry[];
    combinedLiveUpdates: Array<Record<string, unknown>>;
  };
  const assistantIndex = captured.displayEntries.find((entry) => entry.role === 'assistant')?.index;
  const capturedLive = assistantIndex === undefined ? [] : captured.combinedLiveUpdates.flatMap((update) =>
    mapReasonixSessionUpdate(update, 'captured-tool', {
      sessionId: captured.sessionId,
      assistantIndex,
    }));
  const capturedReplay = mapReasonixTranscript(
    captured.sessionId,
    captured.records,
    captured.displayEntries,
  );
  let measuredOffset = 0;
  const inclusiveDisplay = captured.records.every((record, index) => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const display = captured.displayEntries[index];
    const matches = display?.offset === measuredOffset && display.length === lineBytes;
    measuredOffset += lineBytes;
    return matches;
  });
  check('the sanitized R1 sidecar fixture pins newline-inclusive display lengths', inclusiveDisplay);
  const liveOutput = capturedLive.find((message) => message.type === 'model-output');
  const replayOutput = capturedReplay.find((message) => message.type === 'model-output');
  check('the versioned R1 ACP output and durable replay use the same assistant key',
    liveOutput?.type === 'model-output'
      && replayOutput?.type === 'model-output'
      && liveOutput.key === replayOutput.key
      && liveOutput.delta === replayOutput.text,
    JSON.stringify({ liveOutput, replayOutput }));

  const stored = (await discoverReasonixStore({ root: tree.root }))[0];
  if (!stored) throw new Error('Reasonix identity fixture was not discovered');
  const info: SessionInfo = {
    id: tree.id,
    nativeId: tree.id,
    tool: 'reasonix',
    title: stored.title,
    cwd: tree.cwd,
    status: 'idle',
    attachMode: 'observe',
  };

  // One durable record through the tail and through replay must keep the same
  // native keys and ordering. ACP chunks are deltas and deliberately carry no
  // invented record id; convergence happens when this durable row arrives.
  const observe = new ReasonixObserveConnection({ session: stored, info });
  await observe.getHistory();
  const live: AgentMessage[] = [];
  observe.subscribe((message) => live.push(message));
  tree.writeRows([...tree.rows, {
    role: 'assistant',
    reasoning_content: 'identity thought',
    content: 'identity answer',
    workDurationMs: 25,
  }]);
  const tailed = await waitFor(() => live.some((message) =>
    message.type === 'model-output' && message.text === 'identity answer'));
  const tailKeys = keys(live);
  const replayKeys = keys(await observe.getHistory());
  const expectedTailKeys = replayKeys.slice(-tailKeys.length);
  check('one durable record has identical tail and replay keys in identical order',
    tailed && tailKeys.length >= 2 && JSON.stringify(tailKeys) === JSON.stringify(expectedTailKeys),
    `tail=${tailKeys.join('|')} replay-tail=${expectedTailKeys.join('|')}`);
  await observe.close();

  const fake = writeFakeReasonixBinary(join(tree.root, 'bin'), tree.id);
  const adapter = new ReasonixAdapter({
    command: fake.path,
    env: {
      ...fake.env,
      REASONIX_HOME: tree.root,
      FAKE_REASONIX_MODELS: '1',
      FAKE_REASONIX_LOAD_CONFIG_OPTIONS_FULL: '1',
      FAKE_REASONIX_PERSIST_CONFIG_OPTION: '1',
    },
  });
  const first = await adapter.attach(tree.id, 'resume');
  check('the first Resume registers as the session Drive owner', adapter.isDriving(tree.id));
  check('Resume attach is lazy and spawns no child before a prompt', fake.spawnCount() === 0);
  await first.sendPrompt({ text: 'first owner turn', permissionMode: 'yolo' });
  const firstMethods = fake.events()
    .filter((event) => event.kind === 'frame')
    .map((event) => (event.frame as { method?: unknown }).method);
  check('existing-session mode configuration is acknowledged into the composer before prompting',
    fake.spawnCount() === 1
      && first.info.currentMode === 'yolo'
      && firstMethods.includes('session/load')
      && firstMethods.includes('session/set_config_option')
      && firstMethods.indexOf('session/set_config_option') < firstMethods.indexOf('session/prompt'),
    JSON.stringify({ methods: firstMethods, currentMode: first.info.currentMode }));
  const durableConfiguredMode = JSON.parse(readFileSync(tree.acpMetadataPath, 'utf8')) as { toolApprovalMode?: unknown };
  check('existing-session mode configuration is durably visible before the turn resolves',
    durableConfiguredMode.toolApprovalMode === 'yolo', JSON.stringify(durableConfiguredMode));
  let rivalRefused = false;
  try { await adapter.attach(tree.id, 'resume'); } catch { rivalRefused = true; }
  check('a second Resume is refused while the registered owner is driving',
    rivalRefused && adapter.driveConnection(tree.id) === first && fake.spawnCount() === 1);

  await first.close();
  const second = await adapter.attach(tree.id, 'resume');
  check('a replacement is admitted only after the first owner closes',
    'identity' in first && 'identity' in second
      && first.identity !== second.identity
      && adapter.driveConnection(tree.id) === second,
    `${String((first as { identity?: string }).identity)} vs ${String((second as { identity?: string }).identity)}`);
  check('restart discovery restores the durably configured permission mode before spawning ACP',
    second.info.currentMode === 'yolo' && fake.spawnCount() === 1,
    JSON.stringify({ currentMode: second.info.currentMode, spawns: fake.spawnCount() }));
  check('opening the replacement still does not spawn its child', fake.spawnCount() === 1, String(fake.spawnCount()));
  await second.sendPrompt({ text: 'replacement owner turn' });
  check('the replacement first prompt starts its own ACP child', fake.spawnCount() === 2, String(fake.spawnCount()));

  await first.close();
  check('a stale close cannot deregister the replacement',
    adapter.isDriving(tree.id) && adapter.driveConnection(tree.id) === second);
  const drivenRow = (await adapter.discoverSessions()).find((row) => row.id === tree.id);
  check('discovery reads Drive posture from the identity registry',
    drivenRow?.control?.drive.state === 'driving', JSON.stringify(drivenRow?.control?.drive));

  await second.close();
  check('closing the registered owner returns discovery to Observe',
    !adapter.isDriving(tree.id)
      && (await adapter.discoverSessions()).find((row) => row.id === tree.id)?.control?.drive.state === 'observing');
  check('the registry exercise used one ACP child per native attach', fake.spawnCount() === 2, String(fake.spawnCount()));

  const exitFake = writeFakeReasonixBinary(join(tree.root, 'bin-exit'), tree.id);
  const exitAdapter = new ReasonixAdapter({
    command: exitFake.path,
    env: {
      ...exitFake.env,
      REASONIX_HOME: tree.root,
      FAKE_REASONIX_EXIT_AFTER_PROMPT: '1',
      FAKE_REASONIX_PERMISSION_BEFORE_EXIT: '1',
    },
  });
  const exitConnection = await exitAdapter.attach(tree.id, 'resume');
  const exitMessages: AgentMessage[] = [];
  exitConnection.subscribe((message) => exitMessages.push(message));
  await exitConnection.sendPrompt({ text: 'exit after this completed turn' });
  const idleExitObserved = await waitFor(() => !exitAdapter.isDriving(tree.id));
  check('an ACP child exit while idle demotes the registered writer and updates discovery posture',
    idleExitObserved
      && exitMessages.some((message) => message.type === 'metadata-update')
      && exitMessages.some((message) => message.type === 'permission-request'
        && message.requestId === 'permission-before-exit')
      && exitMessages.some((message) => message.type === 'permission-resolved'
        && message.requestId === 'permission-before-exit'
        && message.decision === 'external')
      && (await exitAdapter.discoverSessions()).find((row) => row.id === tree.id)?.control?.drive.state === 'observing',
    JSON.stringify(exitMessages));
  await exitConnection.close();

  const createRoot = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-create-'));
  try {
    const createCwd = join(createRoot, 'workspace');
    mkdirSync(createCwd, { recursive: true });
    const createFake = writeFakeReasonixBinary(join(createRoot, 'bin'), 'created-empty');
    const createAdapter = new ReasonixAdapter({
      command: createFake.path,
      env: {
        ...createFake.env,
        REASONIX_HOME: createRoot,
        FAKE_REASONIX_MATERIALIZE_ON_PROMPT: '1',
        FAKE_REASONIX_SYSTEM_ON_MATERIALIZE: '1',
        FAKE_REASONIX_STAGED_MATERIALIZE: '1',
        FAKE_REASONIX_STAGE_DELAY_MS: '300',
        FAKE_REASONIX_PROMPT_RESULT_DELAY_MS: '700',
      },
      pendingCreateTimeoutMs: 2_000,
    });
    // The catalogue the New Session sheet is offered, and the reason
    // `modelLabels` is declared unsupported for this adapter.
    //
    // Reasonix reads it from `doctor --json`, which lists bare model id strings:
    // there is no display name in the source, so every entry's label IS its
    // modelID. That is a fact about the native surface, not a gap in the
    // adapter, and it is why a created Reasonix session renders the generic
    // `Model` chip with the exact id in its tooltip. Pinned here so the denial
    // in the capability manifest fails the moment a real name appears --
    // otherwise the declaration is a claim nothing checks, which is exactly how
    // `createModelPropagation` stayed falsely denied through a green gate.
    const catalog = await createAdapter.listModels();
    check('every catalog entry labels itself with its own model id, because the native source has no name',
      catalog.length === 5 && catalog.every((entry) => entry.label === entry.modelID),
      JSON.stringify(catalog.map((entry) => `${entry.providerID}/${entry.modelID}=${String(entry.label)}`)));
    check('one model offered by two providers is deduped on the PAIR, not the name',
      catalog.filter((entry) => entry.modelID === 'glm-5.2').length === 2
        && new Set(catalog.map((entry) => `${entry.providerID}/${entry.modelID}`)).size === catalog.length,
      JSON.stringify(catalog.map((entry) => `${entry.providerID}/${entry.modelID}`)));
    check('provider key material never reaches the served catalogue',
      !JSON.stringify(catalog).includes('api_key_env') && !JSON.stringify(catalog).includes('key_present'),
      JSON.stringify(catalog[0]));

    const created = await createAdapter.createSession({
      directory: createCwd,
      title: 'Pending created display title',
      model: { providerID: 'provider', modelID: 'model' },
      permissionMode: 'yolo',
    });
    // ...and the created row carries identity with NO label, so the client is
    // never handed a raw id dressed as a human name.
    check('a created session propagates the exact pair and invents no label for it',
      created.currentModel?.providerID === 'provider'
        && created.currentModel.modelID === 'model'
        && created.currentModel.label === undefined,
      JSON.stringify(created.currentModel));
    check('empty create returns the exact ACP id as an immediately resumable provisional row',
      created.id === 'created-empty'
        && created.nativeId === 'created-empty'
        && created.cwd === createCwd
        && created.currentMode === 'yolo'
        && created.control?.drive.state === 'observing'
        && createFake.spawnCount() === 1
        && (await createAdapter.discoverSessions()).every((row) => row.id !== created.id),
      JSON.stringify(created));
    const createdDrive = await createAdapter.attach(created.id, 'resume');
    check('the first Resume adopts the session/new child without a second spawn',
      createdDrive === createAdapter.driveConnection(created.id)
        && createFake.spawnCount() === 1
        && (await createdDrive.getHistory()).length === 0);
    const createdLive: AgentMessage[] = [];
    createdDrive.subscribe((message) => createdLive.push(message));
    const createdTurn = createdDrive.sendPrompt({ text: 'materialize this session', clientMessageId: 'created-client' });
    await waitFor(() => createdLive.some((message) => message.type === 'user-message' && message.queued === true));
    const queuedCreated = createdLive.find((message) => message.type === 'user-message' && message.queued === true);
    await createdTurn;
    const createdHistory = await createdDrive.getHistory();
    const createdPending = await createdDrive.getPending?.() ?? [];
    const createdDurable = (await createAdapter.discoverSessions()).find((row) => row.id === created.id);
    const createMethods = createFake.events()
      .filter((event) => event.kind === 'frame')
      .map((event) => (event.frame as { method?: unknown }).method);
    check('the first prompt materializes and verifies durable id, cwd, and model on the adopted child',
      createdDurable?.cwd === createCwd
        && createdDurable.model === 'provider/model'
        && createdDurable.currentMode === 'yolo'
        && createdDurable.control?.drive.state === 'driving'
        && createFake.spawnCount() === 1
        && !createMethods.includes('session/load')
        && createMethods.filter((method) => method === 'session/new').length === 1
        && createMethods.filter((method) => method === 'session/set_config_option').length === 1
        && createMethods.filter((method) => method === 'session/prompt').length === 1,
      JSON.stringify({ createdDurable, createMethods }));
    check('the staged first-prompt tail echo claims the queued key and keeps Drive ownership',
      queuedCreated?.type === 'user-message'
        && createdLive.some((message) => message.type === 'user-message'
          && message.text === 'materialize this session'
          && message.key === queuedCreated.key
          && message.clientKey === 'created-client'
          && message.queued === false)
        && createdHistory.some((message) => message.type === 'user-message'
          && message.text === 'materialize this session'
          && message.key === queuedCreated.key
          && message.clientKey === 'created-client'
          && message.queued === false)
        && !createdPending.some((message) => message.type === 'user-message')
        && createAdapter.isDriving(created.id),
      JSON.stringify({ createdLive, createdHistory, pending: createdPending }));
    await createdDrive.close();

    const streamedCreateId = 'created-streamed';
    const streamedCreateFake = writeFakeReasonixBinary(
      join(createRoot, 'bin-streamed-create'),
      streamedCreateId,
    );
    const streamedCreateAdapter = new ReasonixAdapter({
      command: streamedCreateFake.path,
      env: {
        ...streamedCreateFake.env,
        REASONIX_HOME: createRoot,
        FAKE_REASONIX_MATERIALIZE_ON_PROMPT: '1',
        FAKE_REASONIX_SYSTEM_ON_MATERIALIZE: '1',
        FAKE_REASONIX_STREAM_ON_PROMPT: '1',
        FAKE_REASONIX_PROMPT_RESULT_DELAY_MS: '400',
      },
      pendingCreateTimeoutMs: 2_000,
    });
    const streamedCreated = await streamedCreateAdapter.createSession({
      directory: createCwd,
      model: { providerID: 'provider', modelID: 'model' },
    });
    const streamedCreatedDrive = await streamedCreateAdapter.attach(streamedCreated.id, 'resume');
    const streamedCreatedLive: AgentMessage[] = [];
    streamedCreatedDrive.subscribe((message) => streamedCreatedLive.push(message));
    await streamedCreatedDrive.sendPrompt({ text: 'stream this created turn' });
    await waitFor(() => streamedCreatedLive.some((message) =>
      message.type === 'model-output' && message.text === 'created answer'));
    const streamedCreatedOutputs = streamedCreatedLive.filter((message) => message.type === 'model-output');
    check('the first created turn publishes one keyed durable answer without keyless ACP duplicates',
      streamedCreatedOutputs.length === 1
        && streamedCreatedOutputs[0]?.type === 'model-output'
        && streamedCreatedOutputs[0].text === 'created answer'
        && streamedCreatedOutputs[0].final === true
        && streamedCreatedOutputs[0].key === `reasonix:${streamedCreateId}:message:2:output`,
      JSON.stringify(streamedCreatedOutputs));
    await streamedCreatedDrive.close();

    const inboxOnlyId = 'created-inbox-only';
    const inboxOnlyFake = writeFakeReasonixBinary(join(createRoot, 'bin-inbox-only'), inboxOnlyId);
    const inboxOnlyAdapter = new ReasonixAdapter({
      command: inboxOnlyFake.path,
      env: {
        ...inboxOnlyFake.env,
        REASONIX_HOME: createRoot,
        FAKE_REASONIX_MATERIALIZE_ON_PROMPT: '1',
        FAKE_REASONIX_SYSTEM_ON_MATERIALIZE: '1',
        FAKE_REASONIX_CANONICALIZE_TERMINAL_NEWLINE: '1',
        FAKE_REASONIX_BLOCK_PROMPT_RESULT: '1',
      },
      pendingCreateTimeoutMs: 2_000,
    });
    const inboxOnlyInfo = await inboxOnlyAdapter.createSession({
      directory: createCwd,
      model: { providerID: 'provider', modelID: 'model' },
    });
    const inboxBase = join(createRoot, 'sessions', inboxOnlyId);
    check('physical empty create has only its inbox transaction lock and no durable session row',
      existsSync(join(`${inboxBase}.inbox`, 'transaction.lock'))
        && !existsSync(`${inboxBase}.jsonl`)
        && !existsSync(`${inboxBase}.jsonl.meta`)
        && !existsSync(`${inboxBase}.acp.json`));
    const inboxOnlyDrive = await inboxOnlyAdapter.attach(inboxOnlyInfo.id, 'resume');
    const inboxTurn = inboxOnlyDrive.sendPrompt({
      text: 'materialize while ACP remains pending\n',
      clientMessageId: 'inbox-client',
    });
    void inboxTurn.catch(() => undefined);
    const materializedBeforeWatch = await waitFor(() => existsSync(`${inboxBase}.jsonl`)
      && existsSync(`${inboxBase}.jsonl.meta`)
      && existsSync(`${inboxBase}.acp.json`));
    const queuedInbox = (await inboxOnlyDrive.getPending?.() ?? [])
      .find((message) => message.type === 'user-message');
    // Deliberately start the real production fs.watch lifecycle after every
    // durable file already exists. No injected drain or synthetic watcher
    // event can rescue this turn; the bounded first-prompt probe must do so.
    const inboxLive: AgentMessage[] = [];
    inboxOnlyDrive.subscribe((message) => inboxLive.push(message));
    const inboxPublished = await waitFor(() => inboxLive.some((message) =>
      message.type === 'model-output' && message.text === 'created answer'));
    const inboxPending = await inboxOnlyDrive.getPending?.() ?? [];
    const inboxNativeUsers = inboxLive.filter((message) => message.type === 'user-message'
          && message.text === 'materialize while ACP remains pending'
          && message.clientKey === 'inbox-client'
          && message.queued === false);
    const inboxNativeAnswers = inboxLive.filter((message) =>
      message.type === 'model-output' && message.text === 'created answer');
    check('bounded materialization probe reconciles without an fs.watch event while ACP remains pending',
      materializedBeforeWatch
        && inboxPublished
        && queuedInbox?.type === 'user-message'
        && inboxNativeUsers.length === 1
        && inboxNativeUsers[0]?.type === 'user-message'
        && inboxNativeUsers[0].key === queuedInbox.key
        && inboxNativeAnswers.length === 1
        && !inboxPending.some((message) => message.type === 'user-message')
        && inboxOnlyAdapter.isDriving(inboxOnlyInfo.id),
      JSON.stringify({ materializedBeforeWatch, queuedInbox, inboxLive, inboxPending }));
    await inboxOnlyDrive.close();
    await inboxTurn.catch(() => undefined);

    const abandonedFake = writeFakeReasonixBinary(join(createRoot, 'bin-abandoned'), 'created-abandoned');
    const abandoned = new ReasonixAdapter({
      command: abandonedFake.path,
      env: { ...abandonedFake.env, REASONIX_HOME: createRoot },
      pendingCreateTimeoutMs: 50,
    });
    const abandonedInfo = await abandoned.createSession({ directory: createCwd });
    const abandonedClosed = await waitFor(() => !abandoned.isDriving(abandonedInfo.id)
      && abandonedFake.events().some((event) => event.kind === 'frame'
        && typeof event.frame === 'object'
        && event.frame !== null
        && (event.frame as { method?: unknown }).method === 'session/close'));
    check('an unclaimed empty create closes its child and releases ownership at the bounded lease',
      abandonedClosed
        && abandoned.driveConnection(abandonedInfo.id) === undefined
        && abandonedFake.events().some((event) => event.kind === 'frame'
          && typeof event.frame === 'object'
          && event.frame !== null
          && (event.frame as { method?: unknown }).method === 'session/close'));

    const mismatchFake = writeFakeReasonixBinary(join(createRoot, 'bin-mismatch'), 'created-mismatch');
    const mismatch = new ReasonixAdapter({
      command: mismatchFake.path,
      env: {
        ...mismatchFake.env,
        REASONIX_HOME: createRoot,
        FAKE_REASONIX_MATERIALIZE_ON_PROMPT: '1',
        FAKE_REASONIX_MATERIALIZED_CWD: join(createRoot, 'foreign-workspace'),
      },
      pendingCreateTimeoutMs: 2_000,
    });
    const mismatchInfo = await mismatch.createSession({
      directory: createCwd,
      model: { providerID: 'provider', modelID: 'model' },
    });
    const mismatchDrive = await mismatch.attach(mismatchInfo.id, 'resume');
    let mismatchRefused = false;
    try {
      await mismatchDrive.sendPrompt({ text: 'must fail identity verification' });
    } catch (error) {
      mismatchRefused = error instanceof Error && error.message.includes('durable identity mismatch');
    }
    check('a first-prompt durable cwd/model mismatch refuses and releases the pending owner',
      mismatchRefused
        && !mismatch.isDriving(mismatchInfo.id)
        && mismatch.driveConnection(mismatchInfo.id) === undefined);
    await mismatchDrive.close();
  } finally {
    rmSync(createRoot, { recursive: true, force: true });
  }

  writeFileSync(tree.acpMetadataPath, '{corrupt ACP metadata\n');
  const observeWithoutWorkspace = await adapter.attach(tree.id, 'observe');
  await observeWithoutWorkspace.close();
  let missingWorkspaceRefused = false;
  try {
    await adapter.attach(tree.id, 'resume');
  } catch {
    missingWorkspaceRefused = true;
  }
  check('missing or corrupt native ACP workspace metadata keeps Observe but refuses Resume',
    missingWorkspaceRefused && fake.spawnCount() === 2,
    `refused=${String(missingWorkspaceRefused)} spawns=${fake.spawnCount()}`);
} catch (error) {
  check('identity harness completed', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  tree.cleanup();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
