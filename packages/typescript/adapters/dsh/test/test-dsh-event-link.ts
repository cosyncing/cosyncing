/**
 * The 0.2 event generation.
 *
 * The behaviour under test is the one that decides whether an approval answer
 * reaches the chain that asked for it: readiness is the `ready` frame and
 * nothing less, an answer may only name the current generation's `clientId`,
 * and a generation that misbehaves is ended rather than interpreted.
 *
 * Frames are the ones the real host sent, taken from the 0.2 fixture.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-event-link.ts
 */
export {};
import { DshEventLink, DSH_EVENT_MAX_PENDING } from '../src/event-link.ts';
import { DshMuxClient } from '../src/mux.ts';
import type { DshEventOutcome } from '../src/remote.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as any;
const READY = FIXTURE.events.frames[0].value as { type: 'ready'; clientId: string; host: { home: string } };

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Replay {
  link: DshEventLink;
  sockets: FakeSocket[];
  answers: Array<{ clientId: string; eventId: string; outcome: DshEventOutcome }>;
  failNextAnswer: boolean;
  refuseNextAnswer: boolean;
  verified: string[];
  lost: Array<{ carrier: number; reason: string }>;
  events: string[];
  cancellations: string[];
  waterfalls: string[];
  diagnostics: string[];
  socket(index?: number): FakeSocket;
  timers: { pending: number };
  runTimers(): void;
}



// A carrier the link did not build: enough of a socket to drive it by hand.
interface ReplaySocket {
  readonly sent: string[];
  readonly sentHeaders?: Readonly<Record<string, string>>;
  emit(type: string, event?: unknown): void;
}

class FakeSocket {
  readonly sent: string[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(readonly url: string, readonly headers: Readonly<Record<string, string>>) {}

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed += 1; }
  addEventListener(type: string, listener: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event?: unknown): void { for (const l of this.listeners.get(type) ?? []) l(event); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

function replay(options: {
  autoOpen?: boolean;
  answerOk?: boolean;
  reconnectDelayMs?: number;
  answerOverride?: () => Promise<{ ok: boolean }>;
} = {}): Replay {
  const sockets: FakeSocket[] = [];
  const answers: Replay['answers'] = [];
  const state = {
    /** true: the request never completed. false/refuseNextAnswer: the host saw and declined it. */
    failNextAnswer: false,
    refuseNextAnswer: false,
    verified: [] as string[],
    lost: [] as Array<{ carrier: number; reason: string }>,
    events: [] as string[],
    cancellations: [] as string[],
    waterfalls: [] as string[],
    diagnostics: [] as string[],
  };
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const link: DshEventLink = new DshEventLink({
    baseUrl: 'http://127.0.0.1:3080',
    socketFactory: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      if (options.autoOpen !== false) queueMicrotask(() => socket.emit('open'));
      return socket as never;
    },
    ...(options.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.reconnectDelayMs }),
    setTimeout: (handler) => { const id = ++timerSeq; timers.set(id, () => { timers.delete(id); handler(); }); return id; },
    clearTimeout: (handle) => { if (typeof handle === 'number') timers.delete(handle); },
    answer: async ({ clientId, eventId, outcome }) => {
      if (options.answerOverride) return options.answerOverride();
      const ok = (options.answerOk !== false) && !state.failNextAnswer && !state.refuseNextAnswer;
      if (ok) answers.push({ clientId, eventId, outcome });
      if (state.refuseNextAnswer) {
        state.refuseNextAnswer = false;
        return { ok: false, retryable: false, detail: 'the host declined this answer' };
      }
      if (state.failNextAnswer) {
        state.failNextAnswer = false;
        return { ok: false, retryable: true, detail: 'simulated send failure' };
      }
      return { ok: true };
    },
  }, {
    onVerified: (generation) => state.verified.push(generation.clientId),
    onLost: (carrier, reason) => state.lost.push({ carrier, reason }),
    onEvent: (event) => state.events.push(event),
    onWaterfall: (frame) => state.waterfalls.push(frame.eventId),
    onCancellation: (eventId) => state.cancellations.push(eventId),
    onDiagnostic: (diagnostic) => state.diagnostics.push(diagnostic.code),
  });
  return {
    ...state,
    // Accessors, not a copied field: the fake below reads this at answer time,
    // so a snapshot taken here would freeze it at its initial value and a test
    // that "makes the next send fail" would silently still succeed.
    get failNextAnswer() { return state.failNextAnswer; },
    set failNextAnswer(next: boolean) { state.failNextAnswer = next; },
    get refuseNextAnswer() { return state.refuseNextAnswer; },
    set refuseNextAnswer(next: boolean) { state.refuseNextAnswer = next; },
    link,
    sockets,
    answers,
    timers: { get pending() { return timers.size; } },
    runTimers() { for (const [, fire] of [...timers.entries()]) fire(); },
    socket(index = sockets.length - 1) {
      const socket = sockets[index];
      if (!socket) throw new Error('no socket yet');
      socket.emit('open');
      return socket;
    },
  };
}

