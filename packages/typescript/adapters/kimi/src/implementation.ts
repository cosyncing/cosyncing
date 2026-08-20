/**
 * Kimi Code adapter — discovery, read-only observe, and Drive over the sessions
 * cosyncing itself created.
 *
 * Talks to the official local server started by `kimi web --no-open` over its
 * REST `/api/v1` + `/api/v2` surface and the `/api/v1/ws` cursor stream.
 *
 * It never CONFIGURES that server, and it performs no process effects itself.
 * It DESCRIBES the server to the broker — see
 * {@link KimiAdapter.describeManagedHost} — and the broker starts one when none
 * is running, supervises it, and stops it on exit. The installed service does
 * that by default; a foreground broker opts in. Either way the broker stops only
 * a process it can prove it started, so a server the user runs is never
 * touched.
 *
 * THE WRITE BOUNDARY, precisely. The only write door is the ten enumerated
 * methods of {@link KimiDriveHttp}. Nine of them are reachable only from a
 * {@link KimiDriveConnection} on a session in {@link KimiAdapter.ownedSessions}
 * — that is, one this process created through {@link KimiAdapter.createSession}.
 * The tenth, {@link KimiAdapter.renameSession}, is metadata-only (see its own
 * contract for why the fork risk below does not apply to it).
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
 * CONSEQUENCE. `mode='live'` IS reachable from the app, on the foreground path
 * only: `createdSessionAttachMode`
 * (`runtime.ts`) returns `'live'` when the session's own attach instruction is
 * live, the client's interactive attach asks for it when the FRESH roster row
 * says live (`session_detail_controller.dart`), and the create flow records a
 * live intent as socket-local rather than durable Resume provenance
 * (`new_session_launch_controller.dart`). Resident and background attaches stay
 * bare Observe, which is exactly the keying argument above: authority is
 * socket-local because only the `#live` key carries it.
 *
 * Drive is an ordinary capability of this adapter, permitted per session by
 * OWNERSHIP and the requested attach mode. It spent one round behind
 * `COSYNCING_KIMI_DRIVE`, a default-off rollout boundary for the write surface;
 * that gate is gone, because a flag nobody was expected to set meant the surface
 * most users would meet was the one that never shipped, and because the rule
 * that actually keeps a write safe — only a session this process created may be
 * driven — is enforced per attach and cannot be configured away. The
 * registration flag that used to sit beside it answered a different question
 * — which clients can decode this row —
 * and the broker now settles that per client from
 * {@link KimiAdapter.minimumClientRevision}, so nothing about qualifying the
 * write surface depends on hiding the agent from everyone.
 *
 * Not in this round, deliberately: native file/image input, and agent/mode
 * switching.
 */
