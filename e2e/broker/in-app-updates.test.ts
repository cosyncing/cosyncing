/**
 * The in-app update surface over authenticated HTTP.
 *
 * The unit tests beside the module prove the planning and job rules against a signed fake
 * channel. This proves the parts that only exist once a request arrives: who is allowed to
 * ask at all, which of those answers a paired phone gets versus the owner, and that the
 * endpoint someone already deploys to keeps behaving exactly as it did.
 *
 * The fixture runs with no release channel configured, which is itself a case worth
 * pinning: a broker that cannot reach a signed channel must say so, and must never make
 * an update look available or committed because a route exists.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { atomicWriteJsonOwnerOnly } from '../../packages/typescript/broker/src/security/secure-files.ts';
import { atomicWriteOwnerOnly } from '../../packages/typescript/broker/src/security/secure-files.ts';
import { inspectInstallState, writeInstallState } from '../../packages/typescript/broker/src/installation/install-state.ts';
import { type BrokerClient } from '../harness/index.ts';
import { type InstalledBroker, startInstalledBroker } from '../harness/installed.ts';
import { pairDevice } from '../harness/pairing.ts';

/**
 * Plant a delegated commit the way a crashed updater leaves one.
 *
 * These records are what the process that was told to replace this broker would have written
 * before it died, which is the only honest way to ask a running broker what it does about them:
 * the updater is not coming back, the deadline question is about a machine state nobody here
 * caused, and the answer has to come from the files.
 */
function plantDelegatedJob(home: string, job: Record<string, unknown>): string {
  const jobId = String(job.jobId);
  atomicWriteJsonOwnerOnly(join(home, 'updates', 'jobs', `${jobId}.json`), job);
  return jobId;
}

const PLAN_BODY = {
  releaseId: 'rel-9.9.9+aaaaaaa',
  components: ['broker'],
  expected: { version: '0.0.0' },
};

