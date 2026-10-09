/**
 * The Claude true-sync service: the one object the runtime starts, stops and routes into.
 *
 * Everything M2 built lives behind this door. The socket server, the registry and the hold
 * store each own one narrow thing; this module owns the wiring between them and the rest of
 * the broker, which is the part that would otherwise end up written twice in a 7,900-line
 * `runtime.ts`:
 *
 * - **Gate inputs.** A hold is decided from three facts the broker owns and the mod cannot
 *   see: the session's permission mode from the transcript, the live viewer count from the Hub,
 *   and cosyncing's own kill switch from its config. They are gathered at the moment the `hold`
 *   arrives, never stamped on a poll response.
 * - **The app card.** A held call publishes a permission card into the session's Hub
 *   connection, reusing the same `ingestRequest`/`respondPermission` path the hooks overlay
 *   already proved out, so an approval card is one shape the client already renders.
 * - **The refusal to overreach.** A tap means "yes, this call". It does not mean "always" or
 *   "write a rule": `approve-session` and `approve-rule` are refused rather than silently
 *   downgraded, because Claude's own dialog offers those and the app must not look like it
 *   supports them through a channel that cannot honour them.
 *
 * The listener never starts on native Windows, and a socket that cannot be created is a
 * logged degradation rather than a broker failure: no true sync means Observe plus Take over,
 * which is the product's fail-open shape.
 */

import { claudeSessionId, claudeTranscriptPath, readLatestPermissionMode, type ClaudeModCardNote } from '@cosyncing/adapter-claude';
import { ModAuditStore, type ModAuditRow } from './mod-audit.ts';
import { ModHoldStore, type ModHoldRecord } from './mod-holds.ts';
import { ModRegistry, type ModRowStatus } from './mod-registry.ts';
import { ModSocketServer, modSocketPath, type ModSocketEvent } from './mod-socket-server.ts';
import type {
  PermissionDecidedBy,
  PermissionModeName,
  PermissionReleaseReason,
} from '@cosyncing/protocol';
import {
  UNCARDED_RELEASE_REASONS,
  modAnswerMap,
  modAnswerRows,
  modQuestionViews,
  type ModDecisionSource,
} from './mod-protocol.ts';
import type { ModHoldOutcome } from './mod-holds.ts';
import { setupStateHome } from '../installation/setup-state.ts';
import type { ModCommand, ModHoldMessage } from './mod-protocol.ts';

/** The session's Hub connection, as far as this service needs it. */
export interface ModHubConnection {
  clientCount: number;
  ingestRequest?: (request: {
    requestId: string;
    kind: 'permission' | 'question';
    toolName?: string;
    title?: string;
    detail?: string;
    toolInput?: unknown;
    questions?: unknown;
    /** The mode the gate read, carried so the card can name it. Not a display string: the
     *  client localizes it. */
    permissionMode?: PermissionModeName;
    /** Set on the card raised for a call this broker did NOT answer. It carries no buttons
     *  precisely because there is nothing left to answer. */
    readOnly?: boolean;
    /** Why the call fell through to the terminal, on the read-only card. */
    releaseReason?: PermissionReleaseReason;
    /** What is being approved: command, path or URL, bounded. Data, not prose. */
    inputPreview?: string;
    /** False on a card that explains rather than waits, so the Hub does not read the session as
     *  blocked on it. See the contract's `permission-request.blocking`. */
    blocking?: boolean;
    /** On a question card: open in the terminal and answerable only there. Drawn read-only. */
    answerInTerminal?: boolean;
    /** Replace the card already drawn under this id instead of leaving it. Only ever sent with
     *  `readOnly`: a restatement takes a card's controls away, it never gives them back. */
    restate?: boolean;
  }) => void;
  respondPermission?: (
    requestId: string,
    decision: 'approve' | 'approve-session' | 'approve-rule' | 'reject' | 'external',
    info?: { decidedBy?: PermissionDecidedBy; releaseReason?: PermissionReleaseReason },
  ) => Promise<void> | void;
  /** `info` says who settled it, as on a permission: every seat, and a reload, can then say so. */
  answerQuestion?: (requestId: string, answers: string[][], info?: ModSettledBy) => Promise<void> | void;
  rejectQuestion?: (requestId: string, info?: ModSettledBy) => Promise<void> | void;
  /** Tell the seat which registration the holds belong to, so it forgets the last one's card ids. */
  noteModGeneration?: (generation: number) => void;
  /** Surface one line the terminal has to say for itself, in the seat that is watching. Used for
   *  a command the mod took and then could not carry out, which the app cannot learn any other
   *  way: the send succeeded, and the refusal happened a poll later in a different process. */
  noteModNotice?: (message: string) => void;
  /**
   * The terminal's main turn has ended, as the mod reported it. `aborted` says this broker stopped
   * that turn. The connection settles the turn's run state from it, because a Stop sent through the
   * mod leaves no interruption row in the transcript to settle it from. `endedAt` is set when the end
   * is the mod's memory of an earlier one, said as it registered: only a run that started before it
   * is settled.
   */
  noteModTurnEnded?: (ended: { turnId: string; aborted: boolean; endedAt?: number }) => void;
}

/** Who closed a card, as the broker can say it. Absent fields are things it cannot say. */
export interface ModSettledBy {
  decidedBy?: PermissionDecidedBy;
  releaseReason?: PermissionReleaseReason;
}

/**
 * A Claude row as this service needs to see it: who is watching, and what to draw on.
 *
 * The connection travels as `unknown` deliberately. The Hub hands out any `SessionConnection`,
 * and every member this service touches is probed at the point of use, so the honest type is
 * "whatever the adapter actually gave us" rather than a cast that pretends a driven Claude row
 * and a hooks row are the same class.
 */
export interface ModHubRow {
  clientCount: number;
  conn?: unknown;
}

