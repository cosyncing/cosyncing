#!/usr/bin/env bun
/**
 * The dsh gate: ONE flag, OPT-IN, DEFAULT OFF, and FOREGROUND ONLY.
 *
 * `COSYNCING_ENABLE_DSH` carries two independent reasons, either sufficient on
 * its own:
 *
 *  1. CLIENT COMPATIBILITY, the same one the Kimi lane established for the same
 *     integration kind. `/api/agents` is not revision-filtered, so one dsh row
 *     makes any client that decodes `IntegrationKind` strictly throw on
 *     `http-websocket` — and because a single unknown row aborts the WHOLE
 *     roster decode, such a client loses every agent, dsh installed or not.
 *  2. EXTERNAL HOST DEPENDENCY. This adapter never starts, stops, or configures
 *     anything: it talks to a `dsh web` host the operator is already running.
 *     On a machine with no host, every action on the row fails, so the row
 *     appears only where somebody said the host is there.
 *
 * Unlike Kimi there is no second Drive gate, because there is nothing to stage:
 * dsh serves ONE undifferentiated client contract. There is no read-only
 * credential, so an "observe" attach would hold the same full write authority
 * as `live` and the word would be a lie — the adapter refuses it outright and
 * the row advertises `live` only. Registration therefore admits the whole
 * surface at once, which is why the flag itself is the entire boundary.
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
 * listens, so an unset variable had to fail closed rather than open. The
 * fixture's own pin is asserted below.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-registration-gate.ts
 */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isolatedBrokerFixtureEnvironment,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { DshAdapter, dshRegistrationEnabled, DSH_ENABLE_ENV } from '../../../adapters/dsh/src/index.ts';
import { DSH_BASE_URL_ENV, DSH_DEFAULT_BASE_URL } from '../../../adapters/dsh/src/server.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
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
    stdout: 'ignore',
    stderr: 'ignore',
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
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const broker = spawnBroker(port, env);
  try {
    await waitForBrokerHealth(
      broker as { exitCode: number | null; exited: Promise<number> },
      `${base}/api/health`,
    );
    return await ask(base);
  } finally {
    await stopBroker(broker);
  }
}

