#!/usr/bin/env bun
/** Grok registration, client-floor, service-path, and attach-contract gate. */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE,
  BROKER_CONTRACT_REVISION,
} from '@cosyncing/protocol';
import {
  GROK_CAPABILITIES,
  GROK_MINIMUM_SUPPORTED_VERSION,
  GrokAdapter,
  GrokDriveConnection,
} from '../../../adapters/grok/src/index.ts';
import {
  buildGrokFixtureTree,
  writeFakeGrokBinary,
} from '../../../adapters/grok/test/fixtures/tree.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import {
  brokerServiceEnvironmentEntries,
  serviceAgentDataPathOverrides,
} from '../../src/installation/service-manager.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-grok-gate-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-grok-gate-home-'));
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
  if (!address || typeof address === 'string') throw new Error('could not allocate a fixture port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fixtureEnvironment(port: number): NodeJS.ProcessEnv {
  return isolatedBrokerFixtureEnvironment(fixtureRoot, {
    overrides: {
      HOST: '127.0.0.1',
      PORT: String(port),
      COSYNCING_HOME: home,
      GROK_HOME: join(fixtureRoot, 'grok-home'),
      COSYNCING_RESTART_DRY_RUN: '1',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CLAUDE_HOOKS: '0',
    },
  });
}

async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const exited = await Promise.race([
    broker.exited.then(() => true).catch(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
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
        env: fixtureEnvironment(port),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      output = captureProcessOutput(child, { maxChars: 4_000 });
      return child as unknown as { exitCode: number | null; exited: Promise<number> };
    },
    healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
    capture: () => output,
    stop: (child) => stopBroker(child as unknown as ReturnType<typeof Bun.spawn>),
  });
  try {
    return await run(`http://127.0.0.1:${started.port}`);
  } finally {
    await stopBroker(started.child as unknown as ReturnType<typeof Bun.spawn>);
  }
}

