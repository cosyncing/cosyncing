/**
 * Held permission decisions: who decides, when the answer is consumed, and what happens late.
 *
 * The rule this file implements is short. A `hold` arrives; the broker decides *at that
 * moment* whether to hold it, from its own freshest transcript read and its own live viewer
 * set, and answers `release` immediately when it will not. The mod caches neither the mode
 * nor the viewer flag, because either one stamped on a poll response can be twenty seconds
 * stale on top of the transcript flush lag, and one round trip of a few milliseconds buys a
 * single decider.
 *
 * Three behaviours here are the difference between a courtesy and a gate, and each is a test
 * rather than a comment:
 *
 * - **Nothing is held that Claude would not put to a person.** A permission `ask` is held in
 *   `default`, `acceptEdits` and `plan`; `auto`, `dontAsk`, `bypassPermissions` and an unreadable
 *   mode release at once. In auto mode Claude has its own classifier and a mod `allow` there would
 *   replace its answer outright, so refusing to hold is what keeps us out of the classifier's seat.
 *   A question is held in auto mode too, because there the picker does open for a person.
 * - **Every answer is request-scoped and consumed exactly once.** Once a hold resolves, the
 *   row is gone; a second answer, from whichever seat was slower, is dropped *and logged*.
 *   Phase 0 measured an unread verdict deciding the next call in 14 milliseconds with nobody
 *   asked, and a stale allow is worse than a stale deny.
 * - **A hold dies with its turn, and with its terminal.** `turn.complete`, `user-cancel`, and a
 *   lapsed lease all end it, and the mod's band is cleared rather than left dangling on a call
 *   that no longer exists.
 *
 * There is no deadline. Claude's own dialog waits for as long as it takes, and the terminal can
 * answer the whole time, so the app waits as long too. The lease (`HOLD_LEASE_MS`) is not a
 * budget for the person: the terminal renews it with every long-poll it parks here, and it runs
 * out only when the terminal stops asking. A released call is never an approval either way:
 * releasing answers `ask`, which hands the decision back to Claude's own dialog.
 */

import {
  HOLD_LEASE_MS,
  HOLDABLE_PERMISSION_MODES,
  HOLDABLE_QUESTION_MODES,
  PLAN_APPROVAL_TOOL,
  type ModDecisionSource,
  type ModHoldMessage,
  type ModHoldCancelReason,
  modModeReleaseReason,
  modQuestionsAnswerable,
  type ModReleaseReason,
} from './mod-protocol.ts';
import { randomBytes } from 'node:crypto';
import { modInputDigest, type ModAuditStore } from './mod-audit.ts';
import type { ModRegistry } from './mod-registry.ts';

/** The three facts the broker owns, gathered at the instant the hold arrives. */
export interface ModGateInputs {
  /** Broker's freshest transcript read. `undefined` means no mode on record yet, or a plan approved
   *  since the last one, which changes the mode without writing it. */
  mode: string | undefined;
  /** Connected app viewers for that session, from the hub. */
  viewers: number;
  /** cosyncing's own setting, never Claude's. */
  killSwitch: boolean;
}

export type ModGateDecision =
  | { hold: true; mode: string | undefined }
  | { hold: false; why: ModReleaseReason; mode: string | undefined };

/**
 * The hold gate, as a pure function: hold only when the kill switch is off, somebody is
 * watching, and the recorded mode is one where Claude puts this kind of call to a person -- its
 * permission dialog for a tool call, its picker for a question. The two sets differ in auto mode,
 * where a classifier answers tool calls and a person still answers questions.
 */
export function decideModHold(inputs: ModGateInputs, subject: 'permission' | 'question' = 'permission'): ModGateDecision {
  const { mode, viewers, killSwitch } = inputs;
  if (killSwitch) return { hold: false, why: 'killSwitch', mode };
  if (viewers <= 0) return { hold: false, why: 'viewer:none', mode };
  if (mode === undefined) return { hold: false, why: 'mode:unknown', mode };
  // The mode names itself. `mode:auto` used to stand in for every non-holdable mode, which told a
  // person in plan mode that they were sitting in auto mode.
  const holdable = subject === 'question' ? HOLDABLE_QUESTION_MODES : HOLDABLE_PERMISSION_MODES;
  if (!holdable.includes(mode)) {
    return { hold: false, why: modModeReleaseReason(mode), mode };
  }
  return { hold: true, mode };
}

