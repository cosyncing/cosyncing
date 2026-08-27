/**
 * Kimi SUBAGENT HISTORY — replaying one child's own `wire.jsonl` as canonical rows.
 *
 * Every shape below was MEASURED against the live host on 2026-08-25 and is
 * written up in
 * `docs-internal/active/investigations/2026-08-21-Implenation/kimi-subagent-wire-facts.md`;
 * §-references point into it. This module replays the CHILD's journal and
 * nothing else — never the parent's history, and never `usage.ts`'s
 * token-shape reader, which answers "what did this stream spend" over the same
 * bytes.
 *
 * ── WHAT IS REUSED, AND THE MEASUREMENT THAT DECIDED IT ────────────────────
 *
 * The honest answer is "half of it", and the split is not a judgement call:
 *
 *  REUSED. `context.append_message.message` is structurally the REST message
 *  {@link mapKimiMessage} already consumes. Its `content[]` parts are the SAME
 *  shapes with the SAME field names — `{type:'text', text}` (1,374 measured)
 *  and `{type:'image_url', imageUrl:{url}}` (2) — and its provenance is the
 *  same `origin.kind` closed set of 7 (`injection` 768, `user` 314,
 *  `background_task` 132, `task` 72, `system_trigger` 69, `skill_activation`
 *  15, `cron_job` 3). Only the ENVELOPE differs: the journal puts `origin` on
 *  `message` where REST puts it on `metadata`, and the timestamp on the line
 *  rather than in `created_at`. So these lines are ADAPTED into the REST shape
 *  and handed to `mapKimiMessage` — reflection §5, one fact one code path. That
 *  reuses the whole classification stack (injection folding, task-notification
 *  correlation, skill-activation splitting, image handling) rather than
 *  reimplementing reflection §10 a second time and letting the two drift.
 *
 *  NOT REUSED. The journal records NO assistant message: `message.role` is
 *  `'user'` on 1,373/1,373 lines, and `message.toolCalls` is an EMPTY ARRAY on
 *  1,373/1,373. Everything the model produced — its text, its thinking, its
 *  tool calls and their results — lives only in `context.append_loop_event`,
 *  a line type no existing mapper has ever seen. So loop events get a new
 *  mapper here, and it maps only the five measured `event.type` values.
 *
 * ── THE DUPLICATE THAT WOULD HAVE DOUBLED EVERY USER ROW ───────────────────
 *
 * `turn.prompt` / `turn.steer` (577 lines) and `context.append_message` (1,373)
 * BOTH carry the submitted text. Measured: 574 of the 577 prompt/steer lines
 * have an exact text match in a `context.append_message` in the same journal.
 * Mapping both would render every user message twice. `context.append_message`
 * is the canonical record — it is what the model was actually shown, and it is
 * a strict superset in practice (it also holds the 768 pure `injection` lines
 * that no prompt line records) — so THIS module maps `context.append_message`
 * and deliberately maps no `turn.prompt`. Those lines remain the identity and
 * title source for the roster row (`subagents.ts`), where they are not a
 * transcript row at all.
 *
 * ── UNKNOWN LINES RENDER AS NOTHING, WITH A TRACE ──────────────────────────
 *
 * A `type` this module was not measured against emits NO row. It is counted,
 * and the counts ride out on ONE `kimi.subagent-unmapped` event so drift is
 * visible without inventing a card for a line nobody has read. A guessed card
 * is worse than no card: round 1 shipped a fixture asserting a shape the server
 * could not produce, with full coverage, and it was wrong.
 *
 * ── BLOBS ──────────────────────────────────────────────────────────────────
 *
 * An image reference is `blobref:<mime>;<sha256>` inside a string — never a
 * bare hash field. Matching on the 64-hex SHAPE would pick up 8,824
 * `systemPromptHash` and 8,824 `toolsHash` values, none of which name a file.
 * So the match is on the `blobref:` PREFIX (§7). This module does not inline
 * blob bytes: the store holds up to 542 files and a single PNG dwarfs a whole
 * transcript, so a reference the child journal makes renders as an honest
 * placeholder naming its media type. Resolving one into an artifact needs a
 * `file-artifact` URL the broker serves, which is Landing 2+ work and is
 * recorded as such rather than half-built here.
 */
import { join } from 'node:path';

import type {
  AgentMessage,
  AgentMessageHandler,
  SessionConnection,
  SessionInfo,
  Unsubscribe,
} from '@cosyncing/adapter-api';

