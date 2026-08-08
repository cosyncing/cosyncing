import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, type AgentId } from './scenarios.ts';
import {
  EVIDENCE_LEVELS,
  RETIRED_POC_UI_TRACES,
  TAXONOMY_FUNCTIONS,
  TRACE_MANIFEST,
  type TaxonomyFunction,
} from './trace-manifest.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const validFunctions = new Set<string>(TAXONOMY_FUNCTIONS);
const validEvidence = new Set<string>(EVIDENCE_LEVELS);
const validAgents = new Set<string>(AGENTS);
let failed = 0;

function fail(msg: string): void {
  failed++;
  console.error(`✗ ${msg}`);
}

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

function agentsFor(agents: AgentId[] | 'all'): AgentId[] {
  return agents === 'all' ? [...AGENTS] : agents;
}

const seenFiles = new Set<string>();
const coveredFns = new Set<TaxonomyFunction>();
const coveredByAgent = new Map<AgentId, Set<TaxonomyFunction>>(AGENTS.map((a) => [a, new Set<TaxonomyFunction>()]));

for (const entry of TRACE_MANIFEST) {
  if (seenFiles.has(entry.file)) fail(`duplicate manifest entry: ${entry.file}`);
  seenFiles.add(entry.file);
  if (!existsSync(join(ROOT, entry.file))) fail(`manifest file does not exist: ${entry.file}`);
  if (!entry.coverage.length) fail(`manifest entry has no coverage: ${entry.file}`);
  if (entry.capabilityIds != null) {
    if (!Array.isArray(entry.capabilityIds)) fail(`${entry.file} capabilityIds must be an array`);
    else {
      const seenCapabilityIds = new Set<string>();
      for (const id of entry.capabilityIds) {
        if (typeof id !== 'string' || !id) fail(`${entry.file} has invalid capability id`);
        if (seenCapabilityIds.has(id)) fail(`${entry.file} repeats capability id ${id}`);
        seenCapabilityIds.add(id);
      }
    }
  }
  if (entry.nativeVersion != null && (typeof entry.nativeVersion !== 'string' || !entry.nativeVersion)) {
    fail(`${entry.file} nativeVersion must be a non-empty string`);
  }
  if (entry.sourceLockIds != null) {
    if (!Array.isArray(entry.sourceLockIds)) fail(`${entry.file} sourceLockIds must be an array`);
    else {
      for (const id of entry.sourceLockIds) {
        if (typeof id !== 'string' || !id) fail(`${entry.file} has invalid sourceLock id`);
      }
    }
  }
  for (const c of entry.coverage) {
    if (!validFunctions.has(c.fn)) fail(`${entry.file} uses unknown taxonomy function ${c.fn}`);
    else coveredFns.add(c.fn);
    if (!validEvidence.has(c.level)) fail(`${entry.file} uses unknown evidence level ${c.level}`);
    for (const agent of agentsFor(c.agents)) {
      if (!validAgents.has(agent)) fail(`${entry.file} uses unknown agent ${agent}`);
      coveredByAgent.get(agent)?.add(c.fn);
    }
  }
}

for (const fn of TAXONOMY_FUNCTIONS) {
  if (!coveredFns.has(fn)) fail(`no manifest entry covers ${fn}`);
}

// A retired trace must be gone from the manifest and still present on disk. Cited, it would have the support
// matrix rest on evidence nothing can produce; deleted, the retirement record would point at nothing and the
// broker-side half these keep for the /cosy/ migration would be lost with it.
for (const retired of RETIRED_POC_UI_TRACES) {
  if (seenFiles.has(retired)) fail(`retired trace is still claimed as evidence: ${retired}`);
  if (!existsSync(join(ROOT, retired))) fail(`retired trace file does not exist: ${retired}`);
  // Reaching the refusal is what matters, not where it is written: most of these reach it through
  // `pyOpenOnlySession` or `spawnPermissionClickDriver`, which is the same chokepoint that made them dead.
  const source = readFileSync(join(ROOT, retired), 'utf8');
  if (!/refuseRetiredPocUiTrace|pyOpenOnlySession|spawnPermissionClickDriver/.test(source)) {
    fail(`retired trace does not reach the retirement refusal: ${retired}`);
  }
}

for (const agent of AGENTS) {
  const count = coveredByAgent.get(agent)?.size ?? 0;
  if (count < 10) fail(`${agent} has only ${count} taxonomy functions linked to trace evidence`);
}

const traceReadme = readFileSync(join(ROOT, 'scripts/broker/tests_traces/README.md'), 'utf8');
if (!traceReadme.includes('check-trace-manifest.ts')) fail('trace README does not document check-trace-manifest.ts');
if (!traceReadme.includes('trace-manifest.ts')) fail('trace README does not identify the machine-readable taxonomy');

if (failed) {
  console.error(`\nFAIL: ${failed} trace manifest check(s) failed.`);
  process.exit(1);
}

ok(`${TRACE_MANIFEST.length} manifest entries validated`);
ok(`${RETIRED_POC_UI_TRACES.length} retired PoC UI traces are uncited and refuse to run`);
ok(`${TAXONOMY_FUNCTIONS.length} taxonomy functions have at least one trace link`);
for (const agent of AGENTS) ok(`${agent} links ${coveredByAgent.get(agent)?.size ?? 0} functions`);
ok('optional capability metadata fields validated');
console.log('\nPASS');
