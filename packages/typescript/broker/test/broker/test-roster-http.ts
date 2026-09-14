#!/usr/bin/env bun
/**
 * Unit coverage for the roster HTTP helpers (packages/typescript/broker/src/roster/roster-http.ts): Accept-Encoding
 * q-value negotiation (incl. gzip;q=0), the recency window filter, and the gzip + weak-ETag/304 JSON
 * response. Pure functions → no broker spawn needed.
 *
 *   bun run packages/typescript/broker/test/broker/test-roster-http.ts
 */
export {};
import { join } from 'node:path';
import {
  AgentRegistry,
  type SessionDiscoveryOptions,
} from '../../../adapter-api/src/index.ts';
import {
  acceptsGzip,
  filterRosterDeltasByWindow,
  filterSessionsByWindow,
  ifNoneMatchMatches,
  jsonMaybe,
  parseSessionWindowMs,
  rosterRepresentationIsReusable,
  sessionWindowRepresentationExpiry,
} from '../../src/roster/roster-http.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const reqWith = (headers: Record<string, string>) => new Request('http://x/api/sessions', { headers });

let receivedUpdatedAfter: number | undefined;
const registry = new AgentRegistry();
registry.register({
  id: 'bounded-test',
  displayName: 'Bounded test',
  capabilities: {},
  isAvailable: async () => true,
  discoverSessions: async (options?: SessionDiscoveryOptions) => {
    receivedUpdatedAfter = options?.updatedAfter;
    return [];
  },
} as any);
await registry.discoverAll({ updatedAfter: 123_456 });
check(
  'registry forwards the authoritative cutoff into adapter discovery',
  receivedUpdatedAfter === 123_456,
);

// ---- acceptsGzip: q-values ---------------------------------------------------------------------
check('acceptsGzip: "gzip" → true', acceptsGzip(reqWith({ 'accept-encoding': 'gzip' })) === true);
check('acceptsGzip: "gzip, deflate, br" → true', acceptsGzip(reqWith({ 'accept-encoding': 'gzip, deflate, br' })) === true);
check('acceptsGzip: "gzip;q=0" → false (the review bug)', acceptsGzip(reqWith({ 'accept-encoding': 'gzip;q=0' })) === false);
check('acceptsGzip: "gzip;q=0.001" → true', acceptsGzip(reqWith({ 'accept-encoding': 'gzip;q=0.001' })) === true);
check('acceptsGzip: "deflate, gzip;q=0" → false', acceptsGzip(reqWith({ 'accept-encoding': 'deflate, gzip;q=0' })) === false);
check('acceptsGzip: "*" wildcard → true', acceptsGzip(reqWith({ 'accept-encoding': '*' })) === true);
check('acceptsGzip: "*;q=0" → false', acceptsGzip(reqWith({ 'accept-encoding': '*;q=0' })) === false);
check('acceptsGzip: explicit gzip;q=0 beats *;q=1', acceptsGzip(reqWith({ 'accept-encoding': '*, gzip;q=0' })) === false);
check('acceptsGzip: "identity" only → false', acceptsGzip(reqWith({ 'accept-encoding': 'identity' })) === false);
check('acceptsGzip: no header → false', acceptsGzip(reqWith({})) === false);
check('acceptsGzip: undefined req → false', acceptsGzip(undefined) === false);

// ---- parseSessionWindowMs ----------------------------------------------------------------------
const DAY = 86_400_000;
check('window 1d → 1 day', parseSessionWindowMs('1d') === DAY);
check('window 7d → 7 days', parseSessionWindowMs('7d') === 7 * DAY);
check('window 1m → 30 days', parseSessionWindowMs('1m') === 30 * DAY);
check('window 2m → 60 days', parseSessionWindowMs('2m') === 60 * DAY);
check('window 6m → 180 days', parseSessionWindowMs('6m') === 180 * DAY);
check('window all → undefined', parseSessionWindowMs('all') === undefined);
check('window null → undefined', parseSessionWindowMs(null) === undefined);
check('window garbage → undefined', parseSessionWindowMs('lol') === undefined);

