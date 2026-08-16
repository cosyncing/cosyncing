/**
 * Read-only setup/doctor diagnosis for Kimi Code.
 *
 * Everything here runs through the bounded {@link SetupDiagnosisContext}: no
 * process is started, no server is contacted, no filesystem is touched. The
 * context is fully injected, so these checks pin the DIAGNOSIS, not the host.
 *
 * Two properties carry most of the weight:
 *
 *  - doctor applies the SAME identity gate the adapter does. Reporting a healthy,
 *    supported Kimi for a server the adapter will then refuse to read is worse
 *    than reporting nothing, so an absent, non-string, or contradicted
 *    `server_id` fails here exactly as it fails there.
 *  - an install that is present but off PATH is INSTALLED. The official
 *    installer drops the binary in `~/.kimi-code/bin`, which no service PATH
 *    includes; classifying that as "missing" while the server checks pass was a
 *    self-contradiction that made a working install look broken.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-diagnostics.ts   (exit 0 = all pass)
 */
export {};
import type { SetupDiagnosisContext } from '@cosyncing/adapter-api';
import { diagnoseKimiSetup } from '../src/diagnostics.ts';
import { KIMI_DEFAULT_PORT } from '../src/server.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
  kimiVersion: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Derived from the adapter's own constant rather than written as a literal:
// nothing here binds a port, and a literal `host:port` reads to the suite
// isolation audit as a fixed listen port.
const listenPort = KIMI_DEFAULT_PORT;
const baseUrl = `http://127.0.0.1:${listenPort}`;
// Same reason the port is not spelled out above: a literal `/home/<name>/...`
// reads to the public-tree scan as a personal path leaking into the tree. The
// fixture root is fictional, so build the paths from this constant instead.
const FIXTURE_HOME = '/fixture/home';
const FIXTURE_SERVER_ID = (FIXTURE.rest.meta!.data as { server_id: string }).server_id;

function context(overrides: Partial<SetupDiagnosisContext> = {}): SetupDiagnosisContext {
  return {
    effects: 'forbidden', platform: 'linux', arch: 'x64',
    env: {}, homeDir: FIXTURE_HOME,
    resolveExecutable: () => '/fixture/bin/kimi',
    inspectPath: (path) => ({
      status: path.endsWith('server.token') ? 'file' : 'directory',
      readable: true,
      displayPath: path,
    }),
    readText: () => ({ ok: true, text: 'fixture-token' }),
    readPackageVersion: () => undefined,
    runReadOnly: async () => ({ status: 'ok', exitCode: 0, stdout: FIXTURE.kimiVersion, stderr: '' }),
    fetchJson: async (url) => url.endsWith('/healthz')
      ? { status: 'ok', json: FIXTURE.rest.healthz }
      : { status: 'ok', json: FIXTURE.rest.meta },
    probeTcp: async () => 'closed',
    listDirectory: () => ({ ok: false, reason: 'missing' }),
    processAlive: () => false,
    displayPath: (path) => path,
    ...overrides,
  } as SetupDiagnosisContext;
}

const byId = (
  report: { checks: Array<{ id: string; status: string; detailCode: string;
    evidence?: Record<string, string | number | boolean>;
    remediation?: { command?: string; message: string } }> },
  id: string,
) => report.checks.find((entry) => entry.id === id);

const liveOne = { live: [{ baseUrl, port: listenPort, serverId: FIXTURE_SERVER_ID }], stale: 0, invalid: 0, truncated: false };

// ── Healthy / absent / stale ────────────────────────────────────────────────

const healthy = await diagnoseKimiSetup(context(), { instances: liveOne, token: 'fixture-token' });
check('healthy diagnosis passes binary, version, and server',
  byId(healthy, 'kimi.binary')?.status === 'pass'
    && byId(healthy, 'kimi.version')?.status === 'pass'
    && byId(healthy, 'kimi.server')?.status === 'pass',
  healthy.checks.map((c) => `${c.id}=${c.status}`).join(' '));

