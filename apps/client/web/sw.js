/* Cosyncing static-asset service worker (N3 part B).
 *
 * SOURCE OF TRUTH. `flutter build web` copies this file verbatim into
 * build/web/, and `scripts/client/build-web-cache.ts` then replaces the three
 * __COSYNCING_*__ placeholders below with the manifest computed from the real
 * build output. The build output is generated; edit this file, never that one.
 *
 * What it caches
 * --------------
 * Only immutable/versioned static build artefacts, split into two sets:
 *
 *  * PRECACHE — everything that carries application identity (the HTML shell,
 *    flutter_bootstrap.js, flutter.js, main.dart.js, the asset bundle, icons,
 *    manifest, version.json). Fetched atomically during `install`, each entry
 *    verified against the hash this worker was stamped with. If any entry fails
 *    or does not match, the install fails, its partial cache is removed, the
 *    new worker never activates, and the previous version keeps serving its own
 *    complete cache. That is what makes a failed update incapable of producing
 *    a mixed-version app: app code is never half-replaced.
 *
 *  * RUNTIME — the large engine/runtime binaries whose URL set is fixed by the
 *    same manifest but which are only needed once the browser has chosen a
 *    variant (canvaskit/skwasm builds, sqlite3.wasm, drift_worker.js). These
 *    are stored into the SAME version-scoped cache on first successful fetch,
 *    so a repeat/offline start after one successful visit works without
 *    downloading ~40 MB of unused variants at install time.
 *
 * Both sets are CLOSED: a URL that is in neither list is never read from nor
 * written to the cache. That is the bound on cache size — it can never exceed
 * the bytes of one build's listed assets — and it is what keeps runtime data
 * out by construction rather than by convention.
 *
 * What it must never touch
 * ------------------------
 * Broker API responses, WebSocket traffic, credentials, profiles, drafts,
 * outbox/notification mutations and every other runtime request. Three
 * independent guards:
 *
 *  1. Scope. The worker is registered from the app's base href (`/cosy/` in
 *     release builds), so `/api/*`, `/pi/bridge/*`, `/claude/hook/*` and the
 *     `/api/sessions/:tool/:id/stream` upgrade are outside its scope and never
 *     reach this file at all.
 *  2. Method/mode. Anything that is not a same-origin GET — and any request
 *     whose destination is a WebSocket or EventSource — is passed straight
 *     through untouched.
 *  3. Allowlist. Even inside scope, only URLs present in the build manifest are
 *     served from or written to the cache.
 *
 * `scripts/client/tests/test-web-static-cache.ts` drives this file's real
 * handlers against a fake ServiceWorker environment and fails if any runtime
 * route is cached, if an obsolete cache survives activation, or if a
 * non-manifest URL is stored.
 */
'use strict';

/** Content hash of this build's manifest; the cache name is derived from it. */
const BUILD_VERSION = '__COSYNCING_BUILD_VERSION__';

/** Atomic install set: everything carrying application identity. */
const PRECACHE_URLS = __COSYNCING_PRECACHE_URLS__;

/** Lazily filled, same version-scoped cache: large immutable engine binaries. */
const RUNTIME_URLS = __COSYNCING_RUNTIME_URLS__;

/**
 * SHA-256 of every cacheable file, keyed by manifest path.
 *
 * Flutter web content-hashes no URL, so `canvaskit/canvaskit.wasm` addresses
 * different bytes before and after a deployment. A page still running the
 * previous build that lazy-loads such a URL would otherwise receive — and this
 * worker would store, into the previous build's own cache — bytes belonging to
 * the NEW build. Waiting to activate does not help: the fetch handler is the
 * old worker's, and the server has already moved on. Every response is
 * therefore checked against the hash THIS worker was stamped with, and a
 * mismatch is refused rather than served.
 */
const ASSET_HASHES = __COSYNCING_ASSET_HASHES__;

