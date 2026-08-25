#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteOwnerOnly,
  enforceOwnerOnlyFile,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../../../packages/typescript/broker/src/security/secure-files.ts';

const root = process.env.COSYNCING_WINDOWS_PHASE2_ROOT;
const runId = process.env.COSYNCING_WINDOWS_PHASE2_RUN_ID;
const sourceCommit = process.env.COSYNCING_WINDOWS_PHASE2_SOURCE_COMMIT;
if (process.platform !== 'win32' || !root || !runId || !sourceCommit) {
  throw new Error('Phase 2 DACL probe requires native Windows and an explicit run identity');
}

const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const WEAKEN_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = [Environment]::GetEnvironmentVariable('COSYNCING_WINDOWS_PHASE2_WEAKEN_TARGET', 'Process')
$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target
$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-11')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
if (Test-Path -LiteralPath $target -PathType Container) {
  [System.IO.Directory]::SetAccessControl($target, $acl)
} else {
  [System.IO.File]::SetAccessControl($target, $acl)
}
`;
const weakenCommand = Buffer.from(WEAKEN_SOURCE, 'utf16le').toString('base64');

function weaken(target: string): void {
  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', weakenCommand],
    {
      env: { ...process.env, COSYNCING_WINDOWS_PHASE2_WEAKEN_TARGET: target },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

const state = join(root, 'state');
const secret = join(state, 'secret.txt');
const guarded = join(state, 'guarded.json');
const checks: Record<string, boolean> = {};

try {
  mkdirSync(root, { recursive: false });
  ensureOwnerOnlyDirectory(state);
  checks.directoryConverged = inspectOwnerOnlyDirectory(state).status === 'ok';
  const nested = join(root, 'nested', 'level', 'leaf');
  ensureOwnerOnlyDirectory(nested);
  checks.recursiveDirectoriesConverged = [
    join(root, 'nested'),
    join(root, 'nested', 'level'),
    nested,
  ].every((directory) => inspectOwnerOnlyDirectory(directory).status === 'ok');

  atomicWriteOwnerOnly(secret, 'phase2-secret-v1\n');
  checks.atomicCreateConverged = inspectOwnerOnlyFile(secret).status === 'ok';
  weaken(secret);
  const weakenedFile = inspectOwnerOnlyFile(secret);
  checks.weakenedFileDetected = weakenedFile.status === 'unsafe' && weakenedFile.problem === 'unsafe-dacl';
  enforceOwnerOnlyFile(secret);
  checks.filePermissionRepairConverged = inspectOwnerOnlyFile(secret).status === 'ok';
  weaken(secret);
  atomicWriteOwnerOnly(secret, 'phase2-secret-v2\n');
  checks.atomicReplacementRepaired = inspectOwnerOnlyFile(secret).status === 'ok'
    && readFileSync(secret, 'utf8') === 'phase2-secret-v2\n';

  weaken(state);
  const weakenedDirectory = inspectOwnerOnlyDirectory(state);
  checks.weakenedDirectoryDetected = weakenedDirectory.status === 'unsafe'
    && weakenedDirectory.problem === 'unsafe-dacl';
  ensureOwnerOnlyDirectory(state);
  checks.directoryRepaired = inspectOwnerOnlyDirectory(state).status === 'ok';

  atomicWriteOwnerOnly(guarded, '{"generation":1}\n');
  let observedTempWasSecure = false;
  assert.throws(() => atomicWriteOwnerOnly(guarded, '{"generation":2}\n', {
    beforeReplace: () => {
      const tempName = readdirSync(state).find((name) => name.startsWith('guarded.json.tmp-'));
      assert.ok(tempName);
      observedTempWasSecure = inspectOwnerOnlyFile(join(state, tempName)).status === 'ok';
      throw new Error('intentional phase2 interruption');
    },
  }), /intentional phase2 interruption/);
  checks.tempSecureBeforeReplace = observedTempWasSecure;
  checks.interruptedWriteRolledBack = readFileSync(guarded, 'utf8') === '{"generation":1}\n'
    && !readdirSync(state).some((name) => name.startsWith('guarded.json.tmp-'));

  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
  console.log(JSON.stringify({
    schema: 1,
    runId,
    sourceCommit,
    sourceDirty: process.env.COSYNCING_WINDOWS_PHASE2_SOURCE_DIRTY === 'true',
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    filesystem: 'NTFS',
    policy: {
      protectedDacl: true,
      directoryCreation: 'DirectoryInfo.Create(DirectorySecurity)',
      principals: ['current-user-sid', 'S-1-5-18', 'S-1-5-32-544'],
      rights: 'FullControl',
      inheritedAces: false,
    },
    checks,
    status: 'passed',
  }, null, 2));
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
