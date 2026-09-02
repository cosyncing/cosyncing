import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledResourceRecord } from './install-state.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from '../security/secure-files.ts';

export const SETUP_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const SETUP_TRANSACTION_FILENAME = 'setup.json';
export const SETUP_FAILURE_SCHEMA_VERSION = 1 as const;
export const SETUP_FAILURE_DETAIL_LIMIT = 2_048;

export type SetupTransactionStage =
  | 'applying'
  | 'verifying'
  | 'committing'
  | 'rolling-back'
  | 'failed';

export interface SetupPlanAction {
  id: string;
  title: string;
  summary: string;
  reversible: boolean;
}

export interface SetupTransactionPlan {
  schemaVersion: 1;
  id: string;
  preconditionHash: string;
  /** Additive stable identity for provider-owned objects. Older journals legitimately omit it. */
  installationId?: string;
  actions: SetupPlanAction[];
}

export interface SetupRollbackRecord {
  kind: string;
  data: Record<string, unknown>;
}

export interface SetupActionOutcome {
  resources?: InstalledResourceRecord[];
}

export interface SetupTransactionContext {
  home: string;
  transactionDirectory: string;
  plan: Readonly<SetupTransactionPlan>;
}

export interface SetupTransactionAction {
  id: string;
  prepare(context: Readonly<SetupTransactionContext>): Promise<SetupRollbackRecord> | SetupRollbackRecord;
  apply(
    context: Readonly<SetupTransactionContext>,
  ): Promise<SetupActionOutcome | void> | SetupActionOutcome | void;
  verify(context: Readonly<SetupTransactionContext>): Promise<boolean> | boolean;
  /**
   * Omitted by MONOTONIC actions — ones that only ever narrow what is permitted. Reversing such an action
   * means restoring a weaker state than the one in force, from a record written before it was applied, so
   * these declare that they are never undone instead of pretending recovery can widen access safely. The
   * matching plan entry carries `reversible: false`, and a rollback that reaches one treats it as settled
   * rather than as cleanup that failed. Every action that MUTATES CONTENT still has to define this.
   */
  rollback?(
    context: Readonly<SetupTransactionContext>,
    record: Readonly<SetupRollbackRecord>,
  ): Promise<void> | void;
}

export interface SetupCommitAction extends Omit<SetupTransactionAction, 'apply'> {
  apply(
    context: Readonly<SetupTransactionContext>,
    resources: readonly InstalledResourceRecord[],
  ): Promise<SetupActionOutcome | void> | SetupActionOutcome | void;
}

interface AppliedSetupAction {
  id: string;
  rollback: SetupRollbackRecord;
  resources: InstalledResourceRecord[];
  appliedAt: string;
}

export interface SetupTransactionJournal {
  schemaVersion: typeof SETUP_TRANSACTION_SCHEMA_VERSION;
  plan: SetupTransactionPlan;
  stage: SetupTransactionStage;
  startedAt: string;
  updatedAt: string;
  applied: AppliedSetupAction[];
  inFlight?: AppliedSetupAction;
  failureCode?: string;
}

export class SetupTransactionError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(`setup transaction failed (${code})`);
    this.name = 'SetupTransactionError';
  }
}

/**
 * Verification result for the whole-plan and post-commit hooks. A bare boolean stays valid; the object form
 * carries the reason a check failed, which is the only place the real cause of a post-commit failure (a
 * service that never became active and healthy) exists at all.
 */
export type SetupVerification = boolean | { ok: boolean; detail?: string };

function verificationOk(value: SetupVerification): boolean {
  return typeof value === 'boolean' ? value : value.ok;
}

function verificationDetail(value: SetupVerification): string | undefined {
  return typeof value === 'boolean' ? undefined : value.detail;
}

/**
 * The last failed setup run, in machine-readable form.
 *
 * It lives beside the managed-runtime failure journal under `<home>/logs` — a location no rollback touches —
 * and is written AFTER rollback settles, so both the original cause and whether cleanup completed survive the
 * run that produced them. Without it a failed transaction leaves nothing behind: the journal is deleted by a
 * clean rollback and every mutated file is restored, so the operator is told only that setup failed.
 */
export interface SetupFailureDiagnostic {
  schemaVersion: typeof SETUP_FAILURE_SCHEMA_VERSION;
  recordedAt: string;
  transactionId: string;
  /** The stage the transaction had reached when it failed. */
  stage: SetupTransactionStage;
  /** The plan action that failed, when one was executing; absent for whole-plan and post-commit checks. */
  actionId?: string;
  code: string;
  detail: string;
  rollback: 'complete' | 'incomplete';
}

