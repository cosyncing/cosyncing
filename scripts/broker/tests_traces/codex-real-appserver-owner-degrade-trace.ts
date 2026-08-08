/**
 * Codex real app-server owner-degrade trace (OPT-IN, real binary, low/no model dependency).
 *
 * Starts a temporary real Codex app-server plus a real Codex TUI in tmux, attaches the real Code
 * Anywhere broker/app WebSocket to the live thread, kills the app-server owner, and proves the open
 * socket downgrades to read-only Observe with no stale active-sync claim.
 *
 *   COSYNCING_CODEX_REAL_OWNER_DEGRADE=1 bun run scripts/broker/tests_traces/codex-real-appserver-owner-degrade-trace.ts
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
  tmux,
  tmuxCapture,
  waitForFile,
  waitFrame,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_CODEX_REAL_OWNER_DEGRADE === '1';
if (!enabled) {
  console.log('SKIP codex real app-server owner-degrade - set COSYNCING_CODEX_REAL_OWNER_DEGRADE=1 (opt-in: real codex app-server + TUI)');
  process.exit(0);
}

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? await freePort());
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'codex', 'real-appserver-owner-degrade');
const framesPath = join(outDir, 'frames.ndjson');
const brokerPath = join(outDir, 'broker.ndjson');
const appServerPath = join(outDir, 'app-server.ndjson');
const cleanupAppServerPath = join(outDir, 'cleanup-app-server.ndjson');
const tuiPath = join(outDir, 'tui.txt');
const tracePath = join(outDir, 'trace.json');
const model = process.env.COSYNCING_CODEX_TEST_MODEL ?? 'gpt-5.3-codex-spark';
const effort = process.env.COSYNCING_CODEX_TEST_EFFORT ?? 'low';
const appServerRoot = mkdtempSync(join(tmpdir(), `cosyncing-codex-degrade-appserver-${short}-`));
const sock = join(appServerRoot, 'app-server.sock');
const remote = `unix://${sock}`;
const workspace = mkdtempSync(join(tmpdir(), `cosyncing-codex-degrade-${short}-`));
const tmuxName = `cosyncing-codex-degrade-${process.pid}-${short}`;
const initPrompt = `COSYNCING_DEGRADE_INIT_${short}: reply exactly INIT_OK_${short}. Do not run tools.`;
const assertions: Assertion[] = [];
const frames: any[] = [];
mkdirSync(outDir, { recursive: true });

let appServer: ReturnType<typeof Bun.spawn> | undefined;
let cleanupAppServer: ReturnType<typeof Bun.spawn> | undefined;
let broker: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let threadId = '';
let sessionId = '';
let skipReason: string | null = null;

try {
  if (!(await hasCommand('codex'))) skip('codex is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');

  appServer = startAppServer(appServerPath);
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
      COSYNCING_CODEX_SYNC_WATCH_MS: '250',
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
  check(assertions, 'real Codex TUI launched in tmux against temporary app-server', true, `${model}/${effort}`);

  const visible = await waitForLiveSession();
  sessionId = String(visible.id ?? '');
  threadId = codexThreadId(visible);
  check(assertions, 'broker discovers real Codex TUI thread', !!sessionId && !!threadId, `${sessionId} thread=${threadId}`);
  check(assertions, 'real Codex thread starts live true-sync', visible?.attachMode === 'live' && visible?.control?.terminalSync?.active === true, JSON.stringify(visible?.control));

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
  const initial = await waitFrame(frames, (f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true, 10000);
  check(assertions, 'attached socket starts as real Codex true-sync owner', !!initial, JSON.stringify(initial?.info?.control ?? null));

  const mark = frames.length;
  appServer.kill();
  await appServer.exited.catch(() => undefined);
  appServer = undefined;
  const downgraded = await waitFrame(
    frames,
    (f) =>
      frames.indexOf(f) >= mark &&
      f.kind === 'session' &&
      f.info?.attachMode === 'observe' &&
      f.info?.control?.terminalSync?.supported === true &&
      f.info?.control?.terminalSync?.active === false &&
      f.info?.control?.drive?.state === 'observing',
    12000,
  );
  check(assertions, 'real Codex app-server disappearance downgrades open socket', !!downgraded, JSON.stringify(downgraded?.info?.control ?? null));
  check(assertions, 'Codex downgrade does not emit misleading ended frame', !frames.slice(mark).some((f) => f.kind === 'ended'));

  ws.send(JSON.stringify({ kind: 'prompt', text: `SHOULD_NOT_REACH_REAL_CODEX_AFTER_DEGRADE_${short}` }));
  const readOnly = await waitFrame(frames, (f) => frames.indexOf(f) >= mark && f.kind === 'error' && /read-only observe session/.test(String(f.message ?? '')), 3000);
  check(assertions, 'degraded real Codex socket rejects prompt at broker boundary', !!readOnly, String(readOnly?.message ?? ''));
} catch (err) {
  if (!skipReason) check(assertions, 'codex real app-server owner-degrade completed without exception', false, String(err));
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
    broker?.kill();
  } catch {
    /* ignore */
  }
  try {
    appServer?.kill();
  } catch {
    /* ignore */
  }
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  if (threadId) {
    rmSync(sock, { force: true });
    cleanupAppServer = startAppServer(cleanupAppServerPath);
    if (await waitForFile(sock, 15000)) {
      const archived = await archiveCodexDaemonThread(sock, threadId);
      check(assertions, 'real Codex test thread archived during cleanup', archived.ok, archived.detail);
    } else {
      check(assertions, 'real Codex test thread archived during cleanup', false, `cleanup app-server socket missing: ${fileTail(cleanupAppServerPath)}`);
    }
  }
  try {
    cleanupAppServer?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'codex',
    scenarioIds: ['ST-32'],
    mode: 'real-appserver-owner-degrade',
    broker: BROKER,
    workspace,
    tmuxName,
    model,
    effort,
    remote,
    sessionId,
    threadId,
    output: { frames: framesPath, broker: brokerPath, appServer: appServerPath, cleanupAppServer: cleanupAppServerPath, tui: tuiPath },
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

function startAppServer(logPath: string): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(['codex', 'app-server', '--listen', remote], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(proc, logPath);
  return proc;
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

function fileTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output captured>';
  }
}
