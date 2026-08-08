/**
 * Durable shared composer-draft store (DR1).
 *
 * One versioned latest-draft record per (tool, sessionId), persisted under
 * `${setupStateHome()}/drafts/` so the shared draft survives the normal
 * zero-client owner eviction AND a broker restart. The live `ManagedConn`
 * value remains the low-latency fan-out cache; this store is the recovery
 * copy every client mutation and late-joiner replay flows through.
 *
 * Storage shape: ONE FILE PER SESSION, named by a stable digest of
 * `(tool, sessionId)`. An accepted edit rewrites only that session's shard, so
 * a 300 ms composer debounce costs at most {@link MAX_SHARED_DRAFT_TEXT_CHARS}
 * of write+fsync regardless of how many other sessions are retained. A single
 * combined file would rewrite and fsync every retained draft on every
 * keystroke burst; at the documented caps that is tens of megabytes per edit.
 *
 * Versioning contract:
 *  - `revision` is a per-session monotonically increasing integer assigned by
 *    the store (never by client wall clocks). It survives restarts.
 *  - `updateId` is the idempotency token of the last accepted update. A
 *    retried write with the same `updateId` is a no-op (`duplicate`).
 *  - A write whose `baseRevision` is older than the current revision with
 *    different text is REJECTED (`stale-base`): the shared record is left
 *    untouched so the reconnecting client can present a conflict choice
 *    instead of silently overwriting another client's newer shared draft.
 *
 * Durability contract: a mutation is accepted ONLY after its shard is durably
 * written. If persistence fails the in-memory record is left untouched and the
 * write returns `unavailable`, so the broker never broadcasts — and no client
 * ever marks its own row clean against — a shared copy that a restart would
 * lose. The writer keeps its dirty local row and retries.
 *
 * Retention (bounded, opportunistic — pruned on load and on write, never on a
 * timer):
 *  - non-empty records expire after {@link SHARED_DRAFT_TTL_MS};
 *  - empty-text clear tombstones expire after
 *    {@link SHARED_DRAFT_CLEAR_RETENTION_MS}, which matches the device-local
 *    draft retention: a device that was offline for anything less than the
 *    lifetime of its own local row can still learn that the shared draft was
 *    cleared, instead of resurrecting a stale clean copy;
 *  - at most {@link MAX_SHARED_DRAFT_SESSIONS} NON-EMPTY records, evicting the
 *    least-recently updated first. Clear tombstones do not compete for those
 *    slots: a tombstone is the only durable proof an explicit clear happened,
 *    and evicting one under ordinary cap pressure while an offline device
 *    still holds its pre-clear local row would resurrect a draft the user
 *    already sent or discarded. They are bounded instead by their TTL plus
 *    their own generous {@link MAX_SHARED_DRAFT_CLEAR_TOMBSTONES} backstop.
 */
import { readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setupStateHome } from './setup-state.ts';
import { atomicWriteJsonOwnerOnly, ensureOwnerOnlyDirectory } from './secure-files.ts';

/** Abandoned non-empty shared drafts expire after 30 days. */
export const SHARED_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Empty clear tombstones carry only the clear's revision, but a device that
 * has been offline still needs to learn it: without the tombstone a clean
 * local row from before the clear looks newer than "no record" and the stale
 * draft reappears. The retention therefore matches the 30-day device-local
 * draft retention rather than expiring first.
 */
export const SHARED_DRAFT_CLEAR_RETENTION_MS = SHARED_DRAFT_TTL_MS;
/** Hard cap on retained NON-EMPTY session drafts; LRU by update time. Clear
 *  tombstones have their own far larger cap — see the retention notes above. */
