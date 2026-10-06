/**
 * DSH web browser authentication, server-side.
 *
 * `dsh web` gates every `/api` request and every WebSocket upgrade on a signed,
 * authority-bound cookie. The only way to obtain one is the index route:
 * `GET /?token=<launch token>`, which answers `303` with a `set-cookie` and a
 * redirect to `./`. A token on an API URL is NOT a login, and Node and Bun do
 * not inherit a browser's cookie jar, so an adapter that never performs the
 * exchange never gets past `401` however correct its requests are.
 *
 * What this module owns:
 *
 *  - the exchange, with redirects handled MANUALLY — a blind follow would send
 *    the token to whatever a hostile or misconfigured listener redirects to;
 *  - a small state machine so a missing credential, a refused credential, and a
 *    credential that needs renewing are three different answers with three
 *    different remedies, rather than one "host not ready" that restarts a
 *    process for all of them;
 *  - coalescing, so a roster sweep, a readiness probe, and three session
 *    attaches arriving at once spend ONE exchange;
 *  - the token's lifetime, which is strictly this launch: kept in private
 *    memory so an expired cookie can be renewed without restarting anyone's
 *    host, erased on every terminal event, and never written to disk.
 *
 * What it does not own: where the token came from (the managed-launch hook),
 * where the cookie is stored (an injected broker credential store), or the
 * Host/Origin fence, which is the server's check to make.
 */
import { createHash } from 'node:crypto';

/** States the session can be in. Every transition is asserted by tests. */
export const DSH_AUTH_STATES = Object.freeze([
  'absent',
  'exchanging',
  'authenticated',
  'rejected',
  'blocked',
] as const);
export type DshAuthState = typeof DSH_AUTH_STATES[number];

/** Why authentication stopped where it did, in machine terms. */
export type DshAuthReason =
  | 'no-credential'
  | 'token-exchanged'
  | 'token-invalid'
  | 'redirect-off-origin'
  | 'no-cookie-in-response'
  | 'host-or-origin-refused'
  | 'cookie-expired'
  | 'storage-unavailable'
  | 'exchange-unreachable'
  | 'credential-refused'
  | 'cancelled';

/**
 * Terminal reasons. Nothing a retry can fix: the remedy is a human action
 * (re-enroll, fix the address, restart the host), so the supervisor must not
 * spend a launch on them and the UI must not show a spinner.
 */
export const DSH_AUTH_BLOCKED_REASONS: readonly DshAuthReason[] = Object.freeze([
  'host-or-origin-refused',
  'credential-refused',
  'storage-unavailable',
]);

/** An opaque-enough credential record. The value is never parsed, only replayed. */
export interface DshCookie {
  name: string;
  value: string;
  /** Epoch milliseconds, when the server told us when it dies. */
  expiresAt?: number;
}

/**
 * Where a verified cookie lives between broker runs.
 *
 * `scope` is a caller-computed identity for one (endpoint, profile) pair. The
 * store must be able to hold more than one, because an operator legitimately
 * enrolls a second host; a flat "the dsh cookie" would silently replace the
 * first one.
 */
export interface DshCredentialStore {
  load(scope: string): Promise<DshCookie | null>;
  save(scope: string, cookie: DshCookie): Promise<void>;
  clear(scope: string): Promise<void>;
}

/**
 * What a credential read returned.
 *
 * `null` and "could not look" are different facts and have different remedies,
 * which is why this is a discriminated result rather than a nullable cookie. A
 * caller that conflates them tells an operator to re-enroll when the actual
 * problem is a credential file that exists and must not be replaced, and a
 * provider that refuses an unsafe file would be answered by overwriting it.
 */
export type DshCredentialLoad =
  | { kind: 'loaded'; cookie: DshCookie | null }
  | { kind: 'unavailable' };

/**
 * How the credential this session would put on the wire just changed identity.
 *
 * Reported to whoever is holding a connection open, because a WebSocket is
 * authenticated at handshake time and keeps that credential for its life. An
 * operator's `cosy dsh disconnect` withdraws the credential the carrier is
 * riding, and a re-enrollment replaces it; in both cases the live stream is now
 * speaking with a credential that no longer describes this enrollment, and the
 * only honest response is to end that generation rather than keep streaming on
 * the strength of a handshake nobody would authorize today.
 */
export type DshCredentialChange = 'adopted' | 'replaced' | 'removed';

export interface DshAuthResponseLike {
  status: number;
  headers: {
    get(name: string): string | null;
    /** Present on every modern fetch implementation; absent on hand-built test doubles. */
    getSetCookie?(): string[];
  };
}

export type DshAuthFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal },
) => Promise<DshAuthResponseLike>;

export interface DshAuthSessionOptions {
  /** Normalized API origin, e.g. `http://127.0.0.1:3080`. Never contains a token. */
  baseUrl: string;
  /** Identity this session's credential is stored and looked up under. */
  scope: string;
  store?: DshCredentialStore;
  fetchImpl?: DshAuthFetch;
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Exchange deadline. The index route is local and answers in milliseconds. */
  timeoutMs?: number;
  /**
   * How close to expiry counts as "about to expire".
   *
   * A cookie that is valid but dying is not a reason to interrupt anything, and
   * it is a very good reason to renew while the token that bought it is still in
   * hand. Without this window the adapter keeps a working credential right up
   * until the moment it stops working, which is exactly when the host may have
   * been restarted, the broker may have been restarted, and the token may be
   * gone — and re-enrolling an operator who never asked to be enrolled is a bad
   * way to find that out.
   */
  renewAheadMs?: number;
}

