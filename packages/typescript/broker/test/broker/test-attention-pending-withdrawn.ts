#!/usr/bin/env bun
// A request answered in the agent's own terminal reaches the broker as a history reset and a
// shorter pending list, never a resolution frame. The Hub hands the omitted ids to the attention
// service, so the durable event resolves instead of reminding forever. Only ids the current
// connection surfaced count, and a connection that can omit open requests is never trusted.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRegistry,
  type AgentMessage,
  type AgentMessageHandler,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import { Hub } from '../../src/sessions/hub.ts';

interface FakeSession {
  handler?: AgentMessageHandler;
  pending: () => Promise<AgentMessage[]> | AgentMessage[];
  omitsOpenRequests?: boolean;
}

const sessions = new Map<string, FakeSession>();
const withdrawals: Array<{ sessionId: string; requestIds: string[] }> = [];

function info(id: string): SessionInfo {
  return { id, tool: 'fake', machine: 'test', title: id, status: 'idle', attachMode: 'live' };
}

function connection(id: string): SessionConnection {
  const session = sessions.get(id)!;
  return {
    info: info(id),
    getHistory: async () => [],
    subscribe: (handler) => {
      session.handler = handler;
      return () => {
        if (session.handler === handler) session.handler = undefined;
      };
    },
    getPending: () => session.pending(),
    ...(session.omitsOpenRequests ? { pendingListMayOmitOpenRequests: true } : {}),
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {},
  };
}

const registry = new AgentRegistry();
registry.register({
  id: 'fake', displayName: 'Fake', capabilities: {} as any, isAvailable: async () => true,
  discoverSessions: async () => [], attach: async (id: string) => connection(id),
} as any);

const permission = (requestId: string): AgentMessage => ({ type: 'permission-request', requestId, title: 'run' });
const question = (requestId: string): AgentMessage => ({
  type: 'question-request', requestId, questions: [{ question: 'go?', options: [{ label: 'yes' }] }],
});
const emit = (id: string, message: AgentMessage) => {
  const handler = sessions.get(id)?.handler;
  assert.ok(handler, `session ${id} is subscribed`);
  handler(message);
};

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-pending-withdrawn-'));
const service = new AttentionService({ store: { home: root } });
const state = (sessionId: string, kind: 'permission-required' | 'question-required', requestId: string) =>
  service.store.findByDedupeKey(`${kind}:fake:${sessionId}:${requestId}`)?.state;
const hooks = {
  onMessage: (session: SessionInfo, message: AgentMessage) => { void service.handleMessage(session, message); },
  onPendingWithdrawn: (session: SessionInfo, requestIds: string[]) => {
    withdrawals.push({ sessionId: session.id, requestIds });
    void service.handlePendingWithdrawn(session, requestIds);
  },
};
let hub = new Hub(registry, 20, undefined, hooks);

try {
  // 1. Answered in the terminal: the list shrinks with no resolution frame.
  let terminalPending: AgentMessage[] = [];
  sessions.set('terminal', { pending: () => terminalPending });
  const terminal = await hub.ensure('fake', 'terminal');
  terminal.addClient(() => {});
  await settle();
  emit('terminal', permission('p1'));
  emit('terminal', question('q1'));
  emit('terminal', permission('p2'));
  await waitFor(() => state('terminal', 'permission-required', 'p2') === 'active', 'live requests raise events');
  assert.equal(state('terminal', 'question-required', 'q1'), 'active');
  terminalPending = [permission('p2')];
  emit('terminal', { type: 'history-reset' });
  await waitFor(() => state('terminal', 'permission-required', 'p1') === 'resolved', 'p1 resolves');
  assert.equal(state('terminal', 'question-required', 'q1'), 'resolved',
    'a question answered in the terminal resolves too');
  assert.equal(state('terminal', 'permission-required', 'p2'), 'active', 'a request still listed stays active');
  assert.deepEqual(withdrawals, [{ sessionId: 'terminal', requestIds: ['p1', 'q1'] }]);
  emit('terminal', { type: 'history-reset' });
  await settle();
  assert.equal(withdrawals.length, 1, 'an unchanged list withdraws nothing');
  console.log('PASS: a request answered in the terminal resolves its attention event');

  // 2. A live request that lands while the list is being read makes that read stale.
  let release!: (messages: AgentMessage[]) => void;
  sessions.get('terminal')!.pending = () => new Promise<AgentMessage[]>((resolve) => { release = resolve; });
  emit('terminal', { type: 'history-reset' });
  await waitFor(() => release !== undefined, 'the refresh is reading');
  emit('terminal', permission('p3'));
  release([]);
  await settle();
  assert.equal(withdrawals.length, 1, 'a read overtaken by a live request withdraws nothing');
  assert.equal(state('terminal', 'permission-required', 'p2'), 'active');
  assert.equal(state('terminal', 'permission-required', 'p3'), 'active');
  console.log('PASS: a pending read raced by a live request is discarded');

  // 3. A connection whose list can omit open requests is never trusted to withdraw one.
  sessions.set('lossy', { pending: () => [], omitsOpenRequests: true });
  const lossy = await hub.ensure('fake', 'lossy');
  lossy.addClient(() => {});
  await settle();
  emit('lossy', permission('open'));
  await waitFor(() => state('lossy', 'permission-required', 'open') === 'active', 'lossy request raises an event');
  emit('lossy', { type: 'history-reset' });
  await settle();
  assert.equal(state('lossy', 'permission-required', 'open'), 'active',
    'an empty list from a lossy connection does not resolve the request');
  assert.equal(withdrawals.some((entry) => entry.sessionId === 'lossy'), false);
  console.log('PASS: a connection that can omit open requests never withdraws one');

  // 4. A fresh connection does not know an older connection's requests; its first list must not
  // resolve them.
  sessions.set('restart', { pending: () => [] });
  const first = await hub.ensure('fake', 'restart');
  first.addClient(() => {});
  await settle();
  emit('restart', permission('before-restart'));
  await waitFor(() => state('restart', 'permission-required', 'before-restart') === 'active',
    'the first owner raises an event');
  await hub.dispose();
  hub = new Hub(registry, 20, undefined, hooks);
  const second = await hub.ensure('fake', 'restart');
  second.addClient(() => {});
  await settle();
  emit('restart', { type: 'history-reset' });
  await settle();
  assert.equal(state('restart', 'permission-required', 'before-restart'), 'active',
    'a new owner cannot withdraw a request it never surfaced');
  assert.equal(withdrawals.some((entry) => entry.sessionId === 'restart'), false);
  console.log('PASS: a fresh connection never withdraws an older owner\'s request');
} finally {
  await hub.dispose();
  service.dispose();
  rmSync(root, { recursive: true, force: true });
}
