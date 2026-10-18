/**
 * Update authority on a real owner-only file.
 *
 * The property under test is that authority is narrow, persistent, revocable, and
 * impossible for the requesting device to grant itself -- which is only worth
 * asserting against actual durable state, since an in-memory map would pass these
 * tests while losing grants on every restart.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATE_GRANT_SCOPE } from '@cosyncing/protocol';
import { UPDATE_GRANTS_FILENAME, openUpdateGrantStore, updateGrantsPath } from './update-grants.ts';

const owned: string[] = [];
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cosyncing-update-grants-'));
  owned.push(directory);
  return directory;
}

const T0 = new Date('2026-01-10T12:00:00.000Z');
const LATER = new Date('2026-01-11T12:00:00.000Z');

test('a fresh installation has no update authority to lose', () => {
  const store = openUpdateGrantStore({ home: home(), installationId: 'inst-a' });
  expect(store.mayUpdate('peer-phone', T0)).toBe(false);
  expect(store.forPeer('peer-phone')).toBeUndefined();
  expect(store.pendingRequests()).toEqual([]);
});

test('a grant survives a restart and revocation stops it immediately', () => {
  const directory = home();
  const opened = openUpdateGrantStore({ home: directory, installationId: 'inst-a' });
  const record = opened.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 });
  expect(record.scope).toBe(UPDATE_GRANT_SCOPE);
  expect(opened.mayUpdate('peer-phone', LATER)).toBe(true);

  // Reopened: a second broker process must see the same authority, and the same absence of it.
  const reopened = openUpdateGrantStore({ home: directory, installationId: 'inst-a' });
  expect(reopened.mayUpdate('peer-phone', LATER)).toBe(true);
  expect(reopened.revoke('peer-phone', LATER).ok).toBe(true);
  expect(openUpdateGrantStore({ home: directory, installationId: 'inst-a' }).mayUpdate('peer-phone', LATER)).toBe(false);
  expect(openUpdateGrantStore({ home: directory, installationId: 'inst-a' }).revoke('peer-phone', LATER).reason).toBe('no-active-grant');
});

test('a grant is bound to its peer and to this installation', () => {
  const directory = home();
  let installationId = 'inst-a';
  const live = openUpdateGrantStore({ home: directory, installationId: () => installationId });
  live.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 });
  // A different device on the same broker inherits nothing.
  expect(openUpdateGrantStore({ home: directory, installationId: 'inst-a' }).mayUpdate('peer-laptop', LATER)).toBe(false);
  // A store carried to another installation is not that installation's answer either:
  // neither authority nor the other installation's device list is inherited.
  const foreign = openUpdateGrantStore({ home: directory, installationId: 'inst-b' });
  expect(foreign.mayUpdate('peer-phone', LATER)).toBe(false);
  expect(foreign.list()).toEqual([]);

  const before = readText(updateGrantsPath(directory));
  installationId = 'inst-b';
  expect(live.mayUpdate('peer-phone', LATER)).toBe(false);
  expect(live.forPeer('peer-phone')).toBeUndefined();
  expect(live.list()).toEqual([]);
  expect(readText(updateGrantsPath(directory))).toBe(before);
  const issued = live.grant({ peerId: 'peer-laptop', grantedBy: 'owner', at: LATER });
  expect(issued.installationId).toBe('inst-b');
  expect(foreign.mayUpdate('peer-laptop', LATER)).toBe(true);
  expect(foreign.mayUpdate('peer-phone', LATER)).toBe(false);
  const audit = JSON.parse(readText(updateGrantsPath(directory)));
  expect(audit.grants.find((row: any) => row.peerId === 'peer-phone'))
    .toMatchObject({ installationId: 'inst-a', revokedAt: LATER.toISOString() });
});

test('a peer may ask for authority and cannot give it to itself', () => {
  const store = openUpdateGrantStore({ home: home(), installationId: 'inst-a' });
  const first = store.request('peer-phone', T0);
  expect(first.duplicate).toBe(false);
  expect(store.request('peer-phone', T0).duplicate).toBe(true);
  expect(store.mayUpdate('peer-phone', T0)).toBe(false);
  expect(store.pendingRequests().map((entry) => entry.peerId)).toEqual(['peer-phone']);

  // Only the owner surface converts a request into authority, and it clears the queue.
  store.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: LATER });
  expect(store.pendingRequests()).toEqual([]);
  expect(store.mayUpdate('peer-phone', LATER)).toBe(true);

  const other = store.request('peer-other', T0);
  store.withdrawRequest('peer-other');
  expect(other.record.peerId).toBe('peer-other');
  expect(store.pendingRequests()).toEqual([]);
});

test('revocation is re-checkable at the moment of commit, not cached from pairing', () => {
  const store = openUpdateGrantStore({ home: home(), installationId: 'inst-a' });
  store.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 });
  // The disruptive commit re-reads: revoking between plan and apply is honoured.
  store.revoke('peer-phone', new Date('2026-01-10T12:05:00.000Z'));
  expect(store.mayUpdate('peer-phone', new Date('2026-01-10T12:04:00.000Z'))).toBe(true);
  expect(store.mayUpdate('peer-phone', new Date('2026-01-10T12:06:00.000Z'))).toBe(false);
});

test('re-granting replaces the active row and keeps the revoked history', () => {
  const store = openUpdateGrantStore({ home: home(), installationId: 'inst-a' });
  const first = store.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 });
  store.revoke('peer-phone', LATER);
  const second = store.grant({ peerId: 'peer-phone', grantedBy: 'local-management', at: LATER });
  const rows = store.list();
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.grantedAt === first.grantedAt)?.revokedAt).toBeDefined();
  expect(store.forPeer('peer-phone')?.grantedBy).toBe('local-management');
});

test('a store this build cannot read is refused, never reset', () => {
  const directory = home();
  const path = updateGrantsPath(directory);
  writeFileSync(path, JSON.stringify({ schemaVersion: 99, installationId: 'inst-a', grants: [], requests: [] }), { mode: 0o600 });
  // A new installation may retire a known old scope, but cannot reinterpret a future schema.
  const store = openUpdateGrantStore({ home: directory, installationId: 'inst-b' });
  expect(() => store.grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 })).toThrow('update-grant-store-unknown-schema');
  expect(() => store.list()).toThrow('update-grant-store-unknown-schema');
  expect(store.mayUpdate('peer-phone', T0)).toBe(false);

  writeFileSync(path, 'not json', { mode: 0o600 });
  expect(() => store.list()).toThrow('update-grant-store-unreadable');
  expect(() => store.revoke('peer-phone')).toThrow('update-grant-store-unreadable');
  // Refusing left the file exactly as it was found.
  expect(readText(path)).toBe('not json');
});

test('the grant record is owner-only on disk', () => {
  const directory = home();
  openUpdateGrantStore({ home: directory, installationId: 'inst-a' })
    .grant({ peerId: 'peer-phone', grantedBy: 'owner', at: T0 });
  const path = join(directory, UPDATE_GRANTS_FILENAME);
  expect(statSync(path).mode & 0o077).toBe(0);
  // Nothing that looks like a credential belongs in an authority record.
  expect(readText(path)).not.toMatch(/token|secret|bearer/i);
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

afterAll(() => {
  for (const directory of owned) rmSync(directory, { recursive: true, force: true });
});
