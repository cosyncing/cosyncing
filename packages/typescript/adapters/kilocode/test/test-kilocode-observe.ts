#!/usr/bin/env bun
export {};
import { Database } from 'bun:sqlite';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, HistorySnapshotSink, SessionInfo } from '@cosyncing/adapter-api';
import { AttentionPolicy } from '../../../broker/src/attention/attention-policy.ts';
import { AttentionStore } from '../../../broker/src/attention/attention-store.ts';
import { KiloObserveConnection } from '../src/observe.ts';
import { discoverKiloStore } from '../src/store.ts';
import { appendKiloTurn, buildKiloFixtureTree, KILO_FIXTURE_SESSION_ID } from './fixtures/database.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tree = buildKiloFixtureTree();
try {
  const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } }))[0];
  if (!session) throw new Error('fixture discovery failed');
  const info: SessionInfo = {
    id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
    cwd: session.cwd, status: session.status, attachMode: 'observe',
    updatedAt: session.updatedAt, model: session.model, currentModel: session.currentModel,
    currentAgent: session.currentAgent,
  };
  const connection = new KiloObserveConnection({ session, info });
  const history = await connection.getHistory();
  check('replay maps SQLite user, thought, answer, run, and token rows',
    ['user-message', 'thinking', 'model-output', 'run-summary', 'token-count']
      .every((type) => history.some((message) => message.type === type)),
    JSON.stringify(history.map((message) => message.type)));

  const clearedDatabase = new Database(tree.databasePath);
  clearedDatabase.query('update session set time_created = null, time_updated = null, model = null, agent = null where id = ?')
    .run(session.id);
  clearedDatabase.close();
  await connection.getHistory();
  check('refresh clears stale timestamp, model, and agent projections when SQLite clears them',
    connection.info.updatedAt === undefined && connection.info.model === undefined
      && connection.info.currentModel === undefined && connection.info.currentAgent === undefined);
  const restoredDatabase = new Database(tree.databasePath);
  restoredDatabase.query('update session set time_created = ?, time_updated = ?, model = ?, agent = ? where id = ?').run(
    Date.parse('2026-08-23T10:00:00.000Z'), Date.parse('2026-08-23T10:00:03.000Z'),
    JSON.stringify({ id: 'qwen-fixture', providerID: 'vllm-fixture', variant: 'default' }),
    'code', session.id,
  );
  restoredDatabase.close();

  const accepted: AgentMessage[] = [];
  const sink: HistorySnapshotSink = {
    acceptsLocations: true,
    accept(message) { accepted.push(message); return true; },
  };
  const capture = await connection.captureHistorySnapshot(sink);
  const page = capture && !('refusal' in capture) && capture.reader ? await capture.reader.read([0]) : undefined;
  check('snapshot capture retains compact page encodings under one DB revision',
    !!capture && !('refusal' in capture) && !!page && !('refusal' in page)
      && page.identity.revision === capture.identity.revision && page.messages.length === 1,
    JSON.stringify({ accepted: accepted.length, page }));

  const replacement = buildKiloFixtureTree();
  try {
    const replacementDatabase = new Database(replacement.databasePath);
    const replacementAt = Date.parse('2026-08-23T10:00:08.000Z');
    replacementDatabase.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-replacement', session.id, replacementAt, replacementAt,
      JSON.stringify({ role: 'user', time: { created: replacementAt } }),
    );
    replacementDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
      'prt-replacement', 'msg-replacement', session.id, replacementAt, replacementAt,
      JSON.stringify({ type: 'text', text: 'replacement prompt' }),
    );
    replacementDatabase.close();
    renameSync(replacement.databasePath, tree.databasePath);
    const replacementHistory = await connection.getHistory();
    check('same-prefix main-database replacement resets paging instead of appending under the old source',
      replacementHistory.some((message) => message.type === 'user-message' && message.text === 'replacement prompt')
        && await connection.getHistorySourceIdentity() === undefined);
  } finally { replacement.cleanup(); }

  const live: AgentMessage[] = [];
  const unsubscribe = connection.subscribe((message) => live.push(message));
  const walWriter = appendKiloTurn(tree.databasePath);
  const journalMode = String((walWriter.query('pragma journal_mode').get() as { journal_mode?: string } | null)?.journal_mode ?? '');
  await wait(500);
  check('a WAL-mode SQLite commit emits the appended mapped row once',
    journalMode === 'wal'
      && live.filter((message) => message.type === 'user-message' && message.text === 'tail prompt').length === 1,
    JSON.stringify(live));
  walWriter.close();

  const database = new Database(tree.databasePath);
  database.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'rewritten answer' }), 'prt-answer',
  );
  database.close();
  await wait(500);
  check('a change inside the retained prefix emits rollback reset and invalidates paging',
    live.some((message) => message.type === 'history-reset' && message.semantic?.kind === 'rollback')
      && await connection.getHistorySourceIdentity() === undefined,
    JSON.stringify(live));

  let promptRejected = false;
  let permissionRejected = false;
  try { await connection.sendPrompt({ text: 'no' }); } catch { promptRejected = true; }
  try { await connection.respondPermission('no', 'approve'); } catch { permissionRejected = true; }
  check('Observe rejects prompt and permission mutations', promptRejected && permissionRejected);
  unsubscribe();
  await connection.close();
} finally {
  tree.cleanup();
}

