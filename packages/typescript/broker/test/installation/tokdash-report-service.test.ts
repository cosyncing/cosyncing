/**
 * The usage report's memory, durable store and identity memo, on a clock the test moves.
 *
 * `e2e/broker/usage-and-quota.test.ts` covers the report through a real broker and a fake
 * Tokdash: costs, content, refusals, the store across a restart, identity changes. What it
 * cannot do is let minutes or months pass. These cases pin the time budgets: how long a
 * failed or a good identity is remembered, when a stored window is rebuilt, and that a
 * stored entry from the future is never trusted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokdashReportCache } from '../../src/installation/tokdash-report.ts';
import { TokdashReportService } from '../../src/installation/tokdash-report-service.ts';
import {
  TOKDASH_REPORT_STORE_MAX_AGE_MS,
  TokdashReportStore,
} from '../../src/installation/tokdash-report-store.ts';
import {
  activeTimeFixture,
  insightsFixture,
  usageFixture,
  versionFixture,
} from '../fixtures/tokdash-report-fixtures.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-tokdash-service-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let files = 0;

const AUGUST = { from: '2026-08-01', to: '2026-08-31' };
const JULY = { from: '2026-07-01', to: '2026-07-31' };

/** A service over a scripted Tokdash, a store file of its own, and a clock the test moves. */
function fixture(options: { identityTtlMs?: number } = {}) {
  let now = Date.parse('2026-09-20T12:00:00Z');
  const file = join(root, `store-${(files += 1)}.json`);
  const tokdash = {
    source: 'baseline',
    pricingFails: false,
    usageFails: false,
    tokens: 100,
    cost: 1,
    calls: [] as URL[],
  };
  const upstream = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    tokdash.calls.push(url);
    if (url.pathname === '/api/pricing-db') {
      return tokdash.pricingFails
        ? new Response('', { status: 503 })
        : Response.json({ source: tokdash.source, baseline_version: '2.0.25' });
    }
    if (url.pathname === '/api/version') return Response.json(versionFixture());
    const range = { from: url.searchParams.get('date_from'), to: url.searchParams.get('date_to'), recognized: true };
    if (url.pathname === '/api/usage') {
      return tokdash.usageFails
        ? new Response('', { status: 503 })
        : Response.json(usageFixture({ range, total_tokens: tokdash.tokens, total_cost: tokdash.cost }));
    }
    if (url.pathname === '/api/active-time') return Response.json(activeTimeFixture());
    return Response.json(insightsFixture({ range }));
  }) as typeof fetch;
  const store = () => new TokdashReportStore({ path: file, now: () => now });
  /** A broker process: fresh memory over the same store file. */
  const broker = () => new TokdashReportService({
    baseUrl: 'http://127.0.0.1:9876',
    store: store(),
    cache: new TokdashReportCache({ now: () => now }),
    now: () => now,
    fetch: upstream,
    identityTtlMs: options.identityTtlMs,
  });
  return { tokdash, file, store, broker, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('tokdash report time budgets', () => {
  test('a failed identity read is not remembered: the next window is kept', async () => {
    const f = fixture();
    const service = f.broker();
    f.tokdash.pricingFails = true;
    await service.read(AUGUST);
    expect(existsSync(f.file)).toBe(false);
    f.tokdash.pricingFails = false;
    await service.read(JULY);
    expect((await f.broker().read(JULY)).servedFromCache).toBe(true);
  });

  test('a disk hit keeps its original age, and memory forgets it on the usual schedule', async () => {
    const f = fixture({ identityTtlMs: 0 });
    await f.broker().read(AUGUST);
    const readAt = f.now();
    f.advance(60_000);
    const service = f.broker();
    expect((await service.read(AUGUST)).entry.cachedAt).toBe(readAt);
    const calls = f.tokdash.calls.length;
    f.tokdash.pricingFails = true;
    f.tokdash.usageFails = true;
    const memory = await service.read(AUGUST);
    expect(memory.servedFromCache).toBe(true);
    expect(memory.entry.cachedAt).toBe(readAt);
    expect(f.tokdash.calls.length).toBe(calls);
    f.advance(5 * 60_000);
    await expect(service.read(AUGUST)).rejects.toThrow(/usage request failed/);
  });

  test('warming memory from disk cannot stretch a remembered identity past its budget', async () => {
    const f = fixture();
    const seed = f.broker();
    await seed.read(AUGUST);
    await seed.read(JULY);
    const service = f.broker();
    await service.read(AUGUST);
    f.advance(5 * 60_000 - 1);
    await service.read(JULY);
    f.tokdash.pricingFails = true;
    f.tokdash.usageFails = true;
    f.advance(1);
    await expect(service.read(JULY)).rejects.toThrow(/usage request failed/);
  });

  test('a stored window is rebuilt from a fresh Tokdash read once it reaches the durable deadline', async () => {
    const f = fixture();
    await f.broker().read(AUGUST);
    f.advance(TOKDASH_REPORT_STORE_MAX_AGE_MS - 1);
    expect((await f.broker().read(AUGUST)).entry.report.totals.tokens).toBe(100);
    f.tokdash.tokens = 999;
    f.advance(1);
    f.tokdash.calls.length = 0;
    const rebuilt = await f.broker().read(AUGUST);
    expect(rebuilt.servedFromCache).toBe(false);
    expect(rebuilt.entry.report.totals.tokens).toBe(999);
    const scans = f.tokdash.calls.filter((url) => ['/api/usage', '/api/active-time', '/api/insights'].includes(url.pathname));
    expect(scans).toHaveLength(3);
    expect(scans.every((url) => url.searchParams.get('refresh') === 'true')).toBe(true);
    expect((await f.broker().read(AUGUST)).entry.report.totals.tokens).toBe(999);
  });

  test('a remembered baseline identity cannot stamp a window derived under a new override', async () => {
    const f = fixture();
    const service = f.broker();
    await service.read(AUGUST);
    f.tokdash.source = 'override';
    f.tokdash.cost = 77;
    expect((await service.read(JULY)).entry.report.totals.cost).toBe(77);
    f.tokdash.source = 'baseline';
    f.tokdash.cost = 1;
    // A new process rebuilds July instead of serving the override-priced figure.
    expect((await f.broker().read(JULY)).entry.report.totals.cost).toBe(1);
  });

  test('a stored entry from the future is never trusted', async () => {
    const f = fixture();
    await f.broker().read(AUGUST);
    f.advance(-1);
    f.tokdash.tokens = 5;
    expect((await f.broker().read(AUGUST)).entry.report.totals.tokens).toBe(5);
  });
});
