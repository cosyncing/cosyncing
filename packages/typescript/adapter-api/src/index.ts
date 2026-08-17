/** @cosyncing/adapter-api — provider adapter SPI and bounded setup diagnosis. */
export * from '@cosyncing/protocol';
export * from './diagnosis.ts';
export * from './integration.ts';
export * from './tool-semantics.ts';
import { type AgentCapabilities, type AttachMode, type DriveAttachReason, type FileChange, type FileOperation, type ModelOption, type PromptInput, type SessionConnection, type SessionInfo, type Unsubscribe } from '@cosyncing/protocol';
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
  /** Create a brand-new session and return it (for tools that support it). */
  createSession?(opts?: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
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
  /** Optional deterministic evidence hook for bounded-discovery fixtures. */
  onWork?: (work: SessionDiscoveryWork) => void;
  /** See {@link AvailabilityOptions.signal}; the same signal spans the whole leg. */
  signal?: AbortSignal;
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
 * Five seconds is above any healthy leg by orders of magnitude: these hosts are
 * on loopback, where a JSON read is milliseconds, and it is at or above each
 * adapter's own single-request ceiling, so a request that would have succeeded
 * is not cut short. It is far below the wait a user would read as "cosyncing is
 * broken", which is the failure this exists to prevent.
 */
export const EXTERNAL_HOST_DISCOVERY_BUDGET_MS = 5_000;

/** One native read/query performed by session discovery. */
export type SessionDiscoveryWork =
  | { kind: 'decode-file'; source: string }
  | { kind: 'sqlite-query'; source: string; bounded: boolean; cutoff?: number };

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

  register(backend: AgentBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  list(): AgentBackend[] {
    return [...this.backends.values()];
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
   */
  async discoverAll(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const perBackend = await Promise.all(this.list().map((b) => this.discoverFromBackend(b, options)));
    return perBackend.flat();
  }

  private async discoverFromBackend(
    backend: AgentBackend,
    options?: SessionDiscoveryOptions,
  ): Promise<SessionInfo[]> {
    const budgetMs = effectiveDiscoveryBudgetMs(backend.discoveryBudgetMs);
    if (budgetMs === undefined) return await discoveryLeg(backend, options);
    // `AbortSignal.timeout` rather than a tracked timer: it does not hold the
    // event loop open, so a budget that outlives the leg cannot keep a broker
    // that is otherwise finished from exiting.
    const expiry = AbortSignal.timeout(budgetMs);
    const signal = options?.signal ? AbortSignal.any([expiry, options.signal]) : expiry;
    const abandoned = new Promise<SessionInfo[]>((resolve) => {
      if (signal.aborted) resolve([]);
      else signal.addEventListener('abort', () => resolve([]), { once: true });
    });
    return await Promise.race([discoveryLeg(backend, { ...options, signal }), abandoned]);
  }
}

/** One backend's whole discovery leg, isolated: it resolves, and never throws. */
async function discoveryLeg(
  backend: AgentBackend,
  options?: SessionDiscoveryOptions,
): Promise<SessionInfo[]> {
  try {
    const available = await backend.isAvailable(
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (!available) return [];
    return await backend.discoverSessions(options);
  } catch {
    return [];
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
