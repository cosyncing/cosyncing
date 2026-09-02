/**
 * Read-only Tokdash usage-report aggregation for `GET /api/tokdash/report`.
 *
 * One window in, one product DTO out. The broker owns no pricing table and no usage database —
 * Tokdash's SQLite already is one — so this module is a projection, not a store: three upstream GETs
 * per uncached window, assembled by explicit field selection.
 *
 * Two rules shape everything here.
 *
 * **`display_name` never crosses the wire.** It is the user's first prompt, the most sensitive field
 * in the dataset, and the client has no surface that wants it. None of the three endpoints below
 * serves it today, which is exactly why the defense cannot be "we do not read it": a future Tokdash
 * that starts returning it inside a projects row would pass straight through a spread-based
 * assembler. Every field on the DTO is named individually, so an upstream addition is dropped by
 * construction rather than by vigilance.
 *
 * **The period total is served beside the facet rows.** The projects facet does not cover the
 * period: sources with no stored session records to join on (OpenClaw and the live-only tools)
 * contribute tokens and no project row at all. Serving the rows without the total lets a client
 * print "0.6% unattributed" over a window where a tenth of the tokens are in no row whatsoever.
 * {@link TokdashReportTotals.tokens} is what makes the reconciliation computable.
 */

import { normalizeTokdashQuotaBaseUrl } from './tokdash-quota.ts';

/** Facets requested in the single composite insights scan (Tokdash 2.5.0+). */
export const TOKDASH_REPORT_FACETS = [
  'hourly',
  'weekday',
  'daily',
  'projects',
  'streaks',
  'firsts',
] as const;

/**
 * Bounds sized against a real cold year window, not against a quota poll.
 *
 * The quota read is a 2.5s call because it reads one small live table. A report window is a full
 * scan: measured cold on this host at year-to-date scope, `/api/active-time` alone took 34s, and
 * `/api/usage` took long enough to blow a 15s budget before Tokdash cached it. Serving the year view
 * at all is the headline deliverable, so the budget has to cover the slowest honest read rather than
 * turning the first open of the page into a failure that a second open silently fixes.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

/** Default per-`(from, to)` cache lifetime. */
export const TOKDASH_REPORT_CACHE_MS = 5 * 60_000;

/** Most windows retained at once. A period switcher walks four; the rest are navigation history. */
export const TOKDASH_REPORT_CACHE_ENTRIES = 16;

/** The window a report covers, as Tokdash resolved it. */
export interface TokdashReportRange {
  from: string;
  to: string;
  days: number | null;
  /**
   * Tokdash's own verdict on whether it understood the request.
   *
   * An unrecognized period silently resolves to all time upstream, so a client that labels a window
   * from what it asked for rather than from this block prints a year's figures under "This week".
   */
  recognized: boolean;
  /** Tokdash's resolved period alias (`custom`, `year`, …). A label input, never a label. */
  periodResolved: string | null;
}

/** Period totals. Carried beside every facet so shares reconcile against a real denominator. */
export interface TokdashReportTotals {
  tokens: number;
  cost: number;
  requests: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCache: number | null;
  cacheHitRate: number | null;
}

/** Period-over-period movement against the equal-length prior window. */
export interface TokdashReportComparison {
  tokensPrev: number | null;
  costPrev: number | null;
  requestsPrev: number | null;
  tokensPct: number | null;
  costPct: number | null;
  requestsPct: number | null;
}

/** Estimated agent activity time. `activeMs` is the merged figure; `activeMsSum` is the naive sum. */
export interface TokdashReportActiveTime {
  activeMs: number | null;
  activeMsSum: number | null;
  activeMsPct: number | null;
  estimated: boolean;
  /** Idle gap above which time stops accruing, so the client can explain the estimate. */
  gapCapMs: number | null;
  method: string | null;
  sessions: number | null;
}

/** One tool's contribution. Absent cells stay `null` — the UI em-dashes them rather than showing 0. */
export interface TokdashReportTool {
  tool: string;
  label: string | null;
  tokens: number;
  cost: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCache: number | null;
  cacheHitRate: number | null;
  requests: number | null;
  sessions: number | null;
  activeMs: number | null;
  /** Whether this tool is one of the coding apps, as opposed to a non-coding source. */
  coding: boolean;
}

/** One model's contribution, in the order Tokdash served it. */
export interface TokdashReportModel {
  name: string;
  tokens: number;
  cost: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCache: number | null;
  requests: number | null;
}

