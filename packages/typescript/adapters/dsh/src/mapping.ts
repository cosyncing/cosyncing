/**
 * DeepSeek Harness native payloads → the canonical protocol shapes.
 *
 * Every dsh-native field name is confined to this file and its callers inside
 * this package; nothing dsh-shaped reaches the broker or the client.
 *
 * THE PLUGIN-FOUNDATION CONTRACT LIVES HERE. dsh has thousands of community
 * plugins, and its protocol is deliberately built so a client never learns their
 * names: the event vocabulary is merge-extensible, tool cards arrive as a
 * host-computed `view`, and per-session state arrives as opaque projection
 * values. This mapping preserves all three properties:
 *
 *  1. VERBATIM PASSTHROUGH, NO ALLOWLIST. The three surface types and a small
 *     set of structural types get exact canonical shapes. Every other event type
 *     — including types this build has never seen — becomes an opaque activity
 *     record naming only its type and seq. Nothing is dropped, nothing crashes,
 *     and no switch ever asserts exhaustiveness over a merge-extensible union.
 *     `ignorable: true` is the one documented licence to omit an event entirely.
 *  2. TOOL VIEWS ONCE, GENERIC FALLBACK ALWAYS. {@link mapToolCallView} and
 *     {@link mapToolResultView} switch on the `card` discriminant of the
 *     `dsh-tools` presentation vocabulary and NOTHING else. An absent view, an
 *     unknown card, or a structurally wrong one renders through the generic JSON
 *     card, which is the product's own documented default. There is no per-tool
 *     branch anywhere in this package.
 *  3. GENERIC PROJECTION STORE. {@link DshProjectionStore} keeps every key the
 *     host publishes under higher-seq-wins. Named consumers read the keys they
 *     understand; unknown keys are kept and readable, never discarded, and never
 *     forwarded as raw dsh-shaped values.
 *
 * Captured against dsh 0.1.0-rc.6 (see `test/fixtures/dsh-0.1.0-rc.6.json`).
 */
import {
  boundContextBody,
  CONTEXT_INJECTION_EVENT,
  unwrapContextBlock,
} from '@cosyncing/adapter-api';
import type {
  AgentMessage,
  ContextInjectionPayload,
  SessionInfo,
  ToolDisplayClass,
  ToolSemantic,
} from '@cosyncing/adapter-api';

// ── Native shapes (structural, deliberately permissive) ─────────────────────

/** One entry in the append-only session log, as far as this adapter reads it. */
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data?: unknown;
  /** A reader that does not recognize `type` may safely skip the event. */
  ignorable?: boolean;
  sourceEventSeqs?: number[];
  /** `'append'` or `{op:'replace', start, end}`; present only on surface events. */
  surfaceOp?: unknown;
}

/** One `session.history` item: the event plus its optional host-computed tool view. */
export interface DshHistoryEntry {
  event: DshSessionEvent;
  view?: unknown;
}

export interface DshProjectionsBlock {
  /** `-1` means an empty log, matching `session/subscribed`'s lastSeq convention. */
  asOfSeq: number;
  values: Record<string, unknown>;
}

export interface DshSessionSummary {
  sessionId?: unknown;
  updatedAt?: unknown;
  running?: unknown;
  blank?: unknown;
  parentSessionId?: unknown;  origin?: unknown;
  cwd?: unknown;
  agentPreset?: unknown;
  projections?: unknown;
}

export interface DshWorkspaceSummary {
  workspaceId?: unknown;
  path?: unknown;
  title?: unknown;
  sessionIds?: unknown;
}

/** The tool id every canonical row carries. */
export const DSH_TOOL_ID = 'dsh';

/** Bound on an injected-context excerpt. A skill catalog is megabytes; a notice is a line. */
export const DSH_NOTICE_MAX_CHARS = 240;

// ── Small helpers ───────────────────────────────────────────────────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function bounded(text: string): string {
  return text.length <= DSH_NOTICE_MAX_CHARS ? text : `${text.slice(0, DSH_NOTICE_MAX_CHARS - 1)}…`;
}

/**
 * Flatten `ContentBlock[]` to the visible text. `text` blocks are the only
 * user-visible carrier; a `reasoning`, `image`, or plugin-added block leaves no
 * text behind rather than being stringified into the bubble.
 */
