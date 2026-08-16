/**
 * Everything this package knows about reaching a DeepSeek Harness host: where it
 * listens, which `/api` routes may be produced at all, how one unary RPC is
 * enveloped and correlated, and how the two push-only downlink sockets are
 * opened, generation-tracked, and reconnected.
 *
 * Two structural postures are enforced HERE rather than by review:
 *
 *  1. ONE PATH BUILDER. {@link dshApiPath} is the only function in the package
 *     that produces an `/api/...` string, and it refuses any route outside
 *     {@link DSH_API_ROUTES}. Round 1 deliberately talks to eight unary methods
 *     plus `respond` and the two streams; every other method the host serves
 *     (settings, credentials, agent presets, directory access, fork, queue
 *     mutation, model selection, subagents, commands, skills, goals, export) is
 *     listed in {@link DSH_DEFERRED_RPC_METHODS} and is unreachable from here.
 *     A later round widens the allowlist on purpose, not by a stray fetch.
 *
 *  2. PUSH-ONLY SOCKETS. {@link DshSocketLike} has no `send`, so the downlink
 *     manager physically cannot write to the mux or host stream. The dsh
 *     protocol never expects a client frame on those sockets; every answer —
 *     including question and approval answers — travels over `POST /api/respond`
 *     instead.
 *
 * Captured against dsh 0.1.0-rc.6 (see `test/fixtures/dsh-0.1.0-rc.6.json`) and
 * checked against the upstream contract at
 * `packages/host/apiproxy/src/api/{rpc,events,sessions}.ts`.
 */

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
] as const);