/** Hour-of-day distribution. */
export interface TokdashReportHourly {
  buckets: Array<{ hour: number; tokens: number; cost: number; requests: number }>;
  peakHour: number | null;
  nightShare: number | null;
  /** The served night window. Never hardcode it: Tokdash owns which hours count as night. */
  nightHours: number[];
}

/** Day-of-week distribution. */
export interface TokdashReportWeekday {
  buckets: Array<{
    weekday: number;
    name: string | null;
    tokens: number;
    cost: number;
    requests: number;
  }>;
  peakWeekday: number | null;
}

/** One calendar day, carrying the served quartile rank the heatmap shades by. */
export interface TokdashReportDay {
  date: string;
  tokens: number;
  cost: number;
  requests: number;
  /** Quartile rank 1-4 over active days, 0/null when inactive. Served, never recomputed here. */
  intensity: number | null;
}

/** Project attribution. Amber tier: names may reach the client, and never a log line. */
export interface TokdashReportProjects {
  rows: Array<{ project: string; tokens: number; cost: number; requests: number }>;
  /** In-facet remainder. NOT the whole gap — see the module header. */
  unattributed: { tokens: number; cost: number; requests: number } | null;
  attributedCount: number | null;
  namesIncluded: boolean;
}

/** Consecutive-day activity, as served. */
export interface TokdashReportStreaks {
  currentStreak: number | null;
  longestStreak: number | null;
  activeDays: number | null;
  totalDays: number | null;
}

/** Window landmarks. */
export interface TokdashReportFirsts {
  firstActiveDay: string | null;
  lastActiveDay: string | null;
  busiestDay: string | null;
  busiestDayTokens: number | null;
}

/** How many sources the figures were drawn from, so the footer cites evidence rather than a memory. */
export interface TokdashReportCoverage {
  storedSources: string[];
  liveSources: string[];
  sourceCount: number;
}

/** The aggregated report for one window. */
export interface TokdashReport {
  range: TokdashReportRange;
  /** Tokdash's local zone label. The hourly/weekday buckets are cut in it. */
  timezone: string | null;
  totals: TokdashReportTotals;
  comparison: TokdashReportComparison | null;
  activeTime: TokdashReportActiveTime | null;
  tools: TokdashReportTool[];
  topModelsByTokens: TokdashReportModel[];
  topModelsByCost: TokdashReportModel[];
  /** Facets are `null` when Tokdash is older than 2.5.0 or the scan failed. */
  hourly: TokdashReportHourly | null;
  weekday: TokdashReportWeekday | null;
  daily: TokdashReportDay[] | null;
  projects: TokdashReportProjects | null;
  streaks: TokdashReportStreaks | null;
  firsts: TokdashReportFirsts | null;
  coverage: TokdashReportCoverage | null;
  /** Tools Tokdash could not read for this window; their usage is not in the totals. */
  sourceErrors: string[];
  /** Why the facets are absent, when they are. A reason code, never an upstream error string. */
  insightsUnavailable: TokdashReportInsightsRefusal | null;
}

/** The closed vocabulary of facet refusals. A code cannot interpolate an upstream error. */
export type TokdashReportInsightsRefusal = 'unsupported' | 'unavailable' | 'malformed';

/** Options for one report read. */
export interface TokdashReportFetchOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A window request. Both bounds are inclusive `YYYY-MM-DD` dates in Tokdash's local zone. */
export interface TokdashReportWindow {
  from: string;
  to: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a string is a well-formed, real calendar date.
 *
 * The round-trip rejects `2026-02-30`, which the pattern alone accepts and which Tokdash would
 * silently resolve to something else.
 */
export function isTokdashReportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid Tokdash report response: ${path} must be ${expected}`);
}

/** Strict reader for the mandatory totals. A wrong denominator is worse than no report. */
function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'a finite number');
  return value;
}

/** Lenient reader for optional cells. Anything unusable becomes `null`, which the UI em-dashes. */
function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalInteger(value: unknown): number | null {
  const parsed = optionalNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function numberOrZero(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

async function getJson(
  url: string,
  options: TokdashReportFetchOptions,
  label: string,
): Promise<unknown> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Tokdash ${label} request timed out after ${timeoutMs}ms`);
    throw new Error(`Tokdash ${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const failure = new Error(`Tokdash ${label} request failed with HTTP ${response.status}`) as Error & {
      status?: number;
    };
    failure.status = response.status;
    throw failure;
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid Tokdash ${label} response: body must be JSON`);
  }
}

