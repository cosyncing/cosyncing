/**
 * The cross-adapter session-truth manifest (`../session-truth-conformance.json`), fail closed: every
 * adapter class the production broker registers resolves every lane of the matrix with coverage or a
 * reviewed exclusion, and every coverage reference names a task that still runs in a CI suite.
 * It reads `runtime.ts` and the suite roster on purpose: that is the only way an adapter added
 * later cannot escape the manifest. Pure file reads, safe on Windows.
 */
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) throw new Error(`${label}${extra ? ` (${extra})` : ''}`);
};

test('every production adapter resolves every session-truth lane, and each reference names a CI task', async () => {
  // `turn-attention`: a turn the adapter runs live opens with one live `running` run-summary and
  // closes with one terminal under the same key, and a turn that finished before the connection saw
  // it (priming, replay, catch-up) opens nothing, so the broker raises exactly one Turn finished or
  // Turn failed per live turn and none on attach.
  const CONFORMANCE_LANES = ['native-identity', 'terminal-authority', 'history-live-chronology', 'replacement', 'hub-authority', 'turn-attention'];

  // The production roster, scraped from runtime.ts rather than restated: a drift between this
  // regex and the real registration call shape must fail, never match zero and pass. An
  // indirect registration (`const adapter = new FooAdapter(); registry.register(adapter);`)
  // matches only the total count below, so the two counts diverge and the phase fails closed
  // instead of letting an adapter escape the manifest.
  const runtimeSource = readFileSync(resolve(import.meta.dir, '../../src/runtime/runtime.ts'), 'utf8');
  const registered = [...runtimeSource.matchAll(/registry\.register\(new\s+(\w+Adapter)\b/g)].map((match) => match[1]!);
  const registerCalls = [...runtimeSource.matchAll(/registry\.register\(/g)].length;
  check('A the production adapter roster parses to at least one registered adapter class',
    registered.length > 0, `registered=${registered.join(',')}`);
  check('A every registry.register call uses the supported direct-constructor form',
    registerCalls === registered.length,
    `registerCalls=${registerCalls} directConstructor=${registered.length}`);
  check('A registered adapter class names are unique',
    new Set(registered).size === registered.length,
    `duplicates=${registered.filter((name, index) => registered.indexOf(name) !== index).join(',') || '(none)'}`);

  interface ManifestExclusion { reason?: string; reviewed?: string }
  interface ManifestEntry {
    coverage?: Record<string, string[]>;
    exclusions?: Record<string, ManifestExclusion>;
  }
  interface Manifest {
    schemaVersion?: number;
    lanes?: string[];
    adapters?: Record<string, ManifestEntry>;
  }
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../session-truth-conformance.json'), 'utf8'),
  ) as Manifest;
  check('A the manifest declares the supported schema version and the exact conformance lane matrix',
    manifest.schemaVersion === 1
    && Array.isArray(manifest.lanes)
    && [...manifest.lanes].sort().join(',') === [...CONFORMANCE_LANES].sort().join(','),
    `schemaVersion=${String(manifest.schemaVersion)} lanes=${(manifest.lanes ?? []).join(',')}`);

  const lanes = manifest.lanes ?? [];
  const entries = Object.keys(manifest.adapters ?? {});
  check('A every production-registered adapter class has a manifest entry',
    registered.every((name) => entries.includes(name)),
    `missing=${registered.filter((name) => !entries.includes(name)).join(',') || '(none)'}`);
  check('A every manifest entry names a production-registered adapter class',
    entries.every((name) => registered.includes(name)),
    `stray=${entries.filter((name) => !registered.includes(name)).join(',') || '(none)'}`);

  // Coverage is only real while the named task still runs in a CI suite.
  const { suites } = await import('../../../../../scripts/ci/suites.ts');
  const subSuiteIds = new Set(suites.flatMap((suite) => suite.tasks.map((task) => task.id)));
  check('A the CI task roster loads from the suite manifest',
    subSuiteIds.size > 0, `count=${subSuiteIds.size}`);

  const unresolved: string[] = [];
  const unknownSuites: string[] = [];
  const badExclusions: string[] = [];
  for (const [name, entry] of Object.entries(manifest.adapters ?? {})) {
    for (const lane of lanes) {
      const coverage = entry.coverage?.[lane] ?? [];
      const exclusion = entry.exclusions?.[lane];
      if (coverage.length === 0 && !exclusion) unresolved.push(`${name}:${lane}`);
      for (const suite of coverage) {
        if (!subSuiteIds.has(suite)) unknownSuites.push(`${name}:${lane}→${suite}`);
      }
      if (exclusion && (!String(exclusion.reason ?? '').trim() || !String(exclusion.reviewed ?? '').trim())) {
        badExclusions.push(`${name}:${lane}`);
      }
    }
  }
  check('A every adapter resolves every lane with coverage or a reviewed exclusion',
    unresolved.length === 0, unresolved.slice(0, 6).join(' | '));
  check('A every coverage reference names a task in a CI suite',
    unknownSuites.length === 0, unknownSuites.slice(0, 6).join(' | '));
  check('A every exclusion carries a non-empty reason and a reviewed date',
    badExclusions.length === 0, badExclusions.slice(0, 6).join(' | '));
});
