/**
 * Fires due scheduled sends (part-3 #50). Mirrors the AttentionReminderScheduler skeleton:
 * a chained, serialized timer loop with injectable clock/timers for tests.
 *
 * Missed-fire policy (D7, 2026-07-15): a row whose fire time passed while the broker was down
 * (or asleep) still fires if it is less than {@link DEFAULT_LATE_FIRE_GRACE_MS} late; anything
 * later is marked 'missed' and notified — a stale prompt is never delivered. Repeating schedules
 * advance to their next occurrence either way.
 */
import type { ScheduleFailureKind, ScheduleOutcome, ScheduleRecord, ScheduleStore } from './schedule-store.ts';

type Timer = ReturnType<typeof setTimeout>;

export const DEFAULT_LATE_FIRE_GRACE_MS = 30 * 60_000;
const FALLBACK_TICK_MS = 60_000;

export interface ScheduleDeliveryResult {
  /** kind 'new-session': the created session's id (notification deep-link target). */
  createdSessionId?: string;
}

/** Adapters/delivery code may classify a failure only from native evidence. Message text is never
 * inspected to guess quota exhaustion. */
export class ScheduleDeliveryError extends Error {
  constructor(message: string, readonly failureKind: ScheduleFailureKind = 'delivery') {
    super(message);
  }
}

export interface ScheduledSendRunnerOptions<TTimer = Timer> {
  now?: () => number;
  /** Perform one delivery. A typed ScheduleDeliveryError supplies the failure class used by the
   *  schedule's retry policy; other throws are `delivery`. Resolution means the prompt was HANDED
   *  TO the agent, not that the resulting turn finished. */
  deliver: (schedule: ScheduleRecord) => Promise<ScheduleDeliveryResult | void>;
  /** Outcome hook (notifications). Errors here never affect the schedule record. */
  onOutcome?: (schedule: ScheduleRecord, outcome: ScheduleOutcome, error?: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  lateFireGraceMs?: number;
  fallbackTickMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TTimer;
  clearTimer?: (timer: TTimer) => void;
}

export class ScheduledSendRunner<TTimer = Timer> {
  private readonly now: () => number;
  private readonly deliver: (schedule: ScheduleRecord) => Promise<ScheduleDeliveryResult | void>;
  private readonly onOutcome?: (schedule: ScheduleRecord, outcome: ScheduleOutcome, error?: string) => void | Promise<void>;
  private readonly onError?: (error: unknown) => void;
  private readonly lateFireGraceMs: number;
  private readonly fallbackTickMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (timer: TTimer) => void;
  private timer: TTimer | undefined;
  private stopped = true;
  private runQueue: Promise<void> = Promise.resolve();
  /** Rows currently mid-delivery — a tick that overlaps a slow attach must not double-fire. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: ScheduleStore,
    options: ScheduledSendRunnerOptions<TTimer>,
  ) {
    this.now = options.now ?? Date.now;
    this.deliver = options.deliver;
    this.onOutcome = options.onOutcome;
    this.onError = options.onError;
    this.lateFireGraceMs = Math.max(0, options.lateFireGraceMs ?? DEFAULT_LATE_FIRE_GRACE_MS);
    this.fallbackTickMs = Math.max(1_000, options.fallbackTickMs ?? FALLBACK_TICK_MS);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as Timer));
  }

  /** Startup rearm: the immediate first tick applies the missed-fire policy to everything that
   *  came due while the broker was down. */
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

  /** Whether delivery currently owns this row. Read-only so HTTP mutations can fail closed. */
  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Run one reconcile now (called after HTTP create/cancel). Re-arms the standing timer afterwards:
   *  a just-created near-term schedule (at = now+3s) would otherwise wait for the previous fallback
   *  tick — up to a minute late — because only the timer loop's own callback reschedules. */
  async tick(): Promise<void> {
    await this.queue(() => this.reconcile());
    if (!this.stopped) this.schedule(this.computeDelayMs());
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const scheduled = this.runQueue.then(task, task);
    this.runQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      void this.queue(async () => {
        try {
          await this.reconcile();
        } catch (error) {
          this.reportError(error);
        } finally {
          if (!this.stopped) this.schedule(this.computeDelayMs());
        }
      });
    }, Math.max(0, delayMs));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    for (const schedule of this.store.due(now)) {
      if (this.inFlight.has(schedule.id)) continue;
      const lateMs = now - schedule.at;
      if (lateMs > this.lateFireGraceMs) {
        this.settle(schedule, 'missed', {
          firedAt: now,
          error: `missed: broker was unavailable at the scheduled time (${Math.round(lateMs / 60_000)} min late, grace is ${Math.round(this.lateFireGraceMs / 60_000)} min)`,
        });
        continue;
      }
      this.inFlight.add(schedule.id);
      // Fire-and-forget: a slow attach on one schedule must not delay the others or the timer.
      void (async () => {
        let outcome: ScheduleOutcome = 'delivered';
        let detail: { firedAt: number; error?: string; createdSessionId?: string; failureKind?: ScheduleFailureKind };
        try {
          const result = await this.deliver(schedule);
          detail = { firedAt: this.now(), createdSessionId: result?.createdSessionId };
        } catch (error) {
          outcome = 'failed';
          detail = {
            firedAt: this.now(),
            error: error instanceof Error ? error.message : String(error),
            failureKind: error instanceof ScheduleDeliveryError ? error.failureKind : 'delivery',
          };
        } finally {
          try { this.settle(schedule, outcome, detail!); }
          finally { this.inFlight.delete(schedule.id); }
        }
      })();
    }
  }

  private settle(
    schedule: ScheduleRecord,
    outcome: ScheduleOutcome,
    detail: { firedAt: number; error?: string; createdSessionId?: string; failureKind?: ScheduleFailureKind },
  ): void {
    let updated: ScheduleRecord | undefined;
    try {
      updated = this.store.recordOutcome(schedule.id, outcome, detail);
    } catch (error) {
      // The delivery outcome is already reflected in the store's in-memory record. Surface the
      // durability fault, but never call delivery again or relabel a successful send as failed.
      this.reportError(error);
      updated = this.store.get(schedule.id);
    }
    // A retry is durable and still live. Notify only the terminal result so one logical occurrence
    // produces at most one user-facing failure event.
    if (updated?.nextRetryAt !== undefined) return;
    try {
      const result = this.onOutcome?.(updated ?? schedule, outcome, detail.error);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error) => this.reportError(error));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try { this.onError?.(error); } catch { /* observer-only */ }
  }

  private computeDelayMs(): number {
    const now = this.now();
    // A due row remains `scheduled` while its asynchronous delivery is in flight. Excluding it is
    // essential: otherwise nextAt-now stays negative and the timer rearms at 0ms in a CPU hot loop
    // until a slow attach completes.
    const nextAt = this.store.nextAt(this.inFlight);
    if (nextAt === undefined) return this.fallbackTickMs;
    return Math.max(0, Math.min(nextAt - now, this.fallbackTickMs));
  }
}
