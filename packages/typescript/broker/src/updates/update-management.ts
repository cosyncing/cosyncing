/**
 * The update-management surface: what is installed, what the signed channel offers,
 * what this caller may commit, and the durable record of what happened.
 *
 * Deliberately separate from `release-upgrade.ts`, which is the installer, and from
 * the HTTP layer, which is transport. Everything here is a function of injected
 * observations, one authenticated caller, and the channel, so the authority and
 * staleness rules can be proven against the same fake feed the planner tests use
 * instead of against a live release.
 *
 * Three rules this module's shape exists to enforce:
 *
 *   1. Discovery resolves the mutable pointer; planning and applying never do. A plan
 *      pins the immutable identity of the release it was built from, and every later
 *      step re-authenticates the channel and requires that same identity. A promotion
 *      between review and apply is therefore a typed conflict, never a newer target.
 *   2. A job is durable before it is visible. Nothing here reports progress that is
 *      not already on disk in an owner-only record.
 *   3. Authority is per operation, not per connection. Peer mutations need the narrow
 *      `broker:update` grant, and an unreadable grant store is never a grant.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATE_ACKNOWLEDGEMENTS,
  UPDATE_COMPONENTS,
  UPDATE_JOB_SCHEMA_VERSION,
  UPDATE_MANAGEMENT_CONTRACT_VERSION,
  type UpdateAcknowledgement,
  type UpdateApplyRequest,
  type UpdateBlocker,
  type UpdateBusyState,
  type UpdateBuildIdentity,
  type UpdateCheckResponse,
  type UpdateComponent,
  type UpdateContractAdvert,
  type UpdateErrorCode,
  type UpdateHistoryEntry,
  type UpdateInventory,
  type UpdateJob,
  type UpdateJobSubmission,
  type UpdatePlan,
  type UpdatePlanRequest,
} from '@cosyncing/protocol';
import type { BuildInfo } from '../runtime/build-info.ts';
import type { UpdateGrantStore } from '../security/update-grants.ts';
import type { BrokerUpdateLaunchDecision } from './broker-update.ts';
import { randomBytes } from 'node:crypto';
import {
  checkReleaseUpdate,
  MAX_RELEASE_MANIFEST_BYTES,
  releaseIdCommit,
  releaseIdFromManifest,
  releaseIdVersion,
  verifyUpgradeCandidate,
  type ReleaseUpdateCheckResult,
  type UpgradeCandidate,
} from './release-upgrade.ts';
import { parseReleaseUpdaterMetadata, type ReleaseUpdaterBlock } from './updater-metadata.ts';
import {
  planUpdates,
  updatePlanIsExecutable,
  type InstalledComponentState,
  type PinnedRelease,
  type PlanCaller,
  type PlanRequest,
  type SavedServerObservation,
} from './update-planner.ts';
import type { StoredUpdatePlan, UpdateOperationStore, UpdatePrincipalRef } from './update-operation-store.ts';
import { stageUpgradeArtifacts } from './prepared-upgrade.ts';

/** The authenticated caller, reduced to what the update surface needs. Never a credential. */
export type UpdateManagementCaller = {
  kind: PlanCaller['kind'];
  /** Owner identity or peer id. */
  id: string;
  updateGranted: boolean;
};

export type UpdateManagementError = { ok: false; code: UpdateErrorCode; detail: string; jobId?: string };
export type UpdateManagementResult<T> = { ok: true; value: T } | UpdateManagementError;

export function updatePrincipalFor(caller: UpdateManagementCaller): UpdatePrincipalRef {
  return caller.kind === 'remote-peer'
    ? { kind: 'peer', id: caller.id }
    : { kind: 'owner', id: caller.id };
}

/**
 * The immutable handle for a verified manifest, computed where the manifest is verified.
 *
 * Re-exported because the surface's callers pin the same identity the installer honours: the
 * handoff carries this string to `upgrade --release`, and a pin that meant one thing where it
 * was written and another where it is honoured is worse than no pin at all.
 */
export { releaseIdFromManifest };

// The two halves of a pinned release identity, read where the format itself is defined and handed
// on from here, so the surface, the settle, and the delegated launcher all read one identity the
// same way and cannot drift into two formats.
export { releaseIdCommit, releaseIdVersion };

/**
 * How long a delegated commit may stay unconfirmed.
 *
 * The host updater runs outside this process, so a commit that never lands leaves a job
 * waiting for a restart that is never coming. Past this deadline, with the pinned build
 * still not answering, the honest reading is that the update failed: the record settles,
 * keeps its evidence, and stops holding the component hostage against the next attempt.
 */
export const UPDATE_HANDOFF_LEASE_MS = 30 * 60 * 1000;

/** Which installation this process is standing on: which machine, and which setup of it. */
export interface UpdateInstallationRef {
  installationId: string;
  installationGeneration: number;
}

export interface UpdateManagementDependencies {
  /**
   * Which installation this process is standing on, answered when asked rather than at startup.
   *
   * A snapshot goes quietly wrong. setup commits the installation, and a broker that launchd
   * started while setup was still running, or that simply outlived a re-run of it, would spend
   * its whole life grading new reviews, jobs, and supersessions against an installation that no
   * longer exists -- and would keep saying so until it was restarted. A real host reads its
   * install receipt here, which is also what lets a test change the receipt under a live host
   * instead of rebuilding the host and proving nothing.
   */
  installation(): UpdateInstallationRef;
  buildInfo: BuildInfo;
  store: UpdateOperationStore;
  grants: UpdateGrantStore;
  /** What is actually on this host, re-read on demand rather than cached. */
  observe(): { broker: InstalledComponentState; client?: InstalledComponentState };
  /** Running turns, launches, and approvals, so a restart has to be acknowledged. */
  busy(): UpdateBusyState;
  channel: {
    manifestUrl?: string;
    trustedKeys: Readonly<Record<string, string>>;
    fetch?: typeof fetch;
  };
  /** Where prepared artifacts are staged: under the state home, never inside a replaced directory. */
  stagingRoot: string;
  /**
   * Hand the pinned broker commit to this host's own updater. Absent: this host cannot commit one.
   *
   * `mayLaunch` is the authority answer for the caller who is committing, and it is worth the one
   * launch that asks for it: the answer is read when asked, and asking twice is a refusal, so an
   * approval cannot be taken early and spent late. A handoff that reports an updater it scheduled
   * without asking, or after being told no, is not believed: the job records that the commit was
   * never authorised at the moment it was made.
   */
  handoff?: (job: UpdateJob, mayLaunch: () => BrokerUpdateLaunchDecision) => Promise<{ accepted: boolean; detailCode: string }>;
  /**
   * What this host's installer can prove, from durable state, about a commit it delegated.
   *
   * The candidate answers before the installer has finished with it. `upgrade` starts the new
   * build, proves the broker and the web root healthy, and only then commits its receipts and
   * removes its journal; until that moment the whole transaction can still be rolled back and
   * the previous build put answering again. So "the pinned build is up" proves a start and not
   * a completion, and this is the only witness that says the bytes a job prepared are the bytes
   * this installation now runs. Absent means there is nothing to ask, which is never a commit.
   */
  installerCommit?: (job: UpdateJob) => InstallerCommitProof;
  environment?: () => PlanRequest['environment'];
  otherServers?: () => readonly SavedServerObservation[];
  now?: () => Date;
  newId?: (prefix: string) => string;
}

interface ChannelReading {
  check: ReleaseUpdateCheckResult;
  candidate?: UpgradeCandidate;
  releaseId?: string;
  updater?: ReleaseUpdaterBlock;
}

/**
 * Whether this host's installer finished the transaction that replaces it.
 *
 * Kept as an answer rather than a file format because the answer is what the job needs and the
 * files belong to the installer: a real host reads its upgrade journal and its install receipt,
 * and a host that has no installer to ask reports `committed: false` with the reason. The reason
 * travels too, because a job that never closed has to be explained from history rather than from
 * whatever the operator can reconstruct.
 */
