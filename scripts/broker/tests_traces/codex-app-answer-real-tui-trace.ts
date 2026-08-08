/**
 * Codex app-answer real-TUI trace (OPT-IN, real model).
 *
 * Starts a temporary real Codex app-server plus a real Codex TUI in tmux, opens the real Code
 * Anywhere app in Chromium, triggers a real command approval from the TUI, clicks Allow in the app
 * DOM, and proves the approved command ran by checking a proof file in the throwaway workspace.
 *
 *   COSYNCING_CODEX_REAL_TUI=1 bun run scripts/broker/tests_traces/codex-app-answer-real-tui-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  spawnPermissionClickDriver,
  submitTuiPromptAndWaitFrame,
  tmux,
  tmuxCapture,
  tmuxOk,
  waitForFile,
  waitFrame,
  waitForJsonFile,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_CODEX_REAL_TUI === '1';
if (!enabled) {
  console.log('SKIP codex real-TUI app-answer - set COSYNCING_CODEX_REAL_TUI=1 (opt-in: real model + browser)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'real-tui-app-answer');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const shot = join(outDir, 'browser.png');
const model = process.env.COSYNCING_CODEX_TEST_MODEL ?? 'gpt-5.3-codex-spark';
const effort = process.env.COSYNCING_CODEX_TEST_EFFORT ?? 'low';
const providedRemote = process.env.COSYNCING_CODEX_REMOTE_ADDR?.trim();
const providedSock = process.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim() || (providedRemote?.startsWith('unix://') ? providedRemote.slice('unix://'.length) : undefined);
const appServerRoot = mkdtempSync(join(tmpdir(), `cosyncing-codex-appserver-${short}-`));
const sock = providedSock ?? join(appServerRoot, 'app-server.sock');
const remote = providedRemote ?? `unix://${sock}`;
const ownsAppServer = !providedSock && !providedRemote;
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-codex-appanswer-${short}-`));
const home = mkdtempSync(join(tmpdir(), `cosyncing-codex-appanswer-home-${short}-`));
const tmuxName = `cosyncing-codex-appans-${process.pid}-${short}`;
const attachedFlag = join(home, 'attached.flag');
const driverResult = join(outDir, 'driver-result.json');
const appServerPath = join(outDir, 'app-server.ndjson');
const proofPath = join(workspace, `codex-proof-${short}.txt`);
const proofText = `CODEX_APPROVED_${short}`;
const initPrompt = `COSYNCING_INIT_${short}: reply exactly INIT_OK_${short}. Do not run tools.`;
const approvalCommand = `python3 -c "from pathlib import Path; Path('${proofPath}').write_text('${proofText}')"`;
const approvalPrompt = `COSYNCING_CODEX_APPROVAL_${short}: You must run this exact shell command before answering: ${approvalCommand}`;
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let broker: ReturnType<typeof Bun.spawn> | undefined;
let appServer: ReturnType<typeof Bun.spawn> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let threadId = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('codex'))) skip('codex is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');
  if (providedRemote && !providedRemote.startsWith('unix://') && !providedSock) {
    skip('Codex trace needs COSYNCING_CODEX_APP_SERVER_SOCK when COSYNCING_CODEX_REMOTE_ADDR is not unix://');
  }
  if (!ownsAppServer && !existsSync(sock)) skip(`Codex app-server socket missing: ${sock}`);
  if (ownsAppServer) {
    appServer = Bun.spawn(['codex', 'app-server', '--listen', remote], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    drainProcessOutput(appServer, appServerPath);
    check(assertions, 'temporary real Codex app-server socket appears', await waitForFile(sock, 15000), remote);
    if (!assertions.at(-1)?.ok) throw new Error(`temporary Codex app-server did not create ${sock}: ${fileTail(appServerPath)}`);
  }
  const probe = await probeCodexDaemon(sock);
  check(assertions, 'real Codex app-server WebSocket probe succeeds', probe.ok, probe.detail);
  if (!probe.ok) throw new Error(`Codex app-server probe failed at ${remote}: ${probe.detail}`);

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      COSYNCING_CODEX_SYNC_SERVER: '1',
      COSYNCING_CODEX_APP_SERVER_SOCK: sock,
      COSYNCING_CODEX_REMOTE_ADDR: remote,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  // Codex live discovery intentionally uses the operator's real CODEX_HOME/daemon state; this is not HOME-isolated.
  check(assertions, 'real-CODEX_HOME sync-enabled broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);

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
    shellQuote(initPrompt),
  ].join(' ');
  await tmux(['send-keys', '-t', tmuxName, '--', cmd, 'C-m']);
  check(assertions, 'real Codex TUI launched in tmux with approval prompts enabled', await tmuxOk(['has-session', '-t', tmuxName]), `${model}/${effort}`);

  const visible = await waitForLiveSession();
  threadId = codexThreadId(visible);
  check(assertions, 'broker discovers real Codex TUI thread', !!visible?.id, visible?.id ?? '');
  check(assertions, 'real Codex thread is live true-sync', visible?.attachMode === 'live' && visible?.control?.terminalSync?.active === true, JSON.stringify(visible?.control));

  ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(visible.id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      record(framesPath, frame);
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('trace WebSocket failed'));
  });
  const history = await waitFrame(frames, (f) => f.kind === 'history', 10000);
  check(assertions, 'trace WebSocket records the real thread', !!history && frames.some((f) => f.kind === 'session' && f.info?.id === visible.id), visible.id);

  const initSeen = await waitForModelText(`INIT_OK_${short}`, 120000);
  check(assertions, 'initial real Codex response reaches the app stream', initSeen, `INIT_OK_${short}`);

  driver = spawnPermissionClickDriver({
    home,
    base: BROKER,
    token: short,
    screenshot: shot,
    attachedFlag,
    resultFile: driverResult,
    tool: 'codex',
    sessionId: visible.id,
  });

  const attached = await waitForFile(attachedFlag, 60000);
  check(assertions, 'real browser attaches to the Codex session before approval trigger', attached, attachedFlag);
  if (!attached) throw new Error('browser never attached to Codex session');

  const mark = frames.length;
  const permissionFrame = await submitTuiPromptAndWaitFrame({
    tmuxName,
    prompt: approvalPrompt,
    frames,
    predicate: (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-request',
    timeoutMs: 90000,
  });
  if (!permissionFrame) skip('INCONCLUSIVE: real Codex model did not raise a permission request within 90s');
  check(assertions, 'real Codex TUI raised a permission request after one submitted prompt', !!permissionFrame?.message?.requestId, permissionFrame?.message?.requestId ?? '');

  const driverOut = await waitForJsonFile(driverResult, 150000);
  await driver.exited.catch(() => undefined);
  check(assertions, 'browser driver produced a result', !!driverOut, driverResult);
  if (driverOut?.skip) skip(`browser skipped: ${driverOut.skip}`);
  check(assertions, 'real app DOM showed an actionable Codex permission card', driverOut?.cardShown === true && driverOut?.card?.hasAllow === true, JSON.stringify(driverOut?.card ?? driverOut));
  check(assertions, 'real app DOM clicked Allow', driverOut?.approved === true, JSON.stringify(driverOut));

  const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message?.decision !== 'reject', 30000);
  check(assertions, 'Allow resolves through the Codex app-server approval channel', !!resolved, resolved?.message?.decision ?? '');
  const proof = await waitForFile(proofPath, 90000);
  check(assertions, 'approved Codex command created the proof file', proof && readFileSync(proofPath, 'utf8') === proofText, proofPath);

  writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  const tui = readFileSync(tuiPath, 'utf8');
  check(assertions, 'tmux capture contains post-approval command execution evidence', /Ran python3/.test(tui) && tui.includes(proofText), tuiPath);
} catch (err) {
  if (!skipReason) check(assertions, 'codex real-TUI app-answer completed without exception', false, String(err));
  try {
    writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  } catch {
    /* no pane */
  }
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    driver?.kill();
  } catch {
    /* ignore */
  }
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (threadId) {
    const archived = await archiveCodexDaemonThread(sock, threadId);
    check(assertions, 'real Codex test thread archived during cleanup', archived.ok, archived.detail);
  }
  try {
    appServer?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'codex',
    scenarioIds: ['ST-14'],
    mode: 'real-tui-app-answer',
    broker: BROKER,
    workspace,
    tmuxName,
    model,
    effort,
    remote,
    appServer: { owned: ownsAppServer, socket: sock, log: appServerPath },
    output: { frames: framesPath, broker: brokerPath, tui: tuiPath, screenshot: shot },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
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
    const resp = await fetch(`${BROKER}/api/sessions`);
    const body: any = await resp.json();
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

function brokerTail(): string {
  try {
    return readFileSync(brokerPath, 'utf8').slice(-2000);
  } catch {
    return '<no broker output captured>';
  }
}

function fileTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output captured>';
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

async function waitForModelText(text: string, ms: number): Promise<boolean> {
  return !!(await waitFrame(frames, (f) => modelFrameText(f).includes(text), ms));
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
