import { ControlRefusedError, type AgentMessage, type AgentMessageHandler, type CommandResult, type HistoryQuery, type HistorySourceIdentity, type PermissionDecision, type PromptInput, type SessionConnection, type SessionInfo, type Unsubscribe } from '@cosyncing/adapter-api';
import type { V2Binding } from '../binding.ts';
import type { OpenCodeV2Backend } from './backend.ts';
import { arrayData, contentKey, finite, formAnswer, formCard, historyRows, messageRows, nativeId, newNativeId, object, permissionCard, runSummary, toolMessages, type Native } from './mapping.ts';
import { V2Error, type V2Event } from './transport.ts';

/** A V1 history seat switches source when the shared service imports that same native ID. */
export function followV2Import(backend: OpenCodeV2Backend, legacy: SessionConnection, observe: boolean): SessionConnection {
  const info = legacy.info;
  const handlers = new Set<AgentMessageHandler>();
  let current = legacy;
  let closed = false;
  let imported = false;
  let upgrading: Promise<void> | undefined;
  const emit = (message: AgentMessage) => {
    if (closed) return;
    Object.assign(info, current.info);
    for (const handler of handlers) handler(message);
  };
  let unsubscribe = current.subscribe(emit);
  const stopWatching = backend.watchImport(info.id, () => {
    if (closed || imported || upgrading) return;
    upgrading = (async () => {
      const replacement = await backend.attach(info.id, observe);
      if (closed) { await replacement.close(); return; }
      const previous = current;
      unsubscribe();
      current = replacement;
      imported = true;
      stopWatching();
      Object.assign(info, replacement.info);
      unsubscribe = replacement.subscribe(emit);
      await previous.close();
      emit({ type: 'metadata-update', key: 'sessionInfo', value: { ...info } });
      emit({ type: 'history-reset' });
    })().catch(() => { /* Retry after the next authoritative service snapshot. */ }).finally(() => { upgrading = undefined; });
  });
  return {
    info, historyUsesToolSlots: true,
    subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async getHistory(query) { await upgrading; return current.getHistory(query); },
    async getHistorySourceIdentity() { await upgrading; return current.getHistorySourceIdentity?.(); },
    async getPending() { await upgrading; return current.getPending?.() ?? []; },
    async sendPrompt(input) { await upgrading; return current.sendPrompt(input); },
    async respondPermission(id, decision) { await upgrading; return current.respondPermission(id, decision); },
    async answerQuestion(id, answers) { await upgrading; if (!current.answerQuestion) throw new ControlRefusedError('This form is read-only.', 'command-unsupported'); return current.answerQuestion(id, answers); },
    async rejectQuestion(id) { await upgrading; if (!current.rejectQuestion) throw new ControlRefusedError('This form is read-only.', 'command-unsupported'); return current.rejectQuestion(id); },
    async listModels() { await upgrading; return current.listModels?.() ?? []; },
    async listAgents() { await upgrading; return current.listAgents?.() ?? []; },
    async setAgent(agent) { await upgrading; if (!current.setAgent) throw new ControlRefusedError('This session is read-only.', 'command-unsupported'); return current.setAgent(agent); },
    async listCommands() { await upgrading; return current.listCommands?.() ?? []; },
    async runCommand(name, args, input) { await upgrading; if (!current.runCommand) throw new ControlRefusedError('This session is read-only.', 'command-unsupported'); return current.runCommand(name, args, input); },
    async close() { closed = true; stopWatching(); unsubscribe(); handlers.clear(); await current.close(); },
  };
}

/** Keep the broker subscription while replacing an immutable native binding after a restart. */
export class OpenCodeV2Connection implements SessionConnection {
  readonly historyUsesToolSlots = true;
  private current: BoundV2Connection;
  private readonly handlers = new Set<AgentMessageHandler>();
  private unsubscribe: Unsubscribe;
  private retired = false;
  private closed = false;