export interface ClaudeModServiceOptions {
  /** State directory. Defaults to `COSYNCING_HOME ?? ~/.cosyncing`, the same rule the mod uses. */
  stateHome?: string;
  /** Explicit socket path, for a suite. Overrides `stateHome`. */
  socketPath?: string;
  hub: (sessionId: string) => ModHubRow | undefined;
  /**
   * Every Hub row for the session, across attach modes. A turn's end is news to each of them: a
   * resident tab's Observe row tails the same transcript as the synced one, and once the synced row
   * is released it is the row the roster reads. Without it only `hub`'s row is told.
   */
  hubAll?: (sessionId: string) => ModHubRow[];
  /** The session's Claude transcript, which is where the permission mode is actually written. */
  transcriptPath: (sessionId: string) => string | undefined;
  /** cosyncing's own setting, never Claude's. Read on every gate check so a flip lands within a poll. */
  killSwitch: () => boolean;
  /** Short label for the card, from the roster. Never a prompt excerpt. */
  sessionTitle?: (sessionId: string) => string | undefined;
  /** Mirror of mod events into the Hub/roster (turn boundaries, attention, sync presence). */
  onEvent?: (event: ModSocketEvent) => void;
  /** A registration appeared or changed, which is what flips a row to `live` in the adapter. */
  /** A mod registration was accepted or replaced, with what the kernel said about the peer. */
  onRegister?: (sessionId: string, info: { cwd: string; claudeVersion: string; model?: string; isInteractive: boolean; surface: string; peerPid: number }) => void;
  log?: { warn: (message: string) => void; info?: (message: string) => void };
  /** Passed straight to the socket. A suite shortens it; production leaves it at the default. */
  holdPollWaitMs?: number;
  /** Override the header deadline for a suite. */
  headerDeadlineMs?: number;
  /**
   * Override the 15 s lease a hold outlives its terminal's last request by. Production leaves it
   * alone; the seam suite sets it to a few hundred milliseconds so "the card closed because the
   * terminal stopped asking" is a case that runs in a test rather than in someone's afternoon.
   */
  holdLeaseMs?: number;
  /**
   * Override the broker-descendant rule, passed straight to the socket. Only a suite whose
   * "terminal" is a child of the suite process -- which is also the broker there -- sets it.
   */
  isBrokerChild?: (pid: number) => boolean;
  /**
   * How often the sweep runs. Production leaves the default; a suite shortens it so "closed within
   * a bounded time with nobody looking" is a case that runs in a test.
   */
  sweepIntervalMs?: number;
  /**
   * The timer a hold's wait sleeps on, passed straight to the hold store. Production leaves the
   * default; a suite counts its calls, because "an open hold sleeps until something happens" is a
   * number.
   */
  holdSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** How many sessions' last turn ends are remembered at once. */
const TURN_END_SESSIONS = 512;

/** How many card notes one session keeps. More than any one session's recent question cards. */
const CARD_NOTES_PER_SESSION = 256;
/** How many sessions' card notes are kept at once. */
const CARD_NOTE_SESSIONS = 512;

/**
 * How often every row and every open hold is looked at without anybody asking. It bounds how long a
 * card outlives the terminal that stopped asking about it, and how long a closed terminal reads as
 * synced.
 */
const SWEEP_INTERVAL_MS = 5_000;

export interface ModApproval {
  sessionId: string;
  requestId: string;
  decision: string;
}

export class ClaudeModService {
  private readonly options: ClaudeModServiceOptions;
  private readonly registry: ModRegistry;
  private readonly audit: ModAuditStore;
  private readonly holdStore: ModHoldStore;
  private readonly socket: ModSocketServer;
  private readonly resolvedSocketPath: string;
  /** What each live registration told us, keyed by session id. */
  private readonly registrations = new Map<string, { cwd: string; claudeVersion: string; model?: string; isInteractive: boolean; surface: string; peerPid: number }>();
  /**
   * The read-only "this fell through to your terminal" cards, per session, with the reason each one
   * carries. They are drawn to explain a turn, so they are retired when the turn ends: a card whose
   * turn is over is history, and history belongs to the transcript rather than to the pending set
   * that every new socket is replayed from.
   */
  private readonly released = new Map<string, { requestId: string; why: string; question?: true }[]>();
  /**
   * What each session's cards showed that the transcript does not record, by card id, newest last
   * and bounded. A reload is drawn from the transcript; this is how it is drawn the same way.
   */
  private readonly cardNotes = new Map<string, Map<string, ClaudeModCardNote>>();
  /**
   * The turn the app's Stop was aimed at, per session, until that turn's end is reported. A turn
   * stopped through the mod is closed at once; any other end waits for the transcript's own row.
   */
  private readonly appAborts = new Map<string, string>();
  /**
   * When the mod last said the session's main turn ended (`turn.complete` or `session.end`), per
   * session, newest last and bounded. A history read restates an open run cancelled only when it
   * started before this: the mod's word that it ended. The mod knowing of no turn is not that word.
   */
  private readonly turnEnds = new Map<string, number>();
  private started = false;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Bumped by `close()`, so a start that is still binding when the broker stops comes to nothing. */
  private epoch = 0;

  constructor(options: ClaudeModServiceOptions) {
    this.options = options;
    this.registry = new ModRegistry();
    this.audit = new ModAuditStore();
    this.resolvedSocketPath = options.socketPath ?? modSocketPath(options.stateHome ?? setupStateHome());
    this.holdStore = new ModHoldStore({
      registry: this.registry,
      audit: this.audit,
      ...(options.holdLeaseMs ? { leaseMs: options.holdLeaseMs } : {}),
      ...(options.holdSleep ? { sleep: options.holdSleep } : {}),
      log: (message) => this.options.log?.warn(message),
      gate: (sessionId) => this.gateInputs(sessionId),
      onHoldAccepted: (hold) => this.publishCard(hold.sessionId, hold),
      onRelease: (sessionId, hold, why, mode) => this.publishRelease(sessionId, hold, why, mode),
      onResolve: (sessionId, requestId, outcome, answeredBy, record) =>
        this.settleCard(sessionId, record?.appRequestId ?? requestId, outcome, answeredBy, record),
    });
    this.socket = new ModSocketServer({
      socketPath: this.resolvedSocketPath,
      registry: this.registry,
      holds: this.holdStore,
      killSwitch: () => this.safeKillSwitch(),
      holdPollWaitMs: options.holdPollWaitMs,
      headerDeadlineMs: options.headerDeadlineMs,
      ...(options.isBrokerChild ? { isBrokerChild: options.isBrokerChild } : {}),
      log: options.log,
      onEvent: (event) => this.noteModEvent(event),
      onRegister: (sessionId, info) => {
        this.registrations.set(sessionId, info);
        this.noteRegisteredTurnEnd(sessionId, info);
        this.options.onRegister?.(sessionId, info);
      },
    });
  }

  get listening(): boolean {
    return this.started;
  }

