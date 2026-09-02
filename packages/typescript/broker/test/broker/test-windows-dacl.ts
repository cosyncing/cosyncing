#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  classifyWindowsOwnerOnlyDacl,
  WINDOWS_DACL_POWERSHELL_SOURCE,
  windowsDaclChildEnvironment,
  type WindowsDaclSnapshot,
} from '../../src/security/windows-dacl.ts';
import { windowsPowerShellChildEnvironment } from '../../../adapter-api/src/host-process.ts';

const USER_SID = 'S-1-5-21-1000-1000-1000-1001';
const FULL_CONTROL = 2_032_127;

function rule(sid: string, inheritanceFlags = 0) {
  return {
    sid,
    type: 'Allow',
    rights: FULL_CONTROL,
    inherited: false,
    inheritanceFlags,
    propagationFlags: 0,
  };
}

function snapshot(kind: 'file' | 'directory'): WindowsDaclSnapshot {
  const inheritance = kind === 'directory' ? 3 : 0;
  return {
    currentUserSid: USER_SID,
    ownerSid: USER_SID,
    protected: true,
    rules: [
      rule(USER_SID, inheritance),
      rule('S-1-5-18', inheritance),
      rule('S-1-5-32-544', inheritance),
    ],
  };
}

function rejected(
  name: string,
  change: (candidate: WindowsDaclSnapshot) => void,
  expected: string,
): void {
  const candidate = structuredClone(snapshot('file'));
  change(candidate);
  assert.deepEqual(classifyWindowsOwnerOnlyDacl(candidate, 'file'), { ok: false, problem: expected }, name);
}

assert.deepEqual(classifyWindowsOwnerOnlyDacl(snapshot('file'), 'file'), { ok: true });
assert.deepEqual(classifyWindowsOwnerOnlyDacl(snapshot('directory'), 'directory'), { ok: true });

rejected('owner drift', (candidate) => { candidate.ownerSid = 'S-1-5-21-9'; }, 'wrong-owner');
rejected('unprotected DACL', (candidate) => { candidate.protected = false; }, 'inherited-access');
rejected('inherited ACE', (candidate) => { candidate.rules[0]!.inherited = true; }, 'inherited-access');
rejected('deny ACE', (candidate) => { candidate.rules[0]!.type = 'Deny'; }, 'deny-access');
rejected('ordinary user ACE', (candidate) => { candidate.rules[0]!.sid = 'S-1-5-11'; }, 'unexpected-principal');
rejected('duplicate ACE', (candidate) => { candidate.rules.push(rule(USER_SID)); }, 'duplicate-principal');
rejected('missing ACE', (candidate) => { candidate.rules.pop(); }, 'missing-principal');
rejected('partial rights', (candidate) => { candidate.rules[0]!.rights = 1_179_785; }, 'insufficient-access');
rejected('file inheritance', (candidate) => { candidate.rules[0]!.inheritanceFlags = 3; }, 'unsafe-inheritance');
rejected('propagation flags', (candidate) => { candidate.rules[0]!.propagationFlags = 1; }, 'unsafe-inheritance');

// Enforcement runs inside Windows PowerShell, so these two properties cannot be exercised from a POSIX
// gate. Pin them in the script text instead: both were live defects. Inheriting a foreign PSModulePath
// left 5.1 unable to load Microsoft.PowerShell.Security, and demanding the user SID as prior owner made
// the product reject files it had itself just created whenever it ran elevated, since Windows stamps
// BUILTIN\\Administrators as owner for an elevated token.
assert.match(
  WINDOWS_DACL_POWERSHELL_SOURCE,
  /\$tokenOwnerSid = \[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Owner/,
  'the script must know the owner this token stamps on objects it creates',
);
assert.match(
  WINDOWS_DACL_POWERSHELL_SOURCE,
  /\$priorOwnerSid -ne \$currentSid\.Value -and \$priorOwnerSid -ne \$tokenOwnerSid\.Value/,
  'enforcement must accept the user SID or this token\'s own default owner, and nothing else',
);
assert.equal(
  WINDOWS_DACL_POWERSHELL_SOURCE.includes('$security.SetOwner($currentSid)'),
  true,
  'enforcement still rewrites the owner to the user, so acceptance never leaves Administrators owning it',
);
{
  const inherited = 'C:\\Program Files\\PowerShell\\7\\Modules';
  const child = windowsDaclChildEnvironment(
    { SystemRoot: 'C:\\Windows', PSModulePath: inherited },
    { target: 'C:\\t', operation: 'inspect', kind: 'file' },
  );
  assert.notEqual(child.PSModulePath, inherited, 'the child must not inherit a foreign module path');
  assert.match(String(child.PSModulePath), /WindowsPowerShell/);
}
// ONE rule, in one place. The DACL provider was pinned first and the ownership probe next to it was
// not, so `Get-Acl` still failed there -- and a probe that answers 'unknown' instead of throwing
// spent that failure silently: the OpenCode shim's receipt proof declined, and setup reported the
// shim as applied-but-unverified with nothing naming PowerShell. Every 5.1 spawn now builds its
// environment from the same helper.
{
  const inherited = 'C:\\Program Files\\PowerShell\\7\\Modules';
  const pinned = windowsPowerShellChildEnvironment({
    SystemRoot: 'C:\\Windows',
    PSModulePath: inherited,
    PATH: 'C:\\keep-me',
  });
  // Built with `join`, like the helper: this suite runs on POSIX too, where the separator differs.
  assert.equal(
    pinned.PSModulePath,
    join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  );
  assert.equal(pinned.PATH, 'C:\\keep-me', 'pinning the module path changes nothing else');
  assert.equal(
    windowsDaclChildEnvironment(
      { SystemRoot: 'C:\\Windows', PSModulePath: inherited },
      { target: 'C:\\t', operation: 'inspect', kind: 'file' },
    ).PSModulePath,
    pinned.PSModulePath,
    'the DACL provider pins through the shared helper rather than a second copy of the rule',
  );
  // A probe degrades to 'unknown' without a SystemRoot; owner-only enforcement must not degrade at
  // all, so it keeps refusing where the shared helper hands back an unpinned copy.
  assert.equal(windowsPowerShellChildEnvironment({ PATH: 'x' }).PSModulePath, undefined);
  assert.throws(() => windowsDaclChildEnvironment(
    { PATH: 'x' },
    { target: 'C:\\t', operation: 'inspect', kind: 'file' },
  ), /SystemRoot/);
}

console.log('PASS 21/21 Windows DACL policy checks');
