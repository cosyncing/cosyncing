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
import {
  fetchTokdashReport,
  isTokdashReportDate,
  TokdashReportCache,
  TOKDASH_REPORT_FACETS,
} from '../../src/installation/tokdash-report.ts';

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

const WINDOW = { from: '2026-08-01', to: '2026-08-31' };

/**
 * `/api/usage` as Tokdash 2.5.0 serves it, trimmed to the fields the DTO reads plus a few it must
 * ignore. Shapes and magnitudes are taken from a live read of this host on 2026-09-02.
 */
function usageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    period: 'today',
    range: {
      period_requested: 'year',
      period_resolved: 'custom',
      from: '2026-08-01',
      to: '2026-08-31',
      days: 31,
      recognized: true,
    },
    total_tokens: 19_893_991_786,
    total_cost: 12_976.51,
    total_messages: 129_030,
    cache_hit_rate: 0.9689,
    by_tool: {
      claude: { tokens: 10_088_964_020, cost: 7_568.01, tokens_in: 230_778_425, tokens_cache: 9_830_354_009, cache_hit_rate: 0.9771 },
      codex: { tokens: 8_001_548_471, cost: 4_907.66, tokens_in: 238_611_607, tokens_cache: 7_732_433_776, cache_hit_rate: 0.9701 },
      // Present in by_tool and absent from coding_apps: the source with stored tokens and no
      // project rows, which is the whole reason the coverage gap exists.
      openclaw: { tokens: 777_870_272, cost: 118.12, tokens_in: 114_805_061, tokens_cache: 655_369_004, cache_hit_rate: 0.8509 },
    },
    coding_apps: {
      claude: { tokens: 10_088_964_020, tokens_in: 230_778_425, tokens_out: 27_831_586, tokens_cache: 9_830_354_009, cost: 7_568.01, messages: 44_456, cache_hit_rate: 0.9771 },
      codex: { tokens: 8_001_548_471, tokens_in: 238_611_607, tokens_out: 23_185_303, tokens_cache: 7_732_433_776, cost: 4_907.66, messages: 58_926, cache_hit_rate: 0.9701 },
    },
    top_models: [
      { name: 'claude-opus-5', tokens: 7_979_785_226, cost: 5_146.76, tokens_in: 122_162_066, tokens_out: 18_557_261, tokens_cache: 7_839_065_899, messages: 33_247 },
      { name: 'gpt-5.6-sol', tokens: 6_120_000_000, cost: 3_900.12, messages: 41_000 },
    ],
    top_models_by_cost: [
      { name: 'claude-opus-5', tokens: 7_979_785_226, cost: 5_146.76, messages: 33_247 },
    ],
    source_errors: [],
    comparison: { tokens_prev: 17_228_365_707, cost_prev: 11_328.73, messages_prev: 127_012, tokens_pct: 15.5, cost_pct: 14.5, messages_pct: 1.6 },
    ...overrides,
  };
}

function activeTimeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active_ms: 1_453_366_891,
    active_ms_sum: 2_830_367_494,
    comparison: { active_ms_pct: 27.7 },
    by_tool: {
      claude: { tool_label: 'Claude Code', session_count: 119, active_ms: 793_691_035 },
      codex: { tool_label: 'Codex', session_count: 175, active_ms: 969_656_855 },
    },
    active_gap_cap_ms: 300_000,
    active_time_estimated: true,
    active_time_method: 'capped-inter-event-gap',
    ...overrides,
  };
}

function insightsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    range: { period_requested: 'year', period_resolved: 'custom', from: '2026-08-01', to: '2026-08-31', days: 31, recognized: true },
    timezone: 'BST',
    coverage: { stored_sources: ['claude', 'codex', 'openclaw'], live_sources: ['kilocode', 'mimo'], group_count: 1932 },
    hourly: {
      buckets: [
        { hour: 0, tokens: 861_148_188, cost: 576.85, messages: 4_430 },
        { hour: 15, tokens: 1_900_000_000, cost: 1_200, messages: 9_000 },
      ],
      peak_hour: 15,
      night_share: 0.218,
      night_hours: [22, 23, 0, 1],
    },
    weekday: {
      buckets: [
        { weekday: 0, name: 'Monday', tokens: 3_579_777_284, cost: 2_118.33, messages: 23_681 },
        { weekday: 6, name: 'Sunday', tokens: 4_100_000_000, cost: 2_400, messages: 25_000 },
      ],
      peak_weekday: 6,
    },
    daily: [
      { date: '2026-08-01', tokens: 837_487_917, cost: 595.57, messages: 5_054, intensity: 4 },
      { date: '2026-08-02', tokens: 12_000, cost: 0.1, messages: 4, intensity: 1 },
    ],
    streaks: { current_streak: 0, longest_streak: 31, active_days: 31, total_days: 31 },
    firsts: { first_active_day: '2026-08-01', last_active_day: '2026-08-31', busiest_day: '2026-08-31', busiest_day_tokens: 1_097_438_655, peak_hour: 15 },
    projects: {
      projects: [
        { project: 'cosyncing', tokens: 7_771_744_344, cost: 5_882.03, messages: 36_771 },
        { project: 'cosyncing_private', tokens: 4_000_000_000, cost: 2_400, messages: 20_000 },
      ],
      unattributed: { tokens: 153_435_350, cost: 17.44, messages: 1_376 },
      attributed_project_count: 41,
      names_included: true,
    },
    ...overrides,
  };
}

interface StubOptions {
  usage?: Record<string, unknown> | 'fail';
  activeTime?: Record<string, unknown> | 'fail';
  insights?: Record<string, unknown> | 'fail' | number;
}

/** A Tokdash stub that records every URL it is asked for. */
function stubFetch(options: StubOptions = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const respond = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/usage')) {
      if (options.usage === 'fail') return new Response('nope', { status: 500 });
      return respond(options.usage ?? usageBody());
    }
    if (url.includes('/api/active-time')) {
      if (options.activeTime === 'fail') return new Response('nope', { status: 500 });
      return respond(options.activeTime ?? activeTimeBody());
    }
    if (url.includes('/api/insights')) {
      if (typeof options.insights === 'number') return new Response('nope', { status: options.insights });
      if (options.insights === 'fail') return new Response('nope', { status: 500 });
      return respond(options.insights ?? insightsBody());
    }
    throw new Error(`unexpected upstream request: ${url}`);
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls };
}

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

await test('one window costs exactly three GETs, and no /api/sessions fan-out', async () => {
  const { fetch: upstream, calls } = stubFetch();
  await fetchTokdashReport(undefined, WINDOW, { fetch: upstream });

  assert.equal(calls.length, 3, `expected 3 upstream reads, got ${calls.length}: ${calls.join(', ')}`);
  assert.equal(calls.filter((url) => url.includes('/api/sessions')).length, 0);
  const insights = calls.find((url) => url.includes('/api/insights'));
  assert.ok(insights, 'the composite insights scan is requested');
  for (const name of TOKDASH_REPORT_FACETS) {
    assert.ok(insights.includes(name), `insights scan requests the ${name} facet`);
  }
  for (const url of calls) {
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
        { project: 'cosyncing', tokens: 7_771_744_344, cost: 5_882.03, messages: 36_771, display_name: 'fix the login race before the demo' },
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
  assert.equal(report.projects?.rows[0]?.project, 'cosyncing');
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
  assert.equal(calls.length, 3);

  const hit = cache.get(WINDOW);
  assert.ok(hit);
  assert.equal(hit.report.totals.tokens, first.totals.tokens);
  assert.equal(calls.length, 3, 'a cache hit costs no upstream reads');
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
  assert.equal(calls.length, 3, 'three GETs total, not nine');
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

console.log(`\nTokdash report: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
