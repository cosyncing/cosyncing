/** @cosyncing/adapter-api — provider adapter SPI and bounded setup diagnosis. */
export * from '@cosyncing/protocol';
export * from './diagnosis.ts';
export * from './integration.ts';
export * from './invocation.ts';
export * from './host-process.ts';
export * from './windows-ffi.ts';
export * from './tool-semantics.ts';
export * from './terminal-summary-registry.ts';
import { decodeSessionInfo, type AgentCapabilities, type AttachMode, type DriveAttachReason, type FileChange, type FileOperation, type ModeOption, type ModelOption, type PromptInput, type SessionConnection, type SessionInfo, type Unsubscribe } from '@cosyncing/protocol';
import type { AgentSetupDiagnosis, SetupDiagnosisContext } from './diagnosis.ts';

// ── Backend (one per tool) ───────────────────────────────────────────────────

/** Additive attach context. `reason` only accompanies an authenticated DRIVE
 *  attach — `mode=resume`, or `mode=live` where the reason is `takeover` (see
 *  `DriveAttachReason` for the full matrix); adapters that ignore it keep their
 *  existing behavior, which is exactly the mode-only compatibility path. */
export interface AttachOptions {
  reason?: DriveAttachReason;
}

/** A drive attach was denied because ownership facts prove (or cannot disprove)
 *  a competing owner. The broker maps this to a structured `attach-conflict`
 *  frame and falls back to an Observe-class attach on the same socket, so the
 *  client can stay honest and keep its provenance instead of seeing a generic
 *  socket failure. */
export class OwnershipConflictError extends Error {
  constructor(
    message: string,
    /** Machine conflict category, e.g. 'terminal-sync-active' | 'terminal-private' | 'terminal-unknown'. */
    public readonly conflict: string,
  ) {
    super(message);
    this.name = 'OwnershipConflictError';
  }
}

export function isOwnershipConflictError(error: unknown): error is OwnershipConflictError {
  return error instanceof OwnershipConflictError
    || (error instanceof Error && error.name === 'OwnershipConflictError' && 'conflict' in error);
}

/** A native resume request rejected the session before an app-side owner was
 *  admitted. Unlike {@link OwnershipConflictError}, this is not evidence of a
 *  competing writer: the native runtime itself declined to resume the thread.
 *
 *  The broker maps this to a distinct structured attach refusal and then
 *  falls back to Observe on the same socket. */
export class NativeSessionUnresumableError extends Error {
  constructor(
    message: string,
    /** Bounded native JSON-RPC code when one was supplied. */
    public readonly nativeCode?: string,
  ) {
    super(message);
    this.name = 'NativeSessionUnresumableError';
  }
}

/** Cross-realm-safe predicate for packaged/link-workspace adapter boundaries. */
export function isNativeSessionUnresumableError(error: unknown): error is NativeSessionUnresumableError {
  return error instanceof NativeSessionUnresumableError
    || (error instanceof Error && error.name === 'NativeSessionUnresumableError');
}

/** The adapter supports native rename for some sessions, but this particular
 *  row is outside its measured mutation boundary. The broker treats this as a
 *  request for its display-alias fallback, not as a failed native operation. */
export class NativeSessionRenameUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeSessionRenameUnsupportedError';
  }
}

/** Cross-realm-safe predicate for packaged/link-workspace adapter boundaries. */
export function isNativeSessionRenameUnsupportedError(
  error: unknown,
): error is NativeSessionRenameUnsupportedError {
  return error instanceof NativeSessionRenameUnsupportedError
    || (error instanceof Error && error.name === 'NativeSessionRenameUnsupportedError');
}

/** A session-scoped action was refused because the session is owned by the agent
 *  that spawned it (`SessionInfo.origin === 'subagent'`): its only writer is the
 *  parent session's run, so the capability does not exist for this row.
 *
 *  Deliberately NOT an {@link OwnershipConflictError}. That one asserts a competing
 *  owner the caller could still take over from; here there is no other owner to
 *  contend with and nothing a retry, a takeover, or a later attempt can change.
 *
 *  The broker maps this to the same typed `SESSION_AGENT_OWNED` / 409 its route
 *  gate returns, so an adapter refusal the gate could not anticipate (an
 *  undiscoverable session, a stale or absent roster row, a peer-served row) still
 *  reads as the permanent answer it is instead of a transient adapter fault. */
export class AgentOwnedSessionError extends Error {
  constructor(
    message: string,
    /** The refused session-scoped action, e.g. 'fork'. */
    public readonly action: string,
  ) {
    super(message);
    this.name = 'AgentOwnedSessionError';
  }
}

/** Cross-realm-safe predicate for {@link AgentOwnedSessionError}.
 *
 *  `instanceof` alone is not enough: an adapter and the broker can resolve
 *  different copies of this module (separate bundles, a linked workspace, the
 *  compiled single-file broker), and the class identity differs across them. The
 *  name-plus-shape arm is what survives that boundary — the same reason
 *  {@link isOwnershipConflictError} is written this way. */
export function isAgentOwnedSessionError(error: unknown): error is AgentOwnedSessionError {
  return error instanceof AgentOwnedSessionError
    || (error instanceof Error && error.name === 'AgentOwnedSessionError' && 'action' in error);
}

/** A new session cannot be created until an adapter-owned local runtime becomes usable.
 *
 * This is deliberately narrower than a generic adapter error. The broker maps it to a
 * typed 503 so a known startup/runtime prerequisite is never flattened into HTTP 500.
 * Callers must not use it for model, HTTP application, or other arbitrary failures. */
export class SessionCreateTemporarilyUnavailableError extends Error {
  constructor(
    message: string,
    /** Stable adapter-owned reason suitable for status/diagnostic correlation. */
    public readonly detailCode: string,
  ) {
    super(message);
    this.name = 'SessionCreateTemporarilyUnavailableError';
  }
}

/** Cross-realm-safe predicate for packaged/link-workspace adapter boundaries. */
export function isSessionCreateTemporarilyUnavailableError(
  error: unknown,
): error is SessionCreateTemporarilyUnavailableError {
  return error instanceof SessionCreateTemporarilyUnavailableError
    || (error instanceof Error
      && error.name === 'SessionCreateTemporarilyUnavailableError'
      && 'detailCode' in error);
}

