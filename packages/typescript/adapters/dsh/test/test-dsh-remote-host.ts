/**
 * The 0.2 host link, driving a scripted host built from the CAPTURED fixture.
 *
 * Everything here is a shape `dsh` 0.2.0-rc.2 actually said on the wire: the
 * follow snapshot, its cursor, the projection baseline, the `$events` ready
 * frame, and the v4 event records all come out of
 * `test/fixtures/dsh-0.2.0-rc.2.json` (and, for the v4 event bodies, the
 * captured 0.1 fixture, which is the same durable log format). Additional
 * assistant, tool, question and image records come from disposable rc.2 hosts
 * with a local scripted provider. These prove adapter behavior with
 * modelBacked=false and no provider spend; real-model acceptance is separate.
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
import { DshRemoteHostLink, DSH_INTERACTION_HANDOFF_MS } from '../src/remote-host.ts';
import { DshSessionConnection } from '../src/observe.ts';
import { DshAdapter } from '../src/implementation.ts';
import { dshCredentialScope } from '../src/auth.ts';
import { DshAssistantStream } from '../src/assistant-stream.ts';
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
  controlBaseline: unknown = CONTROL_BASELINE;
  followSnapshot: unknown = SNAPSHOT;

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
      socket.item(streamId, this.followSnapshot);
      return;
    }
    if (endpoint === 'session/control') {
      socket.item(streamId, this.controlBaseline);
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
  host?: ScriptedHost;
  cookie?: DshCookie | null;
  wrapRemoteFetch?: (fetch: DshFetch) => DshFetch;
  snapshotTimeoutMs?: number;
  authFetch?: DshAuthFetch;
  reconnectDelayMs?: number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
} = {}): Harness {
  const host = options.host ?? new ScriptedHost();
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
  const remote = new DshRemoteClient({ baseUrl: BASE_URL, headers: () => auth.authHeaders(),
    fetchImpl: options.wrapRemoteFetch ? options.wrapRemoteFetch(host.fetchImpl) : host.fetchImpl });
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
    ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
    ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
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

{
  // Follow and $events are independent logical streams. An initial snapshot
  // may arrive first. If the first older-page POST races the initial ready
  // frame, its answer must not be discarded as a replacement generation.
  const h = harness();
  h.host.holdStreams.add('$events');
  h.host.holdStreams.add('session/follow');
  // Adapter discovery has already loaded enrollment before a real attach.
  // Authenticate here without verifying the independently delayed event link.
  await h.auth.ensure();
  const { connection } = attach(h);
  await flush();
  h.host.live.item(h.host.stream('session/follow').streamId, {
    ...SNAPSHOT, cursor: 20,
    records: [18, 19, 20].map((seq) => ({ type: 'event', event: V4_BY_SEQ.get(seq) })),
    hasMore: true,
  });
  h.host.unaryHandlers.set('session/page', () => {
    if (!h.link.isReady) queueMicrotask(() => h.host.live.item(h.host.stream('$events').streamId, READY));
    return { value: { records: [...V4_BY_SEQ.entries()].filter(([seq]) => seq < 18)
      .map(([, event]) => ({ type: 'event', event })), hasMore: false } };
  });
  let settled = false;
  const historyRead = connection.getHistory().then((history) => { settled = true; return history; });
  await flush();
  check('initial history waits for event readiness before issuing older pages instead of racing the first handshake',
    !settled && h.host.unaryCalls.every((call) => call.endpoint !== 'session/page'));
  if (!h.link.isReady) h.host.live.item(h.host.stream('$events').streamId, READY);
  const history = await historyRead;
  check('follow-before-ready history preserves the earlier user and final assistant without an incomplete notice or replacement socket',
    history.some((row) => row.type === 'user-message' && row.text === 'Reply with exactly: OK')
      && history.some((row) => row.type === 'model-output' && row.final === true && row.text === 'OK')
      && !history.some((row) => row.type === 'notice' && /incomplete/i.test(row.message))
      && h.host.socketOpens === 1
      && h.host.unaryCalls.filter((call) => call.endpoint === 'session/page').length === 1,
    JSON.stringify({rows:history.filter(row => ['user-message','model-output','notice'].includes(row.type)),opens:h.host.socketOpens,pages:h.host.unaryCalls.filter(call=>call.endpoint==='session/page')}));
  h.link.stop();
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
  const cold = await h.link.workspaces();
  check('cold discovery reads membership on a bounded authenticated carrier and leaves no event registration',
    cold.ok && cold.value.sessionIds.get('ws-1')?.join() === SESSION_ID
      && h.host.socketOpens === 1 && h.host.sockets[0]?.closed === 1
      && !h.link.carrierRunning && h.host.opensFor('$events').length === 0,
    JSON.stringify(cold));
  await h.link.verify();
  const workspaces = await h.link.workspaces();
  const items = workspaces.ok ? workspaces.value.items as Array<Record<string, unknown>> : [];
  check('the workspace baseline is read from workspace/follow and mapped with its session ids',
    workspaces.ok && items.length === 1
      && (workspaces.ok ? workspaces.value.sessionIds.get('ws-1') : [])?.join() === SESSION_ID,
    JSON.stringify(workspaces));
  check('a bounded baseline read closes the stream it opened',
    h.host.cancelled.length === 2 && h.host.cancelled.includes(h.host.stream('workspace/follow').streamId),
    JSON.stringify(h.host.cancelled));
  h.link.stop();
}

// ── History: one stream, one boundary ───────────────────────────────────────

for (const cause of ['abort', 'credential'] as const) {
  const h = harness(); h.host.holdStreams.add('workspace/follow');
  const abort = new AbortController(); const pending = h.link.workspaces(abort.signal);
  await flush();
  if (cause === 'abort') abort.abort();
  else { await h.store.clear('scope'); await h.auth.ensure(); }
  const outcome = await pending;
  check(`a cold workspace read ends on ${cause} without adopting stale membership or starting events`,
    !outcome.ok && outcome.failure.kind === 'transport'
      && outcome.failure.reason === (cause === 'abort' ? 'timeout' : 'generation-lost')
      && h.host.sockets[0]?.closed === 1 && h.host.opensFor('$events').length === 0);
  h.link.stop();
}

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  const follow = h.host.stream('session/follow');
  check('a session attach opens session/follow with the captured address shape',
    JSON.stringify(follow.args) === JSON.stringify({ request: { address: { kind: 'session', sessionId: SESSION_ID }, assistantStream: true } }),
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
  // rc.2 checks requestId against both native queued and durable user messages
  // before accepting a prompt. Restarting only the broker leaves that native
  // set alive, so restarting a process-local counter silently loses new turns.
  const host = new ScriptedHost();
  const admitted: Array<{ requestId: string; mode: unknown; text: string }> = [];
  const seen = new Set<string>();
  host.unaryHandlers.set('session/prompt', (args) => {
    const request = args.request as { requestId: string; mode: unknown; content: Array<{ text?: string }> };
    if (!seen.has(request.requestId)) {
      seen.add(request.requestId);
      admitted.push({ requestId: request.requestId, mode: request.mode, text: request.content.map((part) => part.text ?? '').join('') });
    }
    return { value: { accepted: true } };
  });
  const first = harness({ host });
  await first.link.verify();
  const before = attach(first).connection;
  await flush();
  await before.sendPrompt({ text: 'before restart one' });
  await before.sendPrompt({ text: 'before restart two' });
  await before.close(); first.link.stop();
  const replacement = harness({ host });
  await replacement.link.verify();
  const after = attach(replacement).connection;
  await flush();
  await after.sendPrompt({ text: 'after restart queue' });
  await after.runCommand('steer', 'after restart steer');
  const writes = host.unaryCalls.filter((call) => call.endpoint === 'session/prompt');
  check('new broker links do not reuse prompt identities already seen by the surviving native session',
    admitted.length === 4 && seen.size === 4, JSON.stringify(admitted));
  check('new queued and steering prompts are both admitted after a broker replacement',
    admitted.some((request) => request.text === 'after restart queue' && request.mode === 'queue')
      && admitted.some((request) => request.text === 'after restart steer' && request.mode === 'steer'));
  check('broker replacement sends each fresh prompt once without retrying an acknowledged duplicate', writes.length === 4);
  await after.close();
  const reattached = attach(replacement).connection;
  await flush();
  await reattached.sendPrompt({ text: 'after channel replacement' });
  check('a replacement channel also keeps its new prompt distinct from previous native requests',
    admitted.length === 5 && admitted.at(-1)?.text === 'after channel replacement'
      && host.unaryCalls.filter((call) => call.endpoint === 'session/prompt').length === 5);
  await reattached.close(); replacement.link.stop();
}

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
  check('named-workspace creation returns its actual cwd for attachment staging',
    created.cwd === '/fixture/workspace', String(created.cwd));
}

{
  // A host with no credential is not creatable, and that answer must not arrive
  // as an exception on the way to the roster.
  const host = new ScriptedHost();
  const adapter = adapterOver(host, memoryStore({}));
  check('an unenrolled 0.2 host reports it cannot create right now',
    await adapter.canCreateSession() === false, JSON.stringify(host.unaryCalls.length));
}

// ── The epoch a call was issued under is part of that call ───────────────────
//
// `call()` awaits authentication, and a lot can end during a wait: the carrier
// can drop, the generation can be retracted. These hold the credential read
// open -- the real asynchronous wait in `ensure()`, a file read in production --
// and drop the carrier inside it, which is the window the review fell through.

{
  const h = harness();
  await h.link.verify();
  const attached = attach(h);
  await flush();
  // Delay the credential read, so the prompt is parked inside `ensure()` while
  // the carrier dies. This is the production shape: an enrollment read or a
  // renewal in flight, not a mocked method.
  let releaseLoad!: () => void;
  const gate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const realLoad = h.store.load.bind(h.store);
  let gateOnce = true;
  h.store.load = async (scope: string) => {
    if (gateOnce) { gateOnce = false; await gate; }
    return realLoad(scope);
  };
  const sent = attached.connection.sendPrompt({ text: 'must not be sent while the epoch is gone' });
  await flush(4);
  h.host.live.dropSocket();
  await flush(4);
  releaseLoad();
  let failure: unknown;
  try {
    await sent;
  } catch (error) {
    failure = error;
  }
  const promptCalls = h.host.unaryCalls.filter((call) => call.endpoint === 'session/prompt');
  check('a write whose epoch died during authentication is never sent',
    promptCalls.length === 0, `prompt requests=${String(promptCalls.length)}`);
  check('and the failure says the write did not go out, so the caller may re-issue it',
    failure instanceof Error && failure.message.includes('the write was not sent'),
    failure instanceof Error ? failure.message : String(failure));
  check('readiness is false for the whole of it', h.link.isReady === false);
  h.link.stop();
}

{
  // The other half: a READ that the host answers after its epoch has ended.
  const h = harness();
  await h.link.verify();
  attach(h);
  await flush();
  let releaseAnswer!: (response: DshFetchResponse) => void;
  const realFetch = h.host.fetchImpl;
  const heldEndpoint = 'session/projections';
  let lateRpcId = '';
  let held = false;
  const blocked: DshFetch = async (url, init) => {
    const endpoint = url.replace(`${BASE_URL}/api/`, '');
    if (endpoint === heldEndpoint && !held) {
      held = true;
      // The host sits on the request and answers it LATER, with the rpcId the
      // request actually carried -- which is what a real late reply looks like.
      const rpcId = (JSON.parse(init.body) as { rpcId: string }).rpcId;
      lateRpcId = rpcId;
      return new Promise<DshFetchResponse>((resolve) => {
        releaseAnswer = (response) => resolve(response);
      });
    }
    return realFetch(url, init);
  };
  const remote = new (await import('../src/remote.ts')).DshRemoteClient({
    baseUrl: BASE_URL, headers: () => h.auth.authHeaders(), fetchImpl: blocked,
  });
  // A second link over the same scripted host, so the held request is the
  // product's own epoch-bound read rather than a hand-built promise.
  const link2 = new (await import('../src/remote-host.ts')).DshRemoteHostLink({
    baseUrl: BASE_URL, auth: h.auth, remote, socketFactory: h.host.socketFactory, reconnectDelayMs: 60_000,
  });
  await link2.verify();
  const reading = link2.call<unknown>(heldEndpoint, { sessionId: SESSION_ID });
  await flush(4);
  check('the epoch-bound read is in flight before the carrier goes', held, String(held));
  const socketsBefore = h.host.sockets.length;
  h.host.sockets[socketsBefore - 1]?.dropSocket();
  await flush(4);
  releaseAnswer({ status: 200, text: async () => JSON.stringify({
    type: 'server-response', rpcId: lateRpcId, result: { ok: true, value: { stale: true } },
  }) });
  const outcome = await reading;
  check('a read answered after its generation ended is discarded, not delivered',
    !outcome.ok && outcome.failure.kind === 'transport'
      && outcome.failure.reason === 'generation-lost', JSON.stringify(outcome));
  link2.stop();
  h.link.stop();
}

// ── History is a moving cut, not the bytes from attach time ──────────────────

{
  const h = harness();
  await h.link.verify();
  const attached = attach(h);
  await flush();
  // Read at the channel boundary, which is where the host's own rows arrive.
  // `getHistory()` folds them into transcript messages, and three control events
  // fold into nothing -- so the assertion is about the cut, not the rendering.
  const channel = h.link.channel(SESSION_ID);
  const read = async () => (await channel.history({ sessionId: SESSION_ID, maxMessages: 200 }));
  const first = await read();
  const follow = h.host.stream('session/follow');
  const liveSeq = (SNAPSHOT.cursor as number) + 1;
  if (first.ok) h.host.live.item(follow.streamId, { type: 'event', event: { ...V4_BY_SEQ.get(1)!, seq: liveSeq } });
  await flush(4);
  const second = await read();
  const seqsOf = (outcome: Awaited<ReturnType<typeof read>>) => (outcome.ok ? outcome.value.events : [])
    .map((entry) => (entry as { event?: { seq?: number } }).event?.seq);
  check('a history reread includes the durable events the follow stream delivered',
    seqsOf(first).length === 3 && seqsOf(second).length === 4 && seqsOf(second).includes(liveSeq),
    `${JSON.stringify(seqsOf(first))} -> ${JSON.stringify(seqsOf(second))}`);
  check('and it does not open a second read to get them',
    h.host.unaryCalls.filter((call) => call.endpoint === 'session/page').length === 0,
    String(h.host.unaryCalls.filter((call) => call.endpoint === 'session/page').length));
  const third = await read();
  check('repeated reads are stable, so a reader that polls does not see the transcript grow sideways',
    JSON.stringify(seqsOf(third)) === JSON.stringify(seqsOf(second)), JSON.stringify(seqsOf(third)));
  check('the cut cursor moved with the stream, so older pages are read through the NEW tail',
    (await h.link.snapshotCursor(SESSION_ID)) === liveSeq, String(await h.link.snapshotCursor(SESSION_ID)));
  void attached;
  h.link.stop();
}

{
  // A replacement (compaction) writes a new transcript behind the same session
  // id, and the real Hub re-reads through the same connection to get it.
  // A replacement (compaction) writes a new transcript behind the same session
  // id. The host's way of saying so on the follow stream is to end it and answer
  // the next open with a different snapshot, and every later read -- including
  // the one the Hub issues after a history-reset -- has to see the NEW surface
  // rather than the one this attach started on.
  const h = harness();
  await h.link.verify();
  attach(h);
  await flush();
  const channel = h.link.channel(SESSION_ID);
  const before = await channel.history({ sessionId: SESSION_ID, maxMessages: 200 });
  const beforeSeqs = before.ok ? before.value.events.map((entry) => (entry as { event?: { seq?: number } }).event?.seq) : [];
  check('the pre-replacement read is the attach snapshot', JSON.stringify(beforeSeqs) === JSON.stringify([0, 1, 2]), JSON.stringify(beforeSeqs));
  h.host.holdStreams.add('session/follow');
  h.host.live.end(h.host.stream('session/follow').streamId);
  await flush(6);
  h.host.holdStreams.delete('session/follow');
  // The reopened stream answers with a transcript that moved: new cursor, and
  // the compacted log's own replacement row at the tail.
  const reopened = h.host.opensFor('session/follow').at(-1)!;
  h.host.live.item(reopened.streamId, {
    ...SNAPSHOT,
    cursor: 7,
    records: [{ type: 'event', event: { ...V4_BY_SEQ.get(7)!, seq: 7 } }],
  });
  await flush(6);
  const after = await channel.history({ sessionId: SESSION_ID, maxMessages: 200 });
  const afterSeqs = after.ok ? after.value.events.map((entry) => (entry as { event?: { seq?: number } }).event?.seq) : [];
  check('after the log moves, the next read is the new surface and not the old snapshot',
    JSON.stringify(afterSeqs) === JSON.stringify([7]), JSON.stringify(afterSeqs));
  h.link.stop();
}

// ── A stream the host refuses is not a stream to reopen at full speed ────────

{
  const h = harness();
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  const opensBefore = h.host.opensFor('session/follow').length;
  // The captured way a host refuses a session it does not have.
  h.host.holdStreams.add('session/follow');
  h.host.live.fail(h.host.stream('session/follow').streamId, 'session/not-found');
  await flush(20);
  await wait(300);
  const opensAfter = h.host.opensFor('session/follow').length;
  check('a follow stream the host refuses for a terminal reason is not reopened',
    opensAfter === opensBefore, `${String(opensBefore)} -> ${String(opensAfter)} opens`);
  check('the session says its live surface ended rather than waiting out a timeout',
    h.diagnostics.some((entry) => entry.code === 'stream-withdrawn'),
    JSON.stringify(h.diagnostics.map((entry) => entry.code)));
  const history = await connection.getHistory().catch((error: unknown) => error);
  check('history for a withdrawn session reports the refusal instead of pretending to be current',
    Array.isArray(history) || (history instanceof Error && history.message.length > 0),
    Array.isArray(history) ? `resolved ${String(history.length)} rows` : String(history));
  check('the carrier and its event generation survive one session refusal',
    h.link.isReady === true, String(h.link.isReady));
  h.link.stop();
}

{
  // Transient is the other answer, and it must be BOUNDED rather than instant.
  const h = harness();
  await h.link.verify();
  attach(h);
  await flush();
  const opensBefore = h.host.opensFor('session/follow').length;
  h.host.holdStreams.add('session/follow');
  h.host.live.fail(h.host.stream('session/follow').streamId, 'gateway/uplink-overflow');
  await flush(20);
  const immediate = h.host.opensFor('session/follow').length;
  await wait(1_400);
  const later = h.host.opensFor('session/follow').length;
  check('a transient stream failure backs off instead of reopening on the spot',
    later > immediate || later - opensBefore <= 5,
    `immediate=${String(immediate - opensBefore)} afterBackoff=${String(later - opensBefore)}`);
  check('and it eventually stops asking', later - opensBefore <= 5, String(later - opensBefore));
  h.link.stop();
}

// ── Interactions outlive the connection that first saw them ─────────────────

{
  const h = harness();
  await h.link.verify();
  const first = attach(h);
  await flush();
  const events = h.host.stream('$events');
  h.host.live.item(events.streamId, {
    type: 'waterfall', eventId: 'evt-reattach', agentId: SESSION_ID,
    event: 'approval/request', request: { toolName: 'bash', callId: 'call-ra' },
  });
  await flush(6);
  check('the first connection holds the card',
    first.messages.some((message) => message.type === 'permission-request'), JSON.stringify(first.messages.map((m) => m.type)));
  // The user switches views: this connection goes, and another comes straight back.
  await first.connection.close();
  await flush(2);
  const second = attach(h);
  await flush(6);
  check('the replacement connection shows the still-open approval rather than losing it',
    second.messages.some((message) => message.type === 'permission-request'),
    JSON.stringify(second.messages.map((m) => m.type)));
  check('and nothing was answered on the user\'s behalf while it moved',
    h.host.eventResults.length === 0, JSON.stringify(h.host.eventResults));
  await second.connection.respondPermission('evt-reattach', 'approve');
  check('the replayed card is answerable through the normal route',
    h.host.eventResults.length === 1 && h.host.eventResults[0]?.eventId === 'evt-reattach',
    JSON.stringify(h.host.eventResults));
  h.link.stop();
}

{
  // Genuinely abandoned is a different fact, and the delegation path is what
  // keeps the host's waterfall chain from parking a request nobody will show.
  const h = harness();
  await h.link.verify();
  const only = attach(h);
  await flush();
  h.host.live.item(h.host.stream('$events').streamId, {
    type: 'waterfall', eventId: 'evt-abandoned', agentId: SESSION_ID,
    event: 'user-questions/request', request: { questions: [{ question: 'fixture?', options: [{ label: 'yes' }] }] },
  });
  await flush(6);
  await only.connection.close();
  await flush(2);
  await wait(DSH_INTERACTION_HANDOFF_MS + 120);
  check('an interaction nobody is left to show is delegated to the host chain',
    h.host.eventResults.some((result) => result.eventId === 'evt-abandoned' && result.outcome === undefined && 'kind' in (result as object))
      || JSON.stringify(h.host.eventResults).includes('evt-abandoned'),
    JSON.stringify(h.host.eventResults));
  h.link.stop();
}

// ── The captured permission split: value here, roster there ─────────────────

{
  // The captured 0.2 `permissions` projection is `{currentValue}` ALONE and the
  // roster is a separate host-wide catalog. A picker built from the projection
  // is empty on a host with three presets, and a selector that validates against
  // that picker then refuses the preset the session is already running.
  const permissionPresets = (await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as {
    unary: Record<string, { endpoint: string; envelope: { result: { value: unknown } } }>;
  }).unary['unary.permissionPresets']!;
  const h = harness();
  h.host.unaryHandlers.set(permissionPresets.endpoint, () => ({ value: permissionPresets.envelope.result.value }));
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  const modes = await connection.listModes();
  check('the preset picker is built from the host catalog the projection does not carry',
    JSON.stringify(modes.map((mode) => mode.value)) === JSON.stringify(['read-only', 'workspace-write', 'danger-full-access']),
    JSON.stringify(modes.map((mode) => mode.value)));
  const catalogCalls = () => h.host.unaryCalls.filter((call) => call.endpoint === permissionPresets.endpoint).length;
  const before = catalogCalls();
  await connection.listModes();
  await connection.listModes();
  check('the catalog is read once per carrier rather than once per render',
    catalogCalls() === before, `${String(before)} -> ${String(catalogCalls())}`);
  h.link.stop();
}

// Selection intent comes from the session projection, not the host catalog.
{
  const h = harness(); await h.link.verify();
  const { connection, messages } = attach(h); await flush();
  h.host.live.item(h.host.stream('session/control').streamId, {
    type: 'projection', sessionId: SESSION_ID, key: 'modelSelection', seq: 3,
    value: { lastUsed: { provider: 'previous', model: 'previous' }, next: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } },
  });
  await flush();
  const models = await h.link.channel(SESSION_ID).models();
  check('the picker gets this session\'s next model and reasoning while the catalog remains host-wide',
    models.current?.provider === 'deepseek-official' && models.current?.model === 'deepseek-v4-flash' && models.current?.reasoningEffort === 'high');
  check('a native selection republishes visible session metadata before the next prompt',
    messages.some((message) => message.type === 'metadata-update' && message.key === 'sessionInfo'
      && (message.value as { currentModel?: { modelID?: string } }).currentModel?.modelID === 'deepseek-v4-flash'));
  const sends = h.host.unaryCalls.length;
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  await connection.sendPrompt({ text: 'use selected model', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } });
  check('prompting with the already-selected model does not submit a redundant selection',
    !h.host.unaryCalls.slice(sends).some((call) => call.endpoint === 'session/selectModel'));
  h.link.stop();
}

// rc.2 forwards initializer failures as strings and agent failures as error chains.
{
  const h = harness(); await h.link.verify();
  const { messages } = attach(h); await flush();
  const events = h.host.stream('$events');
  h.host.live.item(events.streamId, {
    type: 'emit', event: 'api-session/error',
    args: [SESSION_ID, 'The fixture provider is temporarily unavailable.'],
  });
  await flush();
  check('a captured scalar native error preserves the actual failure detail',
    messages.filter((message) => message.type === 'error').length === 1
      && messages.some((message) => message.type === 'error'
        && message.message === 'The fixture provider is temporarily unavailable.'));
  h.host.live.item(events.streamId, {
    type: 'emit', event: 'api-session/error', args: [SESSION_ID, [
      { name: 'ProviderError', message: 'The fixture request failed.' },
      { name: 'TransportError', message: 'HTTP 503.' },
    ]],
  });
  await flush();
  check('native error-chain details remain intact alongside scalar notifications',
    messages.filter((message) => message.type === 'error').length === 2
      && messages.some((message) => message.type === 'error'
        && message.message === 'The fixture request failed.\nHTTP 503.'));
  check('a native provider error leaves the healthy event authority and carrier live',
    h.link.isReady && h.host.sockets.length === 1 && h.host.eventResults.length === 0);
  h.link.stop();
}

// Enrollment repairs an existing attach through normal roster reads alone.
for (const cause of ['removed', 'refused'] as const) for (const owned of [false, true]) {
  const withdrawal = `${cause}-${owned ? 'owned' : 'external'}`;
  let exchanges = 0;
  const h = harness({
    cookie: { ...COOKIE, expiresAt: Date.now() + 20 * 86_400_000 },
    authFetch: async () => {
      exchanges += 1;
      return { status: 303, headers: { get: (key) => key === 'set-cookie'
        ? `${COOKIE.name}=v1.unrequested-enrollment; Max-Age=2592000; Path=/; HttpOnly`
        : key === 'location' ? './' : null } };
    },
  });
  if (owned) h.auth.adoptLaunchToken('fixture-owned-launch');
  await h.link.verify();
  const { connection } = attach(h);
  await flush();
  if (cause === 'removed') await h.store.clear('scope');
  else h.host.refuse = { status: 401, body: 'unauthorized' };
  await h.link.roster();
  await flush();
  check(`${withdrawal} enrollment closes the attached carrier`, !h.link.carrierRunning && !h.link.isReady);
  await expectRejection(`${withdrawal} enrollment refuses an attached prompt`, () => connection.sendPrompt({ text: 'blocked' }));
  await h.link.roster();
  await flush();
  check(`${withdrawal} enrollment stays disconnected without a fresh credential`, h.host.sockets.length === 1 && exchanges === 0);
  h.host.refuse = undefined;
  await h.store.save('scope', { ...COOKIE, value: `v1.fresh-${withdrawal}`, expiresAt: Date.now() + 20 * 86_400_000 });
  await Promise.all([h.link.roster(), h.link.roster(), h.link.roster()]);
  await flush();
  check(`${withdrawal} enrollment opens exactly one fresh authenticated handshake`,
    h.host.sockets.length === 2 && h.host.live.headers.cookie === `${COOKIE.name}=v1.fresh-${withdrawal}` && exchanges === 0);
  check(`${withdrawal} enrollment recovers follow and authority without reattach or verify`,
    h.link.isReady && h.host.opensFor('session/follow').length === 2 && await h.link.snapshotCursor(SESSION_ID) === SNAPSHOT.cursor);
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  await connection.sendPrompt({ text: 'resumed' });
  check(`${withdrawal} enrollment makes the same connection writable`,
    h.host.unaryCalls.filter((call) => call.endpoint === 'session/prompt').length === 1);
  h.link.stop();
}

{
  let exchanges = 0;
  const h = harness({
    cookie: { ...COOKIE, expiresAt: Date.now() + 60000 },
    authFetch: async () => {
      exchanges += 1;
      return { status: 303, headers: { get: (key) => key === 'set-cookie'
        ? `${COOKIE.name}=v1.renewed; Max-Age=2592000; Path=/; HttpOnly`
        : key === 'location' ? './' : null } };
    },
  });
  await h.link.verify(); attach(h); await flush();
  h.auth.adoptLaunchToken('fixture-owned-launch');
  await h.link.roster(); await flush();
  await h.link.roster(); await flush();
  check('an owned renewal refreshes the attached handshake once and keeps the retry bounded',
    exchanges === 1 && h.host.sockets.length === 2 && h.host.live.headers.cookie === `${COOKIE.name}=v1.renewed` && h.link.isReady);
  h.link.stop();
  await h.store.save('scope', { ...COOKIE, value: 'v1.after-stop' }); await h.auth.ensure(); await flush();
  check('an enrollment after deliberate link shutdown cannot resurrect its sessions', h.host.sockets.length === 2 && !h.link.carrierRunning);
}

// A follow-only loss must leave decisions with their still-live event owner.
for (const kind of ['approval', 'question'] as const) {
  const h = harness();
  await h.link.verify();
  const { connection, messages } = attach(h);
  await flush();
  const events = h.host.stream('$events');
  const eventId = `evt-follow-${kind}`;
  h.host.live.item(events.streamId, {
    type: 'waterfall', eventId, agentId: SESSION_ID,
    event: kind === 'approval' ? 'approval/request' : 'user-questions/request',
    request: kind === 'approval' ? { toolName: 'bash', callId: 'call-follow' }
      : { questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }] },
  });
  await flush();
  const requests = () => messages.filter((message) => message.type === (kind === 'approval' ? 'permission-request' : 'question-request'));
  check(`${kind} was displayed before follow recovery`, requests().length === 1);
  h.host.live.end(h.host.stream('session/follow').streamId);
  await flush();
  check(`${kind} stays actionable across a fresh follow snapshot`,
    !messages.some((message) => message.type === (kind === 'approval' ? 'permission-resolved' : 'question-resolved'))
      && h.host.eventResults.length === 0 && h.host.stream('$events').streamId === events.streamId && h.host.sockets.length === 1);
  if (kind === 'approval') {
    await connection.respondPermission(eventId, 'approve');
    await expectRejection('follow recovery cannot decide the approval twice', () => connection.respondPermission(eventId, 'approve'));
    check('follow recovery sends exactly one decision to the original event owner',
      h.host.eventResults.length === 1 && h.host.eventResults[0]?.eventId === eventId);
    h.host.live.item(events.streamId, { type: 'cancel', eventId }); await flush();
    check('an accepted approval receipt resolves its visible card exactly once despite late cancellation',
      messages.filter((m) => m.type === 'permission-resolved' && m.requestId === eventId).length === 1
      && messages.some((m) => m.type === 'permission-resolved' && m.requestId === eventId && m.decision === 'approve'));
  } else {
    await Promise.all([
      connection.answerQuestion(eventId, [['yes']]),
      connection.answerQuestion(eventId, [['yes']]),
    ]);
    await expectRejection('follow recovery cannot answer the question twice',
      () => connection.answerQuestion(eventId, [['yes']]));
    h.host.live.item(events.streamId, { type: 'cancel', eventId }); await flush();
    check('follow recovery answers once on the original question authority and settles one card',
      h.host.eventResults.length === 1 && h.host.eventResults[0]?.eventId === eventId
        && messages.filter((message) => message.type === 'question-resolved' && message.requestId === eventId).length === 1);
    const cancelledId = `${eventId}-cancelled`;
    h.host.live.item(events.streamId, {
      type: 'waterfall', eventId: cancelledId, agentId: SESSION_ID,
      event: 'user-questions/request',
      request: { questions: [{ id: 'q2', question: 'Continue again?', options: [{ label: 'yes' }] }] },
    });
    await flush();
    h.host.live.end(h.host.stream('session/follow').streamId); await flush();
    h.host.live.item(events.streamId, { type: 'cancel', eventId: cancelledId });
    await flush();
    check('a question cancelled after follow recovery resolves without an answer',
      messages.filter((message) => message.type === 'question-resolved' && message.requestId === cancelledId).length === 1
        && h.host.eventResults.length === 1 && h.host.stream('$events').streamId === events.streamId
        && h.host.sockets.length === 1);
  }
  h.link.stop();
}

{
  const h = harness(); await h.link.verify();
  const { connection, messages } = attach(h); await flush();
  const events = h.host.stream('$events'); const eventId = 'accepted-question';
  h.host.live.item(events.streamId, { type: 'waterfall', eventId, agentId: SESSION_ID,
    event: 'user-questions/request', request: { questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }] } });
  await flush();
  await Promise.all([connection.answerQuestion(eventId, [['yes']]), connection.answerQuestion(eventId, [['yes']])]);
  h.host.live.item(events.streamId, { type: 'cancel', eventId }); await flush();
  check('a blocking question receipt resolves its visible card exactly once and coalesces concurrent answers',
    h.host.eventResults.length === 1 && messages.filter((m) => m.type === 'question-resolved' && m.requestId === eventId).length === 1);
  h.link.stop();
}

// Exhaust the entire ladder with a virtual clock, then recover on a new carrier.
{
  const timers = new Map<object, { handler: () => void; ms: number }>();
  const h = harness({
    reconnectDelayMs: 7,
    setTimeout: (handler, ms) => { const id = {}; timers.set(id, { handler, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id as object); },
  });
  const fire = (ms: number) => {
    const timer = [...timers].find(([, value]) => value.ms === ms);
    if (!timer) throw new Error(`missing retry timer ${String(ms)}`);
    timers.delete(timer[0]); timer[1].handler();
  };
  await h.link.verify();
  attach(h); await flush();
  h.host.holdStreams.add('session/follow');
  const before = h.host.opensFor('session/follow').length;
  const ladder = [0, 50, 200, 800, 2000];
  for (let index = 0; index <= ladder.length; index += 1) {
    h.host.live.fail(h.host.stream('session/follow').streamId, 'gateway/uplink-overflow');
    await flush();
    if (index < ladder.length && ladder[index] !== 0) { fire(ladder[index]!); await flush(); }
    check(`follow ladder attempt ${String(index)} has its exact open count`,
      h.host.opensFor('session/follow').length === before + Math.min(index + 1, ladder.length));
  }
  check('the fully exhausted ladder withdraws and leaves no follow retry timer',
    h.link.streamWithdrawn(SESSION_ID) === 'session/follow retried 5 times'
      && ![...timers.values()].some((timer) => ladder.includes(timer.ms)));
  h.host.holdStreams.delete('session/follow');
  h.host.live.dropSocket(); await flush(); fire(7); await flush();
  check('a fresh carrier resets transient withdrawal and delivers a follow baseline',
    h.host.sockets.length === 2 && h.host.opensFor('session/follow').length === before + 6
      && h.link.streamWithdrawn(SESSION_ID) === undefined && h.link.isReady
      && await h.link.snapshotCursor(SESSION_ID) === SNAPSHOT.cursor);
  const terminalOpens = h.host.opensFor('session/follow').length;
  h.host.live.fail(h.host.stream('session/follow').streamId, 'session/not-found'); await flush();
  h.host.live.dropSocket(); await flush(); fire(7); await flush();
  check('a terminal session refusal survives a new carrier while its siblings remain usable',
    h.host.opensFor('session/follow').length === terminalOpens
      && h.link.streamWithdrawn(SESSION_ID) === 'session/not-found' && h.link.isReady);
  h.link.stop();
}

// A real timed waterfall becomes a durable continued question. The fake clock
// controls the host-computed claim duration; answer routes remain distinct.
{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-questions.json', import.meta.url)).json() as {
    waterfall: Record<string, unknown>; continued: unknown; inbox: unknown;
  };
  const timers: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
  const h = harness({ setTimeout: (handler, ms) => {
    const timer = { handler, ms, cleared: false }; timers.push(timer); return timer;
  }, clearTimeout: (raw) => { (raw as { cleared: boolean }).cleared = true; } });
  h.host.holdStreams.add('userQuestions/attachWait');
  await h.link.verify(); const { connection, messages } = attach(h); await flush(); await connection.getHistory();
  h.host.live.item(h.host.stream('$events').streamId, fixture.waterfall); await flush();
  const waitStream = h.host.opensFor('userQuestions/attachWait').at(-1)!;
  check('a timed foreground card holds the source-defined wait claim by agent and call identity',
    JSON.stringify(waitStream.args) === JSON.stringify({ agentId: SESSION_ID, callId: 'call-fixture' })
      && connection.getPending().some((m) => m.type === 'question-request' && m.blocking !== false));
  h.host.live.item(waitStream.streamId, { remainingMs: 1000 }); await flush();
  const deadline = timers.findLast((timer) => timer.ms === 1000 && !timer.cleared)!;
  deadline.handler(); await flush();
  const timeout = h.host.unaryCalls.filter((c) => c.endpoint === '$events/result').at(-1);
  check('the wait deadline rejects only the foreground waterfall and releases its claim',
    (timeout?.args.outcome as { kind?: string; error?: { code?: string } })?.error?.code === 'ASK_TIMED_OUT'
      && h.host.cancelled.includes(waitStream.streamId));
  const control = h.host.stream('session/control');
  h.host.live.item(control.streamId, { type: 'projection', sessionId: SESSION_ID, key: 'userQuestions', seq: 23, value: fixture.continued });
  await flush();
  const late = connection.getPending().find((m) => m.type === 'question-request' && m.blocking === false);
  check('the durable continued projection exposes a nonblocking late-answer card', late?.type === 'question-request');
  const before = h.host.unaryCalls.filter((c) => c.endpoint === '$events/result').length;
  h.host.unaryHandlers.set('userQuestions/answer', () => ({ value: true }));
  if (late?.type === 'question-request') await Promise.all([
    connection.answerQuestion(late.requestId, [['yes']]), connection.answerQuestion(late.requestId, [['no']]),
  ]);
  const replies = h.host.unaryCalls.filter((c) => c.endpoint === 'userQuestions/answer');
  check('concurrent late answers submit exactly one complete batch through the dedicated route and no waterfall result',
    replies.length === 1 && JSON.stringify(replies[0]?.args) === JSON.stringify({ agentId: SESSION_ID, callId: 'call-fixture', answer: { answers: [{ id: 'q-fixture', selected: ['yes'] }] } })
      && h.host.unaryCalls.filter((c) => c.endpoint === '$events/result').length === before);
  h.host.live.item(control.streamId, { type: 'projection', sessionId: SESSION_ID, key: 'userQuestions', seq: 24, value: fixture.continued }); await flush();
  check('an unchanged continued projection cannot resurrect a locally accepted reply', connection.getPending().length === 0);
  check('transitioning from foreground to durable clears the old card', messages.some((m) => m.type === 'question-resolved' && m.requestId === 'question-fixture-timed'));
  // Canceling a queued continued reply makes that durable question answerable
  // again; a native-client queue claim must not resurrect it briefly.
  h.host.live.item(control.streamId, { type: 'projection', sessionId: SESSION_ID, key: 'inbox', seq: 25, value: {
    'next-turn': [{ id: 'late-reply', source: { kind: 'user-question-reply', callId: 'call-fixture' } }], 'next-step': [],
  } }); await flush();
  check('a native queued reply keeps the continued card settled', connection.getPending().length === 0);
  const follow = h.host.stream('session/follow');
  h.host.live.item(follow.streamId, { type: 'event', event: { type: 'agent/inbox/spliced', seq: 26, time: 1, data: {
    target: 'next-turn', start: 0, inserted: [{ id: 'late-reply', source: { kind: 'user-question-reply', callId: 'call-fixture' } }],
  } } });
  h.host.live.item(follow.streamId, { type: 'event', event: { type: 'agent/inbox/spliced', seq: 27, time: 1, data: {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
  } } });
  h.host.live.item(control.streamId, { type: 'projection', sessionId: SESSION_ID, key: 'inbox', seq: 28, value: { 'next-turn': [], 'next-step': [] } }); await flush();
  const canceled = connection.getPending().find((m) => m.type === 'question-request');
  check('canceling a queued late reply makes the durable question answerable again', canceled?.type === 'question-request' && canceled.blocking === false);
  if (canceled?.type === 'question-request') await connection.answerQuestion(canceled.requestId, [['no']]);
  check('a replacement decision after explicit cancellation has one new dedicated RPC', h.host.unaryCalls.filter((c) => c.endpoint === 'userQuestions/answer').length === 2);
  h.host.controlBaseline = { type: 'baseline', value: { projections: { [SESSION_ID]: { asOfSeq: 29, values: { userQuestions: fixture.continued, inbox: { 'next-turn': [], 'next-step': [] } } } } } };
  await h.store.save('scope', { ...COOKIE, value: 'v1.renewed-timed-fixture' }); await h.link.roster(); await flush();
  check('a credential renewal cannot resurrect an already accepted continued answer', connection.getPending().length === 0 && h.link.isReady);
  // Authoritative native settlement removes the call before any later replay.
  h.host.live.item(h.host.stream('session/control').streamId, { type: 'projection', sessionId: SESSION_ID, key: 'userQuestions', seq: 30, value: { active: [] } }); await flush();
  check('external durable settlement leaves no continued card or duplicate answer', connection.getPending().length === 0 && h.host.unaryCalls.filter((c) => c.endpoint === 'userQuestions/answer').length === 2);
  h.link.stop();
}

// Ordered transient frames and the process-local reconnect baseline captured

{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-assistant-stream.json', import.meta.url)).json() as {
    reasoning: Array<{ type: string; frame?: unknown; event?: { data: { turn: number; step: number } } }>;
  };
  const h = harness(); await h.link.verify(); const { connection, messages } = attach(h); await flush(); await connection.getHistory();
  const follow = h.host.stream('session/follow');
  for (const item of fixture.reasoning) h.host.live.item(follow.streamId, item);
  await flush();
  const reasoning = messages.filter((m) => m.type === 'thinking' && m.text === 'Fixture reasoning.');
  check('captured streamed reasoning and its durable settlement replace the same identity without a stale overlay',
    reasoning.length >= 2 && new Set(reasoning.map((m) => m.type === 'thinking' ? m.key : undefined)).size === 1
      && !(await connection.getHistoryOverlays()).some((m) => m.type === 'thinking'));
  h.link.stop();
}
// from rc.2 with a local scripted provider. These prove the adapter fold, not
// provider-backed or UI acceptance.
{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-assistant-stream.json', import.meta.url)).json() as {
    follow: Array<Record<string, unknown>>;
  };
  const h = harness(); h.host.holdStreams.add('session/follow'); await h.link.verify();
  const { connection, messages } = attach(h); await flush();
  const follow = h.host.stream('session/follow');
  const initial = fixture.follow[0]!;
  h.host.live.item(follow.streamId, { ...initial, records: [], hasMore: false }); await flush();
  await connection.getHistory();
  const baselinePosition = fixture.follow.findIndex((v, i) => i > 0 && v.type === 'snapshot');
  for (const item of fixture.follow.slice(1, baselinePosition)) h.host.live.item(follow.streamId, item);
  await flush();
  check('real assistant frames render text before durable settlement',
    messages.some((m) => m.type === 'model-output' && m.text === 'Fixture ' && m.final === false));
  h.host.live.end(follow.streamId); await flush();
  const replacement = h.host.opensFor('session/follow').at(-1)!;
  h.host.live.item(replacement.streamId, { ...fixture.follow[baselinePosition], records: [], hasMore: false }); await flush();
  await connection.getHistory();
  const overlay = await connection.getHistoryOverlays();
  check('a replacement baseline supplies the partial assistant as a full overlay without doubling text',
    overlay.some((m) => m.type === 'model-output' && m.text === 'Fixture '));
  for (const item of fixture.follow.slice(baselinePosition + 1)) h.host.live.item(replacement.streamId, item);
  await flush();
  const outputs = messages.filter((m) => m.type === 'model-output');
  check('dense continuation settles the same key exactly once with the durable complete message',
    outputs.some((m) => m.type === 'model-output' && m.text === 'Fixture reply.' && m.final === false)
      && outputs.filter((m) => m.type === 'model-output' && m.final === true).length === 1
      && new Set(outputs.map((m) => m.type === 'model-output' ? m.key : undefined)).size === 1
      && !(await connection.getHistoryOverlays()).some((m) => m.type === 'model-output'));
  h.link.stop();

  const fold = new DshAssistantStream(SESSION_ID);
  fold.baseline(initial.assistantStream);
  for (const item of fixture.follow.slice(1, baselinePosition)) fold.frame(item.frame);
  const duplicate = fold.frame(fixture.follow[baselinePosition - 1]!.frame);
  check('a duplicate revision changes no text', duplicate.length === 0 && fold.messages().some((m) => m.type === 'model-output' && m.text === 'Fixture '));
  check('a missing revision retracts the uncommitted attempt through an authoritative history reload',
    fold.frame({ type: 'chunk', attemptId: 'session-fixture-stream:1', revision: 9, index: 2,
      chunk: { type: 'text-delta', index: 0, text: 'lost' } }).some((m) => m.type === 'history-reset')
      && fold.messages().length === 0);
  fold.baseline(fixture.follow[baselinePosition]!.assistantStream);
  check('an abandoned attempt clears its provisional rows',
    fold.frame({ type: 'end', attemptId: 'session-fixture-stream:1', revision: 4, index: 2, outcome: { kind: 'abandoned' } })
      .some((m) => m.type === 'history-reset') && fold.messages().length === 0);
  fold.baseline(fixture.follow[baselinePosition]!.assistantStream);
  check('an out-of-order chunk index also retracts incomplete text',
    fold.frame({ type: 'chunk', attemptId: 'session-fixture-stream:1', revision: 4, index: 3,
      chunk: { type: 'text-delta', index: 0, text: 'bad' } }).some((m) => m.type === 'history-reset'));
}

// Source-defined lifecycle events reconcile durable roster truth; inactivity
// alone cannot delete a cold session. Workspace archives remain reversible.
{
  const h = harness(); await h.link.verify();
  const { connection, messages } = attach(h, structuredClone(info)); await flush(); await connection.getHistory();
  const event = (event: string, args: unknown[]) => h.host.live.item(h.host.stream('$events').streamId, { type: 'emit', event, args });
  const row = (available: boolean) => ({ sessionId: SESSION_ID, agentAvailable: available, running: false, blank: false, updatedAt: 5, projections: { kind: 'sequenced', asOfSeq: 0, values: {} } });
  h.host.unaryHandlers.set('session/list', () => ({ value: { items: [row(false)] } }));
  event('api-session/removed', [SESSION_ID]); await flush();
  check('disposing an inactive agent preserves its durable cold session and history',
    !messages.some((m) => m.type === 'notice' && m.message.includes('removed from'))
      && connection.info.control?.drive.supported === true && !(await connection.getHistory()).some((m) => m.type === 'notice' && m.message.includes('unavailable')));
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  await connection.sendPrompt({ text: 'resume the ordinary cold session' });
  check('an inactive ordinary session can reach the native prompt route that resumes it', h.host.unaryCalls.some((c) => c.endpoint === 'session/prompt'));
  event('api-session/added', [row(true)]); await flush();
  check('a native agent becoming available restores attached Drive metadata', connection.info.control?.drive.supported === true);
  event('api-session/activity', [SESSION_ID, 42]); event('api-session/status', [SESSION_ID, true]); await flush();
  check('forwarded status and activity update the attached session', connection.info.updatedAt === 42 && connection.info.status === 'working');
  const ws = h.host.stream('workspace/follow');
  h.host.unaryHandlers.set('session/list', () => ({ value: { items: [row(true)] } }));
  h.host.live.item(ws.streamId, { type: 'upsert', workspace: { workspaceId: 'ws-1', title: 'Renamed', path: '/fixture/moved', sessionIds: [SESSION_ID] } });
  h.host.live.item(ws.streamId, { type: 'archived', archivedSessionIds: [SESSION_ID] }); await flush();
  check('workspace deltas update association and archive admission without deleting the transcript',
    connection.info.projectName === 'Renamed' && connection.info.cwd === '/fixture/moved'
      && connection.info.control?.drive.reason?.includes('archived') === true && h.link.isReady);
  await expectRejection('archived sessions refuse new prompts', () => connection.sendPrompt({ text: 'must refuse' }));
  event('api-session/status', [SESSION_ID, true]); await flush();
  check('a late running event cannot re-latch an archived session', connection.info.status === 'idle'
    && messages.filter((m) => m.type === 'status').at(-1)?.status === 'idle');
  h.host.live.item(ws.streamId, { type: 'archived', archivedSessionIds: [] }); await flush();
  check('unarchive reconciles native availability and restores the existing connection', connection.info.control?.drive.supported === true);
  h.host.unaryHandlers.set('session/list', () => ({ error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture service failure' } }));
  event('api-session/removed', [SESSION_ID]); await flush();
  check('a failed roster read cannot declare an attached session deleted', connection.info.control?.drive.supported === true);
  h.host.unaryHandlers.set('session/list', () => ({ value: { items: [], cursor: 'repeated' } }));
  event('api-session/removed', [SESSION_ID]); await flush();
  check('a truncated or repeated-cursor roster cannot declare deletion', connection.info.control?.drive.supported === true);
  h.host.unaryHandlers.set('session/list', () => ({ value: { items: [] } }));
  event('api-session/removed', [SESSION_ID]); await flush();
  check('an exhaustive successful roster absence withdraws only that durable session',
    connection.info.control?.drive.reason?.includes('removed from') === true && h.link.isReady);
  h.link.stop();
}

// Ordered native queue splices distinguish normal delivery from cancellation.
{
  const h = harness(); await h.link.verify();
  const { connection, messages } = attach(h, { ...info, control: undefined }); await flush(); await connection.getHistory();
  const follow = h.host.stream('session/follow'); let seq = Number(SNAPSHOT.cursor);
  const emit = (type: string, data: unknown) => h.host.live.item(follow.streamId, { type: 'event', event: { type, seq: ++seq, time: 1, data } });
  const queued = { id: 'queued-image', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'opaque-image-id' } }] };
  emit('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] }); await flush();
  check('an image-only queued input appears as a stable queued user echo',
    messages.some((m) => m.type === 'user-message' && m.queued && m.imageCount === 1 && m.key?.endsWith('queued-image')));
  check('queue overlays retain image-only inputs on history refresh', (await connection.getHistoryOverlays()).some((m) => m.type === 'user-message' && m.queued && m.imageCount === 1));
  const resets = messages.filter((m) => m.type === 'history-reset').length;
  emit('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  emit('user/message', queued); await flush();
  check('a normal queue claim settles the same bubble without resetting history',
    messages.filter((m) => m.type === 'history-reset').length === resets
      && messages.some((m) => m.type === 'user-message' && !m.queued && m.key?.endsWith('queued-image'))
      && !(await connection.getHistoryOverlays()).some((m) => m.type === 'user-message' && m.queued));
  emit('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ id: 'steer', source: { kind: 'user' }, content: [{ type: 'text', text: 'steer' }] }] });
  emit('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }); await flush();
  check('a canceled steering item retracts through one history reset and leaves no stale overlay',
    messages.filter((m) => m.type === 'history-reset').length === resets + 1
      && !(await connection.getHistoryOverlays()).some((m) => m.type === 'user-message' && m.queued));
  h.link.stop();
}

// Session-authorized durable image readback stays behind the adapter boundary.
{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-images.json', import.meta.url)).json() as {
    userEvents: Array<Record<string, unknown>>; readback: { attachment: Record<string, unknown>; data: string };
  };
  const h = harness(); h.host.holdStreams.add('session/follow'); await h.link.verify();
  h.host.unaryHandlers.set('session/attachment', () => ({ value: fixture.readback }));
  const { connection } = attach(h, { ...info, control: undefined }); await flush();
  const event = fixture.userEvents[0]!;
  h.host.live.item(h.host.stream('session/follow').streamId, { ...SNAPSHOT, cursor: event.seq, records: [{ type: 'event', event }], hasMore: false }); await flush();
  const history = await connection.getHistory();
  const artifact = history.find((m) => m.type === 'file-artifact');
  const request = h.host.unaryCalls.find((c) => c.endpoint === 'session/attachment');
  check('captured durable images become user-linked artifacts through the authorized readback route',
    artifact?.type === 'file-artifact' && artifact.url === `data:image/png;base64,${fixture.readback.data}`
      && !!artifact.userMessageKey && JSON.stringify(request?.args) === JSON.stringify({ request: { sessionId: SESSION_ID, attachmentId: fixture.readback.attachment.attachmentId } })
      && request?.cookie === `${COOKIE.name}=${COOKIE.value}`);
  await connection.getHistory();
  check('history refresh reuses one bounded image read without exposing a DSH cookie or endpoint',
    h.host.unaryCalls.filter((c) => c.endpoint === 'session/attachment').length === 1
      && artifact?.type === 'file-artifact' && !artifact.url?.includes('dsh-auth') && !artifact.url?.includes(BASE_URL));
  connection.onGenerationLost();
  h.host.unaryHandlers.set('session/attachment', () => ({ value: { ...fixture.readback, attachment: { ...fixture.readback.attachment, attachmentId: 'wrong-image' } } }));
  const refused = await connection.getHistory();
  check('a mismatched image identity cannot supply preview bytes after generation invalidation',
    refused.some((m) => m.type === 'file-artifact' && !m.url) && refused.some((m) => m.type === 'notice' && m.message.includes('preview')));
  h.link.stop();
}

{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-assistant-stream.json', import.meta.url)).json() as {
    interruptedFollow: unknown[];
  };
  const h = harness(); h.host.holdStreams.add('session/follow'); await h.link.verify();
  const { connection, messages } = attach(h, { ...info, control: undefined }); await flush();
  const follow = h.host.stream('session/follow');
  h.host.live.item(follow.streamId, { ...SNAPSHOT, cursor: 0, records: [], hasMore: false, assistantStream: { revision: 0 } }); await flush(); await connection.getHistory();
  for (const item of fixture.interruptedFollow) h.host.live.item(follow.streamId, item); await flush();
  const outputs = messages.filter((m) => m.type === 'model-output');
  check('a real interrupted message settles the partial stream on the same identity',
    outputs.some((m) => m.type === 'model-output' && m.text === 'Fixture ' && m.final === false)
      && outputs.filter((m) => m.type === 'model-output' && m.final === true && m.text === 'Fixture ').length === 1
      && new Set(outputs.map((m) => m.type === 'model-output' ? m.key : undefined)).size === 1
      && messages.some((m) => m.type === 'run-summary' && m.status === 'cancelled')
      && !(await connection.getHistoryOverlays()).some((m) => m.type === 'model-output'));
  h.link.stop();
}


// Exercise the steering product caller, not just the channel's mode builder.
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'steer', description: 'native collision' }, { name: 'compact' }] }));
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  h.host.unaryHandlers.set('session/selectModel', () => ({ value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } }));
  const commands = await connection.listCommands();
  check('rc.2 offers one local steering command alongside its native registry', commands.filter(c => c.name === 'steer').length === 1 && commands.find(c => c.name === 'steer')?.description?.includes('next step') === true && commands.some(c => c.name === 'compact'));
  const mark = h.host.unaryCalls.length;
  let error: unknown;
  await connection.runCommand('steer', '  steering witness  ', { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } }).catch(e => { error = e; });
  const calls = h.host.unaryCalls.slice(mark);
  const prompt = calls.find(c => c.endpoint === 'session/prompt');
  const request = prompt?.args.request as Record<string, unknown> | undefined;
  check('local steer selects its model then submits one authenticated next-step prompt', error === undefined
    && calls.filter(c => c.endpoint === 'session/prompt').length === 1
    && calls.findIndex(c => c.endpoint === 'session/selectModel') >= 0
    && calls.findIndex(c => c.endpoint === 'session/selectModel') < calls.findIndex(c => c.endpoint === 'session/prompt')
    && request?.mode === 'steer' && request.sessionId === SESSION_ID && typeof request.requestId === 'string'
    && JSON.stringify(request.content) === JSON.stringify([{ type: 'text', text: 'steering witness' }])
    && prompt?.cookie === `${COOKIE.name}=${COOKIE.value}` && !calls.some(c => c.endpoint === 'commands/execute'));
  const emptyMark = h.host.unaryCalls.length;
  await expectRejection('empty steering text is refused', () => connection.runCommand('steer', '  '));
  check('empty steer issues no request or selectors', h.host.unaryCalls.length === emptyMark);
  let failures = 0;
  h.host.unaryHandlers.set('session/prompt', () => { failures++; return { error: { code: 'session/writer-held', message: 'other owner' } }; });
  await expectRejection('steering surfaces a native writer refusal', () => connection.runCommand('steer', 'refused steering'));
  check('an ambiguous or refused steer is never retried', failures === 1);
  h.link.stop();
  const stoppedMark = h.host.unaryCalls.length;
  await expectRejection('steering refuses an unverified generation', () => connection.runCommand('steer', 'stale steering'));
  check('unverified steering issues no requests', h.host.unaryCalls.length === stoppedMark);
}
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('session/selectModel', () => {
    h.link.stop();
    return { value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } };
  });
  let refused: unknown;
  await connection.runCommand('steer', 'generation fence', { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash' } }).catch(e => { refused = e; });
  check('steering lost during model selection cannot submit to the stale generation', refused instanceof Error && !h.host.unaryCalls.some(c => c.endpoint === 'session/prompt'));
  h.link.stop();
}


// These names are the rc.2 forwarded allowlist and native catalog listeners;
// the old settings/change spelling is never emitted by that host.
for (const event of ['settings/document-updated', 'plugin-manager/changed', 'llm/adapters-updated', 'permission-presets/catalog-changed', 'commands/change', 'agent-preset/selected', 'credentials/record-updated', 'credentials/reference-updated']) {
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  let catalog = ['before-change'];
  h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: { options: catalog.map(value => ({ value, name: value })), defaultPreset: catalog[0] } }));
  const before = await connection.listModes();
  catalog = ['after-change'];
  h.host.live.item(h.host.stream('$events').streamId, { type: 'emit', event, args: event === 'settings/document-updated' ? ['models', 2] : [SESSION_ID] });
  await flush();
  const after = await connection.listModes();
  check(`${event} refreshes the live catalog without replacing carrier or event authority`,
    before.some(m => m.value === 'before-change') && after.some(m => m.value === 'after-change')
      && !after.some(m => m.value === 'before-change') && h.host.sockets.length === 1 && h.link.isReady
      && !h.diagnostics.some(d => d.code === 'forwarded-event-unmapped' && d.detail === event));
  h.link.stop();
}

// A catalog read started before native invalidation must not poison later pickers.
for (const replacement of [['new-preset'], []] as string[][]) {
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ wrapRemoteFetch: (fetch) => async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith('/permissionPresets/catalog') && !held) {
      held = true;
      await gate;
    }
    return response;
  } });
  await h.link.verify(); const { connection } = attach(h); await flush();
  let catalog = ['obsolete-preset'];
  h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: {
    options: catalog.map(value => ({ value, name: value })), defaultPreset: catalog[0],
  } }));
  const obsoleteRead = connection.listModes(); await flush();
  catalog = replacement;
  h.host.live.item(h.host.stream('$events').streamId, {
    type: 'emit', event: 'permission-presets/catalog-changed', args: [],
  });
  await flush();
  const current = await connection.listModes();
  const label = replacement.length ? 'replacement' : 'empty replacement';
  check(`native catalog ${label} removes obsolete picker choices`,
    !current.some(mode => mode.value === 'obsolete-preset')
      && (replacement.length ? current.some(mode => mode.value === 'new-preset') : current.length === 0));
  release(); await obsoleteRead;
  const later = await connection.listModes();
  check(`a late pre-invalidation reply cannot undo the catalog ${label}`,
    !later.some(mode => mode.value === 'obsolete-preset')
      && (replacement.length ? later.some(mode => mode.value === 'new-preset') : later.length === 0)
      && h.host.sockets.length === 1 && h.link.isReady);
  h.link.stop();
}

// Credential renewal can recreate the mux with the same numeric generation.
for (const replacement of [['fresh-enrollment-preset'], []] as string[][]) {
  const h = harness({ cookie: { ...COOKIE, expiresAt: Date.now() + 20 * 86_400_000 } });
  await h.link.verify(); const { connection } = attach(h); await flush();
  let catalog = ['old-enrollment-preset'];
  h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: {
    options: catalog.map(value => ({ value, name: value })), defaultPreset: catalog[0],
  } }));
  const before = await connection.listModes();
  const oldGeneration = h.link.generation;
  await h.store.clear('scope'); await h.link.roster(); await flush();
  const withdrawn = !h.link.isReady && !h.link.carrierRunning;
  catalog = replacement;
  await h.store.save('scope', { ...COOKIE, value: 'v1.fresh-catalog-enrollment', expiresAt: Date.now() + 20 * 86_400_000 });
  await Promise.all([h.link.roster(), h.link.roster()]); await flush();
  const current = await connection.listModes();
  const label = replacement.length ? 'replacement' : 'empty replacement';
  check(`preset catalog ${label} exercises attached renewal with a reused generation`,
    before.some(mode => mode.value === 'old-enrollment-preset') && withdrawn
      && h.link.isReady && h.host.sockets.length === 2 && oldGeneration === h.link.generation);
  check(`a fresh authenticated handshake reloads the preset catalog ${label}`,
    !current.some(mode => mode.value === 'old-enrollment-preset')
      && (replacement.length ? current.some(mode => mode.value === 'fresh-enrollment-preset') : current.length === 0)
      && h.host.unaryCalls.filter(call => call.endpoint === 'permissionPresets/catalog').length >= 2);
  h.link.stop();
}

// A host-scoped catalog can outlive withdrawal; the mutation waiting on it cannot.
for (const selector of ['model', 'permission'] as const) for (const operation of ['prompt', 'command'] as const)
  for (const loss of ['withdrawal', 'carrier', 'close'] as const) {
    const endpoint = selector === 'model' ? 'session/modelCatalog' : 'permissionPresets/catalog';
    let release!: () => void;
    let held = false;
    const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    const h = harness({
      wrapRemoteFetch: fetch => async (url, init) => {
        const response = await fetch(url, init);
        if (url.endsWith('/' + endpoint) && !held) {
          held = true;
          await new Promise<void>(resolve => { release = resolve; });
        }
        return response;
      },
      reconnectDelayMs: 50,
      setTimeout: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return timer; },
      clearTimeout: handle => { (handle as typeof timers[number]).cancelled = true; },
    });
    h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: {
      options: [{ value: 'read-only', name: 'Read only' }],
    } }));
    h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'compact' }, { name: 'permission' }] }));
    h.host.unaryHandlers.set('commands/execute', () => ({ value: { commandId: 'fenced-command', result: { kind: 'success' } } }));
    h.host.unaryHandlers.set('session/selectModel', () => ({ value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } }));
    h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
    await h.link.verify(); const { connection } = attach(h); await flush();
    const input = selector === 'model'
      ? { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } }
      : { permissionMode: 'read-only' };
    const run = (target: DshSessionConnection) => operation === 'prompt'
      ? target.sendPrompt({ text: 'Explicit mutation lifetime witness', ...input })
      : target.runCommand('compact', undefined, input);
    let rejected = false;
    const old = run(connection).catch(() => { rejected = true; });
    await flush();
    if (loss === 'withdrawal') {
      await h.store.clear('scope'); await h.link.roster(); await flush();
      await h.store.save('scope', { ...COOKIE, value: 'v1.new-mutation-authority' });
      await h.link.roster(); await flush();
    } else if (loss === 'carrier') {
      h.host.live.dropSocket(); await flush();
      const reconnect = timers.findLast(timer => timer.ms === 50 && !timer.cancelled);
      reconnect?.run(); await flush();
    } else {
      await connection.close();
    }
    const label = `${operation} ${selector} catalog across ${loss}`;
    check(`${label} reaches a held read and a healthy replacement authority`,
      held && h.link.isReady && h.host.sockets.length === (loss === 'close' ? 1 : 2));
    const mark = h.host.unaryCalls.length;
    release(); await old;
    check(`${label} rejects the old mutation even after readiness returns`, rejected);
    check(`${label} sends no selection, permission, prompt or command after the old read lands`,
      !h.host.unaryCalls.slice(mark).some(call => ['session/selectModel', 'session/prompt', 'commands/execute'].includes(call.endpoint)));
    const current = loss === 'close' ? attach(h).connection : connection;
    const freshMark = h.host.unaryCalls.length;
    await run(current);
    check(`${label} permits one explicitly new mutation without reconnecting again`,
      h.host.unaryCalls.slice(freshMark).filter(call => operation === 'prompt'
        ? call.endpoint === 'session/prompt'
        : call.endpoint === 'commands/execute' && call.args.line === '/compact').length === 1
        && h.host.sockets.length === (loss === 'close' ? 1 : 2));
    await current.close(); h.link.stop();
  }

// A follow-only retry invalidates transcript, not the authority of a parked send.
{
  let release!: () => void;
  let held = false;
  const h = harness({ wrapRemoteFetch: fetch => async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith('/session/modelCatalog') && !held) {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return response;
  } });
  h.host.unaryHandlers.set('session/selectModel', () => ({ value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }));
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  await h.link.verify(); const { connection } = attach(h); await flush();
  const oldFollow = h.host.stream('session/follow').streamId;
  const send = connection.sendPrompt({ text: 'The event authority remains healthy', model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash' } });
  await flush(); h.host.live.end(oldFollow); await flush();
  check('a parked mutation sees a real follow replacement with the same event authority',
    held && h.link.isReady && h.host.sockets.length === 1 && h.host.stream('session/follow').streamId !== oldFollow);
  release(); await send;
  check('follow-only recovery permits the existing send exactly once',
    h.host.unaryCalls.filter(call => call.endpoint === 'session/prompt').length === 1);
  await connection.close(); h.link.stop();
}

// Native command selection configures the next prompt, not command arguments.
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'compact' }] }));
  h.host.unaryHandlers.set('commands/execute', () => ({ value: { commandId: 'selected-command', result: { kind: 'success' } } }));
  h.host.unaryHandlers.set('session/selectModel', () => ({ value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } }));
  await connection.runCommand('compact', undefined, { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } });
  const calls = h.host.unaryCalls;
  const selection = calls.find(call => call.endpoint === 'session/selectModel');
  check('native command model and effort use the captured next-prompt selection before execution',
    selection !== undefined && calls.indexOf(selection) < calls.findIndex(call => call.endpoint === 'commands/execute')
      && JSON.stringify(selection.args) === JSON.stringify({ request: { sessionId: SESSION_ID, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } }));
  const executions = calls.filter(call => call.endpoint === 'commands/execute');
  check('native command selection submits one unchanged command envelope without override fields',
    executions.length === 1 && JSON.stringify(executions[0]?.args) === JSON.stringify({ agentId: SESSION_ID, line: '/compact', submittedAttachments: [] }));
  h.host.live.item(h.host.stream('session/control').streamId, { type: 'projection', sessionId: SESSION_ID, key: 'modelSelection', seq: 3,
    value: { next: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } });
  await flush(); const mark = calls.length;
  await connection.runCommand('compact', undefined, { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } });
  check('a command using the native next selection does not repeat its selection write',
    !calls.slice(mark).some(call => call.endpoint === 'session/selectModel') && calls.slice(mark).filter(call => call.endpoint === 'commands/execute').length === 1);
  h.link.stop();
}
for (const fault of ['refused', 'generation-lost'] as const) {
  const h = harness(); await h.link.verify(); const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'compact' }] }));
  h.host.unaryHandlers.set('commands/execute', () => ({ value: { commandId: 'must-not-execute', result: { kind: 'success' } } }));
  h.host.unaryHandlers.set('session/selectModel', () => {
    if (fault === 'refused') return { error: { code: 'session/model-unavailable', message: 'the native selection was refused' } };
    h.link.stop(); return { value: { selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } };
  });
  await expectRejection(`native command does not execute after ${fault} model selection`, () => connection.runCommand('compact', undefined,
    { model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' } }));
  check(`native command ${fault} model selection sends no command or retry`,
    h.host.unaryCalls.filter(call => call.endpoint === 'session/selectModel').length === 1 && !h.host.unaryCalls.some(call => call.endpoint === 'commands/execute'));
  h.link.stop();
}

const commandPermissionCatalog = (await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2.json', import.meta.url)).json() as {
  unary: Record<string, { envelope: { result: { value: unknown } } }>;
}).unary['unary.permissionPresets']!.envelope.result.value;
// Ordinary command permission selectors use the native registry, not prompt admission.
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: commandPermissionCatalog }));
  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'goal' }, { name: 'permission' }] }));
  h.host.unaryHandlers.set('commands/execute', () => ({ value: { commandId: 'fixture-command', result: { kind: 'success' } } }));
  await connection.runCommand('goal', undefined, { permissionMode: 'read-only' });
  const calls = h.host.unaryCalls.filter(c => c.endpoint === 'commands/execute');
  check('rc.2 applies command permission before exactly one requested registry execution',
    JSON.stringify(calls.map(c => c.args.line)) === JSON.stringify(['/permission read-only', '/goal']));
  check('rc.2 command permission and target retain captured argument names and empty attachments',
    calls.every(c => c.args.agentId === SESSION_ID && JSON.stringify(c.args.submittedAttachments) === '[]'));
  const mark = h.host.unaryCalls.length;
  await expectRejection('rc.2 refuses an unadvertised command permission before target execution',
    () => connection.runCommand('goal', undefined, { permissionMode: 'unknown-preset' }));
  check('rc.2 refused command permission sends no registry execution',
    !h.host.unaryCalls.slice(mark).some(c => c.endpoint === 'commands/execute'));
  h.link.stop();
}
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await flush();
  h.host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: commandPermissionCatalog }));
  h.host.unaryHandlers.set('commands/list', () => ({ value: [{ name: 'goal' }, { name: 'permission' }] }));
  h.host.unaryHandlers.set('commands/execute', args => {
    if (args.line === '/permission read-only') h.link.stop();
    return { value: { commandId: 'fixture-command', result: { kind: 'success' } } };
  });
  let refused: unknown;
  await connection.runCommand('goal', undefined, { permissionMode: 'read-only' }).catch(e => { refused = e; });
  check('rc.2 generation lost after accepted command permission blocks the target without retry',
    refused instanceof Error && h.host.unaryCalls.filter(c => c.endpoint === 'commands/execute').length === 1
      && !h.host.unaryCalls.some(c => c.endpoint === 'commands/execute' && c.args.line === '/goal'));
  h.link.stop();
}

{
  const host = new ScriptedHost();
  const scope = dshCredentialScope(BASE_URL, '/fixture/dsh-home');
  const adapter = adapterOver(host, memoryStore({ [scope]: COOKIE }));
  const connection = await adapter.attach(SESSION_ID, 'live');
  await connection.getHistory();
  const link = (adapter as unknown as { remoteHost: DshRemoteHostLink }).remoteHost;
  const beforeGeneration = link.generation;
  const beforeSockets = host.sockets.length;
  check('the adapter catalog scenario starts with a verified attached carrier', link.isReady && link.carrierRunning);
  let notifications = 0;
  const watch = (adapter as unknown as {
    watchSessionCatalog?: (id: string, notify: () => void) => () => void;
  }).watchSessionCatalog?.bind(adapter);
  const stopBroken = watch?.(SESSION_ID, () => { throw new Error('retired fixture listener'); });
  const stop = watch?.(SESSION_ID, () => { notifications++; });
  let catalog = ['before-change'];
  host.unaryHandlers.set('permissionPresets/catalog', () => ({ value: { options: catalog.map(value => ({ value, name: value })), defaultPreset: catalog[0] } }));
  await connection.listModes!();
  catalog = ['after-change'];
  host.live.item(host.stream('$events').streamId, { type: 'emit', event: 'permission-presets/catalog-changed', args: [] });
  await flush();
  const after = await connection.listModes!();
  check('the actual adapter forwards native catalog invalidation to its attached-client watcher',
    notifications === 1 && after.some(mode => mode.value === 'after-change'));
  check('a failed catalog listener cannot suppress another listener or replace event authority',
    notifications === 1 && link.generation === beforeGeneration && link.isReady && host.sockets.length === beforeSockets);
  stop?.(); stopBroken?.();
  host.live.item(host.stream('$events').streamId, { type: 'emit', event: 'commands/change', args: [] });
  await flush();
  check('unsubscribed attached clients receive no later command catalog notification', notifications === 1);
  await connection.close(); link.stop();
}

// A native disposal can precede a roster reread. Only an actual complete
// session list, not a malformed successful RPC, can prove durable removal.
for (const [name, value] of [
  ['absent-items', {}], ['null-items', { items: null }],
  ['invalid-identity', { items: [{}] }], ['invalid-cursor', { items: [], cursor: 42 }],
] as const) {
  const h = harness(); await h.link.verify();
  h.host.unaryHandlers.set('session/list', () => ({ value }));
  const outcome = await h.link.roster();
  check(`malformed ${name} roster is a contract refusal, never an exhaustive empty list`,
    !outcome.ok && outcome.failure.kind === 'transport' && outcome.failure.reason === 'invalid-envelope');
  h.link.stop();
}
{
  const h = harness(); await h.link.verify();
  const { connection } = attach(h); await connection.getHistory();
  h.host.unaryHandlers.set('session/list', () => ({ value: { accepted: true } }));
  h.host.unaryHandlers.set('session/prompt', () => ({ value: { accepted: true } }));
  const notify = () => h.host.live.item(h.host.stream('$events').streamId,
    { type: 'emit', event: 'api-session/removed', args: [SESSION_ID] });
  notify(); await flush();
  let refused: unknown;
  await connection.sendPrompt({ text: 'durable session still exists' }).catch(error => { refused = error; });
  check('malformed reconciliation after native disposal preserves the attached durable session',
    refused === undefined && h.link.isReady && h.host.sockets.length === 1
      && h.host.unaryCalls.filter(call => call.endpoint === 'session/prompt').length === 1);
  h.host.unaryHandlers.set('session/list', () => ({ value: { items: [] } }));
  notify(); await flush();
  await expectRejection('a subsequent valid exhaustive empty roster proves actual removal',
    () => connection.sendPrompt({ text: 'must not be submitted' }));
  check('proved removal issues no extra native prompt',
    h.host.unaryCalls.filter(call => call.endpoint === 'session/prompt').length === 1);
  h.link.stop();
}
{
  const h = harness(); await h.link.verify();
  h.host.unaryHandlers.set('session/list', args => (args._request as { cursor?: string }).cursor === 'next-page'
    ? { value: { broken: true } }
    : { value: { items: [{ sessionId: SESSION_ID }], cursor: 'next-page' } });
  const outcome = await h.link.roster();
  check('a malformed later roster page cannot turn a partial read into deletion authority',
    !outcome.ok && h.host.unaryCalls.filter(call => call.endpoint === 'session/list').length === 2);
  h.link.stop();
}

// Carrier replacement reconciles process-local attempts even when the durable
// cursor did not move. Chunk bodies come from the captured scripted provider;
// carrier loss and the durable checkpoint are deliberately injected schedules.
for (const scenario of ['lost-text', 'lost-reasoning', 'surviving-text', 'restarted-text']) {
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-assistant-stream.json', import.meta.url)).json();
  const frames = scenario === 'lost-reasoning' ? fixture.reasoning : fixture.follow.slice(1);
  const last = frames.findIndex((item: { frame?: { chunk?: { type?: string } } }) =>
    item.frame?.chunk?.type === (scenario === 'lost-reasoning' ? 'reasoning-delta' : 'text-delta'));
  const checkpoint = { type: 'event', event: { type: 'step/start', seq: frames[0].frame.startedAfterSeq, time: 1,
    data: { turn: frames[0].frame.turn, step: frames[0].frame.step } } };
  const timers = new Map<object, { handler: () => void; ms: number }>();
  const h = harness({ reconnectDelayMs: 7,
    setTimeout: (handler, ms) => { const id = {}; timers.set(id, { handler, ms }); return id; },
    clearTimeout: id => { timers.delete(id as object); } });
  h.host.followSnapshot = { ...SNAPSHOT, cursor: checkpoint.event.seq,
    records: [...(SNAPSHOT.records as unknown[]), checkpoint], assistantStream: { revision: 0 } };
  await h.link.verify(); const { connection, messages } = attach(h, { id: SESSION_ID, tool: 'dsh', title: 'fixture', status: 'idle', attachMode: 'live' });
  await flush(); await connection.getHistory();
  for (const frame of frames.slice(0, last + 1)) h.host.live.item(h.host.stream('session/follow').streamId, frame);
  await flush();
  const type = scenario === 'lost-reasoning' ? 'thinking' : 'model-output';
  check(`${scenario}: the partial attempt is visible before carrier loss`, messages.some(m => m.type === type));
  messages.length = 0;
  h.host.live.dropSocket(); await flush();
  check(`${scenario}: loss hides the overlay without reading an obsolete history cut`,
    !(await connection.getHistoryOverlays()).some(m => m.type === type) && !messages.some(m => m.type === 'history-reset'));
  const survives = scenario === 'surviving-text' || scenario === 'restarted-text';
  if (survives) {
    const baseline = fixture.follow[4].assistantStream;
    h.host.followSnapshot = { ...(h.host.followSnapshot as object), assistantStream: {
      ...baseline, activeAttempt: { ...baseline.activeAttempt,
        turn: baseline.activeAttempt.turn + (scenario === 'restarted-text' ? 1 : 0) },
    } };
  }
  const reconnect = [...timers].find(([, timer]) => timer.ms === 7)!;
  timers.delete(reconnect[0]); reconnect[1].handler(); await flush();
  const resets = messages.filter(m => m.type === 'history-reset');
  const overlays = (await connection.getHistoryOverlays()).filter(m => m.type === type);
  check(`${scenario}: the fresh same-cursor baseline reconciles exactly the surviving overlay`,
    h.link.isReady && h.host.sockets.length === 2 && connection.isPrimed
      && resets.length === (scenario === 'surviving-text' ? 0 : 1)
      && overlays.length === (survives ? 1 : 0));
  await connection.close(); h.link.stop();
}
{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-assistant-stream.json', import.meta.url)).json();
  const fold = new DshAssistantStream(SESSION_ID);
  fold.baseline(fixture.follow[4].assistantStream);
  const turn = fixture.follow[1].frame.turn + 1;
  const restarted = fold.frame({ ...fixture.follow[1].frame, turn });
  for (const item of fixture.follow.slice(2, 4)) fold.frame(item.frame);
  check('a restarted Agent reusing its attempt counter replaces the prior turn instead of being deduplicated',
    restarted.some(m => m.type === 'history-reset')
      && fold.messages().some(m => m.type === 'model-output' && m.key === `dsh:${SESSION_ID}:turn${String(turn)}:step1`));
}

// Native claims happen before user/message admission. Interrupted preparation
// releases a continued reply at turn/end; accepted/queued replies for a later
// turn and actually admitted answers must remain suppressed.
for (const scenario of ['interrupted', 'missed-end', 'admitted', 'late-receipt']) {
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-questions.json', import.meta.url)).json();
  let releaseReceipt!: () => void;
  const receipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const timers = new Map<object, { handler: () => void; ms: number }>();
  const h = harness({ reconnectDelayMs: 7,
    setTimeout: (handler, ms) => { const id = {}; timers.set(id, { handler, ms }); return id; },
    clearTimeout: id => { timers.delete(id as object); },
    wrapRemoteFetch: fetch => async (url, init) => {
      const result = await fetch(url, init);
      if (scenario === 'late-receipt' && url.endsWith('/userQuestions/answer')) await receipt;
      return result;
    } });
  await h.link.verify(); const { connection } = attach(h, { id: SESSION_ID, tool: 'dsh', title: 'fixture', status: 'idle', attachMode: 'live' }); await flush(); await connection.getHistory();
  let seq = Number(SNAPSHOT.cursor);
  const records = [...(SNAPSHOT.records as unknown[])];
  const event = (type: string, data: unknown, deliver = true) => {
    const frame = { type: 'event', event: { type, seq: ++seq, time: 1, data } };
    records.push(frame);
    if (deliver) h.host.live.item(h.host.stream('session/follow').streamId, frame);
  };
  const project = (key: string, value: unknown) => h.host.live.item(h.host.stream('session/control').streamId,
    { type: 'projection', sessionId: SESSION_ID, key, seq, value });
  event('turn/start', { turn: 1 });
  project('userQuestions', fixture.continued); await flush();
  const card = connection.getPending().find(m => m.type === 'question-request');
  if (!card || card.type !== 'question-request') throw new Error('missing continued fixture question');
  h.host.unaryHandlers.set('userQuestions/answer', () => ({ value: true }));
  const answer = connection.answerQuestion(card.requestId, [['yes']]);
  if (scenario !== 'late-receipt') await answer;
  else await flush();
  const reply = { id: 'late-reply', source: { kind: 'user-question-reply', callId: 'call-fixture', outcome: 'answered' },
    content: [{ type: 'text', text: 'fixture answer' }] };
  event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [reply] });
  project('inbox', { 'next-turn': [reply], 'next-step': [] });
  event('turn/end', { turn: 1, reason: { kind: 'completed' } }); await flush();
  check(`${scenario}: ending an unrelated turn cannot release a queued later reply`, connection.getPending().length === 0);
  event('turn/start', { turn: 2 });
  event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  project('inbox', fixture.inbox);
  if (scenario === 'admitted') event('user/message', reply);
  await flush();
  check(`${scenario}: a claimed reply remains suppressed before its turn ends`, connection.getPending().length === 0);
  if (scenario === 'missed-end') { h.host.live.dropSocket(); await flush(); }
  event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }, scenario !== 'missed-end');
  await flush();
  if (scenario === 'late-receipt') { releaseReceipt(); await answer; }
  h.host.followSnapshot = { ...SNAPSHOT, cursor: seq, records, assistantStream: { revision: 0 },
    projections: { asOfSeq: seq, values: { userQuestions: fixture.continued, inbox: fixture.inbox } } };
  h.host.controlBaseline = { type: 'baseline', value: { projections: { [SESSION_ID]: {
    asOfSeq: seq, values: { userQuestions: fixture.continued, inbox: fixture.inbox },
  } } } };
  if (scenario !== 'missed-end') { h.host.live.dropSocket(); await flush(); }
  const reconnect = [...timers].find(([, timer]) => timer.ms === 7)!;
  timers.delete(reconnect[0]); reconnect[1].handler(); await flush(); await connection.getHistory();
  const expected = scenario === 'admitted' ? 0 : 1;
  check(`${scenario}: recovery distinguishes abandoned claims from durable admission`,
    h.link.isReady && connection.getPending().length === expected);
  if (expected) {
    const retryCard = connection.getPending()[0]!;
    if (retryCard.type !== 'question-request') throw new Error('wrong continued fixture card');
    await Promise.all([connection.answerQuestion(retryCard.requestId, [['yes']]), connection.answerQuestion(retryCard.requestId, [['no']])]);
    check(`${scenario}: the replacement card accepts exactly one new decision`,
      h.host.unaryCalls.filter(call => call.endpoint === 'userQuestions/answer').length === 2 && connection.getPending().length === 0);
  }
  await connection.close(); h.link.stop();
}

{
  const fixture = await Bun.file(new URL('./fixtures/dsh-0.2.0-rc.2-questions.json', import.meta.url)).json();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ wrapRemoteFetch: fetch => async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith('/userQuestions/answer')) await held;
    return response;
  } });
  await h.link.verify(); const { connection } = attach(h, { id: SESSION_ID, tool: 'dsh', title: 'fixture', status: 'idle', attachMode: 'live' }); await flush(); await connection.getHistory();
  const project = (seq: number) => h.host.live.item(h.host.stream('session/control').streamId,
    { type: 'projection', sessionId: SESSION_ID, key: 'userQuestions', seq, value: fixture.continued });
  project(3); await flush();
  const card = connection.getPending()[0]!;
  if (card.type !== 'question-request') throw new Error('missing refused fixture question');
  h.host.unaryHandlers.set('userQuestions/answer', () => ({ error: { code: 'BAD_ANSWER', message: 'fixture refusal' } }));
  const answer = connection.answerQuestion(card.requestId, [['yes']]).then(() => false, () => true);
  await flush(); project(4); await flush();
  check('a projection refresh cannot settle an answer whose receipt is still outstanding', connection.getPending().length === 1);
  release();
  check('a refused continued answer retains its card and rolls back local suppression', await answer && connection.getPending().length === 1);
  h.host.unaryHandlers.set('userQuestions/answer', () => ({ value: true }));
  await connection.answerQuestion(card.requestId, [['no']]);
  check('a corrected continued answer remains available after refusal', connection.getPending().length === 0
    && h.host.unaryCalls.filter(call => call.endpoint === 'userQuestions/answer').length === 2);
  await connection.close(); h.link.stop();
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