export interface ModHoldRecord {
  sessionId: string;
  requestId: string;
  /**
   * Which registration opened this hold, stamped by the broker.
   *
   * Hold ids restart at `cm-1` in every process, so a `kill -9` followed by a `claude --resume`
   * of the same session id produces a second hold with the first one's key. The generation is
   * what keeps the new call from inheriting the dead one's card, where an Allow would have
   * decided a call the user was never shown.
   */
  generation: number;
  /**
   * The id the app's card carries, this hold's alone. Never the mod's own id: that count restarts
   * at `cm-1` in every process, so a tap still in flight on a dead process's card arrived carrying
   * the same id as the resumed process's first call -- and decided it, for a command the person had
   * never been shown.
   *
   * A question's card takes Claude's own `tool_use` id, because the transcript draws the same call
   * under that id and the app merges cards by id: a minted id made two cards of one question. That
   * keeps the rule, since Claude does not reuse a `tool_use` id for another call. The one way it
   * comes round again is the same call asked by a resumed process, and that card is minted (see
   * {@link ModHoldStore.cardIdFor}). A permission card is always minted.
   */
  appRequestId: string;
  tool: string;
  engineVerdict: string;
  modeSeen: string;
  inputDigest?: string;
  /**
   * What the call would actually do, as the mod described it: command, path or URL.
   *
   * Held in memory for the life of the hold so the app's card can show it, and deliberately kept
   * out of the audit row, which records a digest. A card you cannot read is not a decision.
   */
  inputPreview?: string;
  /** Every field of the call, for the card's details. Like the preview: in memory, never audited. */
  inputDetail?: string;
  questions?: unknown;
  startedAt: number;
  /**
   * When the terminal last asked about this hold: its offer, then every long-poll parked on it,
   * renewed for as long as one stays parked. The lease runs from here, never from `startedAt`.
   */
  renewedAt: number;
  /** Long-polls the terminal has parked on this hold. Counted for the audit row, never capped. */
  polls: number;
}

export type ModHoldOutcome =
  | { kind: 'released'; why: ModReleaseReason }
  /**
   * The call is being held.
   *
   * `first` says this is the moment the record was opened, as opposed to the same open hold
   * re-offered by a retry. The distinction exists for the terminal's band: the broker answers a
   * held call by waiting, so the mod's first reply about it IS its answer, and a band drawn
   * before that reply flashed over every call the broker released in the same round trip. Only
   * the first acceptance can say "held" early; a re-offer that answered early would spin the
   * mod's hold leg on a hold that was never waiting.
   */
  | { kind: 'held'; first?: boolean }
  | { kind: 'verdict'; behavior: 'allow' | 'deny'; source: ModDecisionSource }
  /** An `AskUserQuestion` hold answered from the app. The answers travel with the outcome, because
   *  the hold's long-poll is the only leg that can put them back into the tool. */
  | { kind: 'answered'; answers: unknown; source: ModDecisionSource }
  | { kind: 'expired' }
  /**
   * `via` is the terminal's account of a `user-cancel`: the person chose Claude's own dialog, or the
   * turn was interrupted. It stays in the broker, where it decides what the app's card says; the
   * mod is told only `why`.
   */
  | { kind: 'cancelled'; why: ModHoldCancelReason; via?: ModCancelVia }
  /**
   * This call was decided, and its outcome has already been handed to the other leg. Said out loud
   * because the alternative was an empty answer, which the mod read as "still held" and offered the
   * call again -- opening a second hold for a call that was already over, which then sat out the
   * whole lease with a card the person could tap for nothing.
   */
  | { kind: 'settled-elsewhere' }
  | { kind: 'unknown' };