// The mux client mints `s1` by default; the replay needs to address the stream it
// opened, so the helper reads the id back off the wire instead of assuming it.
function eventStreamId(r: Replay, index = r.sockets.length - 1): string {
  const frame = r.sockets[index]?.frames().find((f) => f.type === 'open');
  return String(frame?.streamId ?? 's1');
}
function emitValue(r: Replay, value: unknown, index = r.sockets.length - 1): void {
  r.sockets[index]?.emit('message', {
    data: JSON.stringify({ type: 'item', streamId: eventStreamId(r, index), value }),
  });
}

// ── 1. Readiness is the ready frame ─────────────────────────────────────────

{
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  check('an open carrier is not a verified host', r.link.isVerified === false);
  const refused = await r.link.answer('evt-1', { kind: 'next' });
  check('nothing is answered before the generation verifies',
    refused.ok === false && r.answers.length === 0, JSON.stringify(refused));

  const socket0 = r.socket(0);
  await settle();
  const open = socket0.frames()[0];
  check('the carrier opens $events with the empty args payload the host expects',
    JSON.stringify(open) === JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }),
    JSON.stringify(open));

  // The captured grammar puts `ready` first on a stream this client opens, so a
  // frame ahead of it is not an early arrival to be queued — it means the host
  // is speaking something other than the grammar assumed, and the next frame
  // could be an approval read wrongly. Ending is the only honest answer.
  emitValue(r, { type: 'emit', event: 'session/updated', args: [] });
  await settle();
  check('a frame that is not the ready frame ends the generation instead of being skipped',
    r.link.isVerified === false && r.lost.length === 1 && r.diagnostics.includes('verify-frame-rejected'),
    JSON.stringify({ lost: r.lost, d: r.diagnostics }));
  check('the reason names what actually happened rather than "handshake failed"',
    r.lost[0]?.reason === 'the event stream did not open with its ready frame', String(r.lost[0]?.reason));
  r.link.stop();
}

{
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  check('a verification deadline is armed', r.timers.pending === 1, `${String(r.timers.pending)} pending`);
  r.runTimers();
  await settle();
  check('a carrier that never announces its generation is failed, not waited on forever',
    r.lost.length === 1 && r.lost[0]?.reason === 'the event stream never announced its generation'
      && r.diagnostics.includes('verify-timeout'),
    JSON.stringify(r.lost));
  r.link.stop();
}

// ── 2. The captured ready frame, and what it authorises ──────────────────────

