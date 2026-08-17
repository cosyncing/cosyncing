/**
 * Broker-owned lifecycle for an EXTERNAL host process — one this broker may
 * start, but which also exists perfectly well without it.
 *
 * `kimi web` and `dsh web` are the cases. Both are ordinary programs a user runs
 * in their own terminal, and both are things the broker would like to start on
 * their behalf. Those two facts are what make this hard: the moment the broker
 * is willing to START a host, it must also be able to say — later, from a
 * different process, after a reboot, against a pid the OS may have recycled —
 * whether the host now listening is the one it started or the user's own.
 *
 * THE RULE, and it is absolute: cosyncing stops or replaces ONLY a process it
 * can PROVE it started. Everything it cannot prove is left strictly alone. Not
 * adopted, not signalled, not disposed — preserved, and reported. A wrong answer
 * here kills a stranger's work, so every ambiguity resolves toward doing
 * nothing.
 *
 * Proof is a durable record ({@link ManagedHostOwnership}) written at spawn and
 * re-verified against the live process:
 *
 *   pid            the record's process id
 *   start          a locale-free start token — defeats pid REUSE, because a
 *                  recycled pid necessarily started at a different time
 *   boot           the boot this record was written in — defeats REBOOT, which
 *                  is what makes the Linux start token safe to compare at all
 *   identityKey    the address or home the record was written for, so a record
 *                  proves nothing about a host at some other location
 *
 * All four must match. Any mismatch, missing record, or unreadable live identity
 * is 'foreign' or 'indeterminate', and both mean hands off.
 *
 * THE COMMAND NAME IS NOT PART OF THE PROOF, and it is worth saying why, because
 * it reads like the most obvious thing to check. `/proc/<pid>/comm` is writable
 * by the process itself — `prctl(PR_SET_NAME)`, or Node's `process.title` — so
 * it is a label a host may change at any moment, not an identity it is stuck
 * with. Both hosts this product manages do change it: Kimi's launcher is
 * recorded as `kimi` and later reads `kimi-code`, and `dsh` is a
 * `#!/usr/bin/env node` script that reads `node` once its interpreter is up.
 * Comparing it declared this broker's own children foreign — which left them
 * running at shutdown with their records cleared, the exact leak this module
 * exists to prevent.
 *
 * Nothing is lost by dropping it. Its job was to separate a recycled pid that
 * happens to share a start tick, and the start tick already does that alone: two
 * processes cannot hold one pid at one tick in one boot without the whole pid
 * space wrapping inside a single 10ms tick. It stays in the record as evidence
 * an operator can read.
 *
 * NOTHING HERE IS TWO-VALUED. The most dangerous thing this module could believe
 * is that "I did not find a process" and "I could not look" are the same answer.
 * They authorize opposite actions: an address proven EMPTY may be spawned into,
 * and a record naming a process proven GONE may be cleared; an address this
 * machine would not describe may have anything behind it, including a host the
 * user started, and so authorizes nothing at all. Both the listener lookup
 * ({@link ManagedHostLocation}) and the process reader ({@link LiveProcess}) are
 * therefore three-valued, and every `unknown` resolves to inaction.
 *
 * WHY THIS LIVES IN THE BROKER. Two adapters need it and adapters may not import
 * each other (`scripts/ci/check-boundaries.sh`), so an adapter-side
 * implementation is two implementations of the never-kill-a-stranger rule — the
 * one place in this product where a subtle divergence between two copies ends
 * with a killed process. It is also the split `adapter-api/src/integration.ts`
 * already describes: adapters declare native capability, broker-owned code
 * performs host effects. The adapter still supplies what only it knows —
 * whether the host is READY, and where its process can be found — as
 * {@link ManagedHostPlan} callbacks.
 *
 * The OpenCode managed serve (`adapters/opencode/src/managed-server.ts`) is the
 * precedent this generalizes, and it deliberately stays where it is for now:
 * that lane is under active work, and rewriting a proven lifecycle to prove a
 * refactor is not a trade this round makes. It should migrate onto this engine
 * once it settles.
 *
 * EVERY host effect is injected ({@link ManagedHostEffects}), so the whole
 * decision surface is testable with fake processes, synthetic pids, and a temp
 * state directory — no real host is ever started to test the logic that decides
 * whether to start one.
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonOwnerOnly } from '../security/secure-files.ts';
import { setupStateHome } from '../installation/setup-state.ts';

/**
 * Bumped to 3: v2 added the evidence fields below, v3 added the boot identity
 * that makes the Linux start token safe to compare across a reboot. A v1 record reads as NO record,
 * which is the fail-closed direction (a live host is preserved rather than
 * signalled on a partial match), and it costs nothing here: managed start has
 * never shipped enabled, so no v1 record exists on any machine to strand.
 */
export const MANAGED_HOST_OWNER_SCHEMA_VERSION = 3 as const;

/** Agent ids are used in file names and environment variable names; both are bounded. */
const MANAGED_HOST_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Stable OS identity of a running process. */
export interface HostProcessIdentity {
  pid: number;
  /**
   * Locale-free start token: Linux `/proc/<pid>/stat` field 22 (start time in
   * clock ticks since boot); macOS `ps -o lstart=`. Compared as an opaque
   * string — its only job is to differ when the pid has been recycled.
   */
  start: string;
  /**
   * Which BOOT the process belongs to. Linux: `/proc/sys/kernel/random/boot_id`.
   *
   * Load-bearing, and the reason is easy to miss: the Linux start token is ticks
   * SINCE BOOT, so it is only unique within one boot. Across a reboot a fresh
   * process can hold the same pid and the same start tick as the host a
   * persisted record describes — at which point that record would classify a
   * total stranger as owned and authorize a signal against it.
   * A record is only ever compared inside the boot that wrote it.
   *
   * Empty on platforms with no such identifier, which is sound there because
   * their start token is an ABSOLUTE wall-clock time (macOS `ps -o lstart=`)
   * rather than an offset from boot, and so is already cross-boot unique.
   */
  boot: string;
  /**
   * Command name (`/proc/<pid>/comm`, or `ps -o comm=`). DIAGNOSTIC, NOT PROOF —
   * see the module header for why comparing it is unsound.
   *
   * Still never empty in a usable identity, and that has nothing to do with
   * ownership. A read that cannot produce a command name is a read that did not
   * reach the process at all, so it yields no identity rather than a partial
   * one; requiring the field is how that failure stays distinguishable from a
   * successful read of a process that happens to be named nothing.
   */
  comm: string;
}

/** Durable proof that this product started a particular host process. */
export interface ManagedHostOwnership extends HostProcessIdentity {
  schemaVersion: typeof MANAGED_HOST_OWNER_SCHEMA_VERSION;
  /** Which agent's host this is; one record per agent. */
  agent: string;
  /**
   * The address or home the host was started FOR. A record written for one
   * location proves nothing about a process serving another — the operator may
   * have repointed the adapter since, and the old host may still be running.
   */
  identityKey: string;
  /** Wall-clock ms at which ownership was recorded. Diagnostic only. */
  recordedAtMs: number;
  /**
   * EVIDENCE, NOT PROOF, and the distinction is deliberate.
   *
   * Everything below describes the host this broker launched, for an operator
   * reading `doctor`, for uninstall's report, and for locating the process
   * later. None of it joins the ownership comparison, which stays exactly
   * pid + start + boot + identityKey.
   *
   * The reason is asymmetric cost. Adding a field to the comparison can only
   * ever turn 'owned' into something else, and every "something else" preserves
   * the process — so a field that cannot be re-read on some machine (an
   * unreadable `/proc/<pid>/exe`, a host that reports no version) would quietly
   * convert a stoppable host into one nothing can ever reap. Recording it as
   * evidence costs nothing and tells the operator everything.
   */
  evidence: ManagedHostEvidence;
}

/** What this broker knows about the host it launched, beyond its identity. */
export interface ManagedHostEvidence {
  /** Absolute path of the executable that was launched. */
  executable: string;
  /** Exactly the arguments it was launched with. */
  args: readonly string[];
  /** Working directory it was given, when the descriptor pinned one. */
  cwd?: string;
  /**
   * The port the host was observed serving AFTER it became ready — not the port
   * it was asked for.
   *
   * `kimi web` picks its own port and publishes it, so this is the only place
   * that number is ever written down by us, and it is what lets a later broker
   * look for the host by address instead of by a pid it must take on faith.
   */
  port?: number;
  /** Host version, when the host reports a real one. dsh's is a placeholder, so it is usually absent. */
  version?: string;
  /** The profile or home the host serves; `identityKey` for hosts keyed that way. */
  profile?: string;
}

/**
 * Where a host process is — three-valued, because the two ways of "not finding
 * one" authorize opposite actions.
 *
 * 'absent'     — this machine looked and nothing is there. The only answer that
 *                permits spawning, and the only one that permits clearing a
 *                record as describing something gone.
 * 'identified' — a specific process is there. It still has to be classified
 *                before anything may be done to it.
 * 'unknown'    — this machine would not say. Could be empty, could be the
 *                user's own host. Authorizes nothing whatsoever.
 */
export type ManagedHostLocation =
  | { state: 'absent' }
  | { state: 'identified'; pid: number }
  | { state: 'unknown' };

export const HOST_ABSENT: ManagedHostLocation = Object.freeze({ state: 'absent' });
export const HOST_UNKNOWN: ManagedHostLocation = Object.freeze({ state: 'unknown' });
export function hostAt(pid: number): ManagedHostLocation {
  return Number.isInteger(pid) && pid > 0 ? { state: 'identified', pid } : HOST_UNKNOWN;
}

