#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  parseWindowsActiveInstallManifest,
  parseWindowsServiceEnvironment,
  windowsActiveInstallManifest,
  windowsServiceEnvironment,
  windowsServiceInstallPaths,
  windowsServiceVersionKey,
} from '../../src/installation/windows-service-install.ts';
import {
  classifyWindowsScheduledTask,
  classifyWindowsTaskFolders,
  WINDOWS_SHARED_FOLDER_RESOURCE_ID,
  WINDOWS_SID_FOLDER_RESOURCE_ID,
  windowsTaskSchedulerReceiptOwnership,
  windowsTaskSchedulerCanonicalSddl,
  windowsTaskSchedulerSddl,
  windowsScheduledTaskIdentity,
  type WindowsScheduledTaskDefinition,
} from '../../src/installation/windows-task-scheduler.ts';
import {
  NativeWindowsTaskSchedulerExecutor,
  WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE,
  WindowsTaskSchedulerPowerShellBackend,
  type WindowsTaskSchedulerExecutor,
  type WindowsTaskSchedulerOperation,
  type WindowsTaskSchedulerSpawn,
} from '../../src/installation/windows-task-scheduler-powershell.ts';
import {
  WindowsTaskSchedulerServiceProvider,
  windowsFilesystemReceiptMatches,
  windowsPriorVersionReceiptTarget,
} from '../../src/installation/windows-task-scheduler-provider.ts';
import type { InstalledResourceRecord } from '../../src/installation/install-state.ts';
import {
  brokerServiceEnvironmentEntries,
  createDurableServiceProvider,
  durableServiceProviderId,
  SERVICE_RESOURCE_IDS,
} from '../../src/installation/service-manager.ts';
import {
  BROKER_CONFIG_SCHEMA_VERSION,
  BROKER_LISTEN_HOST,
  brokerConfigPath,
  brokerInternalUrl,
  inspectBrokerConfig,
  resolveBrokerConfiguration,
  writeBrokerConfig,
} from '../../src/runtime/configuration.ts';
import { embeddedRuntimeAsset } from '../../src/runtime/runtime-assets.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

{
  const paths = windowsServiceInstallPaths('C:\\Users\\Fixture\\.cosyncing', '0.5.0-build_7');
  check('Windows service paths keep one stable bootstrap and one version-scoped application',
    paths.bootstrapPath === 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\service-bootstrap.mjs'
      && paths.activeManifestPath === 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\active-install.json'
      && paths.applicationPath === 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\versions\\0.5.0-build_7\\cosyncing'
      && paths.environmentPath.endsWith('\\0.5.0-build_7\\environment.json'));
}

{
  const build = {
    schemaVersion: 2 as const, version: '0.5.0', commit: 'abc123', dirty: false,
    target: 'bun-windows-x64', buildDate: '2026-08-22T12:00:00.000Z',
    packaged: true, distribution: 'bun-js' as const,
  };
  let oversizedRejected = false;
  try { windowsServiceVersionKey({ ...build, commit: 'a'.repeat(200) }); } catch { oversizedRejected = true; }
  check('Windows version identity is deterministic and rejects truncation collisions',
    windowsServiceVersionKey(build).includes('abc123-clean-bun-windows-x64') && oversizedRejected);
}

