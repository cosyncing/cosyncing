/**
 * Durable scheduled-send store (part-3 #50).
 *
 * Two schedule kinds, per maintainer's D5 (2026-07-15):
 *  - 'message'      → deliver a prompt to an EXISTING session at time T (always one-shot).
 *  - 'new-session'  → create a session (directory/title like POST /api/sessions/:tool) and send
 *                     its first prompt at T; supports one-shot plus simple daily/weekdays repeats.
 *
 * The prompt fires with NO model/agent/permissionMode overrides (D6: "everything has to be the
 * same, basically like sending another prompt, but just scheduled") — delivery goes through the
 * exact same session-control gates the composer uses.
 *
 * Location: `${setupStateHome()}/schedules.json` — survives broker restarts and cache wipes; the
 * runner rearms from this file at startup and applies the missed-fire policy (D7).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ScheduleCreate,
  ScheduleCron,
  ScheduleErrorCode,
  ScheduleFailureKind,
  ScheduleOutcome,
  ScheduleRecord,
  ScheduleRepeat,
  ScheduleRetryPolicy,
  ScheduleUpdate,
} from '@cosyncing/protocol';
import { setupStateHome } from '../installation/setup-state.ts';

export type {
  ScheduleCreate,
  ScheduleKind,
  ScheduleCron,
  ScheduleErrorCode,
  ScheduleFailureKind,
  ScheduleOutcome,
  ScheduleRecord,
  ScheduleRepeat,
  ScheduleState,
  ScheduleRetryPolicy,
  ScheduleUpdate,
} from '@cosyncing/protocol';

/** Terminal rows kept for the Schedules list; older ones are pruned on write. */
const MAX_FINISHED = 50;
/** Hard cap on live schedules — bounds the file and the per-tick scan. */
export const MAX_SCHEDULED = 100;

export class ScheduleMutationError extends Error {
  constructor(readonly code: ScheduleErrorCode, message: string) {
    super(message);
  }
}

type StoredScheduleAuthority =
  | { kind: 'owner' }
  | { kind: 'legacy-unprovenanced' };

interface StoredScheduleRecord extends ScheduleRecord {
  createdBy: StoredScheduleAuthority;
  securityRevision: 16 | 17;
  legacyQuarantinedAt?: number;
}

interface LegacyScheduleFile {
  version: 1;
  schedules: unknown[];
}

interface ScheduleFile {
  version: 2;
  schedules: StoredScheduleRecord[];
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallParts(epochMs: number, timeZone: string): WallParts {
  const values: Record<string, number> = {};
  for (const part of zonedFormatter(timeZone).formatToParts(epochMs)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year!, month: values.month!, day: values.day!, hour: values.hour!,
    minute: values.minute!, second: values.second!, millisecond: values.fractionalSecond ?? 0,
  };
}

function wallStamp(parts: WallParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
}

function sameWall(a: WallParts, b: WallParts): boolean {
  return wallStamp(a) === wallStamp(b);
}

function addWallDay(parts: WallParts): WallParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { ...parts, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function recurrenceTime(parts: WallParts): string {
  return [parts.hour, parts.minute, parts.second].map((n) => String(n).padStart(2, '0')).join(':')
    + `.${String(parts.millisecond).padStart(3, '0')}`;
}

function parseRecurrenceTime(value: string | undefined, fallback: WallParts): Pick<WallParts, 'hour' | 'minute' | 'second' | 'millisecond'> {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value ?? '');
  if (!match) return fallback;
  const [hour, minute, second, millisecond] = match.slice(1).map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59 || millisecond! > 999) return fallback;
  return { hour: hour!, minute: minute!, second: second!, millisecond: millisecond! };
}

/** Convert one wall-clock datetime in an IANA zone to epoch ms. Exact matches cover normal and
 *  fall-back times (earliest duplicate wins). In a spring-forward gap, use the first real local
 *  instant after the requested wall time; recurrenceTime keeps later days anchored to the original
 *  clock time instead of permanently shifting by the DST gap. */
