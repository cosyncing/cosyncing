/**
 * Pure update planning: installed observations plus one pinned release in, an
 * explainable plan out.
 *
 * No I/O, no clock but the one it is handed, and no product-version literals.
 * Three questions are easy to collapse into one and expensive to get wrong, so
 * they stay separate here:
 *
 *   1. Is there a newer eligible release?   discovery and eligibility
 *   2. May THIS caller commit it?           authority and installation shape
 *   3. Does the result still work together? the shared session contract policy
 *
 * Question 3 delegates to {@link evaluateBrokerClientCompatibility} instead of
 * restating it, and runs it on the pairs an operation could be INTERRUPTED on,
 * not only the pair it ends on. A plan that finishes compatible but passes
 * through a state where the survivor cannot talk to the other half is not safe,
 * and the second half can still fail: an APK install can be declined, a desktop
 * swap can lose to a locked file. "Ends fine" is not the standard.
 */
import {
  UPDATE_MANAGEMENT_CONTRACT_VERSION,
  UPDATE_PLAN_DEFAULT_TTL_MS,
  evaluateBrokerClientCompatibility,
  type BrokerClientCompatibilityStatus,
  type UpdateAcknowledgement,
  type UpdateBlocker,
  type UpdateBuildIdentity,
  type UpdateComponent,
  type UpdateCompatibilityPair,
  type UpdateCompatibilityReport,
  type UpdateContractAdvert,
  type UpdateInstallOwnership,
  type UpdatePlan,
  type UpdatePlannedComponent,
} from '@cosyncing/protocol';
import {
  isSupportedReleaseUpdater,
  type ReleaseUpdaterBlock,
  type ReleaseUpdaterMetadata,
} from './updater-metadata.ts';
import { compareReleaseVersions, satisfiesMinimum } from './updater-metadata.ts';
import { DESKTOP_CLIENT_HOSTS, type DesktopClientHost } from './desktop-client-types.ts';
import type { ReleaseContractIdentity } from './release-upgrade.ts';

/** What is actually on this host, as observed rather than as assumed. */
export interface InstalledComponentState {
  component: UpdateComponent;
  platform: string;
  arch: string;
  ownership: UpdateInstallOwnership;
  running: UpdateBuildIdentity;
  /** On-disk build when it differs from the running one. */
  installed?: UpdateBuildIdentity;
  /** The contract this build advertises. Absent means it could not prove one. */
  contract?: UpdateContractAdvert;
  /** Update-management version this host actually serves. */
  updateManagementVersion?: number;
}

/**
 * One release, resolved once and pinned for the life of the plan.
 *
 * `releaseId` is the immutability handle. Discovery may resolve a mutable
 * `latest` again while a plan waits, and a plan must not follow it: everything
 * here comes from that one signed manifest, and nothing is re-resolved later.
 */
export interface PinnedRelease {
  releaseId: string;
  version: string;
  /** Absent on a legacy manifest, which publishes no contract to plan against. */
  brokerContract?: ReleaseContractIdentity;
  /** Absent on a release that makes no internal-update promise. */
  updater?: ReleaseUpdaterBlock;
  /** Signed per-component download sizes, when the manifest states them. */
  downloadBytes?: Partial<Record<UpdateComponent, number>>;
  /** The broker and its web sidecar move as one host update. */
  webSidecarIncluded?: boolean;
}

/** Where the request came from, which decides what it is allowed to name. */
export interface PlanCaller {
  kind: 'local-owner' | 'remote-owner' | 'remote-peer';
  /** Owner authority implies true; a peer needs the narrow `broker:update` grant. */
  updateGranted: boolean;
}

export interface SavedServerObservation {
  installationId: string;
  label: string;
  /** That server's own broker contract, when it has been proven. */
  brokerContract?: UpdateContractAdvert;
  lastSeenAt?: string;
}

