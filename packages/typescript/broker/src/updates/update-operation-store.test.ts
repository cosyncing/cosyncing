/**
 * Durable plan/job behaviour, on a real temporary filesystem.
 *
 * These are storage guarantees, so they run against actual files rather than a
 * mock: the properties that matter (a record is on disk before the caller hears
 * about it; a crash between two writes does not become two operations; a record
 * from a future build is left alone) are exactly the ones an in-memory fake would
 * be unable to fail.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateComponent, UpdateJob, UpdatePlan } from '@cosyncing/protocol';
import { UpdateOperationStore, type StoredUpdatePlan, type UpdatePrincipalRef } from './update-operation-store.ts';

const OWNER = { kind: 'owner' as const, id: 'owner' };
const PEER = { kind: 'peer' as const, id: 'peer-phone' };
const OTHER_PEER = { kind: 'peer' as const, id: 'peer-laptop' };

function plan(overrides: Partial<UpdatePlan> = {}): UpdatePlan {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    releaseId: 'rel-1.1.0+bbbbbbb',
    installationId: 'inst-a',
    installationGeneration: 1,
    expiresAt: new Date(clock + 15 * 60 * 1000).toISOString(),
    components: [
      { component: 'broker', from: { version: '1.0.0' }, to: { version: '1.1.0' }, order: 0, impacts: [] },
      { component: 'client', from: { version: '1.0.0' }, to: { version: '1.1.0' }, order: 1, impacts: [] },
    ],
    order: ['broker', 'client'],
    requiredAcknowledgements: [],
    outstandingAcknowledgements: [],
    blockers: [],
    excluded: [],
    compatibility: null,
    updateManagementVersion: 1,
    ...overrides,
  };
}

/**
 * Record a plan and hand back what was written.
 *
 * Most scenarios here do not care about the write itself, only about what happens afterwards, so
 * they take the record and a refusal is a broken fixture rather than a result to assert on.
 */
function putPlan(opened: UpdateOperationStore, next: UpdatePlan, principal: UpdatePrincipalRef): StoredUpdatePlan {
  const written = opened.putPlan(next, principal);
  if (written.status === 'stored') return written.record;
  // A fixture usually wants "a review exists under this id" rather than "this exact write
  // happened", and some set one up before the call they are actually testing. What is already
  // there answers that. The refusal a real caller gets is proven in its own test below, where
  // it is asked for on purpose rather than papered over here.
  if (written.record !== undefined) return written.record;
  throw new Error(`the review was not written (${written.status})`);
}

/** Every test starts at the same instant, so a plan's stated lifetime means the same thing each time. */
const BASE_MS = Date.parse('2026-01-10T12:00:00.000Z');
let clock = BASE_MS;

function root(store: UpdateOperationStore): string {
  return (store as unknown as { root: string }).root;
}

const owned = new Set<string>();
function store(options: { retainFinished?: number } = {}): UpdateOperationStore {
  clock = BASE_MS;
  const directory = mkdtempSync(join(tmpdir(), 'cosyncing-update-store-'));
  owned.add(directory);
  return new UpdateOperationStore(directory, {
    now: () => new Date(clock),
    newId: ((counter) => () => `job-${(counter.value += 1)}`)({ value: 0 }),
    ...options,
  });
}

function submitted(
  store: UpdateOperationStore,
  key = 'key-1',
  principal: UpdatePrincipalRef = OWNER,
  options: { installationId?: string; components?: UpdateComponent[]; planId?: string } = {},
) {
  const installationId = options.installationId ?? 'inst-a';
  // Its own id unless the test names one: two reviews over one id is the thing the store now
  // refuses, and a fixture that stacked them was describing a world that cannot happen.
  const planId = options.planId ?? 'plan-1';
  const full = plan();
  const wanted = options.components ?? ['broker', 'client'];
  putPlan(store, plan({
    planId,
    installationId,
    components: full.components.filter((component) => wanted.includes(component.component)),
    order: full.order.filter((component) => wanted.includes(component)),
  }), principal);
  const result = store.submitJob({ planId, idempotencyKey: key, principal, installationId, installationGeneration: 1 });
  if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
  return result.job;
}