function epochForWall(target: WallParts, timeZone: string): number {
  const desired = wallStamp(target);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = desired + hours * 3_600_000;
    offsets.add(wallStamp(wallParts(probe, timeZone)) - probe);
  }
  const exact: number[] = [];
  const later: number[] = [];
  for (const offset of offsets) {
    const candidate = desired - offset;
    const actual = wallParts(candidate, timeZone);
    if (sameWall(actual, target)) exact.push(candidate);
    else if (actual.year === target.year && actual.month === target.month && actual.day === target.day && wallStamp(actual) > desired) {
      later.push(candidate);
    }
  }
  if (exact.length) return Math.min(...exact);
  if (later.length) return later.sort((a, b) => wallStamp(wallParts(a, timeZone)) - wallStamp(wallParts(b, timeZone)))[0]!;
  throw new Error(`cannot resolve recurrence time in ${timeZone}`);
}

export function isValidTimeZone(value: string): boolean {
  try { zonedFormatter(value); return true; } catch { return false; }
}

interface ParsedCronField {
  values: Set<number>;
  wildcard: boolean;
}

function parseCronField(raw: string, min: number, max: number, normalize?: (value: number) => number): ParsedCronField {
  const values = new Set<number>();
  const add = (value: number) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron field value is out of range');
    values.add(normalize ? normalize(value) : value);
  };
  for (const part of raw.split(',')) {
    if (!part) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron field is empty');
    const [base, stepRaw, ...extra] = part.split('/');
    if (extra.length) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron field has too many step separators');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron step must be a positive integer');
    let start: number;
    let end: number;
    if (base === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(base ?? '')) {
      start = Number(base);
      end = stepRaw === undefined ? start : max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(base ?? '');
      if (!range) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron supports only numeric values, ranges, lists, wildcards, and steps');
      start = Number(range[1]);
      end = Number(range[2]);
      if (start > end) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron range is reversed');
    }
    if (start < min || end > max) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron field value is out of range');
    for (let value = start; value <= end; value += step) add(value);
  }
  return { values, wildcard: raw === '*' || /^\*\//.test(raw) };
}

interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron must have five fields: minute hour day-of-month month day-of-week');
  return {
    minute: parseCronField(fields[0]!, 0, 59),
    hour: parseCronField(fields[1]!, 0, 23),
    dayOfMonth: parseCronField(fields[2]!, 1, 31),
    month: parseCronField(fields[3]!, 1, 12),
    dayOfWeek: parseCronField(fields[4]!, 0, 7, (value) => value === 7 ? 0 : value),
  };
}

export function validateScheduleCron(cron: ScheduleCron): ScheduleCron {
  const expression = typeof cron?.expression === 'string' ? cron.expression.trim() : '';
  const timeZone = typeof cron?.timeZone === 'string' ? cron.timeZone.trim() : '';
  if (!expression) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron expression is required');
  if (!timeZone || !isValidTimeZone(timeZone)) throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron timeZone must be a valid IANA time-zone name');
  parseCron(expression);
  return { expression, timeZone };
}

/** Next matching minute strictly after `afterMs`. Day-of-month/day-of-week follow standard cron OR
 * semantics when both are restricted. Search is bounded to five years. */
