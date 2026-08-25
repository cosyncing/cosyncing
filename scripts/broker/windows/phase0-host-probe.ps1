param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath,

  [Parameter(Mandatory = $true)]
  [string] $WorkingTree,

  [Parameter(Mandatory = $true)]
  [string] $CandidateRevision,

  [Parameter(Mandatory = $true)]
  [ValidateSet('true', 'false')]
  [string] $CandidateDirty,

  [Parameter(Mandatory = $true)]
  [ValidateSet('clean-commit', 'dirty-working-tree')]
  [string] $CandidateArchiveMode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $WorkingTree

function Get-VolumeEvidence {
  param([Parameter(Mandatory = $true)][string] $Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $root = [System.IO.Path]::GetPathRoot($resolved)
  if (-not $root -or $root.StartsWith('\\')) {
    throw 'Expected a local drive path, not a filesystem-provider or UNC path.'
  }
  $driveLetter = $root.Substring(0, 1)
  $volume = Get-Volume -DriveLetter $driveLetter
  [ordered]@{
    drive = $driveLetter.ToUpperInvariant()
    fileSystem = [string] $volume.FileSystem
    nativeNtfs = ([string] $volume.FileSystem -eq 'NTFS')
  }
}

function Get-ToolEvidence {
  param([Parameter(Mandatory = $true)][string] $Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  [ordered]@{
    available = ($null -ne $command)
    commandType = if ($null -eq $command) { $null } else { [string] $command.CommandType }
  }
}

$workingTreeVolume = Get-VolumeEvidence -Path $WorkingTree
if (-not $workingTreeVolume.nativeNtfs) {
  throw 'Phase 0 probes must execute from an NTFS staging tree.'
}
$processWorkingDirectoryVolume = Get-VolumeEvidence -Path (Get-Location).Path
if (-not $processWorkingDirectoryVolume.nativeNtfs) {
  throw 'The native probe process working directory must be on NTFS.'
}
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$localAppDataVolume = Get-VolumeEvidence -Path $localAppData

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$computerSystem = Get-CimInstance Win32_ComputerSystem

$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$rootFolder = $scheduler.GetFolder([string][char]92)
$rootDescriptorReadable = [bool] ($rootFolder.GetSecurityDescriptor(15))
$cosyncingFolderExists = $true
try {
  $null = $scheduler.GetFolder('\Cosyncing')
} catch {
  if ($_.Exception.HResult -ne -2147024894) {
    throw
  }
  $cosyncingFolderExists = $false
}

$report = [ordered]@{
  schemaVersion = 1
  lane = 'native-windows-phase0-host'
  effects = 'read-only-except-staging-and-report'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  candidate = [ordered]@{
    revision = $CandidateRevision
    dirty = ($CandidateDirty -eq 'true')
    archiveMode = $CandidateArchiveMode
  }
  host = [ordered]@{
    caption = [string] $operatingSystem.Caption
    version = [Environment]::OSVersion.Version.ToString()
    build = [string] $operatingSystem.BuildNumber
    architecture = [string] $computerSystem.SystemType
    administrator = $isAdministrator
    powershell = [ordered]@{
      version = $PSVersionTable.PSVersion.ToString()
      edition = [string] $PSVersionTable.PSEdition
      languageMode = [string] $ExecutionContext.SessionState.LanguageMode
    }
  }
  filesystems = [ordered]@{
    workingTree = $workingTreeVolume
    processWorkingDirectory = $processWorkingDirectoryVolume
    localAppData = $localAppDataVolume
  }
  tooling = [ordered]@{
    bun = Get-ToolEvidence -Name 'bun.exe'
    node = Get-ToolEvidence -Name 'node.exe'
    npm = Get-ToolEvidence -Name 'npm.cmd'
    cosyncing = Get-ToolEvidence -Name 'cosyncing.cmd'
    agents = [ordered]@{
      opencode = Get-ToolEvidence -Name 'opencode'
      pi = Get-ToolEvidence -Name 'pi'
      claude = Get-ToolEvidence -Name 'claude'
      codex = Get-ToolEvidence -Name 'codex'
      kimi = Get-ToolEvidence -Name 'kimi'
    }
  }
  taskScheduler = [ordered]@{
    rootSecurityDescriptorReadable = $rootDescriptorReadable
    createFolderApi = [bool] ($rootFolder.PSObject.Methods.Name -contains 'CreateFolder')
    deleteFolderApi = [bool] ($rootFolder.PSObject.Methods.Name -contains 'DeleteFolder')
    cosyncingFolderExists = $cosyncingFolderExists
  }
  limitations = @(
    'No task, task-folder, DACL, process, or package mutation was attempted.'
    'Tool availability does not qualify broker launch or npm acquisition.'
    'External connectivity is operator-owned and is not probed, inspected, or mutated.'
  )
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$json = $report | ConvertTo-Json -Depth 12
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, $utf8WithoutBom)
Write-Output 'Native Windows Phase 0 host probe completed.'
