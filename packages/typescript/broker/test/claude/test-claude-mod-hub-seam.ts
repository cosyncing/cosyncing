/**
 * The mod's turns and cards as the Hub sees them: what a session's row says after the terminal's
 * turn ends, and what a socket is drawn.
 *
 * Everything on the broker side is real: `ClaudeModService` bound in a mkdtemp directory, with its
 * `ModSocketServer`, registry and hold store; the real `Hub`, which is what decides Working or Idle
 * for the roster and what a socket that joins later is replayed; and the real `ClaudeModConnection`
 * (a synced attach, `live` or `plain`) and `ClaudeObserveConnection` (a tab's Observe attach)
 * tailing a real transcript file. The adapter in the Hub's registry hands those out the way the
 * Claude adapter does: a mod seat for `live`, and for a bare attach a plain mod seat while the
 * session's mod is live and an Observe mirror otherwise. A suite can also force the mirror, which is
 * what a tab opened before the mod registered still holds. The mod side is the shipped `register.js`
 * behind a `$` whose `http.fetch` is a real fetch over the socket. What a test cannot have is faked:
 * the engine beneath `next(e)` -- Claude's own question picker included, which stays open until a
 * test answers it the way a person at the keyboard would -- and Claude writing its transcript, which
 * this suite does by hand in the shapes Claude writes.
 *
 *   bun run packages/typescript/broker/test/claude/test-claude-mod-hub-seam.ts   (exit 0 = all pass)
 */
export {};
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeModService, modCancelAttribution } from '../../src/sessions/claude-mod-service.ts';
import { routeModAnswer, type ModRouteDeps } from '../../src/sessions/mod-client-messages.ts';
import { Hub, type ManagedConn } from '../../src/sessions/hub.ts';
import { AgentRegistry, type AgentMessage, type SessionInfo } from '../../../adapter-api/src/index.ts';
import { ClaudeModConnection } from '../../../adapters/claude/src/mod-connection.ts';
import { ClaudeObserveConnection, claudeSessionId } from '../../../adapters/claude/src/implementation.ts';
import { ledger, loadMod, tempRoot, until, type ModInstance } from './claude-mod-seam-harness.ts';

const { check, finish } = ledger();

const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String((reason as Error)?.message ?? reason).slice(0, 200));
});

const cleanups: (() => void | Promise<void>)[] = [];

/** One frame a Hub client was sent. */
interface Received {
  at: number;
  message: AgentMessage & { requestId?: string; key?: string; status?: string };
}

interface HubStack {
  sessionId: string;
  hubId: string;
  transcript: string;
  service: ClaudeModService;
  hub: Hub;
  mod: ModInstance;
  /** The synced attach: the app's foreground socket. */
  live: ManagedConn;
  /** Every live frame the synced attach's client was sent. */
  liveFrames: Received[];
  /** Every SessionInfo the synced attach's client was sent, as it was when sent. */
  liveSessions: SessionInfo[];
  /** The synced attach's socket closes, and the Hub is told, as the runtime tells it. */
  detachLive(): void;
  /** A new synced attach, primed, as a reload makes one. */
  attachLive(): Promise<{ managed: ManagedConn; frames: Received[] }>;
  /**
   * Attach a tab's Observe mirror on the same session, primed as an attach primes it, whatever the
   * mod's state: what a tab opened before the mod registered still holds.
   */
  attachObserve(): Promise<{ managed: ManagedConn; frames: Received[] }>;
  /** Attach a tab without asking for a mode, as a resident or background tab does: the adapter's choice. */
  attachPlain(): Promise<{ managed: ManagedConn; frames: Received[] }>;
  /**
   * Hold the mod's registrations at the socket's door until the returned function is called, the
   * way a terminal that has not reconnected yet holds them.
   */
  holdRegistrations(): () => void;
  /** The terminal's environment, for a second module on the same session. */
  env: Record<string, string>;
  /** Append transcript rows the way Claude does: whole lines, in order. */
  write(...rows: Record<string, unknown>[]): void;
  /** Flip cosyncing's true-sync switch. The mod hears of it on its next poll reply; the gate, at once. */
  setKillSwitch(on: boolean): void;
  /** What the terminal's Claude says of its own permission dialog: open, shut, or nothing to read. */
  setDialogOpen(open: boolean | undefined): void;
  /**
   * Restart the broker half: the service and the Hub close, and new ones bind the same socket, as a
   * restarted broker does. Nothing in memory survives; the mod is the same one, and it registers
   * again on its own. `service` and `hub` then name the new ones; `live` is not replaced.
   */
  restartBroker(): Promise<void>;
  /** The app's frames as the runtime routes them, on the synced row, with the notices it says back. */
  frameDeps: ModRouteDeps;
  notices: string[];
  close(): Promise<void>;
}

interface HubStackOptions {
  turnEndGraceMs?: number;
  /** How long a clientless row lingers. Production's is 15 s. */
  hubGraceMs?: number;
  /** How long a hold outlives its terminal's last request, and how often the sweep looks. */
  holdLeaseMs?: number;
  sweepIntervalMs?: number;
  /**
   * Wire the service's seat upgrade to the Hub the way the runtime does: a tab that cannot draw the
   * mod's cards is re-attached through the adapter on a registration and on a card it cannot draw.
   */
  upgradeSeats?: boolean;
}

/** Whether a connection is a seat in a mod sync: one that can draw the mod's cards. The runtime's test. */
const isModSeat = (conn: unknown): boolean => typeof (conn as { ingestRequest?: unknown } | undefined)?.ingestRequest === 'function';

/** Transcript rows in the shapes Claude writes them. */
const rows = {
  user(uuid: string, text: string, at = Date.now()): Record<string, unknown> {
    return { type: 'user', uuid, parentUuid: null, isSidechain: false, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } };
  },
  /** One streamed assistant line: `stop_reason` stays null until the closing line. */
  streaming(uuid: string, messageId: string, text: string, at = Date.now()): Record<string, unknown> {
    return {
      type: 'assistant', uuid, isSidechain: false, timestamp: new Date(at).toISOString(),
      message: { id: messageId, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }], stop_reason: null, usage: { input_tokens: 3, output_tokens: 5 } },
    };
  },
  endTurn(uuid: string, messageId: string, text: string, at = Date.now()): Record<string, unknown> {
    return {
      type: 'assistant', uuid, isSidechain: false, timestamp: new Date(at).toISOString(),
      message: { id: messageId, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } },
    };
  },
  /** The model's AskUserQuestion call, as the assistant line that carries it. */
  askUserQuestion(uuid: string, messageId: string, toolUseId: string, questions: unknown[], at = Date.now()): Record<string, unknown> {
    return {
      type: 'assistant', uuid, isSidechain: false, timestamp: new Date(at).toISOString(),
      message: { id: messageId, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions } }], stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 9 } },
    };
  },
  /** The call's result line, with the structured answer Claude records beside it. */
  questionAnswered(uuid: string, toolUseId: string, questions: unknown[], answers: Record<string, string>, at = Date.now()): Record<string, unknown> {
    const said = Object.entries(answers).map(([q, a]) => `"${q}"="${a}"`).join(', ');
    return {
      type: 'user', uuid, isSidechain: false, timestamp: new Date(at).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `User has answered your questions: ${said}. You can now continue with the user's answers in mind.` }] },
      toolUseResult: { questions, answers },
    };
  },
  /** What Escape at the keyboard leaves behind. */
  interrupted(uuid: string, at = Date.now()): Record<string, unknown> {
    return { type: 'user', uuid, isSidechain: false, timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  },
};

