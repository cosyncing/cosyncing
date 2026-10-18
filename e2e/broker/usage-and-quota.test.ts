/**
 * The usage report and the quota card, read through the broker the way the app reads them.
 *
 * The broker never computes usage itself: it reads a local Tokdash sidecar. A fake Tokdash
 * serving the real 2.5 bodies stands in for it, records every request, and can fail, hang,
 * or be held open, so each scenario can say what a report cost upstream as well as what the
 * device received. The broker requires an owner token, so the owner and a paired device are
 * different principals.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, eventually, never, scaled, startBroker } from '../harness/index.ts';
import { pairDevice } from '../harness/pairing.ts';
import { pathWithoutHostTools } from '../harness/fakes/executable.ts';
import {
  type FakeTokdash,
  quotaBucket,
  quotaProvider,
  quotaState,
  type ReportWindow,
  startFakeTokdash,
} from '../harness/fakes/tokdash.ts';
import {
  activeTimeFixture,
  insightsFixture,
  usageFixture,
  versionFixture,
} from '../../packages/typescript/broker/test/fixtures/tokdash-report-fixtures.ts';

const DAY_MS = 86_400_000;
/** A UTC calendar day, `offset` days from now: the broker bounds a window's ends in UTC. */
const utcDay = (offset: number): string => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
/** A local calendar day: the broker calls a window finished against the local date. */
function localDay(offset: number): string {
  const date = new Date(Date.now() + offset * DAY_MS);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A window still being written (it ends tomorrow, UTC, which is never before the local
 * date), so the broker keeps it in memory only. Each scenario reads its own, since the
 * broker remembers every window it has read.
 */
let openWindowSeq = 0;
function openWindow(): ReportWindow {
  openWindowSeq += 1;
  return { from: utcDay(-openWindowSeq), to: utcDay(1) };
}

/** A window that ended days ago, in any time zone, so the broker may keep it on disk. */
function finishedWindow(weeksAgo: number): ReportWindow {
  return { from: localDay(-7 * weeksAgo - 6), to: localDay(-7 * weeksAgo) };
}

const reportPath = (window: ReportWindow): string => `/api/tokdash/report?from=${window.from}&to=${window.to}`;

const PROJECT_NAMES = ['atlas', 'atlas_private'];

/** Only the fixture's own tools: never the developer's agents installed beside Bun. */
function hostToolFreePath(bin: string): Record<string, string> {
  const path = pathWithoutHostTools(bin);
  return path ? { PATH: path } : {};
}

let tokdash: FakeTokdash;
let broker: Broker;
let owner: BrokerClient;
let refusedOverride: Broker;

beforeAll(async () => {
  tokdash = startFakeTokdash();
  [broker, refusedOverride] = await Promise.all([
    startBroker({
      name: 'usage',
      token: true,
      setup: (paths) => {
        // State a broker inherits from earlier versions and hand edits: a preference
        // that is not a boolean, another setting beside it, and a report store this
        // broker cannot parse.
        mkdirSync(paths.cosyncingHome, { recursive: true });
        writeFileSync(
          join(paths.cosyncingHome, 'setup-state.json'),
          JSON.stringify({ quotaWarningsEnabled: 'yes', codexUpdatePolicy: 'when-idle' }),
        );
        writeFileSync(join(paths.cosyncingHome, 'tokdash-report-cache.json'), '{ not json');
      },
      env: (paths) => ({
        ...hostToolFreePath(paths.bin),
        COSYNCING_TOKDASH_URL: tokdash.url,
        // No identity memo: a stored window is served only after the broker has re-read
        // which Tokdash and which pricing table it would be derived from now.
        COSYNCING_TOKDASH_FINGERPRINT_TTL_MS: '0',
      }),
    }),
    startBroker({
      name: 'usage-refused-url',
      env: (paths) => ({
        ...hostToolFreePath(paths.bin),
        COSYNCING_TOKDASH_URL: 'http://reader:hunter2-tokdash@127.0.0.1:9/api',
      }),
    }),
  ]);
  owner = broker.client();
});

afterAll(async () => {
  await Promise.all([broker?.stop(), refusedOverride?.stop()]);
  await tokdash?.stop();
});

async function report(client: BrokerClient, window: ReportWindow): Promise<any> {
  const response = await client.get(reportPath(window));
  if (response.status !== 200) {
    throw new Error(`report ${window.from}..${window.to} → ${response.status}: ${response.text.slice(0, 300)}`);
  }
  expect(response.body.ok).toBe(true);
  return response.body;
}

/** Every attention event the broker holds, any state, as a device pages through them. */
async function attentionEvents(client: BrokerClient): Promise<any[]> {
  const events: any[] = [];
  let after = 0;
  for (;;) {
    const page = await client.get(`/api/attention-events?clientId=e2e-usage&after=${after}&limit=200`);
    expect(page.status).toBe(200);
    events.push(...page.body.events);
    if (!page.body.hasMore || page.body.events.length === 0) break;
    after = Math.max(...page.body.events.map((event: any) => event.cursor));
  }
  // A page carries an event's latest revision; keep the newest copy of each.
  const latest = new Map<string, any>();
  for (const event of events) {
    const seen = latest.get(event.id);
    if (!seen || seen.revision <= event.revision) latest.set(event.id, event);
  }
  return [...latest.values()];
}

const quotaWarnings = async (client: BrokerClient): Promise<any[]> =>
  (await attentionEvents(client)).filter((event) => event.kind === 'usage-threshold');

function lowCodexQuota(remainingPercent = 20, overrides: Record<string, unknown> = {}): { json: unknown } {
  return {
    json: quotaState({
      codex: quotaProvider('codex', [quotaBucket('5h', remainingPercent), quotaBucket('7d', 80)], overrides),
    }),
  };
}

describe('quota warnings are opt-in', () => {
  test('a stored preference that is not a boolean reads as off, and nothing polls Tokdash quota', async () => {
    const preference = await owner.get('/api/tokdash/quota-preference');
    expect(preference.status).toBe(200);
    expect(preference.body).toEqual({ ok: true, enabled: false });
    // The broker reconciled quota warnings when it started; opted out, it asked Tokdash nothing.
    expect(tokdash.count('quota')).toBe(0);
    expect((await quotaWarnings(owner))).toEqual([]);
  });

  test('only the owner changes it, only with a boolean, and other settings survive the write', async () => {
    expect((await owner.post('/api/tokdash/quota-preference', { enabled: 'yes' })).status).toBe(400);
    const device = await pairDevice(owner, { peerId: 'quota-phone' });
    const phone = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await phone.get('/api/tokdash/quota-preference')).body.enabled).toBe(false);
    expect((await phone.post('/api/tokdash/quota-preference', { enabled: true })).status).toBe(403);

    tokdash.answer('quota', lowCodexQuota(60));
    const enabled = await owner.post('/api/tokdash/quota-preference', { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toEqual({ ok: true, enabled: true });
    expect((await owner.get('/api/tokdash/quota-preference')).body.enabled).toBe(true);
    // The Codex update policy stored beside it is still the one the owner chose.
    expect((await owner.get('/api/agent-runtime-update-policy')).body.codexUpdatePolicy).toBe('when-idle');
    tokdash.reset();
  });

  test('a low bucket opens one warning, a recovered one resolves it, and opting out resolves a new one', async () => {
    tokdash.answer('quota', lowCodexQuota(20));
    await owner.post('/api/tokdash/quota-preference', { enabled: true });
    let warnings = await quotaWarnings(owner);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'usage-threshold',
      state: 'active',
      severity: 'maintenance',
      title: 'Quota running low',
      summary: 'A 5-hour or weekly quota is low.',
      action: { kind: 'open-quota-settings' },
    });

    // Still low on the next reconciliation: the same warning, not a second one.
    await owner.post('/api/tokdash/quota-preference', { enabled: true });
    expect(await quotaWarnings(owner)).toHaveLength(1);

    tokdash.answer('quota', lowCodexQuota(26));
    await owner.post('/api/tokdash/quota-preference', { enabled: true });
    warnings = await quotaWarnings(owner);
    expect(warnings.map((event) => event.state)).toEqual(['resolved']);

    // An estimate from local data says so, and opting out takes the warning away.
    tokdash.answer('quota', lowCodexQuota(10, { estimated: true, network_enabled: false, sources: ['codex_session'] }));
    await owner.post('/api/tokdash/quota-preference', { enabled: true });
    const estimated = (await quotaWarnings(owner)).find((event) => event.state === 'active');
    expect(estimated?.summary).toBe('A 5-hour or weekly quota is low (estimated from local data).');
    await owner.post('/api/tokdash/quota-preference', { enabled: false });
    expect((await quotaWarnings(owner)).every((event) => event.state === 'resolved')).toBe(true);
    tokdash.reset();
  });
});

