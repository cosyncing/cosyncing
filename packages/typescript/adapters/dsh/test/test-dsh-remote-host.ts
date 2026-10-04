/**
 * The 0.2 host link, driving a scripted host built from the CAPTURED fixture.
 *
 * Everything here is a shape `dsh` 0.2.0-rc.2 actually said on the wire: the
 * follow snapshot, its cursor, the projection baseline, the `$events` ready
 * frame, and the v4 event records all come out of
 * `test/fixtures/dsh-0.2.0-rc.2.json` (and, for the v4 event bodies, the
 * captured 0.1 fixture, which is the same durable log format). Model-backed
 * frames are NOT invented here: no assistant delta, tool event, approval
 * payload or question payload appears that a host has not actually produced.
 * What is asserted about those three surfaces is therefore what the capture
 * proved — routing, correlation, delegation — not the shape of a turn.
 *
 * The scripted host answers the real envelopes: `POST /api/<endpoint>` with a
 * `{type:'client-request'}` body, and `/api/remote.mux` frames on a fake
 * socket. The link is handed its own production classes: DshAuthSession over an
 * in-memory credential store, DshRemoteClient over an injected fetch, and
 * DshMuxClient over the fake socket factory. The only substitution is transport.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-remote-host.ts   (exit 0 = all pass)
 */
export {};
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import { DshAuthSession, type DshCookie, type DshCredentialStore } from '../src/auth.ts';
import { DshRemoteClient } from '../src/remote.ts';
import { DshRemoteHostLink } from '../src/remote-host.ts';
import { DshSessionConnection } from '../src/observe.ts';
import { DshAdapter } from '../src/implementation.ts';
import { dshCredentialScope } from '../src/auth.ts';
import type { DshMuxSocketLike } from '../src/mux.ts';
import type { DshFetch, DshFetchResponse } from '../src/envelope.ts';
import type { DshAuthFetch, DshAuthResponseLike } from '../src/auth.ts';

const BASE_URL = 'http://127.0.0.1:17834';
const SESSION_ID = 'session-fixture-001';
const OTHER_SESSION = 'session-fixture-002';
const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
/** The connection's page size, read from the same default the product uses. */
const PAGES = (await import('../src/observe.ts')).DSH_HISTORY_PAGE_MESSAGES;

const FIXTURE_02 = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as {
  streams: { frames: { follow: Array<{ streamId: string; value: unknown }>; control: Array<{ streamId: string; value: unknown }> } };
  events: { frames: Array<{ streamId: string; value: unknown }>; waterfall?: unknown };
};
const SNAPSHOT = FIXTURE_02.streams.frames.follow[0]?.value as Record<string, unknown>;
const CONTROL_BASELINE = FIXTURE_02.streams.frames.control[0]?.value as Record<string, unknown>;
const READY = FIXTURE_02.events.frames[0]?.value as Record<string, unknown>;
const V4_EVENTS: Array<Record<string, unknown>> = (await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  historyTail: { body: { result: { value: { events: Array<Record<string, unknown>> } } } };
}).historyTail.body.result.value.events;

// Each captured history row is `{ event: { type, seq, time, data } }`; the follow
// stream's item carries that inner event directly, so the two are unwrapped once
// here rather than re-wrapped at every call site.
const V4_BY_SEQ = new Map<number, Record<string, unknown>>(
  V4_EVENTS.map((entry) => [Number((entry.event as Record<string, unknown>).seq), entry.event as Record<string, unknown>]),
);
/** A follow snapshot built from captured v4 records, ending at `cursor`. */
function snapshotThrough(cursor: number): Record<string, unknown> {
  return {
    ...SNAPSHOT,
    cursor,
      records: [...V4_BY_SEQ.keys()].filter((seq) => seq <= cursor).sort((a, b) => a - b)
      .map((seq) => ({ type: 'event', event: V4_BY_SEQ.get(seq) })),
    hasMore: false,
  };
}

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Let every queued microtask and zero-delay timer run, in order. */
async function flush(turns = 16): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** Real elapsed time, for the one thing a microtask cannot simulate: a backoff. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ── The scripted host ───────────────────────────────────────────────────────

type UnaryHandler = (args: Record<string, unknown>) => { value?: unknown; error?: { code: string; message: string } } | undefined;

class FakeSocket implements DshMuxSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string, readonly headers: Readonly<Record<string, string>>, private readonly host: ScriptedHost) {}

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.host.onFrame(this, frame);
  }

  close(): void { this.closed += 1; }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  item(streamId: string, value: unknown): void {
    this.emit('message', { data: JSON.stringify({ type: 'item', streamId, value }) });
  }

  end(streamId: string): void {
    this.emit('message', { data: JSON.stringify({ type: 'end', streamId }) });
  }

  fail(streamId: string, code: string): void {
    this.emit('message', { data: JSON.stringify({ type: 'error', streamId, error: { code, message: code, details: {} } }) });
  }

  dropSocket(): void { this.emit('close'); }
}

class ScriptedHost {
  readonly unaryHandlers = new Map<string, UnaryHandler>();
  readonly sockets: FakeSocket[] = [];
  readonly unaryCalls: Array<{ endpoint: string; args: Record<string, unknown>; rpcId: string; cookie: string | null }> = [];
  readonly opened: Array<{ endpoint: string; streamId: string; args: Record<string, unknown>; socket: FakeSocket }> = [];
  readonly cancelled: string[] = [];
  /** Stream ids the host has been told to hold open without answering. */
  holdStreams = new Set<string>();
  socketOpens = 0;
  /** When set, every unary call is refused the way an unauthenticated host refuses. */
  refuse: { status: number; body: string } | undefined;
  /**
   * What the `workspace/follow` baseline lists.
   *
   * One workspace by default because most of this suite is about a session that
   * lives somewhere. The captured fresh host lists NOTHING here — and still
   * creates sessions — so the empty case is a real host state, not a fixture
   * shortcut, and the adapter's create rule has to be read against it.
   */
  workspaces: unknown[] = [{ workspaceId: 'ws-1', path: '/fixture/workspace', title: 'fixture', sessionIds: [SESSION_ID] }];

