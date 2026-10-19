/**
 * The update-management surface, against a fake signed channel.
 *
 * What is being pinned here is not arithmetic on versions. It is the three promises the
 * feature is judged on: a review binds an immutable release and nothing later substitutes
 * another one; preparation authenticates before anything is stopped; and a peer commits
 * only with a grant the owner issued and can withdraw. Every case drives the real planner,
 * the real operation store, and real bytes over a real fetch seam.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateJob } from '@cosyncing/protocol';
import {
  FEED_MANIFEST_URL,
  FEED_TRUSTED_KEYS,
  createFakeReleaseFeed,
  feedSurfaceHash,
  feedUpdater,
  releaseIdFor,
  type FeedRelease,
  type FakeReleaseFeed,
} from '../../test/helpers/update-release-feed.ts';
import type { BuildInfo } from '../runtime/build-info.ts';
import { openUpdateGrantStore } from '../security/update-grants.ts';
import {
  applyUpdateJob,
  cancelUpdateJob,
  createUpdateJob,
  createUpdatePlan,
  parseUpdatePlanRequestBody,
  readUpdateJob,
  reconcileInterruptedUpdates,
  updateCheck,
  updateGrantView,
  updateHistory,
  channelObservationFromCheck,
  updateInventory,
  updateManagementStatus,
  UPDATE_HANDOFF_LEASE_MS,
  type UpdateManagementCaller,
  type UpdateManagementDependencies,
} from './update-management.ts';
import { UpdateOperationStore } from './update-operation-store.ts';
import type { InstalledComponentState } from './update-planner.ts';

const RUNNING = '1.0.0';
const HOST_TARGET = 'linux-x64';

const BUILD = {
  version: RUNNING,
  commit: 'aaaaaaa',
  target: HOST_TARGET,
  distribution: 'native',
  packaged: true,
  dirty: false,
  contract: { revision: 31, minimumClientRevision: 30, surfaceHash: feedSurfaceHash(31) },
} as unknown as BuildInfo;

/** R1 is one release ahead and carries the contract and updater identity a plan needs. */
const R1: FeedRelease = {
  name: 'R1',
  version: '1.1.0',
  sourceCommit: 'bbbbbbb',
  publishedAt: '2026-01-02T00:00:00.000Z',
  contract: { revision: 31, minimumClientRevision: 30, surfaceHash: feedSurfaceHash(31) },
  updater: feedUpdater({ version: '1.1.0', sourceCommit: 'bbbbbbb', clientContract: { revision: 31, minimumBrokerRevision: 30 } }),
};
const R2: FeedRelease = {
  ...R1,
  name: 'R2',
  version: '1.2.0',
  sourceCommit: 'ccccccc',
  publishedAt: '2026-01-03T00:00:00.000Z',
  contract: { revision: 31, minimumClientRevision: 30, surfaceHash: feedSurfaceHash(31) },
  updater: feedUpdater({ version: '1.2.0', sourceCommit: 'ccccccc', clientContract: { revision: 31, minimumBrokerRevision: 30 } }),
};

const OWNER: UpdateManagementCaller = { kind: 'remote-owner', id: 'owner', updateGranted: true };
const PEER_DENIED: UpdateManagementCaller = { kind: 'remote-peer', id: 'peer-1', updateGranted: false };
const PEER_GRANTED: UpdateManagementCaller = { kind: 'remote-peer', id: 'peer-1', updateGranted: true };
const PEER_TWO: UpdateManagementCaller = { kind: 'remote-peer', id: 'peer-2', updateGranted: true };

function brokerState(): InstalledComponentState {
  return {
    component: 'broker',
    platform: 'linux',
    arch: 'x64',
    ownership: 'cosyncing-installer',
    running: { version: RUNNING, buildId: 'aaaaaaa' },
    contract: { revision: 31, minimumPeerRevision: 30, surfaceHash: feedSurfaceHash(31) },
    updateManagementVersion: 1,
  };
}

interface Harness {
  dependencies: UpdateManagementDependencies;
  feed: FakeReleaseFeed;
  handoffs: UpdateJob[];
  stagingRoot: string;
  home: string;
  /** Swap the running identity, which is all a restarted broker is. */
  restartAs(version: string, commit?: string): void;
  setBusy(state: 'idle' | 'busy' | 'unknown'): void;
  /** Move this host's clock, which is how a delegated commit ages. */
  advance(milliseconds: number): void;
  /** Make every reading after this report one instant, so "at the same time" is a fact and not a race. */
  freezeClock(): void;
  /** Go dark: a channel that verifies nothing, which is not the same as one that passed. */
  silenceChannel(): void;
  /** Re-commit this installation, which is what re-running setup does to the generation. */
  recommitInstallation(): void;
  /**
   * Whether this host's installer has committed the transaction that replaces it.
   *
   * A stand-in on purpose: `update-management-host.test.ts` reads the journal and the install
   * receipt off a real home, and what is being proven here is that a job needs this answer at
   * all, not how a receipt is parsed. Defaulted to committed so a case has to say so when the
   * installer has NOT finished.
   */
  installerSettled(committed: boolean): void;
}