/**
 * A live process lookup, three-valued for the same reason.
 *
 * 'absent' is a POSITIVE result — the operating system said there is no such
 * process (ENOENT on `/proc/<pid>`, `ps` reporting no match) — and it is what
 * makes a stale ownership record safe to delete. 'unknown' is every other
 * failure: an unreadable procfs, a missing `ps`, output that did not parse. A
 * partial identity is never returned, because a partial identity that happened
 * to compare equal would authorize a kill.
 */
export type LiveProcess =
  | { state: 'running'; identity: HostProcessIdentity }
  | { state: 'absent' }
  | { state: 'unknown' };

export const PROCESS_ABSENT: LiveProcess = Object.freeze({ state: 'absent' });
export const PROCESS_UNKNOWN: LiveProcess = Object.freeze({ state: 'unknown' });

/**
 * 'owned'         — proven ours: safe to stop or replace.
 * 'foreign'       — provably NOT ours, or unprovable: someone else's process.
 * 'indeterminate' — the live process could not be identified at all.
 * 'absent'        — proven that nothing is running there.
 *
 * Only 'owned' authorizes a signal, and only 'absent' authorizes forgetting a
 * record. 'foreign' and 'indeterminate' are kept distinct because they are
 * different things to TELL an operator, not because they are treated
 * differently: one says "that is not ours", the other says "this machine would
 * not say whose it is".
 */
export type ManagedHostVerdict = 'owned' | 'foreign' | 'indeterminate' | 'absent';

/**
 * The ownership decision, as a pure function of three inputs.
 *
 * Split out from every effect on purpose: this is the assertion that a process
 * may be killed, and it should be readable, and testable, without a process
 * table anywhere in sight.
 */
export function classifyManagedHost(
  record: ManagedHostOwnership | null,
  live: LiveProcess,
  identityKey: string,
): ManagedHostVerdict {
  if (live.state === 'unknown') return 'indeterminate';
  if (live.state === 'absent') return 'absent';
  const identity = live.identity;
  if (!record) return 'foreign';
  if (record.identityKey !== identityKey) return 'foreign';
  if (record.pid !== identity.pid) return 'foreign';
  if (record.start !== identity.start) return 'foreign';
  // Before the start token means anything: a tick count from a previous boot is
  // not comparable with one from this boot.
  if (record.boot !== identity.boot) return 'foreign';
  // The command name is NOT compared — a host may rename itself, and both of
  // ours do (module header). BOTH sides are still required to be present, and
  // the asymmetry matters: dropping the comparison must not turn a malformed
  // record into a passing one. A live identity with no command name is a read
  // that never reached a process; a RECORD with none was never written by
  // `startManagedHost`, which takes its fields from a live read, so it is
  // synthetic or damaged. Either way the proof is incomplete, and an incomplete
  // proof authorizes nothing.
  if (record.comm.length === 0 || identity.comm.length === 0) return 'foreign';
  return 'owned';
}

/** A spawned child, narrowed to what the lifecycle actually uses. */
export interface ManagedHostChild {
  readonly pid: number;
  /** Resolves when the process exits; the lifecycle races it against readiness. */
  readonly exited: Promise<unknown>;
  /** null while running. */
  readonly exitCode: number | null;
  /** Bounded, redacted stdout+stderr captured so far. */
  readOutput(): string;
}

export interface ManagedHostLaunch {
  command: string;
  args: readonly string[];
  /** Additional environment for the child; the parent environment is inherited. */
  env?: Readonly<Record<string, string>>;
  /** Working directory for the child; the broker's own is inherited when absent. */
  cwd?: string;
}

/** Every effect this module performs on the host, injected so tests need none. */
export interface ManagedHostEffects {
  /**
   * Which process is listening on a loopback TCP port.
   *
   * Must return 'absent' ONLY on a successful lookup that found nothing —
   * that answer is what authorizes a spawn. Every failure, every refusal, and
   * every ambiguous result (two listeners on one port) is 'unknown'.
   */
  listener(port: number): ManagedHostLocation;
  liveProcess(pid: number): LiveProcess;
  spawn(launch: ManagedHostLaunch): ManagedHostChild;
  /** Send a signal. Must be a no-op for a pid that no longer exists. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * A deadline that can be CANCELLED without having elapsed.
   *
   * Distinct from `sleep` because it is used to bound an adapter's own probe: a
   * probe that answers quickly must not have cost the time it was allowed. The
   * returned promise resolves when the time is up and never rejects; `cancel`
   * releases the timer.
   */
  deadline(ms: number): { expired: Promise<void>; cancel(): void };
  /** This process's own pid, which must never be signalled. */
  selfPid(): number;
}

export interface ManagedHostStore {
  read(agent: string): ManagedHostOwnership | null;
  write(record: ManagedHostOwnership): void;
  clear(agent: string): void;
}

/** What only the adapter knows about its own host. */
export interface ManagedHostPlan {
  /** Agent id; keys the ownership record and the failure journal. */
  agent: string;
  /**
   * The address or home this host serves, as a stable string. Ownership is
   * scoped to it — see {@link ManagedHostOwnership.identityKey}.
   */
  identityKey: string;
  /**
   * Is a host SERVING right now? The adapter's own readiness probe, which is
   * the only honest definition: a listening socket is not a working host, and
   * every adapter proves the difference differently.
   *
   * The signal carries this lifecycle's remaining budget. Honouring it lets a
   * probe abandon its socket promptly; ignoring it costs only that probe's
   * result, never the deadline, because the caller races it anyway.
   */
  ready(signal?: AbortSignal): Promise<boolean>;
  /**
   * Where the live host is — see {@link ManagedHostLocation}. 'unknown' is
   * treated as an unidentified process and therefore never touched, and never
   * spawned over.
   *
   * Adapter-supplied because the answer is adapter-shaped: one host publishes
   * its pid in a registry it maintains, another must be located by the port it
   * was configured to listen on.
   */
  locate(): Promise<ManagedHostLocation>;
  /**
   * How to start a host, or `null` when this configuration cannot start one —
   * the binary is absent, or the operator pointed the adapter at a host that is
   * not this machine's to run.
   *
   * Nullable rather than a separate code path, because everything BEFORE the
   * spawn applies either way and one of those things is reconciling a host we
   * started earlier. Splitting on launchability first is how that reconciliation
   * got skipped for the ordinary transition it matters most for: an operator who
   * repoints a locally managed host at a remote one hands us a descriptor with
   * no launch spec, and the process we started is still running.
   */
  launch: ManagedHostLaunch | null;
  /**
   * What the host says about itself once it is serving — the port it actually
   * bound, its version, the profile it loaded.
   *
   * Read AFTER readiness and never before, because before readiness there is
   * nothing to ask. Failures are swallowed: this is evidence for an operator,
   * and losing it must never turn a working start into a failed one.
   */
  observe?(): Promise<{ port?: number; version?: string; profile?: string }>;
  /** How long a freshly spawned host has to become ready before it is a failure. */
  readyTimeoutMs: number;
  /** Poll interval while waiting for readiness. */
  readyPollMs?: number;
  /** How long a stop waits after SIGTERM before escalating to SIGKILL. */
  stopGraceMs: number;
}

type ManagedHostStartAction =
  /** A host is already serving here. `verdict` says whose it is. */
  | { action: 'already-serving'; verdict: ManagedHostVerdict }
  /**
   * Something holds this address but is not serving. Never spawned into and
   * never signalled: an unready listener is as likely to be a host still
   * starting up as it is to be a stranger, and neither may be disturbed.
   */
  /**
   * `verdict` matters here: an unready process that is PROVEN OURS is a host
   * that crashed, wedged, or is still booting, and only the caller knows which
   * of those its situation allows it to act on. Startup treats all three the
   * same and waits; {@link recoverManagedHost} is the one that may act.
   */
  | { action: 'preserved-unready'; pid: number; verdict: ManagedHostVerdict }
  /**
   * This machine would not say whether anything is at the address. Nothing was
   * started: spawning here risks racing a host that is already there and simply
   * invisible to us.
   */
  | { action: 'preserved-unlocatable' }
  /**
   * A host from an EARLIER run is still recorded and could not be settled, so
   * nothing new was started. Starting anyway would overwrite the only proof
   * that authorizes stopping it — see {@link startManagedHost}.
   */
  | { action: 'preserved-predecessor'; verdict: ManagedHostVerdict }
  /**
   * Nothing is running here and this configuration cannot start one: no binary,
   * or an address that is not this machine's to serve. Everything before the
   * spawn still ran — in particular a host recorded by an earlier run was
   * settled, which is the whole reason this is an outcome of the start path
   * rather than a branch taken before it.
   */
  | { action: 'not-launchable' }
  /**
   * A host was started. `servingProven` says whether the process now serving
   * the address was proven to BE the spawned child — see
   * {@link startManagedHost} for why an unproven start is still reported as a
   * start rather than a failure.
   */
  | { action: 'started'; pid: number; servingProven: boolean }
  | { action: 'start-failed'; detailCode: string; capturedOutput: string };

/**
 * What the start did, plus one fact that is independent of it.
 *
 * `action` answers "what happened at the target address". `strandedPredecessor`
 * answers a SEPARATE question — "is a host this broker started in an earlier run
 * still alive and unreaped" — and the two do not imply each other: an operator
 * who repoints the adapter at an address a stranger already serves gets
 * `already-serving` for the address AND a leftover of ours still running, which
 * is precisely the pairing that used to go unreported until shutdown.
 *
 * It is a separate field rather than another `action` because collapsing it into
 * one would force a choice between telling the operator about their host and
 * telling them about ours. They need both.
 */
export type ManagedHostStartOutcome = ManagedHostStartAction & {
  /**
   * The verdict on a recorded earlier host that could not be settled — it is
   * alive and refused to die, or alive and no longer provable. Absent when there
   * was no predecessor, when it was reaped, or when it was proven already gone.
   */
  readonly strandedPredecessor?: ManagedHostVerdict;
};

