#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { AgentRegistry, type AgentMessage, type AgentMessageHandler, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { Hub, ManagedConn } from '../../src/sessions/hub.ts';

let failures = 0;
async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fakeConnection(id: string, closed?: Set<string>): { conn: SessionConnection; emit: (message: AgentMessage) => void } {
  const handlers = new Set<AgentMessageHandler>();
  const info: SessionInfo = { id, tool: 'fake', machine: 'test', title: id, status: 'idle', attachMode: 'observe' };
  return {
    conn: {
      info,
      getHistory: async () => [],
      subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
      sendPrompt: async () => {},
      respondPermission: async () => {},
      close: async () => { closed?.add(id); },
    },
    emit(message) { for (const handler of handlers) handler(message); },
  };
}

await run('ManagedConn exposes live attention state and callbacks only from live frames', () => {
  const fake = fakeConnection('one');
  const messages: AgentMessage[] = [];
  const retention: boolean[] = [];
  const managed = new ManagedConn(fake.conn, undefined, {
    onMessage: (_info, message) => messages.push(message),
    onRetentionChanged: (_info, required) => retention.push(required),
  });

  assert.equal(managed.requiresAttentionRetention, false);
  fake.emit({ type: 'status', status: 'running' });
  assert.equal(managed.requiresAttentionRetention, true);
  fake.emit({ type: 'goal-state', key: 'goal', status: 'active', title: 'Long goal' });
  fake.emit({ type: 'status', status: 'idle' });
  assert.equal(managed.requiresAttentionRetention, true, 'active goal retains after turn goes idle');
  fake.emit({ type: 'goal-state', key: 'goal', status: 'done' });
  assert.equal(managed.requiresAttentionRetention, false);
  assert.deepEqual(retention, [true, false]);
  assert.equal(messages.length, 4);
});

await run('queued user correlation retains a zero-client owner until its durable echo arrives', async () => {
  const fakes = new Map<string, ReturnType<typeof fakeConnection>>();
  const registry = new AgentRegistry();
  registry.register({
    id: 'fake', displayName: 'Fake', capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async (id: string) => {
      const fake = fakeConnection(id);
      fakes.set(id, fake);
      return fake.conn;
    },
  } as any);
  const hub = new Hub(registry, 20);
  const owner = await hub.ensure('fake', 'queued');
  fakes.get('queued')!.emit({ type: 'user-message', text: 'accepted', key: 'queued-key', queued: true });
  fakes.get('queued')!.emit({ type: 'status', status: 'idle' });
  hub.release('fake', 'queued');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hub.getConn('fake', 'queued'), owner, 'queued correlation must survive the grace window');
  fakes.get('queued')!.emit({ type: 'user-message', text: 'accepted', key: 'queued-key', queued: false });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hub.getConn('fake', 'queued'), undefined, 'durable echo releases the retained owner');
  await hub.dispose();
});

