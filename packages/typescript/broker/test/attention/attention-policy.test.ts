/**
 * Which agent messages become attention events, replayed straight into the policy.
 *
 * The e2e suites (`e2e/broker/attention-*.test.ts`) drive requests, turn outcomes and session ends
 * through a scripted Pi session. What stays here are the message shapes that no scriptable agent
 * source can send to a broker under test: Codex turn generations and thread-keyed goals, background
 * and mid-turn runs, a cosyncing roster title, a connection replacement or a day-old observation,
 * and the managed-runtime update lifecycle, which needs a real runtime probe.
 */
import { afterAll, describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, AgentRuntimeUpdateStatus, SessionInfo } from '../../../adapter-api/src/index.ts';
import { attentionSessionView } from '../../src/attention/attention-notification-type.ts';
import { AttentionPolicy } from '../../src/attention/attention-policy.ts';
import { AttentionService } from '../../src/attention/attention-service.ts';
import { AttentionStore } from '../../src/attention/attention-store.ts';
import { RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT, type RuntimeUpdateInspection } from '../../src/updates/runtime-update.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const roots: string[] = [];
// One id sequence for the file, so a second store over the same home (a restart) never reuses one.
let ids = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-attention-policy-'));
  roots.push(root);
  return root;
}

/** A store and policy over a fresh root with a clock the test moves. */
function world(options: { tool?: string; title?: string; runtimeBootId?: string; home?: string } = {}) {
  const clock = { now: 1_000_000 };
  const home = options.home ?? tempRoot();
  const store = new AttentionStore({ home, now: () => clock.now, idFactory: () => `event-${++ids}` });
  const policy = new AttentionPolicy(store, { now: () => clock.now, runtimeBootId: options.runtimeBootId });
  const session: SessionInfo = {
    id: 'session-1', tool: options.tool ?? 'codex', machine: 'test', title: options.title ?? 'test', status: 'idle', attachMode: 'live',
  };
  const send = (message: AgentMessage, as: SessionInfo = session) => policy.handleMessage(as, message);
  return { clock, home, store, policy, session, send };
}

const question = (requestId: string, extra: Record<string, unknown> = {}): AgentMessage => ({
  type: 'question-request', requestId, questions: [{ question: 'go?', options: [{ label: 'yes' }] }], ...extra,
} as AgentMessage);

describe('requests', () => {
  test('a read-only placeholder and an asynchronous question raise nothing; an explicitly blocking one does', async () => {
    const { store, send } = world();
    await send(question('read-only', { readOnly: true }));
    assert.equal(store.findByDedupeKey('question-required:codex:session-1:read-only'), undefined);
    await send(question('async', { blocking: false }));
    await send({ type: 'question-resolved', requestId: 'async' });
    assert.equal(store.findByDedupeKey('question-required:codex:session-1:async'), undefined);
    await send(question('blocking', { blocking: true }));
    assert.equal(store.findByDedupeKey('question-required:codex:session-1:blocking')?.state, 'active');
  });
});