export type DshRpcMethod = (typeof DSH_RPC_METHODS)[number];

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
// 0.1.0-rc.6), so the wiring round widens the allowlist by moving lines, not by
// re-deriving the surface. Not listed: `session.export` (a GET download route,
// not an RPC) and the Typert Remote namespaces (`commands/execute`,
// `goals/create`, `messageFeedback/put`, `pluginInventory/list`, …), which ride
// `POST /api/<namespace>/<method>` outside `RpcMethodMap`.
export const DSH_DEFERRED_RPC_METHODS: readonly string[] = Object.freeze([
  'session.fork',
  'session.updateQueue',
  'session.models',
  'session.selectModel',
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
  'llm.models',
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

/** Why a call did not produce a business value, in machine terms. */
export type DshTransportReason =
  | 'route-not-allowed'
  | 'unreachable'
  | 'timeout'
  | 'http-status'
  | 'invalid-envelope'
  | 'rpc-id-mismatch'
  | 'generation-lost';

/**
 * Envelope-shape reasons. dsh is a developer preview whose rc train may change
 * the wire contract between releases, so an unrecognized envelope FAILS CLOSED
 * with a drift diagnostic instead of being interpreted optimistically.
 */
export const DSH_VERSION_DRIFT_REASONS: readonly DshTransportReason[] =
  Object.freeze(['invalid-envelope', 'rpc-id-mismatch']);

export function isDshVersionDrift(failure: DshFailure): boolean {
  return failure.kind === 'transport' && DSH_VERSION_DRIFT_REASONS.includes(failure.reason);
}

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

export type DshFailure =
  /** The host answered, and answered with a typed business error. */
  | { kind: 'rpc'; code: string; message: string; details?: unknown }
  | { kind: 'transport'; reason: DshTransportReason; retryable: boolean; status?: number; detail?: string };

export type DshOutcome<T> = { ok: true; value: T } | { ok: false; failure: DshFailure };

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

export function describeDshFailure(failure: DshFailure): string {
  if (failure.kind === 'rpc') return `${failure.code}: ${failure.message}`;
  if (isDshVersionDrift(failure)) return dshVersionDriftDiagnostic(failure.detail ?? failure.reason);
  return failure.detail ? `${failure.reason} (${failure.detail})` : failure.reason;
}

// ── Unary RPC ───────────────────────────────────────────────────────────────

/**
 * The product's unary timeout convention. A dsh RPC either answers or the host
 * is wedged; waiting past this only holds a broker request open.
 */
export const DSH_UNARY_TIMEOUT_MS = 30_000;

/** Decoded-body ceiling. A history page is large; anything past this is not one. */
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

export interface DshFetchResponse {
  status: number;
  text(): Promise<string>;
  /**
   * The body as a byte stream, when the underlying fetch exposes one. The
   * client stops reading once MORE than maxBytes bytes have arrived, so
   * retention is bounded by the ceiling plus one transport chunk (a chunk
   * straddling the limit is held whole). The production fetch always provides
   * this stream. Injected fetches may omit it; the text() fallback then
   * enforces the same byte ceiling but only AFTER the body is fully allocated
   * — acceptable for tests, not a production path.
   */
  body?: AsyncIterable<Uint8Array> | null;
}

export type DshFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<DshFetchResponse>;

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

interface InFlight {
  controller: AbortController;
  cause?: 'timeout' | 'generation-lost';
}

/**
 * One unary caller for one host.
 *
 * Correlation is checked, not assumed: the client mints the `rpcId`, and a
 * response echoing a different one is drift rather than a late answer to reuse.
 * The method also travels inside the envelope (the host rejects a body whose
 * `method` disagrees with the path), so both halves come from the same
 * allowlisted constant.
 */
export class DshRpcClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: DshFetch;
  private readonly newRpcId: () => string;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly inFlight = new Set<InFlight>();

  constructor(options: DshRpcClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DSH_UNARY_TIMEOUT_MS;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<DshFetch>);
    this.newRpcId = options.newRpcId ?? (() => crypto.randomUUID());
    this.setTimeoutImpl = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
  }

  /** The origin this client talks to. Safe to log; carries no credential. */
  get origin(): string {
    return this.baseUrl;
  }

  /**
   * Fail every in-flight call with a RETRYABLE `generation-lost`.
   *
   * A downlink generation ending means the client's picture of the host is
   * stale, and a unary answer that arrives after that point describes a session
   * state nothing has re-baselined yet. Callers get a typed retryable failure
   * and re-issue after the re-baseline instead of mixing epochs.
   */
  abortInFlight(): void {
    for (const entry of this.inFlight) {
      entry.cause = 'generation-lost';
      entry.controller.abort();
    }
  }

  /**
   * `options.onRpcId` hands the caller the id this call was minted with. dsh
   * stamps that exact id onto the `user/message` a prompt produces, so it is the
   * only handle an adapter has for correlating a send with its own echo.
   */
  async call<T>(
    method: DshRpcMethod,
    payload: unknown,
    options?: { onRpcId?: (rpcId: string) => void },
  ): Promise<DshOutcome<T>> {
    if (!isDshRpcMethod(method)) {
      return {
        ok: false,
        failure: { kind: 'transport', reason: 'route-not-allowed', retryable: false, detail: String(method) },
      };
    }
    const rpcId = this.newRpcId();
    options?.onRpcId?.(rpcId);
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
    const raw = await this.post(method, body);
    if (!raw.ok) return raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      return this.drift('invalid-envelope', 'response body is not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.drift('invalid-envelope', 'response body is not an object');
    }
    const envelope = parsed as { type?: unknown; rpcId?: unknown; result?: unknown };
    if (envelope.type !== 'server-response') {
      return this.drift('invalid-envelope', `type "${String(envelope.type)}"`);
    }
    if (envelope.rpcId !== rpcId) {
      return this.drift('rpc-id-mismatch', `expected "${rpcId}", got "${String(envelope.rpcId)}"`);
    }
    const result = envelope.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return this.drift('invalid-envelope', 'result is not an object');
    }
    const outcome = result as { ok?: unknown; value?: unknown; error?: unknown };
    if (outcome.ok === true) return { ok: true, value: outcome.value as T };
    if (outcome.ok === false) {
      const error = (outcome.error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof error.code !== 'string') {
        return this.drift('invalid-envelope', 'error branch carries no code');
      }
      return {
        ok: false,
        failure: {
          kind: 'rpc',
          code: error.code,
          message: typeof error.message === 'string' ? error.message : error.code,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
    }
    return this.drift('invalid-envelope', 'result has no ok discriminant');
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
    const raw = await this.post(DSH_RESPOND_ROUTE, body);
    if (!raw.ok) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      return this.drift('invalid-envelope', 'receipt body is not JSON');
    }
    const receipt = (parsed ?? {}) as { accepted?: unknown; reason?: unknown };
    if (receipt.accepted === true) return { ok: true, value: { accepted: true } };
    if (receipt.accepted === false) {
      const reason = receipt.reason;
      // The contract defines exactly two refusal reasons; a missing or future
      // one is drift, because only `not-pending` may ever be read as "settled
      // elsewhere".
      if (reason !== 'not-pending' && reason !== 'bad-response') {
        return this.drift('invalid-envelope', `receipt reason "${String(reason)}"`);
      }
      return { ok: true, value: { accepted: false, reason } };
    }
    return this.drift('invalid-envelope', 'receipt has no accepted discriminant');
  }

  private drift<T>(reason: DshTransportReason, detail: string): DshOutcome<T> {
    return { ok: false, failure: { kind: 'transport', reason, retryable: false, detail } };
  }

  /**
   * The single network operation. `POST` and the JSON media type are literals:
   * the host answers 415 to anything else, and no caller may choose a verb.
   */
  private async post(route: string, body: string): Promise<DshOutcome<string>> {
    let url: string;
    try {
      url = `${this.baseUrl}${dshApiPath(route)}`;
    } catch {
      return {
        ok: false,
        failure: { kind: 'transport', reason: 'route-not-allowed', retryable: false, detail: route },
      };
    }
    const entry: InFlight = { controller: new AbortController() };
    this.inFlight.add(entry);
    const timer = this.setTimeoutImpl(() => {
      entry.cause ??= 'timeout';
      entry.controller.abort();
    }, this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: entry.controller.signal,
      });
      status = response.status;
      const read = await this.readBodyLimited(response);
      if (!read.ok) {
        return {
          ok: false,
          failure: { kind: 'transport', reason: 'http-status', retryable: false, status, detail: 'response too large' },
        };
      }
      text = read.text;
    } catch {
      const reason: DshTransportReason = entry.cause === 'generation-lost'
        ? 'generation-lost'
        : entry.cause === 'timeout' ? 'timeout' : 'unreachable';
      return { ok: false, failure: { kind: 'transport', reason, retryable: true } };
    } finally {
      this.clearTimeoutImpl(timer);
      this.inFlight.delete(entry);
    }
    // The host puts BUSINESS outcomes in the envelope and keeps HTTP for carrier
    // faults, so a non-200 is a carrier fault with no envelope to decode.
    if (status !== 200) {
      return { ok: false, failure: { kind: 'transport', reason: 'http-status', retryable: status >= 500, status } };
    }
    return { ok: true, value: text };
  }

  /**
   * Read the response under the byte ceiling BEFORE it is decoded. The size
   * limit exists to bound allocation, so checking `text().length` afterwards
   * would be both too late (the body is already fully read) and wrong (a
   * character count is not a byte count).
   *
   * The real guarantee, stated plainly: with a byte stream, retention is
   * bounded by maxBytes PLUS ONE TRANSPORT CHUNK — a chunk straddling the
   * ceiling is held whole, then the stream is abandoned (leaving the for-await
   * loop cancels it). The text() fallback exists for injected fetches without
   * a stream; it measures encoded BYTES but only after the full body is
   * allocated, and production fetch never takes it.
   */
  private async readBodyLimited(response: DshFetchResponse): Promise<{ ok: true; text: string } | { ok: false }> {
    if (response.body) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > this.maxBytes) return { ok: false };
        chunks.push(chunk);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true, text: new TextDecoder().decode(merged) };
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > this.maxBytes) return { ok: false };
    return { ok: true, text };
  }
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
