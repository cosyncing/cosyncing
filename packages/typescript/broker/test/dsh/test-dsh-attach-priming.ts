#!/usr/bin/env bun
/**
 * The dsh attach lifecycle, driven through the REAL {@link AgentRegistry} and a
 * REAL {@link Hub} — owner keying included, because that is where the hazard is.
 *
 * WHY A REAL HUB AND NOT A HAND-BUILT ManagedConn. `Hub.key` folds an absent
 * mode and `'observe'` onto the bare `tool:id` key while an explicit `live` gets
 * `tool:id#live`, and the join rule is ONE-WAY (`hub.ts:1685-1695`): a `#live`
 * request folds onto an existing bare owner that already reports live/driving,
 * but a bare request never folds onto an existing `#live` owner. dsh has no
 * observe surface to degrade a bare attach into, so if the adapter accepted an
 * absent mode this order would produce TWO full-authority owners for one
 * session — foreground `#live` first, background bare second — and
 * {@link DshHostLink} routes by session id ALONE, so registering the second
 * would silently replace the first as the only frame recipient. The foreground
 * client would go quiet while both connections could still write, and closing
 * the second would stop the shared downlinks under the first.
 *
 * A suite that constructs `ManagedConn` directly cannot see any of that: it
 * proves the adapter's own ordering and nothing about who owns the session. So
 * the owner topology is asserted first, through the Hub, and every later phase
 * runs on the connection the Hub actually handed out.
 *
 * The rest is compositional too: `ManagedConn` subscribes in its CONSTRUCTOR and
 * history is read afterwards, so live frames legitimately arrive before the
 * transcript that overlaps them; and `history-reset` is a message the ADAPTER
 * emits which the HUB acts on by re-reading history wholesale. Only the real
 * wrapper proves the re-read reaches attached clients.
 *
 * ISOLATED FAKE HOST. The unary RPC side is a `Bun.serve` on an OS-leased
 * loopback port replaying the sanitized 0.1.0-rc.6 capture; the two push-only
 * downlinks are injected fake sockets. No `dsh` process, no port 3080, no
 * installed broker, no `~/.cosyncing`, no real network, no model call. The
 * reconnect timer is injected, so nothing here waits on a wall clock.
 *
 *   bun run packages/typescript/broker/test/dsh/test-dsh-attach-priming.ts
 */
export {};
import { AgentRegistry } from '@cosyncing/adapter-api';
import { DshAdapter } from '../../../adapters/dsh/src/index.ts';
import type { DshSocketLike } from '../../../adapters/dsh/src/server.ts';
import { DSH_RECONNECT_NOTICE } from '../../../adapters/dsh/src/observe.ts';
import { Hub, type ManagedConn, type WireEvent } from '../../src/sessions/hub.ts';

const FIXTURE = await Bun.file(
  new URL('../../../adapters/dsh/test/fixtures/dsh-0.1.0-rc.6.json', import.meta.url),
).json() as {
  hostDescribe: { body: { result: { value: unknown } } };
  sessionList: { body: { result: { value: unknown } } };
  workspaceList: { body: { result: { value: unknown } } };
  historyTail: {
    body: {
      result: {
        value: {
          events: Array<{ event: { seq: number; type: string } }>;
          hasMore: boolean;
          projections: { asOfSeq: number; values: Record<string, unknown> };
        };
      };
    };
  };
};

const FULL_HISTORY = FIXTURE.historyTail.body.result.value;
const SESSION_ID = 'session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc';
const OTHER_SESSION_ID = 'session-655e54c7-7734-41b5-85bf-e6e838c36709';

/**
 * A distinctive reconnect delay, used as the injected timer's discriminant.
 * The unary client's own 30s deadline goes to the real clock; only this one is
 * captured, so firing it is unambiguous.
 */
const RECONNECT_DELAY_MS = 7;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const threw = async (work: () => Promise<unknown>): Promise<Error | undefined> =>
  work().then(() => undefined, (error: Error) => error);

// ── The fake host's mutable log ─────────────────────────────────────────────
//
// A restarted dsh host serves a SHORTER log under reused sequence numbers.
// Swapping this is how the restart lane stops being a story about one number
// and becomes a story about the transcript the broker re-reads.
let historyPage: {
  events: Array<{ event: { seq: number; type: string } }>;
  hasMore: boolean;
  projections: { asOfSeq: number; values: Record<string, unknown> };
} = FULL_HISTORY;

