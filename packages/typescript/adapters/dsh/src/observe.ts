/**
 * One attached dsh session: history seed, priming boundary, live mux passthrough,
 * projection store, queue snapshots, and the pending-prompt table.
 *
 * Shape of the attach, and why:
 *
 *  1. HISTORY FIRST, LIVE SECOND — except the broker subscribes BEFORE it reads
 *     history, so live frames can arrive while the seed is still in flight. They
 *     are buffered until the seed lands, then replayed through the SAME admit
 *     gate that history seeded. dsh numbers every event with a contiguous
 *     per-session `seq`, so the overlap is exact: dedupe is arithmetic, not a
 *     content heuristic.
 *  2. ONE ADMIT GATE. {@link DshSessionConnection.admit} is the only place a
 *     transcript event becomes a canonical row. Buffered frames, live frames,
 *     and post-reconnect frames all pass through it, so no path can bypass the
 *     dedupe.
 *  3. NO `since` REPLAY EXISTS. A reconnect cannot ask the host for what was
 *     missed, so a fresh `session/subscribed` whose `lastSeq` is ahead of what
 *     this connection admitted is proof of a gap. The honest answer is the
 *     canonical `history-reset`: the broker re-reads history wholesale rather
 *     than the connection inventing the missing middle.
 *  4. PENDING PROMPTS CONVERGE ACROSS CLIENTS. The host replays still-pending
 *     question and approval frames VERBATIM, same rpcId, on every mux open — and
 *     ONLY the still-pending ones. So a generation loss CLEARS the local pending
 *     table (each card settles as resolved-elsewhere) and lets the replay
 *     reconstruct whatever is genuinely still open; a card kept on the strength
 *     of a resolution frame that never comes — because another client answered
 *     while this one was disconnected — would be stuck forever. The same rule
 *     covers a `not-pending` answer receipt: the prompt is already settled, so
 *     the local card clears immediately instead of waiting for a replay that is
 *     not coming.
 */