export type ManagedHostStopOutcome =
  | { action: 'stopped'; pid: number; escalated: boolean }
  | { action: 'already-gone' }
  /** Not ours, or not identifiable: left running, deliberately. */
  | { action: 'preserved'; verdict: ManagedHostVerdict };

/**
 * Start the host if — and only if — nothing is there and nothing else is using
 * the address.
 *
 * The order of the checks is the safety argument:
 *
 *  1. A serving host is never disturbed, ours or not. If it is ours the goal is
 *     already met; if it is not, stopping it is exactly the thing this module
 *     exists to prevent. Ownership is still classified, because the CALLER may
 *     need to say whose it is, but nothing acts on the answer here.
 *  2. An address held by something not serving is left alone for the same
 *     reason, and additionally because spawning into it would just fail.
 *  3. Only a genuinely empty address is spawned into.
 *  4. Independently of all three, a host RECORDED by an earlier run is settled
 *     from its own identity. That question is about our process, not about this
 *     address, so it is not gated on the answer to any of the above — see the
 *     reconciliation below for the repointed case that made the difference
 *     observable.
 *

 * A spawned child whose identity cannot be read is stopped again rather than
 * left running: a process this broker cannot PROVE it owns is one no later
 * broker will ever be able to stop, and leaking one of those on every start is
 * worse than failing to start at all.
 *
 * THE SUCCESS BARRIER IS NOT "SOMETHING IS READY". `ready()` asks about an
 * ADDRESS, not about our child, and during a launch window the two can come
 * apart: a user's own `kimi web` started a second earlier can satisfy the probe
 * while our child is still binding or has already died. So a start is only
 * reported as ours once the serving process is located and proven to be the
 * child we spawned. If it is somebody else's, our child is stopped — it is
 * proven ours and it is not the host, so leaving it running would leak a
 * process for no benefit — and the outcome is reported as the foreign host that
 * actually won the address.
 *
 * The one case that stays ours without proof is a host that is ready while this
 * machine will not say WHICH process serves it. Killing our child there would
 * mean destroying the working host we just started on nothing more than a
 * failure to look; keeping it costs at worst one recorded, provably-ours
 * process that a later stop can still reap. The invariant that must never bend
 * — no stranger is ever touched — holds either way, so the outcome is reported
 * as a start with `servingProven: false`.
 */
export async function startManagedHost(
  plan: ManagedHostPlan,
  effects: ManagedHostEffects,
  store: ManagedHostStore,
): Promise<ManagedHostStartOutcome> {
  // Both facts about the target address are gathered BEFORE anything is decided,
  // because the predecessor question below is answered against them and must be
  // answered whatever they turn out to be.
  const addressServing = await probeReady(plan, effects, plan.readyTimeoutMs);
  const atAddress = await plan.locate();

  // A RECORDED HOST IS SETTLED INDEPENDENTLY OF WHAT IS AT THE ADDRESS.
  //
  // A record from an earlier run can describe a live process this address knows
  // nothing about, and there are two ordinary ways to get there: `kimi web` was
  // observed releasing its listener while its process lingered, and an operator
  // who repoints the adapter leaves the host we started for the OLD address
  // running while the new one is somebody else's or empty.
  //
  // This used to run only after the address was proven empty, which made the
  // repointed case unreachable in the way it actually happens: repoint onto an
  // address a user's own host already serves and the start returned
  // 'already-serving' from the first check, so our leftover kept running,
  // unmentioned, until the broker exited. The reconciliation belongs to the
  // RECORD, not to the address, so it happens on every path.
  //
  // It reaps nothing it cannot prove is a different process from the one holding
  // the address, and — worth being explicit — it can never touch the host at the
  // address either way: `stopManagedHost` decides from the record's own pid and
  // re-proves that identity before every signal, so a foreign host is untouched
  // whether or not it happens to sit where our record used to.
  const predecessor = store.read(plan.agent);
  let stranded: ManagedHostVerdict | undefined;
  if (predecessor && reapablePredecessor(predecessor, atAddress, addressServing)) {
    const settled = await stopRecordedManagedHost(predecessor, effects, store, plan.stopGraceMs);
    // 'stopped' and 'already-gone' both clear the record, so a spawn below writes
    // onto nothing. 'preserved' means the predecessor is alive and unprovable, or
    // alive and refused to die: either way its proof must stand, and the operator
    // is told rather than left to discover it at shutdown.
    if (settled.action === 'preserved') stranded = settled.verdict;
  }
  /** Carry the stranded-host fact onto whatever the address decision turns out to be. */
  const withPredecessor = (action: ManagedHostStartAction): ManagedHostStartOutcome =>
    stranded === undefined ? action : { ...action, strandedPredecessor: stranded };

  if (addressServing) {
    const live = atAddress.state === 'identified' ? effects.liveProcess(atAddress.pid) : PROCESS_UNKNOWN;
    return withPredecessor({
      action: 'already-serving',
      verdict: classifyManagedHost(store.read(plan.agent), live, plan.identityKey),
    });
  }
  if (atAddress.state === 'identified') {
    return withPredecessor({
      action: 'preserved-unready',
      pid: atAddress.pid,
      verdict: classifyManagedHost(store.read(plan.agent), effects.liveProcess(atAddress.pid), plan.identityKey),
    });
  }
  // Not proven empty. An address this machine will not describe is the one an
  // unowned host is most likely to be hiding behind, so it is never spawned into.
  if (atAddress.state === 'unknown') return withPredecessor({ action: 'preserved-unlocatable' });
  // Nothing is here and nothing can be started. Reached only after the address
  // was read and the predecessor settled, which is the point: a descriptor with
  // no launch spec is the ordinary shape of "this host moved somewhere else",
  // and the host we started for the old configuration is exactly what still
  // needs reaping.
  if (!plan.launch) return withPredecessor({ action: 'not-launchable' });
  // The address is empty and ours could not be settled: starting now would write
  // a fresh record over the only proof that authorizes stopping the process still
  // running, leaving it for nothing to ever reap. Reported as its own action
  // rather than as a stranded field, because here it is the REASON nothing
  // started, not a side fact alongside some other outcome.
  if (stranded !== undefined) return { action: 'preserved-predecessor', verdict: stranded };

  // A missing or non-executable command throws synchronously rather than
  // producing a child, and that must read as a reported start failure like any
  // other — it is the ordinary case of "the tool is not installed", and letting
  // it escape would turn an absent optional agent into a broker startup error.
  let child: ManagedHostChild;
  try {
    child = effects.spawn(plan.launch);
  } catch (error) {
    return withPredecessor({
      action: 'start-failed',
      detailCode: 'host-spawn-failed',
      capturedOutput: error instanceof Error ? error.message : String(error),
    });
  }
  // The ceiling on the child's readiness starts HERE, not at the top of the
  // function. `readyTimeoutMs` is what the adapter advertises a freshly spawned
  // host gets; measuring it from before the pre-flight probe and a predecessor
  // stop would let those spend the new host's budget and then fail it for being
  // slow. Each earlier phase is separately bounded, so the whole start still is.
  const deadline = effects.now() + plan.readyTimeoutMs;
  const spawned = effects.liveProcess(child.pid);
  if (spawned.state !== 'running') {
    // Stop it with the handle we still hold — this is the one moment ownership
    // needs no proof, because the child has not left this function.
    await terminate(child.pid, plan.stopGraceMs, effects, () => child.exitCode !== null);
    return {
      action: 'start-failed',
      detailCode: 'host-identity-unreadable',
      capturedOutput: child.readOutput(),
    };
  }
  // Written BEFORE readiness, deliberately. The record's claim is "this broker
  // spawned this process", which is proven right now; it is not a claim about
  // which process serves the address. Writing it here is what makes a child
  // that hangs, crashes, or outlives this broker still reapable — the leak this
  // whole module exists to prevent.
  const record: ManagedHostOwnership = {
    schemaVersion: MANAGED_HOST_OWNER_SCHEMA_VERSION,
    ...spawned.identity,
    agent: plan.agent,
    identityKey: plan.identityKey,
    recordedAtMs: effects.now(),
    evidence: {
      executable: plan.launch.command,
      args: [...plan.launch.args],
      ...(plan.launch.cwd === undefined ? {} : { cwd: plan.launch.cwd }),
    },
  };
  store.write(record);
  /** Fold in what the host reports about itself, once there is a host to ask. */
  const recordObserved = async (): Promise<void> => {
    if (!plan.observe) return;
    let observed: { port?: number; version?: string; profile?: string };
    try {
      observed = await plan.observe();
    } catch {
      return; // evidence is a courtesy to the operator, never a start condition
    }
    const evidence: ManagedHostEvidence = { ...record.evidence };
    if (observed.port !== undefined) evidence.port = observed.port;
    if (observed.version !== undefined) evidence.version = observed.version;
    if (observed.profile !== undefined) evidence.profile = observed.profile;
    store.write({ ...record, evidence });
  };
  const childGone = (): boolean => child.exitCode !== null;
  /** Give up the child and the record together, but only once it is proven gone. */
  const abandonChild = async (detailCode: string): Promise<ManagedHostStartOutcome> => {
    const stopped = await terminate(child.pid, plan.stopGraceMs, effects, childGone);
    // A child that would not die keeps its record: it is still running, it is
    // still ours, and the record is the only thing that will ever let it be
    // stopped. See `stopManagedHost` for the same rule on the shutdown path.
    if (stopped.gone) store.clear(plan.agent);
    return { action: 'start-failed', detailCode, capturedOutput: child.readOutput() };
  };

  const pollMs = plan.readyPollMs ?? 150;
  for (;;) {
    if (await probeReady(plan, effects, deadline - effects.now())) {
      const serving = await plan.locate();
      if (serving.state === 'identified' && serving.pid === child.pid) {
        await recordObserved();
        return { action: 'started', pid: child.pid, servingProven: true };
      }
      if (serving.state === 'identified') {
        // Another host won the address while ours was starting. Ours is proven
        // ours and is demonstrably not the one serving, so it is stopped rather
        // than leaked — and the winner is classified and left strictly alone.
        const stopped = await terminate(child.pid, plan.stopGraceMs, effects, childGone);
        if (stopped.gone) store.clear(plan.agent);
        const live = effects.liveProcess(serving.pid);
        return {
          action: 'already-serving',
          verdict: classifyManagedHost(store.read(plan.agent), live, plan.identityKey),
        };
      }
      await recordObserved();
      return { action: 'started', pid: child.pid, servingProven: false };
    }
    if (childGone()) {
      // Proven exited, so the record describes nothing and is safe to drop.
      store.clear(plan.agent);
      return { action: 'start-failed', detailCode: 'host-exited-during-start', capturedOutput: child.readOutput() };
    }
    if (effects.now() >= deadline) {
      // Ours, proven, and not working: stopping it is both allowed and required,
      // otherwise the next start finds an unready occupant and preserves it
      // forever.
      return await abandonChild('host-not-ready-in-time');
    }
    await effects.sleep(pollMs);
  }
}

