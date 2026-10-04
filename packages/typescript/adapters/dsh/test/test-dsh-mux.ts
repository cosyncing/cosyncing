/**
 * The 0.2 logical-stream carrier.
 *
 * The legacy downlink could only receive, and its tests proved that. This one
 * has to prove the opposite: that a client can open several streams over one
 * socket, cancel one without disturbing the others, tell a stream failure from a
 * socket failure, and put nothing back on the wire when it is done.
 *
 * Fake sockets and fake timers throughout, so "no orphan timers" is a count
 * rather than an act of faith.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-mux.ts
 */
export {};
import {
  DshMuxClient,
  DshStreamError,
  DSH_MUX_MAX_QUEUED_ITEMS,
  DSH_REMOTE_MUX_PATH,
  type DshMuxDiagnostic,
  type DshMuxSocketLike,
} from '../src/mux.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

class FakeSocket implements DshMuxSocketLike {
  readonly sent: string[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string, readonly headers: Readonly<Record<string, string>>) {}

  send(data: string): void {
    if (this.closed > 0) throw new Error('send on a closed socket');
    this.sent.push(data);
  }

  close(): void { this.closed += 1; }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

interface Harness {
  client: DshMuxClient;
  sockets: FakeSocket[];
  diagnostics: DshMuxDiagnostic[];
  lost: Array<{ generation: number; reason: string }>;
  opened: number[];
  /** Open the socket the client just created and return it. */
  connect(index?: number): FakeSocket;
  /** Fire every scheduled callback, which is how a backoff is tested in zero seconds. */
  runTimers(): void;
  timers: { get pending(): number };
}

function harness(options: {
  autoOpen?: boolean;
  headers?: () => Readonly<Record<string, string>>;
  socketFactory?: (url: string, headers: Readonly<Record<string, string>>) => DshMuxSocketLike;
  reconnectDelayMs?: number;
  maxQueuedBytesOverride?: number;
} = {}): Harness {
  const sockets: FakeSocket[] = [];
  const diagnostics: DshMuxDiagnostic[] = [];
  const lost: Array<{ generation: number; reason: string }> = [];
  const opened: number[] = [];
  // Fake timers, so a reconnect delay is a assertion about a count rather than
  // a pause in the suite, and so "no orphan timers" can be measured.
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const harnessValue: Harness = {
    sockets,
    diagnostics,
    lost,
    opened,
    timers: { get pending() { return timers.size; } },
    runTimers() {
      for (const [, fire] of [...timers.entries()]) fire();
    },
    client: undefined as unknown as DshMuxClient,
    connect(index = sockets.length - 1) {
      const socket = sockets[index];
      if (!socket) throw new Error('no socket yet');
      socket.emit('open');
      return socket;
    },
  };
  harnessValue.client = new DshMuxClient({
    baseUrl: 'http://127.0.0.1:3080',
    headers: options.headers,
    socketFactory: options.socketFactory ?? ((url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      if (options.autoOpen !== false) queueMicrotask(() => socket.emit('open'));
      return socket;
    }),
    ...(options.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: options.reconnectDelayMs }),
    ...(options.maxQueuedBytesOverride === undefined ? {} : { maxQueuedBytes: options.maxQueuedBytesOverride }),
    setTimeout: (handler) => {
      const id = ++timerSeq;
      timers.set(id, () => {
        timers.delete(id);
        handler();
      });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') timers.delete(handle);
    },
  }, {
    onOpen: (generation) => opened.push(generation),
    onLost: (generation, reason) => lost.push({ generation, reason }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return harnessValue;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 1. Open, and the exact frames the host's parser accepts ──────────────────

{
  const h = harness({ autoOpen: false });
  const stream = h.client.open('session/follow', { args: { request: { sessionId: 's1' } } });
  check('a stream is handed back before the socket exists, so an attach never races a handshake',
    h.sockets.length === 1 && stream !== undefined);
  check('opening a carrier against a stopped client asks for one, rather than queueing forever',
    h.sockets[0]?.url === `ws://127.0.0.1:3080${DSH_REMOTE_MUX_PATH}`, h.sockets[0]?.url ?? 'none');

  const socket = h.connect(0);
  await settle();
  const frames = socket.frames();
  // The host parser requires EXACTLY these four keys on an open frame; an extra
  // one is a rejected message, and a missing payload is a different stream.
  check('the open frame carries exactly type, streamId, endpoint and payload',
    frames.length === 1 && JSON.stringify(Object.keys(frames[0] ?? {}).sort())
      === JSON.stringify(['endpoint', 'payload', 'streamId', 'type']),
    JSON.stringify(frames[0]));
  check('the open frame names the endpoint and passes the payload through untouched',
    JSON.stringify(frames[0] ?? {}) === JSON.stringify({
      type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { request: { sessionId: 's1' } } },
    }), JSON.stringify(frames[0]));
  check('an open held while the socket was cold is written exactly once on open',
    socket.sent.length === 1, String(socket.sent.length));
  h.client.stop();
}

{
  // Headers are read per attempt, so a cookie renewed between two carriers is
  // used by the second one. A captured-once header would pin a dead credential
  // to every socket for the life of the process.
  let token = 'first';
  const h = harness({ autoOpen: false, headers: () => ({ cookie: `dsh-auth-x=${token}` }) });
  h.client.open('$events', { args: {} });
  await settle();
  const first = h.sockets[0];
  check('the carrier authenticates its WebSocket upgrade with the current cookie',
    first?.headers.cookie === 'dsh-auth-x=first', first?.headers.cookie ?? 'none');
  token = 'second';
  h.client.failGeneration('test');
  h.runTimers();
  await settle();
  h.connect(1);
  await settle();
  check('the next carrier picks up the rotated credential',
    h.sockets[1]?.headers.cookie === 'dsh-auth-x=second', h.sockets[1]?.headers.cookie ?? 'none');
  h.client.stop();
}

// ── 2. Many streams, independently ─────────────────────────────────────────

{
  const h = harness();
  const a = h.client.open('session/follow', { args: {} });
  const b = h.client.open('session/control', { args: {} });
  const c = h.client.open('workspace/follow', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  const ids = socket.frames().map((frame) => String(frame.streamId));
  check('three streams get three distinct ids on one socket',
    new Set(ids).size === 3 && h.client.activeStreamCount === 3, ids.join(','));

  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: ids[1], value: { n: 2 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: ids[0], value: { n: 1 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: ids[1], value: { n: 3 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: ids[0] }) });

  const seenA: unknown[] = [];
  for await (const value of a) seenA.push(value);
  const seenB: unknown[] = [];
  let bDone = 0;
  const iterateB = (async () => {
    for await (const value of b) seenB.push(value);
    bDone += 1;
  })();

  check('items are routed to their own stream and stay in order',
    JSON.stringify(seenA) === JSON.stringify([{ n: 1 }]) && h.client.activeStreamCount === 2,
    `${JSON.stringify(seenA)} / ${String(h.client.activeStreamCount)} active`);

  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: ids[1], value: { n: 4 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: ids[1] }) });
  await iterateB;
  check('a stream that ends mid-iteration delivers its tail and completes normally',
    bDone === 1 && JSON.stringify(seenB) === JSON.stringify([{ n: 2 }, { n: 3 }, { n: 4 }]),
    JSON.stringify(seenB));

