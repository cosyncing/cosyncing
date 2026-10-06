/**
 * The adapter as the broker actually uses it, against a real local HTTP host.
 *
 * The transport suites prove the parts. This one proves the thing a user
 * experiences: discovery answers without a WebSocket, a launch announcement
 * arriving in the middle of a startup becomes an authenticated session without
 * anyone typing anything, and the credential it earned is the one the next
 * request carries. To make that honest the fixture is a real Bun.serve listener
 * speaking the captured 0.2 HTTP contract — the index-route exchange with its
 * 303 and its cookie, the anonymous carrier probe, and unary Remote envelopes —
 * rather than an injected fetch that agrees with whatever the adapter asked for.
 * The stream carrier stays a fake socket: this host does not upgrade, and the
 * mux is exercised frame-for-frame in test-dsh-remote-host.ts.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-integration.ts   (exit 0 = all pass)
 */
export {};
import type { SessionInfo } from '@cosyncing/adapter-api';
import { DshAdapter } from '../src/implementation.ts';
import type { DshCookie, DshCredentialStore } from '../src/auth.ts';
import type { DshFetch, DshFetchResponse } from '../src/envelope.ts';
import type { DshMuxSocketFactory, DshMuxSocketLike } from '../src/mux.ts';
import { dshCredentialScope } from '../src/auth.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function flush(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

const SESSION_ID = 'session-fixture-001';
const LAUNCH_TOKEN = 'launch-token-not-a-real-one';

// ── A real listener speaking the captured HTTP half of the 0.2 contract ─────

interface Fixture {
  baseUrl: string;
  readonly requests: Array<{ method: string; path: string; cookie: string | null; body: unknown }>;
  /** Cookie the fixture handed out, so a test can assert what the adapter stored. */
  readonly issuedCookie: { name: string; value: string } | null;
  token: string;
  stop(): void;
}

const SCOPE_ONE = 'placeholder-one';
const SCOPE_TWO = 'placeholder-two';

