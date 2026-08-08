/**
 * Pi real-TUI bridge trace.
 *
 * Starts a real interactive `pi` process in tmux with the cosyncing bridge extension loaded,
 * then proves terminal→app, app→terminal, model/command metadata, tool activity, outbox artifact
 * surfacing, and a real extension-owned approval gate.
 *
 * This is intentionally opt-in because it uses a real model/provider:
 *
 *   COSYNCING_PI_REAL_TUI=1 \
 *   COSYNCING_PI_TUI_MODEL=vllm-hpc/qwen3.6-27B-FP8 \
 *   bun run scripts/broker/tests_traces/pi-real-tui-bridge-trace.ts
 *
 * If your Pi qwen endpoint is already configured in ~/.pi/agent, add COSYNCING_PI_USE_USER_CONFIG=1.
 * Otherwise export explicit provider env first and override COSYNCING_PI_TUI_MODEL as needed.
 */
export {};
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drainProcessOutput, freePort } from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_PI_REAL_TUI === '1';
const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const MODEL = process.env.COSYNCING_PI_TUI_MODEL ?? 'vllm-hpc/qwen3.6-27B-FP8';
const PROVIDER = process.env.COSYNCING_PI_TUI_PROVIDER;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = Math.random().toString(36).slice(2, 8);
const outDir = join(process.cwd(), 'output', 'traces', runId, 'pi', 'real-tui-bridge');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const nativePath = join(outDir, 'pi-tmux.txt');
const tracePath = join(outDir, 'trace.json');
const artifactName = `pi-broad-${short}.txt`;
const artifactMarker = `PI_BROAD_ARTIFACT_${short}`;
const doneMarker = `PI_BROAD_DONE_${short}`;
const scenarioIds = ['ST-03', 'ST-04', 'ST-14'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assertions: Array<{ name: string; ok: boolean; detail?: string }> = [];
mkdirSync(outDir, { recursive: true });

if (!enabled) {
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'pi',
    kind: 'real-tui-bridge',
    status: 'skip',
    skipReason: 'Set COSYNCING_PI_REAL_TUI=1 to run the real Pi TUI bridge trace.',
    model: MODEL,
  }, null, 2));
  console.log(`SKIP  real Pi TUI trace is opt-in\ntrace: ${tracePath}`);
  process.exit(0);
}