  // c is still open: an end on a sibling must not reach it.
  const pending = (async () => { const it = c[Symbol.asyncIterator](); return it.next(); })();
  await settle();
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: ids[2], value: 'still-here' }) });
  const next = await pending;
  check('a sibling ending does not settle an open stream', next.done === false && next.value === 'still-here',
    JSON.stringify(next));
  h.client.stop();
}

// ── 3. Cancel, error, and the difference between them ───────────────────────

{
  const h = harness();
  const doomed = h.client.open('session/follow', { args: {} });
  const kept = h.client.open('session/control', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  const frames = socket.frames();
  const doomedId = String(frames[0]?.streamId);

  doomed.cancel();
  await settle();
  const cancel = socket.frames().find((frame) => frame.type === 'cancel');
  check('a cancel is written to the host and names only that stream',
    JSON.stringify(cancel) === JSON.stringify({ type: 'cancel', streamId: doomedId }), JSON.stringify(cancel));

  let caught: unknown;
  try {
    for await (const _value of doomed) void _value;
  } catch (error) { caught = error; }
  check('the cancelled iterator ends quietly: asking to stop is not a failure',
    caught === undefined, String(caught));

  socket.emit('message', {
    data: JSON.stringify({
      type: 'error',
      streamId: String(frames[1]?.streamId),
      error: { code: 'session/writer-held', message: 'another writer holds this session', details: {} },
    }),
  });
  let streamError: DshStreamError | undefined;
  try {
    for await (const _value of kept) void _value;
  } catch (error) { streamError = error as DshStreamError; }
  check('a business failure arrives on its own stream and keeps the host code',
    streamError instanceof DshStreamError && streamError.failure.code === 'session/writer-held',
    String(streamError?.failure.code));
  check('a stream error does not end the carrier: the socket stays and no generation is lost',
    h.lost.length === 0 && h.sockets[0]?.closed === 0,
    `${String(h.lost.length)} losses, ${String(h.sockets[0]?.closed)} closes`);
  h.client.stop();
}

// ── 4. Carrier loss is not stream loss ──────────────────────────────────────

{
  const h = harness({ autoOpen: false, reconnectDelayMs: 10 });
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  h.connect(0);
  await settle();
  const iteration = (async () => {
    const seen: unknown[] = [];
    try {
      for await (const value of stream) seen.push(value);
    } catch (error) {
      return { seen, error: error instanceof DshStreamError ? error.failure.code : String(error) };
    }
    return { seen, error: undefined };
  })();
  await settle();
  h.sockets[0]!.emit('close');
  const outcome = await iteration;
  check('physical loss fails every stream on it rather than pretending they are whole',
    outcome.error === 'carrier/lost', String(outcome.error));
  check('the generation ends once, and the caller learns why',
    h.lost.length === 1 && h.lost[0]?.reason === 'stream carrier closed', JSON.stringify(h.lost));
  check('the generation counter moves so a late frame from the dead socket is discarded',
    h.client.generation === 1, String(h.client.generation));
  check('a reconnect is scheduled rather than hammered',
    h.timers.pending === 1, `${String(h.timers.pending)} pending`);

  h.runTimers();
  h.connect(1);
  await settle();
  check('a fresh carrier comes up on its own after the delay', h.sockets.length === 2, String(h.sockets.length));

  // A frame from the SUPERSEDED socket, delivered late, must not be attributed
  // to the new generation's stream.
  const survivor = h.client.open('session/control', { args: {} });
  await settle();
  const newId = h.sockets[1]!.frames()[0]?.streamId;
  h.sockets[0]!.emit('message', { data: JSON.stringify({ type: 'end', streamId: newId }) });
  await settle();
  check('an end from a dead socket does not settle a stream that lives on the new one',
    survivor.hasWaitingReader === false && h.client.activeStreamCount === 1,
    `${String(survivor.hasWaitingReader)} / ${String(h.client.activeStreamCount)}`);
  h.client.stop();
  check('stopping clears the pending reconnect rather than leaving it to fire later',
    h.timers.pending === 0, `${String(h.timers.pending)} pending`);
}

// ── 5. An unreadable frame ends the generation, not the silence ──────────────

{
  const h = harness({ reconnectDelayMs: 10 });
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  h.connect(0);
  await settle();
  const socket = h.sockets[0]!;

  // An unknown stream id IS attributable: this client retired that id, the host
  // documents dropping frames for it, and the socket is still telling the truth
  // about the streams it has not retired. That is contained. Everything below is
  // not, because it cannot be attributed to anything.
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: 'nobody-has-this', value: 1 }) });
  await settle();
  check('a frame for a retired stream is contained and leaves the carrier alone',
    h.diagnostics.some((entry) => entry.code === 'unknown-stream')
      && h.lost.length === 0 && h.client.activeStreamCount === 1,
    JSON.stringify(h.diagnostics));

  // These three each arrive with the ORIGINAL carrier still live, so each is
  // tested on a fresh client: the first one to land ends the generation and the
  // rest would be attributed to a socket that no longer exists.
  const contained = h.diagnostics.length;
  socket.emit('message', { data: 'this is not json' });
  await settle();
  check('a frame that is not decodable ends the generation rather than creating a silent hole',
    h.lost.length === 1 && h.lost[0]?.reason === 'the stream carrier sent something that was not a frame'
      && h.diagnostics.length > contained && stream.settled,
    JSON.stringify(h.lost));
  // The rebuild is the point: the caller gets a fresh generation to re-baseline
  // on, not a subscription that looks live and is quietly missing a page.
  h.runTimers();
  h.connect(1);
  await settle();
  check('the carrier rebuilds itself after an undecodable frame', h.sockets.length === 2, String(h.sockets.length));
  h.client.stop();
}