export const MAX_SHARED_DRAFT_SESSIONS = 200;
/**
 * Hard cap on retained clear tombstones, LRU by update time.
 *
 * Deliberately far above the non-empty cap: a tombstone is ~140 bytes and the
 * only durable proof of an explicit clear, so it must never compete with
 * full-size draft records for slots. This bound exists purely as a pathology
 * backstop — reaching it takes over two thousand distinct sessions cleared
 * within one 30-day TTL window. Past it, evicting the oldest tombstone
 * accepts a bounded resurrection risk (a device offline across that clear can
 * re-adopt its stale pre-clear row) in exchange for a store whose record and
 * shard-file count cannot grow without limit.
 */
export const MAX_SHARED_DRAFT_CLEAR_TOMBSTONES = 2000;
/**
 * Revisions handed out per persisted clock write.
 *
 * The clock is the store's ONLY unbounded-in-value state, and it must never go
 * backwards, so every revision it hands out has to be covered by a durable
 * reservation taken BEFORE use. Reserving in blocks keeps that to one small
 * write per block instead of one per keystroke; a restart discards the unused
 * tail of the block, which is exactly the safe direction — gaps are harmless,
 * reuse is not.
 */
export const REVISION_RESERVATION_BLOCK = 1024;
/** File name of the durable revision clock inside the store directory. */
export const REVISION_CLOCK_FILE = 'revision-clock.json';
/** One draft never stores more than this many characters (composer text is
 *  prompts, not transcripts). */
export const MAX_SHARED_DRAFT_TEXT_CHARS = 256 * 1024;

export interface SharedDraftRecord {
  /** Current shared text ('' is a clear tombstone). */
  text: string;
  /** Broker-assigned per-session revision, starting at 1. */
  revision: number;
  /** Epoch ms of the last accepted update. Diagnostic only — never used for
   *  conflict ordering (that is what {@link SharedDraftRecord.revision} is for). */
  updatedAt: number;
  /** Idempotency token of the last accepted update, when the writer sent one. */
  lastUpdateId?: string;
}

export type SharedDraftWrite =
  | { status: 'applied'; record: SharedDraftRecord }
  /** Same updateId as the last accepted update: idempotent retry, no mutation. */
  | { status: 'duplicate'; record: SharedDraftRecord }
  /** baseRevision behind the current revision with different text: NOT applied. */
  | { status: 'stale-base'; record: SharedDraftRecord }
  /** The shard could not be durably written: NOT applied, NOT broadcast, and
   *  never acknowledged to the writer. `record` is the untouched current
   *  record, absent when the session had none. */
  | { status: 'unavailable'; record?: SharedDraftRecord };

interface DraftShardFile {
  version: 1;
  tool: string;
  sessionId: string;
  text: string;
  revision: number;
  updatedAt: number;
  lastUpdateId?: string;
}

export interface SharedDraftStoreOptions {
  /** Store directory (one shard file per session). */
  directory?: string;
  now?: () => number;
  onPersistenceError?: (error: unknown) => void;
}

const storeKey = (tool: string, sessionId: string): string => `${tool}\0${sessionId}`;

/** Stable, filesystem-safe shard name. The shard body carries the real
 *  `(tool, sessionId)`, so a name is only a handle — never parsed back. */
const shardName = (tool: string, sessionId: string): string =>
  `${createHash('sha256').update(storeKey(tool, sessionId)).digest('hex').slice(0, 32)}.json`;

function reportPersistenceError(callback: ((error: unknown) => void) | undefined, error: unknown): void {
  try { callback?.(error); } catch { /* observer-only */ }
}

export class SharedDraftStore {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly onPersistenceError?: (error: unknown) => void;
  private readonly records = new Map<string, SharedDraftRecord>();
  /** key → shard path. Populated on load and on the first accepted write. */
  private readonly shards = new Map<string, string>();
  /** Next revision to hand out. Global, so it satisfies per-session
   *  monotonicity without depending on any session's retained record. */
  private nextRevision = 1;
  /** Highest revision covered by a durable reservation. */
  private reservedThrough = 0;
  /** Set when the clock could not be established; every write then fails
   *  closed rather than restarting a revision sequence clients already hold. */
  private clockUnavailable = false;

