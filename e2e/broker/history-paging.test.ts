/**
 * The history window, read backward: a client attaches with a capped
 * `initialHistory`, pages older rows from the boundaries the broker names, and
 * keeps those boundaries valid while the session grows, is rewritten, or the
 * broker restarts.
 *
 * Sessions come from the Pi bridge (a scripted session whose whole transcript
 * the extension relays), so every row is known. The broker's native-read
 * ledger (`COSYNCING_TEST_HISTORY_READ_LOG`) shows that paging is served from
 * one snapshot per attach and never re-reads the session per page.
 *
 * What a client relies on (protocol revision 28): the boundaries a frame or
 * page names count transcript rows only; a walk from them returns every row
 * exactly once, in order; a boundary the broker cannot serve is never offered;
 * a refused page says why with a stable code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { type Broker, type SessionStream, startBroker } from '../harness/index.ts';
import { ask, attachFrame, historyReadLedgerEnv, sessionReads } from '../harness/history.ts';
import { openPiBridgeSession, piFinalRows, piUserRows, type PiBridgeSession } from '../harness/fakes/pi-bridge.ts';

const ROWS = 2_500;
const PAGE = 100;

/** A unified diff of `lines` added lines: far past the 32 KiB inline cap. */
function lockfileDiff(lines = 30_000): string {
  return [
    'diff --git a/bun.lock b/bun.lock',
    '--- a/bun.lock',
    '+++ b/bun.lock',
    `@@ -1,1 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+dependency-${index} 1.0.${index}`),
  ].join('\n');
}

const keys = (messages: any[]): string[] => messages.map((message) => String(message.key));