let broker: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let cleanup: { tmux: string; root: string } | undefined;

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  if (!(await hasCommand('pi'))) throw new Error('pi is not on PATH');
  if (!(await hasCommand('tmux'))) throw new Error('tmux is not on PATH');

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_BROKER: BROKER },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  if (!(await waitHealth(`${BROKER}/api/health`))) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);

  const root = `/tmp/cosyncing-pi-real-tui-${Math.random().toString(36).slice(2, 8)}`;
  const cwd = join(root, 'work');
  const configDir = process.env.COSYNCING_PI_TUI_CONFIG_DIR ??
    (process.env.COSYNCING_PI_USE_USER_CONFIG === '1' ? '' : join(root, 'config'));
  const sessionDir = join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  if (configDir) mkdirSync(configDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const tmuxName = `cosyncing-pi-${Math.random().toString(36).slice(2, 8)}`;
  cleanup = { tmux: tmuxName, root };

  const extension = join(process.cwd(), 'packages', 'adapters', 'pi', 'agent-extensions', 'cosyncing-bridge', 'index.ts');
  const envVars = [
    `COSYNCING_BROKER=${shellQuote(BROKER)}`,
    `COSYNCING_BRIDGE_APPROVALS=dangerous`,
    `COSYNCING_BRIDGE_APPROVAL_TIMEOUT_MS=60000`,
    `PI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}`,
  ];
  if (configDir) envVars.push(`PI_CODING_AGENT_DIR=${shellQuote(configDir)}`);
  const envPrefix = envVars.join(' ');
  const args = [
    'pi',
    '--session-dir', shellQuote(sessionDir),
    '--no-extensions',
    '--extension', shellQuote(extension),
    '--model', shellQuote(MODEL),
    '--tools', 'bash',
    '--name', 'cosyncing-pi-real-tui',
    '--no-context-files',
  ];
  if (PROVIDER) args.splice(1, 0, '--provider', shellQuote(PROVIDER));
  await tmux(['new-session', '-d', '-s', tmuxName, '-c', cwd, '-x', '120', '-y', '40', `${envPrefix} ${args.join(' ')}`]);
  await tmux(['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shellQuote(nativePath)}`]).catch(() => undefined);
  check('real Pi TUI started in tmux on qwen trace model', await tmuxOk(['has-session', '-t', tmuxName]), `${tmuxName} ${MODEL}`);

  // Pi creates/adopts the session when the first terminal prompt starts, not when the idle TUI opens.
  await tmux(['send-keys', '-t', tmuxName, 'BOOTSTRAP_PI_TUI_PROMPT. Reply with exactly PI_READY.', 'Enter']);
  const session = await waitLivePiSession(cwd, 30000);
  check('Pi bridge hello adopted the real TUI session', !!session?.id, session?.id ?? '');
  if (!session?.id) throw new Error('Pi bridge did not hello');

  const frames: any[] = [];
  const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(session.id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* skip malformed */
    }
  };
  await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  check('real Pi bridge session exposes synced model metadata', sessionFrame?.info?.currentModel?.modelID === MODEL.split('/').at(-1), JSON.stringify(sessionFrame?.info?.currentModel ?? null));
  const commands = await waitFrame(frames, (f) => f.kind === 'commands', 5000);
  check('real Pi bridge commands expose lifecycle command surface', (commands?.commands ?? []).some((c: any) => c.name === 'stop'), JSON.stringify(commands?.commands ?? []));
  const bootstrap = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'user-message' && /BOOTSTRAP_PI_TUI_PROMPT/.test(f.message.text ?? ''), 10000);
  console.log(`${bootstrap ? 'PASS' : 'INFO'}  bootstrap terminal prompt after app attach${bootstrap?.message?.key ? ` — ${bootstrap.message.key}` : ' — not required for live sync assertions'}`);
  await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 90000);

  const markTerminal = frames.length;
  await tmux(['send-keys', '-t', tmuxName, 'TERMINAL_PI_TUI_PROMPT. Reply with exactly PI_TUI_OK.', 'Enter']);
  const terminalUser = await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'user-message' && /TERMINAL_PI_TUI_PROMPT/.test(f.message.text ?? ''), 20000);
  check('real Pi TUI typed prompt reaches app', !!terminalUser, terminalUser?.message?.key);
  await waitFrame(frames, (f) => frames.indexOf(f) >= markTerminal && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 60000);

  const markApp = frames.length;
  ws.send(JSON.stringify({
    kind: 'prompt',
    text: [
      `APP_PI_TUI_BROAD_PROMPT_${short}.`,
      `Use your bash tool to create .cosyncing/outbox/${artifactName} containing exactly ${artifactMarker}.`,
      `Then reply exactly ${doneMarker}.`,
      'Do not skip the bash tool call.',
    ].join(' '),
  }));
  const appEcho = await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'user-message' && /APP_PI_TUI_BROAD_PROMPT/.test(f.message.text ?? ''), 20000);
  check('app prompt is injected into the real Pi TUI session', !!appEcho, appEcho?.message?.key);
  const appTool = await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && (f.message?.type === 'tool-call' || f.message?.type === 'tool-result'), 90000);
  check('real Pi broad app turn emits tool activity surface', !!appTool, JSON.stringify(appTool?.message ?? null));
  const artifact = await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'file-artifact' && JSON.stringify(f.message).includes(artifactName), 90000);
  check('real Pi broad app turn surfaces outbox file artifact', !!artifact, JSON.stringify(artifact?.message ?? null));
  const done = await waitForAccumulatedModelText(frames, markApp, doneMarker, 90000);
  check('real Pi broad app turn final response reaches app stream', done, doneMarker);
  const nativeArtifact = join(cwd, '.cosyncing', 'outbox', artifactName);
  check('Pi artifact file exists in real workspace with marker', readFileSafe(nativeArtifact).includes(artifactMarker), nativeArtifact);
  await waitFrame(frames, (f) => frames.indexOf(f) >= markApp && f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 60000);

  const markPerm = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: 'Use your bash tool to run exactly this command and do not answer without calling bash: sudo -n true' }));
  const perm = await waitFrame(frames, (f) => frames.indexOf(f) >= markPerm && f.kind === 'message' && f.message?.type === 'permission-request', 45000);
  check('real Pi extension tool_call gate emits permission request', !!perm, perm?.message ? `${perm.message.title}: ${perm.message.detail ?? ''}` : '');
  if (perm?.message?.requestId) {
    ws.send(JSON.stringify({ kind: 'approve', requestId: perm.message.requestId, decision: 'approve' }));
    const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= markPerm && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message.requestId === perm.message.requestId, 20000);
    check('app approval resolves the real Pi extension gate', !!resolved, resolved?.message?.decision);
  }

  const capture = await tmuxCapture(tmuxName);
  appendFileSync(nativePath, `\n\n--- capture-pane ---\n${capture}`);
  const native = readFileSync(nativePath, 'utf8');
  check('tmux capture contains the terminal prompt', /TERMINAL_PI_TUI_PROMPT/.test(native), nativePath);
  ws.close();
} catch (err) {
  check('real Pi TUI trace completed without exception', false, String(err));
} finally {
  if (cleanup && await tmuxOk(['has-session', '-t', cleanup.tmux]).catch(() => false)) {
    try {
      appendFileSync(nativePath, `\n\n--- capture-pane ---\n${await tmuxCapture(cleanup.tmux)}`);
    } catch {
      /* best-effort debug capture */
    }
  }
  if (cleanup) {
    await tmux(['kill-session', '-t', cleanup.tmux]).catch(() => undefined);
    rmSync(cleanup.root, { recursive: true, force: true });
  }
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds,
    agent: 'pi',
    kind: 'real-tui-bridge',
    model: MODEL,
    provider: PROVIDER,
    broker: BROKER,
    output: { frames: framesPath, broker: brokerPath, tui: nativePath },
    assertions,
    status: failed ? 'fail' : 'pass',
  }, null, 2));
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function waitLivePiSession(cwd: string, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const data = await (await fetch(`${BROKER}/api/sessions`)).json();
      const session = (data.sessions ?? []).find((s: any) => s.tool === 'pi' && s.cwd === cwd && s.control?.terminalSync?.active === true);
      if (session) return session;
    } catch {
      /* not ready */
    }
    if (Date.now() > end) return undefined;
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

async function waitForAccumulatedModelText(frames: any[], startIndex: number, needle: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const text = frames.slice(startIndex).map(modelFrameText).join('');
    if (text.includes(needle)) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

function modelFrameText(frame: any): string {
  if (frame?.kind === 'history' && Array.isArray(frame.messages)) return frame.messages.filter((m: any) => m?.type === 'model-output').map((m: any) => textOf(m)).join('\n');
  if (frame?.kind === 'message' && frame?.message?.type !== 'model-output') return '';
  if (frame?.type && frame.type !== 'model-output') return '';
  return textOf(frame);
}

function textOf(frame: any): string {
  const message = frame?.message ?? frame;
  return String(message?.text ?? '') + String(message?.delta ?? '') + String(message?.result ?? '') + String(message?.detail ?? '');
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
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