// ---- filterSessionsByWindow --------------------------------------------------------------------
const NOW = 1_000 * DAY;
const rows = [
  { id: 'recent-idle', status: 'idle', updatedAt: NOW - 1 * DAY },
  { id: 'old-idle', status: 'idle', updatedAt: NOW - 100 * DAY },
  { id: 'old-working', status: 'working', updatedAt: NOW - 100 * DAY },
  { id: 'old-needs-input', status: 'needs-input', updatedAt: NOW - 100 * DAY },
  { id: 'no-timestamps-idle', status: 'idle' as const },
  { id: 'recent-by-createdAt', status: 'idle' as const, createdAt: NOW - 2 * DAY },
  { id: 'old-by-createdAt', status: 'idle' as const, createdAt: NOW - 100 * DAY },
];
const w7 = filterSessionsByWindow(rows, 7 * DAY, NOW).map((s) => s.id);
check('7d keeps recent idle', w7.includes('recent-idle'));
check('7d drops old idle', !w7.includes('old-idle'));
check('7d ALWAYS keeps old working (non-idle)', w7.includes('old-working'));
check('7d ALWAYS keeps old needs-input (non-idle)', w7.includes('old-needs-input'));
// The measured macOS defect: a live connection's timestamp-free SessionInfo was the only surviving
// record of a 24-day-old rollout under 7d, and this filter admitted it. A row the client cannot place
// on a timeline belongs to no bounded window.
check('7d DROPS un-datable idle (a row no client can place on a timeline)', !w7.includes('no-timestamps-idle'));
check('7d keeps recent idle dated via createdAt fallback', w7.includes('recent-by-createdAt'));
check('7d drops old idle dated via createdAt fallback', !w7.includes('old-by-createdAt'));
check('all (undefined) returns every row unchanged', filterSessionsByWindow(rows, undefined, NOW).length === rows.length);
check(
  'an un-datable session is still reachable — the all window is where it lives',
  filterSessionsByWindow(rows, undefined, NOW).some((s) => s.id === 'no-timestamps-idle'),
);
check(
  'an un-datable NON-idle session is never hidden by any window',
  filterSessionsByWindow(
    [{ id: 'undated-working', status: 'working' as const }],
    7 * DAY,
    NOW,
  ).length === 1,
);
check(
  'every bounded window drops it, not only the narrow ones',
  [DAY, 7 * DAY, 30 * DAY, 180 * DAY].every(
    (span) => !filterSessionsByWindow(rows, span, NOW).some((s) => s.id === 'no-timestamps-idle'),
  ),
);
// The whole shape of the macOS report: 39 sessions, newest 24 days old, plus one undatable live
// overlay. Before the fix `7d` answered with exactly that one row.
const macShape = [
  ...Array.from({ length: 39 }, (_, index) => ({
    id: `aged-${index}`,
    status: 'idle' as const,
    updatedAt: NOW - (24 + index) * DAY,
  })),
  { id: 'live-overlay-undated', status: 'idle' as const },
];
check(
  'a roster whose newest session predates the window answers empty, not with a ghost row',
  filterSessionsByWindow(macShape, 7 * DAY, NOW).length === 0,
);
check(
  'the same roster is complete at 30 days and at all time',
  // Ages 24..30 inclusive — seven of the thirty-nine — plus the undatable row only at all time.
  filterSessionsByWindow(macShape, 30 * DAY, NOW).length === 7
    && filterSessionsByWindow(macShape, undefined, NOW).length === 40,
);
check(
  '7d representation expires when its oldest included idle row crosses cutoff',
  sessionWindowRepresentationExpiry(
    [
      { status: 'idle', updatedAt: NOW - 2 * DAY },
      { status: 'idle', updatedAt: NOW - 1 * DAY },
      { status: 'working', updatedAt: NOW - 100 * DAY },
    ],
    7 * DAY,
  ) === NOW + 5 * DAY,
);
check(
  'all-time representation has no wall-clock expiry',
  sessionWindowRepresentationExpiry(rows, undefined) === undefined,
);

