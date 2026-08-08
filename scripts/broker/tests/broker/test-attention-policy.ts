#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentRuntimeUpdateStatus, SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { AttentionStore } from '../../../../packages/typescript/broker/src/attention-store.ts';
import { AttentionPolicy } from '../../../../packages/typescript/broker/src/attention-policy.ts';
import {
  RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT,
  type RuntimeUpdateInspection,
} from '../../../../packages/typescript/broker/src/runtime-update.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-policy-'));
let now = 1_000_000;
let ids = 0;
const store = new AttentionStore({ home: root, now: () => now, idFactory: () => `event-${++ids}` });
const policy = new AttentionPolicy(store, { now: () => now });
const session: SessionInfo = {
  id: 'session-1', tool: 'codex', machine: 'test', title: 'test', status: 'idle', attachMode: 'live',
};
const send = (message: AgentMessage) => policy.handleMessage(session, message);

try {
  await send({ type: 'permission-request', requestId: 'permission-1', title: 'secret prompt detail' });
  await send({ type: 'permission-request', requestId: 'permission-1', title: 'replayed secret' });
  let active = store.listActive();
  assert.equal(active.length, 1, 'replayed actionable request dedupes');
  assert.equal(active[0]?.kind, 'permission-required');
  assert.equal(active[0]?.sessionTitle, session.title,
    'permission events capture the authoritative session title');
  assert.equal(JSON.stringify(active[0]).includes('secret'), false, 'attention copy remains generic');
  await send({ type: 'permission-resolved', requestId: 'permission-1', decision: 'approve' });
  assert.equal(store.findByDedupeKey('permission-required:codex:session-1:permission-1')?.state, 'resolved');

  await send({
    type: 'question-request', requestId: 'read-only', readOnly: true,
    questions: [{ question: 'secret', options: [{ label: 'yes' }] }],
  });
  assert.equal(store.findByDedupeKey('question-required:codex:session-1:read-only'), undefined,
    'read-only observe placeholders are not actionable');

  await send({ type: 'run-summary', key: 'short', turnId: 'turn-short', status: 'running' });
  now += 3_400;
  await send({ type: 'run-summary', key: 'short', turnId: 'turn-short', status: 'done' });
  const short = store.findByDedupeKey('run-finished:codex:session-1:turn-short');
  assert.equal(short?.state, 'resolved',
    'production defaults retain an authoritative 3.4-second completion');
  assert.equal(short?.presentationRevision, 1);
  assert.equal(short?.summary, 'An agent task is ready to review.');
  assert.equal(short?.summary.includes('long-running'), false);

  await send({ type: 'run-summary', key: 'long', turnId: 'turn-long', status: 'running' });
  now += 60_000;
  await send({ type: 'run-summary', key: 'long', turnId: 'turn-long', status: 'done' });
  const finished = store.findByDedupeKey('run-finished:codex:session-1:turn-long');
  assert.equal(finished?.state, 'resolved');
  assert.equal(finished?.sessionTitle, session.title,
    'run-finished events capture the authoritative session title');

  await send({ type: 'run-summary', key: 'failed', turnId: 'turn-failed', status: 'running' });
  now += 1;
  await send({ type: 'run-summary', key: 'failed', turnId: 'turn-failed', status: 'error' });
  const failed = store.findByDedupeKey('run-failed:codex:session-1:turn-failed');
  assert.equal(failed?.state, 'resolved',
    'run failures are not duration gated');
  assert.equal(failed?.sessionTitle, session.title,
    'run-failed events capture the authoritative session title');

  await send({ type: 'goal-state', key: 'goal-1', title: 'private goal title', status: 'active' });
  await send({ type: 'goal-state', key: 'goal-1', title: 'private goal title', status: 'done' });
  const goal = store.findByDedupeKey('goal-finished:codex:session-1:goal-1');
  assert.equal(goal?.state, 'resolved');
  assert.equal(goal?.sessionTitle, session.title,
    'goal-finished events capture the authoritative session title');
  assert.equal(JSON.stringify(goal).includes('private goal'), false);

  await send({ type: 'question-request', requestId: 'pending', questions: [{ question: 'x', options: [] }] });
  assert.equal(
    store.findByDedupeKey('question-required:codex:session-1:pending')?.sessionTitle,
    session.title,
    'question events capture the authoritative session title',
  );
  await send({ type: 'run-summary', key: 'ended-run', turnId: 'ended-turn', status: 'running' });
  await send({ type: 'goal-state', key: 'ended-goal', title: 'ended', status: 'active' });
  await policy.handleSessionEnded(session);
  assert.equal(store.findByDedupeKey('question-required:codex:session-1:pending')?.state, 'resolved');
  assert.equal(store.getObservation('run:codex:session-1:ended-run'), undefined,
    'session end clears live run evidence');
  assert.equal(store.getObservation('goal:codex:session-1:ended-goal'), undefined,
    'session end clears live goal evidence');
  await send({ type: 'run-summary', key: 'ended-run', turnId: 'ended-turn', status: 'error' });
  await send({ type: 'goal-state', key: 'ended-goal', title: 'ended', status: 'done' });
  assert.equal(store.findByDedupeKey('run-failed:codex:session-1:ended-turn'), undefined,
    'late terminal frames after session end cannot create a notification');
  assert.equal(store.findByDedupeKey('goal-finished:codex:session-1:ended-goal'), undefined,
    'late goal terminal frames after session end cannot create a notification');

  await send({ type: 'run-summary', key: 'lost-run', turnId: 'lost-turn', status: 'running' });
  await send({ type: 'goal-state', key: 'lost-goal', title: 'lost', status: 'active' });
  await policy.handleObservationLost(session);
  assert.equal(store.getObservation('run:codex:session-1:lost-run'), undefined,
    'connection replacement/disposal clears incomplete run evidence');
  assert.equal(store.getObservation('goal:codex:session-1:lost-goal'), undefined,
    'connection replacement/disposal clears incomplete goal evidence');

  const pendingRuntime: AgentRuntimeUpdateStatus = {
    agent: 'codex', displayName: 'Codex', managed: true, state: 'pending', updateAvailable: true,
    autoRestartReady: false, installedVersion: '0.2', runningVersion: '0.1', checkedAt: now,
  };
  const runtimeRoot = join(root, 'runtime-lifecycle');
  const runtimeStoreA = new AttentionStore({
    home: runtimeRoot,
    now: () => now,
    idFactory: () => `runtime-event-${++ids}`,
  });
  const runtimePolicyA = new AttentionPolicy(runtimeStoreA, { now: () => now, runtimeBootId: 'boot-a' });
  await runtimePolicyA.reconcileRuntimeStatus(pendingRuntime);
  const runtime = runtimeStoreA.listActive().find((event) => event.kind === 'runtime-update-ready');
  assert(runtime);
  assert.equal(runtime.presentationStage, 'immediate');
  assert.equal(runtime.presentationRevision, 1, 'first pending observation presents immediately once');

  await runtimePolicyA.reconcileRuntimeStatus({ ...pendingRuntime, state: 'error', updateAvailable: false });
  await runtimePolicyA.reconcileRuntimeStatus({
    ...pendingRuntime,
    managed: false,
    state: 'unavailable',
    updateAvailable: false,
  });
  assert.equal(runtimeStoreA.getEvent(runtime.id)?.state, 'active',
    'failed and unavailable probes preserve the last confirmed occurrence');
  await runtimeStoreA.advancePresentationAndReserve(runtime.id, '2h', ['phone']);
  const beforeRestart = runtimeStoreA.getEvent(runtime.id);
  const deliveriesBeforeRestart = runtimeStoreA.listDeliveries();
  assert(beforeRestart);

  now += 60_000;
  const runtimeStoreB = new AttentionStore({
    home: runtimeRoot,
    now: () => now,
    idFactory: () => `runtime-event-${++ids}`,
  });
  const runtimePolicyB = new AttentionPolicy(runtimeStoreB, { now: () => now, runtimeBootId: 'boot-b' });
  await runtimePolicyB.reconcileRuntimeStatus(pendingRuntime);
  const afterRestart = runtimeStoreB.listEvents().filter((event) => event.kind === 'runtime-update-ready');
  assert.equal(afterRestart.length, 1, 'a broker restart must not create a second unchanged occurrence');
  assert.equal(afterRestart[0]?.id, runtime.id);
  assert.equal(afterRestart[0]?.createdAt, runtime.createdAt);
  assert.deepEqual(afterRestart[0], beforeRestart);
  assert.deepEqual(runtimeStoreB.listDeliveries(), deliveriesBeforeRestart,
    'a broker restart must not recreate delivery reservations');

  const changedRuntime: AgentRuntimeUpdateStatus = {
    ...pendingRuntime,
    installedVersion: '0.3',
    pendingChanges: ['binary-version', 'configuration'],
  };
  await runtimePolicyB.reconcileRuntimeStatus(changedRuntime);
  const afterChange = runtimeStoreB.listEvents().filter((event) => event.kind === 'runtime-update-ready');
  assert.equal(afterChange.length, 2, 'a changed version/configuration fingerprint creates one occurrence');
  const changedEvent = afterChange.find((event) => event.state === 'active');
  assert(changedEvent);
  assert.notEqual(changedEvent.id, runtime.id);
  assert.equal(runtimeStoreB.getEvent(runtime.id)?.state, 'resolved');
  assert.equal(changedEvent.presentationStage, 'immediate');
  assert.equal(changedEvent.presentationRevision, 1);
  assert.match(changedEvent.summary ?? '', /configuration changed/i);

  await runtimePolicyB.reconcileRuntimeStatus({
    ...changedRuntime,
    state: 'current',
    updateAvailable: false,
    runningVersion: changedRuntime.installedVersion,
    pendingChanges: [],
  });
  const resolved = runtimeStoreB.getEvent(changedEvent.id);
  assert.equal(resolved?.state, 'resolved');
  await runtimePolicyB.reconcileRuntimeStatus({
    ...changedRuntime,
    state: 'current',
    updateAvailable: false,
    runningVersion: changedRuntime.installedVersion,
    pendingChanges: [],
  });
  assert.deepEqual(runtimeStoreB.getEvent(changedEvent.id), resolved,
    'repeated current observations resolve idempotently');

  await runtimePolicyB.reconcileRuntimeStatus(changedRuntime);
  const returning = runtimeStoreB.listActive().find((event) => event.kind === 'runtime-update-ready');
  assert(returning);
  assert.notEqual(returning.id, changedEvent.id,
    'the same fingerprint after a confirmed current interval is a new occurrence');
  assert.equal(returning.presentationStage, 'immediate');
  assert.equal(returning.presentationRevision, 1);

  const configRoot = join(root, 'runtime-config-fingerprint');
  const configStore = new AttentionStore({
    home: configRoot,
    now: () => now,
    idFactory: () => `runtime-event-${++ids}`,
  });
  const configPolicy = new AttentionPolicy(configStore, { now: () => now });
  const configA: RuntimeUpdateInspection = {
    ...pendingRuntime,
    installedVersion: '0.2',
    runningVersion: '0.2',
    pendingChanges: ['configuration'],
  };
  configA[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = 'config-fingerprint-a';
  await configPolicy.reconcileRuntimeStatus(configA);
  const configEventA = configStore.listActive().find((event) => event.kind === 'runtime-update-ready');
  assert(configEventA);
  assert.match(configEventA.summary ?? '', /configuration changed/i);

  const configB: RuntimeUpdateInspection = { ...configA };
  configB[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = 'config-fingerprint-b';
  await configPolicy.reconcileRuntimeStatus(configB);
  const configEventB = configStore.listActive().find((event) => event.kind === 'runtime-update-ready');
  assert(configEventB);
  assert.notEqual(configEventB.id, configEventA.id,
    'changed configuration content supersedes the old occurrence even when versions are unchanged');
  assert.equal(configStore.getEvent(configEventA.id)?.state, 'resolved');
  assert.equal(configEventB.presentationStage, 'immediate');
  assert.equal(configEventB.presentationRevision, 1);

  const legacyBinaryRoot = join(root, 'legacy-runtime-binary');
  const legacyBinaryStore = new AttentionStore({
    home: legacyBinaryRoot,
    now: () => now,
    idFactory: () => `runtime-event-${++ids}`,
  });
  const legacyBinary = await legacyBinaryStore.upsertEvent({
    dedupeKey: 'runtime-update-ready:codex:0.1:0.2:boot:legacy',
    kind: 'runtime-update-ready',
    state: 'active',
    severity: 'maintenance',
    agent: 'codex',
    title: 'Managed runtime update ready',
    action: { kind: 'open-runtime-settings', agent: 'codex' },
    presentationRevision: 3,
    presentationStage: '12h',
  });
  await new AttentionPolicy(legacyBinaryStore, { now: () => now })
    .reconcileRuntimeStatus(pendingRuntime);
  const adoptedBinary = legacyBinaryStore.listActive().filter((event) =>
    event.kind === 'runtime-update-ready');
  assert.equal(adoptedBinary.length, 1);
  assert.equal(adoptedBinary[0]?.id, legacyBinary.event.id,
    'legacy binary-only version identity proves equivalence and preserves the occurrence');
  assert.equal(adoptedBinary[0]?.presentationStage, '12h');
  assert.equal(adoptedBinary[0]?.presentationRevision, 3);

  const legacyConfigRoot = join(root, 'legacy-runtime-configuration');
  const legacyConfigStore = new AttentionStore({
    home: legacyConfigRoot,
    now: () => now,
    idFactory: () => `runtime-event-${++ids}`,
  });
  const legacyConfig = await legacyConfigStore.upsertEvent({
    dedupeKey: 'runtime-update-ready:codex:configuration:0.2:0.2:boot:legacy',
    kind: 'runtime-update-ready',
    state: 'active',
    severity: 'maintenance',
    agent: 'codex',
    title: 'Managed runtime restart ready',
    action: { kind: 'open-runtime-settings', agent: 'codex' },
    presentationRevision: 3,
    presentationStage: '12h',
  });
  await legacyConfigStore.advancePresentationAndReserve(
    legacyConfig.event.id,
    '12h',
    ['phone'],
  );
  await new AttentionPolicy(legacyConfigStore, { now: () => now })
    .reconcileRuntimeStatus(configB);
  const migratedConfig = legacyConfigStore.listActive().find((event) =>
    event.kind === 'runtime-update-ready');
  assert(migratedConfig);
  assert.notEqual(migratedConfig.id, legacyConfig.event.id,
    'legacy configuration keys cannot prove content equality and start one explicit migration occurrence');
  assert.equal(legacyConfigStore.getEvent(legacyConfig.event.id)?.state, 'resolved');
  assert.equal(migratedConfig.presentationStage, 'immediate');
  assert.equal(migratedConfig.presentationRevision, 1);
  assert.equal(
    legacyConfigStore.listDeliveries().find((delivery) =>
      delivery.eventId === legacyConfig.event.id)?.state,
    'superseded',
  );

  console.log('PASS: attention policy live evidence, privacy, duration, failure, goal, request, loss, and persisted runtime lifecycle');
} finally {
  rmSync(root, { recursive: true, force: true });
}