export interface PlanRequest {
  nowMs: number;
  ttlMs?: number;
  planId: () => string;
  installationId: string;
  installationGeneration: number;
  caller: PlanCaller;
  requested: readonly UpdateComponent[];
  installed: { broker: InstalledComponentState; client?: InstalledComponentState };
  release: PinnedRelease;
  /** Acknowledgements the user already gave during review. */
  acknowledgements?: readonly UpdateAcknowledgement[];
  /**
   * The session contract the initiating caller advertises, when it is an app.
   *
   * Used only for the pair where the client is NOT being replaced, and only when this
   * host cannot see that client itself: a server has no way to read the contract of the
   * phone asking it to restart, and a plan that quietly evaluated some other build would
   * call an update compatible with an app nobody is running.
   */
  clientContract?: UpdateContractAdvert;
  /** Saved servers the user did NOT select, checked against the candidate client. */
  otherServers?: readonly SavedServerObservation[];
  environment?: {
    helperVersion?: string;
    helperCapabilities?: readonly string[];
    /** Runtime the candidate would run under, as that runtime itself reported it. */
    runtimeVersion?: string;
    freeBytes?: number;
    busyState?: 'idle' | 'busy' | 'unknown';
  };
}

/**
 * What counts as an installed release identity.
 *
 * Deliberately stricter than the manifest's own version grammar: a pre-release or
 * build suffix on an INSTALLED build is what an unstamped development build reports,
 * and ordering a user's real app against a sentinel would send them after a build
 * they may already be running. The published side may legally carry a suffix.
 */
const READABLE_VERSION = /^\d+\.\d+\.\d+$/;

const OWNERSHIP_BLOCKERS: Partial<Record<UpdateInstallOwnership, UpdateBlocker>> = {
  'package-manager': {
    code: 'package-manager-owned',
    detail: 'A package manager owns these files, so cosyncing does not replace them from inside itself.',
    guidance: 'Run the signed installer from https://cosyncing.com/#install to migrate this installation, then use `cosy update`.',
  },
  source: { code: 'source-build', detail: 'This build runs from a source checkout, which is updated by pulling it.' },
  'store-managed': { code: 'store-managed', detail: 'An app store owns this installation, so the store must deliver the update.' },
  unknown: {
    code: 'ownership-unproven',
    detail: 'Installation ownership could not be proven, so nothing here is safe to replace.',
    guidance: 'Re-run the installer once to record an owned installation.',
  },
};

/**
 * The updater block only when this build can actually read it.
 *
 * `undefined` covers both "the release published none" and "the release published a
 * newer format", and the caller distinguishes them from `request.release.updater`
 * itself. Neither case may be read as an empty-but-valid metadata set.
 */
function supportedUpdater(block: ReleaseUpdaterBlock | undefined): ReleaseUpdaterMetadata | undefined {
  return block !== undefined && isSupportedReleaseUpdater(block) ? block : undefined;
}

function blocker(
  code: UpdateBlocker['code'],
  detail: string,
  component?: UpdateComponent,
  guidance?: string,
): UpdateBlocker {
  return { code, detail, ...(component ? { component } : {}), ...(guidance ? { guidance } : {}) };
}

/** A pair is workable when it is not refused and not merely unproven. */
function usable(status: BrokerClientCompatibilityStatus): boolean {
  return status === 'compatible' || status === 'client-behind' || status === 'broker-behind';
}

/**
 * Evaluate one client/broker pair through the session policy.
 *
 * A candidate client with no surface hash still gets evaluated: hash equality
 * only bites at equal revisions, and a candidate build's hash is published with
 * the release that carries it.
 */
function evaluatePair(
  client: UpdateContractAdvert,
  broker: UpdateContractAdvert,
): UpdateCompatibilityPair {
  const verdict = evaluateBrokerClientCompatibility(
    {
      revision: client.revision,
      minimumBrokerRevision: client.minimumPeerRevision,
      ...(client.surfaceHash === undefined ? {} : { surfaceHash: client.surfaceHash }),
    },
    {
      revision: broker.revision,
      minimumClientRevision: broker.minimumPeerRevision,
      surfaceHash: broker.surfaceHash ?? '',
    },
  );
  return {
    client: { ...client },
    broker: { ...broker },
    status: verdict.status,
    readOnly: verdict.readOnly,
    reason: verdict.reason,
  };
}

