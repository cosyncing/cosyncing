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

  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $Executable @Arguments 2>&1 | ForEach-Object { [string] $_ })
    [ordered]@{
      exitCode = $LASTEXITCODE
      output = ([string]::Join([Environment]::NewLine, $lines)).Trim()
    }
  } finally {
    $ErrorActionPreference = $saved
  }
}

function Get-JsonResult {
  param([Parameter(Mandatory = $true)] $Result)

  try {
    [ordered]@{
      exitCode = $Result.exitCode
      validJson = $true
      value = $Result.output | ConvertFrom-Json -ErrorAction Stop
    }
  } catch {
    [ordered]@{
      exitCode = $Result.exitCode
      validJson = $false
      value = $null
    }
  }
}

function Write-Utf8 {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $Value
  )

  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $utf8WithoutBom)
}

$runRoot = Split-Path -Parent $WorkingTree
$bun = Join-Path $runRoot 'toolchains\bun-1.4.0\bun-windows-x64\bun.exe'
$application = Join-Path $WorkingTree 'phase0-inputs\cosyncing'
foreach ($required in @($bun, $application)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw 'The behavior probe requires the runtime probe toolchain and staged application.'
  }
}

$probeRoot = Join-Path $runRoot 'behavior-probe'
New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null

$environmentScript = Join-Path $probeRoot 'environment.ts'
Write-Utf8 -Path $environmentScript -Value @'
import { homedir, tmpdir } from "node:os";
console.log(JSON.stringify({
  bunMainAbsolute: /^[A-Za-z]:\\/.test(Bun.main),
  execPathName: process.execPath.split(/[\\/]/).pop(),
  homeAbsolute: /^[A-Za-z]:\\/.test(homedir()),
  tempAbsolute: /^[A-Za-z]:\\/.test(tmpdir()),
  pathKey: Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? null,
  pathSeparator: ";",
  pathEntryCount: (process.env.Path ?? process.env.PATH ?? "").split(";").length,
  pathext: process.env.PATHEXT ?? null,
  localAppDataAbsolute: /^[A-Za-z]:\\/.test(process.env.LOCALAPPDATA ?? "")
}));
'@
$environment = Get-JsonResult -Result (Invoke-Captured -Executable $bun -Arguments @($environmentScript))

$argvScript = Join-Path $probeRoot 'argv.ts'
Write-Utf8 -Path $argvScript -Value @'
console.log(JSON.stringify(process.argv.slice(2)));
'@
$systemCom = Join-Path $env:SystemRoot 'System32\more.com'
$cmdWrapper = Join-Path $probeRoot 'argv-probe.cmd'
$batWrapper = Join-Path $probeRoot 'argv-probe.bat'
$wrapperBody = "@echo off`r`n`"$bun`" `"$argvScript`" %*`r`n"
Write-Utf8 -Path $cmdWrapper -Value $wrapperBody
Write-Utf8 -Path $batWrapper -Value $wrapperBody

$invocationDriver = Join-Path $probeRoot 'invocation.ts'
$driverSource = @'
const [bun, systemCom, script, cmdWrapper, batWrapper] = process.argv.slice(2, 7);
const expected = ["space value", "amp&value", "paren(value)", "Unicode-雪", "percent%value"];
async function run(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", shell: false });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
    ]);
    let argv = null;
    try { argv = JSON.parse(stdout.trim()); } catch {}
    return { started: true, exitCode, argvMatches: JSON.stringify(argv) === JSON.stringify(expected), stderrEmpty: stderr.length === 0 };
  } catch (error) {
    return { started: false, errorName: error instanceof Error ? error.name : "unknown" };
  }
}
const cmdExe = `${process.env.SystemRoot}\\System32\\cmd.exe`;
const throughCmd = (wrapper: string) => [cmdExe, "/d", "/c", wrapper, ...expected];
console.log(JSON.stringify({
  expectedCount: expected.length,
  exe: await run([bun, script, ...expected]),
  com: await run([systemCom, "/?"]),
  cmdDirect: await run([cmdWrapper, ...expected]),
  batDirect: await run([batWrapper, ...expected]),
  cmdExplicit: await run(throughCmd(cmdWrapper)),
  batExplicit: await run(throughCmd(batWrapper))
}));
'@
Write-Utf8 -Path $invocationDriver -Value $driverSource
$invocation = Get-JsonResult -Result (Invoke-Captured -Executable $bun -Arguments @(
  $invocationDriver, $bun, $systemCom, $argvScript, $cmdWrapper, $batWrapper
))

$fileRoot = Join-Path $probeRoot 'filesystem'
New-Item -ItemType Directory -Path $fileRoot -Force | Out-Null
$target = Join-Path $fileRoot 'active.json'
$replacement = Join-Path $fileRoot 'replacement.json'
$backup = Join-Path $fileRoot 'backup.json'
Write-Utf8 -Path $target -Value '{"generation":"old"}'
$targetAclBefore = Get-Acl -LiteralPath $target
Write-Utf8 -Path $replacement -Value '{"generation":"new"}'
[System.IO.File]::Replace($replacement, $target, $backup)
$targetAclAfter = Get-Acl -LiteralPath $target
$replaceResult = [ordered]@{
  contentSwitched = ((Get-Content -LiteralPath $target -Raw) -eq '{"generation":"new"}')
  backupHasOldContent = ((Get-Content -LiteralPath $backup -Raw) -eq '{"generation":"old"}')
  aclSddlPreserved = ($targetAclBefore.Sddl -eq $targetAclAfter.Sddl)
}

