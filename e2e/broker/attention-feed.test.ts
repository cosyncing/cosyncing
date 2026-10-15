/**
 * The attention feed: what an agent's activity puts in front of the user, and how each app client
 * reads, marks and clears it.
 *
 * Activity comes from a live Pi session (the bridge extension, scripted): permission requests,
 * questions, turns that finish or fail, a session that ends. The app side is the feed API
 * (`/api/attention-events`) as several clients use it at once. The broker's attention clock is
 * the movable test clock, so the hour-long authentication cooldown and the thirty-day retention are
 * reached by moving time, not by waiting.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ATTENTION_BULK_DISMISS_MAX } from '../../packages/typescript/protocol/src/index.ts';
import { type Broker, type BrokerClient, eventually, never, startBroker } from '../harness/index.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-session.ts';
import { DAY, MINUTE, TestClock } from '../harness/fakes/test-clock.ts';

let broker: Broker;
let owner: BrokerClient;
let clock: TestClock;
let tokdash: ReturnType<typeof Bun.serve>;

/** A Tokdash sidecar whose Codex five-hour bucket has 20% left. */
function startTokdash(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/quota') return new Response('not found', { status: 404 });
      return Response.json({
        enabled: true,
        timestamp: 1,
        providers: {
          codex: {
            provider: 'codex', network_enabled: false, status: 'ok', status_detail: null,
            status_at: 1, updated_at: 1, sources: ['codex_session'], estimated: true,
            buckets: [{
              account: 'local', bucket: '5h', bucket_label: '5 hour', used_percent: 80,
              remaining_percent: 20, resets_at: 123, captured_at: 1, source: 'codex_session', status: 'ok',
            }],
          },
        },
      });
    },
  });
}

beforeAll(async () => {
  tokdash = startTokdash();
  broker = await startBroker({
    name: 'attention',
    token: true,
    env: (paths) => {
      clock = new TestClock(paths.root);
      return { ...clock.env, COSYNCING_TOKDASH_URL: `http://127.0.0.1:${tokdash.port}` };
    },
  });
  owner = broker.client();
});

afterAll(async () => {
  await broker?.stop();
  tokdash?.stop(true);
});

// ── Feed helpers, as a client uses the API ─────────────────────────────────

async function page(clientId: string, query: Record<string, string | number> = {}): Promise<any> {
  const params = new URLSearchParams({ clientId, ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) });
  const response = await owner.get(`/api/attention-events?${params}`);
  expect(response.status).toBe(200);
  return response.body;
}

/** Every retained event as `clientId` sees it, paging from the start. */
async function feed(clientId: string): Promise<any[]> {
  const events: any[] = [];
  let next = await page(clientId, { limit: 200 });
  events.push(...next.events);
  while (next.hasMore) {
    next = await page(clientId, { after: next.cursor, limit: 200 });
    events.push(...next.events);
  }
  return events;
}

async function sessionEvents(session: PiBridgeSession, clientId = 'e2e-observer'): Promise<any[]> {
  return (await feed(clientId)).filter((event) => event.sessionId === session.id);
}

/** Wait until the session's events satisfy `ready`, and return them. */
function waitForSessionEvents(
  session: PiBridgeSession,
  ready: (events: any[]) => boolean,
  what: string,
  clientId?: string,
): Promise<any[]> {
  return eventually(async () => {
    const events = await sessionEvents(session, clientId);
    return ready(events) ? events : undefined;
  }, { what });
}

const byKey = (events: any[], dedupeKey: string) => events.find((event) => event.dedupeKey === dedupeKey);

async function headCursor(): Promise<number> {
  return (await page('e2e-head', { limit: 1 })).baselineThroughCursor;
}

const ack = (eventId: string, clientId: string) => owner.post(`/api/attention-events/${encodeURIComponent(eventId)}/ack`, { clientId });
const dismiss = (eventId: string, clientId: string) => owner.post(`/api/attention-events/${encodeURIComponent(eventId)}/dismiss`, { clientId });
const dismissBatch = (clientId: string, events: unknown) => owner.post('/api/attention-events/dismiss-batch', { clientId, events });

