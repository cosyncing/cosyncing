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
 */
export {};
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureProcessOutput,
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
  catch (e) { results.push({ name, ok: false, detail: String(e) }); console.log('FAIL  threw: ' + e); }
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
    const sf = `/tmp/cabridge-late-${rand()}.jsonl`;
    await Bun.write(
      sf,
      JSON.stringify({ type: 'session', version: 3, id: 'late', timestamp: new Date().toISOString(), cwd: '/tmp' }) + '\n',
    );
    const id = enc(sf);
    const p = await attach(id);
    await sleep(400);
    const before = p.frames.find((f) => f.kind === 'session')?.info;
    const id2 = await hello(sf, '/tmp');
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
    const sf = `/tmp/cabridge-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
    const p = await attach(id);
    await sleep(400); // attach completes (session + history sent)
    const info = p.frames.find((f) => f.kind === 'session')?.info;
    const controlActive = info?.control?.terminalSync?.active === true;
    const driveUnavailable = info?.control?.drive?.supported === false && info.control.drive.state === 'unavailable';
    await events(id, [{ t: 'status', running: true }, { t: 'delta', kind: 'text', key: 't1:t', delta: 'PRE' }]);
    const gotPre = await p.waitFrame(isModelDelta('PRE'), 3000);
    // reload: old runtime byes, new runtime re-hellos the SAME session file (→ same id), immediately.
    await bye(id, 'reload');
    const id2 = await hello(sf, '/tmp');
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'POST' }]);
    const gotPost = await p.waitFrame(isModelDelta('POST'), 3000);
    const noEnded = !p.frames.some((f) => f.kind === 'ended');
    p.close();
    const ok = id2 === id && controlActive && driveUnavailable && !!gotPre && !!gotPost && noEnded;
    return [ok, `sameId=${id2 === id} syncActive=${controlActive} driveUnavailable=${driveUnavailable} pre=${!!gotPre} post=${!!gotPost} noEndedFrame=${noEnded}`];
  });

  // 2 — quit: clean `ended` frame, then the bridge is gone.
  await test('quit sends a clean `ended` frame and removes the bridge', async () => {
    const sf = `/tmp/cabridge-q-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
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
      const sf = `/tmp/cabridge-${reason}-${rand()}.jsonl`;
      const id = await hello(sf, '/tmp');
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
    const sf = `/tmp/cabridge-g-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
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
