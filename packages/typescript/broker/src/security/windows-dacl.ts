import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { windowsPowerShellChildEnvironment } from '@cosyncing/adapter-api';

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544';
const FULL_CONTROL = 2_032_127;
const POWERSHELL_TIMEOUT_MS = 15_000;
const POWERSHELL_MAX_BUFFER = 128 * 1024;

export type WindowsSecurePathKind = 'file' | 'directory';

export interface WindowsDaclRule {
  sid: string;
  type: string;
  rights: number;
  inherited: boolean;
  inheritanceFlags: number;
  propagationFlags: number;
}

export interface WindowsDaclSnapshot {
  currentUserSid: string;
  ownerSid: string;
  protected: boolean;
  rules: WindowsDaclRule[];
}

export type WindowsDaclProblem =
  | 'wrong-owner'
  | 'inherited-access'
  | 'deny-access'
  | 'unexpected-principal'
  | 'missing-principal'
  | 'duplicate-principal'
  | 'insufficient-access'
  | 'unsafe-inheritance';

export interface WindowsDaclInspection {
  ok: boolean;
  problem?: WindowsDaclProblem;
}

function expectedInheritance(kind: WindowsSecurePathKind): number {
  return kind === 'directory' ? 3 : 0;
}

/** Classify a normalized DACL snapshot without relying on localized account names or ACL text. */
export function classifyWindowsOwnerOnlyDacl(
  snapshot: WindowsDaclSnapshot,
  kind: WindowsSecurePathKind,
): WindowsDaclInspection {
  if (snapshot.ownerSid !== snapshot.currentUserSid) return { ok: false, problem: 'wrong-owner' };
  if (!snapshot.protected) return { ok: false, problem: 'inherited-access' };

  const expected = new Set([
    snapshot.currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID,
  ]);
  const seen = new Set<string>();
  for (const rule of snapshot.rules) {
    if (rule.inherited) return { ok: false, problem: 'inherited-access' };
    if (rule.type !== 'Allow') return { ok: false, problem: 'deny-access' };
    if (!expected.has(rule.sid)) return { ok: false, problem: 'unexpected-principal' };
    if (seen.has(rule.sid)) return { ok: false, problem: 'duplicate-principal' };
    if (rule.rights !== FULL_CONTROL) return { ok: false, problem: 'insufficient-access' };
    if (rule.inheritanceFlags !== expectedInheritance(kind) || rule.propagationFlags !== 0) {
      return { ok: false, problem: 'unsafe-inheritance' };
    }
    seen.add(rule.sid);
  }
  for (const sid of expected) {
    if (!seen.has(sid)) return { ok: false, problem: 'missing-principal' };
  }
  return { ok: true };
}

export const WINDOWS_DACL_POWERSHELL_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = [Environment]::GetEnvironmentVariable('COSYNCING_WINDOWS_DACL_TARGET', 'Process')
$operation = [Environment]::GetEnvironmentVariable('COSYNCING_WINDOWS_DACL_OPERATION', 'Process')
$kind = [Environment]::GetEnvironmentVariable('COSYNCING_WINDOWS_DACL_KIND', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'missing DACL target' }
if ($kind -ne 'file' -and $kind -ne 'directory') { throw 'invalid DACL target kind' }

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
# The SID Windows stamps as owner on objects THIS token creates. It equals the user on an ordinary
# session, and BUILTIN\Administrators on an elevated one, so an object this process just created can
# come back owned by Administrators rather than by the user who ran the command.
$tokenOwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().Owner
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

