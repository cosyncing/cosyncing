/**
 * Broker-side regression for the omp (oh-my-pi) bridge family (C7–C9 of the omp adapter
 * investigation): the `/omp/bridge/*` routes must behave exactly like `/pi/bridge/*` while
 * stamping every session, frame, and roster row with omp identity.
 *
 * Pure broker-side: it simulates the in-session extension over the `/omp/bridge/*` HTTP wire and
 * a phone over the attach WebSocket. No real `omp` is needed — the bridge endpoints are
 * in-memory, and a WS attach to an already-adopted (pinned) bridge reuses it WITHOUT spawning
 * `omp --mode rpc`. It starts its OWN broker on a free port with a short grace window, so it
 * never touches a running broker or real sessions.
 *
 *   bun run test:omp-bridge
 * Exit 0 = all pass.
 *
 * What it proves:
 *   1. DISCOVERY identity — a disk-discovered omp session (through a symlinked agent dir) and a
 *      bridge hello for the realpath produce ONE canonical id, on a roster row with tool 'omp'.
 *   2. HELLO identity — the session frame and roster row carry the omp terminal-sync label and
 *      the unavailable Drive control, not pi's strings.
 *   3. EVENT namespacing (C9) — a real extension-shaped `{t:'run'}` event carrying its rewritten
 *      `omp:run:<turnId>` key reaches the phone unchanged with source `omp-bridge`; a text delta
 *      fans out.
 *   4. COMMANDS round-trip — a phone prompt lands in the extension's long-polled queue.
 *   5. RELOAD keeps the phone attached — bye(reason:'reload') then a same-id re-hello → a
 *      POST-reload event still reaches the phone, and NO `ended` frame was sent.
 *   6. QUIT ends cleanly — `{kind:'ended', reason:'quit'}`, later events 404, status goes false.
 *   7. GRACE EXPIRY — bye(reason:'reload') with NO re-hello → after the grace window the phone
 *      gets an `ended` frame and the bridge is gone.
 */
export {};
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROKER_CONTRACT_REVISION,
  CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY,
} from '@cosyncing/protocol';
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
const ROOT = join('/tmp', `cosyncing-omp-bridge-${PORT}`);
const DISCOVERY_CWD = join(ROOT, 'work');
const DISCOVERY_AGENT = join(ROOT, 'agent');
const DISCOVERY_AGENT_LINK = join(ROOT, 'agent-link');
const PI_EMPTY_SESSIONS = join(ROOT, 'pi-empty-sessions');
const DISCOVERY_SESSION_DIR = join(DISCOVERY_AGENT, 'sessions', encodeCwdDir(DISCOVERY_CWD));
const DISCOVERY_SESSION_FILE = join(DISCOVERY_SESSION_DIR, '2026-08-25T00-00-00-000Z_omp-sync.jsonl');

