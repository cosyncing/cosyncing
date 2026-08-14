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
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
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
  options: {
    historyReadMetrics?: (line: string) => void;
    captureHoldFile?: string;
  } = {},
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
          ...(options.historyReadMetrics
            ? { COSYNCING_TEST_HISTORY_READ_METRICS: '1' }
            : {}),
          ...(options.captureHoldFile
            ? { COSYNCING_TEST_CODEX_CAPTURE_HOLD_FILE: options.captureHoldFile }
            : {}),
        },
      }),
      stdout: 'ignore',
      stderr: options.historyReadMetrics ? 'pipe' : 'ignore',
    },
  );
  if (options.historyReadMetrics) {
    const onMetric = options.historyReadMetrics;
    void (async () => {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.includes('[h1-history-read]')) onMetric(line);
          }
        }
      } catch {
        /* broker exited */
      }
    })();
  }
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

/** Open the stream but return as soon as the SESSION frame arrives — before the history
 *  capture completes. The cold-attach race test needs a subscribed socket whose first
 *  capture is still in flight; waiting for the history frame (as openClient does) would
 *  put every later action after the race window it exists to occupy. */
async function openClientDeferred(
  wsBase: string,
  id: string,
): Promise<{ ws: WebSocket; frames: any[] }> {
  const frames: any[] = [];
  const params = new URLSearchParams({
    artifactMode: 'reference',
    contractRevision: '9',
    minimumBrokerRevision: '2',
    initialHistory: `${PAGE_MESSAGES}`,
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
  await waitFor(
    () => frames.find((frame) => frame.kind === 'session'),
    'Codex session frame (pre-history)',
  );
  return { ws, frames };
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

  // -------------------- H1d live streaming over an over-index source (wire)
  // The production reproduction: a rollout beyond the whole-source index
  // ceiling, observed mid-turn. Before H1d every attach re-streamed the whole
  // source (O(source) serialized in front of the history frame — the cost that
  // made real clients abandon and retry, starving live delivery), and the
  // observe tail keyed live rows on a synthetic byte base that no history read
  // agrees with, so a manual refresh rendered the same rows under second
  // identities. Both halves are pinned here through the real broker and a real
  // WebSocket.
  for (const ws of clients.splice(0)) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  const metricLines: string[] = [];
  const bigDay = join(codexHome, 'sessions', '2026', '08', '01');
  mkdirSync(bigDay, { recursive: true });
  const bigRollout = join(
    bigDay,
    'rollout-2026-08-01T00-00-00-00000000-0000-4000-8000-0000000001d1.jsonl',
  );
  {
    const bigFd = openSync(bigRollout, 'w');
    try {
      // Sparse: the hole is one unreadable record the bounded window skips; the
      // rows plus an OPEN turn (no terminal marker — the mid-turn production
      // shape) live beyond the indexing ceiling.
      ftruncateSync(bigFd, 256 * 1024 * 1024 + 1);
      const seedRows = Array.from({ length: 30 }, (_unused, index) => JSON.stringify({
        timestamp: '2026-08-01T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: `h1d live row ${index}` },
      }));
      seedRows.push(JSON.stringify({
        timestamp: '2026-08-01T00:59:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'h1d-open-turn' },
      }));
      writeSync(bigFd, `\n${seedRows.join('\n')}\n`, 256 * 1024 * 1024 + 1);
    } finally {
      closeSync(bigFd);
    }
  }
  broker = await startBroker(home, codexHome, {
    historyReadMetrics: (line) => metricLines.push(line),
  });
  const bigId = Buffer.from(bigRollout, 'utf8').toString('base64url');
  const liveClient = await openClient(broker.wsBase, bigId);
  clients.push(liveClient.ws);
  assertTruthfulAttach(liveClient.attach, 'oversized live attach');
  assert.equal(liveClient.attach.gap?.code, 'HISTORY_PAGE_RESOURCE_LIMIT');
  assert(liveClient.attach.messages.length > 0);

  appendFileSync(
    bigRollout,
    `${JSON.stringify({
      timestamp: '2026-08-01T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'shell',
        call_id: 'h1d-live-call',
        input: '{"command":"echo hi"}',
      },
    })}\n${JSON.stringify({
      timestamp: '2026-08-01T01:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'h1d-live-call',
        output: 'hi',
      },
    })}\n${JSON.stringify({
      timestamp: '2026-08-01T01:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'h1d live assistant text' },
    })}\n`,
  );
  // Intermediate output must stream to the ATTACHED socket — no refresh, no
  // reconnect, no turn boundary.
  const liveAssistant = await waitFor(
    () => liveClient.frames.find((frame) =>
      frame.kind === 'message'
      && frame.message?.type === 'model-output'
      && String(frame.message?.text ?? '').includes('h1d live assistant text')),
    'live assistant frame on an over-index session',
  );
  assert(
    liveClient.frames.some((frame) =>
      frame.kind === 'message' && frame.message?.type === 'tool-call'
      && frame.message?.callId === 'h1d-live-call'),
    'live tool call must stream on an over-index session',
  );
  assert(
    liveClient.frames.some((frame) =>
      frame.kind === 'message' && frame.message?.type === 'tool-result'
      && frame.message?.callId === 'h1d-live-call'),
    'live tool result must stream on an over-index session',
  );

  // A manual refresh (a fresh attach) must converge on the SAME identity for
  // the rows it replays — one key per logical message across live and history,
  // or every refresh doubles the transcript.
  const refreshed = await openClient(broker.wsBase, bigId);
  clients.push(refreshed.ws);
  const refreshedAssistant = (refreshed.attach.messages as any[]).find((message) =>
    message?.type === 'model-output'
    && String(message?.text ?? '').includes('h1d live assistant text'));
  assert(refreshedAssistant, 'the refreshed window must include the streamed assistant text');
  assert.equal(
    refreshedAssistant.key,
    liveAssistant.message.key,
    'live delivery and a later history read must agree on one identity per row',
  );
  assert.equal(
    (refreshed.attach.messages as any[])
      .filter((message) => message?.type === 'model-output'
        && String(message?.text ?? '').includes('h1d live assistant text')).length,
    1,
    'the streamed row must appear exactly once after a refresh',
  );
  // The whole-source bounded scan is paid once; the refresh extends it by the
  // appended bytes instead of re-streaming 256 MiB per attach.
  const fullTailScans = metricLines.filter((line) =>
    line.includes(' bounded-tail-fallback ')).length;
  assert.equal(
    fullTailScans,
    1,
    `exactly one whole-source bounded scan across attaches, got ${fullTailScans}:\n${metricLines.join('\n')}`,
  );

  // -------------------- H1e cold-attach race: the source grows DURING the first capture
  // The broker subscribes the live tail before the history capture runs. On an
  // over-ceiling source the tail starts on a synthetic byte base; before this
  // fix, a line drained while the first capture was still scanning went out
  // under that base, permanently blocked watermark adoption, and the same row
  // then arrived AGAIN inside the history frame under its record-index key —
  // two identities on the very first socket, and every later live row stayed
  // synthetic. The capture hold file pins the capture open so the append lands
  // deterministically inside the race window.
  for (const ws of clients.splice(0)) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  const raceRollout = join(
    bigDay,
    'rollout-2026-08-01T00-00-00-00000000-0000-4000-8000-0000000001e1.jsonl',
  );
  {
    const raceFd = openSync(raceRollout, 'w');
    try {
      ftruncateSync(raceFd, 256 * 1024 * 1024 + 1);
      const seedRows = Array.from({ length: 10 }, (_unused, index) => JSON.stringify({
        timestamp: '2026-08-01T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: `h1e seed row ${index}` },
      }));
      seedRows.push(JSON.stringify({
        timestamp: '2026-08-01T00:59:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'h1e-open-turn' },
      }));
      writeSync(raceFd, `\n${seedRows.join('\n')}\n`, 256 * 1024 * 1024 + 1);
    } finally {
      closeSync(raceFd);
    }
  }
  const holdFile = join(root, 'h1e-capture-hold');
  writeFileSync(holdFile, '1');
  broker = await startBroker(home, codexHome, { captureHoldFile: holdFile });
  const raceId = Buffer.from(raceRollout, 'utf8').toString('base64url');
  const raceClient = await openClientDeferred(broker.wsBase, raceId);
  clients.push(raceClient.ws);
  // The session frame is sent after the tail subscribed and before the capture;
  // the capture is now parked on the hold file. Land the append inside it, and
  // give the (80ms-debounced) watcher time to fire while the capture is still
  // provably open — pre-fix, this is the moment the synthetic-keyed row went out.
  appendFileSync(
    raceRollout,
    `${JSON.stringify({
      timestamp: '2026-08-01T01:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'h1e mid-capture row' },
    })}\n`,
  );
  await Bun.sleep(400);
  rmSync(holdFile);
  const raceAttach = await waitFor(
    () => raceClient.frames.find((frame) => frame.kind === 'history'),
    'history frame after the capture hold released',
  );
  assertTruthfulAttach(raceAttach, 'cold-attach race attach');
  // Let any (buggy) queued live copies flush behind the history frame before counting.
  await Bun.sleep(300);
  const midCaptureInHistory = (raceAttach.messages as any[]).filter((message) =>
    message?.type === 'model-output'
    && String(message?.text ?? '').includes('h1e mid-capture row'));
  const midCaptureLive = raceClient.frames.filter((frame) =>
    frame.kind === 'message'
    && frame.message?.type === 'model-output'
    && String(frame.message?.text ?? '').includes('h1e mid-capture row'));
  assert.equal(
    midCaptureInHistory.length + midCaptureLive.length,
    1,
    `a row appended during the first capture must reach the initial socket exactly once, `
      + `got ${midCaptureInHistory.length} in history + ${midCaptureLive.length} live`,
  );
  const midCaptureKey = midCaptureInHistory[0]?.key ?? midCaptureLive[0]?.message?.key;
  // Adoption must have survived the mid-capture append: the NEXT live row streams
  // under a record-index key, not the synthetic byte base.
  appendFileSync(
    raceRollout,
    `${JSON.stringify({
      timestamp: '2026-08-01T01:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'h1e post-adoption row' },
    })}\n`,
  );
  const postAdoptionLive = await waitFor(
    () => raceClient.frames.find((frame) =>
      frame.kind === 'message'
      && frame.message?.type === 'model-output'
      && String(frame.message?.text ?? '').includes('h1e post-adoption row')),
    'live frame after adoption on the raced connection',
  );
  const raceRefresh = await openClient(broker.wsBase, raceId);
  clients.push(raceRefresh.ws);
  const refreshRows = (raceRefresh.attach.messages as any[]).filter((message) =>
    message?.type === 'model-output'
    && String(message?.text ?? '').includes('h1e '));
  for (const text of ['h1e mid-capture row', 'h1e post-adoption row']) {
    const copies = refreshRows.filter((message) => String(message.text).includes(text));
    assert.equal(copies.length, 1, `${text} must appear exactly once after a refresh`);
  }
  const refreshMidKey = refreshRows.find((message) =>
    String(message.text).includes('h1e mid-capture row'))!.key;
  const refreshPostKey = refreshRows.find((message) =>
    String(message.text).includes('h1e post-adoption row'))!.key;
  assert.equal(
    midCaptureKey,
    refreshMidKey,
    `the mid-capture row must keep one identity across the initial socket and a refresh `
      + `(${midCaptureKey} vs ${refreshMidKey})`,
  );
  assert.equal(
    postAdoptionLive.message.key,
    refreshPostKey,
    `the post-adoption live row must keep one identity across live and a refresh `
      + `(${postAdoptionLive.message.key} vs ${refreshPostKey})`,
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
    liveOverIndexFixture: {
      sourceBytes: statSync(bigRollout).size,
      liveAssistantKey: liveAssistant.message.key,
      fullTailScans,
    },
  }));
  console.log('PASS H1c refused Codex history keeps a truthful replay on the wire');
} finally {
  for (const ws of clients) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