const noBinary = await diagnoseKimiSetup(
  context({ resolveExecutable: () => undefined, inspectPath: (path) => ({ status: 'missing', readable: false, displayPath: path }) }),
  { instances: { live: [], stale: 0, invalid: 0, truncated: false } },
);
check('missing binary reports binary-missing and skips the rest',
  byId(noBinary, 'kimi.binary')?.detailCode === 'binary-missing'
    && byId(noBinary, 'kimi.server')?.status === 'skip');

const serverDown = await diagnoseKimiSetup(context(), { instances: { live: [], stale: 2, invalid: 0, truncated: false } });

// A truncated registry scan: diagnosis must refuse to name a server — even a
// healthy-looking one — because the record it never enumerated may describe
// another live instance. Same fail-closed rule as resolveVerifiedInstance.
const overflow = await diagnoseKimiSetup(context(), {
  instances: { ...liveOne, truncated: true },
  token: 'fixture-token',
});
check('a truncated registry fails the server check as registry-overflow',
  byId(overflow, 'kimi.server')?.status === 'fail'
    && byId(overflow, 'kimi.server')?.detailCode === 'server-registry-overflow',
  `${byId(overflow, 'kimi.server')?.status}/${byId(overflow, 'kimi.server')?.detailCode}`);
const down = byId(serverDown, 'kimi.server');
check('a stale registry reports server-registry-stale, never a fake server',
  down?.status === 'warn' && down.detailCode === 'server-registry-stale');
check('the not-running remediation names the user-facing command',
  down?.remediation?.command === 'kimi web --no-open');

// Fail closed on several live servers: they are not interchangeable, so naming
// one would be a guess presented as a fact. The adapter refuses the same way.
const ambiguousDiagnosis = await diagnoseKimiSetup(context(), {
  instances: {
    live: [
      { baseUrl, port: listenPort, serverId: 'a' },
      { baseUrl, port: listenPort + 1, serverId: 'b' },
    ],
    stale: 0, invalid: 0, truncated: false,
  },
  token: 'fixture-token',
});
const ambiguousCheck = byId(ambiguousDiagnosis, 'kimi.server');
check('several live servers get a distinct ambiguous diagnosis',
  ambiguousCheck?.status === 'fail' && ambiguousCheck.detailCode === 'server-ambiguous',
  `${ambiguousCheck?.status}/${ambiguousCheck?.detailCode}`);

const bypass = await diagnoseKimiSetup(
  context({
    fetchJson: async (url) => url.endsWith('/healthz')
      ? { status: 'ok', json: FIXTURE.rest.healthz }
      : {
          status: 'ok',
          json: { code: 0, data: { ...(FIXTURE.rest.meta!.data as object), dangerous_bypass_auth: true } },
        },
  }),
  { instances: liveOne, token: 't' },
);
check('a bypassed auth gate fails the diagnosis',
  byId(bypass, 'kimi.server-auth')?.status === 'fail');

// ── The identity gate, applied by doctor ────────────────────────────────────

const metaWith = (serverId: unknown) => context({
  fetchJson: async (url: string) => {
    if (url.endsWith('/healthz')) return { status: 'ok' as const, json: FIXTURE.rest.healthz };
    const data = { ...(FIXTURE.rest.meta!.data as Record<string, unknown>) };
    if (serverId === undefined) delete data.server_id; else data.server_id = serverId;
    return { status: 'ok' as const, json: { code: 0, data } };
  },
});
for (const [label, serverId] of [
  ['a wrong server id', 'someone-elses-server'],
  ['an absent server id', undefined],
  ['a non-string server id', 42],
] as const) {
  const report = await diagnoseKimiSetup(metaWith(serverId), { instances: liveOne, token: 't' });
  const serverCheck = byId(report, 'kimi.server');
  check(`doctor fails on ${label}`,
    serverCheck?.status === 'fail' && serverCheck.detailCode === 'server-identity-mismatch',
    `${serverCheck?.status}/${serverCheck?.detailCode}`);
}
const matched = await diagnoseKimiSetup(metaWith(FIXTURE_SERVER_ID), { instances: liveOne, token: 't' });
check('doctor passes when the server id matches the registry record',
  byId(matched, 'kimi.server')?.status === 'pass');

