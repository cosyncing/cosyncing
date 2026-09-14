/** Read-only, snapshot-copied Kilo Code SQLite discovery. */
import { constants } from 'node:fs';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { HistorySourceIdentity, SessionDiscoveryWork } from '@cosyncing/adapter-api';
import {
  readOpenCodeSqliteHistory,
  readOpenCodeSqliteMessageIds,
  readOpenCodeSqliteSession,
  readOpenCodeSqliteSessions,
  type OpenCodeSqliteSession,
} from '@cosyncing/opencode-wire';
import { mapKiloPart, validateKiloMessage, validateKiloPart } from './mapping.ts';

// Re-exported, not re-declared. Two independent literals for the pinned version
// meant `index.ts` re-exported the copy the runtime gate does NOT consult, so a
// bump could move one and silently leave the gate on the other.
export { KILO_VERIFIED_VERSION } from './version.ts';
export const KILO_MAX_DATABASE_BYTES = 64 * 1024 * 1024;
export const KILO_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const KILO_MAX_DISCOVERY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const KILO_MAX_DATABASES = 8;
export const KILO_MAX_DATA_ROOT_ENTRIES = 256;
export const KILO_MAX_SESSIONS = 2_000;

/**
 * Database paths currently reported as over a discovery bound.
 *
 * Grows with DISTINCT database paths seen by this process, not with the
 * databases on the machine: the path is derived from each call's `env`/`homeDir`
 * and `KILO_MAX_DATABASES` caps names within ONE sweep, not keys across a
 * lifetime. The broker builds one adapter over `process.env` so it sees a fixed
 * set, but an embedder — or this repository's own test suite — can drive it with
 * many roots. Entries are a path string each and are dropped again by
 * {@link clearKiloBoundWarning}.
 */
const warnedBounds = new Set<string>();

function warnBoundOnce(key: string, message: string): void {
  if (warnedBounds.has(key)) return;
  warnedBounds.add(key);
  console.warn(`[cosyncing] ${message}`);
}

/**
 * Re-arm the warning for a database that is back within its bound.
 *
 * Without this the message fires once per process and never again, so an
 * operator who does exactly what it tells them — archive sessions to get back
 * under the bound — and later drifts over it again gets the silent empty-Kilo
 * symptom this warning exists to explain. Deleting and recreating the database
 * was silent for the same reason.
 */
function clearKiloBoundWarning(key: string): void {
  warnedBounds.delete(key);
}

/** Test-only: forget which bounds have been reported. */
export function resetKiloBoundWarnings(): void {
  warnedBounds.clear();
}
export const KILO_MAX_MESSAGES_PER_SESSION = 10_000;
export const KILO_MAX_PARTS_PER_SESSION = 50_000;
export const KILO_MAX_CANONICAL_MESSAGE_BYTES = 1024 * 1024;
export const KILO_MAX_CANONICAL_HISTORY_BYTES = 32 * 1024 * 1024;
export const KILO_MAX_RAW_RECORD_BYTES = 1024 * 1024;
export const KILO_MAX_RAW_HISTORY_BYTES = 32 * 1024 * 1024;
export const KILO_MAX_SESSION_METADATA_BYTES = 8 * 1024 * 1024;
export const KILO_MAX_IDENTITY_BYTES = 1024;
const KILO_MAX_ID_SCALARS = 256;
const KILO_MAX_TITLE_SCALARS = 2_048;
const KILO_MAX_CWD_SCALARS = 4_096;
const KILO_MAX_MODEL_SCALARS = 512;
const SNAPSHOT_ATTEMPTS = 3;
const REQUIRED_SESSION_COLUMNS = [
  'id', 'parent_id', 'slug', 'directory', 'title', 'model', 'revert', 'agent',
  'time_created', 'time_updated', 'time_archived',
] as const;
const REQUIRED_MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'data'] as const;
const REQUIRED_PART_COLUMNS = ['id', 'message_id', 'session_id', 'time_created', 'data'] as const;

export interface KiloStoreTrace {
  op: 'store-read' | 'path-refused' | 'schema-refused' | 'snapshot-retry' | 'discovery-bound';
  path?: string;
  detail: string;
}

export interface KiloStoredSession {
  id: string;
  nativeId: string;
  title: string;
  cwd: string;
  model?: string;
  currentModel?: { providerID: string; modelID: string; variant?: string };
  currentAgent?: string;
  createdAt?: number;
  updatedAt?: number;
  status: 'idle' | 'working';
  origin?: 'subagent';
  parentThreadId?: string;
  databasePath: string;
  dataRoot: string;
}

