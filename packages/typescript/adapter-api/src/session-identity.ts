/**
 * Which session ids an adapter may act on.
 *
 * One rule, applied by every adapter: an id that reaches attach, resume, a
 * history read, rename or fork must name a session the adapter's OWN store or
 * native server would publish. Anything else is refused with
 * {@link SessionNotFoundError}, which the broker answers as `NOT_FOUND`.
 *
 * Two shapes of id exist, and each has one helper:
 *
 *  - An id that IS a path (Codex rollouts, Claude transcripts: base64url of the
 *    file). It is admitted only when the file it names, with every symlink and
 *    `..` resolved, sits inside the adapter's store root
 *    ({@link containedStorePath}).
 *  - An id a native server or store mints (OpenCode, Kilo, Kimi). It is spliced
 *    into URL paths, store paths and argv, so it must be ONE opaque segment
 *    ({@link isOpaqueSessionId}); and it is encoded wherever it is spliced, so a
 *    rule miss can never climb out of the route it was put in.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isRegularFileSync } from './store-file.ts';

/**
 * The session an id names is not one this adapter's store or native server
 * publishes: unlisted, outside the store, or not an id at all.
 *
 * Deliberately not an ownership or capability refusal. Nothing a retry, a
 * takeover or a different mode can change: the id names nothing this adapter
 * may open. The broker maps it to `NOT_FOUND` on its HTTP routes, and an attach
 * that throws it ends with the attach error frame.
 */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

/** Cross-realm-safe predicate, for the same reason as {@link isOwnershipConflictError}. */
export function isSessionNotFoundError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError
    || (error instanceof Error && error.name === 'SessionNotFoundError');
}

/** The longest native session id accepted, in Unicode scalars (Kilo's measured store bound). */
export const OPAQUE_SESSION_ID_MAX_SCALARS = 256;

/**
 * Whether `value` can be a native session id that is spliced into a URL path,
 * a store path or an argv as ONE segment.
 *
 * Refused: anything but a non-empty string of at most
 * {@link OPAQUE_SESSION_ID_MAX_SCALARS} scalars; a control character; a path
 * separator (`/` or `\`, on every platform); a dot segment (`.` or `..`); a
 * percent sign, so no server or proxy that decodes the path once can turn the
 * id into a separator or a dot segment; and a leading `-`, so the id can never
 * read as an option where a native CLI takes it as an argument. Real ids
 * (`ses_…`, `session_<uuid>`) contain none of these.
 */
export function isOpaqueSessionId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === '.' || value === '..' || value.startsWith('-')) return false;
  if (/[\u0000-\u001f\u007f/\\%]/u.test(value)) return false;
  return [...value].length <= OPAQUE_SESSION_ID_MAX_SCALARS;
}

/**
 * `path` in the real namespace: realpath when it exists; otherwise the realpath
 * of its nearest EXISTING ancestor with the missing tail rejoined.
 *
 * A missing final component must not skip canonicalization of the components
 * above it: `resolve()` on `/x/link/new.jsonl` whose `link` is a symlink hands
 * back the literal, so a containment check on the answer sees the symlink's
 * NAME and passes for a directory that points anywhere.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    /* the path itself is missing — canonicalize what of it does exist */
  }
  const absolute = resolve(path);
  let base = absolute;
  const missing: string[] = [];
  for (;;) {
    const parent = dirname(base);
    if (parent === base) return absolute; // nothing on this volume exists; nothing to canonicalize
    const name = basename(base);
    if (name) missing.unshift(name);
    base = parent;
    let real: string;
    try {
      real = realpathSync(base);
    } catch {
      continue;
    }
    return missing.length ? join(real, ...missing) : real;
  }
}

/**
 * Whether the nearest EXISTING ancestor of a missing `path` is a directory, i.e. whether the path
 * could ever be created. POSIX answers a path under a file with `ENOTDIR`, but Windows answers it
 * with `ENOENT`, the same as a path that is merely not written yet, so the shape is checked here.
 */
function creatableBelowNearestAncestor(path: string): boolean {
  let base = resolve(path);
  for (;;) {
    const parent = dirname(base);
    if (parent === base) return true; // nothing on this volume exists; nothing above it is a file
    base = parent;
    try {
      return statSync(base).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    }
  }
}

/** Is `target` strictly beneath `root` (both canonical)? Case-insensitive where the platform is. */
function strictlyWithin(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

/**
 * The canonical path `path` names, when it lies strictly inside one of `roots`
 * with every symlink and `..` resolved; otherwise `undefined`.
 *
 * - A path that EXISTS must resolve: a dangling symlink (or a loop) names
 *   nothing, and is refused.
 * - A path that does not exist (`ENOENT`) is admitted only with
 *   `allowMissing` — a session created but not yet written, such as a Codex
 *   thread before its first turn. It is canonicalized through its nearest
 *   existing ancestor, so a symlinked directory above it cannot carry it out
 *   of the store, and it cannot exfiltrate anything: there is nothing to read. A path under a
 *   FILE is not missing but impossible, and is refused on every platform.
 * - With `regularFile`, a path that exists must resolve to a regular file: a
 *   FIFO, socket, device or directory under a session name is no session, and
 *   opening a FIFO would block the reader (see `store-file.ts`).
 * - Any other failure (permission, a file used as a directory) is refused.
 */
export function containedStorePath(
  roots: readonly string[],
  path: string,
  options: { allowMissing?: boolean; regularFile?: boolean } = {},
): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return undefined;
  let present: boolean;
  try {
    lstatSync(path);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !options.allowMissing) return undefined;
    present = false;
  }
  let canonical: string;
  if (present) {
    try {
      canonical = realpathSync(path);
    } catch {
      return undefined;
    }
    if (options.regularFile && !isRegularFileSync(canonical)) return undefined;
  } else {
    if (!creatableBelowNearestAncestor(path)) return undefined;
    canonical = canonicalPath(path);
  }
  return roots.some((root) => strictlyWithin(canonicalPath(root), canonical)) ? canonical : undefined;
}
