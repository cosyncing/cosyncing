#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { BROKER_INTEGRATION_ROUTES, BROKER_ROUTES } from '@cosyncing/protocol';
import {
  authorizeBrokerRoute,
  BROKER_ROUTE_POLICIES,
  INTEGRATION_ROUTE_POLICIES,
  type PeerRoutePolicy,
  type RouteAuthorizationPrincipal,
} from '../../src/security/route-authorization.ts';
import type { PeerRole } from '../../src/transport/transport-pairing.ts';

const principals: ReadonlyArray<{ name: string; value: RouteAuthorizationPrincipal }> = [
  { name: 'unauthenticated', value: undefined },
  { name: 'owner', value: { kind: 'owner' } },
  { name: 'observe-only', value: peer('observe') },
  { name: 'drive-only', value: peer('drive') },
  { name: 'files-only', value: peer('files') },
  { name: 'observe+files', value: peer('observe', 'files') },
  { name: 'zero-role', value: peer() },
  { name: 'Pi integration', value: { kind: 'integration', integration: 'pi' } },
];

assert.deepEqual(
  [...new Set(BROKER_ROUTE_POLICIES.map((entry) => entry.route))].sort(),
  [...BROKER_ROUTES].sort(),
  'every canonical broker route must have an explicit policy',
);
assert.deepEqual(
  [...new Set(INTEGRATION_ROUTE_POLICIES.map((entry) => entry.route))].sort(),
  [...new Set(BROKER_INTEGRATION_ROUTES)].sort(),
  'every canonical integration route must have an explicit policy',
);

for (const entry of [...BROKER_ROUTE_POLICIES, ...INTEGRATION_ROUTE_POLICIES]) {
  const path = entry.route.replaceAll('{id}', 'route-id');
  for (const method of entry.methods) {
    for (const principal of principals) {
      const decision = authorizeBrokerRoute(principal.value, path, method);
      assert.equal(
        decision.allowed,
        expectedAllowed(entry.policy, principal.value),
        `${principal.name} ${method} ${path} must follow ${JSON.stringify(entry.policy)}`,
      );
    }
  }
}

for (const principal of principals.filter((entry) => entry.value?.kind !== 'owner')) {
  assert.equal(
    authorizeBrokerRoute(principal.value, '/api/future-unclassified-route', 'GET').allowed,
    false,
    `${principal.name} must fail closed for an unclassified route`,
  );
  assert.equal(
    authorizeBrokerRoute(principal.value, '/api/machines', 'POST').allowed,
    false,
    `${principal.name} must fail closed for an unclassified method`,
  );
}
assert.equal(authorizeBrokerRoute({ kind: 'owner' }, '/api/future-unclassified-route', 'GET').allowed, true);

console.log(`PASS: ${BROKER_ROUTES.length} broker routes and ${new Set(BROKER_INTEGRATION_ROUTES).size} integration routes are exhaustively authorized`);

function peer(...roles: PeerRole[]): RouteAuthorizationPrincipal {
  return { kind: 'peer', roles: new Set(roles) };
}

function expectedAllowed(policy: PeerRoutePolicy, principal: RouteAuthorizationPrincipal): boolean {
  if (principal?.kind === 'owner') return true;
  if (policy.kind === 'public') return true;
  if (!principal || policy.kind === 'owner-only') return false;
  if (principal.kind === 'integration') {
    return policy.kind === 'integration' && policy.integration === principal.integration;
  }
  if (policy.kind !== 'peer') return false;
  return 'allOf' in policy
    ? policy.allOf.every((role) => principal.roles.has(role))
    : policy.anyOf.some((role) => principal.roles.has(role));
}
