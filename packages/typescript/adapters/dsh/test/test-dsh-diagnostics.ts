/**
 * The doctor boundary: what a READ-ONLY observer can honestly say about a dsh
 * install, and what it must refuse to claim.
 *
 * The interesting case is the port. Every dsh RPC is a POST, and the diagnosis
 * context is deliberately GET-only and effect-free, so "is a host there" cannot
 * be answered by calling `host.describe`. What CAN be answered read-only is the
 * downlink fingerprint: a plain GET on the mux route is answered `426 Upgrade
 * Required` by a real host, and by something else entirely by whatever else
 * happens to own that port. These tests pin that distinction, because "a server
 * is listening" and "a dsh host is listening" are different facts and reporting
 * the first as the second is how a doctor lies.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-diagnostics.ts   (exit 0 = all pass)
 */
export {};
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';
import { DSH_DEFAULT_BASE_URL } from '../src/server.ts';
import { dshCredentialScope, type DshCookie, type DshCredentialStore } from '../src/auth.ts';
import {
  diagnoseDshSetup,
  npxCacheRoot,
  resolveDshHome,
  DSH_MINIMUM_VERSION,
  DSH_UPGRADE_REQUIRED_STATUS,
} from '../src/diagnostics.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  muxPlainGetStatus: number;
};

/**
 * The 0.2 answers, read from the capture rather than typed in here, because the
 * whole point of these cases is that a 0.2 host's fingerprint is a REFUSAL on a
 * different route: an anonymous 401 on its carrier and a 404 where the 0.1
 * downlink used to be.
 */
const REMOTE_FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as {
  probe: {
    'probe.remoteMuxUnauthenticated': { status: number };
    'probe.legacyMux': { status: number };
  };
};
const REMOTE_ROUTES: Record<string, SetupHttpProbe> = {
  '/api/remote.mux': { status: 'http-error', statusCode: REMOTE_FIXTURE.probe['probe.remoteMuxUnauthenticated'].status },
  '/api/events.mux': { status: 'http-error', statusCode: REMOTE_FIXTURE.probe['probe.legacyMux'].status },
};
/** A 0.1 host has no Remote carrier route; only a 404 there lets the legacy fingerprint be read. */
const LEGACY_ROUTES: Record<string, SetupHttpProbe> = {
  '/api/remote.mux': { status: 'http-error', statusCode: 404 },
};

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

interface FakeWorld {
  env?: Record<string, string | undefined>;
  executable?: string;
  version?: string;
  paths?: Record<string, SetupPathInspection['status']>;
  tcp?: 'open' | 'closed' | 'unknown';
  /** Answer for any path not listed in `routes`. */
  http?: SetupHttpProbe;
  /** Answer per path, for the hosts whose two probe routes answer differently. */
  routes?: Record<string, SetupHttpProbe>;
  /** What the broker's credential store answers for THIS endpoint's scope. */
  credential?: DshCookie | null | 'throws' | 'no-store';
  /** The DSH_HOME the credential scope is derived from, when a credential is seeded. */
  dshHome?: string;
}

const HOME = '/fixture/home';

function context(world: FakeWorld): { context: SetupDiagnosisContext; urls: string[] } {
  const urls: string[] = [];
  const paths = world.paths ?? {};
  return {
    urls,
    context: {
      effects: 'forbidden',
      platform: 'linux',
      arch: 'x64',
      env: world.env ?? {},
      homeDir: HOME,
      resolveExecutable: (command) => (command === 'dsh' ? world.executable : undefined),
      inspectPath: (path): SetupPathInspection => {
        const status = paths[path] ?? 'missing';
        return { status, readable: status !== 'unreadable', displayPath: path };
      },
      readText: () => ({ ok: false, reason: 'missing' }),
      readPackageVersion: () => world.version,
      runReadOnly: async (): Promise<SetupCommandProbe> => ({ status: 'unavailable', stdout: '', stderr: '' }),
      fetchJson: async (url): Promise<SetupHttpProbe> => {
        urls.push(url);
        return world.routes?.[new URL(url).pathname] ?? world.http ?? { status: 'unreachable' };
      },
      probeTcp: async () => world.tcp ?? 'closed',
      listDirectory: () => ({ ok: false, reason: 'missing' }),
      processAlive: () => false,
      displayPath: (path) => path,
    },
  };
}

