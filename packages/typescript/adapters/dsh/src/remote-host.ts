/**
 * The 0.2 host link: one authenticated carrier, the session streams that ride it,
 * and the event generation that authorizes answers.
 *
 * This is the module that makes the 0.2 transport a PRODUCT path rather than a
 * green test suite. It owns what {@link DshHostLink} owns for 0.1 — one shared
 * connection, a routing table, and the re-baseline when a generation dies — with
 * three differences that the 0.2 contract forces:
 *
 *  READINESS IS AUTHENTICATED AND GENERATION-SCOPED. There is no `host.describe`.
 *  What proves the host is a cookie the host itself issued plus a `$events`
 *  `ready` frame whose `clientId` is the only thing that can settle an approval.
 *  A carrier that merely opened proves nothing, and a generation that ended while
 *  the socket lives is worse than an outage, so readiness is revoked with it.
 *
 *  HISTORY AND LIVE ARE ONE STREAM. `session/follow` opens with a bounded
 *  snapshot, a cursor, and then the live tail, on the same stream. The snapshot's
 *  cursor is therefore the ONLY consistent history boundary: older pages are read
 *  `throughSeq = cursor`, and a live event is admitted by the connection's seq
 *  gate exactly as a legacy one is. Older pages arrive through `session/page`.
 *
 *  PROJECTIONS ARE HOST-WIDE. `session/control` takes no arguments and publishes
 *  a baseline keyed by session id plus per-session updates. One stream serves
 *  every attached session; opening one per session would multiply identical
 *  host-wide feeds by the roster size.
 *
 * Everything it hands a session is shaped like a legacy downlink frame, which is
 * deliberate: the transcript fold, the admit gate, the projection store and the
 * pending cards are contract-family-neutral machinery that was qualified against
 * a real 0.1 host, and the cheapest way to keep them correct is to feed them the
 * same vocabulary instead of rewriting them per family.
 */

import { PRODUCT_IDENTITY } from '@cosyncing/adapter-api';
import {
  DshDriveError,
  dshImageParts,
  dshStagedImages,
  parseDshCommandDescriptors,
  parseDshCommandExecution,
  parseDshModelGroups,
  type DshCommandDescriptor,
  type DshCommandExecution,
  type DshModelProviderGroup,
  type DshModelSelection,
  type DshPromptOptions,
  type DshSessionModels,
} from './drive.ts';
import { DshAuthSession } from './auth.ts';
import { transportFailure, type DshOutcome } from './envelope.ts';
import {
  DshEventLink,
  type DshAnswerReceipt,
  type DshEventGeneration,
  type DshEventLinkDiagnostic,
} from './event-link.ts';
import {
  DshMuxClient,
  DshStreamError,
  type DshMuxDiagnostic,
  type DshMuxSocketFactory,
  type DshMuxStream,
} from './mux.ts';
import {
  DshRemoteArgs,
  DshRemoteClient,
  dshSessionAddress,
  type DshEventOutcome,
  type DshRemoteEndpoint,
} from './remote.ts';
import type { DshSessionChannel, DshHistoryPage } from './protocol.ts';
import {
  mapDshApproval,
  mapDshQuestion,
  type DshHistoryEntry,
  type DshPendingApproval,
  type DshPendingQuestion,
  type DshSessionEvent,
} from './mapping.ts';
import type { DshSessionConnection } from './observe.ts';
import type { DshDownlinkFrame, DshReceipt } from './server.ts';

const LOG_PREFIX = `[${PRODUCT_IDENTITY.productName}]`;

/** How long a follow snapshot may take to arrive before a history read says so. */
export const DSH_REMOTE_SNAPSHOT_TIMEOUT_MS = 15_000;

/** What the link saw that it could not use. Contained, bounded, and never fatal. */
export interface DshRemoteLinkDiagnostic {
  code: 'unusable-stream-item'
    | 'ignored-assistant-stream'
    | 'snapshot-timeout'
    | 'auth-refused'
    | 'waterfall-delegated'
    | 'mux-diagnostic'
    | 'event-diagnostic';
  detail?: string;
}

