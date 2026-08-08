#!/usr/bin/env bun
/**
 * H1c production wiring — a real broker, a real WebSocket, a real Codex rollout
 * whose compact index genuinely cannot be built.
 *
 * The fixture crosses the compact reader's native call-reference ceiling, which
 * is an INDEX-only bound: the plain streaming path underneath it stays
 * available, so this exercises the interesting half of the lane — a genuine
 * resource refusal that must still deliver the newest usable replay.
 *
 * Every attach frame this test sees is checked against one rule: a refusal may
 * never claim an authoritative empty history or a true session start.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import {
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const PAGE_MESSAGES = 100;
const USER_ROWS = 900;
/** Beyond CODEX_HISTORY_READER_MAX_CALL_REFS_PER_ID, which only the compact
 *  random-access index enforces. */
const SHARED_CALL_OUTPUTS = 96;
const WAIT_MS = 20_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

type RunningBroker = {
  child: ReturnType<typeof Bun.spawn>;
  wsBase: string;
};

async function startBroker(
  home: string,
  codexHome: string,
): Promise<RunningBroker> {
  const port = await freePort();
  const child = Bun.spawn(
    ['bun', 'run', 'packages/typescript/broker/src/main.ts'],
    {
      env: isolatedBrokerFixtureEnvironment(home, {
        overrides: {
          PORT: String(port),
          HOST: '127.0.0.1',
          CODEX_HOME: codexHome,
          COSYNCING_HOME: home,
          COSYNCING_TOKEN: '',
          COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        },
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  const base = `http://127.0.0.1:${port}`;
  // Readiness is not one of this suite's assertions, so it does not get this
  // suite's WAIT_MS: a broker booting beside other suites is slow, not broken.
  // The waits after this keep WAIT_MS, because those are the behaviour tested.
  try {
    await waitForBrokerHealth(child, `${base}/api/health`);
  } catch (error) {
    // The caller never receives this child, so it cannot clean it up. A broker
    // that is merely slow, not dead, would otherwise outlive the suite and be
    // reaped by the lane as a stray.
    child.kill();
    await child.exited;
    throw error;
  }
  return { child, wsBase: base.replace(/^http/, 'ws') };
}

type SocketClient = {
  ws: WebSocket;
  frames: any[];
  attach: any;
};

async function openClient(
  wsBase: string,
  id: string,
  since?: string,
): Promise<SocketClient> {
  const frames: any[] = [];
  const params = new URLSearchParams({
    artifactMode: 'reference',
    contractRevision: '9',
    minimumBrokerRevision: '2',
    initialHistory: `${PAGE_MESSAGES}`,
    ...(since ? { since } : {}),
  });
  const ws = new WebSocket(
    `${wsBase}/api/sessions/codex/${encodeURIComponent(id)}/stream?${params}`,
  );
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      // The timeout below reports a malformed/missing production frame.
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  const attach = await waitFor(
    () => frames.find((frame) => frame.kind === 'history'),
    'Codex initial history',
  );
  return { ws, frames, attach };
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
  return waitFor(
    () => client.frames.find((frame) =>
      frame.clientMessageId === requestId
      && (frame.kind === 'history-page' || frame.kind === 'nack')),
    `history page ${requestId}`,
  );
}

/** The whole point of H1c, asserted on a real production frame. */
function assertTruthfulAttach(attach: any, label: string): void {
  const messages = attach.messages ?? [];
  const claimsStart = attach.reset === true
    && attach.hasEarlier !== true
    && attach.truncated === undefined;
  assert(
    !(claimsStart && messages.length === 0),
    `${label}: attach claimed an authoritative empty history and a true session start`,
  );
  const gapMessage = String(attach.gap?.message ?? '');
  if (attach.gap && attach.reset !== true) {
    assert(
      !gapMessage.includes('full replay'),
      `${label}: a non-reset frame described itself as a full replay`,
    );
  }
  if (attach.gap?.code === 'HISTORY_PAGE_RESOURCE_LIMIT'
    || attach.gap?.code === 'HISTORY_PAGE_SOURCE_CHANGED') {
    assert(
      !gapMessage.includes('full replay'),
      `${label}: an unreadable history described itself as a full replay`,
    );
    assert.equal(
      attach.olderCursor,
      undefined,
      `${label}: an unreadable history offered an older cursor it cannot serve`,
    );
  }
}

const root = mkdtempSync('/tmp/cosyncing-h1c-wire-');
const home = join(root, 'broker-home');
const codexHome = join(root, 'codex-home');
const day = join(codexHome, 'sessions', '2026', '07', '28');
mkdirSync(day, { recursive: true });
const rollout = join(
  day,
  'rollout-2026-07-28T00-00-00-00000000-0000-4000-8000-0000000001c3.jsonl',
);

const fd = openSync(rollout, 'w');
try {
  writeSync(fd, `${JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '00000000-0000-4000-8000-0000000001c3',
      cwd: '/tmp',
    },
  })}\n`);
  for (let index = 0; index < USER_ROWS; index += 1) {
    writeSync(fd, `${JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `h1c wire row ${index} ${'x'.repeat(256)}`,
      },
    })}\n`);
  }
  // More references to one call id than the compact reader retains. Only the
  // index path counts these, so the bounded tail fallback stays possible.
  for (let index = 0; index < SHARED_CALL_OUTPUTS; index += 1) {
    writeSync(fd, `${JSON.stringify({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'h1c-shared-call',
        output: `shared output ${index}`,
      },
    })}\n`);
  }
} finally {
  closeSync(fd);
}

/**
 * A second rollout whose newest messages surround a record no bounded window can
 * hold.
 *
 * The tail read SKIPS such a record instead of refusing the whole source, which
 * is right — but the frame then described itself as "the newest messages are
 * shown" while silently omitting one of them (H1c round 3, finding 5). The
 * window is the newest READABLE messages, and the frame has to say so.
 */
const skipRollout = join(
  day,
  'rollout-2026-07-28T00-00-01-00000000-0000-4000-8000-0000000001c4.jsonl',
);
const skipFd = openSync(skipRollout, 'w');
try {
  writeSync(skipFd, `${JSON.stringify({
    timestamp: '2026-07-28T00:00:01.000Z',
    type: 'session_meta',
    payload: { id: '00000000-0000-4000-8000-0000000001c4', cwd: '/tmp' },
  })}\n`);
  const skipRow = (index: number) => `${JSON.stringify({
    timestamp: '2026-07-28T00:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: `h1c skip row ${index} ${'x'.repeat(256)}`,
    },
  })}\n`;
  for (let index = 0; index < USER_ROWS; index += 1) writeSync(skipFd, skipRow(index));
  // One record past HISTORY_SNAPSHOT_MAX_RECORD_BYTES, written in chunks so the
  // fixture never materializes whole in this process either.
  const filler = Buffer.alloc(1 << 20, 0x78);
  writeSync(skipFd, '{"type":"event_msg","payload":{"type":"user_message","message":"');
  for (let written = 0; written < 33; written += 1) writeSync(skipFd, filler);
  writeSync(skipFd, '"}}\n');
  for (let index = USER_ROWS; index < USER_ROWS + 40; index += 1) {
    writeSync(skipFd, skipRow(index));
  }
} finally {
  closeSync(skipFd);
}

let broker = await startBroker(home, codexHome);
const clients: WebSocket[] = [];
try {
  const id = Buffer.from(rollout, 'utf8').toString('base64url');

  // ---------------------------------- initial attach with no retained pages
  const first = await openClient(broker.wsBase, id);
  clients.push(first.ws);
  assertTruthfulAttach(first.attach, 'initial attach');
  assert.equal(
    first.attach.gap?.code,
    'HISTORY_PAGE_RESOURCE_LIMIT',
    'the fixture must genuinely refuse the compact index',
  );
  assert.equal(first.attach.reset, true);
  assert.equal(
    first.attach.messages.length,
    PAGE_MESSAGES,
    'a refusal must still replay the newest bounded window',
  );
  assert.equal(first.attach.hasEarlier, true);
  assert(
    first.attach.truncated?.total >= USER_ROWS,
    'the truncation total must describe the real history, not the window',
  );
  assert(first.attach.cursor, 'a served window must carry a reconnect cursor');
  // Nothing was skipped or shortened here, so the plain claim is the true one.
  const firstGapMessage = String(first.attach.gap?.message ?? '');
  assert(
    firstGapMessage.includes('the newest messages are shown'),
    `a complete window must claim exactly that: ${firstGapMessage}`,
  );
  assert(
    !firstGapMessage.includes('oversized')
      && !firstGapMessage.includes('readable'),
    `a window with no losses must not invent any: ${firstGapMessage}`,
  );

  // Paging is genuinely unavailable, and says so terminally rather than
  // pretending the history ended.
  const pageNack = await requestPage(
    first,
    'AAAA-not-a-real-cursor',
    'refused-page',
  );
  assert.equal(pageNack.kind, 'nack');
  assert.equal(pageNack.code, 'HISTORY_PAGE_RESOURCE_LIMIT');

  // ------------------------- an initialized client with retained pages
  // Its cursor is inside the retained window: the broker must NOT replace what
  // it already holds.
  const reconnected = await openClient(
    broker.wsBase,
    id,
    String(first.attach.cursor),
  );
  clients.push(reconnected.ws);
  assertTruthfulAttach(reconnected.attach, 'in-window reconnect');
  assert.notEqual(
    reconnected.attach.reset,
    true,
    'an in-window reconnect must not reset a client that already has pages',
  );
  assert.equal(reconnected.attach.messages.length, 0);
  assert.equal(reconnected.attach.cursor, first.attach.cursor);

  // A stale cursor is answered with the newest usable replay, never an erasure.
  const stale = await openClient(
    broker.wsBase,
    id,
    Buffer.from(
      JSON.stringify({ v: 1, n: 3, h: 'stale-and-unmatchable' }),
      'utf8',
    ).toString('base64url'),
  );
  clients.push(stale.ws);
  assertTruthfulAttach(stale.attach, 'stale reconnect');
  assert.equal(stale.attach.reset, true);
  assert.equal(stale.attach.messages.length, PAGE_MESSAGES);
  assert.equal(stale.attach.hasEarlier, true);

  // ------------------------------------------------ append, then reconnect
  appendFileSync(
    rollout,
    `${JSON.stringify({
      timestamp: '2026-07-28T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'h1c active append' },
    })}\n`,
  );
  const afterAppend = await openClient(
    broker.wsBase,
    id,
    String(first.attach.cursor),
  );
  clients.push(afterAppend.ws);
  assertTruthfulAttach(afterAppend.attach, 'append reconnect');
  assert.notEqual(
    afterAppend.attach.reset,
    true,
    'an append must stay an incremental delta for a still-valid cursor',
  );
  assert.equal(
    afterAppend.attach.messages.length,
    1,
    'the appended message must arrive without replacing the client window',
  );

  // ------------------------------------------------------- broker restart
  for (const ws of clients.splice(0)) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  broker = await startBroker(home, codexHome);

  const afterRestart = await openClient(broker.wsBase, id);
  clients.push(afterRestart.ws);
  assertTruthfulAttach(afterRestart.attach, 'post-restart attach');
  assert.equal(afterRestart.attach.gap?.code, 'HISTORY_PAGE_RESOURCE_LIMIT');
  assert.equal(afterRestart.attach.reset, true);
  assert.equal(afterRestart.attach.messages.length, PAGE_MESSAGES);
  assert.equal(afterRestart.attach.hasEarlier, true);

  const afterRestartResume = await openClient(
    broker.wsBase,
    id,
    String(afterRestart.attach.cursor),
  );
  clients.push(afterRestartResume.ws);
  assertTruthfulAttach(afterRestartResume.attach, 'post-restart reconnect');
  assert.notEqual(afterRestartResume.attach.reset, true);

  // ------------------------ a window with an unreadable record inside it (F5)
  // The record is skipped, so the frame carries the messages on both sides of a
  // hole. Saying "the newest messages are shown" there is false, and the client
  // has no way to tell: the skip leaves no trace in the messages it receives.
  // Fails against the pre-fix fixed copy, which made exactly that claim.
  const skipId = Buffer.from(skipRollout, 'utf8').toString('base64url');
  const skipped = await openClient(broker.wsBase, skipId);
  clients.push(skipped.ws);
  assertTruthfulAttach(skipped.attach, 'skipped-record attach');
  assert.equal(
    skipped.attach.gap?.code,
    'HISTORY_PAGE_RESOURCE_LIMIT',
    'an oversized record must still refuse the index',
  );
  assert.equal(skipped.attach.reset, true);
  assert(
    skipped.attach.messages.length > 0,
    'a skipped record must not cost every other message',
  );
  const skipGapMessage = String(skipped.attach.gap?.message ?? '');
  assert(
    skipGapMessage.includes('the newest readable messages are shown'),
    `a window with a skipped record must not claim to hold the newest messages: ${skipGapMessage}`,
  );
  assert(
    /\b1 oversized record\b/.test(skipGapMessage)
      && skipGapMessage.includes('could not be read'),
    `the frame must state how many records could not be read: ${skipGapMessage}`,
  );
  // "in this history", not "in this window": the count covers the whole
  // captured source and the skip POSITIONS are not tracked, so scoping the
  // claim to the shown window would be an invention (round 4).
  assert(
    skipGapMessage.includes('in this history')
      && !skipGapMessage.includes('in this window'),
    `the skipped-record count must not claim a position it never tracked: ${skipGapMessage}`,
  );
  // The gap CODE is unchanged, so no client release and no new ARB string are
  // needed to render this honestly.
  assert.equal(
    skipped.attach.olderCursor,
    undefined,
    'a skipped-record window still cannot offer an older cursor',
  );

  console.log(JSON.stringify({
    sourceBytes: statSync(rollout).size,
    refusalCode: first.attach.gap.code,
    replayedMessages: first.attach.messages.length,
    totalMessages: first.attach.truncated.total,
    olderCursorOffered: first.attach.olderCursor ?? null,
    skippedRecordFixture: {
      sourceBytes: statSync(skipRollout).size,
      replayedMessages: skipped.attach.messages.length,
      gapMessage: skipGapMessage,
    },
  }));
  console.log('PASS H1c refused Codex history keeps a truthful replay on the wire');
} finally {
  for (const ws of clients) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
