/**
 * The 0.2 event generation: one carrier, one `$events` stream, one verified
 * `clientId` that authorises answers.
 *
 * 0.1 proved a host with `host.describe` and then routed. 0.2 has no describe,
 * and what replaces it is not weaker in one specific way that matters: the
 * waterfall answer for an approval travels as `$events/result` carrying the
 * `clientId` of the event stream that ASKED. Handing an answer to a superseded
 * generation is not a dropped message, it is a decision attributed to a stream
 * the host has already thrown away, and the host's own answer to that is silence.
 * So readiness here is not "the socket opened" and not "HTTP said 200"; it is
 * this generation's `ready` frame, and nothing may be answered before it.
 *
 * A verified generation is also a thing that can DIE while the socket lives. The
 * host's event registration has its own lifetime, separate from the carrier: it
 * can end, or fail, while the WebSocket underneath is perfectly healthy. A client
 * that treats readiness as a one-way latch keeps offering answers on a
 * subscription that will never deliver again, which is worse than an obvious
 * outage because the UI still looks live. Both terminal stream frames therefore
 * end the generation and recover through the same coordinator that owns the
 * socket, and an old reader is never allowed to invalidate a newer generation.
 *
 * There is deliberately no buffer for frames that arrive before verification.
 * Under the captured grammar `ready` is the FIRST item of the very stream that
 * carries everything else, on a stream this client opens, so ordering already
 * does the work a hold-and-replay loop would do — and a frame that turns up
 * ahead of it means the grammar is not the one assumed, which is a reason to
 * stop rather than a reason to queue.
 */
import {
  parseDshEventFrame,
  type DshEventFrame,
  type DshEventOutcome,
  type DshEventWaterfallFrame,
} from './remote.ts';
import {
  DshMuxClient,
  DshStreamError,
  DSH_EVENT_STREAM_ENDPOINT,
  DSH_EVENT_STREAM_PAYLOAD,
  type DshMuxDiagnostic,
  type DshMuxSocketFactory,
  type DshMuxStream,
} from './mux.ts';

/** How the answer transport is reached. Kept as a function so the link needs no client. */
export interface DshAnswerReceipt {
  ok: boolean;
  /**
   * False once the host has definitely seen and declined the answer, true when
   * the request simply did not complete. The difference decides whether the
   * request is still open: a send that never arrived leaves a live approval
   * waiting for a decision, while a refusal means the host has finished with it
   * and re-sending would be a second decision on one request.
   */
  retryable?: boolean;
  detail?: string;
}

/** A generation whose `ready` frame has been read and validated. */
export interface DshEventGeneration {
  /** Carrier generation, from the mux client. */
  readonly carrier: number;
  /** The host's own id for THIS event stream. Answers must name it, exactly. */
  readonly clientId: string;
  /** Host account home from the ready frame. Metadata only: not a version, not a DSH_HOME, not ownership. */
  readonly hostHome: string;
}

/** How long a generation may stay open without producing its `ready` frame. */
export const DSH_EVENT_VERIFY_TIMEOUT_MS = 10_000;

/** Waterfalls this link will hold at once. Beyond it, requests are delegated. */
export const DSH_EVENT_MAX_PENDING = 64;

export interface DshEventLinkHandlers {
  /** Verification finished for `generation`. Nothing may be answered before this fires. */
  onVerified?(generation: DshEventGeneration): void;
  /** The generation ended. Every pending interaction from it is now unanswerable. */
  onLost?(carrier: number, reason: string): void;
  /** A forwarded host event, delivered only after verification. */
  onEvent?(event: string, args: readonly unknown[], generation: DshEventGeneration): void;
  /** A request the host is waiting on. Answer it with {@link DshEventLink.answer}. */
  onWaterfall?(frame: DshEventWaterfallFrame, generation: DshEventGeneration): void;
  /** The host withdrew a request. Any card still showing it is stale. */
  onCancellation?(eventId: string): void;
  onDiagnostic?(diagnostic: DshEventLinkDiagnostic): void;
}

export interface DshEventLinkDiagnostic {
  code: 'verify-timeout' | 'verify-frame-rejected'
    | 'generation-lost' | 'answer-refused' | 'pending-overflow' | 'mux-diagnostic';
  detail?: string;
}

export interface DshEventLinkOptions {
  /**
   * Per-attempt request headers, so a credential renewed between two carriers is
   * used by the next one. Named here rather than only on the mux because callers
   * reach the event stream through this class and must be able to authenticate it
   * without knowing which socket it ended up on.
   */
  headers?: () => Readonly<Record<string, string>>;
  baseUrl?: string;
  socketFactory?: DshMuxSocketFactory;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reconnectDelayMs?: number;
  verifyTimeoutMs?: number;
  /**
   * A carrier to share instead of constructing one. The link subscribes to its
   * lifecycle either way, so an injected carrier behaves exactly like a owned one
   * apart from who closes it.
   */
  mux?: DshMuxClient;
  answer(event: { clientId: string; eventId: string; outcome: DshEventOutcome }): Promise<DshAnswerReceipt>;
}

