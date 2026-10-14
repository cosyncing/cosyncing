/**
 * A scriptable `opencode serve` for the adapter conformance kit: many sessions, a real event bus, and
 * a turn engine, in the test process on a leased loopback port (never 4096).
 *
 * The broker reaches it through `OPENCODE_URL` and sees what it sees from a real serve: the project
 * and session lists, `/session/:id/message`, `/session/status`, a `/global/event` (and `/event`)
 * stream, `prompt_async`, permission and question asks with their reply routes, revert/unrevert,
 * summarize, fork and rename. Nothing here imports the broker or the adapter.
 *
 * A prompt's own text scripts its turn, as the other kits' fakes do:
 *
 *   [[permission]]   ask for a permission (`permission.v2.asked`) and wait for `/permission/:id/reply`
 *   [[question]]     ask a question (`question.v2.asked`) and wait for its reply or rejection
 *   [[hold:TAG]]     keep the turn open until `release(TAG)` (or an abort)
 *   [[error]]        end the turn with a native (non-abort) error, `model exploded`
 *
 * The turn echoes the user row on the bus before `prompt_async` answers 204, announces a running
 * assistant message, then a completed one, then `session.status idle`, which is OpenCode's own order.
 * Every request is handed to `record` (the kit appends it to the ledger file).
 */
import { type OpenCodeRow, openCodeRows } from '../../../harness/fakes/opencode-server.ts';

type Json = Record<string, any>;

export interface FakeServeSession {
  info: Json;
  rows: OpenCodeRow[];
  busy: boolean;
  /** Turns run strictly in arrival order, as OpenCode's own prompt queue does. */
  chain: Promise<void>;
}

export interface FakeServeOptions {
  /** Called with every request and every notable fake-side event. */
  record: (entry: Json) => void;
  version?: string;
  /** `provider/model` catalog the `/provider` route answers. */
  models?: Array<{ providerID: string; modelID: string; name: string }>;
  /** Primary agents `/agent` lists. */
  agents?: Array<{ name: string; description: string }>;
  /** Template commands `/command` lists. */
  commands?: Array<{ name: string; description: string }>;
  /**
   * A serve whose store lives elsewhere (Kilo's SQLite): called before every event reaches the bus, so
   * the store is current before any client hears of the change, as a real serve writes first.
   */
  onPublish?: (event: { type: string; properties: Json }) => void;
  /** Wraps every request (auth, a different route shape): answer it, or hand it to `next`. */
  intercept?: (request: Request, next: (request: Request) => Promise<Response>) => Response | Promise<Response>;
  /** Also publish the deprecated `session.idle` event after a turn's `session.status idle`, as Kilo's serve still does. */
  emitSessionIdle?: boolean;
  /** The first generated message/part/session id number (a restarted serve must not reuse ids). */
  sequenceStart?: number;
}

interface PendingAsk {
  id: string;
  sessionId: string;
  kind: 'permission' | 'question';
  body: Json;
  settle: (outcome: { reply?: unknown; rejected?: boolean }) => void;
}

export class FakeOpenCodeServe {
  readonly sessions = new Map<string, FakeServeSession>();
  #server: ReturnType<typeof Bun.serve> | undefined;
  #port = 0;
  readonly #options: FakeServeOptions;
  readonly #streams = new Set<{ controller: ReadableStreamDefaultController<Uint8Array>; wrapped: boolean; heartbeats: number }>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  readonly #holds = new Map<string, () => void>();
  readonly #pending = new Map<string, PendingAsk>();
  readonly #aborts = new Map<string, () => void>();
  readonly #failures = new Map<string, number>();
  readonly #raw: Array<{ directory: string; record: unknown }> = [];
  #sequence = 0;
  #nextCreateId: string | undefined;
  #version: string;
  #clock = 0;

  constructor(options: FakeServeOptions) {
    this.#options = options;
    this.#sequence = options.sequenceStart ?? 0;
    this.#version = options.version ?? '1.17.19';
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get listening(): boolean {
    return this.#server !== undefined;
  }

  /** Start listening; `port` 0 leases one, a number reuses it (a restart). */
  start(port = 0): void {
    if (this.#server) return;
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      idleTimeout: 0,
      fetch: (request) => this.#options.intercept
        ? this.#options.intercept(request, (next) => this.#handle(next))
        : this.#handle(request),
    });
    this.#port = this.#server.port!;
    this.#options.record({ kind: 'listening', port: this.#port });
  }