describe('turn outcomes', () => {
  test('a finished goal is a resolved outcome under the session title, never the goal\'s own text', async () => {
    const { store, send, session } = world();
    await send({ type: 'goal-state', key: 'goal-1', title: 'private goal title', status: 'active' });
    await send({ type: 'goal-state', key: 'goal-1', title: 'private goal title', status: 'done' });
    const goal = store.findByDedupeKey('goal-finished:codex:session-1:goal-1');
    assert.equal(goal?.state, 'resolved');
    assert.equal(goal?.sessionTitle, session.title);
    assert.equal(JSON.stringify(goal).includes('private goal'), false);
  });

  test('a turn shorter than any threshold still notifies', async () => {
    const { clock, store, send } = world();
    await send({ type: 'run-summary', key: 'short', turnId: 'turn-short', status: 'running' });
    clock.now += 3_400;
    await send({ type: 'run-summary', key: 'short', turnId: 'turn-short', status: 'done' });
    const short = store.findByDedupeKey('run-finished:codex:session-1:short');
    assert.equal(short?.state, 'resolved');
    assert.equal(short?.summary, 'An agent task is ready to review.');
  });

  test('a Codex turn id reopened as a new generation notifies again; a re-read of a reported one adds nothing', async () => {
    const { store, send } = world();
    for (const key of ['codex:run:reused', 'codex:run:reused@g2']) {
      await send({ type: 'run-summary', key, turnId: 'reused', status: 'running' });
      await send({ type: 'run-summary', key, turnId: 'reused', status: 'done' });
    }
    const generations = () => store.listEvents().filter((event) => event.turnId === 'reused');
    assert.deepEqual(generations().map((event) => event.dedupeKey), [
      'run-finished:codex:session-1:codex:run:reused',
      'run-finished:codex:session-1:codex:run:reused@g2',
    ]);
    const revisions = generations().map((event) => event.revision);
    await send({ type: 'run-summary', key: 'codex:run:reused@g2', turnId: 'reused', status: 'running' });
    await send({ type: 'run-summary', key: 'codex:run:reused@g2', turnId: 'reused', status: 'done' });
    assert.deepEqual(generations().map((event) => event.revision), revisions);
  });

  test('every goal in a Codex thread notifies, told apart by start time; a replaced goal never finishes', async () => {
    const { store, send } = world();
    await send({ type: 'goal-state', key: 'thread-1', title: 'first', status: 'active', startedAt: 100 });
    await send({ type: 'goal-state', key: 'thread-1', title: 'first', status: 'active', startedAt: 100, elapsedMs: 5 });
    await send({ type: 'goal-state', key: 'thread-1', title: 'first', status: 'done', startedAt: 100 });
    await send({ type: 'goal-state', key: 'thread-1', title: 'second', status: 'active', startedAt: 200 });
    // A terminal frame without a start time uses the observed one.
    await send({ type: 'goal-state', key: 'thread-1', title: 'second', status: 'done' });
    const threadGoals = () => store.listEvents()
      .filter((event) => event.kind === 'goal-finished' && event.goalKey === 'thread-1')
      .map((event) => event.dedupeKey);
    assert.deepEqual(threadGoals(), ['goal-finished:codex:session-1:thread-1:100', 'goal-finished:codex:session-1:thread-1:200']);

    await send({ type: 'goal-state', key: 'thread-1', title: 'replaced', status: 'active', startedAt: 300 });
    await send({ type: 'goal-state', key: 'thread-1', title: 'replacement', status: 'active', startedAt: 400 });
    assert.equal(store.getObservation('goal:codex:session-1:thread-1')?.data.startedAt, 400);
    await send({ type: 'goal-state', key: 'thread-1', title: 'replacement', status: 'done', startedAt: 400 });
    assert.deepEqual(threadGoals().slice(2), ['goal-finished:codex:session-1:thread-1:400']);
  });

  test('a run the tool opened itself never notifies and leaves nothing open; a prompted one does', async () => {
    const { clock, store, send } = world({ tool: 'claude' });
    for (const status of ['done', 'error'] as const) {
      const key = `session-1:run:wake-${status}`;
      await send({ type: 'run-summary', key, turnId: `wake-${status}`, status: 'running', origin: 'background' });
      clock.now += MINUTE;
      await send({ type: 'run-summary', key, turnId: `wake-${status}`, status, origin: 'background' });
    }
    assert.equal(store.listEvents().length, 0);
    assert.equal(store.listObservations().length, 0);
    await send({ type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'running', origin: 'user' });
    clock.now += MINUTE;
    await send({ type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'done', origin: 'user' });
    assert.equal(store.findByDedupeKey('run-finished:claude:session-1:session-1:run:u1')?.kind, 'run-finished');
  });

  test('a step that does not end its turn closes silently; the last step notifies once', async () => {
    const { clock, store, send } = world({ tool: 'kilo' });
    await send({ type: 'run-summary', key: 'kilo:run:step-1', turnId: 'step-1', status: 'running' });
    clock.now += 1_000;
    await send({ type: 'run-summary', key: 'kilo:run:step-1', turnId: 'step-1', status: 'done', turnContinues: true });
    assert.equal(store.listEvents().length, 0);
    assert.equal(store.listObservations().length, 0);
    await send({ type: 'run-summary', key: 'kilo:run:step-2', turnId: 'step-2', status: 'running' });
    clock.now += 1_000;
    await send({ type: 'run-summary', key: 'kilo:run:step-2', turnId: 'step-2', status: 'done' });
    assert.deepEqual(store.listEvents().map((event) => event.dedupeKey), ['run-finished:kilo:session-1:kilo:run:step-2']);
  });

  test('a session named in cosyncing notifies under that name, as the roster shows it', async () => {
    const { clock, store, send, session } = world({ tool: 'claude', title: 'workspace' });
    const titles = new Map([['claude:session-1', 'Refactor the parser']]);
    const titleOf = (tool: string, id: string) => titles.get(`${tool}:${id}`);
    assert.equal(attentionSessionView(session, titleOf).title, 'Refactor the parser');
    assert.equal(session.title, 'workspace', 'the adapter\'s own info is not changed');
    assert.equal(attentionSessionView({ ...session, id: 'other' }, titleOf).title, 'workspace');
    titles.set('claude:session-1', '   ');
    assert.equal(attentionSessionView(session, titleOf).title, 'workspace', 'a blank title is no title');
    titles.set('claude:session-1', 'Refactor the parser');

    await send({ type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'running' }, attentionSessionView(session, titleOf));
    clock.now += MINUTE;
    await send({ type: 'run-summary', key: 'session-1:run:u1', turnId: 'u1', status: 'done' }, attentionSessionView(session, titleOf));
    assert.equal(store.findByDedupeKey('run-finished:claude:session-1:session-1:run:u1')?.sessionTitle, 'Refactor the parser');
  });

  test('a running and a done summary that arrive together make one completion, and a replay adds none', async () => {
    const service = new AttentionService({ store: { home: tempRoot(), now: () => 1_000 }, policy: { now: () => 1_000 } });
    try {
      const session = { id: 'native', tool: 'codex', title: 'Native', status: 'idle' as const, attachMode: 'live' as const };
      const summary = (status: 'running' | 'done') => ({
        type: 'run-summary' as const, key: 'codex:run:native-turn', turnId: 'native-turn', status, source: 'codex-app-server',
      });
      // The hub does not await policy work, so the second starts before the first is durable.
      await Promise.all([service.handleMessage(session, summary('running')), service.handleMessage(session, summary('done'))]);
      await service.handleMessage(session, summary('done'));
      const completions = service.store.listEvents().filter((event) =>
        event.dedupeKey === 'run-finished:codex:native:codex:run:native-turn');
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.state, 'resolved');
      assert.equal(completions[0]?.presentationRevision, 1);
    } finally {
      service.dispose();
    }
  });
});

