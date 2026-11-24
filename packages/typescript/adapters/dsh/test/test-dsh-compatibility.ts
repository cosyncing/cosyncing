/**
 * Version classification, launch qualification, and the read-only contract
 * probe.
 *
 * The hazard this suite exists for is a wrong "yes". Accepting an unqualified
 * version means launching a binary whose wire nothing can read, which the
 * supervisor then reports as a host that failed to start; falling back to the
 * legacy contract after a 401 means sending unauthenticated requests to a host
 * that is merely waiting for a credential. Both are wrong in a way that costs
 * an operator an hour, and both are wrong in a way a boolean would have allowed.
 *
 * No dsh process, no port, no network. Every answer is an injected one.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-compatibility.ts
 */
export {};
import { isSessionCreateTemporarilyUnavailableError } from '@cosyncing/adapter-api';
import {
  classifyDshVersion,
  compareDshVersions,
  DSH_CONTRACT_FAMILIES,
  DSH_QUALIFIED_VERSION_LIST,
  DSH_QUALIFIED_VERSIONS,
  decideManagedLaunch,
  mayFallBackToLegacyAfterProbe,
  parseDshVersion,
  planDshLaunch,
  probeDshContract,
  DSH_LEGACY_MUX_PROBE_PATH,
  DSH_REMOTE_MUX_PROBE_PATH,
  type DshProbeFetch,
} from '../src/compatibility.ts';
import { DshAdapter } from '../src/implementation.ts';
import type { DshFetch } from '../src/envelope.ts';

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Version parsing ──────────────────────────────────────────────────────

{
  const parsed = parseDshVersion('0.2.0-rc.2');
  check('a release-candidate version parses into its parts',
    parsed !== null && parsed.major === 0 && parsed.minor === 2 && parsed.patch === 0
      && parsed.prerelease.join('.') === 'rc.2',
    JSON.stringify(parsed));

  check('the CLI version banner is read through its decoration',
    parseDshVersion('dsh/0.2.0-rc.2')?.raw === '0.2.0-rc.2'
      || parseDshVersion('  v0.2.0-rc.2 \n')?.raw === '0.2.0-rc.2',
    JSON.stringify([parseDshVersion('dsh/0.2.0-rc.2')?.raw, parseDshVersion('  v0.2.0-rc.2 \n')?.raw]));

  check('a version that cannot be read is reported as unreadable, not guessed',
    parseDshVersion('Distributed Shell 0.67') === null
      && parseDshVersion('') === null && parseDshVersion(undefined) === null,
  );

  const ordering = (a: string, b: string): number => {
    const left = parseDshVersion(a);
    const right = parseDshVersion(b);
    if (left === null || right === null) return Number.NaN;
    return compareDshVersions(left, right);
  };
  check('ordering places a plain release above its prerelease and rc numbers numerically',
    ordering('0.2.0', '0.2.0-rc.2') === 1
      && ordering('0.2.0-rc.10', '0.2.0-rc.9') === 1
      && ordering('0.1.0-rc.6', '0.2.0-rc.2') === -1
      && ordering('0.2.0-rc.2', '0.2.0-rc.2') === 0,
    [ordering('0.2.0', '0.2.0-rc.2'), ordering('0.2.0-rc.10', '0.2.0-rc.9')].join(','));
}

// ── 2. Contract classification ──────────────────────────────────────────────

