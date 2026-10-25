type Json = Record<string, any>;

export interface FakeV2Session {
  info: Json;
  messages: Json[];
  inbox: Json[];
  busy: boolean;
  cancelled: boolean;
}

interface Ask { id: string; sessionID: string; kind: 'permission' | 'form'; value: Json; settle: (answer: unknown) => void; }

/** A shared service fixture with the native inbox, projection and durable-event ordering. */
export class FakeOpenCodeV2Serve {
  readonly sessions = new Map<string, FakeV2Session>();
  readonly pending = new Map<string, Ask>();
  readonly holds = new Map<string, () => void>();
  readonly record: (value: Json) => void;
  readonly onRegistration: (value: Json | undefined) => void;
  private server?: ReturnType<typeof Bun.serve>;
  private portValue = 0;
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private serial = 0;
  private clock = Date.now();
  private sequences = new Map<string, number>();
  private incarnation = crypto.randomUUID();
  private readonly credential = crypto.randomUUID();
  private failures = new Map<string, { status: number; count: number; body?: Json }>();
  private ambiguous = new Set<string>();
  private redirects = new Map<string, string>();
  private raw: Json[] = [];
  private aborted = new Map<string, () => void>();
  private expectedCreate?: string;
  version = '2.1.4';
  migration: 'required' | 'running' | 'completed' | 'error' = 'completed';
  formFields?: Json[];

  constructor(options: { record: (value: Json) => void; onRegistration: (value: Json | undefined) => void }) {
    this.record = options.record;
    this.onRegistration = options.onRegistration;
  }
  get port(): number { return this.portValue; }
  get url(): string { return `http://127.0.0.1:${this.portValue}`; }
  get listening(): boolean { return !!this.server; }
  get openStreams(): number { return this.streams.size; }
  private now(): number { this.clock = Math.max(Date.now(), this.clock + 1); return this.clock; }
  private id(prefix: string): string { return `${prefix}_fixture${String(++this.serial).padStart(12, '0')}`; }
  registration(): Json { return { id: this.incarnation, version: this.version, pid: process.pid, url: this.url, password: this.credential }; }
  publishRegistration(): void { this.onRegistration(this.registration()); }
  setVersion(version: string): void { this.version = version; this.publishRegistration(); }