  constructor(options: SharedDraftStoreOptions = {}) {
    this.directory = options.directory ?? join(setupStateHome(), 'drafts');
    this.now = options.now ?? Date.now;
    this.onPersistenceError = options.onPersistenceError;
    this.load();
  }

  /** Current record for one session, if any (including clear tombstones). */
  get(tool: string, sessionId: string): SharedDraftRecord | undefined {
    const record = this.records.get(storeKey(tool, sessionId));
    return record ? { ...record } : undefined;
  }

  /** Current shared revision (0 when the session has no draft record). */
  currentRevision(tool: string, sessionId: string): number {
    return this.records.get(storeKey(tool, sessionId))?.revision ?? 0;
  }

  /** Number of retained records: at most {@link MAX_SHARED_DRAFT_SESSIONS}
   *  non-empty drafts plus {@link MAX_SHARED_DRAFT_CLEAR_TOMBSTONES} clear
   *  tombstones. */
  size(): number {
    return this.records.size;
  }

  /**
   * Apply one client draft mutation. See the module docstring for the
   * applied/duplicate/stale-base/unavailable contract. Legacy writes (no
   * `baseRevision`) keep last-writer-wins behavior; writes over-long text are
   * rejected so one session can never pin unbounded durable state.
   */
  write(
    tool: string,
    sessionId: string,
    text: string,
    options: { updateId?: string; baseRevision?: number } = {},
  ): SharedDraftWrite {
    const normalized = String(text ?? '');
    if (normalized.length > MAX_SHARED_DRAFT_TEXT_CHARS) {
      throw new Error(`draft text exceeds ${MAX_SHARED_DRAFT_TEXT_CHARS} characters`);
    }
    const key = storeKey(tool, sessionId);
    const existing = this.records.get(key);
    if (existing && options.updateId && options.updateId === existing.lastUpdateId) {
      return { status: 'duplicate', record: { ...existing } };
    }
    if (
      existing &&
      options.baseRevision !== undefined &&
      options.baseRevision < existing.revision &&
      normalized !== existing.text
    ) {
      return { status: 'stale-base', record: { ...existing } };
    }
    // Allocated BEFORE the shard write, so a failed write consumes the revision
    // rather than leaving it to be reused by the next attempt. Consuming it is
    // the safe direction: a reused revision would look stale to every client
    // that already saw the first one.
    const revision = this.allocateRevision();
    if (revision === undefined) {
      return existing ? { status: 'unavailable', record: { ...existing } } : { status: 'unavailable' };
    }
    const record: SharedDraftRecord = {
      text: normalized,
      revision,
      updatedAt: this.now(),
      ...(options.updateId ? { lastUpdateId: options.updateId } : {}),
    };
    // Durability gate: persist BEFORE the record becomes visible. A caller that
    // sees `applied` may broadcast it and let clients mark their rows clean, so
    // acceptance must already be recoverable across a restart.
    try {
      this.persist(key, tool, sessionId, record);
    } catch (error) {
      reportPersistenceError(this.onPersistenceError, error);
      return existing ? { status: 'unavailable', record: { ...existing } } : { status: 'unavailable' };
    }
    this.records.set(key, record);
    this.prune();
    return { status: 'applied', record: { ...record } };
  }

  /** Remove one session's record (session end / profile-owned teardown).
   *  A shard that cannot be deleted keeps its record, so the in-memory view
   *  never claims a removal a restart would undo. */
  remove(tool: string, sessionId: string): boolean {
    const key = storeKey(tool, sessionId);
    if (!this.records.has(key)) return false;
    try {
      this.deleteShard(key);
    } catch (error) {
      reportPersistenceError(this.onPersistenceError, error);
      return false;
    }
    this.records.delete(key);
    return true;
  }

