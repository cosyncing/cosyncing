// Compare the installed Pi session picker's native metadata with the adapter on isolated files.
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(process.argv[2] ?? 'output/session-naming/native-pi');
const executable = Bun.which('pi');
if (!executable) throw new Error('Install Pi before running the native naming probe.');
const nativeRoot = process.env.PI_PROBE_PACKAGE_ROOT ?? resolve(dirname(realpathSync(executable)), '../..');
const { SessionManager } = await import(pathToFileURL(join(nativeRoot, 'dist/core/session-manager.js')).href);
const sessions = join(root, 'sessions');
const directory = join(sessions, 'workspace');
mkdirSync(directory, { recursive: true });
process.env.COSYNCING_PI_AGENT_DIR = root;
process.env.COSYNCING_PI_SESSIONS_ROOT = sessions;
process.env.COSYNCING_PI_BRIDGE_AUTOINSTALL = '0';
const { PiAdapter } = await import('../../packages/typescript/adapters/pi/src/implementation.ts');
const adapter = new PiAdapter();
const id = randomUUID();
const file = join(directory, `2026-10-25T00-00-00_${id}.jsonl`);
const rowId = Buffer.from(file).toString('base64url');
const append = (row: unknown) => appendFileSync(file, `${JSON.stringify(row)}\n`);
const user = (text: string) => append({ type: 'message', id: randomUUID().slice(0, 8), parentId: null,
  timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } });
const name = (value: string) => append({ type: 'session_info', id: randomUUID().slice(0, 8), parentId: null,
  timestamp: new Date().toISOString(), name: value });
const results: unknown[] = [];
let previousActivity: number | undefined;
async function compare(step: string): Promise<void> {
  const native = (await SessionManager.list(root, directory)).find((session: any) => session.id === id);
  const discovered = (await adapter.discoverSessions()).find((session) => session.id === rowId);
  const attached = await adapter.attach(rowId, 'observe');
  try {
    const nativeTitle = native?.name ?? native?.firstMessage ?? '';
    if (!discovered || discovered.title !== nativeTitle || attached.info.title !== nativeTitle) throw new Error(`${step}: title mismatch`);
    if (step !== 'first prompt' && step !== 'follow-up' && discovered.updatedAt !== previousActivity) throw new Error(`${step}: rename changed conversation activity`);
    previousActivity = discovered.updatedAt;
    results.push({ step, title: nativeTitle, updatedAt: discovered.updatedAt, discovery: true, attach: true });
  } finally { await attached.close(); }
}
writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`);
user('coordination/relay/2026-10-24/r62_A.md');
await compare('first prompt');
user('A later prompt');
await compare('follow-up');
name('Native / 名称.md');
await compare('native rename');
append({ type: 'custom', id: randomUUID().slice(0, 8), parentId: null, timestamp: new Date().toISOString(), data: 'x'.repeat(256_000) });
await compare('large output');
name('');
await compare('native clear');
writeFileSync(join(root, 'result.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