{
  const h = harness({ reconnectDelayMs: 10 });
  h.client.open('session/follow', { args: {} });
  await settle();
  h.connect(0);
  await settle();
  const before = h.diagnostics.length;
  const big = JSON.stringify({ type: 'item', streamId: 'x', value: 'x'.repeat(1_100_000) });
  h.sockets[0]!.emit('message', { data: big });
  await settle();
  check('an oversized frame is refused before parsing AND ends the generation it arrived on',
    h.diagnostics.slice(before).some((entry) => entry.code === 'frame-too-large')
      && h.lost.length === 1 && (h.lost[0]?.reason.includes('exceeded the size') ?? false),
    JSON.stringify(h.lost));
  h.client.stop();
}

{
  const h = harness({ reconnectDelayMs: 10 });
  h.client.open('session/follow', { args: {} });
  await settle();
  h.connect(0);
  await settle();
  const before = h.diagnostics.length;
  h.sockets[0]!.emit('message', { data: JSON.stringify({ type: 'nonsense', streamId: 'x' }) });
  h.sockets[0]!.emit('message', { data: JSON.stringify({ type: 'item', value: 1 }) });
  await settle();
  check('a well-formed JSON object outside the frame grammar also ends the generation',
    h.lost.length === 1 && h.diagnostics.slice(before).every((entry) => entry.code === 'undecodable-frame'),
    JSON.stringify({ lost: h.lost, d: h.diagnostics.slice(before) }));
  h.client.stop();
}

