/**
 * Kimi Code adapter — discovery, read-only observe, and Drive over the sessions
 * cosyncing itself created.
 *
 * Talks to the official local server started by `kimi web --no-open` over its
 * REST `/api/v1` + `/api/v2` surface and the `/api/v1/ws` cursor stream. It
 * never starts, stops, or configures that server.
 *
 * THE WRITE BOUNDARY, precisely. The only write door is the six enumerated
 * methods of {@link KimiDriveHttp}, and it is reachable only from a
 * {@link KimiDriveConnection} on a session in {@link KimiAdapter.ownedSessions}
 * — that is, one this process created through {@link KimiAdapter.createSession}.
 * Every other session is FOREIGN: listed, observed read-only through
 * {@link KimiReadOnlyHttp.getJson}, and refused a live attach. That is not
 * caution about an unfinished feature; it is the coexistence rule. Two
 * processes writing one Kimi session silently fork its journal, and a terminal
 * `kimi -S <id>` is a writer this adapter cannot see, negotiate with, or lock
 * out. Ownership is also an in-memory belief that a terminal can falsify at any
 * moment, so a drive connection watches for foreign writes and demotes itself
 * to observe when it finds one (see `drive.ts`).
 *
 * DRIVE IS EXPLICIT, and this is the second half of that boundary. Ownership is
 * necessary for Drive but not sufficient: the caller must also ASK for it, with
 * `mode === 'live'`. An absent mode means observe, on an owned session as much
 * as a foreign one. The reason is the broker's connection keying — `Hub.key`
 * folds `undefined` and `'observe'` onto the SAME bare `tool:id` connection
 * (`hub.ts:996-1000`) — so a drive connection created for a bare attach becomes
 * the connection every later bare attach joins, and each of those clients
 * inherits `canMutate` from its `info.control` (`session-owner.ts:34-44`). The
 * client's background Observe path attaches with no mode and is documented
 * "never restore or acquire Drive", so inferring write authority from a missing
 * parameter hands mutation rights to a background watcher. `mode === 'live'`
 * lands on the distinct `tool:id#live` key instead, which makes that authority
 * socket-local by construction.
 *
 * CONSEQUENCE, and the gate that answers it. `mode='live'` IS reachable from
 * the app, on the foreground path only: `createdSessionAttachMode`
 * (`runtime.ts`) returns `'live'` when the session's own attach instruction is
 * live, the client's interactive attach asks for it when the FRESH roster row
 * says live (`session_detail_controller.dart`), and the create flow records a
 * live intent as socket-local rather than durable Resume provenance
 * (`new_session_launch_controller.dart`). Resident and background attaches stay
 * bare Observe, which is exactly the keying argument above: authority is
 * socket-local because only the `#live` key carries it.
 *
 * So the Drive gate is NOT "the app cannot ask for this". It is a
 * controlled-rollout boundary for the WRITE SURFACE itself, and it stays
 * default-off until physical Kimi Drive qualification is done. With it off this
 * adapter presents exactly the K1 surface — observe-only capabilities, and no
 * create/model hooks at all, so the broker's presence probes report a tool that
 * cannot create sessions; with nothing able to create, the owned set stays empty
 * and `mode='live'` refuses through the same ownership conflict that refuses
 * foreign sessions. With it on, the K2 surface is present and reachable end to
 * end. Two gates rather than one because they answer different questions:
 * `COSYNCING_ENABLE_KIMI` is about clients that cannot decode the row at all,
 * this one is about qualifying a write surface independently of the read-only
 * integration.
 *
 * Not in this round, deliberately: takeover of terminal-created sessions,
 * native file/image input, agent/mode switching, and any lifecycle management
 * of the Kimi server itself.
 */
