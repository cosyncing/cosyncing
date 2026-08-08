#!/usr/bin/env bun
/**
 * TUI TRACE — "can I read every detail a human sees in the Claude TUI?"
 *
 * Drives a LIVE claude TUI in tmux through a scenario that elicits as many on-screen ornaments as
 * possible (thinking-collapse, working spinner + elapsed, todo panel, tool call, long-output collapse),
 * records the full visible surface frame-by-frame (plain text AND ANSI via capture-pane -e), then:
 *   1. classifies every ornament it saw by how it is rendered (visible / collapsed-summary / ephemeral);
 *   2. sends Ctrl-o to EXPAND a collapsed section and re-captures, proving the body is reachable on demand;
 *   3. diffs the visible surface against the session JSONL, showing what the transcript has that the
 *      collapsed TUI hides (thinking body, diagnostics, etc.) and what the TUI has that the JSONL lacks
 *      (the live spinner + elapsed + token counter — pure ephemeral chrome).
 *
 * The TUI chrome is rendered CLIENT-SIDE, so a cheap backend produces identical ornaments. Run on the
 * first-party model AND a cheap open-model wrapper to prove that:
 *   bun run scripts/broker/coexistence-test/tui-trace.ts --cmd "claude --model haiku"   --label haiku
 *   bun run scripts/broker/coexistence-test/tui-trace.ts --cmd "claude-open"            --label open
 *   bun run scripts/broker/coexistence-test/tui-trace.ts --cmd "claude-mi"              --label mi
 * Flags: --cmd "<launch command>" (required-ish; default first-party haiku) --label <name> --keep
 * Artifacts: /tmp/tui-trace/<label>/ (frames.ndjson, last.plain.txt, last.ansi.txt, expanded.txt, report.json)
 */
import { rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const CMD = flag('--cmd', 'claude --model haiku')!;            // the launch command (wrapper or first-party)
const LABEL = flag('--label', 'haiku')!;
const KEEP = args.includes('--keep');
const OUT = join('/tmp/tui-trace', LABEL);
const S = `tui-trace-${LABEL}`;
const WORK = join('/tmp/tui-trace', `work-${LABEL}`);
// Wrappers set their own CLAUDE_CONFIG_DIR; mirror it so we can find the transcript the same way claude does.
const CONFIG_DIR =
  CMD.includes('claude-open') ? join(homedir(), '.claude-open')
  : CMD.includes('claude-mi') ? join(homedir(), '.claude-mi')
  : CMD.includes('claude-minimax') ? join(homedir(), '.claude-minimax')
  : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${ts()} ${s}`);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[>=]/g, '');
function tmux(...a: string[]): string { const p = Bun.spawnSync(['tmux', ...a]); return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr); }
const capPlain = () => stripAnsi(tmux('capture-pane', '-t', S, '-p'));
const capAnsi = () => tmux('capture-pane', '-t', S, '-p', '-e');
const capScroll = () => stripAnsi(tmux('capture-pane', '-t', S, '-p', '-S', '-2000')); // include scrollback

// ---- the ornament catalog: every distinct thing a human sees painted in the Claude TUI -------------
type Kind = 'ephemeral' | 'collapsed' | 'visible' | 'ide';
const ORNAMENTS: { id: string; re: RegExp; kind: Kind; note: string }[] = [
  { id: 'spinner',      re: /(esc to interrupt|to interrupt\))/,                 kind: 'ephemeral', note: 'live working line: verb + elapsed + token counter + esc-to-interrupt' },
  { id: 'spinner-verb', re: /^[\s]*[✻✶✳✺✷·*●][^\n]*\b(for \d+|\d+s\b)/m,         kind: 'ephemeral', note: '"✻ Crunched for 7m 44s" elapsed badge' },
  { id: 'thinking-live',re: /(✻|·)\s*(Thinking|Pondering|Reasoning)…/,           kind: 'ephemeral', note: 'live "✻ Thinking…" while reasoning streams' },
  { id: 'thinking-done',re: /Thought for \d+s/,                                  kind: 'collapsed', note: '"Thought for 10s (ctrl+o to expand)" — body lives in JSONL type:thinking' },
  { id: 'todos',        re: /(Update Todos|☐|☒|▢|▣|◻|◼)/,                          kind: 'visible',   note: 'todo panel — body lives in JSONL TodoWrite' },
  { id: 'tool-call',    re: /^[\s]*⏺\s+\w+\(/m,                                   kind: 'visible',   note: '"⏺ Bash(cmd)" tool invocation — JSONL tool_use' },
  { id: 'tool-output',  re: /⎿/,                                                 kind: 'visible',   note: '"⎿ output" tool result branch — JSONL tool_result' },
  { id: 'output-collapse', re: /\+\d+ lines? \(ctrl\+o to expand\)/,             kind: 'collapsed', note: 'long output collapsed to "+N lines (ctrl+o to expand)" — full body in JSONL' },
  { id: 'collapse-any', re: /\(ctrl\+o to expand\)/,                             kind: 'collapsed', note: 'any collapsed section marker' },
  { id: 'permission',   re: /(Do you want to (proceed|make this edit|create)|❯\s*1\.\s*Yes)/, kind: 'visible', note: 'permission prompt box (off-disk → only hooks/TUI see it live)' },
  { id: 'question',     re: /(Select an option|❯\s*1\.|press \d to select)/,     kind: 'visible',   note: 'AskUserQuestion box (off-disk)' },
  { id: 'recap',        re: /※\s*recap/i,                                        kind: 'visible',   note: '"※ recap:" context recap — body in JSONL (compact summary)' },
  { id: 'diagnostics',  re: /\d+ new diagnostic issues?/,                        kind: 'collapsed', note: '"Found 29 new diagnostic issues (ctrl+o to expand)" — IDE/LSP gated; body in JSONL' },
  { id: 'ide-select',   re: /⧉\s*Selected \d+ lines? from .* in /,               kind: 'ide',       note: '"⧉ Selected N lines from FILE in Visual Studio Code" — IDE gated; injected into JSONL' },
  { id: 'input-box',    re: /│\s*>/,                                             kind: 'visible',   note: 'the input composer box' },
  { id: 'mode-footer',  re: /(⏵⏵\s*accept edits|bypass permissions|plan mode on|accept edits on)/i, kind: 'ephemeral', note: 'permission-mode footer (⏵⏵ accept edits on)' },
  { id: 'context-meta', re: /(Context (left|low)|% context|tokens? (left|remaining)|auto-compact)/i, kind: 'ephemeral', note: 'context-usage / auto-compact meter' },
];

// ---- frame recorder --------------------------------------------------------------------------------
type Frame = { t: string; plain: string };
const frames: Frame[] = [];
const seen = new Map<string, { firstT: string; line: string }>(); // ornament id -> first sighting
function snap(): string {
  const plain = capPlain();
  const last = frames[frames.length - 1];
  if (!last || last.plain !== plain) frames.push({ t: ts(), plain });
  // ornament detection against the FULL visible surface (incl. scrollback so we don't miss scrolled lines)
  const surface = plain + '\n' + capScroll();
  for (const o of ORNAMENTS) {
    if (seen.has(o.id)) continue;
    const m = surface.match(o.re);
    if (m) {
      const line = (surface.split('\n').find((l) => o.re.test(l)) || m[0]).trim();
      seen.set(o.id, { firstT: ts(), line });
      log(`  ◆ ornament '${o.id}' [${o.kind}] → ${JSON.stringify(line.slice(0, 110))}`);
    }
  }
  return plain;
}
async function record(durationMs: number, idleQuietMs = 6000): Promise<void> {
  const end = Date.now() + durationMs;
  let lastChange = Date.now();
  let prev = '';
  while (Date.now() < end) {
    const p = snap();
    if (p !== prev) { lastChange = Date.now(); prev = p; }
    // stop early once the spinner is gone and the surface has been quiet for idleQuietMs (turn done)
    const spinning = /(esc to interrupt|to interrupt\))/.test(p);
    if (!spinning && Date.now() - lastChange > idleQuietMs && seen.size > 0) break;
    await sleep(350);
  }
}

async function launch(): Promise<boolean> {
  tmux('kill-session', '-t', S);
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, 'README.md'), '# tui-trace scratch\nsome lines\n');
  tmux('new-session', '-d', '-s', S, '-x', '220', '-y', '50');
  // allow `ls` so the tool flows without a permission stop (we cover the permission box separately).
  const settings = JSON.stringify(JSON.stringify({ permissions: { allow: ['Bash(ls:*)', 'Bash(cat:*)'] } }));
  tmux('send-keys', '-t', S, '--', `cd ${WORK} && ${CMD} --settings ${settings}`);
  tmux('send-keys', '-t', S, 'Enter');
  const MENU = /Enter to confirm|Enter to continue|Do you want to trust|trust the files|❯\s*1\.\s*(Yes|I am)/i;
  const READY = (t: string) => /for shortcuts|Try "|Welcome back|│\s*>/i.test(t);
  const answered = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const t = capPlain();
    if (READY(t) && !MENU.test(t)) { log(`  ✓ ${LABEL} TUI ready (${CMD})`); return true; }
    if (MENU.test(t)) { const k = /trust/i.test(t) ? 'trust' : 'menu'; if (!answered.has(k)) { log(`  … accept menu: ${k}`); tmux('send-keys', '-t', S, 'Enter'); answered.add(k); await sleep(1200); } }
  }
  log(`  ✗ ${LABEL} not ready. pane:\n` + capPlain()); return false;
}

async function typeAndSubmit(text: string, started: () => boolean, ms = 40000): Promise<boolean> {
  tmux('send-keys', '-t', S, '--', text);
  const end = Date.now() + ms;
  let attempt = 0;
  while (Date.now() < end) {
    tmux('send-keys', '-t', S, 'Enter');
    const sub = Date.now() + 8000;
    while (Date.now() < sub) { if (started()) return true; await sleep(500); }
    log(`    (re-submitting prompt, attempt ${++attempt + 1})`);
  }
  return started();
}

function findTranscript(): string | undefined {
  const root = join(CONFIG_DIR, 'projects');
  if (!existsSync(root)) return undefined;
  let best: { p: string; m: number } | undefined;
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let entries: string[]; try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f); const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best?.p;
}

// ---- main ------------------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
log(`=== tui-trace start label=${LABEL} cmd=${JSON.stringify(CMD)} config=${CONFIG_DIR} ===`);
const report: any = { label: LABEL, cmd: CMD, startedAt: ts() };
try {
  if (!(await launch())) throw new Error('launch failed');

  // Scenario: think (→ thinking + spinner), make a todo plan, then run a long-output bash tool (→ tool
  // call + ⎿ output collapse). One turn, maximal ornament coverage.
  const PROMPT =
    'Think hard step by step first, then do this: create a short todo list of your plan using your todo tool, ' +
    'then run the shell command `ls -la /usr/bin` and finally tell me the total number of entries. Be deliberate.';
  log('  → sending scenario prompt (think + todos + long-output tool)…');
  const started = await typeAndSubmit(PROMPT, () => /(esc to interrupt|to interrupt\)|⏺|Thinking|✻|✶|✳)/.test(capPlain()), 40000);
  log(started ? '  ✓ turn started' : '  ⚠ turn may not have started');

  await record(150000 /* up to 2.5 min */);
  const lastPlain = capPlain(); const lastAnsi = capAnsi();
  writeFileSync(join(OUT, 'last.plain.txt'), lastPlain);
  writeFileSync(join(OUT, 'last.ansi.txt'), lastAnsi);
  writeFileSync(join(OUT, 'frames.ndjson'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');

  // ---- EXPAND a collapsed section: send Ctrl-o, confirm the body becomes visible -------------------
  let expandProof: any = { attempted: false };
  if (seen.has('collapse-any') || seen.has('output-collapse') || seen.has('thinking-done')) {
    log('  → collapsed section present; sending Ctrl-o to expand…');
    const before = capScroll();
    tmux('send-keys', '-t', S, 'C-o'); await sleep(1500);
    const after = capScroll();
    writeFileSync(join(OUT, 'expanded.txt'), after);
    const grew = after.length > before.length + 40;
    const collapseGone = !/\(ctrl\+o to expand\)/.test(after) || after.length > before.length;
    expandProof = { attempted: true, beforeLen: before.length, afterLen: after.length, grew, collapseGone };
    log(`  ${grew ? '✓' : '•'} expand: before=${before.length} after=${after.length} grew=${grew}`);
  }
  report.expandProof = expandProof;

  // ---- diff against the JSONL transcript (the structured truth) ------------------------------------
  const tpath = findTranscript();
  let jsonl: any = { found: false };
  if (tpath && existsSync(tpath)) {
    const raw = readFileSync(tpath, 'utf8');
    jsonl = {
      found: true, path: tpath, bytes: raw.length,
      hasThinkingBlock: /"type":"thinking"/.test(raw),
      hasTodoWrite: /"name":"TodoWrite"/.test(raw),
      hasToolUse: /"type":"tool_use"/.test(raw),
      hasToolResult: /"type":"tool_result"/.test(raw),
      // pure-ephemeral chrome that should NOT be in the JSONL:
      hasSpinnerText: /esc to interrupt/.test(raw),
      hasElapsedBadge: /Crunched for|for \d+m \d+s \(/.test(raw),
    };
    log(`  ✓ transcript ${tpath} (${raw.length}b): thinkingBlock=${jsonl.hasThinkingBlock} todoWrite=${jsonl.hasTodoWrite} spinnerInJsonl=${jsonl.hasSpinnerText}`);
  } else {
    log('  • no transcript found to diff');
  }
  report.jsonl = jsonl;

  report.ornaments = ORNAMENTS.map((o) => ({ id: o.id, kind: o.kind, seen: seen.has(o.id), line: seen.get(o.id)?.line || null, note: o.note }));
  report.frameCount = frames.length;
  report.finishedAt = ts();
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  // ---- summary table -------------------------------------------------------------------------------
  log('\n=== TUI-TRACE SUMMARY (' + LABEL + ') ===');
  log(`  frames recorded: ${frames.length}; transcript: ${jsonl.found ? jsonl.path : 'none'}`);
  log('  ornament                 seen  kind        readable-via-capture-pane?');
  for (const o of report.ornaments) {
    const verdict = !o.seen ? '(not elicited this run)'
      : o.kind === 'ephemeral' ? 'YES — only capture-pane has it (never in JSONL)'
      : o.kind === 'collapsed' ? 'SUMMARY line YES; body needs Ctrl-o OR read JSONL'
      : o.kind === 'ide' ? 'YES if rendered (IDE-gated); also injected into JSONL'
      : 'YES — fully on screen';
    log(`  ${o.id.padEnd(22)} ${o.seen ? ' ✓ ' : ' · '}  ${o.kind.padEnd(10)} ${verdict}`);
  }
  log(`\n  → artifacts: ${OUT}`);
} catch (e) {
  log('ERROR ' + String(e));
  report.error = String(e);
  try { writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); } catch {}
} finally {
  if (!KEEP) tmux('kill-session', '-t', S);
  log(`tui-trace done${KEEP ? ' (session kept)' : ''}.`);
}
