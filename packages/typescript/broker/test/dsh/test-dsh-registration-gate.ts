#!/usr/bin/env bun
/**
 * dsh registration: unconditional, and filtered per client.
 *
 * `COSYNCING_ENABLE_DSH` carried two independent reasons, and the route now
 * answers both better than a flag could:
 *
 *  1. CLIENT COMPATIBILITY, the same one the Kimi lane established for the same
 *     integration kind. One dsh row makes any client that decodes
 *     `IntegrationKind` strictly throw on `http-websocket` — and because a
 *     single unknown row aborts the WHOLE roster decode, such a client loses
 *     every agent, dsh installed or not. The flag answered that by denying dsh
 *     to EVERYONE, including the clients that read it perfectly well and a
 *     managed service that could never set it. `/api/agents` now withholds the
 *     row from exactly the clients that cannot decode it.
 *  2. EXTERNAL HOST DEPENDENCY. This adapter never starts, stops, or configures
 *     anything: it talks to a `dsh web` host the operator is already running.
 *     But "no host is running" is a DIAGNOSIS and an empty session list, which
 *     is what an operator needs to see — not a reason to hide the agent behind
 *     a variable they must already know to set. It is still the reason setup
 *     does not offer dsh as an installable agent.
 *
 * There is no second Drive gate as there is for Kimi, because there is nothing
 * to stage: dsh serves ONE undifferentiated client contract. There is no
 * read-only credential, so an "observe" attach would hold the same full write
 * authority as `live` and the word would be a lie — the adapter refuses it
 * outright and the row advertises `live` only.
 *
 * Proved against a REAL broker over its real `/api/agents` and create routes
 * rather than by reading the registration source: "is the row served" and "what
 * does the create button do" are the only forms of the question that matter to
 * a client.
 *
 * NO PRODUCTION ANYTHING. Every broker here is a fixture on an OS-leased port
 * with a temp home and a scrubbed environment, and its dsh base URL is pinned
 * to an unroutable origin by `isolatedBrokerFixtureEnvironment` — the default
 * is `127.0.0.1:3080`, which is exactly where a maintainer's own `dsh web` host
 * listens, and now that registration is unconditional an unpinned fixture would
 * reach it on every run. The fixture's own pin is asserted below.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-registration-gate.ts
 */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';
import { DshAdapter } from '../../../adapters/dsh/src/index.ts';
import {
  ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE,
  CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE,
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
} from '@cosyncing/protocol';

/**
 * The revision this adapter's floor is, and the one it is deliberately NOT.
 *
 * dsh needs the INTEGRATION-KIND tolerance and nothing later: `http-websocket`
 * is the only value in its row a released client could fail to decode, and
 * `live` has existed since the first contract. Pinning the floor at the newer
 * attach-mode tolerance instead would hide the agent from a whole released
 * client generation that decodes the row perfectly.
 */
const FLOOR = String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE);
const LATER_TOLERANCE = String(CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE);
import { DSH_BASE_URL_ENV, DSH_DEFAULT_BASE_URL } from '../../../adapters/dsh/src/server.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-dsh-gate-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-dsh-gate-home-'));

/** Every spelling the repo's shared truthy-env reading accepts. */
const TRUTHY_SPELLINGS = ['1', 'true', 'YES', 'on'] as const;

/** Where the fixture helper points endpoints whose real default is a live host. */
const UNROUTABLE_FIXTURE_ORIGIN = 'http://127.0.0.1:1';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a free TCP port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function fixtureEnvironment(port: number, overrides: Record<string, string>): NodeJS.ProcessEnv {
  // A scrubbed fixture environment, never ...process.env: an inherited
  // developer environment lets the broker reach real host agent state — and for
  // dsh specifically, a real `dsh web` host with full write authority.
  return isolatedBrokerFixtureEnvironment(fixtureRoot, {
    overrides: {
      HOST: '127.0.0.1',
      PORT: String(port),
      COSYNCING_HOME: home,
      COSYNCING_RESTART_DRY_RUN: '1',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CLAUDE_HOOKS: '0',
      ...overrides,
    },
  });
}