export interface DshAuthOutcome {
  state: DshAuthState;
  reason: DshAuthReason;
  /** Safe to log and to put in a diagnostic: names no secret and quotes no URL. */
  detail: string;
}

/** Default exchange budget. Generous for a local GET and short enough to be honest. */
export const DSH_AUTH_EXCHANGE_TIMEOUT_MS = 10_000;

/** How long to wait before retrying a renewal that could not reach the host. */
export const DSH_AUTH_RENEW_RETRY_MS = 60_000;

/** One day ahead of a 30-day default cookie. */
export const DSH_AUTH_RENEW_AHEAD_MS = 86_400_000;

/** Cookie name prefix the host uses. Checked, never relied on to construct one. */
const COOKIE_NAME_PREFIX = 'dsh-auth-';

/** Parse `Max-Age` / `Expires` out of a Set-Cookie string. Absent means "session cookie". */
function readExpiry(setCookie: string, now: number): number | undefined {
  const maxAge = /(?:^|;\s*)max-age=(\d+)/i.exec(setCookie)?.[1];
  if (maxAge !== undefined) {
    const seconds = Number(maxAge);
    return Number.isSafeInteger(seconds) ? now + seconds * 1000 : undefined;
  }
  const expires = /(?:^|;\s*)expires=([^;]+)/i.exec(setCookie)?.[1];
  if (expires === undefined) return undefined;
  const parsed = Date.parse(expires);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Whether two records name the same credential.
 *
 * Name and value only: an expiry the host restated for the same session is not a
 * new enrollment, and treating it as one would lift a refusal the same cookie
 * still deserves.
 */
function sameCookie(left: DshCookie, right: DshCookie | null): boolean {
  return right !== null && left.name === right.name && left.value === right.value;
}

/**
 * The authority-bound cookie name for an origin, computed the way the host
 * computes it: `dsh-auth-` plus base64url of the SHA-256 of the canonical
 * `host:port`.
 *
 * Kept for one narrow purpose — to recognise OUR cookie among whatever a
 * response or a cookie header carries. Nothing here mints a cookie value:
 * signing requires the host's secret, and an adapter that invented its own
 * credential would be a client that has decided its own authorisation.
 */
export function dshCookieNameForOrigin(baseUrl: string): string {
  const authority = new URL(baseUrl).host;
  return `${COOKIE_NAME_PREFIX}${createHash('sha256').update(authority).digest('base64url')}`;
}

/**
 * The token-free application URL for an origin.
 *
 * Split out from {@link parseDshLaunchUrl} because most of the adapter needs an
 * address to talk to and must not be handed the one string that is a credential.
 */
export function dshApplicationUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.search || url.hash) throw new Error('the API origin must not carry a query or fragment');
  return url.origin;
}

/**
 * A launch URL as `dsh web` prints it, with the credential held apart from the
 * address rather than inside it.
 */
export interface DshLaunchUrl {
  origin: string;
  token: string;
}

/**
 * Split `http://127.0.0.1:3080/?token=…` into its two halves and check the
 * address half against what we configured.
 *
 * The origin check is not paranoia about a typo. The token is a credential that
 * buys full control of an agent host, and it arrives from the stdout of a
 * process. A URL that names a different authority than the configured one is
 * either a misparse or a hostile child, and in both cases exchanging it would
 * hand the credential to somebody who did not earn it. `pathname` is checked
 * too: only the index route performs the exchange, so a launch URL pointing at
 * any other path could never have worked and is treated as the parse error it
 * is. The token itself is never echoed in a returned or thrown message.
 */
export function parseDshLaunchUrl(raw: string, expectedBaseUrl: string): DshLaunchUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DshAuthUrlError('the launch URL could not be parsed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DshAuthUrlError('the launch URL is not an http(s) address');
  }
  const expected = new URL(expectedBaseUrl);
  if (url.origin !== expected.origin) {
    throw new DshAuthUrlError(`the launch URL names an authority other than the configured ${expected.host}`);
  }
  if (url.pathname !== '/') {
    throw new DshAuthUrlError('the launch URL does not point at the index route that performs the exchange');
  }
  const tokens = url.searchParams.getAll('token');
  const token = tokens.length === 1 ? tokens[0] : undefined;
  if (token === undefined || token === '') {
    throw new DshAuthUrlError('the launch URL does not carry exactly one launch token');
  }
  return { origin: url.origin, token };
}

/** Safe-by-construction: every branch names the problem, never the value. */
export class DshAuthUrlError extends Error {
  constructor(detail: string) {
    super(`invalid DeepSeek Harness launch URL — ${detail}`);
    this.name = 'DshAuthUrlError';
  }
}

/**
 * One endpoint's authentication, for one broker process.
 *
 * The generation counter is what makes concurrent work safe. A credential
 * arriving for an endpoint that has since been replaced must not overwrite the
 * new one, an in-flight exchange that outlives its caller must not publish, and
 * a token belonging to a launch we no longer own must not be spent. Every
 * async hand-off here re-checks the generation it started under, and
 * {@link invalidate} is the single way to end one.
 */
