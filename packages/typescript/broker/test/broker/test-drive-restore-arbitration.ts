#!/usr/bin/env bun
/**
 * CR1 — restore Drive after owner eviction, atomically at the Hub attach boundary.
 *
 * The 15-second zero-client eviction is desirable hygiene; the regression was failing to
 * reconstruct the owner on demand. These checks prove, with a shortened grace and no real
 * waits, that:
 *
 *  A: create → Driving → last client disconnect → grace eviction → reopen (reason-tagged
 *     resume) → exactly ONE new Resume owner reporting driving+supported (the broker's
 *     canMutate/canPrompt gate input), with NO roster discovery and NO history fetch in
 *     the restoration decision;
 *  B: a second reopen after another eviction (any later time — the broker imposes no TTL;
 *     the 30-minute lease is client-side policy for terminal-origin takeovers only) still
 *     reconstructs exactly one owner;
 *  C: simultaneous restoration requests converge on one owner (one backend attach);
 *  D: an already-mutable bare owner and a pinned (active terminal sync) owner WIN — the
 *     reason-tagged resume joins them instead of spawning a rival;
 *  E: an adapter OwnershipConflictError propagates as a typed conflict (the runtime maps
 *     it to a structured `attach-conflict` frame + Observe fallback), and the fallback
 *     bare attach never leaves a second Resume owner behind;
 *  F: a mode-only attach (no reason) reaches the adapter without attach options — the
 *     legacy compatibility path.
 *  G: the REAL WebSocket path against a spawned broker with the real Codex adapter —
 *     upgrade-time reason validation, current-socket terminal handoff, the structured
 *     `attach-conflict` frame, the in-socket Observe fallback, and proof that a denied
 *     restore spawns no additional Resume owner process.
 */
import {
  captureProcessOutput,
  fixtureWsUrl,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';
import { Hub } from '../../src/sessions/hub.ts';
import { driveAttachRefusalCode } from '../../src/sessions/client-message-policy.ts';
import {
  AgentRegistry,
  isOwnershipConflictError,
  NativeSessionUnresumableError,
  OwnershipConflictError,
  type AgentMessage,
  type AttachMode,
  type AttachOptions,
  type SessionConnection,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(20);
  }
  return undefined;
}

type FakeConn = SessionConnection & { closed: number };

function fakeConn(info: SessionInfo): FakeConn {
  const handlers = new Set<(m: AgentMessage) => void>();
  const conn: any = {
    info: structuredClone(info),
    closed: 0,
    getHistory: async () => {
      historyCalls++;
      return [];
    },
    subscribe: (h: (m: AgentMessage) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    sendPrompt: async () => {},
    respondPermission: async () => {},
    close: async () => {
      conn.closed++;
    },
  };
  return conn;
}

const driving = (id: string): SessionInfo =>
  ({
    id,
    tool: 'fake',
    machine: 'test',
    title: 't',
    status: 'idle',
    attachMode: 'resume',
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: false, syncAvailable: false, active: false },
    },
  }) as SessionInfo;

const observing = (id: string): SessionInfo =>
  ({
    id,
    tool: 'fake',
    machine: 'test',
    title: 't',
    status: 'idle',
    attachMode: 'observe',
    control: {
      drive: { supported: true, state: 'observing' },
      terminalSync: { supported: true, syncAvailable: true, active: false },
    },
  }) as SessionInfo;

let resumeAttaches = 0;
let observeAttaches = 0;
let discoverCalls = 0;
let historyCalls = 0;
let attachDelayMs = 0;
let conflictNextResume: OwnershipConflictError | undefined;
const attachOpts: (AttachOptions | undefined)[] = [];
const liveConns: FakeConn[] = [];

const registry = new AgentRegistry();
registry.register({
  id: 'fake',
  displayName: 'Fake',
  capabilities: {} as any,
  isAvailable: async () => true,
  discoverSessions: async () => {
    discoverCalls++;
    return [];
  },
  attach: async (id: string, mode?: AttachMode, opts?: AttachOptions) => {
    attachOpts.push(opts);
    if (attachDelayMs > 0) await sleep(attachDelayMs);
    if (mode === 'resume') {
      if (conflictNextResume) {
        const err = conflictNextResume;
        conflictNextResume = undefined;
        throw err;
      }
      resumeAttaches++;
      const conn = fakeConn(driving(id));
      liveConns.push(conn);
      return conn;
    }
    observeAttaches++;
    const conn = fakeConn(observing(id));
    liveConns.push(conn);
    return conn;
  },
} as any);

// Shortened grace: the real broker uses 15s; the contract under test is
// "evict after zero-client grace, reconstruct on demand", not the duration.
const GRACE_MS = 40;
const hub = new Hub(registry, GRACE_MS);
const noopClient = () => {};