/**
 * The link.
 *
 * `start()` is lazy and `stop()` is final for the process's purposes: the mux
 * client refuses to revive itself after a stop, which is the only state where
 * opening a socket on demand would be an effect nobody asked for.
 */
export class DshEventLink {
  private readonly mux: DshMuxClient;
  private readonly ownsMux: boolean;
  private readonly verifyTimeoutMs: number;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly unsubscribe?: () => void;
  private readonly diagnostics: DshEventLinkDiagnostic[] = [];
  private generation?: DshEventGeneration;
  private readonly pending = new Map<string, DshEventWaterfallFrame>();
  /**
   * Answers already in flight, keyed by (clientId, eventId). Two entries in this
   * map at once for one key is the duplicate submission this exists to prevent:
   * two callers reaching an approval at the same moment must produce one request
   * to the host, not two, and the second caller has to be told the outcome of the
   * one that is actually running.
   */
  private readonly claims = new Map<string, Promise<DshAnswerReceipt>>();
  /** Events the host withdrew. Restoring one would resurrect a dead card. */
  private readonly cancelled = new Set<string>();
  private verifyHandle?: unknown;
  /**
   * The `$events` stream this link opened on the current carrier.
   *
   * Held rather than local to the reader, because the reader outlives every
   * single thing that could end it. Without the handle there is nothing to
   * cancel, and a reader parked on a stream nobody owns any more wakes on the
   * host's NEXT event and reads its own cleared state as a broken frame —
   * which it reports by failing the carrier, taking down the session streams
   * that share the socket with it.
   */
  private eventStream?: DshMuxStream;
  /** The carrier generation {@link eventStream} was opened on. See {@link start}. */
  private eventCarrier = -1;
  private started = false;
  private stopped = false;

  constructor(private readonly options: DshEventLinkOptions, private readonly handlers: DshEventLinkHandlers = {}) {
    this.verifyTimeoutMs = positiveOr(options.verifyTimeoutMs, DSH_EVENT_VERIFY_TIMEOUT_MS);
    // Resolved once, with platform defaults, so the verification deadline exists
    // whether or not a caller passed test timers. A deadline that only works when
    // someone injected a clock is a deadline the production path does not have.
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.ownsMux = options.mux === undefined;
    this.mux = options.mux ?? new DshMuxClient({
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:3080',
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
      // The same timer source the link verifies against, so one carrier's
      // backoff and one verification deadline are governed by one clock. A
      // carrier that reconnects on a different clock than the one a caller can
      // advance is a carrier that silently reconnects in real time instead.
      setTimeout: this.setTimeoutImpl,
      clearTimeout: this.clearTimeoutImpl,
    }, { onOpen() {}, onLost() {} });
    // One subscription path for both construction routes. Making an injected
    // carrier skip it would leave a caller holding a mux that opens its socket,
    // authenticates, and never has `$events` opened on it — a link that reports
    // itself unverified forever with no failure to point at.
    this.unsubscribe = this.mux.addObserver({
      onOpen: (carrier) => this.onCarrierOpen(carrier),
      onLost: (carrier, reason) => this.onCarrierLost(carrier, reason),
      onDiagnostic: (diagnostic: DshMuxDiagnostic) => this.note({ code: 'mux-diagnostic', detail: diagnostic.code }),
    });
  }

  get isVerified(): boolean {
    return this.generation !== undefined;
  }

  get currentGeneration(): DshEventGeneration | undefined {
    return this.generation;
  }

  get carrierGeneration(): number {
    return this.mux.generation;
  }

  /** Shared carrier, so session attaches ride THIS socket instead of starting a second reconnect loop. */
  get streams(): DshMuxClient {
    return this.mux;
  }

  recordedDiagnostics(): readonly DshEventLinkDiagnostic[] {
    return this.diagnostics;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.mux.start();
    // A carrier handed in already connected has had its ONE open notification
    // before this link existed to receive it, and the socket will not repeat it
    // for a generation that is already running. Asking the carrier where it
    // stands is the only way to see that, and the alternative is a link that
    // reports itself unverified forever with no timeout and nothing to report.
    if (this.mux.isOpen) this.onCarrierOpen(this.mux.generation);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.clearVerifyTimer();
    this.unsubscribe?.();
    // Cancelled, not abandoned. The reader is parked on this stream, and the
    // wake-up has to come from a stream that is ENDING rather than from the next
    // event the host happens to send: an event that arrives after the link has
    // stopped finds its own generation cleared and reads as a protocol breach,
    // and the breach is reported by failing the carrier every other session on
    // this socket is using. Cancelling also stops the host producing for a
    // viewer that has gone.
    const stream = this.eventStream;
    this.eventStream = undefined;
    this.eventCarrier = -1;
    if (stream) stream.cancel();
    this.generation = undefined;
    this.pending.clear();
    this.claims.clear();
    this.cancelled.clear();
    // Only close what this link opened. A carrier handed in belongs to whoever
    // gave it, and stopping a viewer must not disconnect the sessions riding it.
    if (this.ownsMux) this.mux.stop();
  }

