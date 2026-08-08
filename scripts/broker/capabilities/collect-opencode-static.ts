import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const fixture = process.argv.includes('--fixture')
  ? process.argv[process.argv.indexOf('--fixture') + 1]
  : join(ROOT, 'scripts/broker/capabilities/fixtures/opencode/discovered.seed.json');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'output/capabilities/opencode/fixture/discovered.capabilities.json');
if (!fixture || !out) throw new Error('usage: bun scripts/broker/capabilities/collect-opencode-static.ts [--fixture path] [--out path]');
mkdirSync(dirname(out), { recursive: true });
copyFileSync(fixture, out);
console.log(`wrote ${out}`);
