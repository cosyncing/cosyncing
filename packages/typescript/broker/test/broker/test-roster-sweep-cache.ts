#!/usr/bin/env bun
/**
 * The roster sweep cache's timing rules (packages/typescript/broker/src/roster/roster-sweep-cache.ts).
 *
 * These are the rules a request-level test cannot reach. Each bug below needed a
 * caller to arrive at a specific instant inside a sweep -- before its first leg
 * lands, or between an early answer and the sweep's completion -- and all three
 * shipped without a test because there was nowhere to write one:
 *
 *   1. Only the request that STARTED a sweep was bounded. A second cold caller
 *      joined the raw promise and waited out the whole thing, which on a cold
 *      broker is every request after the first.
 *   2. A partial answer was assumed to correct itself. It does not: filling the
 *      cache advances no roster revision, so an ETag client is answered 304 with
 *      the partial roster until something unrelated disturbs it.
 *   3. The correction was then attached to the cold partial ONLY, leaving the
 *      ordinary stale-while-revalidate answer -- the one a reconnect gets --
 *      with exactly the same hole.
 *
 * `test-roster-stale-reconcile.ts` proves the outcome of 2 and 3 over real HTTP,
 * where the revision and the ETag actually live. This suite proves the rule.
 *
 *   bun run packages/typescript/broker/test/broker/test-roster-sweep-cache.ts
 */
export {};
import {
  ROSTER_COVERAGE_COMPLETE,
  RosterSweepCache,
  unconfirmedBackends,
  type RosterCoverage,
  type RosterSweepAnswer,
} from '../../src/roster/roster-sweep-cache.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Scaled down from the product's 2500ms so the suite runs in milliseconds. */
const PARTIAL_MS = 40;
const TTL_MS = 400;
const STALE_MS = 4_000;

type Row = { id: string };
const row = (id: string): Row => ({ id });

function cache(now?: () => number): RosterSweepCache<Row> {
  return new RosterSweepCache<Row>({
    ttlMs: TTL_MS,
    staleServeMaxMs: STALE_MS,
    coldPartialMs: PARTIAL_MS,
    ...(now ? { now } : {}),
  });
}

/** A sweep that never settles on its own, so a missing bound HANGS visibly. */
function wedged(): {
  sweep: () => Promise<RosterSweepAnswer<Row>>;
  finish: (rows: Row[], coverage?: RosterCoverage) => void;
} {
  let settle: ((answer: RosterSweepAnswer<Row>) => void) | undefined;
  const promise = new Promise<RosterSweepAnswer<Row>>((resolve) => { settle = resolve; });
  return {
    sweep: () => promise,
    finish: (rows, coverage = ROSTER_COVERAGE_COMPLETE) => settle?.({ rows, coverage }),
  };
}

/** Rows of a settled answer, or a marker the checks can print. */
const rowsOf = (answer: RosterSweepAnswer<Row> | 'TIMED-OUT'): Row[] =>
  answer === 'TIMED-OUT' ? [] : answer.rows;
const coverageOf = (answer: RosterSweepAnswer<Row> | 'TIMED-OUT'): string =>
  answer === 'TIMED-OUT' ? 'TIMED-OUT' : answer.coverage.kind;
const withheldOf = (answer: RosterSweepAnswer<Row> | 'TIMED-OUT'): readonly string[] =>
  answer !== 'TIMED-OUT' && answer.coverage.kind === 'incomplete' ? answer.coverage.withheld : [];

/**
 * Bound every await, because the regression under test is an UNBOUNDED wait: a
 * plain `await` would hang the whole deterministic run instead of failing one
 * sub-suite. Generous enough that it can only fire for a read that is not
 * bounded at all.
 */
