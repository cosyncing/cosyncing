#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionService, normalizeAttentionClientId } from '../../src/attention/attention-service.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-service-'));
let now = 1_000;
const persistence: boolean[] = [];
const service = new AttentionService({
  store: { home: root, now: () => now, idFactory: () => `event-${now}`, onPersistenceResult: (ok) => persistence.push(ok) },
  policy: { now: () => now },
});

try {
  assert.equal(normalizeAttentionClientId('phone-1'), 'phone-1');
  assert.throws(() => normalizeAttentionClientId('bad id'), /clientId/);
  assert.throws(() => normalizeAttentionClientId(''), /clientId/);

  const empty = await service.getEvents({ after: 0, limit: 20, waitMs: 0, clientId: 'phone-1' });
  assert.equal(empty.events.length, 0);

  const waiting = service.getEvents({ after: empty.cursor, limit: 20, waitMs: 5_000, clientId: 'phone-1' });
  await Promise.resolve();
  now += 1;
  const created = await service.upsertEvent({
    dedupeKey: 'device-paired:phone-2', kind: 'device-paired', state: 'resolved',
    severity: 'informational', title: 'New device paired',
    action: { kind: 'open-attention-inbox' }, presentationRevision: 1, presentationStage: 'immediate',
  });
  const page = await waiting;
  assert.equal(page.events[0]?.id, created.event.id, 'long poll wakes on the durable mutation');

  await service.acknowledge(created.event.id, 'phone-1');
  await service.dismiss(created.event.id, 'phone-1');
  const phone = await service.getEvents({ after: 0, limit: 20, waitMs: 0, clientId: 'phone-1' });
  const tablet = await service.getEvents({ after: 0, limit: 20, waitMs: 0, clientId: 'tablet-1' });
  assert.ok(phone.events[0]?.readAt && phone.events[0]?.dismissedAt);
  assert.equal(tablet.events[0]?.readAt, undefined);
  assert.equal(tablet.events[0]?.dismissedAt, undefined);

  // Hub intentionally fire-and-forgets policy work. A native app-server can
  // emit these two summaries in one input chunk, so the second call starts
  // before the first durable mutation resolves.
  const session = {
    id: 'native-session',
    tool: 'codex',
    title: 'Native session',
    status: 'idle' as const,
    attachMode: 'live' as const,
  };
  const running = service.handleMessage(session, {
    type: 'run-summary',
    key: 'codex:run:native-turn',
    turnId: 'native-turn',
    status: 'running',
    source: 'codex-app-server',
  });
  const completed = service.handleMessage(session, {
    type: 'run-summary',
    key: 'codex:run:native-turn',
    turnId: 'native-turn',
    status: 'done',
    source: 'codex-app-server',
  });
  await Promise.all([running, completed]);
  const nativeCompletion = service.store.findByDedupeKey(
    'run-finished:codex:native-session:native-turn',
  );
  assert.equal(nativeCompletion?.state, 'resolved');
  assert.equal(nativeCompletion?.presentationRevision, 1);
  await service.handleMessage(session, {
    type: 'run-summary',
    key: 'codex:run:native-turn',
    turnId: 'native-turn',
    status: 'done',
    source: 'codex-app-server',
  });
  assert.equal(
    service.store.listEvents().filter((event) =>
      event.dedupeKey === 'run-finished:codex:native-session:native-turn').length,
    1,
    'replaying the short terminal summary cannot duplicate its durable event',
  );

  const timeoutStarted = Date.now();
  const timed = await service.getEvents({ after: service.store.headCursor, waitMs: 20, clientId: 'phone-1' });
  assert.equal(timed.events.length, 0);
  assert.ok(Date.now() - timeoutStarted >= 10);
  assert.ok(persistence.every(Boolean), 'successful store writes report health success');
  console.log('PASS: attention service long-poll, cursor wake, client isolation, ordered native completion, validation, and store health callback');
} finally {
  service.dispose();
  rmSync(root, { recursive: true, force: true });
}
