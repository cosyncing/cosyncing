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
  http?: SetupHttpProbe;
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
        return world.http ?? { status: 'unreachable' };
      },
      probeTcp: async () => world.tcp ?? 'closed',
      listDirectory: () => ({ ok: false, reason: 'missing' }),
      processAlive: () => false,
      displayPath: (path) => path,
    },
  };
}

function checkOf(
  diagnosis: { checks: Array<{ id: string; status: string; detailCode: string; remediation?: { command?: string } }> },
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
    'the fingerprint is taken from the mux route on the configured base URL',
    world.urls.length === 1 && world.urls[0] === 'http://127.0.0.1:3080/api/events.mux',
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
    'no host listening is a warn carrying the command that starts one',
    closedServer?.status === 'warn'
      && closedServer.detailCode === 'server-not-running'
      && closedServer.remediation?.command === 'dsh web',
    JSON.stringify(closedServer),
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
    http: { status: 'invalid-response', statusCode: DSH_UPGRADE_REQUIRED_STATUS },
  });
  await diagnoseDshSetup(configured.context);
  check(
    'the environment override moves the probe to the configured address',
    configured.urls[0] === 'http://127.0.0.1:4444/api/events.mux',
    configured.urls.join(' '),
  );

  // A credential in the configured URL is redacted at resolution: the probe,
  // the evidence, and every later log line see only the bare origin.
  const credentialed = context({
    executable: '/usr/local/bin/dsh',
    version: '0.1.0-rc.6',
    env: { COSYNCING_DSH_BASE_URL: 'http://user:secret@127.0.0.1:5555' },
    tcp: 'open',
    http: { status: 'invalid-response', statusCode: DSH_UPGRADE_REQUIRED_STATUS },
  });
  const credentialedDiagnosis = await diagnoseDshSetup(credentialed.context);
  check(
    'a credentialed base URL is probed and reported with the credential redacted',
    credentialed.urls[0] === 'http://127.0.0.1:5555/api/events.mux'
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
