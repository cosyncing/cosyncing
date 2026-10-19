import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, closeSync, readSync, statSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRegularFileSync, type AgentMessage, type HistorySourceIdentity, type StoredHistorySnapshot } from '@cosyncing/adapter-api';

const activeStores = new Map<string, { store: ClaudeHistoryStore; users: number }>();
function historyRoot(): string { return join(process.env.COSYNCING_HOME || join(homedir(), '.cosyncing'), 'cache', 'claude-history'); }
export function acquireClaudeHistoryStore(source: string): ClaudeHistoryStore {
  const key = `${historyRoot()}\0${source}`;
  const existing = activeStores.get(key);
  if (existing) { existing.users += 1; return existing.store; }
  const store = new ClaudeHistoryStore(source);
  activeStores.set(key, { store, users: 1 });
  return store;
}

/** Prune only disposable, inactive caches. A quota eviction never touches the
 * source transcript and is recovered by rebuilding its index on next open. */
function pruneCaches(root: string, keep: string): void {
  const quota = Number(process.env.COSYNCING_HISTORY_CACHE_BYTES) || 2 * 1024 ** 3;
  const files = readdirSync(root).filter((name) => name.endsWith('.sqlite')).map((name) => {
    const path = join(root, name), stat = statSync(path);
    let bytes = stat.size;
    for (const suffix of ['-wal', '-shm']) { try { bytes += statSync(path + suffix).size; } catch {} }
    try { for (const body of readdirSync(path + '.bodies')) bytes += statSync(join(path + '.bodies', body)).size; } catch {}
    return { path, bytes, touched: stat.mtimeMs };
  }).sort((a, b) => a.touched - b.touched);
  let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const active = new Set([...activeStores.values()].map((entry) => entry.store.path));
  for (const file of files) {
    if (bytes <= quota) break;
    if (file.path === keep || active.has(file.path)) continue;
    for (const suffix of ['', '-wal', '-shm', '.bodies']) rmSync(file.path + suffix, { recursive: true, force: true });
    bytes -= file.bytes;
  }
}

/** Provider-owned, disposable cache. Native transcripts are never modified. */
export class ClaudeHistoryStore {
  readonly db: Database;
  readonly path: string;
  private maps = new Map<string, Map<string, unknown>>();
  lastWork = { sourceBytes: 0, sourceRecords: 0, mappedRecords: 0, pageRows: 0 };
  private flight?: Promise<void>;