// ── 5b. Bounds, release, and accounting that adds up ─────────────────────────

{
  // The exact accounting bug: a consumer that reads every message before the
  // next one arrives should never overflow, however long it runs. Charging the
  // carrier frame and crediting back only the payload left the difference behind
  // on every message, so a busy-but-caught-up stream overflowed its own history.
  const h = harness({ maxQueuedBytesOverride: 200 });
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  const iterator = stream[Symbol.asyncIterator]();
  const residual: number[] = [];
  let overflowed = false;
  for (let index = 0; index < 8; index += 1) {
    socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { n: index } }) });
    const next = await iterator.next();
    if (next.done === true) { overflowed = true; break; }
    residual.push(stream.bufferedBytes);
  }
  check('a fully-consumed queue is empty, not a running total of envelope overhead',
    overflowed === false && residual.every((bytes) => bytes === 0) && stream.bufferedBytes === 0,
    `${residual.join(',')} residual, overflowed=${String(overflowed)}`);
  h.client.stop();
}

{
  // A backlog that nobody reads must still fail: the bound is about an
  // abandoned reader, not about a healthy one.
  const h = harness({ maxQueuedBytesOverride: 400 });
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  let code = 'none';
  for (let index = 0; index < 40 && code === 'none'; index += 1) {
    socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { n: index } }) });
  }
  try {
    for await (const _value of stream) void _value;
  } catch (error) { code = error instanceof DshStreamError ? error.failure.code : String(error); }
  const cancelled = socket.frames().some((frame) => frame.type === 'cancel');
  check('a real backlog still trips, and the abandoned producer is cancelled upstream',
    code === 'client/stream-overflow' && cancelled && h.client.activeStreamCount === 0,
    `${code}, cancelled=${String(cancelled)}, active=${String(h.client.activeStreamCount)}`);
  h.client.stop();
}

