/**
 * Durable cache for the report windows that can no longer change.
 *
 * The in-memory {@link ./tokdash-report.ts | TokdashReportCache} exists so a period switcher does
 * not re-scan the same window twice in five minutes. It cannot help the case that actually costs
 * the reader time: a window that ENDED — last month, last year — is a full upstream scan every time
 * the broker restarts, every time the entry ages out, and once more for every past window the
 * reader steps back into. Those windows are finished. Their inputs stopped changing when the day
 * they end on closed, so re-deriving them from a SQLite scan is work with a knowable answer.
 *
 * Only closed windows are stored. A window ending today is still accumulating, and an open window
 * written to disk would be a figure the reader could not refresh without deleting a file.
 *
 * **Only COMPLETE reports are stored.** `fetchTokdashReport` does not throw when its optional reads
 * fail: a shed insights scan answers with every facet null, and a missed `/api/version` answers
 * with `belowMinimum: true`, which the client renders as a full-page "upgrade Tokdash" notice. In
 * memory those degrade for five minutes. On disk they would degrade for months, and the reader has
 * no way to refresh a window whose answer is a file. {@link isPersistableTokdashReport} is what
 * keeps one shed scan from freezing a permanent lie about a month that was fine.
 *
 * **Identity, not age.** A stored window is not trusted because it is recent; it is trusted because
 * the two things that could change its numbers are provably the same as when it was written:
 *
 * - **Pricing.** Every cost in the DTO is derived from Tokdash's pricing table, which the user can
 *   edit. Tokdash keys its own response cache on the effective pricing files for this reason.
 * - **Tokdash itself.** A new build can parse a source it could not read before, or fix an
 *   attribution, and re-derive a past window differently from the same rows.
 *
 * Both ride in the fingerprint, with the store's own revision. A mismatch drops every entry rather
 * than mixing two derivations in one cache — the cheap direction, because the cost of being wrong
 * is one re-scan and the cost of being trusted wrongly is a number nobody can explain.
 *
 * The fingerprint is an ARGUMENT rather than something this module resolves. One request must read
 * and write under the identity it derived its figures from: a store that resolved it twice could
 * finish a scan begun under one pricing table and stamp the result with the next one, and that
 * entry never self-heals, because the file then matches the current identity exactly.
 *
 * **A pricing override disables the store.** When Tokdash serves its packaged baseline, the
 * baseline's version names the table exactly. When the user has an override in effect, nothing on
 * the wire names its contents, so this module declines to persist rather than inventing an identity
 * for a table it cannot identify — and an override is precisely when a stale cost is most wrong,
 * because the user is editing prices. The in-memory cache still serves those sessions.
 *
 * Every failure here is a miss, never a throw: a broker that cannot read its own cache file must
 * still serve the report.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteOwnerOnly } from '../security/secure-files.ts';
import { setupStateHome } from './setup-state.ts';
import type { TokdashReport, TokdashReportWindow } from './tokdash-report.ts';
import { normalizeTokdashQuotaBaseUrl } from './tokdash-quota.ts';

/**
 * Bump when {@link TokdashReport}'s shape changes.
 *
 * Deliberately not the broker's version: a release that does not touch this DTO has no reason to
 * throw away a year of stored windows, and a change that does touch it must not be able to ship
 * without this line moving. {@link looksLikeTokdashReport} is the backstop for the release where
 * somebody forgets.
 */
export const TOKDASH_REPORT_STORE_REVISION = 1;

/** File-format version, separate from the DTO revision the entries are stamped with. */
const STORE_SCHEMA_VERSION = 1;

/**
 * Windows retained on disk.
 *
 * Sized for the navigation the page actually offers: four periods, stepped back through a year, is
 * well inside this.
 */
export const TOKDASH_REPORT_STORE_ENTRIES = 24;

