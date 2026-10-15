/**
 * Boundaries survive the session moving forward.
 *
 * Adapters end a history with its current state (a running run summary, a
 * token reading, recomputed totals, a pending request, a prompt not yet
 * delivered, a running tool) and restate, move or drop it on the next read.
 * The boundaries a frame names count transcript rows only, so when a session
 * only moved forward (a prompt, streamed text, a tool, a turn ending), every
 * path a client takes from the boundaries it holds still works: a reconnect is
 * incremental, a refresh is served, and older and newer pages are served.
 *
 * Driven through a real broker over a fake OpenCode server (whose revision is
 * coarse and whose transcript can be read while it is being written) and over
 * the Pi bridge. Per-adapter mapping of the same rule, over every adapter's
 * native store, is the narrow `history-append-stability-adapters` test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Broker, eventually, type SessionStream, startBroker } from '../harness/index.ts';
import { ask, attachFrame, historyReadLedgerEnv, rowKey, sessionReads } from '../harness/history.ts';
import { openCodeRows as oc, type OpenCodeRow, startFakeOpenCode } from '../harness/fakes/opencode-server.ts';
import { openPiBridgeSession, type PiEvent } from '../harness/fakes/pi-bridge.ts';

const keys = (messages: any[]): string[] => (messages ?? []).map(rowKey);
const firstTurn = (): OpenCodeRow[] => [
  oc.user('msg_u1', 1_000, 'first'),
  oc.assistant('msg_a1', 'msg_u1', 2_000, [oc.text('prt_a1', 'answer one', 2_000, 2_400)], 2_500),
];
const prompt2 = () => oc.user('msg_u2', 3_000, 'second');
/** The second turn's finished state. */
const turnTwoDone = () => oc.assistant('msg_a2', 'msg_u2', 4_000, [
  oc.text('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
  oc.text('prt_a2', 'Hello world, and more', 4_200, 4_500),
  oc.tool('prt_t1', 'call_1', 'completed', 'ls'),
  oc.text('prt_a3', 'Done.', 5_000, 5_100),
], 5_200);

/** Messages delivered after the attach frame, as `type:key`. */
function afterFrame(stream: SessionStream, frame: any): string[] {
  return stream.frames.slice(stream.frames.indexOf(frame) + 1)
    .filter((candidate) => candidate.kind === 'message').map((candidate) => rowKey(candidate.message));
}

async function startOverOpenCode(name: string, fake: ReturnType<typeof startFakeOpenCode>): Promise<Broker> {
  return startBroker({ name, env: (paths) => ({ OPENCODE_URL: fake.url, ...historyReadLedgerEnv(paths) }) });
}

describe('an OpenCode session moving through a turn', () => {
  let broker: Broker;
  let fake: ReturnType<typeof startFakeOpenCode>;
  let worktree: string;
  const streams: SessionStream[] = [];
  const open = async (options: { since?: string; revision?: number } = {}) => {
    const stream = await broker.client().attach('opencode', fake.sessionId, {
      artifactMode: 'reference',
      ...(options.since ? { since: options.since } : {}),
      ...(options.revision ? { params: { contractRevision: String(options.revision) } } : {}),
    });
    streams.push(stream);
    return { stream, frame: await attachFrame(stream) };
  };
  let reader: SessionStream;
  let attach: any;
  let afterPrompt: any;
  let midTurn: any;
  let continued: any;
  let ended: any;
  let legacy: any;

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-opencode-'));
    fake = startFakeOpenCode(worktree);
    fake.setRows(firstTurn());
    broker = await startOverOpenCode('history-append-opencode', fake);
    ({ stream: reader, frame: attach } = await open());
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    fake?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  test('an idle attach ends at the finished run; the token reading and totals follow the frame', async () => {
    expect(keys(attach.messages)).toEqual(['user-message:msg_u1', 'model-output:prt_a1', 'run-summary:opencode:run:msg_a1']);
    expect(attach.newerHistory).toBe(true);
    await eventually(() => {
      const after = afterFrame(reader, attach);
      return after.includes('token-count:') && after.includes('metadata-update:runtimeTotals');
    }, { what: 'the token reading and totals after the attach frame' });
  });

  test('after one prompt the idle boundaries page newer, refresh and reconnect incrementally', async () => {
    fake.setRows([...firstTurn(), prompt2()]);
    const newer = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: attach.endCursor, limit: 100 });
    expect(newer.kind).toBe('history-page');
    expect(keys(newer.messages)).toContain('user-message:msg_u2');
    afterPrompt = await ask(reader, { kind: 'history-refresh', cursor: attach.cursor });
    expect(afterPrompt.kind).toBe('history');
    expect(afterPrompt.reset).toBe(false);
    expect(keys(afterPrompt.messages).at(-1)).toBe('user-message:msg_u2');
    const { stream, frame } = await open({ since: attach.cursor });
    expect(frame.reset).toBe(false);
    expect(keys(frame.messages).at(-1)).toBe('user-message:msg_u2');
    stream.close();
  });

  test('mid-turn, a refresh names the finished rows and holds the streaming text back', async () => {
    fake.setBusy(true);
    await reader.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'running');
    fake.setRows([...firstTurn(), prompt2(), oc.assistant('msg_a2', 'msg_u2', 4_000, [
      oc.text('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      oc.text('prt_a2', 'Hello wor', 4_200),
    ])]);
    midTurn = await ask(reader, { kind: 'history-refresh', cursor: afterPrompt.cursor });
    expect(midTurn.kind).toBe('history');
    expect(keys(midTurn.messages)).toEqual(['thinking:prt_r2']);
  });

  test('the mid-turn boundary still refreshes after the text grew; a running tool gets a reserved result', async () => {
    fake.setRows([...firstTurn(), prompt2(), oc.assistant('msg_a2', 'msg_u2', 4_000, [
      oc.text('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      oc.text('prt_a2', 'Hello world, and more', 4_200, 4_500),
      oc.tool('prt_t1', 'call_1', 'running', 'ls'),
    ])]);
    continued = await ask(reader, { kind: 'history-refresh', cursor: midTurn.cursor });
    expect(continued.kind).toBe('history');
    expect(continued.reset).toBe(false);
    expect(keys(continued.messages)).toEqual(['model-output:prt_a2', 'tool-call:call_1', 'tool-result:call_1']);
    expect(continued.messages[0].text).toBe('Hello world, and more');
    expect(continued.messages.at(-1).pending).toBe(true);
    expect(typeof continued.messages.at(-1).reloadCursor).toBe('string');
    // A client before revision 28 never receives a hidden reservation.
    ({ frame: legacy } = await open({ revision: 27 }));
    expect(legacy.messages.some((row: any) => row.type === 'tool-call')).toBe(true);
    expect(legacy.messages.every((row: any) => !row.pending)).toBe(true);
    const back = await ask(reader, { kind: 'history-page', cursor: midTurn.endCursor, limit: 100 });
    expect(back.kind).toBe('history-page');
    const forward = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, limit: 100 });
    expect(forward.kind).toBe('history-page');
    expect(keys(forward.messages)).toContain('model-output:prt_a2');
  });

  test('the boundary named beside a running tool survives the tool and the turn finishing', async () => {
    fake.setRows([...firstTurn(), prompt2(), turnTwoDone()]);
    fake.setBusy(false);
    await reader.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'idle');
    ended = await ask(reader, { kind: 'history-refresh', cursor: continued.cursor });
    expect(ended.kind).toBe('history');
    expect(ended.reset).toBe(false);
    expect(keys(ended.messages)).toEqual(['model-output:prt_a3', 'run-summary:opencode:run:msg_a2']);
    // The reserved slot reloads its completion.
    const slot = await ask(reader, { kind: 'history-page', cursor: continued.messages.at(-1).reloadCursor, limit: 1 });
    expect(slot.kind).toBe('history-page');
    expect(slot.messages).toHaveLength(1);
    expect(slot.messages[0]).toMatchObject({ pending: false, callId: 'call_1' });
    // An older client reconnecting gets a fresh snapshot carrying the completion it missed.
    const { frame: legacyAgain } = await open({ since: legacy.cursor, revision: 27 });
    expect(legacyAgain.reset).toBe(true);
    expect(legacyAgain.messages.some((row: any) => row.type === 'tool-result' && row.callId === 'call_1' && row.pending === false)).toBe(true);
    const { frame: late } = await open({ since: midTurn.cursor });
    expect(late.reset).toBe(false);
    expect(keys(late.messages)[0]).toBe('model-output:prt_a2');
  });

  test('refreshes that arrive together share one read of the grown session', async () => {
    const { stream: peer } = await open({ since: ended.cursor });
    const reads = () => sessionReads(broker, 'opencode', fake.sessionId, 'refresh');
    const before = reads();
    fake.setRows([...firstTurn(), prompt2(), turnTwoDone(), oc.user('msg_u2b', 5_500, 'aside')]);
    const probes = () => fake.requests.filter((request) => request === `GET /session/${fake.sessionId}`).length;
    const hold = fake.holdReads();
    const mine = ask(reader, { kind: 'history-refresh', cursor: ended.cursor });
    await hold.started;
    const probed = probes();
    const theirs = ask(peer, { kind: 'history-refresh', cursor: ended.cursor });
    // The second request has reached the session (its revision probe) while the first read is open.
    await eventually(() => probes() > probed, { what: "the second refresh's revision probe" });
    hold.release();
    const [a, b] = await Promise.all([mine, theirs]);
    expect(a.kind).toBe('history');
    expect(b.kind).toBe('history');
    expect(a.cursor).toBe(b.cursor);
    expect(reads()).toBe(before + 1);
    ended = a;
  });

  test('while the session writes, pages are answered from the pooled snapshot or refused as still writing', async () => {
    fake.setRows([...firstTurn(), prompt2(), turnTwoDone(), oc.user('msg_u2b', 5_500, 'aside'), oc.user('msg_u3', 6_000, 'third')]);
    fake.setWriting(true);
    // Starting at the snapshot's end: nothing it may carry, more history past it. Never an empty "more" page.
    const atEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: ended.endCursor, limit: 100 });
    expect(atEnd.kind).toBe('nack');
    expect(atEnd.code).toBe('HISTORY_PAGE_SOURCE_CHANGED');
    const into = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, limit: 100 });
    expect(into.kind).toBe('history-page');
    expect(keys(into.messages)).toEqual([
      'model-output:prt_a2', 'tool-call:call_1', 'tool-result:call_1', 'model-output:prt_a3',
      'run-summary:opencode:run:msg_a2', 'token-count:', 'user-message:msg_u2b',
    ]);
    expect(into.cursor).toBe(ended.endCursor);
    expect(into.hasMore).toBe(true);
    expect(into.endOfHistory).toBe(false);
    const pageReads = () => sessionReads(broker, 'opencode', fake.sessionId, 'page-cache-miss');
    const before = pageReads();
    const toUntil = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, until: ended.endCursor, limit: 100,
    });
    expect(toUntil.kind).toBe('history-page');
    expect(toUntil.messages).toHaveLength(7);
    expect(toUntil.cursor).toBe(ended.endCursor);
    expect(pageReads()).toBe(before);
    const writingRefresh = await ask(reader, { kind: 'history-refresh', cursor: ended.cursor });
    expect(writingRefresh.kind).toBe('history');
    expect(keys(writingRefresh.messages).at(-1)).toBe('user-message:msg_u3');
    const past = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: midTurn.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    expect(past.kind).toBe('history-page');
    expect(past.messages).toHaveLength(7);
    expect(past.cursor).toBe(ended.endCursor);
    const gapRest = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: ended.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    expect(gapRest.kind).toBe('nack');
    expect(gapRest.code).toBe('HISTORY_PAGE_SOURCE_CHANGED');
    fake.setWriting(false);
    const settled = await ask(reader, {
      kind: 'history-page', direction: 'newer', cursor: ended.endCursor, until: writingRefresh.endCursor, limit: 100,
    });
    expect(settled.kind).toBe('history-page');
    expect(keys(settled.messages)).toEqual(['user-message:msg_u3']);
    expect(settled.cursor).toBe(writingRefresh.endCursor);
    const trueEnd = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: settled.cursor, limit: 100 });
    expect(trueEnd.kind).toBe('history-page');
    expect(trueEnd.messages).toHaveLength(0);
    expect(trueEnd.cursor).toBe(settled.cursor);
    expect(trueEnd.hasMore).toBe(false);
    expect(trueEnd.endOfHistory).toBe(true);
  });
});

