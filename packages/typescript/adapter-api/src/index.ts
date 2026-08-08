/** @cosyncing/adapter-api — provider adapter SPI and bounded setup diagnosis. */
export * from '@cosyncing/protocol';
export * from './tool-semantics.ts';
import { PRODUCT_IDENTITY, type AgentCapabilities, type AttachMode, type DriveAttachReason, type FileChange, type FileOperation, type ModelOption, type PromptInput, type SessionConnection, type SessionInfo, type Unsubscribe } from '@cosyncing/protocol';
// ── Setup and doctor diagnosis ──────────────────────────────────────────────

export type SetupCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface SetupRemediation {
  kind: 'command' | 'manual' | 'retry';
  message: string;
  /** Customer-facing commands only. Never expose contributor-only environment variables here. */
  command?: string;
}

/** One stable, redacted setup/doctor result. Detail codes are API surface; prose may improve additively. */
export interface SetupCheck {
  id: string;
  status: SetupCheckStatus;
  detailCode: string;
  summary: string;
  evidence?: Record<string, string | number | boolean>;
  remediation?: SetupRemediation;
}

export interface AgentMinimumVersion {
  version: string;
  requiredFeature: string;
  evidenceUrl: string;
  evidenceNote: string;
}

export interface AgentSetupDiagnosis {
  agent: string;
  displayName: string;
  minimumVersion: AgentMinimumVersion;
  checks: SetupCheck[];
}

/** Adapter-to-broker notification for a managed runtime's short-lived launch helper. */
export interface ManagedRuntimeStartFailure {
  detailCode: string;
  /** Native stdout/stderr. The broker sink must bound and redact this before persistence. */
  capturedOutput?: string;
}

export type ManagedRuntimeStartReporter = (failure?: ManagedRuntimeStartFailure) => void;

export interface SetupPathInspection {
  status: 'missing' | 'file' | 'directory' | 'socket' | 'other' | 'unreadable';
  readable: boolean;
  displayPath: string;
}

