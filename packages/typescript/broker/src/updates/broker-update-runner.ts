import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectInstallState } from '../installation/install-state.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../security/secure-files.ts';
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
  if (!binary || binary.target !== deps.executablePath || inspectOwnerOnlyFile(deps.executablePath).status !== 'ok') {
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

/** An independent per-user demand task; no passwords, elevation or broker job object. */
export function windowsBrokerUpdateCommand(deps: BrokerUpdateTriggerDependencies): string[] | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const powershell = deps.windowsPowerShellPath ?? (systemRoot && join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  if (!powershell || !deps.runtimePath) return undefined;
  const payload = Buffer.from(JSON.stringify({ runtime: deps.runtimePath, application: deps.executablePath,
    home: deps.stateHome, cache: deps.cacheRoot, userHome: deps.userHome, release: deps.pinnedReleaseId,
    manifest: deps.manifestUrl, preparedJob: deps.preparedJobId, name: `Update-${randomUUID()}` })).toString('base64');
  const worker = `$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$env:COSYNCING_HOME = $p.home
if ($p.cache) { $env:COSYNCING_CACHE_DIR = $p.cache }
$arguments = @($p.application, 'upgrade', '--yes', '--json', '--components', 'broker')
if ($p.release) { $arguments += @('--release', $p.release) }
if ($p.preparedJob) { $arguments += @('--prepared-job', $p.preparedJob) }
if ($p.manifest) { $arguments += @('--manifest', $p.manifest) }
& $p.runtime @arguments
exit $LASTEXITCODE
`;
  const encodedWorker = Buffer.from(worker, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$folder = $scheduler.GetFolder('\\Cosyncing\\' + $sid)
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
$action.Arguments = '-NoProfile -NonInteractive -EncodedCommand ${encodedWorker}'
$action.WorkingDirectory = $p.home
$sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;' + $sid + ')'
$registered = $folder.RegisterTaskDefinition($p.name, $task, 2, $sid, $null, 3, $sddl)
$null = $registered.Run($null)
`;
  return [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
