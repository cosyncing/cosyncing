#!/usr/bin/env bun
/**
 * Deterministic audit of the static-asset service worker (N3 part B).
 *
 * Runs `apps/client/web/sw.js` for real — stamped with a synthetic manifest —
 * inside a fake ServiceWorkerGlobalScope, then drives its actual install,
 * activate and fetch handlers. No browser, no network, no build required.
 *
 * It proves the properties that code inspection cannot:
 *
 *  1. Broker HTTP/API, WebSocket and other runtime requests are never served
 *     from, nor written to, the static cache.
 *  2. A URL outside the build manifest is never cached, even in scope.
 *  3. Activating a new build deletes every obsolete application cache, and the
 *     legacy Flutter caches with it.
 *  4. A failed install does not promote the new version or touch the old cache.
 *  5. Offline repeat startup serves the cached shell and assets.
 *  6. The manifest generator refuses to emit runtime routes.
 *
 *   bun run scripts/client/tests/test-web-static-cache.ts
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { assertNoRuntimeRoutes, stampWorkerSource } from '../build-web-cache.ts';
import { WEB_BASE_HREF, WEB_BUILD_COMMAND } from '../build-web.ts';
import { CLIENT_ROOT, REPOSITORY_ROOT } from '../run-client-command.ts';

const SCOPE = 'https://broker.example/cosy/';
const WORKER_SOURCE_PATH = join(CLIENT_ROOT, 'web', 'sw.js');

/** Cache names are scope-qualified, so a co-hosted app is never a candidate. */
const CACHE_PREFIX = 'cosyncing-app:/cosy/:';
const cacheNameFor = (version: string) => CACHE_PREFIX + version;
const MARKER_URL = SCOPE + '__cosyncing_activated__';

const PRECACHE = [
  'index.html',
  'flutter_bootstrap.js',
  'main.dart.js',
  'assets/FontManifest.json',
];
const RUNTIME = ['canvaskit/canvaskit.wasm', 'sqlite3.wasm'];

/**
 * What the "deployed" server currently serves for a URL.
 *
 * Swapped by the version-skew case, which is the whole point: a fake network
 * that returns identical bytes for every deployment cannot tell a coherent
 * update apart from one that hands an old page a new build's engine.
 */
const buildOneBody = (url: string) => `body:${url}`;
let servedBody: (url: string) => string = buildOneBody;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Cache keys whose `put` the storage double refuses, as real storage can. */
const failingPuts = new Set<string>();

/** Cache keys whose `delete` the storage double refuses. */
const failingEntryDeletes = new Set<string>();

/** Whole caches whose `caches.delete(name)` the storage double refuses. */
const failingCacheDeletes = new Set<string>();

/** Whether `clients.claim()` rejects, as it can when the client list changes. */
let claimFails = false;

const MANIFEST = {
  buildVersion: 'buildaaaaaaaaaa1',
  precache: PRECACHE,
  runtime: RUNTIME,
  hashes: Object.fromEntries(
    [...PRECACHE, ...RUNTIME].map((path) => [path, sha256(buildOneBody(SCOPE + path))]),
  ),
  precacheBytes: 0,
  runtimeBytes: 0,
};

let failures = 0;
let checks = 0;

