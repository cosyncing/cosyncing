/**
 * The Kimi Agent Protocol (KAP 1.x, Kimi Code 2.7.0 and newer), spoken BEHIND
 * the 0.x surface the rest of this package is written against.
 *
 * Both wires are kept, and the one a server speaks is selected from its
 * `/api/v1/meta`. The observe and drive connections carry years of hard-won
 * rules — echo correlation, the foreign-writer detector, interaction
 * reconciliation, the cursor discipline — and none of those rules is about the
 * wire format. So rather than fork them, a KAP server is translated at the
 * three transport seams the connections already inject:
 *
 *  - the READ door: {@link KimiKapTranslator} answers the 0.x reads
 *    (`/api/v2/sessions`, `.../messages`, `.../status`, `.../approvals`, …)
 *    from KAP routes, through the same GET-only door (`server.ts`);
 *  - the SOCKET: {@link KimiKapSocket} speaks KAP `subscribe` and turns KAP
 *    frames into the 0.x event envelopes the connections map;
 *  - the WRITE door: `drive-http.ts` routes its ten named operations to the
 *    KAP paths and bodies (`:cancel`, `/interactions/{id}`).
 *
 * Every shape below is from a live capture of Kimi Code 2.7.2 (an isolated
 * install, 2026-11-24) and its served `asyncapi.json` / `openapi.json`, not
 * from upstream source. Nothing here writes: this file names no HTTP verb and
 * sends only `subscribe`, `unsubscribe` and `pong` frames.
 */
import { registerDefaultKimiKapBinding } from './server.ts';
import type {
  KimiGetQuery,
  KimiGetResult,
  KimiGetTranslator,
  KimiKapBinding,
  KimiNativeGet,
  KimiWire,
} from './server.ts';
import { KIMI_WS_FRAME_MAX_BYTES, type KimiSocketFactory, type KimiSocketLike } from './observe.ts';
import { KIMI_AGENT_STATE_EVENT, KIMI_BACKGROUND_TASKS_EVENT, KIMI_TURN_FAILURE_PART } from './mapping.ts';

// ── Live state ──────────────────────────────────────────────────────────────

/** Bound on every per-session memory below; a long session costs a constant. */
const KAP_MEMORY_LIMIT = 1_024;
/** Bound on the sessions whose live state is held at once. */
const KAP_SESSION_LIMIT = 256;
/** The same per-frame ceiling the connection applies. */
const KAP_FRAME_MAX_BYTES = KIMI_WS_FRAME_MAX_BYTES;
/** How much of an oversized frame's head is read to recognize it; see {@link kapOversizedTurnsHead}. */
const KAP_FRAME_HEAD_CHARS = 1_024;

/**
 * What a KAP server has said about one session over the socket, kept because
 * KAP has no REST read for it: the model, effort and modes (`agent` frame),
 * the context window (`context`), and the goal (`goal`) arrive ONLY as frames,
 * and the 0.x `.../status` and `.../goal` reads are answered from here.
 */
export interface KimiKapSessionLive {
  /** Synthesized 0.x sequence for this session; only ever grows. */
  seq: number;
  agent?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** `undefined` = no goal frame yet; `{goal: null}` = the server said there is none. */
  goal?: { goal: unknown };
  activity?: string;
  pendingInteraction?: string;
  lastTurnOutcome?: string;
  /** KAP `turn_id` → the turn number the journal and the 0.x frames use. */
  turnRefs: Map<string, number>;
  /** Turn number → the prompt ids its user messages carried. */
  turnPrompts: Map<number, string[]>;
  /** Synthesized message id → the ordinal of the turn it came from, for `before_id` paging. */
  messageOrdinals: Map<string, number>;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit = KAP_MEMORY_LIMIT): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Host (`127.0.0.1:47341`) of an http or ws URL: the key both doors share. */
function originKey(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * One adapter's KAP state: which wire answers at which origin, and each
 * session's live state. Shared by the read translator and every socket, so a
 * `/status` read is answered from the frames the session's own socket heard.
 */
export class KimiKapHub implements KimiKapBinding {
  private readonly origins = new Map<string, { wire: KimiWire; epoch: string }>();
  private readonly sessions = new Map<string, KimiKapSessionLive>();
  private readonly reader: KimiKapTranslator = new KimiKapTranslator(this);

  translator(): KimiGetTranslator {
    return this.reader;
  }

  /**
   * The gate verified a server at `baseUrl`. The epoch is the API generation
   * id, so a restarted `kimi web` presents a NEW epoch to every connection — the
   * same incarnation change a 0.x journal rebuild presents — while a mere
   * reconnect to the same server keeps it.
   */
  noteVerified(baseUrl: string, wire: KimiWire, apiServerId: string): void {
    const key = originKey(baseUrl);
    if (key) boundedSet(this.origins, key, { wire, epoch: `kap:${apiServerId}` }, 16);
  }

  wireAt(url: string): KimiWire | undefined {
    const key = originKey(url);
    return key ? this.origins.get(key)?.wire : undefined;
  }

  epochAt(url: string): string {
    const key = originKey(url);
    return (key ? this.origins.get(key)?.epoch : undefined) ?? 'kap';
  }

  session(id: string): KimiKapSessionLive {
    let live = this.sessions.get(id);
    if (!live) {
      live = { seq: 0, turnRefs: new Map(), turnPrompts: new Map(), messageOrdinals: new Map() };
    }
    boundedSet(this.sessions, id, live, KAP_SESSION_LIMIT);
    return live;
  }

  peek(id: string): KimiKapSessionLive | undefined {
    return this.sessions.get(id);
  }

  /**
   * A socket factory that speaks KAP wherever the gate last verified a KAP
   * server, and passes every other socket through untouched. Decided per
   * socket, so a host upgraded under a live connection is spoken to correctly
   * from its next reconnect.
   */
  socketFactory(inner: KimiSocketFactory): KimiSocketFactory {
    return (url, token) => {
      const socket = inner(url, token);
      return this.wireAt(url) === 'kap' ? new KimiKapSocket(socket, this, url) : socket;
    };
  }
}

/** The binding the gate uses when a caller passed none (direct gate callers, tests). */
registerDefaultKimiKapBinding(() => new KimiKapHub());

// ── Shapes ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow).filter((row): row is Row => row !== undefined) : [];
}