$lockedPath = Join-Path $fileRoot 'locked.txt'
Write-Utf8 -Path $lockedPath -Value 'locked'
$lock = [System.IO.File]::Open(
  $lockedPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::Read
)
$renameBlocked = $false
$deleteBlocked = $false
try {
  try {
    [System.IO.File]::Move($lockedPath, (Join-Path $fileRoot 'moved.txt'))
  } catch {
    $renameBlocked = $true
  }
  try {
    [System.IO.File]::Delete($lockedPath)
  } catch {
    $deleteBlocked = $true
  }
} finally {
  $lock.Dispose()
}
$childPath = Join-Path $fileRoot 'inherited.txt'
Write-Utf8 -Path $childPath -Value 'inherited'
$childAcl = Get-Acl -LiteralPath $childPath
$filesystem = [ordered]@{
  replaceFile = $replaceResult
  openFile = [ordered]@{
    renameBlockedWithoutDeleteSharing = $renameBlocked
    deleteBlockedWithoutDeleteSharing = $deleteBlocked
  }
  inheritance = [ordered]@{
    accessRulesProtected = $childAcl.AreAccessRulesProtected
    accessRuleCount = @($childAcl.Access).Count
  }
  directoryFsync = [ordered]@{
    supportedByUsedRuntimeApi = $false
    disposition = 'deferred-until-native-handle-provider'
  }
}

$childScript = Join-Path $probeRoot 'child.ts'
Write-Utf8 -Path $childScript -Value 'setInterval(() => {}, 1000);'
$serverScript = Join-Path $probeRoot 'server.ts'
Write-Utf8 -Path $serverScript -Value @'
import { writeFileSync } from "node:fs";
const [readyPath, childScript] = process.argv.slice(2);
const child = Bun.spawn([process.execPath, childScript], { stdout: "ignore", stderr: "ignore" });
const server = Bun.serve({ port: 0, fetch() { return new Response("phase0-ok"); } });
writeFileSync(readyPath, JSON.stringify({ pid: process.pid, childPid: child.pid, port: server.port }));
setInterval(() => {}, 1000);
'@
$readyPath = Join-Path $probeRoot 'server-ready.json'
Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
$processStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$serverProcess = Start-Process -FilePath $bun -ArgumentList @($serverScript, $readyPath, $childScript) -PassThru -WindowStyle Hidden
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -gt $deadline) {
      throw 'The process probe server did not report readiness.'
    }
    Start-Sleep -Milliseconds 100
  }
  $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
  $processStopwatch.Stop()
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($ready.pid)"
  $listener = Get-NetTCPConnection -State Listen -LocalPort ([int] $ready.port) -ErrorAction Stop |
    Select-Object -First 1
  $httpResult = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($ready.port)/" -TimeoutSec 5
  $taskkillStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $taskkill = Invoke-Captured -Executable (Join-Path $env:SystemRoot 'System32\taskkill.exe') -Arguments @(
    '/PID', [string] $ready.pid, '/T', '/F'
  )
  $taskkillStopwatch.Stop()
  Start-Sleep -Milliseconds 250
  $processEvidence = [ordered]@{
    readyLatencyMilliseconds = $processStopwatch.ElapsedMilliseconds
    pidMatchesCim = ([int] $cim.ProcessId -eq [int] $ready.pid)
    listenerPidMatches = ([int] $listener.OwningProcess -eq [int] $ready.pid)
    executableName = Split-Path -Leaf ([string] $cim.ExecutablePath)
    commandLineContainsProbeScript = ([string] $cim.CommandLine).Contains('server.ts')
    parentPidPresent = ([int] $cim.ParentProcessId -gt 0)
    creationTimePresent = ($null -ne $cim.CreationDate)
    loopbackBodyMatches = ([string] $httpResult.Content -eq 'phase0-ok')
    taskkillExitCode = $taskkill.exitCode
    taskkillTreeLatencyMilliseconds = $taskkillStopwatch.ElapsedMilliseconds
    parentTerminated = ($null -eq (Get-Process -Id ([int] $ready.pid) -ErrorAction SilentlyContinue))
    childTerminated = ($null -eq (Get-Process -Id ([int] $ready.childPid) -ErrorAction SilentlyContinue))
    culture = [System.Globalization.CultureInfo]::CurrentCulture.Name
  }
} finally {
  if (-not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

$report = [ordered]@{
  schemaVersion = 1
  lane = 'native-windows-phase0-behavior'
  effects = 'run-local-files-and-ephemeral-process-tree'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  environment = $environment
  invocation = $invocation
  filesystem = $filesystem
  process = $processEvidence
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$json = $report | ConvertTo-Json -Depth 14
Write-Utf8 -Path $OutputPath -Value ($json + [Environment]::NewLine)
Write-Output 'Native Windows Phase 0 behavior probe completed.'