const open = (name: string, title?: string) => PiBridgeSession.open(owner, broker.paths.root, name, { title });

// ── What agent activity raises ─────────────────────────────────────────────

describe('agent activity', () => {
  test('a permission request raises one generic event under the session title; the answer reaches the agent and resolves it', async () => {
    const pi = await open('request', 'Refactor the parser');
    const secret = 'rm -rf ~/secret-project';
    await pi.emit({ t: 'permission-request', requestId: 'p1', title: `Run ${secret}`, detail: secret, toolName: 'bash' });
    await pi.emit({ t: 'permission-request', requestId: 'p1', title: `Run ${secret} again`, detail: secret, toolName: 'bash' });
    await pi.emit({ t: 'question-request', requestId: 'q1', questions: [{ question: 'Deploy to secret-staging?', options: [{ label: 'yes' }] }] });

    const permissionKey = `permission-required:pi:${pi.id}:p1`;
    const questionKey = `question-required:pi:${pi.id}:q1`;
    // The question came after the replay, so the replay has been handled once it is listed.
    const raised = await waitForSessionEvents(pi, (events) => !!byKey(events, questionKey), 'the question event');
    expect(raised.filter((event) => event.kind === 'permission-required')).toHaveLength(1);
    expect(byKey(raised, permissionKey)).toMatchObject({
      kind: 'permission-required',
      state: 'active',
      severity: 'action-required',
      title: 'Permission required',
      summary: 'An agent is waiting for permission.',
      sessionTitle: 'Refactor the parser',
      requestId: 'p1',
      agent: 'pi',
      action: { kind: 'open-session', tool: 'pi', sessionId: pi.id },
      notificationType: 'permission_request',
      collapseKey: permissionKey,
    });
    expect(byKey(raised, questionKey)).toMatchObject({
      state: 'active',
      title: 'Question requires an answer',
      notificationType: 'question',
      collapseKey: questionKey,
    });
    // Notifications carry generic copy: never the command, the detail or the question.
    expect(JSON.stringify(raised)).not.toContain('secret');

    const stream = await owner.attach('pi', pi.id);
    await stream.waitForKind('history');
    expect((await stream.sendAndAwait({ kind: 'approve', requestId: 'p1', decision: 'approve' })).kind).toBe('ack');
    expect(await pi.commands()).toContainEqual(expect.objectContaining({ kind: 'permission', requestId: 'p1', decision: 'approve' }));
    stream.close();

    await pi.emit({ t: 'permission-resolved', requestId: 'p1', decision: 'approve' }, { t: 'question-resolved', requestId: 'q1' });
    const resolved = await waitForSessionEvents(
      pi,
      (events) => byKey(events, permissionKey)?.state === 'resolved' && byKey(events, questionKey)?.state === 'resolved',
      'both requests resolved',
    );
    expect(resolved.filter((event) => event.kind === 'permission-required')).toHaveLength(1);
  });

  test('a finished and a failed turn each raise one outcome; a turn never seen running, or replayed, raises nothing more', async () => {
    const pi = await open('outcomes', 'Release notes');
    // A terminal frame with no running half: the broker never saw this turn start.
    await pi.emit({ t: 'run', key: 'unseen', turnId: 'unseen', status: 'done' });
    // Running and done in one batch, as a native session reports a short turn.
    await pi.turn('u1');
    await pi.emit({ t: 'run', key: 'u1', turnId: 'u1', status: 'done' });
    await pi.turn('u2', 'error');

    const events = await waitForSessionEvents(
      pi,
      (found) => found.some((event) => event.kind === 'run-failed'),
      'the failed turn',
    );
    expect(events.map((event) => [event.kind, event.turnId])).toEqual([
      ['run-finished', 'u1'],
      ['run-failed', 'u2'],
    ]);
    const outcomeSlot = `session-outcome:pi:${pi.id}`;
    expect(events[0]).toMatchObject({
      state: 'resolved',
      severity: 'informational',
      title: 'Agent run finished',
      sessionTitle: 'Release notes',
      notificationType: 'turn_finished',
      collapseKey: outcomeSlot,
    });
    expect(events[1]).toMatchObject({
      state: 'resolved',
      title: 'Agent run failed',
      notificationType: 'turn_failed',
      collapseKey: outcomeSlot,
    });
  });

  test('a session that ends resolves its open question, and its unfinished turn can no longer notify', async () => {
    const pi = await open('ending');
    await pi.emit(
      { t: 'question-request', requestId: 'open', questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }] },
      { t: 'run', key: 'late', turnId: 'late', status: 'running' },
    );
    const questionKey = `question-required:pi:${pi.id}:open`;
    await waitForSessionEvents(pi, (events) => byKey(events, questionKey)?.state === 'active', 'the open question');

    await pi.bye('quit');
    await waitForSessionEvents(pi, (events) => byKey(events, questionKey)?.state === 'resolved', 'the question resolved by the end');

    // The same session file starts again; the old turn's terminal frame arrives late.
    await pi.hello();
    await pi.emit({ t: 'run', key: 'late', turnId: 'late', status: 'done' });
    await pi.turn('fresh');
    const events = await waitForSessionEvents(
      pi,
      (found) => found.some((event) => event.turnId === 'fresh'),
      'the new turn',
    );
    expect(events.filter((event) => event.kind === 'run-finished').map((event) => event.turnId)).toEqual(['fresh']);
  });

  test('a quota below its threshold raises a usage warning once warnings are on', async () => {
    expect((await owner.get('/api/tokdash/quota-preference')).body.enabled).toBe(false);
    expect((await owner.post('/api/tokdash/quota-preference', { enabled: true })).status).toBe(200);
    const quota = await owner.get('/api/tokdash/quota');
    expect(quota.body.ok).toBe(true);
    expect(quota.body.data.providers.codex.buckets[0].remaining_percent).toBe(20);
    const warning = await eventually(async () =>
      (await feed('e2e-observer')).find((event) => event.kind === 'usage-threshold'), { what: 'a usage warning' });
    expect(warning).toMatchObject({ state: 'active', severity: 'maintenance', notificationType: 'usage_quota' });
  });
});

