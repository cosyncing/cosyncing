import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBackgroundCommands, CodexBackgroundLedger, backgroundPage } from '../../../adapters/codex/src/background-commands.ts';
import { recoverBackgroundItems } from '../../../adapters/codex/src/background-history.ts';
import { CodexAdapter } from '../../../adapters/codex/src/index.ts';
import { ManagedConn } from '../../src/sessions/hub.ts';
import { canSendBackgroundMessage } from '../../src/sessions/background-compatibility.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';
import { historyDelta, isCursorDurableMessage } from '../../src/sessions/history-delta.ts';
import type { AgentMessage, SessionConnection } from '../../../adapter-api/src/index.ts';

// Shapes measured against real 0.142.5 and 0.155.1 app-servers. In particular,
// completion is after turn completion and its output omits the initial yield.
const row = (itemId = 'exec-success', processId = '12046') => ({ itemId, processId, command: 'python3 fixture.py', cwd: '/fixture', osPid: null, cpuPercent: null, rssKb: null });
const item = (itemId = 'exec-success', processId = '12046', exitCode?: number) => ({
  type: 'commandExecution', id: itemId, processId, source: 'unifiedExecStartup', command: 'python3 fixture.py', cwd: '/fixture',
  status: exitCode === undefined ? 'inProgress' : exitCode === 0 ? 'completed' : 'failed',
  exitCode: exitCode ?? null, aggregatedOutput: exitCode === undefined ? null : 'fixture-end\n', durationMs: exitCode === undefined ? null : 8000,
});
const page = (data: unknown[] = [], nextCursor: string | null = null) => ({ data, nextCursor });
const params = (value: unknown, turnId = 'turn') => ({ threadId: 'thread', turnId, item: value });
const nativeError = (code: number, message = 'unsupported') => Object.assign(new Error(message), { rpcCode: code });
let scopes = 0;

export async function testBackgroundLedger(): Promise<void> {
  assert.equal(backgroundPage(page([row()])).rows.length, 1);
  for (const bad of [{}, page([{}]), { data: [] }, page([row()], ''), page(Array(33).fill(row()))]) {
    assert.throws(() => backgroundPage(bad), /Invalid/);
  }
  const frames: any[] = [];
  const ledger = new CodexBackgroundLedger('runtime-a', (frame) => frames.push(frame));
  ledger.notification('item/started', { ...params(item()), startedAtMs: 1000 }, 1000);
  assert.equal(ledger.cards().length, 0, 'foreground start alone is not a background card');
  ledger.snapshot([row()], ledger.version(), 1100);
  assert.equal(ledger.cards()[0]?.status, 'running');
  const before = ledger.version();
  ledger.notification('item/completed', { ...params(item('exec-success', '12046', 7)), completedAtMs: 9000 }, 9001);
  ledger.snapshot([row()], before, 9002);
  assert.equal(ledger.cards()[0]?.status, 'error', 'late running snapshot cannot undo completion');
  assert.equal(ledger.cards()[0]?.exitCode, 7);
  assert.equal(ledger.cards()[0]?.output?.truncated, true, 'native aggregate is an available tail');
  const terminalFrames = frames.length;
  ledger.notification('item/completed', { ...params(item('exec-success', '12046', 0)), completedAtMs: 12000 }, 12000);
  assert.equal(frames.length, terminalFrames, 'duplicate completion cannot change the first exact outcome');
  ledger.notification('item/started', { ...params(item(), 'next-turn'), startedAtMs: 13000 }, 13000);
  ledger.notification('turn/completed', { threadId: 'thread', turn: { id: 'next-turn' } }, 14000);
  assert.notEqual(ledger.cards()[0]?.key, frames[0]?.key, 'proven reused identity gets a new generation');
  ledger.history(item('exec-success', '12046', 0), 14001, 'turn');
  assert.equal(ledger.cards()[0]?.status, 'running', 'historical old generation cannot complete the reused ID');
  ledger.snapshot([], ledger.version(), 15000);
  assert.equal(frames.at(-1).status, 'retired');
  assert.equal(frames.at(-1).exitCode, undefined);
  assert.equal(frames.at(-1).elapsedMs, undefined);

  const fallback = new CodexBackgroundLedger('no-list', (frame) => frames.push(frame));
  fallback.notification('item/started', params(item('call_older', '7')), 0);
  fallback.notification('turn/completed', { turn: { id: 'turn' } }, 1000);
  assert.equal(fallback.cards()[0]?.status, 'running');
  fallback.expire(31000);
  assert.equal(frames.at(-1).status, 'retired', 'notification-only evidence has a finite lease');
  const staleCandidate = new CodexBackgroundLedger('stale-candidate', (frame) => frames.push(frame));
  staleCandidate.notification('item/started', params(item()), 0);
  staleCandidate.notification('item/started', params(item()), 31000);
  staleCandidate.notification('turn/completed', { turn: { id: 'turn' } }, 31000);
  assert.equal(staleCandidate.cards().length, 0, 'replayed starts and turn completion cannot renew stale process evidence');

  const window = new CodexBackgroundLedger('window', (frame) => frames.push(frame));
  window.snapshot([row('long')], 0, 0);
  for (let i = 0; i < 12; i++) {
    window.snapshot([row('long'), row(`short-${i}`)], window.version(), i + 1);
    window.notification('item/completed', { ...params(item(`short-${i}`, '12046', 0)), completedAtMs: i + 100 }, i + 100);
  }
  window.notification('item/completed', { ...params(item('long', '12046', 7)), completedAtMs: 1000 }, 1000);
  assert.equal(frames.at(-1).exitCode, 7, 'long command completion delivered before result windowing');
  assert.equal(window.cards().length, 8);
  assert.ok(window.cards().some((card) => card.key.includes('long')));
  window.snapshot([row('unicode')], window.version(), 1100);
  window.notification('item/commandExecution/outputDelta', { itemId: 'unicode', delta: '你'.repeat(9000) }, 1200);
  const output = window.cards().find((card) => card.key.includes('unicode'))?.output;
  assert.ok(output && Buffer.byteLength(output.text) <= 4096 && output.truncated);
  assert.ok(!output.text.includes('\ufffd'));
}

