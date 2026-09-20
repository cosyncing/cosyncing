#!/usr/bin/env bun
/**
 * Standalone Tokdash usage-report aggregation contract.
 *
 * The report is the one broker surface that reads a user's whole history, so this suite pins the
 * properties that make that safe and honest rather than merely working: `display_name` cannot reach
 * the wire even if Tokdash starts serving it, the period total travels beside the facet rows so the
 * coverage gap is computable, an older Tokdash degrades to a report without facets instead of no
 * report, and the window cache is keyed, bounded and expiring.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import {
  checkTokdashReportWindow,
  fetchTokdashReport,
  isTokdashReportDate,
  isTokdashVersionBelowMinimum,
  TokdashReportCache,
  TOKDASH_MINIMUM_VERSION,
  TOKDASH_REPORT_FACETS,
  TOKDASH_REPORT_WINDOW_FLOOR,
  withoutProjectNames,
} from '../../src/installation/tokdash-report.ts';
import { TokdashReportService } from '../../src/installation/tokdash-report-service.ts';
import {
  TOKDASH_REPORT_STORE_MAX_AGE_MS,
  brokerLocalToday,
  fetchTokdashPricingIdentity,
  isClosedTokdashReportWindow,
  isPersistableTokdashReport,
  isStorableTokdashReportWindow,
  TokdashReportStore,
  tokdashReportStoreFingerprint,
  TOKDASH_REPORT_STORE_MAX_SPAN_DAYS,
  TOKDASH_REPORT_STORE_REVISION,
} from '../../src/installation/tokdash-report-store.ts';
import {
  activeTimeFixture as activeTimeBody,
  insightsFixture as insightsBody,
  SAMPLE_WINDOW,
  stubTokdash as stubFetch,
  usageFixture as usageBody,
  versionFixture as versionBody,
  type FixtureAnswer,
} from '../fixtures/tokdash-report-fixtures.ts';

let failures = 0;
let passes = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name} - ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const WINDOW = SAMPLE_WINDOW;

await test('report window rejects malformed, impossible and inverted dates', async () => {
  assert.equal(isTokdashReportDate('2026-08-01'), true);
  assert.equal(isTokdashReportDate('2026-2-1'), false);
  assert.equal(isTokdashReportDate('2026-02-30'), false, 'an impossible day is not a date');
  assert.equal(isTokdashReportDate('not-a-date'), false);
  assert.equal(isTokdashReportDate(20260801), false);

  const { fetch: upstream, calls } = stubFetch();
  await assert.rejects(
    () => fetchTokdashReport(undefined, { from: '2026-13-01', to: '2026-08-31' }, { fetch: upstream }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => fetchTokdashReport(undefined, { from: '2026-08-31', to: '2026-08-01' }, { fetch: upstream }),
    /must not be after/,
  );
  assert.deepEqual(calls, [], 'a refused window never reaches Tokdash');
});

await test('one window costs exactly four GETs, and no /api/sessions fan-out', async () => {
  const { fetch: upstream, calls } = stubFetch();
  await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.equal(calls.length, 4, `expected 4 upstream reads, got ${calls.length}: ${calls.join(', ')}`);
  assert.equal(calls.filter((url) => url.includes('/api/sessions')).length, 0);
  const insights = calls.find((url) => url.includes('/api/insights'));
  assert.ok(insights, 'the composite insights scan is requested');
  for (const name of TOKDASH_REPORT_FACETS) {
    assert.ok(insights.includes(name), `insights scan requests the ${name} facet`);
  }
  assert.ok(calls.some((url) => url.endsWith('/api/version')), 'the running version is read');
  // The version read is about the instance, not about a window, so it carries no date bounds — and
  // it must not, or the per-window cache would be reading a different resource for every period.
  for (const url of calls.filter((candidate) => !candidate.endsWith('/api/version'))) {
    assert.ok(url.includes('date_from=2026-08-01'), url);
    assert.ok(url.includes('date_to=2026-08-31'), url);
  }
});

await test('the period total travels beside the facet rows so the coverage gap is computable', async () => {
  const { fetch: upstream } = stubFetch();
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.equal(report.totals.tokens, 19_893_991_786);
  assert.equal(report.totals.requests, 129_030);
  assert.ok(report.projects, 'the projects facet is carried');

  const rowTokens = report.projects.rows.reduce((sum, row) => sum + row.tokens, 0);
  const unattributed = report.projects.unattributed?.tokens ?? 0;
  const gap = report.totals.tokens - rowTokens - unattributed;
  // The whole point of serving the total: this gap is real and an order of magnitude larger than
  // the in-facet unattributed bucket, which is all an earlier draft printed.
  assert.ok(gap > 0, 'the fixture reproduces a facet that does not cover the period');
  assert.ok(gap > unattributed, 'the uncovered gap dwarfs the in-facet remainder');
  assert.ok(
    Math.abs(rowTokens + unattributed + gap - report.totals.tokens) < 1e-6,
    'the three components sum to the period total',
  );
});

await test('display_name never reaches the serialized DTO, even when Tokdash serves it', async () => {
  const contaminated = insightsBody({
    projects: {
      projects: [
        { project: 'atlas', tokens: 7_771_744_344, cost: 5_882.03, messages: 36_771, display_name: 'fix the login race before the demo' },
      ],
      unattributed: { tokens: 153_435_350, cost: 17.44, messages: 1_376, display_name: 'another prompt' },
      attributed_project_count: 41,
      names_included: true,
      display_name: 'facet-level prompt text',
    },
    daily: [{ date: '2026-08-01', tokens: 1, cost: 0, messages: 1, intensity: 1, display_name: 'daily prompt' }],
  });
  const { fetch: upstream } = stubFetch({
    usage: usageBody({ display_name: 'top-level prompt text' }),
    activeTime: activeTimeBody({ by_tool: { claude: { tool_label: 'Claude Code', session_count: 1, active_ms: 1, display_name: 'tool prompt' } } }),
    insights: contaminated,
  });

  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  const serialized = JSON.stringify(report);

  // Asserted on the serialized DTO, not on a field read: the guarantee is that nothing can carry it
  // through, which a spread-based assembler would break silently.
  assert.equal(serialized.includes('display_name'), false, 'no display_name key survives');
  assert.equal(serialized.includes('fix the login race'), false, 'no prompt text survives');
  assert.equal(serialized.includes('facet-level prompt text'), false);
  assert.equal(serialized.includes('top-level prompt text'), false);
  assert.equal(serialized.includes('daily prompt'), false);
  assert.equal(serialized.includes('tool prompt'), false);
  // The surrounding data still arrived, so the scrub is selective rather than a dropped facet.
  assert.equal(report.projects?.rows[0]?.project, 'atlas');
});

await test('an older Tokdash without /api/insights still serves a report, minus its facets', async () => {
  const { fetch: upstream } = stubFetch({ insights: 404 });
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.equal(report.insightsUnavailable, 'unsupported');
  assert.equal(report.hourly, null);
  assert.equal(report.weekday, null);
  assert.equal(report.daily, null);
  assert.equal(report.projects, null);
  assert.equal(report.streaks, null);
  assert.equal(report.firsts, null);
  assert.equal(report.coverage, null);
  assert.equal(report.timezone, null);
  // The parts that do not depend on the scan are untouched.
  assert.equal(report.totals.tokens, 19_893_991_786);
  assert.equal(report.tools.length, 3);
  assert.equal(report.topModelsByTokens[0]?.name, 'claude-opus-5');
  assert.equal(report.activeTime?.activeMs, 1_453_366_891);
});

await test('a broken insights scan is distinguished from an absent one', async () => {
  const unavailable = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch({ insights: 500 }).fetch });
  assert.equal(unavailable.insightsUnavailable, 'unavailable');

  const malformed = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({ insights: [] as unknown as Record<string, unknown> }).fetch,
  });
  assert.equal(malformed.insightsUnavailable, 'malformed');
  assert.equal(malformed.hourly, null);
});

await test('a failed active-time read em-dashes its cells instead of inventing zeros', async () => {
  const { fetch: upstream } = stubFetch({ activeTime: 'fail' });
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.equal(report.activeTime, null);
  for (const tool of report.tools) {
    assert.equal(tool.sessions, null, `${tool.tool} sessions`);
    assert.equal(tool.activeMs, null, `${tool.tool} active time`);
    assert.equal(tool.label, null, `${tool.tool} label`);
  }
  // Token figures come from /api/usage and are unaffected.
  assert.equal(report.tools[0]?.tokens, 10_088_964_020);
});

await test('a failed usage read fails the whole report rather than serving a wrong denominator', async () => {
  const { fetch: upstream, calls } = stubFetch({ usage: 'fail' });
  await assert.rejects(() => fetchTokdashReport(undefined, WINDOW, { fetch: upstream }), /HTTP 500/);
  assert.deepEqual(calls, [`http://127.0.0.1:55423/api/usage?date_from=2026-08-01&date_to=2026-08-31`]);
});

await test('missing totals are refused, not defaulted to zero', async () => {
  const { fetch: upstream } = stubFetch({ usage: usageBody({ total_tokens: null }) });
  await assert.rejects(() => fetchTokdashReport(undefined, WINDOW, { fetch: upstream }), /total_tokens/);
});

await test('tools merge the three upstream views and keep coding membership', async () => {
  const { fetch: upstream } = stubFetch();
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.deepEqual(report.tools.map((tool) => tool.tool), ['claude', 'codex', 'openclaw']);
  const claude = report.tools[0]!;
  assert.equal(claude.label, 'Claude Code', 'the label comes from the active-time API');
  assert.equal(claude.sessions, 119);
  assert.equal(claude.requests, 44_456, 'the request count comes from coding_apps');
  assert.equal(claude.tokensOut, 27_831_586);
  assert.equal(claude.coding, true);

  // openclaw is in by_tool only: real tokens, and every coding_apps/active-time cell em-dashed.
  const openclaw = report.tools[2]!;
  assert.equal(openclaw.tokens, 777_870_272);
  assert.equal(openclaw.coding, false);
  assert.equal(openclaw.requests, null);
  assert.equal(openclaw.sessions, null);
  assert.equal(openclaw.tokensOut, null);
});

await test('range.recognized is carried, and absent means unrecognized', async () => {
  const recognized = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch().fetch });
  assert.equal(recognized.range.recognized, true);
  assert.equal(recognized.range.days, 31);
  assert.equal(recognized.range.periodResolved, 'custom');

  const silent = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({
      usage: usageBody({ range: { from: '2026-08-01', to: '2026-08-31' } }),
      insights: insightsBody({ range: { from: '2026-08-01', to: '2026-08-31' } }),
    }).fetch,
  });
  assert.equal(silent.range.recognized, false, 'an unpublished verdict is never read as agreement');
});

await test('the running Tokdash version is carried, and the floor is judged against it', async () => {
  const current = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch().fetch });
  assert.equal(current.runtime.version, '2.5.3');
  assert.equal(current.runtime.minimumVersion, TOKDASH_MINIMUM_VERSION);
  assert.equal(current.runtime.belowMinimum, false, 'a build above the floor clears it');

  const exact = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({ version: versionBody({ runtime_version: TOKDASH_MINIMUM_VERSION }) }).fetch,
  });
  assert.equal(exact.runtime.belowMinimum, false, 'the floor itself is not below the floor');

  // The measured macOS host: 2.0.0 honours the window and answers correct totals, and publishes no
  // verdict at all because the field postdates it.
  const old = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({
      version: versionBody({ runtime_version: '2.0.0', install_method: 'pipx' }),
      usage: usageBody({ range: { from: '2026-08-01', to: '2026-08-31' } }),
      insights: 404,
    }).fetch,
  });
  assert.equal(old.runtime.version, '2.0.0');
  assert.equal(old.runtime.belowMinimum, true);
  assert.equal(old.range.recognized, false);
  assert.equal(old.insightsUnavailable, 'unsupported');
  assert.equal(old.totals.tokens, 19_893_991_786, 'the totals are still read and still correct');
});

await test('an unreadable version fails closed to below the floor', async () => {
  const cases: Array<[string, FixtureAnswer]> = [
    ['no /api/version route at all', 404],
    ['a body with no runtime_version', { service: 'tokdash' }],
    ['a version that is not a version', versionBody({ runtime_version: 'nightly' })],
    ['something else holding the port', { service: 'not-tokdash', runtime_version: '9.9.9' }],
  ];
  for (const [label, answer] of cases) {
    const report = await fetchTokdashReport(undefined, WINDOW, {
      fetch: stubFetch({ version: answer }).fetch,
    });
    assert.equal(report.runtime.version, null, label);
    assert.equal(report.runtime.belowMinimum, true, label);
  }
});

await test('the version read never costs the report', async () => {
  // A `/api/version` that hangs past the budget or answers garbage must not turn a readable window
  // into a failure: the figures come from `/api/usage`, and the version only labels them.
  const report = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({ version: 500 }).fetch,
  });
  assert.equal(report.totals.tokens, 19_893_991_786);
  assert.equal(report.runtime.belowMinimum, true);
  assert.ok(report.hourly, 'the facets are untouched by a failed version read');
});

await test('a current Tokdash that refuses a period is not reported as an old one', async () => {
  // The two states the client must tell apart. Same `recognized: false`, different cause, different
  // next move for the reader — and only the version says which.
  const refused = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({
      usage: usageBody({ range: { from: '2026-08-01', to: '2026-08-31', recognized: false } }),
      insights: insightsBody({ range: { from: '2026-08-01', to: '2026-08-31', recognized: false } }),
    }).fetch,
  });
  assert.equal(refused.range.recognized, false);
  assert.equal(refused.runtime.belowMinimum, false, 'a current Tokdash keeps the period explanation');
});

await test('version comparison orders releases numerically, not lexically', () => {
  assert.equal(isTokdashVersionBelowMinimum('2.10.0'), false, '2.10 is above 2.5, not below it');
  assert.equal(isTokdashVersionBelowMinimum('2.4.9'), true);
  assert.equal(isTokdashVersionBelowMinimum('2.5'), false, 'a missing patch reads as zero');
  assert.equal(isTokdashVersionBelowMinimum('3.0.0'), false);
  assert.equal(isTokdashVersionBelowMinimum('v2.5.0'), false, 'a leading v is decoration');
  assert.equal(isTokdashVersionBelowMinimum('2.5.0-rc.1'), false, 'a prerelease of the floor is the floor');
  assert.equal(isTokdashVersionBelowMinimum(null), true);
  assert.equal(isTokdashVersionBelowMinimum('2.5.0.1'), false, 'a fourth component is tolerated');
});

await test('the night window is served, never assumed', async () => {
  const served = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch().fetch });
  assert.deepEqual(served.hourly?.nightHours, [22, 23, 0, 1]);

  const moved = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({
      insights: insightsBody({
        hourly: { buckets: [{ hour: 3, tokens: 5, cost: 1, messages: 2 }], peak_hour: 3, night_share: 0.5, night_hours: [1, 2, 3] },
      }),
    }).fetch,
  });
  assert.deepEqual(moved.hourly?.nightHours, [1, 2, 3], 'a different served window is carried verbatim');
  assert.equal(moved.hourly?.peakHour, 3);
});

await test('the heatmap rank is the served intensity, not a recomputation', async () => {
  const { fetch: upstream } = stubFetch({
    insights: insightsBody({
      // A day with far fewer tokens carries the higher served rank. Any client- or broker-side
      // bucketing by magnitude would contradict it, and the tokdash dashboard would disagree.
      daily: [
        { date: '2026-08-01', tokens: 1_000_000_000, messages: 10, cost: 1, intensity: 1 },
        { date: '2026-08-02', tokens: 5, messages: 1, cost: 0, intensity: 4 },
      ],
    }),
  });
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  assert.deepEqual(report.daily?.map((day) => [day.date, day.intensity]), [
    ['2026-08-01', 1],
    ['2026-08-02', 4],
  ]);
});

await test('coverage counts the served source lists rather than a remembered total', async () => {
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch().fetch });
  assert.equal(report.coverage?.sourceCount, 5, '3 stored + 2 live');
  assert.deepEqual(report.coverage?.liveSources, ['kilocode', 'mimo']);

  const drifted = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({ insights: insightsBody({ coverage: { stored_sources: ['claude'], live_sources: [] } }) }).fetch,
  });
  assert.equal(drifted.coverage?.sourceCount, 1);
});

await test('source errors are carried so a partial window says so', async () => {
  const report = await fetchTokdashReport(undefined, WINDOW, {
    fetch: stubFetch({ usage: usageBody({ source_errors: ['kimi', 'grok'] }) }).fetch,
  });
  assert.deepEqual(report.sourceErrors, ['kimi', 'grok']);
});

await test('the window cache is keyed per range, expires, and stays bounded', () => {
  let clock = 1_000;
  const cache = new TokdashReportCache({ ttlMs: 500, maxEntries: 2, now: () => clock });
  const report = (tokens: number) => ({ totals: { tokens } }) as never;

  cache.set({ from: '2026-08-01', to: '2026-08-31' }, report(1));
  cache.set({ from: '2026-01-01', to: '2026-09-01' }, report(2));

  assert.equal(cache.get({ from: '2026-08-01', to: '2026-08-31' })?.report.totals.tokens, 1);
  assert.equal(cache.get({ from: '2026-01-01', to: '2026-09-01' })?.report.totals.tokens, 2);
  assert.equal(cache.get({ from: '2026-08-01', to: '2026-08-30' }), undefined, 'a different window is a different key');

  // Recency tracks reads, not writes: touching August last makes January the eviction candidate,
  // so a user flipping back to a window they are actually using does not lose it to a newer one.
  assert.equal(cache.get({ from: '2026-08-01', to: '2026-08-31' })?.report.totals.tokens, 1);
  cache.set({ from: '2026-07-01', to: '2026-07-31' }, report(3));
  assert.equal(cache.size, 2);
  assert.equal(cache.get({ from: '2026-01-01', to: '2026-09-01' }), undefined, 'the least recently read window is evicted');
  assert.equal(cache.get({ from: '2026-08-01', to: '2026-08-31' })?.report.totals.tokens, 1);

  clock += 500;
  assert.equal(cache.get({ from: '2026-08-01', to: '2026-08-31' }), undefined, 'entries expire at the TTL');
});

await test('a cached window is not re-read from Tokdash', async () => {
  const { fetch: upstream, calls } = stubFetch();
  const cache = new TokdashReportCache({ ttlMs: 60_000, now: () => 0 });

  const first = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  cache.set(WINDOW, first);
  assert.equal(calls.length, 4);

  const hit = cache.get(WINDOW);
  assert.ok(hit);
  assert.equal(hit.report.totals.tokens, first.totals.tokens);
  assert.equal(calls.length, 4, 'a cache hit costs no upstream reads');
});

await test('concurrent readers of one window share a single upstream scan', async () => {
  const { fetch: upstream, calls } = stubFetch();
  const cache = new TokdashReportCache({ ttlMs: 60_000, now: () => 0 });
  let loads = 0;
  const loader = () => {
    loads++;
    return fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  };

  // Started together, before any of them can have finished: this is the shape that made Tokdash
  // refuse the second caller with a 503 while the first one succeeded.
  const [first, second, third] = await Promise.all([
    cache.load(WINDOW, loader),
    cache.load(WINDOW, loader),
    cache.load(WINDOW, loader),
  ]);

  assert.equal(loads, 1, 'one upstream scan serves every concurrent caller');
  assert.equal(calls.length, 4, 'four GETs total, not twelve');
  assert.equal(first.servedFromCache, false, 'the caller that started the scan says so');
  assert.equal(second.servedFromCache, true);
  assert.equal(third.servedFromCache, true);
  for (const result of [first, second, third]) {
    assert.equal(result.entry.report.totals.tokens, 19_893_991_786);
  }

  // The settled window is now a plain cache hit and costs nothing more.
  const later = await cache.load(WINDOW, loader);
  assert.equal(loads, 1);
  assert.equal(later.servedFromCache, true);
});

await test('a failed scan is not cached and does not poison the next reader', async () => {
  const cache = new TokdashReportCache({ ttlMs: 60_000, now: () => 0 });
  let attempt = 0;
  const loader = () => {
    attempt++;
    const stub = attempt === 1 ? stubFetch({ usage: 'fail' }) : stubFetch();
    return fetchTokdashReport(undefined, WINDOW, { fetch: stub.fetch });
  };

  await assert.rejects(() => cache.load(WINDOW, loader), /HTTP 500/);
  assert.equal(cache.size, 0, 'a failure leaves no entry behind');

  // A transient upstream failure must not be remembered as this window's answer.
  const recovered = await cache.load(WINDOW, loader);
  assert.equal(attempt, 2, 'the next reader retries rather than replaying the failure');
  assert.equal(recovered.entry.report.totals.tokens, 19_893_991_786);
});

await test('a non-loopback Tokdash override is refused without echoing the value', async () => {
  const { fetch: upstream, calls } = stubFetch();
  await assert.rejects(
    () => fetchTokdashReport('http://user:secret@evil.example/api', WINDOW, { fetch: upstream }),
    (error: Error) => {
      assert.equal(error.message.includes('secret'), false, 'the refused value is never echoed');
      return /Invalid Tokdash URL/.test(error.message);
    },
  );
  assert.deepEqual(calls, []);
});

await test('a well-formed window is still bounded in span', async () => {
  const today = '2026-09-02';
  assert.equal(checkTokdashReportWindow({ from: '2026-08-01', to: '2026-08-31' }, today), null);

  // The window the reviewer reached for: every date is real, the order is right, and it costs a
  // full upstream scan over everything Tokdash has ever recorded.
  assert.equal(
    checkTokdashReportWindow({ from: '0001-01-01', to: '9999-12-31' }, today),
    'range-too-early',
  );
  assert.equal(checkTokdashReportWindow({ from: '2026-08-31', to: '2026-08-01' }, today),
    'range-inverted');
  assert.equal(checkTokdashReportWindow({ from: '2026-01-01', to: '2027-01-01' }, today),
    'range-in-future');
});

await test('the bound accommodates the client\'s own all-time window', async () => {
  // The floor is not a guess. `usageAllTimeFloor` in usage_period.dart is this exact day, and the
  // all-time period is the widest window the product asks for: a broker that refused it would
  // refuse its own client rather than an abusive caller.
  assert.equal(TOKDASH_REPORT_WINDOW_FLOOR, '2000-01-01');
  assert.equal(
    checkTokdashReportWindow({ from: TOKDASH_REPORT_WINDOW_FLOOR, to: '2026-09-02' }, '2026-09-02'),
    null,
  );

  // A client one timezone ahead asks for a day the broker has not reached. That is not abuse.
  assert.equal(checkTokdashReportWindow({ from: '2026-09-01', to: '2026-09-03' }, '2026-09-02'),
    null);
  assert.equal(checkTokdashReportWindow({ from: '2026-09-01', to: '2026-09-04' }, '2026-09-02'),
    'range-in-future');
});

await test('distinct windows queue behind the scan cap instead of fanning out', async () => {
  const cache = new TokdashReportCache({ maxConcurrentScans: 2 });
  let peakConcurrent = 0;
  let running = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });

  const started = [0, 1, 2, 3, 4].map((index) => cache.load(
    { from: `2026-0${index + 1}-01`, to: `2026-0${index + 1}-28` },
    async () => {
      running += 1;
      peakConcurrent = Math.max(peakConcurrent, running);
      await gate;
      running -= 1;
      const { fetch: upstream } = stubFetch();
      return fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
    },
  ));

  // Five callers are already in flight; only the cap decides how many reach Tokdash.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.runningScans, 2, 'the cap holds while every caller is waiting');
  assert.equal(cache.queuedScans, 3, 'the rest queue rather than fan out');

  open();
  await Promise.all(started);

  assert.equal(peakConcurrent, 2, 'five distinct windows never scanned more than twice at once');
  assert.equal(cache.runningScans, 0, 'every slot is returned');
  assert.equal(cache.queuedScans, 0, 'nothing is left waiting');
});

await test('a queued window that arrives already cached spends no scan', async () => {
  const cache = new TokdashReportCache({ maxConcurrentScans: 1 });
  const blocker: (() => void)[] = [];
  let scans = 0;
  const load = (from: string) => cache.load({ from, to: '2026-08-31' }, async () => {
    scans += 1;
    await new Promise<void>((resolve) => blocker.push(resolve));
    const { fetch: upstream } = stubFetch();
    return fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  });

  const first = load('2026-08-01');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = load('2026-08-02');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // While the queued window waits, its answer arrives by another route.
  const { fetch: upstream } = stubFetch();
  cache.set({ from: '2026-08-02', to: '2026-08-31' },
    await fetchTokdashReport(undefined, WINDOW, { fetch: upstream }));

  blocker.shift()!();
  await first;
  await queued;
  assert.equal(scans, 1, 'the queued caller read the stored entry instead of scanning');
});

await test('project names can be withheld without withholding the report', async () => {
  const { fetch: upstream } = stubFetch();
  const owner = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  assert.ok((owner.projects?.rows.length ?? 0) > 0, 'the owner sees named projects');
  assert.equal(owner.projectsUnavailable, null);

  const observer = withoutProjectNames(owner);
  assert.equal(observer.projects, null, 'the names are gone');
  assert.equal(observer.projectsUnavailable, 'owner-only', 'and the reason is said, not inferred');

  // Everything that is a count survives: the narrowing is the Amber facet, not the report.
  assert.equal(observer.totals.tokens, owner.totals.tokens);
  assert.deepEqual(observer.tools, owner.tools);
  assert.deepEqual(observer.daily, owner.daily);
  assert.deepEqual(observer.hourly, owner.hourly);
  assert.equal(observer.insightsUnavailable, null, 'withholding is not a facet failure');

  // The owner's own copy is never the one that got trimmed.
  assert.ok((owner.projects?.rows.length ?? 0) > 0);

  // No project name survives anywhere in the observer's serialized answer.
  const names = owner.projects!.rows.map((row) => row.project);
  assert.ok(names.length > 0);
  const wire = JSON.stringify(observer);
  for (const name of names) {
    assert.equal(wire.includes(name), false, `withheld report still carries ${name}`);
  }
});

await test('withholding a report that never had projects changes nothing', async () => {
  const { fetch: upstream } = stubFetch({ insights: 404 });
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
  assert.equal(report.projects, null);

  // An older Tokdash already served no facets. Calling that "owner-only" would blame the caller's
  // scope for an upstream limitation and send the client to the wrong notice.
  const withheld = withoutProjectNames(report);
  assert.equal(withheld.projectsUnavailable, null);
  assert.equal(withheld.insightsUnavailable, 'unsupported');
});

await test('the scan cap holds through the hand-off gap', async () => {
  const cache = new TokdashReportCache({ maxConcurrentScans: 2 });
  let running = 0;
  let peak = 0;
  const readings: number[] = [];

  const load = (index: number) => cache.load(
    { from: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`, to: '2026-12-31' },
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      readings.push(cache.runningScans);
      await Promise.resolve();
      running -= 1;
      const { fetch: upstream } = stubFetch();
      return fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
    },
  );

  const started: Promise<unknown>[] = [];
  for (let index = 0; index < 24; index += 1) {
    started.push(load(index));
    // Arriving continuously rather than all at once is the point: a caller that
    // lands between a release and the woken waiter's continuation is exactly the
    // window in which a slot could be counted twice.
    await Promise.resolve();
  }
  await Promise.all(started);

  assert.equal(peak <= 2, true, `peak concurrent scans was ${peak}`);
  assert.equal(Math.max(...readings) <= 2, true, `cap read ${Math.max(...readings)}`);
  assert.equal(cache.runningScans, 0, 'every slot is accounted for');
  assert.equal(cache.queuedScans, 0, 'nothing is left waiting');
});

// ---------------------------------------------------------------------------
// The durable store for windows that have ended.
// ---------------------------------------------------------------------------

const storeRoot = mkdtempSync(join(tmpdir(), 'cosyncing-tokdash-report-store-'));
let storeSeq = 0;
/** A store on its own file, so one case cannot read another's. */
function storeAt(
  options: { maxEntries?: number; now?: () => number; file?: string } = {},
): { store: TokdashReportStore; file: string } {
  const file = options.file ?? join(storeRoot, `store-${(storeSeq += 1)}.json`);
  return {
    file,
    store: new TokdashReportStore({
      path: file,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}

const sampleReport = await (async () => {
  const { fetch: upstream } = stubFetch();
  return fetchTokdashReport(undefined, WINDOW, { fetch: upstream });
})();

const FP = tokdashReportStoreFingerprint(sampleReport.runtime.version, 'baseline:2.0.25')!;

await test('the day a window is judged against is the local one', () => {
  // Local components, zero-padded. A Tokdash day is a local day, so a broker
  // west of UTC must not call this evening's window finished because UTC has
  // already rolled over.
  assert.equal(brokerLocalToday(new Date(2026, 8, 19, 23, 30)), '2026-09-19');
  assert.equal(brokerLocalToday(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
  const late = new Date(2026, 8, 19, 23, 30);
  assert.equal(
    isClosedTokdashReportWindow({ from: '2026-09-01', to: '2026-09-19' }, brokerLocalToday(late)),
    false,
    'the window the host is still writing into is not finished',
  );
});

await test('only a window that has ended is treated as finished', () => {
  // The window the reader is inside is still taking writes; one that ended is
  // eligible for bounded historical caching.
  assert.equal(isClosedTokdashReportWindow({ from: '2026-08-01', to: '2026-08-31' }, '2026-09-19'), true);
  assert.equal(isClosedTokdashReportWindow({ from: '2026-09-01', to: '2026-09-19' }, '2026-09-19'), false);
  assert.equal(isClosedTokdashReportWindow({ from: '2026-09-01', to: '2026-09-20' }, '2026-09-19'), false);
});

await test('an unbounded span is served but never kept', () => {
  const today = '2026-09-19';
  // The route bounds a window's ends, not its length, so this is a legal
  // request any paired device can make. Keeping it forever is the part refused.
  assert.equal(
    isStorableTokdashReportWindow({ from: '2000-01-01', to: '2026-09-18' }, today),
    false,
    'a 26-year window is not durable state',
  );
  // A full past year is the widest thing the client can ask for and close.
  assert.equal(isStorableTokdashReportWindow({ from: '2025-01-01', to: '2025-12-31' }, today), true);
  assert.equal(isStorableTokdashReportWindow({ from: '2026-08-01', to: '2026-08-31' }, today), true);
  // Still subject to closedness.
  assert.equal(isStorableTokdashReportWindow({ from: '2026-09-01', to: '2026-09-19' }, today), false);
  // Exactly at the bound, and one day past it.
  const from = new Date(Date.UTC(2025, 0, 1));
  const atCap = new Date(from.getTime() + (TOKDASH_REPORT_STORE_MAX_SPAN_DAYS - 1) * 86_400_000);
  const overCap = new Date(from.getTime() + TOKDASH_REPORT_STORE_MAX_SPAN_DAYS * 86_400_000);
  const iso = (value: Date): string => value.toISOString().slice(0, 10);
  assert.equal(isStorableTokdashReportWindow({ from: '2025-01-01', to: iso(atCap) }, today), true);
  assert.equal(isStorableTokdashReportWindow({ from: '2025-01-01', to: iso(overCap) }, today), false);
});

await test('a report with a hole in it is never made permanent', () => {
  // `fetchTokdashReport` does not throw when its optional reads fail, so a shed
  // scan produces a valid-looking DTO. In memory that degrades for five
  // minutes; on disk it would be this window's answer for months, and the
  // reader has no way to refresh a file.
  assert.equal(isPersistableTokdashReport(sampleReport), true, 'the whole fixture report is keepable');

  assert.equal(
    isPersistableTokdashReport({ ...sampleReport, insightsUnavailable: 'unavailable' }),
    false,
    'a shed facet scan renders every chart null',
  );
  assert.equal(
    isPersistableTokdashReport({
      ...sampleReport,
      runtime: { version: null, minimumVersion: TOKDASH_MINIMUM_VERSION, belowMinimum: true },
    }),
    false,
    'an unread version paints the client\'s upgrade page over the whole report',
  );
  assert.equal(
    isPersistableTokdashReport({ ...sampleReport, activeTime: null }),
    false,
    'an idle month still answers with a record of zeros, so null is a failed read',
  );
  assert.equal(
    isPersistableTokdashReport({ ...sampleReport, sourceErrors: ['codex'] }),
    false,
    'Tokdash itself says tokens are missing from the totals',
  );
});

await test('the store refuses to keep a degraded report', () => {
  const { store } = storeAt();
  store.write(WINDOW, { ...sampleReport, insightsUnavailable: 'unavailable' }, FP);
  assert.equal(store.read(WINDOW, FP), undefined, 'nothing was written');
  // Enforced in the store, not only at the call site, so no later caller can
  // put a hole on disk by forgetting the rule.
  store.write(WINDOW, sampleReport, FP);
  assert.notEqual(store.read(WINDOW, FP), undefined);
});

await test('pricing identity is the packaged baseline, or nothing', async () => {
  const answer = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  assert.equal(
    await fetchTokdashPricingIdentity(undefined, {
      fetch: answer({ source: 'baseline', baseline_version: '2.0.25' }),
    }),
    'baseline:2.0.25',
  );
  // An override is the user's own table, and nothing on the wire names its
  // contents. Declining to persist is the fail-closed direction: an override is
  // exactly when a stale cost is most wrong.
  assert.equal(
    await fetchTokdashPricingIdentity(undefined, {
      fetch: answer({ source: 'override', baseline_version: '2.0.25' }),
    }),
    null,
  );
  assert.equal(
    await fetchTokdashPricingIdentity(undefined, {
      fetch: answer({ source: 'baseline', baseline_version: 7 }),
    }),
    null,
  );
  assert.equal(
    await fetchTokdashPricingIdentity(undefined, { fetch: answer({}, 404) }),
    null,
  );
  assert.equal(
    await fetchTokdashPricingIdentity(undefined, {
      fetch: (async () => {
        throw new Error('unreachable');
      }) as unknown as typeof fetch,
    }),
    null,
  );
});

await test('an unidentifiable derivation has no fingerprint', () => {
  assert.equal(tokdashReportStoreFingerprint(null, 'baseline:2.0.25'), null);
  assert.equal(tokdashReportStoreFingerprint('2.5.7', null), null);
  const fingerprint = tokdashReportStoreFingerprint('2.5.7', 'baseline:2.0.25');
  assert.equal(typeof fingerprint, 'string');
  // Both halves and the revision are named, so none of the three can change
  // without the stored windows being dropped.
  assert.equal(fingerprint?.includes('2.5.7'), true);
  assert.equal(fingerprint?.includes('baseline:2.0.25'), true);
  assert.equal(fingerprint?.includes(`r${TOKDASH_REPORT_STORE_REVISION}`), true);
});

await test('a stored window comes back with the time it was read', () => {
  const { store, file } = storeAt({ now: () => 1_789_776_000_000 });
  assert.equal(store.read(WINDOW, FP), undefined, 'nothing is stored yet');

  store.write(WINDOW, sampleReport, FP);
  const stored = store.read(WINDOW, FP);
  assert.notEqual(stored, undefined);
  assert.equal(stored?.storedAt, 1_789_776_000_000);
  assert.deepEqual(stored?.report.totals, sampleReport.totals);
  // Read back through a second instance on the same file: the point of the
  // store is surviving the process that wrote it.
  const reopened = storeAt({ file, now: () => 1_789_776_000_000 }).store;
  assert.notEqual(reopened.read(WINDOW, FP), undefined);
  assert.equal(reopened.read(WINDOW, FP)?.storedAt, 1_789_776_000_000);
});

await test('a different derivation drops every stored window', () => {
  const { store, file } = storeAt();
  store.write(WINDOW, sampleReport, FP);

  // A pricing edit or a Tokdash upgrade moves the fingerprint. Entries written
  // under the old one are not mixed in with the new: they go.
  const moved = storeAt({ file }).store;
  const other = tokdashReportStoreFingerprint(sampleReport.runtime.version, 'baseline:2.0.26')!;
  assert.equal(moved.read(WINDOW, other), undefined);
  moved.write(WINDOW, sampleReport, other);
  assert.equal(moved.size(other), 1, 'the file is replaced, not appended to');
  assert.equal(moved.size(FP), 0, 'and the old derivation is gone, not hidden');
});

await test('a request with no fingerprint neither reads nor writes', () => {
  const { store, file } = storeAt();
  store.write(WINDOW, sampleReport, null);
  assert.equal(store.read(WINDOW, null), undefined);
  // Nothing was written at all, so a later broker that CAN identify the
  // derivation does not find a file it has to reason about.
  const reopened = storeAt({ file }).store;
  assert.equal(reopened.size(FP), 0);
});

await test('eviction drops the least recently READ, not the oldest written', () => {
  const january = { from: '2026-01-01', to: '2026-01-31' };
  const february = { from: '2026-02-01', to: '2026-02-28' };
  const march = { from: '2026-03-01', to: '2026-03-31' };
  const { store } = storeAt({ maxEntries: 2 });
  store.write(january, { ...sampleReport, range: { ...sampleReport.range, ...january } }, FP);
  store.write(february, { ...sampleReport, range: { ...sampleReport.range, ...february } }, FP);

  // January is the oldest WRITE, but the reader keeps coming back to it. The
  // entry nothing has asked for is the one that should go.
  assert.notEqual(store.read(january, FP), undefined);
  store.write(march, { ...sampleReport, range: { ...sampleReport.range, ...march } }, FP);

  assert.equal(store.size(FP), 2);
  assert.notEqual(store.read(january, FP), undefined, 'the re-read window survives');
  assert.equal(store.read(february, FP), undefined, 'the untouched one is evicted');
});

await test('a file the broker did not write is a miss, never a throw', () => {
  for (const body of ['{ not json', '[]', '{"schemaVersion":99}', '{"schemaVersion":1}']) {
    const file = join(storeRoot, `damaged-${(storeSeq += 1)}.json`);
    writeFileSync(file, body);
    const store = storeAt({ file }).store;
    assert.equal(store.read(WINDOW, FP), undefined, body);
    // And it recovers: the next write replaces the file rather than refusing.
    store.write(WINDOW, sampleReport, FP);
    assert.notEqual(store.read(WINDOW, FP), undefined, body);
  }
});

await test('an entry of the wrong shape is dropped, not rendered as zeros', () => {
  // The revision constant is the intended guard against a DTO change, and it is
  // a line a human has to remember to move. The Dart decoder defaults every
  // missing field, so without this backstop a wrong-shaped entry renders as a
  // month of zeros on a page with no refresh.
  const file = join(storeRoot, `shapes-${(storeSeq += 1)}.json`);
  const entry = (from: string, report: unknown) => ({ from, to: WINDOW.to, storedAt: Date.now(), report });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      fingerprint: FP,
      entries: [
        entry('2026-01-01', {}),
        entry('2026-01-02', { ...sampleReport, totals: undefined }),
        entry('2026-01-03', { ...sampleReport, totals: { tokens: 'lots', cost: 1, requests: 1 } }),
        entry('2026-01-04', { ...sampleReport, range: undefined }),
        entry('2026-01-05', { ...sampleReport, runtime: undefined }),
        entry('2026-01-06', { ...sampleReport, tools: 'claude' }),
        { from: '2026-01-07', to: '2026-01-07', storedAt: 'yesterday', report: sampleReport },
        entry(WINDOW.from, sampleReport),
      ],
    }),
  );
  const store = storeAt({ file }).store;
  assert.equal(store.size(FP), 1, 'only the well-formed entry survives');
  assert.notEqual(store.read(WINDOW, FP), undefined);
});


await test('empty required upstream objects cannot become durable reports', async () => {
  for (const overrides of [{ insights: {} }, { activeTime: {} }, { insights: insightsBody({ projects: {} }) }]) {
    const report = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch(overrides).fetch });
    assert.equal(isPersistableTokdashReport(report), false);
    const { store } = storeAt();
    store.write(WINDOW, report, FP);
    assert.equal(store.read(WINDOW, FP), undefined);
  }
});