  /** Bounded opportunistic retention: TTL first, then the two LRU count caps.
   *  Iterates only the retained in-memory map, whose size the caps bound to
   *  {@link MAX_SHARED_DRAFT_SESSIONS} + {@link MAX_SHARED_DRAFT_CLEAR_TOMBSTONES}
   *  entries after pruning.
   *  A shard that resists deletion is dropped from memory anyway and re-pruned
   *  on the next load — retention must never block an accepted write. */
  private prune(): void {
    const now = this.now();
    const evict = (key: string): void => {
      this.records.delete(key);
      try {
        this.deleteShard(key);
      } catch (error) {
        reportPersistenceError(this.onPersistenceError, error);
      }
    };
    for (const [key, record] of this.records) {
      const ttl = record.text ? SHARED_DRAFT_TTL_MS : SHARED_DRAFT_CLEAR_RETENTION_MS;
      if (now - record.updatedAt > ttl) evict(key);
    }
    // Non-empty records and clear tombstones have SEPARATE count caps. A
    // tombstone competing with full-size drafts for the same 200 slots could
    // be evicted long before its TTL, and a device that was offline across
    // the clear would then resurrect its stale pre-clear draft — the exact
    // loss the tombstone exists to prevent. Its own cap is a pathology
    // backstop only; see {@link MAX_SHARED_DRAFT_CLEAR_TOMBSTONES}.
    const nonEmpty: Array<[string, SharedDraftRecord]> = [];
    const tombstones: Array<[string, SharedDraftRecord]> = [];
    for (const entry of this.records) {
      (entry[1].text === '' ? tombstones : nonEmpty).push(entry);
    }
    const evictOldestBeyond = (entries: Array<[string, SharedDraftRecord]>, cap: number): void => {
      if (entries.length <= cap) return;
      entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [key] of entries.slice(0, entries.length - cap)) evict(key);
    };
    evictOldestBeyond(nonEmpty, MAX_SHARED_DRAFT_SESSIONS);
    evictOldestBeyond(tombstones, MAX_SHARED_DRAFT_CLEAR_TOMBSTONES);
  }

  /**
   * Hands out the next global revision, reserving a block first when needed.
   *
   * Returns undefined when the reservation cannot be made durable. That is a
   * hard stop, not a degrade: handing out an unreserved revision would let a
   * restart reuse it, and a reused revision is indistinguishable from a stale
   * one to every client — they would ignore real updates forever.
   */
  private allocateRevision(): number | undefined {
    if (this.clockUnavailable) return undefined;
    if (this.nextRevision > this.reservedThrough) {
      const reserveThrough = this.nextRevision + REVISION_RESERVATION_BLOCK - 1;
      try {
        atomicWriteJsonOwnerOnly(join(this.directory, REVISION_CLOCK_FILE), {
          version: 1,
          reservedThrough: reserveThrough,
        });
      } catch (error) {
        reportPersistenceError(this.onPersistenceError, error);
        return undefined;
      }
      this.reservedThrough = reserveThrough;
    }
    return this.nextRevision++;
  }

  private shardPath(key: string, tool: string, sessionId: string): string {
    const known = this.shards.get(key);
    if (known) return known;
    const path = join(this.directory, shardName(tool, sessionId));
    this.shards.set(key, path);
    return path;
  }

  private persist(key: string, tool: string, sessionId: string, record: SharedDraftRecord): void {
    const body: DraftShardFile = {
      version: 1,
      tool,
      sessionId,
      text: record.text,
      revision: record.revision,
      updatedAt: record.updatedAt,
      ...(record.lastUpdateId ? { lastUpdateId: record.lastUpdateId } : {}),
    };
    atomicWriteJsonOwnerOnly(this.shardPath(key, tool, sessionId), body);
  }

  private deleteShard(key: string): void {
    const path = this.shards.get(key);
    if (!path) return;
    rmSync(path, { force: true });
    this.shards.delete(key);
  }

  private load(): void {
    let entries: string[];
    try {
      ensureOwnerOnlyDirectory(this.directory);
      entries = readdirSync(this.directory);
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') return;
      reportPersistenceError(this.onPersistenceError, error);
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.json') || name === REVISION_CLOCK_FILE) continue;
      const path = join(this.directory, name);
      let row: Partial<DraftShardFile>;
      try {
        row = JSON.parse(readFileSync(path, 'utf8')) as Partial<DraftShardFile>;
        if (row?.version !== 1) throw new Error('unsupported shared draft shard schema');
      } catch (error) {
        // Preserve malformed state for diagnosis instead of silently
        // overwriting it with the next accepted draft (schedule-store
        // precedent). Valid sibling shards still load.
        try {
          renameSync(path, `${path}.corrupt-${this.now()}-${randomUUID()}`);
        } catch { /* retain in place if the backup rename fails */ }
        reportPersistenceError(this.onPersistenceError, error);
        continue;
      }
      if (
        typeof row.tool !== 'string' ||
        typeof row.sessionId !== 'string' ||
        typeof row.text !== 'string' ||
        !Number.isSafeInteger(row.revision) ||
        (row.revision as number) < 1 ||
        !Number.isFinite(row.updatedAt)
      ) {
        continue; // skip malformed shards; valid siblings still load
      }
      const key = storeKey(row.tool, row.sessionId);
      this.records.set(key, {
        text: row.text,
        revision: row.revision as number,
        updatedAt: row.updatedAt as number,
        ...(typeof row.lastUpdateId === 'string' ? { lastUpdateId: row.lastUpdateId } : {}),
      });
      this.shards.set(key, path);
    }
    this.loadRevisionClock(entries);
    this.prune();
  }

  /**
   * Establishes the global revision clock from its durable reservation.
   *
   * A clock is written eagerly the first time a pristine directory is opened, so
   * from then on its absence is proof of LOSS, never of newness. That
   * distinction has to survive quarantine: a corrupt shard is renamed to
   * `.json.corrupt-*`, which would leave a directory holding no `.json` file at
   * all, and treating that as pristine would restart the sequence at 1 — handing
   * back revisions clients already hold, which they then ignore as stale
   * forever. Pristine therefore means EMPTY, not "no shards".
   *
   * Anything else fails closed: writes return `unavailable`, so every device
   * keeps its draft dirty and retries rather than converging on a number that
   * means nothing. Recovery is deliberate — remove the store directory.
   */
  private loadRevisionClock(entries: string[]): void {
    const path = join(this.directory, REVISION_CLOCK_FILE);
    const highestRetained = [...this.records.values()].reduce(
      (highest, record) => Math.max(highest, record.revision),
      0,
    );
    let reserved: unknown;
    try {
      reserved = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT' && entries.length === 0) {
        // Genuinely pristine: claim the first block now, so a later absence can
        // only mean the clock was lost.
        try {
          atomicWriteJsonOwnerOnly(path, { version: 1, reservedThrough: REVISION_RESERVATION_BLOCK });
          this.reservedThrough = REVISION_RESERVATION_BLOCK;
          this.nextRevision = 1;
        } catch (writeError) {
          this.clockUnavailable = true;
          reportPersistenceError(this.onPersistenceError, writeError);
        }
        return;
      }
      this.clockUnavailable = true;
      reportPersistenceError(
        this.onPersistenceError,
        new Error(
          `shared draft revision clock is missing from ${this.directory}; refusing to restart the ` +
            'revision sequence (remove the directory to reinitialize)',
        ),
      );
      return;
    }
    const value = (reserved as { reservedThrough?: unknown })?.reservedThrough;
    if ((reserved as { version?: unknown })?.version !== 1 || !Number.isSafeInteger(value) || (value as number) < 0) {
      this.clockUnavailable = true;
      reportPersistenceError(this.onPersistenceError, new Error('shared draft revision clock is malformed'));
      return;
    }
    // Discard the unused tail of the previous block, and never fall below a
    // revision a retained shard already proves was handed out.
    this.reservedThrough = Math.max(value as number, highestRetained);
    this.nextRevision = this.reservedThrough + 1;
  }
}