export interface ModHoldDeps {
  registry: ModRegistry;
  audit: ModAuditStore;
  /** The gate's inputs, gathered fresh. Injected so the hub, the transcript reader and the
   *  settings store stay out of this module, and each can be swapped for a fake in a suite. */
  gate: (sessionId: string) => ModGateInputs;
  /** Called when a hold should be shown in the app. Never throws. */
  onHoldAccepted?: (hold: ModHoldRecord) => void;
  /** Called when a declined `ask` should surface as a read-only card. Never throws. */
  onRelease?: (sessionId: string, hold: ModHoldMessage, why: ModReleaseReason, mode: string | undefined) => void;
  /**
   * Called when a held call settles, so the app card closes.
   *
   * `record` is the hold as it was, handed over because the row is already gone by the time
   * this fires and the questions a card was drawn from cannot be recovered afterwards.
   */
  onResolve?: (sessionId: string, requestId: string, outcome: ModHoldOutcome, answeredBy: ModDecisionSource | 'cancel', record?: ModHoldRecord) => void;
  now?: () => number;
  /** How long a hold outlives its terminal's last request. Production uses `HOLD_LEASE_MS`. */
  leaseMs?: number;
  /**
   * The one timer a wait takes: its own end or its lease, whichever comes first. The signal ends it
   * early, when something else woke the wait. Injected so a suite can drive a fake clock, or count.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

/** A timer an abort can clear, so a wait woken early leaves nothing behind. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
/** How the terminal cancelled a held call itself: Claude's own dialog chosen, or the turn interrupted. */
export type ModCancelVia = 'dialog' | 'interrupt';

/** A `user-cancel` event's `via`, or nothing for a mod that predates it or sent something else. */
export function modCancelVia(value: unknown): ModCancelVia | undefined {
  return value === 'dialog' || value === 'interrupt' ? value : undefined;
}

/** How many card ids a session remembers. More than any one session's open and recent cards. */
const DRAWN_CARD_IDS_PER_SESSION = 256;
/** How many sessions' card ids are remembered at once. */
const DRAWN_CARD_SESSIONS = 512;
/** How long a settled outcome waits for a verdict poll that was already in flight. */
const RESOLVED_TOMBSTONE_MS = 90_000;

export class ModHoldStore {
  private readonly holds = new Map<string, ModHoldRecord>();
  /**
   * One-shot outcomes for holds that have resolved, so a verdict long-poll already in flight
   * can still report the truth. Consumed on read, which is what makes an answer travel once;
   * tombstones age out so a hold nobody ever polls does not leak.
   */
  private readonly resolved = new Map<string, { outcome: ModHoldOutcome; at: number }>();
  /**
   * The keys whose outcome has been handed over, kept as long as a tombstone would be. A call is
   * held once: a request for it after its outcome left is answered `settled-elsewhere`, never
   * accepted as a new hold.
   */
  private readonly delivered = new Map<string, number>();
  private readonly deps: ModHoldDeps;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Every wait parked on a session, by its wake function. A wait sleeps until one of these is called
   * or its one timer runs out, and then reads the hold again: nothing is polled on a clock.
   */
  private readonly waits = new Map<string, Set<() => void>>();
  /**
   * The terminal's own hold legs parked on each hold, by hold key. While one of them can still carry
   * an answer, the terminal is still asking, and the hold's lease is renewed whenever it is read.
   */
  private readonly askers = new Map<string, Set<() => boolean>>();
  /**
   * The card ids drawn for each session, newest last and bounded. A card id is used once: the app
   * remembers a settled id, and a second card under it would be drawn settled. It is also how a
   * late tap on a card whose id this broker did not mint is still known to be a mod card.
   */
  private readonly drawnCardIds = new Map<string, string[]>();

  constructor(deps: ModHoldDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.leaseMs = deps.leaseMs ?? HOLD_LEASE_MS;
    this.sleep = deps.sleep ?? abortableSleep;
  }

  /**
   * Holds are keyed by the registration that opened them, not just by the session.
   *
   * `generation` is the registry's counter for the session, so the key of a hold opened by a
   * process that has since died can never be reached by the process that took the session over.
   * The same rule covers the resolved tombstones below, which is what stops a settled outcome
   * being delivered "to the next live poll" across a generation boundary.
   */
  private key(sessionId: string, generation: number, requestId: string): string {
    return `${sessionId}\u0000${generation}\u0000${requestId}`;
  }

  private currentGeneration(sessionId: string): number {
    return this.deps.registry.generation(sessionId);
  }

  private keyNow(sessionId: string, requestId: string): string {
    return this.key(sessionId, this.currentGeneration(sessionId), requestId);
  }

