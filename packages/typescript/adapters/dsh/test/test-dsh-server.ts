/**
 * The transport boundary: the route allowlist, the unary envelope, the readiness
 * gate, and the two-socket generation model.
 *
 * The first block is the round-1 method allowlist asserted STRUCTURALLY rather
 * than by "we did not call it": the reachable `/api` surface is proven to be
 * exactly the eight unary methods plus `respond` and the two streams, every
 * deferred method is proven unreachable, and the source is proven to build paths
 * in exactly one place. The rest asserts the envelope fails closed — a wrong
 * rpcId, a foreign envelope, or a non-200 never becomes a business value.
 *
 * Runs entirely on injected fetch, sockets, and timers against SANITIZED
 * CAPTURES from a real dsh 0.1.0-rc.6 host (fixtures/dsh-0.1.0-rc.6.json). No
 * dsh process, no model, no network, no listening port.
 *
 *   bun run packages/typescript/adapters/dsh/test/test-dsh-server.ts   (exit 0 = all pass)
 */
export {};
import type { AgentMessage } from '@cosyncing/adapter-api';
import { DshAdapter, type DshAdapterOptions } from '../src/index.ts';
import { DshHostLink } from '../src/implementation.ts';
import { DshSessionConnection } from '../src/observe.ts';
import {
  DshDownlinks,
  DshRpcClient,
  DSH_API_ROUTES,
  DSH_DEFAULT_BASE_URL,
  DSH_DEFERRED_RPC_METHODS,
  DSH_FRAME_MAX_BYTES,
  DSH_HOST_ROUTE,
  DSH_MUX_ROUTE,
  DSH_REMOTE_METHODS,
  DSH_RESPOND_ROUTE,
  DSH_RPC_METHODS,
  dshApiPath,
  isDshVersionDrift,
  resolveDshBaseUrl,
  verifyDshHostDescribe,
  type DshDownlinkDiagnostic,
  type DshDownlinkFrame,
  type DshFetch,
  type DshSocketLike,
} from '../src/server.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/dsh-0.1.0-rc.6.json', import.meta.url)).json() as {
  sourceRef: string;
  hostDescribe: { status: number; body: { result: { ok: true; value: Record<string, unknown> } } };
  sessionList: { body: { result: { value: unknown } } };
  workspaceList: { body: { result: { value: unknown } } };
  errorSessionNotFound: { status: number; body: unknown };
  respondBadResponse: { status: number; body: unknown };
  muxOpenFrames: Array<Record<string, unknown>>;
};

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Round-1 method allowlist (structural) ────────────────────────────────

