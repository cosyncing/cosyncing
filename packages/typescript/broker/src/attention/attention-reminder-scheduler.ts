import type { AttentionDelivery, AttentionStore } from './attention-store.ts';

type Timer = ReturnType<typeof setTimeout>;

export interface AttentionReminderSchedulerOptions<TTimer = ReturnType<typeof setTimeout>> {
  now?: () => number;
  listDeviceIds?: () => string[] | Promise<string[]>;
  dispatchReservation: (delivery: AttentionDelivery) => Promise<unknown> | unknown;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => TTimer;
  clearTimer?: (timer: TTimer) => void;
  fallbackTickMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FALLBACK_TICK_MS = 60_000;
const RETRY_DELAYS_MS = [5 * MINUTE, 30 * MINUTE, 2 * HOUR];
// Initial attempt plus all three documented retries (5m, 30m, 2h).
const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const RESOLVED_ONE_SHOT_KINDS = new Set([
  'goal-finished',
  'run-finished',
  'run-failed',
  'device-paired',
  'security-alert',
  // Scheduled-send failures/misses push once (D8). Successes use kind 'scheduled-send', which is
  // deliberately NOT listed: a quiet inbox row, no wake.
  'scheduled-send-failed',
]);

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    seen.add(value);
  }
  return [...seen];
}

function isDismissed(deviceId: string, eventId: string, store: AttentionStore): boolean {
  const clientState = store.getClientState(deviceId, eventId);
  return clientState?.dismissedAt !== undefined;
}

function parsePermissionStage(stage?: string): number {
  if (stage === 'immediate') return 1;
  if (stage === '15m') return 2;
  if (stage === '1h') return 3;

  const hourMatch = /^([1-9]\d*)h$/.exec(stage ?? '');
  if (!hourMatch) return 0;
  const hours = Number(hourMatch[1]);
  if (!Number.isSafeInteger(hours) || hours < 7) return 0;
  return 4 + Math.floor((hours - 7) / 6);
}

function parseMaintenanceStage(stage?: string): number {
  if (stage === 'immediate') return 1;
  if (stage === '2h') return 2;
  if (stage === '12h') return 3;
  if (stage?.startsWith('health-')) return 1;

  const hourMatch = /^([1-9]\d*)h$/.exec(stage ?? '');
  if (!hourMatch) return 0;
  const hours = Number(hourMatch[1]);
  if (!Number.isSafeInteger(hours) || hours < 24) return 0;
  return 4 + Math.floor((hours - 24) / 24);
}

function parseRuntimeStage(stage?: string): number {
  if (stage === 'immediate') return 1;
  if (stage === '2h') return 2;
  if (stage === '12h') return 3;
  if (stage === '24h') return 4;

  const hourMatch = /^([1-9]\d*)h$/.exec(stage ?? '');
  if (!hourMatch) return 0;
  const hours = Number(hourMatch[1]);
  if (!Number.isSafeInteger(hours) || hours < 24) return 0;
  return 4 + Math.floor((hours - 24) / 24);
}

function stageIndex(kind: string, stage?: string): number {
  switch (kind) {
    case 'permission-required':
    case 'question-required':
      return parsePermissionStage(stage);
    case 'runtime-update-ready':
      return parseRuntimeStage(stage);
    case 'broker-health':
    case 'sync-degraded':
      return parseMaintenanceStage(stage);
    default:
      return stage === 'immediate' ? 1 : 0;
  }
}

function dueIndex(kind: string, ageMs: number): number {
  switch (kind) {
    case 'permission-required':
    case 'question-required':
      if (ageMs < 15 * MINUTE) return 1;
      if (ageMs < 60 * MINUTE) return 2;
      if (ageMs < 7 * HOUR) return 3;
      return 4 + Math.floor((ageMs - 7 * HOUR) / (6 * HOUR));
    case 'runtime-update-ready':
      if (ageMs < 2 * HOUR) return 0;
      if (ageMs < 12 * HOUR) return 2;
      if (ageMs < 24 * HOUR) return 3;
      return 4 + Math.floor((ageMs - 24 * HOUR) / (24 * HOUR));
    case 'broker-health':
    case 'sync-degraded':
      if (ageMs < 2 * HOUR) return 1;
      if (ageMs < 12 * HOUR) return 2;
      if (ageMs < 24 * HOUR) return 3;
      return 4 + Math.floor((ageMs - 24 * HOUR) / (24 * HOUR));
    default:
      return 1;
  }
}

