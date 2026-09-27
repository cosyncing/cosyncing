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

{
  // One connection across a turn Kilo writes in place. Until a message completes, Kilo rewrites its
  // rows where they are: a text part grows, a running tool gains its result, and the message gains
  // its run summary before its final token reading. None of that rewinds history, so the connection
  // keeps its paging source and tails each new or rewritten row once. A rewrite of a row the store
  // had finished writing still rewinds it.
  const turnTree = buildKiloFixtureTree();
  try {
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: turnTree.dataRoot } }))[0]!;
    const connection = new KiloObserveConnection({
      session,
      info: {
        id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
        cwd: session.cwd, status: session.status, attachMode: 'observe',
      },
    });
    await connection.getHistory();
    const tail: AgentMessage[] = [];
    const unsubscribe = connection.subscribe((message) => tail.push(message));
    const writer = new Database(turnTree.databasePath);
    writer.exec('pragma wal_autocheckpoint = 0');
    const at = Date.parse('2026-08-23T10:00:30.000Z');
    const assistant = (completed: boolean) => JSON.stringify({
      role: 'assistant', parentID: 'msg-user-turn', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
      time: { created: at + 100, ...(completed ? { completed: at + 900 } : {}) },
      ...(completed ? { finish: 'stop' } : {}),
      cost: completed ? 0.1 : 0,
      tokens: completed
        ? { input: 4, output: 1, cache: { read: 0, write: 0 }, total: 5 }
        : { input: 0, output: 0, cache: { read: 0, write: 0 }, total: 0 },
    });
    const tool = (status: 'running' | 'completed') => JSON.stringify({
      type: 'tool', tool: 'bash', callID: 'call-turn',
      state: status === 'completed'
        ? { status, input: { command: 'ls' }, output: 'a.txt', title: 'ls', metadata: { exit: 0 }, time: { start: 1, end: 2 } }
        : { status, input: { command: 'ls' }, time: { start: 1 } },
    });
    const part = (id: string, messageId: string, offset: number, data: string) =>
      writer.query('insert or replace into part values (?, ?, ?, ?, ?, ?)')
        .run(id, messageId, KILO_FIXTURE_SESSION_ID, at + offset, at + offset, data);
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-user-turn', KILO_FIXTURE_SESSION_ID, at, at, JSON.stringify({ role: 'user', time: { created: at } }),
    );
    part('prt-user-turn', 'msg-user-turn', 0, JSON.stringify({ type: 'text', text: 'turn prompt' }));
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-assistant-turn', KILO_FIXTURE_SESSION_ID, at + 100, at + 100, assistant(false),
    );
    part('prt-answer-turn', 'msg-assistant-turn', 200, JSON.stringify({ type: 'text', text: 'Hello wor', time: { start: at + 200 } }));
    await wait(500);
    // Another client attaching mid-turn reads the history through the same connection.
    await connection.getHistory();
    part('prt-answer-turn', 'msg-assistant-turn', 200,
      JSON.stringify({ type: 'text', text: 'Hello world', time: { start: at + 200, end: at + 300 } }));
    part('prt-tool-turn', 'msg-assistant-turn', 400, tool('running'));
    await wait(500);
    const midTurnIdentity = await connection.getHistorySourceIdentity();
    part('prt-tool-turn', 'msg-assistant-turn', 400, tool('completed'));
    writer.query('update message set time_updated = ?, data = ? where id = ?')
      .run(at + 900, assistant(true), 'msg-assistant-turn');
    await wait(500);
    const ended = await connection.getHistory();
    const capture = await connection.captureHistorySnapshot({ acceptsLocations: true, accept: () => true });
    const describeTail = () => JSON.stringify(tail.map((message) =>
      `${message.type}:${'key' in message ? message.key ?? '' : ''}${'callId' in message ? message.callId ?? '' : ''}`));
    check('a Kilo turn written in place never reads as a rollback on one connection',
      tail.every((message) => message.type !== 'history-reset')
        && midTurnIdentity !== undefined && await connection.getHistorySourceIdentity() !== undefined
        && !!capture && !('refusal' in capture),
      describeTail());
    const tailed = (type: string, id: string) => tail.filter((message) =>
      message.type === type && (('key' in message && message.key === id) || ('callId' in message && message.callId === id)));
    // A rewritten row comes again under its key (the answer as it grew, the call once it finished),
    // and no version of a row comes twice.
    const encodings = tail.map((message) => JSON.stringify(message));
    const answers = tailed('model-output', 'prt-answer-turn') as Array<Extract<AgentMessage, { type: 'model-output' }>>;
    check('each new or rewritten row of the turn tails once, under the key it already had',
      new Set(encodings).size === encodings.length
        && tailed('user-message', 'msg-user-turn').length === 1
        && answers.map((answer) => answer.text).join('|') === 'Hello wor|Hello world'
        && tailed('tool-call', 'call-turn').length === 2
        && tailed('tool-result', 'call-turn').length === 2
        && tailed('tool-result', 'call-turn').filter((row) => row.type === 'tool-result' && row.pending).length === 1
        && tailed('run-summary', 'kilo:run:msg-assistant-turn').length === 1,
      describeTail());
    check('the newest tailed version of each row is what a fresh read of the store maps',
      [['model-output', 'prt-answer-turn'], ['tool-call', 'call-turn'], ['tool-result', 'call-turn'],
        ['run-summary', 'kilo:run:msg-assistant-turn']].every(([type, id]) =>
        JSON.stringify(ended.findLast((message) => message.type === type))
          === JSON.stringify(tailed(type!, id!).at(-1))),
      describeTail());

    part('prt-user-turn', 'msg-user-turn', 0, JSON.stringify({ type: 'text', text: 'rewritten prompt' }));
    await wait(500);
    writer.close();
    check('a rewrite of a row Kilo had finished writing still resets and ends paging',
      tail.some((message) => message.type === 'history-reset' && message.semantic?.kind === 'rollback')
        && await connection.getHistorySourceIdentity() === undefined,
      describeTail());
    unsubscribe();
    await connection.close();
  } finally {
    turnTree.cleanup();
  }
}