  constructor(readonly backend: OpenCodeV2Backend, readonly info: SessionInfo, binding: V2Binding, private readonly observe: boolean) {
    this.current = new BoundV2Connection(backend, info, binding, observe);
    this.unsubscribe = this.current.subscribe((message) => this.emit(message));
  }
  private emit(message: AgentMessage): void { if (!this.closed) for (const handler of this.handlers) handler(message); }
  subscribe(handler: AgentMessageHandler): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  updateInfo(native?: Native): void { this.current.updateInfo(native); }
  syncPending(): void { this.current.syncPending(); }
  onEvent(event: V2Event): void { this.current.onEvent(event); }
  onGap(identityChanged: boolean): void {
    this.current.onGap(identityChanged);
    if (identityChanged) { this.retired = true; void this.current.close(); }
  }
  async resnapshot(): Promise<void> {
    if (this.closed) return;
    const replaced = this.retired;
    if (replaced) {
      this.unsubscribe();
      this.current = new BoundV2Connection(this.backend, this.info, this.backend.binding!, this.observe);
      this.unsubscribe = this.current.subscribe((message) => this.emit(message));
      this.retired = false;
    }
    await this.current.resnapshot();
    if (replaced) this.emit({ type: 'history-reset' });
  }
  getHistory(query?: HistoryQuery) { return this.current.getHistory(query); }
  getHistorySourceIdentity() { return this.current.getHistorySourceIdentity(); }
  getPending() { return this.current.getPending(); }
  sendPrompt(input: PromptInput) { return this.current.sendPrompt(input); }
  listModels() { return this.current.listModels(); }
  listAgents() { return this.current.listAgents(); }
  setAgent(agent: string) { return this.current.setAgent(agent); }
  respondPermission(id: string, decision: PermissionDecision) { return this.current.respondPermission(id, decision); }
  answerQuestion(id: string, answers: string[][]) { return this.current.answerQuestion(id, answers); }
  rejectQuestion(id: string) { return this.current.rejectQuestion(id); }
  listCommands() { return this.current.listCommands(); }
  runCommand(name: string) { return this.current.runCommand(name); }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); this.handlers.clear();
    this.backend.connections.delete(this);
    await this.current.close();
  }
}

class BoundV2Connection implements SessionConnection {
  readonly historyUsesToolSlots = true;
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly ended = new Set<string>();
  private readonly tools = new Map<string, Native>();
  private readonly inbox = new Map<string, Native>();
  private readonly heldPending = new Map<string, AgentMessage>();
  private readonly terminalRuns = new Set<string>();
  private buffered: V2Event[] = [];
  private bufferedBytes = 0;
  private ready = false;
  private closed = false;
  private loading?: Promise<void>;
  private reloadNeeded = false;
  private hasSnapshot = false;
  private lastEnqueued?: string;
  private run?: { key: string; startedAt?: number };