// ── A: create → Driving → disconnect → eviction → reopen restores ONE owner ──
const first = await hub.ensure('fake', 's1', 'resume', 'create');
check('A1 the create attach carries its reason to the adapter', attachOpts.at(-1)?.reason === 'create');
check('A2 the created owner reports driving+supported (canPrompt gate input)',
  first.conn.info.control?.drive.state === 'driving' && first.conn.info.control?.drive.supported === true);
first.addClient(noopClient);
first.removeClient(noopClient);
hub.release('fake', 's1', 'resume');
await sleep(GRACE_MS * 3);
check('A3 the zero-client owner was evicted after the grace window', (liveConns[0]?.closed ?? 0) === 1,
  `closed=${liveConns[0]?.closed}`);

// Reopen "at +10 minutes": wall-clock is irrelevant to the broker decision.
const restored = await hub.ensure('fake', 's1', 'resume', 'app-restore');
check('A4 reopen reconstructed exactly one new Resume owner', resumeAttaches === 2 && restored !== first,
  `resumeAttaches=${resumeAttaches}`);
check('A5 the restored owner is Driving and prompt-capable',
  restored.conn.info.control?.drive.state === 'driving' && restored.conn.info.control?.drive.supported === true);
check('A6 restoration fetched no roster and no transcript', discoverCalls === 0 && historyCalls === 0,
  `discover=${discoverCalls} history=${historyCalls}`);

// ── B: another eviction, then a much later reopen still restores safely ──────
restored.addClient(noopClient);
restored.removeClient(noopClient);
hub.release('fake', 's1', 'resume');
await sleep(GRACE_MS * 3);
const restoredAgain = await hub.ensure('fake', 's1', 'resume', 'app-restore');
check('B1 a later reopen (past any client-side lease) still restores one owner',
  resumeAttaches === 3 && restoredAgain.conn.info.control?.drive.state === 'driving',
  `resumeAttaches=${resumeAttaches}`);
restoredAgain.addClient(noopClient);
restoredAgain.removeClient(noopClient);
hub.release('fake', 's1', 'resume');
await sleep(GRACE_MS * 3);

// ── C: simultaneous restorations converge on one owner ───────────────────────
attachDelayMs = 30;
const [race1, race2] = await Promise.all([
  hub.ensure('fake', 's1', 'resume', 'app-restore'),
  hub.ensure('fake', 's1', 'resume', 'lease-restore'),
]);
attachDelayMs = 0;
check('C1 concurrent restores share ONE in-flight attach', resumeAttaches === 4, `resumeAttaches=${resumeAttaches}`);
check('C2 both callers received the same owner', race1 === race2);
race1.addClient(noopClient);
race1.removeClient(noopClient);
hub.release('fake', 's1', 'resume');
await sleep(GRACE_MS * 3);

// ── D: existing mutable/pinned owners win over restoration ──────────────────
const bareDriving = await hub.ensure('fake', 's2');
const bareDrivingConn = bareDriving.conn as FakeConn;
bareDriving.conn.info.control = {
  drive: { supported: true, state: 'driving' },
  terminalSync: { supported: false, syncAvailable: false, active: false },
} as any;
const joined = await hub.ensure('fake', 's2', 'resume', 'app-restore');
check('D1 an already-mutable bare owner wins — the restore JOINS it', joined === bareDriving && resumeAttaches === 4,
  `resumeAttaches=${resumeAttaches}`);
joined.addClient(noopClient);
joined.removeClient(noopClient);
hub.releaseAttached('fake', 's2', 'resume', joined);
await sleep(GRACE_MS * 3);
check('D2 a folded resume socket releases the actual bare owner after the grace',
  bareDrivingConn.closed === 1, `closed=${bareDrivingConn.closed}`);

// A joinExisting socket keeps `mode=resume` while the Kimi/dsh owner it joined
// is registered under `#live`; releasing by the requested key alone matched
// neither `#resume` nor the bare key and left the owner alive until dispose.
const liveOwner = await hub.ensure('fake', 's4', 'live');
const liveOwnerConn = liveOwner.conn as FakeConn;
liveOwner.conn.info.control = {
  drive: { supported: true, state: 'driving' },
  terminalSync: { supported: false, syncAvailable: false, active: false },
} as any;
liveOwner.addClient(noopClient);
liveOwner.removeClient(noopClient);
hub.releaseAttached('fake', 's4', 'resume', liveOwner);
await sleep(GRACE_MS * 3);
check('D2b a joined resume socket releases the #live owner it actually holds',
  liveOwnerConn.closed === 1, `closed=${liveOwnerConn.closed}`);

