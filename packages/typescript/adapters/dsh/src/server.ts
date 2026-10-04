/**
 * The LEGACY (0.1.0-rc.6) web transport: where that host listens, which `/api`
 * routes it may be asked for at all, how one unary RPC is enveloped and
 * correlated, and how its two push-only downlink sockets are opened,
 * generation-tracked, and reconnected.
 *
 * The 0.2 carrier is a different module ({@link ./remote.ts}) and a different
 * route shape; the envelope they share is in {@link ./envelope.ts}. Nothing in
 * here reaches 0.2 and nothing there reaches 0.1. What survives in both
 * directions is the base-URL resolver, because the address of a host is not a
 * property of its protocol.
 *
 * Two structural postures are enforced HERE rather than by review:
 *
 *  1. ONE PATH BUILDER PER FAMILY. {@link dshApiPath} is the only function in
 *     this module that produces an `/api/...` string, and it refuses any route
 *     outside {@link DSH_API_ROUTES}. That surface is eleven unary methods
 *     ({@link DSH_RPC_METHODS}), the two `commands/*` Typert Remote endpoints
 *     ({@link DSH_REMOTE_METHODS}), `respond`, and the two streams; every other
 *     method that host serves (settings, credentials, agent presets, directory
 *     access, fork, queue mutation, subagents, skills, goals, export) is listed
 *     in {@link DSH_DEFERRED_RPC_METHODS} and is unreachable from here. The 0.2
 *     family enforces the same posture with its own allowlist, and widening
 *     either is an edit to a frozen list rather than a stray fetch.
 *
 *  2. PUSH-ONLY SOCKETS. {@link DshSocketLike} has no `send`, so the legacy
 *     downlink manager physically cannot write to the mux or host stream. That
 *     protocol never expects a client frame on those sockets; every answer —
 *     including question and approval answers — travels over `POST /api/respond`
 *     instead. The 0.2 carrier is the opposite: one socket, many logical
 *     streams, and `open`/`cancel` frames the client MUST be able to send.
 *
 * Captured against dsh 0.1.0-rc.6 (see `test/fixtures/dsh-0.1.0-rc.6.json`).
 * Retained as a live contract, not as history: an operator still running that
 * host keeps working, and retiring it is its own documented compatibility
 * decision rather than a side effect of adding the new one.
 */
import {
  DshUnaryTransport,
  transportFailure,
  type DshFetch,
  type DshGenerationLossPolicy,
  type DshOutcome,
  type DshTransportReason,
} from './envelope.ts';

// ── Where the host listens ──────────────────────────────────────────────────

/** Documented default listen address of `dsh web`. */
export const DSH_DEFAULT_BASE_URL = 'http://127.0.0.1:3080';

/** Operator override for a host on another port or loopback alias. */
export const DSH_BASE_URL_ENV = 'COSYNCING_DSH_BASE_URL';

/** Version this round's fixtures, mappings, and shape checks were captured against. */
export const DSH_FIXTURE_VERSION = '0.1.0-rc.6';

/**
 * A configured base URL this package refuses to use. The message is safe to
 * surface and to log: it NEVER embeds the configured value, which may carry
 * userinfo credentials.
 */
export class DshBaseUrlError extends Error {
  constructor(detail: string) {
    super(`invalid DeepSeek Harness base URL — ${detail}`);
    this.name = 'DshBaseUrlError';
  }
}

/**
 * Resolve the base URL, explicit option first, then the environment, then the
 * documented default.
 *
 * The value is parsed and normalized HERE, once, so every downstream consumer —
 * the unary client, the socket origin, and every diagnostic that quotes it as
 * evidence — sees the same sanitized origin:
 *
 *  - http(s) ONLY. Another scheme is a configuration error, not a host to probe.
 *  - userinfo is REDACTED. A credential in the URL would otherwise leak into
 *    logs and diagnostic evidence; dsh listens on loopback and has no use for it.
 *  - query and fragment are REFUSED. They are meaningless on an API origin and
 *    are exactly where a token would hide.
 *
 * Trailing slashes are stripped so path joining stays exact.
 */