export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  /** Optional native-host integration described as data for broker orchestration. */
  readonly integration?: import('./integration.ts').AgentIntegration;
  /**
   * Oldest client contract revision that may be SHOWN this agent at all.
   *
   * Declared by the adapter, applied by the broker when it projects
   * `/api/agents`, and never sent to anyone: a client below this revision is
   * simply not told the agent exists. It exists because the roster decodes as
   * ONE list, so an agent carrying an `integrationKind` or `attachMode` an
   * older client cannot parse costs that client EVERY agent, not just this one.
   *
   * Absent means every client may see it — the right default, because an agent
   * built from values that have always existed excludes nobody. Set it only for
   * an agent that introduces a value older clients cannot decode, and set it to
   * the revision that introduced the tolerance THAT AGENT NEEDS — the highest of
   * {@link CLIENT_REVISION_WITH_TOLERANT_INTEGRATION_KIND_DECODE} and
   * {@link CLIENT_REVISION_WITH_TOLERANT_ATTACH_MODE_DECODE} its own declared
   * values require — rather than the current revision, or the newest tolerance
   * that exists. Either shortcut silently hides the agent from a whole released
   * client generation that could have decoded it.
   */
  readonly minimumClientRevision?: number;
  /**
   * Ceiling on how long the registry will WAIT for this backend's discovery leg
   * — `isAvailable()` and `discoverSessions()` together — before abandoning it
   * for this sweep and aborting its in-flight work.
   *
   * Absent means no ceiling, which is right for a backend that reads local
   * files: it is bounded by the filesystem and cannot hang on a peer. Set it on
   * any backend whose discovery crosses a network to a host this broker does
   * not own, because {@link AgentRegistry.discoverAll} answers only when every
   * backend has, so one unresponsive host otherwise stalls the WHOLE roster —
   * including agents that answered in milliseconds.
   *
   * A per-request transport timeout is not a substitute. A leg is several
   * requests, and a host that accepts connections and answers slowly (or never)
   * pays that timeout once per request; the ceiling that matters to the roster
   * is over the leg.
   */
  readonly discoveryBudgetMs?: number;
  /**
   * Describe the external host this adapter talks to, so the broker can own its
   * lifecycle without knowing which agent this is.
   *
   * `null` means there is nothing to describe right now — no host is configured,
   * or the adapter cannot say where one would be. Absent entirely means the
   * agent has no external host, which is every adapter whose runtime the broker
   * already owns as its own child.
   *
   * This must be a READ: resolve configuration, consult a registry the host
   * maintains, report what it finds. It must not start, stop, signal, or connect
   * to anything. The broker performs every effect implied by what this returns,
   * and only after deciding it is allowed to.
   */
  describeManagedHost?(): Promise<import('./integration.ts').ManagedHostDescriptor | null>;
  /**
   * WHICH host a given environment points this adapter at, as an opaque identity
   * key — the same key {@link import('./integration.ts').ManagedHostDescriptor}
   * records ownership under.
   *
   * Pure and parameterized, which is the whole point: `describeManagedHost`
   * answers for the environment this adapter instance was constructed with, and
   * the broker needs the answer for an environment it is NOT running in — the
   * installed service's. That is what makes the managed posture specific to a
   * configuration instead of to an agent, so an operator pointed at some other
   * home or address is not told that host is supervised.
   *
   * `null` where the environment names no host this adapter could talk to (an
   * unusable address), which is an identity nothing can match.
   *
   * Adapters that declare `integration.externalHost` must implement this; the
   * broker cannot scope a posture it cannot name, and a managed host with no
   * identity would have to be treated as agent-wide again.
   */
  managedHostIdentity?(inputs: import('./integration.ts').ManagedHostIdentityInputs): string | null;
  /** Exact readiness of the described managed host; defaults to isAvailable. */
  isManagedHostReady?(options?: AvailabilityOptions): Promise<boolean>;
  /** Is the tool installed / its server reachable right now? */
  isAvailable(options?: AvailabilityOptions): Promise<boolean>;
  /** Read-only setup/doctor checks. This path must not call discovery or start/install any runtime. */
  diagnoseSetup?(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis>;
  /** Enumerate sessions for the roster.
   *
   * `updatedAfter` is an authoritative query bound, not a presentation hint:
   * adapters should apply it before decoding native session payloads wherever
   * their store supports that. Active/needs-input sessions remain eligible
   * regardless of age. */
  discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]>;
  /** Open (or join) a session. `mode` defaults to the session's best available.
   *  `opts.reason` (additive) lets a resume attach carry its authenticated intent so the
   *  adapter can arbitrate restore-vs-takeover atomically; adapters may ignore it. */
  attach(sessionId: string, mode?: AttachMode, opts?: AttachOptions): Promise<SessionConnection>;
  /** Dynamic readiness for native title persistence. Hook presence describes the static
   * capability; this probe prevents clients from offering it while the runtime is gated. */
  canRenameNative?(): Promise<boolean> | boolean;
  /** Revoke ADAPTER-OWNED automatic Drive eligibility for one session.
   *
   *  Only for adapters that keep their own record of which sessions they may drive — the broker's
   *  connection registry is not that record. Kimi is the case this exists for: it tracks the sessions
   *  this process created, and a live attach on one of them is granted automatically. Closing the
   *  native owner does not touch that record, so terminal handoff would release the connection and
   *  the very next open would silently take Drive back without the user asking.
   *
   *  Called by the hub AFTER the native owner has closed and been unregistered, and BEFORE the
   *  replacement Observe connection is constructed — the ordering matters, because an adapter asked
   *  for an observe attach while it still believes it owns the session can publish a drivable row.
   *
   *  Adapters with no adapter-owned eligibility omit it entirely; the hub treats its absence as
   *  "nothing to revoke", never as an error. Must be idempotent: a retry, or a demotion that already
   *  revoked the same session, has to be a no-op rather than a second state change. */
  releaseDriveEligibility?(sessionId: string): Promise<void> | void;
  /** Optional dynamic availability for createSession, used when create depends on a live daemon. */
  canCreateSession?(): Promise<boolean> | boolean;
  /** Bounded adapter-owned readiness boundary invoked before model validation and the one create call.
   * Implementations may wait/re-probe safe prerequisites, but must never create a native session here. */
  prepareCreateSession?(): Promise<void>;
  /** Adapter-owned pre-session catalog. Absence means model selection is unavailable. */
  listModels?(): Promise<ModelOption[]>;
  /** Adapter-owned pre-session approval modes. Absence means creation uses the native default. */
  listModes?(): Promise<ModeOption[]>;
  /** Create a brand-new session and return it (for tools that support it). */
  createSession?(opts?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
    permissionMode?: string;
  }): Promise<SessionInfo>;
  /** Optional native session-title rename. The broker may still keep its own display-title override
   *  when a tool cannot or should not rewrite native history. Passing null clears the override. */
  renameSession?(sessionId: string, title: string | null): Promise<SessionInfo | void>;
  /** Optional native session fork/branch. The adapter owns native fork-point semantics; messageId is
   *  supplied only when the client selected a specific parent message. */
  forkSession?(sessionId: string, opts?: { messageId?: string | null }): Promise<SessionInfo | void>;
  /** Optional native session clone. Kept distinct from fork because clone/head-copy semantics are not
   *  the same as a user-selected fork point. */
  cloneSession?(sessionId: string): Promise<SessionInfo | void>;
  /** Optional native transcript export for the gated R2 `transcriptExport` action. The adapter writes
   *  a native export into the BROKER-OWNED `opts.tempDir` (never a client-supplied path), enforces its
   *  own size/timeout guard, and returns the produced file path + format. The broker then verifies
   *  path containment, runs the mandatory redaction pass, and delivers it as an `export-attachment`
   *  file-artifact. Presence of this hook (not the tool name) gates the app's export command. */
  exportTranscript?(sessionId: string, opts: { tempDir: string; maxBytes: number; timeoutMs: number }): Promise<{ path: string; format: 'json' | 'html' }>;
  /** Static native export format for the R2 confirm nonce/card, read generically (no tool-name branch). */
  readonly transcriptExportFormat?: 'json' | 'html';
  /** Optional generic liveness signal: is ANY of this backend's sessions mid-turn (working or blocked
   *  on input)? Read generically (no tool-name branch) by owners of a restartable server so they can
   *  defer a disruptive restart until the backend is quiescent (C5 serve-restart guardrail). */
  anySessionBusy?(): boolean;
  /** Optional low-latency session metadata/control watcher. Adapters use this for externally-owned
   *  state changes that are visible without opening a second driver, such as a terminal-sync bridge
   *  socket appearing/disappearing. The broker pushes the returned SessionInfo to attached clients. */
  watchSessionInfo?(onChange: (info: SessionInfo) => void): Unsubscribe;
}

/** Per-call context for an availability probe. */
export interface AvailabilityOptions {
  /**
   * Aborted when the caller stops waiting — the discovery budget expiring is
   * the case this exists for. A backend that reaches a network MUST thread it
   * into the request it is waiting on; abandoning the promise bounds the
   * caller but leaves the socket open to a host that already proved it will
   * not answer.
   */
  signal?: AbortSignal;
}

export interface SessionDiscoveryOptions {
  /** Inclusive UTC epoch-millisecond cutoff for idle historical sessions. */
  updatedAfter?: number;
  /**
   * A STABLE name for the window this sweep is asking about, used to keep one
   * scope's remembered rows out of another's.
   *
   * `updatedAfter` cannot do this job. A caller derives it from the current
   * clock -- the broker uses `now - windowMs` -- so it differs on every sweep
   * of the SAME window, while two different windows share one registry. Without
   * a stable name the abandoned-leg memory is simply whichever sweep finished
   * last, and a wide sweep then inherits a narrow sweep's answer.
   *
   * Optional. A caller that omits it gets a memory keyed by the moving cutoff,
   * which costs it the carry but never lets its rows reach another scope.
   */
  scopeKey?: string;
  /** Optional deterministic evidence hook for bounded-discovery fixtures. */
  onWork?: (work: SessionDiscoveryWork) => void;
  /** See {@link AvailabilityOptions.signal}; the same signal spans the whole leg. */
  signal?: AbortSignal;
  /**
   * Wall-clock ceiling for the WHOLE registry sweep, across every backend.
   *
   * This is distinct from {@link AgentBackend.discoveryBudgetMs}: a leg budget
   * protects the roster from one remote host, while this ceiling prevents the
   * sum of local reads and concurrent legs from occupying the broker forever.
   * Every leg still running when it expires is abandoned, contributes bounded
   * carry under the existing rules, and is reported as unconfirmed. A caller's
   * own {@link signal} remains cancellation and never spends carry.
   */
  sweepBudgetMs?: number;
  /**
   * Rows an adapter has finished mapping, reported as they become ready, so a
   * leg abandoned at its budget contributes what it had instead of nothing.
   *
   * Purely additive and opt-in. An adapter that ignores it behaves exactly as
   * before — its abandoned leg contributes no rows — so this cannot change the
   * roster for any adapter that has not been taught to call it.
   *
   * Worth calling from any adapter that can finish rows incrementally. A
   * backend's own {@link AgentBackend.discoveryBudgetMs} or the caller's whole
   * sweep ceiling may abandon the leg. Call it with rows that are already final:
   * the registry validates each one and a row reported here is used verbatim if
   * the leg is later abandoned.
   */
  onPartialRows?: (rows: readonly SessionInfo[]) => void;
  /**
   * One backend's FINAL rows, reported the moment that leg settles rather than
   * when the whole sweep does.
   *
   * The sweep answers only when its LAST leg finishes, so a fast adapter's rows
   * sat unpublished behind a slow one: measured at
   * `omp=153ms/209r` inside a sweep that took `22641ms` because
   * `reasonix=22631ms` was still running. A session started in a terminal has no
   * live owner to push it, so until that sweep landed it did not exist as far as
   * the roster was concerned — long enough for a short OMP run to finish its
   * whole tool call before a client could attach to it.
   *
   * Reported for a leg that COMPLETED, and only then. An abandoned or failed
   * leg returns carried rows from {@link AgentRegistry.lastGoodRows}, which is
   * keyed by backend id and not by `updatedAfter` — so a leg carrying under one
   * window can hand back rows another window's sweep remembered, and a
   * caller-cancelled leg is deliberately given no carry at all and would report
   * nothing. Neither is an improvement on rows a consumer is already serving,
   * so neither is published; the previous rows simply stand.
   *
   * `rows` therefore always comes from a completed read, and a consumer may
   * replace that backend's rows with it outright.
   *
   * The partition key is `SessionInfo.tool`, which every shipped adapter sets
   * equal to its own `AgentBackend.id`. A consumer merging by tool depends on
   * that, and {@link AgentRegistry.discoverAll} enforces it.
   *
   * Purely additive: a caller that ignores it sees the unchanged end-of-sweep
   * result.
   */
  onLegRows?: (backendId: string, rows: readonly SessionInfo[]) => void;
}