import {
  createKimiMappingState,
  kimiToolDisplayClass,
  mapKimiMessage,
  truncateToUtf8Budget,
  type KimiMappingState,
} from './mapping.ts';
import {
  defaultKimiSubagentIo,
  KIMI_SUBAGENT_MAX_LINE_BYTES,
  type KimiSubagentIo,
} from './subagents.ts';

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * How much of a child journal ONE history replay reads, taken from the END.
 *
 * Measured child journals run to 10,201,217 bytes (p50 498,816), so a whole-file
 * read is not an option. The TAIL is the right window: a replay shows the most
 * recent conversation and the client pages backward from there. Equal to the
 * telemetry reader's `KIMI_WIRE_TAIL_CAP_BYTES` on purpose — two different
 * windows over the same file would make "what the transcript shows" and "what
 * it cost" describe different conversations.
 */
export const KIMI_SUBAGENT_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Rows one replay may emit. A 4 MiB tail of tool spam must not become an unbounded array. */
export const KIMI_SUBAGENT_HISTORY_ROW_MAX = 4_000;

/** Longest single text body a row carries out of the journal, in UTF-8 BYTES. */
export const KIMI_SUBAGENT_TEXT_CAP = 64 * 1024;

// ── Line reading ────────────────────────────────────────────────────────────

/** One journal line, with the absolute byte offset that gives it a stable key. */
export interface KimiWireLine {
  /** Absolute byte offset of the line's first byte within the file. */
  offset: number;
  record: Record<string, unknown>;
}

export interface KimiWireLineRead {
  lines: KimiWireLine[];
  /** True when the read started past byte 0 — the replay is a window, not the whole session. */
  clipped: boolean;
  /** Lines dropped for exceeding {@link KIMI_SUBAGENT_MAX_LINE_BYTES}, or unparseable. */
  dropped: number;
  fileSize: number;
}

/**
 * Read the last {@link KIMI_SUBAGENT_HISTORY_TAIL_BYTES} of a child journal as
 * whole, parsed lines.
 *
 * The first fragment is discarded whenever the window started past byte 0: a
 * tail read cuts the file mid-line by construction, and parsing that fragment
 * would either throw or — worse — succeed on a truncated object and yield a
 * field that is not what the file says.
 */
export function readKimiWireTailLines(
  wirePath: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
  tailBytes: number = KIMI_SUBAGENT_HISTORY_TAIL_BYTES,
): KimiWireLineRead | undefined {
  let fd: number;
  try {
    fd = io.openRead(wirePath);
  } catch {
    return undefined;
  }
  try {
    const { size } = io.statOf(fd);
    const want = Math.min(size, tailBytes);
    const start = size - want;
    const buffer = Buffer.alloc(want);
    let filled = 0;
    while (filled < want) {
      const n = io.readAt(fd, buffer, filled, want - filled, start + filled);
      if (n <= 0) break;
      filled += n;
    }
    const text = buffer.subarray(0, filled).toString('utf8');
    const clipped = start > 0;
    const out: KimiWireLine[] = [];
    let dropped = 0;
    // Offsets are tracked in BYTES, not characters: a journal is full of
    // multi-byte text, and a character offset would not name a byte position.
    let cursor = start;
    const parts = text.split('\n');
    for (const [index, part] of parts.entries()) {
      const byteLength = Buffer.byteLength(part, 'utf8');
      const offset = cursor;
      cursor += byteLength + 1; // +1 for the newline this split consumed
      // The first fragment of a clipped window is a partial line; the last
      // fragment of ANY window is unterminated unless the file ends in \n.
      if (clipped && index === 0) continue;
      if (index === parts.length - 1 && byteLength > 0) continue;
      const line = part.trim();
      if (!line) continue;
      if (byteLength > KIMI_SUBAGENT_MAX_LINE_BYTES) {
        dropped += 1;
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          dropped += 1;
          continue;
        }
        out.push({ offset, record: value as Record<string, unknown> });
      } catch {
        dropped += 1;
      }
    }
    return { lines: out, clipped, dropped, fileSize: size };
  } catch {
    return undefined;
  } finally {
    io.close(fd);
  }
}

// ── Small readers ───────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Bound a body this module lifts out of the journal, marking what it cut.
 *
 * Delegates to the package's ONE truncation rule rather than carrying a second.
 * The version that lived here measured the cap in UTF-8 bytes and then cut with
 * `slice()`, which counts UTF-16 CODE UNITS — so a CJK body under a 64 KiB cap
 * came back at roughly three times it, and a cut landing between the two units
 * of a surrogate pair emitted a lone surrogate. Journal bodies are exactly
 * where that bites: a child's thinking text is frequently CJK on this host, and
 * tool output carries emoji. `truncateToUtf8Budget` iterates code points and
 * counts the marker inside the budget, so neither failure is reachable.
 */
