#!/usr/bin/env bun
/**
 * The Kimi gates: TWO of them, both OPT-IN and both DEFAULT OFF.
 *
 * `COSYNCING_ENABLE_KIMI` is a client-compatibility gate. `/api/agents` is not
 * revision-filtered, so one Kimi row makes any client that decodes
 * `IntegrationKind` strictly throw, and because a single unknown row aborts the
 * WHOLE roster decode such a client loses every agent, Kimi installed or not.
 * The default therefore has to be off until every supported client ships the
 * tolerant decoding added in the same contract revision as the new kind.
 *
 * `COSYNCING_KIMI_DRIVE` is a separate controlled-rollout gate for K2's write
 * surface. With it off the adapter is the K1 observe surface exactly, and the
 * create hooks are ABSENT rather than throwing — the broker reads capability
 * from method presence, so a throwing stub still advertises a creatable tool.
 * Foreground clients can request `mode=live`; keeping the flag opt-in leaves
 * physical Kimi Drive qualification independent of the read-only integration.
 *
 * Proved against a REAL broker over its real `/api/agents` and create routes
 * rather than by reading the registration source, because "is the row served"
 * and "does the create button work" are the only forms of the question that
 * matter to those clients.
 *
 *   bun run packages/typescript/broker/test/kimi/test-kimi-registration-gate.ts
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
import {
  kimiDriveEnabled,
  kimiRegistrationEnabled,
  KIMI_DRIVE_ENV,
  KIMI_ENABLE_ENV,
} from '../../../adapters/kimi/src/index.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kimi-gate-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-kimi-gate-home-'));

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

function spawnBroker(port: number, env: Record<string, string>) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    // A scrubbed fixture environment, never ...process.env: an inherited
    // developer environment lets the broker reach real host agent state.
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        HOST: '127.0.0.1',
        PORT: String(port),
        COSYNCING_HOME: home,
        COSYNCING_RESTART_DRY_RUN: '1',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_CLAUDE_HOOKS: '0',
        ...env,
      },
    }),
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

/** One real broker, one question. Each spawn is expensive, so each one answers everything it can. */
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