/**
 * May the recorded host be reaped, given what is at the target address?
 *
 * The whole question is "can we PROVE the record describes a different process
 * than the one holding this address" — because the one thing that must never
 * happen is reaping the working host we are being asked to ensure. The record's
 * own identity is re-proved later; this only decides whether to look at all.
 */
function reapablePredecessor(
  record: ManagedHostOwnership,
  atAddress: ManagedHostLocation,
  addressServing: boolean,
): boolean {
  // This machine will not name what is at the address, and the recorded process
  // is a candidate for being exactly that. Never reaped on a guess.
  if (atAddress.state === 'unknown') return false;
  // Named: reapable only when the address is held by a DIFFERENT process. Pid
  // equality is deliberately the conservative direction — a recycled pid that
  // happens to match preserves a record it did not have to, whereas the reverse
  // error would signal the host we came here to keep.
  if (atAddress.state === 'identified') return atAddress.pid !== record.pid;
  // Proven empty. That is only consistent with a host answering the readiness
  // probe if something is serving that the locator cannot see — and while that
  // is unexplained, the recorded process is not excluded from being it.
  return !addressServing;
}

/**
 * One readiness probe, bounded by the time the start still has left.
 *
 * An adapter's readiness probe is adapter code talking to a host over a socket,
 * and its own patience is its own business: a DSH availability check may wait 30
 * seconds under a 20-second lifecycle ceiling. The advertised timeout is only a
 * real deadline if the wait for an ANSWER is bounded too, so every probe is
 * raced against the remaining budget and told to abort. A probe that honours the
 * signal releases its socket immediately; one that ignores it loses only its own
 * result, never the deadline.
 */
async function probeReady(
  plan: Pick<ManagedHostPlan, 'ready'>,
  effects: ManagedHostEffects,
  budgetMs: number,
): Promise<boolean> {
  if (!(budgetMs > 0)) return false;
  const controller = new AbortController();
  const timer = effects.deadline(budgetMs);
  try {
    return await Promise.race([
      plan.ready(controller.signal).catch(() => false),
      timer.expired.then(() => false),
    ]);
  } finally {
    // Abort first: a probe still holding a socket should be released even
    // though its result is already discarded.
    controller.abort();
    timer.cancel();
  }
}

/**
 * Stop the host, but only once it is PROVEN ours — and re-proven immediately
 * before each signal.
 *
 * The re-proof is not paranoia about a hypothetical. Between classifying and
 * signalling, our process can exit and another take its pid; between SIGTERM and
 * SIGKILL, the same. Signalling on a classification made even milliseconds
 * earlier is signalling a pid, not a process. So identity is re-read before
 * SIGTERM and again before SIGKILL, and a mismatch abandons the stop rather
 * than completing it.
 */
export async function stopManagedHost(
  plan: Pick<ManagedHostPlan, 'agent' | 'identityKey' | 'stopGraceMs'>,
  effects: ManagedHostEffects,
  store: ManagedHostStore,
  locate: () => Promise<ManagedHostLocation>,
): Promise<ManagedHostStopOutcome> {
  const record = store.read(plan.agent);
  if (!record) {
    // No proof of ownership, so nothing here is ours to stop, whatever is there.
    // The address is consulted only to say WHAT was left alone.
    const location = await locate();
    if (location.state === 'absent') return { action: 'already-gone' };
    if (location.state === 'unknown') return { action: 'preserved', verdict: 'indeterminate' };
    return {
      action: 'preserved',
      verdict: classifyManagedHost(null, effects.liveProcess(location.pid), plan.identityKey),
    };
  }
  // OWNERSHIP IS A PROPERTY OF THE PROCESS, NOT OF THE ADDRESS, and this stop is
  // about the process the record names.
  //
  // Deciding from the listener instead had two failures, in opposite directions.
  // An address proven empty is not proof our host exited — `kimi web` was
  // observed releasing its listener while its process lingered — and an address
  // this machine will not describe is not proof of anything at all, yet it used
  // to preserve unconditionally, which meant a host started when the serving
  // process could not be resolved (`servingProven: false`) could never
  // afterwards be stopped by anything. Both disappear once the recorded pid is
  // what gets verified: the record and the pid are self-consistent, so no
  // listener lookup can make this decision better, and a mismatch on any part of
  // the identity still refuses.
  //
  // Classified against the RECORD's own identity key rather than the caller's.
  // The question here is only "is the process this record described still that
  // process" — an operator who repointed the adapter since must still have the
  // host we started reaped, not stranded because it serves a different address
  // than the one we are being asked about now.
  const pid = record.pid;
  const live = effects.liveProcess(pid);
  const verdict = classifyManagedHost(record, live, record.identityKey);
  if (verdict === 'absent' || verdict === 'foreign') {
    // Either the process is gone, or the pid now belongs to something else —
    // which means OUR process is gone. Both make the record spent, and keeping
    // it would invite a future pid collision from being read as ownership.
    // Nothing is signalled on this path: 'foreign' describes a stranger holding
    // a number we used to hold, and it is left strictly alone.
    store.clear(plan.agent);
    return { action: 'already-gone' };
  }
  if (verdict !== 'owned') return { action: 'preserved', verdict };
  if (pid === effects.selfPid()) return { action: 'preserved', verdict: 'foreign' };

  const stillOurs = (): boolean =>
    classifyManagedHost(record, effects.liveProcess(pid), record.identityKey) === 'owned';
  const result = await terminate(pid, plan.stopGraceMs, effects, () => !stillOurs());
  // The record outlives a FAILED stop, on purpose. If SIGTERM and SIGKILL both
  // failed to land, a process that is still running is still ours, and this
  // record is the only evidence that will ever authorize another attempt at it.
  // Clearing it here would launder a live owned host into an untouchable
  // stranger — the exact outcome this module exists to prevent, arrived at from
  // the other direction.
  if (!result.gone) return { action: 'preserved', verdict: 'indeterminate' };
  store.clear(plan.agent);
  // Gone without a signal means the pid stopped being ours between classifying
  // and acting. Nothing was stopped, and — the part that matters — nothing was
  // signalled, so whatever took the pid was never touched.
  if (!result.signalled) return { action: 'already-gone' };
  return { action: 'stopped', pid, escalated: result.escalated };
}

/**
 * SIGTERM, wait, SIGKILL — with `gone()` consulted before every signal.
 *
 * `gone()` is the caller's proof that the pid is still the process it meant.
 * When it goes true the escalation stops immediately, which is what makes the
 * SIGKILL safe: a pid that has been recycled between the two signals reads as
 * gone, and the replacement is never touched.
 */
async function terminate(
  pid: number,
  graceMs: number,
  effects: ManagedHostEffects,
  gone: () => boolean,
): Promise<{ gone: boolean; escalated: boolean; signalled: boolean }> {
  // `signalled` is reported separately from `gone` because the two come apart
  // in exactly the case this guard exists for: a process that vanishes between
  // the decision and the signal is gone WITHOUT having been stopped by us, and
  // calling that "stopped" would credit this code with an effect it never had.
  if (gone()) return { gone: true, escalated: false, signalled: false };
  if (pid === effects.selfPid()) return { gone: false, escalated: false, signalled: false };
  effects.signal(pid, 'SIGTERM');
  const deadline = effects.now() + graceMs;
  while (effects.now() < deadline) {
    await effects.sleep(Math.min(50, Math.max(1, graceMs)));
    if (gone()) return { gone: true, escalated: false, signalled: true };
  }
  if (gone()) return { gone: true, escalated: false, signalled: true };
  effects.signal(pid, 'SIGKILL');
  const killDeadline = effects.now() + graceMs;
  while (effects.now() < killDeadline) {
    await effects.sleep(Math.min(50, Math.max(1, graceMs)));
    if (gone()) return { gone: true, escalated: true, signalled: true };
  }
  return { gone: gone(), escalated: true, signalled: true };
}

// ── driving it from an adapter's own description ────────────────────────────

/**
 * The environment variable that authorizes managed start for one agent.
 *
 * DERIVED from the agent id rather than listed, because the broker may never
 * branch on which tool it is talking to (`@cosyncing/protocol` header). Adding
 * an agent adds no code here.
 */