/** Frame ids the bridge synthesizes. `rpcId` carries the host's own event id. */
function bridgeFrame(
  frameType: string,
  rpcId: string,
  payload: Record<string, unknown>,
): DshDownlinkFrame {
  const serialized = JSON.stringify(payload);
  return {
    stream: 'mux',
    frameType,
    rpcId,
    payload,
    bytes: Buffer.byteLength(serialized, 'utf8') + 64,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One durable record as the follow stream and the page route both deliver it. */
function historyEntry(raw: unknown): DshHistoryEntry | undefined {
  const row = record(raw);
  if (!row) return undefined;
  const event = record(row.event);
  if (!event || typeof event.type !== 'string' || typeof event.seq !== 'number') return undefined;
  return { event: event as unknown as DshSessionEvent, ...(row.view !== undefined ? { view: row.view } : {}) };
}

/** One snapshot's records, defensively: a malformed row drops, the page does not. */
function historyEntries(raw: unknown): DshHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: DshHistoryEntry[] = [];
  for (const row of raw) {
    const entry = historyEntry(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Read one matching item off a stream and stop.
 *
 * The reader is cancelled by the CALLER's `finally`, not here: a stream this
 * module opened but nobody closes is a stream the host keeps producing into.
 */
async function firstItemOf(
  stream: DshMuxStream,
  matches: (item: Record<string, unknown>) => boolean,
  timeoutMs: number,
  setTimeoutImpl: (handler: () => void, ms: number) => unknown,
  clearTimeoutImpl: (handle: unknown) => void,
): Promise<Record<string, unknown> | undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  let timer: unknown;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeoutImpl(() => resolve(undefined), timeoutMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === undefined || next.done) return undefined;
      const item = record(next.value);
      if (item && matches(item)) return item;
    }
  } finally {
    clearTimeoutImpl(timer);
    void iterator.return?.();
  }
}

/** The snapshot a follow stream opens with, plus what the connection needs from it. */
interface DshFollowSnapshot {
  cursor: number;
  records: DshHistoryEntry[];
  hasMore: boolean;
  projections?: unknown;
}

interface SessionRuntime {
  connection: DshSessionConnection;
  channel: DshRemoteSessionChannel;
  /** The follow stream this carrier generation opened, once written. */
  stream?: DshMuxStream;
  carrier: number;
  snapshot?: DshFollowSnapshot;
  snapshotSettled: boolean;
  waiters: Set<() => void>;
}

export interface DshRemoteHostLinkOptions {
  baseUrl: string;
  auth: DshAuthSession;
  remote: DshRemoteClient;
  socketFactory?: DshMuxSocketFactory;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reconnectDelayMs?: number;
  /** Bounded snapshot read for one follow attach. */
  historyPageMessages?: number;
  /** How long a history read waits for the follow snapshot that opens it. */
  snapshotTimeoutMs?: number;
  onDiagnostic?: (diagnostic: DshRemoteLinkDiagnostic) => void;
}

/**
 * The 0.2 write path for one session.
 *
 * Attachment validation is not reimplemented here. Prompt content comes from the
 * same two builders the qualified 0.1 driver uses, so a staged file that fails
 * the inbox/symlink/size/media check fails identically on both families, and a
 * rejected attachment still fails the WHOLE prompt rather than arriving short.
 */
export class DshRemoteSessionChannel implements DshSessionChannel {
  readonly family = 'remote-0.2' as const;

  constructor(
    private readonly link: DshRemoteHostLink,
    private readonly remote: DshRemoteClient,
    private readonly sessionId: string,
    private readonly options: {
      newRequestId: () => string;
      pageMessages: number;
    },
  ) {}

  async history(request: { sessionId: string; maxMessages: number; beforeSeq?: number }): Promise<DshOutcome<DshHistoryPage>> {
    if (request.beforeSeq === undefined) {
      const snapshot = await this.link.snapshot(this.sessionId);
      if (!snapshot) return transportFailure('unreachable', {
        retryable: true,
        detail: 'the DeepSeek Harness follow stream did not deliver a history snapshot',
      });
      return {
        ok: true,
        value: {
          events: snapshot.records,
          hasMore: snapshot.hasMore,
          ...(snapshot.projections !== undefined ? { projections: snapshot.projections } : {}),
        },
      };
    }
    const throughSeq = await this.link.snapshotCursor(this.sessionId);
    if (throughSeq === undefined) {
      return transportFailure('unreachable', {
        retryable: true,
        detail: 'no follow snapshot is open to page older DeepSeek Harness history from',
      });
    }
    const outcome = await this.link.call<unknown>('session/page', DshRemoteArgs.page({
      sessionId: request.sessionId,
      throughSeq,
      beforeSeq: request.beforeSeq,
      maxMessages: Math.max(1, Math.min(request.maxMessages, this.options.pageMessages)),
    }));
    if (!outcome.ok) return outcome;
    const page = record(outcome.value);
    return { ok: true, value: { events: historyEntries(page?.records), hasMore: page?.hasMore === true } };
  }

  async prompt(sessionId: string, input: Parameters<DshSessionChannel['prompt']>[1], options: DshPromptOptions = {}): Promise<void> {
    const images = [
      ...(input.images ?? []),
      ...dshStagedImages(input.files ?? [], options.imageLimits, options.sessionCwd),
    ];
    const content: unknown[] = [
      { type: 'text', text: input.text ?? '' },
      ...dshImageParts(images, options.imageLimits),
    ];
    // The prompt's own identity, minted HERE rather than reused from the carrier:
    // `session/prompt` requires a client `requestId`, and the envelope's rpcId
    // identifies THIS request, not the turn it started. They are different ids
    // with different lifetimes and must never be collapsed.
    const requestId = this.options.newRequestId();
    options.onRpcId?.(requestId);
    const outcome = await this.link.call<unknown>('session/prompt', DshRemoteArgs.prompt({
      requestId,
      sessionId,
      mode: options.mode ?? 'queue',
      content,
      ...(options.clientTimeZone ? { clientTimeZone: options.clientTimeZone } : {}),
    }));
    if (!outcome.ok) throw new DshDriveError('prompt', outcome.failure);
  }

  async models(): Promise<DshSessionModels> {
    const outcome = await this.link.call<unknown>('session/modelCatalog', DshRemoteArgs.modelCatalog());
    if (!outcome.ok) throw new DshDriveError('model catalog', outcome.failure);
    const row = record(outcome.value);
    if (!row) {
      throw new DshDriveError('model catalog', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session/modelCatalog did not return an object',
      });
    }
    // 0.2 publishes no per-session routability check. `routable` therefore reports
    // that the catalog answered, and the gateway's own `session/model-unavailable`
    // refusal is the authority on a route that cannot serve. Inventing a `false`
    // here would disable the composer on the exact version this build targets.
    return {
      routable: true,
      groups: parseDshModelGroups(row.groups),
    };
  }

  async selectModel(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection> {
    const outcome = await this.link.call<unknown>('session/selectModel', DshRemoteArgs.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }));
    if (!outcome.ok) throw new DshDriveError('model selection', outcome.failure);
    const selected = record(record(outcome.value)?.selected);
    const provider = optionalString(selected?.provider);
    const model = optionalString(selected?.model);
    if (!provider || !model) {
      throw new DshDriveError('model selection', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session/selectModel returned no usable selection',
      });
    }
    const reasoningEffort = optionalString(selected?.reasoningEffort);
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  async listCommands(sessionId: string): Promise<DshCommandDescriptor[]> {
    // `agentId` is the session id on this host: `commands/list` names its single
    // parameter `agentId` and types it `SessionId`, so there is no separate agent
    // identity to discover first.
    const outcome = await this.link.call<unknown>('commands/list', DshRemoteArgs.commands(sessionId));
    if (!outcome.ok) throw new DshDriveError('command list', outcome.failure);
    return parseDshCommandDescriptors(outcome.value);
  }

  async executeCommand(sessionId: string, line: string): Promise<DshCommandExecution | undefined> {
    // `submittedAttachments` is a required argument on 0.2's execute signature.
    // An empty array is the honest value: this adapter sends no attachments with a
    // command, and omitting the key is a `gateway/arguments-invalid`, not a default.
    const outcome = await this.link.call<unknown>(
      'commands/execute',
      DshRemoteArgs.execute(sessionId, line, []),
    );
    if (!outcome.ok) throw new DshDriveError('command', outcome.failure);
    return parseDshCommandExecution(outcome.value, 'command');
  }

  async cancel(sessionId: string): Promise<void> {
    const outcome = await this.link.call<unknown>('session/cancel', DshRemoteArgs.cancel(sessionId));
    if (!outcome.ok) throw new DshDriveError('cancel', outcome.failure);
  }

  async answerQuestion(pending: DshPendingQuestion, answers: string[][]): Promise<DshReceipt> {
    return this.link.settleWaterfall('question answer', pending.rpcId, {
      kind: 'result',
      value: {
        answers: pending.ids.map((id, index) => {
          const given = [...new Set(answers[index] ?? [])];
          const labels = pending.optionLabels[index] ?? [];
          const selected = given.filter((entry) => labels.includes(entry));
          const custom = given.filter((entry) => !labels.includes(entry)).join('\n');
          if (pending.multiSelect[index] !== true) {
            return custom ? { id, selected: [], custom } : { id, selected: selected.slice(0, 1) };
          }
          return { id, selected, ...(custom ? { custom } : {}) };
        }),
      },
    });
  }

  async respondApproval(pending: DshPendingApproval, allow: boolean): Promise<DshReceipt> {
    // The outcome vocabulary is the host's own: `allowed-once` and `rejected` are
    // the two values the waterfall accepts, so a session-wide grant degrades to a
    // single allow rather than to a promise the host cannot keep.
    return this.link.settleWaterfall('approval', pending.rpcId, { kind: 'result', value: allow ? 'allowed-once' : 'rejected' });
  }
}

