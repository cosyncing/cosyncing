/**
 * Narrow, kept on purpose: when a repeating schedule fires next. Cron evaluation in a declared IANA
 * zone and wall-clock recurrence across a DST change are pure date math over fixed calendar dates;
 * an e2e suite would have to move the broker clock to those exact dates to reach them. Also the
 * bound on retained finished rows, which an e2e suite would need fifty deliveries to show.
 * Firing, missing, retrying and editing schedules are in e2e/broker/scheduled-sends.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SCHEDULED,
  nextCronOccurrence,
  nextOccurrence,
  ScheduleMutationError,
  ScheduleStore,
} from '../../src/scheduling/schedule-store.ts';

const MINUTE = 60_000;
// Local-time anchors (legacy daily/weekday recurrence is local wall-clock math): Wed 2026-07-15 09:00.
const WED = new Date(2026, 6, 15, 9, 0).getTime();
const THU = new Date(2026, 6, 16, 9, 0).getTime();
const FRI = new Date(2026, 6, 17, 9, 0).getTime();
const SAT = new Date(2026, 6, 18, 9, 0).getTime();
const MON = new Date(2026, 6, 20, 9, 0).getTime();

function cronCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ScheduleMutationError ? error.code : 'unexpected';
  }
  return undefined;
}

describe('cron schedules', () => {
  test('evaluate in their declared zone, with steps, ranges and lists', () => {
    expect(nextCronOccurrence({ expression: '0 9 * * 1-5', timeZone: 'America/New_York' }, Date.parse('2026-07-17T12:59:30.000Z')))
      .toBe(Date.parse('2026-07-17T13:00:00.000Z'));
    expect(nextCronOccurrence({ expression: '*/15 9-10 * * 1,3,5', timeZone: 'UTC' }, Date.parse('2026-07-17T09:00:00.000Z')))
      .toBe(Date.parse('2026-07-17T09:15:00.000Z'));
  });

  test('refuse out-of-range fields, aliases, and expressions that never occur', () => {
    expect(cronCode(() => nextCronOccurrence({ expression: '0 25 * * *', timeZone: 'UTC' }, WED))).toBe('SCHEDULE_CRON_INVALID');
    // Aliases are refused so the grammar stays the same across versions.
    expect(cronCode(() => nextCronOccurrence({ expression: '@daily', timeZone: 'UTC' }, WED))).toBe('SCHEDULE_CRON_INVALID');
    expect(cronCode(() => nextCronOccurrence({ expression: '0 0 31 2 *', timeZone: 'UTC' }, WED))).toBe('SCHEDULE_CRON_INVALID');
  });
});

describe('daily and weekday repeats', () => {
  test('advance by local days, skip weekends, and land past a gap', () => {
    expect(nextOccurrence(WED, 'daily', WED)).toBe(THU);
    expect(nextOccurrence(WED, 'daily', SAT)).toBe(new Date(2026, 6, 19, 9, 0).getTime());
    expect(nextOccurrence(THU, 'weekdays', THU)).toBe(FRI);
    expect(nextOccurrence(FRI, 'weekdays', FRI)).toBe(MON);
    expect(nextOccurrence(FRI, 'weekdays', SAT + 26 * 60 * MINUTE)).toBe(MON);
    expect(new Date(nextOccurrence(FRI, 'weekdays', FRI)).getHours()).toBe(9);
  });

  test('keep the wall-clock time across a 23-hour DST day in their zone', () => {
    const beforeSpring = Date.parse('2026-03-07T14:00:00.000Z'); // 09:00 EST
    const afterSpring = Date.parse('2026-03-08T13:00:00.000Z'); // 09:00 EDT
    expect(nextOccurrence(beforeSpring, 'daily', beforeSpring, 'America/New_York', '09:00:00.000')).toBe(afterSpring);
  });
});

test('finished rows are pruned to the newest fifty; live rows never are', () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-schedule-prune-'));
  try {
    let now = WED;
    let ids = 0;
    const store = new ScheduleStore({ path: join(root, 'schedules.json'), now: () => now, idFactory: () => `row-${++ids}` });
    const live = store.create({ kind: 'message', tool: 'claude', sessionId: 'keep', text: 'live', at: WED + 100 * MINUTE });
    for (let index = 0; index < 60; index += 1) {
      now = WED + index * MINUTE;
      const row = store.create({ kind: 'message', tool: 'claude', sessionId: `s-${index}`, text: `t${index}`, at: WED });
      store.recordOutcome(row.id, 'delivered', { firedAt: now });
    }
    const rows = store.list();
    expect(rows.filter((row) => row.state !== 'scheduled')).toHaveLength(50);
    expect(store.get(live.id)).toBeDefined();
    expect(rows.some((row) => row.sessionId === 's-0')).toBe(false);
    expect(rows.some((row) => row.sessionId === 's-59')).toBe(true);
    expect(MAX_SCHEDULED).toBe(100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
