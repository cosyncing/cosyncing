import type { SessionInfo } from '@cosyncing/adapter-api';

/** A bounded, transcript-free roster mutation. */
export interface RosterDelta {
  revision: number;
  machine: string;
  tool: string;
  sessionId: string;
  changedFields: string[];
  session?: SessionInfo;
  removed?: true;
}

export interface RosterDeltaBatch {
  revision: number;
  deltas: RosterDelta[];
  resetRequired?: boolean;
}

const ROSTER_FIELDS = [
  'title',
  'status',
  'attachMode',
  'launchSurface',
  'lineageId',
  'liveUuid',
  'slug',
  'cwd',
  'projectName',
  'origin',
  'parentThreadId',
  'nativeId',
  'model',
  'currentModel',
  'currentAgent',
  'currentMode',
  'createdAt',
  'updatedAt',
  'terminalSyncHint',
  'control',
] as const;

type RosterField = (typeof ROSTER_FIELDS)[number];

function keyOf(info: SessionInfo, machine: string): string {
  return `${machine}\0${info.tool}\0${info.id}`;
}

function valueAt(info: SessionInfo, field: RosterField): unknown {
  return info[field];
}

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedFields(before: SessionInfo | undefined, after: SessionInfo): string[] {
  if (!before) return ['session'];
  return ROSTER_FIELDS.filter((field) => !equalValue(valueAt(before, field), valueAt(after, field)));
}

/**
 * Monotonic roster revision plus a bounded reconnect journal.
 *
 * Only SessionInfo roster metadata enters this store. Conversation history,
 * telemetry, tool output, and model catalogs have no representation here.
 */
export class RosterRevisionStore {
  private revisionValue = 0;
  private changedAtValue = 0;
  private readonly current = new Map<string, SessionInfo>();
  private readonly journal: RosterDelta[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(private readonly maxJournal = 512) {}

  get revision(): number {
    return this.revisionValue;
  }

  /** Stable until roster content changes; suitable for `generatedAt`. */
  get changedAt(): number {
    return this.changedAtValue;
  }

  observe(info: SessionInfo, machine: string): RosterDelta | undefined {
    const normalized = structuredClone({ ...info, machine });
    const key = keyOf(normalized, machine);
    const fields = changedFields(this.current.get(key), normalized);
    if (fields.length === 0) return undefined;
    this.current.set(key, normalized);
    return this.append({
      revision: 0,
      machine,
      tool: normalized.tool,
      sessionId: normalized.id,
      changedFields: fields,
      session: normalized,
    });
  }

  /** Removes one row when a bounded view no longer contains it. */
  remove(machine: string, tool: string, sessionId: string): RosterDelta | undefined {
    const key = `${machine}\0${tool}\0${sessionId}`;
    const info = this.current.get(key);
    if (!info) return undefined;
    this.current.delete(key);
    return this.append({
      revision: 0,
      machine,
      tool,
      sessionId,
      changedFields: ['removed'],
      removed: true,
    });
  }

  /** Remove prior adapter ids for one exact native session before its replacement is observed. An
   * absent native id is not a join, and same-id refreshes remove nothing. */
  removeSuperseded(info: SessionInfo, machine: string): RosterDelta[] {
    if (!info.nativeId) return [];
    const removed: RosterDelta[] = [];
    for (const current of [...this.current.values()]) {
      if (
        current.machine !== machine ||
        current.tool !== info.tool ||
        current.id === info.id ||
        current.nativeId !== info.nativeId
      ) continue;
      const delta = this.remove(machine, current.tool, current.id);
      if (delta) removed.push(delta);
    }
    return removed;
  }

  /**
   * Reconciles a local snapshot, including bounded removal events.
   *
   * `withheldTools` names backends the snapshot could not speak for -- a
   * discovery leg abandoned at its budget, or one that threw. Row count does not
   * enter into it: such a leg returns the carry of the last sweep that DID read
   * the adapter, which cannot mention anything that appeared since. Their rows
   * are left alone; every other backend reconciles normally.
   *
   * Removal authority is per ADAPTER because absence means different things for
   * different ones in the same sweep. Without this, one adapter timing out
   * published a removal delta for every session it owned, and a connected client
   * applied them the moment they arrived: the snapshot's own completeness flag
   * cannot help, because deltas are a separate channel that never sees it. The
   * whole agent's sessions vanished from the list and returned on the next
   * healthy sweep.
   *
   * Withholding is not the same as suppressing removals altogether. A session
   * deleted under a HEALTHY adapter still has to leave, and it does.
   */
  reconcile(
    sessions: SessionInfo[],
    machine: string,
    options: { withheldTools?: readonly string[] } = {},
  ): void {
    const seen = new Set(sessions.map((info) => keyOf(info, machine)));
    const withheld = new Set(options.withheldTools ?? []);
    // Retire absent owners before admitting replacements. Native incarnations can change adapter id
    // while preserving one native identity; publishing the new row first exposes both logical
    // owners for one revision window and can leave the superseded Working row actionable.
    for (const [key, info] of [...this.current]) {
      if (!key.startsWith(`${machine}\0`) || seen.has(key)) continue;
      if (withheld.has(info.tool)) continue;
      this.current.delete(key);
      this.append({
        revision: 0,
        machine,
        tool: info.tool,
        sessionId: info.id,
        changedFields: ['removed'],
        removed: true,
      });
    }
    for (const info of sessions) this.observe(info, machine);
  }

  eventsAfter(after: number): RosterDeltaBatch {
    if (after > this.revisionValue) {
      return { revision: this.revisionValue, deltas: [], resetRequired: true };
    }
    const oldest = this.journal[0]?.revision ?? this.revisionValue + 1;
    if (after < oldest - 1) {
      return { revision: this.revisionValue, deltas: [], resetRequired: true };
    }
    return {
      revision: this.revisionValue,
      deltas: this.journal.filter((delta) => delta.revision > after),
    };
  }

  async waitAfter(after: number, waitMs: number): Promise<RosterDeltaBatch> {
    const immediate = this.eventsAfter(after);
    if (immediate.resetRequired || immediate.deltas.length > 0 || waitMs <= 0) return immediate;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      this.waiters.add(finish);
    });
    return this.eventsAfter(after);
  }

  private append(delta: RosterDelta): RosterDelta {
    const committed = { ...delta, revision: ++this.revisionValue };
    this.changedAtValue = Date.now();
    this.journal.push(committed);
    while (this.journal.length > this.maxJournal) this.journal.shift();
    for (const wake of [...this.waiters]) wake();
    return committed;
  }
}
