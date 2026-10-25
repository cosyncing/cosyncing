// Installed Codex against a local Responses fixture: real native turns, no credentials or model cost.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const root = resolve(process.argv[2] ?? 'output/session-naming/native-codex-conversation');
mkdirSync(root, { recursive: true });
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as { model?: string };
  const id = `resp_naming_${++requests}`;
  const item = { id: `msg_naming_${requests}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Native naming probe reply.', annotations: [] }] };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const frames = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Native naming probe reply.' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'Native naming probe reply.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
} });
writeFileSync(join(root, 'config.toml'), `model = "gpt-probe"\nmodel_provider = "naming-probe"\n[model_providers.naming-probe]\nname = "Local naming probe"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const child = spawn(Bun.which('codex')!, ['app-server', '--listen', 'stdio://'], { cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
const completions = new Map<string, () => void>();
const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`);
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame: any;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === 'turn/completed') completions.get(frame.params?.threadId)?.();
  const held = pending.get(frame.id);
  if (!held) return;
  pending.delete(frame.id);
  clearTimeout(held.timer);
  frame.error ? held.reject(frame.error) : held.resolve(frame.result);
});
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
const results: unknown[] = [];
try {
  await rpc('initialize', { clientInfo: { name: 'cosyncing', version: 'probe' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  const started = await rpc('thread/start', { cwd: root, historyMode: 'legacy', approvalPolicy: 'never' });
  const threadId = started.thread.id;
  await rpc('thread/metadata/update', { threadId, gitInfo: { branch: started.thread.gitInfo?.branch ?? null } });
  process.env.CODEX_HOME = root;
  process.env.COSYNCING_CODEX_BIN = Bun.which('codex')!;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '0';
  const { CodexAdapter } = await import('../../packages/typescript/adapters/codex/src/implementation.ts');
  const adapter = new CodexAdapter();
  const created = await adapter.createSession({ directory: root });
  const createdNative = (await rpc('thread/read', { threadId: created.nativeId })).thread;
  const createdPath = Buffer.from(created.id, 'base64url').toString();
  if (!existsSync(createdPath) || created.title !== '' || createdNative.name) {
    throw new Error('Adapter create did not persist an unnamed native thread.');
  }
  results.push({ step: 'adapter creates a durable unnamed thread through metadata barrier', native: true, name: createdNative.name ?? null });
  // Rust treats NEL as whitespace while JavaScript trim preserves it. This
  // exercises a real native name validation error, without a fake RPC server.
  const rejectedName = '\u0085';
  let nativeRejected = false;
  try { await rpc('thread/name/set', { threadId, name: rejectedName }); }
  catch { nativeRejected = true; }
  if (!nativeRejected) throw new Error('Native Codex accepted the intended invalid-name fixture.');
  const refusedNameCreate = await adapter.createSession({ directory: root, title: rejectedName });
  const refusedNameNative = (await rpc('thread/read', { threadId: refusedNameCreate.nativeId })).thread;
  const refusedNamePath = Buffer.from(refusedNameCreate.id, 'base64url').toString();
  const refusedNameAttach = await adapter.attach(refusedNameCreate.id, 'observe');
  try {
    if (!existsSync(refusedNamePath) || refusedNameCreate.title !== '' || refusedNameNative.name
      || refusedNameAttach.info.title !== '') throw new Error('A real native name rejection lost the durable create.');
    results.push({ step: 'real native name rejection preserves a durable attachable create', native: true, nameRejected: true });
  } finally { await refusedNameAttach.close(); }
  const sessionId = Buffer.from(started.thread.path).toString('base64url');
  async function turn(text: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const settled = new Promise<void>((resolve, reject) => {
      completions.set(threadId, resolve);
      timer = setTimeout(() => reject(new Error('Native turn did not settle')), 30_000);
    });
    try { await rpc('turn/start', { threadId, input: [{ type: 'text', text }] }); await settled; }
    finally { clearTimeout(timer!); completions.delete(threadId); }
  }
  async function compare(step: string, expected: string): Promise<void> {
    const native = (await rpc('thread/read', { threadId })).thread;
    const connection = await adapter.attach(sessionId, 'observe');
    try {
      const nativeTitle = native.name || native.preview || '';
      if (connection.info.title !== expected || nativeTitle !== expected) throw new Error(`${step}: native=${nativeTitle}, app=${connection.info.title}`);
      results.push({ step, title: expected, native: true, attach: true });
    } finally { await connection.close(); }
  }
  await compare('unnamed durable create', '');
  await turn('First native prompt');
  await compare('first native prompt', 'First native prompt');
  await turn('A later native prompt');
  await compare('native follow-up', 'First native prompt');
  await adapter.renameSession(sessionId, 'Native / 名称.md');
  await compare('native rename', 'Native / 名称.md');
  await adapter.renameSession(sessionId, null);
  await compare('requested clear uses prompt when native clearing is unsupported', 'First native prompt');
  results.push({ localModelRequests: requests });
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  server.stop(true);
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(results, null, 2)}\n`);
}
console.log(JSON.stringify(results, null, 2));