export function setupFailureDiagnosticPath(home: string): string {
  return join(home, 'logs', 'last-setup-failure.json');
}

const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');

/** Bound and flatten an underlying error message so one diagnostic line stays one diagnostic line. */
export function setupFailureDetail(error: unknown): string {
  const raw = error instanceof SetupTransactionError
    ? error.detail ?? error.message
    : error instanceof Error ? error.message : String(error);
  return raw.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, SETUP_FAILURE_DETAIL_LIMIT)
    || 'no underlying error detail was reported';
}

/**
 * Read the last recorded setup failure. A missing, unsafe, or malformed record reads as "none": this file is
 * a breadcrumb for the operator, and refusing to run doctor because the breadcrumb rotted would be worse than
 * the missing breadcrumb itself.
 */
export function readSetupFailureDiagnostic(home: string): SetupFailureDiagnostic | undefined {
  const target = setupFailureDiagnosticPath(home);
  const inspection = inspectOwnerOnlyFile(target);
  if (inspection.status !== 'ok') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(target, 'utf8')); } catch { return undefined; }
  if (!plainRecord(parsed) || parsed.schemaVersion !== SETUP_FAILURE_SCHEMA_VERSION) return undefined;
  if (!validIso(parsed.recordedAt) || !safeIdentifier(parsed.transactionId)) return undefined;
  if (!['applying', 'verifying', 'committing', 'rolling-back', 'failed'].includes(String(parsed.stage))) return undefined;
  if (typeof parsed.code !== 'string' || typeof parsed.detail !== 'string') return undefined;
  if (parsed.rollback !== 'complete' && parsed.rollback !== 'incomplete') return undefined;
  const actionId = parsed.actionId == null ? undefined : parsed.actionId;
  if (actionId !== undefined && !safeIdentifier(actionId)) return undefined;
  return {
    schemaVersion: SETUP_FAILURE_SCHEMA_VERSION,
    recordedAt: parsed.recordedAt,
    transactionId: parsed.transactionId,
    stage: parsed.stage as SetupTransactionStage,
    ...(actionId ? { actionId } : {}),
    code: parsed.code.slice(0, 128),
    detail: parsed.detail.slice(0, SETUP_FAILURE_DETAIL_LIMIT),
    rollback: parsed.rollback,
  };
}

export function recordSetupFailureDiagnostic(
  home: string,
  diagnostic: Omit<SetupFailureDiagnostic, 'schemaVersion'>,
): void {
  atomicWriteJsonOwnerOnly(setupFailureDiagnosticPath(home), {
    schemaVersion: SETUP_FAILURE_SCHEMA_VERSION,
    ...diagnostic,
  } satisfies SetupFailureDiagnostic);
}

/** Drop the breadcrumb once a setup run commits, so doctor never reports a failure the machine has moved past. */
export function clearSetupFailureDiagnostic(home: string): void {
  const target = setupFailureDiagnosticPath(home);
  try {
    if (!existsSync(target)) return;
    assertNoSymlinkComponents(target, false);
    if (lstatSync(target).isFile()) unlinkSync(target);
  } catch {
    // Best effort: a stale breadcrumb is a reporting nuisance, never a reason to fail a successful setup.
  }
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validResource(value: unknown): value is InstalledResourceRecord {
  if (!plainRecord(value) || !safeIdentifier(value.id) || typeof value.target !== 'string') return false;
  if (!['binary', 'alias', 'service', 'environment-file', 'path-entry', 'agent-integration', 'shell-init-block', 'other'].includes(String(value.kind))) {
    return false;
  }
  if (!plainRecord(value.ownership)) return false;
  return ['package-hash', 'receipt', 'legacy-marker'].includes(String(value.ownership.proof));
}

function normalizeRollback(value: unknown): SetupRollbackRecord | undefined {
  if (!plainRecord(value) || !safeIdentifier(value.kind) || !plainRecord(value.data)) return undefined;
  return { kind: value.kind, data: value.data };
}

function normalizeApplied(value: unknown): AppliedSetupAction | undefined {
  if (!plainRecord(value) || !safeIdentifier(value.id) || !validIso(value.appliedAt)) return undefined;
  const rollback = normalizeRollback(value.rollback);
  if (!rollback || !Array.isArray(value.resources) || !value.resources.every(validResource)) return undefined;
  return {
    id: value.id,
    rollback,
    resources: value.resources,
    appliedAt: value.appliedAt,
  };
}

function normalizePlan(value: unknown): SetupTransactionPlan | undefined {
  if (!plainRecord(value) || value.schemaVersion !== 1 || !safeIdentifier(value.id)) return undefined;
  if (typeof value.preconditionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.preconditionHash)) return undefined;
  if (value.installationId !== undefined
      && (typeof value.installationId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.installationId))) return undefined;
  if (!Array.isArray(value.actions)) return undefined;
  const actions: SetupPlanAction[] = [];
  for (const candidate of value.actions) {
    if (!plainRecord(candidate) || !safeIdentifier(candidate.id)
        || typeof candidate.title !== 'string' || typeof candidate.summary !== 'string'
        || typeof candidate.reversible !== 'boolean') return undefined;
    actions.push({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      reversible: candidate.reversible,
    });
  }
  return {
    schemaVersion: 1,
    id: value.id,
    preconditionHash: value.preconditionHash,
    ...(typeof value.installationId === 'string' ? { installationId: value.installationId } : {}),
    actions,
  };
}

