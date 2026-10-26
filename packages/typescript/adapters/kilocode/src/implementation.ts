/**
 * Kilo Code full-sync contract — measured from the 7.4.23 CLI, HTTP/SSE API,
 * and SQLite store on 2026-08-23/30/31.
 *
 * The broker owns an authenticated loopback serve on port 4097. Only durable
 * root sessions created by this broker may Drive; native children and foreign
 * sessions remain visible but Observe-only.
 */
import { watch, type FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  SessionCreateTemporarilyUnavailableError,
  SessionNotFoundError,
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
  OpenCodeLiveOwnershipUnprovenError,
  type OpenCodeLiveOwnershipHooks,
  type OpenCodeLiveRecovery,
  type OpenCodeLiveUnavailableCause,
  type OpenCodeLivePermissionDialect,
  type OpenCodeLiveRequestContext,
} from '@cosyncing/opencode-wire';
import { diagnoseKiloSetup } from './diagnostics.ts';
import { KiloObserveConnection, type KiloObserveOptions } from './observe.ts';
import {
  discoverKiloStore,
  kiloHistoryContinuation,
  kiloHistorySourceIdentity,
  KILO_MAX_RAW_HISTORY_BYTES,
  kiloDataRoot,
  kiloDatabasePaths,
  kiloSessionDirectoryAdmissible,
  kiloSessionIdAdmissible,
  readKiloHistory,
  type KiloHistorySnapshot,
  type KiloStoredSession,
  type KiloStoreTrace,
} from './store.ts';
import {
  kiloVerifiedInvocation,
  kiloVersionAllowsDrive,
  KILO_MINIMUM_SUPPORTED_VERSION,
} from './version.ts';

export const KILO_MANAGED_PORT = 4097;
const KILO_HTTP_TIMEOUT_MS = 5_000;
const KILO_HTTP_MUTATION_TIMEOUT_MS = 30_000;
const KILO_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;
const KILO_LIVE_MAX_ROWS_PER_SCOPE = 4_096;
const KILO_LIVE_MAX_STATUS_ENTRIES = 4_096;
const KILO_LIVE_MAX_MERGED_SESSIONS = 8_192;
/**
 * How long a Drive ownership read keeps retrying a store the serve is writing. It gates a mutation
 * the user is waiting on (Stop, an approval), usually while the turn it belongs to is running.
 */
const KILO_OWNERSHIP_READ_WITHIN_MS = 2_000;
/**
 * How long an open Drive waits for its managed serve to answer again after it stopped: the broker's
 * supervisor notices a dead serve within its 60 s tick and gives a replacement up to 20 s to start.
 */
const KILO_SERVE_RECOVERY_MS = 120_000;
/**
 * A driven session's store changed (a commit to the database, its WAL or its rollback journal):
 * how long to let it settle before reading it, and how often an unreadable read is tried again.
 */
const KILO_STORE_WATCH_DEBOUNCE_MS = 250;
const KILO_STORE_WATCH_RETRY_MS = 500;
const KILO_STORE_WATCH_RETRIES = 3;

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

class KiloDriveOwnership implements OpenCodeLiveOwnershipHooks {
  private knownMessageIds: string[] = [];
  private knownRowIds = new Set<string>();
  private knownEncodings: string[] = [];
  private knownSettledRows = 0;
  private knownUserIds = new Set<string>();
  private claimedUserIds = new Set<string>();
  /** Evidence against this writer was found: its durable Drive eligibility is revoked. */
  private revoked = false;
  /**
   * This connection is over with no evidence against the session: it closed idle, or its serve
   * stopped answering while the session was settled. Durable eligibility stands, and the next
   * attach proves it again from scratch (the exact managed host, the live session, and the exact
   * durable boundary this Drive last proved).
   */
  private ended = false;
  /** A prompt of this Drive is running: claimed, and the native session has not reported idle since. */
  private turnRunning = false;
  /** The durable boundary of the last snapshot this Drive proved (at attach, a mutation or a settle). */
  private lastProven: HistorySourceIdentity;
  /** The settle read in flight: the boundary it proves is the one a recovery must find. */
  private settling?: Promise<unknown>;
  /** Store reads run one at a time, so an older read never records over a newer one. */
  private reconciling: Promise<unknown> = Promise.resolve();
  /**
   * The text of every user prompt part this Drive knows, by part id: read from a proved snapshot
   * (`durable`), or echoed by the serve for a prompt of this Drive before any read saw it. A prompt
   * never streams, so a text that changes was rewritten, however new its message is.
   */
  private knownUserText = new Map<string, { text: string; durable: boolean }>();
  /** The serve stopped answering: the next proof that counts is {@link recover}'s. */
  private away = false;
  private watcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private watchRetries = 0;

