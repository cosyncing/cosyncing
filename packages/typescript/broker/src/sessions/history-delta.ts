import { createHash } from 'node:crypto';
import type { AgentMessage } from '@cosyncing/protocol';

export type HistoryGapReason = 'invalid-cursor' | 'cursor-out-of-range' | 'cursor-prefix-mismatch';
export type HistoryGapCode = 'HISTORY_CURSOR_INVALID' | 'HISTORY_CURSOR_GONE' | 'HISTORY_CURSOR_DIVERGED';

interface CursorPayload {
  v: 1;
  n: number;
  h: string;
}

interface OlderCursorPayload {
  v: 1;
  k: 'older';
  /** Exclusive raw-history boundary. */
  b: number;
  /** Hash of the raw durable prefix through `b`. */
  h: string;
}

export interface HistoryDelta {
  messages: AgentMessage[];
  reset: boolean;
  cursor: string;
  gap?: {
    reason: HistoryGapReason;
    code: HistoryGapCode;
    message: string;
    since?: string;
  };
  /** Present when the frame was capped to the newest messages (see {@link capHistoryDelta}). */
  truncated?: { shown: number; total: number };
}

/** Messages that represent durable transcript history for cursor purposes. Derived/live-status
 *  overlays are replayed as catch-up frames so elapsed time/progress changes do not invalidate the
 *  transcript prefix and force a full long-session resend. */
export function isCursorDurableMessage(message: AgentMessage): boolean {
  return message.type !== 'agent-activity';
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function encodeOlderCursor(payload: OlderCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeOlderCursor(raw: string | undefined): { cursor: OlderCursorPayload | null; invalid: boolean } {
  if (!raw) return { cursor: null, invalid: true };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OlderCursorPayload>;
    if (
      parsed.v !== 1 || parsed.k !== 'older' || !Number.isInteger(parsed.b) ||
      typeof parsed.b !== 'number' || typeof parsed.h !== 'string'
    ) return { cursor: null, invalid: true };
    return { cursor: { v: 1, k: 'older', b: parsed.b, h: parsed.h }, invalid: false };
  } catch {
    return { cursor: null, invalid: true };
  }
}

function decodeCursor(raw: string | undefined): { cursor: CursorPayload | null; invalid: boolean } {
  if (!raw) return { cursor: null, invalid: false };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (parsed.v !== 1 || typeof parsed.n !== 'number' || typeof parsed.h !== 'string') return { cursor: null, invalid: true };
    return { cursor: { v: 1, n: parsed.n, h: parsed.h }, invalid: false };
  } catch {
    return { cursor: null, invalid: true };
  }
}

function stablePart(message: AgentMessage, index: number): string {
  switch (message.type) {
    case 'model-output':
    case 'thinking':
    case 'user-message':
      return [message.type, message.key ?? '', 'text' in message ? message.text ?? '' : ''].join('\0');
    case 'tool-call':
      return [message.type, message.callId, message.toolName, message.title ?? '', JSON.stringify(message.args ?? null)].join('\0');
    case 'tool-result':
      return [
        message.type,
        message.callId,
        message.toolName,
        message.title ?? '',
        message.path ?? '',
        message.isError ?? '',
        message.exitCode ?? '',
        message.truncated ?? '',
        message.additions ?? '',
        message.deletions ?? '',
        message.diff ?? '',
        // When the aggregate diff moved behind a reference the inline `diff` is stripped, so bind the
        // cursor to the body's stable CONTENT HASH — not the signed fetchUrl, which carries an
        // expiry and would otherwise churn the cursor (and hide oversized-diff changes; T1b finding 1).
        message.diffRef?.contentHash ?? '',
        JSON.stringify(message.result ?? null),
      ].join('\0');
    case 'file-artifact':
      return [message.type, message.artifactKey ?? '', message.contentHash ?? '', message.path, message.name, message.size ?? ''].join('\0');
    case 'permission-request':
    case 'permission-resolved':
    case 'question-request':
    case 'question-resolved':
      return [message.type, message.requestId].join('\0');
    case 'token-count':
      return [message.type, message.input ?? '', message.output ?? '', message.cost ?? ''].join('\0');
    case 'status':
      return [message.type, message.status, message.detail ?? ''].join('\0');
    case 'fs-edit':
      return [message.type, message.path, message.description ?? '', message.diff ?? ''].join('\0');
    case 'goal-state':
    case 'task-list-state':
    case 'agent-activity':
    case 'metadata-update':
    case 'event':
    case 'terminal-output':
    case 'history-reset':
    case 'error':
      return JSON.stringify(message);
    default:
      return JSON.stringify(message) || String(index);
  }
}