export function managedHostGateEnv(agent: string): string {
  if (!MANAGED_HOST_AGENT_ID.test(agent)) throw new Error('invalid managed-host agent id');
  return `COSYNCING_${agent.replace(/-/g, '_').toUpperCase()}_MANAGED_HOST`;
}

/**
 * Default OFF, and it stays off until a physical maintenance-window pass says
 * otherwise.
 *
 * This is not the registration question that a flag answered badly — that one
 * was about which clients can decode a row, and hiding an agent from everyone
 * was the wrong answer to it. This flag guards SPAWNING A PROCESS on the
 * operator's machine, which is exactly the kind of effect a controlled rollout
 * is for. The installed service enables it for every external-host agent (see
 * `shipped-adapters.ts`), so the variable is what a FOREGROUND broker uses to
 * opt in, not a rollout flag an operator has to discover.
 */
export function managedHostStartAuthorized(
  agent: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return /^(1|true|yes|on)$/i.test(env[managedHostGateEnv(agent)]?.trim() ?? '');
}

export type ManagedHostSkip =
  /** The adapter declares no external host, so there is nothing to own. */
  | { action: 'not-applicable' }
  /** It has one, but the operator has not authorized starting it. */
  | { action: 'not-authorized'; variable: string }
  /** It has one and cannot say where; nothing may be started or touched. */
  | { action: 'undescribed' };

export type ManagedHostEnsureOutcome = ManagedHostStartOutcome | ManagedHostSkip;

/** One line an operator sees at startup about one managed host. */
export interface ManagedHostStartupLine {
  readonly level: 'info' | 'warn';
  readonly message: string;
}

/**
 * What to TELL the operator about a start — as data, so it can be asserted.
 *
 * Separated from the printing because the failure it exists to prevent is a
 * SILENT outcome: `preserved-predecessor` was added to the union, returned by
 * the engine, and never handled by the startup chain, so an authorized managed
 * host could decline to start with no explanation anywhere. A caller can forget
 * to handle a new variant; a test over this function cannot.
 *
 * Every message here is built from a closed set of our own words — an agent id,
 * a verdict, a detail code, a pid we started. Native output from another program
 * NEVER reaches it: that goes to the sanitizing failure journal, which is what
 * `capturedOutput` is for.
 */
export function managedHostStartupReport(
  agent: string,
  outcome: ManagedHostEnsureOutcome,
): readonly ManagedHostStartupLine[] {
  const doctor = 'run `cosyncing doctor`';
  const lines: ManagedHostStartupLine[] = [];
  // Said first and independently of the action, because it is the one thing the
  // operator cannot discover for themselves: a host WE started in an earlier run
  // is alive and can no longer be proved ours, so nothing will ever reap it. The
  // pid is deliberately not printed — it names a process this broker has just
  // lost the right to touch, and an operator reading a pid next to a cosyncing
  // message may reasonably assume it is theirs to kill.
  if ('strandedPredecessor' in outcome && outcome.strandedPredecessor !== undefined) {
    lines.push({
      level: 'warn',
      message: `a managed ${agent} host from an earlier run is still running and could not be stopped `
        + `(${outcome.strandedPredecessor}); ${doctor}`,
    });
  }
  switch (outcome.action) {
    // Silent by design: no host was asked for, or none can be described. Nothing
    // was decided and nothing was touched.
    case 'not-applicable':
    case 'not-authorized':
    case 'undescribed':
      break;
    case 'start-failed':
      lines.push({ level: 'warn', message: `managed ${agent} host did not start (${outcome.detailCode}); ${doctor}` });
      break;
    case 'preserved-predecessor':
      // Nothing started, and the reason is invisible from the address: it is
      // empty, the tool is authorized, and an operator with no explanation would
      // reasonably conclude the managed host feature itself is broken.
      lines.push({
        level: 'warn',
        message: `did not start a managed ${agent} host: one from an earlier run is still running `
          + `and could not be stopped (${outcome.verdict}); ${doctor}`,
      });
      break;
    case 'started':
      lines.push({
        level: 'info',
        message: outcome.servingProven
          ? `started a managed ${agent} host (pid ${outcome.pid})`
          // Said plainly rather than smoothed over: the host answers, but this
          // machine would not confirm that the process answering is the one we
          // started, so a later stop may find nothing it can prove it owns.
          : `started a managed ${agent} host (pid ${outcome.pid}); could not confirm it is the process now serving`,
      });
      break;
    case 'preserved-unlocatable':
      lines.push({ level: 'info', message: `could not determine whether a ${agent} host is running; started nothing` });
      break;
    case 'not-launchable':
      lines.push({
        level: 'info',
        message: `no ${agent} host is running here and this configuration cannot start one; started nothing`,
      });
      break;
    case 'already-serving':
      // Ours and serving is the goal, and the goal met says nothing. The other
      // two postures are NOT the same statement, and saying only one of them
      // would be a claim we cannot support: 'foreign' is proof somebody else's
      // host holds this address, while 'indeterminate' is our own inability to
      // tell — possibly about a host we started.
      if (outcome.verdict === 'foreign') {
        lines.push({
          level: 'info',
          message: `a ${agent} host is already running that cosyncing did not start; leaving it untouched`,
        });
      } else if (outcome.verdict !== 'owned') {
        lines.push({
          level: 'info',
          message: `a ${agent} host is already running and cosyncing could not determine whether it started it; `
            + `leaving it untouched`,
        });
      }
      break;
    case 'preserved-unready':
      // EVERY posture here prevented a start, so every posture is reported. Only
      // 'owned' used to be, which left the two cases an operator most needs —
      // something else is sitting on the address, or this machine will not say
      // whose it is — looking exactly like a successful startup.
      lines.push({
        level: outcome.verdict === 'owned' ? 'info' : 'warn',
        message: outcome.verdict === 'owned'
          // Ours, running, and not answering yet. Startup deliberately waits
          // rather than replacing it — a host mid-boot looks exactly like a
          // wedged one from here, and the supervisor is the thing allowed to
          // tell them apart, because by its first tick a booting host has had
          // time to finish.
          ? `a managed ${agent} host from a previous run is not serving yet; leaving it to the supervisor`
          // 'absent' joins 'foreign' rather than standing alone: both mean the
          // process holding this address is provably not one of ours.
          : outcome.verdict === 'indeterminate'
            ? `something holds the ${agent} host address, is not serving, and could not be identified; `
              + `started nothing; ${doctor}`
            : `something that is not a cosyncing-started ${agent} host holds its address and is not serving; `
              + `started nothing; ${doctor}`,
      });
      break;
    default: {
      // A variant added to the outcome union fails to COMPILE here rather than
      // reaching an operator as silence — which is what happened to
      // `preserved-predecessor`, and is the reason this branch exists at all.
      // Deliberately not a throw: a reporting gap must not be able to take down
      // a broker that is otherwise working.
      const unreported: never = outcome;
      void unreported;
      break;
    }
  }
  return lines;
}

/**
 * Every action the ensure path can return, as data.
 *
 * The `Record` is the enforcement: it cannot be written without a key for every
 * member of the union, so adding an action breaks this file until it is listed,
 * and breaks the report's coverage test until that action is exercised. A test
 * cannot enumerate a TYPE at runtime, and this is what closes that gap.
 */
const MANAGED_HOST_ACTION_COVERAGE: Record<ManagedHostEnsureOutcome['action'], true> = {
  'not-applicable': true,
  'not-authorized': true,
  'undescribed': true,
  'already-serving': true,
  'preserved-unready': true,
  'preserved-unlocatable': true,
  'preserved-predecessor': true,
  'not-launchable': true,
  'started': true,
  'start-failed': true,
};

export const MANAGED_HOST_ACTIONS = Object.keys(MANAGED_HOST_ACTION_COVERAGE) as ReadonlyArray<
  ManagedHostEnsureOutcome['action']
>;

/**
 * Resolve a declared locator to a location using the broker's process-table
 * access.
 *
 * An adapter that declares `{kind:'unknown'}` is saying it cannot tell where its
 * host would be — never that there is none — so it resolves to 'unknown' and
 * authorizes nothing. Proof of ABSENCE only ever comes from a lookup that
 * actually succeeded, which in practice means a port.
 */
async function locatorLocation(
  descriptor: { locator: DescribedLocator },
  effects: ManagedHostEffects,
): Promise<ManagedHostLocation> {
  const locator = descriptor.locator;
  if (locator.kind === 'pid') return hostAt(locator.pid);
  if (locator.kind === 'tcp-port') return effects.listener(locator.port);
  if (locator.kind === 'absent') return HOST_ABSENT;
  return HOST_UNKNOWN;
}

/** The locator shape adapters describe; mirrors `adapter-api`'s ManagedHostLocator. */
type DescribedLocator =
  | { kind: 'tcp-port'; port: number }
  | { kind: 'pid'; pid: number }
  | { kind: 'absent' }
  | { kind: 'unknown' };

/**
 * The generic entry point: ask an adapter to describe its host, then apply the
 * ownership rules to whatever it says.
 *
 * Nothing here knows which agent it is holding. The adapter supplies the
 * description and the readiness probe; this supplies the process table, the
 * durable record, and the decision — which is the split that lets one
 * implementation of "never kill a stranger" serve every external host.
 */
