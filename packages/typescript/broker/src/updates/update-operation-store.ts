/**
 * Durable plans and jobs for in-app updates.
 *
 * Three properties do the work here, and each earns its keep by failing loudly
 * without it:
 *
 *   - A plan is persisted before the caller is told it exists, and carries the
 *     principal, installation identity and generation it was issued for. A review
 *     that survives a restart must not be replayable by a different device or
 *     against an installation that has since moved.
 *   - A job is durable before the 202 goes out, so a lost response is a lookup
 *     rather than a second installation. Idempotency is scoped to principal and
 *     installation, and reusing a key for different content is a conflict.
 *   - A job belongs to the principal that created it, recorded beside the job rather
 *     than inside it. Reading somebody else's job is fenced one layer up; mutating it
 *     is fenced here, because those are different calls, and a mutation that trusts
 *     its caller is one any peer holding an update grant can make.
 *   - Everything lands through owner-only atomic writes under the state root, not
 *     beside the trees an update replaces. A journal inside the thing being swapped
 *     is a journal that gets swapped away.
 *
 * Nothing here starts a process or touches an installation. It records what was
 * agreed and what happened, which is what a runner that dies needs to resume from.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATE_JOB_SCHEMA_VERSION,
  isUpdateJobTerminal,
  type UpdateComponent,
  type UpdateAcknowledgement,
  type UpdateContractAdvert,
  type UpdateComponentOutcome,
  type UpdateJob,
  type UpdateJobComponentState,
  type UpdateJobPhase,
  type UpdatePlan,
  type UpdateStage,
} from '@cosyncing/protocol';
import {
  atomicWriteJsonOwnerOnly,
  ensureOwnerOnlyDirectory,
  readOwnerOnlyText,
} from '../security/secure-files.ts';

/** Who the operation belongs to. Bound to identity, never to a credential. */
export interface UpdatePrincipalRef {
  kind: 'owner' | 'peer';
  id: string;
}

export interface StoredUpdatePlan {
  schemaVersion: typeof UPDATE_JOB_SCHEMA_VERSION;
  plan: UpdatePlan;
  principal: UpdatePrincipalRef;
  /**
   * What the review was asked for, which is not the same as what it ended up scheduling.
   *
   * A component the planner refuses never appears in the plan, so a later eligibility check
   * driven by the plan alone would be re-running "update nothing" and calling the result
   * clean. The request travels with the review so the recheck can fail for the same reason
   * the first attempt did.
   */
  requested?: UpdateComponent[];
  /**
   * Consent the caller gave for this plan, recorded verbatim.
   *
   * Optional because a plan written before the field existed carries no record of it;
   * such a plan falls back to "required minus what was still outstanding", which is
   * what the caller must have given for it to have looked executable.
   */
  acknowledged?: UpdateAcknowledgement[];
  /**
   * The session contract the caller advertised at review time.
   *
   * Kept with the plan because the client half of a broker-only compatibility check is
   * this caller's own build, which the host cannot read for itself, and the check has to
   * be repeatable when the job is committed.
   */
  clientContract?: UpdateContractAdvert;
  /** Content fingerprint, so an idempotency key can detect reuse with other content. */
  fingerprint: string;
  createdAt: string;
}

export type PlanRejection =
  | 'not-found'
  | 'expired'
  | 'principal-mismatch'
  | 'installation-mismatch'
  | 'generation-mismatch'
  | 'unknown-schema';

/** What a submission's idempotency key already resolved to, before anything is created. */
export type ExistingSubmission =
  | { status: 'none' }
  | { status: 'found'; job: UpdateJob }
  /** The key belongs to other reviewed work, or to a record this build cannot honour. */
  | { status: 'conflict' };

export type JobSubmission =
  | { status: 'created'; job: UpdateJob }
  | { status: 'existing'; job: UpdateJob }
  /** Same key, different content: the caller must not get a second operation. */
  | { status: 'idempotency-conflict' }
  | { status: 'plan-rejected'; reason: PlanRejection }
  /** Another operation already owns a component of this plan. */
  | { status: 'in-progress'; job: UpdateJob };

export type ApplyAcceptance =
  | { status: 'accepted'; job: UpdateJob }
  | { status: 'existing'; job: UpdateJob }
  | { status: 'not-found' }
  | { status: 'forbidden' }
  | { status: 'not-ready'; phase: UpdateJobPhase };

