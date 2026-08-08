/**
 * Codex exact-evidence run-state repair (R0c.4).
 *
 * The owner's run state is edge-triggered: turn notifications plus one attach seed. A missed edge
 * used to be permanent because every other source is deliberately subordinate. These are the pure
 * rules that let EXACT native evidence — and only exact native evidence — correct a definite latched
 * state. Nothing here reads a clock, a file, or a process; recency is not evidence.
 */

/** What one `thread/read` (or `thread/turns/list`) result says about this thread's turns. */
export interface CodexNativeRunEvidence {
  /** `thread.status.type` verbatim, trimmed. Empty when the runtime reported none. */
  statusType: string;
  /** Newest turn the runtime reports as still in progress. */
  activeTurnId?: string;
  /** Turn ids the runtime reports as terminal (completed/failed/aborted/cancelled) in this read. */
  terminalTurnIds: Set<string>;
}

const IN_PROGRESS = new Set(['running', 'active', 'in_progress', 'inprogress']);
const TERMINAL = new Set([
  'completed', 'complete', 'failed', 'error', 'aborted', 'cancelled', 'canceled', 'interrupted',
]);

function turnStartedAt(turn: any): number {
  const raw = turn?.startedAt ?? turn?.started_at ?? turn?.createdAt ?? turn?.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Fold a native turns payload into exact run evidence. Unrecognized turn states contribute
 *  NOTHING: an unknown vocabulary must read as "no evidence", never as a terminal. */
export function readCodexNativeRunEvidence(read: any): CodexNativeRunEvidence {
  const turns: any[] = [
    ...(Array.isArray(read?.thread?.turns) ? read.thread.turns : []),
    ...(Array.isArray(read?.turns) ? read.turns : []),
    ...(Array.isArray(read?.data) ? read.data : []),
    ...(Array.isArray(read?.initialTurnsPage?.data) ? read.initialTurnsPage.data : []),
  ];
  const terminalTurnIds = new Set<string>();
  let newest: { id: string; startedAt: number } | undefined;
  for (const turn of turns) {
    const id = turn?.id == null ? '' : String(turn.id);
    if (!id) continue;
    const status = String(turn?.status ?? '').toLowerCase();
    if (IN_PROGRESS.has(status) || status.includes('progress')) {
      const startedAt = turnStartedAt(turn);
      if (!newest || startedAt >= newest.startedAt) newest = { id, startedAt };
    } else if (TERMINAL.has(status)) {
      terminalTurnIds.add(id);
    }
  }
  return {
    statusType: String(read?.thread?.status?.type ?? read?.status?.type ?? '').trim(),
    ...(newest ? { activeTurnId: newest.id } : {}),
    terminalTurnIds,
  };
}

export type CodexRunStateRepair =
  | { kind: 'none' }
  | { kind: 'running'; turnId: string }
  | { kind: 'idle' };

/**
 * Decide what exact native evidence may do to the owner's current run state.
 *
 * Admission is generous and retirement is strict, which is the asymmetry the whole R0c series
 * encodes: an in-progress turn id is proof a turn exists, while "the runtime is not active right
 * now" is only proof that THIS turn ended if the turn itself is accounted for. `hasMatchingTerminal`
 * lets the caller add the connection's own recorded completions to the read's terminal set, so a
 * completion delivered as a notification still counts as the matching terminal.
 */
export function decideCodexRunStateRepair(
  current: { kind: 'active'; turnId?: string } | { kind: 'idle' | 'unknown' | 'hydrating' },
  evidence: CodexNativeRunEvidence,
  hasMatchingTerminal: (turnId: string) => boolean,
): CodexRunStateRepair {
  if (evidence.activeTurnId) {
    // Re-pointing an active state at a DIFFERENT in-progress turn is also a repair: the latched id
    // is the fence every terminal is matched against, so a wrong one cannot retire correctly.
    if (current.kind === 'active' && current.turnId === evidence.activeTurnId) return { kind: 'none' };
    return { kind: 'running', turnId: evidence.activeTurnId };
  }
  // No in-progress turn. Only an EXACT non-active thread status is idle evidence; a missing or
  // still-active status with no turn listed is ambiguous and settles nothing.
  if (!evidence.statusType || evidence.statusType === 'active') return { kind: 'none' };
  if (current.kind === 'idle') return { kind: 'none' };
  if (current.kind === 'active') {
    const admitted = current.turnId;
    if (!admitted) return { kind: 'idle' };
    const matched = evidence.terminalTurnIds.has(admitted) || hasMatchingTerminal(admitted);
    return matched ? { kind: 'idle' } : { kind: 'none' };
  }
  return { kind: 'idle' };
}

export type CodexObservedRunState = 'working' | 'needs-input' | 'idle';

export interface CodexObserveEvidence {
  /** What `qualifyCodexRolloutStatus` returns for the EXACT rollout status under a FRESH
   *  qualification context. Reusing that one function is deliberate: an Observe owner's repaired
   *  state must be identical to what discovery would publish for the same row, and the ownership
   *  rules (native activity outranks; a loaded thread holds; presence decides the tail) already
   *  live there and are already regression-covered. */
  qualified: CodexObservedRunState;
  /** The durable rollout's EXACT authority, plus the identity of the bytes it answered about.
   *  Undefined when the scan produced a typed bounded fallback or could not read the source — a
   *  catch-up state is not evidence, which is the distinction R0c.1 turns on. */
  rollout?: { openTurn: boolean; identity: string };
  /** Source identity recorded at the previous owner-absent observation, if any. */
  heldIdentity?: string;
}

export interface CodexObserveRunDecision {
  /** The state to adopt, or undefined to leave the owner alone this round. */
  next?: CodexObservedRunState;
  /** Source identity to carry into the next round; undefined clears the hold. */
  heldIdentity?: string;
}

/**
 * Repair target for a read-only Observe owner, which has no turn-notification channel.
 *
 * An exact open turn in the rollout retires on exactly two grounds:
 *
 *   (a) the rollout itself accounts for it — the authority reports no unmatched start, i.e. a
 *       matching terminal was written; or
 *   (b) corroborated absence of EVERY possible owner. `qualified` is what carries this: the
 *       qualifier returns Idle for an open turn only when the daemon is not an owner (not loaded,
 *       or loaded and exactly idle) AND terminal presence is `absent`. Every class that could be an
 *       owner — presence `shared`, `private`, or `unprovable`/`unknown`, a failed probe, a loaded
 *       thread, an in-flight or unknown activity — yields Working there and holds.
 *
 * The byte-identity hold is an ADDITIONAL gate on (b) only, never a substitute for it: a turn that
 * is actively appending has a moving identity, so the corroboration resets and a live turn cannot
 * be retired by repetition. It is not applied to (a), which is exact terminal evidence.
 *
 * Why the quiet-tool class is closed: a long command or a subagent can append nothing for many
 * intervals, but it still HAS an owner — the TUI shows in presence, or the daemon reports working —
 * so (b) never fires and the turn stays Working however long the bytes are frozen. Frozen bytes
 * alone were never the signal, and the previous round was wrong to treat them as one.
 *
 * Why R0c.3's dead-turn class stays closed: a turn whose TUI was killed has NO owner — presence is
 * `absent` and the daemon does not hold the thread — so (b) fires and it retires within two rounds.
 *
 * Nothing here reads a clock or an elapsed time.
 */
export function decideCodexObserveRunState(evidence: CodexObserveEvidence): CodexObserveRunDecision {
  const { qualified, rollout, heldIdentity } = evidence;
  // No exact rollout authority: this round has no admissible durable evidence at all.
  if (!rollout) return { heldIdentity };
  if (qualified !== 'idle') return { next: qualified };
  // (a) the rollout accounts for the turn — exact terminal evidence, no corroboration needed.
  if (!rollout.openTurn) return { next: 'idle' };
  // (b) an open turn with no possible owner, corroborated over bytes that did not move.
  if (heldIdentity !== undefined && heldIdentity === rollout.identity) return { next: 'idle' };
  return { heldIdentity: rollout.identity };
}

/**
 * Could this cached qualification context DEMOTE a freshly-observed open turn?
 *
 * The seed's inputs are captured at different instants — stat-cached rollout facts, a ≤5s activity
 * cache, and a point-in-time presence scan — and every one of them can predate a start marker the
 * baseline scan reads moments later. Each named value below is a demoting input in
 * `qualifyCodexRolloutStatus`; when any is present alongside fresh Working evidence, the whole
 * context is superseded and must be re-taken at one instant rather than patched field by field.
 */
export function codexSeedContextCouldDemote(context: {
  nativeActivity?: string;
  parentNativeActivity?: string;
  terminalPresence?: string;
  parentTerminalPresence?: string;
}): boolean {
  return context.nativeActivity === 'idle'
    || context.parentNativeActivity === 'idle'
    || context.terminalPresence === 'absent'
    || context.parentTerminalPresence === 'absent';
}

/** The subset of a stat result the baseline fence reads. */
export interface CodexSourceStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Inode-change time. Unlike mtime it cannot be set from userland (`utimes` restores mtime but
   *  BUMPS ctime), so it is what catches a same-size rewrite that also restores the mtime. */
  ctimeMs: number;
}

