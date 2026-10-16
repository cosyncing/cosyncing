import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@cosyncing/adapter-api';
import { ClaudeResumeConnection } from '../src/index.ts';

for (const existing of [true, false]) {
  test(`Drive completes after a stored-history attach (${existing ? 'existing' : 'new'} transcript)`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-stored-drive-'));
    const previousHome = process.env.COSYNCING_HOME;
    process.env.COSYNCING_HOME = root;
    const path = join(root, 'fixture.jsonl');
    if (existing) writeFileSync(path, [
      { type: 'user', uuid: 'old-user', timestamp: '2026-10-14T10:00:00Z', message: { content: 'old turn' } },
      { type: 'assistant', uuid: 'old-answer', timestamp: '2026-10-14T10:00:01Z', message: {
        id: 'old-answer', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const connection = new ClaudeResumeConnection(
      { configDir: root, projectsRoot: root, bin: 'unused', isDefault: true }, path,
      { id: 'fixture', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'resume' },
    );
    const frames: AgentMessage[] = [];
    const drive = connection as any;
    drive.handlers.add((message: AgentMessage) => frames.push(message));
    // Exercise the real send/result mapping without launching a model process.
    drive.proc = { stdin: { write: () => true, end: () => {} }, kill: () => {}, killed: false };
    connection.getHistory = async () => { throw new Error('full replay must not seed Drive'); };
    try {
      await connection.openHistorySnapshot();
      await connection.sendPrompt({ text: 'new turn' });
      const running = frames.find((message) => message.type === 'run-summary' && message.status === 'running');
      assert(running?.type === 'run-summary');
      await connection.openHistorySnapshot(); // A refresh must preserve the live turn.
      drive.handleEvent({ type: 'result', is_error: false, usage: { input_tokens: 7, output_tokens: 3 } });
      const done = frames.find((message) => message.type === 'run-summary' && message.status === 'done');
      assert(done?.type === 'run-summary');
      assert.equal(done.key, running.key);
      assert.equal(done.tokens?.output, 3);
      const totals = frames.findLast((message) => message.type === 'metadata-update' && message.key === 'runtimeTotals');
      assert(totals?.type === 'metadata-update');
      assert.equal((totals.value as { turnCount: number }).turnCount, existing ? 2 : 1);
    } finally {
      await connection.close();
      if (previousHome === undefined) delete process.env.COSYNCING_HOME;
      else process.env.COSYNCING_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('stored-history Drive updates tasks created before attach', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-stored-tasks-'));
  const previousHome = process.env.COSYNCING_HOME;
  process.env.COSYNCING_HOME = root;
  const path = join(root, 'fixture.jsonl');
  writeFileSync(path, [
    { type: 'assistant', uuid: 'create', message: { content: [{ type: 'tool_use', id: 'create', name: 'TaskCreate', input: { subject: 'Existing task' } }] } },
    { type: 'user', uuid: 'created', message: { content: [{ type: 'tool_result', tool_use_id: 'create', content: 'Task #9 created successfully: Existing task' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const connection = new ClaudeResumeConnection(
    { configDir: root, projectsRoot: root, bin: 'unused', isDefault: true }, path,
    { id: 'fixture', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'resume' },
  );
  const frames: AgentMessage[] = [];
  const drive = connection as any;
  drive.handlers.add((message: AgentMessage) => frames.push(message));
  try {
    await connection.openHistorySnapshot();
    drive.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'update', name: 'TaskUpdate', input: { taskId: '9', status: 'completed' } }] } });
    drive.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'update', content: 'Updated task #9 status' }] } });
    const state = frames.findLast((message) => message.type === 'task-list-state');
    assert(state?.type === 'task-list-state');
    assert.deepEqual(state.items, [{ id: '9', title: 'Existing task', status: 'done' }]);
    const snapshot = await connection.openHistorySnapshot();
    assert(snapshot);
    const read = await snapshot.reader.read(Array.from({ length: snapshot.count }, (_, i) => i));
    assert(read && !('refusal' in read));
    const original = read.messages.findLast((message) => message.type === 'task-list-state');
    assert(original?.type === 'task-list-state');
    assert.equal(original.items[0]?.status, 'open', 'live state must not mutate the persisted replay checkpoint');
  } finally {
    await connection.close();
    if (previousHome === undefined) delete process.env.COSYNCING_HOME;
    else process.env.COSYNCING_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