await test('a complete idle window is persistable without inventing activity', async () => {
  const report = await fetchTokdashReport(undefined, WINDOW, { fetch: stubFetch({
    usage: usageBody({ total_tokens: 0, total_cost: 0, total_messages: 0, by_tool: {}, coding_apps: {} }),
    activeTime: activeTimeBody({ active_ms: 0, active_ms_sum: 0, by_tool: {} }),
    insights: insightsBody({
      hourly: { buckets: [], peak_hour: null, night_share: null, night_hours: [] },
      weekday: { buckets: [], peak_weekday: null }, daily: [],
      projects: { projects: [], unattributed: { tokens: 0, cost: 0, messages: 0 }, attributed_project_count: 0, names_included: true },
      streaks: { current_streak: 0, longest_streak: 0, active_days: 0, total_days: 31 },
      firsts: { first_active_day: null, last_active_day: null, busiest_day: null, busiest_day_tokens: null },
    }),
  }).fetch });
  assert.equal(isPersistableTokdashReport(report), true);
  assert.deepEqual(report.daily, []);
  const { store } = storeAt(); store.write(WINDOW, report, FP);
  assert.equal(store.read(WINDOW, FP)?.report.totals.tokens, 0);
});

await test('disk reads reject degraded DTOs, malformed rows, wrong ranges and old schemas', () => {
  const corruptions = [
    (r: any) => { delete r.runtime.version; },
    (r: any) => { r.insightsUnavailable = 'unavailable'; },
    (r: any) => { r.activeTime = null; },
    (r: any) => { r.sourceErrors = ['codex']; },
    (r: any) => { r.tools[0].tokens = '100'; },
    (r: any) => { r.range.from = '2026-07-01'; },
    (r: any) => { delete r.topModelsByTokens; },
  ];
  for (const corrupt of corruptions) {
    const { store, file } = storeAt(); store.write(WINDOW, sampleReport, FP);
    const disk = JSON.parse(readFileSync(file, 'utf8')); corrupt(disk.entries[0].report);
    writeFileSync(file, JSON.stringify(disk)); store.forget();
    assert.equal(store.read(WINDOW, FP), undefined);
  }
  const { store, file } = storeAt(); store.write(WINDOW, sampleReport, FP);
  const disk = JSON.parse(readFileSync(file, 'utf8')); disk.schemaVersion = 1;
  writeFileSync(file, JSON.stringify(disk)); store.forget();
  assert.equal(store.read(WINDOW, FP), undefined, 'old potentially poisoned caches must be rebuilt');
});