await run('history reset reconciles queued retention from adapter pending state', async () => {
  const fake = fakeConnection('rewrite-pending');
  let pending: AgentMessage[] = [
    { type: 'user-message', text: 'accepted', key: 'rewrite-queued', queued: true },
  ];
  fake.conn.getPending = async () => pending;
  const managed = new ManagedConn(fake.conn);
  fake.emit(pending[0]!);
  fake.emit({ type: 'history-reset', notice: 'rewritten', semantic: { kind: 'rollback' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(managed.requiresAttentionRetention, true,
    'rewrite must preserve a queued row still reported by the adapter');
  pending = [];
  fake.emit({ type: 'history-reset', notice: 'settled', semantic: { kind: 'rollback' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(managed.requiresAttentionRetention, false,
    'a later reset may release only after adapter pending state is empty');
});

await run('late attach hydrates actionable permission cards from adapter pending state', async () => {
  const fake = fakeConnection('pending-permission');
  fake.conn.getPending = async () => [{
    type: 'permission-request',
    requestId: 'permission-late',
    title: 'Approve late request',
    options: ['approve', 'reject'],
  }];
  const managed = new ManagedConn(fake.conn);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(managed.liveSnapshot().some((message) =>
    message.type === 'permission-request' && message.requestId === 'permission-late'));
  assert.equal(managed.status, 'needs-input');
});

await run('a history reset keeps a live permission card for an adapter without getPending', async () => {
  // OpenCode and Antigravity are shipped adapters that emit permission-request and history-reset
  // but expose no getPending. The live map is their only record of being blocked on the user, so a
  // reset must not clear it — there is nothing to rebuild it from.
  const fake = fakeConnection('no-get-pending');
  assert.equal(fake.conn.getPending, undefined, 'this case is only meaningful without getPending');
  const managed = new ManagedConn(fake.conn);
  fake.emit({
    type: 'permission-request',
    requestId: 'permission-survives-reset',
    title: 'Approve shell command',
    options: ['approve', 'reject'],
  });
  assert.equal(managed.status, 'needs-input');
  fake.emit({ type: 'history-reset', notice: 'compacted', semantic: { kind: 'rollback' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(managed.liveSnapshot().some((message) =>
    message.type === 'permission-request' && message.requestId === 'permission-survives-reset'),
  'the approval card must survive a reset the adapter cannot re-report');
  assert.equal(managed.status, 'needs-input',
    'a session still waiting on the user must not publish idle after a reset');
  assert.equal(managed.requiresAttentionRetention, true,
    'a blocked session must stay retained rather than become evictable');
});

await run('an older async pending refresh cannot erase a newer live queued row', async () => {
  const fake = fakeConnection('async-pending');
  let resolvePending!: (messages: AgentMessage[]) => void;
  fake.conn.getPending = () => new Promise<AgentMessage[]>((resolve) => { resolvePending = resolve; });
  const managed = new ManagedConn(fake.conn);
  fake.emit({ type: 'user-message', text: 'newer', key: 'newer-queued', queued: true });
  resolvePending([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(managed.requiresAttentionRetention, true);
});

await run('connection replacement resets live-text bytes and truncation state', () => {
  const first = fakeConnection('replace-first');
  const second = fakeConnection('replace-second');
  const managed = new ManagedConn(first.conn);
  first.emit({ type: 'model-output', key: 'old', text: 'x'.repeat(300_000) });
  assert.ok(managed.liveSnapshot().some((message) => message.type === 'notice'));
  managed.replaceConnection(second.conn);
  second.emit({ type: 'model-output', key: 'new', text: 'fresh' });
  const snapshot = managed.liveSnapshot();
  assert.ok(!snapshot.some((message) => message.type === 'notice'));
  assert.ok(snapshot.some((message) => message.type === 'model-output'
    && message.key === 'new' && message.text === 'fresh'));
});

await run('Hub caps zero-client leases without TTL or evicting existing leases', async () => {
  const fakes = new Map<string, ReturnType<typeof fakeConnection>>();
  const closed = new Set<string>();
  const denied: string[] = [];
  const observationLost: string[] = [];
  const registry = new AgentRegistry();
  registry.register({
    id: 'fake', displayName: 'Fake', capabilities: {} as any,
    isAvailable: async () => true,
    discoverSessions: async () => [],
    attach: async (id: string) => {
      const fake = fakeConnection(id, closed);
      fakes.set(id, fake);
      return fake.conn;
    },
  } as any);
  const hub = new Hub(registry, 20, undefined, {
    maxZeroClientLeases: 2,
    onLeaseDenied: (info) => denied.push(info.id),
    onObservationLost: (info) => observationLost.push(info.id),
  });

  for (const id of ['one', 'two', 'three']) {
    await hub.ensure('fake', id);
    fakes.get(id)!.emit({ type: 'status', status: 'running' });
    fakes.get(id)!.emit({ type: 'run-summary', key: `run-${id}`, turnId: `turn-${id}`, status: 'running' });
    hub.release('fake', id);
  }
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(hub.getConn('fake', 'one'));
  assert.ok(hub.getConn('fake', 'two'));
  assert.equal(hub.getConn('fake', 'three'), undefined);
  assert.deepEqual(denied, ['three']);
  assert.deepEqual([...closed], ['three']);
  assert.deepEqual(observationLost, ['three'], 'disposed denied lease drops incomplete live evidence');

  // No TTL: leased connections survive multiple grace windows until their condition actually clears.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(hub.getConn('fake', 'one'));
  fakes.get('one')!.emit({ type: 'status', status: 'idle' });
  fakes.get('one')!.emit({ type: 'run-summary', key: 'run-one', turnId: 'turn-one', status: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hub.getConn('fake', 'one'), undefined);
  assert.ok(hub.getConn('fake', 'two'), 'clearing one lease must not evict another');
});

if (failures) {
  console.error(`\nFAIL: ${failures} attention-retention test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: attention-retention tests passed');