function checkOf(
  diagnosis: {
    checks: Array<{
      id: string; status: string; detailCode: string;
      remediation?: { command?: string; message?: string };
      evidence?: Record<string, unknown>;
    }>;
  },
  id: string,
) {
  return diagnosis.checks.find((entry) => entry.id === id);
}

// ── 1. Config root ──────────────────────────────────────────────────────────

{
  check(
    'DSH_HOME overrides the default config root',
    resolveDshHome({ DSH_HOME: '/custom/dsh' }, HOME) === '/custom/dsh'
      && resolveDshHome({}, HOME) === `${HOME}/.dsh`,
  );
  check('the npx cache root is derived from the home directory', npxCacheRoot(HOME) === `${HOME}/.npm/_npx`);
}

// ── 2. Nothing installed ────────────────────────────────────────────────────

{
  const world = context({});
  const diagnosis = await diagnoseDshSetup(world.context);
  check(
    'with nothing installed the report is a warn and skips, never a false failure',
    diagnosis.agent === 'dsh'
      && checkOf(diagnosis, 'dsh.binary')?.status === 'warn'
      && checkOf(diagnosis, 'dsh.version')?.status === 'skip'
      && checkOf(diagnosis, 'dsh.home')?.status === 'skip'
      && checkOf(diagnosis, 'dsh.server')?.status === 'skip',
    diagnosis.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '),
  );
  check(
    'the supported floor is the exact version the fixtures were captured from',
    diagnosis.minimumVersion === DSH_MINIMUM_VERSION && DSH_MINIMUM_VERSION.version === '0.1.0-rc.6',
  );
  check('no host means no HTTP probe is attempted at all', world.urls.length === 0);
}

// ── 3. Ephemeral npx install ────────────────────────────────────────────────

{
  const diagnosis = await diagnoseDshSetup(context({
    paths: { [npxCacheRoot(HOME)]: 'directory' },
  }).context);
  const advisory = checkOf(diagnosis, 'dsh.npx-cache');
  check(
    'an npx cache with no binary on PATH is reported as an advisory, not as an install',
    advisory?.status === 'warn' && advisory.detailCode === 'binary-npx-only'
      && checkOf(diagnosis, 'dsh.version')?.status === 'skip',
    JSON.stringify(advisory),
  );

  const installed = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    paths: { [npxCacheRoot(HOME)]: 'directory' },
  }).context);
  check(
    'a real install on PATH suppresses the npx advisory and passes the floor',
    checkOf(installed, 'dsh.npx-cache') === undefined
      && checkOf(installed, 'dsh.binary')?.status === 'pass'
      && checkOf(installed, 'dsh.version')?.status === 'pass',
    installed.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '),
  );

  const old = await diagnoseDshSetup(context({ executable: '/usr/local/bin/dsh', version: '0.0.9' }).context);
  check(
    'a build below the tested floor fails the version check',
    checkOf(old, 'dsh.version')?.detailCode === 'version-below-minimum',
    JSON.stringify(checkOf(old, 'dsh.version')),
  );
}

// ── 4. Config root states ───────────────────────────────────────────────────

{
  const present = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { DSH_HOME: '/custom/dsh' },
    paths: { '/custom/dsh': 'directory' },
  }).context);
  check(
    'a readable config root at the overridden location passes',
    checkOf(present, 'dsh.home')?.status === 'pass',
    JSON.stringify(checkOf(present, 'dsh.home')),
  );

  const missing = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
  }).context);
  check(
    'an installed binary with no config root yet is a warn, not a failure',
    checkOf(missing, 'dsh.home')?.status === 'warn'
      && checkOf(missing, 'dsh.home')?.detailCode === 'home-missing',
  );

  const broken = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    paths: { [`${HOME}/.dsh`]: 'file' },
  }).context);
  check(
    'a config root of the wrong type fails',
    checkOf(broken, 'dsh.home')?.detailCode === 'home-unsafe-type',
  );
}

// ── 5. The port: listening vs. actually dsh ─────────────────────────────────

