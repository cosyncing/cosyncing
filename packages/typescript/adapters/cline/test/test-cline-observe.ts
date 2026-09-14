#!/usr/bin/env bun
export {};
import type { AgentMessage, HistorySnapshotSink, SessionInfo } from '@cosyncing/adapter-api';
import { TerminalSummaryRegistry } from '@cosyncing/adapter-api';
import type { ClineTerminalSummary } from '../src/mapping.ts';
import { ClineObserveConnection } from '../src/observe.ts';
import {
  ClinePromptCorrelationRegistry,
  clineNativeMessageDigest,
  clineTerminalSummaryHistoryIdentity,
  discoverClineStore,
} from '../src/store.ts';
import { buildClineFixtureTree, fixtureParentMessages } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tree = buildClineFixtureTree();
try {
  const session = (await discoverClineStore({ env: { CLINE_DIR: tree.root }, processAlive: () => false }))[0];
  if (!session) throw new Error('fixture discovery failed');
  const info: SessionInfo = {
    id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title,
    cwd: session.cwd, status: 'idle', attachMode: 'observe',
  };
  const connection = new ClineObserveConnection({ session, info });
  const history = await connection.getHistory();
  check('replay maps the full snapshot, interrupted summary, and aggregate usage',
    history.some((message) => message.type === 'user-message' && message.text === 'fixture prompt')
      && history.some((message) => message.type === 'run-summary' && message.status === 'cancelled')
      && history.some((message) => message.type === 'metadata-update' && message.key === 'sessionUsage'),
    JSON.stringify(history.map((message) => message.type)));

  const accepted: AgentMessage[] = [];
  const sink: HistorySnapshotSink = {
    acceptsLocations: true,
    accept(message) { accepted.push(message); return true; },
  };
  const capture = await connection.captureHistorySnapshot(sink);
  const page = capture && !('refusal' in capture) && capture.reader
    ? await capture.reader.read([0])
    : undefined;
  check('snapshot capture and paging share one immutable identity',
    !!capture && !('refusal' in capture) && !!page && !('refusal' in page)
      && page.identity.sourceId === capture.identity.sourceId
      && page.messages.length === 1,
    JSON.stringify({ accepted: accepted.length, page }));

  const live: AgentMessage[] = [];
  const unsubscribe = connection.subscribe((message) => live.push(message));
  const appended = [...fixtureParentMessages(), {
    id: 'msg-user-tail', role: 'user', content: [{ type: 'text', text: 'tail prompt' }],
  }];
  tree.writeParent(appended);
  await wait(250);
  check('whole-file append emits the new mapped row exactly once',
    live.filter((message) => message.type === 'user-message' && message.text === 'tail prompt').length === 1,
    JSON.stringify(live));

  const rewritten = fixtureParentMessages();
  const first = rewritten[0]?.content[0];
  if (first) first.text = 'rewritten prompt';
  tree.writeParent(rewritten);
  await wait(250);
  check('content rewrite emits rollback reset and invalidates further paging',
    live.some((message) => message.type === 'history-reset' && message.semantic?.kind === 'rollback')
      && await connection.getHistorySourceIdentity() === undefined,
    JSON.stringify(live.filter((message) => message.type === 'history-reset')));

  let sendRejected = false;
  let permissionRejected = false;
  try { await connection.sendPrompt({ text: 'no' }); } catch { sendRejected = true; }
  try { await connection.respondPermission('no', 'approve'); } catch { permissionRejected = true; }
  check('Observe refuses prompt and permission mutations', sendRejected && permissionRejected);
  unsubscribe();
  await connection.close();
} finally {
  tree.cleanup();
}