test('a plan is on disk before its id is usable, and only by the principal it was issued to', () => {
  const opened = store();
  const record = putPlan(opened, plan(), PEER);
  expect(record.schemaVersion).toBe(1);
  const redeemed = opened.redeemPlan({ planId: 'plan-1', principal: PEER, installationId: 'inst-a', installationGeneration: 1 });
  expect(redeemed.ok).toBe(true);
  expect(opened.redeemPlan({ planId: 'plan-1', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 }).ok).toBe(false);
});

/**
 * A plan id belongs to one review, and the file behind it is what a later apply reads to prove
 * somebody agreed to what is about to run. Two reviews landing on one id -- which is what a
 * content-derived id made possible for anything minted in the same millisecond -- would leave the
 * first caller's job redeeming the second caller's consent.
 */
test('a second review never replaces the consent already recorded under an id', () => {
  const opened = store();
  const first = putPlan(opened, plan({ planId: 'plan-shared' }), PEER);
  const refused = opened.putPlan(plan({
    planId: 'plan-shared',
    releaseId: 'rel-9.9.9+zzzzzzz',
    requiredAcknowledgements: ['server-will-disconnect'],
    outstandingAcknowledgements: ['server-will-disconnect'],
  }), OTHER_PEER);
  expect(refused.status).toBe('exists');
  const standing = opened.readPlan('plan-shared');
  expect(standing.ok && standing.value.fingerprint).toBe(first.fingerprint);
  expect(standing.ok && standing.value.principal).toEqual(PEER);
  expect(standing.ok && standing.value.plan.releaseId).toBe('rel-1.1.0+bbbbbbb');
  // The point of it holding: the other peer's review did not become this peer's, so it cannot
  // spend a consent it never gave.
  expect(rejection(opened, { planId: 'plan-shared', principal: OTHER_PEER, installationId: 'inst-a', installationGeneration: 1 }))
    .toBe('principal-mismatch');
});

/** Read only the rejection of a redeem, so a mistaken success is a type error rather than `undefined`. */
function rejection(store: UpdateOperationStore, input: Parameters<UpdateOperationStore['redeemPlan']>[0]): string {
  const result = store.redeemPlan(input);
  return result.ok ? 'accepted' : result.reason;
}

test('every way a plan can have gone stale is a distinct rejection', () => {
  const opened = store();
  putPlan(opened, plan(), OWNER);
  const base = { planId: 'plan-1', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 };
  expect(rejection(opened, { ...base, installationGeneration: 2 })).toBe('generation-mismatch');
  expect(rejection(opened, { ...base, installationId: 'inst-b' })).toBe('installation-mismatch');
  clock += 16 * 60 * 1000;
  expect(rejection(opened, base)).toBe('expired');
  expect(rejection(opened, { ...base, planId: 'never-issued' })).toBe('not-found');
});

test('a repeated submission with the same key returns the same operation, not a second one', () => {
  const opened = store();
  const first = submitted(opened);
  putPlan(opened, plan(), OWNER);
  const again = opened.submitJob({ planId: 'plan-1', idempotencyKey: 'key-1', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 });
  expect(again.status).toBe('existing');
  if (again.status !== 'existing') throw new Error('unreachable');
  expect(again.job.jobId).toBe(first.jobId);
});

test('an idempotency key is scoped to its principal and installation', () => {
  const opened = store();
  submitted(opened, 'same-key', OWNER);
  putPlan(opened, plan({ planId: 'plan-peer-phone' }), PEER);
  const asPeer = opened.submitJob({ planId: 'plan-peer-phone', idempotencyKey: 'same-key', principal: PEER, installationId: 'inst-a', installationGeneration: 1 });
  // Same string, different device: the peer never saw the owner's review, so it must
  // not inherit the owner's operation -- and it must not be told a conflict either.
  expect(asPeer.status).toBe('in-progress');
});

