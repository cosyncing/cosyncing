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
  CommandResult,
  HistoryQuery,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  SlashCommand,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import type { DshDownlinkFrame, DshRpcClient } from './server.ts';
import { DshDriver } from './drive.ts';
import {
  createDshMapState,
  dshMessageKey,
  dshProjectionMessages,
  DshProjectionStore,
  DSH_TERMINAL_SYNC_IMPOSSIBLE,
  mapDshApproval,
  mapDshEvent,
  mapDshHistory,
  mapDshQuestion,
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

/** Command names accepted by {@link DshSessionConnection.runCommand}; all mean `session.cancel`. */
const DSH_COMMANDS: readonly string[] = Object.freeze(['stop', 'cancel', 'interrupt']);

export interface DshConnectionOptions {
  rpc: DshRpcClient;
  driver?: DshDriver;
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
  private readonly rpc: DshRpcClient;
  private readonly driver: DshDriver;
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
  private readonly pending = new Map<string, DshPending>();
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

  constructor(readonly info: SessionInfo, options: DshConnectionOptions) {
    this.rpc = options.rpc;
    this.driver = options.driver ?? new DshDriver(options.rpc);
    this.nowImpl = options.now ?? (() => Date.now());
    this.historyMaxPages = options.historyMaxPages ?? DSH_HISTORY_MAX_PAGES;
    this.historyPageMessages = options.historyPageMessages ?? DSH_HISTORY_PAGE_MESSAGES;
    this.primingMaxFrames = options.primingMaxFrames ?? DSH_PRIMING_MAX_FRAMES;
    this.primingTimeoutMs = options.primingTimeoutMs ?? DSH_PRIMING_TIMEOUT_MS;
    if (options.mutationReady) this.mutationReady = options.mutationReady;
    if (options.onClosed) this.onClosed = options.onClosed;
    this.state = createDshMapState(info.id, true);
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

    for (let page = 0; page < this.historyMaxPages; page += 1) {
      const outcome = await this.rpc.call<HistoryPage>('session.history', {
        sessionId: this.info.id,
        maxMessages: this.historyPageMessages,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      });
      if (!outcome.ok) {
        readFailed = true;
        break;
      }
      const entries = normalizeEntries(outcome.value?.events);
      if (pagesRead === 0) this.projections.seed(outcome.value?.projections);
      pagesRead += 1;
      pages.unshift(entries);
      const oldest = entries[0]?.event.seq;
      if (outcome.value?.hasMore !== true || oldest === undefined || oldest === beforeSeq || oldest <= 0) break;
      beforeSeq = oldest;
      if (page === this.historyMaxPages - 1) reachedCeiling = true;
    }

    const entries = pages.flat();
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
    for (const key of this.projections.keys()) {
      rows.push(...dshProjectionMessages(key, this.projections.get(key), { forkedChild: this.info.parentThreadId !== undefined }));
    }
    return rows;
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
   * ONLY `session/event` frames wait for priming: they are the frames the
   * history seed also delivers, so releasing them early is the duplicate risk
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
    if (!this.primed && frame.frameType === 'session/event') {
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
      case 'session/event': {
        const event = payload.event as DshSessionEvent | undefined;
        if (!event || typeof event.type !== 'string') return;
        if (!this.admit(event.seq)) return;
        const entry: DshHistoryEntry = { event, ...(payload.view !== undefined ? { view: payload.view } : {}) };
        // A live surface REPLACE rewrites transcript the client already holds.
        // Only a wholesale reload can make rows disappear, so say so rather than
        // appending a summary beside the text it was meant to shadow.
        if (isReplaceOp(event)) {
          this.deliver({ type: 'history-reset', semantic: { kind: 'compaction' } });
          return;
        }
        for (const message of mapDshEvent(entry, this.state)) this.deliver(message);
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
      case 'session/projection': {
        const key = typeof payload.key === 'string' ? payload.key : '';
        const seq = typeof payload.seq === 'number' ? payload.seq : 0;
        if (!key || !this.projections.apply(key, payload.value, seq)) return;
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
      case 'host/session-status': {
        const running = frame.payload.running === true;
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
   * The transient inbox, as an authoritative whole snapshot. Queued and steering
   * items render as dimmed user bubbles; `context` items are invisible until the
   * agent claims them, exactly as the host describes.
   *
   * The bubble key is the native MESSAGE id, which is also what the durable
   * `user/message` event carries — so when the agent claims the item, the
   * durable row replaces the queued one in place instead of doubling it.
   *
   * KNOWN GAP (round 1): a queued item DELETED via another client
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
    this.primed = false;
    this.primingStartedAt = undefined;
    this.settlePendingAsExternal();
  }

  /**
   * Settle every pending card as resolved-elsewhere and empty the tables.
   * Shared by generation loss and session removal: in both cases the prompts
   * this connection tracks are unverifiable or gone, and no resolution frame
   * is coming for them.
   */
  private settlePendingAsExternal(): void {
    for (const entry of this.pending.values()) {
      if (entry.kind === 'approval') {
        this.deliver({ type: 'permission-resolved', requestId: entry.rpcId, decision: 'external' });
      } else {
        this.deliver({ type: 'question-resolved', requestId: entry.rpcId });
      }
    }
    this.pending.clear();
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
    if (this.mutationReady && !this.mutationReady()) {
      throw new Error(`cannot ${action}: the DeepSeek Harness host link is re-verifying; retry in a moment`);
    }
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertMutable('send a prompt');
    const clientMessageId = input.clientMessageId;
    await this.driver.prompt(this.info.id, input, {
      mode: 'queue',
      ...(clientMessageId
        ? { onRpcId: (rpcId: string) => this.state.clientKeys.set(rpcId, clientMessageId) }
        : {}),
    });
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertMutable('answer an approval');
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'approval') {
      throw new Error(`dsh approval ${requestId} is no longer pending`);
    }
    const receipt = await this.driver.respondApproval(entry, decision !== 'reject');
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
    this.pending.delete(requestId);
    this.approvalIndex.delete(entry.approvalId);
    if (!receipt.accepted) {
      this.deliver({ type: 'permission-resolved', requestId, decision: 'external' });
    }
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.assertMutable('answer a question');
    const entry = this.pending.get(requestId);
    if (!entry || entry.kind !== 'question') {
      throw new Error(`dsh question ${requestId} is no longer pending`);
    }
    const receipt = await this.driver.answerQuestion(entry, answers);
    // Same receipt discipline as respondPermission: `bad-response` throws and
    // keeps the card; `not-pending` — the only other reason the decoder admits
    // — settles the card as resolved-elsewhere.
    if (!receipt.accepted && receipt.reason === 'bad-response') {
      throw new Error(`the dsh host rejected the question answer for ${requestId} as malformed`);
    }
    this.pending.delete(requestId);
    if (!receipt.accepted) {
      this.deliver({ type: 'question-resolved', requestId });
    }
  }

  /**
   * The one action round 1 can actually perform.
   *
   * Compact, undo, redo, and share are deliberately absent rather than stubbed:
   * the host either has no such RPC or it sits outside the round-1 method
   * allowlist, and an advertised command that cannot run is worse than a missing
   * one. `stop` follows the shipped naming for the interrupt action.
   */
  async listCommands(): Promise<SlashCommand[]> {
    return [{ name: 'stop', description: 'Stop the running turn', kind: 'action' }];
  }

  async runCommand(name: string): Promise<CommandResult | void> {
    if (!DSH_COMMANDS.includes(name)) throw new Error(`dsh has no command "${name}"`);
    this.assertMutable(`run "${name}"`);
    await this.driver.cancel(this.info.id);
  }

  async close(): Promise<void> {
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