  /**
   * The id the app's card for this call carries, recorded as drawn.
   *
   * A question names the call by Claude's `tool_use` id, which is the id the transcript draws the
   * same question under, so the app keeps one card. A permission, a question with no `tool_use` id,
   * and a `tool_use` id this session already drew a card for (a resumed process asking the same
   * call again) get a minted id.
   */
  cardIdFor(sessionId: string, hold: Pick<ModHoldMessage, 'requestId' | 'toolUseId' | 'questions' | 'questionsUnreadable'>): string {
    const question = hold.questions !== undefined || hold.questionsUnreadable === true;
    const drawn = this.drawnCardIds.get(sessionId) ?? [];
    const cardId = question && hold.toolUseId && !drawn.includes(hold.toolUseId)
      ? hold.toolUseId
      : modCardRequestId(hold.requestId);
    drawn.push(cardId);
    if (drawn.length > DRAWN_CARD_IDS_PER_SESSION) drawn.splice(0, drawn.length - DRAWN_CARD_IDS_PER_SESSION);
    // Newest session last, so the one dropped when there are too many is the longest quiet.
    this.drawnCardIds.delete(sessionId);
    this.drawnCardIds.set(sessionId, drawn);
    if (this.drawnCardIds.size > DRAWN_CARD_SESSIONS) {
      const oldest = this.drawnCardIds.keys().next().value;
      if (oldest !== undefined) this.drawnCardIds.delete(oldest);
    }
    return cardId;
  }

  /** Whether this session was drawn a card under this id, held, settled or released. */
  drewCard(sessionId: string, cardId: string): boolean {
    return this.drawnCardIds.get(sessionId)?.includes(cardId) === true;
  }

  /** Every open hold on this session, across generations. Used only to close them. */
  openHoldIdsForSession(sessionId: string): string[] {
    const out: string[] = [];
    for (const record of this.holds.values()) if (record.sessionId === sessionId) out.push(record.requestId);
    return out;
  }

  get(sessionId: string, requestId: string): ModHoldRecord | undefined {
    return this.holds.get(this.keyNow(sessionId, requestId));
  }

  /**
   * The open hold an app card stands for, by the card's own id, and only while the registration
   * that opened it is still the session's. Every answer from the app comes in through this.
   */
  byCard(sessionId: string, appRequestId: string): ModHoldRecord | undefined {
    for (const record of this.holds.values()) {
      if (record.sessionId !== sessionId || record.appRequestId !== appRequestId) continue;
      // A lapsed hold is over whether or not the sweep has reached it yet.
      if (this.lapsed(record)) return undefined;
      return this.get(sessionId, record.requestId) === record ? record : undefined;
    }
    return undefined;
  }

  /**
   * Whether the terminal has stopped asking about this hold.
   *
   * Nothing else ends a wait on the clock. A terminal that is still parked on the hold is still
   * waiting on the answer, however long ago the call was made; one that has gone quiet for a whole
   * lease has handed the call back or died, and an answer now would decide a call nobody runs.
   */
  private lapsed(record: ModHoldRecord): boolean {
    this.renewFromAskers(record);
    return this.now() - record.renewedAt >= this.leaseMs;
  }

  /**
   * Renew the lease while a hold leg parked on this hold can still carry an answer.
   *
   * The lease is read, not ticked: a parked hold leg used to renew it every 50 ms by waking to do so.
   * Renewing at each read gives every reader the same answer that ticking did, and a terminal that
   * is parked and still connected is never read as having stopped asking.
   */
  private renewFromAskers(record: ModHoldRecord): void {
    const askers = this.askers.get(this.key(record.sessionId, record.generation, record.requestId));
    if (!askers) return;
    for (const claimIsLive of askers) {
      if (claimIsLive()) {
        record.renewedAt = this.now();
        return;
      }
    }
  }

  /** How long until this hold's lease runs out, as of now. */
  private leaseLeft(record: ModHoldRecord): number {
    return this.leaseMs - (this.now() - record.renewedAt);
  }

  /**
   * Wake every wait parked on this session, so each reads its hold again.
   *
   * The store wakes its own waits whenever a hold settles or an outcome comes back. The socket
   * server calls this for what the store cannot see: a registration replaced, a session ended.
   */
  wake(sessionId: string): void {
    const waiting = this.waits.get(sessionId);
    if (!waiting) return;
    this.waits.delete(sessionId);
    for (const wake of waiting) wake();
  }

