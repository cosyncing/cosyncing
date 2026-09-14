import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';

export const KILO_FIXTURE_SESSION_ID = 'ses_kilo_fixture_parent';

export function createKiloDatabase(
  path: string,
  options: { id?: string; title?: string; updatedAt?: number; incomplete?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec('pragma journal_mode = WAL; pragma wal_autocheckpoint = 0;');
  const id = options.id ?? KILO_FIXTURE_SESSION_ID;
  const now = options.updatedAt ?? Date.parse('2026-08-23T10:00:03.000Z');
  database.exec(`
    create table migration (id integer primary key, name text);
    create table session (
      id text primary key, parent_id text, slug text, directory text, title text,
      model text, revert text, agent text, time_created integer, time_updated integer,
      time_archived integer
    );
    create table message (
      id text primary key, session_id text, time_created integer, time_updated integer, data text
    );
    create table part (
      id text primary key, message_id text, session_id text, time_created integer,
      time_updated integer, data text
    );
  `);
  database.query('insert into migration (id, name) values (?, ?)').run(1, 'opencode-lineage');
  database.query(`insert into session
    (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
    values (?, null, ?, ?, ?, ?, null, ?, ?, ?, null)`)
    .run(id, 'kilo-fixture', join(dirname(path), 'workspace'), options.title ?? 'Kilo fixture',
      JSON.stringify({ id: 'qwen-fixture', providerID: 'vllm-fixture', variant: 'default' }),
      'code', now - 3_000, now);
  database.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-user', id, now - 3_000, now - 3_000,
    JSON.stringify({ role: 'user', time: { created: now - 3_000 }, model: { providerID: 'vllm-fixture', modelID: 'qwen-fixture' } }),
  );
  database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-user', 'msg-user', id, now - 3_000, now - 3_000,
    JSON.stringify({ type: 'text', text: 'fixture prompt' }),
  );
  database.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-assistant', id, now - 2_000, now,
    JSON.stringify({
      role: 'assistant', parentID: 'msg-user', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
      time: { created: now - 2_000, ...(options.incomplete ? {} : { completed: now }) },
      ...(options.incomplete ? {} : { finish: 'stop' }),
      cost: 0.25,
      tokens: { input: 7, output: 2, cache: { read: 3, write: 1 }, total: 9 },
    }),
  );
  database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-thinking', 'msg-assistant', id, now - 1_500, now - 1_500,
    JSON.stringify({ type: 'reasoning', text: 'fixture thought', time: { start: now - 1_500, end: now - 1_000 } }),
  );
  database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-answer', 'msg-assistant', id, now - 1_000, now,
    JSON.stringify({ type: 'text', text: 'fixture answer', time: { start: now - 1_000, end: now } }),
  );
  // A user row whose parts carry no text — what an image-only prompt looks like on disk. The
  // durable projection deliberately appends NO user-message for it (`sqlite.ts`, `if (text.trim())`),
  // so it exists in messageIds and never in the mapped messages. That asymmetry is the point: it is
  // what a re-attached process has to recognise as its own history rather than a foreign write.
  database.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-image-only', id, now - 500, now - 500,
    JSON.stringify({ role: 'user', time: { created: now - 500 } }),
  );
  database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-image-only', 'msg-image-only', id, now - 500, now - 500,
    JSON.stringify({ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }),
  );
  database.close();
}

export interface KiloFixtureTree {
  root: string;
  dataRoot: string;
  databasePath: string;
  cleanup(): void;
}

export function buildKiloFixtureTree(options: Parameters<typeof createKiloDatabase>[1] = {}): KiloFixtureTree {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-tree-'));
  const dataRoot = join(root, 'data');
  const databasePath = join(dataRoot, 'kilo.db');
  createKiloDatabase(databasePath, options);
  return { root, dataRoot, databasePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function appendKiloTurn(databasePath: string, sessionId = KILO_FIXTURE_SESSION_ID): Database {
  const database = new Database(databasePath);
  database.exec('pragma wal_autocheckpoint = 0');
  const now = Date.parse('2026-08-23T10:00:10.000Z');
  database.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-user-tail', sessionId, now, now,
    JSON.stringify({ role: 'user', time: { created: now } }),
  );
  database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-user-tail', 'msg-user-tail', sessionId, now, now,
    JSON.stringify({ type: 'text', text: 'tail prompt' }),
  );
  database.query('update session set time_updated = ? where id = ?').run(now, sessionId);
  return database;
}
