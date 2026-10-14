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
  readonly requests: { mode: HostMode; path: string; answered: boolean; abandoned: boolean }[] = [];
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
    const path = new URL(req.url).pathname;
    const record = { mode: this.mode, path, answered: false, abandoned: false };
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
      env: {
        COSYNCING_MACHINE: 'roster-bounds-e2e',
        KILO_URL: kilo.url,
        COSYNCING_TEST_DISCOVERY_BUDGET_MS: String(BUDGET_MS),
        COSYNCING_ROSTER_COLD_PARTIAL_MS: '250',
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: String(HOUR),
        COSYNCING_CODEX_SYNC_SERVER: '0',
      },
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
    const window = '1m';
    const from = kilo.requests.length;
    const starter = rosterSnapshot(client, { window });
    // Kilo is being asked, so every agent before it has already answered.
    await eventually(() => kilo.requests.length > from, { what: 'the sweep to reach the wedged host' });

    const early = await rosterSnapshot(client, { window });
    expect(early.body.complete).toBe(false);
    expect(ids(early.body.sessions)).toContain(piId);
    expect(ids(early.body.sessions)).not.toContain(claudeId);

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
});
