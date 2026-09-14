/** Total mapping for Cline 3.0.60 rewritten message snapshots. */
import {
  CONTEXT_INJECTION_EVENT,
  boundContextBody,
  type AgentMessage,
  type ToolDisplayClass,
} from '@cosyncing/adapter-api';
import type { ClineNativeMessage, ClineStoredSession, ClineUsage } from './store.ts';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_FIELD_CHARS = 512;
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;

export interface ClineMapTrace {
  op: 'unknown-block' | 'unknown-role' | 'mapping-error';
  detail: string;
}

export type ClineTerminalSummary = Extract<AgentMessage, { type: 'run-summary' }> & {
  status: 'done' | 'error' | 'cancelled';
};

export interface ClineMapContext {
  sessionId: string;
  trace?: (event: ClineMapTrace) => void;
  /**
   * Whether THIS message is provably finished in the transcript being mapped.
   *
   * Carried because `final` is not decoration: the client gates
   * `readAloudSourceText` on `final === true`, and `_modelTextAggregate` skips
   * non-final segments when building copy-turn-text. Cline set it nowhere, so
   * both features were dead on every Cline session while reasonix and omp had
   * them. The flag is only asserted where completion is PROVEN — a later
   * message follows, or this assistant message already carries its `metrics` —
   * never inferred from a timer or from the read having succeeded, because
   * `_withCarriedFinality` makes a wrong `true` permanent.
   */
  settled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars = MAX_TOOL_FIELD_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : undefined;
}

function boundedText(value: unknown): { text: string; truncated?: true } | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= MAX_TEXT_BYTES) return { text: value };
  return { text: bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8'), truncated: true };
}

