/** Structural and completeness checks for reports retained across broker restarts. */
import { isTokdashReportDate, isTokdashVersionBelowMinimum, type TokdashReport } from './tokdash-report.ts';

type RecordValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const number: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const string: Check = (value) => typeof value === 'string';
const boolean: Check = (value) => typeof value === 'boolean';
const nullable = (check: Check): Check => (value) => value === null || check(value);
const array = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const shape = (fields: Record<string, Check>): Check => (value) =>
  object(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const optionalNumber = nullable(number);
const optionalString = nullable(string);
const counts = { tokens: number, cost: number, requests: number };
const splits = { tokensIn: optionalNumber, tokensOut: optionalNumber, tokensCache: optionalNumber };
const model = shape({ ...counts, ...splits, requests: optionalNumber, name: string });
const date: Check = (value) => isTokdashReportDate(value);

/** Validate every field consumed by the client; absent fields are not equivalent to null. */
const reportShape = shape({
  range: shape({ from: date, to: date, days: optionalNumber, recognized: boolean, periodResolved: optionalString }),
  runtime: shape({ version: optionalString, minimumVersion: string, belowMinimum: boolean }),
  timezone: optionalString,
  totals: shape({ ...counts, ...splits, cacheHitRate: optionalNumber }),
  comparison: nullable(shape({
    tokensPrev: optionalNumber, costPrev: optionalNumber, requestsPrev: optionalNumber,
    tokensPct: optionalNumber, costPct: optionalNumber, requestsPct: optionalNumber,
  })),
  activeTime: nullable(shape({
    activeMs: optionalNumber, activeMsSum: optionalNumber, activeMsPct: optionalNumber,
    estimated: boolean, gapCapMs: optionalNumber, method: optionalString, sessions: optionalNumber,
  })),
  tools: array(shape({
    ...counts, ...splits, requests: optionalNumber, tool: string, label: optionalString,
    cacheHitRate: optionalNumber, sessions: optionalNumber, activeMs: optionalNumber, coding: boolean,
  })),
  topModelsByTokens: array(model),
  topModelsByCost: array(model),
  hourly: nullable(shape({
    buckets: array(shape({ ...counts, hour: number })), peakHour: optionalNumber,
    nightShare: optionalNumber, nightHours: array(number),
  })),
  weekday: nullable(shape({
    buckets: array(shape({ ...counts, weekday: number, name: optionalString })), peakWeekday: optionalNumber,
  })),
  daily: nullable(array(shape({ ...counts, date, intensity: optionalNumber }))),
  projects: nullable(shape({
    rows: array(shape({ ...counts, project: string })), unattributed: nullable(shape(counts)),
    attributedCount: optionalNumber, namesIncluded: boolean,
  })),
  streaks: nullable(shape({
    currentStreak: optionalNumber, longestStreak: optionalNumber, activeDays: optionalNumber, totalDays: optionalNumber,
  })),
  firsts: nullable(shape({
    firstActiveDay: optionalString, lastActiveDay: optionalString,
    busiestDay: optionalString, busiestDayTokens: optionalNumber,
  })),
  coverage: nullable(shape({ storedSources: array(string), liveSources: array(string), sourceCount: number })),
  sourceErrors: array(string),
  insightsUnavailable: (value) => value === null,
  projectsUnavailable: (value) => value === null,
});

/** Empty arrays and zero activity are valid; absent required facets and failed reads are not. */
export function isCompleteTokdashReport(value: unknown): value is TokdashReport {
  if (!reportShape(value)) return false;
  const report = value as TokdashReport;
  return report.runtime.version !== null
    && !isTokdashVersionBelowMinimum(report.runtime.version)
    && !report.runtime.belowMinimum
    && report.range.recognized && report.range.from <= report.range.to
    && report.activeTime !== null
    && number(report.activeTime.activeMs) && number(report.activeTime.activeMsSum)
    && number(report.activeTime.gapCapMs) && report.activeTime.method !== null
    && report.hourly !== null && report.weekday !== null && report.daily !== null
    && report.projects !== null && report.projects.namesIncluded
    && report.streaks !== null && Object.values(report.streaks).every(number)
    && report.firsts !== null && report.coverage !== null
    && report.sourceErrors.length === 0;
}