/**
 * {@link AgentBackend.discoveryBudgetMs} for a backend whose sessions live in an
 * external host process.
 *
 * ONE number for all of them, deliberately. A per-adapter budget would be a
 * second policy for a question that is not about any adapter: how long the
 * roster may be held hostage by a host nobody here owns. The adapters differ in
 * their per-request timeouts (5s and 30s today) precisely because those answer
 * a different question — how long ONE request may take — and neither of them
 * bounds a leg.
 *
 * This was five seconds, on the reasoning that five seconds is "above any
 * healthy leg by orders of magnitude: these hosts are on loopback, where a JSON
 * read is milliseconds". Measurement says otherwise, and the number moved
 * because of it. A leg is not one loopback read; it is a whole discovery. The
 * old concurrent sweep made that cost much worse:
 *
 *   cline, alone and sequential ....................  140ms
 *   cline, six legs at once (probe) ................ 1765ms
 *   cline, six legs at once (broker, 485 sessions) . 4334ms
 *
 * The last line is a healthy leg returning all 53 of its rows, against a 5000ms
 * budget — 15% of headroom. So the budget was not detecting a host that accepts
 * and never answers, which is the only thing it exists for; it was firing on
 * ordinary I/O contention, and it was not alone. Every substantial leg in that
 * sweep ran 25-80x its standalone time (reasonix 219ms->4286ms, claude
 * 46ms->3783ms, opencode 3111ms for THREE rows), which is the shape of a shared
 * bottleneck rather than any adapter being slow.
 *
 * Production now runs legs serially, which removes the contention that caused
 * those false overruns. Fifteen seconds still keeps the property the five was
 * chosen for — a bounded wait,
 * far below what a user reads as "cosyncing is broken" — with roughly 3.5x over
 * the slowest healthy leg actually observed, rather than 1.15x. The cost is that
 * a genuinely wedged host holds the roster longer before the sweep gives up. That
 * is the right side to err on: a wedged host still contributes whatever it had
 * (see {@link SessionDiscoveryOptions.onPartialRows}), whereas a false
 * abandonment silently deletes a healthy adapter's sessions from the roster.
 */
export const EXTERNAL_HOST_DISCOVERY_BUDGET_MS = 15_000;

/**
 * How long an abandoned leg may carry the rows of its last SUCCESSFUL sweep.
 *
 * The budget is wall-clock, so load trips it on adapters that are not at fault:
 * cline answers in ~140ms measured alone and took 15.8s inside a broker busy
 * with browser sessions. Dropping its rows because of that publishes "this
 * adapter has no sessions", which is a lie the adapter cannot detect or
 * correct, and it is the ONLY user-visible harm abandonment causes.
 *
 * Raised from two minutes, because two minutes did not work. The old rationale
 * was that it "covers a burst of slow sweeps (the observed overruns came in
 * runs of one to three)", which assumes sweeps arrive close together. Measured
 * against three days of this broker's own journal, they do not:
 *
 *     cline discovery abandoned              109
 *     ...of which still blanked the lane      22
 *
 * and the blanking ones are mostly ISOLATED overruns, not bursts — an hour of
 * quiet, one abandoned sweep, every Cline session gone. Roster sweeps are
 * DEMAND-DRIVEN (a client opening the roster), so the gap between them has no
 * upper bound this layer can know, and a window tuned to a burst cannot cover
 * it.
 *
 * The cap is deliberately NOT the thing that stops an uninstalled tool
 * advertising: that case returns `available: false`, which is a SUCCESSFUL leg
 * whose empty result legitimately replaces the remembered rows. What the cap
 * bounds is a persistently WEDGED host — and see
 * {@link ABANDONED_LEG_CARRY_SWEEPS}, which bounds it by consecutive failures
 * instead, independent of how often anyone looks.
 */
export const ABANDONED_LEG_LAST_GOOD_MS = 900_000;

/**
 * How many consecutive failed sweeps a backend may be carried through.
 *
 * The cadence-independent half of the bound. Time alone cannot separate "nobody
 * has opened the roster in ten minutes" from "this host has been wedged for ten
 * minutes"; a run of failures can. Five is enough that no plausible burst of
 * contention exhausts it, and small enough that a genuinely wedged host stops
 * advertising sessions that are not there within a handful of attempts.
 */
export const ABANDONED_LEG_CARRY_SWEEPS = 5;

/**
 * Whether rows remembered for `remembered` may be replayed for a request whose
 * cutoff is `wanted`. True only when the memory is at least as WIDE, because
 * the caller narrows a carry by filtering and no filter can recover rows a
 * narrower sweep never read.
 *
 * `undefined` means no cutoff, which is the widest question there is: a memory
 * of everything answers any window, and nothing but a memory of everything
 * answers the all-time roster.
 */
export function lastGoodCoversCutoff(
  remembered: number | undefined,
  wanted: number | undefined,
): boolean {
  if (remembered === undefined) return true;
  if (wanted === undefined) return false;
  return remembered <= wanted;
}

/**
 * How many discovery legs a production sweep starts at once.
 *
 * Six looked fastest in an isolated benchmark. The installed broker disproved
 * that model: one six-leg cohort occupied the event loop for 36-48 seconds and
 * delayed even the timers meant to abandon it. Serial discovery, with a
 * macrotask turn between legs, bounds the synchronous continuation work queued
 * ahead of health, status, and live-session sockets.
 */
export const DISCOVERY_FAN_OUT_LIMIT = 1;

/**
 * Fan-out actually used. Raising this is an explicit diagnostic opt-in to the
 * concurrency production avoids; the hard ceiling keeps that experiment below
 * the old unbounded shape.
 */
export function discoveryFanOutLimit(): number {
  const raw = Number(process.env.COSYNCING_DISCOVERY_FAN_OUT);
  if (!Number.isFinite(raw) || raw < 1) return DISCOVERY_FAN_OUT_LIMIT;
  return Math.min(Math.floor(raw), 6);
}

/**
 * The width every per-row discovery batch uses.
 *
 * Chosen by measurement, and the measurement is the whole point: a batch is a
 * SEQUENTIAL round of the event loop. Under the old concurrent sweep, a leg
 * sharing that loop with five siblings was starved at every one of them. Narrow
 * batches therefore made a starved leg dramatically slower. Timed over 101 real
 * Cline sessions with five
 * busy-loops holding the loop, twice:
 *
 *     unbounded    firstRow 254ms / 7ms     total  272ms /  21ms
 *     batch 8      firstRow 369ms / 124ms   total 5607ms / 5558ms
 *     batch 64     firstRow   7ms / 4ms     total  159ms /  84ms
 *
 * Batch 8 cost 265x the unbounded total and salvaged nothing before a 15s
 * budget fired. Batch 64 matches unbounded while still capping simultaneous
 * descriptors, because 127 rows is two rounds rather than sixteen.
 */
export const DISCOVERY_ROW_BATCH = 64;

/**
 * Map over rows a bounded number at a time.
 *
 * `Promise.all` over every discovered session is the shape both the Grok and
 * Cline discovery legs used, and each element does per-session I/O — an `open`
 * for a boundary, a read for a snapshot. At 127 Cline sessions, and far more
 * elsewhere, that is one simultaneous file descriptor per row inside a process
 * already running up to {@link DISCOVERY_FAN_OUT_LIMIT} legs at once.
 *
 * See {@link DISCOVERY_ROW_BATCH} for why the width is what it is; a narrow one
 * is worse than no bound at all.
 *
 * Order is preserved: the result is indexed by input position, not by
 * completion.
 */