export interface SetupCommandProbe {
  status: 'ok' | 'nonzero' | 'timeout' | 'unavailable';
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface SetupHttpProbe {
  status: 'ok' | 'http-error' | 'unreachable' | 'invalid-response';
  statusCode?: number;
  json?: unknown;
}

/**
 * Capability-limited context for adapter diagnosis. Implementations are read-only and bounded; adapters must
 * never call normal discovery from this path because discovery may launch a managed runtime or install assets.
 */
export interface SetupDiagnosisContext {
  readonly effects: 'forbidden';
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  resolveExecutable(command: string): string | undefined;
  inspectPath(path: string): SetupPathInspection;
  readText(path: string, maxBytes?: number): { ok: true; text: string } | { ok: false; reason: 'missing' | 'unreadable' | 'too-large' };
  readPackageVersion(executable: string, packageNames: readonly string[]): string | undefined;
  runReadOnly(executable: string, args: readonly string[], timeoutMs?: number): Promise<SetupCommandProbe>;
  fetchJson(url: string, headers?: Readonly<Record<string, string>>, timeoutMs?: number): Promise<SetupHttpProbe>;
  probeTcp(host: string, port: number, timeoutMs?: number): Promise<'open' | 'closed' | 'unknown'>;
  displayPath(path: string): string;
}

/** Extract a SemVer-shaped version from tool output while ignoring product prefixes and build suffixes. */
export function semanticVersionFromText(value: string): string | undefined {
  const match = value.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`;
}

/** Compare normalized SemVer values. A prerelease is lower than the corresponding stable version. */
export function compareSemanticVersions(left: string, right: string): number | undefined {
  const parse = (value: string): { core: number[]; prerelease?: string[] } | undefined => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      ...(match[4] ? { prerelease: match[4].split('.') } : {}),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x) ? Number(x) : undefined;
    const yNumber = /^\d+$/.test(y) ? Number(y) : undefined;
    if (xNumber !== undefined && yNumber !== undefined) return xNumber < yNumber ? -1 : 1;
    if (xNumber !== undefined) return -1;
    if (yNumber !== undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface BinaryVersionDiagnosis {
  executable?: string;
  installedVersion?: string;
  checks: SetupCheck[];
}

/** Shared binary/version branch logic; adapters still own command names, version floors, and feature claims. */
export async function diagnoseBinaryVersion(options: {
  context: SetupDiagnosisContext;
  checkPrefix: string;
  displayName: string;
  command: string;
  versionArgs?: readonly string[];
  packageNames?: readonly string[];
  /** Parse version from a package-managed/standalone executable path without invoking the CLI. */
  versionFromExecutable?: (executable: string) => string | undefined;
  minimum: AgentMinimumVersion;
  installMessage: string;
  upgradeCommand: string;
}): Promise<BinaryVersionDiagnosis> {
  const executable = options.context.resolveExecutable(options.command);
  if (!executable) {
    return {
      checks: [
        {
          id: `${options.checkPrefix}.binary`,
          status: 'warn',
          detailCode: 'binary-missing',
          summary: `${options.displayName} is not installed or is not on PATH.`,
          remediation: { kind: 'manual', message: options.installMessage },
        },
        {
          id: `${options.checkPrefix}.version`,
          status: 'skip',
          detailCode: 'version-not-checked',
          summary: `Version was not checked because the ${options.displayName} binary is missing.`,
        },
      ],
    };
  }

  const checks: SetupCheck[] = [{
    id: `${options.checkPrefix}.binary`,
    status: 'pass',
    detailCode: 'binary-found',
    summary: `${options.displayName} executable found.`,
    evidence: { executable: options.context.displayPath(executable) },
  }];
  let installedVersion = options.packageNames?.length
    ? options.context.readPackageVersion(executable, options.packageNames)
    : undefined;
  installedVersion ??= options.versionFromExecutable?.(executable);
  let probe: SetupCommandProbe | undefined;
  if (!installedVersion && options.versionArgs) {
    probe = await options.context.runReadOnly(executable, options.versionArgs);
    if (probe.status === 'ok' || probe.status === 'nonzero') {
      installedVersion = semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`);
    }
  }
  if (!installedVersion) {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'fail',
      detailCode: probe?.status === 'timeout' ? 'version-probe-timeout' : 'version-unparsable',
      summary: `${options.displayName} version could not be verified.`,
      remediation: {
        kind: 'command',
        message: `Update ${options.displayName}, then rerun doctor.`,
        command: options.upgradeCommand,
      },
    });
    return { executable, checks };
  }

  const comparison = compareSemanticVersions(installedVersion, options.minimum.version);
  if (comparison === undefined || comparison < 0) {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'fail',
      detailCode: comparison === undefined ? 'version-unparsable' : 'version-below-minimum',
      summary: comparison === undefined
        ? `${options.displayName} version could not be compared with the supported floor.`
        : `${options.displayName} ${installedVersion} is below supported ${options.minimum.version}.`,
      evidence: { installedVersion, minimumVersion: options.minimum.version },
      remediation: {
        kind: 'command',
        message: `Update ${options.displayName} to ${options.minimum.version} or newer.`,
        command: options.upgradeCommand,
      },
    });
  } else {
    checks.push({
      id: `${options.checkPrefix}.version`,
      status: 'pass',
      detailCode: 'version-supported',
      summary: `${options.displayName} version is supported.`,
      evidence: { installedVersion, minimumVersion: options.minimum.version },
    });
  }
  return { executable, installedVersion, checks };
}