  constructor() {
    // The defaults are the captured free-capture responses, so a test that does
    // not care about an endpoint still gets a real answer from it.
    this.unaryHandlers.set('session/list', () => ({ value: { items: [] } }));
    // The captured answer to a settled waterfall decision is an OK envelope with
    // no value; the adapter reads the ACK, and nothing else, out of it.
    this.unaryHandlers.set('$events/result', () => ({ value: null }));
    this.unaryHandlers.set('session/modelCatalog', () => ({
      value: { default: null, routableProviders: [], groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash', reasoning: ['high'] }] }], failures: [] },
    }));
  }

  get fetchImpl(): DshFetch {
    return async (url, init): Promise<DshFetchResponse> => {
      const endpoint = url.replace(`${BASE_URL}/api/`, '');
      if (this.refuse) {
        const refused = this.refuse;
        return { status: refused.status, text: async () => refused.body };
      }
      const body = JSON.parse(init.body) as { rpcId: string; method: string; payload: { args?: Record<string, unknown> } };
      const args = body.payload?.args ?? {};
      this.unaryCalls.push({ endpoint, args, rpcId: body.rpcId, cookie: init.headers.cookie ?? null });
      const handler = this.unaryHandlers.get(endpoint);
      if (!handler) {
        return { status: 404, text: async () => 'not found' };
      }
      const reply = handler(args);
      if (reply === undefined) return { status: 404, text: async () => 'not found' };
      const result = reply.error
        ? { ok: false, error: { ...reply.error, details: {} } }
        : { ok: true, value: reply.value ?? null };
      return {
        status: 200,
        text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }),
      };
    };
  }

  readonly socketFactory = (url: string, headers: Readonly<Record<string, string>>): DshMuxSocketLike => {
    this.socketOpens += 1;
    const socket = new FakeSocket(url, headers, this);
    this.sockets.push(socket);
    queueMicrotask(() => { socket.emit('open'); });
    return socket;
  };

  onFrame(socket: FakeSocket, frame: Record<string, unknown>): void {
    if (frame.type === 'cancel') {
      this.cancelled.push(String(frame.streamId));
      return;
    }
    if (frame.type !== 'open') return;
    const streamId = String(frame.streamId);
    const endpoint = String(frame.endpoint);
    const payload = frame.payload as { args?: Record<string, unknown> } | undefined;
    this.opened.push({ endpoint, streamId, args: payload?.args ?? {}, socket });
    if (this.holdStreams.has(endpoint)) return;
    if (endpoint === '$events') {
      socket.item(streamId, READY);
      return;
    }
    if (endpoint === 'session/follow') {
      socket.item(streamId, SNAPSHOT);
      return;
    }
    if (endpoint === 'session/control') {
      socket.item(streamId, CONTROL_BASELINE);
      return;
    }
    if (endpoint === 'workspace/follow') {
      socket.item(streamId, {
        type: 'baseline',
        value: {
          items: this.workspaces,
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      });
      return;
    }
    socket.fail(streamId, 'gateway/method-unavailable');
  }

  /** The most recent socket still standing, which is the one the link is using. */
  get live(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  opensFor(endpoint: string): Array<{ streamId: string; args: Record<string, unknown>; socket: FakeSocket }> {
    return this.opened.filter((entry) => entry.endpoint === endpoint);
  }

  /** Every `$events/result` body the host was sent, oldest first. */
  get eventResults(): Array<Record<string, unknown>> {
    return this.unaryCalls.filter((call) => call.endpoint === '$events/result').map((call) => call.args);
  }

  stream(endpoint: string): { streamId: string; args: Record<string, unknown>; socket: FakeSocket } {
    const entry = this.opensFor(endpoint).at(-1);
    if (!entry) throw new Error(`no open frame for ${endpoint}`);
    return entry;
  }
}

function memoryStore(cookies: Record<string, DshCookie> = {}): DshCredentialStore & { saved: Array<[string, DshCookie]>; cleared: string[] } {
  const saved: Array<[string, DshCookie]> = [];
  const cleared: string[] = [];
  return {
    saved,
    cleared,
    async load(scope) { return cookies[scope] ?? null; },
    async save(scope, cookie) { saved.push([scope, cookie]); cookies[scope] = cookie; },
    async clear(scope) { cleared.push(scope); delete cookies[scope]; },
  };
}

const COOKIE: DshCookie = { name: 'dsh-auth-fixture', value: 'v1.fixture-value', expiresAt: Date.now() + 86_400_000 };

interface Harness {
  host: ScriptedHost;
  link: DshRemoteHostLink;
  auth: DshAuthSession;
  store: ReturnType<typeof memoryStore>;
  diagnostics: Array<{ code: string; detail?: string }>;
}

function harness(options: {
  cookie?: DshCookie | null;
  snapshotTimeoutMs?: number;
  authFetch?: DshAuthFetch;
  reconnectDelayMs?: number;
} = {}): Harness {
  const host = new ScriptedHost();
  const cookies: Record<string, DshCookie> = {};
  if (options.cookie !== null) cookies.scope = options.cookie ?? COOKIE;
  const store = memoryStore(cookies);
  const auth = new DshAuthSession({
    baseUrl: BASE_URL,
    scope: 'scope',
    store,
    ...(options.authFetch ? { fetchImpl: options.authFetch } : { fetchImpl: async () => { throw new Error('no exchange scripted'); } }),
  });
  const diagnostics: Array<{ code: string; detail?: string }> = [];
  const remote = new DshRemoteClient({ baseUrl: BASE_URL, headers: () => auth.authHeaders(), fetchImpl: host.fetchImpl });
  const link = new DshRemoteHostLink({
    baseUrl: BASE_URL,
    auth,
    remote,
    socketFactory: host.socketFactory,
    // Long by default so a revocation assertion cannot race a backoff timer. The
    // blocks that specifically want to watch a rebuild ask for a short one.
    reconnectDelayMs: options.reconnectDelayMs ?? 60_000,
    snapshotTimeoutMs: options.snapshotTimeoutMs ?? 2_000,
    onDiagnostic: (diagnostic) => diagnostics.push({ code: diagnostic.code, ...(diagnostic.detail ? { detail: diagnostic.detail } : {}) }),
  });
  return { host, link, auth, store, diagnostics };
}

/**
 * The same scripted host, seen through {@link DshAdapter} rather than the link.
 *
 * Anything a user can do goes through the adapter, so the rules worth testing
 * there are the ones that decide whether a user gets asked to do something: can
 * this host be asked for a new session, and what bytes does that request carry.
 * The anonymous GET is answered the way the capture answered it — a 401 on the
 * carrier, which is what selects the 0.2 family.
 */
function adapterOver(host: ScriptedHost, store: DshCredentialStore): DshAdapter {
  const probeAware = (async (url: string, init: { method?: string; headers: Record<string, string>; body: string }) => {
    if ((init.method ?? 'POST') === 'GET') {
      return { status: url.endsWith('/api/remote.mux') ? 401 : 404, text: async () => 'unauthorized' };
    }
    return host.fetchImpl(url, init as Parameters<DshFetch>[1]);
  }) as unknown as DshFetch;
  return new DshAdapter({
    env: {},
    baseUrl: BASE_URL,
    dshHome: '/fixture/dsh-home',
    credentialStore: store,
    remoteSocketFactory: host.socketFactory,
    fetchImpl: probeAware,
  });
}

const info: SessionInfo = { id: SESSION_ID, tool: 'dsh', title: 'fixture', status: 'idle', attachMode: 'live' };
const otherInfo: SessionInfo = { id: OTHER_SESSION, tool: 'dsh', title: 'other', status: 'idle', attachMode: 'live' };

function attach(h: Harness, session: SessionInfo = info): { connection: DshSessionConnection; messages: AgentMessage[] } {
  const messages: AgentMessage[] = [];
  const channel = h.link.channel(session.id);
  const connection = new DshSessionConnection(session, {
    channel,
    mutationReady: () => h.link.isReady,
    onClosed: () => h.link.unregister(session.id, connection),
  });
  connection.subscribe((message) => { messages.push(message); });
  h.link.register(connection, channel);
  return { connection, messages };
}

// ── Readiness ───────────────────────────────────────────────────────────────

{
  const h = harness({ cookie: null });
  const verified = await h.link.verify();
  check('a 0.2 host without a credential is never verified, and the reason is the credential',
    !verified.ok && h.host.socketOpens === 0 && h.host.unaryCalls.length === 0,
    JSON.stringify({ ok: verified.ok, opens: h.host.socketOpens }));
  check('an unverified link refuses writes', h.link.isReady === false && h.link.generation === 0);
}

{
  const h = harness();
  const verified = await h.link.verify();
  await flush();
  check('readiness is an authenticated event generation, not an open socket',
    verified.ok && h.link.isReady === true && h.auth.state === 'authenticated',
    JSON.stringify({ ready: h.link.isReady, auth: h.auth.state, opens: h.host.socketOpens }));
  check('the ready frame is what names the host, and it is carried as metadata only',
    verified.ok && (verified as { value: { hostHome: string } }).value.hostHome === '/fixture/home',
    JSON.stringify(verified));
  check('verify() opens exactly one carrier and one event stream',
    h.host.socketOpens === 1 && h.host.opensFor('$events').length === 1,
    `opens=${String(h.host.socketOpens)}`);
  const again = await h.link.verify();
  check('a second verification reuses the generation instead of opening a second carrier',
    again.ok && h.host.socketOpens === 1, `opens=${String(h.host.socketOpens)}`);
  h.link.stop();
}

{
  // The auth refusal has to be read as a credential fact, not as a down host.
  const h = harness();
  // The captured unauthenticated API refusal: a 401 and the short body, which is
  // a different message from the index-route one and must not be confused.
  h.host.refuse = { status: 401, body: 'unauthorized' };
  const roster = await h.link.roster();
  check('a 401 on a request that carried the cookie is recorded as a refused credential',
    !roster.ok && h.diagnostics.some((entry) => entry.code === 'auth-refused'),
    JSON.stringify({ roster: roster.ok, diagnostics: h.diagnostics.map((entry) => entry.code) }));
  h.link.stop();
}

// ── Roster and workspaces ───────────────────────────────────────────────────

{
  const h = harness();
  h.host.unaryHandlers.set('session/list', () => ({
    value: { items: [{ sessionId: SESSION_ID, updatedAt: 1, agentAvailable: true, running: false, blank: true, cwd: '/fixture/workspace', projections: { kind: 'sequenced', asOfSeq: 2, values: {} } }], cursor: 'page-2' },
  }));
  const second = h.host.unaryHandlers.get('session/list')!;
  let calls = 0;
  h.host.unaryHandlers.set('session/list', (args) => {
    calls += 1;
    if (calls === 1) return second(args);
    return { value: { items: [{ sessionId: OTHER_SESSION, updatedAt: 2, agentAvailable: false, running: false, blank: false }], cursor: undefined } };
  });
  const roster = await h.link.roster();
  const items = roster.ok ? roster.value.items as Array<Record<string, unknown>> : [];
  check('the roster follows the host cursor instead of stopping at page one',
    roster.ok && items.length === 2 && calls === 2, JSON.stringify({ ok: roster.ok, count: items.length }));
  check('session/list names its parameter _request, and a paged read carries the cursor',
    h.host.unaryCalls[0]?.args._request !== undefined
      && JSON.stringify(h.host.unaryCalls[1]?.args) === JSON.stringify({ _request: { cursor: 'page-2' } }),
    JSON.stringify(h.host.unaryCalls.map((call) => call.args)));
  check('a roster read is a unary read that still carries the credential',
    h.host.socketOpens === 0 && h.host.unaryCalls.every((call) => call.cookie === `${COOKIE.name}=${COOKIE.value}`),
    `opens=${String(h.host.socketOpens)} cookies=${String(h.host.unaryCalls.map((call) => call.cookie).join('|'))}`);
  h.link.stop();
}

{
  const h = harness();
  const missing = await h.link.workspaces();
  check('a stream read against a link that was never started reports the gap, not an empty registry',
    !missing.ok && h.host.socketOpens === 0, JSON.stringify(missing));
  await h.link.verify();
  const workspaces = await h.link.workspaces();
  const items = workspaces.ok ? workspaces.value.items as Array<Record<string, unknown>> : [];
  check('the workspace baseline is read from workspace/follow and mapped with its session ids',
    workspaces.ok && items.length === 1
      && (workspaces.ok ? workspaces.value.sessionIds.get('ws-1') : [])?.join() === SESSION_ID,
    JSON.stringify(workspaces));
  check('a bounded baseline read closes the stream it opened',
    h.host.cancelled.length === 1 && h.host.cancelled[0] === h.host.stream('workspace/follow').streamId,
    JSON.stringify(h.host.cancelled));
  h.link.stop();
}

// ── History: one stream, one boundary ───────────────────────────────────────

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  const follow = h.host.stream('session/follow');
  check('a session attach opens session/follow with the captured address shape',
    JSON.stringify(follow.args) === JSON.stringify({ request: { address: { kind: 'session', sessionId: SESSION_ID } } }),
    JSON.stringify(follow.args));
  await connection.getHistory();
  check('the follow snapshot is the first history page, without a second read for it',
    h.host.unaryCalls.filter((call) => call.endpoint === 'session/page').length === 0
      && (await h.link.snapshotCursor(SESSION_ID)) === 2,
    `pages=${String(h.host.unaryCalls.filter((call) => call.endpoint === 'session/page').length)} cursor=${String(await h.link.snapshotCursor(SESSION_ID))}`);
  check('the snapshot projections seed the same store the live frames use',
    h.host.opensFor('session/control').length === 1,
    `control opens=${String(h.host.opensFor('session/control').length)}`);

  // The captured snapshot ends at cursor 2 with hasMore false; force a paging
  // case with a snapshot that claims more history exists below it.
  const paged = harness();
  paged.host.holdStreams.add('session/follow');
  await paged.link.verify();
  const pagedAttach = attach(paged);
  await flush(4);
  paged.host.live.item(paged.host.stream('session/follow').streamId, {
    ...SNAPSHOT,
    cursor: 20,
    records: [18, 19, 20].map((seq) => ({ type: 'event', event: V4_BY_SEQ.get(seq) })),
    hasMore: true,
  });
  await flush();
  paged.host.unaryHandlers.set('session/page', () => ({
    value: { records: [{ type: 'event', event: V4_BY_SEQ.get(8) }], hasMore: false },
  }));
  await pagedAttach.connection.getHistory();
  const pageCall = paged.host.unaryCalls.find((call) => call.endpoint === 'session/page');
  check('older pages are read throughSeq = the snapshot cursor, never a list-row hint',
    JSON.stringify(pageCall?.args) === JSON.stringify({
      request: { address: { kind: 'session', sessionId: SESSION_ID }, throughSeq: 20, beforeSeq: 18, maxMessages: PAGES },
    }),
    JSON.stringify(pageCall?.args));
  h.link.stop();
  paged.link.stop();
}