{
  const identity = windowsScheduledTaskIdentity('install-018f', 'S-1-5-21-1-2-3-1001');
  const definition: WindowsScheduledTaskDefinition = {
    principalSid: identity.sid,
    runLevel: 'least-privilege',
    logonType: 'interactive-token',
    executable: 'C:\\Tools\\bun.exe',
    arguments: '"C:\\Users\\Fixture\\.cosyncing\\service\\windows\\service-bootstrap.mjs"',
    workingDirectory: 'C:\\Users\\Fixture\\.cosyncing',
    triggers: ['logon-current-user'],
    settings: {
      logonTriggerEnabled: true,
      allowDemandStart: true,
      executionTimeLimit: 'none',
      restartOnFailure: true,
      restartCount: 3,
      restartInterval: 'PT1M',
      multipleInstances: 'ignore-new',
      allowStartOnBattery: true,
      doNotStopOnBattery: true,
      startWhenAvailable: true,
    },
    enabled: true,
  };
  const current = classifyWindowsScheduledTask({
    actual: {
      path: identity.taskPath,
      ownershipMarker: identity.ownershipMarker,
      definition,
      enabled: 'enabled',
      active: 'inactive',
    },
    expectedIdentity: identity,
    expectedDefinition: definition,
  });
  const drifted = classifyWindowsScheduledTask({
    actual: {
      path: identity.taskPath,
      ownershipMarker: identity.ownershipMarker,
      definition: { ...definition, executable: 'C:\\Foreign\\bun.exe' },
      enabled: 'enabled',
      active: 'inactive',
    },
    expectedIdentity: identity,
    expectedDefinition: definition,
  });
  const operationalDrifts: WindowsScheduledTaskDefinition[] = [
    { ...definition, settings: { ...definition.settings, allowDemandStart: false } },
    { ...definition, settings: { ...definition.settings, restartCount: 1 } },
    { ...definition, settings: { ...definition.settings, restartInterval: 'PT1H' } },
    { ...definition, settings: { ...definition.settings, logonTriggerEnabled: false } },
  ];
  const operationalDriftHealth = operationalDrifts.map((candidate) => classifyWindowsScheduledTask({
    actual: {
      path: identity.taskPath,
      ownershipMarker: identity.ownershipMarker,
      definition: candidate,
      enabled: 'enabled',
      active: 'inactive',
    },
    expectedIdentity: identity,
    expectedDefinition: definition,
  }).definition);
  const collision = classifyWindowsScheduledTask({
    actual: {
      path: identity.taskPath,
      ownershipMarker: 'foreign-owner',
      definition,
      enabled: 'enabled',
      active: 'inactive',
    },
    expectedIdentity: identity,
    expectedDefinition: definition,
  });
  check('task ownership remains stable while mutable definition drift stays repairable',
    current.ownership === 'owned' && current.definition === 'current'
      && drifted.ownership === 'owned' && drifted.definition === 'drifted'
      && collision.ownership === 'conflict' && collision.definition === 'unknown');
  check('every written scheduler operational setting participates in exact drift detection',
    operationalDriftHealth.length === 4 && operationalDriftHealth.every((health) => health === 'drifted'),
    operationalDriftHealth.join(','));

  const sddl = windowsTaskSchedulerSddl(identity.sid);
  const shared = { path: '\\Cosyncing', sddl, childFolders: [identity.sid], tasks: [] };
  const ownedFolder = {
    path: identity.sidFolderPath,
    sddl: `${sddl}-drift`,
    childFolders: [],
    tasks: [{ name: 'Broker', ownershipMarker: identity.ownershipMarker }],
  };
  const repairableFolder = classifyWindowsTaskFolders({
    identity,
    expectedSddl: sddl,
    shared,
    sidFolder: ownedFolder,
    sidFolderReceiptOwned: true,
  });
  const blockedFolder = classifyWindowsTaskFolders({
    identity,
    expectedSddl: sddl,
    shared,
    sidFolder: { ...ownedFolder, childFolders: ['Foreign'] },
    sidFolderReceiptOwned: true,
  });
  const incompatibleShared = classifyWindowsTaskFolders({
    identity,
    expectedSddl: sddl,
    shared: { ...shared, sddl: 'D:foreign' },
    sidFolder: ownedFolder,
    sidFolderReceiptOwned: true,
  });
  check('scheduler folders classify shared compatibility, owned drift, and foreign children separately',
    repairableFolder.shared === 'current' && repairableFolder.sidFolder === 'drifted'
      && blockedFolder.sidFolder === 'conflict' && blockedFolder.foreignChildren[0] === 'folder:Foreign'
      && incompatibleShared.shared === 'conflict');
  const canonical = windowsTaskSchedulerCanonicalSddl(identity.sid);
  const canonicalized = classifyWindowsTaskFolders({
    identity, expectedSddl: sddl,
    shared: { ...shared, sddl: canonical },
    sidFolder: { ...ownedFolder, sddl: canonical },
    sidFolderReceiptOwned: true,
  });
  check('scheduler security accepts only the supplied DACL and its exact native owner/group canonical form',
    canonicalized.shared === 'current' && canonicalized.sidFolder === 'current');
}

