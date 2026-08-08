param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RuntimeArguments
)

$ErrorActionPreference = 'Stop'

$RepositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '../..')
$ClientRoot = Join-Path $RepositoryRoot 'apps/client'

if (-not (Test-Path (Join-Path $ClientRoot 'pubspec.yaml'))) {
  Write-Error 'apps/client/pubspec.yaml is missing from the cosyncing monorepo.'
  exit 2
}

if (-not (Get-Command dart -ErrorAction SilentlyContinue)) {
  Write-Error 'dart was not found on PATH.'
  exit 2
}

Push-Location $ClientRoot
& dart tool/voice_runtime_validation.dart @RuntimeArguments
$ExitCode = $LASTEXITCODE
Pop-Location
exit $ExitCode