describe('quota', () => {
  test('is one read-only GET of /api/quota, with reset credits as epoch seconds', async () => {
    tokdash.answer('quota', {
      json: quotaState({
        codex: quotaProvider('codex', [quotaBucket('5h', 24)], {
          reset_credits: {
            available_count: 2,
            credits: [
              { id: 'RateLimitResetCredit_1', title: 'Full reset', expires_at: '2026-10-22T20:48:12.396262Z', status: 'available' },
              { id: 'RateLimitResetCredit_2', title: 'Full reset', expires_at: '2026-10-29T19:17:38Z' },
            ],
          },
        }),
        // One malformed credit block never fails the read.
        claude: quotaProvider('claude', [quotaBucket('session', 86, { source: 'claude_api' })], {
          reset_credits: { available_count: 'one', credits: [] },
        }),
      }),
    });
    const since = tokdash.requests.length;
    const quota = await owner.get('/api/tokdash/quota');
    expect(quota.status).toBe(200);
    expect(quota.body.endpoint).toBe('/api/quota');
    expect(tokdash.since(since).map((request) => `${request.method} ${request.path}`)).toEqual(['GET /api/quota']);
    const { codex, claude } = quota.body.data.providers;
    expect(codex.buckets[0].remaining_percent).toBe(24);
    expect(codex.reset_credits).toEqual({
      available_count: 2,
      credits: [
        { id: 'RateLimitResetCredit_1', title: 'Full reset', expires_at: Math.floor(Date.parse('2026-10-22T20:48:12.396262Z') / 1000) },
        { id: 'RateLimitResetCredit_2', title: 'Full reset', expires_at: Math.floor(Date.parse('2026-10-29T19:17:38Z') / 1000) },
      ],
    });
    expect('reset_credits' in claude).toBe(false);
    expect(claude.buckets[0].remaining_percent).toBe(86);

    // A paired device reads the same card.
    const device = await pairDevice(owner, { peerId: 'quota-reader' });
    const phone = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await phone.get('/api/tokdash/quota')).body.data.providers.codex.buckets[0].remaining_percent).toBe(24);
    // Transport negotiation must preserve the same authenticated quota card.
    const identity = await phone.get('/api/tokdash/quota', { 'accept-encoding': 'gzip;q=0' });
    expect(Buffer.byteLength(identity.text)).toBeGreaterThanOrEqual(1024);
    expect(identity.headers.get('content-encoding')).toBeNull();
    const gzip = await phone.get('/api/tokdash/quota', { 'accept-encoding': 'gzip' });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(gzip.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    expect(gzip.body).toEqual(identity.body);
    tokdash.reset();
  });

  test('a malformed or silent Tokdash is an error, never coerced numbers', async () => {
    tokdash.answer('quota', {
      json: quotaState({ codex: quotaProvider('codex', [{ ...quotaBucket('5h', 24), remaining_percent: '24' }]) }),
    });
    const malformed = await owner.get('/api/tokdash/quota');
    expect(malformed.status).toBe(502);
    expect(malformed.body.ok).toBe(false);
    expect(malformed.body.error).toMatch(/invalid Tokdash quota response.*remaining_percent/i);

    tokdash.answer('quota', 'hang');
    const silent = await owner.get('/api/tokdash/quota');
    expect(silent.status).toBe(502);
    expect(silent.body.error).toMatch(/timed out/i);
    tokdash.reset();
  });
});

