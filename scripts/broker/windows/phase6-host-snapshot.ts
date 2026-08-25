/**
 * The Windows process snapshot, retried.
 *
 * `captureWindowsProcessSnapshot` spawns PowerShell under a bounded timeout and returns `null` when
 * it does not answer in time. With two Bun lanes and a live Pi on the box that happens, and a probe
 * that REQUIRES a snapshot at both ends then fails on the harness rather than on the product —
 * observed once on the 1.3.8 lane of slice 3 while 1.4.0 passed the same commit.
 *
 * Retrying is not weakening the claim. The claim is "no agent process outlived this probe", and it
 * needs a snapshot to be true or false at all; a snapshot that never answers is still reported as
 * failed, never assumed empty. The retry only stops a slow answer from being read as no answer.
 */
import {
  captureWindowsProcessSnapshot,
  type WindowsProcessSnapshot,
} from '../../../packages/typescript/broker/src/runtime/windows-process.ts';

export async function captureHostSnapshot(
  attempts = 3,
  pauseMs = 750,
): Promise<WindowsProcessSnapshot | null> {
  let snapshot: WindowsProcessSnapshot | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    snapshot = captureWindowsProcessSnapshot();
    if (snapshot?.processesOk === true) return snapshot;
    if (attempt < attempts) await Bun.sleep(pauseMs);
  }
  return snapshot;
}