{
  const identity = windowsScheduledTaskIdentity('install-backend', 'S-1-5-21-1-2-3-1001');
  const definition: WindowsScheduledTaskDefinition = {
    principalSid: identity.sid,
    runLevel: 'least-privilege',
    logonType: 'interactive-token',
    executable: 'C:\\Tools\\bun.exe',
    arguments: '"C:\\State\\service-bootstrap.mjs"',
    workingDirectory: 'C:\\State',
    triggers: ['logon-current-user'],
    settings: {
      logonTriggerEnabled: true,
      allowDemandStart: true,
      executionTimeLimit: 'none',
      restartOnFailure: true,
      restartCount: 3,
      restartInterval: 'PT1M',
      multipleInstances: 'ignore-new',
      allowStartOnBattery: true,
      doNotStopOnBattery: true,
      startWhenAvailable: true,
    },
    enabled: true,
  };
  const operations: Array<{ operation: WindowsTaskSchedulerOperation; input: Readonly<Record<string, unknown>> }> = [];
  const emptySnapshot = {
    currentUserSid: identity.sid,
    shared: undefined,
    sidFolder: undefined,
    task: undefined,
  };
  const executor: WindowsTaskSchedulerExecutor = {
    execute(operation, input) {
      operations.push({ operation, input });
      return emptySnapshot;
    },
  };
  const backend = new WindowsTaskSchedulerPowerShellBackend(executor);
  backend.currentUserSid();
  backend.inspect(identity);
  backend.reconcile({ identity, definition, expectedSddl: windowsTaskSchedulerSddl(identity.sid), sidFolderOwned: false });
  backend.setEnabled(identity, false);
  backend.run(identity);
  backend.stop(identity);
  backend.restore({ identity, snapshot: emptySnapshot });
  backend.uninstall({ identity, sidFolderOwned: true, sharedFolderCreated: false });
  check('Task Scheduler backend exposes fixed typed operations with identity fields supplied internally',
    operations.map((entry) => entry.operation).join(',')
      === 'current-user,inspect,reconcile,set-enabled,run,stop,restore,uninstall'
      && operations.slice(1).every((entry) => entry.input.taskPath === identity.taskPath
        && entry.input.ownershipMarker === identity.ownershipMarker)
      && operations[2]?.input.definition === definition
      && operations[2]?.input.sidFolderOwned === false
      && operations[2]?.input.canonicalSddl === windowsTaskSchedulerCanonicalSddl(identity.sid));

  let malformedRejected = false;
  try {
    new WindowsTaskSchedulerPowerShellBackend({ execute: () => ({ ...emptySnapshot, currentUserSid: 'S-1-5-18' }) })
      .inspect(identity);
  } catch {
    malformedRejected = true;
  }
  check('Task Scheduler backend rejects output for a different Windows identity', malformedRejected);

  const multilineXml = new WindowsTaskSchedulerPowerShellBackend({
    execute: () => ({
      ...emptySnapshot,
      task: {
        path: identity.taskPath,
        enabled: 'enabled',
        active: 'inactive',
        xml: '<Task>\r\n  <Settings/>\r\n</Task>',
      },
    }),
  }).inspect(identity);
  let nulXmlRejected = false;
  try {
    new WindowsTaskSchedulerPowerShellBackend({
      execute: () => ({
        ...emptySnapshot,
        task: { path: identity.taskPath, enabled: 'enabled', active: 'inactive', xml: '<Task>\0</Task>' },
      }),
    }).inspect(identity);
  } catch { nulXmlRejected = true; }
  check('Task Scheduler snapshots admit native multiline XML but reject NUL data',
    multilineXml.task?.xml?.includes('\r\n') === true && nulXmlRejected);

  let nativeCall: Parameters<WindowsTaskSchedulerSpawn> | undefined;
  const native = new NativeWindowsTaskSchedulerExecutor(
    { SystemRoot: 'C:\\Windows', FOREIGN: 'preserved' },
    ((...args: Parameters<WindowsTaskSchedulerSpawn>) => {
      nativeCall = args;
      return { status: 0, stdout: JSON.stringify(emptySnapshot), stderr: '' };
    }) as WindowsTaskSchedulerSpawn,
  );
  native.execute('inspect', { taskPath: identity.taskPath });
  const nativeArgs = nativeCall?.[1] ?? [];
  const nativeOptions = nativeCall?.[2];
  const decodedPayload = nativeOptions?.env.COSYNCING_SCHEDULER_INPUT
    ? JSON.parse(Buffer.from(nativeOptions.env.COSYNCING_SCHEDULER_INPUT, 'base64').toString('utf8'))
    : undefined;
  check('native scheduler invocation is fixed, bounded, hidden, and carries data outside argv',
    nativeCall?.[0] === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      && nativeArgs.join(' ') === '-NoLogo -NoProfile -NonInteractive -Command -'
      && !nativeArgs.join(' ').includes(identity.taskPath)
      && nativeOptions?.input === WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE
      && nativeOptions?.windowsHide === true
      && nativeOptions.timeout === 30_000
      && nativeOptions.maxBuffer === 512 * 1024
      && decodedPayload.taskPath === identity.taskPath);
  check('enable and rollback posture persist through owned definition registration',
    WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE.includes('function Set-OwnedTaskEnabled')
      && WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE.includes('$definition.Settings.Enabled = $enabled')
      && !WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE.includes('$task.Enabled = [bool] $payload.enabled'));
}

