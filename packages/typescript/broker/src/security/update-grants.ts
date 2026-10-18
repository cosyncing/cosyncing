/**
 * The narrow, revocable authority to install updates on this broker.
 *
 * Ordinary pairing hands out `observe`, `drive` and `files`, and none of them has
 * ever meant "may replace the software on this machine". The existing `admin` peer
 * role is unused by any route and must not become the back door that answers for
 * it, so update authority lives in its own persistent record, bound to a peer
 * identity and to this broker installation.
 *
 * A peer may ask. Only an already-authorized surface may answer. That asymmetry is
 * the entire design: a phone that could approve its own request would make the
 * grant decorative.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPDATE_GRANT_SCOPE,
  updateGrantIsActive,
  type UpdateGrantRecord,
} from '@cosyncing/protocol';
import {
  atomicWriteJsonOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from './secure-files.ts';

export const UPDATE_GRANTS_SCHEMA_VERSION = 1 as const;
export const UPDATE_GRANTS_FILENAME = 'update-grants.json';

export interface UpdateGrantStore {
  /** Current authority for a peer, if any. A revoked grant stays as an audit row. */
  forPeer(peerId: string): UpdateGrantRecord | undefined;
  mayUpdate(peerId: string, at?: Date): boolean;
  grant(input: { peerId: string; grantedBy: 'owner' | 'local-management'; at?: Date }): UpdateGrantRecord;
  revoke(peerId: string, at?: Date): { ok: boolean; reason?: string };
  pendingRequests(): UpdatePermissionRequest[];
  /** A peer records that it needs authority. It cannot grant itself. */
  request(peerId: string, at?: Date): { record: UpdatePermissionRequest; duplicate: boolean };
  withdrawRequest(peerId: string): void;
  list(): UpdateGrantRecord[];
}

export interface UpdatePermissionRequest {
  peerId: string;
  requestedAt: string;
}

interface GrantFile {
  schemaVersion: typeof UPDATE_GRANTS_SCHEMA_VERSION;
  installationId: string;
  grants: UpdateGrantRecord[];
  requests: UpdatePermissionRequest[];
}

export type GrantRead =
  | { state: 'empty' }
  | { state: 'ok'; file: GrantFile }
  | { state: 'superseded'; file: GrantFile }
  /** A file this build cannot interpret. Never rewritten, never honoured. */
  | { state: 'unreadable' | 'unknown-schema' };

export function updateGrantsPath(home: string): string {
  return join(home, UPDATE_GRANTS_FILENAME);
}

/**
 * Owner-only update authority for one broker installation.
 *
 * Records live under the state root beside the durable service state rather than
 * under a directory an update replaces, and every write is atomic and owner-only,
 * because a grant readable by anything other than this user is not a grant.
 */
