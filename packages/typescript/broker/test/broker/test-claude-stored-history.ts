/** Standalone acceptance suite. Intentionally not registered with CI while
 * its runner is being replaced. Run: bun run <this file>. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeObserveConnection, ClaudeResumeConnection } from '../../../adapters/claude/src/index.ts';
import { storedHistoryIndex } from '../../src/sessions/stored-history-index.ts';
import { estimatedClientDecodedBytes } from '../../src/sessions/history-delta.ts';
import { ManagedConn } from '../../src/sessions/hub.ts';
import type { AgentMessage, SessionConnection } from '../../../adapter-api/src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-stored-history-'));
const previousHome = process.env.COSYNCING_HOME;
process.env.COSYNCING_HOME = root;
const path = join(root, 'fixture.jsonl');
const user = (i: number, size = 30) => ({ type: 'user', uuid: `user-${i}`, timestamp: `2026-10-14T10:00:00.000Z`, message: { content: `row ${i} ${'x'.repeat(size)}` } });
const assistant = (uuid: string, content: unknown[], id = uuid) => ({ type: 'assistant', uuid, timestamp: '2026-10-14T10:00:01.000Z', message: { id, content } });
const conn = () => new ClaudeObserveConnection(path, { id: 'fixture', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'observe', currentMode: 'default' });
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

async function allStored(c: Pick<SessionConnection, 'openHistorySnapshot'>): Promise<AgentMessage[]> {
  const snapshot = await c.openHistorySnapshot!(); assert(snapshot);
  const rows: AgentMessage[] = [];
  for (let start = 0; start < snapshot.count; start += 100) {
    const read = await snapshot.reader.read(Array.from({ length: Math.min(100, snapshot.count - start) }, (_, i) => start + i));
    assert(read && !('refusal' in read)); rows.push(...read.messages);
  }
  return rows;
}

try {
  const rows = [user(0),
    assistant('a1', [{ type: 'text', text: 'first' }], 'shared'),
    assistant('a2', [{ type: 'thinking', thinking: 'reason' }], 'shared'),
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'body' }] } },
    assistant('a3', [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/fixture/file.ts' } }]),
    assistant('task-z', [{ type: 'tool_use', id: 'task-z-call', name: 'TaskCreate', input: { subject: 'Z first' } }]),
    { type: 'user', uuid: 'task-z-result', message: { content: [{ type: 'tool_result', tool_use_id: 'task-z-call', content: 'Task #9 created successfully: Z first' }] } },
    assistant('task-a', [{ type: 'tool_use', id: 'task-a-call', name: 'TaskCreate', input: { subject: 'A second' } }]),
    { type: 'user', uuid: 'task-a-result', message: { content: [{ type: 'tool_result', tool_use_id: 'task-a-call', content: 'Task #1 created successfully: A second' }] } },
    assistant('task-update', [{ type: 'tool_use', id: 'task-update-call', name: 'TaskUpdate', input: { taskId: '9', status: 'completed' } }]),
    { type: 'user', uuid: 'task-update-result', message: { content: [{ type: 'tool_result', tool_use_id: 'task-update-call', content: 'Updated task #9 status' }] } },
    { ...assistant('tokens', [{ type: 'text', text: 'done' }]), message: { id: 'tokens', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, output_tokens: 5 }, stop_reason: 'end_turn' } },
    user(1),
  ];
  writeFileSync(path, encode(rows));
  let c = conn();
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'disk replay must exactly match full history, including later tool definitions');
  const original = await c.openHistorySnapshot(); assert(original);
  assert.equal(c.historyReadWork?.sourceBytes, 0, 'unchanged open reads no native records');
  const cache = await storedHistoryIndex(original);
  const attached = await cache.loadAttach(undefined, 3); assert('messages' in attached && attached.endCursor);
  appendFileSync(path, encode([assistant('a4', [{ type: 'text', text: 'third sibling' }], 'shared'), user(2)]));
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'incremental state must preserve block numbering and runtime');
  const newer = await c.openHistorySnapshot(); assert(newer);
  const newerCache = await storedHistoryIndex(newer);
  const page = await newerCache.loadPage(attached.endCursor, 3);
  assert('messages' in page && !page.gap, 'issued boundaries survive append');
  await c.close();
  c = conn();
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'restart restores mapper state');
  assert.equal(c.historyReadWork?.sourceBytes, 0, 'restart reuses the persisted index');
  appendFileSync(path, encode([assistant('a5', [{ type: 'text', text: 'fourth sibling' }], 'shared')]));
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'append after restart');
  writeFileSync(path, encode([user(100)]));
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'shrink/rewrite rebuilds derived state');
  const stale = await original.reader.read([0]); assert.equal(stale, undefined, 'rewritten source invalidates old snapshots');
  await c.close();
  console.log('PASS exact replay, late enrichment, append, restart, rewrite and cursor continuity');

  writeFileSync(path, encode([user(0)]));
  c = conn();
  const live: AgentMessage[] = [];
  const unsubscribe = c.subscribe((message) => live.push(message));
  await c.openHistorySnapshot();
  const delivered = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('live indexed tail timed out')), 5000);
    const un = c.subscribe((message) => {
      if (message.type === 'model-output' && message.text === 'live sibling') { clearTimeout(deadline); un(); resolve(); }
    });
  });
  appendFileSync(path, encode([assistant('live', [{ type: 'text', text: 'live sibling' }])]));
  await delivered;
  assert.equal(live.filter((message) => message.type === 'model-output' && message.text === 'live sibling').length, 1);
  assert.equal(c.historyReadWork?.mappedRecords, 1, 'live updates map only newly appended records');
  unsubscribe(); await c.close();
  console.log('PASS live tail after indexed attach');

  writeFileSync(path, encode([user(0), { type: 'user', uuid: 'late-result', message: { content: [{ type: 'tool_result', tool_use_id: 'late-call', content: 'result before definition' }] } }]));
  c = conn(); const peer = conn();
  const [first, shared] = await Promise.all([c.openHistorySnapshot(), peer.openHistorySnapshot()]);
  assert(first && shared && first.version === shared.version, 'concurrent clients share one native index build');
  await peer.close();
  appendFileSync(path, encode([assistant('late-definition', [{ type: 'tool_use', id: 'late-call', name: 'Read', input: { file_path: '/late/file.ts' } }])]));
  assert.deepEqual(await allStored(c), JSON.parse(JSON.stringify(await c.getHistory())), 'late appended call definition rebuilds affected mapping correctly');
  assert.equal(await first.reader.read([0]), undefined, 'late enrichment invalidates superseded readers');
  await c.close();
  console.log('PASS shared indexing and appended late enrichment');

  // A pending driven prompt must retain its app key when a history refresh
  // sees the transcript echo before the live tail does.
  writeFileSync(path, encode([user(0)]));
  const drive = new ClaudeResumeConnection({ configDir: root, projectsRoot: root, bin: 'unused', isDefault: true }, path,
    { id: 'driven', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'resume' });
  (drive as any).relaunch = () => {
    (drive as any).proc = { stdin: { write: () => true, end: () => {} }, kill: () => {}, killed: false };
    return true;
  };
  await drive.openHistorySnapshot();
  await drive.sendPrompt({ text: 'my pending prompt' });
  const pending = (await allStored(drive)).find((message) => message.type === 'user-message' && message.text === 'my pending prompt');
  assert(pending?.type === 'user-message' && pending.queued && pending.key?.startsWith('queued:app:'));
  appendFileSync(path, encode([{ type: 'user', uuid: 'drive-echo', timestamp: new Date().toISOString(), message: { content: 'my pending prompt' } }]));
  const deliveredRows = (await allStored(drive)).filter((message) => message.type === 'user-message' && message.text === 'my pending prompt');
  assert.equal(deliveredRows.length, 1);
  assert(deliveredRows[0]?.type === 'user-message' && deliveredRows[0].key === pending.key && !deliveredRows[0].queued);
  await drive.close();
  console.log('PASS driven pending prompt survives refresh and adopts the delivered transcript row');

  // Partial native records cannot advance the checkpoint or lose their bytes.
  writeFileSync(path, encode([user(0)])); c = conn();
  await c.openHistorySnapshot();
  const partial = encode([user(1)]);
  appendFileSync(path, partial.slice(0, 20));
  const incomplete = await allStored(c);
  assert.equal(incomplete.filter((message) => message.type === 'user-message').length, 1);
  appendFileSync(path, partial.slice(20));
  assert.equal((await allStored(c)).filter((message) => message.type === 'user-message').length, 2);
  await c.close();
  const cacheRoot = join(root, 'cache', 'claude-history');
  for (const name of readdirSync(cacheRoot).filter((name) => name.endsWith('.sqlite'))) {
    writeFileSync(join(cacheRoot, name), 'not a database');
    for (const suffix of ['-wal', '-shm']) rmSync(join(cacheRoot, name + suffix), { force: true });
  }
  c = conn();
  assert.equal((await allStored(c)).filter((message) => message.type === 'user-message').length, 2);
  await c.close();
  console.log('PASS partial-line append and disposable cache corruption recovery');

  const hugeBody = '😀long output\n'.repeat(110_000);
  writeFileSync(path, encode([user(0), assistant('huge', [{ type: 'text', text: hugeBody }]), user(1)]));
  c = conn();
  const hugeRows = await allStored(c);
  const preview = hugeRows.find((row) => row.type === 'model-output');
  assert(preview?.type === 'model-output' && preview.bodyTruncated && preview.text!.length <= 128 * 1024);
  const bodyFile = hugeRows.find((row) => row.type === 'file-artifact');
  assert(bodyFile?.type === 'file-artifact');
  assert.equal(readFileSync(bodyFile.path, 'utf8'), hugeBody, 'full text remains accessible beyond the bounded preview');
  await c.close();
  console.log('PASS oversized body preview and complete file');

  writeFileSync(path, ''); c = conn();
  const empty = await c.openHistorySnapshot(); assert(empty);
  const emptyAttach = await (await storedHistoryIndex(empty)).loadAttach(undefined, 100);
  assert('messages' in emptyAttach && emptyAttach.endCursor);
  appendFileSync(path, encode([user(0), ...Array.from({ length: 55 }, (_, i) => assistant(`wide-${i}`, [{ type: 'text', text: `${i} ${'w'.repeat(80_000)}` }]))]));
  const wide = await c.openHistorySnapshot(); assert(wide);
  const wideIndex = await storedHistoryIndex(wide);
  const wideAttach = await wideIndex.loadAttach(undefined, 100, undefined, 2 * 1024 * 1024);
  assert('messages' in wideAttach && wideAttach.olderCursor);
  const backwards = new Set(wideAttach.messages.filter((m) => m.type === 'model-output').map((m) => m.key));
  let older = wideAttach.olderCursor;
  while (older) {
    const page = await wideIndex.loadPage(older, 100); assert('messages' in page && !page.gap);
    assert(page.messages.reduce((sum, m) => sum + estimatedClientDecodedBytes(m), 0) <= 2 * 1024 * 1024);
    for (const m of page.messages) if (m.type === 'model-output') { assert(!backwards.has(m.key)); backwards.add(m.key); }
    older = page.cursor!;
  }
  assert.equal(backwards.size, 55, 'byte-shortened backward pages do not skip or repeat rows');
  let forwardCursor = emptyAttach.endCursor;
  const forwards = new Set<string | undefined>();
  for (;;) {
    const page = await wideIndex.loadNewerPage(forwardCursor, 100); assert('messages' in page && !page.gap);
    assert(page.messages.reduce((sum, m) => sum + estimatedClientDecodedBytes(m), 0) <= 2 * 1024 * 1024);
    for (const m of page.messages) if (m.type === 'model-output') { assert(!forwards.has(m.key)); forwards.add(m.key); }
    if (!page.hasMore) break;
    assert(page.cursor && page.cursor !== forwardCursor); forwardCursor = page.cursor;
  }
  assert.equal(forwards.size, 55, 'byte-shortened forward pages do not skip or repeat rows');
  await c.close();
  console.log('PASS bounded decoded pages preserve every row in both directions');

  writeFileSync(path, encode([user(0)]));
  c = new ClaudeObserveConnection(path, { id: 'mod', title: 'fixture', tool: 'claude', status: 'working', attachMode: 'observe' }, undefined, { turnEndGraceMs: 0 });
  await c.openHistorySnapshot();
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('indexed mod completion timed out')), 5000);
    c.subscribe((message) => { if (message.type === 'status' && message.status === 'idle') { clearTimeout(timer); resolve(); } });
  });
  const terminal = assistant('terminal', [{ type: 'text', text: 'done' }]);
  appendFileSync(path, encode([{ ...terminal, message: { ...terminal.message, stop_reason: 'end_turn' } }]));
  c.noteModTurnEnded({ aborted: false, endedAt: Date.now() });
  await finished;
  assert((await allStored(c)).some((message) => message.type === 'run-summary' && message.status === 'done'));
  await c.close();
  console.log('PASS live terminal summary and mod completion wait for the indexed tail');

  // More than 50k normalized rows and 32 MiB. The old complete-cache path
  // refuses this fixture; every user row must remain readable in either direction.
  writeFileSync(path, encode(Array.from({ length: 18_000 }, (_, i) => user(i, 2100))));
  c = conn();
  const start = performance.now();
  const large = await c.openHistorySnapshot(); assert(large && large.count > 50_000);
  const largeCache = await storedHistoryIndex(large);
  assert(largeCache.stats.encodedBytes < 8 * 1024 * 1024, 'memory charge stays bounded beyond the old limits');
  const tail = await largeCache.loadAttach(undefined, 100); assert('messages' in tail && tail.olderCursor);
  let cursor: string | undefined = tail.olderCursor;
  let users = tail.messages.filter((message) => message.type === 'user-message').length;
  let pages = 0;
  while (cursor) {
    const page = await largeCache.loadPage(cursor, 100);
    assert('messages' in page && !page.gap);
    assert(page.messages.length <= 100);
    users += page.messages.filter((message) => message.type === 'user-message').length;
    cursor = page.cursor; pages += 1;
    assert((largeCache.lastReadWork?.recordsRead ?? 0) <= 100, 'paging reads only requested records');
  }
  assert.equal(users, 18_000, 'whole session remains reachable exactly once');
  console.log(JSON.stringify({ pass: 'large history round trip', rows: large.count, pages, memoryBudgetBytes: largeCache.encodedBytes, elapsedMs: Math.round(performance.now() - start) }));
  let pauseBuild!: () => void, releaseBuild!: () => void;
  const building = new Promise<void>((resolve) => { pauseBuild = resolve; });
  const released = new Promise<void>((resolve) => { releaseBuild = resolve; });
  let firstRead = true;
  const rebuild = storedHistoryIndex({ ...large, version: 'atomic-rebuild-test', previousVersion: undefined, reader: {
    ...large.reader,
    read: async (locations, query) => {
      if (firstRead) { firstRead = false; pauseBuild(); await released; }
      return large.reader.read(locations, query);
    },
  } });
  await building;
  try {
    const concurrent = await largeCache.loadPage(tail.olderCursor, 500);
    assert('messages' in concurrent && !concurrent.gap && concurrent.messages.length > 100,
      'pages remain readable while the replacement index is incomplete');
  } finally { releaseBuild(); }
  await rebuild;
  await assert.rejects(storedHistoryIndex({ ...large, version: 'failed-rebuild-test', previousVersion: undefined,
    reader: { ...large.reader, read: () => { throw new Error('injected read failure'); } },
  }), /injected read failure/);
  const afterFailure = await largeCache.loadPage(tail.olderCursor, 500);
  assert('messages' in afterFailure && !afterFailure.gap, 'failed builds roll back without damaging issued pages');
  const missingCache = await storedHistoryIndex(large);
  (missingCache as any).reader = { read: () => { throw new Error('cache file evicted'); } };
  assert.deepEqual(await missingCache.loadPage(tail.olderCursor, 100), { kind: 'source-changed' },
    'a disappeared disk cache is a recoverable page failure');
  console.log('PASS concurrent page reads and atomic index rollback');

  // Reset/compaction must use the bounded index too, not invoke full replay.
  c.getHistory = async () => { throw new Error('full replay is forbidden in stored resync'); };
  const managed = new ManagedConn(c);
  const frames: any[] = [];
  managed.addClient((frame) => frames.push(frame));
  await (managed as any).resync('indexed reset');
  const reset = frames.find((frame) => frame.kind === 'history');
  assert(reset?.reset && reset.hasEarlier && reset.olderCursor && reset.endCursor);
  assert(reset.messages.length <= 100);
  const runningAttach = await largeCache.loadAttach(undefined, 100, undefined, 2 * 1024 * 1024, undefined, true);
  assert('messages' in runningAttach && runningAttach.messages.length <= 100);
  assert((largeCache.lastReadWork?.recordsRead ?? 0) <= 100, 'running turns do not scan their entire prefix');
  await managed.dispose();
  console.log('PASS bounded managed resync and attach during an active turn');

  const real = process.env.COSYNCING_TEST_CLAUDE_TRANSCRIPT;
  if (real) {
    const realConnection = new ClaudeObserveConnection(real, { id: 'authorized-real-fixture', tool: 'claude', title: 'History acceptance', status: 'idle', attachMode: 'observe', currentMode: 'default' });
    try {
      const coldStart = performance.now();
      const snapshot = await realConnection.openHistorySnapshot(); assert(snapshot);
      const index = await storedHistoryIndex(snapshot);
      const attached = await index.loadAttach(undefined, 100); assert('messages' in attached);
      const coldMs = performance.now() - coldStart;
      const warmStart = performance.now();
      const warm = await realConnection.openHistorySnapshot(); assert(warm);
      const warmIndex = await storedHistoryIndex(warm);
      await warmIndex.loadAttach(undefined, 100);
      const warmMs = performance.now() - warmStart;
      assert.equal(realConnection.historyReadWork?.sourceBytes, 0, 'real warm open reads no native records');
      const latencies: number[] = [];
      let cursor = attached.olderCursor;
      let pages = 0;
      while (cursor) {
        const began = performance.now();
        const page = await warmIndex.loadPage(cursor, 100);
        assert('messages' in page && !page.gap);
        latencies.push(performance.now() - began); cursor = page.cursor; pages += 1;
      }
      latencies.sort((a, b) => a - b);
      console.log(JSON.stringify({ pass: 'authorized real transcript', rows: snapshot.count, pages,
        coldMs: Math.round(coldMs), warmMs: Math.round(warmMs),
        pageP95Ms: Math.round(latencies[Math.floor(latencies.length * .95)] ?? 0),
        nativeRecordsOnWarmOpen: realConnection.historyReadWork?.sourceRecords,
      }));
    } finally { await realConnection.close(); }
  }
} finally {
  if (previousHome === undefined) delete process.env.COSYNCING_HOME; else process.env.COSYNCING_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
