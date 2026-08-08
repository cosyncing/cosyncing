#!/usr/bin/env bun
/**
 * `set-agent` policy regression: the broker validates a requested agent/mode
 * against the EXACT roster the live connection advertises via listAgents, and
 * fails closed (stable sanitized code) when the adapter has no switch surface,
 * the roster is unavailable, or the name is malformed/stale.
 *
 *   bun run scripts/broker/tests/broker/test-agent-switch-policy.ts
 */
import assert from 'node:assert/strict';
import type { SessionConnection } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  ClientMessagePolicyError,
  validateRequestedAgent,
} from '../../../../packages/typescript/broker/src/client-message-policy.ts';

const connection = (overrides: Partial<SessionConnection> = {}): SessionConnection => ({
  info: { id: 's', tool: 'fake', title: 'Fake', status: 'idle', attachMode: 'live' },
  async getHistory() { return []; },
  subscribe() { return () => undefined; },
  async sendPrompt() {},
  async respondPermission() {},
  async close() {},
  ...overrides,
});

const switchable = (listAgents: SessionConnection['listAgents']) =>
  connection({ listAgents, setAgent: async () => {} });

assert.equal(
  await validateRequestedAgent(switchable(async () => [
    { name: 'build', description: 'Implementation agent' },
    { name: 'plan', description: 'Read-only planning agent' },
  ]), 'plan'),
  'plan',
  'an exact live advertisement must pass',
);

for (const [name, conn, value] of [
  ['unknown', switchable(async () => [{ name: 'build' }]), 'plan'],
  ['malformed whitespace', switchable(async () => [{ name: 'build' }]), ' build'],
  ['malformed type', switchable(async () => [{ name: 'build' }]), { name: 'build' }],
  ['absent', switchable(async () => [{ name: 'build' }]), undefined],
  ['no setAgent surface', connection({ listAgents: async () => [{ name: 'build' }] }), 'build'],
  ['no listAgents surface', connection({ setAgent: async () => {} }), 'build'],
  ['unavailable roster', switchable(async () => { throw new Error('/secret/native failure'); }), 'build'],
] as const) {
  await assert.rejects(
    validateRequestedAgent(conn, value),
    (error: unknown) => error instanceof ClientMessagePolicyError
      && error.code === 'AGENT_UNSUPPORTED'
      && !error.message.includes('/secret/'),
    `${name} agent must fail with the stable sanitized code`,
  );
}

console.log('PASS set-agent policy exact-match, malformed, unsupported, and unavailable cases');