export function dshContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** Pretty JSON for a generic card body, bounded so an enormous payload cannot be inlined whole. */
function jsonCard(value: unknown, maxChars = 4_000): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, undefined, 2) ?? '';
  } catch {
    return '[unserializable]';
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`;
}

// ── Projection store ────────────────────────────────────────────────────────

export interface DshProjectionEntry {
  value: unknown;
  seq: number;
}

/**
 * One generic per-session key → value store under higher-seq-wins.
 *
 * Generic ON PURPOSE. A dsh plugin can register a projection unit under any key,
 * and a client that only kept keys it recognized would silently discard the
 * state of every plugin the user actually installed. Named consumers ask for the
 * keys they understand; the rest stay readable here, and ABSENCE of a key is how
 * a capability announces it is not installed.
 */
export class DshProjectionStore {
  private readonly entries = new Map<string, DshProjectionEntry>();

  /**
   * Seed from a history tail page's projections block — one consistent cut.
   *
   * The cut is a STALE-OK baseline: the host may have advanced while the
   * history RPC was in flight, so a held row NEWER than `asOfSeq` is live state
   * the cut merely predates. It is always preserved, and the baseline's value
   * for that key is refused by {@link apply}'s equal-or-newer rule. Only a held
   * row the cut omits AND does not postdate was removed upstream — clearing it
   * is what keeps a deleted projection unit or a stale `sessionStats` from
   * surviving a reconnect. Rows beyond a RESTARTED host's log are NOT handled
   * here: a history response cannot prove a new generation, so that cleanup
   * lives in {@link truncate}, driven by `session/subscribed`'s lastSeq.
   */
  seed(block: unknown): string[] {
    const parsed = record(block);
    const values = record(parsed?.values);
    const asOfSeq = optionalNumber(parsed?.asOfSeq);
    if (!values || asOfSeq === undefined) return [];
    for (const [key, entry] of this.entries) {
      // Object.hasOwn, NOT `in`: an inherited property (a held projection
      // literally named "constructor") is not a key the baseline supplied.
      if (entry.seq <= asOfSeq && !Object.hasOwn(values, key)) this.entries.delete(key);
    }
    const adopted: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (this.apply(key, value, asOfSeq)) adopted.push(key);
    }
    return adopted;
  }

  /**
   * Discard every row beyond `lastSeq`; returns true when anything was
   * dropped. Only `session/subscribed` calls this: a host whose log tail is
   * BEHIND a held row has restarted — log seqs only move forward within one
   * generation — and that row belonged to the previous life. A history
   * baseline is not such evidence: see {@link seed}. The caller needs the
   * boolean because dropped rows may already have been DELIVERED, and those
   * messages then have to be retracted via a wholesale history reset.
   */
  truncate(lastSeq: number): boolean {
    let dropped = false;
    for (const [key, entry] of this.entries) {
      if (entry.seq > lastSeq) {
        this.entries.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Adopt one unit value. Returns false when an equal-or-newer value is held. */
  apply(key: string, value: unknown, seq: number): boolean {
    if (!key) return false;
    const held = this.entries.get(key);
    if (held && held.seq >= seq) return false;
    this.entries.set(key, { value, seq });
    return true;
  }

  get(key: string): unknown {
    return this.entries.get(key)?.value;
  }

  seqOf(key: string): number | undefined {
    return this.entries.get(key)?.seq;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Canonical rows for the projection keys this build understands.
 *
 * An unknown key produces NOTHING on the wire and stays in the store: forwarding
 * an unrecognized plugin value would put a dsh-shaped payload into the shared
 * protocol, which is exactly what this package exists to prevent.
 *
 * `tokenUsage` is deliberately not forwarded either. It is a whole-session
 * running total, and the canonical `token-count` message is defined as a
 * per-reading figure — publishing cumulative totals there produces nonsense
 * context percentages. Per-step usage rides `assistant/message.usage` instead,
 * and per-turn sums ride the `run-summary` fold documented on {@link DshMapState}.
 *
 * `sessionStats` IS forwarded as `runtimeTotals`: it is the host's own
 * whole-log, authoritative turn/step counts and model/tool wall times, immune
 * to this client's bounded history window — which is exactly why the fold
 * never publishes session-wide totals of its own. It carries no native
 * whole-session wall clock, so `totalRuntimeMs` stays absent rather than
 * summed from a partial window; a complete active-time figure belongs to a
 * whole-log consumer (the planned tokdash aggregate).
 *
 * FORK CHILDREN ARE SUPPRESSED: upstream folds the whole PHYSICAL log, so a
 * forked session's `sessionStats` includes its inherited parent prefix — and
 * the parent already publishes those same figures under its own session.
 * Publishing both would double-count the inherited work, and the wire exposes
 * no header `seedLength` to subtract it by, so a session with a
 * `parentThreadId` emits no `runtimeTotals` until a seed-aware totals source
 * exists.
 */
export function dshProjectionMessages(
  key: string,
  value: unknown,
  options: { forkedChild?: boolean } = {},
): AgentMessage[] {
  switch (key) {
    case 'title': {
      const title = optionalString(value);
      return title ? [{ type: 'metadata-update', key: 'sessionInfo', value: { title } }] : [];
    }
    case 'contextPressure': {
      const pressure = record(value);
      const used = optionalNumber(pressure?.pressureTokens);
      const max = optionalNumber(pressure?.contextWindow);
      if (used === undefined || max === undefined || max <= 0) return [];
      return [{ type: 'metadata-update', key: 'contextUsage', value: { used, max } }];
    }
    case 'sessionStats': {
      // A fork child's whole-log figures include the inherited parent prefix,
      // which the parent publishes too — see the doc header.
      if (options.forkedChild === true) return [];
      const stats = record(value);
      const turns = optionalNumber(stats?.turns);
      const llmMs = optionalNumber(stats?.llmMs);
      const toolMs = optionalNumber(stats?.toolMs);
      if (turns === undefined || llmMs === undefined || toolMs === undefined) return [];
      // `turns` is a count: the installed schema requires a non-negative integer.
      if (!Number.isSafeInteger(turns) || turns < 0 || llmMs < 0 || toolMs < 0) return [];
      return [{
        type: 'metadata-update',
        key: 'runtimeTotals',
        value: { agentRuntimeMs: llmMs, executionRuntimeMs: toolMs, turnCount: turns, source: 'dsh' },
      }];
    }
    case 'todos':
      return dshTodoMessages(value, 'projection');
    case 'goal':
      return dshGoalMessages(value);
    default:
      return [];
  }
}

function dshTodoMessages(value: unknown, source: 'projection' | 'event'): AgentMessage[] {
  const items = Array.isArray(value) ? value : Array.isArray(record(value)?.todos) ? (record(value)!.todos as unknown[]) : undefined;
  if (!items) return [];
  const mapped = items.flatMap((raw) => {
    const item = record(raw);
    const title = optionalString(item?.content);
    if (!title) return [];
    const status = item?.status === 'completed' ? 'done' : item?.status === 'in_progress' ? 'in-progress' : 'open';
    return [{ title, status } as { title: string; status: 'open' | 'in-progress' | 'done' }];
  });
  return [{
    type: 'task-list-state',
    key: 'dsh:todos',
    status: mapped.length === 0 ? 'cleared' : mapped.every((item) => item.status === 'done') ? 'done' : 'running',
    source: source === 'projection' ? 'native' : 'transcript',
    sourceTool: 'todo/write',
    items: mapped,
  }];
}

function dshGoalMessages(value: unknown): AgentMessage[] {
  const projection = record(value);
  if (!projection) return [{ type: 'goal-state', status: 'cleared' }];
  const goal = record(projection.goal);
  const objective = optionalString(goal?.objective);
  if (!objective) return [{ type: 'goal-state', status: 'cleared' }];
  const phase = goal?.phase;
  const status = phase === 'complete' ? 'done' : phase === 'blocked' ? 'blocked' : phase === 'paused' ? 'paused' : 'active';
  const startedAt = optionalNumber(projection.createdAt);
  return [{
    type: 'goal-state',
    ...(optionalString(goal?.id) ? { key: optionalString(goal?.id)! } : {}),
    title: objective,
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
  }];
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface DshSessionMapOptions {
  /** Workspace path/title for this session's workspace, when the caller resolved one. */
  workspaceTitle?: string;
  /** Live-attach availability: false while the host cannot be driven. */
  driveSupported?: boolean;
}

/**
 * No terminal exists in dsh AT ALL — there is no TUI to sync with, so the
 * terminal-sync channel is structurally impossible rather than inactive.
 * Mutation authority comes from `drive` alone (sessionConnectionAuthority
 * grants it for supported+driving), and claiming an active shared terminal
 * would misrank the owner projection as `terminal-sync` and show a "Synced"
 * affordance for a terminal that cannot exist. Shared between the roster
 * mapping and the live removal path.
 */
export const DSH_TERMINAL_SYNC_IMPOSSIBLE = Object.freeze({
  supported: false,
  syncAvailable: false,
  active: false,
  reason: 'DeepSeek Harness has no terminal UI; sessions live on the dsh web host and are driven by RPC.',
});

/**
 * Map one `session.list` row.
 *
 * dsh is server-first: the ONE host process owns every session, and any number
 * of clients — its own browser UI included — are peers writing through it. So a
 * discovered session is live-attachable rather than something to take ownership
 * of; mutation authority is carried by `drive` alone, and `terminalSync` is
 * reported structurally impossible, because dsh has no terminal UI to sync with.
 *
 * There is deliberately no `observe` fallback: dsh serves one undifferentiated
 * client contract, so an observe-mode row would promise a read-only attach the
 * adapter cannot honor. A host that cannot be driven reports `drive.supported:
 * false` and keeps `attachMode: 'live'` — unavailable, not mislabeled.
 */
export function mapDshSession(raw: DshSessionSummary, options: DshSessionMapOptions = {}): SessionInfo | undefined {
  const id = optionalString(raw?.sessionId);
  if (!id) return undefined;
  const store = new DshProjectionStore();
  store.seed(raw.projections);
  const title = optionalString(store.get('title'))
    ?? optionalString(options.workspaceTitle)
    ?? id;
  const cwd = optionalString(raw.cwd);
  const updatedAt = optionalNumber(raw.updatedAt);
  const driveSupported = options.driveSupported !== false;
  return {
    id,
    tool: DSH_TOOL_ID,
    title,
    ...(cwd ? { cwd } : {}),
    ...(raw.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(optionalString(raw.parentSessionId) ? { parentThreadId: optionalString(raw.parentSessionId)! } : {}),
    status: raw.running === true ? 'working' : 'idle',
    launchSurface: 'unknown',
    attachMode: 'live',
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(optionalString(raw.agentPreset) ? { currentAgent: optionalString(raw.agentPreset)! } : {}),
    control: {
      drive: {
        state: driveSupported ? 'driving' : 'unavailable',
        supported: driveSupported,
        // Stated, not inferred. dsh has one client contract and no read-only
        // credential, so it advertises `live` as its only attach mode and
        // refuses observe outright: there is no read-only session for terminal
        // handoff to leave attached, and the broker refuses the call for that
        // same reason. Declaring it here is what stops the app offering a
        // control whose only possible outcome is a refusal.
        handoffAvailable: false,
        ...(driveSupported ? {} : { reason: 'dsh-host-unreachable' }),
      },
      terminalSync: DSH_TERMINAL_SYNC_IMPOSSIBLE,
    },
  };
}

// ── Surface folding ─────────────────────────────────────────────────────────

function surfaceReplace(event: DshSessionEvent): { start: number; end: number } | undefined {
  const op = record(event.surfaceOp);
  if (!op || op.op !== 'replace') return undefined;
  const start = optionalNumber(op.start);
  const end = optionalNumber(op.end);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function isSurfaceEvent(event: DshSessionEvent): boolean {
  return event.surfaceOp !== undefined;
}

/**
 * Apply `surfaceOp` replaces so a folded history shows the CURRENT surface.
 *
 * Compaction rewrites a range of surface nodes into one summary node. Replaying
 * the shadowed originals alongside their replacement would show the user a
 * transcript the model can no longer see, so the shadowed nodes are removed and
 * the replacement takes the position the range occupied. Log-only events are
 * untouched: they never entered the surface and never leave it.
 */
export function foldDshSurface(entries: readonly DshHistoryEntry[]): DshHistoryEntry[] {
  const out: DshHistoryEntry[] = [];
  for (const entry of entries) {
    const replace = surfaceReplace(entry.event);
    if (!replace) {
      out.push(entry);
      continue;
    }
    let insertAt = -1;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const candidate = out[index]!;
      if (!isSurfaceEvent(candidate.event)) continue;
      if (candidate.event.seq < replace.start || candidate.event.seq > replace.end) continue;
      out.splice(index, 1);
      insertAt = index;
    }
    if (insertAt >= 0) out.splice(insertAt, 0, entry);
    else out.push(entry);
  }
  return out;
}

// ── Tool views ──────────────────────────────────────────────────────────────

function toolClassForKind(kind: unknown): ToolDisplayClass {
  switch (kind) {
    case 'execute':
      return 'execute';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'read':
    case 'search':
    case 'fetch':
      return 'lookup';
    default:
      return 'other';
  }
}

function unifiedDiff(diffs: unknown): { diff: string; paths: string[] } {
  if (!Array.isArray(diffs)) return { diff: '', paths: [] };
  const chunks: string[] = [];
  const paths: string[] = [];
  for (const raw of diffs) {
    const file = record(raw);
    const path = optionalString(file?.path);
    if (!path) continue;
    paths.push(path);
    const oldText = typeof file?.oldText === 'string' ? file.oldText : undefined;
    const newText = typeof file?.newText === 'string' ? file.newText : '';
    // The host hands over before/after text, never a patch, so the adapter emits
    // a whole-file diff rather than inventing hunk arithmetic it cannot verify.
    const oldLines = oldText === undefined ? [] : oldText.length ? oldText.split('\n') : [];
    const newLines = newText.length ? newText.split('\n') : [];
    chunks.push([
      `diff --git a/${path} b/${path}`,
      oldText === undefined ? '--- /dev/null' : `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join('\n'));
  }
  return { diff: chunks.join('\n'), paths };
}

