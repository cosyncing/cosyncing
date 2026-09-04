import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  createWindowsOwnerOnlyDirectory,
  enforceWindowsOwnerOnlyDacl,
  inspectWindowsOwnerOnlyDacl,
  type WindowsSecurePathKind,
} from './windows-dacl.ts';

export type SecurePathProblem =
  | 'not-absolute'
  | 'symlink'
  | 'not-file'
  | 'not-directory'
  | 'wrong-owner'
  | 'unsafe-mode'
  | 'unsafe-dacl';

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
  const missing: string[] = [];
  let cursor = resolve(target);
  const root = parse(cursor).root;
  while (cursor !== root && !existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  if (process.platform === 'win32') {
    // Create each missing level with its final descriptor in the create operation. A post-mkdir DACL change
    // would leave a window in which a principal admitted by a shared parent could retain an open handle.
    for (const directory of missing.reverse()) createWindowsOwnerOnlyDirectory(directory);
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
  if (!stat.isDirectory()) throw new SecurePathError('not-directory', target);
  if (process.platform === 'win32') {
    // An existing application-owned directory may have drifted and is safe to converge after owner proof.
    if (missing.length === 0) enforceWindowsOwnerOnlyDacl(target, 'directory');
  } else {
    assertOwned(stat, target);
    chmodSync(target, 0o700);
  }
}

export interface SecureFileInspection {
  status: 'missing' | 'ok' | 'unsafe' | 'unreadable';
  path: string;
  problem?: SecurePathProblem;
}

/** Read-only owner/mode/symlink inspection for configuration and credential files. */
function inspectOwnerOnlyPath(target: string, kind: WindowsSecurePathKind): SecureFileInspection {
  try {
    assertNoSymlinkComponents(target, false);
    const stat = lstatIfPresent(target);
    if (!stat) return { status: 'missing', path: target };
    if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
    if (kind === 'file' && !stat.isFile()) throw new SecurePathError('not-file', target);
    if (kind === 'directory' && !stat.isDirectory()) throw new SecurePathError('not-directory', target);
    if (process.platform === 'win32') {
      const dacl = inspectWindowsOwnerOnlyDacl(target, kind);
      if (!dacl.ok) {
        throw new SecurePathError(dacl.problem === 'wrong-owner' ? 'wrong-owner' : 'unsafe-dacl', target);
      }
    } else {
      assertOwned(stat, target);
    }
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

/** Read-only owner/mode/symlink inspection for configuration and credential files. */
export function inspectOwnerOnlyFile(target: string): SecureFileInspection {
  return inspectOwnerOnlyPath(target, 'file');
}

/** Read-only owner/mode/symlink inspection for application-owned directories. */
export function inspectOwnerOnlyDirectory(target: string): SecureFileInspection {
  return inspectOwnerOnlyPath(target, 'directory');
}

/** Tighten one current-user-owned regular file without changing its contents. */
export function enforceOwnerOnlyFile(target: string, mode = 0o600): void {
  assertNoSymlinkComponents(target);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new SecurePathError('symlink', target);
  if (!stat.isFile()) throw new SecurePathError('not-file', target);
  if (process.platform === 'win32') {
    enforceWindowsOwnerOnlyDacl(target, 'file');
  } else {
    assertOwned(stat, target);
    chmodSync(target, mode);
  }
}

/**
 * Tighten an entire application-owned directory tree, node by node.
 *
 * A tree that arrives from somewhere else -- an unpacked archive, a directory a tool created inside one of
 * ours -- carries the modes the tool chose and, on Windows, the ACEs its parent handed down. Inherited
 * access is exactly what {@link inspectOwnerOnlyDirectory} rejects, so a tree that merely SITS inside an
 * owner-only directory does not read as owner-only itself and never will until each node is given its own
 * protected descriptor.
 *
 * Every node is visited: a directory whose children were skipped is a directory whose contents are still
 * whatever produced them. Symlinks and anything that is neither a regular file nor a directory are refused
 * rather than tightened, because tightening a link tightens whatever it points at.
 */
export function enforceOwnerOnlyTree(root: string): void {
  ensureOwnerOnlyDirectory(root);
  for (const name of readdirSync(root)) {
    const child = join(root, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new SecurePathError('symlink', child);
    if (stat.isDirectory()) enforceOwnerOnlyTree(child);
    else if (stat.isFile()) enforceOwnerOnlyFile(child);
    else throw new SecurePathError('not-file', child);
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
    if (process.platform === 'win32') {
      const dacl = inspectWindowsOwnerOnlyDacl(target, 'file');
      if (!dacl.ok && dacl.problem === 'wrong-owner') {
        throw new SecurePathError('wrong-owner', target);
      }
    } else {
      assertOwned(stat, target);
    }
    if (options.preserveMode) mode = stat.mode & 0o777;
  }

  const temp = `${target}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', mode);
    // On Windows, inherited access must be removed before any secret bytes are written.
    if (process.platform === 'win32') enforceWindowsOwnerOnlyDacl(temp, 'file');
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
    enforceOwnerOnlyFile(target, mode);
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

/**
 * Windows ignores the POSIX mode, so a file opened at `target` carries the parent's inherited ACEs until a
 * PowerShell round trip can tighten it. Tightening in place would leave a multi-hundred-millisecond window in
 * which a concurrent loser inspects a target that exists but is neither owner-only nor written yet, and every
 * caller of this primitive treats `unsafe` as fatal rather than as contention. Build the file under a private
 * name instead and publish it with a hard link: the link fails with EEXIST rather than replacing a winner, and
 * shares the prepared security descriptor, so a loser only ever observes the finished file or none at all.
 */
function createOwnerOnlyFileExclusiveWindows(
  target: string,
  content: string | Uint8Array,
  mode: number,
): 'created' | 'exists' {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', mode);
    // Before any secret bytes exist, as in atomicWriteOwnerOnly.
    enforceWindowsOwnerOnlyDacl(temp, 'file');
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, target);
      return 'created';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      // Hard links are an NTFS feature, and this function exists precisely because creating the final path
      // before its descriptor is tightened leaves a window in which a concurrent command reads a file that
      // exists, is not owner-only, and is not written yet. An in-place fallback would reinstate exactly that
      // window, so it fails closed instead: the qualified Windows contract is NTFS, and supporting a
      // filesystem without hard links needs its own proven publication strategy, not a silent downgrade of
      // this one.
      throw new Error(
        `owner-only exclusive creation requires hard-link support on this filesystem (${code ?? 'unknown'})`,
        { cause: error },
      );
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* the published hard link keeps the contents */ }
  }
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
  if (process.platform === 'win32') return createOwnerOnlyFileExclusiveWindows(target, content, mode);
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
