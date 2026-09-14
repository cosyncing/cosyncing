#!/usr/bin/env bun
/** Cline managed-Hub shipment, revision floor, and service-environment gate. */
export {};
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROKER_CONTRACT_REVISION,
  CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE,
} from '@cosyncing/protocol';
import { CLINE_CAPABILITIES, ClineAdapter } from '../../../adapters/cline/src/index.ts';
import {
  CLINE_MINIMUM_SUPPORTED_VERSION,
  CLINE_VERIFIED_VERSION,
} from '../../../adapters/cline/src/store.ts';

/** `3.0.61` -> `3.0.62`: one patch ahead of whatever the pin currently is. */
function bumpPatch(version: string): string {
  return version.replace(/(\d+)(?!.*\d)/, (patch) => String(Number(patch) + 1));
}
import { buildClineFixtureTree } from '../../../adapters/cline/test/fixtures/tree.ts';
import { captureProcessOutput, isolatedBrokerFixtureEnvironment, startHealthyFixtureBroker } from '../helpers/isolated-broker-fixture.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { agentSummaries, inspectSetupEnvironment, setupContextWithOwnedServiceOverrides } from '../../src/installation/setup.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { committedInstallState, writeInstallState } from '../../src/installation/install-state.ts';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { atomicWriteOwnerOnly } from '../../src/security/secure-files.ts';
import {
  brokerServiceEnvironmentEntries,
  serviceAgentConfigurationOverrides,
  serviceAgentDataPathOverrides,
  serviceAgentExecutableOverrides,
} from '../../src/installation/service-manager.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-cline-gate-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-cline-gate-home-'));
const tree = buildClineFixtureTree();
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate fixture port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
function fixtureEnvironment(port: number): NodeJS.ProcessEnv {
  return isolatedBrokerFixtureEnvironment(fixtureRoot, {
    overrides: {
      HOST: '127.0.0.1', PORT: String(port), COSYNCING_HOME: home,
      CLINE_DIR: tree.root, COSYNCING_CLINE_BIN: 'missing-cline-fixture-command',
      COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_CLAUDE_HOOKS: '0',
    },
  });
}
async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const exited = await Promise.race([broker.exited.then(() => true).catch(() => true), Bun.sleep(5_000).then(() => false)]);
  if (!exited && broker.exitCode === null) {
    broker.kill('SIGKILL');
    await broker.exited.catch(() => undefined);
  }
}
async function withBroker<T>(run: (base: string) => Promise<T>): Promise<T> {
  let output!: ReturnType<typeof captureProcessOutput>;
  const started = await startHealthyFixtureBroker({
    reservePort: freePort,
    spawn: (port) => {
      const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
        cwd: ROOT, env: fixtureEnvironment(port), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      output = captureProcessOutput(child, { maxChars: 4_000 });
      return child as unknown as { exitCode: number | null; exited: Promise<number> };
    },
    healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
    capture: () => output,
    stop: (child) => stopBroker(child as unknown as ReturnType<typeof Bun.spawn>),
  });
  try { return await run(`http://127.0.0.1:${started.port}`); }
  finally { await stopBroker(started.child as unknown as ReturnType<typeof Bun.spawn>); }
}
async function agents(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents returned ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

try {
  const shipped = shippedAdapters();
  const cline = shipped.find((adapter) => adapter.id === 'cline');
  check('Cline is shipped and diagnosed exactly once',
    shipped.filter((adapter) => adapter.id === 'cline').length === 1
      && defaultDoctorAdapters({}).filter((adapter) => adapter.id === 'cline').length === 1
      && typeof cline?.diagnoseSetup === 'function',
    shipped.map((adapter) => adapter.id).join(','));

  const views = await withBroker(async (base) => ({
    legacy: await agents(base),
    older: await agents(base, String(CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE - 1)),
    current: await agents(base, String(BROKER_CONTRACT_REVISION)),
    malformed: await agents(base, 'not-a-revision'),
  }));
  check('legacy and pre-floor clients omit Cline without crashing',
    !views.legacy.some((row) => row.id === 'cline')
      && !views.older.some((row) => row.id === 'cline')
      && !views.malformed.some((row) => row.id === 'cline'));
  const currentRows = views.current.filter((row) => row.id === 'cline');
  check('current clients receive one exact Cline capability row',
    currentRows.length === 1
      && JSON.stringify(currentRows[0]?.capabilities) === JSON.stringify(CLINE_CAPABILITIES)
      && currentRows[0]?.supportsCreateSession === true
      && currentRows[0]?.canCreateSession === false,
    JSON.stringify(currentRows));
  check('Cline carries the integration-kind decoder floor',
    cline?.minimumClientRevision === CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE);

  const enBehavior = setupMessages('en').agentBehavior('cline');
  const zhBehavior = setupMessages('zh-Hans').agentBehavior('cline');
  // The rendered copy must state the version constant in BOTH languages, so it
  // cannot silently go stale: written as a literal it kept promising 3.0.60
  // after the pin moved, and this suite printed that stale string in its own
  // PASS line without failing.
  //
  // It is the FLOOR that is named now, not a pinned build, and the two
  // languages place it differently in the sentence -- so assert the parts
  // rather than one phrase. Binding it to the constant is what matters.
  const clineFloorPattern = new RegExp(CLINE_MINIMUM_SUPPORTED_VERSION.replace(/\./g, '\\.'));
  const namesFlooredHub = (copy: string): boolean =>
    /Cline Hub/.test(copy) && clineFloorPattern.test(copy);
  check('setup states managed Drive and credential boundaries in both presenters',
    /Create\/Resume/.test(enBehavior) && /never credentials/.test(enBehavior)
      && namesFlooredHub(enBehavior)
      && namesFlooredHub(zhBehavior) && /创建\/恢复/.test(zhBehavior) && /不读取凭据/.test(zhBehavior),
    `${enBehavior} | ${zhBehavior}`);
  const setupRows = agentSummaries({ minimumVersions: [], sections: [] } as never);
  const setupIds = setupRows.map((entry) => entry.id);
  check('setup preflight lists every integration once, including managed Cline',
    new Set(setupIds).size === setupIds.length
      && setupIds.filter((id) => id === 'cline').length === 1,
    setupIds.join(','));

  const serviceEntries = Object.fromEntries(brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home', stateHome: '/fixture/state', cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing', webDir: '/fixture/web',
    agentExecutableOverrides: { COSYNCING_CLINE_BIN: '/fixture/bin/cline' },
    agentDataPathOverrides: serviceAgentDataPathOverrides({
      env: {
        CLINE_DIR: '/fixture/cline', CLINE_DATA_DIR: '/fixture/cline-data',
        COSYNCING_CLINE_PROFILE_DIR: '/fixture/cline-managed',
      },
      piAgentDir: '/fixture/pi', ompAgentDir: '/fixture/omp',
      piSessionsRoot: '/fixture/pi/sessions', ompSessionsRoot: '/fixture/omp/sessions',
    }),
    agentConfigurationOverrides: serviceAgentConfigurationOverrides({
      COSYNCING_CLINE_PROVIDER: 'openai-compatible',
      COSYNCING_CLINE_MODEL: 'fixture-model',
      COSYNCING_CLINE_HUB_PORT: '25464',
    }),
  }));
  check('service persists Cline paths/model selection and enables the managed-host gate',
    serviceEntries.COSYNCING_CLINE_BIN === '/fixture/bin/cline'
      && serviceEntries.CLINE_DIR === '/fixture/cline'
      && serviceEntries.CLINE_DATA_DIR === '/fixture/cline-data'
      && serviceEntries.COSYNCING_CLINE_PROFILE_DIR === '/fixture/cline-managed'
      && serviceEntries.COSYNCING_CLINE_PROVIDER === 'openai-compatible'
      && serviceEntries.COSYNCING_CLINE_MODEL === 'fixture-model'
      && serviceEntries.COSYNCING_CLINE_HUB_PORT === '25464'
      && serviceEntries[managedHostGateEnv('cline')] === '1'
      && cline?.integration?.externalHost?.managed === true,
    JSON.stringify(serviceEntries));

  const upgradeHome = join(home, 'upgrade-preservation');
  const exactCline = join(upgradeHome, 'tools', 'cline-3.0.60', '.cline');
  const serviceEnvironmentPath = join(upgradeHome, 'service', 'broker.env');
  mkdirSync(join(upgradeHome, 'tools', 'cline-3.0.60'), { recursive: true });
  writeFileSync(exactCline, `#!/bin/sh\nprintf "${CLINE_VERIFIED_VERSION}\\n"\n`, { mode: 0o755 });
  const priorEnvironment = [
    `COSYNCING_CLINE_BIN="${exactCline}"`,
    'COSYNCING_CLINE_PROVIDER="openai-compatible"',
    'COSYNCING_CLINE_MODEL="fixture-model"',
    '',
  ].join('\n');
  atomicWriteOwnerOnly(serviceEnvironmentPath, priorEnvironment, { mode: 0o600 });
  const priorState = committedInstallState();
  priorState.resources.push({
    id: 'service-environment',
    kind: 'environment-file',
    target: serviceEnvironmentPath,
    ownership: {
      proof: 'package-hash',
      installedSha256: createHash('sha256').update(priorEnvironment).digest('hex'),
    },
  });
  const bareContext = createSetupDiagnosisContext({
    env: { HOME: home, PATH: '' },
    homeDir: home,
  });
  const preservedContext = setupContextWithOwnedServiceOverrides(
    bareContext,
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: priorState },
    upgradeHome,
  );
  const preservedDescriptor = await new ClineAdapter({
    env: preservedContext.env,
    homeDir: home,
  }).describeManagedHost();
  check('repeat setup retains the receipt-owned exact Cline executable and non-secret model selection',
    serviceAgentExecutableOverrides(preservedContext).COSYNCING_CLINE_BIN === exactCline
      && serviceAgentConfigurationOverrides(preservedContext.env).COSYNCING_CLINE_PROVIDER === 'openai-compatible'
      && serviceAgentConfigurationOverrides(preservedContext.env).COSYNCING_CLINE_MODEL === 'fixture-model'
      && preservedDescriptor.launch?.command === exactCline,
    JSON.stringify({
      executable: serviceAgentExecutableOverrides(preservedContext).COSYNCING_CLINE_BIN,
      configuration: serviceAgentConfigurationOverrides(preservedContext.env),
      launch: preservedDescriptor.launch?.command,
    }));
  const explicitlyCleared = setupContextWithOwnedServiceOverrides(
    { ...bareContext, env: { ...bareContext.env, COSYNCING_CLINE_MODEL: '' } },
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: priorState },
    upgradeHome,
  );
  check('an explicit empty setup input clears the Cline selection atomically',
    Object.prototype.hasOwnProperty.call(explicitlyCleared.env, 'COSYNCING_CLINE_MODEL')
      && explicitlyCleared.env.COSYNCING_CLINE_MODEL === ''
      && explicitlyCleared.env.COSYNCING_CLINE_PROVIDER === undefined);
  const providerOnly = setupContextWithOwnedServiceOverrides(
    { ...bareContext, env: { ...bareContext.env, COSYNCING_CLINE_PROVIDER: 'openrouter' } },
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: priorState },
    upgradeHome,
  );
  const modelOnly = setupContextWithOwnedServiceOverrides(
    { ...bareContext, env: { ...bareContext.env, COSYNCING_CLINE_MODEL: 'replacement-model' } },
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: priorState },
    upgradeHome,
  );
  check('provider-only or model-only input never mixes with the retained Cline selection',
    providerOnly.env.COSYNCING_CLINE_PROVIDER === 'openrouter'
      && providerOnly.env.COSYNCING_CLINE_MODEL === undefined
      && modelOnly.env.COSYNCING_CLINE_MODEL === 'replacement-model'
      && modelOnly.env.COSYNCING_CLINE_PROVIDER === undefined);
  const alternateEnvironmentPath = join(upgradeHome, 'service', 'alternate.env');
  atomicWriteOwnerOnly(alternateEnvironmentPath, priorEnvironment, { mode: 0o600 });
  const wrongTargetState = structuredClone(priorState);
  const wrongTargetResource = wrongTargetState.resources.find((resource) => resource.id === 'service-environment')!;
  wrongTargetResource.target = alternateEnvironmentPath;
  const wrongTargetContext = setupContextWithOwnedServiceOverrides(
    bareContext,
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: wrongTargetState },
    upgradeHome,
  );
  check('a hash-matching noncanonical environment file cannot supply retained authority',
    wrongTargetContext.env.COSYNCING_CLINE_BIN === undefined
      && wrongTargetContext.env.COSYNCING_CLINE_PROVIDER === undefined
      && wrongTargetContext.env.COSYNCING_CLINE_MODEL === undefined);
  writeInstallState(priorState, upgradeHome);
  // Replaced in place by the shape a real package-manager update produces: one
  // patch AHEAD of the pin. Derived rather than written as a literal — when the
  // pin last moved, this line had become the pinned version itself and the test
  // silently stopped proving that an in-place swap is blocked. A prerelease
  // suffix would derive correctly but parse below the pin, modelling a
  // downgrade instead of the upgrade that actually strands installations.
  writeFileSync(
    exactCline,
    `#!/bin/sh\nprintf "${bumpPatch(CLINE_VERIFIED_VERSION)}\\n"\n`,
    { mode: 0o755 },
  );
  const staleInspection = await inspectSetupEnvironment({
    buildInfo: BUILD_INFO,
    executablePath: join(ROOT, 'packages', 'typescript', 'broker', 'src', 'main.ts'),
    home: upgradeHome,
    context: bareContext,
  });
  check('repeat setup blocks when the retained exact Cline path was replaced in place',
    staleInspection.blockingIssues.some((issue) => issue.code === 'cline-retained-executable-unavailable'),
    staleInspection.blockingIssues.map((issue) => issue.code).join(','));
  writeFileSync(serviceEnvironmentPath, `${priorEnvironment}# drift\n`, { mode: 0o600 });
  const driftedContext = setupContextWithOwnedServiceOverrides(
    bareContext,
    { committed: true, path: join(upgradeHome, 'install-state.json'), state: priorState },
    upgradeHome,
  );
  check('edited service environment cannot supply retained Cline authority',
    driftedContext.env.COSYNCING_CLINE_BIN === undefined
      && driftedContext.env.COSYNCING_CLINE_PROVIDER === undefined
      && driftedContext.env.COSYNCING_CLINE_MODEL === undefined);

  const adapter = new ClineAdapter({
    command: 'missing-cline-fixture-command', env: { PATH: '', CLINE_DIR: tree.root }, processAlive: () => false,
  });
  check('existing local snapshots make Cline available without launching a process', await adapter.isAvailable());
  check('shipped Cline exposes Create but stays dynamically false without the owned Hub/config',
    typeof adapter.createSession === 'function' && !await adapter.canCreateSession());
  const bareObserve = await adapter.attach(tree.id);
  let writeRefused = false;
  try { await bareObserve.sendPrompt({ text: 'must refuse' }); } catch { writeRefused = true; }
  check('bare background attach means Observe, replays history, and refuses writes',
    bareObserve.info.control?.drive.state === 'observing'
      && (await bareObserve.getHistory()).some((message) => message.type === 'user-message')
      && writeRefused);
  await bareObserve.close();
  const observe = await adapter.attach(tree.id, 'observe');
  check('explicit Observe remains accepted', observe.info.control?.drive.state === 'observing');
  await observe.close();
  let resumeRefused = false;
  try { await adapter.attach(tree.id, 'resume'); } catch { resumeRefused = true; }
  check('Resume refuses instead of downgrading when the managed writer is unavailable', resumeRefused);

  const rows = await adapter.discoverSessions();
  const parent = rows.find((row) => row.id === tree.id);
  const child = rows.find((row) => row.id === tree.childId);
  check('parent handoff is separate-process while child exposes native parent linkage',
    parent?.terminalSyncHint?.command.includes(`--id '${tree.id}'`) === true
      && parent.control?.terminalSync.syncAvailable === false
      && child?.nativeId === tree.childId
      && child.parentThreadId === tree.id
      && child.terminalSyncHint === undefined,
    JSON.stringify(rows));
} catch (error) {
  check('registration harness completed', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  tree.cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