  /** Stop listening and drop every open stream (the serve is gone; state is kept for a restart). */
  stop(): void {
    const server = this.#server;
    this.#server = undefined;
    for (const stream of this.#streams) {
      try {
        stream.controller.close();
      } catch {
        // Already closed.
      }
    }
    this.#streams.clear();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    server?.stop(true);
  }

  /**
   * Send a comment line on every open event stream each `ms` (0 stops). A real serve does this; with it
   * off the stream is silent, which is the hang the adapter's idle timeout recovers from.
   */
  setHeartbeat(ms: number): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (ms <= 0) return;
    const encoder = new TextEncoder();
    this.#heartbeat = setInterval(() => {
      for (const stream of [...this.#streams]) {
        try {
          stream.controller.enqueue(encoder.encode(': heartbeat\n\n'));
          stream.heartbeats += 1;
        } catch {
          this.#streams.delete(stream);
        }
      }
    }, ms);
  }

  /** The open event streams, and how many heartbeats each has been sent. */
  openStreams(): Array<{ heartbeats: number }> {
    return [...this.#streams].map((stream) => ({ heartbeats: stream.heartbeats }));
  }

  setVersion(version: string): void {
    this.#version = version;
  }

  /** The next request with this method (a write) is refused with this status. */
  failNext(method: string, status: number): void {
    this.#failures.set(method, status);
  }

  /** The id the next `POST /session` answers with. */
  prepareCreate(id?: string): string {
    this.#nextCreateId = id ?? `ses_created_${++this.#sequence}`;
    return this.#nextCreateId;
  }

  /** Every open turn waiting on a hold, permission or question is ended (test teardown). */
  releaseAll(): void {
    for (const resolve of [...this.#holds.values()]) resolve();
    this.#holds.clear();
    for (const ask of [...this.#pending.values()]) ask.settle({ rejected: true });
  }

  // ------------------------------------------------------------------ seeding

  /** A stored session with `turns` completed exchanges. */
  seed(input: { id: string; directory: string; title: string; turns: number; parentID?: string; model?: { providerID: string; modelID: string } }): FakeServeSession {
    const created = this.#tick();
    const info: Json = {
      id: input.id,
      slug: input.title.toLowerCase().replaceAll(/\W+/g, '-'),
      directory: input.directory,
      title: input.title,
      time: { created, updated: created },
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.model ? { model: { providerID: input.model.providerID, id: input.model.modelID, modelID: input.model.modelID } } : {}),
    };
    const session: FakeServeSession = { info, rows: [], busy: false, chain: Promise.resolve() };
    for (let turn = 1; turn <= input.turns; turn += 1) {
      const userId = `msg_seed_${input.id}_${turn}_u`;
      const assistantId = `msg_seed_${input.id}_${turn}_a`;
      const at = this.#tick();
      session.rows.push(
        openCodeRows.user(userId, at, `seeded prompt ${turn}`),
        openCodeRows.assistant(assistantId, userId, at + 1, [
          openCodeRows.text(`prt_seed_${input.id}_${turn}`, `seeded answer ${turn}`, at + 1, at + 2),
        ], at + 2),
      );
      info.time.updated = at + 2;
    }
    this.sessions.set(input.id, session);
    return session;
  }

  /** A session record the serve lists but the broker must not trust (no usable id, wrong shape). */
  plantRaw(directory: string, record: unknown): void {
    this.#raw.push({ directory, record });
  }

  session(id: string): FakeServeSession {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`fake OpenCode serve has no session ${id}`);
    return found;
  }

  // --------------------------------------------------- terminal-side writes

  /** A turn a TUI attached to this serve typed: user row, run, answer, idle. */
  appendTurn(id: string, user: string, answer: string): void {
    const session = this.session(id);
    const userRow = this.#userRow(session, user);
    this.#announce(id, userRow);
    this.#setBusy(session, true);
    const answerRow = this.#assistantRow(session, userRow, answer);
    this.#announce(id, answerRow);
    this.#setBusy(session, false);
  }

  /** The first half of a user row: its message is announced, its text part is not yet. */
  appendPartial(id: string): string {
    const session = this.session(id);
    const row = this.#userRow(session, '', { announce: false });
    row.parts = [];
    this.#publish({ type: 'message.updated', properties: { sessionID: id, info: { ...row.info, sessionID: id } } });
    return String(row.info.id);
  }

  completePartial(id: string, messageId: string, text: string, answer: string): void {
    const session = this.session(id);
    const row = session.rows.find((candidate) => candidate.info.id === messageId)!;
    row.parts = [{ id: `prt_${messageId}`, type: 'text', text }];
    this.#touch(session);
    this.#announce(id, row);
    this.#setBusy(session, true);
    this.#announce(id, this.#assistantRow(session, row, answer));
    this.#setBusy(session, false);
  }

  /** Delete the first part of the first row and put new text there, as an edit that removes a part does. */
  rewriteFirstUserText(id: string, text: string): void {
    const session = this.session(id);
    const row = session.rows[0]!;
    const part = row.parts[0]!;
    part.text = text;
    this.#touch(session);
    this.#publish({ type: 'message.part.removed', properties: { sessionID: id, messageID: row.info.id, partID: part.id } });
  }

  /**
   * A turn whose answer streams token by token: each part is announced empty, grows by `message.part.delta`
   * events, and ends with the whole text in a final `message.part.updated`, as OpenCode writes it.
   */
  streamTurn(id: string, user: string, parts: Array<{ id: string; type: 'text' | 'reasoning'; deltas: string[] }>): void {
    const session = this.session(id);
    const userRow = this.#userRow(session, user);
    this.#announce(id, userRow);
    this.#setBusy(session, true);
    const at = this.#tick();
    const assistant = openCodeRows.assistant(this.#messageId(), String(userRow.info.id), at, []);
    session.rows.push(assistant);
    this.#publish({ type: 'message.updated', properties: { sessionID: id, info: { ...assistant.info, sessionID: id } } });
    for (const part of parts) {
      const empty = { id: part.id, type: part.type, text: '', time: { start: at } };
      this.#publish({ type: 'message.part.updated', properties: { sessionID: id, part: { ...empty, sessionID: id, messageID: assistant.info.id } } });
      for (const delta of part.deltas) {
        this.#publish({ type: 'message.part.delta', properties: { sessionID: id, messageID: assistant.info.id, partID: part.id, field: 'text', delta } });
      }
      const whole = { ...empty, text: part.deltas.join(''), time: { start: at, end: at + 1 } };
      assistant.parts.push(whole);
      this.#publish({ type: 'message.part.updated', properties: { sessionID: id, part: { ...whole, sessionID: id, messageID: assistant.info.id } } });
    }
    const completed = openCodeRows.assistant(String(assistant.info.id), String(userRow.info.id), at, assistant.parts, at + 2);
    assistant.info = completed.info;
    this.#touch(session);
    this.#publish({ type: 'message.updated', properties: { sessionID: id, info: { ...assistant.info, sessionID: id } } });
    this.#setBusy(session, false);
  }

  /** Events a real serve emits constantly and the broker must ignore. */
  noise(id: string): void {
    const session = this.session(id);
    this.#publish({ type: 'server.heartbeat', properties: {} });
    this.#publish({ type: 'session.updated', properties: { sessionID: id, info: { ...session.info, sessionID: id } } });
    this.#publish({ type: 'message.updated', properties: { sessionID: 'ses_somebody_else', info: { id: 'msg_other', role: 'user', time: { created: 1 } } } });
  }

  /** Set a session's run status and announce it, as the serve does when a turn starts or ends. */
  setBusy(id: string, busy: boolean): void {
    this.#setBusy(this.session(id), busy);
  }

  /** Append a row the way a native writer does and announce it on the bus. */
  addRow(id: string, row: OpenCodeRow): void {
    const session = this.session(id);
    session.rows.push(row);
    this.#touch(session);
    this.#announce(id, row);
  }

  /** Let a `[[hold:TAG]]` turn finish. */
  release(tag: string): void {
    this.#holds.get(tag)?.();
    this.#holds.delete(tag);
  }

  /** Publish an arbitrary event on the bus. */
  publish(event: { type: string; properties: Json }): void {
    this.#publish(event);
  }

  /** The current pending permission or question asks, oldest first. */
  pendingAsks(): PendingAsk[] {
    return [...this.#pending.values()];
  }

  // -------------------------------------------------------------------- bus

  #publish(event: { type: string; properties: Json }): void {
    this.#options.onPublish?.(event);
    const encoder = new TextEncoder();
    for (const stream of [...this.#streams]) {
      const payload = stream.wrapped ? { payload: event } : event;
      try {
        stream.controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      } catch {
        this.#streams.delete(stream);
      }
    }
  }

  #announce(sessionId: string, row: OpenCodeRow): void {
    this.#publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...row.info, sessionID: sessionId } } });
    for (const part of row.parts) {
      this.#publish({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { ...part, sessionID: sessionId, messageID: row.info.id } } });
    }
  }

  #setBusy(session: FakeServeSession, busy: boolean): void {
    session.busy = busy;
    this.#publish({ type: 'session.status', properties: { sessionID: session.info.id, status: { type: busy ? 'busy' : 'idle' } } });
    if (!busy && this.#options.emitSessionIdle) this.#publish({ type: 'session.idle', properties: { sessionID: session.info.id } });
  }

  #tick(): number {
    this.#clock = Math.max(this.#clock + 1, Date.now());
    return this.#clock;
  }

  #touch(session: FakeServeSession): void {
    session.info.time.updated = this.#tick();
  }

  #messageId(): string {
    return `msg_fake_${String(++this.#sequence).padStart(6, '0')}`;
  }

  #userRow(session: FakeServeSession, text: string, options: { id?: string; announce?: boolean } = {}): OpenCodeRow {
    const row = openCodeRows.user(options.id ?? this.#messageId(), this.#tick(), text);
    session.rows.push(row);
    this.#touch(session);
    return row;
  }

  #assistantRow(session: FakeServeSession, user: OpenCodeRow, answer: string): OpenCodeRow {
    const at = this.#tick();
    const row = openCodeRows.assistant(this.#messageId(), String(user.info.id), at, [
      openCodeRows.text(`prt_fake_${String(++this.#sequence).padStart(6, '0')}`, answer, at, at + 1),
    ], at + 1);
    session.rows.push(row);
    this.#touch(session);
    return row;
  }

  // ------------------------------------------------------------ turn engine

  #startTurn(session: FakeServeSession, user: OpenCodeRow, text: string, model?: Json): void {
    const sessionId = String(session.info.id);
    session.chain = session.chain.then(() => this.#runTurn(session, user, text, model).catch((error) => {
      this.#options.record({ kind: 'fault', message: `turn failed: ${String(error)}` });
    }));
    void sessionId;
  }

  async #runTurn(session: FakeServeSession, user: OpenCodeRow, text: string, model?: Json): Promise<void> {
    const sessionId = String(session.info.id);
    const hold = /\[\[hold:([^\]]+)\]\]/.exec(text)?.[1];
    const permission = text.includes('[[permission]]');
    const question = text.includes('[[question]]');
    const failing = text.includes('[[error]]');
    const visible = text.replaceAll(/\[\[[^\]]*\]\]\s*/g, '').trim();
    this.#options.record({ kind: 'turn', sessionId, text });
    if (model?.providerID && model?.modelID) {
      session.info.model = { providerID: model.providerID, id: model.modelID, modelID: model.modelID };
      this.#touch(session);
      this.#publish({ type: 'session.updated', properties: { sessionID: sessionId, info: { ...session.info, sessionID: sessionId } } });
    }
    this.#setBusy(session, true);
    const at = this.#tick();
    const assistant = openCodeRows.assistant(this.#messageId(), String(user.info.id), at, []);
    session.rows.push(assistant);
    this.#touch(session);
    this.#publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...assistant.info, sessionID: sessionId } } });

    let aborted = false;
    const abortSignal = new Promise<void>((resolve) => {
      this.#aborts.set(sessionId, () => {
        aborted = true;
        resolve();
      });
    });
    const waitFor = (gate: Promise<unknown>) => Promise.race([gate, abortSignal]);
    let detail = '';
    if (hold) await waitFor(new Promise<void>((resolve) => this.#holds.set(hold, resolve)));
    if (permission && !aborted) {
      const id = `permission-${++this.#sequence}`;
      const outcome = await waitFor(this.#ask(sessionId, id, 'permission', {
        id, sessionID: sessionId, action: 'bash', resources: ['rm -rf build'],
        // The legacy fields a pending-list read (`GET /permission`) carries.
        permission: 'bash', patterns: ['rm -rf build'],
      })) as { reply?: unknown; rejected?: boolean } | undefined;
      detail = ` permission ${String(outcome?.reply ?? 'rejected')}`;
    }
    if (question && !aborted) {
      const id = `question-${++this.#sequence}`;
      const outcome = await waitFor(this.#ask(sessionId, id, 'question', {
        id, sessionID: sessionId,
        questions: [{ question: 'Which flavour?', header: 'Flavour', multiple: false, options: [{ label: 'vanilla', description: 'Plain' }, { label: 'mint', description: 'Fresh' }] }],
      })) as { reply?: unknown; rejected?: boolean } | undefined;
      detail = outcome?.rejected ? ' question dismissed' : ` question ${JSON.stringify(outcome?.reply)}`;
    }
    this.#aborts.delete(sessionId);
    const done = this.#tick();
    if (failing && !aborted) {
      const error = { name: 'ProviderError', data: { message: 'model exploded' } };
      assistant.info.time = { created: (assistant.info.time as { created: number }).created, completed: done };
      assistant.info.error = error;
      this.#touch(session);
      this.#publish({ type: 'session.error', properties: { sessionID: sessionId, error } });
      this.#publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...assistant.info, sessionID: sessionId } } });
      this.#setBusy(session, false);
      this.#options.record({ kind: 'turn-end', sessionId, text });
      return;
    }
    if (aborted) {
      assistant.info.time = { created: (assistant.info.time as { created: number }).created, completed: done };
      assistant.info.error = { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } };
      this.#touch(session);
      this.#publish({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } } });
      this.#publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...assistant.info, sessionID: sessionId } } });
      this.#setBusy(session, false);
      this.#options.record({ kind: 'turn-aborted', sessionId, text });
      return;
    }
    const part = openCodeRows.text(`prt_fake_${String(++this.#sequence).padStart(6, '0')}`, `answer: ${visible}${detail}`, done, done + 1);
    assistant.parts.push(part);
    this.#publish({ type: 'message.part.updated', properties: { sessionID: sessionId, part: { ...part, sessionID: sessionId, messageID: assistant.info.id } } });
    const completed = openCodeRows.assistant(String(assistant.info.id), String(user.info.id), at, assistant.parts, done + 1);
    assistant.info = completed.info;
    this.#touch(session);
    this.#publish({ type: 'message.updated', properties: { sessionID: sessionId, info: { ...assistant.info, sessionID: sessionId } } });
    this.#setBusy(session, false);
    this.#options.record({ kind: 'turn-end', sessionId, text });
  }

  #ask(sessionId: string, id: string, kind: 'permission' | 'question', body: Json): Promise<unknown> {
    return new Promise((resolve) => {
      this.#pending.set(id, { id, sessionId, kind, body, settle: (outcome) => { this.#pending.delete(id); resolve(outcome); } });
      this.#publish({ type: kind === 'permission' ? 'permission.v2.asked' : 'question.v2.asked', properties: body });
    });
  }

  // ------------------------------------------------------------------- HTTP

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body = method === 'POST' || method === 'PATCH' || method === 'PUT'
      ? await request.json().catch(() => ({})) as Json
      : undefined;
    this.#options.record({ kind: 'request', method, path, query: Object.fromEntries(url.searchParams), ...(body !== undefined ? { body } : {}) });
    const refused = method === 'GET' ? undefined : this.#failures.get(method);
    if (refused !== undefined) {
      this.#failures.delete(method);
      return Response.json({ name: 'UnknownError', data: { message: 'refused by the fake' } }, { status: refused });
    }

    if (path === '/global/event' || path === '/event') {
      let own: { controller: ReadableStreamDefaultController<Uint8Array>; wrapped: boolean; heartbeats: number } | undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          own = { controller, wrapped: path === '/global/event', heartbeats: 0 };
          this.#streams.add(own);
          controller.enqueue(new TextEncoder().encode(': connected\n\n'));
        },
        cancel: () => {
          if (own) this.#streams.delete(own);
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/global/health') return Response.json({ healthy: true, version: this.#version });
    if (path === '/project') {
      const directories = new Set([...this.sessions.values()].map((session) => String(session.info.directory)));
      for (const raw of this.#raw) directories.add(raw.directory);
      return Response.json([...directories].map((worktree) => ({ worktree })));
    }
    if (path === '/session' && method === 'GET') {
      const directory = url.searchParams.get('directory');
      if (!directory) return Response.json([]);
      return Response.json([
        ...[...this.sessions.values()].filter((session) => session.info.directory === directory).map((session) => session.info),
        ...this.#raw.filter((raw) => raw.directory === directory).map((raw) => raw.record),
      ]);
    }
    if (path === '/session' && method === 'POST') {
      const directory = url.searchParams.get('directory') ?? '';
      const id = this.#nextCreateId ?? `ses_created_${++this.#sequence}`;
      this.#nextCreateId = undefined;
      const session = this.seed({ id, directory, title: typeof body?.title === 'string' ? body.title : 'New session', turns: 0 });
      return Response.json(session.info);
    }
    if (path === '/session/status') {
      const busy = Object.fromEntries([...this.sessions.values()].filter((session) => session.busy).map((session) => [session.info.id, { type: 'busy' }]));
      return Response.json(busy);
    }
    if (path === '/provider') {
      const models = this.#options.models ?? [];
      const providers = [...new Set(models.map((model) => model.providerID))];
      return Response.json({
        connected: providers,
        all: providers.map((providerID) => ({
          id: providerID,
          name: providerID,
          models: Object.fromEntries(models.filter((model) => model.providerID === providerID)
            .map((model) => [model.modelID, { id: model.modelID, name: model.name }])),
        })),
      });
    }
    if (path === '/agent') return Response.json((this.#options.agents ?? []).map((agent) => ({ ...agent, mode: 'primary' })));
    if (path === '/command') return Response.json(this.#options.commands ?? []);
    if (path === '/permission' || path === '/question') {
      const directory = url.searchParams.get('directory');
      const kind = path === '/permission' ? 'permission' : 'question';
      return Response.json([...this.#pending.values()]
        .filter((ask) => ask.kind === kind && (!directory || this.sessions.get(ask.sessionId)?.info.directory === directory))
        .map((ask) => ask.body));
    }
    const reply = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path);
    if (reply && method === 'POST') {
      const ask = this.#pending.get(decodeURIComponent(reply[2]!));
      if (!ask || ask.kind !== reply[1]) return Response.json({ name: 'NotFoundError', data: { message: 'no such request' } }, { status: 404 });
      const rejected = reply[3] === 'reject' || body?.reply === 'reject';
      const sessionId = ask.sessionId;
      this.#options.record({ kind: reply[1] === 'permission' ? 'permission-reply' : 'question-reply', id: ask.id, reply: body?.reply ?? body?.answers ?? null, rejected });
      ask.settle({ reply: body?.reply ?? body?.answers, rejected });
      this.#publish({
        type: reply[1] === 'permission' ? 'permission.v2.replied' : (rejected ? 'question.v2.rejected' : 'question.v2.replied'),
        properties: { sessionID: sessionId, requestID: ask.id, ...(reply[1] === 'permission' ? { reply: body?.reply } : {}) },
      });
      return Response.json(true);
    }

    const route = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path) ?? /^\/api\/session\/([^/]+)\/(agent)$/.exec(path);
    if (!route) {
      this.#options.record({ kind: 'unimplemented', method, path });
      return new Response('not found', { status: 404 });
    }
    const session = this.sessions.get(decodeURIComponent(route[1]!));
    if (!session) return Response.json({ name: 'NotFoundError', data: { message: 'session not found' } }, { status: 404 });
    const sub = route[2] ?? '';
    const sessionId = String(session.info.id);
    if (sub === '' && method === 'GET') return Response.json(session.info);
    if (sub === '' && method === 'PATCH') {
      if (typeof body?.title === 'string') session.info.title = body.title;
      else delete session.info.title;
      this.#touch(session);
      this.#publish({ type: 'session.updated', properties: { sessionID: sessionId, info: { ...session.info, sessionID: sessionId } } });
      return Response.json(session.info);
    }
    if (sub === 'message' && method === 'GET') return Response.json(session.rows);
    if (sub === 'prompt_async' && method === 'POST') {
      const messageID = typeof body?.messageID === 'string' ? body.messageID : undefined;
      const text = String(body?.parts?.find((part: any) => part?.type === 'text')?.text ?? '');
      const user = this.#userRow(session, text, { id: messageID });
      this.#announce(sessionId, user);
      this.#startTurn(session, user, text, body?.model);
      return new Response(null, { status: 204 });
    }
    if (sub === 'command' && method === 'POST') {
      const text = `/${String(body?.command ?? '')}${body?.arguments ? ` ${String(body.arguments)}` : ''}`;
      const user = this.#userRow(session, text);
      this.#announce(sessionId, user);
      this.#startTurn(session, user, text);
      return Response.json(true);
    }
    if (sub === 'abort' && method === 'POST') {
      this.#aborts.get(sessionId)?.();
      for (const ask of [...this.#pending.values()].filter((candidate) => candidate.sessionId === sessionId)) ask.settle({ rejected: true });
      return Response.json(true);
    }
    if (sub === 'revert' && method === 'POST') {
      if (session.busy) return Response.json({ name: 'BusyError', data: { message: 'session is busy' } }, { status: 409 });
      session.info.revert = { messageID: String(body?.messageID) };
      this.#touch(session);
      this.#publish({ type: 'session.updated', properties: { sessionID: sessionId, info: { ...session.info, sessionID: sessionId } } });
      return Response.json(session.info);
    }
    if (sub === 'unrevert' && method === 'POST') {
      if (!session.info.revert) return Response.json({ name: 'NothingToRedo', data: { message: 'nothing to redo' } }, { status: 409 });
      delete session.info.revert;
      this.#touch(session);
      this.#publish({ type: 'session.updated', properties: { sessionID: sessionId, info: { ...session.info, sessionID: sessionId } } });
      return Response.json(session.info);
    }
    if (sub === 'summarize' && method === 'POST') {
      // Compaction replaces the conversation with a summary, then announces it.
      const first = session.rows[0];
      const at = this.#tick();
      const summary = openCodeRows.assistant(this.#messageId(), String(first?.info.id ?? 'msg_none'), at, [
        openCodeRows.text(`prt_fake_${String(++this.#sequence).padStart(6, '0')}`, 'summary of the earlier conversation', at, at + 1),
      ], at + 1);
      session.rows = first ? [first, summary] : [summary];
      this.#touch(session);
      this.#publish({ type: 'session.compacted', properties: { sessionID: sessionId } });
      return Response.json(true);
    }
    if (sub === 'fork' && method === 'POST') {
      const cut = typeof body?.messageID === 'string' ? session.rows.findIndex((row) => row.info.id === body.messageID) : -1;
      const id = `ses_fork_${++this.#sequence}`;
      const child = this.seed({ id, directory: String(session.info.directory), title: `${String(session.info.title)} (fork #1)`, turns: 0 });
      child.rows = session.rows.slice(0, cut >= 0 ? cut : session.rows.length).map((row) => structuredClone(row));
      return Response.json(child.info);
    }
    if (sub === 'share' && method === 'POST') return Response.json({ ...session.info, share: { url: `https://share.invalid/${sessionId}` } });
    if (sub === 'share' && method === 'DELETE') return Response.json(true);
    if (sub === 'agent' && method === 'POST') {
      session.info.agent = String(body?.agent ?? '');
      this.#publish({ type: 'session.next.agent.switched', properties: { sessionID: sessionId, agent: session.info.agent } });
      return new Response(null, { status: 204 });
    }
    this.#options.record({ kind: 'unimplemented', method, path });
    return new Response('not found', { status: 404 });
  }
}