async function hubStack(label: string, options: HubStackOptions = {}): Promise<HubStack> {
  const temp = tempRoot('cmhub-');
  cleanups.push(temp.remove);
  const sessionId = randomUUID();
  const transcript = join(temp.root, `${sessionId}.jsonl`);
  writeFileSync(transcript, [
    rows.user('u0', 'hello', Date.now() - 60_000),
    rows.endTurn('a0', 'msg_0', 'Hello.', Date.now() - 59_000),
    { type: 'permission-mode', permissionMode: 'default' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const hubId = claudeSessionId(transcript);
  const info = (): SessionInfo => ({ id: hubId, nativeId: sessionId, tool: 'claude', status: 'idle', attachMode: 'observe', cwd: '/work', title: label } as unknown as SessionInfo);

  let service!: ClaudeModService;
  // cosyncing's own true-sync switch, read on every gate check and on every poll reply.
  let killSwitch = false;
  // Claude's own word on its permission dialog, as its process status record would say it.
  let dialogOpen: boolean | undefined;
  /** What a bare attach is answered with: the adapter's choice, or the Observe mirror an early tab holds. */
  let bareSeat: 'adapter' | 'observe' = 'adapter';
  const modSeat = (seat: 'live' | 'plain'): ClaudeModConnection => new ClaudeModConnection({
    info: { ...info(), attachMode: seat === 'live' ? 'live' : 'observe' } as SessionInfo,
    transcriptPath: transcript,
    nativeSessionId: sessionId,
    seat,
    send: (command: unknown): { ok: boolean; code?: string } => service.send(sessionId, command as never),
    steeringEnabled: () => true,
    turnRunning: () => service.currentTurn(sessionId) !== '',
    cardNote: (requestId: string) => service.cardNote(sessionId, requestId),
    turnEndedAt: () => service.turnEndedAt(sessionId),
    // The cards still open, for a seat that opens after they were drawn: the runtime's bridge.
    openCards: () => service.openCards(sessionId),
    ...(options.turnEndGraceMs !== undefined ? { turnEndGraceMs: options.turnEndGraceMs } : {}),
  });
  const registry = new AgentRegistry();
  registry.register({
    id: 'claude', displayName: 'Claude', capabilities: {} as never,
    isAvailable: async () => true, discoverSessions: async () => [],
    // What the Claude adapter hands out: a synced attach writes through the mod, and so does a bare
    // one while the mod is live, as a plain seat. Otherwise a bare one observes.
    attach: async (_id: string, mode?: string) => {
      if (mode === 'live') return modSeat('live');
      if (bareSeat === 'adapter' && service.status(sessionId).state === 'live') return modSeat('plain');
      return new ClaudeObserveConnection(transcript, info(), undefined, {
        ...(options.turnEndGraceMs !== undefined ? { turnEndGraceMs: options.turnEndGraceMs } : {}),
        // The adapter's `observeModTurn`: what an Observe attach of a registered session reads.
        modTurn: { turnRunning: () => service.currentTurn(sessionId) !== '', turnEndedAt: () => service.turnEndedAt(sessionId) },
      });
    },
  } as never);
  let hub = new Hub(registry, options.hubGraceMs ?? 60_000);
  const newService = (): ClaudeModService => new ClaudeModService({
    socketPath: join(temp.root, 'claude-mod.sock'),
    // The runtime's own two lookups, against the real Hub.
    hub: (id) => {
      const mc = hub.getConn('claude', id);
      return mc ? { clientCount: mc.clientCount, conn: mc.conn } : undefined;
    },
    hubAll: (id) => hub.getConns('claude', id).map((mc) => ({ clientCount: mc.clientCount, conn: mc.conn })),
    transcriptPath: () => transcript,
    killSwitch: () => killSwitch,
    permissionDialogOpen: () => dialogOpen,
    dialogPollMs: 50,
    holdPollWaitMs: 20_000,
    ...(options.holdLeaseMs !== undefined ? { holdLeaseMs: options.holdLeaseMs } : {}),
    ...(options.sweepIntervalMs !== undefined ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
    // The runtime's wiring, against the real Hub.
    ...(options.upgradeSeats
      ? { upgradeSeats: (hubId: string) => void hub.reattachUpgradedSeats('claude', hubId, isModSeat).catch(() => undefined) }
      : {}),
  });
  service = newService();
  await service.start();

  const env = { COSYNCING_CLAUDE_SOCK: service.socketPath, HOME: temp.root };
  let registrationGate: Promise<void> = Promise.resolve();
  const mod = await loadMod(label, {
    sessionId,
    env,
    // Claude's own picker stays open beneath a question until a test answers it at the "keyboard".
    openPicker: true,
    beforeFetch: async (sent) => {
      if (sent.route === 'register') await registrationGate;
    },
  });
  (mod.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300 });
  await mod.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
  await until(() => service.status(sessionId).present);
  await until(() => mod.record.requests.some((r) => r.route === 'poll'));

  const clients = new Map<ManagedConn, unknown>();
  const attach = async (mode?: string, bare: 'adapter' | 'observe' = 'adapter'): Promise<{ managed: ManagedConn; frames: Received[]; sessions: SessionInfo[] }> => {
    bareSeat = bare;
    let managed: ManagedConn;
    try {
      managed = await hub.ensure('claude', hubId, mode);
    } finally {
      bareSeat = 'adapter';
    }
    const frames: Received[] = [];
    const sessions: SessionInfo[] = [];
    const client = ((event: { kind?: string; message?: AgentMessage; info?: SessionInfo }) => {
      if (event.kind === 'message' && event.message) frames.push({ at: Date.now(), message: event.message as Received['message'] });
      // A session frame carries the row's info by reference; what the client got is what it said then.
      if (event.kind === 'session' && event.info) sessions.push(JSON.parse(JSON.stringify(event.info)) as SessionInfo);
    });
    managed.addClient(client as never);
    clients.set(managed, client);
    // An attach reads history before it follows the tail: that read is what primes the tail.
    await managed.conn.getHistory();
    return { managed, frames, sessions };
  };
  const { managed: live, frames: liveFrames, sessions: liveSessions } = await attach('live');

  const notices: string[] = [];
  const frameDeps: ModRouteDeps = {
    service,
    // The runtime's own shape: the row's id is the Hub's, not the mod's.
    conn: {
      tool: 'claude',
      id: hubId,
      respondPermission: (requestId: string, decision: string) => live.conn.respondPermission(requestId as never, decision as never),
    },
    send: (frame: Record<string, unknown>) => notices.push(String(frame.message ?? '')),
  };
  const close = async (): Promise<void> => {
    mod.kill();
    service.close();
    await hub.dispose();
  };
  cleanups.push(close);
  const stack: HubStack = {
    sessionId,
    hubId,
    transcript,
    service,
    hub,
    mod,
    live,
    liveFrames,
    liveSessions,
    detachLive: () => {
      live.removeClient(clients.get(live) as never);
      hub.releaseAttached('claude', hubId, 'live', live);
    },
    attachLive: () => attach('live'),
    attachObserve: () => attach(undefined, 'observe'),
    attachPlain: () => attach(undefined),
    holdRegistrations: () => {
      let release!: () => void;
      registrationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        registrationGate = Promise.resolve();
      };
    },
    write: (...lines) => appendFileSync(transcript, lines.map((row) => JSON.stringify(row)).join('\n') + '\n'),
    setKillSwitch: (on) => {
      killSwitch = on;
    },
    setDialogOpen: (open) => {
      dialogOpen = open;
    },
    frameDeps,
    notices,
    env,
    close,
    restartBroker: async () => {
      service.close();
      await hub.dispose();
      hub = new Hub(registry, options.hubGraceMs ?? 60_000);
      service = newService();
      await service.start();
      stack.service = service;
      stack.hub = hub;
    },
  };
  return stack;
}

/** A call's result, or undefined when it has not come back within `ms`: a broken path fails a
 *  named check instead of hanging the suite. */
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

const runKey = (s: HubStack, userUuid: string): string => `${s.sessionId}:run:${userUuid}`;
const summaries = (frames: Received[], key: string) =>
  frames.filter((f) => f.message.type === 'run-summary' && f.message.key === key).map((f) => f.message as AgentMessage & { status: string; completedAt?: number; tokens?: { input: number; output: number } });
/** The newest run-summary for `key` in a history read, which is what a client draws for that turn. */
function newestInHistory(history: AgentMessage[], key: string): (AgentMessage & { status?: string; completedAt?: number }) | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i] as AgentMessage & { key?: string; status?: string };
    if (message.type === 'run-summary' && message.key === key) return message;
  }
  return undefined;
}

/** Start a turn the way Claude does: the hook reports it, then the prompt and a streamed line land. */
async function startTurn(s: HubStack, turnId: string, userUuid: string, rowsAfter: Record<string, unknown>[] = []): Promise<boolean> {
  await s.mod.fire('turn.start', { turnId });
  await until(() => s.service.currentTurn(s.sessionId) === turnId);
  s.write(rows.user(userUuid, `prompt for ${turnId}`), ...rowsAfter);
  return until(() => s.live.turnInFlight());
}

// PR-5: mod turn reports own the live status even when no new transcript rows have landed.
async function workingStatusSection(): Promise<void> {
  const s = await hubStack('pr5-working');
  check('PR-5 start frame: attaching before a prompt reads Idle', s.live.status === 'idle');
  await s.mod.fire('turn.start', { turnId: 'pr5-no-transcript' });
  check('PR-5 start frame: the next prompt reads Working before its transcript arrives',
    await until(() => s.live.status === 'working'), String(s.live.status));
  check('PR-5 start frame: the roster overlay reads Working too',
    s.hub.liveSnapshot().find((row) => row.info.id === s.hubId)?.status === 'working');
  check('PR-5 start frame: the client receives running from the mod',
    s.liveFrames.some((f) => f.message.type === 'status' && f.message.status === 'running')
      && s.liveSessions.at(-1)?.status === 'working');
  await s.mod.fire('turn.complete', { turnId: 'pr5-no-transcript', answer: '', durationMs: 100 });
  check('PR-5 end frame: turn.complete returns the live row to Idle without a transcript close',
    await until(() => s.live.status === 'idle'), String(s.live.status));
  check('PR-5 end frame: the roster and client both receive Idle',
    s.hub.liveSnapshot().find((row) => row.info.id === s.hubId)?.status === 'idle'
      && s.liveFrames.some((f) => f.message.type === 'status' && f.message.status === 'idle')
      && s.liveSessions.at(-1)?.status === 'idle');
  await s.close();
}

// ── P-2: a Stop from the app leaves the session idle, and every seat agrees ─────────────────────
async function appStopSection(): Promise<void> {
  const s = await hubStack('p2-stop', { hubGraceMs: 50 });
  const resident = await s.attachObserve();
  const running = await startTurn(s, 'turn-stop', 'u-stop', [rows.streaming('a-stop-1', 'msg_stop', 'Writing a long')]);
  check('P-2 seam: the turn is running on the synced row', running, `inFlight=${s.live.turnInFlight()}`);
  check('P-2 seam: and on the resident tab\'s Observe row', await until(() => resident.managed.turnInFlight()));

  await s.live.conn.runCommand?.('stop');
  check('P-2 seam: the app\'s Stop reaches $.turn.abort for that turn', await until(() => s.mod.record.aborts.some((a) => a.turnId === 'turn-stop')),
    JSON.stringify(s.mod.record.aborts));
  // The engine stops the turn and fires its end. It writes no interruption row for an abort.
  const completedAt = Date.now();
  await s.mod.fire('turn.complete', { turnId: 'turn-stop', answer: '', durationMs: 900, isAborted: true });
  const idle = await until(() => !s.live.turnInFlight(), 1000);
  check('P-2 seam: within 1 s of turn.complete the synced row is not running', idle, `${Date.now() - completedAt} ms`);
  check('P-2 seam: and the Hub published idle to its client',
    s.liveFrames.some((f) => f.at >= completedAt && f.message.type === 'status' && f.message.status === 'idle'),
    JSON.stringify(s.liveFrames.filter((f) => f.at >= completedAt).map((f) => [f.message.type, f.message.status])));
  check('P-2 seam: the transcript has no interruption row', !readFileSync(s.transcript, 'utf8').includes('Request interrupted'));
  const stopped = summaries(s.liveFrames, runKey(s, 'u-stop'));
  check('P-2 seam: the turn\'s run-summary closes cancelled', stopped.at(-1)?.status === 'cancelled', JSON.stringify(stopped.map((m) => m.status)));
  check('P-2 seam: nothing else holds the synced row in attention retention',
    s.live.requiresAttentionRetention === false && s.live.status === 'idle', `retained=${s.live.requiresAttentionRetention} status=${s.live.status}`);
  check('P-2 seam: the resident tab\'s Observe row is told as well, and is idle',
    await until(() => !resident.managed.turnInFlight(), 1000) && resident.managed.requiresAttentionRetention === false,
    `inFlight=${resident.managed.turnInFlight()} retained=${resident.managed.requiresAttentionRetention}`);

  // ── resync: the same rows, a fresh attach after the synced row was let go ──
  const liveHistory = await s.live.conn.getHistory();
  check('P-2 seam: after the Stop, a resync of the synced row shows the turn not running',
    newestInHistory(liveHistory, runKey(s, 'u-stop'))?.status === 'cancelled', JSON.stringify(newestInHistory(liveHistory, runKey(s, 'u-stop'))));
  const residentHistory = await resident.managed.conn.getHistory();
  check('P-2 seam: and a resync of the resident tab\'s Observe row agrees',
    newestInHistory(residentHistory, runKey(s, 'u-stop'))?.status === 'cancelled', JSON.stringify(newestInHistory(residentHistory, runKey(s, 'u-stop'))));
  check('P-2 seam: and invents no completion time for it', newestInHistory(residentHistory, runKey(s, 'u-stop'))?.completedAt === undefined);
  // A reload after the synced row was released is a new connection that never saw the live end.
  s.detachLive();
  check('P-2 seam: with its socket gone and nothing holding it, the synced row is let go',
    await until(() => !s.hub.getConns('claude', s.hubId).includes(s.live), 2000));
  const fresh = await s.attachLive();
  const freshHistory = await fresh.managed.conn.getHistory();
  check('P-2 seam: a fresh synced attach after the Stop shows the turn not running',
    fresh.managed !== s.live && newestInHistory(freshHistory, runKey(s, 'u-stop'))?.status === 'cancelled',
    JSON.stringify(newestInHistory(freshHistory, runKey(s, 'u-stop'))));
  check('P-2 seam: and its row is not running either', fresh.managed.turnInFlight() === false && fresh.managed.status === 'idle',
    `inFlight=${fresh.managed.turnInFlight()} status=${fresh.managed.status}`);
  await s.close();
}

