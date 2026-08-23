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
        if (!message.readOnly) await this.upsertRequest(session, 'question-required', message.requestId);
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

  /** Drops incomplete live-transition evidence when the owning connection is replaced or disposed.
   *  Existing actionable events stay active: losing observation is not proof the native request ended. */
  async handleObservationLost(session: SessionInfo): Promise<void> {
    const prefixes = [
      `run:${session.tool}:${session.id}:`,
      `goal:${session.tool}:${session.id}:`,
    ];
    const observations = this.store.listObservations().filter((observation) =>
      prefixes.some((prefix) => observation.key.startsWith(prefix)));
    await Promise.all(observations.map((observation) => this.store.deleteObservation(observation.key)));
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
    if (message.status === 'error') {
      await this.store.upsertEvent(this.completedSessionEvent({
        session,
        kind: 'run-failed',
        dedupeKey: `run-failed:${session.tool}:${session.id}:${turnId}`,
        turnId,
        title: 'Agent run failed',
        summary: 'A background agent run ended with an error.',
      }));
      return;
    }
    if (message.status !== 'done') return;
    await this.store.upsertEvent(this.completedSessionEvent({
      session,
      kind: 'run-finished',
      dedupeKey: `run-finished:${session.tool}:${session.id}:${turnId}`,
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
    if (message.status === 'active') {
      if (!this.store.getObservation(observationKey)) {
        await this.store.putObservation({
          key: observationKey,
          kind: 'goal',
          observedAt: this.now(),
          data: { goalKey },
        });
      }
      return;
    }
    const observation = this.store.getObservation(observationKey);
    if (!observation) return;
    await this.store.deleteObservation(observationKey);
    if (message.status !== 'done') return;
    await this.store.upsertEvent(this.completedSessionEvent({
      session,
      kind: 'goal-finished',
      dedupeKey: `goal-finished:${session.tool}:${session.id}:${goalKey}`,
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

/** Generic control-path evidence consumed by attention policy without agent-name branches. */
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

export type SyncDegradationChange =
  | {
      type: 'upsert';
      dedupeKey: string;
      tool: string;
      sessionId: string;
      sessionTitle?: string;
      path: SessionControlTransition['path'];
      cause: SessionControlTransition['cause'];
      at: number;
    }
  | { type: 'resolve'; dedupeKey: string; at: number };

/** Tracks authoritative usable-to-unusable control transitions and their resolution. */
export class SyncDegradationTracker {
  private readonly active = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  restoreActive(dedupeKeys: Iterable<string>): void {
    for (const dedupeKey of dedupeKeys) {
      if (dedupeKey.startsWith('sync-degraded:')) this.active.add(dedupeKey);
    }
  }

  observe(transition: SessionControlTransition): SyncDegradationChange | undefined {
    const dedupeKey = `sync-degraded:${transition.tool}:${transition.sessionId}:${transition.path}`;
    if (transition.intentional) {
      if (!this.active.delete(dedupeKey)) return undefined;
      return { type: 'resolve', dedupeKey, at: this.now() };
    }

    const fromUsable = transition.from === 'active' || transition.from === 'available';
    if (fromUsable && transition.to === 'unavailable') {
      if (this.active.has(dedupeKey)) return undefined;
      this.active.add(dedupeKey);
      return {
        type: 'upsert',
        dedupeKey,
        tool: transition.tool,
        sessionId: transition.sessionId,
        ...(transition.sessionTitle ? { sessionTitle: transition.sessionTitle } : {}),
        path: transition.path,
        cause: transition.cause,
        at: this.now(),
      };
    }

    if (transition.to === 'active' || transition.to === 'available' || transition.to === 'ended') {
      if (!this.active.delete(dedupeKey)) return undefined;
      return { type: 'resolve', dedupeKey, at: this.now() };
    }
    return undefined;
  }
}