const windowedDeltas = filterRosterDeltasByWindow([
  {
    revision: 1,
    machine: 'm',
    tool: 'codex',
    sessionId: 'old-idle',
    changedFields: ['session'],
    session: rows[1]!,
  },
  {
    revision: 2,
    machine: 'm',
    tool: 'codex',
    sessionId: 'recent-idle',
    changedFields: ['session'],
    session: rows[0]!,
  },
], 7 * DAY, NOW);
check(
  '7d delta body does not transfer an old idle session payload',
  windowedDeltas[0] !== undefined &&
    'removed' in windowedDeltas[0] &&
    windowedDeltas[0].removed === true &&
    windowedDeltas[0].session === undefined,
);
check(
  '7d delta body retains a recent session payload',
  windowedDeltas[1]?.session?.id === 'recent-idle',
);
// Revision continuity over the same reversal: a row that leaves a bounded view for being undatable
// leaves it as a removal at its own revision, so the client advances its cursor rather than being
// handed a gap it has to resynchronise to notice.
const undatableDeltas = filterRosterDeltasByWindow([
  {
    revision: 7,
    machine: 'm',
    tool: 'codex',
    sessionId: 'no-timestamps-idle',
    changedFields: ['session'],
    session: rows[4]!,
  },
], 7 * DAY, NOW);
const undatableDelta = undatableDeltas[0];
check(
  'an un-datable idle row leaves a bounded view as a transcript-free removal',
  undatableDelta !== undefined
    && undatableDelta.revision === 7
    && 'removed' in undatableDelta
    && undatableDelta.removed === true
    && undatableDelta.session === undefined
    && undatableDelta.sessionId === 'no-timestamps-idle',
);
check(
  'the all window still carries the same row as a full payload',
  filterRosterDeltasByWindow([
    {
      revision: 7,
      machine: 'm',
      tool: 'codex',
      sessionId: 'no-timestamps-idle',
      changedFields: ['session'],
      session: rows[4]!,
    },
  ], undefined, NOW)[0]?.session?.id === 'no-timestamps-idle',
);

// ---- jsonMaybe: gzip + ETag + 304 --------------------------------------------------------------
const big = { machine: 'm', sessions: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: 'a session title padding to exceed the gzip threshold', status: 'idle' })) };

const gz = jsonMaybe(reqWith({ 'accept-encoding': 'gzip' }), big, { etag: true, cacheControl: 'no-cache' });
check('jsonMaybe gzips when accepted', gz.headers.get('content-encoding') === 'gzip', `ce=${gz.headers.get('content-encoding')}`);
check('jsonMaybe sets Vary: accept-encoding', gz.headers.get('vary') === 'accept-encoding');
check('jsonMaybe sets a weak ETag', (gz.headers.get('etag') ?? '').startsWith('W/"'), `etag=${gz.headers.get('etag')}`);
check('jsonMaybe sets Cache-Control: no-cache', gz.headers.get('cache-control') === 'no-cache');
const gzBytes = new Uint8Array(await gz.arrayBuffer());
const roundTrip = JSON.parse(Buffer.from(Bun.gunzipSync(gzBytes)).toString('utf8'));
check('gzipped body round-trips to the original JSON', roundTrip.sessions.length === 200);

const plain = jsonMaybe(reqWith({ 'accept-encoding': 'gzip;q=0' }), big, { etag: true });
check('jsonMaybe does NOT gzip for gzip;q=0', plain.headers.get('content-encoding') === null, `ce=${plain.headers.get('content-encoding')}`);
check('un-gzipped body is valid JSON', (JSON.parse(await plain.text())).sessions.length === 200);

const etag = gz.headers.get('etag')!;
const notModified = jsonMaybe(reqWith({ 'accept-encoding': 'gzip', 'if-none-match': etag }), big, { etag: true, cacheControl: 'no-cache' });
check('matching If-None-Match → 304', notModified.status === 304, `status=${notModified.status}`);
check('304 carries the ETag and no body', notModified.headers.get('etag') === etag && (await notModified.text()) === '');
const stillFull = jsonMaybe(reqWith({ 'accept-encoding': 'gzip', 'if-none-match': 'W/"stale"' }), big, { etag: true });
check('non-matching If-None-Match → 200 body', stillFull.status === 200);

// ---- ifNoneMatchMatches: RFC 7232 list / wildcard / weak compare -------------------------------
check('INM: null header → false', ifNoneMatchMatches(null, 'W/"a"') === false);
check('INM: exact weak match → true', ifNoneMatchMatches('W/"a"', 'W/"a"') === true);
check('INM: wildcard "*" → true', ifNoneMatchMatches('*', 'W/"a"') === true);
check('INM: list containing the tag → true', ifNoneMatchMatches('W/"x", W/"a", W/"y"', 'W/"a"') === true);
check('INM: list without the tag → false', ifNoneMatchMatches('W/"x", W/"y"', 'W/"a"') === false);
check('INM: strong-form candidate weak-matches our weak tag', ifNoneMatchMatches('"a"', 'W/"a"') === true);
check('INM: no match → false', ifNoneMatchMatches('W/"stale"', 'W/"a"') === false);