export function nextCronOccurrence(cronInput: ScheduleCron, afterMs: number): number {
  const cron = validateScheduleCron(cronInput);
  const parsed = parseCron(cron.expression);
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const deadline = candidate + 5 * 366 * 24 * 60 * 60_000;
  while (candidate <= deadline) {
    const wall = wallParts(candidate, cron.timeZone);
    if (!parsed.minute.values.has(wall.minute)) {
      let delta = 1;
      while (delta < 60 && !parsed.minute.values.has((wall.minute + delta) % 60)) delta++;
      candidate += delta * 60_000;
      continue;
    }
    if (!parsed.hour.values.has(wall.hour)) {
      candidate += 60 * 60_000;
      continue;
    }
    if (!parsed.month.values.has(wall.month)) {
      candidate += 24 * 60 * 60_000;
      continue;
    }
    const dayOfWeek = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
    const dom = parsed.dayOfMonth.values.has(wall.day);
    const dow = parsed.dayOfWeek.values.has(dayOfWeek);
    const dayMatches = parsed.dayOfMonth.wildcard
      ? dow
      : parsed.dayOfWeek.wildcard
        ? dom
        : dom || dow;
    if (dayMatches) return candidate;
    candidate += 24 * 60 * 60_000;
  }
  throw new ScheduleMutationError('SCHEDULE_CRON_INVALID', 'cron has no occurrence within five years');
}

export function validateRetryPolicy(input: ScheduleRetryPolicy): ScheduleRetryPolicy {
  const maxRetries = Number(input?.maxRetries);
  const delayMs = Number(input?.delayMs);
  const backoff = input?.backoff;
  const retryOn = Array.isArray(input?.retryOn) ? [...new Set(input.retryOn)] : [];
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new ScheduleMutationError('SCHEDULE_INVALID', 'retry maxRetries must be an integer from 0 to 10');
  if (!Number.isFinite(delayMs) || delayMs < 1_000 || delayMs > 24 * 60 * 60_000) throw new ScheduleMutationError('SCHEDULE_INVALID', 'retry delayMs must be from 1000 through 86400000');
  if (backoff !== 'fixed' && backoff !== 'exponential') throw new ScheduleMutationError('SCHEDULE_INVALID', 'retry backoff must be fixed or exponential');
  if (!retryOn.length || retryOn.some((kind) => kind !== 'delivery' && kind !== 'quota')) throw new ScheduleMutationError('SCHEDULE_INVALID', 'retryOn must contain delivery and/or quota');
  return { maxRetries, delayMs, backoff, retryOn };
}

/** Next occurrence strictly after `afterMs`. When an IANA zone is supplied, whole calendar days
 *  are stepped in that zone (normally the scheduling phone/browser), not the broker host's zone. */
export function nextOccurrence(
  fromMs: number,
  repeat: ScheduleRepeat,
  afterMs: number,
  timeZone?: string,
  timeOfDay?: string,
): number {
  if (timeZone && isValidTimeZone(timeZone)) {
    const from = wallParts(fromMs, timeZone);
    const clock = parseRecurrenceTime(timeOfDay, from);
    let candidate = { ...addWallDay(from), ...clock };
    for (;;) {
      const weekday = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day)).getUTCDay();
      if (repeat !== 'weekdays' || (weekday !== 0 && weekday !== 6)) {
        const epoch = epochForWall(candidate, timeZone);
        if (epoch > afterMs) return epoch;
      }
      candidate = { ...addWallDay(candidate), ...clock };
    }
  }
  const d = new Date(fromMs);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getTime() <= afterMs || (repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)));
  return d.getTime();
}

function emptyFile(): ScheduleFile {
  return { version: 2, schedules: [] };
}

function reportPersistenceError(callback: ((error: unknown) => void) | undefined, error: unknown): void {
  try { callback?.(error); } catch { /* observer-only */ }
}

function cleanOptional(value: string | null | undefined, maxLength?: number): string | undefined {
  if (value == null) return undefined;
  const cleaned = value.trim();
  return cleaned ? (maxLength === undefined ? cleaned : cleaned.slice(0, maxLength)) : undefined;
}