// ── P-2: a turn the transcript closes keeps its own end ─────────────────────────────────────────
async function normalEndSection(): Promise<void> {
  const s = await hubStack('p2-normal');
  await startTurn(s, 'turn-done', 'u-done', [rows.streaming('a-done-1', 'msg_done', 'Thinking')]);
  await s.mod.fire('turn.complete', { turnId: 'turn-done', answer: 'ok', durationMs: 400, isAborted: false });
  // Claude flushes the closing row a moment after the hook fired.
  await until(() => false, 300);
  s.write(rows.endTurn('a-done-2', 'msg_done', 'Done.'));
  await until(() => !s.live.turnInFlight(), 3000);
  // Past the grace, so a settle that was going to happen has happened.
  await until(() => false, 1800);
  const done = summaries(s.liveFrames, runKey(s, 'u-done'));
  check('P-2 seam: a normal turn whose end_turn row lands 300 ms after turn.complete closes done',
    done.at(-1)?.status === 'done', JSON.stringify(done.map((m) => m.status)));
  check('P-2 seam: with its tokens', (done.at(-1)?.tokens?.output ?? 0) > 0, JSON.stringify(done.at(-1)?.tokens));
  check('P-2 seam: and is never closed cancelled', !done.some((m) => m.status === 'cancelled'), JSON.stringify(done.map((m) => m.status)));
  await s.close();
}

// ── L-1: a Stop that crosses the turn's own end keeps the turn's end ───────────────────────────
async function stopCrossesEndSection(): Promise<void> {
  const s = await hubStack('l1-cross');
  await startTurn(s, 'turn-cross', 'u-cross', [rows.streaming('a-cross-1', 'msg_cross', 'Nearly done')]);
  // The person taps Stop just as the turn finishes on its own: the Stop is queued for this turn,
  // and the mod's turn.complete for it arrives before the abort could do anything.
  await s.live.conn.runCommand?.('stop');
  const stoppedAt = Date.now();
  await s.mod.fire('turn.complete', { turnId: 'turn-cross', answer: 'Done.', durationMs: 700, isAborted: false });
  const idle = await until(() => !s.live.turnInFlight(), 1000);
  check('L-1 seam: a Stop crossing the turn\'s own end still reads idle at once', idle, `${Date.now() - stoppedAt} ms`);
  // Claude flushes the closing row about 195 ms after the hook.
  await until(() => false, 200);
  s.write(rows.endTurn('a-cross-2', 'msg_cross', 'Done.'));
  await until(() => false, 1800);
  const closed = summaries(s.liveFrames, runKey(s, 'u-cross')).filter((m) => m.status !== 'running');
  check('L-1 seam: the turn closes done, with its tokens, once the transcript says so',
    closed.at(-1)?.status === 'done' && (closed.at(-1)?.tokens?.output ?? 0) > 0, JSON.stringify(closed.map((m) => [m.status, m.tokens])));
  const history = await s.live.conn.getHistory();
  const replayed = newestInHistory(history, runKey(s, 'u-cross')) as (AgentMessage & { status?: string; tokens?: { output?: number } }) | undefined;
  check('L-1 seam: and history agrees', replayed?.status === 'done' && (replayed?.tokens?.output ?? 0) > 0, JSON.stringify(replayed));
  await s.close();
}

// ── L-2: history restates a run cancelled only when the mod said it ended ───────────────────────
/** One whole turn the mod reports ending, so the session has a turn end on record before the next. */
async function finishedTurn(s: HubStack, turnId: string, userUuid: string): Promise<void> {
  await startTurn(s, turnId, userUuid, [rows.streaming(`a-${userUuid}-1`, `msg_${userUuid}`, 'Working')]);
  await s.mod.fire('turn.complete', { turnId, answer: 'Done.', durationMs: 300, isAborted: false });
  s.write(rows.endTurn(`a-${userUuid}-2`, `msg_${userUuid}`, 'Done.'));
  await until(() => !s.live.turnInFlight(), 3000);
  // A turn end is stamped when it is heard; the next prompt is written after it.
  await until(() => false, 20);
}

// ── L-2 residual: a turn stopped from the app stays ended across a broker restart ───────────────
async function restartSection(): Promise<void> {
  const s = await hubStack('l2-restart', { turnEndGraceMs: 300 });
  await startTurn(s, 'turn-stopped', 'u-stopped', [rows.streaming('a-stopped-1', 'msg_stopped', 'Writing a long')]);
  await s.live.conn.runCommand?.('stop');
  await until(() => s.mod.record.aborts.some((a) => a.turnId === 'turn-stopped'));
  await s.mod.fire('turn.complete', { turnId: 'turn-stopped', answer: '', durationMs: 900, isAborted: true });
  await until(() => !s.live.turnInFlight(), 1000);
  const key = runKey(s, 'u-stopped');
  // Same broker: an Observe attach made after the Stop never saw the live end.
  const lateObserve = await s.attachObserve();
  check('L-2 residual seam: an Observe attach made after the Stop draws the stopped turn ended',
    newestInHistory(await lateObserve.managed.conn.getHistory(), key)?.status === 'cancelled' && !lateObserve.managed.turnInFlight(),
    `${JSON.stringify(newestInHistory(await lateObserve.managed.conn.getHistory(), key))} inFlight=${lateObserve.managed.turnInFlight()}`);

  // The broker restarts. A synced attach made before the mod is back finds no end on record.
  const registersBefore = s.mod.record.requests.filter((r) => r.route === 'register').length;
  await s.restartBroker();
  const early = await s.attachLive();
  check('L-2 residual seam: right after the restart, before the mod is back, nothing says the turn ended',
    s.service.turnEndedAt(s.sessionId) === undefined && newestInHistory(await early.managed.conn.getHistory(), key)?.status === 'running',
    `endedAt=${String(s.service.turnEndedAt(s.sessionId))}`);
  check('L-2 residual seam: the mod registers again with the restarted broker',
    await until(() => s.service.status(s.sessionId).present, 5000));
  const register = s.mod.record.requests.filter((r) => r.route === 'register').slice(registersBefore).at(-1);
  check('L-2 residual seam: and its registration says when the last turn ended, and that none is running',
    typeof register?.body.turnEndedAt === 'number' && register.body.turnId === undefined, JSON.stringify(register?.body ?? null));
  check('L-2 residual seam: the restarted broker takes that end', s.service.turnEndedAt(s.sessionId) === register?.body.turnEndedAt,
    `${String(s.service.turnEndedAt(s.sessionId))} vs ${String(register?.body.turnEndedAt)}`);
  // That row drew the turn running from its history; the frame that closes it is what its seat sees.
  check('L-2 residual seam: the row attached before the mod was back is sent the stopped turn closed',
    await until(() => summaries(early.frames, key).at(-1)?.status === 'cancelled', 3000) && !early.managed.turnInFlight(),
    JSON.stringify(summaries(early.frames, key).map((m) => m.status)));
  const after = await s.attachObserve();
  check('L-2 residual seam: an Observe attach after the restart draws the turn ended',
    newestInHistory(await after.managed.conn.getHistory(), key)?.status === 'cancelled' && !after.managed.turnInFlight(),
    JSON.stringify(newestInHistory(await after.managed.conn.getHistory(), key)));
  check('L-2 residual seam: so does a synced resync after the restart',
    newestInHistory(await early.managed.conn.getHistory(), key)?.status === 'cancelled');

  // The next turn starts and its prompt lands before its turn.start reaches the broker: the end on
  // record is the stopped turn's, older than this run, so the new run stands.
  s.write(rows.user('u-next', 'the next prompt, not reported yet'), rows.streaming('a-next-1', 'msg_next', 'Starting'));
  await until(() => early.managed.turnInFlight(), 3000);
  await until(() => false, 600);
  check('L-2 residual seam: a turn that started after the remembered end is still drawn running',
    early.managed.turnInFlight() && newestInHistory(await early.managed.conn.getHistory(), runKey(s, 'u-next'))?.status === 'running',
    `inFlight=${early.managed.turnInFlight()} ${JSON.stringify(newestInHistory(await early.managed.conn.getHistory(), runKey(s, 'u-next')))}`);
  // The broker restarts again inside that window: the mod registers with the stopped turn's end and
  // no running turn. A row attached before it is back must not close the newer run on that word.
  const registeredAgain = s.mod.record.requests.filter((r) => r.route === 'register').length;
  await s.restartBroker();
  const second = await s.attachLive();
  check('L-2 residual seam: after a second restart, a row attached before the mod is back draws the new turn running',
    second.managed.turnInFlight() || newestInHistory(await second.managed.conn.getHistory(), runKey(s, 'u-next'))?.status === 'running');
  await until(() => s.mod.record.requests.filter((r) => r.route === 'register').length > registeredAgain && s.service.status(s.sessionId).present, 5000);
  // Past the grace, so a settle that was going to happen has happened.
  await until(() => false, 900);
  check('L-2 residual seam: the remembered end, older than that turn, does not close it in that row',
    !summaries(second.frames, runKey(s, 'u-next')).some((m) => m.status === 'cancelled')
      && newestInHistory(await second.managed.conn.getHistory(), runKey(s, 'u-next'))?.status === 'running',
    JSON.stringify(summaries(second.frames, runKey(s, 'u-next')).map((m) => m.status)));
  await s.close();
}

async function historyWindowsSection(): Promise<void> {
  // The session's first turn, before the mod has reported any turn at all: nothing says it ended.
  {
    const s = await hubStack('l2-first-turn');
    s.write(rows.user('u-first', 'the first prompt, not reported yet'), rows.streaming('a-first-1', 'msg_first', 'Starting'));
    await until(() => s.live.turnInFlight());
    const history = await s.live.conn.getHistory();
    check('L-2 seam: with no turn end ever reported, a resync draws the running turn running',
      s.service.turnEndedAt(s.sessionId) === undefined && newestInHistory(history, runKey(s, 'u-first'))?.status === 'running',
      JSON.stringify(newestInHistory(history, runKey(s, 'u-first'))));
    await s.close();
  }
  // The prompt row has landed and the turn is streaming, but the mod's turn.start has not reached
  // the broker yet. The mod's last word is that the turn BEFORE this one ended.
  {
    const s = await hubStack('l2-prompt-first');
    await finishedTurn(s, 'turn-before', 'u-before');
    s.write(rows.user('u-early', 'a prompt the hook has not reported yet'), rows.streaming('a-early-1', 'msg_early', 'Starting'));
    await until(() => s.live.turnInFlight());
    const history = await s.live.conn.getHistory();
    check('L-2 seam: a resync before the mod reports the turn draws it running, not cancelled',
      newestInHistory(history, runKey(s, 'u-early'))?.status === 'running', JSON.stringify(newestInHistory(history, runKey(s, 'u-early'))));
    await s.close();
  }
  // The mod is reloaded mid-turn: its new instance registers knowing no turn, until a pass-through
  // turn.step adopts the main loop's.
  {
    const s = await hubStack('l2-reload');
    await finishedTurn(s, 'turn-before-reload', 'u-before-reload');
    await startTurn(s, 'turn-reload', 'u-reload', [rows.streaming('a-reload-1', 'msg_reload', 'Working on it')]);
    s.mod.kill();
    const reloaded = await loadMod('l2-reload-2', { sessionId: s.sessionId, env: s.env });
    cleanups.push(() => reloaded.kill());
    (reloaded.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300 });
    await reloaded.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
    await until(() => reloaded.record.requests.some((r) => r.route === 'poll'));
    const noTurn = s.service.currentTurn(s.sessionId) === '';
    const history = await s.live.conn.getHistory();
    check('L-2 seam: after a mid-turn reload of the mod, before it adopts the turn, a resync draws the turn running',
      noTurn && newestInHistory(history, runKey(s, 'u-reload'))?.status === 'running',
      `currentTurn=${JSON.stringify(s.service.currentTurn(s.sessionId))} ${JSON.stringify(newestInHistory(history, runKey(s, 'u-reload')))}`);
    await s.close();
  }
}

