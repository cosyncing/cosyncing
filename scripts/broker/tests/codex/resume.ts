/**
 * Live integration test for the Codex resume adapter.
 *
 * Creates one THROWAWAY Codex thread in /tmp on the cheapest available Codex model, starts a broker
 * unless BROKER is provided, attaches through cosyncing, then checks:
 *   1. attach + history replay
 *   2. model-output deltas with stable keys
 *   3. command approval round-trip
 *   4. requestUserInput question cards (deterministic fake app-server)
 *   5. file input/output through inbox/outbox
 *   6. tool-call + tool-result rendering data
 *   7. skills/config/model extension surfaces
 *   8. history replay on reattach
 *
 *   bun run scripts/broker/tests/codex/resume.ts
 *   BROKER=http://127.0.0.1:7734 bun run scripts/broker/tests/codex/resume.ts
 */
export {};
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../../../../packages/typescript/adapters/codex/src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

const HOST = '127.0.0.1';
const PORT = String(17734 + Math.floor(Math.random() * 1000));
const BROKER = process.env.BROKER ?? `http://${HOST}:${PORT}`;

interface Result { name: string; status: 'pass' | 'fail' | 'skip'; detail: string }
const results: Result[] = [];
async function test(name: string, fn: () => Promise<[boolean | 'skip', string]>): Promise<void> {
  process.stdout.write(`• ${name} … `);
  try {
    const [ok, detail] = await fn();
    const status = ok === 'skip' ? 'skip' : ok ? 'pass' : 'fail';
    results.push({ name, status, detail });
    console.log(`${status.toUpperCase()}  ${detail}`);
  } catch (e) {
    results.push({ name, status: 'fail', detail: String(e) });
    console.log('FAIL  threw: ' + e);
  }
}

