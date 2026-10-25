/**
 * No single agent host can hold the roster.
 *
 * Kilo Code is an external-host adapter: it reads its own SQLite store and then
 * asks a `kilo serve` host over HTTP. Here that host is a fake the test
 * controls. It can be down (Kilo answers from its store), live (it lists a
 * session of its own), or wedged: it accepts every request and never answers,
 * which is the failure the discovery budget exists for. Nothing fails in that
 * state, so only the budget can end the wait.
 *
 * Discovery runs one agent at a time, in registration order: Pi before Kilo,
 * Claude after it. A Pi session therefore shows what had landed before Kilo
 * was reached, and a Claude session shows that the agents after a wedged host
 * were still read.
 *
 * COSYNCING_TEST_DISCOVERY_BUDGET_MS (a source-only test hook) caps the 15 s
 * external-host budget, so each abandonment costs two seconds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TestClock } from '../harness/fakes/test-clock.ts';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKiloDatabase } from '../../packages/typescript/adapters/kilocode/test/fixtures/database.ts';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { fileSessionId, RosterFeed, rosterSnapshot, writePiSession } from '../harness/roster.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUDGET_MS = 2_000;

type HostMode = 'down' | 'live' | 'wedged';

/** A fake `kilo serve`. Every request is recorded, with whether it was ever answered. */
class FakeKiloHost {
  mode: HostMode = 'down';
  readonly requests: { mode: HostMode; path: string; search: string; answered: boolean; abandoned: boolean }[] = [];
  readonly liveSession: Record<string, unknown>;
  readonly server: ReturnType<typeof Bun.serve>;

