/** Total mapping for the Grok Build 1.0.13 updates.jsonl surface. */
import {
  CONTEXT_INJECTION_EVENT,
  boundContextBody,
  type AgentMessage,
  type ToolDisplayClass,
} from '@cosyncing/adapter-api';

export interface GrokUpdateRecord {
  timestamp?: unknown;
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

export interface GrokUpdateEntry {
  record: GrokUpdateRecord;
  lineIndex: number;
  offset: number;
  length: number;
}

export interface GrokMapTrace {
  op: 'unknown-session-update' | 'malformed-update' | 'mapping-error';
  detail: string;
}

export interface GrokMapContext {
  sessionId: string;
  lineIndex: number;
  trace?: (event: GrokMapTrace) => void;
  /** The turn's prompt id, when the record cannot name it itself. A measured `user_message_chunk`
   *  carries no prompt id in any carrier — `params._meta` holds only `{agentTimestampMs, eventId}`
   *  and its own `update._meta` only `{modelId, promptIndex}` — so the row that OPENS a turn is the
   *  one row that cannot identify it. A whole-transcript pass supplies it from the turn's later
   *  records, which do carry it. */
  turnPromptId?: string;
  /** Key of the user row that opened this turn. Grok's `turn_completed` names no message, so a
   *  summary can only be bound to its prompt through the turn id -- and a client that indexes turns
   *  by the prompt row (session_conversation_turns.dart) drops a summary it cannot bind, taking
   *  Grok's only carrier of per-turn token usage with it. Publishing the key gives the same binding
   *  every peer adapter already provides. */
  turnUserMessageKey?: string;
}

const MAX_EVENT_ID_CHARS = 512;
const MAX_TOOL_FIELD_CHARS = 512;
const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;
const MAX_NOTICE_CHARS = 4_000;
const MAX_TASKS = 256;

export function isGrokSessionUpdateMethod(method: unknown): boolean {
  return method === 'session/update'
    || method === '_x.ai/session/update'
    || method === 'x.ai/session/update';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars = MAX_TOOL_FIELD_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.text === 'string') return value.text;
  if (!Array.isArray(value)) return undefined;
  const chunks = value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    return isRecord(item) && typeof item.text === 'string' ? [item.text] : [];
  });
  return chunks.length > 0 ? chunks.join('') : undefined;
}

function boundedPayload(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return undefined;
    return Buffer.byteLength(encoded, 'utf8') <= MAX_TOOL_PAYLOAD_BYTES
      ? value
      : `[Grok ${label} exceeded ${MAX_TOOL_PAYLOAD_BYTES} bytes; omitted]`;
  } catch {
    return `[Grok ${label} was not serializable; omitted]`;
  }
}

/** Epoch milliseconds, whichever unit Grok used.
 *
 *  The string branch already yields milliseconds (`Date.parse`), and
 *  `_meta.agentTimestampMs` says its unit in its name. Grok's own `timestamp`
 *  field does not: it is epoch SECONDS, and returning it unchanged from a
 *  function called `timestampMs` put a seconds value into `completedAt`, which
 *  the contract and the client both read as milliseconds. Measured on installed
 *  v69: grok published `completedAt: 1788558552` where kilo published
 *  `1788558255719` for the same minute, and the transcript footer read
 *  "Finished at Jan 21, 1970 5:49 PM" -- before AND after a reload, because the
 *  wrong unit was stored, not merely rendered.
 *
 *  The threshold separates the two units for any plausible date: epoch seconds
 *  do not reach 1e11 until the year 5138. This mirrors `_toEpochMs` in the Dart
 *  contract model, which exists for the same reason on the Tokdash payload. */
function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 1e11 ? value * 1_000 : value;
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function paramsOf(record: GrokUpdateRecord): Record<string, unknown> | undefined {
  return isRecord(record.params) ? record.params : undefined;
}

function updateOf(record: GrokUpdateRecord): Record<string, unknown> | undefined {
  const params = paramsOf(record);
  return params && isRecord(params.update) ? params.update : undefined;
}

export function grokEventId(record: GrokUpdateRecord): string | undefined {
  const meta = paramsOf(record)?._meta;
  if (!isRecord(meta)) return undefined;
  const raw = meta.eventId;
  if ((typeof raw === 'string' || typeof raw === 'number')
    && String(raw).length > 0
    && String(raw).length <= MAX_EVENT_ID_CHARS) return String(raw);
  return undefined;
}