{
  // Written out rather than derived from the constant, so widening the
  // allowlist is a deliberate edit HERE and not a side effect of an edit there.
  const expectedMethods = [
    'host.describe', 'workspace.list', 'session.list', 'session.history',
    'session.create', 'session.prompt', 'session.cancel', 'session.rename',
    // The model surface, verified against the installed 0.1.0-rc.6 host:
    // session-scoped catalog + selection, and the host-wide catalog the
    // create dialog reads before any session exists.
    'session.models', 'session.selectModel', 'llm.models',
  ];
  check(
    'the unary method allowlist is exactly the verified set',
    JSON.stringify([...DSH_RPC_METHODS].sort()) === JSON.stringify([...expectedMethods].sort()),
    DSH_RPC_METHODS.join(','),
  );

  // The Typert Remote family is a SEPARATE constant because it is a separate
  // wire dialect (`payload:{args:{…}}`, named fields). Only the two commands
  // endpoints are reachable; `goals/*`, `messageFeedback/*` and the rest of
  // that family stay unbuildable.
  check(
    'the Typert Remote allowlist is exactly the two commands endpoints',
    JSON.stringify([...DSH_REMOTE_METHODS].sort()) === JSON.stringify(['commands/execute', 'commands/list']),
    DSH_REMOTE_METHODS.join(','),
  );

  check(
    'an unverified Typert Remote endpoint cannot be produced',
    ['goals/create', 'messageFeedback/put', 'pluginInventory/list', 'commands/', 'commands'].every((route) => {
      try {
        dshApiPath(route);
        return false;
      } catch {
        return true;
      }
    }),
  );

  const expectedRoutes = [
    ...expectedMethods,
    'commands/list',
    'commands/execute',
    DSH_RESPOND_ROUTE,
    DSH_MUX_ROUTE,
    DSH_HOST_ROUTE,
  ];
  check(
    'no /api route outside the allowlist can be produced',
    JSON.stringify([...DSH_API_ROUTES].sort()) === JSON.stringify([...expectedRoutes].sort()),
    DSH_API_ROUTES.join(','),
  );

  const refused = DSH_DEFERRED_RPC_METHODS.filter((method) => {
    try {
      dshApiPath(method);
      return false;
    } catch {
      return true;
    }
  });
  check(
    'every deferred method is refused by the path builder',
    refused.length === DSH_DEFERRED_RPC_METHODS.length,
    `${refused.length}/${DSH_DEFERRED_RPC_METHODS.length}`,
  );

  const adversarial = ['', '../admin', 'session.prompt/../session.fork', 'HOST.DESCRIBE', 'respond/../settings.write'];
  check(
    'traversal and case-variant routes are refused',
    adversarial.every((route) => {
      try {
        dshApiPath(route);
        return false;
      } catch {
        return true;
      }
    }),
  );

  check('an allowlisted route produces its exact path', dshApiPath('session.prompt') === '/api/session.prompt');

  // The two dialects must not be crossable. A Remote endpoint reached through
  // `call` would post a bare payload the host rejects as `internal` one round
  // trip later, and an RPC method reached through `callRemote` would arrive
  // double-wrapped in `args`. Both are routing mistakes, so both are refused
  // here rather than by the host.
  {
    let posted = 0;
    const fetchImpl: DshFetch = async () => {
      posted += 1;
      return { status: 200, text: async () => '{}' };
    };
    const rpc = new DshRpcClient({ baseUrl: 'http://h', fetchImpl });
    const asRpc = await rpc.call('commands/list' as never, {});
    const asRemote = await rpc.callRemote('session.prompt' as never, {});
    check(
      'neither wire dialect can be used to reach the other’s methods',
      asRpc.ok === false
        && asRpc.failure.kind === 'transport'
        && asRpc.failure.reason === 'route-not-allowed'
        && asRemote.ok === false
        && asRemote.failure.kind === 'transport'
        && asRemote.failure.reason === 'route-not-allowed'
        && posted === 0,
      `${JSON.stringify(asRpc)} / ${JSON.stringify(asRemote)} / ${posted} posts`,
    );
  }

  {
    // The gateway matches FIELD NAMES against its descriptor, so the wrapper is
    // load-bearing: the installed host answers a bare payload with "Remote
    // payload must contain exactly one plain-object args field".
    let body: Record<string, unknown> = {};
    const fetchImpl: DshFetch = async (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        status: 200,
        text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: [] } }),
      };
    };
    const rpc = new DshRpcClient({ baseUrl: 'http://h', fetchImpl });
    await rpc.callRemote('commands/list', { agentId: 'session-1' });
    check(
      'a Typert Remote call wraps its named arguments in the args field the gateway requires',
      body.type === 'client-request'
        && body.method === 'commands/list'
        && JSON.stringify(body.payload) === JSON.stringify({ args: { agentId: 'session-1' } }),
      JSON.stringify(body),
    );
  }

  // One builder, proven over the source text: outside server.ts no adapter
  // source may embed an /api/ path literal (a quote or backtick immediately
  // before it), so a later edit cannot smuggle a route past the allowlist.
  const sources = ['index.ts', 'implementation.ts', 'mapping.ts', 'observe.ts', 'drive.ts', 'diagnostics.ts'];
  let stray = '';
  for (const name of sources) {
    const text = await Bun.file(new URL(`../src/${name}`, import.meta.url)).text();
    if (/['"`]\/api\//.test(text)) stray = name;
  }
  check('only server.ts embeds an /api path literal', stray === '', stray);

  const serverSource = await Bun.file(new URL('../src/server.ts', import.meta.url)).text();
  const verbs = serverSource.match(/method:\s*'([A-Z]+)'/g) ?? [];
  check(
    'the unary client names only the POST method',
    verbs.length > 0 && verbs.every((verb) => verb.includes("'POST'")),
    verbs.join(' '),
  );

  // The downlink socket type has no send: the client writes nothing on either
  // stream, and answers travel over the respond route instead.
  check(
    'the downlink socket surface exposes no send path',
    !/interface DshSocketLike \{[^}]*send/s.test(serverSource),
  );
}

// ── 2. Base URL resolution ──────────────────────────────────────────────────

{
  check(
    'base URL prefers the explicit option, then the environment, then the default',
    resolveDshBaseUrl({ COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:9999' }, 'http://127.0.0.1:1234/')
      === 'http://127.0.0.1:1234'
    && resolveDshBaseUrl({ COSYNCING_DSH_BASE_URL: 'http://127.0.0.1:9999/' }) === 'http://127.0.0.1:9999'
    && resolveDshBaseUrl({}) === DSH_DEFAULT_BASE_URL,
  );

  check(
    'userinfo is redacted, so a configured credential never reaches a request URL, a log, or an evidence line',
    resolveDshBaseUrl({}, 'http://user:secret@127.0.0.1:3080/') === 'http://127.0.0.1:3080',
  );

  const refused = [
    'ftp://127.0.0.1:3080',
    'http://127.0.0.1:3080/?token=abc123',
    'http://127.0.0.1:3080/#fragment',
    'not a url',
  ];
  let leaked = false;
  const allRefused = refused.every((value) => {
    try {
      resolveDshBaseUrl({}, value);
      return false;
    } catch (error) {
      // The refusal itself must be safe to quote: no configured secret in it.
      if (/(abc123|secret)/.test(error instanceof Error ? error.message : String(error))) leaked = true;
      return true;
    }
  });
  check(
    'non-http schemes, query strings, fragments, and unparseable values are refused, and refusals carry no secret',
    allRefused && !leaked,
  );
}

// ── 3. Unary envelope ───────────────────────────────────────────────────────

interface Recorded { url: string; method: string; headers: Record<string, string>; body: unknown }

function recorder(reply: (body: Record<string, unknown>) => { status?: number; text: string }): {
  fetchImpl: DshFetch;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push({ url, method: init.method, headers: init.headers, body });
    const answer = reply(body);
    return { status: answer.status ?? 200, text: async () => answer.text };
  };
  return { fetchImpl, seen };
}

{
  let counter = 0;
  const { fetchImpl, seen } = recorder((body) => ({
    text: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }),
  }));
  const client = new DshRpcClient({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl,
    newRpcId: () => `fix-${(counter += 1)}`,
  });
  const outcome = await client.call<{ items: unknown[] }>('session.list', {});
  const request = seen[0]!;
  check(
    'a unary call posts the client-request envelope as JSON',
    outcome.ok
      && request.method === 'POST'
      && request.url === 'http://127.0.0.1:3080/api/session.list'
      && request.headers['content-type'] === 'application/json'
      && (request.body as { type?: string }).type === 'client-request'
      && (request.body as { method?: string }).method === 'session.list'
      && (request.body as { rpcId?: string }).rpcId === 'fix-1',
    JSON.stringify(request.body),
  );

  let handed = '';
  await client.call('session.prompt', {}, { onRpcId: (id) => { handed = id; } });
  check('the caller is handed the rpcId dsh will stamp on the echo', handed === 'fix-2', handed);
}

