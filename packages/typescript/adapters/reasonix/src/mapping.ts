/**
 * Total mapping for Reasonix v1.25.2's flat JSONL transcript.
 *
 * Only a native `user` role becomes a human bubble. System rows become context,
 * measured tool rows become bounded tool results, and unknown shapes use the
 * named context-injection category so a future Reasonix schema cannot turn
 * machine-authored material into user speech or take out replay.
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
  tool_call_id?: unknown;
  tool_execution?: unknown;
  [key: string]: unknown;
}

const MAX_TOOL_FIELD_CHARS = 512;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;

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

function boundedToolResult(value: unknown): unknown {
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
    if (records[index]?.role === 'user') {
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