  /**
   * Sleep until something can change a wait's answer: a wake, the caller's signal, or `ms`.
   *
   * One timer per call, cleared when anything else ends the sleep first.
   */
  private park(sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = new AbortController();
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        const waiting = this.waits.get(sessionId);
        if (waiting) {
          waiting.delete(wake);
          if (waiting.size === 0) this.waits.delete(sessionId);
        }
        signal?.removeEventListener('abort', wake);
        timer.abort();
        resolve();
      };
      const waiting = this.waits.get(sessionId) ?? new Set<() => void>();
      waiting.add(wake);
      this.waits.set(sessionId, waiting);
      if (signal?.aborted) {
        wake();
        return;
      }
      signal?.addEventListener('abort', wake, { once: true });
      void this.sleep(ms, timer.signal).then(wake, wake);
    });
  }

  /** Refuse an answer to a lapsed hold, closing the hold the way the lease does. */
  private refusedAsLate(record: ModHoldRecord, what: string): boolean {
    if (!this.lapsed(record)) return false;
    this.deps.log?.(`mod ${what} late answer dropped session=${record.sessionId} request=${record.requestId} (its terminal stopped asking)`);
    this.expire(record.sessionId, record.requestId);
    return true;
  }

  /**
   * A `hold` arrived: decide now, hold or release, and never leave the mod guessing.
   *
   * A duplicate `hold` for an open request id is the same call re-offered after a transport
   * retry, so it reports the current state rather than opening a second card for one tool call.
   */
  accept(hold: ModHoldMessage): ModHoldOutcome {
    const generation = this.currentGeneration(hold.sessionId);
    const key = this.key(hold.sessionId, generation, hold.requestId);
    const existing = this.holds.get(key);
    if (existing) {
      // The same call offered again is the terminal still asking about it.
      existing.renewedAt = this.now();
      return { kind: 'held' };
    }

    // Already settled. This is not a rare race: the app answers between two of the mod's polls
    // more often than during one, and the mod re-offers the call on its next poll. Re-opening it
    // there put a live record where the settled outcome was waiting, and the verdict poll only
    // reads the tombstone when no record exists -- so the answer the user gave was swallowed and
    // the terminal sat on its dialog until the hold gave up. Hand over what was decided.
    const settled = this.resolved.get(key);
    if (settled) {
      this.resolved.delete(key);
      this.markDelivered(key);
      return settled.outcome.kind === 'held' ? { kind: 'held' } : settled.outcome;
    }
    if (this.delivered.has(key)) return { kind: 'settled-elsewhere' };

    const inputs = this.deps.gate(hold.sessionId);
    const question = hold.questions !== undefined || hold.questionsUnreadable === true;
    let decision = decideModHold(inputs, question ? 'question' : 'permission');
    // A question the app cannot answer the way the tool will take it is not held for the app: the
    // card would collect an answer the terminal then throws away, and say Sent. It is shown
    // read-only instead, and answered in Claude's own picker.
    if (decision.hold && (hold.questionsUnreadable === true || (hold.questions !== undefined && !modQuestionsAnswerable(hold.questions)))) {
      decision = { hold: false, why: 'question:terminal-only', mode: decision.mode };
    }
    // A plan is shown, not approved, from the app: see `plan:terminal-only`.
    if (decision.hold && hold.tool === PLAN_APPROVAL_TOOL) {
      decision = { hold: false, why: 'plan:terminal-only', mode: decision.mode };
    }
    const modeSeen = decision.mode ?? 'unknown';

    if (!decision.hold) {
      // Recorded as a release, not a decision: nobody approved anything and the trail must not
      // imply that it did.
      this.deps.audit.record({
        sessionId: hold.sessionId,
        requestId: hold.requestId,
        tool: hold.tool,
        engineVerdict: hold.decision || 'ask',
        modeSeen,
        answeredBy: 'cancel',
        durationMs: 0,
        released: decision.why,
        ...(hold.input ? { inputDigest: modInputDigest(hold.input) } : {}),
      });
      this.settle(hold.sessionId, generation, hold.requestId, { kind: 'released', why: decision.why });
      this.deps.onRelease?.(hold.sessionId, hold, decision.why, decision.mode);
      return { kind: 'released', why: decision.why };
    }

    const record: ModHoldRecord = {
      sessionId: hold.sessionId,
      requestId: hold.requestId,
      generation,
      appRequestId: this.cardIdFor(hold.sessionId, hold),
      tool: hold.tool,
      engineVerdict: hold.decision || 'ask',
      modeSeen,
      ...(hold.input ? { inputDigest: modInputDigest(hold.input) } : {}),
      ...(hold.input ? { inputPreview: hold.input } : {}),
      ...(hold.detail ? { inputDetail: hold.detail } : {}),
      ...(hold.questions === undefined ? {} : { questions: hold.questions }),
      startedAt: this.now(),
      renewedAt: this.now(),
      polls: 0,
    };
    this.holds.set(this.key(hold.sessionId, generation, hold.requestId), record);
    this.deps.registry.openHold(hold.sessionId, hold.requestId);
    this.deps.onHoldAccepted?.(record);
    return { kind: 'held', first: true };
  }

  /**
   * Wait for a hold's outcome: up to `waitMs`, returning the moment the hold resolves by any route.
   *
   * The wait sleeps on one timer, its own end or the hold's lease, and wakes early for anything that
   * can change its answer: the hold settling (an answer, a cancel, an expiry), an outcome put back,
   * a `wake` for the session, or `signal`. It used to wake every 50 ms to look, which was about
   * twenty wakeups a second per leg for as long as a card stayed open, and a hold has no deadline.
   * A wait ended by `signal` answers `held`: the caller has something else to say first.
   *
   * `charge` says this is the terminal's own hold leg asking about this call, rather than its poll
   * leg carrying an outcome it happens to find. Only the hold leg renews the lease, and only while
   * `claimIsLive` says its connection can still carry an answer: a parked request from a terminal
   * that has gone away must not keep its card open, which is the whole job of the lease.
   *
   * `claimIsLive` is asked again just before the resolved verdict is taken, and the verdict is
   * handed over only while it says yes. A waiter whose connection has closed, or whose
   * registration has been replaced, cannot deliver an answer it takes, and a consumed answer is
   * gone for everybody: the tier-2 smoke watched one such waiter swallow the app's reply and
   * leave the live terminal parked for 45 s on a call the user had already approved. A dead
   * claimant is answered `held`, which asks for nothing and leaves the verdict where the next
   * live poll can reach it.
   */
  async pollVerdict(
    sessionId: string,
    requestId: string,
    waitMs: number,
    charge = true,
    claimIsLive: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<ModHoldOutcome> {
    const counted = this.get(sessionId, requestId);
    if (counted && charge) counted.polls += 1;
    const pollDeadline = this.now() + waitMs;
    const askerKey = this.keyNow(sessionId, requestId);
    if (charge) {
      const askers = this.askers.get(askerKey) ?? new Set<() => boolean>();
      askers.add(claimIsLive);
      this.askers.set(askerKey, askers);
    }
    try {
      for (;;) {
        const record = this.get(sessionId, requestId);
        if (!record) {
          return claimIsLive() ? this.takeResolved(sessionId, requestId) : { kind: 'held' };
        }
        // `lapsed` renews the lease first while this hold leg, or another, can still carry an answer.
        if (this.lapsed(record)) {
          // Notified, like every other exit. It used to be silent, which left a card the user could
          // still tap after cosyncing had stopped waiting on it, and the tap came back "Approved"
          // for a call the terminal had already been handed.
          this.stop(sessionId, requestId, { kind: 'expired' }, 'expired', true, record, 'deadline');
          return { kind: 'expired' };
        }
        const remaining = pollDeadline - this.now();
        if (remaining <= 0 || signal?.aborted) return { kind: 'held' };
        await this.park(sessionId, Math.max(1, Math.min(remaining, this.leaseLeft(record))), signal);
      }
    } finally {
      if (charge) {
        const askers = this.askers.get(askerKey);
        askers?.delete(claimIsLive);
        if (askers && askers.size === 0) this.askers.delete(askerKey);
      }
    }
  }

  /**
   * Settle a hold with a human decision. False means there was nothing to settle, which is the
   * late-answer case: the answer is dropped and logged, never queued.
   */
  answer(sessionId: string, requestId: string, behavior: 'allow' | 'deny', source: ModDecisionSource): boolean {
    const record = this.holds.get(this.keyNow(sessionId, requestId));
    if (!record) {
      // Spec rule 3. A dropped-but-unlogged late answer is invisible, and invisible is how
      // this class of bug survived a whole probe cycle.
      this.deps.log?.(
        `mod hold late answer dropped session=${sessionId} request=${requestId} behavior=${behavior} source=${source}` +
          ` (${this.deps.registry.hasOpenHold(sessionId, requestId) ? 'hold no longer open' : 'never held'})`,
      );
      return false;
    }
    if (this.refusedAsLate(record, 'hold')) return false;
    const outcome: ModHoldOutcome = { kind: 'verdict', behavior, source };
    this.stop(sessionId, requestId, outcome, source, true, record);
    return true;
  }

  /**
   * Settle a question hold with the answer the app collected.
   *
   * This is not the command queue. A mod parked on a `hold` long-poll is not parked on its poll
   * leg at the same time, so an answer handed over as a queued command sits unread until the hold
   * ends by itself, which is how an app answer to a question used to do nothing at all. Resolving
   * the hold wakes the leg that is actually waiting, and the tombstone carries the answers for
   * whichever leg gets there first.
   */
  answerQuestion(sessionId: string, requestId: string, answers: unknown): boolean {
    const record = this.holds.get(this.keyNow(sessionId, requestId));
    if (!record) {
      this.deps.log?.(`mod question late answer dropped session=${sessionId} request=${requestId} (never held or already resolved)`);
      return false;
    }
    if (this.refusedAsLate(record, 'question')) return false;
    this.stop(sessionId, requestId, { kind: 'answered', answers, source: 'app' }, 'app', true, record);
    return true;
  }

  /** Close a hold because its turn ended, the human escaped it, or the transport went. */
  cancel(sessionId: string, requestId: string, reason: ModHoldCancelReason, via?: ModCancelVia): boolean {
    if (!this.holds.has(this.keyNow(sessionId, requestId))) return false;
    this.stop(sessionId, requestId, { kind: 'cancelled', why: reason, ...(via ? { via } : {}) }, reason === 'deadline' ? 'expired' : 'cancel', true, undefined, reason);
    return true;
  }

  /** A lapsed lease: the terminal stopped asking, so nothing is waiting on an answer any more. */
  expire(sessionId: string, requestId: string): boolean {
    if (!this.holds.has(this.keyNow(sessionId, requestId))) return false;
    // Named `deadline` in the audit and on the wire, the same way the poll path names it. "Why did
    // my terminal get the dialog back" is the first question anyone asks, and a null reason
    // answers nothing.
    this.stop(sessionId, requestId, { kind: 'expired' }, 'expired', true, undefined, 'deadline');
    return true;
  }

  /**
   * Close the holds this session can no longer carry, and return their ids.
   *
   * Two different deaths live here, and both were missing. A hold whose terminal stopped asking
   * used to expire only inside a verdict poll -- which a mod that stopped polling never enters, so
   * its card stayed live for ever after cosyncing had stopped waiting for it. And a row that went
   * stale, dead or replaced cannot carry an answer either, so nothing should still be waiting on
   * one; `carried: false` closes whatever it has open.
   */
  sweep(sessionId: string, carried: boolean): string[] {
    const prefix = `${sessionId}\u0000`;
    const closed: string[] = [];
    for (const [key, record] of [...this.holds]) {
      if (!key.startsWith(prefix)) continue;
      if (!carried) {
        if (this.cancel(sessionId, record.requestId, 'transport')) closed.push(record.requestId);
        continue;
      }
      if (this.lapsed(record)) {
        if (this.expire(sessionId, record.requestId)) closed.push(record.requestId);
      }
    }
    return closed;
  }

  /**
   * Put a handed-over outcome back, because the response carrying it never left this process.
   *
   * An outcome is handed over once, and the record of that is what tells the other leg the call is
   * settled. So an answer written into a dead connection was lost to both legs: the hold leg was told
   * "settled elsewhere" and waited for an outcome the poll leg had never carried. Only an outcome
   * this store handed over, for the registration that is the session's now, can come back.
   */
  putBack(sessionId: string, requestId: string, outcome: ModHoldOutcome): boolean {
    const key = this.keyNow(sessionId, requestId);
    if (!this.delivered.has(key) || this.resolved.has(key) || this.holds.has(key)) return false;
    this.delivered.delete(key);
    this.resolved.set(key, { outcome, at: this.now() });
    this.wake(sessionId);
    return true;
  }

  /** Every session with a hold still open, so a sweep can reach the ones nobody is looking at. */
  openSessionIds(): string[] {
    return [...new Set([...this.holds.values()].map((record) => record.sessionId))];
  }

  /** Drop the tombstones that have outlived any poll that could still read them. */
  trim(): void {
    this.trimTombstones();
  }

  openCount(): number {
    return this.holds.size;
  }

  /** Everything the app may still answer, newest last. */
  openHolds(): ModHoldRecord[] {
    return [...this.holds.values()];
  }

  /** True while a hold is still open, which is the only window in which an answer is legal. */
  isOpen(sessionId: string, requestId: string): boolean {
    return this.holds.has(this.keyNow(sessionId, requestId));
  }

  /**
   * A request worth long-polling for on this session: one still open, or one whose verdict has
   * landed and not yet been carried to the mod.
   *
   * Without the second half, an answer that arrives between two polls is written to the
   * tombstone and then never read, because the poll path only looks at open holds. The verdict
   * would be stranded in the broker and the band would sit there holding a call nobody is
   * holding any more.
   */
  pollableRequest(sessionId: string): string | undefined {
    const open = this.deps.registry.openHoldIds(sessionId);
    if (open.length > 0) return open[0];
    // Scoped to the live registration on purpose. A settled outcome from a previous process is
    // not "something the next poll should carry"; it is a verdict for a call that no longer
    // exists, and delivering it to whoever resumes is how one call's answer decides another.
    const prefix = `${sessionId}\u0000${this.currentGeneration(sessionId)}\u0000`;
    for (const key of this.resolved.keys()) {
      if (key.startsWith(prefix)) return key.slice(prefix.length);
    }
    return undefined;
  }

  private settle(sessionId: string, generation: number, requestId: string, outcome: ModHoldOutcome): void {
    this.trimTombstones();
    this.resolved.set(this.key(sessionId, generation, requestId), { outcome, at: this.now() });
  }

  private takeResolved(sessionId: string, requestId: string): ModHoldOutcome {
    const key = this.keyNow(sessionId, requestId);
    const settled = this.resolved.get(key);
    if (!settled) return this.delivered.has(key) ? { kind: 'settled-elsewhere' } : { kind: 'unknown' };
    this.resolved.delete(key);
    this.markDelivered(key);
    return settled.outcome;
  }

  private markDelivered(key: string): void {
    this.trimTombstones();
    this.delivered.set(key, this.now());
  }

  private trimTombstones(): void {
    const cutoff = this.now() - RESOLVED_TOMBSTONE_MS;
    for (const [key, entry] of this.resolved) if (entry.at < cutoff) this.resolved.delete(key);
    for (const [key, at] of this.delivered) if (at < cutoff) this.delivered.delete(key);
  }

  /**
   * The one exit path for a resolved hold: delete the row, close the registry's open-hold
   * entry, write the audit row, publish the one-shot outcome, and notify the app once.
   *
   * `record` is passed in by `answer` because the caller has already looked it up; everywhere
   * else it is fetched here so there is only one place that knows how a hold is torn down.
   */
  private stop(
    sessionId: string,
    requestId: string,
    outcome: ModHoldOutcome,
    answeredBy: ModDecisionSource | 'cancel',
    notify: boolean,
    known?: ModHoldRecord,
    releaseNote?: string,
  ): void {
    const key = this.keyNow(sessionId, requestId);
    const record = known ?? this.holds.get(key);
    if (!record) return;
    this.holds.delete(key);
    this.deps.registry.closeHold(sessionId, requestId);
    this.deps.audit.record({
      sessionId,
      requestId,
      tool: record.tool,
      engineVerdict: record.engineVerdict,
      modeSeen: record.modeSeen,
      answeredBy,
      durationMs: Math.max(0, this.now() - record.startedAt),
      polls: record.polls,
      ...(releaseNote ? { released: releaseNote } : {}),
      ...(record.inputDigest ? { inputDigest: record.inputDigest } : {}),
    });
    this.settle(sessionId, record.generation, requestId, outcome);
    // Whatever was waiting on this hold reads the outcome now, not at its next timer.
    this.wake(sessionId);
    if (notify) this.deps.onResolve?.(sessionId, requestId, outcome, answeredBy, record);
  }
}

/**
 * A card id: the mod's id for readability in a log, and a random tail that makes it this hold's
 * alone. The tail is what a stale tap cannot guess, so it is never derived from anything the mod,
 * the session or the clock would repeat.
 */
export function modCardRequestId(modRequestId: string): string {
  return `${modRequestId}@${randomBytes(8).toString('hex')}`;
}

/**
 * Whether an id the app sent is one this broker minted for a mod card -- held, settled or long
 * gone -- or one an older broker sent as the bare mod id. Either way it is the mod's to refuse:
 * no adapter connection ever drew a card under it.
 */
export function isModCardRequestId(requestId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}@[0-9a-f]{16}$/.test(requestId) || /^cm-[0-9]{1,9}$/.test(requestId);
}