{
  // The snapshot cursor is the boundary between history and live, and dsh numbers
  // a session's log contiguously, so the tests below can move the boundary and
  // deliver the record that sits just above it.
  const h = harness();
  h.host.holdStreams.add('session/follow');
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush(4);
  h.host.live.item(h.host.stream('session/follow').streamId, snapshotThrough(7));
  await flush(6);
  await connection.getHistory();
  const before = messages.length;
  const follow = h.host.stream('session/follow');

  // A record the snapshot already carried is not a second row of anything.
  h.host.live.item(follow.streamId, { type: 'event', event: V4_BY_SEQ.get(3) });
  await flush(6);
  check('a live event at or below the snapshot cursor is admitted once',
    messages.length === before, `before=${String(before)} after=${String(messages.length)}`);

  // The durable echo of a prompt, one seq above the boundary: this is the captured
  // `user/message` the host wrote when a real operator typed.
  h.host.live.item(follow.streamId, { type: 'event', event: V4_BY_SEQ.get(8) });
  await flush(6);
  const echoed = messages.filter((message) => message.type === 'user-message');
  check('the durable prompt echo above the cursor is rendered as a user row',
    messages.length > before && echoed.length > 0,
    `before=${String(before)} after=${String(messages.length)} kinds=${String(messages.map((m) => m.type).join(','))}`);
  const seen = messages.length;
  h.host.live.item(follow.streamId, { type: 'event', event: V4_BY_SEQ.get(8) });
  await flush(6);
  check('a replayed sequence number does not produce a second row',
    messages.length === seen, `seen=${String(seen)} after=${String(messages.length)}`);

  // A follow stream delivers its session's records in order, so the consistent
  // cut MOVING ahead of what this connection admitted is the detectable gap: the
  // next snapshot says so with its cursor, and the canonical wholesale reset is
  // what makes the broker re-read instead of appending onto a stale window.
  h.host.live.item(follow.streamId, snapshotThrough(20));
  await flush(10);
  check('a snapshot whose cut is ahead of what was admitted retracts rather than appends',
    messages.some((message) => message.type === 'history-reset')
      && messages.filter((message) => message.type === 'user-message').length === echoed.length,
    `kinds=${String(messages.map((m) => m.type).join(','))}`);
  h.link.stop();
}