export interface DshToolPresentation {
  title?: string;
  toolClass?: ToolDisplayClass;
  semantic?: ToolSemantic;
  path?: string;
  diff?: string;
  result?: unknown;
  isError?: boolean;
  exitCode?: number;
  truncated?: boolean;
}

/**
 * Host-computed CALL view → canonical presentation fields.
 *
 * Switches on `card` and nothing else. An unknown card keeps the generic path,
 * so a plugin shipping a new card renders as a titled JSON card instead of
 * disappearing or crashing the fold.
 */
export function mapToolCallView(view: unknown): DshToolPresentation {
  const wrapper = record(view);
  const inner = record(wrapper?.view);
  // No view: the pending card is the tool name plus its raw arguments, which the
  // caller already carries. Nothing to add, and nothing to invent.
  if (!inner || wrapper?.for !== 'call') return { toolClass: 'other' };
  const title = optionalString(inner.title);
  switch (inner.card) {
    case 'terminal': {
      const command = title ?? '';
      return {
        ...(title ? { title } : {}),
        toolClass: 'execute',
        semantic: {
          kind: 'command',
          command,
          ...(optionalString(inner.cwd) ? { cwd: optionalString(inner.cwd)! } : {}),
          state: 'running',
        },
      };
    }
    case 'diff': {
      const { diff, paths } = unifiedDiff(inner.diffs);
      return {
        ...(title ? { title } : {}),
        toolClass: 'edit',
        ...(paths[0] ? { path: paths[0] } : {}),
        ...(diff ? { diff } : {}),
      };
    }
    case 'generic':
    default:
      return {
        ...(title ? { title } : {}),
        toolClass: toolClassForKind(inner.kind),
      };
  }
}

