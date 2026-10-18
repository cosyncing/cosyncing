/**
 * The update planner's compatibility and ordering matrix.
 *
 * Every case here is a pair of installed builds plus one pinned release, and the
 * assertion is about what the plan commits IN ORDER, not about which strings the
 * planner produced. Versions and revisions are arbitrary fixture identities;
 * nothing in production code reads them, and a case named R0/R1/R2 means
 * "older, target, and a later one that appeared mid-flight" and nothing more.
 */
import { expect, test } from 'bun:test';
import type { UpdateAcknowledgement, UpdateBlockerCode, UpdateBuildIdentity, UpdateComponent, UpdateContractAdvert } from '@cosyncing/protocol';
import {
  planUpdates,
  updatePlanIsExecutable,
  type InstalledComponentState,
  type PinnedRelease,
  type PlanRequest,
  type SavedServerObservation,
} from './update-planner.ts';
/** Build a new updater block from an existing one without tripping the supported/unsupported union. */
function withClientContract(
  block: ReleaseUpdaterMetadata,
  clientContract: { revision: number; minimumBrokerRevision: number; surfaceHash: string },
): ReleaseUpdaterMetadata {
  const next: ReleaseUpdaterMetadata = { ...block };
  next.clientContract = clientContract;
  return next;
}

import type { ReleaseUpdaterMetadata } from './updater-metadata.ts';

/** Fixture contract identities. Equal revision means equal surface, as real peers advertise. */
const surface = (revision: number): string => `fnv1a32:${revision.toString(16).padStart(8, '0')}`;
const brokerAdvert = (revision: number, minimumClientRevision: number): UpdateContractAdvert => ({
  revision,
  minimumPeerRevision: minimumClientRevision,
  surfaceHash: surface(revision),
});
const clientAdvert = (revision: number, minimumBrokerRevision: number): UpdateContractAdvert => ({
  revision,
  minimumPeerRevision: minimumBrokerRevision,
  surfaceHash: surface(revision),
});

const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const LINUX_HOST = { platform: 'linux', arch: 'x64' } as const;
const build = (version: string): UpdateBuildIdentity => ({ version });

const DESKTOP_CAPABILITIES = ['prepare', 'client-replace', 'client-relaunch', 'broker-restart'] as const;

function updaterFor(options: {
  version: string;
  sourceCommit: string;
  clientRevision?: number;
  clientMinimumBrokerRevision?: number;
  managementContractVersion?: number;
  minimumHelperVersion?: string;
  runtimeFloor?: string;
  stagingBytes?: number;
  capabilities?: readonly string[];
  hosts?: readonly string[];
  schemaVersion?: number;
  omitClientContract?: boolean;
}): ReleaseUpdaterMetadata {
  const hosts = options.hosts ?? ['linux-x64'];
  const desktop: NonNullable<ReleaseUpdaterMetadata['desktop']> = {};
  for (const host of hosts) {
    desktop[host as keyof typeof desktop] = {
      ...(options.runtimeFloor === undefined ? {} : { minimumRuntimeVersion: options.runtimeFloor }),
      ...(options.stagingBytes === undefined ? {} : { stagingBytes: options.stagingBytes }),
      capabilities: (options.capabilities ?? DESKTOP_CAPABILITIES) as ReleaseUpdaterMetadata['desktop'] extends undefined
        ? never
        : string[],
    } as never;
  }
  return {
    schemaVersion: (options.schemaVersion ?? 1) as 1,
    releaseId: `rel-${options.version}+${options.sourceCommit}`,
    managementContractVersion: options.managementContractVersion ?? 1,
    minimumHelperVersion: options.minimumHelperVersion ?? '1.0.0',
    ...(options.omitClientContract || options.clientRevision === undefined
      ? {}
      : {
        clientContract: {
          revision: options.clientRevision,
          minimumBrokerRevision: options.clientMinimumBrokerRevision ?? 1,
          surfaceHash: surface(options.clientRevision),
        },
      }),
    ...(hosts.length > 0 ? { desktop } : {}),
  };
}

