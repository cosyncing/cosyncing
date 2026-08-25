param(
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$BunPath,
  [Parameter(Mandatory = $true)][string]$ProbePath
)

$ErrorActionPreference = 'Stop'
$env:COSYNCING_PHASE1_SOURCE_COMMIT = $SourceCommit
$env:COSYNCING_PHASE1_RUN_ID = $RunId
& $BunPath $ProbePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