describe('the usage report', () => {
  test('one window costs one read of each scan and the version, and never a session fan-out', async () => {
    const window = openWindow();
    const since = tokdash.requests.length;
    const body = await report(owner, window);
    expect(body.servedFromCache).toBe(false);
    expect(body.baseUrl).toBe(tokdash.url);

    const reads = tokdash.since(since);
    expect(reads.some((request) => request.path.includes('/sessions'))).toBe(false);
    expect(tokdash.count('usage', { window, since })).toBe(1);
    expect(tokdash.count('active-time', { window, since })).toBe(1);
    expect(tokdash.count('insights', { window, since })).toBe(1);
    expect(tokdash.count('version', { since })).toBe(1);
    // A window still being written is never kept, so no identity is read and Tokdash's own
    // cache may answer it.
    expect(tokdash.count('pricing-db', { since })).toBe(0);
    expect(reads.some((request) => request.query.has('refresh'))).toBe(false);
    const facets = reads.find((request) => request.endpoint === 'insights')!.query.get('facets')!.split(',');
    expect(facets.sort()).toEqual(['daily', 'firsts', 'hourly', 'projects', 'streaks', 'weekday']);

    const data = body.data;
    expect(data.runtime).toEqual({ version: '2.5.3', minimumVersion: '2.5.0', belowMinimum: false });
    expect(data.range).toMatchObject({ from: window.from, to: window.to, recognized: true, days: 31 });
    expect(data.totals).toMatchObject({ tokens: 19_893_991_786, requests: 129_030 });
    expect(data.tools.map((tool: any) => tool.tool)).toEqual(['claude', 'codex', 'openclaw']);
    expect(data.tools[0]).toMatchObject({
      label: 'Claude Code', sessions: 119, requests: 44_456, tokensOut: 27_831_586, coding: true,
    });
    // A source with tokens and no coding-app row: real tokens, every other cell empty.
    expect(data.tools[2]).toMatchObject({
      tokens: 777_870_272, coding: false, requests: null, sessions: null, tokensOut: null,
    });
    // The period total travels beside the project rows, so the uncovered share is computable.
    const rowTokens = data.projects.rows.reduce((sum: number, row: any) => sum + row.tokens, 0);
    const unattributed = data.projects.unattributed.tokens;
    expect(data.totals.tokens - rowTokens - unattributed).toBeGreaterThan(unattributed);
    // Served, never recomputed: the night window, the heatmap rank and the source count.
    expect(data.hourly.nightHours).toEqual([22, 23, 0, 1]);
    expect(data.hourly.peakHour).toBe(15);
    expect(data.daily.map((day: any) => [day.date, day.intensity])).toEqual([['2026-08-01', 4], ['2026-08-02', 1]]);
    expect(data.coverage.sourceCount).toBe(5);
    expect(data.coverage.liveSources).toEqual(['kilocode', 'mimo']);
    expect(data.sourceErrors).toEqual([]);
    expect(data.insightsUnavailable).toBeNull();
  });

  test('prompt text Tokdash starts serving never reaches a device', async () => {
    const window = openWindow();
    tokdash.answer('usage', { json: usageFixture({ display_name: 'top-level prompt text' }) }, window);
    tokdash.answer('active-time', {
      json: activeTimeFixture({
        by_tool: { claude: { tool_label: 'Claude Code', session_count: 1, active_ms: 1, display_name: 'tool prompt' } },
      }),
    }, window);
    tokdash.answer('insights', {
      json: insightsFixture({
        projects: {
          projects: [{ project: 'atlas', tokens: 7_771_744_344, cost: 5_882.03, messages: 36_771, display_name: 'fix the login race before the demo' }],
          unattributed: { tokens: 153_435_350, cost: 17.44, messages: 1_376, display_name: 'another prompt' },
          attributed_project_count: 41,
          names_included: true,
          display_name: 'facet-level prompt text',
        },
        daily: [{ date: '2026-08-01', tokens: 1, cost: 0, messages: 1, intensity: 1, display_name: 'daily prompt' }],
      }),
    }, window);
    const response = await owner.get(reportPath(window));
    expect(response.status).toBe(200);
    for (const leaked of ['display_name', 'fix the login race', 'facet-level prompt', 'top-level prompt', 'daily prompt', 'tool prompt']) {
      expect(response.text).not.toContain(leaked);
    }
    expect(response.body.data.projects.rows[0].project).toBe('atlas');
    tokdash.reset();
  });

  test('the version decides the floor: an old or unreadable Tokdash is told apart from a refused period', async () => {
    const read = async (setup: () => void): Promise<any> => {
      setup();
      const body = await report(owner, openWindow());
      tokdash.reset();
      return body.data;
    };

    const atFloor = await read(() => tokdash.answer('version', { json: versionFixture({ runtime_version: '2.5.0' }) }));
    expect(atFloor.runtime).toEqual({ version: '2.5.0', minimumVersion: '2.5.0', belowMinimum: false });
    const tenth = await read(() => tokdash.answer('version', { json: versionFixture({ runtime_version: '2.10.0' }) }));
    expect(tenth.runtime.belowMinimum).toBe(false);
    const below = await read(() => tokdash.answer('version', { json: versionFixture({ runtime_version: '2.4.9' }) }));
    expect(below.runtime).toEqual({ version: '2.4.9', minimumVersion: '2.5.0', belowMinimum: true });

    // An unreadable version fails closed to below the floor, and costs the report nothing else.
    for (const answer of [{ status: 404 }, { json: { service: 'not-tokdash', runtime_version: '9.9.9' } }, { json: versionFixture({ runtime_version: 'nightly' }) }]) {
      const unreadable = await read(() => tokdash.answer('version', answer));
      expect(unreadable.runtime).toEqual({ version: null, minimumVersion: '2.5.0', belowMinimum: true });
      expect(unreadable.totals.tokens).toBe(19_893_991_786);
      expect(unreadable.hourly).not.toBeNull();
    }

    // Tokdash 2.0: no insights route and no window verdict. Still a report, minus facets.
    const old = await read(() => {
      tokdash.answer('version', { json: versionFixture({ runtime_version: '2.0.0' }) });
      tokdash.answer('insights', { status: 404 });
      tokdash.answer('usage', { json: usageFixture({ range: { from: '2026-08-01', to: '2026-08-31' } }) });
    });
    expect(old.runtime.belowMinimum).toBe(true);
    expect(old.range.recognized).toBe(false);
    expect(old.insightsUnavailable).toBe('unsupported');
    for (const facet of ['hourly', 'weekday', 'daily', 'projects', 'streaks', 'firsts', 'coverage', 'timezone']) {
      expect(old[facet]).toBeNull();
    }
    expect(old.totals.tokens).toBe(19_893_991_786);
    expect(old.tools).toHaveLength(3);
    expect(old.topModelsByTokens[0].name).toBe('claude-opus-5');
    expect(old.activeTime.activeMs).toBe(1_453_366_891);

    // A current Tokdash that could not resolve the period: same verdict, different cause.
    const refused = await read(() => {
      tokdash.answer('usage', { json: usageFixture({ range: { from: '2026-08-01', to: '2026-08-31', recognized: false } }) });
      tokdash.answer('insights', { json: insightsFixture({ range: { from: '2026-08-01', to: '2026-08-31', recognized: false } }) });
    });
    expect(refused.range.recognized).toBe(false);
    expect(refused.runtime.belowMinimum).toBe(false);
  });

  test('a failed optional read empties only its own cells', async () => {
    const read = async (endpoint: 'insights' | 'active-time', answer: { status: number } | { json: unknown }): Promise<any> => {
      tokdash.answer(endpoint, answer);
      const body = await report(owner, openWindow());
      tokdash.reset();
      return body.data;
    };
    expect((await read('insights', { status: 500 })).insightsUnavailable).toBe('unavailable');
    const malformed = await read('insights', { json: [] });
    expect(malformed.insightsUnavailable).toBe('malformed');
    expect(malformed.hourly).toBeNull();

    const noActiveTime = await read('active-time', { status: 500 });
    expect(noActiveTime.activeTime).toBeNull();
    for (const tool of noActiveTime.tools) {
      expect([tool.sessions, tool.activeMs, tool.label]).toEqual([null, null, null]);
    }
    expect(noActiveTime.tools[0].tokens).toBe(10_088_964_020);
    expect(noActiveTime.sourceErrors).toEqual([]);

    tokdash.answer('usage', { json: usageFixture({ source_errors: ['kimi', 'grok'] }) });
    expect((await report(owner, openWindow())).data.sourceErrors).toEqual(['kimi', 'grok']);
    tokdash.reset();
  });

  test('a failed usage read fails the report without upstream detail, and is not remembered', async () => {
    const window = openWindow();
    tokdash.answer('usage', { status: 500 });
    const failed = await owner.get(reportPath(window));
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ ok: false, error: 'upstream-unavailable' });
    expect(failed.text).not.toContain('127.0.0.1');

    tokdash.answer('usage', { json: usageFixture({ total_tokens: null }) });
    expect((await owner.get(reportPath(openWindow()))).status).toBe(502);

    tokdash.reset();
    const since = tokdash.requests.length;
    const recovered = await report(owner, window);
    expect(recovered.servedFromCache).toBe(false);
    expect(recovered.data.totals.tokens).toBe(19_893_991_786);
    expect(tokdash.count('usage', { window, since })).toBe(1);
  });

  test('a window is checked before Tokdash is asked, and the client\'s all-time window passes', async () => {
    const since = tokdash.requests.length;
    const refusals: Array<[string, string, string]> = [
      ['2026-2-1', utcDay(0), 'from and to must be YYYY-MM-DD dates'],
      ['2026-02-30', '2026-03-02', 'from and to must be YYYY-MM-DD dates'],
      ['not-a-date', utcDay(0), 'from and to must be YYYY-MM-DD dates'],
      ['0001-01-01', '9999-12-31', 'range-too-early'],
      [utcDay(-1), utcDay(-5), 'range-inverted'],
      [utcDay(-1), utcDay(3), 'range-in-future'],
    ];
    for (const [from, to, error] of refusals) {
      const refused = await owner.get(`/api/tokdash/report?from=${from}&to=${to}`);
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ ok: false, code: 'BAD_PARAM', error });
    }
    expect((await owner.get('/api/tokdash/report')).status).toBe(400);
    expect(tokdash.since(since)).toEqual([]);

    // The widest window the app asks for: everything since its own floor.
    const allTime = await report(owner, { from: '2000-01-01', to: utcDay(0) });
    expect(allTime.data.totals.tokens).toBe(19_893_991_786);
  });

  test('concurrent readers of one window share a single scan', async () => {
    const window = openWindow();
    const hold = tokdash.hold('usage');
    const since = tokdash.requests.length;
    const readers = [report(owner, window), report(owner, window), report(owner, window)];
    await eventually(() => hold.held() >= 1, { what: 'the first scan to reach Tokdash' });
    hold.release();
    const bodies = await Promise.all(readers);
    expect(bodies.filter((body) => body.servedFromCache === false)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.cachedAt)).size).toBe(1);
    expect(tokdash.count('usage', { window, since })).toBe(1);
    expect(tokdash.count('insights', { window, since })).toBe(1);
  });

  test('distinct windows queue behind the scan limit instead of all reaching Tokdash', async () => {
    const windows = [openWindow(), openWindow(), openWindow(), openWindow()];
    const hold = tokdash.hold('usage');
    const readers = windows.map((window) => report(owner, window));
    await eventually(() => hold.held() >= 2, { what: 'two scans held at Tokdash' });
    // No sentinel marks "the other two are queued", so give them a short chance to escape.
    await never(() => hold.held() > 2, scaled(500), 'a third concurrent scan');
    hold.release();
    const bodies = await Promise.all(readers);
    expect(bodies.every((body) => body.servedFromCache === false)).toBe(true);
    expect(tokdash.peakInFlight('usage')).toBe(2);
    tokdash.reset();
  });

  test('a paired device sees the same counts without project names', async () => {
    const window = openWindow();
    const own = (await report(owner, window)).data;
    expect(own.projects.rows.map((row: any) => row.project)).toEqual(PROJECT_NAMES);

    const device = await pairDevice(owner, { peerId: 'usage-phone' });
    const phone = owner.as({ kind: 'peer', peerToken: device.peerToken });
    const response = await phone.get(reportPath(window));
    expect(response.status).toBe(200);
    const theirs = response.body.data;
    expect(theirs.projects).toBeNull();
    expect(theirs.projectsUnavailable).toBe('owner-only');
    expect(theirs.insightsUnavailable).toBeNull();
    expect(theirs.totals).toEqual(own.totals);
    expect(theirs.tools).toEqual(own.tools);
    expect(theirs.daily).toEqual(own.daily);
    for (const name of PROJECT_NAMES) expect(response.text).not.toContain(name);
    // The owner's copy was not the one trimmed.
    expect((await report(owner, window)).data.projects.rows).toHaveLength(2);

    // An old Tokdash never served projects; the device is not told it is a matter of scope.
    tokdash.answer('insights', { status: 404 });
    const old = (await report(phone, openWindow())).data;
    expect(old.projectsUnavailable).toBeNull();
    expect(old.insightsUnavailable).toBe('unsupported');
    tokdash.reset();
  });

  test('the usage summary answers from the first Tokdash path that responds', async () => {
    const summary = await owner.get('/api/tokdash/usage');
    expect(summary.status).toBe(200);
    expect(summary.body.endpoint).toBe('/api/usage');
    expect(summary.body.data.total_tokens).toBe(19_893_991_786);

    tokdash.outage(true);
    const down = await owner.get('/api/tokdash/usage');
    expect(down.status).toBe(502);
    expect(down.body.checked).toEqual([
      '/api/usage/summary', '/api/usage/today', '/api/usage', '/usage/summary', '/usage/today', '/usage',
    ]);
    tokdash.reset();
  });
});