/** Read the bounded broker-owned launch-failure journal without exposing captured command output verbatim. */
export function diagnoseManagedRuntimeFailure(
  context: SetupDiagnosisContext,
  agent: string,
  displayName: string,
): SetupCheck {
  const stateRoot = context.env.COSYNCING_HOME?.trim()
    || `${context.homeDir}/${PRODUCT_IDENTITY.stateDirectoryName}`;
  const path = `${stateRoot}/logs/managed-runtime-failures.json`;
  const read = context.readText(path, 128 * 1024);
  if (!read.ok && read.reason === 'missing') {
    return {
      id: `${agent}.managed-start-failure`,
      status: 'skip',
      detailCode: 'no-recorded-failure',
      summary: `No ${displayName} managed-start failure is recorded.`,
    };
  }
  if (!read.ok) {
    return {
      id: `${agent}.managed-start-failure`,
      status: 'fail',
      detailCode: 'failure-record-unreadable',
      summary: 'The managed-runtime failure record is unreadable.',
      remediation: { kind: 'command', message: 'Repair broker-owned diagnostic state.', command: 'cosyncing repair' },
    };
  }
  try {
    const parsed = JSON.parse(read.text) as any;
    if (parsed?.schemaVersion !== 1 || !parsed.failures || typeof parsed.failures !== 'object'
        || Array.isArray(parsed.failures)) {
      throw new Error('malformed managed-runtime failure journal');
    }
    const present = Object.prototype.hasOwnProperty.call(parsed.failures, agent);
    const failure = parsed.failures[agent];
    if (!present) {
      return {
        id: `${agent}.managed-start-failure`,
        status: 'skip',
        detailCode: 'no-recorded-failure',
        summary: `No ${displayName} managed-start failure is recorded.`,
      };
    }
    if (!failure || typeof failure !== 'object'
        || typeof failure.detailCode !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(failure.detailCode)
        || typeof failure.recordedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failure.recordedAt)
        || !Number.isFinite(Date.parse(failure.recordedAt))
        || typeof failure.capturedOutput !== 'string'
        || failure.capturedOutput.length > 16 * 1024) {
      throw new Error('malformed managed-runtime failure entry');
    }
    return {
      id: `${agent}.managed-start-failure`,
      status: 'fail',
      detailCode: failure.detailCode,
      summary: `The last managed ${displayName} start failed.`,
      evidence: { recordedAt: failure.recordedAt },
      remediation: { kind: 'command', message: 'Retry the managed runtime check and inspect the recorded failure.', command: 'cosyncing repair' },
    };
  } catch {
    return {
      id: `${agent}.managed-start-failure`,
      status: 'fail',
      detailCode: 'failure-record-malformed',
      summary: 'The managed-runtime failure record is malformed.',
      remediation: { kind: 'command', message: 'Repair broker-owned diagnostic state.', command: 'cosyncing repair' },
    };
  }
}

// ── Backend (one per tool) ───────────────────────────────────────────────────

/** Additive attach context. `reason` only accompanies an authenticated
 *  `mode=resume` attach (see `DriveAttachReason`); adapters that ignore it keep
 *  their existing behavior, which is exactly the mode-only compatibility path. */
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

export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  /** Is the tool installed / its server reachable right now? */
  isAvailable(): Promise<boolean>;
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
  /** Optional dynamic availability for createSession, used when create depends on a live daemon. */
  canCreateSession?(): Promise<boolean> | boolean;
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

export interface SessionDiscoveryOptions {
  /** Inclusive UTC epoch-millisecond cutoff for idle historical sessions. */
  updatedAfter?: number;
  /** Optional deterministic evidence hook for bounded-discovery fixtures. */
  onWork?: (work: SessionDiscoveryWork) => void;
}

/** One native read/query performed by session discovery. */
export type SessionDiscoveryWork =
  | { kind: 'decode-file'; source: string }
  | { kind: 'sqlite-query'; source: string; bounded: boolean; cutoff?: number };

// ── Registry ─────────────────────────────────────────────────────────────────

/** Holds the registered adapters. Adding a tool touches only registration. */
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

  /** Discover sessions across all available backends; failures are isolated. */
  async discoverAll(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const perBackend = await Promise.all(
      this.list().map(async (b) => {
        try {
          if (!(await b.isAvailable())) return [];
          return await b.discoverSessions(options);
        } catch {
          return [];
        }
      }),
    );
    return perBackend.flat();
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
