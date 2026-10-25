/**
 * A fake `kimi web` host: the local server Kimi Code runs, in the test process on a loopback port.
 *
 * The broker never starts it (`COSYNCING_KIMI_MANAGED_HOST=0` in the fixture environment): like a user's own
 * `kimi web`, it is found through the registry the host itself writes, so everything the product does to reach
 * it is exercised:
 *
 *   - `<KIMI_CODE_HOME>/server.token` and `<KIMI_CODE_HOME>/server/instances/<server_id>.json`, written the way
 *     the real host writes them. The record's `server_id` is a SIBLING of the id `/api/v1/meta` answers with,
 *     never a copy (the K3 trap: a fixture that derived one from the other proved the comparator, not the
 *     premise), and meta's `started_at` follows the record's by a few hundred milliseconds;
 *   - the REST surface (`/api/v1`, `/api/v2/sessions`) in the real `{code, msg, data, request_id}` envelope, and
 *     the `/api/v1/ws` cursor stream, with `{type, seq, epoch, session_id, timestamp, payload}` frames;
 *   - the wire journal on disk (`sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`, `state.json`) the
 *     adapter reads for models, subagents and telemetry.
 *
 * Every request and every client WebSocket frame lands in the ledger (`KimiLedger` in `../kimi.ts` reads it in
 * the conformance vocabulary), so a scenario proves what the product did to the host, not only what it showed.
 *
 * A turn is scripted by the prompt text: `[[hold:TAG]]` parks it until `release(TAG)`, `[[permission]]` raises an
 * approval card, `[[question]]` a question card, `[[fail]]` ends it failed. Otherwise the answer is `answer: <text>`.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;

export interface FakeKimiHostOptions {
  /** `KIMI_CODE_HOME`: the token, the instance registry and the session tree live under it. */
  home: string;
  ledgerPath: string;
  version: string;
  token?: string;
  models?: Array<{ provider: string; model: string; display_name?: string; support_efforts?: string[]; default_effort?: string }>;
}

export interface KimiMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: Json[];
  created_at: string;
  metadata?: Json;
  prompt_id?: string;
}

interface Prompt {
  id: string;
  text: string;
  hold?: string;
  permission: boolean;
  question: boolean;
  fail: boolean;
  model?: string;
}

interface Approval { id: string; tool_name: string; action: string; tool_input_display: string; resolve?: (decision: string) => void }
interface Question { id: string; questions: Json[]; resolve?: (outcome: string) => void }

export interface KimiSession {
  id: string;
  cwd: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  pending: 'none' | 'approval' | 'question';
  lastTurnReason: string;
  messages: KimiMessageRow[];
  model: string;
  thinking: string;
  permission: string;
  goal: Json | null;
  seq: number;
  archived: boolean;
  approvals: Approval[];
  questions: Question[];
  queue: Prompt[];
  running?: { prompt: Prompt; abort: AbortController; turnId: number };
}

interface SocketData { id: number; subscribed: Set<string> }

export interface RouteFault { status?: number; body?: unknown; times?: number; closeConnection?: boolean }

/** A route a fault or a hold applies to: `METHOD /path` (a RegExp tested against it). */
export type RouteMatch = RegExp;

const SKILLS = [{ name: 'fixture-skill', description: 'A skill the host offers' }];

const ulid = (): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  let time = Date.now();
  for (let index = 0; index < 10; index += 1) {
    out = alphabet[time % 32] + out;
    time = Math.floor(time / 32);
  }
  for (let index = 0; index < 16; index += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
};

export class FakeKimiHost {
  readonly home: string;
  readonly version: string;
  readonly sessions = new Map<string, KimiSession>();
  readonly uploads: Array<{ id: string; name: string; mediaType: string; bytes: Uint8Array }> = [];
  #options: FakeKimiHostOptions;
  #server: ReturnType<typeof Bun.serve> | undefined;
  #port = 0;
  #token: string;
  #registryId = '';
  #apiId = '';
  #startedAt = 0;
  #apiStartedAt = 0;
  #epoch = '';
  #metaOverride: ((meta: Json) => Json | string | undefined) | undefined;
  #apiVersion: string;
  #bypassAuth = false;
  #sockets = new Map<number, Bun.ServerWebSocket<SocketData>>();
  #socketSeq = 0;
  #held = new Map<string, Array<() => void>>();
  #released = new Set<string>();
  #routeHolds: Array<{ match: RouteMatch; gate: Promise<void> }> = [];
  #faults: Array<{ match: RouteMatch; fault: RouteFault }> = [];
  #turnCounter = 0;
  #promptCounter = 0;
  #messageCounter = 0;
  #approvalCounter = 0;
  #questionCounter = 0;
  #fileCounter = 0;
  #modelCatalog: NonNullable<FakeKimiHostOptions['models']>;
  #registryPath = '';