// ── P-2: Escape at the keyboard is the transcript's to close, once ──────────────────────────────
async function escapeSection(): Promise<void> {
  const s = await hubStack('p2-escape');
  await startTurn(s, 'turn-esc', 'u-esc', [rows.streaming('a-esc-1', 'msg_esc', 'Starting')]);
  // The hook can fire before the row is flushed; the row is still what closes the turn.
  await s.mod.fire('turn.complete', { turnId: 'turn-esc', answer: '', durationMs: 300, isAborted: true });
  await until(() => false, 200);
  const markerAt = Date.now() - 50;
  s.write(rows.interrupted('u-esc-int', markerAt));
  await until(() => !s.live.turnInFlight(), 3000);
  await until(() => false, 1800);
  const closed = summaries(s.liveFrames, runKey(s, 'u-esc')).filter((m) => m.status !== 'running');
  check('P-2 seam: Escape closes the turn once, cancelled', closed.length === 1 && closed[0]?.status === 'cancelled',
    JSON.stringify(closed.map((m) => [m.status, m.completedAt])));
  check('P-2 seam: at the interruption row\'s own time', closed[0]?.completedAt === markerAt, `${closed[0]?.completedAt} vs ${markerAt}`);
  await s.close();
}

// ── P-3a: one question is one card, and it is the one that can be answered ─────────────────────
const COLOUR = { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Amber' }, { label: 'Teal' }] };
type QuestionFrame = { requestId: string; readOnly?: boolean; type: string };
const questionFrames = (frames: Received[], id: string) =>
  frames.map((f) => f.message as unknown as QuestionFrame).filter((m) => m.type === 'question-request' && m.requestId === id);
/** The resolutions of one question that reached the seats, oldest first. */
const resolvedFrames = (frames: Received[], id: string) =>
  frames.map((f) => f.message as unknown as { type: string; requestId?: string; answers?: string[][] })
    .filter((m) => m.type === 'question-resolved' && m.requestId === id);
/** The cards a socket that joins now is drawn, after its history. */
const drawnToJoiner = (s: HubStack, id: string) =>
  s.live.liveSnapshot().map((m) => m as unknown as QuestionFrame).filter((m) => m.type === 'question-request' && m.requestId === id);

async function questionIdentitySection(): Promise<void> {
  for (const order of ['the transcript\'s card first', 'the held card first'] as const) {
    const s = await hubStack(`p3a-${order.length}`);
    const toolUseId = `toolu_p3a${order.length}`;
    await s.mod.fire('turn.start', { turnId: 'turn-q' });
    s.write(rows.user('u-q', 'ask me a colour'));
    if (order === 'the transcript\'s card first') {
      s.write(rows.askUserQuestion('a-q', 'msg_q', toolUseId, [COLOUR]));
      await until(() => questionFrames(s.liveFrames, toolUseId).length === 1);
    }
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
    await until(() => questionFrames(s.liveFrames, toolUseId).some((m) => m.readOnly !== true));
    if (order === 'the held card first') {
      s.write(rows.askUserQuestion('a-q', 'msg_q', toolUseId, [COLOUR]));
      // Long enough for the tail to have read the line and drawn whatever it was going to.
      await until(() => false, 400);
    }
    const ids = new Set(s.liveFrames.filter((f) => f.message.type === 'question-request').map((f) => f.message.requestId));
    check(`P-3a seam (${order}): the held card carries the call's tool_use id, and there is no other card`,
      ids.size === 1 && ids.has(toolUseId), JSON.stringify([...ids]));
    const joiner = drawnToJoiner(s, toolUseId);
    check(`P-3a seam (${order}): the Hub's pending set holds one entry for it, the one that can be answered`,
      joiner.length === 1 && joiner[0]?.readOnly !== true, JSON.stringify(joiner));
    check(`P-3a seam (${order}): and the row says Needs input for it`, s.live.status === 'needs-input', s.live.status);

    const routed = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Amber']] });
    const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
    check(`P-3a seam (${order}): the app's answer by that id answers the call`, routed && result?.result?.answers?.['Which colour?'] === 'Amber',
      JSON.stringify(result));
    check(`QR seam (${order}): and Claude's picker, open beneath it the whole time, is closed by that answer`,
      s.mod.picker(toolUseId)?.closedByHook === true && s.mod.picker(toolUseId)?.settled === false, JSON.stringify(s.mod.picker(toolUseId) ?? null));
    s.write(rows.questionAnswered('u-q-r', toolUseId, [COLOUR], { 'Which colour?': 'Amber' }));
    await until(() => s.liveFrames.filter((f) => f.message.type === 'question-resolved' && f.message.requestId === toolUseId).length >= 1);
    await until(() => false, 300);
    check(`P-3a seam (${order}): the card is settled, and no copy of it is left pending`,
      drawnToJoiner(s, toolUseId).length === 0 && s.live.status !== 'needs-input', `${s.live.status} ${JSON.stringify(drawnToJoiner(s, toolUseId))}`);
    const resolutions = resolvedFrames(s.liveFrames, toolUseId);
    check(`P-3c seam (${order}): every resolution the seats were sent carries the answer picked`,
      resolutions.length >= 1 && resolutions.every((m) => JSON.stringify(m.answers) === JSON.stringify([['Amber']])), JSON.stringify(resolutions));
    const history = await s.live.conn.getHistory();
    const inHistory = history.filter((m) => (m.type === 'question-request' || m.type === 'question-resolved') && (m as { requestId?: string }).requestId === toolUseId);
    check(`P-3a seam (${order}): history keys the question and its end by the same id`,
      inHistory.map((m) => m.type).join(',') === 'question-request,question-resolved', JSON.stringify(inHistory.map((m) => m.type)));
    const replayed = inHistory.find((m) => m.type === 'question-resolved') as { answers?: string[][] } | undefined;
    check(`P-3c seam (${order}): a reload settles the card with the same answer`,
      JSON.stringify(replayed?.answers) === JSON.stringify([['Amber']]), JSON.stringify(replayed));

    const before = s.notices.length;
    const late = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Teal']] });
    check(`P-3a seam (${order}): a late tap on the settled card is refused out loud`, late && /already been answered/.test(s.notices[before] ?? ''),
      JSON.stringify(s.notices.slice(before)));
    await s.close();
  }
}

// ── P-3c: a question answered in Claude's picker settles every seat's card with that answer ───
async function terminalAnswerSection(): Promise<void> {
  const s = await hubStack('p3c-terminal');
  // A plain tab of the same session, beside the live one: both are seats.
  const plain = await s.attachPlain();
  const toolUseId = 'toolu_p3c_terminal';
  await s.mod.fire('turn.start', { turnId: 'turn-t' });
  s.write(rows.user('u-t', 'ask me a colour'));
  s.write(rows.askUserQuestion('a-t', 'msg_t', toolUseId, [COLOUR]));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  const drawn = await until(() => questionFrames(s.liveFrames, toolUseId).some((m) => m.readOnly !== true)
    && questionFrames(plain.frames, toolUseId).some((m) => m.readOnly !== true));
  check('P-3c seam: the live tab and the plain tab are both drawn the question, answerable', drawn,
    JSON.stringify({ live: questionFrames(s.liveFrames, toolUseId), plain: questionFrames(plain.frames, toolUseId) }));
  // The person at the keyboard answers in Claude's own picker, which has been open the whole time.
  s.mod.picker(toolUseId)?.answer({ 'Which colour?': 'Teal' });
  const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
  check("P-3c seam: the call ends with what the picker took", result?.result?.answers?.['Which colour?'] === 'Teal', JSON.stringify(result));
  await until(() => resolvedFrames(s.liveFrames, toolUseId).length >= 1 && resolvedFrames(plain.frames, toolUseId).length >= 1);
  for (const [seat, frames] of [['live', s.liveFrames], ['plain', plain.frames]] as const) {
    const first = resolvedFrames(frames, toolUseId)[0] as SettledFrame | undefined;
    check(`P-3c seam: the ${seat} tab's card closes before the transcript says so, with that answer, as the terminal's`,
      JSON.stringify(first?.answers) === JSON.stringify([['Teal']]) && first?.decidedBy === 'band', JSON.stringify(resolvedFrames(frames, toolUseId)));
  }
  check('P-3c seam: and the question is no longer held for the app', !s.service.isHeld(s.sessionId, toolUseId));
  s.write(rows.questionAnswered('u-t-r', toolUseId, [COLOUR], { 'Which colour?': 'Teal' }));
  await until(() => false, 300);
  const resolutions = resolvedFrames(s.liveFrames, toolUseId);
  check('P-3c seam: a question answered in the terminal ends, for every seat, on the answer given there',
    resolutions.length >= 1 && resolutions.every((m) => JSON.stringify(m.answers) === JSON.stringify([['Teal']])), JSON.stringify(resolutions));
  check('P-3c seam: with neither tab left waiting', s.live.status !== 'needs-input' && plain.managed.status !== 'needs-input',
    `${s.live.status} ${plain.managed.status}`);
  const history = await s.live.conn.getHistory();
  const replayed = history.find((m) => m.type === 'question-resolved' && (m as { requestId?: string }).requestId === toolUseId) as SettledFrame | undefined;
  check('P-3c seam: and a reload settles it with that answer, as the terminal\'s',
    JSON.stringify(replayed?.answers) === JSON.stringify([['Teal']]) && replayed?.decidedBy === 'band', JSON.stringify(replayed));
  const before = s.notices.length;
  const late = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Amber']] });
  check("P-3c seam: an app answer after the picker's is refused out loud", late && /already been answered/.test(s.notices[before] ?? ''),
    JSON.stringify(s.notices.slice(before)));
  await s.close();
}

// ── P-3a: the same call asked again by a resumed process gets a card of its own ────────────────
async function resumedAskSection(): Promise<void> {
  const s = await hubStack('p3a-resumed');
  const toolUseId = 'toolu_p3aresumed';
  await s.mod.fire('turn.start', { turnId: 'turn-r1' });
  const first = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  await until(() => questionFrames(s.liveFrames, toolUseId).length === 1);
  routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Teal']] });
  await within(first);
  // `kill -9`, then `claude --resume` asks the same call again.
  s.mod.kill();
  const resumed = await loadMod('p3a-resumed-2', { sessionId: s.sessionId, env: s.env, openPicker: true });
  cleanups.push(() => resumed.kill());
  (resumed.exports.tuneForTest as (o: Record<string, unknown>) => void)({ backoffMs: [100, 200, 300], pollWaitMs: 300 });
  await resumed.fire('session.start', { cwd: '/work', surface: 'terminal', isInteractive: true });
  await until(() => resumed.record.requests.some((r) => r.route === 'poll'));
  await resumed.fire('turn.start', { turnId: 'turn-r2' });
  const framesBefore = s.liveFrames.length;
  const again = resumed.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  await until(() => s.liveFrames.slice(framesBefore).some((f) => f.message.type === 'question-request'));
  const card = s.liveFrames.slice(framesBefore).map((f) => f.message as unknown as QuestionFrame).find((m) => m.type === 'question-request');
  check('P-3a seam: the same tool_use id asked by a resumed process is drawn under a minted id',
    card !== undefined && card.requestId !== toolUseId && /@[0-9a-f]{16}$/.test(card.requestId), JSON.stringify(card));
  check('P-3a seam: and that card can be answered', card?.readOnly !== true
    && routeModAnswer(s.frameDeps, { requestId: card?.requestId ?? '', answers: [['Amber']] })
    && (await within(again) as { result?: { answers?: Record<string, string> } } | undefined)?.result?.answers?.['Which colour?'] === 'Amber');
  await s.close();
}

// ── QR: a question is open in Claude's picker and on the app's card at once, and the row says so ──
type CardFrame = { type: string; requestId: string; readOnly?: boolean; answerInTerminal?: boolean; blocking?: boolean };
/** The cards the Hub holds pending for the row: what decides Needs input, and what a joiner is drawn. */
const pendingCards = (s: HubStack) => s.live.liveSnapshot()
  .map((m) => m as unknown as CardFrame)
  .filter((m) => m.type === 'question-request' || m.type === 'permission-request');
const inTerminal = (card: CardFrame | undefined) => card?.readOnly === true && card.answerInTerminal === true && card.blocking !== false;
/** The cards a managed row would replay to a socket that joins it now. */
const cardsOn = (managed: ManagedConn, id: string) => managed.liveSnapshot()
  .map((m) => m as unknown as CardFrame)
  .filter((m) => m.type === 'question-request' && m.requestId === id);

async function pickerRaceSection(): Promise<void> {
  for (const end of ['answered in the picker', 'the turn is interrupted with the picker open'] as const) {
    const s = await hubStack(`qr-race-${end.length}`, { hubGraceMs: 50 });
    const toolUseId = `toolu_qrrace${end.length}`;
    await s.mod.fire('turn.start', { turnId: 'turn-b1' });
    s.write(rows.user('u-b1', 'ask me a colour'), rows.askUserQuestion('a-b1', 'msg_b1', toolUseId, [COLOUR]));
    const abort = new AbortController();
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] }, abort.signal);
    await until(() => questionFrames(s.liveFrames, toolUseId).some((m) => m.readOnly !== true));
    // Long enough for anything else the offer was going to fan to have fanned.
    await until(() => false, 300);
    const pending = pendingCards(s);
    check(`QR seam (${end}): Claude's picker opened at once, and the terminal draws no band for the question`,
      s.mod.pickers.length === 1 && s.mod.picker(toolUseId)?.settled === false && s.mod.record.bands.length === 0, JSON.stringify(s.mod.record.bands));
    check(`QR seam (${end}): the row reads Needs input`, s.live.status === 'needs-input', s.live.status);
    check(`QR seam (${end}): with one pending card, under the call's tool_use id, that the app can answer`,
      pending.length === 1 && pending[0]?.requestId === toolUseId && pending[0]?.readOnly !== true, JSON.stringify(pending));
    const joiner = drawnToJoiner(s, toolUseId) as CardFrame[];
    check(`QR seam (${end}): a socket that joins now is drawn that card, answerable`,
      joiner.length === 1 && joiner[0]?.readOnly !== true, JSON.stringify(joiner));

    if (end === 'answered in the picker') {
      // The app says something while the picker is open. The question is still open on both sides.
      await s.live.conn.sendPrompt({ text: 'and make it bold' } as never);
      await until(() => false, 200);
      check('QR seam: a prompt from the app while the picker is open leaves the card open, and Needs input',
        s.live.status === 'needs-input' && pendingCards(s).some((m) => m.requestId === toolUseId && m.readOnly !== true)
          && resolvedFrames(s.liveFrames, toolUseId).length === 0,
        `${s.live.status} ${JSON.stringify(pendingCards(s))}`);
      s.mod.picker(toolUseId)?.answer({ 'Which colour?': 'Teal' });
      const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
      check("QR seam: the picker's answer is the call's", result?.result?.answers?.['Which colour?'] === 'Teal', JSON.stringify(result));
      await until(() => resolvedFrames(s.liveFrames, toolUseId).length >= 1);
      const first = resolvedFrames(s.liveFrames, toolUseId)[0] as SettledFrame | undefined;
      check('QR seam: the card closes from the mod\'s word, before the transcript says anything, carrying the answer',
        JSON.stringify(first?.answers) === JSON.stringify([['Teal']]) && first?.decidedBy === 'band', JSON.stringify(resolvedFrames(s.liveFrames, toolUseId)));
      s.write(rows.questionAnswered('u-b1-r', toolUseId, [COLOUR], { 'Which colour?': 'Teal' }));
      await until(() => false, 300);
      const resolutions = resolvedFrames(s.liveFrames, toolUseId);
      check('QR seam: when the transcript records the answer too, every resolution carries it',
        resolutions.length >= 1 && resolutions.every((m) => JSON.stringify(m.answers) === JSON.stringify([['Teal']])), JSON.stringify(resolutions));
      check('QR seam: and the row leaves Needs input', s.live.status !== 'needs-input' && pendingCards(s).length === 0,
        `${s.live.status} ${JSON.stringify(pendingCards(s))}`);
      const ids = new Set(s.liveFrames.filter((f) => f.message.type === 'question-request').map((f) => f.message.requestId));
      check('QR seam: and no second card appeared', ids.size === 1 && ids.has(toolUseId), JSON.stringify([...ids]));
      const settledCount = resolutions.length;
      await s.mod.fire('turn.complete', { turnId: 'turn-b1', answer: 'Teal it is', durationMs: 900, isAborted: false });
      await until(() => false, 300);
      check('QR seam: the turn\'s end after that settles nothing a second time', resolvedFrames(s.liveFrames, toolUseId).length === settledCount,
        JSON.stringify(resolvedFrames(s.liveFrames, toolUseId)));
      // A reload is drawn from the transcript, and the transcript does not say where the question
      // was answered. The broker does.
      s.detachLive();
      await until(() => !s.hub.getConns('claude', s.hubId).includes(s.live), 2000);
      const reloaded = await s.attachLive();
      const history = (await reloaded.managed.conn.getHistory())
        .filter((m) => (m.type === 'question-request' || m.type === 'question-resolved') && (m as { requestId?: string }).requestId === toolUseId) as unknown as (CardFrame & SettledFrame)[];
      check('QR seam: a reload draws the question answered in the terminal, with the answer given there',
        reloaded.managed !== s.live && history.length === 2 && history[1]?.type === 'question-resolved'
          && history[1]?.decidedBy === 'band' && JSON.stringify(history[1]?.answers) === JSON.stringify([['Teal']]),
        JSON.stringify(history));
    } else {
      // Escape: the engine aborts the hook, and the picker it had open comes back as an error.
      abort.abort();
      s.mod.picker(toolUseId)?.escape();
      const result = await within(call) as { isError?: boolean } | undefined;
      check('QR seam: an interrupted picker ends the call as the engine ended it', result?.isError === true, JSON.stringify(result));
      await s.mod.fire('turn.complete', { turnId: 'turn-b1', answer: '', durationMs: 900, isAborted: true });
      await until(() => resolvedFrames(s.liveFrames, toolUseId).length >= 1);
      await until(() => false, 300);
      const resolutions = resolvedFrames(s.liveFrames, toolUseId) as SettledFrame[];
      check('QR seam: an interrupt with the picker open closes the card once, as the terminal\'s, with no answer',
        resolutions.length === 1 && resolutions[0]?.releaseReason === 'band' && resolutions[0]?.answers === undefined, JSON.stringify(resolutions));
      check('QR seam: with no Needs input left', s.live.status !== 'needs-input' && pendingCards(s).length === 0,
        `${s.live.status} ${JSON.stringify(pendingCards(s))}`);
    }
    await s.close();
  }
}

