/**
 * Claude live sync via HOOKS (broker side) — the Tier-1 control path that replaces the archived
 * `claude/channel` bridge. Empirically proven viable (no allowlist) on claude 2.1.185; see
 * `docs/protocol/adapter-support.md`.
 *
 * Claude already writes the rich session content (assistant text, tool calls/results, thinking, tokens) to
 * its transcript JSONL on disk, so a `ClaudeObserveConnection` gives us the whole CONTENT stream for free.
 * The one thing Observe cannot do is answer a LIVE permission prompt or the in-flight AskUserQuestion (both
 * are held off-disk until the turn completes). A **PreToolUse hook** closes exactly that gap: it fires before
 * each tool, relays the permission/question to the broker, BLOCKS for the phone's answer, and returns the
 * decision to Claude — which honors it. So:
 *
 *   ClaudeHooksConnection = ClaudeObserveConnection (content)  +  hook control channel (live answer)
 *
 * Wire protocol (broker ⇄ in-session hook), all over the broker's HTTP server:
 *   POST /claude/hook/hello   {transcriptPath, sessionUuid, cwd?, title?, model?} → adopt a pinned live conn
 *   POST /claude/hook/request {id, requestId, kind:'permission'|'question', ...} → ingest + long-poll the
 *        decision; returns {resolved:true, decision|answers} once the phone answers, else {resolved:false}
 *        (hook re-posts), or {viewers:0} when no app is attached (hook passes through to the terminal).
 *   POST /claude/hook/bye     {id, reason?} → tear the live conn down.
 *
 * The connection mirrors `PiBridgeConnection`/`PiBridgeRegistry`: adopted into the Hub (pinned) so a phone
 * attach reuses it, and the same `respondPermission`/`answerQuestion`/`rejectQuestion` the app already calls.
 */
import type {
  AgentMessage,
  AgentMessageHandler,
  HistorySourceIdentity,
  HistoryQuery,
  ModeOption,
  ModelOption,
  PermissionDecision,
  PromptInput,
  SessionConnection,
  SessionInfo,
  SlashCommand,
  Unsubscribe,
} from '@cosyncing/protocol';
import { ClaudeObserveConnection } from '@cosyncing/adapter-claude';

/** What the blocked hook is waiting for — resolved when the app answers. */
export type HookDecision =
  | { kind: 'permission'; decision: PermissionDecision }
  | { kind: 'answer'; answers: string[][] }
  | { kind: 'reject' };

/** A relayed request the hook is blocking on. */
export interface HookRequest {
  requestId: string;
  kind: 'permission' | 'question';
  toolName?: string;
  title?: string;
  detail?: string;
  toolInput?: unknown;
  questions?: unknown;
}

function normalizeQuestions(raw: unknown): Array<{ question: string; header?: string; options: { label: string; description?: string }[]; multiple?: boolean }> {
  return (Array.isArray(raw) ? raw : []).map((q: any) => ({
    question: String(q?.question ?? q?.message ?? ''),
    header: q?.header == null ? undefined : String(q.header),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) =>
      typeof o === 'string' ? { label: o } : { label: String(o?.label ?? ''), description: o?.description == null ? undefined : String(o.description) },
    ),
    multiple: q?.multiSelect === true || q?.multiple === true,
  }));
}

export class ClaudeHooksConnection implements SessionConnection {
  readonly info: SessionInfo;
  /** Content comes from the transcript tail; the hook channel only adds live permission/question control. */
  private readonly observe: ClaudeObserveConnection;
  private readonly handlers = new Set<AgentMessageHandler>();
  private observeUnsub?: Unsubscribe;
  /** Live permission/question frames awaiting an answer — replayed to a browser joining mid-block. */
  private readonly pendingFrames = new Map<string, AgentMessage>();
  /** Decisions already produced (answer may land before the hook polls / between re-polls). */
  private readonly resolved = new Map<string, HookDecision>();
  /** A blocked hook poll waiting for a specific requestId's decision. */
  private readonly waiters = new Map<string, (d: HookDecision | null) => void>();
  lastSeen = Date.now();

  constructor(info: SessionInfo, transcriptPath: string) {
    this.info = info;
    this.observe = new ClaudeObserveConnection(transcriptPath, info);
  }

  replaceInfo(info: SessionInfo): void {
    for (const k of Object.keys(this.info)) delete (this.info as unknown as Record<string, unknown>)[k];
    Object.assign(this.info, info);
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    // Lazily tail the transcript and forward CONTENT only — the hook channel owns interactive control, so
    // drop Observe's read-only permission/question frames (else they'd duplicate / downgrade the live ones).
    if (!this.observeUnsub) {
      this.observeUnsub = this.observe.subscribe((m) => {
        if (m.type === 'permission-request' || m.type === 'question-request') return;
        this.fan(m);
      });
    }
    return () => this.handlers.delete(handler);
  }