{
  // The host puts business failures in the envelope with HTTP 200; the typed
  // code must survive as a code, not be flattened into a transport fault.
  const { fetchImpl } = recorder(() => ({ text: JSON.stringify(FIXTURE.errorSessionNotFound.body) }));
  const client = new DshRpcClient({ baseUrl: 'http://h', fetchImpl, newRpcId: () => 'fix-6' });
  const outcome = await client.call('session.history', { sessionId: 'nope' });
  check(
    'a typed business error survives as its native code',
    !outcome.ok && outcome.failure.kind === 'rpc' && outcome.failure.code === 'session-not-found',
    outcome.ok ? 'ok' : JSON.stringify(outcome.failure),
  );
}

{
  const cases: Array<{ name: string; text: string; status?: number; reason: string }> = [
    { name: 'a foreign envelope type', text: JSON.stringify({ type: 'hello' }), reason: 'invalid-envelope' },
    { name: 'a body that is not JSON', text: 'not json', reason: 'invalid-envelope' },
    {
      name: 'a mismatched rpcId',
      text: JSON.stringify({ type: 'server-response', rpcId: 'someone-else', result: { ok: true, value: 1 } }),
      reason: 'rpc-id-mismatch',
    },
    {
      name: 'a result with no ok discriminant',
      text: JSON.stringify({ type: 'server-response', rpcId: 'fix-1', result: {} }),
      reason: 'invalid-envelope',
    },
  ];
  let allDrift = true;
  for (const testCase of cases) {
    const { fetchImpl } = recorder(() => ({ text: testCase.text, ...(testCase.status ? { status: testCase.status } : {}) }));
    const client = new DshRpcClient({ baseUrl: 'http://h', fetchImpl, newRpcId: () => 'fix-1' });
    const outcome = await client.call('host.describe', {});
    const failed = !outcome.ok
      && outcome.failure.kind === 'transport'
      && outcome.failure.reason === testCase.reason
      && isDshVersionDrift(outcome.failure);
    if (!failed) allDrift = false;
    check(`${testCase.name} fails closed as version drift`, failed);
  }
  check('every envelope mismatch is reported as drift', allDrift);
}

{
  const { fetchImpl } = recorder(() => ({ status: 415, text: 'content type must be application/json' }));
  const client = new DshRpcClient({ baseUrl: 'http://h', fetchImpl });
  const outcome = await client.call('host.describe', {});
  check(
    'a carrier-layer status is a transport failure carrying the status',
    !outcome.ok && outcome.failure.kind === 'transport' && outcome.failure.reason === 'http-status'
      && outcome.failure.status === 415,
  );
}

{
  // Timeout and generation loss share the abort path but must not share a
  // reason: one is a wedged host, the other is a stale epoch to re-issue into.
  const pending: Array<() => void> = [];
  const fetchImpl: DshFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    pending.push(() => reject(new Error('aborted')));
  });
  let fire: (() => void) | undefined;
  const client = new DshRpcClient({
    baseUrl: 'http://h',
    fetchImpl,
    setTimeout: (handler) => { fire = handler; return 1; },
    clearTimeout: () => {},
  });
  const inFlight = client.call('session.list', {});
  fire?.();
  const timedOut = await inFlight;
  check(
    'an unanswered call times out as a retryable transport failure',
    !timedOut.ok && timedOut.failure.kind === 'transport' && timedOut.failure.reason === 'timeout'
      && timedOut.failure.retryable,
  );

  const second = client.call('session.list', {});
  client.abortInFlight();
  const lost = await second;
  check(
    'a lost downlink generation fails in-flight calls as retryable generation-lost',
    !lost.ok && lost.failure.kind === 'transport' && lost.failure.reason === 'generation-lost'
      && lost.failure.retryable,
  );
}

{
  const { fetchImpl, seen } = recorder(() => ({ text: JSON.stringify(FIXTURE.respondBadResponse.body) }));
  const client = new DshRpcClient({ baseUrl: 'http://h', fetchImpl });
  const outcome = await client.respond('echoed-rpc-id', { sessionId: 's', approvalId: 'a', outcome: 'rejected' });
  check(
    'the answer route posts a client-response echoing the frame rpcId',
    seen[0]!.url === 'http://h/api/respond'
      && (seen[0]!.body as { type?: string }).type === 'client-response'
      && (seen[0]!.body as { rpcId?: string }).rpcId === 'echoed-rpc-id',
    JSON.stringify(seen[0]!.body),
  );
  check(
    'a refused receipt is a value, not a failure',
    outcome.ok && outcome.value.accepted === false,
    JSON.stringify(outcome),
  );
}

{
  // Upstream defines exactly not-pending | bad-response. A missing or future
  // reason must fail closed as drift: only not-pending may ever be read as
  // "settled elsewhere".
  const unknownReason = await new DshRpcClient({
    baseUrl: 'http://h',
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ accepted: false, reason: 'settled-upstream' }) }),
  }).respond('rpc-1', {});
  const missingReason = await new DshRpcClient({
    baseUrl: 'http://h',
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ accepted: false }) }),
  }).respond('rpc-1', {});
  check(
    'a receipt with an unknown or missing reason is contract drift, never settled-elsewhere',
    !unknownReason.ok && unknownReason.failure.kind === 'transport'
      && unknownReason.failure.reason === 'invalid-envelope' && isDshVersionDrift(unknownReason.failure)
      && !missingReason.ok && missingReason.failure.kind === 'transport'
      && missingReason.failure.reason === 'invalid-envelope',
    JSON.stringify([unknownReason, missingReason]),
  );
}

// ── 3b. The byte ceiling bounds the READ, not the decoded string ────────────