test('reusing a key for different reviewed content is a conflict, not a silent substitution', () => {
  const opened = store();
  submitted(opened, 'key-1');
  // Same principal and same key, but the review it now points at names a different release.
  // Handing back the old job would run something the user never confirmed, and handing back a
  // new one would double the side effects, so the only honest answer is a conflict.
  putPlan(opened, plan({ planId: 'plan-other-release', releaseId: 'rel-1.2.0+ccccccc' }), OWNER);
  const conflict = opened.submitJob({ planId: 'plan-other-release', idempotencyKey: 'key-1', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 });
  expect(conflict.status).toBe('idempotency-conflict');
});

test('an index torn by a crash never yields a second operation', () => {
  const opened = store();
  const job = submitted(opened, 'key-torn');
  rmSync(join(root(opened), 'jobs', `${job.jobId}.json`), { force: true });
  const again = opened.submitJob({ planId: 'plan-1', idempotencyKey: 'key-torn', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 });
  expect(again.status).toBe('idempotency-conflict');
});

test('a lost submission response recovers the original job across a process death', () => {
  const opened = store();
  const first = submitted(opened);
  // New store over the same root: the broker restarted and the client never got its 202.
  const reopened = new UpdateOperationStore(root(opened), { now: () => new Date(clock) });
  const recovered = reopened.submitJob({ planId: 'plan-1', idempotencyKey: 'key-1', principal: OWNER, installationId: 'inst-a', installationGeneration: 1 });
  expect(recovered.status).toBe('existing');
  if (recovered.status !== 'existing') throw new Error('unreachable');
  expect(recovered.job.jobId).toBe(first.jobId);
});

test('two devices cannot open competing operations over the same component', () => {
  const opened = store();
  const first = submitted(opened);
  putPlan(opened, plan({ planId: 'plan-broker-only', components: [plan().components[0]!], order: ['broker'] }), PEER);
  const second = opened.submitJob({ planId: 'plan-broker-only', idempotencyKey: 'key-2', principal: PEER, installationId: 'inst-a', installationGeneration: 1 });
  expect(second.status).toBe('in-progress');
  if (second.status !== 'in-progress') throw new Error('unreachable');
  expect(second.job.jobId).toBe(first.jobId);
});

test('a job cannot skip to verification, and the happy path records each phase once', () => {
  const opened = store();
  const job = submitted(opened);
  expect(opened.transition(job.jobId, 'host', 'verifying', 'skip-ahead').ok).toBe(false);
  for (const phase of ['preparing', 'ready', 'applying', 'verifying', 'succeeded'] as const) {
    const moved = opened.transition(job.jobId, 'host', phase, `enter-${phase}`);
    if (!moved.ok) throw new Error(`expected to reach ${phase}`);
  }
  const finished = opened.readJob(job.jobId);
  if (!finished.ok) throw new Error('unreachable');
  expect(finished.value.phase).toBe('succeeded');
  expect(finished.value.result).toBe('complete');
  expect(finished.value.sequence).toBe(6);
  expect(finished.value.events.map((event) => event.phase)).toEqual(['accepted', 'preparing', 'ready', 'applying', 'verifying', 'succeeded']);
});

/** Move a job to `ready`, the last phase at which both apply and cancel are still open. */
function ready(store: UpdateOperationStore, jobId: string): string {
  store.transition(jobId, 'host', 'preparing', 'staging');
  store.transition(jobId, 'host', 'ready', 'staged');
  return jobId;
}