function windowQuery(window: TokdashReportWindow): string {
  return `date_from=${encodeURIComponent(window.from)}&date_to=${encodeURIComponent(window.to)}`;
}

function parseRange(value: unknown, window: TokdashReportWindow): TokdashReportRange {
  const range = isRecord(value) ? value : {};
  return {
    from: optionalString(range.from) ?? window.from,
    to: optionalString(range.to) ?? window.to,
    days: optionalInteger(range.days),
    // Absent means an older Tokdash that never published the verdict. Treating that as "recognized"
    // would assert something it never said, so the honest default is the one that hides the surface.
    recognized: range.recognized === true,
    periodResolved: optionalString(range.period_resolved),
  };
}

function parseTotals(usage: Record<string, unknown>): TokdashReportTotals {
  return {
    tokens: requiredNumber(usage.total_tokens, 'total_tokens'),
    cost: requiredNumber(usage.total_cost, 'total_cost'),
    requests: requiredNumber(usage.total_messages, 'total_messages'),
    tokensIn: null,
    tokensOut: null,
    tokensCache: null,
    cacheHitRate: optionalNumber(usage.cache_hit_rate),
  };
}

function parseComparison(value: unknown): TokdashReportComparison | null {
  if (!isRecord(value)) return null;
  return {
    tokensPrev: optionalNumber(value.tokens_prev),
    costPrev: optionalNumber(value.cost_prev),
    requestsPrev: optionalNumber(value.messages_prev),
    tokensPct: optionalNumber(value.tokens_pct),
    costPct: optionalNumber(value.cost_pct),
    requestsPct: optionalNumber(value.messages_pct),
  };
}

function parseModels(value: unknown, limit: number): TokdashReportModel[] {
  if (!Array.isArray(value)) return [];
  const models: TokdashReportModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = optionalString(entry.name);
    if (name === null) continue;
    models.push({
      name,
      tokens: numberOrZero(entry.tokens),
      cost: numberOrZero(entry.cost),
      tokensIn: optionalNumber(entry.tokens_in),
      tokensOut: optionalNumber(entry.tokens_out),
      tokensCache: optionalNumber(entry.tokens_cache),
      requests: optionalInteger(entry.messages),
    });
    if (models.length >= limit) break;
  }
  return models;
}

/**
 * Merge the three per-tool views Tokdash serves into one row set.
 *
 * `by_tool` is the complete source set and owns tokens and cost; `coding_apps` owns the in/out/cache
 * split and the request count and says which sources are coding apps; `/api/active-time` owns the
 * label, the session count and the active milliseconds. A tool present in one view and not another
 * keeps `null` in the missing cells — the report em-dashes them, which is the honest rendering of
 * "this API has no value here" and is not the same claim as zero.
 */
function parseTools(
  usage: Record<string, unknown>,
  activeTime: Record<string, unknown> | null,
): TokdashReportTool[] {
  const byTool = isRecord(usage.by_tool) ? usage.by_tool : {};
  const codingApps = isRecord(usage.coding_apps) ? usage.coding_apps : {};
  const activeByTool = activeTime && isRecord(activeTime.by_tool) ? activeTime.by_tool : {};

  const tools: TokdashReportTool[] = [];
  for (const [tool, raw] of Object.entries(byTool)) {
    if (!isRecord(raw)) continue;
    const coding = isRecord(codingApps[tool]) ? (codingApps[tool] as Record<string, unknown>) : null;
    const active = isRecord(activeByTool[tool]) ? (activeByTool[tool] as Record<string, unknown>) : null;
    tools.push({
      tool,
      label: active ? optionalString(active.tool_label) : null,
      tokens: numberOrZero(raw.tokens),
      cost: numberOrZero(raw.cost),
      tokensIn: optionalNumber(raw.tokens_in ?? coding?.tokens_in),
      tokensOut: optionalNumber(coding?.tokens_out),
      tokensCache: optionalNumber(raw.tokens_cache ?? coding?.tokens_cache),
      cacheHitRate: optionalNumber(raw.cache_hit_rate ?? coding?.cache_hit_rate),
      requests: optionalInteger(coding?.messages),
      sessions: active ? optionalInteger(active.session_count) : null,
      activeMs: active ? optionalNumber(active.active_ms) : null,
      coding: coding !== null,
    });
  }
  tools.sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool));
  return tools;
}