  private fan(m: AgentMessage): void {
    for (const h of this.handlers) {
      try { h(m); } catch { /* isolate one bad subscriber */ }
    }
  }

  private emit(m: AgentMessage): void {
    if (m.type === 'permission-request' || m.type === 'question-request') this.pendingFrames.set(m.requestId, m);
    else if (m.type === 'permission-resolved' || m.type === 'question-resolved') this.pendingFrames.delete(m.requestId);
    this.fan(m);
  }

  /** Turn-boundary signal from UserPromptSubmit (working) / Stop (idle) hooks → a live status the app shows
   *  as a spinner, so a hooks-synced session feels live during a turn instead of looking idle until the
   *  roster poll. (Mid-turn TEXT stays block-level from disk — token streaming is the Tier-2 tmux job.) */
  setStatus(state: 'working' | 'idle'): void {
    this.lastSeen = Date.now();
    // Emit BEFORE touching info.status: the owning ManagedConn derives and assigns the new status
    // from this frame (a pending permission still outranks it) and broadcasts only on a real
    // transition. Pre-mutating the shared info object made the transition invisible to that change
    // detection, so an authoritative turn boundary (UserPromptSubmit/Stop) never published a roster
    // revision until the next poll (R0c.1). The direct assignment remains only as the truthful
    // fallback while no subscriber owns the projection.
    this.emit({ type: 'status', status: state === 'working' ? 'running' : 'idle' });
    if (this.handlers.size === 0) this.info.status = state === 'working' ? 'working' : 'idle';
  }

  /** The hook relayed a permission/question. Emit the actionable card (idempotent on re-post). */
  ingestRequest(req: HookRequest): void {
    this.lastSeen = Date.now();
    if (this.pendingFrames.has(req.requestId) || this.resolved.has(req.requestId)) return; // already live / answered
    // Bound the live set so a flood of un-answered requests can't exhaust memory (auth gates this when a token
    // is set; cap the loopback case too). Evict the oldest pending and unblock its hook → it fails open by its
    // own deadline. (Review finding 2026-06-23: unbounded pendingFrames/waiters.)
    if (this.pendingFrames.size >= 200) {
      const oldest = this.pendingFrames.keys().next().value;
      if (oldest !== undefined) {
        this.pendingFrames.delete(oldest);
        const w = this.waiters.get(oldest);
        if (w) { this.waiters.delete(oldest); w(null); }
      }
    }
    if (req.kind === 'question') {
      this.emit({ type: 'question-request', requestId: req.requestId, questions: normalizeQuestions(req.questions) });
    } else {
      if (req.toolName) {
        this.emit({
          type: 'tool-call',
          callId: req.requestId,
          toolName: req.toolName,
          title: req.title,
          args: req.toolInput,
        });
      }
      this.emit({
        type: 'permission-request',
        requestId: req.requestId,
        title: req.title || (req.toolName ? `${req.toolName} permission` : 'Permission request'),
        toolName: req.toolName,
        detail: req.detail,
      });
    }
  }