const WATCHDOG_MS = PARTIAL_MS * 25;
async function within<T>(work: Promise<T>): Promise<T | 'TIMED-OUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    work,
    new Promise<'TIMED-OUT'>((resolve) => { timer = setTimeout(() => resolve('TIMED-OUT'), WATCHDOG_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

// ── 1. A cold caller is answered from the legs that have landed ──────────────
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  const startedAt = Date.now();
  const read = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: startedAt,
    startSweep: sweep,
  });
  // One fast leg lands; the rest of the sweep stays wedged.
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, (existing) => [...existing, row('omp-1')]);
  const answered = await within(read);
  const elapsed = Date.now() - startedAt;
  check(
    'a cold caller is answered with the landed legs rather than the whole sweep',
    rowsOf(answered).length === 1 && rowsOf(answered)[0]?.id === 'omp-1' && elapsed < WATCHDOG_MS,
    `${elapsed}ms, rows=${JSON.stringify(rowsOf(answered))}`,
  );
  check(
    'and it is told the roster is not the whole one',
    coverageOf(answered) === 'sweeping',
    coverageOf(answered),
  );
  finish([row('omp-1'), row('cline-1')]);
}

// ── 2. ...and so is a caller that merely JOINS that sweep ────────────────────
//
// The regression: the bound lived after the `pending` join, so a second cold
// caller returned the raw sweep promise and waited without limit. On a cold
// broker this is not an edge case -- every tab after the first hits it.
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  const startedAt = Date.now();
  const first = sweeps.read({ key: '7d', force: false, allowSweeping: true, now: startedAt, startSweep: sweep });
  // The joiner arrives BEFORE any leg has landed, which is the whole point: with
  // a snapshot present it would have taken the stale-serve path and proved
  // nothing about the bound.
  const joiner = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: Date.now(),
    startSweep: () => { throw new Error('a joiner must never start a second sweep'); },
  });
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, (existing) => [...existing, row('omp-1')]);

  const joined = await within(joiner);
  check(
    'a second cold caller joining the same sweep is bounded exactly like the first',
    rowsOf(joined).length === 1 && rowsOf(joined)[0]?.id === 'omp-1' && coverageOf(joined) === 'sweeping',
    `${JSON.stringify(rowsOf(joined))} ${coverageOf(joined)}`,
  );
  const both = await within(first);
  check(
    'and the caller that started the sweep still gets its own bounded answer',
    rowsOf(both).length === 1,
    JSON.stringify(rowsOf(both)),
  );
  finish([row('omp-1')]);
}

// ── 3. A partial answer schedules its own correction ─────────────────────────
//
// Serving an incomplete roster is only safe if something puts the complete one
// in front of the client afterwards. Nothing in the cache can do that -- the
// journal and the ETag live in the runtime -- so the cache's whole obligation is
// to SAY that it served a partial, exactly once, with the sweep to wait on.
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  const startedAt = Date.now();
  let partialsAnnounced = 0;
  let correctedWith: Row[] | undefined;
  const announce = (pending: Promise<RosterSweepAnswer<Row>>): void => {
    partialsAnnounced += 1;
    void pending.then((answer) => { correctedWith = answer.rows; });
  };
  const first = sweeps.read({ key: '7d', force: false, allowSweeping: true, now: startedAt, startSweep: sweep, onServedAheadOfSweep: announce });
  const second = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: Date.now(),
    startSweep: () => { throw new Error('unreachable'); },
    onServedAheadOfSweep: announce,
  });
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, (existing) => [...existing, row('omp-1')]);
  await within(first);
  await within(second);
  check(
    'a partial answer announces itself so the caller can correct it',
    partialsAnnounced === 1,
    `announced=${partialsAnnounced}`,
  );

  finish([row('omp-1'), row('cline-1')]);
  await sleep(5);
  check(
    'the announcement carries the sweep, so the correction runs on the COMPLETE rows',
    correctedWith?.length === 2,
    JSON.stringify(correctedWith),
  );
  const settled = sweeps.snapshot('7d');
  check(
    'and the completed sweep replaces the seeded partial snapshot',
    settled?.rows.length === 2 && settled.at >= startedAt,
    JSON.stringify(settled),
  );
}