{
  check('the captured fingerprint is the upgrade-required status', FIXTURE.muxPlainGetStatus === DSH_UPGRADE_REQUIRED_STATUS);

  const world = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    paths: { [`${HOME}/.dsh`]: 'directory' },
    tcp: 'open',
    // A real host answers the upgrade-only route with 426 and a non-JSON body,
    // which the probe reports as invalid-response WITH the status.
    routes: LEGACY_ROUTES,
    http: { status: 'invalid-response', statusCode: FIXTURE.muxPlainGetStatus },
  });
  const diagnosis = await diagnoseDshSetup(world.context);
  check(
    'a listening host answering the downlink contract passes both checks',
    checkOf(diagnosis, 'dsh.server')?.status === 'pass'
      && checkOf(diagnosis, 'dsh.contract')?.status === 'pass'
      && checkOf(diagnosis, 'dsh.contract')?.detailCode === 'downlink-upgrade-required',
    JSON.stringify(checkOf(diagnosis, 'dsh.contract')),
  );
  check(
    'the carrier route is asked first, and the legacy route only behind a 404 there',
    world.urls.length === 2
      && world.urls[0] === 'http://127.0.0.1:3080/api/remote.mux'
      && world.urls[1] === 'http://127.0.0.1:3080/api/events.mux',
    world.urls.join(' '),
  );

  const foreign = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    paths: { [`${HOME}/.dsh`]: 'directory' },
    tcp: 'open',
    http: { status: 'http-error', statusCode: 404 },
  }).context);
  check(
    'a server that is listening but is NOT dsh fails the contract check while the port check still passes',
    checkOf(foreign, 'dsh.server')?.status === 'pass'
      && checkOf(foreign, 'dsh.contract')?.status === 'fail'
      && checkOf(foreign, 'dsh.contract')?.detailCode === 'downlink-unexpected-status',
    JSON.stringify(checkOf(foreign, 'dsh.contract')),
  );

  const silent = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    tcp: 'open',
    http: { status: 'unreachable' },
  }).context);
  check(
    'a port that accepts a connection but answers nothing fails the contract check',
    checkOf(silent, 'dsh.contract')?.detailCode === 'downlink-unreachable',
  );

  const closed = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    tcp: 'closed',
  }).context);
  const closedServer = checkOf(closed, 'dsh.server');
  check(
    'no host listening is a warn carrying the command that starts one, where nothing manages it',
    closedServer?.status === 'warn'
      && closedServer.detailCode === 'server-not-running'
      && closedServer.remediation?.command === 'dsh web',
    JSON.stringify(closedServer),
  );

  // THE MANAGED POSTURE. Same closed port, opposite instruction.
  //
  // The installed service starts and supervises this host by default, so a
  // `dsh web` command races its recovery and leaves two hosts on one address.
  const managedClosed = await diagnoseDshSetup({
    ...context({ executable: '/usr/local/bin/dsh', version: '0.1.0-rc.6', tcp: 'closed' }).context,
    managedExternalHostIdentities: [DSH_DEFAULT_BASE_URL],
  });
  const managedClosedServer = checkOf(managedClosed, 'dsh.server');
  check(
    'the managed posture reports the same absent host, with no command at all',
    managedClosedServer?.status === closedServer?.status
      && managedClosedServer?.detailCode === closedServer?.detailCode
      && managedClosedServer?.remediation?.command === undefined,
    JSON.stringify(managedClosedServer),
  );
  check(
    '...and never names dsh web, claiming only that cosyncing is CONFIGURED to manage the host',
    !/dsh web/.test(managedClosedServer?.remediation?.message ?? '')
      && /configured to manage/.test(managedClosedServer?.remediation?.message ?? ''),
    managedClosedServer?.remediation?.message,
  );
  // AN ADDRESS THIS MACHINE DOES NOT SERVE, on a machine where the service IS
  // installed and manages the default one.
  //
  // Two things must both be true here, and a managed/unmanaged flag can only
  // deliver one of them. The remote host is NOT claimed as managed — cosyncing
  // will never start it. And it still gets no `dsh web`, because that command
  // takes no address: it would start a host at the DEFAULT address, which is
  // neither the host being diagnosed nor a free address — it is the one the
  // service manages, so the suggestion collides with the managed host while
  // doing nothing for the operator's actual problem.
  //
  // A reserved `.example` name, not an RFC1918 literal: this tree ships publicly,
  // where a private address reads as leaked topology whether or not it is one.
  const REMOTE_HOST = 'http://dsh-host.example:3080';
  const managedRemote = await diagnoseDshSetup({
    ...context({
      executable: '/usr/local/bin/dsh',
      version: '0.1.0-rc.6',
      tcp: 'closed',
      env: { COSYNCING_DSH_BASE_URL: REMOTE_HOST },
    }).context,
    managedExternalHostIdentities: [DSH_DEFAULT_BASE_URL],
  });
  const managedRemoteServer = checkOf(managedRemote, 'dsh.server');
  check(
    'a host at another address is never claimed as managed, whatever the service manages',
    !/configured to manage/.test(managedRemoteServer?.remediation?.message ?? ''),
    JSON.stringify(managedRemoteServer?.remediation),
  );
  check(
    '...and is never handed a local dsh web, which would start a DIFFERENT host',
    managedRemoteServer?.remediation?.command === undefined
      && !/dsh web/.test(managedRemoteServer?.remediation?.message ?? ''),
    JSON.stringify(managedRemoteServer?.remediation),
  );
  check(
    '...but still says what to do, naming the address the operator must start',
    managedRemoteServer?.remediation?.message?.includes(REMOTE_HOST) === true,
    managedRemoteServer?.remediation?.message,
  );
  // The same address with NOTHING installed: still no local command, for the
  // same reason. This is not a managed-posture rule, it is an address rule.
  const unmanagedRemote = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    tcp: 'closed',
    env: { COSYNCING_DSH_BASE_URL: REMOTE_HOST },
  }).context);
  check(
    'an unmanaged remote host is refused the local command too',
    checkOf(unmanagedRemote, 'dsh.server')?.remediation?.command === undefined,
    JSON.stringify(checkOf(unmanagedRemote, 'dsh.server')?.remediation),
  );
  // ...while the local default with nothing managing it keeps it, which is what
  // makes the three postures distinct rather than one blanket refusal.
  check(
    'the local default address with nothing managing it still gets dsh web',
    closedServer?.remediation?.command === 'dsh web',
    JSON.stringify(closedServer?.remediation),
  );
  // A sweep over the whole managed diagnosis: nothing anywhere in it may offer
  // the host command, not just the check this test happens to look at.
  const managedMessages = [...managedClosed.checks, ...managedRemote.checks, ...unmanagedRemote.checks]
    .map((entry) => `${entry.remediation?.message ?? ''} ${entry.remediation?.command ?? ''}`);
  check(
    'no remediation in a managed or non-default diagnosis mentions dsh web at all',
    managedMessages.every((message) => !/dsh web/.test(message)),
    managedMessages.filter((message) => /dsh web/.test(message)).join(' | ') || 'none',
  );
  check(
    'a closed port never produces a contract verdict',
    checkOf(closed, 'dsh.contract') === undefined,
  );

  const badUrl = await diagnoseDshSetup(
    context({ executable: '/usr/local/bin/dsh', version: '0.1.0-rc.6' }).context,
    { baseUrl: 'not a url' },
  );
  check(
    'an unusable base URL is named as such instead of being probed',
    checkOf(badUrl, 'dsh.server')?.detailCode === 'base-url-invalid',
    JSON.stringify(checkOf(badUrl, 'dsh.server')),
  );

  // A non-http scheme PARSES, so only a protocol gate keeps it from being probed
  // as a TCP address on port 80 and reported as a host that is simply not running.
  const wrongScheme = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { COSYNCING_DSH_BASE_URL: 'ftp://127.0.0.1:3080' },
    tcp: 'open',
  });
  const schemeDiagnosis = await diagnoseDshSetup(wrongScheme.context);
  check(
    'a base URL that parses but is not http(s) is refused rather than probed',
    checkOf(schemeDiagnosis, 'dsh.server')?.status === 'fail'
      && checkOf(schemeDiagnosis, 'dsh.server')?.detailCode === 'base-url-invalid'
      && wrongScheme.urls.length === 0,
    JSON.stringify(checkOf(schemeDiagnosis, 'dsh.server')),
  );

  const configured = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:4444' },
    tcp: 'open',
    routes: LEGACY_ROUTES,
    http: { status: 'invalid-response', statusCode: DSH_UPGRADE_REQUIRED_STATUS },
  });
  await diagnoseDshSetup(configured.context);
  check(
    'the environment override moves the probe to the configured address',
    configured.urls.length > 1
      && configured.urls.every((url) => url.startsWith('http://127.0.0.1:4444/'))
      && configured.urls[1] === 'http://127.0.0.1:4444/api/events.mux',
    configured.urls.join(' '),
  );

  // A credential in the configured URL is redacted at resolution: the probe,
  // the evidence, and every later log line see only the bare origin.
  const credentialed = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { COSYNCING_DSH_BASE_URL: 'http://user:secret@127.0.0.1:5555' },
    tcp: 'open',
    routes: LEGACY_ROUTES,
    http: { status: 'invalid-response', statusCode: DSH_UPGRADE_REQUIRED_STATUS },
  });
  const credentialedDiagnosis = await diagnoseDshSetup(credentialed.context);
  check(
    'a credentialed base URL is probed and reported with the credential redacted',
    credentialed.urls[0] === 'http://127.0.0.1:5555/api/remote.mux'
      && !JSON.stringify(credentialedDiagnosis.checks).includes('secret'),
    credentialed.urls.join(' '),
  );

  const withQuery = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:3080/?token=abc123' },
    tcp: 'open',
  });
  const queryDiagnosis = await diagnoseDshSetup(withQuery.context);
  check(
    'a base URL carrying a query string is refused, never probed, and the refusal quotes no secret',
    checkOf(queryDiagnosis, 'dsh.server')?.detailCode === 'base-url-invalid'
      && withQuery.urls.length === 0
      && !JSON.stringify(queryDiagnosis.checks).includes('abc123'),
    JSON.stringify(checkOf(queryDiagnosis, 'dsh.server')),
  );
}

