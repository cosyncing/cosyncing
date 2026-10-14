/**
 * Kilo Code's SQLite store as the adapter reads it (`<data root>/kilo.db`, WAL mode), written the way Kilo
 * writes it. Used by both sides of a kit: the test seeds and appends to it as a terminal would, and the fake
 * `kilo serve` mirrors its own writes into it before announcing them, so the two can never disagree on the
 * layout. Imports `bun:sqlite` only.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

type Json = Record<string, any>;

export interface KiloRow {
  info: Json;
  parts: Json[];
}

export interface KiloSessionRecord {
  info: Json;
  rows: KiloRow[];
}

const SCHEMA = `
  create table if not exists migration (id integer primary key, name text);
  create table if not exists session (
    id text primary key, parent_id text, slug text, directory text, title text,
    model text, revert text, agent text, time_created integer, time_updated integer,
    time_archived integer
  );
  create table if not exists message (
    id text primary key, session_id text, time_created integer, time_updated integer, data text
  );
  create table if not exists part (
    id text primary key, message_id text, session_id text, time_created integer,
    time_updated integer, data text
  );
`;

export class KiloDb {
  readonly path: string;
  readonly #db: Database;

  /** `journal: 'delete'` makes the rollback-journal database the adapter refuses (only WAL is measured). */
  constructor(path: string, options: { journal?: 'wal' | 'delete' } = {}) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    // Held open and never checkpointed, as a running Kilo holds its database: rows live in the -wal file.
    this.#db.exec(`pragma journal_mode = ${options.journal === 'delete' ? 'delete' : 'wal'}; pragma busy_timeout = 5000; pragma synchronous = off;`);
    if (options.journal !== 'delete') this.#db.exec('pragma wal_autocheckpoint = 0;');
    this.#db.exec(SCHEMA);
    const migrated = this.#db.query('select count(*) as count from migration').get() as { count: number };
    if (migrated.count === 0) this.#db.query('insert into migration (id, name) values (?, ?)').run(1, 'opencode-lineage');
  }

  close(): void {
    this.#db.close();
  }

  /** Insert or replace the session row (not its messages). */
  putSession(info: Json): void {
    const model = info.model
      ? { id: info.model.modelID ?? info.model.id, providerID: info.model.providerID, ...(info.model.variant ? { variant: info.model.variant } : {}) }
      : undefined;
    this.#db.query(`insert or replace into session
      (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`)
      .run(
        String(info.id), info.parentID ?? null,
        String(info.slug ?? String(info.title ?? 'session').toLowerCase().replaceAll(/\W+/g, '-')),
        String(info.directory), String(info.title ?? ''),
        model ? JSON.stringify(model) : null,
        info.revert ? JSON.stringify(info.revert) : null,
        info.agent ?? 'code',
        Number(info.time?.created ?? 0), Number(info.time?.updated ?? info.time?.created ?? 0),
      );
  }

  /** Insert or replace one message and its parts, in order. */
  putRow(sessionId: string, row: KiloRow): void {
    const { id, sessionID: _session, ...data } = row.info;
    const created = Number(row.info.time?.created ?? 0);
    const updated = Number(row.info.time?.completed ?? created);
    this.#db.query('insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)')
      .run(String(id), sessionId, created, updated, JSON.stringify(data));
    row.parts.forEach((part, index) => {
      const { id: partId, messageID: _message, sessionID: _s, ...partData } = part;
      const start = Number(part.time?.start ?? created + index);
      const end = Number(part.time?.end ?? start);
      this.#db.query('insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)')
        .run(String(partId), String(id), sessionId, start, end, JSON.stringify(partData));
    });
  }

  /** A whole session (info and every row), in one transaction. */
  putSessionRecord(record: KiloSessionRecord): void {
    this.#db.transaction(() => {
      for (const row of record.rows) this.putRow(String(record.info.id), row);
      this.putSession(record.info);
    })();
  }

  /** Move the session's update time, as any write to it does. */
  touch(sessionId: string, updated: number): void {
    this.#db.query('update session set time_updated = ? where id = ?').run(updated, sessionId);
  }

  /** Overwrite one part's text in place (a prefix rewrite of the durable history). */
  rewritePartText(partId: string, text: string): void {
    const row = this.#db.query('select data from part where id = ?').get(partId) as { data: string } | null;
    if (!row) throw new Error(`no part ${partId}`);
    this.#db.query('update part set data = ? where id = ?').run(JSON.stringify({ ...JSON.parse(row.data), text }), partId);
  }

  /** Drop a message and its parts (a history rewrite that removes rows). */
  deleteMessage(messageId: string): void {
    this.#db.query('delete from part where message_id = ?').run(messageId);
    this.#db.query('delete from message where id = ?').run(messageId);
  }

  sessionIds(): string[] {
    return (this.#db.query('select id from session').all() as Array<{ id: string }>).map((row) => row.id);
  }

  /** Read one session back as the serve holds it in memory (`null` when it is not there). */
  load(sessionId: string): KiloSessionRecord | null {
    const session = this.#db.query('select * from session where id = ?').get(sessionId) as Json | null;
    if (!session) return null;
    const model = session.model ? JSON.parse(session.model) : undefined;
    const info: Json = {
      id: session.id,
      slug: session.slug,
      directory: session.directory,
      title: session.title,
      time: { created: session.time_created, updated: session.time_updated },
      ...(session.parent_id ? { parentID: session.parent_id } : {}),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(session.revert ? { revert: JSON.parse(session.revert) } : {}),
      ...(model ? { model: { providerID: model.providerID, id: model.id, modelID: model.id } } : {}),
    };
    const messages = this.#db.query('select * from message where session_id = ? order by time_created, id').all(sessionId) as Json[];
    const parts = this.#db.query('select * from part where session_id = ? order by time_created, id').all(sessionId) as Json[];
    const rows: KiloRow[] = messages.map((message) => ({
      info: { id: message.id, ...JSON.parse(message.data) },
      parts: parts.filter((part) => part.message_id === message.id)
        .map((part) => ({ id: part.id, ...JSON.parse(part.data) })),
    }));
    return { info, rows };
  }
}
