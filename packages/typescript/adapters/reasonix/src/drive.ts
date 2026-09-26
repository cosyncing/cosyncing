import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  AcpClient,
  type AcpChildExit,
  type AcpClientHooks,
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
  HistoryQuery,
  ModeOption,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionInfo,
  SlashCommand,
} from '@cosyncing/adapter-api';
import { CONTEXT_INJECTION_EVENT, boundContextBody } from '@cosyncing/adapter-api';
import {
  mapReasonixInterruptedTail,
  mapReasonixRecord,
  reasonixMessageKey,
  type ReasonixDisplayEntry,
  type ReasonixTranscriptRecord,
} from './mapping.ts';
import {
  ReasonixObserveConnection,
  type ReasonixObserveOptions,
  type StableReasonixSnapshot,
} from './observe.ts';
import {
  readReasonixAcpPosture,
  reasonixApprovalMode,
  reasonixModelSelection,
  reasonixSessionUsage,
  type ReasonixApprovalMode,
  type ReasonixStoredSession,
  type ReasonixTranscriptRead,
} from './store.ts';

export interface ReasonixAcpTransport {
  readonly alive: boolean;
  initialize?(): Promise<void>;
  sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult>;
  sessionCancel(sessionId: string): void;
  listModels?(): Promise<ModelOption[]>;
  listModes?(): Promise<ModeOption[]>;
  configureModel?(selection: PromptInput['model']): Promise<void>;
  configureMode?(mode: string | undefined): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export interface ReasonixDriveOpenOptions extends Omit<ReasonixObserveOptions, 'session' | 'info'> {
  command?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  permissionMode?: ReasonixApprovalMode;
  requestTimeoutMs?: number;
  onClose?: (connection: ReasonixDriveConnection) => void;
  pendingCreate?: {
    cwd: string;
    model?: string;
    permissionMode?: ReasonixApprovalMode;
    discover(): Promise<ReasonixStoredSession | undefined>;
    onMaterialized?: (connection: ReasonixDriveConnection, session: ReasonixStoredSession) => void;
  };
}

interface ReasonixLazyHooks {
  onSessionUpdate(params: AcpSessionUpdateParams): void;
  onPermissionRequest(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> | AcpRequestPermissionResult;
  onStatusExtension(event: { method: string; params: unknown }): void;
  onMode(mode: ReasonixApprovalMode): void;
  onExit(exit: AcpChildExit): void;
  beforePrompt(): Promise<void>;
}

const MAX_PENDING_PROMPTS = 128;
const MAX_PROMPT_ADMISSIONS = 256;
const MAX_PENDING_PERMISSIONS = 64;
const MAX_NATIVE_PERMISSION_OPTIONS = 64;
const MAX_PERMISSION_FIELD_CHARS = 512;
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;
const MAX_AVAILABLE_COMMANDS = 256;
const MAX_TOOL_FIELD_CHARS = 512;
const PENDING_CREATE_PROBE_INTERVAL_MS = 100;
const PENDING_CREATE_PROBE_DEADLINE_MS = 30_000;

/**
 * Reasonix prepends its own turn-routing block to the user record it persists,
 * so the durable text is not the text we sent:
 *
 *     <capability-route version="1">
 *     Relevant capabilities for this turn:
 *     - source:skills require: ...
 *     </capability-route>
 *
 *     Use your shell tool to run exactly: ...
 *
 * The block is Reasonix's own scaffolding, not a user write, and it appears
 * once the session has context that triggers routing -- which is why a first
 * connection on a fresh session never sees it and a later one does. Without
 * this, the drive matched its own prompt echo against a string starting
 * `<capability-route` and demoted itself on a foreign user write that was the
 * agent talking to itself.
 *
 * Strip only that one well-delimited leading block and compare the remainder
 * exactly. A competing writer's text still cannot match.
 */
const REASONIX_CAPABILITY_ROUTE_PREFIX = /^<capability-route\b[^>]*>[\s\S]*?<\/capability-route>\s*/u;

/**
 * Reasonix 1.25.2 removes one terminal composer line break from raw_content.
 * Keep ownership matching exact apart from that measured ACP persistence
 * canonicalization; broader trimming could claim a foreign user write.
 */
function matchesSentPromptExactly(nativeText: string | undefined, sentText: string): boolean {
  if (nativeText === sentText) return true;
  if (sentText.endsWith('\r\n')) return nativeText === sentText.slice(0, -2);
  if (sentText.endsWith('\n')) return nativeText === sentText.slice(0, -1);
  return false;
}

export function isReasonixDurablePromptEcho(nativeText: string | undefined, sentText: string): boolean {
  if (matchesSentPromptExactly(nativeText, sentText)) return true;
  if (nativeText === undefined) return false;
  const withoutRoute = nativeText.replace(REASONIX_CAPABILITY_ROUTE_PREFIX, '');
  if (withoutRoute === nativeText) return false;
  return matchesSentPromptExactly(withoutRoute, sentText);
}

class ReasonixPromptCancelledBeforeDelivery extends Error {
  constructor() {
    super('Reasonix prompt cancelled before native delivery.');
    this.name = 'ReasonixPromptCancelledBeforeDelivery';
  }
}

interface ReasonixNativeModelOption {
  value: string;
  option: ModelOption;
}

interface ReasonixConfigCatalog {
  modelConfigId?: string;
  models: ReasonixNativeModelOption[];
  currentModel?: string;
  effortConfigId?: string;
  efforts: Array<{ value: string; label: string; description?: string }>;
  currentEffort?: string;
  modeConfigId?: string;
  modes: Array<{ value: ReasonixApprovalMode; label: string; description?: string }>;
  currentMode?: ReasonixApprovalMode;
}

function reasonixConfigCatalog(
  value: unknown,
  legacyModels?: unknown,
  fallback?: ReasonixConfigCatalog,
): ReasonixConfigCatalog {
  const catalog: ReasonixConfigCatalog = { models: [], efforts: [], modes: [] };
  const configOptions = Array.isArray(value) && value.length <= 256 ? value : [];
  for (const raw of configOptions) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const option = raw as {
      id?: unknown; category?: unknown; type?: unknown; currentValue?: unknown; options?: unknown;
    };
    if (option.type !== 'select' || typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 128
      || (option.options !== undefined && (!Array.isArray(option.options) || option.options.length > 256))) continue;
    const category = typeof option.category === 'string' ? option.category : '';
    const isModel = category === 'model' || option.id === 'model';
    const isEffort = category === 'thought_level' || option.id === 'effort';
    const isMode = category === 'tool_approval' || option.id === 'tool_approval';
    if (!isModel && !isEffort && !isMode) continue;
    const parsed = (Array.isArray(option.options) ? option.options : []).flatMap((rawChoice) => {
      if (typeof rawChoice !== 'object' || rawChoice === null || Array.isArray(rawChoice)) return [];
      const choice = rawChoice as { value?: unknown; name?: unknown; description?: unknown };
      if (typeof choice.value !== 'string' || choice.value.length === 0 || choice.value.length > 512
        || typeof choice.name !== 'string' || choice.name.length === 0 || choice.name.length > 512
        || (choice.description !== undefined
          && (typeof choice.description !== 'string' || choice.description.length > 2_048))) return [];
      return [{
        value: choice.value,
        label: choice.name,
        ...(typeof choice.description === 'string' && choice.description ? { description: choice.description } : {}),
      }];
    });
    if (isModel) {
      catalog.modelConfigId = option.id;
      if (typeof option.currentValue === 'string' && option.currentValue.length <= 512) {
        catalog.currentModel = option.currentValue;
      }
      const models = parsed.flatMap((choice) => {
        const selection = reasonixModelSelection(choice.value);
        if (!selection) return [];
        return [{
          value: choice.value,
          option: {
            ...selection,
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
          },
        }];
      });
      if (models.length === parsed.length && models.length > 0) {
        catalog.models = models;
      }
    } else if (isEffort && parsed.length > 0) {
      catalog.effortConfigId = option.id;
      catalog.efforts = parsed;
      if (typeof option.currentValue === 'string' && parsed.some((entry) => entry.value === option.currentValue)) {
        catalog.currentEffort = option.currentValue;
      }
    } else if (isMode && parsed.length > 0) {
      const modes = parsed.flatMap((entry) => {
        const mode = reasonixApprovalMode(entry.value);
        return mode ? [{ ...entry, value: mode }] : [];
      });
      if (modes.length === parsed.length) {
        catalog.modeConfigId = option.id;
        catalog.modes = modes;
        catalog.currentMode = reasonixApprovalMode(option.currentValue);
      }
    }
  }
  if (catalog.models.length === 0 && typeof legacyModels === 'object' && legacyModels !== null) {
    const available = (legacyModels as { availableModels?: unknown }).availableModels;
    if (Array.isArray(available) && available.length <= 256) {
      catalog.models = available.flatMap((raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
        const model = raw as { modelId?: unknown; name?: unknown; description?: unknown };
        if (typeof model.modelId !== 'string' || model.modelId.length === 0 || model.modelId.length > 512
          || typeof model.name !== 'string' || model.name.length === 0 || model.name.length > 512
          || (model.description !== undefined
            && (typeof model.description !== 'string' || model.description.length > 2_048))) return [];
        const selection = reasonixModelSelection(model.modelId);
        if (!selection) return [];
        return [{
          value: model.modelId,
          option: {
            ...selection,
            label: model.name,
            ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
          },
        }];
      });
      const legacyCurrent = (legacyModels as { currentModelId?: unknown }).currentModelId;
      if (!catalog.currentModel && typeof legacyCurrent === 'string' && legacyCurrent.length <= 512) {
        catalog.currentModel = legacyCurrent;
      }
    }
  }
  if (catalog.models.length === 0 && fallback) catalog.models = fallback.models;
  if (!catalog.modelConfigId && fallback) catalog.modelConfigId = fallback.modelConfigId;
  if (!catalog.currentModel && fallback) catalog.currentModel = fallback.currentModel;
  if (catalog.efforts.length === 0 && fallback) {
    catalog.efforts = fallback.efforts;
    catalog.effortConfigId = fallback.effortConfigId;
    catalog.currentEffort = fallback.currentEffort;
  }
  if (catalog.modes.length === 0 && fallback) {
    catalog.modes = fallback.modes;
    catalog.modeConfigId = fallback.modeConfigId;
    catalog.currentMode = fallback.currentMode;
  }
  if (catalog.efforts.length > 0) {
    const reasoningEfforts = catalog.efforts.map((entry) => ({
      effort: entry.value,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
    }));
    catalog.models = catalog.models.map((entry) => ({
      ...entry,
      option: {
        ...entry.option,
        reasoningEfforts,
        ...(catalog.currentEffort ? { defaultReasoningEffort: catalog.currentEffort } : {}),
      },
    }));
  }
  return catalog;
}

/** Starts the native ACP child when command discovery or the first prompt needs it. */
class LazyReasonixAcpTransport implements ReasonixAcpTransport {
  private client?: AcpClient;
  private startupClient?: AcpClient;
  private startupAbort?: AbortController;
  private starting?: Promise<AcpClient>;
  private closed = false;
  private prompting = false;
  private cancelGeneration = 0;
  private configCatalog: ReasonixConfigCatalog = { models: [], efforts: [], modes: [] };

