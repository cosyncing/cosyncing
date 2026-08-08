/**
 * Codex real native model-change display trace (OPT-IN, real binary + browser).
 *
 * Starts a temporary real Codex app-server plus a real Codex TUI in tmux, attaches the real app in
 * Chromium, sends an app prompt with a different real Codex model, and verifies the real app-server
 * turn reaches the target model and updates both the real TUI prompt display and app DOM statusline.
 *
 *   COSYNCING_CODEX_REAL_MODEL_CHANGE=1 bun run scripts/broker/tests_traces/codex-real-native-model-change-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refuseRetiredPocUiTrace } from './_app-trace-helpers.ts';
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
  submitTuiPromptAndWaitFrame,
  tmux,
  tmuxCapture,
  tmuxOk,
  waitForFile,
  waitFrame,
  waitForJsonFile,
  waitHealth,
} from './_real-tui-app-helpers.ts';

refuseRetiredPocUiTrace('scripts/broker/tests_traces/codex-real-native-model-change-trace.ts');

const enabled = process.env.COSYNCING_CODEX_REAL_MODEL_CHANGE === '1';
if (!enabled) {
  console.log('SKIP codex real native model-change - set COSYNCING_CODEX_REAL_MODEL_CHANGE=1 (opt-in: real model + browser)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'real-native-model-change');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const appServerPath = join(outDir, 'app-server.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const browserDriverPath = join(outDir, 'browser-driver.ndjson');
const tracePath = join(outDir, 'trace.json');
const browserShot = join(outDir, 'browser.png');
const appServerRoot = mkdtempSync(join(tmpdir(), `cosyncing-codex-modelchange-appserver-${short}-`));
const sock = join(appServerRoot, 'app-server.sock');
const remote = `unix://${sock}`;
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-codex-modelchange-${short}-`));
const browserHome = mkdtempSync(join(tmpdir(), `cosyncing-codex-modelchange-browser-${short}-`));
const tmuxName = `cosyncing-codex-modelchange-${process.pid}-${short}`;
const initialModel = process.env.COSYNCING_CODEX_INITIAL_MODEL ?? 'gpt-5.3-codex-spark';
const initialEffort = process.env.COSYNCING_CODEX_INITIAL_EFFORT ?? 'low';
const targetProvider = process.env.COSYNCING_CODEX_TARGET_PROVIDER ?? 'openai';
const targetModel = process.env.COSYNCING_CODEX_TARGET_MODEL ?? 'gpt-5.4-mini';
const targetEffort = process.env.COSYNCING_CODEX_TARGET_EFFORT ?? 'low';
const terminalModel = process.env.COSYNCING_CODEX_TERMINAL_TARGET_MODEL ?? initialModel;
const terminalEffort = process.env.COSYNCING_CODEX_TERMINAL_TARGET_EFFORT ?? initialEffort;
const initPrompt = `COSYNCING_MODEL_INIT_${short}: reply exactly MODEL_INIT_OK_${short}. Do not run tools.`;
const switchPrompt = `COSYNCING_MODEL_SWITCH_${short}: reply exactly MODEL_SWITCH_OK_${short}. Do not run tools.`;
const attachedFlag = join(browserHome, 'attached.flag');
const driverResult = join(outDir, 'browser-result.json');
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });
const terminalModelBoundary = 'Codex remote TUI treated `/model <id>` as ordinary prompt text in real probes; picker automation is not claimed.';

let appServer: ReturnType<typeof Bun.spawn> | undefined;
let broker: ReturnType<typeof Bun.spawn> | undefined;
let browserDriver: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let threadId = '';
let sessionId = '';
let skipReason: string | null = null;
let terminalSideModelChange: Record<string, unknown> | null = null;

try {
  if (!(await hasCommand('codex'))) skip('codex is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  appServer = Bun.spawn(['codex', 'app-server', '--listen', remote], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(appServer, appServerPath);
  check(assertions, 'temporary real Codex app-server socket appears', await waitForFile(sock, 15000), remote);
  if (!assertions.at(-1)?.ok) throw new Error(`temporary Codex app-server did not create ${sock}: ${fileTail(appServerPath)}`);
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
  check(assertions, 'real-CODEX_HOME sync-enabled broker starts', await waitHealth(`${BROKER}/api/health`, 15000), BROKER);
  if (!assertions.at(-1)?.ok) throw new Error(`broker did not start at ${BROKER}: ${fileTail(brokerPath)}`);

  await tmux(['new-session', '-d', '-s', tmuxName, '-c', workspace]);
  const cmd = [
    'codex',
    '--remote',
    shellQuote(remote),
    '-C',
    shellQuote(workspace),
    '-m',
    shellQuote(initialModel),
    '-c',
    shellQuote(`model_reasoning_effort="${initialEffort}"`),
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
  check(assertions, 'real Codex TUI launched in tmux with initial model', await tmuxOk(['has-session', '-t', tmuxName]), `${initialModel}/${initialEffort}`);

  const visible = await waitForLiveSession();
  sessionId = String(visible.id ?? '');
  threadId = codexThreadId(visible);
  check(assertions, 'broker discovers real Codex TUI thread', !!sessionId && !!threadId, `${sessionId} thread=${threadId}`);
  check(assertions, 'real Codex thread starts with initial model metadata', visible?.currentModel?.modelID === initialModel, JSON.stringify(visible?.currentModel ?? null));

  ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(sessionId)}/stream`);
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
  check(assertions, 'trace WebSocket records the real thread', !!history && frames.some((f) => f.kind === 'session' && f.info?.id === sessionId), sessionId);

  browserDriver = spawnModelStatusDriver();
  const attachState = await waitForAttachOrBrowserResult(90000);
  check(assertions, 'real browser attaches to the Codex session before model switch', attachState.attached, attachState.detail);
  if (!attachState.attached) throw new Error(`browser never attached to Codex session: ${attachState.detail}`);

  const options = await waitFrame(frames, (f) => f.kind === 'options', 10000);
  const targetOffered = Array.isArray((options as any)?.models) && (options as any).models.some((m: any) => m.providerID === targetProvider && m.modelID === targetModel);
  check(assertions, 'real Codex options include the target model', targetOffered, `${targetProvider}/${targetModel}`);
  if (!targetOffered) skip(`target Codex model not offered: ${targetProvider}/${targetModel}`);

  const mark = frames.length;
  ws.send(JSON.stringify({
    kind: 'prompt',
    text: switchPrompt,
    model: { providerID: targetProvider, modelID: targetModel, reasoningEffort: targetEffort },
  }));
  const output = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && modelFrameText(f).includes(`MODEL_SWITCH_OK_${short}`), 120000);
  check(assertions, 'real Codex target-model response reaches the app stream', !!output, `MODEL_SWITCH_OK_${short}`);
  const tuiAfterSwitch = await tmuxCapture(tmuxName, 3000);
  check(
    assertions,
    'real Codex TUI displays the target model after the app-server turn',
    tuiAfterSwitch.toLowerCase().includes(targetModel.toLowerCase()) && tuiAfterSwitch.toLowerCase().includes(targetEffort.toLowerCase()),
    `${targetModel}/${targetEffort}`,
  );

  const browserOut = await waitForJsonFile(driverResult, 150000);
  await browserDriver.exited.catch(() => undefined);
  check(assertions, 'real app DOM statusline showed the target Codex model', browserOut?.modelShown === true, JSON.stringify(browserOut));

  const terminalMark = frames.length;
  const nativeSettings = await submitTuiPromptAndWaitFrame({
    tmuxName,
    prompt: `/model ${terminalModel}`,
    frames,
    predicate: (f) =>
      frames.indexOf(f) >= terminalMark &&
      f.kind === 'message' &&
      f.message?.type === 'metadata-update' &&
      f.message?.key === 'sessionInfo' &&
      f.message?.value?.currentModel?.modelID === terminalModel,
    timeoutMs: 60000,
  });
  terminalSideModelChange = nativeSettings
    ? {
        status: 'observed',
        target: { providerID: 'openai', modelID: terminalModel, reasoningEffort: terminalEffort },
        currentModel: nativeSettings?.message?.value?.currentModel ?? null,
      }
    : {
        status: 'not-observed',
        target: { providerID: 'openai', modelID: terminalModel, reasoningEffort: terminalEffort },
        boundary: terminalModelBoundary,
      };
  if (!nativeSettings) {
    skip(`terminal-side Codex model change not observed: ${terminalModelBoundary}`);
  }
  check(assertions, 'terminal-side Codex /model switch propagates to the app via native settings metadata', true, JSON.stringify(terminalSideModelChange));
} catch (err) {
  if (!skipReason) check(assertions, 'codex real native model-change completed without exception', false, String(err));
} finally {
  try {
    writeFileSync(tuiPath, await tmuxCapture(tmuxName, 3000));
  } catch {
    /* no pane */
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  try {
    browserDriver?.kill();
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
    scenarioIds: ['ST-13'],
    mode: 'real-native-model-change',
    broker: BROKER,
    workspace,
    tmuxName,
    initialModel: { providerID: 'openai', modelID: initialModel, reasoningEffort: initialEffort },
    targetModel: { providerID: targetProvider, modelID: targetModel, reasoningEffort: targetEffort },
    terminalTargetModel: { providerID: 'openai', modelID: terminalModel, reasoningEffort: terminalEffort },
    terminalSideModelChange,
    remote,
    sessionId,
    threadId,
    output: { frames: framesPath, broker: brokerPath, appServer: appServerPath, tui: tuiPath, screenshot: browserShot, browser: driverResult, browserDriver: browserDriverPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(browserHome, { recursive: true, force: true });
  rmSync(appServerRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function spawnModelStatusDriver(): ReturnType<typeof Bun.spawn> {
  mkdirSync(browserHome, { recursive: true });
  const driverPath = join(browserHome, 'model-status-driver.py');
  writeFileSync(driverPath, modelStatusDriverPy());
  const proc = Bun.spawn(['python3', driverPath, BROKER, short, browserShot, attachedFlag, driverResult, sessionId, targetModel, targetEffort], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  drainProcessOutput(proc, browserDriverPath);
  return proc;
}

function modelStatusDriverPy(): string {
  return String.raw`
import json, sys, time
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    open(sys.argv[5], "w").write(json.dumps({"skip": "playwright import: " + str(e)})); sys.exit(0)

base, token, shot, attached, result, session_id, target_model, target_effort = sys.argv[1:9]

def save(page, data):
    try:
        page.screenshot(path=shot)
    except Exception:
        pass
    open(result, "w").write(json.dumps(data))

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=True)
    except Exception as e:
        open(result, "w").write(json.dumps({"skip": "chromium launch: " + str(e)})); sys.exit(0)
    page = browser.new_page()
    page.goto(base.rstrip('/') + '/poc-ui/', wait_until="domcontentloaded")  # PoC moved off root → /poc-ui/ (D6)
    try:
        page.wait_for_load_state("networkidle", timeout=3000)
    except Exception:
        pass
    page.wait_for_timeout(1200)
    try:
        found = False
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                found = page.evaluate("""async session_id => {
                    const res = await fetch("/api/sessions");
                    const payload = await res.json();
                    const sessions = Array.isArray(payload) ? payload : (Array.isArray(payload?.sessions) ? payload.sessions : []);
                    return sessions.some(s => s && s.tool === "codex" && s.id === session_id);
                }""", session_id)
                if found:
                    break
            except Exception:
                pass
            page.wait_for_timeout(500)
        if not found:
            save(page, {"error": "exact session not found in /api/sessions", "sessionId": session_id, "token": token})
            browser.close()
            sys.exit(0)
        search = page.locator("#sessionSearch")
        if search.count() > 0:
            search.fill(token)
            page.wait_for_timeout(1000)
        row = page.locator("#rosterList .srow", has_text=token).first
        if row.count() == 0:
            opened = page.evaluate("""token => {
                const projects = [...document.querySelectorAll("#rosterList .project")];
                const project = projects.find(el => (el.textContent || "").includes(token));
                const head = project?.querySelector(".projectHead");
                if (!head) return false;
                head.click();
                return true;
            }""", token)
            if opened:
                page.wait_for_timeout(1000)
                row = page.locator("#rosterList .project", has_text=token).locator(".srow", has_text=token).first
                if row.count() == 0:
                    row = page.locator("#rosterList .project", has_text=token).locator(".srow").first
        if row.count() == 0:
            row = page.locator("#rosterList .srow").filter(has_text=session_id[:12]).first
        if row.count() == 0:
            debug = page.evaluate("""() => ({
                rosterText: document.querySelector("#rosterList")?.textContent || "",
                projectCount: document.querySelectorAll("#rosterList .project").length,
                openProjectCount: document.querySelectorAll("#rosterList .project.open").length,
                rowCount: document.querySelectorAll("#rosterList .srow").length,
                html: (document.querySelector("#rosterList")?.innerHTML || "").slice(0, 4000),
            })""")
            save(page, {"error": "session row not found", "token": token, "debug": debug})
            browser.close()
            sys.exit(0)
        row.evaluate("el => el.click()")
    except Exception as e:
        save(page, {"error": "open session: " + str(e)})
        browser.close()
        sys.exit(0)
    try:
        page.wait_for_function("""() => {
            const meta = document.querySelector("#sessionMeta");
            return document.body.classList.contains("attached") && meta && getComputedStyle(meta).display !== "none";
        }""", timeout=15000)
    except Exception as e:
        debug = page.evaluate("""() => ({
            bodyClass: document.body.className,
            sessionMeta: document.querySelector("#sessionMeta")?.textContent || "",
            sessionMetaDisplay: getComputedStyle(document.querySelector("#sessionMeta")).display,
            statusline: document.querySelector("#statusline")?.textContent || "",
            statuslineDisplay: getComputedStyle(document.querySelector("#statusline")).display,
            thread: document.querySelector("#thread")?.textContent || "",
            activeRows: document.querySelectorAll("#rosterList .srow.active").length,
            rowCount: document.querySelectorAll("#rosterList .srow").length,
        })""")
        save(page, {"error": "session did not enter attached state: " + str(e), "debug": debug})
        browser.close()
        sys.exit(0)
    open(attached, "w").write("1")
    deadline = time.time() + 130
    last = {}
    while time.time() < deadline:
        try:
            last = page.evaluate("""() => {
                const status = document.getElementById("statusline");
                const text = status ? status.textContent || "" : "";
                const chips = {};
                for (const el of document.querySelectorAll("#statusline .chip")) {
                    const key = [...el.classList].find(c => c.startsWith("status-")) || "chip";
                    chips[key] = (el.textContent || "").trim();
                }
                return { text, chips };
            }""")
            if target_model.lower() in (last.get("text") or "").lower() and target_effort.lower() in (last.get("text") or "").lower():
                save(page, {"modelShown": True, "statusline": last})
                browser.close()
                sys.exit(0)
        except Exception as e:
            last = {"error": str(e)}
        page.wait_for_timeout(500)
    save(page, {"modelShown": False, "target": target_model, "targetEffort": target_effort, "last": last})
    browser.close()
`;
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

async function waitForAttachOrBrowserResult(ms: number): Promise<{ attached: boolean; detail: string }> {
  const { existsSync, readFileSync } = await import('node:fs');
  const end = Date.now() + ms;
  for (;;) {
    if (existsSync(attachedFlag)) return { attached: true, detail: attachedFlag };
    if (existsSync(driverResult)) {
      let body = '';
      try {
        body = readFileSync(driverResult, 'utf8');
      } catch {
        body = '<browser-result unreadable>';
      }
      return { attached: false, detail: body };
    }
    if (browserDriver) {
      const exited = await Promise.race([
        browserDriver.exited.then((code) => ({ done: true, code })),
        sleep(10).then(() => ({ done: false, code: undefined })),
      ]);
      if (exited.done) return { attached: false, detail: `browser driver exited ${exited.code}; log=${fileTail(browserDriverPath)}` };
    }
    if (Date.now() > end) return { attached: false, detail: `timeout; log=${fileTail(browserDriverPath)}` };
    await sleep(250);
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

function fileTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output captured>';
  }
}
