/**
 * The runtime's own view of the update-management surface.
 *
 * `update-management.ts` is pure enough to test against a fake feed; this is the
 * thin seam that points it at a real state home, a real install receipt, and a real
 * release channel. Keeping the two apart is what lets the authority and staleness
 * rules be proven without promoting a release.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { UPDATE_MANAGEMENT_CONTRACT_VERSION, type UpdateBusyState, type UpdateInstallOwnership, type UpdateJob } from '@cosyncing/protocol';
import type { BrokerServiceBoundary } from '../runtime/service-boundary.ts';
import { inspectInstallState } from '../installation/install-state.ts';
import { handoffBrokerUpdate, type BrokerUpdateChecker, type BrokerUpdateLaunchDecision } from './broker-update.ts';
import { openUpdateGrantStore, type UpdateGrantStore } from '../security/update-grants.ts';
import { inspectDesktopClient, type DesktopClientContext } from './desktop-client.ts';
import {
  defaultManifestUrl,
  packageManagerUpdateGuidance,
  releaseKeys,
  upgradeTransactionOpen,
} from './release-upgrade.ts';
import { UpdateOperationStore } from './update-operation-store.ts';
import type { InstalledComponentState } from './update-planner.ts';
import { stagedPreparedDigest, type InstallerCommitProof, type UpdateManagementDependencies } from './update-management.ts';
import type { BuildInfo } from '../runtime/build-info.ts';

export interface UpdateManagementHost {
  dependencies: UpdateManagementDependencies;
  store: UpdateOperationStore;
  grants: UpdateGrantStore;
}

/** Stable per-home identity for a run with no committed receipt, so authority still binds to something. */
function fallbackInstallationId(home: string): string {
  return `uncommitted-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
}

/**
 * What is on this host, as observed.
 *
 * Ownership comes from the install receipt and the desktop receipt, never from the
 * OS name or a version pair: an npm-installed broker and an installer-owned one can
 * share a home directory and mean completely different things.
 */
function observeComponents(home: string, buildInfo: BuildInfo, committed: boolean): {
  broker: InstalledComponentState;
  client?: InstalledClientState;
} {
  const platform = process.platform;
  const arch = process.arch;
  const running = {
    ...(buildInfo.version ? { version: buildInfo.version } : {}),
    ...(buildInfo.commit ? { buildId: buildInfo.commit } : {}),
  };
  const contract = (buildInfo.contract ?? {}) as unknown as Record<string, unknown>;
  const brokerContract = typeof contract.revision === 'number' && typeof contract.minimumClientRevision === 'number'
    ? {
      revision: contract.revision,
      minimumPeerRevision: contract.minimumClientRevision,
      ...(typeof contract.surfaceHash === 'string' ? { surfaceHash: contract.surfaceHash } : {}),
    }
    : undefined;
  const broker: InstalledComponentState = {
    component: 'broker',
    platform,
    arch,
    ownership: brokerOwnership(buildInfo, committed),
    running,
    ...(brokerContract ? { contract: brokerContract } : {}),
    updateManagementVersion: UPDATE_MANAGEMENT_CONTRACT_VERSION,
  };
  return { broker, ...observeDesktopClient(home) };
}

type InstalledClientState = InstalledComponentState;

/**
 * Acquisition, not location.
 *
 * A JavaScript package the operator installed with npm stays owned by that package manager even
 * after setup copied an executable into the state home, and replacing those files from inside the
 * broker makes the manager's record of the machine permanently false. An uncommitted or unstamped
 * build reports `unknown`, which blocks the component rather than the whole operation.
 */
function brokerOwnership(buildInfo: BuildInfo, committed: boolean): UpdateInstallOwnership {
  if (!committed || !buildInfo.packaged) return 'unknown';
  if (packageManagerUpdateGuidance(buildInfo)) return 'package-manager';
  return 'cosyncing-installer';
}

/**
 * The installer-owned desktop, when this host has one.
 *
 * Read-only inspection: a missing, unreadable, or foreign desktop is simply absent
 * from the inventory. Claiming a client the receipts cannot prove is worse than
 * reporting nothing, because the planner would then order work against it.
 */
function observeDesktopClient(home: string): { client?: InstalledClientState } {
  const context: DesktopClientContext = { home };
  try {
    const prepared = inspectDesktopClient(context);
    if (!prepared) return {};
    return {
      client: {
        component: 'client',
        platform: process.platform,
        arch: process.arch,
        ownership: 'cosyncing-installer',
        running: { ...(prepared.receipt.version ? { version: prepared.receipt.version } : {}) },
        updateManagementVersion: UPDATE_MANAGEMENT_CONTRACT_VERSION,
      },
    };
  } catch {
    return {};
  }
}

/**
 * What this host's installer can vouch for about a commit the surface delegated to it.
 *
 * Two records, neither of them written by the code that asks. The upgrade journal is the
 * transaction's own lifetime: it exists from the moment bytes start moving until the receipts
 * name the new build, which is exactly the window in which a candidate can be answering traffic
 * and still be about to be rolled back. The install receipt is what survives that: the write
 * that commits the swap sets the broker binary's recorded hash to the candidate's digest, and a
 * rollback puts the previous one back. So when the receipt names the bytes this job staged, the
 * commit is a fact about this installation rather than a hope about the build currently
 * answering, and when it names other bytes, the honest answer is that they differ.
 */
function installerCommitProof(home: string, stagingRoot: string): (job: UpdateJob) => InstallerCommitProof {
  return (job) => {
    if (upgradeTransactionOpen(home)) return { committed: false, reason: 'in-flight' };
    const prepared = stagedPreparedDigest(stagingRoot, job.jobId, job.releaseId);
    const inspection = inspectInstallState(home);
    if (!inspection.committed) return { committed: false, reason: 'unrecorded' };
    const installed = inspection.state.resources
      .find((resource) => resource.id === 'broker-binary')
      ?.ownership.installedSha256;
    if (prepared === undefined || installed === undefined) return { committed: false, reason: 'unrecorded' };
    return installed === prepared ? { committed: true } : { committed: false, reason: 'installed-bytes-differ' };
  };
}

const UNKNOWN_BUSY: () => UpdateBusyState = () => ({
  // Unknown, not idle: the spec's own rule is that an unread maintenance state keeps
  // work running, which means an apply has to be acknowledged rather than assumed safe.
  state: 'unknown',
  activeTurns: 0,
  activeLaunches: 0,
  pendingApprovals: 0,
  observedAt: new Date(0).toISOString(),
});

export function openUpdateManagementHost(options: {
  home: string;
  buildInfo: BuildInfo;
  manifestUrl?: string;
  fetch?: typeof fetch;
  /** Channel trust for this host. Defaults to the keys stamped into this build. */
  trustedKeys?: Readonly<Record<string, string>>;
  /**
   * Test seam for a host's updater. Production passes `updater` instead, and a surface with
   * neither has no handoff and says so.
   */
  handoff?: (job: UpdateJob, mayLaunch: () => BrokerUpdateLaunchDecision) => Promise<{ accepted: boolean; detailCode: string }>;
  /**
   * How this host's own upgrader is reached, when it can be reached at all.
   *
   * The runtime's view of its launcher, given as data so the composition root holds the wiring
   * and the sequence that honours a pin, asks for authority, and refuses a moved target stays
   * in one function that can be run against a stub.
   */
  updater?: {
    checker: BrokerUpdateChecker;
    service: Readonly<BrokerServiceBoundary>;
    executablePath: string;
    runtimePath?: string;
    cacheRoot?: string;
    userHome?: string;
  };
  busy?: () => UpdateBusyState;
  now?: () => Date;
}): UpdateManagementHost {
  // Read every time it is asked for, never carried: a broker that was started by launchd while
  // setup was still committing, or one that outlived a re-run of setup, is standing on a
  // different installation than the one it opened with, and every staleness answer it gives has
  // to describe the receipt on disk now. `committed` travels along because ownership is read
  // from the same record: an installation that stopped being provable has to stop looking
  // provable in the inventory too, not keep a startup answer alive.
  const readInstallation = () => {
    const inspection = inspectInstallState(options.home);
    return {
      committed: inspection.committed,
      installationId: inspection.committed && inspection.state.installationId
        ? inspection.state.installationId
        : fallbackInstallationId(options.home),
      // Re-running setup re-commits the installation, which moves this number and turns any
      // plan reviewed against the previous one into a typed conflict.
      installationGeneration: inspection.committed
        ? Math.max(1, Math.floor(Date.parse(inspection.state.setup.committedAt) / 1000) || 1)
        : 0,
    };
  };
  const store = new UpdateOperationStore(join(options.home, 'updates'));
  const grants = openUpdateGrantStore({
    home: options.home,
    installationId: () => readInstallation().installationId,
    ...(options.now ? { now: options.now } : {}),
  });
  // One reader, two places. The inventory reports what the host is doing, and the planner
  // decides whether restarting it has to be acknowledged -- so the same reading has to reach
  // both. A host that never reports its state is indistinguishable from one that proved
  // itself idle, which is precisely the wrong thing to be when the answer is "unknown".
  const busy = options.busy ?? UNKNOWN_BUSY;
  const stagingRoot = join(options.home, 'updates', 'staging');
  const handoff = options.handoff
    ?? (options.updater === undefined ? undefined : hostHandoff(options.updater, options.home, options.buildInfo));
  // Grants and reviews use the same live installation identity. The store refuses old
  // authority and binds newly issued grants to the receipt the host is currently serving.
  const dependencies: UpdateManagementDependencies = {
    installation: () => {
      const { installationId: id, installationGeneration: generation } = readInstallation();
      return { installationId: id, installationGeneration: generation };
    },
    buildInfo: options.buildInfo,
    store,
    grants,
    observe: () => observeComponents(options.home, options.buildInfo, readInstallation().committed),
    busy,
    environment: () => ({ busyState: busy().state }),
    channel: {
      manifestUrl: options.manifestUrl ?? defaultManifestUrl(),
      // The host, not the caller, chooses what it trusts: a request names components and a
      // release identity, and only ever gets an answer about the channel this build verifies.
      trustedKeys: options.trustedKeys ?? releaseKeys(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    stagingRoot,
    installerCommit: installerCommitProof(options.home, stagingRoot),
    ...(handoff === undefined ? {} : { handoff }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return { dependencies, store, grants };
}

/**
 * The handoff for a host that was told how its upgrader is reached.
 *
 * The pin and the authority question are both per commit, which is why this is a function of the
 * job rather than a launch configuration: `mayLaunch` belongs to whoever is committing, and the
 * updater asks it at the moment it schedules, after its channel refresh and before the spawn.
 */
function hostHandoff(
  options: NonNullable<Parameters<typeof openUpdateManagementHost>[0]['updater']>,
  home: string,
  buildInfo: BuildInfo,
): (job: UpdateJob, mayLaunch: () => BrokerUpdateLaunchDecision) => Promise<{ accepted: boolean; detailCode: string }> {
  return (job, mayLaunch) => handoffBrokerUpdate({
    checker: options.checker,
    buildInfo,
    service: options.service,
    executablePath: options.executablePath,
    ...(options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath }),
    stateHome: home,
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    pinnedReleaseId: job.releaseId,
    authorizeLaunch: mayLaunch,
  });
}