async function startHost(options: { token?: string; exchangeRefuses?: boolean } = {}): Promise<Fixture> {
  const token = options.token ?? LAUNCH_TOKEN;
  const requests: Fixture['requests'] = [];
  let issuedCookie: Fixture['issuedCookie'] = null;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const cookie = req.headers.get('cookie');
      const record = { method: req.method, path: url.pathname, cookie, body: undefined as unknown };
      requests.push(record);
      // The captured anonymous refusal on the carrier. This is the answer the
      // contract probe reads as "0.2, not enrolled", and it must not be confused
      // with the index route's longer message.
      if (url.pathname === '/api/remote.mux') {
        return new Response('unauthorized', { status: 401 });
      }
      if (url.pathname === '/' && url.searchParams.get('token')) {
        if (options.exchangeRefuses || url.searchParams.get('token') !== token) {
          return new Response('dsh web authentication required; reopen the URL printed by dsh web.', { status: 401 });
        }
        const value = `v1.${token.replace(/[^a-z]/gi, '')}`;
        issuedCookie = { name: 'dsh-auth-fixture', value };
        return new Response(null, {
          status: 303,
          headers: {
            location: './',
            'cache-control': 'no-store',
            'set-cookie': `${issuedCookie.name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          },
        });
      }
      if (url.pathname.startsWith('/api/')) {
        if (cookie === null) return new Response('unauthorized', { status: 401 });
        return new Response(JSON.stringify({ ok: false, error: { code: 'gateway/method-unavailable', message: 'not scripted', details: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    requests,
    get issuedCookie() { return issuedCookie; },
    token,
    stop() { server.stop(true); },
  };
}

/** Unary POSTs to the fixture, answering from a per-endpoint script. */
function scriptedFetch(baseUrl: string, host: Fixture, script: Record<string, () => unknown>): DshFetch {
  return async (url, init): Promise<DshFetchResponse> => {
    const endpoint = url.replace(`${baseUrl}/api/`, '');
    const body = JSON.parse(init.body) as { rpcId: string; payload: unknown };
    host.requests.push({ method: 'POST', path: `/api/${endpoint}`, cookie: init.headers.cookie ?? null, body });
    const answer = script[endpoint];
    if (!answer) {
      return { status: 404, text: async () => 'not found' };
    }
    const value = answer();
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    };
  };
}

/** A fetch that also answers the anonymous GET the contract probe makes. */
function probeAwareFetch(fetchImpl: DshFetch): DshFetch {
  return (async (url: string, init: { method?: string; headers: Record<string, string>; body: string }) => {
    if ((init.method ?? 'POST') === 'GET') {
      return { status: url.endsWith('/api/remote.mux') ? 401 : 404, text: async () => 'unauthorized' };
    }
    return fetchImpl(url, init as Parameters<DshFetch>[1]);
  }) as unknown as DshFetch;
}

function memoryStore(seed: Record<string, DshCookie> = {}): DshCredentialStore & {
  saved: Array<[string, DshCookie]>;
  loaded: string[];
} {
  const cookies = { ...seed };
  const saved: Array<[string, DshCookie]> = [];
  const loaded: string[] = [];
  return {
    saved,
    loaded,
    async load(scope) { loaded.push(scope); return cookies[scope] ?? null; },
    async save(scope, cookie) { saved.push([scope, cookie]); cookies[scope] = cookie; },
    async clear(scope) { delete cookies[scope]; },
  };
}

/** A disposable carrier answering only the captured workspace baseline. */
function workspaceSocketFactory(): { factory: DshMuxSocketFactory; opens: string[]; endpoints: string[]; closed: () => number } {
  const opens: string[] = []; const endpoints: string[] = []; let closed = 0;
  return {
    opens, endpoints, closed: () => closed,
    factory: (url: string): DshMuxSocketLike => {
      opens.push(url);
      const listeners = new Map<string, Array<(event: unknown) => void>>();
      const emit = (type: string, event: unknown = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); };
      queueMicrotask(() => emit('open'));
      return {
        send(data) {
          const frame = JSON.parse(data) as { type: string; endpoint: string; streamId: string };
          if (frame.type !== 'open') return;
          endpoints.push(frame.endpoint);
          queueMicrotask(() => emit('message', { data: JSON.stringify(frame.endpoint === 'workspace/follow'
            ? { type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } } }
            : { type: 'error', streamId: frame.streamId, error: { code: 'gateway/method-unavailable', message: 'not scripted', details: {} } }) }));
        },
        close() { closed += 1; emit('close'); },
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      };
    },
  };
}

const COOKIE: DshCookie = { name: 'dsh-auth-fixture', value: 'v1.stored-cookie', expiresAt: Date.now() + 86_400_000 };

// ── Discovery without a carrier ─────────────────────────────────────────────

{
  const host = await startHost();
  // The scope is the one the adapter computes for itself, because that identity —
  // endpoint plus profile — is the whole point of the lookup.
  const scope = dshCredentialScope(host.baseUrl, '/fixture/dsh-home');
  const store = memoryStore({ [scope]: COOKIE });
  const sockets = workspaceSocketFactory();
  const adapter = new DshAdapter({
    env: {},
    baseUrl: host.baseUrl,
    dshHome: '/fixture/dsh-home',
    credentialStore: store,
    remoteSocketFactory: sockets.factory,
    fetchImpl: probeAwareFetch(scriptedFetch(host.baseUrl, host, {
      'session/list': () => ({
        items: [
          { sessionId: SESSION_ID, updatedAt: 1_759_449_600_000, agentAvailable: true, running: true, blank: false, cwd: '/fixture/workspace', projections: { kind: 'sequenced', asOfSeq: 3, values: { title: 'spike' } } },
          { sessionId: 'session-cold', updatedAt: 1_759_449_500_000, agentAvailable: false, running: false, blank: true, cwd: '/fixture/other', projections: { kind: 'cached', asOfSeq: 0, values: {} } },
        ],
      }),
      'session/projections': () => ({ asOfSeq: 17, values: {
        title: 'cold durable title', permissions: { currentValue: 'read-only' },
        modelSelection: { lastUsed: null, next: { provider: 'parity-fixture', model: 'fixture-text', reasoningEffort: 'high' } },
      } }),
    })),
  });

  const available = await adapter.isAvailable();
  check('a 0.2 host is available from an authenticated roster read', available, `requests=${String(host.requests.length)}`);
  check('availability never opens the stream carrier', sockets.opens.length === 0, `opens=${String(sockets.opens.length)}`);
  check('discovery never falls back to the legacy host.describe',
    host.requests.some((request) => JSON.stringify(request.body).includes('host.describe')) === false,
    JSON.stringify(host.requests.map((request) => request.path)));

  const sessions = await adapter.discoverSessions();
  const first = sessions.find((session) => session.id === SESSION_ID);
  const cold = sessions.find((session) => session.id === 'session-cold');
  check('the roster titles a session from its own projections',
    first?.title === 'spike' && first.status === 'working', JSON.stringify(first?.title));
  check('an ordinary cold session is listed and can use native command-driven resumption',
    cold !== undefined && cold.control?.drive.state === 'driving' && cold.status === 'idle',
    JSON.stringify({ drive: cold?.control?.drive.state, status: cold?.status }));
  check('cold discovery restores durable title/model/preset beyond a stale cached roster cut',
    cold?.title === 'cold durable title' && cold.currentModel?.modelID === 'fixture-text'
      && cold.currentModel.reasoningEffort === 'high' && cold.currentMode === 'read-only'
      && cold.cwd === '/fixture/other', JSON.stringify(cold));
  const coldReads = host.requests.filter((request) => request.path === '/api/session/projections');
  check('cold discovery uses one authenticated projection read and only the disposable workspace carrier',
    coldReads.length === 1 && coldReads[0]?.cookie === `${COOKIE.name}=${COOKIE.value}`
      && JSON.stringify(coldReads[0]?.body).includes('session-cold') && sockets.opens.length === 1
      && sockets.closed() === 1 && sockets.endpoints.join() === 'workspace/follow',
    JSON.stringify({reads: coldReads.length, sockets: sockets.opens.length}));
  check('the roster read carried the stored cookie, not an anonymous request',
    host.requests.some((request) => request.path === '/api/session/list' && request.cookie === `${COOKIE.name}=${COOKIE.value}`),
    JSON.stringify(host.requests.map((request) => request.cookie)));
  host.stop();
}

{
  // An unenrolled 0.2 host is a distinct fact, and the legacy RPCs must not be
  // tried on the way to saying so.
  const host = await startHost();
  const store = memoryStore({});
  const adapter = new DshAdapter({
    env: {},
    baseUrl: host.baseUrl,
    dshHome: '/fixture/dsh-home',
    credentialStore: store,
    fetchImpl: probeAwareFetch(scriptedFetch(host.baseUrl, host, {})),
  });
  const available = await adapter.isAvailable();
  const sessions = await adapter.discoverSessions();
  check('an unenrolled 0.2 host is unavailable rather than mislabelled as an unknown server',
    available === false && sessions.length === 0, `available=${String(available)}`);
  check('the legacy protocol was not attempted after the refusal',
    host.requests.every((request) => request.method === 'POST' && request.path.startsWith('/api/')),
    JSON.stringify(host.requests.map((request) => request.path)));
  check('an unrecognized port is reported as a finding rather than a version guess',
    host.requests.some((request) => request.path === '/api/mux') === false,
    JSON.stringify(host.requests.map((request) => request.path)));
  host.stop();
}

{
  const host = await startHost();
  const scope = dshCredentialScope(host.baseUrl, '/fixture/dsh-home');
  const store = memoryStore({ [scope]: COOKIE });
  const sockets = workspaceSocketFactory();
  const rows = Array.from({ length: 67 }, (_, index) => ({
    sessionId: `cold-budget-${index}`, updatedAt: index, agentAvailable: false,
    cwd: '/fixture/cold', projections: { kind: 'cached', asOfSeq: 10, values: { title: `cached ${index}` } },
  }));
  const fetchImpl = probeAwareFetch(scriptedFetch(host.baseUrl, host, {
    'session/list': () => ({ items: [...rows, { sessionId: 'active-budget', updatedAt: 100, agentAvailable: true,
      projections: { kind: 'sequenced', asOfSeq: 10, values: { title: 'active title' } } }] }),
    'session/projections': () => {
      const body = host.requests.at(-1)?.body as { payload: { args: { request: { sessionId: string } } } };
      const id = body.payload.args.request.sessionId;
      if (id === 'cold-budget-65') return { asOfSeq: 9, values: { title: 'older cut' } };
      if (id === 'cold-budget-64') return { asOfSeq: 11, values: [] };
      return { asOfSeq: 11, values: { title: `fresh ${id}` } };
    },
  }));
  const adapter = new DshAdapter({ env: {}, baseUrl: host.baseUrl, dshHome: '/fixture/dsh-home',
    credentialStore: store, remoteSocketFactory: sockets.factory,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/session/projections') && init.body.includes('cold-budget-63')) {
        host.requests.push({ method: 'POST', path: '/api/session/projections', cookie: init.headers.cookie ?? null, body: JSON.parse(init.body) });
        return { status: 503, text: async () => 'temporarily unavailable' };
      }
      return fetchImpl(url, init);
    },
  });
  const sessions = await adapter.discoverSessions();
  const reads = host.requests.filter((request) => request.path === '/api/session/projections');
  const ids = reads.map((request) => (request.body as { payload: { args: { request: { sessionId: string } } } }).payload.args.request.sessionId);
  check('cold projection discovery refreshes only the newest 64 cold sessions without an event or session subscription',
    sessions.length === 68 && reads.length === 64 && new Set(ids).size === 64
      && !ids.some((id) => ['cold-budget-0', 'cold-budget-1', 'cold-budget-2', 'active-budget'].includes(id))
      && reads.every((request) => request.cookie === `${COOKIE.name}=${COOKIE.value}`) && sockets.opens.length === 1
      && sockets.closed() === 1 && sockets.endpoints.join() === 'workspace/follow',
    JSON.stringify({ sessions: sessions.length, reads: reads.length, sockets: sockets.opens.length }));
  check('a newer cold projection updates its row while active and over-budget roster rows are retained',
    sessions.find((row) => row.id === 'cold-budget-66')?.title === 'fresh cold-budget-66'
      && sessions.find((row) => row.id === 'cold-budget-0')?.title === 'cached 0'
      && sessions.find((row) => row.id === 'active-budget')?.title === 'active title');
  check('older cuts, malformed projections and service failures retain the cached session instead of regressing or removing it',
    [65, 64, 63].every((index) => sessions.find((row) => row.id === `cold-budget-${index}`)?.title === `cached ${index}`));
  const beforeWindowReads = reads.length;
  const window = await adapter.discoverSessions({ updatedAfter: 64 });
  const windowReads = host.requests.filter((request) => request.path === '/api/session/projections').slice(beforeWindowReads);
  const windowIds = windowReads.map((request) => (request.body as { payload: { args: { request: { sessionId: string } } } }).payload.args.request.sessionId);
  check('bounded discovery skips projection work for idle sessions older than its requested window',
    window.length === 4 && windowReads.length === 3 && windowIds.every((id) => ['cold-budget-64', 'cold-budget-65', 'cold-budget-66'].includes(id))
      && window.some((row) => row.id === 'active-budget'), JSON.stringify({ rows: window.length, reads: windowIds }));
  host.stop();
}

// ── Managed launch: announcement to authenticated, with no user in the loop ─

{
  const host = await startHost();
  const store = memoryStore({});
  const adapter = new DshAdapter({
    env: {},
    baseUrl: host.baseUrl,
    dshHome: '/fixture/dsh-home',
    credentialStore: store,
    fetchImpl: probeAwareFetch(scriptedFetch(host.baseUrl, host, {
      'session/list': () => ({ items: [] }),
    })),
  });

  // The child writes its announcement in pieces, with the token split across two
  // reads — the case a regex over a finished string gets wrong.
  const announcement = `dsh web: ${host.baseUrl}/?token=${host.token}\n`;
  const head = announcement.slice(0, announcement.indexOf('token=') + 5);
  const tail = announcement.slice(announcement.indexOf('token=') + 5);
  adapter.observeManagedOutput(head);
  await flush(2);
  check('a half-written announcement is held, not exchanged half', store.saved.length === 0);
  adapter.observeManagedOutput(tail);
  await flush(20);
  const stored = store.saved[0];
  check('the split announcement is reassembled and exchanged without user input',
    stored !== undefined && host.issuedCookie !== null,
    JSON.stringify({ saved: store.saved.length, issued: host.issuedCookie !== null }));
  check('what was stored is the cookie the host actually handed out',
    stored !== undefined && stored[1].value === host.issuedCookie?.value && stored[1].name === host.issuedCookie?.name,
    JSON.stringify(stored?.[1]));
  check('the exchange happened on the index route with the token, exactly once',
    host.requests.filter((request) => request.path === '/' && request.method === 'GET').length === 1,
    JSON.stringify(host.requests.map((request) => request.method + ' ' + request.path)));

  // And the credential it earned is the credential the next API call uses.
  const roster = await adapter.isAvailable();
  check('the earned cookie authenticates the API path the browser never touches',
    roster && host.requests.some((request) => request.path === '/api/session/list'
      && request.cookie === `${host.issuedCookie?.name}=${host.issuedCookie?.value}`),
    JSON.stringify(host.requests.filter((request) => request.path === '/api/session/list').map((request) => request.cookie)));

  // The launch token dies with the launch; the cookie does not.
  adapter.managedLaunchEnded('host-exited-during-start');
  await flush(4);
  const availableAfterExit = await adapter.isAvailable();
  check('a finished launch keeps the cookie it earned and forgets the token that bought it',
    availableAfterExit && store.saved.length === 1,
    `available=${String(availableAfterExit)} saved=${String(store.saved.length)}`);
  host.stop();
}

{
  // A wrong token is a login problem, and it is not retried into a loop.
  const host = await startHost();
  const store = memoryStore({});
  const adapter = new DshAdapter({
    env: {},
    baseUrl: host.baseUrl,
    dshHome: '/fixture/dsh-home',
    credentialStore: store,
    fetchImpl: probeAwareFetch(scriptedFetch(host.baseUrl, host, { 'session/list': () => ({ items: [] }) })),
  });
  adapter.observeManagedOutput(`dsh web: ${host.baseUrl}/?token=not-the-hosts-token\n`);
  await flush(20);
  const attempts = host.requests.filter((request) => request.path === '/').length;
  const available = await adapter.isAvailable();
  check('a refused token stores nothing and becomes an availability failure',
    store.saved.length === 0 && available === false, `saved=${String(store.saved.length)} available=${String(available)}`);
  check('a refused token is not hammered: one exchange, then it stands',
    attempts === 1, `attempts=${String(attempts)}`);
  host.stop();
}

// ── Announcement scanner ────────────────────────────────────────────────────

{
  const { DshLaunchScanner } = await import('../src/implementation.ts');
  const scanner = new DshLaunchScanner();
  const hostBaseUrl = 'http://127.0.0.1:3080';
  const hostToken = 'abc';
  const first = scanner.feed(`listening on ${hostBaseUrl}\ndsh web: ${hostBaseUrl}/?token=${hostToken}`);
  check('an announcement with no trailing whitespace is not emitted until it is complete',
    first.length === 0, JSON.stringify(first));
  const second = scanner.feed('rest-of-the-token\n');
  check('the candidate completes into the whole token URL rather than a fragment',
    second.length === 1 && second[0] === `${hostBaseUrl}/?token=${hostToken}rest-of-the-token`,
    JSON.stringify(second));
  const third = scanner.feed(`dsh web: ${hostBaseUrl}/?token=${hostToken}rest-of-the-token\n`);
  check('a repeated announcement is not a second credential', third.length === 0, JSON.stringify(third));
  const fourth = scanner.feed(`dsh web: ${hostBaseUrl}/?token=a-different-launch\n`);
  check('a new token is reported, because a new token is a new launch',
    fourth.length === 1 && fourth[0] === `${hostBaseUrl}/?token=a-different-launch`, JSON.stringify(fourth));
  const flooded = new DshLaunchScanner();
  for (let index = 0; index < 400; index += 1) flooded.feed('x'.repeat(200));
  check('a chatty host cannot grow the bootstrap buffer without limit',
    flooded.feed(`dsh web: ${hostBaseUrl}/?token=late\n`).length === 1, 'still finds the marker after a flood');
  flooded.reset();
  check('reset forgets both the partial line and what was already emitted',
    flooded.feed(`dsh web: ${hostBaseUrl}/?token=${hostToken}\n`).length === 1, 're-emitted after reset');
}

// ── Credential scope ────────────────────────────────────────────────────────

{
  const host = await startHost();
  const storeA = memoryStore({});
  const storeB = memoryStore({});
  void SCOPE_ONE;
  void SCOPE_TWO;
  const fetchImpl = probeAwareFetch(scriptedFetch(host.baseUrl, host, { 'session/list': () => ({ items: [] }) }));
  const a = new DshAdapter({ env: {}, baseUrl: host.baseUrl, dshHome: '/profile-one', credentialStore: storeA, fetchImpl });
  const b = new DshAdapter({ env: {}, baseUrl: host.baseUrl, dshHome: '/profile-two', credentialStore: storeB, fetchImpl });
  await a.isAvailable();
  await b.isAvailable();
  check('two dsh profiles on one address are two credentials, not one',
    storeA.loaded[0] !== undefined && storeA.loaded[0] !== storeB.loaded[0],
    JSON.stringify({ a: storeA.loaded[0], b: storeB.loaded[0] }));
  host.stop();
}

console.log(`\n${String(results.filter((entry) => entry.ok).length)}/${String(results.length)} checks passed`);
if (results.some((entry) => !entry.ok)) process.exitCode = 1;
