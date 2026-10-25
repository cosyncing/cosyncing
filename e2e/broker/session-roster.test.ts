/**
 * The session roster as the app reads it: `/api/sessions` snapshots with an
 * ETag, recency windows, and the delta feed it follows between snapshots.
 *
 * Sessions come from real agent stores in the fixture HOME (Pi session files,
 * Claude transcripts and Claude's own session registry) and from live owners
 * (the Pi bridge and the Claude hooks). A fake `claude` answers
 * `claude agents --json`, which is how the Claude adapter learns whether a
 * terminal is busy or waiting.
 *
 * The periodic safety reconcile is pushed to an hour, so whatever a client
 * sees here was put there by a sweep it caused, a live owner, or the
 * transcript watcher, never by the safety net.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { type Broker, type BrokerClient, eventually, SOON_MS, startBroker } from '../harness/index.ts';
import { installFakeCommand, type FakeCommand } from '../harness/fakes/command.ts';
import { type FakeClaudeAgents, installFakeClaudeAgents } from '../harness/fakes/claude-agents.ts';
import {
  age,
  fileSessionId,
  RosterFeed,
  type RosterDelta,
  rosterQuery,
  rosterSnapshot,
  writePiSession,
} from '../harness/roster.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROSTER_TTL_MS = 1_500;
// Match the production sweep bound explicitly. A polling client must allow
// the sweep it started to finish, rather than impose the generic 20s UI wait.
const ROSTER_SWEEP_BUDGET_MS = 45_000;

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const ids = (sessions: any[]): string[] => sessions.map((session) => session.id);

// ── Claude fixtures ─────────────────────────────────────────────────────────

/** A watched Claude session: no live owner until the hooks say hello. */
const WATCHED_UUID = '0e0c1000-0000-4000-8000-000000000001';
/** A terminal waiting on a permission prompt for a month. */
const WAITING_UUID = '0e0c1000-0000-4000-8000-000000000002';
/** One logical Claude session that a native restart replaced. */
const OLD_INCARNATION = '11111111-1111-4111-8111-111111111111';
const NEW_INCARNATION = '22222222-2222-4222-8222-222222222222';
const BRIDGE_SUFFIX = '0123456789abcdefghijklmn';

function claudeUser(uuid: string, n: number, cwd: string, at = new Date()): string {
  return line({
    type: 'user', uuid: `${uuid}-u${n}`, sessionId: uuid, cwd, timestamp: at.toISOString(),
    message: { role: 'user', content: `prompt ${n}` },
  });
}

function claudeEndTurn(uuid: string, n: number, at = new Date()): string {
  return line({
    type: 'assistant', uuid: `${uuid}-a${n}`, sessionId: uuid, timestamp: at.toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], stop_reason: 'end_turn' },
  });
}

