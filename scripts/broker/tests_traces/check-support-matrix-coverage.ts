import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS } from './scenarios.ts';
import { renderSupportMatrixBlock } from './render-support-matrix.ts';
import {
  FULL_SUPPORT_MIN_LEVEL,
  PARTIAL_SUPPORT_MIN_LEVEL,
  SUPPORT_MATRIX_CLAIMS,
  type SupportClaim,
} from './support-matrix-claims.ts';
import { TRACE_MANIFEST, TAXONOMY_FUNCTIONS, type EvidenceLevel, type TaxonomyFunction } from './trace-manifest.ts';

const orderedLevels: Exclude<EvidenceLevel, 'D'>[] = ['L0', 'L1', 'L2', 'L3'];
const rank = new Map<EvidenceLevel, number>(orderedLevels.map((level, i) => [level, i]));
let failed = 0;

function key(agent: string, fn: TaxonomyFunction): string {
  return `${agent}:${fn}`;
}

function agentsFor(agents: readonly string[] | 'all'): string[] {
  return agents === 'all' ? [...AGENTS] : [...agents];
}

function requiredLevel(claim: SupportClaim): EvidenceLevel | null {
  if (claim.support === 'n/a') return null;
  if (claim.requiredLevel) return claim.requiredLevel;
  if (claim.support === 'full') return FULL_SUPPORT_MIN_LEVEL[claim.fn];
  return PARTIAL_SUPPORT_MIN_LEVEL[claim.fn];
}

function satisfies(levels: Set<EvidenceLevel> | undefined, required: EvidenceLevel): boolean {
  if (!levels?.size) return false;
  if (required === 'D') return levels.has('D');
  const min = rank.get(required);
  if (min == null) return false;
  for (const level of levels) {
    if (level === 'D') continue;
    const got = rank.get(level);
    if (got != null && got >= min) return true;
  }
  return false;
}

function levelText(levels: Set<EvidenceLevel> | undefined): string {
  if (!levels?.size) return '-';
  return [...levels].sort((a, b) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1) || a.localeCompare(b)).join(',');
}

const evidence = new Map<string, Set<EvidenceLevel>>();
for (const entry of TRACE_MANIFEST) {
  for (const c of entry.coverage) {
    for (const agent of agentsFor(c.agents)) {
      const k = key(agent, c.fn);
      if (!evidence.has(k)) evidence.set(k, new Set());
      evidence.get(k)!.add(c.level);
    }
  }
}

const knownCapabilities = new Set<string>();
let adapterRefCount = 0;

