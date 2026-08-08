/**
 * OpenCode idle-attach reconnect trace (OPT-IN, real binary, no model turn).
 *
 * Codifies a verified 2026-07-22 finding on OpenCode 1.18.4: an IDLE `opencode attach` client
 * SURVIVES a same-port `opencode serve` restart. It does not exit when the serve it was talking to
 * dies; instead it stays alive, auto-reconnects with a FRESH socket to the restarted serve, and its
 * session remains recoverable.
 *
 * Proven against real processes, throwaway port + throwaway XDG home (production state untouched):
 *   1. start a real `opencode serve` on a free port; wait until GET /session is reachable
 *   2. create a throwaway session so there is something to recover
 *   3. launch an IDLE `opencode attach <url> -s <id> --mini` in a DETACHED tmux pty; find its PID;
 *      wait until it has an ESTABLISHED socket to the serve (lsof)
 *   4. kill ONLY the serve we started; wait until the port is free
 *   5. restart `opencode serve` on the SAME port; wait until reachable again
 *   6. ASSERT: (a) the attach PID is still alive; (b) it opens a NEW socket to the restarted serve
 *      (a fresh ESTABLISHED local port, distinct from the pre-kill set); (c) the session is still
 *      listed by GET /session and the attach TUI shows no fatal error in its captured output
 *
 *   COSYNCING_OPENCODE_RECONNECT_TRACE=1 bun run scripts/broker/tests_traces/opencode-reconnect-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Assertion,
  check,
  command,
  drainProcessOutput,
  freePort,
  hasCommand,
  shellQuote,
  sleep,
  waitHealth,
} from './_real-tui-app-helpers.ts';

const enabled = process.env.COSYNCING_OPENCODE_RECONNECT_TRACE === '1';
if (!enabled) {
  console.log('SKIP opencode idle-attach reconnect - set COSYNCING_OPENCODE_RECONNECT_TRACE=1 (opt-in: real opencode serve + tmux)');
  process.exit(0);
}

const OC_PORT = Number(process.env.COSYNCING_OC_TEST_PORT ?? await freePort());
const OC = `http://127.0.0.1:${OC_PORT}`;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const short = randomBytes(3).toString('hex');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'opencode', 'reconnect');
const serve1Path = join(outDir, 'opencode-serve-1.ndjson');
const serve2Path = join(outDir, 'opencode-serve-2.ndjson');
const tuiPath = join(outDir, 'tmux.txt');
const tracePath = join(outDir, 'trace.json');
// A throwaway home so nothing touches the user's real OpenCode state/config.
const home = mkdtempSync(join(tmpdir(), `cosyncing-opencode-reconnect-${short}-`));
const workspace = join(home, 'work');
// NOTE: process.env is never mutated - isolation is passed only into the child env we build here,
// so there is nothing to "restore" and the test runner's environment stays clean.
const childEnv = {
  ...process.env,
  XDG_DATA_HOME: join(home, 'xdg-data'),
  XDG_CONFIG_HOME: join(home, 'xdg-config'),
  XDG_STATE_HOME: join(home, 'xdg-state'),
};
const tmuxName = `cosyncing-oc-reconnect-${short}`;
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const) {
  mkdirSync(childEnv[key], { recursive: true });
}

let serve1: ReturnType<typeof Bun.spawn> | undefined;
let serve2: ReturnType<typeof Bun.spawn> | undefined;
let tmuxStarted = false;
let sessionId = '';
let attachPid = 0;
let preSockets: number[] = [];
let newSockets: number[] = [];
let skipReason: string | null = null;

try {
  if (!(await hasCommand('opencode'))) skip('opencode is not on PATH');
  if (!(await hasCommand('tmux'))) skip('tmux is not on PATH');
  if (!(await hasCommand('lsof'))) skip('lsof is not on PATH');

  // 1. real serve on a throwaway port with throwaway XDG home
  serve1 = spawnServe(serve1Path);
  check(assertions, 'real opencode serve #1 starts', await waitHealth(`${OC}/session`, 30000), OC);
  if (!assertions.at(-1)?.ok) throw new Error(`opencode serve did not start at ${OC}: ${await fileTail(serve1Path)}`);

  // 2. a throwaway session to recover later
  sessionId = await createSession();
  check(assertions, 'throwaway OpenCode session created', /^ses/.test(sessionId), sessionId);

  // 3. IDLE attach client inside a detached tmux pty
  const attachCmd = [
    `XDG_DATA_HOME=${shellQuote(childEnv.XDG_DATA_HOME)}`,
    `XDG_CONFIG_HOME=${shellQuote(childEnv.XDG_CONFIG_HOME)}`,
    `XDG_STATE_HOME=${shellQuote(childEnv.XDG_STATE_HOME)}`,
    'opencode', 'attach', shellQuote(OC),
    '-s', shellQuote(sessionId),
    '--dir', shellQuote(workspace),
    '--mini', '--print-logs',
  ].join(' ');
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  const spawned = await command(['tmux', 'new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '40', attachCmd]);
  tmuxStarted = spawned.ok;
  check(assertions, 'idle opencode attach launched in detached tmux', spawned.ok && (await tmuxHasSession()), tmuxName);
  if (!assertions.at(-1)?.ok) throw new Error(`tmux attach did not start: ${spawned.err || spawned.out}`);

  attachPid = await resolveAttachPid(20000);
  check(assertions, 'attach client PID captured (opencode inside tmux, not tmux)', attachPid > 0, String(attachPid));
  if (attachPid <= 0) throw new Error('could not resolve the opencode attach PID from the tmux pane');

  const connected = await waitForSocket(attachPid, 15000);
  preSockets = await establishedLocalPorts(attachPid);
  check(
    assertions,
    'attach client established a socket to serve #1 (pre-kill)',
    connected && preSockets.length > 0,
    `local ephemeral ports ${JSON.stringify(preSockets)} -> ${OC_PORT}`,
  );
  if (!connected) throw new Error('attach client never established a socket to serve #1');

  // 4. kill ONLY the serve we started, wait for the port to free
  serve1.kill();
  await serve1.exited.catch(() => undefined);
  serve1 = undefined;
  const freed = await waitPortFree(OC_PORT, 15000);
  check(assertions, 'serve #1 killed and its port freed', freed, `port ${OC_PORT}`);
  if (!freed) throw new Error(`port ${OC_PORT} never freed after killing serve #1`);

  // 5. restart serve on the SAME port
  serve2 = spawnServe(serve2Path);
  check(assertions, 'real opencode serve #2 restarts on the same port', await waitHealth(`${OC}/session`, 30000), OC);
  if (!assertions.at(-1)?.ok) throw new Error(`opencode serve #2 did not start at ${OC}: ${await fileTail(serve2Path)}`);

  // 6a. the idle attach client SURVIVED the serve restart
  check(assertions, 'idle attach client is STILL ALIVE after same-port serve restart', pidAlive(attachPid), `pid ${attachPid}`);

  // 6b. it auto-reconnects with a FRESH socket (a new ephemeral local port, distinct from pre-kill)
  newSockets = await waitForNewSocket(attachPid, preSockets, 20000);
  check(
    assertions,
    'attach client auto-reconnects with a NEW socket to the restarted serve',
    newSockets.length > 0,
    `fresh ephemeral ports ${JSON.stringify(newSockets)} -> ${OC_PORT} (pre-kill were ${JSON.stringify(preSockets)})`,
  );

  // 6c. the session is recoverable and the attach TUI shows no fatal error
  const recovered = await waitForSessionListed(sessionId, 15000);
  check(assertions, 'session is recoverable on the restarted serve (GET /session lists it)', recovered, sessionId);

  const capture = (await command(['tmux', 'capture-pane', '-p', '-t', tmuxName, '-S', '-400'])).out;
  writeFileSync(tuiPath, capture);
  const fatal = /panic:|fatal error|unhandled|ECONNREFUSED|connection refused|unable to connect|command not found|exit status/i.exec(capture);
  check(assertions, 'attach TUI captured output shows no fatal error', tmuxStarted && !fatal, fatal ? `matched ${JSON.stringify(fatal[0])}` : tuiPath);
} catch (err) {
  if (!skipReason) check(assertions, 'opencode idle-attach reconnect completed without exception', false, String(err));
} finally {
  // Idempotent, partial-setup-tolerant teardown. Only ever touches what THIS test started:
  // its own tmux session (which owns the attach child) and the two serves it spawned.
  await command(['tmux', 'kill-session', '-t', tmuxName]).catch(() => undefined);
  try {
    serve1?.kill();
  } catch {
    /* ignore */
  }
  try {
    serve2?.kill();
  } catch {
    /* ignore */
  }
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    agent: 'opencode',
    mode: 'idle-attach-reconnect',
    finding: 'idle opencode attach survives a same-port serve restart and auto-reconnects',
    opencode: OC,
    home,
    workspace,
    sessionId,
    attachPid,
    sockets: { preKill: preSockets, reconnect: newSockets },
    output: { serve1: serve1Path, serve2: serve2Path, tui: tuiPath },
    assertions,
    status: skipReason ? 'skip' : failed ? 'fail' : 'pass',
    skipReason,
  }, null, 2));
  rmSync(home, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(skipReason ? `SKIP ${skipReason}` : `${assertions.length - failed} passed, ${failed} failed`);
  process.exit(skipReason || failed === 0 ? 0 : 1);
}

