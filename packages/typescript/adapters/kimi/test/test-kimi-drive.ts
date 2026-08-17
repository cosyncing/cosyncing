/**
 * Broker-arbitrated Drive over a cosyncing-created Kimi session.
 *
 * What this suite exists to pin, in the order the hazards matter:
 *
 *  - OWNERSHIP IS THE GATE. Only a session created here can be driven; a
 *    foreign one refuses a live attach with the typed conflict, and an owned
 *    session opened in observe still cannot mutate.
 *  - THE WRITE SET IS CLOSED, and every refusal is checked with a NEGATIVE
 *    CONTROL: a refused prompt, an unanswerable question, an idle observe
 *    `getPending`, and every call after demotion must issue ZERO HTTP. Proving
 *    the absence of a write is the whole point — a happy path that also
 *    half-wrote would pass a presence-only assertion.
 *  - DIVERGENCE DEMOTES. A terminal writing the same session appears only as a
 *    REST-sourced user row with no WS activity behind it; two polls of that,
 *    with the stream demonstrably healthy, stop the driving. Every way that
 *    evidence can be innocent — REST simply leading the WS, a socket-down
 *    window, assistant-only rows — must NOT demote.
 *  - THE FENCE SURVIVES A RESTART. A turn whose completion event is lost to a
 *    dropped socket is repaired from the session row, once, and only when a
 *    fence is actually outstanding.
 *
 * Runs against a fake `kap-server` that answers the real envelope shape
 * (`{code,msg,data,request_id}`) and the real WS envelope
 * (`{type,seq,epoch,session_id,timestamp,payload}` with the event fields nested
 * inside `payload`). No Kimi process, no model, no real waiting.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-drive.ts   (exit 0 = all pass)
 */
export {};
import { isOwnershipConflictError, isSessionCreateTemporarilyUnavailableError } from '@cosyncing/adapter-api';
import type { AgentMessage, SessionInfo } from '@cosyncing/adapter-api';
import { KimiAdapter } from '../src/index.ts';
import { KimiReadOnlyHttp, type KimiInstanceScan } from '../src/server.ts';
import {
  KimiObserveConnection,
  type KimiObserveTransport,
  type KimiSocketLike,
} from '../src/observe.ts';
import { KimiDriveHttp, type KimiWriteFetch } from '../src/drive-http.ts';
import {
  KIMI_DEMOTED_REFUSAL,
  KIMI_DIVERGENCE_CONFIRM_POLLS,
  KIMI_DIVERGENCE_MESSAGE,
  KIMI_DIVERGENCE_SUSPECT_LIMIT,
  KIMI_INTERACTION_RECONCILE_PASS_MAX,
  KIMI_NO_FILE_INPUT_MESSAGE,
  KIMI_NO_STREAM_REFUSAL,
  KIMI_OPEN_PROVENANCE_REFUSAL,
  KIMI_STOP_ALREADY_DONE_NOTICE,
  KIMI_STOP_NOTICE,
  KimiDriveConnection,
} from '../src/drive.ts';
import { KIMI_AMBIGUOUS_SINGLE_ANSWER, KIMI_APPROVAL_DETAIL_CAP_BYTES } from '../src/mapping.ts';
import { KIMI_LIVE_ATTACH_NO_STREAM } from '../src/implementation.ts';
import { KIMI_WS_FRAME_MAX_BYTES } from '../src/observe.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Fake kap-server ─────────────────────────────────────────────────────────

const SERVER_ID = 'srv_drive_fixture';
/**
 * The registry record's start time, and the `/api/v1/meta` body that binds to
 * it 200ms later — the shape upstream actually writes. The meta id is a
 * SIBLING of the registry id, never a copy: see the identity gate in
 * `test-kimi-server.ts` for why a fixture must never synthesize one from the
 * other. Passing the gate is a precondition of this suite, not its subject.
 */
const SERVER_STARTED_AT = 1_786_657_461_604;
const SERVER_META = {
  server_version: '0.35.0',
  server_id: 'api_drive_fixture',
  started_at: new Date(SERVER_STARTED_AT + 200).toISOString(),
  capabilities: { websocket: true },
  dangerous_bypass_auth: false,
};
const CREATED_ID = 'session_created_0001';
const FOREIGN_ID = 'session_foreign_0001';
const WORKSPACE = '/fixture/workspace';

/** The server's uniform envelope. `code` carries the business outcome, never the HTTP status. */
const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'req_fixture' });
const fail = (code: number, data: unknown, msg = 'already done') =>
  ({ code, msg, data, request_id: 'req_fixture' });

interface Recorded { method: string; path: string; body?: unknown; bearer?: string }
const requests: Recorded[] = [];
const writes = () => requests.filter((entry) => entry.method === 'POST');

/**
 * The credential this fixture server currently accepts.
 *
 * Mutable so a transport REPLACEMENT can be forced the way production forces
 * one: the server stops accepting the generation a connection holds, and the
 * only way back is a fresh resolution carrying a fresh snapshot. The recorded
 * bearer is then what proves which generation a given write actually used.
 */
let acceptedToken = 'fixture-token';

/** Newest-first, exactly like `GET .../messages` answers. */
let messages: Array<Record<string, unknown>> = [];
const userRow = (id: string, text: string) => ({
  id, session_id: CREATED_ID, role: 'user',
  content: [{ type: 'text', text }], created_at: '2026-08-14T09:00:00.000Z',
});
const assistantRow = (id: string, text: string) => ({
  id, session_id: CREATED_ID, role: 'assistant',
  content: [{ type: 'text', text }], created_at: '2026-08-14T09:00:01.000Z',
});

/** Mutable route answers, so one fake server can stand in for many server states. */
let createAnswer: unknown = ok({
  id: CREATED_ID, workspace_id: 'wd_0001', title: 'from cosyncing',
  created_at: '2026-08-14T09:00:00.000Z', updated_at: '2026-08-14T09:00:00.000Z',
  busy: false, pending_interaction: 'none', metadata: { cwd: WORKSPACE },
  agent_config: { model: '' }, usage: {}, permission_rules: [], message_count: 0, last_seq: 0,
});
let promptAnswer: unknown = ok({
  prompt_id: 'prompt_1', user_message_id: 'msg_user_1', status: 'running',
  content: [{ type: 'text', text: 'hello' }], created_at: '2026-08-14T09:00:00.000Z',
});
let abortAnswer: unknown = ok({ aborted: true });
let approvalResolveAnswer: unknown = ok({ resolved: true, resolved_at: '2026-08-14T09:00:00.000Z' });
let questionAnswerAnswer: unknown = ok({ answered: true });
let dismissAnswer: unknown = fail(40909, { dismissed: true, dismissed_at: '2026-08-14T09:00:00.000Z' });
let sessionRowAnswer: unknown = ok({
  id: CREATED_ID, busy: false, pending_interaction: 'none', last_turn_reason: 'completed',
  metadata: { cwd: WORKSPACE }, title: 'from cosyncing',
});
let pendingApprovals: unknown[] = [];
let pendingQuestions: unknown[] = [];
/**
 * Makes the QUESTIONS half of a pending read fail while the approvals half
 * succeeds — the shape of a PARTIAL read.
 *
 * A business-error envelope rather than a 401 on purpose: a refused credential
 * would additionally invalidate the transport and pull a whole replacement
 * generation into the test, and the fact being pinned here is narrower — half a
 * reading is not a reading, whatever else is or is not wrong with the server.
 */
let questionsFail = false;
/** Sessions the v2 roster lists. Ownership is applied by the adapter, not by the server. */
let rosterIds: string[] = [CREATED_ID, FOREIGN_ID];

/**
 * Route-level parking gates, so a test can hold ONE request open and order the
 * events around it deterministically.
 *
 * Held on the SERVER rather than in an injected client on purpose: the request
 * has genuinely arrived and been recorded — the prompt row exists, the page was
 * selected — and only the answer is late. That is the shape of the race being
 * pinned (upstream can publish `prompt.completed` before the submit's reply is
 * written), and a fake that never sent the request could not reproduce it.
 */
let holdPrompt: Promise<void> | undefined;
let holdMessages: Promise<void> | undefined;
/**
 * Parks the PENDING-INTERACTION read, and answers it from the state the request
 * ARRIVED in — see the snapshot in the route below. That is the shape of the
 * hazard: a reconciliation pass reads the cards, the generation behind it is
 * replaced while the read is out, and the answer that finally lands describes a
 * server this connection is no longer talking to.
 */
let holdApprovals: Promise<void> | undefined;
/**
 * Parks the IDENTITY read a re-resolution runs, so a content write can be held
 * INSIDE its door with the current socket still open.
 *
 * The stream-down park holds a write before the transport is touched; this one
 * holds it after — at `writeClient`, waiting for the generation that replaces a
 * refused one — which is the window in which a pre-dispatch claim recorded ahead
 * of the door would be live for a write that has not happened.
 */
let holdMeta: Promise<void> | undefined;
const gate = (): { hold: Promise<void>; release: () => void } => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release };
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    let body: unknown;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
    }
    const bearer = request.headers.get('authorization') ?? '';
    requests.push({
      method: request.method, path,
      ...(body !== undefined ? { body } : {}),
      ...(bearer ? { bearer } : {}),
    });

    if (path === '/api/v1/healthz') return Response.json(ok({ ok: true }));
    if (bearer !== `Bearer ${acceptedToken}`) {
      return Response.json({ code: 40101, msg: 'unauthorized', data: null, request_id: 'r' }, { status: 401 });
    }
    if (path === '/api/v1/meta') {
      // Parks the IDENTITY leg of a re-resolution, which is what a content
      // write's door waits on when the generation it was cleared against has
      // been refused — with the old socket still open the whole time. See
      // {@link holdMeta}.
      if (holdMeta) {
        const parked = holdMeta;
        holdMeta = undefined;
        await parked;
      }
      return Response.json(ok(SERVER_META));
    }
    if (path === '/api/v1/models') {
      return Response.json(ok({
        items: [
          { provider: 'kimi-code', model: 'k3-256k', display_name: 'K3 256k', max_context_size: 262_144, support_efforts: ['low', 'high'], default_effort: 'high' },
          { provider: 'kimi-code', model: 'k2', max_context_size: 131_072 },
          // Structurally broken: no `model`, so no selection token exists behind
          // it. Must be SKIPPED, never surfaced as an option the broker would
          // then validate a create against.
          { provider: 'kimi-code', display_name: 'nameless' },
        ],
      }));
    }
    if (path === '/api/v2/sessions') {
      return Response.json(ok({
        items: rosterIds.map((id) => ({
          id, workspace: { id: 'wd_0001', cwd: WORKSPACE },
          meta: { title: id, created_at: '2026-08-14T09:00:00.000Z', updated_at: '2026-08-14T09:00:00.000Z' },
          activity: { status: 'idle' },
        })),
        has_more: false,
      }));
    }
    if (request.method === 'POST' && path === '/api/v1/sessions') return Response.json(createAnswer);

    const session = path.match(/^\/api\/v1\/sessions\/([^/]+?)(?::(\w+))?(?:\/(.*))?$/);
    if (session) {
      const tail = session[3];
      const action = session[2];
      if (request.method === 'POST' && action === 'abort') return Response.json(abortAnswer);
      if (request.method === 'POST' && tail?.startsWith('approvals/')) {
        return Response.json(approvalResolveAnswer);
      }
      if (request.method === 'POST' && tail?.startsWith('questions/')) {
        return Response.json(tail.endsWith(':dismiss') ? dismissAnswer : questionAnswerAnswer);
      }
      if (request.method === 'POST' && tail === 'prompts') {
        if (holdPrompt) {
          const parked = holdPrompt;
          holdPrompt = undefined;
          await parked;
        }
        return Response.json(promptAnswer);
      }
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
      if (tail === 'messages') {
        if (holdMessages) {
          const parked = holdMessages;
          holdMessages = undefined;
          await parked;
        }
        const beforeId = url.searchParams.get('before_id');
        const pageSize = Number(url.searchParams.get('page_size') ?? '100');
        const start = beforeId ? messages.findIndex((row) => row.id === beforeId) + 1 : 0;
        const window = messages.slice(start, start + pageSize);
        return Response.json(ok({ items: window, has_more: start + window.length < messages.length }));
      }
      if (tail === 'status') {
        return Response.json(ok({ context_tokens: 100, max_context_tokens: 262_144, model: 'kimi-code/k3-256k' }));
      }
      if (tail === 'approvals') {
        // Chosen when the REQUEST arrives, never when the reply is released: a
        // parked read describes the generation that issued it. See
        // {@link holdApprovals}.
        const items = pendingApprovals;
        if (holdApprovals) {
          const parked = holdApprovals;
          holdApprovals = undefined;
          await parked;
        }
        return Response.json(ok({ items }));
      }
      if (tail === 'questions') {
        return Response.json(questionsFail
          ? { code: 50_001, msg: 'questions unavailable', data: null, request_id: 'r' }
          : ok({ items: pendingQuestions }));
      }
      if (!tail) return Response.json(sessionRowAnswer);
    }
    return Response.json({ code: 40401, msg: 'not found', data: null, request_id: 'r' });
  },
});

const baseUrl = `http://127.0.0.1:${server.port ?? 0}`;
const liveScan: KimiInstanceScan = {
  live: [{ baseUrl, port: server.port ?? 0, serverId: SERVER_ID, hostVersion: '0.35.0', startedAt: SERVER_STARTED_AT }],
  stale: 0, invalid: 0, truncated: false,
};

// ── Fake socket ─────────────────────────────────────────────────────────────

const sockets: FakeSocket[] = [];
class FakeSocket implements KimiSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  /** Was `close()` actually CALLED on this socket? Retirement is otherwise invisible. */
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor() { sockets.push(this); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; this.fire('close', {}); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  deliver(frame: unknown): void { this.fire('message', { data: JSON.stringify(frame) }); }
}

/**
 * Opens on the next macrotask, the way a real loopback socket does — unless the
 * test has taken the handshake into its own hands.
 *
 * The flag exists because "constructed" and "open" are now different states with
 * different consequences, and the window between them is exactly what several
 * checks below are about: a server that accepts the TCP connection and then says
 * nothing produces a socket object that never fires `open`.
 */
let socketsOpenAutomatically = true;
function openingSocketFactory(): KimiSocketLike {
  const socket = new FakeSocket();
  if (socketsOpenAutomatically) setTimeout(() => socket.fire('open', {}), 0);
  return socket;
}

let seq = 0;
/**
 * The REAL envelope: routing at the top level, the event itself nested under
 * `payload` with the broadcaster's camelCase `agentId`/`sessionId` stamped on
 * (`sessionEventBroadcaster.ts:1308-1322`).
 */
const frame = (type: string, payload: Record<string, unknown> = {}, sessionId = CREATED_ID) => {
  seq += 1;
  return {
    type, seq, epoch: 'ep_drive', session_id: sessionId, timestamp: '2026-08-14T09:00:00.000Z',
    payload: { type, agentId: 'main', sessionId, ...payload },
  };
};

let intervalHandler: (() => void) | undefined;

/**
 * A Kimi adapter with the DRIVE GATE ON, which is what makes the create surface
 * exist at all.
 *
 * The gate (`COSYNCING_KIMI_DRIVE`) is default-off as a controlled rollout of
 * the write surface — foreground clients DO request `mode='live'` — and with it
 * off `createSession` and friends are ABSENT rather than throwing, so a suite
 * about Drive has to ask for the posture it is testing. The return type says the
 * same thing in the type system: these four are present here, and a reader who
 * forgets the gate gets a compile error rather than a runtime one.
 */
type DrivingKimiAdapter = KimiAdapter
  & Required<Pick<KimiAdapter, 'createSession' | 'canCreateSession' | 'prepareCreateSession' | 'listModels'>>;

interface AdapterOverrides {
  socketFactory?: () => KimiSocketLike;
  readToken?: () => string | undefined;
  writeFetchImpl?: KimiWriteFetch;
  liveAttachSocketMs?: number;
  writeStreamWaitMs?: number;
}

function makeAdapter(scan: KimiInstanceScan = liveScan, overrides: AdapterOverrides = {}): DrivingKimiAdapter {
  return new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    drive: true,
    instanceScan: () => scan,
    readToken: overrides.readToken ?? (() => 'fixture-token'),
    ...(overrides.writeFetchImpl ? { writeFetchImpl: overrides.writeFetchImpl } : {}),
    // Short enough that a socket which never opens costs the suite nothing;
    // the production ceilings are asserted separately from their constants.
    liveAttachSocketMs: overrides.liveAttachSocketMs ?? 200,
    writeStreamWaitMs: overrides.writeStreamWaitMs ?? 200,
    observe: {
      socketFactory: overrides.socketFactory ?? openingSocketFactory,
      setInterval: (handler) => { intervalHandler = handler; return 1; },
      clearInterval: () => { intervalHandler = undefined; },
    },
  }) as DrivingKimiAdapter;
}

/** A socket that is CONSTRUCTED and never opens — a server that accepts the TCP connection and says nothing. */
function silentSocketFactory(): KimiSocketLike {
  return new FakeSocket();
}

const settle = () => Bun.sleep(30);
const threw = async (work: () => Promise<unknown>): Promise<Error | undefined> =>
  work().then(() => undefined, (error: Error) => error);

/**
 * Waits for the REPLACEMENT socket after a reconnect, and returns that exact
 * object so a frame can be delivered to it rather than to whatever happens to
 * be last in {@link sockets}.
 *
 * Two conditions, because either alone is a lie:
 *
 *  - a DISTINCT socket, since the retired one stays in the array; and
 *  - one whose `open` handler has actually RUN, proven by `client_hello` — the
 *    first frame `openSocket` sends. Listeners are installed synchronously at
 *    construction, so their presence proves nothing; `client_hello` is what
 *    proves the open handler ran and this socket became the CURRENT usable
 *    stream. `observe.ts` silently drops frames delivered to any socket that is
 *    not `this.socket`.
 *
 * A fixed sleep cannot express this. Reopening is deferred to the poll tick,
 * and `restoreSocket` re-resolves the whole generation over HTTP — a real
 * request against the fixture server — BEFORE it constructs the socket. How
 * long that takes is a property of the machine, not of the code under test, so
 * a sleep that is long enough today silently becomes a race tomorrow. Waiting
 * on the condition makes a slow re-verification cost time instead of accuracy.
 */
async function replacementSocket(
  retired: FakeSocket | undefined,
  timeoutMs = 5_000,
): Promise<FakeSocket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = sockets.at(-1);
    if (candidate
      && candidate !== retired
      && candidate.sent.some((sent) => sent.type === 'client_hello')) return candidate;
    if (Date.now() >= deadline) {
      throw new Error(
        `no replacement socket opened within ${timeoutMs}ms (sockets=${sockets.length}, `
        + `newest is ${candidate === retired ? 'still the retired one' : 'constructed but unopened'})`,
      );
    }
    await Bun.sleep(1);
  }
}

/**
 * A walk-COMPLETION barrier for the post-reconnect sequences below.
 *
 * Socket-open readiness is not this barrier: the poll tick starts its own
 * walk the moment the generation re-resolves, and `refresh()` COALESCES on
 * that busy slot (`observe.ts`, `runExclusiveWalk`), so an awaited `refresh()`
 * can return having run no walk at all. `settleContent` is the production
 * primitive written for exactly this ordering (`drive.ts` uses it to land a
 * send after the rows that belong before it): it waits the in-flight walk
 * out, then runs one more to completion. The cast reaches a protected member
 * the way the interaction-record checks elsewhere in this suite already do,
 * without growing the public surface for a test.
 */
const walkedAfterReconnect = (conn: KimiDriveConnection): Promise<void> =>
  (conn as unknown as { settleContent: () => Promise<void> }).settleContent();

/**
 * Fail a bounded wait with its own diagnostic instead of riding the suite
 * timeout. A barrier that awaits production work without one turns a stuck
 * walk into a 90-second hang that blames the whole suite — exactly the kind
 * of timing-dependent gate failure this change exists to remove.
 */
const withinDeadline = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Wait out the walk currently holding the slot — and NOTHING more.
 *
 * This is the barrier the explained-outage blocks actually need, and the
 * stronger {@link walkedAfterReconnect} is actively WRONG there: the tick's
 * own post-reconnect walk is what ARMS the held row (polls=1), so a barrier
 * that then runs one more walk runs the CONFIRMING walk — the suspect reaches
 * {@link KIMI_DIVERGENCE_CONFIRM_POLLS} and demotes before the test has even
 * delivered the explanation. Whether that happened depended on whether the
 * tick walk's evaluation or the barrier's second walk came first, which is
 * machine timing: the intermittent demotion this suite kept showing on CI.
 *
 * After the reconnect the only walk that can exist is the tick's — the timer
 * is test-driven and nothing else triggers one — so once the slot is idle the
 * detector state reflects exactly one post-reconnect evaluation, and the
 * frame delivered next genuinely precedes the second walk.
 */
const waitOutWalk = async (conn: KimiDriveConnection, timeoutMs = 5_000): Promise<void> => {
  const walk = conn as unknown as { refreshing: boolean; activeWalk?: Promise<void> };
  const deadline = Date.now() + timeoutMs;
  while (walk.refreshing) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('the in-flight transcript walk never settled — the slot stayed busy past the deadline');
    }
    // `refreshing` and `activeWalk` are set in one synchronous frame, so a
    // busy slot always has its promise.
    await withinDeadline(walk.activeWalk!, remaining, 'the in-flight transcript walk');
  }
};

/** Transcript reads the fixture has SERVED so far — the observable half of a walk. */
const transcriptReads = (): number =>
  requests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/messages')).length;

/**
 * Is the detector holding any row whose provenance is still open? Read through
 * the same cast pattern as the other private-state checks in this suite —
 * `provenancePending` stays private production state.
 */
const provenanceOpen = (conn: KimiDriveConnection): boolean =>
  (conn as unknown as { provenancePending: boolean }).provenancePending;

/**
 * An outage-HOLD barrier: resolves once the row the block just added is
 * genuinely held as unresolved — observed under a DOWN stream, which is the
 * whole premise of the explained-outage blocks below.
 *
 * `await conn.refresh()` cannot promise this. The socket's own close listener
 * fires a refresh that re-resolves the generation over HTTP before it walks
 * (`observe.ts`), and on a slow machine that walk is still in flight when a
 * fixed settle ends: the test's refresh then COALESCES on the busy slot, the
 * row is never seen while the stream is down, and when a walk finally reads
 * it after the replacement socket has opened, the detector quite correctly
 * treats it as a row that appeared under a healthy, silent stream — suspects
 * it, and confirms it to a demotion before the explanatory frame is even
 * delivered. Polling the detector's own provenance state — and nudging a
 * refresh each round, so the walk that makes it true is never missing — turns
 * "the outage saw the row" into the condition it always needed to be. While
 * the stream is down no healthy evaluation can run, so a pending provenance
 * here can only BE the unresolved hold.
 */
