#!/usr/bin/env bun
/** Kilo Code floor-gated full-sync shipment and managed-host gate. */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKER_CONTRACT_REVISION } from '@cosyncing/protocol';
import { KILO_CAPABILITIES, KiloAdapter } from '../../../adapters/kilocode/src/index.ts';
import { diagnoseKiloSetup } from '../../../adapters/kilocode/src/diagnostics.ts';
import { kiloDatabasePaths } from '../../../adapters/kilocode/src/store.ts';
import { buildKiloFixtureTree, KILO_FIXTURE_SESSION_ID } from '../../../adapters/kilocode/test/fixtures/database.ts';
import { captureProcessOutput, isolatedBrokerFixtureEnvironment, startHealthyFixtureBroker } from '../helpers/isolated-broker-fixture.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { brokerServiceEnvironmentEntries, serviceAgentDataPathOverrides } from '../../src/installation/service-manager.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-gate-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-gate-home-'));
const tree = buildKiloFixtureTree();
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
        cwd: ROOT,
        env: isolatedBrokerFixtureEnvironment(fixtureRoot, { overrides: {
          HOST: '127.0.0.1', PORT: String(port), COSYNCING_HOME: home,
          KILO_DATA_DIR: tree.dataRoot, COSYNCING_KILO_BIN: 'missing-kilo-fixture-command',
          COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_CLAUDE_HOOKS: '0',
        } }),
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
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
  const kilo = shipped.find((adapter) => adapter.id === 'kilo');
  check('Kilo Code is shipped and diagnosed exactly once',
    shipped.filter((adapter) => adapter.id === 'kilo').length === 1
      && defaultDoctorAdapters({}).filter((adapter) => adapter.id === 'kilo').length === 1
      && typeof kilo?.diagnoseSetup === 'function',
    shipped.map((adapter) => adapter.id).join(','));

  const views = await withBroker(async (base) => ({
    legacy: await agents(base),
    current: await agents(base, String(BROKER_CONTRACT_REVISION)),
  }));
  check('Kilo Code needs no client revision floor and every client receives one row',
    views.legacy.filter((row) => row.id === 'kilo').length === 1
      && views.current.filter((row) => row.id === 'kilo').length === 1
      && kilo?.minimumClientRevision === undefined);
  const current = views.current.find((row) => row.id === 'kilo');
  check('the published Kilo Code row declares the exact shipped full-sync capability data',
    JSON.stringify(current?.capabilities) === JSON.stringify(KILO_CAPABILITIES)
      && current?.canCreateSession === false,
    JSON.stringify(current));

  const enBehavior = setupMessages('en').agentBehavior('kilo');
  const zhBehavior = setupMessages('zh-Hans').agentBehavior('kilo');
  check('setup states exact authenticated Drive and dedicated managed-host ownership in both locales',
    /authenticated Create\/Drive/.test(enBehavior) && /loopback port 4097/.test(enBehavior)
      && /经认证的创建和控制/.test(zhBehavior) && /4097/.test(zhBehavior),
    `${enBehavior} | ${zhBehavior}`);
  for (const language of ['en', 'zh-Hans'] as const) {
    const body = setupMessages(language).managedRuntimeBody('cosyncing');
    check(`the managed-runtime consent names the Kilo host (${language})`,
      /Kilo/.test(body), body);
  }
  const dbOnlySummaries = agentSummaries({
    minimumVersions: [{
      agent: 'kilo', displayName: 'Kilo Code', version: '7.4.23',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    }],
    sections: [{
      id: 'agents', title: 'Agents', checks: [
        { id: 'kilo.binary', status: 'warn', detailCode: 'binary-missing', summary: 'missing' },
        { id: 'kilo.version', status: 'skip', detailCode: 'version-unavailable', summary: 'unavailable' },
        { id: 'kilo.storage', status: 'pass', detailCode: 'storage-readable', summary: 'readable' },
      ],
    }],
  } as never).filter((entry) => entry.id === 'kilo');
  const dbOnlySummary = dbOnlySummaries[0];
  check('setup treats a readable DB-only Kilo installation as supported Observe-only',
    dbOnlySummaries.length === 1 && dbOnlySummary?.state === 'supported', JSON.stringify(dbOnlySummaries));

  const serviceEntries = Object.fromEntries(brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home', stateHome: '/fixture/state', cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing', webDir: '/fixture/web',
    agentExecutableOverrides: { COSYNCING_KILO_BIN: '/fixture/bin/kilo' },
    agentDataPathOverrides: serviceAgentDataPathOverrides({
      env: { KILO_DATA_DIR: '/fixture/kilo-data' },
      piAgentDir: '/fixture/pi', ompAgentDir: '/fixture/omp',
      piSessionsRoot: '/fixture/pi/sessions', ompSessionsRoot: '/fixture/omp/sessions',
    }),
  }));
  check('service persists explicit Kilo paths and authorizes its declared managed host',
    serviceEntries.COSYNCING_KILO_BIN === '/fixture/bin/kilo'
      && serviceEntries.KILO_DATA_DIR === '/fixture/kilo-data'
      && serviceEntries[managedHostGateEnv('kilo')] === '1'
      && kilo?.integration?.externalHost?.managed === true,
    JSON.stringify(serviceEntries));

  const boundedRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-diagnosis-bound-'));
  try {
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(boundedRoot, `unrelated-${String(index).padStart(3, '0')}`), '');
    }
    writeFileSync(join(boundedRoot, 'kilo.db'), '');
    const realContext = createSetupDiagnosisContext({
      env: { KILO_DATA_DIR: boundedRoot, COSYNCING_KILO_BIN: 'missing-kilo-fixture-command', PATH: '' },
      homeDir: home,
    });
    const diagnosis = await diagnoseKiloSetup(realContext);
    const storage = diagnosis.checks.find((entry) => entry.id === 'kilo.storage');
    check('real doctor and discovery both refuse a root beyond the shared 256-entry bound',
      kiloDatabasePaths(boundedRoot).length === 0
        && storage?.detailCode === 'storage-database-missing',
      JSON.stringify(storage));
  } finally { rmSync(boundedRoot, { recursive: true, force: true }); }

  const linkedRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-diagnosis-link-'));
  try {
    const linkedParent = join(linkedRoot, 'linked-parent');
    symlinkSync(tree.root, linkedParent, 'dir');
    const configuredRoot = join(linkedParent, 'data');
    const realContext = createSetupDiagnosisContext({
      env: { KILO_DATA_DIR: configuredRoot, COSYNCING_KILO_BIN: 'missing-kilo-fixture-command', PATH: '' },
      homeDir: home,
    });
    const diagnosis = await diagnoseKiloSetup(realContext);
    const storage = diagnosis.checks.find((entry) => entry.id === 'kilo.storage');
    check('real doctor and discovery both refuse an intermediate data-root symlink',
      (await new KiloAdapter({ command: 'missing-kilo-fixture-command', env: {
        PATH: '', KILO_DATA_DIR: configuredRoot,
      } }).discoverSessions()).length === 0
        && storage?.detailCode === 'storage-unsafe-component',
      JSON.stringify(storage));
  } finally { rmSync(linkedRoot, { recursive: true, force: true }); }

  const adapter = new KiloAdapter({
    command: 'missing-kilo-fixture-command', env: { PATH: '', KILO_DATA_DIR: tree.dataRoot },
  });
  check('existing local SQLite makes Kilo available without starting a serve', await adapter.isAvailable());
  check('Kilo Create is registered but dynamically false without exact binary and managed health',
    typeof adapter.createSession === 'function' && await adapter.canCreateSession() === false);
  const bare = await adapter.attach(KILO_FIXTURE_SESSION_ID);
  let bareWriteRefused = false;
  try { await bare.sendPrompt({ text: 'must refuse' }); } catch { bareWriteRefused = true; }
  check('bare attach means Observe and never infers writer authority',
    bare.info.attachMode === 'observe'
      && (await bare.getHistory()).some((message) => message.type === 'user-message')
      && bareWriteRefused);
  await bare.close();
  const observe = await adapter.attach(KILO_FIXTURE_SESSION_ID, 'observe');
  let writeRefused = false;
  try { await observe.sendPrompt({ text: 'must refuse' }); } catch { writeRefused = true; }
  check('explicit Observe replays and refuses writes',
    (await observe.getHistory()).some((message) => message.type === 'user-message') && writeRefused);
  await observe.close();
  let resumeRefused = false;
  try { await adapter.attach(KILO_FIXTURE_SESSION_ID, 'resume'); } catch { resumeRefused = true; }
  check('undeclared Resume is refused rather than downgraded', resumeRefused);

  const row = (await adapter.discoverSessions())[0];
  check('disk discovery publishes native id, display-only model/agent, and no terminal hint',
    row?.nativeId === KILO_FIXTURE_SESSION_ID
      && row.currentModel?.providerID === 'vllm-fixture'
      && row.currentAgent === 'code'
      && row.terminalSyncHint === undefined,
    JSON.stringify(row));
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