/** The reference situation: both components one release behind, and either order is safe. */
function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  const release: PinnedRelease = {
    releaseId: 'rel-1.1.0+bbbbbbb',
    version: '1.1.0',
    brokerContract: { revision: 11, minimumClientRevision: 10, surfaceHash: surface(11) },
    updater: updaterFor({
      version: '1.1.0',
      sourceCommit: 'bbbbbbb',
      clientRevision: 11,
      clientMinimumBrokerRevision: 10,
      runtimeFloor: '1.3.0',
      stagingBytes: 1_000,
    }),
    downloadBytes: { broker: 4_096, client: 65_536 },
    webSidecarIncluded: true,
  };
  const broker: InstalledComponentState = {
    component: 'broker',
    ...LINUX_HOST,
    ownership: 'cosyncing-installer',
    running: build('1.0.0'),
    contract: brokerAdvert(10, 9),
    updateManagementVersion: 1,
  };
  const client: InstalledComponentState = {
    component: 'client',
    ...LINUX_HOST,
    ownership: 'cosyncing-installer',
    running: build('1.0.0'),
    contract: clientAdvert(10, 9),
  };
  return {
    nowMs: NOW,
    planId: () => 'plan-1',
    installationId: 'inst-a',
    installationGeneration: 1,
    caller: { kind: 'local-owner', updateGranted: true },
    requested: ['broker', 'client'],
    installed: { broker, client },
    release,
    environment: { helperVersion: '1.0.0', runtimeVersion: '1.3.14', freeBytes: 1_000_000, busyState: 'idle' },
    ...overrides,
  };
}

const codes = (plan: ReturnType<typeof planUpdates>): UpdateBlockerCode[] => plan.blockers.map((blocker) => blocker.code);
const actionable = (plan: ReturnType<typeof planUpdates>): UpdateComponent[] => plan.components.map((component) => component.component);

test('both behind with either order safe stages both and commits broker first', () => {
  const plan = planUpdates(request());
  expect(codes(plan)).toEqual([]);
  expect(plan.order).toEqual(['broker', 'client']);
  expect(actionable(plan)).toEqual(['broker', 'client']);
  expect(plan.components.map((component) => component.order)).toEqual([0, 1]);
  expect(plan.components.find((component) => component.component === 'broker')?.to.version).toBe('1.1.0');
  expect(plan.components.find((component) => component.component === 'client')?.from.version).toBe('1.0.0');
  expect(updatePlanIsExecutable(plan)).toBe(false); // the close/disconnect consent is still outstanding
  expect(plan.outstandingAcknowledgements).toEqual(expect.arrayContaining(['app-will-close', 'server-will-disconnect']));
});

test('the reviewed plan runs with no second prompt once its impacts are acknowledged', () => {
  const acknowledgements: UpdateAcknowledgement[] = ['app-will-close', 'server-will-disconnect'];
  const plan = planUpdates(request({ acknowledgements }));
  expect(plan.outstandingAcknowledgements).toEqual([]);
  expect(updatePlanIsExecutable(plan)).toBe(true);
});

test('a current broker with a behind app is a client-only job that never names the broker', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['broker', 'client'],
    installed: {
      ...base.installed,
      broker: { ...base.installed.broker, running: build('1.1.0'), contract: brokerAdvert(11, 10) },
    },
  });
  expect(codes(plan)).toEqual([]);
  expect(actionable(plan)).toEqual(['client']);
  expect(plan.order).toEqual(['client']);
  expect(plan.excluded.map((row) => row.component)).toEqual(['broker']);
});

test('a current app with a behind broker is a broker-only job that does not close the app', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    installed: {
      ...base.installed,
      client: { ...base.installed.client!, component: 'client', running: build('1.1.0'), contract: clientAdvert(11, 10) },
    },
  });
  expect(codes(plan)).toEqual([]);
  expect(actionable(plan)).toEqual(['broker']);
  expect(plan.order).toEqual(['broker']);
  expect(plan.requiredAcknowledgements).toEqual(['server-will-disconnect']);
});

test('only the client-first intermediate pair is safe, so the client commits first', () => {
  // Target broker refuses the current client, so committing the broker first would
  // strand an app that could fail to update afterwards.
  const base = request();
  const release = {
    ...base.release,
    brokerContract: { revision: 11, minimumClientRevision: 11, surfaceHash: surface(11) },
  };
  const plan = planUpdates({ ...base, release });
  expect(codes(plan)).toEqual([]);
  expect(plan.order).toEqual(['client', 'broker']);
  expect(plan.compatibility?.clientFirst?.status).toBe('broker-behind');
  expect(plan.compatibility?.brokerFirst?.status).toBe('hard-incompatible');
});