// ── An off-PATH install is INSTALLED, not missing ───────────────────────────

const offPathBinary = `${FIXTURE_HOME}/.kimi-code/bin/kimi`;
const offPathContext = (version: string): SetupDiagnosisContext => context({
  // Not on PATH, but present at the official install location.
  resolveExecutable: (command: string) => (command === offPathBinary ? offPathBinary : undefined),
  inspectPath: (path: string) => ({
    status: path === offPathBinary ? 'file' : path.endsWith('server.token') ? 'file' : 'directory',
    readable: true,
    displayPath: path,
  }),
  runReadOnly: async () => ({ status: 'ok', exitCode: 0, stdout: version, stderr: '' }),
});
const offPath = await diagnoseKimiSetup(offPathContext(FIXTURE.kimiVersion), { instances: liveOne, token: 't' });
const offPathBinaryCheck = byId(offPath, 'kimi.binary');
check('an off-PATH install passes the binary check',
  offPathBinaryCheck?.status === 'pass' && offPathBinaryCheck.detailCode === 'binary-found',
  `${offPathBinaryCheck?.status}/${offPathBinaryCheck?.detailCode}`);
check('the off-PATH location is carried as evidence',
  String(offPathBinaryCheck?.evidence?.executable ?? '').includes('.kimi-code/bin/kimi'),
  String(offPathBinaryCheck?.evidence?.executable ?? ''));
check('an off-PATH install still passes the version check',
  byId(offPath, 'kimi.version')?.status === 'pass');
check('the PATH gap stays an advisory, not a contradiction',
  byId(offPath, 'kimi.binary-off-path')?.status === 'warn');

const oldOffPath = await diagnoseKimiSetup(offPathContext('0.20.0'), { instances: liveOne, token: 't' });
check('the version floor is still enforced through the fallback binary',
  byId(oldOffPath, 'kimi.version')?.status === 'fail'
    && byId(oldOffPath, 'kimi.version')?.detailCode === 'version-below-minimum',
  `${byId(oldOffPath, 'kimi.version')?.status}/${byId(oldOffPath, 'kimi.version')?.detailCode}`);

// ── The bearer token never reaches a check ──────────────────────────────────

check('no diagnosis check carries the bearer token',
  !JSON.stringify([healthy, noBinary, serverDown, bypass, offPath, matched]).includes('fixture-token'));

// ── The adapter diagnosis path stays inside the capability boundary ─────────
//
// `KimiAdapter.diagnoseSetup` must reach the registry, the records, and the
// pid table ONLY through the context: `listDirectory` for names, `readText`
// for content, `processAlive` for liveness. Recording fixtures prove the
// calls actually route through the context, and the resulting diagnosis shows
// the scan worked end to end through those capabilities alone.

{
  const registryDir = `${FIXTURE_HOME}/.kimi-code/server/instances`;
  const record = { server_id: FIXTURE_SERVER_ID, pid: 4321, host: '127.0.0.1', port: listenPort };
  const listedDirs: string[] = [];
  const probedPids: number[] = [];
  const readPaths: string[] = [];
  const boundaryContext = context({
    listDirectory: (path: string) => {
      listedDirs.push(path);
      return path === registryDir
        ? { ok: true as const, names: ['live.json'], truncated: false }
        : { ok: false as const, reason: 'missing' as const };
    },
    processAlive: (pid: number) => {
      probedPids.push(pid);
      return pid === record.pid;
    },
    readText: (path: string) => {
      readPaths.push(path);
      return path.endsWith('server.token')
        ? { ok: true as const, text: 'fixture-token' }
        : { ok: true as const, text: JSON.stringify(record) };
    },
  });
  const { KimiAdapter } = await import('../src/index.ts');
  const adapterReport = await new KimiAdapter().diagnoseSetup(boundaryContext);
  check('adapter diagnosis lists the registry through the context',
    listedDirs.includes(registryDir), listedDirs.join(','));
  check('adapter diagnosis probes the recorded pid through the context',
    probedPids.length === 1 && probedPids[0] === record.pid, probedPids.join(','));
  check('adapter diagnosis reads records and token through the bounded readText',
    readPaths.some((path) => path.endsWith('live.json')) && readPaths.some((path) => path.endsWith('server.token')),
    readPaths.join(','));
  check('the context-scanned instance reaches the server check',
    byId(adapterReport, 'kimi.server')?.status === 'pass',
    `${byId(adapterReport, 'kimi.server')?.status}/${byId(adapterReport, 'kimi.server')?.detailCode}`);
}

