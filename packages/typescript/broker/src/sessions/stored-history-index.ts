import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, StoredHistorySnapshot } from '@cosyncing/adapter-api';
import { IndexedHistoryPageCache, type HistoryIndexVector } from './history-page-cache.ts';
import { isBackwardPageMessage, isCursorDurableMessage, isVolatileTailMessage, stableHistoryPart, VolatileHistoryTail } from './history-delta.ts';

const OPENING = createHash('sha256').update('cosyncing:stored-history:v1').digest('base64url');
const databases = new Map<string, Database>();
const flights = new Map<string, Promise<IndexedHistoryPageCache>>();
type IndexRow = { position: number; location: number; hash: string; pageable: number };
type IndexMeta = { version: string; replayFrom: number; count: number };

function database(): Database {
  const root = join(process.env.COSYNCING_HOME || join(homedir(), '.cosyncing'), 'cache');
  const path = join(root, 'history-index.sqlite');
  const existing = databases.get(path);
  if (existing) return existing;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const open = (): Database => {
    const db = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;
    CREATE TABLE IF NOT EXISTS snapshots (source TEXT PRIMARY KEY, meta TEXT NOT NULL, touched INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS positions (source TEXT NOT NULL, position INTEGER NOT NULL, location INTEGER NOT NULL,
      hash TEXT NOT NULL, pageable INTEGER NOT NULL, projection TEXT, textKey TEXT, textLength INTEGER,
      PRIMARY KEY(source,position)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS position_locations ON positions(source,location);
    CREATE INDEX IF NOT EXISTS position_projections ON positions(source,projection,position);
    CREATE TABLE IF NOT EXISTS derived (source TEXT NOT NULL, key TEXT NOT NULL, location INTEGER NOT NULL,
      PRIMARY KEY(source,key)) WITHOUT ROWID;`);
      return db;
    } catch (error) { db.close(); throw error; }
  };
  let db: Database;
  try { db = open(); } catch (error) {
    if (!['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes((error as { code?: string }).code ?? '')) throw error;
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    db = open();
  }
  databases.set(path, db);
  return db;
}

/** Durable page metadata lives on disk, including the cursor at every boundary.
 * Hash chaining is checkpointable, so an append never re-hashes its prefix.
 * Old opaque cursors reset once when moving from the full-replay index. */
export async function storedHistoryIndex(snapshot: StoredHistorySnapshot): Promise<IndexedHistoryPageCache> {
  const db = database();
  const source = snapshot.identity.sourceId;
  // One writer per database. Readers use separate connections, so an index
  // rebuild publishes atomically without blocking already-issued pages.
  const key = db.filename;
  const prior = flights.get(key);
  const flight = (prior ? prior.catch(() => undefined) : Promise.resolve())
    .then(() => build(db, source, snapshot));
  flights.set(key, flight);
  try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
}

async function build(db: Database, source: string, snapshot: StoredHistorySnapshot): Promise<IndexedHistoryPageCache> {
  db.exec('BEGIN IMMEDIATE');
  try {
    const saved = db.query('SELECT meta FROM snapshots WHERE source=?').get(source) as { meta: string } | null;
    const old: IndexMeta | undefined = saved ? JSON.parse(saved.meta) : undefined;
    const resume = old && old.version === snapshot.version ? old.replayFrom
      : old && old.version === snapshot.previousVersion ? Math.min(old.replayFrom, snapshot.unchangedPrefix) : 0;
    db.query('DELETE FROM positions WHERE source=? AND location>=?').run(source, resume);
    db.query('DELETE FROM derived WHERE source=? AND location>=?').run(source, resume);
    db.query('DELETE FROM snapshots WHERE source=?').run(source);
    const last = db.query('SELECT position,hash FROM positions WHERE source=? ORDER BY position DESC LIMIT 1').get(source) as { position: number; hash: string } | null;
    let count = last?.position ?? 0;
    let hash = last?.hash ?? OPENING;
    const volatile = new VolatileHistoryTail<{ message: AgentMessage; location: number }>();
    const insert = db.query('INSERT INTO positions VALUES (?,?,?,?,?,?,?,?)');
    const derived = (message: AgentMessage, location: number) => {
      const key = `${message.type}\0${'key' in message ? message.key ?? location : location}`;
      db.query('INSERT OR REPLACE INTO derived VALUES (?,?,?)').run(source, key, location);
    };
    const durable = (message: AgentMessage, location: number) => {
      hash = createHash('sha256').update(hash).update('\n').update(stableHistoryPart(message, count)).digest('base64url');
      count += 1;
      const projection = ['task-list-state', 'goal-state', 'metadata-update'].includes(message.type)
        ? `${message.type}\0${'key' in message ? message.key ?? '' : ''}` : null;
      const textKey = (message.type === 'model-output' || message.type === 'thinking') && message.key ? `${message.type}:${message.key}` : null;
      const textLength = textKey && 'text' in message ? message.text?.length ?? 0 : null;
      insert.run(source, count, location, hash, isBackwardPageMessage(message) ? 1 : 0, projection, textKey, textLength);
    };
    for (let start = resume; start < snapshot.count; start += 128) {
      const locations = Array.from({ length: Math.min(128, snapshot.count - start) }, (_, i) => start + i);
      const read = await snapshot.reader.read(locations);
      if (!read || 'refusal' in read || read.messages.length !== locations.length) throw new Error('Stored history changed during indexing');
      read.messages.forEach((message, i) => {
        const location = locations[i]!;
        if (!isCursorDurableMessage(message)) { derived(message, location); return; }
        for (const entry of volatile.push({ message, location }, isVolatileTailMessage(message))) durable(entry.message, entry.location);
      });
      await new Promise<void>((done) => setImmediate(done));
    }
    for (const entry of volatile.tail) derived(entry.message, entry.location);
    const replayFrom = Math.min(snapshot.stableCount, ...volatile.tail.map((entry) => entry.location),
      ...((db.query('SELECT min(location) AS n FROM derived WHERE source=?').get(source) as { n: number | null }).n === null
        ? [] : [(db.query('SELECT min(location) AS n FROM derived WHERE source=?').get(source) as { n: number }).n]));
    db.query('INSERT OR REPLACE INTO snapshots VALUES (?,?,?)').run(source, JSON.stringify({ version: snapshot.version, replayFrom, count }), Date.now());
    db.exec('COMMIT');
    const rows = new DiskRows(db.filename, source, count);
    const projections = new Map<string, { location: number; index: number }>();
    for (const row of db.query(`SELECT projection,location,position FROM positions WHERE source=? AND position IN
      (SELECT max(position) FROM positions WHERE source=? AND projection IS NOT NULL GROUP BY projection)
      ORDER BY position DESC LIMIT 2048`).all(source, source) as { projection: string; location: number; position: number }[]) {
      projections.set(row.projection, { location: row.location, index: row.position - 1 });
    }
    const overlap = (db.query(`SELECT textKey AS key,textLength AS length FROM positions WHERE source=? AND textKey IS NOT NULL ORDER BY position DESC LIMIT 1024`).all(source) as { key: string; length: number }[]).reverse();
    const derivedLocations = (db.query('SELECT location FROM derived WHERE source=? ORDER BY location DESC LIMIT 2048').all(source) as { location: number }[]).map((row) => row.location).reverse();
    return new IndexedHistoryPageCache({
      sourceIdentity: snapshot.identity,
      hashes: rows.vector('hash', true), locations: rows.vector('location'), pageable: rows.vector('pageable'),
      projections, derived: derivedLocations, overlap, reader: snapshot.reader,
      pageDecodedBudget: 2 * 1024 * 1024,
      immutableRows: true,
      // SQLite cache + one metadata block + bounded overlays. Total transcript
      // bytes and row count do not contribute to the RAM admission budget.
      indexBytes: 3 * 1024 * 1024 + snapshot.reader.retainedBytes,
    });
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

class DiskRows {
  private block = -1;
  private rows: IndexRow[] = [];
  constructor(private readonly path: string, private readonly source: string, private readonly count: number) {}
  get(index: number): IndexRow {
    const block = Math.floor(index / 256);
    if (block !== this.block) {
      const db = new Database(this.path, { readonly: true });
      try {
        db.exec('PRAGMA cache_size=-128');
        this.rows = db.query('SELECT position,location,hash,pageable FROM positions WHERE source=? AND position>? AND position<=? ORDER BY position').all(this.source, block * 256, Math.min(this.count, (block + 1) * 256)) as IndexRow[];
      } finally { db.close(); }
      this.block = block;
    }
    const row = this.rows[index - block * 256];
    if (!row) throw new Error('Stored history index is incomplete');
    return row;
  }
  vector<K extends 'hash' | 'location' | 'pageable'>(field: K, opening = false): HistoryIndexVector<IndexRow[K]> {
    const length = this.count + (opening ? 1 : 0);
    const at = (index: number): IndexRow[K] => opening && index === 0 ? OPENING as IndexRow[K] : this.get(index - (opening ? 1 : 0))[field];
    return new Proxy({
      length,
      slice(start = 0, end = length) {
        const from = start < 0 ? Math.max(0, length + start) : Math.min(length, start);
        const to = end < 0 ? Math.max(0, length + end) : Math.min(length, end);
        return Array.from({ length: Math.max(0, to - from) }, (_, i) => at(from + i));
      },
    }, { get: (target, key) => typeof key === 'string' && /^\d+$/.test(key) ? at(Number(key)) : Reflect.get(target, key) }) as HistoryIndexVector<IndexRow[K]>;
  }
}