test('only the broker-first intermediate pair is safe, so the broker commits first', () => {
  const base = request();
  const release = {
    ...base.release,
    updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, clientMinimumBrokerRevision: 11 }),
  };
  const plan = planUpdates({ ...base, release });
  expect(codes(plan)).toEqual([]);
  expect(plan.order).toEqual(['broker', 'client']);
  expect(plan.compatibility?.clientFirst?.status).toBe('hard-incompatible');
  expect(plan.compatibility?.brokerFirst?.status).toBe('client-behind');
});

test('no safe intermediate pair is a bridge requirement, not a forced rollout', () => {
  const base = request();
  const release = {
    ...base.release,
    brokerContract: { revision: 11, minimumClientRevision: 11, surfaceHash: surface(11) },
    updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, clientMinimumBrokerRevision: 11 }),
  };
  const plan = planUpdates({ ...base, release });
  expect(codes(plan)).toEqual(['bridge-release-required']);
  expect(plan.order).toEqual([]);
  expect(updatePlanIsExecutable(plan)).toBe(false);
  expect(plan.blockers[0]?.guidance).toContain('intermediate release');
});

test('an unusable final pair stops the plan before any component is scheduled', () => {
  const base = request();
  const release = {
    ...base.release,
    updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 13, clientMinimumBrokerRevision: 12 }),
  };
  const plan = planUpdates({ ...base, release });
  expect(codes(plan)).toEqual(['no-safe-intermediate']);
  expect(plan.order).toEqual([]);
});

test('equal revisions with different surfaces are an incompatibility, not a rounding error', () => {
  const base = request();
  const release = {
    ...base.release,
    updater: {
      ...updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, clientMinimumBrokerRevision: 10 }),
      clientContract: { revision: 11, minimumBrokerRevision: 10, surfaceHash: 'fnv1a32:deadbeef' },
    },
  };
  const plan = planUpdates({ ...base, release });
  expect(codes(plan)).toEqual(['no-safe-intermediate']);
  expect(plan.compatibility?.final.reason).toContain('different public surfaces');
});

test('a release with no updater metadata promises no internal update and names the supported path', () => {
  const base = request();
  const plan = planUpdates({ ...base, release: { ...base.release, updater: undefined } });
  expect(codes(plan)).toEqual(['release-metadata-absent']);
  expect(actionable(plan)).toEqual([]);
  expect(updatePlanIsExecutable(plan)).toBe(false);
  expect(plan.blockers.find((blocker) => blocker.code === 'release-metadata-absent')?.guidance).toContain('cosyncing upgrade');
});

test('a newer updater schema is refused without touching the journal', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    release: { ...base.release, updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', schemaVersion: 7, clientRevision: 11 }) },
  });
  expect(codes(plan)).toEqual(['unknown-future-schema']);
});

test('a release needing a newer management contract is a typed prerequisite', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    release: { ...base.release, updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, managementContractVersion: 9 }) },
  });
  expect(codes(plan)).toEqual(['management-contract-too-old']);
});

test('an unproven ownership blocks only the component it describes', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    installed: { ...base.installed, client: { ...base.installed.client!, component: 'client', ownership: 'unknown' } },
  });
  expect(codes(plan)).toEqual(['ownership-unproven']);
  expect(actionable(plan)).toEqual(['broker']);
  expect(plan.order).toEqual(['broker']);
});

test('a package-manager-owned broker reports guidance instead of offering a commit', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['broker'],
    installed: { ...base.installed, broker: { ...base.installed.broker, ownership: 'package-manager' } },
  });
  const [only] = plan.blockers;
  expect(only?.code).toBe('package-manager-owned');
  expect(only?.guidance).toContain('https://cosyncing.com/#install');
  expect(actionable(plan)).toEqual([]);
});

test('a remote caller cannot pull the server host desktop into a server update', () => {
  const base = request();
  const plan = planUpdates({ ...base, caller: { kind: 'remote-peer', updateGranted: true } });
  expect(codes(plan)).toEqual(['desktop-out-of-scope']);
  expect(actionable(plan)).toEqual(['broker']);
  expect(plan.excluded.map((row) => row.component)).toEqual(['client']);
});