function normalizeJournal(value: unknown): SetupTransactionJournal | undefined {
  if (!plainRecord(value) || value.schemaVersion !== SETUP_TRANSACTION_SCHEMA_VERSION) return undefined;
  const plan = normalizePlan(value.plan);
  if (!plan || !['applying', 'verifying', 'committing', 'rolling-back', 'failed'].includes(String(value.stage))) {
    return undefined;
  }
  if (!validIso(value.startedAt) || !validIso(value.updatedAt) || !Array.isArray(value.applied)) return undefined;
  const applied = value.applied.map(normalizeApplied);
  if (applied.some((item) => !item)) return undefined;
  const inFlight = value.inFlight == null ? undefined : normalizeApplied(value.inFlight);
  if (value.inFlight != null && !inFlight) return undefined;
  const failureCode = value.failureCode == null ? undefined : String(value.failureCode);
  if (failureCode && !safeIdentifier(failureCode)) return undefined;
  return {
    schemaVersion: SETUP_TRANSACTION_SCHEMA_VERSION,
    plan,
    stage: value.stage as SetupTransactionStage,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    applied: applied as AppliedSetupAction[],
    ...(inFlight ? { inFlight } : {}),
    ...(failureCode ? { failureCode } : {}),
  };
}

export function setupTransactionRoot(home: string): string {
  return join(home, 'transactions');
}

export function setupTransactionJournalPath(home: string): string {
  return join(setupTransactionRoot(home), SETUP_TRANSACTION_FILENAME);
}

function transactionDirectory(home: string, planId: string): string {
  return join(setupTransactionRoot(home), `setup-${planId}`);
}

function writeJournal(home: string, journal: SetupTransactionJournal): void {
  journal.updatedAt = new Date().toISOString();
  atomicWriteJsonOwnerOnly(setupTransactionJournalPath(home), journal);
}

export function readSetupTransactionJournal(home: string): SetupTransactionJournal | undefined {
  const target = setupTransactionJournalPath(home);
  const inspection = inspectOwnerOnlyFile(target);
  if (inspection.status === 'missing') return undefined;
  if (inspection.status !== 'ok') throw new SetupTransactionError('journal-unsafe');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new SetupTransactionError('journal-malformed');
  }
  const journal = normalizeJournal(parsed);
  if (!journal) throw new SetupTransactionError('journal-malformed');
  return journal;
}