import {
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  OwnershipConflictError,
  SessionCreateTemporarilyUnavailableError,
  type AgentBackend,
  type AgentMessage,
  type AgentCapabilities,
  type AgentSetupDiagnosis,
  type AttachMode,
  type AttachOptions,
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
import { basename, join } from 'node:path';
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
  KimiModelCatalogCache,
  kimiForeignControlState,
  kimiOwnedControlState,
  kimiOwnedObserveControlState,
  kimiStatusModel,
  mapKimiCreatedSession,
  mapKimiModelCatalog,
  mapKimiSessionPage,
  mapKimiSessionStatus,
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

/**
 * How long a broker-started `kimi web` has to answer its own health probe.
 *
 * Generous, because this is a server booting rather than a request: the cost of
 * being wrong in the short direction is killing a host that was about to work.
 */
export const KIMI_MANAGED_HOST_READY_MS = 20_000;

/** How long a stop waits after SIGTERM before escalating. */
export const KIMI_MANAGED_HOST_STOP_MS = 5_000;

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

/**
 * Why a takeover of a session this server does not list is refused.
 *
 * A takeover is authorized against a session the user can SEE. If discovery
 * does not return it, the synthesized fallback row would be the only evidence
 * it exists — and promoting on that would let a typo or a stale client id mint
 * Drive eligibility for an arbitrary string.
 */
export const KIMI_TAKEOVER_UNKNOWN_SESSION_REFUSAL =
  'cosyncing cannot take over this Kimi session because the Kimi server does not list it. It may have '
  + 'been deleted, or belong to a different Kimi home. Reload the session list and try again.';

/**
 * Why a takeover that raced a demotion is refused.
 *
 * The promotion had not committed when a foreign writer was proven on the same
 * session. Committing anyway would hand Drive to the loser of that race.
 */
export const KIMI_TAKEOVER_DEMOTED_REFUSAL =
  'cosyncing stopped taking over this Kimi session because another program was proven to be writing it '
  + 'while the takeover was still opening. The session is available read-only.';

/**
 * Why a second concurrent takeover of one session is refused.
 *
 * Defense in depth only — see the latch's own comment for why the hub already
 * prevents this for socket-driven attaches.
 */
export const KIMI_TAKEOVER_IN_FLIGHT_REFUSAL =
  'cosyncing is already taking over this Kimi session. Wait for that attempt to finish.';

/** Why an attach was refused, in the caller's language. */
/**
 * What to tell a caller whose create failed because no Kimi host was reachable.
 *
 * Deliberately does NOT name `kimi web`. The broker starts and supervises that
 * host itself wherever it is authorized to — by default under the installed
 * service — so telling a user to start one races the managed startup and invites
 * a SECOND server on the same home. That is the exact ambiguity ownership proof
 * exists to prevent, and it is already one of the refusal reasons below
 * (`ambiguous`), so the remediation for a missing host must not be able to
 * create it. Doctor is the honest pointer: it reports what is actually running
 * and whose it is, without starting anything.
 */
const KIMI_HOST_UNAVAILABLE_REMEDIATION = 'retry shortly, or run `cosyncing doctor`';

const ATTACH_REFUSAL: Record<KimiInstanceRefusal, string> = {
  none: 'no local Kimi server is running',
  ambiguous: 'several Kimi servers are running on this home; cosyncing will not guess which one owns the session',
  unreachable: 'the local Kimi server did not answer an authenticated capability probe',
  'metadata-invalid': 'the local Kimi server answered its capability probe with metadata cosyncing cannot read',
  'auth-bypassed': 'the local Kimi server has its bearer-token gate disabled, so answering cosyncing proves nothing about which server it is',
  unbindable: 'the Kimi instance registry record is missing the start time or version cosyncing needs to tie it to the server answering on that port',
  'startup-mismatch': 'the Kimi server on this port did not start when its registry record says it did',
  'version-mismatch': 'the Kimi server on this port reports a different version from the one its registry record records',
  incomplete: 'the Kimi instance registry holds more records than the bounded scan examines; cosyncing will not pick a server from a partial view',
};

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
 * The adapter's surface: observe every session, drive the ones cosyncing owns.
 *
 * A fresh object per adapter, never a shared frozen singleton: `attachModes` is
 * a mutable array in the protocol type, and one adapter instance handing the
 * broker an array another instance could reach is a coupling nothing here needs.
 *
 * Drive used to sit behind `COSYNCING_KIMI_DRIVE`, a default-off rollout gate
 * for a write surface that had not yet met a real Kimi host. It has now, so the
 * gate is gone rather than defaulted on: a flag nobody is expected to set is a
 * second configuration of the adapter that ships untested, and the checks that
 * actually keep a write safe are ownership and the attach mode, which are
 * enforced per session and cannot be turned off by an environment.
 */
function kimiCapabilities(): AgentCapabilities {
  return {
    integrationKind: 'http-websocket',
    // `observe` stays FIRST: it is the mode every session supports, and only the
    // ones this process created can be driven. Live attach joins the running
    // server; it never resumes one.
    attachModes: ['observe', 'live'],
    supportsObserve: true,
    // No `mode=resume`: this adapter never owns a Kimi process, so there is no
    // session for it to resume INTO.
    supportsResume: false,
    supportsLiveAttach: true,
    // TWO COSYNCING CLIENTS MAY SHARE ONE DRIVE CONNECTION, and this is what
    // makes that safe here: a joining socket is handed the EXISTING
    // {@link KimiDriveConnection} (`Hub.joinExisting` never attaches), so there
    // is still exactly ONE writer against the Kimi session — the same single
    // journal writer the whole ownership boundary above exists to guarantee.
    // Everything a second socket could race is already state this connection
    // shares with the terminal:
    //
    //  - a send's echo correlation is keyed by the SERVER's `user_message_id`
    //    (`drive.ts`, `clientKeys`), which is per submission, not per client;
    //  - an approval or question answered twice is the 40902/40909 race the
    //    resolve path already treats as an outcome rather than an error, and
    //    the losing claim is released so the card reports whose decision it
    //    actually was;
    //  - the divergence detector accounts for every row THIS connection
    //    caused, so a peer socket's prompt can never look like a foreign
    //    writer; and
    //  - a demotion emits the new control state to every subscriber at once,
    //    so both sockets lose Drive together instead of one keeping a stale
    //    claim.
    //
    // Without the flag a second client is never offered the join and sits on
    // its own read-only observe connection forever, which is the "one client
    // driving, the other observing" the 2026-08-20 pass reported.
    supportsCrossClientDriveSharing: true,
    // The server has no "send this file to the user" signal; artifacts are
    // detected from content like every filesystem-only adapter.
    supportsNativeArtifact: false,
    // Prompt content parts carry images inline (base64) and files through the
    // server's own `/api/v1/files` store (`drive.ts`, `assembleContent`), and
    // the broker's staging supplies the bytes — so the adapter can take what
    // the attach affordance offers.
    supportsNativeFileInput: true,
    // Model selection is a WRITE — it rides the prompt body, and only a drive
    // connection sends one, which the ones this process owns are.
    supportsModelSwitch: true,
    // The approval scope the SERVER offers — `'session'`, approve once and the
    // rule applies to this session's later calls — which is a fact about Kimi,
    // not about what this adapter may do with it.
    permissionGranularity: 'per-session',
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
   * How an executable name becomes an absolute path, injected so a suite can
   * describe a machine with or without Kimi installed without having either.
   */
  resolveExecutable?: (command: string) => string | undefined;
}

export class KimiAdapter implements AgentBackend {
  readonly id = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly capabilities: AgentCapabilities;
  /**
   * Registered for every client, shown only to those that can decode it.
   *
   * This replaces the `COSYNCING_ENABLE_KIMI` gate, which was never a
   * capability decision: the adapter was finished, but one kimi row made a
   * pre-tolerance client throw on the unknown integration kind and lose its
   * WHOLE roster. An environment flag answered that with "then nobody gets
   * Kimi", including the clients that could read it perfectly well. The broker
   * now answers per client instead.
   *
   * The floor is the INTEGRATION-KIND tolerance, not the later attach-mode one:
   * `http-websocket` is the only value here that a released client could fail to
   * decode, and both attach modes this adapter offers (`observe` and `live`)
   * have existed since long before either fallback. The registration suite pins
   * that reasoning against drift.
   */
  readonly minimumClientRevision = CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE;
  /**
   * A leg here is the identity read, the health read, and up to
   * {@link DISCOVERY_MAX_PAGES} session pages — every one of them against a
   * server this adapter never starts or stops. Unbudgeted, a server that
   * accepts connections and answers nothing would hold the roster for every
   * OTHER agent as well.
   */
  readonly discoveryBudgetMs = EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
  /**
   * The host is EXTERNAL: `kimi web` runs with or without this broker, so its
   * lifecycle is governed by proven ownership rather than by assumption. See
   * {@link KimiAdapter.describeManagedHost}.
   */
  readonly integration = { externalHost: { managed: true as const } };

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

  /**
   * Takeover promotions that have started and not yet committed or failed.
   *
   * DEFENSE IN DEPTH, and deliberately not the thing that stops two sockets
   * racing: `Hub.pending` installs its in-flight entry synchronously and
   * dedupes concurrent attaches on the same key, so two clients driving one
   * broker never reach a second promotion. This covers the callers the hub does
   * not mediate — a direct adapter consumer, and two Hub instances over one
   * adapter — where nothing else would.
   */
  private readonly promotionsInFlight = new Set<string>();

  /**
   * Sessions demoted while their takeover promotion was still in flight.
   *
   * A demotion arriving mid-promotion has nothing to remove: the promotion has
   * not added the session to {@link ownedSessions} yet. Recording it here is
   * what lets the commit barrier refuse, instead of adding eligibility a proven
   * foreign writer had just taken away.
   */
  private readonly demotedDuringPromotion = new Set<string>();

  /**
   * Drop a session's automatic Drive eligibility, and the create-time model
   * request that only makes sense while we hold it.
   *
   * ONE body for two callers that must never disagree: a proven foreign writer
   * (demotion) and the user handing control to the terminal. Both mean "this
   * process may no longer drive this session on its own", and if they ever
   * diverged, one of them would leave a session that re-acquires Drive on the
   * next attach without anyone asking for it.
   *
   * Idempotent by construction — `Set.delete` and `Map.delete` on an absent key
   * are no-ops — which is what the hub's contract for
   * {@link AgentBackend.releaseDriveEligibility} requires: a handoff after a
   * demotion has already revoked the same session must be a no-op, not a second
   * state change.
   */
  private revokeDriveEligibility(sessionId: string): void {
    // A demotion that lands mid-promotion must survive to the commit barrier.
    // `ownedSessions` does not contain the session yet — that is precisely what
    // committing would do — so this delete would be a silent no-op and the
    // barrier would then grant Drive to the writer that just lost the race.
    if (this.promotionsInFlight.has(sessionId)) {
      this.demotedDuringPromotion.add(sessionId);
    }
    this.ownedSessions.delete(sessionId);
    this.pendingModels.delete(sessionId);
  }

  /** See {@link AgentBackend.releaseDriveEligibility}. Terminal handoff calls this after the native
   *  owner has closed, so the observer the hub then builds cannot advertise Drive. */
  releaseDriveEligibility(sessionId: string): void {
    this.revokeDriveEligibility(sessionId);
  }

  constructor(options: KimiAdapterOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? (process.env.HOME ?? '');
    this.capabilities = kimiCapabilities();
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

  private client(
    instance: KimiDiscoveredInstance,
    token: string | undefined,
    cancel?: AbortSignal,
  ): KimiReadOnlyHttp {
    return new KimiReadOnlyHttp({
      baseUrl: instance.baseUrl,
      ...(token ? { token } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(cancel ? { signal: cancel } : {}),
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
  private async verifiedInstance(cancel?: AbortSignal): Promise<{ resolved: KimiVerifiedInstance; token: string | undefined }> {
    const token = this.token();
    const resolved = await resolveVerifiedInstance(this.scan(), (instance) => this.client(instance, token, cancel));
    return { resolved, token };
  }

  /**
   * Kimi's host is `kimi web` — a program the user may already be running, and
   * one the broker may start for them.
   *
   * Everything here is a READ: the registry the host itself maintains, and
   * whether an executable exists. The broker decides what, if anything, to do
   * with the answer.
   *
   * `null` — describing nothing at all — is returned for the two states where
   * no honest answer exists, and both are refusals this adapter already makes
   * elsewhere for the same reason ({@link resolveVerifiedInstance}):
   *
   *  - a TRUNCATED registry scan, which can prove neither "one server" nor
   *    "none", so any locator derived from it would be a guess;
   *  - MORE THAN ONE live instance, where naming one would be picking a server
   *    arbitrarily and the broker would then own the wrong process.
   */
  /**
   * The HOME, which is what `identityKey` below is, resolved for an environment
   * this adapter is not necessarily running in.
   *
   * Total and effect-free: a home is a path, and naming one asserts nothing about
   * whether a server is registered there. That is why the broker can ask it about
   * the installed service's environment while the adapter itself was constructed
   * with an operator's.
   */
  managedHostIdentity(inputs: ManagedHostIdentityInputs): string {
    return resolveKimiHome(inputs.env, inputs.homeDir);
  }

  async describeManagedHost(): Promise<ManagedHostDescriptor | null> {
    const scan = this.scan();
    if (scan.truncated || scan.live.length > 1) return null;
    const instance = scan.live[0];
    const executable = this.hostExecutable();
    return {
      // The HOME, not a base URL: `kimi web` chooses its own port, so the home
      // is what decides which registry — and therefore which server — this
      // record is about. A record written for one home proves nothing about a
      // server registered in another.
      identityKey: this.home(),
      // The registry already recorded the pid and the scan already proved it
      // live, so the broker never has to guess from a port.
      //
      // With no live instance this asserts ABSENT rather than unknown, and that
      // assertion is the only thing that can authorize starting a host at all.
      // It rests on two facts: the registry is kimi's own published index of its
      // running servers — the same index discovery already trusts to enumerate
      // them — and this scan COMPLETED, since a truncated one was refused above.
      // So "no live entry" here is a successful lookup that found nothing, not a
      // lookup that gave up. A server whose registry file was deleted underneath
      // it would be missed, and the cost of that is bounded and visible: the
      // second `kimi web` loses the port and exits, reported as a start failure.
      // No stranger is signalled on this path either way.
      locator: instance ? { kind: 'pid', pid: instance.pid } : { kind: 'absent' },
      launch: executable
        // `--no-open` because a broker starting a host must not also open a
        // browser on somebody's desktop.
        //
        // No `--port`: this adapter has not source-verified that `kimi web`
        // accepts one, and the whole design already assumes it picks its own
        // port and publishes it in the registry. Inventing a flag here would
        // produce a launch that silently does something other than what the
        // descriptor claims — the DSH mismatch, imported.
        ? { command: executable, args: ['web', '--no-open'], cwd: this.homeDir }
        : null,
      // The registry's own numbers, which is the only place kimi's chosen port
      // is ever written down. `profile` is the home, because that is what
      // decides which registry — and so which server — this record is about.
      serving: instance
        ? { port: instance.port, profile: this.home() }
        : { profile: this.home() },
      readyTimeoutMs: KIMI_MANAGED_HOST_READY_MS,
      stopGraceMs: KIMI_MANAGED_HOST_STOP_MS,
    };
  }

  /**
   * The `kimi` executable, PATH first and then the official installer's
   * location.
   *
   * The fallback exists because that install directory is not on a service
   * PATH by default, which the diagnostics module already had to account for:
   * an install that is present but off PATH is INSTALLED, and reporting it as
   * absent here would refuse to start a host that works perfectly well.
   */
  private hostExecutable(): string | undefined {
    const resolve = this.options.resolveExecutable ?? ((command: string) => Bun.which(command) ?? undefined);
    const onPath = resolve('kimi');
    if (onPath) return onPath;
    return resolve(join(this.homeDir, '.kimi-code', 'bin', 'kimi'));
  }

  async isAvailable(options?: AvailabilityOptions): Promise<boolean> {
    const { resolved } = await this.verifiedInstance(options?.signal);
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
    const { resolved } = await this.verifiedInstance(options?.signal);
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
  async attach(sessionId: string, mode?: AttachMode, opts?: AttachOptions): Promise<SessionConnection> {
    const takeover = mode === 'live' && opts?.reason === 'takeover';
    // Only an UNOWNED takeover is a promotion. A takeover of a session already
    // owned is an ordinary live attach that happens to carry the reason, and
    // must not take the latch or run the transaction.
    if (!takeover || this.ownedSessions.has(sessionId)) {
      return this.openAttach(sessionId, mode, takeover);
    }
    if (this.promotionsInFlight.has(sessionId)) {
      throw new OwnershipConflictError(KIMI_TAKEOVER_IN_FLIGHT_REFUSAL, KIMI_FOREIGN_ATTACH_CONFLICT);
    }
    this.promotionsInFlight.add(sessionId);
    this.demotedDuringPromotion.delete(sessionId);
    let settled = false;
    try {
      const connection = await this.openAttach(sessionId, mode, takeover);
      // The latch is HELD past this return, deliberately. Ownership is still
      // provisional until the broker admits the connection, so the window a
      // demotion has to be noticed extends to that moment too; releasing here
      // would let a demotion between the barrier and admission go unrecorded
      // and be committed anyway. `settlePromotion` releases it.
      settled = true;
      return connection;
    } finally {
      // Only the FAILURE path releases here. A promotion that never produced a
      // connection has nothing left to settle.
      if (!settled) {
        this.promotionsInFlight.delete(sessionId);
        this.demotedDuringPromotion.delete(sessionId);
      }
    }
  }

  /**
   * Settle ownership a promotion minted provisionally: the broker admitted the
   * connection (`commit`), or it did not and the connection is being closed.
   *
   * EXACT-GENERATION, which is the property that makes it safe to run late. It
   * settles only the promotion whose latch it still holds; a rollback arriving
   * after a NEWER promotion has already committed finds the latch gone and
   * touches nothing, so a rejected attempt can never revoke its successor's
   * eligibility. A blunt `ownedSessions.delete(sessionId)` here would do exactly
   * that.
   */
  private settlePromotion(sessionId: string, commit: boolean): boolean {
    // Not ours to settle: a later promotion already took the latch and
    // committed, or this one was settled once already.
    if (!this.promotionsInFlight.has(sessionId)) return false;
    const demoted = this.demotedDuringPromotion.has(sessionId);
    this.promotionsInFlight.delete(sessionId);
    this.demotedDuringPromotion.delete(sessionId);
    // No `await` between the check and the add.
    if (!commit || demoted) return false;
    this.ownedSessions.add(sessionId);
    return true;
  }

  /**
   * One synchronous `/status` read for the attach itself — the SAME route and
   * the SAME mapping ({@link mapKimiSessionStatus}) the observe poll uses, so
   * an attach and a poll can never decode the host's answer differently.
   *
   * Returns only the fields attach actually seeds: the roster-shaped model
   * string and the host-reported permission mode. Everything else the overlay
   * carries (context usage, plan/swarm flags) has the poll as its established
   * channel and would only duplicate it here.
   *
   * Total by construction: an unreachable server, a refused read, an odd
   * body, or a never-prompted session's empty config all yield `undefined`
   * rather than an attach failure or an invented value — the poll remains
   * the fallback for anything this read missed.
   */
  private async readAttachStatusOverlay(
    http: KimiReadOnlyHttp,
    sessionId: string,
    catalog: KimiModelCatalogCache,
  ): Promise<{ model?: string; currentModel?: SessionInfo['currentModel']; currentMode?: string } | undefined> {
    const result = await http.getJson<unknown>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
    );
    if (!result.ok) return undefined;
    // The catalog read is the label's only source, and it is TOTAL like the
    // status read above: a refused `/api/v1/models` yields no rows, the join
    // matches nothing, and the attach still seeds the bare alias.
    const options = await catalog.optionsFor(
      kimiStatusModel(result.data),
      () => this.readCatalogFrom(http),
    );
    const overlay = mapKimiSessionStatus(result.data, options).find(
      (message): message is Extract<AgentMessage, { type: 'metadata-update' }> =>
        message.type === 'metadata-update' && message.key === 'sessionInfo',
    );
    const value = overlay?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : undefined;
    const currentModel = record.currentModel as SessionInfo['currentModel'] | undefined;
    const currentMode = typeof record.currentMode === 'string' && record.currentMode.length > 0
      ? record.currentMode
      : undefined;
    if (!model && !currentMode) return undefined;
    return {
      ...(model ? { model } : {}),
      ...(currentModel ? { currentModel } : {}),
      ...(currentMode ? { currentMode } : {}),
    };
  }

  /** `/api/v1/models` against an ALREADY verified client — the attach's own generation. */
  private async readCatalogFrom(http: KimiReadOnlyHttp): Promise<ModelOption[]> {
    const result = await http.getJson<unknown>('/api/v1/models');
    if (!result.ok) return [];
    return mapKimiModelCatalog(result.data);
  }

  /**
   * The attach itself, with the promotion latch already held when one is owed.
   *
   * Split from {@link attach} so the latch has exactly one acquisition and one
   * release around every exit path, including the throws.
   */
  private async openAttach(
    sessionId: string,
    mode: AttachMode | undefined,
    takeover: boolean,
  ): Promise<SessionConnection> {
    if (mode === 'resume') {
      throw new Error('kimi cannot resume a session: cosyncing never owns the Kimi process that runs it');
    }
    const owned = this.ownedSessions.has(sessionId);
    // A live attach on a foreign session is still refused; what a takeover
    // changes is that the user has explicitly authorized this one. The refusal
    // for a live attach carrying NO takeover intent is unchanged.
    if (mode === 'live' && !owned && !takeover) {
      throw new OwnershipConflictError(KIMI_FOREIGN_ATTACH_REFUSAL, KIMI_FOREIGN_ATTACH_CONFLICT);
    }
    const promoting = takeover && !owned;
    const drive = mode === 'live' && (owned || takeover);
    // One verified snapshot for the whole attach: discovery and the connection
    // it produces must talk to the SAME server, or the returned SessionInfo
    // would describe a session the connection never reads.
    const { resolved, token } = await this.verifiedInstance();
    if (!resolved.ok) {
      throw new Error(ATTACH_REFUSAL[resolved.reason]);
    }
    const { instance, http } = resolved;
    const known = (await this.discoverFrom(http)).find((session) => session.id === sessionId);
    // A promotion is authorized against a session the user could see. The
    // synthesized fallback below is deliberately foreign-shaped and exists for
    // a create the listing has not caught up with; accepting it here would let
    // any unlisted id mint Drive eligibility for itself.
    if (promoting && !known) {
      throw new OwnershipConflictError(KIMI_TAKEOVER_UNKNOWN_SESSION_REFUSAL, KIMI_FOREIGN_ATTACH_CONFLICT);
    }
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
    // A promoting takeover is owned-in-waiting: the commit barrier below is the
    // only thing left between here and eligibility, and it either commits or
    // throws, so no connection is ever returned describing a posture it did not
    // get.
    if (owned || promoting) {
      info.attachMode = drive ? 'live' : 'observe';
      info.control = drive ? kimiOwnedControlState(sessionId, info.cwd) : kimiOwnedObserveControlState();
    }
    // ── Attach-time display seeding ─────────────────────────────────────────
    //
    // The composer's model picker and permission chip read `sessionInfo` from
    // THIS info object: the create response is spent on navigation alone, and
    // the 10 s `/status` poll would otherwise be the first time either field
    // reaches the client (on a fresh session with empty config, possibly
    // never). Seed both here, before the first session frame:
    //
    // - The create-time model choice still pending for this session, exactly
    //   as `createOwnedSession` advertises it — the roster row carries no
    //   model and the synthesized fallback above is bare. Only an OWNED
    //   session can have one: `pendingModels` is written by the create path
    //   and dropped with drive eligibility, so an entry implies ownership,
    //   and the `owned` guard keeps that invariant load-bearing rather than
    //   incidental. The entry is NOT consumed here — handing a connection
    //   out spends nothing; the first prompt does, via `onModelConsumed`.
    // - The host's OWN reported state, read once through the same route and
    //   mapping the poll uses, so the chip shows the real permission mode
    //   (and the roster-shaped model string) immediately rather than a
    //   default this adapter invented. A never-prompted session reports an
    //   empty config; the mapping's `optionalString` turns empty strings
    //   into ABSENT, which stays the honest answer — no chip, not a guessed
    //   one. A failed read seeds nothing and the poll remains the fallback.
    //   The model also arrives LABELLED: `/status.model` is the host catalog's
    //   own alias, so it joins `/api/v1/models` exactly and the roster shows
    //   the host's `display_name` instead of the client's guess at one. The
    //   cache is per ATTACH and is handed to the connection below, so the
    //   poll's own join costs no second read.
    const modelCatalog = new KimiModelCatalogCache();
    const attachStatus = await this.readAttachStatusOverlay(http, sessionId, modelCatalog);
    if (attachStatus?.model && !info.model) info.model = attachStatus.model;
    if (attachStatus?.currentModel && !info.currentModel) info.currentModel = attachStatus.currentModel;
    if (attachStatus?.currentMode) info.currentMode = attachStatus.currentMode;
    const pendingModel = owned ? this.pendingModels.get(sessionId) : undefined;
    if (pendingModel?.modelID) {
      info.model = pendingModel.modelID;
      // A create-time choice gets the SAME catalog label the host-reported one
      // does. `PromptInput.model` carries no label — the picker sends provider
      // and id — so without the join the roster falls back to its own guess for
      // the one session whose model this process itself chose. An id the
      // catalog does not know keeps exactly what the picker sent.
      const chosen = (await modelCatalog.optionsFor(
        pendingModel.modelID,
        () => this.readCatalogFrom(http),
      )).find((option) => option.modelID === pendingModel.modelID);
      info.currentModel = { ...pendingModel, ...(chosen ? { label: chosen.label } : {}) };
    }
    const options: KimiDriveOptions = {
      // The journal root is derived from the SAME home every other path
      // derives from, so a spike install or a KIMI_CODE_HOME override reads
      // its own journals rather than the user's real ones. Injected options
      // win: a test names its own root.
      wireRoot: kimiSessionWireRoot(this.home()),
      // The attach's catalog, so the poll labels a status reading from the rows
      // this attach already paid for.
      modelCatalog,
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
    const connection = new KimiDriveConnection(info, http, wsUrlFor(instance), token, {
      ...options,
      ...(this.options.writeStreamWaitMs !== undefined
        ? { writeStreamWaitMs: this.options.writeStreamWaitMs }
        : {}),
      driveHttp: this.driveClient(instance, token),
      ...(pendingModel ? { pendingModel } : {}),
      // Demotion is the adapter's business too: the owned set is the single
      // source of drive eligibility, so a proven foreign writer has to remove
      // the session from it or the next attach would drive it again. Shares one
      // implementation with terminal handoff — the two must never disagree about
      // what losing eligibility means.
      onDemoted: (id) => this.revokeDriveEligibility(id),
      // Present only for a promotion: an attach that already owned the session
      // has nothing provisional to settle.
      ...(promoting
        ? { settlePromotion: (commit: boolean) => this.settlePromotion(sessionId, commit) }
        : {}),
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
    // ── Promotion barrier ───────────────────────────────────────────────────
    //
    // `waitForStream` is the barrier because it is the point at which this
    // connection is proven able to carry approval requests back to the user and
    // to notice a foreign writer. Nothing above it may record ownership: a
    // promotion that committed earlier could hand out Drive eligibility on a
    // connection that then failed to open, leaving a foreign session
    // permanently marked ours.
    //
    // Passing the barrier still does not COMMIT. Ownership stays provisional
    // until the broker admits this connection as the session's owner, because
    // the broker can refuse — a superseded generation, an incumbent that
    // changed underneath, a hub shutting down — and closing a connection cannot
    // undo eligibility already recorded. A rejected promotion that had already
    // committed would leave the session drivable by the next ORDINARY live
    // attach, with no user confirmation anywhere in that path.
    //
    // Everything here is therefore rollback-safe: no write has been issued and
    // `ownedSessions` is untouched, so every failure path — including one the
    // broker causes after this returns — leaves the session a foreign Observe
    // exactly as it found it.
    if (promoting) {
      if (this.demotedDuringPromotion.has(sessionId)) {
        await connection.close();
        throw new OwnershipConflictError(KIMI_TAKEOVER_DEMOTED_REFUSAL, KIMI_FOREIGN_ATTACH_CONFLICT);
      }
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
      `${ATTACH_REFUSAL[resolved.reason]} — ${KIMI_HOST_UNAVAILABLE_REMEDIATION}`,
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
        `${ATTACH_REFUSAL[resolved.reason]} — ${KIMI_HOST_UNAVAILABLE_REMEDIATION}`,
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

  // ── Rename ────────────────────────────────────────────────────────────────

  /**
   * Native rename through the server's profile route — the reviewed exception
   * among the write door's ten methods.
   *
   * Deliberately NOT gated on {@link ownedSessions}: a title is metadata the
   * server applies through its own `ISessionMetadata.setTitle` and broadcasts
   * as `session.meta.updated`. It appends nothing to the wire journal, so the
   * two-writers-fork-the-journal case that gates every other write does not
   * exist here, and a terminal-owned session renamed in the app shows that name
   * in the terminal too — which a broker-side alias never could.
   *
   * `null` (a cleared display-title override) has no native expression — the
   * profile schema requires a non-empty string — so it resolves to the same
   * human-readable name codex uses for a cleared title, the session's cwd
   * basename; with no cwd on record there is nothing honest to write and the
   * call is a no-op, dsh-style.
   */
  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo | void> {
    const { resolved, token } = await this.verifiedInstance();
    if (!resolved.ok) {
      throw new Error(ATTACH_REFUSAL[resolved.reason]);
    }
    // The roster row supplies the cwd the null-case fallback is composed from,
    // and is the base the returned info is patched over, so an open session's
    // facts survive the rename rather than being reconstructed bare.
    const known = (await this.discoverFrom(resolved.http)).find((session) => session.id === sessionId);
    const name = title?.trim() || (known?.cwd ? basename(known.cwd) : '');
    if (!name) return;
    await this.driveClient(resolved.instance, token).renameSession(sessionId, { title: name });
    if (known) return { ...known, title: name };
    return {
      id: sessionId,
      tool: this.id,
      title: name,
      status: 'idle',
      attachMode: 'observe',
      launchSurface: 'unknown',
      control: kimiForeignControlState(),
    };
  }
}