  constructor(liveSession: Record<string, unknown>) {
    this.liveSession = liveSession;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => this.answer(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  private async answer(req: Request): Promise<Response> {
    const { pathname: path, search } = new URL(req.url);
    const record = { mode: this.mode, path, search, answered: false, abandoned: false };
    this.requests.push(record);
    const reply = (response: Response): Response => {
      record.answered = true;
      return response;
    };
    if (this.mode === 'down') return reply(new Response('starting', { status: 503 }));
    if (path === '/global/health') return reply(Response.json({ healthy: true, version: '7.4.23' }));
    if (this.mode === 'live') {
      if (path === '/session') return reply(Response.json([this.liveSession]));
      return reply(Response.json({}));
    }
    // Wedged: hold the request until the caller gives up on it.
    await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
    record.abandoned = true;
    return new Response(null, { status: 499 });
  }

  /** Requests made since `from` that the host never answered. */
  unanswered(from: number): string[] {
    return this.requests.slice(from).filter((request) => !request.answered).map((request) => request.path);
  }

  stop(): void {
    this.server.stop(true);
  }
}

function addKiloSession(databasePath: string, id: string, title: string, updatedAt: number): void {
  const database = new Database(databasePath);
  try {
    database.query(`insert into session
      (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, null, null, 'code', ?, ?, null)`)
      .run(id, id, join(databasePath, '..', 'workspace'), title, updatedAt - 1_000, updatedAt);
  } finally {
    database.close();
  }
}

function deleteKiloSession(databasePath: string, id: string): void {
  const database = new Database(databasePath);
  try {
    database.query('delete from session where id = ?').run(id);
  } finally {
    database.close();
  }
}

const ids = (sessions: any[]): string[] => sessions.map((session) => session.id);
const kiloIds = (sessions: any[]): string[] => sessions.filter((row) => row.tool === 'kilo').map((row) => row.id).sort();

describe('roster discovery with a wedged external host', () => {
  let broker: Broker;
  let client: BrokerClient;
  let kilo: FakeKiloHost;
  let clock: TestClock;
  let kiloDatabase = '';
  let piId = '';
  let claudeId = '';

  beforeAll(async () => {
    kilo = new FakeKiloHost({
      id: 'ses_kilo_live',
      title: 'Kilo live only',
      // A live Kilo row carries its creation time and no update time.
      time: { created: Date.now() - 3 * DAY },
    });
    broker = await startBroker({
      name: 'roster-bounds',
      setup: (paths) => {
        clock = new TestClock(paths.root);
        piId = writePiSession(paths, 'before-kilo', HOUR).id;
        kiloDatabase = join(paths.root, 'kilo-data', 'kilo.db');
        createKiloDatabase(kiloDatabase, { id: 'ses_kilo_a', title: 'Kilo recent', updatedAt: Date.now() - HOUR });
        addKiloSession(kiloDatabase, 'ses_kilo_b', 'Kilo two days', Date.now() - 2 * DAY);
        const project = join(paths.root, 'claude', 'projects', 'after-kilo');
        mkdirSync(project, { recursive: true });
        const transcript = join(project, '0e0c1000-0000-4000-8000-0000000000aa.jsonl');
        writeFileSync(transcript, `${JSON.stringify({
          type: 'user', uuid: 'u1', sessionId: '0e0c1000-0000-4000-8000-0000000000aa', cwd: paths.home,
          timestamp: new Date().toISOString(), message: { role: 'user', content: 'after kilo' },
        })}\n`);
        claudeId = fileSessionId(transcript);
      },
      env: () => ({
        ...clock.env,
        COSYNCING_MACHINE: 'roster-bounds-e2e',
        KILO_URL: kilo.url,
        COSYNCING_TEST_DISCOVERY_BUDGET_MS: String(BUDGET_MS),
        COSYNCING_ROSTER_COLD_PARTIAL_MS: '250',
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: String(HOUR),
        COSYNCING_CODEX_SYNC_SERVER: '0',
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    await broker?.stop();
    kilo?.stop();
  });

  test('a healthy roster is whole, and a live row with only a creation date is placed by it', async () => {
    kilo.mode = 'live';
    // `refresh` waits for the whole sweep: a cold answer here would be an early one.
    const week = await rosterSnapshot(client, { window: '7d', refresh: true });
    expect(week.body.complete).toBe(true);
    expect(ids(week.body.sessions)).toEqual(expect.arrayContaining([piId, claudeId]));
    expect(kiloIds(week.body.sessions)).toEqual(['ses_kilo_a', 'ses_kilo_b', 'ses_kilo_live']);
    const live = week.body.sessions.find((row: any) => row.id === 'ses_kilo_live');
    expect([live.createdAt !== undefined, live.updatedAt]).toEqual([true, undefined]);

    const day = await rosterSnapshot(client, { window: '1d', refresh: true });
    expect(day.body.complete).toBe(true);
    expect(kiloIds(day.body.sessions)).toEqual(['ses_kilo_a']);
  });

  test('a host that never answers is abandoned at its budget; the roster answers, incomplete, carrying its last good sessions', async () => {
    kilo.mode = 'wedged';
    // Written after the last good read: a carry cannot know about it.
    addKiloSession(kiloDatabase, 'ses_kilo_new', 'Kilo since the last read', Date.now());
    const from = kilo.requests.length;
    const outputFrom = broker.output().length;

    const week = await rosterSnapshot(client, { window: '7d', refresh: true });
    expect(week.body.complete).toBe(false);
    expect(ids(week.body.sessions)).toEqual(expect.arrayContaining([piId, claudeId]));
    expect(kiloIds(week.body.sessions)).toEqual(['ses_kilo_a', 'ses_kilo_b', 'ses_kilo_live']);
    // The host was asked and never answered: only the budget ended the wait.
    expect(kilo.unanswered(from).length).toBeGreaterThan(0);
    // ...and the broker hung up rather than leaving the request open.
    await eventually(() => kilo.requests.slice(from).some((request) => request.abandoned), {
      what: 'the broker to cancel its request to the wedged host',
    });

    const log = await eventually(() => {
      const text = broker.output().slice(outputFrom);
      return /cannot speak for kilo/.test(text) ? text : undefined;
    }, { what: 'the operator log to name the unread backend' });
    expect(log).toContain(`kilo discovery exceeded its ${BUDGET_MS}ms budget`);
    expect(log).toMatch(/0 mapped this sweep and 3 carried from the last successful one, so the roster keeps 3 kilo session/);
  });

  test("a narrow window's memory is never carried into a wider sweep, and the machine roster says it is partial", async () => {
    const outputFrom = broker.output().length;
    const all = await rosterSnapshot(client, { refresh: true });
    expect(all.body.complete).toBe(false);
    expect(ids(all.body.sessions)).toEqual(expect.arrayContaining([piId, claudeId]));
    // Only a 7-day answer was ever read, and it cannot stand in for all time.
    expect(kiloIds(all.body.sessions)).toEqual([]);
    expect(broker.output().slice(outputFrom)).toContain('EVERY kilo session is absent from this roster sweep');

    const machines = await client.get('/api/machines');
    const local = machines.body.machines.find((machine: any) => machine.role === 'local');
    expect(local).toMatchObject({ status: 'degraded', code: 'MACHINE_PEER_PARTIAL' });
  });

  test('a cold client is answered from the agents that have landed, then corrected when the sweep settles', async () => {
    // Broader readings can now seed this view. Move beyond stale serving too,
    // so this scenario still exercises a genuinely cold, partial answer.
    clock.advance(60_001);
    const window = '1m';
    const from = kilo.requests.length;
    const starter = rosterSnapshot(client, { window });
    // Kilo is being asked, so every agent before it has already answered.
    await eventually(() => kilo.requests.length > from, { what: 'the sweep to reach the wedged host' });

    const early = await rosterSnapshot(client, { window });
    expect(early.body.complete).toBe(false);
    expect(ids(early.body.sessions)).toContain(piId);
    expect(ids(early.body.sessions)).not.toContain(claudeId);
    const narrow = await rosterSnapshot(client, { window: '2d' });
    expect(narrow.body.complete).toBe(false);
    expect(ids(narrow.body.sessions)).toContain(piId);
    const broader = await rosterSnapshot(client, { window: '2m' });
    expect(broader.body.complete).toBe(false);
    expect(ids(broader.body.sessions)).toContain(piId);
    expect(kilo.requests.slice(from).filter((r) =>
      r.path === '/session' && r.search === '' && !r.answered && !r.abandoned,
    ).length).toBeLessThanOrEqual(1);

    // A client from before roster completeness cannot read `complete`, so it is
    // never handed a sweep in progress: it waits for the settled one.
    const older = await client.get(`/api/sessions?window=${window}`);
    expect(ids(older.body.sessions)).toEqual(expect.arrayContaining([piId, claudeId]));
    await starter;

    // The early answer corrects itself for a client polling with its ETag.
    const etag = early.headers.get('etag') ?? '';
    const corrected = await eventually(async () => {
      const poll = await rosterSnapshot(client, { window, headers: { 'if-none-match': etag } });
      return poll.status === 200 && ids(poll.body.sessions).includes(claudeId) ? poll.body : undefined;
    }, { what: 'the early answer to be corrected' });
    expect(corrected.revision).toBeGreaterThan(early.body.revision);
    expect(corrected.complete).toBe(false);
    const narrowCorrection = await eventually(async () => {
      const poll = await rosterSnapshot(client, {
        window: '2d', headers: { 'if-none-match': narrow.headers.get('etag')! },
      });
      return poll.status === 200 && ids(poll.body.sessions).includes(claudeId) ? poll.body : undefined;
    }, { what: 'the narrower early answer to receive its own correction' });
    expect(narrowCorrection.revision).toBeGreaterThan(narrow.body.revision);
    await eventually(async () => {
      const poll = await rosterSnapshot(client, {
        window: '2m', headers: { 'if-none-match': broader.headers.get('etag')! },
      });
      return poll.status === 200 && ids(poll.body.sessions).includes(claudeId);
    }, { what: 'the serialized wider reading to correct its partial answer' });
  });

  test('a carry lasts five sweeps; its end retracts nothing, and the next good read removes what is really gone', async () => {
    const feed = new RosterFeed(client, '7d');
    await feed.start();
    // The first carried sweep was the abandonment above.
    let carried = 1;
    for (;;) {
      const week = await rosterSnapshot(client, { window: '7d', refresh: true });
      expect(week.body.complete).toBe(false);
      if (kiloIds(week.body.sessions).length === 0) break;
      carried += 1;
      expect(carried).toBeLessThanOrEqual(5);
    }
    expect(carried).toBe(5);

    // A later change on the same feed shows it has moved past those sweeps.
    const hello = await client.post('/pi/bridge/hello', {
      sessionFile: join(broker.paths.root, 'live-sentinel.jsonl'), cwd: broker.paths.home, title: 'sentinel',
    });
    await client.post('/pi/bridge/events', { id: hello.body.id, events: [{ t: 'status', running: true }] });
    await feed.waitFor((delta) => delta.sessionId === hello.body.id);
    // Kilo could not be read, so its absence is not evidence of deletion.
    expect(feed.seen.filter((delta) => delta.tool === 'kilo' && delta.removed)).toEqual([]);

    kilo.mode = 'down';
    deleteKiloSession(kiloDatabase, 'ses_kilo_b');
    const from = feed.seen.length;
    const week = await rosterSnapshot(client, { window: '7d', refresh: true });
    expect(week.body.complete).toBe(true);
    expect(kiloIds(week.body.sessions)).toEqual(['ses_kilo_a', 'ses_kilo_new']);
    const removed = await feed.waitFor((delta) => delta.sessionId === 'ses_kilo_b' && delta.removed === true, { from });
    expect(removed.session).toBeUndefined();
    expect(feed.of('ses_kilo_live', from).map((delta) => delta.removed)).toEqual([true]);
  });

  test('settled rows answer older and wider clients while a sweep revalidates them', async () => {
    kilo.mode = 'wedged';
    const archive = writePiSession(broker.paths, 'archive-before-kilo', 10 * DAY).id;
    const all = await rosterSnapshot(client, { refresh: true });
    expect(ids(all.body.sessions)).toContain(archive);

    // Past the TTL, inside the stale-serving bound. A client from before roster
    // completeness takes the settled rows at once rather than waiting out the
    // revalidating sweep, which cannot settle before the wedged host's budget.
    clock.advance(20_000);
    let from = kilo.requests.length;
    const older = await client.get('/api/sessions');
    expect(ids(older.body.sessions)).toContain(archive);
    expect(kilo.requests.slice(from).some((request) => request.abandoned)).toBe(false);
    // A forced read joins that sweep, so the next step starts from its settled rows.
    expect(ids((await rosterSnapshot(client, { refresh: true })).body.sessions)).toContain(archive);

    // A wider client keeps its own settled rows while a narrower sweep runs,
    // instead of that sweep's partial answer, which cannot hold the archive.
    clock.advance(20_000);
    from = kilo.requests.length;
    const week = rosterSnapshot(client, { window: '7d', refresh: true });
    await eventually(() => kilo.requests.slice(from).some((request) => request.path === '/session' && !request.answered), {
      what: 'the seven-day sweep to reach the wedged host',
    });
    const wider = await rosterSnapshot(client);
    expect(ids(wider.body.sessions)).toContain(archive);
    expect((await week).body.complete).toBe(false);
  });
});


describe('deliberate roster freshness without an attached session', () => {
  let broker: Broker;
  let kilo: FakeKiloHost;
  let clock: TestClock;
  let database: string;
  let allAfter: number;
  const rename = (id: string, title: string) => {
    const db = new Database(database);
    try { db.query('update session set title = ? where id = ?').run(title, id); }
    finally { db.close(); }
  };
  // One unscoped list per discovery; per-directory fan-out is separate work.
  const reads = () => kilo.requests.filter((r) => r.path === '/session' && r.search === '').length;
  const pending = (window: string, after: number, signal: AbortSignal) => fetch(
    `${broker.url}/api/session-roster-deltas?window=${window}&after=${after}&waitMs=25000`, { signal },
  ).then((response) => response.json());
  const statusChange = (batch: any, status: string) => batch.deltas.some(
    (delta: any) => delta.sessionId === 'ses_unwatched' && delta.session?.status === status,
  );
  beforeAll(async () => {
    kilo = new FakeKiloHost({
      id: 'ses_unwatched', title: 'Old active terminal', status: 'busy',
      time: { created: Date.now() - 30 * DAY },
    });
    kilo.mode = 'live';
    broker = await startBroker({
      name: 'roster-cadence',
      setup: (paths) => {
        clock = new TestClock(paths.root);
        database = join(paths.root, 'kilo-data', 'kilo.db');
        createKiloDatabase(database, { id: 'ses_archive', title: 'Old archive', updatedAt: Date.now() - 30 * DAY });
        addKiloSession(database, 'ses_midweek', 'Three-day archive', Date.now() - 3 * DAY);
      },
      env: () => ({
        ...clock.env, KILO_URL: kilo.url, COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_ROSTER_COLD_PARTIAL_MS: '120000',
      }),
    });
  });
  afterAll(async () => { await broker?.stop(); kilo?.stop(); });

  test('7d and all share one bounded cadence, preserve archives, and stop on cancellation', async () => {
    const client = broker.client();
    const week = await rosterSnapshot(client, { window: '7d', refresh: true });
    const afterWeek = reads();
    const [day, twoDays] = await Promise.all([
      rosterSnapshot(client, { window: '1d' }),
      rosterSnapshot(client, { window: '2d' }),
    ]);
    expect(reads()).toBe(afterWeek);
    for (const snapshot of [day, twoDays]) {
      expect(ids(snapshot.body.sessions)).toContain('ses_unwatched');
      expect(ids(snapshot.body.sessions)).not.toContain('ses_midweek');
    }
    const all = await rosterSnapshot(client, { refresh: true });
    for (const snapshot of [week, all]) {
      expect(snapshot.body.sessions.find((row: any) => row.id === 'ses_unwatched')?.status).toBe('working');
    }
    expect(ids(all.body.sessions)).toContain('ses_archive');
    expect(ids(week.body.sessions)).not.toContain('ses_archive');
    const initial = reads();
    const abort = new AbortController();
    const weekPoll = pending('7d', week.body.revision, abort.signal);
    const allPoll = pending('all', all.body.revision, abort.signal);
    await client.get('/api/health');
    // Renaming without changing activity timestamps reveals which native rows
    // discovery read. A seven-day sweep sees midweek, but not the old archive.
    rename('ses_archive', 'Only a full read should see this');
    rename('ses_midweek', 'Bounded reading sees this');
    kilo.liveSession.status = 'idle';
    kilo.liveSession.time = { created: Date.now() - 30 * DAY, updated: clock.now() };
    clock.advance(15_001);
    const [weekChange, allChange] = await Promise.all([weekPoll, allPoll]);
    expect(statusChange(weekChange, 'idle')).toBe(true);
    expect(statusChange(allChange, 'idle')).toBe(true);
    for (const batch of [weekChange, allChange]) {
      expect(batch.deltas.some((d: any) => d.session?.title === 'Bounded reading sees this')).toBe(true);
      expect(batch.deltas.some((d: any) => d.sessionId === 'ses_archive')).toBe(false);
    }
    expect(allChange.deltas.some((d: any) => d.removed)).toBe(false);
    expect(reads() - initial).toBe(1);
    allAfter = allChange.revision;

    let settled = 0;
    const waitingWeek = pending('7d', weekChange.revision, abort.signal).then(() => { settled++; }, () => {});
    const waitingAll = pending('all', allAfter, abort.signal).then(() => { settled++; }, () => {});
    await client.get('/api/health');
    clock.advance(60_000);
    await eventually(() => reads() === initial + 2, { what: 'one due cadence sweep without catch-up scans' });
    expect(settled).toBe(0);
    abort.abort();
    await Promise.all([waitingWeek, waitingAll]);
    await client.get('/api/health');
    clock.advance(60_000);
    await client.get('/api/health');
    expect(reads()).toBe(initial + 2);
  });

  test('all and a one-day poller share seven-day discovery without hiding wider updates', async () => {
    const client = broker.client();
    const abort = new AbortController();
    let initial = reads();
    // Reconnection may immediately start an already-due cadence sweep.
    rename('ses_midweek', 'All-only bounded update');
    kilo.liveSession.status = 'busy';
    const allPoll = pending('all', allAfter, abort.signal);
    await client.get('/api/health');
    clock.advance(15_001);
    const allChange = await allPoll;
    expect(statusChange(allChange, 'working')).toBe(true);
    expect(allChange.deltas.some((d: any) => d.session?.title === 'All-only bounded update')).toBe(true);
    expect(allChange.deltas.some((d: any) => d.sessionId === 'ses_archive' || d.removed)).toBe(false);
    expect(reads() - initial).toBe(1);
    allAfter = allChange.revision;

    const day = await rosterSnapshot(client, { window: '1d', refresh: true });
    initial = reads();
    const dayPoll = pending('1d', day.body.revision, abort.signal);
    const widerPoll = pending('all', allAfter, abort.signal);
    await client.get('/api/health');
    rename('ses_midweek', 'Only wider reconciliation sees this');
    kilo.liveSession.status = 'idle';
    kilo.liveSession.time = { created: Date.now() - 30 * DAY, updated: clock.now() };
    clock.advance(15_001);
    const [dayChange, widerChange] = await Promise.all([dayPoll, widerPoll]);
    expect(statusChange(dayChange, 'idle')).toBe(true);
    expect(statusChange(widerChange, 'idle')).toBe(true);
    expect(widerChange.deltas.some((d: any) => d.session?.title === 'Only wider reconciliation sees this')).toBe(true);
    expect(widerChange.deltas.some((d: any) => d.sessionId === 'ses_archive' || d.removed)).toBe(false);
    expect(dayChange.deltas.some((d: any) => d.sessionId === 'ses_midweek')).toBe(false);
    expect(reads() - initial).toBe(1);
    allAfter = widerChange.revision;
    abort.abort();
  });

  test('all-only safety reconciliation retains full removal authority after five minutes', async () => {
    deleteKiloSession(database, 'ses_archive');
    clock.advance(5 * 60_000 + 1);
    const feed = new RosterFeed(broker.client());
    feed.cursor = allAfter;
    await feed.waitFor((delta) => delta.sessionId === 'ses_archive' && delta.removed === true);
    const snapshot = await rosterSnapshot(broker.client());
    expect(snapshot.body.sessions.some((s: any) => s.title === 'Only wider reconciliation sees this')).toBe(true);
  });
});