// ── Reading the feed ───────────────────────────────────────────────────────

describe('the feed', () => {
  test('a first page fixes a baseline; events raised during catch-up arrive above it', async () => {
    const pi = await open('catch-up');
    await pi.turn('before-1');
    await pi.turn('before-2');
    await waitForSessionEvents(pi, (events) => events.length === 2, 'two outcomes');

    const first = await page('catch-up-client', { limit: 1 });
    expect(first.events).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const baseline = first.baselineThroughCursor;
    expect(baseline).toBe(await headCursor());

    await pi.turn('during');
    const seen: any[] = [...first.events];
    let next = first;
    while (next.hasMore) {
      next = await page('catch-up-client', { after: next.cursor, limit: 1 });
      expect(next.reset).toBe(false);
      seen.push(...next.events);
    }
    expect(next.baselineThroughCursor).toBe(next.cursor);
    const cursors = seen.map((event) => event.cursor);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
    const during = seen.find((event) => event.turnId === 'during');
    expect(during.cursor).toBeGreaterThan(baseline);
    for (const event of seen.filter((item) => item.turnId?.startsWith('before-'))) {
      expect(event.cursor).toBeLessThanOrEqual(baseline);
    }

    // A client starting now is fully caught up by its first page.
    const fresh = await feed('fresh-client');
    expect(fresh.some((event) => event.turnId === 'during')).toBe(true);
  });

  test('a long poll waits for a change, and wakes for a new event and for another client reading it', async () => {
    const pi = await open('long-poll');
    const head = await headCursor();
    let returned = false;
    const waiting = owner.get(`/api/attention-events?clientId=poller&after=${head}&waitMs=20000`);
    void waiting.then(() => { returned = true; });
    await never(() => returned, 200, 'a long poll with nothing new returned');

    await pi.turn('wake');
    const woke = (await waiting).body;
    const raised = woke.events.find((event: any) => event.turnId === 'wake');
    expect(raised).toBeDefined();

    returned = false;
    const second = owner.get(`/api/attention-events?clientId=poller&after=${woke.cursor}&waitMs=20000`);
    void second.then(() => { returned = true; });
    await never(() => returned, 200, 'a long poll with nothing new returned');
    expect((await ack(raised.id, 'phone')).status).toBe(200);
    const read = (await second).body.events.find((event: any) => event.id === raised.id);
    expect(read.seenAt).toBeNumber();
    expect(read.readAt).toBeUndefined();

    // A poll with a short wait and nothing new answers empty.
    const quiet = await page('poller', { after: await headCursor(), waitMs: 50 });
    expect(quiet.events).toEqual([]);
  });

  test('read and dismissal belong to each client; the first read marks the event seen for every client, once', async () => {
    const pi = await open('per-client');
    await pi.turn('shared');
    const [created] = await waitForSessionEvents(pi, (events) => events.length === 1, 'the outcome');
    const tabletHead = (await page('tablet', { limit: 1 })).baselineThroughCursor;

    expect((await ack(created.id, 'phone')).status).toBe(200);
    const phone = byKey(await sessionEvents(pi, 'phone'), created.dedupeKey);
    expect(phone.readAt).toBeNumber();
    expect(phone.seenAt).toBeNumber();
    // Seeing is not a new revision, but it moves the event onto the tablet's next page.
    const tabletPage = await page('tablet', { after: tabletHead });
    const onTablet = tabletPage.events.find((event: any) => event.id === created.id);
    expect(onTablet).toMatchObject({ seenAt: phone.seenAt, revision: created.revision, presentationRevision: created.presentationRevision });
    expect(onTablet.readAt).toBeUndefined();

    const head = await headCursor();
    expect((await ack(created.id, 'tablet')).status).toBe(200);
    const after = byKey(await sessionEvents(pi, 'laptop'), created.dedupeKey);
    expect(after.seenAt).toBe(phone.seenAt);
    expect(after.cursor).toBe(onTablet.cursor);
    expect((await page('laptop', { after: head })).events.some((event: any) => event.id === created.id)).toBe(false);

    expect((await dismiss(created.id, 'phone')).status).toBe(200);
    expect(byKey(await sessionEvents(pi, 'phone'), created.dedupeKey).dismissedAt).toBeNumber();
    expect(byKey(await sessionEvents(pi, 'tablet'), created.dedupeKey).dismissedAt).toBeUndefined();
  });

  test('a dismissal marks an event seen; a reopened request is unseen and a revision-scoped dismissal no longer hides it', async () => {
    const pi = await open('reopen');
    const key = `permission-required:pi:${pi.id}:again`;
    await pi.emit({ t: 'permission-request', requestId: 'again', title: 'Edit file' });
    const [request] = await waitForSessionEvents(pi, (events) => byKey(events, key)?.state === 'active', 'the request');

    const batch = await dismissBatch('phone', [{ eventId: request.id, revision: request.revision }]);
    expect(batch.body.accepted.map((item: any) => item.eventId)).toEqual([request.id]);
    const dismissed = byKey(await sessionEvents(pi, 'phone'), key);
    expect(dismissed.dismissedAt).toBeNumber();
    expect(dismissed.seenAt).toBeNumber();

    await pi.emit({ t: 'permission-resolved', requestId: 'again', decision: 'deny' });
    const resolved = await waitForSessionEvents(pi, (events) => byKey(events, key)?.state === 'resolved', 'the resolution', 'phone');
    expect(byKey(resolved, key).seenAt).toBe(dismissed.seenAt);
    // The batch dismissed one revision; the resolution is a newer one, so the phone shows it again.
    expect(byKey(resolved, key).dismissedAt).toBeUndefined();

    await pi.emit({ t: 'permission-request', requestId: 'again', title: 'Edit file' });
    const reopened = await waitForSessionEvents(pi, (events) => byKey(events, key)?.state === 'active', 'the reopened request');
    expect(byKey(reopened, key).id).toBe(request.id);
    expect(byKey(reopened, key).seenAt).toBeUndefined();

    // A single dismissal hides the event for good, whatever revision comes later.
    expect((await dismiss(request.id, 'phone')).status).toBe(200);
    await pi.emit({ t: 'permission-resolved', requestId: 'again', decision: 'approve' });
    const final = await waitForSessionEvents(pi, (events) => byKey(events, key)?.state === 'resolved', 'the second resolution', 'phone');
    expect(byKey(final, key).dismissedAt).toBeNumber();
  });
});

