#!/usr/bin/env bun
/**
 * Antigravity registration: unconditional, served to everyone, and honest about
 * what an attach will actually do.
 *
 * agy carries NO `minimumClientRevision`, and that is a claim with evidence
 * rather than an omission. The roster decodes as ONE list, so an agent whose row
 * contains an `IntegrationKind` or `AttachMode` an older client cannot parse
 * costs that client EVERY agent — which is why kimi and dsh each declare a floor
 * at the revision that introduced the tolerance THEIR values need. agy's values
 * need none: `sdk-callback` has existed since Claude, and `observe`/`resume` are
 * both in {@link ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE}. A floor set anyway
 * — out of caution, or copied from a neighbour — would hide the agent from a
 * whole released client generation that decodes it perfectly. So the assertion
 * here is two-sided: the row reaches a client that declares nothing, AND the
 * values in it are the ones that make that safe.
 *
 * The second half is the ATTACH CONTRACT, because a capability row is a promise
 * and `attach()` is what keeps it:
 *
 *  - The declared `attachModes` and the modes `attach` honours are the same set.
 *    A mode advertised and refused is a client rendering a control that throws;
 *    a mode honoured and unadvertised is a surface nobody is offered.
 *  - An OBSERVE attach spawns nothing. Every `agy` invocation pays a full
 *    workspace init, so an opened roster row must cost a process launch of zero
 *    — and the fake binary here records its own argv, so "nothing was spawned"
 *    is observed rather than reasoned about.
 *  - A BARE attach is never silently promoted. `attachModes` is observe-FIRST,
 *    so bare means observe: the honest refusal is that it does not quietly
 *    become a drive. That is the exact shape reflection §11 warns about — the
 *    client believes it is driving, the session is not driven, and nothing
 *    anywhere says so.
 *
 * NO PRODUCTION ANYTHING. The broker is a fixture on an OS-leased port whose
 * HOME is a temp directory, and agy's discovery is FILE-BACKED off that HOME —
 * so the fixture's own pin is what keeps a maintainer's real
 * `~/.gemini/antigravity-cli` conversations out of a test's `/api/sessions`.
 * That pin is asserted below rather than assumed. The real `agy` binary is never
 * executed by anything here.
 *
 *   bun run packages/typescript/broker/test/agy/test-agy-registration-gate.ts
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
import {
  ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE,
  BROKER_CONTRACT_REVISION,
  CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE,
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
} from '@cosyncing/protocol';
import { AgyAdapter, AGY_CAPABILITIES } from '../../../adapters/antigravity/src/index.ts';
import { AgyDriveConnection } from '../../../adapters/antigravity/src/drive.ts';
import {
  buildAgyFixtureTree,
  writeFakeAgyBinary,
  FIXTURE,
} from '../../../adapters/antigravity/test/fixtures/tree.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-agy-gate-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-agy-gate-home-'));

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

function fixtureEnvironment(port: number, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // A scrubbed fixture environment, never `...process.env`. agy resolves its
  // store from HOME, so an inherited one would point a fixture broker at the
  // maintainer's real Antigravity conversations.
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

function spawnBroker(port: number) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: fixtureEnvironment(port),
    stdin: 'ignore',
    // PIPED and drained: the shared starter only respawns a stalled start once
    // it can prove the process wrote nothing, and a discarded stream proves
    // nothing.
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
async function withBroker<T>(ask: (base: string) => Promise<T>): Promise<T> {
  let output!: ReturnType<typeof captureProcessOutput>;
  const { child: broker, port } = await startHealthyFixtureBroker({
    reservePort: freePort,
    spawn: (attemptPort) => {
      const spawned = spawnBroker(attemptPort);
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
 * is the oldest thing the filter can be asked about.
 */