function parseActiveTime(value: Record<string, unknown> | null): TokdashReportActiveTime | null {
  if (value === null) return null;
  const comparison = isRecord(value.comparison) ? value.comparison : {};
  const byTool = isRecord(value.by_tool) ? value.by_tool : {};
  let sessions: number | null = null;
  for (const raw of Object.values(byTool)) {
    if (!isRecord(raw)) continue;
    const count = optionalInteger(raw.session_count);
    if (count === null) continue;
    sessions = (sessions ?? 0) + count;
  }
  return {
    activeMs: optionalNumber(value.active_ms),
    activeMsSum: optionalNumber(value.active_ms_sum),
    activeMsPct: optionalNumber(comparison.active_ms_pct),
    estimated: value.active_time_estimated !== false,
    gapCapMs: optionalNumber(value.active_gap_cap_ms),
    method: optionalString(value.active_time_method),
    sessions,
  };
}

/** One facet, addressed by name. Tokdash serves them as siblings of `range` on the insights body. */
function facet(insights: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const value = insights[name];
  return isRecord(value) ? value : null;
}

function parseHourly(insights: Record<string, unknown>): TokdashReportHourly | null {
  const hourly = facet(insights, 'hourly');
  if (hourly === null || !Array.isArray(hourly.buckets)) return null;
  const buckets: TokdashReportHourly['buckets'] = [];
  for (const entry of hourly.buckets) {
    if (!isRecord(entry)) continue;
    const hour = optionalInteger(entry.hour);
    if (hour === null) continue;
    buckets.push({
      hour,
      tokens: numberOrZero(entry.tokens),
      cost: numberOrZero(entry.cost),
      requests: optionalInteger(entry.messages) ?? 0,
    });
  }
  if (buckets.length === 0) return null;
  return {
    buckets,
    peakHour: optionalInteger(hourly.peak_hour),
    nightShare: optionalNumber(hourly.night_share),
    nightHours: Array.isArray(hourly.night_hours)
      ? hourly.night_hours
          .map((entry) => optionalInteger(entry))
          .filter((entry): entry is number => entry !== null)
      : [],
  };
}

function parseWeekday(insights: Record<string, unknown>): TokdashReportWeekday | null {
  const weekday = facet(insights, 'weekday');
  if (weekday === null || !Array.isArray(weekday.buckets)) return null;
  const buckets: TokdashReportWeekday['buckets'] = [];
  for (const entry of weekday.buckets) {
    if (!isRecord(entry)) continue;
    const index = optionalInteger(entry.weekday);
    if (index === null) continue;
    buckets.push({
      weekday: index,
      name: optionalString(entry.name),
      tokens: numberOrZero(entry.tokens),
      cost: numberOrZero(entry.cost),
      requests: optionalInteger(entry.messages) ?? 0,
    });
  }
  if (buckets.length === 0) return null;
  return { buckets, peakWeekday: optionalInteger(weekday.peak_weekday) };
}

function parseDaily(insights: Record<string, unknown>): TokdashReportDay[] | null {
  const daily = insights.daily;
  if (!Array.isArray(daily)) return null;
  const days: TokdashReportDay[] = [];
  for (const entry of daily) {
    if (!isRecord(entry)) continue;
    const date = optionalString(entry.date);
    if (date === null) continue;
    days.push({
      date,
      tokens: numberOrZero(entry.tokens),
      cost: numberOrZero(entry.cost),
      requests: optionalInteger(entry.messages) ?? 0,
      intensity: optionalInteger(entry.intensity),
    });
  }
  return days.length === 0 ? null : days;
}

function parseProjects(insights: Record<string, unknown>): TokdashReportProjects | null {
  const projects = facet(insights, 'projects');
  if (projects === null || !Array.isArray(projects.projects)) return null;
  const rows: TokdashReportProjects['rows'] = [];
  for (const entry of projects.projects) {
    if (!isRecord(entry)) continue;
    const project = optionalString(entry.project);
    if (project === null) continue;
    rows.push({
      project,
      tokens: numberOrZero(entry.tokens),
      cost: numberOrZero(entry.cost),
      requests: optionalInteger(entry.messages) ?? 0,
    });
  }
  const unattributed = isRecord(projects.unattributed) ? projects.unattributed : null;
  return {
    rows,
    unattributed: unattributed === null
      ? null
      : {
          tokens: numberOrZero(unattributed.tokens),
          cost: numberOrZero(unattributed.cost),
          requests: optionalInteger(unattributed.messages) ?? 0,
        },
    attributedCount: optionalInteger(projects.attributed_project_count),
    namesIncluded: projects.names_included !== false,
  };
}

