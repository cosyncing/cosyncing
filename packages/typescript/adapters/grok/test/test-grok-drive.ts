#!/usr/bin/env bun
export {};
import { strict as assert } from 'node:assert';
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  AcpRpcError,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionPromptResult,
  type AcpSessionUpdateParams,
} from '@cosyncing/acp-client';
import type {
  AgentMessage,
  HistorySnapshotSink,
  ModelOption,
  PromptInput,
  SessionInfo,
  SlashCommand,
} from '@cosyncing/adapter-api';
import { TerminalSummaryRegistry } from '@cosyncing/adapter-api';
import {
  GROK_PERMISSION_MODES,
  GrokDriveConnection,
  parseGrokModelCatalog,
  type GrokAcpTransport,
} from '../src/drive.ts';
import {
  GrokObserveConnection,
  GrokReplayCorrelationRegistry,
  type GrokReplayCorrelation,
  type GrokTerminalSummary,
} from '../src/observe.ts';
import { discoverGrokStore, grokHistorySourceIdentity } from '../src/store.ts';
import { buildGrokFixtureTree } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeTransport implements GrokAcpTransport {
  alive = true;
  prompts: Array<{ sessionId: string; prompt: Array<{ type: string; text?: string }> }> = [];
  configurations: Array<{ model?: PromptInput['model']; mode?: string }> = [];
  cancels: string[] = [];
  closes: boolean[] = [];
  models: ModelOption[] = [{ providerID: 'xai', modelID: 'grok-4.6', label: 'Grok 4.6' }];
  commands: SlashCommand[] = [{ name: 'compact', description: 'Compact context', kind: 'prompt' }];
  onPrompt?: (params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }) => Promise<AcpSessionPromptResult>;

  initialize(): Promise<void> { return Promise.resolve(); }
  async sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult> {
    this.prompts.push(params);
    return this.onPrompt ? this.onPrompt(params) : { stopReason: 'end_turn' };
  }
  sessionCancel(sessionId: string): void { this.cancels.push(sessionId); }
  configure(model?: PromptInput['model'], mode?: string): Promise<void> {
    this.configurations.push({ ...(model ? { model } : {}), ...(mode ? { mode } : {}) });
    return Promise.resolve();
  }
  listModels(): Promise<ModelOption[]> { return Promise.resolve(this.models); }
  listCommands(): Promise<SlashCommand[]> { return Promise.resolve(this.commands); }
  close(force = false): Promise<void> {
    this.closes.push(force);
    this.alive = false;
    return Promise.resolve();
  }
}

type InternalDrive = {
  acceptUpdate(method: string, params: AcpSessionUpdateParams): void;
  requestPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult>;
};

