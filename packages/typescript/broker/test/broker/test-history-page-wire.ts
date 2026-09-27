#!/usr/bin/env bun
/**
 * H1 real-broker/WebSocket acceptance.
 *
 * A 2,500-message Pi bridge fixture pages to the true beginning while the
 * broker's opt-in native-read metric proves that history is parsed only for an
 * attach, never once per page. The same socket run covers 101-message
 * append-only growth, two truncated clients, exact-snapshot replacement,
 * append-ancestor retry, end-of-history, an untruncated attach, source
 * rewrite, and broker restart.
 */
import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';

const FIXTURE_MESSAGES = 2_500;
const PAGE_MESSAGES = 100;
const WAIT_MS = 15_000;
let waitLabel = 'broker state';

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${waitLabel}`);
}

type RunningBroker = {
  child: ReturnType<typeof Bun.spawn>;
  base: string;
  wsBase: string;
  stderr: () => string;
};

async function startBroker(
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<RunningBroker> {
  let stderr = '';
  let drained: Promise<void> = Promise.resolve();
  // Readiness is not one of this suite's assertions, so it does not get this
  // suite's 15s budget: a broker booting beside other suites is slow, not
  // broken. Every wait after this keeps WAIT_MS, because those are the
  // behaviour under test.
  //
  // Through the shared starter, so a lost port race or a silent startup stall
  // costs a respawn rather than the suite. This suite drains the stream itself,
  // so its own accumulator is handed back as the silence evidence rather than a
  // second reader competing for the same pipe; it resets per attempt.
  let child!: ReturnType<typeof Bun.spawn>;
  let port!: number;
  try {
    ({ child, port } = await startHealthyFixtureBroker({
      spawn: (attemptPort) => {
        stderr = '';
        const spawned = Bun.spawn(
          ['bun', 'run', 'packages/typescript/broker/src/main.ts'],
          {
            env: isolatedBrokerFixtureEnvironment(home, {
              overrides: {
                PORT: String(attemptPort),
                HOST: '127.0.0.1',
                COSYNCING_HOME: home,
                COSYNCING_TOKEN: '',
                COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
                COSYNCING_HISTORY_MAX_MESSAGES: '5000',
                COSYNCING_TEST_HISTORY_READ_METRICS: '1',
                ...extraEnv,
              },
            }),
            stdout: 'ignore',
            stderr: 'pipe',
          },
        );
        drained = (async () => {
          const reader = spawned.stderr.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stderr += new TextDecoder().decode(value);
          }
        })();
        return spawned;
      },
      healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
      // This suite accumulates stderr itself (it asserts over the whole log
      // later), so it supplies the two readers directly rather than a capture:
      // an immediate snapshot for silence, and the same text once the drain
      // has reached EOF for collision classification.
      peekOutput: () => stderr,
      readSettledOutput: async () => {
        await Promise.race([drained, Bun.sleep(2_000)]);
        return stderr;
      },
      // A rejected child never reaches the caller, so it cannot clean it up. A
      // broker that is merely slow, not dead, would otherwise outlive the suite
      // and be reaped by the lane as a stray.
      stop: async (spawned) => { spawned.kill(); await spawned.exited.catch(() => undefined); },
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${stderr.slice(-2_000)}`);
  }
  const base = `http://127.0.0.1:${port}`;
  return {
    child,
    base,
    wsBase: base.replace(/^http/, 'ws'),
    stderr: () => stderr,
  };
}

function historyFixture(prefix: string): Array<Record<string, unknown>> {
  return Array.from({ length: FIXTURE_MESSAGES }, (_, index) => ({
    t: 'user',
    key: `${prefix}-${index}`,
    text: `${prefix} deterministic row ${index}`,
  }));
}

async function bridgeHello(
  base: string,
  sessionFile: string,
  history: Array<Record<string, unknown>>,
): Promise<string> {
  const response = await fetch(`${base}/pi/bridge/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionFile,
      cwd: '/tmp',
      title: 'H1 wire paging',
      history,
    }),
  });
  assert.equal(response.status, 200);
  return String((await response.json() as { id: string }).id);
}

async function bridgeEvents(
  base: string,
  id: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const response = await fetch(`${base}/pi/bridge/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, events }),
  });
  assert.equal(response.status, 200);
}

async function bridgeBye(base: string, id: string): Promise<void> {
  const response = await fetch(`${base}/pi/bridge/bye`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, reason: 'rewrite fixture' }),
  });
  assert.equal(response.status, 200);
}

type SocketClient = {
  ws: WebSocket;
  frames: any[];
  attach: any;
};

async function openClient(
  wsBase: string,
  id: string,
  initialHistory?: number,
  artifactMode = 'reference',
): Promise<SocketClient> {
  const params = new URLSearchParams({
    artifactMode,
    contractRevision: '5',
    minimumBrokerRevision: '2',
  });
  if (initialHistory !== undefined) {
    params.set('initialHistory', `${initialHistory}`);
  }
  const frames: any[] = [];
  const ws = new WebSocket(
    `${wsBase}/api/sessions/pi/${encodeURIComponent(id)}/stream?${params}`,
  );
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      // Malformed frames are asserted by the timeout below.
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  waitLabel = 'initial history frame';
  const attach = await waitFor(() =>
    frames.find((frame) => frame.kind === 'history'));
  return { ws, frames, attach };
}