/** Deterministic live-source changes without sleeping or touching real runtime state. */
function serviceFixture(options: { identityTtlMs?: number; ttlMs?: number } = {}) {
  let now = Date.parse('2026-09-20T12:00:00Z');
  const { store, file } = storeAt({ now: () => now });
  const state = {
    source: 'baseline', pricingFails: false, usageFails: false, version: '2.5.3',
    tokens: 100, cost: 1, calls: [] as URL[],
    onUsage: undefined as undefined | (() => void | Promise<void>),
  };
  const upstream = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); state.calls.push(url);
    if (url.pathname === '/api/pricing-db') return state.pricingFails
      ? new Response('', { status: 503 })
      : Response.json({ source: state.source, baseline_version: '2.0.25' });
    if (url.pathname === '/api/version') return Response.json(versionBody({ runtime_version: state.version }));
    const range = { from: url.searchParams.get('date_from'), to: url.searchParams.get('date_to'), recognized: true };
    if (url.pathname === '/api/usage') {
      await state.onUsage?.();
      return state.usageFails ? new Response('', { status: 503 })
        : Response.json(usageBody({ range, total_tokens: state.tokens, total_cost: state.cost }));
    }
    if (url.pathname === '/api/active-time') return Response.json(activeTimeBody());
    return Response.json(insightsBody({ range }));
  }) as typeof fetch;
  const create = () => new TokdashReportService({
    baseUrl: 'http://127.0.0.1:9876', store: new TokdashReportStore({ path: file, now: () => now }),
    cache: new TokdashReportCache({ now: () => now, ttlMs: options.ttlMs }),
    now: () => now, fetch: upstream, identityTtlMs: options.identityTtlMs,
  });
  return { state, store, file, create, advance: (ms: number) => { now += ms; }, now: () => now };
}
const JULY = { from: '2026-07-01', to: '2026-07-31' };