import {
  OwnershipConflictError,
  SessionCreateTemporarilyUnavailableError,
  type AgentBackend,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type ModelOption,
  type PromptInput,
  type SessionConnection,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { diagnoseKimiSetup } from './diagnostics.ts';
import {
  KIMI_INSTANCE_SCAN_MAX_FILES,
  KimiReadOnlyHttp,
  boundedDirectoryListing,
  kimiServerTokenPath,
  pidIsLive,
  readBoundedText,
  resolveKimiHome,
  resolveVerifiedInstance,
  scanKimiInstances,
  type KimiDiscoveredInstance,
  type KimiFetch,
  type KimiInstanceRefusal,
  type KimiInstanceScan,
  type KimiVerifiedInstance,
} from './server.ts';
import { KimiDriveHttp, type KimiWriteFetch } from './drive-http.ts';
import {
  KIMI_FOREIGN_DRIVE_REASON,
  KIMI_OBSERVE_ONLY_REASON,
  kimiOwnedControlState,
  kimiOwnedObserveControlState,
  mapKimiCreatedSession,
  mapKimiModelCatalog,
  mapKimiSessionPage,
  type KimiV1Session,
  type KimiV2SessionPage,
} from './mapping.ts';
import { KimiObserveConnection, type KimiObserveOptions } from './observe.ts';
import { KimiDriveConnection, type KimiDriveOptions } from './drive.ts';
import { kimiSessionWireRoot } from './usage.ts';

/** Sessions per discovery page. Kimi caps `page_size` at 100. */
const DISCOVERY_PAGE_SIZE = 50;

/** Discovery pages per sweep, so an enormous store cannot become unbounded roster work. */
const DISCOVERY_MAX_PAGES = 4;

/** One instance record is a handful of scalars; anything larger is not one. */
const INSTANCE_RECORD_MAX_BYTES = 8 * 1024;

/** The token file holds a single opaque token. */
const SERVER_TOKEN_MAX_BYTES = 4 * 1024;

/**
 * How long a LIVE attach waits for its socket to OPEN before refusing.
 *
 * Four seconds is generous for a loopback WebSocket handshake against a server
 * the identity gate just spoke to, and it is a CEILING, not an unbounded await:
 * a server that accepts the connection and then says nothing must not hang the
 * attach.
 *
 * What happens at the ceiling is the part that matters. The attach REFUSES —
 * see {@link KIMI_LIVE_ATTACH_NO_STREAM}. Poll-only is an honest degradation for
 * observe, where nothing can be written; for Drive it would hand the broker a
 * connection that can send prompts it cannot show approvals for and cannot
 * police for a second writer.
 */
export const KIMI_LIVE_ATTACH_SOCKET_MS = 4_000;

/**
 * Why a live attach whose stream never opened is refused rather than degraded.
 *
 * Names the DEPENDENCY, because that is what the caller can act on: the live
 * stream is the channel an approval request arrives on and the channel a
 * foreign writer is detected against, so mutation authority granted without it
 * is authority over a session this process can neither answer for nor watch.
 * The broker surfaces it as an attach failure and the client can retry — a
 * failure the user sees beats a Drive session that silently cannot deliver its
 * first permission card.
 */
export const KIMI_LIVE_ATTACH_NO_STREAM =
  'cosyncing could not open the live stream for this Kimi session, so it will not drive it: '
  + 'approval requests arrive on that stream, and it is also how cosyncing notices another program '
  + 'writing the same session. The session is available read-only, or try again in a moment.';

/**
 * Create-time model requests held for their session's first prompt.
 *
 * The server ignores `agent_config` on create, so a requested model can only be
 * applied per prompt; this holds it until then. An entry survives attach and is
 * dropped only when a prompt actually spends it, so a create whose session is
 * never PROMPTED would otherwise leave its entry forever — 64 is far more
 * never-prompted creates than one broker run accumulates, and evicting the
 * oldest costs at worst a first prompt that runs on the session default.
 */
export const KIMI_PENDING_MODEL_LIMIT = 64;

/** Why a foreign session refuses a live attach, in the caller's language. */
export const KIMI_FOREIGN_ATTACH_REFUSAL =
  'this Kimi session was not created through cosyncing in this session, so cosyncing cannot prove it '
  + 'has no other owner — a terminal running `kimi -S` may be driving it right now, and a second writer '
  + 'silently forks the session history. It is available read-only.';

/** Machine conflict category for the refusal above; the broker relays it as an `attach-conflict`. */
export const KIMI_FOREIGN_ATTACH_CONFLICT = 'kimi-foreign-session';

/** Why an attach was refused, in the caller's language. */
const ATTACH_REFUSAL: Record<KimiInstanceRefusal, string> = {
  none: 'no local Kimi server is running',
  ambiguous: 'several Kimi servers are running on this home; cosyncing will not guess which one owns the session',
  unreachable: 'the local Kimi server did not answer an authenticated capability probe',
  'identity-mismatch': 'the Kimi server on this port is not the one its registry record describes',
  incomplete: 'the Kimi instance registry holds more records than the bounded scan examines; cosyncing will not pick a server from a partial view',
};

/**
 * Opt-in flag for registering the Kimi adapter, DEFAULT OFF.
 *
 * Not a feature preference — a client-compatibility gate. `/api/agents` is not
 * revision-filtered, so a single Kimi row makes any client that decodes
 * `IntegrationKind` strictly throw, and because one unknown row aborts the whole
 * roster decode that client loses its ENTIRE roster, Kimi installed or not. The
 * first-party client decodes tolerantly from the contract revision that added
 * the `unknown` fallback onward; until every supported client has shipped that,
 * serving a Kimi row by default would break working installations for a feature
 * they are not using.
 *
 * Flip the default only once supported clients ship tolerant decoding. Spelling
 * follows the repo's existing `COSYNCING_*` truthy-env convention
 * (`COSYNCING_CODEX_SYNC_SERVER`).
 *
 * ACTIVATION SCOPE — foreground only, deliberately. The durable service
 * environment is a closed, enumerated, receipt-hashed list
 * (`brokerServiceEnvironmentEntries` in the broker's service-manager) and does
 * NOT carry this flag, so a systemd/launchd-managed broker cannot enable Kimi:
 * K1 is reachable only from a foreground `cosyncing` launch with the variable
 * set. That is intentional for a review-stage adapter — a persisted
 * feature-gate that setup writes into the service environment is a later
 * lifecycle round, and smuggling one variable past that closed list now would
 * bypass its receipts. The registration-gate suite pins this restriction.
 */
export const KIMI_ENABLE_ENV = 'COSYNCING_ENABLE_KIMI';

/**
 * The observe socket URL of a resolved instance.
 *
 * ONE derivation, used by the attach and by the reverifier it installs: two
 * copies could drift, and a socket url that disagreed with the client's origin
 * would put one connection's two transports on different servers.
 */
function wsUrlFor(instance: KimiDiscoveredInstance): string {
  return `${instance.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
}

/**
 * Opt-in flag for the DRIVE surface, DEFAULT OFF — the second gate.
 *
 * Registration and Drive are two different bets. {@link KIMI_ENABLE_ENV} is
 * about clients that cannot decode a Kimi roster row; this one is about
 * qualifying the WRITE SURFACE itself. Foreground clients do request
 * `mode='live'` (see the header), so what this gate withholds is not an
 * unreachable capability — it is a writer that has not yet been proven against
 * a real Kimi host. Until that physical pass, advertising Drive would put a
 * `live` attach mode, `supportsLiveAttach`, a model switcher and a create hook
 * in front of users on the strength of deterministic evidence alone.
 *
 * With this off the adapter is the K1 observe surface exactly: no live attach
 * mode, no model switch, and no create/prepare/list-models methods AT ALL. Their
 * absence is the point rather than a throwing stub — the broker probes for the
 * method (`runtime.ts:5136-5139`, `runtime.ts:1369`), so a defined method that
 * throws still advertises a creatable tool and a create button that fails.
 *
 * With no way to create, {@link KimiAdapter.ownedSessions} stays empty, every
 * roster row maps foreign, and a `mode='live'` attach refuses through the
 * ownership conflict that already exists. So the off state needs no mapping
 * change and no second refusal path.
 *
 * Flip the default once Kimi Drive has a physical pass against a real host.
 * Same truthy-env convention as every other `COSYNCING_*` flag.
 */
export const KIMI_DRIVE_ENV = 'COSYNCING_KIMI_DRIVE';

/** The repo's shared truthy-env reading, so two flags cannot drift into two spellings. */
function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

export function kimiRegistrationEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return envFlagEnabled(env[KIMI_ENABLE_ENV]);
}

export function kimiDriveEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return envFlagEnabled(env[KIMI_DRIVE_ENV]);
}

/**
 * The K1 surface: observe, and nothing that implies a writer.
 *
 * A fresh object per adapter, never a shared frozen singleton: `attachModes` is
 * a mutable array in the protocol type, and one adapter instance handing the
 * broker an array another instance could reach is a coupling nothing here needs.
 */
function kimiObserveCapabilities(): AgentCapabilities {
  return {
    integrationKind: 'http-websocket',
    attachModes: ['observe'],
    supportsObserve: true,
    // No `mode=resume`: this adapter never owns a Kimi process, so there is no
    // session for it to resume INTO.
    supportsResume: false,
    supportsLiveAttach: false,
    // The server has no "send this file to the user" signal; artifacts are
    // detected from content like every filesystem-only adapter.
    supportsNativeArtifact: false,
    // The prompt schema accepts image/file content parts, but nothing here
    // uploads bytes or resolves a workspace path into one yet, so claiming it
    // would advertise an input the adapter then refuses.
    supportsNativeFileInput: false,
    // Model selection is a WRITE — it rides the prompt body, and only a drive
    // connection sends one — so the observe surface cannot offer it.
    supportsModelSwitch: false,
    // Unchanged by the gate: this describes the approval scope the SERVER
    // offers — `'session'`, approve once and the rule applies to this session's
    // later calls — which is a fact about Kimi, not about what this adapter may
    // do with it.
    permissionGranularity: 'per-session',
  };
}

/** The K2 surface: observe for every session, plus Drive for the ones cosyncing created. */
function kimiDriveCapabilities(): AgentCapabilities {
  return {
    ...kimiObserveCapabilities(),
    // `observe` stays FIRST: it is the mode every session supports, and only the
    // ones this process created can be driven. Live attach joins the running
    // server; it never resumes one.
    attachModes: ['observe', 'live'],
    supportsLiveAttach: true,
    supportsModelSwitch: true,
  };
}

export interface KimiAdapterOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  /** Injected for deterministic tests; production reads the real instance registry. */
  instanceScan?: () => KimiInstanceScan;
  readToken?: (home: string) => string | undefined;
  fetchImpl?: KimiFetch;
  /**
   * The WRITE door's injected fetch, separate from {@link fetchImpl}.
   *
   * Two injection points rather than one because {@link KimiFetch} hardcodes
   * `method: 'GET'` in its own signature — half of what makes the read door
   * structurally incapable of writing — and widening it to a verb union would
   * erase that proof for a test-injection convenience. Production uses the real
   * `fetch` for both.
   */
  writeFetchImpl?: KimiWriteFetch;
  observe?: KimiObserveOptions;
  /** Injected only by tests: the live-attach socket ceiling. See {@link KIMI_LIVE_ATTACH_SOCKET_MS}. */
  liveAttachSocketMs?: number;
  /** Injected only by tests: the content-write stream ceiling. See `KIMI_WRITE_STREAM_WAIT_MS`. */
  writeStreamWaitMs?: number;
  /**
   * The Drive gate, injected. Wins over {@link KIMI_DRIVE_ENV} so a suite can
   * name the posture it is testing instead of arranging an environment for it.
   */
  drive?: boolean;
}

export class KimiAdapter implements AgentBackend {
  readonly id = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly capabilities: AgentCapabilities;

  /**
   * The create surface, PRESENT ONLY BEHIND THE DRIVE GATE.
   *
   * Assigned properties rather than class methods because the broker decides
   * what a tool can do by asking whether the method exists — `typeof
   * b.createSession === 'function'` builds the roster row
   * (`runtime.ts:5136-5139`) and `!backend?.createSession` answers the create
   * route (`runtime.ts:4496`). A method that exists and throws is still a tool
   * the app offers a create button for. Absent is the only way to say "no".
   */
  createSession?: (opts?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  }) => Promise<SessionInfo>;
  canCreateSession?: () => Promise<boolean>;
  prepareCreateSession?: () => Promise<void>;
  listModels?: () => Promise<ModelOption[]>;

  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly homeDir: string;
  private readonly options: KimiAdapterOptions;
  /** See {@link KIMI_DRIVE_ENV}. Decided once, at construction. */
  private readonly driveEnabled: boolean;

  /**
   * Sessions created through {@link createSession} in THIS process, and the
   * ONLY source of drive eligibility.
   *
   * In memory on purpose. A durable store would let a session created by a
   * previous broker run be driven after a restart — but the thing that changed
   * across that restart is precisely what cannot be checked: whether a terminal
   * picked the session up in between. Forgetting on restart is the fail-closed
   * answer, and a user-confirmed takeover is the feature that replaces it, not
   * a longer-lived guess. Divergence demotion REMOVES ids from here, so a
   * session proven to have another writer cannot regain Drive by reattaching.
   */
  private readonly ownedSessions = new Set<string>();

  /** Create-time model requests, applied to their session's first prompt. Bounded. */
  private readonly pendingModels = new Map<string, PromptInput['model']>();

  constructor(options: KimiAdapterOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? (process.env.HOME ?? '');
    this.driveEnabled = options.drive ?? kimiDriveEnabled(this.env);
    this.capabilities = this.driveEnabled ? kimiDriveCapabilities() : kimiObserveCapabilities();
    if (!this.driveEnabled) return;
    this.canCreateSession = () => this.probeCreateSession();
    this.prepareCreateSession = () => this.readyToCreateSession();
    this.listModels = () => this.readModelCatalog();
    this.createSession = (opts) => this.createOwnedSession(opts);
  }

  private home(): string {
    return resolveKimiHome(this.env, this.homeDir);
  }

  private scan(): KimiInstanceScan {
    if (this.options.instanceScan) return this.options.instanceScan();
    return scanKimiInstances(this.home(), {
      // Bounded at the ITERATION and the READ, not after the fact: a huge
      // registry directory costs the ceiling, and an oversized record costs
      // one ceiling-sized read that throws (counted invalid) — this runs on
      // the broker's discovery path.
      listFiles: (directory) => boundedDirectoryListing(directory, KIMI_INSTANCE_SCAN_MAX_FILES),
      readJson: (path) => JSON.parse(readBoundedText(path, INSTANCE_RECORD_MAX_BYTES)),
      pidAlive: (pid) => pidIsLive(pid, (target, signal) => process.kill(target, signal)),
    });
  }

  /**
   * The injected token reader, under the ceiling every reader here obeys.
   *
   * Same re-cap pattern the scan applies to injected io: an injected reader owes
   * the ceiling, and one that ignores it must still yield no credential rather
   * than a bearer header carrying whatever it returned. A reader that THROWS has
   * likewise produced no credential — the same answer an unreadable file gets —
   * and must not take the calling path down with it.
   *
   * One reader, one rule: the doctor path calls this too, so a diagnosis cannot
   * send a header the runtime would have refused.
   */
  private injectedToken(home: string): string | undefined {
    if (!this.options.readToken) return undefined;
    let injected: string | undefined;
    try {
      injected = this.options.readToken(home);
    } catch {
      return undefined;
    }
    if (injected !== undefined && Buffer.byteLength(injected, 'utf8') > SERVER_TOKEN_MAX_BYTES) {
      return undefined;
    }
    return injected;
  }

  private token(): string | undefined {
    if (this.options.readToken) return this.injectedToken(this.home());
    try {
      // Bounded at the READ, at the same ceiling the diagnosis path applies to
      // this file. An oversized read throws and therefore yields undefined —
      // the same answer as an unreadable file, which is correct: something
      // larger than the ceiling is not a token.
      const value = readBoundedText(kimiServerTokenPath(this.home()), SERVER_TOKEN_MAX_BYTES).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private client(instance: KimiDiscoveredInstance, token: string | undefined): KimiReadOnlyHttp {
    return new KimiReadOnlyHttp({
      baseUrl: instance.baseUrl,
      ...(token ? { token } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }

  /**
   * The write door for ONE verified instance and the token snapshot that
   * verified it.
   *
   * Built from the same two values as the read client and never independently
   * resolved: a write client pointing at a different base URL or carrying a
   * different token than the reads would authenticate as a different identity,
   * and a write is the one operation where landing on the wrong server cannot
   * be undone.
   */
  private driveClient(instance: KimiDiscoveredInstance, token: string | undefined): KimiDriveHttp {
    return new KimiDriveHttp({
      baseUrl: instance.baseUrl,
      ...(token ? { token } : {}),
      ...(this.options.writeFetchImpl ? { fetchImpl: this.options.writeFetchImpl } : {}),
    });
  }

  /** The ownership predicate handed to the mapper and to every posture decision. */
  private readonly isOwned = (id: string): boolean => this.ownedSessions.has(id);

  /**
   * The ONE door to a Kimi server. Every server-consuming path below —
   * `isAvailable`, `discoverSessions`, `attach` — goes through the identity gate
   * in {@link resolveVerifiedInstance}, so no route reaches a Kimi server
   * without it. Read that function's contract for the fail-closed cases and the
   * two residual risks it cannot close at this version.
   *
   * ONE token snapshot per operation, returned alongside the resolution:
   * verification, discovery, and the socket all authenticate as the same
   * identity, so a rotation between two reads cannot split one connection
   * across two credentials.
   */
  private async verifiedInstance(): Promise<{ resolved: KimiVerifiedInstance; token: string | undefined }> {
    const token = this.token();
    const resolved = await resolveVerifiedInstance(this.scan(), (instance) => this.client(instance, token));
    return { resolved, token };
  }

  async isAvailable(): Promise<boolean> {
    const { resolved } = await this.verifiedInstance();
    if (!resolved.ok) return false;
    const health = await resolved.http.getJson<{ ok?: unknown }>('/api/v1/healthz');
    return health.ok && health.data?.ok === true;
  }

  /**
   * Diagnosis runs ENTIRELY through the capability-limited context: record
   * content via the bounded `readText`, directory names via the bounded
   * `listDirectory`, and pid liveness via the effect-free `processAlive`.
   * Nothing here touches the filesystem or the process table directly, so the
   * context's ceilings and redaction hold for every read this diagnosis makes.
   */
  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    const home = resolveKimiHome(context.env, context.homeDir);
    const scan = scanKimiInstances(home, {
      listFiles: (directory) => {
        const listed = context.listDirectory(directory, KIMI_INSTANCE_SCAN_MAX_FILES);
        if (!listed.ok) throw new Error(listed.reason);
        // `truncated` travels into the scan: diagnosis must report an
        // unenumerable registry, not describe the subset it happened to see.
        return { names: [...listed.names], truncated: listed.truncated };
      },
      readJson: (path) => {
        const read = context.readText(path, INSTANCE_RECORD_MAX_BYTES);
        if (!read.ok) throw new Error(read.reason);
        return JSON.parse(read.text);
      },
      pidAlive: (pid) => context.processAlive(pid),
    });
    const tokenRead = context.readText(kimiServerTokenPath(home), SERVER_TOKEN_MAX_BYTES);
    const token = this.options.readToken
      ? this.injectedToken(home)
      : tokenRead.ok ? tokenRead.text.trim() || undefined : undefined;
    return diagnoseKimiSetup(context, { instances: scan, ...(token ? { token } : {}) });
  }

  /**
   * Bounded roster sweep over `GET /api/v2/sessions`.
   *
   * This listing is index-backed: it reports current titles and activity without
   * loading any session into the server, which is what makes it safe to run on a
   * store a terminal may be writing. History reads are NOT safe in that sense —
   * see {@link KimiObserveConnection.getHistory}.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const { resolved } = await this.verifiedInstance();
    if (!resolved.ok) return [];
    return this.discoverFrom(resolved.http, options);
  }

  /** Discovery against an ALREADY-RESOLVED server, so a caller can pin one instance. */
  private async discoverFrom(
    http: KimiReadOnlyHttp,
    options?: SessionDiscoveryOptions,
  ): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
      const result = await http.getJson<KimiV2SessionPage>('/api/v2/sessions', {
        page_size: DISCOVERY_PAGE_SIZE,
        'meta.archived': 'false',
        ...(options?.updatedAfter !== undefined ? { 'meta.updated_after': options.updatedAfter } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      if (!result.ok) break;
      // Ownership is applied AT MAP TIME, so one roster row can never be listed
      // as driveable and then attach as foreign.
      const mapped = mapKimiSessionPage(result.data, this.isOwned);
      sessions.push(...mapped.sessions);
      if (!mapped.hasMore || !mapped.nextPageToken) break;
      pageToken = mapped.nextPageToken;
    }
    return sessions;
  }

  /**
   * Attach routing: BOTH ownership and an explicit request are required to
   * drive. Ownership alone is only permission; the mode is the request.
   *
   *  - `live`      → owned ? drive : {@link OwnershipConflictError}. The broker
   *                  turns that into a structured `attach-conflict` and falls
   *                  back to Observe on the same socket, so the client keeps
   *                  its provenance instead of seeing a generic failure.
   *  - `observe`   → observe, on any session. Unchanged.
   *  - undefined   → OBSERVE ALWAYS, owned or not. An owned session gets the
   *                  supported-but-observing posture, so the client can still
   *                  see that Drive is available for it — it just was not asked
   *                  for. See the header for why a missing parameter must never
   *                  grant write authority: the hub keys an absent mode and
   *                  `'observe'` to one shared connection, so a bare attach's
   *                  authority is not socket-local.
   *  - `resume`    → refused. Nothing here owns a Kimi process to resume into.
   */
  async attach(sessionId: string, mode?: AttachMode): Promise<SessionConnection> {
    if (mode === 'resume') {
      throw new Error('kimi cannot resume a session: cosyncing never owns the Kimi process that runs it');
    }
    const owned = this.ownedSessions.has(sessionId);
    if (mode === 'live' && !owned) {
      throw new OwnershipConflictError(KIMI_FOREIGN_ATTACH_REFUSAL, KIMI_FOREIGN_ATTACH_CONFLICT);
    }
    const drive = mode === 'live' && owned;
    // One verified snapshot for the whole attach: discovery and the connection
    // it produces must talk to the SAME server, or the returned SessionInfo
    // would describe a session the connection never reads.
    const { resolved, token } = await this.verifiedInstance();
    if (!resolved.ok) {
      throw new Error(ATTACH_REFUSAL[resolved.reason]);
    }
    const { instance, http } = resolved;
    const known = (await this.discoverFrom(http)).find((session) => session.id === sessionId);
    const info: SessionInfo = known ?? {
      id: sessionId,
      tool: this.id,
      title: sessionId,
      status: 'idle',
      attachMode: 'observe',
      launchSurface: 'unknown',
      control: {
        drive: { state: 'observing', supported: false, reason: KIMI_FOREIGN_DRIVE_REASON },
        terminalSync: { supported: false, syncAvailable: false, active: false, reason: KIMI_OBSERVE_ONLY_REASON },
      },
    };
    // The POSTURE is decided here, not inherited from the roster row.
    //
    // `mapKimiSession` already applies the ownership predicate, but the roster
    // read can legitimately not contain this session at all — a create the
    // listing has not caught up with, or an `updatedAfter` window it fell
    // outside — and the synthesized fallback above is foreign-shaped. Attaching
    // an owned session on that fallback would hand the broker a `driving`
    // connection whose `control` says `supported: false`, and the authority
    // gate would then refuse every mutation on a socket the client was told it
    // could drive. So an owned session's control state is set unconditionally.
    //
    // An OWNED session that is not driving is a real posture, not a fallback:
    // drive is supported, this connection just is not doing it — because it was
    // opened in observe, or because nothing asked for `live`.
    if (owned) {
      info.attachMode = drive ? 'live' : 'observe';
      info.control = drive ? kimiOwnedControlState() : kimiOwnedObserveControlState();
    }
    const options: KimiDriveOptions = {
      // The journal root is derived from the SAME home every other path
      // derives from, so a spike install or a KIMI_CODE_HOME override reads
      // its own journals rather than the user's real ones. Injected options
      // win: a test names its own root.
      wireRoot: kimiSessionWireRoot(this.home()),
      // The verification above proves an identity for one moment; the
      // connection outlives it. A Kimi restart, a port another process now
      // owns, or a rotated token leaves the pinned client, url, and token
      // describing a server that is gone — re-sent forever, with no way back.
      // So the connection is given the gate itself: re-resolving runs the
      // WHOLE thing again — a fresh scan, the identity check, and one token
      // snapshot serving both transports — which is exactly what this attach
      // just did. A drive attach's replacement generation carries a MATCHING
      // write client, built from that same snapshot.
      reverify: async () => {
        const { resolved: current, token: currentToken } = await this.verifiedInstance();
        if (!current.ok) return undefined;
        return {
          http: current.http,
          wsUrl: wsUrlFor(current.instance),
          ...(currentToken !== undefined ? { token: currentToken } : {}),
          ...(drive ? { driveHttp: this.driveClient(current.instance, currentToken) } : {}),
        };
      },
      ...(this.options.observe ?? {}),
    };
    if (!drive) {
      return new KimiObserveConnection(info, http, wsUrlFor(instance), token, options);
    }
    // Handed to the connection but NOT dropped here. Handing a connection out
    // spends nothing: a client that opened the session and closed it before
    // prompting, or an attach whose socket died, would otherwise take the
    // create-time model choice with it and leave the next attach running the
    // first turn on the session default. The entry is dropped when the request
    // is actually SPENT, through `onModelConsumed` below.
    const pendingModel = this.pendingModels.get(sessionId);
    const connection = new KimiDriveConnection(info, http, wsUrlFor(instance), token, {
      ...options,
      ...(this.options.writeStreamWaitMs !== undefined
        ? { writeStreamWaitMs: this.options.writeStreamWaitMs }
        : {}),
      driveHttp: this.driveClient(instance, token),
      ...(pendingModel ? { pendingModel } : {}),
      // Demotion is the adapter's business too: the owned set is the single
      // source of drive eligibility, so a proven foreign writer has to remove
      // the session from it or the next attach would drive it again.
      onDemoted: (id) => {
        this.ownedSessions.delete(id);
        this.pendingModels.delete(id);
      },
      // The first successful prompt is the moment the request is spent; from
      // then on the session runs under whatever it settled on, and re-pinning
      // the create-time choice on a later attach would be the bug this replaces.
      onModelConsumed: (id) => {
        this.pendingModels.delete(id);
      },
    });
    // Bounded, and FATAL to the attach. Mutation authority is not granted
    // without the safety stream that carries approval requests back to the user
    // and makes a foreign writer visible: without it this connection could
    // start turns nobody can answer and fork a journal without noticing. The
    // connection is closed rather than abandoned — it has a poll timer running
    // by now, and a live attach that failed must leave nothing behind reading
    // (and force-loading) the session on the Kimi server.
    if (!(await connection.waitForStream(this.options.liveAttachSocketMs ?? KIMI_LIVE_ATTACH_SOCKET_MS))) {
      await connection.close();
      throw new Error(KIMI_LIVE_ATTACH_NO_STREAM);
    }
    return connection;
  }

  // ── Creation ──────────────────────────────────────────────────────────────

  /**
   * Can a session be created RIGHT NOW? One identity-gated probe, no side
   * effects. Presence of {@link createSession} is what makes the tool creatable
   * at all; this answers whether the server behind it is reachable this second.
   */
  private async probeCreateSession(): Promise<boolean> {
    const { resolved } = await this.verifiedInstance();
    return resolved.ok;
  }

  /**
   * The readiness boundary the broker runs BEFORE model validation and the one
   * create call. It creates nothing — it only converts "no reachable Kimi
   * server" into the typed 503 the client can act on, instead of a generic 500
   * from a create that was never going to work.
   */
  private async readyToCreateSession(): Promise<void> {
    const { resolved } = await this.verifiedInstance();
    if (resolved.ok) return;
    throw new SessionCreateTemporarilyUnavailableError(
      `${ATTACH_REFUSAL[resolved.reason]} — start it with \`kimi web --no-open\` and try again`,
      'kimi-server-unavailable',
    );
  }

  /**
   * The pre-session model catalog. Shares its mapping with the connection's own
   * `listModels`, so the model the broker validates a create against is decoded
   * exactly like the one a prompt later sends.
   */
  private async readModelCatalog(): Promise<ModelOption[]> {
    const { resolved } = await this.verifiedInstance();
    if (!resolved.ok) return [];
    const result = await resolved.http.getJson<unknown>('/api/v1/models');
    if (!result.ok) return [];
    return mapKimiModelCatalog(result.data);
  }

  /**
   * Create a session on the running Kimi server, and OWN it.
   *
   * `directory` is required and is never invented. The server registers a
   * workspace for an EXISTING directory and refuses one that is not there
   * (`FS_PATH_NOT_FOUND`, 40409) — it never creates the path — so a create with
   * no directory could only guess at one, and a guess is how a session ends up
   * rooted somewhere the user did not mean.
   *
   * A requested `model` is NOT sent here. The create schema accepts
   * `agent_config`, but the handler never reads it and the response always
   * reports an empty model, so sending it would look like a model selection
   * that silently did nothing. The request is held and applied to the session's
   * first prompt instead, which is the only place this server accepts one — and
   * the returned info advertises it so the picker preselects the right row.
   */
  private async createOwnedSession(opts?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  }): Promise<SessionInfo> {
    const directory = opts?.directory?.trim();
    if (!directory) {
      throw new Error('kimi needs an existing working directory to create a session in');
    }
    const { resolved, token } = await this.verifiedInstance();
    if (!resolved.ok) {
      throw new SessionCreateTemporarilyUnavailableError(
        `${ATTACH_REFUSAL[resolved.reason]} — start it with \`kimi web --no-open\` and try again`,
        'kimi-server-unavailable',
      );
    }
    const title = opts?.title?.trim();
    const outcome = await this.driveClient(resolved.instance, token).createSession({
      ...(title ? { title } : {}),
      metadata: { cwd: directory },
    });
    const info = mapKimiCreatedSession(outcome.data as KimiV1Session | undefined);
    if (!info) throw new Error('kimi create returned no session');
    this.ownedSessions.add(info.id);
    const model = opts?.model;
    if (model?.modelID) {
      this.rememberPendingModel(info.id, model);
      // Advertised on the returned info so the picker preselects what was
      // asked for, even though the session will not actually run under it until
      // its first prompt carries it.
      info.model = model.modelID;
      info.currentModel = { ...model };
    }
    return info;
  }

  private rememberPendingModel(sessionId: string, model: PromptInput['model']): void {
    this.pendingModels.set(sessionId, model);
    while (this.pendingModels.size > KIMI_PENDING_MODEL_LIMIT) {
      // Maps iterate in insertion order, so the first key is the oldest.
      const oldest = this.pendingModels.keys().next();
      if (oldest.done) break;
      this.pendingModels.delete(oldest.value);
    }
  }
}
