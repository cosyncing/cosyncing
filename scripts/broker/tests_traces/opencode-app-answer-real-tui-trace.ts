/**
 * OpenCode app-answer real-TUI trace (OPT-IN, real model).
 *
 * Starts a throwaway OpenCode shared-server session, attaches a real `opencode attach` TUI in tmux,
 * opens the real cosyncing app in Chromium, types a tool-using prompt into the TUI, clicks Allow
 * in the app DOM, and proves the approved shell command ran.
 *
 * If $OC/$OPENCODE_URL is set, uses that real `opencode serve`; otherwise starts a throwaway real
 * `opencode serve` on a free local port for the trace.
 *
 *   COSYNCING_OPENCODE_REAL_TUI=1 bun run scripts/broker/tests_traces/opencode-app-answer-real-tui-trace.ts
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

const enabled = process.env.COSYNCING_OPENCODE_REAL_TUI === '1';
if (!enabled) {
  console.log('SKIP opencode real-TUI app-answer - set COSYNCING_OPENCODE_REAL_TUI=1 (opt-in: real model + browser)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const providedOC = process.env.OC ?? process.env.OPENCODE_URL;
const ownsOpenCodeServe = !providedOC;
const OC_PORT = Number(process.env.COSYNCING_OC_TEST_PORT ?? await freePort());
const OC = (providedOC ?? `http://127.0.0.1:${OC_PORT}`).replace(/\/$/, '');
const MODEL = {
  id: process.env.OPENCODE_TRACE_MODEL_ID ?? 'qwen3.6-27B-FP8',
  providerID: process.env.OPENCODE_TRACE_PROVIDER_ID ?? 'vllm-hpc',
};
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'real-tui-app-answer');
const framesPath = join(outDir, 'frames.ndjson');
const nativePath = join(outDir, 'opencode.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'tmux.txt');
const tracePath = join(outDir, 'trace.json');
const shot = join(outDir, 'browser.png');
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-opencode-appanswer-${short}-`));
const home = mkdtempSync(join(tmpdir(), `cosyncing-opencode-appanswer-home-${short}-`));
const tmuxName = `cosyncing-oc-appans-${process.pid}-${short}`;
const attachedFlag = join(home, 'attached.flag');
const driverResult = join(outDir, 'driver-result.json');
const proofPath = join(workspace, `opencode-proof-${short}.txt`);
const proofText = `OPENCODE_APPROVED_${short}`;
const approvalCommand = `python3 -c "from pathlib import Path; Path('${proofPath}').write_text('${proofText}')"`;
const approvalPrompt = `COSYNCING_OPENCODE_APPROVAL_${short}. Use your bash tool to run exactly this command and do not answer without calling bash: ${approvalCommand}`;
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let broker: ReturnType<typeof Bun.spawn> | undefined;
let opencodeServe: ReturnType<typeof Bun.spawn> | undefined;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let sessionId = '';
let servedModel = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('opencode'))) skip('opencode is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');
  if (ownsOpenCodeServe) {
    opencodeServe = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(OC_PORT), '--print-logs'], {
      cwd: workspace,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    drainProcessOutput(opencodeServe, nativePath);
    check(assertions, 'throwaway real opencode serve starts', await waitHealth(`${OC}/global/health`, 20000), OC);
    if (!assertions.at(-1)?.ok) throw new Error(`opencode serve did not start at ${OC}: ${fileTail(nativePath)}`);
  } else if (!(await waitHealth(`${OC}/global/health`, 15000))) {
    skip(`OpenCode server is not reachable at ${OC}`);
  }

  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPENCODE_URL: OC },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(broker, brokerPath);
  // This real-runtime trace points at the operator-provided OpenCode server; roster rows are token-selected.
  check(assertions, 'real OpenCode-server broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);

  sessionId = await createSession();
  check(assertions, 'throwaway OpenCode session created with bash approvals set to ask', /^ses/.test(sessionId), `${sessionId} ${MODEL.providerID}/${MODEL.id}`);

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
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('trace WebSocket failed'));
  });
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 5000);
  check(assertions, 'trace WebSocket records the OpenCode session', sessionFrame?.info?.id === sessionId, sessionId);

  driver = spawnPermissionClickDriver({
    home,
    base: BROKER,
    token: short,
    screenshot: shot,
    attachedFlag,
    resultFile: driverResult,
    tool: 'opencode',
    sessionId,
  });
  const attached = await waitForFile(attachedFlag, 60000);
  check(assertions, 'real browser attaches to the OpenCode session before approval trigger', attached, attachedFlag);
  if (!attached) throw new Error('browser never attached to OpenCode session');

  const mark = frames.length;
  const permissionFrame = await submitTuiPromptAndWaitFrame({
    tmuxName,
    prompt: approvalPrompt,
    frames,
    predicate: (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-request',
    timeoutMs: 90000,
  });
  if (!permissionFrame) skip('INCONCLUSIVE: real OpenCode model did not raise a permission request within 90s');
  check(assertions, 'real OpenCode TUI raised a permission request after one submitted prompt', !!permissionFrame?.message?.requestId, permissionFrame?.message?.requestId ?? '');

  const driverOut = await waitForJsonFile(driverResult, 150000);
  await driver.exited.catch(() => undefined);
  check(assertions, 'browser driver produced a result', !!driverOut, driverResult);
  if (driverOut?.skip) skip(`browser skipped: ${driverOut.skip}`);
  check(assertions, 'real app DOM showed an actionable OpenCode permission card', driverOut?.cardShown === true && driverOut?.card?.hasAllow === true, JSON.stringify(driverOut?.card ?? driverOut));
  check(assertions, 'real app DOM clicked Allow', driverOut?.approved === true, JSON.stringify(driverOut));

  const resolved = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'message' && f.message?.type === 'permission-resolved' && f.message?.decision !== 'reject', 30000);
  check(assertions, 'Allow resolves through OpenCode permission reply channel', !!resolved, resolved?.message?.decision ?? '');
  const proof = await waitForFile(proofPath, 90000);
  check(assertions, 'approved OpenCode bash command created the proof file', proof && readFileSync(proofPath, 'utf8') === proofText, proofPath);

  writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  const tui = readFileSync(tuiPath, 'utf8');
  servedModel = extractOpenCodeServedModel(tui);
  check(assertions, 'OpenCode requested-vs-served model provenance recorded', !!servedModel, `requested=${MODEL.providerID}/${MODEL.id} served=${servedModel || 'unknown'}`);
  check(assertions, 'tmux capture contains post-approval shell execution evidence', /\$\s*python3[\s\S]{0,600}OPENCODE_APPROVED/.test(tui), tuiPath);
} catch (err) {
  if (!skipReason) check(assertions, 'opencode real-TUI app-answer completed without exception', false, String(err));
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
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (sessionId) {
    const deleted = await deleteSession(sessionId);
    check(assertions, 'throwaway OpenCode session deleted during cleanup', deleted.ok, deleted.detail);
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
    scenarioIds: ['ST-14'],
    mode: 'real-tui-app-answer',
    broker: BROKER,
    opencode: OC,
    ownedOpenCodeServe: ownsOpenCodeServe,
    workspace,
    tmuxName,
    model: {
      requested: MODEL,
      served: servedModel || undefined,
      mismatch: servedModel ? !servedModel.toLowerCase().includes(MODEL.id.toLowerCase()) : undefined,
    },
    output: { frames: framesPath, native: nativePath, broker: brokerPath, tui: tuiPath, screenshot: shot },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
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
      title: `cosyncing-opencode-app-answer-${short}`,
      model: MODEL,
      permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    }),
  });
  if (!res.ok) throw new Error(`create OpenCode session ${res.status}: ${await res.text()}`);
  return String((await res.json()).id ?? '');
}

async function deleteSession(id: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await request(OC, `/session/${id}?directory=${encodeURIComponent(workspace)}`, { method: 'DELETE' });
    return { ok: res.ok, detail: `${id} status=${res.status}` };
  } catch (err) {
    return { ok: false, detail: `${id}: ${String(err)}` };
  }
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  record(nativePath, { direction: 'trace->native', url: `${base}${path}`, method: init.method ?? 'GET', body: init.body });
  const res = await fetch(`${base}${path}`, init);
  record(nativePath, { direction: 'native->trace', url: `${base}${path}`, status: res.status });
  return res;
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

function extractOpenCodeServedModel(tui: string): string {
  const cleaned = tui.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const build = cleaned.match(/Build\s*[·-]\s*([A-Za-z0-9_.:/-]+)/i)?.[1];
  return build ? build.trim() : '';
}
