export interface AuthFailureAttentionTrackerOptions {
  now?: () => number;
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

/**
 * Bounded detector for repeated failures at the broker's shared-token gate.
 * It stores no address, token, path, header, or request content. One incident
 * per cooldown bounds attacker-triggered attention writes and wakes.
 */
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

  /** Returns a content-free episode key only when a new incident opens. */
  recordFailure(): string | undefined {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at <= this.windowMs);
    this.failures.push(now);
    if (this.failures.length < this.threshold) return undefined;
    if (this.lastIncidentAt !== undefined && now - this.lastIncidentAt < this.cooldownMs) {
      return undefined;
    }
    this.lastIncidentAt = now;
    this.failures = [];
    return `auth-failures:${now}`;
  }
}
