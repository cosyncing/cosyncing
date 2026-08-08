import type { WakeRegistration } from './push-wake.ts';

export interface DeviceWakeCoalescerOptions<TTimer = ReturnType<typeof setTimeout>> {
  dispatch: (registration: WakeRegistration) => Promise<unknown> | unknown;
  windowMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TTimer;
  clearTimer?: (timer: TTimer) => void;
  onError?: (error: unknown, registration: WakeRegistration) => void;
}

type DeviceState<TTimer> = {
  nextAllowedAt: number;
  timer?: TTimer;
  pending?: WakeRegistration;
  pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};

/**
 * Coalesces content-free provider wakes per device. Event delivery reservations remain independent;
 * one wake simply tells a device to fetch every available durable attention revision.
 * Governing UX/privacy: docs/architecture/client-ui.md
 */
export class DeviceWakeCoalescer<TTimer = ReturnType<typeof setTimeout>> {
  private readonly states = new Map<string, DeviceState<TTimer>>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (timer: TTimer) => void;

  constructor(private readonly options: DeviceWakeCoalescerOptions<TTimer>) {
    this.windowMs = Math.max(1, options.windowMs ?? 30_000);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  request(registration: WakeRegistration): Promise<void> {
    const now = this.now();
    let state = this.states.get(registration.deviceId);
    if (!state) {
      state = { nextAllowedAt: now + this.windowMs, pendingWaiters: [] };
      this.states.set(registration.deviceId, state);
      const dispatched = this.dispatch(registration);
      this.arm(registration.deviceId, state);
      return dispatched;
    }

    if (now >= state.nextAllowedAt) {
      if (state.timer !== undefined) this.clearTimer(state.timer);
      state.timer = undefined;
      const waiters = state.pendingWaiters;
      state.pendingWaiters = [];
      state.pending = undefined;
      state.nextAllowedAt = now + this.windowMs;
      const dispatched = this.dispatch(registration);
      void dispatched.then(
        () => { for (const waiter of waiters) waiter.resolve(); },
        (error) => { for (const waiter of waiters) waiter.reject(error); },
      );
      this.arm(registration.deviceId, state);
      return dispatched;
    }

    // Only the latest registration matters: token rotation inside the window must use the new token.
    state.pending = registration;
    return new Promise<void>((resolve, reject) => state!.pendingWaiters.push({ resolve, reject }));
  }

  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) this.clearTimer(state.timer);
      for (const waiter of state.pendingWaiters) waiter.reject(new Error('wake coalescer stopped'));
    }
    this.states.clear();
  }

  private arm(deviceId: string, state: DeviceState<TTimer>): void {
    const delay = Math.max(0, state.nextAllowedAt - this.now());
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      const pending = state.pending;
      const waiters = state.pendingWaiters;
      state.pending = undefined;
      state.pendingWaiters = [];
      if (!pending) {
        this.states.delete(deviceId);
        for (const waiter of waiters) waiter.resolve();
        return;
      }
      state.nextAllowedAt = this.now() + this.windowMs;
      void this.dispatch(pending).then(
        () => { for (const waiter of waiters) waiter.resolve(); },
        (error) => { for (const waiter of waiters) waiter.reject(error); },
      );
      this.arm(deviceId, state);
    }, delay);
    const timer = state.timer as { unref?: () => unknown };
    timer.unref?.();
  }

  private async dispatch(registration: WakeRegistration): Promise<void> {
    try {
      await this.options.dispatch(registration);
    } catch (error) {
      this.options.onError?.(error, registration);
      throw error;
    }
  }
}