describe('a long session pages back to its true start', () => {
  let broker: Broker;
  let session: PiBridgeSession;
  let reads: () => number;
  const streams: SessionStream[] = [];
  const attach = async (options: { initialHistory?: number; artifactMode?: string; params?: Record<string, string> } = {}) => {
    const stream = await broker.client().attach('pi', session.id, { artifactMode: 'reference', ...options });
    streams.push(stream);
    return { stream, frame: await attachFrame(stream) };
  };
  // Boundaries the tests below hand to each other, in file order.
  let first: { stream: SessionStream; frame: any };
  let firstInline: { stream: SessionStream; frame: any };
  let midCursor: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'history-paging',
      // An attach without `initialHistory` gets the broker maximum: high enough here to be the whole session.
      env: (paths) => ({ COSYNCING_HISTORY_MAX_MESSAGES: '5000', ...historyReadLedgerEnv(paths) }),
    });
    session = await openPiBridgeSession(broker, piUserRows('original', ROWS));
    reads = () => sessionReads(broker, 'pi', session.id);
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
  });

  test('a capped attach carries only the newest rows and names both boundaries', async () => {
    first = await attach({ initialHistory: PAGE });
    const frame = first.frame;
    expect(frame.reset).toBe(true);
    expect(frame.messages).toHaveLength(PAGE);
    expect(frame.messages[0].text).toBe('original row 2400');
    expect(frame.messages.at(-1).text).toBe('original row 2499');
    expect(frame.truncated).toEqual({ shown: PAGE, total: ROWS });
    expect(frame.hasEarlier).toBe(true);
    expect(typeof frame.olderCursor).toBe('string');
    expect(typeof frame.endCursor).toBe('string');
    expect(frame.newerHistory).toBe(true);
    // An inline socket is its own artifact scope; each scope reads the session once to attach.
    firstInline = await attach({ initialHistory: PAGE, artifactMode: 'inline' });
    expect(keys(firstInline.frame.messages)).toEqual(keys(frame.messages));
    expect(reads()).toBe(2);
  });

  test('a malformed or oversized initialHistory falls back to the broker maximum', async () => {
    for (const initialHistory of ['abc', '0', '-5', '2.5', '9999999']) {
      const { stream, frame } = await attach({ params: { initialHistory } });
      expect(frame.messages).toHaveLength(ROWS);
      expect(frame.truncated).toBeUndefined();
      expect(frame.hasEarlier).not.toBe(true);
      stream.close();
    }
  });

  test('the end boundary reloads exactly the attach rows and lands on its older boundary', async () => {
    const before = reads();
    const end = await ask(first.stream, { kind: 'history-page', cursor: first.frame.endCursor, limit: PAGE });
    expect(end.kind).toBe('history-page');
    expect(keys(end.messages)).toEqual(keys(first.frame.messages));
    expect(end.cursor).toBe(first.frame.olderCursor);
    expect(reads()).toBe(before);
  });

  test('backward pages walk to the true start once, in order, from the attach snapshot', async () => {
    const before = reads();
    const pages: any[][] = [];
    let cursor: string | undefined = first.frame.olderCursor;
    for (let guard = 0; cursor && guard < 40; guard += 1) {
      const page = await ask(first.stream, { kind: 'history-page', cursor, limit: PAGE });
      expect(page.kind).toBe('history-page');
      expect(page.messages.length).toBeLessThanOrEqual(PAGE);
      expect(JSON.stringify(page).length).toBeLessThan(128 * 1024);
      if (pages.length === 0) midCursor = page.cursor;
      pages.unshift(page.messages);
      if (page.endOfHistory) {
        expect(page.hasMore).toBe(false);
        expect(page.cursor).toBeUndefined();
        cursor = undefined;
      } else {
        expect(page.hasMore).toBe(true);
        cursor = page.cursor;
      }
    }
    expect(cursor).toBeUndefined();
    const walked = [...pages.flat(), ...first.frame.messages];
    expect(keys(walked)).toEqual(Array.from({ length: ROWS }, (_, index) => `original-${index}`));
    expect(reads()).toBe(before);
  });

  test('live appends keep issued boundaries valid; one current snapshot serves old and new ones', async () => {
    await session.events([
      { t: 'delta', key: 'live-append', delta: 'live append during paging' },
      { t: 'final', key: 'live-append', text: 'live append during paging' },
      ...piFinalRows('later', PAGE),
    ]);
    await first.stream.waitForMessage((message) => message.key === 'live-append');
    const before = reads();
    const newer = await attach({ initialHistory: PAGE });
    expect(newer.frame.truncated?.total).toBe(ROWS + 101);
    expect(newer.frame.messages.at(-1).key).toBe('later-99');
    // The newer attach read the grown session once and replaced the snapshot it grew from.
    expect(reads()).toBe(before + 1);
    const fromNewer = await ask(newer.stream, { kind: 'history-page', cursor: newer.frame.olderCursor, limit: PAGE });
    expect(fromNewer.kind).toBe('history-page');
    expect(fromNewer.messages).toHaveLength(PAGE);
    const fromOld = await ask(first.stream, { kind: 'history-page', cursor: first.frame.olderCursor, limit: PAGE });
    expect(fromOld.kind).toBe('history-page');
    expect(keys(fromOld.messages)).toEqual(Array.from({ length: PAGE }, (_, index) => `original-${2300 + index}`));
    expect(reads()).toBe(before + 1);
    // The inline scope still holds the snapshot the append grew from: a boundary past it
    // builds the current one once, and the next page reuses it.
    const retry = await ask(firstInline.stream, { kind: 'history-page', cursor: newer.frame.olderCursor, limit: PAGE });
    expect(retry.kind).toBe('history-page');
    expect(keys(retry.messages)).toEqual(keys(fromNewer.messages));
    expect(reads()).toBe(before + 2);
    const next = await ask(firstInline.stream, { kind: 'history-page', cursor: retry.cursor, limit: PAGE });
    expect(next.kind).toBe('history-page');
    expect(reads()).toBe(before + 2);
  });

  test('a full attach reads the session itself and leaves the paging snapshot in place', async () => {
    const before = reads();
    const full = await attach();
    expect(full.frame.messages).toHaveLength(ROWS + 101);
    expect(full.frame.truncated).toBeUndefined();
    expect(typeof full.frame.endCursor).toBe('string');
    expect(reads()).toBe(before + 1);
    const mid = await ask(full.stream, { kind: 'history-page', cursor: midCursor, limit: PAGE });
    expect(mid.kind).toBe('history-page');
    expect(mid.messages).toHaveLength(PAGE);
    const end = await ask(full.stream, { kind: 'history-page', cursor: full.frame.endCursor, limit: PAGE });
    expect(end.kind).toBe('history-page');
    expect(end.messages.at(-1).key).toBe('later-99');
    expect(reads()).toBe(before + 1);
  });

  test('a rewritten transcript refuses boundaries into the old one as diverged', async () => {
    for (const stream of streams) stream.close();
    await session.bye();
    await session.rehello(piUserRows('rewritten', ROWS));
    const before = reads();
    const rewritten = await attach({ initialHistory: PAGE });
    expect(rewritten.frame.messages[0].text).toBe('rewritten row 2400');
    const stale = await ask(rewritten.stream, { kind: 'history-page', cursor: midCursor, limit: PAGE });
    expect(stale.kind).toBe('nack');
    expect(stale.code).toBe('HISTORY_CURSOR_DIVERGED');
    expect(reads()).toBe(before + 1);
  });

  test('a reference-mode attach is bounded by what it receives, not by a diff it gets as a reference', async () => {
    const diff = lockfileDiff();
    const diffSession = await openPiBridgeSession(broker, Array.from({ length: PAGE }, (_, index) => (
      index === 60
        ? { t: 'tool-result', callId: 'lockfile', name: 'edit', args: { path: 'bun.lock' }, details: { diff }, result: 'Edited bun.lock' }
        : { t: 'user', key: `diff-${index}`, text: `diff fixture row ${index}` }
    )));
    const reference = await broker.client().attach('pi', diffSession.id, { artifactMode: 'reference', initialHistory: PAGE });
    streams.push(reference);
    const referenceFrame = await attachFrame(reference);
    expect(referenceFrame.messages).toHaveLength(PAGE);
    const referenced = referenceFrame.messages.find((message: any) => message.type === 'tool-result');
    expect(typeof referenced?.diffRef?.fetchUrl).toBe('string');
    expect(referenced?.diff).toBeUndefined();
    // An inline socket receives the diff whole, so its frame ends right after the rows it fits.
    const inline = await broker.client().attach('pi', diffSession.id, { artifactMode: 'inline', initialHistory: PAGE });
    streams.push(inline);
    const inlineFrame = await attachFrame(inline);
    expect(inlineFrame.messages).toHaveLength(PAGE - 61);
    expect(inlineFrame.messages[0].text).toBe('diff fixture row 61');
    expect(inlineFrame.truncated).toEqual({ shown: PAGE - 61, total: PAGE });
    const before = await ask(inline, { kind: 'history-page', cursor: inlineFrame.olderCursor, limit: 1 });
    expect(before.messages[0].type).toBe('tool-result');
  });

  test('a reconnect from far behind becomes a capped replacement of the newest rows', async () => {
    const growing = await openPiBridgeSession(broker, piUserRows('far', 10));
    const early = await broker.client().attach('pi', growing.id, { artifactMode: 'reference', initialHistory: PAGE });
    const earlyFrame = await attachFrame(early);
    early.close();
    await growing.events(piUserRows('far', 1_990, 10));
    const back = await broker.client().attach('pi', growing.id, {
      artifactMode: 'reference', initialHistory: PAGE, since: earlyFrame.cursor,
    });
    streams.push(back);
    const frame = await attachFrame(back);
    // The cursor is valid, but 1,990 new rows are more than a client may be asked to render.
    expect(frame.reset).toBe(true);
    expect(keys(frame.messages)).toEqual(Array.from({ length: PAGE }, (_, index) => `far-${1_900 + index}`));
    expect(frame.truncated).toEqual({ shown: PAGE, total: 2_000 });
    expect(typeof frame.olderCursor).toBe('string');
  });

  test('a session past the paging cache never names an end boundary, and refuses pages as a resource limit', async () => {
    const big = await openPiBridgeSession(broker, [{ t: 'user', key: 'over-start', text: 'o-start' }]);
    const grow = (chunk: number, length: number) => big.events(
      Array.from({ length }, (_, index) => ({ t: 'final', key: `over-${chunk}-${index}`, text: `o${chunk}-${index}` })),
    );
    for (let chunk = 0; chunk < 9; chunk += 1) await grow(chunk, 5_000);
    await grow(9, 4_000);
    const bigReads = (kind: string) => sessionReads(broker, 'pi', big.id, kind);
    // It fits the cache when it attaches, so its frame is refreshable...
    const early = await broker.client().attach('pi', big.id, { artifactMode: 'reference', initialHistory: PAGE });
    streams.push(early);
    const earlyFrame = await attachFrame(early);
    expect(earlyFrame.truncated?.total).toBe(49_001);
    expect(earlyFrame.newerHistory).toBe(true);
    // ...then outgrows it. The refresh reads the grown session once, refuses, and is not re-read.
    await grow(10, 1_000);
    const outgrown = await ask(early, { kind: 'history-refresh', cursor: earlyFrame.cursor });
    expect(outgrown.kind).toBe('nack');
    expect(outgrown.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(bigReads('refresh')).toBe(1);
    const again = await ask(early, { kind: 'history-refresh', cursor: earlyFrame.cursor });
    expect(again.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(bigReads('refresh')).toBe(1);
    early.close();

    const late = await broker.client().attach('pi', big.id, { artifactMode: 'reference', initialHistory: PAGE });
    streams.push(late);
    const lateFrame = await attachFrame(late);
    expect(lateFrame.messages).toHaveLength(PAGE);
    expect(lateFrame.truncated?.total).toBe(50_001);
    expect(typeof lateFrame.olderCursor).toBe('string');
    expect('endCursor' in lateFrame).toBe(false);
    expect('newerHistory' in lateFrame).toBe(false);
    const page = await ask(late, { kind: 'history-page', cursor: lateFrame.olderCursor, limit: PAGE });
    expect(page.kind).toBe('nack');
    expect(page.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    const refresh = await ask(late, { kind: 'history-refresh', cursor: lateFrame.cursor });
    expect(refresh.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(bigReads('refresh')).toBe(1);
  });

  // Last: it restarts the broker.
  test('a restarted broker starts with no snapshot: the first attach reads the session once', async () => {
    for (const stream of streams) stream.close();
    await broker.restart();
    // Bridge sessions live in the extension; it says hello again after a broker restart.
    const restarted = await openPiBridgeSession(broker, piUserRows('restarted', ROWS), { sessionFile: session.sessionFile });
    expect(restarted.id).toBe(session.id);
    const before = reads();
    const { stream, frame } = await attach({ initialHistory: PAGE });
    expect(frame.messages[0].text).toBe('restarted row 2400');
    const page = await ask(stream, { kind: 'history-page', cursor: frame.olderCursor, limit: PAGE });
    expect(page.kind).toBe('history-page');
    expect(keys(page.messages)).toEqual(Array.from({ length: PAGE }, (_, index) => `restarted-${2300 + index}`));
    expect(reads()).toBe(before + 1);
  });
});

describe('a byte budget measures rows without storing them', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'history-budget', env: { COSYNCING_HISTORY_MAX_DECODED_BYTES: '3000' } });
  });
  afterAll(() => broker?.stop());

  test('a diff row measured and cut by the budget leaves no artifact behind', async () => {
    const session = await openPiBridgeSession(broker, [
      { t: 'user', key: 'measure-first', text: 'first' },
      {
        t: 'tool-result',
        callId: 'measured-lockfile',
        name: 'edit',
        args: { path: 'bun.lock', note: 'n'.repeat(4_000) },
        details: { diff: lockfileDiff() },
        result: 'r'.repeat(4_000),
      },
      { t: 'user', key: 'measure-newest', text: 'newest' },
    ]);
    const stream = await broker.client().attach('pi', session.id, { artifactMode: 'reference', initialHistory: PAGE });
    const frame = await attachFrame(stream);
    expect(frame.messages.map((message: any) => message.text)).toEqual(['newest']);
    expect(frame.truncated).toEqual({ shown: 1, total: 3 });
    const blobs = readdirSync(broker.paths.root, { recursive: true })
      .map(String)
      .filter((entry) => /artifacts[\\/]blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/.test(entry));
    expect(blobs).toEqual([]);
    stream.close();
  });
});
