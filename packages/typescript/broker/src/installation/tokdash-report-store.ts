/**
 * Bounded durable cache for closed usage windows. Historical inputs can change after import,
 * restore, or correction, so even an unchanged runtime/pricing identity expires after 24 hours.
 * The caller brackets each fresh scan with identity reads; unidentifiable or degraded results
 * are never stored. Every disk failure is a miss. Pricing overrides disable persistence.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteOwnerOnly } from '../security/secure-files.ts';
import { setupStateHome } from './setup-state.ts';
import { isCompleteTokdashReport } from './tokdash-report-validation.ts';
import type { TokdashReport, TokdashReportWindow } from './tokdash-report.ts';
import { normalizeTokdashQuotaBaseUrl } from './tokdash-quota.ts';

/**
 * Bump when {@link TokdashReport}'s shape changes.
 *
 * Deliberately not the broker's version: a release that does not touch this DTO has no reason to
 * throw away a year of stored windows, and a change that does touch it must not be able to ship
 * without this line moving. {@link isCompleteTokdashReport} is the backstop for the release where
 * somebody forgets.
 */
export const TOKDASH_REPORT_STORE_REVISION = 2;

/** Revalidate historical data at least daily, independently of the identity memo. */
export const TOKDASH_REPORT_STORE_MAX_AGE_MS = 24 * 60 * 60_000;

/** File-format version, separate from the DTO revision the entries are stamped with. */
const STORE_SCHEMA_VERSION = 2;

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

/** Complete DTO validation is shared by writes and reads of untrusted disk state. */
export const isPersistableTokdashReport = isCompleteTokdashReport;

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
    const age = this.#now() - found.storedAt;
    if (age < 0 || age >= TOKDASH_REPORT_STORE_MAX_AGE_MS) return undefined;
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
    // by forgetting the rule. The store clock also bounds the window and its retention.
    if (!isPersistableTokdashReport(report)) return;
    if (!isStorableTokdashReportWindow(window, brokerLocalToday(new Date(this.#now())))) return;
    if (report.range.from !== window.from || report.range.to !== window.to) return;
    if (!fingerprint.startsWith(`r${TOKDASH_REPORT_STORE_REVISION}|tokdash:${report.runtime.version}|pricing:`)) return;
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
    if (!isCompleteTokdashReport(report)) continue;
    if (report.range.from !== from || report.range.to !== to) continue;
    if (!record.fingerprint.startsWith(`r${TOKDASH_REPORT_STORE_REVISION}|tokdash:${report.runtime.version}|pricing:`)) continue;
    entries.push({ from, to, storedAt, report: report as TokdashReport });
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, fingerprint: record.fingerprint, entries };
}
