/**
 * The one implementation of the DSH HTTP RPC envelope.
 *
 * Both web contract families ride it. 0.1.0-rc.6 put dot-named methods at
 * `POST /api/<method>` and 0.2.0-rc.2 puts slash-named Typert Remote endpoints
 * at `POST /api/<namespace>/<method>`, but the carrier did not change: the same
 * `{type:'client-request', rpcId, method, payload}` body, the same
 * `{type:'server-response', rpcId, result:{ok,…}}` answer, and the same rule
 * that business outcomes live INSIDE the envelope while HTTP status is reserved
 * for carrier faults.
 *
 * That is why this is shared rather than copied. Correlation, cancellation,
 * byte ceilings, and the fail-closed drift taxonomy are the security-relevant
 * part of the transport, and a second copy of them would be a second place to
 * get wrong. What differs between families is which routes may be produced at
 * all and how the business payload is shaped, and both of those are injected:
 * `pathFor` is the allowlist, and callers own their payload.
 */

/**
 * The product's unary timeout convention. A dsh call either answers or the host
 * is wedged; waiting past this only holds a broker request open.
 */
export const DSH_UNARY_TIMEOUT_MS = 30_000;

/** Decoded-body ceiling. A history page is large; anything past this is not one. */
export const DSH_UNARY_MAX_BYTES = 24 * 1024 * 1024;

/** Why a call did or did not produce a business value, in machine terms. */
export type DshTransportReason =
  | 'route-not-allowed'
  | 'unreachable'
  | 'timeout'
  | 'http-status'
  | 'invalid-envelope'
  | 'rpc-id-mismatch'
  | 'generation-lost'
  | 'unauthenticated'
  | 'forbidden';

/**
 * Envelope-shape reasons. dsh is a developer preview whose rc train may change
 * the wire contract between releases, so an unrecognized envelope FAILS CLOSED
 * with a drift diagnostic instead of being interpreted optimistically.
 */
export const DSH_VERSION_DRIFT_REASONS: readonly DshTransportReason[] =
  Object.freeze(['invalid-envelope', 'rpc-id-mismatch']);

export type DshFailure =
  /** The host answered, and answered with a typed business error. */
  | { kind: 'rpc'; code: string; message: string; details?: unknown }
  | { kind: 'transport'; reason: DshTransportReason; retryable: boolean; status?: number; detail?: string };

export type DshOutcome<T> = { ok: true; value: T } | { ok: false; failure: DshFailure };

export function isDshVersionDrift(failure: DshFailure): boolean {
  return failure.kind === 'transport' && DSH_VERSION_DRIFT_REASONS.includes(failure.reason);
}

export function describeDshFailure(failure: DshFailure): string {
  if (failure.kind === 'rpc') return `${failure.code}: ${failure.message}`;
  return failure.detail ? `${failure.reason} (${failure.detail})` : failure.reason;
}

export function transportFailure(
  reason: DshTransportReason,
  options: { retryable: boolean; status?: number; detail?: string },
): { ok: false; failure: DshFailure } {
  return {
    ok: false,
    failure: {
      kind: 'transport',
      reason,
      retryable: options.retryable,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    },
  };
}

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

/**
 * Why a call does or does not die when a downlink generation ends.
 *
 * An enum rather than a boolean because the two survival reasons are NOT the
 * same claim, and collapsing them would let a future caller inherit an argument
 * that does not apply to it:
 *
 * - `epoch-bound` — the answer describes session state read under this
 *   generation. Mixing it with a re-baselined picture is the hazard
 *   {@link DshUnaryTransport.abortInFlight} exists to prevent, so it dies. The
 *   DEFAULT, because a call whose category nobody has thought about is safest
 *   re-issued.
 * - `host-scoped` — the answer describes the HOST (is it alive, what does it
 *   serve, which workspaces exist). A generation rotating underneath it does not
 *   make it wrong, and aborting it turns an unrelated rotation into a failure of
 *   whatever asked.
 * - `non-idempotent-write` — the outcome is already being decided upstream and
 *   aborting locally cannot undo it. Abandoning the answer does not cancel the
 *   write; it only loses the receipt, and a caller that retries on the resulting
 *   "retryable" failure duplicates the effect.
 *
 * Note the asymmetry: `host-scoped` survives because abandoning it is needlessly
 * destructive, `non-idempotent-write` because abandoning it is UNSAFE. "Abort by
 * default" is the right default for reads and is not a general safety argument
 * for writes.
 */
