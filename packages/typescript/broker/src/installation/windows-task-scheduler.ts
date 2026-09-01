import type { InstalledResourceRecord } from './install-state.ts';
import type { DurableServiceOwnership } from './service-manager.ts';

export const WINDOWS_TASK_ROOT_PATH = '\\Cosyncing';
export const WINDOWS_TASK_NAME = 'Broker';
export const WINDOWS_TASK_OWNERSHIP_VERSION = 1 as const;
export const WINDOWS_TASK_SECURITY_PROFILE_VERSION = 1 as const;
export const WINDOWS_TASK_RESOURCE_ID = 'service-task-scheduler';
export const WINDOWS_SID_FOLDER_RESOURCE_ID = 'service-task-scheduler-sid-folder';
export const WINDOWS_SHARED_FOLDER_RESOURCE_ID = 'service-task-scheduler-shared-folder';

const WINDOWS_SID = /^S-1-(?:\d+-){1,14}\d+$/;
const SAFE_INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WindowsScheduledTaskDefinition {
  principalSid: string;
  runLevel: 'least-privilege' | 'highest' | 'other';
  logonType: 'interactive-token' | 'other';
  executable: string;
  /** Exact Task Scheduler ExecAction argument string. */
  arguments: string;
  workingDirectory: string;
  triggers: ReadonlyArray<'logon-current-user' | 'other'>;
  settings: {
    logonTriggerEnabled: boolean;
    allowDemandStart: boolean;
    executionTimeLimit: 'none' | 'bounded';
    restartOnFailure: boolean;
    restartCount: number;
    restartInterval: string;
    multipleInstances: 'ignore-new' | 'other';
    allowStartOnBattery: boolean;
    doNotStopOnBattery: boolean;
    startWhenAvailable: boolean;
  };
  enabled: boolean;
}

export interface WindowsScheduledTaskSnapshot {
  path: string;
  ownershipMarker?: string;
  definition?: WindowsScheduledTaskDefinition;
  taskSddl?: string;
  enabled: 'enabled' | 'disabled' | 'unknown';
  active: 'active' | 'inactive' | 'unknown';
  lastResult?: number;
  /** Exact registered XML used only for transactional restoration. */
  xml?: string;
}

export interface WindowsTaskSchedulerSnapshot {
  currentUserSid: string;
  shared?: WindowsTaskFolderSnapshot;
  sidFolder?: WindowsTaskFolderSnapshot;
  task?: WindowsScheduledTaskSnapshot;
}

export interface WindowsTaskSchedulerReceiptOwnership {
  sidFolderOwned: boolean;
  sharedFolderCreated: boolean;
}

export interface WindowsScheduledTaskIdentity {
  installationId: string;
  sid: string;
  sidFolderPath: string;
  taskPath: string;
  ownershipMarker: string;
}

export type WindowsScheduledTaskOwnership = 'missing' | 'owned' | 'conflict' | 'unknown';
export type WindowsScheduledTaskDefinitionHealth = 'missing' | 'current' | 'drifted' | 'unknown';

export interface WindowsScheduledTaskClassification {
  ownership: WindowsScheduledTaskOwnership;
  definition: WindowsScheduledTaskDefinitionHealth;
}

export interface WindowsTaskFolderSnapshot {
  path: string;
  sddl?: string;
  childFolders: readonly string[];
  tasks: ReadonlyArray<{ name: string; ownershipMarker?: string }>;
}

export type WindowsSharedTaskFolderHealth = 'missing' | 'current' | 'conflict' | 'unknown';
export type WindowsOwnedTaskFolderHealth = 'missing' | 'current' | 'drifted' | 'conflict' | 'unknown';

export interface WindowsTaskFolderClassification {
  shared: WindowsSharedTaskFolderHealth;
  sidFolder: WindowsOwnedTaskFolderHealth;
  foreignChildren: string[];
}

function validSid(value: string): string {
  if (!WINDOWS_SID.test(value)) throw new Error('invalid Windows service SID');
  return value;
}

function validInstallationId(value: string): string {
  if (!SAFE_INSTALLATION_ID.test(value)) throw new Error('invalid Windows installation id');
  return value;
}