/**
 * The turn number of a KAP turn: `turn_number`, which is what the wire journal
 * writes as `turnId` (captured: both 0, 4, 5 on the same turns), falling back
 * to the 0-based `ordinal` the protocol always carries.
 */
export function kapTurnRef(turn: Row): number | undefined {
  const number = turn.turn_number;
  if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) return number;
  const ordinal = turn.ordinal;
  return typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : undefined;
}

/**
 * The 0.x listing activity of a KAP session row. A pending interaction wins
 * over the running turn — on KAP the turn stays `turn` while it waits on an
 * approval, and 0.x reported that state as the interaction (`needs-input`).
 *
 * KAP `background` (no turn running, background shell tasks or subagents still
 * working) maps to idle on purpose. On 0.x `busy` meant a running TURN, and
 * the working badge, the drive's idle gate and Stop all follow the turn, so a
 * session whose turn ended reads idle while its background work continues.
 */
function legacyActivity(row: Row): 'running' | 'approval' | 'question' | 'idle' {
  const pending = row.pending_interaction;
  if (pending === 'approval' || pending === 'question') return pending;
  return row.activity === 'turn' ? 'running' : 'idle';
}

/** 0.x `busy`: a turn running and NOT parked on a question or approval. */
function legacyBusy(row: Row): boolean {
  return legacyActivity(row) === 'running';
}

/** KAP flat session row → the 0.x `/api/v2/sessions` item shape (`mapping.ts` `KimiV2Session`). */
export function kapSessionAsV2(row: Row): Row {
  return {
    id: row.id,
    workspace: { id: row.workspace_id, cwd: row.cwd },
    meta: {
      title: row.title,
      last_prompt: row.last_prompt,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived: row.archived,
      archived_at: row.archived_at ?? null,
    },
    activity: { status: legacyActivity(row) },
  };
}

const LEGACY_TURN_REASON: Record<string, string> = {
  completed: 'completed',
  interrupted: 'cancelled',
  failed: 'failed',
};

/** KAP flat session row → the 0.x flat v1 row (`mapping.ts` `KimiV1Session`). */
export function kapSessionAsV1(row: Row): Row {
  const outcome = str(row.last_turn_outcome);
  return {
    id: row.id,
    title: row.title,
    ...(row.last_prompt !== undefined ? { last_prompt: row.last_prompt } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    busy: legacyBusy(row),
    pending_interaction: row.pending_interaction ?? 'none',
    ...(outcome && LEGACY_TURN_REASON[outcome] ? { last_turn_reason: LEGACY_TURN_REASON[outcome] } : {}),
    archived: row.archived,
    workspace_id: row.workspace_id,
    metadata: { ...(asRow(row.metadata) ?? {}), ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) },
  };
}

/**
 * KAP's typed user-message `origin` → the 0.x `metadata.origin` the mapper
 * and the foreign-writer detector read.
 *
 * `user` stays `user` (the only kind that can be a foreign prompt). The two
 * activation kinds keep their 0.x names and fields, so the row still splits
 * into `/name args` plus the loaded body. Harness-authored kinds (`system`,
 * `hook`) fold as injected context; `cron` keeps its 0.x name; `goal` and
 * `retry` keep their own, which renders them as user rows that are never
 * suspected. An unknown kind is passed through as-is: never `user`.
 */
function legacyOrigin(origin: unknown): Row | undefined {
  const row = asRow(origin);
  const kind = str(row?.kind);
  if (!row || !kind) return undefined;
  switch (kind) {
    case 'user':
      return { kind: 'user' };
    case 'skill':
      return { kind: 'skill_activation', skillName: row.name, ...(row.args !== undefined ? { skillArgs: row.args } : {}) };
    case 'plugin_command':
      return {
        kind: 'plugin_command',
        pluginId: row.plugin_id,
        commandName: row.command,
        ...(row.args !== undefined ? { commandArgs: row.args } : {}),
      };
    case 'cron':
      return { kind: 'cron_job' };
    case 'system':
    case 'hook':
      return { kind: 'injection', variant: kind };
    default:
      return { kind };
  }
}

/**
 * The text a file attachment echoes as. 0.x rewrote an uploaded file into a
 * notice part — `Attached file "<name>" (<media>, <size> bytes): <path> …` —
 * and the transcript showed that; KAP keeps the attachment structured
 * (`{kind:'file', file_id, name, media_type, size}`, captured) and the message
 * text clean. The notice is rebuilt up to the path, which KAP does not expose.
 */
function fileAttachmentText(attachment: Row): string {
  const name = str(attachment.name) ?? str(attachment.file_id) ?? 'file';
  const media = str(attachment.media_type) ?? 'application/octet-stream';
  const size = typeof attachment.size === 'number' ? attachment.size : undefined;
  return size === undefined ? `Attached file "${name}" (${media})` : `Attached file "${name}" (${media}, ${size} bytes)`;
}