export type DshGenerationLossPolicy = 'epoch-bound' | 'host-scoped' | 'non-idempotent-write';

interface InFlight {
  controller: AbortController;
  cause?: 'timeout' | 'generation-lost';
  /** Absent means {@link DshGenerationLossPolicy} `epoch-bound`. */
  generationLoss?: DshGenerationLossPolicy;
}

export interface DshUnaryTransportOptions {
  baseUrl: string;
  /**
   * The route allowlist, as a function. Return the path or `null` to refuse;
   * nothing in this module can produce a path that was not handed back here, so
   * the reachable surface of a family is exactly what its allowlist contains.
   */
  pathFor(route: string): string | null;
  /** Extra request headers, evaluated per call so a rotated credential is picked up. */
  headers?: () => Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: DshFetch;
  /** Injected id minting keeps correlation assertions deterministic in tests. */
  newRpcId?: () => string;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface DshUnaryCallOptions {
  /**
   * Hands the caller the id this call was minted with. dsh stamps that exact id
   * onto the durable user message a prompt produces, so it can be the only
   * handle a caller has for correlating a send with its own echo.
   */
  onRpcId?: (rpcId: string) => void;
  /**
   * Lets a caller that has stopped waiting take the request down with it — the
   * discovery budget is the case it exists for. Reports as a RETRYABLE
   * `timeout`, which is what it is: the caller's deadline rather than the
   * transport's, expiring on a host that had not answered either way.
   */
  signal?: AbortSignal;
  /** What a downlink generation ending means for THIS call; see the policy type. */
  generationLoss?: DshGenerationLossPolicy;
}

/**
 * One unary caller for one host, over one route allowlist.
 *
 * Correlation is checked, not assumed: the client mints the `rpcId`, and a
 * response echoing a different one is drift rather than a late answer to reuse.
 * The method also travels inside the envelope (the host rejects a body whose
 * `method` disagrees with the path), so both halves come from one caller.
 */
export class DshUnaryTransport {
  private readonly baseUrl: string;
  private readonly pathFor: (route: string) => string | null;
  private readonly headers: () => Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: DshFetch;
  private readonly newRpcId: () => string;
  private readonly setTimeoutImpl: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly inFlight = new Set<InFlight>();

