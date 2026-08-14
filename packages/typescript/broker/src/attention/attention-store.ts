/**
 * Durable broker-owned attention feed.
 *
 * Governing design: docs/architecture/attention.md
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AttentionBulkDismissItem,
  AttentionBulkDismissResponse,
  AttentionEvent,
  AttentionEventsPage,
  AttentionEventUpsert,
  AttentionEventView,
} from '@cosyncing/protocol';
import { ATTENTION_BULK_DISMISS_MAX } from '@cosyncing/protocol';
import { setupStateHome } from '../installation/setup-state.ts';

export const ATTENTION_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ATTENTION_RESOLVED_MAX = 2_000;

export interface AttentionObservation {
  key: string;
  kind: string;
  observedAt: number;
  updatedAt?: number;
  data: Record<string, unknown>;
}

export interface AttentionClientState {
  clientId: string;
  eventId: string;
  cursor: number;
  readAt?: number;
  dismissedAt?: number;
  /** Exact event revision targeted by a snapshot-isolated bulk dismissal. */
  dismissedRevision?: number;
}

export interface AttentionDelivery {
  key: string;
  deviceId: string;
  eventId: string;
  stage: string;
  state: 'reserved' | 'delivered' | 'superseded';
  attempts: number;
  reservedAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  deliveredAt?: number;
  lastFailedAt?: number;
}

interface AttentionStoreFile {
  version: 1;
  nextCursor: number;
  prunedThroughCursor: number;
  events: AttentionEvent[];
  observations: AttentionObservation[];
  clientStates: AttentionClientState[];
  deliveries: AttentionDelivery[];
}

export interface AttentionStoreOptions {
  /** Full snapshot filename. Defaults to `${setupStateHome()}/attention-events.json`. */
  path?: string;
  home?: string;
  now?: () => number;
  idFactory?: () => string;
  resolvedRetentionMs?: number;
  maxResolved?: number;
  onWarning?: (message: string) => void;
  /** Sanitized real-write result for broker health. Callback errors never change persistence. */
  onPersistenceResult?: (ok: boolean) => void;
  /** Sanitized startup integrity result. Corrupt bytes are quarantined before `startup-corrupt`. */
  onStartupResult?: (ok: boolean, detailCode?: 'startup-corrupt') => void;
  /** Called after a durable mutation becomes the visible in-memory snapshot. */
  onChange?: (headCursor: number) => void;
}

export interface AttentionEventUpsertResult {
  event: AttentionEvent;
  created: boolean;
  changed: boolean;
}

export type RuntimeUpdateOccurrenceTransition =
  | {
    agent: string;
    state: 'current';
  }
  | {
    agent: string;
    state: 'pending';
    /** Stable semantic fingerprint; never includes boot/process/poll identity. */
    fingerprint: string;
    dedupeKeyBase: string;
    /** True only when a pre-F4d dedupe key fully proves semantic equality. */
    legacyDedupeProvesFingerprint: boolean;
    event: Omit<AttentionEventUpsert, 'dedupeKey' | 'id' | 'createdAt'>;
  };

export interface AttentionDeliveryReservation {
  reserved: boolean;
  delivery: AttentionDelivery;
}

function emptyFile(): AttentionStoreFile {
  return {
    version: 1,
    nextCursor: 1,
    prunedThroughCursor: 0,
    events: [],
    observations: [],
    clientStates: [],
    deliveries: [],
  };
}

function cloneState(state: AttentionStoreFile): AttentionStoreFile {
  return structuredClone(state);
}

function stableSerialize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableSerialize);
  const sorted = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of sorted) {
    normalized[key] = stableSerialize(child);
  }
  return normalized;
}