function readFile(
  path: string,
  now: () => number,
  onPersistenceError?: (error: unknown) => void,
): { state: ScheduleFile; migrated: boolean } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LegacyScheduleFile | ScheduleFile>;
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.schedules)) {
      throw new Error('unsupported schedule store schema');
    }
    const legacy = raw.version === 1;
    const quarantinedAt = now();
    const schedules = raw.schedules.map((value): StoredScheduleRecord => {
      if (!value || typeof value !== 'object') throw new Error('invalid schedule store record');
      const schedule = value as ScheduleRecord & {
        revision?: unknown;
        createdBy?: unknown;
        securityRevision?: unknown;
      };
      if (typeof schedule.id !== 'string' || typeof schedule.text !== 'string' || !Number.isFinite(schedule.at)) {
        throw new Error('invalid schedule store record');
      }
      // Revision was added after the initial schedule-store release. Treat an absent field as the
      // first revision, but reject malformed present values instead of silently weakening CAS.
      const revision = schedule.revision === undefined ? 1 : schedule.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid schedule revision');
      if (legacy) {
        const live = schedule.state === 'scheduled' || schedule.state === 'paused';
        return {
          ...schedule,
          revision: live ? revision + 1 : revision,
          state: live ? 'canceled' : schedule.state,
          updatedAt: live ? quarantinedAt : schedule.updatedAt,
          createdBy: { kind: 'legacy-unprovenanced' },
          securityRevision: 16,
          ...(live ? { legacyQuarantinedAt: quarantinedAt } : {}),
        };
      }
      if (!isStoredScheduleAuthority(schedule.createdBy)
        || !storedScheduleProvenanceIsSafe(schedule.createdBy, schedule.securityRevision, schedule.state)) {
        throw new Error('invalid schedule authorization provenance');
      }
      return {
        ...schedule,
        revision,
        createdBy: schedule.createdBy,
        securityRevision: schedule.securityRevision as 16 | 17,
      };
    });
    return { state: { version: 2, schedules }, migrated: legacy };
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return { state: emptyFile(), migrated: false };
    // Preserve malformed or unreadable state for diagnosis instead of letting the next successful
    // create silently overwrite it. Recovery starts from an empty in-memory list.
    const backup = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
    try { renameSync(path, backup); } catch { /* retain the original in place if backup fails */ }
    reportPersistenceError(onPersistenceError, error);
    return { state: emptyFile(), migrated: false };
  }
}

function isStoredScheduleAuthority(raw: unknown): raw is StoredScheduleAuthority {
  if (!raw || typeof raw !== 'object') return false;
  const kind = (raw as { kind?: unknown }).kind;
  return kind === 'owner' || kind === 'legacy-unprovenanced';
}

function storedScheduleProvenanceIsSafe(
  authority: StoredScheduleAuthority,
  securityRevision: unknown,
  state: ScheduleRecord['state'],
): boolean {
  return authority.kind === 'owner'
    ? securityRevision === 17
    : securityRevision === 16 && state === 'canceled';
}

export interface ScheduleStoreOptions {
  path?: string;
  now?: () => number;
  idFactory?: () => string;
  onPersistenceError?: (error: unknown) => void;
}

