/**
 * Real Codex TUI true-sync smoke.
 *
 * Starts a throwaway cosyncing broker, opens a real Codex TUI inside tmux against the managed
 * app-server daemon, then proves app->terminal and terminal->app flow over the same loaded thread.
 *
 * This test makes real Codex model calls. Defaults to the cheap spark model and low reasoning.
 *
 *   bun run scripts/broker/tests_traces/codex-real-tui-smoke.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, submitTuiPromptAndWaitFrame } from './_real-tui-app-helpers.ts';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'real-tui-sync');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const model = process.env.COSYNCING_CODEX_TEST_MODEL ?? 'gpt-5.3-codex-spark';
const effort = process.env.COSYNCING_CODEX_TEST_EFFORT ?? 'low';
const sock = process.env.COSYNCING_CODEX_APP_SERVER_SOCK ?? join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
const remote = process.env.COSYNCING_CODEX_REMOTE_ADDR ?? `unix://${sock}`;
const workspace = mkdtempSync(join(tmpdir(), 'cosyncing-codex-real-tui-'));
const tmuxName = `cosyncing-codex-real-${process.pid}-${short}`;
const initPrompt = `COSYNCING_INIT_${short}: reply exactly INIT_OK_${short}. Do not run tools.`;
const appPrompt = `COSYNCING_APP_${short}: reply exactly APP_SYNC_OK_${short}. Do not run tools.`;
const terminalPrompt = `COSYNCING_TERMINAL_${short}: reply exactly TERMINAL_SYNC_OK_${short}. Do not run tools.`;

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}

function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

async function main(): Promise<void> {
  let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let ws: WebSocket | undefined;
  try {
    if (!existsSync(sock)) throw new Error(`Codex daemon socket missing: ${sock}`);

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
    drainBrokerOutput(broker);
    if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}: ${brokerTail()}`);
    check('real-CODEX_HOME sync-enabled broker starts', BROKER.startsWith('http://127.0.0.1:'), BROKER);

    await run(['tmux', 'new-session', '-d', '-s', tmuxName, '-c', workspace]);
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
      'read-only',
      '-a',
      'never',
      '-c',
      'check_for_update_on_startup=false', // a fresh release otherwise blocks the TUI on an interactive update gate
      '--no-alt-screen',
      shellQuote(initPrompt),
    ].join(' ');
    await run(['tmux', 'send-keys', '-t', tmuxName, '--', cmd, 'C-m']);
    check('real Codex TUI launched in tmux', await tmuxOk(['has-session', '-t', tmuxName]), `${model}/${effort}`);

    const visible = await waitForLiveSession();
    check('broker discovers real TUI thread', !!visible, visible?.id ?? '');
    check('real TUI thread is live true-sync', visible?.attachMode === 'live' && visible?.control?.terminalSync?.active === true, JSON.stringify(visible?.control));
    check('Drive is unavailable during true-sync', visible?.control?.drive?.supported === false && visible?.control?.drive?.state === 'unavailable', JSON.stringify(visible?.control?.drive));

    ws = new WebSocket(`${WSBASE}/api/sessions/codex/${encodeURIComponent(visible.id)}/stream`);
    ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(String(e.data));
        frames.push(frame);
        record(framesPath, frame);
      } catch {
        /* ignore malformed */
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws!.onopen = () => resolve();
      ws!.onerror = () => reject(new Error('browser WebSocket failed'));
    });
    const history = await waitFrame((f) => f.kind === 'history', 10000);
    check('app websocket attaches to real TUI thread', !!history, visible.id);

    const initSeen = await waitForText(`INIT_OK_${short}`, 120000);
    check('initial real TUI model response reaches app', initSeen, `INIT_OK_${short}`);

    const appMark = frames.length;
    ws.send(JSON.stringify({ kind: 'prompt', text: appPrompt }));
    const appUser = await waitFrame((f) => frames.indexOf(f) >= appMark && f.kind === 'message' && f.message?.type === 'user-message' && textOf(f).includes(appPrompt), 15000);
    const appOutput = await waitForText(`APP_SYNC_OK_${short}`, 120000, appMark);
    check('app prompt reaches shared real Codex thread', !!appUser, appUser?.message?.key ?? '');
    check('app prompt response reaches app', appOutput, `APP_SYNC_OK_${short}`);
    const tuiSawApp = await waitTuiContains(`APP_SYNC_OK_${short}`, 20000);
    check('real TUI displays app-originated turn', tuiSawApp, `APP_SYNC_OK_${short}`);

    const terminalMark = frames.length;
    const terminalUser = await submitTuiPromptAndWaitFrame({
      tmuxName,
      prompt: terminalPrompt,
      frames,
      predicate: (f) => frames.indexOf(f) >= terminalMark && f.kind === 'message' && f.message?.type === 'user-message' && textOf(f).includes(terminalPrompt),
      timeoutMs: 30000,
    });
    const terminalOutput = await waitForText(`TERMINAL_SYNC_OK_${short}`, 120000, terminalMark);
    check('terminal prompt reaches app as user-message', !!terminalUser, terminalUser?.message?.key ?? '');
    check('terminal prompt response reaches app', terminalOutput, `TERMINAL_SYNC_OK_${short}`);
    const terminalEchoCount = frames.filter((f) => f.kind === 'message' && f.message?.type === 'user-message' && textOf(f).includes(terminalPrompt)).length;
    check('terminal prompt is not duplicated in app stream', terminalEchoCount === 1, `${terminalEchoCount} matches`);

    const tui = await captureTui();
    writeFileSync(tuiPath, tui);
  } catch (err) {
    check('real TUI smoke completed without exception', false, String(err));
    try {
      writeFileSync(tuiPath, await captureTui());
    } catch {
      /* no pane */
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    broker?.kill();
    await run(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
    const failed = assertions.filter((a) => !a.ok).length;
    writeFileSync(tracePath, JSON.stringify({
      agent: 'codex',
      scenarioIds: ['ST-03', 'ST-04'],
      mode: 'real-tui',
      broker: BROKER,
      workspace,
      tmuxName,
      model,
      effort,
      remote,
      output: { frames: framesPath, broker: brokerPath, tui: tuiPath },
      assertions,
      status: failed ? 'fail' : 'pass',
      skipReason: null,
    }, null, 2));
    rmSync(workspace, { recursive: true, force: true });
    console.log(`\ntrace: ${tracePath}`);
    console.log(`${assertions.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

async function waitForLiveSession(): Promise<any> {
  const end = Date.now() + 120000;
  let last: any;
  for (;;) {
    const resp = await fetch(`${BROKER}/api/sessions`);
    const body: any = await resp.json();
    const sessions = Array.isArray(body) ? body : body.sessions ?? [];
    const visible = sessions.find((s: any) => s.tool === 'codex' && (s.cwd === workspace || JSON.stringify(s).includes(workspace)));
    if (visible) {
      last = visible;
      if (visible.attachMode === 'live' && visible.control?.terminalSync?.active === true) return visible;
    }
    if (Date.now() > end) {
      throw new Error(`Codex session for ${workspace} did not become live; last=${JSON.stringify(last?.control ?? last ?? null)}`);
    }
    await sleep(1000);
  }
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  for (const [name, stream] of [['stdout', proc.stdout], ['stderr', proc.stderr]] as const) {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          record(brokerPath, { stream: name, text: decoder.decode(value) });
        }
      } catch {
        /* process ended */
      }
    })();
  }
}

function brokerTail(): string {
  try {
    return readFileSync(brokerPath, 'utf8').slice(-2000);
  } catch {
    return '<no broker output captured>';
  }
}

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BROKER}/api/health`)).ok) return true;
    } catch {
      /* broker not ready */
    }
    await sleep(100);
  }
  return false;
}

