import { randomUUID } from 'node:crypto';
import {
  AcpClient,
  AcpRpcError,
  type AcpChildExit,
  type AcpPermissionOption,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionPromptResult,
  type AcpSessionUpdateParams,
} from '@cosyncing/acp-client';
import type {
  AgentMessage,
  CommandInput,
  CommandResult,
  HistorySourceIdentity,
  HistoryQuery,
  ModeOption,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionInfo,
  SlashCommand,
} from '@cosyncing/adapter-api';
import {
  grokEventId,
  grokMessageKey,
  grokPromptId,
  grokTurnId,
  isGrokSessionUpdateMethod,
  mapGrokUpdate,
  turnPromptIds,
  type GrokUpdateEntry,
  type GrokUpdateRecord,
} from './mapping.ts';
import {
  GrokObserveConnection,
  type GrokHistoryIntegrityFailure,
  type GrokObserveOptions,
  type GrokReplayCorrelation,
  type GrokReplayCorrelations,
  type GrokTerminalSummary,
} from './observe.ts';
import {
  discoverGrokStore,
  type GrokStoredSession,
  type GrokUpdatesRead,
} from './store.ts';
import { grokBinaryMatchesVerifiedVersion, grokChildEnv } from './version.ts';
import { authenticateGrokClient } from './auth.ts';

export interface GrokAcpTransport {
  readonly alive: boolean;
  initialize?(): Promise<void>;
  sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult>;
  sessionCancel(sessionId: string): void;
  configure?(selection?: PromptInput['model'], permissionMode?: string): Promise<void>;
  listModels?(): Promise<ModelOption[]>;
  listCommands?(): Promise<SlashCommand[]>;
  close(force?: boolean): Promise<void>;
}

export interface GrokDriveOpenOptions extends Omit<GrokObserveOptions, 'session' | 'info'> {
  command?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  authMethodId?: string;
  requestTimeoutMs?: number;
  onConfiguration?: (info: Pick<SessionInfo, 'currentModel' | 'currentMode' | 'model'>) => void;
  onHistoryBoundary?: (
    identity: HistorySourceIdentity,
    terminalSummary?: GrokTerminalSummary,
  ) => void;
  expectedHistoryBoundary?: HistorySourceIdentity;
  onDemote?: (connection: GrokDriveConnection) => void;
  onClose?: (connection: GrokDriveConnection) => void;
  replayCorrelations?: GrokReplayCorrelations;
}

interface GrokLazyHooks {
  onUpdate(method: string, params: AcpSessionUpdateParams): void;
  onPermissionRequest(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> | AcpRequestPermissionResult;
  onExit(exit: AcpChildExit): void;
}

interface PendingPrompt {
  key: string;
  text: string;
  clientKey?: string;
  byteFence: number;
  row: Extract<AgentMessage, { type: 'user-message' }>;
  terminal: boolean;
}

type GrokRunSummary = Extract<AgentMessage, { type: 'run-summary' }>;

/** A turn this connection submitted and saw start, from `session/prompt` until its terminal
 *  is published. `held` keeps, in arrival order, terminal frames the tail drain (`live: false`)
 *  or ACP (`live: true`) delivered before the settle read proved which one is the turn's. */
interface OwnedLiveTurn {
  readonly pendingKey: string;
  readonly held: Array<{ message: GrokRunSummary; live: boolean }>;
}

interface PendingPermission {
  message: Extract<AgentMessage, { type: 'permission-request' }>;
  optionIds: Map<PermissionDecision, string>;
  resolve: (result: AcpRequestPermissionResult) => void;
}

class GrokPromptCancelledBeforeDelivery extends Error {
  constructor() {
    super('Grok prompt was cancelled before native delivery.');
    this.name = 'GrokPromptCancelledBeforeDelivery';
  }
}

class GrokDurablePromptNotSettled extends Error {
  constructor() {
    super('Grok completed ACP prompt without one exact durable owned user turn.');
  }
}

const MAX_PENDING_PROMPTS = 128;
const MAX_PROMPT_ADMISSIONS = 256;
const MAX_PENDING_PERMISSIONS = 64;
const MAX_NATIVE_PERMISSION_OPTIONS = 64;
const MAX_PERMISSION_FIELD_CHARS = 512;
const MAX_AVAILABLE_COMMANDS = 256;
const MAX_LIVE_STREAM_SLOTS = 512;
const MAX_HELD_TERMINALS = 64;
const MAX_PUBLISHED_RUN_KEYS = 512;
const MAX_MODE_CHARS = 128;
const ACTIVE_TAIL_SETTLE_ATTEMPTS = 7;
const ACTIVE_TAIL_SETTLE_MS = 40;

export const GROK_PERMISSION_MODES: readonly ModeOption[] = Object.freeze([
  // The pinned 1.0.13 child does not echo its launch mode from session/load.
  // Keep only the physically exercised ask-on-write default until each other
  // CLI mode has an independent native-behaviour capture.
  { value: 'default', label: 'Default', category: 'ask-permission' },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelToken(selection: PromptInput['model']): string | undefined {
  if (!selection) return undefined;
  return selection.providerID === 'xai'
    ? selection.modelID
    : `${selection.providerID}/${selection.modelID}`;
}

function modelSelection(token: string): { providerID: string; modelID: string } {
  const slash = token.indexOf('/');
  return slash > 0 && slash < token.length - 1
    ? { providerID: token.slice(0, slash), modelID: token.slice(slash + 1) }
    : { providerID: 'xai', modelID: token };
}

export function parseGrokModelCatalog(value: unknown): ModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.availableModels) || value.availableModels.length > 256) return [];
  return value.availableModels.flatMap((raw): ModelOption[] => {
    if (!isRecord(raw)
      || typeof raw.modelId !== 'string' || raw.modelId.length === 0 || raw.modelId.length > 512
      || typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 512) return [];
    const selection = modelSelection(raw.modelId);
    const meta = isRecord(raw._meta) ? raw._meta : undefined;
    const efforts: NonNullable<ModelOption['reasoningEfforts']> = [];
    let defaultReasoningEffort: string | undefined;
    const effortIds = new Set<string>();
    if (Array.isArray(meta?.reasoningEfforts) && meta.reasoningEfforts.length <= 32) {
      for (const choice of meta.reasoningEfforts) {
        if (!isRecord(choice)
          || typeof choice.value !== 'string' || choice.value.length === 0 || choice.value.length > 128
          || typeof choice.label !== 'string' || choice.label.length === 0 || choice.label.length > 512
          || effortIds.has(choice.value)) continue;
        effortIds.add(choice.value);
        efforts.push({
          effort: choice.value,
          label: choice.label,
          ...(typeof choice.description === 'string' && choice.description.length <= 2_048
            ? { description: choice.description }
            : {}),
        });
        if (choice.default === true && defaultReasoningEffort === undefined) {
          defaultReasoningEffort = choice.value;
        }
      }
    }
    return [{
      ...selection,
      label: raw.name,
      ...(typeof raw.description === 'string' && raw.description.length <= 2_048
        ? { description: raw.description }
        : {}),
      ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    }];
  });
}

function commandCatalog(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: SlashCommand[] = [];
  const names = new Set<string>();
  for (const raw of value.slice(0, MAX_AVAILABLE_COMMANDS)) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().replace(/^\/+/, '') : '';
    if (!name || name.length > 128 || /[\s/\u0000-\u001f]/u.test(name) || names.has(name)) continue;
    names.add(name);
    commands.push({
      name,
      kind: 'prompt',
      ...(typeof raw.description === 'string' && raw.description.trim()
        ? { description: raw.description.trim().slice(0, 2_048) }
        : {}),
    });
  }
  return commands;
}

function updateCommands(update: Record<string, unknown>): SlashCommand[] | undefined {
  return update.sessionUpdate === 'available_commands_update'
    ? commandCatalog(update.availableCommands)
    : undefined;
}

class LazyGrokAcpTransport implements GrokAcpTransport {
  private client?: AcpClient;
  private startupClient?: AcpClient;
  private startupAbort?: AbortController;
  private starting?: Promise<AcpClient>;
  private closed = false;
  private prompting = false;
  private generation = 0;
  private models: ModelOption[] = [];
  private commands: SlashCommand[] = [];
  private desiredModel?: string;
  private desiredEffort?: string;
  private desiredMode: string;
  private verifyRelaunchConfiguration = false;

