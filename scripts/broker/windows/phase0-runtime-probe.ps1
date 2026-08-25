param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath,

  [Parameter(Mandatory = $true)]
  [string] $WorkingTree
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $WorkingTree

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string[]] $Arguments
  )

  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $Executable @Arguments 2>&1 | ForEach-Object { [string] $_ })
    [ordered]@{
      exitCode = $LASTEXITCODE
      output = ([string]::Join([Environment]::NewLine, $lines)).Trim()
    }
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
}

function Convert-JsonSummary {
  param([Parameter(Mandatory = $true)] $Result)

  try {
    $value = $Result.output | ConvertFrom-Json -ErrorAction Stop
    $diagnosticCodes = @()
    $hostDiagnosticCode = $null
    if ($value.PSObject.Properties['sections']) {
      $checks = @($value.sections | ForEach-Object { @($_.checks) })
      $diagnosticCodes = @($checks | Where-Object { $_.status -eq 'fail' } |
        ForEach-Object { [string] $_.detailCode })
      $hostCheck = $checks | Where-Object { $_.id -eq 'host.platform' } | Select-Object -First 1
      if ($null -ne $hostCheck) {
        $hostDiagnosticCode = [string] $hostCheck.detailCode
      }
    }
    [ordered]@{
      exitCode = $Result.exitCode
      validJson = $true
      version = if ($value.PSObject.Properties['version']) { [string] $value.version } else { $null }
      distribution = if ($value.PSObject.Properties['distribution']) {
        [string] $value.distribution
      } else {
        $null
      }
      ok = if ($value.PSObject.Properties['ok']) { [bool] $value.ok } else { $null }
      commit = if ($value.PSObject.Properties['commit']) { [string] $value.commit } else { $null }
      dirty = if ($value.PSObject.Properties['dirty']) { [bool] $value.dirty } else { $null }
      buildDate = if ($value.PSObject.Properties['buildDate']) { [string] $value.buildDate } else { $null }
      hostDiagnosticCode = $hostDiagnosticCode
      failingDiagnosticCodes = $diagnosticCodes
    }
  } catch {
    [ordered]@{
      exitCode = $Result.exitCode
      validJson = $false
      version = $null
      distribution = $null
      ok = $null
      commit = $null
      dirty = $null
      buildDate = $null
      hostDiagnosticCode = $null
      failingDiagnosticCodes = @()
    }
  }
}

function Install-Archive {
  param(
    [Parameter(Mandatory = $true)][string] $Url,
    [Parameter(Mandatory = $true)][string] $Archive,
    [Parameter(Mandatory = $true)][string] $Destination
  )

  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}

$runRoot = Split-Path -Parent $WorkingTree
$toolchainRoot = Join-Path $runRoot 'toolchains'
$downloadRoot = Join-Path $toolchainRoot 'downloads'
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

$bunFloorArchive = Join-Path $downloadRoot 'bun-1.3.8-windows-x64.zip'
$bunCurrentArchive = Join-Path $downloadRoot 'bun-1.4.0-windows-x64.zip'
$nodeArchive = Join-Path $downloadRoot 'node-v24.19.0-win-x64.zip'
$bunFloorRoot = Join-Path $toolchainRoot 'bun-1.3.8'
$bunCurrentRoot = Join-Path $toolchainRoot 'bun-1.4.0'
$nodeRoot = Join-Path $toolchainRoot 'node-24.19.0'