function skip(reason: string): never {
  skipReason = reason;
  console.log(`SKIP opencode idle-attach reconnect - ${reason}`);
  throw new Error(reason);
}

function spawnServe(logPath: string): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(OC_PORT), '--print-logs'], {
    cwd: workspace,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainProcessOutput(proc, logPath);
  return proc;
}

async function createSession(): Promise<string> {
  const res = await fetch(`${OC}/session?directory=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `cosyncing-reconnect-${short}` }),
  });
  if (!res.ok) throw new Error(`create OpenCode session ${res.status}: ${await res.text()}`);
  const body: any = await res.json();
  return String(body.id ?? '');
}

async function tmuxHasSession(): Promise<boolean> {
  return (await command(['tmux', 'has-session', '-t', tmuxName])).ok;
}

/**
 * Resolve the opencode attach PID by anchoring on THIS tmux session's pane and walking its subtree.
 * This never scans by name across the box - it only inspects the process tree we ourselves started,
 * so the PID we later assert on is guaranteed to belong to our tmux session.
 */
async function resolveAttachPid(ms: number): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const paneOut = (await command(['tmux', 'list-panes', '-t', tmuxName, '-F', '#{pane_pid}'])).out.trim();
    const panePid = Number(paneOut.split('\n')[0]);
    if (Number.isInteger(panePid) && panePid > 0) {
      const pids = [panePid, ...(await descendants(panePid))];
      for (const pid of pids) {
        const args = (await command(['ps', '-o', 'args=', '-p', String(pid)])).out.trim();
        if (/\bopencode\b/.test(args) && /\battach\b/.test(args) && args.includes(String(OC_PORT))) return pid;
      }
    }
    await sleep(300);
  }
  return 0;
}

async function descendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length) {
    const parent = queue.shift()!;
    const kids = (await command(['pgrep', '-P', String(parent)])).out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    for (const kid of kids) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      queue.push(kid);
    }
  }
  return out;
}

/** Ephemeral local ports of ESTABLISHED sockets from `pid` to 127.0.0.1:OC_PORT (client side). */
async function establishedLocalPorts(pid: number): Promise<number[]> {
  const r = await command(['lsof', '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED', '-Fn']);
  const ports = new Set<number>();
  const re = new RegExp(`^n127\\.0\\.0\\.1:(\\d+)->127\\.0\\.0\\.1:${OC_PORT}$`);
  for (const line of r.out.split('\n')) {
    const m = re.exec(line.trim());
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

async function waitForSocket(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await establishedLocalPorts(pid)).length > 0) return true;
    await sleep(300);
  }
  return false;
}

async function waitForNewSocket(pid: number, pre: number[], ms: number): Promise<number[]> {
  const preSet = new Set(pre);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const now = await establishedLocalPorts(pid);
    const fresh = now.filter((p) => !preSet.has(p));
    if (fresh.length > 0) return fresh;
    await sleep(300);
  }
  return [];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

async function waitPortFree(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await canConnect(port))) return true;
    await sleep(250);
  }
  return false;
}

async function waitForSessionListed(id: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${OC}/session?directory=${encodeURIComponent(workspace)}`);
      if (res.ok) {
        const rows: any = await res.json();
        if (Array.isArray(rows) && rows.some((s) => s?.id === id)) return true;
      }
    } catch {
      /* serve still coming up */
    }
    await sleep(250);
  }
  return false;
}

async function fileTail(path: string): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8').slice(-2000);
  } catch {
    return '<no output>';
  }
}