await test('identity failure recovers without five minutes of negative memoization', async () => {
  const f = serviceFixture(); const service = f.create(); f.state.pricingFails = true;
  await service.read(WINDOW);
  assert.equal(existsSync(f.file), false);
  f.state.pricingFails = false;
  await service.read(JULY); f.store.forget();
  assert.notEqual(f.store.read(JULY, FP), undefined);
});

await test('a verified disk hit warms memory without changing its original timestamp', async () => {
  const f = serviceFixture({ identityTtlMs: 0 }); await f.create().read(WINDOW);
  const captured = f.now(); f.advance(60_000); const service = f.create();
  const disk = await service.read(WINDOW);
  assert.equal(disk.entry.cachedAt, captured);
  const calls = f.state.calls.length; f.state.pricingFails = true; f.state.usageFails = true;
  const memory = await service.read(WINDOW);
  assert.equal(memory.servedFromCache, true); assert.equal(memory.entry.cachedAt, captured);
  assert.equal(f.state.calls.length, calls);
  f.advance(5 * 60_000);
  await assert.rejects(service.read(WINDOW), /usage request failed/);
});

await test('warming memory cannot extend a memoized identity beyond its freshness budget', async () => {
  const f = serviceFixture(); const seed = f.create();
  await seed.read(WINDOW); await seed.read(JULY);
  const service = f.create(); await service.read(WINDOW);
  f.advance(5 * 60_000 - 1); await service.read(JULY);
  f.state.pricingFails = true; f.state.usageFails = true; f.advance(1);
  await assert.rejects(service.read(JULY), /usage request failed/);
});