export function openUpdateGrantStore(options: {
  home: string;
  installationId: string | (() => string);
  now?: () => Date;
}): UpdateGrantStore {
  const path = updateGrantsPath(options.home);
  const now = options.now ?? (() => new Date());
  const installationId = (): string => typeof options.installationId === 'function'
    ? options.installationId()
    : options.installationId;

  const read = (id: string): GrantRead => {
    // Inspected rather than caught: "never issued a grant" and "could not be read"
    // must not collapse into each other. The first is the ordinary legacy answer and
    // means no authority; the second means authority exists somewhere and this build
    // is not allowed to guess at it.
    const inspection = inspectOwnerOnlyFile(path);
    if (inspection.status === 'missing') return { state: 'empty' };
    if (inspection.status !== 'ok') return { state: 'unreadable' };
    let value: unknown;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return { state: 'unreadable' };
    }
    try {
      value = JSON.parse(text);
    } catch {
      return { state: 'unreadable' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unreadable' };
    if ((value as { schemaVersion?: unknown }).schemaVersion !== UPDATE_GRANTS_SCHEMA_VERSION) {
      return { state: 'unknown-schema' };
    }
    const file = value as GrantFile;
    if (typeof file.installationId !== 'string' || !file.installationId
        || !Array.isArray(file.grants) || !Array.isArray(file.requests)
        || file.grants.some((grant) => !grant || typeof grant !== 'object'
          || typeof grant.installationId !== 'string')) return { state: 'unreadable' };
    // A store copied from another installation is not this installation's answer.
    if (file.installationId !== id) return { state: 'superseded', file };
    return { state: 'ok', file };
  };

  const emptyFile = (id: string): GrantFile => ({
    schemaVersion: UPDATE_GRANTS_SCHEMA_VERSION,
    installationId: id,
    grants: [],
    requests: [],
  });

  const write = (file: GrantFile): void => {
    ensureOwnerOnlyDirectory(options.home);
    atomicWriteJsonOwnerOnly(path, file);
  };

  /** Load a writable copy, treating "nothing recorded yet" as the empty store. */
  const load = (id: string, at = now()): GrantFile => {
    const current = read(id);
    if (current.state === 'ok') return current.file;
    if (current.state === 'empty') return emptyFile(id);
    if (current.state === 'superseded') {
      // Preserve the audit, but transfer no authority or permission requests. Mark old
      // rows revoked on disk as well, so an older reader cannot honour them after rollback.
      return {
        ...emptyFile(id),
        grants: current.file.grants.map((grant) => ({
          ...grant,
          revokedAt: grant.revokedAt ?? at.toISOString(),
        })),
      };
    }
    // An unreadable or future-schema store is refused rather than reset. Overwriting
    // it would erase the authority a user granted, or silently invent one.
    throw new Error(`update-grant-store-${current.state}`);
  };

  return {
    forPeer: (peerId) => {
      const id = installationId();
      const current = read(id);
      if (current.state === 'empty' || current.state === 'superseded') return undefined;
      if (current.state !== 'ok') throw new Error(`update-grant-store-${current.state}`);
      return [...current.file.grants]
        .reverse()
        .find((grant) => grant.installationId === id && grant.peerId === peerId && grant.scope === UPDATE_GRANT_SCOPE);
    },
    // The authorization predicate is the one read that never throws: an authority
    // store this build cannot interpret means nobody currently may commit, which is
    // the safe direction to be wrong. The reporting reads above do throw, so a
    // surface can say "unknown" instead of showing a confident wrong list.
    mayUpdate: (peerId, at) => {
      const id = installationId();
      const current = read(id);
      if (current.state !== 'ok') return false;
      const grant = [...current.file.grants]
        .reverse()
        .find((entry) => entry.installationId === id && entry.peerId === peerId && entry.scope === UPDATE_GRANT_SCOPE);
      return updateGrantIsActive(grant, at ?? now());
    },
    grant: ({ peerId, grantedBy, at }) => {
      const id = installationId();
      const grantedAt = at ?? now();
      const file = load(id, grantedAt);
      const record: UpdateGrantRecord = {
        scope: UPDATE_GRANT_SCOPE,
        peerId,
        installationId: id,
        grantedAt: grantedAt.toISOString(),
        grantedBy,
      };
      // Appended rather than replaced: the earlier rows are the audit trail for who
      // held this authority and when, and revoking does not delete that history.
      file.grants = [...file.grants.filter((entry) => entry.peerId !== peerId || entry.revokedAt !== undefined), record];
      file.requests = file.requests.filter((entry) => entry.peerId !== peerId);
      write(file);
      return record;
    },
    revoke: (peerId, at) => {
      const id = installationId();
      const file = load(id, at);
      const active = file.grants.find((entry) => entry.installationId === id && entry.peerId === peerId && entry.revokedAt === undefined);
      if (!active) return { ok: false, reason: 'no-active-grant' };
      active.revokedAt = (at ?? now()).toISOString();
      write(file);
      return { ok: true };
    },
    pendingRequests: () => {
      const current = read(installationId());
      if (current.state === 'empty' || current.state === 'superseded') return [];
      if (current.state !== 'ok') throw new Error(`update-grant-store-${current.state}`);
      return [...current.file.requests];
    },
    request: (peerId, at) => {
      const file = load(installationId(), at);
      const existing = file.requests.find((entry) => entry.peerId === peerId);
      if (existing) return { record: existing, duplicate: true };
      const record: UpdatePermissionRequest = { peerId, requestedAt: (at ?? now()).toISOString() };
      file.requests = [...file.requests, record];
      write(file);
      return { record, duplicate: false };
    },
    withdrawRequest: (peerId) => {
      const file = load(installationId());
      file.requests = file.requests.filter((entry) => entry.peerId !== peerId);
      write(file);
    },
    list: () => {
      const id = installationId();
      const current = read(id);
      if (current.state === 'empty' || current.state === 'superseded') return [];
      if (current.state !== 'ok') throw new Error(`update-grant-store-${current.state}`);
      return current.file.grants.filter((grant) => grant.installationId === id);
    },
  };
}