  constructor(
    private readonly session: KiloStoredSession,
    private readonly expected: HistorySourceIdentity,
    private readonly publish: (boundary: HistorySourceIdentity) => void,
    private readonly revoke: (reason: string) => void,
    private readonly closed: () => void,
    /** Whether the serve answering now is the exact managed host this broker launched and owns. */
    private readonly hostOwned: () => Promise<boolean>,
  ) {
    this.lastProven = expected;
  }

  async prime(): Promise<void> {
    const snapshot = await readKiloHistory(this.session, { stableWithinMs: KILO_OWNERSHIP_READ_WITHIN_MS });
    if (!snapshot) throw new Error('Kilo Drive requires one stable SQLite snapshot.');
    const boundary = kiloHistorySourceIdentity(this.session, snapshot);
    if (!sameBoundary(this.expected, boundary)) throw new Error('Kilo durable ownership boundary changed before live attach.');
    this.remember(snapshot);
  }

  async beforeMutation(): Promise<void> { await this.reconcileDisk(false); }

  promptClaimed(nativeId: string): void {
    this.claimedUserIds.add(nativeId);
    this.turnRunning = true;
  }

  promptEchoed(nativeId: string, partId: string, text: string): void {
    if (!this.claimedUserIds.has(nativeId) || this.knownUserText.get(partId)?.durable) return;
    this.knownUserText.set(partId, { text, durable: false });
  }

  promptRejected(nativeId: string): void {
    this.claimedUserIds.delete(nativeId);
    this.turnRunning = false;
  }

  reconcileHistory(nativeUserIds: readonly string[]): void {
    if (this.revoked) return;
    // A user row whose parts carry no text — an image-only prompt — is projected to NO user-message,
    // so knownUserIds never learns its id even though the durable snapshot listed the row. Admitting
    // ids already seen in a snapshot keeps the live check consistent with the disk check, which only
    // ever inspects user-message keys and so already treats a text-less row as unremarkable.
    const foreign = nativeUserIds.find((id) =>
      !this.knownUserIds.has(id) && !this.claimedUserIds.has(id) && !this.knownRowIds.has(id));
    if (foreign) this.fail('Kilo history contains a user prompt from another writer.');
    for (const id of nativeUserIds) this.knownUserIds.add(id);
  }

  async sessionSettled(): Promise<void> {
    // The native session reported idle: no turn of this Drive runs any more, whatever this read finds.
    this.turnRunning = false;
    const settling = this.reconcileDisk(true);
    this.settling = settling.catch(() => undefined);
    await settling;
  }

  /**
   * A serve that stopped answering while the session was settled proves nothing about the session:
   * the store any serve reads is unchanged, and a replacement serve may drive it again once a new
   * attach proves it. Lost mid-turn, the turn's outcome is unknown, so it is revoked as before, as is
   * every other cause (another writer, a rewrite, a deletion, a rejected credential, a mutation that
   * may have landed).
   */
  onUnavailable(reason: string, cause?: OpenCodeLiveUnavailableCause): void {
    if (cause === 'disconnected' && !this.turnRunning) this.end();
    else this.invalidate(reason);
  }

  onClose(status: SessionInfo['status']): void {
    if (this.ended) return;
    if (status !== 'idle') this.invalidate('Kilo Drive closed before the native session settled.');
    else this.end();
  }

  /** Lost between turns, the serve may come back (or be replaced): this Drive waits for it. */
  serverLost(): boolean {
    if (this.turnRunning || this.ended || this.revoked) return false;
    this.away = true;
    return true;
  }