// ── P-10: the mod's word on the picker reaches the broker after the transcript's answer did ───
async function lateBandSection(): Promise<void> {
  const s = await hubStack('p10-late-band', { hubGraceMs: 50 });
  const toolUseId = 'toolu_p10late';
  type Resolution = { answers?: string[][]; decidedBy?: string; releaseReason?: string };
  const resolutions = () => resolvedFrames(s.liveFrames, toolUseId) as Resolution[];
  await s.mod.fire('turn.start', { turnId: 'turn-late' });
  s.write(rows.user('u-late', 'ask me a colour'), rows.askUserQuestion('a-late', 'msg_late', toolUseId, [COLOUR]));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  await until(() => questionFrames(s.liveFrames, toolUseId).some((m) => m.readOnly !== true));
  // The picker was answered at the keyboard, and the transcript's line for it was read before the
  // mod's report of it reached the broker.
  s.write(rows.questionAnswered('u-late-r', toolUseId, [COLOUR], { 'Which colour?': 'Amber' }));
  await until(() => resolutions().length >= 1);
  check('P-10 seam: the transcript closes the card first, with the answer and no word on who gave it',
    resolutions().length === 1 && JSON.stringify(resolutions()[0]?.answers) === JSON.stringify([['Amber']])
      && !resolutions()[0]?.decidedBy && !resolutions()[0]?.releaseReason, JSON.stringify(resolutions()));
  const framesBeforeReport = s.liveFrames.length;
  s.mod.picker(toolUseId)?.answer({ 'Which colour?': 'Amber' });
  const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
  check("P-10 seam: the call still ends with the picker's answer", result?.result?.answers?.['Which colour?'] === 'Amber', JSON.stringify(result));
  check('P-10 seam: and the report closes the hold', await until(() => !s.service.isHeld(s.sessionId, toolUseId), 3000));
  await until(() => false, 300);
  check('P-10 seam: every resolution any seat was sent carries the same answer',
    resolutions().length >= 1 && resolutions().every((r) => JSON.stringify(r.answers) === JSON.stringify([['Amber']])), JSON.stringify(resolutions()));
  // The broker's word lands on a card that is already closed, and corrects it in place: an open tab
  // says who answered without waiting for a reload.
  check('P-10 seam: the report corrects the closed card once, to answered in the terminal',
    resolutions().length === 2 && resolutions()[1]?.decidedBy === 'band' && !resolutions()[1]?.releaseReason, JSON.stringify(resolutions()));
  // The transcript's own copy of the card may have been drawn before the held one, under the same id;
  // what must not happen is a card drawn again after the mod's report.
  const redrawn = questionFrames(s.liveFrames.slice(framesBeforeReport), toolUseId);
  check('P-10 seam: and nothing re-opens: no card drawn again, none pending, the row not waiting',
    redrawn.length === 0 && pendingCards(s).length === 0 && s.live.status !== 'needs-input',
    `${redrawn.length} cards redrawn, ${JSON.stringify(pendingCards(s))}, ${s.live.status}`);
  const history = await s.live.conn.getHistory();
  const replayed = history.find((m) => m.type === 'question-resolved' && (m as { requestId?: string }).requestId === toolUseId) as Resolution | undefined;
  check('P-10 seam: a reload says the terminal answered it, with that answer',
    replayed?.decidedBy === 'band' && JSON.stringify(replayed?.answers) === JSON.stringify([['Amber']]), JSON.stringify(replayed));
  const settledCount = resolutions().length;
  await s.mod.fire('turn.complete', { turnId: 'turn-late', answer: 'Amber', durationMs: 900, isAborted: false });
  await until(() => false, 300);
  check('P-10 seam: the turn\'s end corrects nothing a second time', resolutions().length === settledCount, JSON.stringify(resolutions()));
  await s.close();
}