await test('historical changes refresh at the durable deadline, including upstream caches', async () => {
  const f = serviceFixture(); await f.create().read(WINDOW);
  f.advance(TOKDASH_REPORT_STORE_MAX_AGE_MS - 1); const service = f.create();
  assert.equal((await service.read(WINDOW)).entry.report.totals.tokens, 100);
  f.state.tokens = 999; f.advance(1); f.state.calls.length = 0;
  const rebuilt = await service.read(WINDOW);
  assert.equal(rebuilt.entry.report.totals.tokens, 999); assert.equal(rebuilt.servedFromCache, false);
  const scans = f.state.calls.filter((u) => ['/api/usage', '/api/active-time', '/api/insights'].includes(u.pathname));
  assert.equal(scans.length, 3); assert.equal(scans.every((u) => u.searchParams.get('refresh') === 'true'), true);
  assert.equal((await f.create().read(WINDOW)).entry.report.totals.tokens, 999, 'fresh result survives restart');
});

await test('a remembered baseline cannot stamp a new override-derived window', async () => {
  const f = serviceFixture(); const service = f.create(); await service.read(WINDOW);
  f.state.source = 'override'; f.state.cost = 77;
  assert.equal((await service.read(JULY)).entry.report.totals.cost, 77);
  f.store.forget(); assert.equal(f.store.read(JULY, FP), undefined);
  f.state.source = 'baseline'; f.state.cost = 1;
  assert.equal((await f.create().read(JULY)).entry.report.totals.cost, 1);
});