{
  // The size limit exists to bound allocation, so it must act DURING the read:
  // a hostile body is abandoned once the ceiling is crossed, never read to
  // completion and then measured. The precise guarantee: retention is bounded
  // by maxBytes PLUS ONE TRANSPORT CHUNK — here 128 + 64 = 192 bytes, i.e.
  // exactly 3 chunks, and the fourth is never pulled.
  let produced = 0;
  const endless: DshFetch = async () => ({
    status: 200,
    text: async () => '',
    body: (async function* () {
      while (true) {
        produced += 1;
        yield new Uint8Array(64).fill(120);
      }
    })(),
  });
  const capped = new DshRpcClient({ baseUrl: 'http://h', fetchImpl: endless, maxBytes: 128 });
  const overflow = await capped.call('host.describe', {});
  check(
    'an oversized streamed body fails closed without being read to the end',
    !overflow.ok
      && overflow.failure.kind === 'transport'
      && overflow.failure.detail === 'response too large'
      && produced === 3,
    `${produced} chunks produced`,
  );

  const envelope = JSON.stringify({
    type: 'server-response',
    rpcId: 'fix-1',
    result: { ok: true, value: { version: '0.0.1', cwd: '/x', attachedSessions: 0, canOpenPath: true } },
  });
  const bytes = new TextEncoder().encode(envelope);
  const chunks = [bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40)];
  const chunked: DshFetch = async () => ({
    status: 200,
    text: async () => {
      throw new Error('text() must not be called when the stream is used');
    },
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  });
  const streaming = new DshRpcClient({ baseUrl: 'http://h', fetchImpl: chunked, newRpcId: () => 'fix-1' });
  const read = await streaming.call('host.describe', {});
  check(
    'a chunked body within the ceiling decodes exactly',
    read.ok && (read.value as { cwd?: string }).cwd === '/x',
    JSON.stringify(read),
  );

  // The text() fallback (injected fetches without a stream) measures BYTES, not
  // characters: multibyte text counts what it costs on the wire.
  const wide = 'é'.repeat(100); // 200 bytes, 100 characters
  const textOnly = new DshRpcClient({
    baseUrl: 'http://h',
    fetchImpl: async () => ({ status: 200, text: async () => wide }),
    maxBytes: 150,
  });
  const counted = await textOnly.call('host.describe', {});
  check(
    'the text() fallback enforces the ceiling in bytes, not characters',
    !counted.ok && counted.failure.kind === 'transport' && counted.failure.detail === 'response too large',
  );
}



// ── 4. Readiness gate ───────────────────────────────────────────────────────

{
  const verified = verifyDshHostDescribe(FIXTURE.hostDescribe.body.result.value);
  check(
    'the captured host.describe validates',
    verified.ok && verified.value.version === '0.0.1' && verified.value.attachedSessions === 2,
  );
  const broken = [
    {},
    { version: '', cwd: '/x', attachedSessions: 0, canOpenPath: true },
    { version: '0.0.1', attachedSessions: 0, canOpenPath: true },
    { version: '0.0.1', cwd: '/x', attachedSessions: 'two', canOpenPath: true },
    { version: '0.0.1', cwd: '/x', attachedSessions: 0 },
    'not an object',
  ];
  check(
    'a host.describe missing or mistyping a required field fails closed',
    broken.every((value) => !verifyDshHostDescribe(value).ok),
  );
}

// ── 5. Downlink generations ─────────────────────────────────────────────────

