import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isNativeSessionRenameUnsupportedError,
  type AgentMessage,
  type HistorySourceIdentity,
} from '@cosyncing/adapter-api';
import { resolveClineAcpEnvironment } from '../src/auth.ts';
import { CLINE_NATIVE_RENAME_TIMEOUT_MS, ClineAdapter } from '../src/implementation.ts';
import { buildFakeClineAcp } from './fixtures/fake-acp.ts';

let passed = 0;
const check = (name: string, condition: unknown, detail = '') => {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};

const fake = buildFakeClineAcp({ replayPermission: true, hangRenameTitle: 'Timed out title' });
try {
  check('production native rename budget covers measured slow Cline history updates',
    CLINE_NATIVE_RENAME_TIMEOUT_MS === 30_000);
  const explicitAuthPath = join(fake.root, 'cline-openai-compatible.json');
  writeFileSync(explicitAuthPath, JSON.stringify({
    provider: 'openai-compatible', model: 'fixture/model', apiKey: 'fixture-secret',
  }), { mode: 0o600 });
  const fileAuth = await resolveClineAcpEnvironment({
    env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath },
  });
  check('Cline API-key auth uses an explicit owner-only cosyncing file, not native provider settings',
    fileAuth?.provider === 'openai-compatible' && fileAuth.model === 'fixture/model'
      && fileAuth.source === 'auth-file' && fileAuth.env.CLINE_API_KEY === 'fixture-secret');
  chmodSync(explicitAuthPath, 0o644);
  check('world-readable Cline auth files fail closed',
    await resolveClineAcpEnvironment({ env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath } }) === undefined);
  chmodSync(explicitAuthPath, 0o600);
  const providerSettings = join(fake.dataRoot, 'settings', 'providers.json');
  mkdirSync(join(fake.dataRoot, 'settings'), { recursive: true });
  writeFileSync(providerSettings, JSON.stringify({ providers: {
    'openai-compatible': { settings: { provider: 'openai-compatible', model: 'forbidden', apiKey: 'forbidden' } },
  } }), { mode: 0o600 });
  check('Cline native providers.json is never an adapter authentication source',
    await resolveClineAcpEnvironment({ env: {} }) === undefined);
  check('partial explicit Cline environment fails closed instead of falling through to the auth file',
    await resolveClineAcpEnvironment({
      env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: 'partial-secret' },
    }) === undefined
      && await resolveClineAcpEnvironment({
      env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_MODEL: 'partial/model' },
      }) === undefined
      && await resolveClineAcpEnvironment({
        env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: '' },
      }) === undefined
      && await resolveClineAcpEnvironment({
        env: { COSYNCING_CLINE_AUTH_FILE: explicitAuthPath, CLINE_API_KEY: 'x'.repeat(4_097) },
      }) === undefined);

  let storedBoundary: HistorySourceIdentity | undefined;
  let revocations = 0;
  const adapter = new ClineAdapter({
    command: fake.path,
    env: fake.env,
    homeDir: fake.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 2_000,
    promptTimeoutMs: 2_000,
    renameTimeoutMs: 100,
    nativeRenameTimeoutMs: 100,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
    recordStoredDriveBoundary: (record) => { storedBoundary = { ...record.historyBoundary }; },
    revokeStoredDriveEligibility: () => { storedBoundary = undefined; revocations += 1; },
  });
  check('fixture-only Cline candidate advertises floor-gated ACP Create/Resume',
    adapter.capabilities.integrationKind === 'acp-stdio'
      && adapter.capabilities.attachModes.includes('resume')
      && await adapter.canCreateSession());
  check('version probes disable native background self-update',
    fake.ledger().some((entry) => entry.kind === 'version-probe' && entry.noAutoUpdate === '1'));
  const modes = await adapter.listModes!();
  check('candidate exposes exact create-time permission modes', modes.map((mode) => mode.value).join(',') === 'ask,auto,plan');
  const created = await adapter.createSession!({
    directory: fake.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model', reasoningEffort: 'high' },
    permissionMode: 'plan',
  });
  check('create accepts the in-memory ACP id without fabricating a durable store row',
    created.id === fake.sessionId && created.nativeId === fake.sessionId && created.currentMode === 'plan'
      && created.currentModel?.label === 'Fixture model'
      && fake.ledger().filter((entry) => entry.kind === 'frame'
        && entry.frame?.method === 'session/load').length === 0);
  const spawn = fake.ledger().find((entry) => entry.kind === 'spawn');
  check('create propagates exact provider/model/reasoning/mode into the ACP child argv',
    spawn.argv.includes('--provider') && spawn.argv.includes('openai-compatible')
      && spawn.argv.includes('--model') && spawn.argv.includes('fixture/model')
      && spawn.argv.includes('--thinking') && spawn.argv.includes('high')
      && spawn.argv.includes('--plan') && spawn.argv.includes('false'),
    JSON.stringify(spawn.argv));
  check('adapter-spawned Cline processes disable native background self-update',
    spawn.noAutoUpdate === '1');

  const conn = await adapter.attach(fake.sessionId, 'resume');
  check('first Resume adopts the exact session/new child without spawning or loading a rival writer',
    fake.ledger().filter((entry) => entry.kind === 'spawn').length === 1
      && fake.ledger().filter((entry) => entry.kind === 'frame'
        && entry.frame?.method === 'session/load').length === 0);
  await assert.rejects(
    adapter.attach(fake.sessionId),
    /missing or its snapshot identity is unsupported/u,
  );
  check('a claimed ACP create without a durable snapshot cannot leak its provisional writer to bare Observe',
    conn.info.control?.drive.state === 'driving');
  check('Drive exposes the bounded model and mode catalogs used by broker prompt policy',
    (await conn.listModels!()).some((model) => model.providerID === 'openai-compatible' && model.modelID === 'fixture/model')
      && (await conn.listModes!()).map((mode) => mode.value).join(',') === 'ask,auto,plan');
  await assert.rejects(
    conn.sendPrompt({ text: 'wrong provider', model: { providerID: 'other', modelID: 'fixture/model' } }),
    /active native provider/u,
  );
  const live: AgentMessage[] = [];
  conn.subscribe((message) => live.push(message));
  const turn = conn.sendPrompt({ text: 'fixture prompt', clientMessageId: 'client-1' });
  for (let attempt = 0; attempt < 40 && !(await conn.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pending = await conn.getPending!();
  const firstPermissionId = pending.find((row) => row.type === 'permission-request')?.requestId;
  check('native ACP permission request reaches the shared pending surface',
    firstPermissionId === 'permission-1');
  await assert.rejects(
    conn.respondPermission(firstPermissionId!, 'approve-rule'),
    /not advertised/u,
  );
  check('a forged permission decision cannot resolve or retire the native request',
    (await conn.getPending!()).some((row) => row.type === 'permission-request' && row.requestId === firstPermissionId));
  await conn.respondPermission(firstPermissionId!, 'approve');
  check('permission reply immediately retires the shared actionable card',
    live.some((row) => row.type === 'permission-resolved'
      && row.requestId === firstPermissionId && row.decision === 'approve'));
  await turn;
  const history = await conn.getHistory();
  check('durable native echo replaces the queued row and keeps caller correlation',
    history.some((row) => row.type === 'user-message' && row.text === 'fixture prompt'
      && row.key === 'client-1' && row.clientKey === 'client-1')
      && !history.some((row) => row.type === 'user-message' && row.queued));
  check('the first prompt, not session/new, materializes the supported durable Cline row',
    history.some((row) => row.type === 'user-message' && row.text === 'fixture prompt'));
  check('ACP answer streams live and lands durably',
    live.some((row) => row.type === 'model-output' && row.delta === 'fixture answer')
      && history.filter((row) => row.type === 'model-output' && row.text === 'fixture answer').length === 1
      && !history.some((row) => row.type === 'model-output' && row.text === 'fixture '));
  check('live ACP tool, token, and context updates reach the generic client surfaces',
    live.some((row) => row.type === 'tool-call' && row.callId === 'tool-1')
      && live.some((row) => row.type === 'tool-result' && row.callId === 'tool-1' && row.isError === false)
      && live.some((row) => row.type === 'token-count' && row.cost === 0.125)
      && live.some((row) => row.type === 'metadata-update' && row.key === 'contextUsage'
        && (row.value as any)?.used === 100 && (row.value as any)?.max === 4096));
  const configured = fake.ledger().filter((entry) => entry.kind === 'frame'
    && entry.frame?.method === 'session/set_config_option').map((entry) => entry.frame.params);
  check('ACP configuration uses the exact native model, mode, and typed auto-approve options',
    configured.some((row) => row.configId === 'model' && row.value === 'fixture/model')
      && configured.some((row) => row.configId === 'mode' && row.value === 'plan')
      && configured.some((row) => row.configId === 'auto_approve' && row.type === 'boolean' && row.value === false),
    JSON.stringify(configured));
  const repeatedOne = conn.sendPrompt({ text: 'continue', clientMessageId: 'repeat-1' });
  const repeatedTwo = conn.sendPrompt({ text: 'continue', clientMessageId: 'repeat-2' });
  for (let attempt = 0; attempt < 40 && !(await conn.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const repeatedOnePermission = (await conn.getPending!()).find((row) => row.type === 'permission-request');
  await conn.respondPermission(repeatedOnePermission!.requestId, 'approve');
  await repeatedOne;
  for (let attempt = 0; attempt < 40 && !(await conn.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const repeatedTwoPermission = (await conn.getPending!()).find((row) => row.type === 'permission-request');
  await conn.respondPermission(repeatedTwoPermission!.requestId, 'approve');
  await repeatedTwo;
  const repeatedRows = (await conn.getHistory()).filter((row) => row.type === 'user-message' && row.text === 'continue');
  check('serialized duplicate-text prompts retain distinct durable caller correlations',
    repeatedRows.length === 2
      && repeatedRows.some((row) => row.type === 'user-message'
        && row.key === 'repeat-1' && row.clientKey === 'repeat-1')
      && repeatedRows.some((row) => row.type === 'user-message'
        && row.key === 'repeat-2' && row.clientKey === 'repeat-2'));
  const stoppedTurn = conn.sendPrompt({ text: 'stop fixture prompt', clientMessageId: 'client-stop' });
  for (let attempt = 0; attempt < 40 && !(await conn.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stoppedPermission = (await conn.getPending!()).find((row) => row.type === 'permission-request');
  await conn.runCommand!('stop');
  await stoppedTurn;
  check('Stop atomically retires the queued prompt and native permission request',
    !(await conn.getPending!()).some((row) => row.type === 'permission-request' || row.type === 'user-message')
      && live.some((row) => row.type === 'permission-resolved'
        && row.requestId === stoppedPermission?.requestId && row.decision === 'reject')
      && conn.info.attachMode === 'resume');
  await new Promise((resolve) => setTimeout(resolve, 25));
  check('late and replayed native permission ids remain cancelled after turn completion and Stop',
    !(await conn.getPending!()).some((row) => row.type === 'permission-request')
      && fake.ledger().some((entry) => entry.kind === 'frame'
        && entry.frame?.id === stoppedPermission?.requestId
        && entry.frame?.result?.outcome?.outcome === 'cancelled'));
  const renamed = await adapter.renameSession(fake.sessionId, 'Native Cline title');
  check('native history update renames the durable parent session',
    renamed?.title === 'Native Cline title'
      && fake.ledger().some((entry) => entry.kind === 'spawn'
        && entry.noAutoUpdate === '1'
        && entry.dataRoot === fake.dataRoot
        && entry.sessionDataRoot === join(fake.dataRoot, 'sessions')
        && entry.argv.join(' ') === `history update --session-id ${fake.sessionId} --title Native Cline title`));
  const childSuffix = 'agent_1788091200001_abcde';
  const childId = `${fake.sessionId}__${childSuffix}`;
  writeFileSync(
    join(fake.dataRoot, 'sessions', fake.sessionId, `${childSuffix}.messages.json`),
    JSON.stringify({
      version: 1,
      agent: 'subagent',
      taskType: 'subagent_task',
      sessionId: childId,
      origin: {
        source: 'cli',
        mode: 'subagent',
        sessionId: childId,
        parentThreadId: fake.sessionId,
        subagent: childSuffix,
        version: '3.0.60',
      },
      messages: [],
    }),
  );
  const fallbackAdapter = new ClineAdapter({
    command: join(fake.root, 'missing-cline'),
    env: fake.env,
    homeDir: fake.root,
  });
  const nativeSpawnsBeforeFallback = fake.ledger().filter((entry) => entry.kind === 'spawn').length;
  await assert.rejects(
    fallbackAdapter.renameSession(fake.sessionId, 'Display-only parent title'),
    isNativeSessionRenameUnsupportedError,
  );
  await assert.rejects(
    fallbackAdapter.renameSession(childId, 'Display-only child title'),
    isNativeSessionRenameUnsupportedError,
  );
  check('default-profile parents and subagents select broker display aliases before binary validation',
    fake.ledger().filter((entry) => entry.kind === 'spawn').length === nativeSpawnsBeforeFallback);
  const renameTimeoutStarted = Date.now();
  await assert.rejects(adapter.renameSession(fake.sessionId, 'Timed out title'), /timed out/u);
  check('native history update escalates from SIGTERM and remains time-bounded',
    Date.now() - renameTimeoutStarted < 2_000
      && fake.ledger().some((entry) => entry.kind === 'rename-sigterm'));
  await conn.close();
  const durableBoundary = storedBoundary && { ...storedBoundary };
  check('the first durable prompt records the exact restart ownership boundary', durableBoundary !== undefined);
  const restarted = new ClineAdapter({
    command: fake.path,
    env: fake.env,
    homeDir: fake.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 2_000,
    promptTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
    resolveStoredDriveState: () => storedBoundary
      ? { currentModel: { providerID: 'openai-compatible', modelID: 'fixture/model' }, currentMode: 'plan', historyBoundary: storedBoundary }
      : undefined,
    recordStoredDriveBoundary: (record) => { storedBoundary = { ...record.historyBoundary }; },
    revokeStoredDriveEligibility: () => { storedBoundary = undefined; revocations += 1; },
  });
  const backgroundObserve = await restarted.attach(fake.sessionId);
  check('a bare background attach is Observe-only after app reload and opens no ACP writer child',
    backgroundObserve.info.control?.drive.state === 'observing'
      && fake.ledger().filter((entry) => entry.kind === 'spawn'
        && entry.argv.includes('--acp')).length === 1);
  await backgroundObserve.close();
  const reopened = await restarted.attach(fake.sessionId, 'resume');
  check('normal close plus broker restart restores Drive only from the exact stored boundary',
    reopened.info.attachMode === 'resume' && reopened.info.control?.drive.state === 'driving'
      && reopened.info.currentModel?.label === 'Fixture model', JSON.stringify(reopened.info));
  await assert.rejects(
    reopened.sendPrompt({ text: 'fail prompt', clientMessageId: 'client-failed' }),
    /fixture delivery failed/u,
  );
  check('ambiguous Cline delivery failure demotes and retires its queued correlation',
    reopened.info.attachMode === 'observe'
      && !(await reopened.getPending!()).some((row) => row.type === 'user-message' && row.clientKey === 'client-failed'));
  await reopened.close();
  storedBoundary = durableBoundary;
  const activeRestart = new ClineAdapter({
    command: fake.path,
    env: fake.env,
    homeDir: fake.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 2_000,
    testOnlyEnableUnverifiedDrive: true,
    resolveStoredDriveState: () => storedBoundary ? { historyBoundary: storedBoundary } : undefined,
    revokeStoredDriveEligibility: () => { storedBoundary = undefined; revocations += 1; },
  });
  const activeConnection = await activeRestart.attach(fake.sessionId, 'resume');
  fake.appendForeignPrompt('foreign write while broker is offline');
  const promptsBeforeForeign = fake.ledger().filter((entry) => entry.kind === 'frame'
    && entry.frame?.method === 'session/prompt').length;
  await assert.rejects(
    activeConnection.sendPrompt({ text: 'must not double write', clientMessageId: 'client-after-foreign' }),
    /ownership changed|read-only/u,
  );
  check('a same-process foreign append terminates Drive before another native prompt is delivered',
    activeConnection.info.attachMode === 'observe' && activeConnection.info.control?.drive.supported === false
      && fake.ledger().filter((entry) => entry.kind === 'frame'
        && entry.frame?.method === 'session/prompt').length === promptsBeforeForeign);
  await activeConnection.close();
  storedBoundary = durableBoundary;
  const afterForeign = new ClineAdapter({
    command: fake.path,
    env: fake.env,
    homeDir: fake.root,
    authMethodId: 'fixture-auth',
    testOnlyEnableUnverifiedDrive: true,
    resolveStoredDriveState: () => storedBoundary ? { historyBoundary: storedBoundary } : undefined,
    revokeStoredDriveEligibility: () => { storedBoundary = undefined; revocations += 1; },
  });
  const foreignRows = await afterForeign.discoverSessions();
  check('an offline foreign append revokes durable ownership before another writer can open',
    foreignRows.find((row) => row.id === fake.sessionId)?.control?.drive.supported === false
      && storedBoundary === undefined && revocations >= 3);
} finally {
  fake.cleanup();
}

const demotedCreate = buildFakeClineAcp();
try {
  let enterPublicationGate!: () => void;
  let releasePublicationGate!: () => void;
  const publicationGateEntered = new Promise<void>((resolve) => { enterPublicationGate = resolve; });
  const publicationGate = new Promise<void>((resolve) => { releasePublicationGate = resolve; });
  const adapter = new ClineAdapter({
    command: demotedCreate.path,
    env: demotedCreate.env,
    homeDir: demotedCreate.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 500,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
    testOnlyBeforeCandidateCreatePublication: async () => {
      enterPublicationGate();
      await publicationGate;
    },
  });
  const creating = adapter.createSession!({
    directory: demotedCreate.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model' },
    permissionMode: 'ask',
  });
  await publicationGateEntered;
  demotedCreate.killLatestAcp();
  await new Promise((resolve) => setTimeout(resolve, 50));
  releasePublicationGate();
  await assert.rejects(creating, /lost its ACP child before ownership publication/u);
  await assert.rejects(
    adapter.attach(demotedCreate.sessionId, 'resume'),
    /missing or its snapshot identity is unsupported/u,
  );
  check('ACP Create cannot publish or resurrect a child that exits after its final durable-id scan',
    demotedCreate.ledger().filter((entry) => entry.kind === 'spawn').length === 1);
} finally {
  demotedCreate.cleanup();
}

const mismatched = buildFakeClineAcp({ agentName: 'not-cline' });
try {
  const adapter = new ClineAdapter({
    command: mismatched.path,
    env: mismatched.env,
    homeDir: mismatched.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 250,
    testOnlyEnableUnverifiedDrive: true,
  });
  await assert.rejects(
    adapter.createSession!({ directory: mismatched.cwd, permissionMode: 'ask' }),
    /did not identify a cline agent/u,
  );
  check('ACP initialize identity is pinned again before auth or session mutation',
    !mismatched.ledger().some((entry) => entry.kind === 'frame'
      && ['authenticate', 'session/new', 'session/load'].includes(entry.frame?.method)));
} finally {
  mismatched.cleanup();
}

const ambiguousConfig = buildFakeClineAcp({ dropConfigValue: 'auto' });
try {
  const adapter = new ClineAdapter({
    command: ambiguousConfig.path,
    env: ambiguousConfig.env,
    homeDir: ambiguousConfig.root,
    authMethodId: 'fixture-auth',
    // One budget bounds BOTH the handshake and the request under test, so a
    // value tuned to "short enough to time out" also times out `initialize`.
    // The fixture never answers the ambiguous config request, so the rejection
    // below is guaranteed by the fixture rather than by a tight clock — the
    // number only has to be small enough to keep the suite quick, and large
    // enough that a loaded machine can still complete the handshake. At 100ms
    // this failed in the gate as "acp initialize timed out after 100ms" under
    // load average 20, which is the same shared-budget defect already fixed in
    // acp-client's own suite.
    requestTimeoutMs: 1_000,
    promptTimeoutMs: 500,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
  });
  const created = await adapter.createSession!({
    directory: ambiguousConfig.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model' },
    permissionMode: 'plan',
  });
  const connection = await adapter.attach(created.id, 'resume');
  await assert.rejects(
    connection.sendPrompt({ text: 'ambiguous config', permissionMode: 'auto' }),
    /timed out/u,
  );
  check('an ambiguous native configuration timeout demotes and closes the writer',
    connection.info.attachMode === 'observe' && connection.info.control?.drive.supported === false);
  await connection.close();
} finally {
  ambiguousConfig.cleanup();
}

const emptyTurn = buildFakeClineAcp({ emptyPrompt: true });
try {
  const adapter = new ClineAdapter({
    command: emptyTurn.path,
    env: emptyTurn.env,
    homeDir: emptyTurn.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 500,
    promptTimeoutMs: 500,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
  });
  const created = await adapter.createSession!({
    directory: emptyTurn.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model' },
    permissionMode: 'ask',
  });
  const connection = await adapter.attach(created.id, 'resume');
  await assert.rejects(
    connection.sendPrompt({ text: 'native persisted only this prompt', clientMessageId: 'empty-native-turn' }),
    /exact durable semantic response/u,
  );
  check('a native end_turn with only the user echo fails closed and retires Drive ownership',
    connection.info.attachMode === 'observe'
      && connection.info.control?.drive.supported === false
      && !(await connection.getPending!()).some((row) => row.type === 'user-message'));
  await connection.close();
} finally {
  emptyTurn.cleanup();
}

const unrelatedTurn = buildFakeClineAcp({ unrelatedDurableResponse: true });
try {
  const adapter = new ClineAdapter({
    command: unrelatedTurn.path,
    env: unrelatedTurn.env,
    homeDir: unrelatedTurn.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 500,
    promptTimeoutMs: 500,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
  });
  const created = await adapter.createSession!({
    directory: unrelatedTurn.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model' },
    permissionMode: 'ask',
  });
  const connection = await adapter.attach(created.id, 'resume');
  await assert.rejects(
    connection.sendPrompt({ text: 'prompt beside an unrelated response', clientMessageId: 'unrelated-native-turn' }),
    /exact durable semantic response/u,
  );
  check('an unrelated late durable response cannot satisfy the current native turn',
    connection.info.attachMode === 'observe' && connection.info.control?.drive.supported === false);
  await connection.close();
} finally {
  unrelatedTurn.cleanup();
}

const rewrittenTurn = buildFakeClineAcp({ rewriteOnPrompt: true });
try {
  const adapter = new ClineAdapter({
    command: rewrittenTurn.path,
    env: rewrittenTurn.env,
    homeDir: rewrittenTurn.root,
    authMethodId: 'fixture-auth',
    requestTimeoutMs: 500,
    promptTimeoutMs: 500,
    testOnlyEnableUnverifiedDrive: true,
    testOnlyModels: [{ providerID: 'openai-compatible', modelID: 'fixture/model', label: 'Fixture model' }],
  });
  const created = await adapter.createSession!({
    directory: rewrittenTurn.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture/model' },
    permissionMode: 'ask',
  });
  const connection = await adapter.attach(created.id, 'resume');
  const first = connection.sendPrompt({ text: 'prime rewrite fixture', clientMessageId: 'rewrite-prime' });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const firstPermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  await connection.respondPermission(firstPermission!.requestId, 'approve');
  await first;
  const rewritten = connection.sendPrompt({ text: 'rewrite while validating', clientMessageId: 'rewrite-current' });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rewritePermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  await connection.respondPermission(rewritePermission!.requestId, 'approve');
  await assert.rejects(rewritten, /ownership changed|read-only|rewritten/u);
  check('a synchronous transcript rewrite rejects the in-flight prompt after demoting Drive',
    connection.info.attachMode === 'observe' && connection.info.control?.drive.supported === false);
  await connection.close();
} finally {
  rewrittenTurn.cleanup();
}

console.log(`\n${passed} passed, 0 failed`);