export function windowsScheduledTaskIdentity(
  installationId: string,
  sid: string,
): WindowsScheduledTaskIdentity {
  const cleanInstallationId = validInstallationId(installationId);
  const cleanSid = validSid(sid);
  const sidFolderPath = `${WINDOWS_TASK_ROOT_PATH}\\${cleanSid}`;
  return {
    installationId: cleanInstallationId,
    sid: cleanSid,
    sidFolderPath,
    taskPath: `${sidFolderPath}\\${WINDOWS_TASK_NAME}`,
    ownershipMarker: `cosyncing:task-scheduler:v${WINDOWS_TASK_OWNERSHIP_VERSION}:${cleanInstallationId}`,
  };
}

/**
 * Versioned descriptor used for every scheduler object created by the login-scoped Windows provider.
 * The supplied descriptor contains the protected DACL only. Native inspection adds exact owner/group fields;
 * {@link windowsTaskSchedulerSddlMatches} admits only these two representations of the same descriptor.
 */
export function windowsTaskSchedulerSddl(sid: string): string {
  const cleanSid = validSid(sid);
  return `D:PAI(A;;FA;;;${cleanSid})(A;;FA;;;SY)(A;;FA;;;BA)`;
}

/** Task Scheduler adds the current principal as owner and primary group when storing this exact DACL. */
export function windowsTaskSchedulerCanonicalSddl(sid: string): string {
  const cleanSid = validSid(sid);
  return `O:${cleanSid}G:${cleanSid}${windowsTaskSchedulerSddl(cleanSid)}`;
}

export function windowsTaskSchedulerSddlMatches(actual: string | undefined, sid: string): boolean {
  return actual === windowsTaskSchedulerSddl(sid) || actual === windowsTaskSchedulerCanonicalSddl(sid);
}

function receiptOwns(
  resources: readonly InstalledResourceRecord[],
  id: string,
  target: string,
): boolean {
  const normalizedTarget = target.toLowerCase();
  return resources.some((resource) => resource.id === id
    && resource.kind === 'other'
    && resource.ownership.proof === 'receipt'
    && resource.target.toLowerCase() === normalizedTarget);
}

/**
 * Exactly ONE receipt, matching in every field that identifies it.
 *
 * `.some()` is not enough for an ownership decision: two receipts under one id mean the state file
 * disagrees with itself about what we installed, and picking whichever matches is choosing the answer.
 * Missing, duplicated, wrong-target, wrong-kind and wrong-marker all fail here, and all mean the same
 * thing — the receipt does not prove we put the object there.
 */
export function exactlyOneWindowsReceipt(
  resources: readonly InstalledResourceRecord[],
  id: string,
  expected: { target: string; kind: InstalledResourceRecord['kind']; marker?: string },
): boolean {
  const matches = resources.filter((resource) => resource.id === id);
  if (matches.length !== 1) return false;
  const resource = matches[0]!;
  return resource.kind === expected.kind
    && resource.ownership.proof === 'receipt'
    // Windows paths are case-insensitive, so the comparison has to be too.
    && resource.target.toLowerCase() === expected.target.toLowerCase()
    // STRICT, undefined included. `expected.marker === undefined || ...` accepted any marker on a receipt
    // where none was expected -- the SID-folder receipt -- so a record carrying a foreign marker passed a
    // check whose whole purpose is that the receipt matches exactly. "No marker expected" means the
    // receipt must not carry one.
    && resource.ownership.marker === expected.marker;
}

/**
 * The ownership verdict for a Windows install: are these objects OURS, independently of whether they are
 * healthy. Drift is deliberately owned — an environment file with unexpected contents, or a task whose
 * action needs repair, is still one we installed, and reconciling it is exactly what setup is for. Only a
 * foreign marker, a contested folder, or evidence that does not add up denies ownership.
 */
export function windowsTaskSchedulerOwnership(options: {
  resources: readonly InstalledResourceRecord[];
  identity: WindowsScheduledTaskIdentity;
  environmentPath: string;
  versionKey: string;
  task: WindowsScheduledTaskClassification;
  folders: WindowsTaskFolderClassification;
}): DurableServiceOwnership {
  const receiptsProveTask = exactlyOneWindowsReceipt(options.resources, WINDOWS_TASK_RESOURCE_ID, {
    target: options.identity.taskPath,
    kind: 'service',
    // The marker is the immutable identity written into the task itself; a receipt naming a different
    // installation is evidence of a DIFFERENT install, not of this one.
    marker: options.identity.ownershipMarker,
  }) && exactlyOneWindowsReceipt(options.resources, WINDOWS_SID_FOLDER_RESOURCE_ID, {
    target: options.identity.sidFolderPath,
    kind: 'other',
  });
  const folderOwned = options.folders.sidFolder === 'current' || options.folders.sidFolder === 'drifted';
  const folderDenies = options.folders.sidFolder === 'conflict';
  const definition: DurableServiceOwnership['definition'] =
    options.task.ownership === 'conflict' || folderDenies
      ? 'unowned'
      : options.task.ownership === 'owned' && folderOwned && receiptsProveTask
        ? 'owned'
        : 'unknown';
  return {
    definition,
    // The environment IS a file, but its ownership is still receipt-borne rather than hashed: the version
    // key is what says this installation wrote it. Contents are a health question, answered elsewhere.
    environment: exactlyOneWindowsReceipt(options.resources, 'service-environment', {
      target: options.environmentPath,
      kind: 'environment-file',
      marker: options.versionKey,
    })
      ? 'owned'
      : 'unowned',
  };
}