if ($operation -eq 'enforce' -or $operation -eq 'create-directory') {
  if ($operation -eq 'create-directory' -and $kind -ne 'directory') {
    throw 'DACL create operation requires a directory target'
  }
  if ($operation -eq 'enforce') {
    $prior = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target
    $priorOwnerSid = $prior.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    # Accept an object owned by this token's own default owner as well as by the user. Refusing it made
    # the product reject files it had just created itself whenever it ran elevated -- Node opens the temp
    # file, Windows stamps Administrators as its owner, and enforcement then called it foreign. On an
    # ordinary session the two SIDs are identical, so nothing widens there. Either way the owner is
    # rewritten to the user below, so the object still ends up owned by the person who ran the command.
    if ($priorOwnerSid -ne $currentSid.Value -and $priorOwnerSid -ne $tokenOwnerSid.Value) {
      throw 'DACL target is not owned by the current user'
    }
  }
  if ($kind -eq 'directory') {
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $security = New-Object System.Security.AccessControl.FileSecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  if ($operation -eq 'create-directory') {
    $directory = New-Object System.IO.DirectoryInfo($target)
    $directory.Create($security)
  } elseif ($kind -eq 'directory') {
    [System.IO.Directory]::SetAccessControl($target, $security)
  } else {
    [System.IO.File]::SetAccessControl($target, $security)
  }
} elseif ($operation -ne 'inspect') {
  throw 'invalid DACL operation'
}

$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    rights = [int]$_.FileSystemRights
    inherited = [bool]$_.IsInherited
    inheritanceFlags = [int]$_.InheritanceFlags
    propagationFlags = [int]$_.PropagationFlags
  }
})
[ordered]@{
  currentUserSid = $currentSid.Value
  ownerSid = $ownerSid
  protected = [bool]$acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 5
`;

const ENCODED_POWERSHELL = Buffer.from(WINDOWS_DACL_POWERSHELL_SOURCE, 'utf16le').toString('base64');

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) throw new Error('Windows SystemRoot is unavailable for DACL enforcement');
  return systemRoot;
}

function powershellExecutable(env: NodeJS.ProcessEnv): string {
  return join(windowsSystemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Environment for the Windows PowerShell child, with the module path pinned to the system module store.
 *
 * This provider runs Windows PowerShell 5.1 explicitly. Any host with PowerShell 7 installed exports a
 * PSModulePath naming 7's module roots, and 5.1 inheriting that cannot auto-load
 * Microsoft.PowerShell.Security -- `Get-Acl` then fails and takes every owner-only write with it: setup,
 * durable state, credentials. The cmdlets are already module-qualified, but a qualified name still has to
 * be discoverable, and pinning the system store additionally stops a user-writable module from shadowing
 * Get-Acl or Set-Acl in a path whose whole job is deciding who may read a secret.
 */
export function windowsDaclChildEnvironment(
  env: NodeJS.ProcessEnv,
  request: { target: string; operation: string; kind: WindowsSecurePathKind },
): NodeJS.ProcessEnv {
  // The SystemRoot read is kept, and kept FIRST: the shared helper answers a missing SystemRoot by
  // returning the environment unpinned, which is the right answer for a probe that degrades to
  // 'unknown' and the wrong one here, where an unpinned 5.1 loses Get-Acl and takes every owner-only
  // write with it. This provider refuses instead.
  windowsSystemRoot(env);
  return {
    ...windowsPowerShellChildEnvironment(env),
    COSYNCING_WINDOWS_DACL_TARGET: request.target,
    COSYNCING_WINDOWS_DACL_OPERATION: request.operation,
    COSYNCING_WINDOWS_DACL_KIND: request.kind,
  };
}

function runWindowsDaclOperation(
  target: string,
  kind: WindowsSecurePathKind,
  operation: 'inspect' | 'enforce' | 'create-directory',
): WindowsDaclSnapshot {
  const result = spawnSync(
    powershellExecutable(process.env),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_POWERSHELL],
    {
      encoding: 'utf8',
      env: windowsDaclChildEnvironment(process.env, { target, operation, kind }),
      maxBuffer: POWERSHELL_MAX_BUFFER,
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const detail = stderr.slice(Math.max(0, stderr.length - 2_048));
    throw new Error(`Windows DACL ${operation} failed${detail ? `: ${detail}` : ''}`);
  }
  const parsed = JSON.parse(result.stdout.trim()) as WindowsDaclSnapshot;
  if (!parsed || !Array.isArray(parsed.rules)) throw new Error('Windows DACL provider returned invalid output');
  return parsed;
}

export function inspectWindowsOwnerOnlyDacl(
  target: string,
  kind: WindowsSecurePathKind,
): WindowsDaclInspection {
  return classifyWindowsOwnerOnlyDacl(runWindowsDaclOperation(target, kind, 'inspect'), kind);
}

export function enforceWindowsOwnerOnlyDacl(target: string, kind: WindowsSecurePathKind): void {
  const inspection = classifyWindowsOwnerOnlyDacl(runWindowsDaclOperation(target, kind, 'enforce'), kind);
  if (!inspection.ok) {
    throw new Error(`Windows DACL enforcement did not converge (${inspection.problem ?? 'unknown'})`);
  }
}

/** Create one directory with its final protected DACL in the operating-system create operation. */
export function createWindowsOwnerOnlyDirectory(target: string): void {
  const inspection = classifyWindowsOwnerOnlyDacl(runWindowsDaclOperation(target, 'directory', 'create-directory'), 'directory');
  if (!inspection.ok) {
    throw new Error(`Windows secured directory creation did not converge (${inspection.problem ?? 'unknown'})`);
  }
}
