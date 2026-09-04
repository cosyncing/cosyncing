#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  inspectWindowsActiveInstall,
  parseWindowsActiveInstallManifest,
  parseWindowsServiceEnvironment,
  windowsActiveInstallManifest,
  windowsServiceActiveManifestPath,
  windowsServiceEnvironment,
  windowsServiceInstallPaths,
  windowsServiceVersionKey,
  writeWindowsActiveInstall,
} from '../../src/installation/windows-service-install.ts';
import { windowsPowerShellChildEnvironment } from '../../../adapter-api/src/host-process.ts';
import {
  classifyWindowsScheduledTask,
  classifyWindowsTaskFolders,
  WINDOWS_TASK_RESOURCE_ID,
  WINDOWS_TASK_ROOT_PATH,
  windowsTaskSchedulerOwnership,
  WINDOWS_SHARED_FOLDER_RESOURCE_ID,
  WINDOWS_SID_FOLDER_RESOURCE_ID,
  windowsTaskSchedulerReceiptOwnership,
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
  removeWindowsServiceVersionRoot,
  windowsFilesystemReceiptMatches,
  windowsPriorVersionReceiptTarget,
  windowsServiceVersionResources,
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
import { ensureOwnerOnlyDirectory } from '../../src/security/secure-files.ts';

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
  // The Task Scheduler executor is the LAST Windows PowerShell caller left: owner-only enforcement now
  // reaches the operating system directly, but registering a scheduled task still goes through the
  // ScheduledTasks module. A host with PowerShell 7 installed exports a PSModulePath naming 7's module
  // roots, and 5.1 inheriting that auto-loads neither ScheduledTasks nor Security, so this child must
  // replace an inherited module path rather than pass it through.
  {
    const hostile = 'C:\\Users\\someone\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules';
    const childEnv = windowsPowerShellChildEnvironment({ SystemRoot: 'C:\\Windows', PSModulePath: hostile });
    check('the Windows PowerShell child never inherits a foreign module path',
      childEnv.PSModulePath !== hostile
        && childEnv.PSModulePath!.includes('WindowsPowerShell')
        && childEnv.PSModulePath!.includes('Modules'),
      childEnv.PSModulePath);
  }

  const classifyBoth = (value: string) => classifyWindowsTaskFolders({
    identity, expectedSddl: sddl,
    shared: { ...shared, sddl: value },
    sidFolder: { ...ownedFolder, sddl: value },
    sidFolderReceiptOwned: true,
  });
  // Native inspection reads owner, group and DACL back together, and Task Scheduler fills the primary
  // group in from the creating token. A local Windows account carries None (RID 513) there rather than
  // its own SID, so a descriptor is ours whatever group it came back with.
  const ownGroup = classifyBoth(`O:${identity.sid}G:${identity.sid}${sddl}`);
  const localAccountGroup = classifyBoth(`O:${identity.sid}G:S-1-5-21-1-2-3-513${sddl}`);
  const daclOnly = classifyBoth(sddl);
  check('scheduler security accepts the stored descriptor whichever primary group the token carried',
    ownGroup.shared === 'current' && ownGroup.sidFolder === 'current'
      && localAccountGroup.shared === 'current' && localAccountGroup.sidFolder === 'current'
      && daclOnly.shared === 'current' && daclOnly.sidFolder === 'current');
  const foreignOwner = classifyBoth(`O:S-1-5-21-1-2-3-1002G:S-1-5-21-1-2-3-513${sddl}`);
  const widenedDacl = classifyBoth(
    `O:${identity.sid}G:S-1-5-21-1-2-3-513D:PAI(A;;FA;;;${identity.sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)`);
  const audited = classifyBoth(`O:${identity.sid}G:S-1-5-21-1-2-3-513${sddl}S:(AU;SA;FA;;;WD)`);
  const unprotected = classifyBoth(`O:${identity.sid}G:S-1-5-21-1-2-3-513D:AI(A;;FA;;;${identity.sid})(A;;FA;;;SY)(A;;FA;;;BA)`);
  check('scheduler security still rejects a foreign owner, a widened or unprotected DACL, and an audit ACL',
    [foreignOwner, widenedDacl, audited, unprotected]
      .every((entry) => entry.shared === 'conflict' && entry.sidFolder === 'drifted'));
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
      && operations[2]?.input.expectedSddl === windowsTaskSchedulerSddl(identity.sid));

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
  // ---- The ownership VERDICT, derived the way the provider derives it ------------------------------
  //
  // Ownership and health are different questions, and setup once answered the first with the second: it
  // read a Windows install's `drifted` status as proof of ownership, which would have accepted an
  // owner-only environment file whose contents were not ours with no receipt consulted at all. These
  // cases run the real classifiers over real receipts, so they check the derivation rather than a
  // verdict handed to them.
  const identity = windowsScheduledTaskIdentity('install-verdict', 'S-1-5-21-1-2-3-1001');
  const environmentPath = 'C:\\Users\\Fixture\\.cosyncing\\service\\broker.env';
  const versionKey = 'version-7';
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
  const exactReceipts: InstalledResourceRecord[] = [
    { id: WINDOWS_TASK_RESOURCE_ID, kind: 'service', target: identity.taskPath,
      ownership: { proof: 'receipt', marker: identity.ownershipMarker } },
    { id: WINDOWS_SID_FOLDER_RESOURCE_ID, kind: 'other', target: identity.sidFolderPath,
      ownership: { proof: 'receipt' } },
    { id: 'service-environment', kind: 'environment-file', target: environmentPath,
      ownership: { proof: 'receipt', marker: versionKey } },
  ];
  const folderSnapshot = (tasks: Array<{ name: string; ownershipMarker?: string }>) => ({
    path: identity.sidFolderPath,
    sddl: windowsTaskSchedulerSddl(identity.sid),
    childFolders: [] as string[],
    tasks,
  });
  const verdictFor = (options: {
    resources?: InstalledResourceRecord[];
    marker?: string;
    taskDefinition?: WindowsScheduledTaskDefinition;
  } = {}) => {
    const actualMarker = options.marker ?? identity.ownershipMarker;
    return windowsTaskSchedulerOwnership({
      resources: options.resources ?? exactReceipts,
      identity,
      environmentPath,
      versionKey,
      task: classifyWindowsScheduledTask({
        actual: {
          path: identity.taskPath,
          ownershipMarker: actualMarker,
          definition: options.taskDefinition ?? definition,
          enabled: 'enabled',
          active: 'active',
        },
        expectedIdentity: identity,
        expectedDefinition: definition,
      }),
      folders: classifyWindowsTaskFolders({
        identity,
        expectedSddl: windowsTaskSchedulerSddl(identity.sid),
        shared: { path: WINDOWS_TASK_ROOT_PATH, sddl: windowsTaskSchedulerSddl(identity.sid), childFolders: [], tasks: [] },
        sidFolder: folderSnapshot([{ name: 'Broker', ownershipMarker: actualMarker }]),
        sidFolderReceiptOwned: (options.resources ?? exactReceipts)
          .some((resource) => resource.id === WINDOWS_SID_FOLDER_RESOURCE_ID),
      }),
    });
  };

  const owned = verdictFor();
  check('exact receipts, marker, folder authority and SDDL make the install owned',
    owned.definition === 'owned' && owned.environment === 'owned',
    `${owned.definition}/${owned.environment}`);

  // Definition drift is a repair job, not a stranger's task. Denying ownership here would block setup
  // exactly when reconciliation is what the operator came for.
  const drifted = verdictFor({ taskDefinition: { ...definition, executable: 'C:\\Other\\bun.exe' } });
  check('an owned task whose definition drifted is still owned, so setup can reconcile it',
    drifted.definition === 'owned' && drifted.environment === 'owned',
    `${drifted.definition}/${drifted.environment}`);

  // The environment file's CONTENTS are health. Its ownership is the version-key receipt, and that is the
  // only thing that says this installation wrote it.
  check('a modified environment file with a valid receipt stays owned',
    verdictFor().environment === 'owned');

  const missing = verdictFor({ resources: exactReceipts.filter((r) => r.id !== 'service-environment') });
  check('a missing environment receipt denies environment ownership',
    missing.definition === 'owned' && missing.environment === 'unowned',
    `${missing.definition}/${missing.environment}`);

  // Two receipts under one id mean the state file disagrees with itself; picking the matching one would
  // be choosing the answer.
  const duplicated = verdictFor({ resources: [...exactReceipts, exactReceipts[0]!] });
  check('duplicate receipts for one resource deny ownership',
    duplicated.definition !== 'owned', duplicated.definition);

  const wrongTarget = verdictFor({
    resources: exactReceipts.map((r) => (r.id === WINDOWS_TASK_RESOURCE_ID
      ? { ...r, target: '\\Cosyncing\\S-1-5-21-1-2-3-1001\\Other' } : r)),
  });
  check('a receipt naming a different target denies ownership', wrongTarget.definition !== 'owned',
    wrongTarget.definition);

  const wrongMarker = verdictFor({
    resources: exactReceipts.map((r) => (r.id === WINDOWS_TASK_RESOURCE_ID
      ? { ...r, ownership: { proof: 'receipt' as const, marker: 'cosyncing:task-scheduler:v1:someone-else' } } : r)),
  });
  check('a receipt carrying another installation\'s marker denies ownership',
    wrongMarker.definition !== 'owned', wrongMarker.definition);

  // "No marker expected" has to mean the receipt carries none. Admitting any marker where none was
  // expected -- which is every SID-folder receipt -- contradicts the exactly-one-matching-receipt rule
  // this function exists to enforce.
  const sidFolderMarker = verdictFor({
    resources: exactReceipts.map((r) => (r.id === WINDOWS_SID_FOLDER_RESOURCE_ID
      ? { ...r, ownership: { proof: 'receipt' as const, marker: 'cosyncing:task-scheduler:v1:elsewhere' } } : r)),
  });
  check('a SID-folder receipt carrying an unexpected marker denies ownership',
    sidFolderMarker.definition !== 'owned', sidFolderMarker.definition);

  // A task wearing someone else's marker is theirs, however healthy it looks.
  const foreign = verdictFor({ marker: 'cosyncing:task-scheduler:v1:foreign-install' });
  check('a foreign task marker is refused as unowned', foreign.definition === 'unowned', foreign.definition);

  const unsafeSddl = windowsTaskSchedulerOwnership({
    resources: exactReceipts,
    identity,
    environmentPath,
    versionKey,
    task: classifyWindowsScheduledTask({
      actual: {
        path: identity.taskPath, ownershipMarker: identity.ownershipMarker,
        definition, enabled: 'enabled', active: 'active',
      },
      expectedIdentity: identity,
      expectedDefinition: definition,
    }),
    folders: classifyWindowsTaskFolders({
      identity,
      expectedSddl: windowsTaskSchedulerSddl(identity.sid),
      shared: { path: WINDOWS_TASK_ROOT_PATH, sddl: windowsTaskSchedulerSddl(identity.sid), childFolders: [], tasks: [] },
      // A folder holding a task that is not ours is contested, whatever the receipts say.
      sidFolder: { ...folderSnapshot([{ name: 'Intruder', ownershipMarker: 'foreign' }]), sddl: 'D:PAI' },
      sidFolderReceiptOwned: true,
    }),
  });
  check('a contested SID folder denies ownership even with exact receipts',
    unsafeSddl.definition === 'unowned', unsafeSddl.definition);
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

