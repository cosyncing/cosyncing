/**
 * Read-only observe attach for one Kimi session.
 *
 * Shape of the attach, and why:
 *
 *  1. REST backfill first. `GET /api/v1/sessions/{id}/messages` re-folds the
 *     persisted journal from disk on every request, so it is the only surface
 *     that reflects turns driven outside this server (a terminal TUI).
 *  2. Then WebSocket `subscribe` + `subscribe_v2` with the `{seq, epoch}`
 *     cursor, answering the server's `ping` with `pong` (two silent cycles and
 *     the server reaps the connection).
 *  3. Because WS pushes nothing for TUI-driven turns — physically confirmed: an
 *     entire foreign turn produced zero frames — a bounded pull refresh runs
 *     while the session is open, so foreign turns still appear without the user
 *     doing anything. See {@link KIMI_OBSERVE_POLL_INTERVAL_MS}.
 *  4. Telemetry rides alongside, not inside, the transcript: the overlay read
 *     and the wire-journal read run on the same tick but outside the walk slot,
 *     because they answer "what does this session look like NOW" rather than
 *     "what did it say". The journal is the only place real token counts exist
 *     — the REST projections carry an empty usage object — so it is read from
 *     disk, bounded, read-only, and absent rather than faked when unavailable.
 *  5. Recovery: a lost socket resolves as a REST refresh now plus a reopen on
 *     the next tick. `resync_required` is stronger — the server is saying our
 *     cursor cannot be served incrementally — so recovery adopts the CURRENT
 *     watermark the frame carries (`current_seq`/`epoch`), runs a deeper
 *     bounded catch-up, states honestly (in-band notice) when even that could
 *     not bridge the gap, and only then resubscribes. Resubscribing from the
 *     adopted watermark is what makes the loop impossible: the old behavior
 *     resubscribed from seq 0, which a busy session answers with another
 *     `resync_required`, forever.
 *
 * Cursor discipline: the `{seq, epoch}` cursor belongs to ONE journal — this
 * session's. Kimi journals events per session and additionally fans global
 * events (`session_id: "__global__"`, and other sessions' `event.session.*`
 * family) to every connection with their OWN journal's seq/epoch. Only frames
 * whose `session_id` equals this session's id may move the cursor; adopting a
 * foreign watermark would silently skip or replay this session's events.
 *
 * Every mutating member of `SessionConnection` rejects. This connection cannot
 * write: {@link KimiReadOnlyHttp} exposes only GET, and the socket sends only
 * the frames in {@link KIMI_READ_ONLY_WS_FRAMES}.
 */
import type {
  AgentMessage,
  AgentMessageHandler,
  HistoryQuery,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { KimiReadOnlyHttp, isKimiReadOnlyWsFrame, type KimiReadOnlyWsFrame } from './server.ts';
import type { KimiDriveHttp } from './drive-http.ts';
import {
  KIMI_MAIN_AGENT_ID,
  mapKimiApprovalRequest,
  mapKimiApprovalResolved,
  mapKimiMessagePage,
  mapKimiQuestionRequest,
  mapKimiSessionStatus,
  mapKimiTurnFailure,
  mapKimiWorkChanged,
  type KimiMappedRow,
  type KimiMessagePage,
  type KimiQuestionRecord,
} from './mapping.ts';
import {
  KIMI_WIRE_TAIL_CAP_BYTES,
  KIMI_WIRE_TICK_CAP_BYTES,
  KimiWireTail,
  defaultKimiWireIo,
  locateKimiWireStreams,
  type KimiUsageRecord,
  type KimiWireIo,
} from './usage.ts';
import {
  KIMI_ACTIVE_GAP_CAP_MS,
  KIMI_ACTIVE_TIME_METHOD,
  activeTimeAccount,
} from './timing.ts';

/**
 * How often an open observe session re-reads REST history.
 *
 * Deliberately conservative. Each read force-loads the session into the server
 * and costs a full journal fold there, so this is a freshness floor for foreign
 * (terminal-driven) turns, not a streaming substitute. Bounding the cadence is
 * an open question in the design note; ten seconds is the reviewed starting
 * value and is the ONLY polling constant in this adapter.
 */
export const KIMI_OBSERVE_POLL_INTERVAL_MS = 10_000;

/** Messages per history page. Kimi caps `page_size` at 100. */
export const KIMI_HISTORY_PAGE_SIZE = 100;

/** Newest-page size used by the pull refresh; a refresh never re-reads the whole transcript. */
export const KIMI_REFRESH_PAGE_SIZE = 20;

/**
 * How far back one refresh may walk when the newest page shows no overlap with
 * what this connection already holds.
 *
 * One native message fans out into several canonical rows, so a busy foreign
 * turn can produce more than one page between ticks; without the walk, anything
 * older than the newest page would never be emitted. The walk stops at the first
 * page that overlaps, so the common case still costs exactly one request.
 *
 * RESIDUAL BOUND, stated honestly: a turn that produces more than
 * `KIMI_REFRESH_PAGE_SIZE * KIMI_REFRESH_MAX_PAGES` native messages inside one
 * poll interval can still leave a gap in the live tail. Reattaching re-reads
 * history through {@link KimiObserveConnection.getHistory}, whose own ceiling is
 * far higher, so the gap is a live-tail freshness limit and never a permanent
 * hole in the transcript.
 */
export const KIMI_REFRESH_MAX_PAGES = 3;

/** Backward paging ceiling for one attach, so an enormous session cannot become unbounded work. */
export const KIMI_HISTORY_MAX_PAGES = 10;

/**
 * Backward paging ceiling for the catch-up after a `resync_required`.
 *
 * Sized to the server's own scale: it declares a cursor unservable when the
 * session moved more than its ~1000-event replay buffer ahead, so the rebuild
 * walks up to the same order of messages (10 × 100) before conceding. Events
 * outnumber messages, and the walk stops at the first overlap anyway, so this
 * ceiling is a worst-case bound, not the common cost.
 */
export const KIMI_RESYNC_MAX_PAGES = 10;

/**
 * Catch-up passes ONE resync incident may spend.
 *
 * Each pass already covers every frame that arrived during the previous one, so
 * a stream that outruns three of them is not a gap to be bridged but a server
 * refusing to be caught up to. Without the ceiling every late frame buys another
 * full {@link KIMI_RESYNC_MAX_PAGES} walk of force-loading reads, so a session
 * that keeps producing frames keeps one incident running for as long as it stays
 * busy. Conceding after three passes and SAYING so is the honest end.
 */
export const KIMI_RESYNC_RECOVERY_PASS_MAX = 3;

/** No page could be read at all — the alternative reading, an empty session, would be a lie. */
export const KIMI_HISTORY_UNAVAILABLE_NOTICE =
  'Kimi history could not be read right now, so no earlier messages are shown. Reattach to try again.';

/** Some pages were read before the source stopped answering. */
export const KIMI_HISTORY_PARTIAL_NOTICE =
  'Kimi history is incomplete: reading older messages failed part way through, so earlier messages are missing.';

/** The session is longer than one bounded read; older messages exist above this point. */
export const KIMI_HISTORY_TRUNCATED_NOTICE =
  'Older Kimi messages are not shown: this session is longer than one bounded history read.';

/** The post-resync catch-up hit its ceiling without reconnecting to known rows. */
export const KIMI_RESYNC_GAP_NOTICE =
  'The Kimi live stream fell too far behind and the catch-up read could not bridge the whole gap: '
  + 'some messages above this point may be missing. Reattach to re-read full history.';

/**
 * Rows held while the connection waits for its first
 * {@link KimiObserveConnection.getHistory}, and how long it will wait.
 *
 * The broker subscribes BEFORE it reads history (`ManagedConn` subscribes at
 * attach; the history read follows), so without a priming boundary a socket or
 * tick could deliver rows that the history reset then repeats as duplicates.
 * Buffering until history seeds `seen` closes that window.
 *
 * The caps exist only for a caller that never reads history at all. On breach
 * the buffer FLUSHES rather than being discarded and the connection primes
 * itself: losing live rows outright is worse than the bounded duplicate risk
 * that priming was protecting against, and an unbounded buffer is worse than
 * both.
 */
export const KIMI_PRIMING_MAX_ROWS = 500;
export const KIMI_PRIMING_TIMEOUT_MS = 30_000;

/** Bound on remembered message identities, so a long-lived observe cannot grow without limit. */
const SEEN_IDENTITY_LIMIT = 4_000;

/**
 * Bytes one WebSocket frame may carry before this connection refuses to parse it.
 *
 * Every other input in this package is bounded AT THE READ — the HTTP bodies,
 * the instance records, the token file, the wire journal — and a socket frame is
 * the one that reaches `JSON.parse` from a process this adapter does not
 * control. So it gets a ceiling too.
 *
 * Why 4 MiB and not something tight: a frame is ONE event, and the largest
 * legitimate one is `event.approval.requested`, whose `tool_input_display` is an
 * `unknown` upstream (`protocol/approval.ts:18`) carrying the tool's whole input
 * — for a write or edit tool, an entire file body plus its diff. Dropping such a
 * frame would cost the user the approval card for a large edit, which is a worse
 * outcome than parsing it. 4 MiB clears any source file this tool edits by a
 * wide margin, sits an order of magnitude above every frame observed against
 * 0.35.0, and is half the shared HTTP body ceiling (`KIMI_HTTP_MAX_BODY_BYTES`,
 * 8 MiB) — which bounds a whole 100-message history page rather than a single
 * event, so letting one frame cost more than half of that would invert the two.
 *
 * WHAT IT BOUNDS, stated honestly: the parse and everything downstream of it,
 * not the transport. The HTTP reader can stop mid-body because it owns the
 * stream; a `message` event arrives only once the socket implementation has
 * already assembled the whole frame, so this is a ceiling on what this adapter
 * decodes and retains, not on what a server can make the socket buffer. Closing
 * that would take a frame limit on the WebSocket itself.
 */
export const KIMI_WS_FRAME_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Open interaction cards retained per connection.
 *
 * An interaction is a live prompt to the user, not transcript history: the
 * server holds at most a handful open at once (one approval and one question
 * group per running turn), so this is a leak bound rather than a working set.
 * Evicting the oldest costs a card that can no longer be answered from its
 * registry — which is why the answer path says so instead of guessing.
 */
export const KIMI_INTERACTION_REGISTRY_LIMIT = 64;

/**
 * WS event types that mark NEW DURABLE CONTENT and therefore justify a REST
 * refresh.
 *
 * Deliberately not the per-token deltas (`assistant.delta`, `thinking.delta`,
 * `tool.call.delta`): every refresh is a bounded but real REST read that
 * force-loads the session into the Kimi server, so one read per token is not a
 * freshness strategy, it is an attack on the server. These six each mark a
 * boundary at which the journal gained rows the transcript should show.
 *
 * `transcript.*` stays in the set even though this connection no longer
 * subscribes to that stream (see {@link KIMI_TRANSCRIPT_GRADE}): a server that
 * sends one anyway is still telling us something changed.
 */
const REFRESH_TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  'transcript.reset',
  'transcript.ops',
  'turn.step.completed',
  'turn.ended',
  'prompt.completed',
  'prompt.aborted',
]);

