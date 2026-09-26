#!/usr/bin/env bun
// The broker names the notification type and slot of every event it serves, and marks an event
// seen once any client reads or dismisses it, so every other client clears its notification.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttentionEvent, AttentionEventUpsert } from '@cosyncing/protocol';
import type { SessionInfo } from '../../../adapter-api/src/index.ts';
import {
  attentionNotificationCollapseKey,
  attentionNotificationType,
  attentionSessionView,
} from '../../src/attention/attention-notification-type.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';

const fixturePath = join(import.meta.dir, '../../../../../contracts/fixtures/attention-notification-types.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: Array<{ name: string; event: AttentionEvent; notificationType: string | null; collapseKey: string | null }>;
};

const roots: string[] = [];
const tempRoot = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `cosyncing-attention-fields-${label}-`));
  roots.push(root);
  return root;
};

let now = 1_000;
let ids = 0;
const clock = () => now;
const idFactory = () => `event-${++ids}`;

function outcome(dedupeKey: string, overrides: Partial<AttentionEventUpsert> = {}): AttentionEventUpsert {
  return {
    dedupeKey,
    kind: 'run-finished',
    state: 'active',
    severity: 'informational',
    title: 'Turn finished',
    sessionTitle: 'Refactor the parser',
    action: { kind: 'open-session', tool: 'claude', sessionId: 'session-1' },
    presentationRevision: 1,
    ...overrides,
  };
}

const passed: string[] = [];
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  await body();
  passed.push(name);
}