export class DshAuthSession {
  private readonly baseUrl: string;
  private readonly scope: string;
  private readonly store?: DshCredentialStore;
  private readonly fetchImpl: DshAuthFetch;
  private readonly now: () => number;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly timeoutMs: number;
  private readonly renewAheadMs: number;

  private stateValue: DshAuthState = 'absent';
  private reasonValue: DshAuthReason = 'no-credential';
  private detailValue = 'no DeepSeek Harness credential has been exchanged for this endpoint yet';
  private cookie?: DshCookie;
  /** Private-memory-only credential. Never persisted, never logged, never returned. */
  private launchToken?: string;
  private generation = 0;
  /**
   * Launch/ownership revision. Separate from {@link generation} because the two
   * end work for different reasons: the generation ends when the whole scope is
   * replaced, this ends when the OWNERSHIP of the host changes — a new launch
   * token, a released child, a lost lock. Both must fence an exchange, or the
   * token from a host this broker stopped owning buys a cookie that a later
   * owner's state has to carry.
   */
  private ownership = 0;
  private inFlight?: Promise<DshAuthOutcome>;
  /**
   * The credential a refusal was about, for as long as that refusal stands.
   *
   * A refusal is an opinion about ONE credential, not a life sentence on the
   * scope: `credential-refused` means the value the host looked at is dead, and
   * the store may already hold a fresh one because `cosy dsh connect` runs in
   * another process. The block therefore survives only while the store still
   * answers with the very cookie that was refused, which is what stops a
   * refusal from becoming a request loop without also making a repair inert.
   */
  private refusedCookie?: DshCookie;
  /**
   * Whether the held credential is the enrolment's own record.
   *
   * Set when the credential came out of the store, or went into it and the write
   * completed. It is what makes an empty read mean "the enrolment was withdrawn"
   * rather than "my own write never landed", and those two need opposite
   * remedies: withdraw the credential, or keep serving with the one in hand.
   */
  private storeBacked = false;
  /** An observed withdrawal requires a usable enrollment before token renewal resumes. */
  private enrollmentWithdrawn = false;
  /** Bumped every time the usable credential changes identity; see {@link onCredentialChange}. */
  private revisionValue = 0;
  private readonly credentialHandlers = new Set<(change: DshCredentialChange, revision: number) => void>();
  /**
   * Store mutations, in order, one at a time.
   *
   * A credential store is an arbitrary async dependency, so two overlapping
   * saves can commit in either order regardless of which was asked for first.
   * Checking the fence AFTER an await on such a write proves only that nothing
   * had changed by the time the write finished; the write itself is already in
   * the file, and a superseded cookie left there comes back on the next process
   * start. So every mutation waits its turn and is re-authorized at the moment
   * it is about to be applied, which is the only point at which the check means
   * anything.
   */
  private storeQueue: Promise<void> = Promise.resolve();
  /** Not-before for the next renewal attempt. Retryable failures are retried, not hammered. */
  private renewalRetryAfter = 0;