  constructor(
    private readonly session: ReasonixStoredSession,
    private readonly options: ReasonixDriveOpenOptions,
    private readonly hooks: ReasonixLazyHooks,
  ) {}

  get alive(): boolean {
    return !this.closed && (this.client?.alive ?? true);
  }

  async initialize(): Promise<void> {
    await this.ensureClient();
  }

  async sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult> {
    const generation = this.cancelGeneration;
    const client = await this.ensureClient();
    if (generation !== this.cancelGeneration) throw new ReasonixPromptCancelledBeforeDelivery();
    await this.hooks.beforePrompt();
    if (generation !== this.cancelGeneration) throw new ReasonixPromptCancelledBeforeDelivery();
    this.prompting = true;
    try {
      return await client.sessionPrompt(params);
    } finally {
      this.prompting = false;
    }
  }

  sessionCancel(sessionId: string): void {
    this.cancelGeneration += 1;
    if (this.client?.alive) this.client.sessionCancel(sessionId);
  }

  async listModels(): Promise<ModelOption[]> {
    await this.ensureClient();
    return this.configCatalog.models.map((entry) => ({
      ...entry.option,
      ...(entry.option.reasoningEfforts
        ? { reasoningEfforts: entry.option.reasoningEfforts.map((effort) => ({ ...effort })) }
        : {}),
    }));
  }

  async listModes(): Promise<ModeOption[]> {
    await this.ensureClient();
    return this.configCatalog.modes.map((entry) => ({
      ...entry,
      category: entry.value === 'ask'
        ? 'ask-permission'
        : entry.value === 'auto' ? 'approve-for-me' : 'full-access',
    }));
  }

  async configureMode(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    const mode = reasonixApprovalMode(value);
    if (!mode) throw new Error(`Reasonix permission mode ${value} is not in the measured native vocabulary.`);
    const client = await this.ensureClient();
    if (!this.configCatalog.modeConfigId || !this.configCatalog.modes.some((entry) => entry.value === mode)) {
      throw new Error(`Reasonix did not advertise permission mode ${mode}.`);
    }
    if (this.configCatalog.currentMode === mode) return;
    const result = await client.sessionSetConfigOption({
      sessionId: this.session.id,
      configId: this.configCatalog.modeConfigId,
      value: mode,
    });
    this.configCatalog = reasonixConfigCatalog(result.configOptions, undefined, this.configCatalog);
    if (this.configCatalog.currentMode !== mode) {
      throw new Error(`Reasonix did not confirm permission mode ${mode}.`);
    }
  }

  async configureModel(selection: PromptInput['model']): Promise<void> {
    if (!selection) return;
    const client = await this.ensureClient();
    const target = this.configCatalog.models.find((entry) =>
      entry.option.providerID === selection.providerID && entry.option.modelID === selection.modelID);
    if (!target || !this.configCatalog.modelConfigId) {
      throw new Error(`Reasonix did not advertise model ${selection.providerID}/${selection.modelID}.`);
    }
    if (target.value !== this.configCatalog.currentModel) {
      const result = await client.sessionSetConfigOption({
        sessionId: this.session.id,
        configId: this.configCatalog.modelConfigId,
        value: target.value,
      });
      this.configCatalog = reasonixConfigCatalog(result.configOptions, undefined, this.configCatalog);
      if (this.configCatalog.currentModel !== target.value) {
        throw new Error(`Reasonix did not confirm model ${selection.providerID}/${selection.modelID}.`);
      }
    }
    if (selection.reasoningEffort) {
      const effort = this.configCatalog.efforts.find((entry) => entry.value === selection.reasoningEffort);
      if (!effort || !this.configCatalog.effortConfigId) {
        throw new Error(`Reasonix did not advertise reasoning effort ${selection.reasoningEffort}.`);
      }
      if (effort.value !== this.configCatalog.currentEffort) {
        const result = await client.sessionSetConfigOption({
          sessionId: this.session.id,
          configId: this.configCatalog.effortConfigId,
          value: effort.value,
        });
        this.configCatalog = reasonixConfigCatalog(result.configOptions, undefined, this.configCatalog);
        if (this.configCatalog.currentEffort !== effort.value) {
          throw new Error(`Reasonix did not confirm reasoning effort ${selection.reasoningEffort}.`);
        }
      }
    }
  }

  async close(force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.startupAbort?.abort();
    if (force) {
      const client = this.client ?? this.startupClient;
      if (client) await client.close({ force: true });
      return;
    }
    const client = this.client ?? await this.starting?.catch(() => undefined);
    if (client?.alive) {
      try {
        await client.sessionClose({ sessionId: this.session.id }, 250);
      } catch (error) {
        this.options.trace?.({
          op: 'observe',
          detail: `Reasonix ACP session/close failed; falling back to process teardown: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (client) await client.close();
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.closed) throw new Error('Reasonix ACP transport is closed.');
    if (this.client?.alive) return this.client;
    if (!this.starting) {
      const model = this.options.model ?? this.session.model;
      this.starting = (async () => {
        const cwd = this.session.cwd;
        if (!cwd) throw new Error('Reasonix Drive requires a native workspace path.');
        const startupAbort = new AbortController();
        this.startupAbort = startupAbort;
        const client = await AcpClient.connect({
          command: this.options.command ?? 'reasonix',
          args: ['acp', ...(model ? ['--model', model] : []), '--workspace-only'],
          cwd,
          env: this.options.env,
          requestTimeoutMs: this.options.requestTimeoutMs,
          signal: startupAbort.signal,
          hooks: {
            // session/load replays history through the same notification; the
            // file store is the durable replay source, so only prompt-time
            // updates enter the live mapper.
            onSessionUpdate: (params) => {
              if (this.prompting || params.update?.sessionUpdate === 'available_commands_update') {
                this.hooks.onSessionUpdate(params);
              }
            },
            onPermissionRequest: (params) => this.hooks.onPermissionRequest(params),
            extensions: {
              reasonix: (event) => {
                if (event.kind !== 'notification'
                  || event.method !== '_reasonix.io/session/status_update') return undefined;
                this.hooks.onStatusExtension(event);
                return null;
              },
            },
          },
        });
        if (this.startupAbort === startupAbort) this.startupAbort = undefined;
        this.startupClient = client;
        if (this.closed) {
          await client.close({ force: true });
          throw new Error('Reasonix ACP transport closed during startup.');
        }
        void client.exited?.then((exit) => {
          if (!this.closed) this.hooks.onExit(exit);
        });
        try {
          const loaded = await client.sessionLoad({
            sessionId: this.session.id,
            cwd,
            mcpServers: [],
          });
          this.configCatalog = reasonixConfigCatalog(loaded.configOptions, loaded.models);
          if (this.configCatalog.currentMode) this.hooks.onMode(this.configCatalog.currentMode);
          if (this.closed) throw new Error('Reasonix ACP transport closed during startup.');
          this.client = client;
          this.startupClient = undefined;
          return client;
        } catch (error) {
          await client.close();
          if (this.startupClient === client) this.startupClient = undefined;
          throw error;
        }
      })().catch((error) => {
        this.startupAbort = undefined;
        this.closed = true;
        throw error;
      });
    }
    return this.starting;
  }
}

/** Keeps the exact child that answered session/new; it must never session/load or spawn again. */
class CreatedReasonixAcpTransport implements ReasonixAcpTransport {
  private closed = false;

  constructor(
    private readonly client: AcpClient,
    private readonly sessionId: string,
    private configCatalog: ReasonixConfigCatalog,
    private readonly trace?: ReasonixDriveOpenOptions['trace'],
  ) {}

  get alive(): boolean { return !this.closed && this.client.alive; }
  async initialize(): Promise<void> {}

  sessionPrompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<AcpSessionPromptResult> {
    return this.client.sessionPrompt(params);
  }

  sessionCancel(sessionId: string): void { this.client.sessionCancel(sessionId); }

  async listModes(): Promise<ModeOption[]> {
    return this.configCatalog.modes.map((entry) => ({
      ...entry,
      category: entry.value === 'ask'
        ? 'ask-permission'
        : entry.value === 'auto' ? 'approve-for-me' : 'full-access',
    }));
  }

  async configureMode(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    const mode = reasonixApprovalMode(value);
    if (!mode || !this.configCatalog.modeConfigId
      || !this.configCatalog.modes.some((entry) => entry.value === mode)) {
      throw new Error(`Reasonix did not advertise permission mode ${value}.`);
    }
    if (this.configCatalog.currentMode === mode) return;
    const result = await this.client.sessionSetConfigOption({
      sessionId: this.sessionId,
      configId: this.configCatalog.modeConfigId,
      value: mode,
    });
    this.configCatalog = reasonixConfigCatalog(result.configOptions, undefined, this.configCatalog);
    if (this.configCatalog.currentMode !== mode) {
      throw new Error(`Reasonix did not confirm permission mode ${mode}.`);
    }
  }

  async close(force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (force) {
      await this.client.close({ force: true });
      return;
    }
    if (this.client.alive) {
      try {
        await this.client.sessionClose({ sessionId: this.sessionId }, 250);
      } catch (error) {
        this.trace?.({
          op: 'observe',
          detail: `Reasonix pending-create session/close failed; falling back to process teardown: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    await this.client.close();
  }
}

interface PendingPrompt {
  key: string;
  text: string;
  clientKey?: string;
  byteFence: number;
  userIndex?: number;
  assistantIndex?: number;
  /** Empty creates may persist native system rows before their first user row. */
  materializesCreate?: boolean;
  row: AgentMessage;
}

type RunSummary = Extract<AgentMessage, { type: 'run-summary' }>;

/**
 * One native turn this connection delivered over ACP. The broker's attention
 * policy notifies only for a live `running` run-summary followed by a terminal
 * with the same key, and Reasonix never reports a running turn by that key:
 * v1.25.2 stamps `workDurationMs` on EVERY committed assistant row, tool steps
 * included (upstream `internal/agent/run_loop.go`), so a tool turn writes one
 * `done` footer per model step and the step that ends the turn is known only
 * once `session/prompt` returns. The pairing is therefore made after that
 * return, on the turn's last footer, and only for a turn whose durable user
 * row this connection claimed as its own echo.
 */
interface DrivenTurn {
  /** The claimed durable user row's display index. */
  userIndex?: number;
  /** `session/prompt` returned a stop reason other than `cancelled`. */
  resolved: boolean;
}

type DrivenTurnClosing =
  | { state: 'found'; lineIndex: number; summary: RunSummary }
  /** The next user-authored turn began without a footer for this one. */
  | { state: 'sealed' }
  /** No footer yet, and nothing proves one cannot still arrive. */
  | { state: 'open' };

/**
 * The footer that closes the turn opened by the user row at `userIndex`: the
 * last assistant row that maps to a `done` run-summary before the next
 * user-authored row. Reasonix's own retry and steer rows carry
 * `starts_turn: false` and stay inside the turn.
 */
function drivenTurnClosing(sessionId: string, read: ReasonixTranscriptRead, userIndex: number): DrivenTurnClosing {
  const displayByIndex = new Map(read.displayEntries.map((entry) => [entry.index, entry]));
  if (read.records[userIndex]?.role !== 'user' || displayByIndex.get(userIndex)?.index !== userIndex) {
    return { state: 'open' };
  }
  let found: DrivenTurnClosing | undefined;
  for (let lineIndex = userIndex + 1; lineIndex < read.records.length; lineIndex += 1) {
    const record = read.records[lineIndex];
    if (!record) continue;
    const display = displayByIndex.get(lineIndex);
    if (record.role === 'user' && display?.startsTurn !== false) return found ?? { state: 'sealed' };
    if (record.role !== 'assistant') continue;
    const summary = mapReasonixRecord(record, { sessionId, lineIndex, display })
      .find((message): message is RunSummary => message.type === 'run-summary' && message.status === 'done');
    if (summary) found = { state: 'found', lineIndex, summary };
  }
  return found ?? { state: 'open' };
}

/** The live `running` frame that opens the attention observation for a terminal footer. */
function runningFor(terminal: RunSummary): RunSummary {
  return { type: 'run-summary', key: terminal.key, turnId: terminal.turnId, status: 'running', source: 'reasonix' };
}

interface PendingPermission {
  message: AgentMessage;
  optionIds: Map<PermissionDecision, string>;
  resolve: (result: AcpRequestPermissionResult) => void;
}

interface PendingQuestion {
  message: Extract<AgentMessage, { type: 'question-request' }>;
  optionIds: Map<string, string>;
  resolve: (result: AcpRequestPermissionResult) => void;
}

function textContent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
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
      : option.kind === 'allow_always' ? 'approve-rule'
        : option.kind === 'reject_once' ? 'reject'
          : undefined;
    if (!decision || decisions.has(decision)) return undefined;
    decisions.set(decision, id);
  }
  return decisions;
}

function reasonixQuestionShape(params: AcpRequestPermissionParams): {
  message: Extract<AgentMessage, { type: 'question-request' }>;
  optionIds: Map<string, string>;
} | undefined {
  const toolCallId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined;
  if (!toolCallId?.startsWith('ask-') || toolCallId.length > MAX_PERMISSION_FIELD_CHARS) return undefined;
  const raw = params.toolCall?.rawInput;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const input = raw as { id?: unknown; question?: unknown; options?: unknown };
  if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > MAX_PERMISSION_FIELD_CHARS
    || typeof input.question !== 'string' || input.question.length === 0 || input.question.length > 4_000
    || !Array.isArray(input.options) || input.options.length === 0
    || input.options.length > MAX_NATIVE_PERMISSION_OPTIONS) return undefined;

  const nativeIds = new Set((params.options ?? []).map(optionId).filter((id): id is string => !!id));
  const optionIds = new Map<string, string>();
  const options: Array<{ label: string; description?: string }> = [];
  for (let index = 0; index < input.options.length; index += 1) {
    const rawOption = input.options[index];
    if (typeof rawOption !== 'object' || rawOption === null || Array.isArray(rawOption)) return undefined;
    const option = rawOption as { label?: unknown; description?: unknown };
    if (typeof option.label !== 'string' || option.label.length === 0
      || option.label.length > MAX_PERMISSION_FIELD_CHARS || optionIds.has(option.label)
      || (option.description !== undefined && (typeof option.description !== 'string'
        || option.description.length > 4_000))) return undefined;
    const nativeId = `${input.id}:${index + 1}`;
    if (!nativeIds.has(nativeId)) return undefined;
    optionIds.set(option.label, nativeId);
    options.push({
      label: option.label,
      ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}),
    });
  }
  return {
    message: {
      type: 'question-request',
      requestId: toolCallId,
      questions: [{ question: input.question, options }],
    },
    optionIds,
  };
}

function boundedDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return '[unserializable Reasonix tool input]';
  }
}

function boundedToolPayload(value: unknown, label: 'input' | 'output'): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return undefined;
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_PAYLOAD_BYTES) return value;
    return `[Reasonix tool ${label} exceeded ${MAX_TOOL_PAYLOAD_BYTES} bytes; omitted]`;
  } catch {
    return `[unserializable Reasonix tool ${label}]`;
  }
}

function boundedToolField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= MAX_TOOL_FIELD_CHARS
    ? value
    : fallback;
}

/** Normalize one ACP live update without inventing file semantics the wire did not report. */
export function mapReasonixSessionUpdate(
  update: Record<string, unknown>,
  fallbackCallId = 'reasonix-tool:unknown',
  liveIdentity?: { sessionId: string; assistantIndex: number },
): AgentMessage[] {
  const content = textContent(update.content);
  if (update.sessionUpdate === 'agent_message_chunk' && content !== undefined) {
    return [{
      type: 'model-output',
      delta: content,
      ...(liveIdentity
        ? { key: `${reasonixMessageKey(liveIdentity.sessionId, liveIdentity.assistantIndex)}:output` }
        : {}),
    }];
  }
  if (update.sessionUpdate === 'agent_thought_chunk' && content !== undefined) {
    return [{
      type: 'thinking',
      delta: content,
      ...(liveIdentity
        ? { key: `${reasonixMessageKey(liveIdentity.sessionId, liveIdentity.assistantIndex)}:thinking` }
        : {}),
    }];
  }
  if (update.sessionUpdate === 'tool_call') {
    const callId = boundedToolField(update.toolCallId, fallbackCallId);
    const title = boundedToolField(update.title, 'Reasonix tool');
    return [{ type: 'tool-call', callId, toolName: title, title, args: boundedToolPayload(update.rawInput, 'input') }];
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const status = typeof update.status === 'string' ? update.status.toLowerCase() : '';
    if (!['completed', 'failed', 'cancelled'].includes(status)) return [];
    const callId = boundedToolField(update.toolCallId, fallbackCallId);
    const title = boundedToolField(update.title, 'Reasonix tool');
    return [{
      type: 'tool-result',
      callId,
      toolName: title,
      result: boundedToolPayload(update.rawOutput ?? content ?? update.status, 'output'),
      isError: status === 'failed',
    }];
  }
  if (typeof update.sessionUpdate === 'string') {
    const bounded = boundContextBody(`sessionUpdate=${update.sessionUpdate}`);
    return [{
      type: 'event',
      name: CONTEXT_INJECTION_EVENT,
      payload: {
        source: 'Reasonix live update (unmapped)',
        body: bounded.body,
        ...(bounded.truncated ? { truncated: true } : {}),
      },
    }];
  }
  return [];
}