export async function ensureManagedHost(
  backend: {
    id: string;
    integration?: { externalHost?: { managed: true } };
    describeManagedHost?(): Promise<{
      identityKey: string;
      locator: DescribedLocator;
      launch: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>>; cwd?: string } | null;
      serving?: { port?: number; version?: string; profile?: string };
      readyTimeoutMs: number;
      stopGraceMs: number;
    } | null>;
    isAvailable(options?: { signal?: AbortSignal }): Promise<boolean>;
  },
  effects: ManagedHostEffects,
  store: ManagedHostStore,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ManagedHostEnsureOutcome> {
  if (!backend.integration?.externalHost?.managed || !backend.describeManagedHost) {
    return { action: 'not-applicable' };
  }
  if (!managedHostStartAuthorized(backend.id, env)) {
    return { action: 'not-authorized', variable: managedHostGateEnv(backend.id) };
  }
  const descriptor = await backend.describeManagedHost();
  if (!descriptor) return { action: 'undescribed' };
  // A descriptor with no launch spec is NOT a separate path. It once was, and
  // that branch answered the address question correctly while silently skipping
  // everything else the start does — including settling a host recorded by an
  // earlier run. The transition that exposes it is ordinary: an operator moves a
  // locally managed host to a remote one, the new descriptor cannot launch, and
  // the process we started for the old address keeps running until the broker
  // exits. `startManagedHost` takes the nullable spec and declines to spawn.
  return await startManagedHost(
    {
      agent: backend.id,
      identityKey: descriptor.identityKey,
      ready: (signal) => backend.isAvailable({ signal }),
      // RE-DESCRIBED on every call, not closed over the descriptor above.
      //
      // A frozen locator cannot see the process this start creates. Kimi finds
      // its host by a pid read from its own registry, and before the spawn that
      // registry says ABSENT — so the pre-spawn descriptor keeps answering
      // 'absent' forever and readiness can never be attributed to the process
      // that just registered. Every managed Kimi start reported
      // `servingProven: false` and logged "could not confirm it is the process
      // now serving", for the whole life of the host.
      //
      // Fails closed on every way re-description can go wrong, because this
      // answer authorizes stopping and replacing a process:
      //  - it throws, or the adapter now describes nothing → 'unknown'
      //  - the identity key changed under us → 'unknown', since an operator who
      //    repointed the adapter mid-start must not have a host at the NEW
      //    address judged against the record written for the old one
      //  - the registry is truncated or ambiguous → the adapter already says
      //    locator kind 'unknown', and that survives untouched
      // 'unknown' authorizes nothing, so the worst case is the pre-existing
      // behaviour: a start that declines to claim more than it proved.
      locate: async () => {
        let current: Awaited<ReturnType<NonNullable<typeof backend.describeManagedHost>>>;
        try {
          current = await backend.describeManagedHost?.() ?? null;
        } catch {
          return HOST_UNKNOWN;
        }
        if (!current || current.identityKey !== descriptor.identityKey) return HOST_UNKNOWN;
        return await locatorLocation(current, effects);
      },
      // Re-described AFTER readiness rather than reused from above: the whole
      // point of this evidence is what the host chose once it was running, and
      // the description taken before it started cannot contain that.
      observe: async () => (await backend.describeManagedHost?.())?.serving ?? {},
      launch: descriptor.launch,
      readyTimeoutMs: descriptor.readyTimeoutMs,
      stopGraceMs: descriptor.stopGraceMs,
    },
    effects,
    store,
  );
}

/**
 * Stop the host this broker started for one agent, if it started one.
 *
 * Safe to call for every registered agent on shutdown: an adapter with no
 * external host, no description, or no ownership record does nothing.
 */
export async function releaseManagedHost(
  backend: {
    id: string;
    integration?: { externalHost?: { managed: true } };
    describeManagedHost?(): Promise<{
      identityKey: string;
      locator: DescribedLocator;
      stopGraceMs: number;
    } | null>;
  },
  effects: ManagedHostEffects,
  store: ManagedHostStore,
): Promise<ManagedHostStopOutcome | ManagedHostSkip> {
  if (!backend.integration?.externalHost?.managed || !backend.describeManagedHost) {
    return { action: 'not-applicable' };
  }
  // No authorization check on the STOP path, deliberately. The gate governs
  // whether a host may be created; a host this broker already created must still be
  // cleaned up afterwards even if the gate has since been turned off —
  // otherwise flipping a variable strands a process nothing will ever reap.
  // Ownership is still what authorizes the signal.
  const descriptor = await backend.describeManagedHost();
  if (!descriptor) {
    // THE RECORD IS THE PRIMARY INPUT, not the description.
    //
    // An adapter stops describing its host exactly when the situation gets
    // interesting: Kimi returns null when its registry scan is truncated or
    // shows more than one live server — that is, when a SECOND Kimi appears.
    // Refusing to release there would strand the process we can still prove we
    // started, at the one moment there is another one around to confuse it with.
    // The record names a pid and carries its own identity key, which is
    // everything a stop needs; the description was only ever a convenience.
    const record = store.read(backend.id);
    if (!record) return { action: 'undescribed' };
    return await stopRecordedManagedHost(record, effects, store);
  }
  return await stopManagedHost(
    { agent: backend.id, identityKey: descriptor.identityKey, stopGraceMs: descriptor.stopGraceMs },
    effects,
    store,
    () => locatorLocation(descriptor, effects),
  );
}


// ── recovery ────────────────────────────────────────────────────────────────

/**
 * How many times a host may be restarted, and over what window.
 *
 * A restart budget is not tidiness. A host that crashes immediately on startup —
 * a broken install, an unwritable state directory, a port it cannot bind — would
 * otherwise be respawned forever, and the failure an operator needs to see would
 * be buried under a process being created and dying several times a minute. When
 * the budget is spent the failure stands, gets journalled, and stays visible.
 */
export interface ManagedHostRestartBudget {
  limit: number;
  windowMs: number;
}

/**
 * How often the broker checks that its managed hosts are still serving.
 *
 * Slow on purpose. Every tick costs one readiness probe per authorized external
 * host, and the thing being watched for — a host that died — is not more urgent
 * at 30 seconds than at 60. Recovery is bounded by the restart budget anyway, so
 * a faster tick would only spend that budget sooner.
 */
export const MANAGED_HOST_SUPERVISION_INTERVAL_MS = 60_000;

export const MANAGED_HOST_RESTART_BUDGET: ManagedHostRestartBudget = Object.freeze({
  limit: 3,
  windowMs: 10 * 60_000,
});

export interface ManagedHostRestartLedger {
  allow(agent: string, now: number, budget: ManagedHostRestartBudget): boolean;
  record(agent: string, now: number): void;
  forget(agent: string): void;
}

/** In-memory, and deliberately so: a broker restart is itself a fresh chance. */
export function managedHostRestartLedger(): ManagedHostRestartLedger {
  const attempts = new Map<string, number[]>();
  return {
    allow: (agent, now, budget) => {
      const recent = (attempts.get(agent) ?? []).filter((at) => now - at < budget.windowMs);
      attempts.set(agent, recent);
      return recent.length < budget.limit;
    },
    record: (agent, now) => {
      attempts.set(agent, [...(attempts.get(agent) ?? []), now]);
    },
    forget: (agent) => { attempts.delete(agent); },
  };
}

export type ManagedHostRecoveryOutcome =
  /** A host is serving. Nothing to do, which is the overwhelmingly common answer. */
  | { action: 'healthy' }
  /**
   * Restarted after the previous host was proven gone or proven ours-and-wedged,
   * AND a host is serving now. Only this one may be reported as good news.
   */
  | { action: 'recovered'; outcome: ManagedHostStartOutcome }
  /**
   * The restart was attempted and did not end with a host THIS BROKER manages
   * on the address.
   *
   * Deliberately not "did not end with a serving host": one member of this
   * shape is an address that IS serving, held by a process ownership could not
   * prove is ours (`already-serving` with a non-`owned` verdict). Calling that
   * "not serving" would send an operator hunting a process that is running
   * perfectly well. The carried outcome tells the two apart, and the caller
   * words them separately.
   *
   * Separate from 'recovered' because it used to be indistinguishable from it:
   * every attempt returned 'recovered' whatever came back, so a host that had
   * crashed and could not be restarted was announced as restarted, once a
   * minute, while it stayed down.
   */
  | { action: 'recovery-failed'; outcome: ManagedHostStartOutcome }
  /** Something is wrong but nothing here is provably ours to act on. */
  | { action: 'declined'; reason: 'unproven' | 'foreign' | 'budget-exhausted' }
  | ManagedHostSkip;

/**
 * One supervision tick for one agent.
 *
 * The lifecycle up to here can start a host and stop it, which is exactly as
 * useful as it sounds when the host dies at 3am. This is the part that notices.
 *
 * It acts on two proven states and refuses everything else:
 *
 *  1. OUR HOST IS GONE. The record names a process, that process is proven
 *     absent, and nothing is serving. That is a crash, and a crash is the one
 *     situation where starting a replacement is unambiguously right.
 *  2. OUR HOST IS ALIVE AND NOT SERVING. Proven ours, proven running, and its
 *     own readiness probe says no. A wedged host we started is ours to stop and
 *     replace — and it is stopped through the ordinary ownership-checked path,
 *     re-proving identity before every signal like any other stop.
 *
 * Everything else declines. A foreign host is never restarted "for" the user; an
 * address this machine will not describe is never acted on; and a host that is
 * merely slow is protected by the same readiness deadline a fresh start uses,
 * because the tick asks the adapter's own probe before concluding anything.
 */