/**
 * The transcript grade this adapter subscribes at — `off`, deliberately.
 *
 * This is not a preference. The server SUPPRESSES every transcript-projected
 * `session_event` for a connection holding a non-`off` grade, on the theory
 * that such a client already receives the content through `transcript.ops`
 * (`sessionEventBroadcaster.ts:1439-1519`, `suppressedByTranscript`). That
 * projected set includes `turn.*`, `prompt.completed`, `prompt.aborted`, and
 * every `event.approval.*` / `event.question.*` frame — precisely the events
 * this adapter maps. K1 subscribed at `block` and therefore received NONE of
 * them; it did not notice because it projected none of them either.
 *
 * This adapter does not consume the transcript op stream at all (its op
 * vocabulary is a rendering model keyed by `t<ordinal>` turn/step/frame ids
 * with no native message ids in it — `packages/transcript/src/ops/operation.ts`),
 * so `block` bought nothing and cost the event stream. `off` suppresses
 * nothing: `gradeFor` returns `off` for an absent spec too, so this states
 * explicitly what an omitted frame would state implicitly.
 */
const KIMI_TRANSCRIPT_GRADE = 'off';

/**
 * Event timestamps retained PER STREAM for the active-time account.
 *
 * The figures need every timestamp in the window, so the window itself is what
 * has to be bounded. Evicting the oldest is the honest trade — the account then
 * covers less than the observed window and reports itself clipped, rather than
 * growing with a session that never ends.
 */
const ACTIVE_EVENT_LIMIT_PER_STREAM = 20_000;

/**
 * Passes the telemetry BASELINE may spend draining the tail window.
 *
 * One `read()` is bounded at {@link KIMI_WIRE_TICK_CAP_BYTES} per stream, so a
 * window as large as {@link KIMI_WIRE_TAIL_CAP_BYTES} needs that many passes to
 * come out whole; the margin covers the leading fragment each stream discards
 * and a little growth under the drain.
 *
 * Derived from the two caps rather than written down, because it is the same
 * fact stated twice: the drain is bounded BY THE TAIL CAP — the window the
 * reader is allowed to look at — and never by another process's write rate. A
 * journal that keeps growing while the drain runs stops it here, and whatever
 * landed after that is genuinely live and belongs in the transcript as rows.
 */
const TELEMETRY_DRAIN_MAX_PASSES =
  Math.ceil(KIMI_WIRE_TAIL_CAP_BYTES / KIMI_WIRE_TICK_CAP_BYTES) + 2;

export interface KimiSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export type KimiSocketFactory = (url: string, token: string | undefined) => KimiSocketLike;

/**
 * One GENERATION of verified proof: the client, the socket url, and the token
 * that were resolved together and therefore authenticate as one identity.
 *
 * Identity is verified once, at attach, and a connection outlives that proof: a
 * Kimi restart, a port another process now owns, or a rotated token all leave
 * the pinned trio describing a server that is gone. So the trio travels as a
 * unit that can be REPLACED, and never as three fields pinned for the life of
 * the connection. See {@link KimiObserveConnection.ensureTransport}.
 */
export interface KimiObserveTransport {
  http: KimiReadOnlyHttp;
  wsUrl: string;
  token?: string;
  /**
   * The write door of THIS generation, present only for a live attach.
   *
   * It travels inside the generation rather than beside it for the same reason
   * the client and the token do: a write client built from an older base URL or
   * an older token would authenticate as a different identity than the reads,
   * and a write is the one operation where landing on the wrong server is not
   * recoverable. Absent means this generation cannot write at all, which is the
   * correct and only state for an observe connection.
   */
  driveHttp?: KimiDriveHttp;
}

export interface KimiObserveOptions {
  pollIntervalMs?: number;
  socketFactory?: KimiSocketFactory;
  /**
   * The FIRST generation's write door. Passed here rather than as a positional
   * constructor argument so an observe construction cannot acquire one by
   * accident, and so the whole generation is still replaced as one unit by
   * {@link KimiObserveOptions.reverify}.
   */
  driveHttp?: KimiDriveHttp;
  /**
   * Re-resolve the Kimi instance and hand back a fresh generation; `undefined`
   * means there is no verified instance right now.
   *
   * Absent means FIXED transport: the connection keeps the generation it was
   * constructed with for its whole life, which is what a direct construction
   * asks for and what makes its read failures visible rather than silent.
   */
  reverify?: () => Promise<KimiObserveTransport | undefined>;
  /** Injected timers keep deterministic tests free of real waiting. */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Injected clock, so the priming-timeout arm is testable without real waiting. */
  now?: () => number;
  /**
   * `<KIMI_CODE_HOME>/sessions`. Absent means no telemetry at all: this
   * connection then emits no usage and no timing, which is the correct answer
   * when there is no journal to read rather than a reason to invent zeroes.
   */
  wireRoot?: string;
  /** Injected filesystem for the journal reader; production uses the real one. */
  wireIo?: KimiWireIo;
}

interface KimiCursor {
  seq: number;
  epoch?: string;
}

/**
 * What both interaction endpoints said, read against ONE transport generation.
 *
 * A VALUE, not an effect: producing it registers no question record, emits no
 * card, and touches no open-set bookkeeping. That is what lets a caller decide
 * whether the reading may be believed before any of it is applied — and what
 * makes "nothing is pending" a claim strong enough to retract a card with. See
 * {@link KimiObserveConnection.readPendingSnapshot}.
 */
export interface KimiPendingSnapshot {
  approvals: Array<Extract<AgentMessage, { type: 'permission-request' }>>;
  questions: Array<{
    message: Extract<AgentMessage, { type: 'question-request' }>;
    record: KimiQuestionRecord;
  }>;
}

/**
 * Identity for a message with no native identity attached.
 *
 * Rows produced by {@link mapKimiMessagePage} carry their own
 * {@link KimiMappedRow.identity}, derived from the native (message id, part
 * index), and that is ALWAYS preferred: it distinguishes two native rows whose
 * rendered content is byte-identical, which the content hash below cannot. This
 * exists for locally synthesized rows (the history notices) that have no native
 * part behind them at all.
 */
export function kimiMessageIdentity(message: AgentMessage): string {
  const keyed = message as { key?: unknown; callId?: unknown };
  if (typeof keyed.key === 'string' && keyed.key) return `${message.type}:${keyed.key}`;
  if (typeof keyed.callId === 'string' && keyed.callId) return `${message.type}:${keyed.callId}`;
  return `${message.type}:${JSON.stringify(message)}`;
}

/**
 * Identity of one overlay REVISION. See
 * {@link KimiObserveConnection.overlayRevisions} for what a revision is and why
 * the reading itself is not in here.
 */
function kimiOverlayIdentity(key: string, revision: number): string {
  return `metadata:${key}:${revision}`;
}