function validateAdapterRef(manifestPath: string, capabilityId: string, ref: unknown): void {
  if (typeof ref !== 'string' || !ref) {
    failed++;
    console.error(`FAIL ${manifestPath} ${capabilityId} has an invalid adapterRef`);
    return;
  }
  adapterRefCount++;
  if (/:[0-9]+(?:\b|$)/.test(ref)) {
    failed++;
    console.error(`FAIL ${manifestPath} ${capabilityId} uses a line-number adapterRef: ${ref}`);
  }
  const sourcePath = ref.match(/^([A-Za-z0-9_./-]+)(?:\s+\(|:[^/]|$)/)?.[1];
  if (!sourcePath || !existsSync(sourcePath)) {
    failed++;
    console.error(`FAIL ${manifestPath} ${capabilityId} references a missing adapter source: ${ref}`);
  }
}

function loadCapabilityIdsFromJson(path: string): void {
  if (!existsSync(path)) return;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  for (const cap of parsed.capabilities ?? []) {
    if (typeof cap?.id === 'string') knownCapabilities.add(cap.id);
    for (const ref of cap?.adapterRefs ?? []) {
      validateAdapterRef(path, String(cap?.id ?? '<unknown>'), ref);
    }
  }
  for (const gap of parsed.openGaps ?? []) {
    if (typeof gap?.capabilityId === 'string') knownCapabilities.add(gap.capabilityId);
    if (typeof gap?.id === 'string') knownCapabilities.add(gap.id);
  }
  for (const gap of parsed.blocked ?? []) {
    if (typeof gap?.capabilityId === 'string') knownCapabilities.add(gap.capabilityId);
    if (typeof gap?.id === 'string') knownCapabilities.add(gap.id);
  }
}

const capabilityManifestDir = 'scripts/broker/capabilities/manifests';
if (existsSync(capabilityManifestDir)) {
  for (const name of readdirSync(capabilityManifestDir)) {
    if (name.endsWith('.json')) loadCapabilityIdsFromJson(join(capabilityManifestDir, name));
  }
}
loadCapabilityIdsFromJson('scripts/broker/capabilities/fixtures/opencode/discovered.seed.json');
loadCapabilityIdsFromJson('output/capabilities/opencode/fixture/gap-report.json');

const seenClaims = new Set<string>();
let capabilityRefCount = 0;
for (const claim of SUPPORT_MATRIX_CLAIMS) {
  const k = key(claim.agent, claim.fn);
  if (seenClaims.has(k)) {
    failed++;
    console.error(`FAIL duplicate support claim: ${k}`);
    continue;
  }
  seenClaims.add(k);
  if (claim.capabilityIds != null) {
    if (!Array.isArray(claim.capabilityIds)) {
      failed++;
      console.error(`FAIL ${k} capabilityIds must be an array`);
    } else {
      const seen = new Set<string>();
      for (const id of claim.capabilityIds) {
        capabilityRefCount++;
        if (typeof id !== 'string' || !id) {
          failed++;
          console.error(`FAIL ${k} has invalid capability id`);
        } else if (seen.has(id)) {
          failed++;
          console.error(`FAIL ${k} repeats capability id ${id}`);
        } else if (!knownCapabilities.has(id)) {
          failed++;
          console.error(`FAIL ${k} references unknown capability id ${id}`);
        }
        seen.add(id);
      }
    }
  }
  if (claim.reviewedNativeVersions != null) {
    if (typeof claim.reviewedNativeVersions !== 'object' || Array.isArray(claim.reviewedNativeVersions)) {
      failed++;
      console.error(`FAIL ${k} reviewedNativeVersions must be an object`);
    } else {
      for (const [agent, version] of Object.entries(claim.reviewedNativeVersions)) {
        if (!AGENTS.includes(agent as any) || typeof version !== 'string' || !version) {
          failed++;
          console.error(`FAIL ${k} has invalid reviewedNativeVersions entry ${agent}:${String(version)}`);
        }
      }
    }
  }
}

for (const agent of AGENTS) {
  for (const fn of TAXONOMY_FUNCTIONS) {
    const k = key(agent, fn);
    if (!seenClaims.has(k)) {
      failed++;
      console.error(`FAIL missing support claim: ${k}`);
    }
  }
}

console.log('-- Support matrix coverage --');
for (const claim of SUPPORT_MATRIX_CLAIMS) {
  const req = requiredLevel(claim);
  const levels = evidence.get(key(claim.agent, claim.fn));
  if (!req) {
  console.log(`SKIP ${claim.agent} ${claim.fn} n/a - ${claim.summary}`);
    continue;
  }
  const ok = satisfies(levels, req);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${claim.agent} ${claim.fn} ${claim.support} requires ${req}; has ${levelText(levels)} - ${claim.summary}`);
  if (!ok) failed++;
}

if (failed) {
  console.error(`\nFAIL: ${failed} support-matrix coverage issue(s).`);
  process.exit(1);
}

const matrixPath = 'docs/protocol/adapter-support.md';
const matrixDoc = readFileSync(matrixPath, 'utf8');
const begin = '<!-- BEGIN GENERATED SUPPORT MATRIX -->';
const end = '<!-- END GENERATED SUPPORT MATRIX -->';
const start = matrixDoc.indexOf(begin);
const stop = matrixDoc.indexOf(end);
if (start < 0 || stop < 0 || stop <= start) {
  console.error(`\nFAIL: ${matrixPath} is missing generated support matrix markers.`);
  process.exit(1);
}
const actual = matrixDoc.slice(start + begin.length, stop).trim();
const expected = renderSupportMatrixBlock().trim();
if (actual !== expected) {
  console.error(`\nFAIL: ${matrixPath} generated support matrix is stale.`);
  console.error('Run: bun run scripts/broker/tests_traces/render-support-matrix.ts --write');
  process.exit(1);
}
console.log(`✓ generated support matrix block matches ${matrixPath}`);
console.log(`✓ ${capabilityRefCount} capability references validated`);
console.log(`✓ ${adapterRefCount} adapter source references validated`);

console.log('\nPASS');