/**
 * Host-computed RESULT view → canonical presentation fields, with the product's
 * documented default (a generic JSON card) whenever no view applies.
 */
export function mapToolResultView(view: unknown, fallbackResult: unknown): DshToolPresentation {
  const wrapper = record(view);
  const inner = record(wrapper?.view);
  if (!inner || wrapper?.for !== 'result') {
    // The documented default: render the raw result as a JSON card.
    return { result: jsonCard(fallbackResult) };
  }
  const title = optionalString(inner.title);
  const titled = title ? { title } : {};
  switch (inner.card) {
    case 'terminal': {
      const output = typeof inner.output === 'string' ? inner.output : '';
      const exitCode = optionalNumber(inner.exitCode);
      const signal = optionalString(inner.signal);
      return {
        ...titled,
        toolClass: 'execute',
        result: output,
        ...(exitCode !== undefined ? { exitCode } : {}),
        semantic: {
          kind: 'command',
          command: title ?? '',
          state: signal ? 'interrupted' : exitCode === undefined ? 'unknown' : exitCode === 0 ? 'completed' : 'failed',
          stdout: { text: output },
        },
      };
    }
    case 'diff': {
      const { diff, paths } = unifiedDiff(inner.diffs);
      return {
        ...titled,
        toolClass: 'edit',
        ...(paths[0] ? { path: paths[0] } : {}),
        ...(diff ? { diff } : {}),
      };
    }
    case 'read': {
      const path = optionalString(inner.path) ?? '';
      const lines = Array.isArray(inner.lines) ? inner.lines : [];
      const preview = lines
        .map((raw) => (typeof record(raw)?.text === 'string' ? (record(raw)!.text as string) : ''))
        .join('\n');
      const startLine = optionalNumber(record(lines[0])?.number) ?? optionalNumber(inner.offset);
      const totalLines = optionalNumber(inner.totalLines);
      return {
        ...titled,
        toolClass: 'lookup',
        path,
        semantic: {
          kind: 'file-read',
          path,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(preview ? { preview } : {}),
          ...(totalLines !== undefined ? { totalLines } : {}),
          ...(preview ? {} : { unavailable: 'empty' as const }),
        },
      };
    }
    case 'search': {
      const truncated = inner.truncated === true;
      const total = optionalNumber(inner.total);
      if (inner.shape === 'paths') {
        const paths = Array.isArray(inner.paths) ? inner.paths.filter((p): p is string => typeof p === 'string') : [];
        return {
          ...titled,
          toolClass: 'lookup',
          ...(truncated ? { truncated: true } : {}),
          semantic: {
            kind: 'search',
            ...(total !== undefined ? { matchCount: total } : {}),
            fileCount: paths.length,
            groups: paths.map((path) => ({ path })),
            ...(truncated ? { truncated: true } : {}),
          },
        };
      }
      const files = Array.isArray(inner.files) ? inner.files : [];
      const groups = files.flatMap((raw) => {
        const file = record(raw);
        const path = optionalString(file?.path);
        if (!path) return [];
        const matches = Array.isArray(file?.matches) ? file.matches : [];
        return [{
          path,
          matchCount: matches.length,
          matches: matches.flatMap((rawMatch) => {
            const match = record(rawMatch);
            const text = typeof match?.line === 'string' ? match.line : undefined;
            if (text === undefined) return [];
            const line = optionalNumber(match?.lineNumber);
            return [{ ...(line !== undefined ? { line } : {}), text }];
          }),
        }];
      });
      return {
        ...titled,
        toolClass: 'lookup',
        ...(truncated ? { truncated: true } : {}),
        semantic: {
          kind: 'search',
          ...(total !== undefined ? { matchCount: total } : {}),
          fileCount: groups.length,
          groups,
          ...(truncated ? { truncated: true } : {}),
        },
      };
    }
    case 'web': {
      const truncated = inner.truncated === true;
      if (inner.kind === 'fetch') {
        return {
          ...titled,
          toolClass: 'lookup',
          semantic: {
            kind: 'web',
            ...(optionalString(inner.url) ? { url: optionalString(inner.url)! } : {}),
            ...(truncated ? { truncated: true } : {}),
          },
        };
      }
      const sources = Array.isArray(inner.sources) ? inner.sources : [];
      return {
        ...titled,
        toolClass: 'lookup',
        semantic: {
          kind: 'web',
          results: sources.flatMap((raw) => {
            const source = record(raw);
            const url = optionalString(source?.url);
            if (!url) return [];
            return [{
              url,
              ...(optionalString(source?.title) ? { title: optionalString(source?.title)! } : {}),
              ...(optionalString(source?.snippet) ? { snippet: optionalString(source?.snippet)! } : {}),
            }];
          }),
          ...(truncated ? { truncated: true } : {}),
        },
      };
    }
    case 'generic':
    default: {
      const content = dshContentText(inner.content);
      return { ...titled, result: content || jsonCard(fallbackResult) };
    }
  }
}

// ── Event mapping ───────────────────────────────────────────────────────────

/**
 * Per-fold state the mapping needs but a single event does not carry.
 *
 * `toolNames` exists because a `tool/result` event names no tool — only its
 * `callId` — so the name has to come from the matching `tool/call` seen earlier
 * in the same fold or live stream.
 */
export interface DshMapState {
  sessionId: string;
  toolNames: Map<string, string>;
  /** rpcId of a prompt this adapter sent → the broker's clientMessageId, for echo correlation. */
  clientKeys: Map<string, string>;
  /** Live frames stream token deltas; a history replay already has the assembled message. */
  live: boolean;
  /** The currently open turn's timing/usage fold; absent between turns. */
  openTurn?: DshOpenTurn;
  /**
   * Seq of the LAST `session/end-seed` marker seen. Everything before it came
   * from a constructor seed (resume, fork, or replay) — "this lifecycle
   * produced none of them" — so the fold never accumulates timing or usage
   * from it. That is what keeps a fork child's inherited parent prefix out of
   * the child's figures (tokdash skips the same prefix via header
   * `seedLength`; the wire exposes no header, so the marker is the boundary).
   */
  seedThroughSeq?: number;
}