  constructor(options: DshUnaryTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.pathFor = options.pathFor;
    this.headers = options.headers ?? (() => ({}));
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DSH_UNARY_TIMEOUT_MS;
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DSH_UNARY_MAX_BYTES;
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
   * Fail every EPOCH-BOUND in-flight call with a RETRYABLE `generation-lost`.
   *
   * A downlink generation ending means the client's picture of the host is
   * stale, and a unary answer that arrives after that point describes a session
   * state nothing has re-baselined yet. Callers get a typed retryable failure
   * and re-issue after the re-baseline instead of mixing epochs.
   *
   * That reasoning holds only for `epoch-bound` answers. A liveness probe or a
   * workspace listing describes the host, not the epoch, and aborting one turns
   * an unrelated generation rotation into a failure of whatever issued it —
   * which is how a session create landing next to a live attach became
   * "DeepSeek Harness is temporarily unavailable", intermittently and with no
   * recorded cause. A non-idempotent write survives for a different and stronger
   * reason: the abort cannot reach the host, so dropping the answer loses the
   * receipt for an effect that already happened. See
   * {@link DshGenerationLossPolicy}.
   */
  abortInFlight(): void {
    for (const entry of this.inFlight) {
      if (entry.generationLoss && entry.generationLoss !== 'epoch-bound') continue;
      entry.cause = 'generation-lost';
      entry.controller.abort();
    }
  }

  /** Mint an id, send one envelope, and decode the answer. */
  async call<T>(
    route: string,
    method: string,
    payload: unknown,
    options?: DshUnaryCallOptions,
  ): Promise<DshOutcome<T>> {
    const rpcId = this.newRpcId();
    options?.onRpcId?.(rpcId);
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
    const raw = await this.postJson(route, body, options?.signal, options?.generationLoss);
    if (!raw.ok) return raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      return transportFailure('invalid-envelope', { retryable: false, detail: 'response body is not JSON' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return transportFailure('invalid-envelope', { retryable: false, detail: 'response body is not an object' });
    }
    const envelope = parsed as { type?: unknown; rpcId?: unknown; result?: unknown };
    if (envelope.type !== 'server-response') {
      return transportFailure('invalid-envelope', { retryable: false, detail: `type "${String(envelope.type)}"` });
    }
    if (envelope.rpcId !== rpcId) {
      return transportFailure('rpc-id-mismatch', {
        retryable: false,
        detail: `expected "${rpcId}", got "${String(envelope.rpcId)}"`,
      });
    }
    const result = envelope.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return transportFailure('invalid-envelope', { retryable: false, detail: 'result is not an object' });
    }
    const outcome = result as { ok?: unknown; value?: unknown; error?: unknown };
    if (outcome.ok === true) return { ok: true, value: outcome.value as T };
    if (outcome.ok === false) {
      const error = (outcome.error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
      if (typeof error.code !== 'string') {
        return transportFailure('invalid-envelope', { retryable: false, detail: 'error branch carries no code' });
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
    return transportFailure('invalid-envelope', { retryable: false, detail: 'result has no ok discriminant' });
  }

  /** Post one body and hand back the raw text. `respond` and the capture runner use this. */
  async postJson(
    route: string,
    body: string,
    cancel?: AbortSignal,
    generationLoss?: DshGenerationLossPolicy,
  ): Promise<DshOutcome<string>> {
    const path = this.pathFor(route);
    if (path === null) {
      return transportFailure('route-not-allowed', { retryable: false, detail: route });
    }
    const url = `${this.baseUrl}${path}`;
    // Checked before the socket is opened, not only linked to it: a caller whose
    // deadline has already passed must not spend a connection on this host.
    if (cancel?.aborted) return transportFailure('timeout', { retryable: true });
    const entry: InFlight = {
      controller: new AbortController(),
      ...(generationLoss ? { generationLoss } : {}),
    };
    this.inFlight.add(entry);
    const onCancel = () => {
      entry.cause ??= 'timeout';
      entry.controller.abort();
    };
    cancel?.addEventListener('abort', onCancel, { once: true });
    const timer = this.setTimeoutImpl(() => {
      entry.cause ??= 'timeout';
      entry.controller.abort();
    }, this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        // `content-type` and `accept` are literals: the host answers 415 to any
        // other media type, and no caller may choose a verb.
        headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers() },
        body,
        signal: entry.controller.signal,
      });
      status = response.status;
      const read = await this.readBodyLimited(response);
      if (!read.ok) {
        return transportFailure('http-status', { retryable: false, status, detail: 'response too large' });
      }
      text = read.text;
    } catch {
      const reason: DshTransportReason = entry.cause === 'generation-lost'
        ? 'generation-lost'
        : entry.cause === 'timeout' ? 'timeout' : 'unreachable';
      return transportFailure(reason, { retryable: true });
    } finally {
      this.clearTimeoutImpl(timer);
      cancel?.removeEventListener('abort', onCancel);
      this.inFlight.delete(entry);
    }
    // The host puts BUSINESS outcomes in the envelope and keeps HTTP for carrier
    // faults, so a non-200 is a carrier fault with no envelope to decode. A 401
    // and a 403 are named separately because neither is fixed by a relaunch: one
    // needs a credential, the other needs the address to be the server's own.
    if (status === 401) return transportFailure('unauthenticated', { retryable: false, status });
    if (status === 403) return transportFailure('forbidden', { retryable: false, status });
    if (status !== 200) {
      return transportFailure('http-status', { retryable: status >= 500, status });
    }
    return { ok: true, value: text };
  }

  /**
   * Read the response under the byte ceiling BEFORE it is decoded. The size
   * limit exists to bound allocation, so checking `text().length` afterwards
   * would be both too late (the body is already fully read) and wrong (a
   * character count is not a byte count).
   *
   * The real guarantee, stated plainly: with a byte stream, retention is bounded
   * by maxBytes PLUS ONE TRANSPORT CHUNK — a chunk straddling the ceiling is
   * held whole, then the stream is abandoned (leaving the for-await loop cancel
   * it). The text() fallback exists for injected fetches without a stream; it
   * measures encoded BYTES but only after the full body is allocated, and
   * production fetch never takes it.
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
