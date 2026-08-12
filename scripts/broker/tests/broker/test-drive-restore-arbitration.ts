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
 *     upgrade-time reason validation, the structured `attach-conflict` frame, the
 *     in-socket Observe fallback, and proof that no Resume owner process is spawned.
 */
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { FakeCodexDaemon } from '../helpers/fake-codex-daemon.ts';
import { Hub } from '../../../../packages/typescript/broker/src/hub.ts';
import { driveAttachRefusalCode } from '../../../../packages/typescript/broker/src/drive-attach-refusal.ts';
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
} from '../../../../packages/typescript/adapter-api/src/index.ts';

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
  mkdirSync(join(procRoot, '4242'), { recursive: true });
  writeFileSync(join(procRoot, 'uptime'), `${bootUptimeSec}.00 20000.00\n`);
  writeFileSync(
    join(procRoot, '4242', 'cmdline'),
    `${['codex', 'resume', '--remote', `unix://${join(home, 'other-daemon.sock')}`, threadUuid].join('\0')}\0`,
  );
  symlinkSync(workDir, join(procRoot, '4242', 'cwd'));
  writeFileSync(
    join(procRoot, '4242', 'stat'),
    `4242 (codex tui) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${(bootUptimeSec - 60) * 100} 0 0`,
  );

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
    if (message.method === 'initialize' || message.method === 'thread/name/set') {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    }
  }
}
`,
  );
  chmodSync(fakeBin, 0o755);
  const resumeOwnerSpawned = () => {
    try {
      return readFileSync(invocationLog, 'utf8').split('\n').some((line) => line.includes('app-server --stdio'));
    } catch {
      return false;
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
    const badReason = await fetch(`${base}${streamPath}?token=${token}&mode=resume&reason=bogus`);
    check('G2 an unknown attach reason is rejected before the upgrade', badReason.status === 400);
    const reasonWithoutMode = await fetch(`${base}${streamPath}?token=${token}&reason=app-restore`);
    check('G3 a reason without mode=resume is rejected before the upgrade', reasonWithoutMode.status === 400);

    const frames = await wsFrames(
      `ws://127.0.0.1:${port}${streamPath}?token=${token}&mode=resume&reason=app-restore`,
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
    check('G7 no Resume owner process was spawned by the denied restore', !resumeOwnerSpawned());

    const bareFrames = await wsFrames(
      `ws://127.0.0.1:${port}${streamPath}?token=${token}`,
      (seen) => seen.some((f) => f.kind === 'session'),
    );
    check(
      'G8 a later bare attach joins cleanly with no conflict frame',
      bareFrames.some((f) => f.kind === 'session') && bareFrames.every((f) => f.kind !== 'attach-conflict'),
    );
    check('G9 the bare attach spawned no Resume owner either', !resumeOwnerSpawned());

    // Keep one Observe client attached while the native rename runs. Its
    // second session frame must carry the accepted title immediately; waiting
    // for Codex's delayed session-index rediscovery would leave this socket and
    // the client roster at the old title.
    const renameFrames: any[] = [];
    const renameSocket = new WebSocket(
      `ws://127.0.0.1:${port}${streamPath}?token=${token}`,
    );
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

if (failures > 0) {
  console.error(`\n${failures} drive-restore arbitration check(s) failed.`);
  process.exit(1);
}
console.log('\nAll drive-restore arbitration checks passed.');
