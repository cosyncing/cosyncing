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
 *   5. RELOAD keeps the phone attached and authoritatively catches up history — bye(reason:'reload')
 *      then a same-id re-hello can recover a native-persisted prompt whose event POST was lost;
 *      a POST-reload event still reaches the phone, and NO `ended` frame was sent.
 *   6. QUIT ends cleanly — `{kind:'ended', reason:'quit'}`, later events 404, status goes false.
 *   7. GRACE EXPIRY — bye(reason:'reload') with NO re-hello → after the grace window the phone
 *      gets an `ended` frame and the bridge is gone.
 *   8. TURN ATTENTION — the omp-stamped extension asset, driven by broker-queued app prompts,
 *      delivers each collab-prompt turn to the bridge connection's subscribers as one `running`
 *      run-summary before one terminal under its `omp:run:u:remote:…` key (one outcome each in a
 *      real AttentionPolicy), and a reload re-hello's backfill of those finished turns puts no
 *      `running` on the live stream.
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const OMP_BIN = join(ROOT, 'omp');
const OMP_BUN_BIN = join(ROOT, 'runtime', 'bun');
const PI_EMPTY_SESSIONS = join(ROOT, 'pi-empty-sessions');
const DISCOVERY_SESSION_DIR = join(DISCOVERY_AGENT, 'sessions', encodeCwdDir(DISCOVERY_CWD));
const DISCOVERY_SESSION_FILE = join(DISCOVERY_SESSION_DIR, '2026-08-25T00-00-00-000Z_omp-sync.jsonl');

function encodeCwdDir(path: string): string {
  return `--${path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function writeSupportedOmpBinary(ompBin: string, bunBin: string): void {
  mkdirSync(dirname(bunBin), { recursive: true });
  writeFileSync(bunBin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.3.14\\n'; exit 0; fi
if [ "$2" = "--version" ]; then printf '17.4.2\\n'; exit 0; fi
exit 73
`);
  chmodSync(bunBin, 0o755);
  writeFileSync(ompBin, `#!${bunBin}
// fixture
`);
  chmodSync(ompBin, 0o755);
}