/** Why a stored record could not be used. Distinct from "does not exist". */
export type RecordRead<T> = { ok: true; value: T } | { ok: false; reason: 'unreadable' | 'unknown-schema' };

export interface UpdateOperationStoreOptions {
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Retained finished jobs. Active and recoverable ones are never pruned. */
  retainFinished?: number;
}

interface IdempotencyRecord {
  schemaVersion: typeof UPDATE_JOB_SCHEMA_VERSION;
  jobId: string;
  planId: string;
  planFingerprint: string;
  createdAt: string;
}

/** Who a job belongs to. Written once, at creation, from the authenticated caller. */
interface JobAuthorityRecord {
  schemaVersion: typeof UPDATE_JOB_SCHEMA_VERSION;
  jobId: string;
  principal: UpdatePrincipalRef;
  createdAt: string;
}

const PLANS = 'plans';
const JOBS = 'jobs';
const KEYS = 'idempotency';
/** Per-job ownership, kept out of the wire record and never taken from a request. */
const AUTHORITY = 'authority';

function stableFingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function principalKey(principal: UpdatePrincipalRef): string {
  return `${principal.kind}:${principal.id}`;
}

/** Deterministic on purpose: tests, logs, and recovery all recompute the same key. */
function idempotencyKey(principal: UpdatePrincipalRef, installationId: string, key: string): string {
  return createHash('sha256').update(`${principalKey(principal)}|${installationId}|${key}`).digest('hex');
}

function parseRecord<T>(path: string): RecordRead<T> {
  let text: string;
  try {
    text = readOwnerOnlyText(path);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!value || typeof value !== 'object') return { ok: false, reason: 'unreadable' };
  // A record from a future schema is left exactly where it is. Reading it into a
  // shape this build guesses at, then writing the guess back, is how a rollback
  // turns a recoverable journal into a corrupted one.
  if ((value as { schemaVersion?: unknown }).schemaVersion !== UPDATE_JOB_SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown-schema' };
  }
  return { ok: true, value: value as T };
}

