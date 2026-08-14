/**
 * Workspace browser helpers for the broker W3 read-only API.
 *
 * This module intentionally avoids `stat` and follows the same trust boundary style as
 * `hub.ts`: resolve-path is checked against session cwd, and `lstat` is used so symlink hops are not
 * followed. All helpers are path-local, non-writing, and throw narrow typed errors for precise API
 * responses.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FsDirEntry, FsDirectoryResult, FsNodeInfo, FsReadResult, FsRejectCode } from '@cosyncing/protocol';

export const DEFAULT_FS_READ_CAP_BYTES = 1024 * 1024;

export class DownloadRangeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface DownloadByteRange {
  start: number;
  end: number;
}

/** Parse one RFC 9110 byte range. Multipart ranges are intentionally unsupported and fail 416. */
export function parseDownloadRange(raw: string | null, size: number): DownloadByteRange | undefined {
  if (!raw) return undefined;
  if (!Number.isSafeInteger(size) || size < 0) throw new DownloadRangeError('invalid representation size');
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || raw.includes(',')) throw new DownloadRangeError('only one bytes range is supported');
  const first = match[1]!;
  const last = match[2]!;
  if (!first && !last) throw new DownloadRangeError('byte range has no boundary');
  if (size === 0) throw new DownloadRangeError('empty representation has no satisfiable byte range');

  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new DownloadRangeError('invalid suffix byte range');
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(first);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw new DownloadRangeError('byte range starts beyond the representation');
  if (!last) return { start, end: size - 1 };
  const requestedEnd = Number(last);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) throw new DownloadRangeError('invalid byte range end');
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** If-Range accepts an exact strong ETag or a date not older than the representation. */
export function ifRangeMatches(raw: string | null, etag: string, mtimeMs: number): boolean {
  if (!raw) return true;
  const value = raw.trim();
  if (!value || value.startsWith('W/')) return false;
  if (value.startsWith('"')) return value === etag;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(dateMs / 1000);
}

const UTF8_CONTROL_ALLOWLIST = new Set([
  0x09, // tab
  0x0a, // lf
  0x0d, // cr
]);

export class FsBrowseError extends Error {
  constructor(
    readonly code: FsRejectCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FsDownloadResult {
  path: string;
  abs: string;
  fd: number;
  size: number;
  mtimeMs: number;
  etag: string;
}

const normalizeRelPath = (path: string | null | undefined): string => {
  const raw = typeof path === 'string' ? path : '';
  if (!raw) return '.';
  if (raw.includes('\0')) throw new FsBrowseError('BAD_PARAM', 'path contains a NUL byte');
  return raw;
};

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

function assertSafePath(baseDir: string, requestedPath: string | null | undefined): { abs: string; rel: string } {
  if (!baseDir) throw new FsBrowseError('NO_CWD', 'session has no workspace root');
  const safe = normalizeRelPath(requestedPath);
  if (isAbsolute(safe)) throw new FsBrowseError('PATH_ESCAPE', 'absolute paths are not allowed');

  const base = resolve(baseDir);
  const abs = resolve(base, safe);
  if (!isWithin(base, abs)) throw new FsBrowseError('PATH_ESCAPE', 'path escapes workspace root');

  const rel = relative(base, abs) || '.';
  const parts = toPosixPath(rel).split('/').filter(Boolean);
  let cursor = base;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) continue;
    const st = lstatSync(cursor);
    if (st.isSymbolicLink()) throw new FsBrowseError('PATH_SYMLINK', 'path crosses or ends at a symbolic link');
  }
  return { abs, rel: toPosixPath(rel) };
}

function nodeInfo(abs: string, rel: string): FsNodeInfo {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsBrowseError('NOT_FOUND', `path not found: ${rel}`);
    throw err;
  }
  if (st.isSymbolicLink()) throw new FsBrowseError('PATH_SYMLINK', 'path is a symbolic link');
  return {
    path: rel,
    type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    size: st.size,
    mtimeMs: st.mtimeMs,
    isDirectory: st.isDirectory(),
    isRegularFile: st.isFile(),
    isSymbolicLink: false,
  };
}

export function readSessionStat(cwd: string, rawPath: string | null | undefined): FsNodeInfo {
  const { abs, rel } = assertSafePath(cwd, rawPath);
  return nodeInfo(abs, rel);
}

