import type {
  AttentionBulkDismissItem,
  AttentionBulkDismissResponse,
  AttentionEventsPage,
  AttentionEventUpsert,
  AgentMessage,
  AgentRuntimeUpdateStatus,
  SessionInfo,
} from '@cosyncing/protocol';
import { ATTENTION_BULK_DISMISS_MAX } from '@cosyncing/protocol';
import { withAttentionNotificationFields } from './attention-notification-type.ts';
import { AttentionPolicy, type AttentionPolicyOptions } from './attention-policy.ts';
import {
  AttentionStore,
  type AttentionEventUpsertResult,
  type AttentionStoreOptions,
} from './attention-store.ts';

export interface AttentionServiceOptions {
  store?: AttentionStoreOptions;
  policy?: AttentionPolicyOptions;
}

type Waiter = { check: () => void; cancel: () => void };

export function normalizeAttentionClientId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('clientId is required');
  const clientId = raw.trim();
  if (!clientId || clientId.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(clientId)) {
    throw new Error('clientId must be a short ASCII token');
  }
  return clientId;
}

export function normalizeAttentionBulkDismissItems(
  raw: unknown,
): AttentionBulkDismissItem[] {
  if (!Array.isArray(raw)) throw new Error('events must be an array');
  if (raw.length > ATTENTION_BULK_DISMISS_MAX) {
    throw new Error(`events must contain at most ${ATTENTION_BULK_DISMISS_MAX} items`);
  }
  const seen = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('events must contain eventId/revision objects');
    }
    const item = value as Record<string, unknown>;
    const eventId = typeof item.eventId === 'string' ? item.eventId.trim() : '';
    const revision = item.revision;
    if (!eventId || eventId.length > 240 || !Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new Error('events must contain valid eventId/revision pairs');
    }
    if (seen.has(eventId)) throw new Error('events must not contain duplicate event ids');
    seen.add(eventId);
    return { eventId, revision: revision as number };
  });
}

/** Broker composition facade: durable feed, live policy, and race-free bounded long polling. */
export class AttentionService {
  readonly store: AttentionStore;
  readonly policy: AttentionPolicy;
  /** Settles once sync-degraded events left by an older broker are resolved. */
  readonly legacySyncDegradedRetired: Promise<number>;
  private readonly waiters = new Set<Waiter>();
  private policyMessageTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: AttentionServiceOptions = {}) {
    const externalChange = options.store?.onChange;
    this.store = new AttentionStore({
      ...options.store,
      onChange: (cursor) => {
        try { externalChange?.(cursor); } catch { /* external observer-only */ }
        this.notifyWaiters();
      },
    });
    this.policy = new AttentionPolicy(this.store, options.policy);
    this.legacySyncDegradedRetired = this.retireLegacySyncDegraded().catch(() => 0);
  }

  async getEvents(input: {
    after?: number;
    limit?: number;
    waitMs?: number;
    clientId: string;
  }): Promise<AttentionEventsPage> {
    const clientId = normalizeAttentionClientId(input.clientId);
    const after = input.after;
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 100)));
    const waitMs = Math.max(0, Math.min(30_000, Math.floor(input.waitMs ?? 0)));
    const read = (): AttentionEventsPage => {
      const page = this.store.getPage({ after, limit, clientId });
      return { ...page, events: page.events.map(withAttentionNotificationFields) };
    };
    const initial = read();
    if (this.hasResult(initial) || waitMs === 0 || this.disposed) return initial;

    // Subscribe before the final recheck. A mutation between the initial read and waiter
    // registration therefore cannot strand a ready page until the timeout.
    return new Promise<AttentionEventsPage>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (page: AttentionEventsPage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(page);
      };
      const waiter: Waiter = {
        check: () => {
          const page = read();
          if (this.hasResult(page) || this.disposed) finish(page);
        },
        cancel: () => finish(read()),
      };
      this.waiters.add(waiter);
      timer = setTimeout(() => finish(read()), waitMs);
      waiter.check();
    });
  }

  upsertEvent(input: AttentionEventUpsert): Promise<AttentionEventUpsertResult> {
    return this.store.upsertEvent(input);
  }

  resolveByDedupeKey(key: string) {
    return this.store.resolveByDedupeKey(key);
  }

  acknowledge(eventId: string, clientId: string) {
    return this.store.acknowledge(eventId, normalizeAttentionClientId(clientId));
  }

  dismiss(eventId: string, clientId: string) {
    return this.store.dismiss(eventId, normalizeAttentionClientId(clientId));
  }

  dismissBatch(
    events: unknown,
    clientId: unknown,
  ): Promise<AttentionBulkDismissResponse> {
    return this.store.dismissBatch(
      normalizeAttentionBulkDismissItems(events),
      normalizeAttentionClientId(clientId),
    );
  }

  handleMessage(info: SessionInfo, message: AgentMessage): Promise<void> {
    return this.enqueuePolicyMessage(() => this.policy.handleMessage(info, message));
  }

  handleSessionEnded(info: SessionInfo): Promise<void> {
    return this.enqueuePolicyMessage(() => this.policy.handleSessionEnded(info));
  }

  handleObservationLost(info: SessionInfo): Promise<void> {
    return this.enqueuePolicyMessage(() => this.policy.handleObservationLost(info));
  }

  handlePendingWithdrawn(info: SessionInfo, requestIds: readonly string[]): Promise<void> {
    return this.enqueuePolicyMessage(() => this.policy.handlePendingWithdrawn(info, requestIds));
  }

  reconcileRuntimeStatus(status: AgentRuntimeUpdateStatus): Promise<void> {
    return this.policy.reconcileRuntimeStatus(status);
  }

  /**
   * Resolves the sync-degraded events an older broker raised.
   *
   * Control-path loss is no longer an attention event: it fired on every
   * ordinary session exit and told the user nothing they could act on. Rows an
   * earlier version left active would otherwise keep their reminders forever.
   * The session's own control state still shows the path's availability.
   */
  private async retireLegacySyncDegraded(): Promise<number> {
    const active = this.store.listActive().filter((event) => event.kind === 'sync-degraded');
    for (const event of active) await this.store.resolveByDedupeKey(event.dedupeKey);
    return active.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of [...this.waiters]) waiter.cancel();
    this.waiters.clear();
  }

  private hasResult(page: AttentionEventsPage): boolean {
    return page.reset || page.hasMore || page.events.length > 0;
  }

  /** Preserve native message order across the policy's durable async writes.
   *
   * Hub deliberately does not block transcript fan-out on attention I/O, so a
   * running summary and its terminal summary can enter this facade without
   * either caller awaiting the first promise. Serializing here keeps the
   * terminal lookup behind the running observation's store mutation while
   * leaving Hub delivery non-blocking.
   */
  private enqueuePolicyMessage(work: () => Promise<void>): Promise<void> {
    const run = this.policyMessageTail.then(work);
    this.policyMessageTail = run.catch(() => undefined);
    return run;
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.check();
  }
}
