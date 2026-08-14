#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionConnection } from '../../../adapter-api/src/index.ts';
import { ManagedConn } from '../../src/sessions/hub.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-observe-readonly-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const connection: SessionConnection = {
  info: {
    id: 'observe-session',
    tool: 'fake',
    title: 'Observe',
    cwd: workspace,
    status: 'idle',
    attachMode: 'observe',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  },
  async getHistory() { return []; },
  subscribe() { return () => undefined; },
  async sendPrompt() { throw new Error('read-only'); },
  async respondPermission() { throw new Error('read-only'); },
  async close() {},
};

const managed = new ManagedConn(connection);
const events: any[] = [];
managed.addClient((event) => events.push(event));
try {
  await Bun.sleep(100);
  assert.equal(existsSync(join(workspace, '.cosyncing')), false,
    'opening Observe must not create .cosyncing or outbox');

  const outbox = join(workspace, '.cosyncing', 'outbox');
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, 'report.txt'), 'created by the producer');
  const deadline = Date.now() + 4_000;
  while (!events.some((event) => event.kind === 'message' && event.message?.type === 'file-artifact') && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  assert(events.some((event) => event.kind === 'message' && event.message?.name === 'report.txt'),
    'the read-only watcher must discover an outbox later created by the producer');
} finally {
  await managed.dispose();
  rmSync(root, { recursive: true, force: true });
}

console.log('PASS Observe attach is workspace-read-only and late producer outbox remains observable');
