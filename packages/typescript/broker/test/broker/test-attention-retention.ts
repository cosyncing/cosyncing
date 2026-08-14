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