/** Scope URL, used to resolve manifest entries and to recognise navigations. */
const SCOPE_URL = new URL(self.registration ? self.registration.scope : './', self.location.href);

/**
 * Cache ownership is scoped, not origin-global.
 *
 * A single origin can host more than one app, and more than one Cosyncing
 * installation (`/cosy/`, `/staging/cosy/`, a reverse-proxied prefix). A bare
 * `cosyncing-app-*` prefix would make every one of them a candidate for another
 * one's cleanup, so the normalized scope path is part of the name and every
 * sweep below matches on it. Nothing outside this scope is ever deleted.
 */
const CACHE_PREFIX = `cosyncing-app:${SCOPE_URL.pathname}:`;

/** This build's cache. A new build means a new name, hence a clean swap. */
const CACHE_NAME = CACHE_PREFIX + BUILD_VERSION;

/**
 * Caches Flutter's now-deprecated bundled worker may have left behind.
 *
 * These names are generic and origin-global: another app on this origin can own
 * one. They are therefore never deleted outright — `pruneLegacyCache` removes
 * only the entries that are inside THIS scope, and drops the cache itself only
 * when that leaves it empty (i.e. it demonstrably held nothing else).
 */
const LEGACY_CACHE_NAMES = ['flutter-app-cache', 'flutter-temp-cache'];

/** Absolute URL of the app shell that answers every in-scope navigation. */
const SHELL_URL = new URL('index.html', SCOPE_URL).href;

/**
 * Cache key written when this build's worker activates.
 *
 * Not a real request — nothing ever fetches it — only a durable mark that this
 * cache belonged to a worker the browser actually promoted. An install sweeps
 * every unmarked cache with this scope's prefix, which is what stops a chain of
 * superseded or failed installs leaving abandoned build caches behind.
 */
const ACTIVATION_MARKER_URL = new URL('__cosyncing_activated__', SCOPE_URL).href;

function absolute(relative) {
  return new URL(relative, SCOPE_URL).href;
}

const PRECACHE_SET = new Set(PRECACHE_URLS.map(absolute));
const RUNTIME_SET = new Set(RUNTIME_URLS.map(absolute));
const HASH_BY_URL = new Map(
  Object.keys(ASSET_HASHES).map((path) => [absolute(path), ASSET_HASHES[path]]),
);

/** Whether this exact URL is a cacheable artefact of the current build. */
function isCacheableAsset(url) {
  return PRECACHE_SET.has(url) || RUNTIME_SET.has(url);
}

/** Lowercase hex SHA-256 of a buffer. */
async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let index = 0; index < bytes.length; index++) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Fetches one manifest URL and proves it is THIS build's copy of it.
 *
 * Returns the verified bytes, or null when the response is unusable: a
 * non-200/non-basic response, an unlisted URL, or — the case this exists for —
 * content whose hash is not the one this worker was stamped with, which means
 * the server is already serving a different build.
 */
async function fetchVerified(url) {
  const expected = HASH_BY_URL.get(url);
  if (expected === undefined) return null;
  // `reload` so an intermediate HTTP cache cannot satisfy this with a copy of
  // some other build; the hash check would only reject it a moment later.
  const response = await fetch(url, { cache: 'reload' });
  if (!response || response.status !== 200 || response.type !== 'basic') {
    return null;
  }
  const buffer = await response.arrayBuffer();
  const actual = await sha256Hex(buffer);
  if (actual !== expected) {
    console.warn(
      `cosyncing: refusing ${url} — it belongs to a different build ` +
        `(expected ${expected.slice(0, 12)}, got ${actual.slice(0, 12)})`,
    );
    return null;
  }
  return { buffer, headers: response.headers, statusText: response.statusText };
}

/** Builds a fresh Response over verified bytes. */
function responseFor(verified) {
  return new Response(verified.buffer, {
    status: 200,
    statusText: verified.statusText,
    headers: verified.headers,
  });
}