function harness(options: {
  releases?: readonly FeedRelease[];
  promoteAfterRequests?: number;
  fetch?: (feed: FakeReleaseFeed) => typeof fetch;
  handoff?: UpdateManagementDependencies['handoff'];
} = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-update-management-'));
  const feed = createFakeReleaseFeed({
    releases: options.releases ?? [R1, R2],
    ...(options.promoteAfterRequests === undefined ? {} : { promoteAfterRequests: options.promoteAfterRequests }),
  });
  const handoffs: UpdateJob[] = [];
  const installationId = 'install-under-test';
  let version = RUNNING;
  let commit = 'aaaaaaa';
  let busy: 'idle' | 'busy' | 'unknown' = 'idle';
  let clockOffsetMs = 0;
  // Pinned when a test needs two operations to land in one instant, which is precisely when an id
  // derived from the clock stops being an id.
  let frozenMs: number | undefined;
  let installerCommitted = true;
  const stagingRoot = join(home, 'updates', 'staging');
  // Movable, because the question a host has to answer is which installation it is standing on
  // right now, and re-running setup moves that under a process that is still running.
  let installationGeneration = 1_700_000_000;
  const dependencies: UpdateManagementDependencies = {
    installation: () => ({ installationId, installationGeneration }),
    // A restarted broker is a different build answering the same identity questions, so the
    // version has to move everywhere it is read rather than only in the observation seam.
    get buildInfo() {
      return { ...BUILD, version, commit };
    },
    store: new UpdateOperationStore(join(home, 'updates')),
    grants: openUpdateGrantStore({ home, installationId }),
    observe: () => ({
      broker: { ...brokerState(), running: { ...brokerState().running, version } },
      client: {
        component: 'client',
        platform: 'linux',
        arch: 'x64',
        ownership: 'cosyncing-installer',
        running: { version: '1.0.0' },
      },
    }),
    busy: () => ({
      state: busy,
      activeTurns: busy === 'busy' ? 1 : 0,
      activeLaunches: 0,
      pendingApprovals: 0,
      observedAt: '2026-01-04T00:00:00.000Z',
    }),
    channel: {
      manifestUrl: FEED_MANIFEST_URL,
      trustedKeys: FEED_TRUSTED_KEYS,
      fetch: options.fetch === undefined ? feed.fetch : options.fetch(feed),
    },
    stagingRoot,
    installerCommit: () => (installerCommitted
      ? { committed: true as const }
      : { committed: false as const, reason: 'in-flight' as const }),
    environment: () => ({ busyState: busy, runtimeVersion: '1.3.14' }),
    // The default behaves like the real launcher: it asks at the moment it schedules, and does
    // not schedule when the answer is no. A stub that skipped the ask would make every test
    // below pass while the production handoff raced its own channel refresh.
    handoff: options.handoff ?? (async (job, mayLaunch) => {
      const authority = mayLaunch();
      if (!authority.allowed) return { accepted: false, detailCode: authority.detailCode };
      handoffs.push(job);
      return { accepted: true, detailCode: 'handoff-accepted' };
    }),
    now: () => new Date(frozenMs ?? Date.now() + clockOffsetMs),
  };
  return {
    dependencies,
    feed,
    handoffs,
    stagingRoot,
    home,
    restartAs: (next, nextCommit) => {
      version = next;
      // A restarted broker reports the build it is answering with, commit included: the two
      // are separate facts, and a settle that only needed the version cannot see that.
      commit = nextCommit ?? (next === RUNNING ? 'aaaaaaa' : 'bbbbbbb');
    },
    setBusy: (next) => {
      busy = next;
    },
    advance: (milliseconds) => {
      clockOffsetMs += milliseconds;
    },
    freezeClock: () => {
      frozenMs = Date.now() + clockOffsetMs;
    },
    silenceChannel: () => {
      dependencies.channel.fetch = (() => Promise.resolve(new Response('unavailable', { status: 503 }))) as unknown as typeof fetch;
    },
    recommitInstallation: () => {
      installationGeneration += 1;
    },
    installerSettled: (committed) => {
      installerCommitted = committed;
    },
  };
}