const metadataTree = buildClineFixtureTree();
try {
  let alive = true;
  const session = (await discoverClineStore({
    env: { CLINE_DIR: metadataTree.root },
    processAlive: () => alive,
  }))[0];
  if (!session) throw new Error('metadata fixture discovery failed');
  const info: SessionInfo = {
    id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title,
    cwd: session.cwd, status: 'working', attachMode: 'observe',
  };
  const connection = new ClineObserveConnection({ session, info, processAlive: () => alive });
  await connection.getHistory();
  const live: AgentMessage[] = [];
  const unsubscribe = connection.subscribe((message) => live.push(message));
  alive = false;
  metadataTree.writeMetadata({
    status: 'completed',
    ended_at: '2026-08-23T10:00:10.000Z',
    provider: 'openai-compatible',
    model: 'qwen-physical',
    metadata: {
      title: 'Cline fixture',
      mode: 'plan',
      aggregateUsage: { inputTokens: 999, outputTokens: 77 },
      totalCost: 0.03,
    },
  });
  await wait(250);
  const refreshed = await connection.getHistory();
  check('metadata rewrites refresh live status, connection info, and aggregate usage',
    connection.info.status === 'idle'
      && connection.info.currentMode === 'plan'
      && connection.info.currentModel?.providerID === 'openai-compatible'
      && connection.info.currentModel.modelID === 'qwen-physical'
      && live.some((message) => message.type === 'status' && message.status === 'idle')
      && live.some((message) => message.type === 'metadata-update'
        && message.key === 'sessionInfo'
        && (message.value as { currentMode?: unknown }).currentMode === 'plan'
        && (message.value as { currentModel?: { modelID?: unknown } }).currentModel?.modelID === 'qwen-physical')
      && JSON.stringify(refreshed).includes('"input":999')
      && JSON.stringify(refreshed).includes('"cost":0.03'),
    JSON.stringify({ info: connection.info, live, refreshed }));
  unsubscribe();
  await connection.close();
} finally {
  metadataTree.cleanup();
}

const boundedTree = buildClineFixtureTree();
try {
  boundedTree.writeParent([...fixtureParentMessages(), {
    id: 'msg-unknown-late', role: 'assistant', content: [{ type: 'future_native_block' }],
  }]);
  const session = (await discoverClineStore({ env: { CLINE_DIR: boundedTree.root } }))[0];
  if (!session) throw new Error('bounded fixture discovery failed');
  const traces: string[] = [];
  const connection = new ClineObserveConnection({
    session,
    info: {
      id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title,
      cwd: session.cwd, status: 'idle', attachMode: 'observe',
    },
    trace: (event) => traces.push(`${event.op}:${event.detail}`),
  });
  let calls = 0;
  const refusal = await connection.captureHistorySnapshot({
    acceptsLocations: true,
    accept() { calls += 1; return false; },
  });
  check('snapshot capture stops native mapping at the sink budget',
    !!refusal && 'refusal' in refusal && refusal.refusal === 'resource-limit'
      && calls === 1
      && !traces.some((trace) => trace.startsWith('unknown-block:')),
    JSON.stringify({ refusal, calls, traces }));
  await connection.close();
} finally {
  boundedTree.cleanup();
}

const summaryRaceTree = buildClineFixtureTree();
try {
  const session = (await discoverClineStore({ env: { CLINE_DIR: summaryRaceTree.root } }))[0];
  if (!session) throw new Error('summary-race fixture discovery failed');
  const expected = clineTerminalSummaryHistoryIdentity(session.id, fixtureParentMessages());
  const registry = new TerminalSummaryRegistry<ClineTerminalSummary>();
  const staleSummary: ClineTerminalSummary = {
    type: 'run-summary',
    key: 'stale-cline-terminal',
    turnId: 'stale-cline-turn',
    status: 'done',
    source: 'cline',
  };
  let invalidated = false;
  let mutated = false;
  const connection = new ClineObserveConnection({
    session,
    info: {
      id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title,
      cwd: session.cwd, status: 'idle', attachMode: 'observe',
    },
    terminalSummaryRegistry: registry,
    expectedTerminalSummaryBoundary: expected,
    terminalSummaries: [staleSummary],
    onTerminalSummaryBoundaryInvalid: () => { invalidated = true; },
    snapshotTestHook: () => {
      if (mutated) return;
      mutated = true;
      summaryRaceTree.writeParent([...fixtureParentMessages(), {
        id: 'summary-race-user', role: 'user', content: [{ type: 'text', text: 'foreign replacement' }],
      }]);
    },
  });
  const history = await connection.getHistory();
  check('Cline drops stored terminal summaries when history changes before the first stable Observe read',
    invalidated && !history.some((message) => message.type === 'run-summary'
      && message.key === staleSummary.key));
  await connection.close();
} finally {
  summaryRaceTree.cleanup();
}

