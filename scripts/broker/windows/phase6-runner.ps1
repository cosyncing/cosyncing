param(
  [Parameter(Mandatory = $true)][string]$ProbePath,
  [Parameter(Mandatory = $true)][string]$CandidateRoot,
  [Parameter(Mandatory = $true)][string]$ProbeRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$SourceDirty,
  # Environment does not cross the WSL boundary on its own, so the operator's exclusive-use
  # declaration is carried as a parameter rather than assumed to have been inherited.
  [Parameter(Mandatory = $false)][ValidateSet('true', 'false')][string]$ExclusiveAgent = 'false'
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

# A PowerShell started from WSL inherits the environment WSL was launched with, so a per-user PATH entry
# added after that point is invisible. Pi's npm prefix is exactly such an entry, and resolving `pi` is the
# thing under test, so the machine and user PATH are re-read from the registry rather than trusted.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'

# Own PID, written where the Linux side can find it. Interrupting the staging script kills a WSL
# interop process, not this one: without this, a cancelled run keeps going on the Windows side and a
# second run then races it for the operator's agent directory. Observed exactly once.
Set-Content -LiteralPath (Join-Path $runRoot 'runner.pid') -Value $PID -Encoding ascii
$env:COSYNCING_WINDOWS_PHASE6_RUN_ID = $RunId
$env:COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT = $SourceCommit
$env:COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY = $SourceDirty
if ($ExclusiveAgent -eq 'true') { $env:COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT = '1' }
else { Remove-Item Env:\COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT -ErrorAction SilentlyContinue }
$reports = @()
$bootstrapBun = Install-Bun '1.3.8'
Push-Location $CandidateRoot
try {
  $installOutput = @(& $bootstrapBun install --frozen-lockfile 2>&1 | ForEach-Object { [string] $_ })
  if ($LASTEXITCODE -ne 0) { throw ([string]::Join([Environment]::NewLine, $installOutput)) }
} finally {
  Pop-Location
}
foreach ($version in @('1.3.8', '1.4.0')) {
  $bun = if ($version -eq '1.3.8') { $bootstrapBun } else { Install-Bun $version }
  $env:COSYNCING_WINDOWS_PHASE6_ROOT = Join-Path $ProbeRoot $version
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @(& $bun run $ProbePath 2>&1 | ForEach-Object { [string] $_ }) }
  finally { $ErrorActionPreference = $savedErrorActionPreference }
  if ($LASTEXITCODE -ne 0) { throw ([string]::Join([Environment]::NewLine, $output)) }
  $reports += ($output -join [Environment]::NewLine) | ConvertFrom-Json
}
$reports | ConvertTo-Json -Depth 8
