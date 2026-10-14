/**
 * The attention reminder scheduler under a virtual clock: cadences hours and weeks long, races with
 * the runtime poller, stages an older broker stored, and how a pass shares the event loop.
 *
 * Delivery retries, late registrations, dismissal and answered requests are driven end to end
 * through the broker's test clock in `e2e/broker/push-delivery.test.ts`. What stays here needs a managed
 * runtime probe, a health escalation, a store an older broker wrote, or control of one pass.
 */
import { afterEach, describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeUpdateStatus, AttentionEventUpsert } from '../../../adapter-api/src/index.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionReminderScheduler } from '../../src/attention/attention-reminder-scheduler.ts';
import { AttentionStore, type AttentionDelivery } from '../../src/attention/attention-store.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface TimerProbe {
  callback: () => void;
  delay: number;
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

class Harness {
  readonly root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-reminders-'));
  now = 1_000_000;
  ids = 0;
  devices: string[] = ['phone'];
  failures = new Set<string>();
  dispatches: AttentionDelivery[] = [];
  readonly timers: TimerProbe[] = [];
  readonly store: AttentionStore;
  readonly scheduler: AttentionReminderScheduler<TimerProbe>;

  constructor(options: { dispatch?: (delivery: AttentionDelivery) => Promise<unknown> | unknown } = {}) {
    harnesses.push(this);
    this.store = new AttentionStore({ home: this.root, now: () => this.now, idFactory: () => `event-${++this.ids}` });
    this.scheduler = new AttentionReminderScheduler<TimerProbe>(this.store, {
      now: () => this.now,
      listDeviceIds: () => this.devices,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        this.timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      dispatchReservation: options.dispatch ?? ((delivery) => {
        this.dispatches.push(delivery);
        if (this.failures.has(delivery.deviceId)) throw new Error(`offline:${delivery.deviceId}`);
      }),
    });
  }

  async addEvent(input: Pick<AttentionEventUpsert, 'kind' | 'dedupeKey'> & Partial<AttentionEventUpsert>) {
    const severity = ['permission-required', 'question-required', 'broker-health'].includes(input.kind)
      ? 'action-required'
      : ['runtime-update-ready', 'sync-degraded', 'usage-threshold'].includes(input.kind) ? 'maintenance' : 'informational';
    return (await this.store.upsertEvent({
      state: 'active', severity, title: input.kind, action: { kind: 'open-attention-inbox' }, ...input,
    } as AttentionEventUpsert)).event;
  }

  /** Move the clock in steps, running one pass after each. */
  async walk(...steps: number[]): Promise<void> {
    for (const step of steps) {
      this.now += step;
      await this.scheduler.tick();
    }
  }

  stagesFor(eventId: string): string[] {
    return this.dispatches.filter((item) => item.eventId === eventId).map((item) => item.stage);
  }

