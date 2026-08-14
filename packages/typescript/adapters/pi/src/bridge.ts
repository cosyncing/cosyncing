/**
 * Pi live bridge (Mode A) — adapter side.
 *
 * Pi has no daemon, so the ONLY way to share a *live* Pi session (terminal + phone on one session,
 * no second `pi --mode rpc` owner corrupting the JSONL) is an extension loaded INSIDE that session.
 * The extension (`~/.pi/agent/extensions/cosyncing-bridge/`) relays the session's events OUT to
 * the broker over HTTP and pulls commands (prompt injection, approvals, send_file) back IN.
 *
 * This module is the broker end:
 *  - `PiBridgeConnection` — a SessionConnection whose events arrive from the extension (via
 *    `ingest`) and whose outbound actions are queued for the extension to long-poll (`takeCommands`).
 *  - `PiBridgeRegistry` — tracks live bridges by session id; `hello` adopts a connection into the Hub
 *    (pinned, so it isn't evicted while the terminal session is alive), `bye` tears it down.
 *
 * Wire protocol (broker ⇄ extension) is small and broker-defined (the extension emits these shapes):
 *   event  {t:'status', running}            → status
 *          {t:'delta',  kind:'text'|'thinking', key, delta} → streaming model-output/thinking
 *          {t:'user',   text}               → a user prompt (typed in the terminal or injected)
 *          {t:'tool-call',   callId, name, args, title?}     → tool started
 *          {t:'tool-result', callId, name, result, isError, title?} → tool finished
 *          {t:'token',  input, output, cost}                 → token-count
 *          {t:'final',  key, kind:'text'|'thinking', text}   → finalized message (for history)
 *          {t:'permission-request', requestId, title, detail?, toolName?} → approval card
 *          {t:'permission-resolved', requestId, decision}     → approval card resolved
 *          {t:'question-request', requestId, questions}       → structured question card
 *          {t:'question-resolved', requestId}                 → question card resolved
 *          {t:'error',  message}            → error
 *          {t:'retry',  attempt, max, message}               → 429/transient retry banner
 *   command {kind:'prompt', text, deliverAs?} | {kind:'abort'} |
 *           {kind:'command', name, args, deliverAs?} | {kind:'permission', requestId, decision} |
 *           {kind:'answer', requestId, answers} | {kind:'reject-question', requestId}
 */
import {
  PRODUCT_IDENTITY,
  type AgentMessage,
  type AgentMessageHandler,
  type CommandInput,
  type CommandResult,
  type FileInput,
  type HistorySourceIdentity,
  type ModelOption,
  type PermissionDecision,
  type PromptInput,
  type SessionConnection,
  type SessionInfo,
  type SlashCommand,
  type Unsubscribe,
} from '@cosyncing/adapter-api';
// The bridge is Pi-specific, so it shares Pi's tool-result enrichment (diff/exitCode/path/truncation
// → canonical chips) with the resume adapter — both paths enrich identically (shared-surface fix).
import { enrichPiToolResult, piToolDisplayClass, piToolSemantic } from './implementation.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, extname, resolve } from 'node:path';

export interface BridgeCommand {
  id: number;
  kind: 'prompt' | 'abort' | 'command' | 'permission' | 'answer' | 'reject-question' | 'set-model' | 'set-thinking-level';
  text?: string;
  name?: string;
  args?: string;
  requestId?: string;
  decision?: PermissionDecision;
  answers?: string[][];
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
  providerID?: string;
  modelID?: string;
  reasoningEffort?: string;
}

const PI_THINKING_LEVELS = [
  { effort: 'off', label: 'Off' },
  { effort: 'minimal', label: 'Minimal' },
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra high' },
] as const;
const PI_THINKING_LEVEL_SET = new Set(PI_THINKING_LEVELS.map((x) => x.effort));

/** Build a canonical tool-result from a bridge wire event, enriching with diff/additions/deletions/
 *  exitCode/truncated/path via the shared Pi enricher (the extension now relays `details`/`args`) so a
 *  bridged Pi session renders the same chips as the resume path and OpenCode — not an opaque blob. A
 *  title the extension already computed wins over the derived one. */