/**
 * The 0.2 host link.
 *
 * Lifetimes, stated plainly because each one has a deadline attached:
 *
 *  - The CARRIER (one WebSocket) reconnects itself, and every generation of it
 *    invalidates every stream that rode the last one.
 *  - The EVENT GENERATION is the authority for answers. It is revoked when its
 *    stream ends even if the carrier stays healthy, because a superseded
 *    `clientId` is a decision the host throws away.
 *  - A SESSION STREAM belongs to one attached connection and closes with it.
 *  - The CONTROL stream is host-wide and starts with the first session, because
 *    its baseline is meaningless with no reader and expensive with none.
 *
 * The link starts on the first attach or the first host-level verification and
 * stops only on `stop()`: an approval raised against a session nobody in cosyncing
 * has open still has to be delegated rather than left hanging, and a create needs a
 * verified generation. Discovery never starts it — a roster sweep is unary reads.
 */
export class DshRemoteHostLink {
  readonly remote: DshRemoteClient;
  private readonly auth: DshAuthSession;
  private readonly baseUrl: string;
  private readonly socketFactory?: DshMuxSocketFactory;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly reconnectDelayMs?: number;
  private readonly pageMessages: number;
  private readonly snapshotTimeoutMs: number;
  private readonly onDiagnostic?: (diagnostic: DshRemoteLinkDiagnostic) => void;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly requestSeq = { value: 0 };
  private mux?: DshMuxClient;
  private events?: DshEventLink;
  private controlStream?: DshMuxStream;
  private controlCarrier = -1;
  private started = false;
  private stopped = false;
  private readonly lostHandlers = new Set<(reason: string) => void>();