export function grokPromptId(record: GrokUpdateRecord): string | undefined {
  const params = paramsOf(record);
  const meta = params?._meta;
  const update = updateOf(record);
  // Both carriers are real and independent: streamed rows put the id in `_meta.promptId`, while
  // `turn_completed` carries `_meta` WITHOUT a promptId and names the turn in `update.prompt_id`.
  // Selecting the carrier by whether `_meta` exists lost the id for exactly that record, so a run
  // summary — and the native per-turn token usage it carries — got a `turn-line:N` id that no
  // answer or prompt in the same turn shares, and could never be correlated to its turn.
  const raw = (isRecord(meta) ? meta.promptId : undefined) ?? update?.prompt_id;
  return (typeof raw === 'string' || typeof raw === 'number')
    && String(raw).length > 0
    && String(raw).length <= MAX_EVENT_ID_CHARS
    ? String(raw)
    : undefined;
}

export function grokMessageKey(sessionId: string, record: GrokUpdateRecord, lineIndex: number): string {
  const eventId = grokEventId(record);
  return eventId
    ? `grok:${sessionId}:event:${eventId}`
    : `grok:${sessionId}:line:${lineIndex}`;
}

export function grokTurnId(
  sessionId: string,
  record: GrokUpdateRecord,
  lineIndex: number,
  turnPromptId?: string,
): string {
  const promptId = grokPromptId(record) ?? turnPromptId;
  return promptId
    ? `grok:${sessionId}:turn:${promptId}`
    : `grok:${sessionId}:turn-line:${lineIndex}`;
}

