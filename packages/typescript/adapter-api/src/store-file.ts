/**
 * Reading a file from an agent's native session store without ever blocking.
 *
 * A session store is a directory other local processes write into, and a
 * session-like name is all discovery has to go on. A FIFO under that name
 * blocks `open()` for reading until a writer appears: a synchronous open stops
 * the broker's event loop (every route and socket with it), and an asynchronous
 * one parks a worker thread for good. A socket, a device or a directory under a
 * session name is no transcript either.
 *
 * So a store read accepts only a REGULAR file, decided three times:
 *
 *  1. `stat` before the open. Anything else is refused without being opened,
 *     so a device never sees an `open()` at all.
 *  2. The open cannot block: `O_NONBLOCK` makes a FIFO swapped in after step 1
 *     return at once, and `O_NOCTTY` keeps a terminal swapped in from becoming
 *     the broker's controlling terminal. Neither flag changes how a regular
 *     file reads.
 *  3. `fstat` on the DESCRIPTOR closes the race between 1 and 2: whatever the
 *     path names by then, only a regular file is handed back.
 *
 * Windows defines neither flag (`fs.constants` omits them, and passing a POSIX
 * bit could be refused), and no FIFO can live in these stores there: named
 * pipes have their own namespace. The flags fall back to a plain read-only
 * open, and both type checks still apply.
 *
 * Symlinks are followed like any `open()`. Whether the file is INSIDE the store
 * is a separate question ({@link containedStorePath}); a caller that refuses a
 * symlinked leaf passes `noFollow`.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { lstat, open, stat, type FileHandle } from 'node:fs/promises';

/** Read-only, and an open that can never wait on a writer or adopt a terminal. */
export const STORE_READ_FLAGS: number = constants.O_RDONLY
  | (constants.O_NONBLOCK ?? 0)
  | (constants.O_NOCTTY ?? 0);

/** `O_NOFOLLOW` where the platform has it (0 on Windows). */
export const NO_FOLLOW_FLAG: number = constants.O_NOFOLLOW ?? 0;

/** The code a {@link NotRegularFileError} carries, beside `ENOENT` and friends. */
export const NOT_REGULAR_FILE_CODE = 'ENOTREGULAR';

/**
 * The path names something other than a regular file: a FIFO, socket, device or
 * directory. A store reader treats it as no session at all — discovery skips it
 * and an attach refuses it.
 */
export class NotRegularFileError extends Error {
  readonly code = NOT_REGULAR_FILE_CODE;
  constructor(readonly path: string) {
    super(`${path} is not a regular file`);
    this.name = 'NotRegularFileError';
  }
}

/** Cross-realm-safe predicate, for the same reason as `isSessionNotFoundError`. */
export function isNotRegularFileError(error: unknown): error is NotRegularFileError {
  return error instanceof NotRegularFileError
    || (error instanceof Error && (error as NodeJS.ErrnoException).code === NOT_REGULAR_FILE_CODE);
}

export interface StoreOpenOptions {
  /** Refuse a symlink at the final component instead of following it. */
  noFollow?: boolean;
}

/** Does `path` name a regular file now (following symlinks unless `noFollow`)? Never opens it. */
export function isRegularFileSync(path: string, options: StoreOpenOptions = {}): boolean {
  try {
    return (options.noFollow ? lstatSync(path) : statSync(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A read-only descriptor on the regular file `path` names; the caller closes
 * it. Throws what `openSync` would (`ENOENT`, `EACCES`, `ELOOP` under
 * `noFollow`), or {@link NotRegularFileError}. Never blocks.
 */
export function openRegularFileSync(path: string, options: StoreOpenOptions = {}): number {
  if (!(options.noFollow ? lstatSync(path) : statSync(path)).isFile()) throw new NotRegularFileError(path);
  const fd = openSync(path, STORE_READ_FLAGS | (options.noFollow ? NO_FOLLOW_FLAG : 0));
  let admitted = false;
  try {
    if (!fstatSync(fd).isFile()) throw new NotRegularFileError(path);
    admitted = true;
    return fd;
  } finally {
    if (!admitted) closeSync(fd);
  }
}

/** `readFileSync` for a store file: the same bytes, and only from a regular file. */
export function readRegularFileSync(path: string, options?: StoreOpenOptions): Buffer;
export function readRegularFileSync(path: string, encoding: BufferEncoding, options?: StoreOpenOptions): string;
export function readRegularFileSync(
  path: string,
  encodingOrOptions?: BufferEncoding | StoreOpenOptions,
  maybeOptions?: StoreOpenOptions,
): Buffer | string {
  const encoding = typeof encodingOrOptions === 'string' ? encodingOrOptions : undefined;
  const options = (typeof encodingOrOptions === 'object' ? encodingOrOptions : maybeOptions) ?? {};
  const fd = openRegularFileSync(path, options);
  try {
    return encoding ? readFileSync(fd, encoding) : readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The files SQLite may open beside a database, by suffix. */
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

/**
 * Whether SQLite can open the database at `path` without blocking: it is a regular file, and so
 * is each `-wal`, `-shm` or `-journal` sidecar that exists (a missing one is fine; pass
 * `sidecars: false` for an `immutable=1` open, which reads none). SQLite's own opens cannot take
 * `O_NONBLOCK`, so this check before the open is the guard; a swap in the instant between the two
 * is closed only by a reader that copies the database through a descriptor first (Kilo).
 */
export function isRegularSqliteStoreSync(path: string, options: { sidecars?: boolean } = {}): boolean {
  if (!isRegularFileSync(path)) return false;
  if (options.sidecars === false) return true;
  return SQLITE_SIDECARS.every((suffix) => {
    try {
      return statSync(`${path}${suffix}`).isFile();
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    }
  });
}

/** The asynchronous {@link openRegularFileSync}: a handle on a regular file, or a rejection. */
export async function openRegularFile(path: string, options: StoreOpenOptions = {}): Promise<FileHandle> {
  if (!(await (options.noFollow ? lstat(path) : stat(path))).isFile()) throw new NotRegularFileError(path);
  const handle = await open(path, STORE_READ_FLAGS | (options.noFollow ? NO_FOLLOW_FLAG : 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(path);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