async function agents(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents returned ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

const tree = buildGrokFixtureTree();
try {
  const shipped = shippedAdapters().map((adapter) => adapter.id);
  const shippedGrok = shippedAdapters().find((adapter) => adapter.id === 'grok');
  check('Grok is shipped exactly once', shipped.filter((id) => id === 'grok').length === 1, shipped.join(','));
  check('doctor diagnoses the same unconditional Grok adapter',
    defaultDoctorAdapters({}).some((adapter) => adapter.id === 'grok'));
  check('the shipped Grok adapter owns its setup diagnosis', typeof shippedGrok?.diagnoseSetup === 'function');

  const views = await withBroker(async (base) => ({
    legacy: await agents(base),
    current: await agents(base, String(BROKER_CONTRACT_REVISION)),
    malformed: await agents(base, 'not-a-revision'),
  }));
  for (const [name, rows] of Object.entries(views)) {
    check(`${name} clients receive exactly one Grok row`,
      rows.filter((row) => row.id === 'grok').length === 1,
      rows.map((row) => String(row.id)).join(','));
  }
  const row = views.current.find((entry) => entry.id === 'grok');
  check('the broker serves the declared Grok capabilities unchanged',
    JSON.stringify(row?.capabilities) === JSON.stringify(GROK_CAPABILITIES),
    JSON.stringify(row?.capabilities));
  check('Grok needs no client floor because both wire values are old-decodable',
    shippedGrok?.minimumClientRevision === undefined
      && GROK_CAPABILITIES.integrationKind === 'acp-stdio'
      && GROK_CAPABILITIES.attachModes.every((mode) =>
        ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode)),
    JSON.stringify(GROK_CAPABILITIES));

  const enBehavior = setupMessages('en').agentBehavior('grok');
  const zhBehavior = setupMessages('zh-Hans').agentBehavior('grok');
  check('setup explains floor-gated Create/Resume and preserved state in both presenters',
    /Create\/Resume/.test(enBehavior) && /创建和恢复/.test(zhBehavior) && /保留 Grok 数据/.test(zhBehavior),
    `${enBehavior} | ${zhBehavior}`);
  const unmeasuredSummary = agentSummaries({
    minimumVersions: [{
      agent: 'grok', displayName: 'Grok Build', version: GROK_MINIMUM_SUPPORTED_VERSION,
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    }],
    sections: [{
      id: 'agents',
      title: 'Agents',
      checks: [
        { id: 'grok.binary', status: 'pass', detailCode: 'binary-found', summary: 'found' },
        {
          id: 'grok.version',
          status: 'warn',
          detailCode: 'version-unverified-observe-only',
          summary: 'unmeasured but Observe-only',
        },
      ],
    }],
  } as never).find((entry) => entry.id === 'grok');
  check('setup treats an unmeasured installed Grok version as supported Observe-only',
    unmeasuredSummary?.state === 'supported', JSON.stringify(unmeasuredSummary));
  const serviceEntries = Object.fromEntries(brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
    agentExecutableOverrides: { COSYNCING_GROK_BIN: '/fixture/bin/grok' },
    agentDataPathOverrides: serviceAgentDataPathOverrides({
      env: { GROK_HOME: '/fixture/grok-home' },
      piAgentDir: '/fixture/pi',
      ompAgentDir: '/fixture/omp',
      piSessionsRoot: '/fixture/pi/sessions',
      ompSessionsRoot: '/fixture/omp/sessions',
    }),
  }));
  check('the service persists Grok executable and store overrides without a managed-host gate',
    serviceEntries.COSYNCING_GROK_BIN === '/fixture/bin/grok'
      && serviceEntries.GROK_HOME === '/fixture/grok-home'
      && serviceEntries[managedHostGateEnv('grok')] === undefined
      && shippedGrok?.integration?.externalHost === undefined,
    JSON.stringify(serviceEntries));

  const fakeSessionId = '019f9d70-e38e-7591-9a24-74a06ad89479';
  const fake = writeFakeGrokBinary(join(tree.root, 'bin'), tree.root, GROK_MINIMUM_SUPPORTED_VERSION, fakeSessionId);
  const adapter = new GrokAdapter({ command: fake.path, env: fake.env, requestTimeoutMs: 2_000 });
  const bare = await adapter.attach(tree.id);
  check('bare attach is Observe and starts no child', bare.info.attachMode === 'observe' && fake.spawnCount() === 0);
  let bareWriteRejected = false;
  try { await bare.sendPrompt({ text: 'must refuse' }); } catch { bareWriteRejected = true; }
  check('bare Observe refuses writes', bareWriteRejected);
  await bare.close();
  let undeclaredRefused = false;
  try { await adapter.attach(tree.id, 'live'); } catch { undeclaredRefused = true; }
  check('an undeclared attach mode is refused instead of downgraded', undeclaredRefused);

  const created = await adapter.createSession({
    directory: tree.cwd,
    model: { providerID: 'xai', modelID: 'grok-4.6', reasoningEffort: 'high' },
  });
  check('create trusts only the durable store identity and grants Resume eligibility',
    created.id === fakeSessionId
      && created.nativeId === fakeSessionId
      && created.cwd === tree.cwd
      && created.control?.drive.supported === true,
    JSON.stringify(created));
  const observeEligible = await adapter.attach(created.id, 'observe');
  check('explicit Observe stays read-only even when the roster offers Resume',
    observeEligible.info.attachMode === 'observe' && fake.spawnCount() === 1);
  await observeEligible.close();

  const resume = await adapter.attach(created.id, 'resume');
  check('Resume grants Drive without starting its lazy child',
    resume instanceof GrokDriveConnection
      && resume.info.control?.drive.state === 'driving'
      && fake.spawnCount() === 1);
  const commands = await resume.listCommands?.();
  check('command discovery starts one child and session/loads the exact durable id',
    fake.spawnCount() === 2
      && commands?.some((command) => command.name === 'compact') === true
      && fake.events().some((event) => event.kind === 'frame'
        && (event.frame as { method?: unknown } | undefined)?.method === 'session/load'),
    JSON.stringify({ commands, events: fake.events() }));
  let duplicateRefused = false;
  try { await adapter.attach(created.id, 'resume'); } catch { duplicateRefused = true; }
  check('a second writer is refused and must join the existing broker connection',
    duplicateRefused && adapter.driveConnection(created.id) === resume);
  await resume.sendPrompt({
    text: 'registration prompt',
  });
  check('registration advertises the physically verified model and permission controls',
    GROK_CAPABILITIES.supportsModelSwitch === true
      && GROK_CAPABILITIES.permissionGranularity === 'per-tool'
      && fake.spawnCount() === 2,
    JSON.stringify({ capabilities: GROK_CAPABILITIES, info: resume.info }));
  check('the terminal hint targets the native id but labels handoff as non-sync',
    resume.info.terminalSyncHint?.command.includes(`--resume '${created.id}'`) === true
      && resume.info.control?.terminalSync.syncAvailable === false,
    JSON.stringify(resume.info.terminalSyncHint));
  await resume.close();

  const futureFake = writeFakeGrokBinary(join(tree.root, 'future-bin'), tree.root, '0.2.115');
  const future = new GrokAdapter({ command: futureFake.path, env: futureFake.env });
  const futureRows = await future.discoverSessions();
  check('an unmeasured Grok version remains Observe-only',
    !await future.canCreateSession()
      && futureRows.some((row) => row.id === tree.id)
      && futureRows.some((row) => row.id === created.id)
      && futureRows.every((row) => row.control?.drive.state === 'observing'
        && row.control.drive.supported === false),
    JSON.stringify(futureRows));
  const absent = new GrokAdapter({ command: 'missing-grok-command', env: { PATH: '', GROK_HOME: tree.root } });
  check(`missing Grok cannot create; Drive still requires ${GROK_MINIMUM_SUPPORTED_VERSION} or newer`,
    !await absent.isAvailable() && !await absent.canCreateSession());
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