{
  const qualified = (version: string): string => {
    const verdict = classifyDshVersion(version);
    return verdict.status === 'qualified' ? `${verdict.family}` : verdict.status;
  };
  check('every captured version is qualified against its own family',
    qualified('0.1.0-rc.6') === 'legacy-0.1' && qualified('0.2.0-rc.2') === 'remote-0.2'
      && qualified('0.2.2-rc.5') === 'remote-0.2',
    [qualified('0.1.0-rc.6'), qualified('0.2.0-rc.2'), qualified('0.2.2-rc.5')].join(' / '));

  // Published builds that share a qualified build's minor. Each used to be
  // admitted as "the same family"; 0.2.2 kept the 0.2 routes and auth and still
  // changed the live control frames and the image readback request, so a family
  // match is not evidence of anything. 0.1 gets the same rule as 0.2. 0.2.2-rc.4
  // is the build before the captured 0.2.2-rc.5: qualifying one rc is not a
  // licence for its neighbours.
  const unlisted = ['0.2.0-rc.1', '0.2.1-rc.5', '0.2.2-rc.4', '0.2.3-alpha.2', '0.1.0-rc.7', '0.1.7-rc.2'];
  const verdicts = unlisted.map((version) => [version, classifyDshVersion(version).status] as const);
  check('a published 0.1 or 0.2 build that is not on the qualified list is unsupported, not recognised as its family',
    verdicts.every(([, status]) => status === 'unsupported')
      && DSH_QUALIFIED_VERSIONS['remote-0.2'].includes('0.2.0-rc.2'),
    JSON.stringify(verdicts));

  // The floor rule, asserted as the absence of the bug rather than the presence
  // of a comparison: a number ABOVE everything captured gets no benefit of the
  // doubt, because "at or above" is exactly the inference that breaks when the
  // rc train moves the wire.
  const newer = classifyDshVersion('0.3.0');
  check('a version above the captured set is unsupported rather than floored in',
    newer.status === 'unsupported', JSON.stringify(newer));
  const older = classifyDshVersion('0.0.9');
  check('a version below the captured set is unsupported rather than floored in',
    older.status === 'unsupported', JSON.stringify(older));
  check('classification distinguishes all four outcomes and the family list is the two of them',
    DSH_CONTRACT_FAMILIES.join(',') === 'legacy-0.1,remote-0.2'
      && classifyDshVersion('nope').status === 'unavailable',
  );
}

// ── 3. Managed-launch qualification ─────────────────────────────────────────