await test('an identity change or failed identity check during a scan refuses persistence', async () => {
  for (const change of ['pricing', 'version', 'unavailable']) {
    const f = serviceFixture();
    f.state.onUsage = () => {
      if (change === 'pricing') f.state.source = 'override';
      if (change === 'version') f.state.version = '2.5.4';
      if (change === 'unavailable') f.state.pricingFails = true;
    };
    await f.create().read(WINDOW);
    assert.equal(existsSync(f.file), false, change);
  }
});

await test('coalesced readers still spend one scan and open windows bypass identity', async () => {
  const f = serviceFixture(); const service = f.create();
  await Promise.all([service.read(WINDOW), service.read(WINDOW)]);
  assert.equal(f.state.calls.filter((u) => u.pathname === '/api/usage').length, 1);
  f.state.calls.length = 0;
  await service.read({ from: '2026-09-01', to: '2026-09-20' });
  assert.equal(f.state.calls.some((u) => u.pathname === '/api/pricing-db'), false);
  assert.equal(f.state.calls.some((u) => u.searchParams.has('refresh')), false);
});

await test('future timestamps and mismatched report windows are never trusted', () => {
  const f = serviceFixture(); f.store.write(WINDOW, sampleReport, FP);
  f.advance(-1); assert.equal(f.store.read(WINDOW, FP), undefined);
  const { store } = storeAt(); store.write(JULY, sampleReport, FP);
  assert.equal(store.read(JULY, FP), undefined);
});

