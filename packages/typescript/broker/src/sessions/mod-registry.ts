/**
 * Who is driving what: the broker-side registry of Claude sessions that have a mod.
 *
 * One row per Claude session id. A row is the answer to three questions the rest of the
 * product asks continuously, and it is the only place that answers them:
 *
 * - *Is this session syncable?* `live` requires a fresh poll chain, a peer process we can
 *   still prove is the same process, and an interactive terminal. Anything short of that is
 *   `observe`, which is the fail-open shape: the row still mirrors, and Take over still works.
 * - *Is anyone listening?* freshness is `now - lastPollAt > 3 * 20 s`, evaluated when
 *   something asks. There is deliberately no heartbeat timer: the poll chain *is* the
 *   heartbeat, and a second timer is a second source of truth that can disagree with it.
 * - *May the app write?* a bounded FIFO per session, drained by the mod's own long-poll, and
 *   never drained into a session that cannot serve it.
 *
 * Two rules here are load-bearing rather than tidy:
 *
 * - A second `register` for the same session id **replaces** the row. That is a restart, not
 *   a duplicate, and the case that produces it constantly is `/clear` followed by
 *   re-registration with a new id plus `claude --resume <id>` with the same one.
 * - A pid that has been recycled reads **dead**, not alive-as-somebody-else. `kill -0` alone
 *   would keep a dead session's Drive button lit until its pid was reused, which is exactly
 *   the kind of lie that ends with a prompt going to a stranger's process.
 */

import { processIsSameLiveProcess, processStartTime } from '../security/process-liveness.ts';
import {
  MAX_POLL_WAIT_MS,
  STALE_AFTER_MS,
  modWireId,
  validateModCommand,
  type ModCommand,
  type ModRegisterMessage,
} from './mod-protocol.ts';

export type ModRowState = 'live' | 'observe';

export interface ModRegistration {
  sessionId: string;
  /** Kernel-reported peer credential. The pid watch and the uid check both hang off this. */
  peerPid: number;
  peerUid: number;
  /** Start time captured at registration, so a recycled pid can be recognised as one. */
  peerPidStart?: string;
  /** False when the mod's own pid guess disagreed with the kernel's. Logged, never decisive. */
  peerPidAgrees: boolean;
  cwd: string;
  claudeVersion: string;
  model?: string;
  isInteractive: boolean;
  surface: string;
  state: ModRowState;
  registeredAt: number;
  lastPollAt: number;
  /**
   * Which registration this row is. Incremented every time the session re-registers.
   *
   * A hold belongs to a call inside one process. After a `kill -9` and a `claude --resume` with
   * the same session id, the new process numbers its first hold `cm-1` again, and a store keyed
   * only on session plus request id would hand it the previous process's card -- where an Allow
   * would then decide a call the user never saw. The generation makes that key collide never.
   */
  generation: number;
  /**
   * The turn the mod last said was running, cleared by that turn's `turn.complete`.
   *
   * The app has no way to know which turn a terminal is on, so a Stop that arrives with no id
   * is answered with this and nothing else. An empty value means no turn, which is refused as
   * `no_active_turn`: stopping "whatever happens to be current" would interrupt a turn the user
   * never meant to touch, and a stale id here is exactly as bad, which is why the mod reports
   * both boundaries rather than just the start.
   */
  currentTurnId: string;
  /** True once this row's dead-pid attention event has been raised. One per session, not per poll. */
  attentionRaised: boolean;
  /**
   * True once the app followed this session: a viewer that could answer, a held call, or a command
   * delivered to it. Only a followed terminal's death is worth an inbox item; a `claude -p` script or
   * a terminal nobody opened in the app ends without one.
   */
  followed: boolean;
  /** Which evaluation of the mod module registered this row. See `ModRegisterMessage.instance`. */
  instance?: string;
}

/** Why a row is not `live`, so the roster can say why instead of going quiet. */
export type ModIneligibleReason = 'stale' | 'pid-dead' | 'not-interactive' | 'not-terminal';

export interface ModRowStatus {
  present: boolean;
  state: ModRowState | 'none';
  fresh: boolean;
  pidAlive: boolean;
  reasons: ModIneligibleReason[];
  registration?: ModRegistration;
}