export type InstallerCommitProof =
  | { committed: true }
  | { committed: false; reason: InstallerCommitReason };

/** Why an installer cannot vouch for a commit, in the three shapes a host can actually tell apart. */
export type InstallerCommitReason =
  /** The transaction is open: not committed, not rolled back, still the installer's to finish. */
  | 'in-flight'
  /** The installation names bytes other than the ones this job prepared and delegated. */
  | 'installed-bytes-differ'
  /** Nothing on this host says either way. */
  | 'unrecorded';

function failure(code: UpdateErrorCode, detail: string, jobId?: string): UpdateManagementError {
  return { ok: false, code, detail, ...(jobId === undefined ? {} : { jobId }) };
}

function clock(dependencies: UpdateManagementDependencies): () => Date {
  return dependencies.now ?? (() => new Date());
}

function contractAdvert(buildInfo: BuildInfo): UpdateContractAdvert | undefined {
  const contract = buildInfo.contract as unknown as Record<string, unknown>;
  if (typeof contract.revision !== 'number' || typeof contract.minimumClientRevision !== 'number') return undefined;
  return {
    revision: contract.revision,
    minimumPeerRevision: contract.minimumClientRevision,
    ...(typeof contract.surfaceHash === 'string' ? { surfaceHash: contract.surfaceHash } : {}),
  };
}

