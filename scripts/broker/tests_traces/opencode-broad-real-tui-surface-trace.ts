/**
 * OpenCode broad real-TUI surface trace (OPT-IN, real binary + model).
 *
 * Starts a throwaway real `opencode serve`, attaches a real `opencode attach` TUI in tmux,
 * attaches the broker/app socket, then proves the broad surface in one run: live session
 * discovery, model/options, commands, tool activity, outbox artifact surfacing, final response,
 * and read-only downgrade when the real serve owner disappears. It records task-list/todo
 * availability honestly but does not claim that surface unless real OpenCode emits it.
 *
 *   COSYNCING_OPENCODE_REAL_BROAD_SURFACE=1 bun run scripts/broker/tests_traces/opencode-broad-real-tui-surface-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Assertion,
  check,
  command,
  drainProcessOutput,
  freePort,
  hasCommand,
  record,
  shellQuote,
  sleep,
  tmux,
  tmuxCapture,
  tmuxOk,
  waitForFile,
  waitFrame,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_OPENCODE_REAL_BROAD_SURFACE === '1';
if (!enabled) {
  console.log('SKIP opencode broad real-TUI surface - set COSYNCING_OPENCODE_REAL_BROAD_SURFACE=1');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const OC_PORT = Number(process.env.COSYNCING_OC_TEST_PORT ?? await freePort());
const OC = `http://127.0.0.1:${OC_PORT}`;
const MODEL = {
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
  id: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'broad-real-tui-surface');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-opencode-broad-${short}-`));
const tmuxName = `cosyncing-oc-broad-${process.pid}-${short}`;
const artifactName = `broad-${short}.txt`;
const artifactMarker = `OPENCODE_BROAD_ARTIFACT_${short}`;
const doneMarker = `OPENCODE_BROAD_DONE_${short}`;
const prompt = [
  `COSYNCING_OPENCODE_BROAD_SURFACE_${short}`,
  'Do these steps exactly:',
  '1. If you have a todo/task tool, record three tasks: inspect broad trace, create artifact, report done.',
  `2. Use your bash tool to create .cosyncing/outbox/${artifactName} containing exactly ${artifactMarker}.`,
  `3. Reply exactly ${doneMarker}.`,
  'Do not skip the bash tool call.',
].join('\n');

const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let broker: ReturnType<typeof Bun.spawn> | undefined;
let opencodeServe: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let sessionId = '';
let servedModel = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('opencode'))) skip('opencode is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  opencodeServe = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(OC_PORT), '--print-logs'], {
    cwd: workspace,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(opencodeServe, nativePath);
  check(assertions, 'throwaway real opencode serve starts', await waitHealth(`${OC}/global/health`, 20000), OC);
  if (!assertions.at(-1)?.ok) throw new Error(`opencode serve did not start: ${fileTail(nativePath)}`);

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPENCODE_URL: OC },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  check(assertions, 'real OpenCode-server broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start: ${fileTail(brokerPath)}`);

  sessionId = await createSession();
  check(assertions, 'throwaway OpenCode session created on trace model', /^ses/.test(sessionId), `${sessionId} ${MODEL.providerID}/${MODEL.id}`);

  await tmux(['new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '40', `opencode attach ${shellQuote(OC)} -s ${shellQuote(sessionId)} --dir ${shellQuote(workspace)}`]);
  check(assertions, 'real OpenCode attach TUI started in tmux', await tmuxOk(['has-session', '-t', tmuxName]), tmuxName);
  await sleep(2500);
  await request(OC, `/tui/select-session?directory=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: sessionId }),
  }).catch(() => undefined);

  ws = new WebSocket(`${WSBASE}/api/sessions/opencode/${encodeURIComponent(sessionId)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
      const msg = frame?.message;
      if (frame.kind === 'message' && msg?.type === 'permission-request' && !msg.readOnly) {
        ws?.send(JSON.stringify({ kind: 'approve', requestId: msg.requestId, decision: 'approve' }));
      }
      if (frame.kind === 'message' && msg?.type === 'question-request' && !msg.readOnly) {
        ws?.send(JSON.stringify({ kind: 'answer', requestId: msg.requestId, answers: [['Proceed']] }));
      }
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('trace WebSocket failed'));
  });
  const session = await waitFrame(frames, (f) => f.kind === 'session', 10000);
  check(assertions, 'broker attaches to the real OpenCode shared-server session', !!session, sessionId);
  check(assertions, 'session starts drivable through shared-server control metadata', session?.info?.control?.drive?.state === 'driving', JSON.stringify(session?.info?.control ?? null));
  const options = await waitFrame(frames, (f) => f.kind === 'options', 10000);
  const commands = await waitFrame(frames, (f) => f.kind === 'commands', 10000);
  check(assertions, 'options expose OpenCode model surface', (options?.models ?? []).some((m: any) => m.providerID === MODEL.providerID && m.modelID === MODEL.id), JSON.stringify(options?.models ?? []));
  check(assertions, 'commands expose lifecycle command surface', (commands?.commands ?? []).some((c: any) => c.name === 'stop') && (commands?.commands ?? []).some((c: any) => c.name === 'compact'), JSON.stringify(commands?.commands ?? []));

  const mark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: prompt, model: { providerID: MODEL.providerID, modelID: MODEL.id } }));
  const userEcho = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'user-message' && String(f.message.text ?? '').includes(`COSYNCING_OPENCODE_BROAD_SURFACE_${short}`), 15000);
  check(assertions, 'broad prompt reaches real OpenCode session', !!userEcho, userEcho?.message?.key ?? '');
  const toolActivity = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && (f.message?.type === 'tool-call' || f.message?.type === 'tool-result'), 120000);
  check(assertions, 'real OpenCode broad turn emits tool activity surface', !!toolActivity, JSON.stringify(toolActivity?.message ?? null));
  const artifact = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'file-artifact' && JSON.stringify(f.message).includes(artifactName), 120000);
  check(assertions, 'real OpenCode broad turn surfaces outbox file artifact', !!artifact, JSON.stringify(artifact?.message ?? null));
  const done = await waitForAccumulatedModelText(mark, doneMarker, 120000);
  check(assertions, 'real OpenCode broad turn final response reaches app stream', done, doneMarker);
  const taskList = frames.find((f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'task-list-state');
  check(assertions, 'real OpenCode broad trace records task-list/todo availability honestly', true, taskList ? 'observed task-list-state' : 'NOT_OBSERVED: real broad turn did not emit task-list-state');
  const nativeArtifact = join(workspace, '.cosyncing', 'outbox', artifactName);
  check(assertions, 'artifact file exists in real workspace with marker', readFileSafe(nativeArtifact).includes(artifactMarker), nativeArtifact);

  const capture = await tmuxCapture(tmuxName, 3000);
  writeFileSync(tuiPath, capture);
  servedModel = extractOpenCodeServedModel(capture);
  check(assertions, 'tmux capture shows broad result and requested model surface', capture.includes(doneMarker) && capture.toLowerCase().includes('qwen'), tuiPath);

  opencodeServe.kill();
  opencodeServe = undefined;
  const degraded = await waitFrame(
    frames,
    (f) => f.kind === 'session' && ['observing', 'unavailable'].includes(String(f.info?.control?.drive?.state ?? '')) && f.info?.control?.terminalSync?.active === false,
    30000,
  );
  check(assertions, 'real OpenCode serve disappearance downgrades broad trace socket', !!degraded, JSON.stringify(degraded?.info?.control ?? null));
  const beforeReject = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `AFTER_OPENCODE_DEGRADE_${short}` }));
  const reject = await waitFrame(frames, (f) => frames.indexOf(f) >= beforeReject && f.kind === 'error' && /read-only observe session|not drivable|unavailable/i.test(String(f.message ?? '')), 5000);
  check(assertions, 'downgraded broad trace socket rejects prompts', !!reject, String(reject?.message ?? ''));
} catch (err) {
  if (!skipReason) check(assertions, 'opencode broad real-TUI surface completed without exception', false, String(err));
} finally {
  try {
    if (!readFileSafe(tuiPath)) writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  } catch {
    /* no pane */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (sessionId && opencodeServe) {
    await deleteSession(sessionId).catch(() => undefined);
  }
  try {
    opencodeServe?.kill();
  } catch {
    /* ignore */
  }
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'opencode',
    scenarioIds: ['ST-01', 'ST-03', 'ST-07', 'ST-12', 'ST-13', 'ST-17', 'ST-20', 'ST-32'],
    mode: 'broad-real-tui-surface',
    broker: BROKER,
    opencode: OC,
    workspace,
    tmuxName,
    model: { requested: MODEL, served: servedModel || undefined },
    sessionId,
    output: { frames: framesPath, native: nativePath, broker: brokerPath, tui: tuiPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function skip(reason: string): never {
  skipReason = reason;
  throw new Error(reason);
}

async function createSession(): Promise<string> {
  const res = await request(OC, `/session?directory=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `cosyncing-opencode-broad-${short}`,
      model: MODEL,
      permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    }),
  });
  if (!res.ok) throw new Error(`create OpenCode session ${res.status}: ${await res.text()}`);
  return String((await res.json()).id ?? '');
}

async function deleteSession(id: string): Promise<void> {
  await request(OC, `/session/${id}?directory=${encodeURIComponent(workspace)}`, { method: 'DELETE' }).catch(() => undefined);
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  record(nativePath, { direction: 'trace->native', url: `${base}${path}`, method: init.method ?? 'GET', body: init.body });
  const res = await fetch(`${base}${path}`, init);
  record(nativePath, { direction: 'native->trace', url: `${base}${path}`, status: res.status });
  return res;
}

function textOf(frame: any): string {
  const message = frame?.message ?? frame;
  return String(message?.text ?? '') + String(message?.delta ?? '') + String(message?.result ?? '') + String(message?.detail ?? '');
}

function modelFrameText(frame: any): string {
  if (frame?.kind === 'history' && Array.isArray(frame.messages)) return frame.messages.filter((m: any) => m?.type === 'model-output').map((m: any) => textOf(m)).join('\n');
  if (frame?.kind === 'message' && frame?.message?.type !== 'model-output') return '';
  if (frame?.type && frame.type !== 'model-output') return '';
  return textOf(frame);
}

async function waitForAccumulatedModelText(startIndex: number, needle: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const text = frames.slice(startIndex).map(modelFrameText).join('');
    if (text.includes(needle)) return true;
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function fileTail(path: string): string {
  return readFileSafe(path).slice(-2000) || '<no output captured>';
}

function extractOpenCodeServedModel(tui: string): string {
  const cleaned = tui.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const build = cleaned.match(/Build\s*[·-]\s*([A-Za-z0-9_.:/-]+)/i)?.[1];
  return build ? build.trim() : '';
}
