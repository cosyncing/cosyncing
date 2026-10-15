/**
 * Session status truth: what a session's run state is, on every surface a client reads it from.
 *
 * A live session is scripted through the Pi bridge (the extension's hello, events and bye), and a
 * pinned Claude session through the Claude hooks. The app side is an attached session stream (its
 * `session` frames and the cards a late joiner is replayed), the roster snapshot and its delta
 * feed, and the attention feed. The Codex run-state authority (daemon, rollouts, terminals) is
 * `status-truth-codex.test.ts`; the exhaustive ordering tables are the narrow
 * `broker/test/sessions/session-status-fold.test.ts`.
 *
 * "Nothing happened" is always proved against a later sentinel: the session frames a stream holds
 * are compared as a whole sequence once the next transition (or a token-count frame) has arrived.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Broker,
  type BrokerClient,
  eventually,
  type Frame,
  type SessionStream,
  startBroker,
} from '../harness/index.ts';
import { installFakeClaudeAgents } from '../harness/fakes/claude-agents.ts';
import { openPiBridgeSession, type PiBridgeSession, type PiEvent } from '../harness/fakes/pi-bridge.ts';
import { fileSessionId, RosterFeed, rosterSnapshot } from '../harness/roster.ts';

const MACHINE = 'status-e2e';
const ATTENTION_STORE = 'attention-events.json';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** The run states a stream was told, in order (every `session` frame). */
const sessionStatuses = (stream: SessionStream, from = 0): string[] =>
  stream.frames.slice(from).filter((frame) => frame.kind === 'session').map((frame) => String(frame.info?.status));

/** Messages delivered live (not in a history frame), in order. */
const liveMessages = (stream: SessionStream, from = 0): any[] =>
  stream.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);

/** The messages of a stream's (first) history frame. */
const historyOf = (stream: SessionStream): any[] =>
  (stream.frames.find((frame) => frame.kind === 'history')?.messages ?? []) as any[];

/** Wait until the stream's newest session frame says `status`. */
function settlesTo(stream: SessionStream, status: string): Promise<Frame> {
  return stream.waitForFrame(
    () => sessionStatuses(stream).at(-1) === status,
    { what: `the stream to settle on ${status}` },
  );
}

/**
 * Everything replayed to a socket that has just attached, up to a sentinel token-count the bridge
 * sends after the attach: the replay is complete once the sentinel arrives.
 */
async function attachAndSettle(client: BrokerClient, pi: PiBridgeSession, marker: number): Promise<SessionStream> {
  const stream = await client.attach('pi', pi.id, { artifactMode: 'reference' });
  await stream.waitForKind('history');
  await pi.events([{ t: 'token', input: marker, output: 0 }]);
  await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'token-count' && frame.message.input === marker);
  return stream;
}

const pendingCards = (stream: SessionStream): string[] =>
  liveMessages(stream)
    .filter((message) => message.type === 'permission-request' || message.type === 'question-request')
    .map((message) => String(message.requestId));

async function attentionFeed(client: BrokerClient, clientId = 'status-e2e'): Promise<any[]> {
  const events: any[] = [];
  let after: number | undefined;
  for (;;) {
    const query = new URLSearchParams({ clientId, limit: '200', ...(after !== undefined ? { after: String(after) } : {}) });
    const response = await client.get(`/api/attention-events?${query}`);
    if (response.status !== 200) throw new Error(`attention feed → ${response.status}: ${response.text.slice(0, 300)}`);
    events.push(...response.body.events);
    if (!response.body.hasMore) return events;
    after = response.body.cursor;
  }
}

// ── one live turn, every surface ────────────────────────────────────────────