const correlationTree = buildClineFixtureTree();
try {
  const session = (await discoverClineStore({ env: { CLINE_DIR: correlationTree.root } }))[0];
  if (!session) throw new Error('correlation fixture discovery failed');
  const registry = new ClinePromptCorrelationRegistry();
  let invalidations = 0;
  const connection = new ClineObserveConnection({
    session,
    info: {
      id: session.id, nativeId: session.nativeId, tool: 'cline', title: session.title,
      cwd: session.cwd, status: 'idle', attachMode: 'observe',
    },
    promptCorrelations: registry,
    onPromptCorrelationInvalid: () => { invalidations += 1; },
  });
  const before = await connection.getHistory();
  const beforeIdentity = await connection.getHistorySourceIdentity();
  const beforeCaptured: AgentMessage[] = [];
  const beforeCapture = await connection.captureHistorySnapshot({
    acceptsLocations: true,
    accept(message) { beforeCaptured.push(message); return true; },
  });
  const beforeUser = before.find((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
    message.type === 'user-message' && message.text === 'fixture prompt');
  const live: AgentMessage[] = [];
  const unsubscribe = connection.subscribe((message) => live.push(message));
  const native = correlationTree.parentMessages[0]!;
  registry.set(native.id, {
    nativeMessageId: native.id,
    nativeMessageDigest: clineNativeMessageDigest(native),
    key: 'durable-app-key',
    clientKey: 'durable-client-key',
  });
  const after = await connection.getHistory();
  const afterIdentity = await connection.getHistorySourceIdentity();
  const afterCaptured: AgentMessage[] = [];
  const afterCapture = await connection.captureHistorySnapshot({
    acceptsLocations: true,
    accept(message) { afterCaptured.push(message); return true; },
  });
  const afterPage = afterCapture && !('refusal' in afterCapture) && afterCapture.reader
    ? await afterCapture.reader.read([0])
    : undefined;
  const afterUser = after.find((message): message is Extract<AgentMessage, { type: 'user-message' }> =>
    message.type === 'user-message' && message.text === 'fixture prompt');
  check('an already-open Observe resets and replays a late durable prompt correlation',
    Boolean(beforeUser?.key !== 'durable-app-key'
      && live.some((message) => message.type === 'history-reset')
      && afterUser?.key === 'durable-app-key'
      && afterUser.clientKey === 'durable-client-key'
      && afterUser.queued === false
      && beforeIdentity?.revision !== afterIdentity?.revision
      && beforeCapture && !('refusal' in beforeCapture)
      && afterCapture && !('refusal' in afterCapture)
      && beforeCapture.identity.revision !== afterCapture.identity.revision
      && afterPage && !('refusal' in afterPage)
      && afterPage.messages[0]?.type === 'user-message'
      && afterPage.messages[0].key === 'durable-app-key'),
    JSON.stringify({ beforeUser, live, afterUser, beforeIdentity, afterIdentity, afterPage }));

  const duplicateText = [...fixtureParentMessages(), {
    id: 'different-native-user', role: 'user', content: [{ type: 'text', text: 'fixture prompt' }],
  }];
  correlationTree.writeParent(duplicateText);
  await wait(250);
  const duplicateHistory = await connection.getHistory();
  const duplicateUsers = duplicateHistory.filter(
    (message): message is Extract<AgentMessage, { type: 'user-message' }> =>
      message.type === 'user-message' && message.text === 'fixture prompt',
  );
  check('identical user text under a different native id never inherits the app correlation',
    duplicateUsers.length === 2
      && duplicateUsers[0]?.key === 'durable-app-key'
      && duplicateUsers[1]?.key !== 'durable-app-key'
      && duplicateUsers[1]?.clientKey === undefined,
    JSON.stringify(duplicateUsers));

  const replacement = fixtureParentMessages();
  replacement[0] = {
    ...replacement[0]!,
    content: [{ type: 'text', text: 'same id, replacement content' }],
  };
  correlationTree.writeParent(replacement);
  await wait(250);
  check('a rewrite clears shared correlations and revokes the durable ownership gate',
    registry.size === 0 && invalidations >= 1,
    JSON.stringify({ registrySize: registry.size, invalidations }));
  unsubscribe();
  await connection.close();
} finally {
  correlationTree.cleanup();
}

const boundedRegistry = new ClinePromptCorrelationRegistry();
for (let index = 0; index < 65; index += 1) {
  boundedRegistry.set(`native-${index}`, {
    nativeMessageId: `native-${index}`,
    nativeMessageDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
    key: `key-${index}`,
  });
}
check('the live Cline prompt-correlation registry matches the 64-row durable cap',
  boundedRegistry.size === 64
    && !boundedRegistry.has('native-0')
    && boundedRegistry.get('native-64')?.key === 'key-64');

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