/** Bounded fetch. The cap is a refusal, not a warning: an over-long body is never buffered. */
async function fetchBounded(dependencies: UpdateManagementDependencies, url: string, maximum: number): Promise<Uint8Array> {
  const fetchImpl = dependencies.channel.fetch ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`release-artifact-unavailable-${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximum) throw new Error('release-artifact-too-large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error('release-artifact-too-large');
  return bytes;
}

/**
 * Read the mutable channel once and derive the immutable identity from what was signed.
 *
 * Nothing downstream parses manifest bytes: the signature is verified here, before any
 * field is read, and what leaves this function is either a verified candidate or an
 * honest `unknown` with the reason.
 */
async function readChannel(dependencies: UpdateManagementDependencies): Promise<ChannelReading> {
  const check = await checkReleaseUpdate({
    buildInfo: dependencies.buildInfo,
    ...(dependencies.channel.manifestUrl === undefined ? {} : { manifestUrl: dependencies.channel.manifestUrl }),
    trustedKeys: dependencies.channel.trustedKeys,
    ...(dependencies.channel.fetch === undefined ? {} : { fetch: dependencies.channel.fetch }),
    now: clock(dependencies),
  });
  if (check.status !== 'update-available') return { check };
  const url = dependencies.channel.manifestUrl;
  if (!url) return { check };
  try {
    const bytes = await fetchBounded(dependencies, url, MAX_RELEASE_MANIFEST_BYTES);
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const candidate = verifyUpgradeCandidate({
      value,
      buildInfo: dependencies.buildInfo,
      trustedKeys: dependencies.channel.trustedKeys,
    });
    return {
      check,
      candidate,
      releaseId: releaseIdFromManifest(candidate.manifest),
      ...(candidate.manifest.updater === undefined ? {} : { updater: parseReleaseUpdaterMetadata(candidate.manifest.updater) }),
    };
  } catch (error) {
    return {
      check: {
        ...check,
        status: 'unknown',
        detailCode: error instanceof Error ? error.message : 'release-manifest-invalid',
      },
    };
  }
}

function pinnedFrom(candidate: UpgradeCandidate, releaseId: string, updater?: ReleaseUpdaterBlock): PinnedRelease {
  return {
    releaseId,
    version: candidate.manifest.version,
    ...(candidate.manifest.contract === undefined ? {} : { brokerContract: candidate.manifest.contract }),
    ...(updater === undefined ? {} : { updater }),
    downloadBytes: { broker: candidate.size },
    webSidecarIncluded: candidate.manifest.webApp !== undefined,
  };
}

/** The channel's state as the inventory reports it: checked, with whatever it is holding. */
export interface ChannelObservation {
  status: 'current' | 'update-available' | 'unknown';
  detailCode: string;
  checkedAt: string;
  available?: { version: string; releaseId?: string };
}

function observationFrom(reading: ChannelReading): ChannelObservation {
  const available = reading.candidate && reading.releaseId
    ? { version: reading.candidate.manifest.version, releaseId: reading.releaseId }
    : undefined;
  return {
    status: available ? 'update-available' : reading.check.status,
    detailCode: reading.check.detailCode,
    checkedAt: reading.check.checkedAt,
    ...(available === undefined ? {} : { available }),
  };
}

/**
 * Sanitized per-component inventory.
 *
 * Safe to hand a peer that has never been granted anything: versions, ownership,
 * capability, and typed reasons, with no paths, URLs, or command lines.
 */
export function updateInventory(
  dependencies: UpdateManagementDependencies,
  channel?: ChannelObservation,
): UpdateInventory {
  const observed = dependencies.observe();
  const running = dependencies.buildInfo.version;
  // One reading of the installation, so the inventory an operator is shown describes one instant
  // rather than whichever receipt each line happened to find.
  const installation = dependencies.installation();
  const active = (component: UpdateComponent): UpdateJob | undefined =>
    dependencies.store.activeJobFor([component], installation.installationId);
  const ownershipProven = observed.broker.ownership === 'cosyncing-installer';
  const components = [observed.broker, ...(observed.client === undefined ? [] : [observed.client])].map((state) => {
    const job = active(state.component);
    const blockers: UpdateBlocker[] = [];
    if (state.ownership === 'unknown') {
      blockers.push({
        code: 'ownership-unproven',
        detail: 'Installation ownership could not be proven, so nothing here is safe to replace.',
        component: state.component,
        guidance: 'Re-run the installer once to record an owned installation.',
      });
    }
    if (state.ownership === 'package-manager') {
      blockers.push({ code: 'package-manager-owned', component: state.component,
        detail: 'This installation is owned by its package manager and cannot be replaced from the app.',
        guidance: 'Migrate through the signed installer before using in-app installation.' });
    }
    if (state.component === 'broker' && dependencies.handoff === undefined) {
      blockers.push({ code: 'unsupported-platform', component: 'broker',
        detail: 'This service has no qualified independent in-app update runner.',
        guidance: 'Use the signed installer or cosy update on this server.' });
    }
    if (state.component === 'client') {
      // The local helper is a separate same-user surface. This remote server
      // API must never claim authority to close a desktop on its host.
      blockers.push({
        code: 'desktop-out-of-scope',
        detail: 'A server update cannot close or replace the desktop app installed on this host.',
        component: 'client',
        guidance: 'Open Settings → Updates in that desktop app to use its own local update helper.',
      });
    }
    const isAvailable = state.component === 'broker' && channel?.available !== undefined && channel.available.version !== running;
    return {
      component: state.component,
      platform: state.platform,
      arch: state.arch,
      ownership: state.ownership,
      running: state.running,
      ...(state.installed === undefined ? {} : { installed: state.installed }),
      ...(state.contract === undefined ? {} : { contract: state.contract }),
      updateManagementVersion: UPDATE_MANAGEMENT_CONTRACT_VERSION,
      ...(isAvailable && channel?.available ? { available: channel.available } : {}),
      ...(channel === undefined ? {} : { lastChannelCheckAt: channel.checkedAt }),
      requiresRestart: isAvailable,
      canCheck: true,
      canPlan: ownershipProven && dependencies.buildInfo.packaged && state.component === 'broker',
      canApply: ownershipProven && dependencies.buildInfo.packaged && state.component === 'broker' && dependencies.handoff !== undefined,
      canCancel: job !== undefined,
      blockers,
      ...(job === undefined ? {} : { activeJobId: job.jobId }),
    };
  });
  return {
    schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
    installationId: installation.installationId,
    installationGeneration: installation.installationGeneration,
    updateManagementVersion: UPDATE_MANAGEMENT_CONTRACT_VERSION,
    components,
    busy: dependencies.busy(),
    checkedAt: clock(dependencies)().toISOString(),
  };
}

/** What the signed channel offers per component, without deciding anything. */
export async function updateCheck(dependencies: UpdateManagementDependencies): Promise<UpdateCheckResponse> {
  const reading = await readChannel(dependencies);
  const observation = observationFrom(reading);
  const inventory = updateInventory(dependencies, observation);
  return {
    schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
    status: observation.status,
    detailCode: observation.detailCode,
    components: inventory.components.map((component) => ({
      component: component.component,
      running: component.running,
      ...(component.available === undefined ? {} : { available: component.available }),
      releaseCheckedAt: observation.checkedAt,
    })),
  };
}

/**
 * The caller's authority as this host records it at the moment a decision is made.
 *
 * The transport authenticates a request once, and everything between that and a commit waits
 * on the network: a channel read, a staged download, a re-plan. A peer's update grant is a
 * revocable record on disk, so a snapshot taken at the door keeps honouring an authority the
 * owner has since withdrawn. Peers are therefore re-read here, and an unreadable grant store
 * is not a grant. An owner's authority comes from owning this broker, not from a record that
 * can be withdrawn, so it is not re-read.
 */
function authorityNow(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
): UpdateManagementCaller {
  if (caller.kind !== 'remote-peer') return caller;
  return { ...caller, updateGranted: dependencies.grants.mayUpdate(caller.id) };
}

/** The one authority answer a delegated launch is allowed to rely on, and whether it was used. */
export interface LaunchAuthority {
  /**
   * Ask at the moment of the launch. Allowed at most once, for a caller who still holds the grant
   * on an installation this process is still standing on.
   */
  mayLaunch(): BrokerUpdateLaunchDecision;
  /** Whether the updater ever asked. */
  readonly asked: boolean;
  /** Whether the ask, whenever it happened, was answered yes. */
  readonly granted: boolean;
  readonly refusal: Extract<BrokerUpdateLaunchDecision, { allowed: false }> | undefined;
}

/**
 * The commit boundary the updater actually stands on.
 *
 * Every authority check before this one is an early no, and cannot be anything else: between
 * "commit accepted" and the transient unit being scheduled, the host's own handoff re-reads the
 * release channel, and a grant withdrawn during that wait is withdrawn. So the answer that
 * matters is the one read at the launch itself, which is why the handoff is handed this rather
 * than a boolean.
 *
 * Two rules keep it from being moved earlier by whoever uses it. It answers for the caller who
 * is committing, read from the grant store and the install receipt as they are at the ask, so an
 * answer taken before a wait is stale by construction. And it answers once: a second ask is a
 * refusal, so holding a yes in reserve and spending it later is not available.
 */
function launchAuthority(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  job: UpdateJob,
): LaunchAuthority {
  let asked = false;
  let granted = false;
  let spent = false;
  let refusal: LaunchAuthority['refusal'];
  return {
    mayLaunch() {
      if (spent) return { allowed: false, detailCode: 'launch-authority-consumed' };
      spent = true;
      asked = true;
      if (installationSuperseded(dependencies, job)) {
        refusal = { allowed: false, detailCode: 'installation-superseded' };
      } else if (!authorityNow(dependencies, caller).updateGranted) {
        refusal = { allowed: false, detailCode: 'grant-revoked' };
      }
      if (refusal) return refusal;
      granted = true;
      return { allowed: true };
    },
    get asked() {
      return asked;
    },
    get granted() {
      return granted;
    },
    get refusal() {
      return refusal;
    },
  };
}

/**
 * What the planner is handed for one pinned release, from observations taken right now.
 *
 * Reviewing and re-checking share this so the second reading cannot quietly differ from the
 * first in what it looks at: same installed components, same environment, same release.
 */
function plannerRequest(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  review: {
    components: readonly UpdateComponent[];
    acknowledgements?: readonly UpdateAcknowledgement[];
    clientContract?: UpdateContractAdvert;
  },
  reading: ChannelReading,
  nowMs: number,
): PlanRequest {
  const candidate = reading.candidate!;
  const installation = dependencies.installation();
  return {
    nowMs,
    // Distinct by construction. A content hash of the millisecond, the release, and the
    // components gave two reviews made in the same millisecond the same id, however different
    // they were -- different caller, different acknowledgements, different client contract --
    // and the second write then overwrote the consent record the first one is redeemed against.
    // Entropy, not content, is what makes two reviews two reviews.
    planId: dependencies.newId === undefined
      ? () => `plan-${nowMs.toString(36)}-${randomBytes(8).toString('hex')}`
      : () => dependencies.newId!.call(dependencies, 'plan'),
    installationId: installation.installationId,
    installationGeneration: installation.installationGeneration,
    // Re-read at the moment of decision, not carried in from the request: see `authorityNow`.
    caller: { kind: caller.kind, updateGranted: authorityNow(dependencies, caller).updateGranted },
    requested: review.components,
    installed: dependencies.observe(),
    release: pinnedFrom(candidate, reading.releaseId!, reading.updater),
    ...(review.acknowledgements === undefined || review.acknowledgements.length === 0
      ? {}
      : { acknowledgements: review.acknowledgements }),
    ...(review.clientContract === undefined ? {} : { clientContract: review.clientContract }),
    ...(dependencies.otherServers === undefined ? {} : { otherServers: dependencies.otherServers() }),
    ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment() }),
  };
}

/**
 * Why a plan cannot run as reviewed, in the shape the surface answers with.
 *
 * Consent and capability are different answers and a caller has to be able to tell them
 * apart: one is a prompt the user has to answer, the other is a fact about this host that
 * no prompt can fix.
 */
function planRefusal(plan: UpdatePlan): UpdateManagementError | undefined {
  if (updatePlanIsExecutable(plan)) return undefined;
  const codes = plan.blockers.map((blocker) => blocker.code);
  if (codes.includes('permission-required') || codes.includes('grant-revoked')) {
    return failure('UPDATE_PERMISSION_REQUIRED', 'This caller is not allowed to install updates on this server.');
  }
  if (plan.blockers.length > 0) {
    return failure('UPDATE_CAPABILITY_UNSUPPORTED', `This host cannot run the reviewed plan (${codes.join(', ')}).`);
  }
  if (plan.outstandingAcknowledgements.length > 0) {
    return failure('UPDATE_ACKNOWLEDGEMENT_REQUIRED',
      `The reviewed plan still needs an acknowledgement: ${plan.outstandingAcknowledgements.join(', ')}.`);
  }
  return failure('UPDATE_PLAN_INVALID', 'The reviewed plan describes no work this host can do.');
}

/**
 * Why a channel reading that verified nothing cannot be used to re-authenticate a review.
 *
 * The distinction this exists to keep honest is between "checked, and clean" and "could not
 * check". A reading with no verified release identity carries no observations to re-plan
 * against, so treating its silence as assent would let an outage, a withdrawn signing key, or
 * a manifest this build cannot read stand in for the check that a commit is required to pass.
 */
function unreadableChannel(reading: ChannelReading): UpdateManagementError | undefined {
  if (reading.candidate !== undefined && reading.releaseId !== undefined) return undefined;
  return failure('UPDATE_CAPABILITY_UNSUPPORTED',
    `The signed release channel could not be re-read (${reading.check.detailCode}), so the reviewed plan could not be re-authenticated.`);
}

/**
 * Re-run a stored review against this host as it is now.
 *
 * A plan is a statement about a moment: what was installed, what the channel served, what
 * the caller consented to. Only the pinned release and the consent actually given are
 * trusted from the record, so a server that started working, an ownership answer that
 * stopped being provable, or a withdrawn grant refuses the commit instead of being
 * discovered by a restarted server that cannot be talked to.
 *
 * The re-run either happens or is refused. Callers on the way to a commit must not read
 * `undefined` from a channel that served nothing, which is why that answer is typed rather
 * than absent.
 */
async function reviewedPlanRefusal(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  record: StoredUpdatePlan,
  reading?: ChannelReading,
): Promise<UpdateManagementError | undefined> {
  const channel = reading ?? await readChannel(dependencies);
  const unreadable = unreadableChannel(channel);
  if (unreadable) return unreadable;
  // A channel that moved to a different verified release belongs to the pinned-release check,
  // which names the release that actually appeared. Repeating it here would bury that answer
  // in a generic one; both callers run that check first.
  if (channel.releaseId !== record.plan.releaseId) return undefined;
  const given = record.acknowledged
    ?? record.plan.requiredAcknowledgements.filter((ack) => !record.plan.outstandingAcknowledgements.includes(ack));
  // What was asked for, not what survived: a plan whose component was refused would
  // otherwise be re-checked as an empty operation and come back looking executable.
  const requested = record.requested ?? record.plan.components.map((component) => component.component);
  const fresh = planUpdates(plannerRequest(dependencies, caller, {
    components: requested,
    ...(given.length === 0 ? {} : { acknowledgements: given }),
    ...(record.clientContract === undefined ? {} : { clientContract: record.clientContract }),
  }, channel, clock(dependencies)().getTime()));
  return planRefusal(fresh);
}

/**
 * Review the work without committing any of it.
 *
 * A plan is returned even when it is not executable, because the blockers and the
 * missing acknowledgements ARE the answer; a 4xx would throw the explanation away.
 */
export async function createUpdatePlan(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  request: UpdatePlanRequest,
): Promise<UpdateManagementResult<UpdatePlan>> {
  const reading = await readChannel(dependencies);
  const { candidate, releaseId } = reading;
  if (!candidate || !releaseId) {
    return failure('UPDATE_CAPABILITY_UNSUPPORTED', reading.check.detailCode);
  }
  // The review binds an immutable release, so a moved channel is a conflict and never
  // a substitution of something newer that nobody consented to.
  if (request.releaseId !== releaseId) {
    return failure('UPDATE_TARGET_MOVED', `The channel now serves ${releaseId}; the reviewed ${request.releaseId} was not planned.`);
  }
  const expected = request.expected;
  if (!sameBuild(expected, dependencies.buildInfo)) {
    return failure('UPDATE_TARGET_MOVED', 'This host is no longer the installation the review was built against.');
  }
  const now = clock(dependencies)();
  const plan = planUpdates(plannerRequest(dependencies, caller, {
    components: request.components,
    ...(request.acknowledgements === undefined
      ? {}
      : { acknowledgements: request.acknowledgements as readonly UpdateAcknowledgement[] }),
    ...(request.clientContract === undefined ? {} : { clientContract: request.clientContract }),
  }, reading, now.getTime()));
  // Consent travels with the review it was given for, and the caller's own contract travels
  // with it: both are needed to re-check this plan when the job is committed, and neither is
  // something this host can reconstruct afterwards.
  const written = dependencies.store.putPlan(plan, updatePrincipalFor(caller), {
    requested: request.components,
    ...(request.acknowledgements === undefined ? {} : { acknowledged: request.acknowledgements }),
    ...(request.clientContract === undefined ? {} : { clientContract: request.clientContract }),
  });
  // The id is minted here and nowhere else, so a record already sitting behind it means this
  // review would have overwritten somebody else's consent. Refusing costs one more review;
  // overwriting silently changes what a job another caller holds was agreed to.
  if (written.status === 'exists') {
    return failure('UPDATE_PLAN_INVALID', 'A review was already recorded under this plan id, so this one was not written. Start the review again.');
  }
  return { ok: true, value: plan };
}

/** The reviewed "expected" identity against what is actually running here. */
function sameBuild(expected: UpdateBuildIdentity | undefined, buildInfo: BuildInfo): boolean {
  if (!expected) return true;
  if (expected.version !== undefined && expected.version !== buildInfo.version) return false;
  if (expected.buildId !== undefined && expected.buildId !== buildInfo.commit) return false;
  return true;
}

/**
 * Create the preparation job for a reviewed plan, then prepare it.
 *
 * Preparation stops nothing. It pins, downloads, authenticates, and leaves the job at
 * `ready` until somebody says apply. A lost response returns the same job, not a
 * second operation.
 */
export async function createUpdateJob(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  request: UpdateJobSubmission,
): Promise<UpdateManagementResult<UpdateJob>> {
  const principal = updatePrincipalFor(caller);
  // One reading of the installation for the whole operation: an idempotent retry has to be
  // looked up, recorded, and redeemed against the same scope it was written under, and a commit
  // boundary re-reads for itself.
  const installation = dependencies.installation();
  // A delegated commit whose deadline has passed would otherwise be read as "somebody else
  // is updating this server" forever, including when the updater it handed work to simply
  // failed. Settling first means the answer describes this host, not a lost process.
  reconcileInterruptedUpdates(dependencies);
  // A retry of a submission this caller already made is answered before anything is
  // re-evaluated. Preparation may have finished while the answer was in flight, and the work
  // that answer set in motion is exactly what a fresh eligibility gate refuses: a caller that
  // was told "yes" and whose bytes are staged comes back to find itself told it never agreed
  // to restart the server. The key is scoped to this principal and this installation, so a hit
  // is the same question asked twice rather than a new one to be graded against new conditions.
  const prior = dependencies.store.lookupSubmission({
    planId: request.planId,
    idempotencyKey: request.idempotencyKey,
    principal,
    installationId: installation.installationId,
    installationGeneration: installation.installationGeneration,
  });
  if (prior.status === 'conflict') {
    return failure('UPDATE_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for different reviewed work.');
  }
  // `accepted` is the one phase that owes a caller more work rather than an answer: a job
  // written and then lost to a crash has nothing staged, and falling through resumes its
  // preparation instead of reporting an empty operation as progress.
  if (prior.status === 'found' && prior.job.phase !== 'accepted') return { ok: true, value: prior.job };
  // A blocked or unacknowledged review is a refusal, not a job. Checking before anything is
  // written means a plan the host could not have run never occupies the component it names,
  // which is what turns "the phone asked and nothing happened" into an answer the user can
  // act on. A plan this host cannot read at all falls through to the typed plan rejection.
  const reviewed = dependencies.store.readPlan(request.planId);
  if (reviewed.ok) {
    const refusal = await reviewedPlanRefusal(dependencies, caller, reviewed.value);
    if (refusal) return refusal;
  }
  const submission = dependencies.store.submitJob({
    planId: request.planId,
    idempotencyKey: request.idempotencyKey,
    principal,
    installationId: installation.installationId,
    installationGeneration: installation.installationGeneration,
    runner: 'broker-host',
  });
  if (submission.status === 'idempotency-conflict') {
    return failure('UPDATE_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for different reviewed work.');
  }
  if (submission.status === 'in-progress') {
    return failure('UPDATE_IN_PROGRESS', 'Another update already owns one of these components on this host.', submission.job.jobId);
  }
  if (submission.status === 'plan-rejected') {
    const code: UpdateErrorCode = submission.reason === 'expired' ? 'UPDATE_PLAN_EXPIRED'
      : submission.reason === 'unknown-schema' ? 'UPDATE_UNKNOWN_JOB_SCHEMA'
        : submission.reason === 'generation-mismatch' ? 'UPDATE_PLAN_STALE'
          : submission.reason === 'principal-mismatch' ? 'UPDATE_PERMISSION_REQUIRED'
            : 'UPDATE_PLAN_INVALID';
    return failure(code, `The reviewed plan could not start a job (${submission.reason}).`);
  }
  if (submission.job.phase !== 'accepted') return { ok: true, value: submission.job };

  const redeemed = dependencies.store.redeemPlan({
    planId: submission.job.planId,
    principal,
    installationId: installation.installationId,
    installationGeneration: installation.installationGeneration,
  });
  if (!redeemed.ok) return failure('UPDATE_PLAN_STALE', `The reviewed plan is no longer usable (${redeemed.reason}).`, submission.job.jobId);

  const preparing = dependencies.store.transition(submission.job.jobId, principal, 'preparing', 'preparation-started');
  if (!preparing.ok) return failure('UPDATE_JOB_NOT_FOUND', 'The job disappeared before preparation could begin.', submission.job.jobId);

  return prepareArtifacts(dependencies, redeemed.record.plan, preparing.job, principal);
}

/**
 * Download and authenticate the pinned broker artifact into staging.
 *
 * The digest is the signed manifest's own, so a moved, truncated, or swapped artifact
 * fails here instead of at the moment it is asked to replace a running service. The
 * channel is re-read because a job may sit between two process lifetimes, and the
 * pinned identity is required to still be the one that was reviewed.
 */
async function prepareArtifacts(
  dependencies: UpdateManagementDependencies,
  plan: UpdatePlan,
  job: UpdateJob,
  principal: UpdatePrincipalRef,
): Promise<UpdateManagementResult<UpdateJob>> {
  const broker = plan.components.find((component) => component.component === 'broker');
  if (!broker) {
    // Nothing to stage: a client-only operation is committed by this machine's own
    // updater, which this build cannot hand work to yet. Failing here is the honest
    // answer; leaving the job at `ready` would advertise a commit that cannot happen.
    dependencies.store.transition(job.jobId, principal, 'failed', 'client-handoff-unavailable',
      plan.components.map((component) => ({ component: component.component, outcome: 'needs_attention' as const })));
    return failure('UPDATE_CAPABILITY_UNSUPPORTED', 'This host cannot prepare a client-only update without its own updater.', job.jobId);
  }
  const reading = await readChannel(dependencies);
  if (reading.releaseId === undefined || reading.releaseId !== plan.releaseId) {
    const moved = reading.releaseId !== undefined && reading.releaseId !== plan.releaseId;
    dependencies.store.transition(job.jobId, principal, 'failed', moved ? 'release-target-moved' : 'release-channel-unavailable',
      [{ component: broker.component, outcome: 'failed', stage: 'discovering', actual: broker.from }]);
    return failure('UPDATE_TARGET_MOVED', moved
      ? `The channel now serves ${reading.releaseId}; the reviewed ${plan.releaseId} was not prepared.`
      : `The signed release channel is unavailable (${reading.check.detailCode}), so nothing was prepared.`, job.jobId);
  }
  const candidate = reading.candidate!;
  const staging = join(dependencies.stagingRoot, safeSegment(job.jobId));
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    await stageUpgradeArtifacts({
      stagingRoot: dependencies.stagingRoot,
      jobId: job.jobId,
      candidate,
      download: (url, maximum) => fetchBounded(dependencies, url, maximum),
    });
    const ready = dependencies.store.transition(job.jobId, 'host', 'ready', 'preparation-verified',
      [{ component: broker.component, outcome: 'prepared', stage: 'verifying', actual: broker.from }]);
    if (!ready.ok) return failure('UPDATE_JOB_NOT_FOUND', 'The prepared job could not be recorded.', job.jobId);
    return { ok: true, value: ready.job };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : 'release-artifact-unavailable';
    dependencies.store.transition(job.jobId, principal, 'failed', detail,
      [{ component: broker.component, outcome: 'failed', stage: 'downloading', actual: broker.from }]);
    return failure('UPDATE_CAPABILITY_UNSUPPORTED', `Preparation could not authenticate the pinned artifact (${detail}).`, job.jobId);
  }
}

/**
 * The digest preparation authenticated for this job, read back from where it put the bytes.
 *
 * Staging lives under the state home rather than inside a tree an update replaces, and a
 * finished job's staging is pruned while an open one's is kept. So this is what the installer
 * can be held to after a restart, when the only other witnesses are the build answering and
 * whatever the installation receipts name: two names for the same bytes, which is the pair
 * that says the commit a caller approved is the commit this machine is running.
 */
export function stagedPreparedDigest(
  stagingRoot: string,
  jobId: string,
  releaseId: string,
): string | undefined {
  try {
    const recorded: unknown = JSON.parse(readFileSync(join(stagingRoot, safeSegment(jobId), 'prepared.json'), 'utf8'));
    if (!recorded || typeof recorded !== 'object') return undefined;
    const value = recorded as { releaseId?: unknown; digest?: unknown };
    return value.releaseId === releaseId && typeof value.digest === 'string' ? value.digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Explicit, idempotent commit.
 *
 * Preparation is not consent, and a review is not a promise that this host still matches it.
 * Apply therefore re-runs the review inside the mutation window -- the channel, the stored
 * plan, the host's own state, and the caller's authority as of now -- and hands the pinned
 * commit to the host's updater only when every one of those answers came back. A check that
 * could not run is a refusal: the cost of a restart that did not happen is smaller than the
 * cost of one the user never agreed to.
 */
export async function applyUpdateJob(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  jobId: string,
  request: UpdateApplyRequest,
): Promise<UpdateManagementResult<UpdateJob>> {
  const principal = updatePrincipalFor(caller);
  const accepted = dependencies.store.acceptApply(jobId, principal);
  if (accepted.status === 'not-found') return failure('UPDATE_JOB_NOT_FOUND', 'No such update job on this host.');
  if (accepted.status === 'forbidden') return failure('UPDATE_PERMISSION_REQUIRED', 'This job belongs to a different principal.');
  if (accepted.status === 'not-ready') {
    return failure('UPDATE_IN_PROGRESS', `Apply is accepted only from ready; this job is ${accepted.phase}.`, jobId);
  }
  // A job reviewed against an installation this process is no longer standing on cannot be
  // honoured here. Re-running setup means the tree that was approved is gone, and committing
  // this job would replace a different installation than the one anybody consented to. Settling
  // the record at the same time is what stops a superseded job holding this host's broker
  // against every later attempt.
  if (installationSuperseded(dependencies, accepted.job)) {
    const settled = settleSupersededInstallation(dependencies, accepted.job);
    return failure('UPDATE_PLAN_STALE', settled === 'transition-refused'
      ? 'This host was set up again after this review, and the stale job could not be settled.'
      : 'This host was set up again after this review, so the installation this commit was reviewed against is gone.', jobId);
  }
  // Taking the phase is what makes a retry safe. A job that has already left `ready` has
  // had its commit delegated, so a second click, a re-sent request, or a client that never
  // saw the first answer gets the job it asked for instead of a second restart.
  // The delegation deadline starts with the phase that delegates: from here on this process
  // may be replaced at any moment, and the only record of "somebody was told to do this" has
  // to survive in the same write that says the commit was asked for.
  const applying = dependencies.store.transition(jobId, principal, 'applying', 'apply-requested', undefined, {
    identity: accepted.job.runner?.identity ?? 'broker-host',
    leaseExpiresAt: new Date(clock(dependencies)().getTime() + UPDATE_HANDOFF_LEASE_MS).toISOString(),
  });
  if (!applying.ok) {
    const current = dependencies.store.readJob(jobId);
    if (current.ok && current.value.applyAcceptedAt !== undefined && current.value.phase !== 'ready') {
      return { ok: true, value: current.value };
    }
    return failure('UPDATE_IN_PROGRESS', current.ok
      ? `The job is ${current.value.phase}; apply was not taken a second time.`
      : 'The job could not be read, so nothing was committed.', jobId);
  }
  const job = applying.job;

  const reading = await readChannel(dependencies);
  if (reading.releaseId !== undefined && reading.releaseId !== job.releaseId) {
    // The reviewed target is gone. Restarting this server onto something nobody reviewed is
    // not a smaller mistake than not restarting it, so the job ends and a fresh review begins.
    dependencies.store.transition(jobId, 'host', 'failed', 'release-target-moved');
    return failure('UPDATE_TARGET_MOVED', `The channel now serves ${reading.releaseId}; the reviewed ${job.releaseId} needs a fresh review.`, job.jobId);
  }
  // A channel that served nothing verified is not a channel that served the reviewed release.
  // Silence used to fall through both checks here -- no release id to compare, and so nothing
  // for the re-plan below to re-authenticate against -- which let a commit through on the
  // strength of a check that never ran.
  const unreadable = unreadableChannel(reading);
  if (unreadable) {
    dependencies.store.transition(jobId, 'host', 'failed', 'release-channel-unavailable');
    return { ...unreadable, jobId: job.jobId };
  }
  // Eligibility and consent are re-checked here, in the window between "commit accepted" and
  // anything being moved, against the host as it is now rather than as it was when the plan
  // was reviewed: work that started since, an ownership answer that stopped being provable,
  // a grant the owner withdrew, or an effect the user never agreed to all stop the commit
  // here. Refusing costs a restart that did not happen; committing without asking costs one
  // that the user cannot undo. A review this host cannot read is refused for the same reason:
  // the consent it documented is the thing being re-checked, and an unreadable record is not
  // evidence that it still stands.
  const reviewed = dependencies.store.readPlan(job.planId);
  if (!reviewed.ok) {
    dependencies.store.transition(jobId, 'host', 'failed',
      reviewed.reason === 'unknown-schema' ? 'plan-unknown-schema' : 'plan-unreadable');
    return reviewed.reason === 'unknown-schema'
      ? failure('UPDATE_UNKNOWN_JOB_SCHEMA', 'This review was written by a newer updater and was left exactly as it was.', job.jobId)
      : failure('UPDATE_PLAN_STALE', 'The reviewed plan could not be read, so the consent behind this commit could not be re-checked.', job.jobId);
  }
  const refusal = await reviewedPlanRefusal(dependencies, caller, reviewed.value, reading);
  if (refusal) {
    dependencies.store.transition(jobId, 'host', 'failed', 'plan-no-longer-executable');
    return { ...refusal, jobId: job.jobId };
  }
  // An early no, and only that: everything after this point can still wait, and the answer that
  // decides the commit is the one the updater itself is given. It is worth asking here because a
  // caller that has already been revoked should not have its job moved through the phases that
  // an honest refusal would have left alone.
  if (!authorityNow(dependencies, caller).updateGranted) {
    dependencies.store.transition(jobId, 'host', 'failed', 'grant-revoked');
    return failure('UPDATE_PERMISSION_REQUIRED', 'The update grant for this caller was withdrawn before the commit.', job.jobId);
  }
  if (!dependencies.handoff) {
    dependencies.store.transition(jobId, 'host', 'failed', 'update-handoff-unavailable');
    return failure('UPDATE_CAPABILITY_UNSUPPORTED', 'This host has no update handoff, so nothing was changed.', job.jobId);
  }
  const authority = launchAuthority(dependencies, caller, job);
  const handed = await dependencies.handoff(job, authority.mayLaunch);
  if (!handed.accepted) {
    dependencies.store.transition(jobId, 'host', 'failed', handed.detailCode);
    // A launcher that turned the commit down because the answer came back no is giving the same
    // answer the surface would have given, and the caller has to be able to tell that apart from
    // a host that cannot do the work at all.
    return handed.detailCode === 'grant-revoked' || handed.detailCode === 'broker-update-authority-withdrawn'
      ? failure('UPDATE_PERMISSION_REQUIRED', 'The update grant for this caller was withdrawn before the updater was scheduled.', job.jobId)
      : handed.detailCode === 'installation-superseded'
        ? failure('UPDATE_PLAN_STALE', 'This host was set up again while the commit was in flight, so nothing was replaced.', job.jobId)
        : failure('UPDATE_CAPABILITY_UNSUPPORTED', `This host's updater refused the commit (${handed.detailCode}).`, job.jobId);
  }
  // An accepted answer that never asked, or asked after the grant was gone, describes a launch
  // this surface did not authorise. It is still a launch: the transient unit is out of this
  // process's hands, and a record saying the update failed would be the less true of the two
  // answers. So the job goes to the delegated phase like any other, under a detail code that
  // says what actually happened, and the caller is told the truth about its own authority.
  if (!authority.granted) {
    dependencies.store.transition(jobId, 'host', 'verifying',
      authority.asked ? 'handoff-accepted-unauthorized' : 'handoff-accepted-unasked',
      job.components.map((component: UpdateJob['components'][number]) => ({
        component: component.component,
        outcome: 'committed' as const,
        stage: 'replacing' as const,
      })));
    // Two different faults, and a caller has to be able to tell them apart: one is about the
    // authority it was given, the other is this host failing to use it. Telling a caller that was
    // still granted that it is not granted sends it to re-ask somebody who never withdrew anything.
    return authority.refusal?.detailCode === 'installation-superseded'
      ? failure('UPDATE_PLAN_STALE', 'This host scheduled the updater after its installation changed.', job.jobId)
      : authority.asked
        ? failure('UPDATE_PERMISSION_REQUIRED', 'The update grant was already withdrawn when this host scheduled the updater.', job.jobId)
        : failure('UPDATE_CAPABILITY_UNSUPPORTED', 'This host scheduled an updater that never asked whether the commit was still authorised.', job.jobId);
  }
  // `verifying` is the delegated state: the commit is in the host updater's hands and the new
  // build has not answered yet. Startup reconciliation closes it against the version that does.
  const verifying = dependencies.store.transition(jobId, 'host', 'verifying', 'handoff-accepted',
    job.components.map((component: UpdateJob['components'][number]) => ({
      component: component.component,
      outcome: 'committed' as const,
      stage: 'replacing' as const,
    })));
  if (verifying.ok) return { ok: true, value: verifying.job };
  const read = dependencies.store.readJob(jobId);
  return read.ok ? { ok: true, value: read.value } : { ok: true, value: job };
}