Install-Archive `
  -Url 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.8/bun-windows-x64.zip' `
  -Archive $bunFloorArchive `
  -Destination $bunFloorRoot
Install-Archive `
  -Url 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip' `
  -Archive $bunCurrentArchive `
  -Destination $bunCurrentRoot
Install-Archive `
  -Url 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' `
  -Archive $nodeArchive `
  -Destination $nodeRoot

$bunFloor = Join-Path $bunFloorRoot 'bun-windows-x64\bun.exe'
$bunCurrent = Join-Path $bunCurrentRoot 'bun-windows-x64\bun.exe'
$nodeDirectory = Join-Path $nodeRoot 'node-v24.19.0-win-x64'
$node = Join-Path $nodeDirectory 'node.exe'
$npm = Join-Path $nodeDirectory 'npm.cmd'
$application = Join-Path $WorkingTree 'phase0-inputs\cosyncing'
foreach ($required in @($bunFloor, $bunCurrent, $node, $npm, $application)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw 'A required runtime probe input is missing after staging.'
  }
}

$bunFloorVersion = Invoke-Captured -Executable $bunFloor -Arguments @('--version')
$bunCurrentVersion = Invoke-Captured -Executable $bunCurrent -Arguments @('--version')
$nodeVersion = Invoke-Captured -Executable $node -Arguments @('--version')
$npmVersion = Invoke-Captured -Executable $npm -Arguments @('--version')
$floorBundleVersion = Invoke-Captured -Executable $bunFloor -Arguments @(
  $application, 'version', '--json'
)
$currentBundleVersion = Invoke-Captured -Executable $bunCurrent -Arguments @(
  $application, 'version', '--json'
)
$currentDoctor = Invoke-Captured -Executable $bunCurrent -Arguments @(
  $application, 'doctor', '--json'
)

$probePackage = Join-Path $runRoot 'npm-probe-package'
$probeBin = Join-Path $probePackage 'bin'
New-Item -ItemType Directory -Path $probeBin -Force | Out-Null
Copy-Item -LiteralPath $application -Destination (Join-Path $probeBin 'cosyncing')
$packageJson = [ordered]@{
  name = 'cosyncing-phase0-probe'
  version = '0.0.0-phase0'
  private = $true
  bin = [ordered]@{
    cosyncing = 'bin/cosyncing'
    cosy = 'bin/cosyncing'
  }
}
$packageJson | ConvertTo-Json -Depth 4 | Set-Content `
  -LiteralPath (Join-Path $probePackage 'package.json') `
  -Encoding UTF8

$npmPrefix = Join-Path $runRoot 'npm-prefix'
$savedPath = $env:Path
$env:Path = "$($bunCurrent | Split-Path -Parent);$nodeDirectory;$savedPath"
try {
  $npmInstall = Invoke-Captured -Executable $npm -Arguments @(
    'install', '--global', '--ignore-scripts', '--prefix', $npmPrefix, $probePackage
  )
  $cosyncingShim = Join-Path $npmPrefix 'cosyncing.cmd'
  $cosyShim = Join-Path $npmPrefix 'cosy.cmd'
  $cosyncingShimVersion = if (Test-Path -LiteralPath $cosyncingShim) {
    Invoke-Captured -Executable $cosyncingShim -Arguments @('version', '--json')
  } else {
    [ordered]@{ exitCode = -1; output = '' }
  }
  $cosyShimVersion = if (Test-Path -LiteralPath $cosyShim) {
    Invoke-Captured -Executable $cosyShim -Arguments @('version', '--json')
  } else {
    [ordered]@{ exitCode = -1; output = '' }
  }
} finally {
  $env:Path = $savedPath
}

$report = [ordered]@{
  schemaVersion = 1
  lane = 'native-windows-phase0-runtime'
  effects = 'run-local-downloads-and-npm-prefix'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  toolchains = [ordered]@{
    bunFloor = [ordered]@{
      expected = '1.3.8'
      observed = $bunFloorVersion.output
      exitCode = $bunFloorVersion.exitCode
    }
    bunCurrent = [ordered]@{
      expected = '1.4.0'
      observed = $bunCurrentVersion.output
      exitCode = $bunCurrentVersion.exitCode
    }
    nodeLts = [ordered]@{
      expected = 'v24.19.0'
      observed = $nodeVersion.output
      exitCode = $nodeVersion.exitCode
    }
    npm = [ordered]@{
      expected = '11.17.0'
      observed = $npmVersion.output
      exitCode = $npmVersion.exitCode
    }
  }
  brokerBundle = [ordered]@{
    bunFloor = Convert-JsonSummary -Result $floorBundleVersion
    bunCurrent = Convert-JsonSummary -Result $currentBundleVersion
    doctor = Convert-JsonSummary -Result $currentDoctor
  }
  npmPrefix = [ordered]@{
    installExitCode = $npmInstall.exitCode
    cosyncingShim = (Test-Path -LiteralPath (Join-Path $npmPrefix 'cosyncing.cmd'))
    cosyShim = (Test-Path -LiteralPath (Join-Path $npmPrefix 'cosy.cmd'))
    cosyncingShimVersion = Convert-JsonSummary -Result $cosyncingShimVersion
    cosyShimVersion = Convert-JsonSummary -Result $cosyShimVersion
  }
  limitations = @(
    'The npm probe package exercises real npm global shim generation but is not the release tarball.'
    'The product package still excludes win32 by policy, so ordinary Windows acquisition remains gated.'
    'No machine-wide PATH or package installation was changed.'
  )
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$json = $report | ConvertTo-Json -Depth 12
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, $utf8WithoutBom)
Write-Output 'Native Windows Phase 0 runtime probe completed.'
