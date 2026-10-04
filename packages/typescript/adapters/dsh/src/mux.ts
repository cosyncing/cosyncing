/**
 * The 0.2 Remote stream carrier: one authenticated WebSocket at
 * `/api/remote.mux` carrying MANY logical streams, each independently
 * openable and cancellable.
 *
 * This is the opposite of the legacy downlink, and the difference is the whole
 * reason it is a separate module. 0.1 gave the client two sockets that only
 * pushed and an out-of-band answer route; 0.2 puts every stream — session
 * history, the projection control feed, workspace membership, the forwarded
 * event stream, a timed question's wait — on one socket with client-written
 * `open`, `item`, `end` and `cancel` frames. A socket abstraction with no send
 * path is not a conservative version of this; it is a client that can never
 * attach to anything.
 *
 * Kept separate from {@link DshRemoteClient} on purpose: one is a request, the
 * other is a subscription, and the resource discipline differs. Every terminal
 * path here has to release its stream's queue, its queued bytes, and (for the
 * last one) the socket, or a broker that attaches and detaches sessions all day
 * accumulates exactly the thing it was built to avoid.
 */

/** Exact WebSocket route carrying every Remote stream. */
export const DSH_REMOTE_MUX_PATH = '/api/remote.mux';

/** Logical endpoint for the host's forwarded event stream. Not a `namespace/method` pair. */
export const DSH_EVENT_STREAM_ENDPOINT = '$events';

/** The only payload the forwarded event stream accepts. */
export const DSH_EVENT_STREAM_PAYLOAD = Object.freeze({ args: Object.freeze({}) });

/** Frames this client may write. Exact key sets are the host's parser's requirement. */
export type DshMuxClientFrame =
  | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'cancel'; streamId: string };

/** One frame the host wrote. `end` and `error` both carry a `streamId`. */
export type DshMuxHostFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: { code: string; message: string; details: unknown } };

/** The socket surface this module uses. Unlike the legacy downlink it CAN send. */
export interface DshMuxSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export type DshMuxSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => DshMuxSocketLike;

/** Backoff floor between carrier attempts, so a down host is not hammered. */
export const DSH_MUX_RECONNECT_DELAY_MS = 1_000;

/**
 * Ceiling on one inbound frame, measured on the raw text BEFORE parsing. A real
 * frame is a history page or a projection baseline, so this is generous; it
 * exists so an unverified endpoint cannot make this client parse and retain
 * without bound.
 */
export const DSH_MUX_FRAME_MAX_BYTES = 1_048_576;

/** Active logical streams on one socket. Every domain in this adapter needs three at once. */
export const DSH_MUX_MAX_ACTIVE_STREAMS = 64;

/** Queued inbound items per stream, and the byte ceiling behind them. */
export const DSH_MUX_MAX_QUEUED_ITEMS = 2_000;
export const DSH_MUX_MAX_QUEUED_BYTES = 8 * 1_048_576;

/** Contained problems. None of these ends the carrier on its own. */
export interface DshMuxDiagnostic {
  code: 'undecodable-frame' | 'frame-too-large' | 'socket-error' | 'stream-overflow' | 'unknown-stream';
  detail?: string;
}

export interface DshMuxOptions {
  baseUrl: string;
  socketFactory?: DshMuxSocketFactory;
  /** Per-attempt request headers, so a rotated cookie is used by the NEXT socket. */
  headers?: () => Readonly<Record<string, string>>;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reconnectDelayMs?: number;
  newStreamId?: () => string;
  maxActiveStreams?: number;
  maxQueuedItems?: number;
  maxQueuedBytes?: number;
}

/**
 * A second pair of eyes on one carrier.
 *
 * The carrier reconnects itself, and anything riding it has to know when a
 * generation began and ended in order to re-baseline. With exactly one handler
 * set supplied at construction, a carrier handed to another component could not
 * also report to the component that owns the socket — which pushed callers
 * toward opening a second carrier, and a second carrier against one host means
 * two reconnect loops with two different answers to which generation is current.
 */
export interface DshMuxObserver {
  onOpen?(generation: number): void;
  onLost?(generation: number, reason: string): void;
  onDiagnostic?(diagnostic: DshMuxDiagnostic): void;
}