{
  const current = decideManagedLaunch('0.2.0-rc.2', 17_831);
  check('the qualified current version launches with --no-open on the configured port',
    current.allowed === true
      && current.allowed && current.plan.browserSuppressed
      && current.plan.args.join(' ') === 'web --port 17831 --no-open',
    current.allowed ? current.plan.args.join(' ') : current.detail);

  // This is the whole reason the flag table exists: 0.1 has no --no-open, so
  // passing it produces "unknown option" and a host that never starts. The
  // adapter must decline the launch and say why instead of discovering it via a
  // readiness timeout.
  const legacy = decideManagedLaunch('0.1.0-rc.6', 3080);
  check('a version with no verified browser-suppression flag is refused before the spawn',
    legacy.allowed === false && legacy.code === 'no-browser-suppression'
      && !legacy.detail.includes('0.1.0-rc.6 --no-open'),
    legacy.allowed ? 'allowed' : `${legacy.code}: ${legacy.detail}`);

  // A 0.2 build nobody captured is NOT started. It used to be, on the grounds
  // that its route shapes, auth model and flags matched the family; 0.2.2 matched
  // all three and still lost live updates and image readback once running. The
  // refusal names the version and the qualified list, so the log line says what
  // to install rather than "host did not become ready".
  for (const version of ['0.2.1-rc.5', '0.2.2-rc.4', '0.2.3-alpha.2']) {
    const refused = decideManagedLaunch(version, 3080);
    check(`published but unqualified ${version} is refused before the spawn, with the qualified versions named`,
      refused.allowed === false && refused.code === 'version-unsupported'
        && refused.detail.includes(version) && refused.detail.includes(DSH_QUALIFIED_VERSION_LIST)
        && refused.detail.includes('@deepseek-ai/dsh@0.2.0-rc.2'),
      refused.allowed ? refused.plan.args.join(' ') : refused.detail);
  }
  // 0.1 builds were never launched (no verified --no-open); an unlisted one is
  // now refused for its version first, which is the more useful sentence.
  const laterLegacy = decideManagedLaunch('0.1.7-rc.2', 3080);
  check('an unlisted 0.1 build is refused for its version, not only for its missing browser flag',
    laterLegacy.allowed === false && laterLegacy.code === 'version-unsupported',
    laterLegacy.allowed ? 'allowed' : `${laterLegacy.code}: ${laterLegacy.detail}`);
  check('exactly the two captured 0.2 builds carry the qualification this build was verified against',
    DSH_QUALIFIED_VERSIONS['remote-0.2'].join(',') === '0.2.0-rc.2,0.2.2-rc.5'
      && decideManagedLaunch('0.2.0-rc.2', 3080).allowed === true
      && classifyDshVersion('0.2.0-rc.2').status === 'qualified',
    DSH_QUALIFIED_VERSIONS['remote-0.2'].join(','));
  // The 0.2.2-rc.5 capture started its host with `--profile web ... --no-open
  // --port`, which its CLI documents `dsh web` as abbreviating.
  const ported = decideManagedLaunch('0.2.2-rc.5', 17_831);
  check('the captured 0.2.2-rc.5 launches with --no-open on the configured port',
    ported.allowed === true && ported.plan.browserSuppressed
      && ported.plan.args.join(' ') === 'web --port 17831 --no-open',
    ported.allowed ? ported.plan.args.join(' ') : ported.detail);

  const unsupported = decideManagedLaunch('0.3.1', 3080);
  check('a known-unsupported version is refused rather than launched and timed out',
    unsupported.allowed === false && unsupported.code === 'version-unsupported',
    unsupported.allowed ? 'allowed' : unsupported.code);

  const missing = decideManagedLaunch(undefined, 3080);
  check('a missing version is refused as its own case, not as a crash',
    missing.allowed === false && missing.code === 'version-unavailable',
    missing.allowed ? 'allowed' : missing.code);

  const refusal = decideManagedLaunch('0.3.1', 3080);
  check('a refusal names the version but no path and no environment value',
    refusal.allowed === false && !/[A-Za-z]:[\\/]/.test(refusal.detail)
      && !refusal.detail.includes('/home/'),
    refusal.allowed ? 'allowed' : refusal.detail);
}

// ── 4. The read-only probe ──────────────────────────────────────────────────