export interface KiloHistorySnapshot {
  messages: import('@cosyncing/adapter-api').AgentMessage[];
  encodings: string[];
  messageIds: string[];
  revision: string;
  sourceIdentity: string;
}

function framedDigest(values: readonly string[]): string {
  const digest = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    digest.update(String(bytes.length));
    digest.update(':');
    digest.update(bytes);
    digest.update(';');
  }
  return digest.digest('base64url');
}

/** Session-specific identity from one already-stable SQLite snapshot. */
export function kiloHistorySourceIdentity(
  session: KiloStoredSession,
  snapshot: KiloHistorySnapshot,
): HistorySourceIdentity {
  return {
    sourceId: `${session.databasePath}:${snapshot.sourceIdentity}:${session.id}`,
    revision: framedDigest(snapshot.encodings),
    appendPosition: snapshot.messageIds.length,
    rewriteToken: framedDigest(snapshot.messageIds),
  };
}

export interface KiloDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  updatedAfter?: number;
  signal?: AbortSignal;
  onWork?: (work: SessionDiscoveryWork) => void;
  trace?: (event: KiloStoreTrace) => void;
  /** Include native child rows only for a live-server-qualified discovery pass. */
  includeUnverifiedChildren?: boolean;
  /** Live overlay: bounded active-session directory inventory, independent of the idle cutoff. */
  collectDirectories?: Set<string>;
}

interface Signature {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface OpenDataRoot {
  fd: number;
  descriptorPath: string;
}

type SignatureState =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; signature: Signature };

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Kilo discovery aborted.');
}

export function kiloDataRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string {
  const xdg = env.XDG_DATA_HOME?.trim() || join(userHome, '.local', 'share');
  return resolve(env.KILO_DATA_DIR?.trim() || join(xdg, 'kilo'));
}

