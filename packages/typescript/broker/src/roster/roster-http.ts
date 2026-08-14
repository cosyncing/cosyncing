/**
 * Pure HTTP helpers for the roster endpoint (`GET /api/sessions`), split out of `main.ts` so they can be
 * unit-tested without importing `main.ts` (which starts a `Bun.serve` at import time). Covers content
 * negotiation (gzip q-values), the recency window filter, and the gzip + weak-ETag/304 JSON response.
 */

const DAY_MS = 86_400_000;

/** Map the roster `?window=` value to a max age in ms, or undefined for "all"/unset (no filter). */
export function parseSessionWindowMs(v: string | null): number | undefined {
  switch ((v ?? '').trim()) {
    case '1d': return DAY_MS;
    case '7d': return 7 * DAY_MS;
    case '1m': return 30 * DAY_MS;
    case '2m': return 60 * DAY_MS;
    case '6m': return 180 * DAY_MS;
    default: return undefined; // 'all', '', or anything unrecognized → no filter
  }
}

/** Filter a roster to sessions active within `windowMs` (by `updatedAt`, falling back to `createdAt`).
 *  Two classes are ALWAYS kept regardless of age, so a window never hides something the user can't get
 *  back another way: (1) non-idle sessions (working / needs-input — they need the user), and (2) idle
 *  sessions with NO timestamp at all — an un-datable session (e.g. an adapter regression that dropped
 *  `updatedAt`) must not silently vanish from every narrow window with no error. `windowMs === undefined`
 *  (the "all" window) returns the list unchanged. */
export function filterSessionsByWindow<T extends { status: string; updatedAt?: number; createdAt?: number }>(
  sessions: T[],
  windowMs: number | undefined,
  now: number,
): T[] {
  if (windowMs === undefined) return sessions;
  const cutoff = now - windowMs;
  return sessions.filter((s) => {
    if (s.status !== 'idle') return true; // working / needs-input — never age out
    const ts = s.updatedAt ?? s.createdAt;
    return ts === undefined ? true : ts >= cutoff; // un-datable idle → keep; otherwise within the window
  });
}

/** Apply the same cutoff to the live journal without breaking revision
 * continuity. An out-of-window session becomes a transcript-free removal, so
 * the client advances its cursor and cannot decode or resurrect the row. */
export function filterRosterDeltasByWindow<
  T extends { status: string; updatedAt?: number; createdAt?: number },
  D extends {
    revision: number;
    machine: string;
    tool: string;
    sessionId: string;
    changedFields: string[];
    session?: T;
    removed?: true;
  },
>(deltas: D[], windowMs: number | undefined, now: number): D[] {
  if (windowMs === undefined) return deltas;
  return deltas.map((delta) => {
    if (
      delta.removed ||
      !delta.session ||
      filterSessionsByWindow([delta.session], windowMs, now).length > 0
    ) {
      return delta;
    }
    return {
      revision: delta.revision,
      machine: delta.machine,
      tool: delta.tool,
      sessionId: delta.sessionId,
      changedFields: ['removed'],
      removed: true,
    } as D;
  });
}

/** First instant an included idle row ages out of a windowed representation.
 *
 * A roster revision does not change as wall time passes, so ETag caches must
 * expire at this boundary instead of returning 304 forever. */
export function sessionWindowRepresentationExpiry<
  T extends { status: string; updatedAt?: number; createdAt?: number },
>(sessions: T[], windowMs: number | undefined): number | undefined {
  if (windowMs === undefined) return undefined;
  let earliest: number | undefined;
  for (const session of sessions) {
    if (session.status !== 'idle') continue;
    const timestamp = session.updatedAt ?? session.createdAt;
    if (timestamp === undefined) continue;
    const expiry = timestamp + windowMs;
    earliest = earliest === undefined ? expiry : Math.min(earliest, expiry);
  }
  return earliest;
}

/** Whether the client accepts gzip per Accept-Encoding, honoring q-values (`gzip;q=0` means "no", and a
 *  `*` wildcard applies when gzip isn't named). A plain substring check would wrongly gzip `gzip;q=0`. */
export function acceptsGzip(req: Request | undefined): boolean {
  const header = req?.headers.get('accept-encoding');
  if (!header) return false;
  let gzipQ: number | undefined;
  let wildcardQ: number | undefined;
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';');
    const token = (tokenRaw ?? '').trim().toLowerCase();
    if (token !== 'gzip' && token !== '*') continue;
    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q=([0-9]*\.?[0-9]+)$/i);
      if (m) q = Number(m[1]);
    }
    if (token === 'gzip') gzipQ = q;
    else wildcardQ = q;
  }
  return (gzipQ ?? wildcardQ ?? 0) > 0;
}

/** RFC 7232 If-None-Match test for our weak ETags: `*` matches any current representation, otherwise the
 *  header is a comma-separated list of entity-tags, each compared to `tag` with the WEAK comparison (the
 *  `W/` prefix is ignored on both sides). Our own client sends exactly one weak tag, but a proxy/browser
 *  cache may send a list or `*` — plain `===` would miss those and force a needless full 200. */
export function ifNoneMatchMatches(header: string | null, tag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//i, '');
  const want = opaque(tag);
  for (const raw of header.split(',')) {
    const candidate = raw.trim();
    if (candidate === '*') return true;
    if (opaque(candidate) === want) return true;
  }
  return false;
}

/** JSON response that gzips when the client accepts it and the body is worth it, with an optional weak
 *  ETag → 304 on a matching If-None-Match. Built for the roster: its ~2 MB payload is re-polled every
 *  few seconds, and a phone over the tailnet was starving on it (gzip ~10×; 304 skips it entirely when
 *  unchanged). `cache-control: no-cache` lets a manual If-None-Match round-trip without a stale cache hit. */
export function jsonMaybe(req: Request, data: unknown, opts: { etag?: boolean; cacheControl?: string } = {}): Response {
  const bodyStr = JSON.stringify(data);
  const headers: Record<string, string> = { 'content-type': 'application/json', vary: 'accept-encoding' };
  if (opts.cacheControl) headers['cache-control'] = opts.cacheControl;
  if (opts.etag) {
    const tag = `W/"${Bun.hash(bodyStr).toString(16)}"`;
    headers.etag = tag;
    if (ifNoneMatchMatches(req.headers.get('if-none-match'), tag)) return new Response(null, { status: 304, headers });
  }
  if (acceptsGzip(req) && Buffer.byteLength(bodyStr) >= 1024) {
    headers['content-encoding'] = 'gzip';
    return new Response(Bun.gzipSync(Buffer.from(bodyStr)), { headers });
  }
  return new Response(bodyStr, { headers });
}