{
  const statuses = new Map<string, number>();
  const calls: string[] = [];
  const fetchImpl: DshProbeFetch = async (url) => {
    calls.push(url);
    const status = statuses.get(url);
    if (status === undefined) throw new Error('unreachable');
    return { status };
  };

  const base = 'http://127.0.0.1:17831';
  check('the probe paths are built from the transports rather than spelled out here',
    DSH_REMOTE_MUX_PROBE_PATH === '/api/remote.mux' && DSH_LEGACY_MUX_PROBE_PATH === '/api/events.mux',
    `${DSH_REMOTE_MUX_PROBE_PATH} ${DSH_LEGACY_MUX_PROBE_PATH}`);

  statuses.clear(); calls.length = 0;
  statuses.set(`${base}/api/remote.mux`, 401);
  let probe = await probeDshContract(base, fetchImpl);
  check('an authentication refusal is read as a 0.2 host, not as an absent host',
    probe.family === 'remote-0.2' && probe.authenticated === false && probe.reason === 'auth-required',
    JSON.stringify(probe));
  check('the probe issues only GETs, and stops as soon as the family is settled',
    calls.length === 1 && (calls[0] ?? '').endsWith('/api/remote.mux'), calls.join(' '));
  check('a refusal never unlocks a legacy fallback',
    mayFallBackToLegacyAfterProbe(probe) === false);

  statuses.clear(); calls.length = 0;
  statuses.set(`${base}/api/remote.mux`, 403);
  probe = await probeDshContract(base, fetchImpl);
  check('a Host or Origin refusal is also a 0.2 host and also not a fallback',
    probe.family === 'remote-0.2' && probe.reason === 'host-or-origin-refused'
      && mayFallBackToLegacyAfterProbe(probe) === false,
    JSON.stringify(probe));

  statuses.clear(); calls.length = 0;
  statuses.set(`${base}/api/remote.mux`, 404);
  statuses.set(`${base}/api/events.mux`, 426);
  probe = await probeDshContract(base, fetchImpl);
  check('an absent Remote route plus an upgrade-only legacy route is the legacy family',
    probe.family === 'legacy-0.1' && probe.authenticated === true, JSON.stringify(probe));
  check('the legacy fingerprint is only taken after the Remote route is ruled out',
    calls.join(' ') === `${base}/api/remote.mux ${base}/api/events.mux`, calls.join(' '));

  statuses.clear(); calls.length = 0;
  statuses.set(`${base}/api/remote.mux`, 404);
  statuses.set(`${base}/api/events.mux`, 404);
  probe = await probeDshContract(base, fetchImpl);
  check('a server that answers neither contract is reported as no contract',
    probe.family === null && probe.reason === 'no-contract' && mayFallBackToLegacyAfterProbe(probe) === true,
    JSON.stringify(probe));

  statuses.clear(); calls.length = 0;
  probe = await probeDshContract(base, fetchImpl);
  check('an unreachable port is its own answer and never a version verdict',
    probe.family === null && probe.reason === 'no-listener', JSON.stringify(probe));

  statuses.clear(); calls.length = 0;
  statuses.set(`${base}/api/remote.mux`, 500);
  statuses.set(`${base}/api/events.mux`, 426);
  probe = await probeDshContract(base, fetchImpl);
  check('a server error on the Remote route does not hide a legacy fingerprint',
    probe.family === 'legacy-0.1', JSON.stringify(probe));

  let verbs = '';
  const verbProbe: DshProbeFetch = async (_url, init) => {
    verbs = init.method;
    return { status: 404 };
  };
  await probeDshContract(base, verbProbe);
  check('the probe never uses a verb that could change host state', verbs === 'GET', verbs);
}


// ── The real adapter's managed descriptor ───────────────────────────────────
//
// Everything above tests the launch rules in isolation, which is exactly how a
// green suite stayed attached to an adapter that ignored them. The finding was
// that `describeManagedHost` built its own argv and so never carried the
// no-browser guard: the rule existed, was tested, and was not applied. These
// checks go through the adapter the broker actually uses.

{
  const descriptor = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080',
    homeDir: '/fixture/home',
    env: {},
    resolveExecutable: (command) => (command === 'dsh' ? '/usr/local/bin/dsh' : undefined),
    readExecutableVersion: () => '0.2.0-rc.2',
  }).describeManagedHost();

  const args = descriptor?.launch?.args ?? [];
  check('the managed descriptor carries the verified no-browser flag',
    descriptor?.launch?.command === '/usr/local/bin/dsh'
      && JSON.stringify(args) === JSON.stringify(['web', '--port', '3080', '--no-open']),
    JSON.stringify(args));
  check('the descriptor advertises the port it tells the child to serve',
    descriptor?.serving?.port === 3080 && args.includes('3080'));
  check('the launch never names a host, so the bind stays dsh\'s own loopback default',
    !args.includes('--host'), JSON.stringify(args));
  check('the qualified launch still pins the workspace watcher and the profile home',
    descriptor?.launch?.env?.['CHOKIDAR_USEPOLLING'] === '1'
      && typeof descriptor?.launch?.env?.['DSH_HOME'] === 'string'
      && descriptor?.launch?.cwd === '/fixture/home',
    JSON.stringify(descriptor?.launch?.env));

  const asked: string[] = [];
  await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: (command) => { asked.push(command); return '0.2.0-rc.2'; },
  }).describeManagedHost();
  check('the qualification asks the resolved executable, not a name on PATH',
    JSON.stringify(asked) === JSON.stringify(['/usr/local/bin/dsh']), JSON.stringify(asked));
}