{
  // Breaking out of the iteration is the ordinary way a caller finishes with a
  // stream, and the host keeps producing until someone says otherwise.
  const h = harness();
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: 1 }) });
  for await (const _value of stream) break;
  check('breaking out of the iterator releases the slot and cancels the subscription',
    h.client.activeStreamCount === 0
      && JSON.stringify(socket.frames().at(-1)) === JSON.stringify({ type: 'cancel', streamId: stream.streamId }),
    JSON.stringify(socket.frames().map((frame) => frame.type)));

  // A stream the HOST already ended needs no cancel, and sending one for a
  // retired id is the case the gateway answers by dropping the socket.
  const finished = h.client.open('session/control', { args: {} });
  await settle();
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: finished.streamId }) });
  const framesBefore = socket.sent.length;
  finished.cancel();
  check('cancelling a stream the host already ended puts nothing back on the wire',
    socket.sent.length === framesBefore && finished.endedByHost,
    `${String(socket.sent.length - framesBefore)} extra frames`);
  h.client.stop();
}

{
  // Releasing before the socket ever opened must not write to a socket that does
  // not exist, and must not leave the slot claimed.
  const h = harness({ autoOpen: false });
  const stream = h.client.open('session/follow', { args: {} });
  stream.cancel();
  check('a stream released before its carrier opened leaves no slot and writes nothing',
    h.client.activeStreamCount === 0 && (h.sockets[0]?.sent.length ?? -1) === 0,
    `${String(h.client.activeStreamCount)} active`);
  h.client.stop();
}

// ── 6. Teardown ─────────────────────────────────────────────────────────────

{
  const h = harness();
  const a = h.client.open('session/follow', { args: {} });
  const b = h.client.open('session/control', { args: {} });
  await settle();
  const socket = h.sockets[0]!;
  a.drain();
  b.drain();
  h.client.stop();
  check('stopping closes the socket once and retires every stream',
    socket.closed === 1 && h.client.activeStreamCount === 0,
    `${String(socket.closed)} closes, ${String(h.client.activeStreamCount)} streams`);

  // Both iterators must be RELEASED. They are released with a carrier loss and
  // not a quiet end, which is the difference between "this transcript finished"
  // and "this client stopped caring"; the first is a fact the host asserted and
  // the second is something only this process knows. Either way, nothing hangs.
  const released: string[] = [];
  for (const stream of [a, b]) {
    try {
      for await (const _value of stream) void _value;
      released.push('quiet');
    } catch (error) {
      released.push(error instanceof DshStreamError ? error.failure.code : String(error));
    }
  }
  check('every parked iterator is released by the stop, with the reason it stopped',
    released.join(',') === 'carrier/lost,carrier/lost', released.join(','));

  const after = h.client.open('session/control', { args: {} });
  let stoppedCode = 'none';
  try {
    for await (const _value of after) void _value;
  } catch (error) { stoppedCode = error instanceof DshStreamError ? error.failure.code : String(error); }
  check('a stream opened after the stop fails at once rather than waiting for a socket',
    stoppedCode === 'carrier/closed', stoppedCode);

  h.client.start();
  await settle();
  // The stop ended the previous epoch, so the new socket opens in generation 1
  // rather than reusing the zeroth one that the stop retired.
  check('a later attach gets a live carrier again rather than a silent no-op',
    h.sockets.length === 2 && h.client.generation === 1 && h.client.isOpen,
    `${String(h.sockets.length)} sockets, generation ${String(h.client.generation)}`);
  h.client.stop();
}

