/** Coordinates memory, durable windows, and live derivation identity for the report route. */
import {
  fetchTokdashReport, fetchTokdashVersion, TokdashReportCache, TOKDASH_REPORT_CACHE_MS,
  type TokdashReportCacheEntry, type TokdashReportWindow,
} from './tokdash-report.ts';
import {
  brokerLocalToday, fetchTokdashPricingIdentity, isStorableTokdashReportWindow,
  TokdashReportStore, tokdashReportStoreFingerprint, TOKDASH_REPORT_STORE_MAX_AGE_MS,
} from './tokdash-report-store.ts';

type Identity = { version: string; fingerprint: string; checkedAt: number };

/** Failed identity reads are coalesced only while in flight, never memoized afterwards. */
export class TokdashReportService {
  readonly #baseUrl: string;
  readonly #cache: TokdashReportCache;
  readonly #store: TokdashReportStore;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #identityTtlMs: number;
  #identity: { value: Identity; at: number } | undefined;
  #identityInFlight: Promise<Identity | null> | undefined;

  constructor(options: {
    baseUrl: string;
    cache?: TokdashReportCache;
    store?: TokdashReportStore;
    now?: () => number;
    fetch?: typeof fetch;
    identityTtlMs?: number;
  }) {
    this.#baseUrl = options.baseUrl;
    this.#cache = options.cache ?? new TokdashReportCache();
    this.#store = options.store ?? new TokdashReportStore();
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? fetch;
    this.#identityTtlMs = Math.max(0, options.identityTtlMs ?? 5 * 60_000);
  }

  async #readIdentity(): Promise<Identity | null> {
    const options = { fetch: this.#fetch, timeoutMs: 5_000 };
    const [version, pricing] = await Promise.all([
      fetchTokdashVersion(this.#baseUrl, options),
      fetchTokdashPricingIdentity(this.#baseUrl, options),
    ]);
    const fingerprint = tokdashReportStoreFingerprint(version, pricing);
    const value = version !== null && pricing !== null && fingerprint !== null
      ? { version, fingerprint, checkedAt: this.#now() } : null;
    this.#identity = value === null ? undefined : { value, at: this.#now() };
    return value;
  }

  async #lookupIdentity(): Promise<Identity | null> {
    const saved = this.#identity;
    if (saved && this.#now() - saved.at < this.#identityTtlMs) return saved.value;
    this.#identityInFlight ??= this.#readIdentity().finally(() => {
      this.#identityInFlight = undefined;
    });
    return this.#identityInFlight;
  }

  async read(window: TokdashReportWindow): Promise<{
    entry: TokdashReportCacheEntry; servedFromCache: boolean;
  }> {
    const memory = this.#cache.get(window);
    if (memory) return { entry: memory, servedFromCache: true };
    const storable = isStorableTokdashReportWindow(window, brokerLocalToday(new Date(this.#now())));
    if (storable) {
      const identity = await this.#lookupIdentity();
      const stored = this.#store.read(window, identity?.fingerprint ?? null);
      if (stored && identity) {
        const entry = this.#cache.set(window, stored.report, {
          cachedAt: stored.storedAt,
          expiresAt: Math.min(
            stored.storedAt + TOKDASH_REPORT_STORE_MAX_AGE_MS,
            identity.checkedAt + TOKDASH_REPORT_CACHE_MS,
          ),
        });
        return { entry, servedFromCache: true };
      }
    }
    return this.#cache.load(window, async () => {
      // Resolve after acquiring the scan slot: a queued scan must not inherit the lookup memo.
      const before = storable ? await this.#readIdentity() : null;
      const report = await fetchTokdashReport(this.#baseUrl, window, {
        fetch: this.#fetch, refresh: storable,
      });
      if (before) {
        // Compare rather than restamp. A changed or unavailable identity leaves this result
        // memory-only. Bracketing is conservative; upstream provides no transactional identity.
        const after = await this.#readIdentity();
        if (after?.fingerprint === before.fingerprint && report.runtime.version === before.version) {
          this.#store.write(window, report, before.fingerprint);
        }
      }
      return report;
    });
  }
}
