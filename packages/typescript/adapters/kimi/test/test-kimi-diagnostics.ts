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
import { KIMI_DEFAULT_PORT, decodeKimiInstanceRecord, resolveKimiHome } from '../src/server.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
  kimiVersion: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
  instanceRecord: Record<string, unknown>;
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
/**
 * The identity an installed service manages on this fixture machine, resolved
 * through the same function the adapter reports to the broker — never a literal
 * path, so a test cannot agree with a rule the product no longer follows.
 */
const MANAGED_HOME = resolveKimiHome({}, FIXTURE_HOME);
// The registry record AS CAPTURED. Its `server_id` is upstream's own and is a
// DIFFERENT ULID from the one the captured `/api/v1/meta` echoes: upstream
// mints the two independently, so a fixture that derives either from the other
// makes an unsatisfiable gate look healthy. Doctor's identity tests below run
// against this record, not a synthesized one.
const FIXTURE_RECORD = decodeKimiInstanceRecord(FIXTURE.instanceRecord)!;
const FIXTURE_META = FIXTURE.rest.meta!.data as Record<string, unknown>;

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

const liveOne = {
  live: [{
    baseUrl,
    port: listenPort,
    pid: FIXTURE_RECORD.pid,
    serverId: FIXTURE_RECORD.serverId,
    hostVersion: FIXTURE_RECORD.hostVersion,
    startedAt: FIXTURE_RECORD.startedAt,
  }],
  stale: 0, invalid: 0, truncated: false,
};

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
check('the not-running remediation names the user-facing command when nothing manages the host',
  down?.remediation?.command === 'kimi web --no-open');

// THE MANAGED POSTURE. Same absent server, opposite instruction.
//
// Where cosyncing starts and supervises this host, telling the operator to run
// `kimi web` races the broker's own recovery and leaves two servers on one home
// — which cosyncing then refuses to guess between. The check still reports the
// host is down; only what to DO about it changes.
const managedDown = await diagnoseKimiSetup(
  context({ managedExternalHostIdentities: [MANAGED_HOME] }),
  { instances: { live: [], stale: 2, invalid: 0, truncated: false } },
);
const managedServer = byId(managedDown, 'kimi.server');
check('the managed posture reports the same down server, never a fake one',
  managedServer?.status === 'warn' && managedServer.detailCode === 'server-registry-stale',
  `${managedServer?.status}/${managedServer?.detailCode}`);
check('the managed remediation carries NO command at all',
  managedServer?.remediation !== undefined && managedServer.remediation.command === undefined,
  JSON.stringify(managedServer?.remediation));
check('...and never names a way to start a competing host',
  !/kimi web/.test(managedServer?.remediation?.message ?? '')
    && /cosyncing/.test(managedServer?.remediation?.message ?? ''),
  managedServer?.remediation?.message);