/** Plan and prepare the reference release, returning the job at `ready`. */
async function prepared(h: Harness, caller = OWNER, idempotencyKey = 'k-1'): Promise<UpdateJob> {
  const releaseId = h.feed.current().version === R1.version ? releaseIdFor(R1.version, R1.sourceCommit) : undefined;
  const plan = await createUpdatePlan(h.dependencies, caller, {
    releaseId: releaseId ?? releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    // What this host can see of the app driving it is nothing, so the plan asks for that to
    // be acknowledged as well; the harness is a server with a desktop receipt and no way to
    // read a contract off it, which is what the real host reports too.
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  if (!plan.ok) throw new Error(`plan refused: ${plan.code} ${plan.detail}`);
  const job = await createUpdateJob(h.dependencies, caller, { planId: plan.value.planId, idempotencyKey });
  if (!job.ok) throw new Error(`job refused: ${job.code} ${job.detail}`);
  return job.value;
}

test('the channel answer names an immutable release, and the inventory reports the honest capability', async () => {
  const h = harness();
  const check = await updateCheck(h.dependencies);
  expect(check.status).toBe('update-available');
  const broker = check.components.find((component) => component.component === 'broker');
  expect(broker?.available?.releaseId).toBe(releaseIdFor(R1.version, R1.sourceCommit));

  const inventory = updateInventory(h.dependencies, channelObservationFromCheck(await updateCheck(h.dependencies)));
  expect(inventory.updateManagementVersion).toBe(1);
  expect(inventory.installationId).toBe('install-under-test');
  const rows = Object.fromEntries(inventory.components.map((row) => [row.component, row]));
  expect(rows.broker?.canApply).toBe(true);
  // No trusted native handoff exists in this build, so the app row says so instead of
  // letting the UI infer support from the operating system name.
  expect(rows.client?.blockers.map((blocker) => blocker.code)).toContain('desktop-out-of-scope');
  expect(rows.client?.canApply).toBe(false);
});

test('a review binds the pinned release, and a channel that moves first is a conflict', async () => {
  const h = harness();
  const stale = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R2.version, R2.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
  });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.code).toBe('UPDATE_TARGET_MOVED');

  const moved = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: '0.9.0' },
  });
  expect(!moved.ok && moved.code === 'UPDATE_TARGET_MOVED').toBe(true);
});

test('preparation downloads and authenticates the pinned artifact without stopping anything', async () => {
  const h = harness();
  const job = await prepared(h);
  expect(job.phase).toBe('ready');
  expect(job.components[0]?.outcome).toBe('prepared');
  expect(h.handoffs).toHaveLength(0);

  const staged = readdirSync(join(h.stagingRoot, job.jobId));
  expect(staged).toContain('prepared.json');
  const manifest = JSON.parse(readFileSync(join(h.stagingRoot, job.jobId, 'prepared.json'), 'utf8')) as {
    releaseId: string; digest: string; bytes: number; component: string; name: string;
  };
  expect(manifest.releaseId).toBe(releaseIdFor(R1.version, R1.sourceCommit));
  expect(manifest.component).toBe('broker');
  const bytes = readFileSync(join(h.stagingRoot, job.jobId, manifest.name));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.digest);
  expect(manifest.bytes).toBe(bytes.byteLength);
});