  /**
   * Waterfalls seen on the CURRENT generation and not yet answered, including
   * one whose answer is still in flight.
   *
   * These do not survive a generation: the host's chain moved on, and a card
   * built on a dead `eventId` is an actionable lie. Callers are told through
   * {@link DshEventLinkHandlers.onLost} so they can retire the request rather
   * than re-present it.
   */
  pendingWaterfalls(): readonly DshEventWaterfallFrame[] {
    return [...this.pending.values()];
  }

  /**
   * Answer one request.
   *
   * The claim is taken synchronously, before the transport is reached, and the
   * generation identity is re-checked after it returns. Both halves matter.
   * Without the first, two callers answering one approval both see a pending
   * entry and both send. Without the second, a late receipt from an answer sent
   * against a dead generation can clear the entry that a RECONNECTED host just
   * re-delivered on the new client — the host genuinely re-sends pending events
   * to a new event client, so this is not a hypothetical id collision.
   */
  answer(eventId: string, outcome: DshEventOutcome): Promise<DshAnswerReceipt> {
    const generation = this.generation;
    if (!generation) {
      this.note({ code: 'answer-refused', detail: 'unverified' });
      return Promise.resolve({ ok: false, retryable: false, detail: 'the event generation is not verified' });
    }
    const key = `${generation.clientId}\u0000${eventId}`;
    const inFlight = this.claims.get(key);
    if (inFlight) return inFlight;
    const frame = this.pending.get(eventId);
    if (!frame) {
      this.note({ code: 'answer-refused', detail: `unknown event ${eventId}` });
      return Promise.resolve({ ok: false, retryable: false, detail: 'this generation did not ask' });
    }
    this.pending.delete(eventId);
    const attempt = this.sendAnswer(key, frame, generation, outcome);
    this.claims.set(key, attempt);
    return attempt;
  }

  private async sendAnswer(
    key: string,
    frame: DshEventWaterfallFrame,
    generation: DshEventGeneration,
    outcome: DshEventOutcome,
  ): Promise<DshAnswerReceipt> {
    let receipt: DshAnswerReceipt;
    try {
      receipt = await this.options.answer({
        clientId: generation.clientId,
        eventId: frame.eventId,
        outcome,
      });
    } catch (error) {
      receipt = { ok: false, retryable: true, detail: error instanceof Error ? error.message : String(error) };
    }
    this.claims.delete(key);
    // Identity, not a timestamp: the same eventId can legitimately be live again
    // on a new client, and only the generation that asked for THIS answer may
    // touch the tray it came from.
    if (this.generation?.clientId !== generation.clientId) return receipt;
    if (!receipt.ok && receipt.retryable !== true) return receipt;
    if (!receipt.ok && !this.cancelled.has(frame.eventId)) {
      // A send that did not complete leaves a real approval waiting. Putting the
      // request back is the truth; dropping it would strand a decision the host
      // has not stopped asking for.
      this.pending.set(frame.eventId, frame);
    }
    return receipt;
  }

  private onCarrierOpen(carrier: number): void {
    if (this.stopped) return;
    // One event stream per carrier. `start()` can adopt an open carrier and the
    // observer can still deliver that carrier's open afterwards, so this is the
    // place where a duplicate would be created rather than noticed.
    if (this.eventStream !== undefined && this.eventCarrier === carrier) return;
    this.clearVerifyTimer();
    const superseded = this.eventStream;
    this.eventStream = undefined;
    this.eventCarrier = -1;
    if (superseded) superseded.cancel();
    this.generation = undefined;
    this.pending.clear();
    this.claims.clear();
    this.cancelled.clear();
    const stream = this.mux.open(DSH_EVENT_STREAM_ENDPOINT, DSH_EVENT_STREAM_PAYLOAD);
    this.eventStream = stream;
    this.eventCarrier = carrier;
    this.verifyHandle = this.setTimeoutImpl(() => {
      this.verifyHandle = undefined;
      if (!this.generation) {
        this.note({ code: 'verify-timeout' });
        this.mux.failGeneration('the event stream never announced its generation');
      }
    }, this.verifyTimeoutMs);
    void this.readStream(stream, carrier);
  }

