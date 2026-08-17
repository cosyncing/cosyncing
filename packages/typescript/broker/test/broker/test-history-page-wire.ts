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
import { mkdtempSync, rmSync } from 'node:fs';
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

async function startBroker(home: string): Promise<RunningBroker> {
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

  console.log('PASS H1 real broker history paging snapshot integration');
} finally {
  for (const ws of clients) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionFile, { force: true });
}
