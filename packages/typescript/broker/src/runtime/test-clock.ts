/**
 * Test hook (source runs only; a packaged broker ignores it): a clock an e2e suite can move.
 *
 * `COSYNCING_TEST_CLOCK_FILE` names a file holding a millisecond offset, added to the wall clock
 * wherever the broker keeps attention and push time (reminder and retry schedules, the
 * repeated-authentication window and cooldown, event retention, registration times), scheduled-send
 * fire times, and shared-draft retention. A suite moves
 * time by rewriting the file; the broker then runs the `onMove` listeners, as a timer falling due at
 * the new time would have. Without the variable this is `Date.now`.
 */
import { readFileSync } from 'node:fs';

export interface BrokerClock {
  now(): number;
  /** Runs `listener` after the offset changes. */
  onMove(listener: () => void): void;
  stop(): void;
}

const WALL_CLOCK: BrokerClock = { now: Date.now, onMove: () => {}, stop: () => {} };

export function createBrokerClock(options: { packaged: boolean; file?: string; pollMs?: number }): BrokerClock {
  const file = options.file?.trim();
  if (options.packaged || !file) return WALL_CLOCK;
  let offset = 0;
  const read = (): number => {
    try {
      const text = readFileSync(file, 'utf8').trim();
      // An empty, half-written or missing file keeps the last offset: time never jumps back to the
      // wall clock (`Number('')` is 0).
      const parsed = text === '' ? Number.NaN : Number(text);
      if (Number.isSafeInteger(parsed)) offset = parsed;
    } catch {
      // Keep the last offset.
    }
    return offset;
  };
  read();
  const listeners: Array<() => void> = [];
  let seen = offset;
  const poll = setInterval(() => {
    if (read() === seen) return;
    seen = offset;
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener never stops the clock */ }
    }
  }, Math.max(10, options.pollMs ?? 50));
  poll.unref?.();
  return {
    // Read on every call, so anything the suite does after moving the clock sees the new time.
    now: () => Date.now() + read(),
    onMove: (listener) => { listeners.push(listener); },
    stop: () => clearInterval(poll),
  };
}
