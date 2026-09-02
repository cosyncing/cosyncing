#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyWindowsOwnerOnlyDacl,
  windowsOwnerOnlySddl,
  type WindowsDaclSnapshot,
} from '../../src/security/windows-dacl.ts';

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

// An elevated token stamps BUILTIN\\Administrators as the owner of everything it creates, so the
// product's OWN files come back owned by a SID that is not the user. Accepting that owner is the
// difference between "loose legacy state, tighten it" and "somebody else's file, refuse" -- and
// `wrong-owner` is the one problem durable state will not repair, so getting this wrong turned every
// elevated host into an unfixable setup blocker rather than a visible failure.
const ADMINISTRATORS = 'S-1-5-32-544';
{
  const elevated = (): WindowsDaclSnapshot => ({
    ...snapshot('file'),
    tokenOwnerSid: ADMINISTRATORS,
    ownerSid: ADMINISTRATORS,
  });
  const owned = elevated();
  assert.deepEqual(classifyWindowsOwnerOnlyDacl(owned, 'file'), { ok: true },
    'a file owned by the owner this token stamps is ours, not foreign');

  // Repairable, not foreign: the loose form must report the problem durable state KNOWS how to fix.
  const loose = elevated();
  loose.rules[0]!.inherited = true;
  assert.deepEqual(classifyWindowsOwnerOnlyDacl(loose, 'file'), { ok: false, problem: 'inherited-access' });

  // Accepting the owner widens nothing about ACCESS. Every DACL rule still has to hold.
  for (const [name, corrupt] of [
    ['an extra principal', (c: WindowsDaclSnapshot) => { c.rules[0]!.sid = 'S-1-5-11'; }],
    ['a deny ACE', (c: WindowsDaclSnapshot) => { c.rules[0]!.type = 'Deny'; }],
    ['partial rights', (c: WindowsDaclSnapshot) => { c.rules[0]!.rights = 1_179_785; }],
    ['an unprotected DACL', (c: WindowsDaclSnapshot) => { c.protected = false; }],
  ] as const) {
    const candidate = elevated();
    corrupt(candidate);
    assert.equal(classifyWindowsOwnerOnlyDacl(candidate, 'file').ok, false,
      `${name} must still be refused on an elevated token`);
  }

  // A THIRD party's SID is still foreign. The acceptance is this token's own default owner, not any
  // owner that happens not to be the user.
  const foreign = elevated();
  foreign.ownerSid = 'S-1-5-21-9-9-9-1234';
  assert.deepEqual(classifyWindowsOwnerOnlyDacl(foreign, 'file'), { ok: false, problem: 'wrong-owner' });

  // Absent the token owner the comparison stays strict, so no caller loses a check by not asking.
  const unasked = elevated();
  delete unasked.tokenOwnerSid;
  assert.deepEqual(classifyWindowsOwnerOnlyDacl(unasked, 'file'), { ok: false, problem: 'wrong-owner' });
}

// Enforcement runs against the Windows API, so applying it cannot be exercised from a POSIX gate.
// What CAN be pinned here is the policy it applies and the mechanism it applies it through.
{
  const file = windowsOwnerOnlySddl(USER_SID, 'file');
  const directory = windowsOwnerOnlySddl(USER_SID, 'directory');
  assert.equal(file, `O:${USER_SID}G:${USER_SID}D:P(A;;FA;;;${USER_SID})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`);
  // `OICI` is what carries the grant to whatever is created inside the directory. Without it the
  // directory would be owner-only and everything written into it would inherit from somewhere else.
  assert.equal(
    directory,
    `O:${USER_SID}G:${USER_SID}D:P`
      + `(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)`,
  );
  // `P` is the whole point: a descriptor without it accepts inherited ACEs and is not owner-only.
  assert.match(file, /D:P\(/, 'the DACL must be protected from inheritance');
  assert.equal(file.includes('OICI'), false, 'a file contains nothing that could inherit the grant');
  // The three principals are closed. A fourth would be a hole this policy exists to prevent.
  assert.equal(file.match(/\(A;/g)?.length, 3);
  assert.equal(directory.match(/\(A;/g)?.length, 3);
}
{
  // The mechanism itself, pinned in the source: the provider must reach the operating system
  // directly. Every defect this rewrite closed -- Get-Acl unresolvable under an inherited
  // PSModulePath, a compile blocking startup past twenty seconds, 271ms per operation against
  // 0.143ms -- came from asking a shell. A reintroduced spawn brings all of them back at once.
  const provider = readFileSync(
    new URL('../../src/security/windows-dacl.ts', import.meta.url), 'utf8',
  );
  assert.equal(/spawnSync|powershell|PSModulePath/i.test(provider), false,
    'owner-only enforcement must not reach the operating system through a shell');
}

console.log('PASS 33/33 Windows DACL policy checks');
