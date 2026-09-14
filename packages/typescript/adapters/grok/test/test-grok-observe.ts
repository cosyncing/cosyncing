#!/usr/bin/env bun
export {};
import type { AgentMessage, HistorySnapshotSink, SessionInfo } from '@cosyncing/adapter-api';
import { GrokObserveConnection } from '../src/observe.ts';
import { discoverGrokStore } from '../src/store.ts';
import { buildGrokFixtureTree, fixtureUpdates } from './fixtures/tree.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function info(id: string, cwd: string): SessionInfo {
  return {
    id,
    nativeId: id,
    tool: 'grok',
    title: 'Grok fixture',
    cwd,
    status: 'idle',
    attachMode: 'observe',
  };
}

const tree = buildGrokFixtureTree();
try {
  const session = (await discoverGrokStore({ root: tree.root }))[0];
  if (!session) throw new Error('fixture discovery failed');
  const traces: string[] = [];
  const connection = new GrokObserveConnection({
    session,
    info: info(session.id, session.cwd),
    trace: (event) => traces.push(`${event.op}:${event.detail}`),
  });
  const history = await connection.getHistory();
  check('replay maps the complete update log plus context usage',
    history.some((message) => message.type === 'user-message' && message.text === 'fixture prompt')
      && history.some((message) => message.type === 'run-summary' && message.status === 'done')
      && history.some((message) => message.type === 'metadata-update' && message.key === 'contextUsage'),
    JSON.stringify(history.map((message) => message.type)));
  const identity = await connection.getHistorySourceIdentity();
  check('history identity publishes append position and omits an unstable rewrite token',
    typeof identity?.appendPosition === 'number'
      && identity.appendPosition > 0
      && identity.rewriteToken === undefined,
    JSON.stringify(identity));

  const accepted: AgentMessage[] = [];
  const locations: number[] = [];
  const sink: HistorySnapshotSink = {
    acceptsLocations: true,
    accept(message, location) {
      accepted.push(message);
      if (location !== undefined) locations.push(location);
      return true;
    },
  };
  const capture = await connection.captureHistorySnapshot(sink);
  check('snapshot capture pairs streamed messages with one immutable identity and page reader',
    !!capture && !('refusal' in capture) && !!capture.reader && locations.length === accepted.length,
    JSON.stringify({ accepted: accepted.length, locations: locations.length }));
  if (capture && !('refusal' in capture) && capture.reader) {
    const page = await capture.reader.read([0]);
    check('snapshot page reader reproduces retained locations under the same source identity',
      !!page && !('refusal' in page) && page.messages.length === 1 && page.identity.sourceId === capture.identity.sourceId,
      JSON.stringify(page));
  }

  const live: AgentMessage[] = [];
  const unsubscribe = connection.subscribe((message) => live.push(message));
  const appended = {
    timestamp: '2026-08-23T10:00:10.000Z',
    method: 'session/update',
    params: {
      sessionId: tree.id,
      _meta: { eventId: 'event-10', promptId: 'prompt-2' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'tail prompt' } },
    },
  };
  tree.append(appended);
  await wait(250);
  check('tail emits an appended durable update exactly once despite sidecar watcher noise',
    live.filter((message) => message.type === 'user-message' && message.text === 'tail prompt').length === 1,
    JSON.stringify(live));

  const rewritten = fixtureUpdates();
  const firstParams = rewritten[0]?.params as { update?: { content?: { text?: string } } } | undefined;
  if (firstParams?.update?.content) firstParams.update.content.text = 'rewritten prompt';
  tree.writeRows(rewritten);
  await wait(250);
  check('a same-lineage prefix rewrite emits one rollback reset instead of replaying mixed history',
    live.some((message) => message.type === 'history-reset' && message.semantic?.kind === 'rollback'),
    JSON.stringify(live.filter((message) => message.type === 'history-reset')));

  let sendRejected = false;
  let permissionRejected = false;
  try { await connection.sendPrompt({ text: 'no' }); } catch { sendRejected = true; }
  try { await connection.respondPermission('no', 'approve'); } catch { permissionRejected = true; }
  check('Observe refuses every mutation', sendRejected && permissionRejected);
  unsubscribe();
  await connection.close();

  tree.writeRows([fixtureUpdates()[0]!]);
  const interruptedSession = (await discoverGrokStore({ root: tree.root }))[0]!;
  const interruptedConnection = new GrokObserveConnection({
    session: interruptedSession,
    info: info(interruptedSession.id, interruptedSession.cwd),
  });
  const interrupted = await interruptedConnection.getHistory();
  check('ownerless replay ending in a user update is marked cancelled, never left running',
    interrupted.some((message) => message.type === 'run-summary' && message.status === 'cancelled'),
    JSON.stringify(interrupted));
  await interruptedConnection.close();
} finally {
  tree.cleanup();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