  constructor(
    private readonly session: GrokStoredSession,
    private readonly options: GrokDriveOpenOptions,
    private readonly hooks: GrokLazyHooks,
  ) {
    this.desiredModel = options.model ?? session.model;
    this.desiredEffort = options.reasoningEffort ?? session.currentModel?.reasoningEffort;
    this.desiredMode = options.permissionMode ?? 'default';
  }

  get alive(): boolean {
    return !this.closed && (this.client?.alive ?? true);
  }

  async initialize(): Promise<void> { await this.ensureClient(); }

  async sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult> {
    const client = await this.ensureClient();
    this.prompting = true;
    try {
      return await client.sessionPrompt(params);
    } finally {
      this.prompting = false;
    }
  }

  sessionCancel(sessionId: string): void {
    if (this.client?.alive) this.client.sessionCancel(sessionId);
  }

  async configure(selection?: PromptInput['model'], permissionMode?: string): Promise<void> {
    const nextModel = modelToken(selection) ?? this.desiredModel;
    const nextEffort = selection?.reasoningEffort ?? this.desiredEffort;
    const nextMode = permissionMode ?? this.desiredMode;
    if (nextMode.length > MAX_MODE_CHARS || !GROK_PERMISSION_MODES.some((mode) => mode.value === nextMode)) {
      throw new Error(`Grok did not advertise permission mode ${nextMode}.`);
    }
    const changed = nextModel !== this.desiredModel || nextEffort !== this.desiredEffort || nextMode !== this.desiredMode;
    this.desiredModel = nextModel;
    this.desiredEffort = nextEffort;
    this.desiredMode = nextMode;
    if (!changed) return;
    this.verifyRelaunchConfiguration = true;
    if (!this.client && !this.starting) return;
    if (this.prompting) throw new Error('Grok cannot relaunch its ACP child during an active turn.');
    await this.stopCurrentClient(false);
    await this.ensureClient();
  }

