import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlHistorySource } from '../src/history-source.ts';
import { ClaudeObserveConnection, mapTranscript, ClaudeRuntimeTracker } from '../src/implementation.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-claude-history-source-'));
const path = join(root, 'fixture.jsonl');
const parse = (raw: string) => { try { return JSON.parse(raw); } catch { return null; } };
const row = (i: number) => ({ type: 'assistant', uuid: `u${i}`, message: {
  id: `m${i}`, content: [{ type: 'text', text: `text ${i} 😀 ${'x'.repeat(4000)}` }],
} });
const source = new JsonlHistorySource();
try {
  const initial = Array.from({ length: 1024 }, (_, i) => row(i));
  writeFileSync(path, initial.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const first = await source.read(path, parse);
  assert.deepEqual(first.lines, initial);
  assert.equal(source.lastRead.reusedRecords, 0);
  assert.deepEqual((await source.read(path, parse)).lines, initial);
  assert(source.lastRead.bytes <= 8192, 'unchanged source reads only bounded guards');
  assert.equal(source.lastRead.records, 0, 'unchanged source must not be reparsed');
  appendFileSync(path, JSON.stringify(row(1024)) + '\n');
  assert.deepEqual((await source.read(path, parse)).lines, [...initial, row(1024)]);
  assert.equal(source.lastRead.records, 1, 'only the appended row should be parsed');
  assert(source.lastRead.bytes < 16_384, 'append must read only the suffix and bounded guards');

  appendFileSync(path, '{"text":"partial');
  assert.equal((await source.read(path, parse)).lines.length, 1025);
  appendFileSync(path, ' 😀"}\n');
  assert.deepEqual((await source.read(path, parse)).lines.at(-1), { text: 'partial 😀' });
  writeFileSync(path, '{"text":"rewrite"}\n');
  assert.deepEqual((await source.read(path, parse)).lines, [{ text: 'rewrite' }]);
  assert.equal(source.lastRead.reusedRecords, 0);
  writeFileSync(path, '{"text":"revised"}\n');
  assert.deepEqual((await source.read(path, parse)).lines, [{ text: 'revised' }], 'same-size rewrites invalidate');
  const replacement = join(root, 'replacement');
  writeFileSync(replacement, '{"text":"new inode"}\n');
  renameSync(replacement, path);
  assert.deepEqual((await source.read(path, parse)).lines, [{ text: 'new inode' }]);
  writeFileSync(path, '{"text":"changed prefix"}\n' + initial.map((record) => JSON.stringify(record)).join('\n') + '\n');
  assert.equal((await source.read(path, parse)).lines[0].text, 'changed prefix');
  assert.equal(source.lastRead.reusedRecords, 0, 'growing rewrites with a changed prefix invalidate');

  // Replay still uses the FULL mapper state, including a late call definition
  // which changes the rendering of an earlier result. Caching normalized rows
  // instead of native records would return stale enrichment here.
  const records: any[] = [
    { type: 'user', uuid: 'prompt', timestamp: '2026-01-01T00:00:00Z', message: { content: 'work' } },
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] } },
  ];
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const conn = new ClaudeObserveConnection(path, { id: 'fixture', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'observe', currentMode: 'default' });
  try {
    assert.deepEqual(await conn.getHistory(), mapTranscript(records, new ClaudeRuntimeTracker('fixture', 'claude-transcript')));
    records.push({ type: 'assistant', uuid: 'call-row', message: { id: 'call-message', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/fixture/example.txt' } }] } });
    appendFileSync(path, JSON.stringify(records.at(-1)) + '\n');
    const [a, b] = await Promise.all([conn.getHistory(), conn.getHistory()]);
    assert.deepEqual(a, b, 'concurrent attaches coalesce');
    assert.deepEqual(a, mapTranscript(records, new ClaudeRuntimeTracker('fixture', 'claude-transcript')));
  } finally { await conn.close(); }
  // Long transcripts contain many hidden progress records. Keep this workload
  // cacheable while retaining the independent byte and record ceilings.
  writeFileSync(path, Array.from({ length: 52_050 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n');
  assert.equal((await source.read(path, parse)).lines.length, 52_050);
  await source.read(path, parse);
  assert.equal(source.lastRead.records, 0, 'long native-record histories remain cacheable');
  assert.equal(source.lastRead.reusedRecords, 52_050);
  writeFileSync(path, Array.from({ length: 100_001 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n');
  await source.read(path, parse);
  await source.read(path, parse);
  assert.equal(source.lastRead.reusedRecords, 0, 'the record ceiling still bounds retention');
  console.log('PASS Claude cached source: unchanged, append, partial UTF-8, shrink, rewrite, replacement, full mapper parity, concurrent reads, long-record retention bound');
} finally {
  source.close();
  rmSync(root, { recursive: true, force: true });
}