export function boundKimiSubagentText(text: string, cap: number = KIMI_SUBAGENT_TEXT_CAP): string {
  if (Buffer.byteLength(text, 'utf8') <= cap) return text;
  return truncateToUtf8Budget(text, cap);
}

/** A row key that is stable for an append-only file and independent of the read window. */
export function kimiWireRowKey(offset: number, suffix?: string): string {
  return `kimi-wire:@${offset}${suffix ? ':' + suffix : ''}`;
}

/**
 * The media type of a `blobref:` reference, or undefined for anything else.
 *
 * Matches the PREFIX, never the 64-hex shape — see the header. Format measured
 * in 554/554 references: `blobref:<mime>;<64-hex>`.
 */
export function kimiBlobRefMime(url: unknown): string | undefined {
  const value = str(url);
  if (value === undefined || !value.startsWith('blobref:')) return undefined;
  const rest = value.slice('blobref:'.length);
  const semi = rest.indexOf(';');
  if (semi <= 0) return undefined;
  return rest.slice(0, semi);
}

/** Where a blob's bytes live, for a caller that later grows an artifact path. */
export function kimiBlobPath(sessionDir: string, agentDir: string, digest: string): string {
  return join(sessionDir, 'agents', agentDir, 'blobs', digest);
}

// ── The mapper ──────────────────────────────────────────────────────────────

export interface KimiSubagentHistoryResult {
  messages: AgentMessage[];
  /** Line types this module was not measured against, with their counts. */
  unmapped: Record<string, number>;
  /** True when the replay window did not reach the start of the journal. */
  clipped: boolean;
  /** Lines dropped as over-long or unparseable. */
  dropped: number;
  /** True when {@link KIMI_SUBAGENT_HISTORY_ROW_MAX} stopped the fold. */
  rowCapped: boolean;
}

/**
 * The five `context.append_loop_event` shapes, measured (§6, n=48,404):
 *   `tool.call`    10,759 — `toolCallId`, `name`, `args`, `description?`, `display?`
 *   `tool.result`  10,758 — `toolCallId`, `parentUuid`, `result{output, note?, isError?, truncated?}`
 *   `content.part`  9,337 — `part{type:'think'|'text', …}`
 *   `step.begin`    8,801 — turn telemetry, no transcript content
 *   `step.end`      8,749 — usage + latency telemetry, no transcript content
 * `step.begin`/`step.end` are KNOWN and deliberately render nothing: they carry
 * token counts and timings, which is `usage.ts`'s subject, not a transcript's.
 * They are therefore not counted as unmapped — a known-empty line is not drift.
 */
const KIMI_LOOP_EVENT_SILENT = new Set(['step.begin', 'step.end']);

/**
 * Fold one child's journal lines into canonical rows.
 *
 * Ordering is the file's own: a journal is append-only, so the lines already
 * arrive in the order the child produced them and nothing here re-sorts.
 */