  constructor(options: DshRemoteHostLinkOptions) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    this.remote = options.remote;
    if (options.socketFactory) this.socketFactory = options.socketFactory;
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    if (options.reconnectDelayMs !== undefined) this.reconnectDelayMs = options.reconnectDelayMs;
    this.pageMessages = options.historyPageMessages ?? 200;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? DSH_REMOTE_SNAPSHOT_TIMEOUT_MS;
    if (options.onDiagnostic) this.onDiagnostic = options.onDiagnostic;
  }

  get authState(): import('./auth.ts').DshAuthState {
    return this.auth.state;
  }

  /** Authenticated AND holding a verified event generation. */
  get isReady(): boolean {
    return this.auth.cookieHeader() !== null && (this.events?.isVerified ?? false);
  }

  get generation(): number {
    return this.mux?.generation ?? 0;
  }

  /**
   * Whether a carrier is open right now.
   *
   * Exposed because one read on the other side of it is a stream: `workspace/follow`
   * has no unary equivalent, and a discovery sweep that started a carrier would
   * leave a broker with an idle roster reconnecting to a host nobody is watching.
   * A caller that only WANTS the baseline asks this first and reads it when the
   * link is already up; a caller about to WRITE starts the link on purpose.
   */
  get carrierRunning(): boolean {
    return this.mux !== undefined && !this.stopped;
  }

  /** A generation ending: every session re-baselines, and no older answer is valid. */
  onGenerationLost(handler: (reason: string) => void): () => void {
    this.lostHandlers.add(handler);
    return () => { this.lostHandlers.delete(handler); };
  }

  /**
   * One unary call, with the auth refusal read as a credential fact.
   *
   * A 401 on a request that CARRIED a cookie means that cookie is not working,
   * which is a different problem from "the host is down" and a different remedy
   * from "the address is wrong". Recording it here is what lets doctor name the
   * remedy instead of reporting a host that never became ready.
   */
  async call<T>(
    endpoint: DshRemoteEndpoint,
    args: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal },
  ): Promise<DshOutcome<T>> {
    // Authenticated BEFORE the request, not merely headed by whatever header the
    // session happens to be holding. The credential on disk is the whole point of
    // a broker restart against a surviving host, and a request that raced past the
    // first load would answer a healthy, enrolled host with its own 401 — which
    // this method then correctly reads as a refused credential, and the operator
    // watches a working host be called broken.
    const auth = await this.auth.ensure();
    if (auth.state !== 'authenticated') {
      return transportFailure('unauthenticated', {
        retryable: auth.state !== 'rejected' && auth.state !== 'blocked',
        detail: auth.detail,
      });
    }
    const outcome = await this.remote.call<T>(endpoint, args, options ? { ...(options.signal ? { signal: options.signal } : {}) } : undefined);
    if (!outcome.ok && outcome.failure.kind === 'transport'
      && (outcome.failure.reason === 'unauthenticated' || outcome.failure.reason === 'forbidden')) {
      this.auth.reportCredentialRefused(outcome.failure.reason === 'forbidden' ? 'host-or-origin-refused' : 'credential-refused');
      this.note({ code: 'auth-refused', detail: outcome.failure.reason });
    }
    return outcome;
  }

  /** Prove the host and this build agree, right now, before anything is written. */
  async verify(signal?: AbortSignal): Promise<DshOutcome<{ hostHome: string }>> {
    const auth = await this.auth.ensure();
    if (auth.state !== 'authenticated') {
      return transportFailure(auth.state === 'rejected' ? 'unauthenticated' : 'unreachable', {
        retryable: auth.state === 'rejected',
        detail: auth.detail,
      });
    }
    const link = this.start();
    const existing = link.currentGeneration;
    if (existing) return { ok: true, value: { hostHome: existing.hostHome } };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: DshOutcome<{ hostHome: string }>): void => {
        if (settled) return;
        settled = true;
        this.clearTimeoutImpl(timer);
        unsubscribe();
        resolve(outcome);
      };
      const unsubscribe = link.onVerified((generation) => {
        finish({ ok: true, value: { hostHome: generation.hostHome } });
      });
      const timer = this.setTimeoutImpl(() => finish(transportFailure('timeout', {
        retryable: true,
        detail: 'the DeepSeek Harness host did not open an event generation',
      })), this.snapshotTimeoutMs);
      if (signal) {
        if (signal.aborted) finish(transportFailure('timeout', { retryable: true, detail: 'aborted' }));
        else signal.addEventListener('abort', () => finish(transportFailure('timeout', { retryable: true, detail: 'aborted' })), { once: true });
      }
      // A carrier already open and verified between the check and the
      // subscription is the race this closes: re-read rather than wait it out.
      const now = link.currentGeneration;
      if (now) finish({ ok: true, value: { hostHome: now.hostHome } });
    });
  }

  start(): DshEventLink {
    if (this.stopped) throw new Error('the DeepSeek Harness remote link has been stopped');
    if (this.events) {
      this.events.start();
      return this.events;
    }
    this.started = true;
    this.mux = new DshMuxClient({
      baseUrl: this.baseUrl,
      headers: () => this.auth.authHeaders(),
      ...(this.socketFactory ? { socketFactory: this.socketFactory } : {}),
      setTimeout: this.setTimeoutImpl,
      clearTimeout: this.clearTimeoutImpl,
      ...(this.reconnectDelayMs !== undefined ? { reconnectDelayMs: this.reconnectDelayMs } : {}),
    }, {
      onOpen: (generation) => { this.onCarrierOpen(generation); },
      onLost: (generation, reason) => {
        if (generation === this.controlCarrier) this.controlStream = undefined;
        if (generation === this.controlCarrier) this.controlCarrier = -1;
        this.onCarrierLost(reason);
      },
      onDiagnostic: (diagnostic: DshMuxDiagnostic) => this.note({ code: 'mux-diagnostic', detail: diagnostic.code }),
    });
    this.events = new DshEventLink({
      baseUrl: this.baseUrl,
      mux: this.mux,
      headers: () => this.auth.authHeaders(),
      setTimeout: this.setTimeoutImpl,
      clearTimeout: this.clearTimeoutImpl,
      ...(this.reconnectDelayMs !== undefined ? { reconnectDelayMs: this.reconnectDelayMs } : {}),
      answer: (event) => this.answerEvent(event.clientId, event.eventId, event.outcome),
    }, {
      onLost: (_carrier, reason) => this.onCarrierLost(reason),
      onEvent: (event, _args) => this.onForwardedEvent(event),
      onWaterfall: (frame) => this.onWaterfall(frame),
      onCancellation: (eventId) => this.onCancellation(eventId),
      onDiagnostic: (diagnostic: DshEventLinkDiagnostic) => this.note({ code: 'event-diagnostic', detail: diagnostic.code }),
    });
    this.events.start();
    return this.events;
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.controlStream = undefined;
    this.controlCarrier = -1;
    for (const session of this.sessions.values()) {
      session.stream?.cancel();
      session.stream = undefined;
    }
    this.events?.stop();
    this.mux?.stop();
    this.events = undefined;
    this.mux = undefined;
  }

  // ── Host reads and writes ─────────────────────────────────────────────────

  /**
   * The roster, following the host's own cursor.
   *
   * Bounded at eight pages: a host with more than eight pages of sessions is a
   * host whose roster this sweep cannot render anyway, and an unbounded cursor
   * loop on a discovery leg with a budget attached is how a roster read turns
   * into the thing the budget exists to prevent.
   */
  async roster(signal?: AbortSignal): Promise<DshOutcome<{ items: unknown[] }>> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const outcome = await this.call<{ items?: unknown; cursor?: unknown }>(
        'session/list',
        DshRemoteArgs.list(cursor === undefined ? undefined : { cursor }),
        signal ? { signal } : undefined,
      );
      if (!outcome.ok) return outcome;
      const row = record(outcome.value);
      if (Array.isArray(row?.items)) items.push(...row.items);
      const next = optionalString(row?.cursor);
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { ok: true, value: { items } };
  }

  /**
   * The workspace registry, from a bounded `workspace/follow` read.
   *
   * There is no unary workspace list on 0.2: membership is a stream. This opens
   * it, takes the baseline, and closes it — it is NOT a subscription, because a
   * discovery sweep that leaves a host-wide stream open per call is a leak with a
   * polite name. If no baseline arrives in the window the read reports the
   * failure rather than answering "no workspaces", which would surface as a
   * create refusal blaming the operator's registry for our own timeout.
   */
  async workspaces(signal?: AbortSignal): Promise<DshOutcome<{ items: unknown[]; sessionIds: Map<string, string[]> }>> {
    const mux = this.mux;
    if (!mux || this.stopped) {
      return transportFailure('generation-lost', {
        retryable: true,
        detail: 'the DeepSeek Harness stream carrier is not running',
      });
    }
    const stream = mux.open('workspace/follow', { args: {} });
    try {
      const baseline = await firstItemOf(stream, (item) => item.type === 'baseline', this.snapshotTimeoutMs, this.setTimeoutImpl, this.clearTimeoutImpl);
      if (!baseline) {
        this.note({ code: 'unusable-stream-item', detail: 'workspace/follow produced no baseline' });
        return transportFailure('timeout', {
          retryable: true,
          detail: 'the DeepSeek Harness host did not publish its workspace baseline',
        });
      }
      const value = record(baseline.value);
      const items = Array.isArray(value?.items) ? value.items : [];
      const sessionIds = new Map<string, string[]>();
      for (const raw of items) {
        const row = record(raw);
        const workspaceId = optionalString(row?.workspaceId);
        if (!workspaceId || !Array.isArray(row?.sessionIds)) continue;
        sessionIds.set(workspaceId, row.sessionIds.filter((entry): entry is string => typeof entry === 'string'));
      }
      return { ok: true, value: { items, sessionIds } };
    } finally {
      stream.cancel();
    }
  }

  /** The host-wide model catalog, in the shape the 0.1 driver already renders. */
  async modelCatalog(signal?: AbortSignal): Promise<import('./drive.ts').DshModelProviderGroup[]> {
    const outcome = await this.call<unknown>('session/modelCatalog', DshRemoteArgs.modelCatalog(), signal ? { signal } : undefined);
    if (!outcome.ok) throw new DshDriveError('model catalog', outcome.failure);
    const row = record(outcome.value);
    if (!row) {
      throw new DshDriveError('model catalog', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session/modelCatalog did not return an object',
      });
    }
    return parseDshModelGroups(row.groups);
  }

  /**
   * Create a session.
   *
   * `non-idempotent-write` for the same reason the 0.1 driver gives: an abort
   * does not un-create a session upstream, and a caller told "retryable" retries
   * into a duplicate.
   */
  async createSession(request: { workspaceId?: string; cwd?: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    const outcome = await this.remote.call<unknown>('session/create', DshRemoteArgs.create(request), {
      generationLoss: 'non-idempotent-write',
    });
    if (!outcome.ok) throw new DshDriveError('session create', outcome.failure);
    const sessionId = optionalString(record(outcome.value)?.sessionId);
    if (!sessionId) {
      throw new DshDriveError('session create', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session/create returned no sessionId',
      });
    }
    const agentPreset = optionalString(record(outcome.value)?.agentPreset);
    return { sessionId, ...(agentPreset ? { agentPreset } : {}) };
  }

  async renameSession(sessionId: string, title: string): Promise<string> {
    const outcome = await this.call<unknown>('session/rename', DshRemoteArgs.rename(sessionId, title));
    if (!outcome.ok) throw new DshDriveError('rename', outcome.failure);
    return optionalString(record(outcome.value)?.title) ?? title;
  }

  async selectModelHost(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection> {
    const outcome = await this.call<unknown>('session/selectModel', DshRemoteArgs.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }));
    if (!outcome.ok) throw new DshDriveError('model selection', outcome.failure);
    const selected = record(record(outcome.value)?.selected);
    const provider = optionalString(selected?.provider);
    const model = optionalString(selected?.model);
    if (!provider || !model) {
      throw new DshDriveError('model selection', {
        kind: 'transport',
        reason: 'invalid-envelope',
        retryable: false,
        detail: 'session/selectModel returned no usable selection',
      });
    }
    const reasoningEffort = optionalString(selected?.reasoningEffort);
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * A channel for one session.
   *
   * A pure factory, deliberately: the connection needs its channel at
   * construction time, and the registration that opens its stream happens after.
   * Handing back a CACHED channel would let a replacement attach read history
   * through the superseded connection's snapshot.
   */
  channel(sessionId: string): DshRemoteSessionChannel {
    return new DshRemoteSessionChannel(this, this.remote, sessionId, {
      newRequestId: () => `cosyncing-${String(++this.requestSeq.value)}`,
      pageMessages: this.pageMessages,
    });
  }

  /** Attach a session: open its follow stream, and the host-wide control stream. */
  register(connection: DshSessionConnection, channel = this.channel(connection.info.id)): DshRemoteSessionChannel {
    const sessionId = connection.info.id;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // A replacement attach must not inherit the superseded connection's
      // snapshot: the broker re-reads history through the NEW connection, and a
      // held snapshot would answer it with bytes taken for the old one.
      existing.stream?.cancel();
      this.sessions.delete(sessionId);
    }
    const runtime: SessionRuntime = {
      connection,
      channel,
      carrier: this.generation,
      snapshotSettled: false,
      waiters: new Set(),
    };
    this.sessions.set(sessionId, runtime);
    this.start();
    this.openFollow(runtime);
    this.ensureControl();
    return runtime.channel;
  }

  unregister(sessionId: string, connection?: DshSessionConnection): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    if (connection && runtime.connection !== connection) return;
    runtime.stream?.cancel();
    runtime.stream = undefined;
    this.sessions.delete(sessionId);
    for (const waiter of runtime.waiters) waiter();
    runtime.waiters.clear();
  }

  /** The follow snapshot for one session, waiting for it to arrive. */
  async snapshot(sessionId: string): Promise<DshFollowSnapshot | undefined> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return undefined;
    if (runtime.snapshot) return runtime.snapshot;
    if (runtime.snapshotSettled) return undefined;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        runtime.waiters.delete(finish);
        this.clearTimeoutImpl(timer);
        resolve();
      };
      const timer = this.setTimeoutImpl(finish, this.snapshotTimeoutMs);
      runtime.waiters.add(finish);
      if (runtime.snapshot || runtime.snapshotSettled) finish();
    });
    if (runtime.snapshot) return runtime.snapshot;
    this.note({ code: 'snapshot-timeout', detail: sessionId });
    return undefined;
  }

  async snapshotCursor(sessionId: string): Promise<number | undefined> {
    return (await this.snapshot(sessionId))?.cursor;
  }

  /**
   * Settle one waterfall decision.
   *
   * The distinction the receipt carries is the whole point: a refusal means the
   * host is finished with the request, while a request that never completed left
   * it open. Collapsing them either re-decides something the host already has or
   * tells the user a live approval is dead.
   */
  async settleWaterfall(action: string, eventId: string, outcome: DshEventOutcome): Promise<DshReceipt> {
    const link = this.events;
    const generation = link?.currentGeneration;
    if (!link || !generation) {
      throw new DshDriveError(action, {
        kind: 'transport',
        reason: 'generation-lost',
        retryable: true,
        detail: 'no verified DeepSeek Harness event generation is open to answer on',
      });
    }
    const receipt = await link.answer(eventId, outcome);
    if (receipt.ok) return { accepted: true };
    if (receipt.retryable === false) return { accepted: false, reason: 'not-pending' };
    throw new DshDriveError(action, {
      kind: 'transport',
      reason: 'unreachable',
      retryable: true,
      detail: receipt.detail ?? `${action} did not reach the DeepSeek Harness host`,
    });
  }

  private async answerEvent(clientId: string, eventId: string, outcome: DshEventOutcome): Promise<DshAnswerReceipt> {
    const result = await this.call<unknown>('$events/result', DshRemoteArgs.eventResult({ clientId, eventId, outcome }));
    if (result.ok) return { ok: true };
    const failure = result.failure;
    // A business refusal means the host read the answer and declined it: the
    // request is finished with, and sending again would be a second decision.
    if (failure.kind === 'rpc') return { ok: false, retryable: false, detail: `${failure.code}: ${failure.message}` };
    if (failure.kind === 'transport' && (failure.reason === 'unauthenticated' || failure.reason === 'forbidden'
      || failure.reason === 'generation-lost')) {
      return { ok: false, retryable: false, detail: failure.reason };
    }
    return { ok: false, retryable: true, detail: failure.kind === 'transport' ? failure.detail : undefined };
  }

  // ── Streams ───────────────────────────────────────────────────────────────

  private openFollow(runtime: SessionRuntime): void {
    const mux = this.mux;
    if (!mux || this.stopped) return;
    const stream = mux.open('session/follow', { args: DshRemoteArgs.follow({ sessionId: runtime.connection.info.id }) });
    runtime.stream = stream;
    runtime.carrier = mux.generation;
    void this.readFollow(runtime, stream, mux.generation);
  }

  private async readFollow(runtime: SessionRuntime, stream: DshMuxStream, carrier: number): Promise<void> {
    const sessionId = runtime.connection.info.id;
    try {
      for await (const raw of stream) {
        if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
        this.handleFollowItem(runtime, raw);
      }
    } catch (error) {
      if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
      const detail = error instanceof DshStreamError ? error.failure.code : 'stream-lost';
      this.note({ code: 'unusable-stream-item', detail: `session/follow: ${detail}` });
    }
    if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
    // The stream ended while the session is still attached. Whether the carrier
    // died or the host simply closed this one stream, this connection's picture
    // of the log is unverifiable: retract, and re-open on the current carrier so
    // the broker's wholesale re-read finds a snapshot waiting.
    runtime.stream = undefined;
    runtime.snapshot = undefined;
    runtime.snapshotSettled = false;
    runtime.connection.onGenerationLost();
    this.openFollow(runtime);
  }

  private handleFollowItem(runtime: SessionRuntime, raw: unknown): void {
    const item = record(raw);
    if (!item) {
      this.note({ code: 'unusable-stream-item', detail: 'follow item was not an object' });
      return;
    }
    switch (item.type) {
      case 'snapshot': {
        const cursor = optionalNumber(item.cursor);
        if (cursor === undefined) {
          this.note({ code: 'unusable-stream-item', detail: 'follow snapshot carried no cursor' });
          return;
        }
        runtime.snapshot = {
          cursor,
          records: historyEntries(item.records),
          hasMore: item.hasMore === true,
          ...(item.projections !== undefined ? { projections: item.projections } : {}),
        };
        runtime.snapshotSettled = true;
        // `session/subscribed` is the legacy frame whose whole job is the baseline
        // seq: it drives gap detection and re-priming. Handing the connection the
        // snapshot's cursor keeps that machinery, which was qualified against a
        // real host, doing exactly the job it was written for.
        runtime.connection.handleMuxFrame(bridgeFrame('session/subscribed', `snapshot-${String(cursor)}`, { sessionId: runtime.connection.info.id, lastSeq: cursor }));
        for (const waiter of runtime.waiters) waiter();
        runtime.waiters.clear();
        return;
      }
      case 'event': {
        const entry = historyEntry({ event: item.event });
        if (!entry) {
          this.note({ code: 'unusable-stream-item', detail: 'follow event item carried no usable event' });
          return;
        }
        runtime.connection.handleMuxFrame(bridgeFrame('session/event', `event-${String(entry.event.seq)}`, {
          sessionId: runtime.connection.info.id,
          event: entry.event,
          ...(entry.view !== undefined ? { view: entry.view } : {}),
        }));
        return;
      }
      case 'assistant-stream': {
        // Deliberately unread. Live assistant deltas are the one 0.2 surface this
        // build has never captured from a real host — the durable `assistant/*`
        // events on the same stream carry the settled text and ARE mapped — so the
        // honest action is to record that a transient surface exists and render
        // the settled row rather than guess at a frame shape.
        this.note({ code: 'ignored-assistant-stream' });
        return;
      }
      default:
        this.note({ code: 'unusable-stream-item', detail: `unknown follow item "${String(item.type)}"` });
    }
  }

  private ensureControl(): void {
    const mux = this.mux;
    if (!mux || this.stopped) return;
    if (this.controlStream && this.controlCarrier === mux.generation) return;
    const stream = mux.open('session/control', { args: {} });
    this.controlStream = stream;
    this.controlCarrier = mux.generation;
    void this.readControl(stream, mux.generation);
  }

  private async readControl(stream: DshMuxStream, carrier: number): Promise<void> {
    try {
      for await (const raw of stream) {
        if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
        this.handleControlItem(raw);
      }
    } catch (error) {
      if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
      this.note({ code: 'unusable-stream-item', detail: `session/control: ${error instanceof DshStreamError ? error.failure.code : 'stream-lost'}` });
    }
    if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
    this.controlStream = undefined;
    this.controlCarrier = -1;
    this.ensureControl();
  }

  private handleControlItem(raw: unknown): void {
    const item = record(raw);
    if (!item) return;
    if (item.type === 'baseline') {
      const projections = record(record(item.value)?.projections);
      if (!projections) return;
      for (const [sessionId, block] of Object.entries(projections)) {
        const runtime = this.sessions.get(sessionId);
        const values = record(block)?.values;
        const asOfSeq = optionalNumber(record(block)?.asOfSeq);
        if (!runtime || !values || asOfSeq === undefined) continue;
        for (const [key, value] of Object.entries(values)) {
          runtime.connection.handleMuxFrame(bridgeFrame('session/projection', `control-${sessionId}-${key}`, {
            sessionId,
            key,
            value,
            seq: asOfSeq,
          }));
        }
      }
      return;
    }
    if (item.type === 'projection') {
      const sessionId = optionalString(item.sessionId);
      const key = optionalString(item.key);
      const seq = optionalNumber(item.seq);
      if (!sessionId || !key || seq === undefined) return;
      this.sessions.get(sessionId)?.connection.handleMuxFrame(bridgeFrame('session/projection', `control-${sessionId}-${key}`, {
        sessionId,
        key,
        value: item.value,
        seq,
      }));
      return;
    }
    this.note({ code: 'unusable-stream-item', detail: `unknown control item "${String(item.type)}"` });
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private onCarrierOpen(carrier: number): void {
    // A fresh carrier means every stream that rode the previous one is gone.
    // Projections are host-wide, so their baseline is re-read here too.
    if (this.controlCarrier !== carrier) {
      this.controlStream = undefined;
      this.controlCarrier = -1;
      if (this.sessions.size > 0) this.ensureControl();
    }
    for (const runtime of this.sessions.values()) {
      if (runtime.carrier === carrier && runtime.stream) continue;
      runtime.stream = undefined;
      runtime.snapshot = undefined;
      runtime.snapshotSettled = false;
      this.openFollow(runtime);
    }
  }

  private onCarrierLost(reason: string): void {
    this.controlStream = undefined;
    this.controlCarrier = -1;
    for (const runtime of this.sessions.values()) {
      runtime.stream = undefined;
      runtime.snapshot = undefined;
      runtime.snapshotSettled = false;
      runtime.connection.onGenerationLost();
    }
    for (const handler of this.lostHandlers) handler(reason);
  }

  /**
   * A request the host is waiting on.
   *
   * Sessions cosyncing is NOT serving get `{kind:'next'}`, which hands the
   * decision down the host's own chain — its browser UI, its own TUI — rather
   * than holding a prompt open for a client that has no card to show. That is
   * also why a session cosyncing HAS open is never auto-answered: an approval is
   * a human's decision, and the card is the product's whole reason to be here.
   */
  private onWaterfall(frame: { eventId: string; agentId: string; event: string; request: Readonly<Record<string, unknown>> }): void {
    const runtime = this.sessions.get(frame.agentId);
    if (!runtime) {
      this.note({ code: 'waterfall-delegated', detail: frame.event });
      void this.events?.answer(frame.eventId, { kind: 'next' });
      return;
    }
    if (frame.event === 'approval/request') {
      const mapped = mapDshApproval(frame.eventId, {
        sessionId: frame.agentId,
        approvalId: optionalString(frame.request.callId) ?? frame.eventId,
        ...(optionalString(frame.request.toolName) ? { toolName: optionalString(frame.request.toolName) } : {}),
        ...(optionalString(frame.request.reason) ? { reason: optionalString(frame.request.reason) } : {}),
      });
      if (!mapped) {
        // Unmapped is not "no decision to make": delegating lets the host's own
        // chain answer instead of leaving a tool call parked forever.
        void this.events?.answer(frame.eventId, { kind: 'next' });
        return;
      }
      runtime.connection.handleMuxFrame(bridgeFrame('approval/requested', frame.eventId, {
        sessionId: frame.agentId,
        approvalId: mapped.approvalId,
        ...(optionalString(frame.request.toolName) ? { toolName: optionalString(frame.request.toolName) } : {}),
        ...(optionalString(frame.request.reason) ? { reason: optionalString(frame.request.reason) } : {}),
      }));
      return;
    }
    if (frame.event === 'user-questions/request') {
      const mapped = mapDshQuestion(frame.eventId, { sessionId: frame.agentId, questions: frame.request.questions });
      if (!mapped) {
        void this.events?.answer(frame.eventId, { kind: 'next' });
        return;
      }
      runtime.connection.handleMuxFrame(bridgeFrame('question/requested', frame.eventId, {
        sessionId: frame.agentId,
        questions: frame.request.questions,
      }));
    }
  }

  private onCancellation(eventId: string): void {
    for (const runtime of this.sessions.values()) runtime.connection.noteCancellation(eventId);
  }

  /**
   * The forwarded `$events` emits.
   *
   * Session transcript does NOT arrive here — it arrives on `session/follow` —
   * and the meaning of the host's other forwarded events has never been captured
   * for cosyncing, so nothing is mapped from a name. The event name is recorded so
   * a capture run can see what a real host actually forwards.
   */
  private onForwardedEvent(event: string): void {
    this.note({ code: 'unusable-stream-item', detail: `forwarded event not mapped: ${event}` });
  }

  private note(diagnostic: DshRemoteLinkDiagnostic): void {
    this.onDiagnostic?.(diagnostic);
  }
}
