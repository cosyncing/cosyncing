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
  /**
   * Backward-page cursor for the boundary immediately after this frame's newest durable message.
   * It names the same boundary as {@link cursor}, in the encoding the paging route accepts, so a
   * client can release the frame's rows and page them back from exactly where the frame ended.
   */
  endCursor: string;
  gap?: {
    reason: HistoryGapReason;
    code: HistoryGapCode;
    message: string;
    since?: string;
  };
  /** Present when the frame was capped to the newest messages (see {@link capHistoryDelta}). */
  truncated?: { shown: number; total: number };
  /** Absolute raw durable boundary before the shown tail; present exactly when {@link truncated} is. */
  olderBoundary?: number;
  /**
   * Backward-page cursor at {@link olderBoundary}. Present on a capped frame whenever the caller
   * supplied the durable history (see {@link capHistoryDelta}).
   */
  olderCursor?: string;
}

/**
 * History frame budget shared with the first-party client (lane H1d).
 *
 * The client keeps ONE bounded decoded window of 500 messages and 4 MiB (see
 * `kMaxActiveTranscriptDecodedBytes`). A frame that fills the whole window leaves no room for the
 * next live message, so every live row would force the frame out again. Half the window is the
 * frame's share: an attach, resync or reconnect frame never carries more than this many decoded
 * bytes, measured with the client's own estimator on the rows as the connection receives them
 * (after artifact-reference egress), so the client never has to trim a frame it has no boundary
 * inside.
 *
 * Two frames are outside this bound. A backward page is bounded by count only; the client asks
 * again for fewer rows when one does not fit. The bounded-tail fallback, sent when no page index
 * can be built, keeps its own `HISTORY_TAIL_REPLAY_MAX_BYTES` (4 MiB) and carries no `endCursor`,
 * so rows the client drops from it need a reconnect, as they did before this bound existed.
 */
export const HISTORY_FRAME_MAX_DECODED_BYTES = 2 * 1024 * 1024;

/**
 * Slots one bounded frame may spend on latest-wins state enrichment (plan, goal, metadata rows
 * that fell out of the shown tail). Shared by the compact indexed attach and the generic
 * attach/resync cap so both deliver the same final shape: enrichment is paid for INSIDE the count
 * bound, never appended on top of it.
 */
export const HISTORY_FRAME_MAX_PROJECTIONS = 24;

/**
 * The first-party client's decoded-size estimate for one received JSON value.
 *
 * An exact mirror of `_estimatedDecodedValueBytes` in the Flutter client: UTF-16 string storage
 * plus fixed collection/object overhead. JavaScript `string.length` counts UTF-16 code units, the
 * same unit Dart counts, so the mirror is exact rather than approximate. Measuring with the
 * client's metric is the point: no serialized-byte bound can guarantee that a frame fits a window
 * the client measures differently, because the ratio between the two is unbounded.
 */
export function estimatedClientDecodedBytes(value: unknown): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'boolean' || typeof value === 'number') return 16;
  if (typeof value === 'string') return 24 + value.length * 2;
  if (Array.isArray(value)) {
    let bytes = 32 + value.length * 8;
    for (const item of value) bytes += estimatedClientDecodedBytes(item === undefined ? null : item);
    return bytes;
  }
  if (typeof value === 'object') {
    // Properties JSON.stringify drops never reach the client.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && typeof entry !== 'function');
    let bytes = 64 + entries.length * 24;
    for (const [key, entry] of entries) {
      bytes += estimatedClientDecodedBytes(key) + estimatedClientDecodedBytes(entry);
    }
    return bytes;
  }
  return 32 + String(value).length * 2;
}

/** Messages that represent durable transcript history for cursor purposes. Derived/live-status
 *  overlays are replayed as catch-up frames so elapsed time/progress changes do not invalidate the
 *  transcript prefix and force a full long-session resend. */
export function isCursorDurableMessage(message: AgentMessage): boolean {
  return message.type !== 'agent-activity'
    && !(message.type === 'event' && message.name === 'codex.background-running-snapshot');
}

