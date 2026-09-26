/**
 * Headless repro + regression for the Pi bridge reload/fork ORPHAN fix
 * (deep-source-audit-2026-06-15.md → [bridge/high]; task #29).
 *
 * Pure broker-side: it simulates the in-session extension over the `/pi/bridge/*` HTTP wire and a
 * phone over the attach WebSocket. No real `pi` is needed — the bridge endpoints are in-memory, and
 * a WS attach to an already-adopted (pinned) bridge reuses it WITHOUT spawning `pi --mode rpc`. It
 * starts its OWN broker on a free port with a short grace window, so it never touches a running
 * broker or real sessions.
 *
 *   bun run scripts/broker/test-pi-bridge-reload.ts
 * Exit 0 = all pass.
 *
 * What it proves:
 *   1. RELOAD keeps the phone attached — bye(reason:'reload') then a same-id re-hello (the reload's
 *      new runtime) → a POST-reload event still reaches the phone, and NO `ended` frame was sent.
 *      This is the bug: before the fix, the bye evicted the connection between the old runtime's bye
 *      and the new runtime's hello, clearing the client set and silently orphaning the socket.
 *   2. QUIT ends cleanly — bye(reason:'quit') → the phone gets a `{kind:'ended', reason:'quit'}`
 *      frame, later events 404 (bridge gone), and the roster no longer reports it bridged.
 *   3. new/resume/fork tear down immediately and pass their reason through to the `ended` frame.
 *   4. GRACE EXPIRY — bye(reason:'reload') with NO re-hello → after the grace window the phone gets
 *      an `ended` frame and the bridge is gone (a failed reload doesn't leak a pinned dead conn).
 *   5. TURN ATTENTION — through the REAL extension, a live bridged turn reaches the bridge
 *      connection's subscribers as one `running` run-summary before one terminal under the same
 *      key (one outcome each in a real AttentionPolicy), and neither the first hello's backfill nor
 *      a reload re-hello's backfill of finished turns puts a `running` on the live stream.
 */
export {};
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const WSBASE = BROKER.replace(/^http/, 'ws');
const GRACE_MS = 700; // small so the grace-expiry test is fast; the reload re-hello is immediate
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);
const ROOT = join('/tmp', `cosyncing-pi-bridge-reload-${PORT}`);
const DISCOVERY_CWD = join(ROOT, 'work');
const RUNTIME_CWD = join(ROOT, 'runtime-work');
const DISCOVERY_AGENT = join(ROOT, 'agent');
const DISCOVERY_AGENT_LINK = join(ROOT, 'agent-link');
const DISCOVERY_SESSION_DIR = join(DISCOVERY_AGENT, 'sessions', encodeCwdDir(DISCOVERY_CWD));
const DISCOVERY_SESSION_FILE = join(DISCOVERY_SESSION_DIR, '2026-06-18T00-00-00-000Z_bridge-sync.jsonl');
const EARLY_SESSION_FILE = join(DISCOVERY_SESSION_DIR, '2026-06-18T00-00-00-000Z_early-hello.jsonl');
const EARLY_SESSION_FILE_LINK = join(DISCOVERY_AGENT_LINK, 'sessions', encodeCwdDir(DISCOVERY_CWD), '2026-06-18T00-00-00-000Z_early-hello.jsonl');

