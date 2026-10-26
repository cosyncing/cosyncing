// A repeatable, offline retention/cost measurement; generated fixtures stay under output/.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionTitleCache } from '../../packages/typescript/adapter-api/src/session-title.ts';

const root = resolve(process.argv[2] ?? 'output/session-naming/measurement');
mkdirSync(root, { recursive: true });
const file = join(root, 'transcript.jsonl');
const count = Number(process.env.NAMING_MEASURE_ROWS ?? 320);
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('NAMING_MEASURE_ROWS must be between 1 and 10000.');
const payload = `${JSON.stringify({ type: 'output', text: 'x'.repeat(64 * 1024) })}\n`;
writeFileSync(file, `${JSON.stringify({ type: 'prompt', text: 'Stable first prompt' })}\n`);
for (let index = 0; index < count; index++) appendFileSync(file, payload);
appendFileSync(file, `${JSON.stringify({ type: 'title', title: 'Native / 名称.md' })}\n`);
let decoded = 0;
const cache = new SessionTitleCache<{ title?: string; offset?: number }>(() => ({}), (row, facts, offset) => {
  decoded++;
  if (row.type === 'title' && offset >= (facts.offset ?? -1)) { facts.title = row.title; facts.offset = offset; }
}, undefined, { tail: true });
const results: unknown[] = [];
async function measure(step: string, reads = 1): Promise<boolean> {
  const before = decoded;
  const started = performance.now();
  let title: string | undefined;
  let complete = false;
  let headThrough = 0;
  for (let index = 0; index < reads; index++) {
    const result = await cache.readResult(file);
    title = result.facts.title;
    complete = result.complete;
    headThrough = result.coverage.headThrough;
  }
  results.push({ step, reads, ms: Math.round((performance.now() - started) * 1000) / 1000, decodedRows: decoded - before, title, complete, headThrough });
  return complete;
}
let complete = await measure('cold');
for (let pass = 1; !complete && pass <= 128; pass++) complete = await measure(`catch-up-${pass}`);
if (!complete) throw new Error('Title backlog did not complete within 128 passes.');
await measure('unchanged', 100);
appendFileSync(file, `${JSON.stringify({ type: 'output', text: 'follow-up' })}\n`);
await measure('append');
appendFileSync(file, `${JSON.stringify({ type: 'title', title: '' })}\n`);
await measure('clear');
let promptDecoded = 0;
const promptCache = new SessionTitleCache<{ prompt?: string }>(() => ({}), (row, facts) => {
  promptDecoded++;
  if (row.type === 'prompt') facts.prompt = row.text;
}, undefined, { stopWhen: (facts) => facts.prompt !== undefined });
const started = performance.now();
const prompt = (await promptCache.read(file)).prompt;
appendFileSync(file, payload);
for (let index = 0; index < 100; index++) await promptCache.read(file);
if (prompt !== 'Stable first prompt' || promptDecoded !== 1) throw new Error('First-prompt retention scanned beyond the first prompt.');
results.push({ step: 'first-prompt-cold-and-100-appended-reads', decodedRows: promptDecoded, prompt,
  ms: Math.round((performance.now() - started) * 1000) / 1000 });
writeFileSync(join(root, 'result.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