/**
 * Whether a durable row describes the session's CURRENT pending or running state rather than
 * transcript: a prompt still queued, a request awaiting an answer, a run that has not finished, a
 * token reading or a session metadata value.
 *
 * Adapters append such rows after the transcript they read and restate, move or drop them on the
 * next read: OpenCode's running run summary, its token reading, the recomputed runtime totals and
 * the pending question and permission cards; the undelivered prompts of Claude and the ACP drives;
 * the interrupted or cancelled run summary grok, Reasonix and Cline project for a turn still
 * being written, and their context and usage readings. While they END a history they are
 * therefore kept out of its cursor space (see {@link cursorDurableHistory}); once a transcript row
 * follows them they are ordinary history.
 *
 * A run summary is not written once, even after a transcript row follows it. OpenCode writes one
 * summary per step of a turn and keeps every one `running` until the whole turn goes idle, when it
 * rewrites each in place as `done` with its completion time and runtimes; later telemetry can
 * enrich a finished summary again. A summary therefore takes part in cursors by its identity
 * alone (see {@link stablePart}): rewriting its status, timing or tokens in place moves no cursor,
 * while adding, removing or moving one still does.
 */
export function isVolatileTailMessage(message: AgentMessage): boolean {
  switch (message.type) {
    case 'user-message':
      return message.queued === true;
    case 'run-summary':
      return message.status !== undefined && message.status !== 'done';
    case 'permission-request':
    case 'question-request':
    case 'token-count':
    case 'metadata-update':
      return true;
    default:
      return false;
  }
}

/**
 * Most trailing volatile rows one history keeps out of its cursor space. A longer run is treated as
 * transcript, oldest first, so a streaming reader holds a bounded look-behind.
 */
export const MAX_VOLATILE_TAIL_ROWS = 64;

/**
 * The trailing run of volatile durable rows (see {@link isVolatileTailMessage}), held while it is
 * still the end of a history. Streaming and whole-array readers share it, so both draw the same
 * cursor space from the same rows.
 */
export class VolatileHistoryTail<T> {
  private held: T[] = [];

  /**
   * Admit one cursor-durable row. Returns the rows that are cursor-durable NOW, in history order:
   * nothing while [entry] is volatile (unless the run outgrew {@link MAX_VOLATILE_TAIL_ROWS}, which
   * releases its oldest row), or the held run followed by [entry] when a transcript row ends it.
   */
  push(entry: T, volatile: boolean): T[] {
    if (volatile) {
      this.held.push(entry);
      return this.held.length > MAX_VOLATILE_TAIL_ROWS ? [this.held.shift()!] : [];
    }
    const released = this.held;
    this.held = [];
    released.push(entry);
    return released;
  }

  /** The rows still held: the history's volatile tail, oldest first. Reading it changes nothing. */
  get tail(): readonly T[] {
    return this.held;
  }
}

/**
 * Split one read of a history into its cursor-durable rows and the rows delivered after a frame
 * instead: the non-durable overlays, and the trailing run of volatile rows. Every cursor, frame,
 * page and page-cache index is built over `durable`, so a history that only appended keeps every
 * cursor it issued even though its adapter re-projected the pending and running rows at its end.
 * `derived` keeps history order.
 */