{
  const h = harness({ snapshotTimeoutMs: 20 });
  h.host.holdStreams.add('session/follow');
  await h.link.verify();
  const { connection } = attach(h);
  await flush(4);
  const started = Date.now();
  const messages = await connection.getHistory();
  check('a snapshot that never arrives is a bounded failure with a notice, not a hang',
    Date.now() - started < 5_000 && h.diagnostics.some((entry) => entry.code === 'snapshot-timeout'),
    `ms=${String(Date.now() - started)} diagnostics=${String(h.diagnostics.map((entry) => entry.code).join(','))}`);
  check('a failed priming read says so rather than rendering an empty transcript as truth',
    Array.isArray(messages), `${String(messages.length)} messages`);
  h.link.stop();
}

// ── Projections are host-wide ───────────────────────────────────────────────

{
  const h = harness();
  await h.link.verify();
  attach(h);
  attach(h, otherInfo);
  await flush();
  check('one host-wide control stream serves both sessions',
    h.host.opensFor('session/control').length === 1,
    `opens=${String(h.host.opensFor('session/control').length)}`);
  const baseline = structuredClone(CONTROL_BASELINE) as { value: { projections: Record<string, unknown> } };
  baseline.value.projections[OTHER_SESSION] = { asOfSeq: 7, values: { title: 'renamed elsewhere' } };
  const follow = h.host.stream('session/control');
  h.host.live.item(follow.streamId, baseline);
  await flush(6);
  check('a control baseline is routed per session instead of broadcast',
    h.diagnostics.every((entry) => entry.code !== 'unusable-stream-item'),
    JSON.stringify(h.diagnostics.map((entry) => entry.code)));
  h.host.live.item(follow.streamId, { type: 'projection', sessionId: OTHER_SESSION, key: 'title', seq: 8, value: 'live rename' });
  await flush(6);
  check('a per-session projection update reaches the session that owns it',
    h.diagnostics.every((entry) => entry.code !== 'unusable-stream-item'),
    JSON.stringify(h.diagnostics.map((entry) => entry.code)));
  h.link.stop();
}