class FakeSocket implements DshSocketLike {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

{
  const sockets: FakeSocket[] = [];
  const frames: DshDownlinkFrame[] = [];
  const diagnostics: DshDownlinkDiagnostic[] = [];
  const opens: number[] = [];
  const losses: Array<{ generation: number; reason: string }> = [];
  const timers: Array<() => void> = [];
  const downlinks = new DshDownlinks(
    {
      baseUrl: 'http://127.0.0.1:3080',
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeout: (handler) => { timers.push(handler); return timers.length; },
      clearTimeout: () => {},
      reconnectDelayMs: 5,
    },
    {
      onFrame: (frame) => frames.push(frame),
      onOpen: (generation) => opens.push(generation),
      onLost: (generation, reason) => losses.push({ generation, reason }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  downlinks.start();
  check(
    'both downlinks are opened on the upgrade origin',
    sockets.length === 2
      && sockets[0]!.url === 'ws://127.0.0.1:3080/api/events.mux'
      && sockets[1]!.url === 'ws://127.0.0.1:3080/api/events.host',
    sockets.map((socket) => socket.url).join(' '),
  );

  sockets[0]!.emit('open');
  const halfOpen = opens.length;
  sockets[1]!.emit('open');
  check('readiness waits for BOTH sockets', halfOpen === 0 && opens.length === 1, `${halfOpen} then ${opens.length}`);

  sockets[0]!.emit('message', { data: JSON.stringify(FIXTURE.muxOpenFrames[0]) });
  check(
    'a captured open frame decodes to its type, rpcId, and payload',
    frames.length === 1
      && frames[0]!.frameType === 'session/subscribed'
      && frames[0]!.stream === 'mux'
      && frames[0]!.rpcId === (FIXTURE.muxOpenFrames[0] as { rpcId: string }).rpcId,
    JSON.stringify(frames[0] ?? null),
  );

  sockets[0]!.emit('message', { data: 'not json' });
  sockets[0]!.emit('message', { data: JSON.stringify({ type: 'server-response', rpcId: 'x' }) });
  sockets[0]!.emit('message', { data: JSON.stringify({ type: 'server-request', rpcId: 'x', payload: {} }) });
  check(
    'undecodable frames are contained diagnostics, not failures',
    diagnostics.length === 3 && frames.length === 1 && losses.length === 0,
    `${diagnostics.length} diagnostics`,
  );

  // A frame this build has never seen must still reach the router: the union
  // grows, and the routing layer is what decides to skip it.
  sockets[0]!.emit('message', { data: JSON.stringify({ type: 'server-request', rpcId: 'y', method: 'session/future', payload: { type: 'session/future', sessionId: 's' } }) });
  check('an unknown frame type is delivered rather than dropped in transport', frames.length === 2
    && frames[1]!.frameType === 'session/future');
  check('a delivered frame carries its raw byte size for retention budgeting', frames[1]!.bytes > 0);

  // The byte ceiling acts BEFORE parsing: an oversized message is dropped as a
  // contained diagnostic and never becomes a retained object.
  const oversized = JSON.stringify({
    type: 'server-request',
    rpcId: 'big',
    payload: { type: 'session/projection', sessionId: 's', key: 'k', value: 'x'.repeat(DSH_FRAME_MAX_BYTES) },
  });
  sockets[0]!.emit('message', { data: oversized });
  check(
    'a frame over the byte ceiling is dropped before parsing, and the stream survives',
    frames.length === 2
      && diagnostics.some((diagnostic) => diagnostic.code === 'frame-too-large')
      && losses.length === 0,
    JSON.stringify(diagnostics),
  );

  const generationBefore = downlinks.generation;
  sockets[1]!.emit('close');
  check(
    'losing ONE socket ends the generation and closes both',
    losses.length === 1
      && losses[0]!.generation === generationBefore
      && downlinks.generation === generationBefore + 1
      && sockets[0]!.closed && sockets[1]!.closed
      && !downlinks.socketsOpen,
    JSON.stringify(losses),
  );

  const stale = frames.length;
  sockets[0]!.emit('message', { data: JSON.stringify(FIXTURE.muxOpenFrames[1]) });
  check('a frame from a superseded generation is dropped', frames.length === stale);

  timers.forEach((fire) => fire());
  check('a fresh generation reopens both sockets', sockets.length === 4, `${sockets.length} sockets`);

  downlinks.stop();
  check('stop closes the current generation', sockets[2]!.closed && sockets[3]!.closed);
}

// ── 6. Adapter orchestration ────────────────────────────────────────────────

{
  const sockets: FakeSocket[] = [];
  const answers: Record<string, unknown> = {
    'host.describe': FIXTURE.hostDescribe.body.result.value,
    'session.list': FIXTURE.sessionList.body.result.value,
    'workspace.list': FIXTURE.workspaceList.body.result.value,
    'session.history': { events: [], hasMore: false },
  };
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as { rpcId: string };
    const route = new URL(url).pathname.replace('/api/', '');
    return {
      status: 200,
      text: async () => JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: answers[route] === undefined
          ? { ok: false, error: { code: 'internal', message: 'unscripted', details: {} } }
          : { ok: true, value: answers[route] },
      }),
    };
  };
  const adapter = new DshAdapter({
    env: {},
    fetchImpl,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });

  check(
    'the capability posture is live-only drive with model switching and image input',
    adapter.capabilities.integrationKind === 'http-websocket'
      && JSON.stringify(adapter.capabilities.attachModes) === JSON.stringify(['live'])
      && adapter.capabilities.supportsLiveAttach && !adapter.capabilities.supportsObserve
      && !adapter.capabilities.supportsResume
      && !adapter.capabilities.supportsNativeArtifact
      // The host takes inline image bytes on the prompt; this flag is what
      // makes the client offer the attach control that reaches them.
      && adapter.capabilities.supportsNativeFileInput
      && adapter.capabilities.supportsModelSwitch
      && adapter.capabilities.permissionGranularity === 'per-tool',
    JSON.stringify(adapter.capabilities),
  );

  check('availability is a verified host.describe', await adapter.isAvailable());

  const sessions = await adapter.discoverSessions();
  check(
    'discovery titles a session from its projections and locates it by workspace',
    sessions.length === 1
      && sessions[0]!.title === 'cosyncing spike (safe to delete)'
      && sessions[0]!.cwd === '/home/user'
      && sessions[0]!.attachMode === 'live',
    JSON.stringify(sessions[0]),
  );

  const bounded = await adapter.discoverSessions({ updatedAfter: Date.now() });
  check('an idle session older than the discovery bound is filtered out', bounded.length === 0);

  let resumeRefused = false;
  await adapter.attach(sessions[0]!.id, 'resume').catch(() => { resumeRefused = true; });
  check('resume is refused: dsh sessions are attached by the host, not continued by a client', resumeRefused);

  let observeRefused = false;
  await adapter.attach(sessions[0]!.id, 'observe').catch(() => { observeRefused = true; });
  check(
    'observe is refused: dsh has no read-only credential, so an observe attach would hold full Drive authority',
    observeRefused,
  );

  const connection = await adapter.attach(sessions[0]!.id, 'live');
  const link = adapter.hostLink();
  check('attaching opens the two downlinks once', sockets.length === 2, `${sockets.length} sockets`);

  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  await connection.getHistory();

  sockets[0]!.emit('open');
  sockets[1]!.emit('open');
  // The readiness probe is a real round trip; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    'readiness needs BOTH sockets and a verified host.describe',
    link.isReady && link.hostDescribe?.attachedSessions === 2,
    JSON.stringify(link.hostDescribe),
  );

  sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'push-1',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: sessions[0]!.id, key: 'title', value: 'routed', seq: 99 },
    }),
  });
  check(
    'mux frames are routed to the session they name',
    seen.some((message) => message.type === 'metadata-update'
      && JSON.stringify((message as { value: unknown }).value) === JSON.stringify({ title: 'routed' })),
    JSON.stringify(seen.map((message) => message.type)),
  );

  sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'push-2',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: 'some-other-session', key: 'title', value: 'not ours', seq: 100 },
    }),
  });
  check(
    'a frame for a session nobody attached is dropped, not broadcast',
    !seen.some((message) => JSON.stringify(message).includes('not ours')),
  );

  // The broker's replaceConnection installs a session's NEW connection first and
  // closes the superseded one afterwards, fire-and-forget. The stale close must
  // not evict the replacement's routing entry or stop the shared downlinks.
  const replacement = await adapter.attach(sessions[0]!.id, 'live');
  const replacementSeen: AgentMessage[] = [];
  replacement.subscribe((message) => replacementSeen.push(message));
  await replacement.getHistory();
  await connection.close();
  sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'push-2b',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: sessions[0]!.id, key: 'title', value: 'replacement routed', seq: 101 },
    }),
  });
  check(
    'closing a superseded connection neither evicts its replacement nor stops the downlinks',
    replacementSeen.some((message) => message.type === 'metadata-update'
      && JSON.stringify((message as { value: unknown }).value) === JSON.stringify({ title: 'replacement routed' }))
      && !sockets[0]!.closed && !sockets[1]!.closed,
    JSON.stringify(replacementSeen.map((message) => message.type)),
  );

  const generation = link.generation;
  sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'push-3',
      method: 'stream/error',
      payload: { type: 'stream/error', error: { code: 'internal', message: 'boom', details: {} } },
    }),
  });
  check(
    'a stream/error ends the generation and unreadies the link',
    link.generation === generation + 1 && !link.isReady,
    `${generation} → ${link.generation}`,
  );

  await replacement.close();
  check(
    'the last detach closes the downlinks rather than holding sockets with no reader',
    sockets.slice(-2).every((socket) => socket.closed),
  );

  // The adapter reuses ONE link, and therefore one downlink manager, for its
  // whole lifetime, so the stop above must not be a permanent latch: a session
  // attaching afterwards has to get live frames, not history over unary RPC and
  // a readiness that never turns true. Sockets open synchronously on register,
  // which is what makes this observable with a setTimeout that never fires.
  const beforeReattach = sockets.length;
  const reattached = await adapter.attach(sessions[0]!.id, 'live');
  const reattachedSeen: AgentMessage[] = [];
  reattached.subscribe((message) => reattachedSeen.push(message));
  await reattached.getHistory();
  const fresh = sockets.slice(beforeReattach);
  fresh[0]?.emit('open');
  fresh[1]?.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readyAgain = link.isReady;
  fresh[0]?.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'push-4',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: sessions[0]!.id, key: 'title', value: 'reattached', seq: 102 },
    }),
  });
  check(
    'a fresh attach after the last detach reopens the downlinks and routes again',
    fresh.length === 2
      && readyAgain
      && reattachedSeen.some((message) => message.type === 'metadata-update'
        && JSON.stringify((message as { value: unknown }).value) === JSON.stringify({ title: 'reattached' })),
    `${fresh.length} new sockets, ready=${readyAgain}, ${JSON.stringify(reattachedSeen.map((message) => message.type))}`,
  );

  // Socket callbacks are asynchronous, so a socket of a STOPPED generation can
  // still emit after the next attach. stop() ends its epoch, which is what makes
  // that late close inert: without the bump it would arrive under the generation
  // it was opened with still current, and fail the generation that replaced it.
  await reattached.close();
  const beforeRejoin = sockets.length;
  const rejoined = await adapter.attach(sessions[0]!.id, 'live');
  const rejoinedSockets = sockets.slice(beforeRejoin);
  rejoinedSockets[0]?.emit('open');
  rejoinedSockets[1]?.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const liveGeneration = link.generation;
  fresh[0]?.emit('close');
  check(
    'a late close from a stopped generation cannot fail the generation that replaced it',
    rejoinedSockets.length === 2
      && link.generation === liveGeneration
      && !rejoinedSockets[0]?.closed && !rejoinedSockets[1]?.closed,
    `${liveGeneration} → ${link.generation}`,
  );
  await rejoined.close();
}

// ── 7. Verification gates routing AND mutation ──────────────────────────────

{
  // The verifier is DELAYED: frames arriving before host.describe validates
  // must be buffered, not routed; mutations must refuse while the link is
  // unready; and once the probe lands, the buffered frames flow.
  const sockets: FakeSocket[] = [];
  let releaseDescribe: () => void = () => {};
  const answers: Record<string, unknown> = {
    'session.list': FIXTURE.sessionList.body.result.value,
    'workspace.list': FIXTURE.workspaceList.body.result.value,
    'session.history': { events: [], hasMore: false },
    'session.prompt': { accepted: true },
  };
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as { rpcId: string };
    const route = new URL(url).pathname.replace('/api/', '');
    if (route === 'host.describe') {
      await new Promise<void>((resolve) => { releaseDescribe = resolve; });
    }
    const value = route === 'host.describe' ? FIXTURE.hostDescribe.body.result.value : answers[route];
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    };
  };
  const adapter = new DshAdapter({
    env: {},
    fetchImpl,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    // A caller trying to disable the verification guard through the connection
    // seam: the Omit'd type refuses this at compile time, and the
    // mandatory-fields-after-spread order refuses it at runtime.
    connection: { mutationReady: () => true } as unknown as DshAdapterOptions['connection'],
  });
  const connection = await adapter.attach('session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc', 'live');
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  sockets[0]!.emit('open');
  sockets[1]!.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0)); // the probe is in flight, held

  const projection = (seq: number, title: string) => JSON.stringify({
    type: 'server-request',
    rpcId: `gate-${seq}`,
    method: 'session/projection',
    payload: { type: 'session/projection', sessionId: 'session-7723d8e8-cf1c-4e0a-8748-3a600aa396fc', key: 'title', value: title, seq },
  });
  sockets[0]!.emit('message', { data: projection(1, 'pre-verification') });
  check(
    'frames from a not-yet-verified generation are buffered, never routed',
    seen.length === 0 && !adapter.hostLink().isReady,
    JSON.stringify(seen),
  );

  let unreadyRefused = false;
  await connection.sendPrompt({ text: 'too early' }).catch(() => { unreadyRefused = true; });
  check(
    'a mutation is refused while the host link is unverified, even when the caller tries to override the guard',
    unreadyRefused,
  );

  releaseDescribe();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    'verification success readies the link and replays the buffered frames in order',
    adapter.hostLink().isReady
      && seen.some((message) => message.type === 'metadata-update'
        && JSON.stringify((message as { value: unknown }).value) === JSON.stringify({ title: 'pre-verification' })),
    JSON.stringify(seen.map((message) => message.type)),
  );

  let drove = true;
  await connection.sendPrompt({ text: 'now allowed' }).catch(() => { drove = false; });
  check('a mutation flows once the link is verified', drove);
  await connection.close();
}

