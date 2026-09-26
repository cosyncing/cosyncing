import { createHash } from 'node:crypto';
import type {
  AgentMessage,
  AgentRuntimeUpdateStatus,
  AttentionEventUpsert,
  SessionInfo,
} from '@cosyncing/protocol';
import type { AttentionStore } from './attention-store.ts';
import {
  RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT,
  type RuntimeUpdateInspection,
} from '../updates/runtime-update.ts';

/** How long unfinished run and goal evidence survives the loss of the connection that saw it. */
export const LIVE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;

export interface AttentionPolicyOptions {
  now?: () => number;
  /** @deprecated Ignored. Process lifetime never defines update occurrence identity. */
  runtimeBootId?: string;
}

/** Converts live canonical/broker transitions into generic durable attention meaning. */
export class AttentionPolicy {
  private readonly now: () => number;

  constructor(
    private readonly store: AttentionStore,
    options: AttentionPolicyOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async handleMessage(session: SessionInfo, message: AgentMessage): Promise<void> {
    switch (message.type) {
      case 'permission-request':
        if (!message.readOnly) await this.upsertRequest(session, 'permission-required', message.requestId);
        return;
      case 'question-request':
        // An asynchronous question (`blocking: false`) does not stop the agent, which reads the answer
        // at a later input boundary. Its card stays in the session; it raises no attention event, so
        // it neither notifies nor collects reminders.
        if (!message.readOnly && message.blocking !== false) {
          await this.upsertRequest(session, 'question-required', message.requestId);
        }
        return;
      case 'permission-resolved':
        await this.store.resolveByDedupeKey(this.requestDedupe('permission-required', session, message.requestId));
        return;
      case 'question-resolved':
        await this.store.resolveByDedupeKey(this.requestDedupe('question-required', session, message.requestId));
        return;
      case 'run-summary':
        await this.handleRunSummary(session, message);
        return;
      case 'goal-state':
        await this.handleGoalState(session, message);
        return;
      default:
        return;
    }
  }

  /** The session's own connection withdrew these requests without a resolution frame (answered in
   *  the tool's terminal, or dropped). Their events resolve as if the frame had arrived. */
  async handlePendingWithdrawn(session: SessionInfo, requestIds: readonly string[]): Promise<void> {
    await Promise.all(requestIds.flatMap((requestId) => [
      this.store.resolveByDedupeKey(this.requestDedupe('permission-required', session, requestId)),
      this.store.resolveByDedupeKey(this.requestDedupe('question-required', session, requestId)),
    ]));
  }

  async handleSessionEnded(session: SessionInfo): Promise<void> {
    const active = this.store.listActive().filter((event) =>
      event.agent === session.tool
      && event.sessionId === session.id
      && (event.kind === 'permission-required' || event.kind === 'question-required' || event.kind === 'sync-degraded'));
    const observationPrefixes = [
      `run:${session.tool}:${session.id}:`,
      `goal:${session.tool}:${session.id}:`,
    ];
    const observations = this.store.listObservations().filter((observation) =>
      observationPrefixes.some((prefix) => observation.key.startsWith(prefix)));
    await Promise.all([
      ...active.map((event) => this.store.resolveByDedupeKey(event.dedupeKey)),
      ...observations.map((observation) => this.store.deleteObservation(observation.key)),
    ]);
  }

  /** Keeps a replaced or disposed connection's recent run and goal evidence.
   *
   *  A drive takeover, a reattach, or a lease-cap eviction swaps the owning connection while the
   *  native turn keeps running, and the replacement reports that turn's end. Dropping the running
   *  evidence here made that completion silent. Dedupe keys keep a terminal frame seen by both
   *  owners to one event. Evidence older than {@link LIVE_EVIDENCE_MAX_AGE_MS} is dropped, so a turn
   *  that never reported an end cannot hold a row forever. Actionable events stay active: losing
   *  observation is not proof the native request ended. */
  async handleObservationLost(session: SessionInfo): Promise<void> {
    const prefixes = [
      `run:${session.tool}:${session.id}:`,
      `goal:${session.tool}:${session.id}:`,
    ];
    const staleBefore = this.now() - LIVE_EVIDENCE_MAX_AGE_MS;
    const stale = this.store.listObservations().filter((observation) =>
      prefixes.some((prefix) => observation.key.startsWith(prefix))
      && observation.observedAt < staleBefore);
    await Promise.all(stale.map((observation) => this.store.deleteObservation(observation.key)));
  }

  async reconcileRuntimeStatus(status: AgentRuntimeUpdateStatus): Promise<void> {
    if (status.state === 'current') {
      await this.store.reconcileRuntimeUpdateOccurrence({
        agent: status.agent,
        state: 'current',
      });
      return;
    }
    // A failed/unavailable probe is unknown, not proof that confirmed drift disappeared.
    if (status.state !== 'pending' || !status.updateAvailable) return;
    if (!status.managed) return;
    if (!status.runningVersion || !status.installedVersion) return;

    const pendingChanges = status.pendingChanges?.length
      ? [...new Set(status.pendingChanges)].sort()
      : ['binary-version' as const];
    const changeKey = pendingChanges.length === 1 && pendingChanges[0] === 'binary-version'
      ? ''
      : `${pendingChanges.join('+')}:`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        agent: status.agent,
        pendingChanges,
        runningVersion: status.runningVersion,
        installedVersion: status.installedVersion,
        configuration:
          (status as RuntimeUpdateInspection)[RUNTIME_UPDATE_OCCURRENCE_FINGERPRINT],
      }))
      .digest('hex');
    const dedupeKeyBase =
      `runtime-update-ready:${status.agent}:${changeKey}${status.runningVersion}:${status.installedVersion}`;
    await this.store.reconcileRuntimeUpdateOccurrence({
      agent: status.agent,
      state: 'pending',
      fingerprint,
      dedupeKeyBase,
      // Pre-F4d binary-only keys contain the complete version identity.
      // Configuration-bearing keys never contained the config content hash.
      legacyDedupeProvesFingerprint:
        pendingChanges.length === 1 && pendingChanges[0] === 'binary-version',
      event: {
        kind: 'runtime-update-ready',
        state: 'active',
        severity: 'maintenance',
        agent: status.agent,
        title: pendingChanges.includes('configuration')
          ? 'Managed runtime restart ready'
          : 'Managed runtime update ready',
        summary: pendingChanges.includes('configuration')
          ? `${status.displayName} configuration changed and is waiting for a safe managed-runtime restart.`
          : 'An update is waiting in managed-runtime settings.',
        action: { kind: 'open-runtime-settings', agent: status.agent },
        presentationRevision: 1,
        presentationStage: 'immediate',
      },
    });
  }

  private async upsertRequest(
    session: SessionInfo,
    kind: 'permission-required' | 'question-required',
    requestId: string,
  ): Promise<void> {
    const permission = kind === 'permission-required';
    await this.store.upsertEvent({
      dedupeKey: this.requestDedupe(kind, session, requestId),
      kind,
      state: 'active',
      severity: 'action-required',
      agent: session.tool,
      sessionId: session.id,
      ...this.sessionTitleSnapshot(session),
      requestId,
      title: permission ? 'Permission required' : 'Question requires an answer',
      summary: permission ? 'An agent is waiting for permission.' : 'An agent is waiting for your answer.',
      action: { kind: 'open-session', tool: session.tool, sessionId: session.id },
      presentationRevision: 1,
      presentationStage: 'immediate',
    });
  }

  private requestDedupe(
    kind: 'permission-required' | 'question-required',
    session: SessionInfo,
    requestId: string,
  ): string {
    return `${kind}:${session.tool}:${session.id}:${requestId}`;
  }

  private async handleRunSummary(
    session: SessionInfo,
    message: Extract<AgentMessage, { type: 'run-summary' }>,
  ): Promise<void> {
    const observationKey = `run:${session.tool}:${session.id}:${message.key}`;
    // A run the tool opened itself (a background continuation) never notifies: without the
    // running half its terminal has no pair.
    if (message.origin === 'background') return;
    if (message.status === 'running') {
      const existing = this.store.getObservation(observationKey);
      if (!existing) {
        await this.store.putObservation({
          key: observationKey,
          kind: 'run',
          observedAt: this.now(),
          data: { turnId: message.turnId },
        });
      }
      return;
    }

    const observation = this.store.getObservation(observationKey);
    if (!observation) return;
    await this.store.deleteObservation(observationKey);
    const turnId = typeof observation.data.turnId === 'string' ? observation.data.turnId : message.turnId;
    // One event per run occurrence, keyed as the adapter keys the run's transcript footer. A turn id
    // alone is not an occurrence: Codex reopens a closed turn id as a new generation with its own
    // `@gN` run key, and deduping on the turn id made every later generation silent.
    const occurrence = `${session.tool}:${session.id}:${message.key}`;
    if (message.status === 'error') {
      await this.store.upsertEvent(this.completedSessionEvent({
        session,
        kind: 'run-failed',
        dedupeKey: `run-failed:${occurrence}`,
        turnId,
        title: 'Agent run failed',
        summary: 'A background agent run ended with an error.',
      }));
      return;
    }
    if (message.status !== 'done') return;
    // One step of a turn that goes on: the turn's last step raises its outcome.
    if (message.turnContinues) return;
    await this.store.upsertEvent(this.completedSessionEvent({
      session,
      kind: 'run-finished',
      dedupeKey: `run-finished:${occurrence}`,
      turnId,
      title: 'Agent run finished',
      summary: 'An agent task is ready to review.',
    }));
  }

  private async handleGoalState(
    session: SessionInfo,
    message: Extract<AgentMessage, { type: 'goal-state' }>,
  ): Promise<void> {
    const goalKey = message.key ?? 'current';
    const observationKey = `goal:${session.tool}:${session.id}:${goalKey}`;
    const startedAt = goalStartedAt(message.startedAt);
    if (message.status === 'active') {
      const existing = this.store.getObservation(observationKey);
      // A different start time under the same key is a new goal that replaced the old one (Codex keys
      // goals by thread), so the observation follows the goal that is active now.
      if (!existing || (startedAt !== undefined && existing.data.startedAt !== startedAt)) {
        await this.store.putObservation({
          key: observationKey,
          kind: 'goal',
          observedAt: this.now(),
          data: { goalKey, ...(startedAt !== undefined ? { startedAt } : {}) },
        });
      }
      return;
    }
    const observation = this.store.getObservation(observationKey);
    if (!observation) return;
    await this.store.deleteObservation(observationKey);
    if (message.status !== 'done') return;
    // The goal key names a slot, not a goal: Codex reuses the thread id for every goal in a thread,
    // so the start time is what tells one finished goal from the next.
    const occurrence = startedAt ?? goalStartedAt(observation.data.startedAt);
    await this.store.upsertEvent(this.completedSessionEvent({
      session,
      kind: 'goal-finished',
      dedupeKey: `goal-finished:${session.tool}:${session.id}:${goalKey}${occurrence !== undefined ? `:${occurrence}` : ''}`,
      goalKey,
      title: 'Goal finished',
      summary: 'An agent goal is ready to review.',
    }));
  }

  private completedSessionEvent(input: {
    session: SessionInfo;
    kind: 'run-finished' | 'run-failed' | 'goal-finished';
    dedupeKey: string;
    title: string;
    summary: string;
    turnId?: string;
    goalKey?: string;
  }): AttentionEventUpsert {
    return {
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      state: 'resolved',
      severity: 'informational',
      agent: input.session.tool,
      sessionId: input.session.id,
      ...this.sessionTitleSnapshot(input.session),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.goalKey ? { goalKey: input.goalKey } : {}),
      title: input.title,
      summary: input.summary,
      action: { kind: 'open-session', tool: input.session.tool, sessionId: input.session.id },
      presentationRevision: 1,
      presentationStage: 'immediate',
    };
  }

  private sessionTitleSnapshot(session: SessionInfo): { sessionTitle?: string } {
    const sessionTitle = session.title?.replace(/\s+/g, ' ').trim();
    return sessionTitle ? { sessionTitle: sessionTitle.slice(0, 200) } : {};
  }
}

function goalStartedAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export interface AuthFailureAttentionTrackerOptions {
  now?: () => number;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

/** Content-free, bounded detector for repeated shared-token failures. */
export class AuthFailureAttentionTracker {
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private failures: number[] = [];
  private lastIncidentAt: number | undefined;

  constructor(options: AuthFailureAttentionTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.threshold = Math.max(2, Math.floor(options.threshold ?? 5));
    this.windowMs = Math.max(1_000, options.windowMs ?? 10 * 60_000);
    this.cooldownMs = Math.max(this.windowMs, options.cooldownMs ?? 60 * 60_000);
  }

  recordFailure(): string | undefined {
    const now = this.now();
    if (this.lastIncidentAt !== undefined && now - this.lastIncidentAt < this.cooldownMs) {
      // A cooldown suppresses the whole incident, not just its notification. Retaining attacker-driven
      // timestamps here makes every request filter an unbounded array and primes an immediate incident at
      // cooldown expiry. Discard them instead; a new incident requires a new bounded threshold crossing.
      this.failures = [];
      return undefined;
    }
    this.failures = this.failures.filter((at) => now - at <= this.windowMs);
    this.failures.push(now);
    if (this.failures.length < this.threshold) return undefined;
    this.lastIncidentAt = now;
    this.failures = [];
    return `auth-failures:${now}`;
  }
}

/** Generic control-path evidence the Hub reports, without agent-name branches. Logged for diagnosis;
 *  it raises no attention event. */
export interface SessionControlTransition {
  tool: string;
  sessionId: string;
  sessionTitle?: string;
  path: 'drive' | 'terminal-sync';
  from: 'active' | 'available' | 'unavailable' | 'unknown';
  to: 'active' | 'available' | 'unavailable' | 'unknown' | 'ended';
  cause: 'transport-lost' | 'runtime-unreachable' | 'peer-ended' | 'configuration-removed' | 'unknown';
  intentional?: boolean;
  observedAt: number;
  reason?: string;
}