/** The task-state fields a background-task row is built from (KAP `TaskState`, captured on 2.7.2). */
const KAP_TASK_FIELDS = [
  'task_id', 'kind', 'status', 'outcome', 'phase', 'detached', 'description', 'command',
  'child_agent_id', 'parent_tool_call_id', 'swarm_index', 'started_at', 'ended_at',
] as const;

/** One KAP task state, reduced to {@link KAP_TASK_FIELDS}: a `task` frame carries routing fields too. */
function kapTaskState(task: Row): Row {
  const out: Row = {};
  for (const field of KAP_TASK_FIELDS) if (task[field] !== undefined) out[field] = task[field];
  return out;
}

/** An item is settled once it has ended; a running one is read again when it ends. */
function ended(item: Row): boolean {
  return item.status === 'ended';
}

/**
 * One KAP turn → 0.x messages, oldest first, one message per item (two for a
 * finished tool call: the call, then its result). Message ids are the KAP item
 * ids, so a prompt's user message keeps the `user_message_id` the submit
 * answered with (captured: `item_id` = `prompt_id`), which is what the drive
 * connection correlates its echo by.
 *
 * Running reasoning and assistant text are SKIPPED, not shown partially: the
 * connection dedupes by identity, so a row first walked half-written would
 * never be replaced by its finished text. A running tool call is shown once
 * its input is known, and its result when it ends.
 */
export function kapTurnMessages(turn: Row, sessionId: string): Row[] {
  const out: Row[] = [];
  for (const item of rows(turn.items)) {
    const id = str(item.item_id);
    if (!id) continue;
    const created = item.created_at;
    const base = { session_id: sessionId, created_at: created };
    switch (item.type) {
      case 'user_message': {
        const content: Row[] = [];
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) content.push({ type: 'text', text });
        for (const attachment of rows(item.attachments)) {
          if (attachment.kind === 'image' && str(attachment.url)) {
            content.push({ type: 'image', source: { kind: 'url', url: attachment.url }, ...(str(attachment.media_type) ? { media_type: attachment.media_type } : {}) });
          } else if (attachment.kind === 'file') {
            content.push({ type: 'text', text: fileAttachmentText(attachment) });
          }
        }
        const origin = legacyOrigin(item.origin);
        const promptIds = Array.isArray(item.prompt_ids) ? item.prompt_ids.filter((p): p is string => typeof p === 'string') : [];
        out.push({
          ...base,
          id,
          role: 'user',
          content,
          ...(promptIds[0] ? { prompt_id: promptIds[0] } : {}),
          ...(origin ? { metadata: { origin } } : {}),
        });
        break;
      }
      case 'assistant_message': {
        if (ended(item) && str(item.text)) out.push({ ...base, id, role: 'assistant', content: [{ type: 'text', text: item.text }] });
        break;
      }
      case 'reasoning': {
        if (ended(item) && str(item.text)) out.push({ ...base, id, role: 'assistant', content: [{ type: 'thinking', thinking: item.text }] });
        break;
      }
      case 'tool_call': {
        const name = str(item.name);
        if (!name) break;
        // While `stage` is `input` the arguments are still streaming (as
        // `input_text` deltas, captured), so the call is not shown until they
        // are whole: identity dedupe would pin a half-written one.
        if (!ended(item) && (item.input === undefined || item.stage === 'input')) break;
        out.push({
          ...base,
          id,
          role: 'assistant',
          content: [{ type: 'tool_use', tool_call_id: id, tool_name: name, input: item.input ?? {} }],
        });
        if (ended(item)) {
          const failed = item.outcome === 'failed' || typeof item.error === 'string';
          const output = typeof item.output === 'string' ? item.output : typeof item.error === 'string' ? item.error : '';
          out.push({
            ...base,
            created_at: item.ended_at ?? created,
            id: `${id}:result`,
            role: 'tool',
            content: [{ type: 'tool_result', tool_call_id: id, tool_name: name, output, ...(failed ? { is_error: true } : {}) }],
          });
        }
        break;
      }
      case 'notification': {
        const title = str(item.title);
        const body = str(item.body);
        const settled = backgroundTaskSettlement(item);
        if (settled) {
          out.push({ ...base, id, ...settled });
        } else if (title || body) {
          out.push({ ...base, id, role: 'system', content: [{ type: 'text', text: [title, body].filter(Boolean).join('\n') }] });
        }
        break;
      }
      case 'system': {
        if (item.kind === 'compaction' && str(item.summary)) {
          out.push({
            ...base,
            id,
            role: 'user',
            content: [{ type: 'text', text: item.summary }],
            metadata: { origin: { kind: 'compaction_summary' } },
          });
        }
        break;
      }
      default:
        break;
    }
  }
  // A FAILED turn says why on the turn itself (`error{code, message}` and
  // `end_reason`, captured on the turn read and on `turn.ended` alike), so
  // the reason is read from the server here rather than from the wire
  // journal's tail. One row per failed turn, last in that turn, keyed by the
  // turn so the live `turn.ended` row for the same turn is the same row.
  const ref = kapTurnRef(turn);
  if (turn.outcome === 'failed' && ref !== undefined) {
    out.push({
      session_id: sessionId,
      created_at: turn.ended_at ?? turn.started_at,
      id: `${str(turn.turn_id) ?? `turn-${ref}`}:failure`,
      role: 'system',
      content: [{
        type: KIMI_TURN_FAILURE_PART,
        turn_ref: String(ref),
        ...(turn.error != null ? { error: turn.error } : {}),
        ...(turn.end_reason != null ? { interrupt_reason: turn.end_reason } : {}),
      }],
    });
  }
  return out;
}