{
  // ---- The cached verdict may never outlive the inspection that produced it ------------------------
  //
  // The verdict used to be published as soon as the classifications existed, while the filesystem and
  // environment inspections still had to run. An exception from either then left an `owned` answer
  // standing for an inspection that never completed -- and setup reads that answer to decide whether it
  // may touch the service at all.
  const sid = 'S-1-5-21-4-5-6-1001';
  const identity = windowsScheduledTaskIdentity('install-verdict-seq', sid);
  const paths = windowsServiceInstallPaths('C:\\Users\\Fixture\\.cosyncing', 'version-1');
  let filesystemState: 'missing' | 'current' = 'missing';
  let filesystemThrows = false;
  let snapshot: Record<string, unknown> = { currentUserSid: sid };
  const executor: WindowsTaskSchedulerExecutor = {
    execute(operation, input) {
      if (operation === 'current-user') return { currentUserSid: sid };
      if (operation === 'reconcile') {
        const definition = structuredClone(input.definition);
        snapshot = {
          currentUserSid: sid,
          shared: { path: input.sharedPath, sddl: input.expectedSddl, childFolders: [sid], tasks: [] },
          sidFolder: {
            path: input.sidFolderPath, sddl: input.expectedSddl, childFolders: [],
            tasks: [{ name: 'Broker', ownershipMarker: input.ownershipMarker }],
          },
          task: {
            path: input.taskPath, ownershipMarker: input.ownershipMarker, definition,
            taskSddl: input.expectedSddl, enabled: 'enabled', active: 'active', lastResult: 0, xml: '<Task/>',
          },
        };
      }
      return structuredClone(snapshot);
    },
  };
  const provider = new WindowsTaskSchedulerServiceProvider({
    context: { platform: 'win32' } as never,
    homeDir: 'C:\\Users\\Fixture',
    stateHome: 'C:\\Users\\Fixture\\.cosyncing',
    installationId: 'install-verdict-seq',
    versionKey: 'version-1',
    cacheRoot: 'C:\\Users\\Fixture\\AppData\\Local\\cosyncing-cache',
    executablePath: 'C:\\Acquisition\\cosyncing',
    acquisitionExecutablePath: 'C:\\Acquisition\\cosyncing',
    distribution: 'bun-js',
    runtimePath: 'C:\\Tools\\bun.exe',
    webDir: 'C:\\Acquisition\\web',
    environmentEntries: [['COSYNCING_HOME', 'C:\\Users\\Fixture\\.cosyncing']],
    backend: new WindowsTaskSchedulerPowerShellBackend(executor),
    taskSchedulerReceiptResources: [
      { id: WINDOWS_TASK_RESOURCE_ID, kind: 'service', target: identity.taskPath,
        ownership: { proof: 'receipt', marker: identity.ownershipMarker } },
      { id: WINDOWS_SID_FOLDER_RESOURCE_ID, kind: 'other', target: identity.sidFolderPath,
        ownership: { proof: 'receipt' } },
      { id: 'service-environment', kind: 'environment-file', target: paths.environmentPath,
        ownership: { proof: 'receipt', marker: 'version-1' } },
    ],
    environmentState: () => 'current',
    stageFiles: () => { filesystemState = 'current'; },
    filesystemState: () => {
      if (filesystemThrows) throw new Error('filesystem inspection failed');
      return filesystemState;
    },
  });

  check('a provider that has not inspected yet claims nothing',
    provider.ownership().definition === 'unknown' && provider.ownership().environment === 'unknown',
    `${provider.ownership().definition}/${provider.ownership().environment}`);

  await provider.installDefinition();
  await provider.inspect();
  const afterSuccess = provider.ownership();
  check('a completed inspection publishes the verdict it derived',
    afterSuccess.definition === 'owned' && afterSuccess.environment === 'owned',
    `${afterSuccess.definition}/${afterSuccess.environment}`);

  filesystemThrows = true;
  let threw = false;
  try { await provider.inspect(); } catch { threw = true; }
  const afterFailure = provider.ownership();
  check('an inspection that throws after classifying leaves unknown, not the previous owned verdict',
    threw && afterFailure.definition === 'unknown' && afterFailure.environment === 'unknown',
    `threw=${threw} ${afterFailure.definition}/${afterFailure.environment}`);
}