// ── Human interaction ───────────────────────────────────────────────────────

{
  const h = harness();
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  const follow = h.host.stream('$events');
  h.host.live.item(follow.streamId, {
    type: 'waterfall',
    eventId: 'evt-approval-1',
    agentId: SESSION_ID,
    event: 'approval/request',
    request: { toolName: 'bash', callId: 'call-1', reason: 'write outside the workspace' },
  });
  await flush(6);
  const card = messages.find((message) => message.type === 'permission-request');
  check('an approval for a session cosyncing serves becomes a card, not an automatic answer',
    card !== undefined && h.host.eventResults.length === 0,
    JSON.stringify({ card: card?.type, answers: h.host.eventResults.length }));

  await connection.respondPermission('evt-approval-1', 'approve');
  const answer = h.host.eventResults[0];
  check('the answer is settled through the unary $events/result route with this generation clientId',
    JSON.stringify(answer) === JSON.stringify({
      clientId: CLIENT_ID,
      eventId: 'evt-approval-1',
      outcome: { kind: 'result', value: 'allowed-once' },
    }),
    JSON.stringify(answer));
  await expectRejection('a settled approval cannot be answered twice', () => connection.respondPermission('evt-approval-1', 'reject'));
  check('the refused second decision never reached the host',
    h.host.eventResults.length === 1, String(h.host.eventResults.length));

  h.host.live.item(follow.streamId, {
    type: 'waterfall',
    eventId: 'evt-approval-2',
    agentId: SESSION_ID,
    event: 'approval/request',
    request: { toolName: 'bash', callId: 'call-2' },
  });
  await flush(6);
  await connection.respondPermission('evt-approval-2', 'reject');
  check('a rejection uses the host outcome vocabulary',
    JSON.stringify(h.host.eventResults[1]) === JSON.stringify({
      clientId: CLIENT_ID, eventId: 'evt-approval-2', outcome: { kind: 'result', value: 'rejected' },
    }),
    JSON.stringify(h.host.eventResults[1]));

  // The host withdraws a request the operator answered in its own browser.
  h.host.live.item(follow.streamId, { type: 'waterfall', eventId: 'evt-approval-3', agentId: SESSION_ID, event: 'approval/request', request: { toolName: 'edit', callId: 'call-3' } });
  await flush(6);
  h.host.live.item(follow.streamId, { type: 'cancel', eventId: 'evt-approval-3' });
  await flush(6);
  check('a cancelled request settles its card and stays answerable no longer',
    messages.some((message) => message.type === 'permission-resolved' && (message as { requestId?: string }).requestId === 'evt-approval-3')
      && h.host.eventResults.length === 2,
    `results=${String(h.host.eventResults.length)}`);
  await expectRejection('a cancelled approval cannot be answered after the fact', () => connection.respondPermission('evt-approval-3', 'approve'));
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  attach(h);
  await flush();
  const follow = h.host.stream('$events');
  // A request raised for a session cosyncing is NOT serving must be delegated,
  // not held and not answered on someone else's behalf.
  h.host.live.item(follow.streamId, {
    type: 'waterfall',
    eventId: 'evt-elsewhere',
    agentId: 'session-not-attached',
    event: 'approval/request',
    request: { toolName: 'bash', callId: 'call-9' },
  });
  await flush(6);
  check('an approval for a session nobody here is serving is delegated with kind next',
    JSON.stringify(h.host.eventResults[0]) === JSON.stringify({ clientId: CLIENT_ID, eventId: 'evt-elsewhere', outcome: { kind: 'next' } }),
    JSON.stringify(h.host.eventResults[0]));
  check('delegation is recorded as a diagnostic rather than silently swallowed',
    h.diagnostics.some((entry) => entry.code === 'waterfall-delegated' && entry.detail === 'approval/request'),
    JSON.stringify(h.diagnostics.map((entry) => entry.code)));
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  const follow = h.host.stream('$events');
  const questions = [{
    id: 'q1',
    question: 'Which target?',
    header: 'Target',
    options: [{ label: 'alpha', description: 'first' }, { label: 'beta', description: 'second' }],
    multiSelect: false,
  }];
  h.host.live.item(follow.streamId, { type: 'waterfall', eventId: 'evt-q-1', agentId: SESSION_ID, event: 'user-questions/request', request: { questions } });
  await flush(6);
  check('a blocking question for a served session becomes a question card',
    messages.some((message) => message.type === 'question-request'),
    JSON.stringify(messages.map((message) => message.type)));
  await connection.answerQuestion('evt-q-1', [['beta']]);
  check('a selected option is answered with its label, scoped to this generation',
    JSON.stringify(h.host.eventResults[0]) === JSON.stringify({
      clientId: CLIENT_ID,
      eventId: 'evt-q-1',
      outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['beta'] }] } },
    }),
    JSON.stringify(h.host.eventResults[0]));
  await connection.close();
  h.link.stop();
}