function prefixHash(messages: AgentMessage[], n: number): string {
  const h = createHash('sha256');
  for (let i = 0; i < Math.min(n, messages.length); i++) h.update(stablePart(messages[i]!, i)).update('\n');
  return h.digest('base64url');
}

/**
 * Build the exact opaque backward cursor for every raw durable-history
 * boundary in one pass.
 *
 * The broker's short-lived paging cache stores these compact cursor strings
 * beside encoded messages. It therefore validates and advances a cursor
 * without retaining the complete decoded transcript or re-hashing every
 * prefix for every page.
 */
export function backwardHistoryCursorIndex(messages: AgentMessage[]): string[] {
  const indexer = new BackwardHistoryCursorIndexer();
  const cursors = [indexer.openingCursor];
  for (const message of messages) cursors.push(indexer.push(message));
  return cursors;
}

/**
 * The same cursor derivation, one message at a time.
 *
 * The hash is a rolling prefix hash, so nothing about it requires the complete
 * transcript to exist first. This is what lets the paging cache be built while
 * an adapter is still reading its native source, under the cache's own budget,
 * instead of after a whole `AgentMessage[]` has been materialized.
 */
export class BackwardHistoryCursorIndexer {
  private readonly hash = createHash('sha256');
  private count = 0;

  /** Hash for the empty durable prefix. */
  readonly openingHash = createHash('sha256').digest('base64url');

  /** Cursor for the empty prefix. */
  readonly openingCursor = encodeOlderCursor({
    v: 1,
    k: 'older',
    b: 0,
    h: this.openingHash,
  });

  /** Fold one message in and return only the compact rolling hash. */
  pushHash(message: AgentMessage): string {
    this.hash.update(stablePart(message, this.count)).update('\n');
    this.count += 1;
    return this.hash.copy().digest('base64url');
  }

  /** Folds one message in and returns the cursor for the prefix ending at it. */
  push(message: AgentMessage): string {
    const digest = this.pushHash(message);
    return encodeOlderCursor({
      v: 1,
      k: 'older',
      b: this.count,
      h: digest,
    });
  }
}

/** Rebuild an opaque older cursor from trusted compact index metadata. */
export function backwardHistoryCursorFromHash(
  boundary: number,
  hash: string,
): string {
  return encodeOlderCursor({ v: 1, k: 'older', b: boundary, h: hash });
}

/** Parse an opaque older cursor for validation against a trusted hash index. */
export function backwardHistoryCursorParts(
  raw: string | undefined,
): { boundary: number; hash: string } | undefined {
  const decoded = decodeOlderCursor(raw);
  return decoded.invalid || !decoded.cursor
    ? undefined
    : { boundary: decoded.cursor.b, hash: decoded.cursor.h };
}

/** Decode only the boundary from an opaque older cursor. The caller must
 * compare the complete cursor against a trusted cursor index before using it. */
export function backwardHistoryCursorBoundary(raw: string | undefined): number | undefined {
  const decoded = decodeOlderCursor(raw);
  return decoded.invalid ? undefined : decoded.cursor?.b;
}

/** Projection/state frames are deliberately absent from backward pages. Their latest value is
 * already salvaged into the attach tail; replaying an older value later could resurrect cleared UI. */
export function isBackwardPageMessage(message: AgentMessage): boolean {
  return !['task-list-state', 'goal-state', 'metadata-update', 'agent-activity', 'history-reset'].includes(message.type);
}