async function agentRows(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents answered ${response.status}`);
  return await response.json() as Array<Record<string, unknown>>;
}

// The attach half runs against a temp store and a scripted fake binary; the real
// `agy` is never on this PATH and never spawned.
const tree = buildAgyFixtureTree();
const fakeBinDir = join(tree.dir, 'bin');
const fake = writeFakeAgyBinary(fakeBinDir, {
  init: FIXTURE.streamEvents.init,
  defaultTurn: [FIXTURE.streamEvents.result],
});
const LIVE = FIXTURE.conversationIds.withTranscript;

/** An adapter that can find the fake binary. */
function adapterWithBinary(): AgyAdapter {
  return new AgyAdapter({ roots: tree.roots, env: { PATH: fakeBinDir }, trace: () => {} });
}

/** An adapter with NOTHING on PATH — the machine where the CLI is not installed. */
function adapterWithoutBinary(): AgyAdapter {
  return new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
}

async function attachRefused(adapter: AgyAdapter, mode: string): Promise<string | undefined> {
  try {
    await adapter.attach(LIVE, mode as never);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

try {
  // ── The fixture's own isolation, asserted before anything relies on it ─────
  //
  // agy discovery is file-backed off HOME. If HOME leaked, a fixture broker
  // would discover, publish and serve the maintainer's real Antigravity
  // conversations — the OPENCODE_URL leak in another costume.
  const probeEnvironment = fixtureEnvironment(0);
  check('the fixture pins HOME away from the real Antigravity store',
    probeEnvironment.HOME === join(fixtureRoot, 'home') && probeEnvironment.HOME !== process.env.HOME,
    String(probeEnvironment.HOME));
  // agy has no host address and no managed-host gate to pin, and the absence is
  // the point: there is nothing running to reach or to start.
  check('the fixture carries no agy host address and no agy managed-host gate, because agy has neither',
    Object.keys(probeEnvironment).every((name) => !/AGY|ANTIGRAVITY/i.test(name)),
    Object.keys(probeEnvironment).filter((name) => /AGY|ANTIGRAVITY/i.test(name)).join(',') || '(none)');

  // ── Registered for EVERY broker ───────────────────────────────────────────
  //
  // Two lists, and they must never disagree: the runtime registry is what
  // `/api/agents` serves, and `shippedAdapters()` is what doctor diagnoses and
  // what the service environment derives managed hosts from. A newly added
  // adapter in one and not the other ships diagnosed but unregistered, or
  // registered but undiagnosed.
  const shipped = shippedAdapters().map((adapter) => adapter.id);
  check('agy is on the shipped-adapter list, exactly once',
    shipped.filter((id) => id === 'agy').length === 1, shipped.join(','));
  const doctorIds = defaultDoctorAdapters({}).map((adapter) => adapter.id);
  check('doctor diagnoses agy, with no flag set', doctorIds.includes('agy'), doctorIds.join(','));
  // An adapter on the shipped list with no `diagnoseSetup` does not degrade
  // quietly: `diagnoseAgents` synthesizes a hard failure whose remediation tells
  // the operator to install a build that does not exist.
  const agyShipped = shippedAdapters().find((adapter) => adapter.id === 'agy');
  check('...and can actually answer, rather than being failed as undiagnosable',
    typeof agyShipped?.diagnoseSetup === 'function', String(typeof agyShipped?.diagnoseSetup));

  const { legacy, floor14, floor15, current, older, noncanonical } = await withBroker(async (base) => ({
    legacy: await agentRows(base),
    floor14: await agentRows(base, String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE)),
    floor15: await agentRows(base, String(CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE)),
    current: await agentRows(base, String(BROKER_CONTRACT_REVISION)),
    older: await agentRows(base, String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE - 1)),
    // Every spelling `Number()` would have read as a revision. Each is a client
    // whose encoding this broker does not recognize, and the filter must read
    // them all as the OLDEST client rather than acting on the claim.
    noncanonical: await Promise.all(
      ['not-a-number', '', '0xF', '1e2', ' 17 ', '+17', '017', 'Infinity']
        .map(async (raw) => [raw, await agentRows(base, raw)] as const),
    ),
  }));
  const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((row) => String(row.id));

  // ── Served to every client that can decode the row — which is all of them ─
  const views: Array<readonly [string, Array<Record<string, unknown>>]> = [
    ['declares nothing', legacy],
    ['one below the integration-kind tolerance', older],
    ['at the integration-kind tolerance', floor14],
    ['at the attach-mode tolerance', floor15],
    ['current with this broker', current],
  ];
  const missing = views.filter(([, rows]) => !idsOf(rows).includes('agy')).map(([label]) => label);
  check('EVERY client view is served the agy row, including one that declares nothing',
    missing.length === 0, missing.join(' | ') || idsOf(legacy).join(','));
  const duplicated = views.filter(([, rows]) => rows.filter((row) => String(row.id) === 'agy').length !== 1);
  check('...exactly one agy row in each, never a duplicate registration',
    duplicated.length === 0, duplicated.map(([label]) => label).join(','));
  const leaked = noncanonical.filter(([, rows]) => !idsOf(rows).includes('agy')).map(([raw]) => raw);
  check('a non-canonical revision spelling is read as the oldest client and STILL served agy',
    leaked.length === 0, leaked.map((raw) => JSON.stringify(raw)).join(','));
  check('the established agents are served alongside it',
    ['opencode', 'pi', 'codex', 'claude'].every((id) => idsOf(legacy).includes(id)),
    idsOf(legacy).join(','));

  const row = current.find((entry) => String(entry.id) === 'agy');
  check('the served row names the product, not the command',
    row?.displayName === 'Antigravity', String(row?.displayName));

  // ── What the served row claims, read off the WIRE ─────────────────────────
  //
  // On the wire and not on the in-process capabilities object: the wire is what
  // a client decodes, and only the wire can prove the broker did not reshape it
  // on the way out.
  const capabilities = row?.capabilities as Record<string, unknown> | undefined;
  check('the served row reports the sdk-callback integration kind',
    capabilities?.integrationKind === 'sdk-callback', JSON.stringify(capabilities?.integrationKind));
  check('the served row advertises observe FIRST and resume second, and no live attach',
    JSON.stringify(capabilities?.attachModes) === '["observe","resume"]'
      && capabilities?.supportsObserve === true
      && capabilities?.supportsResume === true
      && capabilities?.supportsLiveAttach === false,
    JSON.stringify(capabilities));
  // Q14, and the reason it is asserted on the wire: the field is OPTIONAL and
  // defaults to false, so an adapter that stays silent is never offered the
  // join and every observer reads "observing" forever. Its absence WAS two
  // shipped defects.
  check('the served row declares cross-client Drive sharing explicitly, not by omission',
    capabilities?.supportsCrossClientDriveSharing === true,
    JSON.stringify(capabilities?.supportsCrossClientDriveSharing));
  check('the served row carries the reviewed posture: per-tool approvals, model switch, no file input, no artifact signal',
    capabilities?.permissionGranularity === 'per-tool'
      && capabilities?.supportsModelSwitch === true
      && capabilities?.supportsNativeFileInput === false
      && capabilities?.supportsNativeArtifact === false,
    JSON.stringify(capabilities));
  // P0/P1 build no create, no rename, no fork, no clone and no export, and the
  // row must say so rather than offering a button that throws. These are derived
  // from HOOK PRESENCE in `runtime.ts`, so this asserts which hooks exist.
  check('the served row offers NO write-class action, because the adapter defines none of those hooks',
    row?.canCreateSession === false
      && row?.canSelectModelAtCreation === false
      && row?.canRenameNative === false
      && row?.canFork === false
      && row?.canClone === false
      && row?.canTranscriptExport === false,
    JSON.stringify(row));

  // ── The evidence for carrying NO minimum revision ─────────────────────────
  //
  // Serving the row to everyone is only correct while every value in it predates
  // both decode tolerances. Adding a newer attach mode or integration kind
  // without also declaring a floor would hand an old client a row it cannot
  // parse, costing it the WHOLE roster — and it fails HERE rather than in the
  // field.
  const publishedModes = (capabilities?.attachModes as unknown[] ?? []).map(String);
  const needingTolerance = publishedModes.filter(
    (mode) => !ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode as never));
  check('every attach mode agy publishes predates the attach-mode tolerance',
    publishedModes.length > 0 && needingTolerance.length === 0,
    `published=${publishedModes.join(',')} needing-tolerance=${needingTolerance.join(',')}`);
  check('...and the adapter therefore declares no minimum client revision at all',
    agyShipped?.minimumClientRevision === undefined, String(agyShipped?.minimumClientRevision));

  // ── No managed host, stated rather than left to be noticed ────────────────
  //
  // There is no daemon: nothing listens between invocations, so there is no host
  // for the installed service to start, supervise or stop. The durable service
  // environment is a closed enumerated list, and agy must not appear in it.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment activates no managed agy host, because agy has none',
    !serviceEnvironment.includes(managedHostGateEnv('agy'))
      && !serviceEnvironment.some((name) => /AGY|ANTIGRAVITY/i.test(name)),
    serviceEnvironment.join(','));
  check('...and the adapter declares no external host to manage',
    agyShipped?.integration?.externalHost === undefined,
    JSON.stringify(agyShipped?.integration?.externalHost));

  // ── The declared modes and the honoured modes are the SAME set ────────────
  {
    const adapter = adapterWithBinary();
    const declared = [...AGY_CAPABILITIES.attachModes];
    const honoured: string[] = [];
    for (const mode of declared) {
      const refusal = await attachRefused(adapter, mode);
      if (refusal === undefined) honoured.push(mode);
    }
    check('every DECLARED attach mode is honoured by attach',
      honoured.length === declared.length, `declared=${declared.join(',')} honoured=${honoured.join(',')}`);
    // `live` is the mode agy does not have — no daemon, nothing to join — and it
    // must refuse loudly rather than hand back something weaker under that name.
    const liveRefusal = await attachRefused(adapter, 'live');
    check('an UNDECLARED mode is refused loudly, never silently downgraded',
      liveRefusal !== undefined && /not available/i.test(liveRefusal), String(liveRefusal));
    const nonsenseRefusal = await attachRefused(adapter, 'drive');
    check('...as is a mode that is not an attach mode at all', nonsenseRefusal !== undefined, String(nonsenseRefusal));
  }

  // ── An observe attach spawns nothing ─────────────────────────────────────
  {
    const adapter = adapterWithBinary();
    const connection = await adapter.attach(LIVE, 'observe');
    connection.subscribe(() => {});
    const history = await connection.getHistory();
    await connection.close();
    check('an observe attach replays the transcript',
      history.length > 0, `${history.length} rows`);
    check('...and spawns NO child: nothing invoked the binary',
      fake.argv() === undefined, JSON.stringify(fake.argv()));
    check('...and never registers as a driver, so every roster row still reads observing',
      adapter.isDriving(LIVE) === false && adapter.driveConnection(LIVE) === undefined);
  }

  // ── A bare attach is observe, and is never promoted to drive ─────────────
  //
  // `attachModes` is observe-FIRST, so bare MEANS observe — a cost decision as
  // much as a safety one. What must never happen is the silent promotion: a
  // client handed write authority it did not ask for, on a session nothing told
  // the other clients was being driven.
  {
    const adapter = adapterWithBinary();
    const bare = await adapter.attach(LIVE);
    check('a bare attach yields an OBSERVE connection, not a Drive one',
      !(bare instanceof AgyDriveConnection) && bare.info.attachMode === 'observe',
      String(bare.info.attachMode));
    check('...it claims no drive authority in its own snapshot',
      bare.info.control?.drive?.state !== 'driving', JSON.stringify(bare.info.control?.drive));
    check('...the adapter registry records no driver for it',
      adapter.isDriving(LIVE) === false && adapter.driveConnection(LIVE) === undefined);
    // Read-only by construction, not merely by posture: the observe connection
    // refuses the write outright rather than accepting it and dropping it.
    let sendRefused = false;
    try {
      await bare.sendPrompt({ text: 'this must not reach a child' });
    } catch {
      sendRefused = true;
    }
    check('...and a prompt on it is REFUSED rather than silently swallowed', sendRefused);
    check('...still with no child spawned', fake.argv() === undefined, JSON.stringify(fake.argv()));
    await bare.close();
  }

  // ── A resume attach is a drive — and still spawns nothing until a prompt ──
  {
    const adapter = adapterWithBinary();
    const drive = await adapter.attach(LIVE, 'resume');
    check('a resume attach yields a Drive connection that claims the session',
      drive instanceof AgyDriveConnection
        && adapter.driveConnection(LIVE) === drive
        && adapter.isDriving(LIVE) === true,
      JSON.stringify(drive.info.control?.drive));
    check('...whose OWN snapshot reports driving, so a joining client sees the posture',
      drive.info.control?.drive?.state === 'driving' && drive.info.attachMode === 'resume',
      JSON.stringify(drive.info.control?.drive));
    check('...and which STILL spawns nothing on attach: the child starts on the first prompt',
      fake.argv() === undefined, JSON.stringify(fake.argv()));
    await drive.close();
    check('...and closing it deregisters the drive',
      adapter.isDriving(LIVE) === false && adapter.driveConnection(LIVE) === undefined);
  }

  // ── Refusing a drive this machine cannot deliver ─────────────────────────
  //
  // A normal attach refusal, not a crash: handing back a Drive that can never
  // spawn would fail on the first prompt, after the client had been told it was
  // driving.
  {
    const adapter = adapterWithoutBinary();
    const observeOk = await attachRefused(adapter, 'observe');
    check('with no `agy` on PATH an OBSERVE attach still works — reading a transcript needs no binary',
      observeOk === undefined, String(observeOk));
    const resumeRefusal = await attachRefused(adapter, 'resume');
    check('...while a RESUME attach refuses, naming the missing command',
      resumeRefusal !== undefined && /not on PATH/i.test(resumeRefusal), String(resumeRefusal));
    check('...and no half-built drive is left registered behind the refusal',
      adapter.isDriving(LIVE) === false && adapter.driveConnection(LIVE) === undefined);
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  tree.cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