async function heldRow(conn: KimiDriveConnection, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (provenanceOpen(conn)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('the outage row was never held — no walk observed it while the stream was down');
    }
    // The refresh itself is bounded by the same deadline: an unbounded await
    // here would keep the deadline from ever firing on a stuck walk.
    await withinDeadline(conn.refresh(), remaining, 'a refresh while waiting for the outage hold');
    await Bun.sleep(1);
  }
}

try {
  // ── 1. createSession ──────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    // NEGATIVE CONTROL: a create with no directory must not reach the network
    // at all. The server never creates the path, so cosyncing would be inventing
    // a workspace root — and a create that half-happened is worse than one that
    // refused.
    const before = requests.length;
    const refused = await threw(() => adapter.createSession({}));
    check('a create with no directory refuses and issues no HTTP at all',
      !!refused && /working directory/.test(refused.message) && requests.length === before,
      `${refused?.message} calls=${requests.length - before}`);

    const created = await adapter.createSession({
      directory: WORKSPACE,
      title: 'from cosyncing',
      model: { providerID: 'kimi-code', modelID: 'k3-256k', reasoningEffort: 'high' },
    });
    const post = writes().find((entry) => entry.path === '/api/v1/sessions');
    check('create posts the cwd as workspace metadata and nothing else',
      JSON.stringify(post?.body) === JSON.stringify({ title: 'from cosyncing', metadata: { cwd: WORKSPACE } }),
      JSON.stringify(post?.body));
    // `agent_config` parses upstream and is then ignored by the handler, so
    // sending it would look like a model selection that silently did nothing.
    check('create sends no agent_config, which the server would ignore',
      !JSON.stringify(post?.body ?? {}).includes('agent_config'), JSON.stringify(post?.body));
    check('the created session maps from the FLAT v1 row',
      created.id === CREATED_ID && created.title === 'from cosyncing'
        && created.cwd === WORKSPACE && created.status === 'idle' && created.launchSurface === 'app',
      JSON.stringify(created));
    // This exact shape is what `sessionConnectionAuthority` reads to grant
    // `canMutate`, and what routes `createdSessionAttachMode` to a BARE attach.
    check('the created session carries the owned control matrix',
      created.attachMode === 'live'
        && created.control?.drive.supported === true
        && created.control.drive.state === 'driving'
        && created.control.terminalSync.supported === false
        && created.control.terminalSync.syncAvailable === false
        && created.control.terminalSync.active === false
        && created.control.terminalSync.reason === 'kimi-server-owned',
      JSON.stringify(created.control));
    check('the requested model is advertised so the picker preselects it',
      created.model === 'k3-256k' && created.currentModel?.modelID === 'k3-256k'
        && created.currentModel.reasoningEffort === 'high',
      JSON.stringify(created.currentModel));

    const models = await adapter.listModels();
    check('the model catalog maps totally and skips the malformed item',
      models.length === 2 && models[0]?.modelID === 'k3-256k' && models[0].label === 'K3 256k'
        && JSON.stringify(models[0].reasoningEfforts) === JSON.stringify([
          { effort: 'low', label: 'low' }, { effort: 'high', label: 'high' },
        ])
        && models[0].defaultReasoningEffort === 'high'
        // No display_name upstream: the alias id is the honest label.
        && models[1]?.label === 'k2' && models[1].reasoningEfforts === undefined,
      JSON.stringify(models));
  }

  {
    const down = makeAdapter({ live: [], stale: 1, invalid: 0, truncated: false });
    check('a down server cannot create', (await down.canCreateSession()) === false);
    const error = await threw(() => down.prepareCreateSession());
    check('a down server fails the readiness boundary with the typed 503 error',
      isSessionCreateTemporarilyUnavailableError(error)
        && error.detailCode === 'kimi-server-unavailable'
        && /kimi web/.test(error.message),
      `${error?.name} ${error?.message}`);
    // The boundary must CREATE NOTHING — that is its whole contract.
    check('the readiness boundary issued no create',
      writes().every((entry) => entry.path !== '/api/v1/sessions' || entry.body !== undefined),
      writes().map((entry) => entry.path).join(','));
  }

  // ── 2. Attach routing ─────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });

    // A BARE attach never acquires Drive, however owned the session is.
    // Ownership is permission; the MODE is the request. The hub keys an absent
    // mode and 'observe' onto the same `tool:id` connection (hub.ts:996-1000),
    // so a drive connection created for a no-mode attach becomes the connection
    // every later bare attach folds onto — including the client's background
    // Observe watcher, which is documented never to acquire Drive — and each of
    // those clients would inherit canMutate from this info.control.
    const beforeBare = writes().length;
    const bare = await adapter.attach(CREATED_ID);
    const bareMutation = await threw(() => bare.sendPrompt({ text: 'nope' }));
    check('an owned session BARE-attaches observe, with drive still SUPPORTED',
      !(bare instanceof KimiDriveConnection)
        && bare instanceof KimiObserveConnection
        && bare.info.attachMode === 'observe'
        && bare.info.control?.drive.supported === true
        && bare.info.control.drive.state === 'observing'
        && !!bareMutation,
      `${bare.constructor.name} ${JSON.stringify(bare.info.control)} threw=${!!bareMutation}`);
    // NEGATIVE CONTROL: the whole point is the ABSENCE of a write. A bare attach
    // plus a refused prompt must not have posted anything at all.
    check('a bare attach on an owned session issues ZERO writes',
      writes().length === beforeBare, `writes=${writes().length - beforeBare}`);
    await bare.close();

    // The EXPLICIT request is what acquires Drive, and it lands on the hub's
    // separate `tool:id#live` key, which is what makes the authority
    // socket-local rather than shared with every observer.
    const live = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    check('an EXPLICIT mode=live on the same owned session drives it',
      live instanceof KimiDriveConnection && live.info.attachMode === 'live'
        && live.info.control?.drive.state === 'driving' && live.info.control.drive.supported === true,
      `${live.constructor.name} ${JSON.stringify(live.info.control)}`);
    await live.close();

    const observing = await adapter.attach(CREATED_ID, 'observe');
    const observeMutation = await threw(() => observing.sendPrompt({ text: 'nope' }));
    check('an owned session opened in observe is read-only, with drive still SUPPORTED',
      !(observing instanceof KimiDriveConnection)
        && observing instanceof KimiObserveConnection
        && observing.info.attachMode === 'observe'
        && observing.info.control?.drive.supported === true
        && observing.info.control.drive.state === 'observing'
        && !!observeMutation,
      `${JSON.stringify(observing.info.control)} threw=${!!observeMutation}`);
    await observing.close();

    // Kimi is the converse of dsh: it serves a real read-only observe
    // connection (proven directly above), so handing Drive back to the terminal
    // leaves the session attached rather than stranded. The declaration and the
    // capability have to agree — a row claiming handoff on an agent the broker
    // would refuse is exactly the mismatch this field exists to prevent.
    check('a driving kimi row declares terminal handoff available, matching its observe capability',
      live.info.control?.drive.handoffAvailable === true
        && adapter.capabilities.attachModes?.includes('observe') === true,
      `${JSON.stringify(live.info.control?.drive)} modes=${JSON.stringify(adapter.capabilities.attachModes)}`);

    const conflict = await threw(() => adapter.attach(FOREIGN_ID, 'live'));
    check('a foreign session refuses a live attach with the typed conflict',
      isOwnershipConflictError(conflict) && conflict.conflict === 'kimi-foreign-session'
        && /terminal/.test(conflict.message),
      `${conflict?.name} ${(conflict as { conflict?: string } | undefined)?.conflict}`);

    const foreign = await adapter.attach(FOREIGN_ID);
    check('a foreign session bare-attaches OBSERVE, unchanged from K1',
      !(foreign instanceof KimiDriveConnection)
        && foreign.info.attachMode === 'observe'
        && foreign.info.control?.drive.supported === false
        && foreign.info.control.drive.reason === 'kimi-terminal-owned',
      JSON.stringify(foreign.info.control));
    await foreign.close();

    const roster = await adapter.discoverSessions();
    check('the roster marks the owned row driveable and the foreign row not',
      roster.find((row) => row.id === CREATED_ID)?.control?.drive.state === 'driving'
        && roster.find((row) => row.id === FOREIGN_ID)?.control?.drive.supported === false,
      roster.map((row) => `${row.id}:${row.attachMode}`).join(','));
  }

  // ── 3. sendPrompt ─────────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({
      directory: WORKSPACE,
      model: { providerID: 'kimi-code', modelID: 'k3-256k', reasoningEffort: 'high' },
    });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();

    await conn.sendPrompt({ text: 'first', permissionMode: 'auto' });
    const first = writes().at(-1);
    check('the first prompt carries the create-time model, the effort as `thinking`, and the mode',
      first?.path === `/api/v1/sessions/${CREATED_ID}/prompts`
        && JSON.stringify(first.body) === JSON.stringify({
          content: [{ type: 'text', text: 'first' }],
          model: 'k3-256k', thinking: 'high', permission_mode: 'auto',
        }),
      JSON.stringify(first?.body));

    promptAnswer = ok({ prompt_id: 'prompt_2', user_message_id: 'msg_user_2', status: 'queued', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'second' });
    const second = writes().at(-1);
    check('the pending model is spent ONCE: the second prompt carries no model',
      JSON.stringify(second?.body) === JSON.stringify({ content: [{ type: 'text', text: 'second' }] }),
      JSON.stringify(second?.body));

    promptAnswer = ok({ prompt_id: 'prompt_3', user_message_id: 'msg_user_3', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'third', model: { providerID: 'kimi-code', modelID: 'k2' } });
    check('an explicit per-prompt model is sent as itself',
      JSON.stringify(writes().at(-1)?.body) === JSON.stringify({
        content: [{ type: 'text', text: 'third' }], model: 'k2',
      }),
      JSON.stringify(writes().at(-1)?.body));

    // An unadvertised permission mode must not be forwarded: the server would
    // reject the whole submission as a schema violation, costing the user the
    // prompt rather than one ignored option.
    promptAnswer = ok({ prompt_id: 'prompt_4', user_message_id: 'msg_user_4', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'fourth', permissionMode: 'a-mode-from-the-future' });
    check('an unknown permission mode is dropped rather than sent',
      !JSON.stringify(writes().at(-1)?.body).includes('permission_mode'),
      JSON.stringify(writes().at(-1)?.body));

    // NEGATIVE CONTROL: file/image input is refused BEFORE the transport is
    // touched. Sending the text alone would silently drop the attachment.
    const beforeFiles = requests.length;
    const withFile = await threw(() => conn.sendPrompt({
      text: 'here you go', files: [{ name: 'a.txt', path: '/tmp/a.txt' } as never],
    }));
    const withImage = await threw(() => conn.sendPrompt({
      text: 'look', images: [{ data: 'x', mediaType: 'image/png' } as never],
    }));
    check('files and images are refused with zero HTTP issued',
      !!withFile && !!withImage
        && withFile.message === KIMI_NO_FILE_INPUT_MESSAGE
        && withImage.message === KIMI_NO_FILE_INPUT_MESSAGE
        && requests.length === beforeFiles,
      `calls=${requests.length - beforeFiles}`);

    // The echo comes from the SERVER, and the correlation token is stamped on
    // the row whose native id the submission handed back.
    promptAnswer = ok({ prompt_id: 'prompt_5', user_message_id: 'msg_user_5', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'correlate me', clientMessageId: 'client-abc' });
    messages = [userRow('msg_user_5', 'correlate me'), userRow('msg_user_other', 'typed in the terminal')];
    await conn.refresh();
    const echoes = rows.filter((row): row is Extract<AgentMessage, { type: 'user-message' }> => row.type === 'user-message');
    const mine = echoes.find((row) => row.text === 'correlate me');
    const theirs = echoes.find((row) => row.text === 'typed in the terminal');
    check('the echo of OUR send carries the clientKey',
      mine?.clientKey === 'client-abc', JSON.stringify(mine));
    // NEGATIVE CONTROL: a user row we did not send must carry no correlation.
    // Equal text is never identity, and a wrongly stamped key converges the
    // client's optimistic bubble onto somebody else's message.
    check('a user row we did not send carries NO clientKey',
      !!theirs && theirs.clientKey === undefined, JSON.stringify(theirs));
    await conn.close();
  }

  // ── 3b. A create-time model is spent by a PROMPT, not by an attach ────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({
      directory: WORKSPACE,
      model: { providerID: 'kimi-code', modelID: 'k3-256k', reasoningEffort: 'high' },
    });

    // Opened and closed WITHOUT prompting — a client that opened the session and
    // backed out, or an attach whose socket died. Nothing was applied, so
    // nothing may be forgotten: handing a connection out spends no model.
    const abandoned = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    await abandoned.close();

    const second = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    promptAnswer = ok({ prompt_id: 'prompt_survivor', user_message_id: 'msg_survivor', status: 'running', content: [], created_at: 'x' });
    await second.sendPrompt({ text: 'first real prompt' });
    check('a create-time model survives an attach that closed before prompting',
      JSON.stringify(writes().at(-1)?.body) === JSON.stringify({
        content: [{ type: 'text', text: 'first real prompt' }], model: 'k3-256k', thinking: 'high',
      }),
      JSON.stringify(writes().at(-1)?.body));
    await second.close();

    // ...and is SPENT the moment it is actually sent. Re-pinning the create-time
    // choice onto a later attach would make one create decide every future turn.
    const third = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    promptAnswer = ok({ prompt_id: 'prompt_after', user_message_id: 'msg_after', status: 'running', content: [], created_at: 'x' });
    await third.sendPrompt({ text: 'later prompt' });
    check('a spent create-time model is not re-pinned by a later attach',
      JSON.stringify(writes().at(-1)?.body) === JSON.stringify({
        content: [{ type: 'text', text: 'later prompt' }],
      }),
      JSON.stringify(writes().at(-1)?.body));
    await third.close();
  }

  // ── 4. Stop ───────────────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;

    check('the command list is the single stop action',
      JSON.stringify(await conn.listCommands()) === JSON.stringify([
        { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      ]),
      JSON.stringify(await conn.listCommands()));

    abortAnswer = ok({ aborted: true });
    const stopped = await conn.runCommand('stop');
    check('stop posts the colon action suffix on the session id',
      writes().at(-1)?.path === `/api/v1/sessions/${CREATED_ID}:abort`
        && stopped?.notice === KIMI_STOP_NOTICE,
      `${writes().at(-1)?.path} ${stopped?.notice}`);

    const aliased = await conn.runCommand('abort');
    check('`abort` is accepted as the same action', aliased?.notice === KIMI_STOP_NOTICE);

    // 40903 `PROMPT_ALREADY_COMPLETED` rides a nonzero envelope with a
    // success-shaped payload. Treating it as an error would make an idempotent
    // stop look broken.
    abortAnswer = fail(40903, { aborted: false });
    const late = await conn.runCommand('stop');
    check('an already-finished turn reports success, not failure',
      late?.notice === KIMI_STOP_ALREADY_DONE_NOTICE, late?.notice);

    // An honest `{aborted:false}` on code 0 says the same thing.
    abortAnswer = ok({ aborted: false });
    check('an honest aborted:false is read rather than assumed',
      (await conn.runCommand('stop'))?.notice === KIMI_STOP_ALREADY_DONE_NOTICE);
    abortAnswer = ok({ aborted: true });

    const unknown = await threw(() => conn.runCommand('compact'));
    check('an unadvertised command is refused', !!unknown && /compact/.test(unknown.message), unknown?.message);

    const modes = await conn.listModes();
    check('the mode picker offers the server\'s three permission modes with universal categories',
      JSON.stringify(modes) === JSON.stringify([
        { value: 'manual', label: 'Manual approvals', category: 'ask-permission' },
        { value: 'auto', label: 'Auto-approve tools', category: 'approve-for-me' },
        { value: 'yolo', label: 'Approve everything', category: 'full-access' },
      ]),
      JSON.stringify(modes));
    check('the connection model list matches the adapter catalog',
      (await conn.listModels()).map((model) => model.modelID).join(',') === 'k3-256k,k2');
    await conn.close();
  }

  // ── 5. Approvals ──────────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();
    const socket = sockets.at(-1)!;

    // NEGATIVE CONTROL for the detail cap: a tool input far past the ceiling.
    const huge = 'x'.repeat(KIMI_APPROVAL_DETAIL_CAP_BYTES * 3);
    socket.deliver(frame('event.approval.requested', {
      approval_id: 'ap_1', session_id: CREATED_ID, tool_call_id: 'call_1',
      tool_name: 'Bash', action: 'run command', tool_input_display: { command: huge },
      created_at: '2026-08-14T09:00:00.000Z', expires_at: '2026-08-15T09:00:00.000Z',
    }));
    const card = rows.find((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request');
    check('an approval request becomes an actionable permission card',
      card?.requestId === 'ap_1' && card.title === 'Bash — run command'
        && card.toolName === 'Bash' && card.readOnly === undefined,
      JSON.stringify({ ...card, detail: `${card?.detail?.length} chars` }));
    check('a huge tool input is truncated at the cap and SAYS it was truncated',
      !!card?.detail && card.detail.length < huge.length
        && card.detail.endsWith('… (truncated)')
        && card.detail.length <= KIMI_APPROVAL_DETAIL_CAP_BYTES + 32,
      `${card?.detail?.length} chars, cap=${KIMI_APPROVAL_DETAIL_CAP_BYTES}`);

    approvalResolveAnswer = ok({ resolved: true, resolved_at: 'x' });
    await conn.respondPermission('ap_1', 'approve');
    const approved = writes().at(-1);
    await conn.respondPermission('ap_2', 'approve-session');
    const scoped = writes().at(-1);
    await conn.respondPermission('ap_3', 'reject');
    const rejected = writes().at(-1);
    check('the three decisions map to the exact native bodies',
      JSON.stringify(approved?.body) === JSON.stringify({ decision: 'approved' })
        && JSON.stringify(scoped?.body) === JSON.stringify({ decision: 'approved', scope: 'session' })
        && JSON.stringify(rejected?.body) === JSON.stringify({ decision: 'rejected' })
        && approved?.path === `/api/v1/sessions/${CREATED_ID}/approvals/ap_1`,
      `${JSON.stringify(approved?.body)} ${JSON.stringify(scoped?.body)} ${JSON.stringify(rejected?.body)}`);

    // 40902 means another client answered first: the card is settled, which is
    // the outcome the caller asked for.
    approvalResolveAnswer = fail(40902, { resolved: false });
    const duplicate = await threw(() => conn.respondPermission('ap_4', 'approve'));
    check('a duplicate resolve (40902) is a success, not an error', duplicate === undefined, duplicate?.message);
    approvalResolveAnswer = ok({ resolved: true, resolved_at: 'x' });

    socket.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_1', decision: 'approved', resolved_at: 'x',
    }));
    socket.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_foreign', decision: 'rejected', resolved_at: 'x',
    }));
    const resolutions = rows.filter((row): row is Extract<AgentMessage, { type: 'permission-resolved' }> =>
      row.type === 'permission-resolved');
    check('our own resolution reports the decision we made',
      resolutions.find((row) => row.requestId === 'ap_1')?.decision === 'approve',
      JSON.stringify(resolutions));
    // A resolution nobody here initiated was settled by another client of the
    // shared owner — a terminal, say. Reporting it as a decision would
    // attribute that user's choice to this one.
    check('a resolution we did not initiate reports as external',
      resolutions.find((row) => row.requestId === 'ap_foreign')?.decision === 'external',
      JSON.stringify(resolutions));

    // `ap_4` is the card another client settled first (the 40902 above). We
    // ASKED to approve it and the server then broadcasts their REJECT: the
    // outcome belongs to them, so the row must say external rather than dress
    // their choice up as this user's. Losing that distinction is how a user
    // ends up believing they rejected something they tried to approve.
    socket.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_4', decision: 'rejected', resolved_at: 'x',
    }));
    const raced = rows.filter((row): row is Extract<AgentMessage, { type: 'permission-resolved' }> =>
      row.type === 'permission-resolved').find((row) => row.requestId === 'ap_4');
    check('a resolve that LOST the 40902 race reports as external, not as ours',
      raced?.decision === 'external', JSON.stringify(raced));
    await conn.close();
  }

  // ── 6. Questions ──────────────────────────────────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();
    const socket = sockets.at(-1)!;

    // Fixture-shaped ids: `q_<idx>` items with `opt_<item>_<option>` options,
    // exactly as `routes/questions.ts:296-324` synthesizes them.
    const questionPayload = {
      question_id: 'qn_1', session_id: CREATED_ID, created_at: 'x',
      questions: [
        {
          id: 'q_0', question: 'Pick one', header: 'Framework',
          options: [
            { id: 'opt_0_0', label: 'Alpha', description: 'the first' },
            { id: 'opt_0_1', label: 'Beta' },
          ],
          allow_other: true,
        },
        {
          id: 'q_1', question: 'Pick many', multi_select: true,
          options: [{ id: 'opt_1_0', label: 'One' }, { id: 'opt_1_1', label: 'Two' }],
          allow_other: true,
        },
        {
          id: 'q_2', question: 'Free text welcome',
          options: [{ id: 'opt_2_0', label: 'Preset' }, { id: 'opt_2_1', label: 'Other preset' }],
          allow_other: true,
        },
        {
          id: 'q_3', question: 'Optional',
          options: [{ id: 'opt_3_0', label: 'Yes' }, { id: 'opt_3_1', label: 'No' }],
          allow_other: false,
        },
      ],
    };
    socket.deliver(frame('event.question.requested', questionPayload));
    const question = rows.find((row): row is Extract<AgentMessage, { type: 'question-request' }> =>
      row.type === 'question-request');
    check('a question request becomes a labelled, actionable card',
      question?.requestId === 'qn_1' && question.readOnly === undefined
        && question.questions.length === 4
        && question.questions[0]?.header === 'Framework'
        && JSON.stringify(question.questions[0]?.options) === JSON.stringify([
          { label: 'Alpha', description: 'the first' }, { label: 'Beta' },
        ])
        && question.questions[1]?.multiple === true
        && question.questions[0]?.multiple === undefined,
      JSON.stringify(question));
    // No Kimi-native field name may reach the client through this card.
    check('the card leaks no native option or item id',
      !/opt_\d|q_\d|multi_select|allow_other/.test(JSON.stringify(question)),
      JSON.stringify(question));

    await conn.answerQuestion('qn_1', [['Beta'], ['One', 'Two'], ['something of my own'], []]);
    const answer = writes().at(-1);
    check('answers translate labels back into the exact native union',
      answer?.path === `/api/v1/sessions/${CREATED_ID}/questions/qn_1`
        && JSON.stringify(answer.body) === JSON.stringify({
          answers: {
            q_0: { kind: 'single', option_id: 'opt_0_1' },
            q_1: { kind: 'multi', option_ids: ['opt_1_0', 'opt_1_1'] },
            q_2: { kind: 'other', text: 'something of my own' },
            q_3: { kind: 'skipped' },
          },
        }),
      JSON.stringify(answer?.body));

    // A multi-select carrying both known labels and free text is the union's
    // `multi_with_other` variant, which is the only shape that can express it.
    socket.deliver(frame('event.question.requested', { ...questionPayload, question_id: 'qn_2' }));
    await conn.answerQuestion('qn_2', [[], ['One', 'invented'], [], []]);
    check('a multi-select with free text uses multi_with_other',
      JSON.stringify((writes().at(-1)?.body as { answers?: Record<string, unknown> })?.answers?.q_1)
        === JSON.stringify({ kind: 'multi_with_other', option_ids: ['opt_1_0'], other_text: 'invented' }),
      JSON.stringify(writes().at(-1)?.body));

    // An item that does NOT allow free text cannot express one, and inventing an
    // option id the server never issued is the failure with no recovery. Nor may
    // it be reported as `skipped`: that announces an intentional skip the user
    // never made. NEGATIVE CONTROL on the zero-write refusal.
    socket.deliver(frame('event.question.requested', { ...questionPayload, question_id: 'qn_3' }));
    const beforeUnrepresentable = requests.length;
    const unrepresentable = await threw(() => conn.answerQuestion('qn_3', [[], [], [], ['not an option']]));
    check('an unrepresentable selection refuses with ZERO HTTP, never a fabricated skip',
      !!unrepresentable && /does not accept free text/.test(unrepresentable.message)
        && requests.length === beforeUnrepresentable,
      `${unrepresentable?.message} calls=${requests.length - beforeUnrepresentable}`);
    // ...while a genuinely EMPTY selection is a real skip and still sends.
    await conn.answerQuestion('qn_3', [['Alpha'], [], [], []]);
    check('an empty selection is still a real skip',
      JSON.stringify((writes().at(-1)?.body as { answers?: Record<string, unknown> })?.answers?.q_3)
        === JSON.stringify({ kind: 'skipped' }),
      JSON.stringify(writes().at(-1)?.body));

    // ── Ids are READ, never minted ──────────────────────────────────────────
    //
    // The server always names its items and options (`routes/questions.ts:299-322`),
    // and resolves an id it does not recognize by using the id STRING as the
    // answer text (`routes/questions.ts:381-403`) — so a minted `opt_0_1` is
    // delivered to the model as the literal answer "opt_0_1", and a minted item
    // id keys a question that was never asked. A payload that names nothing is
    // therefore unanswerable, not an invitation to guess.
    socket.deliver(frame('event.question.requested', {
      question_id: 'qn_no_ids', session_id: CREATED_ID, created_at: 'x',
      questions: [{
        question: 'Which one?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
        allow_other: false,
      }],
    }));
    const unkeyableCard = rows.filter((row): row is Extract<AgentMessage, { type: 'question-request' }> =>
      row.type === 'question-request').find((row) => row.requestId === 'qn_no_ids');
    check('a question whose payload names no ids is still DELIVERED, marked read-only',
      unkeyableCard?.readOnly === true
        && unkeyableCard.questions[0]?.question === 'Which one?'
        && JSON.stringify(unkeyableCard.questions[0]?.options)
          === JSON.stringify([{ label: 'Alpha' }, { label: 'Beta' }]),
      JSON.stringify(unkeyableCard));
    const beforeUnkeyable = requests.length;
    const unkeyable = await threw(() => conn.answerQuestion('qn_no_ids', [['Alpha']]));
    check('answering an unkeyable question refuses with ZERO HTTP',
      !!unkeyable && /will not invent identifiers/.test(unkeyable.message)
        && requests.length === beforeUnkeyable,
      `${unkeyable?.message} calls=${requests.length - beforeUnkeyable}`);

    // One missing OPTION id is enough: the answer body keys every item at once,
    // so a partially-named question cannot be partially answered.
    socket.deliver(frame('event.question.requested', {
      question_id: 'qn_partial_ids', session_id: CREATED_ID, created_at: 'x',
      questions: [{
        id: 'q_0', question: 'Which one?',
        options: [{ id: 'opt_0_0', label: 'Alpha' }, { label: 'Beta' }],
        allow_other: false,
      }],
    }));
    const partialCard = rows.filter((row): row is Extract<AgentMessage, { type: 'question-request' }> =>
      row.type === 'question-request').find((row) => row.requestId === 'qn_partial_ids');
    const beforePartial = requests.length;
    const partial = await threw(() => conn.answerQuestion('qn_partial_ids', [['Alpha']]));
    check('an option with no native id makes the whole question unanswerable, with ZERO HTTP',
      partialCard?.readOnly === true
        && !!partial && /will not invent identifiers/.test(partial.message)
        && requests.length === beforePartial,
      `${partial?.message} calls=${requests.length - beforePartial}`);

    socket.deliver(frame('event.question.requested', { ...questionPayload, question_id: 'qn_4' }));
    const dismissed = await threw(() => conn.rejectQuestion('qn_4'));
    check('a dismiss posts the colon suffix and reads 40909 as success',
      dismissed === undefined && writes().at(-1)?.path === `/api/v1/sessions/${CREATED_ID}/questions/qn_4:dismiss`,
      `${dismissed?.message} ${writes().at(-1)?.path}`);

    // NEGATIVE CONTROL: without the retained native ids there is nothing to send
    // but invented ones, so the refusal happens before any HTTP.
    const beforeUnknown = requests.length;
    const unknown = await threw(() => conn.answerQuestion('qn_never_seen', [['Alpha']]));
    check('answering an unknown question refuses with zero HTTP issued',
      !!unknown && /no longer known/.test(unknown.message) && requests.length === beforeUnknown,
      `${unknown?.message} calls=${requests.length - beforeUnknown}`);

    socket.deliver(frame('event.question.answered', { question_id: 'qn_1', resolved_at: 'x' }));
    check('an answered event resolves the card',
      rows.some((row) => row.type === 'question-resolved' && row.requestId === 'qn_1'));

    // NEGATIVE CONTROL over the ENTIRE write log so far: once an id is in a
    // request body it is indistinguishable from a real one, so the proof has to
    // be that every `q_`/`opt_`-shaped id sent came out of a payload the server
    // named. `emitted.length > 0` keeps this from passing vacuously.
    const named = JSON.stringify(questionPayload);
    const emitted = writes()
      .flatMap((entry) => JSON.stringify(entry.body ?? {}).match(/\b(?:q|opt)_\d+(?:_\d+)?\b/g) ?? []);
    const invented = [...new Set(emitted)].filter((id) => !named.includes(`"${id}"`));
    check('no request body ever carried a question id the source payload did not name',
      emitted.length > 0 && invented.length === 0,
      `emitted=${[...new Set(emitted)].join(',')} invented=${invented.join(',') || '(none)'}`);
    await conn.close();
  }

  // ── 7. getPending ─────────────────────────────────────────────────────────

  {
    pendingApprovals = [{
      approval_id: 'ap_pending', session_id: CREATED_ID, tool_call_id: 'c1',
      tool_name: 'Edit', action: 'write file', tool_input_display: { path: '/tmp/x' },
      created_at: 'x', expires_at: 'y',
    }];
    pendingQuestions = [{
      question_id: 'qn_pending', session_id: CREATED_ID, created_at: 'x',
      questions: [{
        id: 'q_0', question: 'Continue?',
        options: [{ id: 'opt_0_0', label: 'Yes' }, { id: 'opt_0_1', label: 'No' }],
      }],
    }];

    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const live = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const pending = await live.getPending();
    check('a driving connection replays both open cards, actionable',
      pending.length === 2
        && pending[0]?.type === 'permission-request' && pending[0].readOnly === undefined
        && pending[1]?.type === 'question-request' && pending[1].readOnly === undefined,
      pending.map((row) => `${row.type}:${'readOnly' in row ? row.readOnly : ''}`).join(','));
    // The registry is filled from the pending read too, so a connection that
    // reconnected after the request event can still answer it.
    const answered = await threw(() => live.answerQuestion('qn_pending', [['Yes']]));
    check('a card recovered from the pending read is answerable',
      answered === undefined
        && JSON.stringify((writes().at(-1)?.body as { answers?: Record<string, unknown> })?.answers?.q_0)
          === JSON.stringify({ kind: 'single', option_id: 'opt_0_0' }),
      `${answered?.message} ${JSON.stringify(writes().at(-1)?.body)}`);
    await live.close();

    {
      // A HALF-READ IS NOT A READING on the broker path either. `getPending`
      // retries once and then answers honestly empty, rather than handing back
      // the half it happened to get — and it registers nothing, so no question
      // becomes answerable on the strength of a reading nobody accepted.
      questionsFail = true;
      const halfLive = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
      const approvalsBefore = requests.filter((entry) =>
        entry.path === `/api/v1/sessions/${CREATED_ID}/approvals`).length;
      const questionsBefore = requests.filter((entry) =>
        entry.path === `/api/v1/sessions/${CREATED_ID}/questions`).length;
      const half = await halfLive.getPending();
      const approvalsAfter = requests.filter((entry) =>
        entry.path === `/api/v1/sessions/${CREATED_ID}/approvals`).length;
      const questionsAfter = requests.filter((entry) =>
        entry.path === `/api/v1/sessions/${CREATED_ID}/questions`).length;
      check('a half-read pending replay answers empty, after exactly ONE retry',
        half.length === 0 && approvalsAfter === approvalsBefore + 2
          && questionsAfter === questionsBefore + 2,
        `rows=${half.length} approvals=${approvalsAfter - approvalsBefore}`
        + ` questions=${questionsAfter - questionsBefore}`);
      const beforeUnknown = requests.length;
      const unregistered = await threw(() => halfLive.answerQuestion('qn_pending', [['Yes']]));
      check('a half-read pending replay registers no question record',
        /no longer known/.test(unregistered?.message ?? '') && requests.length === beforeUnknown,
        `${unregistered?.message} calls=${requests.length - beforeUnknown}`);
      questionsFail = false;
      await halfLive.close();
    }

    // NEGATIVE CONTROL for the force-load rule: an IDLE observe connection must
    // issue no pending read at all. Each of those reads resumes the session
    // inside the Kimi server, so arming them on every foreign attach would make
    // merely looking at a terminal-owned session load it into a second owner.
    const observing = await adapter.attach(FOREIGN_ID);
    const beforeIdle = requests.length;
    const idlePending = await observing.getPending?.();
    check('an idle observe connection issues NO pending read',
      idlePending?.length === 0 && requests.length === beforeIdle,
      `rows=${idlePending?.length} calls=${requests.length - beforeIdle}`);

    // Blocked, so the cost is justified — and the cards are non-actionable,
    // because the broker's authority gate would refuse this socket's answer.
    (observing.info as { status: string }).status = 'needs-input';
    const blocked = await observing.getPending?.() ?? [];
    check('a blocked observe connection surfaces both cards as READ-ONLY',
      blocked.length === 2
        && blocked.every((row) => (row as { readOnly?: boolean }).readOnly === true),
      blocked.map((row) => `${row.type}:${(row as { readOnly?: boolean }).readOnly}`).join(','));
    await observing.close();
    pendingApprovals = [];
    pendingQuestions = [];
  }

  // ── 8. Completion fencing and run-state repair ────────────────────────────

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();
    const socket = sockets.at(-1)!;
    const statuses = () => rows.filter((row): row is Extract<AgentMessage, { type: 'status' }> =>
      row.type === 'status').map((row) => row.status);

    promptAnswer = ok({ prompt_id: 'prompt_fence', user_message_id: 'msg_fence', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'run something' });
    socket.deliver(frame('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' }));
    await settle();
    // The turn's rows land in REST before its completion frames, exactly as the
    // server orders them.
    messages = [assistantRow('msg_reply', 'the answer'), userRow('msg_fence', 'run something')];
    socket.deliver(frame('prompt.completed', { promptId: 'prompt_fence', finishedAt: 'x', reason: 'completed' }));
    socket.deliver(frame('event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: 'completed' }));
    await settle();
    check('one working and one idle status, and no more',
      statuses().join(',') === 'running,idle', statuses().join(','));
    const idleIndex = rows.findIndex((row) => row.type === 'status' && row.status === 'idle');
    const replyIndex = rows.findIndex((row) => row.type === 'model-output' && row.text === 'the answer');
    check('idle arrives AFTER the turn\'s terminal row, never before it',
      replyIndex >= 0 && idleIndex > replyIndex, `reply@${replyIndex} idle@${idleIndex}`);

    // NEGATIVE CONTROL: with no fence outstanding, a reconnect must pull no
    // session row. The repair is for a LOST completion, not a routine reopen.
    const beforeQuietReconnect = requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length;
    socket.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a reconnect with no pending fence pulls no session row',
      requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length === beforeQuietReconnect,
      `pulls=${requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length - beforeQuietReconnect}`);

    // Now the real case: a turn in flight when the socket dies. Its
    // `prompt.completed` is lost with the journal, so nothing on the stream will
    // ever clear the fence — the session would read as working forever.
    promptAnswer = ok({ prompt_id: 'prompt_lost', user_message_id: 'msg_lost', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'this one gets orphaned' });
    const liveSocket = sockets.at(-1)!;
    liveSocket.deliver(frame('event.session.work_changed', { busy: true, pending_interaction: 'none' }));
    await settle();
    check('the orphaned turn is reported working', statuses().at(-1) === 'running', statuses().join(','));
    const beforeRepair = requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length;
    sessionRowAnswer = ok({ id: CREATED_ID, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', metadata: { cwd: WORKSPACE } });
    liveSocket.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    const pulls = requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length - beforeRepair;
    check('a reconnect with a pending fence repairs from ONE session-row read',
      pulls === 1 && statuses().at(-1) === 'idle', `pulls=${pulls} statuses=${statuses().join(',')}`);
    await conn.close();
  }

  // ── 8b. Malformed run-state evidence must not fabricate idle ──────────────
  //
  // Idle is not a neutral reading here: it CLEARS the completion fences and ends
  // the turn for the client. `busy` is a required boolean upstream
  // (`protocol/session.ts:49`, `events-zod.ts:591-597`), so a string, a null, an
  // absent field, or an unknown `pending_interaction` is not an idle session —
  // it is a payload this reader cannot read, and the state already held is
  // better evidence than a guess.

  {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();
    const socket = sockets.at(-1)!;
    const statuses = () => rows.filter((row): row is Extract<AgentMessage, { type: 'status' }> =>
      row.type === 'status').map((row) => row.status);
    const sessionRowPulls = () =>
      requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}`).length;

    promptAnswer = ok({ prompt_id: 'prompt_drift', user_message_id: 'msg_drift', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'run something' });
    socket.deliver(frame('event.session.work_changed', { busy: true, pending_interaction: 'none' }));
    await settle();
    check('the fenced turn is reported working', statuses().join(',') === 'running', statuses().join(','));

    const beforeDrift = rows.length;
    for (const payload of [
      { busy: 'false', pending_interaction: 'none' },
      {},
      { busy: null },
      { busy: false, pending_interaction: 'a-state-from-the-future' },
    ]) {
      socket.deliver(frame('event.session.work_changed', payload));
    }
    // A payload that is not an object at all takes the same path: the dispatch
    // hands the mapper `{}`, which is equally not evidence.
    socket.deliver({ ...frame('event.session.work_changed'), payload: 'not-an-object' });
    await settle();
    // NEGATIVE CONTROL: prove the ABSENCE of a status emission, not merely that
    // the last one still reads `running`.
    check('drifted work_changed frames emit NO status row and preserve the run state',
      !rows.slice(beforeDrift).some((row) => row.type === 'status')
        && statuses().join(',') === 'running'
        && conn.info.status === 'working',
      `emitted=${rows.slice(beforeDrift).filter((row) => row.type === 'status').length} info=${conn.info.status}`);

    // The fence itself is not directly observable, so it is proved through the
    // repair: a reconnect pulls exactly one session row while a fence stands and
    // none once it has cleared. A repair that READS a drifted row must leave the
    // fence standing — and, having already run for this discontinuity, must
    // return rather than retry.
    sessionRowAnswer = ok({ id: CREATED_ID, busy: 'false', pending_interaction: 'none', metadata: { cwd: WORKSPACE } });
    const beforeDriftedRepair = sessionRowPulls();
    socket.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a repair that reads a drifted session row leaves the fence standing and does not loop',
      sessionRowPulls() - beforeDriftedRepair === 1 && statuses().join(',') === 'running',
      `pulls=${sessionRowPulls() - beforeDriftedRepair} statuses=${statuses().join(',')}`);

    // An AUTHORITATIVE idle still clears it — the fix narrows what counts as
    // evidence, it does not stop the repair working.
    sessionRowAnswer = ok({ id: CREATED_ID, busy: false, pending_interaction: 'none', last_turn_reason: 'completed', metadata: { cwd: WORKSPACE } });
    const beforeGoodRepair = sessionRowPulls();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('an authoritative idle row still repairs the fence',
      sessionRowPulls() - beforeGoodRepair === 1 && statuses().at(-1) === 'idle',
      `pulls=${sessionRowPulls() - beforeGoodRepair} statuses=${statuses().join(',')}`);

    // ...and once cleared, the next reconnect pulls nothing: the fence really
    // was outstanding for both reads above.
    const beforeQuiet = sessionRowPulls();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a reconnect after the fence cleared pulls no session row',
      sessionRowPulls() === beforeQuiet, `pulls=${sessionRowPulls() - beforeQuiet}`);

    // A live `{busy:false}` frame is still an authoritative idle for a fresh
    // fence, so the WS path is not merely "never trusted now".
    promptAnswer = ok({ prompt_id: 'prompt_clean', user_message_id: 'msg_clean', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'one more' });
    const liveSocket = sockets.at(-1)!;
    liveSocket.deliver(frame('event.session.work_changed', { busy: true, pending_interaction: 'none' }));
    await settle();
    liveSocket.deliver(frame('event.session.work_changed', { busy: false, pending_interaction: 'none' }));
    await settle();
    const beforeFinalQuiet = sessionRowPulls();
    liveSocket.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a well-formed {busy:false} frame still clears the fence',
      statuses().at(-1) === 'idle' && sessionRowPulls() === beforeFinalQuiet,
      `statuses=${statuses().join(',')} pulls=${sessionRowPulls() - beforeFinalQuiet}`);
    await conn.close();
    sessionRowAnswer = ok({
      id: CREATED_ID, busy: false, pending_interaction: 'none', last_turn_reason: 'completed',
      metadata: { cwd: WORKSPACE }, title: 'from cosyncing',
    });
  }

  // ── 9. Divergence ─────────────────────────────────────────────────────────

  /** A driven, primed connection with its socket open and its history baselined. */
  async function drivenSession(): Promise<{
    adapter: KimiAdapter; conn: KimiDriveConnection; socket: FakeSocket; rows: AgentMessage[];
    /** Drops the ONLY handler, which is what the zero-subscriber read guard turns on. */
    unsubscribe: () => void;
  }> {
    const adapter = makeAdapter();
    await adapter.createSession({ directory: WORKSPACE });
    messages = [assistantRow('msg_seed', 'seeded'), userRow('msg_seed_user', 'seed prompt')];
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    const unsubscribe = conn.subscribe((message) => rows.push(message));
    await conn.getHistory();
    await settle();
    return { adapter, conn, socket: sockets.at(-1)!, rows, unsubscribe };
  }

  {
    const { adapter, conn, rows } = await drivenSession();
    // A terminal `kimi -S` turn: the row appears through the REST re-fold and
    // the socket says nothing, because the CLI runs its own in-process bus.
    messages = [userRow('msg_terminal', 'typed in a terminal'), ...messages];
    await conn.refresh();
    check('one poll of an unexplained user row suspects but does NOT demote',
      conn.demotedToObserve === false && conn.info.attachMode === 'live',
      `demoted=${conn.demotedToObserve}`);

    const beforeWrites = writes().length;
    await conn.refresh();
    check(`a suspect surviving ${KIMI_DIVERGENCE_CONFIRM_POLLS} healthy polls demotes exactly once`,
      conn.demotedToObserve === true
        && rows.filter((row) => row.type === 'error' && row.message === KIMI_DIVERGENCE_MESSAGE).length === 1,
      `demoted=${conn.demotedToObserve}`);
    const flip = rows.filter((row): row is Extract<AgentMessage, { type: 'metadata-update' }> =>
      row.type === 'metadata-update' && row.key === 'sessionInfo'
      && (row.value as { attachMode?: string }).attachMode === 'observe');
    check('demotion emits exactly one sessionInfo flip carrying the unavailable control state',
      flip.length === 1
        && (flip[0]!.value as { control?: { drive?: { state?: string; supported?: boolean; reason?: string } } })
          .control?.drive?.state === 'unavailable'
        && (flip[0]!.value as { control?: { drive?: { supported?: boolean } } }).control?.drive?.supported === false
        && (flip[0]!.value as { control?: { drive?: { reason?: string } } }).control?.drive?.reason === 'kimi-foreign-writer',
      JSON.stringify(flip.map((row) => row.value)));
    check('the connection info itself flips to observe',
      conn.info.attachMode === 'observe' && conn.info.control?.drive.supported === false,
      JSON.stringify(conn.info.control));

    // NEGATIVE CONTROL, the one that matters most: a diverged session must
    // receive NOTHING further — not even an abort. A write to a session with two
    // writers is the exact hazard the demotion exists to stop.
    const prompt = await threw(() => conn.sendPrompt({ text: 'still there?' }));
    const stop = await threw(() => conn.runCommand('stop'));
    const approve = await threw(() => conn.respondPermission('ap_x', 'approve'));
    const answer = await threw(() => conn.answerQuestion('qn_x', [['Yes']]));
    check('every mutation after demotion refuses, and ZERO writes are issued',
      [prompt, stop, approve, answer].every((error) => !!error)
        && [prompt, stop, approve].every((error) => error!.message === KIMI_DEMOTED_REFUSAL)
        && writes().length === beforeWrites,
      `writes=${writes().length - beforeWrites} messages=${[prompt, stop, approve, answer].map((e) => e?.message).join(' | ')}`);

    // The adapter's owned set is the single source of drive eligibility, so a
    // demoted session must not regain Drive by reattaching.
    const roster = await adapter.discoverSessions();
    check('the demoted session is foreign again on the roster',
      roster.find((row) => row.id === CREATED_ID)?.control?.drive.supported === false,
      JSON.stringify(roster.find((row) => row.id === CREATED_ID)?.control));
    const reattach = await threw(() => adapter.attach(CREATED_ID, 'live'));
    check('a demoted session refuses a fresh live attach',
      isOwnershipConflictError(reattach), `${reattach?.name}`);
    await conn.close();
  }

  {
    // TERMINAL HANDOFF REVOKES THE SAME ELIGIBILITY DEMOTION DOES.
    //
    // The hub calls `releaseDriveEligibility` after closing the native owner, so
    // the observer it then builds cannot advertise Drive. If this path and
    // demotion ever disagreed, one of them would leave a session that silently
    // re-acquires Drive on the next attach with no user action — which is the
    // whole reason handoff needs an adapter hook rather than just a closed
    // connection. Asserted through the PUBLIC surface, so it holds whatever the
    // internals are named.
    const { adapter, conn } = await drivenSession();
    const beforeRoster = await adapter.discoverSessions();
    check('the owned session is drivable before handoff',
      beforeRoster.find((row) => row.id === CREATED_ID)?.control?.drive.supported === true,
      JSON.stringify(beforeRoster.find((row) => row.id === CREATED_ID)?.control?.drive));

    adapter.releaseDriveEligibility(CREATED_ID);

    const afterRoster = await adapter.discoverSessions();
    check('handoff revocation makes the session foreign on the roster',
      afterRoster.find((row) => row.id === CREATED_ID)?.control?.drive.supported === false,
      JSON.stringify(afterRoster.find((row) => row.id === CREATED_ID)?.control?.drive));
    const afterHandoff = await threw(() => adapter.attach(CREATED_ID, 'live'));
    check('a handed-off session refuses a fresh live attach, exactly as a demoted one does',
      isOwnershipConflictError(afterHandoff), `${afterHandoff?.name}`);

    // Idempotent: the hub's contract allows a handoff after a demotion already
    // revoked the same session, and a second call must be a no-op rather than a
    // second state change.
    adapter.releaseDriveEligibility(CREATED_ID);
    const twiceRoster = await adapter.discoverSessions();
    check('revoking twice is a no-op',
      twiceRoster.find((row) => row.id === CREATED_ID)?.control?.drive.supported === false);
    await conn.close();
  }

  {
    // REST LEADS WS. The server ran this turn and its frames are simply behind
    // the disk re-fold; any owned-session frame in the interval proves the
    // server was alive and accounts for the row.
    const { conn } = await drivenSession();
    const socket = sockets.at(-1)!;
    messages = [userRow('msg_server_side', 'submitted through another API client'), ...messages];
    await conn.refresh();
    socket.deliver(frame('turn.started', { turnId: 7, origin: { kind: 'user' } }));
    await conn.refresh();
    await conn.refresh();
    check('a suspect explained by WS activity in the interval does NOT demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // SOCKET DOWN. Two separate claims, and only the first one used to hold.
    //
    // (1) A poll taken while the stream is gone proves NOTHING and must not
    //     demote: poll-only rows are expected there, and an interval in which
    //     nothing could have spoken cannot be called silent.
    // (2) It also proves nothing in the other direction, which is what the
    //     round-2 behaviour got wrong. Recording such a row as KNOWN — which is
    //     what the unconditional known-marking did — makes it permanently
    //     unsuspectable, so a terminal prompt that happened to land inside an
    //     outage window bought lifetime immunity from the detector. The row is
    //     HELD instead, and re-armed when the stream comes back.
    const { conn, rows } = await drivenSession();
    const socket = sockets.at(-1)!;
    socket.fire('close', {});
    await settle();
    messages = [userRow('msg_during_outage', 'arrived while the stream was down'), ...messages];
    // The refusal checks below stand on the row being HELD, which only a walk
    // under the down stream can do — so that observation is barriered, not
    // slept (see heldRow).
    await heldRow(conn);
    check('rows seen while the socket was down never demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and the connection SAYS it cannot account for the row, by refusing to
    // write. NEGATIVE CONTROL: zero writes, and a message distinct from both the
    // demotion refusal and the stream refusal.
    const beforeHeld = writes().length;
    const held = await threw(() => conn.sendPrompt({ text: 'while provenance is open' }));
    check('a write during the unresolved window refuses with its own message and ZERO writes',
      held?.message === KIMI_OPEN_PROVENANCE_REFUSAL && writes().length === beforeHeld,
      `${held?.message} writes=${writes().length - beforeHeld}`);

    // The stream returns with NOTHING to account for the row: no server-side
    // activity, no late POST of ours. Held suspicion is not forgiveness, so the
    // row is now watched under a demonstrably healthy stream and confirmed.
    // ONE healthy interval is not enough — the confirmation rule is unchanged —
    // which is what proves the row was re-armed rather than fast-tracked.
    intervalHandler?.();
    await settle();
    check('the held row is re-suspected rather than confirmed outright',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // The stream is UP again and the row is still unattributed, so the write is
    // refused without even reaching for a reconnect: a live stream is necessary
    // for a content write, never sufficient. NEGATIVE CONTROL on zero writes.
    const beforeStreamUpHold = writes().length;
    const heldWithStream = await threw(() => conn.sendPrompt({ text: 'stream is up, provenance is not' }));
    check('a write is refused while provenance is open even with the stream healthy, with ZERO writes',
      heldWithStream?.message === KIMI_OPEN_PROVENANCE_REFUSAL
        && writes().length === beforeStreamUpHold,
      `${heldWithStream?.message} writes=${writes().length - beforeStreamUpHold}`);
    await conn.refresh();
    await conn.refresh();
    check('an outage row that nothing ever accounts for demotes once the stream is healthy again',
      conn.demotedToObserve === true
        && rows.filter((row) => row.type === 'error' && row.message === KIMI_DIVERGENCE_MESSAGE).length === 1,
      `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // THE SAME OUTAGE ROW, ACCOUNTED FOR. The held suspicion is a question, not
    // a verdict, so every innocent explanation still clears it.
    //
    // Here the server itself answers: an owned-session frame in the confirming
    // interval proves it was alive and running something that can produce the
    // row, which is the REST-leads-WS case wearing an outage.
    const { conn } = await drivenSession();
    const retired = sockets.at(-1)!;
    retired.fire('close', {});
    await settle();
    messages = [userRow('msg_outage_explained', 'the server ran this'), ...messages];
    // The row must be SEEN while the stream is down — that is the premise every
    // later claim in this block stands on. A plain refresh cannot promise it
    // (see heldRow): the close listener's own re-resolution walk can still hold
    // the slot when a fixed settle ends, and a row first read after the stream
    // is back is, correctly, a fresh suspect under a healthy silent stream.
    await heldRow(conn);
    // The tick reopens the stream, but only AFTER re-resolving the generation
    // over HTTP, so the replacement socket is not ready the moment a sleep ends.
    // Deliver to the socket that actually opened: delivering to the retired one
    // is silently dropped, and the row would then demote with an explanation
    // sitting unread.
    intervalHandler?.();
    const replacement = await replacementSocket(retired);
    // The frame must land in the interval BETWEEN the arming walk and the
    // confirming one: socket-open readiness is not a walk barrier (the tick
    // starts its own walk the moment the generation re-resolves), and waiting
    // out that walk by running ANOTHER one would run the confirmation itself
    // — the suspect would demote before its explanation was delivered. Wait
    // the tick's walk out, deliver, then let the next walk evaluate.
    await waitOutWalk(conn);
    replacement.deliver(frame('turn.started', { turnId: 11, origin: { kind: 'user' } }));
    await conn.refresh();
    await conn.refresh();
    check('an outage row explained by later server activity does NOT demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and with provenance resolved, writing is allowed again.
    const beforeResumed = writes().length;
    promptAnswer = ok({ prompt_id: 'prompt_resumed', user_message_id: 'msg_resumed', status: 'running', content: [], created_at: 'x' });
    const resumed = await threw(() => conn.sendPrompt({ text: 'writing again' }));
    check('writes resume once the outage row is accounted for',
      resumed === undefined && writes().length === beforeResumed + 1,
      `${resumed?.message} writes=${writes().length - beforeResumed}`);
    await conn.close();
  }

  {
    // BITE PROOF for the readiness wait above, and the regression guard for the
    // race it replaced.
    //
    // The reopen's re-resolution is parked well past the old fixed budget. A
    // sleep-based wait would return while the RETIRED socket was still newest,
    // deliver the explanation into a socket whose listeners are neutralized,
    // and demote a session that had a perfectly good account of itself — which
    // is exactly how this suite failed intermittently on loaded machines and on
    // CI. The first check below asserts the trap is genuinely armed (a sleep
    // really would have been fooled here); the rest prove the readiness wait
    // walks past it.
    const { conn } = await drivenSession();
    const retired = sockets.at(-1)!;
    retired.fire('close', {});
    await settle();
    messages = [userRow('msg_outage_slow_meta', 'the server ran this too'), ...messages];
    await heldRow(conn);
    const parkedMeta = gate();
    holdMeta = parkedMeta.hold;
    intervalHandler?.();
    await Bun.sleep(90);
    check('with re-verification parked, a fixed sleep would still see only the retired socket',
      sockets.at(-1) === retired, `sockets=${sockets.length}`);
    parkedMeta.release();
    // From here the sequence is IDENTICAL to the block above — the park is the
    // only difference. That is the point: the same script that races on a
    // loaded machine runs deterministically once the wait is a condition rather
    // than a duration.
    const replacement = await replacementSocket(retired);
    await waitOutWalk(conn);
    replacement.deliver(frame('turn.started', { turnId: 12, origin: { kind: 'user' } }));
    await conn.refresh();
    await conn.refresh();
    check('a slow re-verification does not demote an outage row that was explained',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // THE EXPLANATION CROSSING THE ARMING WALK — the schedule socket-readiness
    // alone cannot rule out. The reconnect's first healthy walk is held open
    // INSIDE the fixture server, the explanatory frame is delivered while that
    // walk is in flight, and only then is the walk allowed to finish.
    //
    // The detector contract says this row is EXPLAINED, not merely lucky. The
    // outage row's open question is "did the server answer for this session at
    // any point since the row appeared unattributed", and a frame that arrives
    // while the arming walk is still gathering is exactly such an answer: the
    // same REST-leads-WS case as the blocks above, measured from the hold
    // rather than from the arming. Counting the frame into the suspect's
    // arming baseline instead would call the explanation part of the silence,
    // and the suspect would confirm against the very frame that accounted for
    // it — demoting a session whose server demonstrably answered for it, the
    // false positive this detector exists to avoid.
    const { conn } = await drivenSession();
    const retired = sockets.at(-1)!;
    retired.fire('close', {});
    await settle();
    messages = [userRow('msg_outage_crossed', 'the server ran this during recovery'), ...messages];
    await heldRow(conn);
    // Park the transcript read BEFORE the tick, so the first healthy walk the
    // reconnect runs is the one held open here — and record how many transcript
    // reads the fixture has served, so the walk's arrival is PROVEN rather than
    // assumed.
    const readsBefore = transcriptReads();
    const crossing = gate();
    holdMessages = crossing.hold;
    intervalHandler?.();
    const replacement = await replacementSocket(retired);
    const parkedDeadline = Date.now() + 5_000;
    while (transcriptReads() === readsBefore) {
      if (Date.now() >= parkedDeadline) {
        throw new Error('the reconnect walk never reached the parked transcript read');
      }
      await Bun.sleep(1);
    }
    // The walk is parked mid-flight with its GET served and unanswered: the
    // frame below genuinely crosses it. This is the delivery the readiness
    // wait cannot order.
    replacement.deliver(frame('turn.started', { turnId: 13, origin: { kind: 'user' } }));
    crossing.release();
    // The barrier waits the parked walk out and runs one more; the refresh
    // after it widens the window past the confirmation rule, so a suspect
    // armed WITH the explanation in its baseline — the regression pinned here
    // — would have confirmed by the time the check runs.
    await walkedAfterReconnect(conn);
    await conn.refresh();
    check('a turn.started crossing the first healthy walk still exonerates the outage row',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and "accounted for" has teeth: provenance is closed, so a write goes
    // out. NEGATIVE CONTROL on the count, as everywhere else.
    const beforeCrossed = writes().length;
    promptAnswer = ok({ prompt_id: 'prompt_crossed', user_message_id: 'msg_crossed', status: 'running', content: [], created_at: 'x' });
    const resumed = await threw(() => conn.sendPrompt({ text: 'writing again' }));
    check('writes resume once the crossing frame has accounted for the row',
      resumed === undefined && writes().length === beforeCrossed + 1,
      `${resumed?.message} writes=${writes().length - beforeCrossed}`);
    await conn.close();
  }

  {
    // THE EXPLANATION ARRIVES, THEN THE STREAM BREAKS BEFORE ANY WALK CAN
    // EVALUATE IT. The suspect was armed in a healthy interval, the server's
    // frame landed, and the socket died in between — so the evidence exists
    // only inside the suspect being MOVED to the unresolved set. Re-baselining
    // on the move would record the counter AFTER the frame, and the reconnect
    // would then arm the row with its own answer as the starting point and
    // confirm against it: the same false demotion as the crossing case, one
    // transition later. The contract is unchanged — activity at any point
    // since the row was first questioned exonerates it — so the break must
    // carry the baseline, not the current reading.
    const { conn } = await drivenSession();
    const retired = sockets.at(-1)!;
    messages = [userRow('msg_explained_before_break', 'explained, then the stream died'), ...messages];
    await conn.refresh();
    // Armed now: one healthy poll of an unexplained row, per the blocks above.
    // The frame and the close are SYNCHRONOUS and adjacent, so no walk can
    // evaluate the suspect in between — the move to the unresolved set is the
    // only place the evidence can survive.
    retired.deliver(frame('turn.started', { turnId: 14, origin: { kind: 'user' } }));
    retired.fire('close', {});
    await settle();
    // The stream returns with NOTHING further to say: if the baseline survived
    // the move, the frame already delivered accounts for the row.
    intervalHandler?.();
    await replacementSocket(retired);
    await walkedAfterReconnect(conn);
    await conn.refresh();
    await conn.refresh();
    check('a suspect whose explanation arrived before the break does NOT demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    const beforeExplained = writes().length;
    promptAnswer = ok({ prompt_id: 'prompt_explained', user_message_id: 'msg_explained', status: 'running', content: [], created_at: 'x' });
    const explainedResume = await threw(() => conn.sendPrompt({ text: 'writing again' }));
    check('writes resume once the pre-break frame has accounted for the row',
      explainedResume === undefined && writes().length === beforeExplained + 1,
      `${explainedResume?.message} writes=${writes().length - beforeExplained}`);
    await conn.close();
  }

  {
    // OUR OWN POST, RESOLVING LATE. The one sequence that can still produce an
    // unattributed row that is genuinely ours: a walk ALREADY IN FLIGHT when a
    // submit begins (the submission fence holds walks that start after it, not
    // one that is already running), the stream dropping while both are
    // outstanding, and the walk therefore ending with the row present and its
    // id still unknown. The `user_message_id` the POST finally returns is the
    // evidence, and it clears the row wherever it has got to.
    const { conn } = await drivenSession();
    const socket = sockets.at(-1)!;
    const read = gate();
    const submit = gate();

    holdMessages = read.hold;
    const walking = conn.refresh();
    await settle();

    // The submit passes the write gate — the stream is up and nothing is
    // unattributed — and the server writes the row before its answer is sent.
    messages = [userRow('msg_late_echo', 'mine, learned late'), ...messages];
    promptAnswer = ok({ prompt_id: 'prompt_late', user_message_id: 'msg_late_echo', status: 'running', content: [], created_at: 'x' });
    holdPrompt = submit.hold;
    const sending = conn.sendPrompt({ text: 'mine, learned late' });
    await settle();

    socket.fire('close', {});
    await settle();
    read.release();
    await walking;
    check('a walk that ends with the stream down holds our own un-named echo',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);

    submit.release();
    await sending;
    // The id is in. Two proofs that it landed as EVIDENCE and not merely as a
    // recorded send: the connection writes again (so provenance is closed), and
    // no number of healthy walks demotes it.
    intervalHandler?.();
    await settle();
    const beforeAfterEvidence = writes().length;
    promptAnswer = ok({ prompt_id: 'prompt_after_late', user_message_id: 'msg_after_late', status: 'running', content: [], created_at: 'x' });
    const resumed = await threw(() => conn.sendPrompt({ text: 'writing again' }));
    messages = [userRow('msg_after_late', 'writing again'), ...messages];
    await conn.refresh();
    await conn.refresh();
    await conn.refresh();
    check('our own late-resolving POST exonerates the row: no demotion, and writes resume',
      resumed === undefined
        && writes().length === beforeAfterEvidence + 1
        && conn.demotedToObserve === false,
      `${resumed?.message} writes=${writes().length - beforeAfterEvidence} demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // A SECOND BREAK DURING CONFIRMATION RE-ARMS, it does not forgive. Round 2
    // dropped every suspect on a break, so a foreign writer on a flappy stream
    // was invisible by construction: each outage wiped the evidence the next
    // interval was building.
    const { conn } = await drivenSession();
    sockets.at(-1)!.fire('close', {});
    await settle();
    messages = [userRow('msg_flappy', 'typed in a terminal'), ...messages];
    await conn.refresh();
    // The stream returns and the row starts its confirmation...
    intervalHandler?.();
    await settle();
    check('the promoted row has not demoted after one healthy interval',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and the stream drops again before it finishes. The row goes back to
    // being unattributed rather than being cleared, and nothing demotes on
    // evidence gathered while nobody was listening.
    sockets.at(-1)!.fire('close', {});
    await settle();
    await conn.refresh();
    check('the second break does not clear the row, and nothing demotes while the stream is down',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    intervalHandler?.();
    await settle();
    check('the re-armed row starts its confirmation over rather than resuming mid-count',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.refresh();
    await conn.refresh();
    check('the row demotes after the NEXT healthy interval — the break re-armed it, it did not forgive it',
      conn.demotedToObserve === true, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // OVERFLOW. The unresolved set is bounded, and the bound's overflow rule is
    // DEMOTE rather than evict: 64 prompts nobody can account for is not a race,
    // and silently forgetting the oldest would make a large enough burst of
    // foreign writes the one shape the detector cannot see.
    const { conn } = await drivenSession();
    sockets.at(-1)!.fire('close', {});
    await settle();
    // Two batches, because one bounded walk reads at most
    // KIMI_REFRESH_PAGE_SIZE × KIMI_REFRESH_MAX_PAGES rows — fewer than the
    // bound. Each batch is comfortably inside a walk's reach, and together they
    // are more than the set can hold.
    const flood = (from: number, count: number) => Array.from({ length: count }, (_, index) =>
      userRow(`msg_flood_${from + index}`, 'typed in a terminal'));
    messages = [...flood(0, 40), ...messages];
    await conn.refresh();
    check('a flood inside the bound is held, not yet a verdict',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    messages = [...flood(40, 40), ...messages];
    await conn.refresh();
    check(`more than ${KIMI_DIVERGENCE_SUSPECT_LIMIT} unattributable prompts demotes rather than forgetting one`,
      conn.demotedToObserve === true && conn.info.attachMode === 'observe',
      `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // ASSISTANT-ONLY ROWS. Model and tool output arrives in fragments whose
    // absence from the stream proves nothing; only a user prompt the server
    // never saw is evidence.
    const { conn } = await drivenSession();
    messages = [
      assistantRow('msg_assistant_a', 'a fragment'),
      assistantRow('msg_assistant_b', 'another fragment'),
      ...messages,
    ];
    await conn.refresh();
    await conn.refresh();
    await conn.refresh();
    check('assistant-only poll rows never demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // A DROPPED FRAME IS A DISCONTINUITY, and a discontinuity DELAYS a verdict
    // rather than granting an acquittal.
    //
    // Round 2 dropped the suspect here, on the reasoning that the frame the
    // ceiling refused might have been the one accounting for it. That reasoning
    // is half right: the hole means the row is not yet PROVEN foreign. It does
    // not mean the row is explained — nobody has explained it, which is the same
    // state it was in before the frame arrived. Clearing the suspicion turned
    // "we could not look" into "we looked and saw nothing wrong", and any writer
    // that could produce one oversized frame could stay invisible forever.
    //
    // So the suspicion is PRESERVED across the break, and confirmed on the
    // stream that follows it if nothing accounts for the row in the meantime.
    const { conn, rows } = await drivenSession();
    const socket = sockets.at(-1)!;
    messages = [userRow('msg_terminal_break', 'typed in a terminal'), ...messages];
    await conn.refresh();
    check('the unexplained row is suspected and has not demoted yet',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    socket.fire('message', {
      data: JSON.stringify({
        type: 'event.session.work_changed', session_id: CREATED_ID,
        seq: 9_999, epoch: 'ep_drive', timestamp: 't',
        payload: {
          busy: true, pending_interaction: 'none',
          pad: 'x'.repeat(KIMI_WS_FRAME_MAX_BYTES),
        },
      }),
    });
    // The break happened IN PLACE — the socket is still open, so there is no
    // reconnect to wait for. The very next walk re-arms the row.
    await conn.refresh();
    check('the interrupted suspect is preserved, and one interval after the break is not yet proof',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.refresh();
    await conn.refresh();
    check('with nothing accounting for it after the break, the preserved suspect demotes',
      conn.demotedToObserve === true
        && conn.info.attachMode === 'observe'
        && rows.filter((row) => row.type === 'error' && row.message === KIMI_DIVERGENCE_MESSAGE).length === 1,
      `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // OUR OWN prompt echo must never look foreign: the submission handed back
    // the user-message id before the row could ever be walked.
    const { conn } = await drivenSession();
    promptAnswer = ok({ prompt_id: 'prompt_own', user_message_id: 'msg_own_echo', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'mine' });
    messages = [userRow('msg_own_echo', 'mine'), ...messages];
    await conn.refresh();
    await conn.refresh();
    await conn.refresh();
    check('our own prompt echo never becomes a suspect',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  // ── 9b. An ORDINARY suspect suspends content writes too ──────────────────
  //
  // A row first seen under a HEALTHY stream never enters the unresolved set — it
  // goes straight into the confirmation machinery — and the write gate used to
  // consult that set alone. So the two polls in which a foreign write is
  // plausible and unrefuted were exactly the window in which this connection
  // would still send, which is the state the gate exists to refuse. Provenance
  // is now provenance: where the doubt came from decides what counts as
  // EVIDENCE, never what may be written while it stands.

  {
    const { conn } = await drivenSession();
    const socket = sockets.at(-1)!;
    // A live card, so `answerQuestion` has real native ids to fail on rather
    // than failing for the unrelated reason that it never saw the question.
    socket.deliver(frame('event.question.requested', {
      question_id: 'qn_provenance', session_id: CREATED_ID, created_at: 'x',
      questions: [{
        id: 'q_0', question: 'Pick one',
        options: [{ id: 'opt_0_0', label: 'Alpha' }, { id: 'opt_0_1', label: 'Beta' }],
        allow_other: false,
      }],
    }));

    messages = [userRow('msg_healthy_provenance', 'typed in a terminal'), ...messages];
    await conn.refresh();
    check('one healthy poll of an unexplained row suspects it without demoting',
      conn.demotedToObserve === false && conn.info.attachMode === 'live',
      `demoted=${conn.demotedToObserve}`);

    const beforeHeld = writes().length;
    const socketsBefore = sockets.length;
    const prompt = await threw(() => conn.sendPrompt({ text: 'while the row is unattributed' }));
    const approve = await threw(() => conn.respondPermission('ap_provenance', 'approve'));
    const answer = await threw(() => conn.answerQuestion('qn_provenance', [['Alpha']]));
    // NEGATIVE CONTROL on the write recorder: all three refuse and NOTHING is
    // posted. A gate that refused the prompt and let an approval through would
    // still be answering a card the second writer may have caused.
    check('an ordinary suspect suspends prompt, approval, and answer alike, with ZERO writes',
      [prompt, approve, answer].every((error) => error?.message === KIMI_OPEN_PROVENANCE_REFUSAL)
        && writes().length === beforeHeld,
      `writes=${writes().length - beforeHeld} messages=${[prompt, approve, answer].map((e) => e?.message).join(' | ')}`);
    // ...and it was the PROVENANCE gate that refused, on a demonstrably healthy
    // stream. The stream gate makes exactly one reopen attempt before it
    // refuses, so zero new sockets is the mechanical proof it was never reached.
    check('the refusal is the provenance gate on a HEALTHY stream, not the stream gate',
      prompt?.message !== KIMI_NO_STREAM_REFUSAL && sockets.length === socketsBefore,
      `sockets=${sockets.length - socketsBefore} message=${prompt?.message}`);

    // The one exemption survives: the abort takes something back rather than
    // adding something the user then has to answer.
    abortAnswer = ok({ aborted: true });
    const beforeStop = writes().length;
    const stopped = await conn.runCommand('stop');
    check('runCommand(\'stop\') stays exempt while provenance is open',
      stopped?.notice === KIMI_STOP_NOTICE && writes().length === beforeStop + 1,
      `${stopped?.notice} writes=${writes().length - beforeStop}`);

    // The server itself answers for the row: an owned-session frame in the
    // interval proves it ran something that can account for it.
    socket.deliver(frame('turn.started', { turnId: 21, origin: { kind: 'user' } }));
    await conn.refresh();
    check('server activity exonerates the row rather than demoting it',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);

    promptAnswer = ok({ prompt_id: 'prompt_provenance', user_message_id: 'msg_provenance_ours', status: 'running', content: [], created_at: 'x' });
    approvalResolveAnswer = ok({ resolved: true, resolved_at: 'x' });
    const beforeResumed = writes().length;
    const sent = await threw(() => conn.sendPrompt({ text: 'writing again' }));
    const approved = await threw(() => conn.respondPermission('ap_provenance', 'approve'));
    const answered = await threw(() => conn.answerQuestion('qn_provenance', [['Alpha']]));
    check('all three write again once the row is exonerated',
      [sent, approved, answered].every((error) => error === undefined)
        && writes().length === beforeResumed + 3,
      `writes=${writes().length - beforeResumed} messages=${[sent, approved, answered].map((e) => e?.message).join(' | ')}`);
    await conn.close();
  }

  // ── 9c. Suspect overflow under a HEALTHY stream fails CLOSED ─────────────
  //
  // The round-3 overflow rule reached only the unresolved set. On the healthy
  // side the new-suspect loop simply stopped at the cap and the tail then
  // recorded the overflow rows as KNOWN — permanently forgiving exactly the
  // evidence the bound exists to preserve, so a burst large enough to fill the
  // map was the one shape of foreign write the detector agreed in advance never
  // to see.
  //
  // More than 64 rows reach ONE healthy walk through the resync catch-up, which
  // pages far deeper than a poll refresh (KIMI_RESYNC_MAX_PAGES ×
  // KIMI_HISTORY_PAGE_SIZE) with the socket still open — a session a terminal
  // has been writing while this connection's cursor fell out of the replay
  // buffer.

  const floodRows = (from: number, count: number) => Array.from({ length: count }, (_, index) =>
    userRow(`msg_healthy_flood_${from + index}`, 'typed in a terminal'));
  const floodIds = (from: number, count: number) =>
    floodRows(from, count).map((row) => row.id);
  const resyncFrame = (currentSeq: number) => frame('resync_required', {
    session_id: CREATED_ID, current_seq: currentSeq, epoch: 'ep_drive',
  });

  {
    // CONTROL: at the cap and not over it, nothing changes. The 64 rows are
    // tracked, the walk does not demote, and the ordinary confirmation rule is
    // what decides them.
    const { conn } = await drivenSession();
    messages = [...floodRows(0, KIMI_DIVERGENCE_SUSPECT_LIMIT), ...messages];
    sockets.at(-1)!.deliver(resyncFrame(21));
    await settle();
    await settle();
    const tracked = floodIds(0, KIMI_DIVERGENCE_SUSPECT_LIMIT)
      .filter((id) => conn.accountedUserMessageIds.has(id)).length;
    check(`exactly ${KIMI_DIVERGENCE_SUSPECT_LIMIT} unexplained rows in one healthy walk do not demote, and all are tracked`,
      conn.demotedToObserve === false && tracked === KIMI_DIVERGENCE_SUSPECT_LIMIT,
      `demoted=${conn.demotedToObserve} tracked=${tracked}`);
    await conn.refresh();
    check('...and they confirm on the next healthy poll, by the ordinary rule',
      conn.demotedToObserve === true, `demoted=${conn.demotedToObserve}`);
    await conn.close();
  }

  {
    // OVERFLOW: the 65th unexplained row is the demotion trigger, exactly as it
    // is on the unresolved side.
    const overflow = KIMI_DIVERGENCE_SUSPECT_LIMIT + 6;
    const { conn } = await drivenSession();
    messages = [...floodRows(0, overflow), ...messages];
    sockets.at(-1)!.deliver(resyncFrame(41));
    await settle();
    await settle();
    check(`more than ${KIMI_DIVERGENCE_SUSPECT_LIMIT} unexplained rows under a HEALTHY stream demote`,
      conn.demotedToObserve === true && conn.info.attachMode === 'observe',
      `demoted=${conn.demotedToObserve}`);
    // The half that matters: a row recorded as known can never be suspected
    // again, so the overflow must leave the known set untouched. Proved by
    // looking, because forgiveness has no other observable consequence.
    const forgiven = floodIds(0, overflow).filter((id) => conn.accountedUserMessageIds.has(id));
    check('NONE of the overflow rows is recorded as accounted for',
      forgiven.length === 0, `forgiven=${forgiven.length}/${overflow}`);
    await conn.close();
  }

  messages = [];

  // ── 10. The live stream is a PRECONDITION for Drive, not a nicety ─────────
  //
  // Everything a driving connection owes the user rides the socket: the approval
  // card it must answer, the completion that ends its turn, and the foreign
  // frames that prove nobody else is writing. Poll-only is an honest posture for
  // OBSERVE, where nothing can be written and the worst case is a stale view;
  // for Drive it means starting turns the user cannot answer and forking a
  // journal without noticing. So the stream is required, and its absence is
  // stated rather than absorbed.

  {
    // The primitive itself. A socket that is CONSTRUCTED and never opens is not
    // a stream, and the wait has to actually run out — the round-2 predicate
    // read `socket !== undefined` and therefore answered `true` in zero
    // milliseconds, which made every gate built on it a no-op.
    const info = {
      id: CREATED_ID, tool: 'kimi', title: 'stream precondition', status: 'idle' as const,
      attachMode: 'live' as const, launchSurface: 'app' as const,
    };
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    const silent = new KimiDriveConnection(
      info, new KimiReadOnlyHttp({ baseUrl, token: 'fixture-token' }), wsUrl, 'fixture-token',
      { socketFactory: silentSocketFactory, setInterval: () => 1, clearInterval: () => {} },
    );
    const startedAt = Date.now();
    const silentOpened = await silent.waitForStream(60);
    const elapsed = Date.now() - startedAt;
    check('waitForStream answers FALSE for a socket that never opens, at the ceiling and not in zero time',
      silentOpened === false && elapsed >= 55,
      `opened=${silentOpened} elapsed=${elapsed}ms`);
    await silent.close();

    // MECHANISM CONTROL: the same wait against a socket that does open answers
    // true, so the check above is about the handshake and not about the wait
    // being broken.
    const opening = new KimiDriveConnection(
      info, new KimiReadOnlyHttp({ baseUrl, token: 'fixture-token' }), wsUrl, 'fixture-token',
      { socketFactory: openingSocketFactory, setInterval: () => 1, clearInterval: () => {} },
    );
    check('waitForStream answers TRUE once a socket actually opens',
      (await opening.waitForStream(200)) === true);
    await opening.close();
  }

  {
    // A LIVE ATTACH WITH NO STREAM REFUSES. It must also leave nothing behind:
    // the connection has a poll timer running by the time the ceiling falls, and
    // every tick of it is an active REST read that force-loads the session into
    // the Kimi server on behalf of a client that never got a connection.
    const adapter = makeAdapter(liveScan, { socketFactory: silentSocketFactory, liveAttachSocketMs: 60 });
    await adapter.createSession({ directory: WORKSPACE });
    const refused = await threw(() => adapter.attach(CREATED_ID, 'live'));
    check('a live attach whose stream never opens refuses, naming the dependency',
      refused?.message === KIMI_LIVE_ATTACH_NO_STREAM, refused?.message ?? '(did not throw)');
    check('the refused attach leaves NO poll timer behind',
      intervalHandler === undefined, `poller=${intervalHandler === undefined ? 'cleared' : 'still installed'}`);
    // NEGATIVE CONTROL: prove the absence of further io. A connection that was
    // abandoned rather than closed would keep reading on the next tick.
    const afterRefusal = requests.length;
    await settle();
    check('the refused attach issues no further io',
      requests.length === afterRefusal, `calls=${requests.length - afterRefusal}`);

    // ...while an OBSERVE attach against the same silent server still succeeds.
    // The degradation is honest there: a connection that cannot write cannot
    // start a turn nobody can answer.
    const observing = await adapter.attach(FOREIGN_ID);
    check('an observe attach against the same silent server still succeeds, poll-only',
      observing instanceof KimiObserveConnection && !(observing instanceof KimiDriveConnection),
      observing.constructor.name);
    await observing.close();
  }

  {
    // A CONTENT WRITE WITH THE STREAM DOWN. One reopen is attempted at the
    // moment of the write rather than a poll interval later, and if it does not
    // come up the write is refused with nothing sent.
    const adapter = makeAdapter(liveScan, { writeStreamWaitMs: 80 });
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();

    socketsOpenAutomatically = false;
    sockets.at(-1)!.fire('close', {});
    await settle();
    const beforeRefusal = writes().length;
    const socketsBefore = sockets.length;
    const noStream = await threw(() => conn.sendPrompt({ text: 'no stream for this' }));
    check('a prompt with the stream down refuses, naming the dependency, with ZERO writes',
      noStream?.message === KIMI_NO_STREAM_REFUSAL && writes().length === beforeRefusal,
      `${noStream?.message} writes=${writes().length - beforeRefusal}`);
    check('the refused write made exactly ONE reopen attempt',
      sockets.length === socketsBefore + 1, `sockets=${sockets.length - socketsBefore}`);

    // THE PRE-DISPATCH STATE LIVES IN THE WRITE'S OWN FRAME, so a door refusal
    // never runs it. The submission fence is the visible half: raised before the
    // door, it would still be standing over a POST that never happened, holding
    // every transcript walk on this connection until some later submit closed
    // it — a session that silently stops showing new rows after one refused
    // prompt.
    messages = [assistantRow('msg_after_refusal', 'delivered after a refused prompt'), ...messages];
    await conn.refresh();
    await settle();
    check('a refused prompt leaves no submission fence standing: the next refresh walks',
      rows.some((row) => row.type === 'model-output' && row.text === 'delivered after a refused prompt'),
      `rows=${rows.filter((row) => row.type === 'model-output').length}`);

    // ...and the claim half. `respondPermission` marks a request as OURS one
    // statement before its POST; a refusal that recorded the claim anyway would
    // make the NEXT resolution of that card — somebody else's — report as this
    // user's own decision.
    const beforeClaim = writes().length;
    const refusedApproval = await threw(() => conn.respondPermission('ap_never_sent', 'approve'));
    check('an approval refused at the door issues ZERO writes',
      refusedApproval?.message === KIMI_NO_STREAM_REFUSAL && writes().length === beforeClaim,
      `${refusedApproval?.message} writes=${writes().length - beforeClaim}`);

    // The abort is EXEMPT, and this is the one place that exemption matters:
    // refusing the defensive write because the safety stream is down would keep
    // a runaway turn running for as long as the outage lasts.
    abortAnswer = ok({ aborted: true });
    const beforeStop = writes().length;
    const stopped = await conn.runCommand('stop');
    check('runCommand(\'stop\') still aborts with the stream down',
      stopped?.notice === KIMI_STOP_NOTICE && writes().length === beforeStop + 1,
      `${stopped?.notice} writes=${writes().length - beforeStop}`);

    // The same prompt goes through once the replacement socket opens: the gate
    // withholds the write, it does not break the connection.
    sockets.at(-1)!.fire('open', {});
    await settle();

    // ...and the refused approval left NO claim behind. Somebody else answers
    // that card now, and the resolution must report as theirs.
    sockets.at(-1)!.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_never_sent', session_id: CREATED_ID, decision: 'approved', resolved_at: 'x',
    }));
    await settle();
    const claimedBack = rows.filter((row): row is Extract<AgentMessage, { type: 'permission-resolved' }> =>
      row.type === 'permission-resolved' && row.requestId === 'ap_never_sent');
    check('a door refusal leaves no self-resolved claim: the later resolution reports as external',
      claimedBack.length === 1 && claimedBack[0]?.decision === 'external',
      `${claimedBack.length} rows, decision=${claimedBack[0]?.decision}`);

    promptAnswer = ok({ prompt_id: 'prompt_after_stream', user_message_id: 'msg_after_stream', status: 'running', content: [], created_at: 'x' });
    const beforeRetry = writes().length;
    const retried = await threw(() => conn.sendPrompt({ text: 'no stream for this' }));
    check('the same prompt succeeds once the stream is back',
      retried === undefined && writes().length === beforeRetry + 1,
      `${retried?.message} writes=${writes().length - beforeRetry}`);
    socketsOpenAutomatically = true;
    await conn.close();
  }

  {
    // A POLL TAKEN WHILE A SOCKET IS ASSIGNED BUT UNOPENED. This is the window
    // the round-2 liveness predicate could not see: a socket object exists, so
    // the detector called the interval healthy and silent — while in fact no
    // frame could have arrived through it in either direction.
    const { conn } = await drivenSession();
    socketsOpenAutomatically = false;
    sockets.at(-1)!.fire('close', {});
    await settle();
    // The tick constructs a replacement that never completes its handshake.
    intervalHandler?.();
    await settle();
    messages = [userRow('msg_unopened_window', 'typed in a terminal'), ...messages];
    await conn.refresh();
    await conn.refresh();
    await conn.refresh();
    check('polls taken while a socket is assigned but unopened create no suspects and never demote',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and the row is HELD, not forgiven: once a real stream exists it is
    // confirmed. Both halves matter — the first is F1, the second is F2.
    sockets.at(-1)!.fire('open', {});
    await settle();
    await conn.refresh();
    await conn.refresh();
    check('the row held through the unopened window demotes once a real stream exists',
      conn.demotedToObserve === true, `demoted=${conn.demotedToObserve}`);
    socketsOpenAutomatically = true;
    await conn.close();
  }

  // ── 11. Interactions the outage swallowed are reconciled, once ────────────

  {
    // An approval frame that landed in a hole is GONE — unlike a transcript row,
    // which the next REST re-fold recovers. Without a reconciliation the user is
    // left looking at a session that has stopped for no visible reason, holding
    // a card they cannot answer because they never received it.
    const { conn, rows } = await drivenSession();
    const cards = () => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === 'ap_outage');
    sockets.at(-1)!.fire('close', {});
    await settle();
    pendingApprovals = [{
      approval_id: 'ap_outage', session_id: CREATED_ID, tool_call_id: 'c_outage',
      tool_name: 'Edit', action: 'write file', tool_input_display: { path: '/tmp/x' },
      created_at: 'x', expires_at: 'y',
    }];
    check('the card opened during the outage has not been delivered', cards().length === 0);

    intervalHandler?.();
    await settle();
    check('reconciliation after the stream returns delivers the missed approval, actionable',
      cards().length === 1 && cards()[0]?.readOnly === undefined,
      `${cards().length} cards`);

    // DEDUPE, proven rather than assumed: the cursor replay delivers the same
    // card over the WS moments later, and it must be the same card and not a
    // second one. That only holds because reconciliation emits under the SAME
    // identity the socket path uses.
    sockets.at(-1)!.deliver(frame('event.approval.requested', {
      approval_id: 'ap_outage', session_id: CREATED_ID, tool_call_id: 'c_outage',
      tool_name: 'Edit', action: 'write file', tool_input_display: { path: '/tmp/x' },
      created_at: 'x', expires_at: 'y',
    }));
    await settle();
    check('a WS replay of the reconciled card is not a second card',
      cards().length === 1, `${cards().length} cards`);
    pendingApprovals = [];
    await conn.close();
  }

  // ── 11b. Overlapping reconciliations COALESCE, they do not drop ───────────
  //
  // A pass already running used to make the next request a no-op. But the reads
  // in flight were issued against the PREVIOUS generation — `this.transport` is
  // replaced wholesale — and they answer for the session as it was before the
  // break that asked again. So the card that only the new generation can see was
  // never looked for, and the user sat in front of a session stopped for no
  // visible reason holding a question nobody delivered.

  const approvalRow = (id: string) => ({
    approval_id: id, session_id: CREATED_ID, tool_call_id: `c_${id}`,
    tool_name: 'Edit', action: 'write file', tool_input_display: { path: '/tmp/x' },
    created_at: 'x', expires_at: 'y',
  });
  const approvalReads = () =>
    requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}/approvals`).length;
  const questionReads = () =>
    requests.filter((entry) => entry.path === `/api/v1/sessions/${CREATED_ID}/questions`).length;
  const questionRow = (id: string) => ({
    question_id: id, session_id: CREATED_ID, created_at: 'x',
    questions: [{
      id: 'q_0', question: 'Continue?',
      options: [{ id: 'opt_0_0', label: 'Yes' }, { id: 'opt_0_1', label: 'No' }],
    }],
  });

  {
    const { conn, rows } = await drivenSession();
    const cards = (id: string) => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);

    // Generation 1 goes down with one card open, and the reconciliation its
    // reconnect triggers is PARKED with its read in flight.
    pendingApprovals = [approvalRow('ap_gen1')];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeReads = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('the first reconciliation pass is in flight, with nothing delivered yet',
      approvalReads() === beforeReads + 1 && cards('ap_gen1').length === 0,
      `reads=${approvalReads() - beforeReads} cards=${cards('ap_gen1').length}`);

    // The stream breaks and is replaced while that read is still out, and the
    // session opens a SECOND card in the meantime. The parked read cannot see
    // it — it is answered from the state its own request arrived in.
    pendingApprovals = [approvalRow('ap_gen1'), approvalRow('ap_gen2')];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('the second break issues no read of its own while a pass is running',
      approvalReads() === beforeReads + 1, `reads=${approvalReads() - beforeReads}`);

    parked.release();
    await settle();
    await settle();
    check('the coalesced follow-up pass delivers the FINAL generation\'s card, exactly once',
      cards('ap_gen2').length === 1 && approvalReads() === beforeReads + 2,
      `cards=${cards('ap_gen2').length} reads=${approvalReads() - beforeReads}`);
    // `ap_gen1` was in BOTH reads — generation 1's parked answer and generation
    // 2's fresh one — and reaches the client exactly once. The first read is
    // discarded (it answers for a server this connection has stopped talking
    // to), and the second one emits. Cross-pass dedupe by identity is proven on
    // the in-place path below, where both passes legitimately emit.
    check('a card seen by a discarded read and a fresh one is delivered exactly once',
      cards('ap_gen1').length === 1, `cards=${cards('ap_gen1').length}`);
    pendingApprovals = [];
    await conn.close();
  }

  {
    // F2, THE OWNER'S CASE: a card read on a generation that no longer exists.
    // The pass reads `ap_stale` from generation 1, the generation is replaced
    // while the read is parked, and generation 2 does not have that card at all
    // — it was resolved elsewhere, or its whole server process is gone. Emitting
    // it would put an ACTIONABLE approval in front of the user that nothing can
    // ever retract: the resolution event that would close it was the old
    // server's to send.
    const { conn, rows } = await drivenSession();
    const cards = (id: string) => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);
    pendingApprovals = [approvalRow('ap_stale')];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeReads = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();

    // The generation is replaced under the parked read, and the new one has
    // nothing pending.
    pendingApprovals = [];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    parked.release();
    await settle();
    await settle();
    check('a card read from a generation that was replaced under it is NEVER emitted',
      cards('ap_stale').length === 0, `cards=${cards('ap_stale').length}`);
    check('the discarded pass still spends its rerun on the current generation',
      approvalReads() === beforeReads + 2, `reads=${approvalReads() - beforeReads}`);
    await conn.close();
  }

  {
    // The same race with the SECOND variant of generation 2's pending set: it
    // lacks the stale card and holds a real one. The stale card must not appear,
    // and the real one must appear exactly once — a discard is not a dropped
    // reconciliation.
    const { conn, rows } = await drivenSession();
    const cards = (id: string) => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);
    pendingApprovals = [approvalRow('ap_stale_two')];
    const parked = gate();
    holdApprovals = parked.hold;
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();

    pendingApprovals = [approvalRow('ap_real')];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    parked.release();
    await settle();
    await settle();
    check('the stale card is discarded while the replacement generation\'s card is delivered exactly once',
      cards('ap_stale_two').length === 0 && cards('ap_real').length === 1,
      `stale=${cards('ap_stale_two').length} real=${cards('ap_real').length}`);
    pendingApprovals = [];
    await conn.close();
  }

  {
    // WHICH TRIGGER, part one: the REQUEST FLAG, isolated. A break that happens
    // IN PLACE — the frame ceiling refusing an oversized frame, with the socket
    // still open — asks for a reconciliation without replacing the generation,
    // so the flag is the only thing that can carry it past the running pass.
    // (And the frame it refused may have BEEN the approval card.)
    const { conn, rows } = await drivenSession();
    const cards = (id: string) => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);
    // A card the parked read WILL see. Its generation is never replaced, so this
    // read's results stay true and must be emitted — the discard rule is about a
    // read answering for a server that is gone, and an in-place break is the
    // same server saying it dropped a frame.
    pendingApprovals = [approvalRow('ap_same_gen')];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeReads = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();

    pendingApprovals = [approvalRow('ap_same_gen'), approvalRow('ap_in_place')];
    sockets.at(-1)!.fire('message', {
      data: JSON.stringify({
        type: 'event.session.work_changed', session_id: CREATED_ID,
        seq: 9_998, epoch: 'ep_drive', timestamp: 't',
        payload: {
          busy: true, pending_interaction: 'none',
          pad: 'x'.repeat(KIMI_WS_FRAME_MAX_BYTES),
        },
      }),
    });
    await settle();
    check('an in-place break during a running pass issues no read of its own',
      approvalReads() === beforeReads + 1, `reads=${approvalReads() - beforeReads}`);

    parked.release();
    await settle();
    await settle();
    check('the request flag alone carries an in-place break into exactly ONE follow-up pass',
      approvalReads() === beforeReads + 2 && cards('ap_in_place').length === 1,
      `reads=${approvalReads() - beforeReads} cards=${cards('ap_in_place').length}`);
    // NO OVER-DISCARD, and cross-pass dedupe with it: the parked read belonged to
    // the CURRENT generation, so its card is emitted rather than thrown away —
    // and the second pass, which saw the same card again, is one card because
    // the emission identity is the one the socket path uses.
    check('a same-generation read still emits its card, exactly once across both passes',
      cards('ap_same_gen').length === 1, `cards=${cards('ap_same_gen').length}`);
    pendingApprovals = [];
    await conn.close();
  }

  {
    // WHICH TRIGGER, part two: the GENERATION SNAPSHOT, isolated. A reconnect
    // that re-resolves the instance and then gets a socket which never opens
    // replaces `this.transport` without ever reaching `onStreamRestored`, so
    // NOTHING asks for a reconciliation. The only thing that can notice the read
    // still in flight is answering for a server this connection has already
    // stopped talking to is the snapshot that pass took of its own generation.
    const { conn, rows } = await drivenSession();
    const cards = () => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === 'ap_replaced_gen');
    pendingApprovals = [];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeReads = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();

    socketsOpenAutomatically = false;
    pendingApprovals = [approvalRow('ap_replaced_gen')];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a generation replaced with no stream to announce it asks for nothing, and reads nothing',
      approvalReads() === beforeReads + 1, `reads=${approvalReads() - beforeReads}`);

    parked.release();
    await settle();
    await settle();
    check('the generation snapshot alone runs exactly ONE follow-up pass, on the current generation',
      approvalReads() === beforeReads + 2 && cards().length === 1,
      `reads=${approvalReads() - beforeReads} cards=${cards().length}`);
    socketsOpenAutomatically = true;
    pendingApprovals = [];
    await conn.close();
  }

  /**
   * A driven connection whose reconciliation has just hit its pass ceiling with
   * work STILL PENDING — the state the delayed retry exists for.
   *
   * Shared rather than re-derived: producing it takes a parked read per pass and
   * a stream break landing inside each of them, and both the retry and its close
   * control need exactly this state and no other.
   */
  async function reconcileAtCeiling(): Promise<{
    conn: KimiDriveConnection; rows: AgentMessage[]; passes: number;
  }> {
    const { conn, rows } = await drivenSession();
    pendingApprovals = [];
    const beforeReads = approvalReads();
    const parks = [gate(), gate(), gate()];
    holdApprovals = parks[0]!.hold;
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    for (let index = 0; index < parks.length; index += 1) {
      // Break the stream INSIDE the pass that is parked, so its rerun condition
      // is true when it lands — and park the next pass before releasing this
      // one, so the flap continues into it.
      sockets.at(-1)!.fire('close', {});
      await settle();
      intervalHandler?.();
      await settle();
      if (index + 1 < parks.length) holdApprovals = parks[index + 1]!.hold;
      parks[index]!.release();
      await settle();
    }
    return { conn, rows, passes: approvalReads() - beforeReads };
  }

  {
    // THE PASS CAP. Coalescing alone does not end an incident whose stream keeps
    // flapping: every break landing during a pass buys another one, and two
    // reads apiece against a server that is already unwell is a loop this
    // connection must not enter.
    const { conn, rows, passes } = await reconcileAtCeiling();
    const cards = (id: string) => rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);
    check(`a flapping stream is bounded at ${KIMI_INTERACTION_RECONCILE_PASS_MAX} passes per invocation`,
      passes === KIMI_INTERACTION_RECONCILE_PASS_MAX, `passes=${passes}`);

    // ...and the ceiling must not SWALLOW the work it stopped short of. The last
    // pass ended with a rerun still demanded and NOTHING else is coming: no
    // further break, no epoch change, no resync. Without the delayed retry the
    // card below would sit unread until some unrelated discontinuity happened to
    // reconcile it, which is a card the user never sees.
    pendingApprovals = [approvalRow('ap_after_ceiling')];
    const beforeRetry = approvalReads();
    await conn.refresh();
    await settle();
    check('the ceiling leaves the pending work for the next poll tick, which runs exactly ONE fresh reconciliation',
      approvalReads() === beforeRetry + 1 && cards('ap_after_ceiling').length === 1,
      `passes=${approvalReads() - beforeRetry} cards=${cards('ap_after_ceiling').length}`);

    // CONTROL: the retry is paced by the poll and consumed by it. With nothing
    // pending, a refresh reconciles nothing at all — a tick must not become a
    // standing pair of card reads on every session.
    const beforeIdle = approvalReads();
    await conn.refresh();
    await settle();
    check('a refresh with nothing pending starts no reconciliation',
      approvalReads() === beforeIdle, `passes=${approvalReads() - beforeIdle}`);

    // ...and the cap ends the INVOCATION, not the mechanism. The next
    // discontinuity reconciles again, once.
    const beforeNext = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a later discontinuity still reconciles, exactly once',
      approvalReads() === beforeNext + 1, `passes=${approvalReads() - beforeNext}`);
    pendingApprovals = [];
    await conn.close();
  }

  {
    // CLOSE CANCELS THE RETRY. The pending flag outlives the invocation by
    // design, so the guard that stops it from outliving the CONNECTION has to be
    // proven: a closed connection reads nothing for anybody.
    const { conn } = await reconcileAtCeiling();
    pendingApprovals = [approvalRow('ap_after_close')];
    await conn.close();
    const beforeClosed = approvalReads();
    await conn.refresh();
    await settle();
    check('a connection closed with reconcile work pending runs no retry at all',
      approvalReads() === beforeClosed, `passes=${approvalReads() - beforeClosed}`);
    pendingApprovals = [];
  }

  // ── 11f. Reconciliation RETRACTS what was settled during the outage ───────
  //
  // The other half of the same repair, and the one nothing was doing: a card
  // this connection SHOWED, that the pending set no longer lists, was answered
  // while the view was down — by a terminal, or by another client of the shared
  // owner — and the resolution event that would have closed it is exactly what
  // the outage swallowed. Emitting nothing leaves an actionable card on screen
  // for the rest of the session, waiting for an answer the server will refuse.

  const resolutionsOf = (rows: AgentMessage[], id: string) =>
    rows.filter((row): row is Extract<AgentMessage, { type: 'permission-resolved' }> =>
      row.type === 'permission-resolved' && row.requestId === id);
  const cardsOf = (rows: AgentMessage[], id: string) =>
    rows.filter((row): row is Extract<AgentMessage, { type: 'permission-request' }> =>
      row.type === 'permission-request' && row.requestId === id);

  {
    const { conn, rows } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.approval.requested', approvalRow('ap_settled')));
    await settle();
    check('the approval card is on screen before the outage',
      cardsOf(rows, 'ap_settled').length === 1, `cards=${cardsOf(rows, 'ap_settled').length}`);

    // The stream breaks; somebody else answers the card while it is down, so the
    // pending set comes back WITHOUT it.
    pendingApprovals = [];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a card settled during the outage is retracted as EXTERNAL, exactly once',
      resolutionsOf(rows, 'ap_settled').length === 1
        && resolutionsOf(rows, 'ap_settled')[0]?.decision === 'external',
      `${resolutionsOf(rows, 'ap_settled').length} rows,`
      + ` decision=${resolutionsOf(rows, 'ap_settled')[0]?.decision}`);

    // DEDUPE, the same property the recovery direction has: the real resolution
    // replayed by the cursor moments later is the SAME resolution, because the
    // retraction used the identity the socket path uses.
    sockets.at(-1)!.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_settled', session_id: CREATED_ID, decision: 'rejected', resolved_at: 'x',
    }));
    await settle();
    check('a WS replay of the real resolution after a retraction is not a second resolution',
      resolutionsOf(rows, 'ap_settled').length === 1,
      `${resolutionsOf(rows, 'ap_settled').length} rows`);
    await conn.close();
  }

  {
    // The same for a QUESTION, plus the registry half: a retracted question must
    // stop being answerable, because answering one the server no longer holds is
    // a wrong answer sent confidently.
    const { conn, rows } = await drivenSession();
    const resolved = () => rows.filter((row) =>
      row.type === 'question-resolved' && row.requestId === 'qn_settled');
    sockets.at(-1)!.deliver(frame('event.question.requested', questionRow('qn_settled')));
    await settle();
    pendingQuestions = [];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a question settled during the outage is retracted, exactly once',
      resolved().length === 1, `${resolved().length} rows`);
    const beforeLate = requests.length;
    const late = await threw(() => conn.answerQuestion('qn_settled', [['Yes']]));
    check('the retracted question is no longer answerable, with ZERO HTTP',
      /no longer known/.test(late?.message ?? '') && requests.length === beforeLate,
      `${late?.message} calls=${requests.length - beforeLate}`);
    await conn.close();
  }

  {
    // THE TWO-POINT MEMBERSHIP RULE. A card that opened WHILE the snapshot reads
    // were out is legitimately absent from a reading taken before it existed, so
    // retracting on the snapshot alone would cancel a live card the user is
    // looking at right now.
    const { conn, rows } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.approval.requested', approvalRow('ap_before_read')));
    await settle();
    pendingApprovals = [];
    const parked = gate();
    holdApprovals = parked.hold;
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    // ...and now, with the read in flight, a new card arrives on the live stream.
    sockets.at(-1)!.deliver(frame('event.approval.requested', approvalRow('ap_during_read')));
    await settle();
    parked.release();
    await settle();
    await settle();
    check('a card that arrived DURING the snapshot read is never retracted',
      cardsOf(rows, 'ap_during_read').length === 1
        && resolutionsOf(rows, 'ap_during_read').length === 0,
      `cards=${cardsOf(rows, 'ap_during_read').length}`
      + ` resolutions=${resolutionsOf(rows, 'ap_during_read').length}`);
    check('...while the card open before the read began is retracted',
      resolutionsOf(rows, 'ap_before_read').length === 1,
      `${resolutionsOf(rows, 'ap_before_read').length} rows`);
    await conn.close();
  }

  {
    // A PARTIAL READ IS NOT A READING. Approvals answered and questions did not,
    // so this connection knows half of what is open — which is not enough to add
    // a card, not enough to retract one, and not enough to touch the registry.
    const { conn, rows } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.approval.requested', approvalRow('ap_partial_open')));
    sockets.at(-1)!.deliver(frame('event.question.requested', questionRow('qn_partial_open')));
    await settle();
    pendingApprovals = [approvalRow('ap_partial_new')];
    questionsFail = true;
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('a half-read pending set adds no card and retracts none',
      cardsOf(rows, 'ap_partial_new').length === 0
        && resolutionsOf(rows, 'ap_partial_open').length === 0
        && rows.filter((row) => row.type === 'question-resolved').length === 0,
      `added=${cardsOf(rows, 'ap_partial_new').length}`
      + ` retracted=${resolutionsOf(rows, 'ap_partial_open').length}`);
    // ...and the registry is untouched, so the open question is still answerable.
    questionsFail = false;
    const stillAnswerable = await threw(() => conn.answerQuestion('qn_partial_open', [['Yes']]));
    check('a half-read pending set leaves the question registry untouched',
      stillAnswerable === undefined, `${stillAnswerable?.message}`);
    pendingApprovals = [];
    await conn.close();
  }

  {
    // A REPLACED-GENERATION READ retracts nothing either, for the round-5
    // reason: its silence about a card is the OLD server's silence, and that is
    // not evidence about this one. The snapshot bails the moment the generation
    // moves, so it does not even spend the second read.
    const { conn, rows } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.approval.requested', approvalRow('ap_kept')));
    await settle();
    pendingApprovals = [];
    pendingQuestions = [questionRow('qn_discarded')];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeApprovals = approvalReads();
    const beforeQuestions = questionReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();

    // The generation is replaced under the parked read, and the card is still
    // pending on the one that replaced it.
    pendingApprovals = [approvalRow('ap_kept')];
    pendingQuestions = [];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    parked.release();
    await settle();
    await settle();
    check('a read whose generation was replaced under it retracts nothing',
      resolutionsOf(rows, 'ap_kept').length === 0,
      `${resolutionsOf(rows, 'ap_kept').length} rows`);
    check('the discarded read never spends its second half, so no question record is registered',
      approvalReads() === beforeApprovals + 2 && questionReads() === beforeQuestions + 1,
      `approvals=${approvalReads() - beforeApprovals} questions=${questionReads() - beforeQuestions}`);
    const beforeUnknown = requests.length;
    const unknown = await threw(() => conn.answerQuestion('qn_discarded', [['Yes']]));
    check('a question only the discarded generation held is unanswerable, with ZERO HTTP',
      /no longer known/.test(unknown?.message ?? '') && requests.length === beforeUnknown,
      `${unknown?.message} calls=${requests.length - beforeUnknown}`);
    // CONTROL: a card the snapshot still lists stays open and is not re-emitted.
    check('a card still pending in the snapshot stays open and is delivered exactly once',
      cardsOf(rows, 'ap_kept').length === 1, `cards=${cardsOf(rows, 'ap_kept').length}`);
    pendingApprovals = [];
    await conn.close();
  }

  // ── 11g. Reconciliation respects the zero-subscriber read guard ───────────
  //
  // Both pending reads FORCE-LOAD the session into the Kimi server, making it a
  // second live owner alongside any terminal holding the same session. A
  // reconnect (or a ceiling retry) landing after the last client left would pay
  // that coexistence cost for a session nobody is watching, and buy nothing:
  // there is no handler for the card it would recover.

  {
    const { conn, rows, unsubscribe } = await drivenSession();
    pendingApprovals = [approvalRow('ap_no_watcher')];
    unsubscribe();

    const beforeIdle = approvalReads();
    const beforeIdleQuestions = questionReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    await conn.refresh();
    await settle();
    check('a reconnect with no subscriber issues ZERO pending-interaction reads',
      approvalReads() === beforeIdle && questionReads() === beforeIdleQuestions,
      `approvals=${approvalReads() - beforeIdle} questions=${questionReads() - beforeIdleQuestions}`);

    // ...and the demand SURVIVES the guard. The discontinuity happened and the
    // card it swallowed is still missing, so the first refresh after a client
    // returns runs the work rather than waiting for another break.
    const returning = conn.subscribe((message) => rows.push(message));
    const beforeReturn = approvalReads();
    await conn.refresh();
    await settle();
    check('the held reconciliation runs on the first refresh after a subscriber returns',
      approvalReads() === beforeReturn + 1 && cardsOf(rows, 'ap_no_watcher').length === 1,
      `reads=${approvalReads() - beforeReturn} cards=${cardsOf(rows, 'ap_no_watcher').length}`);

    // MECHANISM CONTROL: the same reconnect with a subscriber present reads
    // exactly as it did before the guard existed.
    const beforeControl = approvalReads();
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    check('the same reconnect with a subscriber present still reconciles, once',
      approvalReads() === beforeControl + 1, `reads=${approvalReads() - beforeControl}`);
    returning();
    pendingApprovals = [];
    await conn.close();
  }

  // ── 11h. The ATTACH REPLAY is a delivery, so it is retractable too ────────
  //
  // A card reaches a client three ways — a request frame, a reconciliation, and
  // the attach-time replay — and the replay is the most common of the three: a
  // session already blocked when a client joins delivers no request frame at
  // all. Only the two-point retraction rule can ever close such a card if
  // somebody else answers it, and that rule reads the open-interaction registry,
  // so a replay that showed a card without recording it left the user holding an
  // actionable box nothing in the system could ever take back.

  /**
   * The open-interaction registry, read directly.
   *
   * It has no broker-facing surface and must not grow one — it is the INPUT to a
   * retraction, not a fact a client reasons about — and the properties below are
   * about what it holds after a race, so a behavioural proxy would pass for the
   * wrong reason as often as the right one.
   */
  const openIds = (conn: object): string[] =>
    [...(conn as unknown as { openInteractions: Map<string, string> }).openInteractions.keys()];
  const questionCardsOf = (rows: AgentMessage[], id: string) =>
    rows.filter((row) => row.type === 'question-request' && row.requestId === id);
  const questionResolutionsOf = (rows: AgentMessage[], id: string) =>
    rows.filter((row) => row.type === 'question-resolved' && row.requestId === id);

  {
    const { conn, rows } = await drivenSession();
    pendingApprovals = [approvalRow('ap_replayed')];
    pendingQuestions = [questionRow('qn_replayed')];
    // NO WS REQUEST FRAME IS EVER DELIVERED for either card: the replay is the
    // only path they take, which is the case the registry used to miss.
    const replayed = await conn.getPending();
    check('the attach replay delivers both cards and RECORDS them as shown',
      replayed.length === 2
        && JSON.stringify(openIds(conn)) === JSON.stringify(['ap_replayed', 'qn_replayed']),
      `rows=${replayed.length} open=${openIds(conn).join(',')}`);

    // ...and now somebody else answers both while this connection's stream is
    // down, so the pending set comes back empty.
    pendingApprovals = [];
    pendingQuestions = [];
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    await settle();
    check('a card delivered ONLY by the attach replay is retracted as EXTERNAL, exactly once',
      resolutionsOf(rows, 'ap_replayed').length === 1
        && resolutionsOf(rows, 'ap_replayed')[0]?.decision === 'external'
        && questionResolutionsOf(rows, 'qn_replayed').length === 1,
      `approval=${resolutionsOf(rows, 'ap_replayed').length}`
      + ` decision=${resolutionsOf(rows, 'ap_replayed')[0]?.decision}`
      + ` question=${questionResolutionsOf(rows, 'qn_replayed').length}`);
    const late = await threw(() => conn.answerQuestion('qn_replayed', [['Yes']]));
    check('...and the retracted replay question is no longer answerable, with ZERO HTTP',
      /no longer known/.test(late?.message ?? '') && openIds(conn).length === 0,
      `${late?.message} open=${openIds(conn).join(',')}`);
    await conn.close();
  }

  {
    // POSTURE, not session: an observe connection runs no reconciliation, so
    // tracking there would be an entry with no reader. It still registers the
    // question RECORD — that is how a connection promoted by a later attach
    // recovers the native ids — so the two halves are checked apart.
    const adapter = makeAdapter();
    const observing = await adapter.attach(FOREIGN_ID);
    (observing.info as { status: string }).status = 'needs-input';
    pendingApprovals = [approvalRow('ap_observed')];
    pendingQuestions = [questionRow('qn_observed')];
    const observed = await observing.getPending?.() ?? [];
    check('an observe replay shows both cards read-only and tracks NOTHING',
      observed.length === 2
        && observed.every((row) => (row as { readOnly?: boolean }).readOnly === true)
        && openIds(observing).length === 0,
      `rows=${observed.length} open=${openIds(observing).join(',')}`);
    await observing.close();
    pendingApprovals = [];
    pendingQuestions = [];
  }

  // ── 11i. A resolution that lands DURING the reads is not undone ───────────
  //
  // The snapshot is one reading of two endpoints, and the server takes each half
  // when the request arrives. So a card the frame handler settles between them
  // is still listed by the half that has not answered yet. Applying that listing
  // re-opens a card this connection has already closed — and for a question it
  // restores the ANSWERING record, so a late answer would be sent confidently to
  // something the server settled long ago. Nothing could correct it either: the
  // resolution's emission identity is already in the seen-set, so a retraction
  // on the next pass dedupes to silence.

  {
    const { conn, rows } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.question.requested', questionRow('qn_midread')));
    await settle();
    // The server's reading still lists it: it was taken before the answer landed.
    pendingQuestions = [questionRow('qn_midread')];
    const parked = gate();
    holdApprovals = parked.hold;
    sockets.at(-1)!.fire('close', {});
    await settle();
    intervalHandler?.();
    await settle();
    // ...and HERE, with the approvals half still out and the questions half not
    // yet issued, the real resolution arrives on the stream.
    sockets.at(-1)!.deliver(frame('event.question.answered', {
      question_id: 'qn_midread', session_id: CREATED_ID,
    }));
    await settle();
    parked.release();
    await settle();
    await settle();
    check('a question settled mid-read is not re-opened by the snapshot that still lists it',
      !openIds(conn).includes('qn_midread'), `open=${openIds(conn).join(',')}`);
    const beforeLate = requests.length;
    const late = await threw(() => conn.answerQuestion('qn_midread', [['Yes']]));
    check('...its answering record is not restored either: a late answer refuses with ZERO HTTP',
      /no longer known/.test(late?.message ?? '') && requests.length === beforeLate,
      `${late?.message} calls=${requests.length - beforeLate}`);
    // The counting controls: one resolution for one card, and the re-emission
    // the snapshot would have made is not a second card either way — the
    // identity dedupe covers that, and it is pinned so a future change to the
    // identities cannot quietly turn the skip into a visible duplicate.
    check('...and the card settles exactly once, with no second request card',
      questionResolutionsOf(rows, 'qn_midread').length === 1
        && questionCardsOf(rows, 'qn_midread').length === 1,
      `resolved=${questionResolutionsOf(rows, 'qn_midread').length}`
      + ` cards=${questionCardsOf(rows, 'qn_midread').length}`);
    pendingQuestions = [];
    await conn.close();
  }

  {
    // THE SAME INTERLEAVING through the attach replay, which reads the same two
    // endpoints in the same order and must make the same decision: a card
    // settled between them is not handed to the attaching client at all.
    // Returning it would be worse here than in the reconciliation, because the
    // replay's whole job is to seed a client that has no other view.
    const { conn } = await drivenSession();
    const socket = sockets.at(-1)!;
    socket.deliver(frame('event.question.requested', questionRow('qn_replay_midread')));
    await settle();
    pendingApprovals = [];
    pendingQuestions = [questionRow('qn_replay_midread')];
    const parked = gate();
    holdApprovals = parked.hold;
    const replaying = conn.getPending();
    await settle();
    socket.deliver(frame('event.question.answered', {
      question_id: 'qn_replay_midread', session_id: CREATED_ID,
    }));
    await settle();
    parked.release();
    const replayed = await replaying;
    check('the replay drops a card that settled while its own reads were out',
      replayed.length === 0 && !openIds(conn).includes('qn_replay_midread'),
      `rows=${replayed.map((row) => row.type).join(',')} open=${openIds(conn).join(',')}`);
    const beforeLate = requests.length;
    const late = await threw(() => conn.answerQuestion('qn_replay_midread', [['Yes']]));
    check('...and the replay does not restore its answering record either',
      /no longer known/.test(late?.message ?? '') && requests.length === beforeLate,
      `${late?.message} calls=${requests.length - beforeLate}`);
    pendingQuestions = [];
    await conn.close();
  }

  // ── 11j. A DEMOTION landing during the pending reads ──────────────────────
  //
  // The pending reads are awaited, and `demoteToObserve` runs IN PLACE: the
  // connection stays open, flips to observe posture, and clears its open set. So
  // a pass that entered while driving can land after the session has been proven
  // to have a second writer, carrying cards that were mapped `readOnly: false`
  // against a posture that no longer exists. Handing those over unchanged puts
  // enabled controls in front of the user that fail only once they act, and
  // re-fills the registry the demotion just emptied.
  //
  // The cards are still SHOWN — the user should see what the session is blocked
  // on, and the sessionInfo flip has already said the connection cannot drive —
  // but read-only, registering nothing, and the loop stops rather than spending
  // another pair of force-loading reads on a connection that answers nothing.

  /**
   * The answering registry, read directly, for the same reason {@link openIds}
   * is: it has no broker-facing surface, and "was a record ADDED by this pass"
   * is not observable from a refusal that would happen anyway — a demoted
   * connection refuses at the write gate long before the record is consulted.
   */
  const questionRecordIds = (conn: object): string[] =>
    [...(conn as unknown as { questionRecords: Map<string, unknown> }).questionRecords.keys()];
  /** The rerun demand, read directly, so a "no further pass" claim cannot pass vacuously. */
  const rerunPending = (conn: object): boolean =>
    (conn as unknown as { reconcileRequested: boolean }).reconcileRequested;

  /**
   * An IN-PLACE break: an oversized frame the reader drops before parsing, on a
   * socket that stays open.
   *
   * The one reconciliation trigger that runs no transcript walk of its own,
   * which is what lets the demotion be ordered exactly — INSIDE the parked pass
   * rather than before it. A reconnect trigger would run a walk in the same tick
   * and could demote before the pass had started, which proves nothing.
   */
  const inPlaceBreak = (socket: FakeSocket): void => {
    socket.fire('message', {
      data: JSON.stringify({
        type: 'event.session.work_changed', session_id: CREATED_ID,
        seq: 9_990, epoch: 'ep_drive', timestamp: 't',
        payload: {
          busy: true, pending_interaction: 'none',
          pad: 'x'.repeat(KIMI_WS_FRAME_MAX_BYTES),
        },
      }),
    });
  };

  /**
   * Demote for real, by the established route: an unexplained foreign user row
   * that survives {@link KIMI_DIVERGENCE_CONFIRM_POLLS} healthy polls (section
   * 9). Not a flag flip — the point of these checks is what a REAL demotion
   * leaves behind.
   */
  const demoteByForeignRow = async (conn: KimiDriveConnection, id: string): Promise<void> => {
    messages = [userRow(id, 'typed in a terminal'), ...messages];
    for (let poll = 0; poll < KIMI_DIVERGENCE_CONFIRM_POLLS; poll += 1) await conn.refresh();
  };

  {
    // THE RECONCILE PATH, with cards that were NEVER SHOWN before: fresh ids, no
    // request frame, so nothing dedupes and every emission below is a first
    // delivery. That is the case that reaches a client as an actionable box.
    const { conn, rows } = await drivenSession();
    pendingApprovals = [approvalRow('ap_crossing')];
    pendingQuestions = [questionRow('qn_crossing')];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeApprovals = approvalReads();
    const beforeQuestions = questionReads();
    inPlaceBreak(sockets.at(-1)!);
    await settle();
    await demoteByForeignRow(conn, 'msg_cross_reconcile');
    check('the demotion lands INSIDE the parked pass: the approvals half is out, the questions half is not, nothing delivered',
      conn.demotedToObserve === true
        && approvalReads() === beforeApprovals + 1 && questionReads() === beforeQuestions
        && cardsOf(rows, 'ap_crossing').length === 0
        && questionCardsOf(rows, 'qn_crossing').length === 0,
      `demoted=${conn.demotedToObserve} approvals=${approvalReads() - beforeApprovals}`
      + ` questions=${questionReads() - beforeQuestions}`);

    parked.release();
    await settle();
    await settle();
    const approval = cardsOf(rows, 'ap_crossing')[0];
    const question = questionCardsOf(rows, 'qn_crossing')[0];
    check('a pass that crossed a demotion still DELIVERS both cards, and both are read-only',
      cardsOf(rows, 'ap_crossing').length === 1 && approval?.readOnly === true
        && questionCardsOf(rows, 'qn_crossing').length === 1
        && (question as { readOnly?: boolean } | undefined)?.readOnly === true,
      `approval=${JSON.stringify(approval)} question=${JSON.stringify(question)}`);
    // The registry half, read directly: the demotion cleared the open set on the
    // documented invariant that this connection answers nothing more, and a pass
    // still in flight must not re-fill it — nor mint an answering record for a
    // question it can never send an answer to.
    check('...and it registers NOTHING: the open set stays empty and no answering record is added',
      openIds(conn).length === 0 && !questionRecordIds(conn).includes('qn_crossing'),
      `open=${openIds(conn).join(',') || '(none)'} records=${questionRecordIds(conn).join(',') || '(none)'}`);

    // NEGATIVE CONTROL: the cards are read-only because they are genuinely
    // unanswerable, and the write gate says the same thing with ZERO HTTP.
    const beforeRefusals = requests.length;
    const approving = await threw(() => conn.respondPermission('ap_crossing', 'approve'));
    const answering = await threw(() => conn.answerQuestion('qn_crossing', [['Yes']]));
    check('the connection is still demoted, and both delivered cards refuse with ZERO HTTP',
      conn.demotedToObserve === true && conn.info.attachMode === 'observe'
        && approving?.message === KIMI_DEMOTED_REFUSAL
        && answering?.message === KIMI_DEMOTED_REFUSAL
        && requests.length === beforeRefusals,
      `${approving?.message} | ${answering?.message} calls=${requests.length - beforeRefusals}`);
    pendingApprovals = [];
    pendingQuestions = [];
    await conn.close();
  }

  {
    // THE SAME INTERLEAVING through `getPending`, which is the OTHER apply site
    // and the one an attaching client is served from: it enters while driving,
    // the demotion lands between its two reads, and what it returns is what the
    // client renders.
    const { conn } = await drivenSession();
    pendingApprovals = [approvalRow('ap_crossing_replay')];
    pendingQuestions = [questionRow('qn_crossing_replay')];
    const parked = gate();
    holdApprovals = parked.hold;
    const replaying = conn.getPending();
    await settle();
    await demoteByForeignRow(conn, 'msg_cross_getpending');
    parked.release();
    const replayed = await replaying;
    check('an attach replay that crossed a demotion returns both cards read-only, and tracks nothing',
      conn.demotedToObserve === true && replayed.length === 2
        && replayed.every((row) => (row as { readOnly?: boolean }).readOnly === true)
        && openIds(conn).length === 0,
      `demoted=${conn.demotedToObserve}`
      + ` rows=${replayed.map((row) => `${row.type}:${(row as { readOnly?: boolean }).readOnly}`).join(',')}`
      + ` open=${openIds(conn).join(',') || '(none)'}`);
    pendingApprovals = [];
    pendingQuestions = [];
    await conn.close();
  }

  {
    // THE LOOP STOPS. A rerun demanded during the crossing pass — a second
    // in-place break, which is exactly the trigger the reads are meant to answer
    // — must not start another one: the entry gate refuses a demoted connection
    // for the force-load reason, and that reason does not weaken mid-loop.
    const { conn } = await drivenSession();
    pendingApprovals = [];
    pendingQuestions = [];
    const parked = gate();
    holdApprovals = parked.hold;
    const beforeApprovals = approvalReads();
    const beforeQuestions = questionReads();
    inPlaceBreak(sockets.at(-1)!);
    await settle();
    // ...and a SECOND break while that pass is parked, which is what sets the
    // rerun demand the pass would otherwise act on when it lands.
    inPlaceBreak(sockets.at(-1)!);
    await settle();
    await demoteByForeignRow(conn, 'msg_cross_rerun');

    parked.release();
    await settle();
    await settle();
    check('a pass that crossed a demotion runs NO further pass: one pair of reads in the whole incident',
      approvalReads() === beforeApprovals + 1 && questionReads() === beforeQuestions + 1,
      `approvals=${approvalReads() - beforeApprovals} questions=${questionReads() - beforeQuestions}`);
    // NOT VACUOUS: the demand really was standing when the pass ended, so the
    // count above is a pass that was refused rather than one nothing asked for.
    // It is left set on purpose — `refresh` consults the posture before acting on
    // it, so it can never be spent by a demoted connection.
    check('...and the rerun demand was genuinely standing, and is left inert rather than spent',
      rerunPending(conn) === true && conn.demotedToObserve === true,
      `requested=${rerunPending(conn)} demoted=${conn.demotedToObserve}`);
    const beforeIdle = approvalReads();
    await conn.refresh();
    await settle();
    check('...so a later poll tick starts nothing either',
      approvalReads() === beforeIdle, `passes=${approvalReads() - beforeIdle}`);
    await conn.close();
  }

  {
    // THE MONOTONE CONTROL, and the reason the hardening is a one-way ADD rather
    // than a re-projection from posture. An UNANSWERABLE question is read-only
    // for a driving connection too (the mapper marks it, because there is
    // nothing to key an answer by), so an apply site that recomputed the flag
    // from its own posture would hand the user controls that could only submit
    // invented ids. Checked at BOTH apply sites, on a healthy driving connection.
    const unkeyableRow = (id: string) => ({
      question_id: id, session_id: CREATED_ID, created_at: 'x',
      questions: [{ question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
    });
    const { conn, rows } = await drivenSession();
    pendingApprovals = [approvalRow('ap_monotone')];
    pendingQuestions = [unkeyableRow('qn_monotone')];
    const replayed = await conn.getPending();
    check('the replay of a DRIVING connection keeps an unanswerable question read-only and its approval actionable',
      conn.demotedToObserve === false && replayed.length === 2
        && (replayed[0] as { readOnly?: boolean }).readOnly === undefined
        && (replayed[1] as { readOnly?: boolean }).readOnly === true,
      replayed.map((row) => `${row.type}:${(row as { readOnly?: boolean }).readOnly}`).join(','));

    pendingApprovals = [approvalRow('ap_monotone_rec')];
    pendingQuestions = [unkeyableRow('qn_monotone_rec')];
    inPlaceBreak(sockets.at(-1)!);
    await settle();
    await settle();
    const reconciled = questionCardsOf(rows, 'qn_monotone_rec')[0];
    check('...and so does the reconciliation, which applies the same snapshot on the same posture',
      cardsOf(rows, 'ap_monotone_rec').length === 1
        && cardsOf(rows, 'ap_monotone_rec')[0]?.readOnly === undefined
        && questionCardsOf(rows, 'qn_monotone_rec').length === 1
        && (reconciled as { readOnly?: boolean } | undefined)?.readOnly === true,
      `approval=${JSON.stringify(cardsOf(rows, 'ap_monotone_rec')[0])} question=${JSON.stringify(reconciled)}`);
    pendingApprovals = [];
    pendingQuestions = [];
    await conn.close();
  }

  // ── 12. The submission fence ─────────────────────────────────────────────

  {
    // Upstream can publish `prompt.completed` for a turn it blocked or failed
    // BEFORE the submit's reply is written (`promptService.ts:141-148` races the
    // launch against the completion; `:274-278` completes a hook-blocked prompt
    // inside that race; `routes/prompts.ts:285` sends the reply afterwards).
    // That event triggers a REST refresh, and a refresh landing here would
    // deliver this connection's OWN user row before it has learned the id to
    // correlate it by — an uncorrelated echo, so the client's optimistic bubble
    // never converges and the prompt appears twice.
    const { conn, rows } = await drivenSession();
    const socket = sockets.at(-1)!;
    const echoes = () => rows.filter((row): row is Extract<AgentMessage, { type: 'user-message' }> =>
      row.type === 'user-message' && row.text === 'fence me');

    const submit = gate();
    messages = [userRow('msg_fenced_echo', 'fence me'), ...messages];
    promptAnswer = ok({ prompt_id: 'prompt_fenced', user_message_id: 'msg_fenced_echo', status: 'blocked', content: [], created_at: 'x' });
    holdPrompt = submit.hold;
    const sending = conn.sendPrompt({ text: 'fence me', clientMessageId: 'client-fenced' });
    await settle();

    // The blocked turn's completion arrives while the POST is still out, and a
    // second trigger for good measure.
    socket.deliver(frame('prompt.completed', { promptId: 'prompt_fenced', finishedAt: 'x', reason: 'blocked' }));
    await conn.refresh();
    await settle();
    check('no user row is emitted while the submit POST is unresolved',
      echoes().length === 0, `${echoes().length} early rows`);

    submit.release();
    await sending;
    await settle();
    check('the held refresh delivers the row exactly ONCE, carrying the clientKey',
      echoes().length === 1 && echoes()[0]?.clientKey === 'client-fenced',
      `${echoes().length} rows, clientKey=${echoes()[0]?.clientKey}`);
    // ...and the row never looked foreign to the detector on the way through.
    await conn.refresh();
    await conn.refresh();
    check('the fenced echo never becomes a suspect',
      conn.demotedToObserve === false, `demoted=${conn.demotedToObserve}`);
    // ...and it SUSPENDED nothing on the way through either. Now that ANY open
    // provenance refuses a content write, an echo that was suspected even for
    // one interval would surface here as a refused prompt rather than as a
    // demotion — a quieter failure than the one above, and the one a user would
    // actually meet.
    promptAnswer = ok({ prompt_id: 'prompt_after_fence', user_message_id: 'msg_after_fence', status: 'running', content: [], created_at: 'x' });
    const beforeThrough = writes().length;
    const wroteThrough = await threw(() => conn.sendPrompt({ text: 'straight through' }));
    check('the fenced echo suspends no write: the next prompt goes straight through',
      wroteThrough === undefined && writes().length === beforeThrough + 1,
      `${wroteThrough?.message} writes=${writes().length - beforeThrough}`);

    // MECHANISM CONTROL: with no submit in flight, a refresh is not held at all.
    messages = [assistantRow('msg_unfenced', 'delivered normally'), ...messages];
    await conn.refresh();
    check('a refresh with no in-flight submit is unaffected by the fence',
      rows.some((row) => row.type === 'model-output' && row.text === 'delivered normally'));
    await conn.close();
  }

  // ── 13. A single-answer question cannot be answered twice over ───────────

  {
    const { conn } = await drivenSession();
    sockets.at(-1)!.deliver(frame('event.question.requested', {
      question_id: 'qn_single', session_id: CREATED_ID, created_at: 'x',
      questions: [{
        id: 'q_0', question: 'Pick one',
        options: [{ id: 'opt_0_0', label: 'Alpha' }, { id: 'opt_0_1', label: 'Beta' }],
        allow_other: true,
      }],
    }));
    // NEGATIVE CONTROL: the native union has one slot here, so a plural
    // selection is refused BEFORE any transport is touched — not truncated to
    // whichever value this code happens to prefer.
    const beforeAmbiguous = requests.length;
    const twoOptions = await threw(() => conn.answerQuestion('qn_single', [['Alpha', 'Beta']]));
    const optionPlusText = await threw(() => conn.answerQuestion('qn_single', [['Alpha', 'my own answer']]));
    check('a plural answer to a single-answer question refuses with ZERO HTTP',
      twoOptions?.message === KIMI_AMBIGUOUS_SINGLE_ANSWER
        && optionPlusText?.message === KIMI_AMBIGUOUS_SINGLE_ANSWER
        && requests.length === beforeAmbiguous,
      `${twoOptions?.message} calls=${requests.length - beforeAmbiguous}`);
    // ...and one value still answers, so the refusal is not overbroad.
    await conn.answerQuestion('qn_single', [['Beta']]);
    check('a single value still answers normally',
      JSON.stringify((writes().at(-1)?.body as { answers?: Record<string, unknown> })?.answers?.q_0)
        === JSON.stringify({ kind: 'single', option_id: 'opt_0_1' }),
      JSON.stringify(writes().at(-1)?.body));
    await conn.close();
  }

  // ── 14. Replacement generations, and the write gate across one ───────────
  //
  // A connection outlives the identity it was verified under: a Kimi restart, a
  // port another process now owns, or a rotated token leaves its pinned client,
  // socket url, and token describing a server that is gone. The generation is
  // therefore replaced WHOLE — and a write is the one operation where landing on
  // the wrong server cannot be undone, so what has to be proved is that the
  // write went through the REPLACEMENT's door and not the dead one.

  {
    let currentToken = 'fixture-token';
    // The stream ceiling is long enough here that a write parked on the
    // REPLACEMENT socket's handshake is decided by the test firing `open`, never
    // by the clock — the two refusal checks below still wait it out in full.
    const adapter = makeAdapter(liveScan, { readToken: () => currentToken, writeStreamWaitMs: 400 });
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    conn.subscribe(() => {});
    messages = [];
    await conn.getHistory();
    await settle();

    promptAnswer = ok({ prompt_id: 'prompt_gen1', user_message_id: 'msg_gen1', status: 'running', content: [], created_at: 'x' });
    await conn.sendPrompt({ text: 'on the first generation' });
    const firstWrite = writes().at(-1);

    // The server stops accepting the credential this connection holds — the
    // shape a rotation or a restarted server takes from here.
    acceptedToken = 'fixture-token-2';
    currentToken = 'fixture-token-2';
    const unauthorized = await threw(() => conn.sendPrompt({ text: 'on a refused credential' }));
    check('a write with a refused credential fails rather than reporting a send that did not happen',
      !!unauthorized, unauthorized?.message ?? '(did not throw)');

    // THE GENERATION IS NOW DOWN WITH ITS SOCKET STILL OPEN, which is the exact
    // shape the retirement rule is about: the next content write passes the
    // stream gate on the OLD socket, and the write client it then resolves
    // belongs to the NEW one. Replacement has to take the socket with it, and
    // the write has to wait for the replacement stream — otherwise the prompt
    // lands on a server whose approvals come back somewhere nobody is listening.
    socketsOpenAutomatically = false;
    const retiring = sockets.at(-1)!;
    const socketsBeforeSwap = sockets.length;
    const beforeSwapWrites = writes().length;
    promptAnswer = ok({ prompt_id: 'prompt_gen2', user_message_id: 'msg_gen2', status: 'running', content: [], created_at: 'x' });
    const swapping = conn.sendPrompt({ text: 'on the replacement generation' });
    await settle();
    await settle();
    check('replacing the generation RETIRES its socket and opens one on the new generation',
      retiring.closed === true && sockets.length === socketsBeforeSwap + 1
        && sockets.at(-1) !== retiring,
      `retiredClosed=${retiring.closed} sockets=${sockets.length - socketsBeforeSwap}`);
    // NEGATIVE CONTROL, and the whole point: the POST has NOT happened. The old
    // socket is gone and the replacement has not opened, so there is no live
    // stream for this write however open the stream was when it started.
    check('a write whose generation was replaced mid-acquisition does not POST until the REPLACEMENT socket opens',
      writes().length === beforeSwapWrites, `writes=${writes().length - beforeSwapWrites}`);

    sockets.at(-1)!.fire('open', {});
    await swapping;
    const secondWrite = writes().at(-1);
    check('the next write goes through the REPLACEMENT generation\'s write client',
      firstWrite?.bearer === 'Bearer fixture-token'
        && secondWrite?.bearer === 'Bearer fixture-token-2'
        && secondWrite.path === `/api/v1/sessions/${CREATED_ID}/prompts`
        && writes().length === beforeSwapWrites + 1,
      `first=${firstWrite?.bearer === secondWrite?.bearer ? 'same' : 'different'} generation`);
    socketsOpenAutomatically = true;

    // Now the socket dies. Restoring it re-resolves the instance first (the
    // socket may have died BECAUSE the server did), so the replacement socket
    // and the replacement write client come from one fresh snapshot — and a
    // write must wait for that socket to actually open.
    acceptedToken = 'fixture-token-3';
    currentToken = 'fixture-token-3';
    socketsOpenAutomatically = false;
    sockets.at(-1)!.fire('close', {});
    await settle();
    const beforeHeld = writes().length;
    const socketsBefore = sockets.length;
    const heldWrite = await threw(() => conn.sendPrompt({ text: 'before the replacement stream' }));
    check('a write attempted before the REPLACEMENT socket has opened is refused, with ZERO writes',
      heldWrite?.message === KIMI_NO_STREAM_REFUSAL
        && writes().length === beforeHeld
        && sockets.length === socketsBefore + 1,
      `${heldWrite?.message} writes=${writes().length - beforeHeld} sockets=${sockets.length - socketsBefore}`);

    sockets.at(-1)!.fire('open', {});
    await settle();
    promptAnswer = ok({ prompt_id: 'prompt_gen3', user_message_id: 'msg_gen3', status: 'running', content: [], created_at: 'x' });
    const afterOpen = await threw(() => conn.sendPrompt({ text: 'after the replacement stream' }));
    const thirdWrite = writes().at(-1);
    check('the same write succeeds once the replacement stream opens, on the replacement generation',
      afterOpen === undefined
        && writes().length === beforeHeld + 1
        && thirdWrite?.bearer === 'Bearer fixture-token-3',
      `${afterOpen?.message} writes=${writes().length - beforeHeld}`);

    socketsOpenAutomatically = true;
    acceptedToken = 'fixture-token';
    await conn.close();
  }

  // ── 15. The pre-dispatch state belongs to the WRITE, not to the door ──────
  //
  // The submission fence and the self-resolved claim are both statements about a
  // request that is on the wire. Recorded ahead of the door instead, they are
  // live for the whole gate — the provenance check, a reconnect, a stream wait,
  // an identity re-resolution — for a write that may never happen at all.

  {
    const adapter = makeAdapter(liveScan, { writeStreamWaitMs: 250 });
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();

    // The write parks at the stream gate: the socket is gone and its
    // replacement never completes its handshake.
    socketsOpenAutomatically = false;
    sockets.at(-1)!.fire('close', {});
    await settle();
    const parkedWrite = threw(() => conn.sendPrompt({ text: 'parked at the door' }));
    await settle();
    messages = [assistantRow('msg_during_door', 'delivered while the door waits'), ...messages];
    await conn.refresh();
    await settle();
    check('a write still AT the door holds no walk: the fence rises with the POST, not before it',
      rows.some((row) => row.type === 'model-output' && row.text === 'delivered while the door waits'),
      `rows=${rows.filter((row) => row.type === 'model-output').length}`);
    const refusedAtDoor = await parkedWrite;
    check('...and the parked write still refuses, naming the dependency',
      refusedAtDoor?.message === KIMI_NO_STREAM_REFUSAL, refusedAtDoor?.message);

    // ...and the refusal left the counter AT zero rather than below it. A
    // decrement that ran for a callback which never did would make the next
    // submit's fence read as already closed, and this connection would deliver
    // its own uncorrelated echo for every prompt from here on.
    sockets.at(-1)!.fire('open', {});
    await settle();
    const submit = gate();
    holdPrompt = submit.hold;
    messages = [userRow('msg_after_door_refusal', 'fenced after a refusal'), ...messages];
    promptAnswer = ok({
      prompt_id: 'prompt_after_door_refusal', user_message_id: 'msg_after_door_refusal',
      status: 'running', content: [], created_at: 'x',
    });
    const echoes = () => rows.filter((row): row is Extract<AgentMessage, { type: 'user-message' }> =>
      row.type === 'user-message' && row.text === 'fenced after a refusal');
    const sending = conn.sendPrompt({ text: 'fenced after a refusal', clientMessageId: 'client-after-door' });
    await settle();
    await conn.refresh();
    await settle();
    check('a door refusal leaves the fence at zero: the NEXT submit still holds its own walk',
      echoes().length === 0, `${echoes().length} early rows`);
    submit.release();
    await sending;
    await settle();
    check('...and the held walk then delivers that echo exactly once, carrying its clientKey',
      echoes().length === 1 && echoes()[0]?.clientKey === 'client-after-door',
      `${echoes().length} rows, clientKey=${echoes()[0]?.clientKey}`);
    socketsOpenAutomatically = true;
    await conn.close();
  }

  {
    // THE CLAIM, in the window where it is visible: a write parked INSIDE its
    // door — re-resolving an identity the server has refused — with the socket
    // still open, so somebody else's answer to the card arrives while this
    // connection's own answer has not been sent.
    let currentToken = 'fixture-token';
    const adapter = makeAdapter(liveScan, { readToken: () => currentToken, writeStreamWaitMs: 400 });
    await adapter.createSession({ directory: WORKSPACE });
    const conn = await adapter.attach(CREATED_ID, 'live') as KimiDriveConnection;
    const rows: AgentMessage[] = [];
    conn.subscribe((message) => rows.push(message));
    messages = [];
    await conn.getHistory();
    await settle();
    const socket = sockets.at(-1)!;
    socket.deliver(frame('event.approval.requested', approvalRow('ap_claim')));
    await settle();

    // The server stops accepting this generation's credential, so the door has
    // to re-resolve — and that is what the park holds.
    acceptedToken = 'fixture-token-claim';
    currentToken = 'fixture-token-claim';
    await conn.refresh();
    await settle();
    const parkedMeta = gate();
    holdMeta = parkedMeta.hold;
    const beforeClaimWrites = writes().length;
    const responding = threw(() => conn.respondPermission('ap_claim', 'approve'));
    await settle();
    check('the parked door has sent nothing yet',
      writes().length === beforeClaimWrites, `writes=${writes().length - beforeClaimWrites}`);
    socket.deliver(frame('event.approval.resolved', {
      approval_id: 'ap_claim', session_id: CREATED_ID, decision: 'rejected', resolved_at: 'x',
    }));
    await settle();
    const claimed = resolutionsOf(rows, 'ap_claim');
    check('a resolution landing while our write is still AT the door reports as external, not as ours',
      claimed.length === 1 && claimed[0]?.decision === 'external',
      `${claimed.length} rows, decision=${claimed[0]?.decision}`);
    parkedMeta.release();
    await responding;
    await settle();
    acceptedToken = 'fixture-token';
    await conn.close();
  }

  // ── 15b. The door's checks and the POST share ONE synchronous frame ───────
  //
  // A door that VALIDATES a generation and then HANDS THE CLIENT BACK leaves its
  // caller to dispatch after an await resumption, and an await resumption is a
  // separate microtask. A concurrent read's `ensureTransport` continuation can
  // run in that gap: it replaces `this.transport` and retires the socket the
  // stream gate had just passed — while the caller still holds, and then
  // invokes, the RETIRED client. The prompt lands on a server whose approvals
  // come back somewhere nobody is listening and whose second writer nothing is
  // watching for, which is the one class of mistake a write cannot undo.
  //
  // Driven through injected surfaces only: two generations whose write doors
  // carry DIFFERENT bearers, an injected socket factory, an injected tick, and
  // an injected `reverify`. The probe exposes the two protected facts a dispatch
  // has to agree with — which generation is current, and whether the stream is
  // up — and the write door's fetch records them AT DISPATCH, synchronously.

  {
    class ProbeDrive extends KimiDriveConnection {
      /** The CURRENT generation's token: the identity a POST leaving now must carry. */
      get generationToken(): string | undefined { return this.transport.token; }
      /** Is the safety stream up RIGHT NOW? Read at dispatch, never inferred afterwards. */
      get streamLive(): boolean { return this.socketLive; }
    }

    interface RacedDispatch { bearer: string; generation?: string; streamLive: boolean }

    const racedInfo: SessionInfo = {
      id: 'session_raced', tool: 'kimi', title: 'raced', status: 'idle',
      attachMode: 'live', launchSurface: 'unknown',
    };

    const racedGeneration = (
      token: string,
      dispatches: RacedDispatch[],
      probe: () => ProbeDrive,
    ): KimiObserveTransport => {
      const envelope = (data: unknown) => JSON.stringify(ok(data));
      return {
        http: new KimiReadOnlyHttp({
          baseUrl: 'http://127.0.0.1:1',
          token,
          fetchImpl: async (url) => ({
            status: 200,
            text: async () => envelope(new URL(url).pathname.endsWith('/messages')
              ? { items: [], has_more: false }
              : { items: [] }),
          }),
        }),
        wsUrl: `ws://127.0.0.1:1/api/v1/ws?generation=${token}`,
        token,
        driveHttp: new KimiDriveHttp({
          baseUrl: 'http://127.0.0.1:1',
          token,
          // RECORDED AT DISPATCH, in the same synchronous frame the request
          // leaves in: what the door decided and what was true when the bytes
          // went out are the same question only if nothing ran in between.
          fetchImpl: async (_url, init) => {
            const current = probe().generationToken;
            dispatches.push({
              bearer: init.headers.authorization ?? '',
              ...(current !== undefined ? { generation: current } : {}),
              streamLive: probe().streamLive,
            });
            return {
              status: 200,
              text: async () => envelope({
                prompt_id: `prompt_${token}`, user_message_id: `msg_${token}`,
                status: 'running', content: [], created_at: 'x',
              }),
            };
          },
        }),
      };
    };

    /**
     * One write, disturbed `gapTicks` microtasks after it started — or not at
     * all when `gapTicks` is undefined, which is the mechanism control.
     *
     * The disturbance is one synchronous frame: the socket dies and the poll
     * tick's `restoreSocket` re-resolves the instance, exactly as a tick lands
     * on a connection whose socket has just gone away. The replacement itself
     * then happens in a MICROTASK — which is the gap the old door left open, so
     * sweeping the offset walks the window rather than guessing at it.
     */
    async function racedWrite(gapTicks: number | undefined): Promise<{
      dispatches: RacedDispatch[]; outcome: string; replacements: number;
    }> {
      const dispatches: RacedDispatch[] = [];
      let probe!: ProbeDrive;
      const genA = racedGeneration('tok-race-a', dispatches, () => probe);
      const genB = racedGeneration('tok-race-b', dispatches, () => probe);
      const made: FakeSocket[] = [];
      let tick: (() => void) | undefined;
      let replacements = 0;
      probe = new ProbeDrive(racedInfo, genA.http, genA.wsUrl, genA.token, {
        driveHttp: genA.driveHttp,
        socketFactory: () => { const socket = new FakeSocket(); made.push(socket); return socket; },
        setInterval: (handler) => { tick = handler; return 1; },
        clearInterval: () => { tick = undefined; },
        // The SAME object every time, so the connection sees exactly ONE
        // generation change however often it re-resolves: the fact under test is
        // a write crossing one replacement, not a connection that never settles.
        reverify: async () => { replacements += 1; return genB; },
        writeStreamWaitMs: 120,
      });
      probe.subscribe(() => {});
      made[0]!.fire('open', {});
      const sending = probe.sendPrompt({ text: 'raced' })
        .then(() => 'sent', (error: Error) => error.message);
      if (gapTicks !== undefined) {
        for (let step = 0; step < gapTicks; step += 1) await Promise.resolve();
        made.at(-1)!.fire('close', {});
        tick?.();
        await settle();
        // Whatever socket the replacement opened comes up, so a write that was
        // refused-and-retried can land on the generation that owns it. The
        // retired socket's own listeners are neutralized by their identity
        // guard, so firing at all of them is safe.
        for (const socket of made) socket.fire('open', {});
      }
      await settle();
      const outcome = await sending;
      await probe.close();
      return { dispatches, outcome, replacements };
    }

    const raced: Array<{ gap: number; dispatches: RacedDispatch[]; outcome: string; replacements: number }> = [];
    for (let gap = 0; gap <= 9; gap += 1) raced.push({ gap, ...(await racedWrite(gap)) });

    const wrongHands = raced.flatMap((run) => run.dispatches
      .filter((sent) => sent.bearer !== `Bearer ${sent.generation}` || !sent.streamLive)
      .map((sent) => `gap=${run.gap} sent=${sent.bearer === 'Bearer tok-race-a' ? 'A' : 'B'}`
        + ` current=${sent.generation === 'tok-race-a' ? 'A' : 'B'} live=${sent.streamLive}`));
    check('no POST is ever carried by a bearer that was not the CURRENT transport\'s at dispatch',
      wrongHands.length === 0, wrongHands.slice(0, 4).join(' | ') || '(none)');
    check('a replacement landing mid-door ends on the new generation or in the bounded refusal',
      raced.every((run) => run.outcome === 'sent' || run.outcome === KIMI_NO_STREAM_REFUSAL),
      raced.filter((run) => run.outcome !== 'sent' && run.outcome !== KIMI_NO_STREAM_REFUSAL)
        .map((run) => `gap=${run.gap}: ${run.outcome}`).join(' | ') || '(all accounted for)');
    check('every run in the sweep genuinely crossed a generation replacement',
      raced.every((run) => run.replacements > 0),
      raced.map((run) => run.replacements).join(','));
    check('no run ever sent the prompt twice',
      raced.every((run) => run.dispatches.length <= 1),
      raced.map((run) => run.dispatches.length).join(','));

    // MECHANISM CONTROL: with nothing disturbing it, the same write lands
    // exactly once, on the generation it was cleared against.
    const undisturbed = await racedWrite(undefined);
    check('an undisturbed write still lands exactly once, on the current generation',
      undisturbed.outcome === 'sent' && undisturbed.dispatches.length === 1
        && undisturbed.dispatches[0]?.bearer === 'Bearer tok-race-a'
        && undisturbed.dispatches[0]?.streamLive === true,
      `${undisturbed.outcome} dispatches=${undisturbed.dispatches.length}`);
  }

  // ── 15c. A REFUSED generation cannot dispatch, replaced or not ────────────
  //
  // `noteUnauthorized` only SETS the flag. The transport swap, the socket
  // retirement, and the reopen all happen later, whenever some caller runs
  // `ensureTransport` — so between the two there is a live connection holding
  // the server's own refusal of the credential it is about to write with. The
  // identity check cannot see it (the transport object has not moved) and the
  // stream check cannot see it (the socket is still open), which is exactly the
  // window a concurrent read's 401 continuation lands in.
  //
  // Driven through injected surfaces: the read client PARKS its refusal, so the
  // continuation can be released into a chosen microtask of the write's gate
  // rather than whenever the clock allows, and the offset is swept because the
  // window is a handful of microtasks wide and guessing at it proves nothing.

  {
    class RefusalProbe extends KimiDriveConnection {
      /** Has the server refused this generation — whether or not the swap has happened yet? */
      get generationRefused(): boolean { return this.transportInvalid; }
      /** The CURRENT generation's token: the identity a POST leaving now must carry. */
      get generationToken(): string | undefined { return this.transport.token; }
    }

    /** What was true of the connection AT DISPATCH, recorded in the request's own frame. */
    interface RefusedDispatch { bearer: string; refused: boolean; generation?: string }

    const refusedInfo: SessionInfo = {
      id: 'session_refused', tool: 'kimi', title: 'refused', status: 'idle',
      attachMode: 'live', launchSurface: 'unknown',
    };
    const envelope = (data: unknown) => JSON.stringify(ok(data));

    /**
     * One write, with a parked 401 released `offset` microtasks before it starts
     * — or `-offset` microtasks after it, when the offset is negative.
     *
     * The offset is what walks the window, and it walks it at one-microtask
     * resolution: raising it by one moves the refusal's continuation exactly one
     * microtask earlier relative to the write's gate. Deep negative, the flag
     * lands after the POST is already out (nothing to catch, and nothing wrong);
     * high positive, it is standing before the write begins and the door's first
     * `writeClient` repairs it. THE HOLE IS THE BOUNDARY BETWEEN THEM — the flag
     * landing after `writeClient` has read it and before the frame runs — so a
     * sweep containing both endings necessarily contains it, which is what the
     * coverage check below asserts rather than assumes.
     *
     * `reverifiable` picks which honest ending is expected: a connection that
     * CAN obtain a second generation must complete the write on it inside the
     * two attempts, and one that cannot must refuse and write nothing at all.
     */
    async function refusedMidDoor(offset: number, reverifiable: boolean): Promise<{
      dispatches: RefusedDispatch[]; outcome: string;
    }> {
      const dispatches: RefusedDispatch[] = [];
      let probe!: RefusalProbe;
      let refusing = false;
      let release: (() => void) | undefined;
      const generation = (token: string, refusable: boolean): KimiObserveTransport => ({
        http: new KimiReadOnlyHttp({
          baseUrl: 'http://127.0.0.1:1',
          token,
          fetchImpl: async (url) => {
            if (refusable && refusing) {
              // PARKED, not merely slow: the test decides which microtask the
              // refusal's continuation runs in.
              await new Promise<void>((resolve) => { release = resolve; });
              return { status: 401, text: async () => '' };
            }
            return {
              status: 200,
              text: async () => envelope(new URL(url).pathname.endsWith('/messages')
                ? { items: [], has_more: false }
                : { items: [] }),
            };
          },
        }),
        wsUrl: `ws://127.0.0.1:1/api/v1/ws?generation=${token}`,
        token,
        driveHttp: new KimiDriveHttp({
          baseUrl: 'http://127.0.0.1:1',
          token,
          fetchImpl: async (_url, init) => {
            dispatches.push({
              bearer: init.headers.authorization ?? '',
              refused: probe.generationRefused,
              ...(probe.generationToken !== undefined ? { generation: probe.generationToken } : {}),
            });
            return {
              status: 200,
              text: async () => envelope({
                prompt_id: `prompt_${token}`, user_message_id: `msg_${token}`,
                status: 'running', content: [], created_at: 'x',
              }),
            };
          },
        }),
      });
      const genA = generation('tok-refused-a', true);
      const genB = generation('tok-refused-b', false);
      const made: FakeSocket[] = [];
      probe = new RefusalProbe(refusedInfo, genA.http, genA.wsUrl, genA.token, {
        driveHttp: genA.driveHttp,
        socketFactory: () => { const socket = new FakeSocket(); made.push(socket); return socket; },
        setInterval: () => 1,
        clearInterval: () => {},
        reverify: async () => (reverifiable ? genB : undefined),
        writeStreamWaitMs: 200,
      });
      probe.subscribe(() => {});
      made[0]!.fire('open', {});
      // The concurrent read is IN FLIGHT and parked before the write begins, so
      // its refusal is a continuation waiting to be scheduled — which is the
      // shape the hazard actually takes.
      refusing = true;
      void probe.refresh();
      await settle();
      const start = () => probe.sendPrompt({ text: 'refused mid-door' })
        .then(() => 'sent', (error: Error) => error.message);
      let sending: Promise<string>;
      if (offset >= 0) {
        release?.();
        for (let step = 0; step < offset; step += 1) await Promise.resolve();
        sending = start();
      } else {
        sending = start();
        for (let step = 0; step < -offset; step += 1) await Promise.resolve();
        release?.();
      }
      await settle();
      // Whatever socket the replacement opened comes up, so a write that was
      // refused-and-retried can land on the generation that owns it. The retired
      // sockets' listeners are neutralized by their identity guard.
      for (const socket of made) socket.fire('open', {});
      await settle();
      const outcome = await sending;
      await probe.close();
      return { dispatches, outcome };
    }

    const refused: Array<{ head: number; dispatches: RefusedDispatch[]; outcome: string }> = [];
    for (let head = -6; head <= 15; head += 1) refused.push({ head, ...(await refusedMidDoor(head, true)) });
    const landedOn = (run: { dispatches: RefusedDispatch[] }) =>
      (run.dispatches[0]?.bearer === 'Bearer tok-refused-b' ? 'B' : 'A');

    const onRefused = refused.flatMap((run) => run.dispatches
      .filter((sent) => sent.refused || sent.bearer !== `Bearer ${sent.generation}`)
      .map((sent) => `head=${run.head} bearer=${sent.bearer}`
        + ` current=${sent.generation} refused=${sent.refused}`));
    check('no content POST is ever dispatched through a generation the server has refused',
      onRefused.length === 0, onRefused.slice(0, 4).join(' | ') || '(none)');
    check('a refusal landing anywhere in the door still completes the write, once, within two attempts',
      refused.every((run) => run.outcome === 'sent' && run.dispatches.length === 1),
      refused.filter((run) => run.outcome !== 'sent' || run.dispatches.length !== 1)
        .map((run) => `head=${run.head}: ${run.outcome} dispatches=${run.dispatches.length}`)
        .join(' | ') || '(all sent exactly once)');
    // COVERAGE, not decoration. The sweep steps one microtask at a time, so a
    // run that still made it out on the OLD generation and a run that was pushed
    // onto the REPLACEMENT bracket the moment the flag lands mid-door — the hole
    // itself — and the check above is only worth anything if both are present.
    check('the sweep brackets the hole: some run landed on the old generation, some on the replacement',
      refused.some((run) => landedOn(run) === 'A') && refused.some((run) => landedOn(run) === 'B'),
      refused.map(landedOn).join(''));

    // ...and with NO second generation to reach for, the honest ending is a
    // refusal with nothing written — never a POST through the door the server
    // has already closed.
    const unrecoverable: Array<{ head: number; dispatches: RefusedDispatch[]; outcome: string }> = [];
    for (let head = -6; head <= 15; head += 1) unrecoverable.push({ head, ...(await refusedMidDoor(head, false)) });

    check('an unrecoverable refusal never reaches the wire: it refuses, and posts nothing',
      unrecoverable.every((run) => (run.outcome === 'sent'
        ? run.dispatches.length === 1 && run.dispatches[0]?.refused === false
        : /could not be re-verified/.test(run.outcome) && run.dispatches.length === 0)),
      unrecoverable.map((run) => `head=${run.head}:${run.outcome === 'sent' ? 'sent' : 'refused'}`
        + `/${run.dispatches.length}`).join(' '));
    check('...and the sweep genuinely reached that refusal on at least one schedule',
      unrecoverable.some((run) => run.dispatches.length === 0
        && /could not be re-verified/.test(run.outcome)),
      unrecoverable.map((run) => run.dispatches.length).join(','));
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
