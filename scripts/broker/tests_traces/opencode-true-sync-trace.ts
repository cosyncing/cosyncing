/**
 * OpenCode true-sync scenario trace driver.
 *
 * Uses a real running `opencode serve` as the shared owner, starts an isolated cosyncing broker,
 * then proves app→OpenCode and OpenCode→app live flow plus the permission approval path.
 *
 * This does not spawn a real terminal TUI. Native OpenCode HTTP calls stand in for the terminal
 * peer because `opencode attach <url>` is also a client of the same server/event bus.
 *
 *   OC=http://127.0.0.1:4096 bun run scripts/broker/tests_traces/opencode-true-sync-trace.ts
 */
export {};
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 20000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const OC = (process.env.OC ?? process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/$/, '');
const MODEL = {
  id: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'ST-03-ST-04-ST-14');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode.ndjson');
const tracePath = join(outDir, 'trace.json');
const scenarioIds = ['ST-03', 'ST-04', 'ST-14'];
const steps = [
  'start isolated broker pointed at opencode serve',
  'create a throwaway OpenCode session with bash permissions set to ask',
  'attach a browser WebSocket client',
  'verify explicit session-control metadata',
  'send an app prompt and verify it appears in native OpenCode history',
  'send a native OpenCode prompt and verify it streams into the app',
  'trigger a bash permission request from the app',
  'approve it through the app and verify the dedicated permission channel resolves',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPENCODE_URL: OC },
  stdout: 'pipe',
  stderr: 'pipe',
});
let cleanupSession: { id: string; dir: string } | undefined;

const request = async (base: string, path: string, init: RequestInit = {}): Promise<Response> => {
  record(nativePath, { direction: 'trace->native', url: `${base}${path}`, method: init.method ?? 'GET', body: init.body });
  const res = await fetch(`${base}${path}`, init);
  record(nativePath, { direction: 'native->trace', url: `${base}${path}`, status: res.status });
  return res;
};

try {
  if (!(await waitHealth(`${OC}/global/health`, 'OpenCode'))) throw new Error(`OpenCode server is not reachable at ${OC}`);
  if (!(await waitHealth(`${BROKER}/api/health`, 'broker'))) throw new Error(`broker did not start at ${BROKER}`);

  const dir = `/tmp/cosyncing-opencode-trace-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const id = await createSession(dir);
  cleanupSession = { id, dir };
  check('throwaway OpenCode session created', /^ses/.test(id), id);

  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* skip malformed frames */
    }
  };
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  const info = sessionFrame?.info;
  check('session frame reports explicit control metadata', !!info?.control?.drive && !!info?.control?.terminalSync, JSON.stringify(info?.control));
  check('OpenCode drive state is app-drivable', info?.control?.drive?.supported === true && info.control.drive.state === 'driving');
  check('OpenCode sync setup command is exposed but not falsely active', info?.control?.terminalSync?.supported === true && info.control.terminalSync.active === false && /opencode attach/.test(info.control.terminalSync.command ?? ''));

  const markApp = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: 'APP_TRACE_PROMPT. Reply with exactly APP_TRACE_OK.' }));
  const appUser = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'user-message' && /APP_TRACE_PROMPT/.test(f.message.text ?? ''), 8000);
  check('app prompt echoes as app user-message', !!appUser, appUser?.message?.key);
  const nativeAppPrompt = await waitNativeText(id, dir, /APP_TRACE_PROMPT/, 8000);
  check('app prompt persists in native OpenCode history', nativeAppPrompt, 'terminal peer would read the same server history');
  const appOutput = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'model-output', 30000);
  check('app-driven turn streams model output', !!appOutput, appOutput?.message?.key);
  await waitIdleAfter(frames, markApp, 45000);

  const markTerminal = frames.length;
  await promptDirect(id, dir, 'TERMINAL_TRACE_PROMPT. Reply with exactly TERMINAL_TRACE_OK.');
  const terminalUser = await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'user-message' && /TERMINAL_TRACE_PROMPT/.test(f.message.text ?? ''), 10000);
  check('native OpenCode prompt reaches app as user-message', !!terminalUser, terminalUser?.message?.key);
  const terminalOutput = await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'model-output', 30000);
  check('native-driven turn streams output into app', !!terminalOutput, terminalOutput?.message?.key);
  await waitIdleAfter(frames, markTerminal, 45000);

  const markPerm = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: 'Use your bash tool to run exactly this command and do not answer without calling bash: echo OPENCODE_PERMISSION_TRACE' }));
  const perm = await waitFrame(frames, (f) => frames.indexOf(f) >= markPerm && f.kind === 'message' && f.message?.type === 'permission-request', 35000);
  check('OpenCode permission request reaches app', !!perm, perm?.message ? `${perm.message.title}: ${perm.message.detail ?? ''}` : 'no permission card');
  if (perm?.message?.requestId) {
    ws.send(JSON.stringify({ kind: 'approve', requestId: perm.message.requestId, decision: 'approve' }));
    const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= markPerm && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === perm.message.requestId, 15000);
    check('app approval resolves through OpenCode permission channel', !!resolved, resolved?.message?.decision);
    const tool = await waitFrame(frames, (f) => frames.indexOf(f) >= markPerm && f.kind === 'message' && f.message?.type === 'tool-result' && f.message.toolName === 'bash', 30000);
    check('approved bash tool completes after permission', !!tool, tool?.message?.title ?? '');
  }

  ws.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  if (cleanupSession) await deleteSession(cleanupSession.id, cleanupSession.dir);
  broker.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'opencode',
    version: { cosyncing: 'local-source', opencode: await opencodeVersion() },
    broker: BROKER,
    opencode: OC,
    steps,
    output: { frames: framesPath, native: nativePath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function waitHealth(url: string, label: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not ready */
    }
    await sleep(label === 'broker' ? 250 : 100);
  }
  return false;
}

async function opencodeVersion(): Promise<string | undefined> {
  try {
    const r = await fetch(`${OC}/global/health`);
    return r.ok ? String((await r.json())?.version ?? '') : undefined;
  } catch {
    return undefined;
  }
}

async function createSession(dir: string): Promise<string> {
  const res = await request(OC, `/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'cosyncing-opencode-trace',
      model: MODEL,
      permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    }),
  });
  if (!res.ok) throw new Error(`create session ${res.status}: ${await res.text()}`);
  return String((await res.json()).id ?? '');
}

async function deleteSession(id: string, dir: string): Promise<void> {
  await request(OC, `/session/${id}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }).catch(() => {});
}

async function promptDirect(id: string, dir: string, text: string): Promise<void> {
  const res = await request(OC, `/session/${id}/prompt_async?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`direct prompt ${res.status}: ${await res.text()}`);
}

async function waitNativeText(id: string, dir: string, re: RegExp, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const rows = await nativeMessages(id, dir);
    const text = rows.flatMap((r: any) => r.parts ?? []).map((p: any) => p.text ?? '').join('\n');
    if (re.test(text)) return true;
    if (Date.now() > end) return false;
    await sleep(250);
  }
}

async function nativeMessages(id: string, dir: string): Promise<any[]> {
  const res = await request(OC, `/session/${id}/message?directory=${encodeURIComponent(dir)}`);
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  record(nativePath, { direction: 'native-history', rows: Array.isArray(rows) ? rows.length : 0 });
  return Array.isArray(rows) ? rows : [];
}

async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(100);
  }
}

async function waitIdleAfter(frames: any[], mark: number, ms: number): Promise<void> {
  await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', ms);
}
