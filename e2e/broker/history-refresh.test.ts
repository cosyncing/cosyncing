/**
 * The history window, read forward (protocol revision 28): `history-refresh`
 * from the reconnect cursor of the client's last frame, and `history-page`
 * with `direction: 'newer'` (optionally closed by `until`).
 *
 * A client that bounds its in-memory transcript releases rows and gets them
 * back through these, so what it relies on is: a refresh is an incremental
 * frame (`reset: false`) holding a bounded prefix of what was persisted since
 * the cursor, never skipping a row; while a turn runs the rows it may still
 * rewrite are held back; a forward walk holds every row once and ends at the
 * current end boundary; `until` comes back verbatim; a request the broker
 * cannot serve is refused with a stable code; and every client is answered
 * from one read of the session.
 *
 * The Pi bridge gives a scripted session; a Codex rollout shows the same
 * requests answered from the native compact index.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Broker, type SessionStream, startBroker } from '../harness/index.ts';
import { ask, attachFrame, historyReadLedgerEnv, sessionReads } from '../harness/history.ts';
import { openPiBridgeSession, piUserRows, type PiBridgeSession } from '../harness/fakes/pi-bridge.ts';
import { codexUser, writeRollout } from '../harness/fakes/codex-rollout.ts';

const PAGE = 100;
const keys = (messages: any[]): string[] => messages.map((message) => String(message.key));
const range = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, index) => `${prefix}-${from + index}`);

let broker: Broker;
beforeAll(async () => {
  broker = await startBroker({ name: 'history-refresh', env: (paths) => historyReadLedgerEnv(paths) });
});
afterAll(() => broker?.stop());

describe('refresh and newer pages over a live session', () => {
  let session: PiBridgeSession;
  let reader: SessionStream;
  let attach: any;
  const refreshReads = () => sessionReads(broker, 'pi', session.id, 'refresh');
  const pageReads = () => sessionReads(broker, 'pi', session.id, 'page-cache-miss');
  // Frames the tests below continue from, in file order.
  let one: any;
  let two: any;
  let idle: any;
  let empty: any;
  let forwardEnd: string;
  const streams: SessionStream[] = [];

  beforeAll(async () => {
    session = await openPiBridgeSession(broker, piUserRows('r', 300));
    reader = await broker.client().attach('pi', session.id, { artifactMode: 'reference', initialHistory: PAGE });
    streams.push(reader);
    attach = await attachFrame(reader);
  });
  afterAll(() => {
    for (const stream of streams) stream.close();
  });

  test('a pageable attach offers refresh and newer paging', () => {
    expect(attach.newerHistory).toBe(true);
    expect(typeof attach.endCursor).toBe('string');
    expect(keys(attach.messages)).toEqual(range('r', PAGE, 200));
  });

  test('a refresh after live rows is a bounded prefix starting right after the last frame', async () => {
    await session.events([
      { t: 'status', running: true },
      ...piUserRows('rl', 150),
      { t: 'delta', key: 'reply', delta: 'streamed reply' },
      // Persisted as the turn's newest row, while the turn still runs.
      { t: 'final', key: 'reply', text: 'streamed reply' },
    ]);
    await reader.waitForMessage((message) => message.key === 'reply');
    one = await ask(reader, { kind: 'history-refresh', cursor: attach.cursor });
    expect(one.kind).toBe('history');
    expect(one.reset).toBe(false);
    expect(one.newerHistory).toBe(true);
    expect(keys(one.messages)).toEqual(range('rl', PAGE));
    expect(one.truncated).toBeUndefined();
    expect(refreshReads()).toBe(1);
  });

  test('while the turn runs, the newest persisted row is held back', async () => {
    two = await ask(reader, { kind: 'history-refresh', cursor: one.cursor, limit: 500 });
    expect(two.kind).toBe('history');
    expect(keys(two.messages)).toEqual(range('rl', 50, 100));
    // Unchanged source: answered from the snapshot the last refresh read.
    expect(refreshReads()).toBe(1);
  });

  test('a refresh end boundary pages back exactly the rows before it', async () => {
    const back = await ask(reader, { kind: 'history-page', cursor: two.endCursor, limit: PAGE });
    expect(back.kind).toBe('history-page');
    expect(keys(back.messages)).toEqual(range('rl', PAGE, 50));
  });

  test('once the turn ends the held row ships, and an up-to-date refresh is empty and keeps its cursor', async () => {
    await session.events([{ t: 'status', running: false }]);
    await reader.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'idle');
    idle = await ask(reader, { kind: 'history-refresh', cursor: two.cursor });
    expect(idle.kind).toBe('history');
    expect(keys(idle.messages)).toEqual(['reply']);
    expect(idle.messages[0].text).toBe('streamed reply');
    empty = await ask(reader, { kind: 'history-refresh', cursor: idle.cursor });
    expect(empty.kind).toBe('history');
    expect(empty.messages).toHaveLength(0);
    expect(empty.cursor).toBe(idle.cursor);
    expect(empty.endCursor).toBe(idle.endCursor);
    // The snapshot read during the turn is retired once when it ends; nothing re-reads after that,
    // and the page route reused the snapshot the refresh read.
    expect(refreshReads()).toBe(2);
    expect(pageReads()).toBe(0);
  });

  test('a forward walk from the attach boundary holds every later row once and ends at the current end', async () => {
    const walked: string[] = [];
    let cursor = attach.olderCursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await ask(reader, { kind: 'history-page', direction: 'newer', cursor, limit: PAGE });
      expect(page.kind).toBe('history-page');
      expect(page.direction).toBe('newer');
      walked.push(...keys(page.messages));
      cursor = page.cursor;
      if (page.endOfHistory) break;
    }
    expect(walked).toEqual([...range('r', PAGE, 200), ...range('rl', 150), 'reply']);
    expect(cursor).toBe(idle.endCursor);
    forwardEnd = cursor;
  });

  test('a newer page past the snapshot it walked continues into rows appended since', async () => {
    await session.events(piUserRows('after', 5));
    await reader.waitForMessage((message) => message.key === 'after-4');
    const beyond = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: forwardEnd, limit: PAGE });
    expect(beyond.kind).toBe('history-page');
    expect(keys(beyond.messages)).toEqual(range('after', 5));
    expect(beyond.endOfHistory).toBe(true);
  });

  test('a walk that reaches until stops there and names it verbatim', async () => {
    const closed = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: attach.endCursor, until: one.endCursor, limit: 500,
    });
    expect(closed.kind).toBe('history-page');
    expect(keys(closed.messages)).toEqual(range('rl', PAGE));
    expect(closed.cursor).toBe(one.endCursor);
    expect(closed.hasMore).toBe(true);
  });

  test('requests the broker cannot serve are refused with stable codes', async () => {
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'history-page', direction: 'sideways', cursor: attach.endCursor }, 'BAD_PARAM'],
      [{ kind: 'history-page', cursor: attach.endCursor, until: attach.endCursor }, 'BAD_PARAM'],
      [{ kind: 'history-page', direction: 'newer', cursor: one.endCursor, until: attach.endCursor }, 'HISTORY_CURSOR_INVALID'],
      [{ kind: 'history-page', cursor: 'not-a-cursor' }, 'HISTORY_CURSOR_INVALID'],
      [{ kind: 'history-refresh', cursor: 'not-a-cursor' }, 'HISTORY_CURSOR_INVALID'],
      [{ kind: 'history-refresh', cursor: attach.cursor, limit: 0 }, 'BAD_PARAM'],
      [{ kind: 'history-refresh', cursor: attach.cursor, limit: 501 }, 'BAD_PARAM'],
      [{ kind: 'history-refresh' }, 'BAD_PARAM'],
    ];
    for (const [request, code] of refusals) {
      const answer = await ask(reader, request);
      expect({ request, kind: answer.kind, code: answer.code }).toEqual({ request, kind: 'nack', code });
    }
    // A refresh is matched to its answer by id, so one without an id is refused outright.
    const after = reader.frames.length;
    reader.send({ kind: 'history-refresh', cursor: attach.cursor });
    const unnamed = await reader.waitForFrame((frame) => frame.kind === 'nack', { after });
    expect(unnamed.code).toBe('BAD_CLIENT_MESSAGE_ID');
  });

  test('every client is answered from one read of the grown session', async () => {
    const peer = await broker.client().attach('pi', session.id, { artifactMode: 'reference', initialHistory: PAGE });
    streams.push(peer);
    const peerAttach = await attachFrame(peer);
    const before = refreshReads();
    await session.events([{ t: 'user', key: 'grown', text: 'grown row' }]);
    await peer.waitForMessage((message) => message.key === 'grown');
    const [mine, theirs] = await Promise.all([
      ask(reader, { kind: 'history-refresh', cursor: empty.cursor }),
      ask(peer, { kind: 'history-refresh', cursor: peerAttach.cursor }),
    ]);
    expect(mine.kind).toBe('history');
    expect(theirs.kind).toBe('history');
    expect(keys(theirs.messages)).toEqual(['grown']);
    expect(mine.messages.at(-1).key).toBe('grown');
    expect(mine.cursor).toBe(theirs.cursor);
    expect(refreshReads()).toBe(before + 1);
    const third = await ask(peer, { kind: 'history-refresh', cursor: theirs.cursor });
    expect(third.messages).toHaveLength(0);
    expect(refreshReads()).toBe(before + 1);

    // A replaced transcript is never answered from the snapshot of the one it replaced.
    await session.rehello([
      { t: 'user', key: 'replaced-0', text: 'replacement row 0' },
      { t: 'user', key: 'replaced-1', text: 'replacement row 1' },
    ]);
    const replacement = await peer.waitForFrame((frame) => frame.kind === 'history' && frame.reset === true
      && frame.messages?.[0]?.key === 'replaced-0');
    const stale = await ask(peer, { kind: 'history-refresh', cursor: third.cursor });
    expect(stale.kind).toBe('nack');
    expect(stale.code).toBe('HISTORY_CURSOR_GONE');
    const beforeReplacement = refreshReads();
    await session.events([{ t: 'user', key: 'replaced-2', text: 'replacement row 2' }]);
    await peer.waitForMessage((message) => message.key === 'replaced-2');
    const fresh = await ask(peer, { kind: 'history-refresh', cursor: replacement.cursor });
    expect(fresh.kind).toBe('history');
    expect(keys(fresh.messages)).toEqual(['replaced-2']);
    expect(refreshReads()).toBe(beforeReplacement + 1);
  });
});

describe('refresh and newer pages from a native compact index', () => {
  test('a Codex rollout refreshes and pages forward from its index, never from a full history read', async () => {
    const rollout = writeRollout(broker.paths.home, {
      generate: { count: 300, row: (index) => codexUser(`codex row ${index}`) },
    });
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE });
    try {
      const frame = await attachFrame(stream);
      expect(frame.messages).toHaveLength(PAGE);
      expect(frame.newerHistory).toBe(true);
      rollout.append(Array.from({ length: 30 }, (_, index) => codexUser(`codex appended ${index}`)));
      const refresh = await ask(stream, { kind: 'history-refresh', cursor: frame.cursor });
      expect(refresh.kind).toBe('history');
      expect(refresh.reset).toBe(false);
      expect(refresh.messages.map((message: any) => message.text))
        .toEqual(Array.from({ length: 30 }, (_, index) => `codex appended ${index}`));
      const forward = await ask(stream, {
        kind: 'history-page', direction: 'newer', cursor: frame.olderCursor, until: refresh.endCursor, limit: 500,
      });
      expect(forward.kind).toBe('history-page');
      expect(forward.direction).toBe('newer');
      expect(forward.messages.map((message: any) => message.text)).toEqual([
        ...Array.from({ length: PAGE }, (_, index) => `codex row ${200 + index}`),
        ...Array.from({ length: 30 }, (_, index) => `codex appended ${index}`),
      ]);
      expect(forward.cursor).toBe(refresh.endCursor);
      expect(forward.endOfHistory).toBe(true);
      expect(sessionReads(broker, 'codex', rollout.id, 'refresh')).toBe(0);
      expect(sessionReads(broker, 'codex', rollout.id, 'attach')).toBe(0);
      expect(sessionReads(broker, 'codex', rollout.id, 'page-cache-miss')).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  });
});