test('a paired device without the update grant is refused authority, not connectivity', () => {
  const base = request();
  const plan = planUpdates({ ...base, requested: ['broker'], caller: { kind: 'remote-peer', updateGranted: false } });
  expect(codes(plan)).toEqual(['permission-required']);
  expect(updatePlanIsExecutable(plan)).toBe(false);
});

test('an app ahead of the channel is reported and never walked backwards', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['client'],
    installed: { ...base.installed, client: { ...base.installed.client!, running: build('9.9.9') } },
  });
  expect(codes(plan)).toEqual([]);
  expect(actionable(plan)).toEqual([]);
  expect(plan.excluded[0]?.reason.detail).toContain('newer than the published release');
});

test('an unstamped build is uncertainty, not a missing update', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['client'],
    installed: { ...base.installed, client: { ...base.installed.client!, running: build('0.0.0-dev') } },
  });
  expect(codes(plan)).toEqual(['identity-mismatch']);
});

test('a helper that can replace but not reopen cannot meet the desktop promise', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    release: {
      ...base.release,
      updater: updaterFor({
        version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, capabilities: ['prepare', 'client-replace'],
      }),
    },
  });
  expect(codes(plan)).toEqual(['helper-missing']);
});

test('a helper older than the release requirement blocks the client only', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    release: { ...base.release, updater: updaterFor({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientRevision: 11, minimumHelperVersion: '2.0.0' }) },
    environment: { ...base.environment, helperVersion: '1.0.0' },
  });
  expect(codes(plan)).toEqual(['helper-too-old']);
  expect(actionable(plan)).toEqual(['broker']);
});

test('a runtime below the signed floor is a typed prerequisite, never a silent interpreter download', () => {
  const base = request();
  const plan = planUpdates({ ...base, environment: { ...base.environment, runtimeVersion: '1.2.0' } });
  expect(codes(plan)).toEqual(['runtime-below-floor']);
});

test('an unknown runtime never satisfies a floor', () => {
  const base = request();
  const environment = { ...base.environment };
  delete environment.runtimeVersion;
  const plan = planUpdates({ ...base, environment });
  expect(codes(plan)).toEqual(['runtime-below-floor']);
});

test('a host with no staged space cannot lose its only recoverable copy', () => {
  const base = request();
  const plan = planUpdates({ ...base, environment: { ...base.environment, freeBytes: 10 } });
  expect(codes(plan)).toEqual(['insufficient-space']);
});

test('a platform the release does not publish is unsupported, not broken', () => {
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['client'],
    installed: {
      ...base.installed,
      client: { ...base.installed.client!, component: 'client', platform: 'linux', arch: 'arm64' },
    },
  });
  expect(codes(plan)).toEqual(['unsupported-platform']);
});

test('a known-incompatible unselected server needs an explicit acknowledgement', () => {
  const base = request();
  const otherServers: SavedServerObservation[] = [
    { installationId: 'inst-b', label: 'Lab server', brokerContract: brokerAdvert(20, 19), lastSeenAt: 'x' },
  ];
  const plan = planUpdates({ ...base, otherServers });
  expect(plan.requiredAcknowledgements).toContain('unselected-servers-unusable');
  expect(plan.compatibility?.unselectedServers[0]?.status).toBe('hard-incompatible');
  const accepted = planUpdates({ ...base, otherServers, acknowledgements: ['unselected-servers-unusable', 'app-will-close', 'server-will-disconnect'] });
  expect(accepted.outstandingAcknowledgements).toEqual([]);
  expect(updatePlanIsExecutable(accepted)).toBe(true);
});

test('an offline server is uncertainty the user accepts, not a veto on their own app', () => {
  const base = request();
  const otherServers: SavedServerObservation[] = [{ installationId: 'inst-c', label: 'Laptop' }];
  const plan = planUpdates({ ...base, otherServers });
  expect(plan.requiredAcknowledgements).toContain('compatibility-unconfirmed');
  expect(codes(plan)).toEqual([]);
  expect(plan.compatibility?.unselectedServers[0]?.status).toBe('unknown');
});

test('unknown maintenance readiness keeps work running rather than proceeding', () => {
  const base = request();
  for (const busyState of ['busy', 'unknown'] as const) {
    const plan = planUpdates({ ...base, environment: { ...base.environment, busyState } });
    expect(plan.requiredAcknowledgements).toContain('interruption-during-work');
    expect(updatePlanIsExecutable(plan)).toBe(false);
  }
});