/**
 * A background task's settlement notification → the 0.x row the mapper folds
 * into the call that started the task.
 *
 * On 0.x a settled background task wrote a `role:'user'` row with origin
 * `{kind:'task', taskId, status}` and a `<notification …>` envelope as its
 * text; the mapper turns that into the spawning call's deferred result and
 * closes a detached subagent's bar. KAP keeps the same notification as a
 * structured item (captured on 2.7.2: `{type:'notification', title, body,
 * severity, notification_type:'task.completed'|'task.failed'…, source:{kind:
 * 'background_task', id}, task_id}`), so the row is rebuilt in that shape.
 * Without it a detached subagent's bar, opened by the spawn result, would
 * never close on a KAP history read.
 */
function backgroundTaskSettlement(item: Row): Row | undefined {
  const source = asRow(item.source);
  const taskId = str(item.task_id) ?? (source?.kind === 'background_task' ? str(source.id) : undefined);
  if (!taskId || source?.kind !== 'background_task') return undefined;
  const type = str(item.notification_type);
  const status = type?.startsWith('task.') ? type.slice('task.'.length) : 'completed';
  const attribute = (value: string): string => value
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Where the task's full output was saved, as 0.x named it in an
  // `<output-file>` child (KAP: `output.file`, captured).
  const outputFile = str(asRow(item.output)?.file);
  const lines = [
    ...(str(item.title) ? [`Title: ${str(item.title)}`] : []),
    ...(str(item.severity) ? [`Severity: ${str(item.severity)}`] : []),
    ...(str(item.body) ? [str(item.body)!.replace(/<\/notification>/g, '</ notification>')] : []),
    ...(outputFile ? [`<output-file path="${attribute(outputFile)}"></output-file>`] : []),
  ];
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: `<notification${type ? ` type="${attribute(type)}"` : ''}>\n${lines.join('\n')}\n</notification>`,
    }],
    metadata: { origin: { kind: 'task', taskId, status } },
  };
}

/** Record what a turn tells the live state: its number and its prompts. */
function noteTurn(live: KimiKapSessionLive, turn: Row): void {
  const ref = kapTurnRef(turn);
  const turnId = str(turn.turn_id);
  if (ref === undefined) return;
  if (turnId) boundedSet(live.turnRefs, turnId, ref);
  for (const item of rows(turn.items)) notePrompt(live, ref, item);
}

function notePrompt(live: KimiKapSessionLive, ref: number, item: Row): void {
  if (item.type !== 'user_message' || !Array.isArray(item.prompt_ids)) return;
  const known = live.turnPrompts.get(ref) ?? [];
  for (const id of item.prompt_ids) {
    if (typeof id === 'string' && id && !known.includes(id)) known.push(id);
  }
  if (known.length > 0) boundedSet(live.turnPrompts, ref, known);
}

// ── Read door ───────────────────────────────────────────────────────────────

/**
 * Turns per page for a 0.x page of `pageSize` messages. A KAP turn carries all
 * of its items, tool outputs included, so a page of turns has no size bound
 * of its own and a large one would trip the read door's body ceiling and fail
 * the whole walk. One turn per 25 requested messages keeps a page near the
 * size the 0.x walk was tuned for: the refresh walk (20) reads one turn, the
 * history walk (100) four.
 */
function turnsPerPage(pageSize: number): number {
  return Math.max(1, Math.min(20, Math.ceil(pageSize / 25)));
}