// ── 5b. The 0.2 host: its fingerprint is a refusal, and the remedy is enrollment ─
//
// A 0.2 host authenticates every route before it dispatches, so the answer that
// PROVES it is a DeepSeek Harness host is the one the 0.1-era fingerprint called
// a failure. Doctor has to read that refusal as a contract match and then answer
// the only question left, which is what cosyncing itself holds — a local fact,
// from the local store, never a second guess from the same anonymous GET.

function storeAnswering(answer: DshCookie | null | 'throws'): DshCredentialStore {
  return {
    async load() {
      if (answer === 'throws') throw new Error('the session store refuses an unsafe file');
      return answer;
    },
    async save() { throw new Error('diagnosis must not write to the credential store'); },
    async clear() { throw new Error('diagnosis must not write to the credential store'); },
  };
}

const REMOTE_COOKIE: DshCookie = {
  name: 'dsh-auth-fixture',
  value: 'v1.a-credential-that-must-never-be-printed',
  expiresAt: 1_800_000_000_000,
};
const REMOTE_HOME = `${HOME}/.dsh`;
/** The scope is derived, never typed: it is what makes doctor and adapter read one file. */
const REMOTE_SCOPE = dshCredentialScope(DSH_DEFAULT_BASE_URL, REMOTE_HOME);