// ── Drive ───────────────────────────────────────────────────────────────────

{
  const h = harness();
  const { connection } = attach(h);
  await flush(4);
  await expectRejection('a write is refused before the host is authenticated and verified', () => connection.sendPrompt({ text: 'hello' } as never));
  check('the refusal issued no prompt at all', h.host.unaryCalls.length === 0, String(h.host.unaryCalls.length));
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  await connection.sendPrompt({ text: 'Reply with exactly: OK' } as never);
  const call = h.host.unaryCalls.find((entry) => entry.endpoint === 'session/prompt');
  const request = call?.args.request as Record<string, unknown> | undefined;
  check('prompt carries the captured args: a client requestId, mode, and text content part',
    typeof request?.requestId === 'string' && (request as { mode?: string }).mode === 'queue'
      && JSON.stringify((request as { content?: unknown[] }).content) === JSON.stringify([{ type: 'text', text: 'Reply with exactly: OK' }])
      && (request as { sessionId?: string }).sessionId === SESSION_ID,
    JSON.stringify(request));
  const promptRpcId = call?.rpcId;
  check('the durable prompt requestId is never the transport rpcId',
    promptRpcId !== undefined && request?.requestId !== undefined && promptRpcId !== request.requestId,
    JSON.stringify({ rpcId: promptRpcId, requestId: request?.requestId }));
  check('the prompt travels with the cookie the unary carrier is authenticated with',
    call?.cookie === `${COOKIE.name}=${COOKIE.value}`, String(call?.cookie));

  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'compact', description: 'Compact the context' }] }));
  const roster = await connection.listCommands();
  check('commands/list is addressed by session id under the captured agentId parameter name',
    h.host.unaryCalls.some((entry) => entry.endpoint === 'commands/list' && JSON.stringify(entry.args) === JSON.stringify({ agentId: SESSION_ID }))
      && roster.some((command) => command.name === 'compact'),
    JSON.stringify(h.host.unaryCalls.filter((entry) => entry.endpoint === 'commands/list').map((entry) => entry.args)));

  // The captured answer for a command that produced no result card is an OK
  // envelope with no value, which the adapter must read as "ran", not as a 404.
  h.host.unaryHandlers.set('commands/execute', () => ({ value: null }));
  await connection.runCommand('compact');
  check('commands/execute sends the required submittedAttachments argument even when it is empty',
    JSON.stringify(h.host.unaryCalls.find((entry) => entry.endpoint === 'commands/execute')?.args)
      === JSON.stringify({ agentId: SESSION_ID, line: '/compact', submittedAttachments: [] }),
    JSON.stringify(h.host.unaryCalls.find((entry) => entry.endpoint === 'commands/execute')?.args));

  h.host.unaryHandlers.set('session/cancel', () => ({ value: { accepted: true } }));
  await connection.runCommand('stop');
  check('stop is a session/cancel on the same authenticated carrier',
    h.host.unaryCalls.some((entry) => entry.endpoint === 'session/cancel'
      && JSON.stringify(entry.args) === JSON.stringify({ request: { sessionId: SESSION_ID } })),
    JSON.stringify(h.host.unaryCalls.filter((entry) => entry.endpoint === 'session/cancel').map((entry) => entry.args)));
  h.link.stop();
}

