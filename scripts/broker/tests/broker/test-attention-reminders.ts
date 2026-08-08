#!/usr/bin/env bun
/** Deterministic reminder scheduling validation for attention events. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntimeUpdateStatus,
  AttentionEventUpsert,
} from '../../../../packages/typescript/adapter-api/src/index.ts';
import { AttentionPolicy } from '../../../../packages/typescript/broker/src/attention-policy.ts';
import { AttentionReminderScheduler } from '../../../../packages/typescript/broker/src/attention-reminder-scheduler.ts';
import { AttentionStore, type AttentionDelivery } from '../../../../packages/typescript/broker/src/attention-store.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface TimerProbe {
  callback: () => void;
  delay: number;
  unrefCount: number;
  unref?: () => void;
}

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-reminders-'));
  now = 1_000_000;
  ids = 0;
  devices: string[] = ['phone'];
  failures = new Set<string>();
  dispatches: AttentionDelivery[] = [];
  errors: unknown[] = [];
  readonly timers: TimerProbe[] = [];
  readonly store: AttentionStore;
  readonly scheduler: AttentionReminderScheduler<TimerProbe>;

  constructor(options?: {
    devices?: string[];
    setTimer?: (callback: () => void, delay: number) => TimerProbe;
    clearTimer?: (timer: TimerProbe) => void;
    dispatch?: (delivery: AttentionDelivery) => Promise<unknown> | unknown;
  }) {
    if (options?.devices) this.devices = [...options.devices];
    this.store = new AttentionStore({
      home: this.root,
      now: () => this.now,
      idFactory: () => `event-${++this.ids}`,
    });
    this.scheduler = new AttentionReminderScheduler<TimerProbe>(this.store, {
      now: () => this.now,
      listDeviceIds: () => this.devices,
      setTimer: options?.setTimer ?? ((callback, delay) => {
        const timer = { callback, delay, unrefCount: 0, unref() { this.unrefCount += 1; } };
        this.timers.push(timer);
        return timer;
      }),
      clearTimer: options?.clearTimer ?? (() => {}),
      dispatchReservation: options?.dispatch ?? ((delivery) => {
        this.dispatches.push(delivery);
        if (this.failures.has(delivery.deviceId)) {
          throw new Error(`offline:${delivery.deviceId}`);
        }
      }),
      onError: (error) => this.errors.push(error),
    });
  }

  async addEvent(input: Pick<AttentionEventUpsert, 'kind' | 'dedupeKey'> & Partial<AttentionEventUpsert>) {
    const severity = input.kind === 'permission-required' || input.kind === 'question-required'
      || input.kind === 'broker-health'
      ? 'action-required'
      : input.kind === 'runtime-update-ready' || input.kind === 'sync-degraded'
      || input.kind === 'usage-threshold'
      ? 'maintenance'
      : 'informational';
    const result = await this.store.upsertEvent({
      state: 'active',
      severity,
      title: input.kind,
      action: { kind: 'open-attention-inbox' },
      ...input,
    });
    return result.event;
  }

  setFailure(deviceId: string, fail: boolean): void {
    if (fail) this.failures.add(deviceId);
    else this.failures.delete(deviceId);
  }

  advance(ms: number): void {
    this.now += ms;
  }

  async tick(): Promise<void> {
    await this.scheduler.tick();
  }

  dispatchesFor(eventId: string): AttentionDelivery[] {
    return this.dispatches.filter((item) => item.eventId === eventId);
  }

  cleanup(): void {
    this.scheduler.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

function assertLastStage(dispatches: AttentionDelivery[]): string {
  assert.ok(dispatches.length > 0, 'expected at least one dispatch');
  return dispatches[dispatches.length - 1]!.stage;
}

function pendingRuntime(checkedAt: number): AgentRuntimeUpdateStatus {
  return {
    agent: 'codex',
    displayName: 'Codex',
    managed: true,
    state: 'pending',
    updateAvailable: true,
    autoRestartReady: false,
    installedVersion: '0.2',
    runningVersion: '0.1',
    checkedAt,
  };
}

async function testRuntimePollsNeverResetCadence(): Promise<void> {
  const h = new Harness();
  try {
    const policy = new AttentionPolicy(h.store, { now: () => h.now, runtimeBootId: 'boot-a' });
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert(occurrence);
    assert.equal(occurrence.presentationStage, 'immediate');
    assert.equal(occurrence.presentationRevision, 1);

    const boundaryStages = new Map([
      [2 * 60, '2h'],
      [12 * 60, '12h'],
      [24 * 60, '24h'],
      [48 * 60, '48h'],
      [72 * 60, '72h'],
    ]);
    for (let minute = 1; minute <= 72 * 60; minute++) {
      h.advance(MINUTE);
      await h.tick();
      const beforePoll = h.store.getEvent(occurrence.id);
      assert(beforePoll);
      const deliveriesBeforePoll = h.store.listDeliveries();

      await policy.reconcileRuntimeStatus(pendingRuntime(h.now));

      const afterPoll = h.store.getEvent(occurrence.id);
      assert.deepEqual(afterPoll, beforePoll,
        `identical minute ${minute} poll must not mutate scheduler-owned presentation state`);
      assert.deepEqual(h.store.listDeliveries(), deliveriesBeforePoll,
        `identical minute ${minute} poll must not recreate delivery reservations`);
      assert.equal(afterPoll.id, occurrence.id);
      assert.equal(afterPoll.createdAt, occurrence.createdAt);
      const expectedStage = boundaryStages.get(minute);
      if (expectedStage) assert.equal(afterPoll.presentationStage, expectedStage);
    }

    assert.deepEqual(
      h.dispatchesFor(occurrence.id).map((delivery) => delivery.stage),
      ['2h', '12h', '24h', '48h', '72h'],
      'one unchanged occurrence follows the ordinary 2h/12h/24h/daily cadence',
    );
  } finally {
    h.cleanup();
  }
}

async function testConcurrentRuntimePollCannotRegressSchedulerAdvance(): Promise<void> {
  const h = new Harness();
  try {
    const policy = new AttentionPolicy(h.store, { now: () => h.now, runtimeBootId: 'boot-a' });
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert(occurrence);
    h.advance(2 * HOUR);

    await Promise.all([
      h.store.advancePresentationAndReserve(occurrence.id, '2h', ['phone']),
      policy.reconcileRuntimeStatus(pendingRuntime(h.now)),
    ]);

    const current = h.store.getEvent(occurrence.id);
    assert.equal(current?.presentationStage, '2h');
    assert.equal(current?.presentationRevision, occurrence.presentationRevision + 1);
    assert.equal(
      h.store.listDeliveries().filter((delivery) =>
        delivery.eventId === occurrence.id && delivery.stage === '2h').length,
      1,
      'the poll/scheduler race creates one reservation for the monotonic target stage',
    );
  } finally {
    h.cleanup();
  }
}

async function testResolvedOrSupersededRuntimeReservationNeverDispatches(): Promise<void> {
  for (const transition of ['current', 'changed-fingerprint'] as const) {
    const h = new Harness();
    let releaseReservation: (() => void) | undefined;
    try {
      const policy = new AttentionPolicy(h.store, { now: () => h.now });
      await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
      const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
      assert(occurrence);
      h.advance(2 * HOUR);

      let reservationHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { reservationHeld = resolve; });
      const release = new Promise<void>((resolve) => { releaseReservation = resolve; });
      const advance = h.store.advancePresentationAndReserve.bind(h.store);
      h.store.advancePresentationAndReserve = async (eventId, stage, deviceIds) => {
        const result = await advance(eventId, stage, deviceIds);
        if (eventId === occurrence.id && stage === '2h') {
          reservationHeld?.();
          await release;
        }
        return result;
      };

      const tick = h.tick();
      await held;
      const reserved = h.store.listDeliveries().find((delivery) =>
        delivery.eventId === occurrence.id && delivery.stage === '2h');
      assert.equal(reserved?.state, 'reserved');

      if (transition === 'current') {
        await policy.reconcileRuntimeStatus({
          ...pendingRuntime(h.now),
          state: 'current',
          updateAvailable: false,
          runningVersion: '0.2',
        });
      } else {
        await policy.reconcileRuntimeStatus({
          ...pendingRuntime(h.now),
          installedVersion: '0.3',
        });
      }
      assert.equal(h.store.getEvent(occurrence.id)?.state, 'resolved');
      assert.equal(h.store.getDelivery(reserved!.key)?.state, 'superseded',
        `${transition} atomically retires the held old reservation`);

      releaseReservation?.();
      await tick;
      assert.equal(h.dispatchesFor(occurrence.id).length, 0,
        `${transition} prevents the held old occurrence from dispatching`);
      if (transition === 'changed-fingerprint') {
        const replacement = h.store.listActive().find((event) =>
          event.kind === 'runtime-update-ready');
        assert(replacement);
        assert.notEqual(replacement.id, occurrence.id);
        assert.equal(replacement.presentationStage, 'immediate');
      }
    } finally {
      releaseReservation?.();
      h.cleanup();
    }
  }
}

async function testCadenceMatrix(): Promise<void> {
  const h = new Harness();
  try {
    const permission = await h.addEvent({
      kind: 'permission-required',
      dedupeKey: 'permission:1',
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
    await h.tick();
    assert.deepEqual(h.dispatchesFor(permission.id).map((item) => item.stage), ['immediate']);

    h.advance(15 * MINUTE);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(permission.id)), '15m');

    h.advance(45 * MINUTE);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(permission.id)), '1h');

    h.advance(6 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(permission.id)), '7h');

    h.advance(6 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(permission.id)), '13h');

    h.advance(6 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(permission.id)), '19h');

    const runtime = await h.addEvent({ kind: 'runtime-update-ready', dedupeKey: 'runtime:1' });
    h.dispatches = [];
    h.advance(2 * HOUR);
    await h.tick();
    assert.deepEqual(h.dispatchesFor(runtime.id).map((item) => item.stage), ['2h']);

    h.advance(10 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(runtime.id)), '12h');

    h.advance(12 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(runtime.id)), '24h');

    h.advance(24 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(runtime.id)), '48h');

    h.advance(24 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(runtime.id)), '72h');

    const health = await h.addEvent({
      kind: 'broker-health',
      dedupeKey: 'health:1',
      severity: 'action-required',
    });
    h.dispatches = [];
    await h.tick();
    assert.deepEqual(h.dispatchesFor(health.id).map((item) => item.stage), ['immediate']);
    h.advance(2 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(health.id)), '2h');
    h.advance(10 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(health.id)), '12h');
    h.advance(12 * HOUR);
    await h.tick();
    assert.equal(assertLastStage(h.dispatchesFor(health.id)), '24h');

    const quota = await h.addEvent({ kind: 'usage-threshold', dedupeKey: 'quota:1' });
    h.dispatches = [];
    await h.tick();
    assert.deepEqual(h.dispatchesFor(quota.id).map((item) => item.stage), ['immediate']);
    h.advance(7 * HOUR);
    await h.tick();
    assert.equal(h.dispatchesFor(quota.id).length, 1, 'one-shot quota reminders do not repeat');

    const scheduledFailure = await h.addEvent({
      kind: 'scheduled-send-failed',
      dedupeKey: 'scheduled-send-failed:1',
      state: 'resolved',
      severity: 'action-required',
      presentationStage: 'immediate',
    });
    h.dispatches = [];
    await h.tick();
    assert.deepEqual(h.dispatchesFor(scheduledFailure.id).map((item) => item.stage), ['immediate']);
    h.advance(7 * HOUR);
    await h.tick();
    assert.equal(h.dispatchesFor(scheduledFailure.id).length, 1, 'scheduled-send failures push once and never repeat');
  } finally {
    h.cleanup();
  }
}

async function testLateRegistrationCatchupAndDismissal(): Promise<void> {
  const h = new Harness();
  try {
    const runtime = await h.addEvent({ kind: 'runtime-update-ready', dedupeKey: 'runtime-late' });
    h.setFailure('phone', true);
    await h.tick();
    h.advance(2 * HOUR);
    await h.tick();
    const first = h.dispatchesFor(runtime.id);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.stage, '2h');
    assert.equal(h.store.listDeliveries().filter((item) => item.eventId === runtime.id && item.stage === '2h').length, 1);
    const firstDelivery = h.store.listDeliveries().find((item) =>
      item.eventId === runtime.id && item.stage === '2h')!;
    assert.equal(firstDelivery.attempts, 1);

    h.now = runtime.createdAt + 30 * HOUR;
    h.devices = ['phone', 'tablet'];
    h.setFailure('phone', true);
    await h.tick();

    const runtimeDispatches = h.dispatchesFor(runtime.id);
    assert.equal(runtimeDispatches.filter((item) => item.deviceId === 'tablet').length, 1);
    assert.equal(runtimeDispatches.filter((item) => item.deviceId === 'tablet')[0]!.stage, '24h');

    const stage2h = h.store.listDeliveries().filter((item) => item.eventId === runtime.id && item.stage === '2h');
    assert.equal(stage2h.every((item) => item.state === 'superseded'), true, 'older stage should be superseded after restart');

    const stage24h = h.store.listDeliveries().filter((item) => item.eventId === runtime.id && item.stage === '24h');
    assert.equal(stage24h.length, 2);

    h.devices = ['phone'];
    h.dispatches = [];
    const permission = await h.addEvent({ kind: 'permission-required', dedupeKey: 'perm-dismiss' });
    h.setFailure('phone', false);
    await h.tick();
    const immediate = h.dispatchesFor(permission.id).length;
    assert.equal(immediate, 1);
    await h.store.dismiss(permission.id, 'phone');
    h.advance(15 * MINUTE);
    await h.tick();
    assert.equal(h.dispatchesFor(permission.id).length, immediate, 'dismissal suppresses future delivery for matching device');
  } finally {
    h.cleanup();
  }
}

async function testRetryFlowAndFutureStageResume(): Promise<void> {
  const h = new Harness();
  try {
    h.setFailure('mobile', true);
    h.devices = ['mobile'];
    const policy = new AttentionPolicy(h.store, { now: () => h.now, runtimeBootId: 'boot-a' });
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const runtime = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert(runtime);

    await h.tick();
    h.advance(2 * HOUR);
    await h.tick();
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    let latest = h.dispatchesFor(runtime.id);
    assert.equal(latest.length, 1);
    assert.equal(latest[latest.length - 1]!.attempts, 0);
    let delivery = h.store.listDeliveries().find((item) =>
      item.eventId === runtime.id && item.stage === '2h' && item.deviceId === 'mobile')!;
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.nextAttemptAt, runtime.createdAt + 2 * HOUR + 5 * MINUTE);

    h.advance(5 * MINUTE);
    await h.tick();
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    latest = h.dispatchesFor(runtime.id);
    assert.equal(latest.length, 2);
    delivery = h.store.listDeliveries().find((item) =>
      item.eventId === runtime.id && item.stage === '2h' && item.deviceId === 'mobile')!;
    assert.equal(delivery.attempts, 2);
    assert.equal(delivery.nextAttemptAt, runtime.createdAt + 2 * HOUR + 35 * MINUTE);

    h.advance(30 * MINUTE);
    await h.tick();
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    latest = h.dispatchesFor(runtime.id);
    assert.equal(latest.length, 3);
    delivery = h.store.listDeliveries().find((item) =>
      item.eventId === runtime.id && item.stage === '2h' && item.deviceId === 'mobile')!;
    assert.equal(delivery.attempts, 3);
    assert.equal(delivery.nextAttemptAt, runtime.createdAt + 4 * HOUR + 35 * MINUTE);

    h.advance(2 * HOUR);
    await h.tick();
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const postExhaust = h.dispatchesFor(runtime.id).length;
    assert.equal(postExhaust, 4, 'the documented 2-hour retry is attempted once');
    await h.tick();
    assert.equal(h.dispatchesFor(runtime.id).length, 4, 'no busy retry after the 2-hour retry is exhausted');

    h.now = runtime.createdAt + 12 * HOUR;
    await h.tick();
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    assert.equal(h.dispatchesFor(runtime.id).length, 5, 'next regular stage resumes reminders');
    assert.equal(h.store.getEvent(runtime.id)?.presentationStage, '12h',
      'delivery retries never reset or replace the ordinary reminder stage');
  } finally {
    h.cleanup();
  }
}

async function testResolutionCancelsReminders(): Promise<void> {
  const h = new Harness();
  try {
    const run = await h.addEvent({ kind: 'run-finished', dedupeKey: 'run:done' });
    await h.tick();
    assert.equal(h.dispatchesFor(run.id).length, 1);
    const current = h.dispatchesFor(run.id).length;

    await h.store.resolveByDedupeKey(run.dedupeKey);
    h.advance(2 * HOUR);
    await h.tick();
    assert.equal(h.dispatchesFor(run.id).length, current, 'resolved event sends no later reminders');
  } finally {
    h.cleanup();
  }
}

async function testResolvedCompletionPresentsOnce(): Promise<void> {
  const h = new Harness();
  try {
    const completion = await h.addEvent({
      kind: 'run-finished',
      dedupeKey: 'run:resolved-at-creation',
      state: 'resolved',
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
    await h.tick();
    await h.tick();
    assert.equal(h.dispatchesFor(completion.id).length, 1,
      'globally-resolved completion remains newly presentable per device exactly once');
  } finally {
    h.cleanup();
  }
}

async function testFallbackTimerUnref(): Promise<void> {
  const timers: TimerProbe[] = [];
  const h = new Harness({
    setTimer: (callback, delay) => {
      const timer: TimerProbe = {
        callback,
        delay,
        unrefCount: 0,
        unref() {
          this.unrefCount += 1;
        },
      };
      timers.push(timer);
      return timer;
    },
  });
  try {
    h.scheduler.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.delay, 0);
    assert.equal(timers[0]!.unrefCount, 1);
  } finally {
    h.cleanup();
  }
}

async function testDueReservationsEnterCoalescerConcurrently(): Promise<void> {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const h = new Harness({
    dispatch: async () => {
      entered++;
      if (entered === 2) release?.();
      await gate;
    },
  });
  try {
    await h.addEvent({ kind: 'permission-required', dedupeKey: 'concurrent:1' });
    await h.addEvent({ kind: 'question-required', dedupeKey: 'concurrent:2' });
    const tick = h.tick();
    await Promise.race([
      tick,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('due reservations were dispatched serially')),
          250,
        );
        timer.unref();
      }),
    ]);
    assert.equal(entered, 2,
      'all due same-window reservations must reach the coalescer before awaiting');
  } finally {
    release?.();
    h.cleanup();
  }
}

async function testIgnoreReservationsForUnregisteredDevices(): Promise<void> {
  const timers: TimerProbe[] = [];
  const h = new Harness({
    setTimer: (callback, delay) => {
      const timer: TimerProbe = {
        callback,
        delay,
        unrefCount: 0,
      };
      timers.push(timer);
      return timer;
    },
  });
  try {
    const event = await h.addEvent({
      kind: 'permission-required',
      dedupeKey: 'stale-device:1',
      presentationStage: '15m',
      presentationRevision: 1,
    });
    await h.store.advancePresentationAndReserve(event.id, '15m', ['phone']);
    h.advance(16 * MINUTE);
    h.devices = [];

    h.scheduler.start();
    assert.equal(timers.length, 1, 'scheduler start schedules one immediate timer');
    timers[0]!.callback();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await Promise.resolve();
    assert.ok(timers.length >= 2, 'scheduler should reschedule after reconcile');
    assert.equal(timers[1]!.delay > 0, true, 'stale deliveries for missing devices should not force a zero-delay loop');
  } finally {
    h.cleanup();
  }
}

async function testBrokerHealthStageContractDoesNotReAdvance(): Promise<void> {
  const h = new Harness();
  try {
    const health = await h.addEvent({
      kind: 'broker-health',
      dedupeKey: 'health-contract',
      severity: 'maintenance',
      presentationRevision: 9,
      presentationStage: 'health-1700000000000',
      summary: 'preamble',
    });
    h.advance(30 * MINUTE);
    await h.tick();
    const current = h.store.getEvent(health.id);
    assert.equal(current?.presentationStage, 'health-1700000000000', 'custom health stage markers should not re-advance immediately');
    assert.equal(current?.presentationRevision, 9, 'preserve monotonic presentation revision for ongoing health incidents');
  } finally {
    h.cleanup();
  }
}

async function testHealthEscalationBefore2hDispatchesCustomStage(): Promise<void> {
  const timers: TimerProbe[] = [];
  const h = new Harness({
    setTimer: (callback, delay) => {
      const timer: TimerProbe = {
        callback,
        delay,
        unrefCount: 0,
        unref() {
          this.unrefCount += 1;
        },
      };
      timers.push(timer);
      return timer;
    },
  });
  try {
    h.setFailure('phone', true);
    await h.addEvent({
      kind: 'broker-health',
      dedupeKey: 'health-escalation-before-2h',
      presentationStage: 'health-before-2h-test',
      severity: 'maintenance',
      summary: 'escalation marker should dispatch now',
    });

    h.scheduler.start();
    assert.equal(timers.length, 1, 'scheduler start schedules one immediate timer');
    timers[0]!.callback();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    });

    assert.equal(h.dispatches.some((item) => item.stage === 'health-before-2h-test'), true,
      'custom health escalation stages before 2h must dispatch immediately');
    assert.equal(timers.length >= 2, true, 'retry-aware stage dispatch should schedule a wake window');
    assert.equal(timers[1]!.delay > 0 && timers[1]!.delay <= 5 * MINUTE, true,
      'custom health stage retries must stay bounded by that stage, not the 2h cadence boundary');
  } finally {
    h.cleanup();
  }
}

async function testHealthEscalationAfterCadenceRungDispatchesCustomStage(): Promise<void> {
  const h = new Harness();
  try {
    const health = await h.addEvent({
      kind: 'broker-health',
      dedupeKey: 'health-escalation-after-12h',
      presentationStage: 'immediate',
      severity: 'maintenance',
    });
    await h.tick();
    h.advance(2 * HOUR);
    await h.tick();
    h.advance(10 * HOUR);
    await h.tick();
    assert.deepEqual(
      h.dispatchesFor(health.id).map((item) => item.stage),
      ['immediate', '2h', '12h'],
    );

    h.advance(1 * HOUR);
    const escalationStage = `health-${h.now}`;
    await h.addEvent({
      kind: 'broker-health',
      dedupeKey: health.dedupeKey,
      presentationRevision: 5,
      presentationStage: escalationStage,
      severity: 'action-required',
    });
    await h.tick();
    assert.equal(
      assertLastStage(h.dispatchesFor(health.id)),
      escalationStage,
      'a post-12h critical escalation must reserve its unique stage immediately',
    );

    const dispatchCount = h.dispatchesFor(health.id).length;
    await h.tick();
    assert.equal(
      h.dispatchesFor(health.id).length,
      dispatchCount,
      'the same escalation stage must not dispatch twice',
    );

    h.advance(11 * HOUR);
    await h.tick();
    assert.equal(
      assertLastStage(h.dispatchesFor(health.id)),
      '24h',
      'the regular cadence must resume at the first boundary after escalation',
    );
  } finally {
    h.cleanup();
  }
}

await testRuntimePollsNeverResetCadence();
await testConcurrentRuntimePollCannotRegressSchedulerAdvance();
await testResolvedOrSupersededRuntimeReservationNeverDispatches();
await testCadenceMatrix();
await testLateRegistrationCatchupAndDismissal();
await testRetryFlowAndFutureStageResume();
await testResolutionCancelsReminders();
await testResolvedCompletionPresentsOnce();
await testFallbackTimerUnref();
await testDueReservationsEnterCoalescerConcurrently();
await testIgnoreReservationsForUnregisteredDevices();
await testBrokerHealthStageContractDoesNotReAdvance();
await testHealthEscalationBefore2hDispatchesCustomStage();
await testHealthEscalationAfterCadenceRungDispatchesCustomStage();

console.log('PASS broker attention reminders (14 groups)');