/** A 0.x read KAP cannot answer: shaped like the server refusing it, never as an empty success. */
function refusal<T>(message: string): KimiGetResult<T> {
  return { ok: false, reason: 'business-error', code: 40400, message };
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const SESSION_PATH = /^\/api\/v1\/sessions\/([^/:]+)(?:\/(messages|status|goal|approvals|questions))?$/;

/**
 * The read-side translator. Every native call goes through the GET-only door
 * it is handed, so the client stays exactly as read-only as before.
 */
export class KimiKapTranslator implements KimiGetTranslator {
  constructor(private readonly hub: KimiKapHub) {}

  async get<T>(path: string, query: KimiGetQuery | undefined, native: KimiNativeGet): Promise<KimiGetResult<T>> {
    if (path === '/api/v2/sessions') return this.listSessions(query, native) as Promise<KimiGetResult<T>>;
    const match = SESSION_PATH.exec(path);
    if (!match) return native<T>(path, query);
    const encoded = match[1]!;
    let id: string;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      return native<T>(path, query);
    }
    switch (match[2]) {
      case undefined:
        return this.session(path, id, native) as Promise<KimiGetResult<T>>;
      case 'messages':
        return this.messages(encoded, id, query, native) as Promise<KimiGetResult<T>>;
      case 'status':
        return this.status(id) as KimiGetResult<T>;
      case 'goal':
        return this.goal(id) as KimiGetResult<T>;
      case 'approvals':
        return this.pending(encoded, 'approval', native) as Promise<KimiGetResult<T>>;
      case 'questions':
        return this.pending(encoded, 'question', native) as Promise<KimiGetResult<T>>;
      default:
        return native<T>(path, query);
    }
  }

  /**
   * `/api/v2/sessions` → `GET /api/v1/sessions` (flat rows, captured). The 0.x
   * `meta.updated_after` bound is applied HERE rather than sent: KAP's
   * `updated_after` is a string whose format the capture did not pin down, and
   * a rejected filter would empty the roster. The rows are newest first, so
   * the first row older than the bound ends the listing.
   */
  private async listSessions(query: KimiGetQuery | undefined, native: KimiNativeGet): Promise<KimiGetResult<unknown>> {
    const pageToken = query?.page_token;
    const result = await native<Row>('/api/v1/sessions', {
      page_size: query?.page_size,
      archived: 'false',
      sort: 'updated_at_desc',
      ...(pageToken !== undefined ? { page_token: pageToken } : {}),
    });
    if (!result.ok) return result;
    const data = asRow(result.data) ?? {};
    const after = epochMs(query?.['meta.updated_after']);
    let older = false;
    const items: Row[] = [];
    for (const row of rows(data.items)) {
      const updated = epochMs(row.updated_at);
      if (after !== undefined && updated !== undefined && updated < after) {
        older = true;
        continue;
      }
      const id = str(row.id);
      if (id) this.noteRow(id, row);
      items.push(kapSessionAsV2(row));
    }
    const hasMore = data.has_more === true && !older;
    return {
      ok: true,
      data: { items, has_more: hasMore, next_page_token: hasMore ? data.next_page_token ?? null : null },
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  private async session(path: string, id: string, native: KimiNativeGet): Promise<KimiGetResult<unknown>> {
    const result = await native<Row>(path);
    if (!result.ok) return result;
    const row = asRow(result.data);
    if (!row) return result;
    this.noteRow(id, row);
    return { ...result, data: kapSessionAsV1(row) };
  }

  private noteRow(id: string, row: Row): void {
    const live = this.hub.peek(id);
    if (!live) return;
    if (typeof row.activity === 'string') live.activity = row.activity;
    if (typeof row.pending_interaction === 'string') live.pendingInteraction = row.pending_interaction;
    if (typeof row.last_turn_outcome === 'string') live.lastTurnOutcome = row.last_turn_outcome;
  }

  /**
   * `.../messages` → `GET .../agents/main/turns`. 0.x pages are NEWEST first
   * and continue with `before_id`; KAP pages are turns, oldest first, and
   * continue with `before_ordinal`. Each page is whole turns, so the oldest
   * message on it is the first message of its oldest turn, and `before_id` is
   * always resolvable to that turn's ordinal from what this page recorded.
   */
  private async messages(
    encoded: string,
    id: string,
    query: KimiGetQuery | undefined,
    native: KimiNativeGet,
  ): Promise<KimiGetResult<unknown>> {
    const live = this.hub.session(id);
    const beforeId = query?.before_id;
    let beforeOrdinal: number | undefined;
    if (beforeId !== undefined) {
      beforeOrdinal = live.messageOrdinals.get(String(beforeId));
      // A cursor this side never issued (or has forgotten) cannot be continued;
      // the walk then stops as at the start of history.
      if (beforeOrdinal === undefined) return { ok: true, data: { items: [], has_more: false } };
    }
    const rawSize = query?.page_size;
    const pageSize = typeof rawSize === 'number' ? rawSize : Number(rawSize ?? 20);
    const result = await native<Row>(`/api/v1/sessions/${encoded}/agents/main/turns`, {
      page_size: turnsPerPage(Number.isFinite(pageSize) ? pageSize : 20),
      ...(beforeOrdinal !== undefined ? { before_ordinal: beforeOrdinal } : {}),
    });
    if (!result.ok) return result;
    const data = asRow(result.data) ?? {};
    const messages: Row[] = [];
    for (const turn of rows(data.turns)) {
      noteTurn(live, turn);
      const ordinal = typeof turn.ordinal === 'number' ? turn.ordinal : undefined;
      for (const message of kapTurnMessages(turn, id)) {
        if (ordinal !== undefined) boundedSet(live.messageOrdinals, String(message.id), ordinal, KAP_MEMORY_LIMIT * 4);
        messages.push(message);
      }
    }
    return {
      ok: true,
      data: { items: messages.reverse(), has_more: data.has_more === true },
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  /**
   * `.../status` from the session's live `agent` and `context` frames, in the
   * 0.x field names (`thinking_level`, `permission`). Refused until a frame
   * has arrived: an invented reading would be pinned by the overlay dedupe.
   */
  private status(id: string): KimiGetResult<unknown> {
    const live = this.hub.peek(id);
    const agent = live?.agent;
    const context = live?.context;
    if (!agent && !context) return refusal('no live Kimi agent state for this session yet');
    return {
      ok: true,
      data: {
        busy: live?.activity === 'turn' && live.pendingInteraction !== 'approval' && live.pendingInteraction !== 'question',
        ...(agent && str(agent.model) ? { model: agent.model } : {}),
        ...(agent && str(agent.thinking) ? { thinking_level: agent.thinking } : {}),
        ...(agent && str(agent.permission_mode) ? { permission: agent.permission_mode } : {}),
        ...(agent && typeof agent.plan_mode === 'boolean' ? { plan_mode: agent.plan_mode } : {}),
        ...(agent && typeof agent.swarm_mode === 'boolean' ? { swarm_mode: agent.swarm_mode } : {}),
        ...(context && typeof context.context_tokens === 'number' ? { context_tokens: context.context_tokens } : {}),
        ...(context && typeof context.max_context_tokens === 'number' ? { max_context_tokens: context.max_context_tokens } : {}),
      },
    };
  }

  /** `.../goal` from the live `goal` frame: its `goal` object, or null when the frame carried none. */
  private goal(id: string): KimiGetResult<unknown> {
    const seen = this.hub.peek(id)?.goal;
    if (!seen) return refusal('no live Kimi goal state for this session yet');
    return { ok: true, data: seen.goal ?? null };
  }

  /**
   * `.../approvals` and `.../questions` → `GET .../interactions` (one list for
   * both kinds on KAP), reshaped to the 0.x item fields
   * (`approval_id`/`question_id`, request fields at the top level).
   */
  private async pending(encoded: string, kind: 'approval' | 'question', native: KimiNativeGet): Promise<KimiGetResult<unknown>> {
    const result = await native<Row>(`/api/v1/sessions/${encoded}/interactions`);
    if (!result.ok) return result;
    const items: Row[] = [];
    for (const interaction of rows(asRow(result.data)?.items)) {
      if (interaction.kind !== kind || (interaction.status !== undefined && interaction.status !== 'pending')) continue;
      const legacy = kind === 'approval' ? legacyApproval(interaction) : legacyQuestion(interaction);
      if (legacy) items.push(legacy);
    }
    return { ...result, data: { items } };
  }
}

function legacyApproval(interaction: Row): Row | undefined {
  const id = str(interaction.interaction_id);
  if (!id) return undefined;
  const request = asRow(interaction.request) ?? {};
  return {
    approval_id: id,
    ...(interaction.tool_call_id !== undefined ? { tool_call_id: interaction.tool_call_id } : {}),
    tool_name: request.tool_name,
    action: request.action,
    ...(request.tool_input_display !== undefined ? { tool_input_display: request.tool_input_display } : {}),
  };
}

function legacyQuestion(interaction: Row): Row | undefined {
  const id = str(interaction.interaction_id);
  if (!id) return undefined;
  return {
    question_id: id,
    ...(interaction.tool_call_id !== undefined ? { tool_call_id: interaction.tool_call_id } : {}),
    // Item shape is the same on both wires: `{id, question, header, options:[{id,label,description}], multi_select, allow_other}`.
    questions: asRow(interaction.request)?.questions ?? [],
  };
}

// ── Socket ──────────────────────────────────────────────────────────────────

type Listener = (event: unknown) => void;

function frameBytes(raw: unknown): number | undefined {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return undefined;
}

/** At most the first `max` units of a frame, decoded without touching the rest. */
function frameHead(raw: unknown, max: number): string | undefined {
  if (typeof raw === 'string') return raw.slice(0, max);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw, 0, Math.min(raw.byteLength, max)).toString('utf8');
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, max)).toString('utf8');
  }
  return undefined;
}