/**
 * Whether this request may be considered for the static cache at all.
 *
 * Deliberately conservative: a request has to be a same-origin, in-scope,
 * plain GET for a document or a static subresource. Everything else — POST,
 * PUT, PATCH, DELETE, WebSocket/EventSource destinations, `range` requests,
 * cross-origin fetches, anything with a query string (broker calls carry
 * parameters; build artefacts do not) — is left to the network untouched.
 */
function isStaticCandidate(request) {
  if (request.method !== 'GET') return false;
  if (request.destination === 'websocket') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return false;
  }
  if (url.origin !== SCOPE_URL.origin) return false;
  if (!url.href.startsWith(SCOPE_URL.href)) return false;
  if (url.search !== '') return false;
  return true;
}

/** Navigations inside scope are answered by the precached shell. */
function isShellNavigation(request) {
  return request.mode === 'navigate' && request.destination === 'document';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await deleteAbandonedCaches();
      const cache = await caches.open(CACHE_NAME);
      try {
        // Atomic: one rejection here aborts the install, so a partially fetched
        // new version is never promoted over a complete old one. Every entry is
        // hash-verified, so a deployment landing mid-install aborts too rather
        // than precaching a mixture of two builds.
        await Promise.all(
          PRECACHE_URLS.map(absolute).map(async (url) => {
            const verified = await fetchVerified(url);
            if (!verified) throw new Error(`cosyncing: cannot precache ${url}`);
            await cache.put(url, responseFor(verified));
          }),
        );
      } catch (error) {
        // Leaving the partial cache behind would accumulate one abandoned cache
        // per failed update, none of which any worker will ever activate to
        // clean up. It is ours and it is incomplete, so it goes now.
        await caches.delete(CACHE_NAME);
        throw error;
      }
      // DELIBERATELY NO skipWaiting().
      //
      // A page that is already open is running the previous build's
      // main.dart.js. Activating over it would let that page lazy-load the NEW
      // CanvasKit, Drift worker and assets — one document running two builds —
      // and the activate handler would delete the cache it is still reading
      // from. Waiting is what makes the swap coherent: this worker stays in
      // `waiting` until every client the old worker controls has gone, so the
      // old build keeps its own complete cache for as long as it is on screen,
      // and the next navigation gets the new build whole.
      //
      // N3b does not weaken this. It removes the requirement that the USER
      // close every tab, not the requirement that every tab be gone: open tabs
      // flush their durable state and move themselves to a page outside this
      // scope, the old worker retires with no controllees exactly as it does
      // today, and each tab returns to its route under the new build. There is
      // still no moment at which one document sees two builds.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // ORDER IS THE SAFETY PROPERTY HERE.
      //
      // Activation is the only place that destroys the previous build, and the
      // previous build is the device's fallback if this one turns out not to
      // work. So: everything that can fail runs BEFORE anything is deleted, and
      // the deleting itself is not allowed to fail activation. Any other order
      // has a path where a rejected activation leaves the device with no
      // complete build at all.

      // 1. Mark this cache. Storage can refuse a write (quota, eviction,
      //    CacheStorage unavailable). Failing here leaves the previous build
      //    whole and this one unmarked, which the next install sweeps.
      const cache = await caches.open(CACHE_NAME);
      await cache.put(ACTIVATION_MARKER_URL, new Response(BUILD_VERSION));

      // 2. Take over the clients. This can reject too, so it also happens while
      //    the previous cache is still intact. A build that could not claim its
      //    clients has not really taken over, so it must not look durable
      //    either — unmark it, best-effort, and rethrow.
      try {
        await self.clients.claim();
      } catch (error) {
        try {
          await cache.delete(ACTIVATION_MARKER_URL);
        } catch (unmarkError) {
          console.warn('cosyncing: could not unmark a failed activation', unmarkError);
        }
        throw error;
      }

      // 3. Cleanup, and nothing else. Reached only once no client controlled by
      //    the previous worker remains, so deleting its cache cannot pull an
      //    asset out from under a live page.
      //
      //    Settled, never awaited as a group: one storage error here means one
      //    leftover cache, and this activation has already succeeded. Rejecting
      //    it over a leftover would be the original hazard wearing a different
      //    hat — the previous cache is already gone by the time the sibling
      //    rejects. Unmarked leftovers are swept by the next install anyway.
      try {
        const names = await caches.keys();
        const swept = await Promise.allSettled(
          names.map((name) => {
            // Scope-local: only caches this exact installation owns.
            if (name.startsWith(CACHE_PREFIX)) {
              return name === CACHE_NAME ? null : caches.delete(name);
            }
            if (LEGACY_CACHE_NAMES.indexOf(name) !== -1) return pruneLegacyCache(name);
            return null;
          }),
        );
        for (const result of swept) {
          if (result.status === 'rejected') {
            console.warn('cosyncing: could not remove an obsolete cache', result.reason);
          }
        }
      } catch (error) {
        console.warn('cosyncing: obsolete cache cleanup failed', error);
      }
    })(),
  );
});

