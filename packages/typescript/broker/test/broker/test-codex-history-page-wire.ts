#!/usr/bin/env bun
/**
 * H1b production wiring for a Codex rollout whose normalized history exceeds
 * the former 32 MiB cache entry.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const MESSAGE_COUNT = 20_600;
const DURABLE_MESSAGE_COUNT = MESSAGE_COUNT + 1;
const PAGE_MESSAGES = 100;
const WAIT_MS = 20_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

type RunningBroker = {
  child: ReturnType<typeof Bun.spawn>;
  wsBase: string;
  stderr: () => string;
};

async function startBroker(home: string, codexHome: string): Promise<RunningBroker> {
  const port = await freePort();
  let stderr = '';
  const child = Bun.spawn(
    ['bun', 'run', 'packages/typescript/broker/src/main.ts'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        CODEX_HOME: codexHome,
        COSYNCING_HOME: home,
        COSYNCING_TOKEN: '',
        COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
        COSYNCING_TEST_HISTORY_READ_METRICS: '1',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  void (async () => {
    const reader = child.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
  })();
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/health`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, 'broker health');
  return {
    child,
    wsBase: base.replace(/^http/, 'ws'),
    stderr: () => stderr,
  };
}

type SocketClient = {
  ws: WebSocket;
  frames: any[];
  attach: any;
};

async function openClient(
  wsBase: string,
  id: string,
): Promise<SocketClient> {
  const frames: any[] = [];
  const params = new URLSearchParams({
    artifactMode: 'reference',
    contractRevision: '6',
    minimumBrokerRevision: '2',
    initialHistory: `${PAGE_MESSAGES}`,
  });
  const ws = new WebSocket(
    `${wsBase}/api/sessions/codex/${encodeURIComponent(id)}/stream?${params}`,
  );
  ws.onmessage = (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      // The timeout below reports a malformed/missing production frame.
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  const attach = await waitFor(
    () => frames.find((frame) => frame.kind === 'history'),
    'Codex initial history',
  );
  return { ws, frames, attach };
}

async function requestPage(
  client: SocketClient,
  cursor: string,
  requestId: string,
): Promise<any> {
  client.ws.send(JSON.stringify({
    kind: 'history-page',
    cursor,
    limit: PAGE_MESSAGES,
    clientMessageId: requestId,
  }));
  return waitFor(
    () => client.frames.find((frame) =>
      frame.clientMessageId === requestId
      && (frame.kind === 'history-page' || frame.kind === 'nack')),
    `history page ${requestId}`,
  );
}

function historyReads(broker: RunningBroker): string[] {
  return broker.stderr().split('\n')
    .filter((line) => line.includes('[h1-history-read]'));
}

const root = mkdtempSync('/tmp/cosyncing-h1b-codex-wire-');
const home = join(root, 'broker-home');
const codexHome = join(root, 'codex-home');
const day = join(codexHome, 'sessions', '2026', '07', '28');
mkdirSync(day, { recursive: true });
const rollout = join(
  day,
  'rollout-2026-07-28T00-00-00-00000000-0000-4000-8000-000000000001.jsonl',
);
const fd = openSync(rollout, 'w');
try {
  writeSync(fd, `${JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '00000000-0000-4000-8000-000000000001',
      cwd: '/tmp',
    },
  })}\n`);
  // An old state projection must share the requested 100-entry frame with the
  // contiguous newest tail. Before H1b R1 the broker appended this after the
  // 100 rows, producing 101 entries and leaving the client's front trim
  // disconnected from its opaque older cursor.
  writeSync(fd, `${JSON.stringify({
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'update_plan',
      call_id: 'old-plan',
      arguments: JSON.stringify({
        plan: [{
          step: 'Keep every older row reachable',
          status: 'in_progress',
        }],
      }),
    },
  })}\n`);
  for (let base = 0; base < MESSAGE_COUNT; base += 400) {
    const rows: string[] = [];
    for (
      let index = base;
      index < Math.min(base + 400, MESSAGE_COUNT);
      index += 1
    ) {
      rows.push(JSON.stringify({
        timestamp: '2026-07-28T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `wire large row ${index} ${'x'.repeat(1_700)}`,
        },
      }));
    }
    writeSync(fd, `${rows.join('\n')}\n`);
  }
} finally {
  closeSync(fd);
}
assert(statSync(rollout).size > 32 * 1024 * 1024);

const broker = await startBroker(home, codexHome);
const clients: WebSocket[] = [];
try {
  const id = Buffer.from(rollout, 'utf8').toString('base64url');
  const first = await openClient(broker.wsBase, id);
  clients.push(first.ws);
  assert.equal(first.attach.messages.length, PAGE_MESSAGES);
  assert.equal(first.attach.truncated?.total, DURABLE_MESSAGE_COUNT);
  assert(
    first.attach.messages.some((message: any) =>
      message?.type === 'task-list-state' && message?.key === 'codex:plan'),
    'bounded production attach must retain the old current-state projection',
  );
  assert(first.attach.olderCursor);
  assert.equal(
    historyReads(broker).filter((line) => line.includes(' attach ')).length,
    0,
    'bounded initial attach must not call full getHistory()',
  );
  assert.equal(historyReads(broker).length, 1);

  let cursor = String(first.attach.olderCursor);
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = await requestPage(first, cursor, `page-${pageIndex}`);
    assert.equal(page.kind, 'history-page');
    assert.equal(page.messages.length, PAGE_MESSAGES);
    assert(page.hasMore && page.cursor);
    cursor = String(page.cursor);
  }
  assert.equal(
    historyReads(broker).length,
    1,
    'page requests must reuse the compact native index',
  );

  appendFileSync(
    rollout,
    `${JSON.stringify({
      timestamp: '2026-07-28T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'active append' },
    })}\n`,
  );
  const afterAppend = await requestPage(
    first,
    cursor,
    'same-socket-after-append',
  );
  assert.equal(afterAppend.kind, 'history-page');
  assert.equal(
    historyReads(broker).length,
    1,
    'an active append must keep the same socket/index usable',
  );

  const newer = await openClient(broker.wsBase, id);
  clients.push(newer.ws);
  assert.equal(newer.attach.truncated?.total, DURABLE_MESSAGE_COUNT + 1);
  assert.equal(
    historyReads(broker).length,
    2,
    'one exact append upgrade must build one newer compact index',
  );

  console.log(JSON.stringify({
    sourceBytes: statSync(rollout).size,
    attachMessages: first.attach.messages.length,
    totalMessages: first.attach.truncated.total,
    pagesChecked: 4,
    nativeIndexBuilds: historyReads(broker).length,
  }));
  console.log('PASS H1b Codex >32 MiB production paging wire');
} finally {
  for (const ws of clients) ws.close();
  broker.child.kill();
  await broker.child.exited.catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