/** The real replacement shape: the transcript names the bridge `cse_…`, the live registry `session_…`. */
function writeClaudeReplacement(claudeDir: string): { registries: string[] } {
  const project = join(claudeDir, 'projects', '-fixture-workspace');
  const registry = join(claudeDir, 'sessions');
  mkdirSync(project, { recursive: true });
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(project, `${OLD_INCARNATION}.jsonl`), [
    line({ type: 'custom-title', customTitle: 'Claude replacement fixture', sessionId: OLD_INCARNATION }),
    line({ type: 'user', uuid: 'old-user', sessionId: OLD_INCARNATION, cwd: '/fixture/workspace', timestamp: '2026-08-03T10:00:00.000Z', message: { role: 'user', content: 'fixture' } }),
    line({ type: 'assistant', uuid: 'old-tool', sessionId: OLD_INCARNATION, timestamp: '2026-08-03T10:00:01.000Z', message: { id: 'old-assistant', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-old', name: 'Bash', input: { command: 'true' } }] } }),
    line({ type: 'bridge-session', bridgeSessionId: `cse_${BRIDGE_SUFFIX}`, sessionId: OLD_INCARNATION, lastSequenceNum: 1594 }),
  ].join(''));
  writeFileSync(join(project, `${NEW_INCARNATION}.jsonl`), [
    line({ type: 'custom-title', customTitle: 'Claude replacement fixture', sessionId: NEW_INCARNATION }),
    line({ type: 'user', uuid: 'new-user', sessionId: NEW_INCARNATION, cwd: '/fixture/workspace', timestamp: '2026-08-03T11:00:00.000Z', message: { role: 'user', content: 'fixture' } }),
    line({ type: 'assistant', uuid: 'new-done', sessionId: NEW_INCARNATION, timestamp: '2026-08-03T11:00:01.000Z', message: { id: 'new-assistant', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
  ].join(''));
  // Both processes are dead (pids nobody holds); the generation is `startedAt`.
  const registries = [join(registry, 'old-dead.json'), join(registry, 'replacement-dead.json')];
  writeFileSync(registries[0]!, JSON.stringify({
    sessionId: OLD_INCARNATION, bridgeSessionId: `session_${BRIDGE_SUFFIX}`, pid: 2_147_483_646,
    kind: 'bg', entrypoint: 'cli', cwd: '/fixture/workspace', startedAt: 1,
  }));
  writeFileSync(registries[1]!, JSON.stringify({
    sessionId: NEW_INCARNATION, bridgeSessionId: `session_${BRIDGE_SUFFIX}`, pid: 2_147_483_647,
    kind: 'bg', entrypoint: 'cli', cwd: '/fixture/workspace', startedAt: 2,
  }));
  // Two pairs the broker cannot order: equal generations, and one generation missing.
  const ambiguous = (title: string, suffix: string, uuids: [string, string], generations: [number | undefined, number | undefined]): void => {
    for (const [index, uuid] of uuids.entries()) {
      writeFileSync(join(project, `${uuid}.jsonl`), [
        line({ type: 'custom-title', customTitle: title, sessionId: uuid }),
        line({ type: 'user', uuid: `${uuid}-user`, sessionId: uuid, cwd: '/fixture/workspace', message: { role: 'user', content: 'fixture' } }),
        line({ type: 'bridge-session', bridgeSessionId: `cse_${suffix}`, sessionId: uuid }),
      ].join(''));
      writeFileSync(join(registry, `${suffix}-${index}.json`), JSON.stringify({
        sessionId: uuid, bridgeSessionId: `session_${suffix}`, pid: 2_147_483_640 + index,
        ...(generations[index] === undefined ? {} : { startedAt: generations[index] }),
      }));
    }
  };
  ambiguous('Claude tied generation fixture', 'tiedgeneration',
    ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'], [3, 3]);
  ambiguous('Claude missing generation fixture', 'missinggeneration',
    ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'], [4, undefined]);
  return { registries };
}

function expectOneReplacementRow(sessions: any[]): void {
  const rows = sessions.filter((row) => row.title === 'Claude replacement fixture');
  expect(rows.map((row) => ({ nativeId: row.nativeId, status: row.status }))).toEqual([
    { nativeId: `claude-bridge:${BRIDGE_SUFFIX}`, status: 'idle' },
  ]);
  expect(Buffer.from(rows[0].id, 'base64url').toString('utf8').endsWith(`${NEW_INCARNATION}.jsonl`)).toBe(true);
}

// ── the suite ───────────────────────────────────────────────────────────────

describe('the session roster', () => {
  let broker: Broker;
  let client: BrokerClient;
  let claude: FakeClaudeAgents;
  let claudeDir: string;
  let replacementRegistries: string[] = [];
  const pi: Record<string, { path: string; id: string }> = {};
  let hostPi: FakeCommand | undefined;
  let watchedPath = '';
  let waitingPath = '';

  beforeAll(async () => {
    const originalPath = process.env.PATH;
    broker = await startBroker({
      name: 'roster',
      setup: (paths) => {
        // A harmless host-only tool shadows any real Pi installation. The
        // broker must use only its fixture PATH, including after restarts.
        const hostBin = join(paths.root, 'host-tools');
        mkdirSync(hostBin, { recursive: true });
        hostPi = installFakeCommand(hostBin, 'pi', 'process.exit(2);');
        process.env.PATH = [hostBin, originalPath ?? ''].join(delimiter);
        pi.recent = writePiSession(paths, 'recent', 2 * HOUR);
        pi.days3 = writePiSession(paths, 'days3', 3 * DAY);
        pi.days20 = writePiSession(paths, 'days20', 20 * DAY);
        pi.days100 = writePiSession(paths, 'days100', 100 * DAY);
        pi.doomed = writePiSession(paths, 'doomed', 3 * DAY);

        claudeDir = join(paths.root, 'claude');
        replacementRegistries = writeClaudeReplacement(claudeDir).registries;

        const watched = join(claudeDir, 'projects', 'watched');
        mkdirSync(watched, { recursive: true });
        watchedPath = join(watched, `${WATCHED_UUID}.jsonl`);
        writeFileSync(watchedPath, claudeUser(WATCHED_UUID, 1, paths.home) + claudeEndTurn(WATCHED_UUID, 1));

        // Recent filesystem mtimes with old conversation/child timestamps are
        // precisely the rows that used to leave the 7d expiry in the past.
        const oldAt = new Date(Date.now() - 8 * DAY);
        const oldUuid = '0e0c1000-0000-4000-8000-000000000003';
        writeFileSync(join(watched, `${oldUuid}.jsonl`), claudeUser(oldUuid, 1, paths.home, oldAt) + claudeEndTurn(oldUuid, 1, oldAt));
        const children = join(watched, WATCHED_UUID, 'subagents');
        mkdirSync(children, { recursive: true });
        writeFileSync(join(children, 'agent-old.meta.json'), line({ toolUseId: 'old-child-tool' }));
        writeFileSync(join(children, 'agent-old.jsonl'), claudeUser('agent-old', 1, paths.home, oldAt) + claudeEndTurn('agent-old', 1, oldAt));

        const waiting = join(claudeDir, 'projects', 'waiting');
        mkdirSync(waiting, { recursive: true });
        waitingPath = join(waiting, `${WAITING_UUID}.jsonl`);
        writeFileSync(waitingPath, claudeUser(WAITING_UUID, 1, paths.home, new Date(Date.now() - 30 * DAY)));
        age(waitingPath, 30 * DAY);

        claude = installFakeClaudeAgents(paths.bin, [
          { sessionId: WATCHED_UUID, status: 'busy' },
          { sessionId: WAITING_UUID, status: 'waiting' },
        ]);
      },
      env: () => ({
        COSYNCING_MACHINE: 'roster-e2e',
        COSYNCING_CLAUDE_BIN: claude.path,
        // The Claude hooks routes exist only in a development run.
        COSYNCING_DEV_MODE: '1',
        COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: String(HOUR),
        COSYNCING_ROSTER_TTL_MS: String(ROSTER_TTL_MS),
        COSYNCING_ROSTER_SWEEP_BUDGET_MS: String(ROSTER_SWEEP_BUDGET_MS),
        // Process/listener queries must fit their normal probe budget even on
        // a fresh Windows profile, without a previously discovered module cache.
        ...(process.platform === 'win32' ? { PSModuleAnalysisCachePath: 'NUL' } : {}),
        // A cold caller waits for its whole sweep: no early answers here (the
        // discovery-bounds suite owns those), so every correction below is one
        // this file caused on purpose.
        COSYNCING_ROSTER_COLD_PARTIAL_MS: '120000',
        // The smallest journal the broker allows, so a client can fall behind it.
        COSYNCING_ROSTER_DELTA_JOURNAL: '32',
        // Exercise real window eviction with small fixtures on every platform.
        COSYNCING_TEST_ROSTER_WINDOW_LIMIT: '3',
      }),
    }).finally(() => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    });
    client = broker.client();
  });
  afterAll(async () => {
    try { if (hostPi) expect(hostPi.calls()).toEqual([]); }
    finally { await broker?.stop(); }
  });

  test('an unchanged roster answers its ETag with 304, is gzipped only when accepted, and says it is whole', async () => {
    const url = `${broker.url}/api/sessions?${rosterQuery()}`;
    const plain = await fetch(url, { headers: { 'accept-encoding': 'identity' }, decompress: false } as RequestInit);
    const text = await plain.text();
    const body = JSON.parse(text);
    expect(plain.status).toBe(200);
    expect(body.complete).toBe(true);
    expect(ids(body.sessions)).toContain(pi.recent!.id);
    const etag = plain.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/".+"$/);
    expect(plain.headers.get('cache-control')).toBe('no-cache');
    expect(plain.headers.get('vary')).toBe('accept-encoding');
    expect(plain.headers.get('content-encoding')).toBeNull();
    // Large enough to be worth compressing; the broker gzips from 1 KiB.
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024);

    const again = await client.get(`/api/sessions?${rosterQuery()}`);
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.text).toBe(text);

    for (const ifNoneMatch of [etag, '*', `W/"not-this-one", ${etag}`]) {
      const notModified = await client.get(`/api/sessions?${rosterQuery()}`, { 'if-none-match': ifNoneMatch });
      expect(notModified.status).toBe(304);
      expect(notModified.text).toBe('');
      expect(notModified.headers.get('etag')).toBe(etag);
    }
    expect((await client.get(`/api/sessions?${rosterQuery()}`, { 'if-none-match': 'W/"stale"' })).status).toBe(200);

    const gzipped = await fetch(url, { headers: { 'accept-encoding': 'gzip' }, decompress: false } as RequestInit);
    expect(gzipped.headers.get('content-encoding')).toBe('gzip');
    const unzipped = Buffer.from(Bun.gunzipSync(new Uint8Array(await gzipped.arrayBuffer()))).toString('utf8');
    expect(JSON.parse(unzipped).sessions).toEqual(body.sessions);

    const refused = await fetch(url, { headers: { 'accept-encoding': 'gzip;q=0' }, decompress: false } as RequestInit);
    expect(refused.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(await refused.text()).sessions).toEqual(body.sessions);
  });

  test('JSON feed and capability responses negotiate gzip without changing identity or error semantics', async () => {
    for (const path of [
      `/api/agents?${rosterQuery()}`,
      `/api/session-roster-deltas?${rosterQuery({ after: '0' })}`,
    ]) {
      const get = (encoding: string) => fetch(broker.url + path, {
        headers: { 'accept-encoding': encoding }, decompress: false,
      } as RequestInit);
      const plain = await get('identity');
      const body = await plain.text();
      expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(1024);
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(plain.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
      for (const encoding of ['gzip;q=0', 'gzip;q=0, *;q=1']) {
        const refused = await get(encoding);
        expect(refused.headers.get('content-encoding')).toBeNull();
        expect(JSON.parse(await refused.text())).toEqual(JSON.parse(body));
      }
      const compressed = await Promise.all([get('gzip'), get('gzip'), get('*;q=0.5')]);
      for (const response of compressed) {
        expect(response.headers.get('content-encoding')).toBe('gzip');
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.length).toBeLessThan(Buffer.byteLength(body));
        expect(JSON.parse(Buffer.from(Bun.gunzipSync(bytes)).toString())).toEqual(JSON.parse(body));
        console.log(JSON.stringify({ probe: 'json-compression', path, identityBytes: Buffer.byteLength(body), gzipBytes: bytes.length }));
      }
    }
    const small = await client.get('/api/schedules', { 'accept-encoding': 'gzip' });
    expect(small.status).toBe(200);
    expect(small.headers.get('content-encoding')).toBeNull();
    expect(small.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    const invalid = await client.get('/api/session-roster-deltas?after=bad', { 'accept-encoding': 'gzip' });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-encoding')).toBeNull();
  });

  test('each window lists what was active in it; a waiting terminal is never hidden; an undated row lives only in all time', async () => {
    // A live session whose transcript does not exist yet: the broker has no date for it.
    const undatedPath = join(claudeDir, 'projects', 'watched', '0e0c1000-0000-4000-8000-0000000000ff.jsonl');
    const hello = await client.post('/claude/hook/hello', { transcriptPath: undatedPath, cwd: broker.paths.home, title: 'undated live' });
    expect(hello.body).toMatchObject({ ok: true, id: fileSessionId(undatedPath) });
    const waitingId = fileSessionId(waitingPath);

    const windows: Record<string, any[]> = {};
    for (const window of ['1d', '7d', '1m', 'all']) {
      const response = await rosterSnapshot(client, { window: window === 'all' ? undefined : window });
      expect(response.status).toBe(200);
      windows[window] = response.body.sessions;
    }
    const listed = (window: string, id: string): boolean => ids(windows[window]!).includes(id);

    expect([listed('1d', pi.recent!.id), listed('1d', pi.days3!.id)]).toEqual([true, false]);
    expect([listed('7d', pi.days3!.id), listed('7d', pi.days20!.id)]).toEqual([true, false]);
    expect([listed('1m', pi.days20!.id), listed('1m', pi.days100!.id)]).toEqual([true, false]);
    expect(listed('all', pi.days100!.id)).toBe(true);

    // A terminal that has waited on a permission prompt for a month is still
    // in the narrowest window, with its real (old) date.
    const waiting = windows['1d']!.find((row) => row.id === waitingId);
    expect(waiting?.status).toBe('needs-input');
    expect(waiting.updatedAt).toBeLessThan(Date.now() - 7 * DAY);

    // No bounded view can place an undated idle row, so only all-time lists it.
    for (const window of ['1d', '7d', '1m']) expect(listed(window, hello.body.id)).toBe(false);
    const undated = windows.all!.find((row) => row.id === hello.body.id);
    expect(undated).toMatchObject({ status: 'idle', title: 'undated live' });
    expect(undated.updatedAt).toBeUndefined();
    expect(undated.createdAt).toBeUndefined();
  });

  test('a session that appears on disk reaches a polling client after a reconnect, as a moved revision', async () => {
    // A window nothing else in this file reads, so no other request can sweep it.
    const window = '6m';
    const first = await rosterSnapshot(client, { window });
    const firstAt = Date.now();
    expect(ids(first.body.sessions)).toContain(pi.recent!.id);

    // A terminal-started session: on disk, no live owner to announce it, and
    // Pi has no watcher.
    const appears = writePiSession(broker.paths, 'appears');
    // The cached roster must be past its TTL for a reconnect to revalidate it.
    await eventually(() => Date.now() - firstAt > ROSTER_TTL_MS, { what: 'the roster TTL to pass' });

    const stale = await rosterSnapshot(client, { window });
    expect(stale.status).toBe(200);
    expect(ids(stale.body.sessions)).not.toContain(appears.id);
    const staleEtag = stale.headers.get('etag') ?? '';

    // From here the client polls with its ETag, as the app does. The sweep the
    // reconnect started must reach it; a 304 never reaches discovery itself.
    const corrected = await eventually(async () => {
      const poll = await rosterSnapshot(client, { window, headers: { 'if-none-match': staleEtag } });
      return poll.status === 200 && ids(poll.body.sessions).includes(appears.id) ? poll.body : undefined;
    }, { timeoutMs: ROSTER_SWEEP_BUDGET_MS, what: 'the roster to correct itself to include the new session' });
    expect(corrected.revision).toBeGreaterThan(stale.body.revision);
    expect(ids(corrected.sessions)).toContain(pi.recent!.id);
    expect([stale.body.complete, corrected.complete]).toEqual([true, true]);
  });

  test('bridge registration, live completion and project order reach the roster as transcript-free deltas', async () => {
    const feed = new RosterFeed(client);
    await feed.start();
    const open = async (name: string): Promise<string> => {
      const hello = await client.post('/pi/bridge/hello', {
        sessionFile: join(broker.paths.root, `live-${name}.jsonl`), cwd: broker.paths.home, title: `live ${name}`,
      });
      expect(hello.status).toBe(200);
      // Admission must happen before any native frame: a quiet, newly bridged
      // session is already discoverable by a client following this feed.
      await feed.waitFor((delta) => delta.sessionId === hello.body.id);
      await client.post('/pi/bridge/events', {
        id: hello.body.id, events: [{ t: 'status', running: true }, { t: 'status', running: false }],
      });
      return String(hello.body.id);
    };
    const first = await open('first');
    const second = await open('second');
    // Settle the hellos' own deltas, so the next poll can only be answered by what follows.
    await feed.waitFor((delta) => delta.sessionId === second && delta.session?.status === 'idle');
    const completedAt = Math.max(...feed.seen.map((delta) => delta.session?.updatedAt ?? 0)) + 1_000;
    const woken = feed.request(feed.cursor, 20_000);
    const marker = `transcript-text-${crypto.randomUUID()}`;
    await client.post('/pi/bridge/events', {
      id: first,
      events: [
        { t: 'status', running: true },
        { t: 'user', key: 'pi:user:1', text: `${marker} prompt` },
        { t: 'delta', key: 'pi:answer:1', delta: marker },
        { t: 'final', key: 'pi:answer:1', text: `${marker} final` },
        { t: 'token', input: 120, output: 40, cost: 0.01 },
        { t: 'run-summary', key: 'pi:run:1', turnId: 'turn-1', status: 'done', startedAt: completedAt - 3_000, completedAt },
        { t: 'status', running: false },
      ],
    });
    // The long poll was already waiting; the change is what answers it.
    const batch = await woken;
    expect(batch.deltas.length).toBeGreaterThan(0);
    feed.cursor = batch.revision;
    feed.seen.push(...batch.deltas);
    await feed.waitFor((delta) => delta.sessionId === first && delta.session?.status === 'working');
    await feed.waitFor((delta) => delta.sessionId === first && delta.session?.status === 'idle' && delta.session?.updatedAt === completedAt);
    const snapshot = await rosterSnapshot(client);
    expect(snapshot.body.sessions.filter((row) => row.id === first || row.id === second).map((row) => row.id)).toEqual([first, second]);

    const wire = JSON.stringify(feed.seen);
    expect(wire).not.toContain(marker);
    expect(wire).not.toMatch(/"(messages|telemetry|toolOutput|history)"/);

    // The same state again changes nothing; a later change on another session
    // proves the feed moved past the moment it would have appeared.
    const from = feed.seen.length;
    await client.post('/pi/bridge/events', { id: first, events: [{ t: 'status', running: false }] });
    await client.post('/pi/bridge/events', { id: second, events: [{ t: 'status', running: true }] });
    await feed.waitFor((delta) => delta.sessionId === second && delta.session?.status === 'working', { from });
    expect(feed.of(first, from)).toEqual([]);
  });


  test('a 7-day client sees an idle row age out and a deleted file leave, as transcript-free removals', async () => {
    const window = '7d';
    // Admitted now, outside the window a few seconds from now. Only a forced discovery reads the
    // new mtime, and the snapshot applies the window when it answers, so the room before the
    // cutoff must outlast that discovery: about twenty seconds on a Windows host. Each attempt
    // re-ages the file with room for the discovery the previous attempt measured.
    let discoveryMs = 0;
    const aging = writePiSession(broker.paths, 'aging');
    const admitted = await eventually(async () => {
      age(aging.path, 7 * DAY - (discoveryMs + 4_000));
      const started = performance.now();
      const snapshot = await rosterSnapshot(client, { window, refresh: true });
      discoveryMs = performance.now() - started;
      return ids(snapshot.body.sessions).includes(aging.id) ? snapshot.body : undefined;
    }, { what: 'a 7-day snapshot that still admits the aging session', timeoutMs: 3 * SOON_MS });
    expect(ids(admitted.sessions)).toContain(pi.doomed!.id);

    const feed = new RosterFeed(client, window);
    feed.cursor = admitted.revision;
    // Nothing touches the file: wall-clock aging alone must remove it, within the room given above.
    const aged = await feed.waitFor(
      (delta) => delta.sessionId === aging.id && delta.removed === true,
      { timeoutMs: SOON_MS + discoveryMs },
    );
    expect(aged.session).toBeUndefined();
    expect(aged.revision).toBeGreaterThan(admitted.revision);

    // A forced refresh can join a sweep started by the preceding long poll.
    // Drain that sweep before deleting, so its earlier read cannot mask removal.
    const settled = await rosterSnapshot(client, { window, refresh: true });
    expect(settled.body.complete).toBe(true);
    unlinkSync(pi.doomed!.path);
    const refreshed = await rosterSnapshot(client, { window, refresh: true });
    expect(ids(refreshed.body.sessions)).not.toContain(pi.doomed!.id);
    const deleted = await feed.waitFor((delta) => delta.sessionId === pi.doomed!.id && delta.removed === true);
    expect(deleted.session).toBeUndefined();
    expect(deleted.revision).toBeGreaterThan(aged.revision);
  });

  test('excluded old children and conversations leave an unchanged poll waiting to its deadline', async () => {
    const snapshot = await rosterSnapshot(client, { window: '7d', refresh: true });
    const feed = new RosterFeed(client, '7d');
    const started = performance.now();
    const batch = await feed.request(snapshot.body.revision, 200);
    expect(batch).toEqual({ revision: snapshot.body.revision, deltas: [] });
    expect(performance.now() - started).toBeGreaterThanOrEqual(180);
    const abort = new AbortController();
    const pending = fetch(`${broker.url}/api/session-roster-deltas?window=7d&after=${batch.revision}&waitMs=25000`, { signal: abort.signal });
    await client.get('/api/health');
    abort.abort();
    await expect(pending).rejects.toThrow();
  });

  test('a cursor from the future, or one the bounded journal no longer holds, asks the client to reset', async () => {
    const feed = new RosterFeed(client);
    const head = await feed.head();
    const future = await feed.request(head + 100);
    expect(future).toMatchObject({ resetRequired: true, deltas: [] });

    await feed.start();
    const hello = await client.post('/pi/bridge/hello', {
      sessionFile: join(broker.paths.root, 'live-churn.jsonl'), cwd: broker.paths.home, title: 'live churn',
    });
    const id = String(hello.body.id);
    await client.post('/pi/bridge/events', { id, events: [{ t: 'status', running: true }] });
    await feed.waitFor((delta) => delta.sessionId === id && delta.session?.status === 'working');
    const start = feed.cursor;
    // More status changes than the 32-entry journal keeps.
    let running = true;
    await eventually(async () => {
      running = !running;
      await client.post('/pi/bridge/events', { id, events: [{ t: 'status', running }] });
      return (await feed.head()) > start + 40;
    }, { what: 'the journal to move 40 revisions', intervalMs: 0 });
    expect(await feed.request(start)).toMatchObject({ resetRequired: true, deltas: [] });
    const current = await feed.head();
    expect((await feed.request(current)).resetRequired).toBeUndefined();
  });

  test('a replaced Claude session is one row, chosen by bridge identity and generation; ties retire neither', async () => {
    const roster = await rosterSnapshot(client, { refresh: true });
    expectOneReplacementRow(roster.body.sessions);
    for (const title of ['Claude tied generation fixture', 'Claude missing generation fixture']) {
      const rows = roster.body.sessions.filter((row: any) => row.title === title);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.nativeId).toStartWith('claude-bridge:');
    }
  });

  test("a live Claude owner's run state outranks what the transcript watcher infers", async () => {
    const id = fileSessionId(watchedPath);
    const bridgeDir = join(claudeDir, 'cosyncing', 'bridge');
    mkdirSync(bridgeDir, { recursive: true });
    let pokes = 0;
    /** Make the transcript watcher re-derive the row, titled so its publication is recognisable. */
    const watcherSnapshot = async (feed: RosterFeed): Promise<RosterDelta> => {
      pokes += 1;
      const title = `watcher view ${pokes}`;
      appendFileSync(watchedPath, line({ type: 'custom-title', customTitle: title, sessionId: WATCHED_UUID }));
      writeFileSync(join(bridgeDir, `${WATCHED_UUID}.sock`), String(pokes));
      return feed.waitFor((delta) => delta.sessionId === id && delta.session?.title === title);
    };
    const statuses = (feed: RosterFeed, from: number): string[] =>
      feed.of(id, from).filter((delta) => delta.session && delta.changedFields.some((field) => field === 'status' || field === 'session'))
        .map((delta) => delta.session.status);

    const roster = await rosterSnapshot(client);
    expect(roster.body.sessions.find((row: any) => row.id === id)?.status).toBe('idle');
    const feed = new RosterFeed(client);
    await feed.start();

    // No live owner: a truthful watcher change publishes as it is.
    appendFileSync(watchedPath, claudeUser(WATCHED_UUID, 2, broker.paths.home));
    writeFileSync(join(bridgeDir, `${WATCHED_UUID}.sock`), '');
    await feed.waitFor((delta) => delta.sessionId === id && delta.session?.status === 'working');

    // The transcript now ends its turn (the watcher would infer idle) while the
    // hooks owner says a turn is running.
    appendFileSync(watchedPath, claudeEndTurn(WATCHED_UUID, 2));
    const hello = await client.post('/claude/hook/hello', { transcriptPath: watchedPath, cwd: broker.paths.home, title: 'hooks owner' });
    expect(hello.body).toEqual({ ok: true, id });
    const turnFrom = feed.seen.length;
    expect((await client.post('/claude/hook/status', { transcriptPath: watchedPath, state: 'working' })).body)
      .toEqual({ ok: true, tracked: true });
    await feed.waitFor((delta) => delta.sessionId === id && delta.session?.status === 'working', { from: turnFrom });
    const raceFrom = feed.seen.length;
    expect((await watcherSnapshot(feed)).session.status).toBe('working');
    expect(statuses(feed, raceFrom).every((status) => status === 'working')).toBe(true);

    // The terminal is now waiting by its own account (`agents --json`) and the
    // transcript has an open prompt: the watcher infers needs-input. A session
    // with no owner publishes exactly that (the waiting terminal in the window
    // test); here the working owner keeps the row.
    claude.setAgents([{ sessionId: WATCHED_UUID, status: 'waiting' }, { sessionId: WAITING_UUID, status: 'waiting' }]);
    appendFileSync(watchedPath, claudeUser(WATCHED_UUID, 3, broker.paths.home));
    const inferredFrom = feed.seen.length;
    expect((await watcherSnapshot(feed)).session.status).toBe('working');
    expect(statuses(feed, inferredFrom).every((status) => status === 'working')).toBe(true);

    // A real permission request on the owned connection is the route to needs-input.
    const stream = await client.attach('claude', id);
    const requestId = `perm-${crypto.randomUUID()}`;
    const decision = client.post('/claude/hook/request', {
      transcriptPath: watchedPath, requestId, kind: 'permission', toolName: 'Bash', title: 'Run a command', detail: 'true',
    });
    const needsInput = await feed.waitFor(
      (delta) => delta.sessionId === id && delta.session?.status === 'needs-input',
      { from: inferredFrom },
    );
    await stream.waitForFrame((frame) => JSON.stringify(frame).includes(requestId));
    const ack = await stream.sendAndAwait({ kind: 'approve', requestId, decision: 'approve' });
    expect(ack.kind).toBe('ack');
    expect((await decision).body).toEqual({ resolved: true, kind: 'permission', decision: 'approve' });
    await feed.waitFor(
      (delta) => delta.sessionId === id && delta.session?.status === 'working',
      { from: feed.seen.indexOf(needsInput) + 1 },
    );
    stream.close();

    // The owner's own terminal event journals exactly one idle; later watcher
    // views (still inferring needs-input) change nothing.
    const terminalFrom = feed.seen.length;
    expect((await client.post('/claude/hook/status', { transcriptPath: watchedPath, state: 'idle' })).body.ok).toBe(true);
    await feed.waitFor((delta) => delta.sessionId === id && delta.session?.status === 'idle', { from: terminalFrom });
    expect((await watcherSnapshot(feed)).session.status).toBe('idle');
    expect(statuses(feed, terminalFrom)).toEqual(['idle']);
  });

  test('after a restart the Claude selection survives a deleted registry, and an old cursor resets', async () => {
    const feed = new RosterFeed(client);
    const before = await feed.head();
    for (const path of replacementRegistries) unlinkSync(path);
    await broker.restart();
    const roster = await rosterSnapshot(client, { refresh: true });
    expectOneReplacementRow(roster.body.sessions);
    expect(roster.body.revision).toBeLessThan(before);
    expect(await feed.request(before)).toMatchObject({ resetRequired: true, deltas: [] });
  });
  test('visibility syncs across clients, hides subagents and survives cache clearing and restart', async () => {
    const other = broker.client();
    try {
      const before = (await rosterSnapshot(client, { refresh: true })).body.sessions;
      const parent = before.find((row) => row.id === fileSessionId(watchedPath));
      const child = before.find((row) => row.origin === 'subagent' && row.parentThreadId === parent?.nativeId);
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      const nativeBefore = readFileSync(watchedPath, 'utf8');
      const route = (row: any) => `/api/sessions/${row.tool}/${encodeURIComponent(row.id)}/visibility`;
      const change = (row: any, hidden: boolean) => client.request('PATCH', route(row), { hidden });
      const feed = new RosterFeed(other);
      await feed.start();
      expect((await client.request('PATCH', route(parent), { hidden: 'yes' })).status).toBe(400);
      // An independently hidden child must not be unhidden by restoring its parent.
      expect((await change(child, true)).status).toBe(200);
      expect((await rosterSnapshot(other)).body.sessions.find((row) => row.id === parent.id)?.appHidden).toBe(false);
      const hidden = await change(parent, true);
      expect(hidden.status).toBe(200);
      expect(hidden.body.session).toMatchObject({ appHidden: true, status: parent.status, attachMode: parent.attachMode });
      const published = await feed.waitFor((delta) => delta.sessionId === parent.id && delta.session?.appHidden === true);
      expect(published.changedFields).toContain('appHidden');
      let rows = (await rosterSnapshot(other)).body.sessions;
      expect(rows.find((row) => row.id === child.id)).toMatchObject({ appHidden: true, appHiddenByAncestor: true });
      expect((await change(child, false)).status).toBe(409);
      // A subagent discovered after Hide inherits the parent's preference.
      const latePath = join(dirname(watchedPath), WATCHED_UUID, 'subagents', 'agent-hidden-late.jsonl');
      writeFileSync(latePath.replace(/\.jsonl$/, '.meta.json'), line({ toolUseId: 'late-child-tool' }));
      writeFileSync(latePath, claudeUser('agent-hidden-late', 1, broker.paths.home) + claudeEndTurn('agent-hidden-late', 1));
      rows = (await rosterSnapshot(other, { refresh: true })).body.sessions;
      expect(rows.find((row) => row.id === fileSessionId(latePath))).toMatchObject({ appHidden: true, appHiddenByAncestor: true });
      expect(rows.find((row) => row.id === pi.recent!.id)?.appHidden).toBe(false);
      expect((await client.delete(`/api/sessions/${parent.tool}/${encodeURIComponent(parent.id)}/cache`)).status).toBe(200);
      await broker.restart();
      // A cold sweep can reach its discovery budget and return an explicitly
      // incomplete roster. Wait for the complete representation before
      // deciding whether the persisted visibility preference survived.
      rows = await eventually(async () => {
        const snapshot = await rosterSnapshot(other, { refresh: true });
        expect(snapshot.status).toBe(200);
        return snapshot.body.complete === true ? snapshot.body.sessions : undefined;
      }, { timeoutMs: ROSTER_SWEEP_BUDGET_MS, what: 'a complete roster after cache clearing and restart' });
      expect(rows.find((row) => row.id === parent.id)?.appHidden).toBe(true);
      expect(rows.find((row) => row.id === child.id)?.appHidden).toBe(true);
      expect((await change(parent, false)).status).toBe(200);
      rows = (await rosterSnapshot(other)).body.sessions;
      expect(rows.find((row) => row.id === parent.id)?.appHidden).toBe(false);
      expect(rows.find((row) => row.id === fileSessionId(latePath))?.appHidden).toBe(false);
      expect(rows.find((row) => row.id === child.id)).toMatchObject({ appHidden: true, appHiddenByAncestor: false });
      expect((await change(child, false)).status).toBe(200);
      expect(readFileSync(watchedPath, 'utf8')).toBe(nativeBefore);
    } finally { other.closeAll(); }
  });

  test('custom activity windows load their own range and use distinct cached representations', async () => {
    for (const window of ['0d', '-2d', '1.5d', '36501d']) {
      expect((await client.get(`/api/sessions?window=${window}`)).status).toBe(400);
      expect((await client.get(`/api/session-roster-deltas?window=${window}`)).status).toBe(400);
    }
    const two = await rosterSnapshot(client, { window: '2d', refresh: true });
    const four = await rosterSnapshot(client, { window: '4d', refresh: true });
    const sixty = await rosterSnapshot(client, { window: '60d', refresh: true });
    expect(ids(two.body.sessions)).not.toContain(pi.days3!.id);
    expect(ids(four.body.sessions)).toContain(pi.days3!.id);
    expect(ids(four.body.sessions)).not.toContain(pi.days20!.id);
    expect(ids(sixty.body.sessions)).toContain(pi.days20!.id);
    expect(ids(sixty.body.sessions)).not.toContain(pi.days100!.id);
    const again = await rosterSnapshot(client, { window: '2d', headers: { 'if-none-match': sixty.headers.get('etag')! } });
    expect(again.status).toBe(200);
    expect(ids(again.body.sessions)).not.toContain(pi.days20!.id);
    // Trying many ranges evicts dormant snapshots; a prior cursor must reset,
    // never silently match a different journal that happens to reuse its number.
    const retained = await client.get(`/api/session-roster-deltas?window=2d&after=${two.body.revision}`);
    expect(retained.status).toBe(200);
    expect(retained.body.resetRequired).not.toBe(true);
    for (let days = 101; days <= 104; days++) {
      const pressure = await rosterSnapshot(client, { window: `${days}d` });
      expect(pressure.status).toBe(200);
      expect(pressure.body.complete).toBe(true);
    }
    const resumed = await client.get(`/api/session-roster-deltas?window=2d&after=${two.body.revision}`);
    expect(resumed.body.resetRequired).toBe(true);
    expect(ids((await rosterSnapshot(client, { window: '2d' })).body.sessions)).not.toContain(pi.days20!.id);
  });

});