{
  const identity = windowsScheduledTaskIdentity('install-receipts', 'S-1-5-21-1-2-3-1001');
  const ownership = windowsTaskSchedulerReceiptOwnership([
    {
      id: WINDOWS_SID_FOLDER_RESOURCE_ID,
      kind: 'other',
      target: identity.sidFolderPath.toLowerCase(),
      ownership: { proof: 'receipt' },
    },
    {
      id: WINDOWS_SHARED_FOLDER_RESOURCE_ID,
      kind: 'other',
      target: '\\Foreign',
      ownership: { proof: 'receipt' },
    },
  ], identity);
  check('scheduler folder authority requires exact receipt id, target, kind, and proof',
    ownership.sidFolderOwned && !ownership.sharedFolderCreated);
}

{
  const paths = windowsServiceInstallPaths('C:\\Users\\Fixture\\.cosyncing', 'version-2');
  const identities: InstalledResourceRecord[] = [
    {
      id: 'service-windows-bootstrap', kind: 'other', target: paths.bootstrapPath,
      ownership: { proof: 'receipt', marker: 'install-fixture' },
    },
    {
      id: 'service-windows-active-install', kind: 'other', target: paths.activeManifestPath,
      ownership: { proof: 'receipt', marker: 'install-fixture' },
    },
    {
      id: 'service-windows-version', kind: 'other', target: paths.versionRoot,
      ownership: { proof: 'receipt', marker: 'version-2' },
    },
    {
      id: 'service-environment', kind: 'environment-file', target: paths.environmentPath,
      ownership: { proof: 'receipt', marker: 'version-2' },
    },
  ];
  const corruptions = (resource: InstalledResourceRecord): InstalledResourceRecord[] => [
    { ...resource, id: `${resource.id}-corrupt` },
    { ...resource, kind: resource.kind === 'other' ? 'binary' : 'other' },
    { ...resource, target: `${resource.target}.foreign` },
    { ...resource, ownership: { ...resource.ownership, proof: 'legacy-marker' } },
    { ...resource, ownership: { ...resource.ownership, marker: `${resource.ownership.marker}-corrupt` } },
  ];
  for (const resource of identities) {
    const expected = {
      id: resource.id, kind: resource.kind, target: resource.target,
      ownership: { proof: resource.ownership.proof, marker: resource.ownership.marker },
    };
    check(`${resource.id} cleanup requires complete receipt identity`,
      windowsFilesystemReceiptMatches([resource], expected)
        && corruptions(resource).every((corrupt) => !windowsFilesystemReceiptMatches([corrupt], expected))
        && !windowsFilesystemReceiptMatches([resource, resource], expected));
  }

  const prior: InstalledResourceRecord = {
    id: 'service-windows-version', kind: 'other',
    target: win32.join(paths.versionsRoot, 'version-1'),
    ownership: { proof: 'receipt', marker: 'version-1' },
  };
  check('prior-version cleanup requires complete receipt identity',
    windowsPriorVersionReceiptTarget([prior], paths.versionsRoot, paths.versionRoot) === win32.resolve(prior.target)
      && corruptions(prior).every((corrupt) => windowsPriorVersionReceiptTarget(
        [corrupt], paths.versionsRoot, paths.versionRoot,
      ) === undefined)
      && windowsPriorVersionReceiptTarget([prior, prior], paths.versionsRoot, paths.versionRoot) === undefined
      && windowsPriorVersionReceiptTarget([
        { ...prior, target: win32.join(paths.versionsRoot, 'other') },
      ], paths.versionsRoot, paths.versionRoot) === undefined);
}

