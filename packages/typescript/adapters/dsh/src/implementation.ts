/**
 * DeepSeek Harness adapter — round 1: discovery, live attach, and drive against
 * a running `dsh web` host.
 *
 * dsh is server-first. One host process owns the append-only session log, and
 * every client is a peer of it — its own browser UI included. That single fact
 * decides the whole posture:
 *
 *  - There is no ownership arbitration and no fork-on-write hazard: writes are
 *    RPCs into the one owner, so `live` is the natural attach mode and Drive is
 *    supported for every discovered session.
 *  - There is no resume: a session is attached by the host, not continued by a
 *    client, so `supportsResume` is false rather than "not implemented yet".
 *  - There is no managed runtime: this build never starts, stops, or configures
 *    the host. It only talks to one the user is already running.
 *
 * The transport is two-part and lives in `server.ts`: unary RPCs over
 * `POST /api/<method>`, and two push-only WebSocket downlinks. {@link DshHostLink}
 * is what joins them — it holds one generation of both sockets, routes their
 * frames to the attached sessions, and drives the re-baseline when a generation
 * ends. dsh has no `since` replay, so a lost socket means the client's picture is
 * unverifiable and the only correct answer is to reopen and re-read.
 */
import {
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type SessionConnection,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseDshSetup, DSH_AGENT_ID, DSH_DISPLAY_NAME } from './diagnostics.ts';
import { DshDriver } from './drive.ts';
import { mapDshSession, type DshSessionSummary, type DshWorkspaceSummary } from './mapping.ts';
import { DshSessionConnection, type DshConnectionOptions } from './observe.ts';
import {
  DshDownlinks,
  DshRpcClient,
  resolveDshBaseUrl,
  verifyDshHostDescribe,
  type DshDownlinkDiagnostic,
  type DshDownlinkFrame,
  type DshFetch,
  type DshHostDescribe,
  type DshSocketFactory,
} from './server.ts';

/** Mux frame types that address one session and must reach its connection. */
const SESSION_MUX_FRAMES: readonly string[] = Object.freeze([
  'session/event',
  'session/subscribed',
  'session/projection',
  'session/queue',
  'session/jobs',
  'approval/requested',
  'approval/resolved',
  'question/requested',
  'question/resolved',
]);

/** Host frame types that address one session. */
const SESSION_HOST_FRAMES: readonly string[] = Object.freeze([
  'host/session-status',
  'host/agent-error',
  'host/session-removed',
]);

/**
 * Frames a generation may accumulate while its `host.describe` probe is still
 * in flight, in COUNT and in BYTES. The probe answers in milliseconds against
 * a healthy host; a burst past either cap means the verifier is wedged — or
 * the endpoint is hostile — and the generation fails instead of buffering
 * without bound. The byte budget exists because each frame is already parsed
 * by the time it buffers: 1,000 frame-sized objects is exactly what an
 * unverified endpoint must not make us retain.
 */
const DSH_VERIFY_MAX_BUFFERED_FRAMES = 1_000;
const DSH_VERIFY_MAX_BUFFERED_BYTES = 4 * 1_048_576;

/**
 * Opt-in flag for registering the DeepSeek Harness adapter, DEFAULT OFF.
 *
 * Two independent reasons, either of which alone would justify the default:
 *
 *  1. CLIENT COMPATIBILITY. The broker's agent-roster route is not
 *     revision-filtered, so one dsh row makes any client that decodes
 *     `IntegrationKind` strictly throw on `http-websocket` — and because a
 *     single unknown row aborts the WHOLE roster decode, such a client loses
 *     every agent, dsh installed or not.
 *     (The same gate reasoning the Kimi lane established for the same kind.)
 *  2. EXTERNAL HOST DEPENDENCY. This adapter never starts, stops, or configures
 *     anything: it talks to a `dsh web` host the user is already running. A
 *     broker with no such host serves a row whose every action fails, so the
 *     row appears only when an operator has said the host is there.
 *
 * ACTIVATION SCOPE — foreground only, deliberately. The durable service
 * environment is a closed, enumerated, receipt-hashed list
 * (`brokerServiceEnvironmentEntries` in the broker's service-manager) and does
 * NOT carry this flag, so a systemd/launchd-managed broker cannot enable dsh:
 * it is reachable only from a foreground `cosyncing` launch with the variable
 * set. Persisting a feature gate into the service environment is a later
 * lifecycle round that owns those receipts; smuggling one variable past the
 * closed list now would bypass them. The registration-gate suite pins this.
 */
