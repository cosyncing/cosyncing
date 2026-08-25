param(
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$ProbePath,
  [Parameter(Mandatory = $true)][string]$ProbeRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$SourceDirty
)

$ErrorActionPreference = 'Stop'
$env:COSYNCING_WINDOWS_PHASE2_ROOT = $ProbeRoot
$env:COSYNCING_WINDOWS_PHASE2_RUN_ID = $RunId
$env:COSYNCING_WINDOWS_PHASE2_SOURCE_COMMIT = $SourceCommit
$env:COSYNCING_WINDOWS_PHASE2_SOURCE_DIRTY = $SourceDirty
& $BunPath run $ProbePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