// ---- Moving a live install from one version root to the next --------------------------------------
//
// `upgrade` replaces `<home>\bin\cosyncing` and restarts the service. The Scheduled Task does not exec
// that file: it execs a bootstrap that reads `active-install.json` at every start and runs the version
// root named there. These pin the three pieces an upgrade needs to move the service with the binary --
// a pointer path that does not need a version key to be resolved, the receipts that move with a root,
// and a removal that refuses anything not provably one of ours.
{
  const home = 'C:\\Users\\Fixture\\.cosyncing';
  const versionsRoot = windowsServiceInstallPaths(home, 'version-1').versionsRoot;
  check('the pointer file resolves without a version key, and to the same path the layout gives it',
    windowsServiceActiveManifestPath(home) === windowsServiceInstallPaths(home, 'version-1').activeManifestPath
      && windowsServiceActiveManifestPath(home)
        === windowsServiceInstallPaths(home, 'a-completely-different-key').activeManifestPath,
    windowsServiceActiveManifestPath(home));

  // The bootstrap and the pointer are absent on purpose: neither target carries a version key, so an
  // upgrade that activates a new root leaves both receipts exactly as setup wrote them.
  const moved = windowsServiceVersionResources(home, 'version-2');
  check('exactly the version root and its environment file move with a version key',
    moved.map((resource) => `${resource.id}:${resource.ownership.marker}`).join(',')
      === 'service-windows-version:version-2,service-environment:version-2'
      && moved[0]?.target === `${versionsRoot}\\version-2`
      && moved[1]?.target === `${versionsRoot}\\version-2\\environment.json`,
    moved.map((resource) => resource.target).join(','));

  check('a root outside the versions directory, below it, or currently active is never removed',
    !removeWindowsServiceVersionRoot({
      versionsRoot, target: `${home}\\service\\windows`, activeVersionRoot: `${versionsRoot}\\version-2`,
    })
      && !removeWindowsServiceVersionRoot({
        versionsRoot, target: `${versionsRoot}\\version-1\\web`, activeVersionRoot: `${versionsRoot}\\version-2`,
      })
      && !removeWindowsServiceVersionRoot({
        versionsRoot, target: `${versionsRoot}\\version-2`, activeVersionRoot: `${versionsRoot}\\version-2`,
      }));
}