/**
 * Returns the cadence rung that was current when a broker-health escalation
 * marker was created. The marker is an out-of-band presentation stage until
 * the next regular cadence boundary, so an escalation never collapses into an
 * already-delivered 2h/12h/24h reservation.
 */
function healthEscalationBaseIndex(
  kind: string,
  stage: string | undefined,
  createdAt: number,
  now: number,
): number | undefined {
  if (kind !== 'broker-health' || !stage?.startsWith('health-')) {
    return undefined;
  }
  const parsedAt = Number(stage.slice('health-'.length));
  const markerAt = Number.isSafeInteger(parsedAt) && parsedAt >= 0
    ? Math.min(now, parsedAt)
    : createdAt;
  return dueIndex(kind, Math.max(0, markerAt - createdAt));
}

function stageFromIndex(kind: string, index: number): string {
  if (index <= 0) return 'none';

  switch (kind) {
    case 'permission-required':
    case 'question-required':
      if (index <= 1) return 'immediate';
      if (index === 2) return '15m';
      if (index === 3) return '1h';
      return `${7 + 6 * (index - 4)}h`;
    case 'runtime-update-ready':
      if (index <= 2) return '2h';
      if (index === 3) return '12h';
      if (index === 4) return '24h';
      return `${24 + 24 * (index - 4)}h`;
    case 'broker-health':
    case 'sync-degraded':
      if (index <= 1) return 'immediate';
      if (index === 2) return '2h';
      if (index === 3) return '12h';
      if (index === 4) return '24h';
      return `${24 + 24 * (index - 4)}h`;
    default:
      return 'immediate';
  }
}

function nextStageAgeMs(kind: string, currentIndex: number): number | undefined {
  const nextIndex = currentIndex + 1;
  switch (kind) {
    case 'permission-required':
    case 'question-required': {
      if (nextIndex <= 1) return 0;
      if (nextIndex === 2) return 15 * MINUTE;
      if (nextIndex === 3) return 60 * MINUTE;
      return 7 * HOUR + 6 * HOUR * (nextIndex - 4);
    }
    case 'runtime-update-ready': {
      if (nextIndex <= 2) return 2 * HOUR;
      if (nextIndex === 3) return 12 * HOUR;
      if (nextIndex === 4) return 24 * HOUR;
      return 24 * HOUR + 24 * HOUR * (nextIndex - 4);
    }
    case 'broker-health':
    case 'sync-degraded': {
      if (nextIndex <= 1) return 0;
      if (nextIndex === 2) return 2 * HOUR;
      if (nextIndex === 3) return 12 * HOUR;
      if (nextIndex === 4) return 24 * HOUR;
      return 24 * HOUR + 24 * HOUR * (nextIndex - 4);
    }
    default:
      return undefined;
  }
}

function nextRetryDelay(attempts: number): number | undefined {
  return RETRY_DELAYS_MS[attempts] ?? undefined;
}

function minNextAttemptAt(
  deliveries: AttentionDelivery[],
  eventId: string,
  stage: string,
  now: number,
  isActiveForDevice: (deviceId: string, eventId: string) => boolean,
  isDismissedForEvent: (deviceId: string, eventId: string) => boolean,
): number | undefined {
  let next: number | undefined;
  for (const delivery of deliveries) {
    if (
      delivery.eventId !== eventId
      || delivery.stage !== stage
      || delivery.state !== 'reserved'
      || delivery.attempts >= MAX_RETRY_ATTEMPTS
    ) {
      continue;
    }
    if (!isActiveForDevice(delivery.deviceId, eventId)) continue;
    if (isDismissedForEvent(delivery.deviceId, eventId)) continue;
    if (delivery.nextAttemptAt === undefined) return now;
    if (delivery.nextAttemptAt > now) {
      next = next === undefined ? delivery.nextAttemptAt : Math.min(next, delivery.nextAttemptAt);
    }
  }
  return next;
}