  constructor(readonly backend: OpenCodeV2Backend, readonly info: SessionInfo, private readonly binding: V2Binding, private readonly observe: boolean) {
    this.updateInfo();
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  private emit(message: AgentMessage): void { if (!this.closed) for (const handler of this.handlers) handler(message); }

  updateInfo(native = this.backend.sessions.get(this.info.id)): void {
    if (native) Object.assign(this.info, this.backend.info(native));
    this.info.status = this.backend.status(this.info.id);
    if (this.observe) {
      this.info.attachMode = 'observe';
      this.info.control = { drive: native?.parentID ? { supported: false, state: 'observing', reason: 'This session is controlled by its parent agent.' } : { supported: true, state: 'observing' }, terminalSync: { supported: false, syncAvailable: false, active: false } };
    }
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { ...this.info } });
    this.emit({ type: 'status', status: this.info.status === 'idle' ? 'idle' : 'running' });
  }

  onGap(identityChanged: boolean): void {
    this.ready = false;
    if (identityChanged) {
      this.info.control = { drive: { supported: true, state: 'unavailable', reason: 'The OpenCode service changed; reconnecting.' }, terminalSync: { supported: false, syncAvailable: false, active: false } };
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { ...this.info } });
    }
  }

  async resnapshot(): Promise<void> {
    if (this.closed) return;
    this.reloadNeeded = true;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      while (this.reloadNeeded && !this.closed) {
        this.reloadNeeded = false;
        this.ready = false;
        const binding = this.backend.binding!;
        const [native, messages] = await Promise.all([this.backend.getSession(this.info.id), this.backend.history(this.info.id), this.backend.pending(this.info.id)]);
        if (this.closed) return;
        if (binding !== this.backend.binding) { this.reloadNeeded = true; continue; }
        if (binding.identity !== this.binding.identity || binding.auth !== this.binding.auth) throw new V2Error('unavailable');
        this.updateInfo(native);
        this.tools.clear();
        for (const message of messages) if (message.type === 'assistant' && Array.isArray(message.content)) {
          message.content.forEach((part: Native, ordinal: number) => {
            if (!object(part)) return;
            if (['text', 'reasoning'].includes(part.type) && finite(message.time?.completed)) this.ended.add(contentKey(message.id, ordinal));
            if (part.type === 'tool' && typeof part.id === 'string' && !['completed', 'error'].includes(part.state?.status) && this.tools.size < 512) this.tools.set(part.id, part);
          });
        }
        while (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value!);
        const lastIdle = messages.findLastIndex((message) => message.type === 'idle');
        const firstUser = messages.slice(lastIdle + 1).find((message) => message.type === 'user');
        if (firstUser && this.backend.active.has(this.info.id)) this.run = { key: firstUser.id, startedAt: firstUser.time?.created };
        this.ready = true;
        this.syncPending();
        if (this.hasSnapshot) this.emit({ type: 'history-reset' });
        this.hasSnapshot = true;
        const buffered = this.buffered;
        this.buffered = []; this.bufferedBytes = 0;
        // Snapshot rows already include volatile text observed while the read was in flight.
        // Durable ended blocks replace those rows; replaying deltas would append the same bytes twice.
        for (const event of buffered) if (!event.type.endsWith('.delta')) this.apply(event);
      }
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  async getHistory(query?: HistoryQuery): Promise<AgentMessage[]> {
    const native = await this.backend.getSession(this.info.id);
    const messages = await this.backend.history(this.info.id, query?.signal);
    this.updateInfo(native);
    return historyRows(messages, this.backend.clientKeys);
  }

  async getHistorySourceIdentity(): Promise<HistorySourceIdentity> {
    const native = await this.backend.getSession(this.info.id);
    return { sourceId: `opencode-v2:${this.info.id}`, revision: JSON.stringify([native.time.updated, native.revert]), rewriteToken: JSON.stringify(native.revert ?? null) };
  }

  syncPending(): void {
    if (!this.ready) return;
    const next = new Map<string, AgentMessage>();
    for (const permission of this.backend.permissions.get(this.info.id) ?? []) next.set(permission.id, permissionCard(permission));
    for (const form of this.backend.forms.get(this.info.id) ?? []) next.set(form.id, formCard(form));
    for (const [id, before] of this.heldPending) if (!next.has(id)) this.emit(before.type === 'permission-request'
      ? { type: 'permission-resolved', requestId: id, decision: 'external' }
      : { type: 'question-resolved', requestId: id });
    for (const [id, message] of next) if (JSON.stringify(this.heldPending.get(id)) !== JSON.stringify(message)) this.emit(message);
    this.heldPending.clear();
    for (const [id, message] of next) this.heldPending.set(id, message);
  }

  getPending(): AgentMessage[] {
    return [
      ...(this.backend.permissions.get(this.info.id) ?? []).map(permissionCard),
      ...(this.backend.forms.get(this.info.id) ?? []).map(formCard),
    ];
  }

  onEvent(event: V2Event): void {
    const data = event.data;
    if ((data.sessionID ?? data.form?.sessionID ?? data.session?.id) !== this.info.id) return;
    if (!this.ready) {
      this.bufferedBytes += JSON.stringify(event).length;
      if (this.buffered.length >= 512 || this.bufferedBytes > 2 * 1024 * 1024) {
        this.buffered = []; this.bufferedBytes = 0;
        void this.resnapshot().catch(() => {});
      } else this.buffered.push(event);
      return;
    }
    this.apply(event);
  }

  private apply(event: V2Event): void {
    const data = event.data;
    if (event.type === 'session.inbox.enqueued' && nativeId(data.inboxID, 'msg_') && data.item?.type === 'user' && typeof data.item.payload?.text === 'string') {
      const user = { id: data.inboxID, type: 'user', time: { created: event.created }, text: data.item.payload.text };
      this.inbox.set(user.id, user);
      if (!this.run) this.lastEnqueued = user.id;
      for (const row of messageRows(user, this.backend.clientKeys)) this.emit({ ...row, ...(row.type === 'user-message' ? { queued: true } : {}) });
    } else if (event.type === 'session.inbox.delivered' && nativeId(data.inboxID, 'msg_')) {
      const user = this.inbox.get(data.inboxID);
      this.inbox.delete(data.inboxID);
      if (user) for (const row of messageRows(user, this.backend.clientKeys)) this.emit(row);
      else void this.backend.transport!.json(this.path(`/message/${encodeURIComponent(data.inboxID)}`)).then((value) => {
        if (this.binding !== this.backend.binding || !object(value?.data)) return;
        for (const row of messageRows(value.data, this.backend.clientKeys)) this.emit(row);
      }).catch(() => {});
    } else if (event.type === 'session.execution.started') {
      this.run = { key: this.lastEnqueued ?? `execution:${event.durable?.seq ?? event.created}`, startedAt: event.created };
      this.emit(runSummary(this.run.key, 'running', this.run.startedAt));
    } else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
      const run = this.run ?? { key: this.lastEnqueued ?? `execution:${event.durable?.seq ?? event.created}`, startedAt: undefined };
      this.run = undefined;
      if (!this.terminalRuns.has(run.key)) {
        this.terminalRuns.add(run.key);
        if (this.terminalRuns.size > 128) this.terminalRuns.delete(this.terminalRuns.values().next().value!);
        const status = event.type.endsWith('succeeded') ? 'done' : event.type.endsWith('interrupted') ? 'cancelled' : 'error';
        void this.backend.history(this.info.id).then((messages) => {
          const start = messages.findIndex((message) => message.id === run.key);
          const end = messages.findIndex((message, index) => index > start && message.type === 'idle' && (message.time?.created ?? Infinity) <= (event.created ?? Infinity));
          const assistant = start < 0 ? undefined : messages.slice(start, end < 0 ? undefined : end).findLast((message) => message.type === 'assistant');
          this.emit(runSummary(run.key, status, run.startedAt, event.created, assistant));
        }).catch(() => this.emit(runSummary(run.key, status, run.startedAt, event.created)));
      }
    } else if (/^session\.(text|reasoning)\.(delta|ended)$/.test(event.type)) {
      if (!nativeId(data.assistantMessageID, 'msg_') || !Number.isSafeInteger(data.ordinal) || data.ordinal < 0) return;
      const key = contentKey(data.assistantMessageID, data.ordinal);
      const type = event.type.includes('.reasoning.') ? 'thinking' as const : 'model-output' as const;
      if (event.type.endsWith('.ended') && typeof data.text === 'string') {
        this.ended.add(key);
        if (this.ended.size > 4096) this.ended.delete(this.ended.values().next().value!);
        this.emit({ type, key, text: data.text, ...(type === 'model-output' ? { final: true } : {}) });
      } else if (!this.ended.has(key) && typeof data.delta === 'string') this.emit({ type, key, delta: data.delta });
    } else if (event.type === 'session.tool.input.started' && typeof data.id === 'string' && typeof data.name === 'string') {
      this.tools.set(data.id, { id: data.id, name: data.name, state: { status: 'pending' } });
      if (this.tools.size > 512) this.tools.delete(this.tools.keys().next().value!);
    } else if (event.type === 'session.tool.called' && typeof data.id === 'string') {
      const tool = this.tools.get(data.id);
      if (!tool) return;
      tool.state = { status: 'running', input: data.input };
      for (const row of toolMessages(tool)) this.emit(row);
    } else if ((event.type === 'session.tool.success' || event.type === 'session.tool.failed') && typeof data.id === 'string') {
      const tool = this.tools.get(data.id);
      if (!tool) return;
      tool.state = { ...tool.state, status: event.type.endsWith('success') ? 'completed' : 'error', content: data.content, metadata: data.metadata, error: data.error?.message };
      const result = toolMessages(tool)[1];
      if (result) this.emit(result);
      this.tools.delete(data.id);
    } else if (event.type === 'session.status' && data.status?.type === 'retry') {
      const text = typeof data.status.message === 'string' ? data.status.message : 'Retrying…';
      const detail = [...text.replace(/\p{Cc}/gu, ' ').trim()].slice(0, 240).join('');
      this.emit({ type: 'status', status: 'running', detail });
    } else if (['permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled'].includes(event.type)) this.syncPending();
  }

  private path(suffix: string): string { return `/api/session/${encodeURIComponent(this.info.id)}${suffix}`; }
  private assertMutable(): void {
    if (this.closed || this.observe || !this.ready) throw new ControlRefusedError('This OpenCode connection is read-only or reconnecting.', 'command-unsupported');
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertMutable();
    if (input.files?.length || input.images?.length) throw new ControlRefusedError('File input is not available for this connection.', 'command-unsupported');
    if (input.agent && input.agent !== this.info.currentAgent) await this.setAgent(input.agent);
    if (input.model) {
      const models = await this.listModels();
      if (!models.some((model) => model.providerID === input.model!.providerID && model.modelID === input.model!.modelID)) throw new Error('Choose an available OpenCode model.');
      await this.backend.write(this.binding, this.path('/model'), { model: { providerID: input.model.providerID, id: input.model.modelID, ...(input.model.variant || input.model.reasoningEffort ? { variant: input.model.variant ?? input.model.reasoningEffort } : {}) } });
      this.updateInfo(await this.backend.getSession(this.info.id));
    }
    const id = newNativeId('msg');
    if (input.clientMessageId) {
      this.backend.clientKeys.set(id, input.clientMessageId);
      if (this.backend.clientKeys.size > 4096) this.backend.clientKeys.delete(this.backend.clientKeys.keys().next().value!);
    }
    try {
      const result = await this.backend.write(this.binding, this.path('/prompt'), { id, text: input.text, delivery: 'steer' });
      if (!object(result?.data) || result.data.id !== id) throw new V2Error('invalid-response', true);
    } catch (error) {
      if (!(error instanceof V2Error) || !error.ambiguous) { this.backend.clientKeys.delete(id); throw error; }
      const [inbox, message] = await Promise.allSettled([
        this.backend.transport!.json(this.path('/inbox')),
        this.backend.transport!.json(this.path(`/message/${encodeURIComponent(id)}`)),
      ]);
      if (inbox.status === 'fulfilled' && arrayData(inbox.value).some((item) => item.id === id)) return;
      if (message.status === 'fulfilled' && message.value?.data?.id === id) return;
      throw new Error('OpenCode prompt delivery is unknown. It was not resent; refresh the session before trying again.');
    }
  }

  async listModels() { return this.backend.listModels(this.info.currentModel); }
  async listAgents() { return this.backend.listAgents(); }
  async setAgent(agent: string): Promise<void> {
    this.assertMutable();
    if (!(await this.listAgents()).some((item) => item.name === agent)) throw new Error('Choose an available OpenCode agent.');
    await this.backend.write(this.binding, this.path('/agent'), { agent });
    this.updateInfo(await this.backend.getSession(this.info.id));
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.assertMutable();
    const request = this.backend.permissions.get(this.info.id)?.find((item) => item.id === requestId);
    if (!request) throw new ControlRefusedError('This permission is no longer pending.', 'request-not-pending');
    const reply = decision === 'approve' ? 'once' : decision === 'approve-session' || decision === 'approve-rule' ? 'always' : 'reject';
    await this.reply(this.path(`/permission/${encodeURIComponent(requestId)}/reply`), { decision: reply });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.assertMutable();
    const form = this.backend.forms.get(this.info.id)?.find((item) => item.id === requestId);
    if (!form) throw new ControlRefusedError('This form is no longer pending.', 'request-not-pending');
    await this.reply(this.path(`/form/${encodeURIComponent(requestId)}/reply`), { answer: formAnswer(form, answers) });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    this.assertMutable();
    const form = this.backend.forms.get(this.info.id)?.find((item) => item.id === requestId);
    if (!form) throw new ControlRefusedError('This form is no longer pending.', 'request-not-pending');
    if (formCard(form).readOnly) throw new ControlRefusedError('Answer this form in the OpenCode terminal.', 'command-unsupported');
    await this.reply(this.path(`/form/${encodeURIComponent(requestId)}`), undefined, 'DELETE');
  }

  private async reply(path: string, body?: unknown, method = 'POST'): Promise<void> {
    try { await this.backend.write(this.binding, path, body, method); }
    catch (error) {
      if (error instanceof V2Error && (error.reason === 'not-found' || error.reason === 'conflict')) {
        await this.backend.pending(this.info.id);
        throw new ControlRefusedError('This request was already resolved.', 'request-not-pending');
      }
      throw error;
    }
    await this.backend.pending(this.info.id);
  }

  async listCommands() { return [{ name: 'stop', description: 'Interrupt the current turn', kind: 'action' as const }]; }
  async runCommand(name: string): Promise<CommandResult | void> {
    this.assertMutable();
    if (name !== 'stop') throw new ControlRefusedError('This command is not supported.', 'command-unsupported');
    const response = await this.backend.write(this.binding, this.path('/interrupt'));
    if (typeof response?.interrupted !== 'boolean') throw new V2Error('invalid-response');
    if (!response.interrupted) return { notice: 'Nothing is running.' };
  }

  async close(): Promise<void> { this.closed = true; this.ready = false; this.handlers.clear(); }
}