function driveInfo(id: string, cwd: string): SessionInfo {
  return {
    id,
    nativeId: id,
    tool: 'grok',
    title: 'Grok fixture',
    cwd,
    status: 'idle',
    attachMode: 'resume',
    control: {
      drive: { state: 'driving', supported: true },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  };
}

const tree = buildGrokFixtureTree();
try {
  const restartRaceTree = buildGrokFixtureTree();
  try {
    const restartRaceSession = (await discoverGrokStore({ root: restartRaceTree.root }))[0]!;
    const expectedBoundary = await grokHistorySourceIdentity(restartRaceSession);
    restartRaceTree.append({
      timestamp: '2026-08-23T09:59:59.000Z',
      method: 'session/update',
      params: {
        sessionId: restartRaceSession.id,
        _meta: { eventId: 'foreign-race-event', promptId: 'foreign-race-prompt' },
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'foreign restart race' } },
      },
    });
    const restartRaceTransport = new FakeTransport();
    let restartRaceRefused = false;
    try {
      await GrokDriveConnection.fromTransport(
        restartRaceSession,
        driveInfo(restartRaceSession.id, restartRaceSession.cwd),
        restartRaceTransport,
        { expectedHistoryBoundary: expectedBoundary },
      );
    } catch { restartRaceRefused = true; }
    check('Drive refuses a transcript append between durable-boundary validation and ownership priming',
      restartRaceRefused && restartRaceTransport.closes.includes(true));
  } finally {
    restartRaceTree.cleanup();
  }

  const lazyTree = buildGrokFixtureTree();
  try {
    unlinkSync(lazyTree.updatesPath);
    const lazySession = (await discoverGrokStore({ root: lazyTree.root }))[0]!;
    const lazyTransport = new FakeTransport();
    const lazyConnection = await GrokDriveConnection.fromTransport(
      lazySession,
      driveInfo(lazySession.id, lazySession.cwd),
      lazyTransport,
    );
    check('a never-prompted native session may start before Grok lazily creates updates.jsonl',
      lazyConnection.driving && (await lazyConnection.getHistory()).length >= 0);
    writeFileSync(lazyTree.updatesPath, '');
    await lazyConnection.getHistory();
    check('the first empty updates.jsonl creation is an append-lineage transition, not foreign rewrite',
      lazyConnection.driving && !lazyTransport.closes.includes(true));
    lazyTransport.onPrompt = async (params) => {
      setTimeout(() => writeFileSync(lazyTree.updatesPath, `${JSON.stringify({
        timestamp: '2026-08-23T10:00:00.000Z',
        method: 'session/update',
        params: {
          sessionId: lazySession.id,
          _meta: { eventId: 'lazy-owned-event', promptId: 'lazy-owned-prompt' },
          update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0] },
        },
      })}\n`), 10);
      return { stopReason: 'end_turn' };
    };
    await lazyConnection.sendPrompt({ text: 'lazy durable prompt', clientMessageId: 'lazy-client' });
    await lazyConnection.getHistory();
    check('the first durable lazy-log row claims its queued correlation without demotion',
      lazyConnection.driving && lazyConnection.getPending().every((row) => row.type !== 'user-message'));
    unlinkSync(lazyTree.updatesPath);
    writeFileSync(lazyTree.updatesPath, `${JSON.stringify({
      timestamp: '2026-08-23T10:00:01.000Z',
      method: 'session/update',
      params: {
        sessionId: lazySession.id,
        _meta: { eventId: 'foreign-event', promptId: 'foreign-prompt' },
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'foreign replacement' } },
      },
    })}\n`);
    await lazyConnection.getHistory();
    await tick();
    check('a later lazy-log inode replacement force-demotes after the accepted creation transition',
      !lazyConnection.driving && lazyTransport.closes.includes(true));
    await lazyConnection.close();
  } finally {
    lazyTree.cleanup();
  }

  const session = (await discoverGrokStore({ root: tree.root }))[0];
  if (!session) throw new Error('fixture discovery failed');
  const transport = new FakeTransport();
  const replayCorrelations = new Map<string, GrokReplayCorrelation>();
  const connection = await GrokDriveConnection.fromTransport(
    session,
    driveInfo(session.id, session.cwd),
    transport,
    { replayCorrelations },
  );
  const internal = connection as unknown as InternalDrive;
  const live: AgentMessage[] = [];
  const stop = connection.subscribe((message) => live.push(message));

  let releasePrompt: (() => void) | undefined;
  let markPromptStarted: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  transport.onPrompt = async () => {
    markPromptStarted?.();
    await new Promise<void>((resolve) => { releasePrompt = resolve; });
    return { stopReason: 'end_turn' };
  };
  const send = connection.sendPrompt({ text: 'queued prompt', clientMessageId: 'client-1' });
  await promptStarted;
  check('prompt admission mints and replays a bounded queued row before native completion',
    connection.getPending().some((message) => message.type === 'user-message'
      && message.text === 'queued prompt' && message.queued === true && message.clientKey === 'client-1')
      && live.some((message) => message.type === 'user-message' && message.queued === true),
    JSON.stringify(connection.getPending()));
  check('the adapter serializes the exact text onto one ACP stdin',
    transport.prompts.length === 1 && transport.prompts[0]?.prompt[0]?.text === 'queued prompt',
    JSON.stringify(transport.prompts));

  const durable = {
    timestamp: '2026-08-23T10:01:00.000Z',
    method: 'session/update',
    params: {
      sessionId: session.id,
      _meta: { eventId: 'owned-event' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'queued prompt' } },
    },
  };
  internal.acceptUpdate('session/update', durable.params);
  const beforeDurableAppend = live.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.clientKey === 'client-1',
  );
  check('an event-bearing live user echo remains queued until persistence supplies stable anchors',
    beforeDurableAppend.length === 1
      && beforeDurableAppend[0]?.queued === true,
    JSON.stringify(beforeDurableAppend));
  tree.append(durable);
  await new Promise((resolve) => setTimeout(resolve, 160));
  releasePrompt?.();
  await send;
  const replay = await connection.getHistory();
  const delivered = replay.filter((message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message' && message.text === 'queued prompt');
  const correlatedLive = live.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.clientKey === 'client-1',
  );
  const deliveredLive = correlatedLive.filter((message) => message.queued === false);
  check('the durable eventId publishes one replay-stable correlated user transition',
    delivered.length === 1
      && delivered[0]?.key?.startsWith('queued:grok:') === true
      && delivered[0]?.clientKey === 'client-1'
      && delivered[0]?.queued === false
      && delivered[0]?.sentAt === Date.parse(durable.timestamp)
      && delivered[0]?.turnId?.includes(':turn-line:') === true
      && correlatedLive.length === 2
      && correlatedLive[0]?.queued === true
      && deliveredLive.length === 1
      && deliveredLive[0]?.key === delivered[0]?.key
      && deliveredLive[0]?.clientKey === delivered[0]?.clientKey
      && deliveredLive[0]?.sentAt === delivered[0]?.sentAt
      && deliveredLive[0]?.turnId === delivered[0]?.turnId
      && connection.getPending().every((message) => message.type !== 'user-message'),
    JSON.stringify({ delivered, correlatedLive }));

  tree.append({
    timestamp: '2026-08-23T10:01:00.100Z',
    method: 'session/update',
    params: {
      sessionId: session.id,
      _meta: { eventId: 'owned-answer-event', promptId: 'owned-prompt' },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'owned answer' } },
    },
  });
  tree.append({
    timestamp: '2026-08-23T10:01:00.200Z',
    method: '_x.ai/session/update',
    params: {
      sessionId: session.id,
      _meta: { eventId: 'owned-complete-event', promptId: 'owned-prompt' },
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'owned-prompt',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    },
  });
  const observerInfo = driveInfo(session.id, session.cwd);
  observerInfo.attachMode = 'observe';
  observerInfo.control = {
    drive: { state: 'observing', supported: false },
    terminalSync: { supported: false, syncAvailable: false, active: false },
  };
  const distinctObserver = new GrokObserveConnection({
    session,
    info: observerInfo,
    replayCorrelations,
  });
  const observedReplay: AgentMessage[] = [];
  const captured = await distinctObserver.captureHistorySnapshot({
    accept: (message) => {
      observedReplay.push(structuredClone(message));
      return true;
    },
  });
  const replayedOwnedUsers = observedReplay.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.text === 'queued prompt',
  );
  check('a distinct Observe capture replays the proved queued key/clientKey and native answer',
    captured !== undefined
      && replayedOwnedUsers.length === 1
      && replayedOwnedUsers[0]?.key === delivered[0]?.key
      && replayedOwnedUsers[0]?.clientKey === 'client-1'
      && replayedOwnedUsers[0]?.queued === false
      // Replay carries the COMPLETE answer in `text`; only the live path
      // streams `delta`. `settleStreamedText` in the mapping records the
      // installed measurement that separated the two.
      && observedReplay.some((message) => message.type === 'model-output'
        && message.text === 'owned answer' && message.delta === undefined),
    JSON.stringify({ replayedOwnedUsers, observedReplay }));
  await distinctObserver.close();

  let releaseIdlessPrompt: (() => void) | undefined;
  let markIdlessStarted: (() => void) | undefined;
  const idlessStarted = new Promise<void>((resolve) => { markIdlessStarted = resolve; });
  transport.onPrompt = async () => {
    markIdlessStarted?.();
    await new Promise<void>((resolve) => { releaseIdlessPrompt = resolve; });
    return { stopReason: 'end_turn' };
  };
  const idlessSend = connection.sendPrompt({ text: 'eventless prompt', clientMessageId: 'client-eventless' });
  await idlessStarted;
  const eventlessUser = {
    timestamp: '2026-08-23T10:01:01.000Z',
    method: 'session/update',
    params: {
      sessionId: session.id,
      _meta: { promptId: 'eventless-prompt' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'eventless prompt' } },
    },
  };
  const eventlessOutput = {
    timestamp: '2026-08-23T10:01:02.000Z',
    method: 'session/update',
    params: {
      sessionId: session.id,
      _meta: { promptId: 'eventless-prompt' },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'eventless answer' } },
    },
  };
  const beforeEventlessLive = live.length;
  internal.acceptUpdate('session/update', eventlessUser.params);
  internal.acceptUpdate('session/update', eventlessOutput.params);
  const eventlessNativeLive = live.slice(beforeEventlessLive);
  check('id-less live frames wait for a durable line identity instead of minting synthetic keys',
    eventlessNativeLive.every((message) =>
      !(message.type === 'user-message' && message.text === 'eventless prompt' && message.queued === false)
      && !(message.type === 'model-output' && message.delta === 'eventless answer')),
    JSON.stringify(eventlessNativeLive));
  tree.append(eventlessUser);
  tree.append(eventlessOutput);
  releaseIdlessPrompt?.();
  await idlessSend;
  const eventlessReplay = await connection.getHistory();
  const eventlessUsers = eventlessReplay.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.text === 'eventless prompt',
  );
  const eventlessAnswers = eventlessReplay.filter(
    // Replay's complete-text shape, not the live path's `delta`.
    (message): message is Extract<AgentMessage, { type: 'model-output' }> =>
      message.type === 'model-output' && message.text === 'eventless answer',
  );
  check('id-less durable replay claims the queued user once and emits output once without demotion',
    eventlessUsers.length === 1
      && eventlessUsers[0]?.key?.startsWith('queued:grok:') === true
      && eventlessUsers[0]?.clientKey === 'client-eventless'
      && eventlessAnswers.length === 1
      && connection.driving,
    JSON.stringify({ eventlessUsers, eventlessAnswers, driving: connection.driving }));

  const models = await connection.listModels();
  const modes = await connection.listModes();
  const commands = await connection.listCommands();
  check('Drive exposes only the measured model, permission-mode, and command catalogs',
    models[0]?.label === 'Grok 4.6'
      && modes.map((mode) => mode.value).join(',') === GROK_PERMISSION_MODES.map((mode) => mode.value).join(',')
      && commands[0]?.name === 'compact');

  transport.onPrompt = async (params) => {
    tree.append({
      timestamp: '2026-08-23T10:01:03.000Z',
      method: 'session/update',
      params: {
        sessionId: session.id,
        _meta: { eventId: 'compact-user', promptId: 'compact-prompt' },
        update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0] },
      },
    });
    return { stopReason: 'end_turn' };
  };
  await connection.runCommand('compact', 'now', { permissionMode: 'default' });
  check('slash commands use the same prompt queue and per-turn mode path',
    transport.prompts.at(-1)?.prompt[0]?.text === '/compact now'
      && transport.configurations.at(-1)?.mode === 'default',
    JSON.stringify({ prompts: transport.prompts, configurations: transport.configurations }));

  const permission = internal.requestPermission({
    sessionId: session.id,
    toolCall: { toolCallId: 'permission-1', title: 'Run command', rawInput: { command: 'true' } },
    options: [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ],
  });
  await tick();
  check('an unresolved ACP permission is replayable to late joiners',
    connection.getPending().some((message) => message.type === 'permission-request'
      && message.requestId === 'permission-1'
      && message.options?.includes('approve') === true
      && message.options.includes('reject')
      && !message.options.includes('approve-rule')),
    JSON.stringify(connection.getPending()));
  await assert.rejects(
    connection.respondPermission('permission-1', 'approve-session'),
    /not advertised/u,
  );
  check('a forged Grok permission decision leaves the native request pending',
    connection.getPending().some((message) => message.type === 'permission-request'
      && message.requestId === 'permission-1'));
  await connection.respondPermission('permission-1', 'approve');
  const permissionResult = await permission;
  check('permission handling maps allow-once but withholds unmeasured allow-always',
    permissionResult.outcome.outcome === 'selected' && permissionResult.outcome.optionId === 'once');

  connection.cancel();
  check('cancel uses ACP session/cancel and leaves no actionable permission',
    transport.cancels.includes(session.id) && connection.getPending().every((message) => message.type !== 'permission-request'));

  const parsed = parseGrokModelCatalog({
    availableModels: [{
      modelId: 'grok-4.6',
      name: 'Grok 4.6',
      description: 'Fixture',
      _meta: { reasoningEfforts: [{ value: 'high', label: 'High', default: true }] },
    }],
  });
  check('initialize modelState supplies labels and bounded reasoning choices without a scraped family table',
    parsed[0]?.providerID === 'xai'
      && parsed[0]?.modelID === 'grok-4.6'
      && parsed[0]?.reasoningEfforts?.[0]?.effort === 'high'
      && parsed[0]?.defaultReasoningEffort === 'high',
    JSON.stringify(parsed));
  const overLimitEfforts = parseGrokModelCatalog({
    availableModels: [{
      modelId: 'grok-bounded',
      name: 'Grok bounded',
      _meta: {
        reasoningEfforts: Array.from({ length: 33 }, (_, index) => ({
          value: index === 0 ? 'x'.repeat(1_024) : `effort-${index}`,
          label: `Effort ${index}`,
          default: index === 0,
        })),
      },
    }],
  });
  check('an over-limit reasoning catalog cannot leak an unaccepted default effort',
    overLimitEfforts[0]?.reasoningEfforts === undefined
      && overLimitEfforts[0]?.defaultReasoningEffort === undefined,
    JSON.stringify(overLimitEfforts));

  const foreign = {
    timestamp: '2026-08-23T10:02:00.000Z',
    method: 'session/update',
    params: {
      sessionId: session.id,
      _meta: { eventId: 'foreign-event', promptId: 'foreign-prompt' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'foreign prompt' } },
    },
  };
  tree.append(foreign);
  await connection.getHistory();
  check('a nonmatching durable user event demotes, cancels, and force-closes the writer',
    connection.driving === false
      && transport.closes.includes(true)
      && live.some((message) => message.type === 'notice' && message.message.includes('read-only')),
    JSON.stringify({ closes: transport.closes, cancels: transport.cancels, live }));
  const promptCountBeforeRefused = transport.prompts.length;
  let refused = false;
  try { await connection.sendPrompt({ text: 'after demotion' }); } catch { refused = true; }
  check('demotion makes later mutations fail before touching native state',
    refused && transport.prompts.length === promptCountBeforeRefused);
  stop();
  await connection.close();

  tree.writeRows(tree.rows.slice(0, -1));
  const rewriteSession = (await discoverGrokStore({ root: tree.root }))[0]!;
  const rewriteTransport = new FakeTransport();
  const rewriteReplayCorrelations = new Map<string, GrokReplayCorrelation>();
  rewriteReplayCorrelations.set('stale-native-key', {
    key: 'queued:grok:stale',
    text: 'stale prompt',
    clientKey: 'stale-client',
  });
  const rewriteConnection = await GrokDriveConnection.fromTransport(
    rewriteSession,
    driveInfo(rewriteSession.id, rewriteSession.cwd),
    rewriteTransport,
    { replayCorrelations: rewriteReplayCorrelations },
  );
  await rewriteConnection.getHistory();
  const replacement = structuredClone(tree.rows);
  const first = replacement[0]?.params as { update?: { content?: { text?: string } } } | undefined;
  if (first?.update?.content) first.update.content.text = 'replacement prompt';
  tree.writeRows(replacement);
  await rewriteConnection.getHistory();
  check('history rewrite invalidates correlations and force-demotes before another prompt',
    !rewriteConnection.driving
      && rewriteTransport.closes.includes(true)
      && rewriteReplayCorrelations.size === 0);
  await rewriteConnection.close();

  const durableOnlyTree = buildGrokFixtureTree();
  try {
    const durableOnlySession = (await discoverGrokStore({ root: durableOnlyTree.root }))[0]!;
    const durableOnlyTransport = new FakeTransport();
    const durableOnlyConnection = await GrokDriveConnection.fromTransport(
      durableOnlySession,
      driveInfo(durableOnlySession.id, durableOnlySession.cwd),
      durableOnlyTransport,
    );
    durableOnlyTransport.onPrompt = async (params) => {
      durableOnlyTree.append({
        timestamp: '2026-08-23T10:03:00.000Z',
        method: 'session/update',
        params: {
          sessionId: durableOnlySession.id,
          _meta: { eventId: 'durable-only-event', promptId: 'durable-only-prompt' },
          update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0]?.text },
        },
      });
      throw new Error('fixture child exited before live echo');
    };
    let durableOnlyRejected = false;
    try {
      await durableOnlyConnection.sendPrompt({ text: 'durable without live echo', clientMessageId: 'durable-client' });
    } catch { durableOnlyRejected = true; }
    const durableOnlyHistory = await durableOnlyConnection.getHistory();
    const durableOnlyUsers = durableOnlyHistory.filter(
      (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
        message.type === 'user-message' && message.text === 'durable without live echo',
    );
    check('durable replay claims a queued row even when the child exits before its live echo',
      durableOnlyRejected
        && durableOnlyUsers.length === 1
        && durableOnlyUsers[0]?.key?.startsWith('queued:grok:') === true
        && durableOnlyUsers[0]?.clientKey === 'durable-client'
        && durableOnlyConnection.getPending().every((message) => message.type !== 'user-message'),
      JSON.stringify(durableOnlyUsers));
    await durableOnlyConnection.close();
  } finally {
    durableOnlyTree.cleanup();
  }

  const durableFirstTree = buildGrokFixtureTree();
  try {
    const durableFirstSession = (await discoverGrokStore({ root: durableFirstTree.root }))[0]!;
    const durableFirstTransport = new FakeTransport();
    const durableFirstCorrelations = new GrokReplayCorrelationRegistry();
    const durableFirstConnection = await GrokDriveConnection.fromTransport(
      durableFirstSession,
      driveInfo(durableFirstSession.id, durableFirstSession.cwd),
      durableFirstTransport,
      { replayCorrelations: durableFirstCorrelations },
    );
    const durableFirstObserverInfo = driveInfo(durableFirstSession.id, durableFirstSession.cwd);
    durableFirstObserverInfo.attachMode = 'observe';
    durableFirstObserverInfo.control = {
      drive: { state: 'observing', supported: false },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    };
    const durableFirstObserver = new GrokObserveConnection({
      session: durableFirstSession,
      info: durableFirstObserverInfo,
      replayCorrelations: durableFirstCorrelations,
    });
    const durableFirstObserverLive: AgentMessage[] = [];
    durableFirstObserver.subscribe((message) => durableFirstObserverLive.push(message));
    await durableFirstObserver.getHistory();
    const durableFirstInternal = durableFirstConnection as unknown as InternalDrive;
    const durableFirstLive: AgentMessage[] = [];
    let resolveDurableFirstObserved: ((message: Extract<AgentMessage, { type: 'user-message' }>) => void) | undefined;
    const durableFirstObserved = new Promise<Extract<AgentMessage, { type: 'user-message' }>>((resolve) => {
      resolveDurableFirstObserved = resolve;
    });
    durableFirstConnection.subscribe((message) => {
      durableFirstLive.push(message);
      if (message.type === 'user-message'
        && message.clientKey === 'durable-first-client'
        && message.queued === false) {
        resolveDurableFirstObserved?.(message);
        resolveDurableFirstObserved = undefined;
      }
    });
    let releaseDurableFirst: (() => void) | undefined;
    let markDurableFirstStarted: (() => void) | undefined;
    const durableFirstStarted = new Promise<void>((resolve) => { markDurableFirstStarted = resolve; });
    durableFirstTransport.onPrompt = async () => {
      markDurableFirstStarted?.();
      await new Promise<void>((resolve) => { releaseDurableFirst = resolve; });
      return { stopReason: 'end_turn' };
    };
    const durableFirstSend = durableFirstConnection.sendPrompt({
      text: 'durable wins before ACP',
      clientMessageId: 'durable-first-client',
    });
    await durableFirstStarted;
    const durableFirstRow = {
      timestamp: '2026-08-23T10:03:05.000Z',
      method: 'session/update',
      params: {
        sessionId: durableFirstSession.id,
        _meta: { eventId: 'durable-first-event' },
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'durable wins before ACP' },
        },
      },
    };
    durableFirstTree.append(durableFirstRow);
    const freshHistoryInfo = structuredClone(durableFirstObserverInfo);
    const freshHistoryObserver = new GrokObserveConnection({
      session: durableFirstSession,
      info: freshHistoryInfo,
      replayCorrelations: durableFirstCorrelations,
    });
    const freshHistoryLive: AgentMessage[] = [];
    freshHistoryObserver.subscribe((message) => freshHistoryLive.push(message));
    const freshInitialHistory = await freshHistoryObserver.getHistory();
    check('a fresh Observe initial history can precede Drive correlation with the native key',
      freshInitialHistory.some((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP'
        && message.clientKey === undefined
        && message.key?.startsWith('grok:') === true));
    const freshCaptureObserver = new GrokObserveConnection({
      session: durableFirstSession,
      info: structuredClone(durableFirstObserverInfo),
      replayCorrelations: durableFirstCorrelations,
    });
    const freshCaptureLive: AgentMessage[] = [];
    const freshCaptured: AgentMessage[] = [];
    freshCaptureObserver.subscribe((message) => freshCaptureLive.push(message));
    const freshCapture = await freshCaptureObserver.captureHistorySnapshot({
      accept: (message) => {
        freshCaptured.push(structuredClone(message));
        return true;
      },
    });
    check('a fresh Observe initial snapshot can precede Drive correlation with the native key',
      freshCapture !== undefined
        && freshCaptured.some((message) => message.type === 'user-message'
          && message.text === 'durable wins before ACP'
          && message.clientKey === undefined
          && message.key?.startsWith('grok:') === true));
    await (durableFirstObserver as unknown as { drain(): Promise<void> }).drain();
    check('a distinct Observe can physically drain the durable-first row before Drive correlation exists',
      durableFirstObserverLive.some((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP'
        && message.clientKey === undefined
        && message.key?.startsWith('grok:') === true),
      JSON.stringify(durableFirstObserverLive));
    const durableFirstPhysical = await Promise.race([
      durableFirstObserved,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('durable-first watcher did not publish before ACP injection')),
        2_000,
      )),
    ]);
    check('the Grok durable-first fixture observes the physical tail row before ACP injection',
      durableFirstPhysical.turnId?.startsWith(`grok:${durableFirstSession.id}:turn-line:`) === true,
      JSON.stringify(durableFirstPhysical));
    durableFirstInternal.acceptUpdate('session/update', durableFirstRow.params);
    releaseDurableFirst?.();
    await durableFirstSend;
    const durableFirstTransitions = durableFirstLive.filter(
      (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
        message.type === 'user-message' && message.clientKey === 'durable-first-client',
    );
    check('a durable-first Grok echo suppresses the later matching ACP user transition',
      durableFirstTransitions.filter((message) => message.queued === true).length === 1
        && durableFirstTransitions.filter((message) => message.queued === false).length === 1
        && durableFirstConnection.driving,
      JSON.stringify(durableFirstTransitions));
    check('late correlation invalidates the distinct observer identity before correlated recapture',
      durableFirstObserverLive.some((message) => message.type === 'history-reset')
        && freshHistoryLive.some((message) => message.type === 'history-reset')
        && freshCaptureLive.some((message) => message.type === 'history-reset'));
    const durableFirstObserverReplay = await durableFirstObserver.getHistory();
    check('the distinct observer recaptures exactly one durable-first row under the queued key/clientKey',
      durableFirstObserverReplay.filter((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP').length === 1
      && durableFirstObserverReplay.some((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP'
        && message.clientKey === 'durable-first-client'
        && message.key === durableFirstPhysical.key));
    const freshHistoryReplay = await freshHistoryObserver.getHistory();
    const freshCapturedReplay: AgentMessage[] = [];
    await freshCaptureObserver.captureHistorySnapshot({
      accept: (message) => {
        freshCapturedReplay.push(structuredClone(message));
        return true;
      },
    });
    check('fresh history and snapshot observers recapture exactly one correlated durable-first row',
      freshHistoryReplay.filter((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP'
        && message.clientKey === 'durable-first-client'
        && message.key === durableFirstPhysical.key).length === 1
      && freshCapturedReplay.filter((message) => message.type === 'user-message'
        && message.text === 'durable wins before ACP'
        && message.clientKey === 'durable-first-client'
        && message.key === durableFirstPhysical.key).length === 1);
    await freshHistoryObserver.close();
    await freshCaptureObserver.close();
    await durableFirstObserver.close();
    await durableFirstConnection.close();
  } finally {
    durableFirstTree.cleanup();
  }

  const splitAppendTree = buildGrokFixtureTree();
  try {
    const splitAppendSession = (await discoverGrokStore({ root: splitAppendTree.root }))[0]!;
    const splitAppendTransport = new FakeTransport();
    const splitAppendConnection = await GrokDriveConnection.fromTransport(
      splitAppendSession,
      driveInfo(splitAppendSession.id, splitAppendSession.cwd),
      splitAppendTransport,
    );
    let releaseSplit: (() => void) | undefined;
    let markSplit: (() => void) | undefined;
    const splitStarted = new Promise<void>((resolve) => { markSplit = resolve; });
    splitAppendTransport.onPrompt = async (params) => {
      const encoded = `${JSON.stringify({
        timestamp: '2026-08-23T10:03:10.000Z',
        method: 'session/update',
        params: {
          sessionId: splitAppendSession.id,
          _meta: { eventId: 'split-append-event', promptId: 'split-append-prompt' },
          update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0]?.text },
        },
      })}\n`;
      const splitAt = Math.floor(encoded.length / 2);
      appendFileSync(splitAppendTree.updatesPath, encoded.slice(0, splitAt));
      markSplit?.();
      await new Promise<void>((resolve) => { releaseSplit = resolve; });
      appendFileSync(splitAppendTree.updatesPath, encoded.slice(splitAt));
      return { stopReason: 'end_turn' };
    };
    const splitSend = splitAppendConnection.sendPrompt({
      text: 'split append prompt',
      clientMessageId: 'split-append-client',
    });
    await splitStarted;
    const splitDuring = await splitAppendConnection.getHistory();
    check('an owned active turn defers an unterminated split append without releasing Drive',
      splitAppendConnection.driving
        && splitDuring.some((message) => message.type === 'user-message'
          && message.text === 'split append prompt'
          && message.queued === true));
    releaseSplit?.();
    await splitSend;
    const splitReplay = await splitAppendConnection.getHistory();
    const splitUsers = splitReplay.filter(
      (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
        message.type === 'user-message' && message.text === 'split append prompt',
    );
    check('completion of the split append preserves correlation and the writer',
      splitAppendConnection.driving
        && splitUsers.length === 1
        && splitUsers[0]?.clientKey === 'split-append-client'
        && splitUsers[0]?.queued === false,
      JSON.stringify(splitUsers));
    await splitAppendConnection.close();
  } finally {
    splitAppendTree.cleanup();
  }

  const recoverableTree = buildGrokFixtureTree();
  try {
    const recoverableSession = (await discoverGrokStore({ root: recoverableTree.root }))[0]!;
    const recoverableTransport = new FakeTransport();
    const recoverableConnection = await GrokDriveConnection.fromTransport(
      recoverableSession,
      driveInfo(recoverableSession.id, recoverableSession.cwd),
      recoverableTransport,
    );
    let promptNumber = 0;
    recoverableTransport.onPrompt = async (params) => {
      promptNumber += 1;
      const durableRow = {
        timestamp: `2026-08-23T10:03:${20 + promptNumber}.000Z`,
        method: 'session/update',
        params: {
          sessionId: recoverableSession.id,
          _meta: { eventId: `recoverable-event-${promptNumber}`, promptId: `recoverable-prompt-${promptNumber}` },
          update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0]?.text },
        },
      };
      if (promptNumber === 1) {
        setTimeout(() => recoverableTree.append(durableRow), 80);
        throw new AcpRpcError(429, 'fixture backend quota exhausted');
      }
      recoverableTree.append(durableRow);
      return { stopReason: 'end_turn' };
    };
    await assert.rejects(
      recoverableConnection.sendPrompt({ text: 'rejected once', clientMessageId: 'recoverable-client-1' }),
      /quota exhausted/u,
    );
    const afterRejected = await recoverableConnection.getHistory();
    check('a correlated ACP backend rejection reconciles durable history without revoking Drive',
      recoverableConnection.driving
        && !recoverableTransport.closes.includes(true)
        && afterRejected.some((message) => message.type === 'user-message'
          && message.text === 'rejected once'
          && message.clientKey === 'recoverable-client-1'
          && message.queued === false));
    await recoverableConnection.sendPrompt({ text: 'accepted next', clientMessageId: 'recoverable-client-2' });
    const afterRetry = await recoverableConnection.getHistory();
    check('the same Grok writer accepts the prompt after a recoverable ACP rejection',
      recoverableConnection.driving
        && recoverableTransport.prompts.length === 2
        && afterRetry.some((message) => message.type === 'user-message'
          && message.text === 'accepted next'
          && message.clientKey === 'recoverable-client-2'
          && message.queued === false));
    await recoverableConnection.close();
  } finally {
    recoverableTree.cleanup();
  }

  // The installed v80 shape: a 429 rejects `session/prompt` after Grok has
  // already written the turn's `retry_state` rows and a `turn_completed`
  // carrying `stop_reason: "rate_limit"`. The drive published a notice and
  // `status: idle` and no terminal row, so the turn had no terminal state live
  // and one on reattach -- and the Stop that followed found no run summary to
  // settle against and timed out.
  const rejectedTerminalTree = buildGrokFixtureTree();
  try {
    const rejectedSession = (await discoverGrokStore({ root: rejectedTerminalTree.root }))[0]!;
    const rejectedTransport = new FakeTransport();
    const rejectedConnection = await GrokDriveConnection.fromTransport(
      rejectedSession,
      driveInfo(rejectedSession.id, rejectedSession.cwd),
      rejectedTransport,
    );
    const rejectedPromptId = 'rejected-prompt-988ae2bb';
    rejectedTransport.onPrompt = async (params) => {
      rejectedTerminalTree.append({
        timestamp: '2026-08-23T10:06:00.000Z',
        method: 'session/update',
        params: {
          sessionId: rejectedSession.id,
          _meta: { eventId: 'rejected-user' },
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: params.prompt[0]?.text } },
        },
      });
      rejectedTerminalTree.append({
        timestamp: '2026-08-23T10:06:01.000Z',
        method: 'session/update',
        params: {
          sessionId: rejectedSession.id,
          _meta: { eventId: 'rejected-retry' },
          update: {
            sessionUpdate: 'retry_state',
            type: 'exhausted',
            reason: 'API error (status 429 Too Many Requests): subscription:free-usage-exhausted',
          },
        },
      });
      rejectedTerminalTree.append({
        timestamp: '2026-08-23T10:06:02.000Z',
        method: '_x.ai/session/update',
        params: {
          sessionId: rejectedSession.id,
          _meta: { eventId: 'rejected-terminal' },
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: rejectedPromptId,
            stop_reason: 'rate_limit',
            elapsed_ms: 2243,
          },
        },
      });
      throw new AcpRpcError(429, 'fixture free usage exhausted');
    };
    const rejectedLive: AgentMessage[] = [];
    rejectedConnection.subscribe((message) => rejectedLive.push(message));
    await assert.rejects(
      rejectedConnection.sendPrompt({ text: 'rate limited prompt', clientMessageId: 'rejected-client' }),
      /free usage exhausted/u,
    );
    const rejectedTurnId = `grok:${rejectedSession.id}:turn:${rejectedPromptId}`;
    const rejectedSummaries = rejectedLive.filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
      message.type === 'run-summary');
    const rejectedPromptRow = rejectedLive.filter((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.queued !== true).at(-1);
    check('a turn Grok rejected still reports the terminal state its log recorded',
      rejectedSummaries.length === 1
        && rejectedSummaries[0]?.status === 'error'
        && rejectedSummaries[0].turnId === rejectedTurnId
        && rejectedSummaries[0].userMessageKey === rejectedPromptRow?.key
        && rejectedPromptRow?.turnId === rejectedTurnId,
      JSON.stringify({ rejectedSummaries, rejectedPromptRow }));
    check('a rejected Grok turn keeps its writer',
      rejectedConnection.driving && !rejectedTransport.closes.includes(true));
    await rejectedConnection.close();
  } finally {
    rejectedTerminalTree.cleanup();
  }

  const missingRejectedEchoTree = buildGrokFixtureTree();
  try {
    const missingRejectedEchoSession = (await discoverGrokStore({ root: missingRejectedEchoTree.root }))[0]!;
    const missingRejectedEchoTransport = new FakeTransport();
    const missingRejectedEchoConnection = await GrokDriveConnection.fromTransport(
      missingRejectedEchoSession,
      driveInfo(missingRejectedEchoSession.id, missingRejectedEchoSession.cwd),
      missingRejectedEchoTransport,
    );
    missingRejectedEchoTransport.onPrompt = async () => {
      throw new AcpRpcError(429, 'fixture rejection without durable echo');
    };
    await assert.rejects(
      missingRejectedEchoConnection.sendPrompt({ text: 'missing durable echo', clientMessageId: 'missing-echo-client' }),
      /rejection without durable echo/u,
    );
    check('a rejected prompt with no exact durable echo fails closed and keeps its pending correlation',
      !missingRejectedEchoConnection.driving
        && missingRejectedEchoTransport.closes.includes(true)
        && missingRejectedEchoConnection.getPending().some((message) => message.type === 'user-message'
          && message.text === 'missing durable echo'
          && message.clientKey === 'missing-echo-client'));
    await missingRejectedEchoConnection.close();
  } finally {
    missingRejectedEchoTree.cleanup();
  }

  const foreignRejectedEchoTree = buildGrokFixtureTree();
  try {
    const foreignRejectedEchoSession = (await discoverGrokStore({ root: foreignRejectedEchoTree.root }))[0]!;
    const foreignRejectedEchoTransport = new FakeTransport();
    const foreignRejectedEchoConnection = await GrokDriveConnection.fromTransport(
      foreignRejectedEchoSession,
      driveInfo(foreignRejectedEchoSession.id, foreignRejectedEchoSession.cwd),
      foreignRejectedEchoTransport,
    );
    foreignRejectedEchoTransport.onPrompt = async () => {
      foreignRejectedEchoTree.append({
        timestamp: '2026-08-23T10:03:40.000Z',
        method: 'session/update',
        params: {
          sessionId: foreignRejectedEchoSession.id,
          _meta: { eventId: 'foreign-rejected-event', promptId: 'foreign-rejected-prompt' },
          update: { sessionUpdate: 'user_message_chunk', content: 'foreign while rejected' },
        },
      });
      throw new AcpRpcError(429, 'fixture rejection with foreign append');
    };
    await assert.rejects(
      foreignRejectedEchoConnection.sendPrompt({ text: 'owned rejected prompt', clientMessageId: 'foreign-rejected-client' }),
      /rejection with foreign append/u,
    );
    check('foreign durable history during ACP rejection demotes without erasing the pending correlation',
      !foreignRejectedEchoConnection.driving
        && foreignRejectedEchoTransport.closes.includes(true)
        && foreignRejectedEchoConnection.getPending().some((message) => message.type === 'user-message'
          && message.text === 'owned rejected prompt'
          && message.clientKey === 'foreign-rejected-client'));
    await foreignRejectedEchoConnection.close();
  } finally {
    foreignRejectedEchoTree.cleanup();
  }

  const partialTree = buildGrokFixtureTree();
  try {
    appendFileSync(partialTree.updatesPath, '{"partial":');
    const partialSession = (await discoverGrokStore({ root: partialTree.root }))[0]!;
    const partialTransport = new FakeTransport();
    let partialRefused = false;
    try {
      await GrokDriveConnection.fromTransport(
        partialSession,
        driveInfo(partialSession.id, partialSession.cwd),
        partialTransport,
      );
    } catch { partialRefused = true; }
    check('Drive refuses and closes before claiming an unterminated pre-ownership record',
      partialRefused && partialTransport.closes.includes(true));
  } finally {
    partialTree.cleanup();
  }

  const postOwnershipPartialTree = buildGrokFixtureTree();
  try {
    const postOwnershipSession = (await discoverGrokStore({ root: postOwnershipPartialTree.root }))[0]!;
    const postOwnershipTransport = new FakeTransport();
    const postOwnershipConnection = await GrokDriveConnection.fromTransport(
      postOwnershipSession,
      driveInfo(postOwnershipSession.id, postOwnershipSession.cwd),
      postOwnershipTransport,
    );
    appendFileSync(postOwnershipPartialTree.updatesPath, '{"partial":');
    await postOwnershipConnection.getHistory();
    check('a new unterminated tail immediately demotes an established Drive connection',
      !postOwnershipConnection.driving && postOwnershipTransport.closes.includes(true));
    await postOwnershipConnection.close();
  } finally {
    postOwnershipPartialTree.cleanup();
  }

  const corruptTree = buildGrokFixtureTree();
  try {
    const corruptSession = (await discoverGrokStore({ root: corruptTree.root }))[0]!;
    const corruptTransport = new FakeTransport();
    const corruptConnection = await GrokDriveConnection.fromTransport(
      corruptSession,
      driveInfo(corruptSession.id, corruptSession.cwd),
      corruptTransport,
    );
    appendFileSync(corruptTree.updatesPath, 'not-json\n');
    const captureSink: HistorySnapshotSink = { accept: () => true };
    const corruptCapture = await corruptConnection.captureHistorySnapshot(captureSink);
    check('snapshot capture of a new malformed row immediately demotes an established Drive connection',
      corruptCapture === undefined
        && !corruptConnection.driving
        && corruptTransport.closes.includes(true));
    await corruptConnection.close();
  } finally {
    corruptTree.cleanup();
  }

  const preConfigureTree = buildGrokFixtureTree();
  try {
    const preConfigureSession = (await discoverGrokStore({ root: preConfigureTree.root }))[0]!;
    const preConfigureTransport = new FakeTransport();
    const preConfigureConnection = await GrokDriveConnection.fromTransport(
      preConfigureSession,
      driveInfo(preConfigureSession.id, preConfigureSession.cwd),
      preConfigureTransport,
    );
    preConfigureTree.append({
      timestamp: '2026-08-23T10:04:00.000Z',
      method: 'session/update',
      params: {
        sessionId: preConfigureSession.id,
        _meta: { eventId: 'foreign-before-configure', promptId: 'foreign-before-configure' },
        update: { sessionUpdate: 'user_message_chunk', content: 'foreign before configure' },
      },
    });
    let rejectedBeforeConfigure = false;
    try {
      await preConfigureConnection.sendPrompt({ text: 'must not configure', permissionMode: 'default' });
    } catch { rejectedBeforeConfigure = true; }
    check('prompt admission rechecks ownership before configuring or touching the ACP child',
      rejectedBeforeConfigure
        && preConfigureTransport.configurations.length === 0
        && preConfigureTransport.prompts.length === 0
        && !preConfigureConnection.driving,
      JSON.stringify({ configurations: preConfigureTransport.configurations, prompts: preConfigureTransport.prompts }));
    await preConfigureConnection.close();
  } finally {
    preConfigureTree.cleanup();
  }

  const fallbackSummaryTree = buildGrokFixtureTree();
  try {
    const fallbackSession = (await discoverGrokStore({ root: fallbackSummaryTree.root }))[0]!;
    const fallbackTransport = new FakeTransport();
    const fallbackCorrelations = new Map<string, GrokReplayCorrelation>();
    const fallbackTerminalSummaries = new TerminalSummaryRegistry<GrokTerminalSummary>();
    const storedSummaries: GrokTerminalSummary[] = [];
    fallbackTransport.onPrompt = async (params) => {
      const prompt = params.prompt[0]?.text ?? '';
      fallbackSummaryTree.append({
        timestamp: '2026-08-23T10:04:00.000Z',
        method: 'session/update',
        params: {
          sessionId: fallbackSession.id,
          _meta: { eventId: 'fallback-user' },
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } },
        },
      });
      fallbackSummaryTree.append({
        timestamp: '2026-08-23T10:04:01.000Z',
        method: 'session/update',
        params: {
          sessionId: fallbackSession.id,
          _meta: { eventId: 'fallback-answer' },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fallback answer' } },
        },
      });
      return { stopReason: 'end_turn' };
    };
    const fallbackConnection = await GrokDriveConnection.fromTransport(
      fallbackSession,
      driveInfo(fallbackSession.id, fallbackSession.cwd),
      fallbackTransport,
      {
        replayCorrelations: fallbackCorrelations,
        terminalSummaryRegistry: fallbackTerminalSummaries,
        onHistoryBoundary: (_identity, terminalSummary) => {
          if (terminalSummary) storedSummaries.push(structuredClone(terminalSummary));
        },
      },
    );
    const fallbackObserverInfo = driveInfo(fallbackSession.id, fallbackSession.cwd);
    fallbackObserverInfo.attachMode = 'observe';
    fallbackObserverInfo.control = {
      drive: { state: 'observing', supported: false },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    };
    const fallbackObserver = new GrokObserveConnection({
      session: fallbackSession,
      info: fallbackObserverInfo,
      replayCorrelations: fallbackCorrelations,
      terminalSummaryRegistry: fallbackTerminalSummaries,
    });
    await fallbackObserver.getHistory();
    const fallbackObserverLive: AgentMessage[] = [];
    fallbackObserver.subscribe((message) => fallbackObserverLive.push(message));
    const fallbackLive: AgentMessage[] = [];
    fallbackConnection.subscribe((message) => fallbackLive.push(message));
    await fallbackConnection.sendPrompt({
      text: 'native log omits turn_completed',
      clientMessageId: 'fallback-client',
    });
    const fallbackHistory = await fallbackConnection.getHistory();
    const fallbackObserverHistory = await fallbackObserver.getHistory();
    const fallbackTerminal = fallbackHistory.filter((message) =>
      message.type === 'run-summary' && message.turnId === storedSummaries[0]?.turnId);
    check('ACP completion plus one settled durable Grok turn emits and stores one fallback run summary',
      storedSummaries.length === 1
        && storedSummaries[0]?.status === 'done'
        && fallbackTerminal.length === 1
        && fallbackLive.filter((message) => message.type === 'run-summary'
          && message.key === storedSummaries[0]?.key).length === 1
        && fallbackObserverLive.some((message) => message.type === 'history-reset')
        && fallbackObserverHistory.filter((message) => message.type === 'run-summary'
          && message.key === storedSummaries[0]?.key).length === 1,
      JSON.stringify({ storedSummaries, fallbackTerminal, fallbackObserverLive, fallbackObserverHistory }));

    fallbackSummaryTree.append({
      timestamp: '2026-08-23T10:04:02.000Z',
      method: '_x.ai/session/update',
      params: {
        sessionId: fallbackSession.id,
        _meta: { eventId: 'fallback-native-complete' },
        update: {
          sessionUpdate: 'turn_completed',
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    });
    const nativeLateHistory = await fallbackConnection.getHistory();
    check('an id-less late native Grok completion replaces its exact causal fallback',
      !nativeLateHistory.some((message) => message.type === 'run-summary'
        && message.key === storedSummaries[0]?.key)
        && nativeLateHistory.filter((message) => message.type === 'run-summary'
          && message.key?.includes('fallback-native-complete')).length === 1);

    const restartedHistory = await fallbackObserver.getHistory();
    check('a Grok Observe suppresses the stored fallback when its id-less native turn becomes terminal',
      restartedHistory.filter((message) => message.type === 'run-summary'
        && message.key?.includes('fallback-native-complete')).length === 1
        && !restartedHistory.some((message) => message.type === 'run-summary'
          && message.key === storedSummaries[0]?.key));
    await fallbackObserver.close();
    await fallbackConnection.close();
  } finally {
    fallbackSummaryTree.cleanup();
  }

  // The exact record shape the installed v79 Grok transcript has, read off
  // `updates.jsonl`: an id-less `user_message_chunk`, then rows carrying
  // `_meta.promptId`, then a `turn_completed` naming the prompt in
  // `update.prompt_id` and carrying the turn's ONLY token usage. Every earlier
  // fixture in this file omits the prompt id entirely, which is why the whole
  // divergence below went unmeasured here and had to be found on the wire.
  const nativeUsageTree = buildGrokFixtureTree();
  try {
    const usageSession = (await discoverGrokStore({ root: nativeUsageTree.root }))[0]!;
    const usagePromptId = 'usage-prompt-67962d4b';
    const usageTransport = new FakeTransport();
    const usageCorrelations = new Map<string, GrokReplayCorrelation>();
    const usageSummaries = new TerminalSummaryRegistry<GrokTerminalSummary>();
    usageTransport.onPrompt = async (params) => {
      const prompt = params.prompt[0]?.text ?? '';
      nativeUsageTree.append({
        timestamp: '2026-08-23T10:05:00.000Z',
        method: 'session/update',
        params: {
          sessionId: usageSession.id,
          _meta: { eventId: 'usage-user' },
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } },
        },
      });
      nativeUsageTree.append({
        timestamp: '2026-08-23T10:05:01.000Z',
        method: 'session/update',
        params: {
          sessionId: usageSession.id,
          _meta: { eventId: 'usage-answer', promptId: usagePromptId },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'usage answer' } },
        },
      });
      nativeUsageTree.append({
        timestamp: '2026-08-23T10:05:02.000Z',
        method: '_x.ai/session/update',
        params: {
          sessionId: usageSession.id,
          _meta: { eventId: 'usage-terminal', promptId: usagePromptId },
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: usagePromptId,
            stop_reason: 'end_turn',
            usage: { inputTokens: 16067, outputTokens: 67, cachedReadTokens: 128 },
          },
        },
      });
      return { stopReason: 'end_turn' };
    };
    const usageStored: GrokTerminalSummary[] = [];
    const usageConnection = await GrokDriveConnection.fromTransport(
      usageSession,
      driveInfo(usageSession.id, usageSession.cwd),
      usageTransport,
      {
        replayCorrelations: usageCorrelations,
        terminalSummaryRegistry: usageSummaries,
        onHistoryBoundary: (_identity, terminalSummary) => {
          if (terminalSummary) usageStored.push(structuredClone(terminalSummary));
        },
      },
    );
    const usageLive: AgentMessage[] = [];
    usageConnection.subscribe((message) => usageLive.push(message));
    await usageConnection.sendPrompt({ text: 'usage prompt', clientMessageId: 'usage-client' });
    const usageLiveSummaries = usageLive.filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
      message.type === 'run-summary');
    const usageLiveUsers = usageLive.filter((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.queued !== true);
    const usageTurnId = `grok:${usageSession.id}:turn:${usagePromptId}`;
    // Before this, the drive published a synthesized `:acp-terminal` row instead
    // and Grok's own summary was swallowed: the settle read moves the tail cursor
    // past the line that carries it, so nothing else ever emits it, and the turn
    // published no attributable usage at all on the wire.
    check('a completed Grok turn publishes its native summary, tokens and all',
      usageLiveSummaries.length === 1
        && usageLiveSummaries[0]?.turnId === usageTurnId
        && usageLiveSummaries[0].key.includes('usage-terminal')
        && usageLiveSummaries[0].tokens?.input === 16067
        && usageLiveSummaries[0].tokens?.output === 67
        && usageLiveSummaries[0].tokens?.cacheRead === 128,
      JSON.stringify(usageLiveSummaries));
    const usagePromptKey = usageLiveUsers.at(-1)?.key;
    check('the summary names the key its prompt was emitted under, not the native one',
      typeof usagePromptKey === 'string'
        && usagePromptKey.startsWith('queued:grok:')
        && usageLiveSummaries[0]?.userMessageKey === usagePromptKey,
      JSON.stringify({ usagePromptKey, anchor: usageLiveSummaries[0]?.userMessageKey }));
    check('the prompt ends on the same turn as the summary that closes it',
      usageLiveUsers.at(-1)?.turnId === usageTurnId,
      JSON.stringify(usageLiveUsers.map((message) => ({ key: message.key, turnId: message.turnId }))));

    const usageObserver = new GrokObserveConnection({
      session: usageSession,
      info: { ...driveInfo(usageSession.id, usageSession.cwd), attachMode: 'observe' },
      replayCorrelations: usageCorrelations,
      terminalSummaryRegistry: usageSummaries,
    });
    const usageReplay = await usageObserver.getHistory();
    const replaySummary = usageReplay.find((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
      message.type === 'run-summary' && message.turnId === usageTurnId);
    const replayPrompt = usageReplay.find((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.text === 'usage prompt');
    check('a reattaching reader re-derives the same anchor, turn and usage',
      replaySummary?.userMessageKey === usagePromptKey
        && replayPrompt?.key === usagePromptKey
        && replayPrompt?.turnId === usageTurnId
        && replaySummary?.tokens?.input === 16067,
      JSON.stringify({ replaySummary, replayPrompt }));
    await usageObserver.close();
    await usageConnection.close();
  } finally {
    nativeUsageTree.cleanup();
  }

  const summaryRaceTree = buildGrokFixtureTree();
  try {
    const summaryRaceSession = (await discoverGrokStore({ root: summaryRaceTree.root }))[0]!;
    const expectedSummaryBoundary = await grokHistorySourceIdentity(summaryRaceSession);
    if (!expectedSummaryBoundary) throw new Error('missing Grok summary-race boundary');
    let summaryBoundaryInvalid = false;
    let summaryRaceMutated = false;
    const staleSummary: GrokTerminalSummary = {
      type: 'run-summary',
      key: 'stale-grok-terminal',
      turnId: 'stale-grok-turn',
      status: 'done',
      source: 'grok',
    };
    const summaryRaceObserver = new GrokObserveConnection({
      session: summaryRaceSession,
      info: {
        ...driveInfo(summaryRaceSession.id, summaryRaceSession.cwd),
        attachMode: 'observe',
      },
      expectedTerminalSummaryBoundary: expectedSummaryBoundary,
      terminalSummaries: [staleSummary],
      onTerminalSummaryBoundaryInvalid: () => { summaryBoundaryInvalid = true; },
      snapshotTestHook: () => {
        if (summaryRaceMutated) return;
        summaryRaceMutated = true;
        summaryRaceTree.append({
          timestamp: '2026-08-23T10:04:10.000Z',
          method: 'session/update',
          params: {
            sessionId: summaryRaceSession.id,
            _meta: { eventId: 'summary-race-foreign' },
            update: { sessionUpdate: 'user_message_chunk', content: 'foreign replacement' },
          },
        });
      },
    });
    const summaryRaceHistory = await summaryRaceObserver.getHistory();
    check('Grok drops stored terminal summaries when history changes before the first stable Observe read',
      summaryBoundaryInvalid
        && !summaryRaceHistory.some((message) => message.type === 'run-summary'
          && message.key === staleSummary.key));
    await summaryRaceObserver.close();
  } finally {
    summaryRaceTree.cleanup();
  }

  const nativeOnlyTurnTree = buildGrokFixtureTree();
  try {
    const nativeOnlySession = (await discoverGrokStore({ root: nativeOnlyTurnTree.root }))[0]!;
    const nativeAKey = `grok:${nativeOnlySession.id}:event:native-only-a-user`;
    nativeOnlyTurnTree.append({
      timestamp: '2026-08-23T10:04:20.000Z',
      method: 'session/update',
      params: {
        sessionId: nativeOnlySession.id,
        _meta: { eventId: 'native-only-a-user' },
        update: { sessionUpdate: 'user_message_chunk', content: 'stored fallback a' },
      },
    });
    nativeOnlyTurnTree.append({
      timestamp: '2026-08-23T10:04:21.000Z',
      method: 'session/update',
      params: {
        sessionId: nativeOnlySession.id,
        _meta: { eventId: 'native-only-a-answer' },
        update: { sessionUpdate: 'agent_message_chunk', content: 'a answer' },
      },
    });
    const nativeOnlyBoundary = await grokHistorySourceIdentity(nativeOnlySession);
    if (!nativeOnlyBoundary) throw new Error('missing native-only replay boundary');
    const storedA: GrokTerminalSummary = {
      type: 'run-summary',
      key: `${nativeAKey}:acp-terminal`,
      turnId: `grok:${nativeOnlySession.id}:turn-line:9`,
      userMessageKey: nativeAKey,
      status: 'done',
      source: 'grok',
    };
    const nativeOnlyObserver = new GrokObserveConnection({
      session: nativeOnlySession,
      info: { ...driveInfo(nativeOnlySession.id, nativeOnlySession.cwd), attachMode: 'observe' },
      expectedTerminalSummaryBoundary: nativeOnlyBoundary,
      terminalSummaries: [storedA],
    });
    await nativeOnlyObserver.getHistory();
    nativeOnlyTurnTree.append({
      timestamp: '2026-08-23T10:04:22.000Z',
      method: 'session/update',
      params: {
        sessionId: nativeOnlySession.id,
        _meta: { eventId: 'native-only-b-user' },
        update: { sessionUpdate: 'user_message_chunk', content: 'native-only b' },
      },
    });
    nativeOnlyTurnTree.append({
      timestamp: '2026-08-23T10:04:23.000Z',
      method: '_x.ai/session/update',
      params: {
        sessionId: nativeOnlySession.id,
        _meta: { eventId: 'native-only-b-terminal' },
        update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
      },
    });
    const nativeOnlyHistory = await nativeOnlyObserver.getHistory();
    check('a later native-only user keeps its id-less terminal from consuming an older stored Grok fallback',
      nativeOnlyHistory.filter((message) => message.type === 'run-summary'
        && message.key === storedA.key).length === 1
        && nativeOnlyHistory.some((message) => message.type === 'run-summary'
          && message.key?.includes('native-only-b-terminal')
          && message.userMessageKey === undefined
          && message.turnId !== storedA.turnId));
    await nativeOnlyObserver.close();
  } finally {
    nativeOnlyTurnTree.cleanup();
  }

  const delayedIdlessTree = buildGrokFixtureTree();
  try {
    const delayedSession = (await discoverGrokStore({ root: delayedIdlessTree.root }))[0]!;
    const delayedTransport = new FakeTransport();
    const delayedStored: GrokTerminalSummary[] = [];
    let turn = 'a';
    delayedTransport.onPrompt = async (params) => {
      const prompt = params.prompt[0]?.text ?? '';
      const event = turn;
      delayedIdlessTree.append({
        timestamp: event === 'a' ? '2026-08-23T10:05:00.000Z' : '2026-08-23T10:05:02.000Z',
        method: 'session/update',
        params: {
          sessionId: delayedSession.id,
          _meta: { eventId: `delayed-${event}-user` },
          update: { sessionUpdate: 'user_message_chunk', content: prompt },
        },
      });
      if (event === 'b') {
        delayedIdlessTree.append({
          timestamp: '2026-08-23T10:05:03.000Z',
          method: '_x.ai/session/update',
          params: {
            sessionId: delayedSession.id,
            _meta: { eventId: 'delayed-a-native-terminal' },
            update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
          },
        });
      }
      delayedIdlessTree.append({
        timestamp: event === 'a' ? '2026-08-23T10:05:01.000Z' : '2026-08-23T10:05:04.000Z',
        method: 'session/update',
        params: {
          sessionId: delayedSession.id,
          _meta: { eventId: `delayed-${event}-answer` },
          update: { sessionUpdate: 'agent_message_chunk', content: `${event} answer` },
        },
      });
      return { stopReason: 'end_turn' };
    };
    const delayedConnection = await GrokDriveConnection.fromTransport(
      delayedSession,
      driveInfo(delayedSession.id, delayedSession.cwd),
      delayedTransport,
      {
        onHistoryBoundary: (_identity, terminalSummary) => {
          if (terminalSummary) delayedStored.push(structuredClone(terminalSummary));
        },
      },
    );
    await delayedConnection.sendPrompt({ text: 'turn a', clientMessageId: 'delayed-client-a' });
    turn = 'b';
    await delayedConnection.sendPrompt({ text: 'turn b', clientMessageId: 'delayed-client-b' });
    const delayedHistory = await delayedConnection.getHistory();
    const delayedFallbacks = delayedHistory.filter(
      (message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
      message.type === 'run-summary' && message.key?.endsWith(':acp-terminal'));
    // Each fallback must name the key of ITS OWN prompt -- and name it in the
    // form a reader holds, which is the key the row was emitted under, not the
    // native event key the row no longer carries.
    const delayedPromptKey = (text: string) => delayedHistory.find(
      (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
        message.type === 'user-message' && message.text === text)?.key;
    check('a delayed id-less native terminal after the next user cannot steal that newer Grok turn',
      delayedStored.length === 2
        && delayedFallbacks.length === 2
        && delayedPromptKey('turn a') !== delayedPromptKey('turn b')
        && delayedFallbacks.some((message) => message.userMessageKey === delayedPromptKey('turn a'))
        && delayedFallbacks.some((message) => message.userMessageKey === delayedPromptKey('turn b'))
        && delayedHistory.some((message) => message.type === 'run-summary'
          && message.key?.includes('delayed-a-native-terminal')
          && message.userMessageKey === undefined
          && !delayedFallbacks.some((fallback) => fallback.turnId === message.turnId)),
      JSON.stringify({ delayedStored, delayedFallbacks }));
    await delayedConnection.close();
  } finally {
    delayedIdlessTree.cleanup();
  }

  const stopTree = buildGrokFixtureTree();
  try {
    const stopSession = (await discoverGrokStore({ root: stopTree.root }))[0]!;
    const stopTransport = new FakeTransport();
    const stopConnection = await GrokDriveConnection.fromTransport(
      stopSession,
      driveInfo(stopSession.id, stopSession.cwd),
      stopTransport,
    );
    let releaseActive: (() => void) | undefined;
    let markActive: (() => void) | undefined;
    const activeStarted = new Promise<void>((resolve) => { markActive = resolve; });
    stopTransport.onPrompt = async (params) => {
      markActive?.();
      await new Promise<void>((resolve) => { releaseActive = resolve; });
      stopTree.append({
        timestamp: '2026-08-23T10:05:00.000Z',
        method: 'session/update',
        params: {
          sessionId: stopSession.id,
          _meta: { eventId: 'cancelled-active', promptId: 'cancelled-active' },
          update: { sessionUpdate: 'user_message_chunk', content: params.prompt[0]?.text },
        },
      });
      return { stopReason: 'cancelled' };
    };
    const active = stopConnection.sendPrompt({ text: 'active before stop' });
    await activeStarted;
    const queued = stopConnection.sendPrompt({ text: 'queued before stop' });
    stopConnection.cancel();
    releaseActive?.();
    await Promise.all([active, queued]);
    check('Stop cancels the active turn and fences every already-queued prompt from native delivery',
      stopTransport.cancels.includes(stopSession.id)
        && stopTransport.prompts.length === 1
        && stopTransport.prompts[0]?.prompt[0]?.text === 'active before stop'
        && stopConnection.getPending().every((message) => message.type !== 'user-message'),
      JSON.stringify({ prompts: stopTransport.prompts, pending: stopConnection.getPending() }));
    await stopConnection.close();
  } finally {
    stopTree.cleanup();
  }
} finally {
  tree.cleanup();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
