/**
 * Kilo Code full-sync contract — measured from the 7.4.23 CLI, HTTP/SSE API,
 * and SQLite store on 2026-08-23/30/31.
 *
 * The broker owns an authenticated loopback serve on port 4097. Only durable
 * root sessions created by this broker may Drive; native children and foreign
 * sessions remain visible but Observe-only.
 */
import { lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  SessionCreateTemporarilyUnavailableError,
  resolveInvocation,
  type AgentBackend,
  type AgentMessage,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type HistorySourceIdentity,
  type ModelOption,
  type ModeOption,
  type ManagedHostDescriptor,
  type ManagedHostIdentityInputs,
  type PermissionDecision,
  type PromptInput,
  type SessionConnection,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import {
  OpenCodeLiveConnection,
  OpenCodeLiveMutationAmbiguousError,
  type OpenCodeLiveOwnershipHooks,
  type OpenCodeLivePermissionDialect,
  type OpenCodeLiveRequestContext,
} from '@cosyncing/opencode-wire';
import { diagnoseKiloSetup } from './diagnostics.ts';
import { KiloObserveConnection, type KiloObserveOptions } from './observe.ts';
import {
  discoverKiloStore,
  kiloHistorySourceIdentity,
  KILO_MAX_RAW_HISTORY_BYTES,
  kiloDataRoot,
  kiloDatabasePaths,
  readKiloHistory,
  type KiloStoredSession,
  type KiloStoreTrace,
} from './store.ts';
import {
  kiloVerifiedInvocation,
  kiloVersionAllowsDrive,
  KILO_MINIMUM_SUPPORTED_VERSION,
} from './version.ts';

const KILO_HTTP_TIMEOUT_MS = 5_000;
const KILO_HTTP_MUTATION_TIMEOUT_MS = 30_000;
const KILO_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;
const KILO_LIVE_MAX_ROWS_PER_SCOPE = 4_096;
const KILO_LIVE_MAX_STATUS_ENTRIES = 4_096;
const KILO_LIVE_MAX_MERGED_SESSIONS = 8_192;

type KiloLiveReadiness =
  | { kind: 'ready' }
  | { kind: 'temporary'; detail: string }
  | { kind: 'incompatible'; detail: string };

function sameBoundary(left: HistorySourceIdentity, right: HistorySourceIdentity): boolean {
  return left.sourceId === right.sourceId && left.revision === right.revision
    && left.appendPosition === right.appendPosition && left.rewriteToken === right.rewriteToken;
}

function preserveModelLabel(
  native: SessionInfo['currentModel'],
  fallback: SessionInfo['currentModel'],
): SessionInfo['currentModel'] {
  if (!native) return fallback ? { ...fallback } : undefined;
  if (native.label || !fallback?.label
    || native.providerID !== fallback.providerID
    || native.modelID !== fallback.modelID) return { ...native };
  return { ...native, label: fallback.label };
}

/**
 * Kilo persists a streaming assistant part IN PLACE: the same row's text grows as the model writes.
 * `reconcileDisk` snapshots every row's encoding at `beforeMutation` (mid-turn — a permission reply
 * is the ordinary case) and compares it as an append-only prefix at `sessionSettled`, so that
 * growth read as "history was rewritten or replaced" and permanently revoked Drive on the next
 * NORMAL turn boundary. Measured: a mid-turn snapshot followed by extending `prt-answer` demoted a
 * healthy session to observe and dropped its stored boundary.
 *
 * Only an assistant-produced streaming row may grow, only under an unchanged type and key, and only
 * by EXTENDING its text. A foreign writer replacing content fails every one of those, so genuine
 * rewrite detection is untouched.
 */
function isStreamedGrowth(before: string, after: string | undefined): boolean {
  if (after === undefined) return false;
  let previous: Record<string, unknown>;
  let current: Record<string, unknown>;
  try {
    previous = JSON.parse(before) as Record<string, unknown>;
    current = JSON.parse(after) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (previous.type !== 'model-output' && previous.type !== 'thinking') return false;
  if (previous.type !== current.type || previous.key !== current.key) return false;
  if (typeof previous.text !== 'string' || typeof current.text !== 'string') return false;
  return current.text.startsWith(previous.text);
}

class KiloDriveOwnership implements OpenCodeLiveOwnershipHooks {
  private knownMessageIds: string[] = [];
  private knownRowIds = new Set<string>();
  private knownEncodings: string[] = [];
  private knownUserIds = new Set<string>();
  private claimedUserIds = new Set<string>();
  private invalid = false;

  constructor(
    private readonly session: KiloStoredSession,
    private readonly expected: HistorySourceIdentity,
    private readonly publish: (boundary: HistorySourceIdentity) => void,
    private readonly revoke: (reason: string) => void,
    private readonly closed: () => void,
  ) {}

  async prime(): Promise<void> {
    const snapshot = await readKiloHistory(this.session);
    if (!snapshot) throw new Error('Kilo Drive requires one stable SQLite snapshot.');
    const boundary = kiloHistorySourceIdentity(this.session, snapshot);
    if (!sameBoundary(this.expected, boundary)) throw new Error('Kilo durable ownership boundary changed before live attach.');
    this.remember(snapshot.messageIds, snapshot.messages);
  }

  async beforeMutation(): Promise<void> { await this.reconcileDisk(false); }

  promptClaimed(nativeId: string): void { this.claimedUserIds.add(nativeId); }
  promptRejected(nativeId: string): void { this.claimedUserIds.delete(nativeId); }

  reconcileHistory(nativeUserIds: readonly string[]): void {
    if (this.invalid) return;
    // A user row whose parts carry no text — an image-only prompt — is projected to NO user-message,
    // so knownUserIds never learns its id even though the durable snapshot listed the row. Admitting
    // ids already seen in a snapshot keeps the live check consistent with the disk check, which only
    // ever inspects user-message keys and so already treats a text-less row as unremarkable.
    const foreign = nativeUserIds.find((id) =>
      !this.knownUserIds.has(id) && !this.claimedUserIds.has(id) && !this.knownRowIds.has(id));
    if (foreign) this.fail('Kilo history contains a user prompt from another writer.');
    for (const id of nativeUserIds) this.knownUserIds.add(id);
  }

  async sessionSettled(): Promise<void> { await this.reconcileDisk(true); }
  onUnavailable(reason: string): void { this.invalidate(reason); }
  onClose(status: SessionInfo['status']): void {
    this.closed();
    if (status !== 'idle') this.invalidate('Kilo Drive closed before the native session settled.');
  }

  private async reconcileDisk(publish: boolean): Promise<void> {
    if (this.invalid) throw new Error('Kilo Drive ownership has been revoked.');
    const snapshot = await readKiloHistory(this.session);
    // Refuse the mutation, but do NOT revoke. `readKiloHistory` answers
    // undefined for "could not read" as well as for "is not there": a `-wal`
    // that will not stabilise across its three attempts is the signature of a
    // BUSY session, which is exactly when a caller is most likely to be here.
    // Revoking on it would surrender durable ownership over a transient read,
    // and `prime()` thirty lines above already treats the same answer as a
    // refusal rather than a revocation.
    if (!snapshot) throw new Error('Kilo SQLite ownership snapshot could not be read; refusing this mutation.');
    const prefix = snapshot.messageIds.length >= this.knownMessageIds.length
      && snapshot.encodings.length >= this.knownEncodings.length
      && this.knownMessageIds.every((id, index) => snapshot.messageIds[index] === id)
      && this.knownEncodings.every((encoding, index) =>
        snapshot.encodings[index] === encoding
        || isStreamedGrowth(encoding, snapshot.encodings[index]));
    if (!prefix) return this.fail('Kilo SQLite history was rewritten or replaced.');
    const users = snapshot.messages.flatMap((message) =>
      message.type === 'user-message' && message.key ? [message.key] : []);
    const foreign = users.find((id) => !this.knownUserIds.has(id) && !this.claimedUserIds.has(id));
    if (foreign) return this.fail('Kilo SQLite history contains a foreign user prompt.');
    this.remember(snapshot.messageIds, snapshot.messages);
    if (publish) this.publish(kiloHistorySourceIdentity(this.session, snapshot));
  }

  private remember(ids: readonly string[], messages: readonly AgentMessage[]): void {
    this.knownMessageIds = [...ids];
    for (const id of ids) this.knownRowIds.add(id);
    this.knownEncodings = messages.map((message) => JSON.stringify(message));
    for (const message of messages) {
      if (message.type === 'user-message' && message.key) this.knownUserIds.add(message.key);
    }
  }

  private fail(reason: string): never {
    this.invalidate(reason);
    throw new Error(reason);
  }

  private invalidate(reason: string): void {
    if (this.invalid) return;
    this.invalid = true;
    this.revoke(reason);
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs = KILO_HTTP_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedText(
  response: Response,
  maxBytes = KILO_HTTP_MAX_BODY_BYTES,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
}

async function readBoundedJson(response: Response): Promise<unknown | undefined> {
  const text = await readBoundedText(response);
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

async function boundedKiloFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const url = new URL(String(input instanceof Request ? input.url : input));
  const returnsJson = method === 'GET'
    || (method === 'POST' && url.pathname === '/session')
    || (method === 'PATCH' && /^\/session\/[^/]+$/u.test(url.pathname));
  if (!returnsJson) {
    // These connection mutations consume status only, so the body is drained
    // either way. Cancelled rather than read: translating a native 2xx into a
    // retryable synthetic failure after the mutation may already have landed
    // would be worse than discarding a body nobody reads.
    await response.body?.cancel().catch(() => undefined);
    return response;
  }
  if (!response.ok) {
    // Drained HERE, once, for every non-2xx that reaches this adapter. Past
    // this point the callers read `status` and `statusText` and nothing else,
    // so an abandoned body just holds its connection out of the pool until the
    // runtime notices — and the very failure that produces these responses is
    // the one where the next request most needs that connection back.
    await response.body?.cancel().catch(() => undefined);
    return response;
  }
  if (!response.body
    || response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
  const maxBytes = /\/session\/[^/]+\/message$/u.test(url.pathname)
    ? KILO_MAX_RAW_HISTORY_BYTES
    : KILO_HTTP_MAX_BODY_BYTES;
  const text = await readBoundedText(response, maxBytes);
  if (text === undefined) {
    return new Response(null, { status: 502, statusText: 'Kilo response exceeded the bounded JSON body limit' });
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const KILO_CAPABILITIES: AgentCapabilities = Object.freeze({
  integrationKind: 'http-sse',
  attachModes: ['live', 'observe'] as AttachMode[],
  supportsObserve: true,
  supportsResume: false,
  supportsLiveAttach: true,
  supportsCrossClientDriveSharing: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: false,
  supportsModelSwitch: true,
  permissionGranularity: 'per-tool',
});

export interface KiloAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  trace?: (event: KiloStoreTrace | { op: 'observe'; detail: string }) => void;
  observe?: Omit<KiloObserveOptions, 'session' | 'info' | 'trace'>;
  /** @deprecated The floor-gated writer is shipped; retained for fixture compatibility. */
  testOnlyEnableUnverifiedDrive?: boolean;
  baseUrl?: string;
  serverUsername?: string;
  serverPassword?: string;
  isManagedHostOwned?: (identityKey: string) => boolean | Promise<boolean>;
  resolveStoredDriveState?: (info: { tool: string; id: string; nativeId?: string }) => {
    currentModel?: SessionInfo['currentModel'];
    historyBoundary?: HistorySourceIdentity;
  } | undefined;
  revokeStoredDriveEligibility?: (info: { tool: string; id: string; nativeId?: string }) => void;
  recordStoredDriveBoundary?: (info: {
    tool: string; id: string; nativeId?: string; historyBoundary: HistorySourceIdentity;
  }) => void;
  /** App-selected model persisted by the broker until Kilo records native model evidence. */
  resolveStoredCurrentModel?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
  }) => SessionInfo['currentModel'] | undefined;
  /** Replace the broker hint when Kilo supplies newer native model evidence. */
  recordNativeCurrentModel?: (info: {
    tool: string;
    id: string;
    nativeId?: string;
    currentModel: NonNullable<SessionInfo['currentModel']>;
  }) => void;
}

function liveControl(reason?: string, driving = true): SessionInfo['control'] {
  return {
    drive: reason
      ? { state: 'unavailable', supported: false, reason }
      : driving
        ? { state: 'driving', supported: true, handoffAvailable: false }
        : { state: 'observing', supported: true, handoffAvailable: false },
    terminalSync: {
      supported: false,
      syncAvailable: false,
      active: false,
      reason: reason ?? 'Kilo Code exposes no measured terminal join channel.',
    },
  };
}

function observeControl(reason: string): SessionInfo['control'] {
  return {
    drive: { state: 'observing', supported: false, reason },
    terminalSync: {
      supported: false, syncAvailable: false, active: false,
      reason: 'Kilo Code exposes no measured terminal join channel.',
    },
  };
}

function permissionFromEvent(raw: unknown, sessionId: string): AgentMessage | undefined {
  const event = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  if (['permission.replied', 'permission.v2.replied'].includes(String(event.type))) {
    const properties = event.properties ?? {};
    if (String(properties.sessionID ?? '') !== sessionId) return undefined;
    const response = properties.reply ?? properties.response;
    return {
      type: 'permission-resolved',
      requestId: String(properties.requestID ?? properties.permissionID ?? ''),
      decision: response === 'reject' ? 'reject' : response === 'always' ? 'approve-session' : 'approve',
    };
  }
  if (!['permission.updated', 'permission.asked', 'permission.v2.asked'].includes(String(event.type))) return undefined;
  const properties = event.properties ?? {};
  const permission = properties.permission && typeof properties.permission === 'object'
    ? properties.permission
    : properties;
  if (String(permission.sessionID ?? properties.sessionID ?? '') !== sessionId) return undefined;
  const status = String(permission.status ?? permission.state ?? 'asked').toLowerCase();
  if (!['asked', 'pending'].includes(status)) return undefined;
  const requestId = permission.id ?? permission.permissionID ?? properties.permissionID;
  if (typeof requestId !== 'string' || !requestId) return undefined;
  const toolName = String(permission.permission ?? permission.tool ?? permission.toolName ?? 'Permission');
  const detail = permission.metadata ?? permission.patterns ?? permission.input;
  return {
    type: 'permission-request',
    requestId,
    title: toolName,
    toolName,
    ...(detail === undefined ? {} : { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }),
    options: ['approve', 'approve-session', 'reject'],
  };
}

/**
 * Await readiness with a deadline, clearing the loser.
 *
 * The `Promise.race` this replaces left its 4s timer ARMED and ref'd whenever
 * readiness won — which is the common case. A broker doing rapid attach/detach
 * therefore never dropped below one live timer, and a suite that fell off the
 * end of its work hung up to four seconds per pending one before the loop could
 * drain.
 */
async function readyWithin(ready: Promise<unknown>, message: string, ms = 4_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const KILO_PERMISSIONS: OpenCodeLivePermissionDialect = {
  /**
   * THROWS when `/permission` refuses. Answering `[]` is a claim that nothing is
   * pending, and every consumer treats it as one: `seedLiveState` runs on EVERY
   * SSE reconnect and emits `permission-resolved decision:'external'` for each
   * id that has disappeared, so a session genuinely blocked on a permission
   * would have its card dismissed by a 503 during a reconnect — status
   * re-derived as Working, the agent blocked forever, nothing left to click.
   *
   * A throw is the "unknown" the three call sites already handle: two trace and
   * carry on, and the broker's `getPending` keeps its existing map.
   */
  async loadPending(context): Promise<AgentMessage[]> {
    const directory = context.directory ? `?directory=${encodeURIComponent(context.directory)}` : '';
    const response = await context.fetch(`${context.baseUrl}/permission${directory}`, {
      signal: requestSignal(context.signal, 3_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Kilo pending-permission read failed with HTTP ${response.status}.`);
    }
    const raw = await readBoundedJson(response);
    if (!Array.isArray(raw)) {
      throw new Error('Kilo pending-permission read returned a non-array document.');
    }
    return raw.slice(0, KILO_LIVE_MAX_STATUS_ENTRIES).flatMap((permission) => {
      const message = permissionFromEvent({ type: 'permission.asked', properties: permission }, context.sessionId);
      return message?.type === 'permission-request' ? [message] : [];
    });
  },
  mapEvent: permissionFromEvent,
  async respond(
    context: OpenCodeLiveRequestContext,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    if (decision === 'approve-rule') throw new Error('Kilo Code does not expose persistent approval rules.');
    const response = decision === 'reject' ? 'reject' : decision === 'approve-session' ? 'always' : 'once';
    const directory = context.directory ? `?directory=${encodeURIComponent(context.directory)}` : '';
    let result: Response;
    try {
      result = await context.fetch(
        `${context.baseUrl}/session/${encodeURIComponent(context.sessionId)}/permissions/${encodeURIComponent(requestId)}${directory}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response }),
          signal: AbortSignal.timeout(8_000),
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new OpenCodeLiveMutationAmbiguousError(
        `Kilo Code permission transport became ambiguous: ${detail}`,
        { cause: error },
      );
    }
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        throw new OpenCodeLiveMutationAmbiguousError(
          'Kilo Code authentication was rejected while replying to a permission.',
        );
      }
      if (result.status >= 500) {
        throw new OpenCodeLiveMutationAmbiguousError(
          `Kilo Code permission reply may have been accepted before the server failed (${result.status}).`,
        );
      }
      throw new Error(`Kilo Code permission reply failed (${result.status}).`);
    }
  },
};

function modelOptions(raw: unknown): ModelOption[] {
  const body = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
  const providers = Array.isArray(body.all) ? body.all : Array.isArray(raw) ? raw : [];
  const connected = (() => {
    if (Array.isArray(raw)) return undefined;
    const ids = new Set<string>();
    const source = body.connected;
    if (Array.isArray(source)) {
      for (const value of source.slice(0, 256)) {
        const id = String(typeof value === 'string' ? value : value?.id ?? value?.providerID ?? '').trim();
        if (id) ids.add(id);
      }
      return ids;
    }
    if (source && typeof source === 'object') {
      for (const [key, value] of Object.entries(source).slice(0, 256)) {
        if (value === false || value == null) continue;
        const id = String(typeof value === 'string' ? value : (value as any)?.id ?? (value as any)?.providerID ?? key).trim();
        if (id) ids.add(id);
      }
      return ids;
    }
    return new Set<string>();
  })();
  const out = new Map<string, ModelOption>();
  for (const provider of providers.slice(0, 256)) {
    const providerID = String(provider?.id ?? provider?.providerID ?? '').trim();
    if (connected && !connected.has(providerID)) continue;
    const providerLabel = String(provider?.name ?? provider?.label ?? '').trim();
    const models = Array.isArray(provider?.models)
      ? provider.models.map((model: unknown) => ['', model] as const)
      : provider?.models && typeof provider.models === 'object'
        ? Object.entries(provider.models) : [];
    for (const model of models.slice(0, 2048)) {
      const [modelKey, modelValue] = model;
      const modelID = String((modelValue as any)?.id ?? (modelValue as any)?.modelID ?? modelKey).trim();
      if (!providerID || !modelID) continue;
      const label = String((modelValue as any)?.name ?? (modelValue as any)?.label ?? modelID).trim();
      const key = `${providerID}\0${modelID}`;
      if (!out.has(key)) out.set(key, {
        providerID,
        ...(providerLabel ? { providerLabel } : {}),
        modelID,
        label,
      });
    }
  }
  return [...out.values()];
}

function sessionInfo(session: KiloStoredSession): SessionInfo {
  return {
    id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
    cwd: session.cwd, status: session.status, attachMode: 'observe',
    ...(session.model ? { model: session.model } : {}),
    ...(session.currentModel ? { currentModel: session.currentModel } : {}),
    ...(session.currentAgent ? { currentAgent: session.currentAgent } : {}),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    ...(session.origin ? { origin: session.origin } : {}),
    ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}),
    control: {
      drive: {
        state: 'observing',
        supported: false,
        reason: 'Kilo Code Drive requires the exact broker-owned managed host and durable app-created root ownership.',
      },
      terminalSync: { supported: false, syncAvailable: false, active: false, reason: 'No measured Kilo Code terminal join command exists.' },
    },
  };
}

export class KiloAdapter implements AgentBackend {
  readonly id = 'kilo';
  readonly displayName = 'Kilo Code';
  readonly integration = { externalHost: { managed: true as const } };
  readonly capabilities: AgentCapabilities;
  readonly discoveryBudgetMs = EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir?: string;
  private readonly trace?: KiloAdapterOptions['trace'];
  private readonly observe?: KiloAdapterOptions['observe'];
  private readonly resolveStoredCurrentModel?: KiloAdapterOptions['resolveStoredCurrentModel'];
  private readonly recordNativeCurrentModel?: KiloAdapterOptions['recordNativeCurrentModel'];
  private readonly baseUrl: string;
  private readonly serverUsername: string;
  private readonly serverPassword?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly isManagedHostOwned?: KiloAdapterOptions['isManagedHostOwned'];
  private readonly resolveStoredDriveState?: KiloAdapterOptions['resolveStoredDriveState'];
  private readonly revokeStoredDriveEligibility?: KiloAdapterOptions['revokeStoredDriveEligibility'];
  private readonly recordStoredDriveBoundary?: KiloAdapterOptions['recordStoredDriveBoundary'];
  private readonly driven = new Map<string, OpenCodeLiveConnection>();
  private readonly opening = new Set<string>();
  private cachedModels: ModelOption[] = [];
  private readonly candidateSelections = new Map<string, {
    model?: SessionInfo['currentModel'];
  }>();
  private readonly nativeSelections = new Map<string, NonNullable<SessionInfo['currentModel']>>();
  private readonly nativeModelGenerations = new Map<string, number>();
  declare readonly listModels?: () => Promise<ModelOption[]>;
  declare readonly listModes?: () => Promise<ModeOption[]>;
  declare readonly createSession?: (options?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  }) => Promise<SessionInfo>;
  declare readonly renameSession?: (sessionId: string, title: string | null) => Promise<SessionInfo>;

  constructor(options: KiloAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.capabilities = KILO_CAPABILITIES;
    this.command = options.command ?? (this.env.COSYNCING_KILO_BIN?.trim() || 'kilo');
    this.baseUrl = (options.baseUrl ?? this.env.KILO_URL?.trim() ?? 'http://127.0.0.1:4097').replace(/\/$/u, '');
    this.serverUsername = options.serverUsername?.trim() || this.env.KILO_SERVER_USERNAME?.trim() || 'kilo';
    this.serverPassword = (options.serverPassword ?? this.env.KILO_SERVER_PASSWORD)?.trim()
      || randomBytes(32).toString('base64url');
    this.fetcher = this.authenticatedFetch();
    this.isManagedHostOwned = options.isManagedHostOwned;
    this.resolveStoredDriveState = options.resolveStoredDriveState;
    this.revokeStoredDriveEligibility = options.revokeStoredDriveEligibility;
    this.recordStoredDriveBoundary = options.recordStoredDriveBoundary;
    if (options.homeDir) this.homeDir = options.homeDir;
    if (options.trace) this.trace = options.trace;
    if (options.observe) this.observe = options.observe;
    if (options.resolveStoredCurrentModel) this.resolveStoredCurrentModel = options.resolveStoredCurrentModel;
    if (options.recordNativeCurrentModel) this.recordNativeCurrentModel = options.recordNativeCurrentModel;
    this.listModels = () => this.listLiveModels();
    this.createSession = (value = {}) => this.createLiveSession(value);
    this.renameSession = (sessionId, title) => this.renameLiveSession(sessionId, title);
  }

  async isAvailable(): Promise<boolean> {
    if (resolveInvocation(this.command, { env: this.env })) return true;
    const root = kiloDataRoot(this.env, this.homeDir);
    return lstat(root).then((value) => !value.isSymbolicLink() && value.isDirectory()
      && kiloDatabasePaths(root).length > 0, () => false);
  }

  async isManagedHostReady(options?: { signal?: AbortSignal }): Promise<boolean> {
    return this.liveServerAvailable(options?.signal);
  }

  managedHostIdentity(inputs: ManagedHostIdentityInputs): string | null {
    try {
      const base = (inputs.env.KILO_URL?.trim() || 'http://127.0.0.1:4097').replace(/\/$/u, '');
      return `${new URL(base).origin}|${kiloDataRoot(inputs.env as NodeJS.ProcessEnv, inputs.homeDir)}`;
    } catch {
      return null;
    }
  }

  /**
   * The base URL with any credential stripped, for anything a human or a client
   * will read.
   *
   * `KILO_URL=http://kilo:<password>@host:4097` is supported — `authenticatedFetch`
   * branches on `url.username`/`url.password` — and `baseUrl` keeps the userinfo
   * because the fetches need it. Every error message that names the server does
   * not: `runtime.ts` answers a failed `POST /api/sessions/kilo` with
   * `String(err)` in a 500 body, so an interpolated `baseUrl` hands the password
   * to any paired client that asks Kilo to create a session while Kilo is off.
   */
  private safeBaseUrl(): string {
    try { return new URL(this.baseUrl).origin; } catch { return 'the configured Kilo server'; }
  }

  async describeManagedHost(): Promise<ManagedHostDescriptor | null> {
    let url: URL;
    try { url = new URL(this.baseUrl); } catch { return null; }
    const loopback = url.protocol === 'http:' && !url.username && !url.password
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
    const port = Number(url.port || 80);
    const invocation = loopback && port === 4097 ? kiloVerifiedInvocation(this.command, this.env) : undefined;
    const launchable = invocation?.kind === 'native';
    return {
      identityKey: `${url.origin}|${kiloDataRoot(this.env, this.homeDir)}`,
      locator: loopback && Number.isSafeInteger(port) && port > 0
        ? { kind: 'tcp-port', port }
        : { kind: 'unknown' },
      launch: launchable
        ? {
            command: invocation.executable,
            args: ['serve', '--hostname', '127.0.0.1', '--port', '4097'],
            env: {
              KILO_SERVER_USERNAME: this.serverUsername,
              KILO_SERVER_PASSWORD: this.serverPassword!,
              // The managed server outlives every other Kilo child, so it is the
              // one most able to update the binary out from under the gate.
              KILO_DISABLE_AUTOUPDATE: '1',
            },
            cwd: this.homeDir ?? this.env.HOME ?? process.cwd(),
          }
        : null,
      serving: { port, profile: kiloDataRoot(this.env, this.homeDir) },
      readyTimeoutMs: 20_000,
      stopGraceMs: 5_000,
    };
  }

  diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> { return diagnoseKiloSetup(context); }

  private authenticatedFetch(): typeof globalThis.fetch {
    const url = new URL(this.baseUrl);
    const loopback = url.protocol === 'http:' && !url.username && !url.password
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(input instanceof Request ? input.url : input));
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [name, value] of new Headers(init?.headers).entries()) headers.set(name, value);
      // The managed credential is loopback-only and origin-bound. It is never
      // forwarded to a configured remote or redirect destination.
      if (loopback && this.serverPassword && target.origin === url.origin) {
        headers.set('authorization', `Basic ${Buffer.from(`${this.serverUsername}:${this.serverPassword}`).toString('base64')}`);
      }
      return boundedKiloFetch(input, { ...init, headers, redirect: 'error' });
    }) as typeof globalThis.fetch;
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const signal = options?.signal ?? AbortSignal.timeout(EXTERNAL_HOST_DISCOVERY_BUDGET_MS);
    const liveDirectories = new Set<string>();
    const nativeGenerationsAtStart = new Map(this.nativeModelGenerations);
    const sessions = await discoverKiloStore({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      ...(options?.updatedAfter === undefined ? {} : { updatedAfter: options.updatedAfter }),
      ...(signal ? { signal } : {}),
      ...(options?.onWork ? { onWork: options.onWork } : {}),
      includeUnverifiedChildren: true,
      collectDirectories: liveDirectories,
      ...(this.trace ? { trace: this.trace } : {}),
    });
    const local = sessions.map(sessionInfo);
    if (!await this.liveServerAvailable(signal)) return local;
    const live = await this.listLiveSessions(
      [...liveDirectories, ...local.flatMap((info) => info.cwd ? [info.cwd] : [])],
      signal,
      options?.updatedAfter,
    );
    const identity = this.currentManagedIdentity();
    const managedHostOwned = !!identity
      && await this.isManagedHostOwned?.(identity) === true;
    const merged = new Map(local.map((info) => [info.id, info]));
    for (const info of live) {
      const disk = merged.get(info.id);
      if (disk?.currentModel
        && (nativeGenerationsAtStart.get(info.id) ?? 0) === 0
        && (this.nativeModelGenerations.get(info.id) ?? 0) === 0) {
        this.candidateSelections.delete(info.id);
        this.nativeSelections.set(info.id, { ...disk.currentModel });
      }
      const combined: SessionInfo = {
        ...disk,
        ...info,
        ...(disk?.origin ? { origin: disk.origin, parentThreadId: disk.parentThreadId } : {}),
      };
      // A live row that omits model is absence of native evidence, not proof
      // that the older disk model is current. Let retagLiveInfo choose the
      // generation-fenced native cache, then the durable fallback.
      if (!info.currentModel) {
        delete combined.currentModel;
        delete combined.model;
      }
      merged.set(info.id, this.retagLiveInfo(combined, false, false, managedHostOwned));
    }
    return [...merged.values()];
  }

  canCreateSession(): Promise<boolean> | boolean {
    return kiloVerifiedInvocation(this.command, this.env)
      ? this.liveServerAvailable()
      : false;
  }

  async prepareCreateSession(): Promise<void> {
    if (!kiloVerifiedInvocation(this.command, this.env)) {
      throw new Error(`Kilo Code Drive requires an authenticated ${KILO_MINIMUM_SUPPORTED_VERSION}-or-newer server at ${this.safeBaseUrl()}.`);
    }
    const readiness = await this.probeLiveServer();
    if (readiness.kind === 'temporary') {
      throw new SessionCreateTemporarilyUnavailableError(
        `Kilo Code managed server is temporarily unavailable: ${readiness.detail} Wait for broker startup or catalog refresh to finish, then retry.`,
        'kilo-server-unavailable',
      );
    }
    if (readiness.kind === 'incompatible') {
      throw new Error(`Kilo Code managed server is not compatible with Drive: ${readiness.detail}`);
    }
    const descriptor = await this.describeManagedHost();
    if (!descriptor || await this.isManagedHostOwned?.(descriptor.identityKey) !== true) {
      throw new SessionCreateTemporarilyUnavailableError(
        'Kilo Code managed-server ownership is temporarily unavailable. Wait for broker reconciliation, then retry.',
        'kilo-managed-host-unavailable',
      );
    }
  }

  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    if (mode === 'live') {
      if (!await this.liveServerAvailable()) {
        throw new Error('Kilo Code live attach requires the authenticated broker-owned managed server.');
      }
      const descriptor = await this.describeManagedHost();
      if (!descriptor || await this.isManagedHostOwned?.(descriptor.identityKey) !== true) {
        throw new Error('Kilo Code live attach requires the exact broker-owned managed host.');
      }
      const storedSession = (await discoverKiloStore({
        env: this.env,
        ...(this.homeDir ? { homeDir: this.homeDir } : {}),
        includeUnverifiedChildren: true,
      })).find((candidate) => candidate.id === sessionId);
      if (!storedSession || storedSession.origin === 'subagent') {
        throw new Error('Kilo Code Drive is limited to durable root sessions.');
      }
      const stored = this.resolveStoredDriveState?.({ tool: this.id, id: sessionId, nativeId: storedSession.nativeId });
      if (!stored?.historyBoundary) throw new Error('Kilo Code Drive requires durable app-created ownership.');
      if (this.driven.has(sessionId) || this.opening.has(sessionId)) {
        throw new Error('Kilo Code already has a Drive owner; join the existing broker connection.');
      }
      this.opening.add(sessionId);
      let live: SessionInfo | undefined;
      try {
        live = await this.fetchLiveSession(sessionId);
        if (!live) throw new Error('Kilo Code live session was not found on the configured serve.');
        if (live.origin === 'subagent') throw new Error('Kilo Code subagent sessions are Observe-only.');
        // Labels are host-authored by /provider. Load them before the SSE can
        // publish a native model update, otherwise a fast event can overwrite
        // durable selection provenance with an unlabeled id.
        await this.listLiveModels();
      } catch (error) {
        this.opening.delete(sessionId);
        throw error;
      }
      const revoke = (reason: string) => {
        this.driven.delete(sessionId);
        this.revokeStoredDriveEligibility?.({ tool: this.id, id: sessionId, nativeId: storedSession.nativeId });
        this.trace?.({ op: 'observe', detail: reason });
      };
      const ownership = new KiloDriveOwnership(
        storedSession,
        stored.historyBoundary,
        (historyBoundary) => this.recordStoredDriveBoundary?.({
          tool: this.id, id: sessionId, nativeId: storedSession.nativeId, historyBoundary,
        }),
        revoke,
        () => this.driven.delete(sessionId),
      );
      try {
        await ownership.prime();
      } catch (error) {
        this.opening.delete(sessionId);
        throw error;
      }
      const connection = new OpenCodeLiveConnection({
        baseUrl: this.baseUrl,
        info: this.retagLiveInfo(live, true),
        dialect: { productId: 'kilo', displayName: this.displayName, permissions: KILO_PERMISSIONS },
        loadModels: () => this.listLiveModels(),
        sendCurrentModelOnPrompt: true,
        onModelObserved: (model) => {
          const catalogModel = this.cachedModels.find((candidate) =>
            candidate.providerID === model.providerID && candidate.modelID === model.modelID);
          const observed = preserveModelLabel(model, catalogModel) ?? model;
          this.candidateSelections.delete(sessionId);
          this.nativeSelections.set(sessionId, { ...observed });
          this.nativeModelGenerations.set(sessionId, (this.nativeModelGenerations.get(sessionId) ?? 0) + 1);
          this.recordNativeModel(sessionId, live.nativeId, observed);
        },
        loadStatus: (context) => this.loadLiveStatus(context),
        fetch: this.fetcher,
        disconnectedControl: (reason) => liveControl(reason)!,
        ownership,
        trace: (detail) => this.trace?.({ op: 'observe', detail }),
      });
      connection.start();
      try {
        await readyWithin(connection.ready, 'Kilo Code SSE did not become ready within 4 seconds.');
        this.driven.set(sessionId, connection);
        return connection;
      } catch (error) {
        await connection.close();
        throw error;
      } finally {
        this.opening.delete(sessionId);
      }
    }
    if (mode !== undefined && mode !== 'observe') {
      throw new Error(`Kilo Code does not support ${mode} attach.`);
    }
    const session = (await discoverKiloStore({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      includeUnverifiedChildren: true,
      ...(this.trace ? { trace: this.trace } : {}),
    })).find((candidate) => candidate.id === sessionId);
    if (session) {
      return new KiloObserveConnection({
        session, info: sessionInfo(session), ...(this.trace ? { trace: this.trace } : {}), ...this.observe,
      });
    }
    if (!await this.liveServerAvailable()) {
      throw new Error('Kilo Code session is missing or its SQLite schema is unsupported.');
    }
    const live = await this.fetchLiveSession(sessionId);
    if (!live) throw new Error('Kilo Code session is unavailable from both SQLite and the managed server.');
    live.attachMode = 'observe';
    live.control = observeControl(live.origin === 'subagent'
      ? 'Kilo Code subagent sessions are Observe-only.'
      : 'This Kilo Code session has no durable app-created writer ownership.');
    const connection = new OpenCodeLiveConnection({
      baseUrl: this.baseUrl,
      info: live,
      dialect: { productId: 'kilo', displayName: this.displayName, permissions: KILO_PERMISSIONS },
      loadModels: () => this.listLiveModels(),
      loadStatus: (context) => this.loadLiveStatus(context),
      fetch: this.fetcher,
      disconnectedControl: (reason) => observeControl(reason)!,
      trace: (detail) => this.trace?.({ op: 'observe', detail }),
    });
    connection.start();
    try {
      await readyWithin(connection.ready, 'Kilo Code Observe SSE did not become ready within 4 seconds.');
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  private async probeLiveServer(signal?: AbortSignal): Promise<KiloLiveReadiness> {
    if (signal?.aborted) return { kind: 'temporary', detail: 'the readiness request was cancelled.' };
    if (!this.serverPassword) return { kind: 'incompatible', detail: 'the managed-server credential is missing.' };
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/global/health`, {
        signal: requestSignal(signal, 1_500),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.trace?.({ op: 'observe', detail: `Kilo live probe failed: ${detail}` });
      return { kind: 'temporary', detail: `the health endpoint could not be reached (${detail}).` };
    }
    if ([502, 503, 504].includes(response.status)) {
      return { kind: 'temporary', detail: `the health endpoint returned ${response.status}.` };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'incompatible', detail: `the managed-server credential was rejected (${response.status}).` };
    }
    if (!response.ok) {
      return { kind: 'incompatible', detail: `the health endpoint returned unexpected status ${response.status}.` };
    }
    try {
      const health = await readBoundedJson(response) as { healthy?: unknown; version?: unknown } | undefined;
      if (health?.healthy !== true) {
        return { kind: 'incompatible', detail: 'the health response did not declare healthy=true.' };
      }
      // A floor, not equality: the managed server is the same binary the CLI
      // gate already admitted, and the shapes this adapter reads from it are
      // checked structurally elsewhere. Requiring an exact match here would
      // refuse a server the CLI gate had just accepted.
      if (!kiloVersionAllowsDrive(
        typeof health.version === 'string' ? health.version : undefined)) {
        return {
          kind: 'incompatible',
          detail: `server version ${String(health.version ?? 'missing')} is below the measured floor ${KILO_MINIMUM_SUPPORTED_VERSION}.`,
        };
      }
      return { kind: 'ready' };
    } catch (error) {
      return {
        kind: 'incompatible',
        detail: `the health response was malformed (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
  }

  private async liveServerAvailable(signal?: AbortSignal): Promise<boolean> {
    return (await this.probeLiveServer(signal)).kind === 'ready';
  }

  private async createLiveSession(options: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  }): Promise<SessionInfo> {
    await this.prepareCreateSession();
    if (options.permissionMode !== undefined) {
      throw new Error('Kilo Code create-time permission mode is unavailable until a native mode transport is measured.');
    }
    const directory = options.directory ? `?directory=${encodeURIComponent(options.directory)}` : '';
    const body: Record<string, unknown> = {};
    if (options.title) body.title = options.title;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/session${directory}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(KILO_HTTP_MUTATION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OpenCodeLiveMutationAmbiguousError(
        `Kilo Code create transport became ambiguous: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      if (response.status === 502 && /bounded JSON body limit/u.test(response.statusText)) {
        throw new OpenCodeLiveMutationAmbiguousError(
          'Kilo Code create was accepted but returned no bounded stable session identity.',
        );
      }
      if (response.status >= 500) {
        throw new OpenCodeLiveMutationAmbiguousError(
          `Kilo Code create may have been accepted before the server failed (${response.status}).`,
        );
      }
      throw new Error(`Kilo Code create failed (${response.status}).`);
    }
    const info = this.liveSessionInfo(await readBoundedJson(response));
    if (!info) {
      throw new OpenCodeLiveMutationAmbiguousError(
        'Kilo Code create was accepted but returned no bounded stable session identity.',
      );
    }
    let materialized: KiloStoredSession | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      materialized = (await discoverKiloStore({
        env: this.env,
        ...(this.homeDir ? { homeDir: this.homeDir } : {}),
        includeUnverifiedChildren: true,
      })).find((candidate) => candidate.id === info.id && candidate.origin !== 'subagent');
      if (materialized) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const snapshot = materialized ? await readKiloHistory(materialized) : undefined;
    if (!materialized || !snapshot) {
      throw new OpenCodeLiveMutationAmbiguousError(
        'Kilo Code create did not materialize one stable root SQLite identity.',
      );
    }
    this.recordStoredDriveBoundary?.({
      tool: this.id,
      id: materialized.id,
      nativeId: materialized.nativeId,
      historyBoundary: kiloHistorySourceIdentity(materialized, snapshot),
    });
    let selectedModel: SessionInfo['currentModel'];
    if (options.model) {
      const catalogModel = this.cachedModels.find((candidate) =>
        candidate.providerID === options.model!.providerID && candidate.modelID === options.model!.modelID);
      selectedModel = {
        ...options.model,
        ...(catalogModel?.label ? { label: catalogModel.label } : {}),
      };
    }
    this.candidateSelections.set(info.id, {
      ...(selectedModel ? { model: selectedModel } : {}),
    });
    // The runtime persists app-created provenance immediately after this call.
    // This create response must already advertise live attach so the client can
    // open the writer without waiting for another roster refresh.
    return this.retagLiveInfo(info, false, true);
  }

  private async renameLiveSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    await this.prepareCreateSession();
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title?.trim() || null }),
        signal: AbortSignal.timeout(KILO_HTTP_MUTATION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OpenCodeLiveMutationAmbiguousError(
        `Kilo Code rename transport became ambiguous: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      if (response.status === 502 && /bounded JSON body limit/u.test(response.statusText)) {
        throw new OpenCodeLiveMutationAmbiguousError(
          'Kilo Code rename was accepted but returned no bounded stable session identity.',
        );
      }
      if (response.status >= 500) {
        throw new OpenCodeLiveMutationAmbiguousError(
          `Kilo Code rename may have been accepted before the server failed (${response.status}).`,
        );
      }
      throw new Error(`Kilo Code rename failed (${response.status}).`);
    }
    const info = this.liveSessionInfo(await readBoundedJson(response));
    if (!info) {
      throw new OpenCodeLiveMutationAmbiguousError(
        'Kilo Code rename was accepted but returned no bounded stable session identity.',
      );
    }
    const identity = this.currentManagedIdentity();
    const managedHostOwned = !!identity
      && await this.isManagedHostOwned?.(identity) === true;
    return this.retagLiveInfo(info, false, false, managedHostOwned);
  }

  private retagLiveInfo(
    info: SessionInfo,
    forceDriving = false,
    forceEligible = false,
    managedHostOwned = false,
  ): SessionInfo {
    const selection = this.candidateSelections.get(info.id);
    const nativeSelection = this.nativeSelections.get(info.id);
    const storedModel = !info.currentModel && !nativeSelection && !selection?.model
      ? this.resolveStoredCurrentModel?.({ tool: this.id, id: info.id, nativeId: info.nativeId })
      : undefined;
    info.tool = this.id;
    info.nativeId ??= info.id;
    const nativeModel = info.currentModel ?? nativeSelection ?? selection?.model ?? storedModel;
    const catalogModel = nativeModel ? this.cachedModels.find((candidate) =>
      candidate.providerID === nativeModel.providerID && candidate.modelID === nativeModel.modelID) : undefined;
    const fallbackModel = catalogModel ?? selection?.model ?? storedModel ?? nativeSelection;
    const pendingModel = preserveModelLabel(nativeModel, fallbackModel);
    if (pendingModel) {
      info.currentModel = { ...pendingModel };
      info.model = `${pendingModel.providerID}/${pendingModel.modelID}`;
    }
    delete info.terminalSyncHint;
    const durable = info.origin !== 'subagent'
      && this.resolveStoredDriveState?.({ tool: this.id, id: info.id, nativeId: info.nativeId })?.historyBoundary !== undefined;
    const driving = forceDriving || this.driven.has(info.id);
    const eligible = forceEligible || driving || (durable && managedHostOwned);
    if (driving || eligible) {
      info.attachMode = 'live';
      info.control = liveControl(undefined, driving);
    } else {
      info.attachMode = 'observe';
      info.control = observeControl(info.origin === 'subagent'
        ? 'Kilo Code subagent sessions are Observe-only.'
        : 'Kilo Code Drive is restricted to durable root sessions created by this broker installation.');
    }
    return info;
  }

  private currentManagedIdentity(): string | undefined {
    try { return `${new URL(this.baseUrl).origin}|${kiloDataRoot(this.env, this.homeDir)}`; } catch { return undefined; }
  }

  private recordNativeModel(
    id: string,
    nativeId: string | undefined,
    currentModel: NonNullable<SessionInfo['currentModel']>,
  ): void {
    this.recordNativeCurrentModel?.({ tool: this.id, id, ...(nativeId ? { nativeId } : {}), currentModel });
  }

  private liveSessionInfo(raw: any): SessionInfo | undefined {
    const id = typeof raw?.id === 'string' ? raw.id : undefined;
    if (!id) return undefined;
    const model = raw?.model && typeof raw.model === 'object'
      ? { providerID: String(raw.model.providerID ?? ''), modelID: String(raw.model.modelID ?? '') }
      : undefined;
    return {
      id,
      nativeId: id,
      tool: this.id,
      title: String(raw.title ?? raw.slug ?? id),
      ...(typeof raw.directory === 'string' ? { cwd: raw.directory } : {}),
      status: /busy|retry|running/u.test(String(raw.status?.type ?? raw.status ?? '').toLowerCase())
        ? 'working'
        : 'idle',
      attachMode: 'live',
      ...(model?.providerID && model.modelID ? { currentModel: model, model: `${model.providerID}/${model.modelID}` } : {}),
      ...(typeof raw.agent === 'string' ? { currentAgent: raw.agent } : {}),
      ...(typeof raw.parentID === 'string' && raw.parentID
        ? { origin: 'subagent' as const, parentThreadId: raw.parentID }
        : {}),
      ...(typeof raw.permission === 'string' ? { currentMode: raw.permission } : {}),
      ...(Number.isFinite(raw.time?.created) ? { createdAt: Number(raw.time.created) } : {}),
      ...(Number.isFinite(raw.time?.updated) ? { updatedAt: Number(raw.time.updated) } : {}),
      control: liveControl(),
    };
  }

  private async listLiveSessions(
    directories: string[],
    signal?: AbortSignal,
    updatedAfter?: number,
  ): Promise<SessionInfo[]> {
    const queries: Array<string | undefined> = [
      undefined,
      ...new Set(directories.map((directory) => directory.trim()).filter(Boolean)),
    ].slice(0, 257);
    const merged = new Map<string, SessionInfo>();
    // Kilo scopes /session and /session/status to one directory. Query the
    // directories already proved by the bounded local store, with modest
    // concurrency so a large roster cannot fan out hundreds of requests.
    for (let offset = 0; offset < queries.length; offset += 8) {
      if (signal?.aborted || merged.size >= KILO_LIVE_MAX_MERGED_SESSIONS) break;
      const rows = await Promise.all(queries.slice(offset, offset + 8).map((directory) =>
        this.listLiveSessionsInDirectory(directory, signal, updatedAfter).catch(() => [])));
      for (const info of rows.flat()) {
        if (!merged.has(info.id) && merged.size >= KILO_LIVE_MAX_MERGED_SESSIONS) break;
        merged.set(info.id, info);
      }
    }
    return [...merged.values()];
  }

  private async listLiveSessionsInDirectory(
    directory?: string,
    signal?: AbortSignal,
    updatedAfter?: number,
  ): Promise<SessionInfo[]> {
    if (signal?.aborted) return [];
    const suffix = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const [response, statusResponse] = await Promise.all([
      this.fetcher(`${this.baseUrl}/session${suffix}`, { signal: requestSignal(signal, 3_000) }),
      this.fetcher(`${this.baseUrl}/session/status${suffix}`, { signal: requestSignal(signal, 3_000) }).catch(() => undefined),
    ]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await statusResponse?.body?.cancel().catch(() => undefined);
      return [];
    }
    const raw = await readBoundedJson(response);
    const rawStatuses = statusResponse?.ok ? await readBoundedJson(statusResponse) : undefined;
    if (statusResponse && !statusResponse.ok) await statusResponse.body?.cancel().catch(() => undefined);
    const statuses = rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)
      ? Object.fromEntries(Object.entries(rawStatuses).slice(0, KILO_LIVE_MAX_STATUS_ENTRIES)) as Record<string, { type?: string }>
      : {};
    return Array.isArray(raw) ? raw.slice(0, KILO_LIVE_MAX_ROWS_PER_SCOPE).flatMap((row) => {
      const info = this.liveSessionInfo({ ...row, status: statuses[String(row?.id)] ?? row?.status });
      if (!info) return [];
      if (updatedAfter !== undefined && info.status === 'idle'
        && (info.updatedAt ?? info.createdAt) !== undefined
        && (info.updatedAt ?? info.createdAt)! < updatedAfter) return [];
      return [info];
    }) : [];
  }

  private async loadLiveStatus(context: OpenCodeLiveRequestContext): Promise<SessionInfo['status'] | undefined> {
    const directory = context.directory ? `?directory=${encodeURIComponent(context.directory)}` : '';
    const response = await context.fetch(`${context.baseUrl}/session/status${directory}`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const raw = await readBoundedJson(response);
    // `undefined` means UNKNOWN and every caller treats it that way; `'idle'` is
    // a claim. The `!response.ok` line above gets that right, and the parse path
    // did not: an unparseable or non-object body collapsed to `{}`, whose
    // missing entry then read as a definite `idle` — so a truncated or garbled
    // status body could publish a busy session as finished.
    const snapshot = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).slice(0, KILO_LIVE_MAX_STATUS_ENTRIES)) as Record<string, { type?: string }>
      : undefined;
    if (!snapshot) return undefined;
    const type = snapshot[context.sessionId]?.type;
    if (type === 'busy' || type === 'retry') return 'working';
    if (type === undefined || type === 'idle') return 'idle';
    return undefined;
  }

  private async fetchLiveSession(sessionId: string): Promise<SessionInfo | undefined> {
    const response = await this.fetcher(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? this.liveSessionInfo(await readBoundedJson(response)) : undefined;
  }

  /** A refused `/provider` is not an empty catalogue: an empty array reaches the
   *  client as 409 "that model is no longer available", while a throw reaches
   *  the 503 MODEL_CATALOG_UNAVAILABLE the broker already built for this. The
   *  body is drained so the connection can be reused. */
  private async listLiveModels(): Promise<ModelOption[]> {
    const response = await this.fetcher(`${this.baseUrl}/provider`, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Kilo model catalog request failed with HTTP ${response.status}.`);
    }
    this.cachedModels = modelOptions(await readBoundedJson(response));
    return this.cachedModels.map((model) => ({ ...model }));
  }
}
