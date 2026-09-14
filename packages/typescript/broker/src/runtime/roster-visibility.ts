/**
 * Which agents — and therefore which sessions — one client is allowed to see.
 *
 * The roster decodes as ONE list on the client, so an agent carrying a value an
 * older client cannot parse costs it EVERY agent rather than just that row. Each
 * client is therefore sent only the agents it declared it can decode.
 *
 * This module exists because that decision has to be made in exactly one place
 * and then applied THREE times, and the three used to disagree:
 *
 *   1. the agent list      — filtered from the start;
 *   2. the session roster  — was not, so a client that was told an agent does
 *                            not exist still received its sessions: rows for a
 *                            tool it has no capabilities for, cannot attach to,
 *                            and cannot explain;
 *   3. the roster CACHE    — keyed by time window alone, so once (2) is fixed
 *                            two clients with different visibility would share
 *                            one cached body and one ETag, and each could be
 *                            served the other's projection or a 304 for it.
 *
 * The cache key is derived from the visible set rather than from the revision
 * the client sent. Clients at different revisions that can see the same agents
 * legitimately share a representation, and — the part that matters for a cache —
 * the number of distinct keys is bounded by the number of registered adapters
 * instead of by whatever numbers clients choose to send.
 */

/** The only thing this module needs to know about a backend. */
export interface RosterVisibilityBackend {
  readonly id: string;
  readonly minimumClientRevision?: number;
}

export interface RosterVisibility {
  /** Agent ids this client may be shown. */
  readonly tools: ReadonlySet<string>;
  /** Stable, order-independent identity of this projection, for cache keys. */
  readonly projectionKey: string;
}

/**
 * A backend with no declared floor is visible to everyone, which is the correct
 * reading of "this row has always been decodable".
 */
export function rosterVisibility(
  backends: readonly RosterVisibilityBackend[],
  clientRevision: number,
): RosterVisibility {
  const tools = new Set<string>();
  for (const backend of backends) {
    if ((backend.minimumClientRevision ?? 0) <= clientRevision) tools.add(backend.id);
  }
  // Sorted, so two requests that resolve to the same set always produce the same
  // key regardless of registration order.
  return { tools, projectionKey: [...tools].sort().join(',') };
}

/** Drop sessions belonging to an agent this client was not shown. */
export function visibleSessions<T extends { tool: string }>(
  sessions: readonly T[],
  visibility: RosterVisibility,
): T[] {
  return sessions.filter((session) => visibility.tools.has(session.tool));
}

/** The roster representation cache key: one entry per window AND projection. */
export function rosterRepresentationKey(windowKey: string, visibility: RosterVisibility): string {
  return `${windowKey}|${visibility.projectionKey}`;
}

/**
 * Replace ONE backend's slice of a served roster snapshot with the rows its
 * discovery leg just finished, leaving every other backend's rows untouched.
 *
 * Wholesale replacement rather than a union, because a completed leg is
 * authoritative for its own tool: a session it no longer reports is gone, and
 * merging by id would resurrect it. That is only sound because the caller
 * publishes a leg exclusively when it COMPLETED, and because every row is
 * guaranteed to be filed under the backend that produced it -- with a misfiled
 * row this would delete another backend's sessions and adopt rows it never had.
 */
export function mergeLegRows<T extends { tool: string }>(
  sessions: readonly T[],
  backendId: string,
  rows: readonly T[],
): T[] {
  return [...sessions.filter((session) => session.tool !== backendId), ...rows];
}
