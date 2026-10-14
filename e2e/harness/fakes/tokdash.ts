/**
 * A Tokdash sidecar a broker can be pointed at (`COSYNCING_TOKDASH_URL`).
 *
 * It serves the endpoints the usage report and the quota card read, with the
 * bodies Tokdash 2.5 really sends (the broker's own recorded fixtures), and
 * echoes the requested window into each report body the way Tokdash does.
 * Every request is recorded, so a test counts the reads a feature cost.
 * Any endpoint can be answered differently, for every window or for one, can
 * fail, can stay silent, or can be held open until the test releases it.
 *
 *   const tokdash = startFakeTokdash();
 *   afterAll(() => tokdash.stop());
 *   startBroker({ env: { COSYNCING_TOKDASH_URL: tokdash.url } });
 */
import {
  activeTimeFixture,
  insightsFixture,
  usageFixture,
  versionFixture,
} from '../../../packages/typescript/broker/test/fixtures/tokdash-report-fixtures.ts';

export type TokdashEndpoint =
  | 'usage'
  | 'active-time'
  | 'insights'
  | 'version'
  | 'pricing-db'
  | 'quota'
  | 'usage-summary'
  | 'usage-today';

const ENDPOINTS: Record<string, TokdashEndpoint> = {
  '/api/usage': 'usage',
  '/api/active-time': 'active-time',
  '/api/insights': 'insights',
  '/api/version': 'version',
  '/api/pricing-db': 'pricing-db',
  '/api/quota': 'quota',
  '/api/usage/summary': 'usage-summary',
  '/api/usage/today': 'usage-today',
};

/** A JSON body, an HTTP status with an opaque body, or no answer at all. */
export type TokdashAnswer = { json: unknown } | { status: number } | 'hang';

export interface ReportWindow {
  from: string;
  to: string;
}

export interface TokdashRequest {
  method: string;
  path: string;
  endpoint: TokdashEndpoint | undefined;
  query: URLSearchParams;
  /** `from..to` when the request named a report window. */
  window: string | undefined;
}

export interface Hold {
  /** Requests waiting on this hold right now. */
  held(): number;
  release(): void;
}

const windowKey = (window: ReportWindow): string => `${window.from}..${window.to}`;

/** One quota bucket as Tokdash serves it. */
export function quotaBucket(
  bucket: string,
  remainingPercent: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    account: 'acct',
    bucket,
    bucket_label: bucket,
    used_percent: 100 - remainingPercent,
    remaining_percent: remainingPercent,
    resets_at: 1_900_000_000,
    captured_at: 1_800_000_000,
    source: 'codex_api',
    status: 'ok',
    ...overrides,
  };
}

/** One quota provider as Tokdash serves it. */
export function quotaProvider(
  provider: string,
  buckets: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider,
    network_enabled: true,
    buckets,
    status: 'ok',
    status_detail: null,
    status_at: null,
    updated_at: 1_800_000_000,
    sources: [`${provider}_api`],
    estimated: false,
    ...overrides,
  };
}

/** `GET /api/quota`. */
export function quotaState(providers: Record<string, unknown>, enabled = true): Record<string, unknown> {
  return { providers, enabled, timestamp: 1_800_000_000 };
}

function defaultBody(endpoint: TokdashEndpoint, query: URLSearchParams): unknown | undefined {
  const from = query.get('date_from');
  const to = query.get('date_to');
  // Tokdash answers with the window it resolved; echo the requested one.
  const range = (base: Record<string, unknown>) =>
    from && to ? { ...(base.range as Record<string, unknown>), from, to } : base.range;
  switch (endpoint) {
    case 'usage': {
      const body = usageFixture();
      return { ...body, range: range(body) };
    }
    case 'insights': {
      const body = insightsFixture();
      return { ...body, range: range(body) };
    }
    case 'active-time':
      return activeTimeFixture();
    case 'version':
      return versionFixture();
    case 'pricing-db':
      return { source: 'baseline', baseline_version: '2.0.25' };
    case 'quota':
      return quotaState({ codex: quotaProvider('codex', [quotaBucket('5h', 60), quotaBucket('7d', 80)]) });
    default:
      return undefined;
  }
}