async function agentRows(base: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}/api/agents`);
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
    probeEnvironment[DSH_ENABLE_ENV] === undefined
      && probeEnvironment.DSH_HOME === undefined
      && probeEnvironment.HOME === join(fixtureRoot, 'home'),
    `${String(probeEnvironment[DSH_ENABLE_ENV])} / ${String(probeEnvironment.HOME)}`);

  // ── The predicate ─────────────────────────────────────────────────────────
  check('the gate predicate defaults to off for absent and false-like values',
    !dshRegistrationEnabled({})
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: '' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: '   ' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: '0' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: 'false' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: 'off' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: 'no' })
      && !dshRegistrationEnabled({ [DSH_ENABLE_ENV]: 'enabled' }));
  check('the gate predicate accepts exactly the repo truthy spellings, case- and space-insensitive',
    TRUTHY_SPELLINGS.every((value) => dshRegistrationEnabled({ [DSH_ENABLE_ENV]: value }))
      && dshRegistrationEnabled({ [DSH_ENABLE_ENV]: ' True ' })
      && dshRegistrationEnabled({ [DSH_ENABLE_ENV]: 'ON' }),
    TRUTHY_SPELLINGS.join(','));

  // ── The stock broker behaves as if dsh does not exist ─────────────────────
  const withoutFlag = await rosterAgents({});
  const withoutIds = withoutFlag.map((row) => String(row.id));
  check('a default broker serves no dsh row', !withoutIds.includes('dsh'), withoutIds.join(','));
  check('a default broker still serves the established agents',
    ['opencode', 'pi', 'codex', 'claude'].every((id) => withoutIds.includes(id)),
    withoutIds.join(','));

  // ── Every accepted spelling registers, through a real broker each time ────
  //
  // The predicate above proves the parser; these prove the WIRING reads that
  // parser. A spelling accepted by the predicate but dropped somewhere between
  // `process.env` and `registry.register` would pass the first check and fail
  // here, which is the whole reason each spelling gets its own broker.
  let canonicalRow: Record<string, unknown> | undefined;
  let canonicalCreate: { status: number; body: Record<string, unknown> } | undefined;
  for (const spelling of TRUTHY_SPELLINGS) {
    const isCanonical = spelling === '1';
    const answered = await withBroker(
      { [DSH_ENABLE_ENV]: spelling },
      async (base) => ({
        rows: await agentRows(base),
        // The create route costs one more request on one broker, not four.
        create: isCanonical ? await createDshSession(base) : undefined,
      }),
    );
    const ids = answered.rows.map((row) => String(row.id));
    const dshRows = answered.rows.filter((row) => String(row.id) === 'dsh');
    check(`the opt-in spelling "${spelling}" registers EXACTLY ONE dsh row`,
      dshRows.length === 1, ids.join(','));
    check(`the opt-in spelling "${spelling}" adds ONLY dsh`,
      ids.length === withoutIds.length + 1 && withoutIds.every((id) => ids.includes(id)),
      ids.join(','));
    if (isCanonical) {
      canonicalRow = dshRows[0];
      canonicalCreate = answered.create;
    }
  }

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
  check('the adapter REFUSES an observe attach rather than serving a full-authority connection under that name',
    await refuses('observe'));
  check('the adapter REFUSES a resume attach', await refuses('resume'));
  // The reviewed Drive posture: every discovered session is drivable because
  // writes are RPCs into the one owner, so cross-client sharing is the normal
  // state rather than a conflict; approvals are per tool call, which is what
  // the host asks for; and this round advertises no model switch, no native
  // file input, and no artifact signal because those upstream methods are off
  // the round-1 allowlist.
  check('the served dsh row carries the reviewed Drive posture',
    capabilities?.supportsCrossClientDriveSharing === true
      && capabilities?.permissionGranularity === 'per-tool'
      && capabilities?.supportsModelSwitch === false
      && capabilities?.supportsNativeFileInput === false
      && capabilities?.supportsNativeArtifact === false,
    JSON.stringify(capabilities));
  // Write-class actions are derived from HOOK PRESENCE (`runtime.ts`), so this
  // asserts which hooks the adapter actually defines. Rename exists; fork,
  // clone, transcript export and create-time model selection do not, because
  // their upstream methods are on the deferred list the path builder refuses.
  check('the served dsh row offers native rename and NO other write-class action',
    canonicalRow?.canRenameNative === true
      && canonicalRow?.canSelectModelAtCreation === false
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

  // ── Activation scope: foreground only ─────────────────────────────────────
  //
  // The durable service environment is a closed enumerated list and must not
  // carry the flag, so a managed systemd/launchd broker cannot enable dsh.
  // Pinned here as a tripwire — the later lifecycle round that adds a persisted
  // feature-gate path flips this check deliberately, with the receipts that
  // surface owns.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment carries neither the dsh gate nor a dsh host address',
    !serviceEnvironment.includes(DSH_ENABLE_ENV) && !serviceEnvironment.includes(DSH_BASE_URL_ENV),
    serviceEnvironment.join(','));

  // ── Doctor rides the SAME gate ────────────────────────────────────────────
  //
  // Doctor describes the CURRENT environment, so with the flag on it may
  // legitimately diagnose dsh — the running (foreground) broker serves it. What
  // must never happen is the two disagreeing, so the check is agreement across
  // every spelling rather than two independent assertions.
  const doctorDefault = defaultDoctorAdapters({}).map((adapter) => adapter.id);
  check('default doctor diagnoses no dsh adapter', !doctorDefault.includes('dsh'), doctorDefault.join(','));
  const disagreements: string[] = [];
  for (const value of [...TRUTHY_SPELLINGS, '', '0', 'false', 'off', 'no', 'enabled']) {
    const environment = { [DSH_ENABLE_ENV]: value };
    const diagnosed = defaultDoctorAdapters(environment).some((adapter) => adapter.id === 'dsh');
    if (diagnosed !== dshRegistrationEnabled(environment)) disagreements.push(JSON.stringify(value));
  }
  check('doctor and the registration predicate agree for every spelling, truthy and false-like',
    disagreements.length === 0, disagreements.join(','));
  const doctorEnabled = defaultDoctorAdapters({ [DSH_ENABLE_ENV]: '1' }).map((adapter) => adapter.id);
  check('the opt-in flag adds dsh to doctor, and only dsh',
    doctorEnabled.includes('dsh')
      && doctorEnabled.length === doctorDefault.length + 1
      && doctorDefault.every((id) => doctorEnabled.includes(id)),
    doctorEnabled.join(','));

  // ── Setup stays closed ────────────────────────────────────────────────────
  //
  // Setup advertises what the SERVICE IT INSTALLS will serve, and that
  // service's environment is the closed list pinned above — it cannot carry the
  // flag. So even when the (gated) doctor report carries a dsh section, setup
  // omits the row: advertising it would promise an agent the installed service
  // then refuses to serve. This flips deliberately in the lifecycle round that
  // persists the gate into the service environment.
  const summaryFor = (agents: string[]) => agentSummaries({
    minimumVersions: agents.map((agent) => ({
      agent, displayName: agent, version: '0.0.0',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    })),
    sections: [{ id: 'agents', title: 'Agents', checks: [] }],
  } as never).map((row) => row.id as string);
  check('setup omits dsh when the doctor did not diagnose it',
    !summaryFor(['codex', 'opencode', 'pi', 'claude']).includes('dsh'),
    summaryFor(['codex', 'opencode', 'pi', 'claude']).join(','));
  check('setup omits dsh even when the doctor report carries it (the service cannot serve it)',
    !summaryFor(['codex', 'opencode', 'pi', 'claude', 'dsh']).includes('dsh'),
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'dsh']).join(','));
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
