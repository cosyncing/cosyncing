param(
  [Parameter(Mandatory = $true)][string]$ProbePath,
  [Parameter(Mandatory = $true)][string]$ProbeRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$SourceDirty
)
$ErrorActionPreference = 'Stop'
$runRoot = Split-Path -Parent $ProbeRoot
$downloads = Join-Path $runRoot 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
function Install-Bun([string]$Version) {
  $archive = Join-Path $downloads "bun-$Version.zip"
  $destination = Join-Path $runRoot "bun-$Version"
  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$Version/bun-windows-x64.zip" `
    -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $destination
  return Join-Path $destination 'bun-windows-x64\bun.exe'
}
$env:COSYNCING_WINDOWS_PHASE3_ROOT = $ProbeRoot
$env:COSYNCING_WINDOWS_PHASE3_RUN_ID = $RunId
$env:COSYNCING_WINDOWS_PHASE3_SOURCE_COMMIT = $SourceCommit
$env:COSYNCING_WINDOWS_PHASE3_SOURCE_DIRTY = $SourceDirty
$reports = @()
foreach ($version in @('1.3.8', '1.4.0')) {
  $bun = Install-Bun $version
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @(& $bun run $ProbePath 2>&1 | ForEach-Object { [string] $_ }) }
  finally { $ErrorActionPreference = $savedErrorActionPreference }
  if ($LASTEXITCODE -ne 0) { throw ([string]::Join([Environment]::NewLine, $output)) }
  $reports += ($output -join [Environment]::NewLine) | ConvertFrom-Json
}
$reports | ConvertTo-Json -Depth 8