/**
 * Job read, fenced to the principal that owns it.
 *
 * Reconciliation runs first because this is the record a caller watches while a delegated
 * update is out of this process's hands. A client polling it after the handoff deadline would
 * otherwise be shown `verifying` forever, on a host that can already prove the commit is not
 * coming: the updater that was told to make it is gone, and the process that would have
 * reported that is the one that failed.
 */
export function readUpdateJob(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  jobId: string,
): UpdateManagementResult<UpdateJob> {
  reconcileInterruptedUpdates(dependencies);
  const read = dependencies.store.readJob(jobId);
  if (!read.ok) {
    return read.reason === 'unknown-schema'
      ? failure('UPDATE_UNKNOWN_JOB_SCHEMA', 'This job was written by a newer updater and was left exactly as it was.')
      : failure('UPDATE_JOB_NOT_FOUND', 'No such update job on this host.');
  }
  if (caller.kind === 'remote-peer') {
    const plan = dependencies.store.readPlan(read.value.planId);
    if (!plan.ok || plan.value.principal.kind !== 'peer' || plan.value.principal.id !== caller.id) {
      return failure('UPDATE_PERMISSION_REQUIRED', 'This update job belongs to another principal.');
    }
  }
  return { ok: true, value: read.value };
}

export function cancelUpdateJob(
  dependencies: UpdateManagementDependencies,
  caller: UpdateManagementCaller,
  jobId: string,
): UpdateManagementResult<UpdateJob> {
  const cancelled = dependencies.store.cancel(jobId, updatePrincipalFor(caller));
  if (!cancelled.ok) {
    if (cancelled.reason === 'forbidden') {
      return failure('UPDATE_PERMISSION_REQUIRED', 'This update job belongs to another principal.', jobId);
    }
    return cancelled.reason === 'unknown-schema'
      ? failure('UPDATE_UNKNOWN_JOB_SCHEMA', 'This job was written by a newer updater and was left exactly as it was.')
      : failure('UPDATE_JOB_NOT_FOUND', cancelled.reason ?? 'This job can no longer be cancelled.', jobId);
  }
  return { ok: true, value: cancelled.job! };
}