/**
 * Per-turn timing/usage fold. The figures are NATIVE DSH METRICS, folded from
 * the same event pairs upstream's `sessionStats` projection documents:
 *
 * - `totalRuntimeMs`: exact native turn elapsed time (turn/start → turn/end).
 * - `agentRuntimeMs`: paired model time (step/start → assistant/message, per
 *   step that assembled a message; a cancelled step stays untimed).
 * - `executionRuntimeMs`: paired tool-call elapsed time (tool/call →
 *   tool/result by callId; pairs still open at turn/end are dropped).
 *
 * These are per-turn exact figures, NOT tokdash's gap-capped active_ms /
 * active_ms_sum estimates, and they are not claimed to be equivalent. Subagent
 * time enters only where dsh attributes it natively: a foreground subagent's
 * `subagent` tool call measures the PARENT's elapsed tool wait (which is not
 * additive child-stream compute), while a background subagent is its own
 * session — roster-linked by `parentThreadId` — carrying its own fold.
 *
 * Validation (tokdash parity): a usage sample needs both input and output,
 * every bucket finite and non-negative, and a non-zero total; a timing pair
 * needs finite endpoints with end >= start. An invalid sample or pair is
 * dropped, and a turn whose own endpoints are invalid closes with NO timing or
 * tokens — never a measured-looking zero. Session-wide totals are never summed
 * from this bounded fold; they come from the host's authoritative
 * `sessionStats` projection (see {@link dshProjectionMessages}).
 *
 * A turn whose start fell outside the fold window (or before the seed
 * boundary) likewise closes without timing or tokens: a partial observation
 * cannot time a turn, and missing fields stay absent rather than becoming
 * fake zeroes.
 */
