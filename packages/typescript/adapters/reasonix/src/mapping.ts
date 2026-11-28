/**
 * Total mapping for the flat JSONL transcript Reasonix 1.25.2 and 2.61.0 share.
 *
 * Only a native `user` role the human wrote becomes a human bubble; a `user` row Reasonix wrote
 * itself (`host_authored`, 2.61.0) is context. System rows become context,
 * measured tool rows become bounded tool results, and unknown shapes use the
 * named context-injection category so a future Reasonix schema cannot turn
 * machine-authored material into user speech or take out replay. An assistant row's
 * `tool_calls` become the calls its tool rows answer, and each `todo_write` call also becomes the
 * session's task panel.
 */
import {
  CONTEXT_INJECTION_EVENT,
  boundContextBody,
  type AgentMessage,
} from '@cosyncing/adapter-api';

export interface ReasonixTranscriptRecord {
  role?: unknown;
  content?: unknown;
  raw_content?: unknown;
  reasoning_content?: unknown;
  workDurationMs?: unknown;
  createdAt?: unknown;
  name?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  tool_execution?: unknown;
  host_authored?: unknown;
  [key: string]: unknown;
}

/**
 * Whether a `user` row is the human's. Reasonix 2.61.0 writes its own `user` rows too: when an
 * assistant step ends without visible text it appends `"host_authored": true` with a continuation
 * instruction and no `raw_content` (measured 2026-11-24 continuing a 1.25.2 session; its display
 * entry is `synthetic` and starts no turn). Such a row is never a prompt, never an echo to claim,
 * and never a foreign write.
 */
export function isReasonixHumanUserRecord(record: ReasonixTranscriptRecord | undefined): boolean {
  return record?.role === 'user' && record.host_authored !== true;
}

const MAX_TOOL_FIELD_CHARS = 512;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;
/** Calls restated from one assistant row, which bounds what a malformed row can cost. */
const MAX_TOOL_CALLS_PER_RECORD = 256;
/** Bounds for one task panel; Reasonix sets none of its own. */
const MAX_PLAN_ITEMS = 256;
const MAX_PLAN_ITEM_CHARS = 4_000;

/** The tool whose arguments Reasonix mirrors as an ACP `plan` update. */
export const REASONIX_PLAN_TOOL = 'todo_write';

type ReasonixTaskListState = Extract<AgentMessage, { type: 'task-list-state' }>;

export interface ReasonixDisplayEntry {
  index: number;
  offset: number;
  length: number;
  role?: string;
  authoredTurn?: number;
  startsTurn?: boolean;
}

export interface ReasonixMapTrace {
  op: 'unmapped-record' | 'display-index-mismatch';
  detail: string;
}

export interface ReasonixMapContext {
  sessionId: string;
  lineIndex: number;
  display?: ReasonixDisplayEntry;
  trace?: (event: ReasonixMapTrace) => void;
}

export function reasonixMessageKey(sessionId: string, index: number): string {
  return `reasonix:${sessionId}:message:${index}`;
}

export function reasonixTurnId(sessionId: string, turn: number): string {
  return `reasonix:${sessionId}:turn:${turn}`;
}

/** One task panel per session: every plan Reasonix sends replaces the whole list. */
export function reasonixPlanKey(sessionId: string): string {
  return `reasonix:${sessionId}:plan`;
}

/**
 * The task panel for one list of `{content, status}` entries. Reasonix 1.25.2 and 2.61.0 build
 * the ACP `plan` update from the `todo_write` arguments (`planEntriesFromTodoArgs` in
 * `internal/acp/dispatch.go` and `internal/frontend/acp/dispatch.go`), so the live entries and the
 * stored arguments name the same items and both map here. As upstream does, a blank entry is
 * skipped and a status other than in_progress or completed reads as pending.
 */
export function reasonixTaskListState(sessionId: string, entries: readonly unknown[]): ReasonixTaskListState {
  const items: ReasonixTaskListState['items'] = [];
  for (const entry of entries) {
    if (items.length >= MAX_PLAN_ITEMS) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== 'string' || content.trim() === '') continue;
    items.push({
      id: String(items.length),
      title: content.length <= MAX_PLAN_ITEM_CHARS ? content : `${content.slice(0, MAX_PLAN_ITEM_CHARS - 1)}…`,
      status: status === 'completed' ? 'done' : status === 'in_progress' ? 'in-progress' : 'open',
    });
  }
  return {
    type: 'task-list-state',
    key: reasonixPlanKey(sessionId),
    status: items.length === 0 ? 'cleared'
      : items.every((item) => item.status === 'done') ? 'done'
        : 'running',
    source: 'native',
    sourceTool: REASONIX_PLAN_TOOL,
    items,
  };
}