/** Folder mutation authority comes only from exact receipts, never from installationId by itself. */
export function windowsTaskSchedulerReceiptOwnership(
  resources: readonly InstalledResourceRecord[],
  identity: WindowsScheduledTaskIdentity,
): WindowsTaskSchedulerReceiptOwnership {
  return {
    sidFolderOwned: receiptOwns(resources, WINDOWS_SID_FOLDER_RESOURCE_ID, identity.sidFolderPath),
    sharedFolderCreated: receiptOwns(resources, WINDOWS_SHARED_FOLDER_RESOURCE_ID, WINDOWS_TASK_ROOT_PATH),
  };
}

/** Shared-container compatibility and SID-folder ownership are separate decisions. */
export function classifyWindowsTaskFolders(options: {
  identity: WindowsScheduledTaskIdentity;
  expectedSddl: string;
  shared?: WindowsTaskFolderSnapshot;
  sidFolder?: WindowsTaskFolderSnapshot;
  sidFolderReceiptOwned: boolean;
}): WindowsTaskFolderClassification {
  const shared: WindowsSharedTaskFolderHealth = !options.shared
    ? 'missing'
    : options.shared.path !== WINDOWS_TASK_ROOT_PATH || !options.shared.sddl
      ? 'unknown'
      : windowsTaskSchedulerSddlMatches(options.shared.sddl, options.identity.sid) ? 'current' : 'conflict';
  if (!options.sidFolder) return { shared, sidFolder: 'missing', foreignChildren: [] };
  if (options.sidFolder.path !== options.identity.sidFolderPath || !options.sidFolder.sddl) {
    return { shared, sidFolder: 'unknown', foreignChildren: [] };
  }
  const foreignChildren = [
    ...options.sidFolder.childFolders.map((name) => `folder:${name}`),
    ...options.sidFolder.tasks
      .filter((task) => task.name !== WINDOWS_TASK_NAME
        || task.ownershipMarker !== options.identity.ownershipMarker)
      .map((task) => `task:${task.name}`),
  ].sort();
  if (!options.sidFolderReceiptOwned || foreignChildren.length > 0) {
    return { shared, sidFolder: 'conflict', foreignChildren };
  }
  return {
    shared,
    sidFolder: windowsTaskSchedulerSddlMatches(options.sidFolder.sddl, options.identity.sid) ? 'current' : 'drifted',
    foreignChildren,
  };
}

function sameDefinition(
  actual: WindowsScheduledTaskDefinition,
  expected: WindowsScheduledTaskDefinition,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Ownership is immutable identity evidence. Definition health is deliberately separate: an owned task with
 * drifted action, principal, trigger, settings, or enabled state remains repairable and is never reclassified
 * as a foreign collision merely because it needs repair.
 */
export function classifyWindowsScheduledTask(options: {
  actual?: WindowsScheduledTaskSnapshot;
  expectedIdentity: WindowsScheduledTaskIdentity;
  expectedDefinition: WindowsScheduledTaskDefinition;
}): WindowsScheduledTaskClassification {
  if (!options.actual) return { ownership: 'missing', definition: 'missing' };
  if (options.actual.path !== options.expectedIdentity.taskPath
      || typeof options.actual.ownershipMarker !== 'string') {
    return { ownership: 'conflict', definition: 'unknown' };
  }
  if (options.actual.ownershipMarker !== options.expectedIdentity.ownershipMarker) {
    return { ownership: 'conflict', definition: 'unknown' };
  }
  if (!options.actual.definition) return { ownership: 'owned', definition: 'unknown' };
  return {
    ownership: 'owned',
    definition: sameDefinition(options.actual.definition, options.expectedDefinition) ? 'current' : 'drifted',
  };
}