// ── 4. Nothing landed: wait rather than answer "no sessions" ─────────────────
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  let announced = 0;
  const read = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: Date.now(),
    startSweep: sweep,
    onServedAheadOfSweep: () => { announced += 1; },
  });
  await sleep(PARTIAL_MS * 2);
  check(
    'with no leg landed the caller keeps waiting instead of being handed an empty roster',
    announced === 0,
    `announced=${announced}`,
  );
  finish([row('late-1')]);
  const answered = await within(read);
  check(
    'and it receives the complete sweep when it finally lands',
    rowsOf(answered).length === 1 && rowsOf(answered)[0]?.id === 'late-1'
      && coverageOf(answered) === 'complete',
    `${JSON.stringify(rowsOf(answered))} ${coverageOf(answered)}`,
  );
}

// ── 5. A seeded snapshot keeps the SWEEP's start time ────────────────────────
//
// Dating a seeded partial `now` would serve an incomplete roster as a complete
// one for a full TTL. Dating the whole snapshot from a late leg would do the
// same thing more subtly, by pushing the TTL out every time a leg lands.
{
  const sweeps = cache();
  const sweepStartedAt = 1_000;
  sweeps.seedLeg('7d', sweepStartedAt, () => [row('omp-1')]);
  await sleep(5);
  sweeps.seedLeg('7d', sweepStartedAt + 5_000, (existing) => [...existing, row('cline-1')]);
  const snapshot = sweeps.snapshot('7d');
  check(
    'a later leg merges into the snapshot without extending its age',
    snapshot?.at === sweepStartedAt && snapshot.rows.length === 2,
    JSON.stringify(snapshot),
  );
}

// ── 6. The ordinary paths are unchanged ──────────────────────────────────────
{
  // A controlled clock, because the TTL compares the CALLER's reading against
  // the cache's own: a synthetic `now` against a real `Date.now()` publish makes
  // every snapshot look freshly written and the test vacuous.
  let clock = 10_000;
  const sweeps = cache(() => clock);
  let sweepsStarted = 0;
  const start = (rows: Row[]) => async (): Promise<RosterSweepAnswer<Row>> => {
    sweepsStarted += 1;
    return { rows, coverage: ROSTER_COVERAGE_COMPLETE };
  };

  const first = await within(sweeps.read({ key: 'all', force: false, allowSweeping: true, now: clock, startSweep: start([row('a')]) }));
  clock = 10_100;
  const fresh = await within(sweeps.read({ key: 'all', force: false, allowSweeping: true, now: clock, startSweep: start([row('b')]) }));
  check(
    'a read inside the TTL is served from the snapshot without starting a sweep',
    rowsOf(first).length === 1 && rowsOf(fresh)[0]?.id === 'a' && sweepsStarted === 1,
    `sweeps=${sweepsStarted} rows=${JSON.stringify(rowsOf(fresh))}`,
  );

  // Past the TTL: the previous rows are served NOW and a fresh sweep runs behind.
  const { sweep, finish } = wedged();
  clock = 10_100 + TTL_MS + 1;
  const stale = await within(sweeps.read({
    key: 'all',
    force: false,
    allowSweeping: true,
    now: clock,
    startSweep: () => { sweepsStarted += 1; return sweep(); },
  }));
  check(
    'past the TTL the previous rows are served while a fresh sweep runs',
    rowsOf(stale)[0]?.id === 'a' && sweepsStarted === 2 && coverageOf(stale) === 'complete',
    `sweeps=${sweepsStarted} rows=${JSON.stringify(rowsOf(stale))} ${coverageOf(stale)}`,
  );
  finish([row('c')]);
  await sleep(5);
  check(
    'and that sweep publishes its own rows for the next read',
    sweeps.snapshot('all')?.rows[0]?.id === 'c',
    JSON.stringify(sweeps.snapshot('all')),
  );
}

