/**
 * A history the broker cannot index is still a history: it attaches with the
 * newest usable rows and an honest notice, never as an empty session or a
 * false session start, and never with a boundary it cannot serve.
 *
 * Codex rollouts past the compact index's ceilings (a call-reference ceiling,
 * an unreadable oversized record, a sparse 256 MiB source) are served by the
 * bounded-tail replay; a reconnect with a cursor gets an incremental delta when
 * the cursor is in its window and the newest replay otherwise; live output
 * still streams and keeps one identity per row across live delivery, a
 * refresh, and a capture that raced an append. A Kilo host whose transcript
 * read fails keeps the client's cache, and a closed tab's late read never
 * reaches its replacement.
 *
 * The sparse rollouts need a filesystem with sparse files (Linux, macOS).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, eventually, type SessionStream, startBroker } from '../harness/index.ts';
import { ask, attachFrame, historyReadLedgerEnv, rowKey, sessionReads, windowAfterAttach } from '../harness/history.ts';
import {
  appendOversizedRecord,
  codexAgent,
  codexPlan,
  codexTurnStarted,
  codexUser,
  MiB,
  type Rollout,
  writeRollout,
} from '../harness/fakes/codex-rollout.ts';
import { installFakeKiloBinary, kiloAssistantRow, startFakeKiloHost } from '../harness/fakes/kilo.ts';

const PAGE = 100;
const ROWS = 900;
/** Past the indexing ceiling (256 MiB); the rows live after a sparse hole. */
const OVER_INDEX = 256 * MiB + 1;

/** The rule every refused frame keeps: never an authoritative empty history or a false start. */
function expectTruthful(frame: any): void {
  const claimsStart = frame.reset === true && frame.hasEarlier !== true && frame.truncated === undefined;
  expect(claimsStart && (frame.messages ?? []).length === 0).toBe(false);
  const notice = String(frame.gap?.message ?? '');
  // Only a replacement frame may describe itself as a replay, and never an unreadable history.
  if (frame.gap && frame.reset !== true) expect(notice).not.toContain('full replay');
  if (frame.gap?.code === 'HISTORY_PAGE_RESOURCE_LIMIT' || frame.gap?.code === 'HISTORY_PAGE_SOURCE_CHANGED') {
    expect(notice).not.toContain('full replay');
    expect(frame.olderCursor).toBeUndefined();
    expect(frame.endCursor).toBeUndefined();
  }
}

const userRow = (prefix: string) => (index: number) => codexUser(`${prefix} row ${index} ${'x'.repeat(256)}`);