describe('completed outputs behind a still-running parallel call', () => {
  let broker: Broker;
  let fake: ReturnType<typeof startFakeOpenCode>;
  let worktree: string;
  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-opencode-'));
    fake = startFakeOpenCode(worktree, 'ses_parallel');
    broker = await startOverOpenCode('history-append-parallel', fake);
  });
  afterAll(async () => {
    await broker?.stop();
    fake?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  test('stay inside the frame budget and reload, whole, through paging', async () => {
    const output = 'x'.repeat(250_000);
    const tool = (callID: string, running: boolean) => ({
      id: `prt_${callID}`,
      type: 'tool',
      tool: 'bash',
      callID,
      state: running
        ? { status: 'running', input: { command: 'example' }, time: { start: 1 } }
        : { status: 'completed', input: { command: 'example' }, output, title: 'example', metadata: { exit: 0, output }, time: { start: 1, end: 2 } },
    });
    fake.setRows([
      oc.user('msg_u1', 1_000, 'run them all'),
      oc.assistant('msg_a1', 'msg_u1', 2_000, [tool('slow', true), ...Array.from({ length: 8 }, (_, index) => tool(`fast-${index}`, false))]),
    ]);
    fake.setBusy(true);
    const stream = await broker.client().attach('opencode', fake.sessionId, { artifactMode: 'reference', initialHistory: 100 });
    try {
      const frame = await attachFrame(stream);
      expect(frame.truncated).toBeDefined();
      expect(typeof frame.olderCursor).toBe('string');
      // Sentinel for "nothing more follows the frame": a refresh answered after it.
      const refresh = await ask(stream, { kind: 'history-refresh', cursor: frame.cursor });
      expect(refresh.kind).toBe('history');
      const afterwards = stream.frames.slice(stream.frames.indexOf(frame) + 1)
        .filter((candidate) => candidate.kind === 'message' && candidate.message?.type === 'tool-result' && !candidate.message.pending);
      expect(afterwards).toEqual([]);
      // Everything the frame left out reloads, one row at a time, exactly once and unclipped.
      const reloaded: any[] = [...frame.messages];
      let cursor: string | undefined = frame.olderCursor;
      for (let guard = 0; cursor && guard < 40; guard += 1) {
        const page = await ask(stream, { kind: 'history-page', cursor, limit: 1 });
        expect(page.kind).toBe('history-page');
        reloaded.unshift(...page.messages);
        cursor = page.endOfHistory ? undefined : page.cursor;
      }
      const completed = reloaded.filter((row) => row.type === 'tool-result' && !row.pending);
      expect(completed.map((row) => row.callId).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `fast-${index}`).sort());
      for (const row of completed) expect(String(row.result ?? row.output ?? '').length).toBe(output.length);
    } finally {
      stream.close();
      fake.setBusy(false);
    }
  });
});

