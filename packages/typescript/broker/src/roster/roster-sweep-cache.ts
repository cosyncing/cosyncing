/**
 * Single-flight cache for whole-roster discovery sweeps.
 *
 * N concurrent `/api/sessions` polls (one per open tab, every 6s) share ONE
 * full-disk sweep instead of each starting their own, and a caller that already
 * has rows is served them while a fresh sweep runs behind it.
 *
 * Extracted from the broker runtime because its rules are reachable only under
 * timing a request-level test cannot arrange -- a caller joining a sweep before
 * its first leg has landed, and the correction that has to follow an early
 * answer. Each was wrong in the runtime and none had a test, because there was
 * nowhere to write one. The state machine is the whole point; the sweep itself,
 * its logging and what a completed sweep means to the rest of the broker stay
 * with the caller.
 *
 * Nothing here interprets a row. `T` is the caller's row type and the answer
 * arrays are never mutated -- callers copy before overlaying live state.
 */

/**
 * How much of the roster a set of rows represents.
 *
 * Two kinds of incompleteness, deliberately not collapsed into one boolean,
 * because the caller must treat them differently:
 *
 * - `sweeping`: a sweep is still running and these are the legs that have
 *   landed. Seconds old at most and about to be superseded. Rows MISSING here
 *   are missing only because nobody has looked yet, so this answer must never
 *   be journalled -- reconciling it would emit removals for rows a leg is
 *   still on its way to reporting, and every connected client would watch them
 *   vanish and come back.
 * - `incomplete`: the sweep settled without reading every adapter -- a leg was
 *   abandoned at its budget or threw. This one CAN persist, so it must still
 *   reconcile: treating it like `sweeping` would mean a machine with one
 *   permanently slow adapter never removed a deleted session again.
 *
 * A statement about coverage, not freshness. Rows from a finished sweep stay
 * `complete` as they age; `generatedAt` is what says how old they are.
 */
export type RosterCoverage =
  | { readonly kind: 'complete' }
  | { readonly kind: 'sweeping' }
  | {
      readonly kind: 'incomplete';
      /**
       * Backends whose rows this answer could not speak for.
       *
       * Carried, not merely counted, because absence has to be attributable. A
       * roster missing an adapter's rows is authoritative about every OTHER
       * adapter -- a session really deleted under a healthy backend must still
       * be removed -- so the caller reconciles normally and withholds removals
       * for exactly these ids. Without the list the only safe options are to
       * remove rows that still exist or to stop removing anything at all.
       */
      readonly withheld: readonly string[];
    };

/** The coverage of an answer that spoke for every backend. */
export const ROSTER_COVERAGE_COMPLETE: RosterCoverage = Object.freeze({ kind: 'complete' });
/** The coverage of an answer taken while its sweep was still running. */
export const ROSTER_COVERAGE_SWEEPING: RosterCoverage = Object.freeze({ kind: 'sweeping' });

/** One discovery leg, as the sweep observed it finishing. */
export interface RosterSweepLeg {
  readonly id: string;
  /**
   * Rows the leg returned -- NOT evidence that it read anything.
   *
   * An abandoned or failed leg returns its carry: the rows of the last sweep
   * that did read this adapter. Present here for the same reason the sweep log
   * prints it, and deliberately not consulted by {@link unconfirmedBackends}.
   */
  readonly rows: number;
  readonly abandoned: boolean;
  readonly failed: boolean;
}

/**
 * The backends a settled sweep did not actually read.
 *
 * Row count is not part of this decision, and the tempting version that made it
 * part is wrong in the direction that matters. A leg abandoned at its budget
 * still returns rows -- its carry -- and a carry is a snapshot of the last sweep
 * that DID read the adapter. It cannot mention anything that appeared since, so
 * a session the journal already knows about is simply absent from it. Grant such
 * a leg removal authority and that absence retires a row that exists.
 *
 * The empty-carry case is only the visible extreme of the same fault, not a
 * different one.
 */
export function unconfirmedBackends(legs: readonly RosterSweepLeg[]): string[] {
  return legs.filter((leg) => leg.abandoned || leg.failed).map((leg) => leg.id);
}

/** Backends whose rows [coverage] cannot speak for; empty unless incomplete. */
export function withheldBackends(coverage: RosterCoverage): readonly string[] {
  return coverage.kind === 'incomplete' ? coverage.withheld : [];
}

/**
 * Rows and their coverage.
 *
 * Coverage travels WITH the rows rather than being read back off the cache
 * afterwards. A sweep landing between the answer and the question would flip a
 * re-read flag and label a partial answer complete, which is the one mistake
 * this field exists to prevent.
 */
export interface RosterSweepAnswer<T> {
  rows: T[];
  coverage: RosterCoverage;
}