// A killed prior run may leave this port-keyed fixture behind. Port reuse must
// not turn that interrupted run into an EEXIST failure in a later clean run.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(DISCOVERY_CWD, { recursive: true });
mkdirSync(DISCOVERY_SESSION_DIR, { recursive: true });
mkdirSync(PI_EMPTY_SESSIONS, { recursive: true });
writeSupportedOmpBinary(OMP_BIN, OMP_BUN_BIN);
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
    COSYNCING_OMP_BIN: OMP_BIN,
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
async function hello(sessionFile: string, cwd: string, nativeId?: string, history?: unknown[]): Promise<string> {
  const r = await post('/omp/bridge/hello', {
    sessionFile,
    cwd,
    title: 'omp-bridge-test',
    nativeId,
    nativeVersion: '17.4.2',
    history,
  });
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
  await test('bridge hello requires exact in-process native version attestation', async () => {
    const sessionFile = join(DISCOVERY_SESSION_DIR, `2026-08-25T00-30-00-000Z_${rand()}.jsonl`);
    const bodies = [
      { sessionFile, cwd: DISCOVERY_CWD },
      { sessionFile, cwd: DISCOVERY_CWD, nativeVersion: '17.4.3' },
    ];
    const responses = await Promise.all(bodies.map((body) => post('/omp/bridge/hello', body)));
    const decoded = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.json().catch(() => ({})) as any,
    })));
    const roster = await currentRoster();
    const ok = decoded.every((entry) => entry.status === 409
      && entry.body.code === 'OMP_BRIDGE_NATIVE_VERSION_UNVERIFIED')
      && !roster.some((session: any) => session.id === enc(sessionFile));
    return [ok, JSON.stringify(decoded)];
  });

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
    const id = await hello(sf, DISCOVERY_CWD, 'identity');
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
      && info?.nativeId === 'identity'
      && info?.control?.terminalSync?.label === 'Synced with omp terminal'
      && info?.control?.terminalSync?.active === true
      && info?.control?.drive?.supported === false
      && info?.control?.drive?.state === 'unavailable'
      && row?.tool === 'omp'
      && row?.nativeId === 'identity'
      && row?.control?.terminalSync?.label === 'Synced with omp terminal';
    return [ok, `frameTool=${info?.tool} native=${info?.nativeId} label=${info?.control?.terminalSync?.label} rowTool=${row?.tool} rowNative=${row?.nativeId} rowLabel=${row?.control?.terminalSync?.label}`];
  });

  // 3 — C9: bridge events are namespaced by the omp dialect, not pi's. The installed asset emits
  // an explicit key (the asset suite pins the rewrite), so this broker fixture must preserve that
  // real event shape instead of relying on bridgeRunSummary's keyless fallback.
  await test('events reach the phone with omp key namespace and source', async () => {
    const sf = `/tmp/omp-bridge-ev-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp', undefined, [
      { t: 'context-usage', value: { tokens: 2048, contextWindow: 32768 } },
    ]);
    const p = await attach(id);
    await sleep(400);
    const replayContext = p.frames.find(
      (f) => f.kind === 'history',
    )?.messages?.find((m: any) => m.type === 'metadata-update' && m.key === 'contextUsage');
    await events(id, [
      { t: 'delta', kind: 'text', key: 't1:t', delta: 'OMPPRE' },
      { t: 'run', key: 'omp:run:turn-7', turnId: 'turn-7', status: 'done' },
      { t: 'context-usage', value: { tokens: 4096, contextWindow: 32768 } },
    ]);
    const gotDelta = await p.waitFrame(isModelDelta('OMPPRE'), 3000);
    const gotRun = await p.waitFrame(
      (f) => f.kind === 'message' && f.message?.type === 'run-summary' && f.message?.key === 'omp:run:turn-7',
      3000,
    );
    const liveContext = await p.waitFrame(
      (f) => f.kind === 'message' && f.message?.type === 'metadata-update' && f.message?.key === 'contextUsage',
      3000,
    );
    const noPiNamespace = !p.frames.some((f) => String(f.message?.key ?? '').startsWith('pi:run:'));
    await bye(id, 'quit');
    p.close();
    const ok = !!gotDelta
      && !!gotRun
      && gotRun.message.source === 'omp-bridge'
      && replayContext?.value?.used === 2048
      && replayContext?.value?.max === 32768
      && liveContext?.message?.value?.used === 4096
      && liveContext?.message?.value?.max === 32768
      && noPiNamespace;
    return [ok, `delta=${!!gotDelta} run=${!!gotRun} source=${gotRun?.message?.source} replayContext=${JSON.stringify(replayContext?.value)} liveContext=${JSON.stringify(liveContext?.message?.value)} noPiNs=${noPiNamespace}`];
  });

  // 4 — the extension's long-poll queue: a phone prompt arrives as a bridge command.
  await test('phone prompt lands in the omp bridge commands queue', async () => {
    const sf = `/tmp/omp-bridge-cmd-${rand()}.jsonl`;
    const id = await hello(sf, '/tmp');
    const p = await attach(id);
    await sleep(400);
    p.send({ kind: 'prompt', text: 'from app over omp bridge', clientMessageId: 'ca.omp.bridge-command' });
    const queued = await commands(id);
    await bye(id, 'quit');
    p.close();
    const prompt: any = queued.find((c: any) => c?.kind === 'prompt' && /over omp bridge/.test(String(c.text ?? '')));
    const durable = prompt?.messageKey?.startsWith('u:remote:') && prompt?.clientKey === 'ca.omp.bridge-command';
    return [!!prompt && durable, `queued=${queued.length} prompt=${!!prompt} durable=${durable}`];
  });

  // 5 — a reload must NOT orphan the attached phone (same policy as pi).
  await test('reload keeps the phone attached (no orphan)', async () => {
    const sf = `/tmp/omp-bridge-${rand()}.jsonl`;
    const prior = { t: 'user', key: 'u:remote:prior', clientKey: 'ca.omp.prior', text: 'prior durable prompt', sentAt: 1000 };
    const recovered = { t: 'user', key: 'u:remote:recovered', clientKey: 'ca.omp.recovered', text: 'persisted before event post', sentAt: 2000 };
    const id = await hello(sf, '/tmp', undefined, [prior]);
    const p = await attach(id);
    await sleep(400);
    const initialHistory = p.frames.find((f) => f.kind === 'history');
    const initialPrior = initialHistory?.messages?.find((m: any) => m.key === prior.key && m.clientKey === prior.clientKey);
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'PRE' }]);
    const gotPre = await p.waitFrame(isModelDelta('PRE'), 3000);
    // reload: old runtime byes, new runtime re-hellos the SAME session file (→ same id), immediately.
    await bye(id, 'reload');
    const id2 = await hello(sf, '/tmp', undefined, [prior, recovered]);
    const caughtUp = await p.waitFrame(
      (f) => f.kind === 'history'
        && f.reset === true
        && f.messages?.filter((m: any) => m.key === recovered.key && m.clientKey === recovered.clientKey).length === 1,
      3000,
    );
    await events(id, [{ t: 'delta', kind: 'text', key: 't1:t', delta: 'POST' }]);
    const gotPost = await p.waitFrame(isModelDelta('POST'), 3000);
    const noEnded = !p.frames.some((f) => f.kind === 'ended');
    p.close();
    const ok = id2 === id && !!initialPrior && !!caughtUp && !!gotPre && !!gotPost && noEnded;
    return [ok, `sameId=${id2 === id} prior=${!!initialPrior} caughtUp=${!!caughtUp} pre=${!!gotPre} post=${!!gotPost} noEndedFrame=${noEnded}`];
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
  // A native model can carry an id and NO provider — the shipped bridge extension
  // sends `String(model.provider ?? '')` for exactly that case. `currentModel`
  // cannot express it (`validSessionCurrentModel` rejects an empty providerID), so
  // the hello must drop the model claim and still ATTACH. It used to build
  // `providerID: ''`, fail its decode, and reject the whole hello — and because
  // `adopt` had no close guard, the bridge connection stayed registered and every
  // re-hello repeated it.
  await test('a bridge hello whose model has no provider still attaches, without the model claim', async () => {
  const response = await post('/omp/bridge/hello', {
    sessionFile: DISCOVERY_SESSION_FILE,
    cwd: DISCOVERY_CWD,
    title: 'omp-no-provider',
    nativeVersion: '17.4.2',
    model: { modelID: 'qwen3:4b' }, // id, no providerID — the reported shape
  });
  const body: any = await response.json().catch(() => ({}));
  const id = String(body?.id ?? '');
  const rows = await rosterSessions(BROKER_CONTRACT_REVISION);
  const row = rows.find((r: any) => r.id === id);
  const ok = response.status === 200 && id.length > 0
    && row !== undefined && row.currentModel === undefined;
  return [ok, `status=${response.status} id=${id ? 'set' : 'missing'} currentModel=${JSON.stringify(row?.currentModel)}`];
});

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
  const collisionOmpBin = join(collisionRoot, 'omp');
  const collisionBunBin = join(collisionRoot, 'runtime', 'bun');
  rmSync(collisionRoot, { recursive: true, force: true });
  mkdirSync(sharedAgent, { recursive: true });
  mkdirSync(sharedSessions, { recursive: true });
  writeSupportedOmpBinary(collisionOmpBin, collisionBunBin);
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
        COSYNCING_OMP_BIN: collisionOmpBin,
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
        body: JSON.stringify({ sessionFile: sharedSessionFile, cwd: collisionRoot, title: 'omp duplicate', nativeVersion: '17.4.2' }),
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

// A future readable OMP store remains roster-visible, but no bridge leg may register or mutate it
// until that exact native protocol has been physically verified.
{
  const futureLease = await reserveLoopbackFixturePort();
  const futurePort = futureLease.port;
  const futureRoot = join('/tmp', `cosyncing-omp-bridge-future-${futurePort}`);
  const futureBin = join(futureRoot, 'omp-future');
  rmSync(futureRoot, { recursive: true, force: true });
  mkdirSync(futureRoot, { recursive: true });
  writeFileSync(futureBin, `#!/usr/bin/env bun
if (process.argv.includes('--version')) { console.log('17.4.3'); process.exit(0); }
process.exit(73);
`);
  chmodSync(futureBin, 0o755);
  await futureLease.release();
  const futureOrigin = `http://127.0.0.1:${futurePort}`;
  const futureBroker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: isolatedBrokerFixtureEnvironment(futureRoot, {
      overrides: {
        PORT: String(futurePort),
        HOST: '127.0.0.1',
        COSYNCING_OMP_BIN: futureBin,
        COSYNCING_OMP_AGENT_DIR: join(futureRoot, 'omp-agent'),
        COSYNCING_OMP_SESSIONS_ROOT: join(futureRoot, 'omp-sessions'),
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const futureOutput = captureProcessOutput(futureBroker);
  try {
    await waitForBrokerHealth(futureBroker, `${futureOrigin}/api/health`);
    await test('future omp version rejects every bridge route and native rename advertisement', async () => {
      const helloResponse = await fetch(`${futureOrigin}/omp/bridge/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionFile: join(futureRoot, 'future.jsonl'), cwd: futureRoot, nativeVersion: '17.4.2' }),
      });
      const helloBody = await helloResponse.json().catch(() => ({})) as any;
      const otherStatuses = await Promise.all([
        fetch(`${futureOrigin}/omp/bridge/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
        fetch(`${futureOrigin}/omp/bridge/commands?id=future`),
        fetch(`${futureOrigin}/omp/bridge/status?id=future`),
        fetch(`${futureOrigin}/omp/bridge/bye`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ]).then((responses) => responses.map((response) => response.status));
      const agents = await (await fetch(
        `${futureOrigin}/api/agents?contractRevision=${BROKER_CONTRACT_REVISION}`,
      )).json() as any[];
      const omp = agents.find((agent) => agent.id === 'omp');
      const ok = helloResponse.status === 409
        && helloBody.code === 'omp-posix-version-above-verified'
        && otherStatuses.every((status) => status === 409)
        && omp?.supportsCreateSession === true
        && omp?.canCreateSession === false
        && omp?.canRenameNative === false;
      return [ok, `hello=${helloResponse.status}/${helloBody.code} others=${otherStatuses.join(',')} create=${omp?.canCreateSession} rename=${omp?.canRenameNative}`];
    });
  } finally {
    futureBroker.kill();
    await futureBroker.exited;
    await settledProcessOutput(futureOutput);
    rmSync(futureRoot, { recursive: true, force: true });
  }
}

// 8 — turn attention through omp's OWN bridge asset. The broker raises "Turn finished"/"Turn
// failed" only for a LIVE `running` run-summary followed by a terminal one under the same key. The
// shipped omp asset (routes, `omp:run:` keys and `omp-bridge` sources rewritten, native version
// attested from `@oh-my-pi/pi-utils/dirs`) runs against an in-process stand-in for the
// `/omp/bridge/*` routes backed by a real omp-dialect PiBridgeRegistry. App prompts are minted by
// the bridge connection itself, so each turn is keyed by its durable collab-prompt correlation.
{
  const { OMP_BRIDGE_EMBEDDED_SOURCE } = await import('../../../adapters/omp/src/bridge-asset.ts');
  const { OMP_DIALECT } = await import('../../../adapters/omp/src/dialect.ts');
  const { PiBridgeRegistry } = await import('../../../pi-engine/src/bridge.ts');
  const { AttentionPolicy } = await import('../../src/attention/attention-policy.ts');
  const { AttentionStore } = await import('../../src/attention/attention-store.ts');
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-omp-bridge-attention-'));
  const extensionDir = join(root, 'extension');
  // The asset imports its version from the native package that loads it; stand one in.
  const nativeUtils = join(extensionDir, 'node_modules', '@oh-my-pi', 'pi-utils');
  mkdirSync(nativeUtils, { recursive: true });
  writeFileSync(join(nativeUtils, 'package.json'), JSON.stringify({ name: '@oh-my-pi/pi-utils', version: '17.4.2', type: 'module' }));
  writeFileSync(join(nativeUtils, 'dirs.js'), "export const VERSION = '17.4.2';\n");
  const sessionFile = join(root, '2026-09-23T00-00-00-000Z_omp-attention.jsonl');
  const bridgeId = Buffer.from(sessionFile, 'utf8').toString('base64url');
  const registry = new PiBridgeRegistry(() => undefined, 5_000, OMP_DIALECT);
  const frames: { phase: string; message: any }[] = [];
  let phase = 'live';
  const helloBodies: any[] = [];
  const queuedCommands: any[] = [];
  let polls = 0;
  let subscribed = false;
  const fakeBroker = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/omp/bridge/hello') {
        const body: any = await req.json();
        helloBodies.push(body);
        // The broker's hello route in miniature: a re-hello reclaims the same connection, then the
        // backfill lands.
        const conn = registry.hello(bridgeId, {
          id: bridgeId, tool: 'omp', title: 'omp attention', cwd: root, status: 'idle', attachMode: 'live',
        } as any);
        if (!subscribed) {
          subscribed = true;
          conn.subscribe((message) => frames.push({ phase, message }));
        }
        conn.ingestHistory(body.history);
        return Response.json({ ok: true, id: bridgeId });
      }
      if (url.pathname === '/omp/bridge/events') {
        const body: any = await req.json();
        const conn = registry.get(String(body?.id ?? ''));
        if (!conn) return new Response('unknown bridge', { status: 404 });
        for (const ev of body.events ?? []) conn.ingest(ev);
        return Response.json({ ok: true });
      }
      if (url.pathname === '/omp/bridge/commands') {
        if (!registry.get(url.searchParams.get('id') ?? '')) return new Response('unknown bridge', { status: 404 });
        polls += 1;
        await sleep(40); // stand in for the long poll so the loop doesn't spin hot
        return Response.json({ commands: queuedCommands.splice(0) });
      }
      if (url.pathname === '/omp/bridge/bye') {
        const body: any = await req.json();
        registry.bye(String(body?.id ?? ''), body?.reason);
      }
      return Response.json({ ok: true });
    },
  });
  const envKeys = ['COSYNCING_BROKER', 'COSYNCING_BRIDGE_CONFIG', 'COSYNCING_OMP_INTEGRATION_FILE', 'COSYNCING_OMP_INTEGRATION_TOKEN', 'COSYNCING_NO_BRIDGE'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  // Read once at module load: the asset must reach this stand-in and no host config.
  process.env.COSYNCING_BROKER = `http://127.0.0.1:${fakeBroker.port}`;
  process.env.COSYNCING_BRIDGE_CONFIG = join(root, 'absent-config.json');
  process.env.COSYNCING_OMP_INTEGRATION_FILE = join(root, 'absent-integration.json');
  delete process.env.COSYNCING_OMP_INTEGRATION_TOKEN;
  delete process.env.COSYNCING_NO_BRIDGE;
  let entries: any[] = [];
  const ctx = {
    cwd: root,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => 'omp-attention',
      getEntries: () => entries,
    },
    ui: { setStatus() {} },
    isIdle: () => true,
  };
  // What native omp persists for an app prompt, and the assistant entry closing its turn.
  const persisted: any[] = [];
  let instances = 0;
  // A fresh module instance per extension runtime, as a reload re-instantiates it. The fake host
  // plays each injected collab-prompt as one omp turn; `error` in the text fails the turn.
  const loadExtension = async () => {
    const handlers = new Map<string, (event: any, c: any) => unknown>();
    const modulePath = join(extensionDir, `index-${++instances}.ts`);
    writeFileSync(modulePath, OMP_BRIDGE_EMBEDDED_SOURCE);
    const fire = async (name: string, event: any = {}) => { await handlers.get(name)?.(event, ctx); };
    const ext = (await import(modulePath)).default;
    ext({
      on: (name: string, fn: (event: any, c: any) => unknown) => { handlers.set(name, fn); },
      registerTool() {},
      sendMessage(message: any) {
        const start = Number(message?.details?.sentAt) || Date.now();
        const failed = String(message?.content ?? '').includes('error');
        const assistant = {
          role: 'assistant',
          stopReason: failed ? 'error' : 'stop',
          ...(failed ? { error: { message: 'fixture failure' } } : {}),
          content: [{ type: 'text', text: `reply: ${message?.content}` }],
          usage: { input: 1, output: 1 },
        };
        const userId = `omp-user-${persisted.length}`;
        persisted.push(
          { type: 'custom_message', id: userId, parentId: persisted.at(-1)?.id ?? null, timestamp: new Date(start).toISOString(), ...message },
          { type: 'message', id: `omp-assistant-${persisted.length}`, parentId: userId, timestamp: new Date(start + 2_000).toISOString(), message: assistant },
        );
        setTimeout(() => void (async () => {
          await fire('agent_start', { timestamp: start });
          await fire('turn_start', { timestamp: start });
          await fire('message_start', { message: { role: 'custom', ...message, timestamp: start } });
          await fire('message_update', { assistantMessageEvent: { type: 'text_delta', delta: assistant.content[0]!.text } });
          await fire('message_end', { timestamp: start + 2_000, message: assistant });
          // OMP's ExtensionAPI marks a nonterminal attempt with willContinue.
          await fire('agent_end', { timestamp: start + 2_000, willContinue: false });
        })(), 0);
      },
      getThinkingLevel: () => undefined,
      setModel: async () => true,
      setThinkingLevel() {},
    } as any);
    return fire;
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
  const session = { id: bridgeId, tool: 'omp', title: 'omp attention', status: 'idle', attachMode: 'live' } as any;
  let delivered = 0;
  const deliverFrames = async () => {
    for (const f of frames.slice(delivered)) await policy.handleMessage(session, f.message);
    delivered = frames.length;
  };
  const outcomes = (kind: string, key: string) =>
    store.listEvents().filter((event) => event.kind === kind && event.dedupeKey === `${kind}:omp:${bridgeId}:${key}`).length;
  const turnKeys: string[] = [];
  let fire = await loadExtension();
  try {
    await test('an app-driven omp bridge turn is one running then one terminal under its correlation key', async () => {
      await fire('session_start');
      const linked = await waitUntil(() => polls > 0);
      const conn = registry.get(bridgeId)!;
      for (const text of ['omp bridged done', 'omp bridged error']) {
        await conn.sendPrompt({ text, clientMessageId: `ca.omp.${text.replaceAll(' ', '-')}` });
        const commands = await conn.takeCommands();
        turnKeys.push(`omp:run:${commands.find((c) => c.kind === 'prompt')?.messageKey}`);
        queuedCommands.push(...commands);
        await waitUntil(() => summariesIn('live').some((m) => m.key === turnKeys.at(-1) && m.status !== 'running'));
      }
      const live = statusesByKey(summariesIn('live'));
      const ok = linked
        && helloBodies[0]?.nativeVersion === '17.4.2'
        && turnKeys.every((key) => key.startsWith('omp:run:u:remote:'))
        && live.size === 2
        && JSON.stringify(live.get(turnKeys[0]!)) === '["running","done"]'
        && JSON.stringify(live.get(turnKeys[1]!)) === '["running","error"]'
        && summariesIn('live').every((m) => m.source === 'omp-bridge');
      return [ok, `linked=${linked} nativeVersion=${helloBodies[0]?.nativeVersion} pairs=${JSON.stringify([...live])}`];
    });

    await test('a real AttentionPolicy raises exactly one outcome per live omp bridge turn', async () => {
      await deliverFrames();
      const ok = store.listEvents().length === 2
        && outcomes('run-finished', turnKeys[0]!) === 1
        && outcomes('run-failed', turnKeys[1]!) === 1
        && store.listObservations().length === 0;
      return [ok, `events=${JSON.stringify(store.listEvents().map((event) => event.dedupeKey))} open=${store.listObservations().length}`];
    });

    await test('an omp reload re-hello backfill of the finished turns emits no live running and raises nothing', async () => {
      phase = 'reload';
      entries = [...persisted];
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
        && JSON.stringify(backfill.get(turnKeys[0]!)) === '["done"]'
        && JSON.stringify(backfill.get(turnKeys[1]!)) === '["error"]'
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
    rmSync(root, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
