/**
 * Pi app-answer real-TUI trace (OPT-IN, real model).
 *
 * Starts a real interactive `pi` TUI in tmux with the cosyncing bridge extension loaded, opens
 * the real cosyncing app in Chromium, triggers the bridge-owned permission gate from a TUI
 * prompt, clicks Allow in the app DOM, and proves the approved bash command ran.
 *
 * Scope note: this is the live-bridge permission path. Pi TUI-mode extensions cannot produce native
 * question dialogs for the app; question answerability is covered by the Pi resume/RPC path and the
 * deterministic bridge-wire trace.
 *
 *   COSYNCING_PI_REAL_TUI_APP_ANSWER=1 COSYNCING_PI_USE_USER_CONFIG=1 COSYNCING_PI_TUI_MODEL=vLLM/model bun run scripts/broker/tests_traces/pi-app-answer-real-tui-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const enabled = process.env.COSYNCING_PI_REAL_TUI_APP_ANSWER === '1';
if (!enabled) {
  console.log('SKIP pi real-TUI app-answer - set COSYNCING_PI_REAL_TUI_APP_ANSWER=1 (opt-in: real model + browser)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const MODEL = process.env.COSYNCING_PI_TUI_MODEL ?? 'vllm-hpc/qwen3.6-27B-FP8';
const PROVIDER = process.env.COSYNCING_PI_TUI_PROVIDER;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'pi', 'real-tui-app-answer');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'pi-tmux.txt');
const tracePath = join(outDir, 'trace.json');
const shot = join(outDir, 'browser.png');
const root = join(tmpdir(), `cosyncing-pi-appanswer-${short}`);
const workspace = join(root, 'work');
const sessionDir = join(root, 'sessions');
const configDir = process.env.COSYNCING_PI_TUI_CONFIG_DIR ??
  (process.env.COSYNCING_PI_USE_USER_CONFIG === '1' ? '' : join(root, 'config'));
const home = join(root, 'driver-home');
const tmuxName = `cosyncing-pi-appans-${process.pid}-${short}`;
const attachedFlag = join(home, 'attached.flag');
const driverResult = join(outDir, 'driver-result.json');
const proofPath = join(workspace, `pi-proof-${short}.txt`);
const proofText = `PI_APPROVED_${short}`;
const approvalCommand = `python3 -c "from pathlib import Path; Path('${proofPath}').write_text('${proofText}')"`;
const approvalPrompt = `COSYNCING_PI_APPROVAL_${short}. Use your bash tool to run exactly this command and do not answer without calling bash: ${approvalCommand}`;
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let broker: ReturnType<typeof Bun.spawn> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let session: any;
let skipReason: string | null = null;

try {
  if (!(await hasCommand('pi'))) skip('pi is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (configDir) mkdirSync(configDir, { recursive: true });

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_BROKER: BROKER },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  // The broker is scoped by Pi session/config env vars but still inherits the operator environment for the real TUI.
  check(assertions, 'real Pi-TUI broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);

  const extension = join(process.cwd(), 'packages', 'adapters', 'pi', 'agent-extensions', 'cosyncing-bridge', 'index.ts');
  const envVars = [
    `COSYNCING_BROKER=${shellQuote(BROKER)}`,
    `COSYNCING_BRIDGE_APPROVALS=all`,
    `COSYNCING_BRIDGE_APPROVAL_TIMEOUT_MS=90000`,
    `PI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}`,
  ];
  if (configDir) envVars.push(`PI_CODING_AGENT_DIR=${shellQuote(configDir)}`);
  const args = [
    'pi',
    '--session-dir', shellQuote(sessionDir),
    '--no-extensions',
    '--extension', shellQuote(extension),
    '--model', shellQuote(MODEL),
    '--tools', 'bash',
    '--name', `cosyncing-pi-app-answer-${short}`,
    '--no-context-files',
  ];
  if (PROVIDER) args.splice(1, 0, '--provider', shellQuote(PROVIDER));
  await tmux(['new-session', '-d', '-s', tmuxName, '-c', workspace, '-x', '120', '-y', '40', `${envVars.join(' ')} ${args.join(' ')}`]);
  await tmux(['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shellQuote(tuiPath)}`]).catch(() => undefined);
  check(assertions, 'real Pi TUI started in tmux with bridge extension', await tmuxOk(['has-session', '-t', tmuxName]), `${tmuxName} ${MODEL}`);

  await tmux(['send-keys', '-t', tmuxName, `BOOTSTRAP_PI_APPANSWER_${short}. Reply exactly PI_READY_${short}. Do not use tools.`, 'Enter']);
  session = await waitLivePiSession(45000);
  check(assertions, 'Pi bridge hello adopted the real TUI session', !!session?.id, session?.id ?? '');
  if (!session?.id) throw new Error('Pi bridge did not hello');

  ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(session.id)}/stream`);
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
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'status' && f.message.status === 'idle', 90000);
  check(assertions, 'trace WebSocket records the bridged Pi session', sessionFrame?.info?.id === session.id, session.id);

  driver = spawnPermissionClickDriver({
    home,
    base: BROKER,
    token: short,
    screenshot: shot,
    attachedFlag,
    resultFile: driverResult,
    tool: 'pi',
    sessionId: session.id,
  });
  const attached = await waitForFile(attachedFlag, 60000);
  check(assertions, 'real browser attaches to the Pi session before approval trigger', attached, attachedFlag);
  if (!attached) throw new Error('browser never attached to Pi session');

  const mark = frames.length;
  const permissionFrame = await submitTuiPromptAndWaitFrame({
    tmuxName,
    prompt: approvalPrompt,
    frames,
    predicate: (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-request',
    timeoutMs: 90000,
  });
  if (!permissionFrame) skip('INCONCLUSIVE: real Pi model did not raise a permission request within 90s');
  check(assertions, 'real Pi TUI raised a permission request after one submitted prompt', !!permissionFrame?.message?.requestId, permissionFrame?.message?.requestId ?? '');

  const driverOut = await waitForJsonFile(driverResult, 150000);
  await driver.exited.catch(() => undefined);
  check(assertions, 'browser driver produced a result', !!driverOut, driverResult);
  if (driverOut?.skip) skip(`browser skipped: ${driverOut.skip}`);
  check(assertions, 'real app DOM showed an actionable Pi permission card', driverOut?.cardShown === true && driverOut?.card?.hasAllow === true, JSON.stringify(driverOut?.card ?? driverOut));
  check(assertions, 'real app DOM clicked Allow', driverOut?.approved === true, JSON.stringify(driverOut));

  const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message?.decision !== 'reject', 30000);
  check(assertions, 'Allow resolves through the Pi bridge permission command', !!resolved, resolved?.message?.decision ?? '');
  const proof = await waitForFile(proofPath, 90000);
  check(assertions, 'approved Pi bash command created the proof file', proof && readFileSync(proofPath, 'utf8') === proofText, proofPath);

  appendFileSync(tuiPath, `\n\n--- capture-pane ---\n${await tmuxCapture(tmuxName, 3000)}`);
  const tui = readFileSync(tuiPath, 'utf8');
  check(assertions, 'tmux capture contains post-approval shell execution evidence', /\$\s*python3[\s\S]{0,800}PI_APPROVED/.test(tui), tuiPath);
} catch (err) {
  if (!skipReason) check(assertions, 'pi real-TUI app-answer completed without exception', false, String(err));
  try {
    appendFileSync(tuiPath, `\n\n--- capture-pane ---\n${await tmuxCapture(tmuxName, 3000)}`);
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
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  try {
    broker?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'pi',
    scenarioIds: ['ST-14'],
    mode: 'real-tui-app-answer',
    broker: BROKER,
    workspace,
    tmuxName,
    model: MODEL,
    provider: PROVIDER,
    output: { frames: framesPath, broker: brokerPath, tui: tuiPath, screenshot: shot },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
    limitation: 'Live Pi TUI bridge can answer permission prompts; native interactive questions remain terminal-only in TUI mode.',
  }, null, 2));
  rmSync(root, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function skip(reason: string): never {
  skipReason = reason;
  throw new Error(reason);
}

async function waitLivePiSession(ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const data: any = await (await fetch(`${BROKER}/api/sessions`)).json();
      const sessions: any[] = Array.isArray(data) ? data : data.sessions ?? [];
      const found = sessions.find((s) => s.tool === 'pi' && s.cwd === workspace && s.control?.terminalSync?.active === true);
      if (found) return found;
    } catch {
      /* not ready */
    }
    if (Date.now() > end) return undefined;
    await sleep(250);
  }
}

function brokerTail(): string {
  try {
    return readFileSync(brokerPath, 'utf8').slice(-2000);
  } catch {
    return '<no broker output captured>';
  }
}
