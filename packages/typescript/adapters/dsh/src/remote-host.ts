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
import { transportFailure, type DshGenerationLossPolicy, type DshOutcome } from './envelope.ts';
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
  type DshStreamFailure,
} from './mux.ts';
import {
  DshRemoteArgs,
  DshRemoteClient,
  dshSessionAddress,
  type DshEventOutcome,
  type DshRemoteEndpoint,
} from './remote.ts';
import type { DshHistoryPage, DshPermissionCatalog, DshPermissionOption, DshSessionChannel } from './protocol.ts';
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

/**
 * Delays between attempts at a logical stream the host keeps refusing.
 *
 * The FIRST entry is 0 because a stream that ended once on a healthy carrier is
 * ordinary: the host closed one subscription and the carrier is fine, and the
 * recovery the qualified 0.1 path used was to re-subscribe at once. What must
 * never happen is a loop — a session that was removed, or a stream this build
 * cannot open, reopened as fast as the process can spin. So each consecutive
 * failure waits longer, and after the last entry the stream is withdrawn: the
 * session's live surface ends, and a re-attach is what starts it again.
 */
export const DSH_STREAM_RETRY_DELAYS_MS: readonly number[] = Object.freeze([0, 50, 200, 800, 2_000]);

/**
 * Records the current cut will not grow past, oldest-first.
 *
 * Sized to the history ceiling the connection itself pages with, so a session
 * cannot hold more rows by streaming them than it could hold by reading them.
 * Overflow drops the OLDEST rows and sets `hasMore`, which sends the reader to
 * `session/page` for them rather than losing them.
 */
export const DSH_FOLLOW_CUT_MAX_RECORDS = 2_000;

/**
 * How long a relinquished session's open interactions wait for a replacement
 * attach before cosyncing hands them to the host's own chain.
 *
 * A tab switch re-attaches in milliseconds and must not answer the user's
 * question for them; a session that is genuinely closed here has nobody left to
 * show the card, and leaving it parked on the host's waterfall chain is the
 * failure the delegation path exists to prevent.
 */
export const DSH_INTERACTION_HANDOFF_MS = 500;

/**
 * Stream failures a retry cannot change.
 *
 * Read off the code's own meaning rather than off a status code, because a mux
 * stream error carries the host's business code and nothing else:
 *
 *  - `carrier/*` is the CARRIER ending, and the carrier's own reconnect owns
 *    that. Reopening on a dead carrier is what the mux already refuses to do.
 *  - `gateway/{arguments,signature,protocol,definition,method}-invalid`-style
 *    codes say THIS REQUEST is not what the host serves. Asking again asks the
 *    same question.
 *  - anything naming a missing session (`*-not-found`) says the target is gone,
 *    which is the case that would otherwise spin the hardest: a removed session
 *    answers the same way forever.
 *
 * `gateway/service-unavailable` and `gateway/uplink-overflow` are deliberately
 * absent: those are "not now", and "not now" is what backoff is for.
 */
export const DSH_STREAM_TERMINAL_CODES: readonly string[] = Object.freeze([
  'carrier/closed',
  'carrier/lost',
  'gateway/arguments-invalid',
  'gateway/definition-unavailable',
  'gateway/input-invalid',
  'gateway/method-unavailable',
  'gateway/protocol',
  'gateway/signature-invalid',
  'gateway/unknown-endpoint',
]);

/**
 * Whether a stream failure is worth asking about again.
 *
 * A missing target is terminal in both spellings the host has been seen to use
 * (`session-not-found` on the unary route, a namespaced variant on a stream),
 * and an UNRECOGNISED code is treated as transient: the bound on retries is what
 * makes guessing safe, while guessing "terminal" would end a healthy session's
 * live surface on a code this build has simply never read.
 */
export function dshStreamFailureIsTerminal(failure: DshStreamFailure | undefined): boolean {
  if (!failure) return false;
  const code = failure.code;
  if (DSH_STREAM_TERMINAL_CODES.includes(code)) return true;
  return code.endsWith('-not-found') || code.endsWith('/not-found');
}