async function startBroker(): Promise<Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined> {
  if (process.env.BROKER) return undefined;
  const proc = Bun.spawn(['bun', 'run', 'broker'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Codex test — don't let the broker's D20 auto-serve spawn an opencode serve as a side effect.
    env: { ...process.env, HOST, PORT, COSYNCING_OPENCODE_NO_AUTOSERVE: '1' },
  });
  void drain(proc.stdout);
  void drain(proc.stderr);
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BROKER}/api/health`);
      if (r.ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error('broker did not start');
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    /* process ended */
  }
}

class CodexRpc {
  private proc!: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly notifications: any[] = [];

  constructor(private readonly cwd: string) {
    this.proc = Bun.spawn(['codex', 'app-server', '--stdio'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd });
    const split = createSplitter((line) => this.onLine(line));
    void (async () => {
      const reader = this.proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    })();
    void drain(this.proc.stderr);
  }

  async init(): Promise<void> {
    await this.rpc('initialize', {
      clientInfo: { name: 'cosyncing-test', title: 'cosyncing Test', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  }

  async rpc(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(String(id))) reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      this.proc.stdin.flush();
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msg.id));
        msg.error ? p.reject(new Error(String(msg.error?.message ?? msg.error))) : p.resolve(msg.result);
        return;
      }
    }
    this.notifications.push(msg);
    if (msg.id != null && msg.method) {
      const result =
        msg.method === 'item/commandExecution/requestApproval'
          ? { decision: 'accept' }
          : msg.method === 'item/fileChange/requestApproval'
            ? { decision: 'accept' }
            : {};
      this.proc.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n');
      this.proc.stdin.flush();
    }
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.proc.kill();
  }
}

function createSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

interface ExtensionProbe {
  modelCount: number;
  modelProvider: string;
  configuredModel: string;
  skillCount: number;
  skillsErrors: number;
  configReadable: boolean;
}

async function seedSession(): Promise<{ dir: string; threadId: string; threadPath: string; sessionId: string; model: string; probe: ExtensionProbe }> {
  const dir = `/tmp/cosyncingcodex${rand()}`;
  mkdirSync(dir, { recursive: true });
  const rpc = new CodexRpc(dir);
  try {
    await rpc.init();
    const model = process.env.CODEX_RESUME_MODEL ?? (await cheapestModel(rpc));
    const probe = await extensionProbe(rpc, dir);
    const start = await rpc.rpc('thread/start', {
      cwd: dir,
      model,
      approvalsReviewer: 'user',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      serviceName: 'cosyncing-test',
    });
    const threadId = String(start.thread.id);
    const threadPath = String(start.thread.path);
    await rpc.rpc('turn/start', {
      threadId,
      clientUserMessageId: `cosyncing-seed-${Date.now()}`,
      input: [{ type: 'text', text: 'Reply exactly CODEX_RESUME_SEED and do not use tools.', text_elements: [] }],
      model,
      approvalsReviewer: 'user',
    });
    await waitFor(() => rpc.notifications.some((n) => n.method === 'turn/completed' && n.params?.threadId === threadId), 90000);
    return { dir, threadId, threadPath, sessionId: Buffer.from(threadPath, 'utf8').toString('base64url'), model, probe };
  } finally {
    rpc.close();
  }
}

async function extensionProbe(rpc: CodexRpc, dir: string): Promise<ExtensionProbe> {
  let modelCount = 0;
  let modelProvider = '';
  let configuredModel = '';
  let skillCount = 0;
  let skillsErrors = 0;
  let configReadable = false;
  try {
    const models = await rpc.rpc('model/list', { limit: 100, includeHidden: false }, 10000);
    modelCount = Array.isArray(models?.data) ? models.data.length : 0;
  } catch {
    /* optional probe */
  }
  try {
    const cfg = await rpc.rpc('config/read', { cwd: dir, includeLayers: true }, 10000);
    configReadable = true;
    modelProvider = String(cfg?.config?.model_provider ?? '');
    configuredModel = String(cfg?.config?.model ?? '');
  } catch {
    /* optional probe */
  }
  try {
    const skills = await rpc.rpc('skills/list', { cwds: [dir], forceReload: false }, 10000);
    for (const entry of skills?.data ?? []) {
      skillCount += Array.isArray(entry?.skills) ? entry.skills.length : 0;
      skillsErrors += Array.isArray(entry?.errors) ? entry.errors.length : 0;
    }
  } catch {
    /* optional probe */
  }
  return { modelCount, modelProvider, configuredModel, skillCount, skillsErrors, configReadable };
}

async function cheapestModel(rpc: CodexRpc): Promise<string> {
  const resp = await rpc.rpc('model/list', { limit: 100, includeHidden: false }, 10000);
  const models: any[] = resp?.data ?? [];
  return (
    models.find((m) => m.model === 'gpt-5.3-codex-spark')?.model ??
    models.find((m) => /mini|spark/i.test(String(m.model)))?.model ??
    models[0]?.model ??
    'gpt-5.3-codex-spark'
  );
}

interface Attach {
  send: (o: any) => void;
  frames: any[];
  msgs: () => any[];
  assistantText: () => string;
  waitMsg: (p: (m: any) => boolean, ms: number) => Promise<any>;
  close: () => void;
}

function attach(id: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BROKER.replace(/^http/, 'ws')}/api/sessions/codex/${encodeURIComponent(id)}/stream?mode=resume`);
    const frames: any[] = [];
    const assistantText = () => {
      const by = new Map<string, string>();
      for (const f of frames) if (f.kind === 'message' && f.message?.type === 'model-output') {
        const k = f.message.key || '_';
        by.set(k, f.message.text != null ? f.message.text : (by.get(k) || '') + (f.message.delta || ''));
      }
      return [...by.values()].join('');
    };
    const a: Attach = {
      send: (o) => ws.send(JSON.stringify(o)),
      frames,
      msgs: () => frames.filter((f) => f.kind === 'message').map((f) => f.message),
      assistantText,
      waitMsg: async (pred, ms) => {
        const end = Date.now() + ms;
        for (;;) {
          const h = frames.filter((f) => f.kind === 'message').map((f) => f.message).find(pred);
          if (h) return h;
          if (Date.now() > end) return undefined;
          await sleep(150);
        }
      },
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve(a);
  });
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(250);
  }
  return false;
}

