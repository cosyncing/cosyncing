/**
 * OpenCode real-TUI true-sync trace.
 *
 * Starts a real `opencode attach <serve> -s <session> --dir <dir>` TUI in tmux, attaches the
 * cosyncing app socket, then proves:
 *   - the app can drive the shared OpenCode session;
 *   - a real attached TUI can submit a prompt that streams into the app;
 *   - the TUI-driven turn's working→idle status round-trips to the app (F1: the status tracker is
 *     driver-agnostic — keyed on sessionID from the server-wide event bus, not on who sent the prompt).
 *
 * Requires an existing `opencode serve` at $OC/$OPENCODE_URL and tmux. The trace's broker only OBSERVES
 * that serve (COSYNCING_OPENCODE_NO_AUTOSERVE=1) — it must never manage/reclaim the shared serve, which the
 * hardened take-over would otherwise do if it shares the default COSYNCING_HOME's ownership record.
 *
 *   OC=http://127.0.0.1:4096 bun run scripts/broker/tests_traces/opencode-real-tui-trace.ts
 */
export {};
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainProcessOutput, freePort } from './_real-tui-app-helpers.ts';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const OC = (process.env.OC ?? process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').replace(/\/$/, '');
const MODEL = {
  id: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'real-tui');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'tmux.txt');
const tracePath = join(outDir, 'trace.json');
const scenarioIds = ['ST-03', 'ST-04'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assertions: Array<{ name: string; ok: boolean; detail?: string }> = [];
mkdirSync(outDir, { recursive: true });

// Isolate the trace broker's state in a throwaway COSYNCING_HOME + dev mode so it starts WITHOUT reading
// (or mismatching) the developer's real ~/.cosyncing credentials, and never mutates them. Removed in finally.
const brokerHome = mkdtempSync(join(tmpdir(), 'cosyncing-real-tui-home-'));

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  // NO_AUTOSERVE: the trace attaches to an ALREADY-RUNNING serve at OC — its broker must only observe it,
  // never spawn/manage/reclaim it. Without this, the hardened take-over could dispose the shared :4096 serve
  // when this broker shares the default COSYNCING_HOME ownership record.
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    OPENCODE_URL: OC,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_HOME: brokerHome,
    COSYNCING_DEV_MODE: '1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
drainProcessOutput(broker, brokerPath);
let cleanup: { id: string; dir: string; tmux: string } | undefined;

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  if (!(await hasCommand('opencode'))) throw new Error('opencode is not on PATH');
  if (!(await hasCommand('tmux'))) throw new Error('tmux is not on PATH');
  if (!(await waitHealth(`${OC}/global/health`))) throw new Error(`OpenCode server is not reachable at ${OC}`);
  if (!(await waitHealth(`${BROKER}/api/health`))) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);

  const dir = `/tmp/cosyncing-opencode-real-tui-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const id = await createSession(dir);
  const tmuxName = `cosyncing-oc-${Math.random().toString(36).slice(2, 8)}`;
  cleanup = { id, dir, tmux: tmuxName };
  check('throwaway OpenCode session created on qwen trace model', /^ses/.test(id), `${id} ${MODEL.providerID}/${MODEL.id}`);

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
  await waitFrame(frames, (f) => f.kind === 'session', 5000);

  await tmux(['new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '40', `opencode attach ${shellQuote(OC)} -s ${shellQuote(id)} --dir ${shellQuote(dir)}`]);
  check('real opencode attach TUI started in tmux', await tmuxOk(['has-session', '-t', tmuxName]), tmuxName);
  await sleep(2500);
  await request(OC, `/tui/select-session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: id }),
  }).catch(() => undefined);

  const markApp = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: 'APP_REAL_TUI_TRACE. Reply with exactly APP_REAL_TUI_OK.' }));
  const appUser = await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'user-message' && /APP_REAL_TUI_TRACE/.test(f.message.text ?? ''), 8000);
  check('app prompt reaches shared OpenCode session', !!appUser, appUser?.message?.key);
  check('app prompt persisted in native history', await waitNativeText(id, dir, /APP_REAL_TUI_TRACE/, 10000));
  await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 45000);

  const markTui = frames.length;
  await request(OC, `/tui/append-prompt?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'TUI_REAL_TRACE_PROMPT. Reply with exactly TUI_REAL_OK.' }),
  });
  await request(OC, `/tui/submit-prompt?directory=${encodeURIComponent(dir)}`, { method: 'POST' });
  const tuiUser = await waitFrame(frames, (f) => frames.indexOf(f) >= markTui && f.kind === 'message' && f.message?.type === 'user-message' && /TUI_REAL_TRACE_PROMPT/.test(f.message.text ?? ''), 12000);
  check('real attached TUI prompt reaches app as user-message', !!tuiUser, tuiUser?.message?.key);
  const tuiOutput = await waitFrame(frames, (f) => frames.indexOf(f) >= markTui && f.kind === 'message' && f.message?.type === 'model-output', 45000);
  check('real attached TUI turn streams model output into app', !!tuiOutput, tuiOutput?.message?.key);
  // Round 3 (F1): the TUI-driven turn's working→idle status must round-trip to the app EXACTLY like an
  // app-driven turn — this is the coverage the trace was missing (it only asserted message streaming, and
  // asserted the status transition only for the app-driven turn at markApp). The tracker + live push key on
  // sessionID from the server-wide /global/event, so a turn a real external TUI submits is surfaced the same.
  const tuiRunning = await waitFrame(frames, (f) => frames.indexOf(f) >= markTui && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'running', 20000);
  check('real attached TUI turn drives the app session to working', !!tuiRunning, tuiRunning ? `frame#${frames.indexOf(tuiRunning)}` : 'no running status frame after the TUI submit');
  // Anchor the idle AFTER the running frame so a stale pre-turn idle can't satisfy it — this proves a genuine
  // working→idle transition for the TUI-driven turn, not just steady-state idle.
  const afterRunning = tuiRunning ? frames.indexOf(tuiRunning) : markTui;
  const tuiIdle = await waitFrame(frames, (f) => frames.indexOf(f) > afterRunning && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 45000);
  check('real attached TUI turn returns the app session to idle', !!tuiIdle, tuiIdle ? `frame#${frames.indexOf(tuiIdle)}` : 'no idle status frame after working');
  const capture = await tmuxCapture(tmuxName);
  writeFileSync(tuiPath, capture);
  check('tmux capture contains the attached TUI prompt', /TUI_REAL_TRACE_PROMPT/.test(capture), tuiPath);
  ws.close();
} catch (err) {
  check('real TUI trace completed without exception', false, String(err));
} finally {
  if (cleanup) {
    await tmux(['kill-session', '-t', cleanup.tmux]).catch(() => undefined);
    await deleteSession(cleanup.id, cleanup.dir);
  }
  broker.kill();
  rmSync(brokerHome, { recursive: true, force: true });
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'opencode',
    kind: 'real-tui',
    model: MODEL,
    broker: BROKER,
    opencode: OC,
    output: { frames: framesPath, native: nativePath, broker: brokerPath, tui: tuiPath },
    assertions,
    status: failed ? 'fail' : 'pass',
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  record(nativePath, { direction: 'trace->native', url: `${base}${path}`, method: init.method ?? 'GET', body: init.body });
  const res = await fetch(`${base}${path}`, init);
  record(nativePath, { direction: 'native->trace', url: `${base}${path}`, status: res.status });
  return res;
}

