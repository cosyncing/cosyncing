import { BROKER_INTEGRATION_ROUTES, BROKER_ROUTES } from '@cosyncing/protocol';
import type { PeerRole } from '../transport/transport-pairing.ts';

export type IntegrationId = 'pi' | 'omp';

export type PeerRoutePolicy =
  | { kind: 'owner-only' }
  | { kind: 'peer'; allOf: readonly PeerRole[] }
  | { kind: 'peer'; anyOf: readonly PeerRole[] }
  | { kind: 'integration'; integration: IntegrationId }
  | { kind: 'public' };

export type RouteAuthorizationPrincipal =
  | { kind: 'owner' }
  | { kind: 'peer'; roles: ReadonlySet<PeerRole> }
  | { kind: 'integration'; integration: IntegrationId }
  | undefined;

export type RouteAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string };

type BrokerRoute = (typeof BROKER_ROUTES)[number];
type IntegrationRoute = (typeof BROKER_INTEGRATION_ROUTES)[number];
type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST';

interface RoutePolicyEntry<Route extends string = BrokerRoute | IntegrationRoute> {
  route: Route;
  methods: readonly HttpMethod[];
  policy: PeerRoutePolicy;
}

const PUBLIC: PeerRoutePolicy = { kind: 'public' };
const OWNER_ONLY: PeerRoutePolicy = { kind: 'owner-only' };
const OBSERVE: PeerRoutePolicy = { kind: 'peer', allOf: ['observe'] };
const DRIVE: PeerRoutePolicy = { kind: 'peer', allOf: ['drive'] };
const FILES: PeerRoutePolicy = { kind: 'peer', allOf: ['files'] };
const OBSERVE_FILES: PeerRoutePolicy = { kind: 'peer', allOf: ['observe', 'files'] };
const PI_INTEGRATION: PeerRoutePolicy = { kind: 'integration', integration: 'pi' };
const OMP_INTEGRATION: PeerRoutePolicy = { kind: 'integration', integration: 'omp' };

/**
 * Exhaustive client HTTP policy. A route may have multiple entries when its
 * read and mutation methods intentionally have different authority.
 * Unlisted methods and paths are denied to every non-owner principal.
 */