export class KimiObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly seen = new Set<string>();
  private readonly pollIntervalMs: number;
  private readonly socketFactory?: KimiSocketFactory;
  private readonly setIntervalImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private socket?: KimiSocketLike;
  /**
   * Is the socket above OPEN, as opposed to merely constructed?
   *
   * A separate boolean because the two are not the same fact and the gap
   * between them is where the damage lives: `openSocket` assigns `this.socket`
   * synchronously and the `open` event arrives an entire handshake later (or
   * never, against a server that accepts the TCP connection and then says
   * nothing). Everything that asks "is the live stream up" — the live-attach
   * gate, the write gate, and the divergence detector's silence claim — must
   * read THIS, because a socket that has not opened has delivered nothing and
   * will explain nothing.
   */
  private socketOpen = false;
  private pollHandle?: unknown;
  /** The generation every read and every socket uses. Replaced whole; see ensureTransport. */
  protected transport: KimiObserveTransport;
  private readonly reverify?: () => Promise<KimiObserveTransport | undefined>;
  /** Set when the server refused this generation's proof; cleared only by a successful re-resolution. */
  protected transportInvalid = false;
  /** The single in-flight re-resolution, so a burst of waiters costs one identity gate. */
  private reverifying?: Promise<boolean>;
  /** True once a socket was actually opened, which is what makes the NEXT one a replacement. */
  private socketEverOpened = false;
  /** Cleared by the first getHistory; until then, emissions are buffered (see KIMI_PRIMING_MAX_ROWS). */
  protected primed = false;
  private priming: Array<{ message: AgentMessage; identity: string }> = [];
  private primingIdentities = new Set<string>();
  private primingStartedAt?: number;
  private readonly nowImpl: () => number;
  /**
   * Undefined means "no position this connection can defend". Subscribing then
   * carries NO cursor entry, which asks the server for no replay at all and
   * gets its current watermark back in the ack. Inventing a number here is the
   * one thing that must never happen: seq 0 on a busy session is the precise
   * replay the server already refused.
   */
  private cursor: KimiCursor | undefined = { seq: 0 };
  protected closed = false;
  protected refreshing = false;
  /** Resolves when the walk currently holding the slot finishes; see runExclusiveWalk. */
  protected activeWalk?: Promise<void>;
  /** One resync recovery at a time; frames arriving during it fold into it. See resyncRecover. */
  private recoveryActive = false;
  private recoveryPending = false;

  // ── Interactions (approvals + questions) ──────────────────────────────────
  //
  // Kept SEPARATE from `seen`, which is the transcript dedupe set. An approval
  // is not a transcript row: the same requestId legitimately appears as a
  // request and later as a resolution, and a `getPending` replay after a
  // reattach is idempotent BY DESIGN (the client dedupes on requestId). Folding
  // them into the row identity set would make the replay a no-op and lose the
  // card a rejoining client came for.

  /** Native item/option ids per open question, so an answer of LABELS can be translated back. */
  protected readonly questionRecords = new Map<string, KimiQuestionRecord>();
  /**
   * Requests THIS connection resolved. A resolution arriving for anything else
   * was settled by another client of the shared owner, which the protocol calls
   * `'external'` — reporting it as a decision we did not make would attribute
   * a terminal user's choice to the app user.
   */
  protected readonly selfResolvedRequests = new Set<string>();
  /**
   * Interaction cards this connection has PUT IN FRONT OF THE USER and not yet
   * seen settled, by kind.
   *
   * It exists for one question a pending READ cannot answer on its own: an
   * approval that is absent from the snapshot may be absent because it was never
   * shown, or because it was shown and then resolved by somebody else while this
   * connection's stream was down. Only the shower of the card knows which, so the
   * ids are remembered here and the reconciliation retracts what it can prove is
   * gone (see the drive layer's `reconcileInteractions`).
   *
   * SHOWN means all three delivery paths, not just the socket: a request frame,
   * a reconciliation snapshot, and the attach-time replay in {@link getPending}.
   * The replay is the most common one of the three — a session already blocked
   * when a client joins delivers no request frame at all — so leaving it out
   * made the retraction unreachable for exactly the cards that needed it most.
   *
   * Bounded at {@link KIMI_INTERACTION_REGISTRY_LIMIT}, the same population and
   * the same ceiling as {@link questionRecords}: the server holds at most a
   * handful of cards open per running turn, so this is a leak bound and not a
   * working set. Oldest-first eviction costs an id its RETRACTION — the card then
   * survives until a real resolution frame arrives — which is the same degraded
   * outcome the registry's own eviction already accepts, and strictly better than
   * a map that grows with a session that never ends.
   */
  protected readonly openInteractions = new Map<string, 'approval' | 'question'>();

  /**
   * Monotonic mark of stream CONTINUITY.
   *
   * Bumped whenever the live view could have missed something: a socket opened
   * or died, a transport generation was replaced, or the server declared our
   * cursor unservable. The divergence detector compares this across a poll
   * interval — an unchanged mark is the only thing that makes "the stream was
   * healthy the whole time, so silence means silence" a defensible claim.
   */
  private streamMarkValue = 0;
  /** Proof of server-side liveness: bumped by every owned-session event frame. */
  private liveActivityValue = 0;
  /** Ordinal of run-state emissions, so a repeated value still carries a fresh identity. */
  private statusEmissions = 0;

  // ── Telemetry (the wire-journal sidecar) ──────────────────────────────────
  private readonly wireRoot?: string;
  private readonly wireIo: KimiWireIo;
  private wireTail?: KimiWireTail;
  /** Set once discovery finds nothing, or fails: this connection then emits no telemetry. */
  private telemetryDisabled = false;
  /** The FIRST read of each journal is a meter reading, not a transcript event. See updateTelemetry. */
  private telemetryBaselined = false;
  /** Re-entrancy guard: prime() runs an update, and an update emits through prime()'s own gate. */
  private telemetryRunning = false;
  /** True once anything (tail cap, rotation, a ceiling, an eviction) put part of the session out of view. */
  private telemetryClipped = false;
  private readonly wireTimestamps = new Map<string, number[]>();
  /** Per-stream ordinal of every emitted reading, so two readings in one millisecond stay distinct. */
  private readonly wireOrdinals = new Map<string, number>();
  private usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    records: 0,
  };

  /**
   * One entry per metadata key (`contextUsage`, `sessionInfo`, `sessionUsage`,
   * `activeTime`): the reading last delivered under it, and its revision.
   *
   * INVARIANT: one revision per DISTINCT CONSECUTIVE value. A → B → A is three
   * revisions and three deliveries; A → A is one. The revision only ever rises,
   * so an identity is never reused for a different reading.
   *
   * An overlay is not a transcript row — the same key is re-read every tick and
   * usually says exactly what it said before, so the identity has to dedupe the
   * repeat while letting a change through. Hashing the VALUE into the identity
   * does the first and fails the second: a reading that returns to a BYTE-EQUAL
   * earlier value (contextUsage 100k → 60k → 100k, which is what a compaction
   * plus a refilling window looks like) hashes to an identity the seen-set
   * already holds, so the client keeps the stale figure with no way to learn
   * otherwise. Comparing against the LAST value instead, and carrying a
   * never-seen revision when it differs, makes suppression impossible for a
   * changed reading while an unchanged one never reaches {@link emit} at all —
   * so priming and buffering still work exactly as they do for rows.
   */
  private readonly overlayRevisions = new Map<string, { lastJson: string; revision: number }>();

  constructor(
    readonly info: SessionInfo,
    http: KimiReadOnlyHttp,
    wsUrl: string,
    token: string | undefined,
    options: KimiObserveOptions = {},
  ) {
    // The construction arguments are the FIRST generation, not permanent state:
    // whoever built this connection verified them moments ago, and a later
    // generation replaces all three together.
    this.transport = {
      http,
      wsUrl,
      ...(token !== undefined ? { token } : {}),
      ...(options.driveHttp ? { driveHttp: options.driveHttp } : {}),
    };
    this.pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : KIMI_OBSERVE_POLL_INTERVAL_MS;
    if (options.socketFactory) this.socketFactory = options.socketFactory;
    if (options.reverify) this.reverify = options.reverify;
    this.setIntervalImpl = options.setInterval
      ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalImpl = options.clearInterval ?? ((handle) => clearInterval(handle as never));
    this.nowImpl = options.now ?? (() => Date.now());
    if (options.wireRoot) this.wireRoot = options.wireRoot;
    this.wireIo = options.wireIo ?? defaultKimiWireIo;
  }

  // ── Transport generations ─────────────────────────────────────────────────

  /**
   * Guarantee a CURRENT generation before anything spends this connection's
   * proof, and answer whether one exists.
   *
   * One re-resolution serves every waiter: the socket that just died, the tick
   * behind it, and each read they trigger all noticed the same dead generation,
   * so they share the single in-flight call rather than running the identity
   * gate once apiece. A failed one leaves the generation DOWN — no read retries
   * with a proof the server has already refused — and the next caller is the one
   * that tries again.
   */
  protected ensureTransport(): Promise<boolean> {
    if (!this.transportInvalid) return Promise.resolve(true);
    const reverify = this.reverify;
    // Nothing to re-resolve with: a fixed-transport connection cannot obtain a
    // second generation, so it says so rather than waiting for one.
    if (!reverify) return Promise.resolve(false);
    this.reverifying ??= (async () => {
      try {
        const next = await reverify();
        if (!next) return false;
        this.transport = next;
        this.transportInvalid = false;
        // A replaced generation is a discontinuity: the reads that follow may
        // be answered by a different server process than the ones before it.
        this.noteStreamBreak();
        // ...and the socket is HALF of the generation that was just replaced,
        // so it is retired with it. See {@link retireSocket}.
        this.retireSocket();
        return true;
      } catch {
        return false;
      } finally {
        this.reverifying = undefined;
      }
    })();
    return this.reverifying;
  }

  /**
   * Retire the socket the REPLACED generation owned, and open one against the
   * generation that replaced it.
   *
   * A generation is HTTP + socket + token TOGETHER — resolved as one identity,
   * authenticating as one identity — so no half of it may outlive the other.
   * Leaving the socket attached is what let a content write pass the stream gate
   * on the OLD socket, resolve the NEW generation's write client, and land the
   * write on a server whose approvals, whose completion events, and whose
   * foreign-writer evidence were all still being watched somewhere else.
   *
   * `this.socket` is cleared BEFORE the close, so every listener still attached
   * to the retired socket is neutralized by its identity guard (see
   * {@link openSocket}) instead of firing against the replacement.
   *
   * The reopen is IMMEDIATE, and that is LOAD-BEARING rather than eager: the
   * content-write door re-gates through the drive layer's
   * `assertContentWritable`, whose {@link restoreSocket} call early-returns once
   * a socket exists. With no socket here, that call would instead set
   * `transportInvalid` and run a SECOND re-resolution — replacing the very
   * generation the door had just snapshotted — so the write's generation
   * snapshot could never stabilize and the write would refuse itself.
   */
  private retireSocket(): void {
    const retired = this.socket;
    if (!retired) return;
    this.socket = undefined;
    this.socketOpen = false;
    try {
      retired.close();
    } catch {
      /* already gone; the listeners are neutralized either way */
    }
    if (this.closed) return;
    this.openSocket();
  }

  /**
   * An unauthorized answer is the generation saying it is over: the proof this
   * connection holds is no longer accepted, so every later read through it would
   * re-send the credential the server just refused.
   *
   * Gated on the reverifier. A fixed-transport connection has no second
   * generation to reach for, so invalidating its only one would turn visible
   * read errors into silence; it keeps reading, and keeps reporting.
   */
  protected noteUnauthorized(reason: string): void {
    if (reason !== 'unauthorized' || !this.reverify) return;
    this.transportInvalid = true;
  }

  // ── Continuity, liveness, and the subclass hooks ──────────────────────────

  /** See {@link streamMarkValue}. Read by the divergence detector across an interval. */
  protected get streamMark(): number {
    return this.streamMarkValue;
  }

  /**
   * Is the live stream up RIGHT NOW? A poll taken with no stream is not evidence
   * of silence.
   *
   * OPEN, not merely assigned. A socket object that exists but has never fired
   * `open` has carried no frame in either direction, so an interval spanning it
   * cannot be called silent — the server had no channel to speak on. Reading
   * the assignment instead is what let the divergence detector treat that
   * window as a healthy interval, and what let a live attach believe it had a
   * stream in zero milliseconds.
   */
  protected get socketLive(): boolean {
    return this.socketOpen;
  }

  /**
   * How many owned-session event frames this connection has received.
   *
   * The divergence detector's REST-leads-WS guard. Kimi's WS carries no native
   * message ids at all (its transcript ops are keyed by `t<ordinal>` turn/step
   * ids), so "did the WS deliver this row" is unanswerable — but "did the
   * server report ANY activity for this session while that row appeared" is
   * answerable, and it is the same question: a turn the server ran emits
   * frames, a turn appended by a foreign process emits none.
   */
  protected get liveActivity(): number {
    return this.liveActivityValue;
  }

  /** One discontinuity. Bumping the mark is what makes a later "nothing happened" trustworthy. */
  protected noteStreamBreak(): void {
    this.streamMarkValue += 1;
  }

  /**
   * The connection re-entered a coherent state after a discontinuity.
   *
   * Base does nothing: an observe connection has no in-flight state to repair.
   * The drive connection overrides it to reconcile its completion fences, whose
   * terminal events a server restart or a resync gap can destroy.
   */
  protected onStreamRestored(): void {}

  /**
   * Rows a bounded walk gathered, before they reach {@link emit}.
   *
   * Base does nothing. The drive connection overrides it to feed the divergence
   * detector, which must see rows the emission dedupe would swallow — a foreign
   * user prompt that arrived once already is still evidence.
   */
  protected onWalkedRows(_rows: KimiMappedRow[]): void {}

  /** Rows the authoritative history read delivered. Base does nothing; drive baselines from them. */
  protected onHistoryRows(_rows: KimiMappedRow[]): void {}

  /**
   * Last chance to add adapter-side knowledge to a mapped row before delivery.
   *
   * The mapper reads the native payload and nothing else, which is what keeps
   * it total and testable in isolation — but a user-message echo's correlation
   * token is knowledge the CONNECTION holds (it sent that prompt and got the
   * message id back), never something the native row carries. Base returns the
   * row untouched.
   */
  protected decorateRow(row: KimiMappedRow): AgentMessage {
    return row.message;
  }

  /**
   * Wait for any walk in flight, then run one more, so a caller can order an
   * emission AFTER the content that belongs before it.
   *
   * A plain {@link refresh} would coalesce away on a busy slot and return
   * before the rows it was waiting for existed — which is exactly the case that
   * matters, because the walk holding the slot is usually the one carrying the
   * turn's final rows.
   */
  protected async settleContent(): Promise<void> {
    while (this.refreshing) await this.activeWalk;
    if (this.closed) return;
    await this.refresh();
  }

  /**
   * Is this connection currently the session's writer?
   *
   * Drives the read-only flag on interaction cards and the force-load rule for
   * {@link getPending}. Base is always false — an observe connection cannot
   * answer anything, and saying otherwise would render controls the broker's
   * authority gate then refuses.
   */
  protected get driving(): boolean {
    return false;
  }

  /**
   * Bounded backward read of the native transcript.
   *
   * NOTE: this read FORCE-LOADS the session into the Kimi server
   * (`loadMessageHistory` resumes it), which makes the server a second live
   * owner alongside any terminal holding the same session. That is the accepted
   * cost of observe under the design note's reviewed-read-only decision: reads
   * alone caused no damage in the coexistence spike, and pull-fresh reads are
   * the only way foreign turns become visible at all. It is also exactly why
   * nothing here may ever write.
   */
  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    // History is a read like any other: a refused generation is re-resolved
    // first, and a read that cannot obtain one reports itself unavailable rather
    // than paging with a credential the server has already rejected.
    if (this.transportInvalid && !(await this.ensureTransport())) {
      return [{ type: 'notice', message: KIMI_HISTORY_UNAVAILABLE_NOTICE }];
    }
    const pages: KimiMappedRow[][] = [];
    let beforeId: string | undefined;
    let readFailed = false;
    let reachedCeiling = false;
    let pagesRead = 0;
    for (let page = 0; page < KIMI_HISTORY_MAX_PAGES; page += 1) {
      // A close mid-read stops the paging where it stands: every remaining page
      // is an active REST read that force-loads the session into the Kimi
      // server. The check runs on BOTH sides of the request — before it, so a
      // closed connection spends no read at all, and after it, because a page
      // that lands once the connection is dead was read for nobody and must
      // not be credited as history this read delivered. Either way close is an
      // ABORTED read and presents as one below, never as a genuinely short
      // session.
      if (this.closed) {
        readFailed = true;
        break;
      }
      const result = await this.transport.http.getJson<KimiMessagePage>(
        `/api/v1/sessions/${encodeURIComponent(this.info.id)}/messages`,
        { page_size: KIMI_HISTORY_PAGE_SIZE, ...(beforeId ? { before_id: beforeId } : {}) },
      );
      if (this.closed) {
        readFailed = true;
        break;
      }
      if (!result.ok) {
        this.noteUnauthorized(result.reason);
        readFailed = true;
        break;
      }
      pagesRead += 1;
      const mapped = mapKimiMessagePage(result.data);
      pages.unshift(mapped.rows);
      if (!mapped.hasMore || !mapped.oldestId || mapped.oldestId === beforeId) break;
      beforeId = mapped.oldestId;
      // Older history exists but this read will not reach it.
      if (page === KIMI_HISTORY_MAX_PAGES - 1) reachedCeiling = true;
    }

    const rows = pages.flat();
    // Seed dedupe from what history actually delivered, so the live tail never
    // repeats a row the reset already carried. A closed connection has no live
    // tail left, so neither the seeding nor the priming below applies to it.
    if (!this.closed) {
      for (const row of rows) this.remember(row.identity);
      // The authoritative read is also the divergence detector's BASELINE:
      // everything in it existed before this connection could have watched for
      // a foreign writer, so none of it may become a suspect.
      this.onHistoryRows(rows);
    }
    const messages = rows.map((row) => this.decorateRow(row));

    // An incomplete read must SAY so. The broker turns this array into an
    // authoritative history reset, so a silent short answer is indistinguishable
    // from a genuinely short session and would quietly clear retained client
    // history. `notice` is the canonical in-band way to state a transcript fact
    // (the Claude and Codex adapters use it the same way); there is no adapter
    // -> broker gap channel on this path, and throwing is no better because
    // `readNativeHistory` maps a rejected read to an empty array.
    // History has now seeded `seen`, so anything the socket or a tick emitted
    // during the attach window can be released without duplicating this reset.
    // A dead connection must not flip priming state: there is nobody left to
    // release the buffer to, and the flag outlives the close.
    if (!this.closed) this.prime();

    if (readFailed && pagesRead === 0) {
      return [{ type: 'notice', message: KIMI_HISTORY_UNAVAILABLE_NOTICE }];
    }
    if (readFailed) {
      return [{ type: 'notice', message: KIMI_HISTORY_PARTIAL_NOTICE }, ...messages];
    }
    if (reachedCeiling) {
      return [{ type: 'notice', message: KIMI_HISTORY_TRUNCATED_NOTICE }, ...messages];
    }
    return messages;
  }

  /**
   * Current-state overlays (context window, model, modes) that are not
   * transcript rows.
   *
   * The caller delivers what this returns DIRECTLY, so the readings are
   * remembered here: the next tick re-reads the same `/status` and must dedupe
   * an unchanged reading against what the attach already carried, rather than
   * repeating it.
   */
  async getHistoryOverlays(_query?: HistoryQuery): Promise<AgentMessage[]> {
    const overlays = await this.readOverlays();
    if (!this.closed) {
      for (const overlay of overlays) {
        if (overlay.type === 'metadata-update') this.seedOverlay(overlay);
      }
    }
    return overlays;
  }

  /**
   * The interaction cards that are open RIGHT NOW, replayed after history so a
   * client joining a blocked session sees the box rather than only the badge.
   *
   * FORCE-LOAD RULE: these two reads resume the session inside the Kimi server,
   * exactly like a history read, so an observe connection arms them only when
   * the roster already says the session is blocked. Arming them on every
   * foreign attach would make merely LOOKING at a terminal-owned session load
   * it into a second owner — the precise coexistence cost K1 was built to
   * avoid. A driving connection is that owner already, so it always reads.
   *
   * `readOnly` follows the posture, not the session: the same pending approval
   * is an actionable card for the writer and a non-actionable notice for an
   * observer, because the broker's authority gate would refuse the observer's
   * answer anyway. The posture that counts is the one at APPLY time — the reads
   * are awaited, and a demotion can land inside them — so the cards are
   * hardened once more below against the current one.
   *
   * A card returned from HERE is TRACKED on the driving posture, and that is not
   * bookkeeping — it is what makes the card retractable. Attach-time replay is
   * the ordinary way a card reaches a client (a session already blocked when the
   * client joins never delivers a request frame at all), and an id the drive
   * layer's reconciliation cannot find in
   * {@link openInteractions} is an id it can never prove settled: the two-point
   * rule needs membership BEFORE the reads, so a card that was never tracked
   * stays on screen forever once somebody else answers it. Not tracked on the
   * observe posture: an observe connection runs no reconciliation, so the entry
   * would have no reader.
   *
   * A card that settled WHILE the reads were out is dropped rather than
   * returned; see {@link settledDuringRead}. The residue is one pass wide: a
   * card that was never tracked and settles during this read has no
   * before-membership to compare and is returned anyway — but it is tracked on
   * the way out, so the first reconciliation retracts it. That self-healing is
   * exactly what the tracking above buys.
   */
  async getPending(): Promise<AgentMessage[]> {
    if (this.closed) return [];
    // THE FORCE-LOAD RULE lives here rather than inside the snapshot, because it
    // is about ARMING these reads for an observe posture and not about their
    // atomicity. The drive layer's reconciliation reads unconditionally: a
    // driving connection is that second owner already.
    //
    // NOT subject to the zero-subscriber guard the background reads take (see
    // {@link hasSubscribers}): this is the broker EXPLICITLY asking for the open
    // cards on behalf of a client that is attaching, not work a tick started for
    // nobody.
    if (!this.driving && this.info.status !== 'needs-input') return [];
    // Captured BEFORE the first read, so the window it opens spans the RETRY as
    // well: a resolution that lands anywhere between here and the apply below is
    // one this call must not undo. See {@link settledDuringRead}.
    const openAtStart = new Map(this.openInteractions);
    // ONE retry, then an honest empty answer. A snapshot answers `undefined` for
    // a refused read, a partial read, or a generation replaced under it — all
    // three mean "this connection does not know what is open" — and the broker's
    // replay is a one-shot call with no later trigger of its own, so it is worth
    // one more attempt against whatever generation is current now.
    const snapshot = (await this.readPendingSnapshot()) ?? (await this.readPendingSnapshot());
    if (!snapshot || this.closed) return [];
    // Applied only from a VALID snapshot, and only AFTER it validated.
    // Registering as the read mapped is what let a half-read — approvals ok,
    // questions refused — leave the registry holding records from a reading
    // nobody accepted.
    //
    // Built card by card rather than wholesale, because two of the three things
    // that happen per card — the skip and the tracking — are per-card decisions.
    // The ORDER is unchanged: approvals first, then questions, which is the
    // order a client renders them in.
    const approvals: AgentMessage[] = [];
    const questions: AgentMessage[] = [];
    // THE POSTURE AT APPLY TIME, not the one the reads were mapped against. The
    // snapshot stamped `readOnly` from the posture this call ENTERED with, and
    // the drive layer can prove a foreign writer and demote IN PLACE while the
    // reads are out — so cards captured while driving would otherwise reach an
    // attaching client rendering as actionable on a connection that now refuses
    // every answer before it reaches the wire.
    //
    // HARDENING ONLY, in one direction: it may ADD `readOnly`, never remove it.
    // The question mapper already marks an UNANSWERABLE card read-only for a
    // driving connection, so recomputing the field from posture would strip
    // that. Posture is monotone the other way as well — `driving` only ever
    // flips false, there is no in-place promotion — so captured-driving,
    // applied-demoted is the only stale combination there is.
    const demotedSinceRead = !this.driving;
    for (const card of snapshot.approvals) {
      if (this.settledDuringRead(openAtStart, card.requestId)) continue;
      approvals.push(demotedSinceRead ? { ...card, readOnly: true } : card);
      if (this.driving) this.trackInteraction(card.requestId, 'approval');
    }
    for (const question of snapshot.questions) {
      const requestId = question.message.requestId;
      if (this.settledDuringRead(openAtStart, requestId)) continue;
      // Registered even on the observe posture: a connection promoted by a
      // later attach is a different object, but a pending read is also how a
      // driving connection recovers the ids it needs after a reconnect. Inert
      // either way — every answering path goes through the drive layer's write
      // gate first, and a demoted connection is refused there.
      this.rememberQuestion(question.record);
      questions.push(demotedSinceRead ? { ...question.message, readOnly: true } : question.message);
      if (this.driving) this.trackInteraction(requestId, 'question');
    }
    return [...approvals, ...questions];
  }

  /**
   * ONE reading of both interaction endpoints, against ONE generation, with NO
   * side effects of its own.
   *
   * `undefined` means this connection did not learn what is open — a read
   * refused, the connection closed, or `this.transport` was replaced while the
   * reads were out — and that is deliberately NOT the same answer as an empty
   * snapshot. The difference is the whole point: an empty snapshot is evidence
   * that nothing is pending, which the drive layer's `reconcileInteractions`
   * turns into RETRACTIONS, while a failed read is evidence of nothing at all.
   * A PARTIAL read is a failed read for the same reason: approvals-ok,
   * questions-refused describes half a server, and half a server cannot say what
   * is open on it.
   *
   * {@link noteUnauthorized} still fires on a refused read — invalidating a
   * generation the server has stopped accepting is transport bookkeeping, not an
   * emission, and withholding it would leave every later read re-sending a
   * credential the server has already refused. Nothing else here mutates: no
   * registry write, no emission, no open-set bookkeeping. The caller applies the
   * snapshot, or discards it whole.
   *
   * The `readOnly` it stamps is the ENTRY posture, captured before the awaits,
   * and it is deliberately not re-read afterwards: this reader has no side
   * effects and no opinion about what happened during it. Both appliers —
   * {@link getPending} here and the drive layer's `applyPendingSnapshot` —
   * harden that flag MONOTONICALLY against the posture at apply time, which is
   * what covers a demotion landing while these two reads were out.
   */
  protected async readPendingSnapshot(): Promise<KimiPendingSnapshot | undefined> {
    if (this.closed) return undefined;
    if (this.transportInvalid && !(await this.ensureTransport())) return undefined;
    // BY OBJECT IDENTITY, the same way the write door and the reconciliation
    // watch it: `ensureTransport` replaces `this.transport` wholesale, so both
    // reads are issued through the generation captured here and the answer is
    // kept only while that generation is still the current one.
    const generation = this.transport;
    const readOnly = !this.driving;
    const approvals = await generation.http.getJson<{ items?: unknown }>(
      `/api/v1/sessions/${encodeURIComponent(this.info.id)}/approvals`,
      { status: 'pending' },
    );
    if (!approvals.ok) {
      this.noteUnauthorized(approvals.reason);
      return undefined;
    }
    if (this.closed || this.transport !== generation) return undefined;
    const questions = await generation.http.getJson<{ items?: unknown }>(
      `/api/v1/sessions/${encodeURIComponent(this.info.id)}/questions`,
      { status: 'pending' },
    );
    if (!questions.ok) {
      this.noteUnauthorized(questions.reason);
      return undefined;
    }
    if (this.closed || this.transport !== generation) return undefined;
    const snapshot: KimiPendingSnapshot = { approvals: [], questions: [] };
    for (const item of Array.isArray(approvals.data?.items) ? approvals.data.items : []) {
      const card = mapKimiApprovalRequest(item, readOnly);
      if (card) snapshot.approvals.push(card);
    }
    for (const item of Array.isArray(questions.data?.items) ? questions.data.items : []) {
      const mapped = mapKimiQuestionRequest(item, readOnly);
      if (mapped) snapshot.questions.push(mapped);
    }
    return snapshot;
  }

  /**
   * Did this id SETTLE while the pending reads were out?
   *
   * The other half of the two-point membership rule the drive layer's
   * `applyPendingSnapshot` applies — same predicate, opposite direction. That
   * one asks "was this id open at both points and absent from the snapshot", to
   * decide a RETRACTION. This one asks "was this id open at the first point and
   * gone at the second", to decide whether a card the snapshot still lists may
   * be registered at all.
   *
   * Only the socket path and this connection's own writes delete from
   * {@link openInteractions}, and both of those mean the same thing: the request
   * is SETTLED. A snapshot listing it is a reading the server took before it
   * settled, so applying it would reopen a card the connection has already
   * closed — and the resolution's emission identity is in the seen-set by then,
   * so no later retraction could reach the client to close it a second time.
   *
   * ACCEPTED EDGE: the {@link KIMI_INTERACTION_REGISTRY_LIMIT} eviction deletes
   * an id that is still open, and such an id matches this predicate too, so it
   * is skipped conservatively. The miss is one pass wide and fail-safe in
   * direction — the NEXT pass captures its `openAtStart` without the evicted id,
   * so the predicate is false and the card is registered again.
   */
  protected settledDuringRead(
    openAtStart: ReadonlyMap<string, 'approval' | 'question'>,
    requestId: string,
  ): boolean {
    return openAtStart.has(requestId) && !this.openInteractions.has(requestId);
  }

  /** Remember one card this connection has SHOWN, bounded oldest-first. See {@link openInteractions}. */
  protected trackInteraction(requestId: string, kind: 'approval' | 'question'): void {
    this.openInteractions.delete(requestId);
    this.openInteractions.set(requestId, kind);
    while (this.openInteractions.size > KIMI_INTERACTION_REGISTRY_LIMIT) {
      // Maps iterate in insertion order, so the first key is the oldest.
      const oldest = this.openInteractions.keys().next();
      if (oldest.done) break;
      this.openInteractions.delete(oldest.value);
    }
  }

  /**
   * Record a reading this call is delivering DIRECTLY, so the next tick treats
   * it as the current one and repeats nothing.
   *
   * The revision is not reset — it is the existing one, or zero on a key never
   * emitted — because a revision that rewound could name an identity the
   * seen-set already holds while carrying a different reading. Remembering the
   * identity as well keeps the seen-set holding exactly the revision that was
   * delivered, so the two gates agree.
   */
  private seedOverlay(overlay: Extract<AgentMessage, { type: 'metadata-update' }>): void {
    const revision = this.overlayRevisions.get(overlay.key)?.revision ?? 0;
    this.overlayRevisions.set(overlay.key, { lastJson: JSON.stringify(overlay.value), revision });
    this.remember(kimiOverlayIdentity(overlay.key, revision));
  }

  /**
   * Deliver a reading only if it CHANGED since the last one under its key.
   *
   * An unchanged reading stops HERE rather than at the seen-set, and a changed
   * one always carries a revision no gate has seen. See
   * {@link overlayRevisions}.
   */
  private emitOverlay(overlay: Extract<AgentMessage, { type: 'metadata-update' }>): void {
    const json = JSON.stringify(overlay.value);
    const current = this.overlayRevisions.get(overlay.key);
    if (current && current.lastJson === json) return;
    const revision = (current?.revision ?? 0) + 1;
    this.overlayRevisions.set(overlay.key, { lastJson: json, revision });
    this.emit(overlay, kimiOverlayIdentity(overlay.key, revision));
  }

  private async readOverlays(): Promise<AgentMessage[]> {
    const result = await this.transport.http.getJson<unknown>(
      `/api/v1/sessions/${encodeURIComponent(this.info.id)}/status`,
    );
    if (!result.ok) {
      this.noteUnauthorized(result.reason);
      return [];
    }
    return mapKimiSessionStatus(result.data);
  }

  /**
   * Re-read the overlays on a tick.
   *
   * Overlays were read at ATTACH only, so a context-window reading went stale
   * the moment the session took another turn and stayed stale for the whole
   * observe. Each reading is compared against the last one under its key, so a
   * CHANGED reading emits and an unchanged one costs one request and nothing
   * else.
   *
   * With no handler listening this does nothing, the same rule {@link refresh}
   * follows: the read force-loads nothing here, but it is still an active
   * request to the Kimi server on behalf of nobody.
   */
  private async refreshOverlays(): Promise<void> {
    if (this.closed || !this.hasSubscribers) return;
    if (this.transportInvalid && !(await this.ensureTransport())) return;
    const overlays = await this.readOverlays();
    if (this.closed) return;
    for (const overlay of overlays) {
      if (overlay.type !== 'metadata-update') continue;
      this.emitOverlay(overlay);
    }
  }

  /**
   * Is anybody listening to this connection right now?
   *
   * The single definition of the rule {@link refresh}, {@link refreshOverlays},
   * {@link resyncRecover} and the drive layer's interaction reconciliation all
   * apply: an ACTIVE read on behalf of nobody is not merely unobserved work.
   * `GET .../messages`, `.../approvals` and `.../questions` each FORCE-LOAD the
   * session into the Kimi server, making it a second live owner alongside any
   * terminal holding the same session, and paying that coexistence cost for a
   * session no client is watching is never right.
   *
   * `protected` because the subclass owns reads of its own; the handler set
   * itself stays private, so no subclass can deliver to it directly.
   */
  protected get hasSubscribers(): boolean {
    return this.handlers.size > 0;
  }

  /**
   * Removing the last handler does NOT stop the socket or the poll; only
   * {@link close} does. That is the established contract for this repo's observe
   * connections — the other observe adapters likewise tear down nothing on
   * last-unsubscribe — and the broker owns the lifecycle: `hub.dispose()` and
   * every connection-replacement path call `close()`.
   *
   * Worth knowing when reading this: Kimi's machinery is not passive. The
   * file-watching and transcript-tailing adapters observe passively, whereas
   * each poll tick here is an active REST read that force-loads the session
   * server-side. So while the timer and socket do keep running, the reads gate
   * themselves on {@link hasSubscribers} — the socket may stay open because that
   * half is passive and cheap. The invariant that makes it safe is `close()`,
   * not the handler count.
   */
  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (this.handlers.size === 1) this.start();
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Idempotent by design: `subscribe` calls this every time the handler count
   * rises to 1, and unsubscribing does not stop the machinery, so a
   * subscribe → unsubscribe → subscribe cycle would otherwise install a second
   * interval and orphan the first (double load, and `close` could only clear the
   * newer handle).
   */
  protected start(): void {
    if (this.closed || this.pollHandle !== undefined) return;
    // The FIRST socket needs no re-verification: whoever built this connection
    // verified the generation it carries moments ago, and re-running the gate
    // here would cost an identity round-trip to prove what the attach just
    // proved. Every LATER socket is a replacement and goes through
    // restoreSocket.
    this.openSocket();
    this.pollHandle = this.setIntervalImpl(() => {
      // The tick owns BOTH jobs: pull the fresh REST state, and restore the
      // stream if it dropped. Without the reopen, one lost socket would demote a
      // server-live session to poll-only for the rest of the connection.
      void this.restoreSocket();
      void this.refresh();
      // The overlay read and the journal read are NOT part of the transcript
      // walk and must not take its single slot: the walk is the expensive,
      // session-force-loading job, and a coalesced tick would otherwise silently
      // stop refreshing the context reading and the usage account too.
      void this.refreshOverlays();
      this.updateTelemetry();
    }, this.pollIntervalMs);
  }

  /**
   * Deliver a row, or hold it until history has primed this connection.
   *
   * The production order is subscribe-first, history-second, so anything emitted
   * before the first {@link getHistory} completes would also arrive inside the
   * history reset that follows — the same row twice. Holding it until `seen` is
   * seeded lets the flush drop exactly the rows history already carried.
   */
  protected emit(message: AgentMessage, identity: string): void {
    if (!this.primed) {
      this.primingStartedAt ??= this.nowImpl();
      const overflowed = this.priming.length >= KIMI_PRIMING_MAX_ROWS
        || this.nowImpl() - this.primingStartedAt >= KIMI_PRIMING_TIMEOUT_MS;
      if (!overflowed) {
        // Buffer DISTINCT rows only. Nothing is marked seen while unprimed, so a
        // repeating refresh would otherwise re-buffer the same rows and trip the
        // cap on duplicates rather than on genuine pending volume.
        if (!this.primingIdentities.has(identity)) {
          this.primingIdentities.add(identity);
          this.priming.push({ message, identity });
        }
        return;
      }
      // Cap breached: a caller that never reads history must not cost live rows.
      // Prime here so this row and every later one are delivered directly.
      this.prime();
    }
    // The triggering row takes the SAME gate as every other row. Delivering it
    // unconditionally here is how a row the breach-flush had just released got
    // sent a second time.
    if (this.seen.has(identity)) return;
    this.remember(identity);
    this.deliver(message);
  }

  private deliver(message: AgentMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch {
        /* one bad subscriber must not stop the others */
      }
    }
  }

  /**
   * Open the gate and release whatever was buffered, minus anything the history
   * read already delivered. Idempotent.
   */
  private prime(): void {
    if (this.primed) return;
    this.primed = true;
    const buffered = this.priming;
    this.priming = [];
    this.primingIdentities.clear();
    for (const row of buffered) {
      if (this.seen.has(row.identity)) continue;
      this.remember(row.identity);
      this.deliver(row.message);
    }
    // Prime time is the telemetry BASELINE: the journal's whole history becomes
    // the opening sums and the opening timing, and only what appears after it
    // is a live reading. Doing it here rather than at attach keeps the account
    // aligned with the transcript the client just received.
    this.updateTelemetry();
  }

  private remember(identity: string): void {
    this.seen.add(identity);
    if (this.seen.size <= SEEN_IDENTITY_LIMIT) return;
    // Sets iterate in insertion order, so the first entries are the oldest.
    const excess = this.seen.size - SEEN_IDENTITY_LIMIT;
    let dropped = 0;
    for (const identity_ of this.seen) {
      this.seen.delete(identity_);
      dropped += 1;
      if (dropped >= excess) break;
    }
  }

  /**
   * Re-read the newest messages and emit only what this connection has not
   * delivered yet. Also the recovery path for `resync_required`, an epoch
   * change, and a dropped socket — one refresh answers all three.
   *
   * A page whose rows are ALL unseen is evidence the window was too small: the
   * overlap with what we already hold is what proves nothing fell between ticks.
   * With no overlap, keep paging backward (bounded) until an already-seen row
   * appears, then emit oldest-first so the transcript stays ordered.
   *
   * With no handler listening this does nothing at all: the read is not merely
   * unobserved work, it force-loads the session into the Kimi server, and paying
   * that coexistence cost for a session nobody is watching is never right. A
   * later re-subscribe needs no catch-up path — the next tick simply refreshes,
   * and the overlap walk above covers whatever accumulated in between.
   */
  async refresh(): Promise<void> {
    if (this.closed || this.refreshing) return;
    if (!this.hasSubscribers) return;
    // A refused generation must not be spent on another read: re-resolve first,
    // and read nothing at all when that cannot be done right now. Re-resolution
    // YIELDS, so the guards above are re-taken after it — a refresh that
    // coalesces on a busy slot must not become a second walk merely because it
    // waited.
    if (this.transportInvalid) {
      if (!(await this.ensureTransport())) return;
      if (this.closed || this.refreshing || !this.hasSubscribers) return;
    }
    await this.runExclusiveWalk(KIMI_REFRESH_MAX_PAGES, KIMI_REFRESH_PAGE_SIZE);
  }

  /**
   * Take the single-walk slot and run one walk in it. Ordinary poll refreshes
   * COALESCE on a busy slot (`refresh` returns without reading — the next tick
   * covers it), but resync recovery must never coalesce away: it WAITS on
   * {@link activeWalk} instead, because the walk it needs is deeper than the
   * one that holds the slot.
   */
  private runExclusiveWalk(
    maxPages: number,
    pageSize: number,
  ): Promise<'overlapped' | 'exhausted' | 'error' | 'ceiling'> {
    this.refreshing = true;
    const run = this.walk(maxPages, pageSize).finally(() => {
      this.refreshing = false;
      this.activeWalk = undefined;
    });
    this.activeWalk = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The shared backward walk: newest page first, keep paging until the window
   * overlaps rows this connection already holds, the source ends, a read
   * fails, or the ceiling falls. Emits everything gathered oldest-first.
   * Returns how the walk stopped, so the resync path can distinguish "the
   * view reconnected to known rows" from "the gap may be bigger than the
   * ceiling".
   */
  private async walk(
    maxPages: number,
    pageSize: number,
  ): Promise<'overlapped' | 'exhausted' | 'error' | 'ceiling'> {
    const pages: KimiMappedRow[][] = [];
    let beforeId: string | undefined;
    let outcome: 'overlapped' | 'exhausted' | 'error' | 'ceiling' = 'ceiling';
    for (let page = 0; page < maxPages; page += 1) {
      // A closed connection must stop paying the force-load cost mid-walk:
      // every remaining page is an active REST read that resumes the session in
      // the Kimi server, and nothing downstream can observe the outcome once
      // close() has run (handlers are cleared, the resubscribe is guarded).
      if (this.closed) break;
      const result = await this.transport.http.getJson<KimiMessagePage>(
        `/api/v1/sessions/${encodeURIComponent(this.info.id)}/messages`,
        { page_size: pageSize, ...(beforeId ? { before_id: beforeId } : {}) },
      );
      if (!result.ok) {
        this.noteUnauthorized(result.reason);
        outcome = 'error';
        break;
      }
      const mapped = mapKimiMessagePage(result.data);
      pages.unshift(mapped.rows);
      const overlaps = mapped.rows.some((row) => this.seen.has(row.identity));
      // Stop as soon as the window overlaps what we hold, or the source ends.
      if (overlaps) {
        outcome = 'overlapped';
        break;
      }
      if (mapped.rows.length === 0 || !mapped.hasMore || !mapped.oldestId || mapped.oldestId === beforeId) {
        outcome = 'exhausted';
        break;
      }
      beforeId = mapped.oldestId;
    }
    // Same reason after the walk: a connection closed mid-page has no handlers
    // left, so the rows it gathered can reach nobody.
    if (this.closed) return outcome;
    const walked = pages.flat();
    // BEFORE emission, deliberately: the detector must see every row this walk
    // gathered, including the ones the seen-set is about to swallow. A foreign
    // prompt that already emitted once is still a foreign prompt.
    this.onWalkedRows(walked);
    for (const row of walked) {
      // `emit` owns the seen-check and the remember for BOTH the primed and
      // the buffered paths, so there is exactly one place a row can be
      // admitted.
      this.emit(this.decorateRow(row), row.identity);
    }
    return outcome;
  }

  /**
   * Recovery after the server declared this connection's cursor unservable
   * (`resync_required`). The caller has ALREADY adopted the current watermark
   * the frame carried, so the resubscribe below starts from a position the
   * server can serve — never from the stale zero that made the old recovery
   * loop forever on any session more than one replay buffer ahead.
   *
   * The content gap is bridged in message-space with a deeper bounded walk
   * than the poll refresh. When even that ceiling cannot reconnect the view to
   * known rows, the transcript says so in-band rather than presenting a silent
   * hole. Both the walk and the notice apply only to a PRIMED connection: an
   * unprimed one has its history read still ahead, and that read is the
   * rebuild.
   *
   * COALESCED, one recovery in flight per connection. A burst of resync frames
   * is one incident, not N: each frame has already adopted (or cleared) its
   * watermark in {@link onFrame}, so a per-frame recovery would spend N deep
   * walks of up to {@link KIMI_RESYNC_MAX_PAGES} force-loading reads each and N
   * resubscribes to reach the position the newest frame already named. Late
   * frames set the pending flag instead; one extra walk covers all of them, and
   * a single resubscribe from the newest cursor ends the incident.
   *
   * BOUNDED, {@link KIMI_RESYNC_RECOVERY_PASS_MAX} passes per incident: coalescing
   * alone does not end an incident whose stream keeps arriving, because every
   * frame landing during a pass buys another one. A stream that outruns the
   * ceiling is conceded in-band and the incident ends where it stands.
   */
  private async resyncRecover(): Promise<void> {
    if (this.closed) return;
    if (this.recoveryActive) {
      this.recoveryPending = true;
      return;
    }
    this.recoveryActive = true;
    // The identity of every gap notice this incident may emit, taken from the
    // watermark it OPENED on. One incident states its gap once however many
    // passes it spends, while a later, higher gap is a different position and
    // surfaces as its own notice — and a server repeating the same verdict
    // repeats the same identity, so it dedupes.
    const gapIdentity = this.resyncGapIdentity();
    let passes = 0;
    try {
      do {
        this.recoveryPending = false;
        passes += 1;
        if (this.primed && this.hasSubscribers) {
          // Recovery is not skippable work. A poll refresh holding the slot
          // walks a 60-message window that may not span the declared gap, so
          // ceding to it — adopt, resubscribe, no deep walk — would leave a
          // permanent, unreported hole in the live view. Wait for the slot
          // instead, then run the deep walk; the resubscribe below happens only
          // after every pending frame has been covered.
          while (this.refreshing) await this.activeWalk;
          if (this.closed) return;
          const outcome = await this.runExclusiveWalk(KIMI_RESYNC_MAX_PAGES, KIMI_HISTORY_PAGE_SIZE);
          if (outcome === 'ceiling' || outcome === 'error') {
            // Both are INCOMPLETE recoveries — the ceiling fell before the view
            // reconnected to known rows, or a read failed mid-rebuild — and the
            // resubscribe below advances past whatever was missed, so the
            // transcript must say so first.
            this.emit({ type: 'notice', message: KIMI_RESYNC_GAP_NOTICE }, gapIdentity);
          }
        }
      } while (this.recoveryPending && !this.closed && passes < KIMI_RESYNC_RECOVERY_PASS_MAX);
      if (this.recoveryPending && !this.closed && this.primed && this.hasSubscribers) {
        // The passes ran out with frames still unaccounted for. The resubscribe
        // below moves to the newest adopted watermark, so whatever those frames
        // named is now behind the live view and unread: an incident that outran
        // its ceiling is an unbridged gap and says so, under the same identity
        // the walk uses (so an incident that already conceded says it once).
        this.emit({ type: 'notice', message: KIMI_RESYNC_GAP_NOTICE }, gapIdentity);
      }
      this.resubscribe();
      // The incident is over: the view is either reconnected or has conceded
      // its gap in-band, and either way this is the coherent state a drive
      // connection must reconcile its in-flight fences against.
      this.onStreamRestored();
    } finally {
      this.recoveryActive = false;
    }
  }

  /**
   * Identity for the gap notice of one incident: the watermark the incident
   * opened on. See {@link resyncRecover} for why it is taken once, at the start.
   * An unknown cursor has no watermark to name, so it dedupes under its own.
   */
  private resyncGapIdentity(): string {
    return this.cursor
      ? `notice:kimi-resync-gap:${this.cursor.epoch ?? ''}:${this.cursor.seq}`
      : 'notice:kimi-resync-gap:unknown';
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────

  /**
   * One bounded pass over this session's wire journals, at prime time and then
   * once per tick.
   *
   * Runs whether or not a handler is listening, unlike {@link refresh}: the
   * reason that read is gated is the force-load it costs the Kimi server, and
   * this one costs a local file read of at most one tick cap. Skipping it would
   * also let the tail fall behind, so the next subscriber would receive a burst
   * of readings for work it never watched.
   *
   * Discovery happens once, lazily. Nothing found — no journal, no directory, a
   * failing io — DISABLES telemetry for the connection: this session then emits
   * no usage and no timing at all, which is the honest answer. An invented zero
   * would be indistinguishable from a session that truly spent nothing.
   */
  private updateTelemetry(): void {
    if (this.closed || this.telemetryDisabled || !this.wireRoot || this.telemetryRunning) return;
    this.telemetryRunning = true;
    try {
      if (!this.wireTail) {
        let discovery;
        try {
          discovery = locateKimiWireStreams(this.wireRoot, this.info.id, this.wireIo);
        } catch {
          this.telemetryDisabled = true;
          return;
        }
        if (discovery.streams.length === 0) {
          this.telemetryDisabled = true;
          return;
        }
        this.telemetryClipped = this.telemetryClipped || discovery.truncated;
        this.wireTail = new KimiWireTail(discovery.streams, this.wireIo);
      }
      const baseline = !this.telemetryBaselined;
      // The baseline DRAINS the window; a tick samples it. One read() is bounded
      // at one tick cap per stream, so a journal whose tail window is larger
      // than that would otherwise have the REST of its history arrive on later
      // ticks and be emitted as live token-count rows — precisely the flood the
      // baseline rule exists to prevent. Repeat until a pass takes nothing at
      // all (no records AND no bytes: a pass can consume a whole tick cap of
      // tool rows and decode nothing), bounded by
      // {@link TELEMETRY_DRAIN_MAX_PASSES}.
      const maxPasses = baseline ? TELEMETRY_DRAIN_MAX_PASSES : 1;
      const records: KimiUsageRecord[] = [];
      for (let pass = 0; pass < maxPasses; pass += 1) {
        let read;
        try {
          read = this.wireTail.read();
        } catch {
          // A bad tick is not a dead connection; the next one re-reads. A first
          // pass that cannot read has taken no baseline at all, so the flag
          // below stays down and the next tick baselines instead.
          if (pass === 0) return;
          break;
        }
        this.telemetryClipped = this.telemetryClipped || read.clipped;
        records.push(...read.records);
        if (read.records.length === 0 && read.bytesConsumed === 0) break;
      }
      this.telemetryBaselined = true;
      for (const record of records) {
        this.rememberEventTime(record.streamId, record.timeMs);
        this.usageTotals.inputTokens += record.inputOther;
        this.usageTotals.outputTokens += record.output;
        this.usageTotals.cacheReadTokens += record.inputCacheRead;
        this.usageTotals.cacheCreationTokens += record.inputCacheCreation;
        this.usageTotals.records += 1;
        // The BASELINE is a meter reading of everything that already happened —
        // every pass of the drain above, not merely its first. Emitting it as
        // rows would flood the transcript with the whole session's history of
        // counts at attach; it seeds the sums and the timing instead, and only
        // readings that arrive AFTER it are events.
        if (baseline) continue;
        const ordinal = (this.wireOrdinals.get(record.streamId) ?? 0) + 1;
        this.wireOrdinals.set(record.streamId, ordinal);
        this.emit(
          {
            type: 'token-count',
            input: record.inputOther,
            output: record.output,
            cacheRead: record.inputCacheRead,
            cacheWrite: record.inputCacheCreation,
            // NO `cost`. The journal records counts and never a price, and this
            // adapter will not invent one from a rate card it cannot verify
            // against the user's actual plan.
          },
          `token-count:kimi:${record.streamId}:${record.timeMs}:${ordinal}`,
        );
      }

      // Cumulative over the OBSERVED WINDOW, which the tail cap may have started
      // part way into the session. `windowClipped` is what keeps that honest: a
      // clipped sum must never be presented as a session total.
      const usage = { ...this.usageTotals, windowClipped: this.telemetryClipped };
      this.emitOverlay({ type: 'metadata-update', key: 'sessionUsage', value: usage });

      // Two figures, never one: `agentMs` counts every stream's work additively,
      // so a subagent working one minute alongside the main stream adds a minute
      // to it — while `activeMs` counts that same minute of wall clock ONCE.
      const account = activeTimeAccount(this.wireTimestamps, KIMI_ACTIVE_GAP_CAP_MS);
      const timing = {
        ...account,
        // Both are estimates from event timestamps; the method name travels with
        // them so a reader can check the number against its definition.
        estimated: true,
        method: KIMI_ACTIVE_TIME_METHOD,
        gapCapMs: KIMI_ACTIVE_GAP_CAP_MS,
        streams: this.wireTail.streams.length,
        windowClipped: this.telemetryClipped,
      };
      this.emitOverlay({ type: 'metadata-update', key: 'activeTime', value: timing });
    } finally {
      this.telemetryRunning = false;
    }
  }

  private rememberEventTime(streamId: string, timeMs: number): void {
    const timestamps = this.wireTimestamps.get(streamId) ?? [];
    timestamps.push(timeMs);
    if (timestamps.length > ACTIVE_EVENT_LIMIT_PER_STREAM) {
      timestamps.splice(0, timestamps.length - ACTIVE_EVENT_LIMIT_PER_STREAM);
      // The window no longer reaches the start of what was observed.
      this.telemetryClipped = true;
    }
    this.wireTimestamps.set(streamId, timestamps);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /**
   * Open a REPLACEMENT socket generation, which never reuses the proof the
   * previous one spent.
   *
   * The socket may have died BECAUSE the server behind it did — restarted, or
   * replaced by whatever now holds that port, or rotated to a new token — so the
   * instance is re-resolved before the reconnect, and ONE fresh token snapshot
   * then serves both transports: the same single-snapshot rule attach itself
   * follows. A re-resolution that fails simply waits; the next tick tries again,
   * which is strictly better than reconnecting on a credential nothing has
   * verified.
   *
   * `protected` so the drive layer can ask for the reconnect AT THE MOMENT it
   * needs one — a write that finds the stream down triggers this rather than
   * waiting out a poll interval for the tick to do it. Idempotent by the guard
   * above: a socket already assigned (open or still handshaking) is not
   * replaced, so an impatient caller cannot stack sockets.
   */
  protected async restoreSocket(): Promise<void> {
    if (this.closed || this.socket) return;
    if (this.socketEverOpened && this.reverify) {
      this.transportInvalid = true;
      if (!(await this.ensureTransport())) return;
    }
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closed || this.socket) return;
    const factory = this.socketFactory ?? defaultSocketFactory;
    let socket: KimiSocketLike;
    try {
      socket = factory(this.transport.wsUrl, this.transport.token);
    } catch {
      return; // No socket means poll-only observe, which is still honest read-only sync.
    }
    this.socketEverOpened = true;
    this.socket = socket;
    // Constructed is not open. The new socket carries nothing until its
    // handshake completes, and until then this connection is poll-only however
    // many socket objects it holds.
    this.socketOpen = false;
    // A new socket is a new stream: whatever the previous one would have
    // delivered between its death and this open was never delivered at all.
    this.noteStreamBreak();
    // EVERY listener below begins by proving it still speaks for the connection.
    // A socket object outlives its ownership — it is retired by
    // {@link retireSocket}, and a real socket keeps firing for a while after
    // `close()` — and a listener that skips the guard acts for a stream nobody
    // is watching: a late `close` clears `this.socket` over the REPLACEMENT and
    // re-invalidates a generation that was just resolved; a late `message` moves
    // the new view's cursor and `liveActivity` with the old server's words; a
    // late `open` reports a stream that is up when the current one is not. The
    // listener closes over its OWN socket, so the comparison is exact.
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      // FIRST, before the subscribe frames and before onStreamRestored: both of
      // those run code that asks whether the stream is up, and it is — this is
      // the event that makes it so.
      this.socketOpen = true;
      this.sendFrame('client_hello', { client_id: 'cosyncing' }, 'hello');
      this.sendFrame(
        'subscribe',
        {
          session_ids: [this.info.id],
          cursors: this.cursor ? { [this.info.id]: this.cursorPayload(this.cursor) } : {},
        },
        'subscribe',
      );
      this.sendFrame(
        'subscribe_v2',
        { session_id: this.info.id, transcript: { '*': KIMI_TRANSCRIPT_GRADE } },
        'subscribe-v2',
      );
      // The stream is live again from here. Anything in flight when the
      // previous one died has to be reconciled now, not on the next tick.
      this.onStreamRestored();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.onFrame((event as { data?: unknown }).data);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.socketOpen = false;
      if (this.closed) return;
      this.noteStreamBreak();
      // A lost socket is a resync: this refresh restores correctness now, and
      // the next poll tick calls restoreSocket() (see start()) to restore the
      // stream. Reopening from here instead would reconnect in a tight loop
      // against a server that is down.
      //
      // A socket dies when the server goes away, so the generation behind it is
      // exactly what is now in doubt: the refresh runs through the gate, which
      // re-resolves before it reads and reads nothing if it cannot. A
      // fixed-transport connection has no second generation to reach for, so it
      // keeps the immediate refresh — the only read it can still make, and the
      // one whose failure it can still report.
      if (this.reverify) this.transportInvalid = true;
      void this.refresh();
    });
    socket.addEventListener('error', () => {
      /* close follows; nothing to do here */
    });
  }

  private cursorPayload(cursor: KimiCursor): { seq: number; epoch?: string } {
    return { seq: cursor.seq, ...(cursor.epoch ? { epoch: cursor.epoch } : {}) };
  }

  /**
   * The single send path. Refuses any frame outside the read-only set, so a
   * later edit cannot smuggle an `abort` or `terminal_input` through an observe
   * connection.
   */
  private sendFrame(type: KimiReadOnlyWsFrame, payload: unknown, id?: string): void {
    if (!isKimiReadOnlyWsFrame(type)) return;
    try {
      this.socket?.send(JSON.stringify({ type, ...(id ? { id } : {}), payload }));
    } catch {
      /* a send failure surfaces as a close, handled above */
    }
  }

  private onFrame(raw: unknown): void {
    const bytes = kimiFrameByteLength(raw);
    // A shape this reader cannot MEASURE is not one it will parse. A real
    // WebSocket delivers a text frame as a string and a binary frame as an
    // ArrayBuffer (or a view of one); anything else never came off this wire,
    // so there is no bounded read to perform and nothing to account for.
    if (bytes === undefined) return;
    if (bytes > KIMI_WS_FRAME_MAX_BYTES) {
      // DROPPED before `JSON.parse` ever sees it — bounding after parsing is
      // not bounding. A dropped frame may have carried a cursor movement or an
      // event this connection needed, so the live view genuinely has a hole and
      // says so; pretending the view is intact is what would let the divergence
      // detector call a later silence trustworthy.
      this.noteStreamBreak();
      return;
    }
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(kimiFrameText(raw));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = frame.type;
    if (type === 'ping') {
      const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
      this.sendFrame('pong', typeof nonce === 'string' ? { nonce } : {});
      return;
    }
    if (type === 'resync_required') {
      const payload = frame.payload as {
        session_id?: unknown;
        current_seq?: unknown;
        epoch?: unknown;
      } | undefined;
      // A resync names the journal it is about. Another session's gap (or the
      // global journal's) says nothing about ours and must not touch our
      // cursor or trigger recovery work.
      if (payload?.session_id !== this.info.id) return;
      // Adopt the CURRENT watermark the server just told us. This is the whole
      // loop-breaking move: resubscribing from here is always servable,
      // whereas the reset-to-zero the old code did re-asks for the exact
      // replay the server just refused.
      const epoch = typeof payload.epoch === 'string' && payload.epoch ? payload.epoch : undefined;
      if (typeof payload.current_seq === 'number'
        && Number.isSafeInteger(payload.current_seq) && payload.current_seq >= 0) {
        this.cursor = { seq: payload.current_seq, ...(epoch ? { epoch } : {}) };
      } else {
        // A malformed watermark is not a watermark. Falling back to zero
        // invents the precise replay the server just refused, forever; dropping
        // the cursor instead asks for no replay and takes the server's own
        // position from the ack.
        this.cursor = undefined;
      }
      // The server declaring our cursor unservable is the strongest form of
      // "you missed things": the live view has a hole of unknown size until
      // recovery closes it.
      this.noteStreamBreak();
      void this.resyncRecover();
      return;
    }
    if (type === 'ack') {
      // The ack's cursor map is keyed by session id; adoptCursor reads only
      // this session's entry, so foreign entries cannot leak in.
      this.adoptCursor((frame.payload as { cursors?: unknown } | undefined)?.cursors);
      return;
    }
    // Everything else is an event envelope. Only OUR journal's envelopes may
    // move the cursor: global fan-out events (`session_id: "__global__"`, plus
    // other sessions' global-family events) reach every connection carrying
    // their OWN journal's seq/epoch, and adopting one would corrupt this
    // session's replay position. They are otherwise ignored by design — the
    // REST refresh is the content channel.
    if (frame.session_id !== this.info.id) return;
    if (typeof type !== 'string') return;
    // An envelope naming OUR journal proves the server is doing something with
    // this session right now. Recorded before anything else, and for every
    // owned frame including ones this version does not map, because the
    // divergence detector's question is "was the server alive here", not "did
    // we understand what it said".
    this.liveActivityValue += 1;
    this.adoptSeq(frame.seq, frame.epoch);
    // The event fields ride INSIDE `payload`; the envelope carries only
    // routing (`type`, `seq`, `epoch`, `session_id`, `timestamp`).
    // See `sessionEventBroadcaster.ts:1308-1322`.
    const payload = frame.payload;
    this.onSessionEvent(type, payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {});
    if (REFRESH_TRIGGER_EVENTS.has(type)) {
      // The mapped content channel is the REST read; these types only say WHEN
      // to run it. See {@link REFRESH_TRIGGER_EVENTS} for why the deltas are not
      // in the set.
      void this.refresh();
    }
  }

  /**
   * Map one owned-session event into canonical rows. Shared by BOTH postures on
   * purpose: an observe client watching a session that is blocked on an
   * approval should see the card (read-only), not merely a `needs-input` badge.
   *
   * Tolerant like the rest of the dispatch — an unknown type falls through
   * silently, and a known type with a drifted payload degrades to no emission
   * rather than a throw inside a socket callback.
   */
  private onSessionEvent(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case 'event.session.work_changed': {
        const status = mapKimiWorkChanged(payload);
        // IGNORED, not defaulted. `undefined` means the frame carried no
        // readable run state, and this connection already holds a state that
        // was read from evidence — keeping it is strictly better than replacing
        // it with a guess. Nothing is emitted, so no status row lands and (in
        // the drive subclass) no completion fence is cleared: only an
        // AUTHORITATIVE idle ends a turn.
        if (status === undefined) return;
        this.applyRunState(status);
        return;
      }
      case 'prompt.completed':
      case 'prompt.aborted': {
        // camelCase upstream (`events-zod.ts:908-919`), unlike the snake_case
        // session/interaction families.
        const promptId = typeof payload.promptId === 'string' ? payload.promptId : undefined;
        if (promptId) this.onPromptSettled(promptId, type === 'prompt.aborted');
        return;
      }
      case 'turn.ended': {
        if (!this.isMainAgentFrame(payload)) return;
        if (payload.reason !== 'failed') return;
        // `turnId` is a NUMBER upstream (`events-zod.ts:681-690`), so the
        // identity stringifies it rather than assuming a string id.
        this.emit(
          { type: 'error', message: mapKimiTurnFailure(payload) },
          `error:kimi-turn-failed:${String(payload.turnId ?? 'unknown')}`,
        );
        return;
      }
      case 'event.approval.requested': {
        const card = mapKimiApprovalRequest(payload, !this.driving);
        if (!card) return;
        this.emit(card, `permission-request:${card.requestId}`);
        // Tracked AFTER the emission and unconditionally, including for a card
        // the seen-set deduped: the id is open on the server either way, and the
        // reconciliation's retraction is about what the USER is looking at.
        this.trackInteraction(card.requestId, 'approval');
        return;
      }
      case 'event.approval.resolved': {
        const requestId = typeof payload.approval_id === 'string' ? payload.approval_id : undefined;
        if (!requestId) return;
        const resolved = mapKimiApprovalResolved(payload, this.selfResolvedRequests.has(requestId));
        this.selfResolvedRequests.delete(requestId);
        this.openInteractions.delete(requestId);
        if (resolved) this.emit(resolved, `permission-resolved:${requestId}`);
        return;
      }
      case 'event.question.requested': {
        const mapped = mapKimiQuestionRequest(payload, !this.driving);
        if (!mapped) return;
        this.rememberQuestion(mapped.record);
        this.emit(mapped.message, `question-request:${mapped.message.requestId}`);
        this.trackInteraction(mapped.message.requestId, 'question');
        return;
      }
      case 'event.question.answered':
      case 'event.question.dismissed': {
        const requestId = typeof payload.question_id === 'string' ? payload.question_id : undefined;
        if (!requestId) return;
        this.questionRecords.delete(requestId);
        this.selfResolvedRequests.delete(requestId);
        this.openInteractions.delete(requestId);
        this.emit({ type: 'question-resolved', requestId }, `question-resolved:${requestId}`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Is this frame the MAIN agent's?
   *
   * An unfiltered subscription receives every agent's frames, each tagged
   * `payload.agentId` (`sessionEventBroadcaster.ts:1405-1416`), while
   * `GET .../messages` folds the main agent alone
   * (`services/messages/messageHistory.ts:125-136`). So a subagent's
   * `turn.ended` describes work that has no transcript row here and must not
   * surface as this session's turn outcome. A frame with no readable agentId
   * passes — the same defensive rule the server's own filters apply.
   */
  private isMainAgentFrame(payload: Record<string, unknown>): boolean {
    const agentId = payload.agentId;
    return typeof agentId !== 'string' || agentId === KIMI_MAIN_AGENT_ID;
  }

  /**
   * Adopt a derived run state and say so exactly once per CHANGE.
   *
   * `work_changed` is emitted on every transition the server makes, including
   * ones that derive to the same canonical status (busy false with an approval
   * pending, then busy false with it resolved, are two frames and one status).
   * Emitting per frame would flood the client with identical statuses.
   */
  protected applyRunState(status: SessionInfo['status']): void {
    if (this.closed) return;
    // Drive overrides this hook to settle its completion fences BEFORE the idle
    // status escapes, so a client never sees idle ahead of the turn's rows.
    this.beforeRunState(status);
    const previous = this.info.status;
    this.info.status = status;
    // The transcript `status` row carries the RUN state and nothing else —
    // `needs-input` is not one of its values, and it does not need to be: a
    // blocked session is not running, and the thing the user must act on
    // arrives as its own `permission-request`/`question-request` card. The
    // three-state `SessionInfo.status` above is what the roster reads.
    const next = runStatusOf(status);
    if (next === runStatusOf(previous)) return;
    // The emission ordinal, not the value, carries the identity: a session that
    // works, idles, and works again must say so three times, and an identity
    // built from the value alone would name a row the seen-set already holds.
    this.statusEmissions += 1;
    this.emit({ type: 'status', status: next }, `status:${next}:${this.statusEmissions}`);
  }

  /** Runs before a status emission. Base does nothing; see {@link applyRunState}. */
  protected beforeRunState(_status: SessionInfo['status']): void {}

  /** One prompt reached its terminal event. Base does nothing; the drive layer clears its fence. */
  protected onPromptSettled(_promptId: string, _aborted: boolean): void {}

  /** Retain a question's native ids, bounded oldest-first. See {@link KIMI_INTERACTION_REGISTRY_LIMIT}. */
  protected rememberQuestion(record: KimiQuestionRecord): void {
    this.questionRecords.delete(record.questionId);
    this.questionRecords.set(record.questionId, record);
    while (this.questionRecords.size > KIMI_INTERACTION_REGISTRY_LIMIT) {
      // Maps iterate in insertion order, so the first key is the oldest.
      const oldest = this.questionRecords.keys().next();
      if (oldest.done) break;
      this.questionRecords.delete(oldest.value);
    }
  }

  /**
   * The single shape of the epoch invariant: a changed epoch is a new journal
   * incarnation, so seq numbering restarted and the held cursor is meaningless
   * whatever the incoming seq happens to be. It resets and re-reads; only when
   * the epoch is unchanged (or absent) does a forward seq advance the cursor.
   *
   * With NO cursor held, any valid frame re-seeds one: a position observed on
   * the wire is a real watermark, unlike an invented zero. An epoch alone is
   * not — a journal identity without a position is not a cursor.
   */
  private adoptSeq(seq: unknown, epoch: unknown): void {
    if (!this.cursor) {
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) {
        this.cursor = { seq, ...(typeof epoch === 'string' && epoch ? { epoch } : {}) };
      }
      return;
    }
    if (typeof epoch === 'string' && epoch && this.cursor.epoch && epoch !== this.cursor.epoch) {
      // A new journal incarnation is a server restart or a rebuilt journal:
      // every event the previous incarnation would have delivered is gone, and
      // anything this connection had in flight against it is unresolvable from
      // the stream alone.
      this.noteStreamBreak();
      this.onStreamRestored();
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) {
        // The frame is FROM the new incarnation, so its own seq is a current
        // watermark for that journal — adopt it rather than an invented zero,
        // which the next resubscribe could find unservable.
        this.cursor = { seq, epoch };
        void this.refresh();
        return;
      }
      // A new incarnation whose frame carries no readable position is a cursor
      // this connection cannot defend, and a fabricated zero is worse than none:
      // the next reconnect would subscribe from it and ask a busy journal for
      // the one replay it is least able to serve. Fail closed, the same way the
      // resync handler does — the empty cursor map asks for no replay, and the
      // ack that answers it re-seeds a real position.
      this.cursor = undefined;
      void this.refresh();
      return;
    }
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= this.cursor.seq) {
      this.cursor = {
        seq,
        ...(typeof epoch === 'string' && epoch ? { epoch } : this.cursor.epoch ? { epoch: this.cursor.epoch } : {}),
      };
    } else if (typeof epoch === 'string' && epoch && epoch !== this.cursor.epoch) {
      // First epoch seen on a fresh cursor: adopt it without discarding position.
      this.cursor = { seq: this.cursor.seq, epoch };
    }
  }

  private adoptCursor(cursors: unknown): void {
    if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)) return;
    const entry = (cursors as Record<string, unknown>)[this.info.id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const { seq, epoch } = entry as { seq?: unknown; epoch?: unknown };
    this.adoptSeq(seq, epoch);
  }

  private resubscribe(): void {
    if (this.closed || !this.socket) return;
    // An unknown cursor is never invented. An empty cursors map asks for no
    // replay, and the ack that answers it carries the server's current
    // watermark, which adoptCursor seeds — so the connection recovers a real
    // position instead of re-asking for one the server already refused.
    this.sendFrame(
      'subscribe',
      {
        session_ids: [this.info.id],
        cursors: this.cursor ? { [this.info.id]: this.cursorPayload(this.cursor) } : {},
      },
      'resubscribe',
    );
  }

  /** Exposed for deterministic tests; never part of the broker-facing contract. */
  get observedCursor(): Readonly<KimiCursor> | undefined {
    return this.cursor;
  }

  // ── Mutation: refused ─────────────────────────────────────────────────────

  async sendPrompt(_input: PromptInput): Promise<void> {
    throw new Error('kimi observe connections are read-only');
  }

  async respondPermission(_requestId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error('kimi observe connections are read-only');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    // Telemetry needs no teardown of its own: the tail opens, reads, and closes
    // its descriptors inside each update, so nothing survives this call but the
    // arithmetic. Clearing the timer below is what stops the reads, and the
    // `closed` guard stops any tick already in flight.
    if (this.pollHandle !== undefined) {
      this.clearIntervalImpl(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.socket) {
      this.sendFrame('unsubscribe', { session_ids: [this.info.id] }, 'unsubscribe');
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      this.socket = undefined;
    }
    // Down for good. A closed connection opens no further socket, so anything
    // still waiting on one has to learn that from here rather than time out.
    this.socketOpen = false;
    // Nobody is looking at these cards any more, so nothing is left to retract:
    // holding the ids would only let a reconciliation that somehow ran after
    // close emit resolutions to an empty handler set.
    this.openInteractions.clear();
  }
}

/**
 * The three-state session status → the two-state RUN status the transcript
 * carries. `needs-input` is not running; the card is what says why it stopped.
 */
function runStatusOf(status: SessionInfo['status']): 'running' | 'idle' {
  return status === 'working' ? 'running' : 'idle';
}

/**
 * Size one raw frame in BYTES, or undefined when its shape cannot be sized.
 *
 * Bytes rather than `length`: a string's length counts UTF-16 code units, so a
 * CJK or emoji frame measures under a byte cap it is comfortably over — the same
 * trap the HTTP body reader and the token reader both avoid.
 */
function kimiFrameByteLength(raw: unknown): number | undefined {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return undefined;
}

/**
 * The already-measured frame as text. Only ever called for a shape
 * {@link kimiFrameByteLength} accepted, so the two stay in step: a frame that
 * was sized one way and decoded another would defeat the ceiling.
 */
function kimiFrameText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  const view = raw as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
}

function defaultSocketFactory(url: string, token: string | undefined): KimiSocketLike {
  const options = token ? { headers: { authorization: `Bearer ${token}` } } : undefined;
  return new WebSocket(url, options as never) as unknown as KimiSocketLike;
}