  /** The hook long-polls this for a specific request's decision. Resolves immediately if already answered,
   *  else waits up to `timeoutMs`, then returns null so the hook re-posts (it owns the overall deadline). */
  awaitDecision(requestId: string, timeoutMs: number): Promise<HookDecision | null> {
    this.lastSeen = Date.now();
    const ready = this.resolved.get(requestId);
    if (ready) return Promise.resolve(ready);
    // A duplicate poll for the same requestId (network dup / overlapping re-post) supersedes the prior one —
    // release the old waiter with null so its HTTP request returns and re-polls, instead of hanging to timeout.
    const prev = this.waiters.get(requestId);
    if (prev) { this.waiters.delete(requestId); prev(null); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.waiters.get(requestId) === wake) this.waiters.delete(requestId); resolve(null); }, timeoutMs);
      const wake = (d: HookDecision | null) => { clearTimeout(timer); if (this.waiters.get(requestId) === wake) this.waiters.delete(requestId); resolve(d); };
      this.waiters.set(requestId, wake);
    });
  }

  private settle(requestId: string, d: HookDecision): void {
    // Fail-safe: a decision whose KIND doesn't match the pending request (e.g. a permission 'approve' routed at
    // a question requestId) is downgraded to reject, so a hook can never receive an answer of the wrong shape.
    const frame = this.pendingFrames.get(requestId);
    if (frame && d.kind !== 'reject') {
      const expected = frame.type === 'question-request' ? 'answer' : 'permission';
      if (d.kind !== expected) d = { kind: 'reject' };
    }
    // `resolved` must persist (so a hook RE-POST after the answer is idempotent — ingestRequest checks it and
    // does NOT re-emit an already-answered card), so it can't be deleted eagerly. Bound it FIFO instead: an
    // evicted entry is one whose tool finished long ago, so a (vanishingly unlikely) late re-post just re-cards.
    this.resolved.set(requestId, d);
    if (this.resolved.size > 1000) { const oldest = this.resolved.keys().next().value; if (oldest !== undefined) this.resolved.delete(oldest); }
    const w = this.waiters.get(requestId);
    if (w) w(d);
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.settle(requestId, { kind: 'permission', decision });
    this.emit({ type: 'permission-resolved', requestId, decision });
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    this.settle(requestId, { kind: 'answer', answers });
    this.emit({ type: 'question-resolved', requestId });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    this.settle(requestId, { kind: 'reject' });
    this.emit({ type: 'question-resolved', requestId });
  }

  async getHistory(_query?: HistoryQuery): Promise<AgentMessage[]> {
    return this.observe.getHistory();
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return this.observe.getHistorySourceIdentity();
  }

  /** Live hook frames only — the actionable permission/question the browser must see if it joins blocked.
   *  (Observe's read-only on-disk card is intentionally NOT included; the hook channel supersedes it.) */
  getPending(): AgentMessage[] {
    return [...this.pendingFrames.values()];
  }

  async sendPrompt(_input: PromptInput): Promise<void> {
    // A hooks-synced session is the user's own live terminal session; there is no live-inject path (the
    // archived channel was the only one, and it's gated). Be honest rather than silently dropping the text.
    this.fan({
      type: 'error',
      message: 'Sending a new message to a hooks-synced Claude session is not supported yet — answer prompts and questions here, or use Drive to take over a fork.',
    });
  }

  async listCommands(): Promise<SlashCommand[]> {
    return this.observe.listCommands();
  }
  async listModels(): Promise<ModelOption[]> {
    return this.observe.listModels();
  }
  async listModes(): Promise<ModeOption[]> {
    return this.observe.listModes();
  }

  async close(): Promise<void> {
    // Fail-OPEN to the terminal: wake any blocked hook poll with null so Claude falls back to its own
    // permission flow (the human at the terminal) — never an auto-allow.
    for (const [id, w] of this.waiters) { try { w(null); } catch { /* ignore */ } this.waiters.delete(id); }
    try { this.observeUnsub?.(); } catch { /* ignore */ }
    try { await this.observe.close?.(); } catch { /* ignore */ }
    this.handlers.clear();
    this.pendingFrames.clear();
    this.resolved.clear();
  }
}

/**
 * Tracks live Claude hook bridges by session id and adopts/evicts them in the Hub. Same teardown policy as
 * PiBridgeRegistry: a `bye` with no/unknown reason is DEFERRED by `graceMs` so a same-id re-hello (e.g. the
 * user restarting claude in the same session, or a SessionStart re-announce) reclaims the live connection
 * without orphaning an attached phone; a definitive `quit` tears down now.
 */
export class ClaudeHooksRegistry {
  private readonly conns = new Map<string, ClaudeHooksConnection>();
  private readonly pendingBye = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onTeardown: (id: string, reason: string) => void | Promise<void>,
    private readonly graceMs = 4000,
  ) {}

  has(id: string): boolean { return this.conns.has(id); }
  get(id: string): ClaudeHooksConnection | undefined { return this.conns.get(id); }

  hello(id: string, info: SessionInfo, transcriptPath: string): ClaudeHooksConnection {
    this.clearPendingBye(id);
    const existing = this.conns.get(id);
    if (existing) { existing.replaceInfo(info); return existing; }
    const conn = new ClaudeHooksConnection(info, transcriptPath);
    this.conns.set(id, conn);
    return conn;
  }

  bye(id: string, reason?: string): void {
    if (!this.conns.has(id)) { this.clearPendingBye(id); return; }
    const deferrable = !reason || reason === 'reload' || reason === 'clear';
    if (deferrable) {
      this.clearPendingBye(id);
      this.pendingBye.set(id, setTimeout(() => { this.pendingBye.delete(id); if (this.conns.has(id)) this.teardown(id, reason || 'reload'); }, this.graceMs));
      return;
    }
    this.teardown(id, reason);
  }

  private teardown(id: string, reason: string): void {
    this.clearPendingBye(id);
    if (!this.conns.delete(id)) return;
    void this.onTeardown(id, reason);
  }

  private clearPendingBye(id: string): void {
    const t = this.pendingBye.get(id);
    if (t) { clearTimeout(t); this.pendingBye.delete(id); }
  }
}