{
  // The verifier FAILS: the generation ends, the buffered frames are discarded
  // with it, and the session never sees state from a host that did not prove
  // the contract.
  const sockets: FakeSocket[] = [];
  const fetchImpl: DshFetch = async (url, init) => {
    const body = JSON.parse(init.body) as { rpcId: string };
    const route = new URL(url).pathname.replace('/api/', '');
    const value = route === 'host.describe'
      ? { version: '', cwd: '', attachedSessions: 'no', canOpenPath: 'no' } // fails shape validation
      : { events: [], hasMore: false };
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    };
  };
  const adapter = new DshAdapter({
    env: {},
    fetchImpl,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  const connection = await adapter.attach('session-failed-verify', 'live');
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  const generation = adapter.hostLink().generation;
  sockets[0]!.emit('open');
  sockets[1]!.emit('open');
  sockets[0]!.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'doomed-1',
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId: 'session-failed-verify', key: 'title', value: 'must never land', seq: 1 },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the failed probe settle
  check(
    'a failed host.describe fails the generation and discards its buffered frames',
    !adapter.hostLink().isReady
      && adapter.hostLink().generation === generation + 1
      && seen.length === 0
      && sockets.every((socket) => socket.closed),
    `generation ${generation} → ${adapter.hostLink().generation}, seen ${seen.length}`,
  );
  await connection.close();
}

// ── 8. The pre-verification buffer budgets bytes ────────────────────────────

{
  // The verifier is WEDGED (describe never answers), and the endpoint floods
  // frames. The buffer caps retained BYTES, not just frames: parsed frame
  // objects are already allocations, so a frame-count cap alone would let an
  // unverified endpoint pin 1,000 arbitrarily large payloads.
  const sockets: FakeSocket[] = [];
  const rpc = new DshRpcClient({
    baseUrl: 'http://h',
    fetchImpl: () => new Promise(() => {}), // never answers
  });
  const link = new DshHostLink(rpc, {
    baseUrl: 'http://h',
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    verifyMaxBufferedBytes: 512,
  });
  const connection = new DshSessionConnection(
    { id: 's-budget', tool: 'dsh', title: 't', status: 'idle', attachMode: 'live' },
    { rpc },
  );
  const seen: AgentMessage[] = [];
  connection.subscribe((message) => seen.push(message));
  link.register(connection);
  sockets[0]!.emit('open');
  sockets[1]!.emit('open');

  const flood = (n: number) => JSON.stringify({
    type: 'server-request',
    rpcId: `flood-${n}`,
    payload: { type: 'session/projection', sessionId: 's-budget', key: 'title', value: 'x'.repeat(300), seq: n },
  });
  const generation = link.generation;
  sockets[0]!.emit('message', { data: flood(1) }); // ~440 bytes: within budget, buffered
  check('frames within the byte budget buffer while the verifier is wedged', link.generation === generation);
  sockets[0]!.emit('message', { data: flood(2) }); // pushes past 512: the generation fails
  check(
    'crossing the pre-verification byte budget fails the generation instead of retaining unbounded state',
    link.generation === generation + 1
      && !link.isReady
      && seen.length === 0
      && sockets.every((socket) => socket.closed),
    `generation ${generation} → ${link.generation}`,
  );
  await connection.close();
}

// ── 9. Adapter-level writes verify the host at write time ───────────────────