export const DSH_ENABLE_ENV = 'COSYNCING_ENABLE_DSH';

/**
 * The repo's shared truthy-env reading, so a new flag cannot drift into a new
 * spelling. Same four accepted values as every other `COSYNCING_*` gate.
 */
function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

/** The ONE predicate broker runtime and doctor both read, so they cannot disagree. */
export function dshRegistrationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return envFlagEnabled(env[DSH_ENABLE_ENV]);
}

export interface DshAdapterOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Explicit base URL; otherwise the environment, otherwise the documented default. */
  baseUrl?: string;
  fetchImpl?: DshFetch;
  socketFactory?: DshSocketFactory;
  newRpcId?: () => string;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reconnectDelayMs?: number;
  /**
   * Test seams for the session connection. The verification guard
   * (`mutationReady`), the rpc/driver wiring, and the close hook are NOT
   * overridable: they are the authority boundary, applied after this spread.
   */
  connection?: Omit<DshConnectionOptions, 'rpc' | 'driver' | 'onClosed' | 'mutationReady'>;
}

/**
 * One generation of both downlinks, plus the session routing table that makes
 * them useful.
 *
 * Generations exist because the two sockets are one unit: dsh publishes session
 * events on the mux stream and lifecycle on the host stream with no cross-stream
 * ordering guarantee and no replay cursor, so a client that lost one of them
 * cannot know what it missed on either. Ending the generation, reopening both,
 * re-verifying the host, and letting each session re-baseline from its fresh
 * `session/subscribed` is the only honest recovery.
 *
 * Routing is GATED on that verification: frames arriving before the generation's
 * `host.describe` validates are buffered per generation and replayed only after
 * it succeeds, discarded when it fails — an open socket proves a port, not a dsh
 * host, and unverified state must never reach a session.
 */
export class DshHostLink {
  private readonly connections = new Map<string, DshSessionConnection>();
  private readonly downlinks: DshDownlinks;
  private readonly diagnostics: DshDownlinkDiagnostic[] = [];
  private started = false;
  private describe?: DshHostDescribe;
  private ready = false;
  /**
   * Frames held until the current generation's `host.describe` verifies. Until
   * then the peer is an open socket, not a proven dsh host, and its frames must
   * not reach sessions. A failed probe fails the generation, which DISCARDS the
   * buffer — the re-baseline after reconnect re-reads everything afresh.
   */
  private preVerificationFrames: DshDownlinkFrame[] = [];
  private preVerificationBytes = 0;
  private readonly verifyMaxBufferedBytes: number;

