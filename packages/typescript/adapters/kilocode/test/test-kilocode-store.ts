#!/usr/bin/env bun
export {};
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  discoverKiloStore,
  kiloDataRoot,
  kiloDatabasePaths,
  KILO_MAX_SESSIONS,
  readKiloHistory,
  resetKiloBoundWarnings,
} from '../src/store.ts';
import { buildKiloFixtureTree, createKiloDatabase, KILO_FIXTURE_SESSION_ID } from './fixtures/database.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const recorded = JSON.parse(readFileSync(new URL('./fixtures/kilo-7.4.23-redacted.json', import.meta.url), 'utf8'));
check('the redacted fixture pins the measured Kilo/OpenCode SQLite lineage',
  recorded.nativeEvidenceVersion === '7.4.23'
    && recorded.tables.join(',') === 'migration,session,message,part'
    && recorded.partTypes.includes('step-finish'));

const tree = buildKiloFixtureTree();
try {
  // The snapshot is a safety boundary, but its copy must not become an event-
  // loop boundary. The installed 64 MiB-class store held /api/health for more
  // than two seconds while a synchronous 64 KiB copy loop ran. A sparse
  // extension makes the copy large enough to prove that discovery yields at
  // least once without adding a large fixture to the repository.
  const responsiveTree = buildKiloFixtureTree();
  try {
    truncateSync(
      responsiveTree.databasePath,
      Math.max(statSync(responsiveTree.databasePath).size, 16 * 1024 * 1024),
    );
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 1);
    try {
      await discoverKiloStore({ env: { KILO_DATA_DIR: responsiveTree.dataRoot } });
    } finally {
      clearInterval(heartbeat);
    }
    check(
      'large Kilo snapshot copies yield to broker health and live sockets',
      heartbeatTicks > 0,
      `${heartbeatTicks} heartbeat tick(s)`,
    );
  } finally {
    rmSync(responsiveTree.root, { recursive: true, force: true });
  }

  check('KILO_DATA_DIR and XDG_DATA_HOME select the measured data root',
    kiloDataRoot({ KILO_DATA_DIR: tree.dataRoot }, '/unused') === tree.dataRoot
      && kiloDataRoot({ XDG_DATA_HOME: tree.root }, '/unused') === join(tree.root, 'kilo'));

  createKiloDatabase(join(tree.dataRoot, 'opencode.db'), { id: 'ses_legacy_wrong', title: 'legacy' });
  check('a kilo-named database suppresses legacy opencode-named files',
    kiloDatabasePaths(tree.dataRoot).map((path) => path.split('/').at(-1)).join(',') === 'kilo.db');
  const sessions = await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } });
  const assistantBaseline = JSON.stringify({
    role: 'assistant', parentID: 'msg-user', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
    time: {
      created: Date.parse('2026-08-23T10:00:01.000Z'),
      completed: Date.parse('2026-08-23T10:00:03.000Z'),
    },
    finish: 'stop', cost: 0.25,
    tokens: { input: 7, output: 2, cache: { read: 3, write: 1 }, total: 9 },
  });
  check('discovery reads the measured schema, model, and display-only agent',
    sessions.length === 1
      && sessions[0]?.id === KILO_FIXTURE_SESSION_ID
      && sessions[0].model === 'vllm-fixture/qwen-fixture'
      && sessions[0].currentAgent === 'code',
    JSON.stringify(sessions));

  const history = await readKiloHistory(sessions[0]!);
  check('SQLite history reuses the OpenCode-lineage mapper and cache-exclusive tokens',
    !!history
      && history.messages.some((message) => message.type === 'user-message' && message.text === 'fixture prompt')
      && history.messages.some((message) => message.type === 'thinking' && message.text === 'fixture thought')
      && history.messages.some((message) => message.type === 'token-count'
        && message.input === 7 && message.cacheRead === 3 && message.cost === 0.25),
    JSON.stringify(history?.messages));

  const database = new Database(tree.databasePath);
  database.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: '  whitespace-sensitive prompt  ' }), 'prt-user',
  );
  database.close();
  const whitespaceHistory = await readKiloHistory(sessions[0]!);
  check('stored user whitespace is tested for emptiness but emitted unchanged',
    whitespaceHistory?.messages.some((message) => message.type === 'user-message'
      && message.text === '  whitespace-sensitive prompt  ') === true);

  const spoofDatabase = new Database(tree.databasePath);
  spoofDatabase.query('update part set data = ? where id = ?').run(
    JSON.stringify({ id: 'spoofed-part-id', type: 'text', text: 'durable identity wins' }), 'prt-answer',
  );
  spoofDatabase.close();
  const spoofHistory = await readKiloHistory(sessions[0]!);
  check('JSON payload ids cannot override authoritative SQLite row identity',
    spoofHistory?.messages.some((message) => message.type === 'model-output'
      && message.key === 'prt-answer' && message.text === 'durable identity wins') === true
      && !spoofHistory?.messages.some((message) => 'key' in message && message.key === 'spoofed-part-id'));

  const unknownDatabase = new Database(tree.databasePath);
  unknownDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-unknown', 'msg-user', KILO_FIXTURE_SESSION_ID,
    Date.parse('2026-08-23T10:00:00.500Z'), Date.parse('2026-08-23T10:00:00.500Z'),
    JSON.stringify({ type: 'future-kilo-part', secret: 'not emitted' }),
  );
  unknownDatabase.close();
  const unknownTrace: string[] = [];
  const unknownHistory = await readKiloHistory(sessions[0]!, {
    trace: (event) => unknownTrace.push(event.detail),
  });
  check('production history routes unknown user-row parts through the Kilo neutral fallback and trace',
    unknownHistory?.messages.some((message) => message.type === 'event'
      && message.name === 'context.injection') === true
      && unknownTrace.some((detail) => detail.includes('future-kilo-part')),
    JSON.stringify({ messages: unknownHistory?.messages, unknownTrace }));

  const oversizedDatabase = new Database(tree.databasePath);
  oversizedDatabase.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }), 'prt-unknown',
  );
  oversizedDatabase.close();
  const oversizedTrace: string[] = [];
  check('raw part data is refused before JSON decoding or canonical emission',
    await readKiloHistory(sessions[0]!, { trace: (event) => oversizedTrace.push(event.op) }) === undefined
      && oversizedTrace.includes('discovery-bound'),
    oversizedTrace.join(','));
  const cleanupDatabase = new Database(tree.databasePath);
  cleanupDatabase.query('delete from part where id = ?').run('prt-unknown');
  cleanupDatabase.close();

  const blobDatabase = new Database(tree.databasePath);
  blobDatabase.query('update part set data = ? where id = ?').run(Buffer.alloc(64 * 1024), 'prt-answer');
  blobDatabase.close();
  check('SQLite BLOB JSON cells fail closed before decode or unknown-part expansion',
    await readKiloHistory(sessions[0]!) === undefined);
  const blobCleanup = new Database(tree.databasePath);
  blobCleanup.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'fixture answer' }), 'prt-answer',
  );
  blobCleanup.close();

  const blobIdentityDatabase = new Database(tree.databasePath);
  blobIdentityDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    Buffer.from('prt-blob'), 'msg-assistant', KILO_FIXTURE_SESSION_ID,
    Date.parse('2026-08-23T10:00:02.700Z'), Date.parse('2026-08-23T10:00:02.700Z'),
    JSON.stringify({ type: 'text', text: 'must refuse' }),
  );
  blobIdentityDatabase.close();
  check('non-TEXT durable identities fail closed before canonical emission',
    await readKiloHistory(sessions[0]!) === undefined);
  const blobIdentityCleanup = new Database(tree.databasePath);
  blobIdentityCleanup.query("delete from part where typeof(id) = 'blob'").run();
  blobIdentityCleanup.close();

  const roleDatabase = new Database(tree.databasePath);
  roleDatabase.query('update message set data = ? where id = ?').run(
    JSON.stringify({ role: 'system' }), 'msg-assistant',
  );
  roleDatabase.close();
  check('unmeasured message roles fail closed instead of becoming model output',
    await readKiloHistory(sessions[0]!) === undefined);
  const roleCleanup = new Database(tree.databasePath);
  roleCleanup.query('update message set data = ? where id = ?').run(assistantBaseline, 'msg-assistant');
  roleCleanup.close();

  const interleavedDatabase = new Database(tree.databasePath);
  const interleavedAt = Date.parse('2026-08-23T10:00:00.500Z');
  interleavedDatabase.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-user-interleaved', KILO_FIXTURE_SESSION_ID, interleavedAt, interleavedAt,
    JSON.stringify({ role: 'user', time: { created: interleavedAt } }),
  );
  interleavedDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-user-interleaved', 'msg-user-interleaved', KILO_FIXTURE_SESSION_ID,
    interleavedAt, interleavedAt, JSON.stringify({ type: 'text', text: 'later user' }),
  );
  const assistantWithoutStart = JSON.parse(assistantBaseline);
  delete assistantWithoutStart.time.created;
  interleavedDatabase.query('update message set data = ? where id = ?').run(
    JSON.stringify(assistantWithoutStart), 'msg-assistant',
  );
  interleavedDatabase.close();
  const interleavedHistory = await readKiloHistory(sessions[0]!);
  const interleavedSummary = interleavedHistory?.messages.find((message) => message.type === 'run-summary');
  check('assistant timing falls back to its exact parent user, not the latest unrelated user',
    interleavedSummary?.type === 'run-summary'
      && interleavedSummary.userMessageKey === 'msg-user'
      && interleavedSummary.startedAt === Date.parse('2026-08-23T10:00:00.000Z'),
    JSON.stringify(interleavedSummary));
  const interleavedCleanup = new Database(tree.databasePath);
  interleavedCleanup.query('delete from part where id = ?').run('prt-user-interleaved');
  interleavedCleanup.query('delete from message where id = ?').run('msg-user-interleaved');
  interleavedCleanup.query('update message set data = ? where id = ?').run(assistantBaseline, 'msg-assistant');
  interleavedCleanup.close();

  const tokenDatabase = new Database(tree.databasePath);
  tokenDatabase.query('update message set data = ? where id = ?').run(JSON.stringify({
    ...JSON.parse(assistantBaseline), tokens: { input: '7', output: 2 },
  }), 'msg-assistant');
  tokenDatabase.close();
  check('non-numeric decoded token fields fail closed before canonical summaries',
    await readKiloHistory(sessions[0]!) === undefined);
  const tokenCleanup = new Database(tree.databasePath);
  tokenCleanup.query('update message set data = ? where id = ?').run(assistantBaseline, 'msg-assistant');
  tokenCleanup.close();

  const nestedToolDatabase = new Database(tree.databasePath);
  nestedToolDatabase.query('update part set data = ? where id = ?').run(JSON.stringify({
    type: 'tool', tool: 'bash',
    state: { status: 'completed', input: { command: { bad: true } }, output: 'ok', metadata: {} },
  }), 'prt-answer');
  nestedToolDatabase.close();
  check('malformed nested tool fields fail closed before shared mapping',
    await readKiloHistory(sessions[0]!) === undefined);
  const nestedToolCleanup = new Database(tree.databasePath);
  nestedToolCleanup.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'fixture answer' }), 'prt-answer',
  );
  nestedToolCleanup.close();

  const linkageDatabase = new Database(tree.databasePath);
  linkageDatabase.query('update message set data = ? where id = ?').run(JSON.stringify({
    ...JSON.parse(assistantBaseline), parentID: 'missing-user',
  }), 'msg-assistant');
  linkageDatabase.close();
  check('assistant parent identity must name a preceding durable user row',
    await readKiloHistory(sessions[0]!) === undefined);
  const linkageCleanup = new Database(tree.databasePath);
  linkageCleanup.query('update message set data = ? where id = ?').run(assistantBaseline, 'msg-assistant');
  linkageCleanup.close();

  const emptyAssistantDatabase = new Database(tree.databasePath);
  emptyAssistantDatabase.query('update part set data = ? where id in (?, ?)').run(
    JSON.stringify({ type: 'reasoning', text: '' }), 'prt-thinking', 'prt-answer',
  );
  emptyAssistantDatabase.close();
  const emptyAssistantHistory = await readKiloHistory(sessions[0]!);
  const emptySummary = emptyAssistantHistory?.messages.find((message) => message.type === 'run-summary');
  check('an empty assistant turn never points its summary at a non-emitted content row',
    emptySummary?.type === 'run-summary' && emptySummary.assistantMessageKey === undefined);
  const emptyAssistantCleanup = new Database(tree.databasePath);
  emptyAssistantCleanup.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'reasoning', text: 'fixture thought' }), 'prt-thinking',
  );
  emptyAssistantCleanup.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'fixture answer' }), 'prt-answer',
  );
  emptyAssistantCleanup.close();

  const timestampDatabase = new Database(tree.databasePath);
  timestampDatabase.query('update session set time_created = ? where id = ?').run(
    Buffer.from('bad-time'), KILO_FIXTURE_SESSION_ID,
  );
  timestampDatabase.close();
  check('non-numeric SQLite timestamp storage fails closed before roster publication',
    (await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } })).length === 0);
  const timestampCleanup = new Database(tree.databasePath);
  timestampCleanup.query('update session set time_created = ? where id = ?').run(
    Date.parse('2026-08-23T10:00:00.000Z'), KILO_FIXTURE_SESSION_ID,
  );
  timestampCleanup.close();

  writeFileSync(`${tree.databasePath}-journal`, 'synthetic hot rollback journal');
  const journalTrace: string[] = [];
  check('a rollback-journal sidecar is refused because only WAL mode is measured',
    await readKiloHistory(sessions[0]!, { trace: (event) => journalTrace.push(event.detail) }) === undefined
      && journalTrace.some((detail) => detail.includes('rollback-journal')),
    journalTrace.join(','));
  rmSync(`${tree.databasePath}-journal`);

  const malformedIdentityDatabase = new Database(tree.databasePath);
  const oversizedPartId = 'p'.repeat(2_000);
  malformedIdentityDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    oversizedPartId, 'msg-assistant', KILO_FIXTURE_SESSION_ID,
    Date.parse('2026-08-23T10:00:02.600Z'), Date.parse('2026-08-23T10:00:02.600Z'),
    JSON.stringify({ type: 'text', text: 'must refuse' }),
  );
  malformedIdentityDatabase.close();
  check('oversized durable row identities refuse history before mapping',
    await readKiloHistory(sessions[0]!) === undefined);
  const malformedCleanup = new Database(tree.databasePath);
  malformedCleanup.query('delete from part where id = ?').run(oversizedPartId);
  malformedCleanup.close();

  symlinkSync(tree.databasePath, `${tree.databasePath}-wal`);
  const refusedTrace: string[] = [];
  check('an unsafe SQLite sidecar refuses the complete snapshot',
    await readKiloHistory(sessions[0]!, { trace: (event) => refusedTrace.push(event.op) }) === undefined
      && refusedTrace.includes('path-refused'),
    refusedTrace.join(','));
  rmSync(`${tree.databasePath}-wal`);

  const activeTree = buildKiloFixtureTree({ updatedAt: Date.now(), incomplete: true });
  try {
    const active = await discoverKiloStore({
      env: { KILO_DATA_DIR: activeTree.dataRoot },
      updatedAfter: Date.now() + 60_000,
    });
    check('an incomplete durable row does not invent live ownership or bypass updatedAfter', active.length === 0);
  } finally { activeTree.cleanup(); }

  const abort = new AbortController();
  abort.abort(new Error('fixture abort'));
  let aborted = false;
  try { await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot }, signal: abort.signal }); } catch { aborted = true; }
  check('discovery honors the caller abort signal', aborted);

  rmSync(tree.databasePath);
  check('legacy opencode-named databases are considered only when no kilo-named file exists',
    kiloDatabasePaths(tree.dataRoot).map((path) => path.split('/').at(-1)).join(',') === 'opencode.db');
  const legacy = await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } });
  check('the legacy fallback remains Kilo-root scoped', legacy[0]?.id === 'ses_legacy_wrong', JSON.stringify(legacy));
} finally {
  tree.cleanup();
}