describe('a live turn', () => {
  let broker: Broker;
  let client: BrokerClient;
  let pi: PiBridgeSession;
  let detail: SessionStream;
  const sessionFile = { path: '' };
  const CANONICAL = {
    promptKey: 'turn:u0',
    assistantKey: 'turn:a0',
    turnId: 'turn-0',
    runKey: 'pi:run:turn-0',
    promptText: 'the cumulative prompt',
    answerText: 'the cumulative answer',
  };
  const SEED: PiEvent[] = [
    { t: 'user', key: 'seed:u', text: 'seed prompt' },
    { t: 'final', key: 'seed:a', text: 'seed answer' },
  ];
  const FINISHED_TURN: PiEvent[] = [
    { t: 'user', key: CANONICAL.promptKey, text: CANONICAL.promptText },
    { t: 'final', key: CANONICAL.assistantKey, text: CANONICAL.answerText },
    {
      t: 'run-summary', key: CANONICAL.runKey, turnId: CANONICAL.turnId,
      userMessageKey: CANONICAL.promptKey, assistantMessageKey: CANONICAL.assistantKey,
      status: 'done', startedAt: 1_000, completedAt: 4_000,
    },
  ];

  beforeAll(async () => {
    broker = await startBroker({
      name: 'status-turn',
      env: {
        COSYNCING_MACHINE: MACHINE,
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '3600000',
        COSYNCING_HISTORY_MAX_MESSAGES: '5000',
      },
    });
    client = broker.client();
    sessionFile.path = join(broker.paths.root, 'pi-live-turn.jsonl');
    pi = await openPiBridgeSession(broker, SEED, { title: 'live turn', sessionFile: sessionFile.path });
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  test('the roster and the open session go Working and back to Idle without a refetch; one prompt row, one footer that knows its prompt', async () => {
    const roster = await rosterSnapshot(client);
    expect(roster.body.sessions.find((row) => row.id === pi.id)?.status).toBe('idle');
    const feed = new RosterFeed(client);
    await feed.start();
    detail = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    await detail.waitForKind('history');

    await pi.events([
      { t: 'status', running: true },
      { t: 'user', key: CANONICAL.promptKey, text: CANONICAL.promptText },
      {
        t: 'run-summary', key: CANONICAL.runKey, turnId: CANONICAL.turnId,
        userMessageKey: CANONICAL.promptKey, status: 'running', startedAt: 1_000,
      },
    ]);
    await settlesTo(detail, 'working');
    const working = await feed.waitFor((delta) => delta.sessionId === pi.id && delta.session?.status === 'working');
    expect(working.changedFields).toContain('status');

    await detail.waitForMessage((message) => message.type === 'user-message' && message.key === CANONICAL.promptKey);
    expect(liveMessages(detail).filter((message) => message.type === 'user-message' && message.text === CANONICAL.promptText))
      .toHaveLength(1);

    await pi.events([
      { t: 'delta', key: CANONICAL.assistantKey, delta: 'the cumulative ' },
      { t: 'final', key: CANONICAL.assistantKey, text: CANONICAL.answerText },
      {
        t: 'run-summary', key: CANONICAL.runKey, turnId: CANONICAL.turnId,
        userMessageKey: CANONICAL.promptKey, assistantMessageKey: CANONICAL.assistantKey,
        status: 'done', startedAt: 1_000, completedAt: 4_000,
      },
      { t: 'status', running: false },
    ]);
    const footer = await detail.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
    expect(footer).toMatchObject({
      key: CANONICAL.runKey,
      totalRuntimeMs: 3_000,
      completedAt: 4_000,
      userMessageKey: CANONICAL.promptKey,
      assistantMessageKey: CANONICAL.assistantKey,
    });
    await settlesTo(detail, 'idle');
    await feed.waitFor((delta) => delta.sessionId === pi.id && delta.session?.status === 'idle', {
      from: feed.seen.indexOf(working) + 1,
    });
    expect(sessionStatuses(detail)).toEqual(['idle', 'working', 'idle']);
  });

  test('a reconnect replays one prompt and one footer, a reset:false continuation restates nothing, and live and history orders agree', async () => {
    const replay = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    const history = await replay.waitForKind('history');
    const prompts = (history.messages as any[]).filter((message) => message.type === 'user-message' && message.text === CANONICAL.promptText);
    expect(prompts.map((message) => message.key)).toEqual([CANONICAL.promptKey]);
    const footers = (history.messages as any[]).filter((message) => message.type === 'run-summary' && message.status === 'done');
    expect(footers).toHaveLength(1);
    expect(footers[0]).toMatchObject({ totalRuntimeMs: 3_000, completedAt: 4_000, userMessageKey: CANONICAL.promptKey });

    const resumed = await client.attach('pi', pi.id, { artifactMode: 'reference', since: String(history.attachTicket) });
    const continuation = await resumed.waitForKind('history');
    expect(continuation.reset).not.toBe(true);
    expect((continuation.messages as any[]).filter((message) => message.type === 'user-message')).toEqual([]);

    // The same canonical order whether a client watched it live or rebuilt it from history.
    const keys = ['wire:u0', 'wire:m0', 'wire:u1', 'wire:m1'];
    const from = detail.frames.length;
    await pi.events([
      { t: 'user', key: keys[0], text: 'open' },
      { t: 'delta', key: keys[1], delta: 'before' },
      { t: 'final', key: keys[1], text: 'before' },
      { t: 'user', key: keys[2], text: 'steer' },
      { t: 'delta', key: keys[3], delta: 'after' },
      { t: 'final', key: keys[3], text: 'after' },
    ]);
    const live = await eventually(() => {
      const seen = liveMessages(detail, from).map((message) => message.key).filter((key) => keys.includes(key));
      return seen.length === keys.length && seen;
    }, { what: 'the live chronology' });
    expect(live).toEqual(keys);
    const rebuilt = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    await rebuilt.waitForKind('history');
    expect(historyOf(rebuilt).map((message) => message.key).filter((key) => keys.includes(key))).toEqual(keys);
    for (const stream of [replay, resumed, rebuilt]) stream.close();
  });

  test('paging while the session appends is served or retriable, never "too large", and the socket stays pageable', async () => {
    const paging = await client.attach('pi', pi.id, { artifactMode: 'reference', initialHistory: 2 });
    const attach = await paging.waitForKind('history');
    expect(typeof attach.olderCursor).toBe('string');
    const page = async (requestId: string): Promise<Frame> => {
      const after = paging.frames.length;
      paging.send({ kind: 'history-page', cursor: attach.olderCursor, limit: 2, clientMessageId: requestId });
      return paging.waitForFrame(
        (frame) => frame.clientMessageId === requestId && (frame.kind === 'history-page' || frame.kind === 'nack'),
        { after, what: `history page ${requestId}` },
      );
    };
    // The bridge appends back to back while the page is requested and built.
    let appending = true;
    let appended = 0;
    const appender = (async () => {
      while (appending) await pi.events([{ t: 'final', key: `append:${appended}`, text: `append ${appended++}` }]);
    })();
    const raced = await page('during-append');
    appending = false;
    await appender;
    expect(appended).toBeGreaterThan(0);
    expect(raced.code).not.toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(raced.kind === 'history-page' || raced.code === 'HISTORY_PAGE_SOURCE_CHANGED').toBe(true);
    // A transient race leaves no sticky "paging unavailable" on the socket.
    expect((await page('retry')).kind).toBe('history-page');
    expect((await page('retry-again')).kind).toBe('history-page');
    paging.close();
  });

  test('after a broker restart the re-announced session keeps its id, its prompt identity and the footer that names it', async () => {
    client.closeAll();
    await broker.restart();
    const again = await openPiBridgeSession(broker, [...SEED, ...FINISHED_TURN], { title: 'live turn', sessionFile: sessionFile.path });
    expect(again.id).toBe(pi.id);
    const restarted = await client.attach('pi', pi.id, { artifactMode: 'reference' });
    await restarted.waitForKind('history');
    const history = historyOf(restarted);
    expect(history.filter((message) => message.type === 'user-message' && message.key === CANONICAL.promptKey)).toHaveLength(1);
    expect(history.find((message) => message.type === 'run-summary' && message.status === 'done')?.userMessageKey)
      .toBe(CANONICAL.promptKey);
    restarted.close();
  });
});

// ── run-state frames, pending requests, attention ───────────────────────────

describe('run state on an open session', () => {
  let broker: Broker;
  let client: BrokerClient;
  let marker = 0;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'status-frames',
      env: { COSYNCING_MACHINE: MACHINE, COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '3600000' },
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  const open = (name: string) => openPiBridgeSession(broker, [], {
    title: name,
    sessionFile: join(broker.paths.root, `pi-${name}.jsonl`),
  });

  test('running, needs-input and idle each push one session frame; streamed text and repeated frames push none', async () => {
    const pi = await open('frames');
    const stream = await client.attach('pi', pi.id);
    await stream.waitForKind('history');

    await pi.events([{ t: 'status', running: true }]);
    await settlesTo(stream, 'working');
    await pi.events([{ t: 'delta', key: 'k1', delta: 'hello' }, { t: 'status', running: true }]);
    // The next transition is the sentinel: nothing came between it and `working`.
    await pi.events([{ t: 'permission-request', requestId: 'r1', title: 'may i' }]);
    await settlesTo(stream, 'needs-input');
    expect(sessionStatuses(stream)).toEqual(['idle', 'working', 'needs-input']);

    // Resolving returns to the derived run state: the turn is still running.
    await pi.events([{ t: 'permission-resolved', requestId: 'r1', decision: 'approve' }]);
    await settlesTo(stream, 'working');
    await pi.events([{ t: 'status', running: false }]);
    await settlesTo(stream, 'idle');
    await pi.events([{ t: 'status', running: false }, { t: 'status', running: true }]);
    await settlesTo(stream, 'working');
    expect(sessionStatuses(stream)).toEqual(['idle', 'working', 'needs-input', 'working', 'idle', 'working']);
    await pi.events([{ t: 'status', running: false }]);
    await settlesTo(stream, 'idle');
    stream.close();
  });

  test('in-flight text a late joiner is replayed is bounded and says so; the end of the turn clears it', async () => {
    const pi = await open('bounded');
    await pi.events([{ t: 'status', running: true }, { t: 'delta', key: 'small', delta: 'hello' }]);
    // 600 KiB on one key, in requests under the bridge's 1 MiB body limit.
    for (const fill of ['x', 'y']) await pi.events([{ t: 'delta', key: 'oversized', delta: fill.repeat(300 * 1024) }]);

    const late = await attachAndSettle(client, pi, ++marker);
    expect(sessionStatuses(late)).toEqual(['working']);
    const replayed = liveMessages(late);
    const oversized = replayed.find((message) => message.type === 'model-output' && message.key === 'oversized');
    expect(Buffer.byteLength(oversized?.text ?? '', 'utf8')).toBe(256 * 1024);
    expect(replayed.find((message) => message.type === 'model-output' && message.key === 'small')?.text).toBe('hello');
    expect(replayed.some((message) => message.type === 'notice' && String(message.message).includes('replay window'))).toBe(true);
    late.close();

    await pi.events([{ t: 'status', running: false }]);
    const afterTurn = await attachAndSettle(client, pi, ++marker);
    expect(sessionStatuses(afterTurn)).toEqual(['idle']);
    expect(liveMessages(afterTurn).filter((message) => message.type === 'model-output' || message.type === 'notice')).toEqual([]);
    afterTurn.close();
  });

  test('a duplicate or orphan resolution changes nothing, and a late joiner is replayed only the requests still open', async () => {
    const pi = await open('pending');
    const stream = await client.attach('pi', pi.id);
    await stream.waitForKind('history');

    await pi.events([{ t: 'permission-request', requestId: 'p1', title: 'may i' }]);
    await settlesTo(stream, 'needs-input');
    await pi.events([{ t: 'permission-resolved', requestId: 'p1', decision: 'approve' }]);
    await settlesTo(stream, 'idle');
    await pi.events([
      { t: 'permission-resolved', requestId: 'p1', decision: 'approve' },
      { t: 'question-resolved', requestId: 'never-requested' },
      { t: 'question-request', requestId: 'q1', questions: [] },
      { t: 'permission-resolved', requestId: 'q-other', decision: 'reject' },
    ]);
    await settlesTo(stream, 'needs-input');
    await pi.events([{ t: 'question-request', requestId: 'q2', questions: [] }, { t: 'question-resolved', requestId: 'q2' }]);
    // q1 is still open: the resolution of another id could not clear it.
    const replay = await attachAndSettle(client, pi, ++marker);
    expect(sessionStatuses(replay)).toEqual(['needs-input']);
    expect(pendingCards(replay)).toEqual(['q1']);
    expect(sessionStatuses(stream)).toEqual(['idle', 'needs-input', 'idle', 'needs-input']);
    replay.close();

    await pi.events([{ t: 'question-resolved', requestId: 'q1' }]);
    await settlesTo(stream, 'idle');
    const empty = await attachAndSettle(client, pi, ++marker);
    expect(sessionStatuses(empty)).toEqual(['idle']);
    expect(pendingCards(empty)).toEqual([]);
    empty.close();
    stream.close();
  });

  test('attention follows the exact request: an orphan resolution clears nothing, the genuine one resolves it once', async () => {
    const pi = await open('attention');
    const permissionKey = `permission-required:pi:${pi.id}:attention-p1`;
    const forSession = async () => (await attentionFeed(client)).filter((event) => event.sessionId === pi.id);

    await pi.events([{ t: 'permission-request', requestId: 'attention-p1', title: 'approval' }]);
    await eventually(async () => (await forSession()).find((event) => event.dedupeKey === permissionKey && event.state === 'active'), {
      what: 'the permission event',
    });
    await pi.events([
      { t: 'permission-resolved', requestId: 'attention-ghost', decision: 'reject' },
      { t: 'question-request', requestId: 'attention-sentinel', questions: [] },
    ]);
    // The sentinel was handled after the orphan resolution.
    const afterOrphan = await eventually(async () => {
      const events = await forSession();
      return events.some((event) => event.requestId === 'attention-sentinel') && events;
    }, { what: 'the sentinel question event' });
    expect(afterOrphan.find((event) => event.dedupeKey === permissionKey)?.state).toBe('active');

    await pi.events([{ t: 'permission-resolved', requestId: 'attention-p1', decision: 'approve' }]);
    const resolved = await eventually(async () => {
      const event = (await forSession()).find((candidate) => candidate.dedupeKey === permissionKey);
      return event?.state === 'resolved' && event;
    }, { what: 'the permission resolved' });
    await pi.events([
      { t: 'permission-resolved', requestId: 'attention-p1', decision: 'approve' },
      { t: 'question-resolved', requestId: 'attention-sentinel' },
    ]);
    const settled = await eventually(async () => {
      const events = await forSession();
      return events.find((event) => event.requestId === 'attention-sentinel')?.state === 'resolved' && events;
    }, { what: 'the sentinel resolved' });
    const permission = settled.filter((event) => event.dedupeKey === permissionKey);
    expect(permission).toHaveLength(1);
    expect(permission[0]).toMatchObject({ state: 'resolved', revision: resolved.revision });
    expect(settled.filter((event) => event.state === 'active')).toEqual([]);
  });

  test('losing terminal control when a session ends raises no attention event', async () => {
    const pi = await open('control-loss');
    const stream = await client.attach('pi', pi.id);
    await stream.waitForKind('history');
    await pi.bye();
    await stream.waitForKind('ended');
    // The broker did observe the loss (the precondition), and said so only in its log.
    await eventually(() => broker.output().split('\n').some((entry) =>
      entry.includes('session-control-transition') && entry.includes(pi.id) && entry.includes('"to":"unavailable"')), {
      what: 'the control-transition log line',
    });
    // The re-announced session runs a turn: its outcome is the sentinel that attention caught up.
    const back = await open('control-loss');
    expect(back.id).toBe(pi.id);
    await back.events([{ t: 'run', key: 'after', turnId: 'after', status: 'running' }, { t: 'run', key: 'after', turnId: 'after', status: 'done' }]);
    const events = await eventually(async () => {
      const all = await attentionFeed(client);
      return all.some((event) => event.sessionId === pi.id && event.turnId === 'after') && all;
    }, { what: 'the sentinel turn outcome' });
    expect(events.filter((event) => event.kind === 'sync-degraded')).toEqual([]);
    expect(events.filter((event) => event.sessionId === pi.id).map((event) => event.kind)).toEqual(['run-finished']);
  });
});

// ── sync-degraded rows an older broker left behind ──────────────────────────

describe('a store with sync-degraded rows from an older broker', () => {
  let broker: Broker;
  const now = Date.now();
  const event = (cursor: number, dedupeKey: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id: `legacy-${cursor}`, cursor, revision: 1, presentationRevision: 1, presentationStage: 'immediate',
    kind, state: 'active', severity: kind === 'sync-degraded' ? 'maintenance' : 'action-required',
    dedupeKey, createdAt: now, updatedAt: now, agent: 'pi', sessionId: 'persisted',
    title: kind === 'sync-degraded' ? 'Session sync degraded' : 'Permission required',
    summary: 'seeded by an older broker',
    action: { kind: 'open-session', tool: 'pi', sessionId: 'persisted' },
    ...extra,
  });

  beforeAll(async () => {
    broker = await startBroker({
      name: 'status-legacy-attention',
      setup: (paths) => writeFileSync(join(paths.cosyncingHome, ATTENTION_STORE), JSON.stringify({
        version: 1,
        nextCursor: 4,
        prunedThroughCursor: 0,
        events: [
          event(1, 'sync-degraded:pi:persisted:drive', 'sync-degraded'),
          event(2, 'sync-degraded:pi:persisted:terminal-sync', 'sync-degraded'),
          event(3, 'permission-required:pi:persisted:request-1', 'permission-required', { requestId: 'request-1' }),
        ],
        observations: [], clientStates: [], deliveries: [],
      }), { mode: 0o600 }),
      env: { COSYNCING_MACHINE: MACHINE },
    });
  });
  afterAll(() => broker?.stop());

  test('resolves them once at start, keeps them as history, and leaves every other open event alone', async () => {
    const client = broker.client();
    const byId = (events: any[]) => Object.fromEntries(events.map((item) => [item.id, item]));
    const first = byId(await attentionFeed(client, 'legacy'));
    expect([first['legacy-1']?.state, first['legacy-2']?.state]).toEqual(['resolved', 'resolved']);
    expect(first['legacy-3']).toMatchObject({ state: 'active', revision: 1 });

    await broker.restart();
    const second = byId(await attentionFeed(broker.client(), 'legacy'));
    for (const id of ['legacy-1', 'legacy-2', 'legacy-3']) {
      expect({ id, state: second[id]?.state, revision: second[id]?.revision })
        .toEqual({ id, state: first[id].state, revision: first[id].revision });
    }
  });
});

// ── a pinned bridge against the adapter's own view ──────────────────────────

describe('a pinned Claude hooks session', () => {
  const UUID = '0e0c3000-0000-4000-8000-000000000001';
  let broker: Broker;
  let client: BrokerClient;
  let transcript = '';
  let bridgeDir = '';

  beforeAll(async () => {
    broker = await startBroker({
      name: 'status-pinned',
      setup: (paths) => {
        const claudeDir = join(paths.root, 'claude');
        const project = join(claudeDir, 'projects', 'pinned');
        mkdirSync(project, { recursive: true });
        bridgeDir = join(claudeDir, 'cosyncing', 'bridge');
        mkdirSync(bridgeDir, { recursive: true });
        transcript = join(project, `${UUID}.jsonl`);
        writeFileSync(transcript, line({
          type: 'user', uuid: `${UUID}-u1`, sessionId: UUID, cwd: paths.home, timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'prompt 1' },
        }));
        installFakeClaudeAgents(paths.bin, []);
      },
      env: (paths) => ({
        COSYNCING_MACHINE: MACHINE,
        COSYNCING_CLAUDE_BIN: join(paths.bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
        // The Claude hooks routes exist only in a development run.
        COSYNCING_DEV_MODE: '1',
        COSYNCING_ROSTER_SAFETY_RECONCILE_MS: '3600000',
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
  });

  test('keeps its terminal sync, its socket and its open request when the transcript watcher reports it Observe-only', async () => {
    const id = fileSessionId(transcript);
    const hello = await client.post('/claude/hook/hello', { transcriptPath: transcript, cwd: broker.paths.home, title: 'pinned hooks' });
    expect(hello.body).toEqual({ ok: true, id });
    const stream = await client.attach('claude', id);
    const first = await stream.waitForKind('session');
    expect(first.info.control.terminalSync).toMatchObject({ supported: true, active: true });

    // The adapter's watcher re-derives the row (its own view is Observe, sync unsupported); the
    // title it publishes is the sentinel that the reconcile ran.
    const feed = new RosterFeed(client);
    await feed.start();
    for (const pass of [1, 2]) {
      const title = `watcher view ${pass}`;
      appendFileSync(transcript, line({ type: 'custom-title', customTitle: title, sessionId: UUID }));
      writeFileSync(join(bridgeDir, `${UUID}.sock`), String(pass));
      await feed.waitFor((delta) => delta.sessionId === id && delta.session?.title === title);
    }
    const row = (await rosterSnapshot(client)).body.sessions.find((session) => session.id === id);
    expect(row?.attachMode).toBe('live');
    expect(row?.control?.terminalSync).toMatchObject({ supported: true, active: true });

    // The same socket still answers the hook's blocking request: the bridge was never replaced.
    const requestId = `perm-${crypto.randomUUID()}`;
    const decision = client.post('/claude/hook/request', {
      transcriptPath: transcript, requestId, kind: 'permission', toolName: 'Bash', title: 'Run a command', detail: 'true',
    });
    await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message?.requestId === requestId);
    expect((await stream.sendAndAwait({ kind: 'approve', requestId, decision: 'approve' })).kind).toBe('ack');
    expect((await decision).body).toEqual({ resolved: true, kind: 'permission', decision: 'approve' });
    expect(stream.isOpen).toBe(true);
    expect(stream.frames.filter((frame) => frame.kind === 'history')).toHaveLength(1);
    stream.close();
  });
});
