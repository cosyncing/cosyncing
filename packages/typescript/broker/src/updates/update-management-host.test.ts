/**
 * The update surface as this host actually wires it, against a channel that answers.
 *
 * The suite beside `update-management.ts` hands the surface a dependency bag it assembled
 * itself, which is the right way to test planning rules and also how two host-level bugs
 * survived it: a maintenance reading the host never passed to the planner, and a lifecycle
 * that never reached staged bytes because nothing in that fixture could sign a release. This
 * opens the real host instead -- a committed installation on a real state home, the real grant
 * store, the real component observation off disk, a signed feed that serves real artifact
 * bodies -- and asks whether an authorized caller can take a release from available to staged
 * to committed, and what stops them when they should not.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateBusyState, UpdateJob, UpdatePlan } from '@cosyncing/protocol';
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
import { committedInstallState, inspectInstallState, installStatePath, installedBinaryPath, writeInstallState } from '../installation/install-state.ts';
import type { BuildInfo } from '../runtime/build-info.ts';
import { openUpdateManagementHost } from './update-management-host.ts';
import { handoffBrokerUpdate, type BrokerUpdateSnapshot } from './broker-update.ts';
import {
  applyUpdateJob,
  cancelUpdateJob,
  createUpdateJob,
  createUpdatePlan,
  readUpdateJob,
  reconcileInterruptedUpdates,
  updateCheck,
  updateHistory,
  updateInventory,
  UPDATE_HANDOFF_LEASE_MS,
  type UpdateManagementCaller,
  type UpdateManagementResult,
} from './update-management.ts';

const RUNNING = '1.0.0';
const R1_VERSION = '1.1.0';
const R1_COMMIT = 'bbbbbbb';
const R1_RELEASE_ID = releaseIdFor(R1_VERSION, R1_COMMIT);
const SETUP_AT = '2026-01-01T00:00:00.000Z';
const CONTRACT = { revision: 31, minimumClientRevision: 30, surfaceHash: feedSurfaceHash(31) };

/** The consent a person gives on the review screen for a server restart they can see coming. */
const REVIEWED_CONSENT = ['server-will-disconnect', 'compatibility-unconfirmed'] as const;

const OWNER: UpdateManagementCaller = { kind: 'remote-owner', id: 'owner', updateGranted: true };