  constructor(readonly rpc: DshRpcClient, options: {
    baseUrl: string;
    socketFactory?: DshSocketFactory;
    setTimeout?: (handler: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    reconnectDelayMs?: number;
    /** Test knob for the retained-bytes budget; production uses the module constant. */
    verifyMaxBufferedBytes?: number;
  }) {
    this.verifyMaxBufferedBytes = options.verifyMaxBufferedBytes && options.verifyMaxBufferedBytes > 0
      ? options.verifyMaxBufferedBytes
      : DSH_VERIFY_MAX_BUFFERED_BYTES;
    this.downlinks = new DshDownlinks(
      {
        baseUrl: options.baseUrl,
        ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
        ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
        ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
        ...(options.reconnectDelayMs !== undefined ? { reconnectDelayMs: options.reconnectDelayMs } : {}),
      },
      {
        onFrame: (frame) => this.route(frame),
        onOpen: (generation) => {
          void this.verify(generation);
        },
        onLost: () => this.onGenerationLost(),
        onDiagnostic: (diagnostic) => {
          // Contained: an undecodable frame or a socket hiccup is recorded and
          // the stream continues. Only a lost socket or `stream/error` ends the
          // generation.
          this.diagnostics.push(diagnostic);
          if (this.diagnostics.length > 100) this.diagnostics.shift();
        },
      },
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.downlinks.start();
  }

  stop(): void {
    this.started = false;
    this.ready = false;
    this.preVerificationFrames = [];
    this.preVerificationBytes = 0;
    this.downlinks.stop();
  }

  register(connection: DshSessionConnection): void {
    this.connections.set(connection.info.id, connection);
    this.start();
  }

  /**
   * Identity-guarded on purpose: the broker's `replaceConnection` installs a
   * session's NEW connection first and closes the superseded one afterwards
   * (fire-and-forget), so a close keyed by session id alone would evict the
   * replacement's routing entry — and stop the shared sockets under it.
   */
  unregister(sessionId: string, connection?: DshSessionConnection): void {
    if (connection && this.connections.get(sessionId) !== connection) return;
    this.connections.delete(sessionId);
    // Nobody is attached, so holding two sockets open against the host would be
    // work with no reader. A later attach starts a fresh generation.
    if (this.connections.size === 0) this.stop();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get hostDescribe(): DshHostDescribe | undefined {
    return this.describe;
  }

  get generation(): number {
    return this.downlinks.generation;
  }

  recordedDiagnostics(): readonly DshDownlinkDiagnostic[] {
    return this.diagnostics;
  }

  /**
   * Readiness is BOTH sockets open AND a `host.describe` whose shape validates.
   * An open socket only proves something accepted an upgrade; the describe is
   * what proves the thing behind it speaks this contract. Frames received while
   * the probe is in flight are buffered and replayed through the same routing
   * path only AFTER verification succeeds — unverified host state never reaches
   * a session.
   */
  private async verify(generation: number): Promise<void> {
    const outcome = await this.rpc.call<unknown>('host.describe', {});
    if (generation !== this.downlinks.generation) return; // superseded mid-probe
    if (!outcome.ok) {
      this.downlinks.failGeneration('host.describe did not answer');
      return;
    }
    const verified = verifyDshHostDescribe(outcome.value);
    if (!verified.ok) {
      this.downlinks.failGeneration('host.describe shape did not validate');
      return;
    }
    this.describe = verified.value;
    this.ready = true;
    const buffered = this.preVerificationFrames;
    this.preVerificationFrames = [];
    this.preVerificationBytes = 0;
    for (const frame of buffered) this.route(frame);
  }

  private onGenerationLost(): void {
    this.ready = false;
    this.preVerificationFrames = [];
    this.preVerificationBytes = 0;
    // A unary answer arriving after the generation ended describes a state
    // nothing has re-baselined, so in-flight calls fail retryable instead.
    this.rpc.abortInFlight();
    for (const connection of this.connections.values()) connection.onGenerationLost();
  }

  private route(frame: DshDownlinkFrame): void {
    if (frame.frameType === 'stream/error') {
      // A control signal, not host state: it ends the generation even while the
      // verifier is still in flight, and the buffer dies with the generation.
      this.downlinks.failGeneration('stream/error frame');
      return;
    }
    if (!this.ready) {
      if (this.preVerificationFrames.length >= DSH_VERIFY_MAX_BUFFERED_FRAMES
          || this.preVerificationBytes + frame.bytes > this.verifyMaxBufferedBytes) {
        this.downlinks.failGeneration('host verification did not keep up with the inbound frame volume');
        return;
      }
      this.preVerificationFrames.push(frame);
      this.preVerificationBytes += frame.bytes;
      return;
    }
    const sessionId = typeof frame.payload.sessionId === 'string' ? frame.payload.sessionId : undefined;
    if (!sessionId) return;
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    if (frame.stream === 'mux' && SESSION_MUX_FRAMES.includes(frame.frameType)) {
      connection.handleMuxFrame(frame);
      return;
    }
    if (frame.stream === 'host' && SESSION_HOST_FRAMES.includes(frame.frameType)) {
      connection.handleHostFrame(frame);
    }
  }
}

export class DshAdapter implements AgentBackend {
  readonly id = DSH_AGENT_ID;
  readonly displayName = DSH_DISPLAY_NAME;
  /**
   * `live` only. dsh has no client-driven resume (the host attaches sessions),
   * no native artifact signal, no file input this round (`session.attachment` is
   * deferred), and no model switch this round (`session.models`/`selectModel` are
   * deferred). Approvals are per tool call, which is what the host asks for.
   *
   * `observe` is NOT offered: dsh serves one undifferentiated client contract, so
   * an "observe" attach would hold the same full Drive authority as `live` and
   * the word would be a lie. A genuinely read-only connection needs an upstream
   * read-only credential first.
   */
  readonly capabilities: AgentCapabilities = {
    integrationKind: 'http-websocket',
    attachModes: ['live'],
    supportsObserve: false,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsCrossClientDriveSharing: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'per-tool',
  };

  private readonly options: DshAdapterOptions;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private rpcClient?: DshRpcClient;
  private link?: DshHostLink;

  constructor(options: DshAdapterOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
  }

  private baseUrl(): string {
    return resolveDshBaseUrl(this.env, this.options.baseUrl);
  }

  private rpc(): DshRpcClient {
    this.rpcClient ??= new DshRpcClient({
      baseUrl: this.baseUrl(),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.newRpcId ? { newRpcId: this.options.newRpcId } : {}),
      ...(this.options.setTimeout ? { setTimeout: this.options.setTimeout } : {}),
      ...(this.options.clearTimeout ? { clearTimeout: this.options.clearTimeout } : {}),
    });
    return this.rpcClient;
  }

  /** The one host link, created lazily so a broker with no dsh installed opens no socket. */
  hostLink(): DshHostLink {
    this.link ??= new DshHostLink(this.rpc(), {
      baseUrl: this.baseUrl(),
      ...(this.options.socketFactory ? { socketFactory: this.options.socketFactory } : {}),
      ...(this.options.setTimeout ? { setTimeout: this.options.setTimeout } : {}),
      ...(this.options.clearTimeout ? { clearTimeout: this.options.clearTimeout } : {}),
      ...(this.options.reconnectDelayMs !== undefined ? { reconnectDelayMs: this.options.reconnectDelayMs } : {}),
    });
    return this.link;
  }

  /**
   * Availability is a verified `host.describe` on the configured base URL.
   *
   * The response carries NO server identity — `version` is a placeholder the
   * product does not maintain — so this proves the contract, not the process.
   * See {@link verifyDshHostDescribe} for the residual and the upstream ask.
   */
  async isAvailable(): Promise<boolean> {
    let rpc: DshRpcClient;
    try {
      rpc = this.rpc();
    } catch {
      return false; // an unusable configured base URL is "not available", not a crash
    }
    const outcome = await rpc.call<unknown>('host.describe', {});
    if (!outcome.ok) return false;
    return verifyDshHostDescribe(outcome.value).ok;
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnoseDshSetup(context, this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {});
  }

  /**
   * Roster sweep over `session.list`, titled from each row's projections block
   * and located by its workspace.
   *
   * `blank` sessions are listed rather than hidden: the shipped adapters do not
   * filter empty sessions out of discovery, and a blank row is exactly what a
   * user sees after creating a session in the host's own UI and not yet typing.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const list = await this.rpc().call<{ items?: unknown }>('session.list', {});
    if (!list.ok) return [];
    const workspaces = await this.workspaceTitles();
    const items = Array.isArray(list.value?.items) ? list.value.items : [];
    const sessions: SessionInfo[] = [];
    for (const raw of items) {
      const summary = (raw ?? {}) as DshSessionSummary;
      const id = typeof summary.sessionId === 'string' ? summary.sessionId : undefined;
      const workspaceTitle = id ? workspaces.get(id) : undefined;
      const mapped = mapDshSession(summary, workspaceTitle ? { workspaceTitle } : {});
      if (!mapped) continue;
      // `updatedAfter` is an authoritative bound, but an active session stays
      // eligible however old its last write is.
      if (options?.updatedAfter !== undefined
          && mapped.status === 'idle'
          && mapped.updatedAt !== undefined
          && mapped.updatedAt < options.updatedAfter) {
        continue;
      }
      sessions.push(mapped);
    }
    return sessions;
  }

  /** sessionId → its workspace's display title, for sessions with no title projection yet. */
  private async workspaceTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const outcome = await this.rpc().call<{ items?: unknown }>('workspace.list', {});
    if (!outcome.ok) return titles;
    const items = Array.isArray(outcome.value?.items) ? outcome.value.items : [];
    for (const raw of items) {
      const workspace = (raw ?? {}) as DshWorkspaceSummary;
      const title = typeof workspace.title === 'string' && workspace.title
        ? workspace.title
        : typeof workspace.path === 'string' ? workspace.path : undefined;
      if (!title || !Array.isArray(workspace.sessionIds)) continue;
      for (const sessionId of workspace.sessionIds) {
        if (typeof sessionId === 'string') titles.set(sessionId, title);
      }
    }
    return titles;
  }

  /**
   * `mode === 'live'` is REQUIRED. Every other mode — including an absent one —
   * is refused.
   *
   * An absent mode looks harmless and is the dangerous case, because of how the
   * broker keys owners. `Hub.key` folds an absent mode and `'observe'` onto the
   * bare `tool:id` key while an explicit `live` gets `tool:id#live`, and the
   * join rule is ONE-WAY: a `#live` request folds onto an existing bare owner
   * that already reports live/driving, but a bare request never folds onto an
   * existing `#live` owner. So accepting "no mode" as live authority makes this
   * order produce TWO owners for one session:
   *
   *   1. the foreground client attaches `mode='live'`  → `dsh:<id>#live`
   *   2. a background watcher attaches with no mode    → `dsh:<id>` (a SECOND
   *      full-authority connection, because dsh has no observe surface to
   *      degrade it to)
   *
   * and {@link DshHostLink} routes by session id alone, so registering the
   * second SILENTLY REPLACES the first as the only frame recipient: the
   * foreground client goes quiet while both connections can still write, and
   * closing the second stops the shared downlinks under the first.
   *
   * Kimi can afford a permissive absent mode because there a bare attach yields
   * an authority-free observe connection. dsh has no such object — one
   * undifferentiated client contract, no read-only credential — so the only
   * safe answer to "no mode" is to refuse it and keep exactly one owner key.
   */
  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    if (mode === 'resume') {
      throw new Error('dsh sessions are attached by the host; there is no client-driven resume');
    }
    if (mode === 'observe') {
      // dsh has no read-only credential: an observe attach would hold full Drive
      // authority, so the adapter refuses rather than lending the word to a lie.
      throw new Error('dsh serves one undifferentiated client contract; there is no read-only observe attach');
    }
    if (mode !== 'live') {
      throw new Error(
        'a dsh attach must request mode=live explicitly; an implicit attach would put a second '
        + 'full-authority owner on the bare session key and silently take over live frame delivery',
      );
    }
    const known = (await this.discoverSessions()).find((session) => session.id === sessionId);
    const info: SessionInfo = known ?? {
      id: sessionId,
      tool: this.id,
      title: sessionId,
      status: 'idle',
      attachMode: 'live',
      launchSurface: 'unknown',
    };
    const link = this.hostLink();
    let connection: DshSessionConnection;
    connection = new DshSessionConnection(info, {
      // Caller/test knobs first; the authority fields come AFTER the spread so
      // no injected option can weaken them.
      ...(this.options.connection ?? {}),
      rpc: this.rpc(),
      driver: new DshDriver(this.rpc()),
      // Mutations ride the verified generation only: while the link is unready
      // (first probe, or re-verifying after a generation loss) the host state a
      // write would act on has not been proven, so the connection refuses.
      mutationReady: () => link.isReady,
      // Pass the connection's own identity so a close arriving after a
      // replacement attach cannot unregister the replacement.
      onClosed: (id) => link.unregister(id, connection),
    });
    link.register(connection);
    return connection;
  }

