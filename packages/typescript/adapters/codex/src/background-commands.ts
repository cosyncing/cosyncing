import { BACKGROUND_REEMIT_MIN_MS, type AgentMessage, type ToolOutputStream } from '@cosyncing/adapter-api';
import { recoverBackgroundItems } from './background-history.ts';

type Activity = Extract<AgentMessage, { type: 'agent-activity' }>;
type Obj = Record<string, any>;
export { BACKGROUND_REEMIT_MIN_MS };
export const BACKGROUND_STALE_MS = 30_000;
export const BACKGROUND_ENTRY_LIMIT = 128;
const RUNNING_LIMIT = 16;
const RESULT_LIMIT = 8;
const obj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const ms = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const label = (value: string, limit: number) => value.length > limit ? value.slice(0, limit - 1) + '…' : value;
const identity = (itemId: string, processId: string) => JSON.stringify([itemId, processId]);

export interface BackgroundRow { itemId: string; processId: string; command: string }
export function backgroundPage(value: unknown): { rows: BackgroundRow[]; cursor: string | null } {
  if (!obj(value) || !Array.isArray(value.data) || value.data.length > 32
    || !(value.nextCursor === null || id(value.nextCursor))) throw new Error('Invalid background terminal page');
  const rows = value.data.map((row: unknown) => {
    if (!obj(row) || !id(row.itemId) || !id(row.processId) || typeof row.command !== 'string'
      || row.command.length > 32_768 || typeof row.cwd !== 'string') throw new Error('Invalid background terminal row');
    return { itemId: row.itemId, processId: row.processId, command: row.command };
  });
  return { rows, cursor: value.nextCursor };
}

function tail(text: string, previousTruncation = false): ToolOutputStream | undefined {
  const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (!clean) return undefined;
  const lines = clean.split('\n');
  const clipped = lines.slice(-40).join('\n');
  const bytes = Buffer.from(clipped);
  // Decode after the byte boundary, discarding a possible split leading codepoint.
  const textTail = bytes.length > 4096 ? bytes.subarray(-4096).toString('utf8').replace(/^\ufffd+/, '') : clipped;
  return { text: textTail, ...(previousTruncation || lines.length > 40 || bytes.length > 4096 ? { truncated: true } : {}) };
}

interface Entry {
  itemId: string; processId: string; command: string; turnId?: string;
  admitted: boolean; status: Activity['status']; startedAtMs?: number; endedAtMs?: number;
  elapsedMs?: number; exitCode?: number; output?: ToolOutputStream;
  observedAt: number; evidenceAt: number; changed: number; terminalAt?: number;
  generation?: number;
}

/** Pure, bounded evidence ledger. No rollout liveness, process controls, or runtime startup. */
export class CodexBackgroundLedger {
  private readonly entries = new Map<string, Entry>();
  private revision = 0;
  constructor(private readonly scope: string, private readonly emit: (message: Activity) => void) {}

  restore(entries: Entry[]): void {
    for (const entry of entries.slice(-BACKGROUND_ENTRY_LIMIT)) {
      this.entries.set(identity(entry.itemId, entry.processId), { ...entry, changed: ++this.revision });
    }
  }
  save(): Entry[] { return [...this.entries.values()].map((entry) => ({ ...entry })); }
  version(): number { return this.revision; }