// The removal itself needs a real filesystem addressed by real Windows paths, which only exists here.
if (process.platform === 'win32') {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-windows-supersede-'));
  const superseded = windowsServiceInstallPaths(home, 'version-1');
  const active = windowsServiceInstallPaths(home, 'version-2');
  ensureOwnerOnlyDirectory(superseded.webRoot);
  ensureOwnerOnlyDirectory(active.webRoot);
  const removed = removeWindowsServiceVersionRoot({
    versionsRoot: superseded.versionsRoot,
    target: superseded.versionRoot,
    activeVersionRoot: active.versionRoot,
  });
  check('a superseded version root and everything under it go, and the active one stays',
    removed && !existsSync(superseded.versionRoot) && existsSync(active.webRoot),
    `${removed}/${existsSync(superseded.versionRoot)}/${existsSync(active.webRoot)}`);
  rmSync(home, { recursive: true, force: true });
}

// The lifecycle seam `upgrade` drives, against a real pointer file. Windows-only for the same reason the
// removal above is: the layout is addressed with `win32` paths, which name nothing on a POSIX filesystem.
if (process.platform === 'win32') {
  const { createLifecycleServiceVersions } = await import('../../src/installation/broker-lifecycle.ts');
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-windows-versions-'));
  const candidate = {
    version: '2.0.0', commit: 'cafe1234', buildDate: '2026-09-04T00:00:00.000Z',
    target: 'universal', dirty: false, distribution: 'bootstrap-js' as const,
  };
  const options = {
    home,
    buildInfo: { version: '1.0.0' } as never,
    executablePath: join(home, 'bin', 'cosyncing'),
    context: { platform: 'win32' } as never,
  };
  const missing = createLifecycleServiceVersions(options)?.plan(candidate);
  check('no pointer means no versioned install to move, and an upgrade there is the binary swap it was',
    missing === undefined, String(missing));

  writeWindowsActiveInstall(
    windowsServiceActiveManifestPath(home),
    windowsActiveInstallManifest('install-live', 'version-1'),
  );
  const versions = createLifecycleServiceVersions(options);
  const activation = versions?.plan(candidate);
  check('the plan reads the live pointer and keys the candidate by the candidate own build terms',
    activation?.record.installationId === 'install-live'
      && activation?.record.fromVersionKey === 'version-1'
      && activation?.record.toVersionKey === windowsServiceVersionKey(candidate),
    JSON.stringify(activation?.record));

  const supersededRoot = windowsServiceInstallPaths(home, 'version-1').versionRoot;
  const candidateRoot = windowsServiceInstallPaths(home, activation!.record.toVersionKey).versionRoot;
  ensureOwnerOnlyDirectory(supersededRoot);
  ensureOwnerOnlyDirectory(candidateRoot);
  writeWindowsActiveInstall(
    windowsServiceActiveManifestPath(home),
    windowsActiveInstallManifest('install-live', activation!.record.toVersionKey),
  );
  await versions!.restore(activation!.record);
  const restored = inspectWindowsActiveInstall(windowsServiceActiveManifestPath(home));
  check('restore points the service back and drops the candidate root, leaving the one it returns to',
    restored.status === 'ok' && restored.manifest.versionKey === 'version-1'
      && !existsSync(candidateRoot) && existsSync(supersededRoot),
    `${restored.status}/${existsSync(candidateRoot)}/${existsSync(supersededRoot)}`);

  ensureOwnerOnlyDirectory(candidateRoot);
  await versions!.finalize(activation!.record);
  check('finalize drops the superseded root and never the one the record moved to',
    !existsSync(supersededRoot) && existsSync(candidateRoot),
    `${existsSync(supersededRoot)}/${existsSync(candidateRoot)}`);

  check('the receipts the seam commits are the ones the provider itself writes for that key',
    JSON.stringify(versions!.resources(activation!.record.toVersionKey))
      === JSON.stringify(windowsServiceVersionResources(home, activation!.record.toVersionKey)));
  rmSync(home, { recursive: true, force: true });
}

