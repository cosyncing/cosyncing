#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  classifyWindowsOwnerOnlyDacl,
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

console.log('PASS 12/12 Windows DACL policy checks');
