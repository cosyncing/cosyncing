/** Standalone route acceptance; deliberately not registered with the CI runner. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedBrokerFixtureEnvironment, reserveLoopbackFixturePort } from '../helpers/isolated-broker-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-claude-history-wire-'));
const environment = isolatedBrokerFixtureEnvironment(root, {
  overrides: { HOST: '127.0.0.1', COSYNCING_TOKEN: '', COSYNCING_TEST_EXIT_ON_STDIN_EOF: '1' },
});
const project = join(environment.CLAUDE_CONFIG_DIR!, 'projects', '-fixture');
mkdirSync(project, { recursive: true });
const path = join(project, '00000000-0000-4000-8000-000000000001.jsonl');
const id = Buffer.from(path).toString('base64url');
const row = (i: number) => JSON.stringify({ type: 'user', uuid: `u-${i}`, timestamp: '2026-10-14T10:00:00Z',
  message: { role: 'user', content: `row ${i} ${'x'.repeat(2100)}` } }) + '\n';
writeFileSync(path, Array.from({ length: 18_000 }, (_, i) => row(i)).join(''));
let child: ReturnType<typeof Bun.spawn> | undefined;
let diagnostics = '';
const sockets: WebSocket[] = [];

async function deadline<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out\n${diagnostics}`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

async function start(): Promise<string> {
  const lease = await reserveLoopbackFixturePort();
  await lease.release();
  diagnostics = '';
  child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...environment, PORT: String(lease.port) }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const spawned = child;
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => { ready = resolve; });
  // Readiness follows the child’s actual listening event; no health/status polling.
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    let line = '';
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      diagnostics = (diagnostics + text).slice(-4000);
      line = (line + text).slice(-4000);
      if (line.includes(`broker on http://127.0.0.1:${lease.port}`)) ready();
    }
  };
  void drain(spawned.stdout as ReadableStream<Uint8Array>);
  void drain(spawned.stderr as ReadableStream<Uint8Array>);
  await deadline(Promise.race([listening, spawned.exited.then((code) => {
    throw new Error(`fixture broker exited ${code}\n${diagnostics}`);
  })]), 'fixture startup');
  return `ws://127.0.0.1:${lease.port}`;
}

async function open(base: string) {
  const ws = new WebSocket(`${base}/api/sessions/claude/${id}/stream?mode=observe&initialHistory=100&artifactMode=reference&contractRevision=28&minimumBrokerRevision=2`);
  sockets.push(ws);
  const frames: any[] = [];
  const listeners = new Set<() => void>();
  ws.onmessage = (event) => { frames.push(JSON.parse(String(event.data))); for (const notify of listeners) notify(); };
  const wait = async (predicate: (frame: any) => boolean) => {
    let notify!: () => void;
    try {
      return await deadline(new Promise<any>((resolve) => {
        notify = () => { const found = frames.find(predicate); if (found) resolve(found); };
        listeners.add(notify); notify();
      }), 'socket answer');
    } finally { listeners.delete(notify); }
  };
  await deadline(new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve(); ws.onerror = () => reject(new Error(`socket failed\n${diagnostics}`));
  }), 'socket open');
  const attached = await wait((frame) => frame.kind === 'history' || frame.kind === 'nack' || frame.kind === 'error');
  assert.equal(attached.kind, 'history', JSON.stringify(attached));
  let sequence = 0;
  const request = async (fields: Record<string, unknown>) => {
    const clientMessageId = `request-${++sequence}`;
    const answer = wait((frame) => frame.clientMessageId === clientMessageId && ['history', 'history-page', 'nack'].includes(frame.kind));
    ws.send(JSON.stringify({ ...fields, clientMessageId }));
    return answer;
  };
  return { ws, attached, request };
}

try {
  let base = await start();
  const first = await open(base);
  assert(first.attached.hasEarlier && first.attached.olderCursor && first.attached.endCursor);
  assert(first.attached.truncated.total > 50_000);
  const before = await first.request({ kind: 'history-page', cursor: first.attached.olderCursor, limit: 100 });
  assert.equal(before.kind, 'history-page');
  assert(before.messages.length > 0 && !before.gap);
  appendFileSync(path, row(18_000));
  const refresh = await first.request({ kind: 'history-refresh', cursor: first.attached.cursor });
  assert.equal(refresh.kind, 'history');
  assert(refresh.messages.some((message: any) => message.type === 'user-message' && message.text.startsWith('row 18000 ')));
  const forward = await first.request({ kind: 'history-page', direction: 'newer', cursor: first.attached.endCursor, until: refresh.endCursor, limit: 100 });
  assert.equal(forward.kind, 'history-page');
  assert(!forward.gap && forward.messages.some((message: any) => message.type === 'user-message' && message.text.startsWith('row 18000 ')));
  const peer = await open(base);
  const old = await peer.request({ kind: 'history-page', cursor: first.attached.olderCursor, limit: 100 });
  assert.equal(old.kind, 'history-page'); assert.deepEqual(old.messages, before.messages);
  first.ws.close(); peer.ws.close();
  child!.kill(); await child!.exited;
  base = await start();
  const restarted = await open(base);
  const persisted = await restarted.request({ kind: 'history-page', cursor: first.attached.olderCursor, limit: 100 });
  assert.equal(persisted.kind, 'history-page'); assert.deepEqual(persisted.messages, before.messages);
  console.log('PASS Claude >32 MiB/>50k rows: wire attach, backward/newer pages, refresh, peer reconnect and broker restart');
} finally {
  for (const socket of sockets) socket.close();
  if (child) { child.kill(); await child.exited; }
  rmSync(root, { recursive: true, force: true });
}