function canonicalEventJson(value: unknown): string {
  return JSON.stringify(stableSerialize(value));
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function normalizeEvent(raw: unknown): AttentionEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = cleanText(value.id, 240);
  const kind = cleanText(value.kind, 120);
  const dedupeKey = cleanText(value.dedupeKey, 600);
  const title = cleanText(value.title, 160);
  const cursor = finiteInteger(value.cursor, -1);
  const revision = finiteInteger(value.revision, -1);
  const presentationRevision = finiteInteger(value.presentationRevision, -1);
  const createdAt = finiteInteger(value.createdAt, -1);
  const updatedAt = finiteInteger(value.updatedAt, -1);
  const state = value.state === 'active' || value.state === 'resolved' ? value.state : undefined;
  const severity = value.severity === 'action-required' || value.severity === 'informational' || value.severity === 'maintenance'
    ? value.severity
    : undefined;
  const action = value.action && typeof value.action === 'object' && !Array.isArray(value.action)
    && cleanText((value.action as Record<string, unknown>).kind, 80)
    ? value.action as AttentionEvent['action']
    : undefined;
  if (!id || !kind || !dedupeKey || !title || cursor < 0 || revision < 0 || presentationRevision < 0
      || createdAt < 0 || updatedAt < 0 || !state || !severity || !action) return undefined;
  const optionalText = (
    key: 'presentationStage' | 'agent' | 'sessionId' | 'sessionTitle'
      | 'requestId' | 'turnId' | 'goalKey' | 'summary',
    max: number,
  ) => {
    const result = cleanText(value[key], max);
    return result ? { [key]: result } : {};
  };
  const resolvedAt = finiteInteger(value.resolvedAt, -1);
  const knownKeys = new Set([
    'id', 'cursor', 'revision', 'presentationRevision', 'presentationStage',
    'kind', 'state', 'severity', 'dedupeKey', 'createdAt', 'updatedAt',
    'resolvedAt', 'agent', 'sessionId', 'sessionTitle', 'requestId', 'turnId',
    'goalKey', 'title', 'summary', 'action',
  ]);
  const unknownFields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !knownKeys.has(key))
      .map(([key, child]) => [key, structuredClone(child)]),
  );
  return {
    ...unknownFields,
    id,
    cursor,
    revision,
    presentationRevision,
    ...optionalText('presentationStage', 120),
    kind,
    state,
    severity,
    dedupeKey,
    createdAt,
    updatedAt,
    ...(resolvedAt >= 0 ? { resolvedAt } : {}),
    ...optionalText('agent', 120),
    ...optionalText('sessionId', 240),
    ...optionalText('sessionTitle', 200),
    ...optionalText('requestId', 240),
    ...optionalText('turnId', 240),
    ...optionalText('goalKey', 240),
    title,
    ...optionalText('summary', 320),
    action,
  } as AttentionEvent;
}

function normalizeObservation(raw: unknown): AttentionObservation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const key = cleanText(value.key, 600);
  const kind = cleanText(value.kind, 120);
  const observedAt = finiteInteger(value.observedAt, -1);
  const updatedAt = finiteInteger(value.updatedAt, -1);
  if (!key || !kind || observedAt < 0 || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return undefined;
  return { key, kind, observedAt, ...(updatedAt >= 0 ? { updatedAt } : {}), data: value.data as Record<string, unknown> };
}

function normalizeClientState(raw: unknown): AttentionClientState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const clientId = cleanText(value.clientId, 120);
  const eventId = cleanText(value.eventId, 240);
  const cursor = finiteInteger(value.cursor, -1);
  const readAt = finiteInteger(value.readAt, -1);
  const dismissedAt = finiteInteger(value.dismissedAt, -1);
  const dismissedRevision = finiteInteger(value.dismissedRevision, -1);
  if (!clientId || !eventId || cursor < 0) return undefined;
  return {
    clientId,
    eventId,
    cursor,
    ...(readAt >= 0 ? { readAt } : {}),
    ...(dismissedAt >= 0 ? { dismissedAt } : {}),
    ...(dismissedRevision >= 0 ? { dismissedRevision } : {}),
  };
}

function normalizeDelivery(raw: unknown): AttentionDelivery | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const key = cleanText(value.key, 900);
  const deviceId = cleanText(value.deviceId, 120);
  const eventId = cleanText(value.eventId, 240);
  const stage = cleanText(value.stage, 160);
  const state = value.state === 'reserved' || value.state === 'delivered' || value.state === 'superseded' ? value.state : undefined;
  const attempts = finiteInteger(value.attempts, 0);
  const reservedAt = finiteInteger(value.reservedAt, -1);
  const updatedAt = finiteInteger(value.updatedAt, -1);
  const nextAttemptAt = finiteInteger(value.nextAttemptAt, -1);
  const deliveredAt = finiteInteger(value.deliveredAt, -1);
  const lastFailedAt = finiteInteger(value.lastFailedAt, -1);
  if (!key || !deviceId || !eventId || !stage || !state || reservedAt < 0 || updatedAt < 0) return undefined;
  return {
    key,
    deviceId,
    eventId,
    stage,
    state,
    attempts,
    reservedAt,
    updatedAt,
    ...(nextAttemptAt >= 0 ? { nextAttemptAt } : {}),
    ...(deliveredAt >= 0 ? { deliveredAt } : {}),
    ...(lastFailedAt >= 0 ? { lastFailedAt } : {}),
  };
}

function clientStateKey(clientId: string, eventId: string): string {
  return `${clientId}\0${eventId}`;
}

function deliveryKey(deviceId: string, eventId: string, stage: string): string {
  return `${deviceId}\0${eventId}\0${stage}`;
}

