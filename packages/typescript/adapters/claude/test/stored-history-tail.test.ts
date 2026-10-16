import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeObserveConnection } from '../src/index.ts';
import type { AgentMessage } from '@cosyncing/adapter-api';

test('stored history drains notifications received during indexing without another file event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-stored-tail-'));
  const previousHome = process.env.COSYNCING_HOME;
  process.env.COSYNCING_HOME = root;
  const path = join(root, 'fixture.jsonl');
  const row = (i: number) => JSON.stringify({ type: 'user', uuid: `user-${i}`, message: { content: `row ${i}` } }) + '\n';
  writeFileSync(path, row(0));
  const connection = new ClaudeObserveConnection(path, {
    id: 'fixture', title: 'fixture', tool: 'claude', status: 'idle', attachMode: 'observe',
  });
  // Control the file notifications and pause precisely after a prefix has been
  // captured; filesystem debounce timing cannot exercise this race reliably.
  const tail = connection as unknown as {
    drainTail(): void;
    storedTailFlight?: Promise<void>;
    handlers: Set<(message: AgentMessage) => void>;
  };
  let release: (() => void) | undefined;
  try {
    await connection.openHistorySnapshot();
    const seen: string[] = [];
    tail.handlers.add((message) => { if (message.type === 'user-message') seen.push(message.text); });
    const open = connection.openHistorySnapshot.bind(connection);
    let entered!: () => void;
    const captured = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    connection.openHistorySnapshot = async () => {
      const snapshot = await open();
      if (first) { first = false; entered(); await paused; }
      return snapshot;
    };
    appendFileSync(path, row(1));
    tail.drainTail();
    await captured;
    appendFileSync(path, row(2));
    tail.drainTail();
    tail.drainTail(); // Multiple notifications must coalesce, not duplicate rows.
    release!();
    await tail.storedTailFlight;
    assert.deepEqual(seen, ['row 1', 'row 2']);
  } finally {
    release?.();
    await connection.close();
    if (previousHome === undefined) delete process.env.COSYNCING_HOME;
    else process.env.COSYNCING_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
