/**
 * Codex broad real-TUI surface trace (OPT-IN, real binary + model).
 *
 * Proves Wave 1.1's Codex broad-surface slice against a real `codex app-server` and real tmux TUI:
 * model/effort/status metadata, commands/options, tool execution, file artifact, final response, and
 * lifecycle downgrade when the app-server owner disappears. It records whether task-list/todo appeared but
 * does not claim that surface unless real Codex emits it.
 *
 *   COSYNCING_CODEX_REAL_BROAD_SURFACE=1 bun run scripts/broker/tests_traces/codex-broad-real-tui-surface-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Assertion,
  archiveCodexDaemonThread,
  check,
  command,
  drainProcessOutput,
  freePort,
  hasCommand,
  probeCodexDaemon,
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

const enabled = process.env.COSYNCING_CODEX_REAL_BROAD_SURFACE === '1';
if (!enabled) {
  console.log('SKIP codex broad real-TUI surface - set COSYNCING_CODEX_REAL_BROAD_SURFACE=1');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'broad-real-tui-surface');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const appServerPath = join(outDir, 'app-server.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const appServerRoot = mkdtempSync(join(tmpdir(), `cosyncing-codex-broad-appserver-${short}-`));
const sock = join(appServerRoot, 'app-server.sock');
const remote = `unix://${sock}`;
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-codex-broad-${short}-`));
const tmuxName = `cosyncing-codex-broad-${process.pid}-${short}`;
const model = process.env.COSYNCING_CODEX_BROAD_MODEL ?? 'gpt-5.4-mini';
const effort = process.env.COSYNCING_CODEX_BROAD_EFFORT ?? 'low';
const artifactName = `broad-${short}.txt`;
const artifactMarker = `COSYNCING_BROAD_ARTIFACT_${short}`;
const doneMarker = `COSYNCING_BROAD_DONE_${short}`;
const prompt = [
  `COSYNCING_BROAD_SURFACE_${short}`,
  'Do these steps exactly:',
  '1. Create a native Codex plan/update_plan with three tasks: inspect broad trace, create artifact, report done. Mark the first in_progress.',
  `2. Run a shell command that creates .cosyncing/outbox/${artifactName} containing exactly ${artifactMarker}.`,
  `3. Reply exactly ${doneMarker}.`,
  'Do not skip the shell command.',
].join('\n');

const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let appServer: ReturnType<typeof Bun.spawn> | undefined;
let broker: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let threadId = '';
let sessionId = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('codex'))) skip('codex is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  appServer = Bun.spawn(['codex', 'app-server', '--listen', remote], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  drainProcessOutput(appServer, appServerPath);
  check(assertions, 'temporary real Codex app-server socket appears', await waitForFile(sock, 15000), remote);
  if (!assertions.at(-1)?.ok) throw new Error(`Codex app-server did not create socket: ${fileTail(appServerPath)}`);
  const probe = await probeCodexDaemon(sock);
  check(assertions, 'real Codex app-server WebSocket probe succeeds', probe.ok, probe.detail);
  if (!probe.ok) throw new Error(probe.detail);

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      COSYNCING_CODEX_SYNC_SERVER: '1',
      COSYNCING_CODEX_SYNC_WATCH_MS: '250',
      COSYNCING_CODEX_APP_SERVER_SOCK: sock,
      COSYNCING_CODEX_REMOTE_ADDR: remote,
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  check(assertions, 'sync-enabled broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start: ${fileTail(brokerPath)}`);

  await tmux(['new-session', '-d', '-s', tmuxName, '-c', workspace]);
  const cmd = [
    'codex',
    '--remote',
    shellQuote(remote),
    '-C',
    shellQuote(workspace),
    '-m',
    shellQuote(model),
    '-c',
    shellQuote(`model_reasoning_effort="${effort}"`),
    '-s',
    'workspace-write',
    '-a',
    'untrusted',
    '-c',
    'check_for_update_on_startup=false', // a fresh release otherwise blocks the TUI on an interactive update gate
    '--no-alt-screen',
    shellQuote(`COSYNCING_BROAD_BOOT_${short}: reply exactly BROAD_BOOT_OK_${short}. Do not run tools.`),
  ].join(' ');
  await tmux(['send-keys', '-t', tmuxName, '--', cmd, 'C-m']);
  check(assertions, 'real Codex TUI launched in tmux', await tmuxOk(['has-session', '-t', tmuxName]), `${model}/${effort}`);

  const visible = await waitForLiveSession();
  sessionId = String(visible.id ?? '');
  threadId = codexThreadId(visible);
  check(assertions, 'broker discovers real Codex TUI thread', !!sessionId && !!threadId, `${sessionId} thread=${threadId}`);
  check(assertions, 'session starts synced with target model/effort', visible?.currentModel?.modelID === model && visible?.currentModel?.reasoningEffort === effort, JSON.stringify(visible?.currentModel ?? null));

  ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream`);
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
  await waitFrame(frames, (f) => f.kind === 'history', 10000);
  const options = await waitFrame(frames, (f) => f.kind === 'options', 10000);
  const commands = await waitFrame(frames, (f) => f.kind === 'commands', 10000);
  check(assertions, 'options expose model/effort surface', (options?.models ?? []).some((m: any) => m.modelID === model && (m.reasoningEfforts ?? []).some((r: any) => r.effort === effort)), JSON.stringify(options?.models ?? []));
  check(assertions, 'commands expose lifecycle command surface', (commands?.commands ?? []).some((c: any) => c.name === 'stop') && (commands?.commands ?? []).some((c: any) => c.name === 'compact'), JSON.stringify(commands?.commands ?? []));

  const mark = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: prompt, model: { providerID: 'openai', modelID: model, reasoningEffort: effort } }));
  const toolActivity = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && (f.message?.type === 'tool-call' || f.message?.type === 'tool-result'), 120000);
  check(assertions, 'real Codex broad turn emits tool activity surface', !!toolActivity, JSON.stringify(toolActivity?.message ?? null));
  const artifact = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'file-artifact' && JSON.stringify(f.message).includes(artifactName), 120000);
  check(assertions, 'real Codex broad turn surfaces outbox file artifact', !!artifact, JSON.stringify(artifact?.message ?? null));
  const done = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && modelFrameText(f).includes(doneMarker), 120000);
  check(assertions, 'real Codex broad turn final response reaches app stream', !!done, doneMarker);
  const taskList = frames.find((f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'task-list-state');
  check(assertions, 'real Codex broad turn surfaces native/task-list-state plan', !!taskList, JSON.stringify(taskList?.message ?? null));
  const nativeArtifact = join(workspace, '.cosyncing', 'outbox', artifactName);
  check(assertions, 'artifact file exists in real workspace with marker', readFileSafe(nativeArtifact).includes(artifactMarker), nativeArtifact);

  const capture = await tmuxCapture(tmuxName, 3000);
  writeFileSync(tuiPath, capture);
  check(assertions, 'tmux capture shows broad prompt/result and model surface', capture.includes(`COSYNCING_BROAD_SURFACE_${short}`) && capture.includes(model) && capture.toLowerCase().includes(effort), tuiPath);

  appServer.kill();
  appServer = undefined;
  const degraded = await waitFrame(
    frames,
    (f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === false && f.info?.control?.drive?.state === 'observing',
    30000,
  );
  check(assertions, 'real Codex owner disappearance downgrades broad trace socket', !!degraded, JSON.stringify(degraded?.info?.control ?? null));
  const beforeReject = frames.length;
  ws.send(JSON.stringify({ kind: 'prompt', text: `AFTER_DEGRADE_${short}` }));
  const reject = await waitFrame(frames, (f) => frames.indexOf(f) >= beforeReject && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 5000);
  check(assertions, 'downgraded broad trace socket rejects prompts', !!reject, String(reject?.message ?? ''));
} catch (err) {
  if (!skipReason) check(assertions, 'codex broad real-TUI surface completed without exception', false, String(err));
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
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (appServer && threadId) {
    const archived = await archiveCodexDaemonThread(sock, threadId);
    check(assertions, 'real Codex broad test thread archived during cleanup', archived.ok, archived.detail);
  }
  try {
    appServer?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'codex',
    scenarioIds: ['ST-01', 'ST-07', 'ST-12', 'ST-13', 'ST-17', 'ST-20', 'ST-32'],
    mode: 'broad-real-tui-surface',
    broker: BROKER,
    workspace,
    tmuxName,
    model: { providerID: 'openai', modelID: model, reasoningEffort: effort },
    remote,
    sessionId,
    threadId,
    output: { frames: framesPath, broker: brokerPath, appServer: appServerPath, tui: tuiPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(appServerRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function skip(reason: string): never {
  skipReason = reason;
  throw new Error(reason);
}

async function waitForLiveSession(): Promise<any> {
  const end = Date.now() + 120000;
  let last: any;
  for (;;) {
    const body: any = await (await fetch(`${BROKER}/api/sessions`)).json();
    const sessions: any[] = Array.isArray(body) ? body : body.sessions ?? [];
    const visible = sessions.find((s) => s.tool === 'codex' && (s.cwd === workspace || JSON.stringify(s).includes(workspace)));
    if (visible) {
      last = visible;
      if (visible.attachMode === 'live' && visible.control?.terminalSync?.active === true) return visible;
    }
    if (Date.now() > end) throw new Error(`Codex session did not become live; last=${JSON.stringify(last?.control ?? last ?? null)}`);
    await sleep(1000);
  }
}

function codexThreadId(session: any): string {
  const hint = String(session?.terminalSyncHint?.command ?? '');
  const fromHint = hint.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (fromHint) return fromHint;
  try {
    const raw = String(session?.id ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const path = Buffer.from(raw, 'base64').toString('utf8');
    return path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? '';
  } catch {
    return '';
  }
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