{
  // createSession and renameSession are writes outside any attached session,
  // so the link's readiness gate does not cover them. A canCreateSession
  // preflight minutes earlier says nothing about the process on the port NOW:
  // EACH write verifies the host itself, immediately before issuing.
  const LLM_GROUPS = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek-V4-Flash',
          reasoning: {
            efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
      ],
    },
    { id: 'minimax-cn', name: 'MiniMax CN', models: [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }] },
  ];

  const make = (describes: unknown[], failRoutes: string[] = []): { adapter: DshAdapter; sent: string[] } => {
    const sent: string[] = [];
    let describeCalls = 0;
    const fetchImpl: DshFetch = async (url, init) => {
      const body = JSON.parse(init.body) as { rpcId: string; payload?: Record<string, unknown> };
      const route = new URL(url).pathname.replace('/api/', '');
      sent.push(route);
      const failed = failRoutes.includes(route);
      const value = route === 'host.describe'
        ? describes[Math.min(describeCalls++, describes.length - 1)]
        : route === 'workspace.list'
          ? { items: [{ workspaceId: 'w1', path: '/w', title: 'W', sessionIds: [] }] }
        : route === 'session.create' ? { sessionId: 's-new' }
        : route === 'session.rename' ? { title: 'T' }
        : route === 'llm.models' ? { groups: LLM_GROUPS, failures: [] }
        : route === 'session.selectModel'
          ? {
            selected: {
              provider: body.payload?.provider,
              model: body.payload?.model,
              ...(typeof body.payload?.reasoningEffort === 'string'
                ? { reasoningEffort: body.payload.reasoningEffort }
                : {}),
            },
          }
        : {};
      return {
        status: 200,
        text: async () => JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: failed ? { ok: false, error: { code: 'internal', message: 'boom' } } : { ok: true, value },
        }),
      };
    };
    return { adapter: new DshAdapter({ env: {}, fetchImpl }), sent };
  };

  const invalid = { version: '', cwd: '', attachedSessions: 'no', canOpenPath: 'no' };
  const valid = FIXTURE.hostDescribe.body.result.value;

  const bad = make([invalid]);
  let createRefused = false;
  await bad.adapter.createSession().catch(() => { createRefused = true; });
  let renameRefused = false;
  await bad.adapter.renameSession('s-old', 'T').catch(() => { renameRefused = true; });
  check(
    'create and rename are refused when the host fails verification at write time',
    createRefused && renameRefused
      && !bad.sent.includes('session.create') && !bad.sent.includes('session.rename'),
    bad.sent.join(','),
  );

  const good = make([valid, valid]);
  await good.adapter.renameSession('s-old', 'T');
  await good.adapter.createSession({ title: 'T' });
  check(
    'each write is preceded by its own fresh verification, in order',
    good.sent.join(',')
      === ['host.describe', 'session.rename', 'workspace.list', 'host.describe', 'session.create', 'host.describe', 'session.rename'].join(','),
    good.sent.join(','),
  );

  // The create lands but the SECOND verification fails. The session EXISTS
  // upstream, so this must NOT surface as a create failure — a scheduled-send
  // retry records the session id only after createSession returns, and would
  // create a duplicate. The created session comes back with the fallback title.
  const flaky = make([valid, invalid]);
  const created = await flaky.adapter.createSession({ title: 'T' });
  check(
    'a failed verification before the optional rename degrades the title, never reports the create as failed',
    created.id === 's-new'
      && created.title === 'W'
      && flaky.sent.join(',') === ['workspace.list', 'host.describe', 'session.create', 'host.describe'].join(','),
    `${JSON.stringify(created)} via ${flaky.sent.join(',')}`,
  );

  // Same rule when the rename RPC itself fails: partial success is success.
  const renameBroken = make([valid, valid], ['session.rename']);
  const untitled = await renameBroken.adapter.createSession({ title: 'T' });
  check(
    'a failed rename RPC degrades to the default title rather than failing the create',
    untitled.id === 's-new'
      && untitled.title === 'W'
      && renameBroken.sent.join(',')
        === ['workspace.list', 'host.describe', 'session.create', 'host.describe', 'session.rename'].join(','),
    `${JSON.stringify(untitled)} via ${renameBroken.sent.join(',')}`,
  );

  // ── The pre-session model surface ─────────────────────────────────────────
  //
  // Presence of `listModels` is the broker's gate for the create dialog's model
  // picker (`canSelectModelAtCreation` and the models route), and it reads the
  // host-wide `llm.models` catalog — no session exists yet to ask.
  const catalog = make([valid]);
  const options = await catalog.adapter.listModels!();
  check(
    'the pre-session catalog flattens llm.models groups, qualifying each label with its provider',
    catalog.sent.join(',') === 'llm.models'
      && options.length === 2
      && options[0]!.providerID === 'deepseek-official'
      && options[0]!.modelID === 'deepseek-v4-flash'
      && options[0]!.label === 'DeepSeek-V4-Flash (DeepSeek)'
      && options[0]!.defaultReasoningEffort === 'high'
      && JSON.stringify(options[0]!.reasoningEfforts) === JSON.stringify([
        { effort: 'off', label: 'Off' },
        { effort: 'high', label: 'High' },
      ])
      && options[1]!.providerID === 'minimax-cn'
      && options[1]!.reasoningEfforts === undefined,
    JSON.stringify(options),
  );

  const catalogBroken = make([valid], ['llm.models']);
  let catalogError: unknown;
  try {
    await catalogBroken.adapter.listModels!();
  } catch (error) {
    catalogError = error;
  }
  check(
    'a failed catalog read THROWS, so the broker answers 503 MODEL_CATALOG_UNAVAILABLE instead of a silently empty picker',
    catalogError != null,
  );

  // A requested model is applied after the create through session.selectModel
  // (the host has no per-create model field), verified fresh like every write.
  const modeled = make([valid, valid]);
  const withModel = await modeled.adapter.createSession({
    model: { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' },
  });
  check(
    'createSession applies a requested model via session.selectModel and advertises it on the returned info',
    modeled.sent.join(',')
      === ['workspace.list', 'host.describe', 'session.create', 'host.describe', 'session.selectModel'].join(',')
      && withModel.model === 'deepseek-v4-flash'
      && JSON.stringify(withModel.currentModel)
        === JSON.stringify({ providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    `${JSON.stringify(withModel)} via ${modeled.sent.join(',')}`,
  );

  // The selection failing after the create is the rename's partial-success
  // rule: the session exists, so the create succeeds with the tool default and
  // no advertised model rather than failing into a duplicating retry.
  const selectionBroken = make([valid, valid], ['session.selectModel']);
  const defaulted = await selectionBroken.adapter.createSession({
    model: { providerID: 'minimax-cn', modelID: 'MiniMax-M3' },
  });
  check(
    'a failed model selection after create degrades to the tool default rather than failing the create',
    defaulted.id === 's-new'
      && defaulted.currentModel === undefined
      && defaulted.model === undefined
      && selectionBroken.sent.includes('session.selectModel'),
    `${JSON.stringify(defaulted)} via ${selectionBroken.sent.join(',')}`,
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