export async function testBackgroundReconciliation(): Promise<void> {
  let now = 1000;
  let list: (p: any) => any = () => page([row()]);
  let history: () => any = () => page();
  const calls: string[] = [];
  const frames: any[] = [];
  const rpc = async (method: string, p: any) => {
    calls.push(method);
    if (method === 'thread/backgroundTerminals/list') return list(p);
    assert.equal(method, 'thread/items/list', 'observer must not call controls, load threads, or start a runtime');
    return history();
  };
  const scope = `recovery-${++scopes}`;
  const observer = new CodexBackgroundCommands('thread', scope, rpc, (frame) => frames.push(frame), () => now);
  await observer.reconcile();
  assert.equal(calls.length, 0, 'no attached product client means no observation RPC');
  observer.setClientCount(1);
  await observer.reconcile();
  assert.equal(frames.at(-1).status, 'running');
  const key = frames.at(-1).key;
  const emitted = frames.length;
  await observer.reconcile();
  assert.equal(frames.length, emitted, 'unchanged snapshots do not fan out');
  observer.notification('item/commandExecution/outputDelta', { threadId: 'thread', itemId: 'exec-success', delta: 'one\n' });
  assert.equal(frames.length, emitted, 'changing output must respect the five-second floor');
  now += 5001;
  await observer.reconcile();
  assert.equal(frames.at(-1).output.text, 'one\n');

  list = () => { throw new Error('temporary disconnect'); };
  now += 1000;
  await observer.reconcile();
  assert.equal(observer.cards()[0]?.status, 'running', 'transient failure is not an empty snapshot');
  list = () => page([row()], 'more');
  await observer.reconcile();
  assert.equal(observer.cards()[0]?.status, 'running', 'repeated/capped pagination is not absence');
  now += 31000;
  await observer.reconcile();
  assert.equal(frames.at(-1).status, 'retired', 'failed snapshots eventually withdraw unverified liveness');
  list = () => page([row()]);
  await observer.reconcile();
  assert.equal(observer.cards()[0]?.status, 'running', 'recovered authoritative snapshot restores liveness');
  observer.close();
  list = () => page();
  history = () => page([{ turnId: 'turn', item: item('exec-success', '12046', 7) }]);
  const recovered = new CodexBackgroundCommands('thread', scope, rpc, (frame) => frames.push(frame), () => now);
  recovered.setClientCount(1);
  await recovered.reconcile();
  assert.equal(frames.at(-1).key, key, 'same-runtime reconnect preserves card identity');
  assert.equal(frames.at(-1).exitCode, 7, 'disconnected exact history recovers failure');
  assert.equal(frames.at(-1).startedAtMs, undefined, 'list observation time is not the process start');
  recovered.close();

  const disabledScope = `unsupported-${++scopes}`;
  list = () => { throw nativeError(-32601); };
  const unsupportedObserver = new CodexBackgroundCommands('thread', disabledScope, rpc, () => {}, () => now);
  unsupportedObserver.setClientCount(1);
  await unsupportedObserver.reconcile();
  const count = calls.length;
  await unsupportedObserver.reconcile();
  assert.equal(calls.length, count, 'definitive unsupported response is cached');
  unsupportedObserver.close();
  const sameRuntime = new CodexBackgroundCommands('thread', disabledScope, rpc, () => {}, () => now);
  sameRuntime.setClientCount(1);
  await sameRuntime.reconcile();
  assert.equal(calls.length, count, 'unsupported cache follows the server incarnation');
  sameRuntime.close();
  const newRuntime = new CodexBackgroundCommands('thread', disabledScope + '-replacement', rpc, () => {}, () => now);
  newRuntime.setClientCount(1);
  await newRuntime.reconcile();
  assert.ok(calls.length > count, 'replacement runtime renegotiates');
  newRuntime.close();

  let finish!: (result: unknown) => void;
  list = () => new Promise((resolve) => { finish = resolve; });
  const detachedFrames: AgentMessage[] = [];
  const detached = new CodexBackgroundCommands('thread', `detach-${++scopes}`, rpc, (frame) => detachedFrames.push(frame), () => now);
  detached.setClientCount(1);
  const flight = detached.reconcile();
  detached.setClientCount(0);
  finish(page([row()]));
  await flight;
  assert.equal(detachedFrames.length, 0, 'late response after detach cannot publish or seed state');
  assert.equal(detached.cards().length, 0);
  detached.close();

  list = (p) => p.cursor ? page([row('call_older', '83190')]) : page([row()], 'next');
  const two = new CodexBackgroundCommands('thread', `pages-${++scopes}`, rpc, (frame) => frames.push(frame), () => now);
  two.setClientCount(1);
  await two.reconcile();
  assert.equal(two.cards().length, 2, 'complete pagination retains concurrent commands');
  two.notification('item/completed', { ...params(item('call_older', '83190', 7)), completedAtMs: now });
  assert.equal(frames.at(-1).exitCode, 7, 'completion bypasses output throttle');
  two.close();

  list = () => page([row()]);
  const liveScope = `live-replacement-${++scopes}`;
  const predecessor = new CodexBackgroundCommands('thread', liveScope, rpc, () => {}, () => now);
  predecessor.setClientCount(1);
  await predecessor.reconcile();
  predecessor.notification('item/completed', { ...params(item('exec-success', '12046', 7)), completedAtMs: now });
  const replacement = new CodexBackgroundCommands('thread', liveScope, rpc, () => {}, () => now);
  assert.equal(replacement.cards()[0]?.exitCode, 7, 'construct-before-close replacement preserves the known result');
  predecessor.close();
  replacement.close();
  const rejoined = new CodexBackgroundCommands('thread', liveScope, rpc, () => {}, () => now);
  assert.equal(rejoined.cards()[0]?.exitCode, 7, 'late predecessor close cannot overwrite the replacement ledger');
  rejoined.close();

  // The legacy endpoint is in the generated 0.142.5 schema but that binary rejects it.
  // A valid schema-shaped response is supported; no success is inferred from discovery.
  for (const implemented of [false, true]) {
    const methods: string[] = [];
    const restored: any[] = [];
    const legacy = new CodexBackgroundCommands('thread', `legacy-${implemented}-${++scopes}`, async (method) => {
      methods.push(method);
      if (method === 'thread/backgroundTerminals/list') return page();
      if (method === 'thread/items/list') throw nativeError(-32600,
        'Invalid request: unknown variant `thread/items/list`, expected one of `thread/turns/items/list`');
      if (method === 'thread/turns/list') return page([{ id: 'turn' }]);
      assert.equal(method, 'thread/turns/items/list');
      if (!implemented) throw nativeError(-32601, 'thread/turns/items/list is not supported yet');
      return page([item('exec-success', '12046', 7)]);
    }, (frame) => restored.push(frame), () => now);
    legacy.ledger.snapshot([row()], 0, now);
    legacy.setClientCount(1);
    await legacy.reconcile();
    assert.equal(restored.at(-1).status, implemented ? 'error' : 'retired');
    assert.equal(restored.at(-1).exitCode, implemented ? 7 : undefined);
    const probes = methods.filter((method) => method === 'thread/items/list').length;
    await legacy.reconcile();
    assert.equal(methods.filter((method) => method === 'thread/items/list').length, probes);
    assert.ok(methods.length <= (implemented ? 6 : 5), 'legacy recovery remains inside the total request budget');
    legacy.close();
  }
  let requests = 0;
  await recoverBackgroundItems({ threadId: 'thread', turnIds: ['turn'], valid: () => true,
    disabled: () => false, needed: () => true, consume: () => assert.fail('transient failure has no outcome'),
    request: async (method) => { requests++; assert.equal(method, 'thread/items/list'); throw new Error('temporary'); },
  });
  assert.equal(requests, 1, 'temporary history errors do not switch protocol families');
}

