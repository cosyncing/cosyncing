/**
 * Tokdash upstream bodies as 2.5.0 actually serves them, trimmed to the fields the report DTO reads
 * plus a few it must ignore.
 *
 * Shapes and magnitudes come from a live read of the design host on 2026-09-02. Project names are
 * synthetic: real basenames are amber-tier data and do not belong in a committed fixture.
 *
 * Shared by the broker suite and by the generator for `contracts/generated/usage-report.sample.json`,
 * so the DTO the Dart client decodes in its own tests is the one this module actually produces.
 */

/** `GET /api/usage`. */
export function usageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** `GET /api/active-time`. */
export function activeTimeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** `GET /api/insights?facets=…`. */
export function insightsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        { project: 'atlas', tokens: 7_771_744_344, cost: 5_882.03, messages: 36_771 },
        { project: 'atlas_private', tokens: 4_000_000_000, cost: 2_400, messages: 20_000 },
      ],
      unattributed: { tokens: 153_435_350, cost: 17.44, messages: 1_376 },
      attributed_project_count: 41,
      names_included: true,
    },
    ...overrides,
  };
}

/** How the stub should answer one upstream endpoint. */
export type FixtureAnswer = Record<string, unknown> | 'fail' | number;

/** What each of the three upstream endpoints answers. */
export interface FixtureOptions {
  usage?: FixtureAnswer;
  activeTime?: FixtureAnswer;
  insights?: FixtureAnswer;
}

/** A Tokdash stub that records every URL it is asked for. */
export function stubTokdash(options: FixtureOptions = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const respond = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const answer = (chosen: FixtureAnswer | undefined, fallback: Record<string, unknown>): Response => {
    if (typeof chosen === 'number') return new Response('nope', { status: chosen });
    if (chosen === 'fail') return new Response('nope', { status: 500 });
    return respond(chosen ?? fallback);
  };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/usage')) return answer(options.usage, usageFixture());
    if (url.includes('/api/active-time')) return answer(options.activeTime, activeTimeFixture());
    if (url.includes('/api/insights')) return answer(options.insights, insightsFixture());
    throw new Error(`unexpected upstream request: ${url}`);
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls };
}

/** The window the committed sample DTO covers. */
export const SAMPLE_WINDOW = { from: '2026-08-01', to: '2026-08-31' } as const;