async function fakeQuestionAdapterTest(): Promise<[boolean, string]> {
  const dir = `/tmp/cosyncingcodexfake${rand()}`;
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const rollout = join(dir, 'rollout-2026-06-16T00-00-00-00000000-0000-4000-8000-000000000000.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'fake-thread', cwd: dir } }) + '\n');
  const fake = join(binDir, 'codex');
  writeFileSync(fake, `#!/usr/bin/env bun
const enc = new TextDecoder();
let buf = '';
const send = (o) => console.log(JSON.stringify(o));
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    if (msg.method === 'initialize') send({ id: msg.id, result: {} });
    else if (msg.method === 'thread/resume') send({ id: msg.id, result: { thread: { name: 'fake' }, model: 'fake-model', modelProvider: 'fake-provider', reasoningEffort: 'medium' } });
    else if (msg.method === 'model/list') send({ id: msg.id, result: { data: [{ id: 'fake-model', model: 'fake-model', displayName: 'Fake Model', description: '', supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' }], nextCursor: null } });
    else if (msg.method === 'config/read') send({ id: msg.id, result: { config: { model_provider: 'fake-provider' }, origins: {}, layers: null } });
    else if (msg.method === 'skills/list') send({ id: msg.id, result: { data: [{ cwd: '${dir}', skills: [], errors: [] }] } });
    else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn1' } } });
      send({ method: 'turn/started', params: { threadId: 'fake-thread', turn: { id: 'turn1' } } });
      send({ id: 0, method: 'item/tool/requestUserInput', params: { threadId: 'fake-thread', turnId: 'turn1', itemId: 'ask1', questions: [
        { id: 'choice', header: 'Decision', question: 'Pick one', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'Approve it' }, { label: 'No', description: 'Decline it' }] },
        { id: 'note', header: 'Note', question: 'Add note', isOther: true, isSecret: false, options: null }
      ] } });
    } else if (msg.id === 0 && msg.result) {
      const text = 'QUESTION_ANSWER_OK ' + JSON.stringify(msg.result.answers);
      send({ method: 'item/agentMessage/delta', params: { turnId: 'turn1', itemId: 'answer1', delta: text } });
      send({ method: 'item/completed', params: { turnId: 'turn1', item: { type: 'agentMessage', id: 'answer1', text } } });
      send({ method: 'turn/completed', params: { threadId: 'fake-thread', turn: { id: 'turn1', status: 'completed' } } });
    }
  }
}
`);
  chmodSync(fake, 0o755);

  const oldBin = process.env.COSYNCING_CODEX_BIN;
  process.env.COSYNCING_CODEX_BIN = fake;
  const conn = await new CodexAdapter().attach(Buffer.from(rollout, 'utf8').toString('base64url'), 'resume');
  const messages: any[] = [];
  conn.subscribe((m: any) => messages.push(m));
  try {
    await conn.sendPrompt({ text: 'trigger question' });
    await waitFor(() => messages.some((m) => m.type === 'question-request'), 10000);
    const q = messages.find((m) => m.type === 'question-request');
    await conn.answerQuestion?.(q.requestId, [['Yes'], ['custom note']]);
    await waitFor(() => messages.some((m) => m.type === 'status' && m.status === 'idle'), 10000);
    const out = messages
      .filter((m) => m.type === 'model-output')
      .map((m) => m.text ?? m.delta ?? '')
      .join('');
    const resolved = messages.some((m) => m.type === 'question-resolved' && m.requestId === q?.requestId);
    const ok = q?.requestId?.startsWith('codex:q:0:') && q.questions?.length === 2 && resolved && /QUESTION_ANSWER_OK/.test(out) && /custom note/.test(out);
    return [ok, `requestId=${q?.requestId} questions=${q?.questions?.length ?? 0} resolved=${resolved}`];
  } finally {
    await conn.close().catch(() => {});
    if (oldBin == null) delete process.env.COSYNCING_CODEX_BIN;
    else process.env.COSYNCING_CODEX_BIN = oldBin;
    rmSync(dir, { recursive: true, force: true });
  }
}

await test('requestUserInput question cards use dedicated answer channel', fakeQuestionAdapterTest);

const broker = await startBroker();
const seeded = await seedSession();
try {
  await test('attach + history replay', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'history'), 10000);
    const hist = a.frames.find((f) => f.kind === 'history');
    const session = a.frames.find((f) => f.kind === 'session');
    const ok = session?.info?.attachMode === 'resume' && JSON.stringify(hist?.messages ?? []).includes('CODEX_RESUME_SEED');
    a.close();
    return [ok, `mode=${session?.info?.attachMode} history=${hist?.messages?.length ?? 0}`];
  });

  await test('live text prompt streams deltas with keyed bubbles', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'history'), 10000);
    a.frames.length = 0;
    a.send({ kind: 'prompt', text: 'Reply exactly CODEX_RESUME_TEXT_OK and do not use tools.' });
    const idle = await waitFor(() => a.msgs().some((m) => m.type === 'status' && m.status === 'idle'), 90000);
    const deltas = a.msgs().filter((m) => m.type === 'model-output' && m.delta != null && m.key).length;
    const keys = new Set(a.msgs().filter((m) => m.type === 'model-output' && m.key).map((m) => m.key));
    const replied = /CODEX_RESUME_TEXT_OK/.test(a.assistantText());
    a.close();
    return [idle && replied && deltas > 0 && keys.size > 0, `idle=${idle} replied=${replied} deltas=${deltas} keys=${[...keys].join(',')}`];
  });

  await test('file input writes inbox path and Codex reads it', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'history'), 10000);
    a.frames.length = 0;
    const token = `CODEX_FILE_INPUT_OK_${rand()}`;
    const name = `codex-input-${rand()}.txt`;
    a.send({
      kind: 'prompt',
      clientMessageId: `codex-file-${rand()}`,
      text: 'Read the attached file path included in this prompt and reply exactly with the file contents, no extra words.',
      files: [{ name, mimeType: 'text/plain', data: Buffer.from(token, 'utf8').toString('base64') }],
    });
    const idle = await waitFor(() => a.msgs().some((m) => m.type === 'status' && m.status === 'idle'), 120000);
    const inboxPath = join(seeded.dir, '.cosyncing', 'inbox', name);
    const wroteInbox = existsSync(inboxPath) && readFileSync(inboxPath, 'utf8') === token;
    const replied = a.assistantText().includes(token);
    a.close();
    return [idle && wroteInbox && replied, `idle=${idle} wroteInbox=${wroteInbox} replied=${replied}`];
  });

  await test('skills/config/model extension surfaces are queryable', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'commands'), 15000);
    await waitFor(() => a.frames.some((f) => f.kind === 'options'), 15000);
    const commands = a.frames.find((f) => f.kind === 'commands')?.commands ?? [];
    const options = a.frames.find((f) => f.kind === 'options')?.models ?? [];
    const hasBuiltins =
      commands.some((c: any) => c.name === 'stop') &&
      commands.some((c: any) => c.name === 'compact') &&
      commands.some((c: any) => c.name === 'goal');
    const providerPreserved = seeded.probe.modelProvider ? options.every((m: any) => m.providerID === seeded.probe.modelProvider) : true;
    a.close();
    return [
      seeded.probe.configReadable && seeded.probe.modelCount > 0 && options.length > 0 && hasBuiltins && providerPreserved,
      `config=${seeded.probe.configReadable} provider=${seeded.probe.modelProvider || 'unset'} configuredModel=${seeded.probe.configuredModel || 'unset'} modelList=${seeded.probe.modelCount}/${options.length} skills=${seeded.probe.skillCount} skillErrors=${seeded.probe.skillsErrors} builtins=${hasBuiltins}`,
    ];
  });

  await test('tool approval + tool-call/result pair', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'history'), 10000);
    a.frames.length = 0;
    a.send({ kind: 'prompt', text: 'Run this exact shell command once: printf CODEX_RESUME_TOOL_OK. Then reply exactly CODEX_RESUME_TOOL_DONE.' });
    const perm = await a.waitMsg((m) => m.type === 'permission-request' && m.toolName === 'exec_command', 90000);
    let rosterNeedsInput = false;
    let replayedPending = false;
    if (perm) {
      const roster = await (await fetch(`${BROKER}/api/sessions`)).json().catch(() => ({}));
      const row = (roster?.sessions ?? []).find((s: any) => s.tool === 'codex' && s.id === seeded.sessionId);
      rosterNeedsInput = row?.status === 'needs-input';
      const b = await attach(seeded.sessionId);
      await waitFor(() => b.frames.some((f) => f.kind === 'history'), 10000);
      replayedPending = !!(await b.waitMsg((m) => m.type === 'permission-request' && m.toolName === 'exec_command', 10000));
      b.close();
    }
    if (perm) a.send({ kind: 'approve', requestId: perm.requestId, decision: 'approve' });
    const idle = await waitFor(() => a.msgs().some((m) => m.type === 'status' && m.status === 'idle'), 90000);
    const call = a.msgs().find((m) => m.type === 'tool-call' && m.toolName === 'exec_command');
    const res = a.msgs().find((m) => m.type === 'tool-result' && m.callId === call?.callId);
    const resolved = a.msgs().some((m) => m.type === 'permission-resolved' && m.requestId === perm?.requestId);
    const outputOk = /CODEX_RESUME_TOOL_OK/.test(String(res?.result ?? ''));
    const finalOk = /CODEX_RESUME_TOOL_DONE/.test(a.assistantText());
    a.close();
    return [
      !!perm && rosterNeedsInput && replayedPending && resolved && idle && !!call && !!res && outputOk && finalOk,
      `perm=${!!perm} rosterNeedsInput=${rosterNeedsInput} replayedPending=${replayedPending} resolved=${resolved} tool=${!!call}/${!!res} output=${outputOk} final=${finalOk}`,
    ];
  });

  await test('reattach replays completed history', async () => {
    const a = await attach(seeded.sessionId);
    await waitFor(() => a.frames.some((f) => f.kind === 'history'), 10000);
    const hist = a.frames.find((f) => f.kind === 'history');
    const hasToolTurn = JSON.stringify(hist?.messages ?? []).includes('CODEX_RESUME_TOOL_DONE');
    a.close();
    return [hasToolTurn, `history=${hist?.messages?.length ?? 0} hasToolTurn=${hasToolTurn}`];
  });
} finally {
  try { rmSync(seeded.dir, { recursive: true, force: true }); } catch {}
  try { if (existsSync(seeded.threadPath)) rmSync(seeded.threadPath, { force: true }); } catch {}
  if (broker) broker.kill();
}

const failed = results.filter((r) => r.status === 'fail').length;
const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
