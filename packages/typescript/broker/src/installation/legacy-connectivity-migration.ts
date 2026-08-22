import type { InstalledResourceRecord } from './install-state.ts';

/** Compatibility identifiers written by releases that managed Tailscale Serve. */
export const LEGACY_TAILSCALE_SETUP_FIELD = 'tailscaleServeRequested' as const;
export const LEGACY_TAILSCALE_RESOURCE_ID = 'tailscale-serve-https-root' as const;

export interface LegacyConnectivityMigration {
  changed: boolean;
  preservedTargets: string[];
}

/** Remove legacy intent without inspecting or changing the external route. */
export function withoutLegacyConnectivityIntent<T extends Record<string, unknown>>(state: T): T {
  const { [LEGACY_TAILSCALE_SETUP_FIELD]: _legacyIntent, ...rest } = state;
  return rest as T;
}

/** Relinquish old ownership receipts while retaining their targets for an operator notice. */
export function relinquishLegacyConnectivityReceipts(
  resources: readonly InstalledResourceRecord[],
): { resources: InstalledResourceRecord[]; migration: LegacyConnectivityMigration } {
  const preservedTargets = resources
    .filter((resource) => resource.id === LEGACY_TAILSCALE_RESOURCE_ID)
    .map((resource) => resource.target);
  return {
    resources: resources.filter((resource) => resource.id !== LEGACY_TAILSCALE_RESOURCE_ID),
    migration: { changed: preservedTargets.length > 0, preservedTargets },
  };
}

export function hasLegacyConnectivityIntent(state: Record<string, unknown>): boolean {
  return state[LEGACY_TAILSCALE_SETUP_FIELD] === true;
}