function parseStreaks(insights: Record<string, unknown>): TokdashReportStreaks | null {
  const streaks = facet(insights, 'streaks');
  if (streaks === null) return null;
  return {
    currentStreak: optionalInteger(streaks.current_streak),
    longestStreak: optionalInteger(streaks.longest_streak),
    activeDays: optionalInteger(streaks.active_days),
    totalDays: optionalInteger(streaks.total_days),
  };
}

function parseFirsts(insights: Record<string, unknown>): TokdashReportFirsts | null {
  const firsts = facet(insights, 'firsts');
  if (firsts === null) return null;
  return {
    firstActiveDay: optionalString(firsts.first_active_day),
    lastActiveDay: optionalString(firsts.last_active_day),
    busiestDay: optionalString(firsts.busiest_day),
    busiestDayTokens: optionalNumber(firsts.busiest_day_tokens),
  };
}

function parseCoverage(insights: Record<string, unknown>): TokdashReportCoverage | null {
  const coverage = facet(insights, 'coverage');
  if (coverage === null) return null;
  const storedSources = stringList(coverage.stored_sources);
  const liveSources = stringList(coverage.live_sources);
  return {
    storedSources,
    liveSources,
    // The count is derived rather than read so the footer can never cite a number the two lists
    // contradict, and so a stale remembered total (the design's "23 sources") cannot survive drift.
    sourceCount: storedSources.length + liveSources.length,
  };
}

/** Whether an upstream failure means "this Tokdash has no insights API" rather than "it broke". */
function insightsRefusal(error: unknown): TokdashReportInsightsRefusal {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 400 ? 'unsupported' : 'unavailable';
}

/**
 * Read one window and project it into the report DTO.
 *
 * `/api/usage` is mandatory: it carries the period total, and every share on every surface
 * reconciles against it. `/api/active-time` and the insights scan are optional — the report renders
 * without them, minus the sections they feed.
 */
export async function fetchTokdashReport(
  baseInput: unknown,
  window: TokdashReportWindow,
  options: TokdashReportFetchOptions = {},
): Promise<TokdashReport> {
  if (!isTokdashReportDate(window.from) || !isTokdashReportDate(window.to)) {
    throw new Error('Invalid Tokdash report window: from and to must be YYYY-MM-DD dates');
  }
  if (window.from > window.to) {
    throw new Error('Invalid Tokdash report window: from must not be after to');
  }
  const baseUrl = normalizeTokdashQuotaBaseUrl(baseInput);
  const query = windowQuery(window);

  const usageBody = await getJson(`${baseUrl}/api/usage?${query}`, options, 'usage');
  if (!isRecord(usageBody)) invalid('body', 'an object');

  const [activeSettled, insightsSettled] = await Promise.allSettled([
    getJson(`${baseUrl}/api/active-time?${query}`, options, 'active-time'),
    getJson(
      `${baseUrl}/api/insights?facets=${TOKDASH_REPORT_FACETS.join(',')}&${query}`,
      options,
      'insights',
    ),
  ]);

  const activeBody = activeSettled.status === 'fulfilled' && isRecord(activeSettled.value)
    ? activeSettled.value
    : null;

  let insights: Record<string, unknown> | null = null;
  let insightsUnavailable: TokdashReportInsightsRefusal | null = null;
  if (insightsSettled.status === 'rejected') {
    insightsUnavailable = insightsRefusal(insightsSettled.reason);
  } else if (!isRecord(insightsSettled.value)) {
    insightsUnavailable = 'malformed';
  } else {
    insights = insightsSettled.value;
  }

  // The insights body carries the authoritative range for the scan; usage's echo is the fallback.
  const range = parseRange(insights?.range ?? usageBody.range, window);
  const totals = parseTotals(usageBody);
  const codingApps = isRecord(usageBody.coding_apps) ? usageBody.coding_apps : {};
  for (const raw of Object.values(codingApps)) {
    if (!isRecord(raw)) continue;
    totals.tokensIn = (totals.tokensIn ?? 0) + numberOrZero(raw.tokens_in);
    totals.tokensOut = (totals.tokensOut ?? 0) + numberOrZero(raw.tokens_out);
    totals.tokensCache = (totals.tokensCache ?? 0) + numberOrZero(raw.tokens_cache);
  }

  return {
    range,
    timezone: insights === null ? null : optionalString(insights.timezone),
    totals,
    comparison: parseComparison(usageBody.comparison),
    activeTime: parseActiveTime(activeBody),
    tools: parseTools(usageBody, activeBody),
    topModelsByTokens: parseModels(usageBody.top_models, 10),
    topModelsByCost: parseModels(usageBody.top_models_by_cost, 10),
    hourly: insights === null ? null : parseHourly(insights),
    weekday: insights === null ? null : parseWeekday(insights),
    daily: insights === null ? null : parseDaily(insights),
    projects: insights === null ? null : parseProjects(insights),
    streaks: insights === null ? null : parseStreaks(insights),
    firsts: insights === null ? null : parseFirsts(insights),
    coverage: insights === null ? null : parseCoverage(insights),
    sourceErrors: stringList(usageBody.source_errors),
    insightsUnavailable,
  };
}