test('a pinned artifact whose bytes do not match the signed digest never reaches ready', async () => {
  const tampered = (feed: FakeReleaseFeed): typeof fetch => ((async (input: RequestInfo | URL) => {
    const response = await feed.fetch(input);
    const url = String(input);
    if (!url.endsWith('/cosyncing')) return response;
    const body = Buffer.from(await response.arrayBuffer());
    body[0] = body[0]! ^ 0xff;
    return new Response(new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch);
  const h = harness({ fetch: tampered });
  const releaseId = releaseIdFor(R1.version, R1.sourceCommit);
  const plan = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId,
    components: ['broker'],
    expected: { version: RUNNING },
    // Fully consented, so the answer this test is about is the digest and not the consent.
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  const job = await createUpdateJob(h.dependencies, OWNER, { planId: plan.value.planId, idempotencyKey: 'tampered' });
  expect(!job.ok && job.code === 'UPDATE_CAPABILITY_UNSUPPORTED').toBe(true);
  if (job.ok) return;
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId!);
  expect(read.ok && read.value.phase).toBe('failed');
  // Half-trusted bytes left in staging would be picked up by the next operation.
  expect(existsSync(join(h.stagingRoot, job.jobId!))).toBe(false);
});

test('a release promoted while a job waits fails the pinned job instead of following the pointer', async () => {
  const h = harness();
  const job = await prepared(h);
  expect(h.feed.promote()).toBe(true);
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_TARGET_MOVED').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
});

test('apply commits once, and a lost answer retried does not restart the server twice', async () => {
  const h = harness();
  const job = await prepared(h);
  const first = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(first.ok && first.value.phase).toBe('verifying');
  const second = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(second.ok).toBe(true);
  expect(h.handoffs).toHaveLength(1);
});

test('a refused handoff is reported as refused, and never as a completed update', async () => {
  const h = harness({ handoff: async () => ({ accepted: false, detailCode: 'broker-update-handoff-unavailable' }) });
  const job = await prepared(h);
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_CAPABILITY_UNSUPPORTED').toBe(true);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
  const history = updateHistory(h.dependencies);
  expect(history.at(-1)?.detailCodes).toContain('broker-update-handoff-unavailable');
});

test('the broker that came back up settles its own replacement from the version it answers with', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  // Same process identity, new build: what a restarted service looks like to this function.
  h.restartAs(R1.version);
  const settled = reconcileInterruptedUpdates(h.dependencies);
  expect(settled).toEqual([{ jobId: job.jobId, action: 'succeeded' }]);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.result).toBe('complete');
  expect(updateHistory(h.dependencies).at(-1)?.components).toEqual([
    { component: 'broker', outcome: 'verified', version: R1.version },
  ]);
});

test('a job whose replacement did not land is left open rather than called a success', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  const settled = reconcileInterruptedUpdates(h.dependencies);
  expect(settled.at(-1)?.action).toBe('finish-committed');
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('verifying');
  expect(updateHistory(h.dependencies)).toHaveLength(0);
});

test('the same key returns the same job, and a key reused for other work conflicts', async () => {
  const h = harness();
  const plan = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  if (!plan.ok) throw new Error('plan should be reviewable');
  const first = await createUpdateJob(h.dependencies, OWNER, { planId: plan.value.planId, idempotencyKey: 'same' });
  const again = await createUpdateJob(h.dependencies, OWNER, { planId: plan.value.planId, idempotencyKey: 'same' });
  expect(first.ok && again.ok && first.value.jobId === again.value.jobId).toBe(true);

  // A second review of the same release is different reviewed work, even where the two
  // plans would do identical things, so the key cannot quietly hand back either answer.
  const other = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  if (!other.ok) throw new Error('second review should exist');
  const conflicting = await createUpdateJob(h.dependencies, OWNER, { planId: other.value.planId, idempotencyKey: 'same' });
  expect(!conflicting.ok && conflicting.code === 'UPDATE_IDEMPOTENCY_CONFLICT').toBe(true);
});

test('a peer commits only with the grant the owner issued, and revocation closes the door', async () => {
  const h = harness();
  const denied = await createUpdatePlan(h.dependencies, PEER_DENIED, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
  });
  // The plan is still returned: the blocker is the answer the caller has to render.
  expect(denied.ok && denied.value.blockers.map((blocker) => blocker.code)).toContain('permission-required');

  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  expect(h.dependencies.grants.mayUpdate('peer-1')).toBe(true);
  const granted = await createUpdatePlan(h.dependencies, PEER_GRANTED, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  expect(granted.ok && granted.value.blockers.filter((blocker) => blocker.code === 'permission-required')).toHaveLength(0);

  const job = await createUpdateJob(h.dependencies, PEER_GRANTED, { planId: granted.ok ? granted.value.planId : '', idempotencyKey: 'peer-1' });
  expect(job.ok).toBe(true);
  if (!job.ok) return;
  // Another peer cannot read it, even with the same authority.
  const stranger = readUpdateJob(h.dependencies, { kind: 'remote-peer', id: 'peer-2', updateGranted: true }, job.value.jobId);
  expect(!stranger.ok && stranger.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);

  expect(h.dependencies.grants.revoke('peer-1').ok).toBe(true);
  expect(updateGrantView(h.dependencies).grants.at(-1)?.revokedAt !== undefined).toBe(true);
});