export class UpdateOperationStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly retainFinished: number;

  constructor(root: string, options: UpdateOperationStoreOptions = {}) {
    this.root = root;
    this.now = options.now ?? (() => new Date());
    this.retainFinished = options.retainFinished ?? 50;
    let counter = 0;
    this.newId = options.newId ?? ((prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`);
    ensureOwnerOnlyDirectory(root);
    for (const leaf of [PLANS, JOBS, KEYS]) ensureOwnerOnlyDirectory(join(root, leaf));
  }

  /**
   * Record a reviewed plan before the caller is told its id, and only if nothing is there.
   *
   * The acknowledgements the caller actually gave travel with the plan instead of
   * living only in the moment they were given, so a job created later can be re-planned
   * against fresh conditions without asking anybody twice.
   *
   * A plan id belongs to one review, and the file behind it is the consent somebody else may
   * already be holding: an apply re-reads it to prove the user agreed to what is about to run.
   * Writing over an id that exists would replace one review's consent with another's, which is
   * why an existing record is reported rather than replaced. Ids carry entropy for the same
   * reason, so `exists` means the id was handed back from outside rather than minted twice.
   */
  putPlan(
    plan: UpdatePlan,
    principal: UpdatePrincipalRef,
    context: {
      requested?: readonly UpdateComponent[];
      acknowledged?: readonly UpdateAcknowledgement[];
      clientContract?: UpdateContractAdvert;
    } = {},
  ): { status: 'stored'; record: StoredUpdatePlan } | { status: 'exists'; record?: StoredUpdatePlan } {
    const path = this.planPath(plan.planId);
    // Checked against the directory rather than a read, because a record that cannot be parsed
    // still occupies its id, and "unreadable" is the same answer there as in the file.
    if (existsSync(path)) {
      const prior = this.readPlan(plan.planId);
      return prior.ok ? { status: 'exists', record: prior.value } : { status: 'exists' };
    }
    const record: StoredUpdatePlan = {
      schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
      plan,
      principal,
      ...(context.requested === undefined ? {} : { requested: [...new Set(context.requested)] }),
      acknowledged: [...new Set(context.acknowledged ?? [])],
      ...(context.clientContract === undefined ? {} : { clientContract: context.clientContract }),
      fingerprint: planFingerprint(plan),
      createdAt: this.now().toISOString(),
    };
    atomicWriteJsonOwnerOnly(path, record);
    return { status: 'stored', record };
  }

  readPlan(planId: string): RecordRead<StoredUpdatePlan> {
    return parseRecord<StoredUpdatePlan>(this.planPath(planId));
  }

  /**
   * Redeem a plan for a submission, rechecking everything that could have moved.
   *
   * Expiry alone is not staleness: the installation generation and the expected
   * build are what turn "another device already ran the update" and "this peer was
   * handed someone else's review" into typed conflicts instead of an action.
   */
  redeemPlan(input: {
    planId: string;
    principal: UpdatePrincipalRef;
    installationId: string;
    installationGeneration: number;
  }): { ok: true; record: StoredUpdatePlan } | { ok: false; reason: PlanRejection } {
    const read = this.readPlan(input.planId);
    if (!read.ok) return { ok: false, reason: read.reason === 'unknown-schema' ? 'unknown-schema' : 'not-found' };
    const record = read.value;
    if (record.principal.kind !== input.principal.kind || record.principal.id !== input.principal.id) {
      return { ok: false, reason: 'principal-mismatch' };
    }
    if (record.plan.installationId !== input.installationId) return { ok: false, reason: 'installation-mismatch' };
    if (record.plan.installationGeneration !== input.installationGeneration) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    if (Date.parse(record.plan.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };
    return { ok: true, record };
  }

  /**
   * The job an earlier submission with this key already created, resolved without side effects.
   *
   * A retry is authenticated by the same principal-and-installation scope the key is hashed
   * with, so a hit is the same caller asking the same question twice rather than a new
   * submission to be graded against conditions that moved since. Answering it from the index
   * is what makes a lost response cheap, and it has to be answerable on its own: a caller
   * whose preparation succeeded but whose answer vanished has to reach this lookup before
   * anything else is re-evaluated, or the very work its job started refuses the retry.
   *
   * A key that names a job which is not there is a torn write from a crash between the two
   * files, and is reported apart from "never submitted": making a second operation would
   * double the side effects, and clearing the index would hand the key to other content.
   */
  lookupSubmission(input: {
    planId: string;
    idempotencyKey: string;
    principal: UpdatePrincipalRef;
    installationId: string;
    installationGeneration: number;
  }): ExistingSubmission {
    const index = this.readIdempotency(input.principal, input.installationId, input.idempotencyKey);
    if (!index) return { status: 'none' };
    const read = this.readJob(index.jobId);
    if (!read.ok) return { status: 'conflict' };
    // A client that lost its response must find the original operation, even after the plan
    // itself has expired or this installation has been set up again. Reusing the key for
    // different reviewed content is the opposite case, and gets a conflict rather than
    // somebody else's job.
    const redeemed = this.redeemPlan(input);
    const sameContent = !redeemed.ok || redeemed.record.fingerprint === index.planFingerprint;
    return index.planId === input.planId && sameContent
      ? { status: 'found', job: read.value }
      : { status: 'conflict' };
  }

  /**
   * Create the durable job for a redeemed plan, or return the one that already exists.
   *
   * The idempotency index is written after the job, and a lookup that finds an index
   * pointing at a missing job reports the conflict rather than silently creating a
   * second one -- a partially written pair is exactly the crash this exists for.
   */
  submitJob(input: {
    planId: string;
    idempotencyKey: string;
    principal: UpdatePrincipalRef;
    installationId: string;
    installationGeneration: number;
    /** Runner the host will hand this job to; recorded so recovery can tell who owns it. */
    runner?: string;
  }): JobSubmission {
    const prior = this.lookupSubmission(input);
    if (prior.status === 'found') return { status: 'existing', job: prior.job };
    if (prior.status === 'conflict') return { status: 'idempotency-conflict' };
    const redeemed = this.redeemPlan(input);
    if (!redeemed.ok) return { status: 'plan-rejected', reason: redeemed.reason };
    const plan = redeemed.record.plan;

    const busy = this.activeJobFor(plan.components.map((component) => component.component), plan.installationId);
    if (busy) return { status: 'in-progress', job: busy };

    const now = this.now().toISOString();
    const job: UpdateJob = {
      schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
      jobId: this.newId('job'),
      planId: plan.planId,
      releaseId: plan.releaseId,
      installationId: plan.installationId,
      installationGeneration: plan.installationGeneration,
      phase: 'accepted',
      sequence: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.runner ? { runner: { identity: input.runner } } : {}),
      components: plan.components.map((component): UpdateJobComponentState => ({
        component: component.component,
        outcome: 'pending',
        detailCode: 'job-accepted',
        actual: component.from,
      })),
      events: [{ at: now, phase: 'accepted', detailCode: 'job-accepted' }],
    };
    this.writeJob(job);
    // Ownership is recorded with the job, from the caller the transport authenticated: a
    // later request cannot claim it. A job whose record cannot be read belongs to nobody,
    // which the host can still settle and a peer cannot.
    this.writeAuthority(job.jobId, input.principal, now);
    atomicWriteJsonOwnerOnly(this.idempotencyPath(input.principal, input.installationId, input.idempotencyKey), {
      schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
      jobId: job.jobId,
      planId: plan.planId,
      planFingerprint: redeemed.record.fingerprint,
      createdAt: now,
    });
    return { status: 'created', job };
  }

  readJob(jobId: string): RecordRead<UpdateJob> {
    return parseRecord<UpdateJob>(this.jobPath(jobId));
  }

  /**
   * Move a job to its next phase under a single atomic rewrite.
   *
   * Progress is persisted before it can be advertised, and the phase machine is
   * checked here rather than trusted from the caller: an `accepted` job that jumps
   * to `verifying` would mean a commit nobody recorded.
   */
  transition(
    jobId: string,
    principal: UpdatePrincipalRef | 'host',
    next: UpdateJobPhase,
    detailCode: string,
    components?: ReadonlyArray<{ component: UpdateComponent; outcome: UpdateComponentOutcome; stage?: UpdateStage; actual?: UpdateJob['components'][number]['actual'] }>,
    /** Runner delegation, recorded in the same rewrite as the phase that created it. */
    runner?: UpdateJob['runner'],
  ): { ok: true; job: UpdateJob } | { ok: false; reason: 'not-found' | 'unreadable' | 'unknown-schema' | 'forbidden' | 'terminal' | 'illegal-transition' } {
    const read = this.readJob(jobId);
    if (!read.ok) return { ok: false, reason: read.reason === 'unknown-schema' ? 'unknown-schema' : 'not-found' };
    const job = read.value;
    // Ownership is checked ahead of the phase machine, so a stranger learns nothing
    // about the job beyond the fact that it cannot move it.
    if (!this.mayAct(jobId, principal)) return { ok: false, reason: 'forbidden' };
    // Terminal is terminal. A client that reconnects to a finished job reads it; it
    // does not get to rewrite it, and a lost connection cannot strand work the user
    // could still stop while it was open.
    if (isUpdateJobTerminal(job.phase)) return { ok: false, reason: 'terminal' };
    if (!LEGAL_TRANSITIONS[job.phase].includes(next)) return { ok: false, reason: 'illegal-transition' };

    const now = this.now().toISOString();
    const updated: UpdateJob = {
      ...job,
      phase: next,
      sequence: job.sequence + 1,
      updatedAt: now,
      ...(runner === undefined ? {} : { runner }),
      events: [...job.events, { at: now, phase: next, detailCode }],
      components: (components ?? []).length === 0
        ? job.components.map((component) => (next === 'verifying' || next === 'succeeded') && component.outcome === 'committed'
          ? { ...component, outcome: 'verified' as UpdateComponentOutcome }
          : component)
        : job.components.map((component) => {
          const patch = components!.find((entry) => entry.component === component.component);
          return patch ? {
            ...component,
            outcome: patch.outcome,
            ...(patch.stage === undefined ? {} : { stage: patch.stage }),
            ...(patch.actual === undefined ? {} : { actual: patch.actual }),
            detailCode,
          } : component;
        }),
    };
    const outcome = aggregateResult(updated);
    if (outcome) updated.result = outcome;
    this.writeJob(updated);
    return { ok: true, job: updated };
  }

  /**
   * Record the apply acceptance durably, independently idempotent.
   *
   * A client that lost the response to `apply` retries with the same key and gets
   * the same answer, and the host finishes the committed component whether or not
   * that client ever comes back.
   */
  acceptApply(jobId: string, principal: UpdatePrincipalRef): ApplyAcceptance {
    const read = this.readJob(jobId);
    if (!read.ok) return { status: 'not-found' };
    if (!this.mayAct(jobId, principal)) return { status: 'forbidden' };
    const job = read.value;
    if (job.applyAcceptedAt !== undefined) return { status: 'existing', job };
    if (job.phase !== 'ready') return { status: 'not-ready', phase: job.phase };
    const now = this.now().toISOString();
    const updated: UpdateJob = {
      ...job,
      applyAcceptedAt: now,
      sequence: job.sequence + 1,
      updatedAt: now,
      events: [...job.events, { at: now, phase: 'ready', detailCode: 'apply-accepted' }],
    };
    this.writeJob(updated);
    return { status: 'accepted', job: updated };
  }

  /**
   * Cancel before commit, or stop remaining steps after a safe boundary.
   *
   * An accepted apply is never reversed here: the host has possibly already moved
   * bytes, and pretending a cancellation unwinds that is worse than reporting that
   * it did not.
   */
  cancel(jobId: string, principal: UpdatePrincipalRef): { ok: boolean; job?: UpdateJob; reason?: string } {
    const read = this.readJob(jobId);
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!this.mayAct(jobId, principal)) return { ok: false, job: read.value, reason: 'forbidden' };
    const job = read.value;
    if (isUpdateJobTerminal(job.phase)) return { ok: false, job, reason: 'already-finished' };
    if (job.applyAcceptedAt !== undefined && job.phase !== 'ready') {
      return { ok: false, job, reason: 'already-committing' };
    }
    const transitioned = this.transition(jobId, principal, 'cancelled', 'cancelled-by-request');
    return transitioned.ok
      ? { ok: true, job: transitioned.job }
      : { ok: false, job, reason: transitioned.reason };
  }

  /** Newest first, finished jobs bounded, anything still recoverable always kept. */
  listJobs(): UpdateJob[] {
    const jobs: UpdateJob[] = [];
    for (const name of this.jobFiles()) {
      const read = parseRecord<UpdateJob>(join(this.root, JOBS, name));
      if (read.ok) jobs.push(read.value);
    }
    return jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * The operation already owning these components on this installation.
   *
   * Scoped by installation as well as component: a record left behind by a
   * superseded installation identity must not block this host's updates forever,
   * while two callers on the same installation can never both own the same swap.
   */
  activeJobFor(components: readonly UpdateComponent[], installationId?: string): UpdateJob | undefined {
    return this.listJobs().find((job) => !isUpdateJobTerminal(job.phase)
      && (installationId === undefined || job.installationId === installationId)
      && job.components.some((component) => components.includes(component.component)));
  }

  /**
   * Drop old finished jobs, keeping every one a restart might still have to finish.
   *
   * Staging and history both need a ceiling, but a job whose components disagree
   * about their outcome is the record of a half-applied update: deleting it to save
   * a few kilobytes would remove the only evidence of what is actually installed.
   */
  prune(): { removed: string[]; retained: string[] } {
    const jobs = this.listJobs();
    const finished = jobs.filter((job) => isUpdateJobTerminal(job.phase) && job.result !== 'partial');
    const removed: string[] = [];
    const retained: string[] = [];
    for (const [index, job] of finished.entries()) {
      if (index >= this.retainFinished) {
        rmSync(this.jobPath(job.jobId), { force: true });
        rmSync(this.authorityPath(job.jobId), { force: true });
        removed.push(job.jobId);
      } else retained.push(job.jobId);
    }
    for (const job of jobs) if (!finished.includes(job)) retained.push(job.jobId);
    return { removed, retained };
  }

  /**
   * What the host should do with jobs on startup.
   *
   * A lease alone never justifies touching files; it only says somebody meant to.
   * Anything past the point of no return is handed back as needing attention with
   * its last durable observation intact.
   */
  recoverInterrupted(): Array<{ job: UpdateJob; action: 'resume-preparation' | 'finish-committed' | 'needs-attention' }> {
    return this.listJobs().filter((job) => !isUpdateJobTerminal(job.phase)).map((job) => ({
      job,
      action: job.phase === 'accepted' || job.phase === 'preparing'
        ? 'resume-preparation' as const
        : job.applyAcceptedAt !== undefined
          ? 'finish-committed' as const
          : 'needs-attention' as const,
    }));
  }

  private readIdempotency(
    principal: UpdatePrincipalRef,
    installationId: string,
    key: string,
  ): IdempotencyRecord | undefined {
    const path = this.idempotencyPath(principal, installationId, key);
    if (!existsSync(path)) return undefined;
    const read = parseRecord<IdempotencyRecord>(path);
    return read.ok ? read.value : undefined;
  }

  private idempotencyPath(principal: UpdatePrincipalRef, installationId: string, key: string): string {
    return join(this.root, KEYS, idempotencyKey(principal, installationId, key));
  }

  private authorityPath(jobId: string): string {
    return join(this.root, AUTHORITY, `${safeSegment(jobId)}.json`);
  }

  private writeAuthority(jobId: string, principal: UpdatePrincipalRef, createdAt: string): void {
    const record: JobAuthorityRecord = {
      schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
      jobId,
      principal,
      createdAt,
    };
    atomicWriteJsonOwnerOnly(this.authorityPath(jobId), record);
  }

  /**
   * Whether this principal may mutate the job.
   *
   * Three cases, and the difference between them is the point:
   *
   *   - the host always may, because it is the only thing that can settle a job whose
   *     caller went away;
   *   - the owner credential may, because it already owns the grant store, the state
   *     directory, and the terminal that could stop this service anyway -- and the job read
   *     path is fenced the same way, so an owner who can see a job can also stop it;
   *   - anybody else has to match the record written when the job was created. A second
   *     device holding the same update grant is not a second owner: it never saw the
   *     review, so it gets neither the commit nor the cancellation.
   *
   * A missing or unreadable record belongs to nobody but the two above, not to everybody.
   */
  private mayAct(jobId: string, principal: UpdatePrincipalRef | 'host'): boolean {
    if (principal === 'host' || principal.kind === 'owner') return true;
    const read = parseRecord<JobAuthorityRecord>(this.authorityPath(jobId));
    if (!read.ok) return false;
    return read.value.jobId === jobId
      && read.value.principal?.kind === principal.kind
      && read.value.principal.id === principal.id;
  }

  private jobFiles(): string[] {
    try {
      return readdirSync(join(this.root, JOBS)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
  }

  private planPath(planId: string): string {
    return join(this.root, PLANS, `${safeSegment(planId)}.json`);
  }

  private jobPath(jobId: string): string {
    return join(this.root, JOBS, `${safeSegment(jobId)}.json`);
  }

  private writeJob(job: UpdateJob): void {
    atomicWriteJsonOwnerOnly(this.jobPath(job.jobId), job);
  }
}

/** Only the characters a caller supplied may reach a filename. */
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(value)) throw new Error('update-record-id-invalid');
  return value;
}

function planFingerprint(plan: UpdatePlan): string {
  return stableFingerprint({
    releaseId: plan.releaseId,
    order: plan.order,
    components: plan.components.map((component) => [component.component, component.from.version ?? '', component.to.version ?? '']),
  });
}

const LEGAL_TRANSITIONS: Record<UpdateJobPhase, readonly UpdateJobPhase[]> = {
  accepted: ['preparing', 'cancelled', 'failed'],
  preparing: ['ready', 'cancelled', 'failed'],
  ready: ['applying', 'preparing', 'cancelled', 'failed', 'needs_attention'],
  applying: ['verifying', 'failed', 'needs_attention', 'rolled_back'],
  verifying: ['succeeded', 'needs_attention', 'rolled_back', 'failed'],
  succeeded: [],
  failed: [],
  rolled_back: [],
  needs_attention: [],
  cancelled: [],
};

/** `partial` is an aggregate of components that ended differently, never a host phase. */
function aggregateResult(job: UpdateJob): UpdateJob['result'] {
  if (job.phase === 'succeeded') return 'complete';
  if (job.phase === 'cancelled') return 'cancelled';
  if (job.phase === 'needs_attention') return 'needs-attention';
  if (job.phase === 'failed' || job.phase === 'rolled_back') {
    return job.components.some((component) => component.outcome === 'verified'
      || component.outcome === 'committed'
      || component.outcome === 'current') ? 'partial' : 'failed';
  }
  return undefined;
}
