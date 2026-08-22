/**
 * Durable broker setup-state — per-agent sync enablement that survives broker restarts and cache wipes.
 *
 * This is the durable home for what used to be the global `SessionControlPreference` two-mode picker
 * (`observe-drive` | `true-sync-terminal`). The Sync Refactor (D28) renames the concept to
 * {@link AgentSyncEnablement}: sync is no longer a user "preference" you pick globally — it is a
 * per-agent setup/enablement flag. Today only Codex needs an explicit, persisted enable (its managed
 * `codex app-server` daemon is process-global and gated on `COSYNCING_CODEX_SYNC_SERVER`); OpenCode
 * auto-serves (D20) and Pi probes for its installed extension (D22), so neither persists a flag here.
 *
 * Location: `${COSYNCING_HOME ?? ~/.cosyncing}/setup-state.json` (D18 — honors COSYNCING_HOME
 * so it survives cache wipes). Read at broker startup to set `COSYNCING_CODEX_SYNC_SERVER` BEFORE adapters
 * construct, so a broker launched after onboarding needs NO restart (FU-3).
 *
 * Governing contract: docs/architecture/client-ui.md
 */
import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { CodexRuntimeUpdatePolicy } from '@cosyncing/protocol';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { atomicWriteJsonOwnerOnly } from '../security/secure-files.ts';

export const SETUP_STATE_SCHEMA_VERSION = 1 as const;

/** Per-agent sync enablement (renamed from the old global `SessionControlPreference`, D28). */
export interface AgentSyncEnablement {
  /** Codex managed-daemon sync server enabled → broker sets COSYNCING_CODEX_SYNC_SERVER=1 at construction. */
  codex?: boolean;
}

export type CodexUpdatePolicy = CodexRuntimeUpdatePolicy;

/**
 * Control-socket identity of the broker-started Codex daemon. A replacement daemon recreates the socket at
 * the same path, so a changed fingerprint proves the live daemon is NOT the recorded instance.
 */
export interface CodexDaemonSocketFingerprint {
  /** `st_dev` of the control-socket file at record time. */
  dev: number;
  /** `st_ino` of the control-socket file at record time. */
  ino: number;
  /** `st_mtime` (ms) of the control-socket file at record time; guards inode reuse. */
  mtimeMs: number;
}

/**
 * Runtime ownership evidence for the process-global Codex `app-server` daemon (BPC8 uninstall).
 *
 * The broker fire-and-forget spawns `codex app-server daemon start` when Codex sync is enabled. Because
 * `daemon start` is idempotent, the exit code cannot distinguish "cosyncing started this daemon" from
 * "cosyncing joined a pre-existing user daemon". The adapter therefore probes the daemon BEFORE spawning
 * and reports the outcome so the broker can record this evidence. Uninstall only stops the daemon when
 * `startedByBroker === true` AND the recorded `socket` fingerprint still matches the live control socket;
 * a pre-existing, replaced, or unknown/unproven daemon is left running. Absence of this field — or of the
 * `socket` fingerprint (records written before the fingerprint existed) — is unproven ownership, and
 * uninstall never stops on unproven.
 */
export interface CodexDaemonOwnership {
  /** True only when cosyncing spawned the daemon from a confidently-absent state (not a pre-existing one). */
  startedByBroker: boolean;
  /** ISO-8601 timestamp recording when this evidence was last written. */
  recordedAt: string;
  /** Control-socket fingerprint captured when the broker started the daemon; proves the live instance. */
  socket?: CodexDaemonSocketFingerprint;
}

/** The on-disk shape of `setup-state.json`. Additive — unknown keys are preserved on write. */
export interface SetupState {
  /** Added by BPC3. Absence is the explicit repo-era migration case; every new write stamps v1. */
  schemaVersion?: typeof SETUP_STATE_SCHEMA_VERSION;
  agents?: AgentSyncEnablement;
  /** Automatic Codex daemon update gate. Missing/invalid values fail back to attachment-empty. */
  codexUpdatePolicy?: CodexUpdatePolicy;
  /** BPC8 ownership evidence for the managed Codex app-server daemon; drives uninstall's stop decision. */
  codexDaemon?: CodexDaemonOwnership;
  /** cosyncing's independent Tokdash quota-warning consent. Missing/invalid remains off. */
  quotaWarningsEnabled?: boolean;
  /**
   * What setup provisioned for Tokdash, if anything. Absent for a reused or pre-existing instance, which is
   * the case uninstall must leave completely untouched. Shaped like `codexDaemon`: prove ownership from a
   * record we wrote, or do nothing.
   */
  tokdash?: TokdashOwnershipRecord;
  /**
   * Positive proof that Tokdash provisioning FINISHED at one endpoint. Absence is what a rerun acts on, so
   * a write that never lands costs a repeated idempotent stage instead of disabling the retry forever.
   */
  tokdashComplete?: TokdashCompletionRecord;
  /**
   * Round 13's stage list — write-only history now, and nothing reads it. Kept declared so the writers below
   * can delete it by name: an upgraded host must not carry a record whose whole purpose was to suppress
   * stages. A remnant cannot suppress anything, malformed or not, because there is no reader left.
   */
  tokdashProgress?: unknown;
  /** One required disclosure/acknowledgement covers supported managed Codex/OpenCode/Pi ownership. */
  managedRuntimeAcknowledgedAt?: string;
  /**
   * BPC5 records the user's service choice; BPC6 owns installing the persistent provider. `launchd` is the
   * darwin durable option and is additive to schemaVersion 1: state written before it existed simply never
   * carries the value, and every reader below treats an unknown value as foreground.
   */
  serviceChoice?: 'foreground' | 'systemd' | 'launchd';
  /** Separate BPC6 consent; true records intent, while the install receipt proves whether cosyncing enabled it. */
  systemdLingeringRequested?: boolean;
  /** One consent controls the package-owned cosyncing agent skill installed in both native discovery roots. */
  agentSkillRequested?: boolean;
  /** Consent to route terminal `opencode` to the shared serve via the shell shim (R1 script + R2 rc blocks). */
  opencodeShimRequested?: boolean;
  /**
   * Wizard language, chosen in setup's first step. Kept as a plain string here so this module stays free of
   * the copy catalog; readers validate it and fall back to English, which is what an older or newer build
   * writing an unknown value degrades to.
   */
  language?: string;
  /** Forward-compat: preserve any keys other subsystems persist here. */
  [key: string]: unknown;
}

