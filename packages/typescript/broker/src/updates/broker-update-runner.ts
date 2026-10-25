import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectInstallState } from '../installation/install-state.ts';
import { inspectWindowsActiveInstall, windowsServiceActiveManifestPath, windowsServiceInstallPaths,
  windowsServiceVersionKey } from '../installation/windows-service-install.ts';
import { WINDOWS_UPDATE_TASK_CLEANUP_POWERSHELL } from '../installation/windows-task-scheduler-powershell.ts';
import { WINDOWS_TASK_ROOT_PATH } from '../installation/windows-task-scheduler.ts';
import { atomicWriteJsonOwnerOnly, atomicWriteOwnerOnly, ensureOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { releaseIdVersion } from './release-upgrade.ts';
import type { BrokerUpdateTriggerDependencies } from './broker-update.ts';

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Preserve the authenticated engine outside the trees its own transaction replaces. */
export function stageBrokerUpdateRunner(deps: BrokerUpdateTriggerDependencies): BrokerUpdateTriggerDependencies {
  if (deps.buildInfo.distribution !== 'bootstrap-js' || !deps.runtimePath) return deps;
  const state = inspectInstallState(deps.stateHome);
  const binary = state.committed && state.state.resources.find((row) => row.id === 'broker-binary');
  // Windows runs the same authenticated bundle from a versioned service root.
  // The active pointer must bind that root to this installation and build.
  const active = deps.service.provider === 'task-scheduler'
    ? inspectWindowsActiveInstall(windowsServiceActiveManifestPath(deps.stateHome)) : undefined;
  const runnerOwned = inspectOwnerOnlyFile(deps.executablePath).status === 'ok';
  const expectedApplication = active?.status === 'ok'
    ? windowsServiceInstallPaths(deps.stateHome, active.manifest.versionKey).applicationPath : undefined;
  const versionedApplication = runnerOwned && state.committed && active?.status === 'ok'
    && active.manifest.installationId === state.state.installationId
    && active.manifest.versionKey === windowsServiceVersionKey(deps.buildInfo)
    && expectedApplication !== undefined && inspectOwnerOnlyFile(expectedApplication).status === 'ok'
    // Bun.main expands Windows 8.3/case aliases; the receipt may retain them.
    // Native canonical equality still binds this to the exact active file.
    && realpathSync.native(expectedApplication) === realpathSync.native(deps.executablePath);
  if (!binary || (binary.target !== deps.executablePath && !versionedApplication)
      || !runnerOwned) {
    throw new Error('broker-update-runner-untrusted');
  }
  const bytes = readFileSync(deps.executablePath);
  if (createHash('sha256').update(bytes).digest('hex') !== binary.ownership.installedSha256) {
    throw new Error('broker-update-runner-untrusted');
  }
  const root = join(deps.stateHome, 'updates', 'runners', randomUUID());
  ensureOwnerOnlyDirectory(root);
  const application = join(root, 'runner.js'); atomicWriteOwnerOnly(application, bytes);
  // A reviewed release is fetched by its immutable tag; latest was discovery only.
  const version = deps.pinnedReleaseId && releaseIdVersion(deps.pinnedReleaseId);
  const manifestUrl = version
    ? `https://github.com/cosyncing/cosyncing/releases/download/broker-v${version}/release-manifest.json`
    : deps.manifestUrl;
  const staged = { ...deps, executablePath: application, ...(manifestUrl ? { manifestUrl } : {}) };
  if (deps.service.provider === 'task-scheduler') {
    // PATH can be large. Keep it in the protected runner directory rather than
    // encoding it twice into Windows' bounded process command line.
    const windowsPayloadPath = join(root, 'runner.json');
    atomicWriteJsonOwnerOnly(windowsPayloadPath, windowsPayload(staged));
    return { ...staged, windowsPayloadPath };
  }
  if (deps.service.provider !== 'launchd') return staged;
  const label = `dev.cosyncing.update.${root.split(/[\\/]/).at(-1)}`;
  const command = ['/usr/bin/env', `COSYNCING_HOME=${deps.stateHome}`,
    ...(deps.cacheRoot ? [`COSYNCING_CACHE_DIR=${deps.cacheRoot}`] : []),
    ...(deps.userHome ? [`HOME=${deps.userHome}`] : []),
    deps.runtimePath, application, 'upgrade', '--yes', '--json', '--components', 'broker',
    ...(deps.pinnedReleaseId ? ['--release', deps.pinnedReleaseId] : []),
    ...(deps.preparedJobId ? ['--prepared-job', deps.preparedJobId] : []),
    ...(manifestUrl ? ['--manifest', manifestUrl] : [])];
  const plist = join(root, 'runner.plist');
  atomicWriteOwnerOnly(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>WorkingDirectory</key><string>${xml(deps.userHome ?? root)}</string>
<key>StandardOutPath</key><string>${xml(join(root, 'result.json'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'error.log'))}</string>
</dict></plist>\n`);
  return { ...staged, launchdPlistPath: plist };
}

function windowsPayload(deps: BrokerUpdateTriggerDependencies) {
  return { runtime: deps.runtimePath, application: deps.executablePath,
    home: deps.stateHome, cache: deps.cacheRoot, userHome: deps.userHome, path: process.env.PATH, release: deps.pinnedReleaseId,
    manifest: deps.manifestUrl, preparedJob: deps.preparedJobId,
    name: `${WINDOWS_TASK_ROOT_PATH.slice(1)}-Update-${randomUUID()}` };
}

/** An independent per-user demand task; no passwords, elevation or broker job object. */
export function windowsBrokerUpdateCommand(deps: BrokerUpdateTriggerDependencies): string[] | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const powershell = deps.windowsPowerShellPath ?? (systemRoot && join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  if (!powershell || !deps.runtimePath) return undefined;
  const readPayload = deps.windowsPayloadPath
    ? `$p = [IO.File]::ReadAllText('${deps.windowsPayloadPath.replaceAll("'", "''")}') | ConvertFrom-Json`
    : `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(windowsPayload(deps))).toString('base64')}')) | ConvertFrom-Json`;
  const worker = `$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
${readPayload}
$env:COSYNCING_HOME = $p.home
if ($p.cache) { $env:COSYNCING_CACHE_DIR = $p.cache }
# Use the service's tool discovery context, not Task Scheduler's login PATH.
# Otherwise the CLI can discover different agents and rewrite their service paths.
if ($p.path) { $env:PATH = $p.path + ';' + [Environment]::GetFolderPath([Environment+SpecialFolder]::System) }
$arguments = @($p.application, 'upgrade', '--yes', '--json', '--components', 'broker')
if ($p.release) { $arguments += @('--release', $p.release) }
if ($p.preparedJob) { $arguments += @('--prepared-job', $p.preparedJob) }
if ($p.manifest) { $arguments += @('--manifest', $p.manifest) }
$result = [IO.Path]::Combine([IO.Path]::GetDirectoryName($p.application), 'result.json')
$errorLog = [IO.Path]::Combine([IO.Path]::GetDirectoryName($p.application), 'error.log')
$exitCode = 1
try {
  $ErrorActionPreference = 'Continue'
  & $p.runtime @arguments 1> $result 2> $errorLog
  $exitCode = $LASTEXITCODE
} finally {
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $scheduler.GetFolder('\\').DeleteTask($p.name, 0)
}
exit $exitCode
`;
  const encodedWorker = Buffer.from(worker, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
${readPayload}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
${WINDOWS_UPDATE_TASK_CLEANUP_POWERSHELL}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$null = Remove-StaleUpdateTasks $scheduler '${WINDOWS_TASK_ROOT_PATH.slice(1)}-Update-' $sid
# The Broker service's SID folder must contain only its owned service task.
# Register this short-lived independent task outside it, then remove it on exit.
$folder = $scheduler.GetFolder('\\')
$task = $scheduler.NewTask(0)
$task.RegistrationInfo.Description = 'cosyncing:update-runner:v1'
$task.Principal.UserId = $sid
$task.Principal.LogonType = 3
$task.Principal.RunLevel = 0
$task.Settings.AllowDemandStart = $true
$task.Settings.DisallowStartIfOnBatteries = $false
$task.Settings.StopIfGoingOnBatteries = $false
$task.Settings.ExecutionTimeLimit = 'PT30M'
$action = $task.Actions.Create(0)
$action.Path = '${powershell.replaceAll("'", "''")}'
$action.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedWorker}'
$action.WorkingDirectory = $p.home
$sddl = 'O:' + $sid + 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;' + $sid + ')'
$registered = $folder.RegisterTaskDefinition($p.name, $task, 2, $sid, $null, 3, $sddl)
try { $null = $registered.Run($null) } catch { $folder.DeleteTask($p.name, 0); throw }
`;
  return [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
