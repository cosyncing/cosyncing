#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../../../adapter-api/src/index.ts';

/** The daemon process `startDaemonChild` runs for the crashed-daemon cases at the end of this file. */
const DAEMON_CHILD_SOURCE = String.raw`
const { createServer } = require('node:net');
const { createHash } = require('node:crypto');
const { appendFileSync, existsSync } = require('node:fs');
const [socketPath, loadedJson] = process.argv.slice(-2);
const loaded = JSON.parse(loadedJson);
const frame = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
};
createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let open = false;
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!open) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /Sec-WebSocket-Key:\s*(.+)/i.exec(buffer.subarray(0, end).toString())?.[1]?.trim();
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      open = true;
      buffer = buffer.subarray(end + 4);
    }
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      const mask = buffer[1] & 0x80 ? buffer.subarray(offset, offset + 4) : undefined;
      if (mask) offset += 4;
      if (buffer.length < offset + length) return;
      const opcode = buffer[0] & 0x0f;
      const raw = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let index = 0; index < raw.length; index += 1) raw[index] ^= mask[index % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) return socket.destroy();
      if (opcode !== 0x1) continue;
      const message = JSON.parse(raw.toString());
      appendFileSync(socketPath + '.log', String(message.method ?? 'reply') + '\n');
      if (message.id === undefined || existsSync(socketPath + '.silent')) continue;
      const result = message.method === 'initialize' ? { userAgent: 'codex-fake/0.0.0' }
        : message.method === 'thread/loaded/list' ? { data: loaded, nextCursor: null }
        : message.method === 'thread/read' ? { thread: { id: message.params.threadId, status: { type: 'idle' } } }
        : undefined;
      socket.write(frame(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'unsupported' } }));
    }
  });
}).listen(socketPath, () => console.log('listening'));
`;

const NO_TERMINALS = async () => ({
  attributed: new Set<string>(),
  unattributed: [],
  privateThreadIds: new Set<string>(),
  privateUnattributed: [],
  unknownUnattributed: [],
  unknownThreadIds: new Set<string>(),
  candidates: [],
  socketDiagAvailable: true,
  processScanAvailable: true,
});

const offersJoin = (info: SessionInfo | undefined): boolean =>
  !!info?.terminalSyncHint?.command?.includes('codex resume --remote unix://') && info.control?.terminalSync.syncAvailable === true;
const joinWithdrawn = (info: SessionInfo | undefined): boolean =>
  info?.terminalSyncHint?.command === '' && info.control?.terminalSync.syncAvailable === false;

const home = mkdtempSync(join(tmpdir(), 'cosyncing-codex-loaded-unknown-'));
const previous = {
  home: process.env.CODEX_HOME,
  sync: process.env.COSYNCING_CODEX_SYNC_SERVER,
  interval: process.env.COSYNCING_CODEX_SYNC_WATCH_MS,
  grace: process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS,
  sock: process.env.COSYNCING_CODEX_APP_SERVER_SOCK,
  bin: process.env.COSYNCING_CODEX_BIN,
};
// A row no daemon holds is `observing` only where a Codex CLI resolves (Drive can resume it);
// without one it is `unavailable`. Pin a CLI this test owns so the expected drive state never
// depends on the host's PATH: a hosted runner has no `codex`, a developer box does. Only its
// existence is ever checked here; it exits non-zero if anything runs it.
const fakeCodexBin = join(home, 'bin', 'codex');
mkdirSync(join(home, 'bin'));
writeFileSync(fakeCodexBin, '#!/bin/sh\nexit 1\n');
chmodSync(fakeCodexBin, 0o755);
process.env.COSYNCING_CODEX_BIN = fakeCodexBin;
process.env.CODEX_HOME = home;
process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
process.env.COSYNCING_CODEX_SYNC_WATCH_MS = '250';
process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = '1';
// Without a sock the watcher's readScan never consults the injected scanner and presence reads as
// scans-unavailable 'unknown' — a possible owner, which round 4 makes a retirement gate.
process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(home, 'absent.sock');

