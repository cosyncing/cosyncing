import { ControlRefusedError, PRODUCT_IDENTITY, type AgentMessage, type AgentMessageHandler, type CommandResult, type CommandInput, type FileInput, type HistoryQuery, type HistoryResetSemantic, type HistorySourceIdentity, type PermissionDecision, type PromptInput, type SessionConnection, type SessionInfo, type SlashCommand, type Unsubscribe } from '@cosyncing/adapter-api';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OPENCODE_SHARED_ACTIONS } from '../commands.ts';
import type { V2Binding } from '../binding.ts';
import type { OpenCodeV2Backend } from './backend.ts';
import { JOB_POLL_MS, V2JobRows } from './jobs.ts';
import { arrayData, compactAttachments, contentKey, finite, formAnswer, formCard, historyRows, isRunInput, messageRows, nativeId, newNativeId, object, OPENCODE_ARCHIVED_REASON, permissionCard, runSummary, sessionPatch, toolMessages, type Native } from './mapping.ts';
import { MAX_MESSAGE_RESPONSE_BYTES, MESSAGE_READ_BUDGET_MS, V2Error, type V2Event } from './transport.ts';

/** A V1 history seat switches source when the shared service imports that same native ID. */
export function followV2Import(backend: OpenCodeV2Backend, legacy: SessionConnection, observe: boolean): SessionConnection {
  const info = legacy.info;
  const handlers = new Set<AgentMessageHandler>();
  let current = legacy;
  let closed = false;
  let imported = false;
  let upgrading: Promise<void> | undefined;
  let clients: number | undefined;
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
      if (clients !== undefined) replacement.setClientCount?.(clients);
      await previous.close();
      emit({ type: 'metadata-update', key: 'sessionInfo', value: sessionPatch(info) });
      emit({ type: 'history-reset' });
    })().catch(() => { /* Retry after the next authoritative service snapshot. */ }).finally(() => { upgrading = undefined; });
  });
  return {
    info, historyUsesToolSlots: true,
    subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    setClientCount(count) { clients = count; current.setClientCount?.(count); },
    async getHistory(query) { await upgrading; return current.getHistory(query); },
    async getHistoryOverlays(query) { await upgrading; return current.getHistoryOverlays?.(query) ?? []; },
    async getHistorySourceIdentity() { await upgrading; return current.getHistorySourceIdentity?.(); },
    async getPending() { await upgrading; return current.getPending?.() ?? []; },
    async sendPrompt(input) { await upgrading; return current.sendPrompt(input); },
    async sendFile(file) { await upgrading; return current.sendPrompt({ text: '', files: [file] }); },
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
  private clients?: number;

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
      const previous = this.current;
      this.unsubscribe();
      this.current = new BoundV2Connection(this.backend, this.info, this.backend.binding!, this.observe);
      this.current.adoptJobs(previous);
      this.unsubscribe = this.current.subscribe((message) => this.emit(message));
      if (this.clients !== undefined) this.current.setClientCount(this.clients);
      this.retired = false;
    }
    await this.current.resnapshot();
    if (replaced) {
      this.emit({ type: 'metadata-update', key: 'sessionInfo', value: sessionPatch(this.info) });
      this.emit({ type: 'history-reset' });
    }
  }
  setClientCount(count: number): void { this.clients = count; this.current.setClientCount(count); }
  getHistory(query?: HistoryQuery) { return this.current.getHistory(query); }
  getHistoryOverlays() { return this.current.getHistoryOverlays(); }
  getHistorySourceIdentity() { return this.current.getHistorySourceIdentity(); }
  getPending() { return this.current.getPending(); }
  sendPrompt(input: PromptInput) { return this.current.sendPrompt(input); }
  sendFile(file: FileInput) { return this.current.sendPrompt({ text: '', files: [file] }); }
  listModels() { return this.current.listModels(); }
  listAgents() { return this.current.listAgents(); }
  setAgent(agent: string) { return this.current.setAgent(agent); }
  respondPermission(id: string, decision: PermissionDecision) { return this.current.respondPermission(id, decision); }
  answerQuestion(id: string, answers: string[][]) { return this.current.answerQuestion(id, answers); }
  rejectQuestion(id: string) { return this.current.rejectQuestion(id); }
  listCommands() { return this.current.listCommands(); }
  runCommand(name: string, args?: string, input?: CommandInput) { return this.current.runCommand(name, args, input); }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); this.handlers.clear();
    this.backend.releaseConnection(this);
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
  private reloadNotice?: { notice: string; semantic: HistoryResetSemantic };
  private hasSnapshot = false;
  private published: Partial<SessionInfo> = {};
  private publishedStatus?: string;
  private run?: { key: string; startedAt?: number; user: boolean };
  /** Background jobs this session started, as background rows. */
  private readonly jobs: V2JobRows;
  private jobTimer?: ReturnType<typeof setTimeout>;
  /** Each job list read takes a ticket; only the newest read may apply. */
  private jobReads = 0;
  /** A turn ended while no client was attached, so a job may have started unseen. */
  private jobsUnread = false;
  private clients = 0;

  constructor(readonly backend: OpenCodeV2Backend, readonly info: SessionInfo, private readonly binding: V2Binding, private readonly observe: boolean) {
    this.jobs = new V2JobRows(info.id, (message) => this.emit(message));
    this.updateInfo();
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  private emit(message: AgentMessage): void { if (!this.closed) for (const handler of this.handlers) handler(message); }

  updateInfo(native = this.backend.sessions.get(this.info.id)): void {
    if (native) Object.assign(this.info, this.backend.info(native));
    this.info.status = this.backend.status(this.info.id);
    if (this.observe) {
      this.info.attachMode = 'observe';
      this.info.control = { drive: native?.parentID ? { supported: false, state: 'observing', reason: 'This session is controlled by its parent agent.' }
        : this.backend.archived.has(this.info.id) ? { supported: false, state: 'observing', reason: OPENCODE_ARCHIVED_REASON }
          : { supported: true, state: 'observing' }, terminalSync: this.info.control!.terminalSync };
    }
    this.publishInfo();
  }

  private publishInfo(): void {
    const next = sessionPatch(this.info);
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(this.published[key as keyof SessionInfo])));
    this.published = structuredClone(next);
    if (Object.keys(changed).length) this.emit({ type: 'metadata-update', key: 'sessionInfo', value: changed });
    const status = this.info.status === 'idle' ? 'idle' : 'running';
    if (status !== this.publishedStatus) {
      this.publishedStatus = status;
      this.emit({ type: 'status', status });
      // OpenCode 2.3+ runs subagents in the background: the parent reads idle while they work.
      if (status === 'idle') this.jobs.restateAfterIdle();
    }
  }

  adoptJobs(previous: BoundV2Connection): void { this.jobs.adopt(previous.jobs); }

  setClientCount(count: number): void {
    this.clients = count;
    if (count > 0 && (this.jobs.size || this.jobsUnread)) this.scheduleJobRead(0);
    else if (count <= 0) { clearTimeout(this.jobTimer); this.jobTimer = undefined; }
  }

  /**
   * A service with a job list but no job events (2.2.6 to 2.3.x) is asked again: once a turn of
   * this session ends (a job starts only inside one), then every {@link JOB_POLL_MS} while one of
   * its jobs runs and a client is attached. 2.4.0+ reports every change as an event instead.
   */
  private scheduleJobRead(delayMs: number): void {
    clearTimeout(this.jobTimer);
    this.jobTimer = undefined;
    const support = this.backend.jobSupport();
    if (this.closed || !support.list || support.events) return;
    if (this.clients <= 0) { this.jobsUnread = true; return; }
    this.jobTimer = setTimeout(() => { this.jobTimer = undefined; void this.readJobs(); }, delayMs);
    this.jobTimer.unref?.();
  }

  private async readJobs(): Promise<void> {
    const ticket = ++this.jobReads;
    const jobs = await this.backend.jobs(this.info.id).catch(() => undefined);
    if (this.closed || ticket !== this.jobReads || this.binding !== this.backend.binding) return;
    if (jobs) { this.jobsUnread = false; this.jobs.snapshot(jobs); }
    if (this.jobs.size) this.scheduleJobRead(JOB_POLL_MS);
  }

  onGap(identityChanged: boolean): void {
    this.ready = false;
    if (identityChanged) {
      this.info.control = { drive: { supported: true, state: 'unavailable', reason: 'The OpenCode service changed; reconnecting.' }, terminalSync: { supported: false, syncAvailable: false, active: false } };
      this.publishInfo();
    }
  }

  async resnapshot(notice?: { notice: string; semantic: HistoryResetSemantic }): Promise<void> {
    if (this.closed) return;
    if (notice) this.reloadNotice = notice;
    this.reloadNeeded = true;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      while (this.reloadNeeded && !this.closed) {
        this.reloadNeeded = false;
        const notice = this.reloadNotice;
        this.reloadNotice = undefined;
        this.ready = false;
        const binding = this.backend.binding!;
        const jobRead = ++this.jobReads;
        // The job list is an addition: a service that cannot answer it still attaches.
        const [native, messages, , jobs] = await Promise.all([this.backend.getSession(this.info.id), this.backend.history(this.info.id), this.backend.pending(this.info.id), this.backend.jobs(this.info.id).catch(() => undefined)]);
        if (this.closed) return;
        if (binding !== this.backend.binding) { this.reloadNeeded = true; this.reloadNotice ??= notice; continue; }
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
        const input = messages.slice(lastIdle + 1).find(isRunInput);
        // A run that ended while events were missed must not name the next one.
        if (!this.backend.active.has(this.info.id)) this.run = undefined;
        else if (input) this.run = { key: input.id, startedAt: input.time?.created, user: input.type === 'user' };
        // Queued inputs the snapshot already holds were delivered while events were missed.
        if (this.inbox.size) {
          const delivered = new Set(messages.map((message) => message.id));
          for (const id of [...this.inbox.keys()]) if (delivered.has(id)) this.inbox.delete(id);
        }
        this.ready = true;
        this.syncPending();
        if (this.hasSnapshot) this.emit({ type: 'history-reset', ...notice });
        this.hasSnapshot = true;
        // Job changes that arrived during the read are in the buffer and apply after it. A service
        // without the job list (an older one after a restart) can vouch for no row.
        if (jobRead === this.jobReads && (jobs || !this.backend.jobSupport().list)) { this.jobsUnread = false; this.jobs.snapshot(jobs ?? []); }
        if (this.jobs.size) this.scheduleJobRead(JOB_POLL_MS);
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
    const boundary = messages.findIndex((message) => message.id === native.revert?.messageID);
    return [...historyRows(boundary < 0 ? messages : messages.slice(0, boundary), this.backend.clientKeys), ...this.jobs.cards()];
  }

  /** The background rows that still run and the recent outcomes: current state, outside the transcript. */
  async getHistoryOverlays(): Promise<AgentMessage[]> { return this.jobs.cards(); }

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
    const sessionId = event.type === 'experimental.job.updated' ? data.info?.sessionID : data.sessionID ?? data.form?.sessionID ?? data.session?.id;
    if (sessionId !== this.info.id) return;
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
      const user = { ...data.item.payload, id: data.inboxID, type: 'user', time: { created: event.created } };
      this.inbox.set(user.id, user);
      for (const row of messageRows(user, this.backend.clientKeys)) this.emit({ ...row, ...(row.type === 'user-message' ? { queued: true } : {}) });
    } else if (event.type === 'session.inbox.enqueued' && nativeId(data.inboxID, 'msg_') && data.item?.type === 'synthetic') {
      // OpenCode 2.3 reports a background subagent going idle, or a background shell exiting, as
      // queued synthetic input that starts an execution nobody prompted. It names that run; it is
      // not a user row, so delivery has nothing to fetch or render.
      this.inbox.set(data.inboxID, { id: data.inboxID, type: 'synthetic' });
    } else if (event.type === 'session.inbox.delivered' && nativeId(data.inboxID, 'msg_')) {
      const user = this.inbox.get(data.inboxID);
      this.inbox.delete(data.inboxID);
      if (user) for (const row of messageRows(user, this.backend.clientKeys)) this.emit(row);
      else void this.backend.transport!.json(this.path(`/message/${encodeURIComponent(data.inboxID)}`), { maxBytes: MAX_MESSAGE_RESPONSE_BYTES, timeoutMs: MESSAGE_READ_BUDGET_MS }).then((value) => {
        if (this.binding !== this.backend.binding || !object(value?.data)) return;
        for (const row of messageRows(compactAttachments(value.data), this.backend.clientKeys)) this.emit(row);
      }).catch(() => {});
    } else if (event.type === 'session.execution.started') {
      // An execution starts by delivering the oldest queued input (enqueued, started, then delivered,
      // as captured), which may have been queued behind a run or behind newer input. An input whose
      // run already ended but was never reported delivered does not name another.
      const input = [...this.inbox.values()].find((entry) => entry.id !== this.run?.key && !this.terminalRuns.has(entry.id));
      this.run = { key: input?.id ?? `execution:${event.durable?.seq ?? event.created}`, startedAt: event.created, user: input?.type === 'user' };
      this.emit(runSummary(this.run.key, 'running', this.run.startedAt, undefined, undefined, this.run.user));
    } else if (event.type === 'experimental.job.updated') {
      this.jobs.update(data.info);
    } else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
      // A job outlives the turn that started it, so a turn's end is when one may have appeared.
      this.scheduleJobRead(0);
      const run = this.run ?? { key: `execution:${event.durable?.seq ?? event.created}`, startedAt: undefined, user: false };
      this.run = undefined;
      if (!this.terminalRuns.has(run.key)) {
        this.terminalRuns.add(run.key);
        if (this.terminalRuns.size > 128) this.terminalRuns.delete(this.terminalRuns.values().next().value!);
        const status = event.type.endsWith('succeeded') ? 'done' : event.type.endsWith('interrupted') ? 'cancelled' : 'error';
        void this.backend.history(this.info.id, undefined, { messageId: run.key.startsWith('msg_') ? run.key : undefined, startedAt: run.startedAt }).then((messages) => {
          const start = messages.findIndex((message) => message.id === run.key);
          const end = messages.findIndex((message, index) => index > start && message.type === 'idle' && (run.startedAt === undefined || message.time?.created >= run.startedAt) && (message.time?.created ?? Infinity) <= (event.created ?? Infinity));
          const assistant = messages.slice(Math.max(0, start), end < 0 ? undefined : end).findLast((message) => message.type === 'assistant' && (run.startedAt === undefined || message.time?.created >= run.startedAt) && (event.created === undefined || message.time?.created <= event.created));
          this.emit(runSummary(run.key, status, run.startedAt, event.created, assistant, run.user));
        }).catch(() => this.emit(runSummary(run.key, status, run.startedAt, event.created, undefined, run.user)));
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
    else if (['session.revert.staged', 'session.revert.cleared', 'session.revert.committed'].includes(event.type)) {
      const notice = event.type === 'session.revert.staged' ? 'Reverted to an earlier message — /redo to restore'
        : event.type === 'session.revert.cleared' ? 'Restored the reverted messages' : undefined;
      void this.resnapshot(notice ? { notice, semantic: { kind: 'rollback' } } : undefined).catch(() => {});
    } else if (event.type === 'session.compaction.ended') {
      void this.resnapshot({ notice: 'Compacted the conversation.', semantic: { kind: 'compaction' } }).catch(() => {});
    } else if (event.type === 'session.compaction.failed') {
      this.emit({ type: 'error', message: 'OpenCode could not compact the conversation.' });
    }
  }

  private path(suffix: string): string { return `/api/session/${encodeURIComponent(this.info.id)}${suffix}`; }
  private assertMutable(): void {
    if (this.closed || this.observe || !this.ready) throw new ControlRefusedError('This OpenCode connection is read-only or reconnecting.', 'command-unsupported');
    // From 2.4.2 OpenCode would restore the session on send; on older services the turn would run
    // in a session its list no longer shows. Either way the user restores it in OpenCode first.
    if (this.backend.archived.has(this.info.id)) throw new ControlRefusedError(OPENCODE_ARCHIVED_REASON, 'command-unsupported');
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    this.assertMutable();
    const { text, files } = this.preparePrompt(input);
    await this.select(input);
    const id = newNativeId('msg');
    if (input.clientMessageId) {
      this.backend.clientKeys.set(id, input.clientMessageId);
      if (this.backend.clientKeys.size > 4096) this.backend.clientKeys.delete(this.backend.clientKeys.keys().next().value!);
    }
    try {
      // Native 2.1.4 hydrates attachments before returning its admission
      // response: eight full-limit images measured 8.8 s locally. Keep the
      // ordinary control deadline, with a bounded budget for this larger IO.
      const result = await this.backend.write(this.binding, this.path('/prompt'), { id, text, delivery: 'steer', ...(files.length ? { files } : {}) }, 'POST', files.length ? { timeoutMs: 30_000 } : {});
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
  async listAgents() { return this.backend.listAgents(this.info.cwd); }
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

  private async select(input: CommandInput): Promise<void> {
    if (input.agent && input.agent !== this.info.currentAgent) await this.setAgent(input.agent);
    if (input.model) {
      const models = await this.listModels();
      if (!models.some((model) => model.providerID === input.model!.providerID && model.modelID === input.model!.modelID)) throw new Error('Choose an available OpenCode model.');
      await this.backend.write(this.binding, this.path('/model'), { model: { providerID: input.model.providerID, id: input.model.modelID, ...(input.model.variant || input.model.reasoningEffort ? { variant: input.model.variant ?? input.model.reasoningEffort } : {}) } });
      this.updateInfo(await this.backend.getSession(this.info.id));
    }
  }

  private preparePrompt(input: PromptInput): { text: string; files: Native[] } {
    if (!input.files?.length && !input.images?.length) return { text: input.text, files: [] };
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(this.binding.baseUrl).hostname)) throw new ControlRefusedError('File input requires a local OpenCode service.', 'command-unsupported');
    const inbox = this.info.cwd && resolve(this.info.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    const refs = (input.files ?? []).map((file) => {
      if (!inbox || !file.brokerPath || dirname(resolve(file.brokerPath)) !== inbox || !lstatSync(file.brokerPath).isFile()) throw new Error('OpenCode requires a broker-staged attachment.');
      return `- ${file.name} (${file.mimeType}) → \`${file.brokerPath}\``;
    });
    const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
    const text = refs.length ? (input.text.trim() ? `${input.text}\n\n${note}` : note) : input.text;
    return { text, files: (input.images ?? []).map((image) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: image.name ?? 'image' })) };
  }

  async listCommands(): Promise<SlashCommand[]> {
    const location = this.info.cwd ? `?location%5Bdirectory%5D=${encodeURIComponent(this.info.cwd)}` : '';
    const commands = arrayData(await this.backend.transport!.json('/api/command' + location));
    const builtins = OPENCODE_SHARED_ACTIONS.map((command) => command.name);
    return [...OPENCODE_SHARED_ACTIONS, ...commands.filter((item) => typeof item.name === 'string' && item.name.trim() && !/[\r\n]/.test(item.name) && ![...builtins, 'share', 'unshare'].includes(item.name)).map((item) => ({ name: item.name, kind: 'prompt' as const, ...(typeof item.description === 'string' ? { description: item.description } : {}) }))];
  }

  async runCommand(name: string, args?: string, input?: CommandInput): Promise<CommandResult | void> {
    this.assertMutable();
    if (name === 'stop') {
      const response = await this.backend.write(this.binding, this.path('/interrupt'));
      if (typeof response?.interrupted !== 'boolean') throw new V2Error('invalid-response');
      if (!response.interrupted) return { notice: 'Nothing is running.' };
      return;
    }
    if (name === 'compact') {
      await this.select(input ?? {});
      const response = await this.backend.write(this.binding, this.path('/compact'), {});
      if (!nativeId(response?.data?.id, 'msg_') || response.data.type !== 'compaction') throw new V2Error('invalid-response', true);
      return { notice: 'Compacting the session…' };
    }
    if (name === 'undo' || name === 'redo') {
      const native = await this.backend.getSession(this.info.id);
      if (this.backend.active.has(this.info.id)) return { notice: 'OpenCode is busy; stop the running turn first.' };
      try {
        if (name === 'redo') {
          if (!native.revert) return { notice: 'Nothing to redo.' };
          await this.backend.write(this.binding, this.path('/revert'), undefined, 'DELETE');
        } else {
          const messages = await this.backend.history(this.info.id);
          const boundary = messages.findIndex((message) => message.id === native.revert?.messageID);
          const users = (boundary < 0 ? messages : messages.slice(0, boundary)).filter((message) => message.type === 'user');
          if (users.length < 2) return { notice: 'Nothing to undo.' };
          await this.backend.write(this.binding, this.path('/revert/stage'), { messageID: users.at(-1)!.id });
        }
      } catch (error) {
        if (error instanceof V2Error && error.reason === 'conflict') return { notice: 'OpenCode is busy; stop the running turn first.' };
        throw error;
      }
      return;
    }
    if (!(await this.listCommands()).some((command) => command.name === name && command.kind === 'prompt')) throw new ControlRefusedError('This command is not supported.', 'command-unsupported');
    await this.select(input ?? {});
    await this.backend.write(this.binding, this.path('/command'), { name, text: args ?? '', delivery: 'steer' });
    return { notice: `Running /${name}…` };
  }

  async close(): Promise<void> { this.closed = true; this.ready = false; this.handlers.clear(); clearTimeout(this.jobTimer); this.jobTimer = undefined; }
}