  async listModels(): Promise<ModelOption[]> {
    await this.ensureClient();
    return this.models.map((model) => ({
      ...model,
      ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })) } : {}),
    }));
  }

  async listCommands(): Promise<SlashCommand[]> {
    await this.ensureClient();
    return this.commands.map((command) => ({ ...command }));
  }

  async close(force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.startupAbort?.abort();
    await this.stopCurrentClient(force);
  }

  private async stopCurrentClient(force: boolean): Promise<void> {
    this.generation += 1;
    const client = this.client ?? this.startupClient ?? await this.starting?.catch(() => undefined);
    this.client = undefined;
    this.startupClient = undefined;
    this.starting = undefined;
    if (!client) return;
    if (!force && client.alive) {
      await client.sessionClose({ sessionId: this.session.id }, 250).catch((error) => {
        this.options.trace?.({
          op: 'observe',
          detail: `Grok ACP session/close failed during relaunch: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
    await client.close({ force });
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.closed) throw new Error('Grok ACP transport is closed.');
    if (this.client?.alive) return this.client;
    if (!this.starting) {
      const generation = ++this.generation;
      this.starting = (async () => {
        const command = this.options.command ?? 'grok';
        const env = grokChildEnv(this.options.env ?? process.env);
        if (!await grokBinaryMatchesVerifiedVersion(command, env)) {
          throw new Error('Grok binary changed from the exact native-contract-measured version before child start.');
        }
        const abort = new AbortController();
        this.startupAbort = abort;
        const args = [
          '--permission-mode', this.desiredMode,
          'agent', '--no-leader',
          ...(this.desiredModel ? ['--model', this.desiredModel] : []),
          ...(this.desiredEffort ? ['--reasoning-effort', this.desiredEffort] : []),
          'stdio',
        ];
        const client = await AcpClient.connect({
          command,
          args,
          cwd: this.session.cwd,
          env,
          requestTimeoutMs: this.options.requestTimeoutMs,
          signal: abort.signal,
          hooks: {
            onSessionUpdate: (params) => {
              const commands = params.update && updateCommands(params.update);
              if (commands) this.commands = commands;
              if (this.prompting || commands) this.hooks.onUpdate('session/update', params);
            },
            onPermissionRequest: (params) => this.hooks.onPermissionRequest(params),
            extensions: {
              xai: (event) => {
                if (event.kind === 'notification'
                  && (event.method === '_x.ai/session/update' || event.method === 'x.ai/session/update')
                  && isRecord(event.params)) {
                  this.hooks.onUpdate(event.method, event.params as AcpSessionUpdateParams);
                  return null;
                }
                return undefined;
              },
            },
          },
        });
        this.startupAbort = undefined;
        this.startupClient = client;
        if (this.closed || generation !== this.generation) {
          await client.close({ force: true });
          throw new Error('Grok ACP transport changed during startup.');
        }
        const initializeMeta = client.initializeResult?._meta;
        if (isRecord(initializeMeta)) {
          this.models = parseGrokModelCatalog(initializeMeta.modelState);
          this.commands = commandCatalog(initializeMeta.availableCommands);
        }
        await authenticateGrokClient(client, this.options.authMethodId);
        void client.exited?.then((exit) => {
          if (!this.closed && generation === this.generation && this.client === client) this.hooks.onExit(exit);
        });
        try {
          const loaded = await client.sessionLoad({ sessionId: this.session.id, cwd: this.session.cwd, mcpServers: [] });
          const loadedModels = parseGrokModelCatalog(loaded.models);
          if (loadedModels.length > 0) this.models = loadedModels;
          await this.verifyLoadedConfiguration(loaded);
          if (this.closed || generation !== this.generation) throw new Error('Grok ACP transport changed during session/load.');
          this.client = client;
          this.startupClient = undefined;
          return client;
        } catch (error) {
          await client.close({ force: true });
          if (this.startupClient === client) this.startupClient = undefined;
          throw error;
        }
      })();
      this.starting.catch(() => undefined).finally(() => {
        if (!this.client) this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async verifyLoadedConfiguration(loaded: Record<string, unknown>): Promise<void> {
    const loadedModels = isRecord(loaded.models) ? loaded.models : undefined;
    const loadedModes = isRecord(loaded.modes) ? loaded.modes : undefined;
    const effectiveModel = boundedSelection(loadedModels, ['currentModelId', 'currentModel']);
    const effectiveEffort = grokLoadedReasoningEffort(loadedModels);
    const effectiveMode = boundedSelection(loadedModes, ['currentModeId', 'currentMode']);
    if (effectiveModel !== undefined && this.desiredModel !== undefined && effectiveModel !== this.desiredModel) {
      throw new Error(`Grok session/load reported model ${effectiveModel}, not requested ${this.desiredModel}.`);
    }
    if (effectiveEffort !== undefined && this.desiredEffort !== undefined && effectiveEffort !== this.desiredEffort) {
      throw new Error(`Grok session/load reported reasoning effort ${effectiveEffort}, not requested ${this.desiredEffort}.`);
    }
    if (this.verifyRelaunchConfiguration
      && effectiveMode !== undefined
      && effectiveMode !== this.desiredMode) {
      throw new Error(`Grok session/load did not confirm requested permission mode ${this.desiredMode}.`);
    }
    if (this.verifyRelaunchConfiguration
      && effectiveMode === undefined
      && this.desiredMode !== 'default') {
      throw new Error(`Grok session/load omitted requested permission mode ${this.desiredMode}.`);
    }
    const durable = (await discoverGrokStore({ root: this.session.storeRoot }))
      .find((candidate) => candidate.id === this.session.id);
    if (!durable) throw new Error('Grok session/load did not preserve the durable session identity.');
    if (this.desiredModel !== undefined && durable.model !== this.desiredModel) {
      throw new Error(`Grok durable summary reports model ${String(durable.model)}, not requested ${this.desiredModel}.`);
    }
    const promptlessEffortLag = durable.messageCount === 0
      && effectiveEffort === this.desiredEffort;
    if (this.desiredEffort !== undefined
      && durable.currentModel?.reasoningEffort !== this.desiredEffort
      && !promptlessEffortLag) {
      throw new Error(`Grok durable summary reports reasoning effort ${String(durable.currentModel?.reasoningEffort)}, not requested ${this.desiredEffort}.`);
    }
    this.verifyRelaunchConfiguration = false;
  }
}

function boundedSelection(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  }
  return undefined;
}

/** The pinned binary reports the active effort either at the model-state root
 * or on the selected available-model row. Keep both measured encodings. */
export function grokLoadedReasoningEffort(models: Record<string, unknown> | undefined): string | undefined {
  const direct = boundedSelection(models, ['currentReasoningEffort', 'reasoningEffort']);
  if (direct) return direct;
  const currentModel = boundedSelection(models, ['currentModelId', 'currentModel']);
  const available = Array.isArray(models?.availableModels) && models.availableModels.length <= 256
    ? models.availableModels
    : [];
  for (const raw of available) {
    if (!isRecord(raw) || raw.modelId !== currentModel || !isRecord(raw._meta)) continue;
    return boundedSelection(raw._meta, ['reasoningEffort', 'currentReasoningEffort']);
  }
  return undefined;
}

function optionId(option: AcpPermissionOption): string | undefined {
  return typeof option.optionId === 'string' ? option.optionId
    : typeof option.id === 'string' ? option.id
      : undefined;
}

function permissionDecisionMap(options: readonly AcpPermissionOption[]): Map<PermissionDecision, string> | undefined {
  if (options.length === 0 || options.length > MAX_NATIVE_PERMISSION_OPTIONS) return undefined;
  const decisions = new Map<PermissionDecision, string>();
  const ids = new Set<string>();
  for (const option of options) {
    const id = optionId(option);
    if (!id || id.length > MAX_PERMISSION_FIELD_CHARS || ids.has(id)) return undefined;
    ids.add(id);
    const decision: PermissionDecision | undefined = option.kind === 'allow_once' ? 'approve'
      : option.kind === 'reject_once' ? 'reject'
        : undefined;
    // Grok's documented always-approve switch is global. Until a native capture
    // proves a narrower remembered-rule option, never surface allow_always as
    // canonical approve-rule.
    if (!decision) continue;
    if (decisions.has(decision)) return undefined;
    decisions.set(decision, id);
  }
  return decisions.size > 0 ? decisions : undefined;
}

function boundedDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value).slice(0, 4_000); } catch { return '[unserializable Grok tool input]'; }
}

function updateOf(record: GrokUpdateRecord): Record<string, unknown> | undefined {
  if (!isRecord(record.params) || !isRecord(record.params.update)) return undefined;
  return record.params.update;
}

function userText(record: GrokUpdateRecord): string | undefined {
  if (!isGrokSessionUpdateMethod(record.method)) return undefined;
  const update = updateOf(record);
  if (update?.sessionUpdate !== 'user_message_chunk') return undefined;
  if (typeof update.content === 'string') return update.content;
  return isRecord(update.content) && typeof update.content.text === 'string' ? update.content.text : undefined;
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

export class GrokDriveConnection extends GrokObserveConnection {
  readonly identity = randomUUID();
  private readonly transport: GrokAcpTransport;
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly liveHandlers = new Set<(message: AgentMessage) => void>();
  /**
   * One row's reconciliation state, per `type:key`.
   *
   * `live` is what ACP has delivered, `durable` what the tail read has, and
   * `published` what this connection has actually put in front of the reader.
   * The third is the one that matters: the two sources arrive in either order
   * and at either speed, and every publish has to be judged against what the
   * reader ALREADY HAS, not against the other source. Tracking only the two
   * inputs is what let a durable read that ran ahead be rendered, and then the
   * live delta covering the same text be appended on top of it.
   */
  private readonly liveStreams = new Map<string, { live: string; durable: string; published: string }>();
  private transportClosing?: Promise<void>;
  private readonly claimedEvents: GrokReplayCorrelations;
  private readonly durablePromptClaims = new Set<string>();
  private readonly onDemoteHook?: (connection: GrokDriveConnection) => void;
  private readonly onCloseHook?: (connection: GrokDriveConnection) => void;
  private readonly onConfigurationHook?: GrokDriveOpenOptions['onConfiguration'];
  private readonly onHistoryBoundaryHook?: GrokDriveOpenOptions['onHistoryBoundary'];
  private readonly expectedHistoryBoundary?: HistorySourceIdentity;
  private turnChain: Promise<void> = Promise.resolve();
  private ownershipFence = 0;
  private ownershipPrimed = false;
  private sequence = 0;
  private liveLine = 1_000_000;
  private liveTurnUserKey: string | undefined;
  private readonly livePromptUserKeys = new Map<string, string>();
  private promptAdmissions = 0;
  private activeTurns = 0;
  private ownedTurn: OwnedLiveTurn | undefined;
  /** Run-summary keys already published live, so none is ever reopened by a later `running`. */
  private readonly publishedRunKeys = new Set<string>();
  private cancelGeneration = 0;
  private closedDrive = false;
  private demoted = false;
  private correlationInvalidated = false;
  private commands: SlashCommand[] = [];

  protected constructor(
    session: GrokStoredSession,
    info: SessionInfo,
    transport: GrokAcpTransport,
    options: GrokDriveOpenOptions,
  ) {
    super({
      session,
      info,
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.replayCorrelations ? { replayCorrelations: options.replayCorrelations } : {}),
      ...(options.terminalSummaries ? { terminalSummaries: options.terminalSummaries } : {}),
      ...(options.terminalSummaryRegistry
        ? { terminalSummaryRegistry: options.terminalSummaryRegistry }
        : {}),
      ...(options.expectedTerminalSummaryBoundary
        ? { expectedTerminalSummaryBoundary: options.expectedTerminalSummaryBoundary }
        : {}),
      ...(options.onTerminalSummaryBoundaryInvalid
        ? { onTerminalSummaryBoundaryInvalid: options.onTerminalSummaryBoundaryInvalid }
        : {}),
      notifyTerminalSummaryChanges: options.notifyTerminalSummaryChanges ?? false,
    });
    this.transport = transport;
    this.claimedEvents = options.replayCorrelations ?? new Map();
    if (options.onDemote) this.onDemoteHook = options.onDemote;
    if (options.onClose) this.onCloseHook = options.onClose;
    if (options.onConfiguration) this.onConfigurationHook = options.onConfiguration;
    if (options.onHistoryBoundary) this.onHistoryBoundaryHook = options.onHistoryBoundary;
    if (options.expectedHistoryBoundary) this.expectedHistoryBoundary = options.expectedHistoryBoundary;
  }

  static async open(
    session: GrokStoredSession,
    info: SessionInfo,
    options: GrokDriveOpenOptions = {},
  ): Promise<GrokDriveConnection> {
    let connection: GrokDriveConnection | undefined;
    const transport = new LazyGrokAcpTransport(session, options, {
      onUpdate: (method, params) => connection?.acceptUpdate(method, params),
      onPermissionRequest: (params) => connection?.requestPermission(params)
        ?? { outcome: { outcome: 'cancelled' } },
      onExit: (exit) => connection?.demote(`Grok ACP child exited (code ${String(exit.code)}, signal ${String(exit.signal)}).`),
    });
    connection = new GrokDriveConnection(session, info, transport, options);
    try {
      await connection.primeOwnership();
      return connection;
    } catch (error) {
      await transport.close(true).catch(() => undefined);
      throw error;
    }
  }

  static async fromTransport(
    session: GrokStoredSession,
    info: SessionInfo,
    transport: GrokAcpTransport,
    options: GrokDriveOpenOptions = {},
  ): Promise<GrokDriveConnection> {
    const connection = new GrokDriveConnection(session, info, transport, options);
    try {
      await connection.primeOwnership();
      return connection;
    } catch (error) {
      await transport.close(true).catch(() => undefined);
      throw error;
    }
  }

  override subscribe(handler: (message: AgentMessage) => void) {
    const stopObserve = super.subscribe(handler);
    this.liveHandlers.add(handler);
    return () => {
      stopObserve();
      this.liveHandlers.delete(handler);
    };
  }

  override async getHistory(query?: HistoryQuery): Promise<AgentMessage[]> {
    const history = await super.getHistory(query);
    return [...history, ...this.pendingPrompts.map((entry) => entry.row)];
  }

  getPending(): AgentMessage[] {
    return [
      ...this.pendingPrompts.map((entry) => entry.row),
      ...[...this.pendingPermissions.values()].map((entry) => entry.message),
    ];
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      return await this.transport.listModels?.() ?? [];
    } catch (error) {
      this.demote(`Grok ACP model discovery failed: ${error instanceof Error ? error.message : String(error)}.`);
      throw error;
    }
  }

  async listModes(): Promise<ModeOption[]> {
    return GROK_PERMISSION_MODES.map((mode) => ({ ...mode }));
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      const commands = await this.transport.listCommands?.() ?? [];
      if (commands.length > 0) this.commands = commands;
      return this.commands.map((command) => ({ ...command }));
    } catch (error) {
      this.demote(`Grok ACP command discovery failed: ${error instanceof Error ? error.message : String(error)}.`);
      throw error;
    }
  }

  async runCommand(name: string, args?: string, input: CommandInput = {}): Promise<CommandResult | void> {
    const command = this.commands.find((entry) => entry.name === name);
    if (!command) throw new Error(`Grok command /${name} is not in the current ACP command catalog.`);
    const suffix = args?.trim();
    await this.sendPrompt({ text: `/${command.name}${suffix ? ` ${suffix}` : ''}`, ...input });
  }

  override async sendPrompt(input: PromptInput): Promise<void> {
    this.assertWritable('prompt');
    if (input.images?.length || input.files?.length) {
      throw new Error('Grok native file input is disabled until an ACP/store echo capture proves it.');
    }
    if (this.pendingPrompts.length >= MAX_PENDING_PROMPTS) {
      throw new Error(`Grok Drive has ${MAX_PENDING_PROMPTS} pending prompts; refusing another.`);
    }
    if (this.promptAdmissions >= MAX_PROMPT_ADMISSIONS) {
      throw new Error(`Grok Drive reached its ${MAX_PROMPT_ADMISSIONS}-prompt connection limit; reconnect before writing again.`);
    }
    const key = `queued:grok:${this.identity}.${++this.sequence}`;
    this.promptAdmissions += 1;
    const row: PendingPrompt['row'] = {
      type: 'user-message',
      text: input.text,
      key,
      queued: true,
      ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}),
    };
    const pending: PendingPrompt = {
      key,
      text: input.text,
      byteFence: this.ownershipFence,
      row,
      terminal: false,
      ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}),
    };
    this.pendingPrompts.push(pending);
    this.emitLive(row);
    const admissionCancelGeneration = this.cancelGeneration;
    const run = async () => {
      let nativeStarted = false;
      let ownedTurn: OwnedLiveTurn | undefined;
      try {
        if (admissionCancelGeneration !== this.cancelGeneration) throw new GrokPromptCancelledBeforeDelivery();
        this.assertWritable('queued prompt delivery');
        const beforeConfigure = await this.inspectCleanHistoryForDrive();
        if (admissionCancelGeneration !== this.cancelGeneration) throw new GrokPromptCancelledBeforeDelivery();
        this.assertWritable('pre-configuration ownership check');
        pending.byteFence = beforeConfigure.byteLength;
        this.ownershipFence = Math.max(this.ownershipFence, beforeConfigure.byteLength);
        await this.transport.configure?.(input.model, input.permissionMode);
        if (admissionCancelGeneration !== this.cancelGeneration) throw new GrokPromptCancelledBeforeDelivery();
        this.assertWritable('configured prompt delivery');
        const before = await this.inspectCleanHistoryForDrive();
        if (admissionCancelGeneration !== this.cancelGeneration) throw new GrokPromptCancelledBeforeDelivery();
        this.assertWritable('prompt admission');
        pending.byteFence = before.byteLength;
        this.ownershipFence = Math.max(this.ownershipFence, before.byteLength);
        if (input.model) {
          const advertised = await this.transport.listModels?.() ?? [];
          const option = advertised.find((candidate) =>
            candidate.providerID === input.model?.providerID
            && candidate.modelID === input.model?.modelID
            && candidate.variant === input.model?.variant);
          this.info.currentModel = {
            ...input.model,
            ...(option?.label ? { label: option.label } : {}),
          };
          this.info.model = modelToken(input.model);
          this.emitLive({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel: this.info.currentModel, model: this.info.model } });
        }
        if (input.permissionMode) {
          this.info.currentMode = input.permissionMode;
          this.emitLive({ type: 'metadata-update', key: 'sessionInfo', value: { currentMode: input.permissionMode } });
        }
        if (input.model || input.permissionMode) {
          this.onConfigurationHook?.({
            ...(this.info.currentModel ? { currentModel: { ...this.info.currentModel } } : {}),
            ...(this.info.currentMode ? { currentMode: this.info.currentMode } : {}),
            ...(this.info.model ? { model: this.info.model } : {}),
          });
        }
        this.activeTurns += 1;
        nativeStarted = true;
        ownedTurn = { pendingKey: key, held: [] };
        this.ownedTurn = ownedTurn;
        this.emitLive({ type: 'status', status: 'running' });
        const result = await this.transport.sessionPrompt({
          sessionId: this.session.id,
          prompt: [{ type: 'text', text: input.text }],
        });
        // `rate_limit` belongs here with the other terminal reasons. Grok emits it
        // when the account's quota runs out mid-turn -- the installed v79 transcript
        // has `retry_state` exhausted on a 429 and then `stop_reason: "rate_limit"`.
        // Treating a routine quota event as a protocol violation threw, demoted the
        // connection, and left the session read-only until reattach, so the Stop that
        // followed was never even acknowledged.
        if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'rate_limit'].includes(result.stopReason ?? '')) {
          throw new Error(`Grok returned unsupported ACP stopReason ${JSON.stringify(result.stopReason)}.`);
        }
        pending.terminal = true;
        const { read: after, terminalSummary } = await this.settleTerminalPrompt(
          pending,
          result.stopReason,
        );
        this.publishHistoryBoundary(after, terminalSummary);
        this.republishOwnedPromptTurn(after, pending);
        this.publishOwnedTurnTerminal(ownedTurn, terminalSummary);
        if (result.stopReason === 'refusal') this.emitLive({ type: 'error', message: 'Grok refused the turn.' });
        if (result.stopReason === 'max_tokens') this.emitLive({ type: 'notice', message: 'Grok reached the turn token limit.' });
        if (!this.demoted) this.emitLive({ type: 'status', status: 'idle' });
      } catch (error) {
        if (error instanceof GrokPromptCancelledBeforeDelivery && !this.demoted && !this.closedDrive) {
          const index = this.pendingPrompts.findIndex((entry) => entry.key === key);
          if (index >= 0) this.pendingPrompts.splice(index, 1);
          this.emitHistoryReset();
          return;
        }
        if (!nativeStarted) {
          const index = this.pendingPrompts.findIndex((entry) => entry.key === key);
          if (index >= 0) this.pendingPrompts.splice(index, 1);
          this.emitHistoryReset();
        }
        if (nativeStarted
          && error instanceof AcpRpcError
          && this.transport.alive
          && !this.demoted
          && !this.closedDrive) {
          try {
            const after = await this.settleRejectedPromptOwnership(pending);
            pending.terminal = true;
            const rejectedSummary = this.nativeTerminalSummary(after, pending);
            this.publishHistoryBoundary(after, rejectedSummary);
            this.republishOwnedPromptTurn(after, pending);
            this.publishOwnedTurnTerminal(ownedTurn, rejectedSummary);
          } catch (reconcileError) {
            this.demote(`Grok ACP turn failed and durable ownership could not be re-established: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}.`);
          }
          if (!this.demoted) {
            this.emitLive({ type: 'status', status: 'idle' });
            throw error;
          }
        }
        this.demote(`Grok ACP turn failed: ${error instanceof Error ? error.message : String(error)}.`);
        throw error;
      } finally {
        if (nativeStarted) this.activeTurns = Math.max(0, this.activeTurns - 1);
        if (ownedTurn) this.releaseOwnedTurn(ownedTurn);
      }
    };
    const turn = this.turnChain.then(run);
    this.turnChain = turn.catch(() => undefined);
    await turn;
  }

  override async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertWritable('permission response');
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Grok permission ${requestId} is not pending.`);
    const selected = pending.optionIds.get(decision);
    if (!selected) throw new Error(`Grok permission decision ${decision} was not advertised for ${requestId}.`);
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: selected } });
    this.emitLive({ type: 'permission-resolved', requestId, decision });
  }

  cancel(): void {
    this.cancelGeneration += 1;
    try { if (this.transport.alive) this.transport.sessionCancel(this.session.id); } catch { /* resolver cleanup below */ }
    this.settlePermissions('external');
  }

  demote(reason = 'Grok updates log received a detectable foreign user write.'): void {
    if (this.demoted) return;
    this.demoted = true;
    this.cancelGeneration += 1;
    try { this.onDemoteHook?.(this); } catch { /* native shutdown remains authoritative */ }
    try { if (this.transport.alive) this.transport.sessionCancel(this.session.id); } catch { /* force-close below */ }
    this.settlePermissions('external');
    // Retained rather than fired and forgotten: `close()` below reports a
    // teardown, and it must be able to join the one already in flight instead
    // of returning while the force-kill is still outstanding.
    this.transportClosing = this.transport.close(true).catch(() => undefined);
    this.emitLive({ type: 'status', status: 'idle' });
    this.emitLive({ type: 'notice', message: `${reason} This connection is now read-only.` });
    this.emitLive({ type: 'metadata-update', key: 'sessionInfo', value: {
      control: {
        drive: { state: 'observing', supported: false },
        terminalSync: { supported: false, syncAvailable: false, active: false },
      },
    } });
  }

  override async close(): Promise<void> {
    if (this.closedDrive) return;
    this.closedDrive = true;
    this.cancelGeneration += 1;
    this.settlePermissions('external');
    try {
      await super.close();
    } finally {
      try {
        await this.transport.close();
        await this.transportClosing;
      } finally {
        this.liveStreams.clear();
        this.liveHandlers.clear();
        this.onCloseHook?.(this);
      }
    }
  }

  get driving(): boolean {
    return !this.closedDrive && !this.demoted && this.transport.alive;
  }

  protected override ownsLiveWriter(): boolean { return this.activeTurns > 0; }

  protected override onTailEntry(
    entry: GrokUpdateEntry,
    messages: readonly AgentMessage[],
  ): readonly AgentMessage[] {
    if (this.correlationInvalidated) return messages;
    this.reconcileDurableUser(entry, messages, this.ownershipPrimed && entry.offset >= this.ownershipFence);
    return this.settleLiveEchoes(messages);
  }

  protected override publishTailMessage(message: AgentMessage): void {
    if (this.holdOwnedTerminal(message, false)) return;
    this.notePublishedRun(message);
    super.publishTailMessage(message);
  }

  protected override onHistorySnapshot(
    entries: readonly GrokUpdateEntry[],
    messages: readonly AgentMessage[],
    byteLength: number,
  ): void {
    if (this.correlationInvalidated) return;
    const usersByNativeKey = new Map(
      messages
        .filter((message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message')
        .flatMap((message) => message.key ? [[message.key, message] as const] : []),
    );
    for (const entry of entries) {
      const wasDemoted = this.demoted;
      const nativeKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
      const message = usersByNativeKey.get(nativeKey);
      this.reconcileDurableUser(
        entry,
        message ? [message] : [],
        this.ownershipPrimed && entry.offset >= this.ownershipFence,
      );
      if (!wasDemoted && this.demoted) return;
    }
    if (this.pendingPrompts.length === 0) this.ownershipFence = Math.max(this.ownershipFence, byteLength);
  }

  protected override onHistoryRewrite(): void {
    // Held frames describe the history that was just replaced; the reader reloads without them.
    this.ownedTurn?.held.splice(0);
    this.claimedEvents.clear();
    this.durablePromptClaims.clear();
    this.correlationInvalidated = true;
    this.demote('Grok transcript history was rewritten outside this connection.');
  }

  protected override onHistoryIntegrity(failure: GrokHistoryIntegrityFailure | undefined): void {
    if (!failure || this.demoted) return;
    if (this.activeTurns > 0 && failure.incompleteTail && failure.issues.length === 0) {
      this.trace?.({ op: 'observe', detail: 'deferred Grok unterminated-tail integrity decision while the owned ACP turn is active' });
      return;
    }
    const detail = [
      ...failure.issues,
      ...(failure.incompleteTail ? ['unterminated tail record'] : []),
    ].join('; ');
    this.demote(`Grok updates log failed the Drive integrity check: ${detail}.`);
  }

  private async primeOwnership(): Promise<void> {
    const read = await this.inspectCleanHistoryForDrive();
    if (this.expectedHistoryBoundary
      && !sameHistoryBoundary(this.expectedHistoryBoundary, read.identity)) {
      throw new Error('Grok transcript changed after durable restart ownership was checked.');
    }
    this.ownershipFence = read.byteLength;
    this.ownershipPrimed = true;
    this.publishHistoryBoundary(read);
  }

  private publishHistoryBoundary(
    read: GrokUpdatesRead,
    terminalSummary?: GrokTerminalSummary,
  ): void {
    if (read.identity) {
      if (terminalSummary) this.rememberTerminalSummary(terminalSummary, read.identity);
      else this.rememberTerminalSummaryBoundary(read.identity);
    }
    if (!this.onHistoryBoundaryHook || this.demoted || this.closedDrive || !read.identity) return;
    this.onHistoryBoundaryHook(read.identity, terminalSummary);
  }

  /** Publish the owned prompt row again under the turn id its own turn ended up
   *  with. A `user_message_chunk` names no prompt, so the tail drain that first
   *  emitted this row could only give it `turn-line:N` -- the id it carried
   *  before its turn had one. Replay resolves the same row to `turn:<uuid>` by
   *  walking forward, so without this the prompt sits alone in a phantom turn
   *  while its answer and summary sit in the real one, and a reattaching reader
   *  disagrees with the connection that ran the turn. Same key, same text, same
   *  sentAt: this updates a row, it does not add one. */
  private republishOwnedPromptTurn(read: GrokUpdatesRead, pending: PendingPrompt): void {
    if (this.demoted || this.closedDrive) return;
    const resolvedPromptIds = turnPromptIds(read.entries);
    for (const entry of read.entries) {
      if (userText(entry.record) === undefined) continue;
      const nativeKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
      const correlation = this.claimedEvents.get(nativeKey);
      if (correlation?.key !== pending.key) continue;
      const turnPromptId = resolvedPromptIds.get(entry.lineIndex);
      // Nothing to correct when the row named its own prompt, and nothing that
      // CAN be corrected when the turn never named one.
      if (turnPromptId === undefined || grokPromptId(entry.record) !== undefined) return;
      const messages = mapGrokUpdate(entry.record, {
        sessionId: this.session.id,
        lineIndex: entry.lineIndex,
        trace: this.trace,
        turnPromptId,
      });
      this.applyCorrelation(messages, correlation);
      for (const message of messages) {
        if (message.type === 'user-message') this.emitLive(message);
      }
      return;
    }
  }

  private fallbackTerminalSummary(
    read: GrokUpdatesRead,
    pending: PendingPrompt,
    stopReason: AcpSessionPromptResult['stopReason'],
  ): GrokTerminalSummary | undefined {
    // Resolve the owned turn's id exactly the way replay does. A
    // `user_message_chunk` carries no prompt id, so reading it alone lands the
    // turn on `turn-line:N` while its own `turn_completed` lands on
    // `turn:<uuid>`; the two never compared equal, so the native summary below
    // was never recognised as this turn's and a token-less ACP fallback was
    // published in its place.
    const resolvedPromptIds = turnPromptIds(read.entries);
    let inOwnedTurn = false;
    let turnId: string | undefined;
    let nativeUserKey: string | undefined;
    const priorFallbackKeys = new Set(
      (read.identity ? this.terminalSummaryRegistry.read(read.identity, true).rows : [])
        .map((summary) => summary.key)
        .filter((key) => key.endsWith(':acp-terminal')),
    );
    for (const entry of read.entries) {
      const text = userText(entry.record);
      if (text !== undefined) {
        if (inOwnedTurn) break;
        const nativeKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
        if (this.claimedEvents.get(nativeKey)?.key !== pending.key) continue;
        inOwnedTurn = true;
        nativeUserKey = nativeKey;
        turnId = grokTurnId(
          this.session.id,
          entry.record,
          entry.lineIndex,
          resolvedPromptIds.get(entry.lineIndex),
        );
      }
      if (!inOwnedTurn) continue;
      const nativeSummaries = mapGrokUpdate(entry.record, {
        sessionId: this.session.id,
        lineIndex: entry.lineIndex,
        trace: this.trace,
        // Name the key the prompt was EMITTED under. `applyCorrelation` rewrites
        // a claimed row's key to the queued one before it goes out, so a summary
        // naming the native key references a row no reader ever saw.
        turnUserMessageKey: pending.key,
      }).filter((message) => message.type === 'run-summary');
      if (nativeSummaries.length === 0) continue;
      if (grokPromptId(entry.record) !== undefined) {
        // Publish Grok's own summary rather than dropping it. It is the sole
        // carrier of the turn's token usage, and the drive's settle read moves
        // the tail cursor past this line, so nothing else would ever emit it.
        const own = nativeSummaries.find((message) => message.turnId === turnId);
        if (own) return own.status === 'running' ? undefined : { ...own, status: own.status };
        continue;
      }
      // An id-less terminal row can close the sole outstanding fallback. Once
      // another prior fallback exists, attributing it to the newest user would
      // be unsafe; preserve this turn's authoritative ACP fallback instead.
      if (![...priorFallbackKeys].some((key) => key !== `${nativeUserKey}:acp-terminal`)) {
        return undefined;
      }
    }
    if (!turnId || !nativeUserKey) {
      throw new GrokDurablePromptNotSettled();
    }
    return {
      type: 'run-summary',
      // The summary's own identity stays native so the fallback registry can
      // still recognise and dedupe it; only what it POINTS AT has to be the key
      // a reader actually holds.
      key: `${nativeUserKey}:acp-terminal`,
      turnId,
      userMessageKey: pending.key,
      status: stopReason === 'cancelled' ? 'cancelled'
        : stopReason === 'refusal' || stopReason === 'rate_limit' ? 'error'
          : 'done',
      source: 'grok',
    };
  }

  /** Grok's own terminal row for the owned turn, if the durable log already
   *  carries one. Never synthesizes: a turn the ACP layer REJECTED has no stop
   *  reason this connection could honestly invent, and the wrong one renders a
   *  turn that produced nothing as one that finished. Measured on the installed
   *  v80 run: a 429 rejects `session/prompt`, so the drive published a notice
   *  and `status: idle` and no terminal row at all, while the durable log had
   *  `turn_completed` with `stop_reason: "rate_limit"` sitting in it. The turn
   *  had no terminal state live and one on reattach. */
  private nativeTerminalSummary(
    read: GrokUpdatesRead,
    pending: PendingPrompt,
  ): GrokTerminalSummary | undefined {
    const resolvedPromptIds = turnPromptIds(read.entries);
    let turnId: string | undefined;
    for (const entry of read.entries) {
      if (userText(entry.record) !== undefined) {
        if (turnId) break;
        const nativeKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
        if (this.claimedEvents.get(nativeKey)?.key !== pending.key) continue;
        turnId = grokTurnId(
          this.session.id,
          entry.record,
          entry.lineIndex,
          resolvedPromptIds.get(entry.lineIndex),
        );
        continue;
      }
      if (turnId === undefined || grokPromptId(entry.record) === undefined) continue;
      const own = mapGrokUpdate(entry.record, {
        sessionId: this.session.id,
        lineIndex: entry.lineIndex,
        trace: this.trace,
        turnUserMessageKey: pending.key,
      }).find((message) => message.type === 'run-summary' && message.turnId === turnId);
      if (own?.type === 'run-summary' && own.status !== 'running') {
        return { ...own, status: own.status };
      }
    }
    return undefined;
  }

  private async settleTerminalPrompt(
    pending: PendingPrompt,
    stopReason: AcpSessionPromptResult['stopReason'],
  ): Promise<{ read: GrokUpdatesRead; terminalSummary?: GrokTerminalSummary }> {
    for (let attempt = 0; attempt < ACTIVE_TAIL_SETTLE_ATTEMPTS; attempt += 1) {
      const read = await this.inspectHistoryForDrive();
      if (read.issues.length > 0) {
        throw new Error(`Grok Drive requires a clean supported updates log: ${read.issues.join('; ')}`);
      }
      if (read.durablePrefixBytes.length === read.byteLength) {
        try {
          return { read, terminalSummary: this.fallbackTerminalSummary(read, pending, stopReason) };
        } catch (error) {
          if (!(error instanceof GrokDurablePromptNotSettled)) throw error;
        }
      }
      if (attempt + 1 < ACTIVE_TAIL_SETTLE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, ACTIVE_TAIL_SETTLE_MS));
      }
    }
    throw new GrokDurablePromptNotSettled();
  }

  private async inspectCleanHistoryForDrive(settleActiveTail = false): Promise<GrokUpdatesRead> {
    const attempts = settleActiveTail ? ACTIVE_TAIL_SETTLE_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const read = await this.inspectHistoryForDrive();
      if (read.issues.length > 0) {
        throw new Error(`Grok Drive requires a clean supported updates log: ${read.issues.join('; ')}`);
      }
      if (read.durablePrefixBytes.length === read.byteLength) return read;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, ACTIVE_TAIL_SETTLE_MS));
    }
    throw new Error('Grok Drive refuses an updates log with an unterminated tail record.');
  }

  private async settleRejectedPromptOwnership(pending: PendingPrompt): Promise<GrokUpdatesRead> {
    for (let attempt = 0; attempt < ACTIVE_TAIL_SETTLE_ATTEMPTS; attempt += 1) {
      const read = await this.inspectHistoryForDrive();
      if (this.demoted || this.closedDrive) {
        throw new Error('Grok Drive ownership changed while reconciling the rejected prompt.');
      }
      if (read.issues.length > 0) {
        throw new Error(`Grok Drive requires a clean supported updates log: ${read.issues.join('; ')}`);
      }
      if (read.durablePrefixBytes.length === read.byteLength
        && this.durablePromptClaims.has(pending.key)) return read;
      if (attempt + 1 < ACTIVE_TAIL_SETTLE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, ACTIVE_TAIL_SETTLE_MS));
      }
    }
    throw new Error('Grok rejected the ACP turn before its exact durable user echo could be proved.');
  }

  private reconcileDurableUser(
    entry: GrokUpdateEntry,
    messages: readonly AgentMessage[],
    foreignIfUnclaimed: boolean,
  ): void {
    const text = userText(entry.record);
    if (text === undefined) return;
    const nativeKey = grokMessageKey(this.session.id, entry.record, entry.lineIndex);
    const correlation = this.claimedEvents.get(nativeKey);
    if (correlation) {
      if (correlation.text !== text) {
        this.demote('Grok reused a claimed event id for different user content.');
        return;
      }
      this.applyCorrelation(messages, correlation);
      this.durablePromptClaims.add(correlation.key);
      return;
    }
    const pendingIndex = this.pendingPrompts.findIndex((pending) =>
      pending.text === text && entry.offset >= pending.byteFence);
    const matchingPending = pendingIndex < 0 ? undefined : this.pendingPrompts[pendingIndex];
    if (matchingPending) {
      this.pendingPrompts.splice(pendingIndex, 1);
      const claimed: GrokReplayCorrelation = {
        key: matchingPending.key,
        text,
        ...(matchingPending.clientKey ? { clientKey: matchingPending.clientKey } : {}),
      };
      this.setClaimedEvent(nativeKey, claimed);
      this.applyCorrelation(messages, claimed);
      this.durablePromptClaims.add(claimed.key);
      return;
    }
    if (foreignIfUnclaimed) this.demote();
  }

  private acceptUpdate(method: string, params: AcpSessionUpdateParams): void {
    if (this.closedDrive || this.demoted || params.sessionId !== this.session.id || !params.update) return;
    const commands = updateCommands(params.update);
    if (commands) {
      this.commands = commands;
      return;
    }
    const record: GrokUpdateRecord = { method, params };
    // A physical JSONL line gives the fallback key its stable index. A live
    // frame does not, so mapping an id-less frame here would create a different
    // key from its later durable copy and could falsely classify our own echo
    // as a foreign write. Let the store tail admit it once its durable identity
    // exists. This protects Drive without claiming that eventId is mandatory
    // for every future native Grok frame.
    if (grokEventId(record) === undefined) {
      this.trace?.({ op: 'mapping-error', detail: 'withheld live Grok update without a stable eventId until durable replay' });
      return;
    }
    const lineIndex = this.liveLine++;
    // Remember the row that opens a turn so the `turn_completed` arriving later in that SAME turn
    // can name it -- Grok's summary names no message otherwise, and an unbindable summary is
    // dropped by the client along with the turn's only token usage. Bind through the prompt id,
    // never through "most recent user row": a delayed id-less terminal carries no prompt id and
    // must not be allowed to claim a newer turn's prompt.
    if (userText(record) !== undefined) {
      this.liveTurnUserKey = grokMessageKey(this.session.id, record, lineIndex);
    }
    const livePromptId = grokPromptId(record);
    if (livePromptId !== undefined && this.liveTurnUserKey !== undefined
      && !this.livePromptUserKeys.has(livePromptId)) {
      // Bind the summary to the key the user row was EMITTED under, not the
      // native one. `applyCorrelation` rewrites a claimed row's `key` to the
      // queued key before it goes out, so a summary pointing at the native key
      // references something no reader ever saw -- and G1 means the turnId
      // cannot bind either, because a `user_message_chunk` carries no prompt id
      // and its turn lands on `turn-line:N` while the summary lands on
      // `turn:<uuid>`. With both bindings missing, nothing attaches the turn's
      // usage to its prompt: measured on grok, `livePromptTurnId` undefined,
      // zero run-summary anchors, and `usagePublished`, `telemetryReDerived`,
      // `lateReaderTurnIdStable` and `lateReaderTurnAnchorStable` all failing
      // together off that one gap. The replay path binds correctly, which is
      // what proves the data is there.
      //
      // Resolved HERE rather than at capture time, and that ordering is the
      // whole reason this is safe: the claim for a user row is established
      // before the later record carrying its prompt id arrives, so by now it
      // exists. Nothing already emitted is rewritten -- only which key a FUTURE
      // summary points at changes.
      const claimedUserKey = this.claimedEvents.get(this.liveTurnUserKey)?.key;
      this.livePromptUserKeys.set(livePromptId, claimedUserKey ?? this.liveTurnUserKey);
      while (this.livePromptUserKeys.size > 64) {
        const oldest = this.livePromptUserKeys.keys().next().value;
        if (oldest === undefined) break;
        this.livePromptUserKeys.delete(oldest);
      }
    }
    const boundUserKey = livePromptId === undefined
      ? undefined
      : this.livePromptUserKeys.get(livePromptId);
    const messages = mapGrokUpdate(record, {
      sessionId: this.session.id,
      lineIndex,
      trace: this.trace,
      ...(boundUserKey === undefined ? {} : { turnUserMessageKey: boundUserKey }),
    });
    const text = userText(record);
    if (text !== undefined) {
      const nativeKey = grokMessageKey(this.session.id, record, lineIndex);
      const existing = this.claimedEvents.get(nativeKey);
      if (existing) {
        if (existing.text !== text) {
          this.demote('Grok reused a claimed event id for different user content.');
          return;
        }
        // A live ACP frame has no physical JSONL timestamp or line boundary.
        // Claim it for ownership, but let the durable tail publish the sole
        // authoritative user transition with replay-stable sentAt/turnId.
        for (const message of messages) {
          if (message.type !== 'user-message') this.emitLive(message);
        }
        return;
      }
      const pendingIndex = this.pendingPrompts.findIndex((entry) => entry.text === text);
      const pending = pendingIndex < 0 ? undefined : this.pendingPrompts[pendingIndex];
      if (!pending) {
        this.demote('Grok ACP child emitted an unsubmitted user update.');
        return;
      }
      const [claimed] = this.pendingPrompts.splice(pendingIndex, 1);
      if (claimed) {
        const correlation: GrokReplayCorrelation = {
          key: claimed.key,
          text,
          ...(claimed.clientKey ? { clientKey: claimed.clientKey } : {}),
        };
        this.setClaimedEvent(nativeKey, correlation);
      }
      for (const message of messages) {
        if (message.type !== 'user-message') this.emitLive(message);
      }
      return;
    }
    for (const message of messages) {
      if (!this.holdOwnedTerminal(message, true)) this.emitLive(message);
    }
  }

  private setClaimedEvent(nativeKey: string, correlation: GrokReplayCorrelation): void {
    if (!this.claimedEvents.has(nativeKey)
      && this.claimedEvents.size >= MAX_PROMPT_ADMISSIONS) {
      const oldest = this.claimedEvents.keys().next().value;
      if (oldest !== undefined) this.claimedEvents.delete(oldest);
    }
    this.claimedEvents.set(nativeKey, correlation);
  }

  private applyCorrelation(messages: readonly AgentMessage[], correlation: GrokReplayCorrelation): void {
    const user = messages.find((message) => message.type === 'user-message');
    if (user?.type !== 'user-message') return;
    user.key = correlation.key;
    user.queued = false;
    if (correlation.clientKey) user.clientKey = correlation.clientKey;
  }

  private requestPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    if (this.closedDrive || this.demoted || !this.transport.alive || params.sessionId !== this.session.id) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const rawId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined;
    const requestId = rawId && rawId.length <= MAX_PERMISSION_FIELD_CHARS
      ? rawId
      : `grok-permission:${++this.sequence}`;
    if (this.pendingPermissions.has(requestId) || this.pendingPermissions.size >= MAX_PENDING_PERMISSIONS) {
      this.trace?.({ op: 'observe', detail: `duplicate or over-limit Grok permission ${requestId} refused` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const optionIds = permissionDecisionMap(params.options ?? []);
    if (!optionIds) {
      this.trace?.({ op: 'observe', detail: `Grok permission ${requestId} has no supported native options` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const title = typeof params.toolCall?.title === 'string'
      ? params.toolCall.title.slice(0, MAX_PERMISSION_FIELD_CHARS)
      : 'Grok requests permission';
    const detail = boundedDetail(params.toolCall?.rawInput);
    return new Promise((resolve) => {
      const message: PendingPermission['message'] = {
        type: 'permission-request',
        requestId,
        title,
        toolName: title,
        ...(detail ? { detail } : {}),
        options: [...optionIds.keys()],
      };
      this.pendingPermissions.set(requestId, { message, optionIds, resolve });
      this.emitLive(message);
    });
  }

  private settlePermissions(decision: PermissionDecision | 'external'): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.emitLive({ type: 'permission-resolved', requestId, decision });
    }
    this.pendingPermissions.clear();
  }

  private assertWritable(action: string): void {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error(`Grok Drive is read-only; refusing ${action} before touching native state.`);
    }
  }

  /**
   * Publish a proved owned turn's terminal, preceded once by `running` under the same key.
   *
   * The broker notifies "turn finished" only when a live `running` and a later terminal share one
   * key. Neither Grok terminal key exists when the turn starts: the native `:summary` key is the
   * future `turn_completed` event id, and the `:acp-terminal` fallback is keyed by a user row the
   * tail has not claimed yet. So the pairing is emitted here, where the settle walk has proved the
   * turn this connection submitted, and not on the tail or ACP paths.
   *
   * Those paths can deliver the same terminal first: a drain racing the settle read, or ACP's own
   * `turn_completed`. They were held for this point, and `running` goes before the FIRST of them
   * that is the turn's: the key the walk proved, or a live frame ACP bound to this prompt, which
   * the walk misses when the durable line lands after the settle read. Every later terminal is
   * published unpaired, and a key already published live is never reopened.
   */
  private publishOwnedTurnTerminal(
    turn: OwnedLiveTurn | undefined,
    terminal: GrokTerminalSummary | undefined,
  ): void {
    const owned = turn !== undefined && this.ownedTurn === turn;
    const frames = owned ? this.takeHeldTerminals(turn) : [];
    if (terminal) frames.push({ message: terminal, live: false });
    const first = owned
      ? frames.find(({ message, live }) => message.key === terminal?.key
        || (live && message.userMessageKey === turn.pendingKey))
      : undefined;
    for (const frame of frames) {
      if (frame === first && !this.publishedRunKeys.has(frame.message.key)) {
        this.emitLive(runningSummaryFor(frame.message));
      }
      this.emitLive(frame.message);
    }
  }

  /** An owned turn that ended without a proved terminal publishes what it held, unpaired. */
  private releaseOwnedTurn(turn: OwnedLiveTurn): void {
    if (this.ownedTurn !== turn) return;
    for (const { message } of this.takeHeldTerminals(turn)) this.emitLive(message);
  }

  private takeHeldTerminals(turn: OwnedLiveTurn): OwnedLiveTurn['held'] {
    this.ownedTurn = undefined;
    return turn.held.splice(0);
  }

  /** Defer a terminal the tail or ACP delivers while an owned turn is still unsettled. */
  private holdOwnedTerminal(message: AgentMessage, live: boolean): boolean {
    const turn = this.ownedTurn;
    if (!turn || message.type !== 'run-summary' || message.status === 'running'
      || turn.held.length >= MAX_HELD_TERMINALS) return false;
    turn.held.push({ message, live });
    return true;
  }

  private notePublishedRun(message: AgentMessage): void {
    if (message.type !== 'run-summary') return;
    this.publishedRunKeys.delete(message.key);
    this.publishedRunKeys.add(message.key);
    while (this.publishedRunKeys.size > MAX_PUBLISHED_RUN_KEYS) {
      const oldest = this.publishedRunKeys.keys().next().value;
      if (oldest === undefined) break;
      this.publishedRunKeys.delete(oldest);
    }
  }

  private emitLive(message: AgentMessage): void {
    const publish = this.settleLiveDelta(message);
    if (publish === undefined) return;
    this.notePublishedRun(publish);
    for (const handler of this.liveHandlers) {
      try { handler(publish); } catch (error) {
        this.trace?.({ op: 'observe', detail: `live subscriber threw: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  /**
   * Reconcile one live frame against what this row has already published.
   *
   * Returns the frame to publish, or `undefined` when there is nothing left to
   * say. That second case is the one this exists for: the tail read can reach a
   * row before ACP delivers it, `settleLiveEchoes` publishes the durable text,
   * and the live delta covering that same text arrives afterwards. Forwarding
   * it appends what the reader can already see — the duplicate the settle was
   * written to remove, re-introduced from the other side one chunk later, and
   * self-sustaining once the two cursors part.
   */
  private settleLiveDelta(message: AgentMessage): AgentMessage | undefined {
    const streamed = streamedMessage(message);
    const slot = streamed && streamed.key !== undefined ? `${streamed.type}:${streamed.key}` : undefined;
    if (streamed === undefined || slot === undefined) return message;
    // A settled row ends the stream: nothing more arrives under this key, and
    // holding the strings for the life of the connection is what made a long
    // Drive session accumulate every answer it ever rendered.
    if (streamed.delta === undefined) {
      // Only `model-output` carries finality; a `thinking` row has no terminal
      // marker, so its slot is retired by the size bound and by `close()`.
      if (streamed.type === 'model-output' && streamed.final === true) this.liveStreams.delete(slot);
      return message;
    }
    const open = this.liveStreams.get(slot);
    if (open === undefined) {
      this.liveStreams.set(slot, { live: streamed.delta, durable: '', published: streamed.delta });
      this.trimLiveStreams();
      return message;
    }
    const previous = open.live;
    const live = previous + streamed.delta;
    open.live = live;
    // In lockstep with the reader: appending the delta is exactly right, and is
    // what every ordinary turn does.
    if (open.published === previous) {
      open.published = live;
      return message;
    }
    // The reader already has this text and possibly more of it.
    if (open.published.startsWith(live)) return undefined;
    // The reader is behind, or holds something unrelated. Either way publish a
    // REPLACE of the longer side rather than a delta: appending here would
    // append to text that already contains part of what is being appended, and
    // the row must never shrink.
    const settled = live.length >= open.published.length ? live : open.published;
    open.published = settled;
    const { delta: _delta, ...rest } = streamed;
    return { ...rest, text: settled };
  }

  private trimLiveStreams(): void {
    while (this.liveStreams.size > MAX_LIVE_STREAM_SLOTS) {
      const oldest = this.liveStreams.keys().next().value;
      if (oldest === undefined) break;
      this.liveStreams.delete(oldest);
    }
  }

  /**
   * Republish this connection's OWN durable echo as cumulative text.
   *
   * `subscribe()` puts one handler on both sinks -- `super.subscribe()` (the
   * `updates.jsonl` tail) and `liveHandlers` (ACP notifications) -- and Grok
   * writes every ACP update it sends into that same file. Both copies carry the
   * SAME key, because `acceptUpdate` withholds any frame without a stable
   * eventId and `streamSegmentKey` prefers that id over the line number, and
   * both carry `delta`, which means "append to what that key already holds". So
   * a driven turn rendered its answer twice. `3bf03fe2` settled the REPLAY path
   * and left this one standing.
   *
   * Dropping the echo is the wrong shape: a reader that attached after the live
   * frame but before the line landed would then never receive that text at all.
   * Rewriting it to cumulative `text` is complete for that reader and a no-op
   * for the one that streamed the turn -- the same resolution cline reaches in
   * `reconcileLiveOutput`.
   *
   * What it publishes is the LONGER of the two sides, never the durable prefix
   * on its own. The client REPLACES on `text`, and the tail drain is debounced
   * 80ms and runs mid-answer, so echoing `open.durable` published a strict
   * prefix of what the reader already had: the answer visibly rewound, and the
   * next live delta appended to the truncated text and corrupted it. Publishing
   * `open.live` is monotonic — the row only ever grows.
   *
   * Both directions advance, which is the other half. If the FILE runs ahead of
   * ACP delivery by even one chunk, `open.live.startsWith(durable)` fails; when
   * that happened the cursor stopped advancing for the rest of the turn and
   * every later chunk went out as a raw delta — re-latching the exact duplicate
   * this exists to prevent. A durable read that extends what we published is
   * adopted instead. Only content unrelated to both sides is left untouched, as
   * the delta it is.
   */
  private settleLiveEchoes(messages: readonly AgentMessage[]): readonly AgentMessage[] {
    let rewrote = false;
    const settled = messages.map((message) => {
      const streamed = streamedMessage(message);
      const slot = streamed && streamed.key !== undefined ? `${streamed.type}:${streamed.key}` : undefined;
      if (streamed === undefined || slot === undefined || streamed.delta === undefined) return message;
      const open = this.liveStreams.get(slot);
      if (open === undefined) {
        // The tail reached this row before ACP delivered any of it. Open the
        // slot anyway. Without one there is nothing to reconcile against, and
        // the live deltas that follow — which the reader is about to be shown
        // here — get appended a second time when they arrive.
        this.liveStreams.set(slot, { live: '', durable: streamed.delta, published: streamed.delta });
        this.trimLiveStreams();
        return message;
      }
      const durable = open.durable + streamed.delta;
      const covered = open.published.startsWith(durable);
      const extends_ = !covered && durable.startsWith(open.published);
      if (!covered && !extends_) return message;
      open.durable = durable;
      if (extends_) open.published = durable;
      rewrote = true;
      const { delta: _delta, ...rest } = streamed;
      return { ...rest, text: open.published };
    });
    return rewrote ? settled : messages;
  }
}

/** The two row types that carry `delta`. A stream accumulates under
 *  `type:key`, type-qualified so one native event carrying both an answer and a
 *  thought keeps them apart. */
type GrokStreamedMessage = Extract<AgentMessage, { type: 'model-output' } | { type: 'thinking' }>;

function streamedMessage(message: AgentMessage): GrokStreamedMessage | undefined {
  return message.type === 'model-output' || message.type === 'thinking' ? message : undefined;
}

/** The `running` half of a terminal's pairing: same key, turn and prompt anchor, no invented timing. */
function runningSummaryFor(terminal: GrokRunSummary): GrokRunSummary {
  return {
    type: 'run-summary',
    key: terminal.key,
    turnId: terminal.turnId,
    ...(terminal.userMessageKey ? { userMessageKey: terminal.userMessageKey } : {}),
    status: 'running',
    ...(terminal.source ? { source: terminal.source } : {}),
  };
}