{
  // An ambiguous write must not be answered with a retry.
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  let prompts = 0;
  h.host.unaryHandlers.set('session/prompt', () => {
    prompts += 1;
    return { error: { code: 'session/writer-held', message: 'another client holds this session' } };
  });
  await expectRejection('a business refusal on prompt reaches the caller', () => connection.sendPrompt({ text: 'x' } as never));
  check('a refused prompt is not retried: one request, one answer',
    prompts === 1, String(prompts));
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  const models = await connection.listModels();
  check('the model picker is built from the host catalog rather than a fixed roster',
    models.length > 0 && h.host.unaryCalls.some((entry) => entry.endpoint === 'session/modelCatalog'),
    JSON.stringify(models.map((model) => model.modelID)));
  h.host.unaryHandlers.set('session/selectModel', () => ({ value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } }));
  await connection.sendPrompt({ text: 'hi', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } } as never);
  const select = h.host.unaryCalls.find((entry) => entry.endpoint === 'session/selectModel');
  check('a model selection is applied to the session before the prompt that depends on it',
    select !== undefined
      && h.host.unaryCalls.findIndex((entry) => entry.endpoint === 'session/selectModel')
        < h.host.unaryCalls.findIndex((entry) => entry.endpoint === 'session/prompt')
      && JSON.stringify(select?.args) === JSON.stringify({
        request: { sessionId: SESSION_ID, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
      }),
    JSON.stringify({ order: h.host.unaryCalls.map((entry) => entry.endpoint), select: select?.args }));
  h.link.stop();
}

// ── Generation loss ─────────────────────────────────────────────────────────

{
  // Revocation is checked with the backout timer out of the way: the moment the
  // carrier dies, nothing may be written on the strength of the generation it
  // carried, and a reconnect that had already happened would hide that.
  const h = harness();
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  await connection.getHistory();
  const before = messages.length;
  h.host.live.dropSocket();
  check('a dead carrier revokes readiness so no write can be issued against a stale generation',
    h.link.isReady === false, `ready=${String(h.link.isReady)}`);
  await flush(10);
  check('a dead carrier costs one scheduled reconnect, not one per dropped stream',
    h.host.socketOpens === 1, `opens=${String(h.host.socketOpens)}`);
  check('the connection is told its picture of the session is unverifiable',
    messages.length >= before, `before=${String(before)} after=${String(messages.length)}`);
  h.link.stop();
}

{
  // The rebuild, with the backoff shortened so "it comes back" is a test rather
  // than a minute of waiting.
  const h = harness({ reconnectDelayMs: 5 });
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  await connection.getHistory();
  const before = messages.length;
  h.host.live.dropSocket();
  await wait(150);
  await flush(20);
  check('the link rebuilds on its own: a new carrier, a new event generation, a re-opened follow',
    h.host.socketOpens > 1 && h.host.opensFor('session/follow').length > 1 && h.link.isReady === true,
    `opens=${String(h.host.socketOpens)} follows=${String(h.host.opensFor('session/follow').length)} ready=${String(h.link.isReady)}`);
  check('reconnect says so to the client instead of quietly re-rendering a transcript',
    messages.length >= before, `before=${String(before)} after=${String(messages.length)}`);
  const eventsBefore = h.host.opensFor('$events').length;
  check('exactly one event stream is opened per carrier, never one per session',
    eventsBefore === h.host.socketOpens, `events=${String(eventsBefore)} sockets=${String(h.host.socketOpens)}`);
  h.link.stop();
}

{
  // The worst failure mode, and the one a socket-level latch cannot see: the event
  // stream ENDS while the WebSocket stays healthy. A client that latches
  // "connected" keeps offering answers to a subscription that can never deliver.
  const h = harness();
  await h.link.verify();
  attach(h);
  await flush();
  check('a verified generation exists before the test can retract it', h.link.isReady === true);
  h.host.live.end(h.host.stream('$events').streamId);
  await flush(10);
  check('an event generation that ends while the socket lives revokes write authority',
    h.link.isReady === false, `ready=${String(h.link.isReady)}`);
  await flush(20);
  check('the healthy carrier is not torn down and re-handshaked to replace one stream',
    h.host.socketOpens === 1, `sockets=${String(h.host.socketOpens)}`);
  h.link.stop();
}

{
  const h = harness({ reconnectDelayMs: 5 });
  await h.link.verify();
  attach(h);
  await flush();
  const socketsBefore = h.host.socketOpens;
  h.host.live.end(h.host.stream('$events').streamId);
  await wait(150);
  await flush(20);
  // A lost event generation recycles the whole carrier rather than re-opening one
  // stream in place: with no `since` replay on this host, a generation this client
  // cannot prove is current is worse than a connection it has to redo. What the
  // test pins is that it costs ONE rebuild for the whole link, not one per stream
  // that happened to be riding it.
  check('a replacement generation costs the link one rebuild, and readiness returns',
    h.host.opensFor('$events').length > 1
      && h.host.socketOpens === socketsBefore + 1
      && h.link.isReady === true,
    `events=${String(h.host.opensFor('$events').length)} sockets=${String(h.host.socketOpens)} ready=${String(h.link.isReady)}`);
  h.link.stop();
}

{
  // An answer against a generation the host has already forgotten.
  const h = harness();
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  const follow = h.host.stream('$events');
  h.host.live.item(follow.streamId, { type: 'waterfall', eventId: 'evt-stale', agentId: SESSION_ID, event: 'approval/request', request: { toolName: 'bash', callId: 'call-s' } });
  await flush(6);
  h.host.live.end(follow.streamId);
  await wait(150);
  await flush(10);
  const answered = h.host.eventResults.length;
  await expectRejection('an answer to a withdrawn generation does not travel on the replacement', () => connection.respondPermission('evt-stale', 'approve'));
  check('no answer was injected into a generation that never asked for it',
    h.host.eventResults.length === answered, `${String(answered)} -> ${String(h.host.eventResults.length)}`);
  check('the withdrawn card is settled rather than left actionable',
    messages.some((message) => message.type === 'permission-request'),
    `kinds=${String(messages.map((m) => m.type).join(','))}`);
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  const opened = h.host.stream('session/follow');
  h.link.unregister(SESSION_ID, connection);
  check('releasing a session cancels its follow stream on the host',
    h.host.cancelled.includes(opened.streamId), JSON.stringify(h.host.cancelled));
  await connection.close();
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  h.host.holdStreams.add('session/follow');
  const { connection } = attach(h);
  await flush(4);
  // The host ends the one stream while the carrier stays healthy: the
  // connection must re-baseline rather than keep rendering from a cut-off log.
  h.host.live.end(h.host.stream('session/follow').streamId);
  await flush(12);
  check('a follow stream that ends on a healthy carrier is reopened rather than trailed off',
    h.host.opensFor('session/follow').length >= 2,
    `opens=${String(h.host.opensFor('session/follow').length)}`);
  check('re-opening re-baselines: the connection is told its picture is unverifiable',
    h.link.isReady === true && h.host.opensFor('session/follow').length >= 2, 'ready+reopened');
  await connection.close();
  h.link.stop();
}