try {
  const threadId = '019f-test-loaded-thread';
  const dir = join(home, 'sessions', '2026', '07', '11');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-07-11T00-00-00-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: '2026-07-11T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd: '/tmp/cosyncing-codex-watch' },
  })}\n${JSON.stringify({
    timestamp: '2026-07-11T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'native-watch-turn' },
  })}\n`);

  let mode: 'loaded' | 'failure' | 'empty' = 'loaded';
  let nativeActivity: 'working' | 'idle' = 'working';
  // Every probe the watcher makes is counted, so each phase waits on the watcher's own progress
  // (a number of further polls in that mode) instead of a fixed sleep that a loaded box can outrun.
  const probes = { loaded: 0, failure: 0, empty: 0 };
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; probes=${JSON.stringify(probes)} changes=${changes.length}`);
      await Bun.sleep(10);
    }
  };
  const { CodexAdapter } = await import('../src/index.ts');
  const adapter = new CodexAdapter({
    queryLoadedThreadIds: async () => {
      probes[mode] += 1;
      if (mode === 'failure') throw new Error('daemon transport failed');
      return mode === 'loaded' ? new Set([threadId]) : new Set();
    },
    queryLoadedThreadActivities: async () => [{ id: threadId, status: nativeActivity }],
    // R0c.4 round 4: native Idle retires an open turn only with proven OWNER absence, so the
    // no-terminal half of that rule must be explicit — without this the suite consults the real
    // host process scan, and a developer's own codex TUIs make the downgrade nondeterministic.
    scanCodexTuiPresence: async () => ({
      attributed: new Set<string>(),
      unattributed: [],
      privateThreadIds: new Set<string>(),
      privateUnattributed: [],
      unknownUnattributed: [],
      unknownThreadIds: new Set<string>(),
      candidates: [],
      socketDiagAvailable: true,
      processScanAvailable: true,
    }),
  });
  const changes: SessionInfo[] = [];
  const stop = adapter.watchSessionInfo((info) => changes.push(info));
  await waitFor(() => changes.length >= 1, 'the first-poll publication (authoritative loaded state)');
  // R0c.4: the first poll PUBLISHES the state it derived. That seed row is the loaded/Working
  // baseline this test then perturbs, so consume it and keep asserting on later publications only.
  assert.equal(changes.length, 1, 'the first poll publishes the derived loaded row');
  assert.equal(changes[0]?.status, 'working', 'the first-poll seed carries the exact native Working');
  changes.length = 0;

  mode = 'failure';
  // Several failed probes, beyond the one-poll drop grace.
  await waitFor(() => probes.failure >= 3, 'several failed probes');

  mode = 'empty';
  nativeActivity = 'idle';
  // The authoritative empty list is the sentinel: it must publish, and only it may have published
  // since the failed probes (they would otherwise have added their own rows before it).
  await waitFor(() => changes.length >= 1, 'the downgrade publication');
  const downgradedAt = probes.empty;
  await waitFor(() => probes.empty >= downgradedAt + 2, 'two further empty polls');
  assert.equal(changes.length, 1, 'probe errors remain unknown and never synthesize an empty loaded list; an authoritative empty loaded list still publishes the real downgrade exactly once');
  assert.equal(changes[0]?.control?.terminalSync.active, false);
  assert.equal(changes[0]?.status, 'idle', 'point-in-time native Idle retires the sticky rollout start');
  stop();
  console.log('PASS: Codex loaded-list probe failure is unknown; authoritative empty still downgrades');

  // ---------------------------------------------------------------- a daemon that crashed
  // The exception to "a failed probe is unknown": proof that nothing listens at the daemon socket. A
  // crashed daemon leaves its socket file behind; the threads it held went with it. Proof needs the
  // kernel's socket table (`/proc/net/unix`), so this half runs on Linux only.
  if (process.platform === 'linux') {
    await crashedDaemonCases(home, waitFor);
  } else {
    console.log('SKIP: dead-daemon proof needs /proc/net/unix (Linux)');
  }
} finally {
  if (previous.home == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
  if (previous.sync == null) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = previous.sync;
  if (previous.interval == null) delete process.env.COSYNCING_CODEX_SYNC_WATCH_MS; else process.env.COSYNCING_CODEX_SYNC_WATCH_MS = previous.interval;
  if (previous.grace == null) delete process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS; else process.env.COSYNCING_CODEX_SYNC_DROP_GRACE_POLLS = previous.grace;
  if (previous.sock == null) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK; else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = previous.sock;
  if (previous.bin == null) delete process.env.COSYNCING_CODEX_BIN; else process.env.COSYNCING_CODEX_BIN = previous.bin;
  rmSync(home, { recursive: true, force: true });
}

type DaemonChild = { socket: string; process: Bun.Subprocess; log(): string[] };

/** A Codex daemon this test starts in its own process: it answers `thread/loaded/list` with `loaded` and
 *  every `thread/read` as idle, logs each request method, and goes silent while `<socket>.silent` exists. */
async function startDaemonChild(home: string, socket: string, loaded: string[]): Promise<DaemonChild> {
  const script = join(home, 'daemon-child.cjs');
  if (!existsSync(script)) writeFileSync(script, DAEMON_CHILD_SOURCE);
  const child = Bun.spawn([process.execPath, script, socket, JSON.stringify(loaded)], { stdout: 'pipe', stderr: 'inherit' });
  const reader = child.stdout.getReader();
  let output = '';
  while (!output.includes('listening')) {
    const next = await reader.read();
    if (next.done) throw new Error(`the daemon child exited before listening on ${socket}`);
    output += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  return {
    socket,
    process: child,
    log: () => (existsSync(`${socket}.log`) ? readFileSync(`${socket}.log`, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** Kill it outright, as a crash would: nothing gets to remove its socket file. */
async function crash(daemon: DaemonChild): Promise<void> {
  daemon.process.kill('SIGKILL');
  await daemon.process.exited;
  assert.equal(lstatSync(daemon.socket).isSocket(), true, 'the crash left the socket file behind');
}

function writeRollout(home: string, threadId: string): void {
  const dir = join(home, 'sessions', '2026', '07', '12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-07-12T00-00-00-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: '2026-07-12T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd: '/tmp/cosyncing-codex-watch' },
  })}\n`);
}

async function crashedDaemonCases(
  home: string,
  waitFor: (predicate: () => boolean, label: string, timeoutMs?: number) => Promise<void>,
): Promise<void> {
  const { CodexAdapter, codexAppServerLiveSocketFingerprint, codexAppServerSocketFingerprint } = await import('../src/index.ts');
  const children: DaemonChild[] = [];
  try {
    // 1. A daemon holding a thread goes silent, then crashes. Real loaded-thread reads, no seams.
    const held = '019f-test-held-by-daemon';
    writeRollout(home, held);
    const daemon = await startDaemonChild(home, join(home, 'held.sock'), [held]);
    children.push(daemon);
    process.env.COSYNCING_CODEX_APP_SERVER_SOCK = daemon.socket;
    const changes: SessionInfo[] = [];
    const adapter = new CodexAdapter({ scanCodexTuiPresence: NO_TERMINALS, daemonProbeTimeoutMs: 300 });
    let stop = adapter.watchSessionInfo((info) => changes.push(info));
    const latest = (threadId: string) => changes.findLast((info) => info.nativeId === threadId);
    await waitFor(() => latest(held) !== undefined, 'the first publication of the daemon-held thread');
    assert.equal(latest(held)?.control?.drive.state, 'driving', 'a daemon-held thread with no terminal is driven');
    assert.equal(offersJoin(latest(held)), true, 'a live daemon offers the terminal join');
    const liveFingerprint = codexAppServerSocketFingerprint(daemon.socket);
    assert.ok(liveFingerprint);
    assert.deepEqual(await codexAppServerLiveSocketFingerprint(daemon.socket), liveFingerprint,
      'a listening daemon\'s socket is ownership evidence for uninstall');
    changes.length = 0;

    // Silent: it still listens, so it proves nothing, and the last-known loaded set stands.
    writeFileSync(`${daemon.socket}.silent`, '');
    const silentFrom = daemon.log().filter((method) => method === 'initialize').length;
    await waitFor(() => daemon.log().filter((method) => method === 'initialize').length >= silentFrom + 4, 'several unanswered polls');
    assert.equal(changes.length, 0, 'a daemon that listens but does not answer is unknown: nothing is published');

    await crash(daemon);
    await waitFor(() => latest(held)?.control?.drive.state === 'observing', 'the crashed daemon\'s thread to be dropped');
    assert.equal(joinWithdrawn(latest(held)), true, 'nothing listens at the socket: no join is offered for it');
    assert.match(latest(held)?.terminalSyncHint?.note ?? '', /daemon is not running or reachable/);
    assert.equal(lstatSync(daemon.socket).isSocket(), true, 'the socket is only read, never removed');
    assert.deepEqual(codexAppServerSocketFingerprint(daemon.socket), liveFingerprint, 'the same file is still there');
    assert.equal(await codexAppServerLiveSocketFingerprint(daemon.socket), undefined,
      'the file a crashed daemon left proves no live instance, so uninstall can never claim one from it');
    stop();

    // 2. A daemon holding nothing crashes. No loaded set changes, yet every join offer it backed goes.
    const idle = '019f-test-never-loaded';
    writeRollout(home, idle);
    const empty = await startDaemonChild(home, join(home, 'empty.sock'), []);
    children.push(empty);
    process.env.COSYNCING_CODEX_APP_SERVER_SOCK = empty.socket;
    changes.length = 0;
    const second = new CodexAdapter({ scanCodexTuiPresence: NO_TERMINALS, daemonProbeTimeoutMs: 300 });
    stop = second.watchSessionInfo((info) => changes.push(info));
    // The second poll's reads mean the first poll (which only records, publishing nothing) finished.
    await waitFor(() => empty.log().filter((method) => method === 'thread/loaded/list').length >= 4, 'two answered polls');
    assert.equal(changes.length, 0, 'nothing loaded: the first poll publishes nothing');
    await crash(empty);
    await waitFor(() => joinWithdrawn(latest(idle)), 'the join offer to be withdrawn for a thread the daemon never held');
    assert.equal(latest(idle)?.control?.drive.state, 'observing');
    stop();
    console.log('PASS: a crashed daemon\'s stale socket drops its loaded threads and withdraws the join; a silent one is unknown');
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill('SIGKILL');
      await child.process.exited;
    }
  }
}
