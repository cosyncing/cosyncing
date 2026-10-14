/**
 * Waiting, the one way every e2e suite does it.
 *
 * A test never sleeps a fixed time and never asserts that something happened
 * within N milliseconds of something else. It waits until a condition holds,
 * under a generous deadline, and the deadline is a hang detector rather than a
 * performance claim. `COSYNCING_E2E_TIME_SCALE` widens every deadline on a slow
 * host without touching a test.
 */

const SCALE = (() => {
  const parsed = Number(process.env.COSYNCING_E2E_TIME_SCALE ?? '1');
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
})();

/** Default deadline for anything the product should do "soon". */
export const SOON_MS = 20_000;

export function scaled(ms: number): number {
  return Math.round(ms * SCALE);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** What was being waited for; leads the error message. */
  what?: string;
}

/**
 * Poll until `probe` returns something other than `undefined`/`false`/`null`,
 * and return it. A probe that throws is retried; its last error is reported
 * if the deadline passes.
 */
export async function eventually<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = scaled(options.timeoutMs ?? SOON_MS);
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError instanceof Error ? `: last error ${lastError.message}` : '';
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.what ?? 'condition'}${cause}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Assert that something does NOT happen. Inherently a bounded wait, so it is
 * paired with a positive barrier: callers first wait for a later event that
 * must arrive after the forbidden one would have (a sentinel), then check.
 * Use this only where no sentinel exists.
 */
export async function never(
  probe: () => boolean | Promise<boolean>,
  forMs: number,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    if (await probe()) throw new Error(`${what} happened, and must not`);
    await sleep(25);
  }
}