function boundedPayload(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return undefined;
    return Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_PAYLOAD_BYTES
      ? value
      : `[Cline ${label} exceeded ${MAX_TOOL_PAYLOAD_BYTES} bytes; omitted]`;
  } catch {
    return `[Cline ${label} was not serializable; omitted]`;
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toolClass(name: string): ToolDisplayClass {
  const normalized = name.toLowerCase();
  if (/read|search|find|list|inspect|fetch|grep/u.test(normalized)) return 'lookup';
  if (/write|edit|patch|replace|delete|move|rename/u.test(normalized)) return 'edit';
  if (/shell|command|exec|bash|terminal|run/u.test(normalized)) return 'execute';
  return 'other';
}

/** Cline's own per-command outcome, which it records and we were discarding.
 *
 *  A `run_commands` result body is a list of `{query, result, success}`. Measured
 *  on installed v70:
 *
 *      [{"query": "rm -f ... && touch ...", "result": "", "success": true}]
 *
 *  That block carries NO `is_error` key at all -- checked against the real
 *  session file, whose only keys are content/name/tool_use_id/type. So deriving
 *  the lifecycle from `is_error` alone could never resolve anything:
 *  `resolveToolCommandState` reached its `unknown` branch and the row rendered
 *  "run commands - state unknown" directly above Cline's own prose saying the
 *  command had succeeded. The native lifecycle was in the payload the whole
 *  time.
 *
 *  Silence is not consent. An entry with no boolean `success` has stated no
 *  outcome, so a chain containing one cannot be called completed -- the first
 *  version of this filtered those entries out and reported `completed` for
 *  `[{success: true}, {result: 'boom'}]`, hiding the unreported command from
 *  both the verdict AND the rendered command line. A stated failure is still
 *  decisive, because one command failing fails the chain no matter what the
 *  others said.
 *
 *  Returns undefined when the outcome is not fully stated, so the row reaches
 *  the honest `unknown` rather than an invented success. */
function commandOutcome(
  content: unknown,
  nativeIsError: boolean,
): { state: 'completed' | 'failed'; command: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  const entries = content.filter(isRecord);
  if (entries.length === 0) return undefined;
  const anyStatedFailure = entries.some((entry) => entry.success === false);
  const allStatedSuccess = entries.every((entry) => entry.success === true);
  // `is_error` outranks a per-entry success: a block Cline itself flagged as an
  // error must never render a completed command, and the semantic is what the
  // client reads first (`resolveToolCommandState` returns it before ever
  // reaching `isError`).
  const state = anyStatedFailure || nativeIsError ? 'failed'
    : allStatedSuccess ? 'completed'
      : undefined;
  if (state === undefined) return undefined;
  // EVERY entry's command, including one that stated no outcome -- a chain is
  // not described by the subset that reported. `boundedString` rejects rather
  // than clips, which published an EMPTY command for a 70KB heredoc, so a
  // failed row could not say which command failed; clip instead, and bound the
  // join, which was the one field in this file with no aggregate cap.
  const queries: string[] = [];
  let budget = MAX_TOOL_PAYLOAD_BYTES;
  for (const entry of entries) {
    if (typeof entry.query !== 'string' || entry.query.length === 0) continue;
    if (budget <= 0) {
      queries.push(`[${entries.length - queries.length} more commands omitted]`);
      break;
    }
    const clipped = entry.query.length <= budget
      ? entry.query
      : `${entry.query.slice(0, budget)}… [command truncated]`;
    queries.push(clipped);
    budget -= Math.min(entry.query.length, budget);
  }
  return { state, command: queries.join('\n') };
}

function contextEvent(source: string, body: string): AgentMessage {
  const bounded = boundContextBody(body);
  return {
    type: 'event',
    name: CONTEXT_INJECTION_EVENT,
    payload: { source, body: bounded.body, ...(bounded.truncated ? { truncated: true } : {}) },
  };
}

function unknownBlock(message: ClineNativeMessage, block: Record<string, unknown>, index: number): AgentMessage {
  return contextEvent(
    'Cline content block (unmapped)',
    `message=${message.id} role=${message.role} block=${index} type=${String(block.type)} keys=${Object.keys(block).sort().join(',')}`,
  );
}

function usageMessage(message: ClineNativeMessage): AgentMessage | undefined {
  if (!isRecord(message.metrics)) return undefined;
  const input = nonNegative(message.metrics.inputTokens);
  const output = nonNegative(message.metrics.outputTokens);
  const cacheRead = nonNegative(message.metrics.cacheReadTokens);
  const cacheWrite = nonNegative(message.metrics.cacheWriteTokens);
  if ([input, output, cacheRead, cacheWrite].every((value) => value === undefined)) return undefined;
  // Cline's inputTokens already includes its cache subsets. Preserve the
  // subsets for display, but never add them into input here or in an aggregate.
  return {
    type: 'token-count',
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** The token usage attributable to ONE settled turn.
 *
 *  Cline reports usage per assistant message in `metrics`, and the drive path
 *  emits no live `token-count` at all -- so a turn's usage reached a reader only
 *  when a later history re-lay happened to carry the assistant row. The raw-wire
 *  oracle measures *attributable* usage over the rows between a prompt and the
 *  next one, and found nothing there: `usagePublished: false` on every Cline run,
 *  while the browser showed real numbers because that claim only asks whether a
 *  token row reached the socket, not whether it belongs to the turn.
 *
 *  `run-summary.tokens` is the contract's per-turn carrier, and the terminal
 *  summary already binds to the turn by `turnId`. This supplies its counts.
 *
 *  The LAST reporting assistant message wins rather than a sum: Cline's
 *  `inputTokens` already includes its cache subsets and is cumulative for the
 *  turn, so adding messages together would double-count -- the same trap
 *  `usageMessage` documents just above. */
export function clineTurnTokens(
  messages: readonly ClineNativeMessage[],
  userMessageId: string,
): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  const start = messages.findIndex((message) => message.id === userMessageId);
  if (start < 0) return undefined;
  let latest: Record<string, unknown> | undefined;
  for (const message of messages.slice(start + 1)) {
    // The next real prompt closes this turn. A `user` row carrying only tool
    // results is still inside it.
    if (message.role === 'user'
      && message.content.some((block) => block.type === 'text' && clineUserText(block.text) !== undefined)) {
      break;
    }
    if (message.role === 'assistant' && isRecord(message.metrics)) latest = message.metrics;
  }
  if (!latest) return undefined;
  const tokens = {
    ...(nonNegative(latest.inputTokens) === undefined ? {} : { input: nonNegative(latest.inputTokens)! }),
    ...(nonNegative(latest.outputTokens) === undefined ? {} : { output: nonNegative(latest.outputTokens)! }),
    ...(nonNegative(latest.cacheReadTokens) === undefined ? {} : { cacheRead: nonNegative(latest.cacheReadTokens)! }),
    ...(nonNegative(latest.cacheWriteTokens) === undefined ? {} : { cacheWrite: nonNegative(latest.cacheWriteTokens)! }),
  };
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export function clineMessageKey(sessionId: string, messageId: string): string {
  return `cline:${sessionId}:message:${messageId}`;
}

export function clineTurnId(sessionId: string, messageId: string): string {
  return `cline:${sessionId}:turn:${messageId}`;
}

/** Cline 3.0.60 persists human prompts inside its own exact mode envelope. */
export function clineUserText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = /^<user_input mode="(?:act|plan)">([\s\S]*)<\/user_input>$/u.exec(value);
  return match ? match[1] : value;
}

function mapKnownBlock(
  message: ClineNativeMessage,
  block: Record<string, unknown>,
  index: number,
  context: ClineMapContext,
): AgentMessage[] {
  const kind = boundedString(block.type, 128);
  const baseKey = `${clineMessageKey(context.sessionId, message.id)}:block:${index}`;
  if (message.role === 'user' && kind === 'text') {
    const body = boundedText(clineUserText(block.text));
    return body ? [{
      type: 'user-message',
      text: body.text,
      key: `${baseKey}:text`,
      turnId: clineTurnId(context.sessionId, message.id),
      ...(timestamp(message.ts) === undefined ? {} : { sentAt: timestamp(message.ts) }),
      ...(body.truncated ? { bodyTruncated: true } : {}),
    }] : [];
  }
  if (message.role === 'assistant' && kind === 'text') {
    const body = boundedText(block.text);
    return body ? [{
      type: 'model-output',
      text: body.text,
      key: `${baseKey}:text`,
      ...(context.settled ? { final: true } : {}),
      ...(body.truncated ? { bodyTruncated: true } : {}),
    }] : [];
  }
  if (message.role === 'assistant' && kind === 'thinking') {
    const body = boundedText(block.thinking);
    return body ? [{
      type: 'thinking',
      text: body.text,
      key: `${baseKey}:thinking`,
      ...(body.truncated ? { bodyTruncated: true } : {}),
    }] : [];
  }
  if (message.role === 'assistant' && kind === 'tool_use') {
    const callId = boundedString(block.id) ?? `cline-tool:${message.id}:${index}`;
    const name = boundedString(block.name) ?? 'Cline tool';
    const args = boundedPayload(block.input, 'tool input');
    const call: AgentMessage = {
      type: 'tool-call',
      callId,
      toolName: name,
      title: name,
      toolClass: toolClass(name),
      ...(args === undefined ? {} : { args }),
    };
    if (name !== 'spawn_agent') return [call];
    const input = isRecord(block.input) ? block.input : undefined;
    const title = boundedString(input?.task, 1_024) ?? 'Cline subagent';
    return [call, {
      type: 'agent-activity',
      key: `agent:${callId}`,
      kind: 'subagent',
      title,
      status: 'running',
      ...(timestamp(message.ts) === undefined ? {} : { startedAtMs: timestamp(message.ts) }),
      agentsDone: 0,
      agentsTotal: 1,
    }];
  }
  if (message.role === 'user' && kind === 'tool_result') {
    const callId = boundedString(block.tool_use_id) ?? `cline-tool-result:${message.id}:${index}`;
    const name = boundedString(block.name) ?? 'Cline tool';
    const displayClass = toolClass(name);
    const nativeIsError = block.is_error === true;
    const outcome = displayClass === 'execute'
      ? commandOutcome(block.content, nativeIsError)
      : undefined;
    const result: AgentMessage = {
      type: 'tool-result',
      callId,
      toolName: name,
      title: name,
      toolClass: displayClass,
      result: boundedPayload(block.content, 'tool result'),
      // A command Cline reports as failed IS an error, whether or not it also
      // set the flag. `is_error` alone said false for both outcomes.
      isError: nativeIsError || outcome?.state === 'failed',
      ...(outcome === undefined ? {} : {
        semantic: { kind: 'command', command: outcome.command, state: outcome.state },
      }),
    };
    if (name !== 'spawn_agent') return [result];
    return [result, {
      type: 'agent-activity',
      key: `agent:${callId}`,
      kind: 'subagent',
      title: 'Cline subagent',
      status: block.is_error === true ? 'error' : 'done',
      agentsDone: 1,
      agentsTotal: 1,
    }];
  }
  context.trace?.({
    op: message.role === 'user' || message.role === 'assistant' ? 'unknown-block' : 'unknown-role',
    detail: `message ${message.id} role=${message.role} block=${index} type=${String(block.type)}`,
  });
  return [unknownBlock(message, block, index)];
}

export function mapClineMessage(message: ClineNativeMessage, context: ClineMapContext): AgentMessage[] {
  try {
    const out = message.content.flatMap((block, index) => mapKnownBlock(message, block, index, context));
    if (message.role === 'assistant') {
      const usage = usageMessage(message);
      if (usage) out.push(usage);
    }
    return out;
  } catch (error) {
    context.trace?.({ op: 'mapping-error', detail: `message ${message.id}: ${error instanceof Error ? error.message : String(error)}` });
    return [contextEvent('Cline message (unmapped)', `message=${message.id} role=${message.role}`)];
  }
}

export function mapClineTranscript(
  sessionId: string,
  messages: readonly ClineNativeMessage[],
  trace?: (event: ClineMapTrace) => void,
): AgentMessage[] {
  const seen = new Set<string>();
  const out: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(...mapClineMessage(message, {
      sessionId,
      ...(trace ? { trace } : {}),
      settled: clineMessageSettled(message, index < messages.length - 1),
    }));
  }
  return out;
}

/**
 * A Cline assistant message is finished when the transcript says so: another
 * message follows it, or it already carries the `metrics` Cline writes when the
 * model call completes. A trailing assistant message with no metrics is the one
 * that may still be growing, and it is exactly the one that must not be marked
 * final.
 */
export function clineMessageSettled(
  message: ClineNativeMessage,
  hasLaterMessage: boolean,
): boolean {
  return hasLaterMessage || isRecord(message.metrics);
}

export function mapClineInterruptedTail(
  session: ClineStoredSession,
  messages: readonly ClineNativeMessage[],
): AgentMessage | undefined {
  if (!session.interrupted) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const blockIndex = message.content.findIndex((block) => block.type === 'text' && typeof block.text === 'string');
    if (blockIndex < 0) continue;
    const userKey = `${clineMessageKey(session.id, message.id)}:block:${blockIndex}:text`;
    return {
      type: 'run-summary',
      key: `${clineMessageKey(session.id, message.id)}:interrupted`,
      turnId: clineTurnId(session.id, message.id),
      userMessageKey: userKey,
      status: 'cancelled',
      source: 'cline',
    };
  }
  return undefined;
}

export function clineSessionUsage(usage: ClineUsage | undefined): AgentMessage | undefined {
  if (!usage) return undefined;
  return {
    type: 'metadata-update',
    key: 'sessionUsage',
    value: {
      ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadSubset: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteSubset: usage.cacheWriteTokens }),
      ...(usage.totalCost === undefined ? {} : { cost: usage.totalCost }),
      inputIncludesCacheSubsets: true,
    },
  };
}

export function clinePendingToolUse(
  messages: readonly ClineNativeMessage[],
): Extract<AgentMessage, { type: 'permission-request' }> | undefined {
  const resolved = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && boundedString(block.tool_use_id)) resolved.add(String(block.tool_use_id));
    }
  }
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== 'assistant') continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (!block || block.type !== 'tool_use') continue;
      const requestId = boundedString(block.id);
      if (!requestId || resolved.has(requestId)) continue;
      const toolName = boundedString(block.name) ?? 'Cline tool';
      const detail = boundedPayload(block.input, 'pending tool input');
      return {
        type: 'permission-request',
        requestId,
        title: `${toolName} is pending in Cline`,
        toolName,
        ...(detail === undefined ? {} : { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }),
        readOnly: true,
      };
    }
  }
  return undefined;
}