/** A turn event that can kill a hold. `user-cancel` and `turn.complete` are the measured ones. */
export interface ModTurnEvent {
  kind: string;
  sessionId: string;
  requestId?: string;
  detail?: Record<string, unknown>;
}

export interface ModRegistryOptions {
  /** Injected clock so the suite can move time without sleeping. */
  now?: () => number;
  /** Injected liveness probe, so pid recycling is testable without recycling a pid. */
  liveness?: (pid: number, expectedStart?: string) => { alive: boolean; identityKnown: boolean; reason?: string };
  /** Injected start-time reader, used at registration. */
  startTime?: (pid: number) => string | undefined;
  /** Commands parked per session before the queue answers `queue_full`. */
  maxQueued?: number;
  /** How long a queued command may wait before it is dropped instead of delivered. */
  commandTtlMs?: number;
  /** How long a question answer may wait. Shorter than a prompt: an answer to a stale card is wrong. */
  answerTtlMs?: number;
  staleAfterMs?: number;
}

interface QueueEntry {
  command: ModCommand;
  /** The hold a queued `answer` belongs to, so it can be cancelled when that hold dies. */
  holdId?: string;
}

const DEFAULT_MAX_QUEUED = 8;
const DEFAULT_COMMAND_TTL_MS = 120_000;
const DEFAULT_ANSWER_TTL_MS = 60_000;

export class ModRegistry {
  private readonly rows = new Map<string, ModRegistration>();
  /** Per-session registration counter, kept out of the row so a replacement cannot reset it. */
  private readonly generations = new Map<string, number>();
  private readonly queues = new Map<string, QueueEntry[]>();
  /** Holds currently open per session, so a turn event can find the hold it invalidates. */
  private readonly openHolds = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly liveness: (pid: number, expectedStart?: string) => { alive: boolean; identityKnown: boolean; reason?: string };
  private readonly startTime: (pid: number) => string | undefined;
  private readonly maxQueued: number;
  private readonly commandTtlMs: number;
  private readonly answerTtlMs: number;
  private readonly staleAfterMs: number;

  constructor(options: ModRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.liveness = options.liveness ?? ((pid, expectedStart) => processIsSameLiveProcess(pid, expectedStart));
    this.startTime = options.startTime ?? ((pid) => processStartTime(pid));
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.commandTtlMs = options.commandTtlMs ?? DEFAULT_COMMAND_TTL_MS;
    this.answerTtlMs = options.answerTtlMs ?? DEFAULT_ANSWER_TTL_MS;
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  }

  /**
   * Record or replace a registration.
   *
   * Queued commands survive a replace, because a restart of the same session id is the
   * `--resume` case and a prompt typed while Claude was restarting is still meant for it.
   * Open holds do not survive: a hold belongs to a call in the process that died.
   */
  /**
   * May this peer take the session?
   *
   * `free` means nobody holds it. `claimed` means a live process does, and it is not this one:
   * the second terminal stays Observe, draws nothing and holds nothing, and keeps retrying on
   * its normal poll cadence. `takeover` means the claim has lapsed -- the claimant's process is
   * gone by pid plus start time, or its poll chain has gone stale (three missed 20 s polls) -- so
   * the row is up for grabs, and whatever holds it left behind die with it. A stale claimant is a
   * terminal nobody is driving: a hung process, or one whose mod stopped, and keeping its claim
   * would keep every other terminal on that session in Observe for as long as it stays hung.
   *
   * The first claimant keeping the claim is an owner decision, and it is deliberate: "newest
   * wins" made a stray `claude --resume` steal a session from the terminal the user is typing
   * into, and the stolen one kept drawing a band for holds nobody would ever answer.
   */
  claimState(sessionId: string, peerPid: number): 'free' | 'claimed' | 'takeover' {
    const previous = this.rows.get(sessionId);
    if (!previous) return 'free';
    if (previous.peerPid === peerPid) return 'takeover';
    return this.pidAlive(previous) && this.isFresh(previous) ? 'claimed' : 'takeover';
  }