// ── 7. A write that throws is a dead carrier ────────────────────────────────

{
  // A socket whose handshake succeeds and whose very first write fails, which
  // is the case where the host may or may not have seen anything.
  const h = harness({
    socketFactory: () => {
      const socket = new (class implements DshMuxSocketLike {
        closed = 0;
        private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

        send(): void { throw new Error('EPIPE'); }

        close(): void { this.closed += 1; }

        addEventListener(type: string, listener: (event: unknown) => void): void {
          const list = this.listeners.get(type) ?? [];
          list.push(listener);
          this.listeners.set(type, list);
        }

        emit(type: string, event?: unknown): void {
          for (const listener of this.listeners.get(type) ?? []) listener(event);
        }
      })();
      queueMicrotask(() => socket.emit('open'));
      return socket;
    },
  });
  const stream = h.client.open('session/follow', { args: {} });
  let code = 'none';
  try {
    for await (const _value of stream) void _value;
  } catch (error) { code = error instanceof DshStreamError ? error.failure.code : String(error); }
  // There is no way to know which frames landed, so nothing derived from this
  // generation can be claimed complete.
  check('a socket that dies mid-write ends the generation rather than the one stream',
    code === 'carrier/lost' && h.lost.length > 0, `${code} / ${JSON.stringify(h.lost)}`);
  h.client.stop();
}

// ── 8. One iterator per stream ──────────────────────────────────────────────

{
  const h = harness();
  const stream = h.client.open('session/follow', { args: {} });
  await settle();
  h.sockets[0]!.emit('message', { data: JSON.stringify({ type: 'item', streamId: 's1', value: 'mine' }) });
  const first = stream[Symbol.asyncIterator]();
  const firstItem = await first.next();
  check('the first reader gets the items', firstItem.done === false && firstItem.value === 'mine',
    JSON.stringify(firstItem));
  // Refused at the moment it is asked for, not on its first `next()`: an
  // iterator that only discovers it is unwanted once it parks is a hang.
  let secondIteratorThrew = 'did not throw';
  try {
    stream[Symbol.asyncIterator]();
  } catch (error) { secondIteratorThrew = error instanceof Error ? error.message : String(error); }
  check('one stream cannot be split between two readers',
    secondIteratorThrew.includes('already iterated'), secondIteratorThrew);
  h.client.stop();
}

{
  // Breaking out of the iterator already cancelled. A caller who then releases
  // the handle by hand is finishing a sentence the loop already said, and a
  // second frame naming a retired stream id is exactly what the gateway objects
  // to, so a repeat release has to be a no-op on the wire.
  const h = harness();
  const stream = h.client.open('session/follow', { args: { request: {} } });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: 1 }) });
  for await (const _value of stream) break;
  const afterFirst = socket.frames().filter((frame) => frame.type === 'cancel').length;
  stream.cancel();
  stream.cancel();
  await settle();
  const afterMore = socket.frames().filter((frame) => frame.type === 'cancel').length;
  check('releasing a stream again after the iterator already did it writes nothing more',
    afterFirst === 1 && afterMore === 1 && h.client.activeStreamCount === 0,
    `${String(afterFirst)} then ${String(afterMore)} cancel frames`);
  h.client.stop();
}

// ── 5c. What cancellation actually releases (review R6, round-2 F8) ──────────

{
  // A cancelled handle that keeps its queue is a handle that still owns the
  // bytes: the accounting stays charged while the data has no consumer, and a
  // caller that reads the rest gets values it promised never to use.
  const h = harness();
  const stream = h.client.open('session/follow', { args: { request: {} } });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', {
    data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { blob: 'x'.repeat(200) } }),
  });
  const queued = stream.bufferedBytes;
  stream.cancel();
  const handedBack: unknown[] = [];
  for await (const value of stream) handedBack.push(value);
  check('a cancelled stream gives back neither its queued item nor its charge',
    queued > 0 && stream.bufferedBytes === 0 && handedBack.length === 0 && stream.settled,
    `${String(queued)} charged, ${String(stream.bufferedBytes)} after, ${String(handedBack.length)} delivered`);
  h.client.stop();
}