  /** Where the socket is, or would be, so a log line and a test can name it. */
  get socketPath(): string {
    return this.resolvedSocketPath;
  }

  /** The Hub's row id for a mod session, for the few callers outside this file that need it. */
  hubIdFor(sessionId: string): string | undefined {
    return this.hubId(sessionId);
  }

  /**
   * A mod event, before it reaches whoever watches the session.
   *
   * One kind has a destination this file can reach on its own: `command.refused`, a command the
   * app was told had been delivered and that the terminal then could not carry out. Everything
   * else goes to `onEvent`, because turn boundaries and a pid that stops being provable belong
   * to the roster and the inbox rather than to a card.
   */
  noteModEvent(event: ModSocketEvent): void {
    // Claude's own dialog chosen from the band is not one: the turn is still running, waiting on
    // that dialog, and a question handed to it is still open in the terminal.
    const dialogChosen = event.kind === 'user-cancel' && event.detail?.via === 'dialog';
    if (event.kind === 'turn.start' || event.kind === 'turn.complete' || (event.kind === 'user-cancel' && !dialogChosen) || event.kind === 'session.end') {
      // A turn boundary, from whichever side reported it: the explanations of the turn that just
      // ended are done explaining.
      this.retireReleased(this.sessionKeyFor(event.sessionId));
    }
    const child = typeof event.detail?.agentId === 'string' && event.detail.agentId.length > 0;
    if ((event.kind === 'turn.complete' && !child) || event.kind === 'session.end') {
      this.noteTurnEnded(event);
    }
    // A Stop that stopped nothing, or a turn that is not the one it was aimed at, is no longer an
    // app Stop waiting for its end. Left in place it would be read as the app's doing later.
    if (event.kind === 'turn.start') {
      const key = this.sessionKeyFor(event.sessionId);
      if (this.appAborts.has(key) && this.appAborts.get(key) !== event.detail?.turnId) this.appAborts.delete(key);
    }
    if (event.kind === 'command.refused' && event.detail?.op === 'abort') {
      this.appAborts.delete(this.sessionKeyFor(event.sessionId));
    }
    if (event.kind === 'command.refused') {
      // Both words come from the terminal and go into a sentence on the app, so each is held to the
      // set of things it can be: an op the broker sends, and a reason code. Anything else is named
      // generically rather than repeated.
      const op = MOD_COMMAND_OPS.includes(event.detail?.op as never) ? event.detail!.op as string : 'command';
      const reason = typeof event.detail?.reason === 'string' && /^[a-z_]{1,48}$/.test(event.detail.reason) ? event.detail.reason : 'refused';
      const message = reason === 'no_active_turn'
        ? 'Nothing was running in your terminal when the stop arrived, so nothing was stopped.'
        : `The cosyncing mod in your terminal could not carry out that ${op} (${reason}).`;
      try {
        this.connection(event.sessionId)?.noteModNotice?.(message);
      } catch {
        /* a notice nobody could take is not worth a stack trace */
      }
    }
    this.options.onEvent?.(event);
  }

  /** Record a turn end for a session, newest last and bounded. */
  private rememberTurnEnd(key: string, at: number): void {
    this.turnEnds.delete(key);
    this.turnEnds.set(key, at);
    if (this.turnEnds.size > TURN_END_SESSIONS) {
      const oldest = this.turnEnds.keys().next().value;
      if (oldest !== undefined) this.turnEnds.delete(oldest);
    }
  }

