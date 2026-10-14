/**
 * A large history capture never holds the broker's event loop: one client attaching a huge
 * rollout must not freeze every other session, live tail and health probe. The capture resumes
 * through the event loop after every chunk it reads, so other work interleaves with it.
 *
 * Measured without a clock: a `setImmediate` chain runs beside the capture and counts the
 * event-loop turns that happened while it ran. A capture that yields lets the chain advance about
 * once per chunk; a synchronous scan (the pre-fix shape, two blocking passes over the whole file)
 * lets it advance at most once. Kept narrow: an e2e could only observe this as latency.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { captureFileHistoryInto } from '../../../adapters/codex/src/index.ts';
import { BoundedTailHistorySnapshotSink, IndexedHistoryPageCacheBuilder } from '../../src/sessions/history-page-cache.ts';

const MiB = 1024 * 1024;
/** Dense real bytes: a sparse hole reads at memory speed and proves nothing. */
const FIXTURE_MiB = 16;

const temp = mkdtempSync(join(tmpdir(), 'cosyncing-capture-yields-'));
const fixture = join(temp, 'dense-rollout.jsonl');
{
  const fd = openSync(fixture, 'w');
  try {
    const row = 'd'.repeat(6_000);
    let written = 0;
    for (let index = 0; written < FIXTURE_MiB * MiB; index += 1) {
      const line = `${JSON.stringify({
        timestamp: '2026-07-31T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: `liveness row ${index} ${row}` },
      })}\n`;
      written += writeSync(fd, line);
    }
  } finally {
    closeSync(fd);
  }
}
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** Run [work] while counting event-loop turns. */
async function turnsDuring<T>(work: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const result = await work();
    return { result, turns };
  } finally {
    running = false;
  }
}

describe('a large history capture keeps the event loop turning', () => {
  test('the bounded-tail capture yields between chunks', async () => {
    const sink = new BoundedTailHistorySnapshotSink();
    const { result, turns } = await turnsDuring(() => captureFileHistoryInto(fixture, sink));
    expect(result && !('refusal' in result)).toBe(true);
    expect(sink.retainedMessages).toBeGreaterThan(0);
    // At least one turn per MiB chunk of one of its two passes.
    expect(turns).toBeGreaterThanOrEqual(FIXTURE_MiB);
  });

  test('the indexing capture shares the yielding scan', async () => {
    const builder = new IndexedHistoryPageCacheBuilder();
    let indexed = 0;
    const { result, turns } = await turnsDuring(() => captureFileHistoryInto(fixture, {
      acceptsLocations: true,
      accept(message: AgentMessage, location?: number): boolean {
        const ok = builder.accept(message, location);
        if (ok) indexed += 1;
        return ok;
      },
    }));
    expect(result && !('refusal' in result)).toBe(true);
    expect(indexed).toBeGreaterThan(0);
    expect(turns).toBeGreaterThanOrEqual(FIXTURE_MiB);
  });

  test('a capture past its time budget is a typed refusal, not a hang', async () => {
    const refused = await captureFileHistoryInto(fixture, new BoundedTailHistorySnapshotSink(), undefined, { maxElapsedMs: 0 });
    expect(refused && 'refusal' in refused ? refused.refusal : refused).toBe('resource-limit');
  });
});
