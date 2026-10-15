/**
 * The history frame bound is measured with the Flutter client's own decoded-size estimate, so the
 * broker never sends a frame the client would have to cut without a boundary. The two estimators
 * live in two languages; `contracts/fixtures/history-decoded-size-estimates.json` holds the cases
 * both must agree on (the client pins the same numbers in
 * `apps/client/test/narrow/history_protocol/budget_cases.dart`).
 * Kept narrow: a cross-language vector no e2e reaches.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimatedClientDecodedBytes } from '../../src/sessions/history-delta.ts';

const fixture = JSON.parse(readFileSync(
  join(import.meta.dir, '../../../../../contracts/fixtures/history-decoded-size-estimates.json'),
  'utf8',
)) as { cases: Array<{ message: Record<string, unknown>; estimatedBytes: number }> };

describe('the decoded-size estimate matches the client', () => {
  for (const { message, estimatedBytes } of fixture.cases) {
    test(`${String(message.type)} ${String(message.key ?? message.callId ?? '')}`, () => {
      expect(estimatedClientDecodedBytes(message)).toBe(estimatedBytes);
    });
  }

  test('a property that is not delivered is not counted', () => {
    expect(estimatedClientDecodedBytes({ a: undefined, b: [1, null, true] }))
      .toBe(64 + 24 + 26 + 32 + 24 + 16 + 8 + 16);
  });
});