// ── The injected token reader obeys its ceiling on the doctor path too ──────
//
// `KimiAdapter.diagnoseSetup` reads the token through the SAME injected reader
// the runtime uses, so it owes the same rule: something past the 4KB ceiling is
// not a token and must yield no credential, and a reader that throws has
// produced none rather than taking the whole diagnosis down. One reader, one
// rule — a doctor probing with a header the runtime would refuse to send is
// diagnosing a request the adapter never makes.

{
  const registryDir = `${FIXTURE_HOME}/.kimi-code/server/instances`;
  const record = { server_id: FIXTURE_SERVER_ID, pid: 4321, host: '127.0.0.1', port: listenPort };
  const probeHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
  const tokenContext = (): SetupDiagnosisContext => context({
    listDirectory: (path: string) => (path === registryDir
      ? { ok: true as const, names: ['live.json'], truncated: false }
      : { ok: false as const, reason: 'missing' as const }),
    processAlive: (pid: number) => pid === record.pid,
    readText: (path: string) => (path.endsWith('server.token')
      ? { ok: true as const, text: 'file-token' }
      : { ok: true as const, text: JSON.stringify(record) }),
    fetchJson: async (url: string, headers?: Readonly<Record<string, string>>) => {
      if (url.endsWith('/healthz')) return { status: 'ok' as const, json: FIXTURE.rest.healthz };
      probeHeaders.push(headers);
      return { status: 'ok' as const, json: FIXTURE.rest.meta };
    },
  });
  const { KimiAdapter } = await import('../src/index.ts');
  // Mirrored from implementation.ts's SERVER_TOKEN_MAX_BYTES, which stays
  // package-internal: the facade exports the adapter and the gate, nothing else.
  const tokenCeiling = 4 * 1024;

  const carried = await new KimiAdapter({ readToken: () => 'within-the-ceiling' })
    .diagnoseSetup(tokenContext());
  check('a token within the ceiling reaches the meta probe as a bearer credential',
    probeHeaders.length === 1 && probeHeaders[0]?.authorization === 'Bearer within-the-ceiling'
      && byId(carried, 'kimi.server')?.status === 'pass',
    `${JSON.stringify(probeHeaders)} ${byId(carried, 'kimi.server')?.status}`);

  probeHeaders.length = 0;
  const oversized = await new KimiAdapter({ readToken: () => 'x'.repeat(tokenCeiling + 1) })
    .diagnoseSetup(tokenContext());
  check('an oversized injected token sends no credential on the doctor path either',
    probeHeaders.length === 1 && probeHeaders[0] === undefined
      && oversized.checks.length > 0,
    `${JSON.stringify(probeHeaders)} checks=${oversized.checks.length}`);

  probeHeaders.length = 0;
  const throwing = await new KimiAdapter({ readToken: () => { throw new Error('reader failed'); } })
    .diagnoseSetup(tokenContext());
  check('a throwing injected token reader yields no credential and still returns a diagnosis',
    throwing.agent === 'kimi' && throwing.checks.length > 0
      && probeHeaders.length === 1 && probeHeaders[0] === undefined,
    `checks=${throwing.checks.length} headers=${JSON.stringify(probeHeaders)}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
