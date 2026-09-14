import { AcpClient, type AcpRequestPermissionParams, type AcpRequestPermissionResult, type AcpSessionUpdateParams } from '@cosyncing/acp-client';
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
import { ClineObserveConnection, type ClineObserveOptions } from './observe.ts';
import {
  CLINE_MINIMUM_SUPPORTED_VERSION,
  clineVersionAllowsDrive,
  type ClineStoredSession,
} from './store.ts';

const MAX_PENDING_PROMPTS = 64;
const MAX_PERMISSION_FIELD_CHARS = 512;

interface PendingPrompt {
  text: string;
  key: string;
  baseline: Set<string>;
  row: Extract<AgentMessage, { type: 'user-message' }>;
}

interface PendingPermission {
  message: Extract<AgentMessage, { type: 'permission-request' }>;
  options: Map<PermissionDecision, string>;
  resolve: (result: AcpRequestPermissionResult) => void;
}

interface LiveTurnRecord {
  turn: number;
  promptText: string;
  userEchoSeen: boolean;
  ingressAmbiguous: boolean;
  answer: string;
  thinking: string;
  toolCallIds: Set<string>;
  semantics: TurnSemantic[];
  durableAnswer: string;
  durableThinking: string;
  answerClaimed: boolean;
  thinkingClaimed: boolean;
}

type TurnSemantic =
  | { kind: 'answer' | 'thinking'; text: string }
  | { kind: 'tool-call'; callId: string }
  | { kind: 'tool-result'; callId: string; isError: boolean };

export interface ClineDriveOptions {
  session: ClineStoredSession;
  info: SessionInfo;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  authMethodId?: string;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  model?: PromptInput['model'];
  permissionMode?: string;
  models?: readonly ModelOption[];
  modes?: readonly ModeOption[];
  trace?: ClineObserveOptions['trace'];
  observe?: Omit<ClineObserveOptions, 'session' | 'info' | 'trace'>;
  pendingCreate?: {
    discover(): Promise<ClineStoredSession | undefined>;
    onMaterialized?: (connection: ClineDriveConnection, session: ClineStoredSession) => void;
  };
  onDemote?: (connection: ClineDriveConnection) => void;
  onClose?: (connection: ClineDriveConnection) => void;
  onConfiguration?: (connection: ClineDriveConnection) => void;
  onHistoryBoundary?: (identity: HistorySourceIdentity) => void;
  expectedHistoryBoundary?: HistorySourceIdentity;
}

function sameHistoryBoundary(
  expected: HistorySourceIdentity,
  current: HistorySourceIdentity | undefined,
): boolean {
  return current !== undefined
    && expected.sourceId === current.sourceId
    && expected.revision === current.revision
    && expected.appendPosition === current.appendPosition
    && expected.rewriteToken === current.rewriteToken;
}

function assertMeasuredClineAgent(client: AcpClient): void {
  const agent = client.initializeResult?.agentInfo;
  if (agent?.name !== 'cline' || !clineVersionAllowsDrive(agent.version)) {
    throw new Error(
      `Cline ACP initialize did not identify a cline agent at or above ${CLINE_MINIMUM_SUPPORTED_VERSION}.`);
  }
}

function optionIdentity(value: any): string | undefined {
  return bounded(value?.optionId) ?? bounded(value?.id);
}

function permissionDecision(kind: unknown, name: unknown): PermissionDecision | undefined {
  const value = `${String(kind ?? '')} ${String(name ?? '')}`.toLowerCase();
  if (/reject|deny|cancel/u.test(value)) return 'reject';
  if (/always|session/u.test(value)) return 'approve-session';
  if (/allow|approve|once/u.test(value)) return 'approve';
  return undefined;
}

function updateText(update: Record<string, any>): string | undefined {
  const content = update.content ?? update.chunk ?? update.message;
  return bounded(typeof content === 'string' ? content : content?.text, 2 * 1024 * 1024);
}

function bounded(value: unknown, max = MAX_PERMISSION_FIELD_CHARS): string | undefined {
  const text = typeof value === 'string' ? value : '';
  return text && text.length <= max ? text : undefined;
}

function appendTurnText(semantics: TurnSemantic[], kind: 'answer' | 'thinking', text: string): void {
  const previous = semantics.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else semantics.push({ kind, text });
}

function durableTurnSemantics(messages: readonly AgentMessage[]): TurnSemantic[] {
  const semantics: TurnSemantic[] = [];
  for (const message of messages) {
    if (message.type === 'model-output' && message.text) appendTurnText(semantics, 'answer', message.text);
    else if (message.type === 'thinking' && message.text) appendTurnText(semantics, 'thinking', message.text);
    else if (message.type === 'tool-call') semantics.push({ kind: 'tool-call', callId: message.callId });
    else if (message.type === 'tool-result') {
      semantics.push({ kind: 'tool-result', callId: message.callId, isError: message.isError === true });
    }
  }
  return semantics;
}

