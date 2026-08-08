#!/usr/bin/env bun
/**
 * Claude live-sync HOOKS — the DEFINITIVE real end-to-end (broker + REAL claude + simulated app).
 *
 * Combines both proven halves into one live loop: a real `claude` TUI (with our production hooks installed via
 * --settings, pointed at a test broker) raises a real permission prompt → the PreToolUse hook relays it to the
 * broker → a simulated phone (a WebSocket app client) receives the card and APPROVES → the hook returns allow →
 * claude runs the tool. PASS iff the gated tool ran ONLY because the phone approved it (no human at terminal).
 *
 * Cost: first-party claude on the subscription, --model haiku, one tiny gated turn. Run from repo root.
 *   bun run scripts/broker/coexistence-test/hooks-e2e.ts [--keep]
 */
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSessionId, CLAUDE_HOOK_SCRIPT } from '../../../packages/typescript/adapters/claude/src/index.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const PORT = 7794;
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = '/tmp/hooks-e2e';
const SESSION = 'hooks-e2e';
const BUN = process.execPath;
const KEEP = process.argv.includes('--keep');
const ts = () => new Date().toISOString();
const log = (s: string) => console.log(`${ts()} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[>=]/g, '');
function tmux(...a: string[]): string { const p = Bun.spawnSync(['tmux', ...a]); return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr); }
const cap = () => stripAnsi(tmux('capture-pane', '-t', SESSION, '-p'));
async function post(path: string, body: unknown): Promise<any> { try { return await (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; } }

const PERMIT = /Do you want to proceed|Do you want to create|Do you want to make this edit|requires approval|❯\s*1\.\s*Yes/i;
const hookEnv = (mode: string) => `COSYNCING_BROKER=${JSON.stringify(BASE)} ${JSON.stringify(BUN)} ${JSON.stringify(CLAUDE_HOOK_SCRIPT)} ${mode}`;
const SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: hookEnv('hello'), timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|Update|WebFetch|AskUserQuestion', hooks: [{ type: 'command', command: hookEnv('request'), timeout: 120 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: hookEnv('bye'), timeout: 10 }] }],
  },
};

let broker: any, ws: WebSocket | undefined, verdict = 'INCONCLUSIVE';
try {
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  // 1) broker
  broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COSYNCING_MACHINE: 'hooks-e2e', COSYNCING_BRIDGE_GRACE_MS: '500' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let up = false; for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!up) await sleep(250); }
  log(up ? `✓ broker up :${PORT}` : '✗ broker not up'); if (!up) throw new Error('broker');

  // 2) launch a real claude TUI with our hooks installed (pointed at the test broker)
  tmux('kill-session', '-t', SESSION);
  tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50');
  tmux('send-keys', '-t', SESSION, '--', `cd ${WORK} && claude --model haiku --settings ${JSON.stringify(JSON.stringify(SETTINGS))}`);
  tmux('send-keys', '-t', SESSION, 'Enter');
  const MENU = /Enter to confirm|Enter to continue|trust the files|❯\s*1\.\s*(Yes|I am)/i;
  const READY = (t: string) => /for shortcuts|Try "|Welcome back|│\s*>/i.test(t);
  let ready = false; const answered = new Set<string>();
  for (let i = 0; i < 45 && !ready; i++) { await sleep(1000); const t = cap(); if (READY(t) && !MENU.test(t)) { ready = true; break; } if (MENU.test(t)) { const k = /trust/i.test(t) ? 'trust' : 'menu'; if (!answered.has(k)) { tmux('send-keys', '-t', SESSION, 'Enter'); answered.add(k); await sleep(1200); } } }
  log(ready ? '✓ claude TUI ready' : '✗ TUI not ready'); if (!ready) { log(cap()); throw new Error('tui'); }

  // 3) the SessionStart hook should have hello'd → find the synced session in the roster, get its id
  let id = ''; let cwd = '';
  for (let i = 0; i < 30 && !id; i++) {
    const r = await (await fetch(`${BASE}/api/sessions`)).json().catch(() => ({}));
    const list: any[] = Array.isArray(r?.sessions) ? r.sessions : Array.isArray(r) ? r : [];
    const mine = list.find((s) => s.tool === 'claude' && (s.cwd === WORK || s.id) && s.control?.terminalSync?.active);
    if (mine) { id = mine.id; cwd = mine.cwd; }
    if (!id) await sleep(700);
  }
  log(id ? `✓ session synced in roster: ${id.slice(0, 16)}… (cwd=${cwd})` : '✗ session never appeared synced');
  if (!id) throw new Error('no synced session');

  // 4) attach the simulated phone (WebSocket)
  const frames: any[] = [];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/claude/${id}/stream`);
  await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 8000); });
  ws.onmessage = (ev) => { try { frames.push(JSON.parse(String(ev.data))); } catch {} };
  await sleep(500);
  log('✓ phone (WS) attached');

  // 5) trigger a gated tool in claude; the hook relays it to the broker → the phone
  const proof = join(WORK, 'proof.txt');
  tmux('send-keys', '-t', SESSION, '--', 'Use the Write tool to create proof.txt with exactly the text DETECTME. Do nothing else.');
  // submit with Enter-retry until the phone gets the card or the gated prompt would show
  let card: any;
  for (let i = 0; i < 6 && !card; i++) {
    tmux('send-keys', '-t', SESSION, 'Enter');
    const end = Date.now() + 7000;
    while (Date.now() < end && !card) { card = frames.find((f) => f.kind === 'message' && f.message?.type === 'permission-request')?.message; if (!card) await sleep(400); }
  }
  log(card ? `✓ phone received permission-request: "${card.title}" ${card.detail ?? ''}` : '✗ phone never got the card');
  if (!card) { log(cap()); throw new Error('no card'); }

  // 6) the phone APPROVES → the hook returns allow → claude writes the file
  ws.send(JSON.stringify({ kind: 'approve', requestId: card.requestId, decision: 'approve' }));
  log('→ phone approved');
  let ran = false; for (let i = 0; i < 20 && !ran; i++) { if (existsSync(proof)) ran = true; else await sleep(500); }
  const noLinger = !PERMIT.test(cap());
  verdict = ran && noLinger ? 'PASS' : 'FAIL';
  log(`${verdict === 'PASS' ? '✅' : '❌'} VERDICT ${verdict}: fileCreated=${ran} noLingerPrompt=${noLinger} (claude ran the tool ONLY after the phone approved — no human at terminal)`);
} catch (e) {
  log('ERROR ' + String(e)); verdict = 'ERROR';
} finally {
  try { ws?.close(); } catch {}
  if (!KEEP) { tmux('kill-session', '-t', SESSION); try { broker?.kill(); } catch {} rmSync(WORK, { recursive: true, force: true }); }
  log(`hooks-e2e done: ${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}
