#!/usr/bin/env bun
/**
 * Scheduled sends (part-3 #50): store semantics, occurrence math, and the runner's D7 missed-fire
 * policy — all deterministic (injected clock + timers, temp-dir persistence).
 *
 *   bun run packages/typescript/broker/test/broker/test-schedule-store.ts
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleRecord } from '../../../adapter-api/src/index.ts';
import {
  MAX_SCHEDULED,
  nextCronOccurrence,
  nextOccurrence,
  ScheduleMutationError,
  ScheduleStore,
} from '../../src/scheduling/schedule-store.ts';
import {
  DEFAULT_LATE_FIRE_GRACE_MS,
  ScheduleDeliveryError,
  ScheduledSendRunner,
} from '../../src/scheduling/schedule-runner.ts';

const MINUTE = 60_000;
// Local-time anchors (nextOccurrence is wall-clock local math): Wed 2026-07-15 09:00.
const WED = new Date(2026, 6, 15, 9, 0).getTime();
const THU = new Date(2026, 6, 16, 9, 0).getTime();
const FRI = new Date(2026, 6, 17, 9, 0).getTime();
const SAT = new Date(2026, 6, 18, 9, 0).getTime();
const MON = new Date(2026, 6, 20, 9, 0).getTime();

let groups = 0;

function tempStore(now: () => number): { store: ScheduleStore; root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-schedules-'));
  const path = join(root, 'schedules.json');
  let ids = 0;
  return { store: new ScheduleStore({ path, now, idFactory: () => `sched-${++ids}` }), root, path };
}

function scheduleCode(error: unknown): string | undefined {
  return error instanceof ScheduleMutationError ? error.code : undefined;
}

// ── arbitrary five-field cron math and validation ──
{
  const fridayBeforeNine = Date.parse('2026-07-17T12:59:30.000Z');
  assert.equal(
    nextCronOccurrence({ expression: '0 9 * * 1-5', timeZone: 'America/New_York' }, fridayBeforeNine),
    Date.parse('2026-07-17T13:00:00.000Z'),
    'cron evaluates in its declared IANA zone',
  );
  assert.equal(
    nextCronOccurrence({ expression: '*/15 9-10 * * 1,3,5', timeZone: 'UTC' }, Date.parse('2026-07-17T09:00:00.000Z')),
    Date.parse('2026-07-17T09:15:00.000Z'),
    'wildcard steps, ranges, and lists are supported',
  );
  assert.throws(
    () => nextCronOccurrence({ expression: '0 25 * * *', timeZone: 'UTC' }, WED),
    (error) => scheduleCode(error) === 'SCHEDULE_CRON_INVALID',
  );
  assert.throws(
    () => nextCronOccurrence({ expression: '@daily', timeZone: 'UTC' }, WED),
    (error) => scheduleCode(error) === 'SCHEDULE_CRON_INVALID',
    'aliases are rejected so the grammar remains version-stable',
  );
  assert.throws(
    () => nextCronOccurrence({ expression: '0 0 31 2 *', timeZone: 'UTC' }, WED),
    (error) => scheduleCode(error) === 'SCHEDULE_CRON_INVALID',
    'an impossible but syntactically valid expression fails within the bounded search',
  );
  groups++;
}

