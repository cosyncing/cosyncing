/**
 * DeepSeek Harness session cookies, held by the broker.
 *
 * `dsh web` hands out one cookie per authenticated browser, valid by default for
 * thirty days, and it is the ONLY thing that authenticates an API or WebSocket
 * request to a 0.2 host. cosyncing earns one either by exchanging the launch URL
 * its own managed host printed, or by exchanging a URL an operator pasted for a
 * host they started themselves. Either way the cookie has to outlive the process
 * that earned it, because the host outlives the broker: without persistence every
 * broker restart would need a fresh token, and an external host has no way to
 * print one again without its owner going and looking.
 *
 * WHAT THIS IS NOT.
 *
 * It is not a place that mints credentials. The cookie is an HMAC under the
 * HOST's signing secret, so possession of this file proves nothing an attacker
 * could not already use — which is exactly why it is owner-only, atomic, and
 * refused rather than repaired when it looks wrong. Nothing here can produce a
 * cookie, and nothing here can extend one.
 *
 * It does not hold the launch token. That token is the host's root credential for
 * one process's lifetime and is kept in the adapter's memory alone, so a broker
 * crash cannot leave a mint-on-demand URL on disk.
 *
 * WHY SCOPES RATHER THAN ONE FILE: an operator with a laptop host and a review
 * host has two enrollments, and a store that held "the dsh cookie" would quietly
 * log one out by enrolling the other.
 */

import { join } from 'node:path';
import { setupStateHome } from '../installation/setup-state.ts';
import {
  atomicWriteJsonOwnerOnly,
  inspectOwnerOnlyFile,
  readOwnerOnlyText,
} from './secure-files.ts';
import type { DshCookie, DshCredentialStore } from '@cosyncing/adapter-dsh';

export const DSH_SESSIONS_FILENAME = 'dsh-sessions.json';
export const DSH_SESSIONS_SCHEMA_VERSION = 1 as const;

/** Distinct enrollments this file will hold. Beyond it, an operator removes one before adding another. */
export const DSH_MAX_ENROLLMENTS = 32;
/** Whole-file ceiling. A cookie is a few hundred bytes; thirty days of them is not a data set. */
export const DSH_SESSIONS_MAX_BYTES = 64 * 1024;
/** One cookie value's ceiling, checked on the way in so a hostile host cannot inflate the file. */
export const DSH_COOKIE_VALUE_MAX_CHARS = 4_096;

export interface DshStoredSession {
  name: string;
  value: string;
  expiresAt?: number;
  /** Bumped on every write, so an operator can tell a refresh from a re-read. */
  revision: number;
  savedAt: number;
}

export interface DshSessionFile {
  schemaVersion: typeof DSH_SESSIONS_SCHEMA_VERSION;
  sessions: Record<string, DshStoredSession>;
}

export interface DshEnrollmentSummary {
  scope: string;
  revision: number;
  savedAt: number;
  expiresAt?: number;
}

export type DshCredentialInspection =
  | { status: 'missing'; path: string; detailCode: 'dsh-sessions-missing' }
  | { status: 'ok'; path: string; detailCode: 'dsh-sessions-ok'; enrollments: readonly DshEnrollmentSummary[] }
  | { status: 'unsafe' | 'unreadable'; path: string; detailCode: 'dsh-sessions-unsafe' | 'dsh-sessions-unreadable' }
  | { status: 'malformed'; path: string; detailCode: 'dsh-sessions-malformed' };

export class DshCredentialStateError extends Error {
  constructor(readonly detailCode: string) {
    super(`DeepSeek Harness session state is invalid (${detailCode})`);
    this.name = 'DshCredentialStateError';
  }
}

export function dshSessionsPath(home = setupStateHome()): string {
  return join(home, 'secrets', DSH_SESSIONS_FILENAME);
}

function validCookieName(name: unknown): name is string {
  // The host names its own cookie `dsh-auth-<base64url(sha256(authority))>`. A
  // name outside that shape is not a cookie this host issued, and storing it
  // would mean this file can be talked into carrying an arbitrary header.
  return typeof name === 'string' && /^dsh-auth-[A-Za-z0-9_-]{8,128}$/.test(name);
}

function validStoredSession(value: unknown): value is DshStoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!validCookieName(row.name)) return false;
  if (typeof row.value !== 'string' || row.value.length === 0 || row.value.length > DSH_COOKIE_VALUE_MAX_CHARS) return false;
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0) return false;
  if (typeof row.savedAt !== 'number' || !Number.isSafeInteger(row.savedAt)) return false;
  if (row.expiresAt !== undefined && (typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt))) return false;
  return true;
}

function parseSessionFile(text: string, path: string): DshSessionFile {
  if (Buffer.byteLength(text, 'utf8') > DSH_SESSIONS_MAX_BYTES) {
    throw new DshCredentialStateError('dsh-sessions-too-large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DshCredentialStateError('dsh-sessions-malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DshCredentialStateError('dsh-sessions-malformed');
  }
  const row = parsed as Record<string, unknown>;
  if (row.schemaVersion !== DSH_SESSIONS_SCHEMA_VERSION) {
    throw new DshCredentialStateError('dsh-sessions-schema-unsupported');
  }
  const sessions = row.sessions;
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    throw new DshCredentialStateError('dsh-sessions-malformed');
  }
  const entries = Object.entries(sessions as Record<string, unknown>);
  if (entries.length > DSH_MAX_ENROLLMENTS) throw new DshCredentialStateError('dsh-sessions-too-large');
  const accepted: Record<string, DshStoredSession> = {};
  for (const [scope, stored] of entries) {
    // A malformed ENTRY is refused, not dropped: silently discarding an
    // enrollment would log an operator out of a host they did not log out of,
    // and the repair for "this file is corrupt" (`cosyncing repair`) is a
    // different action from "your enrollment vanished for no stated reason".
    if (!validStoredSession(stored)) throw new DshCredentialStateError('dsh-sessions-malformed');
    accepted[scope] = stored;
  }
  return { schemaVersion: DSH_SESSIONS_SCHEMA_VERSION, sessions: accepted };
}