{
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();

  emitValue(r, READY);
  await settle();
  check("the captured ready frame establishes the generation with the host's own clientId",
    r.link.isVerified && r.verified.join() === READY.clientId
      && r.link.currentGeneration?.hostHome === '/fixture/home'
      && r.link.currentGeneration?.carrier === 0,
    JSON.stringify(r.link.currentGeneration));
  check('the verification deadline is released rather than left to fire inside the next generation',
    r.timers.pending === 0, `${String(r.timers.pending)} pending`);

  emitValue(r, { type: 'emit', event: 'session/renamed', args: ['session-fixture-001', 'new'] });
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-2', agentId: 'session-fixture-001', request: { id: 'b' } });
  await settle();
  check('post-verification frames reach their consumers in order',
    r.events.join() === 'session/renamed' && r.waterfalls.join() === 'evt-2',
    `${r.events.join()}|${r.waterfalls.join()}`);

  const answered = await r.link.answer('evt-2', { kind: 'result', value: 'allowed-once' });
  check('an answer carries the current generation clientId and the host\'s eventId',
    answered.ok === true && r.answers.length === 1
      && r.answers[0]?.clientId === READY.clientId && r.answers[0]?.eventId === 'evt-2',
    JSON.stringify(r.answers[0]));
  check('an answered request stops being pending, so it cannot be answered twice',
    r.link.pendingWaterfalls().length === 0);
  const again = await r.link.answer('evt-2', { kind: 'next' });
  check('a second answer for one request has nothing to point at and is refused',
    again.ok === false && r.answers.length === 1, JSON.stringify(again));

  const unknown = await r.link.answer('evt-never-asked', { kind: 'next' });
  check('an event this generation never announced is refused out loud',
    unknown.ok === false && r.answers.length === 1, JSON.stringify(unknown));
  r.link.stop();
}

// ── 3. Failure, cancellation and overflow ───────────────────────────────────

{
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q', agentId: 'session-fixture-001', request: {} });
  await settle();
  r.failNextAnswer = true;
  const failed = await r.link.answer('evt-q', { kind: 'result', value: {} });
  check('a send that never completed leaves the request pending instead of stranding it',
    failed.ok === false && r.link.pendingWaterfalls().length === 1, JSON.stringify(failed));
  // The other kind of failure is the opposite instruction: the host saw the
  // answer and said no, so the request is finished and putting it back would
  // invite a second decision on one approval.
  r.refuseNextAnswer = true;
  const declined = await r.link.answer('evt-q', { kind: 'result', value: {} });
  check('an answer the host declined is NOT put back on the tray',
    declined.ok === false && r.link.pendingWaterfalls().length === 0, JSON.stringify(declined));
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-q', agentId: 'session-fixture-001', request: {} });
  await settle();
  const okNow = await r.link.answer('evt-q', { kind: 'result', value: {} });
  check('the same request stays answerable after a transport failure',
    okNow.ok === true && r.link.pendingWaterfalls().length === 0);

  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-c', agentId: 'session-fixture-001', request: {} });
  await settle();
  emitValue(r, { type: 'cancel', eventId: 'evt-c' });
  await settle();
  check('a cancellation clears the pending request and tells the caller',
    r.link.pendingWaterfalls().length === 0 && r.cancellations.join() === 'evt-c',
    JSON.stringify(r.cancellations));

  emitValue(r, READY);
  await settle();
  check('a generation that re-announces itself is ended, not adopted',
    r.link.isVerified === false && r.lost.length >= 1 && r.diagnostics.includes('verify-frame-rejected'),
    JSON.stringify(r.diagnostics));
  r.link.stop();
}

{
  // Overflow: a full tray must delegate, because the host waits on the front of
  // its chain and silence behind a queue is not a decision.
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  for (let index = 0; index <= DSH_EVENT_MAX_PENDING; index += 1) {
    emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: `evt-${String(index)}`, agentId: 'session-fixture-001', request: {} });
  }
  await settle();
  check('a full pending tray delegates the next request with `next`',
    r.answers.length === 1 && JSON.stringify(r.answers[0]?.outcome) === JSON.stringify({ kind: 'next' })
      && r.link.pendingWaterfalls().length === DSH_EVENT_MAX_PENDING,
    `${String(r.answers.length)} delegated, ${String(r.link.pendingWaterfalls().length)} pending`);
  r.link.stop();
}

// ── 4. Loss, reconnect, and one carrier ─────────────────────────────────────

