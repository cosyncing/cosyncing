/**
 * Read-only observe attach: the socket handshake, the bounded pull refresh, the
 * priming boundary, and honest partial history.
 *
 * The behaviours pinned here are the ones that were wrong at least once during
 * review, so each block states the defect it guards:
 *
 *  - a lost socket must not demote the connection to poll-only forever;
 *  - a keyless row (`notice`, `file-artifact`) must dedupe by its NATIVE
 *    identity, or a second distinct notice is silently swallowed;
 *  - a foreign turn bigger than one refresh window must still emit in full,
 *    oldest-first, with a bounded backward walk;
 *  - a tick with nobody listening must issue no HTTP at all, because the read
 *    force-loads the session into the Kimi server;
 *  - an incomplete history read must SAY so — the broker turns getHistory() into
 *    an authoritative reset, so a silently short answer would quietly clear
 *    retained client history;
 *  - and the priming buffer must neither drop rows nor deliver one twice, on the
 *    row-count arm AND the timeout arm (driven by an injected clock).
 *
 * Runs against a fake server replaying SANITIZED CAPTURES from a real Kimi Code
 * 0.35.0 `kimi web` instance. No Kimi process, no model, no real waiting.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-observe.ts   (exit 0 = all pass)
 */
export {};
import { KimiAdapter } from '../src/index.ts';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiReadOnlyHttp, decodeKimiInstanceRecord, type KimiInstanceScan } from '../src/server.ts';
import {
  KIMI_WIRE_TAIL_CAP_BYTES,
  KIMI_WIRE_TICK_CAP_BYTES,
  defaultKimiWireIo,
  type KimiWireIo,
} from '../src/usage.ts';
import { KIMI_ACTIVE_GAP_CAP_MS, KIMI_ACTIVE_TIME_METHOD } from '../src/timing.ts';
import {
  KimiObserveConnection,
  KIMI_HISTORY_MAX_PAGES,
  KIMI_HISTORY_PARTIAL_NOTICE,
  KIMI_HISTORY_TRUNCATED_NOTICE,
  KIMI_HISTORY_UNAVAILABLE_NOTICE,
  KIMI_PRIMING_MAX_ROWS,
  KIMI_PRIMING_TIMEOUT_MS,
  KIMI_REFRESH_MAX_PAGES,
  KIMI_RESYNC_GAP_NOTICE,
  KIMI_RESYNC_MAX_PAGES,
  KIMI_RESYNC_RECOVERY_PASS_MAX,
  KIMI_REFRESH_PAGE_SIZE,
  KIMI_WS_FRAME_MAX_BYTES,
  kimiMessageIdentity,
  type KimiObserveTransport,
  type KimiSocketLike,
} from '../src/observe.ts';
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';

const FIXTURE = await Bun.file(new URL('./fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
  kimiVersion: string;
  sessionId: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
  instanceRecord: Record<string, unknown>;
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Fake server ─────────────────────────────────────────────────────────────

let messageCalls = 0;
let failNextMessages = false;
const messagePageRequests: Array<{ beforeId: string | null; returned: number }> = [];
/**
 * History faults and an endless source, so the honest-partial-history paths can
 * be exercised without inventing a thousand-row fixture.
 *   'fixture'  — page the real captured transcript
 *   'endless'  — every page answers has_more:true with fresh ids (ceiling case)
 * `failMessagesFromPage` fails the Nth and later requests of the current read.
 */
let historyMode: 'fixture' | 'endless' = 'fixture';
/** Bumped by a test to make the endless source yield genuinely NEW rows per read. */
let endlessGeneration = 0;
/**
 * When set, the endless source stamps every READ with its own serial, so two
 * successive walks share no row identity and neither can stop early on an
 * overlap the other created. Without it a second walk over the same generation
 * overlaps on its first page, which would let a per-frame recovery masquerade
 * as a coalesced one in the page arithmetic.
 */
let endlessFreshPerRead = false;
let endlessReadSerial = 0;
let failMessagesFromPage = Number.POSITIVE_INFINITY;
let messagesRequestsThisRead = 0;
/** One-shot: the next /messages request awaits this before answering. */
let holdNextMessages: Promise<void> | undefined;
/**
 * Called with each /messages request's `before_id` before the route answers, so
 * a test can drive the socket from INSIDE a walk — which is the only way to
 * reproduce a stream that keeps overtaking its own catch-up.
 */
let onMessagesRequest: ((beforeId: string | null) => void) | undefined;
/** The current `/status` answer, so a reading can CHANGE between poll ticks. */
let statusPayload: { code: number; msg: string; data: unknown } = FIXTURE.rest.status!;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/api/v1/healthz') return Response.json(FIXTURE.rest.healthz);
    const authorized = request.headers.get('authorization') === 'Bearer fixture-token';
    if (!authorized) return Response.json(FIXTURE.rest.metaUnauthorized, { status: 401 });
    if (url.pathname === '/api/v1/meta') return Response.json(FIXTURE.rest.meta);
    if (url.pathname === '/api/v2/sessions') return Response.json(FIXTURE.rest.v2Sessions);
    if (url.pathname === `/api/v1/sessions/${FIXTURE.sessionId}/status`) {
      return Response.json(statusPayload);
    }
    if (url.pathname === `/api/v1/sessions/${FIXTURE.sessionId}/messages`) {
      messageCalls += 1;
      if (holdNextMessages) {
        const hold = holdNextMessages;
        holdNextMessages = undefined;
        await hold;
      }
      if (failNextMessages) {
        failNextMessages = false;
        return new Response('boom', { status: 500 });
      }
      const beforeId = url.searchParams.get('before_id');
      const pageSize = Number(url.searchParams.get('page_size') ?? '100');
      if (!beforeId) {
        messagesRequestsThisRead = 0;
        endlessReadSerial += 1;
      }
      messagesRequestsThisRead += 1;
      onMessagesRequest?.(beforeId);
      if (messagesRequestsThisRead >= failMessagesFromPage) {
        return new Response('unavailable', { status: 503 });
      }
      if (historyMode === 'endless') {
        // A source deeper than any bounded read: fresh ids every page, never done.
        const page = messagesRequestsThisRead;
        const generation = endlessFreshPerRead
          ? `${endlessGeneration}r${endlessReadSerial}`
          : `${endlessGeneration}`;
        const items = Array.from({ length: pageSize }, (_unused, index) => ({
          id: `msg_endless_${generation}_${page}_${index}`,
          session_id: FIXTURE.sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: `endless ${page}.${index}` }],
          created_at: '2026-08-13T20:00:00.000Z',
        }));
        messagePageRequests.push({ beforeId, returned: items.length });
        return Response.json({
          code: 0, msg: 'success',
          data: { items, has_more: true },
          request_id: 'fixture',
        });
      }
      // Real 0.35.0 paging semantics: items are NEWEST-FIRST, `before_id` walks
      // backward from that id, and `page_size` bounds the window.
      const all = (FIXTURE.rest.messagesAll!.data as { items: Array<{ id: string }> }).items;
      const start = beforeId ? all.findIndex((item) => item.id === beforeId) + 1 : 0;
      const window = all.slice(start, start + pageSize);
      messagePageRequests.push({ beforeId, returned: window.length });
      return Response.json({
        code: 0,
        msg: 'success',
        data: { items: window, has_more: start + window.length < all.length },
        request_id: 'fixture',
      });
    }
    return Response.json(FIXTURE.rest.messagesUnknownSession);
  },
});

const listenPort = server.port ?? 0;
const baseUrl = `http://127.0.0.1:${listenPort}`;
// The registry record AS CAPTURED, with only its address redirected at the
// fake server. Its `server_id` is upstream's own and DIFFERS from the one the
// captured `/api/v1/meta` echoes — deriving either from the other is what once
// made an unsatisfiable identity gate look healthy across every Kimi suite.
const FIXTURE_RECORD = decodeKimiInstanceRecord(FIXTURE.instanceRecord)!;
const scan: KimiInstanceScan = {
  live: [{
    baseUrl,
    port: listenPort,
    pid: FIXTURE_RECORD.pid,
    serverId: FIXTURE_RECORD.serverId,
    hostVersion: FIXTURE_RECORD.hostVersion,
    startedAt: FIXTURE_RECORD.startedAt,
  }],
  stale: 0,
  invalid: 0,
  truncated: false,
};

const sockets: FakeSocket[] = [];
class FakeSocket implements KimiSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor() { sockets.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; this.fire('close', {}); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  deliver(frame: unknown): void { this.fire('message', { data: JSON.stringify(frame) }); }
}