  /**
   * Read one event stream until it ends, fails, or its carrier goes away.
   *
   * Every exit is terminal for the generation. A logical `end` means the host's
   * event registration finished while the socket stayed up, which is the case a
   * readiness latch would miss: the application would keep offering answers to a
   * subscription that can never deliver again.
   */
  private async readStream(
    stream: { [Symbol.asyncIterator](): AsyncIterator<unknown> },
    carrier: number,
  ): Promise<void> {
    // The reader is fenced rather than merely observant. Both conditions end it
    // in silence: this link no longer wants events (stop), or the stream it is
    // reading is not the one it opened (a reconnect). In neither case does this
    // reader get a vote on the carrier, because by then it is not its carrier.
    const stillMine = (): boolean =>
      !this.stopped && this.eventStream === stream && carrier === this.mux.generation;
    try {
      for await (const value of stream) {
        if (!stillMine()) return;
        const frame = parseDshEventFrame(value);
        if (!frame) {
          // One unparseable item on the event stream means the grammar this client
          // knows is not the grammar in use, and the NEXT frame may be an approval
          // it reads wrongly. End the generation; do not guess.
          this.note({ code: 'verify-frame-rejected', detail: 'unrecognised event frame' });
          this.endGeneration(carrier, 'the event stream produced a frame outside its grammar');
          return;
        }
        if (!this.generation) {
          if (frame.type !== 'ready') {
            this.note({ code: 'verify-frame-rejected', detail: `first frame was ${frame.type}` });
            this.endGeneration(carrier, 'the event stream did not open with its ready frame');
            return;
          }
          this.generation = { carrier, clientId: frame.clientId, hostHome: frame.host.home };
          this.clearVerifyTimer();
          this.handlers.onVerified?.(this.generation);
          continue;
        }
        this.deliver(frame);
      }
      if (stillMine()) this.endGeneration(carrier, 'the event stream ended');
    } catch (error) {
      if (!stillMine()) return;
      this.endGeneration(
        carrier,
        error instanceof DshStreamError
          ? `the event stream failed: ${error.failure.code}`
          : 'reading the event stream threw',
      );
      if (!(error instanceof DshStreamError)) {
        this.note({ code: 'generation-lost', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** End the generation THIS reader belongs to, and only that one. */
  private endGeneration(carrier: number, reason: string): void {
    if (carrier !== this.mux.generation) return;
    this.mux.failGeneration(reason);
  }

  private deliver(frame: DshEventFrame): void {
    const generation = this.generation;
    if (!generation) return;
    switch (frame.type) {
      case 'ready':
        // A second ready on one stream is a new generation wearing the old
        // socket's clothes. Trust neither; reconnect.
        this.note({ code: 'verify-frame-rejected', detail: 'duplicate ready frame' });
        this.endGeneration(generation.carrier, 'the event stream re-announced itself');
        return;
      case 'emit':
        this.handlers.onEvent?.(frame.event, frame.args, generation);
        return;
      case 'waterfall': {
        if (this.pending.size >= DSH_EVENT_MAX_PENDING && !this.pending.has(frame.eventId)) {
          // The host is waiting on the FRONT of its chain. Delegating the
          // overflow with `next` lets its own chain answer rather than letting a
          // request sit unanswered behind a full local tray.
          this.note({ code: 'pending-overflow', detail: frame.eventId });
          void this.options.answer({
            clientId: generation.clientId,
            eventId: frame.eventId,
            outcome: { kind: 'next' },
          }).catch(() => ({ ok: false, retryable: true }));
          return;
        }
        this.pending.set(frame.eventId, frame);
        this.handlers.onWaterfall?.(frame, generation);
        return;
      }
      case 'cancel':
        this.pending.delete(frame.eventId);
        // Remembered, not just deleted: an answer already in flight for this
        // event may fail and try to put the request back on the tray.
        this.cancelled.add(frame.eventId);
        this.handlers.onCancellation?.(frame.eventId);
        return;
      default:
        return;
    }
  }

  private onCarrierLost(carrier: number, reason: string): void {
    if (carrier !== this.mux.generation - 1 && carrier !== this.mux.generation) return;
    this.clearVerifyTimer();
    this.generation = undefined;
    const dropped = [...this.pending.values()];
    this.pending.clear();
    this.claims.clear();
    this.cancelled.clear();
    if (dropped.length > 0) {
      this.note({ code: 'generation-lost', detail: `${String(dropped.length)} unanswered` });
    }
    this.handlers.onLost?.(carrier, reason);
  }

  private clearVerifyTimer(): void {
    if (this.verifyHandle !== undefined) this.clearTimeoutImpl(this.verifyHandle);
    this.verifyHandle = undefined;
  }

  private note(diagnostic: DshEventLinkDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > 100) this.diagnostics.shift();
    this.handlers.onDiagnostic?.(diagnostic);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value && value > 0 ? value : fallback;
}