export interface DshMuxHandlers {
  /** The socket is open. The caller must still PROVE the carrier before trusting it. */
  onOpen(generation: number): void;
  /** The carrier ended. Everything derived from that generation is stale. */
  onLost(generation: number, reason: string): void;
  onDiagnostic?(diagnostic: DshMuxDiagnostic): void;
}

/** A failure delivered on one stream. It ends that stream and nothing else. */
export interface DshStreamFailure {
  code: string;
  message: string;
  details: unknown;
}

/** Raised when a stream's own iterator sees a terminal failure. */
export class DshStreamError extends Error {
  constructor(readonly failure: DshStreamFailure) {
    super(`${failure.code}: ${failure.message}`);
    this.name = 'DshStreamError';
  }
}

/**
 * One logical stream.
 *
 * Iteration is single-consumer, which matches both the host (one uplink per
 * call) and every caller in this adapter (one session connection per native
 * session). Cancelling is quiet: the iterator ends without an error, because a
 * caller that asked to stop did not experience a failure.
 */
export class DshMuxStream {
  /**
   * Each entry carries the byte count it was CHARGED for. Subtracting a figure
   * recomputed at dequeue is how accounting drifts: the charge includes the
   * carrier's frame envelope and the recomputation does not, so every consumed
   * message leaves its overhead behind and a stream that is being read as fast
   * as it fills eventually overflows its own history.
   */
  private readonly queue: Array<{ value: unknown; bytes: number }> = [];
  private queuedBytes = 0;
  private ended = false;
  /** The host finished this stream itself, so there is nothing left to cancel. */
  private hostSettled = false;
  private failure?: DshStreamFailure;
  private waiters: Array<(entry: { done: boolean; value?: unknown }) => void> = [];
  private consumed = false;

  constructor(
    readonly streamId: string,
    readonly endpoint: string,
    private readonly onTerminate: (stream: DshMuxStream) => void,
    private readonly maxQueuedItems: number,
    private readonly maxQueuedBytes: number,
  ) {}

  /** True once nothing more can arrive, whether from `end`, `error`, or a lost carrier. */
  get settled(): boolean {
    return this.ended;
  }

  /**
   * Whether the HOST ended this stream. A stream the host finished needs no
   * cancel, and sending one for an id the host has retired is the case the
   * gateway punishes by closing the socket.
   */
  get endedByHost(): boolean {
    return this.hostSettled;
  }

  /** Bytes currently held for this stream, used by the carrier's global budget. */
  get bufferedBytes(): number {
    return this.queuedBytes;
  }

  /** Inbound delivery. Never called after settlement. */
  deliver(value: unknown, bytes: number): boolean {
    if (this.ended) return false;
    if (this.queue.length >= this.maxQueuedItems || this.queuedBytes + bytes > this.maxQueuedBytes) {
      // Overflow is a stream failure, not a socket failure: one session that
      // nobody is reading must not take the other sessions' streams down.
      this.fail({
        code: 'client/stream-overflow',
        message: 'the reader fell behind and this stream was dropped',
        details: {},
      });
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      // Nothing is retained, so nothing is charged. The delivering frame still
      // counted against the caller's reader, not against this queue.
      waiter({ done: false, value });
      return true;
    }
    this.queue.push({ value, bytes });
    this.queuedBytes += bytes;
    return true;
  }

  /**
   * The host ended this stream with `end`. There is no work left upstream and no
   * cancel to send, whatever the local reader does next.
   *
   * Items the host already wrote stay readable. A method that returned normally
   * delivered everything it meant to deliver, and a reader that had not gotten
   * to the last page yet would lose it; the drain ends when the queue does.
   * Client-side release is the opposite case and discards, below.
   */
  finishFromHost(): void {
    this.hostSettled = true;
    if (this.ended) return;
    this.ended = true;
    this.flush();
  }

  /** The host ended this stream with `error`. */
  failFromHost(failure: DshStreamFailure): void {
    this.hostSettled = true;
    this.fail(failure);
  }

