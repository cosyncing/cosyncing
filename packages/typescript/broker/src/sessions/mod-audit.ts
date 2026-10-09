/**
 * The audit trail for permission decisions, and the reason it carries no prompt text.
 *
 * When a tap in the app approves a tool call, the tap replaces a keystroke in Claude's own
 * dialog for that one call. The record has to survive that: a month later, someone is
 * entitled to ask "who approved this, and on what basis?" and get an answer. So each decision
 * row carries the session, the request, the tool, the engine's own verdict, the permission
 * mode the gate actually saw, who answered, and how long it took.
 *
 * What it deliberately does not carry is prompt text or tool output. Those answer a different
 * question, they are already in the transcript the user owns, and copying them into a broker
 * log turns a permission audit into a content archive. `inputDigest` is a short non-reversible
 * fingerprint whose only job is to let two rows be recognised as the same call; it is not a
 * way of getting the command back.
 *
 * Retention is bounded and in memory for v1: rows are dropped once `retentionMs` has passed
 * and `maxRows` is exceeded, oldest first. The store is not a queue and never blocks a
 * decision on its own health.
 */

import { createHash } from 'node:crypto';

export interface ModAuditRow {
  sessionId: string;
  requestId: string;
  tool: string;
  /** The engine's verdict the mod passed through: `ask` for every hold by construction. */
  engineVerdict: string;
  /** The mode the gate saw when it decided. `unknown` is recorded as `unknown`, not guessed. */
  modeSeen: string;
  /** Who settled it: a tap in the app, the terminal band, the deadline, or the turn ending. */
  answeredBy: 'app' | 'band' | 'expired' | 'cancel';
  /** Milliseconds from hold arrival to resolution. */
  durationMs: number;
  /**
   * How many polls the broker charged this hold for.
   *
   * Recorded because the poll budget is a rule rather than a suggestion: the mod waits on
   * the broker's own long-poll, so a hold that needed more than the budget means the two
   * sides disagree about the ceiling, which is invisible unless the trail says so.
   */
  polls?: number;
  at: number;
  /** A `hold` the broker declined to hold, with the reason. Not a decision, but the same trail. */
  released?: string;
  /** Fingerprint of the tool input. Never reversible, never the input itself. */
  inputDigest?: string;
}

export interface ModAuditStoreOptions {
  now?: () => number;
  maxRows?: number;
  retentionMs?: number;
  /** Optional append sink. In-memory rows are authoritative; this is so a run can be filed. */
  onRow?: (row: ModAuditRow) => void;
}

const DEFAULT_MAX_ROWS = 2_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Short, stable, non-reversible fingerprint of a tool input summary. */
export function modInputDigest(input: string | undefined): string | undefined {
  if (!input) return undefined;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export class ModAuditStore {
  private rows: ModAuditRow[] = [];
  private readonly now: () => number;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private readonly onRow?: (row: ModAuditRow) => void;

  constructor(options: ModAuditStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.onRow = options.onRow;
  }

  record(row: Omit<ModAuditRow, 'at'>): ModAuditRow {
    const entry: ModAuditRow = { ...row, at: this.now() };
    this.rows.push(entry);
    this.onRow?.(entry);
    this.trim();
    return entry;
  }

  /** Recorded decisions, newest last. Released-without-holding rows are included and marked. */
  list(filter: { sessionId?: string; includeReleases?: boolean } = {}): ModAuditRow[] {
    const out = this.rows.filter((row) => {
      if (filter.sessionId && row.sessionId !== filter.sessionId) return false;
      if (!filter.includeReleases && row.released) return false;
      return true;
    });
    return out;
  }

  get size(): number {
    return this.rows.length;
  }

  clear(): void {
    this.rows = [];
  }

  private trim(): void {
    const cutoff = this.now() - this.retentionMs;
    if (this.rows.length > this.maxRows || (this.rows.length > 0 && this.rows[0]!.at < cutoff)) {
      this.rows = this.rows.filter((row) => row.at >= cutoff);
    }
    if (this.rows.length > this.maxRows) this.rows = this.rows.slice(this.rows.length - this.maxRows);
  }
}