function encodeCwdDir(path: string): string {
  return `--${path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// A killed prior run may leave this port-keyed fixture behind. Port reuse must
// not turn that interrupted run into an EEXIST failure in a later clean run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DISCOVERY_CWD, { recursive: true });
mkdirSync(RUNTIME_CWD, { recursive: true });
mkdirSync(DISCOVERY_SESSION_DIR, { recursive: true });
writeFileSync(
  DISCOVERY_SESSION_FILE,
  JSON.stringify({ type: 'session', version: 3, id: 'bridge-sync', timestamp: new Date().toISOString(), cwd: DISCOVERY_CWD }) + '\n',
);
symlinkSync(DISCOVERY_AGENT, DISCOVERY_AGENT_LINK, 'dir');

// ── start an isolated broker ────────────────────────────────────────────────
await portLease.release();
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: isolatedBrokerFixtureEnvironment(ROOT, {
    overrides: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_BRIDGE_GRACE_MS: String(GRACE_MS),
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
const events = (id: string, evs: unknown[]) => post('/pi/bridge/events', { id, events: evs });
const bye = (id: string, reason: string) => post('/pi/bridge/bye', { id, reason });
const commands = async (id: string): Promise<unknown[]> =>
  ((await (await fetch(`${BROKER}/pi/bridge/commands?id=${encodeURIComponent(id)}`)).json()).commands ?? []);
const isBridged = async (id: string): Promise<boolean> =>
  (await (await fetch(`${BROKER}/pi/bridge/status?id=${encodeURIComponent(id)}`)).json()).bridged;

// ── phone (attach WebSocket) ─────────────────────────────────────────────────
interface Phone { frames: any[]; waitFrame: (p: (f: any) => boolean, ms: number) => Promise<any>; send: (o: unknown) => void; close: () => void; }
function attach(id: string): Promise<Phone> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream`);
    const frames: any[] = [];
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    const phone: Phone = {
      frames,
      waitFrame: async (pred, ms) => {
        const end = Date.now() + ms;
        for (;;) { const f = frames.find(pred); if (f) return f; if (Date.now() > end) return undefined; await sleep(60); }
      },
      send: (o) => ws.send(JSON.stringify(o)),
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onopen = () => resolve(phone);
  });
}
const isModelDelta = (text: string) => (f: any) =>
  f.kind === 'message' && f.message?.type === 'model-output' && new RegExp(text).test(f.message.delta ?? f.message.text ?? '');

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

  await test('early bridge hello re-keys from symlink fallback id after JSONL appears', async () => {
    const provisional = await hello(EARLY_SESSION_FILE_LINK, DISCOVERY_CWD);
    writeFileSync(
      EARLY_SESSION_FILE,
      JSON.stringify({ type: 'session', version: 3, id: 'early', timestamp: new Date().toISOString(), cwd: DISCOVERY_CWD }) + '\n',
    );
    const canonical = enc(realpathSync(EARLY_SESSION_FILE));
    const roster = await (await fetch(`${BROKER}/api/sessions`)).json();
    const row = (roster.sessions ?? []).find((s: any) => s?.id === canonical);
    const oldStatus = await isBridged(provisional);
    const canonicalStatus = await isBridged(canonical);
    await bye(provisional, 'quit');
    const afterBye = await isBridged(canonical);
    const ok = provisional !== canonical &&
      row?.control?.terminalSync?.active === true &&
      oldStatus === true &&
      canonicalStatus === true &&
      afterBye === false;
    return [ok, `rekeyed=${provisional !== canonical} rowActive=${row?.control?.terminalSync?.active} oldStatus=${oldStatus} canonicalStatus=${canonicalStatus} afterBye=${afterBye}`];
  });

  // 0 — sync latency/control upgrade: the phone may attach before the terminal bridge starts.
  await test('late bridge hello upgrades an open Observe socket without reconnect', async () => {
    const sf = join(ROOT, `cabridge-late-${rand()}.jsonl`);
    await Bun.write(
      sf,
      JSON.stringify({ type: 'session', version: 3, id: 'late', timestamp: new Date().toISOString(), cwd: RUNTIME_CWD }) + '\n',
    );
    const id = enc(sf);
    const p = await attach(id);
    await sleep(400);
    const before = p.frames.find((f) => f.kind === 'session')?.info;
    const id2 = await hello(sf, RUNTIME_CWD);
    const upgraded = await p.waitFrame(
      (f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true && f.info?.control?.drive?.state === 'unavailable',
      3000,
    );
    p.send({ kind: 'prompt', text: 'from app after sync' });
    const queued = await commands(id);
    p.close();
    try { rmSync(sf, { force: true }); } catch { /* ignore */ }
    const prompt = queued.find((c: any) => c?.kind === 'prompt' && /after sync/.test(String(c.text ?? '')));
    const ok = before?.control?.terminalSync?.active === false && id2 === id && !!upgraded && !!prompt;
    return [ok, `beforeActive=${before?.control?.terminalSync?.active} sameId=${id2 === id} upgraded=${!!upgraded} promptQueued=${!!prompt}`];
  });

  // 1 — the bug: a reload must NOT orphan the attached phone.
  await test('reload keeps the phone attached (no orphan)', async () => {
    const sf = join(ROOT, `cabridge-${rand()}.jsonl`);
    const id = await hello(sf, RUNTIME_CWD);
    const p = await attach(id);
    await sleep(400); // attach completes (session + history sent)
    const info = p.frames.find((f) => f.kind === 'session')?.info;
    const controlActive = info?.control?.terminalSync?.active === true;
    const driveUnavailable = info?.control?.drive?.supported === false && info.control.drive.state === 'unavailable';
    await events(id, [{ t: 'status', running: true }, { t: 'delta', kind: 'text', key: 't1:t', delta: 'PRE' }]);
    const gotPre = await p.waitFrame(isModelDelta('PRE'), 3000);
    // reload: old runtime byes, new runtime re-hellos the SAME session file (→ same id), immediately.
    await bye(id, 'reload');
    const id2 = await hello(sf, RUNTIME_CWD);
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'POST' }]);
    const gotPost = await p.waitFrame(isModelDelta('POST'), 3000);
    const noEnded = !p.frames.some((f) => f.kind === 'ended');
    p.close();
    const ok = id2 === id && controlActive && driveUnavailable && !!gotPre && !!gotPost && noEnded;
    return [ok, `sameId=${id2 === id} syncActive=${controlActive} driveUnavailable=${driveUnavailable} pre=${!!gotPre} post=${!!gotPost} noEndedFrame=${noEnded}`];
  });

  // 2 — quit: clean `ended` frame, then the bridge is gone.
  await test('quit sends a clean `ended` frame and removes the bridge', async () => {
    const sf = join(ROOT, `cabridge-q-${rand()}.jsonl`);
    const id = await hello(sf, RUNTIME_CWD);
    const p = await attach(id);
    await sleep(400);
    await events(id, [{ t: 'status', running: true }]);
    await bye(id, 'quit');
    const ended = await p.waitFrame((f) => f.kind === 'ended', 3000);
    const ghost = await events(id, [{ t: 'delta', kind: 'text', key: 't9:t', delta: 'GHOST' }]); // should 404
    const bridged = await isBridged(id);
    p.close();
    const ok = !!ended && ended.reason === 'quit' && ghost.status === 404 && bridged === false;
    return [ok, `ended=${!!ended} reason=${ended?.reason} ghost=${ghost.status} stillBridged=${bridged}`];
  });

  // 3 — new/resume/fork: immediate teardown, reason passed through.
  for (const reason of ['new', 'resume', 'fork'] as const) {
    await test(`${reason} ends immediately with reason='${reason}'`, async () => {
      const sf = join(ROOT, `cabridge-${reason}-${rand()}.jsonl`);
      const id = await hello(sf, RUNTIME_CWD);
      const p = await attach(id);
      await sleep(400);
      const t0 = Date.now();
      await bye(id, reason);
      const ended = await p.waitFrame((f) => f.kind === 'ended', 3000);
      const dt = Date.now() - t0;
      p.close();
      // "immediate" = well under the grace window (no defer for these reasons).
      const ok = !!ended && ended.reason === reason && dt < GRACE_MS;
      return [ok, `ended=${!!ended} reason=${ended?.reason} dt=${dt}ms (<${GRACE_MS})`];
    });
  }

  // 4 — a reload whose re-hello never comes: grace expires → clean teardown, no leak.
  await test('reload with no re-hello tears down after the grace window', async () => {
    const sf = join(ROOT, `cabridge-g-${rand()}.jsonl`);
    const id = await hello(sf, RUNTIME_CWD);
    const p = await attach(id);
    await sleep(400);
    await bye(id, 'reload'); // deferred GRACE_MS; no re-hello follows
    const bridgedDuringGrace = await isBridged(id); // still live inside the window
    const ended = await p.waitFrame((f) => f.kind === 'ended', GRACE_MS + 2000);
    const bridgedAfter = await isBridged(id);
    p.close();
    const ok = bridgedDuringGrace === true && !!ended && bridgedAfter === false;
    return [ok, `bridgedDuringGrace=${bridgedDuringGrace} endedAfterGrace=${!!ended} stillBridged=${bridgedAfter}`];
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
    return [keptOnNoop && rotatedOnRewrite,
      `keptOnNoop=${keptOnNoop} rotatedOnRewrite=${rotatedOnRewrite}`];
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
    const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
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
        await sleep(200); // past the extension's 60ms event batch, so any hello-time relay has landed
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
        await sleep(200);
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