/**
 * The panel a stored `todo_write` call shows, or none where Reasonix's own session/load replay sends
 * no plan: arguments that do not decode as `{todos: [{content: string, status: string, level:
 * integer}]}` (upstream decodes them into that Go struct and gives up on any type error), or a list
 * with no non-blank item. A call the tool then rejected still shows its list, live and replayed
 * alike, because Reasonix sends the plan when it dispatches the call.
 */
function storedTaskListState(sessionId: string, args: unknown): ReasonixTaskListState | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const todos = (args as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return undefined;
  for (const todo of todos) {
    if (todo === null) continue;
    if (typeof todo !== 'object' || Array.isArray(todo)) return undefined;
    const { content, status, level } = todo as { content?: unknown; status?: unknown; level?: unknown };
    if (content != null && typeof content !== 'string') return undefined;
    if (status != null && typeof status !== 'string') return undefined;
    if (level != null && !Number.isSafeInteger(level)) return undefined;
  }
  const panel = reasonixTaskListState(sessionId, todos);
  return panel.items.length > 0 ? panel : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedToolField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_FIELD_CHARS
    ? value
    : fallback;
}

/** A tool payload as the live drive reports it: the value, or a stated omission. */
export function boundedReasonixToolPayload(value: unknown, label: 'input' | 'output'): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return undefined;
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_PAYLOAD_BYTES) return value;
    return `[Reasonix tool ${label} exceeded ${MAX_TOOL_PAYLOAD_BYTES} bytes; omitted]`;
  } catch {
    return `[unserializable Reasonix tool ${label}]`;
  }
}

/**
 * The calls an assistant row made, as the live drive showed them. v1.25.2 dispatches each call
 * over ACP under the id it stores in `tool_calls`, and writes that id again on the tool row that
 * holds the result (upstream `internal/agent/run_loop.go`, `execute_batch.go`), so a replayed call
 * pairs with its result and matches the live row. ACP sends the stored arguments as raw JSON when
 * they parse and omits them otherwise. A `todo_write` call is preceded by its task panel, in the
 * order the live drive receives the `plan` update and then the call.
 */
function toolCallsOf(value: unknown, key: string, sessionId: string): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOL_CALLS_PER_RECORD).flatMap((entry, index): AgentMessage[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const call = entry as { id?: unknown; name?: unknown; arguments?: unknown };
    let args: unknown;
    if (typeof call.arguments === 'string' && call.arguments !== '') {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = undefined;
      }
    }
    const toolName = boundedToolField(call.name, 'Reasonix tool');
    const panel = call.name === REASONIX_PLAN_TOOL ? storedTaskListState(sessionId, args) : undefined;
    return [
      ...(panel ? [panel] : []),
      {
        type: 'tool-call',
        callId: boundedToolField(call.id, `${key}:call:${index}`),
        toolName,
        title: toolName,
        args: boundedReasonixToolPayload(args, 'input'),
      },
    ];
  });
}

/**
 * A stored tool result. Reasonix leaves `content` out of a row whose text is empty (an assistant
 * step without text has no `content` key either), and the live drive shows that result as empty
 * text, so an absent value is the empty result rather than an omission.
 */
function boundedToolResult(value: unknown): unknown {
  if (value === undefined) return '';
  if (typeof value !== 'string') return '[Reasonix tool result was not textual; omitted]';
  return Buffer.byteLength(value, 'utf8') <= MAX_TOOL_RESULT_BYTES
    ? value
    : `[Reasonix tool result exceeded ${MAX_TOOL_RESULT_BYTES} bytes; omitted]`;
}

function contextEvent(source: string, body: string): AgentMessage {
  const bounded = boundContextBody(body || '(empty record)');
  return {
    type: 'event',
    name: CONTEXT_INJECTION_EVENT,
    payload: {
      source,
      body: bounded.body,
      ...(bounded.truncated ? { truncated: true } : {}),
    },
  };
}

function unknownRecordBody(record: ReasonixTranscriptRecord): string {
  const shape = Object.keys(record).sort().slice(0, 32).join(', ') || '(no keys)';
  const content = textOf(record.content) ?? textOf(record.raw_content) ?? '';
  return content ? `keys: ${shape}\n\n${content}` : `keys: ${shape}`;
}