async function waitFrame(pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const frame = frames.find(pred);
    if (frame) return frame;
    if (Date.now() > end) return undefined;
    await sleep(100);
  }
}

async function waitForText(text: string, ms: number, from = 0): Promise<boolean> {
  return !!(await waitFrame((f) => frames.indexOf(f) >= from && frameText(f).includes(text), ms));
}

function textOf(frame: any): string {
  const message = frame?.message ?? frame;
  return String(message?.text ?? '') + String(message?.delta ?? '') + String(message?.result ?? '') + String(message?.detail ?? '');
}

function frameText(frame: any): string {
  if (frame?.kind === 'history' && Array.isArray(frame.messages)) return frame.messages.map((m: any) => textOf(m)).join('\n');
  return textOf(frame);
}

async function waitTuiContains(text: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if ((await captureTui()).includes(text)) return true;
    if (Date.now() > end) return false;
    await sleep(500);
  }
}

async function captureTui(): Promise<string> {
  const res = await run(['tmux', 'capture-pane', '-pt', tmuxName, '-S', '-3000']);
  return res.stdout;
}

async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    await run(['tmux', ...args]);
    return true;
  } catch {
    return false;
  }
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code}): ${stderr || stdout}`);
  return { stdout, stderr };
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/:=.,@%+\-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
