/**
 * Active/agent time from event timestamps alone. Pure arithmetic — no clock, no
 * filesystem, no adapter state — so the estimate can be reasoned about and
 * tested independently of where the timestamps came from.
 *
 * The wire journal records WHEN work happened, never how long it took, so any
 * duration derived from it is an estimate. The method below is the one the
 * tokdash project settled on and is reimplemented here (nothing is imported
 * from it); naming it in the emitted payload is what lets a reader check the
 * figure against its definition instead of trusting a bare number.
 */

/**
 * The `capped-inter-event-gap` cap.
 *
 * METHOD, stated so the estimate cannot be mistaken for a measurement: per
 * stream, the gap between two consecutive events counts as working time up to
 * this cap. Three consequences follow directly and none of them is a defect to
 * be fixed later:
 *  - a short pause between two events is indistinguishable from work, so it
 *    counts as work;
 *  - one operation that genuinely ran longer than the cap is truncated to it;
 *  - a stream with a single event measures ZERO, because nothing precedes that
 *    event and there is no interval to attribute to it.
 */
export const KIMI_ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

/** The method name that travels with every emitted figure. */
export const KIMI_ACTIVE_TIME_METHOD = 'capped-inter-event-gap';

/**
 * The working intervals of ONE stream, `[start, end)` pairs in epoch ms.
 *
 * The interval ENDS at the event: an event is evidence that the work leading to
 * it had just finished, never that work is about to begin. A non-positive gap
 * (a repeated or out-of-order timestamp) contributes nothing rather than a
 * zero-length or inverted interval.
 */
export function activeIntervals(
  timestampsMs: readonly number[],
  capMs: number,
): Array<[number, number]> {
  const sorted = [...timestampsMs].sort((left, right) => left - right);
  const intervals: Array<[number, number]> = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const gap = current - sorted[index - 1]!;
    if (gap <= 0) continue;
    intervals.push([current - Math.min(gap, capMs), current]);
  }
  return intervals;
}

/**
 * Wall-clock milliseconds covered by a set of intervals, OVERLAP COUNTED ONCE.
 *
 * Sorting by start and extending the open interval is what makes two streams
 * working the same minute cost one minute of wall clock rather than two.
 */
export function mergedIntervalMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start = sorted[0]![0];
  let end = sorted[0]![1];
  for (let index = 1; index < sorted.length; index += 1) {
    const [nextStart, nextEnd] = sorted[index]!;
    if (nextStart > end) {
      total += end - start;
      start = nextStart;
      end = nextEnd;
      continue;
    }
    if (nextEnd > end) end = nextEnd;
  }
  return total + (end - start);
}

/**
 * The two figures, from every stream's timestamps.
 *
 * They answer different questions and must never be presented as one number:
 * `activeMs` is how long the SESSION was working (overlap counted once), while
 * `agentMs` is how much work the agents did (overlap counted per stream). A
 * subagent that runs one minute alongside the main stream adds one minute of
 * `agentMs` and no `activeMs` at all.
 */
export function activeTimeAccount(
  streams: ReadonlyMap<string, readonly number[]>,
  capMs: number,
): { activeMs: number; agentMs: number } {
  const all: Array<[number, number]> = [];
  let agentMs = 0;
  for (const timestamps of streams.values()) {
    for (const interval of activeIntervals(timestamps, capMs)) {
      agentMs += interval[1] - interval[0];
      all.push(interval);
    }
  }
  return { activeMs: mergedIntervalMs(all), agentMs };
}
