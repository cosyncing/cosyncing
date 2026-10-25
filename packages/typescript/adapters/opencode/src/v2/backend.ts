import { ControlRefusedError, SessionCreateTemporarilyUnavailableError, SessionNotFoundError, type AgentOption, type ModelOption, type PromptInput, type SessionDiscoveryOptions, type SessionInfo, type Unsubscribe } from '@cosyncing/adapter-api';
import type { BindingResolver, V2Binding } from '../binding.ts';
import { OpenCodeV2Connection } from './connection.ts';
import { arrayData, formCard, isSession, modelsFrom, nativeId, newNativeId, object, permissionCard, sessionInfo, type Native } from './mapping.ts';
import { V2Error, V2Transport, type V2Event } from './transport.ts';

export interface LegacySession { id: string; title?: string; directory?: string; time?: { created?: number; updated?: number }; model?: { providerID?: string; id?: string; modelID?: string }; }
export interface V2BackendOptions {
  sseIdleMs: number;
  sseReconnectMs: number;
  legacySessions: (options?: SessionDiscoveryOptions) => LegacySession[];
}

/** One event subscription and activity projection for the complete shared service. */
export class OpenCodeV2Backend {
  binding?: V2Binding;
  transport?: V2Transport;
  readonly sessions = new Map<string, Native>();
  readonly active = new Set<string>();
  readonly permissions = new Map<string, Native[]>();
  readonly forms = new Map<string, Native[]>();
  readonly clientKeys = new Map<string, string>();
  readonly connections = new Set<OpenCodeV2Connection>();
  readonly watchers = new Set<(info: SessionInfo) => void>();
  private readonly importWatchers = new Map<string, Set<() => void>>();
  private readonly revisions = new Map<string, number>();
  private readonly sequences = new Map<string, number>();
  private streamAbort?: AbortController;
  private streamReady?: Promise<void>;
  private streamEpoch = 0;
  private revision = 0;
  private connected = false;
  private gap = true;
  unknownEvents = 0;
  unknownMessages = 0;

  constructor(readonly resolver: BindingResolver, private readonly options: V2BackendOptions) {}

  useBinding(binding: V2Binding): void {
    if (this.binding?.identity === binding.identity && this.binding.auth === binding.auth) return;
    const hadBinding = !!this.binding;
    this.streamAbort?.abort();
    this.streamEpoch++;
    this.binding = binding;
    this.transport = new V2Transport(binding.baseUrl, binding.auth);
    this.connected = false;
    this.gap = true;
    this.streamReady = undefined;
    this.sequences.clear();
    if (hadBinding) for (const connection of this.connections) connection.onGap(true);
  }

  status(id: string): SessionInfo['status'] {
    return (this.permissions.get(id)?.length || this.forms.get(id)?.length) ? 'needs-input' : this.active.has(id) ? 'working' : 'idle';
  }