  /**
   * The guards of a fresh attach, against the serve that answers now: it is the exact managed host
   * this broker owns (until it is, the connection keeps waiting), and the durable session is exactly
   * the one this Drive last proved. Anything else ends the connection; eligibility is left as a fresh
   * attach would find it, and that attach refuses the same changed session.
   */
  async recover(): Promise<OpenCodeLiveRecovery> {
    if (this.ended || this.revoked) return { refused: 'Kilo Drive ownership has ended.' };
    // A serve that went away just after the turn settled: that settle's read is the last proof.
    await this.settling;
    if (!await this.hostOwned()) return 'retry';
    const snapshot = await readKiloHistory(this.session, { stableWithinMs: KILO_OWNERSHIP_READ_WITHIN_MS });
    if (!snapshot) return 'retry';
    if (this.ended || this.revoked) return { refused: 'Kilo Drive ownership has ended.' };
    if (!sameBoundary(this.lastProven, kiloHistorySourceIdentity(this.session, snapshot))) {
      this.end();
      return { refused: 'Kilo SQLite history changed while the Kilo Code serve was away; open the session again to check it.' };
    }
    this.away = false;
    return 'proven';
  }

  /**
   * Watch the store while this Drive holds the session, so a rewrite or another writer's prompt is
   * seen when it lands rather than at the next mutation. A turn of this Drive is checked by its
   * settle read instead, and a serve that is away by {@link recover}.
   */
  watch(factory: typeof watch = watch): void {
    if (this.watcher || this.ended || this.revoked) return;
    const name = basename(this.session.databasePath);
    // Not `-shm`: every reader of a WAL database writes its read mark there.
    const relevant = new Set([name, `${name}-wal`, `${name}-journal`]);
    try {
      this.watcher = factory(dirname(this.session.databasePath), { persistent: false }, (_event, filename) => {
        if (filename != null && !relevant.has(String(filename))) return;
        this.watchRetries = 0;
        this.scheduleWatchRead(KILO_STORE_WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => this.stopWatching());
    } catch {
      this.watcher = undefined;
    }
  }

  private scheduleWatchRead(delayMs: number): void {
    if (this.watchTimer || this.ended || this.revoked) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.watchRead();
    }, delayMs);
    this.watchTimer.unref?.();
  }

  private async watchRead(): Promise<void> {
    if (this.ended || this.revoked || this.turnRunning || this.away) return;
    try {
      await this.reconcileDisk(true);
    } catch (error) {
      // Evidence against this writer has already revoked and demoted it; an unreadable store is
      // read again a few times, and otherwise waits for its next change or mutation.
      if (error instanceof OpenCodeLiveOwnershipUnprovenError && this.watchRetries < KILO_STORE_WATCH_RETRIES) {
        this.watchRetries += 1;
        this.scheduleWatchRead(KILO_STORE_WATCH_RETRY_MS);
      }
    }
  }

