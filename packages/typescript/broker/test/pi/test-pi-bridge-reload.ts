/**
 * Pi bridge residuals after the e2e pi-family-bridge suite took the reload/quit/new/resume/fork/grace
 * and late-hello scenarios (e2e/adapters/pi-family-bridge.test.ts). Kept here:
 *   - hello for the realpath matches disk discovery through a SYMLINKED Pi agent dir (one canonical id);
 *   - the in-process rewrite-token rotation on a re-hello;
 *   - turn attention through the REAL extension against an in-process stand-in for the broker routes
 *     (running before terminal under one key, one outcome each, no live running from either backfill).
 *
 *   bun run packages/typescript/broker/test/pi/test-pi-bridge-reload.ts   (exit 0 = all pass)
 */
export {};
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HostProcessProvider } from '../../../adapter-api/src/index.ts';
import { BrokerClient } from '../../../../../e2e/harness/client.ts';
import { eventually } from '../../../../../e2e/harness/wait.ts';
import {
  captureProcessOutput,
  freshModuleSpecifier,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

const portLease = await reserveLoopbackFixturePort();
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? portLease.port);
const BROKER = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = join(tmpdir(), `cosyncing-pi-bridge-reload-${PORT}`);
const DISCOVERY_CWD = join(ROOT, 'work');
const DISCOVERY_AGENT = join(ROOT, 'agent');
const DISCOVERY_AGENT_LINK = join(ROOT, 'agent-link');
const DISCOVERY_SESSION_DIR = join(DISCOVERY_AGENT, 'sessions', encodeCwdDir(DISCOVERY_CWD));
const DISCOVERY_SESSION_FILE = join(DISCOVERY_SESSION_DIR, '2026-06-18T00-00-00-000Z_bridge-sync.jsonl');

function encodeCwdDir(path: string): string {
  return `--${path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// A killed prior run may leave this port-keyed fixture behind. Port reuse must
// not turn that interrupted run into an EEXIST failure in a later clean run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DISCOVERY_CWD, { recursive: true });
mkdirSync(DISCOVERY_SESSION_DIR, { recursive: true });
writeFileSync(
  DISCOVERY_SESSION_FILE,
  JSON.stringify({ type: 'session', version: 3, id: 'bridge-sync', timestamp: new Date().toISOString(), cwd: DISCOVERY_CWD }) + '\n',
);
symlinkSync(DISCOVERY_AGENT, DISCOVERY_AGENT_LINK, process.platform === 'win32' ? 'junction' : 'dir');

// ── start an isolated broker ────────────────────────────────────────────────
await portLease.release();
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: isolatedBrokerFixtureEnvironment(ROOT, {
    overrides: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_PI_SESSIONS_ROOT: '',
    PI_CODING_AGENT_SESSION_DIR: '',
    PI_CODING_AGENT_DIR: DISCOVERY_AGENT_LINK,
    },
  }),
  stdout: 'pipe',
  stderr: 'pipe',
});
const brokerOutput = captureProcessOutput(broker);
// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other suites is slow, not broken.
const waitHealth = () => waitForBrokerHealth(broker, `${BROKER}/api/health`);

// ── bridge wire helpers (stand in for the in-session extension) ──────────────
const post = (path: string, body: unknown) =>
  fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
async function hello(sessionFile: string, cwd: string): Promise<string> {
  const r = await post('/pi/bridge/hello', { sessionFile, cwd, title: 'reload-test' });
  return String((await r.json()).id);
}
const bye = (id: string, reason: string) => post('/pi/bridge/bye', { id, reason });

const results: { name: string; ok: boolean; detail: string }[] = [];
async function test(name: string, fn: () => Promise<[boolean, string]>) {
  process.stdout.write(`• ${name} … `);
  try { const [ok, d] = await fn(); results.push({ name, ok, detail: d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${d}`); }
  catch (e) {
    let detail = String(e);
    if (broker.exitCode !== null) {
      const tail = (await settledProcessOutput(brokerOutput)).trim().slice(-2_000);
      detail += `; broker exited ${broker.exitCode}${tail ? `; tail=${tail}` : ''}`;
    }
    results.push({ name, ok: false, detail });
    console.log(`FAIL  threw: ${detail}`);
  }
}

try {
  await waitHealth();
} catch (error) {
  console.error(`${String(error)}\n${brokerOutput.read().trim().slice(-2000)}`);
  broker.kill();
  await broker.exited;
  await settledProcessOutput(brokerOutput);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
}

