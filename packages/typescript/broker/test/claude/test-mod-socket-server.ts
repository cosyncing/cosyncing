/**
 * The mod socket end to end: a fake mod dialling a real socket and the broker answering.
 *
 * Protocol-level tests can pass while the socket is broken, and socket-level tests can pass
 * while the protocol is broken, so this one uses a real Unix socket, a real `node:net` client,
 * and the real reader, registry, hold store and peer check. Three things it exists to catch:
 *
 * - A refused peer that nonetheless queues something. The whole security story is that a wrong
 *   uid or a broker child never gets a command delivered to it, so the refusal and the queue are
 *   asserted together rather than separately.
 * - Per-connection state shared between connections. Bun's `listen({ data })` value is one
 *   object for every connection; two mods registered concurrently would otherwise receive each
 *   other's bodies. Two clients, different session ids, asserted not to cross over.
 * - The kernel's pid rather than the mod's claim. The reply must carry `peerPid`, and a mod that
 *   guesses its own pid wrong must not be able to move the row.
 *
 *   bun run packages/typescript/broker/test/claude/test-mod-socket-server.ts   (exit 0 = all pass)
 */
export {};
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ModSocketServer, MOD_SOCKET_FILENAME } from '../../src/sessions/mod-socket-server.ts';
import { ModRegistry } from '../../src/sessions/mod-registry.ts';
import { Http1RequestReader } from '../../src/sessions/mod-http-reader.ts';
import { ModHoldStore } from '../../src/sessions/mod-holds.ts';
import { ModAuditStore } from '../../src/sessions/mod-audit.ts';
import { parseModRegister } from '../../src/sessions/mod-protocol.ts';
import type { ModGateInputs } from '../../src/sessions/mod-holds.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The suite names its sessions so a failure reads; the wire takes the shape Claude mints, a UUID.
 * One UUID per name for the whole run, so a name means the same session everywhere it appears.
 */