function pathHasSymlinkComponent(path: string): boolean {
  const absolute = resolve(path);
  const parts = absolute.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function openDataRoot(dataRoot: string): OpenDataRoot | undefined {
  let before: ReturnType<typeof lstatSync>;
  try {
    if (pathHasSymlinkComponent(dataRoot)) return undefined;
    before = lstatSync(dataRoot, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
  } catch { return undefined; }
  let fd: number | undefined;
  try {
    fd = openSync(dataRoot, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      closeSync(fd);
      return undefined;
    }
    const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
    return { fd, descriptorPath: join(descriptorRoot, String(fd)) };
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

function signatureState(path: string): SignatureState {
  try {
    const link = lstatSync(path, { bigint: true });
    if (link.isSymbolicLink() || !link.isFile() || link.size > BigInt(KILO_MAX_DATABASE_BYTES)) return { status: 'invalid' };
    return {
      status: 'valid',
      signature: {
        path, dev: link.dev, ino: link.ino, size: link.size,
        mtimeNs: link.mtimeNs, ctimeNs: link.ctimeNs,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
}

function sameSignatureState(left: SignatureState, right: SignatureState): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== 'valid' || right.status !== 'valid') return true;
  return left.signature.path === right.signature.path
    && left.signature.dev === right.signature.dev
    && left.signature.ino === right.signature.ino
    && left.signature.size === right.signature.size
    && left.signature.mtimeNs === right.signature.mtimeNs
    && left.signature.ctimeNs === right.signature.ctimeNs;
}

function kiloDatabaseNames(openedDataRoot: string): string[] {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(openedDataRoot);
    const entries: string[] = [];
    for (let count = 0; ; count += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (count >= KILO_MAX_DATA_ROOT_ENTRIES) return [];
      if (entry.isFile() && !entry.isSymbolicLink()) entries.push(entry.name);
    }
    const kilo = entries.filter((name) => name === 'kilo.db' || /^kilo-[a-z0-9._-]+\.db$/iu.test(name));
    const selected = kilo.length > 0
      ? kilo
      : entries.filter((name) => name === 'opencode.db' || /^opencode-[a-z0-9._-]+\.db$/iu.test(name));
    if (selected.length > KILO_MAX_DATABASES) return [];
    return selected.sort((left, right) => {
      if (left === 'kilo.db' || left === 'opencode.db') return -1;
      if (right === 'kilo.db' || right === 'opencode.db') return 1;
      return left.localeCompare(right);
    });
  } catch {
    return [];
  } finally {
    try { directory?.closeSync(); } catch { /* best effort */ }
  }
}

export function kiloDatabasePaths(dataRoot: string): string[] {
  const opened = openDataRoot(dataRoot);
  if (!opened) return [];
  try {
    return kiloDatabaseNames(opened.descriptorPath).map((name) => join(dataRoot, name));
  } finally { closeSync(opened.fd); }
}

function snapshotStates(databasePath: string): SignatureState[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`].map(signatureState);
}

function schemaMatches(database: Database): boolean {
  const journalMode = database.query('pragma journal_mode').get() as { journal_mode?: unknown } | null;
  if (String(journalMode?.journal_mode ?? '').toLowerCase() !== 'wal') return false;
  const tables = new Set((database.query("select name from sqlite_master where type='table'").all() as any[])
    .map((row) => String(row.name)));
  if (!tables.has('migration') || !tables.has('session') || !tables.has('message') || !tables.has('part')) return false;
  const columns = (table: string) => new Set((database.query(`pragma table_info(${table})`).all() as any[])
    .map((row) => String(row.name)));
  const session = columns('session');
  const message = columns('message');
  const part = columns('part');
  return REQUIRED_SESSION_COLUMNS.every((name) => session.has(name))
    && REQUIRED_MESSAGE_COLUMNS.every((name) => message.has(name))
    && REQUIRED_PART_COLUMNS.every((name) => part.has(name));
}

function sessionMetadataWithinBounds(database: Database, sessionId?: string, updatedAfter?: number): boolean {
  const conditions = [
    ...(sessionId === undefined ? ['time_archived is null'] : ['id = ?']),
    ...(updatedAfter === undefined ? [] : ['coalesce(time_updated, time_created) >= ?']),
  ];
  const where = ` where ${conditions.join(' and ')}`;
  const query = database.query(`select
    coalesce(max(length(cast(model as blob))), 0) as modelMax,
    coalesce(max(length(cast(revert as blob))), 0) as revertMax,
    coalesce(max(length(cast(directory as blob))), 0) as directoryMax,
    coalesce(max(length(cast(title as blob))), 0) as titleMax,
    coalesce(max(length(cast(slug as blob))), 0) as slugMax,
    coalesce(max(length(cast(agent as blob))), 0) as agentMax,
    coalesce(sum(coalesce(length(cast(model as blob)), 0) + coalesce(length(cast(revert as blob)), 0)
      + coalesce(length(cast(directory as blob)), 0) + coalesce(length(cast(title as blob)), 0)
      + coalesce(length(cast(slug as blob)), 0) + coalesce(length(cast(agent as blob)), 0)), 0) as total
    from session${where}`);
  const params = [
    ...(sessionId === undefined ? [] : [sessionId]),
    ...(updatedAfter === undefined ? [] : [updatedAfter]),
  ];
  const size = query.get(...params) as {
    modelMax?: number | bigint;
    revertMax?: number | bigint;
    directoryMax?: number | bigint;
    titleMax?: number | bigint;
    slugMax?: number | bigint;
    agentMax?: number | bigint;
    total?: number | bigint;
  } | null;
  const fields = [size?.modelMax, size?.revertMax, size?.directoryMax, size?.titleMax,
    size?.slugMax, size?.agentMax].map((value) => Number(value ?? 0));
  const total = Number(size?.total ?? 0);
  return fields.every(Number.isSafeInteger) && Number.isSafeInteger(total)
    && fields.every((value) => value <= KILO_MAX_RAW_RECORD_BYTES)
    && total <= KILO_MAX_SESSION_METADATA_BYTES;
}

async function copyStableFile(signature: Signature, destination: string, signal?: AbortSignal): Promise<void> {
  const source = await openFile(signature.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let target: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    const opened = await source.stat({ bigint: true });
    const openedSignature: Signature = {
      path: signature.path,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
    };
    if (!opened.isFile() || !sameSignatureState(
      { status: 'valid', signature },
      { status: 'valid', signature: openedSignature },
    )) throw new Error('Kilo SQLite source identity changed before the no-follow open');
    target = await openFile(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0n;
    while (copied < signature.size) {
      throwIfAborted(signal);
      const remaining = signature.size - copied;
      const wanted = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const { bytesRead } = await source.read(buffer, 0, wanted, Number(copied));
      if (bytesRead <= 0) throw new Error('Kilo SQLite source shrank during snapshot copy');
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written);
        if (result.bytesWritten <= 0) throw new Error('Kilo SQLite snapshot destination stopped accepting bytes');
        written += result.bytesWritten;
      }
      copied += BigInt(bytesRead);
    }
    const after = await source.stat({ bigint: true });
    const afterSignature: Signature = {
      path: signature.path,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
    };
    if (!sameSignatureState(
      { status: 'valid', signature },
      { status: 'valid', signature: afterSignature },
    )) throw new Error('Kilo SQLite source changed during no-follow snapshot copy');
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function withKiloSnapshot<T>(
  databasePath: string,
  displayPath: string,
  signal: AbortSignal | undefined,
  trace: KiloDiscoveryOptions['trace'],
  read: (database: Database, revision: string, sourceIdentity: string) => T,
  copyBudget?: { remaining: bigint },
): Promise<T | undefined> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const before = snapshotStates(databasePath);
    if (before[3]?.status !== 'missing') {
      trace?.({
        op: 'path-refused', path: displayPath,
        detail: 'Kilo rollback-journal snapshots are unsupported; only the measured WAL-mode store is accepted',
      });
      return undefined;
    }
    if (before[0]?.status !== 'valid' || before.some((state) => state.status === 'invalid')) {
      trace?.({ op: 'path-refused', path: displayPath, detail: 'Kilo SQLite database or sidecar has an unsafe type, size, or metadata state' });
      return undefined;
    }
    const stableBefore = before.flatMap((state) => state.status === 'valid' ? [state.signature] : []);
    const total = stableBefore.reduce((sum, signature) => sum + signature.size, 0n);
    if (total > BigInt(KILO_MAX_SNAPSHOT_BYTES)) {
      trace?.({ op: 'discovery-bound', path: displayPath, detail: `Kilo SQLite snapshot exceeds ${KILO_MAX_SNAPSHOT_BYTES} bytes` });
      return undefined;
    }
    if (copyBudget && total > copyBudget.remaining) {
      trace?.({
        op: 'discovery-bound', path: displayPath,
        detail: `Kilo SQLite copy work exceeds the remaining ${copyBudget.remaining}-byte discovery budget`,
      });
      return undefined;
    }
    if (copyBudget) copyBudget.remaining -= total;
    const temp = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-db-'));
    try {
      for (const signature of stableBefore) {
        throwIfAborted(signal);
        await copyStableFile(signature, join(temp, basename(signature.path)), signal);
      }
      const after = snapshotStates(databasePath);
      if (!before.every((state, index) => sameSignatureState(state, after[index]!))) {
        trace?.({ op: 'snapshot-retry', path: displayPath, detail: `Kilo SQLite source changed during snapshot attempt ${attempt + 1}` });
        continue;
      }
      const copyPath = join(temp, basename(databasePath));
      const database = new Database(copyPath, { readonly: true });
      try {
        if (!schemaMatches(database)) {
          trace?.({ op: 'schema-refused', path: displayPath, detail: 'Kilo SQLite schema does not match the measured OpenCode lineage' });
          return undefined;
        }
        const revision = stableBefore.map((signature) => [
          basename(signature.path), signature.dev, signature.ino, signature.size,
          signature.mtimeNs, signature.ctimeNs,
        ].join(':')).join('|');
        const main = stableBefore[0]!;
        return read(database, revision, `${main.dev}:${main.ino}`);
      } finally {
        database.close();
      }
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      trace?.({ op: 'store-read', path: displayPath, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  trace?.({ op: 'discovery-bound', path: displayPath, detail: 'Kilo SQLite snapshot did not stabilize within the retry bound' });
  return undefined;
}

function modelOf(session: OpenCodeSqliteSession): KiloStoredSession['currentModel'] {
  const providerID = session.model?.providerID;
  const modelID = session.model?.id ?? session.model?.modelID;
  if (typeof providerID !== 'string' || typeof modelID !== 'string'
    || !providerID || !modelID
    || [...providerID].length > KILO_MAX_MODEL_SCALARS
    || [...modelID].length > KILO_MAX_MODEL_SCALARS
    || (session.model?.variant !== undefined && (typeof session.model.variant !== 'string'
      || [...session.model.variant].length > KILO_MAX_MODEL_SCALARS))) return undefined;
  return session.model?.variant
    ? { providerID, modelID, variant: session.model.variant }
    : { providerID, modelID };
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && [...value].length <= KILO_MAX_ID_SCALARS && !/[\u0000-\u001f\u007f]/u.test(value);
}

function anchoredSessionDatabase(
  session: KiloStoredSession,
  openedRoot: OpenDataRoot,
): string | undefined {
  if (resolve(dirname(session.databasePath)) !== resolve(session.dataRoot)) return undefined;
  const name = basename(session.databasePath);
  if (!kiloDatabaseNames(openedRoot.descriptorPath).includes(name)) return undefined;
  return join(openedRoot.descriptorPath, name);
}

export async function discoverKiloStore(options: KiloDiscoveryOptions = {}): Promise<KiloStoredSession[]> {
  const dataRoot = kiloDataRoot(options.env ?? process.env, options.homeDir ?? homedir());
  const openedRoot = openDataRoot(dataRoot);
  if (!openedRoot) return [];
  try {
    const paths = kiloDatabaseNames(openedRoot.descriptorPath).map((name) => ({
      internal: join(openedRoot.descriptorPath, name),
      display: join(dataRoot, name),
    }));
    let selectedSnapshotBytes = 0n;
    for (const path of paths) {
      const states = snapshotStates(path.internal);
      if (states.some((state) => state.status === 'invalid')) {
        options.trace?.({
          op: 'path-refused', path: path.display,
          detail: 'Kilo SQLite database or sidecar has an unsafe type, size, or metadata state',
        });
        return [];
      }
      selectedSnapshotBytes += states.reduce((sum, state) => sum
        + (state.status === 'valid' ? state.signature.size : 0n), 0n);
      if (selectedSnapshotBytes > BigInt(KILO_MAX_DISCOVERY_SNAPSHOT_BYTES)) {
        options.trace?.({
          op: 'discovery-bound',
          detail: `Selected Kilo SQLite snapshots exceed the ${KILO_MAX_DISCOVERY_SNAPSHOT_BYTES}-byte discovery budget`,
        });
        return [];
      }
    }
    const byId = new Map<string, KiloStoredSession>();
    const conflictedIds = new Set<string>();
    const copyBudget = { remaining: BigInt(KILO_MAX_DISCOVERY_SNAPSHOT_BYTES) };
    for (const databasePath of paths) {
      throwIfAborted(options.signal);
      options.onWork?.({ kind: 'sqlite-query', source: databasePath.display, bounded: options.updatedAfter !== undefined,
        ...(options.updatedAfter === undefined ? {} : { cutoff: options.updatedAfter }) });
      const result = await withKiloSnapshot(databasePath.internal, databasePath.display, options.signal, options.trace, (database) => {
        const cutoffClause = options.updatedAfter === undefined
          ? 'time_archived is null'
          : 'time_archived is null and coalesce(time_updated, time_created) >= ?';
        const countQuery = database.query(`select count(*) as count from session where ${cutoffClause}`);
        const countRow = options.updatedAfter === undefined ? countQuery.get() : countQuery.get(options.updatedAfter);
        const count = Number((countRow as { count?: number | bigint } | null)?.count ?? 0);
        if (!Number.isSafeInteger(count) || count > KILO_MAX_SESSIONS) {
          options.trace?.({ op: 'discovery-bound', path: databasePath.display, detail: `Kilo database exceeds ${KILO_MAX_SESSIONS} selected sessions` });
          // Said out loud, because this is a CLIFF and not a taper: at
          // KILO_MAX_SESSIONS the roster publishes every session, and at one
          // more it publishes none of them. Measured: 2000 -> 2000 rows,
          // 2001 -> 0 rows. `trace` is an optional fixture hook that nothing
          // supplies in production, so the only symptom an operator had was
          // Kilo Code silently owning no sessions at all.
          //
          // Once per database, not per sweep: discovery runs every few seconds
          // and a store over the bound stays over it, so repeating this would
          // bury the one line that explains the emptiness.
          // Only for a genuine overrun. The other arm is an unreadable count,
          // where "holds more than 2000 unarchived sessions" would be a
          // fabrication about a value this code could not read.
          if (count > KILO_MAX_SESSIONS) {
            warnBoundOnce(
              databasePath.display,
              `Kilo Code database ${databasePath.display} holds more than ${KILO_MAX_SESSIONS} `
                + 'unarchived sessions, so NONE of its sessions are published to the roster. '
                + 'Archive sessions in Kilo Code to bring it back under the bound.',
            );
          }
          return undefined;
        }
        // Back within the bound: re-arm, so a second excursion is reported too.
        // ONLY on an unwindowed count. `count` above is window-scoped, and the
        // broker sweeps this same database on two windows concurrently -- all
        // time for /api/machines, and the caller's window for /api/sessions. A
        // windowed count under the bound says nothing about whether the STORE
        // came back under it, so re-arming on one let the narrow sweep clear
        // the arm the all-time sweep had just set, and the warning went back to
        // once per sweep -- the exact burying the comment above forbids.
        if (options.updatedAfter === undefined) clearKiloBoundWarning(databasePath.display);
        if (!sessionMetadataWithinBounds(database, undefined, options.updatedAfter)) {
          options.trace?.({ op: 'discovery-bound', path: databasePath.display, detail: 'Kilo selected session metadata exceeds its raw decode bound' });
          return undefined;
        }
        const sessions = readOpenCodeSqliteSessions(database, {
          strictStorageTypes: true,
          ...(options.updatedAfter === undefined ? {} : { updatedAfter: options.updatedAfter }),
        });
        const sessionIds = new Set<string>();
        for (const session of sessions) {
          if (sessionIds.has(session.id)) {
            options.trace?.({
              op: 'schema-refused', path: databasePath.display,
              detail: `Kilo session ${session.id} appears more than once in one selected database; refusing the ambiguous identity`,
            });
            return undefined;
          }
          sessionIds.add(session.id);
        }
        const discovered = sessions.flatMap((session): KiloStoredSession[] => {
          if (!boundedIdentity(session.id)
            || (session.parentID !== undefined && !boundedIdentity(session.parentID))
            || !session.directory
            || !isAbsolute(session.directory) || session.directory === '/'
            || [...session.directory].length > KILO_MAX_CWD_SCALARS) return [];
          if (session.parentID && !options.includeUnverifiedChildren) return [];
          const updatedAt = session.time?.updated ?? session.time?.created;
          const currentModel = modelOf(session);
          const rawTitle = session.title || session.slug || session.id;
          const title = [...rawTitle].length <= KILO_MAX_TITLE_SCALARS ? rawTitle : session.id;
          const currentAgent = session.agent && [...session.agent].length <= KILO_MAX_MODEL_SCALARS
            ? session.agent : undefined;
          return [{
            id: session.id,
            nativeId: session.id,
            title,
            cwd: resolve(session.directory),
            ...(currentModel ? { currentModel, model: `${currentModel.providerID}/${currentModel.modelID}` } : {}),
            ...(currentAgent ? { currentAgent } : {}),
            ...(session.time?.created === undefined ? {} : { createdAt: session.time.created }),
            ...(updatedAt === undefined ? {} : { updatedAt }),
            status: 'idle',
            ...(session.parentID ? { origin: 'subagent' as const, parentThreadId: session.parentID } : {}),
            databasePath: databasePath.display,
            dataRoot,
          }];
        });
        const directoryRows = options.collectDirectories
          ? database.query(`select distinct directory from session
              where time_archived is null limit ?`).all(KILO_MAX_SESSIONS + 1) as Array<{ directory?: unknown }>
          : [];
        if (directoryRows.length > KILO_MAX_SESSIONS) {
          options.trace?.({
            op: 'discovery-bound', path: databasePath.display,
            detail: `Kilo active directory inventory exceeds ${KILO_MAX_SESSIONS} entries`,
          });
          return undefined;
        }
        const directories: string[] = [];
        for (const row of directoryRows) {
          if (typeof row.directory !== 'string' || !isAbsolute(row.directory)
            || row.directory === '/' || [...row.directory].length > KILO_MAX_CWD_SCALARS) continue;
          directories.push(resolve(row.directory));
        }
        return { sessions: discovered, directories };
      }, copyBudget);
      if (!result) continue;
      for (const directory of result.directories) options.collectDirectories?.add(directory);
      for (const session of result.sessions) {
        if (conflictedIds.has(session.id)) continue;
        const existing = byId.get(session.id);
        if (existing && existing.databasePath !== session.databasePath) {
          byId.delete(session.id);
          conflictedIds.add(session.id);
          options.trace?.({
            op: 'schema-refused',
            detail: `Kilo session ${session.id} appears in multiple selected databases; refusing the ambiguous identity`,
          });
          continue;
        }
        if (!existing) byId.set(session.id, session);
        if (byId.size > KILO_MAX_SESSIONS) {
          options.trace?.({ op: 'discovery-bound', detail: `Kilo roster exceeds ${KILO_MAX_SESSIONS} sessions; refusing partial discovery` });
          return [];
        }
      }
    }
    return [...byId.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } finally { closeSync(openedRoot.fd); }
}

export async function readKiloHistory(
  session: KiloStoredSession,
  options: Pick<KiloDiscoveryOptions, 'signal' | 'trace'> = {},
): Promise<KiloHistorySnapshot | undefined> {
  const openedRoot = openDataRoot(session.dataRoot);
  if (!openedRoot) return undefined;
  try {
    const databasePath = anchoredSessionDatabase(session, openedRoot);
    if (!databasePath) return undefined;
    return await withKiloSnapshot(databasePath, session.databasePath, options.signal, options.trace, (database, revision, sourceIdentity) => {
    if (!boundedIdentity(session.id)) return undefined;
    const messageCount = Number((database.query('select count(*) as count from message where session_id = ?').get(session.id) as { count?: number | bigint } | null)?.count ?? 0);
    const partCount = Number((database.query('select count(*) as count from part where session_id = ?').get(session.id) as { count?: number | bigint } | null)?.count ?? 0);
    if (!Number.isSafeInteger(messageCount) || !Number.isSafeInteger(partCount)
      || messageCount > KILO_MAX_MESSAGES_PER_SESSION || partCount > KILO_MAX_PARTS_PER_SESSION) {
      options.trace?.({
        op: 'discovery-bound',
        path: session.databasePath,
        detail: `Kilo history exceeds ${KILO_MAX_MESSAGES_PER_SESSION} messages or ${KILO_MAX_PARTS_PER_SESSION} parts`,
      });
      return undefined;
    }
    const messages = readOpenCodeSqliteHistory(database, session.id, {
      productId: 'kilo',
      mapPart: (part, historical) => mapKiloPart(part, historical, (event) => options.trace?.({
        op: 'store-read', path: session.databasePath, detail: event.detail,
      })),
      maxMessageBytes: KILO_MAX_CANONICAL_MESSAGE_BYTES,
      maxHistoryBytes: KILO_MAX_CANONICAL_HISTORY_BYTES,
      maxRawRecordBytes: KILO_MAX_RAW_RECORD_BYTES,
      maxRawHistoryBytes: KILO_MAX_RAW_HISTORY_BYTES,
      maxIdentityBytes: KILO_MAX_IDENTITY_BYTES,
      strictStorageTypes: true,
      validMessageRoles: ['user', 'assistant'],
      validateMessage: validateKiloMessage,
      validatePart: validateKiloPart,
    });
    if (!messages) {
      options.trace?.({ op: 'discovery-bound', path: session.databasePath, detail: 'Kilo raw or canonical history exceeds its decode bound' });
      return undefined;
    }
    return {
      messages,
      encodings: messages.map((message) => JSON.stringify(message)),
      messageIds: readOpenCodeSqliteMessageIds(database, session.id),
      revision,
      sourceIdentity,
    };
    });
  } finally { closeSync(openedRoot.fd); }
}

export async function refreshKiloStoredSession(session: KiloStoredSession): Promise<boolean> {
  const openedRoot = openDataRoot(session.dataRoot);
  if (!openedRoot) return false;
  try {
    const databasePath = anchoredSessionDatabase(session, openedRoot);
    if (!databasePath) return false;
    return (await withKiloSnapshot(databasePath, session.databasePath, undefined, undefined, (database) => {
      if (!sessionMetadataWithinBounds(database, session.id)) return false;
      const current = readOpenCodeSqliteSession(database, session.id, { strictStorageTypes: true });
      if (!current) return false;
      session.status = 'idle';
      session.updatedAt = current.time?.updated ?? current.time?.created;
      const currentModel = modelOf(current);
      if (currentModel) {
        session.currentModel = currentModel;
        session.model = `${currentModel.providerID}/${currentModel.modelID}`;
      } else {
        delete session.currentModel;
        delete session.model;
      }
      if (current.agent && [...current.agent].length <= KILO_MAX_MODEL_SCALARS) session.currentAgent = current.agent;
      else delete session.currentAgent;
      return true;
    })) ?? false;
  } finally { closeSync(openedRoot.fd); }
}
