/**
 * Clock-driven policy of the roster sweep cache that a request-level scenario
 * cannot arrange: which reading answers while sweeps of different ranges are in
 * flight, at exact ages. Behaviour reachable over HTTP lives in
 * `e2e/broker/roster-discovery-bounds.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  ROSTER_COVERAGE_COMPLETE,
  RosterSweepCache,
  type RosterSweepAnswer,
  type RosterSweepRead,
} from '../../src/roster/roster-sweep-cache.ts';

type Row = { id: string };

const WEEK = String(7 * 86_400_000);
const recent: RosterSweepAnswer<Row> = { rows: [{ id: 'recent' }], coverage: ROSTER_COVERAGE_COMPLETE };

function harness() {
  let now = 1_000_000;
  const cache = new RosterSweepCache<Row>({ ttlMs: 15_000, staleServeMaxMs: 60_000, coldPartialMs: 50, now: () => now });
  const read = (key: string, options: Partial<RosterSweepRead<Row>> = {}) => cache.read({
    key,
    force: false,
    allowSweeping: true,
    now,
    covers: (candidate) => candidate === 'all' || (key !== 'all' && Number(candidate) >= Number(key)),
    startSweep: () => Promise.reject(new Error(`unexpected sweep of ${key}`)),
    ...options,
  });
  return { cache, read, now: () => now, advance: (ms: number) => { now += ms; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('roster sweep cache policy', () => {
  test('a running wider sweep never outranks or replaces a settled narrower reading', async () => {
    const { cache, read, now, advance } = harness();
    cache.publish(WEEK, recent, now());
    advance(3_000);
    // A cold all-time sweep starts, and its first leg seeds a partial snapshot
    // timed from that later start.
    const archive = deferred<RosterSweepAnswer<Row>>();
    const cold = read('all', {
      startSweep: () => {
        cache.seedLeg('all', now(), () => [{ id: 'archive-leg' }]);
        return archive.promise;
      },
    });
    advance(2_000);
    expect(await read(WEEK)).toEqual(recent);

    // Past its own TTL, the week view still serves its own rows while the
    // all-time sweep runs, and its snapshot is left as it was.
    advance(14_000);
    expect(await read(WEEK)).toEqual(recent);
    expect(cache.snapshot(WEEK)).toMatchObject(recent);

    archive.resolve({ rows: [{ id: 'archive' }, { id: 'recent' }], coverage: ROSTER_COVERAGE_COMPLETE });
    await cold;
  });

  test('a forced read sweeps its own range instead of joining a running wider one', async () => {
    const { read } = harness();
    const archive = deferred<RosterSweepAnswer<Row>>();
    const cold = read('all', { startSweep: () => archive.promise });
    let swept = false;
    const forced = await read(WEEK, {
      force: true,
      startSweep: async () => {
        swept = true;
        return recent;
      },
    });
    expect(swept).toBe(true);
    expect(forced).toEqual(recent);
    archive.resolve(recent);
    await cold;
  });
});
