import { lstatSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

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

/**
 * Match a Unix-socket table row by PATH rather than by substring.
 *
 * `/proc/net/unix` puts the bound path in the last column, so a row matches only when the path ends the
 * row at a column boundary. The substring test this replaces let one socket answer for every longer path
 * that merely contained its name, and a runtime directory holding several generation-named sockets is
 * exactly where that coincidence stops being hypothetical.
 */
export function unixSocketTableListensFor(table: string, socketPath: string): boolean {
  if (socketPath.length === 0) return false;
  return table.split('\n').some((line) => {
    if (!line.endsWith(socketPath)) return false;
    const boundary = line[line.length - socketPath.length - 1];
    return boundary === undefined || /\s/.test(boundary);
  });
}

export type CodexRuntimeSocketListener = 'listening' | 'dead' | 'unknown';

export interface CodexRuntimeSocketProbeDependencies {
  platform?: NodeJS.Platform;
  /** `/proc/net/unix`, or undefined when it cannot be read. */
  readUnixTable?: () => Promise<string | undefined>;
  /** Whether a stream connection to `path` opens within `timeoutMs`: undefined on a timeout. */
  connects?: (path: string, timeoutMs: number) => Promise<boolean | undefined>;
  timeoutMs?: number;
}

const UNIX_TABLE_MAX_BYTES = 4 * 1024 * 1024;

async function readLinuxUnixTable(): Promise<string | undefined> {
  try {
    const text = await readFile('/proc/net/unix', 'utf8');
    return text.length <= UNIX_TABLE_MAX_BYTES ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Open and close a connection, sending nothing. Bun reports every failed Unix connect as ENOENT
 * (a refusal, a permission denial and a full backlog alike), so the error code is never consulted. */
function streamConnects(path: string, timeoutMs: number): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path });
    const done = (value: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), Math.max(1, timeoutMs));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Is anything still listening at a control endpoint that did not answer? Asked only after the daemon
 * failed to answer, or when the endpoint is an alias whose target cannot be read.
 *
 * `dead` is positive evidence that nothing can be reached there, never an inference from a failed
 * RPC: the endpoint (or the target its symlink names) does not exist, or, on Linux, the kernel lists
 * no socket bound at the path or its target AND a connection to it fails. A bound row, an opened
 * connection, a timeout, an unreadable table, and every host without `/proc/net/unix` are not proof
 * (`listening` or `unknown`). Read-only: it never removes, replaces or rebinds the endpoint, and it
 * sends nothing on a connection it opens.
 */
export async function probeCodexRuntimeSocketListener(
  path: string,
  dependencies: CodexRuntimeSocketProbeDependencies = {},
): Promise<CodexRuntimeSocketListener> {
  let entry;
  try { entry = lstatSync(path); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
  }
  const bound = [path];
  if (entry.isSymbolicLink()) {
    let target;
    try { target = statSync(path); }
    catch (error) {
      // A dangling alias: no file exists at the target for any process to listen on.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
    }
    if (!target.isSocket()) return 'unknown';
    try { bound.push(realpathSync(path)); } catch { return 'unknown'; }
  } else if (!entry.isSocket()) {
    return 'unknown';
  }
  if ((dependencies.platform ?? process.platform) !== 'linux') return 'unknown';
  const table = await (dependencies.readUnixTable ?? readLinuxUnixTable)();
  if (table === undefined) return 'unknown';
  if (bound.some((candidate) => unixSocketTableListensFor(table, candidate))) return 'listening';
  // Nothing in this network namespace is bound there. A listener in another namespace that shares the
  // file system would still accept, so the connection decides.
  const opened = await (dependencies.connects ?? streamConnects)(path, dependencies.timeoutMs ?? 1_000);
  return opened === false ? 'dead' : opened ? 'listening' : 'unknown';
}