  update(work: () => Promise<void>): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = work().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  constructor(readonly source: string, root = historyRoot()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = statSync(source);
    this.path = join(root, `${stat.dev}-${stat.ino}-${basename(source).replace(/[^a-zA-Z0-9._-]/g, '_')}.sqlite`);
    pruneCaches(root, this.path);
    const open = (): Database => {
      const db = new Database(this.path, { create: true });
      try {
        chmodSync(this.path, 0o600);
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;
      PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-512;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(space,key));
      CREATE TABLE IF NOT EXISTS messages (position INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependencies (call TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY(call,offset)) WITHOUT ROWID;`);
        return db;
      } catch (error) { db.close(); throw error; }
    };
    try { this.db = open(); } catch (error) {
      if (!['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes((error as { code?: string }).code ?? '')) throw error;
      // Only our disposable index is replaced; source records and extracted
      // body files are never mistaken for a corrupt database.
      for (const suffix of ['', '-wal', '-shm']) rmSync(this.path + suffix, { force: true });
      this.db = open();
    }
    if (this.get('schema') !== 4) {
      this.db.exec('DELETE FROM meta; DROP TABLE state; CREATE TABLE state (space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(space,key)); DELETE FROM messages; DELETE FROM dependencies;');
      this.set('schema', 4);
    }
  }

  get<T>(key: string): T | undefined {
    const row = this.db.query('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | null;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown): void {
    if (value === undefined) this.db.query('DELETE FROM meta WHERE key=?').run(key);
    else this.db.query('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value));
  }
  map<T>(space: string): Map<string, T> {
    let map = this.maps.get(space);
    if (!map) { map = new StoredMap(this.db, space); this.maps.set(space, map); }
    return map as Map<string, T>;
  }
  setOf(space: string): Set<string> { return new StoredSet(this.map<boolean>(space)); }
  /** A Drive ledger starts from the replay checkpoint but owns its mutations.
   * SQLite's file-backed TEMP table keeps the copy out of the JS heap and
   * automatically discards it when the connection closes, including a crash. */
  forkState(spaces: readonly string[], keys: readonly string[]): { state: ClaudeHistoryState; close(): void } {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS live_state (space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(space,key))');
    const prefix = `${randomUUID()}:`;
    const maps = new Map<string, Map<string, unknown>>();
    for (const space of spaces) {
      this.db.query('INSERT INTO live_state SELECT ?,key,value FROM state WHERE space=? ORDER BY rowid').run(prefix + space, space);
      maps.set(space, new StoredMap(this.db, prefix + space, 'live_state'));
    }
    const values = new Map(keys.map((key) => [key, this.get(key)]));
    let closed = false;
    return {
      state: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        set: (key, value) => { values.set(key, value); },
        map: <T>(space: string) => {
          const map = maps.get(space);
          if (!map) throw new Error(`Unknown live history state: ${space}`);
          return map as Map<string, T>;
        },
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (const space of spaces) this.db.query('DELETE FROM live_state WHERE space=?').run(prefix + space);
        maps.clear();
      },
    };
  }
  resetMapping(): void {
    this.db.exec("DELETE FROM state WHERE space NOT IN ('calls', 'peerNames'); DELETE FROM messages; DELETE FROM dependencies;");
    this.set('mapper', undefined);
    this.set('runtime', undefined);
    this.set('taskFallback', undefined);
    this.set('count', 0);
  }
  append(message: AgentMessage): void {
    const textual = message.type === 'model-output' || message.type === 'thinking' || message.type === 'user-message';
    const body = textual ? message.text : message.type === 'tool-result'
      ? typeof message.result === 'string' ? message.result : JSON.stringify(message.result) : undefined;
    if (typeof body === 'string' && body.length > 128 * 1024) {
      const position = this.get<number>('count') ?? 0;
      const root = `${this.path}.bodies`;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const name = `history-row-${position}.${!textual && typeof (message as { result?: unknown }).result !== 'string' ? 'json' : 'txt'}`;
      const path = join(root, `${this.get<string>('generation')}-${name}`);
      writeFileSync(path, body, { mode: 0o600 });
      let end = 128 * 1024;
      if (body.charCodeAt(end - 1) >= 0xD800 && body.charCodeAt(end - 1) <= 0xDBFF) end -= 1;
      const preview = textual ? { ...message, text: body.slice(0, end), bodyTruncated: true }
        : { ...message, result: body.slice(0, end), truncated: true };
      this.appendRow(preview as AgentMessage);
      this.appendRow({ type: 'file-artifact', path, name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/plain', size: Buffer.byteLength(body),
        ...(message.type === 'user-message' && message.key ? { userMessageKey: message.key } : {}),
      });
      return;
    }
    this.appendRow(message);
  }
  private appendRow(message: AgentMessage): void {
    const position = this.get<number>('count') ?? 0;
    this.db.query('INSERT INTO messages VALUES (?,?)').run(position, JSON.stringify(message));
    this.set('count', position + 1);
  }
  read(start: number, end: number): AgentMessage[] {
    const rows = this.db.query('SELECT json FROM messages WHERE position>=? AND position<? ORDER BY position').all(start, end) as { json: string }[];
    this.lastWork.pageRows += rows.length;
    return rows.map((row) => JSON.parse(row.json));
  }
  snapshot(identity: HistorySourceIdentity, overlays: AgentMessage[] = []): StoredHistorySnapshot {
    const count = this.get<number>('count') ?? 0;
    const generation = this.get<string>('generation')!;
    const version = this.get<string>('version')!;
    const previousVersion = this.get<string>('previousVersion');
    return {
      identity, version, previousVersion,
      unchangedPrefix: this.get<number>('unchangedPrefix') ?? 0,
      stableCount: count,
      count: count + overlays.length,
      reader: {
        retainedBytes: (2048 + 512) * 1024 + overlays.reduce((bytes, message) => bytes + 2 * Buffer.byteLength(JSON.stringify(message)) + 256, 0),
        read: (locations) => {
          const db = new Database(this.path, { readonly: true });
          db.exec('PRAGMA cache_size=-1024');
          try {
            // Appends preserve earlier rows; a rewrite/rebuild invalidates old views.
            const current = db.query("SELECT value FROM meta WHERE key='generation'").get() as { value: string } | null;
            if (!current || JSON.parse(current.value) !== generation) return undefined;
            const messages: AgentMessage[] = [];
            let bytesRead = 0;
            const query = db.query('SELECT json FROM messages WHERE position=?');
            for (const location of locations) {
              if (!Number.isSafeInteger(location) || location < 0 || location >= count + overlays.length) return undefined;
              if (location >= count) { messages.push(overlays[location - count]!); continue; }
              const row = query.get(location) as { json: string } | null;
              if (!row) return undefined;
              bytesRead += Buffer.byteLength(row.json);
              messages.push(JSON.parse(row.json));
            }
            this.lastWork.pageRows += locations.length;
            return { identity, messages, work: { recordsRead: locations.length, bytesRead } };
          } finally { db.close(); }
        },
      },
    };
  }
  newGeneration(): void { this.set('generation', randomUUID()); }
  close(): void {
    for (const [key, entry] of activeStores) {
      if (entry.store !== this) continue;
      if (--entry.users > 0) return;
      activeStores.delete(key); break;
    }
    this.db.close();
  }
}

export type ClaudeHistoryState = Pick<ClaudeHistoryStore, 'get' | 'set' | 'map'>;

/** Map-compatible state whose size does not determine JS heap retention. */
class StoredMap<T> extends Map<string, T> {
  constructor(private readonly db: Database, private readonly space: string, private readonly table: 'state' | 'live_state' = 'state') { super(); }
  override get size(): number { return (this.db.query(`SELECT count(*) AS n FROM ${this.table} WHERE space=?`).get(this.space) as { n: number }).n; }
  override has(key: string): boolean { return !!this.db.query(`SELECT 1 FROM ${this.table} WHERE space=? AND key=?`).get(this.space, key); }
  override get(key: string): T | undefined {
    const row = this.db.query(`SELECT value FROM ${this.table} WHERE space=? AND key=?`).get(this.space, key) as { value: string } | null;
    if (!row) return undefined;
    return this.mutable(key, JSON.parse(row.value));
  }
  private mutable(key: string, value: T): T {
    // Existing mapper ledgers amend values in place. Persist those amendments
    // without retaining an unbounded identity map of decoded objects.
    const wrap = (object: any): any => object && typeof object === 'object' ? new Proxy(object, {
      get: (target, property) => wrap(Reflect.get(target, property)),
      set: (target, property, next) => { Reflect.set(target, property, next); this.set(key, value); return true; },
      deleteProperty: (target, property) => { Reflect.deleteProperty(target, property); this.set(key, value); return true; },
    }) : object;
    return wrap(value);
  }
  override set(key: string, value: T): this { this.db.query(`INSERT INTO ${this.table} VALUES (?,?,?) ON CONFLICT(space,key) DO UPDATE SET value=excluded.value`).run(this.space, key, JSON.stringify(value)); return this; }
  override delete(key: string): boolean { return this.db.query(`DELETE FROM ${this.table} WHERE space=? AND key=?`).run(this.space, key).changes > 0; }
  override clear(): void { this.db.query(`DELETE FROM ${this.table} WHERE space=?`).run(this.space); }
  override *entries(): MapIterator<[string, T]> {
    for (const row of this.db.query(`SELECT key,value FROM ${this.table} WHERE space=? ORDER BY rowid`).iterate(this.space) as Iterable<{ key: string; value: string }>) yield [row.key, this.mutable(row.key, JSON.parse(row.value))];
  }
  override *keys(): MapIterator<string> {
    for (const row of this.db.query(`SELECT key FROM ${this.table} WHERE space=? ORDER BY rowid`).iterate(this.space) as Iterable<{ key: string }>) yield row.key;
  }
  override *values(): MapIterator<T> { for (const [, value] of this.entries()) yield value; }
  override [Symbol.iterator](): MapIterator<[string, T]> { return this.entries(); }
  override forEach(callback: (value: T, key: string, map: Map<string, T>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
}
class StoredSet extends Set<string> {
  constructor(private readonly map: Map<string, boolean>) { super(); }
  override get size(): number { return this.map.size; }
  override has(value: string): boolean { return this.map.has(value); }
  override add(value: string): this { this.map.set(value, true); return this; }
  override delete(value: string): boolean { return this.map.delete(value); }
  override clear(): void { this.map.clear(); }
  override keys(): SetIterator<string> { return this.map.keys(); }
  override values(): SetIterator<string> { return this.map.keys(); }
  override *entries(): SetIterator<[string, string]> { for (const key of this.map.keys()) yield [key, key]; }
  override [Symbol.iterator](): SetIterator<string> { return this.values(); }
  override forEach(callback: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown): void {
    for (const value of this.values()) callback.call(thisArg, value, value, this);
  }
}

/** Only complete records of the captured prefix are exposed. Chunked source
 * reads and explicit yields keep indexing from monopolizing the event loop. */
export async function* historyRecords(path: string, start: number, end: number): AsyncGenerator<{ line: any; offset: number; end: number; bytes: number }> {
  const fd = openRegularFileSync(path);
  let pending: Buffer[] = [], pendingBytes = 0, recordStart = start;
  const chunk = Buffer.alloc(256 * 1024);
  try {
    for (let offset = start; offset < end;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset);
      if (!n) throw new Error('History source changed during indexing');
      let from = 0;
      for (let nl = chunk.indexOf(10, from); nl >= 0 && nl < n; nl = chunk.indexOf(10, from)) {
        const part = chunk.subarray(from, nl);
        if (pendingBytes + part.length > 64 * 1024 * 1024) throw Object.assign(new Error('A native history record exceeds 64 MiB'), { code: 'HISTORY_RECORD_RESOURCE_LIMIT' });
        const raw = pendingBytes ? Buffer.concat([...pending, part], pendingBytes + part.length) : part;
        let line: any = null;
        try { line = JSON.parse(raw.toString('utf8')); } catch { /* native partial/malformed rows have no messages */ }
        const next = offset + nl + 1;
        yield { line, offset: recordStart, end: next, bytes: next - recordStart };
        pending = []; pendingBytes = 0; from = nl + 1; recordStart = next;
      }
      if (from < n) { const rest = Buffer.from(chunk.subarray(from, n)); pending.push(rest); pendingBytes += rest.length; }
      if (pendingBytes > 64 * 1024 * 1024) throw Object.assign(new Error('A native history record exceeds 64 MiB'), { code: 'HISTORY_RECORD_RESOURCE_LIMIT' });
      offset += n;
      await new Promise<void>((done) => setImmediate(done));
    }
  } finally { closeSync(fd); }
}

export function historyGuards(path: string, boundary: number): { head: string; edge: string } {
  const fd = openRegularFileSync(path);
  try {
    const size = Math.min(boundary, 4096);
    const head = Buffer.alloc(size), edge = Buffer.alloc(size);
    readSync(fd, head, 0, size, 0); readSync(fd, edge, 0, size, boundary - size);
    return { head: head.toString('base64'), edge: edge.toString('base64') };
  } finally { closeSync(fd); }
}