{
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-aggregate-bound-'));
  try {
    mkdirSync(root, { recursive: true });
    for (const name of ['kilo-a.db', 'kilo-b.db']) {
      const path = join(root, name);
      writeFileSync(path, '');
      truncateSync(path, 40 * 1024 * 1024);
    }
    const trace: string[] = [];
    const rows = await discoverKiloStore({
      env: { KILO_DATA_DIR: root },
      trace: (event) => trace.push(event.detail),
    });
    check('selected sparse databases are refused by the aggregate snapshot budget before copying',
      rows.length === 0 && trace.some((detail) => detail.includes('discovery budget')),
      trace.join(','));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

{
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-db-bound-'));
  try {
    mkdirSync(root, { recursive: true });
    for (let index = 0; index < 9; index += 1) writeFileSync(join(root, `kilo-${index}.db`), '');
    check('more than the database bound refuses partial path discovery', kiloDatabasePaths(root).length === 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

{
  const duplicateTree = buildKiloFixtureTree();
  try {
    createKiloDatabase(join(duplicateTree.dataRoot, 'kilo-dev.db'));
    const trace: string[] = [];
    const duplicateRows = await discoverKiloStore({
      env: { KILO_DATA_DIR: duplicateTree.dataRoot },
      trace: (event) => trace.push(event.detail),
    });
    check('a native session id present in multiple selected databases fails closed',
      duplicateRows.length === 0 && trace.some((detail) => detail.includes('multiple selected databases')),
      JSON.stringify({ duplicateRows, trace }));
  } finally { duplicateTree.cleanup(); }
}

{
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-same-db-duplicate-'));
  const dataRoot = join(root, 'data');
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, 'kilo.db');
  try {
    const database = new Database(path, { create: true });
    database.exec(`
      pragma journal_mode = WAL;
      create table migration (id integer primary key, name text);
      create table session (
        id text, parent_id text, slug text, directory text, title text,
        model text, revert text, agent text, time_created integer, time_updated integer,
        time_archived integer
      );
      create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
      insert into migration values (1, 'opencode-lineage');
    `);
    const insert = database.query(`insert into session
      (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
      values ('ses-duplicate', null, ?, ?, ?, null, null, null, ?, ?, null)`);
    insert.run('old', join(root, 'workspace'), 'Old', 1, 1);
    insert.run('new', join(root, 'workspace'), 'New', 2, 2);
    database.close();
    const trace: string[] = [];
    const sessions = await discoverKiloStore({
      env: { KILO_DATA_DIR: dataRoot },
      trace: (event) => trace.push(event.detail),
    });
    check('duplicate native session ids inside one selected database fail closed',
      sessions.length === 0 && trace.some((detail) => detail.includes('more than once')),
      JSON.stringify({ sessions, trace }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

{
  const incrementalTree = buildKiloFixtureTree();
  try {
    const database = new Database(incrementalTree.databasePath);
    const insert = database.query(`insert into session
      (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, null, null, null, ?, ?, null)`);
    database.exec('begin');
    for (let index = 0; index < 2_001; index += 1) {
      insert.run(`ses-old-${index}`, `old-${index}`, join(incrementalTree.root, 'workspace'),
        `Old ${index}`, 1, 1);
    }
    insert.run('ses-recent', 'recent', join(incrementalTree.root, 'workspace'), 'Recent',
      10_000_000_000_000, 10_000_000_000_000);
    database.exec('commit');
    database.close();
    const work: Array<{ bounded: boolean; cutoff?: number }> = [];
    const recent = await discoverKiloStore({
      env: { KILO_DATA_DIR: incrementalTree.dataRoot },
      updatedAfter: 9_000_000_000_000,
      onWork: (entry) => {
        if (entry.kind === 'sqlite-query') work.push({ bounded: entry.bounded, cutoff: entry.cutoff });
      },
    });
    check('incremental discovery bounds count, metadata, and row decode at the SQL cutoff',
      recent.length === 1 && recent[0]?.id === 'ses-recent'
        && work.some((entry) => entry.bounded && entry.cutoff === 9_000_000_000_000),
      JSON.stringify({ recent: recent.map((entry) => entry.id), work }));
  } finally { incrementalTree.cleanup(); }
}

{
  const anchoredTree = buildKiloFixtureTree();
  const aliasRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-root-link-'));
  try {
    const aliasParent = join(aliasRoot, 'linked-parent');
    symlinkSync(anchoredTree.root, aliasParent, 'dir');
    const configuredRoot = join(aliasParent, 'data');
    check('a symlinked intermediate data-root component is refused before database enumeration',
      kiloDatabasePaths(configuredRoot).length === 0
        && (await discoverKiloStore({ env: { KILO_DATA_DIR: configuredRoot } })).length === 0);
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
    anchoredTree.cleanup();
  }
}

// The session bound is a CLIFF, not a taper: one session over it and the roster
// publishes NONE of that database's sessions. That is deliberate fail-closed
// behaviour, but it used to be reported only through `trace`, an optional
// fixture hook nothing supplies in production -- so the sole production symptom
// was Kilo Code silently owning no sessions.
{
  const capRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-cap-'));
  try {
    const seedAndCount = (total: number): number => {
      const dataRoot = join(capRoot, `n${total}`, '.local', 'share', 'kilo');
      mkdirSync(dataRoot, { recursive: true });
      createKiloDatabase(join(dataRoot, 'kilo.db'), { id: 'ses_seed', title: 'seed' });
      const database = new Database(join(dataRoot, 'kilo.db'));
      const insert = database.query(`insert into session
        (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
        values (?, null, ?, ?, ?, null, null, ?, ?, ?, null)`);
      const seeded = Number((database.query('select count(*) as c from session where time_archived is null').get() as { c: number }).c);
      for (let index = seeded; index < total; index += 1) {
        insert.run(`ses_${index}`, `s-${index}`, join(capRoot, `wd-${index}`), `S${index}`, 'code', 1, 2);
      }
      database.close();
      return total;
    };
    const discoverAt = async (total: number): Promise<number> => {
      const home = join(capRoot, `n${total}`);
      const rows = await discoverKiloStore({
        homeDir: home,
        env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') },
      });
      return rows.length;
    };

    seedAndCount(KILO_MAX_SESSIONS);
    check('a store exactly at the session bound publishes every session',
      await discoverAt(KILO_MAX_SESSIONS) === KILO_MAX_SESSIONS,
      `${KILO_MAX_SESSIONS} sessions`);

    seedAndCount(KILO_MAX_SESSIONS + 1);
    const warnings: string[] = [];
    const realWarn = console.warn;
    resetKiloBoundWarnings();
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    let overBound = -1;
    let afterFirst = -1;
    let afterSecondDatabase = -1;
    try {
      overBound = await discoverAt(KILO_MAX_SESSIONS + 1);
      afterFirst = warnings.length;
      // Same database again: must stay quiet.
      await discoverAt(KILO_MAX_SESSIONS + 1);
      // A DIFFERENT database over the bound must speak for itself. Without this
      // the suite could not tell "once per database" from "once per process",
      // and a single process-global flag would pass every check.
      seedAndCount(KILO_MAX_SESSIONS + 2);
      afterSecondDatabase = await discoverAt(KILO_MAX_SESSIONS + 2);
    } finally {
      console.warn = realWarn;
    }
    check('one session over the bound publishes none of them',
      overBound === 0, `${KILO_MAX_SESSIONS + 1} sessions -> ${overBound} rows`);
    check('and says so, naming the database and the bound',
      warnings.length > 0
        && warnings[0]!.includes(String(KILO_MAX_SESSIONS))
        && /NONE/.test(warnings[0]!)
        && warnings[0]!.includes('kilo.db'),
      JSON.stringify(warnings[0] ?? '<silent>').slice(0, 150));
    check('the same database does not repeat itself on the next sweep',
      afterFirst === 1 && warnings.length === 2,
      `${warnings.length} line(s) across three sweeps of two databases`);
    check('but a DIFFERENT database over the bound is reported on its own',
      afterSecondDatabase === 0 && warnings.length === 2
        && warnings[1] !== warnings[0],
      JSON.stringify(warnings.map((line) => line.slice(-40))));

    // Re-arming. The message tells the operator to archive sessions; if doing
    // exactly that permanently silenced it, the second excursion would present
    // as the same unexplained empty Kilo the warning exists to explain.
    {
      const home = join(capRoot, `n${KILO_MAX_SESSIONS + 1}`);
      const database = new Database(join(home, '.local', 'share', 'kilo', 'kilo.db'));
      database.query('update session set time_archived = 1 where id = ?').run('ses_1');
      // Checkpointed, or the change sits in the WAL and the snapshot copy this
      // discovery takes still sees the pre-archive count.
      database.query('pragma wal_checkpoint(TRUNCATE)').get();
      database.close();
      const rearmed: string[] = [];
      const realWarnAgain = console.warn;
      console.warn = (...args: unknown[]) => { rearmed.push(args.map(String).join(' ')); };
      let backUnder = -1;
      try {
        backUnder = await discoverAt(KILO_MAX_SESSIONS + 1);
        const reopened = new Database(join(home, '.local', 'share', 'kilo', 'kilo.db'));
        reopened.query('update session set time_archived = null where id = ?').run('ses_1');
        reopened.query('pragma wal_checkpoint(TRUNCATE)').get();
        reopened.close();
        await discoverAt(KILO_MAX_SESSIONS + 1);
      } finally {
        console.warn = realWarnAgain;
      }
      check('archiving back under the bound restores the roster',
        backUnder === KILO_MAX_SESSIONS, `${backUnder} rows`);
      check('and drifting over it again is reported a second time',
        rearmed.length === 1 && /NONE/.test(rearmed[0]!),
        `${rearmed.length} line(s) after re-arming`);
    }

    // A WINDOWED sweep must not re-arm. The bound count is window-scoped, but
    // the broker sweeps one database on two windows at once -- all time for
    // /api/machines, the caller's window for /api/sessions. Re-arming on a
    // windowed count let the narrow sweep clear the arm the all-time sweep had
    // just set, silently restoring the once-per-sweep spam this mechanism
    // exists to prevent. Without this check the suite cannot tell "once per
    // database" from "once per database per window", because every other sweep
    // here is unwindowed.
    {
      const total = KILO_MAX_SESSIONS + 3;
      seedAndCount(total);
      const home = join(capRoot, `n${total}`);
      const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') };
      const windowed: string[] = [];
      const realWarnWindowed = console.warn;
      resetKiloBoundWarnings();
      console.warn = (...args: unknown[]) => { windowed.push(args.map(String).join(' ')); };
      let afterAllTime = -1;
      try {
        await discoverKiloStore({ homeDir: home, env });
        afterAllTime = windowed.length;
        // Past every seeded time_updated, so the windowed count is under the
        // bound while the store itself is still over it.
        await discoverKiloStore({ homeDir: home, env, updatedAfter: 1_000_000 });
        await discoverKiloStore({ homeDir: home, env });
      } finally {
        console.warn = realWarnWindowed;
      }
      check('a narrow-window sweep under the bound does not re-arm the warning',
        afterAllTime === 1 && windowed.length === 1,
        `${windowed.length} line(s) across all-time, windowed, all-time`);
    }
  } finally {
    rmSync(capRoot, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