{
  const r = replay({ autoOpen: false, answerOk: true });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-live', agentId: 'session-fixture-001', request: {} });
  await settle();
  const before = r.link.pendingWaterfalls().length;

  r.sockets[0]!.emit('close');
  await settle();
  check('losing the carrier drops every pending interaction from that generation',
    r.link.pendingWaterfalls().length === 0 && r.lost.length === 1 && before === 1,
    JSON.stringify(r.lost));
  const stale = await r.link.answer('evt-live', { kind: 'result', value: 'allowed-once' });
  check('an answer to a dead generation is refused, not sent into silence',
    stale.ok === false && r.answers.length === 0, JSON.stringify(stale));

  r.runTimers();
  r.socket(1);
  await settle();
  const secondClientId = `${READY.clientId}-second`;
  emitValue(r, { type: 'ready', clientId: secondClientId, host: { home: '/fixture/home' } }, 1);
  await settle();
  check('a fresh carrier re-verifies on its own and adopts the new clientId',
    r.link.isVerified && r.verified.join() === `${READY.clientId},${secondClientId}`,
    r.verified.join(','));
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-new', agentId: 'session-fixture-001', request: {} }, 1);
  await settle();
  await r.link.answer('evt-new', { kind: 'result', value: 'allowed-once' });
  check('answers after a reconnect name the NEW generation',
    r.answers.length === 1 && r.answers[0]?.clientId === secondClientId,
    JSON.stringify(r.answers[0]));
  check('the link exposes the shared carrier so attaches do not start a second reconnect loop',
    r.link.streams instanceof DshMuxClient && r.sockets.length === 2,
    `${String(r.sockets.length)} sockets for one link`);
  r.link.stop();
  check('stopping closes the carrier and leaves no timer behind',
    r.timers.pending === 0 && r.sockets[1]!.closed === 1,
    `${String(r.timers.pending)} timers, ${String(r.sockets[1]!.closed)} closes`);
}

// ── 5. The event stream can die while the socket lives (review R2) ───────────

for (const terminal of ['end', 'error'] as const) {
  const r = replay({ autoOpen: false, reconnectDelayMs: 10 });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-stuck', agentId: 'session-fixture-001', request: {} });
  await settle();
  check(`a ${terminal} on the event stream leaves a live-looking link to test`,
    r.link.isVerified === true && r.link.pendingWaterfalls().length === 1);

  r.sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: terminal,
      streamId: eventStreamId(r, 0),
      ...(terminal === 'error' ? { error: { code: 'remote/stream-failed', message: 'gone', details: {} } } : {}),
    }),
  });
  await settle();
  check(`a bare ${terminal} on the event stream ends the generation and says so once`,
    r.link.isVerified === false && r.link.pendingWaterfalls().length === 0
      && r.lost.length === 1 && (r.lost[0]?.reason ?? '').includes('event stream'),
    JSON.stringify(r.lost));

  // The socket underneath was never the problem, so nothing would have
  // reconnected on its own: recovery has to be driven by the stream ending.
  r.runTimers();
  await settle();
  check(`a stream ${terminal} drives a real reconnect rather than a permanent lull`,
    r.sockets.length === 2, `${String(r.sockets.length)} sockets`);
  r.link.stop();
}

// ── 6. One answer per request, and receipts that cannot cross generations (R3)

{
  let sends = 0;
  let release!: (value: { ok: boolean }) => void;
  const receipt = new Promise<{ ok: boolean }>((resolve) => { release = resolve; });
  const r = replay({ autoOpen: false, answerOverride: async () => { sends += 1; return receipt; } });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-once', agentId: 'session-fixture-001', request: {} });
  await settle();
  const first = r.link.answer('evt-once', { kind: 'result', value: 'allowed-once' });
  const second = r.link.answer('evt-once', { kind: 'result', value: 'rejected' });
  check('two callers answering one approval produce one request to the host',
    sends === 1, `${String(sends)} sends`);
  release({ ok: true });
  const [a, b] = await Promise.all([first, second]);
  check('both callers learn the outcome of the one request that actually ran',
    a.ok === true && b.ok === true);
  r.link.stop();
}