function bridgeToolResult(ev: any): AgentMessage {
  const toolName = String(ev.name ?? 'tool');
  const result = ev.result;
  const text = typeof result === 'string' ? result : '';
  const { title: derivedTitle, ...rest } = enrichPiToolResult(toolName, {
    text,
    details: ev.details,
    isError: !!ev.isError,
    args: ev.args,
  });
  const semantic = piToolSemantic(toolName, {
    args: ev.args,
    details: ev.details,
    text,
    isError: !!ev.isError,
    hasResult: true,
  });
  return {
    type: 'tool-result',
    callId: String(ev.callId ?? ''),
    toolName,
    toolClass: piToolDisplayClass(toolName),
    ...(semantic ? { semantic } : {}),
    isError: !!ev.isError,
    result,
    ...rest,
    title: ev.title ?? derivedTitle,
  };
}

/** The bridge's live and replay tool-call frames share one normalization. */
function bridgeToolCall(ev: any): AgentMessage {
  const toolName = String(ev.name ?? 'tool');
  const semantic = piToolSemantic(toolName, { args: ev.args, hasResult: false });
  return {
    type: 'tool-call',
    callId: String(ev.callId ?? ''),
    toolName,
    toolClass: piToolDisplayClass(toolName),
    ...(semantic ? { semantic } : {}),
    title: ev.title,
    args: ev.args,
  };
}

function normalizePermissionDecision(v: unknown): PermissionDecision {
  return v === 'approve-session' || v === 'reject' || v === 'approve' ? v : 'reject';
}

function normalizePiThinkingLevel(value: unknown): string | undefined {
  const level = typeof value === 'string' ? value.trim() : '';
  return PI_THINKING_LEVEL_SET.has(level as any) ? level : undefined;
}

function piCurrentModelFromWire(model: any, thinkingLevel?: unknown): SessionInfo['currentModel'] | undefined {
  const modelID = model?.modelID ?? model?.id ?? model?.model;
  if (typeof modelID !== 'string' || !modelID) return undefined;
  const effort = normalizePiThinkingLevel(thinkingLevel ?? model?.reasoningEffort ?? model?.thinkingLevel);
  return {
    providerID: String(model.providerID ?? model.provider ?? ''),
    modelID,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

function piThinkingEfforts(model: any): ModelOption['reasoningEfforts'] | undefined {
  if (model?.reasoning !== true) return undefined;
  const map = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : undefined;
  const efforts = PI_THINKING_LEVELS
    .filter(({ effort }) => map?.[effort] !== null)
    .map(({ effort, label }) => ({ effort, label }));
  return efforts.length ? efforts : undefined;
}

function piModelOptionFromWire(model: any, currentEffort?: string): ModelOption | undefined {
  const modelID = model?.modelID ?? model?.id;
  if (typeof modelID !== 'string' || !modelID) return undefined;
  const option: ModelOption = {
    providerID: String(model.providerID ?? model.provider ?? ''),
    modelID,
    label: String(model.label ?? model.name ?? modelID),
  };
  const efforts = piThinkingEfforts(model);
  if (efforts?.length) {
    option.reasoningEfforts = efforts;
    if (currentEffort && efforts.some((e) => e.effort === currentEffort)) option.defaultReasoningEffort = currentEffort;
  }
  return option;
}

function normalizeQuestions(raw: unknown): Array<{
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
}> {
  return (Array.isArray(raw) ? raw : []).map((q: any) => ({
    question: String(q?.question ?? q?.message ?? ''),
    header: q?.header == null ? undefined : String(q.header),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) =>
      typeof o === 'string'
        ? { label: o }
        : { label: String(o?.label ?? ''), description: o?.description == null ? undefined : String(o.description) },
    ),
    multiple: q?.multiple === true,
  }));
}

function nativeTimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function bridgeRunSummary(ev: any): AgentMessage {
  const startedAt = nativeTimeMs(ev.startedAt);
  const completedAt = nativeTimeMs(ev.completedAt);
  const totalRuntimeMs =
    typeof ev.totalRuntimeMs === 'number'
      ? ev.totalRuntimeMs
      : startedAt != null && completedAt != null && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;
  return {
    type: 'run-summary',
    key: String(ev.key ?? `pi:run:${ev.turnId ?? ''}`),
    turnId: String(ev.turnId ?? ev.key ?? ''),
    userMessageKey: ev.userMessageKey == null ? undefined : String(ev.userMessageKey),
    assistantMessageKey: ev.assistantMessageKey == null ? undefined : String(ev.assistantMessageKey),
    status: ev.status === 'error' || ev.status === 'cancelled' || ev.status === 'running' ? ev.status : 'done',
    startedAt,
    completedAt,
    agentRuntimeMs: typeof ev.agentRuntimeMs === 'number' ? ev.agentRuntimeMs : undefined,
    executionRuntimeMs: typeof ev.executionRuntimeMs === 'number' ? ev.executionRuntimeMs : undefined,
    totalRuntimeMs,
    tokens: ev.tokens,
    source: ev.source ?? 'pi-bridge',
  };
}

export class PiBridgeConnection implements SessionConnection {
  readonly info: SessionInfo;
  private readonly handlers = new Set<AgentMessageHandler>();
  /** Finalized messages, in order, for getHistory() — a late-joining client's backfill. Live deltas
   *  ride the stream; ManagedConn.liveSnapshot catches a mid-turn joiner up on in-flight text. */
  private readonly history: AgentMessage[] = [];
  private historyRevision = 0;
  private readonly historySourceGeneration = randomUUID();
  /** Outbound commands awaiting the extension's long-poll. */
  private queue: BridgeCommand[] = [];
  private waiter?: (cmds: BridgeCommand[]) => void;
  private waiterTimer?: ReturnType<typeof setTimeout>;
  private cmdSeq = 0;
  private streaming = false;
  /** The user's skills/templates, relayed by the extension (hello body or a 'commands' event) — so
   *  the bridged palette offers more than /stop. Empty until the extension reports them. */
  private relayedCommands: SlashCommand[] = [];
  /** Model catalog relayed by the active extension. Empty means no actionable model picker. */
  private relayedModels: ModelOption[] = [];
  /** Last time the extension was heard from (event POST or command poll) — for liveness. */
  lastSeen = 0;
  /** Pending permission/question frames that must replay to a browser joining while blocked.
   *  The Hub keeps the live snapshot; this adapter-owned copy backs `getPending()` and is deduped by
   *  requestId during attach. Governing contract: docs/architecture/client-ui.md */
  private readonly pendingFrames = new Map<string, AgentMessage>();
  constructor(info: SessionInfo) {
    this.info = info;
    this.lastSeen = 0;
  }