const bridge = fakeConn(observing('s3'));
hub.adopt('fake', 's3', bridge);
const joinedBridge = await hub.ensure('fake', 's3', 'resume', 'lease-restore');
check('D3 an active terminal bridge (pinned) wins — the restore JOINS it',
  joinedBridge.conn === bridge && resumeAttaches === 4);

// ── E: a typed ownership conflict propagates; the fallback leaves no rival ───
check(
  'E0 attach failures map to distinct stable machine codes without session heuristics',
  driveAttachRefusalCode(new OwnershipConflictError('unknown', 'daemon-ownership-unknown')) === 'DRIVE_OWNERSHIP_UNKNOWN' &&
    driveAttachRefusalCode(new OwnershipConflictError('owned', 'terminal-private')) === 'DRIVE_OWNERSHIP_CONFLICT' &&
    driveAttachRefusalCode(new NativeSessionUnresumableError('native refused')) === 'DRIVE_NATIVE_SESSION_UNRESUMABLE' &&
    driveAttachRefusalCode(new Error('other')) === 'DRIVE_RESTORE_FAILED',
);
conflictNextResume = new OwnershipConflictError('a private terminal owns this session', 'terminal-private');
let conflictCaught: unknown;
try {
  await hub.ensure('fake', 's4', 'resume', 'app-restore');
} catch (error) {
  conflictCaught = error;
}
check('E1 the adapter conflict reaches the caller as a typed ownership conflict',
  isOwnershipConflictError(conflictCaught) && (conflictCaught as OwnershipConflictError).conflict === 'terminal-private');
// The runtime answers with `attach-conflict` and re-enters via the bare path:
const fallback = await hub.ensure('fake', 's4');
check('E2 the Observe fallback attached without spawning a Resume owner',
  fallback.conn.info.control?.drive.state === 'observing' && resumeAttaches === 4,
  `resumeAttaches=${resumeAttaches}`);
// A failed reason attach must not leave a poisoned pending entry behind:
const retriedAfterConflict = await hub.ensure('fake', 's4', 'resume', 'takeover');
check('E3 a later explicit takeover can still create the Resume owner', resumeAttaches === 5,
  `resumeAttaches=${resumeAttaches}`);
check('E4 the takeover reason reached the adapter', attachOpts.at(-1)?.reason === 'takeover');
void retriedAfterConflict;

// ── F: mode-only attach stays reason-free (older clients) ────────────────────
await hub.ensure('fake', 's5', 'resume');
check('F1 a mode-only resume reaches the adapter without attach options', attachOpts.at(-1) === undefined);
check('F2 discovery/history stayed untouched across every arbitration', discoverCalls === 0 && historyCalls === 0,
  `discover=${discoverCalls} history=${historyCalls}`);

// A refresh inside the zero-client grace must rejoin the still-live owner, not create another.
{
  const beforeGraceOwner = await hub.ensure('fake', 's-grace', 'resume', 'create');
  const beforeGraceCount = resumeAttaches;
  beforeGraceOwner.addClient(noopClient);
  beforeGraceOwner.removeClient(noopClient);
  hub.release('fake', 's-grace', 'resume');
  await sleep(Math.max(1, Math.floor(GRACE_MS / 4)));
  const withinGrace = await hub.ensure('fake', 's-grace', 'resume', 'app-restore');
  check('F3 refresh within the eviction grace rejoins the resident owner',
    withinGrace === beforeGraceOwner && resumeAttaches === beforeGraceCount);
}

await hub.dispose();

// ── F4: a broker restart has no in-memory owner; durable client intent can reconstruct it ───────
{
  const restartedHub = new Hub(registry, GRACE_MS);
  const beforeRestartRestore = resumeAttaches;
  const afterRestart = await restartedHub.ensure('fake', 's6', 'resume', 'app-restore');
  check('F4 a reason-tagged refresh after broker restart creates exactly one Resume owner',
    resumeAttaches === beforeRestartRestore + 1 && afterRestart.conn.info.control?.drive.state === 'driving',
    `before=${beforeRestartRestore} after=${resumeAttaches}`);
  const joinedAfterRestart = await restartedHub.ensure('fake', 's6', 'resume', 'app-restore');
  check('F5 repeated refresh after broker restart joins that owner instead of duplicating it',
    joinedAfterRestart === afterRestart && resumeAttaches === beforeRestartRestore + 1);
  await restartedHub.dispose();
}