/** Bounded, sanitized history: detail codes and versions, never paths or command lines. */
export function updateHistory(dependencies: UpdateManagementDependencies): UpdateHistoryEntry[] {
  return dependencies.store.listJobs()
    .filter((job) => job.result !== undefined)
    .slice(-20)
    .map((job) => ({
      jobId: job.jobId,
      releaseId: job.releaseId,
      finishedAt: job.updatedAt,
      result: job.result!,
      components: job.components.map((component) => ({
        component: component.component,
        outcome: component.outcome,
        ...(component.actual.version === undefined ? {} : { version: component.actual.version }),
      })),
      detailCodes: job.events.map((event) => event.detailCode),
    }));
}
/**
 * What this host can now prove about a commit it delegated.
 *
 * Two independent witnesses close a job, and neither of them is this process's own memory:
 *
 *   - the build answering carries the whole identity the review pinned, version and commit,
 *     because two builds can share a version string and only one of them was reviewed;
 *   - this host's installer says its own transaction committed. That is a separate fact, and
 *     the order of operations is why it is needed: the upgrader starts the candidate, and only
 *     then proves the broker and its web root healthy and commits the receipts that make the
 *     swap durable. Between those two moments the pinned build is answering, the journal is
 *     still there, and a failed health check puts the previous build back in charge.
 *
 * So a job is closed as succeeded only when the build answering and the installer's own record
 * agree. Anything else is judged by the delegation deadline. A commit that was handed to this
 * host's own updater and never came back has no other witness -- the process that would have
 * reported it is the thing that failed -- so past the deadline the record settles as needing
 * attention. That is a verdict, not a tidy-up: it keeps the evidence, and it releases the
 * component so the next attempt is possible instead of permanently refused.
 */