import type {
  AgentMessage,
  AgentMessageHandler,
  CommandInput,
  CommandResult,
  HistoryQuery,
  ModelOption,
  ModeOption,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  SlashCommand,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import type { DshDownlinkFrame, DshRpcClient } from './server.ts';
import { DshAssistantStream } from './assistant-stream.ts';
import { DshDriver, dshModelOptions, type DshImageLimits } from './drive.ts';
import { DshLegacySessionChannel, type DshHistoryPage, type DshSessionChannel } from './protocol.ts';
import {
  createDshMapState,
  dshImageCount,
  dshUserImageArtifacts,
  dshMessageKey,
  dshProjectionMessages,
  DshProjectionStore,
  DSH_TERMINAL_SYNC_IMPOSSIBLE,
  mapDshApproval,
  mapDshEvent,
  mapDshHistory,
  mapDshQuestion,
  mapDshSession,
  type DshHistoryEntry,
  type DshMapState,
  type DshPending,
  type DshSessionEvent,
} from './mapping.ts';

/** Events per `session.history` page. The host pages backwards from the window tail. */
export const DSH_HISTORY_PAGE_MESSAGES = 200;

/** Backward paging ceiling for one seed, so an enormous session cannot become unbounded work. */
export const DSH_HISTORY_MAX_PAGES = 10;

/**
 * Frames held while the connection waits for its first
 * {@link DshSessionConnection.getHistory}, and how long it will wait.
 *
 * The caps exist only for a caller that never reads history at all. On breach
 * the buffer FLUSHES rather than being discarded: losing live rows outright is
 * worse than the bounded duplicate risk priming was protecting against, and an
 * unbounded buffer is worse than both.
 */
export const DSH_PRIMING_MAX_FRAMES = 500;
export const DSH_PRIMING_TIMEOUT_MS = 30_000;

/** Bound on remembered event seqs, so a long-lived attach cannot grow without limit. */
const ADMITTED_LIMIT = 4_000;
const ADMITTED_RETAINED = 1_000;

export const DSH_HISTORY_UNAVAILABLE_NOTICE =
  'DeepSeek Harness history could not be read right now, so no earlier messages are shown. Reattach to try again.';

export const DSH_HISTORY_PARTIAL_NOTICE =
  'DeepSeek Harness history is incomplete: reading older events failed part way through, so earlier messages are missing.';

export const DSH_HISTORY_TRUNCATED_NOTICE =
  'Older DeepSeek Harness messages are not shown: this session is longer than one bounded history read.';

export const DSH_RECONNECT_NOTICE =
  'Reconnected to the DeepSeek Harness host and reloaded this session.';

/**
 * Command names {@link DshSessionConnection.runCommand} serves LOCALLY, all
 * meaning `session.cancel`.
 *
 * These are not host registry commands — the host interrupts through
 * `session.cancel`, not through a `/stop` line — so they are answered here and
 * never composed into a command line. A host that later registers a command
 * with one of these names would be shadowed, which is why the roster below
 * filters them out rather than letting two entries collide.
 */
const DSH_LOCAL_COMMANDS: readonly string[] = Object.freeze(['stop', 'cancel', 'interrupt']);

/** The host projection carrying the permission-preset roster and current value. */
const DSH_PERMISSIONS_PROJECTION = 'permissions';

/** The host projection carrying this deployment's image-intake policy. */
const DSH_IMAGE_LIMITS_PROJECTION = 'imageLimits';

/** The registry command that switches the permission preset. */
const DSH_PERMISSION_COMMAND = 'permission';

/**
 * Map one host preset value onto the contract's universal grouping.
 *
 * The GROUPING is for copy and setup docs only; the adapter-owned `value` is
 * what actually travels, so an unrecognized preset is still perfectly usable —
 * it just carries no category rather than a guessed one. Deployments configure
 * this table themselves, so anything not matched is `custom` by definition.
 */
function dshModeCategory(value: string): ModeOption['category'] {
  switch (value) {
    case 'read-only':
      return 'ask-permission';
    case 'workspace-write':
      return 'approve-for-me';
    case 'danger-full-access':
      return 'full-access';
    default:
      return 'custom';
  }
}

export interface DshConnectionOptions {
  /**
   * The legacy transport. Kept as the default construction path so the whole
   * qualified 0.1 suite keeps exercising the real driver; a caller that supplies
   * a `channel` (the 0.2 link) does not need one.
   */
  rpc?: DshRpcClient;
  driver?: DshDriver;
  /**
   * Everything this connection reads and writes, behind one seam.
   *
   * The connection is transcript machinery, not a transport: the admit gate, the
   * priming boundary, the projection store and the pending cards were qualified
   * against a real 0.1 host and are correct for any host that can hand them the
   * same frame vocabulary and the same page-shaped history read. Both families go
   * through here, which is what lets the same connection serve a 0.2 host without
   * a second copy of that logic to keep in step.
   */
  channel?: DshSessionChannel;
  /** Injected clock, so the priming timeout is testable without real waiting. */
  now?: () => number;
  historyMaxPages?: number;
  historyPageMessages?: number;
  primingMaxFrames?: number;
  primingTimeoutMs?: number;
  /**
   * Readiness of the host link that owns this connection, checked before every
   * mutation. While the link is unverified (first probe, or re-verifying after
   * a generation loss) a write would act on host state nothing has proven, so
   * the mutation is refused rather than issued into a stale epoch. Standalone
   * connections (tests) omit it and mutate freely.
   */
  mutationReady?: () => boolean;
  /** Called once when the connection is closed, so the owner can drop its routing entry. */
  onClosed?: (sessionId: string) => void;
}

interface HistoryPage {
  events: DshHistoryEntry[];
  hasMore: boolean;
  projections?: unknown;
}

export class DshSessionConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly channel: DshSessionChannel;
  private readonly nowImpl: () => number;
  private readonly historyMaxPages: number;
  private readonly historyPageMessages: number;
  private readonly primingMaxFrames: number;
  private readonly primingTimeoutMs: number;
  private readonly mutationReady?: () => boolean;
  private readonly onClosed?: (sessionId: string) => void;

  /** Live temporal fold. History reads NEVER touch it — see getHistory. */
  private readonly state: DshMapState;
  private readonly projections = new DshProjectionStore();
  private readonly assistantStream: DshAssistantStream;
  private readonly pending = new Map<string, DshPending>();
  private readonly questionClaims = new Map<string, Promise<void>>();
  private readonly answeredContinuedCalls = new Set<string>();
  private readonly seenQueuedQuestionReplies = new Set<string>();
  /** Follow-ordered inbox fold; control projections can arrive on either side of a splice. */
  private readonly nativeInbox = new Map<string, Array<Record<string, unknown>>>();
  private readonly imageReads = new Map<string, Promise<string | undefined>>();
  private readonly imageAborts = new Set<AbortController>();
  private imageEpoch = 0;
  /** Reverse index so an `approval/resolved` frame, which names only the approvalId, finds its card. */
  private readonly approvalIndex = new Map<string, string>();

  private primed = false;
  /** This connection HAS been primed at least once — a later unprimed state is a reconnect, not the initial attach. */
  private everPrimed = false;
  private primingStartedAt?: number;
  private primingBuffer: DshDownlinkFrame[] = [];
  private admittedFloor = -1;
  private admitted = new Set<number>();
  private hostLastSeq?: number;
  private jobs: unknown[] = [];
  private closed = false;
  /** Set by `host/session-removed`: the session is gone upstream — mutations refuse, transient/control frames drop, durable transcript events still flow. */
  private removed = false;
  private archived = false;
  private unarchivedControl?: SessionInfo['control'];

  constructor(readonly info: SessionInfo, options: DshConnectionOptions) {
    if (options.channel) {
      this.channel = options.channel;
    } else {
      if (!options.rpc) throw new Error('a DeepSeek Harness connection needs either a channel or an rpc client');
      this.channel = new DshLegacySessionChannel(options.rpc, options.driver);
    }
    this.nowImpl = options.now ?? (() => Date.now());
    this.historyMaxPages = options.historyMaxPages ?? DSH_HISTORY_MAX_PAGES;
    this.historyPageMessages = options.historyPageMessages ?? DSH_HISTORY_PAGE_MESSAGES;
    this.primingMaxFrames = options.primingMaxFrames ?? DSH_PRIMING_MAX_FRAMES;
    this.primingTimeoutMs = options.primingTimeoutMs ?? DSH_PRIMING_TIMEOUT_MS;
    if (options.mutationReady) this.mutationReady = options.mutationReady;
    if (options.onClosed) this.onClosed = options.onClosed;
    this.state = createDshMapState(info.id, true);
    this.assistantStream = new DshAssistantStream(info.id);
  }

  // ── History ───────────────────────────────────────────────────────────────

  /**
   * Bounded backward read of the append-only log.
   *
   * The TAIL page — and only the tail page — carries the `projections` block,
   * one consistent cut of every projection unit as of a stated seq. That is what
   * seeds the store; later `session/projection` frames move individual keys
   * forward under higher-seq-wins.
   */
  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    const pages: DshHistoryEntry[][] = [];
    let beforeSeq: number | undefined;
    let readFailed = false;
    let pagesRead = 0;
    let reachedCeiling = false;
    let tailProjections: unknown;

    for (let page = 0; page < this.historyMaxPages; page += 1) {
      const outcome = await this.channel.history({
        sessionId: this.info.id,
        maxMessages: this.historyPageMessages,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      });
      if (!outcome.ok) {
        readFailed = true;
        break;
      }
      const entries = normalizeEntries(outcome.value?.events);
      if (pagesRead === 0) {
        tailProjections = outcome.value?.projections;
        this.projections.seed(outcome.value?.projections);
        this.reconcileContinuedQuestions();
      }
      pagesRead += 1;
      pages.unshift(entries);
      const oldest = entries[0]?.event.seq;
      if (outcome.value?.hasMore !== true || oldest === undefined || oldest === beforeSeq || oldest <= 0) break;
      beforeSeq = oldest;
      if (page === this.historyMaxPages - 1) reachedCeiling = true;
    }

    const entries = pages.flat();
    if (!this.primed && !readFailed) {
      this.nativeInbox.clear();
      const tail = tailProjections as { asOfSeq?: number; values?: { inbox?: Record<string, unknown> } } | undefined;
      const inbox = tail?.values?.inbox;
      for (const target of ['next-turn', 'next-step']) {
        const items = inbox?.[target];
        this.nativeInbox.set(target, Array.isArray(items) ? items as Array<Record<string, unknown>> : []);
      }
      for (const entry of entries) {
        if (entry.event.type === 'agent/inbox/spliced' && (entry.event.seq ?? -1) > (tail?.asOfSeq ?? -1)) this.consumeInboxSplice(entry.event, false);
      }
    }
    // Seed the admit gate from what history actually delivered, so the live tail
    // never repeats a row the reset already carried.
    for (const entry of entries) this.rememberSeq(entry.event.seq);

    // History folds through a FRESH history-local state. Folding into the live
    // state would corrupt it twice over: a second getHistory during an open
    // turn would re-see that turn's turn/start and fence the live fold's turn
    // as a cancelled predecessor, and the awaited page loop would interleave
    // live frames with the replay on shared accumulators.
    const historyState = createDshMapState(this.info.id, false);
    // Echo correlation is connection-level, not per-fold: prompts THIS adapter
    // sent resolve their clientKey on history rows exactly as on live frames.
    historyState.clientKeys = this.state.clientKeys;
    const messages = mapDshHistory(entries, historyState);
    // Readback is authorized upstream against the session log. The broker's
    // existing artifact store promotes these bounded inline bytes to its own
    // credentialed fetch URLs; no DSH cookie or private endpoint reaches clients.
    const imageBudget = { remaining: 16 };
    for (const entry of [...entries].reverse()) messages.push(...await this.imageArtifacts(entry.event, imageBudget));

    // Only a priming read (initial attach, or the wholesale re-read after a
    // reconnect gap) seeds the live fold, and only when the read SUCCEEDED. A
    // ceiling-truncated read still qualifies: its snapshot is bounded, not
    // complete, but it describes the open turn the buffered frames continue —
    // and the truncation notice below tells the client the window was cut. A
    // late read by another client must not move the live fold at all.
    if (!this.primed && !readFailed) {
      this.state.seedThroughSeq = historyState.seedThroughSeq;
      for (const [callId, name] of historyState.toolNames) {
        if (!this.state.toolNames.has(callId)) this.state.toolNames.set(callId, name);
      }
      const open = historyState.openTurn;
      this.state.openTurn = open === undefined ? undefined : {
        ...open,
        stepStarts: new Map(open.stepStarts),
        openCalls: new Map(open.openCalls),
        usage: new Map(open.usage),
      };
    }

    // History has now seeded the gate, so anything the socket delivered during
    // the attach window can be released without duplicating this reset.
    this.prime();

    if (readFailed && pagesRead === 0) return [{ type: 'notice', message: DSH_HISTORY_UNAVAILABLE_NOTICE }];
    if (readFailed) return [{ type: 'notice', message: DSH_HISTORY_PARTIAL_NOTICE }, ...messages];
    if (reachedCeiling) return [{ type: 'notice', message: DSH_HISTORY_TRUNCATED_NOTICE }, ...messages];
    return messages;
  }

  /**
   * Current-state overlays: everything the projection store holds and this build
   * has a named consumer for. Unknown keys stay in the store and are readable
   * through {@link projectionKeys}; they are never forwarded as raw values,
   * because a plugin's payload shape is not part of the shared protocol.
   */
  async getHistoryOverlays(_query?: HistoryQuery): Promise<AgentMessage[]> {
    const rows: AgentMessage[] = [];
    const imageBudget = { remaining: 16 };
    for (const key of this.projections.keys()) {
      rows.push(...dshProjectionMessages(key, this.projections.get(key), { forkedChild: this.info.parentThreadId !== undefined }));
    }
    for (const items of this.nativeInbox.values()) {
      for (const message of items) {
        const source = message.source as { kind?: string } | undefined;
        if (source?.kind !== 'user') continue;
        const id = typeof message.id === 'string' ? message.id : undefined;
        const text = dshQueueText(message.content);
        const imageCount = dshImageCount(message.content);
        if (id && (text || imageCount)) rows.push({ type: 'user-message', key: dshMessageKey(this.info.id, id), text, queued: true, ...(imageCount ? { imageCount } : {}) });
        if (imageCount) rows.push(...await this.imageArtifacts({ type: 'user/message', data: message }, imageBudget));
      }
    }
    return [...rows, ...this.assistantStream.messages()];
  }

  /** Pending question and approval cards, replayed after history on attach. */
  getPending(): AgentMessage[] {
    return [...this.pending.values()].map((entry) => entry.message);
  }

  // ── Subscription ──────────────────────────────────────────────────────────

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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

  // ── Priming boundary ──────────────────────────────────────────────────────

  /**
   * Route one mux frame for this session.
   *
   * Transcript events and assistant attempts wait for priming: they are the
   * rows history also delivers, so releasing them early is the duplicate risk
   * the buffer exists to prevent. Every other frame type is safe immediately —
   * projections are seq-guarded, queue/jobs are authoritative whole snapshots,
   * and prompt frames dedupe by rpcId — and several are control signals
   * (`session/subscribed` above all) whose whole purpose is to be seen NOW:
   * buffering the subscribe would delay reconnect gap detection by the priming
   * timeout.
   */
  handleMuxFrame(frame: DshDownlinkFrame): void {
    if (this.closed) return;
    // Removal is terminal for TRANSIENT and CONTROL state — prompts, queue,
    // jobs, subscribe, projections: admitting a delayed question frame after
    // host/session-removed would recreate a card that is permanently
    // unanswerable on a session the host no longer owns. But NOT for durable
    // transcript events: the mux and host streams have no cross-stream
    // ordering, so a session/event emitted BEFORE the removal may be DELIVERED
    // after it, and dropping it would lose a final user or assistant message
    // permanently. Those still pass the seq admit gate, so a genuinely
    // duplicated event cannot double-render.
    if (this.removed && frame.frameType !== 'session/event') return;
    if (!this.primed && ['session/event', 'session/assistant-frame', 'session/assistant-baseline'].includes(frame.frameType)) {
      this.primingStartedAt ??= this.nowImpl();
      const overflowed = this.primingBuffer.length >= this.primingMaxFrames
        || this.nowImpl() - this.primingStartedAt >= this.primingTimeoutMs;
      if (!overflowed) {
        this.primingBuffer.push(frame);
        return;
      }
      // Cap breached: a caller that never reads history must not cost live rows.
      this.prime();
    }
    this.consumeMuxFrame(frame);
  }

  /** Open the gate and replay whatever was buffered. Idempotent. */
  private prime(): void {
    if (this.primed) return;
    this.primed = true;
    this.everPrimed = true;
    const buffered = this.primingBuffer;
    this.primingBuffer = [];
    this.primingStartedAt = undefined;
    for (const frame of buffered) this.consumeMuxFrame(frame);
  }

  /**
   * The single admit gate for transcript events. Returns false for anything this
   * connection already delivered — history seed included.
   */
  private admit(seq: unknown): boolean {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
    if (seq <= this.admittedFloor) return false;
    if (this.admitted.has(seq)) return false;
    this.rememberSeq(seq);
    return true;
  }

  private rememberSeq(seq: unknown): void {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
    this.admitted.add(seq);
    if (this.admitted.size <= ADMITTED_LIMIT) return;
    // Seqs are contiguous and ascending, so raising the floor is lossless.
    let highest = this.admittedFloor;
    for (const value of this.admitted) if (value > highest) highest = value;
    const floor = highest - ADMITTED_RETAINED;
    for (const value of this.admitted) if (value <= floor) this.admitted.delete(value);
    this.admittedFloor = floor;
  }

  // ── Frame handling ────────────────────────────────────────────────────────

  private consumeMuxFrame(frame: DshDownlinkFrame): void {
    const payload = frame.payload;
    switch (frame.frameType) {
      case 'session/assistant-baseline': {
        for (const message of this.assistantStream.baseline(payload.value)) this.deliver(message);
        return;
      }
      case 'session/assistant-frame': {
        for (const message of this.assistantStream.frame(payload.value)) this.deliver(message);
        return;
      }
      case 'session/event': {
        const event = payload.event as DshSessionEvent | undefined;
        if (!event || typeof event.type !== 'string') return;
        if (!this.admit(event.seq)) return;
        if (event.type === 'assistant/message') {
          const data = event.data as { turn?: unknown; step?: unknown } | undefined;
          this.assistantStream.settle(data?.turn, data?.step);
        }
        if (event.type === 'agent/inbox/spliced') this.consumeInboxSplice(event);
        const entry: DshHistoryEntry = { event, ...(payload.view !== undefined ? { view: payload.view } : {}) };
        // A live surface REPLACE rewrites transcript the client already holds.
        // Only a wholesale reload can make rows disappear, so say so rather than
        // appending a summary beside the text it was meant to shadow.
        if (isReplaceOp(event)) {
          this.deliver({ type: 'history-reset', semantic: { kind: 'compaction' } });
          return;
        }
        for (const message of mapDshEvent(entry, this.state)) this.deliver(message);
        const epoch = this.imageEpoch;
        void this.imageArtifacts(event).then((images) => {
          if (this.closed || this.imageEpoch !== epoch) return;
          for (const image of images) this.deliver(image);
        });
        return;
      }
      case 'session/subscribed': {
        const lastSeq = typeof payload.lastSeq === 'number' ? payload.lastSeq : undefined;
        this.hostLastSeq = lastSeq;
        // On the INITIAL attach this frame precedes the broker's first history
        // read, so a "gap" against an empty admit set proves nothing — the read
        // that is already coming will seed everything. After that first prime,
        // the frame is the reconnect baseline: no `since` replay exists, so a
        // tail ahead of what this connection admitted is a proven gap and the
        // canonical `history-reset` makes the broker re-read wholesale (the
        // re-read primes the gate again). A tail NOT ahead proves nothing was
        // missed, and the connection re-primes itself — the admit gate already
        // holds every delivered seq, so releasing the buffer cannot duplicate.
        if (!this.everPrimed || lastSeq === undefined) return;
        // A tail BEHIND delivered state proves a RESTARTED host (log seqs only
        // move forward within one generation). Rollback retracts everything the
        // previous generation delivered:
        //  - projection rows beyond the tail are dropped, and truncate says
        //    whether any were — a dropped row was already DELIVERED (a title,
        //    runtimeTotals), so its message must be retracted too;
        //  - transcript rows beyond the tail are equally stale, and the new
        //    host will REUSE those seqs, so the admit gate rewinds to the tail
        //    (a replayed seq 21 is new content, not a duplicate);
        //  - the wholesale history-reset makes the broker re-read, replacing
        //    what clients show.
        const truncated = this.projections.truncate(lastSeq);
        if (lastSeq < this.highestAdmitted() || truncated) {
          this.rewindAdmitGate(lastSeq);
          this.primed = false;
          this.deliver({ type: 'history-reset', notice: DSH_RECONNECT_NOTICE });
        } else if (lastSeq > this.highestAdmitted()) {
          this.primed = false;
          this.deliver({ type: 'history-reset', notice: DSH_RECONNECT_NOTICE });
        } else if (!this.primed) {
          this.prime();
        }
        return;
      }
      case 'session/projection-baseline': {
        const before = new Set(this.projections.keys());
        const adopted = this.projections.seed(payload.block);
        if ([...before].some((key) => !this.projections.keys().includes(key))) this.deliver({ type: 'history-reset' });
        this.reconcileContinuedQuestions();
        for (const key of adopted) for (const message of dshProjectionMessages(key, this.projections.get(key), { forkedChild: this.info.parentThreadId !== undefined })) this.deliver(message);
        return;
      }
      case 'session/projection': {
        const key = typeof payload.key === 'string' ? payload.key : '';
        const seq = typeof payload.seq === 'number' ? payload.seq : 0;
        if (!key || !this.projections.apply(key, payload.value, seq)) return;
        if (key === 'userQuestions' || key === 'inbox') this.reconcileContinuedQuestions();
        for (const message of dshProjectionMessages(key, payload.value, { forkedChild: this.info.parentThreadId !== undefined })) {
          this.deliver(message);
        }
        return;
      }
      case 'session/queue': {
        this.deliverQueue(payload.items);
        return;
      }
      case 'session/jobs': {
        // Authoritative whole snapshot, held rather than rendered: the canonical
        // agent-activity card describes subagents and workflows, and calling a
        // background bash job one of those would misreport what it is. Round 1
        // keeps the snapshot readable and adds no invented row.
        this.jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        return;
      }
      case 'approval/requested': {
        const mapped = mapDshApproval(frame.rpcId, payload);
        if (!mapped || this.pending.has(mapped.rpcId)) return; // replay of a card already shown
        this.pending.set(mapped.rpcId, mapped);
        this.approvalIndex.set(mapped.approvalId, mapped.rpcId);
        this.deliver(mapped.message);
        return;
      }
      case 'approval/resolved': {
        const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
        const rpcId = this.approvalIndex.get(approvalId);
        if (!rpcId) return;
        this.approvalIndex.delete(approvalId);
        this.pending.delete(rpcId);
        const outcome = payload.outcome;
        const decision: PermissionDecision | 'external' = outcome === 'allowed-once'
          ? 'approve'
          : outcome === 'rejected' ? 'reject' : 'external';
        this.deliver({ type: 'permission-resolved', requestId: rpcId, decision });
        return;
      }
      case 'question/requested': {
        const mapped = mapDshQuestion(frame.rpcId, payload);
        if (!mapped || this.pending.has(mapped.rpcId)) return; // replay of a card already shown
        this.pending.set(mapped.rpcId, mapped);
        this.deliver(mapped.message);
        return;
      }
      case 'question/resolved': {
        const rpcId = typeof payload.questionRpcId === 'string' ? payload.questionRpcId : '';
        if (!rpcId || !this.pending.delete(rpcId)) return;
        this.deliver({ type: 'question-resolved', requestId: rpcId });
        return;
      }
      default:
        // Unknown mux frame types are the union growing, not a fault. The owner
        // records a contained diagnostic; the session just does not render them.
        return;
    }
  }

  /** Host-stream frames addressed to this session. */
  handleHostFrame(frame: DshDownlinkFrame): void {
    // Removal is terminal here too: a late host/session-status must not relatch
    // the session as working after the host already said it is gone.
    if (this.closed || this.removed) return;
    switch (frame.frameType) {
      case 'host/session-workspace': {
        const archived = frame.payload.archived === true;
        if (archived !== this.archived) {
          if (archived) this.unarchivedControl = this.info.control;
          this.archived = archived;
          this.info.control = archived ? this.archivedControl() : this.unarchivedControl;
          if (archived) this.info.status = 'idle';
          this.deliver({ type: 'notice', message: archived
            ? 'This session was archived in DeepSeek Harness. Its durable history remains available.'
            : 'This session was unarchived in DeepSeek Harness.' });
        }
        const value = { ...(this.info.control ? { control: this.info.control } : {}),
          ...(archived ? { status: 'idle' as const } : {}),
          ...(typeof frame.payload.projectName === 'string' ? { projectName: frame.payload.projectName } : {}),
          ...(typeof frame.payload.cwd === 'string' ? { cwd: frame.payload.cwd } : {}) };
        Object.assign(this.info, value);
        this.deliver({ type: 'metadata-update', key: 'sessionInfo', value });
        if (archived) this.deliver({ type: 'status', status: 'idle' });
        return;
      }
      case 'host/session-activity': {
        if (typeof frame.payload.updatedAt !== 'number') return;
        this.info.updatedAt = frame.payload.updatedAt;
        this.deliver({ type: 'metadata-update', key: 'sessionInfo', value: { updatedAt: frame.payload.updatedAt } }); return;
      }
      case 'host/service-notice': {
        if (typeof frame.payload.message === 'string') this.deliver({ type: 'notice', message: frame.payload.message }); return;
      }
      case 'host/session-updated': {
        const summary = frame.payload.summary as Parameters<typeof mapDshSession>[0] & { agentAvailable?: boolean };
        // rc.2 commands resolve/resume an ordinary cold Agent themselves.
        const mapped = mapDshSession(summary);
        if (!mapped || mapped.id !== this.info.id) return;
        this.unarchivedControl = mapped.control;
        const value = { control: this.archived ? this.archivedControl() : mapped.control, status: this.archived ? 'idle' as const : mapped.status,
          ...(mapped.cwd ? { cwd: mapped.cwd } : {}),
          ...(mapped.currentModel ? { currentModel: mapped.currentModel, model: mapped.model } : {}),
          ...(mapped.updatedAt !== undefined ? { updatedAt: mapped.updatedAt } : {}) };
        Object.assign(this.info, value);
        this.deliver({ type: 'metadata-update', key: 'sessionInfo', value });
        this.deliver({ type: 'status', status: !this.archived && summary.running === true ? 'running' : 'idle' });
        return;
      }
      case 'host/session-status': {
        const running = !this.archived && frame.payload.running === true;
        this.info.status = running ? 'working' : this.pending.size > 0 ? 'needs-input' : 'idle';
        this.deliver({ type: 'status', status: running ? 'running' : 'idle' });
        return;
      }
      case 'host/agent-error': {
        const message = typeof frame.payload.message === 'string' ? frame.payload.message : 'The agent reported an error.';
        this.deliver({ type: 'error', message });
        return;
      }
      case 'host/session-removed': {
        // The session is GONE upstream, and the truth must become consistent in
        // one step: later mutations refuse (assertMutable) and late frames are
        // dropped (removal is terminal above); pending cards settle (no
        // resolution frame will ever arrive for them); the session no longer
        // claims to be working — the canonical idle status clears the hub's
        // live-running latch; and the roster stops claiming Drive authority.
        // The broker merges a sessionInfo metadata-update into SessionInfo and
        // rebroadcasts it, so emitting one retracts both states instead of
        // leaving the UI offering clicks that all fail.
        this.removed = true;
        this.settlePendingAsExternal();
        this.info.status = 'idle';
        const drive = {
          state: 'unavailable' as const,
          supported: false,
          reason: 'This session was removed from the DeepSeek Harness host.',
        };
        const control = this.info.control
          ? { ...this.info.control, drive }
          : { drive, terminalSync: DSH_TERMINAL_SYNC_IMPOSSIBLE };
        this.info.control = control;
        this.deliver({ type: 'metadata-update', key: 'sessionInfo', value: { control, status: 'idle' } });
        this.deliver({ type: 'status', status: 'idle' });
        this.deliver({ type: 'notice', message: 'This session was removed from the DeepSeek Harness host.' });
        return;
      }
      default:
        return;
    }
  }

  /**
   * The host withdrew a pending approval or question by id.
   *
   * 0.2 says only "this event id is cancelled", with no statement of which kind
   * it was, so the connection decides from the card it is actually holding. A
   * resolved frame of the wrong kind would be worse than nothing: a question
   * settled with a `permission-resolved` leaves the question card on screen while
   * telling the broker the interaction is over.
   */
  noteCancellation(eventId: string): void {
    const entry = this.pending.get(eventId);
    if (!entry) return;
    this.pending.delete(eventId);
    if (entry.kind === 'approval') {
      this.approvalIndex.delete(entry.approvalId);
      this.deliver({ type: 'permission-resolved', requestId: eventId, decision: 'external' });
      return;
    }
    this.deliver({ type: 'question-resolved', requestId: eventId });
  }

  /**
   * The transient inbox, as an authoritative whole snapshot. Queued and steering
   * items render as dimmed user bubbles; `context` items are invisible until the
   * agent claims them, exactly as the host describes.
   *
   * The bubble key is the native MESSAGE id, which is also what the durable
   * `user/message` event carries — so when the agent claims the item, the
   * durable row replaces the queued one in place instead of doubling it.
   *
   * Legacy-only gap: a queued item DELETED via another client
   * (`session.updateQueue` from the dsh browser UI) vanishes from the next
   * snapshot without any durable row claiming its key, and the canonical
   * vocabulary has no "remove this bubble" message — so the dimmed bubble goes
   * stale until the next history reset. Diffing snapshots and forcing a reset on
   * vanish is NOT safe: on a normal claim the empty snapshot races the durable
   * `user/message` frame, and losing that race would reset the thread on every
   * prompt. Needs either a canonical queue-item-removed message or a
   * claim-correlated grace window; deferred with the rest of the queue-mutation
   * surface.
   */
  private deliverQueue(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { id?: unknown; placement?: unknown; message?: unknown };
      if (item.placement !== 'queued' && item.placement !== 'steering') continue;
      const id = typeof item.id === 'string' ? item.id : undefined;
      const message = item.message as { content?: unknown } | undefined;
      const text = dshQueueText(message?.content);
      if (!id || !text) continue;
      this.deliver({ type: 'user-message', text, key: dshMessageKey(this.info.id, id), queued: true });
    }
  }

  // ── Generation lifecycle ──────────────────────────────────────────────────

  /**
   * The downlink generation ended. Everything derived from it is stale, so the
   * connection re-enters priming and waits for the fresh subscribe.
   *
   * Pending prompts are CLEARED, not kept: the host replays only STILL-pending
   * prompts on the next mux open, so a prompt another client settled while this
   * connection was disconnected would never send a resolution frame and its
   * card would hang forever. Clearing settles each card as resolved-elsewhere;
   * the verbatim replay then reconstructs the prompts that genuinely remain.
   */
  onGenerationLost(): void {
    if (this.closed) return;
    this.onTranscriptLost();
    this.projections.clear();
    this.resetImageReads();
    this.assistantStream.baseline({ revision: 0 });
    this.settlePendingAsExternal(true);
  }

  /** A follow baseline ended while the independent event authority survives. */
  onTranscriptLost(): void {
    if (this.closed) return;
    this.primed = false;
    this.primingStartedAt = undefined;
  }

  /**
   * Settle every pending card as resolved-elsewhere and empty the tables.
   * Shared by generation loss and session removal: in both cases the prompts
   * this connection tracks are unverifiable or gone, and no resolution frame
   * is coming for them.
   */
  private settlePendingAsExternal(preserveContinued = false): void {
    for (const entry of this.pending.values()) {
      if (preserveContinued && entry.kind === 'question' && entry.continued) continue;
      if (entry.kind === 'approval') {
        this.deliver({ type: 'permission-resolved', requestId: entry.rpcId, decision: 'external' });
      } else {
        this.deliver({ type: 'question-resolved', requestId: entry.rpcId });
      }
      this.pending.delete(entry.rpcId);
    }
    this.approvalIndex.clear();
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  /**
   * The one guard every write passes. Two refusals: the host said the session
   * is gone, or the owning link has not verified the current generation (a
   * write issued into an unverified or stale epoch could act on host state
   * nothing has proven).
   */
  private assertMutable(action: string): void {
    if (this.removed) {
      throw new Error(`cannot ${action}: this session was removed from the DeepSeek Harness host`);
    }
    if (this.archived || this.info.control?.drive.supported === false) {
      throw new Error(`cannot ${action}: ${this.info.control?.drive.reason ?? 'this DeepSeek Harness agent is unavailable'}`);
    }
    if (this.mutationReady && !this.mutationReady()) {
      throw new Error(`cannot ${action}: the DeepSeek Harness host link is re-verifying; retry in a moment`);
    }
  }

  private archivedControl(): NonNullable<SessionInfo['control']> {
    return { ...(this.unarchivedControl ?? this.info.control ?? { terminalSync: DSH_TERMINAL_SYNC_IMPOSSIBLE }),
      drive: { state: 'unavailable', supported: false, reason: 'This session is archived in DeepSeek Harness; unarchive it in the native client first.' } };
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    await this.submitPrompt(input, 'queue');
  }

  private async submitPrompt(input: PromptInput, mode: 'queue' | 'steer'): Promise<void> {
    this.assertMutable(mode === 'steer' ? 'steer the running turn' : 'send a prompt');
    // Selectors FIRST. dsh has no per-prompt model or permission field, so a
    // "per-prompt override" is really two durable session changes followed by a
    // send. Ordering is not cosmetic: a prompt that raced ahead of its own
    // selectors would run under the previous model or the previous permission
    // preset — silently, and with the UI showing the new one.
    await this.applyModelSelection(input.model);
    await this.applyPermissionMode(input.permissionMode);
    const clientMessageId = input.clientMessageId;
    // Re-guarded after the selectors, because both of them AWAIT. A guard taken
    // before a wait proves nothing about the moment after it: the generation
    // can be lost while a catalog read or a switch command is parked, and this
    // send would then land on an epoch nothing has re-baselined.
    this.assertMutable('send a prompt');
    await this.channel.prompt(this.info.id, input, {
      mode,
      imageLimits: this.imageLimits(),
      ...(this.info.cwd ? { sessionCwd: this.info.cwd } : {}),
      ...(clientMessageId
        ? { onRpcId: (rpcId: string) => this.state.clientKeys.set(rpcId, clientMessageId) }
        : {}),
    });
  }

  /** This deployment's published image policy, or undefined when none is composed. */
  private imageLimits(): DshImageLimits | undefined {
    const value = this.projections.get(DSH_IMAGE_LIMITS_PROJECTION);
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    const num = (key: string): number | undefined =>
      typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : undefined;
    const types = Array.isArray(row.mediaTypes)
      ? row.mediaTypes.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    return {
      ...(num('maxImageBytes') !== undefined ? { maxImageBytes: num('maxImageBytes') } : {}),
      ...(num('maxImagesPerMessage') !== undefined ? { maxImagesPerMessage: num('maxImagesPerMessage') } : {}),
      ...(num('maxMessageImageBytes') !== undefined ? { maxMessageImageBytes: num('maxMessageImageBytes') } : {}),
      ...(types && types.length > 0 ? { mediaTypes: types } : {}),
    };
  }

  /**
   * Apply a prompt or command model override as a session selection.
   *
   * Skipped entirely when the request already matches what the session runs,
   * so an unchanged picker costs no write at all — which is what keeps an
   * ordinary send a single RPC.
   */
  private async applyModelSelection(model: PromptInput['model']): Promise<void> {
    if (!model) return;
    this.assertMutable('select a model');
    const catalog = await this.channel.models(this.info.id);
    const wanted = {
      provider: model.providerID,
      model: model.modelID,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    };
    const current = catalog.current;
    if (
      current
      && current.provider === wanted.provider
      && current.model === wanted.model
      && (current.reasoningEffort ?? undefined) === (wanted.reasoningEffort ?? undefined)
    ) {
      return;
    }
    // The catalog read above AWAITED. Re-guard before the write it authorized:
    // the generation may have ended while that request was parked, and a
    // selection is durable session state, not a retryable read.
    this.assertMutable('select a model');
    await this.channel.selectModel(this.info.id, wanted);
  }

  /**
   * Apply a prompt or command permission mode by running the host's own switch command.
   *
   * Validated against the LIVE roster before anything is sent, for two
   * different reasons. The value must be one the host advertised — an
   * unadvertised preset is a caller bug and composing it into a command line
   * would hand the host free text. And the switch itself must exist: a
   * deployment that composes no permission service publishes no `permissions`
   * projection and registers no `permission` command, and silently skipping the
   * switch there would run the turn under the wrong policy.
   */
  private async applyPermissionMode(mode: string | undefined): Promise<void> {
    if (mode === undefined) return;
    this.assertMutable('select a permission mode');
    const select = await this.permissionSelect();
    if (!select) {
      throw new Error(
        'this DeepSeek Harness deployment composes no permission service, so it has no permission mode to select',
      );
    }
    if (!select.options.some((option) => option.value === mode)) {
      throw new Error(`the DeepSeek Harness host does not offer the permission mode "${mode}"`);
    }
    if (select.currentValue === mode) return;
    const roster = await this.channel.listCommands(this.info.id);
    if (!roster.some((command) => command.name === DSH_PERMISSION_COMMAND)) {
      throw new Error(
        'this DeepSeek Harness host advertises permission modes but no command to switch them, so the mode was not changed',
      );
    }
    // The roster read above AWAITED. Re-guard before the switch it authorized —
    // a permission preset is durable session state, and applying one on a lost
    // generation would change how the session approves tools while this
    // connection no longer speaks for it.
    this.assertMutable('select a permission mode');
    const execution = await this.channel.executeCommand(this.info.id, `/${DSH_PERMISSION_COMMAND} ${mode}`);
    if (execution?.result.kind === 'error') {
      throw new Error(
        execution.result.text
          ? `the DeepSeek Harness host refused the permission mode "${mode}": ${execution.result.text}`
          : `the DeepSeek Harness host refused the permission mode "${mode}"`,
      );
    }
  }

  /**
   * The presets this session can be switched to, and the one it is on.
   *
   * Two sources, because the captured build splits them across two routes: the
   * per-session `permissions` projection carries the CURRENT value, and the
   * roster of what may be chosen lives on a host-wide catalog endpoint. Reading
   * only the projection gives a picker with a selection and no choices, and a
   * selector that validates a request against that picker then refuses the
   * preset the session is already running. Reading only the catalog would offer
   * the host's DEFAULT preset as though the session had said so.
   *
   * The catalog read is bounded by the link's per-carrier cache, so a picker
   * that re-renders does not re-request it; an unavailable roster returns
   * undefined rather than a guessed one.
   */
  private async permissionSelect(): Promise<{ options: ModeOption[]; currentValue: string } | undefined> {
    const fromProjection = this.permissionProjection();
    // A projection that carries its own roster is self-describing, which is what
    // the 0.1 family does. Trust it and ask the host nothing.
    if (fromProjection && fromProjection.options.length > 0) return fromProjection;
    const catalog = await this.channel.permissionCatalog?.();
    if (!catalog || catalog.options.length === 0) return undefined;
    const options: ModeOption[] = catalog.options.map((option) => ({
      value: option.value,
      label: option.name && option.name.length > 0 ? option.name : option.value,
      ...(option.description ? { description: option.description } : {}),
      category: dshModeCategory(option.value),
    }));
    // The session's own value outranks the catalog's default, and a current
    // preset the catalog does not list is still listed: hiding the state a
    // session is actually in is how a picker ends up showing the wrong thing
    // as the one the user chose.
    const currentValue = fromProjection?.currentValue ?? '';
    if (currentValue && !options.some((option) => option.value === currentValue)) {
      options.push({ value: currentValue, label: currentValue, category: dshModeCategory(currentValue) });
    }
    return { options, currentValue };
  }

  /** The roster and current value the `permissions` projection itself carries. */
  private permissionProjection(): { options: ModeOption[]; currentValue: string } | undefined {
    const value = this.projections.get(DSH_PERMISSIONS_PROJECTION);
    if (!value || typeof value !== 'object') return undefined;
    const row = value as { options?: unknown; currentValue?: unknown };
    const options: ModeOption[] = [];
    if (Array.isArray(row.options)) {
      for (const entry of row.options) {
        if (!entry || typeof entry !== 'object') continue;
        const option = entry as { value?: unknown; name?: unknown; description?: unknown };
        if (typeof option.value !== 'string' || option.value.length === 0) continue;
        options.push({
          value: option.value,
          label: typeof option.name === 'string' && option.name ? option.name : option.value,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
          category: dshModeCategory(option.value),
        });
      }
    }
    const currentValue = typeof row.currentValue === 'string' ? row.currentValue : '';
    if (options.length === 0 && currentValue === '') return undefined;
    return { options, currentValue };
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertMutable('answer an approval');
    if (decision === 'approve-rule') {
      throw new Error('dsh does not support persistent approval rules through this connection');
    }
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'approval') {
      throw new Error(`dsh approval ${requestId} is no longer pending`);
    }
    const receipt = await this.channel.respondApproval(entry, decision !== 'reject');
    // The receipt reason is one of exactly two (the decoder fails anything
    // else closed as drift). `bad-response`: OUR payload was malformed, the
    // card is still pending on the host, and swallowing it would leave the
    // user staring at a prompt that silently ignored their click — throw and
    // KEEP the card. `not-pending`: the only receipt that PROVES another
    // client settled the prompt, so the card clears now as settled elsewhere
    // rather than waiting for a resolved frame that may never arrive (the
    // reconnect replay carries only still-pending prompts).
    if (!receipt.accepted && receipt.reason === 'bad-response') {
      throw new Error(`the dsh host rejected the approval answer for ${requestId} as malformed`);
    }
    // A successful receipt is also a settlement. The event cancellation can
    // arrive after the receipt; deleting silently here would strand the UI
    // card because that cancellation then finds no entry. Identity fences a
    // replayed card from a replacement event generation.
    if (this.pending.get(requestId) === entry) {
      this.pending.delete(requestId);
      this.approvalIndex.delete(entry.approvalId);
      this.deliver({ type: 'permission-resolved', requestId, decision: receipt.accepted ? decision : 'external' });
    }
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const claimed = this.questionClaims.get(requestId);
    if (claimed) return claimed;
    const operation = this.answerQuestionOnce(requestId, answers);
    this.questionClaims.set(requestId, operation);
    try { await operation; } finally {
      if (this.questionClaims.get(requestId) === operation) this.questionClaims.delete(requestId);
    }
  }

  private async answerQuestionOnce(requestId: string, answers: string[][]): Promise<void> {
    this.assertMutable('answer a question');
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'question') {
      throw new Error(`dsh question ${requestId} is no longer pending`);
    }
    const receipt = await this.channel.answerQuestion(entry, answers);
    // Same receipt discipline as respondPermission: `bad-response` throws and
    // keeps the card; `not-pending` — the only other reason the decoder admits
    // — settles the card as resolved-elsewhere.
    if (!receipt.accepted && receipt.reason === 'bad-response') {
      throw new Error(`the dsh host rejected the question answer for ${requestId} as malformed`);
    }
    if (entry.continued && entry.callId) this.answeredContinuedCalls.add(entry.callId);
    if (this.pending.get(requestId) === entry) {
      this.pending.delete(requestId);
      this.deliver({ type: 'question-resolved', requestId });
    }
  }

  /** Continued questions survive the event generation; their durable projection
   * and queued-reply inbox determine whether they can be answered again. */
  private reconcileContinuedQuestions(): void {
    const value = this.projections.get('userQuestions') as { active?: unknown[] } | undefined;
    if (value && !Array.isArray(value.active)) return;
    const inbox = this.projections.get('inbox') as Record<string, unknown> | undefined;
    const queued = new Set<string>();
    for (const target of ['next-turn', 'next-step']) {
      const items = inbox?.[target];
      for (const raw of Array.isArray(items) ? items : []) {
        const source = (raw as { source?: { kind?: string; callId?: string } })?.source;
        if (source?.kind === 'user-question-reply' && typeof source.callId === 'string') queued.add(source.callId);
      }
    }
    for (const callId of queued) this.seenQueuedQuestionReplies.add(callId);
    for (const callId of this.seenQueuedQuestionReplies) if (!queued.has(callId)) this.seenQueuedQuestionReplies.delete(callId);
    const active = new Map<string, { callId: string; questions: unknown[] }>();
    for (const raw of value?.active ?? []) {
      const q = raw as { callId?: unknown; state?: unknown; questions?: unknown };
      if (q?.state === 'continued' && typeof q.callId === 'string' && Array.isArray(q.questions)) active.set(q.callId, { callId: q.callId, questions: q.questions });
    }
    for (const [id, entry] of this.pending) {
      if (entry.kind !== 'question' || !entry.continued || !entry.callId) continue;
      if (active.has(entry.callId) && !queued.has(entry.callId)) continue;
      this.pending.delete(id);
      this.deliver({ type: 'question-resolved', requestId: id });
    }
    for (const callId of this.answeredContinuedCalls) if (!active.has(callId)) this.answeredContinuedCalls.delete(callId);
    for (const q of active.values()) {
      if (queued.has(q.callId) || this.answeredContinuedCalls.has(q.callId)) continue;
      // A projected transition can precede the waterfall cancellation. Retire
      // that generation-bound card before exposing the durable answer route.
      for (const [id, entry] of this.pending) {
        if (entry.kind === 'question' && entry.callId === q.callId && !entry.continued) this.noteCancellation(id);
      }
      const id = `dsh-question:${this.info.id}:${q.callId}`;
      if (this.pending.has(id)) continue;
      const entry = mapDshQuestion(id, { sessionId: this.info.id, callId: q.callId, questions: q.questions, continued: true });
      if (!entry) continue;
      this.pending.set(id, entry);
      this.deliver(entry.message);
    }
  }

  private consumeInboxSplice(event: DshSessionEvent, live = true): void {
    const data = event.data as { target?: string; start?: number; removedCount?: number; inserted?: unknown[]; outcome?: string } | undefined;
    if (!data || !['next-turn', 'next-step'].includes(data.target ?? '') || !Number.isSafeInteger(data.start)
        || !Array.isArray(data.inserted)) return;
    const target = data.target!;
    const items = [...(this.nativeInbox.get(target) ?? [])];
    const start = data.start!; const count = data.removedCount ?? 0;
    if (start < 0 || start > items.length || !Number.isSafeInteger(count) || count < 0 || start + count > items.length) {
      if (live) this.deliver({ type: 'history-reset' }); return;
    }
    const inserted = data.inserted.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object' && !Array.isArray(m));
    const removed = items.splice(start, count, ...inserted);
    this.nativeInbox.set(target, items);
    for (const message of removed) {
      const source = message.source as { kind?: string; callId?: string } | undefined;
      if (source?.kind !== 'user-question-reply' || !source.callId) continue;
      if (data.outcome === 'canceled') this.answeredContinuedCalls.delete(source.callId);
      else this.answeredContinuedCalls.add(source.callId);
    }
    // A canceled splice is explicit deletion/edit, distinct from a claim. The
    // canonical history reset retracts old bubbles and rebuilds queued overlays.
    if (live && data.outcome === 'canceled' && removed.length) this.deliver({ type: 'history-reset' });
    for (const message of inserted) {
      const source = message.source as { kind?: string } | undefined;
      const text = dshQueueText(message.content); const id = typeof message.id === 'string' ? message.id : undefined;
      const imageCount = dshImageCount(message.content);
      if (live && source?.kind === 'user' && (text || imageCount) && id) this.deliver({ type: 'user-message', key: dshMessageKey(this.info.id, id), text, queued: true, ...(imageCount ? { imageCount } : {}) });
      if (live && imageCount && source?.kind === 'user') {
        const epoch = this.imageEpoch;
        void this.imageArtifacts({ type: 'user/message', data: message }).then((rows) => {
          if (!this.closed && epoch === this.imageEpoch) for (const row of rows) this.deliver(row);
        });
      }
    }
    if (live) this.reconcileContinuedQuestions();
  }

  private async imageArtifacts(event: Pick<DshSessionEvent, 'type' | 'data'>, budget?: { remaining: number }): Promise<AgentMessage[]> {
    if (!this.channel.attachment) return [];
    const rows: AgentMessage[] = [];
    const epoch = this.imageEpoch;
    for (const ref of dshUserImageArtifacts(event, this.info.id)) {
      if (budget && budget.remaining-- <= 0) {
        if (budget.remaining === -1) rows.push({ type: 'notice', message: 'Additional DeepSeek Harness image previews are outside this bounded history read.' });
        continue;
      }
      let read = this.imageReads.get(ref.attachmentId);
      if (!read && this.imageReads.size >= 16) this.imageReads.delete(this.imageReads.keys().next().value!);
      if (!read && this.imageReads.size < 16 && this.imageAborts.size < 4) {
        read = (async () => {
          if ((ref.message.size ?? 0) > 4 * 1024 * 1024) return undefined;
          const abort = new AbortController(); this.imageAborts.add(abort);
          const timer = setTimeout(() => abort.abort(), 2000);
          let outcome: Awaited<ReturnType<NonNullable<DshSessionChannel['attachment']>>>;
          try { outcome = await this.channel.attachment!(this.info.id, ref.attachmentId, abort.signal); }
          finally { clearTimeout(timer); this.imageAborts.delete(abort); }
          if (!outcome.ok || epoch !== this.imageEpoch || this.closed) return undefined;
          const attachment = outcome.value.attachment as { attachmentId?: unknown; mediaType?: unknown; bytes?: unknown } | undefined;
          const data = outcome.value.data;
          if (!attachment || attachment.attachmentId !== ref.attachmentId || attachment.mediaType !== ref.message.mimeType
              || typeof data !== 'string' || data.length > 5_592_408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return undefined;
          const bytes = Buffer.from(data, 'base64');
          if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.length !== attachment.bytes
              || (ref.message.size !== undefined && bytes.length !== ref.message.size)) return undefined;
          return `data:${ref.message.mimeType};base64,${data}`;
        })().catch(() => undefined);
        this.imageReads.set(ref.attachmentId, read);
      }
      const url = await read;
      if (!url && this.imageReads.get(ref.attachmentId) === read) this.imageReads.delete(ref.attachmentId);
      if (epoch !== this.imageEpoch || this.closed) return [];
      rows.push({ ...ref.message, ...(url ? { url } : {}) });
      if (!url) rows.push({ type: 'notice', message: 'This DeepSeek Harness image preview is unavailable or exceeds the bounded readback limit.' });
    }
    return rows;
  }

  private resetImageReads(): void {
    this.imageEpoch += 1; this.imageReads.clear();
    for (const abort of this.imageAborts) abort.abort();
    this.imageAborts.clear();
  }

  /**
   * The session's model catalog, flattened from the host's provider groups.
   *
   * A READ. The broker collects this at attach with per-surface fault
   * isolation, so a throw here costs the picker and nothing else.
   *
   * A session the host cannot route is advertised as EMPTY rather than as a
   * catalog: `routable:false` means no adapter serves the current route, so a
   * turn cannot start, and offering models to pick between would promise a
   * send that is going to fail. The groups themselves are advisory and stay
   * exactly as the host ordered them — advertised order is picker order.
   */
  async listModels(): Promise<ModelOption[]> {
    const catalog = await this.channel.models(this.info.id);
    if (!catalog.routable) return [];
    // Flattened through the shared mapper, so the attached picker shows the
    // same rows the pre-session catalog (`DshAdapter.listModels`) offered.
    return dshModelOptions(catalog.groups);
  }

  /**
   * The permission presets this deployment offers.
   *
 * Read from the `permissions` projection the connection already holds wherever
   * that projection carries its own roster, so a mode picker costs nothing and
   * stays correct as the host pushes updates. Where the projection carries only
   * the current value — the captured 0.2 shape — the roster comes from the
   * host-wide catalog endpoint, cached per carrier. No roster at all means no
   * permission service is composed and the control is hidden, which is exactly
   * what an empty list does.
   */
  async listModes(): Promise<ModeOption[]> {
    return (await this.permissionSelect())?.options ?? [];
  }

  /**
   * The session's command roster: the host's own registry, plus local
   * interruption and, on rc.2, steering.
   *
   * A READ. Every host command runs through the command registry and is never
   * sent to the model, so all of them are `action` kind. A host row whose name
   * collides with a local command is dropped, because two entries with one
   * name is a picker that lies about which one runs.
   *
   * A host that cannot be reached still yields the interrupt — losing the
   * ability to stop a running turn because a roster lookup failed would be a
   * strictly worse outcome than a short list.
   */
  async listCommands(): Promise<SlashCommand[]> {
    const local: SlashCommand[] = [{ name: 'stop', description: 'Stop the running turn', kind: 'action' }];
    if (this.channel.family === 'remote-0.2') {
      local.push({ name: 'steer', description: 'Send text to the running turn at its next step', kind: 'action' });
    }
    let roster: Awaited<ReturnType<DshDriver['listCommands']>>;
    try {
      roster = await this.channel.listCommands(this.info.id);
    } catch {
      return local;
    }
    for (const command of roster) {
      if (DSH_LOCAL_COMMANDS.includes(command.name)
        || (this.channel.family === 'remote-0.2' && command.name === 'steer')) continue;
      local.push({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        kind: 'action',
      });
    }
    return local;
  }

  /**
   * Run one command.
   *
   * EXACTLY ONCE is the property that matters, so this issues a single
   * `commands/execute` and never retries: the host mints a `commandId` and
   * appends the lifecycle records the moment it accepts the line, and a
   * transport failure after that point is indistinguishable from one before it.
   * A retry could compact a session twice or switch a permission preset the
   * user did not ask for a second time.
   *
   * The line is composed from the ADVERTISED name plus the caller's argument
   * text; the name is re-checked against the live roster so a stale picker
   * cannot send an unknown slash line into the host's parser.
   */
  async runCommand(name: string, args?: string, input?: CommandInput): Promise<CommandResult | void> {
    if (DSH_LOCAL_COMMANDS.includes(name)) {
      this.assertMutable(`run "${name}"`);
      await this.channel.cancel(this.info.id);
      return;
    }
    if (this.channel.family === 'remote-0.2' && name === 'steer') {
      this.assertMutable('steer the running turn');
      const text = args?.trim();
      if (!text) throw new Error('/steer requires text for the running turn');
      await this.submitPrompt({ ...input, text }, 'steer');
      return;
    }
    this.assertMutable(`run "${name}"`);
    const roster = await this.channel.listCommands(this.info.id);
    if (!roster.some((command) => command.name === name)) {
      throw new Error(`dsh has no command "${name}"`);
    }
    // Re-guarded after the roster read: the lookup awaited, and the generation
    // it was issued under may have ended while it was in flight.
    this.assertMutable(`run "${name}"`);
    await this.applyPermissionMode(input?.permissionMode);
    this.assertMutable(`run "${name}"`);
    const trimmed = args?.trim() ?? '';
    const execution = await this.channel.executeCommand(
      this.info.id,
      trimmed ? `/${name} ${trimmed}` : `/${name}`,
    );
    if (!execution) return;
    if (execution.result.kind === 'error') {
      throw new Error(
        execution.result.text ? `/${name} failed: ${execution.result.text}` : `/${name} failed`,
      );
    }
    // A command whose effect streams back as ordinary session events settles
    // with no text; returning an empty notice would put a blank system line in
    // the transcript beside the events that ARE the feedback.
    return execution.result.text ? { notice: execution.result.text } : undefined;
  }

  async close(): Promise<void> {
    this.resetImageReads();
    this.channel.close?.();
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.primingBuffer = [];
    this.onClosed?.(this.info.id);
  }

  // ── Package-internal observation (tests, diagnostics) ─────────────────────

  /** Every projection key the host has published, known consumer or not. */
  projectionKeys(): string[] {
    return this.projections.keys();
  }

  projectionValue(key: string): unknown {
    return this.projections.get(key);
  }

  /** Background jobs from the latest authoritative snapshot. */
  jobsSnapshot(): readonly unknown[] {
    return this.jobs;
  }

  pendingRpcIds(): string[] {
    return [...this.pending.keys()];
  }

  get isPrimed(): boolean {
    return this.primed;
  }

  get observedHostLastSeq(): number | undefined {
    return this.hostLastSeq;
  }

  private highestAdmitted(): number {
    let highest = this.admittedFloor;
    for (const value of this.admitted) if (value > highest) highest = value;
    return highest;
  }

  /**
   * Host restart: forget every admitted seq beyond the new tail. The restarted
   * host reuses those numbers for NEW content, so keeping them would reject
   * fresh frames as duplicates.
   */
  private rewindAdmitGate(lastSeq: number): void {
    for (const seq of this.admitted) if (seq > lastSeq) this.admitted.delete(seq);
    if (this.admittedFloor > lastSeq) this.admittedFloor = lastSeq;
  }
}

function isReplaceOp(event: DshSessionEvent): boolean {
  const op = event.surfaceOp;
  return !!op && typeof op === 'object' && (op as { op?: unknown }).op === 'replace';
}

function normalizeEntries(raw: unknown): DshHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: DshHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { event?: unknown; view?: unknown };
    const event = entry.event as DshSessionEvent | undefined;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    entries.push({ event, ...(entry.view !== undefined ? { view: entry.view } : {}) });
  }
  return entries;
}

function dshQueueText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}