  register(message: ModRegisterMessage, peer: { pid: number; uid: number; start?: string }): ModRegistration {
    const previous = this.rows.get(message.sessionId);
    const generation = (this.generations.get(message.sessionId) ?? 0) + 1;
    this.generations.set(message.sessionId, generation);
    const start = peer.start ?? this.startTime(peer.pid);
    const row: ModRegistration = {
      sessionId: message.sessionId,
      peerPid: peer.pid,
      peerUid: peer.uid,
      ...(start ? { peerPidStart: start } : {}),
      peerPidAgrees: message.reportedPid === undefined ? true : message.reportedPid === peer.pid,
      cwd: message.cwd,
      claudeVersion: message.claudeVersion,
      ...(message.model ? { model: message.model } : {}),
      isInteractive: message.isInteractive,
      surface: message.surface,
      state: 'live',
      registeredAt: this.now(),
      lastPollAt: this.now(),
      generation,
      // Never carried over from the old row: a new process is a new turn sequence, and inheriting
      // the dead one's turn id is how a Stop comes to name a turn that no longer exists. What the
      // registering mod says is running is a different fact, and it is the one that counts.
      currentTurnId: message.turnId ?? '',
      attentionRaised: previous?.attentionRaised ?? false,
      // The same session registering again -- a reload, a resume -- is still the session the app was
      // following.
      followed: previous?.followed ?? false,
      ...(message.instance ? { instance: message.instance } : {}),
    };
    this.rows.set(message.sessionId, row);
    if (previous && previous.peerPid !== peer.pid) this.dropHolds(message.sessionId);
    return row;
  }

  /**
   * Deregister on `session.end`. The row goes; queued commands go with it.
   *
   * The generation counter stays. A session that ends and comes back is a new registration, and
   * reusing a generation is how a hold from the dead one gets read as the new one's.
   */
  deregister(sessionId: string): boolean {
    const existed = this.rows.delete(sessionId);
    this.queues.delete(sessionId);
    this.openHolds.delete(sessionId);
    return existed;
  }

  get(sessionId: string): ModRegistration | undefined {
    return this.rows.get(sessionId);
  }

