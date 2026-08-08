/**
 * Pi native get_session_stats regression: fake JSON-RPC `pi` binary, no real Pi, no model.
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pi-stats-'));
const sessionsRoot = join(root, 'sessions');
const bin = join(root, 'pi');
const cwd = join(root, 'work');
const sessionFile = join(sessionsRoot, '2026-07-02_stats.jsonl');
mkdirSync(sessionsRoot, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'stats-session', timestamp: '2026-07-02T00:00:00.000Z', cwd }) + '\n');
writeFileSync(
  bin,
  `#!/usr/bin/env bun
function send(id, payload) {
  process.stdout.write(JSON.stringify({ type: 'response', id, ...payload }) + '\\n');
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += String(chunk);
  const lines = buffered.split('\\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === 'get_state') {
      send(req.id, { success: true, data: { sessionFile: process.argv[process.argv.indexOf('--session') + 1], sessionId: 'stats-session', model: { provider: 'fake', id: 'pi-fake', name: 'Pi Fake' } } });
    } else if (req.type === 'get_messages') {
      send(req.id, { success: true, data: { messages: [] } });
    } else if (req.type === 'get_session_stats') {
      send(req.id, { success: true, data: { tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: 0.04 }, contextWindow: 128000 } });
    } else if (req.type === 'abort') {
      send(req.id, { success: true, data: {} });
    } else {
      send(req.id, { success: true, data: {} });
    }
  }
});
process.stdin.resume();
`,
);
chmodSync(bin, 0o755);

try {
  process.env.COSYNCING_PI_BIN = bin;
  process.env.COSYNCING_PI_SESSIONS_ROOT = sessionsRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  const { PiAdapter } = await import('../../../../packages/typescript/adapters/pi/src/index.ts');
  const adapter = new PiAdapter({ brokerUrl: 'http://127.0.0.1:7734' });
  const id = Buffer.from(sessionFile, 'utf8').toString('base64url');
  const conn = await adapter.attach(id, 'resume');
  const history = await conn.getHistory();
  await conn.close();

  const stats = history.find((m: any) => m.type === 'metadata-update' && m.key === 'sessionStats') as any;
  const token = history.find((m: any) => m.type === 'token-count') as any;
  check('Pi stats maps to sessionStats metadata-update', stats?.value?.contextWindow === 128000, JSON.stringify(stats));
  check('Pi stats maps token fields to token-count', token?.input === 11 && token.output === 7 && token.cacheRead === 3 && token.cacheWrite === 2 && token.cost === 0.04, JSON.stringify(token));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