{
  // The host re-delivers still-pending events to a new event client. A receipt
  // from the answer sent against the OLD client must not act on the NEW one's
  // tray, or a reconnect silently loses a live approval.
  let sends = 0;
  let release!: (value: { ok: boolean }) => void;
  const receipt = new Promise<{ ok: boolean }>((resolve) => { release = resolve; });
  const r = replay({ autoOpen: false, reconnectDelayMs: 10, answerOverride: async () => { sends += 1; return receipt; } });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-replay', agentId: 'session-fixture-001', request: {} });
  await settle();
  const old = r.link.answer('evt-replay', { kind: 'result', value: 'allowed-once' });

  r.sockets[0]!.emit('close');
  await settle();
  r.runTimers();
  r.socket(1);
  await settle();
  emitValue(r, { type: 'ready', clientId: 'client-b', host: { home: '/fixture/home' } }, 1);
  await settle();
  emitValue(r, { type: 'waterfall', event: 'approval/request', eventId: 'evt-replay', agentId: 'session-fixture-001', request: {} }, 1);
  await settle();
  const before = r.link.pendingWaterfalls().length;
  release({ ok: true });
  await old;
  check("a late receipt for a dead generation cannot clear the new client's pending request",
    before === 1 && r.link.pendingWaterfalls().length === 1
      && r.link.currentGeneration?.clientId === 'client-b',
    `${String(before)} -> ${String(r.link.pendingWaterfalls().length)} on ${String(r.link.currentGeneration?.clientId)}`);
  const reanswered = await r.link.answer('evt-replay', { kind: 'result', value: 'rejected' });
  check('the replayed request is answerable again on the new client',
    reanswered.ok === true && sends === 2, `${String(sends)} sends`);
  r.link.stop();
}

// ── 7. Defaults and injected carriers (review R4, R7, R11) ───────────────────
/**
 * A carrier and socket pair the test drives by hand, for the cases where the
 * link is NOT the thing that built the carrier.
 */
function handBuilt(): {
  mux: DshMuxClient;
  sockets: Array<{ sent: string[]; sentHeaders: unknown; emit(type: string, event?: unknown): void }>;
  headerReads: number;
} {
  const sockets: Array<{ sent: string[]; sentHeaders: unknown; emit(type: string, event?: unknown): void }> = [];
  let headerReads = 0;
  const mux = new DshMuxClient({
    baseUrl: 'http://127.0.0.1:3080',
    headers: () => { headerReads += 1; return { cookie: 'dsh-auth-FIXTURE=v1' }; },
    socketFactory: (url, sentHeaders) => {
      const listeners = new Map<string, Array<(e: unknown) => void>>();
      const socket = {
        sent: [] as string[],
        sentHeaders,
        url,
        send(data: string) { socket.sent.push(data); },
        close() { socket.closed += 1; },
        closed: 0,
        addEventListener(type: string, listener: (e: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        emit(type: string, event?: unknown) { for (const l of listeners.get(type) ?? []) l(event); },
      };
      sockets.push(socket as never);
      return socket as never;
    },
  }, { onOpen() {}, onLost() {} });
  return { mux, sockets, get headerReads() { return headerReads; } } as never;
}

/** Deliver one host frame to a named stream. */
function toStream(socket: { emit(type: string, event?: unknown): void }, streamId: string, value: unknown): void {
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId, value }) });
}