function contextEvent(source: string, body: string): AgentMessage {
  const bounded = boundContextBody(body || '(empty update)');
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

function toolMeta(update: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(update._meta) && isRecord(update._meta['x.ai/tool'])
    ? update._meta['x.ai/tool']
    : undefined;
}

function toolClassOf(meta: Record<string, unknown> | undefined): ToolDisplayClass {
  if (meta?.read_only === true) return 'lookup';
  const kind = `${typeof meta?.kind === 'string' ? meta.kind : ''} ${typeof meta?.name === 'string' ? meta.name : ''}`.toLowerCase();
  if (/edit|write|patch|delete|move|rename/u.test(kind)) return 'edit';
  if (/exec|command|shell|terminal|bash/u.test(kind)) return 'execute';
  if (/read|search|find|glob|web|fetch|lookup/u.test(kind)) return 'lookup';
  return 'other';
}

function toolIdentity(update: Record<string, unknown>, fallback: string): {
  callId: string;
  toolName: string;
  title: string;
  toolClass: ToolDisplayClass;
} {
  const meta = toolMeta(update);
  const callId = boundedString(update.toolCallId) ?? fallback;
  const toolName = boundedString(meta?.label)
    ?? boundedString(meta?.name)
    ?? boundedString(update.title)
    ?? 'Grok tool';
  const title = boundedString(update.title) ?? toolName;
  return { callId, toolName, title, toolClass: toolClassOf(meta) };
}

function numericToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function streamSegmentKey(record: GrokUpdateRecord, fallback: string): string {
  const meta = paramsOf(record)?._meta;
  if (isRecord(meta)) {
    const raw = meta.streamStartMs ?? meta.modelCallId ?? meta.messageId;
    if ((typeof raw === 'string' || typeof raw === 'number')
      && String(raw).length > 0
      && String(raw).length <= MAX_EVENT_ID_CHARS) return String(raw);
  }
  // Event identity is safer than collapsing non-contiguous output when an
  // unmeasured producer omits the measured per-model-call streamStartMs.
  return grokEventId(record) ?? fallback;
}

function completedTurn(
  record: GrokUpdateRecord,
  update: Record<string, unknown>,
  key: string,
  turnId: string,
  userMessageKey?: string,
): AgentMessage {
  const stopReason = typeof update.stop_reason === 'string' ? update.stop_reason.toLowerCase() : '';
  // `rate_limit` is a real Grok terminal reason, not a completion: the installed
  // v79 transcript records `retry_state` exhausted on a 429 followed by
  // `turn_completed` with `stop_reason: "rate_limit"` and no usage and no answer.
  // Falling through to `done` renders a turn that produced nothing as one that
  // finished normally.
  const status = /cancel|interrupt|abort/u.test(stopReason)
    ? 'cancelled' as const
    : /error|fail|rate[_-]?limit|quota|exhaust/u.test(stopReason)
      ? 'error' as const
      : 'done' as const;
  const usage = isRecord(update.usage) ? update.usage : undefined;
  const input = numericToken(usage?.input_tokens ?? usage?.inputTokens);
  const output = numericToken(usage?.output_tokens ?? usage?.outputTokens);
  const cacheRead = numericToken(usage?.cached_read_tokens ?? usage?.cachedReadTokens ?? usage?.cacheRead);
  return {
    type: 'run-summary',
    key: `${key}:summary`,
    turnId,
    ...(userMessageKey ? { userMessageKey } : {}),
    status,
    ...(timestampMs(record.timestamp) === undefined ? {} : { completedAt: timestampMs(record.timestamp) }),
    ...(input === undefined && output === undefined ? {} : {
      tokens: {
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(cacheRead === undefined ? {} : { cacheRead }),
      },
    }),
    source: 'grok',
  };
}

function taskMessages(update: Record<string, unknown>, key: string): AgentMessage[] {
  if (update.sessionUpdate === 'task_backgrounded') {
    const taskId = boundedString(update.task_id) ?? boundedString(update.tool_call_id) ?? key;
    const title = boundedString(update.description, 2_048)
      ?? boundedString(update.command, 2_048)
      ?? 'Background task';
    return [{ type: 'agent-activity', key: `agent:${taskId}`, kind: 'subagent', title, status: 'running' }];
  }
  const snapshot = update.task_snapshot;
  if (Array.isArray(snapshot) && snapshot.length <= MAX_TASKS) {
    const items = snapshot.flatMap((raw, index) => {
      if (!isRecord(raw)) return [];
      const title = boundedString(raw.title ?? raw.description, 4_000);
      if (!title) return [];
      const nativeStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
      const status = /done|complete|success/u.test(nativeStatus) ? 'done' as const
        : /cancel/u.test(nativeStatus) ? 'cancelled' as const
          : /progress|running|active/u.test(nativeStatus) ? 'in-progress' as const
            : 'open' as const;
      return [{ id: boundedString(raw.id) ?? String(index), title, status }];
    });
    const terminalActivities: AgentMessage[] = items.flatMap((item) => {
      if (item.status !== 'done' && item.status !== 'cancelled') return [];
      return [{
        type: 'agent-activity',
        key: `agent:${item.id}`,
        kind: 'subagent',
        title: item.title,
        status: item.status === 'done' ? 'done' : 'error',
        agentsDone: item.status === 'done' ? 1 : 0,
        agentsTotal: 1,
      }];
    });
    return [...terminalActivities, {
      type: 'task-list-state',
      key: 'grok:tasks',
      title: 'Tasks',
      status: update.will_wake === true ? 'running' : 'done',
      source: 'native',
      items,
    }];
  }
  return [contextEvent('Grok task completion', `willWake=${String(update.will_wake)}`)];
}

function subagentMessages(
  update: Record<string, unknown>,
  sessionId: string,
): AgentMessage[] | undefined {
  if (update.sessionUpdate !== 'subagent_spawned' && update.sessionUpdate !== 'subagent_finished') {
    return undefined;
  }
  const childId = boundedString(update.child_session_id ?? update.subagent_id, MAX_EVENT_ID_CHARS);
  const subagentId = boundedString(update.subagent_id, MAX_EVENT_ID_CHARS);
  const parentId = boundedString(update.parent_session_id, MAX_EVENT_ID_CHARS);
  if (!childId || (subagentId && subagentId !== childId) || (parentId && parentId !== sessionId)) {
    return [contextEvent('Grok malformed subagent update', `sessionUpdate=${String(update.sessionUpdate)}`)];
  }
  const title = `Grok subagent ${childId}`;
  if (update.sessionUpdate === 'subagent_spawned') {
    return [{
      type: 'agent-activity',
      key: `agent:${childId}`,
      kind: 'subagent',
      title,
      status: 'running',
      agentsDone: 0,
      agentsTotal: 1,
    }];
  }
  const nativeStatus = typeof update.status === 'string' ? update.status.toLowerCase() : '';
  const done = /complete|success|done/u.test(nativeStatus);
  return [{
    type: 'agent-activity',
    key: `agent:${childId}`,
    kind: 'subagent',
    title,
    status: done ? 'done' : 'error',
    agentsDone: done ? 1 : 0,
    agentsTotal: 1,
  }];
}

/** Map one on-disk or live ACP-shaped update without throwing. */
export function mapGrokUpdate(record: GrokUpdateRecord, context: GrokMapContext): AgentMessage[] {
  try {
    if (!isGrokSessionUpdateMethod(record.method)) {
      context.trace?.({
        op: 'unknown-session-update',
        detail: `line ${context.lineIndex}: unsupported method=${String(record.method)}`,
      });
      return [contextEvent('Grok update (unsupported method)', `method=${String(record.method)}`)];
    }
    const params = paramsOf(record);
    const update = updateOf(record);
    if (!params || !update || typeof update.sessionUpdate !== 'string') {
      context.trace?.({ op: 'malformed-update', detail: `line ${context.lineIndex}: missing params.update.sessionUpdate` });
      return [contextEvent('Grok malformed update', `keys: ${Object.keys(record).sort().join(', ')}`)];
    }
    if (params.sessionId !== undefined && params.sessionId !== context.sessionId) {
      context.trace?.({ op: 'malformed-update', detail: `line ${context.lineIndex}: foreign session id` });
      return [contextEvent('Grok foreign-session update', `sessionUpdate=${update.sessionUpdate}`)];
    }
    const key = grokMessageKey(context.sessionId, record, context.lineIndex);
    const turnId = grokTurnId(context.sessionId, record, context.lineIndex, context.turnPromptId);
    const streamKey = streamSegmentKey(record, String(context.lineIndex));
    const text = contentText(update.content);

    if (update.sessionUpdate === 'user_message_chunk' && text !== undefined) {
      const sentAt = timestampMs(record.timestamp) ?? timestampMs(isRecord(params._meta) ? params._meta.agentTimestampMs : undefined);
      return [{ type: 'user-message', text, key, turnId, ...(sentAt === undefined ? {} : { sentAt }) }];
    }
    if (update.sessionUpdate === 'agent_message_chunk' && text !== undefined) {
      return [{ type: 'model-output', delta: text, key: `${turnId}:answer:${streamKey}` }];
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && text !== undefined) {
      return [{ type: 'thinking', delta: text, key: `${turnId}:thinking:${streamKey}` }];
    }
    if (update.sessionUpdate === 'tool_call') {
      const identity = toolIdentity(update, `grok-tool:${context.sessionId}:${context.lineIndex}`);
      return [{ type: 'tool-call', ...identity, args: boundedPayload(update.rawInput, 'tool input') }];
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const identity = toolIdentity(update, `grok-tool:${context.sessionId}:${context.lineIndex}`);
      const status = typeof update.status === 'string' ? update.status.toLowerCase() : '';
      if (!/complete|success|fail|error|cancel|interrupt/u.test(status)) {
        return [{ type: 'tool-call', ...identity, args: boundedPayload(update.rawInput, 'tool input') }];
      }
      return [{
        type: 'tool-result',
        ...identity,
        result: boundedPayload(update.rawOutput ?? update.content ?? update.status, 'tool output'),
        isError: /fail|error|cancel|interrupt/u.test(status),
      }];
    }
    if (update.sessionUpdate === 'session_info_update') {
      const title = boundedString(update.title, 4_096);
      if (!title) {
        context.trace?.({ op: 'malformed-update', detail: `line ${context.lineIndex}: invalid session_info_update title` });
        return [contextEvent('Grok malformed session info update', `keys: ${Object.keys(update).sort().join(',')}`)];
      }
      return [{ type: 'metadata-update', key: 'sessionInfo', value: { title } }];
    }
    if (update.sessionUpdate === 'turn_completed') {
      return [completedTurn(record, update, key, turnId, context.turnUserMessageKey)];
    }
    if (update.sessionUpdate === 'retry_state') {
      const reason = boundedString(update.reason, MAX_NOTICE_CHARS) ?? 'Grok is retrying the turn.';
      const attempt = numericToken(update.attempt ?? update.attempts);
      return [{ type: 'notice', message: attempt === undefined ? reason : `${reason} (attempt ${attempt})` }];
    }
    const subagents = subagentMessages(update, context.sessionId);
    if (subagents) return subagents;
    if (update.sessionUpdate === 'task_backgrounded' || update.sessionUpdate === 'task_completed') {
      return taskMessages(update, key);
    }

    context.trace?.({
      op: 'unknown-session-update',
      detail: `line ${context.lineIndex}: method=${String(record.method)} sessionUpdate=${update.sessionUpdate}`,
    });
    return [contextEvent('Grok update (unmapped)', `method=${String(record.method)} sessionUpdate=${update.sessionUpdate}`)];
  } catch (error) {
    context.trace?.({
      op: 'mapping-error',
      detail: `line ${context.lineIndex}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [contextEvent('Grok update (mapping failure)', `keys: ${Object.keys(record).sort().join(', ')}`)];
  }
}

/** Bind each prompt row to the id its own turn uses. Walk forward to the first later record that
 *  names a prompt; stop at the next prompt row, so a turn that never completed keeps its line
 *  fallback instead of borrowing the following turn's identity. */
export function turnPromptIds(entries: readonly GrokUpdateEntry[]): Map<number, string> {
  const resolved = new Map<number, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (updateOf(entry.record)?.sessionUpdate !== 'user_message_chunk') continue;
    if (grokPromptId(entry.record) !== undefined) continue;
    for (let ahead = index + 1; ahead < entries.length; ahead += 1) {
      const next = entries[ahead];
      if (!next) continue;
      if (updateOf(next.record)?.sessionUpdate === 'user_message_chunk') break;
      const promptId = grokPromptId(next.record);
      if (promptId !== undefined) {
        resolved.set(entry.lineIndex, promptId);
        break;
      }
    }
  }
  return resolved;
}

export function mapGrokTranscript(
  sessionId: string,
  entries: readonly GrokUpdateEntry[],
  trace?: (event: GrokMapTrace) => void,
): AgentMessage[] {
  const resolved = turnPromptIds(entries);
  // promptId -> the key of the row that opened that turn. Keyed by prompt id, never by "most
  // recent user row": a row that names no prompt -- an id-less native terminal, for one -- must not
  // be allowed to claim a newer turn's prompt. `test-grok-drive` guards exactly that.
  const promptUserKeys = new Map<string, string>();
  for (const entry of entries) {
    if (updateOf(entry.record)?.sessionUpdate !== 'user_message_chunk') continue;
    const promptId = grokPromptId(entry.record) ?? resolved.get(entry.lineIndex);
    if (promptId === undefined || promptUserKeys.has(promptId)) continue;
    promptUserKeys.set(promptId, grokMessageKey(sessionId, entry.record, entry.lineIndex));
  }
  return settleStreamedText(entries.flatMap((entry) => {
    const turnPromptId = resolved.get(entry.lineIndex);
    const ownPromptId = grokPromptId(entry.record);
    const turnUserMessageKey = ownPromptId === undefined
      ? undefined
      : promptUserKeys.get(ownPromptId);
    return mapGrokUpdate(entry.record, {
      sessionId,
      lineIndex: entry.lineIndex,
      trace,
      ...(turnPromptId === undefined ? {} : { turnPromptId }),
      ...(turnUserMessageKey === undefined ? {} : { turnUserMessageKey }),
    });
  }));
}

/**
 * Replay is COMPLETE text, not a stream. Fold each key's `model-output` and
 * `thinking` deltas into one `text` row so replaying them is idempotent.
 *
 * `mapGrokUpdate` emits `delta` because it also serves the live path, where
 * append is exactly right. Replay is the opposite case: `delta` means "add
 * this to whatever that key already holds", so a reader that streamed the turn
 * and is then handed the durable history ADDS the answer to itself.
 *
 * Measured on the installed v107 browser leg, three sessions, one marker each:
 *
 *   grok chat_history.jsonl / updates.jsonl   1 copy of the answer
 *   mapGrokTranscript over updates.jsonl      1 `model-output`
 *   a FRESH observer over the wire            1 row, 63 chars
 *   the browser that streamed the turn        2 copies (v106), 3 (v105, v107)
 *
 * and the field is what separates grok from every other lane. Attaching in
 * `observe` to one v107 session per harness and reading the replayed rows:
 * reasonix `text`, cline `text`, kilo `text`, omp `text`, grok `delta`. Grok
 * was the only one that accumulated, and it accumulated on screen — a prompt
 * that said "Reply with exactly X" rendered X three times.
 *
 * Order is preserved by settling each key at its FIRST position: a later delta
 * must not move the answer below rows that were already after it.
 *
 * `final` is asserted only when this replay itself proves the stream closed --
 * a `run-summary` (Grok's `turn_completed`) landing after the stream's last
 * chunk. A history read taken MID-turn otherwise hands the client partial text
 * flagged complete, and `_withCarriedFinality` makes that flag permanent: the
 * turn would never again be read aloud in full or copied in full. Positional
 * rather than by turn id because the answer key embeds the turn id but the row
 * does not carry it, and a summary at a later index closes the stream either
 * way -- it is that turn's own terminal, or a newer turn has already begun.
 */
function settleStreamedText(messages: readonly AgentMessage[]): AgentMessage[] {
  const streamed = new Map<string, {
    type: 'model-output' | 'thinking';
    index: number;
    lastIndex: number;
    text: string;
  }>();
  const settled: (AgentMessage | undefined)[] = [];
  let lastTerminalIndex = -1;
  for (const message of messages) {
    if (message.type === 'run-summary') lastTerminalIndex = settled.length;
    if ((message.type !== 'model-output' && message.type !== 'thinking')
      || message.delta === undefined
      || message.key === undefined) {
      settled.push(message);
      continue;
    }
    // Type-qualified, because one native event can carry both an answer and a
    // thought and they are separate rows. The type is a PREFIX rather than a
    // separator so no key content can be mistaken for it.
    const slot = `${message.type}:${message.key}`;
    const open = streamed.get(slot);
    if (open === undefined) {
      streamed.set(slot, {
        type: message.type,
        index: settled.length,
        lastIndex: settled.length,
        text: message.delta,
      });
      settled.push(message);
      continue;
    }
    open.text += message.delta;
    open.lastIndex = settled.length;
    // Its text lives in the row already placed for this key; leave a hole
    // rather than shifting every later index that hole would invalidate.
    settled.push(undefined);
  }
  for (const open of streamed.values()) {
    const { type } = open;
    const first = settled[open.index];
    if (first === undefined || first.type !== type) continue;
    const { delta: _delta, ...rest } = first;
    settled[open.index] = type === 'model-output'
      ? { ...rest, type, text: open.text, ...(lastTerminalIndex > open.lastIndex ? { final: true } : {}) }
      : { ...rest, type, text: open.text };
  }
  return settled.filter((message): message is AgentMessage => message !== undefined);
}

/** A durable prompt with no later terminal turn boundary is interrupted, not live. */
export function mapGrokInterruptedTail(
  sessionId: string,
  entries: readonly GrokUpdateEntry[],
): AgentMessage | undefined {
  let lastUser: GrokUpdateEntry | undefined;
  for (const entry of entries) {
    if (!isGrokSessionUpdateMethod(entry.record.method)) continue;
    const update = updateOf(entry.record);
    if (update?.sessionUpdate === 'user_message_chunk') lastUser = entry;
    if (update?.sessionUpdate === 'turn_completed') lastUser = undefined;
  }
  if (!lastUser) return undefined;
  const key = grokMessageKey(sessionId, lastUser.record, lastUser.lineIndex);
  return {
    type: 'run-summary',
    key: `${key}:summary`,
    turnId: grokTurnId(sessionId, lastUser.record, lastUser.lineIndex),
    userMessageKey: key,
    status: 'cancelled',
    source: 'grok',
  };
}

export function grokContextUsage(signals: Record<string, unknown> | undefined): AgentMessage | undefined {
  const used = numericToken(signals?.contextTokensUsed);
  const max = numericToken(signals?.contextWindowTokens);
  if (used === undefined || max === undefined || max <= 0) return undefined;
  return { type: 'metadata-update', key: 'contextUsage', value: { used, max } };
}