export function resolveDshBaseUrl(
  env: Readonly<Record<string, string | undefined>> = {},
  configured?: string,
): string {
  const raw = configured?.trim() || env[DSH_BASE_URL_ENV]?.trim() || DSH_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DshBaseUrlError(`set ${DSH_BASE_URL_ENV} to a plain http(s) address like ${DSH_DEFAULT_BASE_URL}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DshBaseUrlError('only http and https addresses can reach a dsh host');
  }
  if (url.search || url.hash) {
    throw new DshBaseUrlError('query strings and fragments are not allowed on the API origin');
  }
  url.username = '';
  url.password = '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The `ws://`/`wss://` origin matching a resolved base URL. */
export function dshSocketOrigin(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws');
}

// ── Route allowlist ─────────────────────────────────────────────────────────

/**
 * The unary RPC methods round 1 may call. Hardcoded, frozen, and asserted by
 * `test/test-dsh-server.ts`: the set is the adapter's whole write and read
 * surface against the host.
 */
export const DSH_RPC_METHODS = Object.freeze([
  'host.describe',
  'workspace.list',
  'session.list',
  'session.history',
  'session.create',
  'session.prompt',
  'session.cancel',
  'session.rename',
  'session.models',
  'session.selectModel',
  'llm.models',
] as const);

export type DshRpcMethod = (typeof DSH_RPC_METHODS)[number];

/**
 * Typert Remote endpoints. A SECOND wire dialect on the same transport, kept in
 * its own constant because it is not interchangeable with an RPC method: these
 * are not in the host's `RpcMethodMap`, and their payload is
 * `{args:{…}}` with NAMED fields rather than a bare business payload.
 *
 * The generated contract
 * (`@deepseek-ai/dsh-commands/lib/typert.remote-client.d.ts`) declares them
 * positionally — `(agentId, line, signal?)` — but the gateway matches an object
 * against a field descriptor, so the names are load-bearing and are pinned by
 * `test-dsh-server.ts`. The installed 0.1.0-rc.6 host refuses anything else:
 * a bare payload answers "Remote payload must contain exactly one plain-object
 * args field", and a wrong field name answers "args fields do not match the
 * descriptor".
 */
export const DSH_REMOTE_METHODS = Object.freeze(['commands/list', 'commands/execute'] as const);

export type DshRemoteMethod = (typeof DSH_REMOTE_METHODS)[number];

export function isDshRemoteMethod(value: string): value is DshRemoteMethod {
  return (DSH_REMOTE_METHODS as readonly string[]).includes(value);
}

/**
 * The host's queue discipline for one prompt. `queue` hands the message to the
 * next turn claim; `steer` injects it into the turn already running.
 */
export type DshPromptMode = 'queue' | 'steer';

/** The answer route for a server-initiated question or approval. Not an RPC method. */
export const DSH_RESPOND_ROUTE = 'respond';

/** The two push-only downlink streams. */
export const DSH_MUX_ROUTE = 'events.mux';
export const DSH_HOST_ROUTE = 'events.host';

/** Every `/api` route this package may produce, unary and streaming alike. */
export const DSH_API_ROUTES: readonly string[] = Object.freeze([
  ...DSH_RPC_METHODS,
  ...DSH_REMOTE_METHODS,
  DSH_RESPOND_ROUTE,
  DSH_MUX_ROUTE,
  DSH_HOST_ROUTE,
]);

/**
 * Methods the host serves that round 1 deliberately does NOT implement. Listed
 * rather than merely omitted so the structural test can prove each one is
 * refused by {@link dshApiPath}, and so a later round adds a method by moving a
 * line rather than by discovering the gap in production.
 */
// The names below are the host's REAL method names (apiproxy `rpc-map.ts` at
// 0.1.0-rc.6), so a wiring round widens the allowlist by moving lines, not by
// re-deriving the surface — which is exactly how `session.models` and
// `session.selectModel` left this list, and later `llm.models` (the
// session-independent catalog the create dialog needs; `llm.providers` is a
// settings-surface view and `llm.discoverModels` carries a draft apiKey, so
// both stay deferred). Not listed: `session.export` (a GET download route, not
// an RPC) and the Typert Remote namespaces
// (`goals/create`, `messageFeedback/put`, `pluginInventory/list`, …), which ride
// `POST /api/<namespace>/<method>` outside `RpcMethodMap`; the two `commands/*`
// endpoints of that family are now allowlisted in {@link DSH_REMOTE_METHODS}.
//
// `session.attachment` stays here on purpose. It is a READ-back of one durable
// image the session log already references — not an upload route — so it buys
// no capability the prompt path does not already carry, and the host has no
// general file intake at all: `session.prompt` accepts exactly a text part and
// an image part.
export const DSH_DEFERRED_RPC_METHODS: readonly string[] = Object.freeze([
  'session.fork',
  'session.updateQueue',
  'session.search',
  'session.attachment',
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'subagent.interrupt',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'skill.list',
  'agentPreset.list',
  'agentPreset.select',
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.providers',
  'llm.discoverModels',
  'host.pickDirectory',
  'host.listDirectory',
  'host.createDirectory',
  'host.openPath',
]);

export function isDshRpcMethod(value: string): value is DshRpcMethod {
  return (DSH_RPC_METHODS as readonly string[]).includes(value);
}

/** Raised when a caller asks for a route outside {@link DSH_API_ROUTES}. */
export class DshRouteNotAllowedError extends Error {
  constructor(readonly route: string) {
    super(`dsh route "${route}" is outside the round-1 allowlist`);
    this.name = 'DshRouteNotAllowedError';
  }
}

/**
 * The ONE place an `/api` path is produced. Everything else in this package —
 * the unary client, the respond route, and both sockets — asks here, so the
 * reachable surface is exactly {@link DSH_API_ROUTES} and a test can prove it.
 */
export function dshApiPath(route: string): string {
  if (!DSH_API_ROUTES.includes(route)) throw new DshRouteNotAllowedError(route);
  return `/api/${route}`;
}

// ── Failures ────────────────────────────────────────────────────────────────
//
// The envelope, its failure taxonomy, and the byte-bounded reader live in
// `envelope.ts`, shared verbatim with the 0.2 Remote transport in `remote.ts`.
// They are re-exported here because this module was, and remains, the package's
// transport surface: nothing outside it constructs an `/api` path.

export {
  describeDshFailure,
  isDshVersionDrift,
  DSH_UNARY_MAX_BYTES,
  DSH_UNARY_TIMEOUT_MS,
  DSH_VERSION_DRIFT_REASONS,
  type DshFailure,
  type DshFetch,
  type DshFetchResponse,
  type DshGenerationLossPolicy,
  type DshOutcome,
  type DshTransportReason,
} from './envelope.ts';

/**
 * Operator-facing account of an envelope mismatch. Names the rc train, because
 * the realistic cause is a host from a different developer-preview build rather
 * than a broken install.
 */
export function dshVersionDriftDiagnostic(detail: string): string {
  return `The DeepSeek Harness host answered with a wire envelope this build does not recognize (${detail}). `
    + `cosyncing was verified against dsh ${DSH_FIXTURE_VERSION}; the developer-preview rc train can change the `
    + 'protocol between releases, so the adapter fails closed rather than guessing at the payload.';
}

/** Carrier receipt for an answered server-request; `accepted:false` is not an error. */
export type DshReceipt =
  | { accepted: true }
  /**
   * The wire defines exactly two refusal reasons. `not-pending` is the ONLY one
   * that proves another client settled the prompt; `bad-response` means our
   * payload was malformed and the prompt is still pending. Anything else fails
   * closed as contract drift in {@link DshRpcClient.respond} — a future reason
   * must never be read as "settled elsewhere".
   */
  | { accepted: false; reason: 'not-pending' | 'bad-response' };

// ── Unary RPC ───────────────────────────────────────────────────────────────

export interface DshRpcClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: DshFetch;
  /** Injected id minting keeps correlation assertions deterministic in tests. */
  newRpcId?: () => string;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface DshUnaryCallOptions {
  onRpcId?: (rpcId: string) => void;
  signal?: AbortSignal;
  generationLoss?: DshGenerationLossPolicy;
}

/**
 * The 0.1.0-rc.6 unary surface: one caller over {@link DSH_API_ROUTES}.
 *
 * A thin typed shell over {@link DshUnaryTransport}, which carries everything
 * that is actually load-bearing — minted correlation ids, the checked
 * `rpcId` echo, byte-bounded reads, caller deadlines, the generation-loss
 * policy, and the fail-closed envelope taxonomy. What this shell adds is the
 * allowlist and the two dialects the 0.1 host distinguishes: a bare business
 * payload for an `RpcMethodMap` method, and `{args:{…}}` for a Typert Remote.
 */
export class DshRpcClient {
  private readonly transport: DshUnaryTransport;

  constructor(options: DshRpcClientOptions) {
    this.transport = new DshUnaryTransport({
      baseUrl: options.baseUrl,
      pathFor: (route) => {
        try {
          return dshApiPath(route);
        } catch {
          return null;
        }
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.newRpcId === undefined ? {} : { newRpcId: options.newRpcId }),
      ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
      ...(options.clearTimeout === undefined ? {} : { clearTimeout: options.clearTimeout }),
    });
  }

  /** The origin this client talks to. Safe to log; carries no credential. */
  get origin(): string {
    return this.transport.origin;
  }

  /**
   * Fail every EPOCH-BOUND in-flight call with a RETRYABLE `generation-lost`.
   *
   * A downlink generation ending means the client's picture of the host is
   * stale, and a unary answer that arrives after that point describes a session
   * state nothing has re-baselined yet. Host-scoped and non-idempotent calls
   * survive; see {@link DshGenerationLossPolicy} for why those two are not the
   * same claim.
   */
  abortInFlight(): void {
    this.transport.abortInFlight();
  }

  /**
   * Call one `RpcMethodMap` method with a bare business payload.
   *
   * `options.onRpcId` hands the caller the id this call was minted with. dsh
   * stamps that exact id onto the `user/message` a prompt produces, so it is
   * the only handle an adapter has for correlating a send with its own echo.
   */
  call<T>(method: DshRpcMethod, payload: unknown, options?: DshUnaryCallOptions): Promise<DshOutcome<T>> {
    if (!isDshRpcMethod(method)) return refused<T>(method);
    return this.transport.call<T>(method, method, payload, options);
  }

  /**
   * Call one Typert Remote endpoint.
   *
   * Deliberately a SEPARATE entry point rather than a wider `call`. The two
   * dialects share an outer envelope and nothing else: a Remote endpoint is
   * absent from the host's `RpcMethodMap`, and its business arguments must be
   * wrapped in `args`. Folding them together would make a Remote name usable
   * with a bare payload — which the host rejects at runtime, one round trip
   * later, as an `internal` error rather than as the routing mistake it is.
   *
   * `args` is typed as a record because the gateway matches FIELD NAMES against
   * its descriptor; a positional array is refused.
   */
  callRemote<T>(
    method: DshRemoteMethod,
    args: Readonly<Record<string, unknown>>,
    options?: { signal?: AbortSignal },
  ): Promise<DshOutcome<T>> {
    if (!isDshRemoteMethod(method)) return refused<T>(method);
    return this.transport.call<T>(method, method, { args }, options);
  }

  /**
   * Answer one server-initiated question or approval.
   *
   * The reply body is a CARRIER RECEIPT, not an RPC envelope: `accepted:false`
   * with `not-pending` is the normal outcome when another client answered first,
   * so it is reported as a value rather than as a failure.
   */
  async respond(rpcId: string, value: unknown): Promise<DshOutcome<DshReceipt>> {
    const body = JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } });
    const raw = await this.transport.postJson(DSH_RESPOND_ROUTE, body);
    if (!raw.ok) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      return transportFailure('invalid-envelope', { retryable: false, detail: 'receipt body is not JSON' });
    }
    const receipt = (parsed ?? {}) as { accepted?: unknown; reason?: unknown };
    if (receipt.accepted === true) return { ok: true, value: { accepted: true } };
    if (receipt.accepted === false) {
      const reason = receipt.reason;
      // The contract defines exactly two refusal reasons; a missing or future
      // one is drift, because only `not-pending` may ever be read as "settled
      // elsewhere".
      if (reason !== 'not-pending' && reason !== 'bad-response') {
        return transportFailure('invalid-envelope', { retryable: false, detail: `receipt reason "${String(reason)}"` });
      }
      return { ok: true, value: { accepted: false, reason } };
    }
    return transportFailure('invalid-envelope', { retryable: false, detail: 'receipt has no accepted discriminant' });
  }
}