try {
  await check('every shared case maps to the same type and slot as the client', () => {
    assert.ok(fixture.cases.length >= 15, 'the shared case file is loaded');
    for (const item of fixture.cases) {
      const type = attentionNotificationType(item.event);
      assert.equal(type ?? null, item.notificationType, `${item.name}: type`);
      const collapseKey = type === undefined ? null : attentionNotificationCollapseKey(item.event, type);
      assert.equal(collapseKey, item.collapseKey, `${item.name}: collapse key`);
    }
  });

  await check('a read marks the event seen once and puts it on every other client\'s next page', async () => {
    const store = new AttentionStore({ path: join(tempRoot('read'), 'attention-events.json'), now: clock, idFactory });
    const created = (await store.upsertEvent(outcome('run-finished:claude:session-1:run:u1'))).event;
    const tabletBefore = store.getPage({ clientId: 'tablet' });

    now += 10;
    await store.acknowledge(created.id, 'phone');
    const seen = store.getEvent(created.id)!;
    assert.equal(seen.seenAt, now);
    assert.equal(seen.revision, created.revision, 'seeing is not a revision: nothing re-presents');
    assert.equal(seen.presentationRevision, created.presentationRevision);
    assert.ok(seen.cursor > created.cursor, 'the event moves to a new cursor');

    const tabletAfter = store.getPage({ clientId: 'tablet', after: tabletBefore.cursor });
    assert.deepEqual(tabletAfter.events.map((event) => event.id), [created.id]);
    assert.equal(tabletAfter.events[0]!.seenAt, now);
    assert.equal(tabletAfter.events[0]!.readAt, undefined, 'the tablet\'s own read state is its own');

    const firstSeenAt = now;
    now += 10;
    const cursorAfterFirst = store.getEvent(created.id)!.cursor;
    await store.acknowledge(created.id, 'tablet');
    assert.equal(store.getEvent(created.id)!.seenAt, firstSeenAt, 'set once, by the first client');
    assert.equal(store.getEvent(created.id)!.cursor, cursorAfterFirst, 'a later read does not move the event');
  });

  await check('a dismissal, single or batched, marks the event seen too', async () => {
    const store = new AttentionStore({ path: join(tempRoot('dismiss'), 'attention-events.json'), now: clock, idFactory });
    const single = (await store.upsertEvent(outcome('run-finished:a'))).event;
    const batched = (await store.upsertEvent(outcome('run-finished:b'))).event;
    now += 5;
    await store.dismiss(single.id, 'phone');
    await store.dismissBatch([{ eventId: batched.id, revision: batched.revision }], 'phone');
    assert.equal(store.getEvent(single.id)!.seenAt, now);
    assert.equal(store.getEvent(batched.id)!.seenAt, now);
  });

  await check('an exact-revision dismissal on another client still applies after the event is seen', async () => {
    const store = new AttentionStore({ path: join(tempRoot('exact'), 'attention-events.json'), now: clock, idFactory });
    const created = (await store.upsertEvent(outcome('run-finished:c'))).event;
    await store.dismissBatch([{ eventId: created.id, revision: created.revision }], 'tablet');
    now += 5;
    await store.acknowledge(created.id, 'phone');
    const tablet = store.getPage({ clientId: 'tablet' }).events.find((event) => event.id === created.id)!;
    assert.ok(tablet.dismissedAt !== undefined, 'the tablet\'s dismissal survives another client\'s read');
  });

  await check('a later alert stage or a reopened event is unseen again; the first alert is not', async () => {
    const store = new AttentionStore({ path: join(tempRoot('realert'), 'attention-events.json'), now: clock, idFactory });
    const request = (await store.upsertEvent(outcome('permission-required:claude:session-1:req-1', {
      kind: 'permission-required', severity: 'action-required', presentationStage: undefined,
    }))).event;
    now += 1;
    await store.acknowledge(request.id, 'phone');
    await store.advancePresentationAndReserve(request.id, 'immediate', []);
    assert.equal(store.getEvent(request.id)!.seenAt, now, 'the first stage is the alert a read may have raced');

    now += 15 * 60_000;
    await store.advancePresentationAndReserve(request.id, '15m', []);
    assert.equal(store.getEvent(request.id)!.seenAt, undefined, 'a reminder alerts every client again');

    const outcomeEvent = (await store.upsertEvent(outcome('run-finished:d'))).event;
    await store.acknowledge(outcomeEvent.id, 'phone');
    await store.upsertEvent(outcome('run-finished:d', { state: 'resolved' }));
    assert.ok(store.getEvent(outcomeEvent.id)!.seenAt !== undefined, 'resolving keeps it seen');
    await store.upsertEvent(outcome('run-finished:d'));
    assert.equal(store.getEvent(outcomeEvent.id)!.seenAt, undefined, 'reopening makes it unseen');

    const raised = (await store.upsertEvent(outcome('run-finished:e'))).event;
    await store.acknowledge(raised.id, 'phone');
    await store.upsertEvent(outcome('run-finished:e', { summary: 'same alert, new detail' }));
    assert.ok(store.getEvent(raised.id)!.seenAt !== undefined, 'an update that does not re-alert keeps it seen');
    await store.upsertEvent(outcome('run-finished:e', { presentationRevision: 2 }));
    assert.equal(store.getEvent(raised.id)!.seenAt, undefined, 'a re-alert makes it unseen');
  });

  await check('seenAt survives a restart; the served fields are never stored', async () => {
    const root = tempRoot('persist');
    const path = join(root, 'attention-events.json');
    const service = new AttentionService({ store: { path, now: clock, idFactory }, policy: { now: clock } });
    const created = (await service.upsertEvent(outcome('run-finished:claude:session-1:run:u9'))).event;
    await service.acknowledge(created.id, 'phone');
    const page = await service.getEvents({ clientId: 'tablet', waitMs: 0 });
    const served = page.events.find((event) => event.id === created.id)!;
    assert.equal(served.notificationType, 'turn_finished');
    assert.equal(served.collapseKey, 'session-outcome:claude:session-1');
    assert.equal(served.seenAt, now);

    const onDisk = readFileSync(path, 'utf8');
    assert.ok(!onDisk.includes('notificationType') && !onDisk.includes('collapseKey'), 'type and slot are derived, not stored');
    const reloaded = new AttentionStore({ path, now: clock, idFactory });
    assert.equal(reloaded.getEvent(created.id)!.seenAt, now);
    service.dispose?.();
  });

  await check('an event that is never a notification is served without a type or slot', async () => {
    const service = new AttentionService({
      store: { path: join(tempRoot('none'), 'attention-events.json'), now: clock, idFactory },
      policy: { now: clock },
    });
    await service.upsertEvent(outcome('scheduled-send:1', { kind: 'scheduled-send', state: 'resolved' }));
    const served = (await service.getEvents({ clientId: 'phone', waitMs: 0 })).events[0]!;
    assert.equal(served.notificationType, undefined);
    assert.equal(served.collapseKey, undefined);
    service.dispose?.();
  });

  await check('a run the tool opened itself never notifies; a prompted one still does', async () => {
    const store = new AttentionStore({ path: join(tempRoot('origin'), 'attention-events.json'), now: clock, idFactory });
    const policy = new AttentionPolicy(store, { now: clock });
    const session: SessionInfo = {
      id: 'session-1', tool: 'claude', machine: 'test', title: 'Refactor', status: 'idle', attachMode: 'live',
    };
    for (const status of ['done', 'error'] as const) {
      const key = `session-1:run:wake-${status}`;
      await policy.handleMessage(session, { type: 'run-summary', key, turnId: `wake-${status}`, status: 'running', origin: 'background' });
      now += 60_000;
      await policy.handleMessage(session, { type: 'run-summary', key, turnId: `wake-${status}`, status, origin: 'background' });
    }
    assert.equal(store.listEvents().length, 0, 'a background continuation raises nothing');
    assert.equal(store.listObservations().length, 0, 'and leaves no run open');

    await policy.handleMessage(session, { type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'running', origin: 'user' });
    now += 60_000;
    await policy.handleMessage(session, { type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'done', origin: 'user' });
    assert.equal(store.findByDedupeKey('run-finished:claude:session-1:session-1:run:u1')?.kind, 'run-finished');
  });

  await check('a session named in Cosyncing notifies under that name, as the roster shows it', async () => {
    const store = new AttentionStore({ path: join(tempRoot('title'), 'attention-events.json'), now: clock, idFactory });
    const policy = new AttentionPolicy(store, { now: clock });
    const native: SessionInfo = {
      id: 'session-7', tool: 'claude', machine: 'test', title: 'workspace', status: 'idle', attachMode: 'live',
    };
    const titles = new Map([['claude:session-7', 'Refactor the parser']]);
    const titleOf = (tool: string, id: string) => titles.get(`${tool}:${id}`);
    const named = attentionSessionView(native, titleOf);
    assert.equal(named.title, 'Refactor the parser');
    assert.equal(native.title, 'workspace', 'the adapter\'s own info is not changed');
    assert.equal(attentionSessionView({ ...native, id: 'other' }, titleOf).title, 'workspace', 'no title given here keeps the native one');
    titles.set('claude:session-7', '   ');
    assert.equal(attentionSessionView(native, titleOf).title, 'workspace', 'a blank title is no title');
    titles.set('claude:session-7', 'Refactor the parser');

    await policy.handleMessage(named, { type: 'run-summary', key: 'session-7:run:u1', turnId: 'u1', status: 'running' });
    now += 60_000;
    await policy.handleMessage(attentionSessionView(native, titleOf), { type: 'run-summary', key: 'session-7:run:u1', turnId: 'u1', status: 'done' });
    assert.equal(store.findByDedupeKey('run-finished:claude:session-7:session-7:run:u1')?.sessionTitle, 'Refactor the parser');
  });

  await check('a step that does not end its turn closes silently; the last step notifies once', async () => {
    const store = new AttentionStore({ path: join(tempRoot('steps'), 'attention-events.json'), now: clock, idFactory });
    const policy = new AttentionPolicy(store, { now: clock });
    const session: SessionInfo = {
      id: 'session-9', tool: 'kilo', machine: 'test', title: 'Tools', status: 'idle', attachMode: 'live',
    };
    await policy.handleMessage(session, { type: 'run-summary', key: 'kilo:run:step-1', turnId: 'step-1', status: 'running' });
    now += 1_000;
    await policy.handleMessage(session, { type: 'run-summary', key: 'kilo:run:step-1', turnId: 'step-1', status: 'done', turnContinues: true });
    assert.equal(store.listEvents().length, 0, 'a tool-calling step raises nothing');
    assert.equal(store.listObservations().length, 0, 'and leaves no run open');
    await policy.handleMessage(session, { type: 'run-summary', key: 'kilo:run:step-2', turnId: 'step-2', status: 'running' });
    now += 1_000;
    await policy.handleMessage(session, { type: 'run-summary', key: 'kilo:run:step-2', turnId: 'step-2', status: 'done' });
    assert.deepEqual(store.listEvents().map((event) => event.dedupeKey), ['run-finished:kilo:session-9:kilo:run:step-2']);
  });

  for (const name of passed) console.log(`PASS  ${name}`);
  console.log(`\n${passed.length} passed, 0 failed`);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