{
  const recoveryTree = buildKiloFixtureTree();
  try {
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: recoveryTree.dataRoot } }))[0]!;
    const connection = new KiloObserveConnection({
      session,
      info: {
        id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
        cwd: session.cwd, status: session.status, attachMode: 'observe',
      },
    });
    const unsubscribe = connection.subscribe(() => undefined);
    const internals = connection as unknown as { watcher?: { emit(event: string, ...args: unknown[]): void } };
    const firstWatcher = internals.watcher;
    firstWatcher?.emit('change', 'change', 'kilo.db-wal');
    firstWatcher?.emit('error', new Error('fixture watcher failure'));
    await wait(600);
    check('a watcher error during a pending debounce cancels it and rearms a replacement watcher',
      !!internals.watcher && internals.watcher !== firstWatcher);
    unsubscribe();
    await connection.close();
  } finally { recoveryTree.cleanup(); }
}

{
  // SQLite Observe is terminal-only by design: an unfinished assistant row projects no run
  // footer, and a finished one appends its terminal. With no live `running` ahead of it, the
  // broker's attention policy has no run to close, so an observed Kilo turn stays silent rather
  // than half-pairing into a "turn finished" nobody driven from here asked for.
  const turnTree = buildKiloFixtureTree();
  const attentionRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-observe-attention-'));
  try {
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: turnTree.dataRoot } }))[0]!;
    const info: SessionInfo = {
      id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
      cwd: session.cwd, status: session.status, attachMode: 'observe',
    };
    const connection = new KiloObserveConnection({ session, info });
    await connection.getHistory();
    const tail: AgentMessage[] = [];
    const unsubscribe = connection.subscribe((message) => tail.push(message));
    const runs = () => tail.filter((message): message is Extract<AgentMessage, { type: 'run-summary' }> =>
      message.type === 'run-summary');
    const describe = () => JSON.stringify(tail.map((message) =>
      message.type === 'run-summary' ? `run-summary:${message.key}=${message.status}` : message.type));

    const writer = new Database(turnTree.databasePath);
    writer.exec('pragma wal_autocheckpoint = 0');
    const startedAt = Date.parse('2026-08-23T10:00:20.000Z');
    const assistant = (completed: boolean) => JSON.stringify({
      role: 'assistant', parentID: 'msg-user-observed', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
      time: { created: startedAt + 100, ...(completed ? { completed: startedAt + 900 } : {}) },
      ...(completed ? { finish: 'stop', cost: 0.1, tokens: { input: 4, output: 1, cache: { read: 0, write: 0 }, total: 5 } } : {}),
    });
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-user-observed', KILO_FIXTURE_SESSION_ID, startedAt, startedAt,
      JSON.stringify({ role: 'user', time: { created: startedAt } }),
    );
    writer.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
      'prt-user-observed', 'msg-user-observed', KILO_FIXTURE_SESSION_ID, startedAt, startedAt,
      JSON.stringify({ type: 'text', text: 'observed prompt' }),
    );
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-assistant-observed', KILO_FIXTURE_SESSION_ID, startedAt + 100, startedAt + 100, assistant(false),
    );
    writer.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
      'prt-answer-observed', 'msg-assistant-observed', KILO_FIXTURE_SESSION_ID, startedAt + 200, startedAt + 200,
      JSON.stringify({ type: 'text', text: 'observed answer' }),
    );
    await wait(500);
    check('an unfinished observed Kilo turn tails its rows with no run-summary at all',
      tail.some((message) => message.type === 'model-output' && message.text === 'observed answer')
        && runs().length === 0,
      describe());

    writer.query('update message set time_updated = ?, data = ? where id = ?')
      .run(startedAt + 900, assistant(true), 'msg-assistant-observed');
    await wait(500);
    writer.close();
    const observedRuns = runs().filter((message) => message.key === 'kilo:run:msg-assistant-observed');
    check('its completion arrives as exactly one terminal, and the observe tail never says running',
      observedRuns.length === 1 && observedRuns[0]!.status === 'done'
        && runs().every((message) => message.status !== 'running'),
      describe());

    const attentionStore = new AttentionStore({ path: join(attentionRoot, 'attention-events.json'), onWarning: () => undefined });
    const attentionPolicy = new AttentionPolicy(attentionStore);
    for (const message of tail) await attentionPolicy.handleMessage(info, message);
    check('the real attention policy raises nothing for an observe-only Kilo turn',
      attentionStore.listEvents().length === 0 && attentionStore.listObservations().length === 0,
      JSON.stringify(attentionStore.listEvents().map((event) => event.dedupeKey)));
    unsubscribe();
    await connection.close();
  } finally {
    turnTree.cleanup();
    rmSync(attentionRoot, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
