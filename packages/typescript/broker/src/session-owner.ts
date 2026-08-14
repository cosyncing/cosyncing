import { randomUUID } from 'node:crypto';
import type {
  SessionConnectionAuthority,
  SessionInfo,
  SessionOwnerProjection,
  SessionOwnerRevision,
} from '@cosyncing/protocol';

/** Stable join-existing refusal codes carried through the existing attach-conflict frame. */
export type JoinExistingRefusalCode =
  | 'JOIN_OWNER_NOT_FOUND'
  | 'JOIN_OWNER_STALE'
  | 'JOIN_NOT_SUPPORTED';

/** A revision-conditional existing-owner lookup failed without attempting native attach. */
export class JoinExistingError extends Error {
  constructor(
    public readonly code: JoinExistingRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'JoinExistingError';
  }
}

export function isJoinExistingError(error: unknown): error is JoinExistingError {
  return error instanceof JoinExistingError
    || (error instanceof Error
      && error.name === 'JoinExistingError'
      && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string');
}

/** One socket's exact broker-enforced mutation authority. */
export function sessionConnectionAuthority(info: SessionInfo): SessionConnectionAuthority {
  const control = info.control;
  const drive = control?.drive.supported === true && control.drive.state === 'driving';
  const sync = control?.terminalSync.supported === true && control.terminalSync.active === true;
  if (!drive && !sync) return { canMutate: false, prompt: 'none' };
  if (!drive && control?.terminalSync.input === 'answer-only') {
    return { canMutate: true, prompt: 'answer-only' };
  }
  return { canMutate: true, prompt: 'full' };
}

export function canMutateSession(info: SessionInfo): boolean {
  return sessionConnectionAuthority(info).canMutate;
}

export function canPromptSession(info: SessionInfo): boolean {
  return sessionConnectionAuthority(info).prompt === 'full';
}

/** Active owner eligibility is evaluated before ranking; attach mode alone proves nothing. */
export function activeOwnerState(info: SessionInfo): SessionOwnerProjection['state'] | undefined {
  const control = info.control;
  if (control?.terminalSync.supported && control.terminalSync.active) return 'terminal-sync';
  if (control?.drive.supported && control.drive.state === 'driving') return 'drive';
  return undefined;
}

export interface ActiveOwnerCandidate<T extends object> {
  key: string;
  identity: T;
  /** Native connection generation. Defaults to `identity` for callers without a wrapper. */
  generation?: object;
  info: SessionInfo;
}

export interface ActiveOwnerResolution<T extends object> {
  projection: SessionOwnerProjection;
  owner?: ActiveOwnerCandidate<T>;
}

interface StoredOwnerResolution<T extends object> extends ActiveOwnerResolution<T> {
  identity?: object;
}

/** Process-scoped owner revisions over every mode wrapper of one `tool:id`. */
export class ActiveSessionOwnerRegistry<T extends object> {
  readonly epoch: string;
  private readonly records = new Map<string, StoredOwnerResolution<T>>();

  constructor(epoch = randomUUID()) {
    this.epoch = epoch;
  }

  private sessionKey(tool: string, id: string): string {
    return `${tool}\0${id}`;
  }

  current(tool: string, id: string): ActiveOwnerResolution<T> {
    const key = this.sessionKey(tool, id);
    let record = this.records.get(key);
    if (!record) {
      record = {
        projection: { revision: { epoch: this.epoch, seq: 0 }, state: 'none' },
      };
      this.records.set(key, record);
    }
    return { projection: cloneProjection(record.projection), ...(record.owner ? { owner: record.owner } : {}) };
  }

  reconcile(
    tool: string,
    id: string,
    candidates: Iterable<ActiveOwnerCandidate<T>>,
  ): {
    resolution: ActiveOwnerResolution<T>;
    changed: boolean;
    previouslyKnown: boolean;
  } {
    const key = this.sessionKey(tool, id);
    const previous = this.records.get(key);
    const owner = selectActiveOwner(candidates);
    const state = owner ? activeOwnerState(owner.info)! : 'none';
    const changed = previous === undefined
      ? state !== 'none'
      : previous.projection.state !== state || previous.identity !== ownerGeneration(owner);
    const seq = previous?.projection.revision.seq ?? 0;
    const record: StoredOwnerResolution<T> = {
      projection: {
        revision: { epoch: this.epoch, seq: changed ? seq + 1 : seq },
        state,
      },
      ...(owner ? { owner, identity: ownerGeneration(owner) } : {}),
    };
    this.records.set(key, record);
    return {
      resolution: {
        projection: cloneProjection(record.projection),
        ...(record.owner ? { owner: record.owner } : {}),
      },
      changed,
      previouslyKnown: previous !== undefined,
    };
  }
}

function ownerGeneration<T extends object>(owner: ActiveOwnerCandidate<T> | undefined): object | undefined {
  return owner?.generation ?? owner?.identity;
}

/** Deterministic active-before-rank reduction. */
export function selectActiveOwner<T extends object>(
  candidates: Iterable<ActiveOwnerCandidate<T>>,
): ActiveOwnerCandidate<T> | undefined {
  let selected: ActiveOwnerCandidate<T> | undefined;
  for (const candidate of candidates) {
    if (!activeOwnerState(candidate.info)) continue;
    if (!selected || ownerOutranks(candidate, selected)) selected = candidate;
  }
  return selected;
}

export function sameOwnerRevision(a: SessionOwnerRevision, b: SessionOwnerRevision): boolean {
  return a.epoch === b.epoch && a.seq === b.seq;
}

function ownerOutranks<T extends object>(
  candidate: ActiveOwnerCandidate<T>,
  selected: ActiveOwnerCandidate<T>,
): boolean {
  const statePriority = (info: SessionInfo): number => activeOwnerState(info) === 'terminal-sync' ? 2 : 1;
  const byState = statePriority(candidate.info) - statePriority(selected.info);
  if (byState !== 0) return byState > 0;
  const byRecency = (candidate.info.updatedAt ?? 0) - (selected.info.updatedAt ?? 0);
  if (byRecency !== 0) return byRecency > 0;
  return candidate.key < selected.key;
}

function cloneProjection(projection: SessionOwnerProjection): SessionOwnerProjection {
  return {
    revision: { ...projection.revision },
    state: projection.state,
  };
}
