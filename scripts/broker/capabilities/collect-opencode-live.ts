import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Text } from './source-lock.ts';
import { normalizeOpenCodeOpenApiEndpoints } from './opencode-openapi.ts';

const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : '';
const fixture = process.argv.includes('--fixture') ? process.argv[process.argv.indexOf('--fixture') + 1] : '';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '';
if ((!base && !fixture) || !out) throw new Error('usage: bun scripts/broker/capabilities/collect-opencode-live.ts (--base http://127.0.0.1:4096 | --fixture captures.json) --out output/capabilities/opencode/<version>/raw');

const endpoints = ['/global/health', '/doc', '/command', '/agent', '/provider'];
mkdirSync(out, { recursive: true });
const captures: Array<{ endpoint: string; file: string; text: string }> = [];
const fixtureData = fixture ? JSON.parse(await Bun.file(fixture).text()) : undefined;
for (const endpoint of endpoints) {
  let text: string;
  if (fixtureData) {
    if (!(endpoint in fixtureData)) throw new Error(`fixture is missing ${endpoint}`);
    text = JSON.stringify(fixtureData[endpoint]);
  } else {
    const res = await fetch(new URL(endpoint, base));
    text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const name = endpoint.replace(/^\//, '').replace(/\//g, '-') || 'root';
  const file = `${name}.json`;
  writeFileSync(join(out, file), text);
  captures.push({ endpoint, file, text });
}
const health = JSON.parse(captures.find((capture) => capture.endpoint === '/global/health')?.text ?? '{}');
const version = typeof health.version === 'string' && health.version ? health.version : 'unknown';
const lock = {
  schemaVersion: 1,
  agent: 'opencode',
  version,
  captured_at: new Date().toISOString(),
  sources: captures.map((capture) => ({
    id: `opencode-live-${capture.endpoint.replace(/^\//, '').replace(/\//g, '-') || 'root'}-${version}`,
    source_url: base ? new URL(capture.endpoint, base).toString() : fixture,
    local_command: base ? `fetch ${capture.endpoint}` : `fixture ${capture.endpoint}`,
    checksum: sha256Text(capture.text),
    trust_level: base ? 'local-live-api' : 'reviewed-seed',
  })),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(join(dirname(out), 'source-lock.json'), JSON.stringify(lock, null, 2) + '\n');
const docText = captures.find((capture) => capture.endpoint === '/doc')?.text;
if (docText) {
  const endpoints = normalizeOpenCodeOpenApiEndpoints(JSON.parse(docText));
  writeFileSync(join(dirname(out), 'endpoints.normalized.json'), JSON.stringify({ schemaVersion: 1, agent: 'opencode', version, endpoints }, null, 2) + '\n');
}
console.log(`wrote read-only OpenCode captures to ${out}`);