{
  // The other rows Kilo may still rewrite: the newest prompt, whose parts land after its message
  // (a text part can arrive after an attachment and map before it), and a step that completes
  // before its tool part settles. Neither rewinds history. A revert of that open prompt removes a
  // row that carried a key, and does.
  const promptTree = buildKiloFixtureTree();
  try {
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: promptTree.dataRoot } }))[0]!;
    const connection = new KiloObserveConnection({
      session,
      info: {
        id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title,
        cwd: session.cwd, status: session.status, attachMode: 'observe',
      },
    });
    const resets: AgentMessage[] = [];
    const unsubscribe = connection.subscribe((message) => { if (message.type === 'history-reset') resets.push(message); });
    const writer = new Database(promptTree.databasePath);
    writer.exec('pragma wal_autocheckpoint = 0');
    const at = Date.parse('2026-08-23T10:00:50.000Z');
    const insertPart = (id: string, messageId: string, offset: number, data: unknown) =>
      writer.query('insert or replace into part values (?, ?, ?, ?, ?, ?)')
        .run(id, messageId, KILO_FIXTURE_SESSION_ID, at + offset, at + offset, JSON.stringify(data));
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-user-open', KILO_FIXTURE_SESSION_ID, at, at, JSON.stringify({ role: 'user', time: { created: at } }),
    );
    insertPart('prt-user-open-image', 'msg-user-open', 0, { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' });
    await connection.getHistory();
    insertPart('prt-user-open-text', 'msg-user-open', 1, { type: 'text', text: 'what is in this picture?' });
    const prompted = await connection.getHistory();
    check('the newest prompt gaining its text after its attachment is not a rewrite',
      resets.length === 0 && await connection.getHistorySourceIdentity() !== undefined
        && prompted.some((message) => message.type === 'user-message' && message.key === 'msg-user-open'),
      JSON.stringify(resets));

    const step = (completed: boolean) => JSON.stringify({
      role: 'assistant', parentID: 'msg-user-open', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
      time: { created: at + 100, ...(completed ? { completed: at + 900 } : {}) },
      ...(completed ? { finish: 'stop' } : {}),
      error: completed ? { name: 'MessageAbortedError', data: { message: 'Aborted' } } : undefined,
    });
    const stepTool = (status: 'running' | 'error') => ({
      type: 'tool', tool: 'bash', callID: 'call-open',
      state: status === 'error'
        ? { status, input: { command: 'sleep 9' }, error: 'Tool execution aborted', time: { start: 1, end: 2 } }
        : { status, input: { command: 'sleep 9' }, time: { start: 1 } },
    });
    writer.query('insert into message values (?, ?, ?, ?, ?)')
      .run('msg-assistant-open', KILO_FIXTURE_SESSION_ID, at + 100, at + 100, step(false));
    insertPart('prt-tool-open', 'msg-assistant-open', 200, stepTool('running'));
    await connection.getHistory();
    // The step is aborted: its message completes first, and its tool part settles after.
    writer.query('update message set data = ? where id = ?').run(step(true), 'msg-assistant-open');
    await connection.getHistory();
    insertPart('prt-tool-open', 'msg-assistant-open', 200, stepTool('error'));
    await connection.getHistory();
    check('a step completing before its tool part settles is not a rewrite',
      resets.length === 0 && await connection.getHistorySourceIdentity() !== undefined, JSON.stringify(resets));

    // A revert to the newest prompt removes it and everything after it.
    writer.query('insert into message values (?, ?, ?, ?, ?)').run(
      'msg-user-reverted', KILO_FIXTURE_SESSION_ID, at + 2_000, at + 2_000,
      JSON.stringify({ role: 'user', time: { created: at + 2_000 } }),
    );
    insertPart('prt-user-reverted', 'msg-user-reverted', 2_000, { type: 'text', text: 'one more thing' });
    await connection.getHistory();
    writer.query('update session set revert = ? where id = ?')
      .run(JSON.stringify({ messageID: 'msg-user-reverted' }), KILO_FIXTURE_SESSION_ID);
    const reverted = await connection.getHistory();
    writer.close();
    check('a revert of the newest prompt still resets and ends paging',
      resets.some((message) => message.type === 'history-reset' && message.semantic?.kind === 'rollback')
        && await connection.getHistorySourceIdentity() === undefined
        && !reverted.some((message) => message.type === 'user-message' && message.key === 'msg-user-reverted'),
      JSON.stringify(resets));
    unsubscribe();
    await connection.close();
  } finally {
    promptTree.cleanup();
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