function remoteWorld(overrides: Record<string, unknown> = {}): FakeWorld {
  return {
    executable: '/usr/local/bin/dsh',
    version: '0.2.0-rc.2',
    paths: { [REMOTE_HOME]: 'directory' },
    tcp: 'open',
    routes: REMOTE_ROUTES,
    ...overrides,
  } as FakeWorld;
}

{
  const noCookie = await diagnoseDshSetup(
    context(remoteWorld()).context,
    { credentialStore: storeAnswering(null), dshHome: REMOTE_HOME },
  );
  const contract = checkOf(noCookie, 'dsh.contract');
  const enrollment = checkOf(noCookie, 'dsh.enrollment');
  check(
    'a 0.2 host behind its auth fence is recognized, not reported as an unexpected server',
    contract?.status === 'pass' && contract.detailCode === 'remote-carrier-requires-credential',
    JSON.stringify(contract),
  );
  check(
    '...and the missing enrollment is its own actionable failure',
    enrollment?.status === 'fail'
      && enrollment.detailCode === 'enrollment-required'
      && enrollment.remediation?.command === 'cosy dsh connect',
    JSON.stringify(enrollment),
  );

  const held = await diagnoseDshSetup(
    context(remoteWorld({ credential: REMOTE_COOKIE })).context,
    { credentialStore: storeAnswering(REMOTE_COOKIE), dshHome: REMOTE_HOME },
  );
  const heldEnrollment = checkOf(held, 'dsh.enrollment');
  check(
    'a held, unexpired credential passes as HELD, which is the most a local fact can claim',
    heldEnrollment?.status === 'pass'
      && heldEnrollment.detailCode === 'credential-held'
      && heldEnrollment.evidence?.expiresAt === REMOTE_COOKIE.expiresAt,
    JSON.stringify(heldEnrollment),
  );
  check(
    '...and neither the cookie value nor its name reaches the report',
    !JSON.stringify(held.checks).includes(REMOTE_COOKIE.value)
      && !JSON.stringify(held.checks).includes(REMOTE_COOKIE.name),
    JSON.stringify(heldEnrollment),
  );

  const expired = await diagnoseDshSetup(
    context(remoteWorld()).context,
    {
      credentialStore: storeAnswering({ ...REMOTE_COOKIE, expiresAt: 1_000 }),
      dshHome: REMOTE_HOME,
      now: () => 2_000,
    },
  );
  check(
    'a credential past the expiry the host gave it is a named failure with the same remedy',
    checkOf(expired, 'dsh.enrollment')?.detailCode === 'credential-expired'
      && checkOf(expired, 'dsh.enrollment')?.remediation?.command === 'cosy dsh connect',
    JSON.stringify(checkOf(expired, 'dsh.enrollment')),
  );

  const unusable = await diagnoseDshSetup(
    context(remoteWorld()).context,
    { credentialStore: storeAnswering('throws'), dshHome: REMOTE_HOME },
  );
  const unusableEnrollment = checkOf(unusable, 'dsh.enrollment');
  check(
    'a store that will not answer is a storage failure, never an invitation to re-enroll',
    unusableEnrollment?.status === 'fail'
      && unusableEnrollment.detailCode === 'credential-store-unusable'
      && unusableEnrollment.remediation?.command === undefined
      && !/dsh connect/.test(unusableEnrollment.remediation?.message ?? ''),
    JSON.stringify(unusableEnrollment),
  );

  const managed = await diagnoseDshSetup(
    { ...context(remoteWorld()).context, managedExternalHostIdentities: [DSH_DEFAULT_BASE_URL] },
    { credentialStore: storeAnswering(null), dshHome: REMOTE_HOME },
  );
  const managedEnrollment = checkOf(managed, 'dsh.enrollment');
  check(
    'a managed host with no credential is never told to enroll by hand, because that needs a second host',
    managedEnrollment?.status === 'fail'
      && managedEnrollment.detailCode === 'enrollment-required-by-managed-host'
      && managedEnrollment.remediation?.command === undefined
      && /second host/.test(managedEnrollment.remediation?.message ?? ''),
    JSON.stringify(managedEnrollment),
  );

  const refused = await diagnoseDshSetup(
    context(remoteWorld({
      routes: {
        ...REMOTE_ROUTES,
        '/api/remote.mux': { status: 'http-error', statusCode: 403 },
      },
    })).context,
    { credentialStore: storeAnswering(null), dshHome: REMOTE_HOME },
  );
  check(
    'a host that refuses the request address is a fence problem, and no enrollment question is asked',
    checkOf(refused, 'dsh.contract')?.detailCode === 'remote-carrier-refused'
      && checkOf(refused, 'dsh.enrollment') === undefined,
    JSON.stringify(refused.checks.map((entry) => `${entry.id}=${entry.detailCode ?? ''}`)),
  );

  const scopeIsEndpointScoped = dshCredentialScope('http://127.0.0.1:3080', REMOTE_HOME) === REMOTE_SCOPE
    && dshCredentialScope('http://127.0.0.1:3081', REMOTE_HOME) !== REMOTE_SCOPE
    && dshCredentialScope(DSH_DEFAULT_BASE_URL, `${REMOTE_HOME}-other`) !== REMOTE_SCOPE;
  check(
    'the scope doctor reads is the scope the adapter writes: same address and profile, same file',
    scopeIsEndpointScoped,
    REMOTE_SCOPE,
  );
}

{
  // A 0.1 host has nothing to enroll, and asking implies a contract it does not
  // have. The legacy fingerprint stays exactly as it was.
  const legacy = await diagnoseDshSetup(context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    paths: { [REMOTE_HOME]: 'directory' },
    tcp: 'open',
    routes: LEGACY_ROUTES,
    http: { status: 'invalid-response', statusCode: FIXTURE.muxPlainGetStatus },
  }).context, { credentialStore: storeAnswering(null), dshHome: REMOTE_HOME });
  check(
    'a 0.1 host is never asked about an enrollment it cannot have',
    checkOf(legacy, 'dsh.contract')?.detailCode === 'downlink-upgrade-required'
      && checkOf(legacy, 'dsh.enrollment') === undefined,
    JSON.stringify(legacy.checks.map((entry) => entry.id)),
  );
}

// ── 6. Diagnosis stays effect-free ──────────────────────────────────────────

{
  const source = await Bun.file(new URL('../src/diagnostics.ts', import.meta.url)).text();
  check(
    'diagnosis opens no socket and issues no RPC of its own',
    !/DshRpcClient|DshDownlinks|new WebSocket|fetchImpl/.test(source),
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