  anyBusy(): boolean { return this.active.size > 0 || [...this.permissions.values(), ...this.forms.values()].some((list) => list.length > 0); }
  watch(listener: (info: SessionInfo) => void): Unsubscribe { this.watchers.add(listener); return () => this.watchers.delete(listener); }
  watchImport(id: string, listener: () => void): Unsubscribe {
    const listeners = this.importWatchers.get(id) ?? new Set<() => void>();
    listeners.add(listener); this.importWatchers.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.importWatchers.delete(id); };
  }

  info(value: Native): SessionInfo { return sessionInfo(value, this.status(value.id)); }

  private changed(id: string): void {
    this.revisions.set(id, ++this.revision);
    const native = this.sessions.get(id);
    if (native) for (const listener of this.watchers) listener(this.info(native));
    for (const connection of this.connections) if (connection.info.id === id) connection.updateInfo(native);
  }

  async ensureStarted(): Promise<void> {
    if (!this.transport) throw new V2Error('unavailable');
    if (!this.streamReady) {
      const abort = new AbortController();
      this.streamAbort = abort;
      const epoch = this.streamEpoch;
      let opened!: () => void;
      this.streamReady = new Promise<void>((resolve) => { opened = resolve; });
      void this.stream(epoch, abort.signal, opened);
    }
    await Promise.race([this.streamReady, new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new V2Error('unavailable')), 4000);
      timeout.unref?.();
      this.streamReady?.finally(() => clearTimeout(timeout)).catch(() => {});
    })]);
  }

  private async stream(epoch: number, signal: AbortSignal, opened: () => void): Promise<void> {
    let first = true;
    while (!signal.aborted && epoch === this.streamEpoch) {
      try {
        if (!first) {
          const next = await this.resolver.resolve(true);
          if (next.generation !== 2) throw new V2Error('unavailable');
          if (next.identity !== this.binding?.identity || next.auth !== this.binding.auth) {
            this.useBinding(next);
            void this.ensureStarted().catch(() => {});
            return;
          }
        }
        const transport = this.transport!;
        for await (const event of transport.events(signal, () => {
          if (epoch !== this.streamEpoch) return;
          this.connected = true;
          opened();
          const reconnecting = [...this.connections];
          if (!first || reconnecting.length > 0) {
            void this.reconcile().then(async () => {
              if (epoch !== this.streamEpoch) return;
              await Promise.all(reconnecting.map((connection) => connection.resnapshot()));
            }).catch(() => {});
          }
        }, this.options.sseIdleMs)) {
          if (epoch !== this.streamEpoch) return;
          this.event(event);
        }
      } catch {
        // A missing stream is never a terminal execution or authoritative idle.
      }
      if (signal.aborted || epoch !== this.streamEpoch) return;
      first = false;
      this.connected = false;
      this.gap = true;
      this.resolver.invalidate();
      for (const connection of this.connections) connection.onGap(false);
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(500, this.options.sseReconnectMs));
        timer.unref?.();
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  private event(event: V2Event): void {
    const data = event.data;
    const id = data.sessionID ?? data.form?.sessionID ?? data.session?.id;
    if (event.durable && nativeId(event.durable.aggregateID, 'ses') && Number.isSafeInteger(event.durable.seq)) {
      const before = this.sequences.get(event.durable.aggregateID);
      if (before !== undefined && event.durable.seq <= before) return;
      this.sequences.set(event.durable.aggregateID, event.durable.seq);
      if (before !== undefined && event.durable.seq !== before + 1) {
        this.gap = true;
        for (const connection of this.connections) connection.onGap(false);
        void this.reconcile().then(() => Promise.all([...this.connections].map((connection) => connection.resnapshot()))).catch(() => {});
      }
    }
    if (nativeId(id, 'ses')) {
      if (event.type === 'session.execution.started') this.active.add(id);
      else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) this.active.delete(id);
      else if (event.type === 'permission.asked') {
        try { permissionCard(data); this.permissions.set(id, [...(this.permissions.get(id) ?? []).filter((item) => item.id !== data.id), data]); } catch { return; }
      } else if (event.type === 'permission.replied') this.permissions.set(id, (this.permissions.get(id) ?? []).filter((item) => item.id !== data.requestID));
      else if (event.type === 'form.created') {
        try { formCard(data.form); this.forms.set(id, [...(this.forms.get(id) ?? []).filter((item) => item.id !== data.form.id), data.form]); } catch { return; }
      } else if (event.type === 'form.replied' || event.type === 'form.cancelled') this.forms.set(id, (this.forms.get(id) ?? []).filter((item) => item.id !== data.id));
      else if (event.type === 'session.status' && data.status?.type === 'retry') this.active.add(id);
      else if (event.type === 'session.step.started') {
        const before = this.sessions.get(id);
        if (before) {
          const next = { ...before, ...(typeof data.agent === 'string' ? { agent: data.agent } : {}), ...(object(data.model) && typeof data.model.providerID === 'string' && typeof data.model.id === 'string' ? { model: data.model } : {}) };
          this.sessions.set(id, next);
        }
      }
      const session = data.session ?? (isSession(data) ? data : undefined);
      if (isSession(session)) this.sessions.set(id, session);
      this.changed(id);
    }
    if (!['server.connected', 'server.heartbeat', 'session.created', 'session.updated', 'session.deleted', 'session.status', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.inbox.enqueued', 'session.inbox.delivered', 'session.text.started', 'session.text.delta', 'session.text.ended', 'session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended', 'session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed', 'permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled'].includes(event.type)) this.unknownEvents++;
    for (const connection of this.connections) connection.onEvent(event);
  }

  async reconcile(signal?: AbortSignal): Promise<void> {
    const revision = this.revision;
    const response = await this.transport!.json('/api/session/active', { signal });
    if (!object(response?.data) || !Object.entries(response.data).every(([id, state]) => nativeId(id, 'ses') && object(state) && typeof state.type === 'string')) throw new V2Error('invalid-response');
    const candidates = new Set([...Object.keys(response.data), ...[...this.permissions, ...this.forms].filter(([, values]) => values.length).map(([id]) => id)]);
    for (const id of new Set([...this.active, ...Object.keys(response.data)])) {
      if ((this.revisions.get(id) ?? 0) > revision) continue;
      if (response.data[id]) this.active.add(id); else this.active.delete(id);
      this.changed(id);
    }
    await Promise.all([...candidates].map((id) => this.pending(id, signal)));
    this.gap = false;
  }

  async pending(id: string, signal?: AbortSignal): Promise<void> {
    const revision = this.revisions.get(id) ?? 0;
    const [permissions, forms] = await Promise.all([
      this.transport!.json(`/api/session/${encodeURIComponent(id)}/permission`, { signal }),
      this.transport!.json(`/api/session/${encodeURIComponent(id)}/form`, { signal }),
    ]);
    const p = arrayData(permissions), f = arrayData(forms);
    for (const item of p) { permissionCard(item); if (item.sessionID !== id) throw new V2Error('invalid-response'); }
    for (const item of f) { formCard(item); if (item.sessionID !== id) throw new V2Error('invalid-response'); }
    if ((this.revisions.get(id) ?? 0) !== revision) return;
    this.permissions.set(id, p); this.forms.set(id, f);
    this.changed(id);
    for (const connection of this.connections) if (connection.info.id === id) connection.syncPending();
  }

  async discover(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    await this.ensureStarted();
    await this.reconcile(options?.signal);
    const migration = await this.transport!.json('/api/experimental/migration/v1', { signal: options?.signal });
    if (!['required', 'running', 'completed', 'error'].includes(migration?.status)) throw new V2Error('invalid-response');
    const rows: SessionInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 50; page++) {
      const value = await this.transport!.json('/api/session?limit=100&archived=false' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), { signal: options?.signal });
      const data = arrayData(value);
      for (const item of data) {
        if (!isSession(item)) continue;
        const before = this.sessions.get(item.id);
        this.sessions.set(item.id, item);
        if (!before || before.time.updated !== item.time.updated) this.changed(item.id);
        for (const listener of this.importWatchers.get(item.id) ?? []) listener();
        const info = this.info(item);
        if (options?.updatedAfter !== undefined && info.status === 'idle' && (info.updatedAt ?? 0) < options.updatedAfter) continue;
        rows.push(info);
      }
      options?.onPartialRows?.(rows);
      cursor = value.cursor?.next;
      if (!data.length || cursor === undefined) { complete = true; break; }
      if (typeof cursor !== 'string') throw new V2Error('invalid-response');
      if (cursors.has(cursor)) throw new V2Error('invalid-response');
      cursors.add(cursor);
    }
    if (!complete) throw new V2Error('unavailable');
    if (migration.status === 'required' || migration.status === 'running') {
      const present = new Set(rows.map((row) => row.id));
      for (const old of this.options.legacySessions(options)) if (!present.has(old.id) && nativeId(old.id, 'ses')) rows.push({
        id: old.id, tool: 'opencode', title: old.title || old.id, cwd: old.directory,
        createdAt: old.time?.created, updatedAt: old.time?.updated, status: 'idle', attachMode: 'observe',
        ...(typeof old.model?.providerID === 'string' && typeof (old.model.id ?? old.model.modelID) === 'string' ? { model: old.model.id ?? old.model.modelID, currentModel: { providerID: old.model.providerID, modelID: (old.model.id ?? old.model.modelID)! } } : {}),
        control: { drive: { supported: false, state: 'observing', reason: 'This session has not yet been imported by OpenCode.' }, terminalSync: { supported: false, syncAvailable: false, active: false } },
      });
    }
    return rows;
  }

  async getSession(id: string): Promise<Native> {
    if (!nativeId(id, 'ses')) throw new SessionNotFoundError('Invalid OpenCode session ID.');
    try {
      const response = await this.transport!.json(`/api/session/${encodeURIComponent(id)}`);
      if (!isSession(response?.data) || response.data.id !== id) throw new V2Error('invalid-response');
      this.sessions.set(id, response.data);
      return response.data;
    } catch (error) {
      if (error instanceof V2Error && error.reason === 'not-found') throw new SessionNotFoundError('OpenCode does not list this session.');
      throw error;
    }
  }

  async history(id: string, signal?: AbortSignal): Promise<Native[]> {
    const pages: Native[][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const deadline = Date.now() + 15_000;
    let bytes = 0;
    for (let page = 0; page < 500 && Date.now() < deadline; page++) {
      const value = await this.transport!.json(`/api/session/${encodeURIComponent(id)}/message?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'), { signal });
      const data = arrayData(value);
      bytes += Buffer.byteLength(JSON.stringify(data));
      if (bytes > 64 * 1024 * 1024) throw new V2Error('invalid-response');
      this.unknownMessages += data.filter((message) => !['user', 'assistant', 'idle'].includes(message.type)).length;
      pages.push([...data].reverse());
      cursor = value.cursor?.next;
      if (!data.length || cursor === undefined) return pages.reverse().flat();
      if (typeof cursor !== 'string') throw new V2Error('invalid-response');
      if (cursors.has(cursor)) throw new V2Error('invalid-response');
      cursors.add(cursor);
    }
    throw new V2Error('unavailable');
  }

  async listModels(current?: SessionInfo['currentModel']): Promise<ModelOption[]> {
    const [models, providers] = await Promise.all([this.transport!.json('/api/model'), this.transport!.json('/api/provider')]);
    return modelsFrom(models, providers, current);
  }

  async listAgents(): Promise<AgentOption[]> {
    return arrayData(await this.transport!.json('/api/agent')).filter((agent) => typeof agent.id === 'string' && agent.hidden !== true && agent.mode !== 'subagent')
      .map((agent) => ({ name: agent.id, ...(typeof agent.description === 'string' ? { description: agent.description } : {}) }));
  }

  async write(binding: V2Binding, path: string, body?: unknown, method = 'POST'): Promise<any> {
    const now = await this.resolver.resolve(true);
    if (now.generation !== 2 || now.identity !== binding.identity || now.auth !== binding.auth) {
      if (now.generation === 2) this.useBinding(now);
      throw new ControlRefusedError('The OpenCode service changed; reconnect before sending.', 'request-not-pending');
    }
    try { return await this.transport!.json(path, { method, body }); }
    catch (error) { this.resolver.invalidate(); throw error; }
  }

  async create(options: { directory?: string; title?: string; model?: PromptInput['model'] }): Promise<SessionInfo> {
    const id = newNativeId('ses');
    try {
      const response = await this.write(this.binding!, '/api/session', { id, ...(options.directory ? { location: { directory: options.directory } } : {}), ...(options.title ? { title: options.title } : {}), ...(options.model ? { model: { providerID: options.model.providerID, id: options.model.modelID, ...(options.model.variant ? { variant: options.model.variant } : {}) } } : {}) });
      if (!isSession(response?.data) || response.data.id !== id) throw new V2Error('invalid-response', true);
      this.sessions.set(id, response.data);
      return this.info(response.data);
    } catch (error) {
      if (error instanceof V2Error && error.ambiguous) {
        try { return this.info(await this.getSession(id)); } catch { throw new Error('OpenCode session creation could not be confirmed. It was not retried.'); }
      }
      if (error instanceof V2Error && error.reason === 'v2-service-starting') throw new SessionCreateTemporarilyUnavailableError('OpenCode is starting; retry when its service is ready.', error.reason);
      throw error;
    }
  }

  async attach(id: string, observe = false): Promise<OpenCodeV2Connection> {
    await this.ensureStarted();
    const native = await this.getSession(id);
    const connection = new OpenCodeV2Connection(this, this.info(native), this.binding!, observe || !!native.parentID);
    this.connections.add(connection);
    try { await connection.resnapshot(); return connection; }
    catch (error) { await connection.close(); throw error; }
  }
}