// The posture is the ONLY difference between the two answers, which is what
// makes it a posture rather than a second diagnosis.
// EVERY start/restart instruction follows the posture, not just the one for an
// absent server. Stopping a running server is what opens the window: the
// supervisor sees its host gone and starts a replacement while the operator,
// following the instruction to completion, starts another.
{
  const managedContext = context({ managedExternalHostIdentities: [MANAGED_HOME] });
  const managedDiagnoses = [
    // No server at all: the START instruction.
    await diagnoseKimiSetup(managedContext, { instances: { live: [], stale: 1, invalid: 0, truncated: false } }),
    // Several servers: the "stop all but one" instruction, which under
    // management could otherwise have them stop cosyncing's own.
    await diagnoseKimiSetup(managedContext, {
      instances: {
        live: [
          { baseUrl, port: listenPort, pid: 4001, serverId: 'a' },
          { baseUrl, port: listenPort + 1, pid: 4002, serverId: 'b' },
        ],
        stale: 0, invalid: 0, truncated: false,
      },
    }),
    // A live server with no token file: the RESTART instruction, and the one
    // that proves stopping is as unsafe as starting — the supervisor fills the
    // window the operator opens.
    await diagnoseKimiSetup(
      context({
        managedExternalHostIdentities: [MANAGED_HOME],
        inspectPath: (path) => ({
          status: path.endsWith('server.token') ? 'missing' as const : 'directory' as const,
          readable: true,
          displayPath: path,
        }),
      }),
      { instances: liveOne, token: 'fixture-token' },
    ),
    // A live server that fails its health contract: another RESTART path.
    await diagnoseKimiSetup(
      context({
        managedExternalHostIdentities: [MANAGED_HOME],
        fetchJson: async () => ({ status: 'unreachable' as const }),
      }),
      { instances: liveOne, token: 'fixture-token' },
    ),
    // A live server whose identity cannot be bound: the IDENTITY_FAILURE table,
    // whose unmanaged wording lives in a const the posture must still override.
    await diagnoseKimiSetup(
      context({
        managedExternalHostIdentities: [MANAGED_HOME],
        fetchJson: async (url) => url.endsWith('/healthz')
          ? { status: 'ok' as const, json: FIXTURE.rest.healthz }
          : { status: 'ok' as const, json: { data: { server: {} } } },
      }),
      { instances: liveOne, token: 'fixture-token' },
    ),
  ];
  const managedChecks = managedDiagnoses.flatMap((diagnosis) => diagnosis.checks);
  const managedMessages = managedChecks
    .map((entry) => entry.remediation?.message)
    .filter((message): message is string => message !== undefined);
  check('no managed-posture remediation names kimi web at all',
    managedMessages.length > 0 && managedMessages.every((message) => !/kimi web/.test(message)),
    managedMessages.filter((message) => /kimi web/.test(message)).join(' | ') || 'none');
  check('no managed-posture remediation carries a runnable command',
    managedChecks.every((entry) => entry.remediation?.command === undefined),
    managedChecks.map((entry) => entry.remediation?.command).filter(Boolean).join(','));
  // Says CONFIGURED TO MANAGE, never "owns this server": the process answering
  // right now may be the operator's own, which cosyncing preserves and never
  // touches, and a claim of ownership would be false exactly then.
  check('the managed wording claims configuration, not ownership of whatever is running',
    managedMessages.some((message) => /configured to manage/.test(message))
      && managedMessages.every((message) => !/owns this server/.test(message)),
    managedMessages.join(' | ').slice(0, 200));
}

// A CONFIGURATION THE SERVICE DOES NOT MANAGE, on a machine where the service
// IS installed. The operator's shell names another Kimi home; the service
// manages the default one and knows nothing about this one.
//
// The inverse honesty failure to the one above, and the reason the posture
// carries identities instead of a flag: an agent-wide "kimi is managed" would
// tell this operator their private home is supervised, when in fact nobody is
// watching it and the manual instruction is the only thing that will start it.
{
  const customHome = '/fixture/elsewhere/.kimi-code';
  const custom = await diagnoseKimiSetup(
    context({
      // The broker still reports what IT manages — the default home — while the
      // diagnosis resolves the operator's.
      managedExternalHostIdentities: [MANAGED_HOME],
      env: { KIMI_CODE_HOME: customHome },
    }),
    { instances: { live: [], stale: 1, invalid: 0, truncated: false } },
  );
  const customServer = byId(custom, 'kimi.server');
  check('a home the service does not manage keeps the manual start command',
    customServer?.remediation?.command === 'kimi web --no-open',
    JSON.stringify(customServer?.remediation));
  check('...and is never described as managed by cosyncing',
    !/configured to manage/.test(customServer?.remediation?.message ?? ''),
    customServer?.remediation?.message);
  // The identity actually decided it: the same shell, with the broker managing
  // THIS home, flips to the managed posture and drops the command.
  const alsoManaged = await diagnoseKimiSetup(
    context({
      managedExternalHostIdentities: [MANAGED_HOME, customHome],
      env: { KIMI_CODE_HOME: customHome },
    }),
    { instances: { live: [], stale: 1, invalid: 0, truncated: false } },
  );
  const alsoManagedServer = byId(alsoManaged, 'kimi.server');
  check('a custom home the broker DOES manage takes the managed posture',
    alsoManagedServer?.remediation?.command === undefined
      && /configured to manage/.test(alsoManagedServer?.remediation?.message ?? ''),
    JSON.stringify(alsoManagedServer?.remediation));
}

check('the two postures differ in remediation and in nothing else',
  managedServer?.status === down?.status
    && managedServer?.detailCode === down?.detailCode
    && managedServer?.remediation?.message !== down?.remediation?.message,
  `${managedServer?.detailCode} | ${down?.detailCode}`);