test('a plan expires so a stale review cannot be replayed, and honourable lifetimes are respected', () => {
  expect(planUpdates(request()).expiresAt).toBe(new Date(NOW + 15 * 60 * 1000).toISOString());
  expect(planUpdates(request({ ttlMs: 1_000 })).expiresAt).toBe(new Date(NOW + 1_000).toISOString());
});

test('a missing contract identity on either side is unknown compatibility, never a guessed safe pair', () => {
  const base = request();
  const noBrokerContract = planUpdates({
    ...base,
    installed: { ...base.installed, broker: { ...base.installed.broker, contract: undefined } },
  });
  expect(codes(noBrokerContract)).toContain('contract-metadata-absent');
  expect(noBrokerContract.compatibility).toBeNull();

  const stripped = { ...base.release.updater! } as ReleaseUpdaterMetadata;
  delete stripped.clientContract;
  const noClientContract = planUpdates({ ...base, release: { ...base.release, updater: stripped } });
  expect(codes(noClientContract)).toContain('contract-metadata-absent');
});

test('a broker-only plan is judged against the app that stays installed', () => {
  const base = request();
  // A server cannot read the contract of the app asking it to restart. With nothing to score
  // it asks the person instead of guessing -- uncertainty is acknowledged, never assumed safe.
  const blind = planUpdates({
    ...base,
    requested: ['broker'],
    installed: { broker: base.installed.broker },
    acknowledgements: ['server-will-disconnect'],
  });
  expect(codes(blind)).toEqual([]);
  expect(blind.compatibility).toBeNull();
  expect(blind.outstandingAcknowledgements).toEqual(['compatibility-unconfirmed']);
  expect(updatePlanIsExecutable(blind)).toBe(false);

  // What the caller advertises IS the client half of this pair, because it is the client
  // that will still be there when the server comes back.
  const advertised = planUpdates({
    ...base,
    requested: ['broker'],
    installed: { broker: base.installed.broker },
    clientContract: clientAdvert(10, 9),
    acknowledgements: ['server-will-disconnect'],
  });
  expect(codes(advertised)).toEqual([]);
  expect(actionable(advertised)).toEqual(['broker']);
  expect(advertised.outstandingAcknowledgements).toEqual([]);
  expect(updatePlanIsExecutable(advertised)).toBe(true);
  expect(advertised.compatibility?.final.client).toEqual(clientAdvert(10, 9));
  expect(advertised.compatibility?.final.broker).toEqual({ revision: 11, minimumPeerRevision: 10, surfaceHash: surface(11) });
});

test('a broker whose successor requires a newer app is refused, not scored against an app nobody has', () => {
  // The release's candidate app would have been compatible with its own candidate broker,
  // and the plan would have been executable while the app driving it could not talk to the
  // server it had just restarted.
  const base = request();
  const plan = planUpdates({
    ...base,
    requested: ['broker'],
    installed: { broker: base.installed.broker },
    clientContract: clientAdvert(10, 9),
    acknowledgements: ['server-will-disconnect'],
    release: {
      ...base.release,
      brokerContract: { revision: 11, minimumClientRevision: 11, surfaceHash: surface(11) },
    },
  });
  expect(codes(plan)).toContain('no-safe-intermediate');
  expect(updatePlanIsExecutable(plan)).toBe(false);
  expect(plan.order).toEqual([]);
  expect(plan.compatibility?.final.reason).toContain('older than broker minimum 11');
});

test('download sizes come from the release and are absent rather than invented', () => {
  const base = request();
  expect(planUpdates(base).components.find((component) => component.component === 'client')?.downloadBytes).toBe(65_536);
  const stripped = planUpdates({ ...base, release: { ...base.release, downloadBytes: undefined } });
  expect(stripped.components.every((component) => component.downloadBytes === undefined)).toBe(true);
});

test('the plan pins the release it was built for and carries the installation generation', () => {
  const plan = planUpdates(request());
  expect(plan.releaseId).toBe('rel-1.1.0+bbbbbbb');
  expect(plan.installationId).toBe('inst-a');
  expect(plan.installationGeneration).toBe(1);
});