{
  // No injected timers: the deadline a production caller gets is the one that
  // has to exist here. A short real timeout is the only honest way to ask.
  const sockets: ReplaySocket[] = [];
  const link = new DshEventLink({
    baseUrl: 'http://127.0.0.1:3080',
    verifyTimeoutMs: 10,
    socketFactory: (url, headers) => {
      const listeners = new Map<string, Array<(e: unknown) => void>>();
      const socket = {
        send() {}, close() {}, url, headers,
        addEventListener(type: string, listener: (e: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        emit(type: string, event?: unknown) { for (const l of listeners.get(type) ?? []) l(event); },
      };
      sockets.push(socket as unknown as ReplaySocket);
      queueMicrotask(() => socket.emit('open'));
      return socket as never;
    },
    answer: async () => ({ ok: true }),
  });
  link.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  check('the verification deadline exists without anyone injecting a clock',
    link.isVerified === false && link.recordedDiagnostics().some((d) => d.code === 'verify-timeout'),
    JSON.stringify(link.recordedDiagnostics()));
  link.stop();
}

{
  // An oversized frame cannot be attributed to a stream, so it cannot be
  // dropped quietly: the subscription would look live and be missing an approval.
  const r = replay({ autoOpen: false });
  r.link.start();
  await settle();
  r.socket(0);
  await settle();
  emitValue(r, READY);
  await settle();
  emitValue(r, {
    type: 'waterfall', event: 'approval/request', eventId: 'evt-huge', agentId: 'session-fixture-001',
    request: { payload: 'x'.repeat(1_100_000) },
  });
  await settle();
  check('an oversized frame ends the generation rather than leaving a verified hole',
    r.link.isVerified === false && r.link.pendingWaterfalls().length === 0 && r.lost.length === 1,
    JSON.stringify({ verified: r.link.isVerified, lost: r.lost.map((l) => l.reason) }));
  r.link.stop();
}

{
  // A carrier handed in from outside still has to carry the event stream and
  // still has to authenticate it, or the injection path is a broken constructor.
  const sockets: ReplaySocket[] = [];
  const headers: string[] = [];
  const mux = new DshMuxClient({
    baseUrl: 'http://127.0.0.1:3080',
    headers: () => { headers.push('cookie-called'); return { cookie: 'dsh-auth-FIXTURE=v1' }; },
    socketFactory: (url, sentHeaders) => {
      const listeners = new Map<string, Array<(e: unknown) => void>>();
      const socket = {
        sent: [] as string[],
        sentHeaders,
        send(data: string) { socket.sent.push(data); },
        close() {},
        addEventListener(type: string, listener: (e: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []) , listener]);
        },
        emit(type: string, event?: unknown) { for (const l of listeners.get(type) ?? []) l(event); },
      };
      sockets.push(socket as unknown as ReplaySocket);
      return socket as never;
    },
  }, { onOpen() {}, onLost() {} });
  const link = new DshEventLink({ mux, answer: async () => ({ ok: true }) });
  link.start();
  await settle();
  sockets[0]!.emit('open');
  await settle();
  check('an injected carrier still opens $events and still authenticates the upgrade',
    headers.length === 1 && sockets[0!]!.sent.length === 1
      && JSON.stringify(sockets[0!]!.sentHeaders) === JSON.stringify({ cookie: 'dsh-auth-FIXTURE=v1' }),
    `${String(headers.length)} header reads, ${String(sockets[0!]!.sent.length)} frames`);
  const openFrame = JSON.parse(sockets[0!]!.sent[0] ?? '{}') as { streamId?: string };
  sockets[0]!.emit('message', {
    data: JSON.stringify({ type: 'item', streamId: openFrame.streamId, value: READY }),
  });
  await settle();
  check('an injected carrier reaches a verified generation like an owned one',
    link.isVerified && link.currentGeneration?.clientId === READY.clientId,
    JSON.stringify(link.currentGeneration));
  const socketsBefore = sockets.length;
  link.stop();
  mux.stop();
  check('stopping a viewer does not disconnect a carrier it did not open',
    socketsBefore === 1, `${String(socketsBefore)}`);
}


