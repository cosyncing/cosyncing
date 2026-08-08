#!/usr/bin/env bun
/**
 * TUI spike — the Tier-2 monitor apparatus + the Tier-1-in-interactive bridge.
 * Resolves RQ-1/2/3/9 and confirms the hooks path (D-A) works for a LIVE INTERACTIVE session, not just headless.
 *
 * Parts (each prints PASS/FAIL/• into a summary):
 *   A  capture/alt-screen behavior — does Claude's default TUI use the normal buffer (capture-pane -p) or the
 *      alternate screen (needs -a)? compare -p vs -a -p -e. (RQ-9)
 *   B  permission-prompt detection — trigger a gated Write, capture -e, detect the prompt by INVERSE-VIDEO
 *      SGR (reverse \x1b[7m) on the selected option + box-drawing, not just text. (RQ-2, semantic anchor)
 *   C  control-mode %output probe — attach a read-only control client, confirm %output streams raw pty bytes
 *      as the TUI repaints (the production streaming transport). (D-C / RQ-3 transport)
 *   D  hooks-in-INTERACTIVE — launch claude TUI WITH the defer PreToolUse hook; trigger a gated Write; a
 *      "remote phone" writes the decision after the hook blocks; confirm the tool is allowed/denied with NO
 *      human at the terminal and NO lingering prompt. This extends the headless hooks proof to a real TUI.
 *
 * Cost: first-party claude, --model haiku, tiny turns. Run from repo root.
 *   bun run scripts/broker/coexistence-test/tui-spike.ts [--only A,B,C,D] [--keep]
 */
import { rmSync, mkdirSync, writeFileSync, existsSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(import.meta.dir, 'hook.ts');
const BUN = process.execPath;
const DIR = '/tmp/tui-spike';
const LOG = join(homedir(), '.claude', 'cosyncing', 'bridge', 'tui-spike.log');
const args = process.argv.slice(2);
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1]! : 'haiku';
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1]!.split(',') : ['A', 'B', 'C', 'D'];
const KEEP = args.includes('--keep');
const want = (p: string) => ONLY.includes(p);

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(s: string): void { const l = `${ts()} ${s}`; console.log(l); try { mkdirSync(join(homedir(), '.claude', 'cosyncing', 'bridge'), { recursive: true }); appendFileSync(LOG, l + '\n'); } catch {} }
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[>=]/g, '');

function tmux(...a: string[]): string { const p = Bun.spawnSync(['tmux', ...a]); return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr); }
const capPlain = (s: string) => stripAnsi(tmux('capture-pane', '-t', s, '-p'));
const capAltAnsi = (s: string) => tmux('capture-pane', '-t', s, '-a', '-p', '-e', '-q'); // alt buffer + ANSI colors
const capAnsi = (s: string) => tmux('capture-pane', '-t', s, '-p', '-e');
function send(s: string, keys: string, enter = true): void { tmux('send-keys', '-t', s, '--', keys); if (enter) { tmux('send-keys', '-t', s, 'Enter'); } }
/** Type a task and SUBMIT it reliably: the claude TUI sometimes drops a too-quick Enter, so type, then retry
 *  Enter until `engaged()` is true (the model started — a prompt/hook/spinner). Returns whether it engaged. */
async function typeAndSubmit(s: string, text: string, engaged: () => boolean, ms = 30000): Promise<boolean> {
  tmux('send-keys', '-t', s, '--', text);
  const end = Date.now() + ms;
  let attempt = 0;
  while (Date.now() < end) {
    tmux('send-keys', '-t', s, 'Enter');
    const sub = Date.now() + 7000;
    while (Date.now() < sub) { if (engaged()) return true; await sleep(500); }
    attempt++;
    log(`    (re-submitting, attempt ${attempt + 1})`);
  }
  return engaged();
}
async function waitFor(s: string, pred: (t: string) => boolean, ms: number, label: string): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred(capPlain(s))) { log(`  ✓ ${label}`); return true; } await sleep(700); }
  log(`  ✗ TIMEOUT ${label}`); return false;
}