function truncatedLog(throughSeq: number): typeof historyPage {
  return {
    events: FULL_HISTORY.events.filter((entry) => entry.event.seq <= throughSeq),
    hasMore: false,
    projections: { asOfSeq: throughSeq, values: FULL_HISTORY.projections.values },
  };
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    // Every dsh RPC is a POST on its own allowlisted path; anything else is a
    // route this host does not have, and answering it would hide a bug.
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = await request.json().catch(() => ({})) as { rpcId?: string; method?: string };
    const rpcId = String(body.rpcId ?? '');
    const answer = (value: unknown) => Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
    switch (body.method) {
      case 'host.describe': return answer(FIXTURE.hostDescribe.body.result.value);
      case 'session.list': return answer(FIXTURE.sessionList.body.result.value);
      case 'workspace.list': return answer(FIXTURE.workspaceList.body.result.value);
      case 'session.history': return answer(historyPage);
      default:
        return Response.json({
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: 'unsupported', message: String(body.method) } },
        });
    }
  },
});

// ── Injected downlinks ──────────────────────────────────────────────────────

class FakeSocket implements DshSocketLike {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  closed = false;
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  fire(type: string, event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

/** Sockets of the CURRENT generation, in the order the link opened them (mux, host). */
let generationSockets: FakeSocket[] = [];
let pendingReconnect: (() => void) | undefined;

const adapter = new DshAdapter({
  env: {},
  baseUrl: server.url.origin,
  reconnectDelayMs: RECONNECT_DELAY_MS,
  socketFactory: () => {
    const socket = new FakeSocket();
    generationSockets.push(socket);
    return socket;
  },
  setTimeout: (handler, ms) => {
    if (ms === RECONNECT_DELAY_MS) {
      pendingReconnect = handler;
      return 'reconnect-handle';
    }
    return setTimeout(handler, ms);
  },
  clearTimeout: (handle) => {
    if (handle === 'reconnect-handle') pendingReconnect = undefined;
    else clearTimeout(handle as never);
  },
});

const registry = new AgentRegistry();
registry.register(adapter);
const link = adapter.hostLink();

/** Bring the current generation's two sockets up and wait for host verification. */
async function openGeneration(): Promise<void> {
  const sockets = generationSockets;
  if (sockets.length !== 2) throw new Error(`expected two downlink sockets, saw ${sockets.length}`);
  for (const socket of sockets) socket.fire('open');
  for (let attempt = 0; attempt < 2_000 && !link.isReady; attempt += 1) await Bun.sleep(1);
  if (!link.isReady) throw new Error('the host link never verified host.describe');
}

/** Push one raw frame down a stream, exactly as the socket would deliver it. */
function push(stream: 'mux' | 'host', frameType: string, payload: Record<string, unknown>, rpcId = `push-${frameType}`): void {
  const socket = stream === 'mux' ? generationSockets[0] : generationSockets[1];
  if (!socket) throw new Error(`no ${stream} socket in this generation`);
  socket.fire('message', {
    data: JSON.stringify({ type: 'server-request', rpcId, method: frameType, payload: { type: frameType, ...payload } }),
  });
}

function sessionEvent(sessionId: string, event: Record<string, unknown>): void {
  push('mux', 'session/event', { sessionId, event }, `push-event-${String(event.seq)}`);
}

function userEvent(seq: number, text: string, id: string): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: 1,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, id },
    surfaceOp: 'append',
  };
}

/** End the current generation the way a dropped socket does, then bring the next one up. */
async function reconnect(): Promise<void> {
  const previous = generationSockets;
  generationSockets = [];
  previous[0]!.fire('close');
  if (!pendingReconnect) throw new Error('a lost generation scheduled no reconnect');
  const fire = pendingReconnect;
  pendingReconnect = undefined;
  fire();
  await openGeneration();
}

const wire: WireEvent[] = [];
const messagesIn = (events: WireEvent[]) =>
  events.filter((event): event is Extract<WireEvent, { kind: 'message' }> => event.kind === 'message');
const dshOwnerKeys = (h: Hub) =>
  h.liveSnapshot().map((entry) => entry.key).filter((key) => key.startsWith('dsh:')).sort();

let hub: Hub | undefined;