describe("OpenCode's coarse revision", () => {
  // OpenCode moves `time.updated` only every few writes, so a snapshot pooled under the current
  // revision can miss rows written since. Nothing is answered from such a snapshot as if current.
  let broker: Broker;
  let fake: ReturnType<typeof startFakeOpenCode>;
  let worktree: string;
  const streams: SessionStream[] = [];
  const open = async () => {
    const stream = await broker.client().attach('opencode', fake.sessionId, { artifactMode: 'reference' });
    streams.push(stream);
    return { stream, frame: await attachFrame(stream) };
  };
  const reads = () => sessionReads(broker, 'opencode', fake.sessionId, 'refresh')
    + sessionReads(broker, 'opencode', fake.sessionId, 'page-cache-miss');

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-opencode-'));
    fake = startFakeOpenCode(worktree);
    fake.setRows(firstTurn());
    broker = await startOverOpenCode('history-append-coarse', fake);
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await broker?.stop();
    fake?.stop();
    rmSync(worktree, { recursive: true, force: true });
  });

  test('rows written without a revision move are never answered from the older snapshot', async () => {
    const { stream: reader, frame: attach } = await open();
    fake.setBusy(true);
    await reader.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status' && frame.message.status === 'running');
    const prompt = prompt2();
    fake.announce(prompt);
    fake.setRows([...firstTurn(), prompt]);
    const prompted = await ask(reader, { kind: 'history-refresh', cursor: attach.cursor });
    expect(keys(prompted.messages).at(-1)).toBe('user-message:msg_u2');

    // The turn writes rows without moving the revision; the event bus delivers them live.
    const answering = oc.assistant('msg_a2', 'msg_u2', 4_000, [
      oc.text('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      oc.text('prt_a2', 'Hello world.', 4_200, 4_300),
      oc.text('prt_a3', 'And mo', 4_400),
    ]);
    fake.setRowsQuietly([...firstTurn(), prompt, answering]);
    fake.announce(answering);
    await reader.waitForFrame((frame) => frame.kind === 'message' && frame.message?.key === 'prt_a2');
    const quiet = await ask(reader, { kind: 'history-refresh', cursor: prompted.cursor });
    expect(quiet.kind).toBe('history');
    expect(quiet.reset).toBe(false);
    expect(keys(quiet.messages)).toEqual(['thinking:prt_r2', 'model-output:prt_a2']);

    // More rows land before the bus says so. A second client reads the session itself, so its
    // boundaries lie past the snapshot pooled under the same revision.
    const more = oc.assistant('msg_a2', 'msg_u2', 4_000, [
      oc.text('prt_r2', 'thinking it over', 4_000, 4_100, 'reasoning'),
      oc.text('prt_a2', 'Hello world.', 4_200, 4_300),
      oc.text('prt_a3', 'And more.', 4_400, 4_500),
      oc.tool('prt_t1', 'call_1', 'completed', 'ls'),
      oc.text('prt_a4', 'Looking', 4_700),
    ]);
    fake.setRowsQuietly([...firstTurn(), prompt, more]);
    const { stream: second, frame: secondFrame } = await open();
    expect(keys(secondFrame.messages)).toContain('model-output:prt_a3');
    expect(keys(secondFrame.messages).at(-1)).toBe('tool-result:call_1');
    // The streaming text is held out of the frame and follows it.
    await eventually(() => afterFrame(second, secondFrame).includes('model-output:prt_a4'), { what: 'the held streaming text after the frame' });
    const before = reads();
    const older = await ask(second, { kind: 'history-page', cursor: secondFrame.endCursor, limit: 100 });
    expect(older.kind).toBe('history-page');
    expect(keys(older.messages)).toContain('user-message:msg_u1');
    // Every row after that end may still be rewritten by the running turn: refused as still writing.
    const newer = await ask(second, { kind: 'history-page', direction: 'newer', cursor: secondFrame.endCursor, limit: 100 });
    expect(newer.kind).toBe('nack');
    expect(newer.code).toBe('HISTORY_PAGE_SOURCE_CHANGED');
    const refreshed = await ask(second, { kind: 'history-refresh', cursor: secondFrame.cursor });
    expect(refreshed.kind).toBe('history');
    expect(refreshed.reset).toBe(false);
    expect(refreshed.messages).toHaveLength(0);
    // The stale snapshot is rebuilt once for all three.
    expect(reads()).toBe(before + 1);

    // A client whose first request after such an attach is a refresh reads the session once more.
    const stillMore = oc.assistant('msg_a2', 'msg_u2', 4_000, [
      ...more.parts.slice(0, 4),
      oc.text('prt_a4', 'Looking closer.', 4_700, 4_800),
      oc.text('prt_a5', 'Fin', 4_900),
    ]);
    fake.setRowsQuietly([...firstTurn(), prompt, stillMore]);
    const { stream: third, frame: thirdFrame } = await open();
    const thirdRefresh = await ask(third, { kind: 'history-refresh', cursor: thirdFrame.cursor });
    expect(thirdRefresh.kind).toBe('history');
    expect(thirdRefresh.reset).toBe(false);
    expect(thirdRefresh.messages).toHaveLength(0);
    expect(thirdRefresh.cursor).toBe(thirdFrame.cursor);
    // One whose first request is a page, over a row the pooled snapshot holds mid-stream, rebuilds it too.
    const lastWritten = oc.assistant('msg_a2', 'msg_u2', 4_000, [
      ...stillMore.parts.slice(0, 5),
      oc.text('prt_a5', 'Finished.', 4_900, 5_000),
      oc.text('prt_a6', 'Summar', 5_100),
    ]);
    fake.setRowsQuietly([...firstTurn(), prompt, lastWritten]);
    const { stream: fourth, frame: fourthFrame } = await open();
    const fourthPage = await ask(fourth, { kind: 'history-page', cursor: fourthFrame.endCursor, limit: 100 });
    expect(fourthPage.kind).toBe('history-page');
    expect(keys(fourthPage.messages)).toContain('user-message:msg_u1');
    const firstClient = await ask(reader, { kind: 'history-page', direction: 'newer', cursor: prompted.endCursor, limit: 100 });
    expect(firstClient.kind).toBe('history-page');
    expect(keys(firstClient.messages)).toContain('tool-result:call_1');

    // A refusal from a snapshot read for the request itself is the answer: it is not read again.
    fake.setRevert('msg_a2');
    fake.setRows([...firstTurn(), prompt]);
    const beforePage = reads();
    const revertedPage = await ask(fourth, { kind: 'history-page', cursor: fourthFrame.endCursor, limit: 100 });
    expect(revertedPage.kind).toBe('nack');
    expect(revertedPage.code).toBe('HISTORY_CURSOR_GONE');
    expect(reads()).toBe(beforePage + 1);
    fake.setRevert('msg_u2');
    fake.setRows(firstTurn());
    const beforeRefresh = reads();
    const revertedRefresh = await ask(fourth, { kind: 'history-refresh', cursor: fourthFrame.cursor });
    expect(revertedRefresh.kind).toBe('nack');
    expect(reads()).toBe(beforeRefresh + 1);
  });
});