export const BROKER_ROUTE_POLICIES: readonly RoutePolicyEntry<BrokerRoute>[] = [
  { route: '/api/agents', methods: ['GET'], policy: OBSERVE },
  { route: '/api/agents/{id}/models', methods: ['GET'], policy: OBSERVE },
  { route: '/api/agents/codex/sync', methods: ['GET'], policy: OBSERVE },
  { route: '/api/agents/codex/sync', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/agent-runtime-updates', methods: ['GET'], policy: OBSERVE },
  { route: '/api/agent-runtime-update-policy', methods: ['GET'], policy: OBSERVE },
  { route: '/api/agent-runtime-update-policy', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/agent-runtime-updates/{id}/restart', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/attention-events', methods: ['GET'], policy: OBSERVE },
  { route: '/api/attention-events/dismiss-batch', methods: ['POST'], policy: DRIVE },
  { route: '/api/attention-events/{id}/ack', methods: ['POST'], policy: DRIVE },
  { route: '/api/attention-events/{id}/dismiss', methods: ['POST'], policy: DRIVE },
  { route: '/api/broker/health', methods: ['GET'], policy: OBSERVE },
  { route: '/api/broker/features/workspace-browsing', methods: ['GET'], policy: OBSERVE },
  { route: '/api/broker/features/workspace-browsing', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/broker/restart', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/broker/restart-all', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/broker/update', methods: ['GET', 'POST'], policy: OWNER_ONLY },
  { route: '/api/health', methods: ['GET', 'HEAD'], policy: PUBLIC },
  { route: '/api/machines', methods: ['GET'], policy: OBSERVE },
  { route: '/api/machines/resolve', methods: ['GET'], policy: OBSERVE },
  { route: '/api/projects/rename', methods: ['PATCH', 'POST'], policy: DRIVE },
  { route: '/api/push/wake', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/push/wake-tokens', methods: ['GET', 'POST'], policy: OBSERVE },
  { route: '/api/push/wake-tokens/{id}', methods: ['DELETE'], policy: OBSERVE },
  { route: '/api/schedules', methods: ['GET', 'POST'], policy: OWNER_ONLY },
  { route: '/api/schedules/{id}', methods: ['DELETE', 'PATCH'], policy: OWNER_ONLY },
  { route: '/api/schedules/{id}/actions', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/claude/hooks', methods: ['GET', 'POST'], policy: OWNER_ONLY },
  { route: '/api/session-roster-deltas', methods: ['GET'], policy: OBSERVE },
  { route: '/api/sessions', methods: ['GET'], policy: OBSERVE },
  { route: '/api/sessions/{id}', methods: ['POST'], policy: DRIVE },
  { route: '/api/sessions/{id}/{id}/artifact/{id}', methods: ['GET', 'HEAD'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/artifact/{id}/ticket', methods: ['POST'], policy: OBSERVE_FILES },
  { route: '/api/sessions/{id}/{id}/fs', methods: ['GET'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/fs/read', methods: ['GET'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/fs/download', methods: ['GET'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/uploads', methods: ['POST'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/uploads/{id}', methods: ['DELETE', 'GET', 'PATCH'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/uploads/{id}/complete', methods: ['POST'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/cache', methods: ['DELETE'], policy: FILES },
  { route: '/api/sessions/{id}/{id}/clone', methods: ['POST'], policy: DRIVE },
  { route: '/api/sessions/{id}/{id}/export', methods: ['POST'], policy: OBSERVE_FILES },
  { route: '/api/sessions/{id}/{id}/export/preflight', methods: ['POST'], policy: OBSERVE_FILES },
  { route: '/api/sessions/{id}/{id}/fork', methods: ['POST'], policy: DRIVE },
  { route: '/api/sessions/{id}/{id}/rename', methods: ['PATCH', 'POST'], policy: DRIVE },
  { route: '/api/sessions/{id}/{id}/stream', methods: ['GET'], policy: OBSERVE },
  { route: '/api/tokdash/usage', methods: ['GET'], policy: OBSERVE },
  { route: '/api/tokdash/quota', methods: ['GET'], policy: OBSERVE },
  { route: '/api/tokdash/quota-preference', methods: ['GET'], policy: OBSERVE },
  { route: '/api/tokdash/quota-preference', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/tool/send_file', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/transport/envelopes', methods: ['GET', 'POST'], policy: OBSERVE },
  { route: '/api/transport/peers', methods: ['GET'], policy: OWNER_ONLY },
  { route: '/api/transport/peers/{id}', methods: ['DELETE'], policy: OWNER_ONLY },
  { route: '/api/transport/pairings', methods: ['POST'], policy: OWNER_ONLY },
  { route: '/api/transport/pairings/{id}', methods: ['GET'], policy: OWNER_ONLY },
  { route: '/api/transport/pairings/{id}/accept', methods: ['POST'], policy: PUBLIC },
  { route: '/api/transport/session-control', methods: ['POST'], policy: DRIVE },
  { route: '/api/ws-auth-tickets', methods: ['POST'], policy: OBSERVE },
];

export const INTEGRATION_ROUTE_POLICIES: readonly RoutePolicyEntry<IntegrationRoute>[] = [
  ...[...new Set(BROKER_INTEGRATION_ROUTES)]
    .filter((route): route is Extract<IntegrationRoute, `/pi/${string}`> => route.startsWith('/pi/'))
    .map((route) => ({ route, methods: route.endsWith('/commands') || route.endsWith('/status') ? ['GET'] as const : ['POST'] as const, policy: PI_INTEGRATION })),
  ...[...new Set(BROKER_INTEGRATION_ROUTES)]
    .filter((route): route is Extract<IntegrationRoute, `/omp/${string}`> => route.startsWith('/omp/'))
    .map((route) => ({ route, methods: route.endsWith('/commands') || route.endsWith('/status') ? ['GET'] as const : ['POST'] as const, policy: OMP_INTEGRATION })),
  ...[...new Set(BROKER_INTEGRATION_ROUTES)]
    .filter((route): route is Extract<IntegrationRoute, `/claude/${string}`> => route.startsWith('/claude/'))
    .map((route) => ({ route, methods: ['POST'] as const, policy: OWNER_ONLY })),
];

const MATCHED_POLICIES = [...BROKER_ROUTE_POLICIES, ...INTEGRATION_ROUTE_POLICIES]
  .map((entry) => ({ ...entry, matcher: routeMatcher(entry.route) }));

export function brokerRoutePolicy(path: string, method: string): PeerRoutePolicy | undefined {
  const normalizedMethod = method.toUpperCase();
  return MATCHED_POLICIES.find((entry) =>
    entry.methods.includes(normalizedMethod as HttpMethod) && entry.matcher.test(path))?.policy;
}

export function authorizeBrokerRoute(
  principal: RouteAuthorizationPrincipal,
  path: string,
  method: string,
): RouteAuthorizationDecision {
  if (principal?.kind === 'owner') return { allowed: true };
  const policy = brokerRoutePolicy(path, method);
  if (policy?.kind === 'public') return { allowed: true };
  if (!principal) return { allowed: false, status: 401, error: 'authenticated credential required' };
  if (!policy || policy.kind === 'owner-only') {
    return { allowed: false, status: 403, error: 'owner credential required' };
  }
  if (principal.kind === 'integration') {
    return policy.kind === 'integration' && policy.integration === principal.integration
      ? { allowed: true }
      : { allowed: false, status: 403, error: 'integration credential is not authorized for this route' };
  }
  if (policy.kind !== 'peer') {
    return { allowed: false, status: 403, error: 'peer credential is not authorized for this route' };
  }
  const allowed = 'allOf' in policy
    ? policy.allOf.every((role) => principal.roles.has(role))
    : policy.anyOf.some((role) => principal.roles.has(role));
  if (allowed) return { allowed: true };
  const roles = 'allOf' in policy ? policy.allOf : policy.anyOf;
  return {
    allowed: false,
    status: 403,
    error: `${roles.join(' + ')} role${roles.length === 1 ? '' : 's'} required`,
  };
}

function routeMatcher(route: string): RegExp {
  const source = route
    .split('{id}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}$`);
}