function settleDelegatedCommit(
  dependencies: UpdateManagementDependencies,
  job: UpdateJob,
  atMs: number,
): 'succeeded' | 'needs-attention' | 'transition-refused' | 'finish-committed' {
  const running = runningIdentity(dependencies);
  const expectedVersion = releaseIdVersion(job.releaseId);
  const expectedCommit = releaseIdCommit(job.releaseId);
  const runningCommit = running.buildId?.slice(0, 7).toLowerCase();
  const answersAsPinned = expectedVersion !== undefined && expectedCommit !== undefined
    && running.version === expectedVersion && runningCommit === expectedCommit;
  const proof = dependencies.installerCommit?.(job)
    ?? { committed: false as const, reason: 'unrecorded' as const };
  if (answersAsPinned && proof.committed) {
    const components = job.components.map((component) => ({
      component: component.component,
      outcome: 'verified' as const,
      actual: { ...component.actual, ...running },
    }));
    // A commit delegated but interrupted before the phase was recorded still lands here:
    // `verifying` is the state the build answering proves, not one it has to remember.
    if (job.phase === 'applying') {
      dependencies.store.transition(job.jobId, 'host', 'verifying', 'broker-build-confirmed', components);
    }
    const done = dependencies.store.transition(job.jobId, 'host', 'succeeded', 'update-complete', components);
    return done.ok ? 'succeeded' : 'transition-refused';
  }
  // No lease means a record written before delegation carried a deadline. Its own last
  // mutation is the closest thing to one, and the same grace applies: a commit that was
  // still in flight a moment ago is not a failure yet.
  const deadline = job.runner?.leaseExpiresAt === undefined
    ? Date.parse(job.updatedAt) + UPDATE_HANDOFF_LEASE_MS
    : Date.parse(job.runner.leaseExpiresAt);
  if (Number.isFinite(deadline) && deadline > atMs) return 'finish-committed';
  const components = job.components.map((component) => ({
    component: component.component,
    outcome: 'needs_attention' as const,
    actual: component.component === 'broker' ? { ...component.actual, ...running } : component.actual,
  }));
  // Two ways not to have landed, which a person reading the history needs apart: nothing ever
  // answered as the pinned build, or the pinned build answered and the installer's own record
  // still does not name the bytes this job prepared.
  const settled = dependencies.store.transition(job.jobId, 'host', 'needs_attention',
    answersAsPinned ? 'delegated-update-uncommitted' : 'delegated-update-unconfirmed', components);
  return settled.ok ? 'needs-attention' : 'transition-refused';
}