test('a second device with the same update grant can neither commit nor cancel the job', () => {
  const opened = store();
  const job = ready(opened, submitted(opened, 'key-owned-by-peer', PEER).jobId);

  // Authority to update this server is not authority over whoever else used it first. Both
  // mutations were previously accepted on somebody else's job, which is the whole defect.
  expect(opened.acceptApply(job, OTHER_PEER).status).toBe('forbidden');
  expect(opened.cancel(job, OTHER_PEER).ok).toBe(false);
  expect(opened.cancel(job, OTHER_PEER).reason).toBe('forbidden');
  const moved = opened.transition(job, OTHER_PEER, 'cancelled', 'somebody-elses-consent');
  expect(moved.ok).toBe(false);
  if (moved.ok) throw new Error('unreachable');
  expect(moved.reason).toBe('forbidden');
  expect(opened.readJob(job).ok && (opened.readJob(job) as { value: UpdateJob }).value.phase).toBe('ready');

  // The principal that reviewed it still can, and the record behind it is intact.
  const written = opened.readJob(job);
  if (!written.ok) throw new Error('unreachable');
  expect(written.value.events.some((event) => event.detailCode === 'somebody-elses-consent')).toBe(false);
  expect(opened.acceptApply(job, PEER).status).toBe('accepted');
});

test('the owner credential stops a peer job, and the host settles one whose record is gone', () => {
  const opened = store();
  const job = ready(opened, submitted(opened, 'key-owned-by-peer', PEER).jobId);
  // The owner owns the grant store and the terminal this service runs from, so an owner who
  // can read the job can also stop it. That is a different rank from another peer's grant.
  expect(opened.cancel(job, OWNER).ok).toBe(true);

  const orphan = ready(opened, submitted(opened, 'key-orphan', PEER).jobId);
  rmSync(join(root(opened), 'authority', `${orphan}.json`), { force: true });
  expect(opened.acceptApply(orphan, PEER).status).toBe('forbidden');
  // Nobody can claim an unreadable record, and that is not a reason to strand the component:
  // the host still settles it.
  expect(opened.transition(orphan, 'host', 'needs_attention', 'host-settles-it').ok).toBe(true);
});

test('apply is accepted durably once and is idempotent afterwards', () => {
  const opened = store();
  const job = submitted(opened);
  expect(opened.acceptApply(job.jobId, OWNER).status).toBe('not-ready');
  opened.transition(job.jobId, 'host', 'preparing', 'staging');
  opened.transition(job.jobId, 'host', 'ready', 'staged');
  const accepted = opened.acceptApply(job.jobId, OWNER);
  expect(accepted.status).toBe('accepted');
  const repeated = opened.acceptApply(job.jobId, OWNER);
  expect(repeated.status).toBe('existing');
  if (repeated.status !== 'existing') throw new Error('unreachable');
  expect(repeated.job.applyAcceptedAt).toBe((accepted as { job: UpdateJob }).job.applyAcceptedAt);
});

test('cancel stops work before commit and cannot undo a commit that already started', () => {
  const opened = store();
  const job = submitted(opened);
  expect(opened.cancel(job.jobId, OWNER).ok).toBe(true);

  const second = submitted(opened, 'key-2');
  opened.transition(second.jobId, 'host', 'preparing', 'staging');
  opened.transition(second.jobId, 'host', 'ready', 'staged');
  opened.acceptApply(second.jobId, OWNER);
  opened.transition(second.jobId, 'host', 'applying', 'committing');
  const refused = opened.cancel(second.jobId, OWNER);
  expect(refused.ok).toBe(false);
  expect(refused.reason).toBe('already-committing');
});

test('a component that landed while another failed reads as partial, never as a whole failure', () => {
  const opened = store();
  const job = submitted(opened);
  opened.transition(job.jobId, 'host', 'preparing', 'staging');
  opened.transition(job.jobId, 'host', 'ready', 'staged');
  opened.acceptApply(job.jobId, OWNER);
  opened.transition(job.jobId, 'host', 'applying', 'committing');
  const failed = opened.transition(job.jobId, 'host', 'failed', 'desktop-replace-refused', [
    { component: 'broker', outcome: 'verified', actual: { version: '1.1.0' } },
    { component: 'client', outcome: 'failed', actual: { version: '1.0.0' } },
  ]);
  if (!failed.ok) throw new Error('unreachable');
  expect(failed.job.result).toBe('partial');
  expect(failed.job.components.find((component) => component.component === 'broker')?.actual.version).toBe('1.1.0');
  expect(failed.job.components.find((component) => component.component === 'client')?.actual.version).toBe('1.0.0');
});

