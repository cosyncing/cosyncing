import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

export type SecurePathProblem =
  | 'not-absolute'
  | 'symlink'
  | 'not-file'
  | 'not-directory'
  | 'wrong-owner'
  | 'unsafe-mode';

export class SecurePathError extends Error {
  constructor(readonly problem: SecurePathProblem, readonly target: string) {
    super(`unsafe filesystem target (${problem})`);
    this.name = 'SecurePathError';
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwned(stat: Stats, target: string): void {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new SecurePathError('wrong-owner', target);
}

/** `existsSync` follows symlinks and therefore reports a broken symlink as absent; ownership checks need lstat. */
function lstatIfPresent(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Reject symlinks in every existing component without requiring ownership of shared ancestors such as /tmp. */
export function assertNoSymlinkComponents(target: string, includeLeaf = true): void {
  if (!isAbsolute(target)) throw new SecurePathError('not-absolute', target);
  const absolute = resolve(target);
  const root = parse(absolute).root;
  const components: string[] = [];
  let cursor = includeLeaf ? absolute : dirname(absolute);
  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.reverse();
  for (const component of components) {
    if (!existsSync(component)) continue;
    const stat = lstatSync(component);
    if (stat.isSymbolicLink()) throw new SecurePathError('symlink', component);
  }
}

/** Create or tighten one application-owned directory. Shared ancestors are inspected, never chmodded. */
export function ensureOwnerOnlyDirectory(target: string): void {
  assertNoSymlinkComponents(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
  if (!stat.isDirectory()) throw new SecurePathError('not-directory', target);
  assertOwned(stat, target);
  chmodSync(target, 0o700);
}

export interface SecureFileInspection {
  status: 'missing' | 'ok' | 'unsafe' | 'unreadable';
  path: string;
  problem?: SecurePathProblem;
}

/** Read-only owner/mode/symlink inspection for configuration and credential files. */
export function inspectOwnerOnlyFile(target: string): SecureFileInspection {
  try {
    assertNoSymlinkComponents(target, false);
    const stat = lstatIfPresent(target);
    if (!stat) return { status: 'missing', path: target };
    if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
    if (!stat.isFile()) throw new SecurePathError('not-file', target);
    assertOwned(stat, target);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new SecurePathError('unsafe-mode', target);
    }
    return { status: 'ok', path: target };
  } catch (error) {
    if (error instanceof SecurePathError) {
      return { status: 'unsafe', path: target, problem: error.problem };
    }
    return { status: 'unreadable', path: target };
  }
}

export function readOwnerOnlyText(target: string): string {
  const inspection = inspectOwnerOnlyFile(target);
  if (inspection.status !== 'ok') {
    throw new SecurePathError(inspection.problem ?? 'not-file', target);
  }
  return readFileSync(target, 'utf8');
}

export interface AtomicWriteOptions {
  mode?: number;
  preserveMode?: boolean;
  /** Final caller-owned precondition, run after the replacement bytes are durable and immediately before rename. */
  beforeReplace?: () => void;
}

/**
 * Owner-only, same-directory atomic replacement. The destination and every existing parent component are
 * checked for symlink substitution; the temporary file is created exclusively, fsynced, then renamed.
 */
export function atomicWriteOwnerOnly(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  assertNoSymlinkComponents(target, false);
  const parent = dirname(target);
  ensureOwnerOnlyDirectory(parent);

  let mode = options.mode ?? 0o600;
  const existing = lstatIfPresent(target);
  if (existing) {
    const stat = existing;
    if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
    if (!stat.isFile()) throw new SecurePathError('not-file', target);
    assertOwned(stat, target);
    if (options.preserveMode) mode = stat.mode & 0o777;
  }

  const temp = `${target}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Recheck immediately before replacement. rename replaces a leaf symlink rather than following it, but an
    // explicit rejection keeps the ownership contract visible and catches directory swaps.
    assertNoSymlinkComponents(target, false);
    if (lstatIfPresent(target)?.isSymbolicLink()) {
      throw new SecurePathError('symlink', target);
    }
    options.beforeReplace?.();
    // The callback may perform filesystem/receipt reads. Recheck the path components once more after it.
    assertNoSymlinkComponents(target, false);
    if (lstatIfPresent(target)?.isSymbolicLink()) {
      throw new SecurePathError('symlink', target);
    }
    renameSync(temp, target);
    chmodSync(target, mode);
    try {
      const dirFd = openSync(parent, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // Some filesystems do not permit directory fsync. File fsync + atomic rename remains the portable floor.
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

export function atomicWriteJsonOwnerOnly(target: string, value: unknown): void {
  atomicWriteOwnerOnly(target, `${JSON.stringify(value, null, 2)}\n`);
}

/** Create a durable owner-only file without ever replacing an existing winner. */
export function createOwnerOnlyFileExclusive(
  target: string,
  content: string | Uint8Array,
  mode = 0o600,
): 'created' | 'exists' {
  assertNoSymlinkComponents(target, false);
  const parent = dirname(target);
  ensureOwnerOnlyDirectory(parent);
  let fd: number | undefined;
  let created = false;
  try {
    try {
      fd = openSync(target, 'wx', mode);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      const dirFd = openSync(parent, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // Directory fsync is not portable. The exclusively created file itself is still durable.
    }
    return 'created';
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
      fd = undefined;
    }
    if (created) {
      try { rmSync(target, { force: true }); } catch { /* best-effort cleanup of our incomplete file */ }
    }
    throw error;
  }
}

/** Test/support helper that returns a sanitized mode without exposing file contents. */
export function ownerOnlyMode(target: string): number {
  return statSync(target).mode & 0o777;
}