  /**
   * The generation holds are filed under for this session.
   *
   * Read from the counter and not from the row, because the row is exactly what is missing in the
   * case that matters: a `session.end`, a stale eviction or a dead pid tears the row down, and the
   * holds it leaves behind still have to be found in order to be closed. Asking the row would
   * answer 0, and the close would quietly miss.
   */
  generation(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  list(): ModRegistration[] {
    return [...this.rows.values()];
  }

  /** The poll chain is the heartbeat. Every poll refreshes freshness and recomputes `state`. */
  notePoll(sessionId: string): ModRegistration | undefined {
    const row = this.rows.get(sessionId);
    if (!row) return undefined;
    row.lastPollAt = this.now();
    row.state = this.status(sessionId).state === 'live' ? 'live' : 'observe';
    return row;
  }

  isFresh(row: ModRegistration): boolean {
    return this.now() - row.lastPollAt <= this.staleAfterMs;
  }

  /** The kernel start time of `pid`, as this registry reads it, or undefined when it cannot be read. */
  readStartTime(pid: number): string | undefined {
    try {
      return this.startTime(pid);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `pid` is the process this row was registered for: the same pid, started at the same
   * time. A row with no start time on record, or a pid whose start time cannot be read now, is not
   * proof of anything, and answers no.
   */
  isRegisteredProcess(row: ModRegistration, pid: number): boolean {
    if (row.peerPid !== pid || !row.peerPidStart) return false;
    return this.readStartTime(pid) === row.peerPidStart;
  }

  pidAlive(row: ModRegistration): boolean {
    return this.liveness(row.peerPid, row.peerPidStart).alive;
  }

  /** Full verdict plus reasons, which is what the roster and the tests both want. */
  status(sessionId: string): ModRowStatus {
    const row = this.rows.get(sessionId);
    if (!row) return { present: false, state: 'none', fresh: false, pidAlive: false, reasons: [] };
    const reasons: ModIneligibleReason[] = [];
    const fresh = this.isFresh(row);
    const alive = this.pidAlive(row);
    if (!fresh) reasons.push('stale');
    if (!alive) reasons.push('pid-dead');
    if (!row.isInteractive) reasons.push('not-interactive');
    if (row.surface !== 'terminal') reasons.push('not-terminal');
    const state: ModRowState = reasons.length === 0 ? 'live' : 'observe';
    return { present: true, state, fresh, pidAlive: alive, reasons, registration: row };
  }

  /** True the first time a session's pid stops being provable, so the app raises one event. */
  takeAttentionEvent(row: ModRegistration): boolean {
    if (row.attentionRaised) return false;
    row.attentionRaised = true;
    return true;
  }

  /** The app is following this session. See `ModRegistration.followed`. */
  noteFollowed(sessionId: string): void {
    const row = this.rows.get(sessionId);
    if (row) row.followed = true;
  }

  /** Freshness, not an invented default: a stale or dead row never answers `live`. */
  isLive(sessionId: string): boolean {
    return this.status(sessionId).state === 'live';
  }

  // ── Command queue ──

  /**
   * Queue a command for delivery on the mod's next poll.
   *
   * The command is validated *before* anything is queued and before anything is consumed,
   * because the phase-0 stub consumed a line and then failed to parse it, which surfaced as
   * "the mod stopped polling" and cost a probe cycle to diagnose.
   */
  enqueue(sessionId: string, command: ModCommand, holdId?: string): {
    ok: true;
    /** The command as queued, with the turn id stamped onto an abort. */
    command: ModCommand;
  } | {
    ok: false;
    code: 'no_registration' | 'invalid_command' | 'command_too_large' | 'queue_full' | 'stale_registration' | 'no_active_turn';
  } {
    const validation = validateModCommand(command);
    if (!validation.ok) {
      // `command_too_large` is kept distinct from `invalid_command`, because one of them is
      // something the person can act on -- send less text -- and the other is a bug in whatever
      // built the command.
      return { ok: false, code: validation.failure.code === 'command_too_large' ? 'command_too_large' : 'invalid_command' };
    }
    const row = this.rows.get(sessionId);
    if (!row) return { ok: false, code: 'no_registration' };
    // A row whose poll chain stopped, or whose process is gone, cannot receive anything. It used
    // to accept the command and drop it at the 120 s TTL, so the app reported success and the
    // user's words disappeared. Refusing here is what lets the connection say so out loud.
    if (!this.isFresh(row) || !this.pidAlive(row)) return { ok: false, code: 'stale_registration' };
    // The turn id is stamped here, at the only moment the broker knows both the session and what
    // it is running, and before the command can be reordered behind anything else in the queue.
    if (command.op === 'abort' && !command.turnId) {
      if (!row.currentTurnId) return { ok: false, code: 'no_active_turn' };
      command = { ...command, turnId: row.currentTurnId };
    }
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length >= this.maxQueued) return { ok: false, code: 'queue_full' };
    queue.push({ command, ...(holdId ? { holdId } : {}) });
    this.queues.set(sessionId, queue);
    return { ok: true, command };
  }

  /**
   * Put an undelivered command back at the HEAD of the queue.
   *
   * Only one caller has ever needed it: a `poll` response whose bytes never left this process.
   * The command keeps its original `queuedAt`, so the queue's own age limit decides when it stops
   * being worth delivering, and it goes in front of anything queued after it, because it was
   * already the next thing to run.
   */
  requeue(sessionId: string, command: ModCommand): boolean {
    const queue = this.queues.get(sessionId) ?? [];
    // Once per request id, whatever else happens. A command the mod DID receive and then answered
    // is not this command any more, and a duplicate prompt is the agent running the same words twice.
    if (queue.some((entry) => entry.command.requestId === command.requestId)) return false;
    if (queue.length >= this.maxQueued) return false;
    queue.unshift({ command });
    this.queues.set(sessionId, queue);
    return true;
  }

  /**
   * Next deliverable command, or none. Expired entries are dropped rather than delivered:
   * an answer to a card the user has already dismissed is worse than no answer.
   */
  dequeue(sessionId: string): ModCommand | undefined {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const now = this.now();
    while (queue.length > 0) {
      const entry = queue[0]!;
      const ttl = entry.command.op === 'answer' ? this.answerTtlMs : this.commandTtlMs;
      if (now - entry.command.queuedAt > ttl) {
        queue.shift();
        continue;
      }
      queue.shift();
      if (queue.length === 0) this.queues.delete(sessionId);
      this.noteFollowed(sessionId);
      return entry.command;
    }
    this.queues.delete(sessionId);
    return undefined;
  }

  /** Drop a queued answer when its hold resolved in another seat (band, expiry, cancel). */
  cancelQueuedAnswer(sessionId: string, requestId: string): boolean {
    const queue = this.queues.get(sessionId);
    if (!queue) return false;
    const before = queue.length;
    const kept = queue.filter((entry) => !(entry.command.op === 'answer' && entry.command.requestId === requestId));
    if (kept.length === before) return false;
    if (kept.length === 0) this.queues.delete(sessionId);
    else this.queues.set(sessionId, kept);
    return true;
  }

  queuedCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  // ── Holds and the turn events that kill them ──

  openHold(sessionId: string, requestId: string): void {
    const set = this.openHolds.get(sessionId) ?? new Set<string>();
    set.add(requestId);
    this.openHolds.set(sessionId, set);
    this.noteFollowed(sessionId);
  }

  closeHold(sessionId: string, requestId: string): void {
    const set = this.openHolds.get(sessionId);
    if (set) {
      set.delete(requestId);
      if (set.size === 0) this.openHolds.delete(sessionId);
    }
  }

  hasOpenHold(sessionId: string, requestId: string): boolean {
    return this.openHolds.get(sessionId)?.has(requestId) === true;
  }

  openHoldIds(sessionId: string): string[] {
    return [...(this.openHolds.get(sessionId) ?? [])];
  }

  private dropHolds(sessionId: string): void {
    const open = this.openHolds.get(sessionId);
    if (!open) return;
    for (const requestId of open) this.cancelQueuedAnswer(sessionId, requestId);
    this.openHolds.delete(sessionId);
  }

  /** The turn this session's mod says is running, or ''. */
  currentTurn(sessionId: string): string {
    return this.rows.get(sessionId)?.currentTurnId ?? '';
  }

  /**
   * Apply a turn event, returning the open holds it invalidates.
   *
   * `turn.complete` closes every hold for the session: a hold that outlived its turn decides
   * the *next* call, which is the failure spec rule 3 exists to prevent. `user-cancel` closes
   * the one call the human escaped, and a `session.end` closes everything.
   */
  noteTurnEvent(event: ModTurnEvent): { resolved: string[]; deregister: boolean } {
    const row = this.rows.get(event.sessionId);
    if (row && event.kind === 'turn.start') {
      // A turn id is what a Stop is aimed at, so it is held to the shape every other id has.
      const turnId = modWireId(event.detail?.turnId);
      if (turnId) row.currentTurnId = turnId;
    } else if (row && event.kind === 'turn.complete') {
      // A child's turn is not the main loop's, and the mod is told to say nothing about it. The
      // check here is the belt: an older mod that reports one must not clear the parent's turn.
      if (typeof event.detail?.agentId === 'string' && event.detail.agentId.length > 0) {
        return { resolved: [], deregister: false };
      }
      row.currentTurnId = '';
    }
    if (event.kind === 'session.end') {
      const resolved = this.openHoldIds(event.sessionId);
      this.deregister(event.sessionId);
      return { resolved, deregister: true };
    }
    if (event.kind === 'turn.complete') {
      const resolved = this.openHoldIds(event.sessionId);
      this.dropHolds(event.sessionId);
      return { resolved, deregister: false };
    }
    if (event.kind === 'user-cancel' || (event.kind === 'turn.interrupted' && event.requestId)) {
      if (!event.requestId) return { resolved: [], deregister: false };
      const resolved = this.hasOpenHold(event.sessionId, event.requestId) ? [event.requestId] : [];
      if (resolved.length > 0) {
        this.closeHold(event.sessionId, event.requestId);
        this.cancelQueuedAnswer(event.sessionId, event.requestId);
      }
      return { resolved, deregister: false };
    }
    return { resolved: [], deregister: false };
  }
}

/** A poll interval the mod may not exceed, exported so the suite can name it. */
export const MOD_POLL_INTERVAL_MS = MAX_POLL_WAIT_MS;