  replaceInfo(info: SessionInfo): void {
    for (const key of Object.keys(this.info)) delete (this.info as unknown as Record<string, unknown>)[key];
    Object.assign(this.info, info);
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(m: AgentMessage): void {
    if (m.type === 'permission-request' || m.type === 'question-request') this.pendingFrames.set(m.requestId, m);
    else if (m.type === 'permission-resolved' || m.type === 'question-resolved') this.pendingFrames.delete(m.requestId);
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate one bad subscriber */
      }
    }
  }

  private appendHistory(message: AgentMessage): void {
    this.history.push(message);
    this.historyRevision += 1;
  }

  /** Map one extension event to canonical messages, emit them, and keep finals for history. */
  ingest(ev: any): void {
    this.lastSeen = Date.now();
    switch (ev?.t) {
      case 'status':
        this.streaming = !!ev.running;
        this.emit({ type: 'status', status: ev.running ? 'running' : 'idle' });
        return;
      case 'delta':
        this.emit(ev.kind === 'thinking'
          ? { type: 'thinking', delta: String(ev.delta ?? ''), key: String(ev.key ?? '') }
          : { type: 'model-output', delta: String(ev.delta ?? ''), key: String(ev.key ?? '') });
        return;
      case 'final': {
        // The consolidated message for this key — store for history (deltas already rendered it live).
        const m: AgentMessage = ev.kind === 'thinking'
          ? { type: 'thinking', text: String(ev.text ?? ''), key: String(ev.key ?? '') }
          : { type: 'model-output', text: String(ev.text ?? ''), key: String(ev.key ?? ''), final: true };
        this.appendHistory(m);
        return;
      }
      case 'user': {
        // Carry the extension's stable key so the app dedupes the relayed user message against its
        // own optimistic bubble (and across reattaches). The echo stays UNSTAMPED: Pi user messages
        // have no native id and the relay gives an injected prompt no exact handle, so a terminal
        // prompt with identical text is indistinguishable — the client's legacy reconcile applies.
        const key = ev.key ? String(ev.key) : undefined;
        const m: AgentMessage = { type: 'user-message', text: String(ev.text ?? ''), key, turnId: key, sentAt: nativeTimeMs(ev.sentAt ?? ev.createdAt) };
        this.appendHistory(m);
        this.emit(m);
        return;
      }
      case 'run-summary':
      case 'run': {
        const m = bridgeRunSummary(ev);
        this.appendHistory(m);
        this.emit(m);
        return;
      }
      case 'runtime-totals': {
        const m: AgentMessage = { type: 'metadata-update', key: 'runtimeTotals', value: ev.value ?? ev };
        this.appendHistory(m);
        this.emit(m);
        return;
      }
      case 'tool-call':
        this.emit(bridgeToolCall(ev));
        return;
      case 'tool-result': {
        const m = bridgeToolResult(ev);
        this.appendHistory(m);
        this.emit(m);
        return;
      }
      case 'token':
        this.emit({ type: 'token-count', input: ev.input, output: ev.output, cost: ev.cost });
        return;
      case 'permission-request':
        this.emit({
          type: 'permission-request',
          requestId: String(ev.requestId ?? ev.id ?? ''),
          title: String(ev.title ?? 'Permission request'),
          detail: ev.detail == null ? undefined : String(ev.detail),
          toolName: ev.toolName == null ? undefined : String(ev.toolName),
        });
        return;
      case 'permission-resolved':
        this.emit({
          type: 'permission-resolved',
          requestId: String(ev.requestId ?? ev.id ?? ''),
          decision: normalizePermissionDecision(ev.decision),
        });
        return;
      case 'question-request':
        this.emit({
          type: 'question-request',
          requestId: String(ev.requestId ?? ev.id ?? ''),
          questions: normalizeQuestions(ev.questions),
        });
        return;
      case 'question-resolved':
        this.emit({ type: 'question-resolved', requestId: String(ev.requestId ?? ev.id ?? '') });
        return;
      case 'retry': {
        const first = String(ev.message ?? 'Retrying…').split('\n')[0] || 'Retrying…';
        this.emit({ type: 'status', status: 'running', detail: ev.attempt ? `${first} (retry ${ev.attempt}/${ev.max ?? '?'})` : first });
        return;
      }
      case 'commands':
        this.setCommands(ev.commands);
        return;
      case 'model': {
        const currentModel = piCurrentModelFromWire(ev.model, ev.thinkingLevel);
        if (currentModel) {
          this.info.currentModel = currentModel;
          this.info.model = String(ev.model?.label ?? ev.model?.name ?? currentModel.modelID);
          this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel, model: this.info.model } });
        }
        if (Array.isArray(ev.models)) this.setModelOptions(ev.models, currentModel?.reasoningEffort);
        return;
      }
      case 'error':
        this.emit({ type: 'error', message: String(ev.message ?? 'error') });
        return;
      default:
        return;
    }
  }

  /** Backfill the conversation-so-far on hello: map relayed wire events to history WITHOUT emitting
   *  (no client is attached yet; live clients pick it up via getHistory on attach/resync). Idempotent
   *  — a re-hello (extension reload) won't duplicate, since the history is already populated. */
  ingestHistory(events: unknown): void {
    if (this.history.length) return; // already backfilled
    for (const ev of Array.isArray(events) ? events : []) {
      const m = this.historyMessage(ev);
      if (m) this.appendHistory(m);
    }
  }

  private historyMessage(ev: any): AgentMessage | undefined {
    switch (ev?.t) {
      case 'user':
        {
          const key = ev.key ? String(ev.key) : undefined;
          return { type: 'user-message', text: String(ev.text ?? ''), key, turnId: key, sentAt: nativeTimeMs(ev.sentAt ?? ev.createdAt) };
        }
      case 'final':
        return ev.kind === 'thinking'
          ? { type: 'thinking', text: String(ev.text ?? ''), key: String(ev.key ?? '') }
          : { type: 'model-output', text: String(ev.text ?? ''), key: String(ev.key ?? ''), final: true };
      case 'run-summary':
      case 'run':
        return bridgeRunSummary(ev);
      case 'runtime-totals':
        return { type: 'metadata-update', key: 'runtimeTotals', value: ev.value ?? ev };
      case 'tool-call':
        return bridgeToolCall(ev);
      case 'tool-result':
        return bridgeToolResult(ev);
      case 'permission-request':
        return {
          type: 'permission-request',
          requestId: String(ev.requestId ?? ev.id ?? ''),
          title: String(ev.title ?? 'Permission request'),
          detail: ev.detail == null ? undefined : String(ev.detail),
          toolName: ev.toolName == null ? undefined : String(ev.toolName),
        };
      case 'question-request':
        return { type: 'question-request', requestId: String(ev.requestId ?? ev.id ?? ''), questions: normalizeQuestions(ev.questions) };
      default:
        return undefined;
    }
  }

  /** Store the user's skills/templates relayed by the extension (replace, keep last non-empty). */
  setCommands(cmds: unknown): void {
    const list = (Array.isArray(cmds) ? cmds : [])
      .filter((c: any) => c?.name)
      .map((c: any) => ({
        name: String(c.name),
        description: c.description ? String(c.description) : undefined,
        kind: (c.kind === 'action' ? 'action' : 'prompt') as 'action' | 'prompt',
      }));
    if (list.length) this.relayedCommands = list;
  }

  /** Store the model catalog relayed by the extension. Empty clears stale options on reload. */
  setModelOptions(models: unknown, currentEffort?: string): void {
    const effort = normalizePiThinkingLevel(currentEffort);
    this.relayedModels = (Array.isArray(models) ? models : [])
      .map((m) => piModelOptionFromWire(m, effort))
      .filter((m): m is ModelOption => !!m);
  }

  async getHistory(): Promise<AgentMessage[]> {
    return [...this.history];
  }

  getHistorySourceIdentity(): HistorySourceIdentity {
    return {
      sourceId: `pi-bridge:${this.info.id}`,
      revision: `${this.historyRevision}:${this.history.length}`,
      appendPosition: this.historyRevision,
      rewriteToken: this.historySourceGeneration,
    };
  }

  getPending(): AgentMessage[] {
    return [...this.pendingFrames.values()];
  }

  // ── outbound: queued for the extension's long-poll ──
  private enqueue(cmd: Omit<BridgeCommand, 'id'>): void {
    const full: BridgeCommand = { id: ++this.cmdSeq, ...cmd };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      if (this.waiterTimer) clearTimeout(this.waiterTimer);
      w([full]);
    } else {
      this.queue.push(full);
    }
  }

  /** The extension long-polls this: resolve immediately with any queued commands, else wait (≤25s). */
  takeCommands(): Promise<BridgeCommand[]> {
    this.lastSeen = Date.now();
    if (this.queue.length) {
      const out = this.queue;
      this.queue = [];
      return Promise.resolve(out);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.waiterTimer = setTimeout(() => {
        if (this.waiter === resolve) this.waiter = undefined;
        resolve([]); // long-poll timeout → extension re-polls
      }, 25000);
    });
  }

  private enqueueModelOverride(model: PromptInput['model'] | undefined): void {
    if (!model?.modelID) return;
    const effort = normalizePiThinkingLevel(model.reasoningEffort);
    this.enqueue({
      kind: 'set-model',
      providerID: model.providerID,
      modelID: model.modelID,
      ...(effort ? { reasoningEffort: effort } : {}),
    });
    this.info.currentModel = {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
    this.info.model = model.modelID;
    this.emit({ type: 'metadata-update', key: 'sessionInfo', value: { currentModel: this.info.currentModel, model: this.info.model } });
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    let text = input.text ?? '';
    if (input.files?.length) {
      const refs = input.files.map((f) => {
        const abs = this.writeInboxFile(f);
        return `- ${f.name} (${f.mimeType}) → \`${abs}\``;
      });
      const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    if (!text.trim()) return;
    this.enqueueModelOverride(input.model);
    // NO optimistic echo here: the app already draws its own optimistic bubble, and the extension
    // relays the real user message (message_start, role:user) which reconciles it. Echoing here too
    // produced a SECOND, un-reconciled bubble (the "one send → two bubbles" report).
    this.enqueue({ kind: 'prompt', text, deliverAs: this.streaming ? 'steer' : undefined });
  }

  async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  /** Write inline bytes or accept a broker-owned inbox path. */
  private writeInboxFile(file: FileInput): string {
    const cwd = this.info.cwd;
    if (!cwd) throw new Error('Pi attachment delivery requires a workspace.');
    const inbox = resolve(cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('Pi rejected an untrusted broker attachment path.');
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') throw new Error('Pi attachment bytes are missing.');
    try {
      mkdirSync(inbox, { recursive: true });
      const safeBase = (file.name || 'file').split('/').pop()!.replace(/[^\w.\- ]+/g, '_') || 'file';
      let safe = safeBase;
      if (existsSync(join(inbox, safe))) {
        const ext = extname(safeBase);
        const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
        let n = 2;
        while (existsSync(join(inbox, `${stem}-${n}${ext}`))) n++;
        safe = `${stem}-${n}${ext}`;
      }
      const abs = join(inbox, safe);
      writeFileSync(abs, Buffer.from(file.data, 'base64'));
      return abs;
    } catch (error) {
      throw new Error(`Pi could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  /** Queue the app's decision for the extension's long-poll so it can resolve a blocked `tool_call`. */
  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.enqueue({ kind: 'permission', requestId, decision });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.enqueue({ kind: 'answer', requestId, answers });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    this.enqueue({ kind: 'reject-question', requestId });
  }

  async runCommand(name: string, args?: string, input?: CommandInput): Promise<CommandResult | void> {
    if (name === 'stop' || name === 'abort') {
      this.enqueue({ kind: 'abort' });
      return { notice: 'Stopped the turn.' };
    }
    // A skill/template — the extension injects it as a '/name args' user message (Pi expands it).
    this.enqueueModelOverride(input?.model);
    this.enqueue({ kind: 'command', name, args, deliverAs: this.streaming ? 'steer' : undefined });
    return { notice: `Running /${name}…` };
  }

  async listCommands(): Promise<SlashCommand[]> {
    // Always stop; plus the user's skills/templates once the extension relays them (hello/commands).
    return [{ name: 'stop', description: 'Stop the running turn', kind: 'action' }, ...this.relayedCommands];
  }

  async listModels(): Promise<ModelOption[]> {
    return [...this.relayedModels];
  }

  async close(): Promise<void> {
    if (this.waiterTimer) clearTimeout(this.waiterTimer);
    if (this.waiter) {
      this.waiter([]);
      this.waiter = undefined;
    }
    this.handlers.clear();
    this.pendingFrames.clear();
  }
}

/**
 * Tracks live Pi bridges by session id and adopts/evicts them in the Hub.
 *
 * Teardown policy (the reload/fork ORPHAN fix). When Pi tears an extension runtime down it fires
 * `session_shutdown` for quit AND for reload/new/resume/fork; the extension relays that `reason`
 * here via `bye`. The danger: a *reload* (or `/reload`, a config hot-swap) shuts the old runtime
 * down and immediately starts a NEW one on the SAME session file — same bridge id. If we evicted on
 * every bye we'd dispose the ManagedConn (clearing its client set) BETWEEN the old runtime's bye and
 * the new runtime's hello, orphaning the attached phone on a now-silent socket. So:
 *   - `reload` (or an unknown/missing reason — version drift) → DEFER teardown by `graceMs`. A
 *     same-id `hello` within the window cancels it and reclaims the live connection: the phone never
 *     notices. If no re-hello arrives (a reload that failed), the timer fires and tears down cleanly.
 *   - `quit` / `new` / `resume` / `fork` → the live session is genuinely gone or replaced by a
 *     DIFFERENT session file (a new id that won't cancel this one) → tear down NOW, after notifying
 *     the phone (`onTeardown` → Hub.evict fans an `ended` frame).
 */
export class PiBridgeRegistry {
  private readonly conns = new Map<string, PiBridgeConnection>();
  /** Deferred byes (reload/unknown): id → timer. A same-id hello() cancels its entry. */
  private readonly pendingBye = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param onTeardown remove this bridge from the Hub (which fans a clean `ended` frame to clients,
   *   then disposes the connection). Injected so the registry owns the *when* and the Hub owns the
   *   *how* — no Hub import here.
   * @param graceMs window a reload/unknown-reason shutdown is held open for the same-id re-hello.
   */
  constructor(
    private readonly onTeardown: (id: string, reason: string) => void | Promise<void>,
    private readonly graceMs = 4000,
  ) {}

  has(id: string): boolean {
    return this.conns.has(id);
  }

  get(id: string): PiBridgeConnection | undefined {
    return this.conns.get(id);
  }

  /** Move a bridge to the canonical session id once the JSONL exists and realpath identity is known.
   *  This closes the narrow early-hello race where the extension reports a symlink spelling before Pi
   *  has materialized the session file. */
  rekey(oldId: string, newId: string): PiBridgeConnection | undefined {
    if (oldId === newId) return this.conns.get(oldId);
    const conn = this.conns.get(oldId);
    if (!conn) return this.conns.get(newId);
    const existing = this.conns.get(newId);
    this.clearPendingBye(oldId);
    if (existing && existing !== conn) {
      existing.replaceInfo({ ...conn.info, id: newId });
      this.conns.delete(oldId);
      return existing;
    }
    this.conns.delete(oldId);
    this.conns.set(newId, conn);
    conn.replaceInfo({ ...conn.info, id: newId });
    return conn;
  }

  /** Register (or reclaim) a bridge for a session. A re-hello reuses the live connection AND cancels
   *  any pending (deferred) bye for it — this is what makes a reload transparent to the phone. */
  hello(id: string, info: SessionInfo): PiBridgeConnection {
    this.clearPendingBye(id); // a reload's re-hello reclaims the connection before its bye fires
    const existing = this.conns.get(id);
    if (existing) {
      existing.replaceInfo(info);
      return existing;
    }
    const conn = new PiBridgeConnection(info);
    this.conns.set(id, conn);
    return conn;
  }

  /** The extension reported `session_shutdown`. `reason` (Pi's SessionShutdownEvent.reason) decides
   *  whether to defer (reload/unknown) or tear down immediately (quit/new/resume/fork). */
  bye(id: string, reason?: string): void {
    if (!this.conns.has(id)) {
      this.clearPendingBye(id);
      return;
    }
    const deferrable = !reason || reason === 'reload';
    if (deferrable) {
      this.clearPendingBye(id);
      const timer = setTimeout(() => {
        this.pendingBye.delete(id);
        if (this.conns.has(id)) this.teardown(id, reason || 'reload'); // no re-hello arrived → really gone
      }, this.graceMs);
      this.pendingBye.set(id, timer);
      return;
    }
    this.teardown(id, reason);
  }

  /** Deterministic liveness sweep for an extension process that disappeared without `bye`.
   *  `lastSeen=0` means the bridge has not completed an event/poll yet and is not evidence of death. */
  sweepStale(now = Date.now(), staleMs = 60_000): string[] {
    const stale: string[] = [];
    for (const [id, conn] of this.conns) {
      if (conn.lastSeen <= 0 || this.pendingBye.has(id) || now - conn.lastSeen <= staleMs) continue;
      stale.push(id);
    }
    for (const id of stale) this.teardown(id, 'liveness-timeout');
    return stale;
  }

  private teardown(id: string, reason: string): void {
    this.clearPendingBye(id);
    if (!this.conns.delete(id)) return;
    void this.onTeardown(id, reason); // Hub.evict: notifyEnded(reason) → dispose
  }

  private clearPendingBye(id: string): void {
    const t = this.pendingBye.get(id);
    if (t) {
      clearTimeout(t);
      this.pendingBye.delete(id);
    }
  }
}
