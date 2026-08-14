import type { SessionInfo } from '@cosyncing/protocol';

/** One broker-owned live connection, as the roster overlay sees it. */
export interface LiveOverlayEntry {
  /** The Hub key that owns this connection — the stable, order-independent tiebreak. */
  key: string;
  info: SessionInfo;
  status: SessionInfo['status'];
}

/**
 * How strong a claim a live connection has on a session's control surface.
 *
 * True Sync > Drive(driving) > Drive(observing) > live attach > resume attach > read-only observe.
 */
export function controlPriority(info: SessionInfo): number {
  const c = info.control;
  if (c?.terminalSync.supported && c.terminalSync.active) return 40;
  if (c?.drive.supported && c.drive.state === 'driving') return 30;
  if (c?.drive.supported && c.drive.state === 'observing') return 20;
  if (info.attachMode === 'live') return 15;
  if (info.attachMode === 'resume') return 10;
  return 0;
}

/**
 * Reduce every live connection to ONE authoritative owner per session.
 *
 * One session id can have several simultaneous owners: a read-only Observe tail keeps the bare
 * `tool:id` key while an explicit Drive attach owns a distinct `#resume`/`#live` wrapper. Their run
 * states legitimately differ — an Observe tail is idle by its own lights while the Drive owner is
 * mid-turn — so applying each owner's status in turn let Map iteration order decide the answer, and
 * a later-iterated Observe entry could overwrite the Drive owner's `working` back to `idle`. That is
 * exactly the roster status regression R0b exists to prevent, and no client event can undo it.
 *
 * Selection is total and order-independent:
 *   1. the strongest {@link controlPriority} wins;
 *   2. ties go to the more recently updated `SessionInfo`;
 *   3. remaining ties go to the lexicographically smaller Hub key.
 *
 * Rules 2 and 3 exist so the result cannot depend on insertion order; rule 3 alone guarantees
 * determinism because Hub keys are unique.
 */
export function authoritativeLiveOwners(entries: Iterable<LiveOverlayEntry>): Map<string, LiveOverlayEntry> {
  const owners = new Map<string, LiveOverlayEntry>();
  for (const entry of entries) {
    const sessionKey = `${entry.info.tool}:${entry.info.id}`;
    const held = owners.get(sessionKey);
    if (!held || outranks(entry, held)) owners.set(sessionKey, entry);
  }
  return owners;
}

function outranks(candidate: LiveOverlayEntry, held: LiveOverlayEntry): boolean {
  const byControl = controlPriority(candidate.info) - controlPriority(held.info);
  if (byControl !== 0) return byControl > 0;
  const byRecency = (candidate.info.updatedAt ?? 0) - (held.info.updatedAt ?? 0);
  if (byRecency !== 0) return byRecency > 0;
  return candidate.key < held.key;
}

/**
 * Apply ONE authoritative live owner onto an inferred (disk-discovered or adapter-watcher) snapshot
 * of the same session, in place. This is the single qualification rule for every roster publication
 * of a session the broker currently owns; discovery reconcile and the watcher publication boundary
 * must use it identically or the two paths would journal different rows for the same state.
 *
 * - Control surface: never let the live owner weaken a stronger control claim the snapshot already
 *   carries — owner control/attach/current* fields apply only at equal-or-higher
 *   {@link controlPriority}.
 * - Run state: has exactly ONE authority — the live owned connection, which observes the turn
 *   boundary itself. A scan only INFERS activity, so an inferred snapshot contributes NO run state
 *   at all — not Working, not Idle, and not needs-input; adopting an inferred needs-input is the
 *   same Idle↔Working-class reversal R0b/R0c.1 exist to prevent, just against a different state.
 *   Real permission/question frames on the owned connection are the route to exact Needs input.
 */
export function overlayAuthoritativeOwner(target: SessionInfo, owner: LiveOverlayEntry): void {
  if (controlPriority(owner.info) >= controlPriority(target)) {
    target.attachMode = owner.info.attachMode;
    if (owner.info.control) target.control = owner.info.control;
    if (owner.info.currentModel) target.currentModel = owner.info.currentModel;
    if (owner.info.currentAgent) target.currentAgent = owner.info.currentAgent;
    if (owner.info.currentMode) target.currentMode = owner.info.currentMode;
    if (owner.info.terminalSyncHint) target.terminalSyncHint = owner.info.terminalSyncHint;
  }
  target.status = owner.status;
}