rmSync(storeRoot, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// The store inside a real broker.
// ---------------------------------------------------------------------------
//
// Everything above tests the module. Two claims it cannot make are the ones the
// feature exists for, and both are properties of the ROUTE: that a window
// already in memory waits on nothing upstream, and that a window read by one
// broker is served from disk by the next one instead of being re-scanned. Both
// were regressions a reviewer caught by reading, which is exactly the coverage
// a unit suite cannot provide.

/** Every upstream path a fixture Tokdash was asked for. */
const brokerCalls: string[] = [];
let brokerUpstreamUnavailable = false;
function fixtureBody(pathname: string): unknown {
  if (pathname.startsWith('/api/usage')) return usageBody();
  if (pathname.startsWith('/api/active-time')) return activeTimeBody();
  if (pathname.startsWith('/api/insights')) return insightsBody();
  if (pathname.startsWith('/api/version')) return versionBody();
  // The store keeps a window only under a pricing table it can name, which is
  // the packaged baseline and its version.
  if (pathname.startsWith('/api/pricing-db')) {
    return { source: 'baseline', baseline_version: '2.0.25' };
  }
  return null;
}
const fixtureTokdash = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url);
    brokerCalls.push(pathname);
    if (brokerUpstreamUnavailable) return new Response('', { status: 503 });
    const body = fixtureBody(pathname);
    return body === null ? new Response('nope', { status: 404 }) : Response.json(body);
  },
});
const hits = (...paths: string[]): number =>
  brokerCalls.filter((path) => paths.some((wanted) => path.startsWith(wanted))).length;