/** Read the file, refusing anything unsafe. A missing file is an empty store, not an error. */
export function readDshSessionFile(target = dshSessionsPath()): DshSessionFile {
  const inspection = inspectOwnerOnlyFile(target);
  if (inspection.status === 'missing') return { schemaVersion: DSH_SESSIONS_SCHEMA_VERSION, sessions: {} };
  if (inspection.status === 'unsafe') throw new DshCredentialStateError('dsh-sessions-unsafe');
  if (inspection.status === 'unreadable') throw new DshCredentialStateError('dsh-sessions-unreadable');
  return parseSessionFile(readOwnerOnlyText(target), target);
}

export function writeDshSessionFile(record: DshSessionFile, target = dshSessionsPath()): void {
  const entries = Object.entries(record.sessions);
  if (entries.length > DSH_MAX_ENROLLMENTS) throw new DshCredentialStateError('dsh-sessions-too-large');
  const serialized = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > DSH_SESSIONS_MAX_BYTES) {
    throw new DshCredentialStateError('dsh-sessions-too-large');
  }
  atomicWriteJsonOwnerOnly(target, JSON.parse(serialized) as unknown);
}

export function loadDshCookie(scope: string, target = dshSessionsPath()): DshCookie | null {
  const stored = readDshSessionFile(target).sessions[scope];
  if (!stored) return null;
  return {
    name: stored.name,
    value: stored.value,
    ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
  };
}

/** Store one cookie. Returns the revision it was written at. */
export function saveDshCookie(scope: string, cookie: DshCookie, target = dshSessionsPath()): number {
  if (!validCookieName(cookie.name)) throw new DshCredentialStateError('dsh-sessions-cookie-name');
  if (!cookie.value || cookie.value.length > DSH_COOKIE_VALUE_MAX_CHARS) {
    throw new DshCredentialStateError('dsh-sessions-cookie-value');
  }
  const file = readDshSessionFile(target);
  const previous = file.sessions[scope];
  const revision = (previous?.revision ?? 0) + 1;
  const stored: DshStoredSession = {
    name: cookie.name,
    value: cookie.value,
    ...(cookie.expiresAt === undefined ? {} : { expiresAt: cookie.expiresAt }),
    revision,
    savedAt: Date.now(),
  };
  writeDshSessionFile({ ...file, sessions: { ...file.sessions, [scope]: stored } }, target);
  return revision;
}

export function clearDshCookie(scope: string, target = dshSessionsPath()): boolean {
  const file = readDshSessionFile(target);
  if (file.sessions[scope] === undefined) return false;
  const next = { ...file.sessions };
  delete next[scope];
  writeDshSessionFile({ ...file, sessions: next }, target);
  return true;
}

export function listDshEnrollments(target = dshSessionsPath()): readonly DshEnrollmentSummary[] {
  const file = readDshSessionFile(target);
  return Object.entries(file.sessions)
    .map(([scope, stored]) => ({
      scope,
      revision: stored.revision,
      savedAt: stored.savedAt,
      ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
    }))
    .sort((left, right) => left.scope.localeCompare(right.scope));
}

/** What doctor and `cosy dsh status` report about the store itself. */
export function inspectDshSessions(target = dshSessionsPath()): DshCredentialInspection {
  const inspection = inspectOwnerOnlyFile(target);
  if (inspection.status === 'missing') return { status: 'missing', path: target, detailCode: 'dsh-sessions-missing' };
  if (inspection.status === 'unsafe') return { status: 'unsafe', path: target, detailCode: 'dsh-sessions-unsafe' };
  if (inspection.status === 'unreadable') return { status: 'unreadable', path: target, detailCode: 'dsh-sessions-unreadable' };
  try {
    return {
      status: 'ok',
      path: target,
      detailCode: 'dsh-sessions-ok',
      enrollments: listDshEnrollments(target),
    };
  } catch {
    return { status: 'malformed', path: target, detailCode: 'dsh-sessions-malformed' };
  }
}

/**
 * The adapter-facing view: the same file, behind the async store the auth session
 * expects, with the home pinned at construction.
 *
 * Reads are NOT cached. A running broker has to notice an enrollment a `cosy dsh
 * connect` wrote from another process, and the alternative — an in-memory copy
 * that only the broker's own writes update — means the CLI's whole purpose fails
 * silently until the next restart.
 */
export function createDshCredentialStore(home = setupStateHome()): DshCredentialStore {
  const target = dshSessionsPath(home);
  return {
    async load(scope) {
      return loadDshCookie(scope, target);
    },
    async save(scope, cookie) {
      saveDshCookie(scope, cookie, target);
    },
    async clear(scope) {
      clearDshCookie(scope, target);
    },
  };
}
