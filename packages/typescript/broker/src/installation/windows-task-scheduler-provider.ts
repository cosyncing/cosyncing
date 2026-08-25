import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { win32 } from 'node:path';
import {
  assertNoSymlinkComponents,
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';
import { embeddedRuntimeAsset } from '../runtime/runtime-assets.ts';
import type {
  DurableServiceProvider,
  DurableServiceProviderOptions,
  DurableServiceStatus,
  ServiceLogsRequest,
} from './service-manager.ts';
import {
  windowsServiceEnvironment,
  windowsServiceInstallPaths,
  windowsActiveInstallManifest,
  inspectWindowsActiveInstall,
  writeWindowsActiveInstall,
  WINDOWS_ACTIVE_INSTALL_RESOURCE_ID,
  WINDOWS_BOOTSTRAP_RESOURCE_ID,
  WINDOWS_VERSION_RESOURCE_ID,
} from './windows-service-install.ts';
import {
  classifyWindowsScheduledTask,
  classifyWindowsTaskFolders,
  WINDOWS_SHARED_FOLDER_RESOURCE_ID,
  WINDOWS_SID_FOLDER_RESOURCE_ID,
  WINDOWS_TASK_RESOURCE_ID,
  WINDOWS_TASK_ROOT_PATH,
  windowsScheduledTaskIdentity,
  windowsTaskSchedulerReceiptOwnership,
  windowsTaskSchedulerSddl,
  windowsTaskSchedulerSddlMatches,
  type WindowsScheduledTaskDefinition,
  type WindowsTaskSchedulerSnapshot,
} from './windows-task-scheduler.ts';
import { WindowsTaskSchedulerPowerShellBackend } from './windows-task-scheduler-powershell.ts';
import type { InstalledResourceRecord } from './install-state.ts';

export interface WindowsTaskSchedulerProviderOptions extends DurableServiceProviderOptions {
  versionKey: string;
  environmentEntries: ReadonlyArray<readonly [string, string]>;
  backend?: WindowsTaskSchedulerPowerShellBackend;
  /** Deterministic filesystem seam; production enforces owner-only inspection before comparing bytes. */
  environmentState?: () => DurableServiceStatus['environment'];
  /** Filesystem staging seam for scheduler-only unit fixtures. */
  stageFiles?: () => void;
  /** Read-only filesystem seam paired with stageFiles. */
  filesystemState?: () => 'missing' | 'current' | 'drifted' | 'unsafe';
}

function windowsArgument(value: string): string {
  if (/[\0\r\n"]/.test(value)) throw new Error('invalid Windows task argument');
  return `"${value.replace(/(\\+)$/g, '$1$1')}"`;
}

function exactEnvironmentState(path: string, expected: string): DurableServiceStatus['environment'] {
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return 'missing';
  if (inspection.status !== 'ok') return 'unsafe';
  try {
    return readFileSync(path, 'utf8') === expected ? 'current' : 'drifted';
  } catch {
    return 'unsafe';
  }
}

function snapshotRecord(snapshot: WindowsTaskSchedulerSnapshot): Record<string, unknown> {
  return structuredClone(snapshot) as unknown as Record<string, unknown>;
}

function sameBytes(path: string, expected: Uint8Array): boolean {
  try { return Buffer.from(readFileSync(path)).equals(Buffer.from(expected)); } catch { return false; }
}

function safeSourceFile(path: string): Uint8Array {
  assertNoSymlinkComponents(path, false);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe Windows staging source file');
  return readFileSync(path);
}

function sourceTree(root: string, relative = ''): Array<{ relative: string; bytes: Uint8Array }> {
  const directory = relative ? win32.join(root, relative) : root;
  assertNoSymlinkComponents(directory, false);
  if (!lstatSync(directory).isDirectory()) throw new Error('unsafe Windows web staging source');
  const result: Array<{ relative: string; bytes: Uint8Array }> = [];
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relative ? win32.join(relative, name) : name;
    const child = win32.join(root, childRelative);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('unsafe Windows web staging symlink');
    if (stat.isDirectory()) result.push(...sourceTree(root, childRelative));
    else if (stat.isFile()) result.push({ relative: childRelative, bytes: readFileSync(child) });
    else throw new Error('unsafe Windows web staging entry');
  }
  return result;
}

function installedTreeIsOwnerOnly(root: string, relative = ''): boolean {
  const directory = relative ? win32.join(root, relative) : root;
  if (inspectOwnerOnlyDirectory(directory).status !== 'ok') return false;
  try {
    return readdirSync(directory).every((name) => {
      const childRelative = relative ? win32.join(relative, name) : name;
      const child = win32.join(root, childRelative);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) return installedTreeIsOwnerOnly(root, childRelative);
      return stat.isFile() && inspectOwnerOnlyFile(child).status === 'ok';
    });
  } catch {
    return false;
  }
}

function removeEmpty(path: string): void {
  try { rmdirSync(path); } catch { /* Preserve nonempty or concurrently removed directories. */ }
}

type FileState = 'missing' | 'current' | 'drifted' | 'unsafe';

export function windowsFilesystemReceiptMatches(
  resources: readonly InstalledResourceRecord[],
  expected: Readonly<Pick<InstalledResourceRecord, 'id' | 'kind' | 'target'> & {
    ownership: Readonly<Pick<InstalledResourceRecord['ownership'], 'proof' | 'marker'>>;
  }>,
): boolean {
  const candidates = resources.filter((resource) => resource.id === expected.id);
  return candidates.length === 1
    && candidates[0]!.kind === expected.kind
    && candidates[0]!.ownership.proof === expected.ownership.proof
    && candidates[0]!.ownership.marker === expected.ownership.marker
    && win32.resolve(candidates[0]!.target).toLowerCase()
      === win32.resolve(expected.target).toLowerCase();
}

export function windowsPriorVersionReceiptTarget(
  resources: readonly InstalledResourceRecord[],
  versionsRoot: string,
  activeVersionRoot: string,
): string | undefined {
  const candidates = resources.filter((resource) => resource.id === WINDOWS_VERSION_RESOURCE_ID);
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  const marker = candidate.ownership.marker;
  if (candidate.kind !== 'other' || candidate.ownership.proof !== 'receipt'
      || !marker || win32.basename(marker) !== marker) return undefined;
  const target = win32.resolve(candidate.target);
  const expectedTarget = win32.resolve(versionsRoot, marker);
  if (target.toLowerCase() !== expectedTarget.toLowerCase()
      || target.toLowerCase() === win32.resolve(activeVersionRoot).toLowerCase()) return undefined;
  return target;
}

/** Login-scoped, least-privilege per-user Task Scheduler provider. Files are staged by a separate action. */
export class WindowsTaskSchedulerServiceProvider implements DurableServiceProvider {
  readonly id = 'task-scheduler' as const;
  readonly serviceName: string;
  readonly definitionPath: string;
  readonly environmentPath: string;
  readonly persistenceTarget: string;
  readonly identity;
  readonly paths;
  private readonly backend: WindowsTaskSchedulerPowerShellBackend;
  private readonly definition: WindowsScheduledTaskDefinition;
  private readonly environment: string;
  private readonly expectedSddl: string;
  private readonly receiptOwnership;
  private readonly sourceApplication: string;
  private readonly sourceWeb: string;
  private readonly receiptResources: readonly InstalledResourceRecord[];
  private sharedCreatedDuringInstall = false;
  private sidFolderCreatedDuringInstall = false;

  constructor(readonly options: WindowsTaskSchedulerProviderOptions) {
    if (options.context.platform !== 'win32') throw new Error('Task Scheduler provider requires Windows');
    if (!options.installationId) throw new Error('Task Scheduler provider requires installation identity');
    if (!options.runtimePath || !win32.isAbsolute(options.runtimePath)) {
      throw new Error('Task Scheduler provider requires an absolute Bun runtime');
    }
    if (!options.acquisitionExecutablePath || !win32.isAbsolute(options.acquisitionExecutablePath)
        || !win32.isAbsolute(options.webDir)) {
      throw new Error('Task Scheduler provider requires absolute immutable staging inputs');
    }
    this.sourceApplication = win32.resolve(options.acquisitionExecutablePath);
    this.sourceWeb = win32.resolve(options.webDir);
    this.receiptResources = options.taskSchedulerReceiptResources ?? [];
    this.backend = options.backend ?? new WindowsTaskSchedulerPowerShellBackend();
    this.identity = windowsScheduledTaskIdentity(options.installationId, this.backend.currentUserSid());
    this.paths = windowsServiceInstallPaths(options.stateHome, options.versionKey);
    this.expectedSddl = windowsTaskSchedulerSddl(this.identity.sid);
    this.receiptOwnership = windowsTaskSchedulerReceiptOwnership(
      options.taskSchedulerReceiptResources ?? [],
      this.identity,
    );
    this.serviceName = this.identity.taskPath;
    this.definitionPath = this.identity.taskPath;
    this.environmentPath = this.paths.environmentPath;
    this.persistenceTarget = `task-scheduler-login:${this.identity.sid}`;
    this.definition = {
      principalSid: this.identity.sid,
      runLevel: 'least-privilege',
      logonType: 'interactive-token',
      executable: win32.resolve(options.runtimePath),
      arguments: windowsArgument(this.paths.bootstrapPath),
      workingDirectory: win32.resolve(options.stateHome),
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
    const environment = windowsServiceEnvironment(options.environmentEntries);
    this.environment = `${JSON.stringify(environment, null, 2)}\n`;
  }

  expectedDefinition(): string { return `${JSON.stringify(this.definition, null, 2)}\n`; }
  expectedEnvironment(): string { return this.environment; }
  transactionFilePaths(): readonly string[] {
    return [this.paths.bootstrapPath, this.paths.activeManifestPath];
  }

  logsCommand(request: Readonly<ServiceLogsRequest>): readonly string[] {
    return [
      this.definition.executable,
      this.paths.bootstrapPath,
      '--service-logs',
      '--lines',
      String(request.lines),
      ...(request.follow ? ['--follow'] : []),
    ];
  }

  async captureTransactionState(): Promise<Record<string, unknown>> {
    return {
      scheduler: snapshotRecord(this.backend.inspect(this.identity)),
      filesystem: {
        serviceRootExisted: existsSync(this.paths.serviceRoot),
        versionsRootExisted: existsSync(this.paths.versionsRoot),
        versionRootExisted: existsSync(this.paths.versionRoot),
        logDirectoryExisted: existsSync(this.paths.logDirectory),
      },
    };
  }

  async restoreTransactionState(state: Readonly<Record<string, unknown>>): Promise<void> {
    const scheduler = state.scheduler as WindowsTaskSchedulerSnapshot | undefined;
    const filesystem = state.filesystem as Record<string, unknown> | undefined;
    if (!scheduler || !filesystem
        || typeof filesystem.serviceRootExisted !== 'boolean'
        || typeof filesystem.versionsRootExisted !== 'boolean'
        || typeof filesystem.versionRootExisted !== 'boolean'
        || typeof filesystem.logDirectoryExisted !== 'boolean') {
      throw new Error('invalid Task Scheduler provider rollback state');
    }
    this.backend.restore({ identity: this.identity, snapshot: scheduler });
    if (!filesystem.versionRootExisted && existsSync(this.paths.versionRoot)) {
      assertNoSymlinkComponents(this.paths.versionRoot, false);
      rmSync(this.paths.versionRoot, { recursive: true, force: false });
    }
    if (!filesystem.logDirectoryExisted) removeEmpty(this.paths.logDirectory);
    if (!filesystem.versionsRootExisted) removeEmpty(this.paths.versionsRoot);
    if (!filesystem.serviceRootExisted) removeEmpty(this.paths.serviceRoot);
  }

  installedResources(): InstalledResourceRecord[] {
    return [
      {
        id: WINDOWS_TASK_RESOURCE_ID,
        kind: 'service',
        target: this.identity.taskPath,
        ownership: { proof: 'receipt', marker: this.identity.ownershipMarker },
      },
      {
        id: WINDOWS_SID_FOLDER_RESOURCE_ID,
        kind: 'other',
        target: this.identity.sidFolderPath,
        ownership: { proof: 'receipt' },
      },
      ...((this.receiptOwnership.sharedFolderCreated || this.sharedCreatedDuringInstall) ? [{
        id: WINDOWS_SHARED_FOLDER_RESOURCE_ID,
        kind: 'other' as const,
        target: WINDOWS_TASK_ROOT_PATH,
        ownership: { proof: 'receipt' as const },
      }] : []),
      {
        id: WINDOWS_BOOTSTRAP_RESOURCE_ID,
        kind: 'other',
        target: this.paths.bootstrapPath,
        ownership: { proof: 'receipt', marker: this.identity.installationId },
      },
      {
        id: WINDOWS_ACTIVE_INSTALL_RESOURCE_ID,
        kind: 'other',
        target: this.paths.activeManifestPath,
        ownership: { proof: 'receipt', marker: this.identity.installationId },
      },
      {
        id: WINDOWS_VERSION_RESOURCE_ID,
        kind: 'other',
        target: this.paths.versionRoot,
        ownership: { proof: 'receipt', marker: this.options.versionKey },
      },
      {
        id: 'service-environment',
        kind: 'environment-file',
        target: this.paths.environmentPath,
        ownership: { proof: 'receipt', marker: this.options.versionKey },
      },
    ];
  }

  private inspectImmutableFilesystem(): FileState {
    if (this.options.filesystemState) return this.options.filesystemState();
    const paths = [this.paths.serviceRoot, this.paths.versionsRoot, this.paths.versionRoot, this.paths.webRoot];
    const directoryStates = paths.map((path) => inspectOwnerOnlyDirectory(path).status);
    const fileStates = [this.paths.bootstrapPath, this.paths.activeManifestPath,
      this.paths.applicationPath, this.paths.environmentPath].map((path) => inspectOwnerOnlyFile(path).status);
    if ([...directoryStates, ...fileStates].every((state) => state === 'missing')) return 'missing';
    if ([...directoryStates, ...fileStates].some((state) => state === 'unsafe' || state === 'unreadable')) return 'unsafe';
    if ([...directoryStates, ...fileStates].some((state) => state === 'missing')) return 'drifted';
    const bootstrap = embeddedRuntimeAsset('service/windows/service-bootstrap.mjs').content;
    const active = inspectWindowsActiveInstall(this.paths.activeManifestPath);
    if (!bootstrap || !sameBytes(this.paths.bootstrapPath, Buffer.from(bootstrap, 'utf8'))
        || active.status !== 'ok'
        || active.manifest.installationId !== this.identity.installationId
        || active.manifest.versionKey !== this.options.versionKey) return 'drifted';
    try {
      const application = safeSourceFile(this.sourceApplication);
      const expectedWeb = sourceTree(this.sourceWeb);
      const actualWeb = sourceTree(this.paths.webRoot);
      if (!sameBytes(this.paths.applicationPath, application)
          || expectedWeb.length !== actualWeb.length
          || expectedWeb.some((entry, index) => {
            const actual = actualWeb[index];
            return !actual || entry.relative.toLowerCase() !== actual.relative.toLowerCase()
              || !Buffer.from(entry.bytes).equals(Buffer.from(actual.bytes));
          })) return 'drifted';
      if (!installedTreeIsOwnerOnly(this.paths.webRoot)) {
        return 'unsafe';
      }
    } catch {
      return 'unsafe';
    }
    return exactEnvironmentState(this.paths.environmentPath, this.environment) === 'current'
      ? 'current'
      : exactEnvironmentState(this.paths.environmentPath, this.environment);
  }

  async inspect(): Promise<DurableServiceStatus> {
    let snapshot: WindowsTaskSchedulerSnapshot;
    try {
      snapshot = this.backend.inspect(this.identity);
    } catch {
      return {
        provider: 'task-scheduler', supported: false,
        definition: 'unsafe', environment: 'unsafe', enabled: 'unknown', active: 'unknown', lingering: 'unsupported',
      };
    }
    const folders = classifyWindowsTaskFolders({
      identity: this.identity,
      expectedSddl: this.expectedSddl,
      shared: snapshot.shared,
      sidFolder: snapshot.sidFolder,
      sidFolderReceiptOwned: this.receiptOwnership.sidFolderOwned || this.sidFolderCreatedDuringInstall,
    });
    const task = classifyWindowsScheduledTask({
      actual: snapshot.task,
      expectedIdentity: this.identity,
      expectedDefinition: this.definition,
    });
    const unsafe = ['conflict', 'unknown'].includes(folders.shared)
      || ['conflict', 'unknown'].includes(folders.sidFolder)
      || ['conflict', 'unknown'].includes(task.ownership);
    const missing = !snapshot.task || task.ownership === 'missing';
    const files = this.inspectImmutableFilesystem();
    const filesystemUnsafe = files === 'unsafe';
    const current = !unsafe && !missing && files === 'current'
      && folders.shared === 'current' && folders.sidFolder === 'current'
      && task.definition === 'current'
      && windowsTaskSchedulerSddlMatches(snapshot.task?.taskSddl, this.identity.sid);
    return {
      provider: 'task-scheduler',
      supported: true,
      definition: unsafe || filesystemUnsafe ? 'unsafe'
        : missing && files === 'missing' ? 'missing'
          : current ? 'current' : 'drifted',
      environment: this.options.environmentState?.()
        ?? exactEnvironmentState(this.environmentPath, this.environment),
      enabled: snapshot.task?.enabled ?? 'disabled',
      active: snapshot.task?.active ?? 'inactive',
      lingering: 'unsupported',
    };
  }

  async installDefinition(): Promise<void> {
    const before = this.backend.inspect(this.identity);
    this.sharedCreatedDuringInstall ||= !before.shared;
    this.sidFolderCreatedDuringInstall ||= !before.sidFolder;
    if (this.options.stageFiles) this.options.stageFiles();
    else this.stageImmutableFiles();
    this.backend.reconcile({
      identity: this.identity,
      definition: this.definition,
      expectedSddl: this.expectedSddl,
      sidFolderOwned: this.receiptOwnership.sidFolderOwned || this.sidFolderCreatedDuringInstall,
    });
  }

  private stageImmutableFiles(): void {
    const application = safeSourceFile(this.sourceApplication);
    const web = sourceTree(this.sourceWeb);
    const bootstrap = embeddedRuntimeAsset('service/windows/service-bootstrap.mjs').content;
    if (bootstrap == null) throw new Error('Windows service bootstrap is unavailable');
    const environment = Buffer.from(this.environment, 'utf8');
    if (existsSync(this.paths.versionRoot)) {
      if (inspectOwnerOnlyDirectory(this.paths.versionRoot).status !== 'ok'
          || inspectOwnerOnlyFile(this.paths.applicationPath).status !== 'ok'
          || inspectOwnerOnlyFile(this.paths.environmentPath).status !== 'ok'
          || !installedTreeIsOwnerOnly(this.paths.webRoot)) {
        throw new Error('unsafe existing Windows immutable service version');
      }
      if (!sameBytes(this.paths.applicationPath, application)
          || !sameBytes(this.paths.environmentPath, environment)
          || web.some((entry) => !sameBytes(win32.join(this.paths.webRoot, entry.relative), entry.bytes))) {
        throw new Error('Windows immutable service version collision');
      }
      const actualFiles = sourceTree(this.paths.webRoot).map((entry) => entry.relative.toLowerCase()).sort();
      const expectedFiles = web.map((entry) => entry.relative.toLowerCase()).sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error('Windows immutable service web version collision');
      }
    } else {
      ensureOwnerOnlyDirectory(this.paths.serviceRoot);
      ensureOwnerOnlyDirectory(this.paths.versionsRoot);
      ensureOwnerOnlyDirectory(this.paths.versionRoot);
      ensureOwnerOnlyDirectory(this.paths.webRoot);
      atomicWriteOwnerOnly(this.paths.applicationPath, application, { mode: 0o700 });
      for (const entry of web) {
        const target = win32.join(this.paths.webRoot, entry.relative);
        ensureOwnerOnlyDirectory(win32.dirname(target));
        atomicWriteOwnerOnly(target, entry.bytes, { mode: 0o600 });
      }
      atomicWriteOwnerOnly(this.paths.environmentPath, this.environment, { mode: 0o600 });
    }
    ensureOwnerOnlyDirectory(this.paths.logDirectory);
    atomicWriteOwnerOnly(this.paths.bootstrapPath, bootstrap, { mode: 0o700 });
    writeWindowsActiveInstall(
      this.paths.activeManifestPath,
      windowsActiveInstallManifest(this.identity.installationId, this.options.versionKey),
    );
  }

  async reloadDefinition(): Promise<void> { await this.installDefinition(); }
  async setEnabled(enabled: boolean): Promise<void> {
    this.backend.reconcile({
      identity: this.identity,
      definition: { ...this.definition, enabled },
      expectedSddl: this.expectedSddl,
      sidFolderOwned: this.receiptOwnership.sidFolderOwned || this.sidFolderCreatedDuringInstall,
    });
  }
  async enableLingering(): Promise<void> { throw new Error('task-scheduler-lingering-unsupported'); }
  async disableLingering(): Promise<void> { throw new Error('task-scheduler-lingering-unsupported'); }
  async start(): Promise<void> { this.backend.run(this.identity); }
  async stop(): Promise<void> { this.backend.stop(this.identity); }
  async restart(): Promise<void> { this.backend.stop(this.identity); this.backend.run(this.identity); }
  async uninstall(): Promise<void> {
    const removeFiles = this.filesystemReceiptsCurrent();
    if (removeFiles && this.inspectImmutableFilesystem() !== 'current') {
      throw new Error('Windows service filesystem ownership changed');
    }
    this.backend.uninstall({
      identity: this.identity,
      sidFolderOwned: this.receiptOwnership.sidFolderOwned || this.sidFolderCreatedDuringInstall,
      sharedFolderCreated: this.receiptOwnership.sharedFolderCreated || this.sharedCreatedDuringInstall,
    });
    if (removeFiles) this.removeOwnedFilesystem();
  }

  async finalizeCommitted(): Promise<void> {
    const active = inspectWindowsActiveInstall(this.paths.activeManifestPath);
    if (active.status !== 'ok' || active.manifest.installationId !== this.identity.installationId
        || active.manifest.versionKey !== this.options.versionKey
        || existsSync(win32.join(this.options.stateHome, 'transactions', 'setup.json'))) return;
    const target = windowsPriorVersionReceiptTarget(
      this.receiptResources,
      this.paths.versionsRoot,
      this.paths.versionRoot,
    );
    if (!target) return;
    const versionsRoot = `${win32.resolve(this.paths.versionsRoot)}\\`;
    if (!target.toLowerCase().startsWith(versionsRoot.toLowerCase())
        || win32.dirname(target).toLowerCase() !== win32.resolve(this.paths.versionsRoot).toLowerCase()
        || inspectOwnerOnlyDirectory(target).status !== 'ok') return;
    assertNoSymlinkComponents(target, false);
    rmSync(target, { recursive: true, force: false });
  }

  private filesystemReceiptsCurrent(): boolean {
    return windowsFilesystemReceiptMatches(this.receiptResources, {
      id: WINDOWS_BOOTSTRAP_RESOURCE_ID, kind: 'other', target: this.paths.bootstrapPath,
      ownership: { proof: 'receipt', marker: this.identity.installationId },
    }) && windowsFilesystemReceiptMatches(this.receiptResources, {
      id: WINDOWS_ACTIVE_INSTALL_RESOURCE_ID, kind: 'other', target: this.paths.activeManifestPath,
      ownership: { proof: 'receipt', marker: this.identity.installationId },
    }) && windowsFilesystemReceiptMatches(this.receiptResources, {
      id: WINDOWS_VERSION_RESOURCE_ID, kind: 'other', target: this.paths.versionRoot,
      ownership: { proof: 'receipt', marker: this.options.versionKey },
    }) && windowsFilesystemReceiptMatches(this.receiptResources, {
      id: 'service-environment', kind: 'environment-file', target: this.paths.environmentPath,
      ownership: { proof: 'receipt', marker: this.options.versionKey },
    });
  }

  private removeOwnedFilesystem(): void {
    assertNoSymlinkComponents(this.paths.versionRoot, false);
    rmSync(this.paths.versionRoot, { recursive: true, force: false });
    for (const path of [this.paths.activeManifestPath, this.paths.bootstrapPath]) {
      assertNoSymlinkComponents(path, true);
      rmSync(path, { force: false });
    }
    removeEmpty(this.paths.versionsRoot);
    removeEmpty(this.paths.serviceRoot);
    removeEmpty(win32.dirname(this.paths.serviceRoot));
  }
}