const IDENTITY = ['/api/version', '/api/pricing-db'] as const;

const brokerHome = mkdtempSync(join(tmpdir(), 'cosyncing-report-store-broker-'));
const BROKER_TOKEN = 'tokdash-report-store-token';
const reportPath = `/api/tokdash/report?from=${WINDOW.from}&to=${WINDOW.to}`;

async function startFixtureBroker(): Promise<{ proc: Bun.Subprocess; base: string }> {
  // Leased rather than hard-coded: this suite runs beside others.
  const lease = await reserveLoopbackFixturePort();
  const { port } = lease;
  await lease.release();
  const proc = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: isolatedBrokerFixtureEnvironment(brokerHome, {
      overrides: {
        PORT: String(port),
        HOST: '127.0.0.1',
        COSYNCING_HOME: brokerHome,
        COSYNCING_TOKEN: BROKER_TOKEN,
        COSYNCING_MACHINE: 'tokdash-report-store-fixture',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_TOKDASH_URL: `http://127.0.0.1:${fixtureTokdash.port}`,
        // No identity memo, so a store consultation cannot hide behind a cached
        // fingerprint: anything that reaches the store re-reads those two routes
        // and shows up in the counts.
        COSYNCING_TOKDASH_FINGERPRINT_TTL_MS: '0',
      },
    }),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForBrokerHealth(proc, `${base}/api/health`);
  return { proc, base };
}

async function readReport(base: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${reportPath}`, {
    headers: { 'x-cosyncing-token': BROKER_TOKEN },
  });
  return await response.json() as Record<string, any>;
}

async function stopFixtureBroker(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  await proc.exited.catch(() => null);
}

let firstTokens: unknown;
const firstBroker = await startFixtureBroker();
try {
  await test('a window already in memory costs no upstream identity read', async () => {
    const before = hits(...IDENTITY);
    const first = await readReport(firstBroker.base);
    firstTokens = first.data?.totals?.tokens;
    assert.equal(first.ok, true, 'the report was served');
    assert.equal(typeof firstTokens, 'number');
    const afterScan = hits(...IDENTITY);
    assert.equal(afterScan > before, true, 'the read that scans establishes the identity');
    assert.equal(
      existsSync(join(brokerHome, 'tokdash-report-cache.json')),
      true,
      'the route keeps the finished window',
    );

    // Memory answers before the store does. The store cannot serve a window
    // without first establishing the current identity, and this broker holds no
    // identity memo, so a consultation would show as another pair of reads.
    const second = await readReport(firstBroker.base);
    assert.equal(second.data?.totals?.tokens, firstTokens);
    assert.equal(hits(...IDENTITY), afterScan, 'the second read went nowhere upstream');
  });
} finally {
  await stopFixtureBroker(firstBroker.proc);
}

const secondBroker = await startFixtureBroker();
try {
  await test('a later broker serves a finished window from disk, without re-scanning', async () => {
    // The scan is the cost the store exists to avoid, so the scan is what is
    // counted. A fresh process, the same home, the same window.
    const scansBefore = hits('/api/insights');
    assert.equal(scansBefore, 1, 'exactly one scan has happened so far');
    const report = await readReport(secondBroker.base);
    assert.equal(report.ok, true);
    assert.equal(report.data?.totals?.tokens, firstTokens, 'the same figures come back');
    assert.equal(report.servedFromCache, true, 'and they are reported as cached');
    assert.equal(hits('/api/insights'), scansBefore, 'no second scan');
  });
  await test('the route keeps a verified disk hit available during an immediate upstream outage', async () => {
    const before = brokerCalls.length;
    brokerUpstreamUnavailable = true;
    const report = await readReport(secondBroker.base);
    assert.equal(report.ok, true);
    assert.equal(report.data?.totals?.tokens, firstTokens);
    assert.equal(brokerCalls.length, before, 'the disk hit warmed the route memory cache');
  });
} finally {
  brokerUpstreamUnavailable = false;
  await stopFixtureBroker(secondBroker.proc);
  rmSync(brokerHome, { recursive: true, force: true });
  fixtureTokdash.stop(true);
}


console.log(`\nTokdash report: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