/**
 * The longest window this module will persist, in days.
 *
 * The route bounds a window's start and its end but never its LENGTH, so
 * `2000-01-01 .. yesterday` is a legal, closed, ~9,000-row request that any paired device can make.
 * Serving it is the route's business; keeping it forever is not — a handful of those is tens of
 * megabytes of durable state re-parsed on every broker start. A year plus a month of slack covers
 * the widest window the client can actually ask for and close (its all-time period always ends
 * today, so it is never closed), and anything longer is served from upstream every time.
 */
export const TOKDASH_REPORT_STORE_MAX_SPAN_DAYS = 400;

/** Where the store lives. */
export function tokdashReportStorePath(home = setupStateHome()): string {
  return join(home, 'tokdash-report-cache.json');
}

/**
 * Today where this broker is running, as `YYYY-MM-DD`.
 *
 * Local, not UTC, because a Tokdash day is a local day: its own cache stamps open windows with
 * `_local_today()`, and the client computes its windows from the reader's clock. Deciding
 * "finished" against UTC would call a window closed while the host was still writing into it —
 * west of UTC for the last hours of every evening — and persist a day that had not happened yet.
 *
 * This is the BROKER's zone, which is the same host's zone as Tokdash's in every supported
 * topology (the broker reads a loopback Tokdash). A broker pinned to a different zone than the
 * Tokdash it reads — `TZ=UTC` in a unit file against a Tokdash aggregating in local time — would
 * judge closedness in the wrong frame, so {@link isClosedTokdashReportWindow} takes the day as an
 * argument and the caller may pass a better one if it ever has one.
 */
