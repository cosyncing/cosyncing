#!/usr/bin/env bun
/**
 * Standalone Tokdash quota read/evaluation contract.
 *
 * This suite proves the broker-side module is read-only, loopback-confined, strictly parsed,
 * bounded, opt-in, and transition-based before it is wired into routes or attention delivery.
 */
import { strict as assert } from 'node:assert';
import {
  TokdashQuotaEvaluator,
  fetchTokdashQuota,
  normalizeTokdashQuotaBaseUrl,
  quotaWarningIdentity,
  TOKDASH_DEFAULT_BASE_URL,
  type TokdashQuotaState,
} from '../../src/installation/tokdash-quota.ts';

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

function bucket(
  bucketId: string,
  remainingPercent: number,
  overrides: Partial<TokdashQuotaState['providers'][string]['buckets'][number]> = {},
) {
  return {
    account: 'acct',
    bucket: bucketId,
    bucket_label: bucketId,
    used_percent: 100 - remainingPercent,
    remaining_percent: remainingPercent,
    resets_at: 1_000,
    captured_at: 900,
    source: 'codex_api',
    status: 'ok',
    ...overrides,
  };
}

function provider(
  providerId: string,
  buckets: ReturnType<typeof bucket>[],
  overrides: Partial<TokdashQuotaState['providers'][string]> = {},
) {
  return {
    provider: providerId,
    network_enabled: true,
    buckets,
    status: 'ok',
    status_detail: null,
    status_at: null,
    updated_at: 900,
    sources: [`${providerId}_api`],
    estimated: false,
    ...overrides,
  };
}

function quotaState(providers: TokdashQuotaState['providers'], enabled = true): TokdashQuotaState {
  return { providers, enabled, timestamp: 900 };
}

await test('fetch uses one bounded GET to the exact Tokdash quota path and parses typed state', async () => {
  const requests: { method: string; path: string }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname });
      return Response.json(quotaState({ codex: provider('codex', [bucket('5h', 24)]) }));
    },
  });
  try {
    const state = await fetchTokdashQuota(`http://127.0.0.1:${server.port}`, { timeoutMs: 500 });
    assert.deepEqual(requests, [{ method: 'GET', path: '/api/quota' }]);
    assert.equal(state.providers.codex?.buckets[0]?.remaining_percent, 24);
  } finally {
    server.stop(true);
  }
});

await test('the advertised default Tokdash endpoint is the loopback one the client actually falls back to', () => {
  // Setup's consent copy names this constant. If the fallback ever moved, the prompt would start advertising
  // an endpoint nothing reads.
  assert.equal(normalizeTokdashQuotaBaseUrl(undefined), TOKDASH_DEFAULT_BASE_URL);
  assert.equal(normalizeTokdashQuotaBaseUrl(''), TOKDASH_DEFAULT_BASE_URL);
  assert.equal(new URL(TOKDASH_DEFAULT_BASE_URL).hostname, '127.0.0.1');
});

await test('source normalization accepts loopback paths and rejects non-loopback or spoofed hosts', () => {
  assert.equal(normalizeTokdashQuotaBaseUrl('http://localhost:55423/tokdash/'), 'http://localhost:55423/tokdash');
  assert.equal(normalizeTokdashQuotaBaseUrl('http://127.9.8.7:55423'), 'http://127.9.8.7:55423');
  assert.throws(() => normalizeTokdashQuotaBaseUrl('http://127.example.com:55423'), /localhost/i);
  assert.throws(() => normalizeTokdashQuotaBaseUrl('https://example.com'), /localhost/i);
});

await test('fetch rejects malformed quota fields instead of coercing them', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return Response.json({
        enabled: true,
        timestamp: 900,
        providers: {
          codex: provider('codex', [{ ...bucket('5h', 24), remaining_percent: '24' as never }]),
        },
      });
    },
  });
  try {
    await assert.rejects(
      () => fetchTokdashQuota(`http://127.0.0.1:${server.port}`),
      /invalid Tokdash quota response.*remaining_percent/i,
    );
  } finally {
    server.stop(true);
  }
});

await test('fetch timeout is bounded and reported without calling a mutation', async () => {
  let method = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      method = req.method;
      await Bun.sleep(100);
      return Response.json(quotaState({}));
    },
  });
  try {
    await assert.rejects(
      () => fetchTokdashQuota(`http://127.0.0.1:${server.port}`, { timeoutMs: 20 }),
      /timed out/i,
    );
    assert.equal(method, 'GET');
  } finally {
    server.stop(true);
  }
});