export function mapKimiSubagentHistory(
  read: KimiWireLineRead,
  state: KimiMappingState = createKimiMappingState(),
): KimiSubagentHistoryResult {
  const messages: AgentMessage[] = [];
  const unmapped: Record<string, number> = {};
  let rowCapped = false;

  const push = (message: AgentMessage): void => {
    if (messages.length >= KIMI_SUBAGENT_HISTORY_ROW_MAX) {
      rowCapped = true;
      return;
    }
    messages.push(message);
  };

  for (const { offset, record } of read.lines) {
    if (rowCapped) break;
    const type = str(record.type);
    if (type === undefined) continue;
    const time = num(record.time);

    switch (type) {
      // ── The REUSED path ────────────────────────────────────────────────
      case 'context.append_message': {
        const message = obj(record.message);
        if (!message) break;
        // Adapted into the REST envelope `mapKimiMessage` consumes: the journal
        // puts `origin` on the message and the timestamp on the line, and
        // carries no per-message id on 1,240 of 1,373 lines — so the byte
        // offset supplies identity, which is stable for an append-only file and
        // does not shift when the read window does.
        const rows = mapKimiMessage(
          {
            id: kimiWireRowKey(offset),
            role: message.role,
            content: message.content,
            ...(time !== undefined ? { created_at: time } : {}),
            ...(message.origin !== undefined ? { metadata: { origin: message.origin } } : {}),
          },
          state,
        );
        for (const row of rows) push(row.message);
        break;
      }

      // ── The NEW path ───────────────────────────────────────────────────
      case 'context.append_loop_event': {
        const event = obj(record.event);
        if (!event) break;
        const eventType = str(event.type);
        if (eventType === undefined) break;
        if (KIMI_LOOP_EVENT_SILENT.has(eventType)) break;

        if (eventType === 'content.part') {
          const part = obj(event.part);
          const partType = str(part?.type);
          // Measured closed set: `think` 6,345, `text` 2,992. The body field is
          // NAMED BY the part type — `think.think`, `text.text` — not a common
          // `text` field, so reading `part.text` unconditionally would silently
          // drop every thinking row.
          if (part === undefined || partType === undefined) break;
          const body = str(part[partType]);
          if (body === undefined) break;
          const key = kimiWireRowKey(offset);
          if (partType === 'think') {
            push({ type: 'thinking', text: boundKimiSubagentText(body), key });
          } else if (partType === 'text') {
            push({ type: 'model-output', text: boundKimiSubagentText(body), key, final: true });
          } else {
            // A third part type would be new upstream: counted, never guessed.
            unmapped[`content.part:${partType}`] = (unmapped[`content.part:${partType}`] ?? 0) + 1;
          }
          break;
        }

        if (eventType === 'tool.call') {
          const callId = str(event.toolCallId);
          const toolName = str(event.name);
          if (callId === undefined || toolName === undefined) break;
          // The SAME classifier the REST path uses, imported rather than
          // re-tabulated: one tool name must not render as two different
          // classes depending on which reader produced the row.
          const toolClass = kimiToolDisplayClass(toolName);
          const title = str(event.description);
          push({
            type: 'tool-call',
            callId,
            toolName,
            ...(toolClass ? { toolClass } : {}),
            ...(title ? { title } : {}),
            ...(event.args !== undefined ? { args: event.args } : {}),
          });
          state.toolNames.set(callId, toolName);
          break;
        }

        if (eventType === 'tool.result') {
          const callId = str(event.toolCallId);
          if (callId === undefined) break;
          const result = obj(event.result);
          // The call is the only place the tool NAME appears; a result whose
          // call fell outside the read window keeps an empty name rather than a
          // guessed one, exactly as the REST path degrades.
          const toolName = state.toolNames.get(callId) ?? '';
          const toolClass = kimiToolDisplayClass(toolName || undefined);
          const output = result?.output;
          push({
            type: 'tool-result',
            callId,
            toolName,
            ...(toolClass ? { toolClass } : {}),
            ...(result?.isError === true ? { isError: true } : {}),
            ...(result?.truncated === true ? { truncated: true } : {}),
            ...(output !== undefined ? { result: boundKimiToolOutput(output) } : {}),
          });
          break;
        }

        unmapped[`loop:${eventType}`] = (unmapped[`loop:${eventType}`] ?? 0) + 1;
        break;
      }

      // ── Known, and deliberately silent ─────────────────────────────────
      //
      // `turn.prompt`/`turn.steer` are the duplicate the header explains: their
      // text is already carried by `context.append_message` (574 of 577
      // measured). The rest are session telemetry, not transcript content.
      // Silence here is a DECISION backed by a measurement, so none of these is
      // counted as drift.
      case 'metadata':
      case 'turn.prompt':
      case 'turn.steer':
      case 'turn.ended':
      case 'turn.cancel':
      case 'llm.request':
      case 'llm.tools_snapshot':
      case 'usage.record':
      case 'config.update':
      case 'profile.bind':
      case 'permission.set_mode':
      case 'permission.record_approval_result':
      case 'prompt.accepted':
      case 'tools.update_store':
      case 'tools.set_active_tools':
      case 'token_counting.measured':
      case 'token_counting.turn_recorded':
      case 'token_counting.rebased':
      case 'staleGuard.recorded':
      case 'runtime.set_binding':
      case 'plugin.session_start':
      case 'task.started':
      case 'task.terminated':
      case 'full_compaction.begin':
      case 'full_compaction.complete':
      case 'context.apply_compaction':
      case 'context.undo':
        break;

      default:
        unmapped[type] = (unmapped[type] ?? 0) + 1;
        break;
    }
  }

  return { messages, unmapped, clipped: read.clipped, dropped: read.dropped, rowCapped };
}

/**
 * Bound a tool result's body. `output` is a string on 10,172 of 10,758 measured
 * results and a part array on 586; an image part inside one is replaced by an
 * honest placeholder rather than by its blob bytes (see the header).
 */
