// Isolated native API probe. Never uses the operator's Codex state or sends a turn.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(process.argv[2] ?? 'output/session-naming/native-codex');
mkdirSync(root, { recursive: true });
const child = spawn(process.env.CODEX_PROBE_BIN ?? 'codex', ['app-server', '--listen', 'stdio://'], {
  cwd: root, env: { ...process.env, CODEX_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
const pending = new Map();
let sequence = 0;
const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  const request = pending.get(frame.id);
  if (!request) return;
  pending.delete(frame.id);
  clearTimeout(request.timer);
  frame.error ? request.reject(frame.error) : request.resolve(frame.result);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
const attempt = async (method, params) => {
  try { return { ok: true, result: await rpc(method, params) }; }
  catch (error) { return { ok: false, error: error.message ?? error }; }
};
const result = {};
try {
  await rpc('initialize', { clientInfo: { name: 'cosyncing-naming-probe', version: '1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  const started = await rpc('thread/start', { cwd: root, historyMode: 'legacy' });
  const threadId = started.thread.id;
  const path = started.thread.path;
  result.start = { persisted: existsSync(path) };
  result.settings = await attempt('thread/settings/update', { threadId, approvalPolicy: 'never' });
  await rpc('thread/read', { threadId });
  result.afterSettings = existsSync(path);
  result.metadata = await attempt('thread/metadata/update', { threadId, gitInfo: { branch: started.thread.gitInfo?.branch ?? null } });
  await rpc('thread/read', { threadId });
  result.metadata = { ok: result.metadata.ok, error: result.metadata.error };
  result.afterMetadata = existsSync(path);
  if (result.afterMetadata) {
    const unnamedFork = await rpc('thread/fork', { threadId });
    await rpc('thread/read', { threadId: unnamedFork.thread.id });
    result.unnamedZeroTurnFork = { persisted: existsSync(unnamedFork.thread.path), name: unnamedFork.thread.name };
  }
  result.name = await attempt('thread/name/set', { threadId, name: 'Untitled session' });
  // A subsequent read is a protocol barrier after name/set's persistence side effect.
  await rpc('thread/read', { threadId });
  result.afterName = existsSync(path);
  result.emptyClear = await attempt('thread/name/set', { threadId, name: '' });
  result.nullClear = await attempt('thread/name/set', { threadId, name: null });
  const read = await rpc('thread/read', { threadId });
  result.nameAfterClear = read.thread?.name;
  const forked = await rpc('thread/fork', { threadId });
  await rpc('thread/read', { threadId: forked.thread.id });
  result.zeroTurnFork = { persisted: existsSync(forked.thread.path), name: forked.thread.name };
  const index = join(root, 'session_index.jsonl');
  result.index = existsSync(index) ? readFileSync(index, 'utf8').trim().split('\n').map((line) => {
    const row = JSON.parse(line); return { thread_name: row.thread_name };
  }) : [];
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