async function createSession(dir: string): Promise<string> {
  const res = await request(OC, `/session?directory=${encodeURIComponent(dir)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'cosyncing-opencode-real-tui', model: MODEL }),
  });
  if (!res.ok) throw new Error(`create session ${res.status}: ${await res.text()}`);
  return String((await res.json()).id ?? '');
}

async function deleteSession(id: string, dir: string): Promise<void> {
  await request(OC, `/session/${id}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }).catch(() => {});
}

async function waitNativeText(id: string, dir: string, re: RegExp, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const res = await request(OC, `/session/${id}/message?directory=${encodeURIComponent(dir)}`);
    const rows = res.ok ? await res.json().catch(() => []) : [];
    const text = (Array.isArray(rows) ? rows : []).flatMap((r: any) => r.parts ?? []).map((p: any) => p.text ?? '').join('\n');
    if (re.test(text)) return true;
    if (Date.now() > end) return false;
    await sleep(250);
  }
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

async function waitHealth(url: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
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
  return (await command(['bash', '-lc', `command -v ${shellQuote(name)}`])).ok;
}

async function tmux(args: string[]): Promise<string> {
  const r = await command(['tmux', ...args]);
  if (!r.ok) throw new Error(`tmux ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

async function tmuxOk(args: string[]): Promise<boolean> {
  return (await command(['tmux', ...args])).ok;
}

async function tmuxCapture(name: string): Promise<string> {
  const r = await command(['tmux', 'capture-pane', '-p', '-t', name, '-S', '-200']);
  return r.out + r.err;
}

async function command(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out, err };
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function brokerTail(): string {
  try {
    return readFileSync(brokerPath, 'utf8').slice(-2000);
  } catch {
    return '<no broker output captured>';
  }
}
