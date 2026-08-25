param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath,

  [Parameter(Mandatory = $true)]
  [string] $WorkingTree,

  [Parameter(Mandatory = $true)]
  [string] $RunId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $WorkingTree

function Write-Utf8 {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $Value
  )

  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $utf8WithoutBom)
}

function Get-DaclAceCount {
  param([Parameter(Mandatory = $true)][string] $Sddl)
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl)
  if ($null -eq $descriptor.DiscretionaryAcl) {
    return 0
  }
  $descriptor.DiscretionaryAcl.Count
}

$runRoot = Split-Path -Parent $WorkingTree
$bun = Join-Path $runRoot 'toolchains\bun-1.4.0\bun-windows-x64\bun.exe'
if (-not (Test-Path -LiteralPath $bun -PathType Leaf)) {
  throw 'The scheduler probe requires the run-local Bun toolchain.'
}

$safeRunId = $RunId -replace '[^A-Za-z0-9_-]', '-'
$topName = "CosyncingPhase0-$safeRunId"
$topPath = "\$topName"
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$sidName = "SID-$sid"
$childPath = "$topPath\$sidName"
$taskName = 'Broker'
$taskOutput = Join-Path $runRoot 'scheduler-action.json'
$taskScript = Join-Path $runRoot 'scheduler-action.ts'
Remove-Item -LiteralPath $taskOutput -Force -ErrorAction SilentlyContinue
Write-Utf8 -Path $taskScript -Value @'
import { appendFileSync } from "node:fs";
const output = process.argv[2];
appendFileSync(output, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
'@

$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$root = $scheduler.GetFolder('\')
$rootSddlBefore = $root.GetSecurityDescriptor(7)
$top = $null
$child = $null
$registered = $null
$topCreated = $false
$childCreated = $false
$taskCreated = $false
$evidence = $null

try {
  try {
    [void] $scheduler.GetFolder($topPath)
    throw 'The disposable scheduler folder already exists; refusing to adopt it.'
  } catch {
    if ($_.Exception.HResult -ne -2147024894) {
      throw
    }
    # Expected: the run-specific folder is absent. Windows PowerShell may
    # surface HRESULT 0x80070002 as either COMException or FileNotFoundException.
  }

  $top = $root.CreateFolder($topName, $null)
  $topCreated = $true
  $topSddl = $top.GetSecurityDescriptor(7)
  $top.SetSecurityDescriptor($topSddl, 0)
  $topSddlRoundTrip = $top.GetSecurityDescriptor(7)

  $child = $top.CreateFolder($sidName, $null)
  $childCreated = $true
  $childSddl = $child.GetSecurityDescriptor(7)
  $child.SetSecurityDescriptor($childSddl, 0)
  $childSddlRoundTrip = $child.GetSecurityDescriptor(7)

  $definition = $scheduler.NewTask(0)
  $definition.RegistrationInfo.Description = 'Disposable Cosyncing native Windows Phase 0 probe'
  $definition.Principal.UserId = $sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.AllowDemandStart = $true
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.ExecutionTimeLimit = 'PT1M'
  $definition.Settings.MultipleInstances = 2
  $logonTrigger = $definition.Triggers.Create(9)
  $logonTrigger.Enabled = $true
  $logonTrigger.UserId = $sid
  $action = $definition.Actions.Create(0)
  $action.Path = $bun
  $action.Arguments = "`"$taskScript`" `"$taskOutput`""
  $action.WorkingDirectory = $runRoot

  $registered = $child.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null)
  $taskCreated = $true
  $taskSddl = $registered.GetSecurityDescriptor(7)
  # TASK_DONT_ADD_PRINCIPAL_ACE keeps a descriptor restore from silently
  # appending another allow ACE for the registration principal.
  $registered.SetSecurityDescriptor($taskSddl, 16)
  $taskSddlRoundTrip = $registered.GetSecurityDescriptor(7)
  $registeredDefinition = $registered.Definition
  $registeredPrincipal = [string] $registeredDefinition.Principal.UserId
  try {
    if ($registeredPrincipal.StartsWith('S-')) {
      $registeredPrincipalSid = $registeredPrincipal
    } else {
      $registeredPrincipalSid = (New-Object System.Security.Principal.NTAccount(
        $registeredPrincipal
      )).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
  } catch {
    $registeredPrincipalSid = $null
  }

  $firstRun = $registered.Run($null)
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ((-not (Test-Path -LiteralPath $taskOutput -PathType Leaf)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  $firstCompleted = Test-Path -LiteralPath $taskOutput -PathType Leaf
  if ($firstCompleted) {
    $registered.Run($null) | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (@(Get-Content -LiteralPath $taskOutput -ErrorAction SilentlyContinue).Count -lt 2 -and
      [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
  }
  $runCount = if (Test-Path -LiteralPath $taskOutput -PathType Leaf) {
    @(Get-Content -LiteralPath $taskOutput).Count
  } else {
    0
  }

  $evidence = [ordered]@{
    nonAdministrator = -not $isAdministrator
    disposablePathRedacted = '\CosyncingPhase0-<run>\SID-<sid>\Broker'
    folderSecurity = [ordered]@{
      rootReadable = -not [string]::IsNullOrWhiteSpace($rootSddlBefore)
      topReadable = -not [string]::IsNullOrWhiteSpace($topSddl)
      childReadable = -not [string]::IsNullOrWhiteSpace($childSddl)
      topReplacementRoundTrip = ($topSddl -eq $topSddlRoundTrip)
      childReplacementRoundTrip = ($childSddl -eq $childSddlRoundTrip)
      folderDescriptorsAreDistinctObjects = ($topPath -ne $childPath)
    }
    taskSecurity = [ordered]@{
      readable = -not [string]::IsNullOrWhiteSpace($taskSddl)
      textualRoundTripEqual = ($taskSddl -eq $taskSddlRoundTrip)
      daclAceCountPreserved = ((Get-DaclAceCount -Sddl $taskSddl) -eq
        (Get-DaclAceCount -Sddl $taskSddlRoundTrip))
      differsFromChildFolder = ($taskSddl -ne $childSddl)
    }
    definition = [ordered]@{
      actionCount = $registeredDefinition.Actions.Count
      directBunAction = ($registeredDefinition.Actions.Item(1).Path -eq $bun)
      workingDirectoryOnRunVolume = ($registeredDefinition.Actions.Item(1).WorkingDirectory -eq $runRoot)
      principalResolvesToCurrentSid = ($registeredPrincipalSid -eq $sid)
      logonType = $registeredDefinition.Principal.LogonType
      runLevel = $registeredDefinition.Principal.RunLevel
      logonTriggerPresent = ($registeredDefinition.Triggers.Count -eq 1 -and
        $registeredDefinition.Triggers.Item(1).Type -eq 9)
      xmlRetrievable = -not [string]::IsNullOrWhiteSpace($registered.Xml)
    }
    execution = [ordered]@{
      firstRunCompleted = $firstCompleted
      repeatedRunCount = $runCount
      lastTaskResult = $registered.LastTaskResult
      internalFileSinkRequired = $true
      schedulerStdoutSinkAvailable = $false
      consoleWindowDisposition = 'not-observable-from-unattended-session'
    }
    deferred = @(
      'sleep-resume'
      'logout-login'
      'visual-console-window-check'
      'second-ordinary-user-denial'
    )
  }
} finally {
  if ($taskCreated -and $null -ne $child) {
    $child.DeleteTask($taskName, 0)
    $taskCreated = $false
  }
  if ($childCreated -and $null -ne $top) {
    $top.DeleteFolder($sidName, 0)
    $childCreated = $false
  }
  if ($topCreated) {
    $root.DeleteFolder($topName, 0)
    $topCreated = $false
  }
}

$rootSddlAfter = $root.GetSecurityDescriptor(7)
$rollback = [ordered]@{
  rootSecurityUnchanged = ($rootSddlBefore -eq $rootSddlAfter)
  taskRemoved = $true
  childFolderRemoved = $true
  topFolderRemoved = $true
}
try {
  [void] $scheduler.GetFolder($topPath)
  $rollback.topFolderRemoved = $false
} catch {
  if ($_.Exception.HResult -ne -2147024894) {
    throw
  }
  # Expected after rollback.
}

$report = [ordered]@{
  schemaVersion = 1
  lane = 'native-windows-phase0-scheduler'
  effects = 'disposable-task-folder-task-and-rollback'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  evidence = $evidence
  rollback = $rollback
}
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Write-Utf8 -Path $OutputPath -Value (($report | ConvertTo-Json -Depth 14) + [Environment]::NewLine)
Write-Output 'Native Windows Phase 0 scheduler probe completed and rolled back.'