export async function mapInBatches<T, R>(
  rows: readonly T[],
  size: number,
  map: (row: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Number.isSafeInteger(size) && size > 0 ? size : 1;
  const out: R[] = new Array<R>(rows.length);
  for (let start = 0; start < rows.length; start += width) {
    const batch = rows.slice(start, start + width);
    const values = await Promise.all(batch.map((row, offset) => map(row, start + offset)));
    for (let offset = 0; offset < values.length; offset += 1) out[start + offset] = values[offset]!;
  }
  return out;
}

/**
 * Legs currently in flight, so each can report the most company it kept.
 *
 * `elapsedMs` alone cannot tell a slow adapter from a starved one, and the
 * difference is the whole question when a sweep is slow: reasonix reported
 * 7495ms in-broker for work that takes ~690ms standalone. A leg records the
 * peak here, and every leg already running is bumped when a new one starts, so
 * the peak is the real overlap rather than a sample taken at one instant.
 */
const legsInFlight = new Set<{ peak: number }>();

function enterLeg(): { peak: number } {
  const record = { peak: legsInFlight.size + 1 };
  legsInFlight.add(record);
  for (const other of legsInFlight) {
    if (legsInFlight.size > other.peak) other.peak = legsInFlight.size;
  }
  return record;
}

function leaveLeg(record: { peak: number }): number {
  legsInFlight.delete(record);
  return record.peak;
}

/**
 * One native read/query performed by session discovery — or the registry giving
 * up on a whole leg.
 *
 * The last variant is not work an adapter did; it is work the roster LOST, and
 * it is here because that loss was previously silent. An abandoned leg returns
 * `[]`, which is byte-identical to "this adapter has no sessions", so a roster
 * missing every session of one adapter looked exactly like an adapter that had
 * nothing to offer. Diagnosing one such case took eight wrong theories across
 * several sessions; the leg that was actually failing sat at a 9% margin under
 * its own budget, which no amount of reading the code reveals.
 */
export type SessionDiscoveryWork =
  | { kind: 'decode-file'; source: string }
  | { kind: 'sqlite-query'; source: string; bounded: boolean; cutoff?: number }
  | {
      kind: 'leg-abandoned';
      backendId: string;
      budgetMs: number;
      /** Whether this backend's ceiling or the whole sweep's ceiling fired. */
      budgetKind?: 'leg' | 'sweep';
      elapsedMs: number;
      /** Rows the leg had already reported via
       *  {@link SessionDiscoveryOptions.onPartialRows} and that therefore
       *  SURVIVE the abandonment. Zero for an adapter that reports none. */
      salvagedRows: number;
    }
  /**
   * What one leg actually cost, reported for EVERY leg rather than only the
   * ones that overran.
   *
   * Reported because the interesting case turned out to be invisible without
   * it: an adapter that answers in ~140ms standalone was overrunning a 5000ms
   * budget inside the broker, and no probe could say which leg the time really
   * went to — the adapters most likely to be slow are the ones that manage a
   * host, which is exactly what a probe must not construct beside a running
   * broker. Only the process with the problem can measure it.
   */
  | {
      kind: 'leg-elapsed';
      backendId: string;
      /**
       * WALL-CLOCK, not CPU time. Production runs one leg at a time, but an
       * explicit diagnostic fan-out can make several share one event loop. Read
       * this together with {@link concurrentPeak}: a high `elapsedMs` at
       * `concurrentPeak: 1` is attributable to that leg; the same number at
       * `concurrentPeak: 6` includes sibling contention.
       *
       * Measured, and the reason this field is now documented rather than
       * trusted: `opencode=4525ms/2r` beside `omp=130ms/149r` in the same sweep,
       * and a reasonix leg that reported 7495ms in-broker answered in ~690ms
       * standalone against the same store.
       */
      elapsedMs: number;
      /**
       * The most legs in flight at any point during this one, itself included.
       * 1 means the leg had the loop to itself and `elapsedMs` IS its cost.
       */
      concurrentPeak: number;
      /** Rows the leg contributed to this sweep, after decoding. */
      rows: number;
      /** True when {@link SessionDiscoveryWork} also reported `leg-abandoned`. */
      abandoned: boolean;
      /** True when {@link SessionDiscoveryWork} also reported `leg-failed`. */
      failed: boolean;
    }
  /**
   * A leg that THREW rather than returning rows.
   *
   * Distinct from a leg that legitimately has nothing: an exception says the
   * adapter could not answer, and treating that as "this tool has no sessions"
   * pushes every one of its rows to every client as a deletion. Reported so the
   * distinction exists in the record, because the failure is otherwise silent —
   * the caught exception used to become `[]` with no line anywhere.
   */
  | {
      kind: 'leg-failed';
      backendId: string;
      elapsedMs: number;
      /** The thrown message, for the log line. Never a value from the store. */
      reason: string;
      /** Rows the CARRY contributed — the published total minus what this leg
       *  itself produced. Zero when nothing was remembered to cover it. */
      carriedRows: number;
    };

// ── Registry ─────────────────────────────────────────────────────────────────

/** Holds the registered adapters. Adding a tool touches only registration. */
/**
 * What a declared discovery budget actually means, including when it is nonsense.
 *
 * `undefined` is "no budget" and stays that way: that is every local adapter,
 * which reads the filesystem and has nothing to hang on, and putting a deadline
 * on that could only lose sessions.
 *
 * A DECLARED but unusable value — 0, negative, NaN, Infinity — is a different
 * thing entirely, and the one meaning it must never take is "therefore wait
 * forever". A backend declares this field only because its discovery can cross
 * to a host the broker does not own, so a broken number is exactly the case
 * where the bound matters most. It falls back to the standard budget.
 */
export function effectiveDiscoveryBudgetMs(declared: number | undefined): number | undefined {
  if (declared === undefined) return undefined;
  return Number.isFinite(declared) && declared > 0 ? declared : EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
}


export class AgentRegistry {
  private readonly backends = new Map<string, AgentBackend>();
  /**
   * One complete production discovery sweep across every concurrent roster
   * window. A per-leg lock still interleaves 7-day and all-time sweeps, making
   * each sweep's aggregate clock include the other's work. The tail never
   * rejects; every holder releases it in `finally`.
   */
  private discoverySweepTail: Promise<void> = Promise.resolve();
  /**
   * Registration index that receives the first turn after an aggregate sweep
   * expiry. A fixed start order lets one wedged early backend consume every
   * sweep and permanently deny all later adapters a native read. Output still
   * uses registration order; only the order in which work gets time changes.
   */
  private discoveryResumeIndex = 0;
  /** Rows the last SUCCESSFUL leg returned, per backend AND discovery scope, for
   *  {@link ABANDONED_LEG_LAST_GOOD_MS}.
   *
   *  Scoped because the broker sweeps several windows concurrently against one
   *  registry. With a single memory per backend the last sweep to finish won,
   *  whatever question it had answered: a narrow success overwrote the wide
   *  rows, and the next abandoned wide leg then either replayed a 7-day answer
   *  as the all-time roster or -- once that was refused -- carried NOTHING and
   *  deleted the lane outright. Both delete sessions from every client, because
   *  the carry is the sweep's return value and the runtime stores it as
   *  authoritative.
   *
   *  `cutoff` is the `updatedAfter` those rows answered. It stays as a guard on
   *  top of the scope key, for a caller that reuses one key across genuinely
   *  different windows. */
  private readonly lastGoodRows = new Map<string, {
    backendId: string; at: number; rows: SessionInfo[]; cutoff: number | undefined;
  }>();

  /** One run of consecutive carries for a backend+scope.
   *
   *  Separate from the memory because a scope may BORROW another scope's rows,
   *  and borrowing must not spend the lender's budget.
   *
   *  `startedAt` dates the run so a carry can tell whether the rows it is about
   *  to serve have been re-confirmed since the run began. `touchedAt` exists
   *  only to bound this map; it is never a re-arm, because
   *  {@link ABANDONED_LEG_CARRY_SWEEPS} is deliberately independent of how
   *  often anyone looks. */
  private readonly lastGoodCarries = new Map<string, {
    count: number; startedAt: number; touchedAt: number;
  }>();

  /**
   * Memory key for one backend's answer to one discovery scope.
   *
   * `scopeKey` is the caller's STABLE name for the window. The derived
   * `updatedAfter` cannot serve: the broker computes it as `now - windowMs`, so
   * it moves every request, and keying on it would mean the carry never hits.
   * A caller that supplies no `scopeKey` but does pass a cutoff falls back to
   * that moving value, which costs it the carry but keeps its answers out of
   * every other scope's memory -- the safe direction to fail.
   */
  private static lastGoodKey(backendId: string, options?: SessionDiscoveryOptions): string {
    const scope = options?.scopeKey
      ?? (options?.updatedAfter === undefined ? 'all' : `cutoff:${options.updatedAfter}`);
    return `${backendId}\u0000${scope}`;
  }

  /**
   * Decode and partition-check one batch of partial rows.
   *
   * Shared, because {@link SessionDiscoveryOptions.onPartialRows} documents the
   * registry as validating EVERY partial row and only the budgeted path used to
   * do it. The unbudgeted path handed the caller's callback straight to the
   * adapter, so on that path the promise was simply untrue.
   */
  private static acceptPartialRows(
    backend: AgentBackend,
    rows: readonly SessionInfo[],
  ): SessionInfo[] {
    const accepted: SessionInfo[] = [];
    for (const row of rows) {
      const decoded = decodeSessionInfo(row);
      if (!decoded) {
        console.warn(`[adapter-api] ${backend.id} reported a malformed partial discovery row; row withheld`);
        continue;
      }
      if (decoded.tool !== backend.id) {
        console.warn(
          `[adapter-api] ${backend.id} reported a partial discovery row filed under tool `
            + `'${decoded.tool}'; row withheld`,
        );
        continue;
      }
      accepted.push(decoded);
    }
    return accepted;
  }

  /** Drop memories and carry runs no longer in play, so an unstable scope key
   *  cannot grow either map without bound.
   *
   *  Both maps are swept, not just `lastGoodRows`. A scope that BORROWS another
   *  scope's rows records a carry under a key it has no memory of its own for,
   *  so keying this loop off `lastGoodRows` alone left that count unreleasable
   *  by anything but a successful sweep in that scope -- and a scope whose host
   *  is wedged never has one. Its lane went empty on the sixth sweep and stayed
   *  empty for the life of the process, while the scope it borrowed from was
   *  still succeeding. */
  private pruneLastGood(now: number): void {
    for (const [key, entry] of this.lastGoodRows) {
      if (now - entry.at > ABANDONED_LEG_LAST_GOOD_MS) this.lastGoodRows.delete(key);
    }
    // By LAST TOUCH, not by when the run began: dropping a live run because it
    // has lasted a while would re-arm the sweep cap on a clock, which the cap
    // is explicitly not supposed to answer to. This only forgets scopes nobody
    // has swept in that long, which by definition have no question pending.
    for (const [key, run] of this.lastGoodCarries) {
      if (now - run.touchedAt > ABANDONED_LEG_LAST_GOOD_MS) this.lastGoodCarries.delete(key);
    }
  }

  register(backend: AgentBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  list(): AgentBackend[] {
    return [...this.backends.values()];
  }

  private async withProductionDiscoverySweep<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.discoverySweepTail;
    let release!: () => void;
    this.discoverySweepTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  /**
   * Discover sessions across all available backends; failures are isolated, and
   * so is SLOWNESS.
   *
   * The isolation that used to exist here was only for throwing: one backend's
   * exception could not lose another's sessions. But the answer still waits for
   * every backend, so a backend that neither throws nor returns held the entire
   * roster — and the backends that can do that are exactly the ones talking to
   * a host the broker does not own. A host that accepts the connection and then
   * says nothing is the shape that matters: it is indistinguishable from a slow
   * one, so nothing below fails, and every established local agent waits behind
   * it.
   *
   * {@link AgentBackend.discoveryBudgetMs} bounds that wait per backend. On
   * expiry the leg is abandoned for this sweep — the backend contributes no
   * rows, exactly as an unavailable one does — and its signal is aborted so a
   * cooperating adapter tears the request down rather than leaving a socket
   * open to a host that has already proved it will not answer.
   *
   * The race is what makes the bound hold: a backend that ignores its signal
   * delays nothing, because the registry has already stopped waiting on it.
   *
   * That the abandoned leg looks like an empty one WAS the bound's cost, and it
   * is REPORTED rather than left to be inferred: see the `leg-abandoned` variant
   * of {@link SessionDiscoveryWork}. Silence here is worse than the truncation
   * itself, because a roster that is quietly missing one adapter entirely reads
   * as an adapter with nothing in it.
   *
   * It is no longer the cost, because an abandoned leg now carries the rows its
   * last SUCCESSFUL sweep returned — see {@link ABANDONED_LEG_LAST_GOOD_MS}. A
   * budget measured in wall-clock is trippable by load rather than by any fault
   * of the adapter (measured: cline answers in ~140ms alone and took 15.8s
   * inside a loaded broker), so treating an overrun as "this adapter has no
   * sessions" deletes healthy rows from the roster for a reason the adapter
   * cannot control or detect.
   */
  async discoverAll(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    // Bounded fan-out, so a sweep opens a bounded number of host connections at
    // once however many adapters ship. In an isolated process, six at a time
    // finished the whole sweep sooner than twelve — measured, not assumed:
    //
    //   unbounded  total 9556ms   cline 5361ms   over 5s: reasonix, cline, codex
    //   cap 4      total 2402ms   cline 1754ms   over 5s: none
    //   cap 6      total 1952ms   cline 1765ms   over 5s: none
    //
    // The installed process is the deciding environment. There, six-way cohorts
    // still took 36-48s and made /api/health unreachable while each standalone
    // leg remained bounded. Production therefore serialises and yields between
    // legs; the diagnostic override above can still reproduce overlap without
    // making it the safe default.
    const backends = this.list();
    const width = Math.min(discoveryFanOutLimit(), backends.length);
    if (width === 1) {
      // Acquire before constructing the aggregate timeout. A queued window has
      // not started discovery yet, so another window's work cannot consume its
      // budget or make untouched trailing lanes look abandoned at 0ms.
      return await this.withProductionDiscoverySweep(
        () => this.discoverAllNow(backends, options, width),
      );
    }
    return await this.discoverAllNow(backends, options, width);
  }

  private async discoverAllNow(
    backends: readonly AgentBackend[],
    options: SessionDiscoveryOptions | undefined,
    width: number,
  ): Promise<SessionInfo[]> {
    const perBackend: SessionInfo[][] = new Array(backends.length);
    const requestedSweepBudget = options?.sweepBudgetMs;
    const sweepBudgetMs = requestedSweepBudget !== undefined
      && Number.isFinite(requestedSweepBudget)
      && requestedSweepBudget > 0
      ? Math.min(Math.floor(requestedSweepBudget), 2_147_483_647)
      : undefined;
    const sweepExpiry = sweepBudgetMs === undefined
      ? undefined
      : AbortSignal.timeout(sweepBudgetMs);
    const startIndex = backends.length === 0
      ? 0
      : this.discoveryResumeIndex % backends.length;
    const executionOrder = backends.map(
      (_backend, offset) => (startIndex + offset) % backends.length,
    );
    let next = 0;
    let lastStartedIndex: number | undefined;
    // Index-assigned rather than pushed, so the roster keeps registration order.
    const worker = async (): Promise<void> => {
      for (;;) {
        const orderIndex = next;
        next += 1;
        const index = executionOrder[orderIndex];
        if (index === undefined) return;
        const backend = backends[index];
        if (!backend) return;
        const runLeg = async (): Promise<SessionInfo[]> => {
          // Remember only adapters that were actually offered a turn before the
          // aggregate deadline. The skipped placeholders below exist to run the
          // normal carry/reporting transitions; they must not move this cursor
          // or the same early wedge will win again on the next sweep.
          if (sweepExpiry?.aborted !== true) lastStartedIndex = index;
          return await this.discoverFromBackend(
            backend,
            options,
            sweepExpiry,
            sweepBudgetMs,
          );
        };
        if (width === 1) {
          // The complete production sweep owns the registry slot. Retain a
          // macrotask turn between legs so health, status, and live sockets can
          // run between synchronous native projections.
          await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
          perBackend[index] = await runLeg();
        } else {
          // A promise/microtask yield is not enough. Keep the explicit
          // diagnostic fan-out useful, but still give unrelated work a
          // macrotask turn before every overlapping leg.
          await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
          perBackend[index] = await runLeg();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(width, 1) }, worker));
    if (backends.length > 0) {
      // After an aggregate expiry, start the next sweep immediately after the
      // last adapter that received time. This guarantees that healthy trailing
      // lanes are eventually read even when an earlier lane wedges repeatedly.
      // A complete sweep restores the ordinary registration-order start.
      this.discoveryResumeIndex = sweepExpiry?.aborted === true
        ? ((lastStartedIndex ?? startIndex) + 1) % backends.length
        : 0;
    }
    return perBackend.flat();
  }

  private async discoverFromBackend(
    backend: AgentBackend,
    options?: SessionDiscoveryOptions,
    sweepExpiry?: AbortSignal,
    sweepBudgetMs?: number,
  ): Promise<SessionInfo[]> {
    const legBudgetMs = effectiveDiscoveryBudgetMs(backend.discoveryBudgetMs);
    if (legBudgetMs === undefined && sweepExpiry === undefined) {
      const unbudgetedStartedAt = Date.now();
      const unbudgetedLeg = enterLeg();
      const result = await discoveryLeg(backend, {
        ...options,
        onPartialRows: (rows) =>
          options?.onPartialRows?.(AgentRegistry.acceptPartialRows(backend, rows)),
      }).finally(() => leaveLeg(unbudgetedLeg));
      // An unbudgeted leg cannot be abandoned, but it can still throw, and a
      // thrown local adapter empties its lane exactly as a thrown external one
      // does. Same cache, same carry, same report.
      const unbudgetedFailed = result.failure !== undefined && result.cancelled !== true;
      const rows = unbudgetedFailed
        ? this.carryLastGood(backend.id, result.rows, options)
        : result.rows;
      const unbudgetedElapsedMs = Date.now() - unbudgetedStartedAt;
      if (result.failure === undefined) {
        const rememberedAt = Date.now();
        this.pruneLastGood(rememberedAt);
        const rememberKey = AgentRegistry.lastGoodKey(backend.id, options);
        this.lastGoodRows.set(rememberKey, {
          backendId: backend.id, at: rememberedAt, rows: [...rows], cutoff: options?.updatedAfter,
        });
        this.lastGoodCarries.delete(rememberKey);
      } else if (unbudgetedFailed) {
        this.reportFailedLeg(
          backend.id, result.failure, unbudgetedElapsedMs, rows.length - result.rows.length, options,
        );
      }
      // The UNBUDGETED path needs this as much as the budgeted one — more, in
      // fact. The adapters this fix is for are exactly the ones with no budget:
      // `omp` settles in ~150ms and is unbudgeted, and it was its rows that sat
      // behind a 22s sweep. Publishing only from the budgeted branch would have
      // left every case that motivated this unfixed.
      //
      // Successful legs only, for the reason given at the budgeted call site: a
      // carried or cancelled leg can publish another window's rows, or none.
      if (result.failure === undefined) options?.onLegRows?.(backend.id, rows);
      options?.onWork?.({
        kind: 'leg-elapsed',
        backendId: backend.id,
        elapsedMs: unbudgetedElapsedMs,
        concurrentPeak: unbudgetedLeg.peak,
        rows: rows.length,
        abandoned: false,
        failed: unbudgetedFailed,
      });
      return rows;
    }
    // `AbortSignal.timeout` rather than a tracked timer: it does not hold the
    // event loop open, so a budget that outlives the leg cannot keep a broker
    // that is otherwise finished from exiting.
    const startedAt = Date.now();
    const legExpiry = legBudgetMs === undefined ? undefined : AbortSignal.timeout(legBudgetMs);
    const signals = [legExpiry, sweepExpiry, options?.signal]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    // The race leaves this listener registered after the winner is known, so the
    // expiry still fires on a leg that ALREADY answered. `resolve` on a settled
    // promise is a no-op, which is why that was harmless while nothing else
    // happened here; a report is not a no-op, so the settled leg is tracked
    // rather than inferred. The flag is set in a microtask off the leg, and the
    // expiry arrives on a macrotask, so a leg that won the race has always
    // recorded itself before this can run.
    let legSettled = false;
    // A holder rather than a bare `let`: the only assignment is inside the abort
    // closure, which control-flow analysis does not see, so a plain variable
    // narrows to its `null` initializer and every field read below is an error.
    const abandonment: {
      notice: {
        budgetMs: number;
        budgetKind: 'leg' | 'sweep';
        elapsedMs: number;
        salvagedRows: number;
      } | null;
    } = { notice: null };
    // Rows the leg finished before the budget fired. Validated on arrival by
    // the same two checks the completed path applies -- decode AND the tool
    // partition -- so abandonment cannot become a way for an unchecked row to
    // reach the roster. The partition check has to be repeated here rather than
    // left to the completed path, because these rows are salvaged precisely
    // when that path never runs, and they still reach the sweep's return value.
    const salvaged: SessionInfo[] = [];
    const collect = (rows: readonly SessionInfo[]): void => {
      // Accepted rows are what BOTH the salvage set and the caller's callback
      // see. Forwarding the original batch handed a caller the malformed and
      // cross-tool rows this function had just withheld from the roster, so an
      // observer could act on a row the sweep itself refused -- and the docs
      // promise the registry validates every partial row.
      const accepted = AgentRegistry.acceptPartialRows(backend, rows);
      // Appended one at a time rather than spread: a single batch larger than
      // the engine's argument limit would make `push(...accepted)` throw.
      for (const row of accepted) salvaged.push(row);
      options?.onPartialRows?.(accepted);
    };
    const legRecord = enterLeg();
    // Do not start another adapter after the whole sweep has expired. Calling
    // an adapter and relying on an already-aborted signal still lets synchronous
    // setup run before the adapter checks it, defeating the aggregate ceiling.
    // A never-settling placeholder lets the normal abandonment/carry path win
    // below without duplicating its state transitions.
    const leg = signal.aborted
      ? new Promise<{
        rows: SessionInfo[];
        failure?: string;
        cancelled?: boolean;
        fromLeg: true;
      }>(() => {})
      : discoveryLeg(
        backend,
        { ...options, signal, onPartialRows: collect },
        () => options?.signal?.aborted === true,
      ).then((result) => {
        legSettled = true;
        return { ...result, fromLeg: true as const };
      });
    const abandoned = new Promise<{ rows: SessionInfo[]; failure?: string; cancelled?: boolean; fromLeg?: false }>((resolve) => {
      const abandon = (): void => {
        // Only the registry's OWN expiry is a defect. A caller that cancelled
        // the sweep aborted this leg deliberately, and reporting that as a
        // budget overrun would train the reader to ignore the message.
        const budgetKind = legExpiry?.aborted === true
          ? 'leg'
          : sweepExpiry?.aborted === true ? 'sweep' : undefined;
        if (!legSettled && budgetKind !== undefined) {
          const budgetMs = budgetKind === 'leg' ? legBudgetMs! : sweepBudgetMs!;
          const elapsedMs = Date.now() - startedAt;
          options?.onWork?.({
            kind: 'leg-abandoned',
            backendId: backend.id,
            budgetMs,
            budgetKind,
            elapsedMs,
            salvagedRows: salvaged.length,
          });
          // The message is emitted AFTER the carry, not here: what the roster
          // actually loses is not known until the last successful sweep has been
          // consulted, and a line that says "EVERY session is absent" while the
          // rows are in fact carried would be worse than no line at all.
          abandonment.notice = { budgetMs, budgetKind, elapsedMs, salvagedRows: salvaged.length };
        }
        // Whatever the leg managed to finish, rather than discarding it. The
        // leg lost the race, so its own return value never arrives.
        resolve({ rows: salvaged });
      };
      if (signal.aborted) abandon();
      else signal.addEventListener('abort', abandon, { once: true });
    });
    // Leave on the RACE, not on the leg's own promise. An abandoned leg is
    // wedged by construction and its promise may never settle, so releasing in
    // its `finally` leaked the record forever and every later leg in the process
    // inherited the count: measured as `concurrentPeak: 11` on a registry with
    // ONE backend. What this is accounting for is legs the sweep is still
    // waiting on, and the sweep stops waiting here.
    // try/finally, not a bare call after the await. `discoveryLeg` swallows
    // everything today (`catch { return [] }`), so nothing here rejects and this
    // is hardening rather than a fix for an observed leak — but the release must
    // not depend on that, because the failure mode if it ever does reject is the
    // silent permanent leak described just above, and it would show up only as
    // wrong numbers in a diagnostic nobody re-derives.
    let raced: { rows: SessionInfo[]; failure?: string; cancelled?: boolean; fromLeg?: boolean };
    try {
      raced = await Promise.race([leg, abandoned]);
    } finally {
      leaveLeg(legRecord);
    }
    // Which promise WON, recorded rather than inferred. `legSettled` answers a
    // different question — "has the leg finished by now" — and a leg that
    // settles a moment after the budget fires makes it true while the race was
    // already decided by the salvage. Testing it therefore let a partial or
    // empty salvage be written as this backend's last SUCCESSFUL sweep, which
    // is the precise failure the comment below argues it prevents.
    const fromLeg = raced.fromLeg === true;
    const legWasAbandoned = !fromLeg
      && (legExpiry?.aborted === true || sweepExpiry?.aborted === true);
    const legFailure = raced.failure;
    // Keyed on the leg having SETTLED, not on the absence of a budget overrun.
    // A caller-cancelled leg (`options.signal`, not `expiry`) also resolves the
    // race with its salvage while `expiry.aborted` stays false, so testing the
    // overrun would record a partial — or empty — salvage as this backend's last
    // SUCCESSFUL sweep. The next genuine overrun would then carry that emptiness
    // forward and delete every row, which is precisely what carrying exists to
    // prevent. Copied, because on the abandoned path the resolved array IS the
    // live `salvaged` one a zombie leg can still append to.
    //
    // A leg that THREW is settled and did not overrun, so both of those tests
    // used to pass and its `[]` was recorded as this backend's last successful
    // sweep — the one case where the cache actively made the next failure
    // worse. A failure is not a sweep; it takes the carry and leaves the
    // remembered rows alone.
    if (fromLeg && legFailure === undefined) {
      const rememberedAt = Date.now();
      this.pruneLastGood(rememberedAt);
      const rememberKey = AgentRegistry.lastGoodKey(backend.id, options);
      this.lastGoodRows.set(rememberKey, {
        backendId: backend.id, at: rememberedAt, rows: [...raced.rows], cutoff: options?.updatedAfter,
      });
      this.lastGoodCarries.delete(rememberKey);
    }
    // Carried for an ABANDONED or a FAILED leg, and NOT for a caller-cancelled
    // one. A caller that aborted its own sweep is not owed this backend's last
    // known rows — handing them back would report a sweep that did not happen.
    // What the caller-cancel case must not do is overwrite the memory, and that
    // is decided by `fromLeg` above, not here.
    const legCancelled = raced.cancelled === true;
    const rows = legWasAbandoned || (legFailure !== undefined && !legCancelled)
      ? this.carryLastGood(backend.id, raced.rows, options)
      : raced.rows;
    if (legFailure !== undefined && !legCancelled) {
      this.reportFailedLeg(
        backend.id, legFailure, Date.now() - startedAt, rows.length - raced.rows.length, options,
      );
    }
    const notice = abandonment.notice;
    if (notice !== null) {
      const carried = rows.length - notice.salvagedRows;
      const prefix = notice.budgetKind === 'sweep'
        ? `[adapter-api] ${backend.id} discovery was still running when the whole roster sweep `
          + `reached its ${notice.budgetMs}ms budget after ${notice.elapsedMs}ms; leg abandoned — `
        : `[adapter-api] ${backend.id} discovery exceeded its ${notice.budgetMs}ms budget after `
          + `${notice.elapsedMs}ms; leg abandoned — `;
      console.warn(
        prefix
          + (rows.length === 0
            ? `EVERY ${backend.id} session is absent from this roster sweep`
            : `${notice.salvagedRows} mapped this sweep`
              + (carried > 0 ? ` and ${carried} carried from the last successful one` : '')
              + `, so the roster keeps ${rows.length} ${backend.id} session(s)`),
      );
    }
    // SUCCESSFUL legs only. A consumer merges these into a snapshot it is
    // already serving, so the bar is not "what will this sweep return" but "is
    // this strictly better than what is there now", and only a completed read
    // clears it:
    //
    //  - ABANDONED or FAILED publishes the CARRY, which is a REPLACEMENT for
    //    the whole answer and not an improvement on rows already being served.
    //    A carry can only ever restate what a previous sweep of this same
    //    window already knew, so merging it in would at best change nothing and
    //    at worst reinstate rows a later sweep deleted.
    //  - CALLER-CANCELLED withholds the carry deliberately, so it publishes an
    //    empty set, which would wipe the backend from the served snapshot. Not
    //    reachable today — the broker's only `discoverAll` passes no signal —
    //    but it costs nothing to be right about now.
    //
    // Skipping simply leaves the previous rows for this backend in place, which
    // is what an abandoned leg is already trying to express.
    if (fromLeg && legFailure === undefined) options?.onLegRows?.(backend.id, rows);
    // After the race, so the elapsed time is the one the sweep actually waited,
    // and `abandoned` is known rather than guessed.
    options?.onWork?.({
      kind: 'leg-elapsed',
      backendId: backend.id,
      elapsedMs: Date.now() - startedAt,
      concurrentPeak: legRecord.peak,
      rows: rows.length,
      abandoned: legWasAbandoned,
      failed: legFailure !== undefined,
    });
    return rows;
  }

  private reportFailedLeg(
    backendId: string,
    reason: string,
    elapsedMs: number,
    carriedRows: number,
    options?: SessionDiscoveryOptions,
  ): void {
    options?.onWork?.({ kind: 'leg-failed', backendId, elapsedMs, reason, carriedRows });
    console.warn(
      `[adapter-api] ${backendId} discovery threw after ${elapsedMs}ms: ${reason} — `
        + (carriedRows === 0
          ? `EVERY ${backendId} session is absent from this roster sweep`
          : `${carriedRows} session(s) carried from the last successful sweep`),
    );
  }

  /**
   * The best remembered answer for this backend that still covers `wanted`:
   * this scope's own if it has one, otherwise the WIDEST from another scope.
   *
   * Widest wins because a wider memory is a superset once filtered, so it can
   * only ever tell us more than a narrower one.
   */
  private bestLastGood(
    backendId: string,
    options: SessionDiscoveryOptions | undefined,
    wanted: number | undefined,
    now: number,
  ): { rows: SessionInfo[]; cutoff: number | undefined; at: number } | undefined {
    const own = this.lastGoodRows.get(AgentRegistry.lastGoodKey(backendId, options));
    if (own && lastGoodCoversCutoff(own.cutoff, wanted)) return own;
    let best: { rows: SessionInfo[]; cutoff: number | undefined; at: number } | undefined;
    for (const entry of this.lastGoodRows.values()) {
      if (entry.backendId !== backendId) continue;
      if (now - entry.at > ABANDONED_LEG_LAST_GOOD_MS) continue;
      if (!lastGoodCoversCutoff(entry.cutoff, wanted)) continue;
      // `undefined` is the widest cutoff there is, so it wins outright.
      if (entry.cutoff === undefined) return entry;
      if (best === undefined || (best.cutoff !== undefined && entry.cutoff < best.cutoff)) {
        best = entry;
      }
    }
    return best;
  }

  /**
   * Cover an abandoned leg with what this backend last successfully returned.
   *
   * Salvaged rows WIN over remembered ones of the same id: they came from this
   * sweep, so where both exist the fresher is the honest answer.
   *
   * The window is re-applied, using the SAME rule the budgeted adapters apply to
   * their own rows — `updatedAt ?? createdAt`, excluded only when that stamp
   * exists and falls below the cutoff (kilocode `implementation.ts:1150-1152`).
   * An earlier version of this consulted `updatedAt` alone and kept anything
   * without one, on the reasoning that a missing timestamp is not evidence of
   * being outside the window. That reasoning is wrong here: a kilo live row
   * carries `time.created` and no `time.updated`, so `updatedAt` alone keeps a
   * six-month-old session and publishes it into a "Last 24 hours" roster, where
   * it flaps as legs alternate between answering and being abandoned. The carry
   * must not admit a row the adapter itself would have filtered out.
   */
  private carryLastGood(
    backendId: string,
    salvaged: readonly SessionInfo[],
    options?: SessionDiscoveryOptions,
  ): SessionInfo[] {
    const now = Date.now();
    this.pruneLastGood(now);
    const wanted = options?.updatedAfter;
    // This scope's own last good answer first, then the WIDEST answer any other
    // scope of this backend holds that still covers the question. Scoping alone
    // was not enough: the 7-day scope's very first sweep after startup has no
    // memory of its own, and the all-time rows -- a superset -- answer it once
    // filtered. Widening is what can never work, because no filter recovers
    // rows a narrower sweep never read.
    const remembered = this.bestLastGood(backendId, options, wanted, now);
    if (!remembered) return [...salvaged];
    // Counted per SCOPE, not per memory. A wedged narrow scope borrowing the
    // wide scope's rows must not spend the budget that decides when the wide
    // scope stops being covered -- they fail independently and one cannot
    // silence the other. Counted BEFORE the decision, so the fifth is the last.
    // The cap counts consecutive sweeps spent serving rows NOBODY HAS
    // RE-CONFIRMED. Rows borrowed from a scope that has succeeded since this run
    // began are not that: the backend answered, this sweep, for another window.
    // Without this reset a scope whose own leg keeps wedging went empty on the
    // sixth sweep and stayed empty until it next succeeded -- which for a wedged
    // leg is never -- while fresh rows for the very same backend sat one line
    // above it. A genuinely wedged BACKEND refreshes nothing, so its run still
    // accumulates and still stops at the cap, on sweeps rather than on a clock.
    const key = AgentRegistry.lastGoodKey(backendId, options);
    const run = this.lastGoodCarries.get(key);
    const reconfirmed = run !== undefined && remembered.at > run.startedAt;
    const carried = run === undefined || reconfirmed ? 1 : run.count + 1;
    this.lastGoodCarries.set(key, {
      count: carried,
      startedAt: run === undefined || reconfirmed ? now : run.startedAt,
      touchedAt: now,
    });
    if (carried > ABANDONED_LEG_CARRY_SWEEPS) return [...salvaged];
    const byId = new Map(remembered.rows.map((row) => [row.id, row]));
    for (const row of salvaged) byId.set(row.id, row);
    const cutoff = options?.updatedAfter;
    if (cutoff === undefined) return [...byId.values()];
    return [...byId.values()].filter((row) => {
      const stamp = row.updatedAt ?? row.createdAt;
      return stamp === undefined || stamp >= cutoff;
    });
  }
}

/**
 * One backend's whole discovery leg, isolated: it resolves, and never throws.
 *
 * It reports WHY it has no rows, which is the whole point of the shape. An
 * adapter with nothing to show and an adapter that could not look both used to
 * resolve a bare `[]`, and the caller then recorded that empty array as this
 * backend's last SUCCESSFUL sweep — so a single spawn failure inside a
 * discovery emptied the lane, pushed every one of its sessions to every client
 * as a deletion, and poisoned the very cache that exists to carry a lane
 * through exactly that. Silently, with no line anywhere.
 */
async function discoveryLeg(
  backend: AgentBackend,
  options?: SessionDiscoveryOptions,
  /** Whether the CALLER's own signal aborted. Passed separately because
   *  `options.signal` on the budgeted path is `AbortSignal.any([expiry, …])`,
   *  so reading it cannot tell the caller's cancellation from the registry's
   *  own budget — and reporting a budget overrun as a cancellation suppresses
   *  the one message that names it. */
  callerAborted?: () => boolean,
): Promise<{ rows: SessionInfo[]; failure?: string; cancelled?: boolean }> {
  try {
    const available = await backend.isAvailable(
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (!available) return { rows: [] };
    const rows = await backend.discoverSessions(options);
    return {
      rows: rows.flatMap((row) => {
        const decoded = decodeSessionInfo(row);
        if (!decoded) {
          console.warn(`[adapter-api] ${backend.id} returned a malformed SessionInfo discovery row; row withheld`);
          return [];
        }
        // `tool` must name the backend that produced the row. `decodeSessionInfo`
        // only checks it is a non-empty string, and every consumer that groups
        // the roster — publication authority, owner retirement, the revision
        // store, and the leg-at-a-time merge in `discoverAllCached` — partitions
        // on it. A row filed under another backend's tool makes that merge drop
        // rows it should keep and keep rows the sweep deleted, so the invariant
        // is checked here rather than assumed by four separate readers.
        if (decoded.tool !== backend.id) {
          console.warn(
            `[adapter-api] ${backend.id} returned a discovery row filed under tool `
              + `'${decoded.tool}'; row withheld`,
          );
          return [];
        }
        return [decoded];
      }),
    };
  } catch (error) {
    // A caller-cancelled sweep is not a defect: `options.signal` aborting is the
    // caller's own decision. It is reported SEPARATELY from a failure, because
    // the two authorize different things — a failure takes the carry and warns,
    // a cancellation does neither — and collapsing them into one string made a
    // cancellation warn as "discovery threw" and spend one of the five
    // consecutive carries a genuine outage is allowed. What both must avoid is
    // being recorded as a good sweep, and that is decided elsewhere.
    const cancelled = callerAborted?.() ?? (options?.signal?.aborted === true);
    return {
      rows: [],
      failure: cancelled
        ? 'discovery was cancelled by its caller'
        : error instanceof Error ? error.message : String(error),
      ...(cancelled ? { cancelled: true } : {}),
    };
  }
}

/**
 * Count added/removed lines in a unified diff — the tool-agnostic half of the tool-result
 * rich-detail mapping every adapter needs (the canonical `tool-result.additions/deletions` chips).
 *
 * Range-safe: a `+++`/`---` line is a file header only *between* hunks. Once a `@@` opens a hunk
 * (with OR without line ranges, e.g. Codex's `@@ class Foo`), a leading `+`/`-` is body content —
 * so a real edit that adds `+++counter` or removes `---flag` is counted, not silently dropped. The
 * whole diff is split per file first so this stays consistent with {@link splitUnifiedDiffFiles} and
 * the client's diff parser. (see docs/protocol/adapter-support.md — Pi/OpenCode rendered diffstat parity)
 */
export function summarizeDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of splitUnifiedDiffFiles(diff)) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
}

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip a git `a/`/`b/` path prefix; leave `/dev/null` and absolute paths intact. */
function stripDiffPrefix(p: string): string {
  const t = p.trim();
  if (t === '/dev/null') return t;
  return t.replace(/^[ab]\//, '');
}

/** A CREDIBLE file-header path for the mid-hunk boundary heuristic: a git-prefixed
 *  `a/…`/`b/…` path or `/dev/null`. Body content like `--- old value` (a removed
 *  `-- old value`) has neither, so it is not mistaken for a file header (R4 finding 3). */
function credibleHeaderPath(afterMarker: string, prefix: 'a/' | 'b/'): boolean {
  const p = afterMarker.trim();
  return p === '/dev/null' || p.startsWith(prefix);
}

/**
 * Split a (possibly multi-file) unified diff into per-file {@link FileChange} entries with
 * range-safe additions/deletions, resolved operation, and rename source. The single source of
 * truth for the canonical `fileChanges[]`: Pi/OpenCode/Codex/Claude all funnel their event-time
 * diff string through this so multi-file boundaries, create/delete/rename, and `++`/`--` body
 * content are classified identically. Never reconstructs from Git — it only reads the supplied diff.
 *
 * A file boundary is a `diff --git` line, or a `--- ` header seen between hunks once the current
 * file already has a body. Operation is derived from `/dev/null` sides, `new file`/`deleted file`,
 * and `rename from/to` (or a differing old/new path). Range-less hunks stay "inside a hunk" until
 * the next boundary so trailing `+`/`-` lines are still counted.
 */
export function splitUnifiedDiffFiles(diff: string): FileChange[] {
  if (!diff) return [];
  const files: Array<FileChange & { _lines: string[] }> = [];
  let cur: (FileChange & { _lines: string[] }) | null = null;
  let hasBody = false; // current file has seen hunk/body content (so a new `---` starts a new file)
  let insideHunk = false;
  let rangeless = false;
  let oldRem = 0;
  let newRem = 0;

  const flush = () => {
    if (!cur) return;
    cur.diff = cur._lines.join('\n');
    files.push(cur);
  };
  const start = (): FileChange & { _lines: string[] } => {
    flush();
    cur = { path: '', operation: 'edit', additions: 0, deletions: 0, _lines: [] };
    hasBody = false;
    insideHunk = false;
    rangeless = false;
    oldRem = 0;
    newRem = 0;
    return cur;
  };

  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const git = GIT_HEADER.exec(raw);
    if (git) {
      const c = start();
      const oldPath = stripDiffPrefix(git[1]!);
      const newPath = stripDiffPrefix(git[2]!);
      c.path = newPath;
      if (oldPath !== newPath) {
        c.previousPath = oldPath;
        c.operation = 'rename';
      }
      c._lines.push(raw);
      continue;
    }
    // A file-header block is the triple `--- <a/…|/dev/null>` / `+++ <b/…|/dev/null>` / `@@ …`.
    // Recognize it as a boundary even inside a range-less hunk (where `insideHunk` never clears on
    // its own), so a plain (no `diff --git`) multi-file diff splits at file 2's header. Requiring
    // BOTH the trailing `@@` AND credible a/·b/ (or /dev/null) paths keeps a range-less BODY pair —
    // removed `-- old value` / added `++ new value`, even one followed by a second hunk — from being
    // mis-split into a fake file (T1b R3/R4 finding 3). NOT inside a *ranged* hunk: there the counters
    // bound `--- x`/`+++ y`, and a lone `--- ` (removing a `--`-prefixed line) stays body.
    const pairBoundary =
      raw.startsWith('--- ') &&
      i + 2 < lines.length &&
      lines[i + 1]!.startsWith('+++ ') &&
      lines[i + 2]!.startsWith('@@') &&
      credibleHeaderPath(raw.slice(4), 'a/') &&
      credibleHeaderPath(lines[i + 1]!.slice(4), 'b/') &&
      (!insideHunk || rangeless);
    const header = !insideHunk || pairBoundary;
    if (header && raw.startsWith('--- ')) {
      if (!cur || hasBody) start();
      const p = stripDiffPrefix(raw.slice(4));
      if (p === '/dev/null') cur!.operation = 'create';
      else if (!cur!.previousPath && !cur!.path) cur!.path = p;
      cur!._lines.push(raw);
      continue;
    }
    if (header && raw.startsWith('+++ ')) {
      if (!cur) start();
      const p = stripDiffPrefix(raw.slice(4));
      if (p === '/dev/null') cur!.operation = 'delete';
      else cur!.path = p;
      cur!._lines.push(raw);
      continue;
    }
    if (header && (raw.startsWith('new file') || raw.startsWith('added file'))) {
      if (!cur) start();
      if (cur!.operation === 'edit') cur!.operation = 'create';
      cur!._lines.push(raw);
      continue;
    }
    if (header && raw.startsWith('deleted file')) {
      if (!cur) start();
      cur!.operation = 'delete';
      cur!._lines.push(raw);
      continue;
    }
    if (header && (raw.startsWith('rename from ') || raw.startsWith('copy from '))) {
      if (!cur) start();
      cur!.previousPath = stripDiffPrefix(raw.replace(/^(?:rename|copy) from /, ''));
      cur!.operation = 'rename';
      cur!._lines.push(raw);
      continue;
    }
    if (header && (raw.startsWith('rename to ') || raw.startsWith('copy to '))) {
      if (!cur) start();
      cur!.path = stripDiffPrefix(raw.replace(/^(?:rename|copy) to /, ''));
      cur!.operation = 'rename';
      cur!._lines.push(raw);
      continue;
    }
    if (header && (raw.startsWith('index ') || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('similarity ') || raw.startsWith('dissimilarity '))) {
      if (!cur) start();
      cur!._lines.push(raw);
      continue;
    }
    const trimmed = raw.trimStart();
    if ((trimmed.startsWith('Binary files ') && trimmed.endsWith(' differ')) || trimmed.startsWith('GIT binary patch')) {
      if (!cur) start();
      cur!.binary = true;
      cur!._lines.push(raw);
      continue;
    }
    if (raw.startsWith('@@')) {
      if (!cur) start();
      const m = HUNK_HEADER.exec(raw);
      if (m) {
        oldRem = m[2] !== undefined ? Number(m[2]) : 1;
        newRem = m[4] !== undefined ? Number(m[4]) : 1;
        rangeless = false;
      } else {
        rangeless = true; // Codex `@@ <context>` — no ranges; stay in-hunk until the next boundary
      }
      insideHunk = true;
      hasBody = true;
      cur!._lines.push(raw);
      continue;
    }
    // Body / context. Every file/hunk header above already `continue`d, so a leading `+`/`-` that
    // reaches here is body content — including `++foo`/`--bar` added/removed lines (finding 3),
    // and a headerless patch's `+line…` (Codex create synth) with no `@@` at all. Context lines
    // only advance the hunk's remaining-line bookkeeping.
    if (!cur) start();
    cur!._lines.push(raw);
    if (raw.startsWith('+')) {
      cur!.additions = (cur!.additions ?? 0) + 1;
      hasBody = true;
      if (!rangeless && newRem > 0) newRem -= 1;
    } else if (raw.startsWith('-')) {
      cur!.deletions = (cur!.deletions ?? 0) + 1;
      hasBody = true;
      if (!rangeless && oldRem > 0) oldRem -= 1;
    } else if (insideHunk) {
      hasBody = true;
      if (!rangeless && oldRem > 0) oldRem -= 1;
      if (!rangeless && newRem > 0) newRem -= 1;
    }
    if (!rangeless && insideHunk && oldRem <= 0 && newRem <= 0) insideHunk = false;
  }
  flush();
  return files.map(({ _lines, ...rest }) => rest);
}

/** Derive the collapsed one-line operation for a set of file changes (Created/Edited/…). */
export function fileChangesOperation(changes: FileChange[]): FileOperation | 'mixed' | undefined {
  if (changes.length === 0) return undefined;
  const first = changes[0]!.operation;
  return changes.every((c) => c.operation === first) ? first : 'mixed';
}

/**
 * Build a git `a/`/`b/` diff-header path without doubling the slash for an absolute path
 * (`b//tmp/x` → `b/tmp/x`). Shared by adapters that synthesize git-style diffs so an absolute
 * edit path never produces a malformed header.
 */
export function gitDiffPath(prefix: 'a' | 'b', p: string): string {
  return p.startsWith('/') ? `${prefix}${p}` : `${prefix}/${p}`;
}

/** Small helper for adapters: strict JSONL line splitting (LF only, strip trailing CR). */
export function createJsonlSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  };
}