  private entry(row: BackgroundRow, now: number): Entry {
    const key = identity(row.itemId, row.processId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    while (this.entries.size >= BACKGROUND_ENTRY_LIMIT) {
      const oldest = [...this.entries.entries()].sort((a, b) => Number(a[1].admitted && a[1].status === 'running')
        - Number(b[1].admitted && b[1].status === 'running') || a[1].observedAt - b[1].observedAt)[0]!;
      if (oldest[1].admitted && oldest[1].status === 'running') this.retire(oldest[1]);
      this.entries.delete(oldest[0]);
    }
    const entry: Entry = { ...row, command: label(row.command, 200), status: 'running', admitted: false,
      observedAt: now, evidenceAt: now, changed: ++this.revision };
    this.entries.set(key, entry);
    return entry;
  }

  notification(method: string, params: unknown, now: number): void {
    if (!obj(params)) return;
    if (method === 'turn/completed' && obj(params.turn) && id(params.turn.id)) {
      // A process with an exact start and no completion still outliving its turn.
      for (const entry of this.entries.values()) {
        if (entry.turnId === params.turn.id && entry.status === 'running'
          && now - entry.evidenceAt < BACKGROUND_STALE_MS) this.admit(entry);
      }
      return;
    }
    if (method === 'item/commandExecution/outputDelta' && id(params.itemId) && typeof params.delta === 'string' && params.delta.length > 0) {
      for (const entry of this.entries.values()) {
        if (entry.itemId !== params.itemId || entry.status === 'done' || entry.status === 'error') continue;
        if (entry.turnId && entry.turnId !== params.turnId) continue;
        entry.output = tail((entry.output?.text ?? '') + params.delta.slice(-8192), true);
        entry.evidenceAt = now;
        entry.changed = ++this.revision;
        if (entry.admitted && entry.status === 'retired' && entry.turnId === params.turnId && id(params.turnId)
          && [...this.entries.values()].filter((candidate) => candidate.itemId === params.itemId && candidate.turnId === params.turnId).length === 1) {
          entry.status = 'running';
          this.admit(entry); // enforce the running window on restoration too
        }
      }
      return;
    }
    const item = params.item;
    if ((method !== 'item/started' && method !== 'item/completed') || !this.commandItem(item)) return;
    if (method === 'item/started' && item.status !== 'inProgress') return;
    const previous = this.entries.get(identity(item.id, item.processId));
    const nextStart = method === 'item/started' ? ms(params.startedAtMs) : undefined;
    const reused = previous?.endedAtMs !== undefined && nextStart !== undefined && nextStart > previous.endedAtMs;
    if (reused) this.entries.delete(identity(item.id, item.processId));
    const entry = this.entry({ itemId: item.id, processId: item.processId, command: item.command }, now);
    if (reused) entry.generation = (previous?.generation ?? 0) + 1;
    if (entry.status === 'done' || entry.status === 'error') return;
    if (entry.turnId && params.turnId !== entry.turnId) return;
    entry.turnId ??= id(params.turnId) ? params.turnId : undefined;
    entry.startedAtMs ??= method === 'item/started' ? ms(params.startedAtMs) : undefined;
    if (method === 'item/completed') this.complete(entry, item, now, ms(params.completedAtMs));
    else {
      const startEvidence = Math.min(now, ms(params.startedAtMs) ?? (previous && !reused ? entry.evidenceAt : now));
      entry.evidenceAt = previous && !reused ? Math.max(entry.evidenceAt, startEvidence) : startEvidence;
      entry.changed = ++this.revision;
    }
  }

  private commandItem(item: unknown): item is Obj {
    return obj(item) && item.type === 'commandExecution' && id(item.id) && id(item.processId)
      && item.source === 'unifiedExecStartup' && typeof item.command === 'string';
  }

  history(item: unknown, now: number, turnId?: string): void {
    if (!this.commandItem(item)) return;
    // Historical foreground commands are not retroactively labelled background work.
    const entry = this.entries.get(identity(item.id, item.processId));
    if (entry?.admitted && (!entry.turnId || entry.turnId === turnId)) this.complete(entry, item, now);
  }

  private complete(entry: Entry, item: Obj, now: number, endedAtMs?: number): void {
    if (entry.status === 'done' || entry.status === 'error') return;
    if ((item.status !== 'completed' && item.status !== 'failed') || !Number.isSafeInteger(item.exitCode)
      || (item.status === 'completed') !== (item.exitCode === 0)) return;
    entry.status = item.exitCode === 0 ? 'done' : 'error';
    entry.exitCode = item.exitCode;
    entry.endedAtMs = endedAtMs;
    entry.elapsedMs = ms(item.durationMs);
    entry.terminalAt = now; // observation time, never presented as an actual process end time
    entry.changed = ++this.revision;
    if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) {
      // Native completion output can omit the initial yield: always an available tail.
      entry.output = tail(item.aggregatedOutput.slice(-8192), true);
    }
    if (entry.admitted) this.emit(this.card(entry)); // deliver BEFORE any result-window eviction
  }

  snapshot(rows: BackgroundRow[], startedVersion: number, now: number): void {
    const seen = new Set(rows.map((row) => identity(row.itemId, row.processId)));
    for (const row of rows) {
      const previous = this.entries.get(identity(row.itemId, row.processId));
      const entry = this.entry(row, now);
      if (entry.status === 'done' || entry.status === 'error' || previous && entry.changed > startedVersion) continue;
      entry.status = 'running';
      entry.evidenceAt = now;
      this.admit(entry);
    }
    for (const [key, entry] of this.entries) {
      if (entry.admitted && entry.status === 'running' && entry.changed <= startedVersion && !seen.has(key)) this.retire(entry);
    }
  }