function supersedeReservedDeliveriesInState(
  state: AttentionStoreFile,
  eventId: string,
  now: number,
  exceptStage?: string,
): number {
  let count = 0;
  for (const delivery of state.deliveries) {
    if (
      delivery.eventId !== eventId
      || delivery.state !== 'reserved'
      || delivery.stage === exceptStage
    ) {
      continue;
    }
    delivery.state = 'superseded';
    delivery.updatedAt = now;
    delete delivery.nextAttemptAt;
    count += 1;
  }
  return count;
}

function runtimePresentationStageIndex(stage?: string): number {
  if (stage === 'immediate') return 1;
  if (stage === '2h') return 2;
  if (stage === '12h') return 3;
  const hourMatch = /^([1-9]\d*)h$/.exec(stage ?? '');
  if (!hourMatch) return 0;
  const hours = Number(hourMatch[1]);
  if (!Number.isSafeInteger(hours) || hours < 24) return 0;
  return 4 + Math.floor((hours - 24) / 24);
}

function eventSemanticJson(event: AttentionEvent): string {
  const { cursor: _cursor, revision: _revision, updatedAt: _updatedAt, ...semantic } = event;
  return canonicalEventJson(semantic);
}

export class AttentionStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly resolvedRetentionMs: number;
  private readonly maxResolved: number;
  private readonly onWarning: (message: string) => void;
  private state: AttentionStoreFile;
  private mutationTail: Promise<void> = Promise.resolve();
  private tempSequence = 0;

  constructor(private readonly options: AttentionStoreOptions = {}) {
    this.path = options.path ?? join(options.home ?? setupStateHome(), 'attention-events.json');
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.resolvedRetentionMs = Math.max(0, options.resolvedRetentionMs ?? ATTENTION_RESOLVED_RETENTION_MS);
    this.maxResolved = Math.max(0, Math.floor(options.maxResolved ?? ATTENTION_RESOLVED_MAX));
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));
    this.state = this.load();
  }

  get snapshotPath(): string {
    return this.path;
  }

  get headCursor(): number {
    return this.state.nextCursor - 1;
  }

  getEvent(id: string): AttentionEvent | undefined {
    const found = this.state.events.find((event) => event.id === id);
    return found ? structuredClone(found) : undefined;
  }

  findByDedupeKey(dedupeKey: string): AttentionEvent | undefined {
    const found = this.state.events.find((event) => event.dedupeKey === dedupeKey);
    return found ? structuredClone(found) : undefined;
  }

  getClientState(clientId: string, eventId: string): AttentionClientState | undefined {
    const key = clientStateKey(clientId, eventId);
    const found = this.state.clientStates.find((item) => clientStateKey(item.clientId, item.eventId) === key);
    return found ? structuredClone(found) : undefined;
  }

  listActive(): AttentionEvent[] {
    return this.state.events.filter((event) => event.state === 'active').map((event) => structuredClone(event));
  }

  /** Retained feed records for scheduler/reconciliation. Callers receive clones, never store state. */
  listEvents(): AttentionEvent[] {
    return this.state.events.map((event) => structuredClone(event));
  }

  getPage(options: { after?: number; limit?: number; clientId?: string }): AttentionEventsPage {
    const requestedAfter = options.after;
    const head = this.headCursor;
    const reset = requestedAfter !== undefined
      && (!Number.isSafeInteger(requestedAfter) || requestedAfter < this.state.prunedThroughCursor || requestedAfter > head);
    const after = reset || requestedAfter === undefined ? undefined : requestedAfter;
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
    const states = new Map(
      this.state.clientStates
        .filter((item) => item.clientId === options.clientId)
        .map((item) => [item.eventId, item]),
    );
    const effectiveCursor = (event: AttentionEvent): number => Math.max(event.cursor, states.get(event.id)?.cursor ?? 0);
    const candidates = this.state.events
      .filter((event) => after === undefined || effectiveCursor(event) > after)
      .sort((a, b) => effectiveCursor(a) - effectiveCursor(b) || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, limit);
    const events: AttentionEventView[] = selected.map((event) => {
      const client = states.get(event.id);
      const dismissalApplies = client?.dismissedAt !== undefined
        && (client.dismissedRevision === undefined || client.dismissedRevision === event.revision);
      return {
        ...structuredClone(event),
        ...(client?.readAt !== undefined ? { readAt: client.readAt } : {}),
        ...(dismissalApplies ? { dismissedAt: client.dismissedAt } : {}),
      };
    });
    const hasMore = candidates.length > selected.length;
    const cursor = selected.length > 0 ? effectiveCursor(selected[selected.length - 1]!) : head;
    return {
      ok: true,
      events,
      cursor,
      baselineThroughCursor: head,
      reset,
      hasMore,
    };
  }

  upsertEvent(input: AttentionEventUpsert): Promise<AttentionEventUpsertResult> {
    return this.mutate<AttentionEventUpsertResult>((next) => {
      const now = this.now();
      const existing = next.events.find((event) => event.dedupeKey === input.dedupeKey);
      if (!existing) {
        const cursor = this.allocateCursor(next);
        const createdAt = input.createdAt ?? now;
        const candidate: AttentionEvent = {
          ...input,
          id: input.id ?? this.idFactory(),
          cursor,
          revision: 1,
          presentationRevision: input.presentationRevision ?? 1,
          createdAt,
          updatedAt: now,
          ...(input.state === 'resolved' ? { resolvedAt: input.resolvedAt ?? now } : {}),
        };
        const normalized = normalizeEvent(candidate);
        if (!normalized) throw new Error('invalid attention event');
        next.events.push(normalized);
        return { value: { event: structuredClone(normalized), created: true, changed: true }, changed: true };
      }

      const candidate: AttentionEvent = {
        ...existing,
        ...input,
        id: existing.id,
        cursor: existing.cursor,
        revision: existing.revision,
        // Runtime occurrence initialization is create-only. Once published,
        // only advancePresentationAndReserve owns its stage and revision.
        presentationRevision: existing.kind === 'runtime-update-ready'
          ? existing.presentationRevision
          : input.presentationRevision === undefined
            ? existing.presentationRevision
            : Math.max(existing.presentationRevision, input.presentationRevision),
        ...(existing.kind === 'runtime-update-ready'
          ? { presentationStage: existing.presentationStage }
          : {}),
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        ...(input.state === 'resolved'
          ? { resolvedAt: input.resolvedAt ?? existing.resolvedAt ?? now }
          : { resolvedAt: undefined }),
      };
      if (candidate.resolvedAt === undefined) delete candidate.resolvedAt;
      const normalized = normalizeEvent(candidate);
      if (!normalized) throw new Error('invalid attention event');
      if (eventSemanticJson(normalized) === eventSemanticJson(existing)) {
        return { value: { event: structuredClone(existing), created: false, changed: false }, changed: false };
      }
      normalized.cursor = this.allocateCursor(next);
      normalized.revision = existing.revision + 1;
      normalized.updatedAt = now;
      const resolved = existing.state === 'active' && normalized.state === 'resolved';
      Object.assign(existing, normalized);
      if (resolved) supersedeReservedDeliveriesInState(next, existing.id, now);
      return { value: { event: structuredClone(existing), created: false, changed: true }, changed: true };
    });
  }

  resolveByDedupeKey(dedupeKey: string): Promise<AttentionEvent | undefined> {
    return this.mutate((next) => {
      const event = next.events.find((item) => item.dedupeKey === dedupeKey);
      if (!event) return { value: undefined, changed: false };
      const now = this.now();
      if (event.state === 'resolved') {
        const retired = supersedeReservedDeliveriesInState(next, event.id, now);
        return { value: structuredClone(event), changed: retired > 0 };
      }
      event.state = 'resolved';
      event.resolvedAt = now;
      event.updatedAt = now;
      event.revision += 1;
      event.cursor = this.allocateCursor(next);
      supersedeReservedDeliveriesInState(next, event.id, now);
      return { value: structuredClone(event), changed: true };
    });
  }

  /**
   * Atomically owns the bounded persisted lifecycle for one runtime-update
   * occurrence. The observation is one row per agent; resolved event history
   * remains subject to the store's existing age/count caps.
   */
  reconcileRuntimeUpdateOccurrence(
    input: RuntimeUpdateOccurrenceTransition,
  ): Promise<AttentionEventUpsertResult | undefined> {
    return this.mutate<AttentionEventUpsertResult | undefined>((next) => {
      const now = this.now();
      const agent = cleanText(input.agent, 120);
      if (!agent) throw new Error('invalid runtime update agent');
      const observationKey = `runtime-update-occurrence:${agent}`;
      const observationIndex = next.observations.findIndex((item) => item.key === observationKey);
      const observation = observationIndex >= 0 ? next.observations[observationIndex] : undefined;
      const active = next.events.filter((event) =>
        event.kind === 'runtime-update-ready'
        && event.agent === agent
        && event.state === 'active');
      let changed = false;

      const resolve = (event: AttentionEvent): void => {
        if (event.state === 'resolved') return;
        event.state = 'resolved';
        event.resolvedAt = now;
        event.updatedAt = now;
        event.revision += 1;
        event.cursor = this.allocateCursor(next);
        supersedeReservedDeliveriesInState(next, event.id, now);
        changed = true;
      };
      const putLifecycle = (data: Record<string, unknown>): void => {
        const normalized = normalizeObservation({
          key: observationKey,
          kind: 'runtime-update-occurrence',
          observedAt: observation?.observedAt ?? now,
          updatedAt: now,
          data,
        });
        if (!normalized) throw new Error('invalid runtime update occurrence');
        if (observation) {
          const { updatedAt: _priorUpdatedAt, ...priorSemantic } = observation;
          const { updatedAt: _nextUpdatedAt, ...nextSemantic } = normalized;
          if (canonicalEventJson(priorSemantic) === canonicalEventJson(nextSemantic)) return;
          next.observations[observationIndex] = normalized;
        } else {
          next.observations.push(normalized);
        }
        changed = true;
      };

      if (input.state === 'current') {
        for (const event of active) resolve(event);
        putLifecycle({ state: 'current' });
        return { value: undefined, changed };
      }

      const fingerprint = cleanText(input.fingerprint, 160);
      const dedupeKeyBase = cleanText(input.dedupeKeyBase, 320);
      if (!fingerprint || !dedupeKeyBase) throw new Error('invalid runtime update fingerprint');
      const observedFingerprint = cleanText(observation?.data.fingerprint, 160);
      const observedEventId = cleanText(observation?.data.eventId, 240);
      const observedEvent = observedEventId
        ? next.events.find((event) => event.id === observedEventId)
        : undefined;
      if (
        observation?.data.state === 'active'
        && observedFingerprint === fingerprint
        && observedEvent?.state === 'active'
      ) {
        for (const event of active) {
          if (event.id !== observedEvent.id) resolve(event);
        }
        return {
          value: {
            event: structuredClone(observedEvent),
            created: false,
            changed,
          },
          changed,
        };
      }

      // Adopt the pre-F4d active event when its legacy key proves it is this
      // fingerprint. This avoids one migration-time immediate presentation.
      const adoptable = active
        .filter((event) =>
          event.dedupeKey === dedupeKeyBase
          || event.dedupeKey.startsWith(`${dedupeKeyBase}:boot:`)
          || event.dedupeKey.startsWith(`${dedupeKeyBase}:occurrence:`))
        .sort((a, b) => b.createdAt - a.createdAt || b.cursor - a.cursor)[0];
      if (!observation && input.legacyDedupeProvesFingerprint && adoptable) {
        for (const event of active) {
          if (event.id !== adoptable.id) resolve(event);
        }
        putLifecycle({ state: 'active', fingerprint, eventId: adoptable.id });
        return {
          value: {
            event: structuredClone(adoptable),
            created: false,
            changed,
          },
          changed,
        };
      }

      for (const event of active) resolve(event);
      const eventId = this.idFactory();
      const dedupeKey = `${dedupeKeyBase}:occurrence:${eventId}`;
      const cursor = this.allocateCursor(next);
      const candidate: AttentionEvent = {
        ...input.event,
        dedupeKey,
        id: eventId,
        cursor,
        revision: 1,
        presentationRevision: input.event.presentationRevision ?? 1,
        createdAt: now,
        updatedAt: now,
        ...(input.event.state === 'resolved' ? { resolvedAt: now } : {}),
      };
      const normalized = normalizeEvent(candidate);
      if (!normalized) throw new Error('invalid runtime update attention event');
      if (
        next.events.some((event) =>
          event.id === normalized.id || event.dedupeKey === normalized.dedupeKey)
      ) {
        throw new Error('duplicate runtime update occurrence identity');
      }
      next.events.push(normalized);
      changed = true;
      putLifecycle({ state: 'active', fingerprint, eventId: normalized.id });
      return {
        value: {
          event: structuredClone(normalized),
          created: true,
          changed: true,
        },
        changed,
      };
    });
  }

  advancePresentation(dedupeKey: string, stage: string): Promise<AttentionEvent | undefined> {
    const event = this.findByDedupeKey(dedupeKey);
    if (!event) return Promise.resolve(undefined);
    return this.advancePresentationAndReserve(event.id, stage, []).then((result) => result?.event);
  }

  /** Atomically publishes one presentation occurrence and reserves its per-device delivery ledger.
   *  Repeating the same stage is idempotent, while a newly registered device can still join it. */
  advancePresentationAndReserve(
    eventId: string,
    stage: string,
    deviceIds: string[],
  ): Promise<{ event: AttentionEvent; reservations: AttentionDeliveryReservation[] } | undefined> {
    return this.mutate((next) => {
      const event = next.events.find((item) => item.id === eventId);
      if (!event) return { value: undefined, changed: false };
      const now = this.now();
      let changed = false;
      if (event.kind === 'runtime-update-ready' && event.state !== 'active') {
        return { value: undefined, changed: false };
      }
      if (
        event.kind === 'runtime-update-ready'
        && runtimePresentationStageIndex(stage)
          < runtimePresentationStageIndex(event.presentationStage)
      ) {
        return { value: undefined, changed: false };
      }
      if (event.presentationStage !== stage) {
        event.presentationRevision += 1;
        event.presentationStage = cleanText(stage, 120);
        event.updatedAt = now;
        event.revision += 1;
        event.cursor = this.allocateCursor(next);
        changed = true;
      }
      const reservations: AttentionDeliveryReservation[] = [];
      for (const deviceId of new Set(deviceIds)) {
        const key = deliveryKey(deviceId, eventId, stage);
        const existing = next.deliveries.find((item) => item.key === key);
        if (existing) {
          reservations.push({ reserved: false, delivery: structuredClone(existing) });
          continue;
        }
        const delivery = normalizeDelivery({
          key,
          deviceId,
          eventId,
          stage,
          state: 'reserved',
          attempts: 0,
          reservedAt: now,
          updatedAt: now,
        });
        if (!delivery) throw new Error('invalid attention delivery reservation');
        next.deliveries.push(delivery);
        reservations.push({ reserved: true, delivery: structuredClone(delivery) });
        changed = true;
      }
      return { value: { event: structuredClone(event), reservations }, changed };
    });
  }

  acknowledge(eventId: string, clientId: string): Promise<AttentionClientState | undefined> {
    return this.updateClientState(eventId, clientId, 'readAt');
  }

  dismiss(eventId: string, clientId: string): Promise<AttentionClientState | undefined> {
    return this.updateClientState(eventId, clientId, 'dismissedAt');
  }

  /** Dismisses exact event revisions in one serialized durable store mutation. */
  dismissBatch(
    events: AttentionBulkDismissItem[],
    clientId: string,
  ): Promise<AttentionBulkDismissResponse> {
    if (events.length > ATTENTION_BULK_DISMISS_MAX) {
      throw new Error(`events must contain at most ${ATTENTION_BULK_DISMISS_MAX} items`);
    }
    const seen = new Set<string>();
    for (const item of events) {
      if (!cleanText(item.eventId, 240) || !Number.isSafeInteger(item.revision) || item.revision < 1) {
        throw new Error('events must contain valid eventId/revision pairs');
      }
      if (seen.has(item.eventId)) throw new Error('events must not contain duplicate event ids');
      seen.add(item.eventId);
    }

    return this.mutate((next) => {
      const accepted: AttentionBulkDismissResponse['accepted'] = [];
      const stale: AttentionBulkDismissResponse['stale'] = [];
      const notFound: AttentionBulkDismissResponse['notFound'] = [];
      const now = this.now();
      let changed = false;

      for (const item of events) {
        const event = next.events.find((candidate) => candidate.id === item.eventId);
        if (!event) {
          notFound.push({ ...item });
          continue;
        }
        if (event.revision !== item.revision) {
          stale.push({ ...item, currentRevision: event.revision });
          continue;
        }

        const key = clientStateKey(clientId, event.id);
        let client = next.clientStates.find(
          (candidate) => clientStateKey(candidate.clientId, candidate.eventId) === key,
        );
        if (!client) {
          client = { clientId, eventId: event.id, cursor: 0 };
          next.clientStates.push(client);
        }
        if (client.dismissedAt === undefined || client.dismissedRevision !== event.revision) {
          client.dismissedAt = now;
          client.dismissedRevision = event.revision;
          client.cursor = this.allocateCursor(next);
          changed = true;
        }
        accepted.push({
          eventId: event.id,
          revision: event.revision,
          dismissedAt: client.dismissedAt,
        });
      }

      return {
        value: { ok: true, accepted, stale, notFound },
        changed,
      };
    });
  }

  getObservation(key: string): AttentionObservation | undefined {
    const found = this.state.observations.find((item) => item.key === key);
    return found ? structuredClone(found) : undefined;
  }

  listObservations(): AttentionObservation[] {
    return this.state.observations.map((item) => structuredClone(item));
  }

  putObservation(observation: AttentionObservation): Promise<AttentionObservation> {
    return this.mutate((next) => {
      const normalized = normalizeObservation({ ...observation, updatedAt: this.now() });
      if (!normalized) throw new Error('invalid attention observation');
      const index = next.observations.findIndex((item) => item.key === normalized.key);
      const existing = index >= 0 ? next.observations[index] : undefined;
      if (existing) {
        const { updatedAt: _existingUpdatedAt, ...existingSemantic } = existing;
        const { updatedAt: _normalizedUpdatedAt, ...normalizedSemantic } = normalized;
        if (canonicalEventJson(existingSemantic) === canonicalEventJson(normalizedSemantic)) {
          return { value: structuredClone(existing), changed: false };
        }
      }
      if (index >= 0) next.observations[index] = normalized;
      else next.observations.push(normalized);
      return { value: structuredClone(normalized), changed: true };
    });
  }

  deleteObservation(key: string): Promise<boolean> {
    return this.mutate((next) => {
      const before = next.observations.length;
      next.observations = next.observations.filter((item) => item.key !== key);
      const deleted = next.observations.length !== before;
      return { value: deleted, changed: deleted };
    });
  }

  getDelivery(key: string): AttentionDelivery | undefined {
    const found = this.state.deliveries.find((item) => item.key === key);
    return found ? structuredClone(found) : undefined;
  }

  listDeliveries(): AttentionDelivery[] {
    return this.state.deliveries.map((item) => structuredClone(item));
  }

  reserveDelivery(input: { deviceId: string; eventId: string; stage: string }): Promise<AttentionDeliveryReservation> {
    return this.mutate<AttentionDeliveryReservation>((next) => {
      const key = deliveryKey(input.deviceId, input.eventId, input.stage);
      const existing = next.deliveries.find((item) => item.key === key);
      if (existing) return { value: { reserved: false, delivery: structuredClone(existing) }, changed: false };
      if (!next.events.some((event) => event.id === input.eventId)) throw new Error('attention event not found');
      const now = this.now();
      const normalized = normalizeDelivery({
        key,
        deviceId: input.deviceId,
        eventId: input.eventId,
        stage: input.stage,
        state: 'reserved',
        attempts: 0,
        reservedAt: now,
        updatedAt: now,
      });
      if (!normalized) throw new Error('invalid attention delivery reservation');
      next.deliveries.push(normalized);
      return { value: { reserved: true, delivery: structuredClone(normalized) }, changed: true };
    });
  }

  completeDelivery(key: string): Promise<AttentionDelivery | undefined> {
    return this.mutate((next) => {
      const delivery = next.deliveries.find((item) => item.key === key);
      if (!delivery || delivery.state === 'delivered') {
        return { value: delivery ? structuredClone(delivery) : undefined, changed: false };
      }
      delivery.state = 'delivered';
      delivery.updatedAt = this.now();
      delivery.deliveredAt = delivery.updatedAt;
      delete delivery.nextAttemptAt;
      return { value: structuredClone(delivery), changed: true };
    });
  }

  recordDeliveryFailure(key: string, nextAttemptAt?: number): Promise<AttentionDelivery | undefined> {
    return this.mutate((next) => {
      const delivery = next.deliveries.find((item) => item.key === key);
      if (!delivery || delivery.state !== 'reserved') {
        return { value: delivery ? structuredClone(delivery) : undefined, changed: false };
      }
      const now = this.now();
      delivery.attempts += 1;
      delivery.lastFailedAt = now;
      delivery.updatedAt = now;
      if (nextAttemptAt !== undefined) delivery.nextAttemptAt = nextAttemptAt;
      else delete delivery.nextAttemptAt;
      return { value: structuredClone(delivery), changed: true };
    });
  }

  supersedeDeliveries(eventId: string, exceptStage?: string): Promise<number> {
    return this.mutate((next) => {
      const now = this.now();
      const count = supersedeReservedDeliveriesInState(next, eventId, now, exceptStage);
      return { value: count, changed: count > 0 };
    });
  }

  releaseDelivery(key: string): Promise<boolean> {
    return this.mutate((next) => {
      const before = next.deliveries.length;
      next.deliveries = next.deliveries.filter((item) => item.key !== key);
      const released = next.deliveries.length !== before;
      return { value: released, changed: released };
    });
  }

  prune(): Promise<number> {
    return this.mutate((next) => {
      const removed = this.pruneState(next);
      return { value: removed, changed: removed > 0 };
    }, false);
  }

  private updateClientState(
    eventId: string,
    clientId: string,
    field: 'readAt' | 'dismissedAt',
  ): Promise<AttentionClientState | undefined> {
    return this.mutate((next) => {
      if (!next.events.some((event) => event.id === eventId)) return { value: undefined, changed: false };
      const key = clientStateKey(clientId, eventId);
      let client = next.clientStates.find((item) => clientStateKey(item.clientId, item.eventId) === key);
      const now = this.now();
      if (client?.[field] !== undefined) {
        if (field !== 'dismissedAt' || client.dismissedRevision === undefined) {
          return { value: structuredClone(client), changed: false };
        }
        // The legacy single-event route is intentionally event-wide. If this
        // client previously used an exact-revision bulk dismissal, clicking
        // Dismiss converts it back to the pre-F4b semantics so this and later
        // revisions remain hidden.
        client.dismissedAt = now;
        delete client.dismissedRevision;
        client.cursor = this.allocateCursor(next);
        return { value: structuredClone(client), changed: true };
      }
      if (!client) {
        client = { clientId, eventId, cursor: 0 };
        next.clientStates.push(client);
      }
      client[field] = now;
      client.cursor = this.allocateCursor(next);
      return { value: structuredClone(client), changed: true };
    });
  }

  private allocateCursor(state: AttentionStoreFile): number {
    const cursor = state.nextCursor;
    state.nextCursor += 1;
    return cursor;
  }

  private mutate<T>(
    operation: (next: AttentionStoreFile) => { value: T; changed: boolean },
    pruneAfter = true,
  ): Promise<T> {
    const run = this.mutationTail.then(() => {
      const next = cloneState(this.state);
      const result = operation(next);
      const pruned = pruneAfter ? this.pruneState(next) : 0;
      if (result.changed || pruned > 0) {
        this.save(next);
        this.state = next;
        try { this.options.onChange?.(this.headCursor); } catch { /* observer-only */ }
      }
      return result.value;
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private pruneState(state: AttentionStoreFile): number {
    const cutoff = this.now() - this.resolvedRetentionMs;
    const resolved = state.events
      .filter((event) => event.state === 'resolved')
      .sort((a, b) => (b.resolvedAt ?? b.updatedAt) - (a.resolvedAt ?? a.updatedAt) || b.cursor - a.cursor);
    const keep = new Set(
      resolved
        .filter((event) => (event.resolvedAt ?? event.updatedAt) >= cutoff)
        .slice(0, this.maxResolved)
        .map((event) => event.id),
    );
    const removed = state.events.filter((event) => event.state === 'resolved' && !keep.has(event.id));
    if (removed.length === 0) return 0;
    const removedIds = new Set(removed.map((event) => event.id));
    state.prunedThroughCursor = Math.max(state.prunedThroughCursor, ...removed.map((event) => event.cursor));
    state.events = state.events.filter((event) => !removedIds.has(event.id));
    state.clientStates = state.clientStates.filter((item) => !removedIds.has(item.eventId));
    state.deliveries = state.deliveries.filter((item) => !removedIds.has(item.eventId));
    // A retained active event can be older than deleted resolved history. Re-cursor it above the
    // compaction floor so a reset snapshot can be safely continued with ordinary `after` paging.
    for (const event of state.events) {
      if (event.cursor <= state.prunedThroughCursor) {
        event.cursor = this.allocateCursor(state);
        event.revision += 1;
      }
    }
    return removed.length;
  }

  private load(): AttentionStoreFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.events) || !Array.isArray(raw.observations)
          || !Array.isArray(raw.clientStates) || !Array.isArray(raw.deliveries)) {
        throw new Error('unsupported attention store schema');
      }
      if (!Number.isSafeInteger(raw.nextCursor) || (raw.nextCursor as number) < 1
          || !Number.isSafeInteger(raw.prunedThroughCursor) || (raw.prunedThroughCursor as number) < 0) {
        throw new Error('invalid attention store cursors');
      }
      const events = raw.events.map(normalizeEvent);
      const observations = raw.observations.map(normalizeObservation);
      const clientStates = raw.clientStates.map(normalizeClientState);
      const deliveries = raw.deliveries.map(normalizeDelivery);
      if (events.some((item) => !item) || observations.some((item) => !item)
          || clientStates.some((item) => !item) || deliveries.some((item) => !item)) {
        throw new Error('invalid attention store record');
      }
      const state: AttentionStoreFile = {
        version: 1,
        nextCursor: raw.nextCursor as number,
        prunedThroughCursor: raw.prunedThroughCursor as number,
        events: events as AttentionEvent[],
        observations: observations as AttentionObservation[],
        clientStates: clientStates as AttentionClientState[],
        deliveries: deliveries as AttentionDelivery[],
      };
      if (new Set(state.events.map((event) => event.id)).size !== state.events.length
          || new Set(state.events.map((event) => event.dedupeKey)).size !== state.events.length) {
        throw new Error('duplicate attention event identity');
      }
      const maxCursor = Math.max(
        state.prunedThroughCursor,
        ...state.events.map((event) => event.cursor),
        ...state.clientStates.map((item) => item.cursor),
      );
      state.nextCursor = Math.max(1, state.nextCursor, maxCursor + 1);
      try { this.options.onStartupResult?.(true); } catch { /* observer-only */ }
      return state;
    } catch (error) {
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      const backup = `${this.path}.${stamp}.corrupt`;
      try {
        renameSync(this.path, backup);
        this.onWarning(`Attention store was corrupt and moved to ${backup}; starting with an empty feed.`);
      } catch {
        this.onWarning(`Attention store is corrupt and could not be moved aside: ${error instanceof Error ? error.message : String(error)}`);
      }
      try { this.options.onStartupResult?.(false, 'startup-corrupt'); } catch { /* observer-only */ }
      return emptyFile();
    }
  }

  private save(state: AttentionStoreFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${++this.tempSequence}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'w', 0o600);
      writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
      try { this.options.onPersistenceResult?.(true); } catch { /* observer-only */ }
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      try { unlinkSync(tmp); } catch { /* best effort */ }
      try { this.options.onPersistenceResult?.(false); } catch { /* observer-only */ }
      throw error;
    }
  }
}
