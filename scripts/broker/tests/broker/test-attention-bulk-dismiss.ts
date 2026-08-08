#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTENTION_BULK_DISMISS_MAX } from '../../../../packages/typescript/protocol/src/index.ts';
import { AttentionService, normalizeAttentionBulkDismissItems } from '../../../../packages/typescript/broker/src/attention-service.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-bulk-'));
let now = 1_000;
let id = 0;
let durableWrites = 0;
const service = new AttentionService({
  store: {
    home: root,
    now: () => now,
    idFactory: () => `event-${++id}`,
    onPersistenceResult: (ok) => {
      if (ok) durableWrites += 1;
    },
  },
});

const createEvent = (dedupeKey: string) => service.upsertEvent({
  dedupeKey,
  kind: 'run-finished',
  state: 'resolved',
  severity: 'informational',
  sessionId: dedupeKey,
  sessionTitle: `Session ${dedupeKey}`,
  title: 'Run finished',
  action: { kind: 'open-session', tool: 'codex', sessionId: dedupeKey },
  presentationRevision: 1,
  presentationStage: 'immediate',
});

try {
  const accepted = await createEvent('accepted');
  const changed = await createEvent('changed');
  const later = await createEvent('later');
  now += 1;
  const changedAgain = await service.upsertEvent({
    ...changed.event,
    summary: 'newer revision',
  });
  assert.equal(changedAgain.event.revision, 2);

  const writesBeforeBatch = durableWrites;
  now += 1;
  const result = await service.dismissBatch([
    { eventId: accepted.event.id, revision: accepted.event.revision },
    { eventId: changed.event.id, revision: changed.event.revision },
    { eventId: 'missing', revision: 1 },
  ], 'phone');
  assert.deepEqual(
    result.accepted.map((item) => item.eventId),
    [accepted.event.id],
    'only the exact unchanged revision is accepted',
  );
  assert.deepEqual(result.stale, [{
    eventId: changed.event.id,
    revision: 1,
    currentRevision: 2,
  }]);
  assert.deepEqual(result.notFound, [{ eventId: 'missing', revision: 1 }]);
  assert.equal(durableWrites, writesBeforeBatch + 1,
    'one mixed bulk request performs one durable store write');

  const page = await service.getEvents({ clientId: 'phone' });
  assert.ok(page.events.find((event) => event.id === accepted.event.id)?.dismissedAt);
  assert.equal(page.events.find((event) => event.id === changed.event.id)?.dismissedAt, undefined);
  assert.equal(page.events.find((event) => event.id === later.event.id)?.dismissedAt, undefined,
    'an event outside the captured snapshot survives');

  const writesBeforeRetry = durableWrites;
  const retry = await service.dismissBatch([
    { eventId: accepted.event.id, revision: accepted.event.revision },
  ], 'phone');
  assert.equal(retry.accepted.length, 1);
  assert.equal(durableWrites, writesBeforeRetry,
    'an exact retry is accepted without another durable write');

  now += 1;
  await service.upsertEvent({
    ...accepted.event,
    summary: 'arrived after Clear all',
  });
  const afterRevision = await service.getEvents({ clientId: 'phone' });
  assert.equal(
    afterRevision.events.find((event) => event.id === accepted.event.id)?.dismissedAt,
    undefined,
    'a later revision is not hidden by an earlier snapshot dismissal',
  );

  now += 1;
  const revisionScopedState = service.store.getClientState(
    'phone',
    accepted.event.id,
  );
  const writesBeforeSingleDismiss = durableWrites;
  await service.dismiss(accepted.event.id, 'phone');
  const eventWideState = service.store.getClientState(
    'phone',
    accepted.event.id,
  );
  const afterSingleDismiss = await service.getEvents({ clientId: 'phone' });
  assert.ok(
    afterSingleDismiss.events.find((event) => event.id === accepted.event.id)?.dismissedAt,
    'single Dismiss hides a newer event after an exact bulk dismissal',
  );
  assert.equal(
    eventWideState?.dismissedRevision,
    undefined,
    'single Dismiss restores event-wide legacy semantics',
  );
  assert.ok(
    (eventWideState?.cursor ?? 0) > (revisionScopedState?.cursor ?? 0),
    'single Dismiss advances the client-state cursor',
  );
  assert.equal(
    durableWrites,
    writesBeforeSingleDismiss + 1,
    'single Dismiss persists the event-wide state conversion',
  );

  now += 1;
  await service.upsertEvent({
    ...accepted.event,
    summary: 'later revision remains dismissed',
  });
  const afterLaterRevision = await service.getEvents({ clientId: 'phone' });
  assert.ok(
    afterLaterRevision.events.find((event) => event.id === accepted.event.id)?.dismissedAt,
    'legacy single Dismiss remains effective for later revisions',
  );

  assert.throws(
    () => normalizeAttentionBulkDismissItems(
      Array.from({ length: ATTENTION_BULK_DISMISS_MAX + 1 }, (_, index) => ({
        eventId: `event-${index}`,
        revision: 1,
      })),
    ),
    /at most/,
  );
  assert.throws(
    () => normalizeAttentionBulkDismissItems([
      { eventId: 'duplicate', revision: 1 },
      { eventId: 'duplicate', revision: 1 },
    ]),
    /duplicate/,
  );

  console.log(
    'PASS broker attention bulk dismissal exactness, one-write durability, '
      + 'idempotent retry, partial results, single-dismiss compatibility, '
      + 'later-revision survival, and hard bounds (7 groups)',
  );
} finally {
  service.dispose();
  rmSync(root, { recursive: true, force: true });
}