function removeTransactionArtifacts(home: string, planId: string): void {
  const journal = setupTransactionJournalPath(home);
  if (existsSync(journal)) {
    assertNoSymlinkComponents(journal, false);
    const stat = lstatSync(journal);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SetupTransactionError('journal-unsafe');
    unlinkSync(journal);
  }
  const directory = transactionDirectory(home, planId);
  if (existsSync(directory)) {
    assertNoSymlinkComponents(directory);
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SetupTransactionError('backup-unsafe');
    rmSync(directory, { recursive: true });
  }
  // The transaction root exists only to hold the journal and per-plan backups. Leaving it behind after both
  // are gone is exactly the class of empty leftover directory a failed physical run complained about.
  try {
    const root = setupTransactionRoot(home);
    if (existsSync(root) && lstatSync(root).isDirectory() && readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // Best effort: a leftover empty directory must never turn a settled rollback into a failure.
  }
}

function actionMap(
  actions: readonly SetupTransactionAction[],
  commitAction?: SetupCommitAction,
): Map<string, SetupTransactionAction | SetupCommitAction> {
  const map = new Map<string, SetupTransactionAction | SetupCommitAction>();
  for (const action of [...actions, ...(commitAction ? [commitAction] : [])]) {
    if (!safeIdentifier(action.id) || map.has(action.id)) throw new SetupTransactionError('action-catalog-invalid');
    map.set(action.id, action);
  }
  return map;
}

async function rollbackJournal(options: {
  home: string;
  journal: SetupTransactionJournal;
  actions: Map<string, SetupTransactionAction | SetupCommitAction>;
}): Promise<void> {
  const { home, journal, actions } = options;
  journal.stage = 'rolling-back';
  writeJournal(home, journal);
  const context: SetupTransactionContext = {
    home,
    transactionDirectory: transactionDirectory(home, journal.plan.id),
    plan: journal.plan,
  };
  const pending = [
    ...(journal.inFlight ? [journal.inFlight] : []),
    ...[...journal.applied].reverse(),
  ];
  // Every pending action is attempted, even after one fails. Aborting the chain on the first failure left
  // EARLIER actions un-rolled-back — a commit-file restore blocked by an immutable install-state.json would
  // strand the service in whatever posture apply() left it, which is the most consequential thing in the
  // list. Each action that rolls back cleanly is dropped from the journal; anything that failed stays,
  // so the recovery on the next setup run retries exactly the remainder.
  let firstFailure: unknown;
  for (const applied of pending) {
    try {
      const action = actions.get(applied.id);
      if (!action) throw new SetupTransactionError('rollback-action-missing');
      // A monotonic action has nothing to undo, and its absence of a rollback is a settled outcome, not
      // an incomplete one: there is no weaker state that recovery is entitled to restore.
      if (action.rollback) await action.rollback(context, applied.rollback);
    } catch (error) {
      firstFailure ??= error;
      continue;
    }
    if (journal.inFlight?.id === applied.id) {
      delete journal.inFlight;
    } else {
      const index = journal.applied.map((item) => item.id).lastIndexOf(applied.id);
      if (index >= 0) journal.applied.splice(index, 1);
    }
    writeJournal(home, journal);
  }
  if (firstFailure !== undefined) {
    journal.stage = 'failed';
    journal.failureCode = firstFailure instanceof SetupTransactionError
      ? firstFailure.code
      : 'rollback-failed';
    writeJournal(home, journal);
    throw new SetupTransactionError('rollback-failed');
  }
  removeTransactionArtifacts(home, journal.plan.id);
}

/** Roll back an interrupted transaction before replanning. The caller must hold the installation lock. */
export async function recoverSetupTransaction(options: {
  home: string;
  actions: readonly SetupTransactionAction[];
  commitAction: SetupCommitAction;
}): Promise<boolean> {
  const journal = readSetupTransactionJournal(options.home);
  if (!journal) return false;
  await rollbackJournal({
    home: options.home,
    journal,
    actions: actionMap(options.actions, options.commitAction),
  });
  return true;
}

/**
 * Apply a confirmed plan. A rollback snapshot is journaled before every mutation, and the ownership result
 * is journaled before the next action starts. The caller must hold the installation lock.
 */
export async function executeSetupTransaction(options: {
  home: string;
  plan: SetupTransactionPlan;
  actions: readonly SetupTransactionAction[];
  commitAction: SetupCommitAction;
  verifyAll: () => Promise<SetupVerification> | SetupVerification;
  /** Runs after the D14 receipt exists but before the journal is committed/removed (for service start + health). */
  verifyCommitted?: (
    resources: readonly InstalledResourceRecord[],
  ) => Promise<SetupVerification> | SetupVerification;
  now?: () => Date;
}): Promise<{ resources: InstalledResourceRecord[] }> {
  if (readSetupTransactionJournal(options.home)) throw new SetupTransactionError('journal-already-present');
  const catalog = actionMap(options.actions, options.commitAction);
  const ids = new Set<string>();
  for (const descriptor of options.plan.actions) {
    if (ids.has(descriptor.id) || !catalog.has(descriptor.id)) throw new SetupTransactionError('plan-action-invalid');
    ids.add(descriptor.id);
  }
  if (!catalog.has(options.commitAction.id)) throw new SetupTransactionError('commit-action-missing');

  const directory = transactionDirectory(options.home, options.plan.id);
  ensureOwnerOnlyDirectory(directory);
  const timestamp = (): string => (options.now?.() ?? new Date()).toISOString();
  const journal: SetupTransactionJournal = {
    schemaVersion: SETUP_TRANSACTION_SCHEMA_VERSION,
    plan: options.plan,
    stage: 'applying',
    startedAt: timestamp(),
    updatedAt: timestamp(),
    applied: [],
  };
  writeJournal(options.home, journal);
  const context: SetupTransactionContext = {
    home: options.home,
    transactionDirectory: directory,
    plan: options.plan,
  };

  // Which plan action owns the current step. It is the one thing a failure report cannot reconstruct
  // afterwards: a clean rollback empties the journal, so nothing on disk says where the run stopped.
  let failingActionId: string | undefined;
  try {
    for (const descriptor of options.plan.actions) {
      const action = catalog.get(descriptor.id) as SetupTransactionAction;
      failingActionId = action.id;
      const rollback = await action.prepare(context);
      journal.inFlight = { id: action.id, rollback, resources: [], appliedAt: timestamp() };
      writeJournal(options.home, journal);
      const outcome = await action.apply(context);
      journal.inFlight.resources = [...(outcome?.resources ?? [])];
      writeJournal(options.home, journal);
      if (!await action.verify(context)) {
        throw new SetupTransactionError(
          `verify-${action.id}`,
          `${action.id} applied but did not verify as the state the plan declared`,
        );
      }
      journal.applied.push(journal.inFlight);
      delete journal.inFlight;
      writeJournal(options.home, journal);
    }

    journal.stage = 'verifying';
    failingActionId = undefined;
    writeJournal(options.home, journal);
    const verified = await options.verifyAll();
    if (!verificationOk(verified)) {
      throw new SetupTransactionError(
        'verify-final',
        verificationDetail(verified) ?? 'the applied plan did not verify as a complete installation',
      );
    }

    journal.stage = 'committing';
    failingActionId = options.commitAction.id;
    writeJournal(options.home, journal);
    const commitRollback = await options.commitAction.prepare(context);
    journal.inFlight = {
      id: options.commitAction.id,
      rollback: commitRollback,
      resources: [],
      appliedAt: timestamp(),
    };
    writeJournal(options.home, journal);
    const resources = journal.applied.flatMap((item) => item.resources);
    const commitOutcome = await options.commitAction.apply(context, resources);
    journal.inFlight.resources = [...(commitOutcome?.resources ?? [])];
    writeJournal(options.home, journal);
    if (!await options.commitAction.verify(context)) {
      throw new SetupTransactionError('verify-commit', 'the install receipt did not read back as committed');
    }
    journal.applied.push(journal.inFlight);
    delete journal.inFlight;
    writeJournal(options.home, journal);
    if (options.verifyCommitted) {
      failingActionId = undefined;
      const committed = await options.verifyCommitted(resources);
      if (!verificationOk(committed)) {
        throw new SetupTransactionError(
          'verify-post-commit',
          verificationDetail(committed) ?? 'the installed broker did not come up healthy after commit',
        );
      }
    }

    removeTransactionArtifacts(options.home, options.plan.id);
    clearSetupFailureDiagnostic(options.home);
    return { resources };
  } catch (error) {
    const stage = journal.stage;
    journal.failureCode = error instanceof SetupTransactionError ? error.code : 'action-failed';
    writeJournal(options.home, journal);
    let rollbackFailure: unknown;
    try {
      await rollbackJournal({ home: options.home, journal, actions: catalog });
    } catch (failure) {
      rollbackFailure = failure;
    }
    // Written after rollback settles so the record survives it and can state whether cleanup completed.
    recordSetupFailureDiagnostic(options.home, {
      recordedAt: timestamp(),
      transactionId: options.plan.id,
      stage,
      ...(failingActionId ? { actionId: failingActionId } : {}),
      code: error instanceof SetupTransactionError ? error.code : 'action-failed',
      detail: setupFailureDetail(error),
      rollback: rollbackFailure === undefined ? 'complete' : 'incomplete',
    });
    if (rollbackFailure !== undefined) throw rollbackFailure;
    throw error instanceof SetupTransactionError
      ? error
      : new SetupTransactionError('action-failed', setupFailureDetail(error));
  }
}