  private admit(entry: Entry): void {
    if (!entry.admitted) {
      entry.admitted = true;
      entry.changed = ++this.revision;
      this.emit(this.card(entry));
    }
    const active = [...this.entries.values()].filter((row) => row.admitted && row.status === 'running');
    for (const old of active.slice(0, Math.max(0, active.length - RUNNING_LIMIT))) this.retire(old);
  }
  private retire(entry: Entry): void {
    entry.status = 'retired';
    entry.changed = ++this.revision;
    this.emit(this.card(entry));
  }
  expire(now: number): void {
    for (const entry of this.entries.values()) {
      if (entry.admitted && entry.status === 'running' && now - entry.evidenceAt >= BACKGROUND_STALE_MS) this.retire(entry);
    }
  }
  needsRecovery(rows?: BackgroundRow[]): boolean {
    const seen = rows && new Set(rows.map((row) => identity(row.itemId, row.processId)));
    return [...this.entries.values()].some((entry) => entry.admitted && !['done', 'error'].includes(entry.status)
      && !seen?.has(identity(entry.itemId, entry.processId)));
  }
  recoveryTurnIds(): string[] {
    return [...new Set([...this.entries.values()].filter((entry) => entry.admitted
      && !['done', 'error'].includes(entry.status)).map((entry) => entry.turnId).filter((value): value is string => !!value))].slice(0, 4);
  }
  cards(): Activity[] {
    const visible = [...this.entries.values()].filter((entry) => entry.admitted && entry.status !== 'retired');
    const finished = visible.filter((entry) => entry.status !== 'running')
      .sort((a, b) => (b.endedAtMs ?? b.terminalAt ?? 0) - (a.endedAtMs ?? a.terminalAt ?? 0)).slice(0, RESULT_LIMIT);
    return [...visible.filter((entry) => entry.status === 'running'), ...finished].map((entry) => this.card(entry));
  }
  /** Replay retained outcomes without dismissing them. Reconcile running identities even
   * after eviction or broker restart; completed client cards are never cleared by this event. */
  replayCards(): AgentMessage[] {
    const current = this.cards();
    const visible = new Set(current.map((card) => card.key));
    const resolutions: Activity[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.admitted) continue;
      const { output: _output, ...card } = this.card(entry);
      if (visible.has(card.key)) continue;
      resolutions.push(card);
    }
    return [...resolutions, ...current, {
      type: 'event', name: 'codex.background-running-snapshot',
      payload: { keys: current.filter((card) => card.status === 'running').map((card) => card.key) },
    }];
  }
  private card(entry: Entry): Activity {
    return { type: 'agent-activity', kind: 'command', key: `cmd:codex:${this.scope}:${identity(entry.itemId, entry.processId)}:${entry.generation ?? 0}`,
      title: label(entry.command.split('\n').find((line) => line.trim()) ?? entry.command, 120), subtitle: entry.command,
      status: entry.status, ...(entry.startedAtMs === undefined ? {} : { startedAtMs: entry.startedAtMs }),
      ...(entry.elapsedMs === undefined ? {} : { elapsedMs: entry.elapsedMs }),
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }), ...(entry.output ? { output: entry.output } : {}) };
  }
}

type Rpc = (method: string, params: unknown, timeoutMs: number) => Promise<any>;
const retained = new Map<string, { at: number; entries: Entry[]; unsupported: string[]; owner: number }>();
let retentionOwner = 0;
function unsupported(error: unknown, method: string): boolean {
  return obj(error) && (error.rpcCode === -32601 || error.rpcCode === -32600
    && typeof error.message === 'string' && (/requires experimentalApi capability/.test(error.message)
      || error.message.startsWith(`Invalid request: unknown variant \`${method}\`, expected one of `)));
}