function hasReadyDeliveryNow(
  deliveries: AttentionDelivery[],
  eventId: string,
  stage: string,
  now: number,
  isActiveForDevice: (deviceId: string, eventId: string) => boolean,
  isDismissedForEvent: (deviceId: string, eventId: string) => boolean,
): boolean {
  return deliveries.some((delivery) =>
    delivery.eventId === eventId
    && delivery.stage === stage
    && delivery.state === 'reserved'
    && delivery.attempts < MAX_RETRY_ATTEMPTS
    && isActiveForDevice(delivery.deviceId, eventId)
    && !isDismissedForEvent(delivery.deviceId, eventId)
    && (delivery.nextAttemptAt === undefined || delivery.nextAttemptAt <= now),
  );
}

/**
 * Reminder scheduler for durable attention delivery.
 * Transport-level coalescing remains outside this class (`DeviceWakeCoalescer` owns it).
 */
export class AttentionReminderScheduler<TTimer = ReturnType<typeof setTimeout>> {
  private readonly now: () => number;
  private readonly listDeviceIds: () => string[] | Promise<string[]>;
  private readonly dispatchReservation: (delivery: AttentionDelivery) => Promise<unknown> | unknown;
  private readonly onError?: (error: unknown) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (timer: TTimer) => void;
  private readonly fallbackTickMs: number;
  private timer: TTimer | undefined;
  private stopped = true;
  private runQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AttentionStore,
    options: AttentionReminderSchedulerOptions<TTimer>,
  ) {
    this.now = options.now ?? Date.now;
    this.listDeviceIds = options.listDeviceIds ?? (() => []);
    this.dispatchReservation = options.dispatchReservation;
    this.onError = options.onError;
    this.setTimer = options.setTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as Timer));
    this.fallbackTickMs = Math.max(1_000, options.fallbackTickMs ?? FALLBACK_TICK_MS);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    await this.queue(() => this.reconcile());
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const scheduled = this.runQueue.then(task, task);
    this.runQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;

    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
    }

    this.timer = this.setTimer(() => {
      void this.queue(async () => {
        try {
          await this.reconcile();
        } catch (error) {
          this.onError?.(error);
        } finally {
          if (!this.stopped) {
            this.schedule(this.computeDelayMs());
          }
        }
      });
    }, Math.max(0, delayMs));

    const unref = this.timer as { unref?: () => void };
    unref.unref?.();
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const allDevices = normalizeList(await Promise.resolve(this.listDeviceIds()));
    const deviceSet = new Set(allDevices);
    const isActiveForDevice = (deviceId: string, _eventId: string): boolean =>
      deviceSet.has(deviceId);
    const dispatchTasks: Promise<void>[] = [];

    for (const event of this.scheduledEvents()) {
      const elapsed = Math.max(0, now - event.createdAt);
      const due = dueIndex(event.kind, elapsed);
      if (due <= 0) continue;

      const escalationBase = healthEscalationBaseIndex(
        event.kind,
        event.presentationStage,
        event.createdAt,
        now,
      );
      const current = escalationBase
        ?? stageIndex(event.kind, event.presentationStage);
      const dueStage = stageFromIndex(event.kind, due);
      const escalationPending = escalationBase !== undefined
        && due <= escalationBase;
      const targetStage = escalationPending
        ? event.presentationStage!
        : current < due ? dueStage : (event.presentationStage ?? dueStage);
      const advanceResult = await this.store.advancePresentationAndReserve(
        event.id,
        targetStage,
        allDevices,
      );
      if (!advanceResult) continue;

      if (!escalationPending && current < due) {
        await this.store.supersedeDeliveries(event.id, targetStage);
      }
      const liveEvent = this.store.getEvent(event.id);
      if (!liveEvent || !this.isScheduledEvent(liveEvent)) continue;

      const deliveries = this.store.listDeliveries();
      const dueDeliveries = deliveries.filter((delivery) =>
        delivery.eventId === event.id
        && delivery.stage === targetStage
        && delivery.state === 'reserved'
        && delivery.attempts < MAX_RETRY_ATTEMPTS
        && deviceSet.has(delivery.deviceId),
      );
      for (const delivery of dueDeliveries) {
        if (!deviceSet.has(delivery.deviceId)) continue;
        const currentDelivery = this.store.getDelivery(delivery.key);
        if (!currentDelivery || currentDelivery.state !== 'reserved') continue;
        const dispatchEvent = this.store.getEvent(currentDelivery.eventId);
        if (!dispatchEvent || !this.isScheduledEvent(dispatchEvent)) continue;
        if (isDismissed(currentDelivery.deviceId, currentDelivery.eventId, this.store)) continue;
        if (currentDelivery.attempts >= MAX_RETRY_ATTEMPTS) continue;
        if (
          currentDelivery.nextAttemptAt !== undefined
          && currentDelivery.nextAttemptAt > now
        ) {
          continue;
        }

        // Start every due reservation before awaiting provider/coalescer work.
        // Otherwise a trailing coalesced wake blocks the loop for the full
        // window and prevents later event reservations from joining its batch.
        dispatchTasks.push((async () => {
          try {
            await Promise.resolve(this.dispatchReservation(currentDelivery));
            await this.store.completeDelivery(currentDelivery.key);
          } catch (error) {
            const delay = nextRetryDelay(currentDelivery.attempts);
            const nextAttemptAt = delay === undefined ? undefined : this.now() + delay;
            await this.store.recordDeliveryFailure(currentDelivery.key, nextAttemptAt);
            this.onError?.(error);
          }
        })());
      }
    }
    await Promise.all(dispatchTasks);
  }

  private computeDelayMs(): number {
    const now = this.now();
    let next = now + this.fallbackTickMs;
    const active = this.scheduledEvents();
    const deliveries = this.store.listDeliveries();
    const listedDevices = this.listDeviceIds();
    const allDevices = normalizeList(Array.isArray(listedDevices) ? listedDevices : []);
    const deviceSet = new Set(allDevices);
    const isActiveForDevice = (deviceId: string, _eventId: string): boolean =>
      deviceSet.has(deviceId);

    const isDismissedForEvent = (deviceId: string, eventId: string): boolean =>
      isDismissed(deviceId, eventId, this.store);

    for (const event of active) {
      const elapsed = Math.max(0, now - event.createdAt);
      const due = dueIndex(event.kind, elapsed);
      const escalationBase = healthEscalationBaseIndex(
        event.kind,
        event.presentationStage,
        event.createdAt,
        now,
      );
      const current = escalationBase
        ?? stageIndex(event.kind, event.presentationStage);
      const dueStage = stageFromIndex(event.kind, Math.max(0, due, current));
      const escalationPending = escalationBase !== undefined
        && due <= escalationBase;
      const targetStage = escalationPending
        ? event.presentationStage!
        : current < due ? dueStage : (event.presentationStage ?? dueStage);
      if (dueStage === 'none') {
        const nextAge = nextStageAgeMs(event.kind, Math.max(current, due));
        if (nextAge !== undefined) {
          next = Math.min(next, event.createdAt + nextAge);
        }
        continue;
      }

      const hasNow = hasReadyDeliveryNow(
        deliveries,
        event.id,
        targetStage,
        now,
        isActiveForDevice,
        isDismissedForEvent,
      );
      if (hasNow) {
        next = now;
        continue;
      }

      const retryAt = minNextAttemptAt(
        deliveries,
        event.id,
        targetStage,
        now,
        isActiveForDevice,
        isDismissedForEvent,
      );
      if (retryAt !== undefined && retryAt > now) {
        next = Math.min(next, retryAt);
        continue;
      }

      const nextAge = nextStageAgeMs(event.kind, Math.max(due, current));
      if (nextAge !== undefined) {
        next = Math.min(next, event.createdAt + nextAge);
      }
    }

    return Math.max(0, next - now);
  }

  private scheduledEvents() {
    return this.store.listEvents().filter((event) => this.isScheduledEvent(event));
  }

  private isScheduledEvent(event: { kind: string; state: string }): boolean {
    return event.state === 'active'
      || (event.state === 'resolved' && RESOLVED_ONE_SHOT_KINDS.has(event.kind));
  }
}