export function brokerLocalToday(now: Date = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Is this window finished?
 *
 * `to` strictly before `today`, because a window ending today is still taking writes. Both dates
 * are `YYYY-MM-DD`, which compares correctly as a string.
 */
export function isClosedTokdashReportWindow(
  window: TokdashReportWindow,
  today: string = brokerLocalToday(),
): boolean {
  return window.to < today;
}

/** Days a window covers, inclusive, or `null` when either end is unparseable. */
function windowSpanDays(window: TokdashReportWindow): number | null {
  const from = Date.parse(`${window.from}T00:00:00Z`);
  const to = Date.parse(`${window.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * May this window be kept at all?
 *
 * Closed and no longer than {@link TOKDASH_REPORT_STORE_MAX_SPAN_DAYS}. Separate from
 * {@link isPersistableTokdashReport} because one is a fact about the request and the other a fact
 * about the answer, and a caller reading this wants to know which refused.
 */
export function isStorableTokdashReportWindow(
  window: TokdashReportWindow,
  today: string = brokerLocalToday(),
): boolean {
  if (!isClosedTokdashReportWindow(window, today)) return false;
  const span = windowSpanDays(window);
  return span !== null && span <= TOKDASH_REPORT_STORE_MAX_SPAN_DAYS;
}

/**
 * Is this report whole enough to outlive its five minutes?
 *
 * Refuses every DTO that carries a hole an optional upstream read left behind:
 *
 * - `insightsUnavailable` — the facet scan was shed or malformed, so every chart is null.
 * - `runtime.version === null` — `/api/version` did not answer, which fails closed to
 *   `belowMinimum: true` and paints the client's "upgrade Tokdash" page over the whole report.
 * - `activeTime === null` — `/api/active-time` did not answer. A window with no activity still
 *   answers with a record of zeros, so `null` here is always a failed read, never an idle month.
 * - `sourceErrors` — Tokdash itself says a source did not parse, so tokens are missing from the
 *   totals every other figure reconciles against.
 *
 * A machine that reports one of these permanently simply never populates the store, which is the
 * behaviour this feature replaced rather than a new failure.
 */
export function isPersistableTokdashReport(report: TokdashReport): boolean {
  if (report.insightsUnavailable !== null) return false;
  if (report.runtime.version === null) return false;
  if (report.activeTime === null) return false;
  return report.sourceErrors.length === 0;
}

/**
 * The pricing table's identity, or `null` when it has none this module will stand behind.
 *
 * `baseline` is the packaged table, named exactly by its version. `override` is the user's own
 * edit, which nothing on the wire identifies — see the module note on why that answers `null`
 * rather than something derived. Never throws: an older Tokdash without this route, an unreachable
 * one, and a malformed body are all `null`, which disables the store rather than failing the read.
 */
export async function fetchTokdashPricingIdentity(
  baseInput: unknown,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<string | null> {
  let baseUrl: string;
  try {
    baseUrl = normalizeTokdashQuotaBaseUrl(baseInput);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetch ?? fetch)(`${baseUrl}/api/pricing-db`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (record.source !== 'baseline') return null;
    const version = record.baseline_version;
    return typeof version === 'string' && version.length > 0 ? `baseline:${version}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The token a stored window must match to be served.
 *
 * `null` in either half means the identity could not be established, and an unidentifiable
 * derivation is not one this module will cache under.
 */
export function tokdashReportStoreFingerprint(
  runtimeVersion: string | null,
  pricingIdentity: string | null,
): string | null {
  if (runtimeVersion === null || pricingIdentity === null) return null;
  return `r${TOKDASH_REPORT_STORE_REVISION}|tokdash:${runtimeVersion}|pricing:${pricingIdentity}`;
}

/** One stored window. */
export interface TokdashReportStoreEntry {
  report: TokdashReport;
  /** When this window was read from Tokdash, epoch ms. Reported as the report's `cachedAt`. */
  storedAt: number;
}

interface StoredFile {
  schemaVersion: number;
  fingerprint: string;
  entries: { from: string; to: string; storedAt: number; report: TokdashReport }[];
}

/**
 * Closed windows on disk, keyed by `(from, to)` under one fingerprint.
 *
 * One fingerprint for the whole file rather than one per entry: entries written under two different
 * pricing tables are not a cache, they are two caches sharing a filename, and the reader has no way
 * to tell which figure they are looking at.
 */
export class TokdashReportStore {
  readonly #path: string;
  readonly #maxEntries: number;
  readonly #now: () => number;
  /** The file, once read. `undefined` until the first access touches disk. */
  #file: StoredFile | undefined;
  #loaded = false;

  /** Creates a store. Every seam is injectable so the tests need neither a clock nor a Tokdash. */
  constructor(options: { path?: string; maxEntries?: number; now?: () => number } = {}) {
    this.#path = options.path ?? tokdashReportStorePath();
    this.#maxEntries = Math.max(1, options.maxEntries ?? TOKDASH_REPORT_STORE_ENTRIES);
    this.#now = options.now ?? Date.now;
  }

  /**
   * The stored window, or `undefined`.
   *
   * A hit is moved to the tail of the retention order, so the next write evicts what has not been
   * read rather than what was written longest ago. Recency lives in memory until that write: a
   * whole-file rewrite on every read would spend more than the read saved.
   */
  read(window: TokdashReportWindow, fingerprint: string | null): TokdashReportStoreEntry | undefined {
    if (fingerprint === null) return undefined;
    const file = this.#read();
    if (file === undefined || file.fingerprint !== fingerprint) return undefined;
    const index = file.entries.findIndex(
      (entry) => entry.from === window.from && entry.to === window.to,
    );
    if (index === -1) return undefined;
    const [found] = file.entries.splice(index, 1);
    if (found === undefined) return undefined;
    file.entries.push(found);
    return { report: found.report, storedAt: found.storedAt };
  }

  /**
   * Stores one window, evicting the least recently used when full.
   *
   * A fingerprint that no longer matches the file replaces the file rather than appending to it,
   * which is what makes "one derivation per cache" hold across a pricing edit or a Tokdash upgrade
   * that happens while the broker is running.
   */
  write(window: TokdashReportWindow, report: TokdashReport, fingerprint: string | null): void {
    if (fingerprint === null) return;
    // Enforced here rather than only at the call site, so no later caller can put a hole on disk
    // by forgetting the rule. Window storability stays with the caller: it owns the clock.
    if (!isPersistableTokdashReport(report)) return;
    const current = this.#read();
    const base: StoredFile =
      current !== undefined && current.fingerprint === fingerprint
        ? current
        : { schemaVersion: STORE_SCHEMA_VERSION, fingerprint, entries: [] };
    const entries = base.entries.filter(
      (entry) => !(entry.from === window.from && entry.to === window.to),
    );
    entries.push({ from: window.from, to: window.to, storedAt: this.#now(), report });
    // Least recently used first: `read` moves every hit to the tail, so the head is the entry
    // nothing has asked for.
    while (entries.length > this.#maxEntries) entries.shift();
    const next: StoredFile = { schemaVersion: STORE_SCHEMA_VERSION, fingerprint, entries };
    try {
      // Compact, not pretty-printed: nobody reads this file by eye, and indentation is roughly a
      // third of a year window's bytes on a path that is parsed synchronously at every broker
      // start.
      atomicWriteOwnerOnly(this.#path, `${JSON.stringify(next)}\n`);
      this.#file = next;
      this.#loaded = true;
    } catch {
      // A store that cannot be written is a store that is not used. The report is already in hand.
    }
  }

  /** Windows held under `fingerprint`; zero when the file belongs to another derivation. */
  size(fingerprint: string | null): number {
    if (fingerprint === null) return 0;
    const file = this.#read();
    return file === undefined || file.fingerprint !== fingerprint ? 0 : file.entries.length;
  }

  /** Drops the in-memory mirror so the next access re-reads the file. */
  forget(): void {
    this.#file = undefined;
    this.#loaded = false;
  }

  #read(): StoredFile | undefined {
    if (this.#loaded) return this.#file;
    this.#loaded = true;
    this.#file = readStoredFile(this.#path);
    return this.#file;
  }
}

/**
 * Does this value carry the load-bearing shape of a {@link TokdashReport}?
 *
 * The fingerprint's revision is the intended guard against a DTO change, and it is a constant a
 * human has to remember to move. This is the backstop for the release where nobody does: the Dart
 * decoder defaults every missing field, so an entry of the wrong shape does not surface as an
 * error — it renders as a month of zeros, indefinitely, on a page with no refresh.
 *
 * Structural rather than exhaustive: the fields checked are the ones every surface reconciles
 * against, so a DTO that still satisfies them is one whose figures still mean what they say.
 */
function looksLikeTokdashReport(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const report = value as Record<string, unknown>;
  const range = report.range;
  if (!isPlainObject(range)) return false;
  if (typeof (range as Record<string, unknown>).from !== 'string') return false;
  if (typeof (range as Record<string, unknown>).to !== 'string') return false;
  const totals = report.totals;
  if (!isPlainObject(totals)) return false;
  for (const field of ['tokens', 'cost', 'requests']) {
    const cell = (totals as Record<string, unknown>)[field];
    if (typeof cell !== 'number' || !Number.isFinite(cell)) return false;
  }
  const runtime = report.runtime;
  if (!isPlainObject(runtime)) return false;
  if (typeof (runtime as Record<string, unknown>).minimumVersion !== 'string') return false;
  if (typeof (runtime as Record<string, unknown>).belowMinimum !== 'boolean') return false;
  return Array.isArray(report.tools) && Array.isArray(report.sourceErrors);
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses the file, or `undefined`.
 *
 * Every field is checked rather than cast: this file is JSON on the user's disk, and a report the
 * broker serves from it reaches a client as though Tokdash had answered it. An entry that is not
 * the shape this module wrote is dropped on its own; a file that is not is dropped entirely.
 */
function readStoredFile(path: string): StoredFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== STORE_SCHEMA_VERSION) return undefined;
  if (typeof record.fingerprint !== 'string' || record.fingerprint.length === 0) return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const entries: StoredFile['entries'] = [];
  for (const raw of record.entries) {
    if (!isPlainObject(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const { from, to, storedAt, report } = entry;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (typeof storedAt !== 'number' || !Number.isFinite(storedAt)) continue;
    if (!looksLikeTokdashReport(report)) continue;
    entries.push({ from, to, storedAt, report: report as TokdashReport });
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, fingerprint: record.fingerprint, entries };
}