// ── Clearing ───────────────────────────────────────────────────────────────

describe('clearing', () => {
  test('Clear all dismisses exactly the revisions the client listed and reports the rest', async () => {
    const pi = await open('clear-exact');
    const changedKey = `permission-required:pi:${pi.id}:changed`;
    await pi.turn('kept');
    await pi.emit({ t: 'permission-request', requestId: 'changed', title: 'Run tests' });
    const listed = await waitForSessionEvents(pi, (events) => events.length === 2, 'two events', 'phone');
    const outcome = listed.find((event) => event.kind === 'run-finished');
    const request = byKey(listed, changedKey);

    // The request changes after the client listed it.
    await pi.emit({ t: 'permission-resolved', requestId: 'changed', decision: 'approve' });
    await waitForSessionEvents(pi, (events) => byKey(events, changedKey)?.state === 'resolved', 'the change');

    const items = [
      { eventId: outcome.id, revision: outcome.revision },
      { eventId: request.id, revision: request.revision },
      { eventId: 'no-such-event', revision: 1 },
    ];
    const result = await dismissBatch('phone', items);
    expect(result.status).toBe(200);
    expect(result.body.accepted.map((item: any) => item.eventId)).toEqual([outcome.id]);
    expect(result.body.stale).toEqual([{ eventId: request.id, revision: request.revision, currentRevision: request.revision + 1 }]);
    expect(result.body.notFound).toEqual([{ eventId: 'no-such-event', revision: 1 }]);
    // Retrying the same request changes nothing and still succeeds.
    expect((await dismissBatch('phone', items.slice(0, 1))).body.accepted).toHaveLength(1);

    const phone = await sessionEvents(pi, 'phone');
    expect(phone.find((event) => event.id === outcome.id).dismissedAt).toBeNumber();
    expect(phone.find((event) => event.id === request.id).dismissedAt).toBeUndefined();
    expect((await sessionEvents(pi, 'tablet')).some((event) => event.dismissedAt !== undefined)).toBe(false);
  });

  test('a Clear all of two hundred events is accepted at once; an oversized, repeated or malformed one is refused', async () => {
    const pi = await open('clear-bulk');
    const count = 200;
    const events = Array.from({ length: count }, (_, index) => [
      { t: 'run', key: `bulk-${index}`, turnId: `bulk-${index}`, status: 'running' },
      { t: 'run', key: `bulk-${index}`, turnId: `bulk-${index}`, status: 'done' },
    ]).flat();
    await pi.emit(...events);
    const raised = await waitForSessionEvents(pi, (found) => found.length === count, 'every outcome');
    const cursors = raised.map((event) => event.cursor);
    expect(new Set(cursors).size).toBe(count);

    const items = raised.map((event) => ({ eventId: event.id, revision: event.revision }));
    const cleared = await dismissBatch('phone', items);
    expect(cleared.status).toBe(200);
    expect(cleared.body.accepted).toHaveLength(count);
    expect(cleared.body.stale).toEqual([]);
    expect(cleared.body.notFound).toEqual([]);
    expect((await sessionEvents(pi, 'phone')).every((event) => event.dismissedAt !== undefined)).toBe(true);

    const oversized = await dismissBatch('phone', Array.from(
      { length: ATTENTION_BULK_DISMISS_MAX + 1 },
      (_, index) => ({ eventId: `over-${index}`, revision: 1 }),
    ));
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('BAD_PARAM');
    expect((await dismissBatch('phone', [items[0], items[0]])).status).toBe(400);
    expect((await dismissBatch('bad id', items.slice(0, 1))).status).toBe(400);
    expect((await owner.get('/api/attention-events?clientId=bad%20id')).status).toBe(400);
    expect((await owner.get('/api/attention-events?clientId=phone&after=-1')).status).toBe(400);
    expect((await ack('no-such-event', 'phone')).status).toBe(404);
  });
});