{
  // F2: a stopped viewer must leave the carrier it was sharing alone.
  //
  // The link's reader stays parked on its logical stream after stop(), so the
  // wake-up arrives whenever the host next feels like sending. The test is that
  // wake-up: a stopped reader finding its generation cleared used to call that a
  // protocol breach and report it by failing the carrier, which closed the socket
  // out from under every session stream riding it.
  const built = handBuilt();
  const link = new DshEventLink({ mux: built.mux, answer: async () => ({ ok: true }) });
  link.start();
  await settle();
  built.sockets[0]!.emit('open');
  await settle();
  const eventStreamId = (JSON.parse(built.sockets[0]!.sent[0] ?? '{}') as { streamId?: string }).streamId ?? '';
  toStream(built.sockets[0]!, eventStreamId, READY);
  await settle();
  // A session attach sharing this exact socket, and still reading from it.
  const sessionStream = built.mux.open('session/follow', { args: {} });
  await settle();
  const socketsBefore = built.sockets.length;
  link.stop();
  const frames = built.sockets[0]!.sent.map((f) => JSON.parse(f) as Record<string, unknown>);
  check('stopping the link cancels its own event stream on the wire',
    frames.some((f) => f.type === 'cancel' && f.streamId === eventStreamId)
      && built.mux.activeStreamCount === 1,
    JSON.stringify(frames.map((f) => f.type)));
  // The host sends an ordinary event to the stream the link used to read.
  toStream(built.sockets[0]!, eventStreamId, { type: 'emit', event: 'session/updated', args: [] });
  await settle();
  check('an event that arrives after stop leaves the shared carrier open',
    built.sockets.length === socketsBefore && built.mux.isOpen && built.mux.activeStreamCount === 1,
    `${String(built.sockets.length)} sockets, open=${String(built.mux.isOpen)}, streams=${String(built.mux.activeStreamCount)}`);
  // The same for the two frames that DO end a generation when a live reader sees
  // them, which is the whole reason this regression is worth its length.
  built.sockets[0]!.emit('message', { data: JSON.stringify({ type: 'end', streamId: eventStreamId }) });
  await settle();
  built.sockets[0]!.emit('message', {
    data: JSON.stringify({ type: 'error', streamId: eventStreamId, error: { code: 'x/y', message: 'gone', details: {} } }),
  });
  await settle();
  check('an end or error for the retired stream cannot close a carrier it does not own',
    built.sockets.length === socketsBefore && built.mux.isOpen === true && sessionStream.settled === false,
    `${String(built.sockets.length)} sockets, open=${String(built.mux.isOpen)}, session settled=${String(sessionStream.settled)}`);
  // And the session that stayed is still a working subscription.
  toStream(built.sockets[0]!, sessionStream.streamId, { type: 'event', event: { type: 'ready' } });
  await settle();
  const read = await sessionStream[Symbol.asyncIterator]().next();
  check('the session riding the shared carrier still receives what the host sent',
    read.done === false && JSON.stringify(read.value) === JSON.stringify({ type: 'event', event: { type: 'ready' } }),
    JSON.stringify(read.value));
  link.stop();
  built.mux.stop();
}

{
  // F6: a carrier that was already open before the link existed.
  //
  // The observer sees transitions, and an injected carrier had its transition
  // already. Nothing repeats it, so a link that only ever reacted to the
  // callback opened no event stream at all: no `$events`, no ready frame, no
  // verification timeout, and a `false` that would stay false forever.
  const built = handBuilt();
  built.mux.start();
  await settle();
  built.sockets[0]!.emit('open');
  await settle();
  const openedBefore = built.sockets[0]!.sent.length;
  const link = new DshEventLink({ mux: built.mux, answer: async () => ({ ok: true }) });
  link.start();
  await settle();
  check('a link built on an already-open carrier opens its event stream',
    built.sockets[0]!.sent.length === openedBefore + 1
      && JSON.stringify((JSON.parse(built.sockets[0]!.sent[openedBefore] ?? '{}') as Record<string, unknown>).endpoint) === JSON.stringify('$events'),
    JSON.stringify(built.sockets[0]!.sent.map((f) => JSON.parse(f) as Record<string, unknown>)));
  const lateOpen = (JSON.parse(built.sockets[0]!.sent[openedBefore] ?? '{}') as { streamId?: string }).streamId ?? '';
  toStream(built.sockets[0]!, lateOpen, READY);
  await settle();
  check('and reaches a verified generation without waiting for an open that already happened',
    link.isVerified && link.currentGeneration?.clientId === READY.clientId,
    JSON.stringify(link.currentGeneration));
  // Repeating the notification for the SAME carrier must not open a second
  // event stream, which is what a start() that adopts plus an observer that
  // still fires would otherwise produce.
  const beforeRedeliver = built.sockets[0]!.sent.length;
  built.sockets[0]!.emit('open');
  await settle();
  check('one carrier gets one event stream even when the open is seen twice',
    built.sockets[0]!.sent.length === beforeRedeliver,
    `${String(built.sockets[0]!.sent.length - beforeRedeliver)} extra frames`);
  link.stop();
  built.mux.stop();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
