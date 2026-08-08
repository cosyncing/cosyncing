import type { SessionInfo } from '@cosyncing/protocol';

/**
 * The live owner's repair channel (R0c.4).
 *
 * R0c/R0c.1 made the live Hub owner the single run-state authority, and R0c.1/R0c.2/R0c.3 built the
 * fences that stop weaker evidence from retiring it. What was missing is a way for the owner to be
 * WRONG and recover: `ManagedConn.liveRunning` is edge-triggered (status frames plus a one-time
 * attach seed), so one missed edge latches permanently and every fence then protects the wrong
 * value. Five occurrences of that class produced R0c…R0c.3.
 *
 * The repair channel keeps the authority exactly where it is. An inferred snapshot never supplies an
 * answer here — it only proves that a CONTRADICTION exists, which is a reason for the owner to
 * re-derive from its own exact native evidence. The owner still decides, and it applies only exact
 * evidence (an in-progress turn with a native turn id, or an exact native idle with a matching
 * terminal). That is why {@link contradictsOwnerRunState} deliberately reports nothing about which
 * side is right.
 *
 * Declared here rather than on `SessionConnection`: that interface is part of the exported
 * broker/client contract snapshot, and this is an in-process broker↔adapter capability with no wire
 * surface. Adapters opt in structurally; adapters without a native run-state channel simply do not.
 */
export interface RunStateRepairableConnection {
  /** Re-derive this owner's run state from EXACT native evidence. Never accepts a caller's status.
   *  Resolving means the attempt finished, not that anything changed: an unavailable or ambiguous
   *  probe is unknown evidence and must leave the state alone. */
  requestRunStateRepair(): void | Promise<void>;
}

/** The repair capability of `conn`, or undefined when the adapter has no exact native channel. */
export function runStateRepairable(conn: unknown): RunStateRepairableConnection | undefined {
  const candidate = conn as Partial<RunStateRepairableConnection> | null | undefined;
  return typeof candidate?.requestRunStateRepair === 'function'
    ? (candidate as RunStateRepairableConnection)
    : undefined;
}

/**
 * Does an external snapshot disagree with the owner's DEFINITE run state?
 *
 * Only working/idle/needs-input are definite. `needs-input` and `working` are both "a turn is in
 * flight", so they do not contradict each other — the difference between them is a pending
 * permission/question, which is the owned connection's own exact evidence and never something a
 * scan can see (see `overlayAuthoritativeOwner`). Collapsing them keeps a permission-blocked owner
 * from re-probing its runtime on every watcher tick.
 */
export function contradictsOwnerRunState(
  external: SessionInfo['status'] | undefined,
  owner: SessionInfo['status'] | undefined,
): boolean {
  if (external === undefined || owner === undefined) return false;
  const inFlight = (status: SessionInfo['status']): boolean => status !== 'idle';
  return inFlight(external) !== inFlight(owner);
}
