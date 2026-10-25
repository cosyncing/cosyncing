// Installed Claude headless CLI against a local, credential-free model fixture. No model cost.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = resolve(process.argv[2] ?? 'output/session-naming/native-claude');
const config = join(root, 'claude');
const workspace = join(tmpdir(), `cosyncing-native-naming-${randomUUID()}`);
mkdirSync(config, { recursive: true });
mkdirSync(workspace, { recursive: true });
const executable = Bun.which('claude');
if (!executable) throw new Error('Install Claude before running the native naming probe.');
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 });
  const body = await request.json().catch(() => ({})) as { stream?: boolean; model?: string };
  requests++;
  const message = { id: `msg_probe_${requests}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'Naming probe reply.' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } };
  if (!body.stream) return Response.json(message);
  const frames = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Naming probe reply.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
} });
const id = randomUUID();
const env = {
  HOME: root, PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_AUTH_TOKEN: 'local-probe',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
};
const results: unknown[] = [];
async function run(prompt: string, resume: boolean): Promise<void> {
  const child = Bun.spawn([executable!, '-p', prompt, resume ? '--resume' : '--session-id', id,
    '--model', 'claude-sonnet-4-6', '--tools', '', '--output-format', 'json'], {
    cwd: workspace, env, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native Claude probe failed (${code}): ${(stderr || stdout).slice(-1000)}`);
  } finally { clearTimeout(timer); }
}
try {
  await run('First native prompt 🧪', false);
  process.env.CLAUDE_CONFIG_DIR = config;
  const { ClaudeAdapter } = await import('../../packages/typescript/adapters/claude/src/implementation.ts');
  const adapter = new ClaudeAdapter();
  const projects = join(config, 'projects');
  const files = readdirSync(projects, { recursive: true }) as string[];
  const relative = files.find((file) => file.endsWith(`${id}.jsonl`));
  if (!relative) throw new Error('Native Claude wrote no session transcript.');
  const file = join(projects, relative);
  const sessionId = Buffer.from(file).toString('base64url');
  async function compare(step: string, expected: string): Promise<void> {
    const title = await adapter.resolveSessionTitle(sessionId);
    const connection = await adapter.attach(sessionId, 'observe');
    try {
      if (title !== expected || connection.info.title !== expected) throw new Error(`${step}: title mismatch`);
      results.push({ step, title, attach: true });
    } finally { await connection.close(); }
  }
  await compare('native headless first prompt', 'First native prompt 🧪');
  await run('A later native prompt', true);
  await compare('native headless follow-up', 'First native prompt 🧪');
  appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Native AI title', sessionId: id })}\n`);
  await compare('native AI title record', 'Native AI title');
  appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'Native / 名称.md', sessionId: id })}\n`);
  await run('Follow-up after native naming', true);
  await compare('native custom title after resume', 'Native / 名称.md');
  const rows = readFileSync(file, 'utf8').trim().split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  results.push({ nativeLastPrompt: rows.findLast((row) => row.type === 'last-prompt')?.lastPrompt, localModelRequests: requests });
} finally {
  server.stop(true);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(results, null, 2)}\n`);
}
console.log(JSON.stringify(results, null, 2));