export async function recoverManagedHost(
  backend: Parameters<typeof ensureManagedHost>[0],
  effects: ManagedHostEffects,
  store: ManagedHostStore,
  ledger: ManagedHostRestartLedger,
  env: Readonly<Record<string, string | undefined>> = process.env,
  budget: ManagedHostRestartBudget = MANAGED_HOST_RESTART_BUDGET,
): Promise<ManagedHostRecoveryOutcome> {
  if (!backend.integration?.externalHost?.managed || !backend.describeManagedHost) {
    return { action: 'not-applicable' };
  }
  if (!managedHostStartAuthorized(backend.id, env)) {
    return { action: 'not-authorized', variable: managedHostGateEnv(backend.id) };
  }
  if (await backend.isAvailable()) {
    // Serving. Forgetting the attempts here is what makes the budget a
    // CRASH-LOOP guard rather than a lifetime cap: a host that recovers and then
    // fails again months later gets its full allowance back.
    ledger.forget(backend.id);
    return { action: 'healthy' };
  }
  const descriptor = await backend.describeManagedHost();
  if (!descriptor) return { action: 'undescribed' };

  const record = store.read(backend.id);
  if (!record) {
    // Nothing of ours was ever here. `ensure` is exactly the right behaviour —
    // it will start one only if the address is PROVEN empty.
    return await restart(backend, effects, store, ledger, env, budget);
  }
  const location = await locatorLocation(descriptor, effects);
  if (location.state === 'unknown') return { action: 'declined', reason: 'unproven' };

  const pid = location.state === 'identified' ? location.pid : record.pid;
  const verdict = classifyManagedHost(record, effects.liveProcess(pid), descriptor.identityKey);
  if (verdict === 'indeterminate') return { action: 'declined', reason: 'unproven' };
  if (verdict === 'foreign') return { action: 'declined', reason: 'foreign' };
  if (verdict === 'owned') {
    // Alive, ours, and not answering. Stop it first — through the ownership-
    // checked path, so a pid recycled since the classification above is still
    // never signalled — and only replace it if that stop actually worked.
    const stopped = await stopManagedHost(
      { agent: backend.id, identityKey: descriptor.identityKey, stopGraceMs: descriptor.stopGraceMs },
      effects, store, () => locatorLocation(descriptor, effects),
    );
    if (stopped.action === 'preserved') return { action: 'declined', reason: 'unproven' };
  } else {
    // 'absent': the recorded process is gone and nothing is serving. The record
    // describes nothing, so it goes before a replacement is started.
    store.clear(backend.id);
  }
  return await restart(backend, effects, store, ledger, env, budget);
}

async function restart(
  backend: Parameters<typeof ensureManagedHost>[0],
  effects: ManagedHostEffects,
  store: ManagedHostStore,
  ledger: ManagedHostRestartLedger,
  env: Readonly<Record<string, string | undefined>>,
  budget: ManagedHostRestartBudget,
): Promise<ManagedHostRecoveryOutcome> {
  const now = effects.now();
  if (!ledger.allow(backend.id, now, budget)) return { action: 'declined', reason: 'budget-exhausted' };
  ledger.record(backend.id, now);
  const outcome = await ensureManagedHost(backend, effects, store, env) as ManagedHostStartOutcome;
  // A restart is a RECOVERY only if OUR host is serving at the end of it. Most
  // members of the outcome union are ways the attempt produced none — a spawn
  // that failed, a predecessor that would not stop, an address that could not
  // be located, a descriptor with nothing to launch — and reporting those as
  // 'recovered' told the operator the host was back while it was still down.
  return isManagedHostRecovered(outcome)
    ? { action: 'recovered', outcome }
    : { action: 'recovery-failed', outcome };
}

/**
 * Whether a start outcome means THIS BROKER'S managed host is serving.
 *
 * The action name alone is not enough, which is why this is a function and not
 * a set-membership test. `already-serving` says the address answered before
 * anything was spawned — it does NOT say whose host answered. When another
 * process wins the address that outcome carries `verdict: 'foreign'`, and
 * reporting it as a recovery tells the operator this broker restarted a host it
 * never touched, on an address it no longer controls.
 *
 * `indeterminate` fails closed for the same reason: something is serving and
 * ownership could not be proved, so the honest report is that recovery did not
 * demonstrably succeed. Both cases reach the operator through the managed-
 * runtime failure journal, which is where an address this broker has lost
 * belongs.
 *
 * `started` needs no verdict: it is returned only after this broker spawned the
 * child and its readiness probe passed, so the host is ours by construction.
 */
function isManagedHostRecovered(outcome: ManagedHostStartOutcome): boolean {
  if (outcome.action === 'started') return true;
  return outcome.action === 'already-serving' && outcome.verdict === 'owned';
}


/**
 * The supervision loop, as an object rather than a pair of loose variables.
 *
 * It exists so shutdown has something to AWAIT. Guarding ticks with a boolean is
 * enough to stop them overlapping each other, but it says nothing about the tick
 * already inside `recoverManagedHost` — which may be part-way through spawning a
 * replacement host. A shutdown that only waits for startup can finish its
 * release pass and then have that replacement appear behind it: a live process
 * with a valid ownership record and no broker left alive to reap it, which is
 * the leak this whole module exists to prevent, arrived at by timing.
 *
 * So `settled()` resolves when nothing is in flight, and shutdown waits on it
 * before releasing. Ticks after shutdown begins are refused outright.
 */
export class ManagedHostSupervisor {
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(private readonly options: {
    backends: () => readonly Parameters<typeof ensureManagedHost>[0][];
    effects: ManagedHostEffects;
    store: ManagedHostStore;
    ledger: ManagedHostRestartLedger;
    /** Asked before the tick and again before each backend, so a long tick stops promptly. */
    stopping: () => boolean;
    env?: Readonly<Record<string, string | undefined>>;
    onOutcome?: (agent: string, outcome: ManagedHostRecoveryOutcome) => void;
    onError?: (agent: string, error: unknown) => void;
  }) {}

  /**
   * Start one tick, unless one is already running or shutdown has begun.
   *
   * Deliberately not async: the interval that drives this must not be able to
   * queue ticks behind a slow one.
   */
  tick(): void {
    if (this.running || this.options.stopping()) return;
    this.running = true;
    this.inFlight = this.run().finally(() => { this.running = false; });
  }

  /** Resolves once no tick is in flight. Never rejects. */
  async settled(): Promise<void> {
    // Re-read rather than await once: a tick that started between the caller's
    // decision and this line is exactly the one being waited for.
    for (let seen = this.inFlight; ; seen = this.inFlight) {
      await seen.catch(() => undefined);
      if (seen === this.inFlight) return;
    }
  }

  private async run(): Promise<void> {
    for (const backend of this.options.backends()) {
      if (this.options.stopping()) return;
      try {
        const outcome = await recoverManagedHost(
          backend, this.options.effects, this.options.store, this.options.ledger, this.options.env,
        );
        this.options.onOutcome?.(backend.id, outcome);
      } catch (error) {
        this.options.onError?.(backend.id, error);
      }
    }
  }
}

// ── the real effects ────────────────────────────────────────────────────────

/**
 * Bound on retained child output, in characters.
 *
 * This is a DIAGNOSTIC of why a start failed, not a log: a host that fails by
 * printing forever must cost a fixed amount of memory.
 */
export const MANAGED_HOST_OUTPUT_LIMIT = 8 * 1024;

/**
 * Read a live process's stable identity, or null when this machine will not say.
 *
 * Null is load-bearing: it becomes 'indeterminate', which preserves the process.
 * Every failure path here — no such pid, unreadable `/proc`, absent `ps` — must
 * therefore return null rather than a partial identity, because a partial
 * identity that happens to compare equal would authorize a kill.
 *
 * `adapters/opencode/src/managed-server.ts` has an equivalent reader predating
 * this engine. The duplication is deliberate and safe — each copy is only ever
 * compared against records the same copy wrote, so a format difference between
 * them cannot produce a false match — and it goes away when that lane migrates
 * onto this engine.
 */
/**
 * This boot's identifier, or '' where the platform has none.
 *
 * Cached: it cannot change without the process ceasing to exist, and it is read
 * on every identity comparison.
 */
let cachedBootId: string | undefined;
export function readBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  if (process.platform !== 'linux') {
    cachedBootId = '';
    return cachedBootId;
  }
  try {
    cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    cachedBootId = '';
  }
  return cachedBootId;
}

export function readLiveProcess(pid: number): LiveProcess {
  if (!Number.isInteger(pid) || pid <= 0) return PROCESS_UNKNOWN;
  if (process.platform === 'linux') {
    // No boot id, no comparable start token, so no identity at all — rather than
    // an identity missing the one field that makes the others mean anything.
    const boot = readBootId();
    if (!boot) return PROCESS_UNKNOWN;
    let stat: string;
    try {
      // `/proc/<pid>/stat` is `pid (comm) state ...`, and comm may itself contain
      // spaces and parentheses — so fields are parsed AFTER the last ')'. From
      // there `state` is field 3, which puts start time (field 22) at index 19.
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      // ENOENT is the kernel positively stating there is no such process, and it
      // is the ONLY error here that means 'absent'. EACCES, EPERM, an unmounted
      // procfs and everything else mean the question went unanswered.
      return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? PROCESS_ABSENT : PROCESS_UNKNOWN;
    }
    const rparen = stat.lastIndexOf(')');
    if (rparen < 0) return PROCESS_UNKNOWN;
    const start = stat.slice(rparen + 1).trim().split(/\s+/)[19];
    if (!start) return PROCESS_UNKNOWN;
    let comm = '';
    try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* handled below */ }
    if (!comm) return PROCESS_UNKNOWN;
    return { state: 'running', identity: { pid, start, boot, comm } };
  }
  const ps = Bun.which('ps');
  if (!ps) return PROCESS_UNKNOWN;
  const field = (format: string): { ok: true; value: string } | { ok: false; absent: boolean } => {
    try {
      const result = Bun.spawnSync([ps, '-o', format, '-p', String(pid)], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, timeout: 3_000,
      });
      const value = new TextDecoder().decode(result.stdout).trim();
      if (result.exitCode === 0 && value) return { ok: true, value };
      // `ps -p` exits 1 with nothing on either stream when the pid does not
      // exist. Anything it complained about is an unanswered question instead.
      const noise = new TextDecoder().decode(result.stderr).trim();
      return { ok: false, absent: result.exitCode === 1 && !value && !noise };
    } catch {
      return { ok: false, absent: false };
    }
  };
  // `lstart` is an absolute wall-clock start time, so it is stable across reads
  // in a way an elapsed-time field would not be.
  const start = field('lstart=');
  if (!start.ok) return start.absent ? PROCESS_ABSENT : PROCESS_UNKNOWN;
  const comm = field('comm=');
  if (!comm.ok) return comm.absent ? PROCESS_ABSENT : PROCESS_UNKNOWN;
  // '' for boot: this platform's start token is an absolute wall-clock time, so
  // it is already unique across reboots and needs no boot qualifier.
  return { state: 'running', identity: { pid, start: start.value, boot: '', comm: comm.value } };
}

