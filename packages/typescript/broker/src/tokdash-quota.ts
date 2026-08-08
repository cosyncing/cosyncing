/**
 * Read-only Tokdash subscription-quota boundary and low-quota transition evaluator.
 *
 * This module deliberately owns no settings, routes, timers, or attention delivery. Callers inject
 * cosyncing's separate opt-in and decide how often to read Tokdash. The only upstream request
 * implemented here is `GET /api/quota`; provider refresh and consent mutations remain Tokdash-owned.
 */

export interface TokdashQuotaBucket {
  account: string;
  bucket: string;
  bucket_label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  resets_at: number | null;
  captured_at: number;
  source: string;
  status: string;
}

export interface TokdashQuotaProvider {
  provider: string;
  network_enabled: boolean;
  buckets: TokdashQuotaBucket[];
  status: string;
  status_detail: string | null;
  status_at: number | null;
  updated_at: number | null;
  sources: string[];
  estimated: boolean;
}

export interface TokdashQuotaState {
  providers: Record<string, TokdashQuotaProvider>;
  enabled: boolean;
  timestamp: number;
}

export interface TokdashQuotaFetchOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface TokdashQuotaWarningIdentity {
  provider: string;
  account: string;
  bucket: string;
  resetsAt: number | null;
}

export interface TokdashQuotaWarning {
  id: string;
  provider: string;
  account: string;
  bucket: string;
  bucketLabel: string;
  remainingPercent: number;
  resetsAt: number | null;
  capturedAt: number;
  source: string;
  estimated: boolean;
}

export interface TokdashQuotaLifecycle {
  opened: TokdashQuotaWarning[];
  active: TokdashQuotaWarning[];
  resolved: TokdashQuotaWarning[];
}

export interface TokdashQuotaEvaluationOptions {
  optedIn: boolean;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_TIMEOUT_MS = 10_000;
const LOW_QUOTA_REMAINING_PERCENT = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid Tokdash quota response: ${path} must be ${expected}`);
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, 'a string');
  return value;
}

function booleanField(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'a boolean');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'a finite number');
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : finiteNumber(value, path);
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringField(value, path);
}

function percent(value: unknown, path: string): number | null {
  const parsed = nullableNumber(value, path);
  if (parsed !== null && (parsed < 0 || parsed > 100)) invalid(path, 'between 0 and 100');
  return parsed;
}

function parseBucket(value: unknown, path: string): TokdashQuotaBucket {
  if (!isRecord(value)) invalid(path, 'an object');
  return {
    account: stringField(value.account, `${path}.account`),
    bucket: stringField(value.bucket, `${path}.bucket`),
    bucket_label: stringField(value.bucket_label, `${path}.bucket_label`),
    used_percent: percent(value.used_percent, `${path}.used_percent`),
    remaining_percent: percent(value.remaining_percent, `${path}.remaining_percent`),
    resets_at: nullableNumber(value.resets_at, `${path}.resets_at`),
    captured_at: finiteNumber(value.captured_at, `${path}.captured_at`),
    source: stringField(value.source, `${path}.source`),
    status: stringField(value.status, `${path}.status`),
  };
}

function parseProvider(value: unknown, path: string): TokdashQuotaProvider {
  if (!isRecord(value)) invalid(path, 'an object');
  if (!Array.isArray(value.buckets)) invalid(`${path}.buckets`, 'an array');
  if (!Array.isArray(value.sources)) invalid(`${path}.sources`, 'an array');
  return {
    provider: stringField(value.provider, `${path}.provider`),
    network_enabled: booleanField(value.network_enabled, `${path}.network_enabled`),
    buckets: value.buckets.map((entry, index) => parseBucket(entry, `${path}.buckets[${index}]`)),
    status: stringField(value.status, `${path}.status`),
    status_detail: nullableString(value.status_detail, `${path}.status_detail`),
    status_at: nullableNumber(value.status_at, `${path}.status_at`),
    updated_at: nullableNumber(value.updated_at, `${path}.updated_at`),
    sources: value.sources.map((entry, index) => stringField(entry, `${path}.sources[${index}]`)),
    estimated: booleanField(value.estimated, `${path}.estimated`),
  };
}

export function parseTokdashQuotaState(value: unknown): TokdashQuotaState {
  if (!isRecord(value)) invalid('root', 'an object');
  if (!isRecord(value.providers)) invalid('providers', 'an object');
  const providers: Record<string, TokdashQuotaProvider> = {};
  for (const [providerId, providerValue] of Object.entries(value.providers)) {
    providers[providerId] = parseProvider(providerValue, `providers.${providerId}`);
  }
  return {
    providers,
    enabled: booleanField(value.enabled, 'enabled'),
    timestamp: finiteNumber(value.timestamp, 'timestamp'),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

/** Where a local Tokdash listens by default, and what `COSYNCING_TOKDASH_URL` overrides. */
export const TOKDASH_DEFAULT_BASE_URL = 'http://127.0.0.1:55423';

/**
 * One resolution of `COSYNCING_TOKDASH_URL`, for every surface that names, probes, provisions, or polls a
 * Tokdash.
 *
 * There used to be three answers to this one question: setup normalized the override and silently fell back
 * to the default when it would not parse, the runtime used the raw string with nothing but a trailing slash
 * stripped, and the wizard's copy named the default whatever either of them had decided. That is how an
 * override ends up provisioning one endpoint and polling another, and how an invalid one is quietly ignored
 * by half the process and used by the other half. Every caller resolves through here instead.
 */
export interface TokdashEndpoint {
  /** The URL every surface must use. Normalized, loopback, no trailing slash. */
  baseUrl: string;
  /** True when {@link baseUrl} is Tokdash's own default endpoint. */
  isDefault: boolean;
  /**
   * Why an override was refused; {@link baseUrl} is then the default. Present so the refusal is reported
   * rather than inferred — every caller says so in its own voice instead of dropping it.
   *
   * A REASON, never the value. A refused override is operator-supplied text that can carry a credential
   * (`http://user:secret@127.0.0.1:55423` is refused for exactly that, and used to be echoed into the broker
   * log and the wizard verbatim), and one that does not parse cannot be structurally stripped at all. The
   * fail-closed rule the runtime-failure journal already applies to captured output — emit only what is
   * provably safe, replace the rest — leaves this field as the whole safe part: the raw value is not
   * retained anywhere, so no surface can print it by accident.
   */
  rejected?: TokdashEndpointRejection;
}