export function readSessionDirectory(cwd: string, rawPath: string | null | undefined): FsDirectoryResult {
  const { abs, rel } = assertSafePath(cwd, rawPath);
  const st = (() => {
    try {
      return lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsBrowseError('NOT_FOUND', `path not found: ${rel}`);
      throw err;
    }
  })();
  if (st.isSymbolicLink()) throw new FsBrowseError('PATH_SYMLINK', 'path is a symbolic link');
  if (!st.isDirectory()) throw new FsBrowseError('NOT_DIRECTORY', `not a directory: ${rel}`);

  const cwdAbs = resolve(cwd);
  const entries: FsDirEntry[] = [];
  for (const name of readdirSync(abs)) {
    const child = resolve(abs, name);
    let childInfo;
    try {
      childInfo = lstatSync(child);
    } catch {
      continue;
    }
    const type = childInfo.isDirectory() ? 'directory' : childInfo.isFile() ? 'file' : childInfo.isSymbolicLink() ? 'symlink' : 'other';
    entries.push({
      name,
      path: toPosixPath(relative(cwdAbs, child)),
      type,
      size: childInfo.size,
      mtimeMs: childInfo.mtimeMs,
    });
  }

  return {
    path: rel,
    stat: {
      path: rel,
      type: 'directory',
      size: st.size,
      mtimeMs: st.mtimeMs,
      isDirectory: true,
      isRegularFile: false,
      isSymbolicLink: false,
    },
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function readSessionFile(
  cwd: string,
  rawPath: string | null | undefined,
  maxBytes: number,
  capBytes = DEFAULT_FS_READ_CAP_BYTES,
): FsReadResult {
  const { abs, rel } = assertSafePath(cwd, rawPath);
  const safeCap = Number.isFinite(capBytes) ? Math.max(1, Math.floor(capBytes)) : DEFAULT_FS_READ_CAP_BYTES;
  const maxRaw = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : safeCap;
  const max = Math.min(maxRaw, safeCap);
  const st = nodeInfo(abs, rel);
  if (!st.isRegularFile) throw new FsBrowseError('NOT_REGULAR_FILE', `not a regular file: ${rel}`);
  const wantBytes = Math.min(st.size, max);
  const bytes = new Uint8Array(wantBytes);
  const fd = openSync(abs, 'r');
  try {
    const n = readSync(fd, bytes, 0, wantBytes, 0);
    const out = n === wantBytes ? bytes : bytes.slice(0, n);
    const utf8 = looksUtf8ish(out);
    if (utf8) {
      return {
        path: rel,
        size: st.size,
        limit: max,
        truncated: st.size > n,
        encoding: 'utf8',
        data: new TextDecoder().decode(out),
      };
    }
    return {
      path: rel,
      size: st.size,
      limit: max,
      truncated: st.size > n,
      encoding: 'base64',
      data: Buffer.from(out).toString('base64'),
    };
  } finally {
    closeSync(fd);
  }
}

export function prepareSessionDownload(
  baseDir: string,
  rawPath: string | null | undefined,
  maxBytes: number,
): FsDownloadResult {
  const { abs, rel } = assertSafePath(baseDir, rawPath);
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsBrowseError('NOT_FOUND', `path not found: ${rel}`);
    throw err;
  }
  if (st.isSymbolicLink()) throw new FsBrowseError('PATH_SYMLINK', 'path is a symbolic link');
  if (!st.isFile()) throw new FsBrowseError('NOT_REGULAR_FILE', `not a regular file: ${rel}`);
  const safeMax = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : DEFAULT_FS_READ_CAP_BYTES;
  if (st.size > safeMax) throw new FsBrowseError('FS_DOWNLOAD_TOO_LARGE', `download exceeds COSYNCING_FS_DOWNLOAD_MAX_BYTES (${safeMax})`);
  const fd = (() => {
    try {
      return openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new FsBrowseError('PATH_SYMLINK', 'path is a symbolic link');
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FsBrowseError('NOT_FOUND', `path not found: ${rel}`);
      throw err;
    }
  })();
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new FsBrowseError('NOT_REGULAR_FILE', `not a regular file: ${rel}`);
    if (opened.dev !== st.dev || opened.ino !== st.ino) throw new FsBrowseError('NOT_FOUND', `path changed during download open: ${rel}`);
    if (opened.size > safeMax) throw new FsBrowseError('FS_DOWNLOAD_TOO_LARGE', `download exceeds COSYNCING_FS_DOWNLOAD_MAX_BYTES (${safeMax})`);
    const validator = [opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs].join('\0');
    const etag = `"${createHash('sha256').update(validator).digest('base64url')}"`;
    return { path: rel, abs, fd, size: opened.size, mtimeMs: opened.mtimeMs, etag };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

export function looksUtf8ish(bytes: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!decoded || bytes.includes(0)) return false;
    let suspicious = 0;
    for (const ch of decoded) {
      const c = ch.codePointAt(0) ?? 0;
      if (c === 0xfffd) return false;
      if (c < 0x20 && !UTF8_CONTROL_ALLOWLIST.has(c)) {
        suspicious += 1;
      }
    }
    return suspicious <= Math.max(1, Math.floor(decoded.length * 0.05));
  } catch {
    return false;
  }
}

/** Small smoke helper: detect impossible paths in a way that mirrors the broker-facing helper checks. */
export function validateBrowsePath(cwd: string, raw: string | null | undefined): { abs: string; rel: string } {
  if (typeof cwd !== 'string') throw new Error('cwd is required');
  return assertSafePath(cwd, raw);
}