try {
  // 0a — disk discovery through a symlinked Pi root and a bridge hello for the realpath must produce
  // ONE canonical id; otherwise the UI shows a stale Observe row plus a separate Synced row.
  await test('bridge hello id matches symlinked disk-discovery id', async () => {
    const roster = await (await fetch(`${BROKER}/api/sessions`)).json();
    const discovered = (roster.sessions ?? []).find((s: any) => s?.tool === 'pi' && s?.cwd === DISCOVERY_CWD);
    const id = await hello(realpathSync(DISCOVERY_SESSION_FILE), DISCOVERY_CWD);
    await bye(id, 'quit');
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const ok = discovered?.id === id && decoded === realpathSync(DISCOVERY_SESSION_FILE);
    return [ok, `discovered=${discovered?.id === id} decodedRealpath=${decoded === realpathSync(DISCOVERY_SESSION_FILE)}`];
  });

  await test('a re-hello that rewrites the transcript rotates the rewrite token', async () => {
    // The broker's page cache keeps a client's earlier snapshot valid across a GROWING
    // appendPosition only while `rewriteToken` is unchanged (history-page-cache.ts:142-146). A
    // re-hello is an authoritative whole-session snapshot that can DROP rows, so it has to rotate
    // that token or the cache goes on serving pages for rows the replacement removed.
    const { PiBridgeConnection } = await import('../../../pi-engine/src/bridge.ts');
    const { historySourceStillContainsSnapshot } = await import('../../src/sessions/history-page-cache.ts');
    const userEvent = (key: string, text: string) => ({ t: 'user', key, text });
    const connection = new PiBridgeConnection({
      id: 'bridge-rewrite-token', tool: 'pi', title: 'rewrite token',
      status: 'idle', attachMode: 'observe',
    } as any);

    connection.ingestHistory([userEvent('k1', 'first'), userEvent('k2', 'second')]);
    const first = connection.getHistorySourceIdentity();
    // Identical content is a no-op (ingestHistory returns early), so earlier pages stay valid.
    connection.ingestHistory([userEvent('k1', 'first'), userEvent('k2', 'second')]);
    const identical = connection.getHistorySourceIdentity();
    // Any DIFFERENCE is a whole-session replacement; this one drops both rows.
    connection.ingestHistory([userEvent('k9', 'rewritten')]);
    const rewritten = connection.getHistorySourceIdentity();

    const keptOnNoop = identical.rewriteToken === first.rewriteToken
      && historySourceStillContainsSnapshot(first, identical);
    const rotatedOnRewrite = rewritten.rewriteToken !== identical.rewriteToken
      && !historySourceStillContainsSnapshot(identical, rewritten);
    const running = { t: 'run-summary', key: 'pi:run:u0', turnId: 'u0', status: 'running',
      tokens: { input: 7, output: 9 }, assistantMessageKey: 'assistant-anchor' };
    connection.ingestHistory([running]);
    const busyBefore = connection.getHistorySourceIdentity();
    connection.publishActiveRun({ ...running, tokens: undefined, assistantMessageKey: undefined });
    connection.ingestHistory([running]);
    connection.publishActiveRun(running);
    const busyAfter = connection.getHistorySourceIdentity();
    const rows = await connection.getHistory();
    const summaries = rows.filter((row: any) => row.type === 'run-summary');
    const intact = busyBefore.rewriteToken === busyAfter.rewriteToken && summaries.length === 1
      && (summaries[0] as any).tokens.input === 7 && (summaries[0] as any).assistantMessageKey === 'assistant-anchor';
    const live: any[] = [];
    connection.subscribe((message) => live.push(message));
    connection.ingest({ t: 'run-summary', key: running.key, turnId: 'u0', status: 'done', completedAt: 1000 });
    // A lost response can leave an already delivered start in shutdown's fallback queue.
    connection.ingest(running);
    const terminal = live.filter((message) => message.type === 'run-summary');
    // The old snapshot's end is a valid paging boundary: completion must exist beyond it.
    const newer = (await connection.getHistory()).slice(rows.length);
    const noRegression = terminal.length === 1 && terminal[0].status === 'done'
      && terminal[0].tokens.input === 7 && terminal[0].assistantMessageKey === 'assistant-anchor'
      && newer.length === 1 && newer[0]?.type === 'run-summary' && newer[0].status === 'done';
    return [keptOnNoop && rotatedOnRewrite && intact && noRegression,
      `keptOnNoop=${keptOnNoop} rotatedOnRewrite=${rotatedOnRewrite} runningIntact=${intact} terminalIntact=${noRegression}`];
  });

  await test('progress refreshes upload expiry while inactivity still discards a transfer', async () => {
    // Narrow clock-policy check: a real minute-long upload is inappropriate for the routine suite.
    const { PiBridgePayloads } = await import('../../../pi-engine/src/bridge-payload.ts');
    let now = 0;
    const payloads = new PiBridgePayloads(() => now);
    const bytes = Buffer.from(JSON.stringify({ history: ['x'.repeat(300_000)] }));
    const fragment = (id: string, index: number) => ({ bridgeChunk: { transferId: id, index,
      count: Math.ceil(bytes.length / (128 * 1024)), totalBytes: bytes.length,
      data: bytes.subarray(index * 128 * 1024, (index + 1) * 128 * 1024).toString('base64') } });
    payloads.accept('/hello', fragment('progressing', 0));
    now = 59_000; payloads.accept('/hello', fragment('progressing', 1));
    now = 118_000; const result = payloads.accept('/hello', fragment('progressing', 2));
    payloads.accept('/hello', fragment('abandoned', 0));
    now += 60_001;
    let expired = false;
    try { payloads.accept('/hello', fragment('abandoned', 1)); } catch (error) { expired = (error as any).status === 409; }
    return [!result.pending && result.body.history[0].length === 300_000 && expired, `progressing=${!result.pending} abandoned=${expired}`];
  });

  // 5 — turn attention. The broker raises "Turn finished"/"Turn failed" only for a LIVE `running`
  // run-summary followed by a terminal one under the same key, so the pairing is the extension's to
  // keep. This runs the REAL extension against an in-process stand-in for the broker's hello/events
  // routes, backed by a real PiBridgeRegistry, and records exactly what the bridge connection's
  // subscribers (the Hub, in the broker) receive. A reload re-hello carries an authoritative backfill
  // that already holds the finished turns; replaying them as a live `running` would notify again.
  {
    const { PiBridgeRegistry } = await import('../../../pi-engine/src/bridge.ts');
    const { AttentionPolicy } = await import('../../src/attention/attention-policy.ts');
    const { AttentionStore } = await import('../../src/attention/attention-store.ts');
    const bridgeModulePath = resolve(import.meta.dir, '../../../pi-engine/agent-extensions/cosyncing-bridge/index.ts');
    const root = join(ROOT, 'turn-attention');
    mkdirSync(root, { recursive: true });
    const sessionFile = join(root, '2026-09-23T00-00-00-000Z_bridge-attention.jsonl');
    const bridgeId = enc(sessionFile);
    const registry = new PiBridgeRegistry(() => undefined, 5_000);
    const frames: { phase: string; message: any }[] = [];
    let phase = 'hello';
    const helloBodies: any[] = [];
    let polls = 0;
    let subscribed = false;
    const fakeBroker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/pi/bridge/hello') {
          const body: any = await req.json();
          if (body.prepare === true) return Response.json({ ok: true, id: bridgeId });
          helloBodies.push(body);
          // The broker's hello route in miniature: a re-hello reclaims the same connection, then
          // the backfill lands. Subscribing before it also watches the first hello's backfill.
          const conn = registry.hello(bridgeId, {
            id: bridgeId, tool: 'pi', title: 'bridge attention', cwd: root, status: 'idle', attachMode: 'live',
          } as any);
          if (!subscribed) {
            subscribed = true;
            conn.subscribe((message) => frames.push({ phase, message }));
          }
          conn.ingestHistory(body.history);
          return Response.json({ ok: true, id: bridgeId });
        }
        if (url.pathname === '/pi/bridge/events') {
          const body: any = await req.json();
          const conn = registry.get(String(body?.id ?? ''));
          if (!conn) return new Response('unknown bridge', { status: 404 });
          for (const ev of body.events ?? []) conn.ingest(ev);
          return Response.json({ ok: true });
        }
        if (url.pathname === '/pi/bridge/commands') {
          if (!registry.get(url.searchParams.get('id') ?? '')) return new Response('unknown bridge', { status: 404 });
          polls += 1;
          await sleep(40); // stand in for the long poll so the loop doesn't spin hot
          return Response.json({ commands: [] });
        }
        if (url.pathname === '/pi/bridge/bye') {
          const body: any = await req.json();
          registry.bye(String(body?.id ?? ''), body?.reason);
        }
        return Response.json({ ok: true });
      },
    });
    const envKeys = ['COSYNCING_BROKER', 'COSYNCING_BRIDGE_CONFIG', 'COSYNCING_PI_INTEGRATION_FILE', 'COSYNCING_PI_INTEGRATION_TOKEN', 'COSYNCING_NO_BRIDGE'];
    const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    // Read once at module load: the extension must reach this stand-in and no host config.
    process.env.COSYNCING_BROKER = `http://127.0.0.1:${fakeBroker.port}`;
    process.env.COSYNCING_BRIDGE_CONFIG = join(root, 'absent-config.json');
    process.env.COSYNCING_PI_INTEGRATION_FILE = join(root, 'absent-integration.json');
    delete process.env.COSYNCING_PI_INTEGRATION_TOKEN;
    delete process.env.COSYNCING_NO_BRIDGE;
    const at = Date.parse('2026-09-23T10:00:00.000Z');
    const userEntry = (id: string, parentId: string | null, text: string, ms: number) => ({
      type: 'message', id, parentId, timestamp: new Date(ms).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms },
    });
    const assistantMessage = (text: string, failed: boolean) => ({
      role: 'assistant',
      stopReason: failed ? 'error' : 'stop',
      ...(failed ? { error: { message: 'fixture failure' } } : {}),
      content: [{ type: 'text', text }],
      usage: { input: 1, output: 1 },
    });
    // The session already holds one finished turn when the terminal starts.
    let entries: any[] = [
      userEntry('prior-user', null, 'finished before the bridge', at - 60_000),
      { type: 'message', id: 'prior-assistant', parentId: 'prior-user', timestamp: new Date(at - 58_000).toISOString(), message: assistantMessage('already done', false) },
    ];
    const ctx = {
      cwd: root,
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => 'bridge-attention',
        getEntries: () => entries,
      },
      ui: { setStatus() {} },
      isIdle: () => true,
    };
    // A fresh module instance per extension runtime, as a reload re-instantiates it.
    const loadExtension = async () => {
      const handlers = new Map<string, (event: any, c: any) => unknown>();
      const ext = (await import(freshModuleSpecifier(bridgeModulePath, root))).default;
      ext({
        on: (name: string, fn: (event: any, c: any) => unknown) => { handlers.set(name, fn); },
        registerTool() {},
        sendMessage() {},
        getThinkingLevel: () => undefined,
        setModel: async () => true,
        setThinkingLevel() {},
      } as any);
      return async (name: string, event: any = {}) => { await handlers.get(name)?.(event, ctx); };
    };
    const waitUntil = async (pred: () => boolean, ms = 20_000): Promise<boolean> => {
      const end = Date.now() + ms;
      while (Date.now() < end && !pred()) await sleep(25);
      return pred();
    };
    const summariesIn = (name: string) =>
      frames.filter((f) => f.phase === name && f.message.type === 'run-summary').map((f) => f.message);
    const statusesByKey = (list: any[]) => {
      const out = new Map<string, string[]>();
      for (const m of list) out.set(m.key, [...(out.get(m.key) ?? []), m.status]);
      return out;
    };
    const store = new AttentionStore({ path: join(root, 'attention-events.json') });
    const policy = new AttentionPolicy(store);
    const session = { id: bridgeId, tool: 'pi', title: 'bridge attention', status: 'idle', attachMode: 'live' } as any;
    let delivered = 0;
    const deliverFrames = async () => {
      for (const f of frames.slice(delivered)) await policy.handleMessage(session, f.message);
      delivered = frames.length;
    };
    const outcomes = (kind: string, key: string) =>
      store.listEvents().filter((event) => event.kind === kind && event.dedupeKey === `${kind}:pi:${bridgeId}:${key}`).length;
    let fire = await loadExtension();
    try {
      await test('first bridge hello backfills a finished turn without a live running summary', async () => {
        await fire('session_start');
        const linked = await waitUntil(() => polls > 0);
        // Negative proof by sentinel: the extension flushes events in emit order, so once a status
        // frame from a LATER emit has arrived, any hello-time relay would already be in `frames`.
        await fire('agent_end');
        await waitUntil(() => frames.some((f) => f.phase === 'hello' && f.message.type === 'status'), 20_000);
        const backfilled =(helloBodies[0]?.history ?? []).some(
          (ev: any) => ev.t === 'run-summary' && ev.key === 'pi:run:u0' && ev.status === 'done',
        );
        const live = summariesIn('hello');
        return [linked && backfilled && live.length === 0, `linked=${linked} backfilled=${backfilled} live=${JSON.stringify(live)}`];
      });

      await test('a live bridged turn is one running then one terminal under one key', async () => {
        phase = 'live';
        const turns = [
          { text: 'bridged done', failed: false, offset: 0 },
          { text: 'bridged error', failed: true, offset: 10_000 },
        ];
        for (const turn of turns) {
          const start = at + turn.offset;
          await fire('agent_start', { timestamp: start });
          await fire('turn_start', { timestamp: start });
          await fire('message_start', { message: { role: 'user', content: [{ type: 'text', text: turn.text }], timestamp: start } });
          await fire('message_update', { assistantMessageEvent: { type: 'text_delta', delta: `reply: ${turn.text}` } });
          await fire('message_end', { timestamp: start + 2_000, message: assistantMessage(`reply: ${turn.text}`, turn.failed) });
          await fire('agent_end', { timestamp: start + 2_000 });
        }
        await waitUntil(() => summariesIn('live').some((m) => m.key === 'pi:run:u2' && m.status !== 'running'));
        const live = statusesByKey(summariesIn('live'));
        const ok = live.size === 2
          && JSON.stringify(live.get('pi:run:u1')) === '["running","done"]'
          && JSON.stringify(live.get('pi:run:u2')) === '["running","error"]'
          && summariesIn('live').every((m) => m.source === 'pi-bridge');
        return [ok, JSON.stringify([...live])];
      });

      await test('a real AttentionPolicy raises exactly one outcome per live bridged turn', async () => {
        await deliverFrames();
        const ok = store.listEvents().length === 2
          && outcomes('run-finished', 'pi:run:u1') === 1
          && outcomes('run-failed', 'pi:run:u2') === 1
          && store.listObservations().length === 0;
        return [ok, `events=${JSON.stringify(store.listEvents().map((event) => event.dedupeKey))} open=${store.listObservations().length}`];
      });

      await test('a reload re-hello backfill of the finished turns emits no live running and raises nothing', async () => {
        phase = 'reload';
        // What the reloaded runtime's session manager reads back: both turns, persisted.
        entries = [
          ...entries,
          userEntry('live-user-1', 'prior-assistant', 'bridged done', at),
          { type: 'message', id: 'live-assistant-1', parentId: 'live-user-1', timestamp: new Date(at + 2_000).toISOString(), message: assistantMessage('reply: bridged done', false) },
          userEntry('live-user-2', 'live-assistant-1', 'bridged error', at + 10_000),
          { type: 'message', id: 'live-assistant-2', parentId: 'live-user-2', timestamp: new Date(at + 12_000).toISOString(), message: assistantMessage('reply: bridged error', true) },
        ];
        await fire('session_shutdown', { reason: 'reload' });
        fire = await loadExtension();
        await fire('session_start');
        const reset = await waitUntil(() => frames.some((f) => f.phase === 'reload' && f.message.type === 'history-reset'));
        await fire('agent_end');
        await waitUntil(() => frames.some((f) => f.phase === 'reload' && f.message.type === 'status'), 20_000);
        const backfill = statusesByKey((helloBodies[1]?.history ?? []).filter((ev: any) => ev.t === 'run-summary'));
        const eventsBefore = store.listEvents().length;
        const openBefore = store.listObservations().length;
        await deliverFrames();
        const live = summariesIn('reload');
        const ok = reset
          && helloBodies.length === 2
          && JSON.stringify(backfill.get('pi:run:u1')) === '["done"]'
          && JSON.stringify(backfill.get('pi:run:u2')) === '["error"]'
          && live.length === 0
          && store.listEvents().length === eventsBefore
          && store.listObservations().length === openBefore;
        return [ok, `reset=${reset} hellos=${helloBodies.length} backfill=${JSON.stringify([...backfill])} live=${JSON.stringify(live)} events=${eventsBefore}->${store.listEvents().length} open=${openBefore}->${store.listObservations().length}`];
      });
    } finally {
      await fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
      fakeBroker.stop(true);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  // Real extension -> real broker -> real session stream. A large native history and an
  // individual multi-megabyte result must survive the ordinary 1 MiB HTTP limit.
  {
    const root = join(ROOT, 'large-native');
    mkdirSync(root, { recursive: true });
    const file = join(DISCOVERY_SESSION_DIR, 'large-native.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'large-native', cwd: root }) + '\n');
    const at = Date.now() - 600_000;
    const entries: any[] = [
      { type: 'message', id: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'one long turn', timestamp: at } },
      { type: 'message', id: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: {
        role: 'assistant', stopReason: 'toolUse', content: [
          { type: 'thinking', thinking: 'large history 💡 '.repeat(90_000) },
          { type: 'toolCall', id: 'long-call', name: 'bash', arguments: { command: 'fixture long tool' } },
        ], usage: { input: 7, output: 9 },
      } },
    ];
    const appendEntry = (customType: string, data: any) => {
      const entry = { type: 'custom', id: crypto.randomUUID(), customType, data, timestamp: new Date().toISOString() };
      entries.push(entry);
      appendFileSync(file, JSON.stringify(entry) + '\n');
    };
    appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    let busy = true;
    const statuses: string[] = [];
    const ctx = {
      cwd: root, isIdle: () => !busy,
      sessionManager: { getSessionFile: () => file, getSessionId: () => 'large-native', getBranch: () => entries },
      ui: { setStatus(_key: string, value: string) { statuses.push(value); } },
    };
    const saved = { COSYNCING_BROKER: process.env.COSYNCING_BROKER,
      COSYNCING_PI_INTEGRATION_FILE: process.env.COSYNCING_PI_INTEGRATION_FILE,
      COSYNCING_BRIDGE_CONFIG: process.env.COSYNCING_BRIDGE_CONFIG };
    process.env.COSYNCING_BROKER = BROKER;
    process.env.COSYNCING_PI_INTEGRATION_FILE = join(root, 'absent-integration.json');
    writeFileSync(join(root, 'config.json'), '{}');
    process.env.COSYNCING_BRIDGE_CONFIG = join(root, 'config.json');
    const originalFetch = globalThis.fetch;
    const requests: { path: string; bytes: number; epoch?: string; prepare?: boolean }[] = [];
    let duringUpload: (() => Promise<void>) | undefined;
    const commands = new Set<AbortController>();
    let intercept: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | undefined;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = new URL(String(input));
      const intercepted = await intercept?.(url, init);
      if (intercepted) return intercepted;
      if (url.origin === BROKER && /\/pi\/bridge\/(hello|events)$/.test(url.pathname)) {
        const payload = JSON.parse(String(init?.body ?? '{}'));
        requests.push({ path: url.pathname, bytes: Buffer.byteLength(String(init?.body ?? '')), epoch: payload.epoch ?? payload.bridgeChunk?.epoch, prepare: payload.prepare === true });
        if (url.pathname.endsWith('/hello') && JSON.parse(String(init?.body))?.bridgeChunk?.index === 0) await duringUpload?.();
      }
      if (url.origin === BROKER && url.pathname === '/pi/bridge/commands') {
        const controller = new AbortController(); commands.add(controller);
        try { return await originalFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal }); }
        finally { commands.delete(controller); }
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const extension = (await import(freshModuleSpecifier(resolve(import.meta.dir, '../../../pi-engine/agent-extensions/cosyncing-bridge/index.ts'), root))).default;
    extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {}, setModel: async () => true, setThinkingLevel() {} } as any);
    const fire = async (name: string, event: any = {}) => { await handlers.get(name)?.(event, ctx); };
    duringUpload = () => fire('tool_execution_start', { toolCallId: 'during-upload', toolName: 'bash', args: { command: 'fixture tool during registration' } });
    const terminals: any[] = [];
    let terminalSequence = 0;
    const native = (name: string, initial: any[] = [], shared?: any, throwsStatus = false) => {
      const nativeFile = shared?.file ?? join(DISCOVERY_SESSION_DIR, `${name}-${++terminalSequence}.jsonl`);
      const rows: any[] = shared?.rows ?? [...initial];
      if (!shared) writeFileSync(nativeFile, [
        JSON.stringify({ type: 'session', id: name, cwd: root }), ...rows.map((row) => JSON.stringify(row)),
      ].join('\n') + '\n');
      let nativeBusy = false;
      const nativeStatuses: string[] = [], injected: any[] = [];
      const callbacks = new Map<string, any>();
      const nativeCtx = { cwd: root, isIdle: () => !nativeBusy,
        sessionManager: { getSessionFile: () => nativeFile, getSessionId: () => name, getBranch: () => rows },
        ui: { setStatus(_key: string, value: string) {
          nativeStatuses.push(value);
          if (throwsStatus) throw new Error('fixture UI unavailable');
        } },
      };
      const append = (entry: any) => { rows.push(entry); appendFileSync(nativeFile, JSON.stringify(entry) + '\n'); };
      extension({ on(event: string, callback: any) { callbacks.set(event, callback); }, registerTool() {},
        getThinkingLevel() {}, sendMessage(message: any) { injected.push(message); },
        appendEntry(customType: string, data: any) { append({ type: 'custom', id: crypto.randomUUID(), customType, data }); },
      } as any);
      const terminal = { file: nativeFile, rows, ctx: nativeCtx, statuses: nativeStatuses, injected, callbacks,
        async fire(event: string, value: any = {}, context = nativeCtx) {
          if (event === 'agent_start') nativeBusy = true;
          if (event === 'agent_end') nativeBusy = false;
          await callbacks.get(event)?.(value, context);
        },
        append,
        async stop() { await callbacks.get('session_shutdown')?.({ reason: 'quit' }, nativeCtx); },
      };
      terminals.push(terminal);
      return terminal;
    };
    const client = new BrokerClient(BROKER, BROKER.replace('http:', 'ws:'), { kind: 'none' });
    try {
      await test('the real extension transfers large history and restores the original busy user turn', async () => {
        const savedIdentityEnv = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
        try {
          process.env.TZ = 'Pacific/Honolulu'; process.env.LC_ALL = 'fr_FR.UTF-8';
          const starting = fire('session_start');
          const bucket = join(DISCOVERY_SESSION_DIR, '.cosyncing-presence', `${basename(file)}.owners`);
          const records = readdirSync(bucket).filter((name) => name.endsWith('.json'));
          if (records.length !== 1 || JSON.parse(readFileSync(join(bucket, records[0]!), 'utf8')).sessionFile !== file) {
            throw new Error('Native ownership must precede asynchronous registration');
          }
          await starting;
          await eventually(() => statuses.includes('📱 bridged'), { what: 'large native registration' });
          process.env.TZ = 'Asia/Tokyo'; process.env.LC_ALL = 'ja_JP.UTF-8';
          const record = JSON.parse(readFileSync(join(bucket, records[0]!), 'utf8'));
          const processRead = new HostProcessProvider().liveProcess(process.pid);
          if (processRead.state !== 'running' || record.start !== processRead.identity.start || record.boot !== processRead.identity.boot) {
            throw new Error('Native extension and provider disagree on process identity across locale/time zone');
          }
        } finally {
          for (const [key, value] of Object.entries(savedIdentityEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
        }
        const id = enc(file);
        const stream = await client.attach('pi', id);
        const info = (await stream.waitForKind('session')).info;
        await stream.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u0' && m.status === 'running', { what: 'original running turn after large registration' });
        await stream.waitForMessage((m) => m.type === 'tool-call' && m.callId === 'during-upload', { what: 'tool started during the snapshot upload' });
        await fire('tool_execution_end', { toolCallId: 'long-call', toolName: 'bash', result: { content: [{ type: 'text', text: 'result '.repeat(180_000) }] } });
        busy = false;
        await fire('message_end', { timestamp: at + 500_000, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'finished after long tool' }] } });
        await fire('agent_end', { timestamp: at + 500_000 });
        const done = await stream.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u0' && m.status === 'done', { what: 'original turn completion after a large result' });
        const physical = requests.filter((r) => r.path.endsWith('/hello'));
        const terminal = stream.messages().filter((m) => m.type === 'run-summary' && m.status === 'done');
        return [info.status === 'working' && done.totalRuntimeMs === 500_000 && terminal.every((m) => m.key === 'pi:run:u0')
          && physical.length > 1 && requests.every((r) => r.bytes < 1024 * 1024),
          `initial=${info.status} key=${done.key} duration=${done.totalRuntimeMs} helloFragments=${physical.length} maxRequest=${Math.max(...requests.map((r) => r.bytes))}`];
      });
      await test('a fresh extension closes a recovered tool-only end under the original key and clock', async () => {
        await fire('session_shutdown', { reason: 'reload' });
        for (const controller of commands) controller.abort();
        entries.push(
          { type: 'message', id: 'first-final', timestamp: new Date(at + 500_000).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first finished' }] } },
          { type: 'message', id: 'second-user', timestamp: new Date(at + 510_000).toISOString(), message: { role: 'user', content: 'second tool-only turn', timestamp: at + 510_000 } },
          { type: 'message', id: 'second-call', timestamp: new Date(at + 511_000).toISOString(), message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'second-call', name: 'bash', arguments: { command: 'fixture second tool' } }] } },
        );
        writeFileSync(file, JSON.stringify({ type: 'session', id: 'large-native', cwd: root }) + '\n' + entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        busy = true;
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        const previousStatuses = statuses.length;
        await fire('session_start');
        await eventually(() => statuses.slice(previousStatuses).includes('📱 bridged'), { what: 'fresh extension recovery' });
        const stream = await client.attach('pi', enc(file));
        await stream.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u1' && m.status === 'running');
        await fire('tool_execution_end', { toolCallId: 'second-call', toolName: 'bash', result: { content: [{ type: 'text', text: 'second result' }] } });
        busy = false;
        await fire('agent_end', { timestamp: at + 810_000 });
        const done = await stream.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u1' && m.status === 'done');
        const outcomes = await eventually(async () => {
          const events = (await client.get('/api/attention-events?clientId=pi-large-recovery&limit=200')).body.events
            .filter((e: any) => e.sessionId === enc(file) && e.kind === 'run-finished');
          return events.length === 2 ? events : undefined;
        }, { what: 'one outcome for each recovered turn' });
        return [done.totalRuntimeMs === 300_000 && new Set(outcomes.map((e: any) => e.turnId)).size === 2,
          `key=${done.key} duration=${done.totalRuntimeMs} outcomes=${outcomes.length}`];
      });
      await test('tool-only live, hello replay and disk Observe agree on the durable end clock', async () => {
        await fire('session_shutdown', { reason: 'reload' });
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        const n = statuses.length;
        await fire('session_start');
        await eventually(() => statuses.slice(n).includes('📱 bridged'), { what: 'durable-end replay' });
        const replay = await client.attach('pi', enc(file));
        const summary = await replay.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u1');
        await fire('session_shutdown', { reason: 'quit' });
        const observe = await client.attach('pi', enc(file));
        const disk = await observe.waitForMessage((m) => m.type === 'run-summary' && m.key === 'pi:run:u1');
        return [summary.status === 'done' && disk.status === 'done' && summary.totalRuntimeMs === 300_000 && disk.totalRuntimeMs === summary.totalRuntimeMs,
          `hello=${summary.status}/${summary.totalRuntimeMs} disk=${disk.status}/${disk.totalRuntimeMs}`];
      });
      await test('shared native session_switch moves the bridge to the new file', async () => {
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        const n = statuses.length;
        await fire('session_start');
        await eventually(() => statuses.slice(n).includes('📱 bridged'), { what: 'switch source bridge' });
        const nextFile = join(DISCOVERY_SESSION_DIR, 'switch-destination.jsonl');
        writeFileSync(nextFile, JSON.stringify({ type: 'session', id: 'switch-destination', cwd: root }) + '\n');
        const nextCtx = { ...ctx, sessionManager: { getSessionFile: () => nextFile, getBranch: () => [] } };
        const k = statuses.length;
        await handlers.get('session_switch')?.({ reason: 'resume', previousSessionFile: file }, nextCtx);
        await eventually(() => statuses.slice(k).includes('📱 bridged'), { what: 'switch destination bridge' });
        const old = (await client.get(`/pi/bridge/status?id=${enc(file)}`)).body.bridged;
        const next = (await client.get(`/pi/bridge/status?id=${enc(nextFile)}`)).body.bridged;
        await handlers.get('session_shutdown')?.({ reason: 'quit' }, nextCtx);
        return [!old && next, `old=${old} next=${next}`];
      });
      await test('a dropped events batch recovers the native bridged status on successful delivery', async () => {
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        const n = statuses.length;
        await fire('session_start');
        await eventually(() => statuses.slice(n).includes('📱 bridged'), { what: 'status recovery initial bridge' });
        let reject = true;
        intercept = async (url) => url.pathname === '/pi/bridge/events' && reject ? new Response('injected loss', { status: 500 }) : undefined;
        await fire('agent_start', { timestamp: Date.now() });
        await eventually(() => statuses.slice(n).some((value) => value.includes('HTTP 500')), { what: 'visible failed delivery' });
        reject = false;
        const k = statuses.length;
        await fire('tool_execution_end', { toolCallId: 'recovered-event', toolName: 'bash', result: { content: [{ type: 'text', text: 'success' }] } });
        await eventually(() => statuses.slice(k).includes('📱 bridged'), { what: 'successful delivery clears disconnected status' });
        intercept = undefined;
        await fire('session_shutdown', { reason: 'quit' });
        return [true, 'HTTP 500 -> successful event -> bridged'];
      });
      await test('quitting during an intercepted fragmented hello leaves no ghost registration', async () => {
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        let entered!: () => void, release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let lateStatus: number | undefined;
        intercept = async (url, init) => {
          if (url.pathname === '/pi/bridge/hello' && JSON.parse(String(init?.body))?.bridgeChunk) {
            entered(); await gate;
            // Model a request already sent before cancellation; the broker must fence it too.
            const result = await originalFetch(url, { ...init, signal: undefined });
            lateStatus = result.status;
            return result;
          }
          return undefined;
        };
        try {
          await fire('session_start');
          await enteredPromise;
          await fire('session_shutdown', { reason: 'quit' });
          release();
          await eventually(() => lateStatus, { what: 'late hello refused' });
          const live = (await client.get(`/pi/bridge/status?id=${enc(file)}`)).body.bridged;
          return [lateStatus === 410 && !live, `lateHello=${lateStatus} bridged=${live}`];
        } finally { release(); intercept = undefined; }
      });
      await test('quit delivers completion even when a fragmented event upload cannot finish', async () => {
        handlers.clear();
        extension({ on(name: string, fn: any) { handlers.set(name, fn); }, appendEntry, registerTool() {}, getThinkingLevel() {} } as any);
        const n = statuses.length;
        await fire('session_start');
        await eventually(() => statuses.slice(n).includes('📱 bridged'), { what: 'large quit initial bridge' });
        const stream = await client.attach('pi', enc(file));
        let entered!: () => void, release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let lateStatus: number | undefined;
        intercept = async (url, init) => {
          if (url.pathname === '/pi/bridge/events' && JSON.parse(String(init?.body))?.bridgeChunk) {
            entered(); await gate;
            const result = await originalFetch(url, { ...init, signal: undefined });
            lateStatus = result.status;
            return result;
          }
          return undefined;
        };
        try {
          const startedAt = Date.now();
          await fire('agent_start', { timestamp: startedAt });
          await fire('message_start', { message: { role: 'user', content: 'quit turn', timestamp: startedAt } });
          await fire('message_end', { timestamp: startedAt + 10, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'quit-call', name: 'bash', arguments: {} }] } });
          await fire('tool_execution_end', { toolCallId: 'quit-call', toolName: 'bash', result: { content: [{ type: 'text', text: 'big result '.repeat(100_000) }] } });
          await fire('agent_end', { timestamp: startedAt + 100 });
          await enteredPromise;
          await fire('session_shutdown', { reason: 'quit' });
          release();
          const done = await stream.waitForMessage((m) => m.type === 'run-summary' && m.userMessageKey === 'u2' && m.status === 'done');
          await eventually(() => lateStatus, { what: 'late event refused' });
          const events = await eventually(async () => {
            const events = (await client.get('/api/attention-events?clientId=quit-recovery&limit=200')).body.events;
            return events.find((event: any) => event.sessionId === enc(file) && event.kind === 'run-finished' && event.turnId === 'u2');
          }, { what: 'completion survives quit' });
          return [done.totalRuntimeMs === 100 && lateStatus === 410 && !!events, `duration=${done.totalRuntimeMs} lateEvents=${lateStatus} outcome=${!!events}`];
        } finally { release(); intercept = undefined; }
      });
      await test('two native terminals keep one owner and the loser never uploads its large history', async () => {
        duringUpload = undefined;
        const largeRows = [
          { type: 'message', id: 'twin-user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'large shared session', timestamp: at } },
          { type: 'message', id: 'twin-answer', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'shared '.repeat(150_000) }] } },
        ];
        const first = native('terminal-owner', largeRows);
        const second = native('terminal-contender', [], first);
        try {
          await first.fire('session_start');
          await eventually(() => first.statuses.includes('📱 bridged'), { what: 'first native owner' });
          const before = requests.length;
          await second.fire('session_start');
          await eventually(() => second.statuses.some((value: string) => value.includes('another terminal')), { what: 'visible ownership contention' });
          const contender = requests.slice(before).filter((request) => request.path.endsWith('/hello'));
          const stream = await client.attach('pi', enc(first.file));
          await stream.waitForKind('history');
          await second.stop(); // its sessionFile-only bye must not end the owner
          {
            const live = (await client.get(`/pi/bridge/status?id=${enc(first.file)}`)).body.bridged;
            if (!live) throw new Error('contender ended the owner');
          }
          await stream.sendAndAwait({ kind: 'prompt', text: 'only the first terminal' });
          await eventually(() => first.injected.some((message: any) => message.content === 'only the first terminal'), { what: 'prompt reaches the owner' });
          return [contender.length === 1 && contender[0]?.prepare === true && contender[0].bytes < 16_384 && second.injected.length === 0,
            `contenderRequests=${contender.length} admissionBytes=${contender[0]?.bytes} ownerInjected=${first.injected.length}`];
        } finally { await second.stop(); await first.stop(); }
      });
      await test('a duplicate native start cannot create a second bridge loop', async () => {
        const terminal = native('single-loop');
        let entered!: () => void, release!: () => void, admissions = 0;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        intercept = async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (url.pathname === '/pi/bridge/hello' && body.prepare && body.sessionFile === terminal.file) {
            admissions++; entered(); await gate;
          }
          return undefined;
        };
        try {
          await terminal.fire('session_start'); await reached;
          await terminal.fire('session_start');
          if (admissions !== 1) throw new Error(`duplicate bridge loops: ${admissions}`);
          release();
          await eventually(() => terminal.statuses.includes('📱 bridged'), { what: 'single loop registration' });
          return [admissions === 1, `admissions=${admissions}`];
        } finally { release(); intercept = undefined; await terminal.stop(); }
      });
      await test('OMP switch events stay on B while retirement of A is held', async () => {
        const terminal = native('switch-owner-A');
        const destination = native('switch-target-B');
        await terminal.fire('session_start');
        await eventually(() => terminal.statuses.includes('📱 bridged'), { what: 'switch owner A' });
        const oldStream = await client.attach('pi', enc(terminal.file));
        await oldStream.waitForKind('history');
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        intercept = async (url, init) => {
          if (url.pathname === '/pi/bridge/bye' && JSON.parse(String(init?.body))?.sessionFile === terminal.file) { entered(); await gate; }
          return undefined;
        };
        try {
          const switching = terminal.fire('session_switch', { reason: 'resume' }, destination.ctx);
          await reached;
          const startedAt = Date.now();
          destination.append({ type: 'message', id: 'new-user', timestamp: new Date(startedAt).toISOString(), message: { role: 'user', content: 'belongs only to B', timestamp: startedAt } });
          await terminal.fire('agent_start', { timestamp: startedAt }, destination.ctx);
          await terminal.fire('message_start', { message: { role: 'user', content: 'belongs only to B', timestamp: startedAt } }, destination.ctx);
          // Trigger size flushing without sleeps, so the old implementation leaks B into A.
          for (let i = 0; i < 33; i++) await terminal.fire('tool_execution_start', { toolCallId: `B-tool-${i}`, toolName: 'bash', args: { command: 'B only' } }, destination.ctx);
          const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'B finished' }] };
          destination.append({ type: 'message', id: 'new-answer', timestamp: new Date(startedAt + 100).toISOString(), message: answer });
          await terminal.fire('message_end', { timestamp: startedAt + 100, message: answer }, destination.ctx);
          await terminal.fire('agent_end', { timestamp: startedAt + 100 }, destination.ctx);
          release(); await switching;
          await eventually(() => destination.statuses.includes('📱 bridged'), { what: 'B bridges after A retirement' });
          const nextStream = await client.attach('pi', enc(destination.file));
          await nextStream.waitForMessage((message) => message.type === 'model-output' && message.text === 'B finished', { what: 'B snapshot includes its completed answer' });
          await oldStream.waitForKind('ended');
          const leaked = oldStream.messages().some((message) => message.text === 'belongs only to B' || String(message.callId ?? '').startsWith('B-tool-'));
          return [!leaked, `B reached its own history; leakedToA=${leaked}`];
        } finally { release(); intercept = undefined; await terminal.stop(); await destination.stop(); }
      });
      await test('a native status UI exception cannot turn successful delivery into a failed bridge', async () => {
        const terminal = native('throwing-status', [], undefined, true);
        try {
          await terminal.fire('session_start');
          await eventually(() => terminal.statuses.includes('📱 bridged'), { what: 'registration survives UI exception' });
          const stream = await client.attach('pi', enc(terminal.file));
          await stream.waitForKind('history');
          await stream.sendAndAwait({ kind: 'prompt', text: 'UI exception must not lose this' });
          await eventually(() => terminal.injected.some((message: any) => message.content === 'UI exception must not lose this'), { what: 'command poll survives UI exception' });
          return [!terminal.statuses.some((value: string) => value.includes('network request failed')), `injected=${terminal.injected.length}`];
        } finally { await terminal.stop(); }
      });
      await test('a permanent full-snapshot refusal stops reuploads and bounds the unbridged bye tail', async () => {
        const terminal = native('bounded-rejection', [
          { type: 'message', id: 'old-user', message: { role: 'user', content: 'old', timestamp: at } },
          { type: 'message', id: 'old-answer', timestamp: new Date(at + 100).toISOString(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'large '.repeat(100_000) }] } },
        ]);
        let rejected = 0, byeBytes = 0, finalEvents: any[] = [];
        intercept = async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (url.pathname === '/pi/bridge/hello' && body.bridgeChunk) { rejected++; return new Response('permanent full payload refusal', { status: 413 }); }
          if (url.pathname === '/pi/bridge/bye' && body.sessionFile === terminal.file) { byeBytes = Buffer.byteLength(String(init?.body)); finalEvents = body.finalEvents; }
          return undefined;
        };
        try {
          await terminal.fire('session_start');
          await eventually(() => terminal.statuses.some((value: string) => value.includes('HTTP 413')), { what: 'permanent snapshot rejection' });
          for (let i = 0; i < 300; i++) {
            const time = Date.now() + i * 10;
            const user = { role: 'user', content: `unbridged turn ${i}`, timestamp: time };
            terminal.append({ type: 'message', id: `burst-u-${i}`, timestamp: new Date(time).toISOString(), message: user });
            await terminal.fire('agent_start', { timestamp: time });
            await terminal.fire('message_start', { message: user });
            const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
            terminal.append({ type: 'message', id: `burst-a-${i}`, timestamp: new Date(time + 1).toISOString(), message: answer });
            await terminal.fire('message_end', { timestamp: time + 1, message: answer });
            await terminal.fire('agent_end', { timestamp: time + 1 });
          }
          await terminal.fire('session_start'); // even an idempotent start cannot restart a rejected upload
          await terminal.stop();
          return [rejected === 1 && byeBytes < 70 * 1024 && finalEvents.some((event) => event.key === 'pi:run:u300' && event.status === 'done'),
            `rejectedUploads=${rejected} byeBytes=${byeBytes} lifecycleFrames=${finalEvents.length}`];
        } finally { intercept = undefined; await terminal.stop(); }
      });
      await test('a failed native claim keeps its warning and recovers on the next eligible heartbeat', async () => {
        const terminal = native('recover-presence');
        const presenceRoot = join(DISCOVERY_SESSION_DIR, '.cosyncing-presence');
        const bucket = join(presenceRoot, `${basename(terminal.file)}.owners`);
        mkdirSync(presenceRoot, { recursive: true });
        writeFileSync(bucket, 'injected filesystem obstruction');
        const originalNow = Date.now;
        try {
          await terminal.fire('session_start');
          await eventually(() => terminal.statuses.some((value: string) => value.startsWith('📱 bridged') && value.includes('native ownership could not be recorded')), { what: 'claim warning survives successful bridge' });
          rmSync(bucket);
          const stream = await client.attach('pi', enc(terminal.file));
          await stream.waitForKind('history');
          // Controlled retry clock: real time still advances for every bounded wait.
          Date.now = () => originalNow() + 6000;
          await stream.sendAndAwait({ kind: 'prompt', text: 'trigger the next poll heartbeat' });
          await eventually(() => existsSync(bucket) && terminal.statuses.at(-1) === '📱 bridged', { what: 'record and warning recover on heartbeat' });
          const record = JSON.parse(readFileSync(join(bucket, readdirSync(bucket).find((name) => name.endsWith('.json'))!), 'utf8'));
          return [record.schemaVersion === 3 && !!record.start, `schema=${record.schemaVersion} knownIdentity=${!!record.start}`];
        } finally {
          Date.now = originalNow;
          await terminal.stop();
          rmSync(bucket, { recursive: true, force: true });
        }
      });
      await test('the real extension reports a rejected registration visibly', async () => {
        // No live mutation: a failed HTTP response is injected only at the extension boundary.
        globalThis.fetch = (async (input: any, init?: RequestInit) => String(input).endsWith('/pi/bridge/hello')
          ? new Response('fixture rejection', { status: 413 }) : originalFetch(input, init)) as typeof fetch;
        await fire('session_shutdown', { reason: 'quit' });
        for (const controller of commands) controller.abort();
        const rejectedHandlers = new Map<string, any>();
        extension({ on(name: string, fn: any) { rejectedHandlers.set(name, fn); }, registerTool() {}, getThinkingLevel() {} } as any);
        await rejectedHandlers.get('session_start')({}, ctx);
        try {
          await eventually(() => statuses.some((s) => s.includes('HTTP 413')), { what: 'native rejection status' });
          return [true, 'native status includes HTTP 413'];
        } finally { await rejectedHandlers.get('session_shutdown')({ reason: 'quit' }, ctx); }
      });
    } finally {
      for (const terminal of terminals) await terminal.stop().catch(() => undefined);
      await fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
      for (const controller of commands) controller.abort();
      globalThis.fetch = originalFetch;
      client.closeAll();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
} finally {
  // Awaiting the exit is the point: signalling and returning left the broker
  // and its children alive past this process, for the lane to reap.
  broker.kill();
  await broker.exited;
  await settledProcessOutput(brokerOutput);
  rmSync(ROOT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