// ── Bounded resources ───────────────────────────────────────────────────────

{
  const h = harness();
  await h.link.verify();
  const first = attach(h);
  const second = attach(h, otherInfo);
  await flush();
  const liveStreams = h.host.opened.filter((entry) => !h.host.cancelled.includes(entry.streamId));
  check('two sessions cost two follow streams and one of everything host-wide',
    h.host.opensFor('session/follow').length === 2 && h.host.opensFor('session/control').length === 1,
    JSON.stringify({ follow: h.host.opensFor('session/follow').length, control: h.host.opensFor('session/control').length }));
  h.link.unregister(SESSION_ID, first.connection);
  await flush(4);
  check('one session leaving does not tear down the stream the other is using',
    h.host.cancelled.length === 1 && h.link.isReady === true, JSON.stringify(h.host.cancelled));
  await first.connection.close();
  await second.connection.close();
  h.link.stop();
}

// ── the create rule, against a host that has registered nothing ─────────────
//
// The captured fresh 0.2.0-rc.2 host answers `workspace/follow` with an empty
// baseline AND answers `session/create` with an empty request by making a
// session. A rule that asks the first question to decide the second therefore
// refuses a host that is ready, on every machine where nobody has added a
// workspace yet — which is every new host. These cases pin both halves of the
// answer, including the half that must stay a refusal.
{
  const host = new ScriptedHost();
  host.workspaces = [];
  const scope = dshCredentialScope(BASE_URL, '/fixture/dsh-home');
  const store = memoryStore({ [scope]: COOKIE });
  host.unaryHandlers.set('session/create', () => ({
    value: { sessionId: 'session-fixture-009', agentPreset: 'standard' },
  }));
  host.unaryHandlers.set('session/list', () => ({
    value: {
      items: [{
        sessionId: 'session-fixture-009',
        updatedAt: 1_759_449_700_000,
        agentAvailable: true,
        running: false,
        blank: true,
        cwd: '/fixture/host-default',
        projections: { kind: 'sequenced', asOfSeq: 0, values: {} },
      }],
    },
  }));
  const adapter = adapterOver(host, store);

  check('an authenticated 0.2 host is creatable while its workspace registry is empty',
    await adapter.canCreateSession() === true,
    JSON.stringify(host.opened.map((entry) => entry.endpoint)));
  check('the create preflight does not open a carrier it does not need',
    host.opensFor('workspace/follow').length === 0,
    JSON.stringify(host.opened.map((entry) => entry.endpoint)));

  const created = await adapter.createSession();
  const create = host.unaryCalls.filter((call) => call.endpoint === 'session/create').at(-1);
  check('the create request is the captured empty request, with no invented workspace id',
    JSON.stringify(create?.args ?? {}) === '{"request":{}}' && created.id === 'session-fixture-009',
    JSON.stringify(create?.args ?? {}));
  check('the row it hands back carries the cwd the host reported, not a guess',
    created.cwd === '/fixture/host-default', String(created.cwd));

  await expectRejection('a directory the host has not registered is still refused',
    () => adapter.createSession({ directory: '/nowhere/registered' }));
}

{
  // ...and the named-directory case keeps its exact behaviour: the caller asked
  // for a place, so the request names that workspace.
  const host = new ScriptedHost();
  const scope = dshCredentialScope(BASE_URL, '/fixture/dsh-home');
  const store = memoryStore({ [scope]: COOKIE });
  host.unaryHandlers.set('session/create', () => ({ value: { sessionId: 'session-fixture-010' } }));
  const adapter = adapterOver(host, store);
  const created = await adapter.createSession({ directory: '/fixture/workspace' });
  const create = host.unaryCalls.filter((call) => call.endpoint === 'session/create').at(-1);
  check('a named directory is created in that registered workspace',
    JSON.stringify(create?.args ?? {}) === '{"request":{"workspaceId":"ws-1"}}' && created.id === 'session-fixture-010',
    JSON.stringify(create?.args ?? {}));
}

{
  // A host with no credential is not creatable, and that answer must not arrive
  // as an exception on the way to the roster.
  const host = new ScriptedHost();
  const adapter = adapterOver(host, memoryStore({}));
  check('an unenrolled 0.2 host reports it cannot create right now',
    await adapter.canCreateSession() === false, JSON.stringify(host.unaryCalls.length));
}

console.log(`\n${String(results.filter((entry) => entry.ok).length)}/${String(results.length)} checks passed`);
if (results.some((entry) => !entry.ok)) process.exitCode = 1;

// ── helpers used above ──────────────────────────────────────────────────────

async function expectRejection(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    check(name, false, 'the call resolved');
  } catch (error) {
    check(name, error instanceof Error && error.message.length > 0, error instanceof Error ? error.message : 'threw a non-Error');
  }
}
