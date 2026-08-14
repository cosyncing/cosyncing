#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, type AgentMessageHandler, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import { Hub } from '../../src/sessions/hub.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-sync-degraded-integration-'));
const service = new AttentionService({ store: { home: root } });
const work: Promise<void>[] = [];
const registry = new AgentRegistry();
let synced = true;
let working = false;

const info = (): SessionInfo => ({
  id: 'session', tool: 'fake', machine: 'test', title: 'session', status: working ? 'working' : 'idle',
  attachMode: synced ? 'live' : 'observe',
  control: {
    drive: { supported: true, state: synced ? 'driving' : 'unavailable' },
    terminalSync: { supported: true, syncAvailable: synced, active: synced },
  },
});
function connection(): SessionConnection {
  return {
    info: info(), getHistory: async () => [], subscribe: (_handler: AgentMessageHandler) => () => {},
    sendPrompt: async () => {}, respondPermission: async () => {}, close: async () => {},
  };
}
registry.register({
  id: 'fake', displayName: 'Fake', capabilities: {} as any, isAvailable: async () => true,
  discoverSessions: async () => [], attach: async () => connection(),
} as any);
const hub = new Hub(registry, 20, undefined, {
  onControlTransition: (transition) => { work.push(service.handleControlTransition(transition)); },
  onSessionEnded: (session) => { work.push(service.handleSessionEnded(session)); },
});

try {
  const firstWindow = await hub.ensure('fake', 'session');
  firstWindow.addClient(() => {});
  const secondWindow = await hub.ensure('fake', 'session');
  secondWindow.addClient(() => {});
  assert.equal(secondWindow, firstWindow, 'two observing windows share the one authoritative owner');
  await Promise.all(work.splice(0));
  assert.equal(service.store.listEvents().filter((event) => event.kind === 'sync-degraded').length, 0,
    'attaching a second observer must not manufacture control degradation');

  working = true;
  await hub.refreshExternalSession(info());
  await Promise.all(work.splice(0));
  assert.equal(service.store.listEvents().filter((event) => event.kind === 'sync-degraded').length, 0,
    'ordinary observer fan-out remains silent when the authoritative session starts working');

  synced = false;
  await hub.refreshExternalSession(info());
  await Promise.all(work.splice(0));
  const degraded = service.store.listActive().filter((event) => event.kind === 'sync-degraded');
  assert.equal(degraded.length, 2, 'Drive and terminal-sync paths degrade independently');

  // Repeating the same unavailable metadata is silent.
  await hub.refreshExternalSession(info());
  await Promise.all(work.splice(0));
  assert.equal(service.store.listEvents().filter((event) => event.kind === 'sync-degraded').length, 2);

  synced = true;
  await hub.refreshExternalSession(info());
  await Promise.all(work.splice(0));
  assert.equal(service.store.listActive().filter((event) => event.kind === 'sync-degraded').length, 0);
  assert.equal(service.store.listEvents().filter((event) => event.kind === 'sync-degraded' && event.state === 'resolved').length, 2);
  console.log('PASS: a second Hub observer is silent while authoritative control loss/recovery publishes durable sync-degraded events');
} finally {
  await hub.dispose();
  service.dispose();
  rmSync(root, { recursive: true, force: true });
}

const restartRoot = mkdtempSync(join(tmpdir(), 'cosyncing-sync-degraded-restart-'));
try {
  const first = new AttentionService({ store: { home: restartRoot } });
  await first.handleControlTransition({
    tool: 'fake', sessionId: 'persisted', path: 'drive', from: 'active', to: 'unavailable',
    cause: 'transport-lost', observedAt: 1,
  });
  assert.equal(first.store.listActive().filter((event) => event.kind === 'sync-degraded').length, 1);
  first.dispose();

  const restored = new AttentionService({ store: { home: restartRoot } });
  await restored.handleControlTransition({
    tool: 'fake', sessionId: 'persisted', path: 'drive', from: 'unavailable', to: 'available',
    cause: 'runtime-unreachable', observedAt: 2,
  });
  assert.equal(restored.store.listActive().filter((event) => event.kind === 'sync-degraded').length, 0,
    'authoritative recovery resolves a degradation retained across broker restart');
  restored.dispose();
  console.log('PASS: persisted sync-degraded tracker state restores across broker restart');
} finally {
  rmSync(restartRoot, { recursive: true, force: true });
}