{
  const sid = 'S-1-5-21-1-2-3-1001';
  let filesystemState: 'missing' | 'current' = 'missing';
  let snapshot: Record<string, unknown> = { currentUserSid: sid };
  const operations: WindowsTaskSchedulerOperation[] = [];
  const executor: WindowsTaskSchedulerExecutor = {
    execute(operation, input) {
      operations.push(operation);
      if (operation === 'current-user') return { currentUserSid: sid };
      if (operation === 'reconcile') {
        const definition = structuredClone(input.definition);
        snapshot = {
          currentUserSid: sid,
          shared: {
            path: input.sharedPath, sddl: input.expectedSddl,
            childFolders: [sid], tasks: [],
          },
          sidFolder: {
            path: input.sidFolderPath, sddl: input.expectedSddl,
            childFolders: [], tasks: [{ name: 'Broker', ownershipMarker: input.ownershipMarker }],
          },
          task: {
            path: input.taskPath, ownershipMarker: input.ownershipMarker, definition,
            taskSddl: input.expectedSddl,
            enabled: (definition as WindowsScheduledTaskDefinition).enabled ? 'enabled' : 'disabled',
            active: 'inactive', lastResult: 0, xml: '<Task/>',
          },
        };
      }
      if (operation === 'set-enabled' && snapshot.task) {
        (snapshot.task as Record<string, unknown>).enabled = input.enabled ? 'enabled' : 'disabled';
      }
      if (operation === 'run' && snapshot.task) (snapshot.task as Record<string, unknown>).active = 'active';
      if (operation === 'stop' && snapshot.task) (snapshot.task as Record<string, unknown>).active = 'inactive';
      if (operation === 'uninstall') snapshot = { currentUserSid: sid };
      if (operation === 'restore') snapshot = structuredClone(input.snapshot as Record<string, unknown>);
      return structuredClone(snapshot);
    },
  };
  const provider = new WindowsTaskSchedulerServiceProvider({
    context: { platform: 'win32' } as never,
    homeDir: 'C:\\Users\\Fixture',
    stateHome: 'C:\\Users\\Fixture\\.cosyncing',
    installationId: 'install-provider',
    versionKey: 'version-1',
    cacheRoot: 'C:\\Users\\Fixture\\AppData\\Local\\cosyncing-cache',
    executablePath: 'C:\\Acquisition\\cosyncing',
    acquisitionExecutablePath: 'C:\\Acquisition\\cosyncing',
    distribution: 'bun-js',
    runtimePath: 'C:\\Tools\\bun.exe',
    webDir: 'C:\\Acquisition\\web',
    environmentEntries: [['COSYNCING_HOME', 'C:\\Users\\Fixture\\.cosyncing']],
    backend: new WindowsTaskSchedulerPowerShellBackend(executor),
    environmentState: () => 'current',
    stageFiles: () => { filesystemState = 'current'; },
    filesystemState: () => filesystemState,
  });
  const before = await provider.inspect();
  await provider.installDefinition();
  const installed = await provider.inspect();
  await provider.setEnabled(false);
  const disabled = await provider.inspect();
  await provider.setEnabled(true);
  const reenabled = await provider.inspect();
  const resources = provider.installedResources();
  const captured = await provider.captureTransactionState();
  await provider.start();
  const running = await provider.inspect();
  await provider.restart();
  await provider.uninstall();
  const removed = await provider.inspect();
  await provider.restoreTransactionState(captured);
  const restored = await provider.inspect();
  check('durable Task Scheduler provider maps inspect, install, lifecycle, uninstall, and exact restore',
    before.definition === 'missing' && before.environment === 'current'
      && installed.definition === 'current' && installed.enabled === 'enabled'
      && disabled.enabled === 'disabled' && reenabled.enabled === 'enabled'
      && running.active === 'active'
      && removed.definition === 'drifted' && removed.enabled === 'disabled'
      && restored.definition === 'current' && restored.active === 'inactive'
      && resources.map((resource) => resource.id).join(',')
        === 'service-task-scheduler,service-task-scheduler-sid-folder,service-task-scheduler-shared-folder,'
          + 'service-windows-bootstrap,service-windows-active-install,service-windows-version,service-environment',
    operations.join(','));
  const command = provider.logsCommand({ follow: true, lines: 42 });
  check('Task Scheduler provider keeps a stable bootstrap action and delegates bounded log following to it',
    provider.expectedDefinition().includes('C:\\\\Tools\\\\bun.exe')
      && provider.expectedDefinition().includes('service\\\\windows\\\\service-bootstrap.mjs')
      && command[0] === 'C:\\Tools\\bun.exe'
      && command.slice(-4).join(',') === '--service-logs,--lines,42,--follow');
}

