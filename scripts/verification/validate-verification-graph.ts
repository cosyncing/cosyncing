#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadVerificationGraph,
  validateFixtureIsolationSources,
  validateVerificationGraph,
} from './verification-graph.ts';

const ROOT = resolve(import.meta.dir, '../..');
const OUTPUT = join(ROOT, 'output', 'verification');
const graph = loadVerificationGraph(ROOT);
const errors = [
  ...validateVerificationGraph(graph, ROOT),
  ...validateFixtureIsolationSources(ROOT),
].sort();
mkdirSync(OUTPUT, { recursive: true });
writeFileSync(
  join(OUTPUT, 'inventory.json'),
  `${JSON.stringify(graph, null, 2)}\n`,
);
writeFileSync(
  join(OUTPUT, 'validation.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    inventoryId: graph.inventoryId,
    status: errors.length === 0 ? 'pass' : 'fail',
    errors,
  }, null, 2)}\n`,
);
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
console.log(
  `PASS: ${graph.claims.length} claims have one owner across `
    + `${graph.gates.length} release gates; inventory=${join(OUTPUT, 'inventory.json')}`,
);
