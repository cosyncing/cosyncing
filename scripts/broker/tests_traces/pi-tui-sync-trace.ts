/**
 * Pi TUI true-sync fine-grained trace (issues-part2 item 3 refinements).
 *
 * Drives maintainer's REAL flow end-to-end with the deliberately degenerate input that exposed the key
 * collision my earlier repros missed: the SAME short text ("hi") sent from the app, then typed in
 * the terminal, then from the app again. Distinct marker texts hide identity bugs — a colliding key
 * silently merges two same-text messages into one bubble and every "does the text appear?" check
 * still passes. This trace therefore asserts CARDINALITY AND KEY IDENTITY, not presence:
 *
 *   T1 app prompt before the TUI is answered (broker-owned drive path)
 *   T2 the driven client upgrades to Synced-with-terminal when the TUI joins (hub mode-fold)
 *   T3 wire: THREE user-message frames with text "hi" and THREE DISTINCT keys reach the client
 *   T4 the app-sent prompt is visible inside the terminal pane (injection)
 *   T5 late-join history carries all three user messages with distinct keys
 *   T6 (optional, python-playwright) the PoC web UI renders THREE user bubbles — the presentation
 *      layer, which is where the miss was actually seen
 *
 * Requirements: real `pi` + `tmux` on PATH (else SKIP). Spawns an ISOLATED broker on a random port;
 * the advertised sync command carries COSYNCING_BROKER so the TUI bridges to the isolated broker, not
 * a production one. Costs ~3 tiny turns on pi's default model.
 *
 *   bun run scripts/broker/tests_traces/pi-tui-sync-trace.ts
 */
export {};
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 26000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const TMUX = `pitrace${PORT}`;
const DIR = `/tmp/cosyncing-pi-tui-sync-trace-${PORT}`;
mkdirSync(DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function have(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
if (!have('pi') || !have('tmux')) {
  console.log('SKIP: real `pi` and `tmux` are required for this trace.');
  process.exit(0);
}

function attach(id: string, mode?: string): Promise<{ frames: any[]; send: (o: any) => void; close: () => void }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/api/sessions/pi/${encodeURIComponent(id)}/stream${mode ? `?mode=${mode}` : ''}`);
    const frames: any[] = [];
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))); } catch {} };
    ws.onopen = () => resolve({ frames, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() });
  });
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(400); }
  return pred();
}
/** All user-message payloads (live frames + history entries) with the given text. */
function userMessages(frames: any[], text: string): { key: string }[] {
  const out: { key: string }[] = [];
  for (const f of frames) {
    if (f.kind === 'message' && f.message?.type === 'user-message' && f.message.text === text) out.push({ key: String(f.message.key ?? '') });
    if (f.kind === 'history') for (const m of f.messages ?? []) if (m.type === 'user-message' && m.text === text) out.push({ key: String(m.key ?? '') });
  }
  return out;
}
const runsFinished = (frames: any[]) => frames.filter((f) => f.kind === 'message' && f.message?.type === 'run-summary' && f.message.status === 'done').length;

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_CODEX_SYNC_SERVER: '0' },
  stdout: 'pipe',
  stderr: 'pipe',
});
try {
  const healthy = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const r = await fetch(`${BROKER}/api/broker/health`); if (r.ok) return true; } catch {}
      await sleep(500);
    }
    return false;
  })();
  if (!healthy) throw new Error('isolated broker did not start');

  // create + drive-attach + PRE-TUI "hi" — the exact app flow
  const created: any = await (await fetch(`${BROKER}/api/sessions/pi`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: DIR, title: 'PI-TUI-SYNC-TRACE (safe to delete)' }),
  })).json();
  const session = created?.session;
  if (!session?.id) throw new Error('create failed: ' + JSON.stringify(created).slice(0, 200));
  const syncCmd: string = session?.control?.terminalSync?.command ?? '';
  const c1 = await attach(session.id, created.attachMode || 'resume');
  await sleep(1200);
  c1.send({ kind: 'prompt', text: 'hi' });
  check('T1 app prompt before the TUI is answered', await waitFor(() => runsFinished(c1.frames) >= 1, 60000), `runs=${runsFinished(c1.frames)}`);

  // TUI joins via the ADVERTISED sync command (carries COSYNCING_BROKER for the isolated port)
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  execSync(`tmux new-session -d -s ${TMUX} -c '${DIR}' "${syncCmd.replace(/"/g, '\\"')}"`);
  check('T2 driven client upgrades to Synced-with-terminal', await waitFor(() => c1.frames.some((f) => f.kind === 'session' && f.info?.control?.terminalSync?.active === true), 30000));

  // SAME text typed INTO the terminal
  await sleep(1500);
  execSync(`tmux send-keys -t ${TMUX} 'hi' Enter`);
  await waitFor(() => runsFinished(c1.frames) >= 2, 60000);

  // SAME text from the app again (now through the bridge)
  c1.send({ kind: 'prompt', text: 'hi' });
  await waitFor(() => runsFinished(c1.frames) >= 3, 60000);
  await sleep(1000);

  const live = userMessages(c1.frames, 'hi');
  const liveKeys = new Set(live.map((m) => m.key));
  check('T3 three same-text user messages reach the client with THREE DISTINCT keys', live.length >= 3 && liveKeys.size >= 3, `count=${live.length} keys=${[...liveKeys].join(',')}`);

  let pane = '';
  try { pane = execSync(`tmux capture-pane -p -t ${TMUX}`).toString(); } catch {}
  const paneUserRows = (pane.match(/^\s*hi\s*$/gm) ?? []).length; // TUI pads user rows with indent
  check('T4 app-sent prompt visible in the terminal pane', paneUserRows >= 2, `pane user rows=${paneUserRows}`);

  const c2 = await attach(session.id);
  await waitFor(() => c2.frames.some((f) => f.kind === 'history'), 15000);
  await sleep(800);
  const hist = userMessages(c2.frames, 'hi');
  const histKeys = new Set(hist.map((m) => m.key));
  check('T5 late-join history carries all three user messages with distinct keys', hist.length >= 3 && histKeys.size >= 3, `count=${hist.length} keys=${[...histKeys].join(',')}`);
  c2.close();

  // T6, the PoC web-UI bubble count, is retired rather than skipped. It drove `/poc-ui/`, which the broker
  // no longer serves, so the stage could only ever reach its catch and print SKIP — a presentation-layer
  // claim that had quietly stopped being made. See RETIRED_POC_UI_TRACES in ./trace-manifest.ts: the
  // replacement is a /cosy/ check against the Flutter client, once a web build exists to drive. T1-T5 above
  // are broker-side and unaffected.
} catch (error) {
  check('trace ran to completion', false, String(error).slice(0, 200));
} finally {
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  broker.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