  constructor(options: FakeKimiHostOptions) {
    this.#options = options;
    this.home = options.home;
    this.version = options.version;
    this.#apiVersion = options.version;
    this.#token = options.token ?? `kimi-${crypto.randomUUID().replaceAll('-', '')}`;
    this.#modelCatalog = options.models ?? [
      { provider: 'test-provider', model: 'model-a', display_name: 'Model A', support_efforts: ['low', 'high'], default_effort: 'high' },
      { provider: 'test-provider', model: 'model-b', display_name: 'Model B' },
    ];
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get token(): string {
    return this.#token;
  }

  get registryId(): string {
    return this.#registryId;
  }

  get epoch(): string {
    return this.#epoch;
  }

  get registryPath(): string {
    return this.#registryPath;
  }

  get instancesDirectory(): string {
    return join(this.home, 'server', 'instances');
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  get modelAliases(): string[] {
    return this.#modelCatalog.map((entry) => entry.model);
  }

  record(entry: Json): void {
    appendFileSync(this.#options.ledgerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  }

  // ------------------------------------------------------------------- lifecycle

  /** Listen, write the token and the instance record. A fresh generation each call. */
  start(port = 0): void {
    this.#server = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        open: (socket) => {
          this.#sockets.set(socket.data.id, socket);
          this.record({ kind: 'ws-open', socket: socket.data.id });
          socket.send(JSON.stringify({
            type: 'server_hello',
            timestamp: new Date().toISOString(),
            payload: { ws_connection_id: `conn_${ulid()}`, protocol_version: 2, heartbeat_ms: 10_000, max_event_buffer_size: 1000, capabilities: { event_batching: false, compression: false } },
          }));
        },
        message: (socket, raw) => this.#onSocketMessage(socket, typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')),
        close: (socket) => {
          this.#sockets.delete(socket.data.id);
          this.record({ kind: 'ws-close', socket: socket.data.id });
        },
      },
    });
    this.#port = this.#server.port ?? 0;
    this.#newGeneration();
  }

  /** Stop listening, dropping every socket. The registry record is left behind, as a dead host leaves it. */
  stop(): void {
    this.#server?.stop(true);
    this.#server = undefined;
    this.#sockets.clear();
  }

  /** Replace this host with a new generation of itself: new registry id, new epoch, sockets dropped, same port. */
  restartGeneration(): void {
    for (const socket of this.#sockets.values()) socket.close(1012, 'restart');
    this.#sockets.clear();
    this.#unregister();
    this.#newGeneration();
  }

  #newGeneration(): void {
    this.#registryId = `01${ulid().slice(2)}`;
    this.#apiId = `01${ulid().slice(2)}`;
    // Now, never in the future: the registry's start comes first, the API layer's a few hundred ms after it.
    this.#startedAt = Date.now() - 400;
    this.#apiStartedAt = this.#startedAt + 200;
    this.#epoch = `ep_${ulid()}`;
    for (const session of this.sessions.values()) session.seq = 0;
    mkdirSync(this.instancesDirectory, { recursive: true });
    writeFileSync(join(this.home, 'server.token'), `${this.#token}\n`, { mode: 0o600 });
    this.register();
  }

  /** The registry record the real host writes (and nothing else about it). */
  registryRecord(): Json {
    return {
      server_id: this.#registryId,
      pid: process.pid,
      host: '127.0.0.1',
      port: this.#port,
      started_at: this.#startedAt,
      heartbeat_at: Date.now(),
      host_version: this.version,
    };
  }

  register(record: Json = this.registryRecord()): string {
    this.#registryPath = join(this.instancesDirectory, `${record.server_id ?? this.#registryId}.json`);
    mkdirSync(this.instancesDirectory, { recursive: true });
    writeFileSync(this.#registryPath, JSON.stringify(record));
    return this.#registryPath;
  }

  /** Another file in the instance registry, as given (another host, a malformed record). Returns its path. */
  plantRecord(name: string, content: Json | string): string {
    mkdirSync(this.instancesDirectory, { recursive: true });
    const path = join(this.instancesDirectory, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  }

  /** The server's heartbeat: a client must answer with a pong carrying the nonce. */
  ping(nonce: string): void {
    const frame = JSON.stringify({ type: 'ping', timestamp: new Date().toISOString(), payload: { nonce } });
    for (const socket of this.#sockets.values()) socket.send(frame);
  }

  /** Append a record to a session's wire journal (`agents/<agent>/wire.jsonl`), as the host itself does. */
  appendWire(sessionId: string, agent: string, record: Json): void {
    const directory = join(this.sessionDirectory(sessionId), 'agents', agent);
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'wire.jsonl'), `${JSON.stringify(record)}\n`);
  }

  #unregister(): void {
    if (this.#registryPath) rmSync(this.#registryPath, { force: true });
    this.#registryPath = '';
  }

  /** Remove every registry record (no host is registered at all). */
  unregister(): void {
    this.#unregister();
    if (existsSync(this.instancesDirectory)) {
      for (const name of readdirSync(this.instancesDirectory)) rmSync(join(this.instancesDirectory, name), { force: true });
    }
  }

  /** Rotate the bearer token: the host accepts only the new one, the token file holds it. */
  rotateToken(token = `kimi-${crypto.randomUUID().replaceAll('-', '')}`): string {
    this.#token = token;
    writeFileSync(join(this.home, 'server.token'), `${token}\n`, { mode: 0o600 });
    return token;
  }

  /** What `/api/v1/meta` answers, replaced: a function over the honest meta, or undefined for the honest answer. */
  overrideMeta(override: ((meta: Json) => Json | string | undefined) | undefined): void {
    this.#metaOverride = override;
  }

  setApiVersion(version: string): void {
    this.#apiVersion = version;
  }

  /** `dangerous_bypass_auth: true`: the host answers anyone. */
  setBypassAuth(bypass: boolean): void {
    this.#bypassAuth = bypass;
  }

  /** Meta's `started_at`, as milliseconds after the registry record's (the binding window is 60 s). */
  setApiStartOffset(ms: number): void {
    this.#apiStartedAt = this.#startedAt + ms;
  }

  /** The registry record's own `started_at`. */
  get startedAt(): number {
    return this.#startedAt;
  }

  // -------------------------------------------------------------------- scripting

  /** Let a `[[hold:TAG]]` turn finish (now, or when it gets there). */
  release(tag: string): void {
    this.#released.add(tag);
    for (const wake of this.#held.get(tag) ?? []) wake();
    this.#held.delete(tag);
  }

  releaseAll(): void {
    for (const tag of [...this.#held.keys()]) this.release(tag);
    this.#routeHolds.length = 0;
    for (const release of this.#routeGateReleases.splice(0)) release();
  }

  #routeGateReleases: Array<() => void> = [];
  #plantedRoster: Json[] = [];

  /** A raw roster row exactly as given (a hostile or malformed one), listed on the first page. */
  plantRosterRow(row: Json): void {
    this.#plantedRoster.push(row);
  }

  /** Park every matching request (once its first arrival) until the returned function is called. */
  holdRoute(match: RouteMatch): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#routeHolds.push({ match, gate });
    this.#routeGateReleases.push(release);
    return release;
  }

  /** Answer a matching request with a fault instead (`times` times; default once). */
  failRoute(match: RouteMatch, fault: RouteFault): void {
    this.#faults.push({ match, fault: { times: 1, ...fault } });
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** Push a frame to every socket subscribed to the session. */
  emit(sessionId: string, type: string, payload: Json = {}, agentId = 'main'): void {
    const session = this.sessions.get(sessionId);
    const seq = session ? (session.seq += 1) : 0;
    const frame = JSON.stringify({
      type, seq, epoch: this.#epoch, session_id: sessionId, timestamp: new Date().toISOString(),
      payload: { type, agentId, sessionId, ...payload },
    });
    for (const socket of this.#sockets.values()) if (socket.data.subscribed.has(sessionId)) socket.send(frame);
  }

  /** A `resync_required` frame for a session, with the server's current watermark. */
  emitResync(sessionId: string, epoch = this.#epoch): void {
    const session = this.sessions.get(sessionId);
    const frame = JSON.stringify({
      type: 'resync_required', timestamp: new Date().toISOString(),
      payload: { session_id: sessionId, current_seq: session?.seq ?? 0, epoch },
    });
    for (const socket of this.#sockets.values()) if (socket.data.subscribed.has(sessionId)) socket.send(frame);
  }

  /** A raw text frame to every socket (an oversized or malformed frame, a global-family event). */
  emitRaw(text: string): void {
    for (const socket of this.#sockets.values()) socket.send(text);
  }

  /** Close every WebSocket, leaving the host itself up. */
  dropSockets(): void {
    for (const socket of this.#sockets.values()) socket.close(1011, 'dropped');
    this.#sockets.clear();
  }

  // --------------------------------------------------------------------- sessions

  /** The workspace directory name sessions of this fake live under in the wire tree. */
  readonly workspaceDirectory = 'wd_fixture_0000000000';

  sessionDirectory(id: string): string {
    return join(this.home, 'sessions', this.workspaceDirectory, id);
  }

  seed(options: { id?: string; cwd: string; title?: string; turns?: number; updatedAt?: number; model?: string }): KimiSession {
    const id = options.id ?? `session_${crypto.randomUUID()}`;
    const now = options.updatedAt ?? Date.now();
    const session: KimiSession = {
      id, cwd: options.cwd, title: options.title ?? id, workspace: this.workspaceDirectory,
      createdAt: now - 60_000, updatedAt: now, busy: false, pending: 'none', lastTurnReason: 'completed',
      messages: [], model: options.model ?? this.#modelCatalog[0]!.model, thinking: 'high', permission: 'manual',
      goal: null, seq: 0, archived: false, approvals: [], questions: [], queue: [],
    };
    this.sessions.set(id, session);
    for (let turn = 1; turn <= (options.turns ?? 1); turn += 1) {
      this.appendRow(session, 'user', `seeded prompt ${turn}`);
      this.appendRow(session, 'assistant', `seeded answer ${turn}`);
    }
    this.writeMainJournal(session);
    return session;
  }

  /** The parent's `agents/main/wire.jsonl` head: the launch model the roster reads. */
  writeMainJournal(session: KimiSession): void {
    const directory = join(this.sessionDirectory(session.id), 'agents', 'main');
    mkdirSync(directory, { recursive: true });
    const created = session.createdAt;
    writeFileSync(join(directory, 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.5', created_at: created },
      { type: 'config.update', cwd: session.cwd, modelAlias: session.model, thinkingEffort: 'high', time: created },
    ].map((record) => `${JSON.stringify(record)}\n`).join(''));
  }

  appendRow(session: KimiSession, role: 'user' | 'assistant', text: string, extra: Partial<KimiMessageRow> = {}): KimiMessageRow {
    this.#messageCounter += 1;
    const row: KimiMessageRow = {
      id: `msg_${session.id.slice(8, 16)}_${String(this.#messageCounter).padStart(6, '0')}`,
      session_id: session.id,
      role,
      content: [{ type: 'text', text }],
      created_at: new Date().toISOString(),
      ...(role === 'user' ? { metadata: { origin: { kind: 'user' } } } : {}),
      ...extra,
    };
    session.messages.push(row);
    session.updatedAt = Math.max(session.updatedAt + 1, Date.now());
    return row;
  }

  // ------------------------------------------------------------------------ fetch

  #envelope(data: unknown, code = 0, msg = 'success'): Response {
    return Response.json({ code, msg, data, request_id: `req_${ulid()}` });
  }

  #unauthorized(): Response {
    return Response.json({ code: 40101, msg: 'unauthorized', data: null, request_id: 'r' }, { status: 401 });
  }

  async #fetch(request: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const bearer = request.headers.get('authorization') ?? '';
    const authorized = this.#bypassAuth || bearer === `Bearer ${this.#token}`;
    if (path === '/api/v1/ws') {
      this.record({ kind: 'ws-upgrade', authorized });
      if (!authorized) return this.#unauthorized();
      if (server.upgrade(request, { data: { id: ++this.#socketSeq, subscribed: new Set<string>() } })) return undefined;
      return new Response('expected a websocket', { status: 400 });
    }
    let body: unknown;
    let form: FormData | undefined;
    if (request.method === 'POST') {
      const type = request.headers.get('content-type') ?? '';
      try {
        if (type.includes('application/json')) body = await request.json();
        else if (type.includes('multipart/form-data')) form = await request.formData();
      } catch {
        body = undefined;
      }
    }
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    this.record({
      kind: 'request', method: request.method, path, query,
      ...(body !== undefined ? { body } : {}),
      ...(form ? { upload: [...form.keys()] } : {}),
      authorized,
      bearer: bearer ? bearer.slice(-6) : '',
    });
    const route = `${request.method} ${path}`;
    for (const hold of this.#routeHolds.filter((candidate) => candidate.match.test(route))) {
      this.#routeHolds.splice(this.#routeHolds.indexOf(hold), 1);
      await hold.gate;
    }
    const fault = this.#faults.find((candidate) => candidate.match.test(route));
    if (fault) {
      fault.fault.times = (fault.fault.times ?? 1) - 1;
      if (fault.fault.times <= 0) this.#faults.splice(this.#faults.indexOf(fault), 1);
      if (fault.fault.closeConnection) return new Response(null, { status: 502 });
      return Response.json(fault.fault.body ?? { code: 50000, msg: 'fault', data: null, request_id: 'r' }, { status: fault.fault.status ?? 200 });
    }
    if (path === '/api/v1/healthz') return this.#envelope({ ok: true });
    if (!authorized) return this.#unauthorized();
    return this.#route(request.method, path, url, body, form);
  }

  #meta(): Response {
    const meta: Json = {
      server_version: this.#apiVersion,
      capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: true, tasks: true, terminal: true },
      server_id: this.#apiId,
      started_at: new Date(this.#apiStartedAt).toISOString(),
      open_in_apps: [],
      dangerous_bypass_auth: this.#bypassAuth,
      backend: 'v2',
      experimental_flags: {},
    };
    const replaced = this.#metaOverride?.(meta);
    if (typeof replaced === 'string') return new Response(replaced, { headers: { 'content-type': 'application/json' } });
    return this.#envelope(replaced ?? meta);
  }

  #route(method: string, path: string, url: URL, body: any, form: FormData | undefined): Response | Promise<Response> {
    if (path === '/api/v1/meta') return this.#meta();
    if (path === '/api/v1/models') return this.#envelope({ items: this.#modelCatalog });
    if (path === '/api/v2/sessions') return this.#roster(url);
    if (method === 'POST' && path === '/api/v1/sessions') return this.#create(body);
    if (method === 'POST' && path === '/api/v1/files') return this.#upload(form);
    const matched = path.match(/^\/api\/v1\/sessions\/([^/:]+)(?::(\w+))?(?:\/(.*))?$/);
    if (!matched) return this.#envelope(null, 40401, 'not found');
    const session = this.sessions.get(matched[1]!);
    const action = matched[2];
    const tail = matched[3];
    if (!session) return this.#envelope(null, 40401, 'session not found');
    if (method === 'POST') return this.#post(session, action, tail, body);
    if (method !== 'GET') return new Response('method not allowed', { status: 405 });
    return this.#get(session, tail, url);
  }

  #roster(url: URL): Response {
    const size = Number(url.searchParams.get('page_size') ?? '50');
    const after = Number(url.searchParams.get('meta.updated_after') ?? '0');
    const offset = Number(url.searchParams.get('page_token') ?? '0');
    const all = [...this.sessions.values()]
      .filter((session) => !session.archived && session.updatedAt >= after)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const items: Json[] = all.slice(offset, offset + size).map((session) => ({
      id: session.id,
      workspace: { id: session.workspace, cwd: session.cwd },
      meta: {
        title: session.title,
        last_prompt: session.messages.findLast((row) => row.role === 'user')?.content[0]?.text,
        created_at: session.createdAt, updated_at: session.updatedAt, archived: false,
      },
      activity: { status: session.busy ? 'running' : session.pending === 'none' ? 'idle' : session.pending },
    }));
    if (offset === 0) items.push(...this.#plantedRoster);
    const more = offset + size < all.length;
    return this.#envelope({ items, has_more: more, next_page_token: more ? String(offset + size) : null });
  }

  #create(body: any): Response {
    const cwd = body?.metadata?.cwd;
    if (typeof cwd !== 'string' || !cwd) return this.#envelope(null, 40001, 'metadata.cwd is required');
    const session = this.seed({ id: this.takePreparedId(), cwd, title: typeof body?.title === 'string' && body.title ? body.title : 'New session', turns: 0 });
    return this.#envelope(this.#v1Row(session));
  }

  /** The id the next create answers with (the session is made when the create arrives). */
  prepareCreate(id = `session_${crypto.randomUUID()}`): string {
    this.#createId = id;
    return id;
  }

  #createId: string | undefined;

  #v1Row(session: KimiSession): Json {
    return {
      id: session.id, workspace_id: session.workspace, title: session.title,
      created_at: new Date(session.createdAt).toISOString(), updated_at: new Date(session.updatedAt).toISOString(),
      busy: session.busy, main_turn_active: session.busy, pending_interaction: session.pending,
      last_turn_reason: session.lastTurnReason, archived: session.archived,
      last_prompt: session.messages.findLast((row) => row.role === 'user')?.content[0]?.text,
      metadata: { cwd: session.cwd }, agent_config: { model: '' }, usage: {}, permission_rules: [],
      message_count: session.messages.length, last_seq: session.seq,
    };
  }

  #upload(form: FormData | undefined): Response | Promise<Response> {
    const part = form?.get('file');
    if (!(part instanceof File)) return this.#envelope(null, 40001, 'missing `file` field');
    return part.arrayBuffer().then((buffer) => {
      const id = `file_${(this.#fileCounter += 1)}`;
      this.uploads.push({ id, name: part.name, mediaType: part.type, bytes: new Uint8Array(buffer) });
      return this.#envelope({ id, name: part.name, media_type: part.type || 'application/octet-stream', size: buffer.byteLength, created_at: new Date().toISOString() });
    });
  }

  #get(session: KimiSession, tail: string | undefined, url: URL): Response {
    switch (tail) {
      case undefined:
        return this.#envelope(this.#v1Row(session));
      case 'messages': {
        const size = Number(url.searchParams.get('page_size') ?? '100');
        const newest = [...session.messages].reverse();
        const before = url.searchParams.get('before_id');
        const start = before ? newest.findIndex((row) => row.id === before) + 1 : 0;
        const items = newest.slice(start, start + size);
        return this.#envelope({ items, has_more: start + items.length < newest.length });
      }
      case 'status':
        return this.#envelope({
          busy: session.busy, model: session.model, thinking_level: session.thinking, permission: session.permission,
          plan_mode: false, swarm_mode: false, context_tokens: 403, max_context_tokens: 262_144, context_usage: 0.0015,
        });
      case 'goal':
        return this.#envelope(session.goal);
      case 'skills':
        return this.#envelope({ skills: SKILLS });
      case 'approvals':
        return this.#envelope({ items: session.approvals.map((card) => ({ approval_id: card.id, tool_name: card.tool_name, action: card.action, tool_input_display: card.tool_input_display })) });
      case 'questions':
        return this.#envelope({ items: session.questions.map((card) => ({ question_id: card.id, questions: card.questions })) });
      default:
        return this.#envelope(null, 40401, 'not found');
    }
  }

  async #post(session: KimiSession, action: string | undefined, tail: string | undefined, body: any): Promise<Response> {
    if (action === 'abort') {
      const running = session.running;
      this.record({ kind: 'abort', session: session.id, running: running !== undefined });
      if (!running) return this.#envelope({ aborted: false });
      running.abort.abort();
      return this.#envelope({ aborted: true });
    }
    if (tail === 'prompts') return this.#submit(session, body);
    if (tail === 'profile') {
      if (typeof body?.title === 'string') {
        session.title = body.title;
        session.updatedAt = Math.max(session.updatedAt + 1, Date.now());
        return this.#envelope(this.#v1Row(session));
      }
      const control = body?.agent_config?.goal_control;
      if (control && session.goal) {
        session.goal = control === 'cancel' ? null : { ...session.goal, status: control === 'pause' ? 'paused' : 'active' };
        this.record({ kind: 'goal-control', session: session.id, control });
      }
      return this.#envelope(this.#v1Row(session));
    }
    const skill = tail?.match(/^skills\/(.+):activate$/);
    if (skill) {
      this.record({ kind: 'skill-activate', session: session.id, skill: skill[1], args: body?.args });
      return this.#envelope({ activated: true, skill_name: skill[1] });
    }
    const approval = tail?.match(/^approvals\/(.+)$/);
    if (approval) return this.#resolveApproval(session, approval[1]!, body);
    const question = tail?.match(/^questions\/(.+?)(:dismiss)?$/);
    if (question) return this.#resolveQuestion(session, question[1]!, question[2] ? 'dismissed' : 'answered', body);
    return this.#envelope(null, 40401, 'not found');
  }

  #resolveApproval(session: KimiSession, id: string, body: any): Response {
    const card = session.approvals.find((candidate) => candidate.id === id);
    if (!card) return this.#envelope(null, 40401, 'approval not found');
    const decision = String(body?.decision ?? 'rejected');
    session.approvals = session.approvals.filter((candidate) => candidate !== card);
    this.record({ kind: 'permission-reply', session: session.id, id, reply: decision, scope: body?.scope });
    this.emit(session.id, 'event.approval.resolved', { approval_id: id, decision, scope: body?.scope, resolved_at: new Date().toISOString() });
    card.resolve?.(decision);
    return this.#envelope({ resolved: true, resolved_at: new Date().toISOString() });
  }

  #resolveQuestion(session: KimiSession, id: string, outcome: 'answered' | 'dismissed', body: any): Response {
    const card = session.questions.find((candidate) => candidate.id === id);
    if (!card) return this.#envelope(null, 40401, 'question not found');
    session.questions = session.questions.filter((candidate) => candidate !== card);
    this.record({ kind: 'question-reply', session: session.id, id, outcome, answers: body?.answers });
    this.emit(session.id, outcome === 'answered' ? 'event.question.answered' : 'event.question.dismissed', { question_id: id, resolved_at: new Date().toISOString() });
    card.resolve?.(outcome === 'answered' ? `question ${JSON.stringify(body?.answers)}` : 'question dismissed');
    return this.#envelope(outcome === 'answered' ? { answered: true } : { dismissed: true });
  }

  // ------------------------------------------------------------------------ turns

  #submit(session: KimiSession, body: any): Response {
    const content: Json[] = Array.isArray(body?.content) ? body.content : [];
    const text = content.filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('');
    const prompt: Prompt = {
      id: `prompt_${(this.#promptCounter += 1)}`,
      text,
      hold: /\[\[hold:([^\]]+)\]\]/.exec(text)?.[1],
      permission: text.includes('[[permission]]'),
      question: text.includes('[[question]]'),
      fail: text.includes('[[fail]]'),
      ...(typeof body?.model === 'string' ? { model: body.model } : {}),
    };
    if (typeof body?.thinking === 'string') session.thinking = body.thinking;
    if (typeof body?.permission_mode === 'string') session.permission = body.permission_mode;
    if (typeof body?.goal_objective === 'string') session.goal = { objective: body.goal_objective, status: 'active' };
    const echo = this.#echoRow(session, content, text);
    echo.prompt_id = prompt.id;
    session.queue.push(prompt);
    this.record({ kind: 'prompt-accepted', session: session.id, promptId: prompt.id, text, userMessageId: echo.id });
    const status = session.running ? 'queued' : 'running';
    if (!session.running) void this.#runNext(session);
    return this.#envelope({ prompt_id: prompt.id, user_message_id: echo.id, status, content, created_at: echo.created_at });
  }

  /** What the host stores for a user prompt: text, files as a notice, images as data URLs. */
  #echoRow(session: KimiSession, content: Json[], text: string): KimiMessageRow {
    const parts: Json[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const part of content) {
      if (part.type === 'file') {
        parts.push({ type: 'text', text: `Attached file "${part.name}" (${part.media_type}, ${part.size} bytes): /srv/kimi/attachments/${part.file_id}-${part.name} — open it with the Read tool` });
      } else if (part.type === 'image') {
        parts.push({ type: 'image', source: { kind: 'url', url: `data:${part.source?.media_type};base64,${part.source?.data}` } });
      }
    }
    const row = this.appendRow(session, 'user', text);
    row.content = parts.length > 0 ? parts : row.content;
    return row;
  }

  async #runNext(session: KimiSession): Promise<void> {
    const prompt = session.queue.shift();
    if (!prompt) return;
    const turnId = (this.#turnCounter += 1);
    const abort = new AbortController();
    session.running = { prompt, abort, turnId };
    session.busy = true;
    session.pending = 'none';
    if (prompt.model) session.model = prompt.model;
    this.emit(session.id, 'event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
    this.emit(session.id, 'turn.started', { turnId, promptId: prompt.id, origin: { kind: 'user' } });
    let outcome: 'completed' | 'cancelled' | 'failed' = 'completed';
    let detail = '';
    try {
      if (prompt.hold) await this.#hold(prompt.hold, abort.signal);
      if (prompt.permission) detail = await this.#askApproval(session, abort.signal);
      if (prompt.question) detail = await this.#askQuestion(session, abort.signal);
      if (prompt.fail) outcome = 'failed';
    } catch {
      outcome = 'cancelled';
    }
    if (abort.signal.aborted) outcome = 'cancelled';
    if (outcome === 'completed') {
      this.appendRow(session, 'assistant', `answer: ${prompt.text.replace(/\[\[[^\]]*\]\]\s*/g, '').trim()}${detail ? ` (${detail})` : ''}`, { prompt_id: prompt.id });
    }
    session.pending = 'none';
    session.lastTurnReason = outcome;
    session.running = undefined;
    this.record({ kind: outcome === 'cancelled' ? 'turn-aborted' : 'turn-end', session: session.id, text: prompt.text, outcome });
    if (outcome === 'cancelled') {
      this.emit(session.id, 'prompt.aborted', { promptId: prompt.id, abortedAt: new Date().toISOString() });
      this.emit(session.id, 'turn.ended', { turnId, reason: 'cancelled' });
    } else {
      this.emit(session.id, 'turn.ended', outcome === 'failed'
        ? { turnId, reason: 'failed', error: { message: 'the provider refused the request' } }
        : { turnId, reason: 'completed' });
      const completed = () => this.emit(session.id, 'prompt.completed', { promptId: prompt.id, finishedAt: new Date().toISOString(), reason: outcome });
      const heldCompletion = /\[\[hold-completion:([^\]]+)\]\]/.exec(prompt.text)?.[1];
      if (heldCompletion) void this.#hold(heldCompletion, abort.signal).then(completed);
      else completed();
    }
    if (session.queue.length > 0) {
      void this.#runNext(session);
      return;
    }
    session.busy = false;
    this.emit(session.id, 'event.session.work_changed', { busy: false, pending_interaction: 'none', last_turn_reason: outcome });
  }

  #hold(tag: string, signal: AbortSignal): Promise<void> {
    if (this.#released.has(tag)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wake = (): void => resolve();
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      this.#held.set(tag, [...(this.#held.get(tag) ?? []), wake]);
    });
  }

  async #askApproval(session: KimiSession, signal: AbortSignal): Promise<string> {
    const card: Approval = { id: `permission-${(this.#approvalCounter += 1)}`, tool_name: 'Bash', action: 'run a command', tool_input_display: 'echo hello' };
    session.approvals.push(card);
    session.pending = 'approval';
    this.emit(session.id, 'event.approval.requested', { approval_id: card.id, tool_name: card.tool_name, action: card.action, tool_input_display: card.tool_input_display });
    this.emit(session.id, 'event.session.work_changed', { busy: true, pending_interaction: 'approval' });
    const decision = await new Promise<string>((resolve, reject) => {
      card.resolve = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    session.pending = 'none';
    this.emit(session.id, 'event.session.work_changed', { busy: true, pending_interaction: 'none' });
    return `permission ${decision}`;
  }

  async #askQuestion(session: KimiSession, signal: AbortSignal): Promise<string> {
    const card: Question = {
      id: `question-${(this.#questionCounter += 1)}`,
      questions: [{ id: 'q1', question: 'Which flavour?', header: 'Flavour', multi_select: false, allow_other: false, options: [{ id: 'o1', label: 'vanilla' }, { id: 'o2', label: 'mint' }] }],
    };
    session.questions.push(card);
    session.pending = 'question';
    this.emit(session.id, 'event.question.requested', { question_id: card.id, questions: card.questions });
    this.emit(session.id, 'event.session.work_changed', { busy: true, pending_interaction: 'question' });
    const outcome = await new Promise<string>((resolve, reject) => {
      card.resolve = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    session.pending = 'none';
    this.emit(session.id, 'event.session.work_changed', { busy: true, pending_interaction: 'none' });
    return outcome;
  }

  // -------------------------------------------------------------------- websocket

  #onSocketMessage(socket: Bun.ServerWebSocket<SocketData>, text: string): void {
    let frame: Json;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    this.record({ kind: 'ws-recv', socket: socket.data.id, frame });
    const ack = (payload: Json): void => {
      socket.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: 'success', payload }));
    };
    switch (frame.type) {
      case 'client_hello':
        ack({ accepted_subscriptions: [], resync_required: [], cursors: {} });
        return;
      case 'subscribe': {
        const ids: string[] = Array.isArray(frame.payload?.session_ids) ? frame.payload.session_ids : [];
        const accepted: string[] = [];
        const notFound: string[] = [];
        const resync: string[] = [];
        const cursors: Json = {};
        for (const id of ids) {
          const session = this.sessions.get(id);
          if (!session) {
            notFound.push(id);
            continue;
          }
          socket.data.subscribed.add(id);
          accepted.push(id);
          const held = frame.payload?.cursors?.[id];
          if (held && (held.epoch !== this.#epoch || held.seq > session.seq)) resync.push(id);
          cursors[id] = { seq: session.seq, epoch: this.#epoch };
        }
        ack({ accepted, not_found: notFound, resync_required: resync, cursors });
        for (const id of resync) {
          socket.send(JSON.stringify({ type: 'resync_required', timestamp: new Date().toISOString(), payload: { session_id: id, current_seq: this.sessions.get(id)?.seq ?? 0, epoch: this.#epoch } }));
        }
        return;
      }
      case 'subscribe_v2':
        ack({ accepted: [frame.payload?.session_id], not_found: [], resync_required: [], cursors: {} });
        return;
      case 'unsubscribe':
      case 'unsubscribe_v2':
        for (const id of [...(frame.payload?.session_ids ?? []), frame.payload?.session_id]) socket.data.subscribed.delete(id);
        return;
      default:
        return;
    }
  }

  /** Called by the create route to give a prepared id to the session it makes. */
  takePreparedId(): string | undefined {
    const id = this.#createId;
    this.#createId = undefined;
    return id;
  }
}