function boundKimiToolOutput(output: unknown): unknown {
  if (typeof output === 'string') return boundKimiSubagentText(output);
  if (!Array.isArray(output)) return output;
  const parts: unknown[] = [];
  for (const raw of output) {
    const part = obj(raw);
    if (!part) continue;
    const partType = str(part.type);
    if (partType === 'text') {
      const text = str(part.text);
      parts.push({ type: 'text', text: text === undefined ? '' : boundKimiSubagentText(text) });
      continue;
    }
    if (partType === 'image_url') {
      const mime = kimiBlobRefMime(obj(part.imageUrl)?.url);
      // A reference, not the bytes. Inlining a 7 MB PNG into a transcript row
      // is how a replay becomes unbounded; naming the media type is honest and
      // costs nothing.
      parts.push({ type: 'image', mimeType: mime ?? 'application/octet-stream', inlined: false });
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/**
 * The trace row for lines this module did not map, or `undefined` when there
 * were none. Emitted ONCE at the end of a replay rather than per line: a
 * thousand unknown lines are one drift signal, not a thousand cards.
 */
export function kimiSubagentUnmappedTrace(result: KimiSubagentHistoryResult): AgentMessage | undefined {
  const names = Object.keys(result.unmapped);
  if (names.length === 0 && !result.clipped && result.dropped === 0 && !result.rowCapped) return undefined;
  return {
    type: 'event',
    name: 'kimi.subagent-unmapped',
    payload: {
      ...(names.length ? { types: result.unmapped } : {}),
      ...(result.clipped ? { clipped: true } : {}),
      ...(result.dropped ? { dropped: result.dropped } : {}),
      ...(result.rowCapped ? { rowCapped: true } : {}),
    },
  };
}

/**
 * Replay one child journal end to end: bounded tail read, fold, trace.
 *
 * An unreadable journal yields NO rows rather than a throw — a subagent whose
 * file vanished between the roster read and the attach is a normal race, and an
 * attach is no place for an exception about another product's file.
 */
export function readKimiSubagentHistory(
  wirePath: string,
  io: KimiSubagentIo = defaultKimiSubagentIo,
  tailBytes: number = KIMI_SUBAGENT_HISTORY_TAIL_BYTES,
): AgentMessage[] {
  const read = readKimiWireTailLines(wirePath, io, tailBytes);
  if (read === undefined) return [];
  const result = mapKimiSubagentHistory(read);
  const trace = kimiSubagentUnmappedTrace(result);
  return trace ? [...result.messages, trace] : result.messages;
}

// ── The connection ──────────────────────────────────────────────────────────

/** Refused on every mutating entry point; single-sourced so no path can differ. */
export const KIMI_SUBAGENT_MUTATION_REFUSAL =
  'This Kimi subagent row is observe-only: the Kimi CLI owns the child, and cosyncing has no writer for it.';

/**
 * A subagent row's connection: the child's own journal, replayed, and nothing
 * else.
 *
 * NO transport of any kind. It opens no socket, resolves no server, and holds
 * no descriptor between calls — a child is a FILE, and the only thing an attach
 * on one can honestly do is read it. That is also why the class is safe to hand
 * out before any instance verification: there is nothing for a verified
 * instance to be verified for.
 *
 * NO live tail either, and that is a deliberate refusal rather than an
 * omission. Nothing in the capture shows what a RUNNING child's journal looks
 * like — every measured journal was written by a process that had already
 * exited (wire-facts §U1) — so a tail would be built on a guess about append
 * behaviour that no measurement supports. `subscribe` therefore accepts a
 * handler and delivers nothing, which is honest: the row is a transcript, and
 * the roster's own refresh is what moves its status.
 *
 * Every mutating method rejects. The broker will not call them on an observe
 * connection, but reflection §11 is explicit that authority belongs to the
 * object rather than to the caller's good manners.
 */
export class KimiSubagentConnection implements SessionConnection {
  readonly info: SessionInfo;
  readonly #wirePath: string;
  readonly #io: KimiSubagentIo;

  constructor(info: SessionInfo, wirePath: string, io: KimiSubagentIo = defaultKimiSubagentIo) {
    this.info = info;
    this.#wirePath = wirePath;
    this.#io = io;
  }

  async getHistory(): Promise<AgentMessage[]> {
    return readKimiSubagentHistory(this.#wirePath, this.#io);
  }

  subscribe(_handler: AgentMessageHandler): Unsubscribe {
    return () => {};
  }

  async sendPrompt(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async respondPermission(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async answerQuestion(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async rejectQuestion(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async sendFile(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async runCommand(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async respondPlan(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async setAgent(): Promise<void> {
    throw new Error(KIMI_SUBAGENT_MUTATION_REFUSAL);
  }

  async close(): Promise<void> {
    // Nothing to release: no socket, no timer, no descriptor.
  }
}
