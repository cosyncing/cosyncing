import { randomBytes } from 'node:crypto';
import type {
  AgentMessage,
  AgentMessageHandler,
  HistoryQuery,
  HistorySourceIdentity,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionControlState,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';
import { mapOpenCodePart } from './mapping.ts';

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const MAX_LOCAL_PROMPT_CLAIMS = 128;
const MAX_LIVE_USER_IDENTITIES = 256;
const PROMPT_REQUEST_TIMEOUT_MS = 30_000;
const MUTATION_REQUEST_TIMEOUT_MS = 8_000;
const OC_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let ocIdLastMs = 0;
let ocIdCounter = 0;

export interface OpenCodeLiveRequestContext {
  baseUrl: string;
  sessionId: string;
  directory?: string;
  fetch: typeof globalThis.fetch;
  /** Optional owner lifecycle for attach-time reads such as pending permissions. */
  signal?: AbortSignal;
}

export interface OpenCodeLivePermissionDialect {
  loadPending(context: OpenCodeLiveRequestContext): Promise<AgentMessage[]>;
  mapEvent(event: unknown, sessionId: string): AgentMessage | undefined;
  respond(
    context: OpenCodeLiveRequestContext,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
}

export class OpenCodeLiveMutationAmbiguousError extends Error {}

export interface OpenCodeLiveDialect {
  productId: string;
  displayName: string;
  permissions?: OpenCodeLivePermissionDialect;
}

export interface OpenCodeLiveOwnershipHooks {
  beforeMutation(action: 'prompt' | 'permission' | 'cancel'): Promise<void>;
  promptClaimed(nativeId: string, clientKey?: string): void;
  promptRejected(nativeId: string): void;
  reconcileHistory(nativeUserIds: readonly string[]): void;
  sessionSettled(): void | Promise<void>;
  onUnavailable(reason: string): void;
  onClose(status: SessionInfo['status']): void;
}

export interface OpenCodeLiveConnectionOptions {
  baseUrl: string;
  info: SessionInfo;
  dialect: OpenCodeLiveDialect;
  sseIdleMs?: number;
  sseReconnectMs?: number;
  loadModels?: (current?: SessionInfo['currentModel']) => Promise<ModelOption[]>;
  /** Kilo create cannot persist a model, so its prompt route must receive the current selection. */
  sendCurrentModelOnPrompt?: boolean;
  onModelObserved?: (model: NonNullable<SessionInfo['currentModel']>) => void;
  loadStatus?: (context: OpenCodeLiveRequestContext) => Promise<SessionInfo['status'] | undefined>;
  disconnectedControl?: (reason: string) => SessionControlState;
  fetch?: typeof globalThis.fetch;
  trace?: (detail: string) => void;
  ownership?: OpenCodeLiveOwnershipHooks;
}

interface LocalPromptClaim {
  generation: number;
  clientKey?: string;
}

interface PendingLiveUserPart {
  partId: string;
  nativeId: string;
  text: string;
  clientKey?: string;
}

function requestContext(
  baseUrl: string,
  info: SessionInfo,
  fetcher: typeof globalThis.fetch,
): OpenCodeLiveRequestContext {
  return {
    baseUrl,
    sessionId: info.id,
    ...(info.cwd ? { directory: info.cwd } : {}),
    fetch: fetcher,
  };
}

function directoryQuery(directory?: string): string {
  return directory ? `?directory=${encodeURIComponent(directory)}` : '';
}

function nativeTime(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function nativeModel(value: any): NonNullable<SessionInfo['currentModel']> | undefined {
  const nested = value?.model && typeof value.model === 'object' ? value.model : undefined;
  const providerID = nested?.providerID ?? value?.providerID;
  const modelID = nested?.id ?? nested?.modelID ?? value?.modelID;
  if (typeof providerID !== 'string' || typeof modelID !== 'string'
    || !providerID || !modelID || providerID.length > 512 || modelID.length > 512) return undefined;
  const variant = nested?.variant ?? value?.variant;
  return {
    providerID,
    modelID,
    ...(typeof variant === 'string' && variant && variant.length <= 512 ? { variant } : {}),
  };
}

/** Match OpenCode's ascending `Identifier.ascending('message')` wire format. */
function messageId(): string {
  const now = Date.now();
  if (now !== ocIdLastMs) {
    ocIdLastMs = now;
    ocIdCounter = 0;
  }
  ocIdCounter += 1;
  const value = BigInt(now) * 4096n + BigInt(ocIdCounter);
  const time = Buffer.alloc(6);
  for (let index = 0; index < 6; index += 1) {
    time[index] = Number((value >> BigInt(40 - 8 * index)) & 0xffn);
  }
  const random = randomBytes(14);
  let suffix = '';
  for (let index = 0; index < random.length; index += 1) {
    suffix += OC_ID_ALPHABET[random[index]! % OC_ID_ALPHABET.length];
  }
  return `msg_${time.toString('hex')}${suffix}`;
}

function textOf(parts: readonly any[]): string {
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n');
}

function tokensOf(info: any): AgentMessage | undefined {
  const tokens = info?.tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const message: AgentMessage = {
    type: 'token-count',
    ...(Number.isFinite(tokens.input) ? { input: Number(tokens.input) } : {}),
    ...(Number.isFinite(tokens.output) ? { output: Number(tokens.output) } : {}),
    ...(Number.isFinite(tokens.cache?.read) ? { cacheRead: Number(tokens.cache.read) } : {}),
    ...(Number.isFinite(tokens.cache?.write) ? { cacheWrite: Number(tokens.cache.write) } : {}),
    ...(Number.isFinite(info?.cost) ? { cost: Number(info.cost) } : {}),
  };
  return Object.keys(message).length > 1 ? message : undefined;
}

function providerErrorMessage(error: any): string {
  return String(error?.data?.message ?? error?.message ?? 'Turn failed')
    .split(/\r?\n/u)[0]!
    .slice(0, 200);
}

function summaryOf(info: any, productId: string): AgentMessage | undefined {
  if (!info?.id || info?.role !== 'assistant') return undefined;
  const startedAt = nativeTime(info?.time?.created);
  const completedAt = nativeTime(info?.time?.completed);
  const error = info?.error != null;
  const cancelled = /abort|cancel|interrupt/iu.test(String(info?.finish ?? info?.error?.name ?? ''));
  const status = cancelled ? 'cancelled' : error ? 'error' : completedAt ? 'done' : 'running';
  return {
    type: 'run-summary',
    key: `${productId}:run:${String(info.id)}`,
    turnId: String(info.id),
    ...(info.parentID ? { userMessageKey: String(info.parentID) } : {}),
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(startedAt && completedAt && completedAt >= startedAt
      ? { totalRuntimeMs: completedAt - startedAt }
      : {}),
    source: productId,
  };
}

/** Provider-neutral live HTTP/SSE session connection for OpenCode-lineage servers. */
export class OpenCodeLiveConnection implements SessionConnection {
  readonly info: SessionInfo;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly abort = new AbortController();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly context: OpenCodeLiveRequestContext;
  private readonly roles = new Map<string, string>();
  private readonly partTypes = new Map<string, string>();
  private readonly streamingParts = new Set<string>();
  /** Native message ids reserved by this connection before prompt_async starts. */
  private readonly localPromptClaims = new Map<string, LocalPromptClaim>();
  /** Native creation times make live user rows stable with durable replay. */
  private readonly nativeUserCreatedAt = new Map<string, number>();
  /** A part can precede its message.updated envelope on the SSE stream. */
  private readonly pendingLiveUserParts = new Map<string, PendingLiveUserPart>();
  private readonly emittedLiveUserParts = new Set<string>();
  private readonly pendingRequestIds = new Set<string>();
  private closed = false;
  private unavailable = false;
  private promptReserved = false;
  private eventRevision = 0;
  private nativeModelGeneration = 0;
  /** Invalidated whenever native activity proves that this connection no longer owns writes. */
  private ownershipGeneration = 0;

  constructor(private readonly options: OpenCodeLiveConnectionOptions) {
    this.info = options.info;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.context = requestContext(options.baseUrl.replace(/\/$/u, ''), this.info, this.fetcher);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  start(): void {
    void this.loop();
    void this.seedLiveState();
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(message: AgentMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  private url(path: string): string {
    return `${this.context.baseUrl}${path}`;
  }

  private dirq(): string {
    return directoryQuery(this.context.directory);
  }

  async getHistory(query?: HistoryQuery): Promise<AgentMessage[]> {
    const modelGenerationAtStart = this.nativeModelGeneration;
    const historySignal = query?.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000);
    const response = await this.fetcher(
      this.url(`/session/${encodeURIComponent(this.info.id)}/message${this.dirq()}`),
      { signal: historySignal },
    );
    if (!response.ok) {
      throw new Error(`${this.options.dialect.displayName} history request failed with HTTP ${response.status}.`);
    }
    const raw = await response.json();
    if (!Array.isArray(raw)) {
      throw new Error(`${this.options.dialect.displayName} history response was not an array.`);
    }
    const out: AgentMessage[] = [];
    const nativeUserIds: string[] = [];
    let historyModel: NonNullable<SessionInfo['currentModel']> | undefined;
    for (const row of raw) {
      const info = row?.info ?? {};
      historyModel = nativeModel(info) ?? historyModel;
      const id = typeof info.id === 'string' ? info.id : undefined;
      if (id) this.roles.set(id, String(info.role ?? ''));
      if (id && info?.role === 'user') {
        const createdAt = nativeTime(info?.time?.created);
        if (createdAt) this.rememberNativeUserTime(id, createdAt);
        this.flushPendingLiveUserParts(id);
      }
      if (info.role === 'user') {
        if (id) nativeUserIds.push(id);
        const text = textOf(Array.isArray(row?.parts) ? row.parts : []);
        if (text.trim()) {
          const clientKey = id ? this.currentLocalPromptClaim(id)?.clientKey : undefined;
          out.push({
            type: 'user-message',
            text,
            ...(id ? { key: id, turnId: id } : {}),
            ...(nativeTime(info?.time?.created) ? { sentAt: nativeTime(info.time.created) } : {}),
            ...(clientKey ? { clientKey } : {}),
          });
        }
      } else {
        for (const part of Array.isArray(row?.parts) ? row.parts : []) {
          out.push(...mapOpenCodePart(part, {
            historical: true,
            productId: this.options.dialect.productId,
          }));
        }
        const summary = summaryOf(info, this.options.dialect.productId);
        if (summary) out.push(summary);
        if (info?.error) {
          out.push({
            type: 'error',
            message: providerErrorMessage(info.error),
          });
        }
      }
      const tokens = tokensOf(info);
      if (tokens) out.push(tokens);
    }
    this.noteNativeModel(historyModel, 'history', modelGenerationAtStart);
    this.options.ownership?.reconcileHistory(nativeUserIds);
    if (this.options.dialect.permissions) {
      try {
        out.push(...await this.options.dialect.permissions.loadPending({
          ...this.context,
          ...(query?.signal ? { signal: query.signal } : {}),
        }));
      } catch (error) {
        // Permission hydration is an attach-time convenience, not part of the
        // durable transcript. A slow permission endpoint must not discard a
        // successfully loaded conversation or make the broker clear its cache.
        this.options.trace?.(
          `pending permission replay failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return out;
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity | undefined> {
    try {
      const response = await this.fetcher(
        this.url(`/session/${encodeURIComponent(this.info.id)}${this.dirq()}`),
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!response.ok) return undefined;
      const session = await response.json() as any;
      const updated = nativeTime(session?.time?.updated);
      const revert = String(session?.revert?.messageID ?? '');
      return {
        sourceId: `${this.options.dialect.productId}-http:${this.info.id}`,
        revision: JSON.stringify({ id: session?.id, updated: updated ?? null, revert }),
        ...(updated ? { appendPosition: updated } : {}),
        rewriteToken: revert,
      };
    } catch {
      return undefined;
    }
  }

  async getPending(): Promise<AgentMessage[]> {
    return this.options.dialect.permissions
      ? this.options.dialect.permissions.loadPending(this.context)
      : [];
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertWritable('prompt');
    await this.checkOwnershipBeforeMutation('prompt');
    this.assertWritable('prompt');
    if (input.files?.length) throw new Error(`${this.options.dialect.displayName} native file input is unavailable.`);
    if (this.promptReserved || this.info.status !== 'idle') {
      throw new Error(`${this.options.dialect.displayName} cannot accept another prompt while the session is ${this.info.status}.`);
    }
    this.promptReserved = true;
    this.eventRevision += 1;
    this.info.status = 'working';
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
    const body: Record<string, unknown> = {
      parts: [
        { type: 'text', text: input.text },
        ...(input.images ?? []).map((image) => ({
          type: 'file', mime: image.mimeType, filename: image.name ?? 'image',
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
    };
    const promptModel = input.model ?? (this.options.sendCurrentModelOnPrompt ? this.info.currentModel : undefined);
    if (promptModel) {
      body.model = { providerID: promptModel.providerID, modelID: promptModel.modelID };
      if (promptModel.variant) body.variant = promptModel.variant;
    }
    if (input.agent) body.agent = input.agent;
    const nativeId = messageId();
    const claimGeneration = this.ownershipGeneration;
    body.messageID = nativeId;
    this.localPromptClaims.set(nativeId, {
      generation: claimGeneration,
      ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}),
    });
    this.options.ownership?.promptClaimed(nativeId, input.clientMessageId);
    while (this.localPromptClaims.size > MAX_LOCAL_PROMPT_CLAIMS) {
      this.localPromptClaims.delete(this.localPromptClaims.keys().next().value!);
    }
    let response: Response;
    try {
      response = await this.fetcher(
        this.url(`/session/${encodeURIComponent(this.info.id)}/prompt_async${this.dirq()}`),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(PROMPT_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${this.options.dialect.displayName} prompt transport became ambiguous: ${detail}`;
      this.markUnavailable(message);
      throw new OpenCodeLiveMutationAmbiguousError(message, { cause: error });
    } finally {
      this.promptReserved = false;
    }
    if (!response.ok) {
      if (response.status >= 500) {
        const message = `${this.options.dialect.displayName} prompt may have been accepted before the server failed (${response.status}).`;
        this.markUnavailable(message);
        throw new OpenCodeLiveMutationAmbiguousError(message);
      }
      this.options.ownership?.promptRejected(nativeId);
      if (this.localPromptClaims.get(nativeId)?.generation === claimGeneration) {
        this.localPromptClaims.delete(nativeId);
      }
      this.info.status = 'idle';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
      if (response.status === 401 || response.status === 403) {
        this.markUnavailable(`${this.options.dialect.displayName} authentication was rejected; Drive was disabled.`);
      }
      throw new Error(`${this.options.dialect.displayName} prompt failed (${response.status}).`);
    }
  }

  async listModels(): Promise<ModelOption[]> {
    return this.options.loadModels?.(this.info.currentModel) ?? [];
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertWritable('permission response');
    await this.checkOwnershipBeforeMutation('permission');
    this.assertWritable('permission response');
    if (!this.options.dialect.permissions) {
      throw new Error(`${this.options.dialect.displayName} permission replies are unsupported.`);
    }
    this.eventRevision += 1;
    try {
      await this.options.dialect.permissions.respond(this.context, requestId, decision);
    } catch (error) {
      if (error instanceof OpenCodeLiveMutationAmbiguousError) {
        this.markUnavailable(error.message);
      }
      throw error;
    }
    this.pendingRequestIds.delete(requestId);
    this.emit({ type: 'permission-resolved', requestId, decision });
    this.info.status = 'working';
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'working' } });
  }

  async listCommands() {
    return [{ name: 'stop', description: 'Stop the running turn', kind: 'action' as const }];
  }

  async runCommand(name: string) {
    if (name !== 'stop' && name !== 'abort') throw new Error(`${this.options.dialect.displayName} does not support /${name}.`);
    this.assertWritable('cancel');
    await this.checkOwnershipBeforeMutation('cancel');
    this.assertWritable('cancel');
    let response: Response;
    try {
      response = await this.fetcher(
        this.url(`/session/${encodeURIComponent(this.info.id)}/abort${this.dirq()}`),
        { method: 'POST', signal: AbortSignal.timeout(MUTATION_REQUEST_TIMEOUT_MS) },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${this.options.dialect.displayName} cancel transport became ambiguous: ${detail}`;
      this.markUnavailable(message);
      throw new OpenCodeLiveMutationAmbiguousError(message, { cause: error });
    }
    if (!response.ok) {
      if (response.status >= 500) {
        const message = `${this.options.dialect.displayName} cancel may have been accepted before the server failed (${response.status}).`;
        this.markUnavailable(message);
        throw new OpenCodeLiveMutationAmbiguousError(message);
      }
      if (response.status === 401 || response.status === 403) {
        this.markUnavailable(`${this.options.dialect.displayName} authentication was rejected; Drive was disabled.`);
      }
      throw new Error(`${this.options.dialect.displayName} cancel failed (${response.status}).`);
    }
    return { notice: 'Stop requested.' };
  }

  private async seedLiveState(): Promise<void> {
    const revision = this.eventRevision;
    try {
      const [status, pending] = await Promise.all([
        this.options.loadStatus?.(this.context),
        this.options.dialect.permissions?.loadPending(this.context) ?? Promise.resolve([]),
      ]);
      if (revision !== this.eventRevision || this.closed || this.unavailable) return;
      const nextPendingIds = new Set(pending.flatMap((message) =>
        message.type === 'permission-request' || message.type === 'question-request'
          ? [message.requestId] : []));
      for (const requestId of this.pendingRequestIds) {
        if (!nextPendingIds.has(requestId)) {
          this.emit({ type: 'permission-resolved', requestId, decision: 'external' });
        }
      }
      this.pendingRequestIds.clear();
      for (const requestId of nextPendingIds) this.pendingRequestIds.add(requestId);
      for (const message of pending) this.emit(message);
      const next = pending.length > 0 ? 'needs-input' : status;
      if (!next) return;
      this.info.status = next;
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: next } });
    } catch (error) {
      this.options.trace?.(`live state seed failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loop(): Promise<void> {
    const reconnectMs = this.options.sseReconnectMs ?? 4_000;
    const idleMs = this.options.sseIdleMs ?? 30_000;
    let firstFailureAt = 0;
    while (!this.closed) {
      const streamAbort = new AbortController();
      const parentAbort = () => streamAbort.abort();
      this.abort.signal.addEventListener('abort', parentAbort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      let streamOpenedAt = 0;
      const resetIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => streamAbort.abort(), idleMs);
      };
      try {
        resetIdle();
        const openedAt = Date.now();
        const response = await this.fetcher(this.url('/global/event'), { signal: streamAbort.signal });
        if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
        streamOpenedAt = openedAt;
        if (!this.readySettled) {
          this.readySettled = true;
          this.resolveReady();
        }
        void this.seedLiveState();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error('SSE ended');
          resetIdle();
          buffer += decoder.decode(value, { stream: true });
          if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES) {
            throw new Error('SSE frame exceeded buffer limit');
          }
          let separator: number;
          while ((separator = buffer.search(/\r?\n\r?\n/u)) >= 0) {
            const frame = buffer.slice(0, separator);
            const match = buffer.slice(separator).match(/^\r?\n\r?\n/u)!;
            buffer = buffer.slice(separator + match[0].length);
            const data = frame.split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            try { this.handleEvent(JSON.parse(data)); } catch { this.options.trace?.('malformed SSE event'); }
          }
        }
      } catch (error) {
        if (this.closed || this.unavailable) return;
        if (streamOpenedAt && Date.now() - streamOpenedAt >= reconnectMs) firstFailureAt = 0;
        this.options.trace?.(`SSE reconnect: ${error instanceof Error ? error.message : String(error)}`);
        firstFailureAt ||= Date.now();
        if (Date.now() - firstFailureAt < reconnectMs && await this.sessionExists()) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, reconnectMs)));
          continue;
        }
        this.markUnavailable(`${this.options.dialect.displayName} live server disconnected.`);
        return;
      } finally {
        if (idle) clearTimeout(idle);
        this.abort.signal.removeEventListener('abort', parentAbort);
      }
    }
  }

  private async sessionExists(): Promise<boolean> {
    try {
      const response = await this.fetcher(
        this.url(`/session/${encodeURIComponent(this.info.id)}${this.dirq()}`),
        { signal: AbortSignal.timeout(1_500) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private handleEvent(raw: any): void {
    if (this.closed || this.unavailable) return;
    const event = raw?.payload ?? raw;
    const properties = event?.properties ?? {};
    const sessionId = properties.sessionID
      ?? properties.info?.sessionID
      ?? properties.info?.id
      ?? properties.id
      ?? properties.session?.id;
    if (sessionId === undefined || String(sessionId) !== this.info.id) return;
    this.eventRevision += 1;
    if (event?.type === 'message.updated') {
      const info = properties.info ?? properties.message ?? properties;
      this.noteNativeModel(nativeModel(info), 'live');
      const id = info?.id ? String(info.id) : undefined;
      if (this.options.ownership
        && info?.role === 'user'
        && (!id || !this.currentLocalPromptClaim(id))) {
        this.markUnavailable(
          `${this.options.dialect.displayName} detected a native user prompt from another writer; Drive was disabled.`,
        );
        return;
      }
      if (id) this.roles.set(id, String(info.role ?? ''));
      if (id && info?.role === 'user') {
        const createdAt = nativeTime(info?.time?.created);
        if (createdAt) this.rememberNativeUserTime(id, createdAt);
        this.flushPendingLiveUserParts(id);
      }
      const summary = summaryOf(info, this.options.dialect.productId);
      if (summary) this.emit(summary);
      const tokens = tokensOf(info);
      if (tokens) this.emit(tokens);
      if (info?.error) this.emit({ type: 'error', message: providerErrorMessage(info.error) });
      return;
    }
    if (event?.type === 'message.part.delta') {
      const partId = properties.partID;
      if (!partId || properties.delta == null || this.roles.get(String(properties.messageID)) === 'user') return;
      this.streamingParts.add(String(partId));
      const type = this.partTypes.get(String(partId)) ?? (properties.field === 'reasoning' ? 'reasoning' : 'text');
      this.emit(type === 'reasoning'
        ? { type: 'thinking', delta: String(properties.delta), key: String(partId) }
        : { type: 'model-output', delta: String(properties.delta), key: String(partId) });
      return;
    }
    if (event?.type === 'message.part.updated') {
      const part = properties.part;
      if (!part) return;
      if (part.id && part.type) this.partTypes.set(String(part.id), String(part.type));
      const nativeId = String(part.messageID ?? '');
      const claim = this.currentLocalPromptClaim(nativeId);
      const role = this.roles.get(nativeId) ?? (claim ? 'user' : undefined);
      if (role === 'user' && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        if (!claim && this.options.ownership) {
          this.markUnavailable(
            `${this.options.dialect.displayName} detected a native user prompt from another writer; Drive was disabled.`,
          );
          return;
        }
        const partId = String(part.id ?? `${nativeId}:text`);
        if (this.emittedLiveUserParts.has(partId)) return;
        if (!this.roles.has(nativeId)) {
          this.rememberPendingLiveUserPart({
            partId,
            nativeId,
            text: part.text,
            ...(claim?.clientKey ? { clientKey: claim.clientKey } : {}),
          });
          return;
        }
        this.emitLiveUserPart({
          partId,
          nativeId,
          text: part.text,
          ...(claim?.clientKey ? { clientKey: claim.clientKey } : {}),
        });
        return;
      }
      if (part.id && this.streamingParts.has(String(part.id))) return;
      for (const message of mapOpenCodePart(part, {
        historical: false,
        productId: this.options.dialect.productId,
      })) this.emit(message);
      return;
    }
    if (event?.type === 'session.status') {
      const status = String(properties.status?.type ?? properties.status ?? '').toLowerCase();
      this.info.status = /busy|retry|running/u.test(status) ? 'working' : 'idle';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: this.info.status } });
      return;
    }
    if (event?.type === 'session.idle') {
      this.info.status = 'idle';
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
      void Promise.resolve()
        .then(() => this.options.ownership?.sessionSettled())
        .catch((error) => this.markUnavailable(
          error instanceof Error
            ? error.message
            : `${this.options.dialect.displayName} could not reconcile durable ownership.`,
        ));
      return;
    }
    if (event?.type === 'session.error') {
      this.info.status = 'idle';
      this.emit({ type: 'error', message: providerErrorMessage(properties.error ?? properties) });
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { status: 'idle' } });
      return;
    }
    if (event?.type === 'session.updated') {
      this.noteNativeModel(nativeModel(properties.info), 'live');
      if (properties.info?.revert !== undefined) {
        this.emit({ type: 'history-reset' });
        this.markUnavailable(
          `${this.options.dialect.displayName} detected a native transcript rewrite; Drive was disabled.`,
        );
      }
      return;
    }
    if (event?.type === 'session.deleted') {
      this.markUnavailable(`${this.options.dialect.displayName} session was deleted.`);
      return;
    }
    const permission = this.options.dialect.permissions?.mapEvent(event, this.info.id);
    if (permission) {
      if (permission.type === 'permission-request' || permission.type === 'question-request') {
        this.pendingRequestIds.add(permission.requestId);
      } else if (permission.type === 'permission-resolved' || permission.type === 'question-resolved') {
        this.pendingRequestIds.delete(permission.requestId);
      }
      this.emit(permission);
    }
  }

  private markUnavailable(message: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.options.ownership?.onUnavailable(message);
    this.ownershipGeneration += 1;
    this.localPromptClaims.clear();
    this.clearLiveUserIdentityState();
    this.abort.abort();
    for (const requestId of this.pendingRequestIds) {
      this.emit({ type: 'permission-resolved', requestId, decision: 'external' });
    }
    this.pendingRequestIds.clear();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error(message));
    }
    this.info.status = 'idle';
    this.info.attachMode = 'observe';
    this.info.control = this.options.disconnectedControl?.(message) ?? {
      drive: { supported: false, state: 'unavailable', reason: message },
      terminalSync: { supported: false, syncAvailable: false, active: false, reason: message },
    };
    this.emit({
      type: 'metadata-update', key: 'sessionInfo',
      value: { status: 'idle', attachMode: 'observe', control: this.info.control },
    });
    this.emit({ type: 'error', message });
  }

  private currentLocalPromptClaim(nativeId: string): LocalPromptClaim | undefined {
    const claim = this.localPromptClaims.get(nativeId);
    return claim?.generation === this.ownershipGeneration ? claim : undefined;
  }

  private rememberNativeUserTime(nativeId: string, createdAt: number): void {
    this.nativeUserCreatedAt.delete(nativeId);
    this.nativeUserCreatedAt.set(nativeId, createdAt);
    while (this.nativeUserCreatedAt.size > MAX_LIVE_USER_IDENTITIES) {
      this.nativeUserCreatedAt.delete(this.nativeUserCreatedAt.keys().next().value!);
    }
  }

  private rememberPendingLiveUserPart(part: PendingLiveUserPart): void {
    this.pendingLiveUserParts.delete(part.partId);
    this.pendingLiveUserParts.set(part.partId, part);
    while (this.pendingLiveUserParts.size > MAX_LIVE_USER_IDENTITIES) {
      this.pendingLiveUserParts.delete(this.pendingLiveUserParts.keys().next().value!);
    }
  }

  private flushPendingLiveUserParts(nativeId: string): void {
    for (const [partId, part] of this.pendingLiveUserParts) {
      if (part.nativeId !== nativeId) continue;
      this.pendingLiveUserParts.delete(partId);
      this.emitLiveUserPart(part);
    }
  }

  private emitLiveUserPart(part: PendingLiveUserPart): void {
    if (this.emittedLiveUserParts.has(part.partId)) return;
    this.emittedLiveUserParts.add(part.partId);
    while (this.emittedLiveUserParts.size > MAX_LIVE_USER_IDENTITIES) {
      this.emittedLiveUserParts.delete(this.emittedLiveUserParts.values().next().value!);
    }
    const sentAt = this.nativeUserCreatedAt.get(part.nativeId);
    this.emit({
      type: 'user-message', text: part.text, key: part.nativeId, turnId: part.nativeId,
      ...(sentAt ? { sentAt } : {}),
      ...(part.clientKey ? { clientKey: part.clientKey } : {}),
    });
  }

  private clearLiveUserIdentityState(): void {
    this.nativeUserCreatedAt.clear();
    this.pendingLiveUserParts.clear();
    this.emittedLiveUserParts.clear();
  }

  private noteNativeModel(
    model: NonNullable<SessionInfo['currentModel']> | undefined,
    source: 'history' | 'live',
    historyGeneration?: number,
  ): void {
    if (!model || (source === 'history' && historyGeneration !== this.nativeModelGeneration)) return;
    this.nativeModelGeneration += 1;
    const previous = this.info.currentModel;
    this.info.currentModel = { ...model };
    this.info.model = `${model.providerID}/${model.modelID}`;
    try {
      this.options.onModelObserved?.(model);
    } catch (error) {
      this.options.trace?.(`native model persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (previous?.providerID === model.providerID
      && previous.modelID === model.modelID
      && previous.variant === model.variant) return;
    this.emit({
      type: 'metadata-update',
      key: 'sessionInfo',
      value: { currentModel: this.info.currentModel, model: this.info.model },
    });
  }

  private assertWritable(action: string): void {
    if (!this.closed && !this.unavailable && this.info.attachMode !== 'observe') return;
    throw new Error(this.info.control?.drive.reason
      ?? `${this.options.dialect.displayName} ${action} refused: this connection is read-only.`);
  }

  private async checkOwnershipBeforeMutation(action: 'prompt' | 'permission' | 'cancel'): Promise<void> {
    try {
      await this.options.ownership?.beforeMutation(action);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markUnavailable(message);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const requestId of this.pendingRequestIds) {
      this.emit({ type: 'permission-resolved', requestId, decision: 'external' });
    }
    this.pendingRequestIds.clear();
    this.clearLiveUserIdentityState();
    this.options.ownership?.onClose(this.info.status);
    this.abort.abort();
    this.handlers.clear();
  }
}
