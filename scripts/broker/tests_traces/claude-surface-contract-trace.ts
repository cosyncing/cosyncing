/**
 * Claude Observe + Drive surface contract trace.
 *
 * Boots an isolated broker against an isolated CLAUDE_CONFIG_DIR + fixture transcript and a FAKE
 * `claude` stream-json binary (COSYNCING_CLAUDE_BIN) — proving the Claude pieces of
 * docs/architecture/client-ui.md end-to-end at the broker WS boundary, with NO
 * model cost: read-only Observe + broker mutation rejection, explicit Drive ownership, full history +
 * commands + options (with permission-mode categories) before input, prompt echoed once, actionable
 * permission + AskUserQuestion round trip with permission-resolved/question-resolved, app-selected
 * plan mode as a native launch flag, and late-tab pending replay (each card exactly once).
 *
 * Writes output/traces/<run-id>/claude/ST-CLAUDE-SURFACE/{trace.json,frames.ndjson}.
 *
 *   bun run scripts/broker/tests_traces/claude-surface-contract-trace.ts
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 25000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'ST-CLAUDE-SURFACE');
const framesPath = join(outDir, 'frames.ndjson');
const fakePath = join(outDir, 'fake-claude.ndjson');
const tracePath = join(outDir, 'trace.json');
const UUID = '0aaaaaaa-0000-4000-8000-claudesurface';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });
function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}
function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-claude-surface-'));
const configDir = join(tempRoot, 'claude-config');
const workDir = join(tempRoot, 'workspace');
const binDir = join(tempRoot, 'bin');
const fakeClaude = join(binDir, 'claude');
const slugDir = join(configDir, 'projects', 'proj-slug');
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(slugDir, { recursive: true });
writeTranscript();
writeFakeClaude();

let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      HOME: tempRoot, // isolate ~/bin wrapper scan + other adapters' home-based discovery
      CLAUDE_CONFIG_DIR: configDir, // default store points here (honored by the adapter, mirrors real claude)
      COSYNCING_CLAUDE_BIN: fakeClaude, // resume spawns the fake stream-json binary, not real claude
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainBrokerOutput(broker);
  if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);

  const sessionsBody = await (await fetch(`${BROKER}/api/sessions`)).json();
  const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions ?? [];
  const row = sessions.find((s: any) => s.tool === 'claude' && s.cwd === workDir);
  check('Claude row discovered from isolated transcript', !!row, JSON.stringify(sessions.filter((s: any) => s.tool === 'claude').map((s: any) => s.cwd)));
  check('default Claude row is observe-first and drivable', row?.attachMode === 'observe' && row?.control?.drive?.state === 'observing', JSON.stringify(row?.control?.drive));

  // ── Observe is read-only: a crafted prompt is rejected at the broker boundary ──
  const observe = await attach(row.id);
  await observe.waitFrame((f) => f.kind === 'history', 5000);
  observe.send({ kind: 'prompt', text: 'SHOULD_NOT_MUTATE_OBSERVE' });
  const observeError = await observe.waitFrame((f) => f.kind === 'error', 5000);
  check('crafted prompt rejected in Observe at the broker boundary', !!observeError, String(observeError?.message ?? ''));
  observe.close();

  // ── Drive: ownership + full surface BEFORE input ──
  const drive = await attach(row.id, 'resume');
  const sessionFrame = await drive.waitFrame((f) => f.kind === 'session', 5000);
  const historyFrame = await drive.waitFrame((f) => f.kind === 'history', 5000);
  const optionsFrame = await drive.waitFrame((f) => f.kind === 'options', 5000);
  check('Drive attach reports app-owned resume control', sessionFrame?.info?.attachMode === 'resume' && sessionFrame?.info?.control?.drive?.state === 'driving', JSON.stringify(sessionFrame?.info?.control?.drive));
  const hist = historyFrame?.messages ?? [];
  check('Drive replays full transcript history before input', hist.some((m: any) => m.type === 'user-message' && /surface history prompt/.test(m.text ?? '')) && hist.some((m: any) => m.type === 'model-output' && /surface history answer/.test(m.text ?? '')), `${hist.length} msgs`);
  const modeCats = new Set((optionsFrame?.modes ?? []).map((m: any) => m.category));
  check('Claude permission modes expose universal categories', modeCats.has('ask-permission') && modeCats.has('approve-for-me') && modeCats.has('full-access'), JSON.stringify(optionsFrame?.modes?.map((m: any) => [m.value, m.category])));
  // The full picker reaches the app over the WS: model + permission-mode + reasoning-effort (the controls
  // maintainer flagged as missing). modes include auto + dontAsk; models include fable + per-model efforts.
  const modeVals = new Set((optionsFrame?.modes ?? []).map((m: any) => m.value));
  check('options frame carries auto + dontAsk permission modes', modeVals.has('auto') && modeVals.has('dontAsk'), JSON.stringify([...modeVals]));
  const modelIds = (optionsFrame?.models ?? []).map((m: any) => m.modelID);
  const optOpus = (optionsFrame?.models ?? []).find((m: any) => m.modelID === 'opus');
  check('options frame carries fable model + opus full reasoning-effort ladder (low..max)', modelIds.includes('fable') && ['low', 'medium', 'high', 'xhigh', 'max'].every((e) => (optOpus?.reasoningEfforts ?? []).some((r: any) => r.effort === e)), JSON.stringify(modelIds));
  // Efforts auto-infer PER MODEL (dynamic-discovery refinement): Sonnet has max but no xhigh; Haiku has none.
  const effortsOf = (id: string) => ((optionsFrame?.models ?? []).find((m: any) => m.modelID === id)?.reasoningEfforts ?? []).map((r: any) => r.effort);
  check('options frame: per-model efforts — sonnet has max but NOT xhigh, haiku has none', effortsOf('sonnet').includes('max') && !effortsOf('sonnet').includes('xhigh') && effortsOf('haiku').length === 0, JSON.stringify({ sonnet: effortsOf('sonnet'), haiku: effortsOf('haiku') }));
  check('options frame: ultracode offered ONLY on xhigh-capable models (opus/fable), never sonnet/haiku', effortsOf('opus').includes('ultracode') && effortsOf('fable').includes('ultracode') && !effortsOf('sonnet').includes('ultracode') && !effortsOf('haiku').includes('ultracode'), JSON.stringify(effortsOf('opus')));

  // ── First prompt: spawns fake claude in plan mode → permission + question arrive; echo exactly once ──
  const mark = drive.frames.length;
  drive.send({ kind: 'prompt', text: 'DRIVE_SURFACE_PROMPT', permissionMode: 'plan' });
  const permission = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-request', 6000);
  const question = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-request', 6000);
  check('Drive receives an actionable permission-request', !!permission && permission?.message?.readOnly !== true, permission?.message?.title ?? '');
  check('Drive receives an actionable AskUserQuestion → question-request', !!question && question?.message?.readOnly !== true && (question?.message?.questions?.[0]?.options?.length ?? 0) === 2, JSON.stringify(question?.message?.questions?.[0]?.question));

  // ── Late Drive tab replays each pending card exactly once ──
  const late = await attach(row.id, 'resume');
  await late.waitFrame((f) => f.kind === 'history', 5000);
  await late.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-request', 5000);
  await sleep(200);
  const latePerm = late.frames.filter((f) => f.kind === 'message' && f.message?.type === 'permission-request').length;
  const lateQ = late.frames.filter((f) => f.kind === 'message' && f.message?.type === 'question-request').length;
  check('late Drive tab replays the pending permission exactly once', latePerm === 1, `count=${latePerm}`);
  check('late Drive tab replays the pending question exactly once', lateQ === 1, `count=${lateQ}`);
  late.close();

  // ── Approve + answer → resolved on both channels + final output ──
  drive.send({ kind: 'approve', requestId: permission?.message?.requestId, decision: 'approve-session' });
  drive.send({ kind: 'answer', requestId: question?.message?.requestId, answers: [['Yes']] });
  const permResolved = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === permission?.message?.requestId, 6000);
  const qResolved = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'question-resolved' && f.message.requestId === question?.message?.requestId, 6000);
  const output = await drive.waitFrame((f) => f.kind === 'message' && f.message?.type === 'model-output' && /SURFACE_DONE/.test(String(f.message.text ?? '') + String(f.message.delta ?? '')), 6000);
  check('approval resolves through the native control channel', !!permResolved, permResolved?.message?.decision ?? '');
  check('question resolves through the native tool_result channel', !!qResolved, qResolved?.message?.requestId ?? '');
  check('driven turn completes with final output', !!output);
  const fakeRecords = readNdjson(fakePath);
  const launchArgs = fakeRecords.find((r: any) => r.event === 'launch')?.args ?? [];
  check(
    'Drive plan mode launches native Claude with --permission-mode plan',
    Array.isArray(launchArgs) && launchArgs.includes('--permission-mode') && launchArgs.includes('plan'),
    JSON.stringify(launchArgs),
  );
  const echoes = drive.frames.filter((f, i) => i >= mark && f.kind === 'message' && f.message?.type === 'user-message' && /DRIVE_SURFACE_PROMPT/.test(f.message.text ?? '')).length;
  check('driven prompt is echoed exactly once', echoes === 1, `count=${echoes}`);
  drive.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-CLAUDE-SURFACE'],
    agent: 'claude',
    version: { cosyncing: 'local-source', claude: 'fake-stream-json' },
    broker: BROKER,
    configDir,
    steps: [
      'discover an isolated transcript-backed Claude session',
      'start broker with a fake claude stream-json binary',
      'prove default attach is Observe/read-only + broker rejects mutation',
      'prove Drive attach owns input and replays history + mode categories before input',
      'prove actionable permission + AskUserQuestion round trip with resolution',
      'prove app-selected Claude plan mode is a native resume launch flag, not a plain prompt',
      'prove late-tab pending replay exactly once + prompt echoed once',
    ],
    output: { frames: framesPath, fakeClaude: fakePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function writeTranscript(): void {
  const lines = [
    { type: 'user', uuid: 'u1', cwd: workDir, sessionId: UUID, message: { role: 'user', content: 'surface history prompt' } },
    { type: 'assistant', uuid: 'a1', cwd: workDir, sessionId: UUID, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'surface history answer' }] } },
  ];
  writeFileSync(join(slugDir, `${UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeFakeClaude(): void {
  writeFileSync(fakeClaude, `#!/usr/bin/env bun
// Fake claude: 'agents --json' → empty roster (status overlay, no cost). Resume → stream-json dance.
const args = process.argv.slice(2);
const send = (o) => console.log(JSON.stringify(o));
const record = (o) => { try { require('node:fs').appendFileSync('${fakePath}', JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\\n"); } catch {} };
if (args.includes('agents')) { console.log('[]'); process.exit(0); }
record({ event: 'launch', args });
let permOk = false, ansOk = false, promptSeen = false;
function finish() {
  if (!permOk || !ansOk) return;
  send({ type: 'stream_event', event: { type: 'message_start' } });
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SURFACE_DONE' } } });
  send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  send({ type: 'result', usage: { output_tokens: 5 }, total_cost_usd: 0, is_error: false });
}
send({ type: 'system', subtype: 'init', session_id: '${UUID}', model: 'fake-opus', permissionMode: 'default', slash_commands: ['stop', 'compact', 'review'] });
const enc = new TextDecoder();
let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += enc.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!raw.trim()) continue;
    let msg; try { msg = JSON.parse(raw); } catch { continue; }
    record({ dir: 'broker->fake', msg });
    if (msg.type === 'control_response') { permOk = true; finish(); continue; }
    const content = msg?.message?.content;
    if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) { ansOk = true; finish(); continue; }
    if (Array.isArray(content) && content.some((c) => c.type === 'text') && !promptSeen) {
      promptSeen = true;
      const text = content.find((c) => c.type === 'text').text;
      send({ type: 'user', uuid: 'echo1', message: { role: 'user', content: [{ type: 'text', text }] } }); // echo once
      send({ type: 'control_request', request_id: 'perm1', request: { subtype: 'can_use_tool', tool_name: 'Bash', explanation: 'rm -rf /tmp/x' } });
      send({ type: 'assistant', message: { id: 'mq', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', header: 'Decide', multiSelect: false, options: [{ label: 'Yes', description: 'go' }, { label: 'No', description: 'stop' }] }] } }] } });
    }
  }
}
`);
  chmodSync(fakeClaude, 0o755);
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  void (async () => {
    for (const stream of [proc.stdout, proc.stderr]) {
      const reader = stream.getReader();
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* ended */ }
    }
  })();
}
async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BROKER}/api/health`)).ok) return true; } catch { /* not ready */ }
    await sleep(100);
  }
  return false;
}
function readNdjson(path: string): any[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
type Attach = { frames: any[]; send: (obj: unknown) => void; waitFrame: (pred: (f: any) => boolean, ms: number) => Promise<any>; close: () => void };
function attach(sessionId: string, mode?: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const query = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(sessionId)}/stream${query}`);
    const frames: any[] = [];
    const out: Attach = {
      frames,
      send: (obj) => ws.send(JSON.stringify(obj)),
      waitFrame: (pred, ms) => waitFrame(frames, pred, ms),
      close: () => { try { ws.close(); } catch {} },
    };
    ws.onmessage = (e) => { try { const f = JSON.parse(String(e.data)); frames.push(f); record(framesPath, { mode: mode ?? 'observe', frame: f }); } catch {} };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve(out);
  });
}
async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const f = frames.find(pred);
    if (f) return f;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}
