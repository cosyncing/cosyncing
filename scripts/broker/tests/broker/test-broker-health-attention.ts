import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AttentionService } from '../../../../packages/typescript/broker/src/attention-service.ts';
import {
  BrokerHealthAttentionReconciler,
  brokerHealthObservationKey,
} from '../../../../packages/typescript/broker/src/broker-health-attention.ts';
import type {
  BrokerHealthComponent,
  BrokerHealthSnapshot,
  BrokerHealthStatus,
} from '../../../../packages/typescript/broker/src/broker-health.ts';

function snapshot(
  status: BrokerHealthStatus,
  unhealthy: BrokerHealthComponent[] = [],
  checkedAt = 1_800_000_000_000,
): BrokerHealthSnapshot {
  const component = (name: BrokerHealthComponent) => ({
    status: unhealthy.includes(name) ? status : ('healthy' as const),
    detailCodes: [],
    checkedAt,
  });
  const components: BrokerHealthSnapshot['components'] = {
    'attention-store': component('attention-store'),
    'artifact-store': component('artifact-store'),
    'state-filesystem': component('state-filesystem'),
    'artifact-filesystem': component('artifact-filesystem'),
  };
  return { status, checkedAt, components, diagnostics: {} };
}

async function seedHealthEvent(
  service: AttentionService,
  dedupeKey: string,
  blockerCount: number,
): Promise<void> {
  await service.upsertEvent({
    dedupeKey,
    kind: 'broker-health',
    state: 'active',
    severity: 'maintenance',
    title: 'Broker health degraded',
    action: { kind: 'open-broker-health' },
    presentationRevision: 1,
    presentationStage: 'immediate',
  });
  await service.store.putObservation({
    key: brokerHealthObservationKey(dedupeKey),
    kind: 'broker-health-blocker-count',
    observedAt: 1,
    data: { blockerCount },
  });
}

async function testRestartThenHealthyResolvesDurableEpisode(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-health-attention-restart-'));
  const path = join(root, 'attention-events.json');
  try {
    const beforeRestart = new AttentionService({ store: { path } });
    const durableKey = 'broker-health:test-machine:100';
    await seedHealthEvent(beforeRestart, durableKey, 1);
    beforeRestart.dispose();

    const afterRestart = new AttentionService({ store: { path } });
    const reconciler = new BrokerHealthAttentionReconciler({
      attentionService: afterRestart,
      machine: 'test-machine',
      requestDirectWake: () => {},
    });
    await reconciler.reconcile(snapshot('healthy'));

    const events = afterRestart.store.listEvents().filter(
      (event) => event.kind === 'broker-health',
    );
    assert.equal(events.length, 1, 'restart recovery must not mint another episode');
    assert.equal(events[0]?.dedupeKey, durableKey);
    assert.equal(events[0]?.state, 'resolved');
    assert.equal(
      afterRestart.store.getObservation(brokerHealthObservationKey(durableKey)),
      undefined,
      'recovery must clear the durable blocker-count observation',
    );
    afterRestart.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testRestartWhileUnhealthyAdoptsOldestAndResolvesExtras(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-health-attention-duplicate-'));
  const path = join(root, 'attention-events.json');
  let now = 1_800_000_000_000;
  try {
    const beforeRestart = new AttentionService({
      store: { path, now: () => now },
    });
    const oldestKey = 'broker-health:test-machine:100';
    const duplicateKey = 'broker-health:test-machine:200';
    await seedHealthEvent(beforeRestart, oldestKey, 1);
    now += 1_000;
    await seedHealthEvent(beforeRestart, duplicateKey, 2);
    beforeRestart.dispose();

    const afterRestart = new AttentionService({
      store: { path, now: () => now },
    });
    const reconciler = new BrokerHealthAttentionReconciler({
      attentionService: afterRestart,
      machine: 'test-machine',
      requestDirectWake: () => {},
    });
    await reconciler.reconcile(
      snapshot('degraded', ['state-filesystem'], now),
    );

    const healthEvents = afterRestart.store.listEvents().filter(
      (event) => event.kind === 'broker-health',
    );
    const active = healthEvents.filter((event) => event.state === 'active');
    assert.equal(active.length, 1, 'only one durable episode may stay active');
    assert.equal(active[0]?.dedupeKey, oldestKey, 'restart adopts the oldest episode');
    assert.equal(
      healthEvents.find((event) => event.dedupeKey === duplicateKey)?.state,
      'resolved',
      'duplicate active episodes must be resolved once persistence is writable',
    );
    assert.equal(
      afterRestart.store.getObservation(brokerHealthObservationKey(duplicateKey)),
      undefined,
      'duplicate observation must be cleared with its event',
    );
    afterRestart.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testCriticalCopyAndInjectedObservationClock(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-health-attention-clock-'));
  const path = join(root, 'attention-events.json');
  const observedAt = 1_900_000_000_123;
  try {
    const service = new AttentionService({ store: { path } });
    const reconciler = new BrokerHealthAttentionReconciler({
      attentionService: service,
      machine: 'test-machine',
      requestDirectWake: () => {},
      now: () => observedAt,
    });
    await reconciler.reconcile(
      snapshot('critical', ['artifact-store'], observedAt),
    );

    const event = service.store.listActive().find(
      (candidate) => candidate.kind === 'broker-health',
    );
    assert.equal(
      event?.summary,
      'Broker persistence is critical (1 component).',
      'critical incidents must not describe themselves as merely degraded',
    );
    assert.equal(
      service.store.getObservation(
        brokerHealthObservationKey(event!.dedupeKey),
      )?.observedAt,
      observedAt,
      'new blocker observations must use the reconciler clock',
    );
    service.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await testRestartThenHealthyResolvesDurableEpisode();
await testRestartWhileUnhealthyAdoptsOldestAndResolvesExtras();
await testCriticalCopyAndInjectedObservationClock();
console.log('PASS broker-health attention restart reconciliation and copy/clock (3 groups)');
