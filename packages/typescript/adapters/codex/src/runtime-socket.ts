import { lstatSync, statSync } from 'node:fs';

type SocketFingerprint = { dev: number; ino: number; mtimeMs: number };
type SocketObservation =
  | { state: 'absent' | 'unknown'; fingerprint?: never }
  | { state: 'socket'; fingerprint: SocketFingerprint };

/** Read-only routing evidence, never authority to start/stop or claim a process.
 * Codex may publish its control endpoint as a symlink to a runtime-owned socket.
 * A dangling link or unreadable target is unknown, not evidence of no daemon. */
export function inspectCodexRuntimeSocket(path: string | undefined): SocketObservation {
  if (!path) return { state: 'absent' };
  let entry;
  try { entry = lstatSync(path); }
  catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
  }
  try {
    const target = entry.isSymbolicLink() ? statSync(path) : entry;
    if (!target.isSocket()) return { state: 'unknown' };
    return { state: 'socket', fingerprint: { dev: target.dev, ino: target.ino, mtimeMs: target.mtimeMs } };
  } catch {
    return { state: 'unknown' };
  }
}