/** Launch a claude TUI in a fresh tmux session in WORK, accept startup menus, return when the idle box is ready. */
async function launchClaude(session: string, work: string, settings?: object): Promise<boolean> {
  tmux('kill-session', '-t', session);
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'README.md'), 'tui spike scratch\n');
  tmux('new-session', '-d', '-s', session, '-x', '220', '-y', '50');
  const settingsArg = settings ? ` --settings ${JSON.stringify(JSON.stringify(settings))}` : '';
  send(session, `cd ${work} && claude --model ${MODEL}${settingsArg}`);
  const MENU = /Enter to confirm|Enter to continue|Do you want to trust|trust the files|❯\s*1\.\s*(Yes|I am)/i;
  const READY = (t: string) => /for shortcuts|Try "|Welcome back|│\s*>/i.test(t);
  const answered = new Set<string>();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const t = capPlain(session);
    if (READY(t) && !MENU.test(t)) { log(`  ✓ ${session} TUI ready`); return true; }
    if (MENU.test(t)) { const k = /trust/i.test(t) ? 'trust' : 'menu'; if (!answered.has(k)) { log(`  … accept menu: ${k}`); tmux('send-keys', '-t', session, 'Enter'); answered.add(k); await sleep(1200); } }
  }
  log(`  ✗ ${session} not ready. pane:\n` + capPlain(session)); return false;
}
function hookSettings(env: Record<string, string>): object {
  const envStr = Object.entries({ HOOK_SPIKE_DIR: DIR, ...env }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  return { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `${envStr} ${BUN} ${HOOK} pretooluse`, timeout: 60 }] }] } };
}
function readHookLog(): any[] { try { return readFileSync(join(DIR, 'hooklog.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
async function waitForDeferStart(ms = 40000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (readHookLog().some((h) => h.phase === 'defer-start')) return true; await sleep(200); } return false; }

const results: { id: string; pass: boolean | null; note: string }[] = [];
const rec = (id: string, pass: boolean | null, note: string) => { results.push({ id, pass, note }); log(`  ${pass === null ? '•' : pass ? 'PASS' : 'FAIL'} ${id}: ${note}`); };

const PERMIT = /Do you want to proceed|Do you want to make this edit|Do you want to create|requires approval|❯\s*1\.\s*Yes/i;
const reverseSeq = (ansi: string) => (ansi.match(/\x1b\[(?:[0-9;]*;)?7(?:;[0-9]+)*m/g) || []).length; // count reverse-video SGRs

log(`=== tui-spike start (model=${MODEL} parts=${ONLY.join('')}) ===`);
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
const S = 'tui-spike';

try {
  // ===== A: capture / alt-screen behavior =====
  if (want('A') || want('B') || want('C')) {
    const ok = await launchClaude(S, join(DIR, 'a'));
    if (!ok) throw new Error('launch A failed');
    if (want('A')) {
      const plain = capPlain(S); const alt = stripAnsi(capAltAnsi(S));
      const plainHasUi = /for shortcuts|Try "|│\s*>|Welcome/i.test(plain);
      rec('A', plainHasUi, `default-buffer capture-pane -p ${plainHasUi ? 'WORKS (normal buffer, NOT alt-screen)' : 'EMPTY (alt-screen → need -a)'}; plainLen=${plain.length} altLen=${alt.length}`);
      log(`    → Claude default TUI uses the ${plainHasUi ? 'NORMAL' : 'ALTERNATE'} buffer. (codex/opencode default to alt-screen → will need -a there.)`);
    }

    // ===== B: permission prompt + inverse-video =====
    if (want('B')) {
      const shown = await typeAndSubmit(S, 'Use the Write tool to create the file proof_b.txt with exactly the text DETECTME. Do nothing else.', () => PERMIT.test(capPlain(S)), 35000);
      log(shown ? '  ✓ permission prompt shown' : '  ✗ no prompt');
      const ansi = capAnsi(S);
      const rev = reverseSeq(ansi);
      const hasBox = /[│╭╮╰╯─┌┐└┘]/.test(ansi);
      const textHit = PERMIT.test(stripAnsi(ansi));
      try { writeFileSync(join(DIR, 'prompt-b.ansi'), ansi); } catch {}
      // Reveal how Claude marks the SELECTED option: the line with ❯ — what SGR sequences wrap it?
      const lines = ansi.split('\n');
      const selLine = lines.find((l) => /❯/.test(l)) || '';
      const sgrs = [...new Set((ansi.match(/\x1b\[[0-9;]*m/g) || []))].slice(0, 14);
      const selSgrs = [...new Set((selLine.match(/\x1b\[[0-9;]*m/g) || []))];
      log(`    selected-line SGRs: ${JSON.stringify(selSgrs)}`);
      log(`    distinct SGRs in prompt: ${JSON.stringify(sgrs)}`);
      rec('B', shown && (rev > 0 || hasBox || textHit), `promptShown=${shown} reverseVideoSGRs=${rev} boxDrawing=${hasBox} textPattern=${textHit} selMarkedBySGR=${selSgrs.length > 0} (best anchor=${rev > 0 ? 'inverse-video' : selSgrs.length > 0 ? 'colored-select(❯ line SGR)' : hasBox ? 'box+text' : 'text-only'})`);
      // decline it to clean up (Escape)
      tmux('send-keys', '-t', S, 'Escape'); await sleep(500);
    }

    // ===== C: control-mode %output streaming probe =====
    if (want('C')) {
      // Control client MUST keep stdin open (tmux -C reads commands from stdin and exits on EOF → no %output).
      const proc = Bun.spawn(['tmux', '-C', 'attach-session', '-t', S], { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
      const collected: string[] = [];
      const reader = (async () => {
        const dec = new TextDecoder();
        const rd = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        try { for (;;) { const { done, value } = await rd.read(); if (done) break; if (value) collected.push(dec.decode(value)); if (collected.join('').length > 200000) break; } } catch { /* killed */ }
      })();
      await sleep(500);
      // A control client receives %output by default; just nudge the TUI to repaint and keep stdin OPEN.
      tmux('send-keys', '-t', S, 'hello'); await sleep(500); // generate output → %output frames
      tmux('send-keys', '-t', S, 'C-u'); await sleep(500); // clear the line
      await sleep(700);
      try { proc.stdin!.end(); proc.kill(); } catch {}
      await Promise.race([reader, sleep(900)]);
      const out = collected.join('');
      const outFrames = (out.match(/%output /g) || []).length;
      const octal = /\\[0-7]{3}/.test(out); // octal-escaped pty bytes
      rec('C', outFrames > 0, `controlMode %output frames=${outFrames} octalEscaped=${octal} (raw pty stream reachable for an emulator)`);
    }
    if (!want('D')) tmux('kill-session', '-t', S);
  }

  // ===== D: hooks in a live INTERACTIVE session (defer → remote allow, then deny) =====
  if (want('D')) {
    for (const decision of ['allow', 'deny'] as const) {
      const sess = `tui-spike-hook-${decision}`;
      const work = join(DIR, `hook-${decision}`);
      writeFileSync(join(DIR, 'hooklog.ndjson'), '');
      rmSync(join(DIR, 'decision.json'), { force: true });
      const ok = await launchClaude(sess, work, hookSettings({ HOOK_MODE: 'defer', HOOK_DEFER_MS: '40000' }));
      if (!ok) { rec(`D-${decision}`, false, 'launch failed'); continue; }
      const proofPath = join(work, `proof_${decision}.txt`);
      // "remote phone" answers only after the hook is observed blocking.
      const writer = (async () => { if (await waitForDeferStart()) { await sleep(2500); writeFileSync(join(DIR, 'decision.json'), JSON.stringify({ decision })); log(`    [remote] wrote decision=${decision}`); } })();
      const engaged = await typeAndSubmit(sess, `Use the Write tool to create the file proof_${decision}.txt with exactly the text DETECTME. Do nothing else.`, () => readHookLog().some((h) => h.phase === 'received'), 35000);
      if (!engaged) log(`    ⚠ hook never fired (model did not call Write) — pane:\n` + capPlain(sess).split('\n').filter(Boolean).slice(-4).join('\n'));
      await writer;
      // give the tool time to run (allow) or be blocked (deny)
      await sleep(4000);
      const hl = readHookLog();
      const fired = hl.some((h) => h.phase === 'received');
      const resolved = hl.find((h) => h.phase === 'defer-resolved');
      const ran = existsSync(proofPath);
      const noLingerPrompt = !PERMIT.test(capPlain(sess));
      const pass = fired && !!resolved && (decision === 'allow' ? ran : !ran) && noLingerPrompt;
      rec(`D-${decision}`, pass, `hookFired=${fired} deferResolved=${!!resolved} waitedMs=${resolved?.waitedMs} fileCreated=${ran} noLingerPrompt=${noLingerPrompt} (interactive session controlled by remote ${decision}, no human at terminal)`);
      if (!KEEP) tmux('kill-session', '-t', sess);
    }
  }

  log('\n=== TUI SPIKE SUMMARY ===');
  for (const r of results) log(`  ${r.pass === null ? '•' : r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.id.padEnd(8)} ${r.note}`);
} catch (e) {
  log('ERROR ' + String(e));
} finally {
  if (!KEEP) { tmux('kill-session', '-t', S); }
  log(`tui-spike done${KEEP ? ' (sessions kept)' : ''}; log: ${LOG}`);
}