// ── 7. `force` is never answered early ───────────────────────────────────────
//
// `?refresh=1` asks for THIS sweep. A bounded partial would make the one
// diagnostic that exists to see the real state report a convenient summary of it.
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  const startedAt = Date.now();
  let answered = false;
  const forced = sweeps.read({ key: '7d', force: true, allowSweeping: true, now: startedAt, startSweep: sweep })
    .then((answer) => { answered = true; return answer; });
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, () => [row('omp-1')]);
  await sleep(PARTIAL_MS * 2);
  check(
    'a forced read is not answered from a partial snapshot',
    answered === false,
    `answered=${answered}`,
  );
  finish([row('omp-1'), row('cline-1')]);
  const rows = await within(forced);
  check(
    'a forced read resolves with the sweep it asked for',
    rowsOf(rows).length === 2,
    JSON.stringify(rowsOf(rows)),
  );
}

// ── 8. A failing sweep is reported rather than hidden ────────────────────────
{
  const sweeps = cache();
  sweeps.publish('7d', { rows: [row('old-1')], coverage: ROSTER_COVERAGE_COMPLETE }, 20_000);
  const failures: string[] = [];
  const served = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: 20_000 + TTL_MS + 1,
    startSweep: () => Promise.reject(new Error('discovery is broken')),
    onDetachedFailure: (error) => { failures.push(String(error)); },
  }));
  await sleep(5);
  check(
    'stale rows are served while a failed sweep is reported, not swallowed',
    rowsOf(served)[0]?.id === 'old-1' && failures.length === 1
      && failures[0]?.includes('discovery is broken') === true,
    `rows=${JSON.stringify(rowsOf(served))} failures=${JSON.stringify(failures)}`,
  );
  // A rejected sweep must not leave the key wedged as permanently in flight.
  const after = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: 20_000 + TTL_MS + 2,
    startSweep: async () => ({ rows: [row('recovered-1')], coverage: ROSTER_COVERAGE_COMPLETE }),
  }));
  await sleep(5);
  check(
    'and the next read after a failure can start a new sweep',
    sweeps.snapshot('7d')?.rows[0]?.id === 'recovered-1',
    JSON.stringify({ after: rowsOf(after), snapshot: sweeps.snapshot('7d') }),
  );
}

// ── 9. Windows are independent ───────────────────────────────────────────────
{
  const sweeps = cache();
  const seven = wedged();
  const all = wedged();
  const startedAt = Date.now();
  const sevenRead = sweeps.read({ key: '7d', force: false, allowSweeping: true, now: startedAt, startSweep: seven.sweep });
  const allRead = sweeps.read({ key: 'all', force: false, allowSweeping: true, now: startedAt, startSweep: all.sweep });
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, () => [row('seven-1')]);
  const sevenRows = await within(sevenRead);
  check(
    "one window's landed legs never answer another window's caller",
    rowsOf(sevenRows)[0]?.id === 'seven-1' && sweeps.snapshot('all') === undefined,
    JSON.stringify({ sevenRows: rowsOf(sevenRows), all: sweeps.snapshot('all') }),
  );
  seven.finish([row('seven-1')]);
  all.finish([row('all-1')]);
  await within(allRead);
}