/** Map one native line without throwing. */
export function mapReasonixRecord(
  record: ReasonixTranscriptRecord,
  context: ReasonixMapContext,
): AgentMessage[] {
  try {
    const nativeIndex = context.display?.index ?? context.lineIndex;
    if (context.display && context.display.role && context.display.role !== record.role) {
      context.trace?.({
        op: 'display-index-mismatch',
        detail: `line ${context.lineIndex}: index role ${context.display.role} != record role ${String(record.role)}`,
      });
    }
    const key = reasonixMessageKey(context.sessionId, nativeIndex);
    const turn = context.display?.authoredTurn ?? nativeIndex;
    const turnId = reasonixTurnId(context.sessionId, turn);

    if (record.role === 'system') {
      return [contextEvent('Reasonix system context', textOf(record.content) ?? unknownRecordBody(record))];
    }

    if (record.role === 'user' && record.host_authored === true) {
      return [contextEvent('Reasonix host continuation', textOf(record.content) ?? unknownRecordBody(record))];
    }

    if (record.role === 'user') {
      const text = textOf(record.raw_content) ?? textOf(record.content);
      if (text !== undefined) {
        const sentAt = finiteNonnegativeNumber(record.createdAt);
        return [{
          type: 'user-message',
          text,
          key,
          turnId,
          ...(sentAt === undefined ? {} : { sentAt }),
        }];
      }
    }

    if (record.role === 'assistant') {
      const out: AgentMessage[] = [];
      const reasoning = textOf(record.reasoning_content);
      const content = textOf(record.content);
      const assistantMessageKey = `${key}:output`;
      if (reasoning?.trim()) out.push({ type: 'thinking', text: reasoning, key: `${key}:thinking` });
      if (content?.trim()) out.push({ type: 'model-output', text: content, key: assistantMessageKey, final: true });
      const runtime = finiteNonnegativeNumber(record.workDurationMs);
      if (runtime !== undefined) {
        out.push({
          type: 'run-summary',
          key: `${key}:summary`,
          turnId,
          ...(content?.trim() ? { assistantMessageKey } : {}),
          status: 'done',
          agentRuntimeMs: runtime,
          source: 'reasonix',
        });
      }
      // After the step's footer, so each call sits beside the tool rows that follow with its result.
      out.push(...toolCallsOf(record.tool_calls, key, context.sessionId));
      if (out.length > 0) return out;
    }

    if (record.role === 'tool') {
      const execution = typeof record.tool_execution === 'object'
        && record.tool_execution !== null
        && !Array.isArray(record.tool_execution)
        ? record.tool_execution as { state?: unknown; exitCode?: unknown }
        : undefined;
      const state = typeof execution?.state === 'string' ? execution.state.toLowerCase() : '';
      const isError = state === 'failed'
        || state === 'cancelled'
        || (typeof execution?.exitCode === 'number' && execution.exitCode !== 0);
      return [{
        type: 'tool-result',
        callId: boundedToolField(record.tool_call_id, `reasonix-tool:${context.sessionId}:${nativeIndex}`),
        toolName: boundedToolField(record.name, 'Reasonix tool'),
        result: boundedToolResult(record.content),
        isError,
      }];
    }

    context.trace?.({
      op: 'unmapped-record',
      detail: `line ${context.lineIndex}: role=${String(record.role)} keys=${Object.keys(record).sort().join(',')}`,
    });
    return [contextEvent(
      `Reasonix ${typeof record.role === 'string' ? record.role : 'unknown'} record (unmapped)`,
      unknownRecordBody(record),
    )];
  } catch (error) {
    context.trace?.({
      op: 'unmapped-record',
      detail: `line ${context.lineIndex}: mapper failure: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [contextEvent('Reasonix record (unmapped)', unknownRecordBody(record))];
  }
}

export function mapReasonixTranscript(
  sessionId: string,
  records: readonly ReasonixTranscriptRecord[],
  displayEntries: readonly ReasonixDisplayEntry[] = [],
  trace?: (event: ReasonixMapTrace) => void,
): AgentMessage[] {
  const displayByIndex = new Map(displayEntries.map((entry) => [entry.index, entry]));
  return records.flatMap((record, lineIndex) => mapReasonixRecord(record, {
    sessionId,
    lineIndex,
    display: displayByIndex.get(lineIndex),
    trace,
  }));
}

/** A durable user tail with no live owner is an abandoned turn, not active work. */
export function mapReasonixInterruptedTail(
  sessionId: string,
  records: readonly ReasonixTranscriptRecord[],
  displayEntries: readonly ReasonixDisplayEntry[] = [],
): AgentMessage | undefined {
  let lineIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isReasonixHumanUserRecord(records[index])) {
      lineIndex = index;
      break;
    }
  }
  if (lineIndex < 0) return undefined;
  // A cancelled Reasonix tool turn is durably represented as user + one or
  // more tool rows, with no assistant row. The caller proves the native owner
  // is idle before using this inference.
  if (records.slice(lineIndex + 1).some((record) => record.role === 'assistant')) return undefined;
  const display = displayEntries.find((entry) => entry.index === lineIndex);
  const nativeIndex = display?.index ?? lineIndex;
  const key = reasonixMessageKey(sessionId, nativeIndex);
  const turnId = reasonixTurnId(sessionId, display?.authoredTurn ?? nativeIndex);
  return {
    type: 'run-summary',
    key: `${key}:summary`,
    turnId,
    userMessageKey: key,
    status: 'cancelled',
    source: 'reasonix',
  };
}