  cleanup(): void {
    this.scheduler.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Let a timer-started pass finish: its awaits all settle before the next macrotask. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

const pendingRuntime = (checkedAt: number): AgentRuntimeUpdateStatus => ({
  agent: 'codex', displayName: 'Codex', managed: true, state: 'pending', updateAvailable: true,
  autoRestartReady: false, installedVersion: '0.2', runningVersion: '0.1', checkedAt,
});

describe('cadence', () => {
  test('each kind alerts once, at its stage, however long it stays open', async () => {
    const h = new Harness();
    const permission = await h.addEvent({ kind: 'permission-required', dedupeKey: 'permission:1', presentationRevision: 1, presentationStage: 'immediate' });
    await h.walk(0, 15 * MINUTE, 45 * MINUTE, 6 * HOUR, 6 * HOUR, 6 * HOUR, 21 * 24 * HOUR);
    assert.deepEqual(h.stagesFor(permission.id), ['immediate'], 'an unanswered request alerts once');
    assert.equal(h.store.getEvent(permission.id)?.presentationRevision, 1, 'and is never presented again');

    const question = await h.addEvent({ kind: 'question-required', dedupeKey: 'question:1' });
    await h.walk(0, 3 * 24 * HOUR);
    assert.deepEqual(h.stagesFor(question.id), ['immediate']);

    const runtime = await h.addEvent({ kind: 'runtime-update-ready', dedupeKey: 'runtime:1' });
    await h.walk(0);
    assert.deepEqual(h.stagesFor(runtime.id), [], 'a runtime update waits out its 2 h grace');
    await h.walk(2 * HOUR, 10 * HOUR, 12 * HOUR, 24 * HOUR, 24 * HOUR);
    assert.deepEqual(h.stagesFor(runtime.id), ['2h']);

    const health = await h.addEvent({ kind: 'broker-health', dedupeKey: 'health:1' });
    await h.walk(0, 2 * HOUR, 10 * HOUR, 12 * HOUR, 24 * HOUR);
    assert.deepEqual(h.stagesFor(health.id), ['immediate'], 'an unchanged health episode alerts once');

    const quota = await h.addEvent({ kind: 'usage-threshold', dedupeKey: 'quota:1' });
    await h.walk(0, 7 * HOUR);
    assert.deepEqual(h.stagesFor(quota.id), ['immediate']);

    const failedSend = await h.addEvent({
      kind: 'scheduled-send-failed', dedupeKey: 'scheduled-send-failed:1', state: 'resolved', severity: 'action-required', presentationStage: 'immediate',
    });
    await h.walk(0, 7 * HOUR);
    assert.deepEqual(h.stagesFor(failedSend.id), ['immediate']);
  });

  test('runtime polls every minute for three days never move the one 2 h alert', async () => {
    const h = new Harness();
    const policy = new AttentionPolicy(h.store, { now: () => h.now, runtimeBootId: 'boot-a' });
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(occurrence);
    for (let minute = 1; minute <= 72 * 60; minute++) {
      await h.walk(MINUTE);
      const before = h.store.getEvent(occurrence.id);
      const deliveries = h.store.listDeliveries();
      await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
      assert.deepEqual(h.store.getEvent(occurrence.id), before, `minute ${minute}: a poll leaves the presentation alone`);
      assert.deepEqual(h.store.listDeliveries(), deliveries, `minute ${minute}: a poll recreates no reservation`);
      assert.equal(before?.presentationStage, minute < 120 ? 'immediate' : '2h');
    }
    assert.deepEqual(h.stagesFor(occurrence.id), ['2h']);
  });

  test('a poll racing the scheduler\'s advance leaves one reservation at the later stage', async () => {
    const h = new Harness();
    const policy = new AttentionPolicy(h.store, { now: () => h.now, runtimeBootId: 'boot-a' });
    await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
    const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(occurrence);
    h.now += 2 * HOUR;
    await Promise.all([
      h.store.advancePresentationAndReserve(occurrence.id, '2h', ['phone']),
      policy.reconcileRuntimeStatus(pendingRuntime(h.now)),
    ]);
    const current = h.store.getEvent(occurrence.id);
    assert.equal(current?.presentationStage, '2h');
    assert.equal(current?.presentationRevision, occurrence.presentationRevision + 1);
    assert.equal(h.store.listDeliveries().filter((delivery) => delivery.eventId === occurrence.id && delivery.stage === '2h').length, 1);
  });

  for (const transition of ['current', 'changed-fingerprint'] as const) {
    test(`a reservation held when the update turns ${transition} is retired and never dispatched`, async () => {
      const h = new Harness();
      const policy = new AttentionPolicy(h.store, { now: () => h.now });
      await policy.reconcileRuntimeStatus(pendingRuntime(h.now));
      const occurrence = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
      assert.ok(occurrence);
      h.now += 2 * HOUR;

      let held!: () => void;
      const reserved = new Promise<void>((resolve) => { held = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const advance = h.store.advancePresentationAndReserve.bind(h.store);
      h.store.advancePresentationAndReserve = async (eventId, stage, deviceIds) => {
        const result = await advance(eventId, stage, deviceIds);
        if (eventId === occurrence.id && stage === '2h') {
          held();
          await released;
        }
        return result;
      };
      const pass = h.scheduler.tick();
      await reserved;
      const reservation = h.store.listDeliveries().find((delivery) => delivery.eventId === occurrence.id && delivery.stage === '2h');
      assert.equal(reservation?.state, 'reserved');

      await policy.reconcileRuntimeStatus(transition === 'current'
        ? { ...pendingRuntime(h.now), state: 'current', updateAvailable: false, runningVersion: '0.2' }
        : { ...pendingRuntime(h.now), installedVersion: '0.3' });
      assert.equal(h.store.getEvent(occurrence.id)?.state, 'resolved');
      assert.equal(h.store.getDelivery(reservation!.key)?.state, 'superseded');
      release();
      await pass;
      assert.deepEqual(h.stagesFor(occurrence.id), []);
      if (transition === 'changed-fingerprint') {
        const replacement = h.store.listActive().find((event) => event.kind === 'runtime-update-ready');
        assert.ok(replacement && replacement.id !== occurrence.id);
        assert.equal(replacement.presentationStage, 'immediate');
      }
    });
  }

  test('a stage an older broker stored is never advanced, so its old 6-hourly ladder stays silent', async () => {
    const h = new Harness();
    h.now = 600 * HOUR;
    const stale = await h.addEvent({
      kind: 'permission-required', dedupeKey: 'permission:stale', createdAt: h.now - 517 * HOUR - 3 * MINUTE,
      presentationRevision: 88, presentationStage: '517h',
    });
    await h.store.advancePresentationAndReserve(stale.id, '517h', ['phone']);
    await h.walk(0);
    h.dispatches = [];
    await h.walk(6 * HOUR, 6 * HOUR, 24 * HOUR);
    assert.equal(h.store.getEvent(stale.id)?.presentationStage, '517h');
    assert.equal(h.store.getEvent(stale.id)?.presentationRevision, 88);
    assert.deepEqual(h.stagesFor(stale.id), []);
  });
});

describe('broker-health escalation', () => {
  test('an ongoing episode\'s own stage is not advanced again', async () => {
    const h = new Harness();
    const health = await h.addEvent({
      kind: 'broker-health', dedupeKey: 'health-contract', severity: 'maintenance',
      presentationRevision: 9, presentationStage: 'health-1700000000000', summary: 'preamble',
    });
    await h.walk(30 * MINUTE);
    assert.equal(h.store.getEvent(health.id)?.presentationStage, 'health-1700000000000');
    assert.equal(h.store.getEvent(health.id)?.presentationRevision, 9);
  });

  test('an escalation stage dispatches at once, and its retry is bounded by that stage, not the 2 h cadence', async () => {
    const h = new Harness();
    h.failures.add('phone');
    await h.addEvent({
      kind: 'broker-health', dedupeKey: 'health-escalation-before-2h', presentationStage: 'health-before-2h-test',
      severity: 'maintenance', summary: 'escalation marker should dispatch now',
    });
    h.scheduler.start();
    assert.equal(h.timers.length, 1);
    h.timers[0]!.callback();
    while (h.timers.length < 2) await nextMacrotask();
    assert.ok(h.dispatches.some((item) => item.stage === 'health-before-2h-test'));
    assert.ok(h.timers[1]!.delay > 0 && h.timers[1]!.delay <= 5 * MINUTE, `next pass in ${h.timers[1]!.delay} ms`);
  });

  test('an escalation after the first alert dispatches its new stage once, and nothing follows it', async () => {
    const h = new Harness();
    const health = await h.addEvent({ kind: 'broker-health', dedupeKey: 'health-escalation', presentationStage: 'immediate', severity: 'maintenance' });
    await h.walk(0, 2 * HOUR, 10 * HOUR);
    assert.deepEqual(h.stagesFor(health.id), ['immediate']);
    h.now += HOUR;
    const stage = `health-${h.now}`;
    await h.addEvent({ kind: 'broker-health', dedupeKey: health.dedupeKey, presentationRevision: 5, presentationStage: stage, severity: 'action-required' });
    await h.walk(0, 0, 11 * HOUR, 24 * HOUR, 24 * HOUR);
    assert.deepEqual(h.stagesFor(health.id), ['immediate', stage]);
  });
});

describe('passes', () => {
  test('a reservation for a device no longer registered does not spin the scheduler', async () => {
    const h = new Harness();
    const event = await h.addEvent({ kind: 'permission-required', dedupeKey: 'stale-device:1', presentationStage: '15m', presentationRevision: 1 });
    await h.store.advancePresentationAndReserve(event.id, '15m', ['phone']);
    h.now += 16 * MINUTE;
    h.devices = [];
    h.scheduler.start();
    h.timers[0]!.callback();
    while (h.timers.length < 2) await nextMacrotask();
    assert.ok(h.timers[1]!.delay > 0, 'the next pass is not due at once');
  });

  test('every due reservation reaches dispatch before any is awaited', async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = new Harness({ dispatch: async () => { entered += 1; await gate; } });
    await h.addEvent({ kind: 'permission-required', dedupeKey: 'concurrent:1' });
    await h.addEvent({ kind: 'question-required', dedupeKey: 'concurrent:2' });
    const pass = h.scheduler.tick();
    // Serial dispatch would wait on the first forever; the deadline only detects that hang.
    const deadline = Date.now() + 10_000;
    while (entered < 2) {
      assert.ok(Date.now() < deadline, 'due reservations were dispatched one at a time');
      await nextMacrotask();
    }
    release();
    await pass;
  });

  test('requests made while a pass runs share one follow-up; requests before a pass share that pass', async () => {
    const h = new Harness();
    let passes = 0;
    let dispatching = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new AttentionReminderScheduler(h.store, {
      now: () => h.now,
      listDeviceIds: () => { passes += 1; return ['phone']; },
      dispatchReservation: async () => { dispatching = true; await gate; },
    });
    try {
      await h.addEvent({ kind: 'permission-required', dedupeKey: 'perm:coalesce' });
      const running = scheduler.tick();
      while (!dispatching) await nextMacrotask();
      const whileRunning = Array.from({ length: 25 }, () => scheduler.tick());
      release();
      await Promise.all([running, ...whileRunning]);
      assert.equal(passes, 2);
      await Promise.all(Array.from({ length: 25 }, () => scheduler.tick()));
      assert.equal(passes, 3);
    } finally {
      scheduler.stop();
    }
  });

  test('the store changes a pass makes queue one follow-up pass, not one per change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-reminders-onchange-'));
    let passes = 0;
    let dispatched = 0;
    let armed = false;
    let scheduler: AttentionReminderScheduler | undefined;
    // The broker wires every store mutation to a tick; presenting N completions makes 2N mutations.
    const store = new AttentionStore({ home: root, now: () => 1_000_000, onChange: () => { if (armed) void scheduler?.tick().catch(() => {}); } });
    scheduler = new AttentionReminderScheduler(store, {
      now: () => 1_000_000,
      listDeviceIds: () => { passes += 1; return ['phone']; },
      dispatchReservation: () => { dispatched += 1; },
    });
    try {
      for (let index = 0; index < 30; index++) {
        await store.upsertEvent({
          kind: 'run-finished', dedupeKey: `run:onchange:${index}`, state: 'resolved', severity: 'informational',
          title: 'run-finished', action: { kind: 'open-attention-inbox' }, presentationRevision: 1, presentationStage: 'immediate',
        } as AttentionEventUpsert);
      }
      armed = true;
      await scheduler.tick();
      await scheduler.tick();
      assert.equal(dispatched, 30);
      assert.ok(passes <= 3, `60 mutations during one pass queued ${passes} passes`);
    } finally {
      scheduler.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a long pass lets other work run instead of holding the event loop to its end', async () => {
    const h = new Harness();
    const ranBeforeDispatch: boolean[] = [];
    let otherWorkRan = false;
    const scheduler = new AttentionReminderScheduler(h.store, {
      now: () => h.now,
      listDeviceIds: () => ['phone'],
      sliceMs: 0,
      dispatchReservation: () => { ranBeforeDispatch.push(otherWorkRan); },
    });
    try {
      for (let index = 0; index < 5; index++) await h.addEvent({ kind: 'permission-required', dedupeKey: `perm:yield:${index}` });
      setImmediate(() => { otherWorkRan = true; });
      await scheduler.tick();
      assert.equal(ranBeforeDispatch.length, 5);
      assert.equal(ranBeforeDispatch[0], true);
    } finally {
      scheduler.stop();
    }
  });
});
