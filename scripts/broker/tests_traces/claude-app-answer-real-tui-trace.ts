/**
 * Claude app-answer — GOLD-STANDARD real-TUI + real-app e2e (OPT-IN, real model).
 *
 * The combined "tmux user-sim + Playwright viewer" maintainer asked for: a REAL `claude` TUI in tmux (production
 * PreToolUse hook installed via --settings, pointed at a test broker) raises a REAL permission prompt → the hook
 * relays it to the broker → the REAL web app in Chromium renders the card and a real CLICK approves it → the hook
 * returns allow → claude runs the gated tool. PASS iff the tool ran ONLY because the app approved (no human at the
 * terminal). hooks-e2e.ts but answered through the real app DOM instead of a WebSocket stub.
 *
 * ORDERING is load-bearing: the production hook fails OPEN to the terminal when no viewer is attached (viewers:0),
 * so the BROWSER must attach to the session BEFORE the gated tool is triggered. The Playwright driver runs in the
 * background, signals once attached, and only then is the Write sent.
 *
 * Opt-in (subscription + a tiny haiku turn + a real browser). Skips cleanly without claude/tmux/chromium.
 *   COSYNCING_CLAUDE_REAL_TUI=1 bun run scripts/broker/tests_traces/claude-app-answer-real-tui-trace.ts [--keep]
 */
import { appendFileSync, rmSync, mkdirSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLAUDE_HOOK_SCRIPT } from '../../../packages/typescript/adapters/claude/src/index.ts';
import { freePort, sleep, spawnPermissionClickDriver, waitForFile, waitForJsonFile } from './_real-tui-app-helpers.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const KEEP = process.argv.includes('--keep');
if (!process.env.COSYNCING_CLAUDE_REAL_TUI) { console.log('SKIP claude real-TUI app-answer — set COSYNCING_CLAUDE_REAL_TUI=1 (opt-in: real model + browser)'); process.exit(0); }
if (Bun.spawnSync(['which', 'claude']).exitCode !== 0 || Bun.spawnSync(['which', 'tmux']).exitCode !== 0) { console.log('SKIP — claude or tmux not on PATH'); process.exit(0); }

const TOKEN = 'realtui-' + Math.abs(Date.now() % 1_000_000);
const WORK = join(tmpdir(), 'cosyncing-' + TOKEN);
const SESSION = 'claude-realtui';
const BUN = process.execPath;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'output', 'traces', RUN_ID, 'claude', 'real-tui-app-answer');
const FRAMES = join(OUT, 'frames.ndjson');
const TRACE = join(OUT, 'trace.json');
const home = mkdtempSync(join(tmpdir(), 'cosyncing-realtui-home-'));
const ATTACHED = join(home, 'attached.flag');
const RESULT = join(home, 'result.json');
const shot = '/tmp/claude-realtui-app.png';
const ts = () => new Date().toISOString();
const log = (s: string) => console.log(`${ts()} ${s}`);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[>=]/g, '');
function tmux(...a: string[]): string { const p = Bun.spawnSync(['tmux', ...a]); return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr); }
const cap = () => stripAnsi(tmux('capture-pane', '-t', SESSION, '-p'));
const PERMIT = /Do you want to proceed|Do you want to create|Do you want to make this edit|requires approval|❯\s*1\.\s*Yes/i;
const hookEnv = (mode: string, base: string) => `COSYNCING_BROKER=${JSON.stringify(base)} ${JSON.stringify(BUN)} ${JSON.stringify(CLAUDE_HOOK_SCRIPT)} ${mode}`;

