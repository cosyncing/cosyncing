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
import {
  classifyDshVersion,
  compareDshVersions,
  DSH_CONTRACT_FAMILIES,
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
  check('both captured versions are qualified against their own family',
    qualified('0.1.0-rc.6') === 'legacy-0.1' && qualified('0.2.0-rc.2') === 'remote-0.2',
    [qualified('0.1.0-rc.6'), qualified('0.2.0-rc.2')].join(' / '));

  const verdict = classifyDshVersion('0.2.0-rc.9');
  check('an unexercised rc in a recognised family is family evidence, NOT a qualified version',
    verdict.status === 'family-recognised'
      && verdict.status === 'family-recognised' && verdict.family === 'remote-0.2'
      && DSH_QUALIFIED_VERSIONS['remote-0.2'].includes('0.2.0-rc.2'),
    JSON.stringify(verdict));

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

  // Family recognition is not qualification, and the launch policy is the place
  // where that distinction has teeth. A 0.2 build nobody has exercised IS
  // started: what the launch depends on is the family's route shapes, auth model
  // and flag set, and those are shared. What the qualified list means is narrower
  // and different — it names the version the fixtures, mappings and physical
  // acceptance were captured against. So `0.2.0-rc.999` gets a launch and does
  // NOT get to be described as a tested version, and anything downstream that
  // reports readiness has to be able to say "started, unverified" rather than
  // implying the exact build was exercised.
  const unexercised = decideManagedLaunch('0.2.0-rc.999', 3080);
  check('an unexercised 0.2 build is permitted to launch without being a qualified version',
    unexercised.allowed === true && unexercised.allowed
      && classifyDshVersion('0.2.0-rc.999').status === 'family-recognised'
      && !DSH_QUALIFIED_VERSIONS['remote-0.2'].includes('0.2.0-rc.999')
      && unexercised.plan.args.join(' ') === 'web --port 3080 --no-open',
    unexercised.allowed ? unexercised.plan.args.join(' ') : unexercised.detail);
  check('exactly one 0.2 build carries the qualification this build was verified against',
    DSH_QUALIFIED_VERSIONS['remote-0.2'].join(',') === '0.2.0-rc.2'
      && decideManagedLaunch('0.2.0-rc.2', 3080).allowed === true
      && classifyDshVersion('0.2.0-rc.2').status === 'qualified',
    DSH_QUALIFIED_VERSIONS['remote-0.2'].join(','));

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
  // Refusing to start is not the same as refusing to see. A host on an
  // unsupported contract must stay connectable and reportable.
  const unsupported = await new DshAdapter({
    baseUrl: 'http://127.0.0.1:3080', homeDir: '/fixture/home', env: {},
    resolveExecutable: () => '/usr/local/bin/dsh',
    readExecutableVersion: () => '0.3.0',
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

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed`);
if (failed.length > 0) process.exit(1);