/** The build this process answers with, in the shape a job's component record carries. */
function runningIdentity(dependencies: UpdateManagementDependencies): UpdateBuildIdentity {
  return {
    ...(dependencies.buildInfo.version === undefined ? {} : { version: dependencies.buildInfo.version }),
    ...(dependencies.buildInfo.commit === undefined ? {} : { buildId: dependencies.buildInfo.commit }),
  };
}

/**
 * Whether a record still describes the installation this process is standing on.
 *
 * `installationId` says which machine, and the generation says which setup of it. Re-running
 * setup re-commits the installation and moves the generation, which turns every review made
 * against the previous one into history: the tree that was approved is gone, and no later
 * observation of this home can settle what it predicted.
 */
function installationSuperseded(
  dependencies: UpdateManagementDependencies,
  job: UpdateJob,
): boolean {
  const installation = dependencies.installation();
  return job.installationId !== installation.installationId
    || job.installationGeneration !== installation.installationGeneration;
}

/**
 * Close a record that belongs to an installation that has since been set up again.
 *
 * Deferring this to the delegation deadline is what used to make a re-run of setup fatal: the
 * component the old job names stays claimed by a job that can never be honoured here, so every
 * later review is told somebody else is updating this server. Settling is a verdict about a
 * record, not about a machine, and it keeps every event the job already recorded.
 *
 * A job that had its commit accepted might have moved bytes on the installation it was made
 * for, so it needs a person: that is `needs_attention`. One that never got that far describes
 * work that simply did not happen, and is `failed`.
 */
function settleSupersededInstallation(
  dependencies: UpdateManagementDependencies,
  job: UpdateJob,
): 'needs-attention' | 'failed' | 'transition-refused' {
  const delegated = job.applyAcceptedAt !== undefined;
  const running = runningIdentity(dependencies);
  const settled = dependencies.store.transition(job.jobId, 'host', delegated ? 'needs_attention' : 'failed',
    'installation-superseded', job.components.map((component) => ({
      component: component.component,
      outcome: delegated ? 'needs_attention' as const : 'failed' as const,
      actual: component.component === 'broker' ? { ...component.actual, ...running } : component.actual,
    })));
  return settled.ok ? (delegated ? 'needs-attention' : 'failed') : 'transition-refused';
}

/**
 * Settle the jobs this host was in the middle of, from what it can prove right now.
 *
 * A broker that has just been replaced is a different process and cannot vouch for itself,
 * so success is read from the build answering now and from the installer's record of what it
 * committed, not from the journal that predicted it. Runs at startup, whenever a read or a new
 * submission needs the truth about what is installed, and before any commit is accepted.
 */