describe('a Codex history past its index ceilings', () => {
  let broker: Broker;
  let holdFile: string;
  /** More references to one call than the compact index retains: an index-only refusal. */
  let shared: Rollout;
  const streams: SessionStream[] = [];
  const attach = async (rollout: Rollout, options: { since?: string } = {}) => {
    const stream = await broker.client().attach('codex', rollout.id, { artifactMode: 'reference', initialHistory: PAGE, ...options });
    streams.push(stream);
    const frame = await attachFrame(stream);
    expectTruthful(frame);
    return { stream, frame };
  };

  beforeAll(async () => {
    broker = await startBroker({
      name: 'history-refusal',
      env: (paths) => ({
        ...historyReadLedgerEnv(paths),
        // Present only while a test holds the first capture open (the cold-attach race).
        COSYNCING_TEST_CODEX_CAPTURE_HOLD_FILE: join(paths.root, 'capture-hold'),
      }),
    });
    holdFile = join(broker.paths.root, 'capture-hold');
    shared = writeRollout(broker.paths.home, {
      generate: {
        count: ROWS + 96,
        row: (index) => index < ROWS
          ? userRow('shared')(index)
          : {
            timestamp: '2026-07-28T00:00:00.000Z',
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'shared-call', output: `shared output ${index}` },
          },
      },
    });
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
  });

  test('a refused index still replays the newest window, says so, and offers no older boundary', async () => {
    const { stream, frame } = await attach(shared);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(frame.reset).toBe(true);
    expect(frame.messages).toHaveLength(PAGE);
    expect(frame.messages.findLast((message: any) => message.type === 'user-message').text).toStartWith(`shared row ${ROWS - 1} `);
    expect(frame.hasEarlier).toBe(true);
    expect(frame.truncated?.total).toBeGreaterThanOrEqual(ROWS);
    expect(typeof frame.cursor).toBe('string');
    expect(frame.gap.message).toContain('the newest messages are shown');
    expect(frame.gap.message).not.toContain('oversized');
    expect(frame.gap.message).not.toContain('readable');
    // Paging is unavailable, and says so rather than claiming the history ended.
    const page = await ask(stream, { kind: 'history-page', cursor: 'AAAA-not-a-real-cursor', limit: PAGE });
    expect(page.kind).toBe('nack');
    expect(page.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
  });

  test('a reconnect inside the window is incremental; an unknown cursor gets the newest replay', async () => {
    const { frame: first } = await attach(shared);
    const { frame: inWindow } = await attach(shared, { since: first.cursor });
    expect(inWindow.reset).not.toBe(true);
    expect(inWindow.messages).toHaveLength(0);
    expect(inWindow.cursor).toBe(first.cursor);
    const unknownCursor = Buffer.from(JSON.stringify({ v: 1, n: 3, h: 'stale-and-unmatchable' })).toString('base64url');
    const { frame: stale } = await attach(shared, { since: unknownCursor });
    expect(stale.reset).toBe(true);
    expect(stale.messages).toHaveLength(PAGE);
    expect(stale.hasEarlier).toBe(true);
    const { frame: malformed } = await attach(shared, { since: '!!!not-base64!!!' });
    expect(malformed.reset).toBe(true);
    expect(malformed.messages.length).toBeGreaterThan(0);
    // An append stays an incremental delta for a cursor still in the window.
    shared.append([codexUser('shared active append', '2026-07-28T00:00:01.000Z')]);
    const { frame: appended } = await attach(shared, { since: first.cursor });
    expect(appended.reset).not.toBe(true);
    expect(appended.messages.map((message: any) => message.text)).toEqual(['shared active append']);
  });

  test('a rewritten or compacted refused history answers an old cursor with the newest replay, never an erasure', async () => {
    const rollout = writeRollout(broker.paths.home, {
      generate: {
        count: ROWS + 96,
        row: (index) => index < ROWS
          ? userRow('rewrite')(index)
          : { timestamp: '2026-07-28T00:00:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'rewrite-call', output: `o${index}` } },
      },
    });
    const { frame } = await attach(rollout);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    // A same-size rewrite inside the first message: an `x` of its padding becomes `Y`.
    const firstRow = readFileSync(rollout.path, 'utf8').indexOf('rewrite row 0 x');
    const fd = openSync(rollout.path, 'r+');
    try {
      writeSync(fd, Buffer.from('Y'), 0, 1, Buffer.byteLength(readFileSync(rollout.path, 'utf8').slice(0, firstRow)) + 'rewrite row 0 '.length);
    } finally {
      closeSync(fd);
    }
    const { frame: rewritten } = await attach(rollout, { since: frame.cursor });
    expect(rewritten.reset).toBe(true);
    expect(rewritten.messages.length).toBeGreaterThan(0);
    // Compaction: the file shrinks under the cursor.
    const fd2 = openSync(rollout.path, 'r+');
    try {
      ftruncateSync(fd2, Math.trunc(statSync(rollout.path).size / 3));
    } finally {
      closeSync(fd2);
    }
    const { frame: compacted } = await attach(rollout, { since: rewritten.cursor });
    expect(compacted.reset).toBe(true);
    expect(compacted.messages.length).toBeGreaterThan(0);
  });

  test('an unreadable record inside the window is admitted, not hidden', async () => {
    const skip = writeRollout(broker.paths.home, { generate: { count: ROWS, row: userRow('skip') } });
    appendOversizedRecord(skip.path, 33 * MiB);
    skip.append(Array.from({ length: 40 }, (_, index) => userRow('skip')(ROWS + index)));
    const { frame } = await attach(skip);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(frame.reset).toBe(true);
    expect(frame.messages.length).toBeGreaterThan(0);
    expect(frame.messages.at(-1).text).toStartWith(`skip row ${ROWS + 39} `);
    const notice = String(frame.gap.message);
    expect(notice).toContain('the newest readable messages are shown');
    expect(notice).toMatch(/\b1 oversized record\b/);
    expect(notice).toContain('could not be read');
    // The count covers the whole history; where the skip sat is not tracked, so no window claim.
    expect(notice).toContain('in this history');
    expect(notice).not.toContain('in this window');
  });

  test('a plan update that could not be read never lets the older plan replay as current', async () => {
    const OLD = 'OLD PLAN MUST NOT RESURRECT';
    // More call references than the index retains: refused to the bounded-tail replay, with
    // nothing skipped, so its plan is current state the frame carries.
    const sharedCalls = Array.from({ length: 96 }, (_, index) => ({
      timestamp: '2026-07-28T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'plan-shared-call', output: `output ${index}` },
    }));
    const rows = [codexUser('before the plans'), codexPlan(OLD, 'plan-old'), ...sharedCalls, codexUser('after the plans')];
    const control = writeRollout(broker.paths.home, { rows });
    const { stream: controlStream, frame: controlFrame } = await attach(control);
    expect(controlFrame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(JSON.stringify(windowAfterAttach(controlStream))).toContain(OLD);

    // The same history, then a newer plan in a record past the per-record ceiling: skipped unread.
    const rollout = writeRollout(broker.paths.home, { rows });
    rollout.append([codexPlan('NEW PLAN', 'plan-new', 33 * MiB)]);
    rollout.append([codexUser('after the unreadable plan')]);
    const { stream, frame } = await attach(rollout);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(JSON.stringify(windowAfterAttach(stream))).not.toContain(OLD);
    expect(frame.messages.some((message: any) => message.type === 'user-message')).toBe(true);
    // Unverifiable state makes every reconnect a replacement, so a client's copy of the old plan is retracted.
    const { frame: again } = await attach(rollout, { since: frame.cursor });
    expect(again.reset).toBe(true);
    expect(JSON.stringify(again.messages)).not.toContain(OLD);
  });

  test('live output on an over-index session streams to the attached socket, and a refresh keeps its identity', async () => {
    const big = writeRollout(broker.paths.home, {
      sparseBytes: OVER_INDEX,
      rows: [
        ...Array.from({ length: 30 }, (_, index) => codexUser(`h1d live row ${index}`, '2026-08-01T00:00:00.000Z')),
        // An open turn: the mid-turn production shape.
        codexTurnStarted('h1d-open-turn', '2026-08-01T00:59:00.000Z'),
      ],
    });
    const { stream: live, frame } = await attach(big);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(frame.messages.length).toBeGreaterThan(0);
    big.append([
      {
        timestamp: '2026-08-01T01:00:00.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'shell', call_id: 'h1d-live-call', input: '{"command":"echo hi"}' },
      },
      { timestamp: '2026-08-01T01:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'h1d-live-call', output: 'hi' } },
      codexAgent('h1d live assistant text', '2026-08-01T01:00:02.000Z'),
    ]);
    const isAssistant = (message: any) => message?.type === 'model-output' && String(message.text ?? '').includes('h1d live assistant text');
    const assistant = await live.waitForFrame((candidate) => candidate.kind === 'message' && isAssistant(candidate.message));
    expect(live.messages().some((message) => message.type === 'tool-call' && message.callId === 'h1d-live-call')).toBe(true);
    expect(live.messages().some((message) => message.type === 'tool-result' && message.callId === 'h1d-live-call')).toBe(true);

    const { stream: refreshed } = await attach(big);
    const copies = await eventually(() => {
      const found = windowAfterAttach(refreshed).filter(isAssistant);
      return found.length > 0 && found;
    }, { what: 'the streamed assistant text in the refreshed window' });
    expect(copies).toHaveLength(1);
    expect(copies[0].key).toBe(assistant.message.key);
    // The whole-source scan is paid once; the refresh extends it by the appended bytes.
    expect(sessionReads(broker, 'codex', big.id, 'bounded-tail-fallback')).toBe(1);
  });

  test('a row appended while the first capture runs reaches the socket once, under one identity', async () => {
    const race = writeRollout(broker.paths.home, {
      sparseBytes: OVER_INDEX,
      rows: [
        ...Array.from({ length: 10 }, (_, index) => codexUser(`h1e seed row ${index}`, '2026-08-01T00:00:00.000Z')),
        codexTurnStarted('h1e-open-turn', '2026-08-01T00:59:00.000Z'),
      ],
    });
    const deferred = `${holdFile}.deferred`;
    rmSync(deferred, { force: true });
    writeFileSync(holdFile, '1');
    let stream: SessionStream;
    try {
      stream = await broker.client().attach('codex', race.id, { artifactMode: 'reference', initialHistory: PAGE });
      streams.push(stream);
      // The session frame goes out after the live tail subscribed and before the (held) capture.
      await stream.waitForKind('session');
      race.append([codexAgent('h1e mid-capture row', '2026-08-01T01:00:00.000Z')]);
      // The tail saw the append while the capture was open, and deferred it.
      await eventually(() => existsSync(deferred), { what: 'the live tail deferring the mid-capture append' });
    } finally {
      rmSync(holdFile, { force: true });
    }
    const frame = await attachFrame(stream!);
    expectTruthful(frame);
    // The next row is the sentinel: any live copy of the raced row would have been sent before it.
    race.append([codexAgent('h1e post-adoption row', '2026-08-01T01:00:05.000Z')]);
    const isRow = (text: string) => (message: any) => message?.type === 'model-output' && String(message.text ?? '').includes(text);
    const postLive = await stream!.waitForFrame((candidate) => candidate.kind === 'message' && isRow('h1e post-adoption row')(candidate.message));
    const midCopies = stream!.messages().filter(isRow('h1e mid-capture row'));
    expect(midCopies).toHaveLength(1);

    const { stream: refreshed } = await attach(race);
    const rows = await eventually(() => {
      const window = windowAfterAttach(refreshed);
      const mid = window.filter(isRow('h1e mid-capture row'));
      const post = window.filter(isRow('h1e post-adoption row'));
      return mid.length > 0 && post.length > 0 && { mid, post };
    }, { what: 'both raced rows in the refreshed window' });
    expect(rows.mid).toHaveLength(1);
    expect(rows.post).toHaveLength(1);
    expect(rowKey(rows.mid[0])).toBe(rowKey(midCopies[0]));
    expect(rowKey(rows.post[0])).toBe(rowKey(postLive.message));
  });

  test('a tail adopted from an over-index capture continues the turn it attached inside', async () => {
    // The tail's state at its boundary comes from the capture's watermark: a steer takes the turn's
    // next ordinal, a call keeps its detail, and a historical question keeps its partial answers.
    const turn = 'h1f-open-turn';
    const questionId = 'h1f-question';
    const requestId = `codex:aq:${questionId}`;
    const reply = (index: number, question: string, answer: string) =>
      '<send_user_message_question_reply>\n' + JSON.stringify([{
        answer, question,
        questionItemId: JSON.stringify(['request_user_input_async', questionId, index]),
      }]) + '\n</send_user_message_question_reply>';
    const isResolution = (message: any) => message?.type === 'question-resolved' && message.requestId === requestId;
    const big = writeRollout(broker.paths.home, {
      sparseBytes: OVER_INDEX,
      rows: [
        codexTurnStarted(turn, '2026-08-01T00:59:00.000Z'),
        codexUser('h1f opening prompt', '2026-08-01T00:59:01.000Z'),
        {
          timestamp: '2026-08-01T00:59:02.000Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', call_id: 'h1f-call', arguments: '{"cmd":"ls h1f"}' },
        },
        {
          timestamp: '2026-08-01T00:59:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed', turn_id: turn,
            item: { type: 'AgentMessage', id: questionId, delivery: 'async', questions: [
              { title: 'Which provider?', options: ['Codex', 'Claude Code'] },
              { title: 'Which windows?', options: ['Both', 'Weekly'] },
            ] },
          },
        },
        codexUser(reply(0, 'Which provider?', 'Codex'), '2026-08-01T00:59:04.000Z'),
      ],
    });
    const { stream: live, frame } = await attach(big);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    const historicalQuestion = await eventually(() => windowAfterAttach(live).find(
      (message) => message.type === 'question-request' && message.requestId === requestId,
    ), { what: 'the partially answered historical question in the attached window' });
    expect(historicalQuestion.readOnly).toBe(true);
    expect(windowAfterAttach(live).filter(isResolution)).toHaveLength(0);
    big.append([
      codexUser('h1f steer', '2026-08-01T01:00:00.000Z'),
      { timestamp: '2026-08-01T01:00:01.000Z', type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'h1f-call', exit_code: 3 } },
      { timestamp: '2026-08-01T01:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'h1f-call', output: 'h1f failed' } },
      codexUser(reply(1, 'Which windows?', 'Both'), '2026-08-01T01:00:03.000Z'),
      codexUser('h1f reply delivered', '2026-08-01T01:00:04.000Z'),
    ]);
    const isSteer = (message: any) => message?.type === 'user-message' && message.text === 'h1f steer';
    const isResult = (message: any) => message?.type === 'tool-result' && message.callId === 'h1f-call';
    const steer = (await live.waitForFrame((candidate) => candidate.kind === 'message' && isSteer(candidate.message))).message;
    const result = (await live.waitForFrame((candidate) => candidate.kind === 'message' && isResult(candidate.message))).message;
    expect(steer.key).toBe(`codex:${turn}:u2`);
    expect(result).toMatchObject({ toolName: 'exec_command', toolClass: 'execute', isError: true, exitCode: 3 });
    expect(result.semantic).toMatchObject({ kind: 'command', command: 'ls h1f', state: 'failed' });
    // The sentinel is after the reply, so every settlement caused by that reply has arrived.
    await live.waitForFrame((candidate) => candidate.kind === 'message' && candidate.message?.text === 'h1f reply delivered');
    const resolutions = live.messages().filter(isResolution);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].answers).toEqual([['Codex'], ['Both']]);

    // A refresh reads both rows exactly as the tail delivered them.
    const { stream: refreshed } = await attach(big);
    const rows = await eventually(() => {
      const window = windowAfterAttach(refreshed);
      const steers = window.filter(isSteer);
      const results = window.filter(isResult);
      return steers.length > 0 && results.length > 0 && { steers, results };
    }, { what: 'the tailed steer and result in the refreshed window' });
    expect(rows.steers).toEqual([steer]);
    expect(rows.results).toEqual([result]);
    expect(windowAfterAttach(refreshed).filter(isResolution)).toEqual(resolutions);
  });

  // Last: it restarts the broker.
  test('after a restart the same refused history attaches the same way', async () => {
    for (const stream of streams.splice(0)) stream.close();
    await broker.restart();
    const { frame } = await attach(shared);
    expect(frame.gap?.code).toBe('HISTORY_PAGE_RESOURCE_LIMIT');
    expect(frame.reset).toBe(true);
    expect(frame.messages).toHaveLength(PAGE);
    expect(frame.hasEarlier).toBe(true);
    const { frame: resumed } = await attach(shared, { since: frame.cursor });
    expect(resumed.reset).not.toBe(true);
  });
});