function nativeReads(broker: RunningBroker): number {
  return broker.stderr().split('\n')
    .filter((line) => line.includes('[h1-history-read]')).length;
}

async function requestPage(
  client: SocketClient,
  cursor: string,
  requestId: string,
): Promise<any> {
  client.ws.send(JSON.stringify({
    kind: 'history-page',
    cursor,
    limit: PAGE_MESSAGES,
    clientMessageId: requestId,
  }));
  waitLabel = `history page ${requestId}`;
  return waitFor(() =>
    client.frames.find((frame) =>
      frame.clientMessageId === requestId
      && (frame.kind === 'history-page' || frame.kind === 'nack')));
}

/** Revision 28: one request answered by the frame (or nack) naming its clientMessageId. */
async function requestAnswer(
  client: SocketClient,
  request: Record<string, unknown>,
  requestId: string,
  answerKind: 'history' | 'history-page',
): Promise<any> {
  client.ws.send(JSON.stringify({ ...request, clientMessageId: requestId }));
  waitLabel = `${String(request.kind)} ${requestId}`;
  return waitFor(() =>
    client.frames.find((frame) =>
      frame.clientMessageId === requestId
      && (frame.kind === answerKind || frame.kind === 'nack')));
}

const home = mkdtempSync('/tmp/cosyncing-h1-wire-');
const sessionFile = `/tmp/cosyncing-h1-wire-${process.pid}.jsonl`;
let broker = await startBroker(home);
const clients: WebSocket[] = [];
try {
  const id = await bridgeHello(
    broker.base,
    sessionFile,
    historyFixture('original'),
  );
  const first = await openClient(broker.wsBase, id, PAGE_MESSAGES);
  clients.push(first.ws);
  const firstInline = await openClient(
    broker.wsBase,
    id,
    PAGE_MESSAGES,
    'inline',
  );
  clients.push(firstInline.ws);
  assert.equal(first.attach.messages.length, PAGE_MESSAGES);
  assert.equal(first.attach.messages[0].text, 'original deterministic row 2400');
  assert.equal(first.attach.truncated?.total, FIXTURE_MESSAGES);
  assert.equal(
    nativeReads(broker),
    2,
    'each artifact-mode scope must parse its initial native snapshot once',
  );
  // The attach names the boundary after its newest row in the paging encoding, so a bounded
  // client that releases the attach rows can reload exactly them and reconnect by cursor
  // equality with the attach's own older boundary.
  assert.equal(typeof first.attach.endCursor, 'string', 'the attach carries its end boundary');
  const endPage = await requestPage(first, String(first.attach.endCursor), 'attach-end-cursor');
  assert.equal(endPage.kind, 'history-page');
  assert.equal(endPage.messages.length, PAGE_MESSAGES);
  assert.equal(endPage.messages[0].text, 'original deterministic row 2400');
  assert.equal(endPage.messages.at(-1).text, 'original deterministic row 2499');
  assert.equal(endPage.cursor, first.attach.olderCursor);
  assert.equal(nativeReads(broker), 2, 'paging from the end boundary reuses the attach snapshot');

  await bridgeEvents(broker.base, id, [
    {
      t: 'delta',
      key: 'live-append',
      delta: 'live append during paging',
    },
    { t: 'final', key: 'live-append', text: 'live append during paging' },
    ...Array.from({ length: PAGE_MESSAGES }, (_, index) => ({
      t: 'final',
      key: `later-${index}`,
      text: `later deterministic row ${index}`,
    })),
  ]);
  waitLabel = 'live append frame';
  await waitFor(() =>
    first.frames.find((frame) =>
      frame.kind === 'message' && frame.message?.key === 'live-append'));

  let cursor = String(first.attach.olderCursor);
  let midCursor = cursor;
  const newer = await openClient(broker.wsBase, id, PAGE_MESSAGES);
  clients.push(newer.ws);
  assert.equal(newer.attach.messages.length, PAGE_MESSAGES);
  assert.equal(newer.attach.truncated?.total, FIXTURE_MESSAGES + 101);
  assert.equal(
    nativeReads(broker),
    3,
    'newer truncated attach reads current history and replaces its append ancestor',
  );

  const newerCursor = String(newer.attach.olderCursor);
  const newerPage = await requestPage(newer, newerCursor, 'newer-cursor');
  assert.equal(newerPage.kind, 'history-page');
  assert.equal(newerPage.messages.length, PAGE_MESSAGES);
  const oldPrefixPage = await requestPage(first, cursor, 'old-prefix-cursor');
  assert.equal(oldPrefixPage.kind, 'history-page');
  assert.equal(oldPrefixPage.messages.length, PAGE_MESSAGES);
  assert.equal(
    nativeReads(broker),
    3,
    'one current snapshot must validate both the old and new truncated cursors',
  );

  const ancestorRetry = await requestPage(
    firstInline,
    newerCursor,
    'append-ancestor-retry',
  );
  assert.equal(ancestorRetry.kind, 'history-page');
  assert.equal(ancestorRetry.messages.length, PAGE_MESSAGES);
  assert.equal(
    nativeReads(broker),
    4,
    'a cursor beyond an append ancestor builds the current snapshot exactly once',
  );
  const ancestorNext = await requestPage(
    firstInline,
    String(ancestorRetry.cursor),
    'append-ancestor-next',
  );
  assert.equal(ancestorNext.kind, 'history-page');
  assert.equal(
    nativeReads(broker),
    4,
    'subsequent pages reuse the refreshed exact snapshot',
  );

  let received = 0;
  for (let pageIndex = 0; pageIndex < 24; pageIndex += 1) {
    const page = await requestPage(first, cursor, `page-${pageIndex}`);
    assert.equal(page.kind, 'history-page');
    assert.ok(page.messages.length <= PAGE_MESSAGES);
    assert.ok(JSON.stringify(page).length < 128 * 1024);
    received += page.messages.length;
    if (pageIndex === 0) midCursor = String(page.cursor);
    if (pageIndex === 23) {
      assert.equal(page.endOfHistory, true);
      assert.equal(page.hasMore, false);
      assert.equal(page.cursor, undefined);
    } else {
      assert.equal(page.hasMore, true);
      cursor = String(page.cursor);
    }
  }
  assert.equal(received, FIXTURE_MESSAGES - PAGE_MESSAGES);
  assert.equal(
    nativeReads(broker),
    4,
    '24 pages and 101 live appends must reuse the upgraded snapshot',
  );

  const second = await openClient(broker.wsBase, id);
  clients.push(second.ws);
  assert.equal(second.attach.messages.length, FIXTURE_MESSAGES + 101);
  assert.equal(nativeReads(broker), 5, 'the full attach performs its own current read');
  const afterFullAttach = await requestPage(second, midCursor, 'after-full-attach');
  assert.equal(afterFullAttach.kind, 'history-page');
  assert.equal(afterFullAttach.messages.length, PAGE_MESSAGES);
  assert.equal(
    nativeReads(broker),
    5,
    'end-of-history and another full attach must not evict the paging snapshot',
  );
  assert.equal(typeof second.attach.endCursor, 'string', 'an untruncated attach carries its end');
  const fullEndPage = await requestPage(second, String(second.attach.endCursor), 'full-end-cursor');
  assert.equal(fullEndPage.kind, 'history-page');
  assert.equal(fullEndPage.messages.length, PAGE_MESSAGES);
  assert.equal(fullEndPage.messages.at(-1).text, 'later deterministic row 99');

  first.ws.close();
  firstInline.ws.close();
  newer.ws.close();
  second.ws.close();
  await bridgeBye(broker.base, id);
  await Bun.sleep(100);
  const rewrittenId = await bridgeHello(
    broker.base,
    sessionFile,
    historyFixture('rewritten'),
  );
  assert.equal(rewrittenId, id);
  const rewritten = await openClient(
    broker.wsBase,
    rewrittenId,
    PAGE_MESSAGES,
  );
  clients.push(rewritten.ws);
  const stale = await requestPage(rewritten, midCursor, 'stale-after-rewrite');
  assert.equal(stale.kind, 'nack');
  assert.equal(stale.code, 'HISTORY_CURSOR_DIVERGED');
  assert.equal(nativeReads(broker), 6, 'source rewrite builds one new snapshot');
  rewritten.ws.close();

  broker.child.kill();
  await broker.child.exited;
  broker = await startBroker(home);
  const restartedId = await bridgeHello(
    broker.base,
    sessionFile,
    historyFixture('restarted'),
  );
  const restarted = await openClient(
    broker.wsBase,
    restartedId,
    PAGE_MESSAGES,
  );
  clients.push(restarted.ws);
  const restartPage = await requestPage(
    restarted,
    String(restarted.attach.olderCursor),
    'after-restart',
  );
  assert.equal(restartPage.kind, 'history-page');
  assert.equal(nativeReads(broker), 1, 'restart begins with an empty cache and one attach read');
  restarted.ws.close();

  // Lane H1d: the attach frame's decoded-size bound is measured on the shape THIS socket
  // receives. A reference-mode socket gets an oversized diff as a small `diffRef`, so its frame
  // must not be cut at that row; an inline socket receives the diff whole and its frame is bounded
  // by it.
  const lockfile = [
    'diff --git a/bun.lock b/bun.lock',
    '--- a/bun.lock',
    '+++ b/bun.lock',
    '@@ -1,1 +1,30000 @@',
    ...Array.from({ length: 30_000 }, (_, index) => `+dependency-${index} 1.0.${index}`),
  ].join('\n');
  const diffHistory: Array<Record<string, unknown>> = Array.from({ length: PAGE_MESSAGES }, (_, index) => (
    index === 60
      ? {
        t: 'tool-result',
        callId: 'lockfile',
        name: 'edit',
        args: { path: 'bun.lock' },
        details: { diff: lockfile },
        result: 'Edited bun.lock',
      }
      : { t: 'user', key: `diff-${index}`, text: `diff fixture row ${index}` }
  ));
  const diffId = await bridgeHello(broker.base, `${sessionFile}.diff`, diffHistory);
  const referenceAttach = await openClient(broker.wsBase, diffId, PAGE_MESSAGES, 'reference');
  clients.push(referenceAttach.ws);
  const referenced = referenceAttach.attach.messages.find((message: any) => message.type === 'tool-result');
  assert.equal(
    referenceAttach.attach.messages.length,
    PAGE_MESSAGES,
    'a reference-mode attach is not cut at a diff it receives as a reference',
  );
  assert.equal(typeof referenced?.diffRef?.fetchUrl, 'string', 'the diff arrives as a reference');
  assert.equal(referenced?.diff, undefined, 'the reference-mode row carries no inline diff');
  const inlineAttach = await openClient(broker.wsBase, diffId, PAGE_MESSAGES, 'inline');
  clients.push(inlineAttach.ws);
  assert.equal(
    inlineAttach.attach.messages.length,
    PAGE_MESSAGES - 61,
    'an inline attach receives the diff whole, so its frame is bounded by it',
  );
  assert.equal(inlineAttach.attach.messages[0].text, 'diff fixture row 61');
  referenceAttach.ws.close();
  inlineAttach.ws.close();

  // Lane H1d: an end boundary is permission for the client to release the frame's rows, so it is
  // withheld when the paging route cannot serve this source. A history over the paging cache's
  // message cap attaches with its newest rows and an older boundary, but no end boundary, and the
  // page request is refused as a resource limit.
  const oversizedId = await bridgeHello(broker.base, `${sessionFile}.oversized`, [
    { t: 'user', key: 'over-start', text: 'o-start' },
  ]);
  // Grown through the ordinary append path, in bodies the bridge accepts.
  const growOversized = async (chunk: number, length: number) => bridgeEvents(
    broker.base,
    oversizedId,
    Array.from({ length }, (_, index) => ({
      t: 'final',
      key: `over-${chunk}-${index}`,
      text: `o${chunk}-${index}`,
    })),
  );
  for (let chunk = 0; chunk < 9; chunk += 1) await growOversized(chunk, 5_000);
  await growOversized(9, 4_000);
  // Revision 28: a session that fit the paging cache when it attached can outgrow it. A refresh
  // then reads the grown history, finds it past the cache, and refuses rather than naming an end
  // boundary no page request could serve; the socket remembers, and later refreshes are refused
  // without reading it again.
  const oversizedRefreshReads = () => broker.stderr().split('\n')
    .filter((line) => line.includes(`[h1-history-read] refresh pi:${oversizedId}`)).length;
  const early = await openClient(broker.wsBase, oversizedId, PAGE_MESSAGES);
  clients.push(early.ws);
  assert.equal(early.attach.truncated?.total, 49_001);
  assert.equal(early.attach.newerHistory, true, 'a history that fits the paging cache is refreshable');
  await growOversized(10, 1_000);
  const outgrown = await requestAnswer(
    early,
    { kind: 'history-refresh', cursor: early.attach.cursor },
    'outgrown-refresh',
    'history',
  );
  assert.equal(outgrown.kind, 'nack');
  assert.equal(
    outgrown.code,
    'HISTORY_PAGE_RESOURCE_LIMIT',
    'a refresh never names a boundary the paging route cannot serve',
  );
  assert.equal(oversizedRefreshReads(), 1, 'the refusal is decided by reading the grown history');
  const outgrownAgain = await requestAnswer(
    early,
    { kind: 'history-refresh', cursor: early.attach.cursor },
    'outgrown-refresh-again',
    'history',
  );
  assert.equal(outgrownAgain.code, 'HISTORY_PAGE_RESOURCE_LIMIT');
  assert.equal(oversizedRefreshReads(), 1, 'a refused source is not read again for a refresh');
  early.ws.close();

  const oversized = await openClient(broker.wsBase, oversizedId, PAGE_MESSAGES);
  clients.push(oversized.ws);
  assert.equal(oversized.attach.messages.length, PAGE_MESSAGES);
  assert.equal(oversized.attach.truncated?.total, 50_001);
  assert.equal(
    'endCursor' in oversized.attach,
    false,
    'a history the paging cache refuses attaches without an end boundary',
  );
  assert.equal(
    'newerHistory' in oversized.attach,
    false,
    'refresh and newer paging are offered exactly where the end boundary is',
  );
  const refusedPage = await requestPage(
    oversized,
    String(oversized.attach.olderCursor),
    'oversized-older-page',
  );
  assert.equal(refusedPage.kind, 'nack');
  assert.equal(refusedPage.code, 'HISTORY_PAGE_RESOURCE_LIMIT');
  const refusedRefresh = await requestAnswer(
    oversized,
    { kind: 'history-refresh', cursor: oversized.attach.cursor },
    'oversized-refresh',
    'history',
  );
  assert.equal(refusedRefresh.code, 'HISTORY_PAGE_RESOURCE_LIMIT');
  assert.equal(oversizedRefreshReads(), 1, 'an attach that refused paging is not read again for a refresh');
  oversized.ws.close();

  // Revision 28: refreshing boundaries for rows received live, and walking forward from a boundary,
  // on the same socket, through the real broker and the Pi bridge's own persistence (a streamed
  // reply reaches history only as its final row, which is never sent live).
  const refreshId = await bridgeHello(
    broker.base,
    `${sessionFile}.refresh`,
    Array.from({ length: 300 }, (_, index) => ({ t: 'user', key: `r-${index}`, text: `refresh row ${index}` })),
  );
  const reader = await openClient(broker.wsBase, refreshId, PAGE_MESSAGES);
  clients.push(reader.ws);
  const refreshReads = () => broker.stderr().split('\n')
    .filter((line) => line.includes(`[h1-history-read] refresh pi:${refreshId}`)).length;
  const refreshPageMisses = () => broker.stderr().split('\n')
    .filter((line) => line.includes(`[h1-history-read] page-cache-miss pi:${refreshId}`)).length;
  assert.equal(reader.attach.newerHistory, true, 'a pageable attach offers refresh and newer paging');
  assert.equal(typeof reader.attach.endCursor, 'string');
  await bridgeEvents(broker.base, refreshId, [
    { t: 'status', running: true },
    ...Array.from({ length: 150 }, (_, index) => ({ t: 'user', key: `rl-${index}`, text: `refresh live row ${index}` })),
    { t: 'delta', key: 'reply', delta: 'streamed reply' },
    { t: 'final', key: 'reply', text: 'streamed reply' },
  ]);
  waitLabel = 'refresh live rows';
  await waitFor(() => reader.frames.find((frame) => frame.kind === 'message' && frame.message?.key === 'reply'));
  const refreshOne = await requestAnswer(
    reader,
    { kind: 'history-refresh', cursor: reader.attach.cursor },
    'refresh-one',
    'history',
  );
  assert.equal(refreshOne.kind, 'history', JSON.stringify(refreshOne).slice(0, 300));
  assert.equal(refreshOne.reset, false, 'a refresh never replaces the window');
  assert.equal(refreshOne.newerHistory, true);
  assert.equal(refreshOne.messages.length, PAGE_MESSAGES, 'a refresh is bounded');
  assert.equal(refreshOne.messages[0].key, 'rl-0', 'a refresh starts right after the last frame');
  assert.equal(refreshOne.truncated, undefined, 'a refresh prefix is not a truncation');
  assert.equal(refreshReads(), 1, 'a refresh of a grown source reads it once');
  const refreshTwo = await requestAnswer(
    reader,
    { kind: 'history-refresh', cursor: refreshOne.cursor, limit: 500 },
    'refresh-two',
    'history',
  );
  assert.equal(refreshTwo.kind, 'history');
  assert.deepEqual(
    refreshTwo.messages.map((message: any) => message.key),
    Array.from({ length: 50 }, (_, index) => `rl-${index + 100}`),
    'while the turn runs the persisted reply that is still the newest row is held back',
  );
  assert.equal(refreshReads(), 1, 'a refresh of an unchanged source reuses the snapshot the last one read');
  const pagedBack = await requestPage(reader, String(refreshTwo.endCursor), 'refresh-end-page');
  assert.equal(pagedBack.kind, 'history-page');
  assert.deepEqual(
    [pagedBack.messages[0].key, pagedBack.messages.at(-1).key],
    ['rl-50', 'rl-149'],
    'the refresh endCursor pages back exactly the rows before it',
  );
  await bridgeEvents(broker.base, refreshId, [{ t: 'status', running: false }]);
  waitLabel = 'turn end';
  await waitFor(() => reader.frames.find((frame) =>
    frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'idle'));
  const refreshIdle = await requestAnswer(
    reader,
    { kind: 'history-refresh', cursor: refreshTwo.cursor },
    'refresh-idle',
    'history',
  );
  assert.equal(refreshIdle.kind, 'history');
  assert.deepEqual(refreshIdle.messages.map((message: any) => message.key), ['reply'], 'the turn ended, so the reply ships');
  assert.equal(refreshIdle.messages[0].text, 'streamed reply');
  assert.ok(
    broker.stderr().split('\n').some((line) => line.includes('[h1-history-read] refresh pi:')),
    'a generic session refreshes from one history read',
  );
  const refreshEmpty = await requestAnswer(
    reader,
    { kind: 'history-refresh', cursor: refreshIdle.cursor },
    'refresh-empty',
    'history',
  );
  assert.equal(refreshEmpty.kind, 'history');
  assert.equal(refreshEmpty.messages.length, 0);
  assert.equal(refreshEmpty.cursor, refreshIdle.cursor, 'an up-to-date refresh keeps the cursor');
  assert.equal(refreshEmpty.endCursor, refreshIdle.endCursor);
  // The snapshot the refreshes shared was read while the turn ran, so it may hold a shorter copy of
  // the turn's newest row than the session saved: the turn ending retires it, and the refresh after
  // the turn reads the session once more. Nothing moves after that.
  assert.equal(refreshReads(), 2, 'the turn ending retired the snapshot read during it, once');
  assert.equal(refreshPageMisses(), 0, 'the page route reused the snapshot the refresh read');

  // Forward: from the attach's older boundary to the end, in pages, holding every row once.
  const forward: string[] = [];
  let forwardCursor = String(reader.attach.olderCursor);
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await requestAnswer(
      reader,
      { kind: 'history-page', direction: 'newer', cursor: forwardCursor, limit: PAGE_MESSAGES },
      `forward-${guard}`,
      'history-page',
    );
    assert.equal(page.kind, 'history-page', JSON.stringify(page).slice(0, 300));
    assert.equal(page.direction, 'newer', 'a newer page names its direction');
    forward.push(...page.messages.map((message: any) => message.key));
    forwardCursor = String(page.cursor);
    if (page.endOfHistory) break;
  }
  assert.deepEqual(
    forward,
    [
      ...Array.from({ length: 100 }, (_, index) => `r-${index + 200}`),
      ...Array.from({ length: 150 }, (_, index) => `rl-${index}`),
      'reply',
    ],
    'a forward walk holds every row after the boundary once, in order',
  );
  assert.equal(forwardCursor, refreshIdle.endCursor, 'the walk ends at the current end boundary');
  // The pooled snapshot now ends where the walk ended. Rows appended after it are still reached:
  // a newer page that runs off the end of an append ancestor reads the current source.
  await bridgeEvents(broker.base, refreshId, Array.from({ length: 5 }, (_, index) => ({
    t: 'user',
    key: `after-${index}`,
    text: `after walk ${index}`,
  })));
  waitLabel = 'rows after the walk';
  await waitFor(() => reader.frames.find((frame) => frame.kind === 'message' && frame.message?.key === 'after-4'));
  const beyondAncestor = await requestAnswer(
    reader,
    { kind: 'history-page', direction: 'newer', cursor: forwardCursor, limit: PAGE_MESSAGES },
    'forward-beyond-ancestor',
    'history-page',
  );
  assert.equal(beyondAncestor.kind, 'history-page');
  assert.deepEqual(
    beyondAncestor.messages.map((message: any) => message.key),
    Array.from({ length: 5 }, (_, index) => `after-${index}`),
    'a newer page past an append ancestor continues into the current source',
  );
  assert.equal(beyondAncestor.endOfHistory, true);
  const closed = await requestAnswer(
    reader,
    {
      kind: 'history-page',
      direction: 'newer',
      cursor: reader.attach.endCursor,
      until: refreshOne.endCursor,
      limit: 500,
    },
    'forward-until',
    'history-page',
  );
  assert.equal(closed.kind, 'history-page');
  assert.equal(closed.messages.length, 100);
  assert.equal(closed.cursor, refreshOne.endCursor, 'a walk that reaches until names it verbatim');
  assert.equal(closed.hasMore, true);
  for (const [request, code, label] of [
    [{ kind: 'history-page', direction: 'sideways', cursor: reader.attach.endCursor }, 'BAD_PARAM', 'bad-direction'],
    [{ kind: 'history-page', cursor: reader.attach.endCursor, until: reader.attach.endCursor }, 'BAD_PARAM', 'older-until'],
    [{ kind: 'history-page', direction: 'newer', cursor: refreshOne.endCursor, until: reader.attach.endCursor }, 'HISTORY_CURSOR_INVALID', 'until-before'],
    [{ kind: 'history-refresh', cursor: 'not-a-cursor' }, 'HISTORY_CURSOR_INVALID', 'refresh-bad-cursor'],
    [{ kind: 'history-refresh', cursor: reader.attach.cursor, limit: 0 }, 'BAD_PARAM', 'refresh-bad-limit'],
    [{ kind: 'history-refresh' }, 'BAD_PARAM', 'refresh-no-cursor'],
  ] as const) {
    const refused = await requestAnswer(reader, request, label, request.kind === 'history-refresh' ? 'history' : 'history-page');
    assert.equal(refused.kind, 'nack', `${label} is refused`);
    assert.equal(refused.code, code, `${label}: ${refused.code}`);
  }
  reader.ws.send(JSON.stringify({ kind: 'history-refresh', cursor: reader.attach.cursor }));
  waitLabel = 'refresh without an id';
  const unnamed = await waitFor(() =>
    reader.frames.find((frame) => frame.kind === 'nack' && frame.code === 'BAD_CLIENT_MESSAGE_ID'));
  assert.equal(unnamed.kind, 'nack', 'a refresh needs an id to be matched to its answer');

  // One read serves every client. Growth invalidates the snapshot, and concurrent refreshes of the
  // grown source share the one read that replaces it.
  const peer = await openClient(broker.wsBase, refreshId, PAGE_MESSAGES);
  clients.push(peer.ws);
  const readsBeforeGrowth = refreshReads();
  await bridgeEvents(broker.base, refreshId, [{ t: 'user', key: 'grown', text: 'grown row' }]);
  waitLabel = 'grown row';
  await waitFor(() => peer.frames.find((frame) => frame.kind === 'message' && frame.message?.key === 'grown'));
  const [firstGrown, secondGrown] = await Promise.all([
    requestAnswer(reader, { kind: 'history-refresh', cursor: refreshEmpty.cursor }, 'grown-first', 'history'),
    requestAnswer(peer, { kind: 'history-refresh', cursor: peer.attach.cursor }, 'grown-second', 'history'),
  ]);
  assert.equal(firstGrown.kind, 'history');
  assert.equal(secondGrown.kind, 'history');
  assert.deepEqual(secondGrown.messages.map((message: any) => message.key), ['grown']);
  assert.equal(firstGrown.messages.at(-1)?.key, 'grown');
  assert.equal(firstGrown.cursor, secondGrown.cursor, 'both clients are answered from the same snapshot');
  assert.equal(refreshReads(), readsBeforeGrowth + 1, 'concurrent refreshes of the grown source share one read');
  const thirdGrown = await requestAnswer(peer, { kind: 'history-refresh', cursor: secondGrown.cursor }, 'grown-third', 'history');
  assert.equal(thirdGrown.kind, 'history');
  assert.equal(thirdGrown.messages.length, 0);
  assert.equal(refreshReads(), readsBeforeGrowth + 1, 'another client reuses the grown snapshot');

  // A replaced history is never answered from the snapshot of the one it replaced.
  await bridgeHello(broker.base, `${sessionFile}.refresh`, [
    { t: 'user', key: 'replaced-0', text: 'replacement row 0' },
    { t: 'user', key: 'replaced-1', text: 'replacement row 1' },
  ]);
  waitLabel = 'replacement frame';
  const replacement = await waitFor(() => peer.frames.find((frame) => frame.kind === 'history'
    && frame.reset === true && frame.messages?.[0]?.key === 'replaced-0'));
  const staleRefresh = await requestAnswer(peer, { kind: 'history-refresh', cursor: thirdGrown.cursor }, 'replaced-stale', 'history');
  assert.equal(staleRefresh.kind, 'nack', 'a cursor into the replaced history is refused');
  assert.equal(staleRefresh.code, 'HISTORY_CURSOR_GONE', 'the replacement is shorter than the stale boundary');
  const readsBeforeReplacementRefresh = refreshReads();
  await bridgeEvents(broker.base, refreshId, [{ t: 'user', key: 'replaced-2', text: 'replacement row 2' }]);
  waitLabel = 'row after the replacement';
  await waitFor(() => peer.frames.find((frame) => frame.kind === 'message' && frame.message?.key === 'replaced-2'));
  const afterReplacement = await requestAnswer(peer, { kind: 'history-refresh', cursor: replacement.cursor }, 'replaced-fresh', 'history');
  assert.equal(afterReplacement.kind, 'history', JSON.stringify(afterReplacement).slice(0, 300));
  assert.deepEqual(afterReplacement.messages.map((message: any) => message.key), ['replaced-2']);
  assert.equal(refreshReads(), readsBeforeReplacementRefresh + 1, 'the replacement is read, not served from the old snapshot');
  peer.ws.close();
  reader.ws.close();

  // Revision 28 on the native-index path: a Codex rollout is served from its compact index, so the
  // refresh and the newer page are answered from that index rather than from a full history read.
  const codexDay = join(home, 'home', '.codex', 'sessions', '2026', '07', '28');
  mkdirSync(codexDay, { recursive: true });
  const rollout = join(codexDay, 'rollout-2026-07-28T00-00-00-00000000-0000-4000-8000-00000000a028.jsonl');
  const codexRow = (text: string) => JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  });
  writeFileSync(rollout, `${[
    JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '00000000-0000-4000-8000-00000000a028', cwd: '/tmp' },
    }),
    ...Array.from({ length: 300 }, (_, index) => codexRow(`codex row ${index}`)),
  ].join('\n')}\n`);
  const codexId = Buffer.from(rollout, 'utf8').toString('base64url');
  const codexFrames: any[] = [];
  const codexWs = new WebSocket(
    `${broker.wsBase}/api/sessions/codex/${encodeURIComponent(codexId)}/stream?${new URLSearchParams({
      artifactMode: 'reference',
      contractRevision: '5',
      minimumBrokerRevision: '2',
      initialHistory: `${PAGE_MESSAGES}`,
    })}`,
  );
  clients.push(codexWs);
  codexWs.onmessage = (event) => {
    try {
      codexFrames.push(JSON.parse(String(event.data)));
    } catch {
      // Malformed frames are asserted by the timeout below.
    }
  };
  await new Promise<void>((resolve, reject) => {
    codexWs.onopen = () => resolve();
    codexWs.onerror = () => reject(new Error('Codex WebSocket failed to open'));
  });
  waitLabel = 'Codex initial history';
  const codexAttach = await waitFor(() => codexFrames.find((frame) => frame.kind === 'history'));
  const codex: SocketClient = { ws: codexWs, frames: codexFrames, attach: codexAttach };
  assert.equal(codexAttach.messages.length, PAGE_MESSAGES);
  assert.equal(codexAttach.newerHistory, true, 'the indexed attach offers refresh and newer paging');
  appendFileSync(rollout, `${Array.from({ length: 30 }, (_, index) => codexRow(`codex appended ${index}`)).join('\n')}\n`);
  const codexRefresh = await requestAnswer(
    codex,
    { kind: 'history-refresh', cursor: codexAttach.cursor },
    'codex-refresh',
    'history',
  );
  assert.equal(codexRefresh.kind, 'history', JSON.stringify(codexRefresh).slice(0, 300));
  assert.equal(codexRefresh.reset, false);
  assert.deepEqual(
    codexRefresh.messages.map((message: any) => message.text),
    Array.from({ length: 30 }, (_, index) => `codex appended ${index}`),
    'the indexed refresh carries exactly the rows appended since the attach',
  );
  const codexForward = await requestAnswer(
    codex,
    {
      kind: 'history-page',
      direction: 'newer',
      cursor: codexAttach.olderCursor,
      until: codexRefresh.endCursor,
      limit: 500,
    },
    'codex-forward',
    'history-page',
  );
  assert.equal(codexForward.kind, 'history-page', JSON.stringify(codexForward).slice(0, 300));
  assert.equal(codexForward.direction, 'newer');
  assert.deepEqual(
    codexForward.messages.map((message: any) => message.text),
    [
      ...Array.from({ length: 100 }, (_, index) => `codex row ${index + 200}`),
      ...Array.from({ length: 30 }, (_, index) => `codex appended ${index}`),
    ],
    'an indexed newer page walks from the attach boundary to the refreshed end',
  );
  assert.equal(codexForward.cursor, codexRefresh.endCursor);
  assert.equal(codexForward.endOfHistory, true);
  const codexReads = broker.stderr().split('\n').filter((line) => line.includes('[h1-history-read]') && line.includes(' codex:'));
  assert.equal(
    codexReads.filter((line) => line.includes(' refresh ')).length,
    0,
    'an indexed session refreshes from its native index, never from a full history read',
  );
  assert.ok(codexReads.some((line) => line.includes(' page-cache-miss ')), 'the refresh indexed the grown rollout');
  codexWs.close();

  // Lane H1d: measuring a row for the byte bound builds its delivered shape without storing
  // anything. A reference-mode socket's diff row that the bound measures and then trims away must
  // leave no blob behind (a stash per measured row would also let a storage failure abort the
  // attach). A small budget makes the diff row the one measured and cut.
  const measureHome = mkdtempSync('/tmp/cosyncing-h1-wire-measure-');
  const measureBroker = await startBroker(measureHome, { COSYNCING_HISTORY_MAX_DECODED_BYTES: '3000' });
  try {
    const measuredId = await bridgeHello(measureBroker.base, `${sessionFile}.measure`, [
      { t: 'user', key: 'measure-first', text: 'first' },
      {
        t: 'tool-result',
        callId: 'measured-lockfile',
        name: 'edit',
        args: { path: 'bun.lock', note: 'n'.repeat(4_000) },
        details: { diff: lockfile },
        result: 'r'.repeat(4_000),
      },
      { t: 'user', key: 'measure-newest', text: 'newest' },
    ]);
    const measured = await openClient(measureBroker.wsBase, measuredId, PAGE_MESSAGES, 'reference');
    clients.push(measured.ws);
    assert.deepEqual(
      measured.attach.messages.map((message: any) => message.text),
      ['newest'],
      'the small budget keeps only the newest row, cutting the measured diff row',
    );
    const blobs = readdirSync(measureHome, { recursive: true })
      .map(String)
      .filter((entry) => /artifacts[\\/]blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/.test(entry));
    assert.deepEqual(blobs, [], 'measuring a row for the byte bound stores no artifact');
    measured.ws.close();
  } finally {
    measureBroker.child.kill();
    await measureBroker.child.exited.catch(() => undefined);
    rmSync(measureHome, { recursive: true, force: true });
    rmSync(`${sessionFile}.measure`, { force: true });
  }

  console.log('PASS H1 real broker history paging snapshot integration');
} finally {
  for (const ws of clients) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionFile, { force: true });
  rmSync(`${sessionFile}.diff`, { force: true });
  rmSync(`${sessionFile}.oversized`, { force: true });
  rmSync(`${sessionFile}.refresh`, { force: true });
}