export interface BackwardHistoryPage {
  messages: AgentMessage[];
  cursor?: string;
  hasMore: boolean;
  endOfHistory: boolean;
  gap?: {
    reason: HistoryGapReason;
    code: HistoryGapCode;
    message: string;
    cursor?: string;
  };
}

/** Issue a cursor for messages strictly before `before`. Cursors are versioned, opaque, and bound
 * to the exact retained prefix so tail appends remain valid while rewrites fail closed. */
export function backwardHistoryCursor(messages: AgentMessage[], before: number): string {
  const boundary = Math.max(0, Math.min(messages.length, Math.trunc(before)));
  return encodeOlderCursor({ v: 1, k: 'older', b: boundary, h: prefixHash(messages, boundary) });
}

/** Walk backward over the raw durable history until `limit` transcript messages are collected,
 * then return them in normal chronological order. */
export function backwardHistoryPage(
  messages: AgentMessage[],
  rawCursor: string | undefined,
  limit = 100,
): BackwardHistoryPage {
  const decoded = decodeOlderCursor(rawCursor);
  if (decoded.invalid || !decoded.cursor) {
    return {
      messages: [],
      hasMore: false,
      endOfHistory: false,
      gap: {
        reason: 'invalid-cursor',
        code: 'HISTORY_CURSOR_INVALID',
        message: 'backward history cursor is invalid',
        ...(rawCursor ? { cursor: rawCursor } : {}),
      },
    };
  }
  const cursor = decoded.cursor;
  if (cursor.b < 0 || cursor.b > messages.length) {
    return {
      messages: [],
      hasMore: false,
      endOfHistory: false,
      gap: {
        reason: 'cursor-out-of-range',
        code: 'HISTORY_CURSOR_GONE',
        message: 'backward history cursor is outside the retained session history',
        cursor: rawCursor,
      },
    };
  }
  if (prefixHash(messages, cursor.b) !== cursor.h) {
    return {
      messages: [],
      hasMore: false,
      endOfHistory: false,
      gap: {
        reason: 'cursor-prefix-mismatch',
        code: 'HISTORY_CURSOR_DIVERGED',
        message: 'backward history cursor no longer matches this session',
        cursor: rawCursor,
      },
    };
  }
  const pageLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 100));
  const reverse: AgentMessage[] = [];
  let boundary = cursor.b;
  while (boundary > 0 && reverse.length < pageLimit) {
    boundary -= 1;
    const message = messages[boundary]!;
    if (isBackwardPageMessage(message)) reverse.push(message);
  }
  const hasMore = boundary > 0;
  return {
    messages: reverse.reverse(),
    ...(hasMore ? { cursor: backwardHistoryCursor(messages, boundary) } : {}),
    hasMore,
    endOfHistory: !hasMore,
  };
}

/**
 * Bound the number of messages a single history frame carries (performance must-fix, 2026-07-03):
 * a 76 MB Claude transcript maps to ~16k messages / a ~23 MB frame, which the phone then has to
 * JSON.parse and DOM-render in one synchronous pass — the "opening a session crashes the tab" bug.
 * Keep only the NEWEST `max` messages. The cursor is left covering the FULL durable prefix, so the
 * next reattach is an incremental delta. A capped frame is always `reset:true`: when an incremental
 * delta overflows the cap, silently dropping its middle would corrupt the client's cached thread,
 * so the client is told to rebuild from the tail instead. `truncated` lets the UI say honestly
 * "showing the last N of M". `max` <= 0 (or non-finite) disables capping.
 */
/** Session-state message types whose LATEST instance must survive capping: they carry the current
 *  task panel / goal bar / statusline metadata, and (unlike chat bubbles) dropping an old one loses
 *  state the tail may never restate. */
const STATE_SALVAGE_TYPES = new Set<AgentMessage['type']>(['task-list-state', 'goal-state', 'metadata-update']);

export interface CappedHistoryMessages {
  messages: AgentMessage[];
  truncated?: { shown: number; total: number };
}