describe('an ordinary history read that fails', () => {
  const SESSION = 'kilo-history-fixture';
  let broker: Broker;
  let kilo: ReturnType<typeof startFakeKiloHost>;
  const streams: SessionStream[] = [];
  const attach = async (options: { since?: string } = {}) => {
    const stream = await broker.client().attach('kilo', SESSION, {
      mode: 'observe', artifactMode: 'reference', initialHistory: PAGE, ...options,
    });
    streams.push(stream);
    return stream;
  };

  beforeAll(async () => {
    kilo = startFakeKiloHost(SESSION, '');
    kilo.rows = Array.from({ length: 520 }, (_, index) => kiloAssistantRow(SESSION, `assistant-${index}`, `Kilo history row ${index}`));
    broker = await startBroker({
      name: 'history-refusal-kilo',
      setup: (paths) => {
        installFakeKiloBinary(paths.bin);
      },
      env: (paths) => ({
        KILO_URL: kilo.url,
        KILO_SERVER_PASSWORD: 'fixture-password',
        COSYNCING_KILO_BIN: join(paths.bin, process.platform === 'win32' ? 'kilo.cmd' : 'kilo'),
      }),
    });
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    kilo?.stop();
  });

  test('a failed read keeps what the client holds and its cached pages', async () => {
    const primed = await attach();
    const frame = await attachFrame(primed);
    expect(frame.reset).toBe(true);
    expect(frame.messages).toHaveLength(PAGE);
    expect(frame.truncated?.total).toBeGreaterThan(PAGE);
    expect(typeof frame.olderCursor).toBe('string');
    primed.close();

    kilo.failNextRead();
    const refused = await attach({ since: frame.cursor });
    const refusedFrame = await attachFrame(refused);
    expect(refusedFrame.reset).toBe(false);
    expect(refusedFrame.messages).toEqual([]);
    expect(refusedFrame.cursor).toBeUndefined();
    expect(refusedFrame.hasEarlier).toBe(true);
    expect(refusedFrame.gap?.code).toBe('HISTORY_PAGE_SOURCE_CHANGED');
    const cached = await ask(refused, { kind: 'history-page', cursor: frame.olderCursor, limit: PAGE });
    expect(cached.kind).toBe('history-page');
    expect(cached.messages).toHaveLength(PAGE);
    refused.close();
  });

  test("a closed tab's late read never reaches its replacement, and its buffered prompt is dropped", async () => {
    const held = kilo.holdNextRead();
    const old = await attach();
    await old.waitForKind('session');
    await held.started;
    old.send({ kind: 'prompt', text: 'must not replay from closed bootstrap', clientMessageId: 'closed-bootstrap-prompt' });
    old.close();
    await held.aborted;

    kilo.rows = [...kilo.rows, kiloAssistantRow(SESSION, 'assistant-current', 'Kilo current replacement row')];
    kilo.touch();
    const replacement = await attach();
    const frame = await attachFrame(replacement);
    expect(frame.messages.some((message: any) => message.type === 'model-output' && message.text === 'Kilo current replacement row')).toBe(true);
    held.release();
    // Sentinel: a request answered after the held read was released.
    const page = await ask(replacement, { kind: 'history-page', cursor: frame.olderCursor, limit: 1 });
    expect(page.kind).toBe('history-page');
    expect(old.ofKind('history')).toHaveLength(0);
    expect(replacement.ofKind('history')).toHaveLength(1);
    expect(kilo.requests.filter((request) => request.startsWith('POST') && request.includes('prompt'))).toEqual([]);
  });
});
