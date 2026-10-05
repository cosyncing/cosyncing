/**
 * The launch-token exchange and the credential it produces.
 *
 * Two properties carry the weight here. The first is that a credential travels
 * nowhere it was not earned: the launch URL arrives from a child process's
 * stdout, and exchanging a URL that names some other authority would hand a
 * full-control token to that host. The second is that the token's lifetime is
 * the launch's lifetime — long enough to renew a cookie without restarting
 * anyone's agent, and no longer than the process that printed it.
 *
 * Every fetch, store, timer and clock in here is injected. No dsh, no port.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-auth.ts
 */
export {};
import {
  dshApplicationUrl,
  DSH_AUTH_RENEW_RETRY_MS,
  dshCookieNameForOrigin,
  dshCredentialScope,
  DshAuthSession,
  parseDshLaunchUrl,
  type DshAuthResponseLike,
  type DshCookie,
  type DshCredentialStore,
} from '../src/auth.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const BASE = 'http://127.0.0.1:3080';
const TOKEN = 'tok-abc123';

interface Recorded {
  url: string;
  init: { method: string; redirect: string; headers: Record<string, string> };
}

function response(
  status: number,
  headers: Record<string, string | string[]> = {},
): DshAuthResponseLike {
  return {
    status,
    headers: {
      get: (name: string) => {
        const value = headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] ?? null : value ?? null;
      },
      getSetCookie: () => {
        const value = headers['set-cookie'];
        return value === undefined ? [] : Array.isArray(value) ? value : [value];
      },
    },
  };
}