/** The closed vocabulary of refusals. A code cannot interpolate the value the way an error string can. */
export type TokdashEndpointRejection = 'unparseable' | 'not-http' | 'not-loopback' | 'credentials';

/** The English phrase for a refusal, for machine-facing surfaces (the broker log, `setup --yes`). */
export function tokdashRejectionReason(rejection: TokdashEndpointRejection): string {
  return {
    unparseable: 'it is not a valid URL',
    'not-http': 'Tokdash serves http(s) only',
    'not-loopback': 'it does not point at localhost',
    credentials: 'it embeds credentials',
  }[rejection];
}

/**
 * Resolve the endpoint from a raw `COSYNCING_TOKDASH_URL`. Never throws: an unusable override falls back to
 * the default and reports why, so setup and the runtime agree on both the endpoint and the complaint instead
 * of diverging.
 */
export function resolveTokdashEndpoint(input: unknown): TokdashEndpoint {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { baseUrl: TOKDASH_DEFAULT_BASE_URL, isDefault: true };
  const parsed = parseTokdashBaseUrl(raw);
  if (!parsed.ok) return { baseUrl: TOKDASH_DEFAULT_BASE_URL, isDefault: true, rejected: parsed.rejection };
  return { baseUrl: parsed.baseUrl, isDefault: parsed.baseUrl === TOKDASH_DEFAULT_BASE_URL };
}

/** One parse, returning the refusal as a code. The thrown wrapper below is the same answer for throwing callers. */
function parseTokdashBaseUrl(raw: string):
  { ok: true; baseUrl: string } | { ok: false; rejection: TokdashEndpointRejection } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, rejection: 'unparseable' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, rejection: 'not-http' };
  if (!isLoopbackHostname(parsed.hostname)) return { ok: false, rejection: 'not-loopback' };
  if (parsed.username || parsed.password) return { ok: false, rejection: 'credentials' };
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return { ok: true, baseUrl: parsed.toString().replace(/\/$/, '') };
}