/**
 * True when the recorded choice means "a durable service manager owns the broker". Anything else — absent,
 * `foreground`, or a value written by a newer build this one does not know — is foreground, so an older
 * binary reading newer state degrades to the safe mode instead of constructing a provider it cannot drive.
 */
export function isDurableServiceChoice(value: unknown): value is 'systemd' | 'launchd' {
  return value === 'systemd' || value === 'launchd';
}

export function getQuotaWarningsEnabled(): boolean {
  return readSetupState().quotaWarningsEnabled === true;
}

export function setQuotaWarningsEnabled(enabled: boolean): SetupState {
  const next: SetupState = { ...readSetupState(), quotaWarningsEnabled: enabled === true };
  writeSetupState(next);
  return next;
}

export function getCodexUpdatePolicy(): CodexUpdatePolicy {
  return readSetupState().codexUpdatePolicy === 'when-idle' ? 'when-idle' : 'when-detached';
}

export function setCodexUpdatePolicy(policy: CodexUpdatePolicy): SetupState {
  const next: SetupState = { ...readSetupState(), codexUpdatePolicy: policy };
  writeSetupState(next);
  return next;
}

/** `${COSYNCING_HOME ?? ~/.cosyncing}` (D18). */
export function setupStateHome(): string {
  const override = process.env.COSYNCING_HOME?.trim();
  if (!override) return join(os.homedir(), PRODUCT_IDENTITY.stateDirectoryName);
  if (!isAbsolute(override) || override.includes('\0')) {
    throw new Error('COSYNCING_HOME must be an absolute path');
  }
  return resolve(override);
}

export function setupStatePath(home = setupStateHome()): string {
  return join(home, 'setup-state.json');
}

/** Read the durable setup-state. Missing file or malformed JSON → `{}` (never throws). */
export function readSetupState(home = setupStateHome()): SetupState {
  try {
    const raw = readFileSync(setupStatePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    // Only a plain object is a valid SetupState — arrays/numbers/strings → {} (honor the "→ {}" contract).
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SetupState) : {};
  } catch {
    return {};
  }
}

/** Persist the full setup-state, creating the home directory if needed. */
export function writeSetupState(next: SetupState, home = setupStateHome()): void {
  // Atomic owner-only write: a crash or concurrent writer must never leave a truncated file, and unknown
  // additive fields survive because callers merge from readSetupState() before reaching this boundary.
  atomicWriteJsonOwnerOnly(
    setupStatePath(home),
    { ...next, schemaVersion: SETUP_STATE_SCHEMA_VERSION },
  );
}

/**
 * Read validated Codex daemon ownership evidence. A malformed/absent field → undefined (unknown ownership),
 * which uninstall treats as "do not stop the daemon". A malformed `socket` fingerprint is dropped on its
 * own (unproven ownership), never fabricated.
 */
export function readCodexDaemonOwnership(home = setupStateHome()): CodexDaemonOwnership | undefined {
  const raw: unknown = readSetupState(home).codexDaemon;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.startedByBroker !== 'boolean') return undefined;
  const socket = readSocketFingerprint(candidate.socket);
  return {
    startedByBroker: candidate.startedByBroker,
    recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : '',
    ...(socket ? { socket } : {}),
  };
}

/** Validate a persisted socket fingerprint; anything malformed → undefined (unproven ownership). */
function readSocketFingerprint(raw: unknown): CodexDaemonSocketFingerprint | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.dev !== 'number' || typeof candidate.ino !== 'number' || typeof candidate.mtimeMs !== 'number') {
    return undefined;
  }
  return { dev: candidate.dev, ino: candidate.ino, mtimeMs: candidate.mtimeMs };
}