describe('the update-management surface', () => {
  // Installed, not a bare source run: a peer credential only means "peer" once there is a
  // real owner credential beside it, and this surface is all about telling those apart.
  let installed: InstalledBroker;
  let owner: BrokerClient;

  beforeAll(async () => {
    const env: Record<string, string> = {};
    installed = await startInstalledBroker({ name: 'in-app-updates', machineLabel: 'e2e-updates', env,
      setup: (paths) => {
        const web = join(paths.root, 'web app');
        atomicWriteOwnerOnly(join(web, 'index.html'), '<html>isolated update web shell</html>');
        atomicWriteJsonOwnerOnly(join(web, 'version.json'), { version: '2.0.0' });
        atomicWriteOwnerOnly(join(web, 'assets', 'hello world.txt'), 'nested asset');
        atomicWriteOwnerOnly(join(paths.root, 'outside.txt'), 'must stay private');
        env.COSYNCING_WEB_DIR = web;
      } });
    owner = installed.owner;
  });
  afterAll(async () => {
    await installed.stop();
  });

  test('web version and shell remain reachable on the native filesystem, while traversal stays refused', async () => {
    const base = installed.internalUrl;
    const version = await fetch(`${base}/cosy/version.json`);
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual({ version: '2.0.0' });
    expect(version.headers.get('cache-control')).toBe('no-store');
    for (const path of ['/cosy/', '/cosy/index.html', '/cosy/settings/deep-link']) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('isolated update web shell');
    }
    expect(await (await fetch(`${base}/cosy/assets/hello%20world.txt`)).text()).toBe('nested asset');
    for (const path of ['..%2foutside.txt', '..%5coutside.txt', '%2foutside.txt', 'C:%5coutside.txt', '%zz']) {
      const response = await fetch(`${base}/cosy/${path}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('must stay private');
    }
  });

  test('the surface is not a public discovery endpoint', async () => {
    for (const path of ['/api/broker/updates', '/api/broker/updates/check', '/api/broker/updates/history']) {
      expect((await fetch(`${installed.internalUrl}${path}`)).status).toBe(401);
    }
  });

  test('the owner reads an inventory that says what this build cannot do', async () => {
    const response = await owner.get('/api/broker/updates');
    expect(response.status).toBe(200);
    const inventory = response.body.inventory;
    expect(inventory.updateManagementVersion).toBe(1);
    expect(inventory.installationGeneration).toBeGreaterThan(0);
    expect(inventory.components.map((row: any) => row.component)).toContain('broker');
    // Honest uncertainty beats a fabricated answer: with no configured channel the broker
    // reports the reason rather than an empty "up to date" or an imagined candidate.
    expect(inventory.busy.state).toBe('unknown');
    const history = await owner.get('/api/broker/updates/history');
    expect(history.status).toBe(200);
    expect(history.body.history).toEqual([]);
  });

  test('a plan refuses to be steered by a caller-supplied URL, path, or component', async () => {
    const hostile = await owner.post('/api/broker/updates/plans', {
      ...PLAN_BODY,
      components: ['broker'],
      manifestUrl: 'https://releases.attacker.example/manifest.json',
      executablePath: '/bin/sh',
    });
    // The extra keys are ignored rather than read: the broker resolves the channel it
    // already trusts, so the answer is about THIS installation, not the attacker's.
    expect(hostile.status).toBe(400);
    expect(hostile.body.code).toBe('UPDATE_CAPABILITY_UNSUPPORTED');
    expect(JSON.stringify(hostile.body)).not.toContain('attacker.example');

    expect((await owner.post('/api/broker/updates/plans', { releaseId: '../../etc/passwd', components: ['broker'] })).status).toBe(400);
    expect((await owner.post('/api/broker/updates/plans', { ...PLAN_BODY, components: ['desktop'] })).status).toBe(400);
    expect((await owner.post('/api/broker/updates/jobs', { planId: 'plan-1' })).status).toBe(400);
    expect((await owner.post('/api/broker/updates/jobs/job-1/apply', {})).status).toBe(400);
    expect((await owner.get('/api/broker/updates/jobs/job-does-not-exist')).body.code).toBe('UPDATE_JOB_NOT_FOUND');
  });

  test('the owner-only grant store is not reachable with a peer credential', async () => {
    const device = await pairDevice(owner, { peerId: 'grant-curious' });
    const peer = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await peer.get('/api/broker/update-grants')).status).toBe(403);
    expect((await peer.post('/api/broker/update-grants', { peerId: 'grant-curious' })).status).toBe(403);
    expect((await peer.request('DELETE', '/api/broker/update-grants/grant-curious')).status).toBe(403);
  });

  test('a paired device may ask for update authority, and asking grants nothing', async () => {
    const device = await pairDevice(owner, { peerId: 'wants-updates' });
    const peer = owner.as({ kind: 'peer', peerToken: device.peerToken });

    const refused = await peer.post('/api/broker/updates/plans', PLAN_BODY);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('broker:update');

    const requested = await peer.post('/api/broker/update-grants/request', {});
    expect(requested.status).toBe(202);
    expect(requested.body.requested).toBe(true);
    // Still no authority: the request is a note for the owner, not a self-approval.
    expect((await peer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);

    const pending = await owner.get('/api/broker/update-grants');
    expect(pending.status).toBe(200);
    expect(pending.body.requests.map((row: any) => row.peerId)).toContain('wants-updates');

    const granted = await owner.post('/api/broker/update-grants', { peerId: 'wants-updates' });
    expect(granted.status).toBe(201);
    const planned = await peer.post('/api/broker/updates/plans', PLAN_BODY);
    // Past authorization now; what refuses it is the missing signed channel, which is a
    // different answer and has to stay a different answer.
    expect(planned.status).not.toBe(403);
    expect(planned.body.code).toBe('UPDATE_CAPABILITY_UNSUPPORTED');

    // The owner's own plan is refused for the same reason and reports the same code, so a
    // client cannot mistake "no channel" for "not allowed here".
    const ownPlan = await owner.post('/api/broker/updates/plans', PLAN_BODY);
    expect(ownPlan.body.code).toBe('UPDATE_CAPABILITY_UNSUPPORTED');

    expect((await owner.request('DELETE', '/api/broker/update-grants/wants-updates')).status).toBe(200);
    expect((await peer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);
  });

  test('discovery stays readable to the peer that may already watch this machine', async () => {
    const device = await pairDevice(owner, { peerId: 'watcher' });
    const peer = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await peer.get('/api/broker/updates')).status).toBe(200);
    expect((await peer.get('/api/broker/updates/history')).status).toBe(200);
    // Sanitized: no state-home path and no command line reaches a paired device.
    const text = JSON.stringify((await peer.get('/api/broker/updates')).body);
    expect(text).not.toContain(installed.paths.root);
  });

  /**
   * A commit this host delegated and never heard of again has exactly one witness left: what
   * the files on disk say now. Both cases below are read through the same authenticated route a
   * phone watches while an update is in flight, so the question is not whether the surface can
   * compute a verdict but whether the caller who is waiting for one ever gets it.
   */
  test('a handoff that expired is settled by the read that renders it', async () => {
    const inventory = (await owner.get('/api/broker/updates')).body.inventory;
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const jobId = plantDelegatedJob(installed.paths.cosyncingHome, {
      schemaVersion: 1,
      jobId: 'job-e2e-expired-handoff',
      planId: 'plan-e2e-expired',
      releaseId: 'rel-9.9.9+aaaaaaa',
      installationId: inventory.installationId,
      installationGeneration: inventory.installationGeneration,
      phase: 'verifying',
      sequence: 4,
      createdAt: stale,
      updatedAt: stale,
      applyAcceptedAt: stale,
      runner: { identity: 'broker-host', leaseExpiresAt: stale },
      components: [{ component: 'broker', outcome: 'committed', stage: 'replacing', detailCode: 'handoff-accepted', actual: {} }],
      events: [{ at: stale, phase: 'verifying', detailCode: 'handoff-accepted' }],
    });

    const read = await owner.get(`/api/broker/updates/jobs/${jobId}`);
    expect(read.status).toBe(200);
    expect(read.body.job.phase).toBe('needs_attention');
    expect(read.body.job.result).toBe('needs-attention');

    const history = await owner.get('/api/broker/updates/history');
    const entry = history.body.history.find((row: any) => row.jobId === jobId);
    expect(entry.detailCodes).toContain('delegated-update-unconfirmed');
    // A failure that keeps holding the server is a failure the user cannot act on, so the
    // inventory that renders the Updates screen has to stop saying an update is running.
    const after = (await owner.get('/api/broker/updates')).body.inventory;
    expect(after.components.find((row: any) => row.component === 'broker').activeJobId).toBeUndefined();
  });

  test('a job left by a re-installed broker settles now instead of at its deadline', async () => {
    const inventory = (await owner.get('/api/broker/updates')).body.inventory;
    const age = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const jobId = plantDelegatedJob(installed.paths.cosyncingHome, {
      schemaVersion: 1,
      jobId: 'job-e2e-superseded-installation',
      planId: 'plan-e2e-superseded',
      releaseId: 'rel-9.9.9+aaaaaaa',
      installationId: inventory.installationId,
      // Re-running setup re-commits the installation. This is the number the tree that was
      // approved carried, and no observation of this home can settle what it predicted.
      installationGeneration: inventory.installationGeneration - 1,
      phase: 'verifying',
      sequence: 4,
      createdAt: age,
      updatedAt: age,
      applyAcceptedAt: age,
      // Deliberately still inside its lease: waiting for a deadline is what used to make a
      // re-run of setup strand this host's updates for good.
      runner: { identity: 'broker-host', leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
      components: [{ component: 'broker', outcome: 'committed', stage: 'replacing', detailCode: 'handoff-accepted', actual: {} }],
      events: [{ at: age, phase: 'verifying', detailCode: 'handoff-accepted' }],
    });

    const read = await owner.get(`/api/broker/updates/jobs/${jobId}`);
    expect(read.body.job.phase).toBe('needs_attention');
    const history = await owner.get('/api/broker/updates/history');
    const entry = history.body.history.find((row: any) => row.jobId === jobId);
    expect(entry.result).toBe('needs-attention');
    expect(entry.detailCodes).toContain('installation-superseded');
  });

  test('the legacy update trigger keeps its owner-only, no-URL contract', async () => {
    const device = await pairDevice(owner, { peerId: 'legacy-caller' });
    const peer = owner.as({ kind: 'peer', peerToken: device.peerToken });
    expect((await peer.get('/api/broker/update')).status).toBe(403);
    const override = await peer.post('/api/broker/update', { manifestUrl: 'https://releases.attacker.example/manifest.json' });
    expect(override.status).toBe(403);
    const ownerOverride = await owner.post('/api/broker/update', { manifestUrl: 'https://releases.attacker.example/manifest.json' });
    expect(ownerOverride.status).toBe(400);
  });

  test('a live installation change retires old grants and new approvals survive restart', async () => {
    const first = await pairDevice(owner, { peerId: 'installation-a-phone' });
    const second = await pairDevice(owner, { peerId: 'installation-b-phone' });
    const oldPeer = owner.as({ kind: 'peer', peerToken: first.peerToken });
    const newPeer = owner.as({ kind: 'peer', peerToken: second.peerToken });
    const granted = await owner.post('/api/broker/update-grants', { peerId: 'installation-a-phone' });
    expect(granted.status).toBe(201);
    expect((await oldPeer.post('/api/broker/updates/plans', PLAN_BODY)).status).not.toBe(403);
    expect((await oldPeer.post('/api/broker/update-grants/request', {})).status).toBe(202);

    const receipt = inspectInstallState(installed.paths.cosyncingHome);
    if (!receipt.committed) throw new Error('fixture installation is not committed');
    const replacementId = 'replacement-update-installation';
    writeInstallState({ ...receipt.state, installationId: replacementId }, installed.paths.cosyncingHome);

    expect((await oldPeer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);
    const current = await owner.get('/api/broker/update-grants');
    expect(current.status).toBe(200);
    expect(current.body.grants).toEqual([]);
    expect(current.body.requests).toEqual([]);
    // A request in the new installation transfers no authority from the previous one.
    expect((await newPeer.post('/api/broker/update-grants/request', {})).status).toBe(202);
    expect((await newPeer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);
    const fresh = await owner.post('/api/broker/update-grants', { peerId: 'installation-b-phone' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.grant.installationId).toBe(replacementId);

    await installed.broker.restart();
    expect((await oldPeer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);
    const allowed = await newPeer.post('/api/broker/updates/plans', PLAN_BODY);
    expect(allowed.status).not.toBe(403);
    expect(allowed.body.code).toBe('UPDATE_CAPABILITY_UNSUPPORTED');
    expect((await owner.request('DELETE', '/api/broker/update-grants/installation-b-phone')).status).toBe(200);
    expect((await newPeer.post('/api/broker/updates/plans', PLAN_BODY)).status).toBe(403);
  });
});