export interface RosterSweepSnapshot<T> extends RosterSweepAnswer<T> {
  /**
   * When these rows were taken.
   *
   * A snapshot SEEDED from a single leg keeps its sweep's start time rather than
   * the moment the leg landed, so a late leg cannot extend the TTL and make an
   * incomplete roster look freshly complete.
   */
  at: number;
}

export interface RosterSweepCacheOptions {
  /** How long one sweep result may be reused before a fresh sweep is started. */
  ttlMs: number;
  /**
   * How far past the TTL previous rows may still be served while a sweep runs.
   * Past it, callers wait on the real sweep and get its error rather than rows
   * from before discovery started failing.
   */
  staleServeMaxMs: number;
  /**
   * How long a caller with nothing to show waits for the WHOLE sweep before
   * being answered with the legs that have landed.
   */
  coldPartialMs: number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface RosterSweepRead<T> {
  key: string;
  /** `?refresh=1`: asks for this exact sweep, and is never answered early. */
  force: boolean;
  /**
   * Whether this caller may be handed a roster taken mid-sweep.
   *
   * False for a caller that cannot read the completeness of what it is given --
   * in practice a client older than the contract revision that introduced the
   * flag. Such a caller reads every roster as an authoritative replacement, so
   * an early answer would show it the missing sessions as deleted ones, which is
   * precisely the harm the flag exists to prevent. It waits for the sweep
   * instead, which is exactly what it did before early answers existed.
   *
   * Only `sweeping` is withheld. A settled sweep that lost a leg is served to
   * everyone: that is the state the broker has been serving all along, and
   * withholding it would mean never answering such a caller at all.
   */
  allowSweeping: boolean;
  /** The caller's own clock reading, so one request judges freshness once. */
  now: number;
  /** Builds AND starts the sweep. Invoked only by the read that starts one. */
  startSweep: () => Promise<RosterSweepAnswer<T>>;
  /**
   * A caller has been answered with rows the running sweep may supersede --
   * either a partial snapshot or a stale one.
   *
   * Fires at most once per sweep, with that sweep, and exists because answering
   * ahead of a sweep is only safe if something puts its result in front of the
   * client afterwards. A caller that ignores this leaves clients holding the
   * superseded answer until an unrelated change happens to disturb them.
   *
   * Both cases, not just the partial one. Stale-while-revalidate has exactly the
   * same hole and it is the one an ordinary reconnect takes.
   */
  onServedAheadOfSweep?: (sweep: Promise<RosterSweepAnswer<T>>) => void;
  /** A failure nobody is left awaiting. Without this it is silent. */
  onDetachedFailure?: (error: unknown) => void;
}

export class RosterSweepCache<T> {
  private readonly snapshots = new Map<string, RosterSweepSnapshot<T>>();
  private readonly inflight = new Map<string, Promise<RosterSweepAnswer<T>>>();
  /** Sweeps for which `onServedAheadOfSweep` has already fired. */
  private readonly servedAhead = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: RosterSweepCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  snapshot(key: string): RosterSweepSnapshot<T> | undefined {
    return this.snapshots.get(key);
  }

  /**
   * Fold one settled leg into the served snapshot, seeding the window when this
   * is the first leg of its first sweep.
   *
   * Seeding is what makes an early answer possible at all: without it the first
   * sweep of a window has no snapshot to merge into, so every landed leg is held
   * until the slowest one finishes.
   *
   * Always `sweeping`, including when it merges into rows a finished sweep left.
   * One leg replacing its own rows inside a complete snapshot leaves a roster
   * that is no longer the answer any single sweep gave, and the caller has no
   * way to tell which part is which.
   */
  seedLeg(key: string, sweepStartedAt: number, merge: (existing: T[]) => T[]): void {
    const snapshot = this.snapshots.get(key);
    this.snapshots.set(key, {
      at: snapshot?.at ?? sweepStartedAt,
      rows: merge(snapshot?.rows ?? []),
      coverage: ROSTER_COVERAGE_SWEEPING,
    });
  }

  /** Replace a window's rows with a settled sweep's answer. */
  publish(key: string, answer: RosterSweepAnswer<T>, at: number = this.now()): void {
    this.snapshots.set(key, { at, rows: answer.rows, coverage: answer.coverage });
  }