// ── 10. Stale-while-revalidate announces itself too ──────────────────────────
//
// The correction was attached to the COLD partial only, and the ordinary
// stale answer -- the one a reconnect gets -- was merely observed for failure.
// Same hole, commoner path: the sweep fills the snapshot, no revision moves, and
// `/api/sessions` answers 304 without reaching discovery again, so the poll that
// would have picked up the new rows never runs.
{
  let clock = 50_000;
  const sweeps = cache(() => clock);
  sweeps.publish('7d', { rows: [row('known-1')], coverage: ROSTER_COVERAGE_COMPLETE }, clock);
  const { sweep, finish } = wedged();
  let announcedWith: Promise<RosterSweepAnswer<Row>> | undefined;
  let announcements = 0;
  clock = 50_000 + TTL_MS + 1;
  const stale = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: clock,
    startSweep: sweep,
    onServedAheadOfSweep: (pending) => { announcements += 1; announcedWith = pending; },
  }));
  check(
    'an ordinary stale answer announces itself, not just a cold partial',
    rowsOf(stale)[0]?.id === 'known-1' && announcements === 1
      // Stale is not incomplete: these rows WERE the whole roster when taken.
      && coverageOf(stale) === 'complete',
    `rows=${JSON.stringify(rowsOf(stale))} ${coverageOf(stale)} announced=${announcements}`,
  );

  // A second reader joining the same sweep must not schedule a second
  // correction: one reconcile per sweep is the whole of what is owed.
  const joined = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: clock,
    startSweep: () => { throw new Error('a joiner must never start a second sweep'); },
    onServedAheadOfSweep: () => { announcements += 1; },
  }));
  check(
    'a joiner served the same stale rows does not schedule a second correction',
    rowsOf(joined)[0]?.id === 'known-1' && announcements === 1,
    `announced=${announcements}`,
  );

  finish([row('known-1'), row('discovered-on-disk')]);
  const corrected = announcedWith === undefined ? undefined : await within(announcedWith);
  check(
    'and the announcement resolves with the rows the client is missing',
    corrected !== undefined && rowsOf(corrected).length === 2
      && rowsOf(corrected).some((entry) => entry.id === 'discovered-on-disk'),
    JSON.stringify(corrected === undefined ? [] : rowsOf(corrected)),
  );

  // The next sweep gets its own announcement: the dedupe is per sweep, not a
  // one-shot that silences every later correction.
  clock += TTL_MS + 1;
  const next = wedged();
  await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: clock,
    startSweep: next.sweep,
    onServedAheadOfSweep: () => { announcements += 1; },
  }));
  check(
    'a later sweep announces its own early answer rather than being deduped away',
    announcements === 2,
    `announced=${announcements}`,
  );
  next.finish([row('known-1')]);
}

// ── 11. A settled sweep that lost a leg is incomplete, and still authoritative ─
//
// Two kinds of incompleteness, and the caller has to tell them apart. A sweep
// still RUNNING must never be journalled -- its gaps are rows nobody has looked
// for yet. A sweep that SETTLED with an adapter contributing nothing can persist
// for as long as that adapter stays slow, so it has to keep reconciling or a
// deleted session would never leave the roster on that machine again.
{
  let clock = 70_000;
  const sweeps = cache(() => clock);
  const { sweep, finish } = wedged();
  const answered = sweeps.read({ key: '7d', force: false, allowSweeping: true, now: clock, startSweep: sweep });
  finish([row('omp-1')], { kind: 'incomplete', withheld: ['cline'] });
  const settled = await within(answered);
  check(
    'a settled sweep that lost a leg reports incomplete, not sweeping',
    coverageOf(settled) === 'incomplete' && rowsOf(settled).length === 1,
    `${coverageOf(settled)} rows=${JSON.stringify(rowsOf(settled))}`,
  );
  check(
    'and it is published, so the next read inside the TTL carries the same verdict',
    sweeps.snapshot('7d')?.coverage.kind === 'incomplete',
    String(sweeps.snapshot('7d')?.coverage.kind),
  );
  check(
    'and it names the backend it could not speak for, so removals can be withheld',
    withheldOf(settled).join(',') === 'cline',
    withheldOf(settled).join(','),
  );
  clock += 1;
  const reread = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: true,
    now: clock,
    startSweep: () => { throw new Error('a TTL hit must not start a sweep'); },
  }));
  check(
    'a TTL hit reports the coverage of the rows it is serving, not a default',
    coverageOf(reread) === 'incomplete',
    coverageOf(reread),
  );
}