/** One observer on the already-owned connection. Client count, not adapter subscribers, gates RPCs. */
export class CodexBackgroundCommands {
  readonly ledger: CodexBackgroundLedger;
  private active = false;
  private closed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private failures = 0;
  private readonly retentionOwner = ++retentionOwner;
  private readonly disabled = new Set<string>();
  private readonly emitted = new Map<string, { signature: string; at: number; status: Activity['status'] }>();
  constructor(private readonly threadId: string, private readonly scope: string, private readonly rpc: Rpc,
    private readonly emit: (message: AgentMessage) => void, private readonly now: () => number = Date.now) {
    this.ledger = new CodexBackgroundLedger(scope, (message) => this.publish(message));
    const old = retained.get(scope);
    if (old && now() - old.at < 6 * 60 * 60_000) {
      this.ledger.restore(old.entries);
      for (const method of old.unsupported) this.disabled.add(method);
    }
    this.retain();
  }
  setClientCount(count: number): void {
    if (this.closed || this.active === (count > 0)) return;
    this.active = count > 0;
    this.generation++;
    clearTimeout(this.timer);
    this.retain();
    if (this.active) void this.reconcile();
  }
  notification(method: string, params: unknown): void {
    if (this.closed || !obj(params) || params.threadId !== this.threadId) return;
    this.ledger.notification(method, params, this.now());
    for (const card of this.ledger.cards()) this.publish(card);
    this.retain(); // a replacement is constructed before its predecessor closes
  }
  cards(): Activity[] { this.ledger.expire(this.now()); this.retain(); return this.ledger.cards(); }
  replayCards(): AgentMessage[] { this.ledger.expire(this.now()); this.retain(); return this.ledger.replayCards(); }
  private publish(message: Activity): void {
    if (!this.active || this.closed) return;
    const signature = JSON.stringify(message);
    const old = this.emitted.get(message.key);
    if (old?.signature === signature || message.status === 'running' && old?.status === 'running' && this.now() - old.at < BACKGROUND_REEMIT_MIN_MS) return;
    this.emitted.delete(message.key);
    this.emitted.set(message.key, { signature, at: this.now(), status: message.status });
    while (this.emitted.size > BACKGROUND_ENTRY_LIMIT) this.emitted.delete(this.emitted.keys().next().value!);
    this.emit(message);
  }
  async reconcile(): Promise<void> {
    if (this.closed || !this.active) return;
    if (this.flight) return this.flight;
    clearTimeout(this.timer);
    const generation = this.generation;
    const valid = () => !this.closed && this.active && this.generation === generation;
    this.flight = this.sweep(valid).finally(() => {
      if (valid()) this.retain();
      this.flight = undefined;
      if (this.active && !this.closed) this.timer = setTimeout(() => void this.reconcile(),
        this.generation !== generation ? 0 : Math.min(10_000, BACKGROUND_REEMIT_MIN_MS * 2 ** this.failures));
    });
    return this.flight;
  }
  private async request(method: string, params: unknown): Promise<any> {
    if (this.disabled.has(method)) throw new Error('Unsupported background capability');
    try { return await this.rpc(method, params, 1500); }
    catch (error) {
      if (unsupported(error, method)) {
        this.disabled.add(method);
        if (this.active && !this.closed) this.emit({ type: 'event', name: 'codex-background-capability', payload: { method, supported: false } });
      }
      throw error;
    }
  }
  private async sweep(valid: () => boolean): Promise<void> {
    this.ledger.expire(this.now());
    const version = this.ledger.version();
    const rows: BackgroundRow[] = [];
    let cursor: string | null = null;
    let complete = false;
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < 4 && valid(); page++) {
        const value = await this.request('thread/backgroundTerminals/list', { threadId: this.threadId, cursor, limit: 32 });
        if (!valid()) return;
        if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('Background page byte budget exceeded');
        const parsed = backgroundPage(value);
        rows.push(...parsed.rows);
        if (new Set(rows.map((row) => identity(row.itemId, row.processId))).size !== rows.length) throw new Error('Repeated background row');
        cursor = parsed.cursor;
        if (cursor === null) { complete = true; break; }
        if (cursors.has(cursor)) throw new Error('Repeated background cursor');
        cursors.add(cursor);
      }
      if (!complete) throw new Error('Incomplete background snapshot');
      this.failures = 0;
    } catch { this.failures = Math.min(2, this.failures + 1); }
    if (!valid()) return;
    // Recover exact outcomes before an absent row is withdrawn. Never interpret a partial
    // history window as absence, and never use a whole-thread read to recover a small card.
    if (this.ledger.needsRecovery(complete ? rows : undefined)) {
      await recoverBackgroundItems({ threadId: this.threadId, turnIds: this.ledger.recoveryTurnIds(),
        request: (method, params) => this.request(method, params), disabled: (method) => this.disabled.has(method),
        consume: (item, turnId) => this.ledger.history(item, this.now(), turnId), needed: () => this.ledger.needsRecovery(), valid });
    }
    if (!valid()) return;
    if (complete) this.ledger.snapshot(rows, version, this.now());
    this.ledger.expire(this.now());
    for (const card of this.ledger.cards()) this.publish(card);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.retain();
    this.emitted.clear();
  }
  private retain(): void {
    // An old socket closing after its replacement must not overwrite newer evidence.
    if ((retained.get(this.scope)?.owner ?? 0) > this.retentionOwner) return;
    retained.delete(this.scope);
    retained.set(this.scope, { at: this.now(), entries: this.ledger.save(), unsupported: [...this.disabled], owner: this.retentionOwner });
    while (retained.size > 32) retained.delete(retained.keys().next().value!);
  }
}