describe('a Pi session moving through a turn', () => {
  /**
   * Each step appends what a real turn appends. From the boundaries a client held at the step
   * before, every path must work on the session after it.
   */
  const steps: Array<{ label: string; events: PiEvent[] }> = [
    { label: 'a prompt starts a turn', events: [{ t: 'status', running: true }, { t: 'user', key: 'u2', text: 'second' }, { t: 'run', key: 'run-2', turnId: 'u2', status: 'running' }] },
    { label: 'a tool finishes and totals move', events: [{ t: 'tool-result', callId: 'tool-1', name: 'bash', result: 'ok' }, { t: 'runtime-totals', value: { tokens: 10 } }] },
    { label: 'the reply streams', events: [{ t: 'delta', key: 'a2', delta: 'Hel' }, { t: 'final', key: 'a2', text: 'Hello.' }] },
    { label: 'the turn ends', events: [{ t: 'run', key: 'run-2', turnId: 'u2', status: 'done' }, { t: 'status', running: false }] },
    { label: 'the next prompt', events: [{ t: 'user', key: 'u3', text: 'third' }] },
  ];
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'history-append-pi' });
  });
  afterAll(() => broker?.stop());

  test('every boundary held before a step resolves after it', async () => {
    const session = await openPiBridgeSession(broker, [
      { t: 'user', key: 'u1', text: 'first' },
      { t: 'final', key: 'a1', text: 'answer one' },
      { t: 'run', key: 'run-1', turnId: 'u1', status: 'done' },
    ]);
    const attach = async (since?: string) => {
      const stream = await broker.client().attach('pi', session.id, { artifactMode: 'reference', ...(since ? { since } : {}) });
      return { stream, frame: await attachFrame(stream) };
    };
    let held = await attach();
    for (const step of steps) {
      const before = held.frame;
      const refreshedBefore = await ask(held.stream, { kind: 'history-refresh', cursor: before.cursor });
      expect(refreshedBefore.kind).toBe('history');
      held.stream.close();
      await session.events(step.events);
      // A fresh attach is the sentinel that the step was applied.
      const after = await attach();
      for (const [label, cursor, older] of [
        ['attach', before.cursor, before.endCursor],
        ['refresh', refreshedBefore.cursor, refreshedBefore.endCursor],
      ] as const) {
        const where = `${step.label} (${label} boundary)`;
        const { stream, frame } = await attach(cursor);
        expect({ where, reset: frame.reset, gap: frame.gap?.code }).toEqual({ where, reset: false, gap: undefined });
        const refresh = await ask(stream, { kind: 'history-refresh', cursor });
        expect({ where, kind: refresh.kind }).toEqual({ where, kind: 'history' });
        const back = await ask(stream, { kind: 'history-page', cursor: older, limit: 100 });
        expect({ where, kind: back.kind }).toEqual({ where, kind: 'history-page' });
        const forward = await ask(stream, { kind: 'history-page', direction: 'newer', cursor: older, limit: 500 });
        expect({ where, kind: forward.kind }).toEqual({ where, kind: 'history-page' });
        stream.close();
      }
      held = after;
    }
    held.stream.close();
  });
});