{
  // `upgrade` moves the service to a new version root without rewriting a scheduled task whose definition
  // has not changed. `installDefinition` still routes through the same writer, so there is one definition
  // of what a version root is rather than a private copy in the upgrade path.
  const sid = 'S-1-5-21-7-8-9-1001';
  let staged = 0;
  const operations: string[] = [];
  let snapshot: Record<string, unknown> = { currentUserSid: sid };
  const provider = new WindowsTaskSchedulerServiceProvider({
    context: { platform: 'win32' } as never,
    homeDir: 'C:\\Users\\Fixture',
    stateHome: 'C:\\Users\\Fixture\\.cosyncing',
    installationId: 'install-stage-version',
    versionKey: 'version-2',
    cacheRoot: 'C:\\Users\\Fixture\\AppData\\Local\\cosyncing-cache',
    executablePath: 'C:\\Acquisition\\cosyncing',
    acquisitionExecutablePath: 'C:\\Acquisition\\cosyncing',
    distribution: 'bun-js',
    runtimePath: 'C:\\Tools\\bun.exe',
    webDir: 'C:\\Acquisition\\web',
    environmentEntries: [['COSYNCING_HOME', 'C:\\Users\\Fixture\\.cosyncing']],
    backend: new WindowsTaskSchedulerPowerShellBackend({
      execute(operation, input) {
        operations.push(operation);
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
    stageFiles: () => { staged += 1; },
    filesystemState: () => 'current',
  });
  await provider.stageVersion();
  const stagedAlone = staged;
  const schedulerAfterStage = operations.filter((operation) => operation !== 'current-user');
  await provider.installDefinition();
  check('stageVersion writes a version root and touches no scheduler object; installDefinition uses it',
    stagedAlone === 1 && schedulerAfterStage.length === 0
      && staged === 2 && operations.includes('reconcile'),
    `staged=${stagedAlone}->${staged} scheduler=${operations.join(',')}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} Windows service installation checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} Windows service installation checks`);