export function cursorDurableHistory(
  history: readonly AgentMessage[],
): { durable: AgentMessage[]; derived: AgentMessage[] } {
  const tail = new VolatileHistoryTail<AgentMessage>();
  const durable: AgentMessage[] = [];
  for (const message of history) {
    if (!isCursorDurableMessage(message)) continue;
    for (const released of tail.push(message, isVolatileTailMessage(message))) durable.push(released);
  }
  const held = new Set(tail.tail);
  const derived = history.filter((message) => !isCursorDurableMessage(message) || held.has(message));
  return { durable: withToolSlotCursors(durable), derived };
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

/**
 * What one durable row contributes to the prefix hash every cursor carries: the fields whose change
 * means the row is no longer the one a cursor was issued over. A run summary contributes only its
 * identity (see {@link isVolatileTailMessage}).
 */
function stablePart(message: AgentMessage, index: number): string {
  switch (message.type) {
    case 'model-output':
    case 'thinking':
    case 'user-message':
      return [message.type, message.key ?? '', 'text' in message ? message.text ?? '' : ''].join('\0');
    case 'tool-call':
      if (message.historySlot) return [message.type, message.callId, message.toolName].join('\0');
      return [message.type, message.callId, message.toolName, message.title ?? '', JSON.stringify(message.args ?? null)].join('\0');
    case 'tool-result':
      if (message.historySlot) return [message.type, message.callId, message.toolName].join('\0');
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
    case 'run-summary':
      // Identity only: an adapter rewrites a summary in place as its run progresses and finishes
      // (see isVolatileTailMessage), and a cursor must survive that. A client holding an older
      // copy receives the rewrite live, keyed by `key`, and a reload of its page restates it.
      return [message.type, message.key, message.turnId].join('\0');
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

/** A pending native result is a real, reserved paging position, not a completed tool. */
export function isPendingToolSlot(message: AgentMessage): boolean {
  return message.type === 'tool-result' && message.historySlot === true && message.pending === true;
}

/** Attach the broker-owned single-row reload boundary; payload changes never alter slot identity. */
export function withToolSlotCursor(message: AgentMessage, cursor: string | undefined): AgentMessage {
  return cursor && isPendingToolSlot(message) ? { ...message, reloadCursor: cursor } as AgentMessage : message;
}

/** Whole-array counterpart of the cache builders' one-pass slot annotation. */
export function withToolSlotCursors(messages: AgentMessage[]): AgentMessage[] {
  if (!messages.some((row) => isPendingToolSlot(row) && !('reloadCursor' in row && row.reloadCursor))) return messages;
  const indexer = new BackwardHistoryCursorIndexer();
  return messages.map((row) => withToolSlotCursor(row, indexer.push(row)));
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
  /** Backward: the boundary before the page. Newer (forward) pages: the boundary after it. */
  cursor?: string;
  /** More durable history lies beyond the page, in the page's own direction. */
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
  messages = withToolSlotCursors(messages);
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
 * Walk FORWARD over the raw durable history from an older-kind boundary until `limit` transcript
 * messages are collected, or the walk reaches `until` (another older-kind boundary) or the end.
 *
 * The mirror of {@link backwardHistoryPage}: the same pageable rows, the same cursor encoding. A
 * forward page from `b` that returns `k` rows and ends at `e` holds exactly the rows a backward
 * page from `e` with limit `k` returns, so a client can release it and reload it either way. A
 * full page ends just before the next row a page carries (or at `until` or the end), so rows no
 * page carries never separate a page from the range after it. `cursor` names `e` and is always
 * present (it is `until` itself, verbatim, when the walk reached it); `hasMore` says durable rows
 * exist beyond `e`. With `holdTrailingText` a page without `until` stops at the running-turn hold
 * (see {@link runningTurnHoldEnd}), and `hasMore` then counts the held rows.
 */
export function forwardHistoryPage(
  messages: AgentMessage[],
  rawCursor: string | undefined,
  limit = 100,
  rawUntil?: string,
  options: { holdTrailingText?: boolean } = {},
): BackwardHistoryPage {
  messages = withToolSlotCursors(messages);
  const start = validatedOlderBoundary(messages, rawCursor);
  if (typeof start !== 'number') return start;
  let stop = messages.length;
  if (rawUntil !== undefined) {
    const until = validatedOlderBoundary(messages, rawUntil);
    if (typeof until !== 'number') return until;
    if (until < start) return invalidOlderCursorPage(rawUntil);
    stop = until;
  } else if (options.holdTrailingText) {
    // A page that runs to the end of a history a turn is still writing stops at the running-turn
    // hold, like every frame: the rows after it may still be rewritten.
    stop = runningTurnHoldEnd(start, stop, (index) => messages[index]!);
  }
  const pageLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 100));
  const page: AgentMessage[] = [];
  let boundary = start;
  while (boundary < stop && page.length < pageLimit) {
    const message = messages[boundary]!;
    boundary += 1;
    if (isBackwardPageMessage(message)) page.push(message);
  }
  // Rows no page ever carries belong to neither side, so a full page ends before the next row a
  // page does carry: a range with exactly `limit` rows left before `until` closes in one page.
  while (boundary < stop && !isBackwardPageMessage(messages[boundary]!)) boundary += 1;
  const hasMore = boundary < messages.length;
  return {
    messages: page,
    // A walk that reached `until` names it verbatim, so the client recognises the closed range by
    // the cursor it sent rather than by comparing positions it cannot read.
    cursor: rawUntil !== undefined && boundary === stop
      ? rawUntil
      : backwardHistoryCursor(messages, boundary),
    hasMore,
    endOfHistory: !hasMore,
  };
}

function invalidOlderCursorPage(rawCursor: string | undefined): BackwardHistoryPage {
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

/** The boundary an older-kind cursor names in `messages`, or the page-shaped refusal. */
function validatedOlderBoundary(
  messages: AgentMessage[],
  rawCursor: string | undefined,
): number | BackwardHistoryPage {
  const decoded = decodeOlderCursor(rawCursor);
  if (decoded.invalid || !decoded.cursor) return invalidOlderCursorPage(rawCursor);
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
  return cursor.b;
}

/**
 * One incremental history frame a client asked for without reconnecting (contract revision 28).
 *
 * It starts at the client's own reconnect position and covers the durable rows persisted since, as
 * a PREFIX: `[n, m)` with `m` chosen by the count and decoded-byte bounds, never a newest-rows
 * suffix. A frame that had to leave rows out therefore never leaves a hole and is never a
 * replacement; the rows after `m` stay live on the client until its next request. `cursor` and
 * `endCursor` both name `m`, in the reconnect and backward-page encodings.
 */
export interface HistoryRefresh {
  messages: AgentMessage[];
  cursor: string;
  endCursor: string;
  /** Durable rows exist beyond `m`. */
  more: boolean;
}

/** The client's cursor no longer names a boundary of this history (a rewrite, or a bad cursor). */
export interface HistoryRefreshRefusal {
  gap: {
    reason: HistoryGapReason;
    code: HistoryGapCode;
    message: string;
  };
}

/** A `history-refresh` request's bound and starting cursor, once it may be served. */
export interface HistoryRefreshRequest {
  limit: number;
  since: string;
}

/** Rows a `history-refresh` carries when the request names no limit. */
export const DEFAULT_HISTORY_REFRESH_LIMIT = 100;

/**
 * Validate a `history-refresh` request before any history is read: its `limit` (an integer from 1
 * to 500, 100 when absent) and its reconnect `cursor`, and whether [session] serves refreshes at
 * all. A session whose live rows carry other keys than their history rows refuses with
 * `NOT_SUPPORTED`, because every row a refresh restated would then show twice.
 */
export function historyRefreshRequest(
  msg: { limit?: unknown; cursor?: unknown } | null | undefined,
  session: { historyRefreshRefusal(): string | undefined },
): HistoryRefreshRequest | { code: 'BAD_PARAM' | 'NOT_SUPPORTED'; message: string } {
  const limit = typeof msg?.limit === 'number' ? msg.limit : DEFAULT_HISTORY_REFRESH_LIMIT;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { code: 'BAD_PARAM', message: 'history refresh limit must be an integer from 1 to 500' };
  }
  const since = typeof msg?.cursor === 'string' ? msg.cursor.trim() : '';
  if (!since) {
    return { code: 'BAD_PARAM', message: 'history-refresh requires the history cursor of the last frame' };
  }
  const refusal = session.historyRefreshRefusal();
  if (refusal) return { code: 'NOT_SUPPORTED', message: refusal };
  return { limit, since };
}

/**
 * Whether a durable row may be text still streaming into the live stream. A text row followed by
 * any later durable row has finished; only the newest one, while a turn runs, can still be growing
 * (an adapter that persists text progressively stores a shorter copy than the live stream holds).
 */
export function isStreamableHistoryText(message: AgentMessage): boolean {
  return (message.type === 'model-output' || message.type === 'thinking')
    && typeof message.key === 'string'
    && message.key.length > 0;
}

/**
 * Serve a `history-refresh` over one complete durable history (see {@link HistoryRefresh}).
 *
 * `holdTrailingText` is set while a turn runs: the rows at the end that the turn may still rewrite
 * are then left out (see {@link refreshPrefixEnd}). At least one row is sent whenever any is
 * eligible, so a single oversized row still ships alone.
 */
export function historyRefresh(
  durable: AgentMessage[],
  since: string | undefined,
  options: {
    max: number;
    maxDecodedBytes?: number;
    measure?: (message: AgentMessage) => number;
    holdTrailingText?: boolean;
  },
): HistoryRefresh | HistoryRefreshRefusal {
  durable = withToolSlotCursors(durable);
  const decoded = decodeCursor(since);
  const refused = (
    reason: HistoryGapReason,
    code: HistoryGapCode,
    message: string,
  ): HistoryRefreshRefusal => ({ gap: { reason, code, message } });
  if (decoded.invalid || !decoded.cursor) {
    return refused('invalid-cursor', 'HISTORY_CURSOR_INVALID', 'history cursor is invalid');
  }
  const start = decoded.cursor.n;
  if (!Number.isInteger(start) || start < 0 || start > durable.length) {
    return refused(
      'cursor-out-of-range',
      'HISTORY_CURSOR_GONE',
      'history cursor is outside the retained session history',
    );
  }
  if (prefixHash(durable, start) !== decoded.cursor.h) {
    return refused(
      'cursor-prefix-mismatch',
      'HISTORY_CURSOR_DIVERGED',
      'history cursor no longer matches this session',
    );
  }
  const end = refreshPrefixEnd(
    start,
    durable.length,
    (index) => durable[index]!,
    options,
  );
  const hash = prefixHash(durable, end);
  return {
    messages: durable.slice(start, end),
    cursor: encodeCursor({ v: 1, n: end, h: hash }),
    endCursor: encodeOlderCursor({ v: 1, k: 'older', b: end, h: hash }),
    more: end < durable.length,
  };
}

/**
 * Stop before text still streaming and trailing calls whose arguments may still be arriving.
 * OpenCode/Kilo mutable parts reserve both their call and result positions from their first
 * emission. Their identity-bound slots update in place, so a slow tool holds no later rows and
 * neither call count nor payload size can turn its completion into an insertion in a prefix.
 * Other adapters append results; an earlier unmatched call does not move subsequent positions.
 */
export function runningTurnHoldEnd(
  start: number,
  length: number,
  rowAt: (index: number) => AgentMessage,
): number {
  let stop = length;
  if (stop > start && isStreamableHistoryText(rowAt(stop - 1))) stop -= 1;
  while (stop > start && rowAt(stop - 1).type === 'tool-call') stop -= 1;
  return stop;
}

/**
 * Split one durable history for an attach, reconnect or resync frame sent while a turn runs: the
 * frame covers `framed` and names its cursors at the running-turn hold (see
 * {@link runningTurnHoldEnd}), and `held` is delivered after the frame with the other rows kept out
 * of the cursor space, so no boundary a frame names lies after a row the turn may still rewrite or
 * write rows after.
 * The hold never reaches back before a valid reconnect cursor [since]: a reconnect never moves its
 * client's boundary backward.
 */
export function holdRunningTurn(
  durable: AgentMessage[],
  since?: string,
): { framed: AgentMessage[]; held: AgentMessage[] } {
  const decoded = decodeCursor(since);
  let from = 0;
  if (
    decoded.cursor
    && Number.isInteger(decoded.cursor.n)
    && decoded.cursor.n >= 0
    && decoded.cursor.n <= durable.length
    && prefixHash(durable, decoded.cursor.n) === decoded.cursor.h
  ) {
    from = decoded.cursor.n;
  }
  const end = runningTurnHoldEnd(from, durable.length, (index) => durable[index]!);
  return end === durable.length
    ? { framed: durable, held: [] }
    : { framed: durable.slice(0, end), held: durable.slice(end) };
}

/**
 * The exclusive end of a refresh frame over rows `[start, length)`, shared by the generic and the
 * indexed history so both deliver the same frame for the same history.
 *
 * With `holdTrailingText` (a turn is running) the frame stops at the running-turn hold (see
 * {@link runningTurnHoldEnd}), so the boundary it names survives the next read.
 */
export function refreshPrefixEnd(
  start: number,
  length: number,
  rowAt: (index: number) => AgentMessage,
  options: {
    max: number;
    maxDecodedBytes?: number;
    measure?: (message: AgentMessage) => number;
    holdTrailingText?: boolean;
  },
): number {
  const stop = options.holdTrailingText ? runningTurnHoldEnd(start, length, rowAt) : length;
  const max = Number.isFinite(options.max) && options.max > 0
    ? Math.trunc(options.max)
    : Number.POSITIVE_INFINITY;
  const maxBytes = options.maxDecodedBytes !== undefined
    && Number.isFinite(options.maxDecodedBytes)
    && options.maxDecodedBytes > 0
    ? options.maxDecodedBytes
    : Number.POSITIVE_INFINITY;
  const measure = options.measure ?? estimatedClientDecodedBytes;
  let end = start;
  let bytes = 0;
  while (end < stop && end - start < max) {
    const size = maxBytes === Number.POSITIVE_INFINITY ? 0 : measure(rowAt(end));
    if (end > start && bytes + size > maxBytes) break;
    bytes += size;
    end += 1;
  }
  return end;
}

/** Session-state message types whose LATEST instance must survive capping: they carry the current
 *  task panel / goal bar / statusline metadata, and (unlike chat bubbles) dropping an old one loses
 *  state the tail may never restate. Backward pages never carry them, so a frame that leaves one
 *  behind its tail start has to re-expose it. */
const STATE_SALVAGE_TYPES = new Set<AgentMessage['type']>(['task-list-state', 'goal-state', 'metadata-update']);

/** How a bounded frame is measured, and what else it may salvage state from. */
export interface HistoryFrameBoundOptions {
  /**
   * Decoded-size estimate of one message AS THIS CLIENT WILL RECEIVE IT. Egress can reshape a row
   * (a reference-mode connection receives an oversized diff as a small `diffRef`), so the byte
   * bound is measured on the delivered shape: callers pass their own egress transform composed
   * with {@link estimatedClientDecodedBytes}, never a second copy of the egress rule. The default
   * measures the message unchanged.
   */
  measure?: (message: AgentMessage) => number;
  /**
   * Durable rows before `messages` that the client is NOT sent (the prefix an incremental delta
   * omits). A capped frame is always a replacement, so the latest state rows in this prefix must be
   * re-exposed exactly like those behind the tail start.
   */
  earlier?: readonly AgentMessage[];
}

export interface CappedHistoryMessages {
  messages: AgentMessage[];
  truncated?: { shown: number; total: number };
  /** Index in the input of the first shown tail message; present exactly when truncated. */
  tailStart?: number;
}

/**
 * Bound one history frame by count and by the client's decoded-size estimate.
 *
 * A 76 MB Claude transcript maps to ~16k messages / a ~23 MB frame, which the phone then has to
 * JSON.parse and render in one synchronous pass (performance must-fix, 2026-07-03), and a client
 * that bounds its decoded window cannot keep a frame larger than that window. The frame is a
 * contiguous newest tail, followed by the latest session-state frames that fell out of it. The
 * projection belongs at the end: active panels upsert either way, while terminal goal states (for
 * example `paused`) render as notes and must be visible at the initial bottom scroll.
 *
 * Both bounds apply to the FINAL delivered shape. At most `max` messages are sent, enrichment
 * included: projections may claim up to {@link HISTORY_FRAME_MAX_PROJECTIONS} of those slots and
 * never buy them from beyond the bound (the same rule the compact indexed attach uses). The
 * decoded estimate of the whole frame, measured by {@link HistoryFrameBoundOptions.measure}, stays
 * within `maxDecodedBytes`, shrinking the tail from its oldest end; at least one tail message is
 * always kept, so a single oversized message still ships alone rather than vanishing. `shown`
 * counts every message in the frame; `tailStart` is where the backward cursor for the rest of the
 * history belongs. `max` <= 0 (or non-finite) disables the count bound, and the same for the byte
 * bound.
 */
export function capHistoryMessages(
  messages: AgentMessage[],
  max: number,
  total = messages.length,
  maxDecodedBytes = Number.POSITIVE_INFINITY,
  options: HistoryFrameBoundOptions = {},
): CappedHistoryMessages {
  const countBounded = Number.isFinite(max) && max > 0;
  const byteBounded = Number.isFinite(maxDecodedBytes) && maxDecodedBytes > 0;
  if (!countBounded && !byteBounded) return { messages };
  const n = messages.length;
  if (n === 0) return { messages };
  const measureMessage = options.measure ?? estimatedClientDecodedBytes;
  const earlier = options.earlier ?? [];
  const e = earlier.length;
  // One index space: the omitted prefix occupies [-e, 0) and the input [0, n).
  const rowAt = (index: number): AgentMessage => (index < 0 ? earlier[e + index]! : messages[index]!);
  const bytesOf = new Map<number, number>();
  const measure = (index: number): number => {
    let bytes = bytesOf.get(index);
    if (bytes === undefined) {
      bytes = measureMessage(rowAt(index));
      bytesOf.set(index, bytes);
    }
    return bytes;
  };
  if ((!countBounded || n <= max) && (!byteBounded || newestFirstSumWithin(n, measure, maxDecodedBytes))) {
    return { messages };
  }
  const bound = countBounded ? Math.max(1, Math.trunc(max)) : n;
  // The newest instance of each state key, in history order. A key whose newest instance lies
  // inside the shown tail is covered by the tail and never projected.
  const stateKey = (m: AgentMessage): string => `${m.type}\0${(m as { key?: string }).key ?? ''}`;
  const latestByKey = new Map<string, number>();
  for (let index = -e; index < n; index++) {
    const message = rowAt(index);
    if (!STATE_SALVAGE_TYPES.has(message.type)) continue;
    const key = stateKey(message);
    latestByKey.delete(key);
    latestByKey.set(key, index);
  }
  const latest = [...latestByKey.values()].sort((left, right) => left - right);
  const budget = Math.max(0, Math.min(HISTORY_FRAME_MAX_PROJECTIONS, bound - 1));
  const exposedBefore = (start: number): number[] => latest.filter((index) => index < start);
  // Count phase: walk the spent allowance upward until the projections exposed by moving the tail
  // start forward fit in what has been spent (bounded because `spent` never exceeds `budget`).
  let start = Math.max(0, n - bound);
  let projections: number[] = [];
  if (start > 0) {
    for (let spent = 0; spent <= budget; spent += 1) {
      const candidateStart = Math.max(0, n - (bound - spent));
      const exposed = exposedBefore(candidateStart);
      if (exposed.length <= spent || spent === budget) {
        start = candidateStart;
        projections = exposed.length <= spent ? exposed : exposed.slice(exposed.length - spent);
        break;
      }
    }
  }
  // Byte phase: shrink the tail from its oldest end until the whole frame fits. A row leaving the
  // tail may expose its own state key; it joins the projections within the same allowance. Every
  // step adjusts running sums, so the phase is linear in the rows it walks.
  if (byteBounded) {
    // No frame can start before `floor`: from there the tail ALONE is over budget. Walking from the
    // newest end also means a row that can never ship is never measured (nor egress-transformed).
    let floor = n;
    let tailBytes = 0;
    while (floor > start && tailBytes + measure(floor - 1) <= maxDecodedBytes) {
      floor -= 1;
      tailBytes += measure(floor);
    }
    if (floor === n) {
      floor = n - 1;
      tailBytes = measure(n - 1);
    }
    let exposedCount = 0;
    const exposeThrough = (tailStart: number): void => {
      while (exposedCount < latest.length && latest[exposedCount]! < tailStart) exposedCount += 1;
    };
    let projectionBytes = 0;
    const chooseProjections = (): void => {
      // Within the projection allowance AND within the count bound beside the tail: a frame the
      // byte phase starts later (an incremental delta turned replacement, say) is still at most
      // `bound` rows, enrichment included.
      const allowance = Math.min(budget, exposedCount, Math.max(0, bound - (n - start)));
      projections = latest.slice(exposedCount - allowance, exposedCount);
      projectionBytes = 0;
      for (const index of projections) projectionBytes += measure(index);
    };
    if (floor > start) {
      start = floor;
      exposeThrough(start);
      chooseProjections();
    } else {
      exposeThrough(start);
      projectionBytes = 0;
      for (const index of projections) projectionBytes += measure(index);
    }
    while (tailBytes + projectionBytes > maxDecodedBytes && start < n - 1) {
      tailBytes -= measure(start);
      start += 1;
      exposeThrough(start);
      chooseProjections();
    }
    // Enrichment is a courtesy: it never keeps the frame over budget.
    while (tailBytes + projectionBytes > maxDecodedBytes && projections.length > 0) {
      projectionBytes -= measure(projections[0]!);
      projections = projections.slice(1);
    }
  }
  // A frame that still starts at the first input row lost nothing, so it stays exactly as the caller
  // built it (an incremental delta stays incremental and needs no projection of its prefix).
  if (start === 0) return { messages };
  const frame = [...messages.slice(start), ...projections.map((index) => rowAt(index))];
  return {
    messages: frame,
    truncated: { shown: frame.length, total },
    tailStart: start,
  };
}

/** Whether rows `[0, end)` sum to at most `limit`, measured newest first and stopping early. */
function newestFirstSumWithin(
  end: number,
  measure: (index: number) => number,
  limit: number,
): boolean {
  let sum = 0;
  for (let index = end - 1; index >= 0; index--) {
    sum += measure(index);
    if (sum > limit) return false;
  }
  return true;
}

/**
 * {@link capHistoryMessages} for a delta. A capped frame is always `reset:true`: when an
 * incremental delta overflows a bound, silently dropping its middle would corrupt the client's
 * cached thread, so the client is told to rebuild from the tail instead. The reconnect `cursor`
 * keeps covering the FULL durable prefix, so the next reattach is incremental again. `truncated`
 * lets the UI say honestly "showing the last N of M".
 *
 * `history` is the complete durable history the delta is a suffix of. With it, a capped
 * incremental delta also salvages the latest state rows of the prefix it omitted (the client's
 * copy of them is about to be replaced), and the capped frame carries its own `olderCursor`.
 */
export function capHistoryDelta(
  delta: HistoryDelta,
  max: number,
  totalDurable: number,
  maxDecodedBytes = Number.POSITIVE_INFINITY,
  options: { history?: readonly AgentMessage[]; measure?: (message: AgentMessage) => number } = {},
): HistoryDelta {
  const { history, measure } = options;
  // `delta.messages` is always a suffix of the durable history (the whole of it for a reset).
  const suffixStart = totalDurable - delta.messages.length;
  const earlier = !delta.reset && history && suffixStart > 0
    ? history.slice(0, suffixStart)
    : undefined;
  const capped = capHistoryMessages(delta.messages, max, totalDurable, maxDecodedBytes, {
    ...(measure ? { measure } : {}),
    ...(earlier ? { earlier } : {}),
  });
  if (!capped.truncated) return delta;
  const olderBoundary = suffixStart + capped.tailStart!;
  return {
    messages: capped.messages,
    reset: true,
    cursor: delta.cursor,
    endCursor: delta.endCursor,
    ...(delta.gap ? { gap: delta.gap } : {}),
    truncated: capped.truncated,
    olderBoundary,
    ...(history ? { olderCursor: backwardHistoryCursor(history as AgentMessage[], olderBoundary) } : {}),
  };
}

export function historyDelta(messages: AgentMessage[], since?: string): HistoryDelta {
  messages = withToolSlotCursors(messages);
  const decoded = decodeCursor(since);
  const cursor = decoded.cursor;
  const fullHash = prefixHash(messages, messages.length);
  const nextCursor = encodeCursor({ v: 1, n: messages.length, h: fullHash });
  // The same boundary as `nextCursor`, in the backward-page encoding (see HistoryDelta.endCursor).
  const endCursor = encodeOlderCursor({ v: 1, k: 'older', b: messages.length, h: fullHash });
  if (decoded.invalid) {
    return {
      messages,
      reset: true,
      cursor: nextCursor,
      endCursor,
      gap: {
        reason: 'invalid-cursor',
        code: 'HISTORY_CURSOR_INVALID',
        message: 'history cursor is invalid; full replay was sent',
        since,
      },
    };
  }
  if (!cursor) return { messages, reset: true, cursor: nextCursor, endCursor };
  if (!Number.isInteger(cursor.n) || cursor.n < 0 || cursor.n > messages.length) {
    return {
      messages,
      reset: true,
      cursor: nextCursor,
      endCursor,
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
      endCursor,
      gap: {
        reason: 'cursor-prefix-mismatch',
        code: 'HISTORY_CURSOR_DIVERGED',
        message: 'history cursor no longer matches this session; full replay was sent',
        since,
      },
    };
  }
  return { messages: messages.slice(cursor.n), reset: false, cursor: nextCursor, endCursor };
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