/**
 * Deletes caches with this scope's prefix that no worker ever activated.
 *
 * Activation cleans up the caches of BUILDS THAT RAN. It cannot clean up builds
 * that never ran: an install that fails, or one that is superseded while
 * waiting, leaves a cache no activate handler will ever visit. Those are
 * exactly the caches without the activation marker, and an install is the right
 * moment to sweep them — the currently active build always carries its marker,
 * so it is never a candidate.
 */
async function deleteAbandonedCaches() {
  const names = await caches.keys();
  await Promise.all(
    names.map(async (name) => {
      if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) return;
      const cache = await caches.open(name);
      const activated = await cache.match(ACTIVATION_MARKER_URL);
      if (!activated) await caches.delete(name);
    }),
  );
}

/**
 * Removes this build's own entries from a generically-named legacy Flutter
 * cache.
 *
 * Deliberately NOT "everything under this scope path": an app mounted deeper
 * (`/cosy/other/`) is inside this scope's prefix but is not this app, and its
 * entries are not ours to delete. Only exact manifest URLs and the shell — the
 * URLs this installation demonstrably owns — are removed, and the cache itself
 * is deleted only when that leaves it empty.
 */
async function pruneLegacyCache(name) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  let remaining = 0;
  for (const request of keys) {
    if (isCacheableAsset(request.url) || request.url === SHELL_URL) {
      await cache.delete(request);
    } else {
      remaining += 1;
    }
  }
  if (remaining === 0) await caches.delete(name);
}

/**
 * Largest client census this worker will report (N3b).
 *
 * Above this the census is REFUSED (-1), not truncated. The handoff proceeds
 * only when acknowledgements equal the census, so a truncated count is the one
 * answer that could ever be actively wrong: 70 open tabs reported as 64, with
 * 64 acknowledgements, is an equality that moves a subset and strands it while
 * six unasked tabs keep the old worker alive. Refusing defers the round, which
 * is always safe.
 */
const MAX_CENSUS_WINDOWS = 64;