function encodeCwdDir(path: string): string {
  return `--${path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// A killed prior run may leave this port-keyed fixture behind. Port reuse must
// not turn that interrupted run into an EEXIST failure in a later clean run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DISCOVERY_CWD, { recursive: true });
mkdirSync(DISCOVERY_SESSION_DIR, { recursive: true });
mkdirSync(PI_EMPTY_SESSIONS, { recursive: true });
writeFileSync(
  DISCOVERY_SESSION_FILE,
  JSON.stringify({ type: 'session', version: 3, id: 'omp-sync', timestamp: new Date().toISOString(), cwd: DISCOVERY_CWD }) + '\n',
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
    // Pin omp through its dialect-specific override. Pi stays on its own agent directory and an
    // empty sessions root, proving the broker does not need shared Pi-family variables here.
    COSYNCING_OMP_SESSIONS_ROOT: '',
    PI_CODING_AGENT_SESSION_DIR: '',
    PI_CODING_AGENT_DIR: '',
    COSYNCING_OMP_AGENT_DIR: DISCOVERY_AGENT_LINK,
    COSYNCING_PI_SESSIONS_ROOT: PI_EMPTY_SESSIONS,
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
  const r = await post('/omp/bridge/hello', { sessionFile, cwd, title: 'omp-bridge-test' });
  return String((await r.json()).id);
}
const events = (id: string, evs: unknown[]) => post('/omp/bridge/events', { id, events: evs });
const bye = (id: string, reason: string) => post('/omp/bridge/bye', { id, reason });
const commands = async (id: string): Promise<unknown[]> =>
  ((await (await fetch(`${BROKER}/omp/bridge/commands?id=${encodeURIComponent(id)}`)).json()).commands ?? []);
const isBridged = async (id: string): Promise<boolean> =>
  (await (await fetch(`${BROKER}/omp/bridge/status?id=${encodeURIComponent(id)}`)).json()).bridged;

// The roster is visibility-filtered by the caller's declared contract revision: omp rows carry
// OmpAdapter.minimumClientRevision is the explicit first-client OMP identity revision, so both a
// revisionless request and the immediately preceding released client must not see OMP at all.
const rosterSessions = async (revision?: number): Promise<any[]> =>
  ((await (await fetch(revision === undefined
    ? `${BROKER}/api/sessions`
    : `${BROKER}/api/sessions?contractRevision=${revision}`)).json()).sessions ?? []);
const currentRoster = () => rosterSessions(BROKER_CONTRACT_REVISION);

// ── phone (attach WebSocket) ─────────────────────────────────────────────────
interface Phone { frames: any[]; waitFrame: (p: (f: any) => boolean, ms: number) => Promise<any>; send: (o: unknown) => void; close: () => void; }
function attach(id: string): Promise<Phone> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/api/sessions/omp/${encodeURIComponent(id)}/stream`);
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
  // 1 — disk discovery through a symlinked omp root and a bridge hello for the realpath must
  // produce ONE canonical id, on a row stamped tool 'omp' (the shared bridgeId, C9). The same
  // row is INVISIBLE to a revisionless client: the C7 visibility floor hides omp from clients
  // that predate omp roster identity.
  await test('bridge hello id matches symlinked disk-discovery id, hidden below the visibility floor', async () => {
    const revisionlessRoster = await rosterSessions();
    const priorClientRoster = await rosterSessions(CLIENT_REVISION_WITH_OMP_ROSTER_IDENTITY - 1);
    const hidden = !revisionlessRoster.some((s: any) => s?.tool === 'omp')
      && !priorClientRoster.some((s: any) => s?.tool === 'omp');
    const discovered = (await currentRoster()).find((s: any) => s?.tool === 'omp' && s?.cwd === DISCOVERY_CWD);
    const id = await hello(realpathSync(DISCOVERY_SESSION_FILE), DISCOVERY_CWD);
    await bye(id, 'quit');
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const ok = hidden && discovered?.id === id && decoded === realpathSync(DISCOVERY_SESSION_FILE);
    return [ok, `hidden=${hidden} discovered=${discovered?.id === id} decodedRealpath=${decoded === realpathSync(DISCOVERY_SESSION_FILE)}`];
  });

  // 2 — hello publishes omp identity: the roster row and the attach session frame carry the omp
  // terminal-sync label and Drive-unavailable control, never pi's strings. The session file sits
  // in the discovery tree so the roster row is the discovered one, as on a real host.
  await test('hello publishes omp roster and session-frame identity', async () => {
    const sf = join(DISCOVERY_SESSION_DIR, `2026-08-25T01-00-00-000Z_${rand()}.jsonl`);
    writeFileSync(
      sf,
      JSON.stringify({ type: 'session', version: 3, id: 'identity', timestamp: new Date().toISOString(), cwd: DISCOVERY_CWD }) + '\n',
    );
    const id = await hello(sf, DISCOVERY_CWD);
    const p = await attach(id);
    await sleep(400); // attach completes (session + history sent)
    const info = p.frames.find((f) => f.kind === 'session')?.info;
    let row: any;
    for (let waited = 0; waited < 3000 && !row; waited += 200) {
      row = (await currentRoster()).find((s: any) => s?.id === id);
      if (!row) await sleep(200);
    }
    await bye(id, 'quit');
    p.close();
    const ok = info?.tool === 'omp'
      && info?.control?.terminalSync?.label === 'Synced with omp terminal'
      && info?.control?.terminalSync?.active === true
      && info?.control?.drive?.supported === false
      && info?.control?.drive?.state === 'unavailable'
      && row?.tool === 'omp'
      && row?.control?.terminalSync?.label === 'Synced with omp terminal';
    return [ok, `frameTool=${info?.tool} label=${info?.control?.terminalSync?.label} rowTool=${row?.tool} rowLabel=${row?.control?.terminalSync?.label}`];
  });

  // 3 — C9: bridge events are namespaced by the omp dialect, not pi's. The installed asset emits
  // an explicit key (the asset suite pins the rewrite), so this broker fixture must preserve that
  // real event shape instead of relying on bridgeRunSummary's keyless fallback.
  await test('events reach the phone with omp key namespace and source', async () => {
    const sf = `/tmp/omp-bridge-ev-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
    const p = await attach(id);
    await sleep(400);
    await events(id, [
      { t: 'delta', kind: 'text', key: 't1:t', delta: 'OMPPRE' },
      { t: 'run', key: 'omp:run:turn-7', turnId: 'turn-7', status: 'done' },
    ]);
    const gotDelta = await p.waitFrame(isModelDelta('OMPPRE'), 3000);
    const gotRun = await p.waitFrame(
      (f) => f.kind === 'message' && f.message?.type === 'run-summary' && f.message?.key === 'omp:run:turn-7',
      3000,
    );
    const noPiNamespace = !p.frames.some((f) => String(f.message?.key ?? '').startsWith('pi:run:'));
    await bye(id, 'quit');
    p.close();
    const ok = !!gotDelta && !!gotRun && gotRun.message.source === 'omp-bridge' && noPiNamespace;
    return [ok, `delta=${!!gotDelta} run=${!!gotRun} source=${gotRun?.message?.source} noPiNs=${noPiNamespace}`];
  });

  // 4 — the extension's long-poll queue: a phone prompt arrives as a bridge command.
  await test('phone prompt lands in the omp bridge commands queue', async () => {
    const sf = `/tmp/omp-bridge-cmd-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
    const p = await attach(id);
    await sleep(400);
    p.send({ kind: 'prompt', text: 'from app over omp bridge' });
    const queued = await commands(id);
    await bye(id, 'quit');
    p.close();
    const prompt = queued.find((c: any) => c?.kind === 'prompt' && /over omp bridge/.test(String(c.text ?? '')));
    return [!!prompt, `queued=${queued.length} prompt=${!!prompt}`];
  });

  // 5 — a reload must NOT orphan the attached phone (same policy as pi).
  await test('reload keeps the phone attached (no orphan)', async () => {
    const sf = `/tmp/omp-bridge-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
    const p = await attach(id);
    await sleep(400);
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'PRE' }]);
    const gotPre = await p.waitFrame(isModelDelta('PRE'), 3000);
    // reload: old runtime byes, new runtime re-hellos the SAME session file (→ same id), immediately.
    await bye(id, 'reload');
    const id2 = await hello(sf, '/tmp');
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'POST' }]);
    const gotPost = await p.waitFrame(isModelDelta('POST'), 3000);
    const noEnded = !p.frames.some((f) => f.kind === 'ended');
    p.close();
    const ok = id2 === id && !!gotPre && !!gotPost && noEnded;
    return [ok, `sameId=${id2 === id} pre=${!!gotPre} post=${!!gotPost} noEndedFrame=${noEnded}`];
  });

  // 6 — quit: clean `ended` frame, then the bridge is gone.
  await test('quit sends a clean `ended` frame and removes the bridge', async () => {
    const sf = `/tmp/omp-bridge-q-${rand()}.jsonl`;
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

  // 7 — a reload whose re-hello never comes: grace expires → clean teardown, no leak.
  await test('reload with no re-hello tears down after the grace window', async () => {
    const sf = `/tmp/omp-bridge-g-${rand()}.jsonl`;
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

// A collision must block the broker-owned live route as well as adapter discovery/RPC. Otherwise
// Pi discovers this shared JSONL while an omp hello adopts the same artifact under a second tool id.
{
  const collisionLease = await reserveLoopbackFixturePort();
  const collisionPort = collisionLease.port;
  const collisionRoot = join('/tmp', `cosyncing-omp-bridge-collision-${collisionPort}`);
  const sharedAgent = join(collisionRoot, 'shared-agent');
  const sharedSessions = join(collisionRoot, 'shared-sessions');
  const sharedSessionFile = join(sharedSessions, '2026-08-25_shared.jsonl');
  rmSync(collisionRoot, { recursive: true, force: true });
  mkdirSync(sharedAgent, { recursive: true });
  mkdirSync(sharedSessions, { recursive: true });
  writeFileSync(sharedSessionFile, [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'shared-session',
      timestamp: '2026-08-25T00:00:00.000Z',
      cwd: collisionRoot,
    }),
    JSON.stringify({
      type: 'session_info',
      id: 'shared-title',
      parentId: null,
      timestamp: '2026-08-25T00:00:01.000Z',
      name: 'Shared Pi artifact',
    }),
  ].join('\n') + '\n');
  await collisionLease.release();
  const collisionOrigin = `http://127.0.0.1:${collisionPort}`;
  const collisionBroker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: isolatedBrokerFixtureEnvironment(collisionRoot, {
      overrides: {
        PORT: String(collisionPort),
        HOST: '127.0.0.1',
        PI_CODING_AGENT_DIR: sharedAgent,
        PI_CODING_AGENT_SESSION_DIR: sharedSessions,
        COSYNCING_OMP_AGENT_DIR: '',
        COSYNCING_OMP_SESSIONS_ROOT: '',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collisionOutput = captureProcessOutput(collisionBroker);
  try {
    await waitForBrokerHealth(collisionBroker, `${collisionOrigin}/api/health`);
    await test('shared Pi-family paths reject omp bridge hello before duplicate adoption', async () => {
      const response = await fetch(`${collisionOrigin}/omp/bridge/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionFile: sharedSessionFile, cwd: collisionRoot, title: 'omp duplicate' }),
      });
      const body = await response.json().catch(() => ({})) as any;
      const roster = await (await fetch(
        `${collisionOrigin}/api/sessions?contractRevision=${BROKER_CONTRACT_REVISION}`,
      )).json() as any;
      const sharedRows = (roster.sessions ?? []).filter((session: any) => session.title === 'Shared Pi artifact');
      const ok = response.status === 409
        && body.code === 'omp-pi-path-collision'
        && sharedRows.some((session: any) => session.tool === 'pi')
        && !sharedRows.some((session: any) => session.tool === 'omp');
      return [ok, `status=${response.status} code=${body.code} rows=${JSON.stringify(sharedRows.map((s: any) => s.tool))}`];
    });
  } finally {
    collisionBroker.kill();
    await collisionBroker.exited;
    await settledProcessOutput(collisionOutput);
    rmSync(collisionRoot, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