try {
  hub = new Hub(registry);

  // ══ Phase 0 — owner topology: ONE key, and only by explicit request ═══════
  //
  // Ordered deliberately: the refusals come first so that when the `#live`
  // owner is created there is provably no bare owner for it to fold onto, and
  // the bare attach is retried AFTER it exists — that order is the defect this
  // phase exists to prevent.
  const bareFirst = await threw(() => hub!.ensure('dsh', SESSION_ID));
  check('a bare (no-mode) attach is REFUSED — it would be a full-authority owner on the shared key',
    !!bareFirst, bareFirst?.message ?? '(did not throw)');
  const observeRefused = await threw(() => hub!.ensure('dsh', SESSION_ID, 'observe'));
  check('an observe attach is refused: dsh has no read-only credential to back the word',
    !!observeRefused, observeRefused?.message ?? '(did not throw)');
  const resumeRefused = await threw(() => hub!.ensure('dsh', SESSION_ID, 'resume'));
  check('a resume attach is refused: the host attaches sessions, not the client',
    !!resumeRefused, resumeRefused?.message ?? '(did not throw)');
  check('every refused attach left NO owner behind — the Hub holds nothing for dsh yet',
    dshOwnerKeys(hub).length === 0, dshOwnerKeys(hub).join(',') || '(none)');

  const foreground = await hub.ensure('dsh', SESSION_ID, 'live');
  foreground.addClient((event) => wire.push(event));
  await openGeneration();
  check('an explicit live attach is the ONE owner, on the #live key',
    dshOwnerKeys(hub).join(',') === `dsh:${SESSION_ID}#live`, dshOwnerKeys(hub).join(','));

  // The defect's exact ordering: a background watcher arriving AFTER the
  // foreground owner exists. `Hub.key` would give it the bare key, which never
  // folds onto `#live`, so acceptance here would mean a second owner — and
  // DshHostLink routes by session id alone, so that second connection would
  // become the sole frame recipient and this foreground client would go silent.
  const bareAfterLive = await threw(() => hub!.ensure('dsh', SESSION_ID));
  check('a bare attach AFTER the live owner exists is still refused — no second owner is created',
    !!bareAfterLive && dshOwnerKeys(hub).join(',') === `dsh:${SESSION_ID}#live`,
    `${bareAfterLive?.message ?? '(did not throw)'} keys=${dshOwnerKeys(hub).join(',')}`);

  // A repeated live request must COALESCE onto the same wrapper, not attach
  // again: a second adapter attach would register a second connection under the
  // same session id and replace the routing entry.
  const secondLive = await hub.ensure('dsh', SESSION_ID, 'live');
  check('a repeated live attach coalesces onto the SAME ManagedConn and the same connection',
    secondLive === foreground
      && secondLive.conn === foreground.conn
      && dshOwnerKeys(hub).join(',') === `dsh:${SESSION_ID}#live`,
    `same=${secondLive === foreground} keys=${dshOwnerKeys(hub).join(',')}`);

  // Two clients on that one owner. This is the shape a second app tab takes,
  // and it must not disturb routing for the first.
  const secondClientWire: WireEvent[] = [];
  const secondClient = (event: WireEvent) => secondClientWire.push(event);
  secondLive.addClient(secondClient);
  check('both clients share one owner', foreground.clientCount === 2, String(foreground.clientCount));

  // ══ Phase 1 — priming: history first, buffered live second ════════════════
  const conn = foreground.conn;

  // Two live frames land BEFORE any history read — the production race. One is
  // an event the coming history ALSO carries (seq 8, the human prompt); the
  // other is genuinely newer than the whole capture (seq 21).
  const overlapEvent = FULL_HISTORY.events[8]!.event as unknown as Record<string, unknown>;
  sessionEvent(SESSION_ID, overlapEvent);
  sessionEvent(SESSION_ID, userEvent(21, 'arrived during the attach window', 'm21'));
  await Bun.sleep(20);
  check('live rows are withheld from the Hub until history primes the connection',
    messagesIn(wire).length === 0, `${messagesIn(wire).length} early rows`);

  const history = await conn.getHistory();
  await Bun.sleep(20);
  check('the history read returned the captured transcript',
    history.some((message) => message.type === 'user-message'), `${history.length} rows`);
  const historyTexts = history.map((message) => JSON.stringify(message));
  const liveTexts = messagesIn(wire).map((event) => JSON.stringify(event.message));
  const duplicated = liveTexts.filter((row) => historyTexts.includes(row));
  check('the history/live overlap is emitted EXACTLY ONCE — no row arrives both live and in history',
    duplicated.length === 0, duplicated.slice(0, 2).join(' | '));
  check('the buffered row that history did NOT carry is released after priming, exactly once',
    liveTexts.filter((row) => row.includes('arrived during the attach window')).length === 1,
    `${liveTexts.filter((row) => row.includes('arrived during the attach window')).length} deliveries`);
  check('BOTH clients on the shared owner received that row — routing serves the whole fan-out',
    messagesIn(secondClientWire).filter((event) =>
      JSON.stringify(event.message).includes('arrived during the attach window')).length === 1,
    `${messagesIn(secondClientWire).length} rows on the second client`);

  // One client leaving must not replace routing or silence the other. This is
  // the second half of the dual-owner hazard: `DshHostLink.unregister` stops the
  // shared downlinks when its last connection detaches, so a departing client
  // that took the connection with it would strand the survivor.
  secondLive.removeClient(secondClient);
  const beforeSurvivor = wire.length;
  sessionEvent(SESSION_ID, userEvent(22, 'after one client left', 'm22'));
  await Bun.sleep(20);
  check('after one client disconnects the survivor still receives live frames',
    messagesIn(wire.slice(beforeSurvivor)).some((event) =>
      JSON.stringify(event.message).includes('after one client left'))
      && foreground.clientCount === 1,
    `clients=${foreground.clientCount}`);

  // ══ Phase 2 — a reconnect whose new tail is AHEAD: proven gap ═════════════
  //
  // dsh has no `since` replay, so a fresh subscribe whose tail sits past what
  // this connection admitted is proof of a gap it cannot reconstruct. The
  // honest answer is a wholesale re-read, and this asserts it reaches the Hub
  // rather than stopping at the adapter.
  const beforeReconnect = wire.length;
  await reconnect();
  push('mux', 'session/subscribed', { sessionId: SESSION_ID, lastSeq: 30 });
  await Bun.sleep(60);
  const afterReconnect = wire.slice(beforeReconnect);
  const reconnectHistory = afterReconnect.filter((event) => event.kind === 'history');
  check('a reconnect gap reaches the Hub as a wholesale history re-read',
    reconnectHistory.length === 1, `${reconnectHistory.length} history frames`);
  check('the Hub tells attached clients why the thread was rebuilt',
    afterReconnect.some((event) => event.kind === 'notice' && event.message === DSH_RECONNECT_NOTICE),
    afterReconnect.map((event) => event.kind).join(','));
  const reconnectRows = reconnectHistory[0]?.kind === 'history' ? reconnectHistory[0].messages.length : 0;

  // ══ Phase 3 — a restart whose new tail is BEHIND: reused sequence numbers ══
  //
  // A tail behind delivered state cannot happen inside one generation (log seqs
  // only move forward), so it is authoritative evidence of a NEW host. Its log
  // is shorter and it will REUSE the numbers the previous generation spent, so
  // the retraction has to reach the clients and the admit gate has to rewind —
  // otherwise every replacement event looks like a duplicate and is dropped.
  historyPage = truncatedLog(5);
  const beforeRestart = wire.length;
  await reconnect();
  push('mux', 'session/subscribed', { sessionId: SESSION_ID, lastSeq: 5 });
  await Bun.sleep(60);
  const afterRestart = wire.slice(beforeRestart);
  const restartHistory = afterRestart.filter((event) => event.kind === 'history');
  check('a proven host restart reaches the Hub as its own wholesale re-read',
    restartHistory.length === 1, `${restartHistory.length} history frames`);
  const restartRows = restartHistory[0]?.kind === 'history' ? restartHistory[0].messages.length : 0;
  check('the re-read RETRACTS the previous generation: the rebuilt thread is shorter',
    restartRows > 0 && restartRows < reconnectRows, `${restartRows} rows after restart vs ${reconnectRows} before`);

  const beforeReplacement = wire.length;
  sessionEvent(SESSION_ID, userEvent(6, 'the restarted host reused seq 6', 'm6-new'));
  await Bun.sleep(20);
  const replacement = messagesIn(wire.slice(beforeReplacement))
    .filter((event) => JSON.stringify(event.message).includes('the restarted host reused seq 6'));
  check('a sequence number REUSED by the restarted host is admitted as new content, exactly once',
    replacement.length === 1, `${replacement.length} deliveries`);

  // ══ Phase 4 — removal is terminal ═════════════════════════════════════════
  //
  // A second attached session on the same link, so removal is proven on a
  // connection whose whole life is this lane rather than on one already three
  // generations deep. It gets its own Hub owner, on its own `#live` key.
  const otherWire: WireEvent[] = [];
  const otherOwner = await hub.ensure('dsh', OTHER_SESSION_ID, 'live');
  otherOwner.addClient((event) => otherWire.push(event));
  const other = otherOwner.conn;
  check('a second session is its own Hub owner, and the first owner is untouched',
    dshOwnerKeys(hub).join(',') === [`dsh:${OTHER_SESSION_ID}#live`, `dsh:${SESSION_ID}#live`].sort().join(',')
      && hub.liveSnapshot().length >= 2,
    dshOwnerKeys(hub).join(','));
  await other.getHistory(); // the broker's own attach order: subscribe, then read
  await Bun.sleep(20);

  push('host', 'host/session-removed', { sessionId: OTHER_SESSION_ID });
  await Bun.sleep(20);
  const drive = (other.info.control as { drive?: { state?: string; supported?: boolean } } | undefined)?.drive;
  check('removal retracts Drive authority on the session the Hub publishes',
    drive?.state === 'unavailable' && drive.supported === false, JSON.stringify(drive));
  check('removal reaches attached clients as a republished session, not a silent model change',
    otherWire.some((event) => event.kind === 'session'), otherWire.map((event) => event.kind).join(','));
  check('removal retracts the running state so the Hub cannot latch the session as working',
    other.info.status === 'idle', String(other.info.status));
  const mutationRefused = await threw(() => other.sendPrompt({ text: 'this must not reach the host' }));
  check('every later mutation on a removed session is refused',
    !!mutationRefused, mutationRefused?.message ?? '(did not throw)');

  // The removed session must not have disturbed the OTHER session's routing —
  // one connection per session id in the link, and removal touches only its own.
  const beforeIsolation = wire.length;
  sessionEvent(SESSION_ID, userEvent(7, 'the other session is still live', 'm7'));
  await Bun.sleep(20);
  check('a removed session does not disturb live delivery to the other attached session',
    messagesIn(wire.slice(beforeIsolation)).some((event) =>
      JSON.stringify(event.message).includes('the other session is still live')),
    `${messagesIn(wire.slice(beforeIsolation)).length} rows`);

  // Terminal for TRANSIENT and CONTROL frames — a late approval would recreate
  // a card that is permanently unanswerable on a session the host no longer
  // owns.
  //
  // The CONTROL first, on the session that is still live: the same frame shape
  // must genuinely produce a card, or "it was dropped" would only prove the
  // fixture was malformed.
  const beforeControl = wire.length;
  push('mux', 'approval/requested', {
    sessionId: SESSION_ID,
    approvalId: 'live-approval',
    toolName: 'bash',
  }, 'live-approval-rpc');
  await Bun.sleep(20);
  check('CONTROL: the same approval frame DOES raise a card on a session that was not removed',
    messagesIn(wire.slice(beforeControl)).some((event) => event.message.type === 'permission-request'),
    messagesIn(wire.slice(beforeControl)).map((event) => event.message.type).join(','));

  const beforeLate = otherWire.length;
  push('mux', 'approval/requested', {
    sessionId: OTHER_SESSION_ID,
    approvalId: 'late-approval',
    toolName: 'bash',
  }, 'late-approval-rpc');
  push('host', 'host/session-status', { sessionId: OTHER_SESSION_ID, running: true });
  await Bun.sleep(20);
  check('a late transient frame after removal is dropped rather than reviving the session',
    otherWire.length === beforeLate && other.info.status === 'idle',
    `${otherWire.length - beforeLate} new events, status ${String(other.info.status)}`);

  // ...but NOT for durable transcript, which the two unordered streams can
  // legitimately deliver after the removal that followed it. Dropping that
  // would lose the session's final message permanently.
  sessionEvent(OTHER_SESSION_ID, userEvent(400, 'emitted before removal, delivered after', 'm-late'));
  await Bun.sleep(20);
  check('a durable transcript event emitted before removal still reaches the Hub',
    messagesIn(otherWire).some((event) => JSON.stringify(event.message).includes('emitted before removal')),
    `${messagesIn(otherWire).length} rows`);
} catch (error) {
  check('test harness completed', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await hub?.dispose().catch(() => {});
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
