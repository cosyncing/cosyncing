/**
 * Whether the rows a connection streamed live and the rows its history read returns can be merged
 * by key without showing anything twice: what a client does with a `history-refresh` answer or a
 * reconnect frame.
 *
 * Identity follows the client's `stableTranscriptMessageKey`: a row's `key`, else its `requestId`,
 * else its `callId`, each under its type. Streamed text rows accumulate their deltas under that
 * identity, as the client's reducer does, and a history row with the same identity replaces them.
 * The refresh and reconnect frames are built by the broker's own `historyRefresh`/`historyDelta`
 * over the cursor-durable part of each read, so a cursor from the attach frame is used exactly as a
 * client would send it.
 */
import type { AgentMessage } from '../../../adapter-api/src/index.ts';
import { cursorDurableHistory, historyDelta, historyRefresh } from '../../src/sessions/history-delta.ts';

const TRANSCRIPT_TYPES = new Set(['user-message', 'model-output', 'thinking', 'tool-call', 'tool-result', 'run-summary']);
const TEXT_TYPES = new Set(['user-message', 'model-output', 'thinking']);

export function transcriptIdentity(message: AgentMessage): string | undefined {
  const raw = message as unknown as Record<string, unknown>;
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const key = nonEmpty(raw.key);
  if (key) return `${message.type}:key:${key}`;
  const requestId = nonEmpty(raw.requestId);
  if (requestId) return `${message.type}:request:${requestId}`;
  const callId = nonEmpty(raw.callId);
  return callId ? `${message.type}:call:${callId}` : undefined;
}

interface HeldRow {
  type: string;
  text?: string;
  queued?: boolean;
}

/** One client's rows, merged by identity in arrival order (keyless rows are not tracked). */
class ClientRows {
  readonly rows = new Map<string, HeldRow>();

  apply(message: AgentMessage): void {
    if (!TRANSCRIPT_TYPES.has(message.type)) return;
    const identity = transcriptIdentity(message);
    if (!identity) return;
    const raw = message as unknown as Record<string, unknown>;
    const held = this.rows.get(identity);
    const delta = typeof raw.delta === 'string' ? raw.delta : undefined;
    const text = typeof raw.text === 'string' ? raw.text : undefined;
    if (delta !== undefined && text === undefined) {
      this.rows.set(identity, { type: message.type, text: (held?.text ?? '') + delta });
      return;
    }
    this.rows.set(identity, {
      type: message.type,
      ...(text !== undefined ? { text } : held?.text !== undefined ? { text: held.text } : {}),
      ...(raw.queued === true ? { queued: true } : {}),
    });
  }

  /** How many rows show each `type:text`. */
  shown(): Map<string, number> {
    const seen = new Map<string, number>();
    for (const row of this.rows.values()) {
      if (!TEXT_TYPES.has(row.type) || !row.text) continue;
      const shown = `${row.type}:${row.text}`;
      seen.set(shown, (seen.get(shown) ?? 0) + 1);
    }
    return seen;
  }

  /** `type:text` of every text row held more often than any of `sources` holds it alone: one entry
   *  shown under two identities, not a text the conversation really repeats. */
  duplicates(...sources: ClientRows[]): string[] {
    const apart = sources.map((source) => source.shown());
    return [...this.shown()]
      .filter(([shown, count]) => count > Math.max(1, ...apart.map((counts) => counts.get(shown) ?? 0)))
      .map(([shown]) => shown);
  }
}

export interface LiveHistoryKeyAudit {
  /** Live transcript identities the later history read does not contain. */
  liveOnly: string[];
  /** Text rows shown more often after the attach frame, the live rows and one refresh from its
   *  cursor than the live rows or the history show them alone. */
  duplicatesAfterRefresh: string[];
  /** The same after a reconnect frame, keeping the live rows it does not restate. */
  duplicatesAfterReconnect: string[];
  /** Live text rows whose streamed text differs from the history row under the same identity: two
   *  texts sharing one key, which a client shows as one row with the wrong text. */
  textMismatches: string[];
  /** Rows the refresh restated; a refusal leaves it undefined. */
  refreshRows?: number;
  refreshRefusal?: string;
}

export function auditLiveAgainstHistory(input: {
  attachHistory: readonly AgentMessage[];
  live: readonly AgentMessage[];
  history: readonly AgentMessage[];
}): LiveHistoryKeyAudit {
  const historyIdentities = new Set(input.history.map(transcriptIdentity).filter((id): id is string => !!id));
  const liveOnly = [...new Set(input.live
    .filter((message) => TRANSCRIPT_TYPES.has(message.type))
    .map(transcriptIdentity)
    .filter((id): id is string => !!id && !historyIdentities.has(id)))];

  const streamed = new ClientRows();
  for (const message of input.live) streamed.apply(message);
  const saved = new ClientRows();
  for (const message of input.history) saved.apply(message);

  const attach = historyDelta(cursorDurableHistory(input.attachHistory as AgentMessage[]).durable);
  const refreshed = new ClientRows();
  for (const message of attach.messages) refreshed.apply(message);
  for (const message of input.live) refreshed.apply(message);
  const durable = cursorDurableHistory(input.history as AgentMessage[]).durable;
  const refresh = historyRefresh(durable, attach.cursor, { max: 500 });
  let refreshRows: number | undefined;
  let refreshRefusal: string | undefined;
  if ('gap' in refresh) refreshRefusal = refresh.gap.code;
  else {
    refreshRows = refresh.messages.length;
    for (const message of refresh.messages) refreshed.apply(message);
  }

  const reconnect = historyDelta(durable);
  const reconnected = new ClientRows();
  for (const message of reconnect.messages) reconnected.apply(message);
  const restated = new Set(reconnect.messages.map(transcriptIdentity).filter((id): id is string => !!id));
  for (const message of input.live) {
    const identity = transcriptIdentity(message);
    if (identity && !restated.has(identity)) reconnected.apply(message);
  }

  const textMismatches = [...streamed.rows]
    .filter(([identity, row]) => {
      const copy = saved.rows.get(identity);
      return TEXT_TYPES.has(row.type) && row.text !== undefined && copy?.text !== undefined && copy.text !== row.text;
    })
    .map(([identity]) => identity);

  return {
    liveOnly,
    duplicatesAfterRefresh: refreshed.duplicates(streamed, saved),
    duplicatesAfterReconnect: reconnected.duplicates(streamed, saved),
    textMismatches,
    ...(refreshRows !== undefined ? { refreshRows } : {}),
    ...(refreshRefusal !== undefined ? { refreshRefusal } : {}),
  };
}
