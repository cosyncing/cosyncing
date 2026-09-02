param(
  [Parameter(Mandatory = $true)][string]$ProbePath,
  [Parameter(Mandatory = $true)][string]$CandidateRoot,
  [Parameter(Mandatory = $true)][string]$ProbeRoot,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$SourceDirty,
  # Environment does not cross the WSL boundary on its own, so the operator's exclusive-use
  # declaration is carried as a parameter rather than assumed to have been inherited.
  [Parameter(Mandatory = $false)][ValidateSet('true', 'false')][string]$ExclusiveAgent = 'false',
  # Bun runtimes are ~90MB each and identical between runs; a shared cache turns the largest cost of
  # a run into a one-time one. Evidence is unaffected: the same pinned versions are executed.
  [Parameter(Mandatory = $false)][string]$BunCache = '',
  # Which runtimes to exercise. Both for evidence; one while iterating. A report names the runtime of
  # every lane it ran, so a single-lane run cannot be mistaken for a two-lane one.
  [Parameter(Mandatory = $false)][string]$Lanes = '1.3.8,1.4.0',
  # Probe-specific settings, as `NAME=value` pairs separated by `;`. Environment does not cross the
  # WSL boundary on its own (see ExclusiveAgent above), and a probe that takes options had no way to
  # receive them. Names are restricted to this project's own prefix so this cannot be used to reach
  # PATH, credentials, or anything else the probe inherits from the host.
  [Parameter(Mandatory = $false)][string]$ProbeEnv = ''
)
$ErrorActionPreference = 'Stop'
$runRoot = Split-Path -Parent $ProbeRoot
$downloads = Join-Path $runRoot 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
function Install-Bun([string]$Version) {
  if ($BunCache) {
    $cached = Join-Path $BunCache "bun-$Version\bun-windows-x64\bun.exe"
    if (Test-Path -LiteralPath $cached) { return $cached }
  }
  $archive = Join-Path $downloads "bun-$Version.zip"
  $destination = if ($BunCache) { Join-Path $BunCache "bun-$Version" } else { Join-Path $runRoot "bun-$Version" }
  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$Version/bun-windows-x64.zip" `
    -OutFile $archive
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
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
# The probe process keeps the cwd it inherited across the WSL boundary, which is the WSL checkout
# reached over \\wsl.localhost — NOT the NTFS candidate this run staged. A probe that resolved the
# tree from its own cwd therefore measured the wrong tree over a network redirector, and the Phase 7
# survey did exactly that: every suite resolved its workspace links against the WSL repository and
# failed on ENOENT before running a line of its own. The candidate root and the lane's pinned Bun are
# named here so no probe has to infer either.
$env:COSYNCING_WINDOWS_PHASE6_CANDIDATE_ROOT = $CandidateRoot
$env:COSYNCING_WINDOWS_PHASE6_RUN_ID = $RunId
$env:COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT = $SourceCommit
$env:COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY = $SourceDirty
if ($ExclusiveAgent -eq 'true') { $env:COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT = '1' }
else { Remove-Item Env:\COSYNCING_WINDOWS_PHASE6_EXCLUSIVE_AGENT -ErrorAction SilentlyContinue }
$probeEnvNames = @()
foreach ($pair in @($ProbeEnv -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  $split = $pair.IndexOf('=')
  if ($split -lt 1) { throw "ProbeEnv entries must be NAME=value: $pair" }
  $name = $pair.Substring(0, $split)
  if ($name -notmatch '^COSYNCING_[A-Z0-9_]{1,64}$') { throw "ProbeEnv name is not permitted: $name" }
  Set-Item -Path "Env:\$name" -Value $pair.Substring($split + 1)
  $probeEnvNames += $name
}

$reports = @()
$laneVersions = @($Lanes -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($laneVersions.Count -eq 0) { throw 'No Bun lanes requested.' }
$bootstrapBun = Install-Bun $laneVersions[0]
Push-Location $CandidateRoot
try {
  $installOutput = @(& $bootstrapBun install --frozen-lockfile 2>&1 | ForEach-Object { [string] $_ })
  if ($LASTEXITCODE -ne 0) { throw ([string]::Join([Environment]::NewLine, $installOutput)) }
} finally {
  Pop-Location
}
foreach ($version in $laneVersions) {
  $bun = if ($version -eq $laneVersions[0]) { $bootstrapBun } else { Install-Bun $version }
  $env:COSYNCING_WINDOWS_PHASE6_ROOT = Join-Path $ProbeRoot $version
  $env:COSYNCING_WINDOWS_PHASE6_BUN = $bun
  $savedErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @(& $bun run $ProbePath 2>&1 | ForEach-Object { [string] $_ }) }
  finally { $ErrorActionPreference = $savedErrorActionPreference }
  if ($LASTEXITCODE -ne 0) { throw ([string]::Join([Environment]::NewLine, $output)) }
  $reports += ($output -join [Environment]::NewLine) | ConvertFrom-Json
}
$reports | ConvertTo-Json -Depth 8