export async function testBackgroundDaemonAndClients(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-background-test-'));
  const sock = join(dir, 'daemon.sock');
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 'thread', cwd: dir } }) + '\n');
  const prior = { sock: process.env.COSYNCING_CODEX_APP_SERVER_SOCK, sync: process.env.COSYNCING_CODEX_SYNC_SERVER };
  process.env.COSYNCING_CODEX_APP_SERVER_SOCK = join(dir, 'control-link.sock');
  process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
  const daemon = new FakeCodexDaemon(sock, { loadedThreadIds: ['thread'], backgroundResult: () => page([row()]) });
  let connection: SessionConnection | undefined;
  let managed: ManagedConn | undefined;
  try {
    await daemon.start();
    symlinkSync(sock, process.env.COSYNCING_CODEX_APP_SERVER_SOCK!);
    const adapter = new CodexAdapter({ queryLoadedThreadIds: async () => new Set(['thread']), scanCodexTuiPresence: async () => ({
      attributed: new Set(), unattributed: [], privateThreadIds: new Set(), privateUnattributed: [], unknownUnattributed: [],
      unknownThreadIds: new Set(), candidates: [], socketDiagAvailable: true, processScanAvailable: true,
    }) });
    connection = await adapter.attach(Buffer.from(path).toString('base64url'), 'live');
    const emitted: any[] = [];
    let delivered!: () => void;
    const activity = new Promise<void>((resolve) => { delivered = resolve; });
    managed = new ManagedConn(connection);
    assert.equal(daemon.calls.includes('thread/backgroundTerminals/list'), false, 'persistent broker subscription must not trigger polling');
    const client = (frame: any) => { emitted.push(frame); if (frame.message?.type === 'agent-activity') delivered(); };
    managed.addClient(client);
    await Promise.race([activity, Bun.sleep(2000).then(() => { throw new Error('background card not delivered through Hub'); })]);
    assert.ok(emitted.some((frame) => frame.message?.status === 'running'));
    const done = new Promise<void>((resolve) => { delivered = resolve; });
    daemon.notify('item/completed', { ...params(item('exec-success', '12046', 7)), completedAtMs: 9000 });
    await Promise.race([done, Bun.sleep(2000).then(() => { throw new Error('background completion not delivered'); })]);
    assert.ok(emitted.some((frame) => frame.message?.type === 'agent-activity' && frame.message.exitCode === 7));
    assert.ok((await connection.getHistory()).some((frame) => frame.type === 'agent-activity' && frame.exitCode === 7),
      'full-history resync preserves finished command cards, not just compact overlays');
    const windowDone = new Promise<void>((resolve) => {
      delivered = () => {
        if (emitted.some((frame) => frame.message?.key?.includes('exec-window-8') && frame.message?.status === 'done')) resolve();
      };
    });
    for (let i = 0; i < 9; i++) {
      const id = `exec-window-${i}`;
      daemon.notify('item/started', params(item(id, id), id));
      daemon.notify('turn/completed', { threadId: 'thread', turn: { id } });
      daemon.notify('item/completed', { ...params(item(id, id, 0), id), completedAtMs: 10000 + i });
    }
    await Promise.race([windowDone, Bun.sleep(2000).then(() => { throw new Error('result window fixtures not completed'); })]);
    for (const history of [await connection.getHistory(), await connection.getHistoryOverlays!()]) {
      const exact = history.findIndex((frame) => frame.type === 'agent-activity' && frame.key.includes('exec-success') && frame.exitCode === 7);
      const removed = history.findIndex((frame) => frame.type === 'agent-activity' && frame.key.includes('exec-success') && frame.status === 'retired');
      assert.ok(exact >= 0 && removed === -1, 'both adapter history methods preserve missed outcomes until dismissal');
    }
    managed.removeClient(client);
    const count = daemon.calls.filter((method) => method === 'thread/backgroundTerminals/list').length;
    await connection.getHistoryOverlays?.();
    assert.equal(daemon.calls.filter((method) => method === 'thread/backgroundTerminals/list').length, count);
    assert.ok(!daemon.calls.some((method) => /backgroundTerminals\/(clean|terminate)/.test(method)));
    const completedKey = emitted.find((frame) => frame.message?.exitCode === 7).message.key;
    await managed.dispose();
    managed = undefined;
    connection = await adapter.attach(Buffer.from(path).toString('base64url'), 'live');
    assert.ok((await connection.getHistoryOverlays!()).some((frame) => frame.type === 'agent-activity'
      && frame.key === completedKey && frame.exitCode === 7), 'symlink reconnect retains the same runtime outcome identity');
  } finally {
    if (managed) await managed.dispose(); else await connection?.close();
    await daemon.stop();
    if (prior.sock === undefined) delete process.env.COSYNCING_CODEX_APP_SERVER_SOCK; else process.env.COSYNCING_CODEX_APP_SERVER_SOCK = prior.sock;
    if (prior.sync === undefined) delete process.env.COSYNCING_CODEX_SYNC_SERVER; else process.env.COSYNCING_CODEX_SYNC_SERVER = prior.sync;
    rmSync(dir, { recursive: true, force: true });
  }
}