{
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-windows-service-logs-'));
  try {
    const serviceRoot = join(root, 'service', 'windows');
    const logs = join(root, 'logs');
    const bootstrap = join(serviceRoot, 'service-bootstrap.mjs');
    const log = join(logs, 'broker.log');
    mkdirSync(serviceRoot, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(bootstrap, embeddedRuntimeAsset('service/windows/service-bootstrap.mjs').content!);
    writeFileSync(log, 'one\ntwo\nthree\n');
    const bounded = Bun.spawnSync(['bun', bootstrap, '--service-logs', '--lines', '2']);
    check('Windows bootstrap reads a bounded trailing log without entering broker startup',
      bounded.exitCode === 0 && bounded.stdout.toString() === 'two\nthree\n');
    const bootstrapSource = embeddedRuntimeAsset('service/windows/service-bootstrap.mjs').content!;
    check('Windows bootstrap applies the registered bounded crash-restart policy to demand starts',
      bootstrapSource.includes('const RESTART_ATTEMPTS = 3;')
        && bootstrapSource.includes('const RESTART_INTERVAL_MS = 60_000;')
        && bootstrapSource.includes('attempt <= RESTART_ATTEMPTS'));

    const follower = Bun.spawn(['bun', bootstrap, '--service-logs', '--lines', '1', '--follow'], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    await Bun.sleep(350);
    renameSync(log, `${log}.1`);
    writeFileSync(log, 'after-rotation\n');
    await Bun.sleep(500);
    follower.kill('SIGTERM');
    const followed = await new Response(follower.stdout).text();
    await follower.exited;
    check('Windows bootstrap log follow reopens after rotation',
      followed.includes('three\n') && followed.includes('after-rotation\n'), JSON.stringify(followed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const manifest = windowsActiveInstallManifest('install-018f', 'version-2');
  check('active installation manifest is one strict authoritative pointer',
    parseWindowsActiveInstallManifest(manifest)?.versionKey === 'version-2'
      && parseWindowsActiveInstallManifest({ ...manifest, applicationPath: 'C:\\mutable\\cosyncing' }) === undefined);
  check('active installation rejects traversal and malformed ownership identity',
    parseWindowsActiveInstallManifest({ ...manifest, versionKey: '..' }) === undefined
      && parseWindowsActiveInstallManifest({ ...manifest, installationId: 'bad\\id' }) === undefined);
}

{
  const environment = windowsServiceEnvironment([
    ['COSYNCING_HOME', 'C:\\Users\\Fixture\\.cosyncing'],
    ['COSYNCING_WEB_DIR', 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\versions\\v1\\web'],
  ]);
  check('Windows environment JSON round-trips exact strings without systemd quoting',
    parseWindowsServiceEnvironment(environment)?.variables.COSYNCING_WEB_DIR?.endsWith('\\v1\\web') === true
      && !JSON.stringify(environment).includes('KEY="value"'));
  check('Windows environment JSON rejects unknown fields, non-strings, and newline injection',
    parseWindowsServiceEnvironment({ ...environment, extra: true }) === undefined
      && parseWindowsServiceEnvironment({ schemaVersion: 1, variables: { COSYNCING_HOME: 7 } }) === undefined
      && parseWindowsServiceEnvironment({ schemaVersion: 1, variables: { COSYNCING_HOME: 'ok\nbad' } }) === undefined);
  let duplicateRejected = false;
  try {
    windowsServiceEnvironment([['Path', 'one'], ['PATH', 'two']]);
  } catch {
    duplicateRejected = true;
  }
  check('Windows environment names are unique case-insensitively', duplicateRejected);
}

// The broker listener is not configurable, so a Windows install has no host to get wrong. These checks
// pin that: a persisted Windows config cannot smuggle a listener host in, and the URL the Windows service
// path health-checks is the derived loopback origin rather than anything an operator wrote down.
{
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-windows-loopback-'));
  writeBrokerConfig({
    schemaVersion: BROKER_CONFIG_SCHEMA_VERSION,
    broker: {
      port: 17734,
      machineLabel: 'WINDOWS-FIXTURE',
      // A hostile or pre-schema-2 file. Persisting either of these is what the derived model removes.
      host: '0.0.0.0',
      internalUrl: 'http://0.0.0.0:17734',
      advertisedUrl: 'https://cosy.example.test',
    } as never,
    update: { channel: 'stable' },
  }, home);
  const persisted = JSON.parse(readFileSync(brokerConfigPath(home), 'utf8')) as {
    broker: Record<string, unknown>;
  };
  const inspected = inspectBrokerConfig(home);
  const resolved = resolveBrokerConfiguration({
    packaged: true,
    home,
    // Environment overrides are refused for a packaged install; a Windows service is always packaged.
    env: { PORT: '9', COSYNCING_MACHINE: 'other' },
  });
  check('a Windows broker configuration always resolves to the derived loopback listener',
    durableServiceProviderId('win32') === 'task-scheduler'
      && !('host' in persisted.broker) && !('internalUrl' in persisted.broker)
      && !('advertisedUrl' in persisted.broker)
      && inspected.status === 'ok'
      && inspected.config.broker.host === BROKER_LISTEN_HOST
      && inspected.config.broker.internalUrl === brokerInternalUrl(17734)
      && resolved.config.broker.host === '127.0.0.1'
      && resolved.config.broker.internalUrl === 'http://127.0.0.1:17734'
      && resolved.source.host === 'derived' && resolved.source.internalUrl === 'derived'
      && resolved.environmentOverrides.length === 0,
    `${JSON.stringify(Object.keys(persisted.broker))}:${resolved.config.broker.internalUrl}`);
  rmSync(home, { recursive: true, force: true });
}

// The Windows service environment is the only place an installed broker could be handed a listener or a
// remote origin. It carries neither: the process derives its loopback URL from the port in its own config,
// and no receipt this provider commits describes an external route.
{
  const connectivity = /tailscale|serve|advertis|tunnel|vpn|mesh|proxy/i;
  const entries = brokerServiceEnvironmentEntries({
    homeDir: 'C:\\Users\\Fixture',
    stateHome: 'C:\\Users\\Fixture\\.cosyncing',
    cacheRoot: 'C:\\Users\\Fixture\\AppData\\Local\\cosyncing-cache',
    executablePath: 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\versions\\v1\\cosyncing',
    runtimePath: 'C:\\Tools\\bun.exe',
    webDir: 'C:\\Users\\Fixture\\.cosyncing\\service\\windows\\versions\\v1\\web',
    platform: 'win32',
  });
  const names = entries.map(([name]) => name);
  check('the Windows service environment names no listener host, origin, or connectivity provider',
    !names.some((name) => ['HOST', 'PORT', 'COSYNCING_BROKER', 'COSYNCING_HOST'].includes(name))
      && !entries.some(([name, value]) => connectivity.test(name) || connectivity.test(value))
      && !entries.some(([, value]) => /https?:\/\//.test(value))
      && entries.some(([name, value]) => name === 'COSYNCING_HOME' && value === 'C:\\Users\\Fixture\\.cosyncing')
      && !SERVICE_RESOURCE_IDS.some((id) => connectivity.test(id)),
    names.join(','));
}

// Schema 2 is the model the rebased Windows provider has to live under: host and internal URL are derived,
// so the immutable staging transaction converges from the port alone.
{
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-windows-schema2-'));
  writeBrokerConfig({
    schemaVersion: BROKER_CONFIG_SCHEMA_VERSION,
    broker: { port: 17734, machineLabel: 'WINDOWS-FIXTURE' },
    update: { channel: 'stable' },
  } as never, home);
  const effective = resolveBrokerConfiguration({ packaged: true, home });
  const sid = 'S-1-5-21-1-2-3-1001';
  let staged = false;
  let filesystemState: 'missing' | 'current' = 'missing';
  let snapshot: Record<string, unknown> = { currentUserSid: sid };
  const executed: string[] = [];
  const provider = createDurableServiceProvider({
    context: { platform: 'win32' } as never,
    homeDir: 'C:\\Users\\Fixture',
    stateHome: 'C:\\Users\\Fixture\\.cosyncing',
    installationId: 'install-schema2',
    versionKey: 'version-schema2',
    cacheRoot: 'C:\\Users\\Fixture\\AppData\\Local\\cosyncing-cache',
    executablePath: 'C:\\Acquisition\\cosyncing',
    acquisitionExecutablePath: 'C:\\Acquisition\\cosyncing',
    distribution: 'bun-js',
    runtimePath: 'C:\\Tools\\bun.exe',
    webDir: 'C:\\Acquisition\\web',
    backend: new WindowsTaskSchedulerPowerShellBackend({
      execute(operation, input) {
        executed.push(operation);
        if (operation === 'current-user') return { currentUserSid: sid };
        if (operation === 'reconcile') {
          snapshot = {
            currentUserSid: sid,
            shared: { path: input.sharedPath, sddl: input.expectedSddl, childFolders: [sid], tasks: [] },
            sidFolder: {
              path: input.sidFolderPath, sddl: input.expectedSddl, childFolders: [],
              tasks: [{ name: 'Broker', ownershipMarker: input.ownershipMarker }],
            },
            task: {
              path: input.taskPath, ownershipMarker: input.ownershipMarker,
              definition: structuredClone(input.definition), taskSddl: input.expectedSddl,
              enabled: 'enabled', active: 'inactive', lastResult: 0, xml: '<Task/>',
            },
          };
        }
        return structuredClone(snapshot);
      },
    }),
    environmentState: () => 'current',
    stageFiles: () => { staged = true; filesystemState = 'current'; },
    filesystemState: () => filesystemState,
  } as never);
  await provider.installDefinition();
  const installed = await provider.inspect();
  check('Task Scheduler staging converges under the derived schema-2 configuration',
    effective.config.schemaVersion === 2
      && effective.config.broker.internalUrl === brokerInternalUrl(effective.config.broker.port)
      && effective.config.broker.internalUrl.startsWith(`http://${BROKER_LISTEN_HOST}:`)
      && staged && installed.definition === 'current' && installed.environment === 'current'
      && executed.includes('reconcile'),
    `${effective.config.broker.internalUrl}:${executed.join(',')}`);
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} Windows service installation checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} Windows service installation checks`);