const wildcard304 = jsonMaybe(reqWith({ 'accept-encoding': 'gzip', 'if-none-match': '*' }), big, { etag: true, cacheControl: 'no-cache' });
check('jsonMaybe: If-None-Match "*" → 304', wildcard304.status === 304, `status=${wildcard304.status}`);
const list304 = jsonMaybe(reqWith({ 'accept-encoding': 'gzip', 'if-none-match': `W/"nope", ${etag}` }), big, { etag: true });
check('jsonMaybe: If-None-Match list containing our tag → 304', list304.status === 304, `status=${list304.status}`);

const small = jsonMaybe(reqWith({ 'accept-encoding': 'gzip' }), { ok: true });
check('tiny body is not gzipped (below threshold)', small.headers.get('content-encoding') === null);

// ---- rosterRepresentationIsReusable: what may still answer 304 ----------------------------------
//
// The INCOMPLETE case is the one with teeth. A roster served ahead of its sweep
// can reconcile to exactly the same rows, so the revision never moves -- and
// since a 304 returns above discovery, the poll that would notice the roster is
// now complete never runs. Without this rule a client holds `complete: false`
// forever on a roster that was complete all along.
const reusable = (over: Partial<Parameters<typeof rosterRepresentationIsReusable>[0]> & object = {}) =>
  rosterRepresentationIsReusable(
    { revision: 7, complete: true, ...over },
    { force: false, revision: 7, now: 1_000 },
  );
check('reusable: complete body at the current revision → 304 allowed', reusable() === true);
check('reusable: incomplete body is never reusable, even at the current revision',
  reusable({ complete: false }) === false);
check('reusable: a moved revision retires the body', reusable({ revision: 6 }) === false);
check('reusable: an expired window cutoff retires the body',
  reusable({ expiresAt: 1_000 }) === false);
check('reusable: a cutoff still in the future does not',
  reusable({ expiresAt: 1_001 }) === true);
check('reusable: refresh=1 never reuses',
  rosterRepresentationIsReusable({ revision: 7, complete: true }, { force: true, revision: 7, now: 1_000 }) === false);
check('reusable: nothing cached is not reusable',
  rosterRepresentationIsReusable(undefined, { force: false, revision: 7, now: 1_000 }) === false);

// ── the early answer is gated on the caller's declared revision ─────────────
//
// `BROKER_MINIMUM_CLIENT_CONTRACT_REVISION` stays at 17 across revision 23, and
// that is only honest if a pre-22 caller never meets the condition `complete`
// exists to describe. The gate is one argument at the /api/sessions call site,
// which is exactly the kind of thing a later edit drops without noticing -- the
// withheld-adapter list was computed and then discarded the same way. Asserted
// against the source because the route is a closure with no test seam.
{
  const runtimeSource = await Bun.file(
    join(import.meta.dir, '..', '..', 'src', 'runtime', 'runtime.ts'),
  ).text();
  check(
    '/api/sessions asks for an early answer only when the caller declares revision 23+',
    /discoverLocalRoster\(\s*\n\s*force \|\| cutoffExpired,\s*\n\s*windowMs,\s*\n\s*requestNow,\s*\n\s*parseAgentRosterClientRevision\(url\.searchParams\) >= CLIENT_REVISION_WITH_ROSTER_COMPLETENESS,/
      .test(runtimeSource),
  );
  check(
    'and the flag it publishes is the sweep\'s coverage, not the filtered row count',
    /complete: roster\.coverage\.kind === 'complete'/.test(runtimeSource),
  );
}

{
  const protocolSource = await Bun.file(
    join(import.meta.dir, '..', '..', '..', 'protocol', 'src', 'index.ts'),
  ).text();
  check(
    'the gate constant is the contract revision that introduced the flag',
    /CLIENT_REVISION_WITH_ROSTER_COMPLETENESS = 23 as const/.test(protocolSource)
      && /BROKER_CONTRACT_REVISION = 23 as const/.test(protocolSource),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} roster-http checks passed.`);
if (failed.length) process.exit(1);