{
  // Refusing to start is not refusing to DESCRIBE. The broker still has to
  // locate, and if it owns one stop, a host at this address — one it started
  // before the install changed included — so the descriptor keeps its locator
  // and identity while the launch is withheld.
  const unsupported = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: () => '0.2.2-rc.4',
  }).describeManagedHost();
  check('an unqualified executable is not started, and the host is still described',
    unsupported?.launch === null && unsupported?.serving?.port === 3080
      && unsupported?.identityKey === 'http://127.0.0.1:3080',
    JSON.stringify(unsupported));

  const unreadable = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: () => undefined,
  }).describeManagedHost();
  check('an executable whose version cannot be read is not started unattended',
    unreadable?.launch === null, JSON.stringify(unreadable?.launch));

  const absent = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => undefined,
    readExecutableVersion: () => { throw new Error('must not probe an absent executable'); },
  }).describeManagedHost();
  check('no version probe is spent on a machine with no executable',
    absent?.launch === null, JSON.stringify(absent?.launch));

  const remote = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: () => '0.2.0-rc.2',
  }).describeManagedHost();
  const elsewhere = await new DshAdapter({
    baseUrl: 'http://dsh-host.example:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: () => '0.2.0-rc.2',
  }).describeManagedHost();
  check('a host on another machine is still watched but never started here',
    remote?.launch !== null && elsewhere?.launch === null
      && elsewhere?.locator.kind === 'unknown',
    JSON.stringify(elsewhere?.locator));
}

// ── Readiness, Create, Drive and Observe on the installed version ───────────
//
// The managed launch is one consumer of the version. A host the operator
// started — or one this broker started before an upgrade — reaches every other
// path through readiness, and the 0.2 routes and auth survived the upgrade that
// broke live updates, so a host that answers is exactly the case that would
// half-work. One scripted 0.2 host, answering the captured anonymous 401 and an
// authenticated roster; only the installed version differs between the runs.