function check(condition: unknown, description: string): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${description}`);
}

function checkEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${description}\n       expected ${String(expected)}, got ${String(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Minimal Cache / CacheStorage doubles.
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  headers?: unknown;
  type?: string;
}

/** Stands in for `Response`, including the bytes the worker hashes. */
class FakeResponse {
  readonly bytes: Uint8Array;
  readonly status: number;
  readonly statusText: string;
  readonly headers: unknown;
  readonly type: string;

  constructor(body: string | Uint8Array | ArrayBuffer, init: FakeResponseInit = {}) {
    this.bytes =
      typeof body === 'string'
        ? encoder.encode(body)
        : body instanceof Uint8Array
          ? body
          : new Uint8Array(body);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = init.headers ?? {};
    this.type = init.type ?? 'basic';
  }

  get body(): string {
    return decoder.decode(this.bytes);
  }

  clone(): FakeResponse {
    return new FakeResponse(this.bytes, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      type: this.type,
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    ) as ArrayBuffer;
  }
}

class FakeCache {
  readonly entries = new Map<string, FakeResponse>();

  async match(request: string | { url: string }): Promise<FakeResponse | undefined> {
    const url = typeof request === 'string' ? request : request.url;
    return this.entries.get(url);
  }

  async put(request: string | { url: string }, response: FakeResponse): Promise<void> {
    const url = typeof request === 'string' ? request : request.url;
    // Storage can refuse a write — quota, eviction, a disabled CacheStorage.
    if (failingPuts.has(url)) throw new DOMException('QuotaExceededError');
    this.entries.set(url, response);
  }

  /** Real `Cache.keys()` resolves Request objects; only `url` is read here. */
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }

  async delete(request: string | { url: string }): Promise<boolean> {
    const url = typeof request === 'string' ? request : request.url;
    if (failingEntryDeletes.has(url)) throw new DOMException('UnknownError');
    return this.entries.delete(url);
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    if (failingCacheDeletes.has(name)) throw new DOMException('UnknownError');
    return this.caches.delete(name);
  }
}

class FakeRequest {
  constructor(
    readonly url: string,
    readonly method = 'GET',
    readonly mode = 'no-cors',
    readonly destination = '',
  ) {}
}

/* ------------------------------------------------------------------ *
 * Fake global scope + worker loader.
 * ------------------------------------------------------------------ */

interface Harness {
  scope: Record<string, unknown>;
  storage: FakeCacheStorage;
  listeners: Map<string, (event: Record<string, unknown>) => void>;
  networkLog: string[];
  offline: boolean;
  skipWaitingCalls: number;
  claimCalls: number;
  install(): Promise<void>;
  activate(): Promise<void>;
  fetchEvent(request: FakeRequest): Promise<{ handled: boolean; response?: FakeResponse }>;
}

let activeHarness: Harness | null = null;

async function fakeFetch(request: FakeRequest | string): Promise<FakeResponse> {
  const url = typeof request === 'string' ? request : request.url;
  const harness = activeHarness;
  if (harness) {
    harness.networkLog.push(url);
    if (harness.offline) throw new TypeError('offline');
  }
  return new FakeResponse(servedBody(url));
}

async function loadWorker(source: string): Promise<Harness> {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const storage = new FakeCacheStorage();
  const networkLog: string[] = [];

  let skipWaitingCalls = 0;
  let claimCalls = 0;
  const scope: Record<string, unknown> = {
    location: { href: SCOPE + 'sw.js' },
    registration: { scope: SCOPE },
    clients: {
      claim: async () => {
        claimCalls += 1;
        if (claimFails) throw new DOMException('InvalidStateError');
      },
    },
    skipWaiting: async () => {
      skipWaitingCalls += 1;
    },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      listeners.set(type, handler);
    },
    caches: storage,
    fetch: fakeFetch,
    URL,
    Set,
    Map,
    Promise,
    JSON,
    console,
    Response: FakeResponse,
    crypto,
  };
  scope.self = scope;

  const harness: Harness = {
    scope,
    storage,
    listeners,
    networkLog,
    offline: false,
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get claimCalls() {
      return claimCalls;
    },
    async install() {
      const waits: Promise<unknown>[] = [];
      listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
    async activate() {
      const waits: Promise<unknown>[] = [];
      listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
    async fetchEvent(request: FakeRequest) {
      let responded: Promise<FakeResponse> | undefined;
      listeners.get('fetch')?.({
        request,
        respondWith: (value: Promise<FakeResponse>) => {
          responded = value;
        },
      });
      if (responded === undefined) return { handled: false };
      return { handled: true, response: await responded };
    },
  };

  // eslint-disable-next-line no-new-func -- executing the real worker source is the point
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'console',
    'Response',
    'crypto',
    `${source}\nreturn true;`,
  );
  activeHarness = harness;
  factory(scope, storage, fakeFetch, console, FakeResponse, crypto);
  return harness;
}

function stamped(): string {
  return stampedSource;
}

let stampedSource = '';

/* ------------------------------------------------------------------ *
 * Cases.
 * ------------------------------------------------------------------ */

async function freshHarness(): Promise<Harness> {
  const harness = await loadWorker(stamped());
  activeHarness = harness;
  return harness;
}

async function caseInstallPrecachesExactlyTheManifest(): Promise<void> {
  console.log('install precaches exactly the manifest');
  const harness = await freshHarness();
  await harness.install();
  const cache = await harness.storage.open(cacheNameFor(MANIFEST.buildVersion));
  checkEqual(cache.entries.size, MANIFEST.precache.length, 'precache holds every precache entry');
  for (const path of MANIFEST.precache) {
    check(cache.entries.has(SCOPE + path), `precached ${path}`);
  }
  for (const path of MANIFEST.runtime) {
    check(!cache.entries.has(SCOPE + path), `runtime asset ${path} not precached at install`);
  }
}

async function caseBrokerRoutesAreNeverTouched(): Promise<void> {
  console.log('broker HTTP/API/WebSocket/runtime requests bypass the cache');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  const cacheName = cacheNameFor(MANIFEST.buildVersion);
  const before = (await harness.storage.open(cacheName)).entries.size;

  const runtimeRequests: FakeRequest[] = [
    // Broker API at the origin root: outside scope entirely.
    new FakeRequest('https://broker.example/api/sessions'),
    new FakeRequest('https://broker.example/api/session-roster-deltas?after=4'),
    new FakeRequest('https://broker.example/api/machines'),
    new FakeRequest('https://broker.example/api/transport/pair'),
    new FakeRequest('https://broker.example/pi/bridge/rpc'),
    new FakeRequest('https://broker.example/claude/hook/notify'),
    // WebSocket upgrade.
    new FakeRequest(
      'wss://broker.example/api/sessions/codex/abc/stream',
      'GET',
      'websocket',
      'websocket',
    ),
    // Mutations, including ones that would be in scope if method were ignored.
    new FakeRequest('https://broker.example/api/sessions/codex/abc/prompt', 'POST'),
    new FakeRequest(SCOPE + 'main.dart.js', 'POST'),
    new FakeRequest(SCOPE + 'index.html', 'DELETE'),
    // Cross-origin.
    new FakeRequest('https://other.example/cosy/main.dart.js'),
    // In scope but not a build artefact.
    new FakeRequest(SCOPE + 'not-in-manifest.js'),
    // In scope with a query string: build artefacts never carry one.
    new FakeRequest(SCOPE + 'main.dart.js?token=secret'),
  ];

  for (const request of runtimeRequests) {
    const result = await harness.fetchEvent(request);
    check(!result.handled, `worker ignores ${request.method} ${request.url}`);
  }

  const after = await harness.storage.open(cacheName);
  checkEqual(after.entries.size, before, 'no runtime request added a cache entry');
  for (const url of after.entries.keys()) {
    if (url === MARKER_URL) continue; // the worker's own activation mark
    check(
      MANIFEST.precache.some((path) => SCOPE + path === url) ||
        MANIFEST.runtime.some((path) => SCOPE + path === url),
      `cached URL ${url} is a manifest entry`,
    );
  }
}

/**
 * A waiting worker is not enough on its own.
 *
 * Flutter web content-hashes no URL, so `canvaskit/canvaskit.wasm` addresses
 * different bytes before and after a deployment. The OLD worker is still the
 * one serving the open page, and if it lazy-fetches a runtime URL it has not
 * cached yet, the server hands it the NEW build's bytes — which it would then
 * store into the old build's own cache and give to the old main.dart.js.
 */
async function caseRuntimeSkewIsRefused(): Promise<void> {
  console.log('an old page never receives a new build\'s runtime binary');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  const cacheName = cacheNameFor(MANIFEST.buildVersion);
  const engineUrl = SCOPE + 'canvaskit/canvaskit.wasm';
  check(
    !(await harness.storage.open(cacheName)).entries.has(engineUrl),
    'the engine binary is deliberately not cached yet',
  );

  // A new build is deployed. This worker is still the active one.
  servedBody = (url) => `newbuild:${url}`;
  const skewed = await harness.fetchEvent(new FakeRequest(engineUrl));

  check(skewed.handled, 'the worker owns the request');
  checkEqual(skewed.response?.status, 503, 'a version-skewed asset fails explicitly');
  check(
    !(skewed.response?.body ?? '').startsWith('newbuild:'),
    'the new build\'s bytes never reach the old page',
  );
  check(
    !(await harness.storage.open(cacheName)).entries.has(engineUrl),
    'and they are not written into the old build\'s cache either',
  );

  // Everything this build already has still serves its own bytes.
  const bundle = await harness.fetchEvent(new FakeRequest(SCOPE + 'main.dart.js'));
  checkEqual(
    bundle.response?.body,
    `body:${SCOPE}main.dart.js`,
    'the precached bundle is still the old build\'s',
  );

  // Back on the matching build, the same URL fills normally.
  servedBody = buildOneBody;
  const matched = await harness.fetchEvent(new FakeRequest(engineUrl));
  checkEqual(matched.response?.status, 200, 'a matching asset is served');
  check(
    (await harness.storage.open(cacheName)).entries.has(engineUrl),
    'and cached',
  );
}

/**
 * An install that never activates still creates a cache. Nothing else will ever
 * clean those up — activation only sweeps on behalf of a build that ran — so
 * each superseded or failed update would leave one behind forever.
 */
async function caseAbandonedInstallsAreSweptUp(): Promise<void> {
  console.log('caches from installs that never activated are swept up');
  const first = await freshHarness();
  await first.install();
  await first.activate();

  const second = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildeeeeeeeee05',
    }),
  );
  activeHarness = second;
  for (const [name, cache] of first.storage.caches) second.storage.caches.set(name, cache);
  await second.install(); // installs, then waits: never activated

  const third = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildfffffffff06',
    }),
  );
  activeHarness = third;
  for (const [name, cache] of second.storage.caches) third.storage.caches.set(name, cache);
  await third.install();

  const names = await third.storage.keys();
  check(
    names.includes(cacheNameFor(MANIFEST.buildVersion)),
    'the live build keeps its cache — a page is still running it',
  );
  check(
    !names.includes(cacheNameFor('buildeeeeeeeee05')),
    'the superseded install leaves no abandoned cache',
  );
  check(names.includes(cacheNameFor('buildfffffffff06')), 'the new install has its own');
  checkEqual(
    names.filter((name) => name.startsWith(CACHE_PREFIX)).length,
    2,
    'never more than the live build plus the one being installed',
  );
}

async function caseRuntimeAssetsFillLazily(): Promise<void> {
  console.log('allowlisted runtime assets fill the version cache on first use');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  const cacheName = cacheNameFor(MANIFEST.buildVersion);

  const first = await harness.fetchEvent(new FakeRequest(SCOPE + 'canvaskit/canvaskit.wasm'));
  check(first.handled, 'runtime asset is handled');
  const cache = await harness.storage.open(cacheName);
  check(cache.entries.has(SCOPE + 'canvaskit/canvaskit.wasm'), 'runtime asset was stored');

  harness.networkLog.length = 0;
  const second = await harness.fetchEvent(new FakeRequest(SCOPE + 'canvaskit/canvaskit.wasm'));
  check(second.handled, 'second request is handled');
  checkEqual(harness.networkLog.length, 0, 'second request is served from cache, not the network');
}

async function caseOfflineRepeatStartup(): Promise<void> {
  console.log('offline repeat startup serves the cached shell and assets');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  await harness.fetchEvent(new FakeRequest(SCOPE + 'canvaskit/canvaskit.wasm'));

  harness.offline = true;
  const navigation = await harness.fetchEvent(
    new FakeRequest(SCOPE + 'sessions/codex/abc', 'GET', 'navigate', 'document'),
  );
  check(navigation.handled, 'in-scope navigation is handled while offline');
  checkEqual(
    navigation.response?.body,
    `body:${SCOPE}index.html`,
    'navigation is answered by the cached shell',
  );

  const script = await harness.fetchEvent(new FakeRequest(SCOPE + 'main.dart.js'));
  checkEqual(script.response?.body, `body:${SCOPE}main.dart.js`, 'app bundle served from cache');

  const runtime = await harness.fetchEvent(new FakeRequest(SCOPE + 'canvaskit/canvaskit.wasm'));
  checkEqual(
    runtime.response?.body,
    `body:${SCOPE}canvaskit/canvaskit.wasm`,
    'engine binary served from cache',
  );
}

/**
 * The update must not be able to mix two builds in one open page.
 *
 * A worker that calls `skipWaiting()` takes over a document that is already
 * running the PREVIOUS main.dart.js, and its activate handler then deletes the
 * cache that document is still lazy-loading CanvasKit, Drift and assets from.
 * The contract is: install fully, then wait. This drives the real handlers and
 * asserts the old client keeps its own complete build for as long as it is
 * open, and only the next navigation sees the new one.
 */
async function caseUpdateCannotMixTwoBuilds(): Promise<void> {
  console.log('an update never mixes two builds in one client');
  const old = await freshHarness();
  await old.install();
  await old.activate();
  checkEqual(old.skipWaitingCalls, 0, 'the first install does not call skipWaiting');

  const next = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildddddddddd04',
    }),
  );
  activeHarness = next;
  for (const [name, cache] of old.storage.caches) next.storage.caches.set(name, cache);

  // A new build is deployed and the new worker installs.
  await next.install();
  checkEqual(
    next.skipWaitingCalls,
    0,
    'the replacement worker does not force itself over an open client',
  );

  // The browser therefore keeps the OLD worker in control of the open page.
  // Its cache must still be intact and still answering.
  const oldCacheName = cacheNameFor(MANIFEST.buildVersion);
  check(
    next.storage.caches.has(oldCacheName),
    'the old build keeps its cache while a client is still running it',
  );
  activeHarness = old;
  const bundle = await old.fetchEvent(new FakeRequest(SCOPE + 'main.dart.js'));
  checkEqual(
    bundle.response?.body,
    `body:${SCOPE}main.dart.js`,
    'an open old client still receives the old build assets',
  );
  const engine = await old.fetchEvent(new FakeRequest(SCOPE + 'canvaskit/canvaskit.wasm'));
  check(engine.handled, 'an open old client can still lazy-load its own engine binary');
  check(
    (await old.storage.open(oldCacheName)).entries.has(SCOPE + 'canvaskit/canvaskit.wasm'),
    'the lazy-loaded binary lands in the OLD build cache, not the new one',
  );

  // The old client goes away; only now does the browser activate the new
  // worker, and only now is the previous cache safe to remove.
  activeHarness = next;
  await next.activate();
  const names = await next.storage.keys();
  check(names.includes(cacheNameFor('buildddddddddd04')), 'the next navigation gets the new build');
  check(!names.includes(oldCacheName), 'the superseded cache is removed once no client needs it');
  checkEqual(
    names.filter((name) => name.startsWith(CACHE_PREFIX)).length,
    1,
    'exactly one build cache survives the swap',
  );
}

/**
 * The shell is the document that decides which bundle to load, so an
 * unverified network fallback here is the worst mix available: the NEW HTML
 * next to the OLD cached main.dart.js. Individual cache entries can disappear
 * on their own under storage pressure, so the miss path is reachable without
 * any bug.
 */
async function caseShellMissIsVerified(): Promise<void> {
  console.log('a missing cached shell is never replaced by another build');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  const cacheName = cacheNameFor(MANIFEST.buildVersion);
  const cache = await harness.storage.open(cacheName);

  // Storage evicts just the shell entry, and a new build is deployed.
  await cache.delete(SCOPE + 'index.html');
  servedBody = (url) => `newbuild:${url}`;

  const navigation = await harness.fetchEvent(
    new FakeRequest(SCOPE + 'sessions/codex/abc', 'GET', 'navigate', 'document'),
  );
  check(navigation.handled, 'the worker still owns the navigation');
  checkEqual(navigation.response?.status, 503, 'a foreign shell fails explicitly');
  check(
    !(navigation.response?.body ?? '').startsWith('newbuild:'),
    "the new build's HTML is never returned to a page running the old bundle",
  );
  check(
    !(await harness.storage.open(cacheName)).entries.has(SCOPE + 'index.html'),
    'and it is not written into the old build\'s cache either',
  );

  // The matching shell refills the gap normally.
  servedBody = buildOneBody;
  const refilled = await harness.fetchEvent(
    new FakeRequest(SCOPE + 'sessions/codex/abc', 'GET', 'navigate', 'document'),
  );
  checkEqual(
    refilled.response?.body,
    `body:${SCOPE}index.html`,
    'this build\'s own shell is served',
  );
  check(
    (await harness.storage.open(cacheName)).entries.has(SCOPE + 'index.html'),
    'and restored to the cache',
  );
}

/**
 * Activation destroys the previous build. Everything that can fail must fail
 * BEFORE that point, or a rejected activation leaves the device with no
 * complete build at all — the previous one deleted and the new one unmarked.
 */
async function caseActivationKeepsTheOldBuildWhenMarkingFails(): Promise<void> {
  console.log('a failed activation leaves the previous build intact');
  const old = await freshHarness();
  await old.install();
  await old.activate();
  const oldCacheName = cacheNameFor(MANIFEST.buildVersion);
  const oldEntryCount = (await old.storage.open(oldCacheName)).entries.size;

  const next = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildggggggggg07',
    }),
  );
  activeHarness = next;
  for (const [name, cache] of old.storage.caches) next.storage.caches.set(name, cache);
  await next.install();

  failingPuts.add(MARKER_URL);
  let activateFailed = false;
  try {
    await next.activate();
  } catch (error) {
    activateFailed = true;
  }
  failingPuts.delete(MARKER_URL);

  check(activateFailed, 'activation rejects when it cannot mark its own cache');
  const surviving = next.storage.caches.get(oldCacheName);
  check(surviving !== undefined, 'the previous complete build still exists');
  checkEqual(
    surviving?.entries.size,
    oldEntryCount,
    'and is untouched — nothing was deleted before the marker landed',
  );

  // The unmarked cache is what the next install treats as abandoned.
  const followUp = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildhhhhhhhhh08',
    }),
  );
  activeHarness = followUp;
  for (const [name, cache] of next.storage.caches) followUp.storage.caches.set(name, cache);
  await followUp.install();
  check(
    !(await followUp.storage.keys()).includes(cacheNameFor('buildggggggggg07')),
    'the cache of the failed activation is swept up on the next install',
  );
}

/** A next build's worker, sharing the browser's cache storage with `previous`. */
async function successorHarness(previous: Harness, version: string): Promise<Harness> {
  const next = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: version,
    }),
  );
  activeHarness = next;
  for (const [name, cache] of previous.storage.caches) next.storage.caches.set(name, cache);
  return next;
}

/**
 * `clients.claim()` is the other activation step that can reject, and it used
 * to run AFTER the sweep — so a failed claim recreated the exact hazard the
 * marker ordering exists to prevent, just through a different call.
 */
async function caseActivationKeepsTheOldBuildWhenClaimFails(): Promise<void> {
  console.log('a failed claim leaves the previous build intact');
  const old = await freshHarness();
  await old.install();
  await old.activate();
  const oldCacheName = cacheNameFor(MANIFEST.buildVersion);
  const oldEntryCount = (await old.storage.open(oldCacheName)).entries.size;

  const next = await successorHarness(old, 'buildiiiiiiiii09');
  await next.install();

  claimFails = true;
  let activateFailed = false;
  try {
    await next.activate();
  } catch (error) {
    activateFailed = true;
  }
  claimFails = false;

  check(activateFailed, 'activation rejects when it cannot claim its clients');
  const surviving = next.storage.caches.get(oldCacheName);
  check(surviving !== undefined, 'the previous complete build still exists');
  checkEqual(
    surviving?.entries.size,
    oldEntryCount,
    'and is untouched — the claim failed before anything was deleted',
  );
  const marker = await (
    await next.storage.open(cacheNameFor('buildiiiiiiiii09'))
  ).match(MARKER_URL);
  check(marker === undefined, 'a build that never claimed its clients is not marked durable');

  const followUp = await successorHarness(next, 'buildjjjjjjjjj10');
  await followUp.install();
  check(
    !(await followUp.storage.keys()).includes(cacheNameFor('buildiiiiiiiii09')),
    'so the next install sweeps it as abandoned',
  );
}

/**
 * Cleanup runs after the previous cache is already gone, so it must not be able
 * to fail the activation that removed it — that would leave a device whose
 * activation rejected AND whose fallback build is deleted, which is the whole
 * failure this ordering exists to rule out.
 */
async function caseCleanupFailureDoesNotBreakActivation(): Promise<void> {
  console.log('a cache deletion that fails does not break activation');
  const old = await freshHarness();
  await old.install();
  await old.activate();
  const oldCacheName = cacheNameFor(MANIFEST.buildVersion);

  const next = await successorHarness(old, 'buildkkkkkkkkk11');
  await next.install();
  // A second obsolete cache, swept in the same pass as the undeletable one.
  await next.storage.open(cacheNameFor('staleoldbuild001'));

  failingCacheDeletes.add(oldCacheName);
  let activateFailed = false;
  try {
    await next.activate();
  } catch (error) {
    activateFailed = true;
  }
  failingCacheDeletes.delete(oldCacheName);

  check(!activateFailed, 'activation succeeds when an obsolete cache cannot be deleted');
  checkEqual(next.claimCalls, 1, 'and the new build did claim its clients');
  const marker = await (
    await next.storage.open(cacheNameFor('buildkkkkkkkkk11'))
  ).match(MARKER_URL);
  check(marker !== undefined, 'the new build is marked activated');
  const names = await next.storage.keys();
  check(names.includes(oldCacheName), 'the undeletable cache is left behind as a leftover');
  check(
    !names.includes(cacheNameFor('staleoldbuild001')),
    'and its sibling in the same sweep is still deleted',
  );
}

/**
 * Pruning a generically-named legacy cache reaches into storage another app may
 * own, so its failure is even less this activation's business.
 */
async function caseLegacyPruneFailureDoesNotBreakActivation(): Promise<void> {
  console.log('a legacy cache that cannot be pruned does not break activation');
  const harness = await freshHarness();
  await harness.install();
  const legacy = await harness.storage.open('flutter-app-cache');
  await legacy.put(SCOPE + 'main.dart.js', new FakeResponse('ours'));
  await harness.storage.open(cacheNameFor('staleoldbuild002'));

  failingEntryDeletes.add(SCOPE + 'main.dart.js');
  let activateFailed = false;
  try {
    await harness.activate();
  } catch (error) {
    activateFailed = true;
  }
  failingEntryDeletes.delete(SCOPE + 'main.dart.js');

  check(!activateFailed, 'activation survives a legacy cache it cannot prune');
  const names = await harness.storage.keys();
  check(names.includes('flutter-app-cache'), 'the unprunable legacy cache remains');
  check(
    !names.includes(cacheNameFor('staleoldbuild002')),
    'and the rest of the sweep still ran',
  );
}

/**
 * One release build definition, shared by every caller.
 *
 * `client:check` used to run its own `flutter build web --release` with no
 * `--base-href`. Nothing failed: it simply replaced the `/cosy/` artefact in
 * build/web with a `/` one, so a service worker registered from it would take a
 * scope covering the broker's own API routes, and any browser evidence run
 * after a check was exercising a mount that will never ship.
 */
async function caseReleaseBuildShapeIsShared(): Promise<void> {
  console.log('one release web build definition');
  checkEqual(WEB_BASE_HREF, '/cosy/', 'the deployed base href is the app mount');
  check(
    WEB_BUILD_COMMAND.includes('--base-href') && WEB_BUILD_COMMAND.includes(WEB_BASE_HREF),
    `the shared build command stamps it (${WEB_BUILD_COMMAND.join(' ')})`,
  );
  check(
    WEB_BUILD_COMMAND.includes(
      `--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`,
    ),
    'the canonical build compiles the release product version into WebSocket negotiation',
  );
  check(
    WEB_BUILD_COMMAND.some((argument) =>
      argument.startsWith('--dart-define=COSYNCING_CLIENT_SOURCE_COMMIT='),
    ),
    'the canonical build compiles its source commit into the executing-client diagnostic',
  );
  check(
    WEB_BUILD_COMMAND.some((argument) =>
      argument.startsWith('--dart-define=COSYNCING_CLIENT_SOURCE_DIRTY='),
    ),
    'the canonical build compiles source cleanliness into the executing-client diagnostic',
  );

  const checkScript = await readFile(join(REPOSITORY_ROOT, 'scripts/client/check.ts'), 'utf8');
  check(checkScript.includes('buildReleaseWeb'), 'client:check builds through that definition');
  check(
    !/'build',\s*'web'/.test(checkScript),
    'and does not spell out a second flutter web build of its own',
  );

  const scripts = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ).scripts as Record<string, string>;
  const buildScript = scripts['client:build:web'] ?? '';
  check(
    buildScript.includes('scripts/client/build-web.ts'),
    `client:build:web builds through it too (${buildScript})`,
  );
  check(
    !buildScript.includes('flutter build web'),
    'and does not carry its own flutter invocation either',
  );
  const indexSource = await readFile(
    join(REPOSITORY_ROOT, 'apps/client/web/index.html'),
    'utf8',
  );
  check(
    indexSource.includes('cosyncingWebUpdateReady')
      && indexSource.includes('cosyncingWebUpdateHandoffFailed')
      && !indexSource.includes('cosyncingApplyWebUpdate'),
    'the shell publishes a waiting build and a failed handoff, and no false reload action',
  );
  check(
    !indexSource.includes('.skipWaiting('),
    'the app-level update path never forces waiting-worker activation',
  );

  for (const workflowPath of ['.github/workflows/ci.yml']) {
    const workflow = await readFile(
      join(REPOSITORY_ROOT, workflowPath),
      'utf8',
    );
    check(
      workflow.includes('bun run check'),
      `${workflowPath} consumes the canonical verification graph`,
    );
    check(
      !workflow.includes('flutter build web --release'),
      `${workflowPath} has no release-shaped raw Flutter web build`,
    );
  }
  const verificationGraph = JSON.parse(
    await readFile(
      join(
        REPOSITORY_ROOT,
        'scripts/verification/verification-graph.json',
      ),
      'utf8',
    ),
  ) as {
    gates: Array<{ id: string; command: string[]; dependencies: string[] }>;
  };
  const clientGate = verificationGraph.gates.find(
    (gate) => gate.id === 'client',
  );
  const browserGate = verificationGraph.gates.find(
    (gate) => gate.id === 'web-browser',
  );
  const cacheGate = verificationGraph.gates.find(
    (gate) => gate.id === 'web-cache',
  );
  check(
    clientGate?.command.join(' ') === 'bun run client:check',
    'the graph has one canonical client build owner',
  );
  check(
    browserGate?.dependencies.includes('client') === true
      && cacheGate?.dependencies.includes('client') === true,
    'browser and cache gates consume the exact canonical client output',
  );
}

/**
 * Cleanup is scope-local. An origin can host another app and a second Cosyncing
 * mount; neither is this installation's to delete.
 */
async function caseCleanupIsScopeLocal(): Promise<void> {
  console.log('activation only touches this scope');
  const harness = await freshHarness();
  await harness.install();

  // Another Cosyncing installation on the same origin, and an unrelated app.
  await harness.storage.open('cosyncing-app:/staging/cosy/:otherbuild00001');
  await harness.storage.open('cosyncing-app:/:rootmountbuild01');
  await harness.storage.open('some-other-app-v3');

  // A generically-named legacy Flutter cache SHARED with another app: it holds
  // one of our entries, one from an app at a different path, and one from an
  // app mounted BENEATH us — which a scope-prefix rule would wrongly claim.
  const shared = await harness.storage.open('flutter-app-cache');
  await shared.put(SCOPE + 'main.dart.js', new FakeResponse('ours'));
  await shared.put('https://broker.example/other-app/main.dart.js', new FakeResponse('theirs'));
  await shared.put(SCOPE + 'other/main.dart.js', new FakeResponse('nested app'));

  // A legacy cache that holds only our entries.
  const oursOnly = await harness.storage.open('flutter-temp-cache');
  await oursOnly.put(SCOPE + 'index.html', new FakeResponse('ours'));

  await harness.activate();
  const names = await harness.storage.keys();

  check(
    names.includes('cosyncing-app:/staging/cosy/:otherbuild00001'),
    'another Cosyncing mount keeps its cache',
  );
  check(names.includes('cosyncing-app:/:rootmountbuild01'), 'a root-mounted install is untouched');
  check(names.includes('some-other-app-v3'), 'an unrelated app is untouched');
  check(
    names.includes('flutter-app-cache'),
    'a legacy cache shared with another app survives',
  );
  const prunedShared = await harness.storage.open('flutter-app-cache');
  check(
    !prunedShared.entries.has(SCOPE + 'main.dart.js'),
    'our entry is pruned out of the shared legacy cache',
  );
  check(
    prunedShared.entries.has('https://broker.example/other-app/main.dart.js'),
    "the other app's entry in the shared legacy cache is left alone",
  );
  check(
    prunedShared.entries.has(SCOPE + 'other/main.dart.js'),
    'an app mounted beneath this scope is not this app',
  );
  check(
    !names.includes('flutter-temp-cache'),
    'a legacy cache proven to hold only our entries is removed',
  );
}

async function caseNewVersionRemovesObsoleteCaches(): Promise<void> {
  console.log('a new build removes obsolete caches');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  // Simulate history: an older app version and Flutter's legacy caches.
  await harness.storage.open(cacheNameFor('oldbuild0000000'));
  await harness.storage.open('flutter-app-cache');
  await harness.storage.open('flutter-temp-cache');
  await harness.storage.open('unrelated-third-party-cache');

  const next = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildbbbbbbbbbb2',
    }),
  );
  // The new worker shares the browser's cache storage.
  activeHarness = next;
  for (const [name, cache] of harness.storage.caches) next.storage.caches.set(name, cache);
  await next.install();
  await next.activate();

  const names = await next.storage.keys();
  check(names.includes(cacheNameFor('buildbbbbbbbbbb2')), 'new version cache exists');
  check(!names.includes(cacheNameFor(MANIFEST.buildVersion)), 'previous version cache deleted');
  check(!names.includes(cacheNameFor('oldbuild0000000')), 'older version cache deleted');
  check(!names.includes('flutter-app-cache'), 'legacy Flutter cache deleted');
  check(!names.includes('flutter-temp-cache'), 'legacy Flutter temp cache deleted');
  check(names.includes('unrelated-third-party-cache'), 'unrelated caches are left alone');
}

async function caseFailedInstallLeavesTheOldVersionIntact(): Promise<void> {
  console.log('a failed update leaves no mixed-version app');
  const harness = await freshHarness();
  await harness.install();
  await harness.activate();
  const oldCache = await harness.storage.open(cacheNameFor(MANIFEST.buildVersion));
  const oldEntryCount = oldCache.entries.size;

  const next = await loadWorker(
    stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), {
      ...MANIFEST,
      buildVersion: 'buildccccccccc03',
    }),
  );
  activeHarness = next;
  for (const [name, cache] of harness.storage.caches) next.storage.caches.set(name, cache);
  next.offline = true; // every precache fetch fails

  let installFailed = false;
  try {
    await next.install();
  } catch (error) {
    installFailed = true;
  }
  check(installFailed, 'install rejects when a precache entry cannot be fetched');

  // The failed version never activates, so nothing deletes the live cache.
  const surviving = await next.storage.open(cacheNameFor(MANIFEST.buildVersion));
  checkEqual(surviving.entries.size, oldEntryCount, 'previous version cache is untouched');
  check(
    next.storage.caches.get(cacheNameFor('buildccccccccc03')) === undefined,
    'the aborted version leaves nothing behind — not even an empty cache',
  );
}

function caseManifestGeneratorRejectsRuntimeRoutes(): void {
  console.log('the manifest generator refuses runtime routes');
  let threw = false;
  try {
    assertNoRuntimeRoutes(['index.html', 'api/sessions']);
  } catch (error) {
    threw = true;
  }
  check(threw, 'assertNoRuntimeRoutes rejects an api/ path');

  let ok = true;
  try {
    assertNoRuntimeRoutes(['index.html', 'canvaskit/canvaskit.wasm']);
  } catch (error) {
    ok = false;
  }
  check(ok, 'assertNoRuntimeRoutes accepts a real build manifest');
}

function caseWorkerSourceKeepsItsPlaceholders(): void {
  console.log('the worker source is a template, not a stamped artefact');
  for (const placeholder of [
    '__COSYNCING_BUILD_VERSION__',
    '__COSYNCING_PRECACHE_URLS__',
    '__COSYNCING_RUNTIME_URLS__',
    '__COSYNCING_ASSET_HASHES__',
  ]) {
    check(rawWorkerSource.includes(placeholder), `apps/client/web/sw.js declares ${placeholder}`);
  }
}

let rawWorkerSource = '';

async function main(): Promise<number> {
  rawWorkerSource = await readFile(WORKER_SOURCE_PATH, 'utf8');
  stampedSource = stampWorkerSource(rawWorkerSource, MANIFEST);

  caseWorkerSourceKeepsItsPlaceholders();
  caseManifestGeneratorRejectsRuntimeRoutes();
  await caseReleaseBuildShapeIsShared();
  await caseInstallPrecachesExactlyTheManifest();
  await caseBrokerRoutesAreNeverTouched();
  await caseRuntimeAssetsFillLazily();
  await caseOfflineRepeatStartup();
  await caseUpdateCannotMixTwoBuilds();
  await caseRuntimeSkewIsRefused();
  await caseShellMissIsVerified();
  await caseAbandonedInstallsAreSweptUp();
  await caseActivationKeepsTheOldBuildWhenMarkingFails();
  await caseActivationKeepsTheOldBuildWhenClaimFails();
  await caseCleanupFailureDoesNotBreakActivation();
  await caseLegacyPruneFailureDoesNotBreakActivation();
  await caseCleanupIsScopeLocal();
  await caseNewVersionRemovesObsoleteCaches();
  await caseFailedInstallLeavesTheOldVersionIntact();

  if (failures > 0) {
    console.error(`\nweb static cache audit: ${failures} failed of ${checks} checks`);
    return 1;
  }
  console.log(`\nweb static cache audit: ${checks} checks passed`);
  return 0;
}

process.exit(await main());