  private stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    try { this.watcher?.close(); } catch { /* best effort */ }
    this.watcher = undefined;
  }

  /** Whether a known user prompt's stored text changed, or a proved one is gone. */
  private userTextRewritten(snapshot: KiloHistorySnapshot): boolean {
    for (const [partId, known] of this.knownUserText) {
      const stored = snapshot.userTextParts.get(partId);
      if (stored === undefined ? known.durable : stored !== known.text) return true;
    }
    return false;
  }

  private end(): void {
    if (this.ended || this.revoked) return;
    this.ended = true;
    this.stopWatching();
    this.closed();
  }

  private reconcileDisk(publish: boolean): Promise<void> {
    const read = this.reconciling.then(() => this.reconcileDiskNow(publish));
    this.reconciling = read.catch(() => undefined);
    return read;
  }

  private async reconcileDiskNow(publish: boolean): Promise<void> {
    if (this.revoked) throw new Error('Kilo Drive ownership has been revoked.');
    const snapshot = await readKiloHistory(this.session, { stableWithinMs: KILO_OWNERSHIP_READ_WITHIN_MS });
    // Refuse the mutation, but do NOT revoke. `readKiloHistory` answers
    // undefined for "could not read" as well as for "is not there": a `-wal`
    // that will not stabilise is the signature of a BUSY session, which is
    // exactly when a caller is most likely to be here. Revoking on it would
    // surrender durable ownership over a transient read, and `prime()` already
    // treats the same answer as a refusal rather than a revocation. The
    // unproven error is the one the live connection refuses with and does not
    // demote on; a plain Error here used to revoke Drive along with the refusal.
    if (!snapshot) {
      throw new OpenCodeLiveOwnershipUnprovenError('Kilo SQLite ownership snapshot could not be read; refusing this mutation.');
    }
    // The disk was last read at `beforeMutation`, usually mid-turn (a permission reply is the
    // ordinary case), so the turn's own progress since then is not a rewrite: Kilo writes a message
    // in place until it completes (see kiloHistoryContinuation). Read as an append-only prefix, that
    // progress permanently revoked Drive on the next normal turn boundary.
    const prefix = snapshot.messageIds.length >= this.knownMessageIds.length
      && this.knownMessageIds.every((id, index) => snapshot.messageIds[index] === id)
      && kiloHistoryContinuation({ encodings: this.knownEncodings, settledRows: this.knownSettledRows }, snapshot) !== undefined;
    if (!prefix || this.userTextRewritten(snapshot)
      || kiloHistorySourceIdentity(this.session, snapshot).sourceId !== this.lastProven.sourceId) {
      return this.fail('Kilo SQLite history was rewritten or replaced.');
    }
    const users = snapshot.messages.flatMap((message) =>
      message.type === 'user-message' && message.key ? [message.key] : []);
    const foreign = users.find((id) => !this.knownUserIds.has(id) && !this.claimedUserIds.has(id));
    if (foreign) return this.fail('Kilo SQLite history contains a foreign user prompt.');
    this.remember(snapshot);
    // A read that finished after a revocation must not record a boundary for it. One that finished
    // after the connection ended (its serve went away just after the turn settled) is still the
    // settled turn's proof, and the next attach starts from it.
    if (publish && !this.revoked) this.publish(kiloHistorySourceIdentity(this.session, snapshot));
  }

  private remember(snapshot: KiloHistorySnapshot): void {
    this.lastProven = kiloHistorySourceIdentity(this.session, snapshot);
    this.knownMessageIds = [...snapshot.messageIds];
    for (const id of snapshot.messageIds) this.knownRowIds.add(id);
    this.knownEncodings = [...snapshot.encodings];
    this.knownSettledRows = snapshot.settledRows;
    for (const [partId, text] of snapshot.userTextParts) this.knownUserText.set(partId, { text, durable: true });
    for (const message of snapshot.messages) {
      if (message.type === 'user-message' && message.key) this.knownUserIds.add(message.key);
    }
  }

  private fail(reason: string): never {
    this.invalidate(reason);
    throw new Error(reason);
  }

  private invalidate(reason: string): void {
    if (this.revoked) return;
    this.revoked = true;
    this.ended = true;
    this.stopWatching();
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

async function boundedKiloFetch(
  base: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await base(input, init);
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
  /** Transport under the authenticated, bounded fetch (default: the global fetch). Fixture hook for in-process servers. */
  fetch?: typeof globalThis.fetch;
  /** The loopback port the broker may launch and own `kilo serve` on (default 4097). Fixture hook, see runtime.ts. */
  managedPort?: number;
  /** How long an open Drive waits for its serve to answer again (default {@link KILO_SERVE_RECOVERY_MS}). Fixture hook. */
  serveRecoveryMs?: number;
  /** How a driven session watches its store for changes (default `fs.watch`). Fixture hook. */
  storeWatch?: typeof watch;
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
  private readonly managedPort: number;
  private readonly serveRecoveryMs: number;
  private readonly storeWatch?: typeof watch;
  private readonly serverUsername: string;
  private readonly serverPassword?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
    this.managedPort = options.managedPort ?? KILO_MANAGED_PORT;
    this.serveRecoveryMs = options.serveRecoveryMs ?? KILO_SERVE_RECOVERY_MS;
    if (options.storeWatch) this.storeWatch = options.storeWatch;
    this.baseUrl = (options.baseUrl ?? this.env.KILO_URL?.trim() ?? `http://127.0.0.1:${this.managedPort}`).replace(/\/$/u, '');
    this.serverUsername = options.serverUsername?.trim() || this.env.KILO_SERVER_USERNAME?.trim() || 'kilo';
    this.serverPassword = (options.serverPassword ?? this.env.KILO_SERVER_PASSWORD)?.trim()
      || randomBytes(32).toString('base64url');
    this.baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
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

  /** The resolve Create and the managed serve start from; never a launch. Without it the broker
   *  lists stored sessions Observe-only and refuses a new live writer, as Create already does. */
  isInstalled(): boolean {
    return resolveInvocation(this.command, { env: this.env }) !== undefined;
  }

  async isAvailable(): Promise<boolean> {
    if (this.isInstalled()) return true;
    const root = kiloDataRoot(this.env, this.homeDir);
    return lstat(root).then((value) => !value.isSymbolicLink() && value.isDirectory()
      && kiloDatabasePaths(root).length > 0, () => false);
  }

  async isManagedHostReady(options?: { signal?: AbortSignal }): Promise<boolean> {
    return this.liveServerAvailable(options?.signal);
  }

  managedHostIdentity(inputs: ManagedHostIdentityInputs): string | null {
    try {
      const base = (inputs.env.KILO_URL?.trim() || `http://127.0.0.1:${this.managedPort}`).replace(/\/$/u, '');
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
    const invocation = loopback && port === this.managedPort ? await kiloVerifiedInvocation(this.command, this.env) : undefined;
    const launchable = invocation?.kind === 'native';
    return {
      identityKey: `${url.origin}|${kiloDataRoot(this.env, this.homeDir)}`,
      locator: loopback && Number.isSafeInteger(port) && port > 0
        ? { kind: 'tcp-port', port }
        : { kind: 'unknown' },
      launch: launchable
        ? {
            command: invocation.executable,
            args: ['serve', '--hostname', '127.0.0.1', '--port', String(this.managedPort)],
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
      return boundedKiloFetch(this.baseFetch, input, { ...init, headers, redirect: 'error' });
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
      ...(this.resolveStoredDriveState ? {
        ownedBoundary: (session: { id: string; nativeId: string }) =>
          this.resolveStoredDriveState?.({ tool: this.id, id: session.id, nativeId: session.nativeId })?.historyBoundary,
      } : {}),
    });
    // The roster offers Drive only where an attach would take it: not where the store already
    // differs from what the session's Drive last proved.
    const ownedHistoryChanged = new Set(sessions.flatMap((session) => session.ownedHistoryChanged ? [session.id] : []));
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
      merged.set(info.id, this.retagLiveInfo(combined, false, false, managedHostOwned, ownedHistoryChanged.has(info.id)));
    }
    return [...merged.values()];
  }

  async canCreateSession(): Promise<boolean> {
    return await kiloVerifiedInvocation(this.command, this.env)
      ? this.liveServerAvailable()
      : false;
  }

  async prepareCreateSession(): Promise<void> {
    // The same typed, retryable refusal every adapter gives when it cannot create right now
    // (`canCreateSession` false): installing or upgrading Kilo is how the user recovers.
    if (!await kiloVerifiedInvocation(this.command, this.env)) {
      const installed = resolveInvocation(this.command, { env: this.env }) !== undefined;
      throw new SessionCreateTemporarilyUnavailableError(
        installed
          ? `Kilo Code Drive requires kilo ${KILO_MINIMUM_SUPPORTED_VERSION} or newer; the installed kilo reports an older or unreadable version. Run \`cosyncing doctor\` for setup guidance.`
          : `Kilo Code Drive requires kilo ${KILO_MINIMUM_SUPPORTED_VERSION} or newer, and no kilo executable was found. Run \`cosyncing doctor\` for setup guidance.`,
        installed ? 'kilo-version-unsupported' : 'kilo-binary-missing',
      );
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
    if (!kiloSessionIdAdmissible(sessionId)) throw new SessionNotFoundError('This Kilo Code session id is not a session id.');
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
      // Scoped to THIS connection: an earlier one that ended (its serve went away) is closed later by
      // the Hub, and must not release the Drive slot a newer attach now holds.
      let connection: OpenCodeLiveConnection | undefined;
      const release = () => {
        if (connection && this.driven.get(sessionId) === connection) this.driven.delete(sessionId);
      };
      const revoke = (reason: string) => {
        release();
        this.revokeStoredDriveEligibility?.({ tool: this.id, id: sessionId, nativeId: storedSession.nativeId });
        this.trace?.({ op: 'observe', detail: reason });
        // Evidence the ownership found in the store itself (a watched change, a settle read) ends
        // Drive for every client now, not at the next mutation.
        connection?.demote(reason);
      };
      const ownership = new KiloDriveOwnership(
        storedSession,
        stored.historyBoundary,
        (historyBoundary) => this.recordStoredDriveBoundary?.({
          tool: this.id, id: sessionId, nativeId: storedSession.nativeId, historyBoundary,
        }),
        revoke,
        release,
        async () => {
          if (!await this.liveServerAvailable()) return false;
          const descriptor = await this.describeManagedHost();
          return !!descriptor && await this.isManagedHostOwned?.(descriptor.identityKey) === true;
        },
      );
      try {
        await ownership.prime();
      } catch (error) {
        this.opening.delete(sessionId);
        throw error;
      }
      const driver = new OpenCodeLiveConnection({
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
        serverRecoveryMs: this.serveRecoveryMs,
        trace: (detail) => this.trace?.({ op: 'observe', detail }),
      });
      connection = driver;
      driver.start();
      try {
        await readyWithin(driver.ready, 'Kilo Code SSE did not become ready within 4 seconds.');
        this.driven.set(sessionId, driver);
        ownership.watch(this.storeWatch);
        return driver;
      } catch (error) {
        await driver.close();
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
      throw new SessionNotFoundError('Kilo Code session is missing or its SQLite schema is unsupported.');
    }
    const live = await this.fetchLiveSession(sessionId);
    if (!live) throw new SessionNotFoundError('Kilo Code session is unavailable from both SQLite and the managed server.');
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
    if (!kiloSessionIdAdmissible(sessionId)) throw new SessionNotFoundError('This Kilo Code session id is not a session id.');
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
    // The renamed row offers Drive only where an attach would take it, by the roster's own check:
    // not where the store already differs from what the session's Drive last proved.
    const ownedHistoryChanged = managedHostOwned && !this.driven.has(info.id)
      && await this.ownedHistoryChanged(info.id);
    return this.retagLiveInfo(info, false, false, managedHostOwned, ownedHistoryChanged);
  }

  /** Discovery's drift check for one session (the `ownedBoundary` of discoverKiloStore). */
  private async ownedHistoryChanged(sessionId: string): Promise<boolean> {
    if (!this.resolveStoredDriveState) return false;
    const stored = (await discoverKiloStore({
      env: this.env,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      includeUnverifiedChildren: true,
      ...(this.trace ? { trace: this.trace } : {}),
      ownedBoundary: (session: { id: string; nativeId: string }) => session.id === sessionId
        ? this.resolveStoredDriveState?.({ tool: this.id, id: session.id, nativeId: session.nativeId })?.historyBoundary
        : undefined,
    })).find((session) => session.id === sessionId);
    return stored?.ownedHistoryChanged === true;
  }

  private retagLiveInfo(
    info: SessionInfo,
    forceDriving = false,
    forceEligible = false,
    managedHostOwned = false,
    ownedHistoryChanged = false,
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
    const durable = info.origin !== 'subagent' && !ownedHistoryChanged
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

  /** A live serve row, admitted only under the store's own id and directory rules: the serve lists
   *  what the store holds, so a row the store would withhold is withheld here too, and nothing
   *  attaches to it. A row that names no directory (absent or empty) has no workspace to expose and
   *  stays as it was. */
  private liveSessionInfo(raw: any): SessionInfo | undefined {
    const id = raw?.id;
    if (!kiloSessionIdAdmissible(id)) return undefined;
    if (raw.directory != null && raw.directory !== '' && !kiloSessionDirectoryAdmissible(raw.directory)) return undefined;
    if (raw.parentID !== undefined && raw.parentID !== null && raw.parentID !== ''
      && !kiloSessionIdAdmissible(raw.parentID)) return undefined;
    const model = raw?.model && typeof raw.model === 'object'
      ? { providerID: String(raw.model.providerID ?? ''), modelID: String(raw.model.modelID ?? '') }
      : undefined;
    return {
      id,
      nativeId: id,
      tool: this.id,
      title: String(raw.title ?? ''),
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
    if (!kiloSessionIdAdmissible(sessionId)) return undefined;
    const response = await this.fetcher(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const info = this.liveSessionInfo(await readBoundedJson(response));
    // The serve answers for exactly the id asked: anything else is not this session.
    return info?.id === sessionId ? info : undefined;
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
