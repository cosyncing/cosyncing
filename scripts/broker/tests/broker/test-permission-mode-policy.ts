#!/usr/bin/env bun
import assert from 'node:assert/strict';
import type { SessionConnection } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  ClientMessagePolicyError,
  validateRequestedPermissionMode,
} from '../../../../packages/typescript/broker/src/client-message-policy.ts';

const connection = (listModes?: SessionConnection['listModes']): SessionConnection => ({
  info: { id: 's', tool: 'fake', title: 'Fake', status: 'idle', attachMode: 'live' },
  async getHistory() { return []; },
  subscribe() { return () => undefined; },
  async sendPrompt() {},
  async respondPermission() {},
  ...(listModes ? { listModes } : {}),
  async close() {},
});

assert.equal(await validateRequestedPermissionMode(connection(), false, undefined), undefined,
  'absent permissionMode stays backwards compatible');
assert.equal(await validateRequestedPermissionMode(connection(async () => [
  { value: 'default', label: 'Default' },
  { value: 'bypassPermissions', label: 'Full access' },
]), true, 'bypassPermissions'), 'bypassPermissions', 'an exact live advertisement must pass');

for (const [name, conn, value] of [
  ['unknown', connection(async () => [{ value: 'default', label: 'Default' }]), 'Default'],
  ['malformed whitespace', connection(async () => [{ value: 'default', label: 'Default' }]), ' default'],
  ['malformed type', connection(async () => [{ value: 'default', label: 'Default' }]), { value: 'default' }],
  ['inapplicable', connection(), 'default'],
  ['unavailable', connection(async () => { throw new Error('/secret/native failure'); }), 'default'],
] as const) {
  await assert.rejects(
    validateRequestedPermissionMode(conn, true, value),
    (error: unknown) => error instanceof ClientMessagePolicyError
      && error.code === 'PERMISSION_MODE_UNSUPPORTED'
      && !error.message.includes('/secret/'),
    `${name} mode must fail with the stable sanitized code`,
  );
}

console.log('PASS permission-mode policy exact-match, malformed, unavailable, and inapplicable cases');