{
  // The other direction: a stream the HOST ended delivered everything it meant
  // to deliver. Discarding on release must not reach into that case, or a
  // history page the reader had not gotten to yet disappears.
  const h = harness();
  const stream = h.client.open('session/follow', { args: { request: {} } });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { page: 1 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: stream.streamId }) });
  const drained: unknown[] = [];
  for await (const value of stream) drained.push(value);
  check('a stream the host ended still hands over what it had already written',
    drained.length === 1 && JSON.stringify(drained[0]) === JSON.stringify({ page: 1 }) && stream.endedByHost,
    JSON.stringify(drained));
  h.client.stop();
}

{
  // The two orders together, which is where the distinction was still lost: the host
  // ends the stream, the buffer keeps its items for a reader that means to finish
  // them, and THEN the reader cancels. An early return on an already-ended stream
  // left those bytes charged and the items readable by a handle whose owner had
  // said it would not use them.
  const h = harness();
  const stream = h.client.open('session/follow', { args: { request: {} } });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { page: 1 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: stream.streamId }) });
  const charged = stream.bufferedBytes;
  stream.cancel();
  const handedBack: unknown[] = [];
  for await (const value of stream) handedBack.push(value);
  check('a stream cancelled after the host ended it gives up its buffer too',
    charged > 0 && stream.bufferedBytes === 0 && handedBack.length === 0,
    String(charged) + ' charged, ' + String(stream.bufferedBytes) + ' after, '
      + String(handedBack.length) + ' delivered');
  check('cancelling a stream the host already settled writes nothing to the wire',
    socket.frames().filter((frame) => frame.type === 'cancel').length === 0,
    String(socket.frames().filter((frame) => frame.type === 'cancel').length) + ' cancel frames');
  h.client.stop();
}

{
  // The same release through the ordinary exit. Breaking out of the iterator is
  // how callers stop a stream, and a reader that leaves a host-ended stream with
  // pages unread has stopped consuming them.
  const h = harness();
  const stream = h.client.open('session/follow', { args: { request: {} } });
  await settle();
  const socket = h.sockets[0]!;
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { page: 1 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { page: 2 } }) });
  socket.emit('message', { data: JSON.stringify({ type: 'end', streamId: stream.streamId }) });
  const seen: unknown[] = [];
  for await (const value of stream) {
    seen.push(value);
    break;
  }
  check('breaking out of a host-ended stream releases what it still held',
    seen.length === 1 && stream.bufferedBytes === 0,
    String(seen.length) + ' read, ' + String(stream.bufferedBytes) + ' left');
  check('breaking out of a host-ended stream sends no cancel',
    socket.frames().filter((frame) => frame.type === 'cancel').length === 0,
    'a cancel was written for a stream the host had settled');
  h.client.stop();
}

{
  // Cancellation during the handshake. The open frame is sitting in the carrier
  // waiting for a writable socket, and the active-stream count comes from the
  // registration, which a cancelled stream has already lost — so a caller that
  // opens and cancels while the carrier connects is not held by the ceiling at
  // all, and the serialized requests pile up for the life of the socket.
  const h = harness({ autoOpen: false });
  for (let index = 0; index < 256; index += 1) {
    h.client.open('session/follow', { args: { request: { sessionId: `session-fixture-${String(index)}` } } }).cancel();
  }
  check('cancelling an open that was still waiting for the socket releases the request',
    h.client.pendingOpenCount === 0 && h.client.activeStreamCount === 0,
    `${String(h.client.pendingOpenCount)} pending opens retained`);
  const socket = h.connect();
  check('and nothing is written when the carrier finally gets its socket',
    socket.sent.length === 0 && h.sockets.length === 1,
    `${String(socket.sent.length)} frames written`);
  h.client.stop();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
