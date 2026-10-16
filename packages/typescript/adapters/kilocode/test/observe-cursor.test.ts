import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { FSWatcher, watch } from 'node:fs';
import type { AgentMessage } from '@cosyncing/adapter-api';
import { KiloObserveConnection } from '../src/observe.ts';
import { discoverKiloStore } from '../src/store.ts';
import { appendKiloTurn, buildKiloFixtureTree } from './fixtures/database.ts';

for (const read of ['history', 'capture'] as const) {
  test(`${read} read by another client cannot consume an undelivered live append`, async () => {
    const tree = buildKiloFixtureTree();
    const session = (await discoverKiloStore({ env: { KILO_DATA_DIR: tree.dataRoot } }))[0]!;
    let changed: (() => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close() {} });
    const connection = new KiloObserveConnection({
      session,
      info: { id: session.id, nativeId: session.nativeId, tool: 'kilo', title: session.title, cwd: session.cwd, status: session.status, attachMode: 'observe' },
      watchFactory: ((_path: string, _options: unknown, callback: (event: string, filename: string) => void) => {
        changed = () => callback!('change', 'kilo.db-wal');
        return watcher as FSWatcher;
      }) as typeof watch,
    });
    try {
      await connection.getHistory();
      const messages: AgentMessage[] = [];
      connection.subscribe(message => messages.push(message));
      const writer = appendKiloTurn(tree.databasePath);
      writer.close();
      if (read === 'history') await connection.getHistory();
      else await connection.captureHistorySnapshot({ accept: () => true });
      changed!();
      const deadline = Date.now() + 1500;
      while (!messages.some(message => message.type === 'user-message' && message.text === 'tail prompt') && Date.now() < deadline) await Bun.sleep(10);
      expect(messages.filter(message => message.type === 'user-message' && message.text === 'tail prompt')).toHaveLength(1);
    } finally { await connection.close(); tree.cleanup(); }
  });
}