function targetAdvert(revision: number, minimumPeerRevision: number, surfaceHash?: string): UpdateContractAdvert {
  return { revision, minimumPeerRevision, ...(surfaceHash === undefined ? {} : { surfaceHash }) };
}

/**
 * Which contract identities a plan has to know before it may call a pair safe.
 *
 * The half being replaced owes the contract the release publishes for it; the half being
 * left alone owes the contract it advertises today. When both halves move, a rollout can be
 * interrupted after either one, so each running build is scored against the other's target
 * too and both have to prove themselves.
 *
 * The one gap not listed here is an app that stays where it is and cannot be seen from
 * here, which is a server's normal view of the phone asking it to restart. That is
 * uncertainty a person can accept, so it asks rather than blocks; a contract this host owns
 * and cannot report is a defect it should not be allowed to consent its way past.
 */
function contractRequirements(input: {
  replacesBroker: boolean;
  replacesClient: boolean;
  brokerState: InstalledComponentState;
  clientState: InstalledComponentState | undefined;
  brokerTarget: UpdateContractAdvert | undefined;
  clientTarget: UpdateContractAdvert | undefined;
}): Array<{ component: UpdateComponent; what: string }> {
  const gaps: Array<{ component: UpdateComponent; what: string }> = [];
  const need = (advert: UpdateContractAdvert | undefined, component: UpdateComponent, what: string): void => {
    if (advert === undefined) gaps.push({ component, what });
  };
  need(input.replacesBroker ? input.brokerTarget : input.brokerState.contract, 'broker',
    input.replacesBroker
      ? 'The published release does not state the broker contract it carries'
      : 'This server does not report its session contract');
  if (input.replacesClient) {
    need(input.clientTarget, 'client', 'The published release does not state the client contract it carries');
  }
  if (input.replacesBroker && input.replacesClient) {
    need(input.clientState?.contract, 'client', 'This app build does not report its session contract');
    need(input.brokerState.contract, 'broker', 'This server does not report its session contract');
  }
  return gaps;
}

function desktopHostFor(state: InstalledComponentState): DesktopClientHost | undefined {
  const key = `${state.platform}-${state.arch}`;
  return (DESKTOP_CLIENT_HOSTS as readonly string[]).includes(key) ? key as DesktopClientHost : undefined;
}

/** Why a selected component will not change, kept apart from "cannot run". */
interface ComponentVerdict {
  component: UpdateComponent;
  state: InstalledComponentState;
  actionable: boolean;
  excludedReason?: UpdateBlocker;
}

function judgeComponent(
  component: UpdateComponent,
  state: InstalledComponentState | undefined,
  request: PlanRequest,
  blockers: UpdateBlocker[],
): ComponentVerdict | undefined {
  const stop = (reason: UpdateBlocker): undefined => {
    blockers.push(reason);
    return undefined;
  };
  if (!state) {
    return stop(blocker('identity-mismatch', `No ${component} installation is associated with this host.`, component));
  }
  const ownership = OWNERSHIP_BLOCKERS[state.ownership];
  if (ownership) {
    return stop(blocker(ownership.code, ownership.detail, component, ownership.guidance));
  }
  const comparison = state.running.version === undefined || !READABLE_VERSION.test(state.running.version)
    ? null
    : compareReleaseVersions(request.release.version, state.running.version);
  if (comparison === null) {
    return stop(blocker('identity-mismatch',
      `The running ${component} build does not report a readable version, so no target can be confirmed.`, component));
  }
  if (comparison <= 0) {
    return {
      component,
      state,
      actionable: false,
      excludedReason: blocker('release-metadata-absent',
        comparison < 0
          ? `This ${component} is newer than the published release, so there is nothing to install.`
          : `This ${component} is already on the published release.`,
        component),
    };
  }
  if (component !== 'client') return { component, state, actionable: true };

  // Desktop replacement is the only component with an OS-shaped gauntlet, and every
  // rung of it is a fact about this machine rather than a guess from its name.
  const updater = supportedUpdater(request.release.updater);
  const host = desktopHostFor(state);
  const platform = host && updater ? updater.desktop?.[host] : undefined;
  if (!host || !platform) {
    return stop(blocker('unsupported-platform',
      'This platform has no in-app desktop update path in the published release.', 'client'));
  }
  if (!platform.capabilities.includes('client-replace') || !platform.capabilities.includes('client-relaunch')) {
    return stop(blocker('helper-missing',
      'The desktop updater here can replace the app but cannot reopen it, which is not an update.', 'client',
      'Rerun the installer to install the current updater.'));
  }
  if (!satisfiesMinimum(request.environment?.helperVersion, updater?.minimumHelperVersion)) {
    return stop(blocker('helper-too-old',
      `The installed updater helper is older than this release requires (needs ${updater?.minimumHelperVersion}).`,
      'client', 'Rerun the installer once to update the helper.'));
  }
  if (!satisfiesMinimum(request.environment?.runtimeVersion, platform.minimumRuntimeVersion)) {
    return stop(blocker('runtime-below-floor',
      `This build needs runtime ${platform.minimumRuntimeVersion}; this host reported ${request.environment?.runtimeVersion ?? 'nothing'}.`,
      'client'));
  }
  const { freeBytes, stagingBytes } = { freeBytes: request.environment?.freeBytes, stagingBytes: platform.stagingBytes };
  if (freeBytes !== undefined && stagingBytes !== undefined && freeBytes < stagingBytes) {
    return stop(blocker('insufficient-space',
      'Not enough free space to stage this update and keep the current app recoverable.', 'client'));
  }
  return { component, state, actionable: true };
}