  start(port = this.portValue): void {
    if (this.server) return;
    this.server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, fetch: (request) => this.handle(request) });
    this.portValue = this.server.port!;
    this.publishRegistration();
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) try { stream.enqueue(new TextEncoder().encode(': heartbeat\n\n')); } catch { this.streams.delete(stream); }
    }, 1000);
    this.heartbeat.unref?.();
  }
  disconnectStreams(): void {
    for (const stream of this.streams) try { stream.close(); } catch { /* Already closed. */ }
    this.streams.clear();
  }
  restartIdentity(): void { this.incarnation = crypto.randomUUID(); this.publishRegistration(); this.disconnectStreams(); }
  stop(): void { this.disconnectStreams(); clearInterval(this.heartbeat); this.server?.stop(true); this.server = undefined; }
  release(tag: string): void { this.holds.get(tag)?.(); this.holds.delete(tag); }
  releaseAll(): void { for (const release of this.holds.values()) release(); this.holds.clear(); for (const ask of this.pending.values()) ask.settle('reject'); }
  failNext(method: string, path: string, status: number, count = 1, body?: Json): void { this.failures.set(`${method} ${path}`, { status, count, body }); }
  ambiguousNext(path: string): void { this.ambiguous.add(path); }
  redirectNext(path: string, target: string): void { this.redirects.set(path, target); }
  plantRaw(_directory: string, value: Json): void { this.raw.push(value); }
  prepareCreate(id?: string): string { this.expectedCreate = id ?? this.id('ses'); return this.expectedCreate; }
  session(id: string): FakeV2Session { const value = this.sessions.get(id); if (!value) throw new Error('Unknown fixture session.'); return value; }

  seed(options: { id: string; directory: string; title?: string; turns?: number; parentID?: string; model?: { providerID: string; modelID: string } }): FakeV2Session {
    const now = this.now();
    const info = { id: options.id, projectID: 'project-fixture', title: options.title || options.id, location: { directory: options.directory }, time: { created: now, updated: now }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, model: { providerID: options.model?.providerID ?? 'test-provider', id: options.model?.modelID ?? 'model-a' }, agent: 'build', ...(options.parentID ? { parentID: options.parentID } : {}) };
    const session: FakeV2Session = { info, messages: [], inbox: [], busy: false, cancelled: false };
    this.sessions.set(info.id, session);
    for (let turn = 1; turn <= (options.turns ?? 1); turn++) this.appendRows(session, `seeded prompt ${turn}`, `seeded answer ${turn}`);
    return session;
  }

  private appendRows(session: FakeV2Session, user: string, answer: string): { user: Json; assistant: Json; idle: Json } {
    const input = { id: this.id('msg'), time: { created: this.now() }, type: 'user', text: user };
    const assistant = { id: this.id('msg'), time: { created: this.now(), completed: this.now() }, type: 'assistant', agent: 'build', model: session.info.model, content: [{ type: 'text', text: answer }], tokens: { input: 8, output: 4, cache: { read: 0, write: 0 } }, cost: 0, finish: 'stop' };
    const idle = { id: this.id('msg'), time: { created: this.now() }, type: 'idle', outcome: 'succeeded' };
    session.messages.push(input, assistant, idle); session.info.time.updated = this.now();
    return { user: input, assistant, idle };
  }

  appendTurn(id: string, user: string, answer: string): void {
    const session = this.session(id);
    const rows = this.appendRows(session, user, answer);
    this.emit('session.inbox.enqueued', { sessionID: id, inboxID: rows.user.id, item: { type: 'user', payload: { text: user }, delivery: 'steer' } }, true);
    this.emit('session.execution.started', { sessionID: id }, true);
    this.emit('session.inbox.delivered', { sessionID: id, inboxID: rows.user.id }, true);
    this.emit('session.text.ended', { sessionID: id, assistantMessageID: rows.assistant.id, ordinal: 0, text: answer }, true);
    this.emit('session.execution.succeeded', { sessionID: id }, true);
  }

  appendPartial(id: string): string { return id; }
  completePartial(id: string): void { this.appendTurn(id, 'partial prompt', 'partial answer'); }
  rewriteFirstUserText(id: string, text: string): void {
    const session = this.session(id); const first = session.messages.find((message) => message.type === 'user');
    if (first) first.text = text;
    session.info.time.updated = this.now(); this.disconnectStreams();
  }
  noise(id: string): void { this.emit('fixture.unknown', { sessionID: id }); }
  setBusy(id: string, busy: boolean): void { this.session(id).busy = busy; this.emit(busy ? 'session.execution.started' : 'session.execution.succeeded', { sessionID: id }, true); }

  emit(type: string, data: Json, durable = false): void {
    const sessionID = data.sessionID ?? data.form?.sessionID;
    const seq = (this.sequences.get(sessionID) ?? 0) + 1;
    if (durable) this.sequences.set(sessionID, seq);
    const event = { id: this.id('evt'), created: this.now(), type, data, ...(sessionID && this.sessions.has(sessionID) ? { location: this.session(sessionID).info.location } : {}), ...(durable ? { durable: { aggregateID: sessionID, seq, version: 1 } } : {}) };
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const stream of this.streams) try { stream.enqueue(bytes); } catch { this.streams.delete(stream); }
  }

  private page(rows: Json[], url: URL): Response {
    if (url.searchParams.has('cursor') && url.searchParams.has('order')) return Response.json({ _tag: 'InvalidRequestError' }, { status: 400 });
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
    const offset = Number(url.searchParams.get('cursor') || 0);
    const data = rows.slice(offset, offset + limit);
    return Response.json({ data, cursor: data.length ? { previous: String(Math.max(0, offset - limit)), next: String(offset + limit) } : {} });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const body = method === 'GET' || method === 'DELETE' ? undefined : await request.json().catch(() => undefined) as Json | undefined;
    const authorized = request.headers.get('authorization') === `Basic ${Buffer.from(`opencode:${this.credential}`).toString('base64')}`;
    this.record({ kind: 'request', method, path, query: Object.fromEntries(url.searchParams), body, authorized });
    const redirect = this.redirects.get(path);
    if (redirect) { this.redirects.delete(path); return new Response(null, { status: 302, headers: { location: redirect } }); }
    const failure = this.failures.get(`${method} ${path}`);
    if (failure && failure.count-- > 0) return Response.json(failure.body ?? { _tag: 'FixtureRequestError' }, { status: failure.status });
    if (path.startsWith('/api/') && !authorized) return Response.json({ _tag: 'UnauthorizedError', message: 'Authentication required' }, { status: 401 });
    if (path === '/api/info') return Response.json({ version: this.version, pid: process.pid, urls: [this.url], paths: { tmp: '/work/tmp' }, capabilities: { persistentPty: true } });
    if (path === '/api/event') {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({
        start: (value) => { controller = value; this.streams.add(value); value.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n')); },
        cancel: () => { this.streams.delete(controller); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/api/experimental/migration/v1') return Response.json({ status: this.migration });
    if (path === '/api/session/active') return Response.json({ data: Object.fromEntries([...this.sessions].filter(([, session]) => session.busy).map(([id]) => [id, { type: 'running' }])) });
    if (path === '/api/provider') return Response.json({ location: { directory: '/work/project' }, data: [{ id: 'test-provider', name: 'Test Provider', activation: 'enabled' }] });
    if (path === '/api/model') return Response.json({ location: { directory: '/work/project' }, data: ['model-a', 'model-b'].map((id) => ({ id, modelID: id, providerID: 'test-provider', name: id === 'model-a' ? 'Model A' : 'Model B', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] })) });
    if (path === '/api/agent') return Response.json({ location: { directory: '/work/project' }, data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }, { id: 'plan', name: 'Plan', mode: 'primary', hidden: false }] });
    if (path === '/api/session' && method === 'GET') {
      const rows = [...this.sessions.values()].map((session) => session.info).filter((info) => url.searchParams.get('archived') !== 'false' || !info.time.archived).sort((a, b) => b.time.updated - a.time.updated);
      return this.page([...rows, ...this.raw], url);
    }
    if (path === '/api/session' && method === 'POST') {
      if (!body || typeof body.id !== 'string') return Response.json({ _tag: 'InvalidRequestError' }, { status: 400 });
      const session = this.seed({ id: body.id, directory: body.location?.directory ?? '/work/project', title: body.title, turns: 0 });
      if (body.model) session.info.model = body.model;
      if (body.agent) session.info.agent = body.agent;
      this.expectedCreate = undefined;
      this.emit('session.created', { sessionID: session.info.id, slug: 'fixture-session', version: this.version, projectID: session.info.projectID, location: session.info.location, subpath: '', title: session.info.title, model: session.info.model }, true);
      if (this.ambiguous.delete(path)) return Response.json({});
      return Response.json({ data: session.info });
    }
    const match = /^\/api\/session\/([^/]+)(.*)$/.exec(path);
    if (!match) return path.startsWith('/api/') ? Response.json({ _tag: 'NotFoundError' }, { status: 404 }) : new Response('<!doctype html><title>OpenCode</title>');
    const id = decodeURIComponent(match[1]!), sub = match[2]!, session = this.sessions.get(id);
    if (!session) return Response.json({ _tag: 'SessionNotFoundError', sessionID: id }, { status: 404 });
    if (!sub && method === 'GET') return Response.json({ data: session.info });
    if (sub === '/message') return this.page([...session.messages].reverse(), url);
    if (sub.startsWith('/message/')) {
      const message = session.messages.find((item) => item.id === decodeURIComponent(sub.slice(9)));
      return Response.json(message ? { data: message } : { _tag: 'MessageNotFoundError' }, { status: message ? 200 : 404 });
    }
    if (sub === '/inbox') return Response.json({ data: session.inbox });
    if (sub === '/permission' || sub === '/form') return Response.json({ data: [...this.pending.values()].filter((ask) => ask.sessionID === id && ask.kind === sub.slice(1)).map((ask) => ask.value) });
    if ((sub === '/model' || sub === '/agent') && method === 'POST') {
      session.info[sub.slice(1)] = sub === '/model' ? body?.model : body?.agent;
      session.info.time.updated = this.now();
      return Response.json({ data: session.info });
    }
    if (sub === '/prompt' && method === 'POST') {
      if (!body || typeof body.id !== 'string' || typeof body.text !== 'string') return Response.json({ _tag: 'InvalidRequestError' }, { status: 400 });
      const input = { id: body.id, sessionID: id, time: { created: this.now() }, type: 'user', payload: { text: body.text }, delivery: body.delivery ?? 'steer' };
      session.inbox.push(input);
      this.record({ kind: 'prompt-model', sessionId: id, model: session.info.model });
      this.emit('session.inbox.enqueued', { sessionID: id, inboxID: input.id, item: { type: 'user', payload: input.payload, delivery: input.delivery } }, true);
      if (!session.busy) { session.busy = true; session.cancelled = false; this.emit('session.execution.started', { sessionID: id }, true); void this.drain(id); }
      if (this.ambiguous.delete(path)) return Response.json({});
      return Response.json({ data: input });
    }
    if (sub === '/interrupt' && method === 'POST') {
      const interrupted = session.busy;
      if (interrupted) {
        session.cancelled = true; this.aborted.get(id)?.();
        for (const ask of this.pending.values()) if (ask.sessionID === id) ask.settle(undefined);
      }
      return Response.json({ interrupted });
    }
    const reply = /^\/(permission|form)\/([^/]+)(\/reply)?$/.exec(sub);
    if (reply) {
      const ask = this.pending.get(reply[2]!);
      if (!ask || ask.sessionID !== id) return Response.json({ _tag: 'NotFoundError' }, { status: 404 });
      const answer = reply[1] === 'permission' ? body?.decision : method === 'DELETE' ? undefined : body?.answer;
      this.record({ kind: 'permission-reply', id: ask.id, reply: answer });
      ask.settle(answer);
      return reply[1] === 'form' && method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ data: { id: ask.id } });
    }
    return Response.json({ _tag: 'NotFoundError' }, { status: 404 });
  }

  private async ask(sessionID: string, kind: 'permission' | 'form'): Promise<unknown> {
    const id = this.id(kind === 'permission' ? 'per' : 'frm');
    const value = kind === 'permission'
      ? { id, sessionID, action: 'shell', resources: ['printf fixture'], save: ['printf *'], source: { type: 'tool', messageID: this.id('msg'), id: this.id('call') } }
      : { id, sessionID, title: 'Questions', fields: this.formFields ?? [{ key: 'q0', type: 'string', title: 'Choice', description: 'Choose an option', options: [{ value: 'Proceed', label: 'Proceed' }, { value: 'Stop', label: 'Stop' }], custom: true }] };
    let settle!: (answer: unknown) => void;
    const promise = new Promise<unknown>((resolve) => { settle = resolve; });
    this.pending.set(id, { id, sessionID, kind, value, settle });
    this.emit(kind === 'permission' ? 'permission.asked' : 'form.created', kind === 'permission' ? value : { form: value });
    const answer = await promise;
    this.pending.delete(id);
    this.emit(kind === 'permission' ? 'permission.replied' : answer === undefined ? 'form.cancelled' : 'form.replied', kind === 'permission' ? { sessionID, requestID: id, reply: answer } : { sessionID, id, answer });
    return answer;
  }

  private async drain(id: string): Promise<void> {
    const session = this.session(id);
    let outcome = 'succeeded';
    while (session.inbox.length) {
      const index = session.inbox.findIndex((input) => input.delivery === 'steer');
      const input = session.inbox.splice(index < 0 ? 0 : index, 1)[0]!;
      const text = input.payload.text as string;
      const visible = text.replace(/\[\[(?:hold:[^\]]+|permission|question|error)\]\]\s*/g, '');
      session.messages.push({ id: input.id, time: input.time, type: 'user', text });
      this.emit('session.inbox.delivered', { sessionID: id, inboxID: input.id }, true);
      const assistant = { id: this.id('msg'), type: 'assistant', agent: session.info.agent, model: session.info.model, time: { created: this.now(), completed: undefined as number | undefined }, content: [] as Json[], tokens: { input: 8, output: 4, cache: { read: 0, write: 0 } }, cost: 0, finish: 'stop' };
      session.messages.push(assistant);
      let abort!: () => void;
      const cancelled = new Promise<'cancelled'>((resolve) => { abort = () => resolve('cancelled'); });
      this.aborted.set(id, abort);
      let permission: unknown;
      if (text.includes('[[permission]]')) permission = await Promise.race([this.ask(id, 'permission'), cancelled]);
      if (text.includes('[[question]]')) await Promise.race([this.ask(id, 'form'), cancelled]);
      const tag = /\[\[hold:([^\]]+)\]\]/.exec(text)?.[1];
      if (tag && !session.cancelled) await Promise.race([new Promise<void>((resolve) => this.holds.set(tag, resolve)), cancelled]);
      if (session.cancelled) { outcome = 'interrupted'; session.inbox = []; this.record({ kind: 'turn-aborted', sessionId: id, text }); break; }
      if (text.includes('[[error]]')) { outcome = 'failed'; this.record({ kind: 'turn-end', sessionId: id, text }); break; }
      const answer = `answer: ${visible}${permission ? ` permission ${String(permission)}` : ''}`;
      assistant.content.push({ type: 'text', text: answer }); assistant.time.completed = this.now();
      this.emit('session.text.started', { sessionID: id, assistantMessageID: assistant.id, ordinal: 0 }, true);
      this.emit('session.text.delta', { sessionID: id, assistantMessageID: assistant.id, ordinal: 0, delta: answer });
      this.emit('session.text.ended', { sessionID: id, assistantMessageID: assistant.id, ordinal: 0, text: answer }, true);
      session.info.time.updated = this.now();
      this.record({ kind: 'turn-end', sessionId: id, text });
    }
    session.busy = false;
    session.messages.push({ id: this.id('msg'), type: 'idle', time: { created: this.now() }, outcome });
    session.info.time.updated = this.now();
    this.aborted.delete(id);
    this.emit(`session.execution.${outcome}`, { sessionID: id }, true);
  }
}