// Fail closed on several live servers: they are not interchangeable, so naming
// one would be a guess presented as a fact. The adapter refuses the same way.
const ambiguousDiagnosis = await diagnoseKimiSetup(context(), {
  instances: {
    live: [
      { baseUrl, port: listenPort, pid: 4001, serverId: 'a' },
      { baseUrl, port: listenPort + 1, pid: 4002, serverId: 'b' },
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
// A server answering with its token gate disabled answers ANY caller, so the
// authenticated probe proved nothing about which server it is. That is a gate
// refusal now, replacing the pass — not an advisory pushed alongside one.
const bypassCheck = byId(bypass, 'kimi.server');
check('a bypassed auth gate fails the diagnosis outright, with no passing server beside it',
  bypassCheck?.status === 'fail'
    && bypassCheck.detailCode === 'server-auth-bypassed'
    && byId(bypass, 'kimi.server-auth') === undefined,
  `${bypassCheck?.status}/${bypassCheck?.detailCode}`);

// ── The identity gate, applied by doctor ────────────────────────────────────

// Doctor must reach the SAME verdict as the adapter through the SAME binding
// function, or a user gets a green doctor for a server every read then refuses.
const metaPatched = (patch: (data: Record<string, unknown>) => Record<string, unknown>) => context({
  fetchJson: async (url: string) => {
    if (url.endsWith('/healthz')) return { status: 'ok' as const, json: FIXTURE.rest.healthz };
    return { status: 'ok' as const, json: { code: 0, data: patch({ ...FIXTURE_META }) } };
  },
});
const drop = (key: string) => (data: Record<string, unknown>) => {
  delete data[key];
  return data;
};
for (const [label, patch, detailCode] of [
  ['an absent server id', drop('server_id'), 'server-metadata-invalid'],
  ['a non-string server id', (d: Record<string, unknown>) => ({ ...d, server_id: 42 }), 'server-metadata-invalid'],
  ['an absent start time', drop('started_at'), 'server-metadata-invalid'],
  ['a start time its record contradicts',
    (d: Record<string, unknown>) => ({ ...d, started_at: new Date(FIXTURE_RECORD.startedAt! - 1).toISOString() }),
    'server-identity-mismatch'],
  ['a version its record contradicts',
    (d: Record<string, unknown>) => ({ ...d, server_version: '9.9.9' }), 'server-version-mismatch'],
] as const) {
  const report = await diagnoseKimiSetup(metaPatched(patch), { instances: liveOne, token: 't' });
  const serverCheck = byId(report, 'kimi.server');
  check(`doctor fails on ${label}`,
    serverCheck?.status === 'fail' && serverCheck.detailCode === detailCode,
    `${serverCheck?.status}/${serverCheck?.detailCode}`);
}
const unbindable = await diagnoseKimiSetup(context(), {
  instances: { ...liveOne, live: [{ baseUrl, port: listenPort, pid: FIXTURE_RECORD.pid, serverId: FIXTURE_RECORD.serverId }] },
  token: 't',
});
const unbindableCheck = byId(unbindable, 'kimi.server');
check('doctor fails when the registry record carries no start time to bind against',
  unbindableCheck?.status === 'fail' && unbindableCheck.detailCode === 'server-identity-unbindable',
  `${unbindableCheck?.status}/${unbindableCheck?.detailCode}`);

// THE REGRESSION, on doctor's side: the captured record and the captured
// metadata, unmodified — two different ids, one boot.
check('the captured record id and the captured meta id DIFFER — siblings, not copies',
  FIXTURE_RECORD.serverId !== FIXTURE_META.server_id,
  `${FIXTURE_RECORD.serverId} vs ${String(FIXTURE_META.server_id)}`);
const matched = await diagnoseKimiSetup(context(), { instances: liveOne, token: 't' });
check('doctor passes on the CAPTURED record and metadata — the shape a real host serves',
  byId(matched, 'kimi.server')?.status === 'pass',
  `${byId(matched, 'kimi.server')?.status}/${byId(matched, 'kimi.server')?.detailCode}`);

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
  // The CAPTURED record — upstream's own `server_id`, `started_at`, and
  // `host_version` — with only the address and pid redirected at this fixture.
  const record = { ...FIXTURE.instanceRecord, pid: 4321, host: '127.0.0.1', port: listenPort };
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
  // The CAPTURED record — upstream's own `server_id`, `started_at`, and
  // `host_version` — with only the address and pid redirected at this fixture.
  const record = { ...FIXTURE.instanceRecord, pid: 4321, host: '127.0.0.1', port: listenPort };
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