interface DshOpenTurn {
  /** dsh's host-assigned turn number, for matching step/tool/usage events. */
  turn?: number;
  turnId: string;
  key: string;
  /** Seq of the turn/start; the seed boundary is judged against it at close. */
  startSeq?: number;
  /** Validated turn/start time; absent when the native timestamp was unusable. */
  startedAt?: number;
  /** step → validated step/start time, for model-time pairing; dropped at step/end. */
  stepStarts: Map<number, number>;
  /** callId → validated tool/call time, for tool-time pairing; dropped at turn/end. */
  openCalls: Map<string, number>;
  llmMs: number;
  toolMs: number;
  /** step → latest usage sample: an early usage chunk, replaced by the finalized message. */
  usage: Map<number, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

export function createDshMapState(sessionId: string, live: boolean): DshMapState {
  return { sessionId, toolNames: new Map(), clientKeys: new Map(), live };
}

/** A timestamp the fold may use: a finite, non-negative epoch-ms number. */
function usableTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * True when the event cannot be proven POST-seed. With a boundary established,
 * an unreadable seq (missing, string, non-finite) fails CLOSED: it cannot be
 * shown to postdate the seeded prefix, so it is treated as part of it.
 */
function beforeSeed(state: DshMapState, seq: unknown): boolean {
  if (state.seedThroughSeq === undefined) return false;
  return typeof seq !== 'number' || !Number.isFinite(seq) || seq < state.seedThroughSeq;
}

/**
 * Validate one native usage sample, tokdash-style: both input and output
 * present, every bucket finite and non-negative, cache buckets only optionally
 * present, and a non-zero total (an all-zero sample carries no information).
 * `reasoningTokens` is deliberately unread — dsh already includes reasoning in
 * `outputTokens`, so folding it anywhere would count those tokens twice.
 */
export function parseDshUsageSample(
  raw: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const usage = record(raw);
  if (!usage) return undefined;
  const input = optionalNumber(usage.inputTokens);
  const output = optionalNumber(usage.outputTokens);
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined;
  const cacheRead = optionalNumber(usage.cacheReadTokens);
  const cacheWrite = optionalNumber(usage.cacheWriteTokens);
  if (cacheRead !== undefined && cacheRead < 0) return undefined;
  if (cacheWrite !== undefined && cacheWrite < 0) return undefined;
  const parsed = { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
  if (parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite === 0) return undefined;
  return parsed;
}

/**
 * The canonical upsert key for one native message.
 *
 * Shared by the durable `user/message` row and the transient queue snapshot,
 * because the transient item and the claimed message are THE SAME message and
 * the client converges the optimistic → queued → delivered states by key.
 */
export function dshMessageKey(sessionId: string, messageId: string): string {
  return `dsh:${sessionId}:msg:${messageId}`;
}

/** The opaque activity record every unrecognized event degrades into. */
export function dshUnmappedEvent(event: DshSessionEvent): AgentMessage {
  return { type: 'event', name: 'dsh.session-event', payload: { eventType: event.type, seq: event.seq } };
}

/**
 * Event types this build recognizes but deliberately renders nothing for.
 *
 * Distinct from the unmapped floor: these are known structural markers whose
 * meaning is already carried by another row (a policy record is state, not
 * transcript), so emitting an opaque activity record for them would be noise
 * rather than honesty. Step boundaries and `session/end-seed` are NOT listed:
 * they have explicit cases feeding the turn-timing fold and its seed boundary.
 */
export const DSH_SILENT_EVENT_TYPES: readonly string[] = Object.freeze([
  'request/context',
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
  'agent/inbox/spliced',
]);

/**
 * Map ONE session event into zero or more canonical rows.
 *
 * Total by construction: every branch either produces canonical rows, is listed
 * as deliberately silent, or falls through to {@link dshUnmappedEvent}. There is
 * no `assertNever` and no throw — an event type added by a plugin upstream costs
 * the user one plain activity row, never a failed attach.
 */
export function mapDshEvent(entry: DshHistoryEntry, state: DshMapState): AgentMessage[] {
  const event = entry.event;
  if (!event || typeof event.type !== 'string') return [];
  // The one documented licence to omit an event entirely.
  if (event.ignorable === true) return [];
  const data = record(event.data);
  const key = `dsh:${state.sessionId}:${event.seq}`;

  switch (event.type) {
    case 'user/message': {
      const source = record(data?.source);
      const text = dshContentText(data?.content);
      if (!text) return [];
      if (source?.kind === 'user') {
        const rpcId = optionalString(source.rpcId);
        const clientKey = rpcId ? state.clientKeys.get(rpcId) : undefined;
        // Keyed by the NATIVE message id, which the transient queue snapshot
        // carries too: when the agent claims a queued item, the durable row
        // replaces the dimmed one in place instead of doubling it.
        const messageId = optionalString(data?.id);
        return [{
          type: 'user-message',
          text,
          key: messageId ? dshMessageKey(state.sessionId, messageId) : key,
          sentAt: event.time,
          ...(clientKey ? { clientKey } : {}),
        }];
      }
      // Injected context is NOT a human bubble. It is agent-visible material the
      // user never typed, so it goes out as the provider-neutral context event
      // and the client gives it one compact, collapsible presentation.
      //
      // It was a notice until this round, which rendered as a wall of centred
      // prose quoting a plugin id and a truncated `<system-reminder>` — the
      // single largest source of noise at session open, and uncollapsible
      // because a notice has no body to fold. A notice is also the wrong
      // category: notices are things the USER should read, and this is context
      // the agent was handed.
      //
      // Bounded by the shared CONTEXT body policy, not by `bounded()`: that one
      // is the 240-char NOTICE bound, sized to keep a one-line banner readable
      // inline, and it would have silently amputated a real reminder here. A
      // clipped body reports `truncated` so the client can say so rather than
      // just stopping mid-sentence.
      //
      // The wrapper comes OFF here, the same way Kimi's does. The protocol
      // states a context body arrives already unwrapped and the client renders
      // it verbatim, so forwarding the raw block put literal `<system-reminder>`
      // tags back on screen — the exact noise this event replaced, just folded
      // behind a disclosure.
      const injected = unwrapContextBlock(text);
      // A plugin id is real provenance; a wrapper tag names a KIND. Prefer the
      // id when the host supplied one, fall back to the tag rather than to
      // 'unknown', and only then admit we do not know.
      const origin = optionalString(source?.plugin)
        ?? optionalString(source?.kind)
        ?? injected?.source
        ?? 'unknown';
      return [{
        type: 'event',
        name: CONTEXT_INJECTION_EVENT,
        payload: {
          source: origin,
          ...boundContextBody(injected?.body ?? text),
        } satisfies ContextInjectionPayload,
      }];
    }

    case 'assistant/message': {
      const message = record(data?.message);
      const text = dshContentText(message?.content);
      const sample = parseDshUsageSample(data?.usage);
      const rows: AgentMessage[] = [];
      const open = state.openTurn;
      const step = optionalNumber(data?.step);
      // Usage is accepted only with a usable event time — tokdash's sample
      // contract requires one, and an untimed sample cannot be ordered against
      // the step it claims to describe.
      const messageTime = usableTime(event.time);
      if (open && optionalNumber(data?.turn) === open.turn && step !== undefined
          && !beforeSeed(state, event.seq)) {
        // Model time: step/start → assembled message, per upstream's sessionStats
        // fold. A cancelled step never assembles one and stays untimed; a pair
        // with an unusable or reversed endpoint is dropped, never zeroed.
        const stepStart = open.stepStarts.get(step);
        if (stepStart !== undefined) {
          open.stepStarts.delete(step);
          if (messageTime !== undefined && messageTime >= stepStart) open.llmMs += messageTime - stepStart;
        }
        if (sample && messageTime !== undefined) {
          // Latest finalized sample per (turn, step) wins.
          open.usage.set(step, sample);
        }
      }
      // An empty assembled message is a truncation artifact, not a reply: it
      // must produce no transcript row while its usage still counts.
      if (text) {
        rows.push({ type: 'model-output', text, final: true, key: assistantStreamKey(state, data) ?? key });
      }
      // Usage before the seed boundary belongs to the seeded prefix (a fork's
      // parent log or an earlier lifecycle): visible as transcript, never
      // counted as this session's usage.
      if (sample && messageTime !== undefined && !beforeSeed(state, event.seq)) {
        rows.push({
          type: 'token-count',
          input: sample.input,
          output: sample.output,
          cacheRead: sample.cacheRead,
          cacheWrite: sample.cacheWrite,
        });
      }
      return rows;
    }

    case 'assistant/chunk': {
      const chunk = record(data?.chunk);
      // A usage chunk is an EARLY sample that can survive a later request
      // failure with no final message. It folds into the open turn under the
      // same (turn, step) key the finalized `assistant/message.usage` replaces
      // — tokdash's replace-not-add fold — in history and live modes alike.
      if (chunk?.type === 'usage') {
        const open = state.openTurn;
        const step = optionalNumber(data?.step);
        const sample = parseDshUsageSample(chunk.usage);
        if (open && optionalNumber(data?.turn) === open.turn && step !== undefined && sample
            && usableTime(event.time) !== undefined && !beforeSeed(state, event.seq)) {
          open.usage.set(step, sample);
        }
        return [];
      }
      // History already carries the assembled message; replaying deltas there
      // would rebuild text the fold is about to state exactly.
      if (!state.live) return [];
      const streamKey = assistantStreamKey(state, data) ?? key;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        return [{ type: 'model-output', delta: chunk.text, key: streamKey }];
      }
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        return [{ type: 'thinking', delta: chunk.text, key: `${streamKey}:reasoning` }];
      }
      return [];
    }

    case 'tool/call': {
      const callId = optionalString(data?.callId);
      const name = optionalString(data?.name);
      if (!callId || !name) return [dshUnmappedEvent(event)];
      state.toolNames.set(callId, name);
      // Tool time pairing: the result lands within the same turn (upstream
      // sessionStats drops pairs still unresolved at turn/end). An unusable
      // call timestamp drops the pair up front rather than zeroing it later.
      const callTime = usableTime(event.time);
      if (state.openTurn && optionalNumber(data?.turn) === state.openTurn.turn && callTime !== undefined
          && !beforeSeed(state, event.seq)) {
        state.openTurn.openCalls.set(callId, callTime);
      }
      let args: unknown = data?.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          /* the model produced an unparsable argument string; show it verbatim */
        }
      }
      const presentation = mapToolCallView(entry.view);
      return [{
        type: 'tool-call',
        callId,
        toolName: name,
        ...(presentation.title ? { title: presentation.title } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(presentation.toolClass ? { toolClass: presentation.toolClass } : {}),
        ...(presentation.semantic ? { semantic: presentation.semantic } : {}),
      }];
    }