// ── P-10: a call made between turns by no subagent is not this conversation's ─────────────────
// Measured on 2.1.295: after a turn ends, Claude's prompt-suggestion fork can call tools, in the main
// loop's envelope. Its AskUserQuestion was held, and drew a band and a card for a question in no
// transcript, in front of the real question asked next.
async function forkCallSection(): Promise<void> {
  const s = await hubStack('p10-fork');
  const holdsSent = () => s.mod.record.requests.filter((r) => r.route === 'hold').length;
  const cards = () => s.liveFrames.filter((f) => f.message.type === 'question-request' || f.message.type === 'permission-request').length;
  await s.mod.fire('turn.start', { turnId: 'turn-before-fork' });
  s.write(rows.user('u-fork', 'ask me a colour'), rows.endTurn('a-fork', 'msg_fork', 'Done.'));
  await s.mod.fire('turn.complete', { turnId: 'turn-before-fork', answer: 'Done.', durationMs: 300, isAborted: false });
  const holdsBefore = holdsSent();
  const cardsBefore = cards();
  const forkQuestion = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'toolu_fork_q', questions: [COLOUR] });
  // Claude's own picker is what takes it; whatever it settles with is the call's result, untouched.
  const opened = await until(() => s.mod.picker('toolu_fork_q') !== undefined, 3000);
  const picked = s.mod.picker('toolu_fork_q')?.answer({ 'Which colour?': 'Teal' });
  const question = await within(forkQuestion, 3000);
  check('P-10 fork seam: a question called after the turn ended, by no subagent, goes to the engine at once',
    opened && picked !== undefined && JSON.stringify(question) === JSON.stringify(picked), JSON.stringify(question ?? null));
  const permission = await within(s.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'toolu_fork_w', input: { file_path: '/tmp/fork.txt', content: 'x' } }), 3000) as { decision?: string } | undefined;
  check('P-10 fork seam: so does a permission check in that window, with the engine\'s own verdict',
    permission?.decision === 'ask', JSON.stringify(permission ?? null));
  await until(() => false, 300);
  check('P-10 fork seam: neither is held, and the app is drawn no card for either',
    holdsSent() === holdsBefore && cards() === cardsBefore, `${holdsSent() - holdsBefore} holds, ${cards() - cardsBefore} cards`);
  // A subagent's call in the same window is a call of this conversation's, and is held as before.
  const sub = s.mod.fire('tool.check', { tool: 'Write', tool_use_id: 'toolu_sub_w', agentId: 'agent-1', input: { file_path: '/tmp/sub.txt', content: 'x' } });
  check('P-10 fork seam: a subagent\'s call after the main turn ended is still held for the app',
    await until(() => s.liveFrames.some((f) => f.message.type === 'permission-request' && String(f.message.requestId).startsWith('cm-')), 3000));
  s.mod.tapBand("Show Claude's dialog");
  await within(sub);
  // The next turn's own question is held again.
  await s.mod.fire('turn.start', { turnId: 'turn-after-fork' });
  const main = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'toolu_main_q', questions: [COLOUR] });
  check('P-10 fork seam: once the next turn starts, its question is held for the app',
    await until(() => questionFrames(s.liveFrames, 'toolu_main_q').some((m) => m.readOnly !== true), 3000));
  s.mod.picker('toolu_main_q')?.answer({ 'Which colour?': 'Amber' });
  await within(main);
  // A hot reload or recovered loop may learn the main turn from a step, without turn.start.
  // The step must close the between-turns fork window as well as learn the new turn id (MA).
  await s.mod.fire('turn.complete', { turnId: 'turn-after-fork', answer: '', durationMs: 100 });
  await s.mod.fireIfHooked('turn.step', { turnId: 'turn-from-step' });
  const recovered = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: 'toolu_step_q', questions: [COLOUR] });
  check('P-10 fork seam: a main turn.step closes the fork window and its next question is held',
    await until(() => questionFrames(s.liveFrames, 'toolu_step_q').some((m) => m.readOnly !== true), 3000));
  s.mod.picker('toolu_step_q')?.answer({ 'Which colour?': 'Teal' });
  await within(recovered);
  await s.close();
}

// ── QR1: a question nobody is watching is still offered; one the switch released waits in the terminal ──
async function unwatchedQuestionSection(): Promise<void> {
  for (const why of ['nobody watching', 'killSwitch'] as const) {
    const s = await hubStack(`qr-unwatched-${why.length}`);
    const toolUseId = `toolu_qrun${why.length}`;
    // Nobody who could answer is watching: the app went away, and its row lingers in its grace.
    if (why === 'nobody watching') s.detachLive();
    await s.mod.fire('turn.start', { turnId: 'turn-rel' });
    s.write(rows.user('u-rel', 'ask me a colour'), rows.askUserQuestion('a-rel', 'msg_rel', toolUseId, [COLOUR]));
    // Switched off between the mod's last poll and this call: the mod still offers the hold, and the
    // broker's gate, which reads the switch when the hold arrives, releases it. (A mod that has
    // already heard holds nothing, and the transcript's own copy of the question is the card.)
    if (why === 'killSwitch') s.setKillSwitch(true);
    const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
    await until(() => pendingCards(s).some((m) => m.requestId === toolUseId && (why === 'killSwitch' || m.readOnly !== true)));
    await until(() => false, 300);
    check(`QR seam (${why}): the row reads Needs input while Claude's picker is open`, s.live.status === 'needs-input', s.live.status);
    if (why === 'nobody watching') {
      // QR1: no viewer is needed. The question is held, and the seat that opens answers it.
      check('QR1 seam (nobody watching): the question is held for the app, not released',
        s.service.isHeld(s.sessionId, toolUseId) && !s.service.auditTrail(s.sessionId).some((row) => row.released),
        JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => row.released)));
      const joined = await s.attachLive();
      const joiner = drawnToJoiner(s, toolUseId) as CardFrame[];
      check('QR1 seam (nobody watching): a viewer who joins is drawn the question, answerable',
        joined.managed === s.live && joiner.length === 1 && joiner[0]?.readOnly !== true, JSON.stringify(joiner));
      const routed = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Amber']] });
      const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
      check('QR1 seam (nobody watching): and its answer is the call\'s', routed && result?.result?.answers?.['Which colour?'] === 'Amber',
        JSON.stringify(result));
      check('QR1 seam (nobody watching): the card the joiner tapped closes as the app\'s',
        await until(() => (resolvedFrames(joined.frames, toolUseId) as SettledFrame[]).some((m) => m.decidedBy === 'app'), 3000),
        JSON.stringify(resolvedFrames(joined.frames, toolUseId)));
    } else {
      check('QR seam (released, killSwitch): the question was not held',
        s.service.auditTrail(s.sessionId).some((row) => row.released === why), JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => row.released)));
      const card = pendingCards(s).find((m) => m.requestId === toolUseId);
      check('QR seam (released, killSwitch): its card is read-only and open in the terminal', inTerminal(card), JSON.stringify(card));
      // The person answers in Claude's picker. The mod says so, and the read-only card closes with it.
      s.mod.picker(toolUseId)?.answer({ 'Which colour?': 'Amber' });
      const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
      check("QR seam (released, killSwitch): the call ends with the picker's answer", result?.result?.answers?.['Which colour?'] === 'Amber',
        JSON.stringify(result));
      await until(() => resolvedFrames(s.liveFrames, toolUseId).length >= 1);
      const first = resolvedFrames(s.liveFrames, toolUseId)[0] as SettledFrame | undefined;
      check('QR2 seam (released, killSwitch): the read-only card closes from the mod\'s word, with the answer, as the terminal\'s',
        JSON.stringify(first?.answers) === JSON.stringify([['Amber']]) && first?.decidedBy === 'band', JSON.stringify(resolvedFrames(s.liveFrames, toolUseId)));
    }
    s.write(rows.questionAnswered('u-rel-r', toolUseId, [COLOUR], { 'Which colour?': 'Amber' }));
    await until(() => s.live.status !== 'needs-input');
    await until(() => false, 300);
    check(`QR seam (${why}): once answered the row leaves Needs input`,
      s.live.status !== 'needs-input' && pendingCards(s).length === 0, `${s.live.status} ${JSON.stringify(pendingCards(s))}`);
    await s.close();
  }
}

