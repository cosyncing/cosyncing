import { createHash } from 'node:crypto';
import { piBridgeEmbeddedSourceForDialect } from '@cosyncing/pi-engine/bridge-asset';
import { OMP_DIALECT } from './dialect.ts';

/**
 * The omp bridge asset: the pi extension source rewritten for the omp dialect — the `/omp/bridge`
 * route family AND omp's own integration credential (`COSYNCING_OMP_INTEGRATION_TOKEN`,
 * `COSYNCING_OMP_INTEGRATION_FILE`, `secrets/omp-integration.json`, kind `omp-bridge`) and
 * event-source labels. The bytes are derived at module load, so the omp asset can never drift from
 * the pi asset's logic; only its dialect constants differ.
 */
export const OMP_BRIDGE_EMBEDDED_SOURCE = piBridgeEmbeddedSourceForDialect({
  routePrefix: OMP_DIALECT.bridgeRoutePrefix,
  toolId: OMP_DIALECT.toolId,
  // Resolved inside the calling OMP process, so hello attests the native package that actually
  // loaded the extension rather than merely echoing the broker's configured executable.
  nativeVersionModule: '@oh-my-pi/pi-utils/dirs',
});
export const OMP_BRIDGE_EMBEDDED_SHA256 = createHash('sha256').update(OMP_BRIDGE_EMBEDDED_SOURCE).digest('hex');