/** A plan with no blockers and nothing left to acknowledge may run exactly as reviewed. */
export function updatePlanIsExecutable(plan: UpdatePlan): boolean {
  return plan.blockers.length === 0
    && plan.outstandingAcknowledgements.length === 0
    && plan.components.length > 0;
}

/**
 * Build the plan for one pinned release.
 *
 * Always returns a plan: blockers and outstanding acknowledgements ARE the
 * refusal, so a caller can show what it found, what it would do, and precisely
 * why it will not, instead of turning a "no" into an empty screen.
 */
export function planUpdates(request: PlanRequest): UpdatePlan {
  const blockers: UpdateBlocker[] = [];
  const excluded: UpdatePlan['excluded'] = [];
  const acknowledgements = new Set<UpdateAcknowledgement>(request.acknowledgements ?? []);
  const requiredAcknowledgements = new Set<UpdateAcknowledgement>();

  // Refusing an over-broad scope is cheaper than explaining it later: a phone
  // driving a remote server cannot replace a desktop on that server's host, and
  // must not be made to believe it did because a same-named app sits next to it.
  const remote = request.caller.kind !== 'local-owner';
  if (remote && request.requested.includes('client')) {
    blockers.push(blocker('desktop-out-of-scope',
      'Updating the app on the server host is not part of a remote server update.', 'client'));
    excluded.push({
      component: 'client',
      reason: blocker('desktop-out-of-scope', "Only this machine's own helper may replace its app.", 'client'),
    });
  }
  const requested = request.requested.filter((component) => !(remote && component === 'client'));

  if (!request.caller.updateGranted) {
    blockers.push(blocker('permission-required',
      'This device is not allowed to install updates on this server.', 'broker'));
  }

  const published = request.release.updater;
  const updater = supportedUpdater(published);
  if (!published) {
    // No metadata means the release never promised an internal update. Saying so
    // is honest; inferring a capability from a version number is not.
    blockers.push(blocker('release-metadata-absent',
      'The published release carries no in-app update metadata, so no internal update can be guaranteed.', 'broker',
      'Update with `cosyncing upgrade`, or rerun the installer once to enable in-app updates.'));
  } else if (!updater) {
    blockers.push(blocker('unknown-future-schema',
      `This release describes update metadata v${published.schemaVersion}, which this build cannot read, so nothing is overwritten.`,
      'broker'));
  } else if (updater.managementContractVersion > UPDATE_MANAGEMENT_CONTRACT_VERSION) {
    blockers.push(blocker('management-contract-too-old',
      `The target release needs update management v${updater.managementContractVersion}; this build serves v${UPDATE_MANAGEMENT_CONTRACT_VERSION}.`,
      'broker'));
  }

  // A release with no readable updater block cannot carry an internal update for
  // either component, so eligibility is settled here rather than component by
  // component. Reaching a per-component verdict past this point would let a
  // metadata-free feed schedule real work it never described.
  const capabilityGapped = blockers.some((entry) => entry.code === 'release-metadata-absent'
    || entry.code === 'unknown-future-schema'
    || entry.code === 'management-contract-too-old');
  const scope = capabilityGapped ? ([] as UpdateComponent[]) : requested;

  const brokerState = request.installed.broker;
  const clientState = request.installed.client;
  const verdicts = scope
    .map((component) => judgeComponent(
      component,
      component === 'broker' ? brokerState : clientState,
      request,
      blockers,
    ))
    .filter((verdict): verdict is ComponentVerdict => verdict !== undefined);

  for (const verdict of verdicts) {
    if (!verdict.actionable && verdict.excludedReason) excluded.push({ component: verdict.component, reason: verdict.excludedReason });
  }
  const actionable = verdicts.filter((verdict) => verdict.actionable).map((verdict) => verdict.component);

  const clientTarget = updater?.clientContract
    ? targetAdvert(
      updater.clientContract.revision,
      updater.clientContract.minimumBrokerRevision,
      updater.clientContract.surfaceHash,
    )
    : undefined;
  const brokerTarget = request.release.brokerContract
    ? targetAdvert(
      request.release.brokerContract.revision,
      request.release.brokerContract.minimumClientRevision,
      request.release.brokerContract.surfaceHash,
    )
    : undefined;

  const replacesBroker = actionable.includes('broker');
  const replacesClient = actionable.includes('client');

  // A pair with a blank in it is not a pair: with any contract unaccounted for the plan
  // carries the gap as a blocker and reports no compatibility at all, rather than a report
  // whose missing row would read as "nothing to worry about".
  let contractGaps = 0;
  if (actionable.length > 0) {
    // Which contract has to be known depends on what this operation replaces. Scoring a
    // candidate build that is never going to be installed is how a broker-only plan came
    // to look compatible with an app the caller was actually running.
    const needs = contractRequirements({
      replacesBroker,
      replacesClient,
      brokerState,
      clientState,
      brokerTarget,
      clientTarget,
    });
    contractGaps = needs.length;
    for (const need of needs) {
      blockers.push(blocker('contract-metadata-absent',
        `${need.what}, so compatibility with the target cannot be confirmed.`, need.component));
    }
  }

  const order = actionable.length > 0
    && actionable.includes('broker') ? (actionable.includes('client') ? undefined : ['broker'] as UpdateComponent[])
    : actionable.length > 0 ? ['client'] as UpdateComponent[] : [];

  let compatibility: UpdateCompatibilityReport | undefined;
  let decidedOrder: UpdateComponent[] = order ?? [];
  // What has to work together is what will be running together. For a job that leaves one
  // component alone, that means the build staying in place and its own advertised contract,
  // not the contract the release happens to publish for a build this host is not installing.
  const survivingClient = replacesClient ? clientTarget : clientState?.contract ?? request.clientContract;
  const survivingBroker = replacesBroker ? brokerTarget : brokerState.contract;
  if (actionable.length > 0 && !replacesClient && survivingClient === undefined) {
    // The app that will still be there when this server comes back is the caller's own build,
    // and a server cannot read a contract off a phone. Asking is the honest move: refusing
    // would make the app the only way to be unable to update.
    requiredAcknowledgements.add('compatibility-unconfirmed');
  }
  if (actionable.length > 0 && contractGaps === 0 && survivingClient && survivingBroker) {
    const currentBroker = brokerState.contract;
    const currentClient = clientState?.contract;
    const finalPair = evaluatePair(survivingClient, survivingBroker);
    const both = replacesClient && replacesBroker;
    const clientFirst = both && clientTarget && currentBroker ? evaluatePair(clientTarget, currentBroker) : null;
    const brokerFirst = both && currentClient && brokerTarget ? evaluatePair(currentClient, brokerTarget) : null;
    compatibility = {
      final: finalPair,
      clientFirst,
      brokerFirst,
      unselectedServers: (request.otherServers ?? []).map((server) => ({
        installationId: server.installationId,
        label: server.label,
        status: server.brokerContract && clientTarget
          ? evaluatePair(clientTarget, server.brokerContract).status
          : 'unknown',
        ...(server.lastSeenAt === undefined ? {} : { lastSeenAt: server.lastSeenAt }),
      })),
    };

    if (!usable(finalPair.status)) {
      const clientWord = replacesClient ? 'updated app' : 'app staying where it is';
      const brokerWord = replacesBroker ? 'updated server' : 'server staying where it is';
      blockers.push(blocker('no-safe-intermediate',
        `The ${clientWord} and the ${brokerWord} could not work together: ${finalPair.reason}`, 'broker'));
      decidedOrder = [];
    } else if (clientFirst && brokerFirst) {
      // Order follows which intermediate pair survives a failure of the second half.
      const clientFirstSafe = usable(clientFirst.status);
      const brokerFirstSafe = usable(brokerFirst.status);
      if (!clientFirstSafe && !brokerFirstSafe) {
        blockers.push(blocker('bridge-release-required',
          'Neither update order leaves a usable pair if the other half fails, and no supported bridge release is known.',
          'broker', 'Install the intermediate release named in the publish notes, then update again.'));
        decidedOrder = [];
      } else if (!brokerFirstSafe) {
        decidedOrder = ['client', 'broker'];
      } else {
        // Both orders survive; broker-first keeps the existing reconciliation preference.
        decidedOrder = ['broker', 'client'];
      }
    } else {
      decidedOrder = [...actionable];
    }

    // Unselected saved servers are weighed against the candidate client too. An
    // offline server is uncertainty the user acknowledges, not a veto on their own app.
    for (const server of request.otherServers ?? []) {
      if (!clientTarget) continue;
      if (!server.brokerContract) requiredAcknowledgements.add('compatibility-unconfirmed');
      else if (!usable(evaluatePair(clientTarget, server.brokerContract).status)) {
        requiredAcknowledgements.add('unselected-servers-unusable');
      }
    }
  }

  if (actionable.includes('client')) requiredAcknowledgements.add('app-will-close');
  if (actionable.includes('broker')) requiredAcknowledgements.add('server-will-disconnect');
  if (actionable.length > 0 && request.environment?.busyState !== undefined
      && request.environment.busyState !== 'idle') {
    requiredAcknowledgements.add('interruption-during-work');
  }

  const componentImpacts = (component: UpdateComponent): UpdateAcknowledgement[] =>
    [...requiredAcknowledgements].filter((impact) => impact !== (component === 'client'
      ? 'server-will-disconnect'
      : 'app-will-close'));

  const planned: UpdatePlannedComponent[] = actionable.map((component) => {
    const state = (component === 'broker' ? brokerState : clientState)!;
    return {
      component,
      from: { ...state.running },
      to: { version: request.release.version, releaseId: request.release.releaseId },
      order: Math.max(0, decidedOrder.indexOf(component)),
      impacts: componentImpacts(component),
      ...(request.release.downloadBytes?.[component] === undefined
        ? {}
        : { downloadBytes: request.release.downloadBytes[component] }),
    };
  });

  return {
    schemaVersion: 1,
    planId: request.planId(),
    releaseId: request.release.releaseId,
    installationId: request.installationId,
    installationGeneration: request.installationGeneration,
    expiresAt: new Date(request.nowMs + (request.ttlMs ?? UPDATE_PLAN_DEFAULT_TTL_MS)).toISOString(),
    components: planned,
    order: decidedOrder,
    requiredAcknowledgements: [...requiredAcknowledgements],
    outstandingAcknowledgements: [...requiredAcknowledgements].filter((ack) => !acknowledgements.has(ack)),
    blockers,
    excluded,
    compatibility: compatibility ?? null,
    updateManagementVersion: UPDATE_MANAGEMENT_CONTRACT_VERSION,
  };
}