/**
 * The session and agent of an oversized KAP `turns` frame, read from the
 * frame's head WITHOUT parsing the frame.
 *
 * KAP writes a frame's scalar fields ahead of its payload — `{"type":"turns",
 * "session_id":…,"agent_id":…,"event_created_at":…,"turns":[…]}`, captured —
 * so the text between the opening brace and the first nested value is exactly
 * the frame's top level, and a match there cannot come from inside a turn.
 * Anything else (another type, another key order, a head that ends before any
 * nested value) is not recognized, and the caller treats the frame as any
 * other oversized one.
 */
export function kapOversizedTurnsHead(raw: unknown): { sessionId: string; agentId: string } | undefined {
  const head = frameHead(raw, KAP_FRAME_HEAD_CHARS);
  if (head === undefined) return undefined;
  const open = head.indexOf('{');
  if (open < 0 || head.slice(0, open).trim() !== '') return undefined;
  const nested = head.slice(open + 1).search(/[[{]/);
  if (nested < 0) return undefined;
  const top = head.slice(open + 1, open + 1 + nested);
  if (!/"type"\s*:\s*"turns"\s*,/.test(top)) return undefined;
  const sessionId = /"session_id"\s*:\s*"([^"\\]{1,256})"/.exec(top)?.[1];
  if (!sessionId) return undefined;
  const agentId = /"agent_id"\s*:\s*"([^"\\]{1,256})"/.exec(top)?.[1] ?? 'main';
  return { sessionId, agentId };
}

function frameText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  const view = raw as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
}

/**
 * A KAP WebSocket presented as a 0.x one.
 *
 * OUT: the connection's `subscribe {session_ids, cursors}` becomes one KAP
 * `subscribe {request_id, session_id}` per session (KAP closes the socket with
 * 1008 on a command without `request_id`, captured); `unsubscribe` likewise;
 * `pong` passes. `client_hello` and `subscribe_v2` have no KAP meaning (2.7.2
 * ignores `client_hello`, captured) and are not sent.
 *
 * IN: each KAP frame becomes the 0.x event envelope(s) the connection maps,
 * `{type, session_id, seq, epoch, payload}`, with a synthesized per-session
 * `seq` and the server-generation epoch ({@link KimiKapHub.noteVerified}).
 * The subscribe `response` becomes the 0.x `ack` with this session's cursor.
 */
export class KimiKapSocket implements KimiSocketLike {
  private readonly listeners: Record<'open' | 'message' | 'close' | 'error', Listener[]> = {
    open: [], message: [], close: [], error: [],
  };
  private readonly pendingSubscribes = new Map<string, { ackId?: string; sessionId: string }>();
  private readonly subscribed = new Set<string>();
  private requests = 0;

  constructor(private readonly inner: KimiSocketLike, private readonly hub: KimiKapHub, private readonly url: string) {
    inner.addEventListener('open', (event) => this.fire('open', event));
    inner.addEventListener('message', (event) => this.receive((event as { data?: unknown }).data));
    inner.addEventListener('close', (event) => this.fire('close', event));
    inner.addEventListener('error', (event) => this.fire('error', event));
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    this.listeners[type].push(listener);
  }

  close(): void {
    this.inner.close();
  }