    case 'tool/result': {
      const message = record(data?.message);
      const block = record(Array.isArray(message?.content) ? message?.content[0] : undefined);
      const callId = optionalString(block?.toolCallId) ?? optionalString(record(message?.source)?.callId);
      if (!callId) return [dshUnmappedEvent(event)];
      const open = state.openTurn;
      const callStart = open?.openCalls.get(callId);
      if (open && callStart !== undefined && optionalNumber(data?.turn) === open.turn) {
        // A pair with an unusable or reversed endpoint is dropped, never zeroed.
        const resultTime = usableTime(event.time);
        if (resultTime !== undefined && resultTime >= callStart) open.toolMs += resultTime - callStart;
        open.openCalls.delete(callId);
      }
      const nativeError = record(data?.error);
      const presentation = mapToolResultView(entry.view, dshContentText(block?.content) || block?.content);
      const isError = block?.isError === true || nativeError !== undefined;
      return [{
        type: 'tool-result',
        callId,
        toolName: state.toolNames.get(callId) ?? '',
        ...(presentation.title ? { title: presentation.title } : {}),
        ...(presentation.toolClass ? { toolClass: presentation.toolClass } : {}),
        ...(presentation.semantic ? { semantic: presentation.semantic } : {}),
        ...(presentation.path ? { path: presentation.path } : {}),
        ...(presentation.diff ? { diff: presentation.diff } : {}),
        ...(presentation.exitCode !== undefined ? { exitCode: presentation.exitCode } : {}),
        ...(presentation.truncated ? { truncated: true } : {}),
        ...(presentation.result !== undefined ? { result: presentation.result } : {}),
        ...(isError ? { isError: true } : {}),
      }];
    }

    case 'step/start': {
      // Silent on the wire (a step boundary lives inside its turn); tracked for
      // the model-time fold. The matching `step/end` drops the entry, so a step
      // that never assembles a message contributes nothing. An unusable start
      // time drops the pair up front rather than zeroing it later.
      const step = optionalNumber(data?.step);
      const stepTime = usableTime(event.time);
      if (state.openTurn && optionalNumber(data?.turn) === state.openTurn.turn && step !== undefined
          && stepTime !== undefined && !beforeSeed(state, event.seq)) {
        state.openTurn.stepStarts.set(step, stepTime);
      }
      return [];
    }

    case 'step/end': {
      const step = optionalNumber(data?.step);
      if (state.openTurn && optionalNumber(data?.turn) === state.openTurn.turn && step !== undefined) {
        state.openTurn.stepStarts.delete(step);
      }
      return [];
    }

    case 'session/end-seed': {
      // Log-only boundary marker: nothing renders, but everything before the
      // LAST one is constructor seed (resume/fork/replay) and must not feed
      // this lifecycle's timing or usage.
      if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
        state.seedThroughSeq = event.seq;
      }
      return [];
    }

    case 'turn/start': {
      const turn = optionalNumber(data?.turn);
      const turnId = `dsh:${state.sessionId}:turn${turn ?? event.seq}`;
      const rows: AgentMessage[] = [];
      if (state.openTurn) {
        // A fresh turn fences its unterminated predecessor as cancelled WITHOUT
        // a completion time: inventing one would fabricate timing a crash or
        // window gap never delivered.
        rows.push({ type: 'run-summary', key: state.openTurn.key, turnId: state.openTurn.turnId, status: 'cancelled' });
      }
      const startedAt = usableTime(event.time);
      state.openTurn = {
        turn,
        turnId,
        key: turnId,
        startSeq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined,
        startedAt,
        stepStarts: new Map(),
        openCalls: new Map(),
        llmMs: 0,
        toolMs: 0,
        usage: new Map(),
      };
      rows.push({
        type: 'run-summary',
        key: turnId,
        turnId,
        status: 'running',
        ...(startedAt !== undefined ? { startedAt } : {}),
      });
      return rows;
    }

    case 'turn/end': {
      const turn = optionalNumber(data?.turn);
      const turnId = `dsh:${state.sessionId}:turn${turn ?? event.seq}`;
      const reason = record(data?.reason);
      const kind = optionalString(reason?.kind);
      const status = kind === 'aborted' || kind === 'interrupted'
        ? 'cancelled'
        : kind === 'error' || kind === 'blocked' ? 'error' : 'done';
      // Only a turn this fold saw OPEN, inside this lifecycle (not before the
      // seed boundary), with valid endpoints in order can be timed; anything
      // else closes the status row WITHOUT timing, tokens, or totals rather
      // than publishing a measured-looking zero.
      const open = state.openTurn;
      const endTime = usableTime(event.time);
      const timed = open !== undefined
        && (turn === undefined || turn === open.turn)
        && !beforeSeed(state, open.startSeq)
        && open.startedAt !== undefined
        && endTime !== undefined
        && endTime >= open.startedAt;
      let summary: AgentMessage;
      if (timed) {
        state.openTurn = undefined;
        const totalRuntimeMs = endTime - open.startedAt!;
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        for (const stepUsage of open.usage.values()) {
          input += stepUsage.input;
          output += stepUsage.output;
          cacheRead += stepUsage.cacheRead;
          cacheWrite += stepUsage.cacheWrite;
        }
        summary = {
          type: 'run-summary',
          key: open.key,
          turnId: open.turnId,
          status,
          startedAt: open.startedAt,
          completedAt: endTime,
          totalRuntimeMs,
          agentRuntimeMs: open.llmMs,
          executionRuntimeMs: open.toolMs,
          ...(open.usage.size > 0 ? { tokens: { input, output, cacheRead, cacheWrite } } : {}),
        };
      } else {
        if (open && (turn === undefined || turn === open.turn)) state.openTurn = undefined;
        summary = {
          type: 'run-summary',
          key: turnId,
          turnId,
          status,
          ...(endTime !== undefined ? { completedAt: endTime } : {}),
        };
      }
      const rows: AgentMessage[] = [summary];
      if (kind === 'aborted' || kind === 'interrupted') {
        // `aborted` nests its cause (user/parent/hook/disposed/legacy); only a
        // proven user cancellation may claim the `user` interruption reason.
        const cause = optionalString(record(reason?.reason)?.kind);
        rows.push({
          type: 'notice',
          message: 'The turn was interrupted.',
          semantic: { kind: 'interruption', reason: cause === 'user' ? 'user' : 'generic', turnId },
        });
      }
      if (kind === 'error') {
        const failure = record(reason?.error);
        rows.push({ type: 'error', message: optionalString(failure?.message) ?? 'The turn failed.' });
      }
      return rows;
    }

    case 'todo/write':
      return dshTodoMessages(data?.todos, 'event');

    case 'session/title': {
      const title = optionalString(data?.title);
      return title ? [{ type: 'metadata-update', key: 'sessionInfo', value: { title } }] : [];
    }

    case 'request/header': {
      const config = record(record(data?.header)?.config);
      const model = optionalString(config?.model);
      const providerID = optionalString(config?.provider);
      if (!model) return [];
      return [{
        type: 'metadata-update',
        key: 'sessionInfo',
        value: { model, ...(providerID ? { currentModel: { providerID, modelID: model } } : {}) },
      }];
    }

    default:
      if (DSH_SILENT_EVENT_TYPES.includes(event.type)) return [];
      return [dshUnmappedEvent(event)];
  }
}

