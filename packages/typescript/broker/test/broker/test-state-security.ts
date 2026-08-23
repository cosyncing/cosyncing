#!/usr/bin/env bun
/** Configuration, credential, migration, lock, backup, and Pi auth-scope acceptance. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  captureProcessOutput,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { parseQrPairingPayload } from '../../../crypto/src/index.ts';
import { verificationEnvironment } from '../../../../../scripts/verification/verification-graph.ts';
import {
  insideSupervisedProcessGroup,
  runSupervised,
} from '../../../../../scripts/verification/supervised-process.ts';
import {
  BROKER_CONFIG_SCHEMA_VERSION,
  BROKER_LISTEN_HOST,
  brokerInternalUrl,
  defaultBrokerConfig,
  inspectBrokerConfig,
  migrateBrokerConfigV1,
  planRepoEraConfigurationMigration,
  resolveBrokerConfiguration,
  validateBrokerConfig,
  writeBrokerConfig,
} from '../../src/runtime/configuration.ts';
import {
  ensureInstallationCredentials,
  inspectBrokerToken,
  inspectPiIntegration,
  readBrokerToken,
  readPiIntegration,
  resolveRuntimeCredentials,
} from '../../src/security/credentials.ts';
import {
  applyDurableStateMigrations,
  backupDurableStores,
  DURABLE_SCHEMA_REGISTRY,
  durableStateLayout,
  inspectDurableSchemas,
  planDurableStateMigrations,
  purgeDataInventory,
} from '../../src/security/durable-state.ts';
import {
  acquireInstallationLock,
  InstallationLockError,
  installationLockPath,
} from '../../src/installation/installation-lock.ts';
import {
  committedInstallState,
  inspectInstallState,
  writeInstallState,
} from '../../src/installation/install-state.ts';
import {
  atomicWriteOwnerOnly,
  ownerOnlyMode,
} from '../../src/security/secure-files.ts';
import { writeSetupState } from '../../src/installation/setup-state.ts';
import { PI_BRIDGE_EMBEDDED_SOURCE } from '../../../adapters/pi/src/bridge-asset.ts';
import { ArtifactStore } from '../../src/artifacts/artifact-store.ts';
import {
  inspectBrokerInstance,
  loadOrCreateBrokerInstanceId,
} from '../../src/runtime/broker-instance.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const CLEAN_ENV = verificationEnvironment();
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, condition: unknown, detail?: string): void {
  const ok = !!condition;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fixtureConfig(port = 7734, advertisedUrl?: string) {
  return {
    ...defaultBrokerConfig(),
    ownerExtension: { preserved: true },
    broker: {
      ...defaultBrokerConfig().broker,
      port,
      internalUrl: `http://127.0.0.1:${port}`,
      ...(advertisedUrl ? { advertisedUrl } : {}),
      nestedExtension: 'keep-me',
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other work is slow, not broken. The fixed
// 15s here lost that bet under load and reported it as a connection refusal.
const waitHealth = (
  child: { exitCode: number | null; exited: Promise<number> },
  base: string,
): Promise<void> => waitForBrokerHealth(child, `${base}/api/health`);

const root = mkdtempSync(join(tmpdir(), 'cosyncing-state-security-'));
try {
  // First-start identity is a single durable winner even when several foreground/source processes race.
  {
    const home = join(root, 'broker-instance-race');
    const workers = Array.from({ length: 12 }, () => Bun.spawn([
      'bun',
      'run',
      'packages/typescript/broker/test/fixtures/create-broker-instance.ts',
      home,
    ], {
      cwd: ROOT,
      env: CLEAN_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
    }));
    const outcomes = await Promise.all(workers.map(async (worker) => ({
      exitCode: await worker.exited,
      stdout: (await new Response(worker.stdout).text()).trim(),
      stderr: (await new Response(worker.stderr).text()).trim(),
    })));
    const persisted = inspectBrokerInstance(home);
    check('concurrent first starts all adopt one exclusively created broker instance identity',
      outcomes.every((outcome) => outcome.exitCode === 0 && outcome.stdout === outcomes[0]?.stdout)
        && persisted.status === 'ok'
        && persisted.state.instanceId === outcomes[0]?.stdout,
      outcomes.find((outcome) => outcome.exitCode !== 0)?.stderr);
  }

  // Configuration schema, validation, additive preservation, and environment precedence.
  {
    const home = join(root, 'config-home');
    const written = writeBrokerConfig(fixtureConfig() as any, home);
    const inspected = inspectBrokerConfig(home);
    check('config writes schema v2 through an owner-only atomic boundary',
      written.schemaVersion === BROKER_CONFIG_SCHEMA_VERSION && inspected.status === 'ok' &&
        ownerOnlyMode(join(home, 'config.json')) === 0o600 && ownerOnlyMode(home) === 0o700);
    check('unknown additive config fields survive validation and a read/write cycle',
      inspected.status === 'ok' && (inspected.config.ownerExtension as any)?.preserved === true &&
        inspected.config.broker.nestedExtension === 'keep-me');
    const persisted = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as any;
    check('persisted config omits every listener and advertised URL field',
      persisted.schemaVersion === 2
        && persisted.broker.host === undefined
        && persisted.broker.internalUrl === undefined
        && persisted.broker.advertisedUrl === undefined);

    const source = resolveBrokerConfiguration({
      packaged: false,
      home,
      env: {
        HOST: '127.0.0.1',
        PORT: '8844',
        COSYNCING_MACHINE: 'fixture-machine',
        COSYNCING_BROKER: 'http://127.0.0.1:8844',
        COSYNCING_ADVERTISED_BROKER: 'https://fixture.tailnet.example',
        COSYNCING_UPDATE_CHANNEL: 'beta',
      },
    });
    check('source runtime ignores removed listener variables and derives loopback from PORT',
      source.config.broker.port === 8844 && source.config.broker.machineLabel === 'fixture-machine' &&
        source.config.broker.internalUrl === 'http://127.0.0.1:8844' &&
        source.config.broker.host === BROKER_LISTEN_HOST &&
        source.config.broker.advertisedUrl === undefined &&
        source.source.internalUrl === 'derived'
        && !source.environmentOverrides.includes('HOST')
        && !source.environmentOverrides.includes('COSYNCING_BROKER')
        && !source.environmentOverrides.includes('COSYNCING_ADVERTISED_BROKER'));

    const packaged = resolveBrokerConfiguration({
      packaged: true,
      home,
      env: { HOST: '0.0.0.0', PORT: '9999', COSYNCING_BROKER: 'http://127.0.0.1:9999' },
    });
    check('packaged runtime ignores repo-era host, port, and broker URL overrides',
      packaged.config.broker.port === 7734 && packaged.config.broker.host === '127.0.0.1' &&
        packaged.config.broker.internalUrl === 'http://127.0.0.1:7734' && packaged.environmentOverrides.length === 0);

    const featureConfig = validateBrokerConfig({
      ...fixtureConfig(),
      features: {
        httpWorkspaceBrowsing: true,
        httpTranscriptExport: true,
        futureFeature: 'preserved',
      },
    });
    check('schema v2 accepts local HTTP feature enablement for packaged brokers',
      featureConfig.features?.httpWorkspaceBrowsing === true
        && featureConfig.features?.httpTranscriptExport === true
        && featureConfig.features?.futureFeature === 'preserved');

    assert.throws(() => validateBrokerConfig({ ...fixtureConfig(), broker: { ...fixtureConfig().broker, port: 0 } }));
    assert.throws(() => validateBrokerConfig({ ...fixtureConfig(), update: { channel: 'surprise' } }));
    assert.throws(() => validateBrokerConfig({
      ...fixtureConfig(),
      features: { httpWorkspaceBrowsing: 'yes' },
    }));
    const reserved = validateBrokerConfig({
      ...fixtureConfig(),
      broker: {
        ...fixtureConfig().broker,
        host: '0.0.0.0',
        internalUrl: 'http://10.0.0.1:7734',
        advertisedUrl: 'http://remote.example',
      },
    });
    check('removed persisted fields cannot alter the loopback listener',
      reserved.broker.host === BROKER_LISTEN_HOST
        && reserved.broker.internalUrl === brokerInternalUrl(reserved.broker.port)
        && reserved.broker.advertisedUrl === undefined);
    check('invalid port and update channel still fail closed', true);

    const legacyHome = join(root, 'legacy-config-home');
    mkdirSync(legacyHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      ownerExtension: { preserved: true },
      broker: {
        host: '0.0.0.0',
        port: 8844,
        machineLabel: 'legacy-machine',
        internalUrl: 'http://127.0.0.1:8844',
        advertisedUrl: 'https://legacy.example.com',
        nestedExtension: 'keep-me',
      },
      update: { channel: 'beta' },
    }), { mode: 0o600 });
    const legacyInspection = inspectBrokerConfig(legacyHome);
    check('v1 inspection derives loopback while preserving non-reserved fields',
      legacyInspection.status === 'ok'
        && legacyInspection.migratedFrom === 1
        && legacyInspection.previousHost === '0.0.0.0'
        && legacyInspection.config.broker.port === 8844
        && legacyInspection.config.broker.nestedExtension === 'keep-me'
        && (legacyInspection.config.ownerExtension as any)?.preserved === true);
    const legacyArtifactRoot = join(root, 'legacy-config-artifacts');
    const legacyArtifactStore = new ArtifactStore('https://legacy.example.com', legacyArtifactRoot);
    const legacyArtifactSession = { tool: 'codex', id: 'before-setup' };
    const legacyArtifact = legacyArtifactStore.putBytes(
      legacyArtifactSession,
      { type: 'file-artifact', path: 'before-setup.txt', name: 'before-setup.txt', mimeType: 'text/plain' },
      Buffer.from('available after setup'),
    ) as Extract<import('@cosyncing/protocol').AgentMessage, { type: 'file-artifact' }>;
    const migration = migrateBrokerConfigV1(legacyHome);
    const migrated = JSON.parse(readFileSync(join(legacyHome, 'config.json'), 'utf8')) as any;
    check('v1 migration backs up and transactionally writes schema v2',
      migration.migrated && migration.backupPath != null && existsSync(migration.backupPath)
        && migrated.schemaVersion === 2 && migrated.broker.port === 8844
        && migrated.broker.host === undefined && migrated.broker.internalUrl === undefined
        && migrated.broker.advertisedUrl === undefined);
    const instance = inspectBrokerInstance(legacyHome);
    const stableArtifactStore = instance.status === 'ok'
      ? new ArtifactStore(`broker-instance:${instance.state.instanceId}`, legacyArtifactRoot, {
          legacyBrokerSources: instance.state.legacyArtifactBrokerSources,
        })
      : undefined;
    const stableReference = stableArtifactStore?.toReference(legacyArtifactSession, legacyArtifact) as
      | Extract<import('@cosyncing/protocol').AgentMessage, { type: 'file-artifact' }>
      | undefined;
    const stableUrl = stableReference?.fetchUrl
      ? new URL(stableReference.fetchUrl, 'http://127.0.0.1:8844')
      : undefined;
    const stableResponse = stableArtifactStore && stableUrl
      ? stableArtifactStore.serve(
          legacyArtifactSession.tool,
          legacyArtifactSession.id,
          String(stableReference?.artifactKey),
          stableUrl.searchParams.get('expires'),
          stableUrl.searchParams.get('sig'),
        )
      : undefined;
    check('config v1 migration preserves legacy artifact sources before removing their URLs',
      instance.status === 'ok'
        && instance.state.legacyArtifactBrokerSources?.includes('https://legacy.example.com/')
        && stableResponse?.status === 200
        && await stableResponse.text() === 'available after setup');

    writeFileSync(join(home, 'config.json'), '{bad json', { mode: 0o600 });
    check('malformed config is visible instead of silently defaulting', inspectBrokerConfig(home).status === 'error');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ broker: {} }), { mode: 0o600 });
    const unversioned = inspectBrokerConfig(home);
    check('unversioned config is an explicit migration case',
      unversioned.status === 'error' && unversioned.problem === 'migration-required');
  }

  // Repo-era detection is read-only and never relays the embedded token value.
  {
    const leaked = 'legacy-token-that-must-never-be-copied-or-printed';
    const plan = planRepoEraConfigurationMigration({
      COSYNCING_BROKER: 'http://127.0.0.1:9922',
      COSYNCING_TOKEN: leaked,
    });
    const rendered = JSON.stringify(plan);
    check('repo-era migration plan requires confirmation and rotates rather than copies the shared token',
      plan?.requiresConfirmation === true && plan.findings.legacySharedToken === true &&
        plan.actions.some((action) => action.kind === 'generate-new-broker-token') && !rendered.includes(leaked));
  }

  // The foreground CLI reports a stable malformed-config code before constructing a listener.
  {
    const home = join(root, 'malformed-cli-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{ malformed', { mode: 0o600 });
    console.log('STAGE malformed-config-cli start (deadline 15000ms)');
    const child = await runSupervised(
      ['bun', 'run', 'packages/typescript/broker/src/cli/cli.ts', 'broker', '--dev-bypass-first-run'],
      {
      cwd: ROOT,
      env: { ...CLEAN_ENV, HOME: home, COSYNCING_HOME: home, COSYNCING_CACHE_DIR: join(home, 'cache') },
        timeoutMs: 15_000,
        maxBufferBytes: 1 << 20,
        isolateProcessGroup: !insideSupervisedProcessGroup(),
      },
    );
    console.log(
      `STAGE malformed-config-cli done exit=${child.exitCode} timedOut=${child.timedOut} strays=${child.strays}`,
    );
    check('CLI surfaces malformed configuration with a stable redacted error before broker startup',
      !child.timedOut && !child.strays && child.exitCode === 1
        && child.stderr.includes('config-malformed-json')
        && !child.stdout.includes('{ malformed'));
  }

  // Owner-only shared and Pi-scoped credentials, idempotence, URL update, and rotation.
  {
    const home = join(root, 'credential-home');
    const first = ensureInstallationCredentials({ home, internalUrl: 'http://127.0.0.1:7734' });
    const second = ensureInstallationCredentials({ home, internalUrl: 'http://127.0.0.1:7734' });
    check('first credential setup creates separate random broker and Pi credentials',
      first.brokerToken !== first.piIntegration.credential && first.brokerToken.length >= 43 &&
        inspectBrokerToken(join(home, 'secrets', 'broker-token')).status === 'ok' &&
        inspectPiIntegration(join(home, 'secrets', 'pi-integration.json')).status === 'ok');
    check('credential files and secret directory are owner-only',
      ownerOnlyMode(join(home, 'secrets')) === 0o700 &&
        ownerOnlyMode(join(home, 'secrets', 'broker-token')) === 0o600 &&
        ownerOnlyMode(join(home, 'secrets', 'pi-integration.json')) === 0o600);
    check('repeated setup is idempotent for credential material',
      second.brokerToken === first.brokerToken && second.piIntegration.credential === first.piIntegration.credential);

    const moved = ensureInstallationCredentials({ home, internalUrl: 'http://127.0.0.1:8844' });
    check('internal URL drift atomically updates the Pi record without stranding or rotating it',
      moved.piIntegration.internalUrl === 'http://127.0.0.1:8844' &&
        moved.piIntegration.credential === first.piIntegration.credential);
    const rotated = ensureInstallationCredentials({
      home,
      internalUrl: 'http://127.0.0.1:8844',
      rotateBrokerToken: true,
    });
    check('explicit broker-token rotation mints fresh material without changing the Pi scope',
      rotated.brokerToken !== first.brokerToken &&
        rotated.piIntegration.credential === first.piIntegration.credential);

    const runtime = resolveRuntimeCredentials({
      packaged: true,
      home,
      internalUrl: 'http://127.0.0.1:8844',
      env: {},
    });
    check('packaged runtime resolves both credentials only from owner-only files',
      runtime.brokerTokenSource === 'file' && runtime.piIntegrationSource === 'file' &&
        runtime.brokerToken === readBrokerToken(join(home, 'secrets', 'broker-token')) &&
        runtime.piInternalUrl === readPiIntegration(join(home, 'secrets', 'pi-integration.json')).internalUrl);
  }

  // Cross-command lock: mutual exclusion, safe release, stale-PID proof, and symlink refusal.
  {
    const home = join(root, 'lock-home');
    const first = acquireInstallationLock({ command: 'setup', home });
    assert.throws(() => acquireInstallationLock({ command: 'repair', home }), (error: unknown) =>
      error instanceof InstallationLockError && error.reason === 'busy');
    first.release();
    check('installation lock serializes mutations and releases idempotently', !existsSync(first.path));
    first.release();

    const stalePath = installationLockPath(home);
    writeFileSync(stalePath, JSON.stringify({
      schemaVersion: 1,
      pid: 99_999_999,
      nonce: 'abcdefghijklmnopqrstuv',
      command: 'upgrade',
      acquiredAt: '2026-07-17T00:00:00.000Z',
    }), { mode: 0o600 });
    const recovered = acquireInstallationLock({ command: 'repair', home });
    check('stale lock recovery occurs only after a parseable dead PID is proven',
      recovered.recoveredStaleLock && readdirSync(home).some((name) => name.includes('.stale-99999999-')));
    recovered.release();

    const victim = join(root, 'lock-victim');
    writeFileSync(victim, 'do not touch');
    symlinkSync(victim, stalePath);
    assert.throws(() => acquireInstallationLock({ command: 'uninstall', home }), InstallationLockError);
    check('symlinked installation lock is rejected without touching its target', readFileSync(victim, 'utf8') === 'do not touch');
    rmSync(stalePath);
  }

  // Schema inventory, setup/install version stamps, full-store backup, and purge enumeration.
  {
    const stateRoot = join(root, 'state-layout');
    const cacheRoot = join(root, 'cache-layout');
    const layout = durableStateLayout({ stateRoot, cacheRoot });
    writeBrokerConfig(fixtureConfig() as any, stateRoot);
    loadOrCreateBrokerInstanceId(stateRoot);
    writeSetupState({ preserved: { future: true }, agents: { codex: false } }, stateRoot);
    writeInstallState(committedInstallState('2026-07-17T00:00:00.000Z'), stateRoot);
    atomicWriteOwnerOnly(layout.schedules, `${JSON.stringify({ version: 1, schedules: [{ id: 's1', text: 'FULL PRIVATE PROMPT' }] })}\n`);
    atomicWriteOwnerOnly(layout.attention, `${JSON.stringify({ version: 1, events: [], observations: [], clientStates: [], deliveries: [], nextCursor: 1, prunedThroughCursor: 0 })}\n`);
    atomicWriteOwnerOnly(layout.peers, `${JSON.stringify({ version: 1, peers: [] })}\n`);
    atomicWriteOwnerOnly(join(layout.transportKeys, 'broker.json'), '{"private":"key-material"}\n');
    atomicWriteOwnerOnly(layout.artifactIndex, `${JSON.stringify({ version: 1, records: [] })}\n`);
    atomicWriteOwnerOnly(join(layout.artifactBlobs, 'aa', 'blob'), 'artifact bytes');
    atomicWriteOwnerOnly(layout.artifactUrlSecret, 'artifact-secret');

    const schema = inspectDurableSchemas(layout);
    check('all eight durable JSON stores have explicit current schema records',
      DURABLE_SCHEMA_REGISTRY.length === 8 && schema.every((item) => item.status === 'ok'));
    const validBrokerInstance = readFileSync(layout.brokerInstance, 'utf8');
    atomicWriteOwnerOnly(layout.brokerInstance, '{"version":1,"instanceId":"invalid"}\n');
    const malformedInstance = inspectDurableSchemas(layout)
      .find((inspection) => inspection.id === 'broker-instance');
    check('durable inspection gives malformed broker identity a dedicated doctor code',
      malformedInstance?.status === 'malformed'
        && malformedInstance.detailCode === 'broker-instance-malformed');
    atomicWriteOwnerOnly(layout.brokerInstance, validBrokerInstance);
    check('install state carries ownership and migration journals from its first committed record',
      inspectInstallState(stateRoot).committed &&
        Array.isArray((inspectInstallState(stateRoot) as any).state.resources) &&
        Array.isArray((inspectInstallState(stateRoot) as any).state.migrations));

    const legacyHome = join(root, 'legacy-install-record');
    const legacyRecord = committedInstallState('2026-07-16T00:00:00.000Z') as any;
    delete legacyRecord.resources;
    delete legacyRecord.migrations;
    legacyRecord.futureField = { preserved: true };
    atomicWriteOwnerOnly(join(legacyHome, 'install-state.json'), `${JSON.stringify(legacyRecord)}\n`);
    const legacyInspection = inspectInstallState(legacyHome);
    check('legacy schema-v1 install receipts retain the first-run commit and gain empty additive journals',
      legacyInspection.committed && legacyInspection.state.resources.length === 0 &&
        legacyInspection.state.migrations.length === 0 &&
        (legacyInspection.state.futureField as any)?.preserved === true);

    const backup = backupDurableStores({
      purpose: 'schema-migration',
      stateRoot,
      cacheRoot,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });
    const scheduleCopy = join(backup.path, 'state', 'schedules.json');
    check('migration backup includes private schedules, peers, keys, attention, and artifact cache',
      readFileSync(scheduleCopy, 'utf8').includes('FULL PRIVATE PROMPT') &&
        existsSync(join(backup.path, 'state', 'broker-instance.json')) &&
        existsSync(join(backup.path, 'state', 'transport-peers.json')) &&
        existsSync(join(backup.path, 'state', 'transport-keys', 'broker.json')) &&
        existsSync(join(backup.path, 'cache', 'artifacts', 'blobs', 'aa', 'blob')) &&
        backup.manifest.stateRootIncluded && backup.manifest.cacheRootIncluded);
    check('backup manifest is owner-only and exposes only logical source labels',
      ownerOnlyMode(join(backup.path, 'manifest.json')) === 0o600 &&
        backup.manifest.entries.every((entry) => !entry.source.startsWith('/')));
    const purge = purgeDataInventory(layout);
    check('purge inventory names both durable roots while normal uninstall can preserve them',
      purge.length === 2 && purge[0]?.path === stateRoot && purge[1]?.path === cacheRoot);
  }

  // Explicit schema migration: displayed plan, confirmation, cross-command lock, full backup, preservation.
  {
    const stateRoot = join(root, 'migration-state');
    const cacheRoot = join(root, 'migration-cache');
    const layout = durableStateLayout({ stateRoot, cacheRoot });
    atomicWriteOwnerOnly(layout.setup, `${JSON.stringify({ agents: { codex: false }, futureField: { keep: 7 } })}\n`);
    atomicWriteOwnerOnly(layout.schedules, `${JSON.stringify({ version: 1, schedules: [{ id: 'private', text: 'MIGRATION PRIVATE PROMPT' }] })}\n`);
    const plan = planDurableStateMigrations(layout);
    assert.throws(() => applyDurableStateMigrations({ plan, confirmed: false, stateRoot, cacheRoot }));
    const result = applyDurableStateMigrations({
      plan,
      confirmed: true,
      stateRoot,
      cacheRoot,
      now: () => new Date('2026-07-17T13:00:00.000Z'),
    });
    const migrated = JSON.parse(readFileSync(layout.setup, 'utf8'));
    const backedUp = result.backupPath
      ? JSON.parse(readFileSync(join(result.backupPath, 'state', 'setup-state.json'), 'utf8'))
      : undefined;
    check('schema migration requires confirmation, takes a backup, and preserves additive fields',
      plan.steps.length === 1 && result.applied[0] === 'setup-state-v0-to-v1' &&
        migrated.schemaVersion === 1 && migrated.futureField?.keep === 7 &&
        backedUp?.schemaVersion === undefined && backedUp?.futureField?.keep === 7);
    check('schema migration is idempotent after the v1 stamp', planDurableStateMigrations(layout).steps.length === 0);
  }

  // Atomic replacement leaves a complete old or new document even with abandoned temp files.
  {
    const home = join(root, 'atomic-home');
    const target = join(home, 'state.json');
    atomicWriteOwnerOnly(target, '{"generation":1}\n');
    writeFileSync(`${target}.tmp-abandoned`, '{truncated');
    atomicWriteOwnerOnly(target, `${JSON.stringify({ generation: 2, payload: 'x'.repeat(100_000) })}\n`);
    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    check('interrupted-write debris cannot truncate the atomically replaced durable file',
      parsed.generation === 2 && parsed.payload.length === 100_000);

    const guarded = join(home, 'guarded.json');
    atomicWriteOwnerOnly(guarded, '{"generation":1}\n');
    assert.throws(() => atomicWriteOwnerOnly(guarded, '{"generation":2}\n', {
      beforeReplace: () => { throw new Error('fixture final precondition changed'); },
    }), /fixture final precondition changed/);
    const guardedTemps = readdirSync(home).filter((entry) => entry.startsWith('guarded.json.tmp-'));
    check('a failed final atomic-write precondition preserves the target and removes proposed temporary bytes',
      readFileSync(guarded, 'utf8') === '{"generation":1}\n' && guardedTemps.length === 0,
      guardedTemps.join(','));

    const victim = join(root, 'secret-victim');
    writeFileSync(victim, 'preserve');
    rmSync(target);
    symlinkSync(victim, target);
    assert.throws(() => atomicWriteOwnerOnly(target, 'replacement'));
    check('atomic secret write rejects a symlink leaf without modifying its referent', readFileSync(victim, 'utf8') === 'preserve');
  }

  // The packaged Pi bytes have no shared-token or fixed-URL fields in extension configuration.
  check('embedded Pi bridge reads the scoped integration file and contains no shared-token fallback',
    PI_BRIDGE_EMBEDDED_SOURCE.includes('.cosyncing') &&
      PI_BRIDGE_EMBEDDED_SOURCE.includes('x-cosyncing-integration-token') &&
      !PI_BRIDGE_EMBEDDED_SOURCE.includes('process.env.COSYNCING_TOKEN') &&
      !PI_BRIDGE_EMBEDDED_SOURCE.includes('CONFIG.token') &&
      !PI_BRIDGE_EMBEDDED_SOURCE.includes('CONFIG.broker'));

  // Real broker route-scope and advertised QR acceptance, using files rather than token arguments/env.
  {
    const home = join(root, 'broker-home');
    const cache = join(root, 'broker-cache');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const advertised = 'https://fixture-machine.tailnet.example';
    writeBrokerConfig(fixtureConfig(port, advertised) as any, home);
    const credentials = ensureInstallationCredentials({ home, internalUrl: base });
    writeFileSync(join(home, 'transport-peers.json'), '{ malformed peer state', { mode: 0o600 });
    const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
      cwd: ROOT,
      env: {
        ...CLEAN_ENV,
        HOME: home,
        COSYNCING_HOME: home,
        COSYNCING_CACHE_DIR: cache,
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_PI_BRIDGE_AUTOINSTALL: '0',
        COSYNCING_CODEX_SYNC_SERVER: '0',
        COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Unbounded: the assertion below is that a credential appears NOWHERE in
    // the broker's output, so a tail would only prove it is absent from the
    // end. This used to read the streams after the kill, which meant nothing
    // drained them while the broker was starting.
    const brokerOutput = captureProcessOutput(child, { maxChars: Infinity });
    try {
      await waitHealth(child, base).catch((error: Error) => {
        throw new Error(`${error.message}\n${brokerOutput.read().trim().slice(-2000)}`);
      });
      const integrationHeader = { 'x-cosyncing-integration-token': credentials.piIntegration.credential };
      const sharedHeader = { 'x-cosyncing-token': credentials.brokerToken };
      const piAllowed = await fetch(`${base}/pi/bridge/status?id=missing`, { headers: integrationHeader });
      const piMissing = await fetch(`${base}/pi/bridge/status?id=missing`);
      const piWrongHeader = await fetch(`${base}/pi/bridge/status?id=missing`, {
        headers: { 'x-cosyncing-token': credentials.piIntegration.credential },
      });
      const unrelated = await fetch(`${base}/api/machines`, { headers: integrationHeader });
      check('Pi integration credential authenticates its exact bridge route family',
        piAllowed.status === 200 && piMissing.status === 401 && piWrongHeader.status === 401);
      check('Pi integration credential cannot authenticate roster or other broker APIs', unrelated.status === 401);

      const healthResponse = await fetch(`${base}/api/broker/health`, { headers: sharedHeader });
      const health = await healthResponse.json() as any;
      check('broker health surfaces malformed security state with stable codes and no local paths',
        healthResponse.status === 200 && health.status === 'critical' &&
          health.components?.['security-state']?.detailCodes?.includes('peers-malformed') &&
          !JSON.stringify(health).includes(home));

      const pairing = await fetch(`${base}/api/transport/pairings`, {
        method: 'POST',
        headers: { ...sharedHeader, 'content-type': 'application/json' },
        body: JSON.stringify({ clientLabel: 'state-security-fixture', brokerUrl: advertised }),
      });
      const offer = await pairing.json() as any;
      const qr = parseQrPairingPayload(offer.qr);
      check('remote pairing QR uses the one-time requested HTTPS URL, never loopback',
        pairing.status === 201 && qr.transport.kind === 'broker-url' &&
          qr.transport.url === advertised && !offer.qr.includes(credentials.brokerToken));

      const processArgs = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(child.pid)]).stdout.toString();
      check('broker process arguments contain neither shared nor Pi credential',
        !processArgs.includes(credentials.brokerToken) && !processArgs.includes(credentials.piIntegration.credential));
    } finally {
      child.kill('SIGTERM');
      await child.exited.catch(() => undefined);
      // Awaited, not sampled: the readers are separate tasks, so the child's
      // exit does not mean the last chunk has been decoded. Sampling here
      // could let "the credential appears nowhere" pass without having read
      // the end of the log — the one place a shutdown path would print it.
      const logs = await settledProcessOutput(brokerOutput);
      check('broker logs contain neither credential',
        !logs.includes(credentials.brokerToken)
          && !logs.includes(credentials.piIntegration.credential));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} state-security checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} state-security checks`);