{
  const BASE = 'http://127.0.0.1:17831';
  const credential = { name: 'dsh-auth-fixture', value: 'v1.fixture-only', expiresAt: Date.now() + 30 * 86_400_000 };
  const scripted = (version: string, baseUrl = BASE) => {
    const sent: string[] = [];
    const fetchImpl: DshFetch = async (url, init) => {
      const method = (init as { method: string }).method;
      sent.push(`${method} ${new URL(url).pathname}`);
      if (method === 'GET') return { status: 401, text: async () => 'unauthorized' };
      const request = JSON.parse(init.body) as { rpcId: string };
      return {
        status: 200,
        text: async () => JSON.stringify({
          type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
        }),
      };
    };
    const adapter = new DshAdapter({
      baseUrl, env: {}, homeDir: '/fixture/home', dshHome: '/fixture/home/.dsh',
      resolveExecutable: () => '/usr/local/bin/dsh',
      readExecutableVersion: () => version,
      credentialStore: { async load() { return credential; }, async save() {}, async clear() {} },
      fetchImpl,
    });
    return { adapter, sent };
  };
  const thrown = async (attempt: () => Promise<unknown>): Promise<unknown> => {
    try {
      await attempt();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const failure = async (attempt: () => Promise<unknown>): Promise<string> => {
    const error = await thrown(attempt);
    if (error === undefined) return '';
    return error instanceof Error ? error.message : String(error);
  };

  for (const version of ['0.2.0-rc.2', '0.2.2-rc.5']) {
    const qualified = scripted(version);
    const qualifiedAvailable = await qualified.adapter.isAvailable();
    check(`the qualified ${version} install reaches the host and is available`,
      qualifiedAvailable === true && qualified.sent.includes('POST /api/session/list')
        && await qualified.adapter.canCreateSession() === true,
      qualified.sent.join(' '));
    const qualifiedPrepared = await thrown(() => qualified.adapter.prepareCreateSession());
    check(`the qualified ${version} install passes Create\'s readiness boundary`,
      qualifiedPrepared === undefined, String(qualifiedPrepared));
  }

  for (const version of ['0.2.1-rc.5', '0.2.3-alpha.2']) {
    const { adapter, sent } = scripted(version);
    const available = await adapter.isAvailable();
    const sessions = await adapter.discoverSessions();
    const creatable = await adapter.canCreateSession();
    check(`${version}: readiness, discovery and Create are unavailable before anything is sent to the host`,
      available === false && sessions.length === 0 && creatable === false && sent.length === 0,
      JSON.stringify({ available, sessions: sessions.length, creatable, sent }));

    // The broker asks Create's readiness boundary FIRST and answers its typed
    // refusal with a 503 that carries the message and the detail code. Only if
    // it returns does the broker ask `canCreateSession`, whose `false` above it
    // can turn only into a generic "temporarily unavailable" with no reason.
    const prepared = await thrown(() => adapter.prepareCreateSession());
    check(`${version}: Create's readiness boundary, asked before canCreateSession, refuses as dsh-version-unsupported with the reason`,
      isSessionCreateTemporarilyUnavailableError(prepared)
        && prepared.detailCode === 'dsh-version-unsupported'
        && prepared.message.includes(version) && prepared.message.includes(DSH_QUALIFIED_VERSION_LIST)
        && prepared.message.includes('@deepseek-ai/dsh@0.2.0-rc.2')
        && sent.length === 0,
      JSON.stringify({ prepared: String(prepared), sent }));
    const created = await thrown(() => adapter.createSession());
    check(`${version}: a create that skips the boundary gets the same typed refusal`,
      isSessionCreateTemporarilyUnavailableError(created)
        && created.detailCode === 'dsh-version-unsupported'
        && created.message === (prepared instanceof Error ? prepared.message : '')
        && sent.length === 0,
      String(created));

    // The adapter's own refusals. The broker forwards the attach message to the
    // app; for rename and the model catalog it answers with its generic failure,
    // so there the reason is the adapter's and doctor's, not the app's.
    const refusals = {
      attach: await failure(() => adapter.attach('session-fixture-001', 'live')),
      create: await failure(() => adapter.createSession()),
      rename: await failure(() => adapter.renameSession('session-fixture-001', 'renamed')),
      models: await failure(() => adapter.listModels()),
    };
    check(`${version}: the adapter's Observe, Drive, Create, rename and model catalog calls refuse with a reason naming the qualified versions`,
      Object.values(refusals).every((message) => message.includes(version)
        && message.includes(DSH_QUALIFIED_VERSION_LIST) && message.includes('@deepseek-ai/dsh@0.2.0-rc.2'))
        && sent.length === 0,
      JSON.stringify({ refusals, sent }));

    // A host answering on the port is left running: the refusal is ours, and a
    // restart could only start the same build or nothing.
    const fault = await adapter.managedHostReadinessFault();
    check(`${version}: supervision is told the fault is the adapter's, with the same reason, so a running host is not restarted`,
      fault.kind === 'adapter' && fault.remedy === 'contract' && fault.detail.includes(version)
        && sent.every((request) => request.startsWith('GET ')),
      JSON.stringify({ fault, sent }));
    check(`${version}: and no managed launch is described for it`,
      (await adapter.describeManagedHost())?.launch === null);
  }

  // The installed binary describes this machine only. A host on another machine
  // is not refused on its evidence: the contract probe decides, as before.
  const elsewhere = scripted('0.2.2-rc.4', 'http://dsh-host.example:3080');
  await elsewhere.adapter.isAvailable();
  check('an unqualified local install does not refuse a host configured on another machine',
    elsewhere.sent.includes('GET /api/remote.mux'), elsewhere.sent.join(' '));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