describe('finished windows and preferences survive a restart', () => {
  const kept = finishedWindow(2);
  const degraded = finishedWindow(3);
  const repriced = finishedWindow(4);
  const overridden = finishedWindow(5);
  const changedMidScan = finishedWindow(6);
  const idle = finishedWindow(7);
  // Finished, but longer than any period the app keeps.
  const unbounded = { from: '2000-01-01', to: localDay(-14) };
  let keptCachedAt: number;
  let keptReadFrom: number;

  test('a finished window is read fresh from Tokdash once, then answered from memory with no read at all', async () => {
    let since = tokdash.requests.length;
    keptReadFrom = Date.now();
    const first = await report(owner, kept);
    expect(first.servedFromCache).toBe(false);
    keptCachedAt = first.cachedAt;
    // It may be kept for months, so it is built from a fresh scan, not Tokdash's own cache,
    // and under a pricing table the broker can name.
    const scans = tokdash.since(since).filter((request) => request.window !== undefined);
    expect(scans.map((request) => request.endpoint).sort()).toEqual(['active-time', 'insights', 'usage']);
    expect(scans.every((request) => request.query.get('refresh') === 'true')).toBe(true);
    expect(tokdash.count('pricing-db', { since })).toBeGreaterThan(0);

    since = tokdash.requests.length;
    const again = await report(owner, kept);
    expect(again.servedFromCache).toBe(true);
    expect(again.cachedAt).toBe(keptCachedAt);
    expect(tokdash.since(since)).toEqual([]);
  });

  test('a restarted broker answers kept windows from disk, rebuilds the rest, and keeps its settings', async () => {
    tokdash.answer('insights', { status: 500 }, degraded);
    expect((await report(owner, degraded)).data.insightsUnavailable).toBe('unavailable');
    tokdash.reset();
    await report(owner, repriced);
    // A pricing override names no table, so nothing derived under it is kept.
    tokdash.answer('pricing-db', { json: { source: 'override', baseline_version: '2.0.25' } });
    await report(owner, overridden);
    tokdash.reset();
    // Tokdash is upgraded while a scan is running: the result is served, never kept.
    const hold = tokdash.hold('usage');
    const midScan = report(owner, changedMidScan);
    await eventually(() => hold.held() === 1, { what: 'the scan to reach Tokdash' });
    tokdash.answer('version', { json: versionFixture({ runtime_version: '2.5.4' }) });
    hold.release();
    expect((await midScan).data.runtime.version).toBe('2.5.4');
    tokdash.reset();
    await report(owner, unbounded);
    // An idle week is a complete answer of zeros, and is kept like any other.
    tokdash.answer('usage', { json: usageFixture({ range: { from: idle.from, to: idle.to, recognized: true }, total_tokens: 0, total_cost: 0, total_messages: 0, by_tool: {}, coding_apps: {} }) }, idle);
    tokdash.answer('active-time', { json: activeTimeFixture({ active_ms: 0, active_ms_sum: 0, by_tool: {} }) }, idle);
    tokdash.answer('insights', {
      json: insightsFixture({
        range: { from: idle.from, to: idle.to, recognized: true },
        hourly: { buckets: [], peak_hour: null, night_share: null, night_hours: [] },
        weekday: { buckets: [], peak_weekday: null },
        daily: [],
        projects: { projects: [], unattributed: { tokens: 0, cost: 0, messages: 0 }, attributed_project_count: 0, names_included: true },
        streaks: { current_streak: 0, longest_streak: 0, active_days: 0, total_days: 7 },
        firsts: { first_active_day: null, last_active_day: null, busiest_day: null, busiest_day_tokens: null },
      }),
    }, idle);
    expect((await report(owner, idle)).data.totals.tokens).toBe(0);
    tokdash.reset();
    // A low quota warning, active when the broker stops.
    tokdash.answer('quota', lowCodexQuota(15));
    await owner.post('/api/tokdash/quota-preference', { enabled: true });
    const warning = (await quotaWarnings(owner)).find((event) => event.state === 'active');
    expect(warning).toBeDefined();

    // Quota recovered while the broker was down.
    tokdash.answer('quota', lowCodexQuota(70));
    await broker.restart();
    owner = broker.client();

    let since = tokdash.requests.length;
    const fromDisk = await report(owner, kept);
    expect(fromDisk.servedFromCache).toBe(true);
    // Its age is the age of the data, not of the restart.
    expect(fromDisk.cachedAt).toBeGreaterThanOrEqual(keptReadFrom);
    expect(fromDisk.cachedAt).toBeLessThanOrEqual(keptCachedAt);
    expect(fromDisk.data.totals.tokens).toBe(19_893_991_786);
    expect(tokdash.count('usage', { window: kept, since })).toBe(0);
    expect(tokdash.count('insights', { window: kept, since })).toBe(0);

    // Now in memory: a Tokdash outage costs the reader nothing.
    tokdash.outage(true);
    since = tokdash.requests.length;
    expect((await report(owner, kept)).data.totals.tokens).toBe(19_893_991_786);
    expect(tokdash.since(since)).toEqual([]);
    tokdash.outage(false);

    // The idle week came back from disk: zeros are an answer, not a hole.
    since = tokdash.requests.length;
    const idleFromDisk = await report(owner, idle);
    expect(idleFromDisk.servedFromCache).toBe(true);
    expect(idleFromDisk.data.totals.tokens).toBe(0);
    expect(tokdash.count('usage', { window: idle, since })).toBe(0);

    // A report with a hole in it, one priced by an override, one whose Tokdash changed
    // under it, and one too long to keep were never kept.
    for (const window of [degraded, overridden, changedMidScan, unbounded]) {
      since = tokdash.requests.length;
      const rebuilt = await report(owner, window);
      expect(rebuilt.servedFromCache).toBe(false);
      expect(tokdash.count('usage', { window, since })).toBe(1);
    }
    expect((await report(owner, degraded)).data.insightsUnavailable).toBeNull();

    // A new pricing table retires every window derived under the old one.
    tokdash.answer('pricing-db', { json: { source: 'baseline', baseline_version: '2.0.26' } });
    since = tokdash.requests.length;
    const repricedAgain = await report(owner, repriced);
    expect(repricedAgain.servedFromCache).toBe(false);
    expect(tokdash.count('usage', { window: repriced, since })).toBe(1);

    // The preference outlived the process, and the warning the old process raised is
    // resolved by the new one's first reconciliation.
    expect((await owner.get('/api/tokdash/quota-preference')).body.enabled).toBe(true);
    await eventually(async () => {
      const events = await quotaWarnings(owner);
      return events.find((event) => event.id === warning.id)?.state === 'resolved';
    }, { what: 'the stale quota warning to resolve after the restart' });
    tokdash.reset();
  });
});

describe('a refused Tokdash override', () => {
  test('is reported at startup without echoing the value', async () => {
    const output = await eventually(() => {
      const text = refusedOverride.output();
      return text.includes('ignoring COSYNCING_TOKDASH_URL') ? text : undefined;
    }, { what: 'the startup refusal of the Tokdash override' });
    expect(output).toContain('ignoring COSYNCING_TOKDASH_URL (value withheld): it embeds credentials');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('reader:');
  });
});