/**
 * Did the bytes a baseline scan just read still describe the source this PATH names?
 *
 * R0c.4 promoted that scan to run-state authority, so this has to be answerable. An fstat on the
 * open descriptor cannot answer it: after an atomic rename the descriptor still refers to the old,
 * now-unlinked inode, so comparing the fd against itself can never fire for the replacement case it
 * was written to catch. Identity is therefore checked on the PATH — what the next reader opens.
 *
 * `onPath` undefined means the path no longer resolves at all (unlinked, or the directory replaced).
 *
 * Growth is legitimate: an append leaves the scanned prefix intact and the tail continues from the
 * recorded boundary. A shrink is truncation. For an unchanged size, ANY inode modification is a
 * rewrite: mtime catches the ordinary case, and ctime catches a rewrite that restores the mtime —
 * `utimes` can put mtime back but every such call bumps ctime, which userland cannot rewind.
 *
 * Residual, deliberately not guessed at here: a rewrite that also GROWS is indistinguishable from an
 * append by stat metadata alone. The rollout authority cache's sampled-prefix validation is the
 * mechanism that catches that one, and it runs on the status path independently.
 */
export function codexBaselineSourceIntact(
  before: CodexSourceStat,
  after: CodexSourceStat,
  onPath: CodexSourceStat | undefined,
  scannedSize: number,
): boolean {
  if (!onPath) return false;
  if (onPath.dev !== after.dev || onPath.ino !== after.ino) return false;
  if (after.size < scannedSize) return false;
  if (
    after.size === scannedSize
    && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
  ) return false;
  return true;
}

/**
 * Does a `turn/started` bearing a recently-completed turn id open a NEW turn, or replay an old one?
 *
 * The replay guard exists because the daemon can redeliver a start after its completion (reconnect,
 * bootstrap flush, out-of-order batch), and admitting that would resurrect a finished turn. But the
 * guard is unconditional on the id alone, so a runtime that genuinely reuses an id would have its
 * real turn swallowed. The runtime's own timestamps settle it: a start that began AFTER the
 * completion this connection recorded cannot be that completion's start. Missing or equal
 * timestamps prove nothing and stay on the safe side — replay.
 */
export function codexTurnStartGeneration(
  startedAtMs: number | undefined,
  completedAtMs: number | undefined,
): 'replay' | 'new-generation' {
  if (startedAtMs === undefined || completedAtMs === undefined) return 'replay';
  return startedAtMs > completedAtMs ? 'new-generation' : 'replay';
}
