/**
 * The ceiling on a referenced diff body holds whatever the environment says.
 *
 * `e2e/broker/diff-references.test.ts` tunes the referenced-body bound DOWN
 * through the environment and watches a broker clip to it. The upward clamp
 * cannot be seen that way: Pi's bridge refuses an event body over 1 MiB, far
 * below the 4 MiB ceiling, and the bounds are read once at import. So the
 * module is imported fresh here with hostile values set.
 */
import { afterAll, expect, test } from 'bun:test';

const KEYS = ['COSYNCING_MAX_REFERENCED_DIFF_BYTES', 'COSYNCING_INLINE_DIFF_CAP_BYTES'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('a huge override of either diff bound is clamped to the 4 MiB hard ceiling', async () => {
  for (const key of KEYS) process.env[key] = String(999 * 1024 * 1024);
  // A query makes this a separate module instance, evaluated now, with these values.
  const fresh = await import(`./diff-reference.ts?clamp=${Date.now()}`);
  expect(fresh.HARD_MAX_REFERENCED_DIFF_BYTES).toBe(4 * 1024 * 1024);
  expect(fresh.MAX_REFERENCED_DIFF_BYTES).toBe(fresh.HARD_MAX_REFERENCED_DIFF_BYTES);
  expect(fresh.INLINE_DIFF_CAP).toBe(fresh.HARD_MAX_REFERENCED_DIFF_BYTES);
});