  constructor(options: DshAuthSessionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.scope = options.scope;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<DshAuthResponseLike>);
    this.now = options.now ?? Date.now;
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DSH_AUTH_EXCHANGE_TIMEOUT_MS;
    this.renewAheadMs = options.renewAheadMs && options.renewAheadMs > 0
      ? options.renewAheadMs
      : DSH_AUTH_RENEW_AHEAD_MS;
  }

  /**
   * Whether the held credential needs replacing even though it still works.
   * Only answerable yes when the token is in hand: without it there is nothing
   * to trade, and letting a credential lapse into a re-enrollment prompt is
   * kinder than failing a request on a host that is fine.
   */
  private needsRenewal(now: number): boolean {
    if (this.launchToken === undefined) return false;
    // A renewal that failed on an unreachable host is retried, but on a clock
    // rather than per call. Without this every request inside the renewal window
    // fires its own GET at a host that is not answering, which is a request loop
    // wearing the costume of a background refresh.
    if (now < this.renewalRetryAfter) return false;
    const expiresAt = this.cookie?.expiresAt;
    return expiresAt !== undefined && expiresAt - now <= this.renewAheadMs;
  }

  get state(): DshAuthState {
    return this.stateValue;
  }

  get reason(): DshAuthReason {
    return this.reasonValue;
  }

  get detail(): string {
    return this.detailValue;
  }

  /** Whether the launch token for the current owned launch is still in hand. */
  get hasLaunchToken(): boolean {
    return this.launchToken !== undefined;
  }

  /**
   * Identity of the credential this session would currently send.
   *
   * A monotonic counter, not a value: two enrollments can legitimately produce
   * the same cookie bytes, and a holder that compared bytes would conclude
   * nothing changed when the enrollment underneath it did.
   */
  get credentialRevision(): number {
    return this.revisionValue;
  }

  /**
   * Watch the usable credential change. Fires for adoption, replacement and
   * removal, and only on an actual identity change.
   */
  onCredentialChange(handler: (change: DshCredentialChange, revision: number) => void): () => void {
    this.credentialHandlers.add(handler);
    return () => { this.credentialHandlers.delete(handler); };
  }

  /**
   * The one way this session's credential changes identity.
   *
   * Every write to the held cookie goes through here so a live carrier cannot be
   * left holding a credential that the store no longer supports. The identity of
   * the object itself is preserved when nothing changed, because the store-write
   * fences below compare held credentials by reference.
   */
  private publishCredential(next: DshCookie | undefined): void {
    const previous = this.cookie;
    const unchanged = (previous === undefined && next === undefined)
      || (previous !== undefined && next !== undefined
        && previous.name === next.name
        && previous.value === next.value
        && previous.expiresAt === next.expiresAt);
    this.cookie = next;
    if (unchanged) return;
    // No credential, no record: whatever the store holds afterwards is a new
    // fact rather than the absence of an old one.
    if (next === undefined) this.storeBacked = false;
    this.revisionValue += 1;
    const change: DshCredentialChange = previous === undefined ? 'adopted' : next === undefined ? 'removed' : 'replaced';
    for (const handler of [...this.credentialHandlers]) handler(change, this.revisionValue);
  }

  /** The `Cookie` header value for this endpoint, or null when unauthenticated. */
  cookieHeader(now = this.now()): string | null {
    if (!this.cookie || this.stateValue !== 'authenticated') return null;
    if (this.cookie.expiresAt !== undefined && this.cookie.expiresAt <= now) return null;
    return `${this.cookie.name}=${this.cookie.value}`;
  }

  /** Headers every API and WebSocket request on this endpoint must carry. */
  authHeaders(now = this.now()): Record<string, string> {
    const cookie = this.cookieHeader(now);
    return cookie ? { cookie } : {};
  }

  /**
   * Adopt the launch token for a process this broker owns.
   *
   * Replaces any previous token outright: one owned launch at a time, and a
   * replacement host's token invalidates the one from the host it replaced.
   */
  adoptLaunchToken(token: string): void {
    if (!token) return;
    if (this.launchToken !== undefined && this.launchToken !== token) {
      // A second token while one is already held means the host was restarted or
      // taken over. Anything being exchanged with the old one is stale, and a
      // cookie it produces is for a launch that no longer exists.
      this.ownership += 1;
      this.inFlight = undefined;
      // The replacement republishes the state rather than the attempt it just
      // invalidated. A fenced-off attempt must not write anything, but leaving
      // the session parked in "exchanging" would strand it, because the thing
      // that ended the attempt is the only other party that knows what the
      // session is now. A still-valid cookie survives; an unearned one does not.
      if (!(this.stateValue === 'authenticated' && this.cookieHeader() !== null)) {
        this.publishCredential(undefined);
        // A new launch is a new fact. Whatever this scope was refused for
        // belongs to the launch that has just been replaced.
        this.refusedCookie = undefined;
        this.renewalRetryAfter = 0;
        this.setState('absent', 'no-credential', this.noCredentialDetail());
      }
    }
    this.launchToken = token;
  }

  /**
   * Forget the launch token and any credential derived from it.
   *
   * Called on child exit, on losing ownership, on being replaced, and on
   * shutdown. The stored cookie is left alone when `keepCookie` is set, because
   * a cookie signed by the host's own secret outlives our knowledge of the
   * token that first bought it, and throwing it away would make the operator
   * re-enroll a host that is still perfectly authenticated.
   */
  releaseLaunchToken(keepCookie = true): void {
    this.ownership += 1;
    this.inFlight = undefined;
    this.launchToken = undefined;
    if (keepCookie) return;
    this.publishCredential(undefined);
    this.setState('absent', 'no-credential', 'no DeepSeek Harness credential has been exchanged for this endpoint yet');
  }

  /**
   * End this session. In-flight work is made stale before anything else happens
   * so a slow exchange cannot publish itself afterwards.
   */
  invalidate(): void {
    this.generation += 1;
    this.ownership += 1;
    this.inFlight = undefined;
    this.refusedCookie = undefined;
    this.enrollmentWithdrawn = false;
    this.publishCredential(undefined);
    this.launchToken = undefined;
    this.setState('absent', 'cancelled', 'the credential scope for this endpoint was replaced');
  }

  /**
   * Record that the host refused a request that ALREADY CARRIED our credential.
   *
   * This is not a retry and not a re-exchange. A cookie the host declines is
   * worthless for every future request, so it is dropped, and the stored copy
   * goes with it — leaving it would make the next broker start reload the same
   * dead value and call the host broken. A Host/Origin refusal (`403`) keeps the
   * stored cookie, because that refusal is about the address the request named,
   * not about the credential: an operator who repoints the adapter at the address
   * the host does accept should find their enrollment still there.
   */
  reportCredentialRefused(reason: 'credential-refused' | 'host-or-origin-refused' = 'credential-refused'): void {
    this.generation += 1;
    this.ownership += 1;
    this.inFlight = undefined;
    if (reason === 'credential-refused') {
      const cookie = this.cookie;
      this.enrollmentWithdrawn = true;
      this.publishCredential(undefined);
      if (cookie) void this.clearStored();
      // Remembered so a later readiness attempt can tell "this enrollment was
      // refused" from "this endpoint was never enrolled", and so the block
      // lifts the moment the store holds anything OTHER than this cookie.
      this.refusedCookie = cookie;
      this.setState('rejected', 'credential-refused',
        `the DeepSeek Harness host refused the session cookie cosyncing holds for ${new URL(this.baseUrl).host}. `
        + 'Run `cosy dsh connect` again to enroll a fresh one.');
      return;
    }
    this.refusedCookie = this.cookie;
    this.setState('blocked', 'host-or-origin-refused',
      `the DeepSeek Harness host refused requests addressed to ${new URL(this.baseUrl).host} `
      + '(the Host/Origin fence). Point cosyncing at the address the host itself printed.');
  }

  /**
   * Get to an authenticated state by the cheapest honest route: the credential
   * the enrollment holds, then an exchange with the token we already have.
   *
   * The enrollment is READ ON EVERY CALL, because it lives in a file another
   * process writes. `cosy dsh connect` and `cosy dsh disconnect` are the whole
   * reason that file exists, and a copy memoized here would make both of them
   * inert until the next broker restart: the operator enrolls, the running
   * broker carries on saying it has nothing, and the operator learns that the
   * CLI is a lie with a restart requirement nobody documented. What the read
   * costs is one small owner-only file behind a coalescing gate; what it buys is
   * that a warm adapter means exactly what a cold one does.
   *
   * Concurrent callers share one attempt. That is not an optimisation: two
   * exchanges spent from one launch is two `GET /` requests, and a host that
   * mints a fresh cookie per exchange would leave the first caller holding a
   * cookie the second has replaced.
   */
  ensure(): Promise<DshAuthOutcome> {
    if (this.inFlight) return this.inFlight;
    if (this.refusalStands()) return Promise.resolve(this.outcome());
    const generation = this.generation;
    let attempt!: Promise<DshAuthOutcome>;
    // Cleared by IDENTITY rather than by generation. A token can be replaced
    // while its exchange is running, and a replacement starts its own attempt
    // under the SAME scope generation; a finishing old attempt that clears by
    // generation then drops the new one's coalescing entry, and the next caller
    // fires a third exchange at a host already answering a second.
    attempt = this.attempt(generation).finally(() => {
      if (this.inFlight === attempt) this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * The one block that reading the enrollment again cannot lift.
   *
   * A Host/Origin refusal is a statement about the ADDRESS, and the address is
   * fixed for the life of this session, so firing the same request again is a
   * loop with no premise behind it. Every other block is a statement about a
   * credential or about being able to read it, and both are re-observable —
   * which is precisely how a repaired enrollment recovers a blocked session
   * without anyone restarting the broker.
   */
  private refusalStands(): boolean {
    return this.stateValue === 'blocked' && this.reasonValue === 'host-or-origin-refused';
  }

  private async attempt(generation: number): Promise<DshAuthOutcome> {
    // Both revisions are captured HERE, at entry, and every publication below
    // — including the held credential and the store writes — is authorized by
    // them. Ownership changes without touching the scope generation, so an
    // attempt fenced on generation alone still publishes a credential the
    // release of its launch token had already disowned.
    const ownership = this.ownership;
    const current = (): boolean => generation === this.generation && ownership === this.ownership;
    // A renewal starts from a credential that WORKS, and declaring it busy while
    // a background refresh is in flight would withdraw the very header the
    // caller is about to send. Only a session with nothing usable has to claim
    // it is on its way to something.
    const usableBefore = this.stateValue === 'authenticated' && this.cookieHeader() !== null;
    if (!usableBefore) {
      this.setState('exchanging', 'no-credential', 'authenticating with the DeepSeek Harness host');
    }
    // 1. The enrollment, read fresh. It is the cheapest credential there is, the
    //    one that survives a broker restart while the host stays up, and the
    //    authority on whether this endpoint is enrolled at all right now.
    const load = await this.loadStored();
    // The load is only a value until this point. A slow read that failed while
    // the scope was replaced must be able to do nothing at all, rather than
    // arrive and block a session the newer read authenticated.
    if (!current()) return this.outcome();
    if (load.kind === 'unavailable') {
      this.setState('blocked', 'storage-unavailable',
        'cosyncing could not read its stored DeepSeek Harness session. The credential file is present but '
        + 'not usable as-is; run `cosyncing repair`.');
      return this.outcome();
    }
    const stored = load.cookie;
    // A refusal was about ONE cookie, so a DIFFERENT cookie in the store is the
    // news that ends it — that is `cosy dsh connect` having done its job. An
    // EMPTY store is not that news. The refusal's own cleanup empties the store,
    // so treating empty as "new fact" would erase the one part of the diagnosis
    // an operator cannot reconstruct afterwards: that the cookie they enrolled
    // was the one the host threw back. It survives until something replaces it.
    if (this.refusedCookie !== undefined && stored !== null && !sameCookie(this.refusedCookie, stored)) {
      this.refusedCookie = undefined;
    }
    if (this.refusedCookie !== undefined) {
      // Neither the refused record nor its cleanup is a fresh enrollment.
      // Keep the refusal until the store supplies a different usable record;
      // the owned launch token must not silently undo that refusal.
      this.setState('blocked', 'credential-refused',
        stored === null ? this.noCredentialDetail()
          : `the DeepSeek Harness host refused the stored session cookie for ${new URL(this.baseUrl).host}. `
            + 'Run `cosy dsh connect` again to enroll a fresh one.');
      return this.outcome();
    }
    if (stored) {
      if (stored.expiresAt !== undefined && stored.expiresAt <= this.now()) {
        this.publishCredential(undefined);
        this.storeBacked = false;
        await this.clearStored(current);
        if (!current()) return this.outcome();
        this.setState('absent', 'cookie-expired', 'the stored DeepSeek Harness session has expired');
      } else {
        // From here the held credential IS the enrollment's record, so a later
        // empty read of that record means the enrollment was withdrawn.
        this.storeBacked = true;
        this.enrollmentWithdrawn = false;
        // A session that was blocked, refused or simply not yet authenticated
        // republishes; a warm one does not, so a routine re-read of the
        // enrollment cannot flicker readiness through "exchanging" on every call.
        if (this.stateValue !== 'authenticated') {
          this.setState('authenticated', 'token-exchanged', 'authenticated with the stored DeepSeek Harness session');
        }
        // Subscribers may immediately handshake with this credential. Publish
        // only after cookieHeader() can expose it as usable.
        this.publishCredential(stored);
        // A reused cookie still gets a renewal when the token is in hand AND the
        // cookie is nearing expiry: this is the broker-restart-onto-a-surviving-host
        // case, where the cookie was earned days ago and the current launch has
        // its own token. Renewal is bounded by the expiry window rather than by
        // "is a token in hand", because this path now runs on every readiness
        // call and an unconditional exchange would be a request loop.
        if (this.needsRenewal(this.now())) await this.exchange(generation);
        return this.outcome();
      }
    } else if (this.storeBacked) {
      // The store is the record of an enrollment THIS credential was written
      // into, and the record is gone: `cosy dsh disconnect` from another
      // process, or a repair that cleared a bad file. Carrying on authenticating
      // would have the broker serve a session its owner has just disconnected,
      // which is the one thing the CLI's no-restart promise has to get right in
      // both directions.
      //
      // A credential this process earned from a launch token and could NOT write
      // into the store (`storeBacked` false) is not such a record, and dropping
      // it would turn a broken credential file into a re-enrollment loop.
      this.storeBacked = false;
      this.enrollmentWithdrawn = true;
      this.publishCredential(undefined);
    }
    if (this.enrollmentWithdrawn) {
      // A launch token can renew an enrollment, but it cannot recreate one the
      // operator withdrew. Even a later token adoption must await a usable
      // record; ordinary expiry above remains eligible for owned renewal.
      this.setState('absent', 'no-credential', this.noCredentialDetail());
      return this.outcome();
    }
    // 2. The launch token, when we own the process that printed it.
    if (this.launchToken) {
      await this.exchange(generation);
      if (!current()) return this.outcome();
      // An exchange whose OWNERSHIP fence broke publishes nothing, which is
      // right, but it also cannot leave the session parked in "exchanging" for a
      // launch that no longer exists. Nothing was earned, a token is still held,
      // so the honest answer is that there is no credential yet.
      if (this.stateValue === 'exchanging') {
        this.setState('absent', 'no-credential', this.noCredentialDetail());
      }
      return this.outcome();
    }
    // 3. Nothing to trade. Say which, because "log in" and "there is no host"
    //    need different sentences from different people.
    this.setState('absent', 'no-credential', this.noCredentialDetail());
    return this.outcome();
  }

  private noCredentialDetail(): string {
    // The two states read differently to an operator even though the remedy
    // rhymes: "enroll this host" versus "the cookie you enrolled is dead". Only
    // the second is news, and it stops being news once the refused credential
    // has been replaced.
    if (this.refusedCookie !== undefined) {
      return `the DeepSeek Harness session cookie cosyncing held for ${new URL(this.baseUrl).host} was refused `
        + 'and has been dropped. Run `cosy dsh connect` with a URL from that host to enroll a fresh one.';
    }
    return this.store
      ? `cosyncing has no DeepSeek Harness session for ${new URL(this.baseUrl).host}. `
        + 'For a host you started, run `cosy dsh connect` and paste the URL dsh printed. '
        + 'For a host cosyncing starts, wait for it to report its launch URL.'
      : `cosyncing has no DeepSeek Harness session for ${new URL(this.baseUrl).host} and nowhere to keep one`;
  }

  private async exchange(generation: number): Promise<{ ok: boolean }> {
    const ownership = this.ownership;
    const token = this.launchToken;
    if (!token) return { ok: false };
    // The fence is captured BEFORE the request and checked after every await,
    // including the store write. Ownership can end mid-exchange: the child can
    // exit, the broker can lose its lock, or a new launch can hand over a new
    // token. An exchange that completes after that belongs to a launch this
    // process no longer owns, and publishing it would leave the current state
    // carrying a cookie for a host that has moved on — including in the store,
    // which is the part that outlives the process.
    const current = (): boolean => generation === this.generation && ownership === this.ownership;
    let cookie: DshCookie;
    try {
      const parsed = parseDshLaunchUrl(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, this.baseUrl);
      cookie = await this.exchangeWithToken(parsed);
    } catch (error) {
      if (!current()) return { ok: false };
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DshAuthTransportError) {
        // Nothing was refused, because nothing reached the host. The token is
        // still valid, and during a proactive renewal the cookie in hand is
        // still valid too — so a renewal that fails on a network hiccup must
        // leave both alone. Dropping the token here would convert one failed
        // GET into a permanent re-enrollment for a host that is fine.
        this.noteRetryable(message);
        this.renewalRetryAfter = this.now() + DSH_AUTH_RENEW_RETRY_MS;
        return { ok: false };
      }
      // An authoritative refusal. The token is spent: a host that has said no to
      // this URL will say no again, and re-firing it on every attempt is how a
      // refused credential turns into a request loop.
      this.launchToken = undefined;
      if (error instanceof DshAuthStatusError && error.reason === 'host-or-origin-refused') {
        this.setState('blocked', 'host-or-origin-refused',
          'the DeepSeek Harness host refused this address as its own. The Host header must name the host '
          + 'the server binds; cosyncing cannot fix that by retrying.');
        return { ok: false };
      }
      this.setState('rejected',
        error instanceof DshAuthStatusError ? error.reason : 'no-cookie-in-response',
        message.includes('— ') ? message : `the DeepSeek Harness launch URL was not accepted: ${message}`);
      return { ok: false };
    }
    if (!current()) return { ok: false };
    this.renewalRetryAfter = 0;
    // A fresh credential outranks whatever this scope was refused for.
    this.refusedCookie = undefined;
    this.setState('authenticated', 'token-exchanged', 'authenticated with the DeepSeek Harness host');
    this.publishCredential(cookie);
    // The write is authorized at its own commit boundary (see queueStore), so a
    // save that waits behind an earlier one and only reaches the file after the
    // scope has moved on never lands. Checking after the await would be too
    // late by then: the stale cookie would already be the persisted one.
    this.storeBacked = await this.persist(cookie, current);
    if (!current()) return { ok: false };
    return { ok: true };
  }

  /**
   * Record a retryable failure without dismantling anything.
   *
   * The distinction that matters is the one this method cannot make: whether the
   * cookie now in hand still works. It might, and it might not, and the answer
   * comes from the next request rather than from a failed renewal. So the state
   * stays where it was and only the detail moves, which is what lets a caller
   * keep working with an unexpired credential and still see why renewal lagged.
   */
  private noteRetryable(message: string): void {
    if (this.stateValue === 'authenticated') {
      this.detailValue = `the DeepSeek Harness session is still in use, but renewing it did not complete: ${message}`;
      return;
    }
    this.setState('absent', 'exchange-unreachable',
      `the DeepSeek Harness host could not be reached to exchange the launch token: ${message}`);
  }

  /** The one network operation in this file. Redirects are followed by hand. */
  private async exchangeWithToken(parsed: DshLaunchUrl): Promise<DshCookie> {
    const controller = new AbortController();
    const timer = this.setTimeoutImpl(() => controller.abort(), this.timeoutMs);
    let response: DshAuthResponseLike;
    try {
      response = await this.fetchImpl(`${parsed.origin}/?token=${encodeURIComponent(parsed.token)}`, {
        method: 'GET',
        headers: { accept: '*/*' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      // Named apart from a refusal on purpose. "Did not complete" says nothing
      // about the token and is not evidence about it; a 401 says the host looked
      // at the token and declined it. Those two need opposite follow-up.
      throw new DshAuthTransportError('the exchange request did not complete');
    } finally {
      this.clearTimeoutImpl(timer);
    }
    if (response.status === 401) throw new DshAuthStatusError(401, 'token-invalid', 'the DeepSeek Harness host refused the launch token');
    if (response.status === 403) throw new DshAuthStatusError(403, 'host-or-origin-refused', 'the DeepSeek Harness host refused this request address');
    // A host that is temporarily unable to serve has not evaluated the token at
    // all, and 429/503 are the ordinary shape of "start the host, come back". A
    // retryable transport failure and a credential refusal need opposite
    // follow-up, and the only difference between them here is the number.
    if (isRetryableExchangeStatus(response.status)) {
      throw new DshAuthTransportError(`the exchange host answered ${String(response.status)}`);
    }
    if (response.status !== 303 && response.status !== 302 && response.status !== 200) {
      throw new DshAuthStatusError(
        response.status,
        'token-invalid',
        `the index route answered ${String(response.status)} instead of authenticating`,
      );
    }
    const location = response.headers.get('location');
    if (location !== null && !isSameOriginRedirect(location, parsed.origin)) {
      throw new DshAuthStatusError(
        response.status,
        'redirect-off-origin',
        'the index route redirected away from the configured host, so no cookie was taken',
      );
    }
    const candidates = collectSetCookie(response);
    const wanted = dshCookieNameForOrigin(parsed.origin);
    const chosen = candidates.find((raw) => raw.startsWith(`${wanted}=`))
      // A host that renamed its cookie is still telling us which one it means;
      // take the first and let the value stay opaque rather than inventing a
      // name the server did not send.
      ?? candidates.find((raw) => raw.startsWith(`${COOKIE_NAME_PREFIX}=`))
      ?? candidates[0];
    if (chosen === undefined) {
      throw new DshAuthStatusError(
        response.status,
        'no-cookie-in-response',
        'the index route authenticated without issuing a session cookie',
      );
    }
    const pair = chosen.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) {
      throw new DshAuthStatusError(
        response.status,
        'no-cookie-in-response',
        'the issued session cookie was malformed',
      );
    }
    const expiresAt = readExpiry(chosen, this.now());
    return { name, value, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }

  private async loadStored(): Promise<DshCredentialLoad> {
    if (!this.store) return { kind: 'loaded', cookie: null };
    try {
      const stored = await this.store.load(this.scope);
      return { kind: 'loaded', cookie: stored };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /**
   * Queue a store mutation and authorize it at the instant it commits.
   *
   * `authorized` runs after every earlier mutation has finished, so it sees the
   * store as this session is about to write it. Returning false means the scope
   * moved on while this operation waited, and the write is dropped rather than
   * applied: the credential it carries belongs to a launch nobody owns or a
   * cookie something newer already replaced.
   */
  private queueStore(authorized: () => boolean, mutate: (store: DshCredentialStore) => Promise<void>): Promise<void> {
    const store = this.store;
    if (!store) return Promise.resolve();
    const run = async (): Promise<void> => {
      if (!authorized()) return;
      await mutate(store);
    };
    // The chain never rejects: a failed write is reported by the caller's detail,
    // and an aborted chain would strand every credential write behind it.
    const next = this.storeQueue.then(run, run);
    this.storeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private persist(cookie: DshCookie, authorized: () => boolean): Promise<boolean> {
    if (!this.store) return Promise.resolve(false);
    let written = false;
    return this.queueStore(
      () => authorized() && this.cookie === cookie,
      async (store) => {
        try {
          await store.save(this.scope, cookie);
          written = true;
        } catch {
          // Authentication WORKED; only remembering it failed. Saying so is worth
          // more than pretending it did not, and worth more than blocking a
          // session that is live right now.
          this.detailValue = 'the DeepSeek Harness session is active but could not be stored for the next start';
        }
      },
    ).then(() => written);
  }

  private clearStored(authorized: () => boolean = () => true): Promise<void> {
    if (!this.store) return Promise.resolve();
    // Captured now: clearing a scope that has since acquired a NEW cookie would
    // delete someone else's credential, and an expired-cookie clear racing a
    // successful exchange is exactly that race.
    const expected = this.cookie;
    return this.queueStore(
      () => authorized() && this.cookie === expected,
      async (store) => {
        try {
          await store.clear(this.scope);
        } catch {
          /* already unusable */
        }
      },
    );
  }

  private setState(state: DshAuthState, reason: DshAuthReason, detail: string): void {
    this.stateValue = state;
    this.reasonValue = reason;
    this.detailValue = detail;
    if (DSH_AUTH_BLOCKED_REASONS.includes(reason)) this.stateValue = 'blocked';
  }

  private outcome(): DshAuthOutcome {
    return { state: this.stateValue, reason: this.reasonValue, detail: this.detailValue };
  }
}

/**
 * The exchange never got an answer.
 *
 * Deliberately not a subclass of {@link DshAuthStatusError}: every refusal this
 * class is NOT, and the whole point is that a caller must be able to tell "no"
 * from "no reply" without re-reading a status code of 0.
 */
export class DshAuthTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshAuthTransportError';
  }
}

/**
 * A status-bearing exchange failure.
 *
 * Carries a number, a machine reason, and never a URL or a token. The reason
 * travels with the error rather than being inferred from it at the catch site
 * because the two refusal reasons here need different remedies: a bad token is
 * re-obtainable by restarting the host, while a cookie-less "success" means the
 * endpoint is not the dsh index route at all.
 */
export class DshAuthStatusError extends Error {
  constructor(
    readonly status: number,
    readonly reason: Extract<DshAuthReason, 'token-invalid' | 'redirect-off-origin' | 'no-cookie-in-response' | 'host-or-origin-refused'>,
    message: string,
  ) {
    super(message);
    this.name = 'DshAuthStatusError';
  }
}

/**
 * Whether an HTTP status is a temporary condition rather than a credential verdict.
 *
 * 5xx is the server failing to do its job, 429 is a limiter, and 408 is the
 * request timing out on the way in. None of them is an opinion about the token,
 * so none of them may retire a credential that still works. Everything else that
 * is not a redirect gets the refusal treatment, because an endpoint answering 404
 * to the index route is not a dsh host being temporary.
 */
export function isRetryableExchangeStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** `./` and `/…` are same-origin; anything with an origin in it must match ours. */
function isSameOriginRedirect(location: string, origin: string): boolean {
  if (location.startsWith('/') && !location.startsWith('//')) return true;
  try {
    return new URL(location, origin).origin === origin;
  } catch {
    return false;
  }
}

/** All Set-Cookie strings, across the two ways a fetch implementation exposes them. */
function collectSetCookie(response: DshAuthResponseLike): string[] {
  const many = response.headers.getSetCookie?.();
  if (many && many.length > 0) return many;
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * The credential scope for one endpoint and local profile.
 *
 * Hashed rather than raw because it is a filename component, and the two parts
 * that go into it are an address an operator may well have typed with a port
 * and a home directory that may contain anything at all. The profile is in the
 * scope for a real reason: `dsh web` signs its cookie with a secret that lives
 * in that DSH home, so a cookie earned against one profile is not a credential
 * for another even when both listen on the same port.
 */
export function dshCredentialScope(baseUrl: string, dshHome: string): string {
  const origin = new URL(baseUrl).origin;
  return createHash('sha256').update(`${origin}\u0000${dshHome}`).digest('hex').slice(0, 32);
}