/** The answer a real host gives a valid launch URL. */
function okResponse(): DshAuthResponseLike {
  return response(303, {
    location: './',
    'set-cookie': `${COOKIE_NAME}=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function harness(
  handler: (url: string, attempt: number) => DshAuthResponseLike,
  options: {
    store?: DshCredentialStore;
    now?: () => number;
  } = {},
): { session: DshAuthSession; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    now: options.now ?? (() => 1_700_000_000_000),
    ...(options.store ? { store: options.store } : {}),
    fetchImpl: async (url, init) => {
      requests.push({ url, init: { method: init.method, redirect: init.redirect, headers: init.headers } });
      return handler(url, requests.length);
    },
  });
  return { session, requests };
}

function memoryStore(): DshCredentialStore & { records: Map<string, DshCookie>; saves: number } {
  const records = new Map<string, DshCookie>();
  return {
    records,
    saves: 0,
    async load(scope) { return records.get(scope) ?? null; },
    async save(scope, cookie) { records.set(scope, cookie); this.saves += 1; },
    async clear(scope) { records.delete(scope); },
  };
}

const COOKIE_NAME = dshCookieNameForOrigin(BASE);

// ── 1. Launch URL parsing ───────────────────────────────────────────────────

{
  const parsed = parseDshLaunchUrl(`${BASE}/?token=${TOKEN}`, BASE);
  check('a launch URL splits into an authority and a credential held apart',
    parsed.origin === 'http://127.0.0.1:3080' && parsed.token === TOKEN, JSON.stringify(parsed));

  // Each case carries a canary that must NOT come back out in the message, so
  // the assertion is about the secret rather than about the word for it.
  const refused: string[] = [];
  for (const [raw, why, canary] of [
    ['http://evil.example:3080/?token=CANARYAUTH', 'different authority', 'CANARYAUTH'],
    ['http://127.0.0.1:3081/?token=CANARYPORT', 'different port', 'CANARYPORT'],
    ['http://127.0.0.1:3080/login?token=CANARYPATH', 'not the index route', 'CANARYPATH'],
    ['http://127.0.0.1:3080/', 'no token at all', ''],
    ['http://127.0.0.1:3080/?token=', 'empty token', ''],
    ['http://127.0.0.1:3080/?token=CANARYTWO&token=other', 'two tokens', 'CANARYTWO'],
    ['ftp://127.0.0.1:3080/?token=CANARYSCHEME', 'not http(s)', 'CANARYSCHEME'],
    ['not a url at all', 'unparseable', ''],
  ] as const) {
    try {
      parseDshLaunchUrl(raw, BASE);
      refused.push(`ACCEPTED ${why}`);
    } catch (error) {
      const message = (error as Error).message;
      if (canary && message.includes(canary)) refused.push(`LEAKED ${why}`);
      if (message.includes('http://') || message.includes('https://')) refused.push(`URL ${why}`);
    }
  }
  check('every unusable launch URL is refused, echoing no token and no URL',
    refused.length === 0, refused.join(', '));

  check('the token-free application URL is available without the credential',
    dshApplicationUrl(BASE) === 'http://127.0.0.1:3080', dshApplicationUrl(BASE));

  // The cookie name is the host's own construction: prefix + base64url of the
  // SHA-256 of the canonical host:port. Pinned so a rename upstream is noticed
  // as a change rather than silently accepted as "some cookie".
  check('the cookie name binds the authority rather than the whole URL',
    COOKIE_NAME.startsWith('dsh-auth-') && COOKIE_NAME.length > 20
      && dshCookieNameForOrigin('http://127.0.0.1:3080/x') === COOKIE_NAME
      && dshCookieNameForOrigin('http://127.0.0.1:3081') !== COOKIE_NAME,
    COOKIE_NAME);

  check('the credential scope binds origin and DSH home and is not a path',
    /^[0-9a-f]{32}$/.test(dshCredentialScope(BASE, '/var/lib/dsh-profile'))
      && dshCredentialScope(BASE, '/var/lib/dsh-profile') === dshCredentialScope(`${BASE}/`, '/var/lib/dsh-profile')
      && dshCredentialScope(BASE, '/other') !== dshCredentialScope(BASE, '/var/lib/dsh-profile'),
    dshCredentialScope(BASE, '/var/lib/dsh-profile'));
}

// ── 2. A successful exchange ────────────────────────────────────────────────

{
  const store = memoryStore();
  const { session, requests } = harness((url) => {
    if (!url.includes('token=')) return response(401);
    return response(303, { location: './', 'set-cookie': `${COOKIE_NAME}=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict` });
  }, { store });

  check('a fresh session reports the missing credential as its own state',
    session.state === 'absent' && session.reason === 'no-credential' && session.cookieHeader() === null,
    `${session.state}/${session.reason}`);

  session.adoptLaunchToken(TOKEN);
  const outcome = await session.ensure();
  check('an owned launch token reaches authenticated readiness on its own',
    outcome.state === 'authenticated' && session.cookieHeader() === `${COOKIE_NAME}=v1.body.sig`,
    `${outcome.state}: ${outcome.detail}`);
  const only = requests[0];
  check('the exchange is a manual-redirect GET on the index route only',
    requests.length === 1 && only !== undefined && only.init.method === 'GET'
      && only.init.redirect === 'manual' && only.url === `${BASE}/?token=${encodeURIComponent(TOKEN)}`,
    JSON.stringify(only));
  check('the expiry the host sent is kept, so a later expiry check is the host\'s own',
    session.cookieHeader(1_700_000_000_000 + 2_591_000_000) !== null
      && session.cookieHeader(1_700_000_000_000 + 2_592_001_000) === null);
  check('the verified credential is persisted and the raw token is not',
    store.saves === 1 && store.records.get('scope-test')?.value === 'v1.body.sig'
      && ![...store.records.values()].some((record) => JSON.stringify(record).includes(TOKEN)),
    JSON.stringify([...store.records.values()]));

  const detail = session.detail;
  check('no diagnostic surface quotes the token or the raw cookie value',
    !detail.includes(TOKEN) && !detail.includes('v1.body.sig'), detail);
}

// ── 3. Refusals ─────────────────────────────────────────────────────────────

{
  const { session, requests } = harness(() => response(401, {}));
  session.adoptLaunchToken(TOKEN);
  const outcome = await session.ensure();
  check('a refused token is a rejection, not a retryable miss',
    outcome.state === 'rejected' && outcome.reason === 'token-invalid', `${outcome.state}/${outcome.reason}`);
  check('a refused token is spent rather than re-fired at the host',
    requests.length === 1, String(requests.length));

  const blocked = harness(() => response(403, {}));
  blocked.session.adoptLaunchToken(TOKEN);
  const blockedOutcome = await blocked.session.ensure();
  check('a Host or Origin refusal blocks rather than cycles: retrying cannot change it',
    blockedOutcome.state === 'blocked' && blockedOutcome.reason === 'host-or-origin-refused',
    `${blockedOutcome.state}/${blockedOutcome.reason}`);
  const after = await blocked.session.ensure();
  check('a blocked session stays blocked through every later readiness attempt',
    after.state === 'blocked' && blocked.requests.length === 1,
    `${after.state} after ${String(blocked.requests.length)} requests`);

  const redirected = harness(() => response(303, {
    location: 'http://elsewhere.example:9999/',
    'set-cookie': `${COOKIE_NAME}=stolen`,
  }));
  redirected.session.adoptLaunchToken(TOKEN);
  const redirectedOutcome = await redirected.session.ensure();
  check('a redirect off the configured authority is not followed and no cookie is taken',
    redirectedOutcome.state === 'rejected' && redirectedOutcome.reason === 'redirect-off-origin'
      && redirected.session.cookieHeader() === null,
    `${redirectedOutcome.state}/${redirectedOutcome.reason}`);

  const silent = harness(() => response(303, { location: './' }));
  silent.session.adoptLaunchToken(TOKEN);
  const silentOutcome = await silent.session.ensure();
  check('an authentication without a cookie is a failure, not a success with a blank',
    silentOutcome.state === 'rejected' && silentOutcome.reason === 'no-cookie-in-response',
    `${silentOutcome.state}/${silentOutcome.reason}`);

  const redirectedHome = harness(() => response(303, { location: './', 'set-cookie': `${COOKIE_NAME}=v1.a.b` }));
  redirectedHome.session.adoptLaunchToken(TOKEN);
  await redirectedHome.session.ensure();
  check('a relative redirect to the same origin is accepted',
    redirectedHome.session.state === 'authenticated', redirectedHome.session.detail);
}

// ── 4. Coalescing, restart, and the token's lifetime ────────────────────────

{
  let hits = 0;
  const store = memoryStore();
  const { session, requests } = harness(() => {
    hits += 1;
    return response(303, { location: './', 'set-cookie': `${COOKIE_NAME}=v1.a.b` });
  }, { store });
  session.adoptLaunchToken(TOKEN);
  const five = await Promise.all([session.ensure(), session.ensure(), session.ensure(), session.ensure(), session.ensure()]);
  check('five concurrent readiness attempts spend exactly one exchange',
    hits === 1 && requests.length === 1 && five.every((entry) => entry.state === 'authenticated'),
    `${String(hits)} exchanges, ${String(requests.length)} requests`);
}

{
  const store = memoryStore();
  store.records.set('scope-test', { name: COOKIE_NAME, value: 'stored-cookie' });
  let hits = 0;
  const { session } = harness(() => {
    hits += 1;
    return response(401, {});
  }, { store });
  const outcome = await session.ensure();
  check('a broker restart reuses the persisted cookie instead of needing a new token',
    outcome.state === 'authenticated' && session.cookieHeader() === `${COOKIE_NAME}=stored-cookie` && hits === 0,
    `${outcome.state} after ${String(hits)} requests`);

  const { session: expired } = harness(() => response(401, {}), {
    store: (() => {
      const s = memoryStore();
      s.records.set('scope-test', { name: COOKIE_NAME, value: 'dead', expiresAt: 1_000 });
      return s;
    })(),
  });
  const expiredOutcome = await expired.ensure();
  check('an expired stored cookie is cleared and reported as expiry, not as a broken host',
    expiredOutcome.reason === 'cookie-expired' || expiredOutcome.reason === 'no-credential',
    JSON.stringify(expiredOutcome));
}

{
  // A clock the test turns, because renewal is a statement about the future and
  // a suite that waits for the future is a suite nobody runs.
  let clock = 1_700_000_000_000;
  const store = memoryStore();
  const { session, requests } = harness(() => response(303, {
    location: './',
    'set-cookie': `${COOKIE_NAME}=v1.a.b; Max-Age=2592000; Path=/`,
  }), { store, now: () => clock });
  session.adoptLaunchToken('token-one');
  await session.ensure();
  const before = requests.length;

  // Still 29 days of cookie left, so a second readiness check must NOT spend an
  // exchange: renewal is for a credential that is dying, not for one that works.
  await session.ensure();
  check('a credential with most of its life left is not renewed on every readiness check',
    requests.length === before, `${String(requests.length)} requests`);

  // Move to inside the renewal window and hand the session a NEW launch, which
  // is the managed-restart case: the surviving cookie, the new token.
  clock += 2_505_600_000;
  session.adoptLaunchToken('token-two');
  await session.ensure();
  const renewed = requests.slice(before).map((entry) => entry.url.split('?')[1] ?? '');
  check('a dying credential is renewed with the current launch token and not the superseded one',
    session.hasLaunchToken && requests.length > before
      && renewed.length === 1 && renewed[0] === 'token=token-two',
    `${renewed.join(' ')} (of ${requests.length} total)`);

  session.releaseLaunchToken();
  const released = await session.ensure();
  check('releasing the token keeps a working cookie but ends the renewal path',
    released.state === 'authenticated' && !session.hasLaunchToken,
    `${released.state}/${String(session.hasLaunchToken)}`);

  session.releaseLaunchToken(false);
  check('dropping the cookie too returns the session to the state it started in',
    session.state === 'absent' && session.cookieHeader() === null, session.state);
}

{
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    fetchImpl: async () => {
      throw new Error('never');
    },
  });
  session.adoptLaunchToken(TOKEN);
  const outcome = await session.ensure();
  // A host that did not answer is not a host that refused. The old reading said
  // "rejected", spent the token, and turned one dropped packet into permanent
  // re-enrollment; the corrected reading keeps the token and says unreachable.
  check('an exchange that never completes is unreachable rather than refused, and keeps its token',
    outcome.state === 'absent' && outcome.reason === 'exchange-unreachable'
      && outcome.detail.length > 0 && !outcome.detail.includes(TOKEN)
      && session.hasLaunchToken,
    JSON.stringify(outcome));
  // …and the next attempt, with the network back, gets in with the same token.
  let attempts = 0;
  const recoverable = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('no route to host');
      return okResponse();
    },
  });
  recoverable.adoptLaunchToken(TOKEN);
  const first = await recoverable.ensure();
  const second = await recoverable.ensure();
  check('one unreachable exchange does not retire the token that would have worked a moment later',
    first.reason === 'exchange-unreachable' && second.state === 'authenticated' && attempts === 2,
    `${first.reason} then ${second.state} after ${String(attempts)} attempts`);
}

// ── Renewal survives a transient failure (review R8) ─────────────────────────

{
  let now = 1_000;
  let calls = 0;
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    now: () => now,
    renewAheadMs: 1_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) throw new Error('temporary network loss');
      return okResponse();
    },
  });
  session.adoptLaunchToken(TOKEN);
  await session.ensure();
  // Walk to the last seconds of the cookie's real life, which is where a renewal
  // window actually opens. okResponse issues Max-Age=2592000 from `now`, so the
  // expiry is known: land just inside the window rather than past the expiry,
  // which would read as a pass while testing an already-dead credential.
  now += 2_592_000 * 1_000 - 500;
  const renewal = await session.ensure();
  const header = session.cookieHeader();
  const retainedToken = session.hasLaunchToken;
  // …and the renewal that failed is retried, rather than leaving the credential
  // to lapse into a re-enrollment prompt.
  now += 60_000;
  const recovered = await session.ensure();
  check('a renewal that could not reach the host keeps both the cookie and the token',
    renewal.state === 'authenticated' && header !== null && retainedToken,
    `${renewal.state}/${renewal.reason} header=${String(header !== null)} token=${String(retainedToken)}`);
  check('the failed renewal is retried once its backoff passes, and then succeeds',
    recovered.state === 'authenticated' && calls === 3, `${recovered.state} after ${String(calls)} calls`);
}

// ── Ownership fences an in-flight exchange (review R9) ───────────────────────

{
  const released = deferred<DshAuthResponseLike>();
  let saves = 0;
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    fetchImpl: () => released.promise,
    store: { load: async () => null, save: async () => { saves += 1; }, clear: async () => {} },
  });
  session.adoptLaunchToken(TOKEN);
  const inFlight = session.ensure();
  await tick();
  session.releaseLaunchToken(false);
  released.resolve(okResponse());
  await inFlight;
  // The exchange used a token whose launch had already been released. Publishing
  // it would put a cookie for a dead launch into the CURRENT state and, worse,
  // into the store, where it outlives the process that learned it.
  check('an exchange finishing after its launch was released publishes nothing',
    session.state === 'absent' && session.cookieHeader() === null && saves === 0,
    `${session.state} cookie=${String(session.cookieHeader() !== null)} saves=${String(saves)}`);
}

{
  const stale = deferred<DshAuthResponseLike>();
  let saves = 0;
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    fetchImpl: () => stale.promise,
    store: { load: async () => null, save: async () => { saves += 1; }, clear: async () => {} },
  });
  session.adoptLaunchToken(TOKEN);
  const inFlight = session.ensure();
  await tick();
  // A second owned launch supersedes the first. Its token is the only one the
  // current host will accept, so the old exchange must not land after it.
  session.adoptLaunchToken(`${TOKEN}-second`);
  stale.resolve(okResponse());
  await inFlight;
  check('a replacement launch token fences the exchange started with the one it replaced',
    session.state === 'absent' && saves === 0 && session.hasLaunchToken,
    `${session.state} saves=${String(saves)}`);
}

// ── A store that will not answer is not an empty store (review R10) ──────────

{
  let exchanges = 0;
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    fetchImpl: async () => {
      exchanges += 1;
      return okResponse();
    },
    store: {
      load: async () => { throw new Error('unsafe credential file'); },
      save: async () => {},
      clear: async () => {},
    },
  });
  session.adoptLaunchToken(TOKEN);
  const outcome = await session.ensure();
  // Failing to READ a credential must not become a licence to overwrite it, and
  // the operator's remedy is to fix the file rather than to re-enroll.
  check('a credential store that refuses to answer is reported as storage, not as missing enrollment',
    outcome.state === 'blocked' && outcome.reason === 'storage-unavailable'
      && outcome.detail.includes('repair') && exchanges === 0,
    JSON.stringify({ ...outcome, exchanges }));
}

{
  let rejectOld!: (reason: unknown) => void;
  let loads = 0;
  const firstLoad = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
  const session = new DshAuthSession({
    baseUrl: BASE,
    scope: 'scope-test',
    store: {
      load: () => {
        loads += 1;
        return loads === 1 ? firstLoad : Promise.resolve({ name: 'dsh-auth-x', value: 'new-cookie' });
      },
      save: async () => {},
      clear: async () => {},
    },
  });
  const old = session.ensure();
  session.invalidate();
  await session.ensure();
  const before = session.state;
  rejectOld(new Error('the old load failed'));
  await old;
  check('a superseded store failure cannot dismantle the session that replaced it',
    before === 'authenticated' && session.state === 'authenticated' && session.cookieHeader() !== null,
    `${before} -> ${session.state}`);
}

{
  const session = new DshAuthSession({ baseUrl: BASE, scope: 'scope-test' });
  session.adoptLaunchToken(TOKEN);
  const pending = session.ensure();
  session.invalidate();
  await pending;
  check('an in-flight exchange cannot publish itself over an invalidation',
    session.state === 'absent' && session.cookieHeader() === null, session.state);
}

// ── 7. Delayed persistence, ownership fencing, and temporary HTTP failures ──
//
// Round 2 of the review showed three ways a credential could outlive the thing
// that earned it. All three are invisible to a suite that only delays the HTTP
// response, because in each case the write or the publication finishes after a
// check that had already passed.

{
  // F1: two writes to one scope commit in the order the store happens to
  // finish them, which is not the order they were asked for. The old attempt is
  // already inside store.save when the scope is replaced, so nothing can take
  // its credential back; the new one has to win the file regardless.
  const persisted: string[] = [];
  let releaseOldSave!: () => void;
  const oldSave = new Promise<void>((resolve) => { releaseOldSave = resolve; });
  const store: DshCredentialStore = {
    async load() { return null; },
    async save(_scope, cookie) {
      const tag = cookie.value.split(".")[0] ?? cookie.value;
      persisted.push(tag);
      if (tag === "old") await oldSave;
    },
    async clear() {},
  };
  let calls = 0;
  const session = new DshAuthSession({
    baseUrl: BASE, scope: "scope-test", store, now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls += 1;
      return response(303, {
        location: "./",
        "set-cookie": `${COOKIE_NAME}=${calls === 1 ? "old" : "new"}.body.sig; Max-Age=2592000; Path=/`,
      });
    },
  });
  session.adoptLaunchToken("token-old");
  const first = session.ensure();
  await tick();
  await tick();
  // The old write is in the store now. Replace the whole scope and earn a
  // cookie under a new launch; the new write is queued behind the old one.
  session.invalidate();
  session.adoptLaunchToken("token-new");
  const second = session.ensure();
  await tick();
  await tick();
  releaseOldSave();
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  check("a new launch earns its own exchange rather than reusing the replaced scope",
    calls === 2 && secondOutcome.state === "authenticated"
      && session.cookieHeader()?.includes("new") === true,
    JSON.stringify({ calls, first: firstOutcome.state, second: secondOutcome.state,
      header: session.cookieHeader(), persisted }));
  // The failure the review reproduced: the superseded cookie arrives last and
  // becomes what the next process start reads. Order of COMMIT is the property,
  // not how many writes happened.
  check("the credential a restart would read back is the newest one, not the superseded one",
    persisted.at(-1) === "new" && persisted.join(",") === "old,new",
    persisted.join(","));
}

{
  // F1's other half. A write that is still WAITING when the scope is replaced
  // must never begin, because by then it is writing a credential for a launch
  // that no longer exists into a file somebody else now owns. The queue is what
  // makes this observable: the old write holds it, the newer write waits behind
  // it, and the fence is re-read at the instant that newer write would start.
  const log: string[] = [];
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const store: DshCredentialStore = {
    async load() { return null; },
    async save(_scope, cookie) {
      const tag = cookie.value.split(".")[0] ?? cookie.value;
      log.push(`start:${tag}`);
      if (tag === "1") await held;
      log.push(`done:${tag}`);
    },
    async clear() {},
  };
  let clock = 1_700_000_000_000;
  let calls = 0;
  const session = new DshAuthSession({
    baseUrl: BASE, scope: "scope-test", store, now: () => clock, renewAheadMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return response(303, {
        location: "./",
        "set-cookie": `${COOKIE_NAME}=${String(calls)}.body.sig; Max-Age=2592000; Path=/`,
      });
    },
  });
  session.adoptLaunchToken("token-first");
  const first = session.ensure();
  await tick();
  await tick();
  // A renewal under a second launch token reaches its own write and queues
  // behind the one still being held. A live cookie means this is a renewal, so
  // the credential has to be dying for the exchange to run at all.
  clock += 2_592_000_000 - 30_000;
  session.adoptLaunchToken("token-second");
  const second = session.ensure();
  await tick();
  await tick();
  // The second attempt's launch goes away while its write is still queued.
  session.invalidate();
  releaseHeld();
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  check("a store write that has not begun when its scope is replaced never begins",
    !log.includes("start:2"),
    log.join(","));
  check("the write already in the store when the scope changed still completes",
    log.includes("done:1") && firstOutcome.state !== "authenticated" && secondOutcome.state !== "authenticated",
    `${log.join(",")} first=${firstOutcome.state} second=${secondOutcome.state}`);
}

{
  // F5: a store read that resolves after its launch was released.
  const load = deferred<DshCookie | null>();
  const store: DshCredentialStore = {
    load: () => load.promise,
    async save() {},
    async clear() {},
  };
  const session = new DshAuthSession({
    baseUrl: BASE, scope: 'scope-test', store, now: () => 1_700_000_000_000,
    fetchImpl: async () => okResponse(),
  });
  session.adoptLaunchToken(TOKEN);
  const inflight = session.ensure();
  await tick();
  session.releaseLaunchToken(false);
  load.resolve({ name: COOKIE_NAME, value: 'stale-cookie.sig', expiresAt: 1_700_000_000_000 + 3_600_000 });
  await inflight;
  check('a store read resolving after release publishes nothing',
    session.state !== 'authenticated' && session.cookieHeader() === null,
    `${session.state} header=${String(session.cookieHeader())}`);
  // And the scope is still readable afterwards: one superseded read may not
  // leave the session convinced it has already consulted the store.
  const after = await session.ensure();
  check('a superseded read does not mark the scope settled for the next attempt',
    after.state === 'absent' || after.state === 'exchanging' || after.state === 'authenticated',
    after.state);
}

{
  // F5: two attempts under one scope generation. The old one finishing must not
  // dissolve the newer one's coalescing entry and start a third exchange.
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const session = new DshAuthSession({
    baseUrl: BASE, scope: 'scope-test', now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return response(303, {
        location: './',
        'set-cookie': `${COOKIE_NAME}=v${String(calls)}.body.sig; Max-Age=2592000; Path=/`,
      });
    },
  });
  session.adoptLaunchToken('token-a');
  const a = session.ensure();
  await tick();
  session.adoptLaunchToken('token-b');
  const b = session.ensure();
  const c = session.ensure();
  releaseFirst();
  await Promise.all([a, b, c]);
  check('an old exchange finishing does not un-coalesce the replacement',
    calls === 2, `${String(calls)} exchanges for two launches`);
}

{
  // F7: 503 is a host that is busy, not a host that said no.
  let now = 1_700_000_000_000;
  let calls = 0;
  const session = new DshAuthSession({
    baseUrl: BASE, scope: 'scope-test', now: () => now, renewAheadMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) return response(503, {});
      return okResponse();
    },
  });
  session.adoptLaunchToken(TOKEN);
  await session.ensure();
  now += 2_592_000_000 - 500;
  const renewal = await session.ensure();
  check('a 503 during renewal is not read as a refused token',
    session.state === 'authenticated' && session.hasLaunchToken && session.cookieHeader() !== null,
    `${session.state}/${renewal.reason} header=${String(session.cookieHeader() !== null)}`);
  now += DSH_AUTH_RENEW_RETRY_MS;
  const retried = await session.ensure();
  check('the retryable refusal is retried and then succeeds',
    retried.state === 'authenticated' && calls === 3, `${retried.state} after ${String(calls)} calls`);

  // The same status on the FIRST exchange must not burn the token either.
  const cold = new DshAuthSession({
    baseUrl: BASE, scope: 'scope-test',
    fetchImpl: async () => response(503, {}),
  });
  cold.adoptLaunchToken(TOKEN);
  const failed = await cold.ensure();
  check('a 503 on the first exchange keeps the token for a later try',
    failed.state === 'absent' && failed.reason === 'exchange-unreachable' && cold.hasLaunchToken,
    JSON.stringify(failed));

  // And a refusal that IS about the credential still retires it.
  const refused = new DshAuthSession({
    baseUrl: BASE, scope: 'scope-test', fetchImpl: async () => response(401, {}),
  });
  refused.adoptLaunchToken(TOKEN);
  const refusedOutcome = await refused.ensure();
  check('a 401 still retires the token it was shown',
    refusedOutcome.state === 'rejected' && refusedOutcome.reason === 'token-invalid' && !refused.hasLaunchToken,
    JSON.stringify(refusedOutcome));
}

// ── 9. The enrollment is a file another process writes ───────────────────────
//
// `cosy dsh connect` and `cosy dsh disconnect` run in a terminal, against the
// same credential file a running broker holds in memory. A session that reads
// that file once and memoizes it makes both commands inert until the next
// restart, which is not what they promise: the operator enrolls, the broker
// carries on saying it has nothing, and the only fix is a restart nobody
// mentioned. These tests hold ONE warm session open across every enrollment
// change, because the warm case is the only one that was ever broken.

{
  // The enrollment appearing is the whole of what `cosy dsh connect` does to a
  // running broker: it writes a cookie. Nothing else tells this process.
  const store = memoryStore();
  const { session, requests } = harness(() => response(401, {}), { store });
  const before = await session.ensure();
  check('a warm session with nothing enrolled says so and sends nothing',
    before.state !== 'authenticated' && requests.length === 0,
    `${before.state} / ${String(requests.length)} requests`);

  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v1.enrolled', expiresAt: 1_700_000_000_000 + 3_600_000 });
  const after = await session.ensure();
  check('the SAME session authenticates once the enrollment appears, with no restart',
    after.state === 'authenticated' && session.cookieHeader() === `${COOKIE_NAME}=v1.enrolled`,
    `${after.state} / ${session.cookieHeader() ?? 'no cookie'}`);

  // ... and `disconnect` has to work in the other direction just as quietly.
  store.records.clear();
  const withdrawn = await session.ensure();
  check('the SAME session stops authenticating when the enrollment is withdrawn',
    withdrawn.state !== 'authenticated' && session.cookieHeader() === null,
    `${withdrawn.state} / ${session.cookieHeader() ?? 'no cookie'}`);
  check('a withdrawn enrollment is reported as no credential, not as a refused one',
    withdrawn.reason === 'no-credential', withdrawn.reason ?? '');
}

{
  // A replacement is not a removal followed by an addition as far as a live
  // carrier is concerned: the socket has to be re-handshaked either way, and the
  // three cases must be told apart or a link cannot know whether to reconnect.
  const store = memoryStore();
  const { session } = harness(() => response(401, {}), { store });
  const changes: Array<{ change: string; revision: number }> = [];
  session.onCredentialChange((change, revision) => { changes.push({ change, revision }); });
  const first = session.credentialRevision;
  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v1.a', expiresAt: 1_700_000_000_000 + 3_600_000 });
  await session.ensure();
  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v2.b', expiresAt: 1_700_000_000_000 + 3_600_000 });
  await session.ensure();
  store.records.clear();
  await session.ensure();
  check('adoption, replacement and removal are each reported, once and in order',
    JSON.stringify(changes.map((entry) => entry.change)) === JSON.stringify(['adopted', 'replaced', 'removed']),
    JSON.stringify(changes));
  check('the revision moves for every identity change and only for those',
    changes.every((entry, index) => entry.revision === first + index + 1), JSON.stringify(changes));
  const steady = session.credentialRevision;
  await session.ensure();
  await session.ensure();
  check('reading an unchanged enrollment again is not a change',
    session.credentialRevision === steady, `${String(steady)} -> ${String(session.credentialRevision)}`);
}

{
  // Renewal must stay bounded now that the enrollment is re-read on every call.
  // "A token is in hand" is not a premise for exchanging again -- the cookie's
  // own expiry window is -- or every readiness probe becomes a GET.
  let now = 1_700_000_000_000;
  const store = memoryStore();
  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v1.long', expiresAt: now + 20 * 86_400_000 });
  const { session, requests } = harness(() => response(303, {
    location: './',
    'set-cookie': `${COOKIE_NAME}=v2.renewed; Max-Age=2592000; Path=/`,
  }), { store, now: () => now });
  session.adoptLaunchToken(TOKEN);
  for (let index = 0; index < 5; index += 1) {
    const outcome = await session.ensure();
    check(`a fresh stored cookie answers readiness without an exchange (attempt ${String(index + 1)})`,
      outcome.state === 'authenticated' && requests.length === 0,
      `${outcome.state} / ${String(requests.length)} exchanges`);
  }
  now += 20 * 86_400_000;
  const renewed = await session.ensure();
  check('the same cookie does get renewed once it is actually nearing expiry',
    renewed.state === 'authenticated' && requests.length === 1, `${String(requests.length)} exchanges`);
}

{
  // A refusal is an opinion about ONE cookie, so it has to die when that cookie
  // does. Refusals arrive from real requests rather than from `ensure()` -- a
  // stored, unexpired cookie is trusted until something actually 401s -- so this
  // walks the production sequence: warm session, a request that gets refused,
  // then `cosy dsh connect` writing a fresh enrollment into the same file.
  const store = memoryStore();
  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v1.dead', expiresAt: 1_700_000_000_000 + 3_600_000 });
  const { session, requests } = harness(() => response(401, {}), { store });
  const warm = await session.ensure();
  check('a warm session authenticates from the enrollment without asking the host',
    warm.state === 'authenticated' && requests.length === 0,
    `${warm.state} / ${String(requests.length)} requests`);

  session.reportCredentialRefused('credential-refused');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  check('a refused cookie is dropped and taken out of the store',
    session.cookieHeader() === null && store.records.size === 0,
    `${session.cookieHeader() ?? 'no cookie'} / ${String(store.records.size)} records`);

  // Until somebody enrolls again, the answer has to name the dead cookie rather
  // than send the operator off to enroll a host that is already enrolled.
  const held = await session.ensure();
  check('the refusal is still the diagnosis while nothing new is enrolled',
    held.state !== 'authenticated' && held.detail.includes('was refused'), held.detail);

  store.records.set('scope-test', { name: COOKIE_NAME, value: 'v2.fresh', expiresAt: 1_700_000_000_000 + 3_600_000 });
  const repaired = await session.ensure();
  check('a fresh enrollment recovers the refused session on the next readiness call',
    repaired.state === 'authenticated' && session.cookieHeader() === `${COOKIE_NAME}=v2.fresh`,
    `${repaired.state} / ${session.cookieHeader() ?? 'no cookie'}`);
}

{
  // The one block a re-read cannot lift, pinned so the rule above cannot be
  // generalized into a loop: a Host/Origin refusal is a statement about the
  // ADDRESS, and the address is fixed for the life of the session.
  const { session, requests } = harness(() => response(403, {}));
  session.adoptLaunchToken(TOKEN);
  const blocked = await session.ensure();
  check('a Host/Origin refusal blocks, and says retrying will not help',
    blocked.state === 'blocked' && blocked.reason === 'host-or-origin-refused'
      && blocked.detail.includes('cosyncing cannot fix that by retrying'), blocked.detail);
  const again = await session.ensure();
  check('the Host/Origin refusal does not re-request on every readiness call',
    again.state === 'blocked' && requests.length === 1, `${String(requests.length)} requests`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
