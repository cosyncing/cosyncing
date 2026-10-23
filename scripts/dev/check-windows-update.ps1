param(
  [Parameter(Mandatory = $true)][string]$AuditDirectory,
  [Parameter(Mandatory = $true)][string]$SourceArchive,
  [Parameter(Mandatory = $true)][string]$RuntimeArchive,
  [string]$BaselineApplication = '',
  [string]$BaselineRuntime = '',
  [string]$Only = 'broker-upgrade',
  [switch]$All,
  [int]$Repeat = 1
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (Test-Path $AuditDirectory) { throw "audit directory already exists: $AuditDirectory" }
New-Item -ItemType Directory -Path $AuditDirectory | Out-Null
& tar.exe -xzf $SourceArchive -C $AuditDirectory
if ($LASTEXITCODE -ne 0) { throw 'source extraction failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($RuntimeArchive, (Join-Path $AuditDirectory 'output\native-tools'))
$Bun = Join-Path $AuditDirectory 'output\native-tools\bun-windows-x64\bun.exe'
Set-Location $AuditDirectory
$env:PATH = (Split-Path $Bun) + ';' + $env:PATH
& $Bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Windows dependency installation failed' }
New-Item -ItemType Directory -Force -Path 'output\windows-update-acceptance' | Out-Null
# Windows PowerShell 5.1 treats redirected native stderr as an ErrorRecord;
# the test runner uses it for ordinary progress as well as failures.
$ErrorActionPreference = 'Continue'
if ($BaselineApplication) {
  # The shared runner deliberately strips COSYNCING_* inherited variables.
  # Keep released-binary acceptance explicit and outside that sanitized lane.
  $env:COSYNCING_TEST_BASELINE_APPLICATION = $BaselineApplication
  if ($BaselineRuntime) { $env:COSYNCING_TEST_BASELINE_RUNTIME = $BaselineRuntime }
  for ($Iteration = 0; $Iteration -lt $Repeat; $Iteration++) {
    & $Bun test --timeout 120000 ./e2e/packaging/broker-upgrade.test.ts 2>&1 |
      ForEach-Object { "$_" } |
      Tee-Object -Append -FilePath 'output\windows-update-acceptance\released-baseline.log'
    if ($LASTEXITCODE -ne 0) { break }
  }
} else {
  $CheckArguments = @('run', 'check', 'windows', '--repeat', "$Repeat", '--no-retry')
  if (-not $All -and $Only) { $CheckArguments += @('--only', $Only) }
  & $Bun @CheckArguments 2>&1 |
    ForEach-Object { "$_" } |
    Tee-Object -FilePath 'output\windows-update-acceptance\check.log'
}
$Result = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Output "Native Windows update evidence: $AuditDirectory\output"
exit $Result
