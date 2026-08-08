/**
 * OpenCode real private-Drive trace.
 *
 * Does NOT start `opencode serve`. It seeds a throwaway OpenCode session with real
 * `opencode run --format json`, attaches cosyncing in `?mode=resume`, then proves the app-owned
 * Drive path maps real raw run records, including real native `todowrite` output. It also records the
 * private-run permission boundary: in JSON run mode, no app-answerable permission prompt is exposed
 * (OpenCode may auto-reject `ask` permissions, or the model may avoid the tool before a prompt exists).
 *
 *   bun run scripts/broker/tests_traces/opencode-real-run-drive-trace.ts
 */
export {};
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 24000 + Math.floor(Math.random() * 18000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const MODEL = {
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
  modelID: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'real-private-drive');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode-run.ndjson');
const tracePath = join(outDir, 'trace.json');
const scenarioIds = ['ST-14', 'ST-17', 'ST-27'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assertions: Array<{ name: string; ok: boolean; detail?: string }> = [];
mkdirSync(outDir, { recursive: true });

let broker: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let ws: WebSocket | undefined;

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  if (!(await hasCommand('opencode'))) throw new Error('opencode is not on PATH');

  const seedDir = `/tmp/cosyncing-opencode-real-drive-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(seedDir, { recursive: true });
  const seed = await opencodeRun(seedDir, 'Reply with exactly COSYNCING_REAL_SEED_OK.', 90000);
  const seedSession = seed.records.find((r) => r?.sessionID)?.sessionID;
  check('seed real OpenCode session created without opencode serve', /^ses_/.test(String(seedSession ?? '')), String(seedSession ?? ''));
  check('seed run emitted real raw text record', seed.records.some((r) => r?.type === 'text' && r?.part?.type === 'text'), `records=${seed.records.length}`);
  check('seed run emitted real step_finish tokens', seed.records.some((r) => r?.type === 'step_finish' && r?.part?.tokens), '');
  if (!seedSession) throw new Error('seed sessionID not found in opencode run output');

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPENCODE_URL: 'http://127.0.0.1:1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!(await waitHealth(`${BROKER}/api/health`))) throw new Error(`broker did not start at ${BROKER}`);

  const frames: any[] = [];
  ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(seedSession)}/stream?mode=resume`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* skip malformed frames */
    }
  };
  await new Promise<void>((resolve, reject) => {
    if (!ws) return reject(new Error('ws missing'));
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 8000);
  check('broker opens real private session as Drive owner', sessionFrame?.info?.attachMode === 'resume' && sessionFrame.info.control?.drive?.state === 'driving', JSON.stringify(sessionFrame?.info?.control));

  const mark = frames.length;
  ws.send(JSON.stringify({
    kind: 'prompt',
    text: 'Use the bash tool to run exactly: echo COSYNCING_REAL_DRIVE_TOOL_OK. Do not just describe it.',
    model: MODEL,
  }));
  const user = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'user-message' && /COSYNCING_REAL_DRIVE_TOOL_OK/.test(f.message.text ?? ''), 10000);
  check('app Drive prompt is echoed as user-message', !!user, user?.message?.key ?? '');
  const tool = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.toolName === 'bash' && /COSYNCING_REAL_DRIVE_TOOL_OK/.test(String(f.message?.result ?? '')), 90000);
  check('real private Drive maps raw tool_use to tool-result', !!tool, tool?.message?.callId ?? '');
  const tokens = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'token-count' && f.message?.input != null, 90000);
  check('real private Drive maps step_finish tokens', !!tokens, JSON.stringify(tokens?.message ?? null));
  const history = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'history' && JSON.stringify(f.messages ?? []).includes('COSYNCING_REAL_DRIVE_TOOL_OK'), 10000);
  check('real private Drive resyncs persisted OpenCode history', !!history);

  const todoMark = frames.length;
  ws.send(JSON.stringify({
    kind: 'prompt',
    text: 'Use your todowrite todo-list tool now. Create exactly three todos with these titles: COSYNCING_TODO_ALPHA, COSYNCING_TODO_BETA, COSYNCING_TODO_GAMMA. Mark COSYNCING_TODO_ALPHA completed, COSYNCING_TODO_BETA in progress, and COSYNCING_TODO_GAMMA pending. After calling the todo tool, reply exactly COSYNCING_REAL_TODO_DONE.',
    model: MODEL,
  }));
  const todoUser = await waitFrame(frames, (f) => frames.indexOf(f) >= todoMark && f.kind === 'message' && f.message?.type === 'user-message' && /COSYNCING_TODO_ALPHA/.test(f.message.text ?? ''), 10000);
  check('real todo prompt is echoed as user-message', !!todoUser, todoUser?.message?.key ?? '');
  const todoList = await waitFrame(
    frames,
    (f) =>
      frames.indexOf(f) >= todoMark &&
      f.kind === 'message' &&
      f.message?.type === 'task-list-state' &&
      hasTodo(f.message, 'COSYNCING_TODO_ALPHA', 'done') &&
      hasTodo(f.message, 'COSYNCING_TODO_BETA', 'in-progress') &&
      hasTodo(f.message, 'COSYNCING_TODO_GAMMA', 'open'),
    90000,
  );
  check('real OpenCode todowrite maps through broker to task-list-state', !!todoList, JSON.stringify(todoList?.message ?? null));
  const todoDone = await waitFrame(frames, (f) => frames.indexOf(f) >= todoMark && f.kind === 'message' && f.message?.type === 'model-output' && /COSYNCING_REAL_TODO_DONE/.test(String(f.message.text ?? '') + String(f.message.delta ?? '')), 90000);
  check('real todo turn completes after native todowrite', !!todoDone, todoDone?.message?.key ?? '');
  check('real todowrite is not surfaced as raw tool-result card', !frames.some((f) => frames.indexOf(f) >= todoMark && f.kind === 'message' && f.message?.type === 'tool-result' && f.message?.toolName === 'todowrite'));

  const askDir = `/tmp/cosyncing-opencode-real-ask-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(askDir, { recursive: true });
  writeFileSync(join(askDir, 'opencode.json'), JSON.stringify({ permission: { bash: 'ask' } }, null, 2));
  const ask = await opencodeRun(askDir, 'Use the bash tool to run exactly: echo COSYNCING_PRIVATE_PERMISSION_BOUNDARY. Do not just describe it.', 90000);
  const autoReject = /auto-rejecting/i.test(ask.stderr);
  const rejectedTool = ask.records.some((r) => r?.part?.type === 'tool' && r.part?.state?.status === 'error' && /rejected permission/i.test(String(r.part?.state?.error ?? '')));
  const toolAttempted = ask.records.some((r) => r?.part?.type === 'tool');
  const refusedBeforeTool =
    !toolAttempted &&
    ask.records.some((r) => r?.part?.type === 'text' && /can't run|cannot run|won't run/i.test(String(r.part?.text ?? '')));
  const noToolAttempt = !toolAttempted;
  check(
    'real opencode run JSON mode has no interactive ask-permission channel',
    (autoReject && rejectedTool) || refusedBeforeTool || noToolAttempt,
    autoReject ? (ask.stderr.split('\n')[0] ?? '') : refusedBeforeTool ? 'model refused before tool execution' : noToolAttempt ? 'model made no tool attempt' : '',
  );
} catch (err) {
  check('real private Drive trace completed without exception', false, String(err));
} finally {
  ws?.close();
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'opencode',
    kind: 'real-private-drive',
    model: MODEL,
    broker: BROKER,
    output: { frames: framesPath, native: nativePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function opencodeRun(dir: string, prompt: string, timeoutMs: number): Promise<{ records: any[]; stdout: string; stderr: string; code: number | null }> {
  const port = String(30000 + Math.floor(Math.random() * 12000));
  const args = ['opencode', 'run', '--port', port, '--format', 'json', '--model', `${MODEL.providerID}/${MODEL.modelID}`, '--dir', dir, prompt];
  record(nativePath, { direction: 'trace->opencode', args, dir });
  const res = await command(args, timeoutMs);
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      record(nativePath, { direction: 'opencode->trace', record: JSON.parse(line) });
    } catch {
      record(nativePath, { direction: 'opencode->trace', raw: line });
    }
  }
  if (res.stderr.trim()) record(nativePath, { direction: 'opencode->trace', stderr: res.stderr });
  const records = res.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  return { ...res, records };
}

async function command(cmd: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited.catch(() => null)]);
  clearTimeout(timer);
  return { stdout, stderr: timedOut ? `${stderr}\n[TIMED OUT]` : stderr, code };
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(100);
  }
}

async function waitHealth(url: string): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  return false;
}

async function hasCommand(name: string): Promise<boolean> {
  const res = await command(['bash', '-lc', `command -v ${shellQuote(name)}`], 5000);
  return res.code === 0;
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function hasTodo(message: any, title: string, status: string): boolean {
  return Array.isArray(message?.items) && message.items.some((item: any) => item?.title === title && item?.status === status);
}