/** What the link saw that it could not use. Contained, bounded, and never fatal. */
export interface DshRemoteLinkDiagnostic {
  code: 'unusable-stream-item'
    | 'ignored-assistant-stream'
    | 'snapshot-timeout'
    | 'auth-refused'
    | 'waterfall-delegated'
    | 'forwarded-event-unmapped'
    | 'waterfall-replayed'
    | 'stream-retry'
    | 'stream-withdrawn'
    | 'credential-changed'
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

/**
 * The preset roster out of a `permissionPresets/catalog` answer.
 *
 * Read from `options` only. `defaultOptions` and `defaultPreset` describe what a
 * NEW session gets, and stamping one of those onto an existing session would
 * report a preset the host never said that session is running.
 */
function dshPermissionOptions(value: unknown): DshPermissionOption[] {
  const row = record(value);
  if (!Array.isArray(row?.options)) return [];
  const options: DshPermissionOption[] = [];
  for (const raw of row.options) {
    const entry = record(raw);
    const preset = optionalString(entry?.value);
    if (!preset) continue;
    options.push({
      value: preset,
      ...(optionalString(entry?.name) ? { name: optionalString(entry?.name) } : {}),
      ...(optionalString(entry?.description) ? { description: optionalString(entry?.description) } : {}),
    });
  }
  return options;
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

/**
 * The session's CURRENT cut: the snapshot the follow stream opened with, plus
 * every durable event that stream has delivered since.
 *
 * This exists because a follow snapshot is a statement about one moment. A
 * reader that comes back after the session has moved on has to be shown the
 * moment it is asking about, and answering every history read with the bytes
 * from attach time is how a reread, a compaction resync, or a client that
 * re-opens the transcript ends up being served yesterday's conversation.
 *
 * The rows are the host's own and arrive in log order on the same stream that
 * delivered the snapshot, so the cut is consistent by construction: no second
 * read is stitched onto it, and no row is invented to fill a gap.
 */
interface DshFollowCut {
  /** Highest seq the cut covers. Older pages are read `throughSeq` this. */
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
  /** What a history read answers with: {@link snapshot} plus the live tail since. */
  cut?: DshFollowCut;
  /** Consecutive failed opens ON THIS CARRIER. A delivered snapshot clears it. */
  retries: number;
  retryHandle?: unknown;
  /**
   * Set when the follow stream failed terminally or its retries ran out.
   *
   * The session's LIVE surface is over; its data is not. History keeps answering
   * from the last cut it held, and a re-attach (a new runtime) is what retries.
   */
  withdrawn?: string;
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
      const withdrawn = this.link.streamWithdrawn(this.sessionId);
      if (withdrawn) {
        // Say what happened. "History could not be read right now" would send an
        // operator at a network problem when the host has said this session is
        // gone, and a retry of a refusal is exactly the loop the withdraw ended.
        return transportFailure('unreachable', {
          retryable: false,
          detail: `this DeepSeek Harness session is no longer being followed: ${withdrawn}`,
        });
      }
      const cut = await this.link.cut(this.sessionId);
      if (!cut) {
        return transportFailure('unreachable', {
          retryable: true,
          detail: 'the DeepSeek Harness follow stream did not deliver a history snapshot',
        });
      }
      // A COPY. The cut is the live thing the follow stream extends row by row,
      // and a history page is a statement about the moment it was read: hand out
      // the array itself and a caller holding an earlier page watches it grow
      // underneath it, which is a different transcript from the one it was given.
      return {
        ok: true,
        value: {
          events: [...cut.records],
          hasMore: cut.hasMore,
          ...(cut.projections !== undefined ? { projections: cut.projections } : {}),
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
    // `non-idempotent-write`, for the reason the 0.1 driver gives for the same
    // flag on a create: a prompt whose receipt was lost in a reconnect may
    // already have started a turn, and a caller told "retryable" starts a second
    // one. The write guard in `call()` is what keeps it from being sent into an
    // epoch that ended during authentication.
    const outcome = await this.link.call<unknown>('session/prompt', DshRemoteArgs.prompt({
      requestId,
      sessionId,
      mode: options.mode ?? 'queue',
      content,
      ...(options.clientTimeZone ? { clientTimeZone: options.clientTimeZone } : {}),
    }), { generationLoss: 'non-idempotent-write' });
    if (!outcome.ok) throw new DshDriveError('prompt', outcome.failure);
  }

  async models(): Promise<DshSessionModels> {
    // Host-scoped: the catalog describes what the host serves, not what this
    // generation has observed, so a generation rotating under the read does not
    // make its answer wrong.
    const outcome = await this.link.call<unknown>('session/modelCatalog', DshRemoteArgs.modelCatalog(), {
      generationLoss: 'host-scoped',
    });
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
    }), { generationLoss: 'non-idempotent-write' });
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
      { generationLoss: 'non-idempotent-write' },
    );
    if (!outcome.ok) throw new DshDriveError('command', outcome.failure);
    return parseDshCommandExecution(outcome.value, 'command');
  }

  async cancel(sessionId: string): Promise<void> {
    const outcome = await this.link.call<unknown>('session/cancel', DshRemoteArgs.cancel(sessionId));
    if (!outcome.ok) throw new DshDriveError('cancel', outcome.failure);
  }

  /**
   * The host's preset roster, from the route that actually publishes it.
   *
   * The per-session `permissions` projection carries the CURRENT value and
   * nothing else on the captured build; the roster is host-wide. A picker built
   * from the projection alone is therefore empty on a host with three presets,
   * and the selector that validates a request against the picker refuses the
   * preset the session is already running.
   */
  async permissionCatalog(): Promise<DshPermissionCatalog | undefined> {
    return this.link.permissionCatalog();
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
  private controlRetries = 0;
  private controlRetryHandle?: unknown;
  /** The host-wide projection stream ended for good. See {@link readControl}. */
  private controlWithdrawn?: string;
  /**
   * The credential the CURRENT carrier shook hands with.
   *
   * Compared against {@link DshAuthSession.credentialRevision} at every point
   * where a request is issued, because a socket cannot re-negotiate what it was
   * authenticated with: an enrollment replaced or withdrawn mid-flight is a new
   * authorization, and the only honest reading of that is a new handshake.
   */
  private carrierCredential = -1;
  /** Forwarded event names seen on this carrier, each recorded once. */
  private readonly forwardedNames = new Set<string>();
  /** Sessions that gave up their open interactions pending a replacement attach. */
  private readonly handoffs = new Map<string, { timer: unknown; eventIds: string[] }>();
  /** Host-wide permission-preset catalog, valid for one carrier generation. */
  private permissionCatalogValue?: readonly DshPermissionOption[];
  private permissionCatalogCarrier = -1;
  private started = false;
  private stopped = false;
  private readonly lostHandlers = new Set<(reason: string) => void>();
  private readonly unsubscribeCredential: () => void;

  constructor(options: DshRemoteHostLinkOptions) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    this.remote = options.remote;
    // The enrollment is a file another process writes. When it changes, the
    // carrier riding the old credential is retired rather than kept as a
    // connection still streaming under an authorization nobody holds.
    this.unsubscribeCredential = this.auth.onCredentialChange((change) => this.onCredentialChanged(change));
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

  /**
   * Authenticated, holding a verified event generation, and holding it with the
   * credential the carrier actually shook hands with.
   *
   * The last clause is what an enrollment change does to a live link: the socket
   * is still open and the generation is still verified, but the credential behind
   * both is not the one on file, which is exactly the moment writes must stop.
   */
  get isReady(): boolean {
    return this.auth.cookieHeader() !== null
      && this.carrierCredential === this.auth.credentialRevision
      && (this.events?.isVerified ?? false);
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
   *
   * THE ASYNC GAP IS THE POINT. Authentication is awaited, and a lot can end
   * while a call waits: the carrier can drop, the event generation can be
   * retracted, the enrollment can come back holding a different cookie. So the
   * epoch is captured BEFORE that wait and re-checked after it, and what the
   * re-check costs depends on what the call was:
   *
   *  - `epoch-bound` (the default) — refuse it. Nothing left this process, so
   *    the caller re-issues after the re-baseline.
   *  - `host-scoped` — let it through. A roster or catalog read describes the
   *    HOST, and an unrelated generation rotating does not make its answer
   *    wrong. Aborting one is how a live attach made discovery intermittently
   *    report a healthy host as unavailable.
   *  - `non-idempotent-write` — refuse it only when it has provably NOT been
   *    sent, and say that in the failure. A prompt that reached the host cannot
   *    be unsent, and a caller told "retryable" after an ambiguous outcome sends
   *    a second turn. So the guard asks whether the link is ready at the moment
   *    of the send rather than trusting what it read a few hundred milliseconds
   *    earlier.
   */
  async call<T>(
    endpoint: DshRemoteEndpoint,
    args: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal; generationLoss?: DshGenerationLossPolicy },
  ): Promise<DshOutcome<T>> {
    const policy = options?.generationLoss ?? 'epoch-bound';
    const carrier = this.generation;
    const clientId = this.events?.currentGeneration?.clientId;
    // The credential in hand when this call started, if it had one. Getting to
    // an authenticated state is `ensure()`'s JOB, so a call that entered with
    // nothing and left holding the enrollment's cookie succeeded rather than
    // lost its epoch; what the fence has to catch is holding one credential,
    // waiting, and finding the enrollment now holds a different one (or none),
    // because those bytes would go out under an authorization the caller never
    // saw. A renewal in flight trips this too, which costs one refused call
    // per renewal -- and renewals are bounded by the expiry window, so the
    // refusal cannot loop.
    const cookieAtEntry = this.auth.cookieHeader();
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
    if (cookieAtEntry !== null && cookieAtEntry !== this.auth.cookieHeader()) {
      // The enrollment itself moved while this call was authenticating. Headers
      // are read per request, so the bytes WOULD go out under the new credential
      // while the caller's picture of the host was taken under the old one.
      return transportFailure('generation-lost', {
        retryable: policy !== 'non-idempotent-write',
        detail: 'the DeepSeek Harness enrollment changed while the call was authenticating, so it was not issued',
      });
    }
    if (policy === 'non-idempotent-write') {
      if (!this.isReady || this.generation !== carrier) {
        return transportFailure('generation-lost', {
          retryable: true,
          detail: 'the DeepSeek Harness host stopped being ready; the write was not sent',
        });
      }
    } else if (policy === 'epoch-bound'
      && (this.generation !== carrier || clientId !== this.events?.currentGeneration?.clientId)) {
      return transportFailure('generation-lost', {
        retryable: true,
        detail: 'the DeepSeek Harness generation ended while the call was authenticating',
      });
    }
    const outcome = await this.remote.call<T>(endpoint, args, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(policy === 'epoch-bound' ? {} : { generationLoss: policy }),
    });
    if (policy === 'epoch-bound'
      && outcome.ok
      && (this.generation !== carrier || clientId !== this.events?.currentGeneration?.clientId)) {
      // The answer is real, but it describes a host this caller is no longer
      // talking to. The transport is asked to abort in flight and normally
      // obliges; a response that was already on its way back when the carrier
      // died still arrives, and handing it over is worse than refusing it: the
      // caller has already been told to re-baseline, so a projection read that
      // lands late would be folded into a picture it does not belong to.
      //
      // Writes are exempt on purpose. A successful write response is the host
      // saying the write HAPPENED, and reporting a failure there is what
      // produces the second prompt.
      return transportFailure('generation-lost', {
        retryable: true,
        detail: 'the DeepSeek Harness generation ended while the call was in flight, so its answer was discarded',
      });
    }
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
    if (this.controlRetryHandle !== undefined) {
      this.clearTimeoutImpl(this.controlRetryHandle);
      this.controlRetryHandle = undefined;
    }
    for (const handoff of this.handoffs.values()) this.clearTimeoutImpl(handoff.timer);
    this.handoffs.clear();
    for (const session of this.sessions.values()) {
      session.stream?.cancel();
      session.stream = undefined;
      if (session.retryHandle !== undefined) {
        this.clearTimeoutImpl(session.retryHandle);
        session.retryHandle = undefined;
      }
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
        // Host-scoped: a roster describes the HOST, and a session stream
        // rotating mid-sweep is not evidence that the host has no sessions.
        { ...(signal ? { signal } : {}), generationLoss: 'host-scoped' },
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
    const outcome = await this.call<unknown>('session/modelCatalog', DshRemoteArgs.modelCatalog(), {
      ...(signal ? { signal } : {}),
      generationLoss: 'host-scoped',
    });
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
    // Routed through `call()` rather than the raw client, so a create passes the
    // same authenticated, current-generation write guard as a prompt. It used to
    // reach the transport directly, which meant the one write that must never be
    // retried was the one write with no readiness fence in front of it.
    const outcome = await this.call<unknown>('session/create', DshRemoteArgs.create(request), {
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
    const outcome = await this.call<unknown>('session/rename', DshRemoteArgs.rename(sessionId, title), {
      generationLoss: 'non-idempotent-write',
    });
    if (!outcome.ok) throw new DshDriveError('rename', outcome.failure);
    return optionalString(record(outcome.value)?.title) ?? title;
  }

  async selectModelHost(sessionId: string, selection: DshModelSelection): Promise<DshModelSelection> {
    const outcome = await this.call<unknown>('session/selectModel', DshRemoteArgs.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    }), { generationLoss: 'non-idempotent-write' });
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

  /**
   * Attach a session: open its follow stream, take the host-wide control stream,
   * and take over any interaction its previous connection was holding.
   *
   * The last part is what makes a re-attach a re-attach rather than a new
   * session. The host's waterfall chain does not care that cosyncing swapped the
   * connection underneath it: an approval raised before the swap is still open,
   * still answerable, and still the user's decision. Show it on the new
   * connection through the same route a fresh one arrives on, so the same
   * generation, cancellation and competing-answer fences apply to a replayed
   * card as to a new one.
   */
  register(connection: DshSessionConnection, channel = this.channel(connection.info.id)): DshRemoteSessionChannel {
    const sessionId = connection.info.id;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // A replacement attach must not inherit the superseded connection's
      // snapshot: the broker re-reads history through the NEW connection, and a
      // held snapshot would answer it with bytes taken for the old one.
      existing.stream?.cancel();
      if (existing.retryHandle !== undefined) this.clearTimeoutImpl(existing.retryHandle);
      existing.waiters.clear();
      this.sessions.delete(sessionId);
    }
    // A replacement attach means this session is being served here, so the
    // handoff that its departure started is called off before the pending
    // requests below are replayed. Without this the delegate could land after
    // the replay and answer a card that is on screen right now.
    this.cancelHandoff(sessionId);
    const runtime: SessionRuntime = {
      connection,
      channel,
      carrier: this.generation,
      snapshotSettled: false,
      waiters: new Set(),
      retries: 0,
    };
    this.sessions.set(sessionId, runtime);
    this.start();
    this.openFollow(runtime);
    this.ensureControl();
    for (const frame of this.events?.pendingWaterfalls() ?? []) {
      if (frame.agentId !== sessionId) continue;
      this.note({ code: 'waterfall-replayed', detail: frame.event });
      this.onWaterfall(frame);
    }
    return runtime.channel;
  }

  unregister(sessionId: string, connection?: DshSessionConnection): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    if (connection && runtime.connection !== connection) return;
    runtime.stream?.cancel();
    runtime.stream = undefined;
    if (runtime.retryHandle !== undefined) {
      this.clearTimeoutImpl(runtime.retryHandle);
      runtime.retryHandle = undefined;
    }
    this.sessions.delete(sessionId);
    for (const waiter of runtime.waiters) waiter();
    runtime.waiters.clear();
    this.handoffInteractions(sessionId);
  }

  /**
   * Why this session is not being followed, when that is the case.
   *
   * A withdrawn stream is a refusal by the host, and a refusal reported as a
   * timeout is an invitation to retry it forever.
   */
  streamWithdrawn(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.withdrawn;
  }

  /** The session's current cut, waiting for the follow snapshot that opens it. */
  async cut(sessionId: string): Promise<DshFollowCut | undefined> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return undefined;
    if (runtime.cut) return runtime.cut;
    if (runtime.withdrawn) return undefined;
    if (runtime.snapshotSettled) return undefined;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        runtime.waiters.delete(finish);
        this.clearTimeoutImpl(timer);
        resolve();
      };
      const timer = this.setTimeoutImpl(finish, this.snapshotTimeoutMs);
      runtime.waiters.add(finish);
      if (runtime.cut || runtime.snapshotSettled || runtime.withdrawn) finish();
    });
    if (runtime.cut) return runtime.cut;
    if (runtime.withdrawn) return undefined;
    this.note({ code: 'snapshot-timeout', detail: sessionId });
    return undefined;
  }

  /** The seq older pages are read through: the tail of the current cut. */
  async snapshotCursor(sessionId: string): Promise<number | undefined> {
    return (await this.cut(sessionId))?.cursor;
  }

  /**
   * The host's permission-preset catalog, read once per carrier generation.
   *
   * Cached because it is host-wide and the composer asks for it on every
   * attach; scoped to the carrier because a host that came back under a new
   * generation may be a host with different presets composed, and a picker
   * built from a dead generation's answer is a picker that offers presets this
   * host will refuse.
   */
  async permissionCatalog(): Promise<DshPermissionCatalog | undefined> {
    const carrier = this.generation;
    if (this.permissionCatalogValue && this.permissionCatalogCarrier === carrier) {
      return { options: this.permissionCatalogValue };
    }
    const outcome = await this.call<unknown>('permissionPresets/catalog', DshRemoteArgs.permissionCatalog(), {
      generationLoss: 'host-scoped',
    });
    if (!outcome.ok) return undefined;
    const options = dshPermissionOptions(outcome.value);
    if (options.length === 0) return undefined;
    this.permissionCatalogValue = options;
    this.permissionCatalogCarrier = carrier;
    const row = record(outcome.value);
    const defaultPreset = optionalString(row?.defaultPreset);
    return { options, ...(defaultPreset ? { defaultPreset } : {}) };
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
    // A decision is a write. If the answer reached the host, the request is
    // settled and the receipt is the only proof of that; a carrier dying
    // mid-flight must not turn it into a retryable failure, because the retry is
    // a SECOND decision on one approval. The event link's own claim map is what
    // stops a duplicate being sent while one is in flight; this is what stops a
    // reconnect from making the first one look unsent.
    const result = await this.call<unknown>('$events/result', DshRemoteArgs.eventResult({ clientId, eventId, outcome }), {
      generationLoss: 'non-idempotent-write',
    });
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
    if (runtime.withdrawn) return;
    const mux = this.mux;
    if (!mux || this.stopped) return;
    const stream = mux.open('session/follow', { args: DshRemoteArgs.follow({ sessionId: runtime.connection.info.id }) });
    runtime.stream = stream;
    runtime.carrier = mux.generation;
    void this.readFollow(runtime, stream, mux.generation);
  }

  private async readFollow(runtime: SessionRuntime, stream: DshMuxStream, carrier: number): Promise<void> {
    const sessionId = runtime.connection.info.id;
    let failure: DshStreamFailure | undefined;
    try {
      for await (const raw of stream) {
        if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
        this.handleFollowItem(runtime, raw);
      }
    } catch (error) {
      if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
      failure = error instanceof DshStreamError ? error.failure : undefined;
      this.note({ code: 'unusable-stream-item', detail: `session/follow: ${failure?.code ?? 'stream-lost'}` });
    }
    if (this.sessions.get(sessionId) !== runtime || carrier !== runtime.carrier) return;
    this.retryFollow(runtime, failure);
  }

  /**
   * The stream a still-attached session was reading has ended.
   *
   * Two answers, and which one applies is what the host said:
   *
   *  - Ask again, on a delay that grows, for as long as the delay table lasts. A
   *    session that was unreadable for a moment comes back on its own; the bound
   *    is what stops a session that is NOT unreadable for a moment — removed, or
   *    a stream this build cannot open — from turning both processes into a pair
   *    of politely spinning tops. The reproducer this exists for managed 26 opens
   *    in three milliseconds; a bounded ladder cannot.
   *  - Stop, when asking again cannot change the answer. The live surface of
   *    THIS session ends: its connection is told its picture is unverifiable, and
   *    later reads say why instead of waiting out a timeout. The carrier, the
   *    event generation and every other session on the socket are untouched.
   *
   * Either way the held cut goes with the stream. A cut that can no longer be
   * extended is not a cut, and serving one as if it were current is how a session
   * quietly becomes a museum.
   */
  private retryFollow(runtime: SessionRuntime, failure: DshStreamFailure | undefined): void {
    const sessionId = runtime.connection.info.id;
    runtime.stream = undefined;
    runtime.snapshot = undefined;
    runtime.cut = undefined;
    runtime.snapshotSettled = false;
    runtime.connection.onGenerationLost();
    for (const waiter of runtime.waiters) waiter();
    runtime.waiters.clear();
    if (dshStreamFailureIsTerminal(failure)) {
      this.withdrawSession(runtime, failure?.code ?? 'stream-ended');
      return;
    }
    const attempts = runtime.retries;
    if (attempts >= DSH_STREAM_RETRY_DELAYS_MS.length) {
      this.withdrawSession(runtime, `session/follow retried ${String(attempts)} times`);
      return;
    }
    runtime.retries = attempts + 1;
    const delay = DSH_STREAM_RETRY_DELAYS_MS[attempts] ?? 0;
    if (delay === 0) {
      this.openFollow(runtime);
      return;
    }
    this.note({ code: 'stream-retry', detail: `session/follow:${String(delay)}` });
    runtime.retryHandle = this.setTimeoutImpl(() => {
      runtime.retryHandle = undefined;
      if (this.sessions.get(sessionId) !== runtime) return;
      this.openFollow(runtime);
    }, delay);
  }

  /** End one session's live surface without touching its host, its carrier, or its siblings. */
  private withdrawSession(runtime: SessionRuntime, reason: string): void {
    runtime.withdrawn = reason;
    runtime.stream = undefined;
    if (runtime.retryHandle !== undefined) {
      this.clearTimeoutImpl(runtime.retryHandle);
      runtime.retryHandle = undefined;
    }
    // Release anyone waiting on a snapshot that is now never coming, so a history
    // read returns its notice instead of spending the snapshot timeout.
    for (const waiter of runtime.waiters) waiter();
    runtime.waiters.clear();
    this.note({ code: 'stream-withdrawn', detail: `${runtime.connection.info.id}:${reason}` });
  }

  /** Extend the current cut with one durable event, keeping it a cut rather than a pile. */
  private adoptFollowEvent(runtime: SessionRuntime, entry: DshHistoryEntry): void {
    const cut = runtime.cut;
    const seq = entry.event.seq;
    if (!cut || typeof seq !== 'number' || !Number.isFinite(seq)) return;
    // Only rows AHEAD of the cut extend it. At or below it the stream is
    // replaying something the connection's own admit gate already decides about,
    // and a row genuinely missing from the middle is a gap the connection reports
    // as a wholesale re-read — not something to paper over by guessing where it
    // ought to have sat.
    if (seq <= cut.cursor) return;
    cut.records.push(entry);
    cut.cursor = seq;
    if (cut.records.length <= DSH_FOLLOW_CUT_MAX_RECORDS) return;
    // Bounded: drop the oldest rows and record that there was something before
    // them, which is exactly what sends the next reader to `session/page`.
    cut.records.splice(0, cut.records.length - DSH_FOLLOW_CUT_MAX_RECORDS);
    cut.hasMore = true;
    this.note({ code: 'unusable-stream-item', detail: 'follow cut truncated at the record ceiling' });
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
        const snapshot: DshFollowSnapshot = {
          cursor,
          records: historyEntries(item.records),
          hasMore: item.hasMore === true,
          ...(item.projections !== undefined ? { projections: item.projections } : {}),
        };
        runtime.snapshot = snapshot;
        // A fresh snapshot is a fresh cut AND proof the stream is alive, so the
        // retry clock starts over: a session that survives ten reconnects never
        // runs out of retries, while a host that answers nothing but errors runs
        // out in a bounded number of opens.
        runtime.cut = {
          cursor: snapshot.cursor,
          records: snapshot.records,
          hasMore: snapshot.hasMore,
          ...(snapshot.projections !== undefined ? { projections: snapshot.projections } : {}),
        };
        runtime.retries = 0;
        runtime.withdrawn = undefined;
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
        this.adoptFollowEvent(runtime, entry);
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
    // A terminal failure here is a statement about the STREAM, not about the
    // sessions, so it is not retried until the carrier changes or somebody
    // attaches again. Projections go stale; transcripts do not stop.
    if (this.controlWithdrawn) return;
    if (this.controlStream && this.controlCarrier === mux.generation) return;
    const stream = mux.open('session/control', { args: {} });
    this.controlStream = stream;
    this.controlCarrier = mux.generation;
    void this.readControl(stream, mux.generation);
  }

  private async readControl(stream: DshMuxStream, carrier: number): Promise<void> {
    let failure: DshStreamFailure | undefined;
    try {
      for await (const raw of stream) {
        if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
        this.handleControlItem(raw);
      }
    } catch (error) {
      if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
      failure = error instanceof DshStreamError ? error.failure : undefined;
      this.note({ code: 'unusable-stream-item', detail: `session/control: ${failure?.code ?? 'stream-lost'}` });
    }
    if (this.controlStream !== stream || carrier !== this.controlCarrier) return;
    this.controlStream = undefined;
    this.controlCarrier = -1;
    if (dshStreamFailureIsTerminal(failure)) {
      this.controlWithdrawn = failure?.code ?? 'stream-ended';
      this.note({ code: 'stream-withdrawn', detail: `session/control:${this.controlWithdrawn}` });
      return;
    }
    const attempts = this.controlRetries;
    if (attempts >= DSH_STREAM_RETRY_DELAYS_MS.length) {
      this.controlWithdrawn = `session/control retried ${String(attempts)} times`;
      this.note({ code: 'stream-withdrawn', detail: this.controlWithdrawn });
      return;
    }
    this.controlRetries = attempts + 1;
    const delay = DSH_STREAM_RETRY_DELAYS_MS[attempts] ?? 0;
    if (delay === 0) {
      this.ensureControl();
      return;
    }
    this.note({ code: 'stream-retry', detail: `session/control:${String(delay)}` });
    this.controlRetryHandle = this.setTimeoutImpl(() => {
      this.controlRetryHandle = undefined;
      this.ensureControl();
    }, delay);
  }

  private handleControlItem(raw: unknown): void {
    const item = record(raw);
    if (!item) return;
    if (item.type === 'baseline') {
      // A baseline is proof the stream is working; the retry clock restarts, so a
      // host that reconnects occasionally never spends the whole ladder.
      this.controlRetries = 0;
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
      if (this.controlRetryHandle !== undefined) {
        this.clearTimeoutImpl(this.controlRetryHandle);
        this.controlRetryHandle = undefined;
      }
      this.controlStream = undefined;
      this.controlCarrier = -1;
      // A new carrier is a new host process for the purposes of a refusal: the
      // ladder that ran out on the last one is not carried over.
      this.controlRetries = 0;
      this.controlWithdrawn = undefined;
      if (this.sessions.size > 0) this.ensureControl();
    }
    this.carrierCredential = this.auth.credentialRevision;
    for (const runtime of this.sessions.values()) {
      if (runtime.carrier === carrier && runtime.stream) continue;
      runtime.stream = undefined;
      runtime.snapshot = undefined;
      runtime.cut = undefined;
      runtime.snapshotSettled = false;
      // The carrier coming back is the retry budget coming back with it: a
      // session whose stream was withdrawn because the SOCKET died gets another
      // run, and one whose stream the host refused for a terminal reason keeps
      // that verdict, because a new socket asks the same question.
      if (runtime.withdrawn && !runtime.withdrawn.includes('retried')) {
        runtime.withdrawn = undefined;
        runtime.retries = 0;
      }
      this.openFollow(runtime);
    }
  }

  private onCarrierLost(reason: string): void {
    this.controlStream = undefined;
    this.controlCarrier = -1;
    if (this.controlRetryHandle !== undefined) {
      this.clearTimeoutImpl(this.controlRetryHandle);
      this.controlRetryHandle = undefined;
    }
    // Epoch-bound unary calls die with the epoch they were issued under. A
    // projection read that lands after the generation it described has ended is
    // not a late answer, it is a wrong one, and the connection would have no way
    // to tell it apart from a current one.
    this.remote.abortInFlight();
    for (const runtime of this.sessions.values()) {
      runtime.stream = undefined;
      runtime.snapshot = undefined;
      runtime.cut = undefined;
      runtime.snapshotSettled = false;
      if (runtime.retryHandle !== undefined) {
        this.clearTimeoutImpl(runtime.retryHandle);
        runtime.retryHandle = undefined;
      }
      // The carrier, not the session, gave up: the retry ladder starts over on
      // the new one, and a stream that was withdrawn for a terminal reason stays
      // withdrawn for the same reason.
      if (runtime.withdrawn && !runtime.withdrawn.includes('retried')) {
        runtime.withdrawn = undefined;
        runtime.retries = 0;
      }
      runtime.connection.onGenerationLost();
    }
    for (const handler of this.lostHandlers) handler(reason);
  }

  /**
   * The enrollment was adopted, replaced or withdrawn while this link was up.
   *
   * A WebSocket authenticates once, at its handshake, and keeps that credential
   * for its life. So an enrollment change is a generation change by another name:
   * epoch-bound requests are taken down with the epoch they were issued under,
   * the carrier is closed, and — when there is still a credential to connect
   * with, and something on this socket that wants one — a fresh handshake is
   * started with the credential the store actually holds.
   *
   * A withdrawal is NOT restarted. Reconnecting to a host the operator has just
   * unenrolled is the one thing `cosy dsh disconnect` promises not to do.
   */
  private onCredentialChanged(change: 'adopted' | 'replaced' | 'removed'): void {
    this.note({ code: 'credential-changed', detail: change });
    this.remote.abortInFlight();
    const wasRunning = this.mux !== undefined;
    if (!wasRunning) return;
    this.detachCarrier(change === 'removed'
      ? 'the DeepSeek Harness enrollment was withdrawn'
      : 'the DeepSeek Harness session cookie was replaced');
    if (change === 'removed') return;
    if (this.stopped || !this.started || this.auth.cookieHeader() === null) return;
    if (this.sessions.size === 0) return;
    this.start();
  }

  /** Close the carrier and event link this link owns, leaving every session re-attachable. */
  private detachCarrier(reason: string): void {
    const events = this.events;
    const mux = this.mux;
    this.events = undefined;
    this.mux = undefined;
    this.controlStream = undefined;
    this.controlCarrier = -1;
    if (this.controlRetryHandle !== undefined) {
      this.clearTimeoutImpl(this.controlRetryHandle);
      this.controlRetryHandle = undefined;
    }
    events?.stop();
    mux?.stop();
    for (const runtime of this.sessions.values()) {
      runtime.stream = undefined;
      runtime.snapshot = undefined;
      runtime.cut = undefined;
      runtime.snapshotSettled = false;
      runtime.connection.onGenerationLost();
    }
    for (const handler of this.lostHandlers) handler(reason);
  }

  /**
   * The requests a departing session was holding, given a bounded chance to find
   * a new one before they are handed to the host's own chain.
   *
   * This is the ownership rule, stated once: cosyncing answers an interaction
   * while it has a connection showing the card, and delegates it as soon as it
   * does not. The window exists because "closed the tab" and "switched views"
   * look identical from inside the broker for a few hundred milliseconds, and
   * answering a user's question on their behalf because they opened a second
   * window is not a conservative default.
   */
  private handoffInteractions(sessionId: string): void {
    const pending = (this.events?.pendingWaterfalls() ?? [])
      .filter((frame) => frame.agentId === sessionId)
      .map((frame) => frame.eventId);
    if (pending.length === 0) return;
    this.cancelHandoff(sessionId);
    const timer = this.setTimeoutImpl(() => {
      this.handoffs.delete(sessionId);
      // A replacement attach means the cards are on screen again, and a
      // delegation issued now would answer a live card.
      if (this.sessions.has(sessionId)) return;
      const stillOpen = new Set((this.events?.pendingWaterfalls() ?? [])
        .filter((frame) => frame.agentId === sessionId)
        .map((frame) => frame.eventId));
      for (const eventId of pending) {
        if (!stillOpen.has(eventId)) continue;
        this.note({ code: 'waterfall-delegated', detail: sessionId });
        void this.events?.answer(eventId, { kind: 'next' });
      }
    }, DSH_INTERACTION_HANDOFF_MS);
    this.handoffs.set(sessionId, { timer, eventIds: pending });
  }

  private cancelHandoff(sessionId: string): void {
    const handoff = this.handoffs.get(sessionId);
    if (!handoff) return;
    this.clearTimeoutImpl(handoff.timer);
    this.handoffs.delete(sessionId);
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
  /**
   * Record a forwarded event name this build has no mapping for.
   *
   * Its own code rather than `unusable-stream-item`, because the two facts are
   * opposite: that one means the host sent something we should have understood
   * and did not, this one means the host told us something whose meaning nobody
   * has observed yet. Folding them together makes an unknown name look like a
   * parser bug in every report, which is exactly the signal a capture run needs
   * to be able to tell apart. Names are recorded, never bodies: a body is where
   * a host's content would live, and this build has not earned an opinion about
   * one.
   */
  private onForwardedEvent(event: string): void {
    if (this.forwardedNames.has(event)) return;
    this.forwardedNames.add(event);
    this.note({ code: 'forwarded-event-unmapped', detail: event });
  }

  private note(diagnostic: DshRemoteLinkDiagnostic): void {
    this.onDiagnostic?.(diagnostic);
  }
}
