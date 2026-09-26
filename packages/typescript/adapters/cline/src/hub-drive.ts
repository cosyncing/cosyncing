/** Production Cline Drive over one broker-owned isolated Hub connection. */
import type {
  AgentMessage,
  AgentMessageHandler,
  HistorySourceIdentity,
  ModeOption,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { TerminalSummaryRegistry } from '@cosyncing/adapter-api';
import {
  ClineHubClient,
  type ClineHubEvent,
  clineHubEpoch,
  clineHubHistoryIdentity,
  parseClineHubMessages,
  sameClineHubHistoryIdentity,
} from './hub.ts';
import { clineMessageKey, clineTurnId, clineTurnTokens, clineUserText, mapClineTranscript } from './mapping.ts';
import type { ClineMapTrace, ClineTerminalSummary } from './mapping.ts';
import {
  CLINE_MAX_PROMPT_CORRELATIONS,
  clineNativeMessageDigest,
  clinePromptCorrelationHistoryIdentity,
  clineTerminalSummaryHistoryIdentity,
  type ClineNativeMessage,
  type ClinePromptCorrelation,
  type ClinePromptCorrelations,
} from './store.ts';

/** Bounded poll for token counts that land after the turn settles.
 *
 *  Sized to finish well inside a reader's late-telemetry window rather than to
 *  be generous: four reads at 400ms plus four Hub round-trips ran to roughly two
 *  seconds, which is exactly the budget the raw-wire oracle allows for telemetry
 *  arriving after a turn completes (`CORE_TELEMETRY_SETTLE_MS`). Counts that
 *  land after that window are real but arrive to nobody still listening, so the
 *  poll must be short, not long. */
const CLINE_LATE_USAGE_ATTEMPTS = 3;
const CLINE_LATE_USAGE_INTERVAL_MS = 200;

/** How long Stop waits for the prior run's reply once native idle is proved.
 *
 *  Do not raise this hoping the reply is merely slow -- it was tried, with a
 *  measurement that looked conclusive and was not. At a 5000ms bound the chain
 *  settled at 5055ms; at 15000ms it settled at 15050ms. Always ~50ms PAST
 *  whatever the bound was, because giving up is what settles it: the timeout
 *  demotes, the demotion rejects the in-flight prompt, and the chain resolves.
 *  The native reply to an aborted `run.start` never arrives on its own, so a
 *  larger bound buys nothing and costs the user the whole wait before the same
 *  read-only outcome. */
const CLINE_AUTHORITY_SETTLE_MS = 5_000;

const MAX_PENDING_PROMPTS = 64;
const MAX_PENDING_PERMISSIONS = 64;
const MAX_FIELD_CHARS = 4_096;

interface PendingPrompt {
  key: string;
  text: string;
  beforeMessages: readonly ClineNativeMessage[];
  row: Extract<AgentMessage, { type: 'user-message' }>;
}

interface PendingPermission {
  message: Extract<AgentMessage, { type: 'permission-request' }>;
  approvalId: string;
}

interface UnpublishedPromptCorrelation {
  correlation: ClinePromptCorrelation;
  claimedBoundary: HistorySourceIdentity;
}

interface ClineNativeTerminal {
  finishReason: 'completed' | 'aborted' | 'failed' | 'error';
  text?: string;
}

export interface ClineHubDriveOptions {
  info: SessionInfo;
  client: ClineHubClient;
  profileRoot: string;
  models: readonly ModelOption[];
  modes: readonly ModeOption[];
  permissionMode: string;
  expectedHistoryBoundary?: HistorySourceIdentity;
  promptCorrelations?: ClinePromptCorrelations;
  terminalSummaries?: readonly ClineTerminalSummary[];
  terminalSummaryRegistry?: TerminalSummaryRegistry<ClineTerminalSummary>;
  requireEmptyIdleBoundary?: boolean;
  trace?: (event: ClineMapTrace | { op: 'observe'; detail: string }) => void;
  onHistoryBoundary?: (
    identity: HistorySourceIdentity,
    terminalSummary?: ClineTerminalSummary,
  ) => void;
  onPromptCorrelation?: (correlation: ClinePromptCorrelation) => void;
  onDemote?: (connection: ClineHubDriveConnection) => void;
  onClose?: (connection: ClineHubDriveConnection) => void;
  onConfiguration?: (connection: ClineHubDriveConnection) => void;
  createManagementClient?: () => Promise<ClineHubClient>;
  onUnsafeAuthority?: (reason: string) => Promise<void>;
  renameNativeTitle?: (title: string) => Promise<boolean>;
  turnTimeoutSeconds?: number;
  authoritySettleTimeoutMs?: number;
}

export class ClineHubCreateBoundaryUnprovenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClineHubCreateBoundaryUnprovenError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function field(value: unknown, maxChars = MAX_FIELD_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function terminalText(payload: Record<string, unknown>): string | undefined {
  const error = record(payload.error);
  return field(payload.text, MAX_FIELD_CHARS)
    ?? field(payload.error, MAX_FIELD_CHARS)
    ?? field(error?.message, MAX_FIELD_CHARS)
    ?? field(payload.reason, MAX_FIELD_CHARS);
}

function sessionIsRunning(status: string): boolean {
  return status === 'running' || status === 'pending';
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sameModel(left: PromptInput['model'] | undefined, right: SessionInfo['currentModel']): boolean {
  return left !== undefined && right !== undefined
    && left.providerID === right.providerID && left.modelID === right.modelID
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '');
}

function nativeUserText(message: ClineNativeMessage): string | undefined {
  if (message.role !== 'user' || message.content.length !== 1) return undefined;
  const block = message.content[0];
  return block?.type === 'text' ? clineUserText(block.text) : undefined;
}

function messageIds(messages: readonly ClineNativeMessage[]): string[] {
  return messages.map((message) => message.id);
}

function isPrefix(before: readonly ClineNativeMessage[], after: readonly ClineNativeMessage[]): boolean {
  return before.length <= after.length
    && before.every((message, index) => JSON.stringify(message) === JSON.stringify(after[index]));
}

/**
 * Cline persists tool results as `role: 'user'` messages whose blocks are `tool_result` — the same
 * shape `mapping.ts` decodes into `tool-result`. They are the tool transport of the assistant's own
 * turn, not a competing human prompt. Reading them as user rows made the FIRST tool-using turn of
 * every managed session look like a foreign write and demote its own Drive.
 *
 * A row that merely CONTAINS a tool result alongside real text stays a user row, so a genuine
 * prompt can never be silently discounted.
 */
function isNativeToolResultCarrier(message: ClineNativeMessage): boolean {
  return message.role === 'user'
    && message.content.length > 0
    && message.content.every((block) => block?.type === 'tool_result');
}

/** Rows the assistant's own turn produces: its reply, and the tool results feeding it. */
export function isTurnInternalRow(message: ClineNativeMessage): boolean {
  return message.role === 'assistant' || isNativeToolResultCarrier(message);
}

/** Appended human prompts only — tool-result transport is not a prompt. */
function appendedUserRows(appended: readonly ClineNativeMessage[]): ClineNativeMessage[] {
  return appended.filter((message) => message.role === 'user' && !isNativeToolResultCarrier(message));
}

function isAssistantOnlyAppend(
  before: readonly ClineNativeMessage[],
  after: readonly ClineNativeMessage[],
): boolean {
  return isPrefix(before, after)
    && after.length > before.length
    && after.slice(before.length).every((message) => isTurnInternalRow(message));
}

export class ClineHubDriveConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly retiredPermissionIds = new Set<string>();
  private readonly claimedUserCorrelations = new Map<string, ClinePromptCorrelation>();
  private readonly unpublishedUserCorrelations = new Map<string, UnpublishedPromptCorrelation>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeClose: () => void;
  private turnChain: Promise<void> = Promise.resolve();
  private turnGeneration = 0;
  private activeTurn = false;
  private liveTurn: { anchor: string; segment: number } | undefined;
  private stopping = false;
  private nativeMutation = false;
  private initialized = false;
  private closing = false;
  private closed = false;
  private demoted = false;
  private ownershipBoundary?: HistorySourceIdentity;
  private ownershipMessages?: readonly ClineNativeMessage[];
  private foreignRunSeen = false;
  private ownRunStarted = false;
  private terminalRunEvent?: ClineNativeTerminal;
  private authorityRecovery?: Promise<boolean>;
  private readonly terminalSummaryRegistry: TerminalSummaryRegistry<ClineTerminalSummary>;

  constructor(private readonly options: ClineHubDriveOptions) {
    this.info = options.info;
    this.terminalSummaryRegistry = options.terminalSummaryRegistry
      ?? new TerminalSummaryRegistry<ClineTerminalSummary>();
    this.unsubscribeEvent = options.client.subscribe((event) => this.acceptEvent(event));
    this.unsubscribeClose = options.client.onClose((error) => {
      if (!this.closed && !this.closing && !this.demoted) {
        this.demote(`Cline Hub connection closed: ${error.message}`);
      }
    });
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async initialize(): Promise<void> {
    const generation = this.turnGeneration;
    const assertCurrentGeneration = (): void => {
      this.assertWritable('initialize');
      if (generation !== this.turnGeneration) {
        throw new Error('Cline Hub initialize refused because its ownership generation changed.');
      }
    };
    assertCurrentGeneration();
    await this.options.client.connect();
    assertCurrentGeneration();
    let snapshot: Awaited<ReturnType<ClineHubDriveConnection['readNativeMessages']>> | undefined;
    if (this.options.requireEmptyIdleBoundary) {
      try {
        const beforeStatus = await this.readNativeStatus(this.options.client);
        assertCurrentGeneration();
        if (beforeStatus !== 'idle') {
          throw new ClineHubCreateBoundaryUnprovenError(
            'Cline Hub Create found a native session that was not exactly idle.',
          );
        }
        snapshot = await this.readStableNativeMessages(this.options.client);
        assertCurrentGeneration();
        const afterStatus = await this.readNativeStatus(this.options.client);
        assertCurrentGeneration();
        if (!snapshot || snapshot.messages.length !== 0 || afterStatus !== 'idle') {
          throw new ClineHubCreateBoundaryUnprovenError(
            'Cline Hub Create could not prove one stable empty and idle native boundary.',
          );
        }
      } catch (error) {
        if (error instanceof ClineHubCreateBoundaryUnprovenError || this.demoted) throw error;
        throw new ClineHubCreateBoundaryUnprovenError(
          `Cline Hub Create could not prove its initial native boundary: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (this.options.expectedHistoryBoundary) {
      const status = await this.readNativeStatus(this.options.client);
      assertCurrentGeneration();
      if (sessionIsRunning(status)) {
        throw new Error('Cline Resume found a running native turn without persisted broker ownership proof.');
      }
      snapshot = await this.readStableNativeMessages(this.options.client);
      assertCurrentGeneration();
      if (!snapshot) {
        throw new Error('Cline Resume could not establish an idle native ownership boundary.');
      }
    } else {
      snapshot = await this.readNativeMessages();
      assertCurrentGeneration();
    }
    if (!snapshot) throw new Error('Cline could not read a stable native ownership boundary.');
    const { messages, identity } = snapshot;
    if (this.options.expectedHistoryBoundary
      && !sameClineHubHistoryIdentity(this.options.expectedHistoryBoundary, identity)) {
      throw new Error('Cline Hub transcript changed after durable ownership was recorded.');
    }
    assertCurrentGeneration();
    this.terminalSummaryRegistry.hydrate(
      clineTerminalSummaryHistoryIdentity(this.info.id, messages),
      this.options.terminalSummaries ?? [],
    );
    this.recordOwnership(messages, identity);
    this.restorePromptCorrelations(messages);
    if (messages.length > 0) this.reconcileClaims(messages);
    this.initialized = true;
  }

  /** Streamed rows coalesce by `key`, so keying each chunk by its own event id makes every chunk a
   *  separate transcript row. Cline's Hub gives deltas no part id — the identity peer adapters key
   *  on — only a per-event id, so anchor them to the prompt's client key, which already identifies
   *  this turn's user row and is what `claimUserCorrelation` maps onto the settled native id.
   *  Falls back to the event id when no broker-owned turn is running: a foreign app client's run
   *  has no prompt key here, and inventing one would merge unrelated turns into a single row. */
  private liveDeltaKey(kind: 'assistant' | 'reasoning', eventId: string | undefined): string | undefined {
    const live = this.liveTurn;
    return live ? `${live.anchor}:${kind}:${live.segment}` : eventId;
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  async getHistory(): Promise<AgentMessage[]> {
    let { messages, identity } = await this.readNativeMessages();
    if (!this.demoted && !this.closed && this.ownershipBoundary
      && !sameClineHubHistoryIdentity(this.ownershipBoundary, identity)
      && !this.activeTurn) {
      const reconciled = await this.reconcileLateAssistantAppend({ messages, identity });
      if (reconciled) ({ messages, identity } = reconciled);
      else this.demote('The Cline Hub transcript changed outside the owned prompt boundary.');
    }
    this.reconcilePendingEchoes(messages, identity);
    this.reconcileClaims(messages);
    const mapped = mapClineTranscript(this.info.id, messages, this.options.trace);
    for (const message of mapped) {
      if (message.type !== 'user-message' || !message.key) continue;
      const nativeId = this.nativeIdFromMappedKey(message.key);
      const correlation = nativeId ? this.claimedUserCorrelations.get(nativeId) : undefined;
      if (correlation) {
        message.key = correlation.key;
        if (correlation.clientKey) message.clientKey = correlation.clientKey;
        message.queued = false;
      }
    }
    const nativeSummaryKeys = new Set(mapped
      .filter((message) => message.type === 'run-summary')
      .map((message) => message.key));
    const nativeSummaryTurnIds = new Set(mapped
      .filter((message) => message.type === 'run-summary')
      .map((message) => message.turnId));
    const terminalSummaries = this.terminalSummaryRegistry.read(
      clineTerminalSummaryHistoryIdentity(this.info.id, messages),
      true,
    ).rows;
    return [
      ...mapped,
      ...terminalSummaries
        .filter((summary) => !nativeSummaryKeys.has(summary.key)
          && !nativeSummaryTurnIds.has(summary.turnId))
        .map((summary) => ({ ...summary })),
      ...this.pendingPrompts.map((entry) => entry.row),
    ];
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity | undefined> {
    const snapshot = await this.readNativeMessages();
    this.reconcilePendingEchoes(snapshot.messages, snapshot.identity);
    this.reconcileClaims(snapshot.messages);
    return clinePromptCorrelationHistoryIdentity(snapshot.identity, this.claimedUserCorrelations);
  }

  getPending(): AgentMessage[] {
    return [
      ...this.pendingPrompts.map((entry) => entry.row),
      ...[...this.pendingPermissions.values()].map((entry) => entry.message),
    ];
  }

  async listModels(): Promise<ModelOption[]> {
    return this.options.models.map((model) => ({ ...model }));
  }

  /**
   * SESSION-scoped modes, which for a Hub session is exactly the one it was created with. Per-turn
   * switching is fixed at creation (`sendPrompt` below refuses any change, and
   * `docs/protocol/adapter-support.md` F08 records it), so advertising the full creation vocabulary
   * here was untrue: the composer renders a picker from this list, the user could select a mode the
   * session can never enter, the client attached it to every later prompt, and every one of those
   * prompts failed. Publishing only the live mode keeps the label visible while leaving nothing
   * selectable, and lets the broker's client-message policy refuse a crafted frame at the boundary
   * instead of in the adapter. The CREATE-time vocabulary is a separate surface
   * (`ClineAdapter.listModes`) and is unaffected.
   */
  async listModes(): Promise<ModeOption[]> {
    const current = this.options.modes.find((mode) => mode.value === this.options.permissionMode);
    return current ? [{ ...current }] : [];
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertWritable('prompt');
    if (this.stopping) throw new Error('Cline Hub prompt refused because Stop is in progress.');
    if (input.files?.length || input.images?.length) {
      throw new Error('Cline Hub file/image input remains disabled until its durable native echo is captured.');
    }
    if (input.model && !sameModel(input.model, this.info.currentModel)) {
      throw new Error('Cline Hub does not support per-turn model changes; create a session with the required model.');
    }
    if (input.permissionMode && input.permissionMode !== this.options.permissionMode) {
      throw new Error('Cline Hub permission mode is fixed at session creation.');
    }
    const generation = this.turnGeneration;
    const run = async () => {
      this.assertPromptAdmission(generation);
      const before = await this.readNativeMessages();
      this.assertPromptAdmission(generation);
      if (this.ownershipBoundary
        && !sameClineHubHistoryIdentity(this.ownershipBoundary, before.identity)) {
        const reconciled = await this.reconcileLateAssistantAppend(before);
        if (!reconciled) {
          this.demote('The Cline Hub transcript changed before prompt delivery.');
          throw new Error('Cline Hub Drive became read-only because ownership changed.');
        }
        before.messages = reconciled.messages;
        before.identity = reconciled.identity;
      }
      const key = input.clientMessageId?.trim()
        || `cline:queued:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const pending: PendingPrompt = {
        key,
        text: input.text,
        beforeMessages: before.messages,
        row: { type: 'user-message', text: input.text, key, clientKey: key, queued: true },
      };
      this.pendingPrompts.push(pending);
      while (this.pendingPrompts.length > MAX_PENDING_PROMPTS) this.pendingPrompts.shift();
      this.emit(pending.row);
      this.activeTurn = true;
      this.liveTurn = { anchor: key, segment: 0 };
      this.ownRunStarted = false;
      this.terminalRunEvent = undefined;
      this.info.status = 'working';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
      const settleOwnedTurn = async (
        result: Record<string, unknown> | undefined,
        terminalEvent: ClineNativeTerminal | undefined,
      ): Promise<void> => {
        const finishReason = field(result?.finishReason, 128) ?? terminalEvent?.finishReason;
        if (!finishReason || !['completed', 'aborted', 'failed', 'error'].includes(finishReason)) {
          throw new Error('Cline Hub returned an unknown terminal run result.');
        }
        // Cline 3.0.60 can reply to run.start just before its message file becomes visible. Preserve the
        // fail-closed causal proof, but give that durable write a bounded settle window instead of treating
        // one immediate empty snapshot as foreign ownership. A rewrite, second user, or mismatched user is
        // still terminal on the first snapshot that proves it.
        const settled = await this.readSettledCausalTurn(before.messages, input.text, finishReason);
        // Stop owns this generation change and deliberately reconciles the still-pending key against its
        // final post-settlement snapshot. Foreign demotion clears pending state; close is not a correlation
        // handoff. Preserve the ordinary active-Stop behavior without allowing either of those paths through.
        if (this.stopping && generation !== this.turnGeneration
            && !this.demoted && !this.closed && !this.closing) return;
        this.assertPromptAdmission(generation);
        const correlation = this.claimUserCorrelation(settled.user, key, key, false);
        this.removePendingPrompt(key);
        const status = finishReason === 'completed' ? 'done'
          : finishReason === 'aborted' ? 'cancelled'
            : 'error';
        // The turn's own token usage, carried on the summary that already binds
        // to the turn. Without it this drive path published no attributable
        // usage at all: Cline reports counts per assistant message and emits no
        // live `token-count`, so a reader saw numbers only when a later history
        // re-lay happened to include the assistant row. Absent counts stay
        // absent -- `clineTurnTokens` returns undefined rather than zeroes.
        const turnTokens = clineTurnTokens(settled.messages, settled.user.id);
        const terminalSummary: ClineTerminalSummary = {
          type: 'run-summary',
          key: `${clineMessageKey(this.info.id, settled.user.id)}:${status}`,
          turnId: clineTurnId(this.info.id, settled.user.id),
          status,
          source: 'cline',
          ...(turnTokens === undefined ? {} : { tokens: turnTokens }),
        };
        this.recordOwnership(settled.messages, settled.identity, terminalSummary);
        this.publishPromptCorrelation(correlation);
        // The broker raises "turn finished" / "turn failed" only for a run key it saw `running`
        // on this live stream first, so a terminal alone notified nobody. The key and the turn id
        // both name the settled native user row, which is known only now. An earlier frame would
        // need a provisional key and turn id, and the policy stamps its event with the running
        // frame's turn id, so the notification would point at a turn no row carries; a turn that
        // then never settles (Stop, demotion) would also leave that run open. So it goes out
        // once, here, for a turn this connection ran and settled itself: its own run.start
        // reply, or its own run.started before the terminal event. History and the shared
        // registry keep terminal rows only, so no reload or replacement connection sees it. It
        // precedes the history-reset so the resync replaces it with the durable terminal.
        if (this.activeTurn) {
          this.emit({
            type: 'run-summary',
            key: terminalSummary.key,
            turnId: terminalSummary.turnId,
            status: 'running',
            source: 'cline',
          });
        }
        this.emit({ type: 'history-reset' });
        this.emit(terminalSummary);
        if (finishReason === 'failed' || finishReason === 'error') {
          const error = field(result?.text, MAX_FIELD_CHARS)
            ?? terminalEvent?.text
            ?? 'Cline Hub run failed.';
          this.emit({ type: 'error', message: error });
        }
        // Cline writes an assistant row's `metrics` AFTER the row itself, and
        // the settle proof above deliberately does not wait for them: it needs
        // only "an assistant row exists" (`causallyComplete`). So the summary is
        // routinely built before the counts land, which is why binding them at
        // construction changed nothing measurable -- v73 kept reporting
        // `usagePublished: false` while `runCompleted` was true, i.e. the bound
        // summary arrived and arrived empty.
        //
        // One bounded re-read, strictly AFTER the fence and after every emit
        // above, so nothing the settled turn depends on can shift. The registry
        // supersedes a row with the same key/turnId, so republishing carries the
        // counts to any later reader, and the re-emit carries them to this one.
        // Wholly failure-isolated: a read error, a rewritten transcript, or
        // still-absent metrics all leave the turn exactly as it already settled.
        // A SINGLE immediate re-read was not enough, measured: the Hub does
        // carry `metrics` (`keys: id,role,content,ts,modelInfo,metrics`) and
        // `clineTurnTokens` reads them correctly off a live reply, but they
        // land when the provider returns usage -- a beat after the assistant
        // text the settle proof waits for. So poll briefly rather than once.
        if (turnTokens === undefined && !this.closed && !this.demoted) {
          try {
            for (let attempt = 0; attempt < CLINE_LATE_USAGE_ATTEMPTS; attempt += 1) {
              if (attempt > 0) await delay(CLINE_LATE_USAGE_INTERVAL_MS);
              if (this.closed || this.demoted || generation !== this.turnGeneration) break;
              const later = await this.readNativeMessages();
              const landed = isPrefix(settled.messages, later.messages)
                ? clineTurnTokens(later.messages, settled.user.id)
                : undefined;
              if (landed === undefined) continue;
              const settledSummary: ClineTerminalSummary = { ...terminalSummary, tokens: landed };
              this.recordOwnership(later.messages, later.identity, settledSummary);
              this.emit(settledSummary);
              break;
            }
          } catch {
            /* the turn is already settled; late usage is an enrichment, never a gate */
          }
        }
      };
      try {
        this.assertPromptAdmission(generation);
        const mode = this.options.permissionMode === 'plan' ? 'plan' : 'act';
        let reply: Record<string, unknown>;
        try {
          reply = await this.options.client.command('run.start', {
            prompt: input.text,
            mode,
            timeoutSeconds: this.options.turnTimeoutSeconds ?? 600,
          }, this.info.id, null);
        } catch (commandError) {
          const terminalEvent = this.readTerminalRunEvent();
          if (this.ownRunStarted && !this.foreignRunSeen && !this.demoted && !this.closed && terminalEvent) {
            await settleOwnedTurn(undefined, terminalEvent);
            return;
          }
          throw commandError;
        }
        if (generation !== this.turnGeneration) {
          if (this.stopping && !this.demoted && !this.closed && !this.closing) return;
          this.assertPromptAdmission(generation);
        }
        this.assertWritable('prompt');
        await settleOwnedTurn(record(reply.result), this.readTerminalRunEvent());
      } catch (error) {
        this.removePendingPrompt(key);
        this.emit({ type: 'history-reset' });
        if (!this.demoted && !this.closed
          && /timed out|closed|malformed|oversized|rewrote|causal|ownership|durable assistant|unknown terminal/u.test(
            error instanceof Error ? error.message : String(error),
          )) {
          this.demote(`Cline Hub prompt became ambiguous: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      } finally {
        this.activeTurn = false;
        this.liveTurn = undefined;
        this.ownRunStarted = false;
        this.terminalRunEvent = undefined;
        this.cancelPendingPermissions('Cline turn ended before the permission was resolved.');
        if (!this.demoted && !this.closed && generation === this.turnGeneration) {
          this.info.status = 'idle';
          this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
        }
      }
    };
    const scheduled = this.turnChain.then(run, run);
    this.turnChain = scheduled.catch((error) => {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    await scheduled;
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertWritable('permission');
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error('Cline Hub permission request is no longer pending.');
    if (decision !== 'approve' && decision !== 'reject') {
      throw new Error(`Cline Hub does not advertise permission decision ${decision}.`);
    }
    await this.options.client.command('approval.respond', {
      approvalId: pending.approvalId,
      approved: decision === 'approve',
      reason: decision === 'approve' ? 'Approved in cosyncing.' : 'Rejected in cosyncing.',
    }, this.info.id);
    if (this.pendingPermissions.delete(requestId)) {
      this.retirePermissionId(requestId);
      this.emit({ type: 'permission-resolved', requestId, decision });
    }
    if (!this.demoted && !this.closed) {
      this.info.status = 'working';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
    }
  }

  async listCommands() {
    return [{ name: 'stop', description: 'Stop the running Cline turn', kind: 'action' as const }];
  }

  async runCommand(name: string) {
    if (name !== 'stop' && name !== 'abort') throw new Error(`Cline Hub does not support /${name}.`);
    this.assertWritable('cancel');
    if (this.stopping) throw new Error('Cline Hub Stop is already in progress.');
    this.stopping = true;
    const priorTurnChain = this.turnChain;
    this.turnGeneration += 1;
    try {
      const stoppedSnapshot = await this.abortAndVerify(this.options.client, 'Stopped from cosyncing.');
      if (!stoppedSnapshot) {
        this.demote('Cline could not prove that the native turn stopped.');
        await this.authorityRecovery;
        throw new Error('Cline Stop failed closed because the native turn did not become idle.');
      }
      if (!await this.settleTurnChain(priorTurnChain)) {
        this.demote('Cline Stop proved native idle but did not receive the terminal run reply.');
        await this.authorityRecovery;
        throw new Error('Cline Stop failed closed because the prior native request did not settle.');
      }
      const finalStatus = await this.readNativeStatus(this.options.client);
      const snapshot = sessionIsRunning(finalStatus)
        ? undefined
        : await this.readStableNativeMessages(this.options.client);
      if (!snapshot) {
        this.demote('Cline Stop could not prove the final durable transcript boundary.');
        await this.authorityRecovery;
        throw new Error('Cline Stop failed closed because its final transcript did not settle.');
      }
      this.reconcilePendingEchoes(snapshot.messages, snapshot.identity);
      if (this.demoted || this.closed) {
        throw new Error('Cline Stop lost its transcript ownership boundary.');
      }
      if (!this.unpublishedClaimsMatch(snapshot.messages)) {
        this.demote('Cline Stop found a rewrite or foreign user after its provisional prompt claim.');
        await this.authorityRecovery;
        throw new Error('Cline Stop refused an unproved final transcript boundary.');
      }
      this.reconcileClaims(snapshot.messages);
      this.recordOwnership(snapshot.messages, snapshot.identity);
      this.publishUnpublishedClaims();
      this.cancelPendingPermissions('Stopped from cosyncing.', 'reject');
      this.pendingPrompts.length = 0;
      this.emit({ type: 'history-reset' });
      this.info.status = 'idle';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
      return { notice: 'Stop requested.' };
    } finally {
      this.stopping = false;
    }
  }

  private async readNativeMessages(): Promise<{
    messages: ClineNativeMessage[];
    identity: HistorySourceIdentity;
  }> {
    return this.readNativeMessagesFrom(this.options.client);
  }

  private async readSettledCausalTurn(
    before: readonly ClineNativeMessage[],
    prompt: string,
    finishReason: string,
  ): Promise<{
    messages: ClineNativeMessage[];
    identity: HistorySourceIdentity;
    user: ClineNativeMessage;
  }> {
    const deadline = Date.now() + (this.options.authoritySettleTimeoutMs ?? CLINE_AUTHORITY_SETTLE_MS);
    let sawExactUser = false;
    do {
      const after = await this.readNativeMessages();
      if (!isPrefix(before, after.messages)) {
        throw new Error('Cline Hub rewrote the transcript during the owned turn.');
      }
      const appended = after.messages.slice(before.length);
      const userRows = appendedUserRows(appended);
      if (userRows.length > 1 || (userRows.length === 1 && nativeUserText(userRows[0]!) !== prompt)) {
        throw new Error('Cline Hub turn did not persist one exact causal user row.');
      }
      const user = userRows[0];
      if (user) {
        sawExactUser = true;
        const userIndex = appended.indexOf(user);
        const causallyComplete = finishReason !== 'completed'
          || appended.slice(userIndex + 1).some((message) => message.role === 'assistant');
        if (causallyComplete) return { ...after, user };
      }
      await delay(25);
    } while (Date.now() < deadline);
    if (!sawExactUser) throw new Error('Cline Hub turn did not persist one exact causal user row.');
    throw new Error('Cline Hub completed without one durable assistant response.');
  }

  private settleTurnChain(chain: Promise<void>): Promise<boolean> {
    // The bound is not what withholds the reply, and reading it that way is a
    // trap this comment used to set. `settled 5055ms after Stop, past the
    // 5000ms authority settle bound` looks like a bound 55ms too tight. It is
    // not: raising it to 15_000 produced `settled 15050ms after Stop, past the
    // 15000ms bound` -- ~50ms past ANY bound, because the timeout demotes, the
    // demotion rejects the in-flight prompt, and THAT is what settles the
    // chain. The native reply to an aborted `run.start` never arrives on its
    // own; see the constant's own doc above.
    //
    // So the number is deliberately 5_000, and the report below names the cause
    // rather than the timing.
    const timeoutMs = this.options.authoritySettleTimeoutMs ?? CLINE_AUTHORITY_SETTLE_MS;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish(false);
        // The bound expired; the question did not. Keep watching, and say
        // whether the reply ever came. A read-only session whose only
        // explanation is "did not receive the terminal run reply" cannot tell
        // its owner whether the bound was too tight or the reply never exists
        // -- and those want opposite answers. Nothing here changes what the
        // gate decides; it only stops the decision being unexplainable.
        // HOW it settles is the discriminator, not `this.demoted` at the time.
        // The caller demotes on the very next microtask after this resolves
        // false, so by the time the chain moves, `demoted` is always true and a
        // check on it can only ever report one of its two cases. A genuine late
        // reply RESOLVES the chain; the demotion rejects the in-flight prompt,
        // so a demotion-released chain REJECTS. That distinction survives the
        // ordering.
        void chain.then(
          () => this.reportLateTurnSettle(startedAt, timeoutMs, 'native-reply'),
          () => this.reportLateTurnSettle(startedAt, timeoutMs, 'demotion'),
        );
      }, timeoutMs);
      void chain.then(() => finish(true), () => finish(true));
    });
  }

  private reportLateTurnSettle(
    startedAt: number,
    timeoutMs: number,
    released: 'native-reply' | 'demotion',
  ): void {
    if (this.closed) return;
    const elapsed = Date.now() - startedAt;
    // Say WHY it settled, not just when. A chain released by the demotion --
    // which rejects the in-flight prompt -- reported as a late native reply
    // reads as "the bound is too tight" and sends the next reader off to raise
    // it. Measured: raising 5_000 to 15_000 just moved the number.
    //
    // `elapsed` counts from when this settle wait began, which is after
    // `abortAndVerify` has already returned, not from when Stop was sent.
    this.emit({
      type: 'notice',
      message: released === 'demotion'
        ? `Cline's prior run settled ${elapsed}ms into the settle wait, and only because demoting this connection rejected the in-flight request: the native reply to the aborted run never arrived, and the ${timeoutMs}ms authority settle bound is not what withheld it.`
        : `Cline's prior run settled ${elapsed}ms into the settle wait, past the ${timeoutMs}ms authority settle bound, by replying on its own.`,
    });
  }

  private async readNativeMessagesFrom(client: ClineHubClient): Promise<{
    messages: ClineNativeMessage[];
    identity: HistorySourceIdentity;
  }> {
    const reply = await client.command(
      'session.messages',
      { sessionId: this.info.id },
      this.info.id,
      10_000,
    );
    if (reply.sessionId !== undefined && reply.sessionId !== this.info.id) {
      throw new Error('Cline Hub returned messages for a different session.');
    }
    const messages = parseClineHubMessages(this.info.id, reply.messages);
    if (!messages) throw new Error('Cline Hub returned an invalid or oversized durable message set.');
    return {
      messages,
      identity: clineHubHistoryIdentity(
        this.options.profileRoot,
        this.info.id,
        clineHubEpoch(client.options.discovery),
        messages,
      ),
    };
  }

  private async readNativeStatus(client: ClineHubClient): Promise<string> {
    const reply = await client.command(
      'session.get',
      { includeSnapshot: false },
      this.info.id,
      5_000,
    );
    const session = record(reply.session);
    if (session?.sessionId !== undefined && session.sessionId !== this.info.id) {
      throw new Error('Cline Hub returned status for a different session.');
    }
    const status = field(session?.status, 128);
    if (!status || !['idle', 'pending', 'completed', 'failed', 'aborted', 'running'].includes(status)) {
      throw new Error('Cline Hub returned an unknown native session status.');
    }
    return status;
  }

  private async readStableNativeMessages(
    client: ClineHubClient,
  ): Promise<Awaited<ReturnType<ClineHubDriveConnection['readNativeMessages']>> | undefined> {
    const first = await this.readNativeMessagesFrom(client);
    await Promise.resolve();
    const second = await this.readNativeMessagesFrom(client);
    return sameClineHubHistoryIdentity(first.identity, second.identity) ? second : undefined;
  }

  private recordOwnership(
    messages: readonly ClineNativeMessage[],
    identity: HistorySourceIdentity,
    terminalSummary?: ClineTerminalSummary,
  ): void {
    this.ownershipMessages = messages;
    this.ownershipBoundary = identity;
    this.terminalSummaryRegistry.publish(
      clineTerminalSummaryHistoryIdentity(this.info.id, messages),
      terminalSummary,
    );
    this.options.onHistoryBoundary?.(identity, terminalSummary);
  }

  private async reconcileLateAssistantAppend(
    candidate: Awaited<ReturnType<ClineHubDriveConnection['readNativeMessages']>>,
  ): Promise<Awaited<ReturnType<ClineHubDriveConnection['readNativeMessages']>> | undefined> {
    if (!this.ownershipMessages || !this.ownershipBoundary
      || this.activeTurn || this.stopping || this.foreignRunSeen
      || this.pendingPrompts.length > 0 || this.pendingPermissions.size > 0
      || this.demoted || this.closed || this.closing || this.info.status !== 'idle'
      || !isAssistantOnlyAppend(this.ownershipMessages, candidate.messages)) return undefined;
    const generation = this.turnGeneration;
    const status = await this.readNativeStatus(this.options.client);
    const stable = status === 'idle'
      ? await this.readStableNativeMessages(this.options.client)
      : undefined;
    if (!stable || generation !== this.turnGeneration || this.activeTurn || this.stopping
      || this.foreignRunSeen || this.demoted || this.closed || this.closing
      || !isAssistantOnlyAppend(this.ownershipMessages, stable.messages)) return undefined;
    this.recordOwnership(stable.messages, stable.identity);
    return stable;
  }

  private async abortAndVerify(
    client: ClineHubClient,
    reason: string,
  ): Promise<Awaited<ReturnType<ClineHubDriveConnection['readNativeMessages']>> | undefined> {
    try {
      await client.command('run.abort', {
        sessionId: this.info.id,
        reason,
      }, this.info.id, 5_000);
      const deadline = Date.now() + (this.options.authoritySettleTimeoutMs ?? CLINE_AUTHORITY_SETTLE_MS);
      do {
        const status = await this.readNativeStatus(client);
        if (!sessionIsRunning(status)) {
          const stable = await this.readStableNativeMessages(client);
          if (stable) return stable;
        }
        await delay(25);
      } while (Date.now() < deadline);
    } catch {
      // The caller either retries through a fresh management client or stops
      // the proven-owned Hub. A native ok reply alone is not cancellation proof.
    }
    return undefined;
  }

  private async quiesceNativeAuthority(reason: string): Promise<boolean> {
    let management: ClineHubClient | undefined;
    try {
      const client = this.options.client.alive
        ? this.options.client
        : (management = await this.options.createManagementClient?.());
      if (!client) return false;
      const status = await this.readNativeStatus(client);
      const stable = sessionIsRunning(status)
        ? await this.abortAndVerify(client, reason)
        : await this.readStableNativeMessages(client);
      return stable !== undefined;
    } catch {
      return false;
    } finally {
      if (management) await management.close().catch(() => undefined);
    }
  }

  private async escalateUnsafeAuthority(reason: string): Promise<boolean> {
    if (!this.options.onUnsafeAuthority) {
      this.emit({ type: 'error', message: `Cline has no managed-Hub stop fence: ${reason}` });
      return false;
    }
    try {
      await this.options.onUnsafeAuthority(reason);
      return true;
    } catch (error) {
      this.emit({
        type: 'error',
        message: `Cline could not stop its unsafe managed Hub: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  private beginAuthorityRecovery(reason: string): void {
    if (this.authorityRecovery) return;
    this.authorityRecovery = (async () => {
      const settled = await this.quiesceNativeAuthority(reason);
      return settled || await this.escalateUnsafeAuthority(reason);
    })();
  }

  private acceptEvent(event: ClineHubEvent): void {
    const payload = event.payload ?? {};
    if (event.event === 'capability.requested') {
      if (event.sessionId === this.info.id) this.acceptCapabilityRequest(payload);
      return;
    }
    if (event.sessionId !== this.info.id) return;
    if (event.event === 'run.enqueued' || event.event === 'run.started') {
      const origin = field(payload.clientId, 512);
      if (!origin || origin !== this.options.client.clientId) {
        this.foreignRunSeen = true;
        this.demote('A foreign Cline Hub client attempted to drive this session.');
      } else if (event.event === 'run.started' && this.activeTurn && !this.demoted) {
        this.ownRunStarted = true;
        this.terminalRunEvent = undefined;
      }
      return;
    }
    if (event.event === 'run.completed' || event.event === 'run.aborted' || event.event === 'run.failed') {
      if (!this.activeTurn || !this.ownRunStarted || this.foreignRunSeen || this.demoted
        || this.terminalRunEvent) return;
      this.terminalRunEvent = {
        finishReason: event.event === 'run.completed' ? 'completed'
          : event.event === 'run.aborted' ? 'aborted'
            : 'error',
        ...(terminalText(payload) ? { text: terminalText(payload) } : {}),
      };
      return;
    }
    if (event.event === 'approval.requested') {
      this.acceptApproval(payload);
      return;
    }
    if (event.event === 'approval.resolved') {
      const approvalId = field(payload.approvalId, 512);
      const pending = approvalId ? this.pendingPermissions.get(approvalId) : undefined;
      if (approvalId && pending) {
        this.pendingPermissions.delete(approvalId);
        this.retirePermissionId(approvalId);
        // Three-valued, because `approved` is: true, false, or absent. Folding
        // the missing case into `reject` rendered a malformed or unrecognised
        // native frame as a USER REJECTION the user never made. `62c1edbf`
        // introduced `'external'` for exactly this ("resolved somewhere else,
        // by something other than you") and changed only the pi bridge.
        // Display-only either way — the native side has already decided.
        const decision = payload.approved === true ? 'approve'
          : payload.approved === false ? 'reject'
          : 'external';
        this.emit({ type: 'permission-resolved', requestId: approvalId, decision });
        if (!this.demoted && !this.closed) {
          this.info.status = 'working';
          this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
        }
      }
      return;
    }
    if (event.event === 'assistant.delta') {
      const text = field(payload.text, 2 * 1024 * 1024);
      if (text) this.emit({ type: 'model-output', delta: text, key: this.liveDeltaKey('assistant', event.eventId) });
      return;
    }
    if (event.event === 'reasoning.delta') {
      const text = typeof payload.text === 'string' && payload.text.length <= 2 * 1024 * 1024
        ? payload.text : undefined;
      if (text !== undefined) this.emit({ type: 'thinking', delta: text, key: this.liveDeltaKey('reasoning', event.eventId) });
      return;
    }
    if (event.event === 'tool.started') {
      const callId = field(payload.toolCallId, 512) ?? event.eventId ?? `cline-tool:${Date.now()}`;
      const toolName = field(payload.toolName, 512) ?? 'Cline tool';
      this.emit({ type: 'tool-call', callId, toolName, title: toolName, args: payload.input });
      // Answer text resumed after a tool call belongs in its own row, below the tool, not appended
      // to the text that preceded it.
      if (this.liveTurn) this.liveTurn.segment += 1;
      return;
    }
    if (event.event === 'tool.finished') {
      const callId = field(payload.toolCallId, 512) ?? event.eventId ?? `cline-tool:${Date.now()}`;
      const toolName = field(payload.toolName, 512) ?? 'Cline tool';
      this.emit({
        type: 'tool-result', callId, toolName, title: toolName,
        result: payload.output,
        isError: payload.error !== undefined,
      });
      return;
    }
    if (event.event === 'usage.updated') {
      const totals = record(payload.totals) ?? record(payload.usage);
      const input = nonNegative(totals?.inputTokens);
      const output = nonNegative(totals?.outputTokens);
      const cacheRead = nonNegative(totals?.cacheReadTokens);
      const cacheWrite = nonNegative(totals?.cacheWriteTokens);
      const cost = nonNegative(totals?.totalCost);
      if ([input, output, cacheRead, cacheWrite, cost].some((value) => value !== undefined)) {
        this.emit({
          type: 'token-count',
          ...(input === undefined ? {} : { input }),
          ...(output === undefined ? {} : { output }),
          ...(cacheRead === undefined ? {} : { cacheRead }),
          ...(cacheWrite === undefined ? {} : { cacheWrite }),
          ...(cost === undefined ? {} : { cost }),
        });
      }
    }
  }

  private readTerminalRunEvent(): ClineNativeTerminal | undefined {
    return this.terminalRunEvent;
  }

  private acceptCapabilityRequest(payload: Record<string, unknown>): void {
    if (payload.targetClientId !== this.options.client.clientId) return;
    const requestId = field(payload.requestId, 512);
    const capabilityName = field(payload.capabilityName, 512);
    if (!requestId || !capabilityName) return;
    const allowed = capabilityName === 'hook.beforeRun'
      || capabilityName === 'hook.onEvent'
      || capabilityName === 'hook.afterRun';
    const stop = capabilityName === 'hook.beforeRun'
      && (this.closed || this.demoted || this.foreignRunSeen || !this.activeTurn);
    void this.options.client.command('capability.respond', {
      requestId,
      ok: allowed,
      ...(allowed ? {
        payload: stop
          ? { control: { stop: true, reason: 'Cline Hub Drive ownership is not active.' } }
          : {},
      } : { error: `Unsupported cosyncing capability ${capabilityName}.` }),
    }, this.info.id, 5_000).catch((error) => {
      if (!this.demoted && !this.closed) {
        this.demote(`Cline Hub capability response failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private acceptApproval(payload: Record<string, unknown>): void {
    if (payload.targetClientId !== undefined && payload.targetClientId !== this.options.client.clientId) return;
    const approvalId = field(payload.approvalId, 512);
    if (!approvalId || this.pendingPermissions.has(approvalId) || this.retiredPermissionIds.has(approvalId)
      || this.closed || this.demoted || !this.activeTurn) return;
    const native = payload;
    const toolName = field(native.toolName ?? native.name, 512) ?? 'Cline tool';
    const detailValue = native.inputJson ?? native.input ?? native.detail ?? native.description;
    let detail: string | undefined;
    try {
      const encoded = typeof detailValue === 'string' ? detailValue : JSON.stringify(detailValue);
      detail = encoded && encoded.length <= MAX_FIELD_CHARS ? encoded : undefined;
    } catch { detail = undefined; }
    const message: PendingPermission['message'] = {
      type: 'permission-request',
      requestId: approvalId,
      title: field(native.title, 512) ?? `Allow ${toolName}?`,
      toolName,
      ...(detail ? { detail } : {}),
      options: ['approve', 'reject'],
    };
    this.pendingPermissions.set(approvalId, { message, approvalId });
    if (this.pendingPermissions.size > MAX_PENDING_PERMISSIONS) {
      this.demote('Cline exceeded the bounded native approval queue.');
      return;
    }
    this.info.status = 'needs-input';
    this.emit(message);
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'needs-input' } });
  }

  private reconcileClaims(messages: readonly ClineNativeMessage[]): void {
    const nativeById = new Map(messages.map((message) => [message.id, message]));
    for (const [id, correlation] of this.claimedUserCorrelations) {
      const native = nativeById.get(id);
      if (native?.role !== 'user'
        || clineNativeMessageDigest(native) !== correlation.nativeMessageDigest) {
        this.claimedUserCorrelations.delete(id);
      }
    }
  }

  private reconcilePendingEchoes(
    messages: readonly ClineNativeMessage[],
    identity: HistorySourceIdentity,
  ): ClinePromptCorrelation[] {
    const claimed: ClinePromptCorrelation[] = [];
    for (const pending of [...this.pendingPrompts]) {
      if (!isPrefix(pending.beforeMessages, messages)) {
        this.demote('The Cline Hub rewrote the transcript before the queued prompt was reconciled.');
        return claimed;
      }
      const appended = messages.slice(pending.beforeMessages.length);
      const userRows = appendedUserRows(appended);
      if (userRows.length === 0) continue;
      if (userRows.length !== 1 || nativeUserText(userRows[0]!) !== pending.text) {
        this.demote('The Cline Hub persisted an ambiguous user echo for the queued prompt.');
        return claimed;
      }
      claimed.push(this.claimUserCorrelation(userRows[0]!, pending.key, pending.key, false, identity));
      this.removePendingPrompt(pending.key);
    }
    return claimed;
  }

  private claimUserCorrelation(
    user: ClineNativeMessage,
    key: string,
    clientKey: string | undefined,
    publish: boolean,
    claimedBoundary?: HistorySourceIdentity,
  ): ClinePromptCorrelation {
    const correlation: ClinePromptCorrelation = {
      nativeMessageId: user.id,
      nativeMessageDigest: clineNativeMessageDigest(user),
      key,
      ...(clientKey ? { clientKey } : {}),
    };
    this.setClaimedUserCorrelation(correlation);
    if (publish) this.publishPromptCorrelation(correlation);
    else if (claimedBoundary) {
      this.unpublishedUserCorrelations.set(user.id, {
        correlation,
        claimedBoundary: { ...claimedBoundary },
      });
    }
    return correlation;
  }

  private setClaimedUserCorrelation(correlation: ClinePromptCorrelation): void {
    this.claimedUserCorrelations.delete(correlation.nativeMessageId);
    this.claimedUserCorrelations.set(correlation.nativeMessageId, correlation);
    while (this.claimedUserCorrelations.size > CLINE_MAX_PROMPT_CORRELATIONS) {
      const oldest = this.claimedUserCorrelations.keys().next().value;
      if (oldest === undefined) break;
      this.claimedUserCorrelations.delete(oldest);
      this.unpublishedUserCorrelations.delete(oldest);
    }
  }

  private publishPromptCorrelation(correlation: ClinePromptCorrelation): void {
    this.unpublishedUserCorrelations.delete(correlation.nativeMessageId);
    this.options.onPromptCorrelation?.(correlation);
  }

  private publishUnpublishedClaims(): void {
    for (const entry of [...this.unpublishedUserCorrelations.values()]) {
      this.publishPromptCorrelation(entry.correlation);
    }
  }

  private unpublishedClaimsMatch(messages: readonly ClineNativeMessage[]): boolean {
    const epoch = clineHubEpoch(this.options.client.options.discovery);
    for (const { correlation, claimedBoundary } of this.unpublishedUserCorrelations.values()) {
      const appendPosition = claimedBoundary.appendPosition;
      if (appendPosition === undefined || !Number.isSafeInteger(appendPosition)
        || appendPosition < 0 || appendPosition > messages.length) return false;
      const prefix = messages.slice(0, appendPosition);
      const prefixIdentity = clineHubHistoryIdentity(
        this.options.profileRoot,
        this.info.id,
        epoch,
        prefix,
      );
      if (!sameClineHubHistoryIdentity(claimedBoundary, prefixIdentity)
        || messages.slice(appendPosition).some((message) => !isTurnInternalRow(message))) return false;
      const native = prefix.find((message) => message.id === correlation.nativeMessageId);
      if (native?.role !== 'user'
        || clineNativeMessageDigest(native) !== correlation.nativeMessageDigest) return false;
    }
    return true;
  }

  private restorePromptCorrelations(messages: readonly ClineNativeMessage[]): void {
    const nativeById = new Map(messages.map((message) => [message.id, message]));
    for (const correlation of this.options.promptCorrelations?.values() ?? []) {
      const native = nativeById.get(correlation.nativeMessageId);
      if (native?.role !== 'user'
        || clineNativeMessageDigest(native) !== correlation.nativeMessageDigest) continue;
      this.setClaimedUserCorrelation({ ...correlation });
    }
  }

  private nativeIdFromMappedKey(key: string): string | undefined {
    const prefix = `${clineMessageKey(this.info.id, '')}`;
    if (!key.startsWith(prefix)) return undefined;
    const tail = key.slice(prefix.length);
    const marker = ':block:';
    const end = tail.indexOf(marker);
    return end > 0 ? tail.slice(0, end) : undefined;
  }

  private removePendingPrompt(key: string): void {
    const index = this.pendingPrompts.findIndex((entry) => entry.key === key);
    if (index >= 0) this.pendingPrompts.splice(index, 1);
  }

  private retirePermissionId(id: string): void {
    this.retiredPermissionIds.add(id);
    while (this.retiredPermissionIds.size > 256) {
      const oldest = this.retiredPermissionIds.values().next().value;
      if (!oldest) break;
      this.retiredPermissionIds.delete(oldest);
    }
  }

  /**
   * `decision` is what the CLIENT is told. A user pressing Stop did make a
   * choice, so `'reject'` is honest there; a turn ending or a demotion did not,
   * and reporting those as a rejection attributes to the user a refusal they
   * never made — the case `62c1edbf` introduced `'external'` for. The NATIVE
   * side is told `approved: false` either way, and that does not change.
   */
  private cancelPendingPermissions(
    reason: string,
    decision: PermissionDecision | 'external' = 'external',
  ): void {
    for (const [id, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      this.retirePermissionId(id);
      void this.options.client.command('approval.respond', {
        approvalId: pending.approvalId,
        approved: false,
        reason,
      }, this.info.id, 2_000).catch(() => undefined);
      this.emit({ type: 'permission-resolved', requestId: id, decision });
    }
  }

  async renameNativeTitle(
    title: string,
    verifyDurable: () => Promise<boolean>,
  ): Promise<boolean> {
    this.assertWritable('rename');
    if (this.activeTurn || this.stopping || this.pendingPrompts.length > 0
      || this.pendingPermissions.size > 0 || this.info.status !== 'idle') return false;
    this.nativeMutation = true;
    this.turnGeneration += 1;
    const generation = this.turnGeneration;
    let mutationAttempted = false;
    let mutationProved = false;
    try {
      await this.turnChain;
      if (generation !== this.turnGeneration || this.demoted || this.closed || this.closing) return false;
      let before = await this.readStableNativeMessages(this.options.client);
      if (!before || !this.ownershipBoundary
        || (!sameClineHubHistoryIdentity(this.ownershipBoundary, before.identity)
          && !(before = await this.reconcileLateAssistantAppend(before)))) {
        this.demote('The Cline Hub transcript changed before native rename.');
        return false;
      }
      if (generation !== this.turnGeneration || this.demoted || this.closed || this.closing) return false;
      const beforeStatus = await this.readNativeStatus(this.options.client);
      if (sessionIsRunning(beforeStatus)) {
        this.demote('The Cline Hub became active before native rename.');
        return false;
      }
      if (!this.options.renameNativeTitle) return false;
      mutationAttempted = true;
      try {
        if (!await this.options.renameNativeTitle(title)) return false;
      } catch (error) {
        const afterFailure = await this.readStableNativeMessages(this.options.client).catch(() => undefined);
        if (!afterFailure || !sameClineHubHistoryIdentity(before.identity, afterFailure.identity)) {
          this.demote('The Cline Hub transcript changed during a failed native rename.');
        }
        throw error;
      }
      if (generation !== this.turnGeneration || this.demoted || this.closed || this.closing) return false;
      const afterStatus = await this.readNativeStatus(this.options.client);
      if (sessionIsRunning(afterStatus)) {
        this.demote('The Cline Hub became active during native rename.');
        return false;
      }
      const durable = await verifyDurable();
      if (!durable || generation !== this.turnGeneration
        || this.demoted || this.closed || this.closing) return false;
      let after = await this.readStableNativeMessages(this.options.client);
      if (!after || (!sameClineHubHistoryIdentity(before.identity, after.identity)
        && !(after = await this.reconcileLateAssistantAppend(after)))) {
        this.demote('The Cline Hub transcript changed during native rename.');
        return false;
      }
      if (sameClineHubHistoryIdentity(before.identity, after.identity)) {
        this.recordOwnership(after.messages, after.identity);
      }
      mutationProved = generation === this.turnGeneration
        && !this.demoted && !this.closed && !this.closing;
      return mutationProved;
    } finally {
      if (mutationAttempted && !mutationProved && !this.demoted && !this.closed && !this.closing) {
        this.demote('Cline could not prove that native rename preserved writer ownership.');
      }
      this.nativeMutation = false;
    }
  }

  private assertWritable(action: string): void {
    if (this.closed) throw new Error(`Cline Hub ${action} refused because the connection is closed.`);
    if (this.closing) throw new Error(`Cline Hub ${action} refused because the connection is closing.`);
    if (this.nativeMutation) throw new Error(`Cline Hub ${action} refused because a native metadata update is in progress.`);
    if (this.demoted) throw new Error(`Cline Hub ${action} refused because Drive is read-only.`);
  }

  private assertPromptAdmission(generation: number): void {
    this.assertWritable('prompt');
    if (this.stopping) throw new Error('Cline Hub prompt refused because Stop is in progress.');
    if (generation !== this.turnGeneration) {
      throw new Error('Cline Hub prompt refused because its ownership generation changed.');
    }
  }

  revokeOwnership(reason: string): void { this.demote(reason); }

  private demote(reason: string): void {
    if (this.demoted || this.closed) return;
    this.demoted = true;
    this.turnGeneration += 1;
    this.info.attachMode = 'observe';
    this.info.status = 'idle';
    this.info.control = {
      ...(this.info.control ?? {}),
      drive: { state: 'observing', supported: false, reason },
      terminalSync: this.info.control?.terminalSync ?? {
        supported: false,
        syncAvailable: false,
        active: false,
        reason: 'Cline Hub Drive was demoted.',
      },
    };
    this.cancelPendingPermissions(reason);
    this.pendingPrompts.length = 0;
    this.claimedUserCorrelations.clear();
    this.unpublishedUserCorrelations.clear();
    this.emit({ type: 'history-reset' });
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: {
      attachMode: 'observe', status: 'idle', control: this.info.control,
    } });
    this.emit({ type: 'error', message: reason });
    // Before initialize() proves and records a boundary, this socket has no
    // writer authority to recover. In particular, never abort a foreign run
    // merely because it raced a Resume attempt that was not yet admitted.
    if (this.initialized) this.beginAuthorityRecovery(reason);
    this.options.onDemote?.(this);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.turnGeneration += 1;
    const priorTurnChain = this.turnChain;
    this.closePromise = this.finishClose(priorTurnChain);
    return this.closePromise;
  }

  private closePromise?: Promise<void>;

  private async finishClose(priorTurnChain: Promise<void>): Promise<void> {
    let unsafeAuthority: string | undefined;
    if (this.activeTurn && !this.demoted) {
      const stopped = await this.abortAndVerify(this.options.client, 'Cline Hub Drive connection closed.');
      if (!stopped && !await this.escalateUnsafeAuthority(
        'Cline Hub Drive closed before its native turn stopped.',
      )) {
        unsafeAuthority = 'Cline Hub Drive closed without proving that its native turn stopped.';
      }
    }
    if (await this.authorityRecovery === false) {
      unsafeAuthority = 'Cline Hub Drive authority recovery and the managed-Hub stop fence both failed.';
    }
    this.closed = true;
    this.cancelPendingPermissions('Cline Hub Drive connection closed.');
    this.pendingPrompts.length = 0;
    this.unsubscribeEvent();
    this.unsubscribeClose();
    await this.options.client.close();
    await priorTurnChain;
    this.handlers.clear();
    this.options.onClose?.(this);
    if (unsafeAuthority) throw new Error(unsafeAuthority);
  }
}
