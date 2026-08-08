#!/usr/bin/env bun
/**
 * H1c — a large history capture must never block the broker's event loop.
 *
 * The two capture passes were one synchronous `readSync` loop over a source
 * admitted up to 1 GiB, run twice. At realistic throughput that is tens of
 * seconds during which the broker services nothing: one client's attach froze
 * every other client's session, every live tail, and every health probe. The
 * existing sparse-file fixtures could not see this — a hole reads at memory
 * speed, so the loop finished before anything noticed.
 *
 * This measures the property directly. A `setInterval` heartbeat runs while a
 * capture reads a DENSE fixture of real bytes; the largest gap between two
 * heartbeat ticks is how long the capture held the loop. It fails against the
 * pre-fix synchronous scan with one gap covering the entire read.
 *
 * Determinism notes, because a timing test that flakes is worse than no test:
 *   - The fixture is sized for SECONDS (see FIXTURE_BYTES), not minutes, so a
 *     slow CI runner stretches the total but not the per-slice work.
 *   - The threshold is per-SLICE, not total. One 1 MiB chunk plus its record
 *     parsing is the unit of work between yields, so a slower machine makes the
 *     capture take longer without making any single slice longer — and it makes
 *     the pre-fix blocking read that this must catch longer still.
 *   - The heartbeat is compared against its own previous tick, never against
 *     wall-clock expectations, so a suspended VM does not by itself fail it.
 */
import { strict as assert } from 'node:assert';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  captureFileHistoryInto,
} from '../../../../packages/typescript/adapters/codex/src/index.ts';
import {
  BoundedTailHistorySnapshotSink,
  IndexedHistoryPageCacheBuilder,
} from '../../../../packages/typescript/broker/src/history-page-cache.ts';

/** Dense real bytes. Large enough that a synchronous read is unmistakable
 *  (multiple seconds of blocking), small enough to write and read twice in a
 *  few seconds on an ordinary disk. */
const FIXTURE_BYTES = 200 * 1024 * 1024;
/** Heartbeat period. Well under the threshold, so a genuine stall is measured
 *  by many missed ticks rather than by one borderline one. */
const HEARTBEAT_MS = 10;
/** Largest tolerated gap between heartbeats.
 *
 *  Measured on this fixture: ~17 ms post-fix (one 1 MiB chunk plus its record
 *  parsing) against ~690 ms pre-fix (the whole two-pass read in one blocking
 *  slice). 250 ms sits an order of magnitude above the real per-slice cost —
 *  so an unrelated GC pause or a busy scheduler cannot fail it — while staying
 *  well under the blocking read it has to catch. */
const MAX_GAP_MS = 250;

type Heartbeat = {
  stop: () => { maxGapMs: number; ticks: number };
};

function startHeartbeat(): Heartbeat {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks += 1;
  }, HEARTBEAT_MS);
  return {
    stop() {
      clearInterval(timer);
      const now = performance.now();
      // The final interval counts too: a stall that begins mid-read and is
      // still running when the capture returns would otherwise be invisible.
      return { maxGapMs: Math.max(maxGapMs, now - last), ticks };
    },
  };
}

const temp = mkdtempSync(join(tmpdir(), 'cosyncing-h1c-liveness-'));
const fixture = join(temp, 'dense-rollout.jsonl');