  /**
   * The mod's own record of the last turn end, said as it registered.
   *
   * `turnEnds` lives in this process, and a restarted broker starts with none. A turn stopped from the
   * app writes no interruption row, so after a restart every history read drew that turn running
   * again, and so did a row attached before the mod came back. The mod remembers the end across the
   * restart. It is taken only when it is newer than the end on record and not in the future, and the
   * rows are told only when the mod says no turn is running: a run that started before that end and
   * is still open is one the transcript never closed.
   */
  private noteRegisteredTurnEnd(sessionId: string, info: { turnId?: string; turnEndedAt?: number }): void {
    const endedAt = info.turnEndedAt;
    if (endedAt === undefined || endedAt > Date.now()) return;
    const key = this.sessionKeyFor(sessionId);
    const known = this.turnEnds.get(key);
    if (known !== undefined && known >= endedAt) return;
    this.rememberTurnEnd(key, endedAt);
    if (info.turnId) return;
    const rows = this.options.hubAll ? this.safeRows(sessionId) : [this.row(sessionId)];
    for (const row of rows) {
      try {
        (row?.conn as ModHubConnection | undefined)?.noteModTurnEnded?.({ turnId: '', aborted: false, endedAt });
      } catch (error) {
        this.options.log?.warn(`mod turn end on register not settled for ${key}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  /**
   * Tell the session's rows that its main turn is over, and whether this broker stopped it.
   *
   * The run state a row shows comes from the transcript, and a Stop through the mod writes nothing
   * there: the row said Working, through a reload, until the next prompt. The mod's own report of the
   * end is the one signal that exists, so it is handed to every row that tails the session.
   */
  private noteTurnEnded(event: ModSocketEvent): void {
    const key = this.sessionKeyFor(event.sessionId);
    this.rememberTurnEnd(key, Date.now());
    const turnId = typeof event.detail?.turnId === 'string' ? event.detail.turnId : '';
    const stopped = this.appAborts.get(key);
    this.appAborts.delete(key);
    // A `session.end` ends whatever turn was running; a `turn.complete` names its own.
    const aborted = stopped !== undefined && (event.kind === 'session.end' || !turnId || stopped === turnId);
    const rows = this.options.hubAll ? this.safeRows(event.sessionId) : [this.row(event.sessionId)];
    for (const row of rows) {
      try {
        (row?.conn as ModHubConnection | undefined)?.noteModTurnEnded?.({ turnId, aborted });
      } catch (error) {
        this.options.log?.warn(`mod turn end not settled for ${key}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  /** Every Hub row for the session, or none when the lookup fails. */
  private safeRows(sessionId: string): ModHubRow[] {
    try {
      return this.options.hubAll?.(this.hubId(sessionId) ?? sessionId) ?? [];
    } catch {
      return [];
    }
  }

  /** Bind the socket. Rejects only for a real bind problem; the caller decides whether that is fatal. */
  async start(): Promise<void> {
    if (this.started) return;
    const epoch = this.epoch;
    await this.socket.start();
    if (this.started || epoch !== this.epoch || !this.socket.listening) return;
    this.started = true;
    const timer = setInterval(() => this.sweep(), Math.max(10, this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS));
    // A sweep is housekeeping for a broker that is running anyway; it must never be the reason one
    // stays up.
    (timer as { unref?: () => void }).unref?.();
    this.sweepTimer = timer;
  }

  /**
   * Look at every row and every open hold, whether or not anybody is watching.
   *
   * A lapsed hold and a dead terminal used to be noticed only when something read `status()`: an
   * app's roster frame, or the adapter's own tick for a row it was drawing. With no app attached,
   * a hold nobody was waiting on stayed open, its card and inbox item with it, and a late tap was
   * still taken; a `kill -9`'d terminal was never reported, because the only other place that
   * raised it was a poll from the dead process itself. This runs `status()` for each of them, which
   * is where both rules already live, and then drops what only grew.
   */
  sweep(): void {
    const sessions = new Set<string>([
      ...this.registry.list().map((row) => row.sessionId),
      ...this.holdStore.openSessionIds(),
    ]);
    for (const sessionId of sessions) {
      try {
        this.status(sessionId);
      } catch (error) {
        this.options.log?.warn(`mod sweep failed for ${sessionId}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
      }
    }
    // What is left once a row is gone: the lookup a registration fed, and the explanation cards of a
    // terminal that will never report the end of their turn.
    for (const sessionId of [...this.registrations.keys()]) {
      if (!this.registry.get(sessionId)) this.registrations.delete(sessionId);
    }
    for (const sessionId of [...this.released.keys()]) {
      if (!this.registry.get(sessionId)) this.retireReleased(sessionId);
    }
    for (const sessionId of [...this.appAborts.keys()]) {
      if (!this.registry.get(sessionId)) this.appAborts.delete(sessionId);
    }
    this.holdStore.trim();
  }

  close(): void {
    this.epoch += 1;
    if (!this.started) {
      // A start still binding is told to stop; nothing else is running yet.
      this.socket.close();
      return;
    }
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    // Registrations describe live processes, so they do not survive a broker restart; the
    // mod re-registers on its own `session.start` or in its poll loop after /clear.
    this.registrations.clear();
    this.released.clear();
    this.appAborts.clear();
    this.turnEnds.clear();
    this.socket.close();
    this.started = false;
  }

  /** Every decision ever taken or declined, newest last. Read by the app and by the suites. */
  auditTrail(sessionId?: string): ModAuditRow[] {
    return this.audit.list({ ...(sessionId ? { sessionId } : {}), includeReleases: true });
  }

  /**
   * The row as the registry sees it, after the holds it can no longer carry have been closed.
   *
   * Nobody is polling a mod that has stopped polling, and the hold's expiry used to be enforced
   * only inside a verdict poll, so exactly the session that needed it never got it. This is the point
   * where the roster, the adapter and the suites all look, so it is the point where the promise
   * is kept: a card outlives cosyncing's wait for it by at most one status read.
   */
  status(sessionId: string): ModRowStatus {
    const status = this.registry.status(sessionId);
    // Somebody in the app who could answer is watching this session now: it is being followed.
    if (status.registration && !status.registration.followed && this.viewers(sessionId) > 0) {
      this.registry.noteFollowed(sessionId);
    }
    const carried = status.present && status.fresh && status.pidAlive && status.state === 'live';
    this.holdStore.sweep(sessionId, carried);
    // A row whose process is gone by pid plus start time is evicted here, at the one point every
    // reader of the row passes through. It used to stay until a `session.end` that a `kill -9`
    // never sends, so the registry kept answering for a dead terminal: polls from the next
    // terminal on that session were refused against it, and the map only grew. This read still
    // reports the death (pid-dead, Observe); the next one finds no row. The person is told once,
    // before the row goes, because the row is what remembers that they were told.
    if (status.present && !status.pidAlive && status.registration) {
      // Only about a terminal a person sat at and the app was following. A `claude -p` script, or a
      // terminal nobody opened in the app, put "your terminal has closed" in an inbox about something
      // its reader never knew was open; those rows go quietly.
      const row = status.registration;
      if (row.isInteractive && row.followed && this.registry.takeAttentionEvent(row)) {
        this.noteModEvent({ sessionId, kind: 'attention.pid-dead' });
      }
      this.registry.deregister(sessionId);
      this.registrations.delete(sessionId);
    }
    return status;
  }

  /**
   * Where the mod said the session is, which is the only route to its transcript.
   *
   * Tied to the registry rather than trusted on its own: a registration that has ended (a
   * `session.end`, or a row that was replaced) must stop answering, or the broker goes on reading
   * the mode out of a dead session's transcript and gating a hold that no longer has a mod behind
   * it. The map is only a lookup for `transcriptPath`, never a second source of truth.
   */
  registrationFor(sessionId: string): { cwd: string } | undefined {
    const info = this.registrations.get(sessionId);
    if (!info) return undefined;
    if (!this.registry.get(sessionId)) {
      this.registrations.delete(sessionId);
      return undefined;
    }
    return info;
  }

  /** The polls a resolved hold was charged for, so a suite or the doctor can name the number. */
  holdPolls(requestId: string): number | undefined {
    return this.auditTrail().find((row) => row.requestId === requestId)?.polls;
  }

  /**
   * Is this card a mod hold this broker is still holding, for this session?
   *
   * By the card's id, which the broker minted for that hold alone, and scoped by session. The mod's
   * own ids restart at `cm-1` in every process: asked by those, a tap on a dead process's card
   * decided the resumed process's first call, and a tap on one row could approve a call in another.
   */
  isHeld(sessionId: string, requestId: string): boolean {
    return this.heldCard(sessionId, requestId) !== undefined;
  }

  /**
   * Was this session drawn a mod card under this id: held, settled, or read-only?
   *
   * A minted id says so by its shape. A question's card carries Claude's own call id, which says
   * nothing, so the ids drawn are remembered, and a late tap on one is refused out loud instead of
   * falling through to a connection that never drew it.
   */
  drewCard(sessionId: string, requestId: string): boolean {
    return this.holdStore.drewCard(this.sessionKeyFor(sessionId), requestId);
  }

  /**
   * Is this one of the session's read-only cards: a call the broker let fall through to the
   * terminal, still open there? Nothing in the app can answer one, and a tap on it is told so.
   */
  isReleasedCard(sessionId: string, requestId: string): boolean {
    return (this.released.get(this.sessionKeyFor(sessionId)) ?? []).some((entry) => entry.requestId === requestId);
  }

  /** The open hold behind an app card, from the registration that is the session's now. */
  private heldCard(sessionId: string, appRequestId: string): ModHoldRecord | undefined {
    return this.holdStore.byCard(this.sessionKeyFor(sessionId), appRequestId);
  }

  /** The app's answer to a held `AskUserQuestion`, converted from the contract's rows.
   *
   * False means there was nothing to answer -- the terminal answered first, the hold expired, or
   * the rows do not line up with the questions the card was drawn from. In every case the answer
   * is dropped and said out loud rather than queued for a call that has gone.
   */
  answerQuestion(approval: { sessionId: string; requestId: string; answers: unknown }): boolean {
    const sessionId = this.sessionKeyFor(approval.sessionId);
    const hold = this.heldCard(approval.sessionId, approval.requestId);
    if (!hold) return false;
    const answers = modAnswerMap(hold.questions, approval.answers);
    if (!answers) {
      this.options.log?.warn(
        `mod question answer refused for ${sessionId}/${approval.requestId}: the answer rows do not line up with the questions the card carried`,
      );
      return false;
    }
    return this.holdStore.answerQuestion(sessionId, hold.requestId, answers);
  }

  /** The app's answer to a held permission call. False means the terminal got there first, or stopped waiting. */
  approve(approval: ModApproval): boolean {
    const behavior = this.behaviourFor(approval.decision);
    if (!behavior) {
      if (approval.decision === 'approve-session' || approval.decision === 'approve-rule') {
        this.options.log?.warn(
          `mod hold refused decision ${approval.decision} for ${approval.requestId}: a tap approves one call and never writes a rule`,
        );
      }
      return false;
    }
    const hold = this.heldCard(approval.sessionId, approval.requestId);
    if (!hold) return false;
    return this.socket.answer(
      this.sessionKeyFor(approval.sessionId),
      hold.requestId,
      behavior,
      'app',
    );
  }

  /** Queue a command for the mod to carry out on its next poll. Validated before it is queued. */
  send(sessionId: string, command: ModCommand): { ok: true } | { ok: false; code: string } {
    const key = this.sessionKeyFor(sessionId);
    if (command.op === 'answer') {
      // An `answer` command is validated, queued and TTL-managed, and nothing carries it: the mod
      // takes a question's answer on the hold it is parked on, over `hold.answer`. A caller that
      // queues one is told `{ok:true}` and gets a question that never closes -- which is exactly
      // how a tier-2 run spent three turns on a green that meant nothing. Refuse it at the door
      // that a caller can hear.
      this.options.log?.warn(
        `mod answer command refused for ${command.requestId}: a question is answered on its hold, not queued as a command`,
      );
      return { ok: false, code: 'answer_on_hold' };
    }
    if (command.op === 'prompt' || command.op === 'steer') {
      // Whatever the terminal was waiting on, the person has just said something. An explanation
      // card for the call before that is now part of the record, not an open question. A question
      // left to the terminal is the exception: Claude's picker is still open there, and the card
      // is what says so, until the picker is answered or the turn ends.
      this.retireReleased(key, { keepQuestions: true });
    }
    const queued = this.socket.enqueue(key, command);
    if (!queued.ok) return queued;
    // The turn the registry stamped onto the Stop, which is the turn whose end it explains.
    if (queued.command.op === 'abort' && queued.command.turnId) this.appAborts.set(key, queued.command.turnId);
    return { ok: true };
  }

  /** The reason a decision came back false, so the app can say something true. */
  refusalReason(decision: string): string | undefined {
    if (decision === 'approve-session' || decision === 'approve-rule') {
      return 'The app approves one call at a time. Persistent rules and session-wide approval stay in Claude\'s own dialog.';
    }
    return undefined;
  }

  private behaviourFor(decision: string): 'allow' | 'deny' | undefined {
    if (decision === 'approve') return 'allow';
    if (decision === 'reject') return 'deny';
    return undefined;
  }

  private safeKillSwitch(): boolean {
    try {
      return this.options.killSwitch() === true;
    } catch {
      // A settings read that fails must not become an approval. Off means hold, so fail toward on.
      return true;
    }
  }

  private gateInputs(sessionId: string) {
    let mode: string | undefined;
    try {
      const transcript = this.transcriptFor(sessionId);
      mode = transcript ? readLatestPermissionMode(transcript) : undefined;
    } catch {
      mode = undefined;
    }
    return { mode, viewers: this.viewers(sessionId), killSwitch: this.safeKillSwitch() };
  }

  /** The session's transcript, or nothing. The one call site for the locator's lookup. */
  private transcriptFor(sessionId: string): string | undefined {
    try {
      return this.options.transcriptPath(sessionId);
    } catch {
      return undefined;
    }
  }

  private row(sessionId: string): ModHubRow | undefined {
    try {
      return this.options.hub(this.hubId(sessionId) ?? sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * The Hub's row id for a mod session.
   *
   * Two ids name one Claude session, and the two halves of this file each know only one.
   * The mod speaks the native session uuid because that is what its API hands it; the Hub
   * keys a Claude row by the encoded transcript path because that is what discovery
   * publishes and what attach re-opens. Asking the Hub for the uuid found nothing at all,
   * which did not look like a broken lookup: a zero viewer count is a REASON to release a
   * hold, so every hold came back `viewer:none` and no card was ever drawn. Crossing here,
   * once, keeps every Hub-facing call honest.
   */
  private hubId(sessionId: string): string | undefined {
    const transcript = this.transcriptFor(sessionId);
    return transcript ? claudeSessionId(transcript) : undefined;
  }

  /**
   * Either spelling of a Claude session's id, resolved to the one the socket keys by.
   *
   * The app's answer arrives with the row id it is attached to; the hold it answers is
   * filed under the mod's native uuid. The transcript's file name IS that uuid, so the row
   * id decodes straight back to it. Anything that does not decode is passed through: a
   * session with no transcript row was addressed by its own id in the first place.
   */
  private sessionKeyFor(id: string): string {
    if (this.registrations.has(id)) return id;
    try {
      const path = claudeTranscriptPath(id);
      const native = (path.split('/').pop() ?? '').replace(/\.jsonl$/, '');
      return native && this.registrations.has(native) ? native : id;
    } catch {
      return id;
    }
  }

  private connection(sessionId: string): ModHubConnection | undefined {
    return this.row(sessionId)?.conn as ModHubConnection | undefined;
  }

  /**
   * App viewers that could actually answer. Zero is not a failure but a rule: with nobody able
   * to answer, the terminal keeps the prompt, which is the measured fail-open shape.
   *
   * A raw client count is not that number. A resident or background tab attaches Claude in plain
   * Observe, and an Observe connection has no card channel and refuses every mutation, so a hold
   * taken for it parked the terminal's prompt against a seat that could never tap it -- for a
   * minute when holds had a deadline, and for as long as the person waited once they did not.
   * Watching is not the gate; being able to answer is.
   */
  private viewers(sessionId: string): number {
    const row = this.row(sessionId);
    if (!row) return 0;
    return this.canAnswer(row.conn) ? row.clientCount : 0;
  }

  /** Whether a connection can be shown a permission card and answered back. */
  private canAnswer(conn: unknown): boolean {
    const candidate = conn as ModHubConnection | undefined;
    return typeof candidate?.ingestRequest === 'function'
      && typeof candidate?.respondPermission === 'function';
  }

  private publishCard(sessionId: string, hold: { appRequestId: string; tool: string; questions?: unknown; modeSeen: string; inputPreview?: string; inputDetail?: string }): void {
    const conn = this.connection(sessionId);
    if (!conn?.ingestRequest) return;
    conn.noteModGeneration?.(this.registry.generation(sessionId));
    try {
      // Keyed by the Hub's row id: the roster cache is filed under what discovery published.
      const title = this.options.sessionTitle?.(this.hubId(sessionId) ?? sessionId);
      if (hold.questions) {
        // Claude's `multiSelect` becomes the contract's `multiple` here, which is the only place
        // the two names meet. Without it a multi-select card draws radio buttons and the app
        // sends one label for a question that takes several.
        conn.ingestRequest({
          requestId: hold.appRequestId,
          kind: 'question',
          toolName: hold.tool,
          questions: modQuestionViews(hold.questions),
          ...(title ? { title } : {}),
        });
        return;
      }
      conn.ingestRequest({
        requestId: hold.appRequestId,
        kind: 'permission',
        toolName: hold.tool,
        ...(title ? { title } : {}),
        permissionMode: modPermissionMode(hold.modeSeen),
        // The preview is the card. A tap that cannot see the command is not an approval, and the
        // sentence this used to send was English in a five-locale app.
        ...(modCardPreview(hold.inputPreview) ? { inputPreview: modCardPreview(hold.inputPreview) } : {}),
        // The whole call, behind the card's "Show details": the preview is enough to recognise a
        // call and not always enough to decide one. A client that predates `inputPreview` draws
        // only this, so it is never left with less than the preview.
        ...(modCardFullDetail(hold.tool, hold.inputPreview, hold.inputDetail) ? { detail: modCardFullDetail(hold.tool, hold.inputPreview, hold.inputDetail) } : {}),
      });
    } catch (error) {
      this.options.log?.warn(`mod card publish failed for ${sessionId}/${hold.appRequestId}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  }

  /**
   * A declined `ask` still deserves a card, because the turn stopped and the person on the
   * phone cannot see why. It is read-only by construction: there is nothing to answer, the
   * terminal owns the dialog, and the reason says which of the four rules let the call go.
   */
  private publishRelease(sessionId: string, hold: ModHoldMessage, why: string, mode: string | undefined): void {
    // Nobody is shown a dialog for these, so there is nothing for a card to say: see the list.
    if (UNCARDED_RELEASE_REASONS.includes(why)) return;
    const conn = this.connection(sessionId);
    if (!conn?.ingestRequest) return;
    conn.noteModGeneration?.(this.registry.generation(sessionId));
    const { tool, input: preview, detail } = hold;
    // A card of its own, like a held call's: the mod's id repeats in the next process. A question
    // keeps Claude's call id, which the transcript draws the same question under.
    const cardId = this.holdStore.cardIdFor(sessionId, hold);
    const question = hold.questions !== undefined || hold.questionsUnreadable === true;
    try {
      if (question) {
        // A question stays a question. Drawn as a permission card it said a dialog was open and
        // offered nothing to do about it, in auto-mode words for a question the person had to
        // answer; this is the question, with no controls, and the sentence that says where.
        //
        // And it blocks. Claude's picker is open in the terminal and the session is waiting on a
        // person, which is what Needs input says. The transcript's own copy of the question would
        // have said it, but it has this card's id and is dropped for it. The card cannot stick: the
        // transcript's answer closes it under the same id, and the turn's end retires it.
        conn.ingestRequest({
          requestId: cardId,
          kind: 'question',
          toolName: tool,
          questions: hold.questions !== undefined ? modQuestionViews(hold.questions) : [],
          readOnly: true,
          answerInTerminal: true,
        });
        this.noteCard(sessionId, cardId, { inTerminal: true });
      } else conn.ingestRequest({
        requestId: cardId,
        kind: 'permission',
        toolName: tool,
        // No buttons on this card. The hold is already closed and the terminal owns the dialog,
        // so an actionable card here would offer the app a decision it can no longer make.
        readOnly: true,
        // ...and nobody is waiting on it either. This is the second half of what a read-only card
        // is: it used to sit in the pending set with a plain permission-request's status, which put
        // the row at `needs-input` for the rest of the session, replayed the explanation to every
        // socket that opened, and made every later prompt read as mid-turn.
        blocking: false,
        releaseReason: modReleaseReason(why),
        ...(mode ? { permissionMode: modPermissionMode(mode) } : {}),
        ...(modCardPreview(preview) ? { inputPreview: modCardPreview(preview) } : {}),
        ...(modCardFullDetail(tool, preview, detail) ? { detail: modCardFullDetail(tool, preview, detail) } : {}),
      });
      const seen = this.released.get(sessionId) ?? [];
      // One entry per request id, and a ceiling: a mod that re-offers the same declined call would
      // otherwise grow this for the life of the broker. Retiring a card nobody can see any more is
      // cheap, so the oldest is dropped rather than the newest.
      if (!seen.some((entry) => entry.requestId === cardId)) {
        seen.push({ requestId: cardId, why, ...(question ? { question: true } : {}) });
        this.released.set(sessionId, seen.slice(-20));
      }
    } catch {
      // A card we could not draw is not worth a stack trace.
    }
  }

  /**
   * Retire this session's read-only cards, because the turn they explained is over.
   *
   * The resolution rides the ordinary `permission-resolved` path with its release reason attached,
   * so the card stays in the transcript as what happened and leaves the pending set that a new
   * socket is replayed from. Cards the terminal is genuinely holding are not in this list and are
   * not touched.
   */
  private retireReleased(sessionId: string, options: { keepQuestions?: boolean } = {}): void {
    const all = this.released.get(sessionId);
    if (!all || all.length === 0) return;
    const kept = options.keepQuestions ? all.filter((entry) => entry.question) : [];
    const entries = options.keepQuestions ? all.filter((entry) => !entry.question) : all;
    if (kept.length > 0) this.released.set(sessionId, kept);
    else this.released.delete(sessionId);
    if (entries.length === 0) return;
    const conn = this.connection(sessionId);
    if (!conn?.respondPermission) return;
    for (const entry of entries) {
      try {
        // A question card retires as a question, or its row stays a permission the client never drew.
        const settled = entry.question
          ? conn.rejectQuestion?.(entry.requestId)
          : conn.respondPermission(entry.requestId, 'external', { releaseReason: modReleaseReason(entry.why) });
        if (settled && typeof (settled as Promise<void>).catch === 'function') {
          (settled as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* the card closes on its own when the overlay rolls forward */
      }
    }
  }

  /** What a card this session was drawn showed that its transcript does not record, if anything. */
  cardNote(sessionId: string, requestId: string): ClaudeModCardNote | undefined {
    return this.cardNotes.get(this.sessionKeyFor(sessionId))?.get(requestId);
  }

  private noteCard(sessionId: string, requestId: string, note: ClaudeModCardNote): void {
    const notes = this.cardNotes.get(sessionId) ?? new Map<string, ClaudeModCardNote>();
    const before = notes.get(requestId);
    notes.delete(requestId);
    notes.set(requestId, { ...(before ?? {}), ...note });
    if (notes.size > CARD_NOTES_PER_SESSION) {
      const oldest = notes.keys().next().value;
      if (oldest !== undefined) notes.delete(oldest);
    }
    // Newest session last, so the one dropped when there are too many is the longest quiet.
    this.cardNotes.delete(sessionId);
    this.cardNotes.set(sessionId, notes);
    if (this.cardNotes.size > CARD_NOTE_SESSIONS) {
      const oldest = this.cardNotes.keys().next().value;
      if (oldest !== undefined) this.cardNotes.delete(oldest);
    }
  }

  /** When the mod last said this session's main turn ended, or undefined when it has not said so. */
  turnEndedAt(sessionId: string): number | undefined {
    return this.turnEnds.get(this.sessionKeyFor(sessionId));
  }

  /** The turn the mod says is running for this session, or ''. What decides prompt versus steer. */
  currentTurn(sessionId: string): string {
    return this.registry.currentTurn(this.sessionKeyFor(sessionId));
  }

  /**
   * Close the card in every seat, and say what closed it.
   *
   * The answer itself already travelled once, through the socket reply; this is the notification
   * that the same decision was made, not a second delivery. It names the decider because two
   * seats can answer one hold and the person in the one that did not need to know their tap was
   * not what let the call through. It says `external` rather than inventing an approval for a
   * hold that expired or was cancelled: nobody approved anything, and an audit-shaped lie on
   * the app's face is worse than a plain one.
   */
  private settleCard(
    sessionId: string,
    requestId: string,
    outcome?: ModHoldOutcome,
    answeredBy?: ModDecisionSource | 'cancel',
    record?: { tool?: string; questions?: unknown },
  ): void {
    const conn = this.connection(sessionId);
    const decidedBy: PermissionDecidedBy | undefined = answeredBy === 'app'
      || answeredBy === 'band'
      || answeredBy === 'expired'
      ? answeredBy
      : undefined;
    const releaseReason = outcome?.kind === 'released'
      ? modReleaseReason(outcome.why)
      : outcome?.kind === 'expired'
        ? 'expired' as PermissionReleaseReason
        : undefined;
    // A call the terminal itself took back. Bare, it read "Resolved in another client" for a dialog
    // the person opened at their own keyboard. The terminal says how (`via`), and this broker knows
    // whether the interrupt was its own Stop. A mod that says nothing still closes it bare.
    const cancelled = outcome?.kind === 'cancelled' ? modCancelAttribution(outcome, this.appAborts.has(sessionId)) : {};
    // A question hold closes as an answered question, not as a permission decision. The answers
    // ride along so every seat shows the same answer the one that was tapped, and so does who gave
    // it: without it the seat that sent the answer read "settled in your terminal or another app"
    // as soon as it rebuilt the card. The transcript records the answer and not the seat, so the
    // seat is remembered here for a reload.
    if (outcome?.kind === 'answered') {
      const rows = modAnswerRows(record?.questions, outcome.answers);
      const by: ModSettledBy = decidedBy ? { decidedBy } : {};
      this.noteCard(sessionId, requestId, by);
      try {
        const answered = conn?.answerQuestion?.(requestId, rows ?? [], by);
        if (answered && typeof (answered as Promise<void>).catch === 'function') {
          (answered as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* the card closes on its own when the session's live overlay rolls forward */
      }
      return;
    }
    // A question handed to Claude's own picker from the band is not over: the picker is open in the
    // terminal, waiting on a person. Closed here, it settled with nothing picked while the session
    // read Working, and the transcript's own copy of the question, which shares this card's id, was
    // dropped for a card already settled. The card stays, read-only, saying where to answer.
    if (record?.questions !== undefined && outcome?.kind === 'cancelled' && outcome.why === 'user-cancel' && outcome.via === 'dialog') {
      this.restateInTerminal(sessionId, requestId, record);
      return;
    }
    // A question that ends any other way -- expired, dismissed, its turn over, or its process
    // replaced -- still closes as a question. Closed as a permission it left the card's
    // `question-required` inbox item open for good: only `question-resolved` resolves one. It says
    // who closed it the way a permission card does, from the same three readings.
    if (record?.questions !== undefined) {
      const by: ModSettledBy = {
        ...(decidedBy ? { decidedBy } : {}),
        ...(releaseReason ? { releaseReason } : {}),
        ...cancelled,
      };
      if (by.decidedBy || by.releaseReason) this.noteCard(sessionId, requestId, by);
      try {
        const closed = conn?.rejectQuestion?.(requestId, by);
        if (closed && typeof (closed as Promise<void>).catch === 'function') {
          (closed as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* the card closes on its own when the session's live overlay rolls forward */
      }
      return;
    }
    const decision: 'approve' | 'reject' | 'external' = outcome?.kind === 'verdict'
      ? (outcome.behavior === 'allow' ? 'approve' : 'reject')
      : 'external';
    try {
      // Settled, not just called: the observe connection REJECTS a resolution rather than
      // throwing it, and a floating rejection is an unhandled one. Either way the card closes on
      // its own when the session's live overlay rolls forward.
      const settled = conn?.respondPermission?.(requestId, decision, {
        ...(decidedBy ? { decidedBy } : {}),
        ...(releaseReason ? { releaseReason } : {}),
        ...cancelled,
      });
      if (settled && typeof (settled as Promise<void>).catch === 'function') {
        (settled as Promise<void>).catch(() => undefined);
      }
    } catch {
      // The card closes on its own when the session's live overlay rolls forward.
    }
  }

  /**
   * Draw a held question again under its own id, as a question open in the terminal.
   *
   * Blocking, because the session is waiting on a person at Claude's picker. It is filed with the
   * read-only cards so the turn's end retires it, and the transcript's answer, which carries this
   * id since the card took Claude's call id, closes it before that with the answer given.
   */
  private restateInTerminal(sessionId: string, requestId: string, record: { tool?: string; questions?: unknown }): void {
    const conn = this.connection(sessionId);
    if (!conn?.ingestRequest) return;
    try {
      conn.ingestRequest({
        requestId,
        kind: 'question',
        ...(record.tool ? { toolName: record.tool } : {}),
        questions: modQuestionViews(record.questions),
        readOnly: true,
        answerInTerminal: true,
        restate: true,
      });
    } catch (error) {
      this.options.log?.warn(`mod question restate failed for ${sessionId}/${requestId}: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
      return;
    }
    this.noteCard(sessionId, requestId, { inTerminal: true });
    const seen = this.released.get(sessionId) ?? [];
    if (!seen.some((entry) => entry.requestId === requestId)) {
      seen.push({ requestId, why: 'band', question: true });
      this.released.set(sessionId, seen.slice(-20));
    }
  }
}

/**
 * The gate's mode string as the contract's mode name.
 *
 * The hold gate reads whatever the transcript says, and Claude's own mode list grows without
 * asking us. Anything unrecognized reads as `unknown`, which the client already renders as a
 * real reading ("the mode had not been written yet") rather than as a blank.
 */
export function modPermissionMode(mode: string): PermissionModeName {
  return (MOD_PERMISSION_MODES as readonly string[]).includes(mode)
    ? mode as PermissionModeName
    : 'unknown';
}

const MOD_PERMISSION_MODES = [
  'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'unknown',
] as const;

/**
 * The hold store's reason as the contract's reason.
 *
 * Only the four gate reasons cross this boundary. A hold that ended for some other reason (the
 * turn finished, the mod went quiet) was never a decision the broker declined, and calling a
 * turn-complete `viewer:none` would put a false sentence on the app.
 */
/**
 * The card's preview, capped the way the contract says it is capped.
 *
 * The mod already bounds what it sends, and the socket bounds what it accepts. This is the last
 * of the three, and the only one that decides what the contract promises a client.
 */
export function modCardPreview(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 239)}\u2026` : trimmed;
}

/**
 * The preview again, as `detail`, for a client that draws `detail` and not `inputPreview`.
 *
 * The mod names the argument it took ("command: rm -rf build"); a card that only has room for
 * one line reads better naming the tool ("Bash: rm -rf build"). Data, not prose: the tool name
 * and the argument are both Claude's, so nothing here needs a translation. Empty when there is
 * no preview, which leaves the card as it was.
 */
export function modCardDetail(tool: string, preview: string | undefined): string {
  const bounded = modCardPreview(preview);
  if (!bounded) return '';
  const colon = bounded.indexOf(': ');
  const key = colon > 0 ? bounded.slice(0, colon) : '';
  const value = (MOD_PREVIEW_KEYS as readonly string[]).includes(key) ? bounded.slice(colon + 2) : bounded;
  return modCardPreview(`${tool}: ${value}`);
}

/**
 * A card's `detail`: every field of the call when the mod sent them, else the one-line preview.
 *
 * The mod sends both, and the socket has already bounded the full text. The one-line form is what
 * a mod that predates the full text leaves to go on, and it is still more than an older client
 * would otherwise show.
 */
export function modCardFullDetail(tool: string, preview: string | undefined, detail: string | undefined): string {
  return detail?.trim() ? detail.trim() : modCardDetail(tool, preview);
}

/**
 * What a card closed by the terminal's own cancel says about who closed it.
 *
 * - The person chose Claude's dialog from the band: they are answering in the terminal (`band`).
 * - The turn was interrupted while this broker's Stop for it was outstanding: the app stopped it,
 *   whether the interrupt or the turn's end reached the broker first.
 * - Any other interrupt is Escape at the keyboard: the terminal again.
 * - A mod that does not say how (one older than `via`) gets nothing, as before.
 */
export function modCancelAttribution(
  outcome: Extract<ModHoldOutcome, { kind: 'cancelled' }>,
  appStopPending: boolean,
): { decidedBy?: PermissionDecidedBy; releaseReason?: PermissionReleaseReason } {
  if (outcome.why === 'user-cancel' && outcome.via === 'dialog') return { releaseReason: 'band' };
  if (outcome.why === 'user-cancel' && outcome.via === 'interrupt') {
    return appStopPending ? { decidedBy: 'app' } : { releaseReason: 'band' };
  }
  if (outcome.why === 'turn-complete' && appStopPending) return { decidedBy: 'app' };
  return {};
}

/** The command ops the broker queues for a mod, and so the only ones a refusal can name. */
const MOD_COMMAND_OPS: readonly string[] = ['prompt', 'steer', 'abort', 'answer'];

/** The argument names the mod's preview starts with. */
const MOD_PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'plan'] as const;

export function modReleaseReason(why: string): PermissionReleaseReason {
  return (MOD_CARD_RELEASE_REASONS as readonly string[]).includes(why)
    ? why as PermissionReleaseReason
    : 'expired';
}

const MOD_CARD_RELEASE_REASONS = [
  'mode:bypassPermissions', 'mode:unknown', 'plan:terminal-only',
  'viewer:none', 'killSwitch', 'band', 'expired',
] as const;