try {
  let intervalHandler: (() => void) | undefined;
  let intervalInstalls = 0;
  let intervalClears = 0;
  const observing = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
    observe: {
      socketFactory: () => new FakeSocket(),
      setInterval: (handler) => { intervalInstalls += 1; intervalHandler = handler; return intervalInstalls; },
      clearInterval: () => { intervalClears += 1; intervalHandler = undefined; },
    },
  });

  const connection = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;

  const history = await connection.getHistory();
  check('REST backfill precedes any socket traffic',
    history.length > 0 && sockets.length === 0, `${history.length} messages`);

  const overlays = await connection.getHistoryOverlays();
  check('overlays read the status route', overlays.length > 0);

  const live: AgentMessage[] = [];
  connection.subscribe((message) => live.push(message));
  const socket = sockets[0]!;
  socket.fire('open', {});
  const opening = socket.sent.map((frame) => frame.type);
  check('attach opens with hello + subscribe + subscribe_v2',
    opening.join(',') === 'client_hello,subscribe,subscribe_v2', opening.join(','));
  check('subscribe carries a {seq, epoch}-shaped cursor',
    JSON.stringify(socket.sent[1]?.payload).includes('"seq":0'),
    JSON.stringify(socket.sent[1]?.payload));

  socket.deliver({ type: 'ping', payload: { nonce: 'n1' } });
  const pong = socket.sent.find((frame) => frame.type === 'pong');
  check('server ping is answered with the same nonce',
    !!pong && JSON.stringify(pong.payload) === '{"nonce":"n1"}');

  socket.deliver({
    type: 'ack', id: 'subscribe',
    payload: { cursors: { [FIXTURE.sessionId]: { seq: 7, epoch: 'ep_a' } } },
  });
  check('ack cursors are adopted',
    connection.observedCursor?.seq === 7 && connection.observedCursor.epoch === 'ep_a',
    JSON.stringify(connection.observedCursor));

  // A resync for ANOTHER session's journal (or the global one) says nothing
  // about ours: cursor untouched, no recovery work, no resubscribe.
  const beforeForeignResync = messageCalls;
  socket.deliver({
    type: 'resync_required',
    payload: { session_id: '__global__', reason: 'buffer_overflow', current_seq: 9_999, epoch: 'ep_global' },
  });
  socket.deliver({
    type: 'resync_required',
    payload: { session_id: 'some-other-session', reason: 'buffer_overflow', current_seq: 5_000, epoch: 'ep_x' },
  });
  await Bun.sleep(50);
  check('a foreign-journal resync is ignored entirely',
    connection.observedCursor?.seq === 7 && connection.observedCursor.epoch === 'ep_a'
      && messageCalls === beforeForeignResync
      && socket.sent.filter((frame) => frame.type === 'subscribe').length === 1,
    JSON.stringify(connection.observedCursor));

  // A real resync (server shape: session_id + current_seq + epoch). The server
  // is refusing incremental replay, so recovery must adopt the CURRENT
  // watermark and resubscribe from THERE — the old reset-to-zero recovery
  // re-asked for the refused replay and looped forever on any session more
  // than one replay buffer ahead.
  const beforeResync = messageCalls;
  socket.deliver({
    type: 'resync_required',
    payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 1_207, epoch: 'ep_b' },
  });
  await Bun.sleep(50);
  check('resync_required triggers a catch-up REST read', messageCalls > beforeResync);
  check('resync adopts the server\'s current watermark, not zero',
    connection.observedCursor?.seq === 1_207 && connection.observedCursor.epoch === 'ep_b',
    JSON.stringify(connection.observedCursor));
  const resubscribes = socket.sent.filter((frame) => frame.type === 'subscribe');
  check('resync resubscribes FROM the adopted watermark (loop-breaking property)',
    resubscribes.length === 2
      && JSON.stringify(resubscribes[1]?.payload).includes('"seq":1207')
      && JSON.stringify(resubscribes[1]?.payload).includes('"epoch":"ep_b"'),
    JSON.stringify(resubscribes[1]?.payload));
  check('a refresh over already-seen history emits nothing new', live.length === 0,
    `${live.length} duplicate messages`);

  const beforePoll = messageCalls;
  intervalHandler?.();
  await Bun.sleep(50);
  check('the poll refresh re-reads REST while observing', messageCalls > beforePoll);

  // A foreign (terminal-driven) turn: WS stays silent, the pull refresh finds it.
  const grown = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
  grown.data.items.unshift({
    id: 'msg_foreign_turn', session_id: FIXTURE.sessionId, role: 'assistant',
    content: [{ type: 'text', text: 'a turn driven in the terminal' }],
    created_at: '2026-08-13T22:00:00.000Z',
  });
  FIXTURE.rest.messagesAll = grown as never;
  intervalHandler?.();
  await Bun.sleep(50);
  check('a foreign turn surfaces through the poll refresh with no WS frame',
    live.some((m) => m.type === 'model-output' && m.text?.includes('driven in the terminal')),
    live.map((m) => m.type).join(','));

  const beforeError = live.length;
  failNextMessages = true;
  intervalHandler?.();
  await Bun.sleep(50);
  check('a failed refresh emits nothing and does not throw', live.length === beforeError);

  socket.fire('close', {});
  await Bun.sleep(50);
  check('a lost socket falls back to a REST refresh', messageCalls > beforeError + 1);

  // The poll tick owns the reopen. Before the fix, one dropped socket demoted
  // observe to poll-only for the rest of the connection.
  const socketsBeforeReopen = sockets.length;
  intervalHandler?.();
  await Bun.sleep(50);
  check('a poll tick reopens the socket after a drop',
    sockets.length === socketsBeforeReopen + 1, `sockets=${sockets.length}`);
  const reopened = sockets[sockets.length - 1]!;
  reopened.fire('open', {});
  const reopenedTypes = reopened.sent.map((frame) => frame.type);
  check('the reopened socket re-subscribes with the current cursor',
    reopenedTypes.join(',') === 'client_hello,subscribe,subscribe_v2'
      && JSON.stringify(reopened.sent[1]?.payload).includes('"epoch":"ep_b"'),
    JSON.stringify(reopened.sent[1]?.payload));
  check('a poll tick does not open a second socket while one is live',
    (intervalHandler?.(), await Bun.sleep(50), sockets.length) === socketsBeforeReopen + 1,
    `sockets=${sockets.length}`);

  // Newer servers fan out event types this round has never seen (0.36.1 adds
  // global `event.plugin.changed` / `event.capability.changed` frames to EVERY
  // connection, subscribed or not). Real envelopes are snake_case and name
  // their journal: global fan-out rides `session_id: "__global__"` (or another
  // session's id) with that journal's OWN seq/epoch. An unknown inbound frame
  // must never become a message, never provoke a frame outside the read-only
  // set, never stall the connection — and a foreign journal's watermark must
  // NEVER move this session's cursor, however large its seq.
  const cursorBeforeUnknown = { ...connection.observedCursor! };
  const liveBeforeUnknown = live.length;
  const sentBeforeUnknown = reopened.sent.length;
  reopened.deliver({ type: 'event.plugin.changed', session_id: '__global__', seq: 9_000, epoch: 'ep_global', timestamp: 't', payload: {} });
  reopened.deliver({ type: 'event.capability.changed', session_id: '__global__', seq: 9_001, epoch: 'ep_global', timestamp: 't', payload: { capability_id: 'cap', install: { running: true, percent: 5 } } });
  reopened.deliver({ type: 'event.session.work_changed', session_id: 'some-other-session', seq: 4_400, epoch: 'ep_x', timestamp: 't', payload: {} });
  reopened.deliver({ type: 'event.some.future.thing', payload: { anything: true } });
  reopened.fire('message', { data: 'not json {{{' });
  reopened.fire('message', { data: JSON.stringify(['an', 'array']) });
  await Bun.sleep(50);
  check('unknown inbound event types surface no message', live.length === liveBeforeUnknown,
    live.slice(liveBeforeUnknown).map((m) => m.type).join(','));
  check('unknown inbound event types provoke no outbound frame', reopened.sent.length === sentBeforeUnknown,
    reopened.sent.slice(sentBeforeUnknown).map((frame) => frame.type).join(','));
  check('global and foreign-session watermarks never move this session\'s cursor',
    connection.observedCursor?.seq === cursorBeforeUnknown.seq
      && connection.observedCursor.epoch === cursorBeforeUnknown.epoch,
    JSON.stringify(connection.observedCursor));
  reopened.deliver({
    type: 'event.agent.activity', session_id: FIXTURE.sessionId,
    seq: cursorBeforeUnknown.seq! + 3, epoch: cursorBeforeUnknown.epoch, timestamp: 't', payload: {},
  });
  check('this session\'s own envelopes still advance the cursor',
    connection.observedCursor?.seq === cursorBeforeUnknown.seq! + 3,
    JSON.stringify(connection.observedCursor));
  const afterNoise = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
  afterNoise.data.items.unshift({
    id: 'msg_after_unknown_noise', session_id: FIXTURE.sessionId, role: 'assistant',
    content: [{ type: 'text', text: 'a turn after unknown-event noise' }],
    created_at: '2026-08-13T22:30:00.000Z',
  });
  FIXTURE.rest.messagesAll = afterNoise as never;
  intervalHandler?.();
  await Bun.sleep(50);
  check('a real row after unknown-event noise delivers exactly once',
    live.filter((m) => m.type === 'model-output' && m.text?.includes('after unknown-event noise')).length === 1,
    live.map((m) => m.type).join(','));

  // ── The WS frame ceiling ──────────────────────────────────────────────────
  //
  // Every other input in this package is bounded AT the read — the HTTP bodies,
  // the instance records, the token file, the wire journal. A socket frame was
  // the one that reached `JSON.parse` unbounded, from a process this adapter
  // does not control. The frames below are all shaped to be consequential if
  // they were parsed: each names THIS session, carries a forward seq, and says
  // `busy:true`, so parsing one would move the cursor and emit a status row.
  // Proving the ABSENCE of both is the control.
  {
    const cursorBefore = { ...connection.observedCursor! };
    const liveBefore = live.length;
    const sentBefore = reopened.sent.length;
    const oversizedFrame = (seqValue: number, padding: string) => JSON.stringify({
      type: 'event.session.work_changed', session_id: FIXTURE.sessionId,
      seq: seqValue, epoch: cursorBefore.epoch, timestamp: 't',
      payload: { busy: true, pending_interaction: 'none', pad: padding },
    });

    const oversizedText = oversizedFrame(cursorBefore.seq! + 100, 'x'.repeat(KIMI_WS_FRAME_MAX_BYTES));
    reopened.fire('message', { data: oversizedText });
    // A binary frame is measured by `byteLength`, the same quantity: a real
    // socket delivers one as an ArrayBuffer, and an unmeasured branch would be
    // an unbounded parse wearing a different type.
    reopened.fire('message', { data: new TextEncoder().encode(oversizedText).buffer });
    // The case a `.length` check misses entirely: comfortably under the cap in
    // UTF-16 code units, comfortably over it in bytes.
    const multibyte = oversizedFrame(
      cursorBefore.seq! + 300,
      '文'.repeat(Math.ceil(KIMI_WS_FRAME_MAX_BYTES / 2)),
    );
    reopened.fire('message', { data: multibyte });
    await Bun.sleep(50);

    check('the multibyte frame is UNDER the cap by UTF-16 length and OVER it by bytes',
      multibyte.length < KIMI_WS_FRAME_MAX_BYTES
        && Buffer.byteLength(multibyte, 'utf8') > KIMI_WS_FRAME_MAX_BYTES,
      `units=${multibyte.length} bytes=${Buffer.byteLength(multibyte, 'utf8')} cap=${KIMI_WS_FRAME_MAX_BYTES}`);
    check('oversized text, binary, and multibyte frames are dropped: no message, no cursor movement',
      live.length === liveBefore
        && connection.observedCursor?.seq === cursorBefore.seq
        && connection.observedCursor.epoch === cursorBefore.epoch
        && reopened.sent.length === sentBefore,
      `rows=${live.length - liveBefore} cursor=${JSON.stringify(connection.observedCursor)}`);

    // The socket callback survived all three: a dropped frame is a dropped
    // frame, not a dead connection.
    reopened.deliver({
      type: 'event.agent.activity', session_id: FIXTURE.sessionId,
      seq: cursorBefore.seq! + 1, epoch: cursorBefore.epoch, timestamp: 't', payload: {},
    });
    check('an in-bounds frame after the dropped ones still moves the cursor',
      connection.observedCursor?.seq === cursorBefore.seq! + 1,
      JSON.stringify(connection.observedCursor));
  }

  // ── Interaction cards on the OBSERVE posture ──────────────────────────────
  //
  // The event mapping lives in the shared base, not in the drive subclass, so a
  // client watching a session that is blocked on an approval sees the CARD and
  // not merely a needs-input badge. It must arrive `readOnly: true`: this
  // connection cannot answer, and rendering answer controls the broker's
  // authority gate would then refuse is worse than rendering none.
  //
  // The frames only reach us because the subscribe grade is `off`. The server
  // SUPPRESSES every transcript-projected `session_event` for a connection
  // holding a non-`off` grade (`sessionEventBroadcaster.ts:1439-1519`), and
  // `event.approval.*`, `event.question.*`, `turn.*`, `prompt.completed` and
  // `prompt.aborted` are all in that projected set — so the `block` grade this
  // adapter used to send silently cost it every one of them.
  {
    const cardConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const cardRows: AgentMessage[] = [];
    cardConn.subscribe((message) => cardRows.push(message));
    await cardConn.getHistory();
    const cardSocket = sockets[sockets.length - 1]!;
    cardSocket.fire('open', {});
    const subscribeV2 = cardSocket.sent.find((sent) => sent.type === 'subscribe_v2');
    check('the transcript subscription asks for the `off` grade, which suppresses no event',
      JSON.stringify((subscribeV2?.payload as { transcript?: unknown } | undefined)?.transcript)
        === JSON.stringify({ '*': 'off' }),
      JSON.stringify(subscribeV2?.payload));

    // The real envelope: routing at the top level, the event nested under
    // `payload` with the broadcaster's camelCase `agentId` stamped on.
    const envelope = (type: string, payload: Record<string, unknown>) => ({
      type, seq: 8_100, epoch: 'ep_cards', session_id: FIXTURE.sessionId, timestamp: 't',
      payload: { type, agentId: 'main', sessionId: FIXTURE.sessionId, ...payload },
    });
    cardSocket.deliver(envelope('event.approval.requested', {
      approval_id: 'ap_observe', tool_call_id: 'c1', tool_name: 'Bash',
      action: 'run command', tool_input_display: { command: 'ls' }, created_at: 't',
    }));
    cardSocket.deliver(envelope('event.question.requested', {
      question_id: 'qn_observe',
      questions: [{
        id: 'q_0', question: 'Continue?',
        options: [{ id: 'opt_0_0', label: 'Yes' }, { id: 'opt_0_1', label: 'No' }],
      }],
    }));
    await Bun.sleep(30);
    const permission = cardRows.find((m) => m.type === 'permission-request');
    const question = cardRows.find((m) => m.type === 'question-request');
    check('an observe connection surfaces the approval card, non-actionable',
      permission?.type === 'permission-request' && permission.requestId === 'ap_observe'
        && permission.title === 'Bash — run command' && permission.readOnly === true,
      JSON.stringify(permission));
    check('an observe connection surfaces the question card, non-actionable',
      question?.type === 'question-request' && question.requestId === 'qn_observe'
        && question.readOnly === true
        && JSON.stringify(question.questions[0]?.options) === JSON.stringify([{ label: 'Yes' }, { label: 'No' }]),
      JSON.stringify(question));
    // No Kimi-native field name may cross the package boundary on these rows.
    check('the observe cards leak no native field name',
      !/approval_id|question_id|tool_input_display|opt_\d|multi_select|agentId/
        .test(JSON.stringify([permission, question])),
      JSON.stringify([permission, question]));

    // A turn that FAILED says so in-band; a turn that merely ended does not.
    cardSocket.deliver(envelope('turn.ended', { turnId: 3, reason: 'completed' }));
    cardSocket.deliver(envelope('turn.ended', {
      turnId: 4, reason: 'failed',
      error: { message: 'the model provider refused\nstack frame one\nstack frame two' },
    }));
    await Bun.sleep(30);
    const errors = cardRows.filter((m): m is Extract<AgentMessage, { type: 'error' }> => m.type === 'error');
    check('only a FAILED turn emits an error, bounded to its first line',
      errors.length === 1 && errors[0]?.message === 'the model provider refused',
      JSON.stringify(errors));

    // A subagent's turn describes work that has no transcript row here — the
    // REST fold this connection reads is main-agent-only — so it must not be
    // reported as this session's turn outcome.
    cardSocket.deliver({
      type: 'turn.ended', seq: 8_200, epoch: 'ep_cards', session_id: FIXTURE.sessionId, timestamp: 't',
      payload: {
        type: 'turn.ended', agentId: 'agent-7', sessionId: FIXTURE.sessionId,
        turnId: 5, reason: 'failed', error: { message: 'a subagent gave up' },
      },
    });
    await Bun.sleep(30);
    check('a SUBAGENT turn failure is not reported as this session\'s outcome',
      cardRows.filter((m) => m.type === 'error').length === 1,
      cardRows.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message).join(' | '));
    await cardConn.close();
  }

  // `notice` and `file-artifact` rows carry no key, no callId and no payload. A
  // payload-only identity collapsed every notice to one value, so the second
  // distinct one was silently swallowed.
  const noticeA = { type: 'notice' as const, message: 'first system notice' };
  const noticeB = { type: 'notice' as const, message: 'second system notice' };
  check('distinct keyless rows get distinct dedupe identities',
    kimiMessageIdentity(noticeA) !== kimiMessageIdentity(noticeB),
    `${kimiMessageIdentity(noticeA)} vs ${kimiMessageIdentity(noticeB)}`);

  const noticesSeen: string[] = [];
  const noticeConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  noticeConn.subscribe((message) => {
    if (message.type === 'notice') noticesSeen.push(message.message);
  });
  await noticeConn.getHistory(); // primes the connection, as the broker attach does
  const withNotices = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
  const systemRow = (text: string, id: string) => ({
    id, session_id: FIXTURE.sessionId, role: 'system',
    content: [{ type: 'text', text }], created_at: '2026-08-13T23:00:00.000Z',
  });
  withNotices.data.items.unshift(systemRow('first system notice', 'msg_notice_a'));
  FIXTURE.rest.messagesAll = withNotices as never;
  await noticeConn.refresh();
  const afterFirst = withNotices.data.items.slice();
  afterFirst.unshift(systemRow('second system notice', 'msg_notice_b'));
  FIXTURE.rest.messagesAll = { data: { items: afterFirst, has_more: false } } as never;
  await noticeConn.refresh();
  check('two distinct notices across two refreshes both emit',
    noticesSeen.length === 2 && noticesSeen[0] === 'first system notice'
      && noticesSeen[1] === 'second system notice',
    noticesSeen.join(' | '));
  await noticeConn.close();

  // A foreign turn larger than one refresh window. Before the fix the refresh
  // read only the newest KIMI_REFRESH_PAGE_SIZE rows and everything older than
  // that window was never emitted.
  const burstConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  await burstConn.getHistory();
  const burstSeen: string[] = [];
  burstConn.subscribe((message) => {
    if (message.type === 'model-output' && message.text?.startsWith('burst-')) burstSeen.push(message.text);
  });
  const burstBase = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
  const burst = [];
  // More rows than one page holds, so the walk is required to see the oldest.
  for (let index = KIMI_REFRESH_PAGE_SIZE + 5; index >= 1; index -= 1) {
    burst.push({
      id: `msg_burst_${index}`, session_id: FIXTURE.sessionId, role: 'assistant',
      content: [{ type: 'text', text: `burst-${index}` }],
      created_at: '2026-08-13T23:30:00.000Z',
    });
  }
  FIXTURE.rest.messagesAll = { data: { items: [...burst, ...burstBase.data.items], has_more: false } } as never;
  messagePageRequests.length = 0;
  await burstConn.refresh();
  check('a burst larger than one refresh window is fully emitted',
    burstSeen.length === KIMI_REFRESH_PAGE_SIZE + 5, `emitted=${burstSeen.length}`);
  check('the burst is emitted oldest-first',
    burstSeen[0] === 'burst-1' && burstSeen[burstSeen.length - 1] === `burst-${KIMI_REFRESH_PAGE_SIZE + 5}`,
    `${burstSeen[0]} .. ${burstSeen[burstSeen.length - 1]}`);
  check('the backward walk is bounded and stops at the first overlap',
    messagePageRequests.length > 1 && messagePageRequests.length <= KIMI_REFRESH_MAX_PAGES,
    `pages=${messagePageRequests.length}`);
  const settled = burstSeen.length;
  await burstConn.refresh();
  check('a refresh after the burst re-emits nothing', burstSeen.length === settled);
  await burstConn.close();

  // The common case must stay one request.
  const quietConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  await quietConn.getHistory();
  quietConn.subscribe(() => {});
  messagePageRequests.length = 0;
  await quietConn.refresh();
  check('an overlapping refresh costs exactly one request',
    messagePageRequests.length === 1, `pages=${messagePageRequests.length}`);
  await quietConn.close();

  // Greater-than-buffer recovery: the server refuses incremental replay
  // (`buffer_overflow`) and the session is so deep that even the resync
  // catch-up ceiling cannot reconnect the view to known rows. Recovery must
  // adopt the server's watermark, say the gap out loud IN-BAND exactly once,
  // and resubscribe from the adopted position — never loop on seq 0.
  const deepConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  const deepNotices: string[] = [];
  await deepConn.getHistory(); // primed: the gap notice applies only to a live view
  deepConn.subscribe((message) => {
    if (message.type === 'notice') deepNotices.push(message.message);
  });
  const deepSocket = sockets[sockets.length - 1]!;
  historyMode = 'endless';
  endlessGeneration += 1;
  messagePageRequests.length = 0;
  deepSocket.deliver({
    type: 'resync_required',
    payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 50_000, epoch: 'ep_deep' },
  });
  await Bun.sleep(200);
  check('an unbridgeable gap emits exactly one in-band gap notice',
    deepNotices.filter((text) => text === KIMI_RESYNC_GAP_NOTICE).length === 1,
    deepNotices.join(' | '));
  check('the resync catch-up walk is bounded at its own ceiling',
    messagePageRequests.length === KIMI_RESYNC_MAX_PAGES, `pages=${messagePageRequests.length}`);
  const deepResubscribes = deepSocket.sent.filter((frame) => frame.type === 'subscribe');
  check('recovery resubscribes from the adopted deep watermark',
    deepResubscribes.length >= 1
      && JSON.stringify(deepResubscribes[deepResubscribes.length - 1]?.payload).includes('"seq":50000')
      && JSON.stringify(deepResubscribes[deepResubscribes.length - 1]?.payload).includes('"epoch":"ep_deep"'),
    JSON.stringify(deepResubscribes[deepResubscribes.length - 1]?.payload));
  // The server repeats the SAME verdict (same watermark): the catch-up now
  // overlaps rows the first one delivered, so no second notice appears.
  deepSocket.deliver({
    type: 'resync_required',
    payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 50_000, epoch: 'ep_deep' },
  });
  await Bun.sleep(200);
  check('a repeated identical resync does not duplicate the gap notice',
    deepNotices.filter((text) => text === KIMI_RESYNC_GAP_NOTICE).length === 1,
    `notices=${deepNotices.length}`);
  // A LATER unbridged gap (new content, higher watermark) is its own incident
  // and gets its own notice.
  endlessGeneration += 1;
  deepSocket.deliver({
    type: 'resync_required',
    payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 61_000, epoch: 'ep_deep' },
  });
  await Bun.sleep(200);
  check('a later unbridged gap surfaces as its own notice',
    deepNotices.filter((text) => text === KIMI_RESYNC_GAP_NOTICE).length === 2,
    `notices=${deepNotices.length}`);
  historyMode = 'fixture';
  await deepConn.close();

  // A resync arriving while a poll refresh is mid-flight must WAIT for the
  // slot and still run its deep walk. The old recovery skipped the walk when
  // the slot was busy, adopted the watermark, and resubscribed straight past
  // the gap — a permanent, unreported hole in the live view.
  {
    const blockedConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const blockedNotices: string[] = [];
    await blockedConn.getHistory();
    blockedConn.subscribe((message) => {
      if (message.type === 'notice') blockedNotices.push(message.message);
    });
    const blockedSocket = sockets[sockets.length - 1]!;
    blockedSocket.fire('open', {});
    const subscribesBefore = blockedSocket.sent.filter((frame) => frame.type === 'subscribe').length;
    let releasePoll: () => void = () => {};
    holdNextMessages = new Promise((resolve) => { releasePoll = resolve; });
    const callsBefore = messageCalls;
    intervalHandler?.(); // the poll refresh takes the walk slot, blocked on its first page
    await Bun.sleep(30);
    blockedConn.refresh(); // a coalesced poll while held must stay a no-op
    blockedSocket.deliver({
      type: 'resync_required',
      payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 70_000, epoch: 'ep_wait' },
    });
    await Bun.sleep(60);
    check('recovery waits for the in-flight refresh instead of skipping its walk',
      blockedSocket.sent.filter((frame) => frame.type === 'subscribe').length === subscribesBefore,
      `subscribes=${blockedSocket.sent.filter((frame) => frame.type === 'subscribe').length}`);
    releasePoll();
    await Bun.sleep(200);
    const blockedResubs = blockedSocket.sent.filter((frame) => frame.type === 'subscribe');
    check('after the blocked refresh the deep walk runs and only THEN resubscribes',
      blockedResubs.length === subscribesBefore + 1
        && JSON.stringify(blockedResubs[blockedResubs.length - 1]?.payload).includes('"seq":70000')
        && messageCalls > callsBefore + 1,
      `resubs=${blockedResubs.length} calls=${messageCalls - callsBefore}`);
    check('a bridgeable gap behind a blocked poll needs no notice',
      blockedNotices.length === 0, blockedNotices.join(' | '));
    await blockedConn.close();
  }

  // A close DURING recovery must stop the deep walk where it stands. Every
  // remaining page is an active REST read that force-loads the session into the
  // Kimi server, and after close there is nobody left to receive what it finds:
  // handlers are cleared and the resubscribe is guarded. Without the check the
  // walk kept spending up to KIMI_RESYNC_MAX_PAGES reads on a dead observer.
  {
    const closingConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    await closingConn.getHistory();
    closingConn.subscribe(() => {});
    const closingSocket = sockets[sockets.length - 1]!;
    closingSocket.fire('open', {});
    const subscribesBefore = closingSocket.sent.filter((frame) => frame.type === 'subscribe').length;
    historyMode = 'endless'; // no overlap ever, so the walk would run its whole ceiling
    endlessGeneration += 1;
    let releaseWalk: () => void = () => {};
    holdNextMessages = new Promise((resolve) => { releaseWalk = resolve; });
    closingSocket.deliver({
      type: 'resync_required',
      payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 90_000, epoch: 'ep_close' },
    });
    await Bun.sleep(30); // recovery is now blocked inside its first page
    const callsAtHold = messageCalls;
    await closingConn.close();
    releaseWalk();
    await Bun.sleep(200);
    check('a close during recovery stops the walk at the page it was holding',
      messageCalls === callsAtHold,
      `pages after close=${messageCalls - callsAtHold} ceiling=${KIMI_RESYNC_MAX_PAGES}`);
    check('a close during recovery sends no resubscribe',
      closingSocket.sent.filter((frame) => frame.type === 'subscribe').length === subscribesBefore,
      `subscribes=${closingSocket.sent.filter((frame) => frame.type === 'subscribe').length}`);
    historyMode = 'fixture';
  }

  // The SAME discipline on the history backfill, whose first page can be slow
  // enough for a close to land inside it. Without the check the remaining nine
  // pages still ran — nine force-loading reads for a dead observer — and the
  // seeding and priming that follow mutated a connection nobody holds. A close
  // is an aborted read: it must present as one, never as a short session.
  {
    const heldConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    historyMode = 'endless'; // the read would otherwise run its whole ceiling
    endlessGeneration += 1;
    let releaseHistory: () => void = () => {};
    holdNextMessages = new Promise((resolve) => { releaseHistory = resolve; });
    const pending = heldConn.getHistory();
    await Bun.sleep(30); // the backfill is now blocked inside its FIRST page
    const callsAtHold = messageCalls;
    await heldConn.close();
    releaseHistory();
    const held = await pending;
    await Bun.sleep(100);
    historyMode = 'fixture';
    check('a close during the history backfill spends no further page reads',
      messageCalls === callsAtHold,
      `pages after close=${messageCalls - callsAtHold} ceiling=${KIMI_HISTORY_MAX_PAGES}`);
    check('a history read aborted by close reports unavailable, not a short session',
      held.length === 1 && held[0]?.type === 'notice'
        && held[0].message === KIMI_HISTORY_UNAVAILABLE_NOTICE,
      JSON.stringify(held));
  }

  // A REST failure DURING recovery is an INCOMPLETE recovery: the resubscribe
  // advances past whatever was missed, so the gap notice must come first.
  {
    const errConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const errNotices: string[] = [];
    await errConn.getHistory();
    errConn.subscribe((message) => {
      if (message.type === 'notice') errNotices.push(message.message);
    });
    const errSocket = sockets[sockets.length - 1]!;
    errSocket.fire('open', {});
    failNextMessages = true; // the recovery's first (and only) page read fails
    errSocket.deliver({
      type: 'resync_required',
      payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 80_000, epoch: 'ep_fail' },
    });
    await Bun.sleep(100);
    check('a failed recovery read emits the gap notice',
      errNotices.filter((text) => text === KIMI_RESYNC_GAP_NOTICE).length === 1,
      errNotices.join(' | '));
    const errResubs = errSocket.sent.filter((frame) => frame.type === 'subscribe');
    check('the failed recovery still resubscribes from the adopted watermark',
      errResubs.length >= 2
        && JSON.stringify(errResubs[errResubs.length - 1]?.payload).includes('"seq":80000'),
      JSON.stringify(errResubs[errResubs.length - 1]?.payload));
    await errConn.close();
  }

  // A resync whose `current_seq` is absent or unusable carries NO watermark.
  // Falling back to zero recreates the exact loop the whole recovery exists to
  // break: seq 0 on a busy session is the precise replay the server just
  // refused. Failing closed uses the server's own semantics instead — a
  // subscribe carrying no cursor entry for the session replays nothing, and its
  // ack answers with the server's current position.
  for (const [label, malformed] of [
    ['absent', { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', epoch: 'ep_bad' }],
    ['non-numeric', { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 'garbage', epoch: 'ep_bad' }],
  ] as const) {
    const badConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    await badConn.getHistory();
    badConn.subscribe(() => {});
    const badSocket = sockets[sockets.length - 1]!;
    badSocket.fire('open', {});
    const subscribesBefore = badSocket.sent.filter((frame) => frame.type === 'subscribe').length;
    badSocket.deliver({ type: 'resync_required', payload: malformed });
    await Bun.sleep(150);
    const badResubs = badSocket.sent.filter((frame) => frame.type === 'subscribe');
    const newest = badResubs[badResubs.length - 1];
    const newestCursors = (newest?.payload as { cursors?: Record<string, unknown> } | undefined)?.cursors ?? {};
    check(`a malformed resync watermark (${label}) resubscribes with no cursor at all`,
      badResubs.length === subscribesBefore + 1
        && !(FIXTURE.sessionId in newestCursors)
        && !JSON.stringify(newest?.payload).includes('"seq":0'),
      JSON.stringify(newest?.payload));
    // The ack answering a cursor-less subscribe carries the server's own
    // watermark, and that is what re-seeds a real position.
    badSocket.deliver({
      type: 'ack', id: 'resubscribe',
      payload: { cursors: { [FIXTURE.sessionId]: { seq: 4_321, epoch: 'ep_ack' } } },
    });
    check(`the ack after a cleared cursor (${label}) seeds the server's position`,
      badConn.observedCursor?.seq === 4_321 && badConn.observedCursor.epoch === 'ep_ack',
      JSON.stringify(badConn.observedCursor));
    badSocket.deliver({
      type: 'event.agent.activity', session_id: FIXTURE.sessionId,
      seq: 4_322, epoch: 'ep_ack', timestamp: 't', payload: {},
    });
    check(`a later owned envelope (${label}) advances the re-seeded cursor`,
      badConn.observedCursor?.seq === 4_322,
      JSON.stringify(badConn.observedCursor));
    await badConn.close();
  }

  // Concurrent resync frames are ONE incident. Each frame has already adopted
  // its watermark by the time recovery runs, so a per-frame recovery spends N
  // deep walks and N resubscribes to reach the position the newest frame
  // already named. The walks here never overlap (endless source, fresh ids per
  // read), so each one that runs costs its full ceiling and the arithmetic is
  // unambiguous.
  {
    const coalesceConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    await coalesceConn.getHistory();
    coalesceConn.subscribe(() => {});
    const coalesceSocket = sockets[sockets.length - 1]!;
    coalesceSocket.fire('open', {});
    const subscribesBefore = coalesceSocket.sent.filter((frame) => frame.type === 'subscribe').length;
    historyMode = 'endless';
    endlessFreshPerRead = true;
    endlessGeneration += 1;
    let releaseWalk: () => void = () => {};
    holdNextMessages = new Promise((resolve) => { releaseWalk = resolve; });
    for (const seq of [70_001, 70_002, 70_003]) {
      coalesceSocket.deliver({
        type: 'resync_required',
        payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: seq, epoch: 'ep_coalesce' },
      });
    }
    await Bun.sleep(30); // the first recovery holds the slot, blocked on page one
    const callsAtHold = messageCalls;
    releaseWalk();
    await Bun.sleep(600);
    historyMode = 'fixture';
    endlessFreshPerRead = false;
    const coalesceResubs = coalesceSocket.sent.filter((frame) => frame.type === 'subscribe');
    check('a burst of resync frames ends in exactly one resubscribe, from the newest watermark',
      coalesceResubs.length === subscribesBefore + 1
        && JSON.stringify(coalesceResubs[coalesceResubs.length - 1]?.payload).includes('"seq":70003'),
      `resubs=${coalesceResubs.length - subscribesBefore} ${JSON.stringify(coalesceResubs[coalesceResubs.length - 1]?.payload)}`);
    const spent = messageCalls - callsAtHold;
    check('a burst of resync frames costs one coalesced re-walk, not one per frame',
      spent <= 2 * KIMI_RESYNC_MAX_PAGES,
      `pages after release=${spent}; coalesced <= 2 x ${KIMI_RESYNC_MAX_PAGES} = ${2 * KIMI_RESYNC_MAX_PAGES}`
      + ` (the held walk plus one covering all three frames), per-frame would spend 3 x ${KIMI_RESYNC_MAX_PAGES} = ${3 * KIMI_RESYNC_MAX_PAGES}`);
    await coalesceConn.close();
  }

  // start() runs again whenever the handler count rises to 1, and unsubscribing
  // leaves the machinery up, so a subscribe/unsubscribe/subscribe cycle used to
  // install a second interval and orphan the first.
  const installsBeforeCycle = intervalInstalls;
  const cycleConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  const unsubscribeFirst = cycleConn.subscribe(() => {});
  unsubscribeFirst();
  const unsubscribeSecond = cycleConn.subscribe(() => {});
  check('subscribe → unsubscribe → subscribe installs exactly one interval',
    intervalInstalls === installsBeforeCycle + 1,
    `installs=${intervalInstalls - installsBeforeCycle}`);
  const clearsBeforeCycle = intervalClears;
  await cycleConn.close();
  check('close clears the one interval that was installed',
    intervalClears === clearsBeforeCycle + 1, `clears=${intervalClears - clearsBeforeCycle}`);
  unsubscribeSecond();

  // A tick with nobody listening must not force-load the session.
  const guardConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
  await guardConn.getHistory();
  const unsubscribeGuard = guardConn.subscribe(() => {});
  const guardTick = intervalHandler;
  unsubscribeGuard();
  const callsBeforeQuietTick = messageCalls;
  guardTick?.();
  await Bun.sleep(50);
  check('a tick with zero handlers issues no HTTP request',
    messageCalls === callsBeforeQuietTick, `calls=${messageCalls - callsBeforeQuietTick}`);
  guardConn.subscribe(() => {});
  guardTick?.();
  await Bun.sleep(50);
  check('after re-subscribing the next tick refreshes again',
    messageCalls > callsBeforeQuietTick, `calls=${messageCalls - callsBeforeQuietTick}`);
  await guardConn.close();

  // ── Honest partial history ────────────────────────────────────────────────

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    failMessagesFromPage = 1; // the very first page fails
    const failedHistory = await conn.getHistory();
    failMessagesFromPage = Number.POSITIVE_INFINITY;
    check('a first-page failure is not reported as an empty session',
      failedHistory.length === 1 && failedHistory[0]?.type === 'notice'
        && failedHistory[0].message === KIMI_HISTORY_UNAVAILABLE_NOTICE,
      JSON.stringify(failedHistory));
    await conn.close();
  }

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    historyMode = 'endless'; // a source with more than one page to fail part way through
    failMessagesFromPage = 2; // first page succeeds, the read then breaks
    const partial = await conn.getHistory();
    failMessagesFromPage = Number.POSITIVE_INFINITY;
    historyMode = 'fixture';
    const notice = partial[0];
    check('a mid-read failure says the history is incomplete',
      notice?.type === 'notice' && notice.message === KIMI_HISTORY_PARTIAL_NOTICE,
      JSON.stringify(notice));
    check('a mid-read failure still returns what it did read',
      partial.length > 1 && partial.some((m) => m.type === 'model-output'),
      `${partial.length} rows`);
    await conn.close();
  }

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    historyMode = 'endless';
    messagePageRequests.length = 0;
    const truncated = await conn.getHistory();
    historyMode = 'fixture';
    const notice = truncated[0];
    check('a session past the page ceiling signals a gap, not a false start',
      notice?.type === 'notice' && notice.message === KIMI_HISTORY_TRUNCATED_NOTICE,
      JSON.stringify(notice));
    check('the ceiling read stays bounded',
      messagePageRequests.length === KIMI_HISTORY_MAX_PAGES,
      `pages=${messagePageRequests.length}`);
    await conn.close();
  }

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const complete = await conn.getHistory();
    check('a complete history carries no notice',
      !complete.some((m) => m.type === 'notice'
        && [KIMI_HISTORY_UNAVAILABLE_NOTICE, KIMI_HISTORY_PARTIAL_NOTICE, KIMI_HISTORY_TRUNCATED_NOTICE]
          .includes(m.message)),
      `${complete.length} rows`);
    await conn.close();
  }

  // ── Priming boundary ──────────────────────────────────────────────────────
  //
  // The broker subscribes BEFORE it reads history, so a tick landing in that
  // window would otherwise emit rows the history reset then repeats. (The
  // ordering itself is proved end-to-end against a real ManagedConn in the
  // broker-side suite; here the buffer's own arithmetic is pinned.)

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const seenRows: AgentMessage[] = [];
    conn.subscribe((message) => seenRows.push(message));
    await conn.refresh();
    check('an unprimed connection buffers rather than dropping', seenRows.length === 0);
    check('the priming buffer is bounded and documented',
      KIMI_PRIMING_MAX_ROWS > 0 && KIMI_PRIMING_TIMEOUT_MS > 0,
      `rows<=${KIMI_PRIMING_MAX_ROWS} or ${KIMI_PRIMING_TIMEOUT_MS}ms`);
    // Priming releases the buffer MINUS whatever history already carried. Here
    // the refresh read the same transcript history is about to return, so the
    // correct release count is zero: every buffered row was already delivered
    // inside the authoritative reset, and re-emitting one would be the exact
    // duplicate the boundary exists to prevent.
    const reset = await conn.getHistory();
    check('priming drops buffered rows the history reset already carried',
      seenRows.length === 0 && reset.length > 0,
      `released=${seenRows.length} reset=${reset.length}`);

    // Once primed, delivery resumes directly: a genuinely new row goes live.
    const restore = FIXTURE.rest.messagesAll;
    const afterPriming = structuredClone(FIXTURE.rest.messagesAll) as { data: { items: Array<Record<string, unknown>> } };
    afterPriming.data.items.unshift({
      id: 'msg_after_priming', session_id: FIXTURE.sessionId, role: 'assistant',
      content: [{ type: 'text', text: 'arrived after priming' }],
      created_at: '2026-08-14T00:00:00.000Z',
    });
    FIXTURE.rest.messagesAll = afterPriming as never;
    await conn.refresh();
    FIXTURE.rest.messagesAll = restore;
    check('a post-priming row is delivered live, exactly once',
      seenRows.filter((m) => m.type === 'model-output' && m.text?.includes('arrived after priming')).length === 1,
      `${seenRows.length} live rows`);
    await conn.close();
  }

  // Crossing the priming cap must not duplicate a row. Buffering DISTINCT rows
  // only means a repeating refresh no longer fills the buffer, so both shapes
  // are covered: identical refreshes stay deduped, and a genuinely growing
  // source crosses the cap without delivering anything twice.
  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const delivered: string[] = [];
    conn.subscribe((message) => delivered.push(JSON.stringify(message)));
    historyMode = 'endless';
    endlessGeneration = 0;
    for (let round = 0; round < 40; round += 1) await conn.refresh(); // identical rows every time
    // Prime against the FIXTURE transcript, so the buffered endless rows are not
    // simply seeded away by history and the flush is actually observed.
    historyMode = 'fixture';
    await conn.getHistory();
    const perRefresh = KIMI_REFRESH_PAGE_SIZE * KIMI_REFRESH_MAX_PAGES;
    check('repeated identical refreshes deliver each row exactly once',
      delivered.length > 0
        && delivered.length === new Set(delivered).size
        && delivered.length <= perRefresh,
      `delivered=${delivered.length} unique=${new Set(delivered).size} oneRefresh=${perRefresh}`);
    await conn.close();
  }

  {
    const conn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const delivered: string[] = [];
    conn.subscribe((message) => delivered.push(JSON.stringify(message)));
    historyMode = 'endless';
    // Each round yields new ids, so the buffer genuinely grows past the cap.
    const perRound = KIMI_REFRESH_PAGE_SIZE * KIMI_REFRESH_MAX_PAGES;
    const rounds = Math.ceil(KIMI_PRIMING_MAX_ROWS / perRound) + 3;
    for (let round = 0; round < rounds; round += 1) {
      endlessGeneration = round + 1;
      await conn.refresh();
    }
    historyMode = 'fixture';
    check('crossing the priming cap delivers no duplicate',
      delivered.length > KIMI_PRIMING_MAX_ROWS
        && delivered.length === new Set(delivered).size,
      `delivered=${delivered.length} unique=${new Set(delivered).size} cap=${KIMI_PRIMING_MAX_ROWS}`);

    // The row that TRIPS the breach is genuinely new here, so it must arrive —
    // exactly once. Delivering it unconditionally was the defect; dropping it
    // would be the opposite one.
    const before = delivered.length;
    endlessGeneration = 9_999;
    await conn.refresh();
    const fresh = delivered.slice(before);
    check('a genuinely new row after the breach is delivered exactly once',
      fresh.length > 0 && fresh.length === new Set(fresh).size,
      `new=${fresh.length} unique=${new Set(fresh).size}`);
    await conn.close();
  }

  // The cap's TIMEOUT arm, deterministic via the injected clock: a caller that
  // never reads history must get its buffered rows once the window ages out,
  // and the row that trips the timeout takes the same seen-gate as the flush.
  {
    let clock = 0;
    const page = (items: Array<Record<string, unknown>>) => JSON.stringify(
      { code: 0, msg: 'success', data: { items, has_more: false }, request_id: 'r' });
    const row = (id: string, text: string, at: number) => (
      { id, session_id: 's-timeout', role: 'assistant', content: [{ type: 'text', text }], created_at: at });
    let body = page([row('m2', 'aged two', 2), row('m1', 'aged one', 1)]);
    const timeoutHttp = new KimiReadOnlyHttp({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => ({ status: 200, text: async () => body }),
    });
    const conn = new KimiObserveConnection(
      {
        id: 's-timeout', tool: 'kimi', title: 's-timeout', status: 'idle',
        attachMode: 'observe', launchSurface: 'unknown',
        control: {
          drive: { state: 'observing', supported: false, reason: 'kimi-observe-only' },
          terminalSync: { supported: false, syncAvailable: false, active: false, reason: 'kimi-observe-only' },
        },
      },
      timeoutHttp, 'ws://127.0.0.1:1/api/v1/ws', undefined,
      {
        socketFactory: () => { throw new Error('no socket'); },
        setInterval: () => 0, clearInterval: () => {},
        now: () => clock,
      },
    );
    const delivered: string[] = [];
    conn.subscribe((message) => delivered.push(JSON.stringify(message)));
    await conn.refresh();
    check('timeout arm: rows buffer while the window is young', delivered.length === 0);
    clock = KIMI_PRIMING_TIMEOUT_MS + 1;
    body = page([row('m3', 'trips the timeout', 3), row('m2', 'aged two', 2), row('m1', 'aged one', 1)]);
    await conn.refresh();
    check('timeout arm: aged buffer flushes and the tripping row arrives exactly once',
      delivered.length === 3 && delivered.length === new Set(delivered).size,
      `delivered=${delivered.length} unique=${new Set(delivered).size}`);
    await conn.refresh();
    check('timeout arm: a repeat refresh after the flush re-delivers nothing',
      delivered.length === 3, `delivered=${delivered.length}`);
    await conn.close();
  }

  // ── Status overlays stay fresh while the session is open ──────────────────
  //
  // Overlays were read at ATTACH only, so the context reading went stale the
  // moment the session took another turn and stayed stale for the whole
  // observe. The reading now travels in its own identity: a CHANGED one emits,
  // an unchanged one dedupes, and the attach's own delivery is not repeated.

  {
    const statusConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const statusRows: AgentMessage[] = [];
    statusConn.subscribe((message) => statusRows.push(message));
    const statusTick = intervalHandler;
    await statusConn.getHistory();
    const overlayRows = (key: string) => statusRows.filter(
      (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
        message.type === 'metadata-update' && message.key === key);

    const attached = await statusConn.getHistoryOverlays();
    const attachedInfo = attached.find(
      (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
        message.type === 'metadata-update' && message.key === 'sessionInfo');
    check('the status overlay carries the session modes, not the model alone',
      JSON.stringify(attachedInfo?.value) === JSON.stringify({
        model: 'kimi-code/k3-256k',
        thinkingLevel: 'high',
        // `currentMode` is the CONTRACT field the mode picker preselects from.
        // Under any other name the broker still assigns the value onto the
        // session info, where nothing declares it and nothing reads it.
        currentMode: 'manual',
        planMode: false,
        swarmMode: false,
      }),
      JSON.stringify(attachedInfo?.value));

    statusTick?.();
    await Bun.sleep(60);
    check('a tick repeats no overlay the attach already delivered',
      overlayRows('contextUsage').length === 0 && overlayRows('sessionInfo').length === 0,
      `context=${overlayRows('contextUsage').length} info=${overlayRows('sessionInfo').length}`);

    const base = FIXTURE.rest.status!.data as Record<string, unknown>;
    statusPayload = {
      ...FIXTURE.rest.status!,
      data: { ...base, context_tokens: 12_345, thinking_level: 'low' },
    };
    statusTick?.();
    await Bun.sleep(60);
    check('a changed context reading is emitted, exactly once',
      overlayRows('contextUsage').length === 1
        && JSON.stringify(overlayRows('contextUsage')[0]?.value)
          === JSON.stringify({ used: 12_345, max: 262_144 }),
      JSON.stringify(overlayRows('contextUsage').map((row) => row.value)));
    check('a changed mode re-emits the enriched session info, exactly once',
      overlayRows('sessionInfo').length === 1
        && (overlayRows('sessionInfo')[0]?.value as { thinkingLevel?: string }).thinkingLevel === 'low',
      JSON.stringify(overlayRows('sessionInfo').map((row) => row.value)));

    statusTick?.();
    await Bun.sleep(60);
    check('a tick with an unchanged reading emits nothing new',
      overlayRows('contextUsage').length === 1 && overlayRows('sessionInfo').length === 1,
      `context=${overlayRows('contextUsage').length} info=${overlayRows('sessionInfo').length}`);
    await statusConn.close();
    statusPayload = FIXTURE.rest.status!;
  }

  // A reading that RETURNS to an earlier value is still news. contextUsage going
  // 100k → 60k → 100k is what a compaction followed by a refilling window looks
  // like, and with the reading hashed into its identity the third one landed on
  // an identity the seen-set already held: suppressed for the rest of the
  // connection, leaving the client on a stale figure with no way to learn
  // otherwise. Revisioned identities make a changed reading unsuppressable while
  // an unchanged one never reaches the gate at all.
  {
    const returnConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const returnRows: AgentMessage[] = [];
    returnConn.subscribe((message) => returnRows.push(message));
    const returnTick = intervalHandler;
    await returnConn.getHistory();
    const base = FIXTURE.rest.status!.data as Record<string, unknown>;
    const readContext = async (used: number) => {
      statusPayload = { ...FIXTURE.rest.status!, data: { ...base, context_tokens: used } };
      returnTick?.();
      await Bun.sleep(60);
    };
    const contextReadings = () => returnRows.filter(
      (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
        message.type === 'metadata-update' && message.key === 'contextUsage')
      .map((row) => (row.value as { used: number }).used).join(',');

    await readContext(100_000);
    await readContext(60_000);
    await readContext(100_000); // byte-identical to the first
    check('a context reading that returns to an earlier value is delivered again, in order',
      contextReadings() === '100000,60000,100000', contextReadings());
    await readContext(100_000);
    check('an unchanged consecutive reading still emits nothing',
      contextReadings() === '100000,60000,100000', contextReadings());
    await returnConn.close();
    statusPayload = FIXTURE.rest.status!;
  }

  // ── Usage and timing from the wire journal ────────────────────────────────
  //
  // The REST projections carry `usage: emptySessionUsage()`, so the on-disk
  // journal is the ONLY source of a real token count. Two properties decide
  // whether reading it helps or hurts: the journal's history is a BASELINE
  // (emitting it as rows would flood an attach with the whole session's meter
  // readings), and the two time figures must stay distinguishable — a subagent
  // adds agent work without adding wall clock.

  {
    const wireHome = mkdtempSync(join(tmpdir(), 'kimi-observe-wire-'));
    const wireRoot = join(wireHome, 'sessions');
    const agentsDirectory = join(wireRoot, 'wd_observe_0001', FIXTURE.sessionId, 'agents');
    const wireOf = (stream: string) => join(agentsDirectory, stream, 'wire.jsonl');
    const usageRow = (time: number, counts: {
      inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number;
    }) => `${JSON.stringify({
      type: 'usage.record', model: 'kimi-code/k3', usage: counts, usageScope: 'turn', time,
    })}\n`;
    const writeStream = (stream: string, body: string) => {
      mkdirSync(join(agentsDirectory, stream), { recursive: true });
      writeFileSync(wireOf(stream), body);
    };

    try {
      // The subagent works entirely INSIDE the main stream's span: one minute of
      // parallel work, adding agentMs and no activeMs at all.
      const base = 1_700_000_000_000;
      const mainCounts = { inputOther: 100, output: 10, inputCacheRead: 1_000, inputCacheCreation: 5 };
      const subCounts = { inputOther: 50, output: 5, inputCacheRead: 500, inputCacheCreation: 0 };
      writeStream('main', [0, 60_000, 120_000].map((offset) => usageRow(base + offset, mainCounts)).join(''));
      writeStream('agent-1', [30_000, 90_000].map((offset) => usageRow(base + offset, subCounts)).join(''));

      let telemetryTick: (() => void) | undefined;
      let wireOpens = 0;
      const countingIo: KimiWireIo = {
        ...defaultKimiWireIo,
        openRead: (path) => {
          wireOpens += 1;
          return defaultKimiWireIo.openRead(path);
        },
      };
      const telemetryAdapter = new KimiAdapter({
        env: {}, homeDir: '/fixture/home',
        instanceScan: () => scan,
        readToken: () => 'fixture-token',
        observe: {
          socketFactory: () => new FakeSocket(),
          setInterval: (handler) => { telemetryTick = handler; return 1; },
          clearInterval: () => { telemetryTick = undefined; },
          wireRoot,
          wireIo: countingIo,
        },
      });

      const conn = await telemetryAdapter.attach(FIXTURE.sessionId) as KimiObserveConnection;
      const rows: AgentMessage[] = [];
      conn.subscribe((message) => rows.push(message));
      await conn.getHistory(); // primes the connection, which is when the baseline is taken

      const tokenRows = () => rows.filter(
        (message): message is Extract<AgentMessage, { type: 'token-count' }> =>
          message.type === 'token-count');
      const latest = (key: string) => rows.filter(
        (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
          message.type === 'metadata-update' && message.key === key).at(-1)?.value as Record<string, unknown> | undefined;

      check('the baseline tail emits no token-count row',
        tokenRows().length === 0, `${tokenRows().length} rows`);
      check('the baseline seeds the cumulative usage over the observed window',
        JSON.stringify(latest('sessionUsage')) === JSON.stringify({
          inputTokens: 400, outputTokens: 40, cacheReadTokens: 4_000, cacheCreationTokens: 15,
          records: 5, windowClipped: false,
        }),
        JSON.stringify(latest('sessionUsage')));
      const timing = latest('activeTime');
      check('the baseline seeds an active-time account that says it is an estimate',
        timing?.estimated === true && timing.method === KIMI_ACTIVE_TIME_METHOD
          && timing.gapCapMs === KIMI_ACTIVE_GAP_CAP_MS && timing.streams === 2
          && timing.windowClipped === false,
        JSON.stringify(timing));
      check('a parallel subagent stream raises agentMs above activeMs',
        timing?.activeMs === 120_000 && timing.agentMs === 180_000,
        JSON.stringify({ activeMs: timing?.activeMs, agentMs: timing?.agentMs }));

      // A row appended AFTER the baseline is a live reading, not history.
      const liveCounts = { inputOther: 7, output: 3, inputCacheRead: 2, inputCacheCreation: 1 };
      appendFileSync(wireOf('main'), usageRow(base + 180_000, liveCounts));
      telemetryTick?.();
      await Bun.sleep(60);
      check('a usage row appended after attach emits exactly one token-count row',
        tokenRows().length === 1
          && JSON.stringify(tokenRows()[0]) === JSON.stringify({
            type: 'token-count', input: 7, output: 3, cacheRead: 2, cacheWrite: 1,
          }),
        JSON.stringify(tokenRows()));
      check('the live reading updates the cumulative window total',
        JSON.stringify(latest('sessionUsage')) === JSON.stringify({
          inputTokens: 407, outputTokens: 43, cacheReadTokens: 4_002, cacheCreationTokens: 16,
          records: 6, windowClipped: false,
        }),
        JSON.stringify(latest('sessionUsage')));

      // The same row appended again is the same reading, not a second one.
      appendFileSync(wireOf('main'), usageRow(base + 180_000, liveCounts));
      telemetryTick?.();
      await Bun.sleep(60);
      check('a repeated usage row is deduped rather than counted twice',
        tokenRows().length === 1
          && (latest('sessionUsage') as { records?: number } | undefined)?.records === 6,
        `rows=${tokenRows().length} records=${(latest('sessionUsage') as { records?: number } | undefined)?.records}`);

      // Telemetry stops with the connection: no timer, and no descriptor held
      // across ticks to keep reading through.
      const heldTick = telemetryTick;
      const opensAtClose = wireOpens;
      const rowsAtClose = rows.length;
      await conn.close();
      appendFileSync(wireOf('main'), usageRow(base + 240_000, liveCounts));
      heldTick?.();
      await Bun.sleep(60);
      check('close stops telemetry: no further journal read, no further row',
        wireOpens === opensAtClose && rows.length === rowsAtClose,
        `opens=${wireOpens - opensAtClose} rows=${rows.length - rowsAtClose}`);

      // Absent, never faked: a session with no journal emits no usage and no
      // timing at all rather than a zero that reads like a measurement.
      const emptyRoot = join(wireHome, 'empty-sessions');
      mkdirSync(emptyRoot, { recursive: true });
      let silentTick: (() => void) | undefined;
      const silentAdapter = new KimiAdapter({
        env: {}, homeDir: '/fixture/home',
        instanceScan: () => scan,
        readToken: () => 'fixture-token',
        observe: {
          socketFactory: () => new FakeSocket(),
          setInterval: (handler) => { silentTick = handler; return 1; },
          clearInterval: () => { silentTick = undefined; },
          wireRoot: emptyRoot,
        },
      });
      const silent = await silentAdapter.attach(FIXTURE.sessionId) as KimiObserveConnection;
      const silentRows: AgentMessage[] = [];
      silent.subscribe((message) => silentRows.push(message));
      await silent.getHistory();
      silentTick?.();
      await Bun.sleep(60);
      check('a session with no journal emits no usage and no timing at all',
        silentRows.every((message) => message.type !== 'token-count'
          && !(message.type === 'metadata-update'
            && ['sessionUsage', 'activeTime'].includes(message.key))),
        silentRows.map((message) => message.type).join(','));
      await silent.close();
    } finally {
      rmSync(wireHome, { recursive: true, force: true });
    }
  }

  // A tail window LARGER than one tick cap — the ordinary shape of a session
  // that has been running a while. One read() is bounded at
  // KIMI_WIRE_TICK_CAP_BYTES per stream, so a baseline that reads once and
  // declares itself baselined leaves the REST of the journal's history to
  // arrive on later ticks, as live token-count rows: precisely the attach-time
  // flood the baseline rule exists to prevent. The baseline must DRAIN.

  {
    const drainHome = mkdtempSync(join(tmpdir(), 'kimi-observe-drain-'));
    const drainRoot = join(drainHome, 'sessions');
    const drainAgents = join(drainRoot, 'wd_drain_0001', FIXTURE.sessionId, 'agents');
    const drainWire = join(drainAgents, 'main', 'wire.jsonl');

    try {
      const base = 1_700_000_500_000;
      const counts = { inputOther: 10, output: 1, inputCacheRead: 2, inputCacheCreation: 0 };
      const drainRow = (time: number) => `${JSON.stringify({
        type: 'usage.record', model: 'kimi-code/k3', usage: counts, usageScope: 'turn', time,
        pad: 'p'.repeat(900),
      })}\n`;
      // Sized FROM the tick cap, so the fixture stays bigger than one pass
      // however the cap moves, and far inside the tail cap, so nothing is
      // clipped and the sum is checkable against every line written.
      const historyRows = Math.ceil(KIMI_WIRE_TICK_CAP_BYTES / drainRow(base).length) + 32;
      const body = Array.from({ length: historyRows }, (_unused, index) => drainRow(base + index)).join('');
      mkdirSync(join(drainAgents, 'main'), { recursive: true });
      writeFileSync(drainWire, body);

      let drainTick: (() => void) | undefined;
      const drainAdapter = new KimiAdapter({
        env: {}, homeDir: '/fixture/home',
        instanceScan: () => scan,
        readToken: () => 'fixture-token',
        observe: {
          socketFactory: () => new FakeSocket(),
          setInterval: (handler) => { drainTick = handler; return 1; },
          clearInterval: () => { drainTick = undefined; },
          wireRoot: drainRoot,
        },
      });

      const drainConn = await drainAdapter.attach(FIXTURE.sessionId) as KimiObserveConnection;
      const drainRows: AgentMessage[] = [];
      drainConn.subscribe((message) => drainRows.push(message));
      await drainConn.getHistory(); // primes, and priming is when the baseline is taken
      // Several ticks, because a single-read baseline hands its arrears to
      // exactly these.
      for (let tick = 0; tick < 4; tick += 1) {
        drainTick?.();
        await Bun.sleep(30);
      }

      const drainTokens = () => drainRows.filter(
        (message): message is Extract<AgentMessage, { type: 'token-count' }> =>
          message.type === 'token-count');
      const drainUsage = () => drainRows.filter(
        (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
          message.type === 'metadata-update' && message.key === 'sessionUsage').at(-1)?.value;

      check('a window past one tick cap is drained at the baseline, never dribbled out as live rows',
        body.length > KIMI_WIRE_TICK_CAP_BYTES && body.length < KIMI_WIRE_TAIL_CAP_BYTES
          && drainTokens().length === 0,
        `bytes=${body.length} tickCap=${KIMI_WIRE_TICK_CAP_BYTES} tokenRows=${drainTokens().length}`);
      check('the drained baseline sums EVERY line of the window, not one tick cap of them',
        JSON.stringify(drainUsage()) === JSON.stringify({
          inputTokens: historyRows * 10, outputTokens: historyRows,
          cacheReadTokens: historyRows * 2, cacheCreationTokens: 0,
          records: historyRows, windowClipped: false,
        }),
        `${JSON.stringify(drainUsage())} lines=${historyRows}`);

      // The drain ends at the end of the window, not at the end of the file for
      // all time: what lands afterwards is genuinely live.
      appendFileSync(drainWire, drainRow(base + historyRows));
      drainTick?.();
      await Bun.sleep(30);
      check('a usage row appended after the drain emits exactly one token-count row',
        drainTokens().length === 1
          && JSON.stringify(drainTokens()[0]) === JSON.stringify({
            type: 'token-count', input: 10, output: 1, cacheRead: 2, cacheWrite: 0,
          }),
        JSON.stringify(drainTokens()));
      await drainConn.close();
    } finally {
      rmSync(drainHome, { recursive: true, force: true });
    }
  }

  // ── Transport generations ─────────────────────────────────────────────────
  //
  // Identity is verified ONCE, at attach, and the connection then outlives that
  // proof. Polling and reopening sockets on the pinned client, url, and token
  // re-sends a stale credential forever after a Kimi restart, a reused port, or
  // a token rotation — and leaves no way back, because the unauthorized answer
  // changed nothing. Each generation is re-resolved instead: a replacement
  // socket never carries the previous generation's proof, an unauthorized read
  // takes the generation down, and a re-resolution that fails leaves it down
  // rather than retrying with what the server already refused.

  const generationInfo = (id: string): SessionInfo => ({
    id, tool: 'kimi', title: id, status: 'idle',
    attachMode: 'observe', launchSurface: 'unknown',
    control: {
      drive: { state: 'observing', supported: false, reason: 'kimi-observe-only' },
      terminalSync: { supported: false, syncAvailable: false, active: false, reason: 'kimi-observe-only' },
    },
  });
  const onePage = (id: string, sessionId: string) => JSON.stringify({
    code: 0, msg: 'success',
    data: {
      items: [{
        id, session_id: sessionId, role: 'assistant',
        content: [{ type: 'text', text: id }], created_at: '2026-08-14T01:00:00.000Z',
      }],
      has_more: false,
    },
    request_id: 'r',
  });
  /** A client that LOGS every path it is asked for, so "which generation read this" is observable. */
  const recordingClient = (log: string[], answer: () => { status: number; body: string }) =>
    new KimiReadOnlyHttp({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async (url) => {
        log.push(new URL(url).pathname);
        const answered = answer();
        return { status: answered.status, text: async () => answered.body };
      },
    });
  const generationOf = (http: KimiReadOnlyHttp, port: number, token: string): KimiObserveTransport =>
    ({ http, wsUrl: `ws://127.0.0.1:${port}/api/v1/ws`, token });

  /**
   * A connection that exposes the two protected facts the retirement rule turns
   * on: whether the stream is OPEN, and how much server-side activity has been
   * observed.
   *
   * Neither belongs on the broker-facing surface — they are the inputs to the
   * live-attach gate, the write gate, and the divergence detector's silence
   * claim — but a zombie frame that moved either of them would otherwise be
   * invisible from outside until it had already corrupted a verdict.
   */
  class ProbeConnection extends KimiObserveConnection {
    get streamLive(): boolean { return this.socketLive; }
    get observedActivity(): number { return this.liveActivity; }
  }

  {
    const aReads: string[] = [];
    const bReads: string[] = [];
    const clientA = recordingClient(aReads, () => ({ status: 200, body: onePage('msg_gen_a', 's-generation') }));
    const clientB = recordingClient(bReads, () => ({ status: 200, body: onePage('msg_gen_b', 's-generation') }));
    const opens: Array<{ url: string; token: string | undefined }> = [];
    let genTick: (() => void) | undefined;
    let genSocket: FakeSocket | undefined;
    let reverifyCalls = 0;
    const conn = new KimiObserveConnection(
      generationInfo('s-generation'), clientA, 'ws://127.0.0.1:1/api/v1/ws', 'tok-A',
      {
        socketFactory: (url, token) => {
          opens.push({ url, token });
          genSocket = new FakeSocket();
          return genSocket;
        },
        setInterval: (handler) => { genTick = handler; return 1; },
        clearInterval: () => { genTick = undefined; },
        reverify: async () => {
          reverifyCalls += 1;
          return generationOf(clientB, 2, 'tok-B');
        },
      },
    );
    conn.subscribe(() => {});
    await conn.refresh(); // the first generation is genuinely reading
    const aAtLoss = aReads.length;
    genSocket!.fire('close', {});
    await Bun.sleep(30);
    genTick?.();
    await Bun.sleep(60);
    check('a replacement socket carries a re-resolved generation, never the lost one\'s proof',
      reverifyCalls > 0 && opens.length === 2
        && opens[1]?.url === 'ws://127.0.0.1:2/api/v1/ws' && opens[1]?.token === 'tok-B',
      `reverify=${reverifyCalls} opens=${JSON.stringify(opens)}`);
    check('reads after the generation changed go through the new client only',
      aReads.length === aAtLoss && bReads.length > 0,
      `a=${aReads.length} (${aAtLoss} when the socket dropped) b=${bReads.length}`);
    await conn.close();
  }

  {
    const aReads: string[] = [];
    const bReads: string[] = [];
    let refusing = false;
    const clientA = recordingClient(aReads, () => refusing
      ? { status: 401, body: '' }
      : { status: 200, body: onePage('msg_auth_a', 's-unauthorized') });
    const clientB = recordingClient(bReads, () => ({ status: 200, body: onePage('msg_auth_b', 's-unauthorized') }));
    let reverifyCalls = 0;
    const conn = new KimiObserveConnection(
      generationInfo('s-unauthorized'), clientA, 'ws://127.0.0.1:1/api/v1/ws', 'tok-A',
      {
        socketFactory: () => new FakeSocket(),
        setInterval: () => 1,
        clearInterval: () => {},
        reverify: async () => {
          reverifyCalls += 1;
          return generationOf(clientB, 2, 'tok-B');
        },
      },
    );
    conn.subscribe(() => {});
    await conn.refresh();
    refusing = true; // the server stops accepting this generation's credential
    await conn.refresh();
    const aAtRefusal = aReads.length;
    await conn.refresh();
    await conn.refresh();
    check('an unauthorized answer takes the generation down and the reads resume on the next one',
      reverifyCalls === 1 && aReads.length === aAtRefusal && bReads.length > 0,
      `a=${aReads.length} (${aAtRefusal} at the refusal) b=${bReads.length} reverify=${reverifyCalls}`);
    await conn.close();
  }

  {
    const aReads: string[] = [];
    const bReads: string[] = [];
    const clientA = recordingClient(aReads, () => ({ status: 200, body: onePage('msg_dark_a', 's-unresolvable') }));
    const clientB = recordingClient(bReads, () => ({ status: 200, body: onePage('msg_dark_b', 's-unresolvable') }));
    const opens: Array<{ url: string; token: string | undefined }> = [];
    let darkTick: (() => void) | undefined;
    let darkSocket: FakeSocket | undefined;
    let resolvable = false;
    let reverifyCalls = 0;
    const conn = new KimiObserveConnection(
      generationInfo('s-unresolvable'), clientA, 'ws://127.0.0.1:1/api/v1/ws', 'tok-A',
      {
        socketFactory: (url, token) => {
          opens.push({ url, token });
          darkSocket = new FakeSocket();
          return darkSocket;
        },
        setInterval: (handler) => { darkTick = handler; return 1; },
        clearInterval: () => { darkTick = undefined; },
        reverify: async () => {
          reverifyCalls += 1;
          return resolvable ? generationOf(clientB, 2, 'tok-B') : undefined;
        },
      },
    );
    conn.subscribe(() => {});
    await conn.refresh();
    const aAtLoss = aReads.length;
    darkSocket!.fire('close', {});
    await Bun.sleep(30);
    for (let tick = 0; tick < 2; tick += 1) {
      darkTick?.();
      await Bun.sleep(60);
    }
    check('a generation nothing can re-resolve reopens no socket and spends no read',
      opens.length === 1 && aReads.length === aAtLoss && reverifyCalls > 1,
      `opens=${opens.length} a=${aReads.length} (${aAtLoss} when the socket dropped) reverify=${reverifyCalls}`);
    resolvable = true;
    darkTick?.();
    await Bun.sleep(60);
    check('a later successful re-resolution restores the socket and the reads together',
      opens.length === 2 && opens[1]?.token === 'tok-B' && bReads.length > 0,
      `opens=${JSON.stringify(opens)} b=${bReads.length}`);
    await conn.close();
  }

  {
    // RETIREMENT, AND THE ZOMBIE GUARDS.
    //
    // A generation is HTTP + socket + token together — resolved as one identity
    // — so replacing it has to take the socket with it. Leaving the socket
    // attached is what let a content write clear the stream gate on the OLD
    // socket and then land on the NEW server, with the approvals answering it
    // and the detector policing it still watching somewhere else.
    //
    // Retirement is only SOUND if the retired socket can no longer act: it keeps
    // every listener it was given, a real one goes on firing for a while after
    // `close()`, and each of the three events does specific damage on arrival.
    const aReads: string[] = [];
    const bReads: string[] = [];
    let refusing = false;
    const clientA = recordingClient(aReads, () => refusing
      ? { status: 401, body: '' }
      : { status: 200, body: onePage('msg_zombie_a', 's-zombie') });
    const clientB = recordingClient(bReads, () => ({ status: 200, body: onePage('msg_zombie_b', 's-zombie') }));
    const opens: Array<{ url: string; token: string | undefined }> = [];
    let zombieTick: (() => void) | undefined;
    let reverifyCalls = 0;
    const conn = new ProbeConnection(
      generationInfo('s-zombie'), clientA, 'ws://127.0.0.1:1/api/v1/ws', 'tok-A',
      {
        socketFactory: (url, token) => { opens.push({ url, token }); return new FakeSocket(); },
        setInterval: (handler) => { zombieTick = handler; return 1; },
        clearInterval: () => { zombieTick = undefined; },
        reverify: async () => {
          reverifyCalls += 1;
          return generationOf(clientB, 2, 'tok-B');
        },
      },
    );
    conn.subscribe(() => {});
    const retired = sockets.at(-1)!;
    retired.fire('open', {});
    retired.deliver({
      type: 'event.agent.activity', session_id: 's-zombie',
      seq: 5, epoch: 'ep_zombie', timestamp: 't', payload: {},
    });
    check('the first generation\'s socket is live and its frames count',
      conn.streamLive === true && conn.observedActivity === 1 && conn.observedCursor?.seq === 5,
      `live=${conn.streamLive} activity=${conn.observedActivity} cursor=${JSON.stringify(conn.observedCursor)}`);

    refusing = true;
    await conn.refresh(); // the server refuses this generation's proof
    await conn.refresh(); // ...and the next read re-resolves it
    const replacement = sockets.at(-1)!;
    check('replacing the generation RETIRES its socket and opens one on the new generation',
      reverifyCalls === 1 && retired.closed === true && replacement !== retired
        && opens.length === 2 && opens[1]?.url === 'ws://127.0.0.1:2/api/v1/ws'
        && opens[1]?.token === 'tok-B' && bReads.length > 0,
      `reverify=${reverifyCalls} retiredClosed=${retired.closed} opens=${JSON.stringify(opens)}`);
    check('the stream is DOWN from the swap until the replacement opens',
      conn.streamLive === false, `live=${conn.streamLive}`);

    // (1) A LATE CLOSE. Unguarded it clears `this.socket` over the REPLACEMENT,
    // re-invalidates the generation that was just resolved, and fires a spurious
    // refresh — after which the replacement is a socket nobody owns, so every
    // frame it delivers is guarded off and the connection is silently deaf.
    const socketsAtGuard = sockets.length;
    const reverifyAtGuard = reverifyCalls;
    retired.fire('close', {});
    await Bun.sleep(30);
    zombieTick?.();
    await Bun.sleep(30);
    check('a late close from the retired socket does not clear the replacement\'s state',
      sockets.length === socketsAtGuard && reverifyCalls === reverifyAtGuard,
      `sockets=${sockets.length - socketsAtGuard} reverify=${reverifyCalls - reverifyAtGuard}`);

    // (2) A LATE MESSAGE, well-formed and consequential: it names THIS session
    // and carries a forward seq. Unguarded it moves the NEW view's cursor to a
    // position the new journal never issued, and counts as proof the new server
    // was alive — which is precisely what exonerates a suspected foreign write.
    const cursorAtGuard = { ...conn.observedCursor! };
    const activityAtGuard = conn.observedActivity;
    retired.deliver({
      type: 'event.agent.activity', session_id: 's-zombie',
      seq: 4_242, epoch: 'ep_zombie', timestamp: 't', payload: {},
    });
    check('a late message from the retired socket moves neither the cursor nor liveActivity',
      conn.observedCursor?.seq === cursorAtGuard.seq && conn.observedActivity === activityAtGuard,
      `cursor=${JSON.stringify(conn.observedCursor)} activity=${conn.observedActivity}`);

    // (3) A LATE OPEN. `socketOpen` is what the live-attach gate, the content
    // write gate, and the detector's silence claim all read, so a socket nobody
    // owns must never be able to set it.
    retired.fire('open', {});
    check('a late open from the retired socket does not report a live stream',
      conn.streamLive === false, `live=${conn.streamLive}`);

    // (4) MECHANISM CONTROL: the REPLACEMENT's frames DO drive the connection,
    // so the three guards above are about ownership rather than about a
    // connection that has stopped listening to anything.
    replacement.fire('open', {});
    replacement.deliver({
      type: 'event.agent.activity', session_id: 's-zombie',
      seq: 4_243, epoch: 'ep_zombie', timestamp: 't', payload: {},
    });
    check('the REPLACEMENT socket\'s frames drive the connection',
      conn.streamLive === true && conn.observedCursor?.seq === 4_243
        && conn.observedActivity === activityAtGuard + 1,
      `live=${conn.streamLive} cursor=${JSON.stringify(conn.observedCursor)} activity=${conn.observedActivity}`);
    await conn.close();
  }

  {
    // No reverifier is the FIXED-transport mode every direct construction asks
    // for: there is no second generation to reach for, so a lost socket keeps
    // its immediate refresh — the only read it can still make.
    const reads: string[] = [];
    let refusingFixed = false;
    const client = recordingClient(reads, () => refusingFixed
      ? { status: 401, body: '' }
      : { status: 200, body: onePage('msg_fixed', 's-fixed') });
    let fixedSocket: FakeSocket | undefined;
    const conn = new ProbeConnection(
      generationInfo('s-fixed'), client, 'ws://127.0.0.1:1/api/v1/ws', 'tok-fixed',
      {
        socketFactory: () => { fixedSocket = new FakeSocket(); return fixedSocket; },
        setInterval: () => 1,
        clearInterval: () => {},
      },
    );
    conn.subscribe(() => {});
    fixedSocket!.fire('open', {});
    // ...and nothing about the retirement rule touches it. There is no second
    // generation to move to, so there is no replacement to protect: retiring the
    // socket here would cost this connection the only stream it will ever have,
    // and its reads would go on reporting their failures with no stream behind
    // them at all.
    const socketsBeforeRefusal = sockets.length;
    refusingFixed = true;
    await conn.refresh();
    await conn.refresh();
    check('a fixed-transport connection retires no socket on an unauthorized read',
      fixedSocket!.closed === false && sockets.length === socketsBeforeRefusal
        && conn.streamLive === true,
      `closed=${fixedSocket!.closed} sockets=${sockets.length - socketsBeforeRefusal} live=${conn.streamLive}`);
    refusingFixed = false;

    const before = reads.length;
    fixedSocket!.fire('close', {});
    await Bun.sleep(30);
    check('with no reverifier a lost socket still refreshes immediately through its fixed transport',
      reads.length > before, `reads=${reads.length - before}`);
    await conn.close();
  }

  // ── A new incarnation with no readable position ───────────────────────────
  //
  // A changed epoch is a new journal, so the held seq means nothing — and a
  // frame from that journal carrying no readable seq of its own carries no
  // position either. Assigning zero INVENTS one, and the next reconnect then
  // subscribes from a watermark nothing ever observed: on a busy session that is
  // the replay the server is least able to serve. The cursor is dropped instead,
  // the same fail-closed rule the resync handler follows.

  for (const [label, frame] of [
    ['an event envelope', { type: 'event.x', session_id: 's-epoch', seq: 'bogus', epoch: 'ep2' }],
    ['a malformed ack', { type: 'ack', id: 'subscribe', payload: { cursors: { 's-epoch': { seq: null, epoch: 'ep2' } } } }],
  ] as const) {
    const reads: string[] = [];
    const client = recordingClient(reads, () => ({ status: 200, body: onePage('msg_epoch', 's-epoch') }));
    let epochSocket: FakeSocket | undefined;
    let epochTick: (() => void) | undefined;
    const conn = new KimiObserveConnection(
      generationInfo('s-epoch'), client, 'ws://127.0.0.1:1/api/v1/ws', undefined,
      {
        socketFactory: () => { epochSocket = new FakeSocket(); return epochSocket; },
        setInterval: (handler) => { epochTick = handler; return 1; },
        clearInterval: () => { epochTick = undefined; },
      },
    );
    conn.subscribe(() => {});
    const first = epochSocket!;
    first.fire('open', {});
    first.deliver({ type: 'ack', id: 'subscribe', payload: { cursors: { 's-epoch': { seq: 5, epoch: 'ep1' } } } });
    const held = conn.observedCursor?.seq === 5 && conn.observedCursor.epoch === 'ep1';
    first.deliver(frame);
    await Bun.sleep(30);
    check(`a new incarnation with no readable position clears the cursor (${label})`,
      held && conn.observedCursor === undefined,
      `held=${held} after=${JSON.stringify(conn.observedCursor)}`);
    // The next socket generation is what would have carried the invented
    // position onto the wire.
    first.fire('close', {});
    await Bun.sleep(30);
    epochTick?.();
    await Bun.sleep(30);
    const next = epochSocket!;
    next.fire('open', {});
    const subscribe = next.sent.find((sent) => sent.type === 'subscribe');
    const cursors = (subscribe?.payload as { cursors?: Record<string, unknown> } | undefined)?.cursors ?? {};
    check(`the subscribe after a cleared cursor asks for no replay at all (${label})`,
      Object.keys(cursors).length === 0 && !JSON.stringify(subscribe?.payload).includes('"seq":0'),
      JSON.stringify(subscribe?.payload));
    next.deliver({ type: 'ack', id: 'subscribe', payload: { cursors: { 's-epoch': { seq: 4_321, epoch: 'ep2' } } } });
    check(`the ack after a cleared cursor seeds the server's own position (${label})`,
      conn.observedCursor?.seq === 4_321 && conn.observedCursor.epoch === 'ep2',
      JSON.stringify(conn.observedCursor));
    await conn.close();
  }

  {
    // The valid-seq epoch change is unchanged: the frame is FROM the new
    // incarnation, so its own seq is a real watermark for that journal.
    const reads: string[] = [];
    const client = recordingClient(reads, () => ({ status: 200, body: onePage('msg_epoch_ok', 's-epoch-ok') }));
    let okSocket: FakeSocket | undefined;
    const conn = new KimiObserveConnection(
      generationInfo('s-epoch-ok'), client, 'ws://127.0.0.1:1/api/v1/ws', undefined,
      {
        socketFactory: () => { okSocket = new FakeSocket(); return okSocket; },
        setInterval: () => 1,
        clearInterval: () => {},
      },
    );
    conn.subscribe(() => {});
    okSocket!.fire('open', {});
    okSocket!.deliver({ type: 'ack', id: 'subscribe', payload: { cursors: { 's-epoch-ok': { seq: 5, epoch: 'ep1' } } } });
    okSocket!.deliver({ type: 'event.x', session_id: 's-epoch-ok', seq: 900, epoch: 'ep2' });
    await Bun.sleep(30);
    check('a valid-seq epoch change still adopts the frame\'s own watermark',
      conn.observedCursor?.seq === 900 && conn.observedCursor.epoch === 'ep2',
      JSON.stringify(conn.observedCursor));
    await conn.close();
  }

  // ── A resync stream that outruns its own catch-up ─────────────────────────
  //
  // Coalescing alone does not end an incident whose frames keep arriving: each
  // one landing during a walk buys another full KIMI_RESYNC_MAX_PAGES walk of
  // force-loading reads, so one incident can spend them for as long as the
  // session stays busy. The passes are ceilinged, the incident concedes in-band
  // ONCE, and it ends where it stands — resubscribing from the newest watermark
  // it adopted.

  {
    const stormConn = await observing.attach(FIXTURE.sessionId) as KimiObserveConnection;
    const stormNotices: string[] = [];
    await stormConn.getHistory();
    stormConn.subscribe((message) => {
      if (message.type === 'notice') stormNotices.push(message.message);
    });
    const stormSocket = sockets[sockets.length - 1]!;
    stormSocket.fire('open', {});
    const subscribesBefore = stormSocket.sent.filter((frame) => frame.type === 'subscribe').length;
    historyMode = 'endless';
    endlessFreshPerRead = true; // no walk may stop early on rows another walk created
    endlessGeneration += 1;
    messagePageRequests.length = 0;
    let injected = 0;
    // Capped so the demonstration TERMINATES: with the pass ceiling lifted the
    // incident spends one full walk per frame, which is what the bound rules out.
    const injectionCap = KIMI_RESYNC_RECOVERY_PASS_MAX + 5;
    onMessagesRequest = (beforeId) => {
      if (beforeId !== null || injected >= injectionCap) return;
      injected += 1;
      stormSocket.deliver({
        type: 'resync_required',
        payload: {
          session_id: FIXTURE.sessionId, reason: 'buffer_overflow',
          current_seq: 110_000 + injected, epoch: 'ep_storm',
        },
      });
    };
    stormSocket.deliver({
      type: 'resync_required',
      payload: { session_id: FIXTURE.sessionId, reason: 'buffer_overflow', current_seq: 110_000, epoch: 'ep_storm' },
    });
    await Bun.sleep(1_200);
    onMessagesRequest = undefined;
    historyMode = 'fixture';
    endlessFreshPerRead = false;
    const passBound = KIMI_RESYNC_RECOVERY_PASS_MAX * KIMI_RESYNC_MAX_PAGES;
    check('a resync stream that outruns its catch-up is bounded at the pass ceiling',
      messagePageRequests.length <= passBound && messagePageRequests.length > KIMI_RESYNC_MAX_PAGES,
      `pages=${messagePageRequests.length} bound=${KIMI_RESYNC_RECOVERY_PASS_MAX} x ${KIMI_RESYNC_MAX_PAGES}`
      + ` = ${passBound}; unbounded spends one ${KIMI_RESYNC_MAX_PAGES}-page walk per frame`);
    check('a conceded incident states its gap exactly once',
      stormNotices.filter((text) => text === KIMI_RESYNC_GAP_NOTICE).length === 1,
      `notices=${stormNotices.length}`);
    const stormResubs = stormSocket.sent.filter((frame) => frame.type === 'subscribe');
    check('a conceded incident ends in one resubscribe, from the newest watermark it adopted',
      stormResubs.length === subscribesBefore + 1
        && JSON.stringify(stormResubs[stormResubs.length - 1]?.payload).includes(`"seq":${110_000 + injected}`),
      `resubs=${stormResubs.length - subscribesBefore} frames=${injected}`
      + ` ${JSON.stringify(stormResubs[stormResubs.length - 1]?.payload)}`);
    await stormConn.close();
  }

  // ── Teardown + the mutation ban ───────────────────────────────────────────

  await connection.close();
  check('close stops the poll timer', intervalHandler === undefined);
  check('mutation is refused on an observe connection',
    await connection.sendPrompt({ text: 'hello' } as never).then(() => false, () => true)
      && await connection.respondPermission('r', 'approve').then(() => false, () => true));
  check('a closed connection sent only read-only frames',
    sockets.every((s) => s.sent.every((frame) =>
      ['client_hello', 'subscribe', 'subscribe_v2', 'unsubscribe', 'unsubscribe_v2', 'pong']
        .includes(String(frame.type)))),
    [...new Set(sockets.flatMap((s) => s.sent.map((f) => String(f.type))))].join(','));
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