export class FakeTokdash {
  readonly requests: TokdashRequest[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #answers = new Map<string, TokdashAnswer>();
  readonly #holds = new Map<TokdashEndpoint, { waiters: Set<() => void>; open: boolean }>();
  readonly #inFlight = new Map<TokdashEndpoint, number>();
  readonly #peak = new Map<TokdashEndpoint, number>();
  readonly #hanging = new Set<() => void>();
  #outage = false;

  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // A held or silent request must outlive Bun's 10 s default.
      idleTimeout: 120,
      fetch: (request) => this.#handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /** Answer `endpoint` this way, for every window or only for `window`. */
  answer(endpoint: TokdashEndpoint, answer: TokdashAnswer, window?: ReportWindow): void {
    this.#answers.set(window ? `${endpoint}@${windowKey(window)}` : endpoint, answer);
  }

  /** Every endpoint fails with 503 while on. */
  outage(on: boolean): void {
    this.#outage = on;
  }

  /** Back to the default answers. Releases any hold. The request log is kept. */
  reset(): void {
    this.#answers.clear();
    this.#outage = false;
    for (const endpoint of [...this.#holds.keys()]) this.#releaseHold(endpoint);
  }

  /** Requests to `endpoint` wait until released. */
  hold(endpoint: TokdashEndpoint): Hold {
    const hold = { waiters: new Set<() => void>(), open: false };
    this.#holds.set(endpoint, hold);
    return {
      held: () => hold.waiters.size,
      release: () => this.#releaseHold(endpoint),
    };
  }

  /** The most requests to `endpoint` that were unanswered at once. */
  peakInFlight(endpoint: TokdashEndpoint): number {
    return this.#peak.get(endpoint) ?? 0;
  }

  /** Requests to `endpoint` (for `window`, when given), from request number `since` on. */
  count(endpoint: TokdashEndpoint, options: { window?: ReportWindow; since?: number } = {}): number {
    const key = options.window ? windowKey(options.window) : undefined;
    return this.requests
      .slice(options.since ?? 0)
      .filter((request) => request.endpoint === endpoint && (key === undefined || request.window === key))
      .length;
  }

  /** Requests from request number `since` on. */
  since(since: number): TokdashRequest[] {
    return this.requests.slice(since);
  }

  async stop(): Promise<void> {
    for (const wake of this.#hanging) wake();
    this.reset();
    await this.#server.stop(true);
  }

  #releaseHold(endpoint: TokdashEndpoint): void {
    const hold = this.#holds.get(endpoint);
    if (!hold) return;
    this.#holds.delete(endpoint);
    hold.open = true;
    for (const wake of hold.waiters) wake();
    hold.waiters.clear();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = ENDPOINTS[url.pathname];
    const from = url.searchParams.get('date_from');
    const to = url.searchParams.get('date_to');
    const window = from && to ? windowKey({ from, to }) : undefined;
    this.requests.push({ method: request.method, path: url.pathname, endpoint, query: url.searchParams, window });
    if (!endpoint) return new Response('not found', { status: 404 });

    const inFlight = (this.#inFlight.get(endpoint) ?? 0) + 1;
    this.#inFlight.set(endpoint, inFlight);
    this.#peak.set(endpoint, Math.max(this.#peak.get(endpoint) ?? 0, inFlight));
    try {
      const hold = this.#holds.get(endpoint);
      if (hold && !hold.open) {
        await new Promise<void>((resolve) => hold.waiters.add(resolve));
      }
      if (this.#outage) return new Response('unavailable', { status: 503 });
      const answer = (window && this.#answers.get(`${endpoint}@${window}`)) ?? this.#answers.get(endpoint);
      if (answer === 'hang') {
        // Silent until the broker gives up (it aborts the request) or the fake stops.
        await new Promise<void>((resolve) => {
          this.#hanging.add(resolve);
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return new Response('stopped', { status: 503 });
      }
      if (answer && 'status' in answer) return new Response('upstream refusal', { status: answer.status });
      const body = answer && 'json' in answer ? answer.json : defaultBody(endpoint, url.searchParams);
      if (body === undefined) return new Response('not found', { status: 404 });
      return Response.json(body);
    } finally {
      this.#inFlight.set(endpoint, (this.#inFlight.get(endpoint) ?? 1) - 1);
    }
  }
}

export function startFakeTokdash(): FakeTokdash {
  return new FakeTokdash();
}
