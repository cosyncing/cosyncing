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
  /** Diagnostic-only; never copy raw native detail into lock-screen text. */
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

/**
 * Tracks only authoritative usable→unusable control transitions. Unknown/startup absence is not an
 * outage, and intentional lifecycle changes are never user-facing degradation events.
 */
export class SyncDegradationTracker {
  private readonly active = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Restores durable active identities after a broker restart. */
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
