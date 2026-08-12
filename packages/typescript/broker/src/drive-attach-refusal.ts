import { isNativeSessionUnresumableError, isOwnershipConflictError } from '@cosyncing/adapter-api';

/** Stable machine codes carried by the additive `attach-conflict` frame. */
export type DriveAttachRefusalCode =
  'DRIVE_OWNERSHIP_CONFLICT' | 'DRIVE_OWNERSHIP_UNKNOWN' | 'DRIVE_NATIVE_SESSION_UNRESUMABLE' | 'DRIVE_RESTORE_FAILED';

/** Classify a failed reason-tagged resume without inspecting session metadata. */
export function driveAttachRefusalCode(error: unknown): DriveAttachRefusalCode {
  if (isOwnershipConflictError(error)) {
    return error.conflict === 'daemon-ownership-unknown' ? 'DRIVE_OWNERSHIP_UNKNOWN' : 'DRIVE_OWNERSHIP_CONFLICT';
  }
  if (isNativeSessionUnresumableError(error)) {
    return 'DRIVE_NATIVE_SESSION_UNRESUMABLE';
  }
  return 'DRIVE_RESTORE_FAILED';
}