// ── 12. A caller that cannot read coverage is never handed a partial ─────────
//
// Revision 23 added the completeness flag and, in the same change, the early
// answer that makes it necessary. A client from before the flag reads every
// roster as an authoritative replacement, so an early answer would show it the
// sessions nobody has looked for yet as sessions that have been deleted. It
// waits for the sweep instead -- older behaviour for older clients.
{
  const sweeps = cache();
  const { sweep, finish } = wedged();
  const startedAt = Date.now();
  let answered = false;
  const old = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: false,
    now: startedAt,
    startSweep: sweep,
  }).then((answer) => { answered = true; return answer; });
  await sleep(5);
  sweeps.seedLeg('7d', startedAt, () => [row('omp-1')]);
  await sleep(PARTIAL_MS * 2);
  check(
    'a caller that cannot read coverage is not answered from a partial snapshot',
    answered === false,
    `answered=${answered}`,
  );

  // ...and not through the TTL either. The partial is fresh by the clock, which
  // is exactly how it would reach a SECOND such caller moments later.
  const viaTtl = sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: false,
    now: Date.now(),
    startSweep: () => { throw new Error('a joiner must never start a second sweep'); },
  });
  let ttlAnswered = false;
  void viaTtl.then(() => { ttlAnswered = true; });
  await sleep(PARTIAL_MS);
  check(
    'and a fresh-by-the-clock partial does not reach it through the TTL',
    ttlAnswered === false,
    `answered=${ttlAnswered}`,
  );

  finish([row('omp-1'), row('cline-1')]);
  const settled = await within(old);
  check(
    'it receives the whole sweep once it lands',
    rowsOf(settled).length === 2 && coverageOf(settled) === 'complete',
    `${JSON.stringify(rowsOf(settled))} ${coverageOf(settled)}`,
  );
  await within(viaTtl);
}

// ── 13. ...but a SETTLED incomplete roster is served to everyone ─────────────
//
// That state can persist for as long as an adapter stays slow, so withholding
// it would mean never answering such a caller at all. It is also what the broker
// has served all along: `complete: false` names a condition that already
// existed, it does not create one.
{
  let clock = 90_000;
  const sweeps = cache(() => clock);
  sweeps.publish(
    '7d',
    { rows: [row('omp-1')], coverage: { kind: 'incomplete', withheld: ['cline'] } },
    clock,
  );
  const served = await within(sweeps.read({
    key: '7d',
    force: false,
    allowSweeping: false,
    now: clock,
    startSweep: () => { throw new Error('a TTL hit must not start a sweep'); },
  }));
  check(
    'a settled incomplete roster is served even to a caller that cannot read coverage',
    rowsOf(served).length === 1 && coverageOf(served) === 'incomplete',
    `${JSON.stringify(rowsOf(served))} ${coverageOf(served)}`,
  );
}

// ── 14. A carry is not a reading ────────────────────────────────────────────
//
// The row count of an abandoned or failed leg comes from `carryLastGood`: the
// rows of the last sweep that actually read the adapter. A non-empty carry looks
// exactly like a healthy leg in the sweep breakdown, and treating it as one is
// worse than the empty case, not better -- an empty carry removes the adapter's
// rows visibly, while a stale one removes only the rows that appeared since,
// which is precisely the set a user is most likely to be looking at.
{
  check(
    'a leg that finished normally is confirmed',
    unconfirmedBackends([{ id: 'omp', rows: 149, abandoned: false, failed: false }]).length === 0,
  );
  check(
    'an abandoned leg is unconfirmed even with a full carry',
    JSON.stringify(unconfirmedBackends([
      { id: 'omp', rows: 149, abandoned: false, failed: false },
      { id: 'cline', rows: 148, abandoned: true, failed: false },
    ])) === '["cline"]',
    JSON.stringify(unconfirmedBackends([
      { id: 'omp', rows: 149, abandoned: false, failed: false },
      { id: 'cline', rows: 148, abandoned: true, failed: false },
    ])),
  );
  check(
    'and so is one that threw',
    JSON.stringify(unconfirmedBackends([
      { id: 'reasonix', rows: 146, abandoned: false, failed: true },
    ])) === '["reasonix"]',
  );
  check(
    'a leg that returned nothing but finished is still confirmed',
    unconfirmedBackends([{ id: 'dsh', rows: 0, abandoned: false, failed: false }]).length === 0,
    'an adapter with no sessions is an answer, not a silence',
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