// ── G: the real WebSocket conflict/fallback path (spawned broker, real adapter) ──
{
  const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'cosyncing-arb-ws-'));
  const workDir = join(home, 'work');
  mkdirSync(workDir, { recursive: true });
  const threadUuid = '019f5799-0000-7000-8000-00000000cafe';
  const rollout = join(home, `rollout-2026-07-24T00-00-00-${threadUuid}.jsonl`);
  writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: threadUuid, cwd: workDir } })}\n`);
  const sessionId = Buffer.from(rollout, 'utf8').toString('base64url');
  const daemonSocket = join(home, 'app-server.sock');
  const daemon = new FakeCodexDaemon(daemonSocket, { ignoreMethods: ['initialize'] });
  await daemon.start();

  // Competing-owner evidence for the REAL presence scan: a fake /proc with a
  // live TUI resuming this exact thread against a DIFFERENT daemon socket.
  const procRoot = join(home, 'proc');
  const bootUptimeSec = 5_000;
  mkdirSync(procRoot, { recursive: true });
  writeFileSync(join(procRoot, 'uptime'), `${bootUptimeSec}.00 20000.00\n`);
  const competingProcDir = join(procRoot, '4242');
  const writeCompetingOwner = () => {
    mkdirSync(competingProcDir, { recursive: true });
    writeFileSync(
      join(competingProcDir, 'cmdline'),
      `${['codex', 'resume', '--remote', `unix://${join(home, 'other-daemon.sock')}`, threadUuid].join('\0')}\0`,
    );
    symlinkSync(workDir, join(competingProcDir, 'cwd'));
    writeFileSync(
      join(competingProcDir, 'stat'),
      `4242 (codex tui) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${(bootUptimeSec - 60) * 100} 0 0`,
    );
  };
  writeCompetingOwner();

  // Every codex CLI invocation logs its argv. A Resume owner is specifically
  // `codex app-server --stdio` (broker version/status probes also run the CLI
  // and are fine); none may appear on this denied-restore path.
  const invocationLog = join(home, 'codex-invocations.log');
  const fakeBin = join(home, 'codex');
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(invocationLog)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(0);
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.method === 'initialize' || message.method === 'thread/name/set' || message.method === 'thread/settings/update') {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'thread/loaded/list') {
      console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
    } else if (message.method === 'thread/resume') {
      console.log(JSON.stringify({ id: message.id, result: { thread: { id: ${JSON.stringify(threadUuid)}, name: 'fake', status: { type: 'idle' } }, model: 'fake-model', modelProvider: 'fake-provider' } }));
    }
  }
}
`,
  );
  chmodSync(fakeBin, 0o755);
  const resumeOwnerSpawnCount = () => {
    try {
      return readFileSync(invocationLog, 'utf8').split('\n').filter((line) => line.includes('app-server --stdio')).length;
    } catch {
      return 0;
    }
  };

  const token = 'arb-ws-token';
  const portLease = await reserveLoopbackFixturePort();
  const port = portLease.port;
  const env = isolatedBrokerFixtureEnvironment(home, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_HOME: home,
      COSYNCING_TOKEN: token,
      COSYNCING_MACHINE: 'arb-ws-fixture',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CODEX_BIN: fakeBin,
      COSYNCING_CODEX_PROC_ROOT: procRoot,
      COSYNCING_CODEX_APP_SERVER_SOCK: daemonSocket,
      COSYNCING_CODEX_SYNC_SERVER: '1',
    },
  });
  await portLease.release();
  const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(), env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const brokerOutput = captureProcessOutput(broker);
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const credentialHeaders = { 'x-cosyncing-token': token };
  const ticketedStreamUrl = (
    params: Record<string, string>,
    websocket = false,
  ) => fixtureWsUrl(
    base,
    websocket ? wsBase : base,
    credentialHeaders,
    'codex',
    sessionId,
    params,
  );

  const wsFrames = (url: string, done: (frames: any[]) => boolean, timeoutMs = 15_000): Promise<any[]> =>
    new Promise((resolve, reject) => {
      const frames: any[] = [];
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        resolve(frames);
      }, timeoutMs);
      ws.onmessage = (event) => {
        try {
          frames.push(JSON.parse(String(event.data)));
        } catch {
          /* ignore non-JSON frames */
        }
        if (done(frames)) {
          clearTimeout(timer);
          ws.close();
          resolve(frames);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error('websocket failed'));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        resolve(frames);
      };
    });

  try {
    // Readiness is not one of this suite's assertions, so it gets no
    // wall-clock budget: a broker booting beside other work is slow, not
    // broken.
    let ready = true;
    try {
      await waitForBrokerHealth(broker, `${base}/api/health`);
    } catch (error) {
      ready = false;
      console.log(
        `      ${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`,
      );
    }
    check('G1 fixture broker starts for the WebSocket arbitration path', ready);

    const streamPath = `/api/sessions/codex/${encodeURIComponent(sessionId)}/stream`;
    const badReason = await fetch(await ticketedStreamUrl({ mode: 'resume', reason: 'bogus' }));
    check('G2 an unknown attach reason is rejected before the upgrade', badReason.status === 400);
    const reasonWithoutMode = await fetch(await ticketedStreamUrl({ reason: 'app-restore' }));
    check('G3 a reason without mode=resume is rejected before the upgrade', reasonWithoutMode.status === 400);
    const joinWithoutRevision = await fetch(
      await ticketedStreamUrl({ mode: 'resume', reason: 'join-existing' }),
    );
    check('G3b join-existing without an owner revision is rejected before the upgrade', joinWithoutRevision.status === 400);
    const revisionOnRestore = await fetch(
      await ticketedStreamUrl({
        mode: 'resume', reason: 'app-restore', ownerEpoch: 'epoch', ownerSeq: '1',
      }),
    );
    check('G3c owner revisions are accepted only for join-existing', revisionOnRestore.status === 400);
    const unauthenticatedJoin = await fetch(
      `${base}${streamPath}?mode=resume&reason=join-existing&ownerEpoch=epoch&ownerSeq=1`,
    );
    check('G3d join-existing retains the authenticated Resume credential boundary', unauthenticatedJoin.status === 401);

    // A reason is now valid on `live` as well as `resume`, which opens exactly
    // one new way to reach Drive. These four pin the boundary around it.
    // The credential boundary itself is NOT provable on this fixture: it runs
    // tokened, so the outer `authed` gate answers 401 for every stream and a
    // refusal here would be attributable to either gate. It is proved in the
    // tokenless baseline at the end of this file, which is the only place the
    // two gates disagree.
    //
    // `join-existing` resolves an exact app-owned Drive connection by owner
    // revision, which only the resume path can do.
    const joinOnLive = await fetch(
      await ticketedStreamUrl({
        mode: 'live', reason: 'join-existing', ownerEpoch: 'epoch', ownerSeq: '1',
      }),
    );
    check('G3i join-existing is still refused on a live attach', joinOnLive.status === 400,
      `status=${joinOnLive.status}`);
    const revisionOnTakeover = await fetch(
      await ticketedStreamUrl({
        mode: 'live', reason: 'takeover', ownerEpoch: 'epoch', ownerSeq: '1',
      }),
    );
    check('G3j an owner revision still requires join-existing, on live too',
      revisionOnTakeover.status === 400, `status=${revisionOnTakeover.status}`);

    // The reason/mode MATRIX, not merely "a reason is allowed on live".
    // `create`, `app-restore` and `lease-restore` each describe reopening a
    // Drive connection this app previously owned — the resume path. On live
    // they would name a provenance the live path cannot have, so accepting them
    // would let a client claim app-created ownership of a session it never
    // created. Only `takeover` means "seize the running session".
    const nonTakeoverOnLive: string[] = [];
    for (const badReason of ['create', 'app-restore', 'lease-restore']) {
      const answer = await fetch(await ticketedStreamUrl({ mode: 'live', reason: badReason }));
      if (answer.status !== 400) nonTakeoverOnLive.push(`${badReason}=${answer.status}`);
    }
    check('G3k only takeover is a valid reason on a live attach',
      nonTakeoverOnLive.length === 0, nonTakeoverOnLive.join(' ') || '(all refused 400)');
    // ...and the positive control, so the matrix is not simply refusing live.
    const takeoverOnLive = await fetch(await ticketedStreamUrl({ mode: 'live', reason: 'takeover' }));
    check('G3k2 ...while takeover itself is accepted past parameter validation',
      takeoverOnLive.status !== 400, `status=${takeoverOnLive.status}`);
    // Every one of them stays valid on resume, which is the half that would
    // break silently if the matrix were written as a blanket live refusal.
    const stillValidOnResume: string[] = [];
    for (const goodReason of ['create', 'app-restore', 'lease-restore', 'takeover']) {
      const answer = await fetch(await ticketedStreamUrl({ mode: 'resume', reason: goodReason }));
      if (answer.status === 400) stillValidOnResume.push(goodReason);
    }
    check('G3k3 ...and every reason remains valid on resume',
      stillValidOnResume.length === 0, stillValidOnResume.join(' ') || '(all accepted)');

    // Temporarily remove the simulated terminal owner so this fixture can
    // establish one real Drive socket and exercise the handoff message. The
    // competing owner is restored before the denial checks below.
    daemon.configure({ ignoreMethods: [] });
    rmSync(competingProcDir, { recursive: true, force: true });
    const handoffUrl = await ticketedStreamUrl(
      { mode: 'resume', reason: 'takeover' },
      true,
    );
    const handoffFrames = await new Promise<any[]>((resolve, reject) => {
      const seen: any[] = [];
      const ws = new WebSocket(handoffUrl);
      let requested = false;
      const timer = setTimeout(() => {
        ws.close();
        resolve(seen);
      }, 15_000);
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          seen.push(frame);
          if (!requested && frame.kind === 'session' && frame.authority?.canMutate === true) {
            requested = true;
            ws.send(JSON.stringify({ kind: 'handoff', clientMessageId: 'handoff-wire-1' }));
          }
        } catch {
          /* ignore non-JSON frames */
        }
        if (seen.some((frame) => frame.kind === 'ack' && frame.clientMessageId === 'handoff-wire-1')
          && seen.some((frame) => frame.kind === 'session' && frame.info?.sessionOwner?.state === 'none')) {
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error('handoff websocket failed'));
      };
    });
    check(
      'G3e current-socket handoff is acknowledged only after owner truth leaves Drive',
      handoffFrames.some((frame) => frame.kind === 'ack' && frame.clientMessageId === 'handoff-wire-1')
        && handoffFrames.some((frame) => frame.kind === 'session' && frame.info?.sessionOwner?.state === 'none')
        && !handoffFrames.some((frame) => frame.kind === 'nack'),
      JSON.stringify(handoffFrames),
    );
    // ── G3f: a socket that declares itself read-only is enforced as read-only ─
    // Asked here, in the one window where this exact request DID produce a
    // mutable driver (G3e above): same session, same daemon state, same
    // `mode=resume&reason=takeover`. The only difference is the declaration, so
    // a refusal cannot be blamed on the fixture having moved on.
    //
    // Omitting `mode` would not prove this. A bare attach is read-only for one
    // adapter, refused by another, and full-authority for a third, so the
    // client's silence cannot be the guarantee — the broker's enforcement is.
    const resumeSpawnsBeforeReadOnly = resumeOwnerSpawnCount();
    const readOnlyUrl = await ticketedStreamUrl(
      { mode: 'resume', reason: 'takeover', readOnly: '1' },
      true,
    );
    const readOnlyFrames = await new Promise<any[]>((resolve, reject) => {
      const seen: any[] = [];
      const ws = new WebSocket(readOnlyUrl);
      let asked = false;
      const timer = setTimeout(() => { ws.close(); resolve(seen); }, 15_000);
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          seen.push(frame);
          if (!asked && frame.kind === 'session') {
            asked = true;
            ws.send(JSON.stringify({ kind: 'prompt', text: 'this must be refused', clientMessageId: 'ro-1' }));
          }
        } catch {
          /* ignore non-JSON frames */
        }
        if (seen.some((frame) => frame.kind === 'nack' && frame.clientMessageId === 'ro-1')) {
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        }
      };
      ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error('read-only websocket failed')); };
    });
    const readOnlySession = readOnlyFrames.find((frame) => frame.kind === 'session');
    const readOnlyNack = readOnlyFrames.find((frame) => frame.kind === 'nack' && frame.clientMessageId === 'ro-1');
    check('G3f a read-only socket is published without mutation authority',
      readOnlySession?.authority?.canMutate === false && readOnlySession?.authority?.prompt === 'none',
      JSON.stringify(readOnlySession?.authority));
    check('G3f2 its prompt is refused at the broker boundary, not merely hidden in the UI',
      !!readOnlyNack, JSON.stringify(readOnlyFrames.map((frame) => frame.kind)));
    check('G3f3 the resume it asked for never spawned a Drive owner',
      resumeOwnerSpawnCount() === resumeSpawnsBeforeReadOnly,
      `${resumeSpawnsBeforeReadOnly} -> ${resumeOwnerSpawnCount()}`);
    // The socket must not be offered controls it can never complete. The
    // read-only latch is monotone on the client, so any re-attach a join or
    // takeover issued would still be read-only — the offer could only fail.
    check('G3f4 no join-existing action is published to a read-only socket',
      readOnlyFrames.every((frame) => frame.kind !== 'session' || frame.joinExisting === undefined),
      JSON.stringify(readOnlyFrames.find((frame) => frame.kind === 'session')?.joinExisting));
    // Carried in the frame the client already reads, so it suppresses Take over
    // and the composer without a new DTO field. The negotiated STATUS stays
    // truthful: the contract is fine, it is this attach that renounced.
    const readOnlyHello = readOnlyFrames.find((frame) => frame.kind === 'hello');
    check('G3f5 the hello tells the client this socket is read-only, without claiming a contract mismatch',
      readOnlyHello?.compatibility?.readOnly === true
        && readOnlyHello?.compatibility?.status !== 'hard-incompatible'
        && typeof readOnlyHello?.compatibility?.reason === 'string',
      JSON.stringify(readOnlyHello?.compatibility));

    // ── G3g: read-only DECLARED and genuinely incompatible at the same time ──
    // Both can hold at once — an old client can also meet an attach mode it
    // cannot read — and the incompatibility is the one the user can act on by
    // updating. It must not be masked by the gentler declared-read-only
    // wording, and the client must still be able to record it globally.
    const bothFrames = await wsFrames(
      await ticketedStreamUrl({
        readOnly: '1',
        clientVersion: '0.0.1',
        contractRevision: '15',
        minimumBrokerRevision: '999',
        contractSurfaceHash: 'fnv1a32:00000000',
      }, true),
      (seen) => seen.some((frame) => frame.kind === 'session'),
    );
    const bothHello = bothFrames.find((frame) => frame.kind === 'hello');
    const bothNotice = bothFrames.find((frame) => frame.kind === 'notice');
    check('G3g the negotiated hard incompatibility survives the read-only declaration',
      bothHello?.compatibility?.status === 'hard-incompatible'
        && bothHello?.compatibility?.readOnly === true,
      JSON.stringify(bothHello?.compatibility));
    check('G3g2 the notice reports the incompatibility, not the milder declaration',
      typeof bothNotice?.message === 'string'
        && bothNotice.message.includes('incompatible'),
      JSON.stringify(bothNotice?.message));

    daemon.configure({ ignoreMethods: ['initialize'] });
    writeCompetingOwner();
    const resumeSpawnsAfterHandoff = resumeOwnerSpawnCount();

    const frames = await wsFrames(
      await ticketedStreamUrl({ mode: 'resume', reason: 'app-restore' }, true),
      (seen) => seen.some((f) => f.kind === 'attach-conflict') && seen.some((f) => f.kind === 'session'),
    );
    const conflictIndex = frames.findIndex((f) => f.kind === 'attach-conflict');
    const sessionIndex = frames.findIndex((f) => f.kind === 'session');
    const conflict = frames[conflictIndex];
    const session = frames[sessionIndex];
    check('G4 the socket greets with hello before any arbitration answer', frames[0]?.kind === 'hello');
    check(
      'G5 the denied restore arrives as a structured attach-conflict frame',
      conflict?.requestedMode === 'resume' &&
        conflict?.reason === 'app-restore' &&
        conflict?.code === 'DRIVE_OWNERSHIP_UNKNOWN' &&
        typeof conflict?.message === 'string' &&
        conflict.message.length > 0,
      JSON.stringify(conflict),
    );
    check(
      'G6 the SAME socket continues as the Observe fallback owner',
      conflictIndex !== -1 &&
        sessionIndex > conflictIndex &&
        session?.info?.attachMode === 'observe' &&
        session?.info?.control?.drive?.state === 'observing' &&
        String(session?.info?.control?.terminalSync?.command ?? '').includes('resume --remote'),
      JSON.stringify(session?.info?.control ?? null),
    );
    check(
      'G6b exactly one structured refusal was sent before the Observe fallback',
      frames.filter((frame) => frame.kind === 'attach-conflict').length === 1,
    );
    check('G7 the denied restore spawned no additional Resume owner process',
      resumeOwnerSpawnCount() === resumeSpawnsAfterHandoff);

    // ── G13: a refused reason-tagged LIVE takeover is REPORTED, not absorbed ──
    //
    // The generic live fallback silently downgrades an ownership conflict to
    // Observe, which is right for an unattended live attach whose eligibility
    // changed under it and wrong for a takeover: the user pressed a button and
    // has to be told the answer. Ordered the other way round, this socket would
    // arrive at Observe with no conflict frame at all — G13b is what fails then.
    const liveTakeoverFrames = await wsFrames(
      await ticketedStreamUrl({ mode: 'live', reason: 'takeover' }, true),
      (seen) => seen.some((f) => f.kind === 'session'),
    );
    const liveConflict = liveTakeoverFrames.find((f) => f.kind === 'attach-conflict');
    check('G13 a refused live takeover reports the conflict rather than silently observing',
      Boolean(liveConflict), JSON.stringify(liveTakeoverFrames.map((f) => f.kind)));
    // The frame must name the mode that was actually requested. A client that
    // reads it to decide what to retry must not be told `resume` for an attach
    // it made on `live`.
    check('G13b ...and the frame carries the ACTUAL requested mode',
      liveConflict?.requestedMode === 'live' && liveConflict?.reason === 'takeover',
      JSON.stringify(liveConflict));
    check('G13c ...and the same socket still continues as the Observe fallback',
      liveTakeoverFrames.some((f) => f.kind === 'session'
        && f.info?.attachMode === 'observe'),
      JSON.stringify(liveTakeoverFrames.find((f) => f.kind === 'session')?.info?.attachMode));

    const bareFrames = await wsFrames(
      await ticketedStreamUrl({}, true),
      (seen) => seen.some((f) => f.kind === 'session'),
    );
    check(
      'G8 a later bare attach joins cleanly with no conflict frame',
      bareFrames.some((f) => f.kind === 'session') && bareFrames.every((f) => f.kind !== 'attach-conflict'),
    );
    check('G9 the bare attach spawned no Resume owner either',
      resumeOwnerSpawnCount() === resumeSpawnsAfterHandoff);

    // Keep one Observe client attached while the native rename runs. Its
    // second session frame must carry the accepted title immediately; waiting
    // for Codex's delayed session-index rediscovery would leave this socket and
    // the client roster at the old title.
    const renameFrames: any[] = [];
    const renameSocket = new WebSocket(await ticketedStreamUrl({}, true));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('rename socket timed out')), 10_000);
      renameSocket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        renameFrames.push(frame);
        if (frame.kind === 'session') {
          clearTimeout(timer);
          resolve();
        }
      };
      renameSocket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('rename socket failed'));
      };
    });
    const renameResponse = await fetch(
      `${base}/api/sessions/codex/${encodeURIComponent(sessionId)}/rename`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-cosyncing-token': token,
        },
        body: JSON.stringify({ title: 'Accepted native title' }),
      },
    );
    const renameBody = await renameResponse.json() as any;
    const renameBroadcast = await waitFor(() => {
      return renameFrames.find(
        (frame) => frame.kind === 'session' && frame.info?.title === 'Accepted native title',
      );
    }, 10_000);
    check(
      'G10 native Codex rename responds with the accepted title immediately',
      renameResponse.status === 200 &&
        renameBody?.title === 'Accepted native title' &&
        renameBody?.session?.title === 'Accepted native title',
      JSON.stringify(renameBody),
    );
    check(
      'G11 the attached Observe socket receives the accepted title without rediscovery',
      Boolean(renameBroadcast),
      JSON.stringify(renameFrames.filter((frame) => frame.kind === 'session')),
    );
    renameSocket.close();
  } finally {
    broker.kill();
    await broker.exited.catch(() => undefined);
    await settledProcessOutput(brokerOutput);
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
}

