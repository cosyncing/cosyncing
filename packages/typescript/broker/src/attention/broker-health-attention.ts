import type { AttentionEvent } from '@cosyncing/protocol';
import type { AttentionService } from './attention-service.ts';
import type { BrokerHealthSnapshot } from '../runtime/broker-health.ts';

const BROKER_HEALTH_BLOCKER_COUNT_KEY = 'broker-health:blocker-count';
const BROKER_HEALTH_BLOCKER_COUNT_KIND = 'broker-health-blocker-count';

export interface BrokerHealthAttentionReconcilerOptions {
  attentionService: AttentionService;
  machine: string;
  requestDirectWake: () => void;
  now?: () => number;
}

export function brokerHealthObservationKey(episodeKey: string): string {
  return `${BROKER_HEALTH_BLOCKER_COUNT_KEY}:${episodeKey}`;
}

function blockerCountFromObservation(
  observation: { data?: Record<string, unknown> } | undefined,
): number {
  const raw = observation?.data?.blockerCount;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : 0;
}

/**
 * Reconciles durable broker-health attention lifecycle across process restarts.
 *
 * The attention store, rather than process memory, is authoritative for an
 * already-open episode. See docs/architecture/attention.md.
 */
export class BrokerHealthAttentionReconciler {
  private readonly attentionService: AttentionService;
  private readonly machine: string;
  private readonly requestDirectWake: () => void;
  private readonly now: () => number;
  private episodeKey: string | undefined;
  private directWakeSent = false;

  constructor(options: BrokerHealthAttentionReconcilerOptions) {
    this.attentionService = options.attentionService;
    this.machine = options.machine;
    this.requestDirectWake = options.requestDirectWake;
    this.now = options.now ?? Date.now;
  }

  async reconcile(snapshot: BrokerHealthSnapshot): Promise<void> {
    const attentionStoreFailed =
      snapshot.components['attention-store'].status !== 'healthy';
    if (attentionStoreFailed) {
      this.adoptDurableEpisode(snapshot.checkedAt);
      if (!this.directWakeSent) {
        this.directWakeSent = true;
        this.requestDirectWake();
      }
      // Avoid recursively writing through the store that just failed.
      return;
    }

    this.directWakeSent = false;
    if (snapshot.status === 'healthy') {
      await this.resolveAllActiveEpisodes();
      return;
    }

    const blockers = Object.entries(snapshot.components)
      .filter(([, component]) => component.status !== 'healthy')
      .map(([component]) => component)
      .sort();
    const active = this.activeHealthEvents();
    const canonical = active[0];
    if (canonical) {
      this.episodeKey = canonical.dedupeKey;
      for (const duplicate of active.slice(1)) {
        await this.attentionService.resolveByDedupeKey(duplicate.dedupeKey);
        await this.clearBlockerObservation(duplicate.dedupeKey);
      }
    } else {
      this.episodeKey ??=
        `broker-health:${this.machine}:${snapshot.checkedAt}`;
    }

    const episodeKey = this.episodeKey;
    const prior = this.attentionService.store.findByDedupeKey(episodeKey);
    const severity =
      snapshot.status === 'critical' ? 'action-required' : 'maintenance';
    const priorCount = blockerCountFromObservation(
      this.attentionService.store.getObservation(
        brokerHealthObservationKey(episodeKey),
      ),
    );
    const escalated =
      !!prior &&
      ((prior.severity !== 'action-required' &&
        severity === 'action-required') ||
        blockers.length > priorCount);

    await this.recordBlockerCount(episodeKey, blockers.length);
    await this.attentionService.upsertEvent({
      dedupeKey: episodeKey,
      kind: 'broker-health',
      state: 'active',
      severity,
      title:
        snapshot.status === 'critical'
          ? 'Broker health needs attention'
          : 'Broker health degraded',
      summary: `Broker persistence is ${snapshot.status === 'critical' ? 'critical' : 'degraded'} (${blockers.length} component${
        blockers.length === 1 ? '' : 's'
      }).`,
      action: { kind: 'open-broker-health' },
      ...(prior
        ? escalated
          ? {
              presentationRevision: prior.presentationRevision + 1,
              presentationStage: `health-${snapshot.checkedAt}`,
            }
          : {}
        : { presentationRevision: 1, presentationStage: 'immediate' }),
    });
  }

  private activeHealthEvents(): AttentionEvent[] {
    return this.attentionService.store
      .listActive()
      .filter((event) => event.kind === 'broker-health')
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.cursor - right.cursor ||
          left.id.localeCompare(right.id),
      );
  }

  private adoptDurableEpisode(checkedAt: number): void {
    const durable = this.activeHealthEvents()[0];
    if (durable) {
      this.episodeKey = durable.dedupeKey;
      return;
    }
    this.episodeKey ??= `broker-health:${this.machine}:${checkedAt}`;
  }

  private async resolveAllActiveEpisodes(): Promise<void> {
    const active = this.activeHealthEvents();
    const keys = new Set(active.map((event) => event.dedupeKey));
    if (this.episodeKey) keys.add(this.episodeKey);

    for (const event of active) {
      await this.attentionService.resolveByDedupeKey(event.dedupeKey);
    }

    if (active.length === 0 && this.episodeKey) {
      // Persistence was unavailable for the whole incident. Record resolved
      // history after recovery without creating a recovery notification.
      await this.attentionService.upsertEvent({
        dedupeKey: this.episodeKey,
        kind: 'broker-health',
        state: 'resolved',
        severity: 'maintenance',
        title: 'Broker health recovered',
        summary: 'A broker persistence problem occurred and has recovered.',
        action: { kind: 'open-broker-health' },
        presentationRevision: 0,
      });
    }

    for (const key of keys) {
      await this.clearBlockerObservation(key);
    }
    this.episodeKey = undefined;
  }

  private async recordBlockerCount(
    episodeKey: string,
    count: number,
  ): Promise<void> {
    const key = brokerHealthObservationKey(episodeKey);
    const existing = this.attentionService.store.getObservation(key);
    if (blockerCountFromObservation(existing) === count) return;
    await this.attentionService.store.putObservation({
      key,
      kind: BROKER_HEALTH_BLOCKER_COUNT_KIND,
      observedAt: existing?.observedAt ?? this.now(),
      data: { blockerCount: count },
    });
  }

  private async clearBlockerObservation(episodeKey: string): Promise<void> {
    await this.attentionService.store.deleteObservation(
      brokerHealthObservationKey(episodeKey),
    );
  }
}