// ── Time ───────────────────────────────────────────────────────────────────

describe('over time', () => {
  async function securityAlerts(): Promise<any[]> {
    return (await feed('e2e-observer')).filter((event) => event.kind === 'security-alert'
      && event.title === 'Repeated broker authentication failures');
  }

  /** Something later in the feed than any alert the failures so far could have raised. */
  async function sentinel(name: string): Promise<void> {
    const pi = await open(`sentinel-${name}`);
    await pi.turn('sentinel');
    await waitForSessionEvents(pi, (events) => events.length === 1, `sentinel ${name}`);
  }

  async function failures(count: number): Promise<void> {
    const anonymous = broker.client({ kind: 'none' });
    for (let attempt = 0; attempt < count; attempt += 1) {
      expect((await anonymous.get('/api/sessions')).status).toBe(401);
    }
  }

  test('repeated authentication failures alert once for a burst inside ten minutes, then stay quiet for an hour', async () => {
    await failures(4);
    clock.advance(11 * MINUTE);
    await failures(4);
    await sentinel('window');
    expect(await securityAlerts()).toEqual([]);

    await failures(1);
    const [first] = await eventually(async () => {
      const found = await securityAlerts();
      return found.length > 0 ? found : undefined;
    }, { what: 'the first alert' });
    expect(first).toMatchObject({ severity: 'action-required', notificationType: 'security_alert' });
    const wire = JSON.stringify(first);
    expect(wire).not.toContain('127.0.0.1');
    expect(wire).not.toContain(broker.paths.root);

    clock.advance(59 * MINUTE);
    await failures(20);
    await sentinel('cooldown');
    expect(await securityAlerts()).toHaveLength(1);

    // The cooldown is over, and failures during it count for nothing.
    clock.advance(2 * MINUTE);
    await failures(4);
    await sentinel('after-cooldown');
    expect(await securityAlerts()).toHaveLength(1);
    await failures(1);
    await eventually(async () => (await securityAlerts()).length === 2, { what: 'the second alert' });
  });

  test('events and what each client has done with them survive a restart; the store is owner-only and holds no derived fields', async () => {
    const before = await feed('phone');
    await broker.restart();
    const after = await feed('phone');
    const view = (events: any[]) => events.map((event) => [event.id, event.state, event.seenAt, event.readAt, event.dismissedAt]);
    expect(view(after)).toEqual(view(before));

    const path = join(broker.paths.cosyncingHome, 'attention-events.json');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('notificationType');
    expect(onDisk).not.toContain('collapseKey');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('resolved events leave the feed after thirty days, open requests stay, and a stale cursor is told to reset', async () => {
    const pi = await open('retention');
    const openKey = `permission-required:pi:${pi.id}:still-open`;
    await pi.turn('old');
    await pi.emit({ t: 'permission-request', requestId: 'still-open', title: 'Approve' });
    await waitForSessionEvents(pi, (events) => events.length === 2, 'the old outcome and the open request');
    const staleCursor = (await page('retention-client', { limit: 1 })).cursor;

    clock.advance(31 * DAY);
    const jumpedAt = clock.now();
    await pi.turn('new');
    const events = await waitForSessionEvents(
      pi,
      (found) => found.some((event) => event.turnId === 'new') && !found.some((event) => event.turnId === 'old'),
      'the old outcome gone and the new one listed',
    );
    expect(byKey(events, openKey)?.state).toBe('active');
    // Everything resolved before the jump is gone, from every session.
    for (const event of (await feed('e2e-observer')).filter((item) => item.state === 'resolved')) {
      expect(event.resolvedAt).toBeGreaterThanOrEqual(jumpedAt);
    }

    const reset = await page('retention-client', { after: staleCursor });
    expect(reset.reset).toBe(true);
  });
});