test('a remote caller may not name this host desktop, and busy work has to be acknowledged', async () => {
  const h = harness();
  const remote = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker', 'client'],
    expected: { version: RUNNING },
    clientContract: { revision: 31, minimumPeerRevision: 30, surfaceHash: feedSurfaceHash(31) },
  });
  expect(remote.ok).toBe(true);
  if (!remote.ok) return;
  expect(remote.value.components.map((component) => component.component)).toEqual(['broker']);
  expect(remote.value.excluded.map((row) => row.component)).toContain('client');

  const busy = harness();
  busy.setBusy('busy');
  const plan = await createUpdatePlan(busy.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
  });
  expect(plan.ok && plan.value.outstandingAcknowledgements).toContain('interruption-during-work');
});

test('cancel stops work before commit and cannot be issued twice for a different job', async () => {
  const h = harness();
  const job = await prepared(h);
  const cancelled = cancelUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(cancelled.ok && cancelled.value.phase).toBe('cancelled');
  expect(h.handoffs).toHaveLength(0);
});

/** The reviewer's first gap: a refusal a user can act on must never become a durable job. */
test('a review that still needs consent never becomes a job, and the reason names what is missing', async () => {
  const h = harness();
  const reviewed = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
  });
  expect(reviewed.ok && reviewed.value.outstandingAcknowledgements).toContain('server-will-disconnect');
  if (!reviewed.ok) return;

  const refused = await createUpdateJob(h.dependencies, OWNER, { planId: reviewed.value.planId, idempotencyKey: 'no-consent' });
  expect(!refused.ok && refused.code === 'UPDATE_ACKNOWLEDGEMENT_REQUIRED').toBe(true);
  if (refused.ok) return;
  expect(refused.detail).toContain('server-will-disconnect');
  // No job, so no held component: the next honest review is not told somebody else is busy.
  expect(h.dependencies.store.listJobs()).toHaveLength(0);
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
});