await test('evaluation is separately opt-in and recognizes Codex and Claude five-hour/weekly windows', () => {
  const state = quotaState({
    codex: provider('codex', [
      bucket('5h', 24),
      bucket('7d', 80),
      bucket('codex_spark_5h', 22),
      bucket('codex_spark_7d', 20),
      bucket('unknown', 1),
    ]),
    claude: provider('claude', [
      bucket('session', 24, { source: 'claude_api' }),
      bucket('weekly_all', 25, { source: 'claude_api' }),
      bucket('weekly_scoped_fable', 8, { source: 'claude_api' }),
      bucket('daily', 1, { source: 'claude_api' }),
    ]),
    mystery: provider('mystery', [bucket('5h', 1)]),
  });
  const evaluator = new TokdashQuotaEvaluator();
  assert.deepEqual(evaluator.evaluate(state, { optedIn: false }), { opened: [], active: [], resolved: [] });

  const result = evaluator.evaluate(state, { optedIn: true });
  assert.deepEqual(
    result.opened.map((warning) => `${warning.provider}:${warning.bucket}`).sort(),
    [
      'claude:session',
      'claude:weekly_all',
      'claude:weekly_scoped_fable',
      'codex:5h',
      'codex:codex_spark_5h',
      'codex:codex_spark_7d',
    ],
  );
});

await test('unchanged low quota stays active without opening a duplicate', () => {
  const evaluator = new TokdashQuotaEvaluator();
  const state = quotaState({ codex: provider('codex', [bucket('5h', 20)]) });
  const first = evaluator.evaluate(state, { optedIn: true });
  const second = evaluator.evaluate(state, { optedIn: true });
  assert.equal(first.opened.length, 1);
  assert.equal(second.opened.length, 0);
  assert.equal(second.active.length, 1);
  assert.equal(second.resolved.length, 0);
});

await test('reset epoch changes identity, resolves the prior warning, and preserves source/estimated', () => {
  const evaluator = new TokdashQuotaEvaluator();
  const estimatedProvider = provider('codex', [bucket('5h', 20, { source: 'codex_session' })], {
    network_enabled: false,
    estimated: true,
    sources: ['codex_session'],
  });
  const first = evaluator.evaluate(quotaState({ codex: estimatedProvider }), { optedIn: true });
  const nextBucket = bucket('5h', 18, { resets_at: 2_000, source: 'codex_session' });
  const second = evaluator.evaluate(
    quotaState({ codex: provider('codex', [nextBucket], { network_enabled: false, estimated: true, sources: ['codex_session'] }) }),
    { optedIn: true },
  );
  assert.equal(first.opened[0]?.estimated, true);
  assert.equal(first.opened[0]?.source, 'codex_session');
  assert.equal(second.opened.length, 1);
  assert.equal(second.resolved.length, 1);
  assert.notEqual(second.opened[0]?.id, second.resolved[0]?.id);
  assert.equal(
    second.opened[0]?.id,
    quotaWarningIdentity({ provider: 'codex', account: 'acct', bucket: '5h', resetsAt: 2_000 }),
  );
});

await test('above-threshold, absent, disabled, and unavailable providers resolve active warnings', () => {
  const cases: Array<{ name: string; next: TokdashQuotaState | undefined }> = [
    { name: 'above threshold', next: quotaState({ codex: provider('codex', [bucket('5h', 26)]) }) },
    { name: 'window absent', next: quotaState({ codex: provider('codex', []) }) },
    { name: 'tracking disabled', next: quotaState({ codex: provider('codex', [bucket('5h', 20)]) }, false) },
    { name: 'provider unavailable', next: quotaState({ codex: provider('codex', [bucket('5h', 20)], { status: 'unavailable' }) }) },
    { name: 'source unavailable', next: undefined },
  ];
  for (const entry of cases) {
    const evaluator = new TokdashQuotaEvaluator();
    evaluator.evaluate(quotaState({ codex: provider('codex', [bucket('5h', 20)]) }), { optedIn: true });
    const result = evaluator.evaluate(entry.next, { optedIn: true });
    assert.equal(result.active.length, 0, entry.name);
    assert.equal(result.resolved.length, 1, entry.name);
  }
});

await test('non-ok bucket and missing remaining quota are ignored without inventing warnings', () => {
  const evaluator = new TokdashQuotaEvaluator();
  const state = quotaState({
    codex: provider('codex', [
      bucket('5h', 5, { status: 'fetch_error' }),
      bucket('7d', 5, { remaining_percent: null, used_percent: null }),
    ]),
  });
  assert.deepEqual(evaluator.evaluate(state, { optedIn: true }), { opened: [], active: [], resolved: [] });
});

console.log(`\nTokdash quota: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