export function reasonixAvailableCommands(update: Record<string, unknown>): SlashCommand[] | undefined {
  if (update.sessionUpdate !== 'available_commands_update') return undefined;
  const raw = update.availableCommands;
  if (!Array.isArray(raw)) return [];
  const commands: SlashCommand[] = [];
  const names = new Set<string>();
  for (const value of raw.slice(0, MAX_AVAILABLE_COMMANDS)) {
    if (typeof value !== 'object' || value === null) continue;
    const row = value as { name?: unknown; description?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim().replace(/^\/+/, '') : '';
    if (!name || name.length > 128 || /[\s/\u0000-\u001f]/u.test(name) || names.has(name)) continue;
    names.add(name);
    commands.push({
      name,
      kind: 'prompt',
      ...(typeof row.description === 'string' && row.description.trim()
        ? { description: row.description.trim().slice(0, 2_048) }
        : {}),
    });
  }
  return commands;
}

export class ReasonixDriveConnection extends ReasonixObserveConnection {
  private readonly transport: ReasonixAcpTransport;
  /** Stable connection identity used by the adapter's compare-and-swap owner registry. */
  readonly identity = randomUUID();
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly liveHandlers = new Set<(message: AgentMessage) => void>();
  private readonly claimedOffsets = new Map<number, {
    key: string;
    clientKey?: string;
    displayIndex: number;
    text: string;
  }>();
  private availableCommands: SlashCommand[] = [];
  private ownershipFence?: number;
  // The byte fence alone cannot judge a row that came from the event journal.
  // The journal runs AHEAD of the flat transcript -- measured: 10 journal
  // messages against 5 flat records -- so a journal row is reported at the flat
  // transcript's frontier and `offset >= ownershipFence` is trivially true for
  // it, however old it is. Rows are therefore fenced in BOTH spaces, and a row
  // has to be beyond the transcript this connection inherited in each of them
  // before it can count as a foreign write.
  private ownershipIndexFence?: number;
  private turnChain: Promise<void> = Promise.resolve();
  private readonly onCloseHook?: (connection: ReasonixDriveConnection) => void;
  private sequence = 0;
  private promptAdmissions = 0;
  private cancelGeneration = 0;
  private nextNativeIndex?: number;
  private activeAssistantIndex?: number;
  private activeIdentityAmbiguous = false;
  private suppressAssistantStreaming = false;
  private durableRebaseAfterIndex?: number;
  private readonly awaitingAssistantIndexes = new Set<number>();
  /** Native turns this connection has in flight, including one whose assistant index is not known
   *  yet. A first post-create turn reserves no index (`reservePromptIndex` returns undefined while
   *  `pendingCreate`), so the awaiting set alone reported us as NOT the live writer for exactly the
   *  window in which we were. */
  private inFlightNativeTurns = 0;
  private readonly terminalAssistantIndexes = new Set<number>();
  private readonly assistantStreamIndexes = new Set<number>();
  /** Delivered turns awaiting their `running` + terminal pairing, by queued prompt key. */
  private readonly drivenTurns = new Map<string, DrivenTurn>();
  private deferredNativeIdle = false;
  private closedDrive = false;
  private transportClosing?: Promise<void>;
  private demoted = false;
  private correlationInvalidated = false;
  private lastStatusSequence = -1;
  private pendingCreate?: NonNullable<ReasonixDriveOpenOptions['pendingCreate']>;
  /**
   * The first durable snapshot of an ACP-created session must be fanned out
   * live even when terminal prompt handling materializes the session before
   * fs.watch (or the bounded probe) enters Observe's initial drain.
   */
  private publishCreatedInitialSnapshot = false;
  private materializingCreate?: Promise<void>;
  private pendingCreateProbeTimer?: ReturnType<typeof setTimeout>;
  private pendingCreateProbeDeadline = 0;

  protected constructor(
    session: ReasonixStoredSession,
    info: SessionInfo,
    transport: ReasonixAcpTransport,
    options: ReasonixDriveOpenOptions,
  ) {
    super({
      session,
      info,
      trace: options.trace,
      correlationRegistry: options.correlationRegistry,
    });
    this.transport = transport;
    if (options.onClose) this.onCloseHook = options.onClose;
    if (options.pendingCreate) {
      this.pendingCreate = options.pendingCreate;
      this.publishCreatedInitialSnapshot = true;
    }
  }

  /**
   * Create a Drive owner around the exact ACP child that answered session/new.
   * The caller supplies only provisional paths; no durable row is fabricated.
   */
  static async createPending(
    cwd: string,
    build: (
      sessionId: string,
      model?: string,
      permissionMode?: ReasonixApprovalMode,
    ) => { session: ReasonixStoredSession; info: SessionInfo },
    options: ReasonixDriveOpenOptions = {},
  ): Promise<ReasonixDriveConnection> {
    let connection: ReasonixDriveConnection | undefined;
    const hooks: AcpClientHooks = {
      onSessionUpdate: (params) => connection?.acceptUpdate(params),
      onPermissionRequest: (params) => connection?.requestPermission(params)
        ?? { outcome: { outcome: 'cancelled' } },
      extensions: {
        reasonix: (event) => {
          if (event.kind !== 'notification'
            || event.method !== '_reasonix.io/session/status_update') return undefined;
          connection?.acceptStatusExtension(event);
          return null;
        },
      },
    };
    const client = await AcpClient.connect({
      command: options.command ?? 'reasonix',
      args: ['acp', ...(options.model ? ['--model', options.model] : []), '--workspace-only'],
      cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
      hooks,
    });
    try {
      const created = await client.sessionNew({ cwd, mcpServers: [] });
      if (typeof created.sessionId !== 'string'
        || !created.sessionId
        || created.sessionId.length > 512
        || created.sessionId === '.'
        || created.sessionId === '..'
        || /[\\/\0]/u.test(created.sessionId)) {
        throw new Error('Reasonix session/new returned no safe session id.');
      }
      let createdCatalog = reasonixConfigCatalog(created.configOptions, created.models);
      const createdModel = options.model ?? createdCatalog.currentModel;
      const requestedMode = options.permissionMode;
      if (requestedMode) {
        if (!createdCatalog.modeConfigId
          || !createdCatalog.modes.some((entry) => entry.value === requestedMode)) {
          throw new Error(`Reasonix session/new did not advertise permission mode ${requestedMode}.`);
        }
        if (createdCatalog.currentMode !== requestedMode) {
          const configured = await client.sessionSetConfigOption({
            sessionId: created.sessionId,
            configId: createdCatalog.modeConfigId,
            value: requestedMode,
          });
          createdCatalog = reasonixConfigCatalog(configured.configOptions, undefined, createdCatalog);
        }
        if (createdCatalog.currentMode !== requestedMode) {
          throw new Error(`Reasonix did not confirm permission mode ${requestedMode} after session/new.`);
        }
      }
      const createdMode = requestedMode ?? createdCatalog.currentMode;
      if (options.pendingCreate && !options.pendingCreate.model && createdModel) {
        options.pendingCreate.model = createdModel;
      }
      if (options.pendingCreate && !options.pendingCreate.permissionMode && createdMode) {
        options.pendingCreate.permissionMode = createdMode;
      }
      const provisional = build(created.sessionId, createdModel, createdMode);
      const transport = new CreatedReasonixAcpTransport(
        client,
        created.sessionId,
        createdCatalog,
        options.trace,
      );
      connection = new ReasonixDriveConnection(provisional.session, provisional.info, transport, options);
      void client.exited?.then((exit) => {
        connection?.demote(
          `Reasonix ACP child exited (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
        );
      });
      return connection;
    } catch (error) {
      await client.close({ force: true });
      throw error;
    }
  }

  static async open(
    session: ReasonixStoredSession,
    info: SessionInfo,
    options: ReasonixDriveOpenOptions = {},
  ): Promise<ReasonixDriveConnection> {
    let connection: ReasonixDriveConnection | undefined;
    const transport = new LazyReasonixAcpTransport(session, options, {
      onSessionUpdate: (params) => connection?.acceptUpdate(params),
      onPermissionRequest: (params) => connection?.requestPermission(params)
        ?? { outcome: { outcome: 'cancelled' } },
      onStatusExtension: (event) => connection?.acceptStatusExtension(event),
      onMode: (mode) => connection?.recordAuthoritativeMode(mode),
      onExit: (exit) => connection?.demote(
        `Reasonix ACP child exited (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
      ),
      beforePrompt: async () => {
        if (!connection) throw new Error('Reasonix Drive connection was not initialized.');
        await connection.assertFreshDriveEligibility();
      },
    });
    connection = new ReasonixDriveConnection(session, info, transport, options);
    return connection;
  }

  /** Test seam: production uses {@link open}, which owns a real ACP child. */
  static fromTransport(
    session: ReasonixStoredSession,
    info: SessionInfo,
    transport: ReasonixAcpTransport,
    options: ReasonixDriveOpenOptions = {},
  ): ReasonixDriveConnection {
    return new ReasonixDriveConnection(session, info, transport, options);
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
    if (this.pendingCreate) return [...this.pendingPrompts.map((entry) => entry.row)];
    return [...await super.getHistory(query), ...this.pendingPrompts.map((entry) => entry.row)];
  }

  getPending(): AgentMessage[] {
    return [
      ...this.pendingPrompts.map((entry) => entry.row),
      ...[...this.pendingPermissions.values()].map((entry) => entry.message),
      ...[...this.pendingQuestions.values()].map((entry) => entry.message),
    ];
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      await this.transport.initialize?.();
    } catch (error) {
      this.demote(`Reasonix ACP command discovery failed: ${error instanceof Error ? error.message : String(error)}.`);
      throw error;
    }
    return [
      { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      ...this.availableCommands
        .filter((command) => command.name !== 'stop')
        .map((command) => ({ ...command })),
    ];
  }

  async listModels(): Promise<ModelOption[]> {
    return [];
  }

  async listModes(): Promise<ModeOption[]> {
    try {
      return await this.transport.listModes?.() ?? [];
    } catch (error) {
      this.demote(`Reasonix ACP mode discovery failed: ${error instanceof Error ? error.message : String(error)}.`);
      throw error;
    }
  }

  async runCommand(name: string, args?: string, input: CommandInput = {}): Promise<CommandResult | void> {
    if (name === 'stop' || name === 'abort') {
      if (this.closedDrive || this.demoted || !this.transport.alive) {
        throw new Error('Reasonix Drive is read-only; refusing Stop.');
      }
      this.cancel();
      return { notice: 'Stop requested.' };
    }
    const command = this.availableCommands.find((entry) => entry.name === name);
    if (!command) throw new Error(`Reasonix command /${name} is not in the current ACP command catalog.`);
    const suffix = args?.trim();
    await this.sendPrompt({ text: `/${command.name}${suffix ? ` ${suffix}` : ''}`, ...input });
  }

  override async sendPrompt(input: PromptInput): Promise<void> {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive is not writable; refusing prompt before touching run state.');
    }
    if (input.images?.length || input.files?.length) {
      throw new Error('Reasonix native file input is not supported by the measured adapter contract.');
    }
    if (input.model) {
      throw new Error('Reasonix existing-session model selection is disabled until a native set_config_option probe proves it.');
    }
    if (this.pendingPrompts.length >= MAX_PENDING_PROMPTS) {
      throw new Error(`Reasonix Drive has ${MAX_PENDING_PROMPTS} pending prompts; refusing another.`);
    }
    if (this.promptAdmissions >= MAX_PROMPT_ADMISSIONS) {
      throw new Error(`Reasonix Drive reached its ${MAX_PROMPT_ADMISSIONS}-prompt connection limit; reconnect before writing again.`);
    }
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive stopped before prompt admission.');
    }
    const key = `queued:reasonix:${this.identity}.${++this.sequence}`;
    this.promptAdmissions += 1;
    const row: AgentMessage = {
      type: 'user-message',
      text: input.text,
      key,
      queued: true,
      ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}),
    };
    this.pendingPrompts.push({
      key,
      text: input.text,
      // The delivery chain refreshes this fence immediately before touching
      // ACP. Keeping admission synchronous preserves socket arrival order and
      // makes the pending/admission limits atomic across joined clients.
      byteFence: 0,
      row,
      ...(this.pendingCreate ? { materializesCreate: true } : {}),
      ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}),
    });
    this.emitLive(row);
    const admissionCancelGeneration = this.cancelGeneration;
    const run = async () => {
      let assistantIndex: number | undefined;
      let nativeStarted = false;
      try {
        if (this.closedDrive || this.demoted || !this.transport.alive) {
          throw new Error('Reasonix Drive stopped before queued prompt delivery.');
        }
        if (admissionCancelGeneration !== this.cancelGeneration) throw new ReasonixPromptCancelledBeforeDelivery();
        const admitted = this.pendingPrompts.find((entry) => entry.key === key);
        if (!admitted) throw new Error('Reasonix queued prompt disappeared before native delivery.');
        await this.assertFreshDriveEligibility();
        await this.transport.configureModel?.(input.model);
        await this.transport.configureMode?.(input.permissionMode);
        if (this.closedDrive || admissionCancelGeneration !== this.cancelGeneration) {
          throw new ReasonixPromptCancelledBeforeDelivery();
        }
        if (input.model) {
          this.emitLive({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel: input.model } });
        }
        if (input.permissionMode) {
          const mode = reasonixApprovalMode(input.permissionMode);
          if (mode) this.recordAuthoritativeMode(mode);
        }
        admitted.byteFence = await stat(this.session.transcriptPath).then((value) => value.size, () => 0);
        if (this.closedDrive || admissionCancelGeneration !== this.cancelGeneration) {
          throw new ReasonixPromptCancelledBeforeDelivery();
        }
        admitted.userIndex = await this.reservePromptIndex();
        if (this.closedDrive || admissionCancelGeneration !== this.cancelGeneration) {
          throw new ReasonixPromptCancelledBeforeDelivery();
        }
        if (admitted.userIndex !== undefined) admitted.assistantIndex = admitted.userIndex + 1;
        await this.assertFreshDriveEligibility();
        assistantIndex = admitted.assistantIndex;
        this.activeAssistantIndex = assistantIndex;
        this.activeIdentityAmbiguous = false;
        this.suppressAssistantStreaming = admitted.materializesCreate === true;
        if (assistantIndex !== undefined) this.awaitingAssistantIndexes.add(assistantIndex);
        this.inFlightNativeTurns += 1;
        nativeStarted = true;
        this.trackDrivenTurn(key);
        if (admitted.materializesCreate) this.startPendingCreateProbe();
        const result = await this.transport.sessionPrompt({
          sessionId: this.session.id,
          prompt: [{ type: 'text', text: input.text }],
        });
        if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error'].includes(result.stopReason ?? '')) {
          throw new Error(`Reasonix returned unsupported ACP stopReason ${JSON.stringify(result.stopReason)}.`);
        }
        const mustPublishCreatedSnapshot = admitted.materializesCreate === true
          || this.publishCreatedInitialSnapshot
          || this.pendingCreate !== undefined;
        await this.materializeCreatedSession();
        if (input.permissionMode) {
          const requestedMode = reasonixApprovalMode(input.permissionMode);
          if (requestedMode) await this.requireDurableMode(requestedMode);
        }
        // The first durable files can all land before session/prompt resolves.
        // In that ordering fs.watch has no later edge to wake Observe after
        // materialization cleared the provisional owner, so explicitly route
        // the terminal snapshot through the same serialized live drain.
        if (mustPublishCreatedSnapshot) await this.refreshFromStore();
        // Inspect without advancing Observe's replay cursor. Every legal ACP
        // terminal reason may finish without an assistant row. Once the
        // durable user row is visible, settle that missing slot and rebase the
        // next admission on the actual display instead of assuming N+2.
        const snapshot = await this.inspectHistoryForDrive();
        if (admitted.userIndex === undefined || admitted.assistantIndex === undefined) {
          throw new Error('Reasonix first created prompt did not publish one correlatable durable user row.');
        }
        assistantIndex = admitted.assistantIndex;
        this.terminalAssistantIndexes.add(admitted.assistantIndex);
        const cancelledSummary = result.stopReason === 'cancelled'
          ? mapReasonixInterruptedTail(this.session.id, snapshot.records, snapshot.displayEntries)
          : undefined;
        const durableUser = this.settleTerminalSnapshot(snapshot, admitted, cancelledSummary !== undefined);
        if (durableUser && cancelledSummary?.type === 'run-summary') {
          cancelledSummary.userMessageKey = admitted.key;
          this.emitLive(cancelledSummary);
          this.maybeEmitDeferredIdle();
        }
        if ((result.stopReason === 'cancelled' || result.stopReason === 'error') && !durableUser) {
          this.demote(
            `Reasonix reported ${result.stopReason} before its durable transcript proved whether the prompt was stored.`,
          );
        }
        this.resolveDrivenTurn(key, result.stopReason, snapshot);
        if (result.stopReason === 'refusal') this.emitLive({ type: 'error', message: 'Reasonix refused the turn.' });
        if (result.stopReason === 'error') this.emitLive({ type: 'error', message: 'Reasonix ended the turn with an error.' });
        if (result.stopReason === 'max_tokens') this.emitLive({ type: 'notice', message: 'Reasonix reached the turn token limit.' });
      } catch (error) {
        if (error instanceof ReasonixPromptCancelledBeforeDelivery) {
          this.drivenTurns.delete(key);
          const refusedIndex = this.pendingPrompts.findIndex((entry) => entry.key === key);
          const refused = refusedIndex < 0 ? undefined : this.pendingPrompts[refusedIndex];
          if (refusedIndex >= 0) this.pendingPrompts.splice(refusedIndex, 1);
          if (assistantIndex !== undefined) this.awaitingAssistantIndexes.delete(assistantIndex);
          if (assistantIndex !== undefined) this.terminalAssistantIndexes.delete(assistantIndex);
          if (refused?.userIndex !== undefined) this.nextNativeIndex = refused.userIndex;
          this.emitHistoryReset();
          return;
        }
        if (!nativeStarted) {
          const refusedIndex = this.pendingPrompts.findIndex((entry) => entry.key === key);
          if (refusedIndex >= 0) this.pendingPrompts.splice(refusedIndex, 1);
          this.emitHistoryReset();
        }
        this.drivenTurns.delete(key);
        this.demote(`Reasonix ACP turn failed: ${error instanceof Error ? error.message : String(error)}.`);
        throw error;
      } finally {
        if (nativeStarted && this.inFlightNativeTurns > 0) this.inFlightNativeTurns -= 1;
        if (assistantIndex !== undefined && this.activeAssistantIndex === assistantIndex) {
          this.activeAssistantIndex = undefined;
          this.activeIdentityAmbiguous = false;
        }
        this.suppressAssistantStreaming = false;
      }
    };
    const turn = this.turnChain.then(run);
    this.turnChain = turn.catch(() => {});
    await turn;
  }

  override async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive is read-only; refusing permission response.');
    }
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Reasonix permission ${requestId} is not pending.`);
    this.pendingPermissions.delete(requestId);
    const selected = pending.optionIds.get(decision);
    // Resolve first — a decision we cannot map must still settle the native
    // request, or the ACP child waits on it forever.
    pending.resolve(selected
      ? { outcome: { outcome: 'selected', optionId: selected } }
      : { outcome: { outcome: 'cancelled' } });
    if (!selected) {
      // And then say what actually happened. Publishing the REQUESTED decision
      // here told every client the tool had been approved while the agent had
      // been told `cancelled`, so the tool never ran and nothing on the wire
      // said so: the card resolved, the session went idle, and the user was left
      // with no error and no reason to retry. `reject` is the honest wire value
      // for a request that was settled without selecting an option.
      this.trace?.({
        op: 'observe',
        detail: `permission ${requestId} decision ${decision} matched no native option; cancelled natively`,
      });
      this.emitLive({ type: 'permission-resolved', requestId, decision: 'reject' });
      return;
    }
    this.emitLive({ type: 'permission-resolved', requestId, decision });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive is read-only; refusing question response.');
    }
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`Reasonix question ${requestId} is not pending.`);
    const labels = answers[0];
    if (answers.length !== 1 || !labels || labels.length !== 1) {
      throw new Error('Reasonix ACP questions require exactly one selected option.');
    }
    const selected = pending.optionIds.get(labels[0]!);
    if (!selected) throw new Error(`Reasonix question ${requestId} received an unknown option.`);
    this.pendingQuestions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: selected } });
    this.emitLive({ type: 'question-resolved', requestId });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive is read-only; refusing question response.');
    }
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`Reasonix question ${requestId} is not pending.`);
    this.pendingQuestions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.emitLive({ type: 'question-resolved', requestId });
  }

  cancel(): void {
    this.cancelGeneration += 1;
    try {
      if (this.transport.alive) this.transport.sessionCancel(this.session.id);
    } catch {
      // Resolver cleanup below is authoritative even when the pipe raced exit.
    } finally {
      this.settleInteractiveRequests('external');
      this.awaitingAssistantIndexes.clear();
      this.terminalAssistantIndexes.clear();
      this.assistantStreamIndexes.clear();
      this.durableRebaseAfterIndex = undefined;
      this.deferredNativeIdle = false;
    }
  }

  demote(reason = 'Reasonix transcript received a foreign user write.'): void {
    if (this.demoted || this.closedDrive) return;
    this.demoted = true;
    this.correlationInvalidated = true;
    this.claimedOffsets.clear();
    this.correlationRegistry?.invalidate(this.session.id);
    this.stopPendingCreateProbe();
    this.activeAssistantIndex = undefined;
    this.activeIdentityAmbiguous = false;
    this.suppressAssistantStreaming = false;
    this.awaitingAssistantIndexes.clear();
    this.terminalAssistantIndexes.clear();
    this.assistantStreamIndexes.clear();
    this.drivenTurns.clear();
    this.durableRebaseAfterIndex = undefined;
    this.deferredNativeIdle = false;
    try { if (this.transport.alive) this.transport.sessionCancel(this.session.id); } catch { /* close below is authoritative */ }
    this.settleInteractiveRequests('external');
    // Retained rather than fired and forgotten. The transport marks itself
    // closed synchronously, so the `await this.transport.close()` in `close()`
    // below early-returns and would otherwise report a teardown while this
    // force-kill was still outstanding.
    this.transportClosing = this.transport.close(true).catch(() => undefined);
    this.emitLive({ type: 'status', status: 'idle' });
    this.emitLive({ type: 'notice', message: `${reason} This connection is now read-only.` });
    this.emitLive({ type: 'metadata-update', key: 'sessionInfo', value: {
      control: {
        drive: { state: 'observing', supported: false, takeoverAvailable: true },
        terminalSync: { supported: false, syncAvailable: false, active: false },
      },
    } });
    this.onCloseHook?.(this);
  }

  override async close(): Promise<void> {
    if (this.closedDrive) return;
    this.closedDrive = true;
    this.stopPendingCreateProbe();
    this.cancelGeneration += 1;
    for (const pending of this.pendingPermissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
    for (const pending of this.pendingQuestions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingQuestions.clear();
    this.awaitingAssistantIndexes.clear();
    this.terminalAssistantIndexes.clear();
    this.assistantStreamIndexes.clear();
    this.drivenTurns.clear();
    this.durableRebaseAfterIndex = undefined;
    this.deferredNativeIdle = false;
    try {
      await super.close();
    } finally {
      try {
        await this.transport.close();
        await this.transportClosing;
      } finally {
        this.liveHandlers.clear();
        this.onCloseHook?.(this);
      }
    }
  }

  /** Whether this exact registered connection still owns write authority. */
  get driving(): boolean {
    return !this.closedDrive && !this.demoted && this.transport.alive;
  }

  protected override onTailRecord(
    record: ReasonixTranscriptRecord,
    _lineIndex: number,
    display: ReasonixDisplayEntry | undefined,
    messages: readonly AgentMessage[],
    snapshot?: StableReasonixSnapshot,
  ): void {
    const canDemote = !this.demoted;
    if (record.role === 'assistant' && display) {
      this.awaitingAssistantIndexes.delete(display.index);
      this.terminalAssistantIndexes.delete(display.index);
      this.assistantStreamIndexes.delete(display.index);
      this.maybeEmitDeferredIdle();
    }
    if (this.correlationInvalidated) return;
    if (display) this.nextNativeIndex = Math.max(this.nextNativeIndex ?? 0, display.index + 1);
    const earliestPendingFence = this.pendingPrompts.reduce(
      (earliest, entry) => Math.min(earliest, entry.byteFence),
      Number.POSITIVE_INFINITY,
    );
    // With no prompt pending this connection cannot have authored a user row,
    // so everything already on disk is history and the fence belongs past it --
    // the same meaning `onHistorySnapshot` gives it with `byteLength`. The old
    // `: 0` said the opposite ("with nothing pending, treat all history as mine
    // to demote on"), which is the wrong default for a connection that has
    // written nothing yet.
    this.ownershipFence ??= Number.isFinite(earliestPendingFence)
      ? earliestPendingFence
      : (display ? display.offset + display.length : 0);
    // Apply the fence, do not merely compute it. `onHistorySnapshot` gates the
    // same call on `(display?.offset ?? -1) >= this.ownershipFence`, because a
    // user row written before this connection took ownership is history, not a
    // foreign write. This path computed the fence and then passed `canDemote`
    // straight through, so any pre-existing user row arriving incrementally
    // demoted a healthy connection.
    //
    // Measured: attach a second Drive connection to a Reasonix session another
    // connection already drove, and its own prompt is refused --
    // `Reasonix transcript received a foreign user write. This connection is
    // now read-only.`, `nack CLIENT_MESSAGE_FAILED` naming the connection's own
    // clientMessageId, and the history frame reading `count: 18` before and
    // after, so no foreign row ever arrived. That is what a user reopening the
    // app and prompting into a session they drove earlier would hit.
    this.ownershipIndexFence ??= display ? display.index : 0;
    this.reconcileDurableUser(
      record,
      display,
      messages,
      canDemote
        && (display?.offset ?? -1) >= this.ownershipFence
        && (display?.index ?? -1) >= this.ownershipIndexFence,
      snapshot,
    );
  }

  protected override onHistorySnapshot(
    records: readonly ReasonixTranscriptRecord[],
    displayEntries: readonly ReasonixDisplayEntry[],
    messages: readonly AgentMessage[],
    byteLength: number,
    snapshot?: StableReasonixSnapshot,
  ): void {
    const canDemote = !this.demoted;
    for (let index = 0; index < records.length; index += 1) {
      if (records[index]?.role === 'assistant') {
        const assistantIndex = displayEntries[index]?.index ?? index;
        this.awaitingAssistantIndexes.delete(assistantIndex);
        this.terminalAssistantIndexes.delete(assistantIndex);
        this.assistantStreamIndexes.delete(assistantIndex);
      }
    }
    this.maybeEmitDeferredIdle();
    if (this.correlationInvalidated) return;
    const highestIndex = displayEntries.reduce((highest, entry) => Math.max(highest, entry.index), -1);
    this.nextNativeIndex = Math.max(this.nextNativeIndex ?? 0, highestIndex + 1, records.length);
    const earliestPendingFence = this.pendingPrompts.reduce(
      (earliest, entry) => Math.min(earliest, entry.byteFence),
      Number.POSITIVE_INFINITY,
    );
    this.ownershipFence ??= Number.isFinite(earliestPendingFence) ? earliestPendingFence : byteLength;
    this.ownershipIndexFence ??= highestIndex + 1;
    const displayByIndex = new Map(displayEntries.map((entry) => [entry.index, entry]));
    const userByKey = new Map(
      messages
        .filter((message): message is Extract<AgentMessage, { type: 'user-message' }> => message.type === 'user-message')
        .flatMap((message) => message.key ? [[message.key, message] as const] : []),
    );
    for (let lineIndex = 0; lineIndex < records.length; lineIndex += 1) {
      const record = records[lineIndex];
      if (!record || record.role !== 'user') continue;
      const display = displayByIndex.get(lineIndex);
      const key = reasonixMessageKey(this.session.id, display?.index ?? lineIndex);
      const native = userByKey.get(key);
      this.reconcileDurableUser(
        record,
        display,
        native ? messages : [],
        canDemote
          && (display?.offset ?? -1) >= this.ownershipFence
          && (display?.index ?? -1) >= this.ownershipIndexFence,
        snapshot,
      );
      if (canDemote && this.demoted) return;
    }
  }

  protected override onHistoryRewrite(): void {
    super.onHistoryRewrite();
    this.claimedOffsets.clear();
    this.correlationInvalidated = true;
    this.ownershipFence = undefined;
    this.ownershipIndexFence = undefined;
    this.nextNativeIndex = undefined;
    this.activeAssistantIndex = undefined;
    this.activeIdentityAmbiguous = false;
    this.awaitingAssistantIndexes.clear();
    this.terminalAssistantIndexes.clear();
    this.assistantStreamIndexes.clear();
    this.durableRebaseAfterIndex = undefined;
    this.demote('Reasonix transcript history was rewritten outside this connection.');
  }

  protected override async publishInitialSnapshot(read: ReasonixTranscriptRead): Promise<boolean | undefined> {
    if (!this.publishCreatedInitialSnapshot && !this.pendingCreate && !this.materializingCreate) return false;
    const pendingFirstPrompt = this.pendingPrompts.find((entry) => entry.materializesCreate);
    if (pendingFirstPrompt) {
      const durableUsers = read.records.filter((record) => record.role === 'user');
      // Reasonix may persist a stable system-only snapshot before its first
      // prompt finishes. Do not release the bounded probe or advance Observe's
      // initial cursor until this SAME stable prefix contains the owned echo.
      if (durableUsers.length === 0) return undefined;
      if (!durableUsers.some((record) => isReasonixDurablePromptEcho(
        typeof record.raw_content === 'string' ? record.raw_content
          : typeof record.content === 'string' ? record.content
            : undefined,
        pendingFirstPrompt.text,
      ))) {
        this.demote('Reasonix created-session transcript materialized with a foreign first user write.');
        return false;
      }
    }
    try {
      await this.materializeCreatedSession();
      const publish = !this.demoted && !this.closedDrive;
      if (publish) this.publishCreatedInitialSnapshot = false;
      return publish;
    } catch (error) {
      this.demote(`Reasonix created-session materialization failed: ${error instanceof Error ? error.message : String(error)}.`);
      return false;
    }
  }

  /**
   * Preferred order: the ACP turn has already returned when the tail appends
   * its closing row, so `running` is emitted immediately before that row's own
   * `done` and no terminal is sent twice. Replay, the created session's
   * initial snapshot, and catch-up never reach this hook.
   */
  protected override appendedRecordPrefix(
    lineIndex: number,
    _display: ReasonixDisplayEntry | undefined,
    messages: readonly AgentMessage[],
    snapshot: StableReasonixSnapshot,
  ): readonly AgentMessage[] {
    if (this.demoted || this.closedDrive || this.drivenTurns.size === 0) return [];
    const terminal = messages.find((message): message is RunSummary =>
      message.type === 'run-summary' && message.status === 'done');
    if (!terminal) return [];
    for (const [key, turn] of this.drivenTurns) {
      if (!turn.resolved || turn.userIndex === undefined || turn.userIndex >= lineIndex) continue;
      const closing = drivenTurnClosing(this.session.id, snapshot.read, turn.userIndex);
      if (closing.state !== 'found' || closing.lineIndex !== lineIndex) continue;
      this.drivenTurns.delete(key);
      return [runningFor(terminal)];
    }
    return [];
  }

  protected override afterTailPublish(read: ReasonixTranscriptRead): void {
    this.pairPublishedDrivenTurns(read);
  }

  private trackDrivenTurn(key: string): void {
    this.drivenTurns.delete(key);
    this.drivenTurns.set(key, { resolved: false });
    while (this.drivenTurns.size > MAX_PENDING_PROMPTS) {
      const oldest = this.drivenTurns.keys().next().value;
      if (oldest === undefined) break;
      this.drivenTurns.delete(oldest);
    }
  }

  /** A user Stop is not a finished turn: `cancelled` clears the observation and must not notify. */
  private resolveDrivenTurn(key: string, stopReason: string | undefined, read: ReasonixTranscriptRead): void {
    const turn = this.drivenTurns.get(key);
    if (!turn) return;
    if (this.demoted || this.closedDrive || stopReason === 'cancelled') {
      this.drivenTurns.delete(key);
      return;
    }
    turn.resolved = true;
    this.pairPublishedDrivenTurns(read);
  }

  /**
   * Fallback order: the tail (or the created session's initial snapshot) had
   * already published the closing row before the turn was both resolved and
   * claimed. That row's `done` went out with no observation to close, so it
   * was silent; re-send the same frame, unchanged, right after `running`.
   * History and the transcript key the footer identically either way.
   */
  private pairPublishedDrivenTurns(read: ReasonixTranscriptRead): void {
    if (this.demoted || this.closedDrive) return;
    for (const [key, turn] of [...this.drivenTurns]) {
      if (!turn.resolved || turn.userIndex === undefined) continue;
      const closing = drivenTurnClosing(this.session.id, read, turn.userIndex);
      if (closing.state === 'sealed') {
        // The turn wrote no footer (a refusal or an error before any model
        // output) and the next turn has begun: nothing can close it.
        this.drivenTurns.delete(key);
        continue;
      }
      if (closing.state !== 'found' || !this.tailHasPublished(closing.lineIndex)) continue;
      this.drivenTurns.delete(key);
      this.emitLive(runningFor(closing.summary));
      this.emitLive(closing.summary);
    }
  }

  protected override ownsLiveWriter(): boolean {
    // A native turn we started IS us writing, whether or not its assistant index is known yet.
    // Without the in-flight count, the first post-create turn read its own `working` posture — and
    // every working posture is `driveEligible: false` (`store.ts:408`) — as another writer, then
    // demoted and force-killed its own ACP child mid-turn.
    return this.awaitingAssistantIndexes.size > 0 || this.inFlightNativeTurns > 0;
  }

  protected override onNativePosture(
    posture: Awaited<ReturnType<typeof readReasonixAcpPosture>>,
  ): boolean {
    if (!posture || posture.driveEligible || this.ownsLiveWriter()) return true;
    this.demote('Reasonix native metadata reports another active writer.');
    return false;
  }

  protected override acceptsNativeMode(mode: ReasonixApprovalMode): boolean {
    return !this.driving || this.info.currentMode === undefined || this.info.currentMode === mode;
  }

  private reconcileDurableUser(
    record: ReasonixTranscriptRecord,
    display: ReasonixDisplayEntry | undefined,
    messages: readonly AgentMessage[],
    foreignIfUnclaimed: boolean,
    snapshot?: StableReasonixSnapshot,
  ): void {
    if (record.role !== 'user') return;
    const text = typeof record.raw_content === 'string' ? record.raw_content
      : typeof record.content === 'string' ? record.content
        : undefined;
    const offset = display?.offset;
    const nativeKey = reasonixMessageKey(this.session.id, display?.index ?? 0);
    const existing = offset === undefined ? undefined : this.claimedOffsets.get(offset);
    if (existing) {
      if (existing.displayIndex !== display?.index || existing.text !== text) {
        this.demote('Reasonix reused a claimed display offset for different transcript content.');
        return;
      }
      this.applyCorrelation(messages, existing, nativeKey);
      this.rememberSharedCorrelation(display, existing.text, existing, snapshot);
      return;
    }
    const matchIndex = this.pendingPrompts.findIndex((entry) => isReasonixDurablePromptEcho(text, entry.text)
      && offset !== undefined
      && offset >= entry.byteFence
      && (entry.materializesCreate && entry.userIndex === undefined
        ? display?.index !== undefined
        : entry.userIndex !== undefined && display?.index === entry.userIndex));
    if (matchIndex < 0) {
      // Deferring here is NOT safe and was tried: a row at the frontier of an
      // in-flight admission is exactly where a competing writer collides, so
      // failing closed is the point. Both a broad "any unreserved prompt
      // defers" and a narrow "only at that admission's own byte fence" hung the
      // drive suite, which asserts precisely that collision. Left as it is on
      // purpose; the diagnostic below is what changed.
      if (foreignIfUnclaimed) {
        // Say WHICH conjunct failed. "Received a foreign user write" with no
        // detail is unactionable for an owner and unreachable for a successor:
        // the row is matched on text echo AND byte fence AND predicted display
        // index, and those three want completely different fixes. Report the
        // row's position and how far each pending prompt got -- never its text,
        // which is user content.
        const attempts = this.pendingPrompts.map((entry) => {
          // Shape only, never content: how long each side is, and how far they
          // agree. `isReasonixDurablePromptEcho` is exact apart from one
          // trailing newline on purpose -- broader trimming could claim a
          // foreign write -- so when it says false the useful question is
          // whether the texts differ by a newline, a prefix, or entirely.
          let shared = 0;
          if (text) while (shared < text.length && shared < entry.text.length
            && text[shared] === entry.text[shared]) shared += 1;
          return [
            `echo=${isReasonixDurablePromptEcho(text, entry.text)}`,
            `text(native=${text?.length ?? 'none'} sent=${entry.text.length} sharedPrefix=${shared})`,
            `fence=${offset !== undefined && offset >= entry.byteFence} (${offset ?? 'none'}>=${entry.byteFence})`,
            `index=${entry.userIndex !== undefined && display?.index === entry.userIndex} (${display?.index ?? 'none'}==${entry.userIndex ?? 'unreserved'})`,
          ].join(' ');
        });
        this.demote(
          'Reasonix transcript received a foreign user write'
          + ` at display index ${display?.index ?? 'unknown'}, offset ${offset ?? 'unknown'},`
          + ` against ownership fence ${this.ownershipFence ?? 'unset'}`
          + ` / index fence ${this.ownershipIndexFence ?? 'unset'}`
          + (attempts.length === 0
            ? ' with no prompt pending from this connection.'
            : ` and ${attempts.length} pending prompt(s): ${attempts.join(' | ')}.`),
        );
      }
      return;
    }
    const [pending] = this.pendingPrompts.splice(matchIndex, 1);
    if (pending) {
      if (pending.userIndex === undefined && display?.index !== undefined) {
        pending.userIndex = display.index;
        pending.assistantIndex = display.index + 1;
        this.nextNativeIndex = Math.max(this.nextNativeIndex ?? 0, display.index + 2);
      }
      // The claimed echo is the proof that this row, and the turn it opens, is ours.
      const drivenTurn = this.drivenTurns.get(pending.key);
      if (drivenTurn && display) drivenTurn.userIndex = display.index;
      const correlation = {
        key: pending.key,
        displayIndex: display!.index,
        text: text!,
        ...(pending.clientKey ? { clientKey: pending.clientKey } : {}),
      };
      if (offset !== undefined) this.claimedOffsets.set(offset, correlation);
      this.applyCorrelation(messages, correlation, nativeKey);
      this.rememberSharedCorrelation(display, text!, correlation, snapshot);
    }
  }

  private rememberSharedCorrelation(
    display: ReasonixDisplayEntry | undefined,
    text: string,
    correlation: { key: string; clientKey?: string },
    snapshot: StableReasonixSnapshot | undefined,
  ): void {
    if (this.demoted || this.correlationInvalidated
        || !display || !snapshot || !this.correlationRegistry) return;
    this.correlationRegistry.remember(
      this.session.id,
      snapshot.read,
      snapshot.identity,
      display,
      text,
      correlation,
    );
  }

  private applyCorrelation(
    messages: readonly AgentMessage[],
    correlation: { key: string; clientKey?: string },
    nativeKey?: string,
  ): void {
    const native = messages.find((message) => message.type === 'user-message'
      && (nativeKey === undefined || message.key === nativeKey));
    if (native?.type !== 'user-message') return;
    const previousKey = native.key;
    native.key = correlation.key;
    native.queued = false;
    if (correlation.clientKey) native.clientKey = correlation.clientKey;
    if (previousKey) {
      for (const message of messages) {
        if (message.type === 'run-summary' && message.userMessageKey === previousKey) {
          message.userMessageKey = correlation.key;
        }
      }
    }
  }

  private emitLive(message: AgentMessage): void {
    for (const handler of this.liveHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.trace?.({
          op: 'observe',
          detail: `live subscriber threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  private settleInteractiveRequests(decision: PermissionDecision | 'external'): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.emitLive({ type: 'permission-resolved', requestId, decision });
    }
    this.pendingPermissions.clear();
    for (const [requestId, pending] of this.pendingQuestions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.emitLive({ type: 'question-resolved', requestId });
    }
    this.pendingQuestions.clear();
  }

  protected acceptUpdate(params: AcpSessionUpdateParams): void {
    if (this.closedDrive || this.demoted || params.sessionId !== this.session.id || !params.update) return;
    const commands = reasonixAvailableCommands(params.update);
    if (commands) {
      this.availableCommands = commands;
      return;
    }
    const assistantIndex = this.activeAssistantIndex;
    const messages = mapReasonixSessionUpdate(
      params.update,
      `reasonix-tool:${++this.sequence}`,
      assistantIndex === undefined || this.activeIdentityAmbiguous
        ? undefined
        : { sessionId: this.session.id, assistantIndex },
    );
    if (assistantIndex !== undefined
      && messages.some((message) => message.type === 'model-output' || message.type === 'thinking')) {
      this.assistantStreamIndexes.add(assistantIndex);
    }
    for (const message of messages) {
      // A newly created session has no durable display index until Reasonix
      // persists its first prompt. Publishing an unkeyed live assistant chunk
      // here makes the later keyed transcript row a second visible message.
      // Keep non-assistant control/tool events live, but let the authoritative
      // initial snapshot publish assistant text once its identity is known.
      if (this.suppressAssistantStreaming
        && (message.type === 'model-output' || message.type === 'thinking')) continue;
      this.emitLive(message);
    }
    // The measured flat store can insert a tool row followed by another
    // assistant row. Without a captured stream-to-file boundary, later ACP
    // deltas must remain live-only instead of claiming the first assistant key.
    if (params.update.sessionUpdate === 'tool_call') {
      this.activeIdentityAmbiguous = true;
      if (assistantIndex !== undefined) this.durableRebaseAfterIndex = assistantIndex;
    }
  }

  private async reservePromptIndex(): Promise<number | undefined> {
    if (this.pendingCreate) {
      if (this.nextNativeIndex !== undefined) {
        throw new Error('Reasonix pending create admitted more than one prompt before durable identity materialized.');
      }
      return undefined;
    }
    const read = await this.inspectHistoryForDrive();
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      throw new Error('Reasonix Drive lost ownership during prompt admission.');
    }
    const indexes = new Set(read.displayEntries.map((entry) => entry.index));
    const complete = read.issues.length === 0
      && read.displayEntries.length === read.records.length
      && indexes.size === read.records.length
      && read.records.every((_record, index) => indexes.has(index))
      && read.displayEntries.every((entry) => entry.offset + entry.length <= read.byteLength);
    if (!complete) {
      throw new Error('Reasonix Drive requires a complete supported display index before admitting a prompt.');
    }
    this.settleTerminalSnapshot(read);
    if (this.durableRebaseAfterIndex !== undefined) {
      throw new Error('Reasonix Drive is waiting for the prior tool turn to publish its final durable assistant row.');
    }
    const observedNext = read.displayEntries.reduce(
      (highest, entry) => Math.max(highest, entry.index + 1),
      0,
    );
    // A normal ACP turn can resolve before its transcript sidecars become
    // visible. Preserve the speculative ledger for unresolved completed
    // prompts; only a history rewrite clears it. Ambiguous cancellation
    // demotes above instead of guessing whether an index can be reused.
    const userIndex = Math.max(this.nextNativeIndex ?? 0, observedNext);
    this.nextNativeIndex = userIndex + 2;
    return userIndex;
  }

  private async assertFreshDriveEligibility(): Promise<void> {
    if (this.pendingCreate) {
      if (!await this.pendingCreate.discover()) return;
      this.demote('Reasonix durable state appeared before the pending created owner sent its first prompt.');
      throw new Error('Reasonix pending create lost exclusive ownership before native prompt delivery.');
    }
    const posture = await readReasonixAcpPosture(this.session);
    if (posture?.driveEligible) return;
    this.demote('Reasonix native metadata no longer proves this session idle.');
    throw new Error('Reasonix Drive lost idle ownership before native prompt delivery.');
  }

  private async requireDurableMode(expected: ReasonixApprovalMode): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const posture = await readReasonixAcpPosture(this.session);
      if (posture?.currentMode === expected) return;
      if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Reasonix did not durably persist permission mode ${expected}.`);
  }

  private async materializeCreatedSession(): Promise<void> {
    const pending = this.pendingCreate;
    if (!pending) return;
    if (this.materializingCreate) return this.materializingCreate;
    const materializing = this.finishCreatedSessionMaterialization(pending);
    this.materializingCreate = materializing;
    try {
      await materializing;
    } finally {
      if (this.materializingCreate === materializing) this.materializingCreate = undefined;
    }
  }

  /**
   * fs.watch is only a wake-up hint and can miss the transition from an
   * inbox-only create to its first transcript. While that first native prompt
   * owns the child, probe for the durable row for a bounded interval and route
   * success through Observe's serialized drain. No timer survives ownership.
   */
  private startPendingCreateProbe(): void {
    if (!this.pendingCreate || this.pendingCreateProbeTimer || this.pendingCreateProbeDeadline > 0) return;
    this.pendingCreateProbeDeadline = Date.now() + PENDING_CREATE_PROBE_DEADLINE_MS;

    const schedule = (): void => {
      this.pendingCreateProbeTimer = setTimeout(() => void tick(), PENDING_CREATE_PROBE_INTERVAL_MS);
      this.pendingCreateProbeTimer.unref?.();
    };
    const tick = async (): Promise<void> => {
      this.pendingCreateProbeTimer = undefined;
      const pending = this.pendingCreate;
      if (!pending || this.closedDrive || this.demoted) {
        this.stopPendingCreateProbe();
        return;
      }
      if (Date.now() >= this.pendingCreateProbeDeadline) {
        this.trace?.({
          op: 'observe',
          detail: `Reasonix first-prompt materialization probe expired after ${PENDING_CREATE_PROBE_DEADLINE_MS}ms.`,
        });
        this.stopPendingCreateProbe();
        return;
      }
      try {
        // Do not enter the initial-snapshot drain until discovery can see a
        // candidate. This avoids treating an ordinary multi-second first
        // persistence as an identity failure.
        if (await pending.discover()) await this.refreshFromStore();
      } catch (error) {
        this.trace?.({
          op: 'observe',
          detail: `Reasonix first-prompt materialization probe failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!this.pendingCreate || this.closedDrive || this.demoted) {
        this.stopPendingCreateProbe();
        return;
      }
      schedule();
    };
    schedule();
  }

  private stopPendingCreateProbe(): void {
    if (this.pendingCreateProbeTimer) clearTimeout(this.pendingCreateProbeTimer);
    this.pendingCreateProbeTimer = undefined;
    this.pendingCreateProbeDeadline = 0;
  }

  private async finishCreatedSessionMaterialization(
    pending: NonNullable<ReasonixDriveOpenOptions['pendingCreate']>,
  ): Promise<void> {
    let durable: ReasonixStoredSession | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = await pending.discover();
      if (candidate) {
        durable = candidate;
        const identityMismatch = candidate.id !== this.session.id
          || candidate.cwd !== pending.cwd
          || (pending.model !== undefined && candidate.model !== pending.model)
          || (pending.permissionMode !== undefined && candidate.currentMode !== pending.permissionMode)
          || candidate.transcriptPath !== this.session.transcriptPath;
        if (identityMismatch || candidate.driveEligible) break;
      }
      if (attempt + 1 < 40) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!durable) {
      throw new Error(`Reasonix created ${this.session.id}, but the first prompt did not materialize a supported durable row.`);
    }
    const mismatch = durable.id !== this.session.id
      || durable.cwd !== pending.cwd
      || (pending.model !== undefined && durable.model !== pending.model)
      || (pending.permissionMode !== undefined && durable.currentMode !== pending.permissionMode)
      || durable.transcriptPath !== this.session.transcriptPath
      || !durable.driveEligible;
    if (mismatch) {
      throw new Error(
        `Reasonix durable identity mismatch after create: expected id=${this.session.id} cwd=${pending.cwd}`
          + `${pending.model === undefined ? '' : ` model=${pending.model}`}; received id=${durable.id}`
          + `${pending.permissionMode === undefined ? '' : ` mode=${pending.permissionMode}`}`
          + ` cwd=${String(durable.cwd)} model=${String(durable.model)} mode=${String(durable.currentMode)}`
          + ` path=${durable.transcriptPath} driveEligible=${String(durable.driveEligible)}.`,
      );
    }
    Object.assign(this.session, durable);
    this.info.cwd = durable.cwd;
    this.info.title = durable.title;
    this.info.status = durable.status;
    if (durable.model) this.info.model = durable.model;
    if (durable.currentModel) this.info.currentModel = { ...durable.currentModel };
    if (durable.currentMode) this.info.currentMode = durable.currentMode;
    this.pendingCreate = undefined;
    this.stopPendingCreateProbe();
    pending.onMaterialized?.(this, durable);
  }

  private settleTerminalSnapshot(
    read: Awaited<ReturnType<ReasonixObserveConnection['inspectHistoryForDrive']>>,
    admitted?: PendingPrompt,
    deferIdle = false,
  ): boolean {
    let admittedDurable = false;
    const displayByIndex = new Map(read.displayEntries.map((entry) => [entry.index, entry]));
    this.settleDurableToolRebase(read, displayByIndex);
    for (const assistantIndex of [...this.terminalAssistantIndexes]) {
      const userIndex = assistantIndex - 1;
      const user = read.records[userIndex];
      const userDisplay = displayByIndex.get(userIndex);
      const durableText = user?.role === 'user'
        ? typeof user.raw_content === 'string' ? user.raw_content
          : typeof user.content === 'string' ? user.content
            : undefined
        : undefined;
      const expectedText = admitted?.assistantIndex === assistantIndex ? admitted.text : undefined;
      const userDurable = read.issues.length === 0
        && userDisplay?.index === userIndex
        && user?.role === 'user'
        && (expectedText === undefined || isReasonixDurablePromptEcho(durableText, expectedText));
      if (!userDurable) continue;
      if (admitted?.assistantIndex === assistantIndex) admittedDurable = true;
      const assistant = read.records[assistantIndex];
      const assistantDisplay = displayByIndex.get(assistantIndex);
      if (assistant?.role === 'assistant' && assistantDisplay?.index === assistantIndex) {
        this.awaitingAssistantIndexes.delete(assistantIndex);
        this.terminalAssistantIndexes.delete(assistantIndex);
        this.assistantStreamIndexes.delete(assistantIndex);
        continue;
      }
      if (this.assistantStreamIndexes.has(assistantIndex)) continue;
      this.awaitingAssistantIndexes.delete(assistantIndex);
      this.terminalAssistantIndexes.delete(assistantIndex);
      this.assistantStreamIndexes.delete(assistantIndex);
      this.nextNativeIndex = read.displayEntries.reduce(
        (highest, entry) => Math.max(highest, entry.index + 1),
        0,
      );
    }
    if (!deferIdle) this.maybeEmitDeferredIdle();
    return admittedDurable;
  }

  private settleDurableToolRebase(
    read: Awaited<ReturnType<ReasonixObserveConnection['inspectHistoryForDrive']>>,
    displayByIndex: ReadonlyMap<number, ReasonixDisplayEntry>,
  ): void {
    const floor = this.durableRebaseAfterIndex;
    if (floor === undefined || read.issues.length > 0) return;
    let lastLineIndex = -1;
    let lastDisplayIndex = -1;
    for (let lineIndex = 0; lineIndex < read.records.length; lineIndex += 1) {
      const display = displayByIndex.get(lineIndex);
      if (display && display.index > lastDisplayIndex) {
        lastLineIndex = lineIndex;
        lastDisplayIndex = display.index;
      }
    }
    if (lastDisplayIndex <= floor || read.records[lastLineIndex]?.role !== 'assistant') return;
    this.durableRebaseAfterIndex = undefined;
    this.nextNativeIndex = lastDisplayIndex + 1;
  }

  private maybeEmitDeferredIdle(): void {
    if (!this.deferredNativeIdle || this.awaitingAssistantIndexes.size > 0 || this.demoted || this.closedDrive) return;
    this.deferredNativeIdle = false;
    this.emitLive({ type: 'status', status: 'idle' });
  }

  protected requestPermission(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    if (this.closedDrive || this.demoted || !this.transport.alive) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (params.sessionId !== this.session.id) {
      this.trace?.({ op: 'observe', detail: `permission request refused for foreign session ${String(params.sessionId)}` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const rawNativeId = typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : undefined;
    const nativeId = rawNativeId && rawNativeId.length <= MAX_PERMISSION_FIELD_CHARS ? rawNativeId : undefined;
    const requestId = nativeId ?? `reasonix-permission:${++this.sequence}`;
    if (this.pendingPermissions.has(requestId) || this.pendingQuestions.has(requestId)) {
      this.trace?.({ op: 'observe', detail: `duplicate permission request ${requestId} refused` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (this.pendingPermissions.size + this.pendingQuestions.size >= MAX_PENDING_PERMISSIONS) {
      this.trace?.({ op: 'observe', detail: `permission request refused at ${MAX_PENDING_PERMISSIONS}-request cap` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const title = typeof params.toolCall?.title === 'string'
      ? params.toolCall.title.slice(0, MAX_PERMISSION_FIELD_CHARS)
      : 'Reasonix requests permission';
    const options = params.options ?? [];
    const optionIds = permissionDecisionMap(options);
    if (!optionIds) {
      this.trace?.({ op: 'observe', detail: `permission request ${requestId} has no supported native options; cancelled` });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const canonicalOptions = [...optionIds.keys()];
    const detail = boundedDetail(params.toolCall?.rawInput);
    return new Promise((resolve) => {
      const message: AgentMessage = {
        type: 'permission-request',
        requestId,
        title,
        toolName: title,
        ...(detail ? { detail } : {}),
        ...(canonicalOptions.length ? { options: canonicalOptions } : {}),
      };
      this.pendingPermissions.set(requestId, { message, optionIds, resolve });
      this.emitLive(message);
    });
  }

  protected acceptStatusExtension(event: { method: string; params: unknown }): void {
    if (this.closedDrive || this.demoted
      || event.method !== '_reasonix.io/session/status_update'
      || typeof event.params !== 'object'
      || event.params === null
      || (event.params as { sessionId?: unknown }).sessionId !== this.session.id) return;
    const params = event.params as { sequence?: unknown; status?: unknown };
    const sequence = params.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) <= this.lastStatusSequence) return;
    const status = params.status;
    if (typeof status !== 'object' || status === null) return;
    const nativeStatus = status as { state?: unknown; cumulative?: unknown };
    const state = nativeStatus.state;
    if (state !== 'running' && state !== 'idle') return;
    this.lastStatusSequence = sequence as number;
    const usage = reasonixSessionUsage(nativeStatus.cumulative);
    if (usage) this.recordSessionUsage(usage);
    if (state === 'running') this.emitLive({ type: 'status', status: 'running' });
    if (state === 'idle') {
      if (this.awaitingAssistantIndexes.size > 0) this.deferredNativeIdle = true;
      else this.emitLive({ type: 'status', status: 'idle' });
    }
  }
}