function boundedCapture(stream: ReadableStream<Uint8Array> | undefined | null): { read(): string } {
  let value = '';
  if (!stream) return { read: () => value };
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (value.length >= MANAGED_HOST_OUTPUT_LIMIT) continue; // drain, never grow
        value += decoder.decode(next.value, { stream: true }).slice(0, MANAGED_HOST_OUTPUT_LIMIT - value.length);
      }
    } catch {
      /* the process ended while its diagnostic stream was draining */
    }
  })();
  return { read: () => value };
}

/**
 * The production effects.
 *
 * `capturedOutput` from the returned child is BOUNDED but not redacted: it is
 * raw host output, so a caller that persists or logs it must sanitize first
 * (`recordManagedRuntimeFailure` does).
 */
export function defaultManagedHostEffects(): ManagedHostEffects {
  return {
    listener: (port) => {
      const lsof = Bun.which('lsof');
      if (!lsof) return HOST_UNKNOWN;
      try {
        // -t prints pids only; the -iTCP/-sTCP pair narrows to the LISTENING
        // socket on that port. Same flags on Linux and macOS.
        const result = Bun.spawnSync([lsof, '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
          stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env }, timeout: 3_000,
        });
        const pids = new TextDecoder().decode(result.stdout).trim().split(/\s+/).filter(Boolean);
        if (result.exitCode !== 0) {
          // lsof exits 1 both for "nothing matched" and for its own failures,
          // and only the first is proof of an empty address. It is quiet on a
          // clean miss and complains on everything else, so a silent exit 1 is
          // the one that authorizes spawning here.
          const noise = new TextDecoder().decode(result.stderr).trim();
          return result.exitCode === 1 && pids.length === 0 && !noise ? HOST_ABSENT : HOST_UNKNOWN;
        }
        // More than one listener on one port means this machine is not telling a
        // simple story (dual-stack duplicates, a fork sharing the socket), and
        // picking one would be a guess. Refuse to name any of them.
        if (pids.length !== 1) return HOST_UNKNOWN;
        return hostAt(Number(pids[0]));
      } catch {
        return HOST_UNKNOWN;
      }
    },
    liveProcess: readLiveProcess,
    spawn: (launch) => {
      const child = Bun.spawn([launch.command, ...launch.args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: launch.env ? { ...process.env, ...launch.env } : { ...process.env },
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
      });
      const stdout = boundedCapture(child.stdout as ReadableStream<Uint8Array> | undefined);
      const stderr = boundedCapture(child.stderr as ReadableStream<Uint8Array> | undefined);
      return {
        pid: child.pid,
        exited: child.exited,
        get exitCode() { return child.exitCode; },
        readOutput: () => `stdout:\n${stdout.read()}\nstderr:\n${stderr.read()}`,
      };
    },
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone, or not ours to signal; both are "nothing to do" */
      }
    },
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    deadline: (ms) => {
      let fire: () => void = () => {};
      const expired = new Promise<void>((resolve) => { fire = resolve; });
      // Unref'd: a readiness deadline is a bound on waiting, not a reason for
      // the broker to stay alive.
      const timer = setTimeout(() => fire(), ms);
      timer.unref?.();
      return { expired, cancel: () => clearTimeout(timer) };
    },
    selfPid: () => process.pid,
  };
}

// ── on-disk ownership store ─────────────────────────────────────────────────

export function managedHostOwnerPath(agent: string, home = setupStateHome()): string {
  if (!MANAGED_HOST_AGENT_ID.test(agent)) throw new Error('invalid managed-host agent id');
  return join(home, `managed-host-owner-${agent}.json`);
}

/**
 * Anything unreadable, malformed, or of an unknown schema reads as NO record.
 *
 * That is the fail-closed direction here, and it is worth being explicit about
 * which way "closed" points: a missing record means the live host is classified
 * foreign and therefore preserved. Corrupt state costs a host we can no longer
 * stop; the opposite default would cost someone else's host entirely.
 */
export function readManagedHostOwnership(agent: string, home = setupStateHome()): ManagedHostOwnership | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(managedHostOwnerPath(agent, home), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== MANAGED_HOST_OWNER_SCHEMA_VERSION) return null;
    if (record.agent !== agent) return null;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
    if (typeof record.start !== 'string' || record.start.length === 0) return null;
    // Empty is refused rather than accepted-and-compared: see HostProcessIdentity.
    if (typeof record.comm !== 'string' || record.comm.length === 0) return null;
    // Present but possibly '' — the honest value on a platform with no boot id.
    if (typeof record.boot !== 'string') return null;
    if (typeof record.identityKey !== 'string' || record.identityKey.length === 0) return null;
    if (typeof record.recordedAtMs !== 'number' || !Number.isFinite(record.recordedAtMs)) return null;
    const evidence = readManagedHostEvidence(record.evidence);
    if (!evidence) return null;
    return {
      schemaVersion: MANAGED_HOST_OWNER_SCHEMA_VERSION,
      pid: record.pid,
      start: record.start,
      boot: record.boot,
      comm: record.comm,
      agent,
      identityKey: record.identityKey,
      recordedAtMs: record.recordedAtMs,
      evidence,
    };
  } catch {
    return null;
  }
}

/**
 * Evidence is validated as strictly as identity, for one reason: it reaches an
 * operator's screen through `doctor` and an uninstall report, and a record
 * carrying a half-parsed executable path would describe a host that was never
 * launched. Anything malformed collapses the whole record to "no proof", which
 * preserves the live host — the same fail-closed direction as the rest.
 */
function readManagedHostEvidence(raw: unknown): ManagedHostEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.executable !== 'string' || value.executable.length === 0) return null;
  if (!Array.isArray(value.args) || value.args.some((entry) => typeof entry !== 'string')) return null;
  const evidence: ManagedHostEvidence = { executable: value.executable, args: value.args as string[] };
  if (typeof value.cwd === 'string' && value.cwd.length > 0) evidence.cwd = value.cwd;
  if (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0) evidence.port = value.port;
  if (typeof value.version === 'string' && value.version.length > 0) evidence.version = value.version;
  if (typeof value.profile === 'string' && value.profile.length > 0) evidence.profile = value.profile;
  return evidence;
}

/** Filename pattern for the per-agent ownership records, and its inverse. */
const MANAGED_HOST_OWNER_FILE = /^managed-host-owner-([a-z0-9][a-z0-9-]{0,63})\.json$/;

/**
 * Every managed host this installation has a record for.
 *
 * Needed because uninstall runs OUTSIDE the broker: there is no adapter registry
 * to ask, so the records themselves are the only list of hosts that might still
 * need reaping. Unreadable and malformed records are skipped rather than
 * reported — a record that proves nothing authorizes nothing, which is the same
 * fail-closed answer `readManagedHostOwnership` gives everywhere else.
 */
export function listManagedHostOwnerships(home = setupStateHome()): ManagedHostOwnership[] {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  const found: ManagedHostOwnership[] = [];
  for (const entry of entries) {
    const agent = MANAGED_HOST_OWNER_FILE.exec(entry)?.[1];
    if (!agent) continue;
    const record = readManagedHostOwnership(agent, home);
    if (record) found.push(record);
  }
  return found;
}

/** How long an uninstall waits after SIGTERM before escalating. */
export const MANAGED_HOST_UNINSTALL_STOP_MS = 5_000;

/**
 * Classify a recorded host without an adapter, using only what the record
 * itself carries.
 *
 * The evidence port is what makes this possible and is the reason it is
 * recorded: with it the host is located the same way a running broker would
 * locate it — by asking who holds the address. Without it the record's pid is
 * the only lead, and it is still only a LEAD: `classifyManagedHost` re-proves
 * start token and boot before anything is done to it, so a recycled pid is
 * classified foreign here exactly as it would be anywhere else.
 */
export function locateRecordedManagedHost(
  record: ManagedHostOwnership,
  effects: ManagedHostEffects,
): ManagedHostLocation {
  return record.evidence.port === undefined ? hostAt(record.pid) : effects.listener(record.evidence.port);
}

/** Stop a recorded host from outside the broker — uninstall's path. */
export async function stopRecordedManagedHost(
  record: ManagedHostOwnership,
  effects: ManagedHostEffects,
  store: ManagedHostStore,
  graceMs: number = MANAGED_HOST_UNINSTALL_STOP_MS,
): Promise<ManagedHostStopOutcome> {
  return await stopManagedHost(
    { agent: record.agent, identityKey: record.identityKey, stopGraceMs: graceMs },
    effects,
    store,
    async () => locateRecordedManagedHost(record, effects),
  );
}

export function managedHostStore(home = setupStateHome()): ManagedHostStore {
  return {
    read: (agent) => readManagedHostOwnership(agent, home),
    write: (record) => atomicWriteJsonOwnerOnly(managedHostOwnerPath(record.agent, home), record),
    clear: (agent) => rmSync(managedHostOwnerPath(agent, home), { force: true }),
  };
}
