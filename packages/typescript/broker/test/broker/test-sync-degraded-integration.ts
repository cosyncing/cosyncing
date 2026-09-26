#!/usr/bin/env bun
// Control-path loss is not an attention event. A drive or terminal-sync path going away fired on
// every ordinary session exit and told the user nothing they could act on, so the broker raises
// nothing for it, and resolves the sync-degraded rows an older broker left active.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, type AgentMessageHandler, type SessionConnection, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import type { SessionControlTransition } from '../../src/attention/attention-policy.ts';
import { Hub } from '../../src/sessions/hub.ts';

const syncDegraded = (service: AttentionService) =>
  service.store.listEvents().filter((event) => event.kind === 'sync-degraded');

const root = mkdtempSync(join(tmpdir(), 'cosyncing-sync-degraded-integration-'));
const service = new AttentionService({ store: { home: root } });
const transitions: SessionControlTransition[] = [];
const registry = new AgentRegistry();
let synced = true;
let working = false;

const info = (): SessionInfo => ({
  id: 'session', tool: 'fake', machine: 'test', title: 'session', status: working ? 'working' : 'idle',
  attachMode: synced ? 'live' : 'observe',
  control: {
    drive: { supported: true, state: synced ? 'driving' : 'unavailable' },
    terminalSync: {
      supported: true,
      syncAvailable: synced,
      active: synced,
      ...(synced ? { presence: 'shared' } : {}),
    },
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
  onControlTransition: (transition) => { transitions.push(transition); },
  onSessionEnded: (session) => { void service.handleSessionEnded(session); },
});

try {
  assert.equal(await service.legacySyncDegradedRetired, 0, 'a fresh store has nothing to retire');
  const firstWindow = await hub.ensure('fake', 'session');
  firstWindow.addClient(() => {});
  const secondWindow = await hub.ensure('fake', 'session');
  secondWindow.addClient(() => {});
  assert.equal(secondWindow, firstWindow, 'two observing windows share the one authoritative owner');

  working = true;
  await hub.refreshExternalSession(info());
  synced = false;
  await hub.refreshExternalSession(info());
  assert.ok(
    transitions.some((transition) => transition.to === 'unavailable'),
    'the Hub still reports the real control loss (the precondition this test depends on)',
  );
  synced = true;
  await hub.refreshExternalSession(info());
  assert.ok(
    transitions.some((transition) => transition.to === 'active' || transition.to === 'available'),
    'the Hub still reports the recovery',
  );
  assert.equal(syncDegraded(service).length, 0, 'control loss and recovery raise no attention event');
  assert.equal(service.store.listEvents().length, 0, 'nor any other event');
  console.log('PASS: a real control loss and recovery reach the Hub hook and raise no attention event');
} finally {
  await hub.dispose();
  service.dispose();
  rmSync(root, { recursive: true, force: true });
}

// An older broker persisted active sync-degraded rows. The next start resolves them so their
// reminders stop, and leaves every other active event alone.
const upgradeRoot = mkdtempSync(join(tmpdir(), 'cosyncing-sync-degraded-upgrade-'));
try {
  const older = new AttentionService({ store: { home: upgradeRoot } });
  await older.legacySyncDegradedRetired;
  for (const path of ['drive', 'terminal-sync']) {
    await older.upsertEvent({
      dedupeKey: `sync-degraded:fake:persisted:${path}`,
      kind: 'sync-degraded',
      state: 'active',
      severity: 'maintenance',
      agent: 'fake',
      sessionId: 'persisted',
      title: 'Session sync degraded',
      summary: 'A previously available remote-control path is unavailable.',
      action: { kind: 'open-session', tool: 'fake', sessionId: 'persisted' },
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
  }
  await older.upsertEvent({
    dedupeKey: 'permission-required:fake:persisted:request-1',
    kind: 'permission-required',
    state: 'active',
    severity: 'action-required',
    agent: 'fake',
    sessionId: 'persisted',
    requestId: 'request-1',
    title: 'Permission required',
    summary: 'An agent is waiting for permission.',
    action: { kind: 'open-session', tool: 'fake', sessionId: 'persisted' },
    presentationRevision: 1,
    presentationStage: 'immediate',
  });
  older.dispose();

  const upgraded = new AttentionService({ store: { home: upgradeRoot } });
  assert.equal(await upgraded.legacySyncDegradedRetired, 2, 'both legacy rows are retired on start');
  assert.equal(
    upgraded.store.listActive().filter((event) => event.kind === 'sync-degraded').length,
    0,
    'no sync-degraded event stays active, so none is reminded',
  );
  assert.equal(syncDegraded(upgraded).filter((event) => event.state === 'resolved').length, 2,
    'the rows stay in history as resolved');
  assert.deepEqual(
    upgraded.store.listActive().map((event) => event.kind),
    ['permission-required'],
    'an unrelated active request is untouched',
  );
  upgraded.dispose();

  const again = new AttentionService({ store: { home: upgradeRoot } });
  assert.equal(await again.legacySyncDegradedRetired, 0, 'the retirement runs once');
  again.dispose();
  console.log('PASS: sync-degraded rows left by an older broker are resolved once on start');
} finally {
  rmSync(upgradeRoot, { recursive: true, force: true });
}