function turnSemanticShape(semantics: readonly TurnSemantic[]): string {
  const tools = new Map<string, number>();
  const ordinal = (callId: string): number => {
    const existing = tools.get(callId);
    if (existing !== undefined) return existing;
    const next = tools.size + 1;
    tools.set(callId, next);
    return next;
  };
  return semantics.map((entry) => {
    if ('text' in entry) return `${entry.kind}:${entry.text.length}`;
    if (entry.kind === 'tool-call') return `tool-call:${ordinal(entry.callId)}`;
    return `tool-result:${ordinal(entry.callId)}:${entry.isError ? 'error' : 'ok'}`;
  }).join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedPayload(value: unknown, maxBytes = 64 * 1024): unknown {
  if (value === undefined) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes
      ? value
      : { truncated: true, summary: 'Cline live payload exceeded the display bound.' };
  } catch {
    return { truncated: true, summary: 'Cline live payload was not serializable.' };
  }
}

function confirmedConfigValue(result: { configOptions?: unknown[] | null }, id: string): unknown {
  const options = Array.isArray(result.configOptions) && result.configOptions.length <= 256
    ? result.configOptions
    : [];
  const matches = options.filter((value): value is Record<string, unknown> => isRecord(value) && value.id === id);
  return matches.length === 1 ? matches[0]!.currentValue : undefined;
}

async function configureClineSession(
  client: AcpClient,
  sessionId: string,
  model: PromptInput['model'] | undefined,
  permissionMode: string | undefined,
): Promise<void> {
  if (model) {
    const result = await client.sessionSetConfigOption({ sessionId, configId: 'model', value: model.modelID });
    if (confirmedConfigValue(result, 'model') !== model.modelID) {
      throw new Error(`Cline did not confirm model ${model.modelID}.`);
    }
  }
  if (permissionMode) {
    const mode = permissionMode === 'plan' ? 'plan'
      : permissionMode === 'ask' || permissionMode === 'auto' ? 'act'
        : undefined;
    if (!mode) throw new Error(`Cline permission mode ${permissionMode} is unsupported.`);
    const modeResult = await client.sessionSetConfigOption({ sessionId, configId: 'mode', value: mode });
    if (confirmedConfigValue(modeResult, 'mode') !== mode) {
      throw new Error(`Cline did not confirm mode ${mode}.`);
    }
    const approve = permissionMode === 'auto';
    const approvalResult = await client.sessionSetConfigOption({
      sessionId,
      configId: 'auto_approve',
      type: 'boolean',
      value: approve,
    });
    if (confirmedConfigValue(approvalResult, 'auto_approve') !== approve) {
      throw new Error(`Cline did not confirm auto-approve=${String(approve)}.`);
    }
  }
}

