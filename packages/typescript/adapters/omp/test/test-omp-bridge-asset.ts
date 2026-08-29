/**
 * omp bridge asset: the shared extension source with the broker route family rewritten to
 * `/omp/bridge`, derived at module load so it can never drift from the pi asset's logic. Guards
 * both the rewrite and the guards the shared source must carry (C6 event subscription, resource
 * loader). Fixture bytes only — no broker, no omp.
 */
export {};
import { createHash } from 'node:crypto';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  piBridgeEmbeddedSourceForDialect,
} from '@cosyncing/pi-engine';
import { OMP_BRIDGE_EMBEDDED_SHA256, OMP_BRIDGE_EMBEDDED_SOURCE } from '../src/bridge-asset.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

check(
  'omp bridge asset calls the /omp/bridge route family only',
  OMP_BRIDGE_EMBEDDED_SOURCE.includes('/omp/bridge') && !OMP_BRIDGE_EMBEDDED_SOURCE.includes('/pi/bridge'),
);
check(
  'pi bridge asset keeps the /pi/bridge route family only',
  PI_BRIDGE_EMBEDDED_SOURCE.includes('/pi/bridge') && !PI_BRIDGE_EMBEDDED_SOURCE.includes('/omp/bridge'),
);
check(
  'omp bridge asset is exactly the dialect rewrite of the pi asset',
  OMP_BRIDGE_EMBEDDED_SOURCE === piBridgeEmbeddedSourceForDialect({ routePrefix: '/omp/bridge', toolId: 'omp' }),
);
// The integration credential is scoped per tool: the omp asset must present omp's own record
// (secrets/omp-integration.json, kind 'omp-bridge', COSYNCING_OMP_INTEGRATION_* overrides) — the
// broker's /omp/bridge token guard accepts only that credential (see the spec's C8 decision).
check(
  'omp bridge asset uses the omp-scoped integration credential',
  OMP_BRIDGE_EMBEDDED_SOURCE.includes('COSYNCING_OMP_INTEGRATION_TOKEN')
    && OMP_BRIDGE_EMBEDDED_SOURCE.includes('COSYNCING_OMP_INTEGRATION_FILE')
    && OMP_BRIDGE_EMBEDDED_SOURCE.includes('omp-integration.json')
    && OMP_BRIDGE_EMBEDDED_SOURCE.includes(`kind !== 'omp-bridge'`)
    && !OMP_BRIDGE_EMBEDDED_SOURCE.includes('COSYNCING_PI_INTEGRATION_TOKEN')
    && !OMP_BRIDGE_EMBEDDED_SOURCE.includes('pi-integration.json')
    && !OMP_BRIDGE_EMBEDDED_SOURCE.includes('pi-bridge'),
);
check(
  'pi bridge asset keeps the pi-scoped integration credential',
  PI_BRIDGE_EMBEDDED_SOURCE.includes('COSYNCING_PI_INTEGRATION_TOKEN')
    && PI_BRIDGE_EMBEDDED_SOURCE.includes('pi-integration.json')
    && PI_BRIDGE_EMBEDDED_SOURCE.includes(`kind !== 'pi-bridge'`),
);
check(
  'omp bridge asset stamps omp event-source labels',
  OMP_BRIDGE_EMBEDDED_SOURCE.includes(`source: 'omp-bridge'`)
    && OMP_BRIDGE_EMBEDDED_SOURCE.includes('omp-bridge-history'),
);
check(
  'omp bridge asset stamps omp run-summary keys',
  OMP_BRIDGE_EMBEDDED_SOURCE.includes('omp:run:')
    && !OMP_BRIDGE_EMBEDDED_SOURCE.includes('pi:run:'),
);
check(
  'omp bridge sha256 stamps the rewritten bytes',
  OMP_BRIDGE_EMBEDDED_SHA256 === sha256(OMP_BRIDGE_EMBEDDED_SOURCE),
);
check(
  'pi bridge sha256 stamps the pi bytes and differs from omp',
  PI_BRIDGE_EMBEDDED_SHA256 === sha256(PI_BRIDGE_EMBEDDED_SOURCE)
    && PI_BRIDGE_EMBEDDED_SHA256 !== OMP_BRIDGE_EMBEDDED_SHA256,
);

// The C6 guard: omp does not emit model_select/thinking_level_select and both runtimes' `on()` is
// an unvalidated Map insert, so the subscription sits behind a try/catch. Both embedded assets are
// the same source, so both must carry it.
for (const [label, source] of [['pi', PI_BRIDGE_EMBEDDED_SOURCE], ['omp', OMP_BRIDGE_EMBEDDED_SOURCE]] as const) {
  check(
    `${label} bridge asset carries the model_select subscription guard`,
    source.includes("pi.on('model_select'") && source.includes('unvalidated Map insert'),
  );
  check(
    `${label} bridge asset keeps the resource loader guard`,
    source.includes('ctx?.resourceLoader?.getSkills?.()'),
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