/** A cached window and when it was built. */
export interface TokdashReportCacheEntry {
  report: TokdashReport;
  cachedAt: number;
}

/**
 * Per-`(from, to)` cache with a bounded, least-recently-used footprint.
 *
 * The composite insights scan is a full-window pass over Tokdash's SQLite, and the report page walks
 * the same four windows back and forth. Without this, a period switcher re-scans a year every time
 * the user glances at Month and comes back.
 */
export class TokdashReportCache {
  readonly #entries = new Map<string, TokdashReportCacheEntry>();
  readonly #inFlight = new Map<string, Promise<TokdashReportCacheEntry>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  /** Creates a cache. `now` is injectable so expiry is testable without waiting. */
  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = Math.max(0, options.ttlMs ?? TOKDASH_REPORT_CACHE_MS);
    this.#maxEntries = Math.max(1, options.maxEntries ?? TOKDASH_REPORT_CACHE_ENTRIES);
    this.#now = options.now ?? Date.now;
  }

  /** The live entry for a window, or `undefined` when absent or expired. */
  get(window: TokdashReportWindow): TokdashReportCacheEntry | undefined {
    const key = cacheKey(window);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#now() - entry.cachedAt >= this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    // Re-insert so recency ordering tracks use, not first write.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  /** Stores a window, evicting the least recently used entry when full. */
  set(window: TokdashReportWindow, report: TokdashReport): TokdashReportCacheEntry {
    const key = cacheKey(window);
    const entry: TokdashReportCacheEntry = { report, cachedAt: this.#now() };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return entry;
  }

  /**
   * Serve a window, reading it at most once however many callers ask at the same time.
   *
   * A cold year scan takes tens of seconds upstream, and Tokdash sheds concurrent requests for a
   * window it is still computing with a 503. Without coalescing, a second viewer — or a rebuild, or
   * a period switcher returning to a window whose first read has not landed — starts a duplicate
   * scan and is the one that gets refused, so the same window both succeeds and fails depending on
   * who asked first. Sharing the in-flight promise makes the second caller wait for the first
   * caller's answer, which is the answer it wanted anyway.
   */
  async load(
    window: TokdashReportWindow,
    loader: () => Promise<TokdashReport>,
  ): Promise<{ entry: TokdashReportCacheEntry; servedFromCache: boolean }> {
    const cached = this.get(window);
    if (cached) return { entry: cached, servedFromCache: true };

    const key = cacheKey(window);
    const pending = this.#inFlight.get(key);
    // A caller that joins an in-flight read did not serve a stored entry, but it also did not spend
    // an upstream scan; reporting it as a cache hit is the honest half of that.
    if (pending) return { entry: await pending, servedFromCache: true };

    const promise = loader()
      .then((report) => this.set(window, report))
      .finally(() => {
        this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, promise);
    return { entry: await promise, servedFromCache: false };
  }

  /** Drops every window. In-flight reads are left to settle into a cache nobody will read. */
  clear(): void {
    this.#entries.clear();
  }

  /** How many windows are retained, expired ones included. */
  get size(): number {
    return this.#entries.size;
  }
}

function cacheKey(window: TokdashReportWindow): string {
  return `${window.from}|${window.to}`;
}