/** The refusal a caller gets for a name outside the allowlist, before any I/O. */
function refused<T>(route: string): Promise<DshOutcome<T>> {
  return Promise.resolve(transportFailure('route-not-allowed', { retryable: false, detail: String(route) }));
}
// ── Readiness / identity ────────────────────────────────────────────────────

export interface DshHostDescribe {
  /**
   * A PLACEHOLDER in every shipped build so far ("0.0.1"). Recorded for
   * diagnostics and never treated as a protocol version — gating on it would
   * pin the adapter to a number the product does not maintain.
   */
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

/**
 * Validate `host.describe` before anything downstream trusts the host.
 *
 * RESIDUAL, stated at the code site rather than buried in a note: dsh exposes NO
 * server identity field. `host.describe` proves something on that port speaks
 * the dsh contract; it cannot prove the process is the same one a previous call
 * reached, so a recycled port between two calls is undetectable here. Upstream
 * ask: a `hostInstanceId` on `host.describe`, which would let this become a real
 * identity gate instead of a shape gate.
 */
export function verifyDshHostDescribe(value: unknown): DshOutcome<DshHostDescribe> {
  const drift = (detail: string): DshOutcome<DshHostDescribe> => ({
    ok: false,
    failure: { kind: 'transport', reason: 'invalid-envelope', retryable: false, detail },
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drift('host.describe is not an object');
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== 'string' || !raw.version) return drift('host.describe.version');
  if (typeof raw.cwd !== 'string' || !raw.cwd) return drift('host.describe.cwd');
  if (typeof raw.attachedSessions !== 'number' || !Number.isFinite(raw.attachedSessions)) {
    return drift('host.describe.attachedSessions');
  }
  if (typeof raw.canOpenPath !== 'boolean') return drift('host.describe.canOpenPath');
  return {
    ok: true,
    value: {
      version: raw.version,
      cwd: raw.cwd,
      ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      attachedSessions: raw.attachedSessions,
      canOpenPath: raw.canOpenPath,
    },
  };
}

// ── Downlinks ───────────────────────────────────────────────────────────────

/**
 * The socket surface this package uses. Deliberately has NO `send`: both dsh
 * downlinks are push-only, and a write path that merely "is not called yet"
 * would be one refactor away from injecting frames into a stream the host owns.
 */
export interface DshSocketLike {
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export type DshSocketFactory = (url: string) => DshSocketLike;

export type DshStream = 'mux' | 'host';

/** One decoded downlink frame: a `server-request` whose payload is a stream frame. */
export interface DshDownlinkFrame {
  stream: DshStream;
  /** Echoed when answering an answerable frame (question/approval requested). */
  rpcId: string;
  /** The frame's discriminant, read from the payload with the envelope method as fallback. */
  frameType: string;
  payload: Record<string, unknown>;
  /**
   * Size of the raw frame in bytes (exact for a wire string; a serialized
   * estimate for an injected object). The pre-verification buffer budgets
   * retained bytes with it.
   */
  bytes: number;
}

/** A contained problem that must not take the connection down. */
export interface DshDownlinkDiagnostic {
  code: 'undecodable-frame' | 'socket-error' | 'frame-too-large';
  stream: DshStream;
  detail?: string;
}

export interface DshDownlinkHandlers {
  onFrame(frame: DshDownlinkFrame, generation: number): void;
  /** Both sockets are open; the caller now verifies host.describe and re-baselines. */
  onOpen(generation: number): void;
  /** The generation ended. Everything derived from it is stale. */
  onLost(generation: number, reason: string): void;
  onDiagnostic?(diagnostic: DshDownlinkDiagnostic): void;
}

export interface DshDownlinkOptions {
  baseUrl: string;
  socketFactory?: DshSocketFactory;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  reconnectDelayMs?: number;
}

/** Backoff floor between reconnect attempts, so a down host is not hammered. */
export const DSH_RECONNECT_DELAY_MS = 1_000;

/**
 * Hard ceiling on one downlink frame, measured on the raw message BEFORE it is
 * parsed. Generous — a real frame is a transcript event or a snapshot — and
 * absolute: anything past it is dropped as a contained diagnostic.
 */
export const DSH_FRAME_MAX_BYTES = 1_048_576;

/** Exact UTF-8 byte count without materializing a copy of the string. */
function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * The two push-only downlinks as ONE unit.
 *
 * dsh has no `since` replay in v1, so a stream is either whole or worthless:
 * losing either socket means the client may have missed events on both, and the
 * only correct answer is to end the generation, reopen both, re-verify the host,
 * and re-baseline. Generation numbers are what make that safe — a frame or a
 * socket callback from a superseded generation is dropped instead of being mixed
 * into the new epoch.
 */
export class DshDownlinks {
  private readonly baseUrl: string;
  private readonly socketFactory: DshSocketFactory;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly reconnectDelayMs: number;
  private sockets = new Map<DshStream, DshSocketLike>();
  private opened = new Set<DshStream>();
  private generationValue = 0;
  private started = false;
  private stopped = false;
  private reconnectHandle?: unknown;

  constructor(options: DshDownlinkOptions, private readonly handlers: DshDownlinkHandlers) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.reconnectDelayMs = options.reconnectDelayMs && options.reconnectDelayMs > 0
      ? options.reconnectDelayMs
      : DSH_RECONNECT_DELAY_MS;
  }

  get generation(): number {
    return this.generationValue;
  }

  /** Both sockets are open right now. Readiness also needs a verified host.describe. */
  get socketsOpen(): boolean {
    return this.opened.size === 2;
  }

  /**
   * Idempotent while running, and RESTARTABLE after a stop: the adapter keeps one
   * link — and so one of these — for its whole lifetime, so a session attaching
   * after the last one detached must get a fresh generation rather than a silent
   * no-op that leaves the caller reading history with no live frames.
   */
  start(): void {
    if (this.started) return;
    this.stopped = false;
    this.started = true;
    this.openGeneration();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.reconnectHandle !== undefined) {
      this.clearTimeoutImpl(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    this.closeSockets();
    // The epoch ends WITH the stop, not only with a failure. Socket callbacks
    // arrive asynchronously, so a 'close' from a socket of the stopped generation
    // can land after a later start(); without this bump it would pass the
    // `generation !== this.generationValue` guard and fail the NEW generation.
    this.generationValue += 1;
  }

  /**
   * End the current generation and schedule a fresh one. Idempotent per
   * generation: the second caller for the same epoch (both sockets closing, or a
   * `stream/error` followed by the close it causes) is a no-op.
   */
  failGeneration(reason: string): void {
    if (this.stopped) return;
    const generation = this.generationValue;
    this.closeSockets();
    this.generationValue += 1;
    this.handlers.onLost(generation, reason);
    if (this.reconnectHandle !== undefined) this.clearTimeoutImpl(this.reconnectHandle);
    this.reconnectHandle = this.setTimeoutImpl(() => {
      this.reconnectHandle = undefined;
      if (!this.stopped) this.openGeneration();
    }, this.reconnectDelayMs);
  }

  private closeSockets(): void {
    for (const socket of this.sockets.values()) {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
    this.opened.clear();
  }

  private openGeneration(): void {
    const generation = this.generationValue;
    for (const [stream, route] of [['mux', DSH_MUX_ROUTE], ['host', DSH_HOST_ROUTE]] as const) {
      let socket: DshSocketLike;
      try {
        socket = this.socketFactory(`${dshSocketOrigin(this.baseUrl)}${dshApiPath(route)}`);
      } catch (error) {
        this.handlers.onDiagnostic?.({
          code: 'socket-error',
          stream,
          detail: error instanceof Error ? error.message : String(error),
        });
        this.failGeneration(`${stream} socket could not be opened`);
        return;
      }
      this.sockets.set(stream, socket);
      socket.addEventListener('open', () => {
        if (generation !== this.generationValue) return;
        this.opened.add(stream);
        if (this.socketsOpen) this.handlers.onOpen(generation);
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generationValue) return;
        this.onMessage(stream, (event as { data?: unknown } | undefined)?.data ?? event);
      });
      socket.addEventListener('close', () => {
        if (generation !== this.generationValue) return;
        this.failGeneration(`${stream} socket closed`);
      });
      socket.addEventListener('error', () => {
        if (generation !== this.generationValue) return;
        this.handlers.onDiagnostic?.({ code: 'socket-error', stream });
      });
    }
  }

  private onMessage(stream: DshStream, raw: unknown): void {
    // Byte ceiling BEFORE parsing: an unverified or hostile endpoint could
    // otherwise make this client parse and retain arbitrarily large frames.
    const rawBytes = typeof raw === 'string' ? utf8ByteLength(raw) : undefined;
    if (rawBytes !== undefined && rawBytes > DSH_FRAME_MAX_BYTES) {
      this.handlers.onDiagnostic?.({ code: 'frame-too-large', stream, detail: `${rawBytes} bytes` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      this.handlers.onDiagnostic?.({ code: 'undecodable-frame', stream, detail: 'not JSON' });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.handlers.onDiagnostic?.({ code: 'undecodable-frame', stream, detail: 'not an object' });
      return;
    }
    const envelope = parsed as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
    if (envelope.type !== 'server-request' || typeof envelope.rpcId !== 'string') {
      this.handlers.onDiagnostic?.({ code: 'undecodable-frame', stream, detail: `type "${String(envelope.type)}"` });
      return;
    }
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.handlers.onDiagnostic?.({ code: 'undecodable-frame', stream, detail: 'payload is not an object' });
      return;
    }
    const record = payload as Record<string, unknown>;
    const frameType = typeof record.type === 'string' && record.type
      ? record.type
      : typeof envelope.method === 'string' ? envelope.method : '';
    if (!frameType) {
      this.handlers.onDiagnostic?.({ code: 'undecodable-frame', stream, detail: 'frame carries no type' });
      return;
    }
    this.handlers.onFrame({
      stream,
      rpcId: envelope.rpcId,
      frameType,
      payload: record,
      bytes: rawBytes ?? JSON.stringify(parsed).length,
    }, this.generationValue);
  }
}

function defaultSocketFactory(url: string): DshSocketLike {
  return new WebSocket(url) as unknown as DshSocketLike;
}