test('history is bounded but a half-applied update is never trimmed away', () => {
  const opened = store({ retainFinished: 2 });
  for (let index = 0; index < 5; index += 1) {
    const job = submitted(opened, `key-${index}`);
    for (const phase of ['preparing', 'ready', 'applying', 'verifying', 'succeeded'] as const) {
      opened.transition(job.jobId, 'host', phase, 'advance');
    }
  }
  const partial = submitted(opened, 'key-partial');
  opened.transition(partial.jobId, 'host', 'preparing', 'staging');
  const pruned = opened.prune();
  expect(pruned.removed.length).toBe(3);
  expect(pruned.retained).toContain(partial.jobId);
  expect(opened.listJobs().some((job) => job.jobId === partial.jobId)).toBe(true);
});

test('a job written by a newer build is left exactly where it is', () => {
  const opened = store();
  const job = submitted(opened, 'key-future');
  const path = join(root(opened), 'jobs', `${job.jobId}.json`);
  const future = JSON.stringify({ ...job, schemaVersion: 999, phase: 'applying' });
  writeFileSync(path, future, { mode: 0o600 });

  const read = opened.readJob(job.jobId);
  expect(read).toEqual({ ok: false, reason: 'unknown-schema' });
  opened.prune();
  expect(readFileSync(path, 'utf8')).toBe(future);
  expect(opened.recoverInterrupted()).toEqual([]);
});

test('a caller-supplied identifier cannot escape the record directory', () => {
  const opened = store();
  expect(() => putPlan(opened, plan({ planId: '../../escape' }), OWNER)).toThrow('update-record-id-invalid');
});

test('recovery sorts interrupted jobs by what the host may still do about them', () => {
  const opened = store();
  // A leftover from an installation identity this host has since replaced: it still
  // needs classifying, and it must not hold the current installation's components.
  const preparing = submitted(opened, 'key-a', OWNER, { installationId: 'inst-old', components: ['broker'], planId: 'plan-a' });
  opened.transition(preparing.jobId, 'host', 'preparing', 'staging');

  const committed = submitted(opened, 'key-b', OWNER, { components: ['client'], planId: 'plan-b' });
  opened.transition(committed.jobId, 'host', 'preparing', 'staging');
  opened.transition(committed.jobId, 'host', 'ready', 'staged');
  opened.acceptApply(committed.jobId, OWNER);
  opened.transition(committed.jobId, 'host', 'applying', 'committing');

  const stalled = submitted(opened, 'key-c', OWNER, { components: ['broker'], planId: 'plan-c' });
  opened.transition(stalled.jobId, 'host', 'preparing', 'staging');
  opened.transition(stalled.jobId, 'host', 'ready', 'staged');

  const recovered = opened.recoverInterrupted();
  const byId = new Map(recovered.map((entry) => [entry.job.jobId, entry.action]));
  // A lease says somebody meant to act; only an accepted apply says bytes may have moved.
  expect(byId.get(preparing.jobId)).toBe('resume-preparation');
  expect(byId.get(committed.jobId)).toBe('finish-committed');
  expect(byId.get(stalled.jobId)).toBe('needs-attention');
});

test('component identity is typed end to end, so a plan cannot smuggle a third scope', () => {
  const components: UpdateComponent[] = ['broker', 'client'];
  const job = submitted(store());
  expect(job.components.map((component) => component.component).sort()).toEqual(components.sort());
  expect(job.components.every((component) => component.outcome === 'pending')).toBe(true);
});

for (const directory of owned) {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
}
