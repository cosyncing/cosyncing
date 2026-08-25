import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import {
  WINDOWS_TASK_NAME,
  WINDOWS_TASK_ROOT_PATH,
  windowsTaskSchedulerCanonicalSddl,
  type WindowsScheduledTaskDefinition,
  type WindowsScheduledTaskIdentity,
  type WindowsTaskSchedulerSnapshot,
} from './windows-task-scheduler.ts';

const POWERSHELL_TIMEOUT_MS = 30_000;
const POWERSHELL_MAX_BUFFER = 512 * 1024;
const INVALID_TEXT = /[\0\r\n]/;

export type WindowsTaskSchedulerOperation =
  | 'current-user'
  | 'inspect'
  | 'reconcile'
  | 'restore'
  | 'set-enabled'
  | 'run'
  | 'stop'
  | 'uninstall';

export interface WindowsTaskSchedulerExecutor {
  execute(operation: WindowsTaskSchedulerOperation, input: Readonly<Record<string, unknown>>): unknown;
}

export interface WindowsTaskSchedulerSpawnResult {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export type WindowsTaskSchedulerSpawn = (
  executable: string,
  args: readonly string[],
  options: Readonly<{
    encoding: 'utf8';
    input: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  }>,
) => WindowsTaskSchedulerSpawnResult;

export const WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$operation = [Environment]::GetEnvironmentVariable('COSYNCING_SCHEDULER_OPERATION', 'Process')
$encodedInput = [Environment]::GetEnvironmentVariable('COSYNCING_SCHEDULER_INPUT', 'Process')
if ([string]::IsNullOrWhiteSpace($encodedInput)) { throw 'missing scheduler input' }
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedInput))
$payload = $payloadJson | ConvertFrom-Json
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($operation -eq 'current-user') {
  [ordered]@{ currentUserSid = $currentSid } | ConvertTo-Json -Compress
  exit 0
}
$root = $scheduler.GetFolder('\')
$notFound = -2147024894

function Get-FolderOrNull([string] $path) {
  try { return $scheduler.GetFolder($path) } catch {
    if ($_.Exception.HResult -eq $notFound) { return $null }
    throw
  }
}

function Get-TaskOrNull($folder, [string] $name) {
  if ($null -eq $folder) { return $null }
  try { return $folder.GetTask($name) } catch {
    if ($_.Exception.HResult -eq $notFound) { return $null }
    throw
  }
}

function Get-Marker($task) {
  if ($null -eq $task) { return $null }
  return [string] $task.Definition.RegistrationInfo.Description
}

function Resolve-Sid([string] $identity) {
  if ([string]::IsNullOrWhiteSpace($identity)) { return '' }
  if ($identity.StartsWith('S-')) { return $identity }
  try {
    return (New-Object Security.Principal.NTAccount($identity)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    return ''
  }
}

function Get-FolderSnapshot($folder, [string] $path) {
  if ($null -eq $folder) { return $null }
  $children = @($folder.GetFolders(0) | ForEach-Object { [string] $_.Name } | Sort-Object)
  $tasks = @($folder.GetTasks(1) | ForEach-Object {
    [ordered]@{ name = [string] $_.Name; ownershipMarker = Get-Marker $_ }
  } | Sort-Object -Property name)
  return [ordered]@{
    path = $path
    sddl = [string] $folder.GetSecurityDescriptor(7)
    childFolders = $children
    tasks = $tasks
  }
}

function Get-TaskDefinition($task) {
  if ($null -eq $task) { return $null }
  $definition = $task.Definition
  if ($definition.Actions.Count -ne 1 -or $definition.Triggers.Count -ne 1) { return $null }
  $action = $definition.Actions.Item(1)
  $trigger = $definition.Triggers.Item(1)
  if ($action.Type -ne 0 -or $trigger.Type -ne 9) { return $null }
  $restartCount = [int] $definition.Settings.RestartCount
  $restartInterval = [string] $definition.Settings.RestartInterval
  return [ordered]@{
    principalSid = Resolve-Sid ([string] $definition.Principal.UserId)
    runLevel = if ([int] $definition.Principal.RunLevel -eq 0) { 'least-privilege' } else { 'highest' }
    logonType = if ([int] $definition.Principal.LogonType -eq 3) { 'interactive-token' } else { 'other' }
    executable = [string] $action.Path
    arguments = [string] $action.Arguments
    workingDirectory = [string] $action.WorkingDirectory
    triggers = @($(if ((Resolve-Sid ([string] $trigger.UserId)) -eq [string] $payload.sid) {
      'logon-current-user'
    } else { 'other' }))
    settings = [ordered]@{
      logonTriggerEnabled = [bool] $trigger.Enabled
      allowDemandStart = [bool] $definition.Settings.AllowDemandStart
      executionTimeLimit = if ([string] $definition.Settings.ExecutionTimeLimit -eq 'PT0S') { 'none' } else { 'bounded' }
      restartOnFailure = ($restartCount -eq 3 -and $restartInterval -eq 'PT1M')
      restartCount = $restartCount
      restartInterval = $restartInterval
      multipleInstances = if ([int] $definition.Settings.MultipleInstances -eq 2) { 'ignore-new' } else { 'other' }
      allowStartOnBattery = -not [bool] $definition.Settings.DisallowStartIfOnBatteries
      doNotStopOnBattery = -not [bool] $definition.Settings.StopIfGoingOnBatteries
      startWhenAvailable = [bool] $definition.Settings.StartWhenAvailable
    }
    enabled = [bool] $task.Enabled
  }
}

function Get-Snapshot {
  $shared = Get-FolderOrNull ([string] $payload.sharedPath)
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  $taskSnapshot = if ($null -eq $task) { $null } else {
    $state = [int] $task.State
    [ordered]@{
      path = [string] $payload.taskPath
      ownershipMarker = Get-Marker $task
      definition = Get-TaskDefinition $task
      taskSddl = [string] $task.GetSecurityDescriptor(7)
      enabled = if ([bool] $task.Enabled) { 'enabled' } else { 'disabled' }
      active = if ($state -eq 4) { 'active' } elseif ($state -eq 0) { 'unknown' } else { 'inactive' }
      lastResult = [int] $task.LastTaskResult
      xml = [string] $task.Xml
    }
  }
  return [ordered]@{
    currentUserSid = $currentSid
    shared = Get-FolderSnapshot $shared ([string] $payload.sharedPath)
    sidFolder = Get-FolderSnapshot $sidFolder ([string] $payload.sidFolderPath)
    task = $taskSnapshot
  }
}

function Assert-OwnedTask($task) {
  if ($null -eq $task) { return }
  if ((Get-Marker $task) -ne [string] $payload.ownershipMarker) {
    throw 'scheduler task ownership conflict'
  }
}

function Test-ExpectedSddl($value) {
  return ([string] $value -eq [string] $payload.expectedSddl -or [string] $value -eq [string] $payload.canonicalSddl)
}

function Assert-EmptyFolder($folder) {
  if ($null -eq $folder) { return }
  if ($folder.GetFolders(0).Count -ne 0 -or $folder.GetTasks(1).Count -ne 0) {
    throw 'scheduler folder contains foreign children'
  }
}

function Register-ExpectedTask($sidFolder) {
  $definition = $scheduler.NewTask(0)
  $definition.RegistrationInfo.Description = [string] $payload.ownershipMarker
  $definition.Principal.UserId = [string] $payload.sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = [bool] $payload.definition.enabled
  $definition.Settings.AllowDemandStart = [bool] $payload.definition.settings.allowDemandStart
  $definition.Settings.StartWhenAvailable = [bool] $payload.definition.settings.startWhenAvailable
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.MultipleInstances = 2
  $definition.Settings.DisallowStartIfOnBatteries = -not [bool] $payload.definition.settings.allowStartOnBattery
  $definition.Settings.StopIfGoingOnBatteries = -not [bool] $payload.definition.settings.doNotStopOnBattery
  $definition.Settings.RestartCount = [int] $payload.definition.settings.restartCount
  $definition.Settings.RestartInterval = [string] $payload.definition.settings.restartInterval
  $trigger = $definition.Triggers.Create(9)
  $trigger.Enabled = [bool] $payload.definition.settings.logonTriggerEnabled
  $trigger.UserId = [string] $payload.sid
  $action = $definition.Actions.Create(0)
  $action.Path = [string] $payload.definition.executable
  $action.Arguments = [string] $payload.definition.arguments
  $action.WorkingDirectory = [string] $payload.definition.workingDirectory
  $task = $sidFolder.RegisterTaskDefinition(
    [string] $payload.taskName, $definition, 6, $null, $null, 3, [string] $payload.expectedSddl
  )
  $task.SetSecurityDescriptor([string] $payload.expectedSddl, 16)
}

function Set-OwnedTaskEnabled($sidFolder, $task, [bool] $enabled) {
  Assert-OwnedTask $task
  $sddl = [string] $task.GetSecurityDescriptor(7)
  $definition = $task.Definition
  $definition.Settings.Enabled = $enabled
  $updated = $sidFolder.RegisterTaskDefinition(
    [string] $payload.taskName, $definition, 6, $null, $null, 3, $sddl
  )
  $updated.SetSecurityDescriptor($sddl, 16)
  return $updated
}

if ($operation -eq 'inspect') {
  # Read-only.
} elseif ($operation -eq 'reconcile') {
  $shared = Get-FolderOrNull ([string] $payload.sharedPath)
  if ($null -eq $shared) {
    $shared = $root.CreateFolder('Cosyncing', [string] $payload.expectedSddl)
  } elseif (-not (Test-ExpectedSddl ([string] $shared.GetSecurityDescriptor(7)))) {
    throw 'scheduler shared folder identity conflict'
  }
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  if ($null -eq $sidFolder) {
    $sidFolder = $shared.CreateFolder([string] $payload.sid, [string] $payload.expectedSddl)
  } else {
    if (-not [bool] $payload.sidFolderOwned) { throw 'scheduler SID folder ownership conflict' }
    $foreignFolders = @($sidFolder.GetFolders(0))
    $foreignTasks = @($sidFolder.GetTasks(1) | Where-Object {
      $_.Name -ne [string] $payload.taskName -or (Get-Marker $_) -ne [string] $payload.ownershipMarker
    })
    if ($foreignFolders.Count -ne 0 -or $foreignTasks.Count -ne 0) {
      throw 'scheduler SID folder contains foreign children'
    }
    if (-not (Test-ExpectedSddl ([string] $sidFolder.GetSecurityDescriptor(7)))) {
      $sidFolder.SetSecurityDescriptor([string] $payload.expectedSddl, 0)
    }
  }
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  Assert-OwnedTask $task
  Register-ExpectedTask $sidFolder
} elseif ($operation -eq 'set-enabled') {
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  if ($null -eq $task) { throw 'scheduler task is missing' }
  $null = Set-OwnedTaskEnabled $sidFolder $task ([bool] $payload.enabled)
} elseif ($operation -eq 'run') {
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  if ($null -eq $task) { throw 'scheduler task is missing' }
  Assert-OwnedTask $task
  $null = $task.Run($null)
} elseif ($operation -eq 'stop') {
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  if ($null -ne $task) { Assert-OwnedTask $task; $task.Stop(0) }
} elseif ($operation -eq 'uninstall') {
  $shared = Get-FolderOrNull ([string] $payload.sharedPath)
  $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
  $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
  if ($null -ne $task) { Assert-OwnedTask $task; $sidFolder.DeleteTask([string] $payload.taskName, 0) }
  if ($null -ne $sidFolder -and [bool] $payload.sidFolderOwned) {
    Assert-EmptyFolder $sidFolder
    $shared.DeleteFolder([string] $payload.sid, 0)
  }
  if ($null -ne $shared -and [bool] $payload.sharedFolderCreated) {
    Assert-EmptyFolder $shared
    $root.DeleteFolder('Cosyncing', 0)
  }
} elseif ($operation -eq 'restore') {
  $prior = $payload.snapshot
  $shared = Get-FolderOrNull ([string] $payload.sharedPath)
  if ($null -eq $prior.shared) {
    $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
    $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
    if ($null -ne $task) { Assert-OwnedTask $task; $sidFolder.DeleteTask([string] $payload.taskName, 0) }
    if ($null -ne $sidFolder) { Assert-EmptyFolder $sidFolder; $shared.DeleteFolder([string] $payload.sid, 0) }
    if ($null -ne $shared) { Assert-EmptyFolder $shared; $root.DeleteFolder('Cosyncing', 0) }
  } else {
    if ($null -eq $shared) { throw 'scheduler shared folder disappeared during transaction' }
    $shared.SetSecurityDescriptor([string] $prior.shared.sddl, 0)
    $sidFolder = Get-FolderOrNull ([string] $payload.sidFolderPath)
    if ($null -eq $prior.sidFolder) {
      $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
      if ($null -ne $task) { Assert-OwnedTask $task; $sidFolder.DeleteTask([string] $payload.taskName, 0) }
      if ($null -ne $sidFolder) { Assert-EmptyFolder $sidFolder; $shared.DeleteFolder([string] $payload.sid, 0) }
    } else {
      if ($null -eq $sidFolder) { throw 'scheduler SID folder disappeared during transaction' }
      $task = Get-TaskOrNull $sidFolder ([string] $payload.taskName)
      if ($null -eq $prior.task) {
        if ($null -ne $task) { Assert-OwnedTask $task; $sidFolder.DeleteTask([string] $payload.taskName, 0) }
      } else {
        if ($null -ne $task) { Assert-OwnedTask $task }
        $restored = $sidFolder.RegisterTask(
          [string] $payload.taskName, [string] $prior.task.xml, 6, $null, $null, 3, [string] $prior.task.taskSddl
        )
        $restored.SetSecurityDescriptor([string] $prior.task.taskSddl, 16)
        $restored = Set-OwnedTaskEnabled $sidFolder $restored ([string] $prior.task.enabled -eq 'enabled')
        if ([string] $prior.task.active -eq 'active') { $null = $restored.Run($null) }
      }
      $sidFolder.SetSecurityDescriptor([string] $prior.sidFolder.sddl, 0)
    }
  }
} else {
  throw 'invalid scheduler operation'
}

Get-Snapshot | ConvertTo-Json -Compress -Depth 16
`;

function powershellExecutable(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) throw new Error('Windows SystemRoot is unavailable for Task Scheduler');
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export class NativeWindowsTaskSchedulerExecutor implements WindowsTaskSchedulerExecutor {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly spawn: WindowsTaskSchedulerSpawn = spawnSync as WindowsTaskSchedulerSpawn,
  ) {}

  execute(operation: WindowsTaskSchedulerOperation, input: Readonly<Record<string, unknown>>): unknown {
    const encodedInput = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
    const result = this.spawn(
      powershellExecutable(this.env),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      {
        encoding: 'utf8',
        input: WINDOWS_TASK_SCHEDULER_POWERSHELL_SOURCE,
        env: {
          ...this.env,
          COSYNCING_SCHEDULER_OPERATION: operation,
          COSYNCING_SCHEDULER_INPUT: encodedInput,
        },
        maxBuffer: POWERSHELL_MAX_BUFFER,
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      const detail = stderr.slice(Math.max(0, stderr.length - 2_048));
      throw new Error(`Windows Task Scheduler ${operation} failed${detail ? `: ${detail}` : ''}`);
    }
    return JSON.parse(result.stdout.trim());
  }
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !INVALID_TEXT.test(value);
}

function validTaskXml(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 * 1024 && !value.includes('\0');
}

function parseSnapshot(value: unknown, identity: WindowsScheduledTaskIdentity): WindowsTaskSchedulerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid scheduler snapshot');
  const snapshot = value as WindowsTaskSchedulerSnapshot;
  if (snapshot.currentUserSid !== identity.sid) throw new Error('scheduler current-user SID mismatch');
  for (const folder of [snapshot.shared, snapshot.sidFolder]) {
    if (!folder) continue;
    if (!validString(folder.path) || !validString(folder.sddl)
        || !Array.isArray(folder.childFolders) || !Array.isArray(folder.tasks)) {
      throw new Error('invalid scheduler folder snapshot');
    }
  }
  if ((snapshot.shared && snapshot.shared.path !== WINDOWS_TASK_ROOT_PATH)
      || (snapshot.sidFolder && snapshot.sidFolder.path !== identity.sidFolderPath)) {
    throw new Error('scheduler snapshot path mismatch');
  }
  if (snapshot.task) {
    if (snapshot.task.path !== identity.taskPath
        || !['enabled', 'disabled', 'unknown'].includes(snapshot.task.enabled)
        || !['active', 'inactive', 'unknown'].includes(snapshot.task.active)
        || (snapshot.task.xml !== undefined && !validTaskXml(snapshot.task.xml))) {
      throw new Error('invalid scheduler task snapshot');
    }
  }
  return structuredClone(snapshot);
}

function commonInput(identity: WindowsScheduledTaskIdentity): Record<string, unknown> {
  return {
    sid: identity.sid,
    sharedPath: WINDOWS_TASK_ROOT_PATH,
    sidFolderPath: identity.sidFolderPath,
    taskPath: identity.taskPath,
    taskName: WINDOWS_TASK_NAME,
    ownershipMarker: identity.ownershipMarker,
  };
}

export class WindowsTaskSchedulerPowerShellBackend {
  constructor(private readonly executor: WindowsTaskSchedulerExecutor = new NativeWindowsTaskSchedulerExecutor()) {}

  currentUserSid(): string {
    const result = this.executor.execute('current-user', {});
    const sid = result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).currentUserSid
      : undefined;
    if (typeof sid !== 'string' || !/^S-1-(?:\d+-){1,14}\d+$/.test(sid)) {
      throw new Error('invalid scheduler current-user SID');
    }
    return sid;
  }

  inspect(identity: WindowsScheduledTaskIdentity): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('inspect', commonInput(identity)), identity);
  }

  reconcile(options: {
    identity: WindowsScheduledTaskIdentity;
    definition: WindowsScheduledTaskDefinition;
    expectedSddl: string;
    sidFolderOwned: boolean;
  }): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('reconcile', {
      ...commonInput(options.identity),
      definition: options.definition,
      expectedSddl: options.expectedSddl,
      canonicalSddl: windowsTaskSchedulerCanonicalSddl(options.identity.sid),
      sidFolderOwned: options.sidFolderOwned,
    }), options.identity);
  }

  restore(options: {
    identity: WindowsScheduledTaskIdentity;
    snapshot: WindowsTaskSchedulerSnapshot;
  }): WindowsTaskSchedulerSnapshot {
    const snapshot = parseSnapshot(options.snapshot, options.identity);
    return parseSnapshot(this.executor.execute('restore', {
      ...commonInput(options.identity),
      snapshot,
    }), options.identity);
  }

  setEnabled(identity: WindowsScheduledTaskIdentity, enabled: boolean): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('set-enabled', {
      ...commonInput(identity), enabled,
    }), identity);
  }

  run(identity: WindowsScheduledTaskIdentity): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('run', commonInput(identity)), identity);
  }

  stop(identity: WindowsScheduledTaskIdentity): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('stop', commonInput(identity)), identity);
  }

  uninstall(options: {
    identity: WindowsScheduledTaskIdentity;
    sidFolderOwned: boolean;
    sharedFolderCreated: boolean;
  }): WindowsTaskSchedulerSnapshot {
    return parseSnapshot(this.executor.execute('uninstall', {
      ...commonInput(options.identity),
      sidFolderOwned: options.sidFolderOwned,
      sharedFolderCreated: options.sharedFolderCreated,
    }), options.identity);
  }
}