  async read(read: RosterSweepRead<T>): Promise<RosterSweepAnswer<T>> {
    const { key, force, now } = read;
    const snapshot = this.snapshots.get(key);
    // A snapshot seeded mid-sweep is withheld from a caller that cannot read its
    // coverage, on EVERY path that would serve it -- including a TTL hit, which
    // is how a partial reaches a second caller seconds after the first was
    // bounded out of the sweep that produced it.
    const cached = snapshot !== undefined && !read.allowSweeping && snapshot.coverage.kind === 'sweeping'
      ? undefined
      : snapshot;
    if (!force && cached && now - cached.at < this.options.ttlMs) return answerOf(cached);

    const pending = this.inflight.get(key);
    if (pending) {
      // Joining a running sweep is still the full remaining wait. A caller
      // holding usable rows takes them; only a caller with NOTHING to show, or
      // one that forced a refresh, has a reason to wait at all.
      if (!force && cached && now - cached.at < this.options.staleServeMaxMs) {
        return this.serveAhead(key, cached, pending, read);
      }
      // ...and a caller with nothing to show is bounded exactly like the one
      // that STARTED the sweep. It used to fall through to the bare `pending`
      // promise, so the bound protected only whichever request happened to be
      // first: the second tab to open against a cold broker waited out the same
      // unbounded sweep the bound exists to prevent, and on a cold broker every
      // request is racing the same first sweep.
      return force ? pending : await this.boundedPartial(key, pending, read);
    }

    const sweep = read
      .startSweep()
      .then((answer) => {
        this.publish(key, answer);
        return answer;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.servedAhead.delete(key);
      });
    this.inflight.set(key, sweep);

    if (!force && !cached) return await this.boundedPartial(key, sweep, read);
    if (!force && cached && now - cached.at < this.options.staleServeMaxMs) {
      return this.serveAhead(key, cached, sweep, read);
    }
    return sweep;
  }

  /**
   * Wait a bounded time for the whole sweep, then answer with whatever has
   * landed.
   *
   * The bound is per CALLER rather than per sweep. A joiner arriving late into a
   * bad sweep would otherwise be handed a partial answer with no wait at all,
   * when a moment more might have completed it; and the thing being bounded is
   * how long any one request can be made to wait, not how old the sweep is.
   */
  private async boundedPartial(
    key: string,
    sweep: Promise<RosterSweepAnswer<T>>,
    read: RosterSweepRead<T>,
  ): Promise<RosterSweepAnswer<T>> {
    // Nothing to answer early WITH for such a caller: the only thing a running
    // sweep can offer is a partial, and it may not have one.
    if (!read.allowSweeping) return sweep;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      sweep,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.options.coldPartialMs);
      }),
    ]);
    // Or the timer holds the event loop open for the rest of its delay after a
    // sweep that answered in time.
    if (timer !== undefined) clearTimeout(timer);
    if (settled !== undefined) return settled;

    const seeded = this.snapshots.get(key);
    // Only with something to show. With no leg landed there is nothing to prefer
    // over waiting, and an empty roster reads as "no sessions" rather than "not
    // yet" -- a caller cannot tell the difference and would write it down.
    if (!seeded || seeded.rows.length === 0) return sweep;
    return this.serveAhead(key, seeded, sweep, read);
  }

  /**
   * Hand back rows the running sweep may supersede, and make sure something
   * follows up.
   *
   * Stale-while-revalidate used only to OBSERVE the sweep for failure, which is
   * how an ordinary reconnect could sit on rows that were already out of date.
   * The sweep's own cache write is invisible to a client: the snapshot moves,
   * the roster revision does not, and `/api/sessions` answers 304 on the
   * unchanged revision WITHOUT reaching discovery again -- so the poll that
   * would have picked the new rows up never runs. Nothing broke the loop until
   * the periodic safety reconcile or an unrelated live mutation, which for a
   * terminal-started session with no live owner is a minutes-long absence from a
   * roster it belongs in.
   */
  private serveAhead(
    key: string,
    snapshot: RosterSweepSnapshot<T>,
    sweep: Promise<RosterSweepAnswer<T>>,
    read: RosterSweepRead<T>,
  ): RosterSweepAnswer<T> {
    if (!this.servedAhead.has(key)) {
      this.servedAhead.add(key);
      read.onServedAheadOfSweep?.(sweep);
    }
    this.observe(sweep, read);
    return answerOf(snapshot);
  }

  /**
   * Report a rejection on a sweep nobody is awaiting.
   *
   * `Promise.race` above already counts as a handler, so this is not about
   * unhandled rejections: it is that a sweep failing every time would otherwise
   * go on serving rows from before the first failure with nothing said.
   */
  private observe(sweep: Promise<RosterSweepAnswer<T>>, read: RosterSweepRead<T>): void {
    void sweep.catch((error: unknown) => read.onDetachedFailure?.(error));
  }
}

function answerOf<T>(snapshot: RosterSweepSnapshot<T>): RosterSweepAnswer<T> {
  return { rows: snapshot.rows, coverage: snapshot.coverage };
}
