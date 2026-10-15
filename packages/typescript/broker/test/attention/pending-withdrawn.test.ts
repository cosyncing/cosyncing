/**
 * A request answered in the agent's own terminal reaches the broker as a history reset and a shorter
 * pending list, never a resolution frame. The hub hands the omitted ids to the attention service, so
 * the durable event resolves instead of standing forever. Only ids the current connection surfaced
 * count, and a connection whose list can omit open requests is never trusted.
 *
 * Narrow because no agent source a broker under test can script (the Pi bridge, hooks) reports a
 * pending list that shrinks without a resolution frame; this drives the real Hub with a fake adapter.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
  reads: number;
  omitsOpenRequests?: boolean;
}

const sessions = new Map<string, FakeSession>();
const withdrawals: Array<{ sessionId: string; requestIds: string[] }> = [];

function connection(id: string): SessionConnection {
  const session = sessions.get(id)!;
  return {
    info: { id, tool: 'fake', machine: 'test', title: id, status: 'idle', attachMode: 'live' },
    getHistory: async () => [],
    subscribe: (handler) => {
      session.handler = handler;
      return () => {
        if (session.handler === handler) session.handler = undefined;
      };
    },
    getPending: async () => {
      const list = await session.pending();
      session.reads += 1;
      return list;
    },
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

/** Poll a condition; the deadline only detects a hang. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

let root = '';
let service: AttentionService;
let hub: Hub;
const hooks = {
  onMessage: (session: SessionInfo, message: AgentMessage) => { void service.handleMessage(session, message); },
  onPendingWithdrawn: (session: SessionInfo, requestIds: string[]) => {
    withdrawals.push({ sessionId: session.id, requestIds });
    void service.handlePendingWithdrawn(session, requestIds);
  },
};
const state = (sessionId: string, kind: 'permission-required' | 'question-required', requestId: string) =>
  service.store.findByDedupeKey(`${kind}:fake:${sessionId}:${requestId}`)?.state;

async function open(id: string, session: Omit<FakeSession, 'reads'>): Promise<FakeSession> {
  const fake = { ...session, reads: 0 };
  sessions.set(id, fake);
  (await hub.ensure('fake', id)).addClient(() => {});
  // The hub reads the pending list once on attach.
  await until(() => fake.handler !== undefined && fake.reads === 1, `${id} attached`);
  await nextMacrotask();
  return fake;
}
function emit(id: string, message: AgentMessage): void {
  const handler = sessions.get(id)?.handler;
  if (!handler) throw new Error(`session ${id} is not subscribed`);
  handler(message);
}
/** Reset the history and wait until the hub has read the pending list and acted on it. */
async function reset(id: string): Promise<void> {
  const fake = sessions.get(id)!;
  const reads = fake.reads;
  emit(id, { type: 'history-reset' });
  await until(() => fake.reads > reads, `${id}'s pending list read`);
  await nextMacrotask();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-pending-withdrawn-'));
  service = new AttentionService({ store: { home: root } });
  hub = new Hub(registry, 20, undefined, hooks);
});
afterAll(async () => {
  await hub?.dispose();
  service?.dispose();
  rmSync(root, { recursive: true, force: true });
});

test('a request answered in the terminal resolves its event; one still listed stays; an unchanged list withdraws nothing', async () => {
  let listed: AgentMessage[] = [];
  const terminal = await open('terminal', { pending: () => listed });
  emit('terminal', permission('p1'));
  emit('terminal', question('q1'));
  emit('terminal', permission('p2'));
  await until(() => state('terminal', 'permission-required', 'p2') === 'active', 'the live requests raised');
  expect(state('terminal', 'question-required', 'q1')).toBe('active');

  listed = [permission('p2')];
  await reset('terminal');
  await until(() => state('terminal', 'permission-required', 'p1') === 'resolved', 'p1 resolved');
  await until(() => state('terminal', 'question-required', 'q1') === 'resolved', 'q1 resolved');
  expect(state('terminal', 'permission-required', 'p2')).toBe('active');
  expect(withdrawals).toEqual([{ sessionId: 'terminal', requestIds: ['p1', 'q1'] }]);

  await reset('terminal');
  expect(withdrawals).toHaveLength(1);
  expect(terminal.reads).toBe(3);
});

test('a pending read overtaken by a live request is discarded', async () => {
  const terminal = sessions.get('terminal')!;
  let release: ((messages: AgentMessage[]) => void) | undefined;
  terminal.pending = () => new Promise<AgentMessage[]>((resolve) => { release = resolve; });
  const reads = terminal.reads;
  emit('terminal', { type: 'history-reset' });
  await until(() => release !== undefined, 'the refresh reading');
  emit('terminal', permission('p3'));
  release!([]);
  await until(() => terminal.reads > reads, 'the read finished');
  await nextMacrotask();
  expect(withdrawals).toHaveLength(1);
  await until(() => state('terminal', 'permission-required', 'p3') === 'active', 'p3 raised');
  expect(state('terminal', 'permission-required', 'p2')).toBe('active');
});

test('a connection whose list can omit open requests never withdraws one', async () => {
  await open('lossy', { pending: () => [], omitsOpenRequests: true });
  emit('lossy', permission('open'));
  await until(() => state('lossy', 'permission-required', 'open') === 'active', 'the lossy request raised');
  await reset('lossy');
  expect(state('lossy', 'permission-required', 'open')).toBe('active');
  expect(withdrawals.some((entry) => entry.sessionId === 'lossy')).toBe(false);
});

test('a fresh connection never withdraws a request an older owner surfaced', async () => {
  await open('restart', { pending: () => [] });
  emit('restart', permission('before-restart'));
  await until(() => state('restart', 'permission-required', 'before-restart') === 'active', 'the first owner\'s request raised');
  await hub.dispose();
  hub = new Hub(registry, 20, undefined, hooks);
  sessions.get('restart')!.handler = undefined;
  await open('restart', { pending: () => [] });
  await reset('restart');
  expect(state('restart', 'permission-required', 'before-restart')).toBe('active');
  expect(withdrawals.some((entry) => entry.sessionId === 'restart')).toBe(false);
});
