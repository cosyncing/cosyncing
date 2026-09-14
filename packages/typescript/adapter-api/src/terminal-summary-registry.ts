import type { AgentMessage, HistorySourceIdentity, Unsubscribe } from '@cosyncing/protocol';

export type TerminalSummary = Extract<AgentMessage, { type: 'run-summary' }> & {
  status: 'done' | 'error' | 'cancelled';
};

function sameBoundary(
  left: HistorySourceIdentity | undefined,
  right: HistorySourceIdentity | undefined,
): boolean {
  return left?.sourceId === right?.sourceId
    && left?.revision === right?.revision
    && left?.appendPosition === right?.appendPosition
    && left?.rewriteToken === right?.rewriteToken;
}

/** Bounded per-session completion projection shared by one writer and every
 * live read-only connection. Stored rows are visible only against the exact
 * native boundary that authorized them; an already-primed reader may advance
 * that boundary only after it independently proved append-only lineage. */
export class TerminalSummaryRegistry<T extends TerminalSummary = TerminalSummary> {
  private rows: T[] = [];
  private boundary?: HistorySourceIdentity;
  private readonly handlers = new Set<() => void>();

  hydrate(boundary: HistorySourceIdentity, rows: readonly T[]): void {
    if (this.boundary || this.rows.length > 0) return;
    this.boundary = { ...boundary };
    this.rows = this.normalize(rows);
  }

  publish(boundary: HistorySourceIdentity, summary?: T): void {
    this.boundary = { ...boundary };
    if (!summary) return;
    const next = this.normalize([...this.rows, summary]);
    const changed = JSON.stringify(next) !== JSON.stringify(this.rows);
    this.rows = next;
    if (changed) this.notify();
  }

  read(
    boundary: HistorySourceIdentity,
    appendLineageProved = false,
  ): { valid: boolean; rows: T[] } {
    if (!this.boundary) {
      this.boundary = { ...boundary };
      return { valid: true, rows: this.cloneRows() };
    }
    if (sameBoundary(this.boundary, boundary) || appendLineageProved) {
      this.boundary = { ...boundary };
      return { valid: true, rows: this.cloneRows() };
    }
    this.rows = [];
    this.boundary = { ...boundary };
    this.notify();
    return { valid: false, rows: [] };
  }

  clear(): void {
    const changed = this.rows.length > 0 || this.boundary !== undefined;
    this.rows = [];
    this.boundary = undefined;
    if (changed) this.notify();
  }

  subscribe(handler: () => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private normalize(rows: readonly T[]): T[] {
    const out: T[] = [];
    for (const row of rows.slice(-64)) {
      const index = out.findIndex((entry) =>
        entry.key === row.key || entry.turnId === row.turnId);
      if (index >= 0) out.splice(index, 1);
      out.push({ ...row });
    }
    return out.slice(-64);
  }

  private cloneRows(): T[] {
    return this.rows.map((row) => ({ ...row }));
  }

  private notify(): void {
    for (const handler of this.handlers) handler();
  }
}