// ── QR3: a plain tab of a synced session is a seat ──────────────────────────────────────────────
async function plainSeatSection(): Promise<void> {
  const s = await hubStack('qr-plain', { hubGraceMs: 50 });
  // The only tab open is a plain one, as a resident or background view opens it: the live tab went.
  s.detachLive();
  await until(() => !s.hub.getConns('claude', s.hubId).includes(s.live), 2000);
  const plain = await s.attachPlain();
  check('QR3 seam: a plain tab of a synced session is a seat in the sync, not a read-only mirror',
    isModSeat(plain.managed.conn) && (plain.managed.conn as ClaudeModConnection).takesHolds === false && plain.managed.conn.info.attachMode === 'observe',
    `${plain.managed.conn.constructor.name} ${plain.managed.conn.info.attachMode}`);
  await s.mod.fire('turn.start', { turnId: 'turn-plain' });
  // A permission is not held for a plain tab: Claude's own dialog stays the answer, and the release
  // draws nothing that nobody there could act on.
  const asked = await within(s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-plain-bash', input: { command: 'make' } }), 3000) as { decision?: string } | undefined;
  await until(() => false, 200);
  check("QR3 seam: a permission with only a plain tab open is left to Claude's dialog",
    asked?.decision === 'ask' && s.service.auditTrail(s.sessionId).some((row) => row.tool === 'Bash' && row.released === 'viewer:none'),
    JSON.stringify({ asked, audit: s.service.auditTrail(s.sessionId).map((row) => [row.tool, row.released]) }));
  check('QR3 seam: and draws no card on that tab', !plain.frames.some((f) => f.message.type === 'permission-request')
    && !plain.managed.liveSnapshot().some((m) => m.type === 'permission-request') && s.mod.record.bands.length === 0,
    JSON.stringify(plain.frames.filter((f) => f.message.type === 'permission-request').map((f) => f.message)));
  // A question is offered to it, and answered from it.
  const toolUseId = 'toolu_qr_plain';
  s.write(rows.user('u-plain', 'ask me a colour'), rows.askUserQuestion('a-plain', 'msg_plain', toolUseId, [COLOUR]));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  check('QR3 seam: a question is drawn on the plain tab, answerable',
    await until(() => questionFrames(plain.frames, toolUseId).some((m) => m.readOnly !== true), 3000), JSON.stringify(questionFrames(plain.frames, toolUseId)));
  check('QR3 seam: and its row reads Needs input', await until(() => plain.managed.status === 'needs-input', 2000), plain.managed.status);
  const routed = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Amber']] });
  const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
  check('QR3 seam: answered from the plain tab, the call takes that answer', routed && result?.result?.answers?.['Which colour?'] === 'Amber',
    JSON.stringify(result));
  check('QR3 seam: and the plain tab\'s card closes as the app\'s', await until(() => (resolvedFrames(plain.frames, toolUseId) as SettledFrame[])
    .some((m) => m.decidedBy === 'app' && JSON.stringify(m.answers) === JSON.stringify([['Amber']])), 3000), JSON.stringify(resolvedFrames(plain.frames, toolUseId)));
  // The turn is over, and a prompt from the plain tab goes to the terminal like a live tab's.
  await s.mod.fire('turn.complete', { turnId: 'turn-plain', answer: 'Amber', durationMs: 300, isAborted: false });
  await plain.managed.conn.sendPrompt({ text: 'from the plain tab' } as never);
  check('QR3 seam: a prompt from the plain tab reaches the terminal',
    await until(() => s.mod.record.prompts.some((p) => p.text === 'from the plain tab'), 3000), JSON.stringify(s.mod.record.prompts));
  await s.close();
}

// ── QR1: a tab that opens while a question is open is drawn it ──────────────────────────────────
async function openCardsSection(): Promise<void> {
  const s = await hubStack('qr-open-cards', { hubGraceMs: 50 });
  const toolUseId = 'toolu_qr_open';
  // Nobody has the session open anywhere: the app's tab went away and its row is gone.
  s.detachLive();
  await until(() => s.hub.getConns('claude', s.hubId).length === 0, 2000);
  await s.mod.fire('turn.start', { turnId: 'turn-open' });
  s.write(rows.user('u-open', 'ask me a colour'), rows.askUserQuestion('a-open', 'msg_open', toolUseId, [COLOUR]));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  check('QR1 seam: a question asked with no tab open anywhere is still held for the app',
    await until(() => s.service.isHeld(s.sessionId, toolUseId), 3000) && !s.service.auditTrail(s.sessionId).some((row) => row.released),
    JSON.stringify(s.service.auditTrail(s.sessionId).map((row) => row.released)));
  check("QR1 seam: while Claude's picker is open in the terminal, with no band drawn beside it",
    s.mod.picker(toolUseId)?.settled === false && s.mod.record.bands.length === 0, JSON.stringify(s.mod.record.bands));
  // A plain tab opens, as a resident or background view opens it.
  const plain = await s.attachPlain();
  check('QR1 seam: the tab that opens now is drawn the open question, answerable',
    await until(() => cardsOn(plain.managed, toolUseId).length === 1 && cardsOn(plain.managed, toolUseId)[0]?.readOnly !== true, 3000),
    JSON.stringify(cardsOn(plain.managed, toolUseId)));
  check('QR1 seam: and its row reads Needs input', await until(() => plain.managed.status === 'needs-input', 2000), plain.managed.status);
  // A live tab opened after it is drawn the same card.
  const live = await s.attachLive();
  check('QR1 seam: so is a live tab opened after it',
    await until(() => cardsOn(live.managed, toolUseId).length === 1 && cardsOn(live.managed, toolUseId)[0]?.readOnly !== true, 3000),
    JSON.stringify(cardsOn(live.managed, toolUseId)));
  const routed = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Teal']] });
  const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
  check('QR1 seam: answering it from the app answers the call', routed && result?.result?.answers?.['Which colour?'] === 'Teal', JSON.stringify(result));
  check('QR1 seam: and closes the card on both tabs',
    await until(() => resolvedFrames(plain.frames, toolUseId).length >= 1 && resolvedFrames(live.frames, toolUseId).length >= 1, 3000)
      && cardsOn(plain.managed, toolUseId).length === 0 && cardsOn(live.managed, toolUseId).length === 0,
    JSON.stringify({ plain: resolvedFrames(plain.frames, toolUseId), live: resolvedFrames(live.frames, toolUseId) }));
  check('QR1 seam: a tab that opens after it closed is not drawn it again', s.service.openCards(s.sessionId)?.cards.length === 0,
    JSON.stringify(s.service.openCards(s.sessionId)));
  await s.close();
}

// ── QR4: a tab opened before the mod registered becomes a seat, in place ────────────────────────
async function seatUpgradeSection(): Promise<void> {
  const s = await hubStack('qr-upgrade', { upgradeSeats: true });
  // What a tab opened a moment too early holds: an Observe mirror.
  const resident = await s.attachObserve();
  check('QR4 seam: the early tab is a read-only mirror', !isModSeat(resident.managed.conn), resident.managed.conn.constructor.name);
  const toolUseId = 'toolu_qr_upgrade';
  await s.mod.fire('turn.start', { turnId: 'turn-up' });
  s.write(rows.user('u-up', 'ask me a colour'), rows.askUserQuestion('a-up', 'msg_up', toolUseId, [COLOUR]));
  const call = s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: toolUseId, questions: [COLOUR] });
  check('QR4 seam: a card that finds a seat it cannot draw on has that seat re-attached through the adapter',
    await until(() => isModSeat(resident.managed.conn), 3000), resident.managed.conn.constructor.name);
  check('QR4 seam: in place, so the tab keeps its socket',
    s.hub.getConns('claude', s.hubId).includes(resident.managed) && resident.managed.clientCount === 1, String(resident.managed.clientCount));
  check('QR4 seam: as a plain seat, which no permission is held for',
    (resident.managed.conn as ClaudeModConnection).takesHolds === false && resident.managed.conn.info.attachMode === 'observe',
    resident.managed.conn.info.attachMode);
  const upgradedConn = resident.managed.conn;
  check('QR4 seam: and a later upgrade pass leaves both seats as they are',
    await s.hub.reattachUpgradedSeats('claude', s.hubId, isModSeat) === 0 && resident.managed.conn === upgradedConn && isModSeat(s.live.conn));
  check('QR4 seam: and the re-attached tab is drawn the open question, answerable',
    await until(() => cardsOn(resident.managed, toolUseId).length === 1 && cardsOn(resident.managed, toolUseId)[0]?.readOnly !== true, 3000),
    JSON.stringify(cardsOn(resident.managed, toolUseId)));
  const routed = routeModAnswer(s.frameDeps, { requestId: toolUseId, answers: [['Amber']] });
  const result = await within(call) as { result?: { answers?: Record<string, string> } } | undefined;
  check('QR4 seam: and its answer reaches the call', routed && result?.result?.answers?.['Which colour?'] === 'Amber', JSON.stringify(result));
  check('QR4 seam: the tab that was a mirror is sent the resolution',
    await until(() => resolvedFrames(resident.frames, toolUseId).length >= 1, 3000), JSON.stringify(resolvedFrames(resident.frames, toolUseId)));
  await s.mod.fire('turn.complete', { turnId: 'turn-up', answer: 'Amber', durationMs: 300, isAborted: false });

  // A broker restart: every tab reconnects before its terminal registers again, so each is a mirror
  // until the registration lands. The registration is what re-attaches it.
  const release = s.holdRegistrations();
  await s.restartBroker();
  const reopened = await s.attachObserve();
  check('QR4 seam: after a broker restart, a tab that reconnects before its terminal does is a mirror',
    !isModSeat(reopened.managed.conn) && s.service.status(s.sessionId).present === false, reopened.managed.conn.constructor.name);
  release();
  check('QR4 seam: and once the terminal registers again that tab is a seat, in place',
    await until(() => s.service.status(s.sessionId).present && isModSeat(reopened.managed.conn), 6000)
      && s.hub.getConns('claude', s.hubId).includes(reopened.managed),
    `${reopened.managed.conn.constructor.name} present=${s.service.status(s.sessionId).present}`);
  await s.close();
}

// ── P-8(a): a closed question card says who closed it, in every seat and after a reload ────────
type SettledFrame = { type: string; requestId?: string; answers?: string[][]; decidedBy?: string; releaseReason?: string };
const settledBy = (frame: SettledFrame | undefined) => JSON.stringify({ decidedBy: frame?.decidedBy, releaseReason: frame?.releaseReason });

async function questionAttributionSection(): Promise<void> {
  const ends: {
    label: string;
    options?: HubStackOptions;
    end: (s: HubStack, id: string, abort: AbortController) => Promise<void>;
    expect: { decidedBy?: string; releaseReason?: string };
  }[] = [
    {
      label: 'answered from the app',
      end: async (s, id) => void routeModAnswer(s.frameDeps, { requestId: id, answers: [['Amber']] }),
      expect: { decidedBy: 'app' },
    },
    // QR2: the person answers in Claude's own picker, which was open beside the card the whole time.
    {
      label: "answered in Claude's picker",
      end: async (s, id) => void s.mod.picker(id)?.answer({ 'Which colour?': 'Amber' }),
      expect: { decidedBy: 'band' },
    },
    // Escape: the engine aborts the parked hook, the mod says the turn was interrupted, and the
    // picker beneath it comes back as an error.
    {
      label: 'Escape at the keyboard',
      end: async (s, id, abort) => {
        abort.abort();
        s.mod.picker(id)?.escape();
      },
      expect: { releaseReason: 'band' },
    },
    {
      label: 'a Stop from the app with the hold open',
      end: async (s, id, abort) => {
        await s.live.conn.runCommand?.('stop');
        await until(() => s.mod.record.aborts.length > 0);
        abort.abort();
        s.mod.picker(id)?.escape();
        await until(() => false, 100);
        await s.mod.fire('turn.complete', { turnId: 'turn-p8a', answer: '', durationMs: 50, isAborted: true });
      },
      expect: { decidedBy: 'app' },
    },
    {
      // The terminal stops asking and its lease runs out with nobody looking.
      label: 'its lease ran out',
      options: { holdLeaseMs: 600, sweepIntervalMs: 100 },
      end: async (s) => s.mod.kill(),
      expect: { decidedBy: 'expired', releaseReason: 'expired' },
    },
  ];
  for (const { label, options, end, expect } of ends) {
    const s = await hubStack(`p8a-${label.length}`, { hubGraceMs: 50, ...options });
    const id = `toolu_p8a${label.length}`;
    await s.mod.fire('turn.start', { turnId: 'turn-p8a' });
    s.write(rows.user('u-p8a', 'ask me a colour'), rows.askUserQuestion('a-p8a', 'msg_p8a', id, [COLOUR]));
    const abort = new AbortController();
    void s.mod.fire('tool.call', { tool: 'AskUserQuestion', tool_use_id: id, questions: [COLOUR] }, abort.signal).catch(() => undefined);
    await until(() => questionFrames(s.liveFrames, id).some((m) => m.readOnly !== true));
    await end(s, id, abort);
    await until(() => resolvedFrames(s.liveFrames, id).length >= 1, 4000);
    const first = resolvedFrames(s.liveFrames, id)[0] as SettledFrame | undefined;
    check(`P-8(a) seam (${label}): the card's resolution says who closed it`,
      settledBy(first) === JSON.stringify(expect), JSON.stringify(resolvedFrames(s.liveFrames, id)));
    if (label === 'answered from the app') {
      // Claude records the answer, and the transcript's own resolution follows the broker's.
      s.write(rows.questionAnswered('u-p8a-r', id, [COLOUR], { 'Which colour?': 'Amber' }));
      await until(() => resolvedFrames(s.liveFrames, id).length >= 2);
      const all = resolvedFrames(s.liveFrames, id) as SettledFrame[];
      check('P-8(a) seam (answered from the app): the transcript\'s resolution, which every seat takes last, still says the app',
        all.length >= 2 && all.every((m) => m.decidedBy === 'app' && JSON.stringify(m.answers) === JSON.stringify([['Amber']])), JSON.stringify(all));
      // The turn ends, so nothing keeps the row once its socket goes: the reload is a new connection.
      await s.mod.fire('turn.complete', { turnId: 'turn-p8a', answer: 'Amber', durationMs: 900, isAborted: false });
      s.write(rows.endTurn('a-p8a-2', 'msg_p8a_2', 'Amber it is.'));
      await until(() => !s.live.turnInFlight(), 3000);
      s.detachLive();
      await until(() => !s.hub.getConns('claude', s.hubId).includes(s.live), 2000);
      const reloaded = await s.attachLive();
      const replayed = (await reloaded.managed.conn.getHistory())
        .find((m) => m.type === 'question-resolved' && (m as { requestId?: string }).requestId === id) as SettledFrame | undefined;
      check('P-8(a) seam (answered from the app): a reload settles the card as answered in the app, with the answer',
        reloaded.managed !== s.live && replayed?.decidedBy === 'app' && JSON.stringify(replayed?.answers) === JSON.stringify([['Amber']]),
        JSON.stringify(replayed));
    }
    await s.close();
  }
}