/** Merge Codex daemon ownership evidence into the durable setup-state and return the updated state. */
/**
 * Ownership of a Tokdash instance, as two independently reversible facts. Both false is not written at all:
 * a reused or pre-existing instance leaves no record, so uninstall has nothing to prove and nothing to do.
 */
export interface TokdashOwnershipRecord {
  installedByBroker: boolean;
  serviceStartedByBroker: boolean;
  recordedAt: string;
}

/** Anything malformed reads back as no record, i.e. unproven ownership — the safe direction. */
export function readTokdashOwnership(home = setupStateHome()): TokdashOwnershipRecord | undefined {
  const raw: unknown = readSetupState(home).tokdash;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.installedByBroker !== 'boolean' || typeof candidate.serviceStartedByBroker !== 'boolean') {
    return undefined;
  }
  if (!candidate.installedByBroker && !candidate.serviceStartedByBroker) return undefined;
  return {
    installedByBroker: candidate.installedByBroker,
    serviceStartedByBroker: candidate.serviceStartedByBroker,
    recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : '',
  };
}

/** Merge Tokdash provisioning evidence into the durable setup-state and return the updated state. */
export function setTokdashOwnership(evidence: TokdashOwnershipRecord, home = setupStateHome()): SetupState {
  const next: SetupState = { ...readSetupState(home), tokdash: evidence };
  writeSetupState(next, home);
  return next;
}

/** Drop the record once its resources are reversed, so a later run never tries to reverse them twice. */
export function clearTokdashOwnership(home = setupStateHome()): SetupState {
  const { tokdash: _removed, ...rest } = readSetupState(home);
  writeSetupState(rest, home);
  return rest;
}

/**
 * Provisioning finished, at this endpoint.
 *
 * Round 13 recorded the opposite — a mutable list of stages already done, consulted to decide what to SKIP —
 * and that polarity is what made a lost write permanent: the write was best-effort, so the note could go
 * missing, and the retry gate then read owned-resources-with-no-note as "nothing outstanding" and skipped
 * provisioning on every later run. Consent stayed off forever.
 *
 * A positive marker inverts the failure. It is written only once quota consent has been issued AND the
 * instance answered `/health`, so its ABSENCE — missing, malformed, from a build that never wrote one — is
 * always read as "retry". A marker write that fails therefore costs one repeated `tokdash quota consent`,
 * which is idempotent, rather than a retry nobody can re-arm.
 *
 * `baseUrl` is part of the record because completion at one endpoint proves nothing about another: an
 * operator who moves `COSYNCING_TOKDASH_URL` after a finished run must get provisioning at the new address,
 * not a marker that says the old one is done.
 */
export interface TokdashCompletionRecord {
  baseUrl: string;
  completedAt: string;
}

/** Anything malformed reads back as no marker, i.e. provisioning is unfinished and the rerun redoes it. */
export function readTokdashCompletion(home = setupStateHome()): TokdashCompletionRecord | undefined {
  const raw: unknown = readSetupState(home).tokdashComplete;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.baseUrl !== 'string' || !candidate.baseUrl) return undefined;
  return {
    baseUrl: candidate.baseUrl,
    completedAt: typeof candidate.completedAt === 'string' ? candidate.completedAt : '',
  };
}

/**
 * Record that provisioning finished. Round 13's stage list is dropped in the same write: it is no longer
 * read, and leaving it on disk would carry a record whose only purpose was suppressing stages.
 */
export function setTokdashCompletion(record: TokdashCompletionRecord, home = setupStateHome()): SetupState {
  const { tokdashProgress: _legacy, ...current } = readSetupState(home);
  const next: SetupState = { ...current, tokdashComplete: record };
  writeSetupState(next, home);
  return next;
}

/**
 * Drop the marker — provisioning is no longer finished here. Reversing any owned resource falsifies it, so
 * uninstall clears it with the FIRST reversal rather than the last: a marker outliving the service it
 * describes would tell the next run there is nothing to do on a host that now has nothing.
 */
export function clearTokdashCompletion(home = setupStateHome()): SetupState {
  const { tokdashComplete: _removed, tokdashProgress: _legacy, ...rest } = readSetupState(home);
  writeSetupState(rest, home);
  return rest;
}

export function setCodexDaemonOwnership(evidence: CodexDaemonOwnership, home = setupStateHome()): SetupState {
  const next: SetupState = { ...readSetupState(home), codexDaemon: evidence };
  writeSetupState(next, home);
  return next;
}

/** Merge one agent's sync enablement into the durable setup-state and return the updated state. */
export function setAgentSyncEnabled(agent: keyof AgentSyncEnablement, enabled: boolean): SetupState {
  const current = readSetupState();
  // Normalize a malformed `agents` (non-plain-object) to {} so we never spread a string char-by-char or
  // leak array index keys back to disk.
  const agents =
    current.agents && typeof current.agents === 'object' && !Array.isArray(current.agents) ? current.agents : {};
  const next: SetupState = { ...current, agents: { ...agents, [agent]: enabled } };
  writeSetupState(next);
  return next;
}
