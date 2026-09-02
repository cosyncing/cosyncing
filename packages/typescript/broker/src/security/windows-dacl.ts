import { windowsFfi } from '@cosyncing/adapter-api';

const LOCAL_SYSTEM_SID = 'S-1-5-18';
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544';
const FULL_CONTROL = 2_032_127;

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
  /**
   * The SID this process's token stamps as owner on objects IT creates.
   *
   * Equal to the user on an ordinary session and `BUILTIN\Administrators` on an elevated one.
   * Optional so a caller that has not asked keeps the strict comparison it had.
   */
  tokenOwnerSid?: string;
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
  // Owned by the user, or by the owner this very token stamps on what it creates.
  //
  // The enforce path already accepted both, for a reason that applies just as much here: run
  // elevated, Windows stamps BUILTIN\Administrators as the owner of every file the product creates,
  // so a file it wrote itself came back reading as somebody else's. On the enforcement side that was
  // a refusal to write. Here it is worse and quieter -- `wrong-owner` is the ONE problem durable
  // state will not repair, because a foreign file must never be laundered by tightening it, so
  // loose-but-ours legacy state became an unfixable setup blocker on every elevated host.
  //
  // Nothing about ACCESS widens: every rule below still has to hold, so the DACL must still name
  // exactly the user, SYSTEM and Administrators at full control, protected and uninherited.
  // Enforcement rewrites the owner to the user regardless, and on an ordinary session the two SIDs
  // are the same value.
  const ownedByUs = snapshot.ownerSid === snapshot.currentUserSid
    || (snapshot.tokenOwnerSid !== undefined && snapshot.ownerSid === snapshot.tokenOwnerSid);
  if (!ownedByUs) return { ok: false, problem: 'wrong-owner' };
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

/**
 * The owner-only policy, as the SDDL the operating system will store.
 *
 * `FA` is FILE_ALL_ACCESS -- the same 2032127 the classifier above compares against -- and `P`
 * protects the DACL from inheritance. `OICI` on a directory carries the grant to what is created
 * inside it, and is absent on a file, which contains nothing to inherit it.
 *
 * The three principals are deliberate and closed: the user, SYSTEM, and Administrators. The first
 * two are the object's working owners; the third is on the machine's own recovery path and can take
 * ownership regardless, so naming it changes nothing it could not already do while keeping the
 * stored ACL honest about who has access.
 */
export function windowsOwnerOnlySddl(sid: string, kind: WindowsSecurePathKind): string {
  const inherit = kind === 'directory' ? 'OICI' : '';
  return `O:${sid}G:${sid}D:P`
    + `(A;${inherit};FA;;;${sid})`
    + `(A;${inherit};FA;;;${LOCAL_SYSTEM_SID})`
    + `(A;${inherit};FA;;;${BUILTIN_ADMINISTRATORS_SID})`;
}

/**
 * The Windows security primitives, or a refusal.
 *
 * Owner-only enforcement is the one caller that must not degrade. A probe that cannot reach the
 * operating system can answer 'unknown' and let its caller decide; this cannot, because the next
 * thing that happens is a secret being written to the path whose access it just failed to
 * establish. So a missing library is an error here rather than a fallback.
 */
function windowsSecurity(): NonNullable<ReturnType<typeof windowsFfi>> {
  const ffi = windowsFfi();
  if (!ffi) throw new Error('the Windows security primitives are unavailable; refusing to write owner-only state');
  return ffi;
}

function snapshotOf(target: string): WindowsDaclSnapshot {
  const security = windowsSecurity();
  const read = security.readSecurity(target);
  return {
    currentUserSid: security.currentUserSid(),
    tokenOwnerSid: security.currentTokenOwnerSid(),
    ownerSid: read.ownerSid,
    protected: read.protected,
    rules: read.aces.map((ace) => ({
      sid: ace.sid,
      type: ace.type,
      rights: ace.rights,
      inherited: ace.inherited,
      inheritanceFlags: ace.inheritanceFlags,
      propagationFlags: ace.propagationFlags,
    })),
  };
}

function runWindowsDaclOperation(
  target: string,
  kind: WindowsSecurePathKind,
  operation: 'inspect' | 'enforce' | 'create-directory',
): WindowsDaclSnapshot {
  const security = windowsSecurity();
  if (operation === 'create-directory') {
    if (kind !== 'directory') throw new Error('Windows DACL create operation requires a directory target');
    security.createDirectory(target, windowsOwnerOnlySddl(security.currentUserSid(), 'directory'));
  } else if (operation === 'enforce') {
    // Accept an object owned by this token's own default owner as well as by the user. Refusing it
    // made the product reject files it had just created itself whenever it ran elevated -- the file
    // is opened, Windows stamps Administrators as its owner, and enforcement then called it foreign.
    // On an ordinary session the two SIDs are identical, so nothing widens there. Either way the
    // owner is rewritten to the user below, so the object still ends up owned by the person who ran
    // the command.
    const prior = security.pathOwnerSid(target);
    if (prior !== security.currentUserSid() && prior !== security.currentTokenOwnerSid()) {
      throw new Error('DACL target is not owned by the current user');
    }
    security.applySecurity(target, windowsOwnerOnlySddl(security.currentUserSid(), kind));
  }
  // Read back in every case, including `inspect`. The verdict is what the operating system stored,
  // never what we asked it to store.
  return snapshotOf(target);
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