/** Real Hub fanout and cursor delta; keyed client reduction mirrors SessionLiveState.
 * A remains cached/offline while B consumes the transition, so fresh-client replay cannot mask it. */
export async function testBackgroundIncrementalReconnect(): Promise<void> {
  const card: AgentMessage = { type: 'agent-activity', key: 'cmd:codex:fixture', kind: 'command', title: 'Build', status: 'running' };
  const snapshot: AgentMessage = { type: 'event', name: 'codex.background-running-snapshot', payload: { keys: [] } };
  assert.equal(isCursorDurableMessage(snapshot), false, 'reconciliation must not alter the durable transcript cursor');
  assert.equal(isCursorDurableMessage({ type: 'event', name: 'ordinary-event' }), true);
  for (const revision of [0, 17, 25, 26, 27]) {
    assert.equal(canSendBackgroundMessage(card, revision), revision >= 26);
    assert.equal(canSendBackgroundMessage(snapshot, revision), revision >= 26);
    assert.equal(canSendBackgroundMessage({ ...card, key: 'cmd:claude:fixture' }, revision), true);
    assert.equal(canSendBackgroundMessage({ type: 'model-output', text: 'ordinary Codex response' }, revision), true);
  }
  for (const mode of ['withdrawal', 'old-completion', 'fresh-output', 'eviction', 'restart']) {
    let now = 1000;
    let listCalls = 0;
    const listeners = new Set<(message: AgentMessage) => void>();
    const observer = new CodexBackgroundCommands('thread', `incremental-${mode}-${++scopes}`, async (method) => {
      if (method === 'thread/backgroundTerminals/list') listCalls++;
      throw nativeError(-32601);
    }, (message) => { for (const listener of listeners) listener(message); }, () => now);
    const connection = {
      info: { id: 'review', tool: 'codex', status: 'idle' },
      subscribe: (listener: (message: AgentMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      setClientCount: (count: number) => observer.setClientCount(count),
      getHistory: async () => observer.replayCards(), getHistoryOverlays: async () => observer.replayCards(),
      close: async () => observer.close(),
    } as unknown as SessionConnection;
    const hub = new ManagedConn(connection);
    type Activity = Extract<AgentMessage, { type: 'agent-activity' }>;
    const a = new Map<string, Activity>(), b = new Map<string, Activity>();
    const apply = (state: Map<string, Activity>, message: AgentMessage) => {
      if (message.type === 'event' && message.name === 'codex.background-running-snapshot') {
        const keys = new Set((message.payload as { keys: string[] }).keys);
        for (const [key, card] of state) if (key.startsWith('cmd:codex:') && card.status === 'running' && !keys.has(key)) state.delete(key);
      }
      if (message.type !== 'agent-activity') return;
      if (message.status === 'retired') state.delete(message.key); else state.set(message.key, message);
    };
    const clientA = (frame: any) => { if (frame.kind === 'message') apply(a, frame.message); };
    const clientB = (frame: any) => { if (frame.kind === 'message') apply(b, frame.message); };
    const start = (id: string) => {
      observer.notification('item/started', params(item(id, id), id));
      observer.notification('turn/completed', { threadId: 'thread', turn: { id } });
    };
    try {
      hub.addClient(clientA); hub.addClient(clientB);
      await observer.reconcile();
      const cursor = historyDelta([]).cursor;
      start('target');
      assert.equal(a.size, 1);
      const key = [...a.keys()][0]!;
      hub.removeClient(clientA);
      if (mode === 'old-completion') {
        observer.notification('item/completed', params(item('target', 'target', 7), 'target'));
        for (let i = 0; i < 9; i++) {
          now++; start(`new-${i}`);
          observer.notification('item/completed', params(item(`new-${i}`, `new-${i}`, 0), `new-${i}`));
        }
        assert.equal(b.get(key)?.exitCode, 7);
        assert.equal(observer.cards().length, 8);
      } else {
        now += 31_000;
        await observer.reconcile();
        assert.equal(b.has(key), false);
        if (mode === 'eviction') {
          for (let i = 0; i < 128; i++) observer.notification('item/started', params(item(`foreground-${i}`, `${i}`)));
          assert.ok(!observer.replayCards().some((m) => m.type === 'agent-activity' && m.key === key), 'individual tombstone was evicted');
        }
      }
      if (mode === 'fresh-output') {
        const output = (turnId: string, delta: string) => observer.notification('item/commandExecution/outputDelta', {
          threadId: 'thread', turnId, itemId: 'target', delta,
        });
        output('foreign-turn', 'wrong turn'); output('target', '');
        observer.notification('item/started', params(item('target', 'target'), 'target'));
        assert.equal(observer.cards().length, 0, 'empty output, another turn, and replayed starts cannot restore');
        const staleSnapshot = observer.ledger.version();
        now++; output('target', 'fresh output');
        assert.equal(observer.cards()[0]?.status, 'running');
        assert.equal(b.get(key)?.status, 'running', 'restoration bypasses the previous retirement emission throttle');
        observer.ledger.snapshot([], staleSnapshot, now);
        assert.equal(observer.cards()[0]?.status, 'running', 'old snapshot cannot undo fresh output');
        observer.notification('item/completed', params(item('target', 'target', 7), 'target'));
        output('target', 'late output');
        assert.equal(observer.cards()[0]?.exitCode, 7, 'completion cannot be reopened by output');
        assert.equal(listCalls, 1, 'notification-only path explicitly caches list unsupported');
      } else {
        hub.addClient(clientA);
        const delta = historyDelta([], cursor);
        assert.equal(delta.reset, false);
        const overlays = mode === 'restart'
          ? new CodexBackgroundLedger('replacement-runtime', () => {}).replayCards()
          : await connection.getHistoryOverlays!();
        for (const message of [...delta.messages, ...overlays, ...hub.liveSnapshot()]) apply(a, message);
        await observer.reconcile();
        assert.equal(a.has(key), mode === 'old-completion', 'incremental reconnect resolves stale running cards without discarding outcomes');
        if (mode === 'old-completion') {
          const outcome = overlays.findIndex((message) => message.type === 'agent-activity' && message.key === key && message.exitCode === 7);
          const withdrawal = overlays.findIndex((message) => message.type === 'agent-activity' && message.key === key && message.status === 'retired');
          assert.ok(outcome >= 0 && withdrawal === -1, 'retained exact outcome is never withdrawn by the display window');
          assert.equal(a.get(key)?.exitCode, 7, 'missed failure remains available to read');
          assert.equal(a.size, 10, 'display window does not dismiss retained results');
        }
        assert.ok(overlays.length <= 256, 'retained resolution replay is bounded');
      }
    } finally { await hub.dispose(); }
  }
}