// ── P-9: the hold gate reads the mode from the rows Claude 2.1.294 writes it in ────────────────
/** Mode rows in that build's shapes: keys and types from a real transcript, content invented. */
const modeRows = {
  /** A prompt the person sent, which carries the mode it was sent in. */
  prompt(uuid: string, mode: string): Record<string, unknown> {
    return {
      type: 'user', uuid, parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: '/work', version: '2.1.294',
      promptId: `pr-${uuid}`, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 },
      permissionMode: mode, timestamp: new Date().toISOString(), message: { role: 'user', content: `a prompt in ${mode}` },
    };
  },
  /** The title block's mode row, written beside `last-prompt`, and not on every turn. */
  title(mode: string): Record<string, unknown> {
    return { type: 'permission-mode', permissionMode: mode, sessionId: 'p9' };
  },
  exitPlan(uuid: string, toolUseId: string): Record<string, unknown> {
    return {
      type: 'assistant', uuid, isSidechain: false, version: '2.1.294', timestamp: new Date().toISOString(),
      message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 9 },
        content: [{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input: { plan: 'the plan', planFilePath: '/plans/p.md' }, caller: { type: 'direct' } }] },
    };
  },
  /** The plan approved: out of plan mode, and nothing says into which. */
  approved(uuid: string, toolUseId: string): Record<string, unknown> {
    return {
      type: 'user', uuid, isSidechain: false, version: '2.1.294', timestamp: new Date().toISOString(), sourceToolAssistantUUID: 'a',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'User has approved your plan.' }] },
      toolUseResult: { plan: 'the plan', isAgent: false, filePath: '/plans/p.md' },
    };
  },
  rejected(uuid: string, toolUseId: string): Record<string, unknown> {
    return {
      type: 'user', uuid, isSidechain: false, version: '2.1.294', timestamp: new Date().toISOString(), sourceToolAssistantUUID: 'a', toolDenialKind: 'user-rejected',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'The user rejected the plan.', is_error: true }] },
      toolUseResult: 'User rejected tool use',
    };
  },
};

type PermissionCard = { type: string; requestId: string; readOnly?: boolean; permissionMode?: string; releaseReason?: string };

async function modeGateSection(): Promise<void> {
  const cases: { label: string; rows: Record<string, unknown>[]; held?: string; released?: string }[] = [
    { label: 'a prompt row in auto, newer than a title block in default', rows: [modeRows.title('default'), modeRows.prompt('u-auto', 'auto')], released: 'mode:auto' },
    { label: 'a title block in default, newer than a prompt row in auto', rows: [modeRows.prompt('u-auto2', 'auto'), modeRows.title('default')], held: 'default' },
    {
      label: 'a plan approved earlier in the turn',
      rows: [modeRows.prompt('u-plan', 'plan'), modeRows.exitPlan('a-plan', 'toolu_plan_ok'), modeRows.approved('u-plan-ok', 'toolu_plan_ok')],
      released: 'mode:unknown',
    },
    {
      label: 'a plan rejected earlier in the turn',
      rows: [modeRows.prompt('u-plan2', 'plan'), modeRows.exitPlan('a-plan2', 'toolu_plan_no'), modeRows.rejected('u-plan-no', 'toolu_plan_no')],
      held: 'plan',
    },
  ];
  for (const [index, { label, rows: written, held, released }] of cases.entries()) {
    const s = await hubStack(`p9-${index}`);
    await s.mod.fire('turn.start', { turnId: 'turn-p9' });
    s.write(...written);
    // The tail has read the rows, which is what the chip follows; the gate reads the file itself.
    await until(() => false, 300);
    const abort = new AbortController();
    void s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-p9-${index}`, input: { command: 'make' } }, abort.signal).catch(() => undefined);
    const audited = () => s.service.auditTrail(s.sessionId).filter((row) => row.tool === 'Bash');
    const cards = () => s.liveFrames.map((f) => f.message as unknown as PermissionCard).filter((m) => m.type === 'permission-request');
    await until(() => (released ? audited().length > 0 : cards().some((c) => c.readOnly !== true)), 3000);
    await until(() => false, 200);
    if (released) {
      check(`P-9 seam (${label}): the ask is released as ${released}, not held`,
        audited().at(-1)?.released === released && !cards().some((c) => c.readOnly !== true), JSON.stringify(audited().map((r) => [r.released, r.modeSeen])));
    } else {
      const card = cards().find((c) => c.readOnly !== true);
      check(`P-9 seam (${label}): the ask is held, and its card names ${held}`, card?.permissionMode === held && audited().length === 0,
        JSON.stringify({ card, audit: audited().map((r) => [r.released, r.modeSeen]) }));
    }
    if (released === 'mode:unknown') {
      // Auto mode's classifier settles a call with no dialog, and nothing on disk says which mode the
      // plan was approved into: the note waits for Claude to say its own dialog is open.
      check('P-9 seam (a plan approved earlier in the turn): no note while Claude has no dialog open',
        !cards().some((c) => c.readOnly === true), JSON.stringify(cards()));
      s.setDialogOpen(false);
      await until(() => false, 200);
      check('P-9 seam (a plan approved earlier in the turn): nor while Claude says its dialog is shut',
        !cards().some((c) => c.readOnly === true), JSON.stringify(cards()));
      s.setDialogOpen(true);
      await until(() => cards().some((c) => c.readOnly === true), 2000);
      const card = cards().find((c) => c.readOnly === true);
      check('P-9 seam (a plan approved earlier in the turn): the note is drawn once the dialog opens, and claims no mode',
        card !== undefined && card.permissionMode === undefined && card.releaseReason === 'mode:unknown',
        JSON.stringify(card));
      check('P-9 seam (a plan approved earlier in the turn): the chip names no mode either',
        (s.live.conn.info as SessionInfo).currentMode === undefined && s.liveSessions.length > 0 && s.liveSessions.at(-1)?.currentMode === undefined,
        JSON.stringify({ row: (s.live.conn.info as SessionInfo).currentMode, sent: s.liveSessions.map((info) => info.currentMode) }));
    }
    abort.abort();
    await s.close();
  }
  // Idle Shift+Tab writes nothing, so it is read at the next prompt, and the gate reads what that
  // prompt says for the asks in its turn.
  const s = await hubStack('p9-next-prompt');
  s.write(modeRows.prompt('u-next', 'acceptEdits'));
  await until(() => (s.live.conn.info as SessionInfo).currentMode === 'acceptEdits', 2000);
  check('P-9 seam: the next prompt\'s mode reaches the chip', s.liveSessions.at(-1)?.currentMode === 'acceptEdits',
    JSON.stringify(s.liveSessions.map((info) => info.currentMode)));
  const abort = new AbortController();
  void s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: 'tu-p9-next', input: { command: 'make' } }, abort.signal).catch(() => undefined);
  await until(() => s.liveFrames.some((f) => f.message.type === 'permission-request'));
  const card = s.liveFrames.map((f) => f.message as unknown as PermissionCard).find((m) => m.type === 'permission-request');
  check('P-9 seam: and the gate\'s recorded mode for the next ask is that prompt\'s', card?.permissionMode === 'acceptEdits', JSON.stringify(card));
  abort.abort();
  await s.close();
}

// ── P-1: the terminal's own cancel says the terminal, and the app's Stop says the app ─────────
type ResolvedFrame = { type: string; requestId?: string; decision?: string; decidedBy?: string; releaseReason?: string };
const permissionCardIds = (frames: Received[]) => frames
  .map((f) => f.message as unknown as ResolvedFrame & { readOnly?: boolean })
  .filter((m) => m.type === 'permission-request' && m.readOnly !== true)
  .map((m) => m.requestId ?? '');
const resolutionOf = (frames: Received[], id: string) => frames
  .map((f) => f.message as unknown as ResolvedFrame)
  .find((m) => m.type === 'permission-resolved' && m.requestId === id);

async function terminalCancelSection(): Promise<void> {
  const ends: { label: string; end: (s: HubStack, abort: AbortController) => Promise<void>; expect: Partial<ResolvedFrame> }[] = [
    { label: 'band 3, Claude\'s own dialog', end: async (s) => s.mod.tapBand("Show Claude's dialog"), expect: { releaseReason: 'band' } },
    { label: 'Escape at the keyboard', end: async (_s, abort) => abort.abort(), expect: { releaseReason: 'band' } },
    {
      label: 'a Stop from the app',
      end: async (s, abort) => {
        await s.live.conn.runCommand?.('stop');
        await until(() => s.mod.record.aborts.length > 0);
        // The engine stops the turn: the parked hook is aborted, then the turn ends.
        abort.abort();
        await until(() => false, 100);
        await s.mod.fire('turn.complete', { turnId: 'turn-p1', answer: '', durationMs: 50, isAborted: true });
      },
      expect: { decidedBy: 'app' },
    },
  ];
  for (const { label, end, expect } of ends) {
    const s = await hubStack(`p1-${label.length}`);
    await s.mod.fire('turn.start', { turnId: 'turn-p1' });
    const abort = new AbortController();
    void s.mod.fire('tool.check', { tool: 'Bash', tool_use_id: `tu-p1-${label.length}`, input: { command: 'make' } }, abort.signal).catch(() => undefined);
    await until(() => permissionCardIds(s.liveFrames).length === 1 && s.mod.record.bands.some((b) => b.label === "Show Claude's dialog"));
    const card = permissionCardIds(s.liveFrames)[0] ?? '';
    await end(s, abort);
    const resolved = await until(() => resolutionOf(s.liveFrames, card) !== undefined, 3000) ? resolutionOf(s.liveFrames, card) : undefined;
    const said = { decidedBy: resolved?.decidedBy, releaseReason: resolved?.releaseReason };
    check(`P-1 seam (${label}): the card says who closed it, not an unnamed other client`,
      resolved?.decision === 'external' && said.decidedBy === expect.decidedBy && said.releaseReason === expect.releaseReason,
      JSON.stringify(resolved));
    await s.close();
  }
  check('P-1: a mod that does not say how it cancelled closes the card as before',
    JSON.stringify(modCancelAttribution({ kind: 'cancelled', why: 'user-cancel' }, false)) === '{}'
      && JSON.stringify(modCancelAttribution({ kind: 'cancelled', why: 'user-cancel' }, true)) === '{}');
  check('P-1: a turn the app stopped that ended before the interrupt was reported is still the app\'s',
    modCancelAttribution({ kind: 'cancelled', why: 'turn-complete' }, true).decidedBy === 'app'
      && JSON.stringify(modCancelAttribution({ kind: 'cancelled', why: 'turn-complete' }, false)) === '{}');
}

try {
  const section = process.argv.find((arg) => arg.startsWith('--section='))?.slice('--section='.length);
  if (section === 'pr5-status') {
    await workingStatusSection();
  } else if (section === 'p10-fork') {
    await forkCallSection();
  } else {
    if (section) throw new Error(`Unknown section: ${section}`);
    await workingStatusSection();
    await appStopSection();
    await terminalCancelSection();
    await questionIdentitySection();
    await terminalAnswerSection();
    await pickerRaceSection();
    await unwatchedQuestionSection();
    await plainSeatSection();
    await openCardsSection();
    await seatUpgradeSection();
    await questionAttributionSection();
    await modeGateSection();
    await resumedAskSection();
    await normalEndSection();
    await stopCrossesEndSection();
    await historyWindowsSection();
    await restartSection();
    await lateBandSection();
    await forkCallSection();
    await escapeSection();
  }
  check('no unhandled rejection escaped', unhandled.length === 0, unhandled.join(' | '));
} catch (error) {
  check('the suite ran to the end', false, String((error as Error)?.stack ?? error).slice(0, 600));
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      /* best effort */
    }
  }
}
finish();