/** Cap a history snapshot while projecting its latest session-state frames after the transcript
 *  tail. The projection belongs at the end: active panels upsert either way, while terminal goal
 *  states (for example `paused`) render as notes and must be visible at the initial bottom scroll.
 *  `shown` counts transcript-tail messages, not the extra projected state frames. */
export function capHistoryMessages(messages: AgentMessage[], max: number, total = messages.length): CappedHistoryMessages {
  if (!Number.isFinite(max) || max <= 0 || messages.length <= max) return { messages };
  const tail = messages.slice(-max);
  const dropped = messages.slice(0, messages.length - max);
  // Salvage the newest state message per (type,key) from the dropped prefix — unless the tail already
  // carries one for the same panel, in which case the tail's is newer.
  const stateKey = (m: AgentMessage): string => `${m.type}\0${(m as { key?: string }).key ?? ''}`;
  const coveredByTail = new Set(tail.filter((m) => STATE_SALVAGE_TYPES.has(m.type)).map(stateKey));
  const salvage = new Map<string, AgentMessage>();
  for (const m of dropped) {
    if (!STATE_SALVAGE_TYPES.has(m.type)) continue;
    const k = stateKey(m);
    if (!coveredByTail.has(k)) salvage.set(k, m); // last-wins within the dropped prefix
  }
  return {
    messages: [...tail, ...salvage.values()],
    truncated: { shown: max, total },
  };
}

export function capHistoryDelta(delta: HistoryDelta, max: number, totalDurable: number): HistoryDelta {
  const capped = capHistoryMessages(delta.messages, max, totalDurable);
  if (!capped.truncated) return delta;
  return {
    messages: capped.messages,
    reset: true,
    cursor: delta.cursor,
    ...(delta.gap ? { gap: delta.gap } : {}),
    truncated: capped.truncated,
  };
}

export function historyDelta(messages: AgentMessage[], since?: string): HistoryDelta {
  const decoded = decodeCursor(since);
  const cursor = decoded.cursor;
  const fullHash = prefixHash(messages, messages.length);
  const nextCursor = encodeCursor({ v: 1, n: messages.length, h: fullHash });
  if (decoded.invalid) {
    return {
      messages,
      reset: true,
      cursor: nextCursor,
      gap: {
        reason: 'invalid-cursor',
        code: 'HISTORY_CURSOR_INVALID',
        message: 'history cursor is invalid; full replay was sent',
        since,
      },
    };
  }
  if (!cursor) return { messages, reset: true, cursor: nextCursor };
  if (!Number.isInteger(cursor.n) || cursor.n < 0 || cursor.n > messages.length) {
    return {
      messages,
      reset: true,
      cursor: nextCursor,
      gap: {
        reason: 'cursor-out-of-range',
        code: 'HISTORY_CURSOR_GONE',
        message: 'history cursor is outside the retained session history; full replay was sent',
        since,
      },
    };
  }
  if (prefixHash(messages, cursor.n) !== cursor.h) {
    return {
      messages,
      reset: true,
      cursor: nextCursor,
      gap: {
        reason: 'cursor-prefix-mismatch',
        code: 'HISTORY_CURSOR_DIVERGED',
        message: 'history cursor no longer matches this session; full replay was sent',
        since,
      },
    };
  }
  return { messages: messages.slice(cursor.n), reset: false, cursor: nextCursor };
}

/** Rebuild the revision-1 forward cursor from trusted compact prefix metadata. */
export function historyCursorFromHash(boundary: number, hash: string): string {
  return encodeCursor({ v: 1, n: boundary, h: hash });
}

/**
 * Parse a revision-1 forward cursor for validation against a compact index.
 *
 * `undefined` means no cursor was supplied. `null` means one was supplied but
 * was malformed.
 */
export function historyCursorParts(
  raw: string | undefined,
): { boundary: number; hash: string } | null | undefined {
  const decoded = decodeCursor(raw);
  if (decoded.invalid) return null;
  if (!decoded.cursor) return undefined;
  return { boundary: decoded.cursor.n, hash: decoded.cursor.h };
}
