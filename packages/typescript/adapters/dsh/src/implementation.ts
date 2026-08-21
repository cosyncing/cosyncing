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
 *  - This adapter performs no process effects and never configures the host. It
 *    may DESCRIBE it ({@link DshAdapter.describeManagedHost}), which behind an
 *    explicit, default-off gate lets the broker start one when none is running
 *    and this machine has the binary. The broker stops only a process it can
 *    prove it started; a host the operator runs is never touched.
 *
 * The transport is two-part and lives in `server.ts`: unary RPCs over
 * `POST /api/<method>`, and two push-only WebSocket downlinks. {@link DshHostLink}
 * is what joins them — it holds one generation of both sockets, routes their
 * frames to the attached sessions, and drives the re-baseline when a generation
 * ends. dsh has no `since` replay, so a lost socket means the client's picture is
 * unverifiable and the only correct answer is to reopen and re-read.
 */
import {
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  PRODUCT_IDENTITY,
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type AvailabilityOptions,
  type ManagedHostDescriptor,
  type ManagedHostIdentityInputs,
  type ModelOption,
  type PromptInput,
  type SessionConnection,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseDshSetup, DSH_AGENT_ID, DSH_DISPLAY_NAME } from './diagnostics.ts';
import { DshDriver, dshModelDisplayName, dshModelOptions } from './drive.ts';
import { mapDshSession, type DshSessionSummary, type DshWorkspaceSummary } from './mapping.ts';
import { DshSessionConnection, type DshConnectionOptions } from './observe.ts';
import {
  DSH_DEFAULT_BASE_URL,
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

const LOG_PREFIX = `[${PRODUCT_IDENTITY.productName}]`;

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
 * How long a broker-started `dsh web` has to answer `host.describe`.
 *
 * Generous, because this is a server booting rather than a request: being wrong
 * in the short direction means killing a host that was about to work.
 */
export const DSH_MANAGED_HOST_READY_MS = 20_000;

/** How long a stop waits after SIGTERM before escalating. */
export const DSH_MANAGED_HOST_STOP_MS = 5_000;

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
 * The repo's shared truthy-env reading, so a new flag cannot drift into a new
 * spelling. Same four accepted values as every other `COSYNCING_*` gate.
 */
function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
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
   * How an executable name becomes an absolute path, injected so a suite can
   * describe a machine with or without dsh installed without having either.
   */
  resolveExecutable?: (command: string) => string | undefined;
  /** The user's home directory; injected so a suite never depends on the real one. */
  homeDir?: string;
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
        onLost: (generation, reason) => this.onGenerationLost(generation, reason),
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

  private onGenerationLost(generation: number, reason: string): void {
    this.ready = false;
    this.preVerificationFrames = [];
    this.preVerificationBytes = 0;
    // Said out loud because it is otherwise invisible. The diagnostics buffer
    // below is in-memory and surfaced nowhere, so a rotation that took an
    // unrelated call down with it left no trace to correlate against — which is
    // what made the intermittent create failure a code read rather than a log
    // read. The reason is our own literal and the origin carries no credential.
    console.warn(
      `${LOG_PREFIX} dsh downlink generation ${generation} ended (${reason}); `
      + `re-baselining against ${this.rpc.origin}`,
    );
    // A unary answer arriving after the generation ended describes a state
    // nothing has re-baselined, so epoch-bound in-flight calls fail retryable
    // instead. Host-scoped calls opt out; see DshRpcClient.abortInFlight.
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
   * Registered for every client, shown only to those that can decode it.
   *
   * Replaces the `COSYNCING_ENABLE_DSH` gate. One of that flag's two reasons
   * was roster tolerance — a dsh row made a pre-tolerance client throw on
   * `http-websocket` and lose every agent — which the broker now settles per
   * client. Its other reason, that the row's actions all fail with no host
   * running, is not a registration question at all: absence is a diagnosis and
   * an empty session list, which is what an operator needs to SEE rather than
   * something to hide behind a variable they must already know to set.
   *
   * The floor is the INTEGRATION-KIND tolerance, not the later attach-mode one:
   * `http-websocket` is the only value in this row a released client could fail
   * to decode, and `live` has existed since the first contract. The registration
   * suite pins that reasoning against drift.
   */
  readonly minimumClientRevision = CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE;
  /**
   * Every read here crosses to a host this broker does not own and cannot
   * restart, and a leg is three RPCs at 30 seconds each. Unbudgeted, one
   * unresponsive host would hold the roster for every OTHER agent too.
   */
  readonly discoveryBudgetMs = EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
  /**
   * The host is EXTERNAL: `dsh web` runs with or without this broker, so its
   * lifecycle is governed by proven ownership rather than by assumption. See
   * {@link DshAdapter.describeManagedHost}.
   */
  readonly integration = { externalHost: { managed: true as const } };
  /**
   * `live` only. dsh has no client-driven resume (the host attaches sessions)
   * and no native artifact signal. Approvals are per tool call, which is what
   * the host asks for.
   *
   * `supportsModelSwitch` is true: `session.models` and `session.selectModel`
   * are wired, and a per-prompt override is applied as the durable session
   * selection the host actually models.
   *
   * `supportsNativeFileInput` is true with a real limit behind it. The host
   * takes inline image bytes on the prompt and has no route for anything else,
   * so the adapter delivers images and refuses other types outright. This flag
   * governs whether the client offers an attach control at all, and it is a
   * per-agent fact rather than a per-file one — leaving it false would remove
   * the only affordance that reaches the host's image intake, so an honest
   * immediate refusal for a non-image is the better trade.
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
    supportsNativeFileInput: true,
    supportsModelSwitch: true,
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

  /** Where a managed host would run from. Injected first, then the environment. */
  private homeDir(): string {
    return this.options.homeDir ?? this.env.HOME ?? this.env.USERPROFILE ?? '.';
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
  /**
   * dsh's host is `dsh web` — a program the operator runs, and one the broker
   * may start for them on this machine only.
   *
   * Two refusals are deliberate and are the whole safety content of this method:
   *
   * NOT LOOPBACK. A configured base URL pointing anywhere but this machine
   * describes somebody else's process on somebody else's host. It is described
   * with no locator and no launch, so the broker can neither start it nor form
   * an opinion about who owns it — the only correct posture toward a remote
   * address.
   *
   * NPX-ONLY INSTALLS. dsh is commonly run as `npx @deepseek-ai/dsh web`, which
   * leaves no binary on PATH. That is reported as "cannot be launched" rather
   * than papered over by invoking `npx`, because doing so would let a broker
   * fetch and execute code from the network as a side effect of starting up.
   * An operator who wants that runs it themselves, and the broker then finds a
   * host already serving.
   *
   * A NON-DEFAULT PORT IS NOT LAUNCHABLE, and this is the third refusal. The
   * locator watches whatever port the operator configured, so a launch that does
   * not BIND that port would describe one address and start a host at another —
   * the broker would then watch an empty port, conclude its child never became
   * ready, and stop it, while the host it actually started keeps running
   * somewhere else. Making the two agree needs a source-verified bind/port flag
   * for `dsh web`, and this adapter does not have one: the DSH roadmap requires
   * the exact invocation, profile/home, bind behavior, working directory and
   * environment to be source-verified before implementation, and only the bare
   * default invocation has been physically exercised. So exactly that one
   * configuration is launchable and every other is described, watched, and left
   * for the operator to start.
   */
  /**
   * The resolved base URL, which is what `identityKey` below is, for an
   * environment this adapter is not necessarily running in.
   *
   * `null` for an address that cannot be resolved at all — the same refusal
   * `describeManagedHost` makes, and for the same reason: an unusable address
   * names no host, so it must not match one either.
   *
   * Resolved from the passed environment ALONE, deliberately ignoring this
   * instance's injected `options.baseUrl`: the answer must be a property of the
   * environment being asked about, and a diagnosis comparing against it resolves
   * from an environment too. An instance override leaking in here would make the
   * two sides disagree about the same machine.
   */
  managedHostIdentity(inputs: ManagedHostIdentityInputs): string | null {
    try {
      return resolveDshBaseUrl(inputs.env);
    } catch {
      return null;
    }
  }

  async describeManagedHost(): Promise<ManagedHostDescriptor | null> {
    let baseUrl: string;
    try {
      baseUrl = this.baseUrl();
    } catch {
      return null; // an unusable configured address describes nothing
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return null;
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      || url.hostname === '::1' || url.hostname === '[::1]';
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    // The launch is `dsh web` with no flags, which is the invocation whose
    // behavior is known — and `dsh web` with no flags serves the default base
    // URL. So it may only be used when that is exactly where the adapter is
    // pointed; the comparison is on the resolved address rather than on "did
    // the operator configure anything", so an operator who explicitly sets the
    // default still gets a startable host.
    const launchable = loopback && baseUrl === DSH_DEFAULT_BASE_URL;
    const resolve = this.options.resolveExecutable ?? ((command: string) => Bun.which(command) ?? undefined);
    const executable = launchable ? resolve('dsh') : undefined;
    return {
      identityKey: baseUrl,
      locator: loopback && Number.isInteger(port) && port > 0
        ? { kind: 'tcp-port', port }
        : { kind: 'unknown' },
      launch: executable
        ? {
          command: executable,
          args: ['web'],
          // Watching files by polling instead of inotify. The physical DSH
          // qualification on this platform found the host needs it — inotify
          // instances were exhausted host-wide (121/128 in use), and a `dsh web`
          // that cannot watch its own workspace reports no changes rather than
          // failing loudly, which is the worst way for this to go wrong.
          env: { CHOKIDAR_USEPOLLING: '1' },
          // Pinned, not inherited: a broker running as a service starts from `/`,
          // and a host that resolves anything against its cwd would then behave
          // differently depending on how the broker was launched. dsh keeps its
          // profiles under `~/.dsh`, so a home-rooted cwd cannot change which
          // profile the default `web` template resolves to.
          cwd: this.homeDir(),
        }
        : null,
      // No `version`: dsh's `host.describe.version` is a documented placeholder,
      // and recording a placeholder as evidence would be worse than recording
      // nothing — it reads like a fact.
      ...(loopback && Number.isInteger(port) && port > 0 ? { serving: { port } } : {}),
      readyTimeoutMs: DSH_MANAGED_HOST_READY_MS,
      stopGraceMs: DSH_MANAGED_HOST_STOP_MS,
    };
  }

  async isAvailable(options?: AvailabilityOptions): Promise<boolean> {
    let rpc: DshRpcClient;
    try {
      rpc = this.rpc();
    } catch {
      return false; // an unusable configured base URL is "not available", not a crash
    }
    // Host-scoped, so a downlink generation rotating mid-probe must not answer
    // "unavailable" for a host that is answering fine.
    const outcome = await rpc.call<unknown>('host.describe', {}, {
      generationLoss: 'host-scoped',
      ...(options?.signal ? { signal: options.signal } : {}),
    });
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
    const cancel = options?.signal ? { signal: options.signal } : {};
    const list = await this.rpc().call<{ items?: unknown }>('session.list', {}, cancel);
    if (!list.ok) return [];
    const workspaces = await this.workspaceTitles(options?.signal);
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
  private async workspaceTitles(cancel?: AbortSignal): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const outcome = await this.rpc().call<{ items?: unknown }>(
      'workspace.list',
      {},
      cancel ? { signal: cancel } : {},
    );
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
      // Same parent half of the roster link the mapped rows carry. The
      // synthesized fallback is still a real session that can own children.
      nativeId: sessionId,
      title: sessionId,
      status: 'idle',
      attachMode: 'live',
      launchSurface: 'unknown',
    };
    // The composer's model picker preselects from `info.currentModel`, and the
    // roster read this info came from maps no model at all — so without this
    // seed the picker sits blank until the FIRST PROMPT's `request/header`
    // publishes one. `session.models` is the authoritative per-session read and
    // is already allowlisted, so ask it here.
    //
    // Best effort by design: a host that cannot answer leaves both fields
    // absent and the `request/header` path stays the fallback. An attach must
    // not fail over a picker seed.
    try {
      const catalog = await new DshDriver(this.rpc()).models(sessionId);
      const current = catalog.current;
      if (current) {
        const label = dshModelDisplayName(catalog.groups, current.provider, current.model);
        info.model = current.model;
        info.currentModel = {
          providerID: current.provider,
          modelID: current.model,
          ...(label ? { label } : {}),
          ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
        };
      }
    } catch {
      /* no authoritative model right now; request/header still publishes one */
    }
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
   * The pre-session model catalog, from the host-wide `llm.models` RPC.
   *
   * Presence of this method is what opens the create dialog's model picker at
   * all (the broker gates `canSelectModelAtCreation` and the models route on
   * it), and the rows are flattened through the SAME mapper the attached
   * session's picker uses, so a selection validated here decodes exactly like
   * the one a prompt later sends.
   *
   * A failed read THROWS: the broker turns that into a retryable 503
   * MODEL_CATALOG_UNAVAILABLE on both the models route and create-time
   * validation, while an empty array would render as a silently empty picker —
   * or worse, a misleading 409 "no longer available" for a valid selection.
   */
  async listModels(): Promise<ModelOption[]> {
    return dshModelOptions(await new DshDriver(this.rpc()).catalog());
  }

  /**
   * Every adapter-level write first proves the endpoint speaks the contract
   * RIGHT NOW. A `canCreateSession` preflight minutes earlier says nothing
   * about the process on the port at write time, so the write path verifies
   * itself rather than trusting an earlier sweep.
   */
  private async requireVerifiedHost(): Promise<void> {
    const outcome = await this.rpc().call<unknown>('host.describe', {}, { generationLoss: 'host-scoped' });
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
   * optional rename or model selection — not once at the top: a describe before
   * `workspace.list` says nothing about the process on the port when the write
   * lands. Once the create has succeeded the method returns the created session
   * even if a follow-up write then fails — both are cosmetic next to the
   * session's existence, and reporting a creation failure for a session that
   * exists invites a duplicating retry.
   *
   * A requested `model` is applied AFTER the create through
   * `session.selectModel`, the only model route this host has (dsh has no
   * per-prompt or per-create model field). dsh model selections are durable
   * session state, so the fresh session simply starts out running it.
   */
  async createSession(opts?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  }): Promise<SessionInfo> {
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
    let currentModel: SessionInfo['currentModel'];
    const requestedModel = opts?.model;
    if (requestedModel) {
      // Same partial-success rule as the rename: the session already exists, so
      // a failed selection degrades to the tool default rather than reporting
      // a create failure that a retry would duplicate. dsh has no `variant`
      // notion; the broker validates the selection against this adapter's own
      // catalog before this call, so what arrives here is a servable route.
      try {
        await this.requireVerifiedHost();
        const selected = await driver.selectModel(created.sessionId, {
          provider: requestedModel.providerID,
          model: requestedModel.modelID,
          ...(requestedModel.reasoningEffort ? { reasoningEffort: requestedModel.reasoningEffort } : {}),
        });
        // Advertised on the returned info so the composer preselects what was
        // asked for without waiting for a session.models round trip.
        currentModel = {
          providerID: selected.provider,
          modelID: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        };
      } catch {
        currentModel = undefined;
      }
    }
    return {
      id: created.sessionId,
      tool: this.id,
      // The parent half of the roster link — see mapDshSession. A session
      // created here can spawn children immediately, so the row it returns has
      // to carry it too or those children render flat until the next discovery.
      nativeId: created.sessionId,
      title: title || chosen.title,
      cwd: chosen.path,
      status: 'idle',
      attachMode: 'live',
      launchSurface: 'app',
      ...(created.agentPreset ? { currentAgent: created.agentPreset } : {}),
      ...(currentModel ? { model: currentModel.modelID, currentModel } : {}),
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
    // A workspace registry is host state, not session state, so it outlives an
    // epoch the same way the liveness probe does.
    const outcome = await this.rpc().call<{ items?: unknown }>('workspace.list', {}, {
      generationLoss: 'host-scoped',
    });
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