describe('connection loss', () => {
  test('session end clears open runs and goals, so their late terminal frames notify nothing', async () => {
    const { store, policy, send, session } = world();
    await send({ type: 'run-summary', key: 'ended-run', turnId: 'ended-turn', status: 'running' });
    await send({ type: 'goal-state', key: 'ended-goal', title: 'ended', status: 'active' });
    await policy.handleSessionEnded(session);
    await send({ type: 'run-summary', key: 'ended-run', turnId: 'ended-turn', status: 'error' });
    await send({ type: 'goal-state', key: 'ended-goal', title: 'ended', status: 'done' });
    assert.equal(store.findByDedupeKey('run-failed:codex:session-1:ended-run'), undefined);
    assert.equal(store.findByDedupeKey('goal-finished:codex:session-1:ended-goal'), undefined);
  });

  test('a replaced connection keeps recent evidence: the new owner reports the outcome once, the old owner\'s late frame adds nothing', async () => {
    const { clock, store, policy, send, session } = world();
    await send({ type: 'run-summary', key: 'lost-run', turnId: 'lost-turn', status: 'running' });
    await send({ type: 'goal-state', key: 'lost-goal', title: 'lost', status: 'active' });
    clock.now += MINUTE;
    await policy.handleObservationLost(session);
    await send({ type: 'run-summary', key: 'lost-run', turnId: 'lost-turn', status: 'running' });
    await send({ type: 'run-summary', key: 'lost-run', turnId: 'lost-turn', status: 'done' });
    await send({ type: 'goal-state', key: 'lost-goal', title: 'lost', status: 'done' });
    assert.equal(store.findByDedupeKey('run-finished:codex:session-1:lost-run')?.state, 'resolved');
    assert.equal(store.findByDedupeKey('goal-finished:codex:session-1:lost-goal')?.state, 'resolved');
    const revisions = store.listEvents().filter((event) => event.turnId === 'lost-turn').map((event) => event.revision);
    await send({ type: 'run-summary', key: 'lost-run', turnId: 'lost-turn', status: 'done' });
    assert.deepEqual(store.listEvents().filter((event) => event.turnId === 'lost-turn').map((event) => event.revision), revisions);
  });

  test('on a loss, every observation older than a day is dropped together and cannot notify later', async () => {
    const { clock, store, policy, send, session } = world();
    await send({ type: 'run-summary', key: 'stale-run', turnId: 'stale-turn', status: 'running' });
    await send({ type: 'run-summary', key: 'second-stale-run', turnId: 'second-stale-turn', status: 'running' });
    clock.now += 25 * HOUR;
    await send({ type: 'run-summary', key: 'fresh-run', turnId: 'fresh-turn', status: 'running' });
    await policy.handleObservationLost(session);
    assert.equal(store.getObservation('run:codex:session-1:stale-run'), undefined);
    assert.equal(store.getObservation('run:codex:session-1:second-stale-run'), undefined);
    assert.ok(store.getObservation('run:codex:session-1:fresh-run'));
    await send({ type: 'run-summary', key: 'stale-run', turnId: 'stale-turn', status: 'done' });
    assert.equal(store.findByDedupeKey('run-finished:codex:session-1:stale-run'), undefined);
  });
});

