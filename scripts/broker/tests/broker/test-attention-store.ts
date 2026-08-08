/**
 * Durable attention feed primitives: no broker, agent, network, or model required.
 *
 * Governing design: docs/architecture/attention.md
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  ATTENTION_RESOLVED_MAX,
  ATTENTION_RESOLVED_RETENTION_MS,
  AttentionStore,
} from '../../../../packages/typescript/broker/src/attention-store.ts';
import { BROKER_ROUTES, type AttentionEventUpsert } from '../../../../packages/typescript/adapter-api/src/index.ts';

const roots: string[] = [];
function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `cosyncing-attention-${name}-`));
  roots.push(root);
  return root;
}

let now = Date.UTC(2026, 6, 11, 12, 0, 0);
let id = 0;
const clock = () => now;
const idFactory = () => `evt-${++id}`;

function event(dedupeKey: string, overrides: Partial<AttentionEventUpsert> = {}): AttentionEventUpsert {
  return {
    dedupeKey,
    kind: 'permission-required',
    state: 'active',
    severity: 'action-required',
    title: 'Action needed',
    action: { kind: 'open-session', tool: 'test-adapter', sessionId: 'session-1' },
    presentationRevision: 1,
    ...overrides,
  };
}

async function testPersistenceDedupeAndClientState(): Promise<void> {
  const root = tempRoot('persistence');
  const path = join(root, 'attention-events.json');
  const store = new AttentionStore({ path, now: clock, idFactory });

  const first = await store.upsertEvent(event('permission:test:1'));
  assert.equal(first.created, true);
  assert.equal(first.changed, true);
  assert.equal(first.event.cursor, 1);
  assert.equal(first.event.revision, 1);

  const replay = await store.upsertEvent(event('permission:test:1'));
  assert.equal(replay.changed, false, 'an identical replay must not advance the feed');
  assert.equal(replay.event.cursor, 1);

  now += 1_000;
  const updated = await store.upsertEvent(event('permission:test:1', { summary: 'Still waiting' }));
  assert.equal(updated.event.cursor, 2);
  assert.equal(updated.event.revision, 2);

  await store.acknowledge(updated.event.id, 'client-a');
  await store.dismiss(updated.event.id, 'client-a');
  const pageA = store.getPage({ clientId: 'client-a' });
  const pageB = store.getPage({ clientId: 'client-b' });
  assert.equal(pageA.events[0]?.readAt, now);
  assert.equal(pageA.events[0]?.dismissedAt, now);
  assert.equal(pageB.events[0]?.readAt, undefined, 'client acknowledgement must remain isolated');
  assert.equal(pageB.events[0]?.dismissedAt, undefined, 'client dismissal must remain isolated');
  assert(pageA.cursor > updated.event.cursor, 'client-state mutations must advance the durable cursor');

  const resolved = await store.resolveByDedupeKey('permission:test:1');
  assert.equal(resolved?.state, 'resolved');
  assert.equal(resolved?.resolvedAt, now);
  assert.equal((await store.resolveByDedupeKey('permission:test:1'))?.cursor, resolved?.cursor,
    're-resolving must be idempotent');

  const reloaded = new AttentionStore({ path, now: clock, idFactory });
  const restored = reloaded.getPage({ clientId: 'client-a' });
  assert.equal(restored.events.length, 1);
  assert.equal(restored.events[0]?.state, 'resolved');
  assert.equal(restored.events[0]?.dismissedAt, now);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
}

async function testPaginationResetAndRetention(): Promise<void> {
  const root = tempRoot('retention');
  const path = join(root, 'attention-events.json');
  const store = new AttentionStore({
    path,
    now: clock,
    idFactory,
    resolvedRetentionMs: 1_000,
    maxResolved: 3,
  });

  const active = await store.upsertEvent(event('active'));
  for (let i = 0; i < 5; i++) {
    now += 10;
    await store.upsertEvent(event(`done:${i}`, {
      kind: 'run-finished',
      state: 'resolved',
      severity: 'informational',
      presentationRevision: 1,
      action: { kind: 'open-session', tool: 'test-adapter', sessionId: `session-${i}` },
    }));
  }
  await store.prune();
  const retained = store.getPage({ limit: 20 });
  assert.equal(retained.events.filter((item) => item.state === 'resolved').length, 3,
    'resolved history must obey the configured count cap');
  assert(retained.events.some((item) => item.id === active.event.id), 'active events must survive pruning');

  const reset = store.getPage({ after: 1, limit: 2 });
  assert.equal(reset.reset, true, 'a cursor older than deleted history must request reset');
  assert.equal(reset.events.length, 2);
  assert.equal(reset.hasMore, true);
  const continuation = store.getPage({ after: reset.cursor, limit: 20 });
  assert.equal(continuation.reset, false, 'a reset page cursor must permit forward pagination');

  now += 2_000;
  await store.prune();
  const afterAge = store.getPage({ limit: 20 });
  assert.equal(afterAge.events.filter((item) => item.state === 'resolved').length, 0,
    'resolved history must expire by age');
  assert(afterAge.events.some((item) => item.id === active.event.id), 'active retention is indefinite');

  assert.equal(ATTENTION_RESOLVED_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(ATTENTION_RESOLVED_MAX, 2_000);
}

async function testObservationsReservationsAndSerialization(): Promise<void> {
  const root = tempRoot('serialized');
  let persistenceWrites = 0;
  const store = new AttentionStore({
    path: join(root, 'attention-events.json'),
    now: clock,
    idFactory,
    onPersistenceResult: (ok) => {
      if (ok) persistenceWrites += 1;
    },
  });

  const stableObservation = {
    key: 'run:test:session:turn',
    kind: 'run',
    observedAt: now,
    data: { status: 'running', turnId: 'turn' },
  };
  await store.putObservation(stableObservation);
  assert.equal(store.getObservation('run:test:session:turn')?.data.turnId, 'turn');
  const writesAfterFirstObservation = persistenceWrites;
  now += 1_000;
  await store.putObservation(stableObservation);
  assert.equal(persistenceWrites, writesAfterFirstObservation,
    'an unchanged structured observation must not rewrite the snapshot only because updatedAt changed');
  await store.deleteObservation('run:test:session:turn');
  assert.equal(store.getObservation('run:test:session:turn'), undefined);

  const created = await store.upsertEvent(event('delivery'));
  const first = await store.reserveDelivery({ deviceId: 'phone', eventId: created.event.id, stage: 'immediate' });
  const duplicate = await store.reserveDelivery({ deviceId: 'phone', eventId: created.event.id, stage: 'immediate' });
  assert.equal(first.reserved, true);
  assert.equal(duplicate.reserved, false, 'overlapping scheduler ticks must not reserve twice');
  await store.completeDelivery(first.delivery.key);
  assert.equal(store.getDelivery(first.delivery.key)?.state, 'delivered');
  const completedDuplicate = await store.reserveDelivery({ deviceId: 'phone', eventId: created.event.id, stage: 'immediate' });
  assert.equal(completedDuplicate.reserved, false);

  const beforeRevision = created.event.presentationRevision;
  const [stageA, stageB] = await Promise.all([
    store.advancePresentationAndReserve(created.event.id, '15m', ['phone', 'tablet']),
    store.advancePresentationAndReserve(created.event.id, '15m', ['phone', 'tablet']),
  ]);
  assert.equal(stageA?.event.presentationRevision, beforeRevision + 1);
  assert.equal(stageB?.event.presentationRevision, beforeRevision + 1,
    'overlapping scheduler ticks must publish a stage only once');
  assert.equal(stageA?.reservations.filter((item) => item.reserved).length, 2);
  assert.equal(stageB?.reservations.filter((item) => item.reserved).length, 0);
  const tablet = stageA?.reservations.find((item) => item.delivery.deviceId === 'tablet')?.delivery;
  assert(tablet);
  await store.recordDeliveryFailure(tablet.key, now + 300_000);
  assert.equal(store.getDelivery(tablet.key)?.attempts, 1);
  assert.equal(store.getDelivery(tablet.key)?.nextAttemptAt, now + 300_000);
  assert.equal(await store.supersedeDeliveries(created.event.id, '15m'), 0);

  const concurrent = await Promise.all(
    Array.from({ length: 40 }, (_, index) => store.upsertEvent(event(`parallel:${index}`))),
  );
  const cursors = concurrent.map((item) => item.event.cursor);
  assert.equal(new Set(cursors).size, cursors.length, 'serialized mutations must allocate unique cursors');
  assert.deepEqual([...cursors].sort((a, b) => a - b), cursors, 'mutation queue must preserve call order');
  assert.equal(new AttentionStore({ path: join(root, 'attention-events.json'), now: clock, idFactory }).getPage({ limit: 100 }).events.length, 41);
}

async function testPresentationRevisionMonotonicForStoreUpdates(): Promise<void> {
  const root = tempRoot('revision');
  const store = new AttentionStore({ path: join(root, 'attention-events.json'), now: clock, idFactory });
  const created = await store.upsertEvent(event('revision:monotonic', { presentationRevision: 9 }));
  assert.equal(created.event.presentationRevision, 9);

  const downgraded = await store.upsertEvent(event('revision:monotonic', { presentationRevision: 1 }));
  assert.equal(downgraded.event.presentationRevision, 9, 'decreases from policy writes must be clamped');
  assert.equal(downgraded.event.revision, created.event.revision, 'downgrading with no semantic delta should not mutate revision');

  const recovered = await store.upsertEvent(event('revision:monotonic', { presentationRevision: 11, summary: 'next alert' }));
  assert.equal(recovered.event.presentationRevision, 11);
  assert.equal(recovered.event.revision, created.event.revision + 1, 'a real presentation bump should advance revision');
}

async function testRuntimeOccurrencePresentationOwnership(): Promise<void> {
  const root = tempRoot('runtime-occurrence');
  const store = new AttentionStore({ path: join(root, 'attention-events.json'), now: clock, idFactory });
  const transition = {
    agent: 'codex',
    state: 'pending' as const,
    fingerprint: 'semantic-fingerprint-a',
    dedupeKeyBase: 'runtime-update-ready:codex:0.1:0.2',
    legacyDedupeProvesFingerprint: true,
    event: {
      kind: 'runtime-update-ready',
      state: 'active',
      severity: 'maintenance',
      agent: 'codex',
      title: 'Runtime update ready',
      action: { kind: 'open-runtime-settings', agent: 'codex' },
      presentationRevision: 1,
      presentationStage: 'immediate',
    } as const,
  };
  const [first, duplicate] = await Promise.all([
    store.reconcileRuntimeUpdateOccurrence(transition),
    store.reconcileRuntimeUpdateOccurrence(transition),
  ]);
  assert(first?.created);
  assert.equal(duplicate?.created, false);
  assert.equal(store.listEvents().filter((item) => item.kind === 'runtime-update-ready').length, 1,
    'overlapping identical observations create one occurrence');
  const occurrence = first.event;

  await store.advancePresentationAndReserve(occurrence.id, '12h', ['phone']);
  const schedulerOwned = store.getEvent(occurrence.id);
  const reservations = store.listDeliveries();
  assert(schedulerOwned);

  const ordinaryUpsert = await store.upsertEvent({
    ...transition.event,
    dedupeKey: occurrence.dedupeKey,
    presentationRevision: 1,
    presentationStage: 'immediate',
  });
  assert.equal(ordinaryUpsert.changed, false,
    'ordinary upserts cannot write scheduler-owned runtime presentation fields');
  assert.deepEqual(store.getEvent(occurrence.id), schedulerOwned);
  assert.deepEqual(store.listDeliveries(), reservations);

  const regressed = await store.advancePresentationAndReserve(occurrence.id, '2h', ['phone']);
  assert.equal(regressed, undefined, 'runtime scheduler/store transitions reject a lower cadence rung');
  assert.deepEqual(store.getEvent(occurrence.id), schedulerOwned);
  assert.deepEqual(store.listDeliveries(), reservations);
}

async function testSemanticComparatorIgnoresNestedKeyOrderAndPresentationStageAppend(): Promise<void> {
  const root = tempRoot('semantic');
  const store = new AttentionStore({ path: join(root, 'attention-events.json'), now: clock, idFactory });

  const first = await store.upsertEvent(event('runtime-style', {
    kind: 'runtime-update-ready',
    severity: 'maintenance',
    title: 'Runtime update ready',
    summary: 'Ready for review',
    action: { kind: 'open-session', tool: 'test-adapter', sessionId: 'session-1' },
    presentationRevision: 1,
  }));

  await store.advancePresentationAndReserve(first.event.id, 'immediate', ['phone']);
  assert.equal(store.getEvent(first.event.id)?.presentationStage, 'immediate', 'presentation stage append must persist');

  const beforeHead = store.headCursor;
  const baseline = await store.getEvent(first.event.id);
  assert(baseline);

  const shuffledActionA = (() => {
    const payload: Record<string, unknown> = { tool: 'test-adapter' };
    payload.kind = 'open-session';
    payload.sessionId = 'session-1';
    return payload;
  })();
  const shuffledActionB = { kind: 'open-session', sessionId: 'session-1', tool: 'test-adapter' };

  for (let i = 0; i < 3; i++) {
    const next = await store.upsertEvent({
      ...event('runtime-style', {
        kind: 'runtime-update-ready',
        severity: 'maintenance',
        title: 'Runtime update ready',
        summary: 'Ready for review',
      }),
      action: i % 2 === 0 ? shuffledActionA : shuffledActionB,
    } as AttentionEventUpsert);
    assert.equal(next.created, false);
    assert.equal(next.changed, false);
    assert.equal(next.event.cursor, baseline.cursor, 'identical runtime-style upserts must not rewrite the cursor');
    assert.equal(next.event.revision, baseline.revision, 'identical runtime-style upserts must not rewrite revision');
    const current = store.getEvent(first.event.id);
    assert(current);
    assert.equal(current.cursor, baseline.cursor);
    assert.equal(current.revision, baseline.revision);
  }

  assert.equal(store.headCursor, beforeHead, 'three no-op upserts must not create store writes');
}

async function testBaselineThroughCursorOnPagination(): Promise<void> {
  const root = tempRoot('baseline');
  const store = new AttentionStore({ path: join(root, 'attention-events.json'), now: clock, idFactory });

  await store.upsertEvent(event('baseline:1'));
  await store.upsertEvent(event('baseline:2'));
  const firstPage = store.getPage({ clientId: 'phone', limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.baselineThroughCursor, 2,
    'the first page baseline is the fixed head, not merely the first page cursor');
  const firstCursor = firstPage.cursor;

  await store.upsertEvent(event('baseline:3'));
  const continuation = store.getPage({ clientId: 'phone', after: firstCursor, limit: 1 });
  assert.equal(continuation.events[0]?.cursor, 2,
    'the remaining pre-baseline event stays historical on a later page');
  assert.equal(continuation.events[0]!.cursor <= firstPage.baselineThroughCursor, true);
  const freshPage = store.getPage({ clientId: 'phone', after: continuation.cursor, limit: 1 });
  assert.equal(freshPage.events[0]?.cursor, 3);
  assert.equal(freshPage.events[0]!.cursor > firstPage.baselineThroughCursor, true,
    'an event created during catch-up stays fresh above the original baseline');

  const fresh = store.getPage({ clientId: 'tablet' });
  assert.equal(fresh.baselineThroughCursor, fresh.cursor, 'fresh clients report a fresh head baseline');
  assert.equal(fresh.events.length, 3);
}

async function testCorruptionAndUnknownKindTolerance(): Promise<void> {
  const root = tempRoot('corrupt');
  const path = join(root, 'attention-events.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(path, '{not-json');
  const warnings: string[] = [];
  const startup: Array<{ ok: boolean; detailCode?: string }> = [];
  const recovered = new AttentionStore({
    path,
    now: clock,
    idFactory,
    onWarning: (message) => warnings.push(message),
    onStartupResult: (ok, detailCode) => startup.push({ ok, detailCode }),
  });
  assert.equal(recovered.getPage({}).events.length, 0);
  assert.equal(existsSync(path), false, 'corrupt primary must be moved aside');
  assert(readdirSync(root).some((name) => name.startsWith('attention-events.json.') && name.endsWith('.corrupt')));
  assert.equal(warnings.length, 1, 'corruption must produce a visible warning callback');
  assert.deepEqual(startup, [{ ok: false, detailCode: 'startup-corrupt' }],
    'corruption must emit only a sanitized startup health code');

  await recovered.upsertEvent(event('after-corruption'));
  assert.equal(existsSync(path), true, 'the quarantined store must accept a clean replacement snapshot');
  assert.deepEqual(startup, [{ ok: false, detailCode: 'startup-corrupt' }],
    'same-process writes must not erase the startup corruption episode');
  const restartStartup: Array<{ ok: boolean; detailCode?: string }> = [];
  const restarted = new AttentionStore({
    path,
    now: clock,
    idFactory,
    onStartupResult: (ok, detailCode) => restartStartup.push({ ok, detailCode }),
  });
  assert.equal(restarted.getPage({}).events.length, 1);
  assert.deepEqual(restartStartup, [{ ok: true, detailCode: undefined }],
    'a restart that loads the clean replacement must report recovery');

  writeFileSync(path, JSON.stringify({
    version: 1,
    nextCursor: 2,
    prunedThroughCursor: 0,
    events: [{
      id: 'future-1', cursor: 1, revision: 1, presentationRevision: 1,
      kind: 'future-attention-kind', state: 'resolved', severity: 'informational',
      dedupeKey: 'future:1', createdAt: now, updatedAt: now, resolvedAt: now,
      title: 'Newer broker event', action: { kind: 'open-attention-inbox' },
      futureScope: { keep: true },
    }],
    observations: [], clientStates: [], deliveries: [],
  }));
  const downgraded = new AttentionStore({ path, now: clock, idFactory });
  assert.equal(downgraded.getPage({}).events[0]?.kind, 'future-attention-kind',
    'one unknown future kind must survive loading and paging');
  assert.equal(downgraded.getPage({}).events[0]?.sessionTitle, undefined,
    'old records without a session title remain valid');
  assert.deepEqual((downgraded.getPage({}).events[0] as any)?.futureScope, { keep: true },
    'unknown newer event fields survive normalization');
  await downgraded.acknowledge('future-1', 'phone');
  assert.deepEqual(
    (new AttentionStore({ path, now: clock, idFactory }).getPage({ clientId: 'phone' }).events[0] as any)?.futureScope,
    { keep: true },
    'unknown newer event fields survive a durable client-state rewrite and replay',
  );

  const blockedRoot = tempRoot('write-failure');
  const blocker = join(blockedRoot, 'not-a-directory');
  writeFileSync(blocker, 'file');
  const unwritable = new AttentionStore({ path: join(blocker, 'attention-events.json'), now: clock, idFactory });
  await assert.rejects(unwritable.upsertEvent(event('must-rollback')));
  assert.equal(unwritable.headCursor, 0, 'failed atomic persistence must roll back the in-memory cursor');
  assert.equal(unwritable.getPage({}).events.length, 0, 'failed atomic persistence must not publish memory-only state');
}

async function main(): Promise<void> {
  assert(BROKER_ROUTES.includes('/api/attention-events'));
  assert(BROKER_ROUTES.includes('/api/attention-events/dismiss-batch'));
  assert(BROKER_ROUTES.includes('/api/attention-events/{id}/ack'));
  assert(BROKER_ROUTES.includes('/api/attention-events/{id}/dismiss'));
  await testPersistenceDedupeAndClientState();
  await testPaginationResetAndRetention();
  await testObservationsReservationsAndSerialization();
  await testPresentationRevisionMonotonicForStoreUpdates();
  await testRuntimeOccurrencePresentationOwnership();
  await testSemanticComparatorIgnoresNestedKeyOrderAndPresentationStageAppend();
  await testBaselineThroughCursorOnPagination();
  await testCorruptionAndUnknownKindTolerance();
  console.log('PASS broker attention store (8 groups)');
}

try {
  await main();
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