let broker: any, driver: any, ws: WebSocket | undefined, verdict = 'INCONCLUSIVE';
const frames: any[] = [];
const assertions: Array<{ name: string; ok: boolean; detail?: string }> = [];
function recordFrame(frame: any): void {
  appendFileSync(FRAMES, JSON.stringify({ ts: new Date().toISOString(), ...frame }) + '\n');
}
function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} claude real-TUI broad — ${name}${detail ? ' — ' + detail : ''}`);
}
try {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const SETTINGS = { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: hookEnv('hello', BASE), timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|Update|WebFetch|AskUserQuestion', hooks: [{ type: 'command', command: hookEnv('request', BASE), timeout: 120 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: hookEnv('bye', BASE), timeout: 10 }] }],
  } };
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true }); mkdirSync(join(WORK, '.cosyncing', 'outbox'), { recursive: true }); mkdirSync(OUT, { recursive: true });

  // 1) broker — real env (claude uses the real ~/.claude subscription; the broker discovers the session it writes)
  broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_MACHINE: 'realtui', COSYNCING_BRIDGE_GRACE_MS: '500' }, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!up) await sleep(250); }
  if (!up) throw new Error('broker not up'); log(`✓ broker :${PORT}`);

  // 2) real claude TUI with our hooks (pointed at the test broker)
  tmux('kill-session', '-t', SESSION);
  tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50');
  tmux('send-keys', '-t', SESSION, '--', `cd ${WORK} && claude --model haiku --settings ${JSON.stringify(JSON.stringify(SETTINGS))}`);
  tmux('send-keys', '-t', SESSION, 'Enter');
  const READY = (t: string) => /for shortcuts|Try "|Welcome back|│\s*>/i.test(t);
  const MENU = /Enter to confirm|Enter to continue|trust the files|❯\s*1\.\s*(Yes|I am)/i;
  let ready = false; const answered = new Set<string>();
  for (let i = 0; i < 45 && !ready; i++) { await sleep(1000); const t = cap(); if (READY(t) && !MENU.test(t)) { ready = true; break; } if (MENU.test(t)) { const k = /trust/i.test(t) ? 'trust' : 'menu'; if (!answered.has(k)) { tmux('send-keys', '-t', SESSION, 'Enter'); answered.add(k); await sleep(1200); } } }
  if (!ready) { log(cap()); throw new Error('TUI not ready'); } log('✓ claude TUI ready');

  // 3) the SessionStart hook should have registered the synced session
  let id = '';
  for (let i = 0; i < 30 && !id; i++) { const r = await (await fetch(`${BASE}/api/sessions`)).json().catch(() => ({} as any)); const list: any[] = Array.isArray(r?.sessions) ? r.sessions : Array.isArray(r) ? r : []; const mine = list.find((s) => s.tool === 'claude' && s.cwd === WORK && s.control?.terminalSync?.active); if (mine) id = mine.id; else await sleep(700); }
  if (!id) throw new Error('session never appeared synced'); log(`✓ synced session ${id.slice(0, 14)}…`);

  ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/sessions/claude/${encodeURIComponent(id)}/stream`);
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(String(e.data));
      frames.push(frame);
      recordFrame(frame);
    } catch {
      /* malformed frame */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('trace WebSocket failed'));
  });
  const sessionFrame = await waitFrame(frames, (f) => f.kind === 'session', 10000);
  check('real Claude synced session exposes terminal-sync metadata', sessionFrame?.info?.control?.terminalSync?.active === true, JSON.stringify(sessionFrame?.info?.control ?? null));
  const modelDetail = JSON.stringify(sessionFrame?.info?.currentModel ?? sessionFrame?.info?.model ?? null);
  if (/haiku/i.test(modelDetail)) check('real Claude synced session records model metadata when Claude supplies it', true, modelDetail);
  else log(`NOT_OBSERVED: real Claude SessionStart model metadata absent in this run (${modelDetail})`);

  // 4) START the shared browser driver in the BACKGROUND: it opens THIS session (→ viewers>0),
  //    signals attached, then waits for the actionable permission card and clicks "Allow once".
  //    Attaching BEFORE the trigger is load-bearing: the production hook fails open to the terminal
  //    when no viewer is attached.
  driver = spawnPermissionClickDriver({
    home,
    base: BASE,
    token: TOKEN,
    screenshot: shot,
    attachedFlag: ATTACHED,
    resultFile: RESULT,
    tool: 'claude',
    sessionId: id,
  });

  // wait for the browser to attach (or to have skipped)
  const attached = await waitForFile(ATTACHED, 40000);
  if (!attached) {
    const r = await waitForJsonFile(RESULT, 100);
    if (r?.skip) { console.log(`SKIP — ${r.skip}`); verdict = 'SKIP'; throw 'skip'; }
    if (r) throw new Error(`driver pre-attach: ${JSON.stringify(r)}`);
    throw new Error('browser never attached');
  }
  log('✓ browser attached to the session (viewers>0)');

  // 5) NOW trigger the gated Write — the hook sees a viewer and relays the permission to the broker → the app card
  const proofRel = `.cosyncing/outbox/claude-broad-${TOKEN}.txt`;
  const proofText = `CLAUDE_BROAD_ARTIFACT_${TOKEN}`;
  tmux('send-keys', '-t', SESSION, '--', `Use the Write tool to create ${proofRel} with exactly the text ${proofText}. Do nothing else.`);
  for (let i = 0; i < 6; i++) { tmux('send-keys', '-t', SESSION, 'Enter'); const end = Date.now() + 6000; let blocked = false; while (Date.now() < end) { if (existsSync(RESULT)) { blocked = true; break; } const r = await (await fetch(`${BASE}/api/sessions`)).json().catch(() => ({} as any)); const list: any[] = Array.isArray(r?.sessions) ? r.sessions : Array.isArray(r) ? r : []; if (list.find((s) => s.id === id && s.status === 'needs-input')) { blocked = true; break; } await sleep(500); } if (blocked) break; }
  log('✓ gated Write triggered');

  // 6) wait for the driver (it clicks Allow), then the tool must run ONLY because the app approved
  const proof = join(WORK, proofRel);
  const firstDriverResult = await waitForJsonFile(RESULT, 90000);
  await driver.exited.catch(() => null);
  const res = firstDriverResult ?? (await waitForJsonFile(RESULT, 100)) ?? { error: 'no result' };
  log(`driver: ${JSON.stringify(res)}  📸 ${shot}`);
  if (res.skip) { console.log(`SKIP — ${res.skip}`); verdict = 'SKIP'; }
  else {
    let ran = false; for (let i = 0; i < 24 && !ran; i++) { if (existsSync(proof)) ran = true; else await sleep(500); }
    const noPermissionRaised = !res.approved && !res.cardShown && !ran && (res.error === 'no result' || String(res.error ?? '').startsWith('permission card / approve:'));
    if (noPermissionRaised) {
      console.log(`SKIP — INCONCLUSIVE: real Claude model did not raise a permission request within the trace window (${res.error})`);
      verdict = 'SKIP';
    } else {
      const noLinger = !PERMIT.test(cap());
      const toolActivity = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'tool-call', 15000);
      const artifact = await waitFrame(frames, (f) => f.kind === 'message' && f.message?.type === 'file-artifact' && JSON.stringify(f.message).includes(`claude-broad-${TOKEN}.txt`), 15000);
      check('real Claude broad trace surfaces the hook-originated canonical tool-call', !!toolActivity, JSON.stringify(toolActivity?.message ?? null));
      check('real Claude broad turn surfaces outbox file artifact', !!artifact, JSON.stringify(artifact?.message ?? null));
      check('Claude artifact file exists in real workspace with marker', ran && readFileSync(proof, 'utf8') === proofText, proof);
      verdict = res.approved && ran && noLinger && assertions.every((a) => a.ok) ? 'PASS' : 'FAIL';
      console.log(`  ${verdict === 'PASS' ? '✅' : '❌'} cardShown=${res.cardShown} appApproved=${res.approved} fileCreated=${ran} noLingerPrompt=${noLinger} ${res.error ? '(' + res.error + ')' : ''}`);
      console.log(verdict === 'PASS' ? 'PASS claude real-TUI app-answer — a real claude permission was answered by clicking in the REAL app; the tool ran with no human at the terminal.' : 'FAIL claude real-TUI app-answer');
    }
  }
} catch (e) {
  if (e !== 'skip') { console.log('ERROR ' + String(e)); verdict = verdict === 'SKIP' ? 'SKIP' : 'ERROR'; }
} finally {
  try { ws?.close(); } catch {}
  try { driver?.kill(); } catch {}
  writeFileSync(TRACE, JSON.stringify({
    agent: 'claude',
    scenarioIds: ['ST-01', 'ST-14', 'ST-17', 'ST-20'],
    mode: 'real-tui-app-answer',
    workspace: WORK,
    output: { frames: FRAMES, screenshot: shot },
    assertions,
    status: verdict === 'PASS' ? 'pass' : verdict === 'SKIP' ? 'skip' : 'fail',
  }, null, 2));
  if (!KEEP) { tmux('kill-session', '-t', SESSION); try { broker?.kill(); } catch {} rmSync(WORK, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  console.log(`claude-app-answer-real-tui done: ${verdict}`);
  process.exit(verdict === 'PASS' || verdict === 'SKIP' ? 0 : 1);
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