try {
  // ------------------------------------------------------------- the fixture
  // Real bytes, not a sparse hole: holes read at memory speed and would let a
  // fully synchronous scan pass this test.
  // Records are deliberately fat. The fixture has to stay inside the INDEXING
  // path's own contract too (50,000 messages, 250,000 native records) so both
  // halves of this test read the same bytes; 200 MiB across 50,000 messages is
  // 4 KiB a record at minimum, so 6 KiB rows leave comfortable margin.
  const rowText = 'd'.repeat(6_000);
  let written = 0;
  let rowIndex = 0;
  const fd = openSync(fixture, 'w');
  try {
    while (written < FIXTURE_BYTES) {
      const batch: string[] = [];
      for (let index = 0; index < 200; index += 1) {
        batch.push(JSON.stringify({
          timestamp: '2026-07-31T00:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: `liveness row ${rowIndex++} ${rowText}`,
          },
        }));
      }
      const chunk = `${batch.join('\n')}\n`;
      writeSync(fd, chunk);
      written += Buffer.byteLength(chunk, 'utf8');
    }
  } finally {
    closeSync(fd);
  }
  const sourceBytes = statSync(fixture).size;
  assert(
    sourceBytes >= FIXTURE_BYTES,
    `the liveness fixture must be dense and large: ${sourceBytes}`,
  );

  // --------------------------------------------- bounded-tail capture (H1c)
  const tailSink = new BoundedTailHistorySnapshotSink();
  const tailBeat = startHeartbeat();
  const tailStartedAt = performance.now();
  const tailCaptured = await captureFileHistoryInto(fixture, tailSink);
  const tailElapsedMs = performance.now() - tailStartedAt;
  const tail = tailBeat.stop();

  assert(
    tailCaptured && !('refusal' in tailCaptured),
    `the dense fixture is inside every ceiling and must capture: ${JSON.stringify(tailCaptured)}`,
  );
  assert(
    tail.ticks > 0,
    'the heartbeat never ran; the measurement proves nothing',
  );
  assert(
    tail.maxGapMs < MAX_GAP_MS,
    `a bounded-tail capture blocked the event loop for ${tail.maxGapMs.toFixed(0)}ms `
      + `(limit ${MAX_GAP_MS}ms) over ${(sourceBytes / (1024 * 1024)).toFixed(0)} MiB`,
  );
  assert(
    tailSink.retainedMessages > 0,
    'the capture must have actually produced a window',
  );

  // -------------------------------------- the INDEXING path shares the scan
  // Same function, same fix. This is the pre-existing 256 MiB path that also
  // ran fully synchronously.
  const indexBuilder = new IndexedHistoryPageCacheBuilder();
  let indexed = 0;
  const indexBeat = startHeartbeat();
  const indexStartedAt = performance.now();
  const indexCaptured = await captureFileHistoryInto(fixture, {
    acceptsLocations: true,
    accept(message: AgentMessage, location?: number): boolean {
      const ok = indexBuilder.accept(message, location);
      if (ok) indexed += 1;
      return ok;
    },
  });
  const indexElapsedMs = performance.now() - indexStartedAt;
  const index = indexBeat.stop();

  assert(
    indexCaptured && !('refusal' in indexCaptured),
    `the dense fixture must also index: ${JSON.stringify(indexCaptured)}`,
  );
  assert(
    index.maxGapMs < MAX_GAP_MS,
    `an indexing capture blocked the event loop for ${index.maxGapMs.toFixed(0)}ms `
      + `(limit ${MAX_GAP_MS}ms)`,
  );
  assert(indexed > 0, 'the indexing capture must have accepted messages');

  // ------------------------------------------------ the wall-clock ceiling
  // Yielding moves the cost from the event loop to elapsed time, so elapsed
  // time is what needs a bound now. Driven through the documented test seam so
  // the abort is deterministic rather than timing-dependent.
  const timedOut = await captureFileHistoryInto(
    fixture,
    new BoundedTailHistorySnapshotSink(),
    undefined,
    { maxElapsedMs: 0 },
  );
  assert(
    timedOut && 'refusal' in timedOut && timedOut.refusal === 'resource-limit',
    `a capture past its wall-clock budget must be a typed refusal: ${JSON.stringify(timedOut)}`,
  );

  console.log(JSON.stringify({
    sourceBytes,
    rows: rowIndex,
    tail: {
      elapsedMs: Math.round(tailElapsedMs),
      maxHeartbeatGapMs: Math.round(tail.maxGapMs),
      heartbeats: tail.ticks,
      retainedMessages: tailSink.retainedMessages,
    },
    indexed: {
      elapsedMs: Math.round(indexElapsedMs),
      maxHeartbeatGapMs: Math.round(index.maxGapMs),
      heartbeats: index.ticks,
      messages: indexed,
    },
    maxGapLimitMs: MAX_GAP_MS,
  }));
  console.log('PASS H1c a large history capture keeps the broker event loop live');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