function flushAsync(): Promise<void> {
  // The runner fires deliveries fire-and-forget; a macrotask turn lets them settle in tests.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── store: revisions, edits, pause/resume, run-now, quota recovery, legacy reload ──
{
  let now = WED - 60 * MINUTE;
  const { store, root, path } = tempStore(() => now);
  try {
    const cron = store.create({
      kind: 'new-session', tool: 'claude', title: 'Cron session', text: 'cron prompt',
      cron: { expression: '0 9 * * 1-5', timeZone: 'UTC' },
      retryPolicy: { maxRetries: 2, delayMs: MINUTE, backoff: 'fixed', retryOn: ['delivery'] },
    });
    assert.equal(cron.revision, 1);
    assert.ok(cron.at > now, 'the broker computes the first cron occurrence');

    const edited = store.update(cron.id, { expectedRevision: 1, text: 'edited prompt', title: 'Edited' });
    assert.equal(edited.revision, 2);
    assert.equal(edited.text, 'edited prompt');
    assert.throws(
      () => store.update(cron.id, { expectedRevision: 1, text: 'stale writer' }),
      (error) => scheduleCode(error) === 'SCHEDULE_STALE',
      'stale edits fail with a stable conflict',
    );

    const paused = store.pause(cron.id, 2);
    assert.equal(paused.state, 'paused');
    assert.equal(store.scheduledCount(), 1, 'paused schedules still count against the live cap');
    now = paused.at + MINUTE;
    assert.equal(store.due(now).length, 0, 'paused rows never fire');
    const resumed = store.resume(cron.id, 3);
    assert.equal(resumed.state, 'scheduled');
    assert.equal(store.due(now).length, 1, 'resume preserves at so the existing missed-fire rule decides overdue rows');
    const immediate = store.runNow(cron.id, 4);
    assert.equal(immediate.at, now);

    const quota = store.create({ kind: 'message', tool: 'claude', sessionId: 's-quota', text: 'quota', at: now });
    const quotaFailed = store.recordOutcome(quota.id, 'failed', { firedAt: now, error: 'native quota event', failureKind: 'quota' })!;
    assert.equal(quotaFailed.state, 'failed');
    assert.equal(quotaFailed.lastFailureKind, 'quota');
    now += MINUTE;
    const recovered = store.recoverQuota(quota.id, quotaFailed.revision);
    assert.equal(recovered.state, 'scheduled');
    assert.equal(recovered.at, now);
    assert.throws(
      () => store.recoverQuota(quota.id, recovered.revision),
      (error) => scheduleCode(error) === 'SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE',
      'quota recovery is evidence- and state-gated',
    );

    const raw = JSON.parse(readFileSync(path, 'utf8')) as { schedules: Array<Record<string, unknown>> };
    delete raw.schedules[0]!.revision;
    raw.schedules[0]!.futureAdditiveField = { ignoredByOldBroker: true };
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    const legacy = new ScheduleStore({ path, now: () => now });
    assert.equal(legacy.get(cron.id)?.revision, 1, 'legacy v1 rows without revisions adopt revision 1');
    assert.deepEqual(
      (legacy.get(cron.id) as ScheduleRecord & { futureAdditiveField?: unknown }).futureAdditiveField,
      { ignoredByOldBroker: true },
      'unknown additive stored data remains intact',
    );
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── nextOccurrence math ──
{
  assert.equal(nextOccurrence(WED, 'daily', WED), THU, 'daily advances one local day');
  assert.equal(nextOccurrence(WED, 'daily', SAT), new Date(2026, 6, 19, 9, 0).getTime(), 'daily after a gap lands on the first day past `after`');
  assert.equal(nextOccurrence(THU, 'weekdays', THU), FRI, 'weekdays: Thursday → Friday');
  assert.equal(nextOccurrence(FRI, 'weekdays', FRI), MON, 'weekdays: Friday skips the weekend to Monday');
  assert.equal(nextOccurrence(FRI, 'weekdays', SAT + 26 * 60 * MINUTE, ), MON, 'weekdays: fired late on Sunday still lands Monday');
  const wallClock = new Date(nextOccurrence(FRI, 'weekdays', FRI));
  assert.equal(wallClock.getHours(), 9, 'the wall-clock fire hour is preserved');
  const beforeSpring = Date.parse('2026-03-07T14:00:00.000Z'); // 09:00 America/New_York (EST)
  const afterSpring = Date.parse('2026-03-08T13:00:00.000Z'); // 09:00 America/New_York (EDT)
  assert.equal(
    nextOccurrence(beforeSpring, 'daily', beforeSpring, 'America/New_York', '09:00:00.000'),
    afterSpring,
    'browser-zone recurrence preserves 09:00 across a 23-hour DST day',
  );
  groups++;
}

// ── runner: durable typed retries, exponential delay, and final-only notification ──
{
  let now = WED;
  const { store, root, path } = tempStore(() => now);
  const outcomes: string[] = [];
  let attempts = 0;
  const runner = new ScheduledSendRunner(store, {
    now: () => now,
    deliver: async () => {
      attempts++;
      if (attempts <= 2) throw new ScheduleDeliveryError('temporary delivery failure', 'delivery');
    },
    onOutcome: (_schedule, outcome) => { outcomes.push(outcome); },
  });
  try {
    const scheduled = store.create({
      kind: 'message', tool: 'claude', sessionId: 'retry', text: 'retry me', at: now,
      retryPolicy: { maxRetries: 2, delayMs: MINUTE, backoff: 'exponential', retryOn: ['delivery'] },
    });
    await runner.tick();
    await flushAsync();
    let after = store.get(scheduled.id)!;
    assert.equal(after.state, 'scheduled');
    assert.equal(after.retryAttempt, 1);
    assert.equal(after.nextRetryAt, WED + MINUTE);
    assert.deepEqual(outcomes, [], 'intermediate failures do not emit terminal attention outcomes');

    // Restart between attempts: retry metadata and terminal semantics survive the durable file.
    const restarted = new ScheduleStore({ path, now: () => now });
    assert.equal(restarted.get(scheduled.id)?.nextRetryAt, WED + MINUTE);

    now = WED + MINUTE;
    await runner.tick();
    await flushAsync();
    after = store.get(scheduled.id)!;
    assert.equal(after.retryAttempt, 2);
    assert.equal(after.nextRetryAt, WED + 3 * MINUTE, 'second exponential retry doubles the base delay');

    now = WED + 3 * MINUTE;
    await runner.tick();
    await flushAsync();
    after = store.get(scheduled.id)!;
    assert.equal(after.state, 'delivered');
    assert.equal(after.nextRetryAt, undefined);
    assert.deepEqual(outcomes, ['delivered'], 'one logical occurrence produces one final notification');

    const quotaOnly = store.create({
      kind: 'message', tool: 'claude', sessionId: 'quota-only', text: 'native only', at: now,
      retryPolicy: { maxRetries: 1, delayMs: MINUTE, backoff: 'fixed', retryOn: ['quota'] },
    });
    const genericRunner = new ScheduledSendRunner(store, {
      now: () => now,
      deliver: async (row) => { if (row.id === quotaOnly.id) throw new Error('message text happens to say quota'); },
    });
    await genericRunner.tick();
    await flushAsync();
    assert.equal(store.get(quotaOnly.id)?.state, 'failed', 'generic text is delivery-class and cannot trigger quota retries');
    assert.equal(store.get(quotaOnly.id)?.lastFailureKind, 'delivery');
    genericRunner.stop();
    groups++;
  } finally {
    runner.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── store: create / persist / cancel / remove / list order ──
{
  let now = WED - 60 * MINUTE;
  const { store, root, path } = tempStore(() => now);
  try {
    const msg = store.create({ kind: 'message', tool: 'claude', sessionId: 's-1', sessionTitle: 'My session', text: 'run the report', at: WED });
    const cron = store.create({ kind: 'new-session', tool: 'opencode', directory: '/tmp/proj', title: 'Nightly', text: 'nightly sweep', at: THU, repeat: 'daily' });
    assert.equal(store.scheduledCount(), 2);
    assert.equal(msg.revision, 1, 'new message rows start at revision 1');
    assert.equal(cron.revision, 1, 'new repeating rows start at revision 1');
    assert.equal(store.nextAt(), WED, 'nextAt is the earliest live fire time');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'prompt-bearing store is private on POSIX');

    // Persistence roundtrip: a second instance on the same path sees identical records.
    const reloaded = new ScheduleStore({ path, now: () => now });
    assert.deepEqual(reloaded.get(msg.id), msg, 'message schedule survives reload');
    assert.deepEqual(reloaded.get(cron.id), cron, 'repeating new-session schedule survives reload');

    assert.equal(store.remove(msg.id), false, 'a LIVE schedule cannot be removed (cancel first)');
    const canceled = store.cancel(msg.id);
    assert.equal(canceled?.state, 'canceled');
    assert.equal(store.cancel(msg.id), undefined, 'cancel is not repeatable on a terminal row');
    assert.equal(store.scheduledCount(), 1);

    const listed = store.list();
    assert.equal(listed[0]?.id, cron.id, 'live rows list before finished rows');
    assert.equal(listed[1]?.id, msg.id);

    assert.equal(store.remove(msg.id), true, 'a terminal row can be removed');
    assert.equal(store.get(msg.id), undefined);

    // A failed durable write must throw and roll memory back; the HTTP layer maps this to 500.
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'x');
    let persistenceErrors = 0;
    const unwritable = new ScheduleStore({
      path: join(blocker, 'schedules.json'),
      now: () => now,
      idFactory: () => 'must-not-survive',
      onPersistenceError: () => { persistenceErrors++; },
    });
    persistenceErrors = 0; // ignore the constructor's expected ENOTDIR read warning for this case
    assert.throws(
      () => unwritable.create({ kind: 'message', tool: 'claude', sessionId: 's-bad', text: 'not durable', at: WED }),
      'create reports a persistence failure instead of claiming success',
    );
    assert.equal(unwritable.scheduledCount(), 0, 'a failed create rolls the in-memory mutation back');
    assert.equal(persistenceErrors, 1, 'persistence failures reach observability exactly once');

    const corruptPath = join(root, 'corrupt-schedules.json');
    writeFileSync(corruptPath, '{ definitely not JSON');
    let corruptWarnings = 0;
    const recovered = new ScheduleStore({ path: corruptPath, now: () => now, onPersistenceError: () => { corruptWarnings++; } });
    assert.equal(recovered.list().length, 0, 'a corrupt store recovers to an empty in-memory list');
    assert.equal(corruptWarnings, 1, 'store corruption reaches observability');
    assert.equal(existsSync(corruptPath), false, 'the corrupt file is moved aside before recovery');
    assert.ok(readdirSync(root).some((name) => name.startsWith('corrupt-schedules.json.corrupt-')), 'corrupt bytes are preserved for diagnosis');
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── store: edit is an in-place durable CAS mutation; unprovenanced v1 work is quarantined ──
{
  let now = WED - 60 * MINUTE;
  const { store, root, path } = tempStore(() => now);
  try {
    const original = store.create({ kind: 'message', tool: 'claude', sessionId: 's-edit', text: 'before', at: WED });
    const edited = store.edit(original.id, { text: 'after', at: THU, expectedRevision: 1 });
    assert.equal(edited?.id, original.id, 'edit preserves the stable schedule id');
    assert.equal(edited?.text, 'after');
    assert.equal(edited?.at, THU);
    assert.equal(edited?.revision, 2, 'edit increments revision');
    assert.deepEqual(new ScheduleStore({ path, now: () => now }).get(original.id), edited, 'successful edit persists');

    const beforeStale = { ...edited! };
    assert.equal(
      store.edit(original.id, { text: 'stale overwrite', at: MON, expectedRevision: 1 }),
      undefined,
      'stale edit is rejected without overwriting',
    );
    assert.deepEqual(store.get(original.id), beforeStale, 'stale edit leaves the canonical row untouched');

    // A revision-16 schedule has no creator provenance. Migration preserves its prompt for owner
    // inspection but makes it terminal before the runner can observe it.
    const legacyPath = join(root, 'legacy-schedules.json');
    const legacyBase = { ...original } as ScheduleRecord;
    const legacyRows = [
      { ...legacyBase, id: 'legacy-scheduled', state: 'scheduled' as const },
      { ...legacyBase, id: 'legacy-paused', state: 'paused' as const },
      { ...legacyBase, id: 'legacy-delivered', state: 'delivered' as const },
      { ...legacyBase, id: 'legacy-failed', state: 'failed' as const },
      { ...legacyBase, id: 'legacy-missed', state: 'missed' as const },
      { ...legacyBase, id: 'legacy-canceled', state: 'canceled' as const },
    ];
    delete (legacyRows[0] as Partial<ScheduleRecord>).revision;
    writeFileSync(legacyPath, JSON.stringify({ version: 1, schedules: legacyRows }));
    const migrated = new ScheduleStore({ path: legacyPath, now: () => now });
    assert.equal(migrated.get('legacy-scheduled')?.state, 'canceled');
    assert.equal(migrated.get('legacy-paused')?.state, 'canceled');
    assert.equal(migrated.get('legacy-scheduled')?.text, original.text, 'quarantine preserves the prompt for inspection');
    assert.equal(migrated.edit('legacy-scheduled', { text: 'legacy edited', at: THU, expectedRevision: 2 }), undefined);
    for (const state of ['delivered', 'failed', 'missed', 'canceled'] as const) {
      assert.equal(migrated.get(`legacy-${state}`)?.state, state, `legacy ${state} history remains inspectable`);
    }
    assert.deepEqual(migrated.due(THU), [], 'no unprovenanced legacy row is executable');
    let deliveries = 0;
    const legacyRunner = new ScheduledSendRunner(migrated, {
      now: () => THU,
      deliver: async () => { deliveries++; },
    });
    await legacyRunner.tick();
    await flushAsync();
    legacyRunner.stop();
    assert.equal(deliveries, 0, 'legacy schedules remain non-executable across restart');
    const owner = migrated.create({
      kind: 'message', tool: 'claude', sessionId: 'owner-session', text: 'owner schedule', at: THU,
    });
    const restartedLegacy = new ScheduleStore({ path: legacyPath, now: () => THU });
    const thirdLoad = new ScheduleStore({ path: legacyPath, now: () => THU });
    assert.deepEqual(restartedLegacy.due(THU).map((schedule) => schedule.id), [owner.id]);
    assert.deepEqual(thirdLoad.due(THU).map((schedule) => schedule.id), [owner.id]);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('legacy-schedules.json.corrupt-')),
      false,
      'valid mixed v2 history must not poison the store on repeated restart',
    );
    const migratedFile = JSON.parse(readFileSync(legacyPath, 'utf8')) as any;
    assert.equal(migratedFile.version, 2);
    assert.equal(migratedFile.schedules[0].createdBy.kind, 'legacy-unprovenanced');
    assert.equal(migratedFile.schedules.some((row: any) => row.securityRevision !== undefined), false);
    assert.equal(migratedFile.schedules.find((row: any) => row.id === owner.id).createdBy.kind, 'owner');
    store.cancel(original.id);
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── store: failed edit durability rolls memory back ──
{
  let now = WED;
  const { store, root } = tempStore(() => now);
  try {
    const original = store.create({ kind: 'message', tool: 'claude', sessionId: 's-rollback', text: 'durable before', at: THU });
    const snapshot = { ...original };
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'blocks schedule-store mkdir');
    assert.throws(
      () => store.edit(original.id, { text: 'must roll back', at: MON, expectedRevision: original.revision }),
      'a failed edit reports a persistence failure',
    );
    assert.deepEqual(store.get(original.id), snapshot, 'a failed edit rolls back text, time, and revision');
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── store: outcomes — one-shot terminal vs repeating advance ──
{
  let now = WED;
  const { store, root, path } = tempStore(() => now);
  try {
    const oneShot = store.create({ kind: 'message', tool: 'claude', sessionId: 's-1', text: 'once', at: WED });
    const failed = store.recordOutcome(oneShot.id, 'failed', { firedAt: WED, error: 'no drive path' });
    assert.equal(failed?.state, 'failed', 'a one-shot lands on the outcome state');
    assert.equal(failed?.lastError, 'no drive path');
    assert.equal(failed?.revision, 2, 'one-shot outcome increments revision');
    assert.equal(store.recordOutcome(oneShot.id, 'delivered', { firedAt: WED }), undefined, 'terminal rows never re-fire');

    const repeating = store.create({ kind: 'new-session', tool: 'opencode', text: 'daily run', at: FRI, repeat: 'weekdays' });
    const advanced = store.recordOutcome(repeating.id, 'delivered', { firedAt: FRI + MINUTE, createdSessionId: 'new-123' });
    assert.equal(advanced?.state, 'scheduled', 'a repeating schedule stays live');
    assert.equal(advanced?.at, MON, 'Friday weekdays repeat advances to Monday');
    assert.equal(advanced?.lastOutcome, 'delivered');
    assert.equal(advanced?.createdSessionId, 'new-123');
    assert.equal(advanced?.revision, 2, 'repeat outcome/rearm increments revision');

    const retryingSession = store.create({
      kind: 'new-session', tool: 'opencode', text: 'create once', at: now,
      retryPolicy: { maxRetries: 1, delayMs: MINUTE, backoff: 'fixed', retryOn: ['delivery'] },
    });
    store.recordPendingSession(retryingSession.id, 'created-before-prompt');
    assert.equal(new ScheduleStore({ path, now: () => now }).get(retryingSession.id)?.pendingSessionId, 'created-before-prompt', 'created target is durable before prompt handoff');
    const retry = store.recordOutcome(retryingSession.id, 'failed', { firedAt: now, error: 'handoff failed', failureKind: 'delivery' })!;
    assert.equal(retry.pendingSessionId, 'created-before-prompt', 'retry reuses the same new session');
    now += MINUTE;
    const retryDelivered = store.recordOutcome(retryingSession.id, 'delivered', { firedAt: now, createdSessionId: 'created-before-prompt' })!;
    assert.equal(retryDelivered.createdSessionId, 'created-before-prompt');
    assert.equal(retryDelivered.pendingSessionId, undefined, 'terminal success clears the pending target');

    const failedRecurring = store.create({ kind: 'new-session', tool: 'opencode', text: 'daily target', at: now, repeat: 'daily' });
    store.recordPendingSession(failedRecurring.id, 'failed-recurring-target');
    const failedOccurrence = store.recordOutcome(failedRecurring.id, 'failed', { firedAt: now, error: 'handoff failed' })!;
    assert.equal(failedOccurrence.pendingSessionId, undefined, 'the next regular occurrence does not reuse a failed session');
    assert.equal(failedOccurrence.lastFailedSessionId, 'failed-recurring-target');
    const manualRetry = store.runNow(failedRecurring.id, failedOccurrence.revision);
    assert.equal(manualRetry.pendingSessionId, 'failed-recurring-target', 'explicit run-now retries the failed occurrence target');
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── store: finished-row pruning keeps live rows and the newest 50 terminal rows ──
{
  let now = WED;
  const { store, root } = tempStore(() => now);
  try {
    const live = store.create({ kind: 'message', tool: 'claude', sessionId: 'keep', text: 'live', at: WED + 100 * MINUTE });
    for (let i = 0; i < 60; i++) {
      now = WED + i * MINUTE;
      const s = store.create({ kind: 'message', tool: 'claude', sessionId: `s-${i}`, text: `t${i}`, at: WED });
      store.recordOutcome(s.id, 'delivered', { firedAt: now });
    }
    const rows = store.list();
    assert.equal(rows.filter((s) => s.state !== 'scheduled').length, 50, 'terminal rows prune to 50');
    assert.ok(store.get(live.id), 'live rows are never pruned');
    assert.ok(!rows.some((s) => s.sessionId === 's-0'), 'the oldest terminal rows were dropped');
    assert.ok(rows.some((s) => s.sessionId === 's-59'), 'the newest terminal rows were kept');
    assert.ok(MAX_SCHEDULED >= 100, 'live cap is the documented 100');
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── runner: on-time fire, failure, missed policy, in-flight guard, repeat advance ──
{
  let now = WED - 10 * MINUTE;
  const { store, root } = tempStore(() => now);
  const delivered: ScheduleRecord[] = [];
  const outcomes: Array<{ id: string; outcome: string; error?: string }> = [];
  const runnerErrors: unknown[] = [];
  let deliverError: string | undefined;
  let hang: Promise<void> | undefined;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const runner = new ScheduledSendRunner<{ callback: () => void; delay: number }>(store, {
    now: () => now,
    deliver: async (schedule) => {
      if (hang) await hang;
      if (deliverError) throw new Error(deliverError);
      delivered.push(schedule);
      return schedule.kind === 'new-session' ? { createdSessionId: 'made-1' } : {};
    },
    onOutcome: (schedule, outcome, error) => { outcomes.push({ id: schedule.id, outcome, error }); },
    onError: (error) => { runnerErrors.push(error); },
    setTimer: (callback, delay) => { const t = { callback, delay }; timers.push(t); return t; },
    clearTimer: () => {},
  });
  try {
    const s1 = store.create({ kind: 'message', tool: 'claude', sessionId: 's-1', sessionTitle: 'T', text: 'on time', at: WED });
    runner.start();
    assert.ok(timers.length >= 1, 'start arms a timer');

    // Not due yet → nothing fires.
    await runner.tick();
    await flushAsync();
    assert.equal(delivered.length, 0);

    // Due (2 min late, inside the 30-min grace) → fires exactly once.
    now = WED + 2 * MINUTE;
    await runner.tick();
    await flushAsync();
    assert.equal(delivered.length, 1, 'due schedule fired');
    assert.equal(store.get(s1.id)?.state, 'delivered');
    assert.deepEqual(outcomes.at(-1), { id: s1.id, outcome: 'delivered', error: undefined });

    // D7: beyond the grace → marked missed, never delivered stale.
    const s2 = store.create({ kind: 'message', tool: 'claude', sessionId: 's-2', text: 'stale', at: WED });
    now = WED + DEFAULT_LATE_FIRE_GRACE_MS + MINUTE;
    await runner.tick();
    await flushAsync();
    assert.equal(delivered.length, 1, 'a stale one-shot must NOT deliver');
    assert.equal(store.get(s2.id)?.state, 'missed');
    assert.equal(outcomes.at(-1)?.outcome, 'missed');
    assert.match(store.get(s2.id)?.lastError ?? '', /missed: broker was unavailable/);

    // Failure → 'failed' + error recorded + notified.
    const s3 = store.create({ kind: 'message', tool: 'claude', sessionId: 's-3', text: 'will fail', at: now });
    deliverError = 'this session cannot accept remote prompts right now';
    await runner.tick();
    await flushAsync();
    assert.equal(store.get(s3.id)?.state, 'failed');
    assert.equal(store.get(s3.id)?.lastError, deliverError);
    assert.deepEqual(outcomes.at(-1), { id: s3.id, outcome: 'failed', error: deliverError });
    deliverError = undefined;

    // In-flight guard: a second tick during a slow delivery must not double-fire.
    let release!: () => void;
    hang = new Promise((resolve) => { release = resolve; });
    const s4 = store.create({ kind: 'new-session', tool: 'opencode', text: 'slow attach', at: now, repeat: 'daily' });
    await runner.tick();
    assert.equal(runner.isInFlight(s4.id), true, 'HTTP control can reject a mutation while delivery is in flight');
    await runner.tick();
    assert.equal(runner.isInFlight(s4.id), true, 'runner exposes delivery ownership while in flight');
    assert.equal(timers.at(-1)?.delay, 60_000, 'an in-flight due row rearms at the fallback, never a 0ms hot loop');
    hang = undefined;
    release();
    await flushAsync();
    assert.equal(runner.isInFlight(s4.id), false, 'delivery ownership clears after settlement');
    assert.equal(delivered.filter((d) => d.id === s4.id).length, 1, 'overlapping ticks fire a schedule once');
    const s4After = store.get(s4.id);
    assert.equal(s4After?.state, 'scheduled', 'repeating schedule stays live after delivery');
    assert.ok((s4After?.at ?? 0) > now, 'repeating schedule advanced past the fire time');
    assert.equal(s4After?.createdSessionId, 'made-1', 'created session id recorded for the notification target');

    // Missed occurrence of a REPEATING schedule advances too (never fires stale).
    const s5 = store.create({ kind: 'new-session', tool: 'opencode', text: 'nightly', at: now - DEFAULT_LATE_FIRE_GRACE_MS - MINUTE, repeat: 'daily' });
    await runner.tick();
    await flushAsync();
    const s5After = store.get(s5.id);
    assert.equal(s5After?.state, 'scheduled', 'a missed repeating occurrence keeps the schedule live');
    assert.equal(s5After?.lastOutcome, 'missed');
    assert.ok((s5After?.at ?? 0) > now, 'advanced to the next occurrence');
    assert.ok(!delivered.some((d) => d.id === s5.id), 'the stale occurrence itself never delivered');

    // A manual tick (the HTTP-create path) must RE-ARM the timer to the new nearest fire time —
    // otherwise a just-created near-term schedule waits out the previous fallback tick (live-probe
    // finding: at=+1s fired ~60s late).
    const s6 = store.create({ kind: 'message', tool: 'claude', sessionId: 's-6', text: 'soon', at: now + 5_000 });
    const s6Revision = s6.revision;
    const s6Edited = store.edit(s6.id, { text: 'rescheduled', at: now + 10_000, expectedRevision: s6Revision });
    assert.equal(s6Edited?.id, s6.id, 'rescheduling keeps the same id');
    assert.equal(s6Edited?.revision, s6Revision + 1, 'rescheduling increments revision');
    await runner.tick();
    await flushAsync();
    assert.equal(timers.at(-1)?.delay, 10_000, 'tick() re-arms the timer to the edited fire time');

    // If the outcome write fails after a successful send, keep the delivered state in memory,
    // report the durability fault, notify with the true outcome, and never redeliver this process.
    const s7 = store.create({ kind: 'message', tool: 'claude', sessionId: 's-7', text: 'durability fault', at: now });
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'blocks schedule-store mkdir');
    await runner.tick();
    await flushAsync();
    assert.equal(delivered.filter((d) => d.id === s7.id).length, 1, 'successful delivery occurs once despite outcome persistence failure');
    assert.equal(store.get(s7.id)?.state, 'delivered', 'delivered outcome remains in memory after write failure');
    assert.deepEqual(outcomes.at(-1), { id: s7.id, outcome: 'delivered', error: undefined }, 'notification keeps the true delivery outcome');
    assert.equal(runnerErrors.length, 1, 'runner reports the outcome durability fault');
    await runner.tick();
    await flushAsync();
    assert.equal(delivered.filter((d) => d.id === s7.id).length, 1, 'the in-memory terminal state prevents same-process redelivery');

    runner.stop();
    groups++;
  } finally {
    runner.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── runner: startup rearm applies the missed policy to rows that came due while down ──
{
  let now = WED;
  const { store, root, path } = tempStore(() => now);
  try {
    store.create({ kind: 'message', tool: 'claude', sessionId: 'late-ok', text: 'just late', at: WED - 5 * MINUTE });
    store.create({ kind: 'message', tool: 'claude', sessionId: 'too-late', text: 'way late', at: WED - 45 * MINUTE });

    // "Restart": a fresh store instance on the same file, a fresh runner, first tick = rearm.
    const restarted = new ScheduleStore({ path, now: () => now });
    const delivered: string[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runner = new ScheduledSendRunner<{ callback: () => void; delay: number }>(restarted, {
      now: () => now,
      deliver: async (s) => { delivered.push(s.sessionId ?? ''); },
      setTimer: (callback, delay) => { const t = { callback, delay }; timers.push(t); return t; },
      clearTimer: () => {},
    });
    runner.start();
    assert.equal(timers[0]?.delay, 0, 'startup rearm ticks immediately');
    timers[0]!.callback();
    await flushAsync();
    await flushAsync();
    assert.deepEqual(delivered, ['late-ok'], '<30 min late fires on startup; older is never delivered');
    assert.equal(restarted.get(restarted.list().find((s) => s.sessionId === 'too-late')!.id)?.state, 'missed');
    runner.stop();
    groups++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`PASS broker schedule store/runner (${groups} groups)`);