const R1: FeedRelease = {
  name: 'R1',
  version: R1_VERSION,
  sourceCommit: R1_COMMIT,
  publishedAt: '2026-01-02T00:00:00.000Z',
  contract: CONTRACT,
  updater: feedUpdater({
    version: R1_VERSION,
    sourceCommit: R1_COMMIT,
    clientContract: { revision: 31, minimumBrokerRevision: 30 },
  }),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Host {
  home: string;
  feed: FakeReleaseFeed;
  handoffs: UpdateJob[];
  host: ReturnType<typeof openUpdateManagementHost>;
  /** Authority read off the grant store, the way the runtime hands a caller to this surface. */
  peer(id: string): UpdateManagementCaller;
  restartAs(version: string, commit: string): void;
  setBusy(state: UpdateBusyState['state']): void;
  advance(milliseconds: number): void;
}

function openHost(options: { declareBusy?: boolean; home?: string; setupAt?: string } = {}): Host {
  const root = options.home === undefined ? mkdtempSync(join(tmpdir(), 'cosyncing-update-host-')) : undefined;
  if (root !== undefined) roots.push(root);
  // Re-opening a home stands for the same machine seen by a later process, which is how a
  // re-run of setup is exercised: new installation generation, same durable jobs on disk.
  const home = options.home ?? join(root!, 'state');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // A committed installation, so ownership is a fact off disk rather than a fixture courtesy:
  // an unproven installation is a blocker, and a test that handed one over would prove nothing.
  writeInstallState(committedInstallState(options.setupAt ?? SETUP_AT), home);

  const feed = createFakeReleaseFeed({ releases: [R1] });
  const handoffs: UpdateJob[] = [];
  const identity = { version: RUNNING, commit: 'aaaaaaa' };
  const buildInfo = {
    get version() { return identity.version; },
    get commit() { return identity.commit; },
    target: 'linux-x64',
    distribution: 'native',
    packaged: true,
    dirty: false,
    contract: CONTRACT,
  } as unknown as BuildInfo;
  let busy: UpdateBusyState['state'] = 'idle';
  let offsetMs = 0;

  const host = openUpdateManagementHost({
    home,
    buildInfo,
    manifestUrl: FEED_MANIFEST_URL,
    fetch: feed.fetch,
    trustedKeys: FEED_TRUSTED_KEYS,
    // Asks at the moment it would launch, like the real launcher does. A stub that skipped the
    // ask would have the surface refuse the commit as unauthorised, which is the correct answer
    // to the wrong question.
    handoff: async (job, mayLaunch) => {
      const authority = mayLaunch();
      if (!authority.allowed) return { accepted: false, detailCode: authority.detailCode };
      handoffs.push(job);
      return { accepted: true, detailCode: 'handoff-accepted' };
    },
    // Withheld on purpose in one case: a host that says nothing about its maintenance state
    // has to be read as `unknown`, not as idle.
    ...(options.declareBusy === false ? {} : {
      busy: (): UpdateBusyState => ({
        state: busy,
        activeTurns: busy === 'busy' ? 1 : 0,
        activeLaunches: 0,
        pendingApprovals: 0,
        observedAt: new Date(0).toISOString(),
      }),
    }),
    now: () => new Date(Date.now() + offsetMs),
  });
  return {
    home,
    feed,
    handoffs,
    host,
    peer: (id) => ({ kind: 'remote-peer', id, updateGranted: host.grants.mayUpdate(id) }),
    restartAs: (version, commit) => {
      identity.version = version;
      identity.commit = commit;
    },
    setBusy: (state) => {
      busy = state;
    },
    advance: (milliseconds) => {
      offsetMs += milliseconds;
    },
  };
}

/**
 * The two records a real upgrader leaves behind, written by the test rather than stubbed.
 *
 * A committed transaction and a candidate that is merely answering are two different facts, and
 * the only honest way to tell them apart in a test is to make both kinds of state on disk: the
 * journal the transaction lives inside, and the install receipt that names the bytes which ended
 * up installed. `update-management.ts` reads both through one seam, and this host opens the real
 * one, so what a case asserts is what the surface actually read.
 */

/** The digest the pinned release publishes for this host's platform. */
function pinnedArtifactDigest(h: Host): string {
  const manifest = h.feed.byReleaseId(R1_RELEASE_ID)!;
  return manifest.artifacts.find((row) => row.target === 'linux-x64')!.sha256;
}

/** A digest for the bytes this fixture was installed with, which are never the candidate's. */
function runningArtifactDigest(): string {
  return createHash('sha256').update(`installed-broker-${RUNNING}`).digest('hex');
}

/** The upgrader's own not-yet marker: written before a byte moves, removed when it commits. */
function transactionOpen(home: string): void {
  writeFileSync(join(home, 'upgrade-journal.json'), '{"phase":"activating"}\n', { mode: 0o600 });
}

function transactionClosed(home: string): void {
  rmSync(join(home, 'upgrade-journal.json'), { force: true });
}

/** What the upgrader's commit write does: the receipt names the bytes now installed. */
function installedBytes(home: string, digest: string): void {
  const inspection = inspectInstallState(home);
  if (!inspection.committed) throw new Error('the fixture installation is not committed');
  writeInstallState({
    ...inspection.state,
    resources: [
      ...inspection.state.resources.filter((resource) => resource.id !== 'broker-binary'),
      {
        id: 'broker-binary',
        kind: 'binary',
        target: installedBinaryPath(home),
        ownership: { proof: 'package-hash', installedSha256: digest },
      },
    ],
  }, home);
}

/** The plan id, or the refusal that stopped the review: a test that cannot name one has failed. */
function reviewedPlanId(result: UpdateManagementResult<UpdatePlan>): string {
  if (!result.ok) throw new Error(`plan refused: ${result.code} ${result.detail}`);
  return result.value.planId;
}

/** The phase a caller is allowed to read, or undefined when the surface refuses the read. */
function jobPhase(h: Host, caller: UpdateManagementCaller, jobId: string): UpdateJob['phase'] | undefined {
  const read = readUpdateJob(h.host.dependencies, caller, jobId);
  return read.ok ? read.value.phase : undefined;
}

async function readyJob(h: Host, caller = OWNER, key = 'k-1') {
  const plan = await createUpdatePlan(h.host.dependencies, caller, {
    releaseId: R1_RELEASE_ID,
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: [...REVIEWED_CONSENT],
  });
  if (!plan.ok) throw new Error(`plan refused: ${plan.code} ${plan.detail}`);
  const job = await createUpdateJob(h.host.dependencies, caller, { planId: plan.value.planId, idempotencyKey: key });
  if (!job.ok) throw new Error(`job refused: ${job.code} ${job.detail}`);
  return job.value;
}

test('an authorized caller takes this host from available to staged without stopping anything', async () => {
  const h = openHost();
  const check = await updateCheck(h.host.dependencies);
  expect(check.status).toBe('update-available');
  expect(check.components.find((row) => row.component === 'broker')?.available?.version).toBe(R1_VERSION);

  const job = await readyJob(h);
  expect(job.phase).toBe('ready');
  expect(job.components[0]?.outcome).toBe('prepared');
  // Preparation authenticates bytes and stops nothing: no commit has been delegated yet.
  expect(h.handoffs).toHaveLength(0);

  // The staged bytes are the pinned release's own, byte for byte, under the state home.
  const manifest = h.feed.byReleaseId(R1_RELEASE_ID)!;
  const artifact = manifest.artifacts.find((row) => row.target === 'linux-x64')!;
  const staged = join(h.home, 'updates', 'staging', job.jobId);
  const recorded = JSON.parse(readFileSync(join(staged, 'prepared.json'), 'utf8')) as {
    releaseId: string; name: string; digest: string; bytes: number;
  };
  expect(recorded).toMatchObject({ releaseId: R1_RELEASE_ID, name: artifact.name, digest: artifact.sha256, bytes: artifact.size });
  const bytes = readFileSync(join(staged, artifact.name));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  expect(readdirSync(staged).sort()).toEqual(['prepared.json', artifact.name].sort());
});

test('a host that cannot say it is idle asks before it restarts its own server', async () => {
  const h = openHost({ declareBusy: false });
  const reviewed = await createUpdatePlan(h.host.dependencies, OWNER, {
    releaseId: R1_RELEASE_ID,
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: [...REVIEWED_CONSENT],
  });
  // The inventory reported `unknown`, so the planner had to ask the person rather than
  // assume a restart would interrupt nothing.
  expect(reviewed.ok && reviewed.value.outstandingAcknowledgements).toContain('interruption-during-work');
  const refused = await createUpdateJob(h.host.dependencies, OWNER, { planId: reviewedPlanId(reviewed), idempotencyKey: 'quiet' });
  expect(!refused.ok && refused.code).toBe('UPDATE_ACKNOWLEDGEMENT_REQUIRED');
  expect(h.host.store.listJobs()).toHaveLength(0);

  // Same host, honest answer: the ack is what was missing, not a permanent blockage.
  const agreed = await createUpdatePlan(h.host.dependencies, OWNER, {
    releaseId: R1_RELEASE_ID,
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: [...REVIEWED_CONSENT, 'interruption-during-work'],
  });
  expect(agreed.ok && agreed.value.blockers).toHaveLength(0);
  const job = await createUpdateJob(h.host.dependencies, OWNER, { planId: reviewedPlanId(agreed), idempotencyKey: 'acknowledged' });
  expect(job.ok && job.value.phase).toBe('ready');
});

test('work that started after the review stops the commit before the updater is asked', async () => {
  const h = openHost();
  const job = await readyJob(h);
  h.setBusy('busy');

  const applied = await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(!applied.ok && applied.code).toBe('UPDATE_ACKNOWLEDGEMENT_REQUIRED');
  expect(h.handoffs).toHaveLength(0);
  const read = readUpdateJob(h.host.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('failed');
  // A refused commit leaves nothing holding the component: the next honest review is not
  // told somebody else is already updating this server.
  expect(h.host.store.activeJobFor(['broker'], h.host.dependencies.installation().installationId)).toBeUndefined();
});

test('a peer commits only what it reviewed, and only while the owner lets it', async () => {
  const h = openHost();
  // Authority comes from the grant store, exactly as the runtime reads it for a peer.
  const early = h.peer('peer-a');
  expect(early.updateGranted).toBe(false);
  const reviewed = await createUpdatePlan(h.host.dependencies, early, {
    releaseId: R1_RELEASE_ID,
    components: ['broker'],
    expected: { version: RUNNING },
    acknowledgements: [...REVIEWED_CONSENT],
  });
  expect(reviewed.ok && reviewed.value.blockers.map((blocker) => blocker.code)).toContain('permission-required');
  const ungranted = await createUpdateJob(h.host.dependencies, early, { planId: reviewedPlanId(reviewed), idempotencyKey: 'no-grant' });
  expect(!ungranted.ok && ungranted.code).toBe('UPDATE_PERMISSION_REQUIRED');

  h.host.grants.grant({ peerId: 'peer-a', grantedBy: 'owner' });
  h.host.grants.grant({ peerId: 'peer-b', grantedBy: 'owner' });
  const first = h.peer('peer-a');
  const second = h.peer('peer-b');
  const job = await readyJob(h, first);

  // Two phones, both holding `broker:update`. The grant says which of them may update this
  // server; it says nothing about who reviewed the work, and one commit was approved once.
  const stolen = await applyUpdateJob(h.host.dependencies, second, job.jobId, { idempotencyKey: 'not-yours' });
  expect(!stolen.ok && stolen.code).toBe('UPDATE_PERMISSION_REQUIRED');
  const hijacked = cancelUpdateJob(h.host.dependencies, second, job.jobId);
  expect(!hijacked.ok && hijacked.code).toBe('UPDATE_PERMISSION_REQUIRED');
  expect(readUpdateJob(h.host.dependencies, second, job.jobId).ok).toBe(false);
  expect(h.handoffs).toHaveLength(0);

  const committed = await applyUpdateJob(h.host.dependencies, first, job.jobId, { idempotencyKey: 'mine' });
  expect(committed.ok && committed.value.phase).toBe('verifying');
  // The delegated commit carries the release it was approved for and a deadline, because the
  // process that asked may not be the one that has to answer for it later.
  expect(h.handoffs.map((row) => row.releaseId)).toEqual([R1_RELEASE_ID]);
  expect(h.handoffs[0]?.runner?.leaseExpiresAt !== undefined).toBe(true);

  // Revocation closes the door on the next attempt, which is all a revoke has ever promised.
  h.host.grants.revoke('peer-b');
  expect(h.peer('peer-b').updateGranted).toBe(false);
});

test('a delegated update that never came back stops holding the server hostage', async () => {
  const h = openHost();
  const job = await readyJob(h);
  const applied = await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(applied.ok && applied.value.phase).toBe('verifying');

  // The updater this host handed the commit to died. Nothing answers, and no cancellation is
  // possible from a job that is past `ready`, so the deadline is what makes it recoverable.
  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  expect(reconcileInterruptedUpdates(h.host.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  const read = readUpdateJob(h.host.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.result).toBe('needs-attention');
  expect(updateHistory(h.host.dependencies).at(-1)?.detailCodes).toContain('delegated-update-unconfirmed');

  const again = await readyJob(h, OWNER, 'k-2');
  expect(again.phase).toBe('ready');
});

test('the build that answers has to be the build that was pinned', async () => {
  const h = openHost();
  const job = await readyJob(h);
  await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });

  // Same version string, different commit: a version comparison alone would call this the
  // reviewed update, and the record would claim a success nobody installed.
  h.restartAs(R1_VERSION, 'ddddddd');
  expect(reconcileInterruptedUpdates(h.host.dependencies).at(-1)?.action).toBe('finish-committed');
  expect(jobPhase(h, OWNER, job.jobId)).toBe('verifying');
  expect(updateHistory(h.host.dependencies)).toHaveLength(0);

  // Not a success once the deadline passes, and not an open question either.
  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  expect(reconcileInterruptedUpdates(h.host.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  expect(updateHistory(h.host.dependencies).at(-1)?.result).toBe('needs-attention');
});

test('the pinned build answering, with the installer\'s receipts behind it, closes the job', async () => {
  const h = openHost();
  const job = await readyJob(h);
  await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.restartAs(R1_VERSION, R1_COMMIT);
  // Both witnesses, on disk: the build answering carries the pinned identity, and the install
  // receipt names the bytes this job prepared. Either one alone is a guess about the other.
  installedBytes(h.home, pinnedArtifactDigest(h));

  expect(reconcileInterruptedUpdates(h.host.dependencies)).toEqual([{ jobId: job.jobId, action: 'succeeded' }]);
  const read = readUpdateJob(h.host.dependencies, OWNER, job.jobId);
  expect(read.ok && read.value.phase).toBe('succeeded');
  expect(read.ok && read.value.components[0]?.actual).toEqual({ version: R1_VERSION, buildId: R1_COMMIT });
  const entry = updateHistory(h.host.dependencies).at(-1);
  expect(entry?.result).toBe('complete');
  expect(entry?.detailCodes).toContain('update-complete');
});

/**
 * The order the upgrader actually runs in: stop the old service, move the candidate in, start
 * it, prove the broker and the web root answer on the new version, and only then write the
 * receipts that make the swap durable. A job closed at "started" is a job that can be wrong in
 * the one direction nobody recovers from, because the rollback that follows hands the previous
 * build a finished record of an update that did not happen.
 */
test('a candidate that is answering has not yet replaced this host', async () => {
  const h = openHost();
  const job = await readyJob(h);
  await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.restartAs(R1_VERSION, R1_COMMIT);
  // The candidate is up and the journal is still there: the health checks have not finished,
  // and the whole transaction is still the installer's to undo.
  transactionOpen(h.home);

  expect(reconcileInterruptedUpdates(h.host.dependencies)).toEqual([{ jobId: job.jobId, action: 'finish-committed' }]);
  expect(jobPhase(h, OWNER, job.jobId)).toBe('verifying');
  expect(updateHistory(h.host.dependencies)).toHaveLength(0);

  // It committed after all: journal removed, receipt names the bytes this job staged. A client
  // polling the job is enough to close it; nothing has to wait for the next inventory read.
  transactionClosed(h.home);
  installedBytes(h.home, pinnedArtifactDigest(h));
  expect(jobPhase(h, OWNER, job.jobId)).toBe('succeeded');
  expect(updateHistory(h.host.dependencies).at(-1)?.detailCodes).toContain('update-complete');
});

test('a rolled-back candidate is not inherited by the build that came back as a success', async () => {
  const h = openHost();
  const job = await readyJob(h);
  await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  h.restartAs(R1_VERSION, R1_COMMIT);
  transactionOpen(h.home);
  expect(reconcileInterruptedUpdates(h.host.dependencies).at(-1)?.action).toBe('finish-committed');

  // The health check failed. The upgrader restores the previous binary, restarts it, and takes
  // its own journal away; the receipt goes back to naming the bytes this host came in with.
  transactionClosed(h.home);
  installedBytes(h.home, runningArtifactDigest());
  h.restartAs(RUNNING, 'aaaaaaa');

  expect(reconcileInterruptedUpdates(h.host.dependencies).at(-1)?.action).toBe('finish-committed');
  expect(updateHistory(h.host.dependencies)).toHaveLength(0);
  // The build that was told to replace it never came back, and there is nobody left to say so
  // but this one, so the deadline makes it a verdict and the server is up for the next attempt.
  h.advance(UPDATE_HANDOFF_LEASE_MS + 1_000);
  expect(reconcileInterruptedUpdates(h.host.dependencies)).toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  expect(updateHistory(h.host.dependencies).at(-1)?.detailCodes).toContain('delegated-update-unconfirmed');
  expect(jobPhase(h, OWNER, job.jobId)).toBe('needs_attention');

  const again = await readyJob(h, OWNER, 'k-2');
  expect(again.phase).toBe('ready');
});

test('a host that was set up again settles the jobs of the installation it replaced', async () => {
  const h = openHost();
  const job = await readyJob(h);
  await applyUpdateJob(h.host.dependencies, OWNER, job.jobId, { idempotencyKey: 'apply-1' });
  expect(jobPhase(h, OWNER, job.jobId)).toBe('verifying');
  const setupAt = h.host.dependencies.installation().installationGeneration;

  // Setup runs again in the same home while this process keeps running -- the launchd case, where
  // the service comes up before setup has finished committing, and the re-run case, where nobody
  // restarts anything. A host that read its receipt once at startup would go on answering with an
  // installation that no longer exists, leaving this job `verifying` and its component excluded.
  writeInstallState(committedInstallState('2026-02-02T00:00:00.000Z'), h.home);
  expect(h.host.dependencies.installation().installationGeneration).toBeGreaterThan(setupAt);

  expect(reconcileInterruptedUpdates(h.host.dependencies))
    .toEqual([{ jobId: job.jobId, action: 'needs-attention' }]);
  expect(updateHistory(h.host.dependencies).at(-1)?.detailCodes).toContain('installation-superseded');
  // And the new installation is free to be updated at all, which is what used to be impossible.
  const next = await readyJob(h, OWNER, 'k-2');
  expect(next.phase).toBe('ready');
});

/**
 * The same reading, without a restart, for the answer the inventory gives.
 *
 * Ownership comes off the install receipt, so a receipt that stopped proving it cannot leave the
 * running host still reporting that it does: that is the field an updater reads as permission to
 * replace what is installed.
 */
test('a receipt that stops proving ownership is reported that way by the host already running', () => {
  const h = openHost();
  expect(updateInventory(h.host.dependencies).components[0]?.ownership).toBe('cosyncing-installer');

  const inspection = inspectInstallState(h.home);
  expect(inspection.committed).toBe(true);
  // Written as raw bytes on purpose: a receipt whose setup never committed is exactly the shape
  // the typed writer refuses to produce, and a host already running has to notice it anyway.
  const receipt = JSON.parse(readFileSync(installStatePath(h.home), 'utf8'));
  receipt.setup = { status: 'running' };
  writeFileSync(installStatePath(h.home), JSON.stringify(receipt), { mode: 0o600 });

  const inventory = updateInventory(h.host.dependencies);
  expect(inventory.components[0]?.ownership).toBe('unknown');
  expect(inventory.components[0]?.blockers.map((blocker) => blocker.code)).toContain('ownership-unproven');
  expect(inventory.installationGeneration).toBe(0);
});

// The packaged HTTP fixture is still pending. Exercise the real host, channel wait,
// authorization and launcher together here; only the process launch is replaced.
test.each(['generation', 'identity', 'grant'] as const)(
  'a %s change during the real handoff returns the recovery reason without launching', async (change) => {
    const h = openHost();
    h.host.grants.grant({ peerId: 'phone', grantedBy: 'owner' });
    const caller = h.peer('phone');
    const job = await readyJob(h, caller);
    let announceCheck!: () => void;
    const checking = new Promise<void>((resolve) => { announceCheck = resolve; });
    let finishCheck!: (snapshot: BrokerUpdateSnapshot) => void;
    const held = new Promise<BrokerUpdateSnapshot>((resolve) => { finishCheck = resolve; });
    let launches = 0;
    h.host.dependencies.handoff = (reviewed, authorizeLaunch) => handoffBrokerUpdate({
      buildInfo: h.host.dependencies.buildInfo,
      service: { managed: true, provider: 'systemd', restartStrategy: 'service-manager-exit' },
      executablePath: '/fixture/cosyncing',
      stateHome: h.home,
      systemdRunPath: '/fixture/systemd-run',
      pinnedReleaseId: reviewed.releaseId,
      authorizeLaunch,
      checker: { inspect: () => { announceCheck(); return held; } },
      run: async () => { launches += 1; return { ok: true }; },
    });
    const applying = applyUpdateJob(h.host.dependencies, caller, job.jobId, { idempotencyKey: 'apply-1' });
    await checking;
    if (change === 'grant') {
      h.host.grants.revoke('phone');
    } else {
      const receipt = inspectInstallState(h.home);
      if (!receipt.committed) throw new Error('fixture installation is not committed');
      writeInstallState({
        ...receipt.state,
        ...(change === 'identity'
          ? { installationId: 'replacement-installation' }
          : { setup: { status: 'committed' as const, committedAt: '2026-02-02T00:00:00.000Z' } }),
      }, h.home);
    }
    finishCheck({ status: 'update-available', latestVersion: R1_VERSION } as BrokerUpdateSnapshot);
    const result = await applying;
    expect(!result.ok && result.code).toBe(change === 'grant' ? 'UPDATE_PERMISSION_REQUIRED' : 'UPDATE_PLAN_STALE');
    expect(launches).toBe(0);
    expect(jobPhase(h, OWNER, job.jobId)).toBe('failed');
    expect(updateHistory(h.host.dependencies).at(-1)?.detailCodes)
      .toContain(change === 'grant' ? 'grant-revoked' : 'installation-superseded');
  },
);