export function normalizeTokdashQuotaBaseUrl(input: unknown, fallback = TOKDASH_DEFAULT_BASE_URL): string {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : fallback;
  const parsed = parseTokdashBaseUrl(raw);
  // The message carries the reason and never the input: this is thrown into HTTP error bodies, and an
  // echoed override is the same leak the endpoint record refuses to hold.
  if (!parsed.ok) throw new Error(`Invalid Tokdash URL: ${tokdashRejectionReason(parsed.rejection)}`);
  return parsed.baseUrl;
}

function quotaEndpoint(baseUrl: string): string {
  return `${baseUrl}/api/quota`;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

export async function fetchTokdashQuota(
  baseInput: unknown,
  options: TokdashQuotaFetchOptions = {},
): Promise<TokdashQuotaState> {
  const baseUrl = normalizeTokdashQuotaBaseUrl(baseInput);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(quotaEndpoint(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Tokdash quota request timed out after ${timeoutMs}ms`);
    throw new Error(`Tokdash quota request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Tokdash quota request failed with HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Invalid Tokdash quota response: body must be JSON');
  }
  return parseTokdashQuotaState(body);
}

function trackedWindow(provider: string, bucket: string): boolean {
  if (provider === 'codex') {
    return bucket === '5h' || bucket === '7d' || bucket.endsWith('_5h') || bucket.endsWith('_7d');
  }
  if (provider === 'claude') {
    return bucket === 'session' || bucket === 'weekly_all' || bucket.startsWith('weekly_scoped_');
  }
  return false;
}

function identityPart(value: string): string {
  return encodeURIComponent(value);
}

export function quotaWarningIdentity(identity: TokdashQuotaWarningIdentity): string {
  const resetEpoch = identity.resetsAt === null ? 'none' : String(identity.resetsAt);
  return [identity.provider, identity.account, identity.bucket, resetEpoch].map(identityPart).join(':');
}

function sortWarnings(values: Iterable<TokdashQuotaWarning>): TokdashQuotaWarning[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

function eligibleWarnings(state: TokdashQuotaState | undefined, optedIn: boolean): Map<string, TokdashQuotaWarning> {
  const warnings = new Map<string, TokdashQuotaWarning>();
  if (!optedIn || !state?.enabled) return warnings;
  for (const [providerId, provider] of Object.entries(state.providers)) {
    if (provider.status !== 'ok') continue;
    for (const bucket of provider.buckets) {
      if (
        bucket.status !== 'ok' ||
        !trackedWindow(providerId, bucket.bucket) ||
        bucket.remaining_percent === null ||
        bucket.remaining_percent > LOW_QUOTA_REMAINING_PERCENT
      ) {
        continue;
      }
      const id = quotaWarningIdentity({
        provider: providerId,
        account: bucket.account,
        bucket: bucket.bucket,
        resetsAt: bucket.resets_at,
      });
      warnings.set(id, {
        id,
        provider: providerId,
        account: bucket.account,
        bucket: bucket.bucket,
        bucketLabel: bucket.bucket_label,
        remainingPercent: bucket.remaining_percent,
        resetsAt: bucket.resets_at,
        capturedAt: bucket.captured_at,
        source: bucket.source,
        estimated: provider.estimated,
      });
    }
  }
  return warnings;
}

export class TokdashQuotaEvaluator {
  readonly #active = new Map<string, TokdashQuotaWarning>();

  evaluate(
    state: TokdashQuotaState | undefined,
    options: TokdashQuotaEvaluationOptions,
  ): TokdashQuotaLifecycle {
    const next = eligibleWarnings(state, options.optedIn);
    const opened = [...next.values()].filter((warning) => !this.#active.has(warning.id));
    const resolved = [...this.#active.values()].filter((warning) => !next.has(warning.id));
    this.#active.clear();
    for (const [id, warning] of next) this.#active.set(id, warning);
    return {
      opened: sortWarnings(opened),
      active: sortWarnings(this.#active.values()),
      resolved: sortWarnings(resolved),
    };
  }
}
