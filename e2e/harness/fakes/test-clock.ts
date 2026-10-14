/**
 * The broker's movable clock, from the test's side.
 *
 * A source-mode broker started with {@link TestClock.env} reads attention and push time as the wall
 * clock plus the offset in this file (`COSYNCING_TEST_CLOCK_FILE`), and runs its reminder pass when
 * the offset changes. A test moves time forward instead of waiting for it:
 *
 *   let clock!: TestClock;
 *   const broker = await startBroker({ env: (paths) => (clock = new TestClock(paths.root)).env });
 *   clock.advance(2 * HOUR);
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class TestClock {
  readonly file: string;
  #offset = 0;
  #writes = 0;

  constructor(directory: string) {
    this.file = join(directory, 'test-clock-offset');
    this.#write();
  }

  get env(): Record<string, string> {
    return { COSYNCING_TEST_CLOCK_FILE: this.file };
  }

  /** How far the broker's clock is ahead of the wall clock. */
  get offset(): number {
    return this.#offset;
  }

  /** The broker's idea of the current time. */
  now(): number {
    return Date.now() + this.#offset;
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`advance by a positive whole number of ms, not ${ms}`);
    this.#offset += ms;
    this.#write();
  }

  #write(): void {
    // Atomic, so the broker never reads a half-written offset.
    const temporary = `${this.file}.${process.pid}.${(this.#writes += 1)}`;
    writeFileSync(temporary, String(this.#offset));
    // Windows refuses to replace a file another process has open, and the broker reads this one on
    // every clock call; its reads are brief, so try again until one lands between them.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        renameSync(temporary, this.file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() > deadline) throw error;
        Bun.sleepSync(5);
      }
    }
  }
}