const sessionNames = new Map<string, string>();
function S(name: string): string {
  let id = sessionNames.get(name);
  if (!id) {
    id = randomUUID();
    sessionNames.set(name, id);
  }
  return id;
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface Harness {
  root: string;
  socketPath: string;
  server: ModSocketServer;
  registry: ModRegistry;
  holds: ModHoldStore;
  audit: ModAuditStore;
  events: { sessionId: string; kind: string }[];
  refusals: string[];
  registered: string[];
  gate: ModGateInputs;
}

interface HarnessOptions {
  gate?: Partial<ModGateInputs>;
  expectedUid?: () => number;
  isBrokerChild?: (pid: number) => boolean;
  livenessAlive?: boolean;
  holdPollWaitMs?: number;
  /** The start time the registry reads for any pid. Defaults to one fixed value. */
  startTime?: (pid: number) => string | undefined;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  // macOS reports os.tmpdir() behind the /var -> /private/var symlink, which the state-dir
  // guard refuses; canonicalize the root first, the way security/r2-export.ts does.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-sock-')));
  const socketPath = join(root, MOD_SOCKET_FILENAME);
  const gate: ModGateInputs = { mode: 'default', viewers: 1, killSwitch: false, ...options.gate };
  const events: { sessionId: string; kind: string }[] = [];
  const refusals: string[] = [];
  const registered: string[] = [];
  const registry = new ModRegistry({
    startTime: options.startTime ?? (() => 'start'),
    liveness: () => ({ alive: options.livenessAlive ?? true, identityKnown: true }),
  });
  const audit = new ModAuditStore();
  const holds = new ModHoldStore({ registry, audit, gate: () => gate });
  const server = new ModSocketServer({
    socketPath,
    registry,
    holds,
    killSwitch: () => gate.killSwitch,
    holdPollWaitMs: options.holdPollWaitMs ?? 1_000,
    onEvent: (event) => events.push({ sessionId: event.sessionId, kind: event.kind }),
    onRefusal: (code) => refusals.push(code),
    onRegister: (sessionId) => registered.push(sessionId),
    log: { warn: () => {} },
    ...(options.expectedUid ? { expectedUid: options.expectedUid } : {}),
    ...(options.isBrokerChild ? { isBrokerChild: options.isBrokerChild } : {}),
  });
  await server.start();
  return { root, socketPath, server, registry, holds, audit, events, refusals, registered, gate };
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  /** How long the broker held the request, because on a long-poll the timing *is* the contract. */
  elapsedMs: number;
}

/** POST one JSON body over the Unix socket. The server answers once and hangs up. */
function post(
  socketPath: string,
  route: string,
  body: unknown,
  options: { sid?: string; timeoutMs?: number; onOpen?: (socket: net.Socket) => void } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = `/claude/mod/${route}${options.sid ? `?sid=${options.sid}` : ''}`;
    const request = `POST ${target} HTTP/1.1\r\nContent-Type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    const chunks: Buffer[] = [];
    const startedAt = Date.now();
    const socket = net.createConnection({ path: socketPath }, () => socket.write(request));
    options.onOpen?.(socket);
    let done = false;
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 15_000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      socket.destroy();
      const [head = '', rest = ''] = text.split('\r\n\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rest);
      } catch {
        parsed = {};
      }
      resolve({ status, body: parsed, raw: text, elapsedMs: Date.now() - startedAt });
    };
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('latin1');
      const boundary = text.indexOf('\r\n\r\n');
      if (boundary >= 0) {
        const declared = /content-length: (\d+)/i.exec(text.slice(0, boundary))?.[1];
        if (declared !== undefined && Buffer.byteLength(text.slice(boundary + 4), 'latin1') >= Number(declared)) finish();
      }
    });
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function registerBody(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    sessionId,
    cwd: '/tmp/scratch-work',
    claudeVersion: '2.1.288',
    model: 'claude-haiku-4-5',
    isInteractive: true,
    surface: 'terminal',
    reportedPid: process.pid,
    ...over,
  };
}

const cleaned: Harness[] = [];
function opened(h: Harness): Harness {
  cleaned.push(h);
  return h;
}

try {
  // ── Modes and ownership ──
  const h = opened(await harness());
  const dirMode = statSync(h.root).mode & 0o777;
  const socketMode = statSync(h.socketPath).mode & 0o777;
  check('the socket directory is 0700', dirMode === 0o700, dirMode.toString(8));
  check('the socket is 0600', socketMode === 0o600, socketMode.toString(8));

  const ok = await post(h.socketPath, 'register', registerBody(S('ses-1')), { sid: S('ses-1') });
  check('register answers 200', ok.status === 200, `status=${ok.status} body=${JSON.stringify(ok.body).slice(0, 90)}`);
  check('the reply carries the kernel peer pid', ok.body.peerPid === process.pid, JSON.stringify(ok.body).slice(0, 120));
  const ownUid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  check('the reply carries the peer uid', ok.body.peerUid === ownUid, `${String(ok.body.peerUid)} vs ${ownUid}`);
  check('an agreeing reportedPid records agreement', ok.body.peerPidAgrees === true);
  check('an interactive terminal registration is live', ok.body.state === 'live', String(ok.body.state));
  check('the register reply carries the kill switch the mod is allowed to cache', ok.body.killSwitch === false);

  // The kernel's pid wins over the mod's claim.
  const disagreed = await post(h.socketPath, 'register', registerBody(S('ses-1'), { reportedPid: 999_999 }), { sid: S('ses-1') });
  check('a wrong reportedPid keeps the row', disagreed.status === 200 && disagreed.body.state === 'live', JSON.stringify(disagreed.body).slice(0, 90));
  check('a wrong reportedPid says it disagreed', disagreed.body.peerPidAgrees === false);
  check('and the stored pid is still the kernel answer', h.registry.get(S('ses-1'))!.peerPid === process.pid);

  // The park tests run on their own session: a `session.end` below removes the row, and the
  // tests further down still need `ses-1` alive.
  const parkId = S('ses-park');
  const parked0 = await post(h.socketPath, 'register', registerBody(parkId), { sid: parkId });
  check('the park tests have their own registration', parked0.status === 200, `status=${parked0.status}`);

  // A one-millisecond wait is a peek: the mod asks for nothing and gets an answer straight away.
  // (`wait: 0` is not a peek; the protocol reads a missing or zero wait as the default long-poll.)
  const peek = await post(h.socketPath, 'poll', { sessionId: parkId, wait: 1 }, { sid: parkId });
  check('a poll asking for almost nothing is answered at once', peek.status === 200 && peek.elapsedMs < 300, `status=${peek.status} in ${peek.elapsedMs}ms`);
  check('a peek still carries the state the mod caches', (peek.body.state as { killSwitch?: boolean } | undefined)?.killSwitch === false);

  // The mod's loop pace *is* the idle poll's answer, so an early answer is a hot spin. The first
  // cut of this lane answered at 50 ms and a real session sent 15,739 polls in seven minutes.
  const idleWaitMs = 900;
  const idle = await post(h.socketPath, 'poll', { sessionId: parkId, wait: idleWaitMs }, { sid: parkId });
  check('an idle poll waits its wait rather than answering early', idle.status === 200 && idle.elapsedMs >= idleWaitMs - 60, `${idle.elapsedMs}ms for a ${idleWaitMs}ms wait`);
  check('an idle poll that expires carries no command', idle.body.command === undefined, JSON.stringify(idle.body).slice(0, 80));
  check('an idle poll still carries the state the mod caches', (idle.body.state as { killSwitch?: boolean } | undefined)?.killSwitch === false);

  // Parking is only cheap if something wakes it. A prompt typed in the app must not sit behind a
  // wait the mod asked for.
  const parked = post(h.socketPath, 'poll', { sessionId: parkId, wait: 20_000 }, { sid: parkId, timeoutMs: 9_000 });
  await sleep(200);
  const wakeEnqueued = h.server.enqueue(parkId, { requestId: 'cmd-wake', op: 'prompt', text: 'wake up', queuedAt: Date.now() });
  const woken = await parked;
  check('a parked poll delivers a command queued after it parked', wakeEnqueued.ok === true && woken.status === 200 && (woken.body.command as { op?: string } | undefined)?.op === 'prompt', JSON.stringify(woken.body).slice(0, 110));
  check('a parked poll wakes rather than waiting out its 20 s', woken.elapsedMs < 3_000, `${woken.elapsedMs}ms`);

  // A row that ends while a poll is parked has to say so, or the mod keeps a dead registration.
  const ending = post(h.socketPath, 'poll', { sessionId: parkId, wait: 20_000 }, { sid: parkId, timeoutMs: 9_000 });
  await sleep(200);
  h.server.noteTurnEvent(parkId, 'session.end');
  const refusal = await ending;
  check('a poll parked over an ended session is refused, not left held', refusal.status === 409 && refusal.body.code === 'no_registration', `status=${refusal.status} ${JSON.stringify(refusal.body).slice(0, 70)}`);
  check('and it is refused at once rather than at the deadline', refusal.elapsedMs < 3_000, `${refusal.elapsedMs}ms`);

  // The mod recovers by registering again, which is the whole `/clear` route.
  const again = await post(h.socketPath, 'register', registerBody(parkId), { sid: parkId });
  check('a session that ended can register again on the same id', again.status === 200 && again.body.state === 'live', `status=${again.status}`);

  // ── Refusals: nothing is queued for a peer we did not accept ──
  const wrongUid = opened(await harness({ expectedUid: () => (typeof process.geteuid === 'function' ? process.geteuid()! + 1 : 4321) }));
  const refusedUid = await post(wrongUid.socketPath, 'register', registerBody(S('ses-uid')), { sid: S('ses-uid') });
  check('a peer of another uid is refused', refusedUid.status === 403 && refusedUid.body.code === 'uid_mismatch', `status=${refusedUid.status} ${JSON.stringify(refusedUid.body).slice(0, 90)}`);
  check('the refused registration stored no row', wrongUid.registry.status(S('ses-uid')).present === false);
  const afterRefusal = await post(wrongUid.socketPath, 'poll', { sessionId: S('ses-uid'), wait: 10 }, { sid: S('ses-uid') });
  // Refused for the peer, not for the missing row: every route runs the kernel check first, so a
  // foreign uid is turned away at the door rather than at whichever lookup happens to be next.
  check('a refused peer cannot queue a command by polling', afterRefusal.status === 403 && afterRefusal.body.code === 'uid_mismatch', `status=${afterRefusal.status} ${JSON.stringify(afterRefusal.body).slice(0, 70)}`);
  check('and the queue stayed empty', wrongUid.registry.queuedCount(S('ses-uid')) === 0);

  const child = opened(await harness({ isBrokerChild: () => true }));
  const refusedChild = await post(child.socketPath, 'register', registerBody(S('ses-child')), { sid: S('ses-child') });
  check('a broker child is refused as broker_child', refusedChild.status === 403 && refusedChild.body.code === 'broker_child', JSON.stringify(refusedChild.body).slice(0, 90));
  check('two writers on one session is refused before the row exists', child.registry.status(S('ses-child')).present === false);

  const old = opened(await harness());
  const tooOld = await post(old.socketPath, 'register', registerBody(S('ses-old'), { claudeVersion: '2.1.287' }), { sid: S('ses-old') });
  check('a Claude below the 2.1.288 floor is refused', tooOld.status === 400 && tooOld.body.code === 'claude_version_too_old', JSON.stringify(tooOld.body).slice(0, 90));
  const exact = await post(old.socketPath, 'register', registerBody(S('ses-floor'), { claudeVersion: '2.1.288' }), { sid: S('ses-floor') });
  check('the floor build itself is accepted', exact.status === 200, `status=${exact.status}`);
  const newer = await post(old.socketPath, 'register', registerBody(S('ses-newer'), { claudeVersion: '2.1.1000' }), { sid: S('ses-newer') });
  check('a newer build passes the floor numerically (2.1.1000 > 2.1.288)', newer.status === 200, `status=${newer.status}`);
  // R4-12: the gate, setup and the smoke share one comparison. Every shape a version reaches the
  // socket in; `2.1.290 (Claude Code)` never does, since a register body's version is one word.
  for (const [version, accepted] of [
    ['2.1.290', true], ['v2.1.290', true], ['2.1.288', true], ['2.1.287', false],
    ['2.1.290-beta.1', true], ['2.1.288-rc.1', false],
  ] as const) {
    const reply = await post(old.socketPath, 'register', registerBody(S(`ses-r412-${version}`), { claudeVersion: version }), { sid: S(`ses-r412-${version}`) });
    check(`R4-12 the register gate ${accepted ? 'accepts' : 'refuses'} ${version}${accepted ? '' : ' as claude_version_too_old'}`,
      accepted ? reply.status === 200 : reply.status === 400 && reply.body.code === 'claude_version_too_old',
      `status=${reply.status} ${JSON.stringify(reply.body).slice(0, 90)}`);
  }

  const skew = await post(old.socketPath, 'register', registerBody(S('ses-skew'), { protocolVersion: 2 }), { sid: S('ses-skew') });
  check('a protocol version mismatch is refused, not adapted', skew.status === 400 && skew.body.code === 'protocol_version_mismatch', JSON.stringify(skew.body).slice(0, 90));

  const broken = await post(h.socketPath, 'register', { protocolVersion: 1, cwd: '/tmp' }, { sid: 'x' });
  check('a register with no sessionId is refused with invalid_message', broken.status === 400 && broken.body.code === 'invalid_message', JSON.stringify(broken.body).slice(0, 90));
  const mismatch = await post(h.socketPath, 'register', registerBody(S('ses-two')), { sid: S('ses-one') });
  check('a query sid that disagrees with the body is refused', mismatch.status === 400 && mismatch.body.code === 'invalid_message');
  const stray = await post(h.socketPath, 'poll', { sessionId: S('never-registered'), wait: 5 });
  check('a poll for an unknown session is refused 409 no_registration', stray.status === 409 && stray.body.code === 'no_registration', `status=${stray.status}`);

  // ── Two mods on one socket, at the same time ──
  const [a, b] = await Promise.all([
    post(h.socketPath, 'register', registerBody(S('mod-a')), { sid: S('mod-a') }),
    post(h.socketPath, 'register', registerBody(S('mod-b'), { cwd: '/tmp/other-work' }), { sid: S('mod-b') }),
  ]);
  check('two mods can register concurrently', a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
  check('both rows exist independently', h.registry.status(S('mod-a')).present && h.registry.status(S('mod-b')).present);
  check('and did not overwrite each other', h.registry.get(S('mod-a'))!.cwd === '/tmp/scratch-work' && h.registry.get(S('mod-b'))!.cwd === '/tmp/other-work');
  const [pollA, pollB] = await Promise.all([
    post(h.socketPath, 'poll', { sessionId: S('mod-a'), wait: 10 }, { sid: S('mod-a') }),
    post(h.socketPath, 'poll', { sessionId: S('mod-b'), wait: 10 }, { sid: S('mod-b') }),
  ]);
  check('concurrent polls are answered independently', pollA.status === 200 && pollB.status === 200);

  // ── Command delivery ──
  const queued = h.server.enqueue(S('mod-a'), { requestId: 'c-1', op: 'prompt', text: 'write a test', queuedAt: Date.now() });
  check('the app can queue a prompt for a registered session', queued.ok === true, JSON.stringify(queued));
  const delivered = await post(h.socketPath, 'poll', { sessionId: S('mod-a'), wait: 10 }, { sid: S('mod-a') });
  const deliveredCommand = delivered.body.command as { op?: string; requestId?: string } | undefined;
  check('the prompt arrives on the next poll', deliveredCommand?.op === 'prompt', JSON.stringify(delivered.body).slice(0, 120));
  check('the command carries its request id', deliveredCommand?.requestId === 'c-1');
  const drained = await post(h.socketPath, 'poll', { sessionId: S('mod-a'), wait: 10 }, { sid: S('mod-a') });
  check('a delivered command is consumed once', drained.body.command === undefined);
  const other = h.server.enqueue(S('mod-b'), { requestId: 'c-bad', op: 'prompt', queuedAt: Date.now() });
  check('a prompt with no text is refused before it is queued', other.ok === false && other.code === 'invalid_command', JSON.stringify(other));
  const unregistered = h.server.enqueue('nope', { requestId: 'c-2', op: 'abort', turnId: 't1', queuedAt: Date.now() });
  check('an abort for an unregistered session is refused', unregistered.ok === false && unregistered.code === 'no_registration');

  // ── Holds over the socket ──
  const unwatched = opened(await harness({ gate: { mode: 'default', viewers: 0 } }));
  await post(unwatched.socketPath, 'register', registerBody(S('ses-noviewer')), { sid: S('ses-noviewer') });
  const released = await post(unwatched.socketPath, 'hold', { sessionId: S('ses-noviewer'), requestId: 'h-1', tool: 'Bash', decision: 'ask' }, { sid: S('ses-noviewer') });
  check('with no viewer the hold releases at once', released.status === 200 && (released.body as { release?: { why?: string } }).release?.why === 'viewer:none', JSON.stringify(released.body).slice(0, 120));
  check('and the mod is told which request the release is about', (released.body as { release?: { requestId?: string } }).release?.requestId === 'h-1');

  const watched = opened(await harness({ gate: { mode: 'default', viewers: 1 }, holdPollWaitMs: 5_000 }));
  await post(watched.socketPath, 'register', registerBody(S('ses-held')), { sid: S('ses-held') });
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  const acked = await post(watched.socketPath, 'hold', { sessionId: S('ses-held'), requestId: 'h-2', tool: 'Bash', decision: 'ask', input: 'npm publish' }, { sid: S('ses-held') });
  check('the broker says it took the hold before it starts to wait', acked.status === 200 && (acked.body as { held?: boolean }).held === true, JSON.stringify(acked.body).slice(0, 90));
  const holdPending = post(watched.socketPath, 'hold', { sessionId: S('ses-held'), requestId: 'h-2', tool: 'Bash', decision: 'ask', input: 'npm publish' }, { sid: S('ses-held') });
  await new Promise((r) => setTimeout(r, 150));
  check('the hold opened a card the app can answer', watched.holds.isOpen(S('ses-held'), 'h-2'));
  const midHold = await post(watched.socketPath, 'poll', { sessionId: S('ses-held'), wait: 10 }, { sid: S('ses-held') });
  check('while the hold is open the poll carries no verdict yet', midHold.status === 200 && midHold.body.verdict === undefined);
  const answered = watched.server.answer(S('ses-held'), 'h-2', 'allow', 'app');
  const holdReply = await holdPending;
  const verdict = (holdReply.body as { verdict?: { behavior?: string; source?: string; requestId?: string } }).verdict;
  check('answering from the app settles the held request', answered === true && verdict?.behavior === 'allow', JSON.stringify(holdReply.body).slice(0, 140));
  check('the verdict names who answered', verdict?.source === 'app', String(verdict?.source));
  check('the verdict is tied to its request id', verdict?.requestId === 'h-2');
  const double = watched.server.answer(S('ses-held'), 'h-2', 'deny', 'band');
  check('the slower seat cannot answer the same request twice', double === false);
  const auditRow = watched.audit.list()[0];
  check('the decision is audited with the mode it was taken in', auditRow?.modeSeen === 'default' && auditRow?.answeredBy === 'app', JSON.stringify(auditRow).slice(0, 140));
  check('the audit row names the tool and duration', auditRow?.tool === 'Bash' && typeof auditRow?.durationMs === 'number');
  check('no audit row carries the command text', !JSON.stringify(watched.audit.list({ includeReleases: true })).includes('npm publish'));

  // A verdict that landed between polls is still delivered, not stranded in the broker.
  const between = opened(await harness({ gate: { mode: 'acceptEdits', viewers: 2 }, holdPollWaitMs: 300 }));
  await post(between.socketPath, 'register', registerBody(S('ses-between')), { sid: S('ses-between') });
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  await post(between.socketPath, 'hold', { sessionId: S('ses-between'), requestId: 'h-3', tool: 'Write', decision: 'ask' }, { sid: S('ses-between') });
  const pending = post(between.socketPath, 'hold', { sessionId: S('ses-between'), requestId: 'h-3', tool: 'Write', decision: 'ask' }, { sid: S('ses-between') });
  await new Promise((r) => setTimeout(r, 60));
  between.holds.answer(S('ses-between'), 'h-3', 'deny', 'app');
  await pending;
  const afterVerdict = await post(between.socketPath, 'poll', { sessionId: S('ses-between'), wait: 10 }, { sid: S('ses-between') });
  check('a consumed verdict is not redelivered on the next poll', afterVerdict.status === 200 && afterVerdict.body.verdict === undefined, JSON.stringify(afterVerdict.body).slice(0, 100));

  // ── Turn events, session end, and the dead-pid attention path ──
  const events = opened(await harness());
  await post(events.socketPath, 'register', registerBody(S('ses-events')), { sid: S('ses-events') });
  await post(events.socketPath, 'event', { sessionId: S('ses-events'), kind: 'turn.start', detail: { turnId: 'turn-9' } }, { sid: S('ses-events') });
  check('a turn.start event reaches the hub mirror', events.events.some((e) => e.kind === 'turn.start' && e.sessionId === S('ses-events')), JSON.stringify(events.events));
  const ended = await post(events.socketPath, 'event', { sessionId: S('ses-events'), kind: 'session.end', detail: { reason: 'clear' } }, { sid: S('ses-events') });
  check('session.end is accepted', ended.status === 200);
  check('session.end deregisters the row', events.registry.status(S('ses-events')).present === false);
  const afterEnd = await post(events.socketPath, 'poll', { sessionId: S('ses-events'), wait: 5 }, { sid: S('ses-events') });
  check('a poll after session.end is refused rather than silently served', afterEnd.status === 409);

  // A closed terminal is reported by the service's sweep (test:claude-mod-lifecycle-seam, BH7). A
  // poll is the one thing a dead process never sends, so the socket raises nothing of its own.
  const dead = opened(await harness({ livenessAlive: false }));
  await post(dead.socketPath, 'register', registerBody(S('ses-dead')), { sid: S('ses-dead') });
  await post(dead.socketPath, 'poll', { sessionId: S('ses-dead'), wait: 5 }, { sid: S('ses-dead') });
  check('BH7: a poll raises no attention event of its own: the sweep owns that',
    !dead.events.some((e) => e.kind === 'attention.pid-dead'), JSON.stringify(dead.events));
  check('a dead-pid row is still present so Observe keeps working', dead.registry.status(S('ses-dead')).present);

  // ── A delivery goes to the claimant that can still carry it ──
  //
  // Two rules collide here: a verdict is consumed exactly once, and a parked long-poll belongs
  // to the registration that sent it. The tier-2 smoke found them out of order. After a resume,
  // the previous session's poll was still parked, took the app's answer for the new session's
  // hold, and wrote it to a process that had already exited; the live terminal then sat parked
  // for its whole 45 s budget on a call the user had approved. A waiter that cannot deliver must
  // leave the answer where the next live request can reach it.
  const stale = opened(await harness({ holdPollWaitMs: 5_000 }));
  await post(stale.socketPath, 'register', registerBody(S('ses-stale')), { sid: S('ses-stale') });
  const stalePoll = post(stale.socketPath, 'poll', { sessionId: S('ses-stale'), wait: 4_000 }, { sid: S('ses-stale') });
  await sleep(150);
  // Same session id, new registration: this is what a resume, a `/clear`, or an orphaned mod
  // worker leaves behind, and it is the only signal the broker has that the parked poll is stale.
  const replaced = await post(stale.socketPath, 'register', registerBody(S('ses-stale')), { sid: S('ses-stale') });
  check('a re-registration replaces the row a parked poll was sent under', replaced.status === 200, `status=${replaced.status}`);
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  await post(stale.socketPath, 'hold', { sessionId: S('ses-stale'), requestId: 'h-live', tool: 'Write', decision: 'ask' }, { sid: S('ses-stale') });
  const liveHold = post(stale.socketPath, 'hold', { sessionId: S('ses-stale'), requestId: 'h-live', tool: 'Write', decision: 'ask' }, { sid: S('ses-stale') });
  await sleep(150);
  check('the live session has a hold the app can answer', stale.holds.isOpen(S('ses-stale'), 'h-live'));
  check('and the answer is accepted', stale.server.answer(S('ses-stale'), 'h-live', 'allow', 'app') === true);
  const [staleReply, liveReply] = await Promise.all([stalePoll, liveHold]);
  const staleVerdict = (staleReply.body as { verdict?: { behavior?: string } }).verdict;
  const liveVerdict = (liveReply.body as { verdict?: { behavior?: string; source?: string } }).verdict;
  check('a poll whose registration was replaced does not take the answer', staleVerdict === undefined, JSON.stringify(staleReply.body).slice(0, 120));
  check('the superseded poll is told to register again', staleReply.status === 409 && staleReply.body.code === 'no_registration', `${staleReply.status} ${JSON.stringify(staleReply.body).slice(0, 80)}`);
  check('the live hold is the one that gets the answer', liveVerdict?.behavior === 'allow' && liveVerdict.source === 'app', JSON.stringify(liveReply.body).slice(0, 120));

  // The same rule for a socket that closed rather than a registration that was replaced: the
  // poll below never answers, so an answer handed to it is an answer nobody will ever read.
  const gone = opened(await harness({ holdPollWaitMs: 5_000 }));
  await post(gone.socketPath, 'register', registerBody(S('ses-gone')), { sid: S('ses-gone') });
  let deadSocket: net.Socket | undefined;
  const doomedPoll = post(gone.socketPath, 'poll', { sessionId: S('ses-gone'), wait: 4_000 }, {
    sid: S('ses-gone'),
    onOpen: (socket) => { deadSocket = socket; },
  });
  await sleep(150);
  deadSocket?.destroy();
  await sleep(200);
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  await post(gone.socketPath, 'hold', { sessionId: S('ses-gone'), requestId: 'h-gone', tool: 'Write', decision: 'ask' }, { sid: S('ses-gone') });
  const goneHold = post(gone.socketPath, 'hold', { sessionId: S('ses-gone'), requestId: 'h-gone', tool: 'Write', decision: 'ask' }, { sid: S('ses-gone') });
  await sleep(150);
  check('the closed poll leaves the hold open for the app', gone.holds.isOpen(S('ses-gone'), 'h-gone'));
  check('and a closed connection cannot consume the verdict', gone.server.answer(S('ses-gone'), 'h-gone', 'deny', 'app') === true);
  const goneReply = await goneHold;
  await doomedPoll;
  const goneVerdict = (goneReply.body as { verdict?: { behavior?: string; source?: string } }).verdict;
  check('the hold still reaches the terminal that is there', goneVerdict?.behavior === 'deny' && goneVerdict.source === 'app', JSON.stringify(goneReply.body).slice(0, 120));

  // ── The peer check on every route, and who owns a session ──
  // Register used to be the only route that looked at the kernel peer. Everything after it
  // trusted the `sid` in the query string, so a process nobody had accepted could read another
  // session's queued prompts, open a hold in its name, answer a hold it never saw, or send the
  // `session.end` that tears the row down.
  const claim = opened(await harness());
  const claimed = await post(claim.socketPath, 'register', registerBody(S('ses-claim')), { sid: S('ses-claim') });
  check('the first live process gets the session', claimed.status === 200 && claim.registry.status(S('ses-claim')).state === 'live', `status=${claimed.status}`);
  await post(claim.socketPath, 'poll', { sessionId: S('ses-claim'), wait: 10 }, { sid: S('ses-claim') });
  // Somebody else's live process. The row says pid 4242, and 4242 is alive as far as this harness
  // knows; the connection on the other end of the socket is this one, and that is the mismatch.
  claim.registry.get(S('ses-claim'))!.peerPid = 4_242;
  const strangerPoll = await post(claim.socketPath, 'poll', { sessionId: S('ses-claim'), wait: 10 }, { sid: S('ses-claim') });
  check('a different live pid cannot read another session\u2019s queue', strangerPoll.status === 403 && strangerPoll.body.code === 'peer_mismatch', `status=${strangerPoll.status} ${JSON.stringify(strangerPoll.body).slice(0, 70)}`);
  const strangerHold = await post(claim.socketPath, 'hold', { sessionId: S('ses-claim'), requestId: 'h-strange', tool: 'Bash', decision: 'ask', input: 'command: rm -rf /' }, { sid: S('ses-claim') });
  check('and cannot open a hold in its name', strangerHold.status === 403 && strangerHold.body.code === 'peer_mismatch', `status=${strangerHold.status}`);
  check('and no card was drawn by the attempt', claim.holds.isOpen(S('ses-claim'), 'h-strange') === false);
  claim.server.enqueue(S('ses-claim'), { requestId: 'cmd-claim', op: 'prompt', text: 'for the claimant only', queuedAt: Date.now() });
  const strangerAnswer = await post(claim.socketPath, 'event', { sessionId: S('ses-claim'), kind: 'hold.answer', requestId: 'h-claim', detail: { behavior: 'allow', source: 'band' } }, { sid: S('ses-claim') });
  check('and cannot answer a hold', strangerAnswer.status === 403 && strangerAnswer.body.code === 'peer_mismatch', `status=${strangerAnswer.status}`);
  const strangerEnd = await post(claim.socketPath, 'event', { sessionId: S('ses-claim'), kind: 'session.end' }, { sid: S('ses-claim') });
  check('and cannot tear the claimant\u2019s row down', strangerEnd.status === 403 && claim.registry.status(S('ses-claim')).present === true, `status=${strangerEnd.status} present=${claim.registry.status(S('ses-claim')).present}`);
  const strangerTurn = await post(claim.socketPath, 'event', { sessionId: S('ses-claim'), kind: 'turn.complete' }, { sid: S('ses-claim') });
  check('and cannot report the claimant\u2019s turn as over', strangerTurn.status === 403 && claim.registry.currentTurn(S('ses-claim')) === '', `status=${strangerTurn.status}`);
  const queuedStillThere = claim.registry.queuedCount(S('ses-claim'));
  check('the queued prompt survived all of it', queuedStillThere === 1, String(queuedStillThere));

  // A newcomer to a claimed session is refused with its own code, and the row is untouched.
  const rival = opened(await harness());
  const firstHolder = await post(rival.socketPath, 'register', registerBody(S('ses-late')), { sid: S('ses-late') });
  rival.registry.get(S('ses-late'))!.peerPid = 4_243;
  const newcomer = await post(rival.socketPath, 'register', registerBody(S('ses-late')), { sid: S('ses-late') });
  check('a second live process is refused the session', newcomer.status === 409 && newcomer.body.code === 'session_claimed', `status=${newcomer.status} ${JSON.stringify(newcomer.body).slice(0, 70)}`);
  check('the first claimant keeps the row', firstHolder.status === 200 && rival.registry.get(S('ses-late'))!.peerPid === 4_243);
  check('and the newcomer draws nothing while it is shut out', rival.registry.status(S('ses-late')).registration?.peerPid === 4_243);

  // The other half of the rule: a claimant whose process is gone stops holding the session.
  const defunct = opened(await harness({ livenessAlive: false }));
  const owner = await post(defunct.socketPath, 'register', registerBody(S('ses-dead')), { sid: S('ses-dead') });
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  await post(defunct.socketPath, 'hold', { sessionId: S('ses-dead'), requestId: 'cm-dead', tool: 'Bash', decision: 'ask', input: 'command: left behind' }, { sid: S('ses-dead') });
  const stuck = post(defunct.socketPath, 'hold', { sessionId: S('ses-dead'), requestId: 'cm-dead', tool: 'Bash', decision: 'ask', input: 'command: left behind' }, { sid: S('ses-dead'), timeoutMs: 6_000 });
  await sleep(150);
  check('the dying claimant has a hold open', defunct.holds.isOpen(S('ses-dead'), 'cm-dead'));
  const takeover = await post(defunct.socketPath, 'register', registerBody(S('ses-dead')), { sid: S('ses-dead') });
  const cancelled = await stuck;
  check('a dead claimant\u2019s pid frees the session for the next registration', owner.status === 200 && takeover.status === 200 && defunct.registry.get(S('ses-dead'))!.peerPid === process.pid, `status=${takeover.status}`);
  check('and the broker cancels every hold the dead process left', defunct.holds.isOpen(S('ses-dead'), 'cm-dead') === false
    && defunct.audit.list({ sessionId: S('ses-dead'), includeReleases: true }).some((row) => row.released === 'replaced'), JSON.stringify(cancelled.body).slice(0, 70));

  // A broker child is refused on every route, not only at registration.
  const kid = opened(await harness({ isBrokerChild: () => true }));
  const kidRegister = await post(kid.socketPath, 'register', registerBody(S('ses-child')), { sid: S('ses-child') });
  const kidPoll = await post(kid.socketPath, 'poll', { sessionId: S('ses-child'), wait: 10 }, { sid: S('ses-child') });
  check('a broker child is refused at register', kidRegister.status === 403 && kidRegister.body.code === 'broker_child', `status=${kidRegister.status}`);
  check('and on the poll route too', kidPoll.status === 403 && kidPoll.body.code === 'broker_child', `status=${kidPoll.status}`);

  // The query and the body have to name the same session.
  const crossed = await post(h.socketPath, 'poll', { sessionId: S('ses-1'), wait: 10 }, { sid: S('ses-park') });
  check('a poll aimed at one row with another\u2019s body is refused', crossed.status === 403 && crossed.body.code === 'session_mismatch', `status=${crossed.status} ${JSON.stringify(crossed.body).slice(0, 60)}`);

  // A replacement closes what the old holder had open, and the new one cannot inherit it.
  const handover = opened(await harness());
  await post(handover.socketPath, 'register', registerBody(S('ses-hand')), { sid: S('ses-hand') });
  // The broker answers the first `hold` for a call with an ack, before the wait for the
  // verdict: the terminal may only put its band up once somebody is really waiting. The re-offer
  // beside it is the leg that parks, which is what the mod does.
  await post(handover.socketPath, 'hold', { sessionId: S('ses-hand'), requestId: 'cm-1', tool: 'Bash', decision: 'ask', input: 'command: the first call' }, { sid: S('ses-hand') });
  const held = post(handover.socketPath, 'hold', { sessionId: S('ses-hand'), requestId: 'cm-1', tool: 'Bash', decision: 'ask', input: 'command: the first call' }, { sid: S('ses-hand'), timeoutMs: 9_000 });
  await sleep(150);
  check('the first process has a hold open', handover.holds.isOpen(S('ses-hand'), 'cm-1'));
  const reopened = await post(handover.socketPath, 'register', registerBody(S('ses-hand')), { sid: S('ses-hand') });
  const handedRelease = await held;
  check('a re-registration closes the dead holder\u2019s hold', reopened.status === 200 && handover.holds.isOpen(S('ses-hand'), 'cm-1') === false, `status=${reopened.status}`);
  // The parked connection is told to register again rather than handed the release: its row is
  // gone, so re-registering is the only useful thing it can do. The reason still lands where it
  // has to -- the audit row, which is what anyone reading this afterwards looks at.
  check('and the parked connection is sent back to register', JSON.stringify(handedRelease.body).includes('no_registration'), JSON.stringify(handedRelease.body).slice(0, 90));
  const replacedRows = handover.audit.list({ sessionId: S('ses-hand'), includeReleases: true }).filter((row) => row.released === 'replaced');
  check('and the audit says the hold was closed by a replacement', replacedRows.length === 1, JSON.stringify(replacedRows.map((row) => row.released)));
  const secondHold = await post(handover.socketPath, 'hold', { sessionId: S('ses-hand'), requestId: 'cm-1', tool: 'Write', decision: 'ask', input: 'file_path: /etc/passwd' }, { sid: S('ses-hand'), timeoutMs: 3_000 });
  check('the new process opens its own hold under the same id', secondHold.status === 200 && handover.holds.isOpen(S('ses-hand'), 'cm-1') === true, `status=${secondHold.status}`);
  // The new holder gets a fresh ack and nothing else. What it must NOT get is the previous
  // generation's settled outcome, which would decide a call nobody has shown anybody yet.
  check('and does not inherit the old hold\u2019s settled answer',
    (secondHold.body as { held?: boolean; verdict?: unknown; answer?: unknown }).held === true
      && (secondHold.body as { verdict?: unknown }).verdict === undefined
      && (secondHold.body as { answer?: unknown }).answer === undefined,
    JSON.stringify(secondHold.body).slice(0, 80));

  // ── Restart, and the refusal ledger ──
  const restarted = await post(h.socketPath, 'register', registerBody(S('mod-a')), { sid: S('mod-a') });
  check('a restart of the same session id replaces its row', restarted.status === 200 && h.registered.filter((id) => id === S('mod-a')).length >= 2);
  const allRefusals = [...cleaned].flatMap((local) => local.refusals);
  check('every refusal was reported to the caller', allRefusals.length >= 8, String(allRefusals.length));
  check('refusal codes are the stable wire strings', allRefusals.every((code) => /^[a-z_]+$/.test(code)), [...new Set(allRefusals)].join(', '));

  // ── Two brokers, one state directory ──
  //
  // A source run pointed at a real state dir, or a restart that overlaps its predecessor: both
  // want the SAME socket name. BH3: the second one used to unlink the first one's live socket on
  // its way in, and every open terminal's mod lost the broker serving it. It now probes the name
  // and refuses to start over a listener that answers. A socket nobody answers on -- a crashed
  // broker's -- is still replaced, or true sync would never come back after a crash.
  //
  // What a loser may not do either is delete the name on its way OUT. The name can still change
  // hands under a listener (an older broker that unlinks by name, a person cleaning up by hand),
  // and the inode is the only answer to "is this still mine".
  {
    const sharedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-shared-')));
    const sharedPath = join(sharedRoot, MOD_SOCKET_FILENAME);
    const listener = () => new ModSocketServer({
      socketPath: sharedPath,
      registry: new ModRegistry({ startTime: () => 'start', liveness: () => ({ alive: true, identityKnown: true }) }),
      holds: new ModHoldStore({
        registry: new ModRegistry({ startTime: () => 'start', liveness: () => ({ alive: true, identityKnown: true }) }),
        audit: new ModAuditStore(),
        gate: () => ({ mode: 'default', viewers: 1, killSwitch: false }),
      }),
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    const reachable = () => new Promise<string>((resolve) => {
      const socket = net.createConnection({ path: sharedPath }, () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', () => resolve('refused'));
      setTimeout(() => resolve('hung'), 2_000);
    });

    const holder = listener();
    await holder.start();
    const holderInode = lstatSync(sharedPath).ino;
    const second = listener();
    let secondRefusal = '';
    try {
      await second.start();
    } catch (error) {
      secondRefusal = String((error as Error)?.message ?? error);
    }
    check('BH3: a second broker refuses to start over a listener that answers', !second.listening && /answering on/.test(secondRefusal), secondRefusal);
    check('BH3: and the listener keeps its socket', existsSync(sharedPath) && lstatSync(sharedPath).ino === holderInode
      && (await reachable()) === 'connected');
    second.close();
    check('BH3: the refused broker\u2019s close leaves it alone too', existsSync(sharedPath) && lstatSync(sharedPath).ino === holderInode);

    // The name changes hands under the holder, by somebody else's unlink.
    unlinkSync(sharedPath);
    const thief = listener();
    await thief.start();
    const stolenInode = lstatSync(sharedPath).ino;
    check('a broker started on a free name binds it', thief.listening && stolenInode !== holderInode, `ino ${holderInode} -> ${stolenInode}`);
    // The loser closes. The winner's socket must survive it.
    holder.close();
    check('a losing broker close leaves the winner\u2019s socket in place',
      existsSync(sharedPath) && lstatSync(sharedPath).ino === stolenInode,
      existsSync(sharedPath) ? `ino ${lstatSync(sharedPath).ino}` : 'gone');
    check('and the winner still answers on it', (await reachable()) === 'connected');
    // The owner closing IS allowed to remove it.
    thief.close();
    check('the owner close removes its own socket', !existsSync(sharedPath), existsSync(sharedPath) ? 'still there' : 'gone');

    // A broker killed outright leaves its socket file with nothing behind it.
    const crashed = Bun.spawn(['bun', '-e', 'Bun.listen({ unix: process.argv[1], socket: { data() {} } }); console.log("bound"); setInterval(() => {}, 1000);', sharedPath], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    });
    const bound = await Promise.race([
      new Response(crashed.stdout).text().then(() => 'eof'),
      (async () => {
        for (let i = 0; i < 100 && !existsSync(sharedPath); i += 1) await sleep(50);
        return existsSync(sharedPath) ? 'bound' : 'never';
      })(),
    ]);
    crashed.kill('SIGKILL');
    await crashed.exited;
    check('BH3: a killed broker leaves its socket behind, answering nothing', bound === 'bound' && existsSync(sharedPath)
      && lstatSync(sharedPath).isSocket() && (await reachable()) === 'refused', bound);
    const successor = listener();
    let successorError = '';
    try {
      await successor.start();
    } catch (error) {
      successorError = String((error as Error)?.message ?? error);
    }
    check('BH3: the next broker replaces a socket nothing answers on', successor.listening && (await reachable()) === 'connected', successorError);
    successor.close();
    rmSync(sharedRoot, { recursive: true, force: true });
  }

  // ── BH3: a close while the start is still probing binds nothing ──
  {
    const probingRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cmts-probing-')));
    const probingPath = join(probingRoot, MOD_SOCKET_FILENAME);
    // A crashed predecessor's name, so the start has to probe before it can bind.
    const leftover = Bun.spawn(['bun', '-e', 'Bun.listen({ unix: process.argv[1], socket: { data() {} } }); setInterval(() => {}, 1000);', probingPath], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    for (let i = 0; i < 100 && !existsSync(probingPath); i += 1) await sleep(50);
    leftover.kill('SIGKILL');
    await leftover.exited;
    const registry = new ModRegistry({ startTime: () => 'start', liveness: () => ({ alive: true, identityKnown: true }) });
    const late = new ModSocketServer({
      socketPath: probingPath,
      registry,
      holds: new ModHoldStore({ registry, audit: new ModAuditStore(), gate: () => ({ mode: 'default', viewers: 1, killSwitch: false }) }),
      killSwitch: () => false,
      log: { warn: () => {} },
    });
    const starting = late.start();
    late.close();
    await starting.catch(() => undefined);
    check('BH3: a broker stopped while its start was probing never binds', !late.listening
      && (!existsSync(probingPath) || lstatSync(probingPath).isSocket()), `listening=${late.listening}`);
    const afterwards = await new Promise<string>((resolve) => {
      const socket = net.createConnection({ path: probingPath }, () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', () => resolve('refused'));
      setTimeout(() => resolve('hung'), 2_000);
    });
    check('BH3: and nothing answers on its socket afterwards', afterwards === 'refused', afterwards);
    rmSync(probingRoot, { recursive: true, force: true });
  }

  // ── BH2: the claimant is a pid AND the time it started ──
  //
  // Between a terminal's death and the sweep that retires its row, the kernel may hand the same pid
  // to another process. The per-route check compared the pid alone, so that process was answered as
  // the terminal. Here the start time the registry reads changes under one pid, which is exactly
  // what a recycled pid looks like from the broker.
  {
    let started: string | undefined = 'start-A';
    const recycled = opened(await harness({ startTime: () => started }));
    const sid = S('ses-recycled');
    const registered = await post(recycled.socketPath, 'register', registerBody(sid), { sid });
    check('BH2: a terminal whose start time can be read registers', registered.status === 200, JSON.stringify(registered.body).slice(0, 120));
    check('BH2: and its start time is on the row', recycled.registry.get(sid)?.peerPidStart === 'start-A');
    const live = await post(recycled.socketPath, 'poll', { sessionId: sid, wait: 5 }, { sid });
    check('BH2: while it is the same process, it is answered', live.status === 200, JSON.stringify(live.body).slice(0, 120));
    started = 'start-B';
    const refusalsBefore = recycled.refusals.length;
    const poll = await post(recycled.socketPath, 'poll', { sessionId: sid, wait: 5 }, { sid });
    const holdReply = await post(recycled.socketPath, 'hold', { sessionId: sid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid });
    const event = await post(recycled.socketPath, 'event', { sessionId: sid, kind: 'session.end' }, { sid });
    check('BH2: the same pid started at another time is refused on every route',
      [poll, holdReply, event].every((reply) => reply.status === 403 && reply.body.code === 'peer_mismatch'),
      JSON.stringify([poll, holdReply, event].map((reply) => [reply.status, reply.body.code])));
    check('BH2: it opened nothing and ended nothing', recycled.holds.openCount() === 0 && recycled.registry.get(sid) !== undefined
      && recycled.refusals.slice(refusalsBefore).every((code) => code === 'peer_mismatch'), JSON.stringify(recycled.refusals.slice(refusalsBefore)));

    // A start time that cannot be read is no identity at all, and a row registered without one could
    // never be told from its successor, so it would never be retired as dead.
    started = undefined;
    const unknown = await post(recycled.socketPath, 'register', registerBody(S('ses-no-start')), { sid: S('ses-no-start') });
    check('BH2: a terminal whose start time cannot be read is not registered', unknown.status === 403 && unknown.body.code === 'peer_unavailable'
      && recycled.registry.get(S('ses-no-start')) === undefined, JSON.stringify(unknown.body).slice(0, 160));
  }

  // ── BH6: every identifier is held to its shape before anything keys, logs or draws by it ──
  {
    const strict = opened(await harness());
    const sid = S('ses-strict');
    const asCode = (reply: Reply) => `${reply.status} ${String(reply.body.code)}`;
    await post(strict.socketPath, 'register', registerBody(sid), { sid });
    check('BH6: a well-formed registration still registers', strict.registry.get(sid) !== undefined);

    const badEscape = await post(strict.socketPath, 'poll', { sessionId: sid, wait: 5 }, { sid: '%E0%A4%A' });
    check('BH6: a sid that is not valid percent-encoding answers 400, not 500', asCode(badEscape) === '400 invalid_message', asCode(badEscape));
    const controlSid = await post(strict.socketPath, 'poll', { sessionId: sid, wait: 5 }, { sid: encodeURIComponent(`${sid}\n[forged] broker line`) });
    check('BH6: a sid carrying a control character answers 400', asCode(controlSid) === '400 invalid_message', asCode(controlSid));
    const longSid = 'a'.repeat(300);
    const longRegister = await post(strict.socketPath, 'register', registerBody(longSid));
    const longPoll = await post(strict.socketPath, 'poll', { sessionId: longSid, wait: 5 }, { sid: longSid });
    check('BH6: a session id that is not a Claude session id is refused on register and on poll, never truncated into one',
      asCode(longRegister) === '400 invalid_message' && asCode(longPoll) === '400 invalid_message'
        && !strict.registry.list().some((row) => row.sessionId.startsWith('aaaa')), `${asCode(longRegister)} / ${asCode(longPoll)}`);

    const badVersion = await post(strict.socketPath, 'register', registerBody(S('ses-strict-2'), { claudeVersion: '2.1.290\n[forged]' }));
    const badSurface = await post(strict.socketPath, 'register', registerBody(S('ses-strict-2'), { surface: 'terminal\u001b[2J' }));
    check('BH6: a version or a surface outside its charset is refused', asCode(badVersion) === '400 invalid_message'
      && asCode(badSurface) === '400 invalid_message' && strict.registry.get(S('ses-strict-2')) === undefined,
      `${asCode(badVersion)} / ${asCode(badSurface)}`);
    await post(strict.socketPath, 'register', registerBody(S('ses-strict-3'), { model: 'claude\u0007-opus' }), { sid: S('ses-strict-3') });
    check('BH6: a model id with a control character is dropped, not stored', strict.registry.get(S('ses-strict-3')) !== undefined
      && strict.registry.get(S('ses-strict-3'))?.model === undefined, String(strict.registry.get(S('ses-strict-3'))?.model));

    const nulId = await post(strict.socketPath, 'hold', { sessionId: sid, requestId: 'cm-1\u0000x', tool: 'Bash', decision: 'ask' }, { sid });
    const longId = await post(strict.socketPath, 'hold', { sessionId: sid, requestId: 'c'.repeat(65), tool: 'Bash', decision: 'ask' }, { sid });
    const badToolUse = await post(strict.socketPath, 'hold', { sessionId: sid, requestId: 'cm-2', tool: 'Bash', decision: 'ask', toolUseId: 'toolu 01' }, { sid });
    const badTool = await post(strict.socketPath, 'hold', { sessionId: sid, requestId: 'cm-3', tool: 'Bash\n', decision: 'ask' }, { sid });
    check('BH6: a hold whose ids or tool name are out of shape is refused, and opens nothing',
      [nulId, longId, badToolUse, badTool].every((reply) => asCode(reply) === '400 invalid_message') && strict.holds.openCount() === 0,
      [nulId, longId, badToolUse, badTool].map(asCode).join(', '));
    const badKind = await post(strict.socketPath, 'event', { sessionId: sid, kind: 'turn.start\r\n' }, { sid });
    const badEventId = await post(strict.socketPath, 'event', { sessionId: sid, kind: 'user-cancel', requestId: 'cm-1\u0000' }, { sid });
    check('BH6: an event whose kind or request id is out of shape is refused', asCode(badKind) === '400 invalid_message'
      && asCode(badEventId) === '400 invalid_message', `${asCode(badKind)} / ${asCode(badEventId)}`);
    await post(strict.socketPath, 'event', { sessionId: sid, kind: 'turn.start', detail: { turnId: 'turn\nforged' } }, { sid });
    check('BH6: a turn id out of shape is not taken as the turn a Stop would be aimed at', strict.registry.currentTurn(sid) === '',
      JSON.stringify(strict.registry.currentTurn(sid)));
    await post(strict.socketPath, 'event', { sessionId: sid, kind: 'turn.start', detail: { turnId: '445ff9d6-d9d8-4413-845d-7c0040757bac' } }, { sid });
    check('BH6: and a real one is', strict.registry.currentTurn(sid) === '445ff9d6-d9d8-4413-845d-7c0040757bac');
  }

  // ── BH10: what a response that never left takes with it ──
  //
  // A failed write is forced here, for exactly the responses chosen, by standing in for the one
  // method that writes. Everything around it -- the queue, the hold store, the parked polls -- is real.
  {
    const realRespond = Http1RequestReader.prototype.respond;
    let failWhen: (body: string) => boolean = () => false;
    Http1RequestReader.prototype.respond = async function (this: Http1RequestReader, socket, status, body) {
      if (failWhen(body)) {
        failWhen = () => false;
        socket.end();
        return false;
      }
      return realRespond.call(this, socket, status, body);
    };
    try {
      // A requeued command wakes a poll that is already parked, rather than waiting out its wait.
      const writer = opened(await harness());
      const sid = S('ses-writer');
      await post(writer.socketPath, 'register', registerBody(sid), { sid });
      const first = post(writer.socketPath, 'poll', { sessionId: sid, wait: 4_000 }, { sid });
      const second = post(writer.socketPath, 'poll', { sessionId: sid, wait: 4_000 }, { sid });
      await sleep(150);
      failWhen = (body) => body.includes('"command"');
      const sentAt = Date.now();
      writer.server.enqueue(sid, { requestId: 'c-requeue', op: 'prompt', text: 'carry me', queuedAt: Date.now() });
      const replies = await Promise.all([first, second]);
      const carried = replies.find((reply) => (reply.body.command as { requestId?: string } | undefined)?.requestId === 'c-requeue');
      check('BH10: a command whose response never left is carried by the poll already parked, at once',
        carried !== undefined && Date.now() - sentAt < 2_000 && writer.registry.queuedCount(sid) === 0,
        `${replies.map((reply) => `${reply.status}:${JSON.stringify(reply.body).slice(0, 60)}`).join(' | ')} after ${Date.now() - sentAt} ms`);

      // A verdict the poll leg took and could not deliver is still there for the hold leg.
      const putBack = opened(await harness());
      const pid = S('ses-put-back');
      await post(putBack.socketPath, 'register', registerBody(pid), { sid: pid });
      const ack = await post(putBack.socketPath, 'hold', { sessionId: pid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid: pid });
      putBack.server.answer(pid, 'cm-1', 'allow', 'app');
      failWhen = (body) => body.includes('"verdict"');
      const lostPoll = await post(putBack.socketPath, 'poll', { sessionId: pid, wait: 500 }, { sid: pid });
      const holdLeg = await post(putBack.socketPath, 'hold', { sessionId: pid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid: pid });
      check('BH10: a verdict whose poll-leg response never left is handed to the hold leg, not called settled elsewhere',
        ack.body.held === true && lostPoll.status === 0
          && (holdLeg.body.verdict as { behavior?: string } | undefined)?.behavior === 'allow' && holdLeg.body.settledElsewhere === undefined,
        `${lostPoll.status} then ${JSON.stringify(holdLeg.body).slice(0, 120)}`);
      const again = await post(putBack.socketPath, 'hold', { sessionId: pid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid: pid });
      check('BH10: and once it has left, it is not handed over again', again.body.verdict === undefined && again.body.settledElsewhere !== undefined,
        JSON.stringify(again.body).slice(0, 120));

      // The other way round: the hold leg took the verdict and could not deliver it; the poll leg can.
      const holdSide = opened(await harness({ holdPollWaitMs: 3_000 }));
      const hsid = S('ses-hold-side');
      await post(holdSide.socketPath, 'register', registerBody(hsid), { sid: hsid });
      await post(holdSide.socketPath, 'hold', { sessionId: hsid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid: hsid });
      const parkedHold = post(holdSide.socketPath, 'hold', { sessionId: hsid, requestId: 'cm-1', tool: 'Bash', decision: 'ask' }, { sid: hsid });
      await sleep(100);
      failWhen = (body) => body.includes('"verdict"');
      holdSide.server.answer(hsid, 'cm-1', 'deny', 'app');
      const lostHold = await parkedHold;
      const pollLeg = await post(holdSide.socketPath, 'poll', { sessionId: hsid, wait: 500 }, { sid: hsid });
      check('BH10: a verdict whose hold-leg response never left is carried by the poll leg',
        lostHold.status === 0 && (pollLeg.body.verdict as { behavior?: string } | undefined)?.behavior === 'deny',
        `${lostHold.status} then ${JSON.stringify(pollLeg.body).slice(0, 120)}`);
    } finally {
      Http1RequestReader.prototype.respond = realRespond;
    }

    // A poll whose terminal hung up is not reported as a registration that ended.
    const hangup = opened(await harness());
    const hid = S('ses-hangup');
    await post(hangup.socketPath, 'register', registerBody(hid), { sid: hid });
    const refusalsBefore = hangup.refusals.length;
    await post(hangup.socketPath, 'poll', { sessionId: hid, wait: 300 }, { sid: hid, timeoutMs: 80 });
    await sleep(500);
    check('BH10: a poll whose connection closed is not answered as a registration that ended',
      !hangup.refusals.slice(refusalsBefore).includes('no_registration') && hangup.registry.get(hid) !== undefined,
      JSON.stringify(hangup.refusals.slice(refusalsBefore)));
  }

  // ── BH8: the broker-child check walks the parent chain; it does not scan every process ──
  {
    const plain = opened(await harness());
    const fs = require('node:fs') as { readdirSync: (path: unknown, ...rest: unknown[]) => unknown };
    const original = fs.readdirSync;
    let procScans = 0;
    fs.readdirSync = (path: unknown, ...rest: unknown[]) => {
      if (String(path) === '/proc') procScans += 1;
      return original.call(fs, path, ...rest);
    };
    try {
      await post(plain.socketPath, 'register', registerBody(S('ses-no-scan')), { sid: S('ses-no-scan') });
      await post(plain.socketPath, 'poll', { sessionId: S('ses-no-scan'), wait: 5 }, { sid: S('ses-no-scan') });
      await post(plain.socketPath, 'event', { sessionId: S('ses-no-scan'), kind: 'turn.start', detail: { turnId: 't-1' } }, { sid: S('ses-no-scan') });
    } finally {
      fs.readdirSync = original;
    }
    check('BH8: three requests through the real broker-child check list /proc no times', procScans === 0, `${procScans} scans`);
    check('BH8: and the requests were served', plain.registry.get(S('ses-no-scan'))?.currentTurnId === 't-1');
  }

  // ── MB3: a settled outcome is handed over, and a call is never held twice ──
  {
    const m = opened(await harness({ holdPollWaitMs: 2_000 }));
    const sid = S('ses-settled');
    const hold = (requestId: string, options: { timeoutMs?: number } = {}) =>
      post(m.socketPath, 'hold', { sessionId: sid, requestId, tool: 'Bash', decision: 'ask', input: `command: ${requestId}` }, { sid, ...options });
    const verdictOf = (reply: Reply) => reply.body.verdict as { requestId?: string; behavior?: string } | undefined;
    const elsewhereOf = (reply: Reply) => reply.body.settledElsewhere as { requestId?: string } | undefined;
    await post(m.socketPath, 'register', registerBody(sid), { sid });

    // The app answers while the mod is between its ack and its wait: the wait's request is a re-offer.
    const ack = await hold('cm-1');
    check('MB3: the ask is acknowledged', ack.body.held === true, JSON.stringify(ack.body).slice(0, 160));
    m.server.answer(sid, 'cm-1', 'allow', 'app');
    const reoffer = await hold('cm-1');
    check('MB3: a hold re-offered after the app answered is handed that answer', verdictOf(reoffer)?.behavior === 'allow'
      && verdictOf(reoffer)?.requestId === 'cm-1', JSON.stringify(reoffer.body).slice(0, 160));
    check('MB3: at once, not after a wait', reoffer.elapsedMs < 1_000, `${reoffer.elapsedMs} ms`);
    const after = await hold('cm-1');
    check('MB3: offered again after that, it is told settled-elsewhere', elsewhereOf(after)?.requestId === 'cm-1', JSON.stringify(after.body).slice(0, 160));
    check('MB3: and no second hold is opened for a call already decided', m.holds.openCount() === 0 && !m.holds.isOpen(sid, 'cm-1'),
      `${m.holds.openCount()} open`);

    // The poll leg carries the answer first, and then the hold leg asks.
    await hold('cm-2');
    m.server.answer(sid, 'cm-2', 'deny', 'app');
    const poll = await post(m.socketPath, 'poll', { sessionId: sid, wait: 500 }, { sid });
    check('MB3: the poll leg carries the answer when it gets there first', verdictOf(poll)?.requestId === 'cm-2' && verdictOf(poll)?.behavior === 'deny',
      JSON.stringify(poll.body).slice(0, 160));
    const late = await hold('cm-2');
    check('MB3: the hold leg after it is told settled-elsewhere, not handed an empty answer', elsewhereOf(late)?.requestId === 'cm-2', JSON.stringify(late.body).slice(0, 160));
    check('MB3: and it opens no ghost hold that would live out the deadline', m.holds.openCount() === 0 && !m.holds.isOpen(sid, 'cm-2'),
      `${m.holds.openCount()} open`);

    // Both legs parked on the same hold when the answer lands.
    await hold('cm-3');
    const parkedPoll = post(m.socketPath, 'poll', { sessionId: sid, wait: 3_000 }, { sid });
    const parkedHold = hold('cm-3', { timeoutMs: 6_000 });
    await sleep(150);
    m.server.answer(sid, 'cm-3', 'allow', 'app');
    const [pollLeg, holdLeg] = await Promise.all([parkedPoll, parkedHold]);
    const carried = [pollLeg, holdLeg].filter((reply) => verdictOf(reply)?.requestId === 'cm-3');
    check('MB3: with both legs parked on one hold, the answer is carried exactly once', carried.length === 1,
      JSON.stringify([pollLeg.body, holdLeg.body]).slice(0, 240));
    check('MB3: and the hold leg is either handed it or told settled-elsewhere, never an empty answer',
      verdictOf(holdLeg)?.requestId === 'cm-3' || elsewhereOf(holdLeg)?.requestId === 'cm-3', JSON.stringify(holdLeg.body).slice(0, 160));

    // A new registration is a new process: its own `cm-1` is a new call, not one decided before.
    await post(m.socketPath, 'register', registerBody(sid), { sid });
    const fresh = await hold('cm-1');
    check('MB3: after a re-registration, a reused request id is a new call and is held', fresh.body.held === true, JSON.stringify(fresh.body).slice(0, 160));
  }

  // ── Shutdown ──
  h.server.close();
  check('close stops the listener', h.server.listening === false);
  const reconnect = await new Promise<string>((resolve) => {
    const socket = net.createConnection({ path: h.socketPath }, () => resolve('connected'));
    socket.on('error', () => resolve('refused'));
    setTimeout(() => resolve('hung'), 2_000);
  });
  check('the socket stops accepting after close', reconnect === 'refused', reconnect);

  // ── the mod's remembered turn end, carried by a registration ──
  // A hint the broker uses after a restart. An unusable value is dropped, never a refusal: a terminal
  // that lost its registration over it would lose true sync.
  const sid = randomUUID();
  const kept = parseModRegister(registerBody(sid, { turnEndedAt: 1_791_000_000_000 }));
  check('a registration keeps the turn end the mod says', kept.ok && kept.message.turnEndedAt === 1_791_000_000_000, JSON.stringify(kept));
  for (const bad of ['1791000000000', -5, 0, 1.5, Number.MAX_VALUE, null, { at: 1 }]) {
    const parsed = parseModRegister(registerBody(sid, { turnEndedAt: bad }));
    check(`a registration with turnEndedAt ${JSON.stringify(bad)} is accepted without it`,
      parsed.ok && parsed.message.turnEndedAt === undefined, JSON.stringify(parsed));
  }
} catch (error) {
  check('no exception', false, String((error as Error)?.stack ?? error).slice(0, 300));
} finally {
  for (const local of cleaned) {
    try {
      local.server.close();
    } catch {
      // already closed
    }
    rmSync(local.root, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length} passed`}`);
process.exit(failed.length ? 1 : 0);