  fail(failure: DshStreamFailure): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = failure;
    // A stream that failed is not going to deliver the items it was holding, so
    // holding their bytes is a claim about memory this client no longer has.
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.flush();
  }

  /**
   * This client stopped caring. Says nothing about what the host did.
   *
   * Discarded rather than drained. A handle whose owner has cancelled must not
   * keep handing back values, because the one thing the caller has promised is
   * that it will not use them — and a retained cancelled handle would go on
   * charging its bytes against the carrier's global budget for as long as the
   * handle itself was reachable.
   *
   * This runs for a cancellation that arrives AFTER the host ended the stream too,
   * which is the ordering where an early return used to keep the buffer alive.
   */
  releaseLocally(): void {
    // Discarded even when the host settled the stream first. A normal end keeps the
    // buffer for a reader that means to finish it, but a reader that cancels after
    // that has promised not to use the items, and returning early here left them
    // charged to the carrier and still readable. The wire stays quiet either way:
    // terminate() asks the stream whether the HOST settled it before cancelling.
    this.ended = true;
    this.drain();
    this.flush();
  }

  private flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter({ done: true });
  }

  /**
   * Stop consuming this stream.
   *
   * One operation with upstream cleanup, because abandoning a subscription is
   * not a local act: the host keeps producing until the stream ends, is
   * cancelled, or the physical connection closes. A release that only unregistered
   * the local half leaked server work for the life of the carrier, and
   * re-attaching a session repeatedly would spend the active-stream ceiling on
   * subscriptions nobody was reading.
   *
   * Breaking out of the iterator calls this, so the ordinary way of finishing
   * with a stream is the way that cleans up. It is idempotent, and a no-op on the
   * wire once the host has said `end` or `error`.
   */
  cancel(): void {
    this.onTerminate(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // A second iterator on the same handle would split one ordered transcript
    // between two readers, which is how history ends up interleaved. The claim
    // is made HERE rather than inside the generator body, because a generator
    // does not run until its first `next()`: a guard that waits for that hands
    // the second caller an iterator that parks on a queue that will never be
    // theirs, which looks like a hang rather than the programming error it is.
    if (this.consumed) throw new Error('dsh stream already iterated');
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncIterator<unknown> {
    try {
      for (;;) {
        if (this.queue.length > 0) {
          const entry = this.queue.shift();
          if (entry) this.queuedBytes = Math.max(0, this.queuedBytes - entry.bytes);
          yield entry?.value;
          continue;
        }
        if (this.failure) throw new DshStreamError(this.failure);
        if (this.ended) return;
        const entry = await new Promise<{ done: boolean; value?: unknown }>((resolve) => {
          this.waiters.push(resolve);
        });
        if (entry.done) {
          if (this.failure) throw new DshStreamError(this.failure);
          return;
        }
        yield entry.value;
      }
    } finally {
      // Covers the consumer breaking out early, throwing inside the loop body,
      // and returning a partially-consumed iterator to a caller that has moved
      // on. All three leave a live host subscription unless something cancels it.
      this.cancel();
    }
  }

  /** Release the local buffer without claiming anything about the host. */
  drain(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  /** Test seam: whether a waiting iterator is parked on this stream. */
  get hasWaitingReader(): boolean {
    return this.waiters.length > 0;
  }
}

/**
 * One carrier generation at a time, with the streams that belonged to it.
 *
 * Physical loss and logical end are different facts and are kept apart: a
 * stream ending because its method returned says nothing about the socket, and
 * a socket dying says that EVERY stream on it may have missed items. The
 * generation counter is what lets a late `end` from a superseded socket be
 * discarded rather than mistaken for the end of a stream that has since been
 * reopened under the same id.
 */
export class DshMuxClient {
  private readonly baseUrl: string;
  private readonly socketFactory: DshMuxSocketFactory;
  private readonly headers: () => Readonly<Record<string, string>>;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly reconnectDelayMs: number;
  private readonly newStreamId: () => string;
  private readonly maxActiveStreams: number;
  private readonly maxQueuedItems: number;
  private readonly maxQueuedBytes: number;
  private socket?: DshMuxSocketLike;
  private socketOpen = false;
  private streamSeq = 0;
  private generationValue = 0;
  private started = false;
  /** True only once {@link DshMuxClient.stop} has been called. See {@link open}. */
  private stopped = false;
  private reconnectHandle?: unknown;
  /** Pending `open` frames, held only while the socket is not yet writable. */
  private readonly pending: Array<{ stream: DshMuxStream; frame: string; bytes: number }> = [];
  private pendingBytes = 0;
  private readonly streams = new Map<string, DshMuxStream>();
  private readonly observers = new Set<DshMuxObserver>();

  constructor(private readonly options: DshMuxOptions, private readonly handlers: DshMuxHandlers) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.headers = options.headers ?? (() => ({}));
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.reconnectDelayMs = options.reconnectDelayMs && options.reconnectDelayMs > 0
      ? options.reconnectDelayMs
      : DSH_MUX_RECONNECT_DELAY_MS;
    this.newStreamId = options.newStreamId ?? (() => `s${String(++this.streamSeq)}`);
    this.maxActiveStreams = positiveOr(options.maxActiveStreams, DSH_MUX_MAX_ACTIVE_STREAMS);
    this.maxQueuedItems = positiveOr(options.maxQueuedItems, DSH_MUX_MAX_QUEUED_ITEMS);
    this.maxQueuedBytes = positiveOr(options.maxQueuedBytes, DSH_MUX_MAX_QUEUED_BYTES);
  }

  get generation(): number {
    return this.generationValue;
  }

  /** The socket is writable. NOT a claim that the carrier has been verified. */
  get isOpen(): boolean {
    return this.socketOpen;
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Test seam: opens waiting for the socket to become writable.
   *
   * Pending opens are invisible to {@link activeStreamCount} — the slot is
   * counted from the registration, and a cancelled stream has already lost it —
   * so a carrier that never finishes its handshake can be made to hold an
   * unlimited number of serialized requests unless something can see them.
   */
  get pendingOpenCount(): number {
    return this.pending.length;
  }

  /**
   * Watch this carrier's generations. Returns the unsubscribe, because an
   * observer that leaves without deregistering is a leak with a socket attached.
   */
  addObserver(observer: DshMuxObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  private notifyOpen(generation: number): void {
    this.handlers.onOpen(generation);
    for (const observer of [...this.observers]) observer.onOpen?.(generation);
  }

  private notifyLost(generation: number, reason: string): void {
    this.handlers.onLost(generation, reason);
    for (const observer of [...this.observers]) observer.onLost?.(generation, reason);
  }

  private notifyDiagnostic(diagnostic: DshMuxDiagnostic): void {
    this.handlers.onDiagnostic?.(diagnostic);
    for (const observer of [...this.observers]) observer.onDiagnostic?.(diagnostic);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.openGeneration();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.reconnectHandle !== undefined) {
      this.clearTimeoutImpl(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.closeSocket();
    this.failAllStreams('carrier stopped');
    // The epoch ends WITH the stop. A `close` from the socket we just closed
    // arrives asynchronously and would otherwise land inside a later start()
    // and fail a generation that has not begun yet.
    this.generationValue += 1;
  }

  /**
   * Open one logical stream.
   *
   * The returned handle is valid before the frame has been written: a caller
   * that is attaching a session does not care whether the socket finished its
   * handshake, only that its items arrive in order once they do. Streams opened
   * against a dead carrier are refused rather than queued indefinitely, because
   * an unbounded open-queue across a restart is how a broker ends up replaying
   * yesterday's subscriptions onto today's host.
   */
  open(endpoint: string, payload: unknown): DshMuxStream {
    if (this.streams.size >= this.maxActiveStreams) {
      throw new Error(`dsh stream limit reached (${String(this.maxActiveStreams)} active streams)`);
    }
    // Asked first, because attaching a session is what the carrier EXISTS for:
    // a client that made the caller wait for someone else to call start() is a
    // client that drops the first attach of every broker run. What it must NOT
    // do is revive itself after a shutdown, which is the one state where opening
    // a socket on demand would be an effect nobody asked for.
    if (!this.stopped) this.start();
    const stream = new DshMuxStream(
      this.newStreamId(),
      endpoint,
      (target) => this.terminate(target),
      this.maxQueuedItems,
      this.maxQueuedBytes,
    );
    this.streams.set(stream.streamId, stream);
    const frame = JSON.stringify({
      type: 'open',
      streamId: stream.streamId,
      endpoint,
      payload,
    } satisfies DshMuxClientFrame);
    if (this.stopped) {
      stream.fail({ code: 'carrier/closed', message: 'the DeepSeek Harness stream carrier is not running', details: {} });
      this.streams.delete(stream.streamId);
      return stream;
    }
    if (this.socketOpen) {
      this.write(frame);
      return stream;
    }
    const bytes = Buffer.byteLength(frame, 'utf8');
    this.pending.push({ stream, frame, bytes });
    this.pendingBytes += bytes;
    return stream;
  }

  /**
   * End the generation and schedule a fresh one.
   *
   * Idempotent per generation, because the two paths that notice — a socket
   * `close` and the terminal error on a stream — both arrive and only the first
   * should burn a reconnect.
   */
  failGeneration(reason: string): void {
    if (this.stopped) return;
    const generation = this.generationValue;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.closeSocket();
    this.failAllStreams(reason);
    this.generationValue += 1;
    this.notifyLost(generation, reason);
    if (this.reconnectHandle !== undefined) this.clearTimeoutImpl(this.reconnectHandle);
    this.reconnectHandle = this.setTimeoutImpl(() => {
      this.reconnectHandle = undefined;
      if (!this.stopped) this.openGeneration();
    }, this.reconnectDelayMs);
  }

  private terminate(stream: DshMuxStream): void {
    const registered = this.streams.get(stream.streamId) === stream;
    if (registered) this.streams.delete(stream.streamId);
    // The open frame goes with the registration. A stream cancelled while the
    // socket was still connecting leaves its request in `pending`, where
    // flushPending() correctly refuses to write it but nothing else releases it:
    // the serialized frame and its stream stay reachable for the life of the
    // carrier, and since the active-stream count dropped, the ceiling can be
    // walked straight past by opening and cancelling during the handshake.
    this.dropPending(stream);
    // Cancel only for a stream this carrier still has, while the host is still
    // producing on it. Losing the registration is what release means, so a
    // second release (breaking out of the iterator and then calling `cancel()`
    // outright) would otherwise put a duplicate frame on the wire naming an id
    // the host already retired. Past `end` or `error` there is nothing to stop,
    // and a frame naming a retired id is the one thing the gateway answers by
    // closing the socket. Once the physical connection is gone the close itself
    // ended everything, which is why the open-socket test comes first.
    if (registered && this.socketOpen && !stream.endedByHost) {
      this.write(JSON.stringify({ type: 'cancel', streamId: stream.streamId } satisfies DshMuxClientFrame));
    }
    stream.releaseLocally();
  }

  /**
   * Forget a pending open for a stream that no longer exists.
   *
   * Returns whether an entry was removed, so a caller can tell a real queued
   * request from one that had already been written.
   */
  private dropPending(stream: DshMuxStream): boolean {
    for (let index = 0; index < this.pending.length; index += 1) {
      const entry = this.pending[index];
      if (!entry || entry.stream !== stream) continue;
      this.pending.splice(index, 1);
      this.pendingBytes = Math.max(0, this.pendingBytes - entry.bytes);
      return true;
    }
    return false;
  }

  private failAllStreams(reason: string): void {
    const failure: DshStreamFailure = { code: 'carrier/lost', message: reason, details: {} };
    for (const stream of [...this.streams.values()]) {
      this.streams.delete(stream.streamId);
      stream.fail(failure);
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.socketOpen = false;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  private openGeneration(): void {
    const generation = this.generationValue;
    let socket: DshMuxSocketLike;
    try {
      socket = this.socketFactory(`${this.baseUrl}${DSH_REMOTE_MUX_PATH}`.replace(/^http/, 'ws'), this.headers());
    } catch (error) {
      this.notifyDiagnostic({ code: 'socket-error', detail: error instanceof Error ? error.message : String(error) });
      this.failGeneration('stream carrier could not be opened');
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.generationValue) return;
      this.socketOpen = true;
      this.flushPending();
      this.notifyOpen(generation);
    });
    socket.addEventListener('message', (event) => {
      if (generation !== this.generationValue) return;
      this.onMessage((event as { data?: unknown } | undefined)?.data ?? event);
    });
    socket.addEventListener('close', () => {
      if (generation !== this.generationValue) return;
      this.failGeneration('stream carrier closed');
    });
    socket.addEventListener('error', () => {
      if (generation !== this.generationValue) return;
      this.notifyDiagnostic({ code: 'socket-error' });
    });
  }

  private flushPending(): void {
    const queued = this.pending.splice(0, this.pending.length);
    this.pendingBytes = 0;
    for (const entry of queued) {
      if (this.streams.get(entry.stream.streamId) !== entry.stream) continue;
      this.write(entry.frame);
    }
  }

  private write(frame: string): void {
    const socket = this.socket;
    if (!socket || !this.socketOpen) return;
    try {
      socket.send(frame);
    } catch (error) {
      // A send that throws is a dead carrier, not a rejected frame. There is no
      // way to know which frames landed, so nothing derived from this
      // generation can be trusted to be complete.
      this.notifyDiagnostic({ code: 'socket-error', detail: error instanceof Error ? error.message : String(error) });
      this.failGeneration('stream carrier write failed');
    }
  }

  private onMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : undefined;
    const bytes = text !== undefined ? Buffer.byteLength(text, 'utf8') : 0;
    // A frame this client cannot decode cannot be attributed to a stream, so the
    // only honest response is to end the generation and rebuild. Dropping it and
    // carrying on leaves a subscription that looks live and is quietly incomplete,
    // and a missing history page or approval frame is not something any caller
    // downstream can detect from the inside. The size bound stays: the generation
    // ends BECAUSE the bound was hit, not instead of it.
    if (text !== undefined && bytes > DSH_MUX_FRAME_MAX_BYTES) {
      this.notifyDiagnostic({ code: 'frame-too-large', detail: `${String(bytes)} bytes` });
      this.failGeneration('a carrier frame exceeded the size this client will parse');
      return;
    }
    let parsed: unknown;
    try {
      parsed = text === undefined ? raw : JSON.parse(text);
    } catch {
      this.notifyDiagnostic({ code: 'undecodable-frame', detail: 'not JSON' });
      this.failGeneration('the stream carrier sent something that was not a frame');
      return;
    }
    const frame = parseHostFrame(parsed);
    if (!frame) {
      this.notifyDiagnostic({ code: 'undecodable-frame', detail: 'not a Remote stream frame' });
      this.failGeneration('the stream carrier sent a frame outside its grammar');
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      // A frame for a stream this client already retired. Dropping it is the
      // host's own documented behaviour for the mirror case, and the socket
      // stays up.
      this.notifyDiagnostic({ code: 'unknown-stream', detail: frame.streamId });
      return;
    }
    if (frame.type === 'item') {
      if (!stream.deliver(frame.value, Math.max(bytes, 1))) {
        // The reader fell behind, so this client is giving the stream up. Ending
        // it locally would leave the host producing for a subscriber that has
        // gone: terminate() cancels on the wire and retires the slot.
        this.terminate(stream);
        this.notifyDiagnostic({ code: 'stream-overflow', detail: frame.streamId });
      }
      return;
    }
    this.streams.delete(frame.streamId);
    if (frame.type === 'end') stream.finishFromHost();
    else stream.failFromHost(frame.error);
  }
}

/** Validate the exact frame shapes the host's parser accepts, or return null. */
function parseHostFrame(value: unknown): DshMuxHostFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.streamId !== 'string' || record.streamId === '') return null;
  if (record.type === 'item') return { type: 'item', streamId: record.streamId, ...(Object.hasOwn(record, 'value') ? { value: record.value } : {}) };
  if (record.type === 'end') return { type: 'end', streamId: record.streamId };
  if (record.type === 'error') {
    const error = record.error as { code?: unknown; message?: unknown; details?: unknown } | undefined;
    if (!error || typeof error !== 'object') return null;
    return {
      type: 'error',
      streamId: record.streamId,
      error: {
        code: typeof error.code === 'string' ? error.code : 'unknown',
        message: typeof error.message === 'string' ? error.message : '',
        details: error.details,
      },
    };
  }
  return null;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value && value > 0 ? value : fallback;
}

function defaultSocketFactory(url: string, headers: Readonly<Record<string, string>>): DshMuxSocketLike {
  // Bun and Node both accept a header-bearing init here, and this carrier needs
  // one: the host gates the upgrade on the same cookie as every API request.
  return new WebSocket(url, Object.keys(headers).length > 0 ? { headers } as never : undefined) as unknown as DshMuxSocketLike;
}
