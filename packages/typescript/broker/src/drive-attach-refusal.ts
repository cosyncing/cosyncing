import { isNativeSessionUnresumableError, isOwnershipConflictError } from '@cosyncing/adapter-api';
import { isJoinExistingError } from './session-owner.ts';

/** Stable machine codes carried by the additive `attach-conflict` frame. */
export type DriveAttachRefusalCode =
  'DRIVE_OWNERSHIP_CONFLICT'
  | 'DRIVE_OWNERSHIP_UNKNOWN'
  | 'DRIVE_NATIVE_SESSION_UNRESUMABLE'
  | 'DRIVE_RESTORE_FAILED'
  | 'JOIN_OWNER_NOT_FOUND'
  | 'JOIN_OWNER_STALE'
  | 'JOIN_NOT_SUPPORTED';

/** Classify a failed reason-tagged resume without inspecting session metadata. */
export function driveAttachRefusalCode(error: unknown): DriveAttachRefusalCode {
  if (isJoinExistingError(error)) return error.code;
  if (isOwnershipConflictError(error)) {
    return error.conflict === 'daemon-ownership-unknown' ? 'DRIVE_OWNERSHIP_UNKNOWN' : 'DRIVE_OWNERSHIP_CONFLICT';
  }
  if (isNativeSessionUnresumableError(error)) {
    return 'DRIVE_NATIVE_SESSION_UNRESUMABLE';
  }
  return 'DRIVE_RESTORE_FAILED';
}