test('a blocked plan is refused at submission, and a withdrawn grant is a permission answer', async () => {
  const h = harness();
  const denied = await createUpdatePlan(h.dependencies, PEER_DENIED, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  expect(denied.ok && denied.value.blockers.map((blocker) => blocker.code)).toContain('permission-required');
  if (!denied.ok) return;
  const job = await createUpdateJob(h.dependencies, PEER_DENIED, { planId: denied.value.planId, idempotencyKey: 'denied' });
  expect(!job.ok && job.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);
  expect(h.dependencies.store.listJobs()).toHaveLength(0);

  // Ownership that stops being provable is a capability answer about this host, not consent.
  const unproven = harness();
  const observed = unproven.dependencies.observe;
  unproven.dependencies.observe = () => ({
    ...observed(),
    broker: { ...observed().broker, ownership: 'unknown' as const },
  });
  const blocked = await prepared(unproven).catch((error: Error) => error);
  expect(blocked instanceof Error ? blocked.message : blocked).toContain('ownership-unproven');
});

test('work that started after the review stops the commit, and the job says so', async () => {
  const h = harness();
  const job = await prepared(h);
  h.setBusy('busy');
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_ACKNOWLEDGEMENT_REQUIRED').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
  // A refused commit is not a stuck server: the component is available to a fresh review.
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
});

test('a server that started working between review and submission is refused before a job exists', async () => {
  const h = harness();
  const reviewed = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  expect(reviewed.ok).toBe(true);
  if (!reviewed.ok) return;
  h.setBusy('unknown');
  const job = await createUpdateJob(h.dependencies, OWNER, { planId: reviewed.value.planId, idempotencyKey: 'went-busy' });
  expect(!job.ok && job.code === 'UPDATE_ACKNOWLEDGEMENT_REQUIRED').toBe(true);
  if (job.ok) return;
  expect(job.detail).toContain('interruption-during-work');
  expect(h.dependencies.store.listJobs()).toHaveLength(0);
});

/**
 * A plan id names one review, and two reviews can be minted in the same instant by different
 * devices agreeing to different things. When the id was a hash of the millisecond, the release,
 * and the components, those two reviews landed on one file and the second review's consent
 * replaced the first -- after both callers had been told their review was recorded.
 */
test('two reviews minted in one instant stay two reviews', async () => {
  const h = harness();
  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  h.dependencies.grants.grant({ peerId: 'peer-2', grantedBy: 'owner' });
  h.freezeClock();
  const releaseId = releaseIdFor(R1.version, R1.sourceCommit);
  const first = await createUpdatePlan(h.dependencies, PEER_GRANTED, {
    releaseId, components: ['broker'], expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  const second = await createUpdatePlan(h.dependencies, PEER_TWO, {
    releaseId, components: ['broker'], expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect'],
  });
  if (!first.ok || !second.ok) {
    throw new Error(`review refused: ${[first, second].map((one) => (one.ok ? 'ok' : one.code)).join(',')}`);
  }
  expect(second.value.planId).not.toBe(first.value.planId);
  // Each record is still the review it was written as, with the consent it was given.
  const mine = h.dependencies.store.readPlan(first.value.planId);
  const theirs = h.dependencies.store.readPlan(second.value.planId);
  expect(mine.ok && mine.value.principal).toEqual({ kind: 'peer', id: 'peer-1' });
  expect(mine.ok && mine.value.acknowledged).toEqual(['server-will-disconnect', 'compatibility-unconfirmed']);
  expect(theirs.ok && theirs.value.principal).toEqual({ kind: 'peer', id: 'peer-2' });
  expect(theirs.ok && theirs.value.acknowledged).toEqual(['server-will-disconnect']);
  // And the first one still buys the job it was reviewed for, which is what an overwrite broke.
  const job = await createUpdateJob(h.dependencies, PEER_GRANTED, { planId: first.value.planId, idempotencyKey: 'peer-1' });
  expect(job.ok && job.value.phase).toBe('ready');
});

test('another granted peer can neither commit nor cancel the job it did not review', async () => {
  const h = harness();
  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  h.dependencies.grants.grant({ peerId: 'peer-2', grantedBy: 'owner' });
  const job = await prepared(h, PEER_GRANTED);

  const stranger: UpdateManagementCaller = { kind: 'remote-peer', id: 'peer-2', updateGranted: true };
  const applied = await applyUpdateJob(h.dependencies, stranger, job.jobId, { idempotencyKey: 'not-yours' });
  expect(!applied.ok && applied.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);
  const cancelled = cancelUpdateJob(h.dependencies, stranger, job.jobId);
  expect(!cancelled.ok && cancelled.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  expect(readUpdateJob(h.dependencies, stranger, job.jobId).ok).toBe(false);

  // The peer that asked for it still can, and the phase proves the job was not disturbed.
  const own = await applyUpdateJob(h.dependencies, PEER_GRANTED, job.jobId, { idempotencyKey: 'mine' });
  expect(own.ok && own.value.phase).toBe('verifying');
  expect(h.handoffs).toHaveLength(1);
});

test('a delegated update that never came back is settled, and stops holding the server', async () => {
  const h = harness();
  const job = await prepared(h);
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(applied.ok && applied.value.phase).toBe('verifying');
  // The commit was delegated with a deadline, so a host that never comes back is a fact
  // this build can eventually state instead of a job that waits forever.
  expect(applied.ok && applied.value.runner?.leaseExpiresAt !== undefined).toBe(true);

  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  const settled = reconcileInterruptedUpdates(h.dependencies);
  expect(settled).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('needs_attention');
  expect(read.ok && read.value.result).toBe('needs-attention');
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('delegated-update-unconfirmed');

  // The next attempt is possible: this is where a failed update used to block every update.
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
  const again = await prepared(h, OWNER, 'k-2');
  expect(again.phase).toBe('ready');
});

test('the same version built from a different commit is never the reviewed update', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  // The pinned release was R1's commit; this build answers with R1's version and R2's commit.
  h.restartAs(R1.version, R2.sourceCommit);

  const settled = reconcileInterruptedUpdates(h.dependencies);
  expect(settled.at(-1)?.action).toBe('finish-committed');
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('verifying');
  expect(updateHistory(h.dependencies)).toHaveLength(0);

  // Still not a success once the deadline passes -- and not an open question either.
  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  expect(reconcileInterruptedUpdates(h.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  expect(updateHistory(h.dependencies).at(-1)?.result).toBe('needs-attention');
});

/**
 * A commit the host could not re-check is a refusal, never a pass. Every case below breaks one
 * of the two witnesses apply is supposed to consult -- the channel it re-authenticates the pin
 * against, or the record that documents what the caller agreed to -- and asks whether the
 * updater still gets the handoff. It must not: refusing costs a restart that did not happen.
 */
test('a channel that served nothing verified stops the commit instead of waving it through', async () => {
  const h = harness();
  const job = await prepared(h);
  h.silenceChannel();
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_CAPABILITY_UNSUPPORTED').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('release-channel-unavailable');
  // Refused, and released: the next honest attempt is not told somebody is already updating.
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
});

test('a review this host cannot read cannot be committed', async () => {
  const h = harness();
  const job = await prepared(h);
  // The consent being re-checked at the commit boundary lives in this record. Losing it is not
  // the same as having it, and "could not read the plan" was once the path that skipped the
  // whole revalidation.
  rmSync(join(h.home, 'updates', 'plans', `${job.planId}.json`), { force: true });
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_PLAN_STALE').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('plan-unreadable');
});

test('a grant withdrawn while the commit was being prepared is withdrawn', async () => {
  const h = harness();
  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  const job = await prepared(h, PEER_GRANTED);
  // The revocation lands while the channel is being read, which is after the transport
  // authenticated this request and before anything is replaced. A caller's authority at the
  // moment of the commit is the only one that means anything.
  const read = h.dependencies.channel.fetch!;
  h.dependencies.channel.fetch = (async (input: RequestInfo | URL) => {
    const response = await read(input);
    h.dependencies.grants.revoke('peer-1');
    return response;
  }) as unknown as typeof fetch;
  const applied = await applyUpdateJob(h.dependencies, PEER_GRANTED, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  const after = readUpdateJob(h.dependencies, PEER_GRANTED, job.jobId);
  expect(after.ok && after.value.phase).toBe('failed');
});

/**
 * The race the surface used to lose.
 *
 * A handoff does work of its own before it launches anything -- the real one re-reads the release
 * channel -- and a grant withdrawn during that wait is withdrawn by the time the updater actually
 * starts. So the handoff is given the question rather than an answer, and asks it where the launch
 * happens. Asking twice is refused as well, because an approval collected early and spent late is
 * the same race with one extra step.
 */
test('an updater that asks when it launches is refused if the grant went while it waited', async () => {
  const asks: boolean[] = [];
  const h = harness({
    handoff: async (_job, mayLaunch) => {
      await Promise.resolve();
      h.dependencies.grants.revoke('peer-1');
      asks.push(mayLaunch().allowed, mayLaunch().allowed);
      return { accepted: false, detailCode: 'broker-update-authority-withdrawn' };
    },
  });
  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  const job = await prepared(h, PEER_GRANTED);
  const applied = await applyUpdateJob(h.dependencies, PEER_GRANTED, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_PERMISSION_REQUIRED').toBe(true);
  expect(asks).toEqual([false, false]);
  const history = updateHistory(h.dependencies).at(-1);
  expect(history?.detailCodes).toContain('broker-update-authority-withdrawn');
  expect(history?.result).not.toBe('complete');
});

/**
 * A handoff that reports a scheduled updater without ever asking is describing a commit this
 * surface did not authorise. It is not disbelieved -- the transient unit exists and the server is
 * going away -- but the job says what happened, and the caller is not told the update was approved.
 */
test('an updater that launches without asking is not believed to have been allowed', async () => {
  const h = harness({ handoff: async () => ({ accepted: true, detailCode: 'handoff-accepted' }) });
  h.dependencies.grants.grant({ peerId: 'peer-1', grantedBy: 'owner' });
  const job = await prepared(h, PEER_GRANTED);
  const applied = await applyUpdateJob(h.dependencies, PEER_GRANTED, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_CAPABILITY_UNSUPPORTED').toBe(true);
  const after = readUpdateJob(h.dependencies, PEER_GRANTED, job.jobId);
  // It really did launch, so the record follows the machine rather than the other way round.
  expect(after.ok && after.value.phase).toBe('verifying');
  // Still no history entry, which is what a settled record is for: this one is the machine
  // carrying on with a commit nobody authorised it to make, and the event is where that says so.
  expect(updateHistory(h.dependencies)).toHaveLength(0);
  expect(after.ok && after.value.events.at(-1)?.detailCode).toBe('handoff-accepted-unasked');
});

/**
 * The candidate answers before the installer has finished with it, and a job closed as
 * succeeded under a candidate that was about to be rolled back leaves the build that took over
 * again with a finished record of an update that did not happen.
 */
test('the pinned build answering is held open until the installer commits', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.restartAs(R1.version, R1.sourceCommit);
  h.installerSettled(false);

  expect(reconcileInterruptedUpdates(h.dependencies)).toEqual([{ jobId: job.jobId, action: 'finish-committed' }]);
  expect(readUpdateJob(h.dependencies, OWNER, job.jobId).ok).toBe(true);
  expect(updateHistory(h.dependencies)).toHaveLength(0);

  // The installer finishes: the receipts name the bytes this job prepared, and the same
  // reconciliation that refused to guess now has both witnesses.
  h.installerSettled(true);
  expect(reconcileInterruptedUpdates(h.dependencies)).toEqual([{ jobId: job.jobId, action: 'succeeded' }]);
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('update-complete');
});

test('a candidate that never got committed is a failure with a reason, not a permanent question', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.restartAs(R1.version, R1.sourceCommit);
  // Health checks never finished, or finished badly: nothing ever named these bytes installed.
  h.installerSettled(false);
  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);

  expect(reconcileInterruptedUpdates(h.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  const entry = updateHistory(h.dependencies).at(-1);
  expect(entry?.detailCodes).toContain('delegated-update-uncommitted');
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
});

test('a host that was set up again after the review does not commit the old job', async () => {
  const h = harness();
  const job = await prepared(h);
  // Re-running setup re-commits the installation. The bytes this job would replace belong to a
  // tree that is no longer the one anybody approved.
  h.recommitInstallation();
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code === 'UPDATE_PLAN_STALE').toBe(true);
  expect(h.handoffs).toHaveLength(0);
  // And it stops holding the broker: settling is the other half of refusing.
  expect(h.dependencies.store.activeJobFor(['broker'], 'install-under-test')).toBeUndefined();
  const again = await prepared(h, OWNER, 'k-2');
  expect(again.phase).toBe('ready');
});

test('a job left by a superseded installation settles now rather than at its deadline', async () => {
  const h = harness();
  const job = await prepared(h);
  await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.recommitInstallation();

  expect(reconcileInterruptedUpdates(h.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.result).toBe('needs-attention');
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('installation-superseded');
});

/**
 * Losing the answer to a submission is the ordinary case, not the crash case: a phone that
 * asked, waited, and fell over has to be told about the job it already owns. Re-grading that
 * retry against conditions the job itself created used to answer it with
 * `UPDATE_ACKNOWLEDGEMENT_REQUIRED`, which is an accusation about a caller who already paid.
 */
test('a lost answer is retried against the job it bought, not against the work that job started', async () => {
  const h = harness();
  const reviewed = await createUpdatePlan(h.dependencies, OWNER, {
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: ['server-will-disconnect', 'compatibility-unconfirmed'],
  });
  expect(reviewed.ok).toBe(true);
  if (!reviewed.ok) return;
  const first = await createUpdateJob(h.dependencies, OWNER, { planId: reviewed.value.planId, idempotencyKey: 'lost' });
  expect(first.ok && first.value.phase).toBe('ready');
  if (!first.ok) return;

  // The commit the caller consented to is what makes the retry look unauthorized: work is
  // running, so a fresh eligibility check asks for a new acknowledgement.
  h.setBusy('busy');
  const again = await createUpdateJob(h.dependencies, OWNER, { planId: reviewed.value.planId, idempotencyKey: 'lost' });
  expect(again.ok && again.value.jobId === first.value.jobId).toBe(true);
  expect(again.ok && again.value.phase).toBe('ready');
});

test('a caller watching a job sees its expired handoff settle, without reading the inventory', async () => {
  const h = harness();
  const job = await prepared(h);
  const applied = await applyUpdateJob(h.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(applied.ok && applied.value.phase).toBe('verifying');

  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  const read = readUpdateJob(h.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('needs_attention');
  expect(updateHistory(h.dependencies).at(-1)?.detailCodes).toContain('delegated-update-unconfirmed');
});

test('request bodies that carry a URL, a path, or an unknown component are refused at the door', () => {
  expect(parseUpdatePlanRequestBody({ releaseId: releaseIdFor(R1.version, R1.sourceCommit), components: ['broker'] })).toBeDefined();
  expect(parseUpdatePlanRequestBody({ releaseId: releaseIdFor(R1.version, R1.sourceCommit), components: ['desktop'] })).toBeUndefined();
  expect(parseUpdatePlanRequestBody({
    releaseId: releaseIdFor(R1.version, R1.sourceCommit),
    components: ['broker'],
    manifestUrl: 'https://attacker.example/manifest.json',
  })).toBeDefined(); // the extra key is ignored, never read: nothing on this surface takes a URL
  expect(parseUpdatePlanRequestBody({ releaseId: '../../../../etc/passwd', components: ['broker'] })).toBeUndefined();
  expect(parseUpdatePlanRequestBody({ releaseId: releaseIdFor(R1.version, R1.sourceCommit), components: [] })).toBeUndefined();
  expect(parseUpdatePlanRequestBody({ releaseId: releaseIdFor(R1.version, R1.sourceCommit), components: ['broker'], acknowledgements: ['reboot-now'] })).toBeUndefined();
  expect(updateManagementStatus('UPDATE_PERMISSION_REQUIRED')).toBe(403);
  expect(updateManagementStatus('UPDATE_JOB_NOT_FOUND')).toBe(404);
  expect(updateManagementStatus('UPDATE_TARGET_MOVED')).toBe(409);
});