export class ScheduleStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly onPersistenceError?: (error: unknown) => void;
  private state: ScheduleFile;

  constructor(options: ScheduleStoreOptions = {}) {
    this.file = options.path ?? join(setupStateHome(), 'schedules.json');
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onPersistenceError = options.onPersistenceError;
    const loaded = readFile(this.file, this.now, this.onPersistenceError);
    this.state = loaded.state;
    // Persist the quarantine before a runner can observe this store. A write failure propagates
    // from the constructor and prevents the broker from advertising revision-17 readiness.
    if (loaded.migrated) this.save();
  }

  list(): ScheduleRecord[] {
    // Live schedules first (soonest fire first), then finished newest-first.
    return [...this.state.schedules].sort((a, b) => {
      const liveA = a.state === 'scheduled' || a.state === 'paused' ? 0 : 1;
      const liveB = b.state === 'scheduled' || b.state === 'paused' ? 0 : 1;
      if (liveA !== liveB) return liveA - liveB;
      return liveA === 0 ? a.at - b.at : b.updatedAt - a.updatedAt;
    });
  }

  get(id: string): ScheduleRecord | undefined {
    return this.state.schedules.find((s) => s.id === id);
  }

  /** Live rows that are due (or overdue) at `nowMs`. */
  due(nowMs: number): ScheduleRecord[] {
    return this.state.schedules.filter((s) => s.state === 'scheduled' && s.at <= nowMs);
  }

  /** Earliest live fire time, for the runner's timer. */
  nextAt(exclude: ReadonlySet<string> = new Set()): number | undefined {
    let next: number | undefined;
    for (const s of this.state.schedules) {
      if (s.state !== 'scheduled' || exclude.has(s.id)) continue;
      if (next === undefined || s.at < next) next = s.at;
    }
    return next;
  }

  scheduledCount(): number {
    return this.state.schedules.filter((s) => s.state === 'scheduled' || s.state === 'paused').length;
  }

  create(input: ScheduleCreate): ScheduleRecord {
    return this.persistMutation(() => {
      const now = this.now();
      if (input.repeat && input.cron) throw new ScheduleMutationError('SCHEDULE_INVALID', 'repeat and cron are mutually exclusive');
      if (input.kind === 'message' && input.repeat) throw new ScheduleMutationError('SCHEDULE_INVALID', 'message schedules do not support legacy repeat');
      if (input.kind === 'message' && input.cron) throw new ScheduleMutationError('SCHEDULE_INVALID', 'message schedules are one-shot and do not support cron');
      const cron = input.cron ? validateScheduleCron(input.cron) : undefined;
      const at = cron ? nextCronOccurrence(cron, now) : Number(input.at);
      if (!Number.isFinite(at) || at <= 0) throw new ScheduleMutationError('SCHEDULE_INVALID', 'at is required when cron is absent');
      const retryPolicy = input.retryPolicy ? validateRetryPolicy(input.retryPolicy) : undefined;
      const record: StoredScheduleRecord = {
        ...input,
        at,
        ...(cron ? { cron } : {}),
        ...(retryPolicy ? { retryPolicy } : {}),
        id: this.idFactory(),
        revision: 1,
        state: 'scheduled',
        createdAt: now,
        updatedAt: now,
        createdBy: { kind: 'owner' },
        securityRevision: 17,
      };
      if (record.repeat) {
        record.timeZone = record.timeZone && isValidTimeZone(record.timeZone)
          ? record.timeZone
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
        record.recurrenceTime = recurrenceTime(wallParts(record.at, record.timeZone));
      }
      this.state.schedules.push(record);
      return record;
    });
  }

  /** Persist a newly created target before its first prompt is handed off. A broker crash or retry
   * then resumes the same session instead of creating another empty session. */
  recordPendingSession(id: string, sessionId: string): ScheduleRecord | undefined {
    const record = this.get(id);
    if (!record || record.kind !== 'new-session' || record.state !== 'scheduled') return undefined;
    if (record.pendingSessionId === sessionId) return record;
    if (record.pendingSessionId) {
      throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'schedule occurrence already has a created session');
    }
    return this.persistMutation(() => {
      record.pendingSessionId = sessionId;
      return this.touch(record);
    });
  }

  /** Edit a live schedule. Tool, kind, and target session remain immutable. */
  update(id: string, input: ScheduleUpdate): ScheduleRecord {
    return this.persistMutation(() => {
      const record = this.requireRevision(id, input.expectedRevision);
      if (record.state !== 'scheduled' && record.state !== 'paused') {
        throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'only scheduled or paused rows can be edited');
      }
      const has = (key: keyof ScheduleUpdate) => Object.prototype.hasOwnProperty.call(input, key);
      if (has('text')) {
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text || text.length > 32_000) throw new ScheduleMutationError('SCHEDULE_INVALID', 'text must contain 1 through 32000 characters');
        record.text = text;
      }
      if (has('sessionTitle')) {
        if (record.kind !== 'message') throw new ScheduleMutationError('SCHEDULE_INVALID', 'sessionTitle applies only to message schedules');
        record.sessionTitle = cleanOptional(input.sessionTitle, 160);
      }
      if (has('directory')) {
        if (record.kind !== 'new-session') throw new ScheduleMutationError('SCHEDULE_INVALID', 'directory applies only to new-session schedules');
        record.directory = cleanOptional(input.directory);
      }
      if (has('title')) {
        if (record.kind !== 'new-session') throw new ScheduleMutationError('SCHEDULE_INVALID', 'title applies only to new-session schedules');
        record.title = cleanOptional(input.title, 160);
      }

      if (has('repeat')) {
        if (record.kind !== 'new-session' && input.repeat != null) throw new ScheduleMutationError('SCHEDULE_INVALID', 'repeat applies only to new-session schedules');
        if (input.repeat != null && input.repeat !== 'daily' && input.repeat !== 'weekdays') throw new ScheduleMutationError('SCHEDULE_INVALID', 'repeat must be daily or weekdays');
        record.repeat = input.repeat ?? undefined;
      }
      if (has('cron')) {
        if (record.kind !== 'new-session' && input.cron != null) throw new ScheduleMutationError('SCHEDULE_INVALID', 'cron applies only to new-session schedules');
        record.cron = input.cron == null ? undefined : validateScheduleCron(input.cron);
      }
      if (record.repeat && record.cron) throw new ScheduleMutationError('SCHEDULE_INVALID', 'repeat and cron are mutually exclusive');

      if (has('timeZone')) {
        if (!record.repeat && input.timeZone != null) throw new ScheduleMutationError('SCHEDULE_INVALID', 'timeZone applies only to legacy repeat schedules');
        if (input.timeZone != null && !isValidTimeZone(input.timeZone)) throw new ScheduleMutationError('SCHEDULE_INVALID', 'timeZone must be a valid IANA time-zone name');
        record.timeZone = input.timeZone ?? undefined;
      }
      if (!record.repeat) {
        record.timeZone = undefined;
        record.recurrenceTime = undefined;
      }

      if (has('at') && record.cron) throw new ScheduleMutationError('SCHEDULE_INVALID', 'at cannot be set while cron is active');
      if (record.cron && has('cron')) {
        record.at = nextCronOccurrence(record.cron, this.now());
      } else if (has('at')) {
        const at = Number(input.at);
        if (!Number.isFinite(at) || at <= 0) throw new ScheduleMutationError('SCHEDULE_INVALID', 'at must be an epoch-ms timestamp');
        record.at = at;
      }
      if (record.repeat) {
        record.timeZone = record.timeZone && isValidTimeZone(record.timeZone)
          ? record.timeZone
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
        record.recurrenceTime = recurrenceTime(wallParts(record.at, record.timeZone));
      }
      if (has('retryPolicy')) record.retryPolicy = input.retryPolicy == null ? undefined : validateRetryPolicy(input.retryPolicy);
      this.clearRetry(record);
      record.lastFailureKind = undefined;
      record.lastFailedSessionId = undefined;
      return this.touch(record);
    });
  }

  /** Edit a live one-shot existing-session message in place. The stable id is never replaced.
   *  Returns undefined on an ownership/freshness mismatch (kind/state/revision) rather than throwing. */
  edit(id: string, input: { text: string; at: number; expectedRevision: number }): ScheduleRecord | undefined {
    const record = this.get(id);
    if (
      !record ||
      record.kind !== 'message' ||
      record.state !== 'scheduled' ||
      record.revision !== input.expectedRevision
    ) return undefined;
    return this.persistMutation(() => {
      record.text = input.text;
      record.at = input.at;
      return this.touch(record);
    });
  }

  pause(id: string, expectedRevision: number): ScheduleRecord {
    return this.persistMutation(() => {
      const record = this.requireRevision(id, expectedRevision);
      if (record.state !== 'scheduled') throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'only a scheduled row can be paused');
      record.state = 'paused';
      return this.touch(record);
    });
  }

  resume(id: string, expectedRevision: number): ScheduleRecord {
    return this.persistMutation(() => {
      const record = this.requireRevision(id, expectedRevision);
      if (record.state !== 'paused') throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'only a paused row can be resumed');
      record.state = 'scheduled';
      return this.touch(record);
    });
  }

  /** Run immediately. For recurring rows this consumes/re-anchors the next occurrence. */
  runNow(id: string, expectedRevision: number): ScheduleRecord {
    return this.persistMutation(() => {
      const record = this.requireRevision(id, expectedRevision);
      if (record.state === 'paused' || record.state === 'canceled' || record.state === 'delivered') {
        throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'this row cannot run now');
      }
      record.state = 'scheduled';
      record.at = this.now();
      this.clearRetry(record);
      record.lastOutcome = undefined;
      record.lastFailureKind = undefined;
      record.lastError = undefined;
      if (record.kind === 'new-session' && !record.pendingSessionId && record.lastFailedSessionId) {
        record.pendingSessionId = record.lastFailedSessionId;
      }
      record.lastFailedSessionId = undefined;
      return this.touch(record);
    });
  }

  /** Rearm an exhausted quota-class failure after an operator confirms quota is available. */
  recoverQuota(id: string, expectedRevision: number): ScheduleRecord {
    return this.persistMutation(() => {
      const record = this.requireRevision(id, expectedRevision);
      if (record.lastOutcome !== 'failed' || record.lastFailureKind !== 'quota' || record.nextRetryAt !== undefined) {
        throw new ScheduleMutationError('SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE', 'the row has no exhausted quota failure');
      }
      if (record.state === 'paused' || record.state === 'canceled' || record.state === 'delivered') {
        throw new ScheduleMutationError('SCHEDULE_INVALID_STATE', 'this row cannot recover quota now');
      }
      record.state = 'scheduled';
      record.at = this.now();
      record.retryAttempt = 0;
      record.nextRetryAt = undefined;
      record.occurrenceAt = undefined;
      record.lastOutcome = undefined;
      record.lastFailureKind = undefined;
      record.lastError = undefined;
      if (record.kind === 'new-session' && !record.pendingSessionId && record.lastFailedSessionId) {
        record.pendingSessionId = record.lastFailedSessionId;
      }
      record.lastFailedSessionId = undefined;
      return this.touch(record);
    });
  }

  /** Cancel a live schedule (kept as a terminal row for the list). */
  cancel(id: string, expectedRevision?: number): ScheduleRecord | undefined {
    const record = this.get(id);
    if (!record || (record.state !== 'scheduled' && record.state !== 'paused')) return undefined;
    return this.persistMutation(() => {
      if (expectedRevision !== undefined) this.assertRevision(record, expectedRevision);
      record.state = 'canceled';
      this.clearRetry(record);
      return this.touch(record);
    });
  }

  /** Remove a terminal row entirely (list cleanup). Live rows must be canceled first. */
  remove(id: string): boolean {
    const idx = this.state.schedules.findIndex((s) => s.id === id && s.state !== 'scheduled' && s.state !== 'paused');
    if (idx < 0) return false;
    return this.persistMutation(() => {
      this.state.schedules.splice(idx, 1);
      return true;
    });
  }

  /** Record one occurrence's outcome. A repeating schedule advances `at` past `firedAt` and stays
   *  live; a one-shot moves to the terminal state matching the outcome. */
  recordOutcome(
    id: string,
    outcome: ScheduleOutcome,
    detail: { firedAt: number; error?: string; createdSessionId?: string; failureKind?: ScheduleFailureKind } ,
  ): ScheduleRecord | undefined {
    const record = this.get(id);
    if (!record || record.state !== 'scheduled') return undefined;
    record.lastFiredAt = detail.firedAt;
    record.lastOutcome = outcome;
    record.lastError = detail.error;
    record.lastFailureKind = outcome === 'failed' ? detail.failureKind ?? 'delivery' : undefined;
    if (detail.createdSessionId) record.createdSessionId = detail.createdSessionId;
    const occurrenceAt = record.occurrenceAt ?? record.at;
    const retryPolicy = record.retryPolicy;
    const retryAttempt = record.retryAttempt ?? 0;
    const failureKind = record.lastFailureKind;
    if (
      outcome === 'failed'
      && retryPolicy
      && failureKind
      && retryPolicy.retryOn.includes(failureKind)
      && retryAttempt < retryPolicy.maxRetries
    ) {
      const delay = retryPolicy.backoff === 'exponential'
        ? Math.min(24 * 60 * 60_000, retryPolicy.delayMs * (2 ** retryAttempt))
        : retryPolicy.delayMs;
      record.retryAttempt = retryAttempt + 1;
      record.occurrenceAt = occurrenceAt;
      record.nextRetryAt = detail.firedAt + delay;
      record.at = record.nextRetryAt;
    } else if (record.cron) {
      this.finishCreatedSessionAttempt(record, outcome);
      record.at = nextCronOccurrence(record.cron, detail.firedAt);
      this.clearRetry(record);
    } else if (record.repeat) {
      this.finishCreatedSessionAttempt(record, outcome);
      record.at = nextOccurrence(occurrenceAt, record.repeat, detail.firedAt, record.timeZone, record.recurrenceTime);
      this.clearRetry(record);
    } else {
      record.state = outcome;
      if (outcome === 'delivered') this.finishCreatedSessionAttempt(record, outcome);
      this.clearRetry(record);
    }
    this.touch(record);
    // A delivery has already happened by this point. Keep its outcome in memory if persistence
    // fails so this broker process never redelivers it; save still throws so the runner can report
    // the durability fault without misclassifying the delivery itself.
    this.save();
    return record;
  }

  private requireRevision(id: string, expectedRevision: number): ScheduleRecord {
    const record = this.get(id);
    if (!record) throw new ScheduleMutationError('SCHEDULE_NOT_FOUND', 'unknown schedule');
    this.assertRevision(record, expectedRevision);
    return record;
  }

  private assertRevision(record: ScheduleRecord, expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== record.revision) {
      throw new ScheduleMutationError('SCHEDULE_STALE', 'schedule revision does not match');
    }
  }

  private clearRetry(record: ScheduleRecord): void {
    record.retryAttempt = undefined;
    record.nextRetryAt = undefined;
    record.occurrenceAt = undefined;
  }

  private finishCreatedSessionAttempt(record: ScheduleRecord, outcome: ScheduleOutcome): void {
    if (record.kind !== 'new-session' || !record.pendingSessionId) return;
    if (outcome === 'delivered') {
      record.createdSessionId = record.pendingSessionId;
      record.lastFailedSessionId = undefined;
    } else {
      record.lastFailedSessionId = record.pendingSessionId;
    }
    record.pendingSessionId = undefined;
  }

  private touch(record: ScheduleRecord): ScheduleRecord {
    record.revision += 1;
    record.updatedAt = this.now();
    return record;
  }

  /** Persist a user-requested mutation atomically from the caller's perspective. An API response
   *  must never claim a schedule was created/canceled/removed when its durable write failed. */
  private persistMutation<T>(mutate: () => T): T {
    const before: ScheduleFile = {
      version: 2,
      schedules: this.state.schedules.map((schedule) => ({ ...schedule })),
    };
    try {
      const result = mutate();
      this.save();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  private save(): void {
    // Prune finished rows beyond the display window (never prunes live schedules).
    const finished = this.state.schedules
      .filter((s) => s.state !== 'scheduled' && s.state !== 'paused')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (finished.length > MAX_FINISHED) {
      const drop = new Set(finished.slice(MAX_FINISHED).map((s) => s.id));
      this.state.schedules = this.state.schedules.filter((s) => !drop.has(s.id));
    }
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // The file contains full prompt text. Keep it private on POSIX; rename preserves the mode.
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      reportPersistenceError(this.onPersistenceError, error);
      throw error;
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  }
}