export function reconcileInterruptedUpdates(
  dependencies: UpdateManagementDependencies,
): Array<{ jobId: string; action: string }> {
  const atMs = clock(dependencies)().getTime();
  const settled: Array<{ jobId: string; action: string }> = [];
  let closed = false;
  for (const entry of dependencies.store.recoverInterrupted()) {
    // Nothing about a superseded installation can improve with waiting: preparation cannot
    // resume against a rewritten tree, and a phase left open holds its component against every
    // attempt this installation makes from now on.
    if (installationSuperseded(dependencies, entry.job)) {
      const action = settleSupersededInstallation(dependencies, entry.job);
      closed = closed || action !== 'transition-refused';
      settled.push({ jobId: entry.job.jobId, action });
      continue;
    }
    if (entry.job.applyAcceptedAt === undefined
        && ['accepted', 'preparing', 'ready'].includes(entry.job.phase)) {
      const reviewed = dependencies.store.readPlan(entry.job.planId);
      if (reviewed.ok && Date.parse(reviewed.value.plan.expiresAt) <= atMs) {
        const expired = dependencies.store.transition(entry.job.jobId, 'host', 'failed', 'prepared-review-expired',
          entry.job.components.map((component) => ({ component: component.component,
            outcome: 'failed' as const, actual: component.actual })));
        closed = closed || expired.ok;
        settled.push({ jobId: entry.job.jobId, action: expired.ok ? 'prepared-review-expired' : 'transition-refused' });
        continue;
      }
    }
    if (entry.action !== 'finish-committed') {
      settled.push({ jobId: entry.job.jobId, action: entry.action });
      continue;
    }
    const action = settleDelegatedCommit(dependencies, entry.job, atMs);
    closed = closed || action === 'succeeded' || action === 'needs-attention';
    settled.push({ jobId: entry.job.jobId, action });
  }
  if (closed) prunePreparation(dependencies);
  return settled;
}

/** Owner-facing grant view: peer identities and audit states, never credentials. */
export function updateGrantView(dependencies: UpdateManagementDependencies): {
  grants: Array<{ peerId: string; grantedAt: string; grantedBy: string; revokedAt?: string }>;
  requests: Array<{ peerId: string; requestedAt: string }>;
} {
  return {
    grants: dependencies.grants.list().map((record) => ({
      peerId: record.peerId,
      grantedAt: record.grantedAt,
      grantedBy: record.grantedBy,
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    })),
    requests: dependencies.grants.pendingRequests(),
  };
}

/**
 * Request bodies, validated before anything reads them.
 *
 * A request names components and identities. It never carries a path, a URL, or a
 * command, and the parser refuses the shapes that would try: an unknown component, an
 * over-long identity, or control characters in an id. The pre-existing endpoint already
 * refuses a caller-supplied manifest URL for the same reason, and this surface holds that
 * line everywhere rather than in one route.
 */
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$/;
const ACKNOWLEDGEMENT_VALUES: readonly string[] = UPDATE_ACKNOWLEDGEMENTS;

function boundedText(value: unknown, maximum = 128): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum && !/[\0\r\n]/.test(trimmed) ? trimmed : undefined;
}

function componentList(value: unknown): UpdateComponent[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > UPDATE_COMPONENTS.length) return undefined;
  const seen = new Set<UpdateComponent>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(UPDATE_COMPONENTS as readonly string[]).includes(entry)) return undefined;
    seen.add(entry as UpdateComponent);
  }
  return [...seen];
}

export function parseUpdatePlanRequestBody(body: unknown): UpdatePlanRequest | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const releaseId = boundedText(value.releaseId);
  const components = componentList(value.components);
  if (!releaseId || !RELEASE_ID_PATTERN.test(releaseId) || !components) return undefined;
  const acknowledgements = value.acknowledgements === undefined
    ? []
    : Array.isArray(value.acknowledgements)
      && value.acknowledgements.every((entry) => typeof entry === 'string' && ACKNOWLEDGEMENT_VALUES.includes(entry))
      ? [...new Set(value.acknowledgements as UpdateAcknowledgement[])]
      : undefined;
  if (acknowledgements === undefined) return undefined;
  const expected = parseBuildIdentity(value.expected);
  if (value.expected !== undefined && expected === undefined) return undefined;
  const clientContract = parseContractAdvert(value.clientContract);
  if (value.clientContract !== undefined && clientContract === undefined) return undefined;
  return {
    releaseId,
    components,
    // An unnamed expectation is no expectation; the broker's own build is checked either way.
    expected: expected ?? {},
    ...(acknowledgements.length === 0 ? {} : { acknowledgements }),
    ...(clientContract === undefined ? {} : { clientContract }),
  };
}

/** The reviewed expected identity. Any field may be absent; a wrong one is a conflict. */
export function parseBuildIdentity(value: unknown): UpdateBuildIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const identity: UpdateBuildIdentity = {};
  for (const key of ['version', 'buildId', 'releaseId'] as const) {
    if (row[key] === undefined) continue;
    const text = boundedText(row[key], 64);
    if (text === undefined) return undefined;
    identity[key] = text;
  }
  return identity;
}

function parseContractAdvert(value: unknown): UpdateContractAdvert | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.minimumPeerRevision)) return undefined;
  const revision = row.revision as number;
  const minimumPeerRevision = row.minimumPeerRevision as number;
  if (revision < 0 || minimumPeerRevision < 0 || minimumPeerRevision > revision) return undefined;
  const surfaceHash = row.surfaceHash;
  return {
    revision,
    minimumPeerRevision,
    ...(typeof surfaceHash === 'string' && /^fnv1a32:[a-f0-9]{8}$/.test(surfaceHash) ? { surfaceHash } : {}),
  };
}

/** Job submission: one reviewed plan plus a key that makes a lost response safe to retry. */
export function parseUpdateJobSubmissionBody(body: unknown): UpdateJobSubmission | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const planId = boundedText(value.planId, 64);
  const idempotencyKey = boundedText(value.idempotencyKey, 128);
  if (planId === undefined || idempotencyKey === undefined) return undefined;
  return { planId, idempotencyKey };
}

export function parseUpdateApplyRequestBody(body: unknown): UpdateApplyRequest | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const idempotencyKey = boundedText((body as Record<string, unknown>).idempotencyKey, 128);
  return idempotencyKey === undefined ? undefined : { idempotencyKey };
}

/**
 * HTTP status for a typed failure.
 *
 * The code is the contract and the status only lets a client branch cheaply, so the
 * mapping never collapses "not granted" and "no such job" into one shape.
 */
export function updateManagementStatus(code: UpdateErrorCode): number {
  if (code === 'UPDATE_PERMISSION_REQUIRED' || code === 'UPDATE_GRANT_REVOKED') return 403;
  if (code === 'UPDATE_JOB_NOT_FOUND') return 404;
  if (code === 'UPDATE_PLAN_STALE' || code === 'UPDATE_PLAN_EXPIRED' || code === 'UPDATE_TARGET_MOVED'
    || code === 'UPDATE_IN_PROGRESS' || code === 'UPDATE_IDEMPOTENCY_CONFLICT') return 409;
  return 400;
}

/** The cached channel probe, expressed the way the inventory reports the channel. */
export function channelObservation(result: ReleaseUpdateCheckResult): ChannelObservation {
  return { status: result.status, detailCode: result.detailCode, checkedAt: result.checkedAt };
}

/** The same, from a check this surface answered, so a caller can render both from one round trip. */
export function channelObservationFromCheck(result: UpdateCheckResponse): ChannelObservation {
  const first = result.components[0];
  const available = first?.available;
  return {
    status: result.status,
    detailCode: result.detailCode,
    checkedAt: first?.releaseCheckedAt ?? new Date(0).toISOString(),
    ...(available?.version === undefined
      ? {}
      : {
        available: {
          version: available.version,
          ...(available.releaseId === undefined ? {} : { releaseId: available.releaseId }),
        },
      }),
  };
}

/** A job id is caller-supplied text on its way to a filename. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/** Drop staged artifacts for finished jobs. Active and recoverable jobs keep theirs. */
export function prunePreparation(dependencies: UpdateManagementDependencies): { removed: string[]; retained: string[] } {
  const pruned = dependencies.store.prune();
  for (const jobId of pruned.removed) {
    rmSync(join(dependencies.stagingRoot, safeSegment(jobId)), { recursive: true, force: true });
  }
  return pruned;
}