/** Stable merge key for one streamed assistant message (chunks + assembled message share it). */
function assistantStreamKey(state: DshMapState, data: Record<string, unknown> | undefined): string | undefined {
  const turn = optionalNumber(data?.turn);
  const step = optionalNumber(data?.step);
  if (turn === undefined || step === undefined) return undefined;
  return `dsh:${state.sessionId}:turn${turn}:step${step}`;
}

/** Fold a whole (oldest-first) history window into canonical rows. */
export function mapDshHistory(entries: readonly DshHistoryEntry[], state: DshMapState): AgentMessage[] {
  // The seed marker trails the prefix it closes, so a sequential fold would
  // learn the boundary too late. Locate the LAST one up front: everything
  // before it is constructor seed (resume/fork/replay) and never feeds this
  // lifecycle's timing or usage.
  for (const entry of entries) {
    const event = entry?.event;
    if (event?.type === 'session/end-seed' && typeof event.seq === 'number' && Number.isFinite(event.seq)) {
      state.seedThroughSeq = event.seq;
    }
  }
  const rows: AgentMessage[] = [];
  for (const entry of foldDshSurface(entries)) rows.push(...mapDshEvent(entry, state));
  return rows;
}

// ── Questions and approvals ─────────────────────────────────────────────────

/** One pending answerable prompt, keyed by the rpcId the answer must echo. */
export interface DshPendingQuestion {
  kind: 'question';
  rpcId: string;
  sessionId: string;
  /** Native question ids, in the order the canonical answer arrays arrive. */
  ids: string[];
  /**
   * The option labels each question offered, in the same order as {@link ids}.
   * The host validates answers strictly — an unknown label is rejected as
   * `bad-response` — so the answer path needs the label set to route free text
   * into the wire's `custom` field instead of sending it as a bogus label.
   */
  optionLabels: string[][];
  /**
   * Each question's multiSelect flag, in the same order as {@link ids}. The host
   * rejects a single-select answer that carries both `selected` and `custom`,
   * so the answer path needs the flag to keep at most one of the two.
   */
  multiSelect: boolean[];
  message: AgentMessage;
}

export interface DshPendingApproval {
  kind: 'approval';
  rpcId: string;
  sessionId: string;
  approvalId: string;
  message: AgentMessage;
}

export type DshPending = DshPendingQuestion | DshPendingApproval;

/**
 * `question/requested` → a canonical question card.
 *
 * `requestId` is the frame's rpcId, NOT any id inside the payload: the answer
 * POST echoes that rpcId, and the host replays the same rpcId verbatim on every
 * mux reconnect, which is exactly the identity a client needs to dedupe a
 * replayed prompt against one it already shows.
 *
 * `intent` is treated as a presentation HINT only. A plugin may tag a question
 * `plan-review`; that must never change whether the question can be answered.
 */
export function mapDshQuestion(rpcId: string, payload: Record<string, unknown>): DshPendingQuestion | undefined {
  const sessionId = optionalString(payload.sessionId);
  const items = Array.isArray(payload.questions) ? payload.questions : [];
  if (!sessionId || items.length === 0) return undefined;
  const ids: string[] = [];
  const optionLabels: string[][] = [];
  const multiSelect: boolean[] = [];
  const questions = items.map((raw, index) => {
    const item = record(raw);
    // The host validates answers INDEX-ALIGNED against its own registry (one
    // answer per question, ids matching per position), so every item must
    // produce a card entry: skipping a malformed one would leave the whole
    // request permanently unanswerable. Missing question text degrades to a
    // placeholder. `detail` joins the question text because the canonical
    // per-question shape has no separate body field, and for a plan-review
    // question `detail` IS the plan under review — dropping it would ask the
    // user to approve something invisible.
    const text = optionalString(item?.question) ?? '(question text missing)';
    const detail = optionalString(item?.detail);
    ids.push(optionalString(item?.id) ?? String(index));
    const options = Array.isArray(item?.options) ? item.options : [];
    optionLabels.push(options.flatMap((rawOption) => {
      const label = optionalString(record(rawOption)?.label);
      return label ? [label] : [];
    }));
    multiSelect.push(item?.multiSelect === true);
    return {
      question: detail ? `${text}\n\n${detail}` : text,
      ...(optionalString(item?.header) ? { header: optionalString(item?.header)! } : {}),
      options: options.flatMap((rawOption) => {
        const option = record(rawOption);
        const label = optionalString(option?.label);
        if (!label) return [];
        return [{
          label,
          ...(optionalString(option?.description) ? { description: optionalString(option?.description)! } : {}),
        }];
      }),
      ...(item?.multiSelect === true ? { multiple: true } : {}),
    };
  });
  if (questions.length === 0) return undefined;
  return {
    kind: 'question',
    rpcId,
    sessionId,
    ids,
    optionLabels,
    multiSelect,
    message: { type: 'question-request', requestId: rpcId, questions },
  };
}

/**
 * `approval/requested` → a canonical permission card.
 *
 * Only two outcomes exist on the wire (`allowed-once`, `rejected`), so the card
 * advertises exactly two options. Offering a session-wide grant the host cannot
 * record would be a button that silently means something else.
 */
export function mapDshApproval(rpcId: string, payload: Record<string, unknown>): DshPendingApproval | undefined {
  const sessionId = optionalString(payload.sessionId);
  const approvalId = optionalString(payload.approvalId);
  const toolName = optionalString(payload.toolName);
  if (!sessionId || !approvalId) return undefined;
  return {
    kind: 'approval',
    rpcId,
    sessionId,
    approvalId,
    message: {
      type: 'permission-request',
      requestId: rpcId,
      title: toolName ? `Allow ${toolName}?` : 'Allow this operation?',
      ...(toolName ? { toolName } : {}),
      ...(optionalString(payload.reason) ? { detail: optionalString(payload.reason)! } : {}),
      options: ['approve', 'reject'],
    },
  };
}