export class ClineDriveConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly observer: ClineObserveConnection;
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly retiredPermissionIds = new Set<string>();
  private readonly claimedKeys = new Map<string, string>();
  private readonly claimedOutputKeys = new Map<string, { key: string; text: string }>();
  private readonly knownUserKeys = new Set<string>();
  private client?: AcpClient;
  private starting?: Promise<AcpClient>;
  private clientClosing?: Promise<void>;
  private turnChain: Promise<void> = Promise.resolve();
  private turnGeneration = 0;
  private permissionIngressGeneration?: number;
  private activeTurn?: { generation: number; record: LiveTurnRecord };
  private closed = false;
  private demoted = false;
  private liveTurn = 0;
  private readonly liveTurns: LiveTurnRecord[] = [];
  private observerUnsubscribe?: Unsubscribe;
  private pendingCreate?: NonNullable<ClineDriveOptions['pendingCreate']>;
  private materializingCreate?: Promise<void>;
  private ownershipPrimed = false;
  private ownershipBoundary?: HistorySourceIdentity;

  constructor(private readonly options: ClineDriveOptions) {
    this.info = options.info;
    this.observer = new ClineObserveConnection({
      session: options.session,
      info: options.info,
      ...(options.trace ? { trace: options.trace } : {}),
      ...options.observe,
    });
    if (options.pendingCreate) this.pendingCreate = options.pendingCreate;
    else this.startObserver();
  }

  /** Retain the exact ACP child that answered session/new until its first prompt materializes disk state. */
  static async createPending(
    cwd: string,
    build: (sessionId: string) => { session: ClineStoredSession; info: SessionInfo },
    options: Omit<ClineDriveOptions, 'session' | 'info'>,
  ): Promise<ClineDriveConnection> {
    let connection: ClineDriveConnection | undefined;
    let client: AcpClient | undefined;
    try {
      client = await AcpClient.connect({
        command: options.command,
        args: options.args,
        cwd,
        env: options.env,
        requestTimeoutMs: options.requestTimeoutMs,
        promptTimeoutMs: options.promptTimeoutMs,
        trace: (event) => options.trace?.({ op: 'observe', detail: `Cline ACP ${event.kind}: ${event.message}` }),
        hooks: {
          onSessionUpdate: (params) => connection?.acceptUpdate(params),
          onPermissionRequest: (params) => connection?.acceptPermission(params)
            ?? { outcome: { outcome: 'cancelled' } },
        },
      });
      assertMeasuredClineAgent(client);
      if (options.authMethodId) await client.authenticate({ methodId: options.authMethodId });
      const created = await client.sessionNew({ cwd, mcpServers: [] });
      const sessionId = bounded(created.sessionId, 512);
      if (!sessionId || sessionId === '.' || sessionId === '..' || /[\\/\0]/u.test(sessionId)) {
        throw new Error('Cline session/new returned no safe stable session id.');
      }
      await configureClineSession(client, sessionId, options.model, options.permissionMode);
      const provisional = build(sessionId);
      connection = new ClineDriveConnection({ ...options, ...provisional });
      connection.client = client;
      void client.exited?.then(() => {
        if (connection && !connection.closed && !connection.demoted) {
          connection.demote('Cline ACP child exited; Drive ownership was released.');
        }
      });
      return connection;
    } catch (error) {
      await client?.close({ force: true }).catch(() => undefined);
      throw error;
    }
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async initialize(): Promise<void> {
    this.assertWritable('initialize');
    await this.ensureClient();
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  async getHistory(): Promise<AgentMessage[]> {
    return this.readHistory(true);
  }

  private async readHistory(publishBoundary: boolean): Promise<AgentMessage[]> {
    if (this.pendingCreate) return [...this.pendingPrompts.map((entry) => entry.row)];
    const history = await this.observer.getHistory();
    const identity = this.observer.lastHistorySourceIdentity();
    this.reconcile(history);
    if (publishBoundary && !this.demoted && !this.closed && identity) this.publishHistoryBoundary(identity);
    return [...history, ...this.pendingPrompts.map((entry) => entry.row)];
  }

  getHistorySourceIdentity() {
    return this.pendingCreate ? Promise.resolve(undefined) : this.observer.getHistorySourceIdentity();
  }
  captureHistorySnapshot(sink: Parameters<NonNullable<SessionConnection['captureHistorySnapshot']>>[0]) {
    return this.pendingCreate ? Promise.resolve(undefined) : this.observer.captureHistorySnapshot(sink);
  }

  getPending(): AgentMessage[] {
    return [
      ...this.pendingPrompts.map((entry) => entry.row),
      ...[...this.pendingPermissions.values()].map((entry) => entry.message),
    ];
  }

  async listModels(): Promise<ModelOption[]> {
    return (this.options.models ?? []).map((model) => ({ ...model }));
  }

  async listModes(): Promise<ModeOption[]> {
    return (this.options.modes ?? []).map((mode) => ({ ...mode }));
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertWritable('prompt');
    if (input.files?.length || input.images?.length) {
      throw new Error('Cline ACP file/image input remains disabled until its native echo is captured.');
    }
    if (input.model) {
      const currentProvider = this.info.currentModel?.providerID ?? this.options.model?.providerID;
      const offered = (this.options.models ?? []).some((model) => model.providerID === input.model!.providerID
        && model.modelID === input.model!.modelID);
      if (!currentProvider || input.model.providerID !== currentProvider || !offered) {
        throw new Error('Cline per-turn model changes are limited to advertised models from the active native provider.');
      }
    }
    if (input.permissionMode
      && !(this.options.modes ?? []).some((mode) => mode.value === input.permissionMode)) {
      throw new Error(`Cline permission mode ${input.permissionMode} is not in the measured native catalog.`);
    }
    const text = input.text;
    const key = input.clientMessageId?.trim() || `cline:queued:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const generation = this.turnGeneration;
    const run = async () => {
      let nativeStarted = false;
      try {
        this.assertWritable('prompt');
        const client = await this.ensureClient();
        if (generation !== this.turnGeneration) throw new Error('Cline prompt was cancelled before delivery.');
        if (!this.pendingCreate) await this.assertOwnershipBeforePrompt();
        const pending: PendingPrompt = {
          text,
          key,
          // readHistory exposes stable app keys for claimed rows, while durable ownership and echo
          // reconciliation operate on native transcript keys. Snapshot the native ownership set here.
          baseline: new Set(this.knownUserKeys),
          row: { type: 'user-message', text, key, clientKey: key, queued: true },
        };
        this.pendingPrompts.push(pending);
        while (this.pendingPrompts.length > MAX_PENDING_PROMPTS) this.pendingPrompts.shift();
        this.emit(pending.row);
        if (input.model || input.permissionMode) {
          // Configuration calls mutate native state. A timeout after this
          // point is ownership-ambiguous and must retire the ACP writer.
          nativeStarted = true;
          await configureClineSession(client, this.info.id, input.model, input.permissionMode);
          if (input.model) {
            this.info.currentModel = { ...input.model };
            this.info.model = `${input.model.providerID}/${input.model.modelID}`;
          }
          if (input.permissionMode) this.info.currentMode = input.permissionMode;
          this.emit({ type: 'metadata-update', key: 'sessionInfo', value: {
            ...(input.model ? { currentModel: this.info.currentModel, model: this.info.model } : {}),
            ...(input.permissionMode ? { currentMode: this.info.currentMode } : {}),
          } });
          this.options.onConfiguration?.(this);
        }
        if (!this.pendingCreate) await this.assertOwnershipBeforePrompt();
        this.info.status = 'working';
        this.liveTurn += 1;
        const liveTurn: LiveTurnRecord = {
          turn: this.liveTurn,
          promptText: text,
          userEchoSeen: false,
          ingressAmbiguous: false,
          answer: '',
          thinking: '',
          toolCallIds: new Set(),
          semantics: [],
          durableAnswer: '',
          durableThinking: '',
          answerClaimed: false,
          thinkingClaimed: false,
        };
        this.liveTurns.push(liveTurn);
        while (this.liveTurns.length > 64) this.liveTurns.shift();
        this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
        nativeStarted = true;
        this.permissionIngressGeneration = generation;
        this.activeTurn = { generation, record: liveTurn };
        try {
          await client.sessionPrompt({ sessionId: this.info.id, prompt: [{ type: 'text', text }] });
        } finally {
          if (this.activeTurn?.record === liveTurn) this.activeTurn = undefined;
        }
        if (generation !== this.turnGeneration) return;
        // The ACP prompt has RETURNED, so the answer this turn streamed is
        // complete. Republished as whole `text` under the same key — idempotent
        // for a reader that already has it — carrying `final: true`, which the
        // client requires before it will read a turn aloud or copy its text.
        // Cline set that flag nowhere, so both features were dead on every
        // Cline session while reasonix and omp had them.
        if (liveTurn.answer) {
          this.emit({
            type: 'model-output',
            text: liveTurn.answer,
            key: `cline:live:${liveTurn.turn}:answer`,
            final: true,
          });
        }
        await this.materializeCreatedSession();
        const durable = await this.readHistory(false);
        const firstIdentity = this.observer.lastHistorySourceIdentity();
        if (generation !== this.turnGeneration) {
          throw new Error('Cline prompt ownership changed while validating its durable response.');
        }
        this.assertWritable('prompt');
        const validateDurableTurn = (history: AgentMessage[]): void => {
          const claimedUserIndex = history.findIndex((message) =>
            message.type === 'user-message' && message.clientKey === key);
          if (this.pendingPrompts.some((entry) => entry.key === key) || claimedUserIndex < 0) {
            throw new Error('Cline first prompt did not materialize one correlatable durable user row.');
          }
          const durableSemantics = durableTurnSemantics(history.slice(claimedUserIndex + 1));
          if (!liveTurn.userEchoSeen || liveTurn.ingressAmbiguous || liveTurn.semantics.length === 0
            || JSON.stringify(durableSemantics) !== JSON.stringify(liveTurn.semantics)) {
            this.options.trace?.({
              op: 'observe',
              detail: `Cline turn semantic mismatch delimiter=${String(liveTurn.userEchoSeen)} ambiguous=${String(liveTurn.ingressAmbiguous)} live=[${turnSemanticShape(liveTurn.semantics)}] durable=[${turnSemanticShape(durableSemantics)}]`,
            });
            throw new Error('Cline native turn did not produce one exact durable semantic response.');
          }
        };
        validateDurableTurn(durable);
        const confirmed = await this.readHistory(false);
        const confirmedIdentity = this.observer.lastHistorySourceIdentity();
        if (generation !== this.turnGeneration) {
          throw new Error('Cline prompt ownership changed during durable response confirmation.');
        }
        this.assertWritable('prompt');
        validateDurableTurn(confirmed);
        if (!firstIdentity || !confirmedIdentity || !sameHistoryBoundary(firstIdentity, confirmedIdentity)) {
          throw new Error('Cline durable response changed while its ownership boundary was being confirmed.');
        }
        this.publishHistoryBoundary(confirmedIdentity);
      } catch (error) {
        if (nativeStarted) await this.getHistory().catch(() => undefined);
        this.removePendingPrompt(key);
        this.emit({ type: 'history-reset' });
        if (nativeStarted && !this.demoted && !this.closed) {
          this.demote(`Cline ACP prompt transport became ambiguous: ${error instanceof Error ? error.message : String(error)}.`);
        }
        throw error;
      } finally {
        if (this.activeTurn?.generation === generation) this.activeTurn = undefined;
        if (this.permissionIngressGeneration === generation) this.permissionIngressGeneration = undefined;
        this.cancelPendingPermissions();
        if (!this.demoted && !this.closed) {
          this.info.status = 'idle';
          this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
          await this.getHistory().catch(() => undefined);
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
    if (!pending) throw new Error('Cline permission request is no longer pending.');
    const selected = pending.options.get(decision);
    if (!selected) throw new Error(`Cline permission decision ${decision} was not advertised for ${requestId}.`);
    this.pendingPermissions.delete(requestId);
    this.retirePermissionId(requestId);
    this.emit({ type: 'permission-resolved', requestId, decision });
    pending.resolve({ outcome: { outcome: 'selected', optionId: selected } });
    if (!this.demoted && !this.closed) {
      this.info.status = 'working';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
    }
  }

  async listCommands() {
    return [{ name: 'stop', description: 'Stop the running turn', kind: 'action' as const }];
  }

  async runCommand(name: string) {
    if (name !== 'stop' && name !== 'abort') throw new Error(`Cline Drive does not support /${name}.`);
    this.assertWritable('cancel');
    this.turnGeneration += 1;
    this.permissionIngressGeneration = undefined;
    if (this.client?.alive) this.client.sessionCancel(this.info.id);
    this.cancelPendingPermissions('reject');
    this.pendingPrompts.length = 0;
    this.emit({ type: 'history-reset' });
    this.info.status = 'idle';
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
    return { notice: 'Stop requested.' };
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client?.alive) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let client: AcpClient | undefined;
      try {
        await this.primeOwnershipBeforeLoad();
        client = await AcpClient.connect({
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.session.cwd,
        env: this.options.env,
        requestTimeoutMs: this.options.requestTimeoutMs,
        promptTimeoutMs: this.options.promptTimeoutMs,
        trace: (event) => this.options.trace?.({ op: 'observe', detail: `Cline ACP ${event.kind}: ${event.message}` }),
        hooks: {
          onSessionUpdate: (params) => this.acceptUpdate(params),
          onPermissionRequest: (params) => this.acceptPermission(params),
        },
        });
        assertMeasuredClineAgent(client);
        if (this.options.authMethodId) {
          await client.authenticate({ methodId: this.options.authMethodId });
        }
        await client.sessionLoad({ sessionId: this.info.id, cwd: this.options.session.cwd, mcpServers: [] });
        await configureClineSession(client, this.info.id, this.options.model, this.options.permissionMode);
        await this.verifyOwnershipAfterLoad();
        // Re-checked HERE, after every await. A `close()` or a `demote()` that
        // arrived while this was still spawning found `this.client` undefined,
        // killed nothing, and resolved reporting a teardown it never performed;
        // the assignment below then handed the connection a child that both
        // paths would thereafter skip on their own flags, so nothing ever
        // closed it. Grok and reasonix both re-check at this point.
        if (this.closed || this.demoted) {
          await client.close({ force: true }).catch(() => undefined);
          throw new Error('Cline Drive was closed while its ACP child was starting.');
        }
        this.client = client;
        void client.exited?.then(() => {
          if (!this.closed && !this.demoted) this.demote('Cline ACP child exited; Drive ownership was released.');
        });
        return client;
      } catch (error) {
        await client?.close({ force: true }).catch(() => undefined);
        throw error;
      }
    })();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private startObserver(): void {
    if (this.observerUnsubscribe) return;
    this.observerUnsubscribe = this.observer.subscribe((message) => this.acceptObserved(message));
  }

  private async materializeCreatedSession(): Promise<void> {
    const pending = this.pendingCreate;
    if (!pending) return;
    if (this.materializingCreate) return this.materializingCreate;
    const work = (async () => {
      const materialized = await pending.discover();
      if (!materialized
        || materialized.id !== this.options.session.id
        || materialized.nativeId !== this.options.session.nativeId
        || materialized.cwd !== this.options.session.cwd) {
        throw new Error(`Cline created ${this.options.session.id}, but its first prompt did not publish the expected durable identity.`);
      }
      Object.assign(this.options.session, materialized);
      this.pendingCreate = undefined;
      this.ownershipPrimed = true;
      this.startObserver();
      pending.onMaterialized?.(this, materialized);
      this.emit({ type: 'history-reset' });
    })();
    this.materializingCreate = work;
    try { await work; } finally {
      if (this.materializingCreate === work) this.materializingCreate = undefined;
    }
  }

  private acceptUpdate(params: AcpSessionUpdateParams): void {
    if (params.sessionId && params.sessionId !== this.info.id) return;
    const update = (params.update ?? {}) as Record<string, any>;
    const text = updateText(update);
    const active = this.activeTurn?.generation === this.turnGeneration && !this.demoted && !this.closed
      ? this.activeTurn.record
      : undefined;
    if (update.sessionUpdate === 'user_message_chunk') {
      if (active) {
        if (active.userEchoSeen || text !== active.promptText) active.ingressAmbiguous = true;
        else active.userEchoSeen = true;
      }
    } else if (update.sessionUpdate === 'agent_message_chunk' && text) {
      if (!active?.userEchoSeen || active.ingressAmbiguous) return;
      active.answer += text;
      appendTurnText(active.semantics, 'answer', text);
      this.emit({ type: 'model-output', delta: text, key: `cline:live:${active.turn}:answer` });
    } else if (update.sessionUpdate === 'agent_thought_chunk' && text) {
      if (!active?.userEchoSeen || active.ingressAmbiguous) return;
      active.thinking += text;
      appendTurnText(active.semantics, 'thinking', text);
      this.emit({ type: 'thinking', delta: text, key: `cline:live:${active.turn}:thinking` });
    } else if (update.sessionUpdate === 'current_mode_update') {
      const nativeMode = bounded(update.currentMode ?? update.mode)?.toLowerCase();
      const mode = nativeMode === 'plan' ? 'plan'
        : nativeMode === 'act' ? (this.info.currentMode === 'auto' ? 'auto' : 'ask')
          : undefined;
      if (mode) {
        this.info.currentMode = mode;
        this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentMode: mode } });
        this.options.onConfiguration?.(this);
      }
    } else if (update.sessionUpdate === 'tool_call') {
      if (!active?.userEchoSeen || active.ingressAmbiguous) return;
      const callId = bounded(update.toolCallId ?? update.id) ?? `cline-tool:${active.turn}:${Date.now()}`;
      if (active.toolCallIds.has(callId)) {
        active.ingressAmbiguous = true;
        return;
      }
      active.toolCallIds.add(callId);
      active.semantics.push({ kind: 'tool-call', callId });
      const name = bounded(update.title ?? update.name) ?? 'Cline tool';
      this.emit({
        type: 'tool-call',
        callId,
        toolName: name,
        title: name,
        ...(update.rawInput === undefined ? {} : { args: boundedPayload(update.rawInput) }),
      });
    } else if (update.sessionUpdate === 'tool_call_update') {
      if (!active?.userEchoSeen || active.ingressAmbiguous) return;
      const callId = bounded(update.toolCallId ?? update.id) ?? `cline-tool:${active.turn}:unknown`;
      if (!active.toolCallIds.has(callId)) {
        active.ingressAmbiguous = true;
        return;
      }
      const name = bounded(update.title ?? update.name) ?? 'Cline tool';
      const status = bounded(update.status)?.toLowerCase() ?? '';
      if (/complete|success|fail|error|cancel|interrupt/u.test(status)) {
        const isError = /fail|error|cancel|interrupt/u.test(status);
        active.semantics.push({ kind: 'tool-result', callId, isError });
        this.emit({
          type: 'tool-result',
          callId,
          toolName: name,
          title: name,
          ...(update.rawOutput === undefined && update.content === undefined
            ? {} : { result: boundedPayload(update.rawOutput ?? update.content) }),
          isError,
        });
      }
    } else if (update.sessionUpdate === 'usage_update') {
      const nativeCost = isRecord(update.cost) ? update.cost : undefined;
      const currency = bounded(nativeCost?.currency)?.toUpperCase();
      // AgentMessage cost is denominated in USD. Do not silently relabel a
      // differently denominated native amount.
      const cost = currency === undefined || currency === 'USD'
        ? nonNegative(nativeCost?.amount)
        : undefined;
      if (cost !== undefined) {
        this.emit({
          type: 'token-count',
          cost,
        });
      }
      const used = nonNegative(update.used ?? update.tokensUsed ?? update.contextUsed);
      const max = nonNegative(update.size ?? update.contextSize ?? update.contextWindow);
      if (used !== undefined || max !== undefined) {
        this.emit({
          type: 'metadata-update',
          key: 'contextUsage',
          value: {
            ...(used === undefined ? {} : { used }),
            ...(max === undefined ? {} : { max }),
          },
        });
      }
    } else if (update.sessionUpdate === 'session_info_update') {
      const title = bounded(update.title, 4_096);
      if (title) {
        this.info.title = title;
        this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { title } });
      }
    } else if (update.sessionUpdate === 'config_option_update') {
      const rawOptions = Array.isArray(update.configOptions) ? update.configOptions : [update];
      for (const raw of rawOptions.slice(0, 256)) {
        if (!isRecord(raw)) continue;
        const id = bounded(raw.id ?? raw.configId);
        const value = raw.currentValue ?? raw.value;
        if (id === 'model' && typeof value === 'string' && value.length <= 512) {
          const providerID = this.info.currentModel?.providerID;
          if (providerID) {
            const previous = this.info.currentModel;
            const catalog = this.options.models?.find((model) =>
              model.providerID === providerID && model.modelID === value);
            const label = catalog?.label
              ?? (previous?.providerID === providerID && previous.modelID === value ? previous.label : undefined);
            this.info.currentModel = { providerID, modelID: value, ...(label ? { label } : {}) };
            this.info.model = `${providerID}/${value}`;
            this.emit({ type: 'metadata-update', key: 'sessionInfo', value: {
              currentModel: this.info.currentModel,
              model: this.info.model,
            } });
          }
        }
      }
      this.options.onConfiguration?.(this);
    }
  }

  private acceptPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    if (this.closed || this.demoted
      || this.permissionIngressGeneration !== this.turnGeneration
      || (params.sessionId && params.sessionId !== this.info.id)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const requestId = bounded(params.toolCall?.toolCallId ?? params.toolCall?.id)
      ?? `cline-permission:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (this.pendingPermissions.has(requestId) || this.retiredPermissionIds.has(requestId)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const options = new Map<PermissionDecision, string>();
    for (const option of params.options ?? []) {
      const id = optionIdentity(option);
      const decision = permissionDecision(option.kind, option.name);
      if (id && decision && !options.has(decision)) options.set(decision, id);
    }
    const message: PendingPermission['message'] = {
      type: 'permission-request',
      requestId,
      title: bounded(params.toolCall?.title ?? params.toolCall?.name) ?? 'Cline permission request',
      toolName: bounded(params.toolCall?.name),
      detail: bounded(params.toolCall?.rawInput ?? params.toolCall?.input, 4096),
      options: [...options.keys()],
      ...(options.size === 0 ? { readOnly: true } : {}),
    };
    if (options.size === 0) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { message, options, resolve });
      this.info.status = 'needs-input';
      this.emit(message);
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'needs-input' } });
    });
  }

  private acceptObserved(message: AgentMessage): void {
    if (message.type === 'history-reset') {
      this.claimedKeys.clear();
      this.claimedOutputKeys.clear();
      this.knownUserKeys.clear();
      this.pendingPrompts.length = 0;
      this.liveTurns.length = 0;
      this.demote('The Cline transcript was rewritten; Drive ownership must be re-established before more writes.');
      this.emit(message);
      return;
    }
    if (message.type !== 'user-message') {
      this.emit(this.reconcileLiveOutput(message));
      return;
    }
    if (message.key) {
      const claimed = this.claimedKeys.get(message.key);
      if (claimed) {
        this.knownUserKeys.add(message.key);
        this.emit({ ...message, key: claimed, clientKey: claimed });
        return;
      }
      if (this.knownUserKeys.has(message.key)) {
        this.emit(message);
        return;
      }
    }
    const pending = this.pendingPrompts.find((entry) => entry.text === message.text
      && !!message.key && !entry.baseline.has(message.key));
    if (pending) {
      this.pendingPrompts.splice(this.pendingPrompts.indexOf(pending), 1);
      if (message.key) {
        this.rememberClaim(message.key, pending.key);
        this.knownUserKeys.add(message.key);
      }
      this.emit({ ...message, key: pending.key, clientKey: pending.key });
      return;
    }
    if (!this.demoted && !this.closed) this.demote('A foreign Cline writer appended a user prompt; this connection is now read-only.');
    this.emit(message);
  }

  private reconcile(history: AgentMessage[]): void {
    const liveKeyIndexes = new Map<string, number>();
    const correlatedUserRows = new Map<AgentMessage, string>();
    for (let index = 0; index < history.length; index += 1) {
      history[index] = this.reconcileLiveOutput(history[index]!);
      const current = history[index]!;
      const key = 'key' in current ? current.key : undefined;
      if (!key?.startsWith('cline:live:')) continue;
      const previous = liveKeyIndexes.get(key);
      if (previous === undefined) {
        liveKeyIndexes.set(key, index);
        continue;
      }
      history[previous] = history[index]!;
      history.splice(index, 1);
      index -= 1;
    }
    for (const message of history) {
      if (message.type !== 'user-message' || !message.key) continue;
      const claimed = this.claimedKeys.get(message.key);
      if (claimed) {
        this.knownUserKeys.add(message.key);
        correlatedUserRows.set(message, claimed);
      }
    }
    for (const pending of [...this.pendingPrompts]) {
      const delivered = history.find((message) => message.type === 'user-message'
        && message.text === pending.text && !!message.key && !pending.baseline.has(message.key));
      if (!delivered || delivered.type !== 'user-message') continue;
      if (delivered.key) {
        this.rememberClaim(delivered.key, pending.key);
        this.knownUserKeys.add(delivered.key);
      }
      correlatedUserRows.set(delivered, pending.key);
      this.pendingPrompts.splice(this.pendingPrompts.indexOf(pending), 1);
    }
    if (this.ownershipPrimed && !this.demoted && !this.closed) {
      // Ownership is classified against native transcript keys. App correlation keys are applied only
      // afterward; otherwise a correctly claimed row would appear foreign to knownUserKeys.
      const foreign = history.find((message) => message.type === 'user-message'
        && !!message.key && !this.knownUserKeys.has(message.key));
      if (foreign?.type === 'user-message') {
        this.demote('A foreign Cline writer appended a user prompt; this connection is now read-only.');
      } else {
        for (const message of history) {
          if (message.type === 'user-message' && message.key) this.knownUserKeys.add(message.key);
        }
      }
    }
    for (const [message, key] of correlatedUserRows) {
      Object.assign(message, { key, clientKey: key });
    }
  }

  private async primeOwnershipBeforeLoad(): Promise<void> {
    if (this.ownershipPrimed) return;
    const history = await this.observer.getHistory();
    const identity = this.observer.lastHistorySourceIdentity();
    if (!identity) throw new Error('Cline Drive requires one clean stable transcript identity.');
    if (this.options.expectedHistoryBoundary
      && !sameHistoryBoundary(this.options.expectedHistoryBoundary, identity)) {
      throw new Error('Cline transcript changed after durable restart ownership was checked.');
    }
    this.knownUserKeys.clear();
    for (const message of history) {
      if (message.type === 'user-message' && message.key) this.knownUserKeys.add(message.key);
    }
    this.ownershipBoundary = identity;
    this.ownershipPrimed = true;
  }

  private async verifyOwnershipAfterLoad(): Promise<void> {
    const history = await this.observer.getHistory();
    const identity = this.observer.lastHistorySourceIdentity();
    this.reconcile(history);
    if (!identity || !this.ownershipBoundary || !sameHistoryBoundary(this.ownershipBoundary, identity)) {
      throw new Error('Cline transcript changed while its ACP writer was opening.');
    }
    this.options.onHistoryBoundary?.(identity);
  }

  private publishHistoryBoundary(identity: HistorySourceIdentity): void {
    if (this.demoted || this.closed) return;
    this.ownershipBoundary = identity;
    this.options.onHistoryBoundary?.(identity);
  }

  private async assertOwnershipBeforePrompt(): Promise<AgentMessage[]> {
    const history = await this.observer.getHistory();
    const identity = this.observer.lastHistorySourceIdentity();
    this.reconcile(history);
    this.assertWritable('prompt');
    if (!identity || !this.ownershipBoundary || !sameHistoryBoundary(this.ownershipBoundary, identity)) {
      this.demote('The Cline transcript changed before prompt delivery; Drive ownership was released.');
      throw new Error('Cline prompt refused because its durable transcript ownership changed.');
    }
    return history;
  }

  private reconcileLiveOutput(message: AgentMessage): AgentMessage {
    if ((message.type !== 'model-output' && message.type !== 'thinking') || !message.text) return message;
    if (message.key) {
      const existing = this.claimedOutputKeys.get(message.key);
      if (existing) return { ...message, key: existing.key, text: existing.text };
    }
    const field = message.type === 'model-output' ? 'answer' : 'thinking';
    const durableField = message.type === 'model-output' ? 'durableAnswer' : 'durableThinking';
    const claimed = message.type === 'model-output' ? 'answerClaimed' : 'thinkingClaimed';
    const live = this.liveTurns.find((candidate) => !candidate[claimed]
      && candidate[field].startsWith(candidate[durableField] + message.text));
    if (!live) return message;
    live[durableField] += message.text;
    if (live[durableField] === live[field]) live[claimed] = true;
    const key = `cline:live:${live.turn}:${field}`;
    if (message.key) this.claimedOutputKeys.set(message.key, { key, text: live[durableField] });
    return { ...message, key, text: live[durableField] };
  }

  private removePendingPrompt(key: string): void {
    const index = this.pendingPrompts.findIndex((entry) => entry.key === key);
    if (index >= 0) this.pendingPrompts.splice(index, 1);
  }

  private rememberClaim(key: string, clientKey: string): void {
    this.claimedKeys.delete(key);
    this.claimedKeys.set(key, clientKey);
    while (this.claimedKeys.size > 512) this.claimedKeys.delete(this.claimedKeys.keys().next().value!);
  }

  private assertWritable(action: string): void {
    if (this.closed || this.demoted) throw new Error(`Cline ${action} refused: this connection is read-only.`);
  }

  /**
   * Retire every outstanding approval.
   *
   * `decision` is what the CLIENT is told, and it is not always `'reject'`. A
   * user pressing Stop did make a choice, and `'reject'` is honest there. A turn
   * ending, a close, or a demotion did not: attributing those to the user
   * renders a refusal they never made, which is the case `62c1edbf` introduced
   * `'external'` for. The ACP child is told `cancelled` either way — that is the
   * real decision and it does not change.
   */
  private cancelPendingPermissions(decision: PermissionDecision | 'external' = 'external'): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.retirePermissionId(requestId);
      this.emit({ type: 'permission-resolved', requestId, decision });
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
  }

  private retirePermissionId(requestId: string): void {
    this.retiredPermissionIds.delete(requestId);
    this.retiredPermissionIds.add(requestId);
    while (this.retiredPermissionIds.size > 512) {
      this.retiredPermissionIds.delete(this.retiredPermissionIds.keys().next().value!);
    }
  }

  private demote(reason: string): void {
    if (this.demoted || this.closed) return;
    this.demoted = true;
    this.turnGeneration += 1;
    this.permissionIngressGeneration = undefined;
    if (this.client?.alive) this.client.sessionCancel(this.info.id);
    // Retained rather than fired and forgotten, so a later `close()` can await
    // the teardown it is about to report as done.
    this.clientClosing = this.client?.close({ force: true }).catch(() => undefined);
    this.cancelPendingPermissions();
    this.info.status = 'idle';
    this.info.attachMode = 'observe';
    this.info.control = {
      drive: { supported: false, state: 'observing', reason },
      terminalSync: { supported: false, syncAvailable: false, active: false, reason },
    };
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: {
      status: 'idle', attachMode: 'observe', control: this.info.control,
    } });
    this.emit({ type: 'notice', message: reason });
    this.options.onDemote?.(this);
  }

  get driving(): boolean {
    return !this.closed && !this.demoted && this.client?.alive === true;
  }

  revokeOwnership(reason = 'Cline durable Drive ownership was revoked.'): void {
    this.demote(reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turnGeneration += 1;
    this.permissionIngressGeneration = undefined;
    this.pendingPrompts.length = 0;
    this.observerUnsubscribe?.();
    try {
      await this.observer.close();
      this.cancelPendingPermissions();
      // A startup racing this close owns a child `this.client` cannot see. It
      // now re-checks `closed` after its awaits and kills what it spawned, but
      // that kill lives inside `this.starting` — so without joining it here,
      // `close()` still returns while the child is being torn down, which is
      // the half of the defect `clientClosing` exists to fix. Bounded by the
      // connect and request timeouts the startup already carries.
      await this.starting?.catch(() => undefined);
      // Cline 3.0.60 does not implement session/close. Closing the retained
      // stdio child is the measured native ownership release.
      await this.client?.close();
      // A demote already in flight owns the same child; join it rather than
      // returning while its kill is still outstanding.
      await this.clientClosing;
    } finally {
      this.handlers.clear();
      this.options.onClose?.(this);
    }
  }
}