/** What the create route answers for a tool. The status and the message are both the contract. */
async function createKimiSession(base: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/sessions/kimi`, {
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
  // The predicate itself: only an explicit truthy opt-in enables registration.
  check('the gate predicate defaults to off',
    !kimiRegistrationEnabled({})
      && !kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: '' })
      && !kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: '0' })
      && !kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: 'false' }));
  check('the gate predicate accepts the repo truthy spellings',
    kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: '1' })
      && kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: 'true' })
      && kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: 'YES' })
      && kimiRegistrationEnabled({ [KIMI_ENABLE_ENV]: 'on' }));
  // The DRIVE gate is a second, independent flag with the same shape: neither
  // one implies the other, and they read the same truthy spellings so two gates
  // cannot drift into two conventions.
  check('the drive-gate predicate defaults to off and reads the same spellings',
    !kimiDriveEnabled({})
      && !kimiDriveEnabled({ [KIMI_DRIVE_ENV]: '0' })
      && !kimiDriveEnabled({ [KIMI_ENABLE_ENV]: '1' })
      && kimiDriveEnabled({ [KIMI_DRIVE_ENV]: '1' })
      && kimiDriveEnabled({ [KIMI_DRIVE_ENV]: 'on' })
      && !kimiRegistrationEnabled({ [KIMI_DRIVE_ENV]: '1' }));

  const withoutFlag = await rosterAgents({});
  const withoutIds = withoutFlag.map((row) => String(row.id));
  check('a default broker serves no kimi row',
    !withoutIds.includes('kimi'), withoutIds.join(','));
  check('a default broker still serves the established agents',
    ['opencode', 'pi', 'codex', 'claude'].every((id) => withoutIds.includes(id)),
    withoutIds.join(','));

  // ── Registration alone: the K1 surface, and nothing that implies a writer ──
  //
  // TWO gates, and this broker has only the first. `COSYNCING_KIMI_DRIVE` is
  // default-off as the K2 controlled-rollout boundary. Registration alone must
  // keep serving the complete K1 observe posture even though current clients
  // know how to request a foreground `mode=live` attach.
  const { rows: withFlag, create: createWithoutDrive } = await withBroker(
    { [KIMI_ENABLE_ENV]: '1' },
    async (base) => ({ rows: await agentRows(base), create: await createKimiSession(base) }),
  );
  const withIds = withFlag.map((row) => String(row.id));
  check('the opt-in flag adds the kimi row', withIds.includes('kimi'), withIds.join(','));
  check('the opt-in flag adds ONLY kimi',
    withIds.length === withoutIds.length + 1
      && withoutIds.every((id) => withIds.includes(id)),
    withIds.join(','));

  // The served row is what a client decodes, so assert the wire posture rather
  // than the adapter's in-process capabilities object.
  const kimiRow = withFlag.find((row) => String(row.id) === 'kimi');
  const capabilities = kimiRow?.capabilities as Record<string, unknown> | undefined;
  check('the registered-but-undriven kimi row advertises OBSERVE ONLY',
    capabilities?.integrationKind === 'http-websocket'
      && JSON.stringify(capabilities?.attachModes) === '["observe"]'
      && capabilities?.supportsObserve === true
      // The adapter never owns the Kimi process, so there is nothing to resume
      // into — unchanged by either gate.
      && capabilities?.supportsResume === false
      && capabilities?.supportsLiveAttach === false
      // Model selection rides the prompt body, so it is a write: an observe-only
      // surface cannot offer it.
      && capabilities?.supportsModelSwitch === false
      && capabilities?.permissionGranularity === 'per-session',
    JSON.stringify(capabilities));
  check('the served kimi row still advertises no native file input or artifact signal',
    capabilities?.supportsNativeFileInput === false
      && capabilities?.supportsNativeArtifact === false,
    JSON.stringify(capabilities));
  // Every write-class action is absent, creation included. `canCreateSession`
  // and `canSelectModelAtCreation` are both derived from HOOK PRESENCE
  // (`runtime.ts:5136-5139`), which is exactly why the gate removes the methods
  // rather than making them throw: a defined method still advertises a
  // creatable tool.
  check('the registered-but-undriven kimi row offers NO write-class action, creation included',
    kimiRow?.canCreateSession === false
      && kimiRow?.canSelectModelAtCreation === false
      && kimiRow?.canRenameNative === false
      && kimiRow?.canFork === false && kimiRow?.canClone === false
      && kimiRow?.canTranscriptExport === false,
    JSON.stringify(kimiRow));
  // The route the create button hits, answered by the same presence probe
  // (`runtime.ts:4496`). A typed refusal the client can act on, not a 500 from a
  // create that was never going to work.
  check('the create route answers "cannot create sessions" for kimi with the drive gate off',
    createWithoutDrive.status === 400
      && String(createWithoutDrive.body.error) === "tool 'kimi' cannot create sessions",
    `${createWithoutDrive.status} ${JSON.stringify(createWithoutDrive.body)}`);

  // ── Both gates: the K2 surface ────────────────────────────────────────────

  const bothFlags = await rosterAgents({ [KIMI_ENABLE_ENV]: '1', [KIMI_DRIVE_ENV]: '1' });
  const drivenRow = bothFlags.find((row) => String(row.id) === 'kimi');
  const drivenCapabilities = drivenRow?.capabilities as Record<string, unknown> | undefined;
  check('with the drive gate on, the served kimi row advertises the observe-plus-drive posture',
    // Observe still leads: it is the mode EVERY Kimi session supports. Drive is
    // reachable only for a session cosyncing created in this broker process.
    JSON.stringify(drivenCapabilities?.attachModes) === '["observe","live"]'
      && drivenCapabilities?.supportsLiveAttach === true
      && drivenCapabilities?.supportsModelSwitch === true
      && drivenCapabilities?.supportsResume === false,
    JSON.stringify(drivenCapabilities));
  // `canCreateSession` is FALSE even here, and that is the point: the route
  // derives it as "the hook exists AND the adapter says it can create right
  // now", and this fixture host runs no `kimi web`, so the adapter's live probe
  // correctly answers no. `canSelectModelAtCreation` is the hook-presence half
  // of the same pair and proves the create surface is genuinely wired.
  check('with the drive gate on, create-time model selection is wired and no other write action is',
    drivenRow?.canSelectModelAtCreation === true
      && drivenRow?.canCreateSession === false
      && drivenRow?.canRenameNative === false
      && drivenRow?.canFork === false && drivenRow?.canClone === false
      && drivenRow?.canTranscriptExport === false,
    JSON.stringify(drivenRow));
  // The drive gate is about the SURFACE, never about who is on the roster: it
  // must not smuggle a Kimi row past the registration gate.
  const driveFlagAlone = await rosterAgents({ [KIMI_DRIVE_ENV]: '1' });
  check('the drive flag alone registers nothing — the two gates are independent',
    !driveFlagAlone.map((row) => String(row.id)).includes('kimi'),
    driveFlagAlone.map((row) => String(row.id)).join(','));

  // Activation is FOREGROUND-ONLY for K1: the durable service environment is a
  // closed enumerated list and must not carry the flag, so a managed
  // systemd/launchd broker cannot enable Kimi. Pinned here as a tripwire — the
  // later lifecycle round that adds a persisted feature-gate path flips this
  // check deliberately, with the receipts that surface owns.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment does not carry either kimi flag',
    !serviceEnvironment.includes(KIMI_ENABLE_ENV) && !serviceEnvironment.includes(KIMI_DRIVE_ENV),
    serviceEnvironment.join(','));

  // Doctor rides the SAME gate as broker registration: it describes the
  // CURRENT environment, so with the flag on it may legitimately diagnose
  // Kimi — the running (foreground) broker serves it. The production adapter
  // list is gate-derived from the env the doctor context carries.
  const doctorDefault = defaultDoctorAdapters({}).map((adapter) => adapter.id);
  const doctorEnabled = defaultDoctorAdapters({ [KIMI_ENABLE_ENV]: '1' }).map((adapter) => adapter.id);
  check('default doctor diagnoses no kimi adapter', !doctorDefault.includes('kimi'), doctorDefault.join(','));
  check('the opt-in flag adds kimi to doctor, and only kimi',
    doctorEnabled.includes('kimi')
      && doctorEnabled.length === doctorDefault.length + 1
      && doctorDefault.every((id) => doctorEnabled.includes(id)),
    doctorEnabled.join(','));

  // Setup must advertise only what the SERVICE IT INSTALLS will serve. That
  // service's environment is the closed list pinned above — it cannot carry
  // the flag — so even when the (gated) doctor report carries a Kimi section,
  // setup omits the row: advertising it would promise an agent the installed
  // service then refuses to serve. This flips deliberately in the lifecycle
  // round that persists the gate into the service environment.
  const summaryFor = (agents: string[]) => agentSummaries({
    minimumVersions: agents.map((agent) => ({
      agent, displayName: agent, version: '0.0.0',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    })),
    sections: [{ id: 'agents', title: 'Agents', checks: [] }],
  } as never).map((row) => row.id as string);
  check('setup omits kimi when the doctor did not diagnose it',
    !summaryFor(['codex', 'opencode', 'pi', 'claude']).includes('kimi'),
    summaryFor(['codex', 'opencode', 'pi', 'claude']).join(','));
  check('setup omits kimi even when the doctor report carries it (service cannot serve it)',
    !summaryFor(['codex', 'opencode', 'pi', 'claude', 'kimi']).includes('kimi'),
    summaryFor(['codex', 'opencode', 'pi', 'claude', 'kimi']).join(','));
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