  /** Create is available only while a host is reachable and owns at least one workspace. */
  async canCreateSession(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    return (await this.workspaces()).length > 0;
  }

  /**
   * Every adapter-level write first proves the endpoint speaks the contract
   * RIGHT NOW. A `canCreateSession` preflight minutes earlier says nothing
   * about the process on the port at write time, so the write path verifies
   * itself rather than trusting an earlier sweep.
   */
  private async requireVerifiedHost(): Promise<void> {
    const outcome = await this.rpc().call<unknown>('host.describe', {});
    if (!outcome.ok || !verifyDshHostDescribe(outcome.value).ok) {
      throw new Error('the DeepSeek Harness host did not pass verification; the write was not issued');
    }
  }

  /**
   * Create a session inside an existing workspace.
   *
   * Creating the WORKSPACE is out of round 1 (`workspace.create` is not on the
   * method allowlist), so a directory with no registered workspace is refused
   * with that fact rather than silently landing the session somewhere else.
   *
   * Verification happens immediately before EACH write — the create, and the
   * optional rename — not once at the top: a describe before `workspace.list`
   * says nothing about the process on the port when the write lands. Once the
   * create has succeeded the method returns the created session even if the
   * rename then fails — the rename is cosmetic, and reporting a creation
   * failure for a session that exists invites a duplicating retry.
   */
  async createSession(opts?: { directory?: string; title?: string }): Promise<SessionInfo> {
    const workspaces = await this.workspaces();
    if (workspaces.length === 0) {
      throw new Error('the DeepSeek Harness host has no workspace to create a session in');
    }
    const directory = opts?.directory?.replace(/\/+$/, '');
    const chosen = directory
      ? workspaces.find((workspace) => workspace.path.replace(/\/+$/, '') === directory)
      : workspaces[0];
    if (!chosen) {
      throw new Error(
        `no DeepSeek Harness workspace is registered for ${directory}; add it in the host, then retry`,
      );
    }
    const driver = new DshDriver(this.rpc());
    await this.requireVerifiedHost();
    const created = await driver.create(chosen.workspaceId);
    let title = opts?.title;
    if (title) {
      // The session EXISTS upstream from here on. A failed re-verification or
      // a failed rename must NOT surface as a create failure: the caller (and
      // especially a scheduled send, which records the session id only after
      // this method returns) would retry and create a duplicate. The rename is
      // cosmetic, so it degrades to the workspace/default title.
      try {
        await this.requireVerifiedHost();
        title = await driver.rename(created.sessionId, title);
      } catch {
        title = undefined;
      }
    }
    return {
      id: created.sessionId,
      tool: this.id,
      title: title || chosen.title,
      cwd: chosen.path,
      status: 'idle',
      attachMode: 'live',
      launchSurface: 'app',
      ...(created.agentPreset ? { currentAgent: created.agentPreset } : {}),
    };
  }

  async renameSession(sessionId: string, title: string | null): Promise<void> {
    // A cleared override is a broker-side concept; dsh stores one durable title,
    // so there is nothing native to write back for null.
    if (title === null) return;
    await this.requireVerifiedHost();
    await new DshDriver(this.rpc()).rename(sessionId, title);
  }

  private async workspaces(): Promise<Array<{ workspaceId: string; path: string; title: string }>> {
    const outcome = await this.rpc().call<{ items?: unknown }>('workspace.list', {});
    if (!outcome.ok) return [];
    const items = Array.isArray(outcome.value?.items) ? outcome.value.items : [];
    const workspaces: Array<{ workspaceId: string; path: string; title: string }> = [];
    for (const raw of items) {
      const workspace = (raw ?? {}) as DshWorkspaceSummary;
      const workspaceId = typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '';
      const path = typeof workspace.path === 'string' ? workspace.path : '';
      if (!workspaceId || !path) continue;
      workspaces.push({
        workspaceId,
        path,
        title: typeof workspace.title === 'string' && workspace.title ? workspace.title : path,
      });
    }
    return workspaces;
  }
}