  send(data: string): void {
    let frame: Row | undefined;
    try {
      frame = asRow(JSON.parse(data));
    } catch {
      return;
    }
    if (!frame) return;
    const payload = asRow(frame.payload) ?? {};
    const sessions = Array.isArray(payload.session_ids)
      ? payload.session_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    switch (frame.type) {
      case 'subscribe':
        for (const sessionId of sessions) {
          const requestId = this.nextRequestId();
          this.pendingSubscribes.set(requestId, { ...(typeof frame.id === 'string' ? { ackId: frame.id } : {}), sessionId });
          this.inner.send(JSON.stringify({ type: 'subscribe', request_id: requestId, session_id: sessionId }));
        }
        return;
      case 'unsubscribe':
        for (const sessionId of sessions) {
          this.subscribed.delete(sessionId);
          this.inner.send(JSON.stringify({ type: 'unsubscribe', request_id: this.nextRequestId(), session_id: sessionId }));
        }
        return;
      case 'pong':
        this.inner.send(JSON.stringify({ type: 'pong' }));
        return;
      default:
        return;
    }
  }

  private nextRequestId(): string {
    this.requests += 1;
    return `cosyncing-${this.requests}`;
  }

  private fire(type: 'open' | 'message' | 'close' | 'error', event: unknown): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }

  private deliver(frame: Row): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }

  private receive(raw: unknown): void {
    const bytes = frameBytes(raw);
    if (bytes === undefined) return;
    if (bytes > KAP_FRAME_MAX_BYTES) {
      // The latest-turns page KAP sends after every subscribe is ONE frame, and
      // on a long, tool-heavy session it outgrows the ceiling. Dropped, it
      // would leave the transcript unread until the next poll and the turn in
      // flight unknown, so its live frames and its prompts' settlement would
      // be lost. All it asks of the connection is a reset, which needs only
      // its session: that is read from the head, and the turns themselves
      // come back through the bounded, paged read the reset starts.
      const turns = kapOversizedTurnsHead(raw);
      if (turns) {
        const reset = { type: 'turns', session_id: turns.sessionId, agent_id: turns.agentId, turns: [] };
        for (const legacy of this.translate(reset)) this.deliver(legacy);
        return;
      }
      // Any other oversized frame is handed on untouched, so the connection's
      // own ceiling drops it and records the hole, as it would on the 0.x wire.
      this.fire('message', { data: raw });
      return;
    }
    let frame: Row | undefined;
    try {
      frame = asRow(JSON.parse(frameText(raw)));
    } catch {
      return;
    }
    if (frame) for (const legacy of this.translate(frame)) this.deliver(legacy);
  }

  /** One KAP frame → the 0.x frames it stands for (often none). */
  translate(frame: Row): Row[] {
    const type = frame.type;
    if (type === 'ping') return [{ type: 'ping', payload: {} }];
    if (type === 'response') return this.acknowledge(frame);
    if (type === 'session') return this.sessionFrame(frame);
    const sessionId = str(frame.session_id);
    if (!sessionId || !this.subscribed.has(sessionId)) return [];
    const live = this.hub.session(sessionId);
    const agentId = str(frame.agent_id) ?? 'main';
    const main = agentId === 'main';
    const envelope = (eventType: string, payload: Row): Row => {
      live.seq += 1;
      return {
        type: eventType,
        session_id: sessionId,
        seq: live.seq,
        epoch: this.hub.epochAt(this.url),
        timestamp: typeof frame.event_created_at === 'string' ? frame.event_created_at : new Date().toISOString(),
        payload: { agentId, ...payload },
      };
    };
    switch (type) {
      case 'turns': {
        if (!main) return [];
        for (const turn of rows(frame.turns)) noteTurn(live, turn);
        // KAP: "replaces the client copy of those turns" — the 0.x reset.
        return [envelope('transcript.reset', {})];
      }
      case 'turns.removed':
        return main ? [envelope('transcript.reset', {})] : [];
      case 'turn.started': {
        const turn = asRow(frame.turn);
        const ref = turn ? kapTurnRef(turn) : undefined;
        if (!turn || ref === undefined) return [];
        if (main) noteTurn(live, turn);
        return [envelope('turn.started', { turnId: ref })];
      }
      case 'item.started':
      case 'item.ended': {
        const item = asRow(frame.item);
        const turnId = str(frame.turn_id);
        const ref = turnId ? live.turnRefs.get(turnId) : undefined;
        if (!item || !main) return [];
        if (ref !== undefined) notePrompt(live, ref, item);
        // The prompt's own echo, the moment it is written: worth a read now
        // rather than at the end of the first step.
        return type === 'item.ended' && item.type === 'user_message' ? [envelope('transcript.ops', {})] : [];
      }
      case 'turn.updated': {
        const turnId = str(frame.turn_id);
        const ref = turnId ? live.turnRefs.get(turnId) : undefined;
        if (!asRow(frame.step) || ref === undefined) return [];
        return [envelope('turn.step.completed', { turnId: ref })];
      }
      case 'turn.ended':
        return this.turnEnded(frame, live, main, envelope);
      case 'interaction':
        return this.interaction(frame, envelope);
      case 'agent':
      case 'context':
        if (!main) return [];
        if (type === 'agent') live.agent = frame;
        else live.context = frame;
        // The `.../status` read answers from these two frames, so a new one is
        // a new reading NOW: say so, and the connection reads it at once
        // instead of on its next poll.
        return [envelope(KIMI_AGENT_STATE_EVENT, {})];
      case 'task':
      case 'task.list': {
        // The main agent's background shell tasks and subagents (`task` per
        // change, `task.list` as the whole list right after every subscribe,
        // captured), passed on as the task states themselves.
        if (!main) return [];
        const tasks = type === 'task' ? [kapTaskState(frame)] : rows(frame.tasks).map(kapTaskState);
        return [envelope(KIMI_BACKGROUND_TASKS_EVENT, { tasks, snapshot: type === 'task.list' })];
      }
      case 'goal':
        if (main) live.goal = { goal: frame.goal ?? null };
        return [];
      default:
        return [];
    }
  }

  private acknowledge(frame: Row): Row[] {
    const requestId = str(frame.request_id);
    const pending = requestId ? this.pendingSubscribes.get(requestId) : undefined;
    if (!requestId || !pending) return [];
    this.pendingSubscribes.delete(requestId);
    const code = typeof frame.code === 'number' ? frame.code : -1;
    if (code !== 0) {
      return [{
        type: 'ack',
        ...(pending.ackId ? { id: pending.ackId } : {}),
        code,
        msg: typeof frame.msg === 'string' ? frame.msg : 'subscribe refused',
        payload: { accepted: [], not_found: code === 40401 ? [pending.sessionId] : [], resync_required: [], cursors: {} },
      }];
    }
    this.subscribed.add(pending.sessionId);
    const live = this.hub.session(pending.sessionId);
    return [{
      type: 'ack',
      ...(pending.ackId ? { id: pending.ackId } : {}),
      code: 0,
      msg: 'success',
      payload: {
        accepted: [pending.sessionId],
        not_found: [],
        resync_required: [],
        cursors: { [pending.sessionId]: { seq: live.seq, epoch: this.hub.epochAt(this.url) } },
      },
    }];
  }

  /**
   * The global `session` frame (sent to every socket, captured) → the 0.x
   * `event.session.work_changed` for a subscribed session. The live state is
   * updated for any session the hub already tracks.
   */
  private sessionFrame(frame: Row): Row[] {
    const row = asRow(frame.session);
    const sessionId = str(row?.id);
    if (!row || !sessionId) return [];
    const tracked = this.hub.peek(sessionId);
    if (tracked) {
      if (typeof row.activity === 'string') tracked.activity = row.activity;
      tracked.pendingInteraction = typeof row.pending_interaction === 'string' ? row.pending_interaction : 'none';
      if (typeof row.last_turn_outcome === 'string') tracked.lastTurnOutcome = row.last_turn_outcome;
    }
    if (!this.subscribed.has(sessionId) || frame.change === 'deleted') return [];
    const live = this.hub.session(sessionId);
    live.seq += 1;
    return [{
      type: 'event.session.work_changed',
      session_id: sessionId,
      seq: live.seq,
      epoch: this.hub.epochAt(this.url),
      timestamp: typeof frame.event_created_at === 'string' ? frame.event_created_at : new Date().toISOString(),
      payload: {
        agentId: 'main',
        busy: legacyBusy(row),
        pending_interaction: typeof row.pending_interaction === 'string' ? row.pending_interaction : 'none',
      },
    }];
  }

  /**
   * `turn.ended` → 0.x `turn.ended {turnId, reason, error}` and then, as a 0.x
   * host wrote them, one `prompt.completed` / `prompt.aborted` per prompt the
   * turn carried — which is what clears the drive connection's prompt fences.
   */
  private turnEnded(
    frame: Row,
    live: KimiKapSessionLive,
    main: boolean,
    envelope: (type: string, payload: Row) => Row,
  ): Row[] {
    const turn = asRow(frame.turn);
    const ref = turn ? kapTurnRef(turn) : undefined;
    if (!turn || ref === undefined) return [];
    const outcome = str(turn.outcome);
    const reason = outcome === 'interrupted' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed';
    const out = [envelope('turn.ended', {
      turnId: ref,
      reason,
      // `null` on every turn that did not fail (captured), so absent and null
      // are the same: no error.
      ...(turn.error != null ? { error: turn.error } : {}),
      ...(turn.end_reason != null ? { interruptReason: turn.end_reason } : {}),
    })];
    if (!main) return out;
    if (outcome) live.lastTurnOutcome = outcome;
    // READ, not consumed: the record is the session's, and every socket on the
    // session (an observe and a drive connection, two clients) owes its own
    // connection the same settlement. The map is bounded instead.
    const prompts = live.turnPrompts.get(ref) ?? [];
    for (const promptId of prompts) {
      out.push(reason === 'cancelled'
        ? envelope('prompt.aborted', { promptId })
        : envelope('prompt.completed', { promptId, reason: reason === 'failed' ? 'failed' : 'completed' }));
    }
    return out;
  }

  /**
   * `interaction` (approval or question, pending or ended; pending ones are
   * re-sent after every subscribe, captured) → the 0.x
   * `event.approval.*` / `event.question.*` payloads.
   */
  private interaction(frame: Row, envelope: (type: string, payload: Row) => Row): Row[] {
    const id = str(frame.interaction_id);
    if (!id) return [];
    const pending = frame.status === 'pending';
    if (frame.kind === 'approval') {
      if (pending) {
        const legacy = legacyApproval(frame);
        return legacy ? [envelope('event.approval.requested', legacy)] : [];
      }
      const response = asRow(frame.response) ?? {};
      const decision = str(response.decision)
        ?? (frame.outcome === 'approved' ? 'approved' : frame.outcome === 'cancelled' ? 'cancelled' : 'rejected');
      return [envelope('event.approval.resolved', {
        approval_id: id,
        decision,
        ...(response.scope !== undefined ? { scope: response.scope } : {}),
      })];
    }
    if (frame.kind === 'question') {
      if (pending) {
        const legacy = legacyQuestion(frame);
        return legacy ? [envelope('event.question.requested', legacy)] : [];
      }
      return [envelope(frame.outcome === 'answered' ? 'event.question.answered' : 'event.question.dismissed', { question_id: id })];
    }
    return [];
  }
}