function spawnBroker(port: number, overrides: Record<string, string>) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: fixtureEnvironment(port, overrides),
    stdin: 'ignore',
    // PIPED, not ignored, and drained by the caller. Silence is evidence: the
    // shared starter only retires and respawns a stalled start once it can
    // prove the process wrote nothing, and a discarded stream proves nothing.
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  if (!exited && broker.exitCode === null) {
    broker.kill('SIGKILL');
    exited = await Promise.race([broker.exited.then(() => true).catch(() => true), sleep(5_000).then(() => false)]);
  }
  if (!exited) throw new Error('broker did not exit after SIGTERM/SIGKILL');
}

/** One real broker, asked everything it can answer: each spawn is expensive. */
async function withBroker<T>(env: Record<string, string>, ask: (base: string) => Promise<T>): Promise<T> {
  // Through the shared starter: this suite spawns a real broker per question,
  // so it is exposed to both a lost port race and a silent startup stall.
  let output!: ReturnType<typeof captureProcessOutput>;
  const { child: broker, port } = await startHealthyFixtureBroker({
    reservePort: freePort,
    spawn: (attemptPort) => {
      const spawned = spawnBroker(attemptPort, env);
      output = captureProcessOutput(spawned, { maxChars: 4_000 });
      return spawned as unknown as { exitCode: number | null; exited: Promise<number> };
    },
    healthUrl: (attemptPort) => `http://127.0.0.1:${attemptPort}/api/health`,
    capture: () => output,
    stop: (child) => stopBroker(child as unknown as ReturnType<typeof Bun.spawn>),
  });
  try {
    return await ask(`http://127.0.0.1:${port}`);
  } finally {
    await stopBroker(broker as unknown as ReturnType<typeof Bun.spawn>);
  }
}

/**
 * The roster as a client of a given contract revision receives it.
 *
 * `revision` omitted models a client built before the parameter existed, which
 * is the case the filtering exists to protect.
 */