describe('managed runtime updates', () => {
  const pending = (checkedAt: number): AgentRuntimeUpdateStatus => ({
    agent: 'codex', displayName: 'Codex', managed: true, state: 'pending', updateAvailable: true,
    autoRestartReady: false, installedVersion: '0.2', runningVersion: '0.1', checkedAt,
  });

  test('one occurrence per fingerprint: kept through failed probes and a restart, replaced on a change, new after a current interval', async () => {
    const a = world({ runtimeBootId: 'boot-a' });
    await a.policy.reconcileRuntimeStatus(pending(a.clock.now));
    const first = a.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(first);
    assert.equal(first.presentationStage, 'immediate');
    assert.equal(first.presentationRevision, 1);

    await a.policy.reconcileRuntimeStatus({ ...pending(a.clock.now), state: 'error', updateAvailable: false });
    await a.policy.reconcileRuntimeStatus({ ...pending(a.clock.now), managed: false, state: 'unavailable', updateAvailable: false });
    assert.equal(a.store.getEvent(first.id)?.state, 'active', 'failed and unavailable probes keep the occurrence');
    await a.store.advancePresentationAndReserve(first.id, '2h', ['phone']);
    const beforeRestart = a.store.getEvent(first.id);
    const deliveriesBeforeRestart = a.store.listDeliveries();

    const b = world({ runtimeBootId: 'boot-b', home: a.home });
    b.clock.now = a.clock.now + MINUTE;
    await b.policy.reconcileRuntimeStatus(pending(b.clock.now));
    const afterRestart = b.store.listEvents().filter((event) => event.kind === 'runtime-update-ready');
    assert.deepEqual(afterRestart, [beforeRestart], 'a restart neither mints a second occurrence nor re-presents it');
    assert.deepEqual(b.store.listDeliveries(), deliveriesBeforeRestart, 'nor recreates its reservations');

    const changed: AgentRuntimeUpdateStatus = { ...pending(b.clock.now), installedVersion: '0.3', pendingChanges: ['binary-version', 'configuration'] };
    await b.policy.reconcileRuntimeStatus(changed);
    const replacement = b.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(replacement);
    assert.notEqual(replacement.id, first.id);
    assert.equal(b.store.getEvent(first.id)?.state, 'resolved');
    assert.equal(replacement.presentationStage, 'immediate');
    assert.match(replacement.summary ?? '', /configuration changed/i);

    const current = { ...changed, state: 'current' as const, updateAvailable: false, runningVersion: '0.3', pendingChanges: [] };
    await b.policy.reconcileRuntimeStatus(current);
    const resolved = b.store.getEvent(replacement.id);
    assert.equal(resolved?.state, 'resolved');
    await b.policy.reconcileRuntimeStatus(current);
    assert.deepEqual(b.store.getEvent(replacement.id), resolved, 'a repeated current probe changes nothing');

    await b.policy.reconcileRuntimeStatus(changed);
    const returning = b.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(returning);
    assert.notEqual(returning.id, replacement.id, 'the same fingerprint after a current interval is a new occurrence');
    assert.equal(returning.presentationRevision, 1);
  });

  test('changed configuration content supersedes the occurrence even when the versions are unchanged', async () => {
    const { clock, store, policy } = world();
    const configA: RuntimeUpdateInspection = { ...pending(clock.now), installedVersion: '0.2', runningVersion: '0.2', pendingChanges: ['configuration'] };
    configA[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = 'config-fingerprint-a';
    await policy.reconcileRuntimeStatus(configA);
    const eventA = store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(eventA);
    assert.match(eventA.summary ?? '', /configuration changed/i);
    const configB: RuntimeUpdateInspection = { ...configA };
    configB[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = 'config-fingerprint-b';
    await policy.reconcileRuntimeStatus(configB);
    const eventB = store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(eventB);
    assert.notEqual(eventB.id, eventA.id);
    assert.equal(store.getEvent(eventA.id)?.state, 'resolved');
    assert.equal(eventB.presentationStage, 'immediate');
  });

  test('an older broker\'s binary-only occurrence is adopted as is; its configuration occurrence is replaced once', async () => {
    const binary = world();
    const legacyBinary = await binary.store.upsertEvent({
      dedupeKey: 'runtime-update-ready:codex:0.1:0.2:boot:legacy', kind: 'runtime-update-ready', state: 'active',
      severity: 'maintenance', agent: 'codex', title: 'Managed runtime update ready',
      action: { kind: 'open-runtime-settings', agent: 'codex' }, presentationRevision: 3, presentationStage: '12h',
    });
    await binary.policy.reconcileRuntimeStatus(pending(binary.clock.now));
    const adopted = binary.store.listActive().filter((event) => event.kind === 'runtime-update-ready');
    assert.deepEqual(adopted.map((event) => [event.id, event.presentationStage, event.presentationRevision]), [[legacyBinary.event.id, '12h', 3]]);

    const config = world();
    const legacyConfig = await config.store.upsertEvent({
      dedupeKey: 'runtime-update-ready:codex:configuration:0.2:0.2:boot:legacy', kind: 'runtime-update-ready', state: 'active',
      severity: 'maintenance', agent: 'codex', title: 'Managed runtime restart ready',
      action: { kind: 'open-runtime-settings', agent: 'codex' }, presentationRevision: 3, presentationStage: '12h',
    });
    await config.store.advancePresentationAndReserve(legacyConfig.event.id, '12h', ['phone']);
    const inspection: RuntimeUpdateInspection = { ...pending(config.clock.now), installedVersion: '0.2', runningVersion: '0.2', pendingChanges: ['configuration'] };
    inspection[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT] = 'config-fingerprint';
    await config.policy.reconcileRuntimeStatus(inspection);
    const migrated = config.store.listActive().find((event) => event.kind === 'runtime-update-ready');
    assert.ok(migrated);
    assert.notEqual(migrated.id, legacyConfig.event.id, 'a legacy configuration key cannot prove the content is the same');
    assert.equal(config.store.getEvent(legacyConfig.event.id)?.state, 'resolved');
    assert.equal(migrated.presentationStage, 'immediate');
    assert.equal(config.store.listDeliveries().find((delivery) => delivery.eventId === legacyConfig.event.id)?.state, 'superseded');
  });
});

describe('seen state across alert stages', () => {
  test('a later stage or a re-alert is unseen again; the first stage, a detail update and a resolution are not', async () => {
    const { clock, store } = world();
    const upsert = (dedupeKey: string, overrides: Record<string, unknown> = {}) => store.upsertEvent({
      dedupeKey, kind: 'run-finished', state: 'active', severity: 'informational', title: 'Turn finished',
      action: { kind: 'open-attention-inbox' }, presentationRevision: 1, ...overrides,
    } as Parameters<AttentionStore['upsertEvent']>[0]);

    const request = (await upsert('permission-required:claude:s1:r1', { kind: 'permission-required', severity: 'action-required' })).event;
    clock.now += 1;
    await store.acknowledge(request.id, 'phone');
    await store.advancePresentationAndReserve(request.id, 'immediate', []);
    assert.equal(store.getEvent(request.id)?.seenAt, clock.now, 'the first stage is the alert a read may have raced');
    clock.now += 15 * MINUTE;
    await store.advancePresentationAndReserve(request.id, '15m', []);
    assert.equal(store.getEvent(request.id)?.seenAt, undefined, 'a later stage alerts every client again');

    const raised = (await upsert('run-finished:e')).event;
    await store.acknowledge(raised.id, 'phone');
    await upsert('run-finished:e', { summary: 'same alert, new detail' });
    assert.notEqual(store.getEvent(raised.id)?.seenAt, undefined);
    await upsert('run-finished:e', { state: 'resolved' });
    assert.notEqual(store.getEvent(raised.id)?.seenAt, undefined);
    await upsert('run-finished:e', { presentationRevision: 2 });
    assert.equal(store.getEvent(raised.id)?.seenAt, undefined, 'a re-alert is unseen');
  });
});