// ── G12: the Drive credential boundary, in the baseline where it is the only
// gate ──────────────────────────────────────────────────────────────────────
//
// A TOKENLESS loopback broker. This is the configuration the boundary exists
// for and the only one that can prove it: with no token configured the outer
// `authed` gate is open for every route, so `credentialAuthenticated` is the
// sole thing between an unattended caller and Drive. On the tokened fixture
// above, `authed` refuses first and a 401 proves nothing about which gate ran.
//
// The pairing matters as much as either check alone: takeover refused, bare
// live admitted, same broker, same request otherwise.
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-arb-open-'));
  const portLease = await reserveLoopbackFixturePort();
  const port = portLease.port;
  const env = isolatedBrokerFixtureEnvironment(home, {
    overrides: {
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_HOME: home,
      COSYNCING_MACHINE: 'arb-open-fixture',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_CODEX_APP_SERVER_SOCK: '',
    },
  });
  await portLease.release();
  const openBroker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(), env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* not up yet */ }
      if (!ready) await Bun.sleep(100);
    }
    check('G12 the tokenless baseline broker starts', ready, base);

    const path = '/api/sessions/codex/missing/stream';
    const bareLive = await fetch(`${base}${path}?mode=live`);
    check('G12a an unattended live attach is open in the tokenless baseline',
      bareLive.status === 426, `status=${bareLive.status}`);

    const takeover = await fetch(`${base}${path}?mode=live&reason=takeover`);
    const takeoverBody = await takeover.json().catch(() => ({})) as { code?: string };
    check('G12b ...but a reason-tagged live takeover still requires a Drive credential',
      takeover.status === 401 && takeoverBody.code === 'RESUME_AUTH_REQUIRED',
      `status=${takeover.status} code=${String(takeoverBody.code)}`);
    // 401 rather than 426 is also what proves the adapter is never reached: the
    // refusal lands at the route, before the upgrade, so no socket exists for an
    // attach to run on.
    check('G12c ...refused at the route, never reaching the websocket upgrade',
      takeover.status !== 426, `status=${takeover.status}`);

    const resume = await fetch(`${base}${path}?mode=resume`);
    check('G12d the resume boundary this extends is unchanged',
      resume.status === 401, `status=${resume.status}`);
  } finally {
    openBroker.kill();
    await openBroker.exited.catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} drive-restore arbitration check(s) failed.`);
  process.exit(1);
}
console.log('\nAll drive-restore arbitration checks passed.');