async function agentRows(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents answered ${response.status}`);
  return await response.json() as Array<Record<string, unknown>>;
}

/** What the create route answers. The status, the code, and the retry flag are all the contract. */
async function createDshSession(base: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/sessions/dsh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: '/tmp' }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function rosterAgents(env: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  return withBroker(env, agentRows);
}

try {
  // ── The fixture's own isolation, asserted before anything relies on it ─────
  //
  // This suite's whole safety argument is that no broker it starts can reach a
  // real dsh host. That argument is a property of the helper, so it is checked
  // here rather than assumed: an unset base URL must resolve to something
  // nothing can be listening on, NOT to the production default.
  const probeEnvironment = fixtureEnvironment(0, {});
  const pinnedBaseUrl = String(probeEnvironment[DSH_BASE_URL_ENV] ?? '');
  // Ordered so the "not the default" half is the one that carries weight: it is
  // checked against the value the adapter would otherwise resolve, BEFORE the
  // equality below narrows the type and makes the comparison vacuous.
  check('the fixture pins the dsh base URL away from the production default',
    pinnedBaseUrl !== DSH_DEFAULT_BASE_URL && pinnedBaseUrl === UNROUTABLE_FIXTURE_ORIGIN,
    `${pinnedBaseUrl} (production default ${DSH_DEFAULT_BASE_URL})`);
  check('the fixture environment carries no dsh gate of its own and no inherited host state',
    probeEnvironment.COSYNCING_ENABLE_DSH === undefined
      && probeEnvironment.DSH_HOME === undefined
      && probeEnvironment.HOME === join(fixtureRoot, 'home'),
    `${String(probeEnvironment.COSYNCING_ENABLE_DSH)} / ${String(probeEnvironment.HOME)}`);
  // A fixture may read a wrong host and be merely wrong; a fixture that STARTS
  // one leaves a real `dsh web` running on the machine that ran the suite.
  check('no fixture broker is authorized to start a managed dsh host',
    probeEnvironment.COSYNCING_DSH_MANAGED_HOST === '0',
    String(probeEnvironment.COSYNCING_DSH_MANAGED_HOST));

  // ── One broker, two views ─────────────────────────────────────────────────
  //
  // Registration no longer varies with the environment; only the view does. The
  // old `COSYNCING_ENABLE_DSH` gate hid dsh from everyone to protect the
  // clients that could not decode `http-websocket`, and denied it to a managed
  // service that could never set the flag. The route now withholds the row from
  // exactly those clients and serves it to the rest.
  const { legacy, current, older, later, noncanonical, canonicalCreate } = await withBroker({}, async (base) => ({
    legacy: await agentRows(base),
    current: await agentRows(base, FLOOR),
    older: await agentRows(base, String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE - 1)),
    later: await agentRows(base, LATER_TOLERANCE),
    // Every spelling `Number()` would have read as a revision at or above the
    // floor. Each is a client whose encoding this broker does not recognize,
    // claiming a decode ability the roster would then act on.
    noncanonical: await Promise.all(
      ['not-a-number', '', '0xF', '1e2', ` ${FLOOR} `, `+${FLOOR}`, `0${FLOOR}`, 'Infinity']
        .map(async (raw) => [raw, await agentRows(base, raw)] as const),
    ),
    canonicalCreate: await createDshSession(base),
  }));
  const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((row) => String(row.id));
  const withoutIds = idsOf(legacy);
  const withIds = idsOf(current);

  check('a client that declares nothing is served no dsh row',
    !withoutIds.includes('dsh'), withoutIds.join(','));
  check('a client one revision too old is served no dsh row',
    !idsOf(older).includes('dsh'), idsOf(older).join(','));
  // Fail closed on nonsense rather than 400: refusing would cost the caller
  // every agent, which is the failure this filtering exists to prevent. The
  // grammar must be exactly as narrow as the policy claims — `0xF` and `1e2` are
  // both ≥ the floor to `Number`, and neither is a revision.
  const leaked = noncanonical.filter(([, rows]) => idsOf(rows).includes('dsh')).map(([raw]) => raw);
  check('every non-canonical revision spelling is read as the oldest client, not rejected',
    leaked.length === 0, leaked.map((raw) => JSON.stringify(raw)).join(','));
  check('a client at the tolerant revision IS served EXACTLY ONE dsh row',
    current.filter((row) => String(row.id) === 'dsh').length === 1, withIds.join(','));
  // The floor is a MINIMUM, not an equality: a newer client is served too.
  check('a client past the floor is still served the dsh row',
    idsOf(later).includes('dsh'), idsOf(later).join(','));
  check('the established agents are served to both views',
    ['opencode', 'pi', 'codex', 'claude'].every((id) =>
      withoutIds.includes(id) && withIds.includes(id)),
    `${withoutIds.join(',')} | ${withIds.join(',')}`);
  check('the filter withholds only what the client cannot decode',
    withoutIds.every((id) => withIds.includes(id)),
    `${withoutIds.join(',')} -> ${withIds.join(',')}`);

  const canonicalRow = current.find((row) => String(row.id) === 'dsh');

  // ── What the served row actually claims ───────────────────────────────────
  //
  // Asserted on the WIRE row, not the adapter's in-process capabilities object:
  // the wire is what a client decodes, and only the wire can prove the broker
  // did not reshape it on the way out.
  const capabilities = canonicalRow?.capabilities as Record<string, unknown> | undefined;
  check('the served dsh row reports the http-websocket integration kind',
    capabilities?.integrationKind === 'http-websocket', JSON.stringify(capabilities?.integrationKind));
  check('the served dsh row is LIVE-ONLY: live is the only attach mode, and it is genuinely supported',
    JSON.stringify(capabilities?.attachModes) === '["live"]'
      && capabilities?.supportsLiveAttach === true,
    JSON.stringify(capabilities));
  // Observe is absent as a DECISION, not an omission: dsh has one client
  // contract with no read-only credential, so an "observe" connection would
  // hold full write authority. Resume is absent because the host attaches
  // sessions — there is nothing for a client to resume INTO.
  check('the served dsh row advertises NEITHER observe NOR resume',
    capabilities?.supportsObserve === false && capabilities?.supportsResume === false,
    JSON.stringify(capabilities));
  // The declared minimum is a claim about decodability; this is its evidence.
  // Every attach mode in the row predates both tolerance fallbacks, so the
  // integration kind is the only thing forcing a floor at all. Adding a newer
  // mode without raising the minimum would hand a revision-14 client a row it
  // cannot decode, and it fails HERE rather than in the field.
  const publishedModes = (capabilities?.attachModes as unknown[] ?? []).map(String);
  const needingTolerance = publishedModes.filter(
    (mode) => !ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode as never));
  check('every attach mode dsh publishes predates the attach-mode tolerance',
    publishedModes.length > 0 && needingTolerance.length === 0,
    `published=${publishedModes.join(',')} needing-tolerance=${needingTolerance.join(',')}`);
  check('the adapter REFUSES an observe attach rather than serving a full-authority connection under that name',
    await refuses('observe'));
  check('the adapter REFUSES a resume attach', await refuses('resume'));
  // The reviewed Drive posture: every discovered session is drivable because
  // writes are RPCs into the one owner, so cross-client sharing is the normal
  // state rather than a conflict; approvals are per tool call, which is what
  // the host asks for; model switching and native file input are served
  // (`session.models`/`session.selectModel`, and inline image bytes on the
  // prompt); and there is still no artifact signal, because the host has none.
  check('the served dsh row carries the reviewed Drive posture',
    capabilities?.supportsCrossClientDriveSharing === true
      && capabilities?.permissionGranularity === 'per-tool'
      && capabilities?.supportsModelSwitch === true
      && capabilities?.supportsNativeFileInput === true
      && capabilities?.supportsNativeArtifact === false,
    JSON.stringify(capabilities));
  // Write-class actions are derived from HOOK PRESENCE (`runtime.ts`), so this
  // asserts which hooks the adapter actually defines. Rename exists; fork,
  // clone and transcript export do not, because their upstream methods are on
  // the deferred list the path builder refuses. Create-time model selection is
  // offered: `listModels` reads the host-wide `llm.models` catalog and
  // `createSession` applies the choice via `session.selectModel` after create.
  check('the served dsh row offers native rename and create-time model selection, and NO other write-class action',
    canonicalRow?.canRenameNative === true
      && canonicalRow?.canSelectModelAtCreation === true
      && canonicalRow?.canFork === false
      && canonicalRow?.canClone === false
      && canonicalRow?.canTranscriptExport === false,
    JSON.stringify(canonicalRow));
  // `canCreateSession` is FALSE here and that is the honest answer, not a gap:
  // the field is "the hook exists AND the adapter says it can create RIGHT
  // NOW", and this fixture has no reachable host. Live-only means exactly this
  // — with no host there is nothing to create in.
  check('with no reachable host the row reports it cannot create right now',
    canonicalRow?.canCreateSession === false, JSON.stringify(canonicalRow?.canCreateSession));
  // ...and the route says the same thing in a form a client can act on: a
  // typed, retryable 503, not a 500 from a create that was never going to work.
  check('the create route refuses with a typed retryable unavailability rather than an untyped failure',
    canonicalCreate?.status === 503
      && canonicalCreate.body.code === 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE'
      && canonicalCreate.body.detailCode === 'dsh-create-readiness-unavailable'
      && canonicalCreate.body.retryable === true,
    `${canonicalCreate?.status} ${JSON.stringify(canonicalCreate?.body)}`);

  // ── Activation scope: what IS durable, and what deliberately is not ───────
  //
  // The durable service environment is a closed enumerated list, and the two
  // dsh-shaped things it could carry are not the same question. Managed-host
  // ACTIVATION belongs there — an installed service that can see a host but
  // never start, recover, or stop one is the same as the agent not working. The
  // host ADDRESS does not: pointing the adapter somewhere else is a foreground
  // decision, and a managed broker must never silently inherit a host an
  // operator configured once in a shell.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment activates a managed dsh host',
    serviceEnvironment.includes(managedHostGateEnv('dsh')),
    serviceEnvironment.join(','));
  check('the durable service environment carries no retired dsh gate and no dsh host address',
    !serviceEnvironment.some((name) => name.includes('ENABLE_DSH'))
      && !serviceEnvironment.includes(DSH_BASE_URL_ENV),
    serviceEnvironment.join(','));

  // ── Doctor diagnoses dsh unconditionally ──────────────────────────────────
  //
  // It reports what is installed and reachable, and "the host is not running"
  // is exactly what an operator opened doctor to be told. An adapter that
  // disappears unless a variable is set cannot report that, which is why the
  // environment no longer changes this list at all.
  const doctorDefault = defaultDoctorAdapters({}).map((adapter) => adapter.id);
  check('doctor diagnoses dsh with no flag set',
    doctorDefault.includes('dsh'), doctorDefault.join(','));
  const varied: string[] = [];
  for (const value of [...TRUTHY_SPELLINGS, '', '0', 'false', 'off', 'no', 'enabled']) {
    const ids = defaultDoctorAdapters({ COSYNCING_ENABLE_DSH: value }).map((adapter) => adapter.id);
    if (JSON.stringify(ids) !== JSON.stringify(doctorDefault)) varied.push(JSON.stringify(value));
  }
  check('no spelling of the removed flag changes what doctor diagnoses',
    varied.length === 0, varied.join(','));

  // ── Setup stays closed ────────────────────────────────────────────────────
  //
  // Setup advertises what the service it installs can actually DELIVER, and it
  // now delivers this one. dsh was off the preflight while setup neither started
  // nor managed `dsh web` — listing it then would have promised a working agent
  // where the honest answer was "run the host yourself". The service this setup
  // installs now starts that host when none is running, restarts it, and stops
  // the one it started, which is the condition the omission was waiting on.
  //
  // It matters beyond the panel: the same install asks the operator to consent
  // to the runtimes cosyncing will manage, and a host missing from that list is
  // a host managed without being disclosed.
  const summaryFor = (agents: string[]) => agentSummaries({
    minimumVersions: agents.map((agent) => ({
      agent, displayName: agent, version: '0.0.0',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    })),
    sections: [{ id: 'agents', title: 'Agents', checks: [] }],
  } as never).map((row) => row.id as string);
  check('setup lists dsh, whose host the installed service now manages',
    summaryFor(['codex', 'opencode', 'pi', 'claude']).includes('dsh'),
    summaryFor(['codex', 'opencode', 'pi', 'claude']).join(','));
  check('...whether or not the doctor report happened to carry a row for it',
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'dsh']).includes('dsh'),
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'dsh']).join(','));
  // The consent shown immediately before setup writes managed-host activation
  // into the service environment must name this host too.
  for (const language of ['en', 'zh-Hans'] as const) {
    const body = setupMessages(language).managedRuntimeBody('cosyncing');
    check(`the managed-runtime consent names the dsh host (${language})`,
      body.includes('dsh web'), body.slice(0, 160));
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

/**
 * Does an attach in this mode throw before any network call?
 *
 * The mode check is the first statement in `attach`, so this reaches no socket
 * and no host — the unroutable base URL is belt-and-braces.
 */
async function refuses(mode: 'observe' | 'resume'): Promise<boolean> {
  const adapter = new DshAdapter({ env: { [DSH_BASE_URL_ENV]: UNROUTABLE_FIXTURE_ORIGIN } });
  try {
    await adapter.attach('fixture-session', mode);
    return false;
  } catch {
    return true;
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