/**
 * Two read-only questions, and nothing else (N3b).
 *
 * `cosyncing-build-identity` — which build is this worker? Asked of the WAITING
 * worker to prove a replacement is real and different before any tab is moved,
 * and of the ACTIVE worker afterwards to prove the swap actually happened. It is
 * the only way a page can tell one build from another: Flutter content-hashes no
 * URL, so identity lives in the manifest this worker was stamped with.
 *
 * `cosyncing-client-census` — how many window clients does this worker control?
 * A page cannot enumerate its origin's tabs; a worker can enumerate its own
 * controllees exactly. That census is what makes "every tab acknowledged" a
 * fact rather than a hope, and it is what a frozen tab fails: it is counted but
 * cannot answer, so the handoff defers instead of stranding it.
 *
 * DELIBERATELY NOT A CONTROL CHANNEL. There is no `skipWaiting` message, no
 * cache mutation, no unregister, no navigation. Every branch below only reads.
 * A message that could activate this worker over a live page would reintroduce
 * exactly the mixed-build hazard the waiting model exists to prevent, and it
 * would be reachable by any same-origin script.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const type = data.type;
  if (type !== 'cosyncing-build-identity' && type !== 'cosyncing-client-census') return;

  // Reply down the caller's own port when it supplied one, so an answer cannot
  // be observed by an unrelated listener on the page.
  const port = (event.ports && event.ports[0]) || null;
  const reply = (payload) => {
    try {
      if (port) port.postMessage(payload);
      else if (event.source && event.source.postMessage) event.source.postMessage(payload);
    } catch (error) {
      // The asker navigated away mid-question. Nothing to do and nothing lost.
    }
  };

  if (type === 'cosyncing-build-identity') {
    reply({
      type,
      version: BUILD_VERSION,
      cacheName: CACHE_NAME,
      scope: SCOPE_URL.href,
    });
    return;
  }

  // `waitUntil` so the worker is not terminated between the query and the reply.
  event.waitUntil(
    (async () => {
      let windows = -1; // -1 = could not be established; the caller must defer.
      try {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: false,
        });
        windows = clients.length > MAX_CENSUS_WINDOWS ? -1 : clients.length;
      } catch (error) {
        console.warn('cosyncing: client census failed', error);
      }
      reply({ type, version: BUILD_VERSION, windows });
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isStaticCandidate(request)) return; // network owns it; we never see the body

  if (isShellNavigation(request)) {
    event.respondWith(respondWithShell(request));
    return;
  }

  if (!isCacheableAsset(request.url)) return; // not a build artefact: pass through

  event.respondWith(respondWithAsset(request));
});

/** The response an old build gets when the network has moved on without it. */
function buildMismatchResponse() {
  return new Response(
    'This asset does not belong to the build that requested it. ' +
      'Reload to pick up the current version.',
    {
      status: 503,
      statusText: 'Build version mismatch',
      headers: { 'Content-Type': 'text/plain' },
    },
  );
}

/**
 * Serves the precached shell for in-scope navigations.
 *
 * Cache-first, because the whole point is that a repeat or offline start paints
 * without waiting for the network. The shell carries no user data — it is the
 * same bytes for every visitor — and a new build replaces it wholesale via a
 * new cache, so it cannot go stale past one update cycle.
 *
 * The miss path is verified like every other asset. A cache entry can go
 * missing on its own (storage pressure evicts individual entries), and an
 * unverified network fallback here is the worst possible mix: the HTML is the
 * document that chooses which bundle to load, so serving the NEW shell to a
 * worker that still holds the OLD main.dart.js is a mixed build by
 * construction. Refusing is recoverable; that is not.
 */
async function respondWithShell(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_URL);
  if (cached) return cached;
  // A network error (offline, no cached shell) propagates so the browser shows
  // its own error rather than one this worker invented.
  const verified = await fetchVerified(SHELL_URL);
  if (!verified) return buildMismatchResponse();
  await cache.put(SHELL_URL, responseFor(verified));
  return responseFor(verified);
}

/**
 * Serves one allowlisted build artefact, filling the runtime set on first use.
 *
 * The response must hash to what this build's manifest says that URL contains.
 * A mismatch means the server has moved on to a newer build, and the page
 * asking is running the older one — so the request fails explicitly instead of
 * handing an old engine a new engine's binary. An explicit failure is
 * recoverable (reload, and the waiting worker takes over); a silently mixed
 * runtime is not.
 */
async function respondWithAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  const verified = await fetchVerified(request.url);
  if (!verified) return buildMismatchResponse();
  await cache.put(request.url, responseFor(verified));
  return responseFor(verified);
}
