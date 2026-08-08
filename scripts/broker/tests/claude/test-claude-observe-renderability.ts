/**
 * RIGOROUS observe-mode RENDERABILITY proof + a real-data flag for the three bugs maintainer hit repeatedly on a
 * LIVE claude.ai-bridge Claude Code session (our app vs the official app vs the terminal):
 *
 *   (1) QUESTION RENDERABILITY — the central question: "is a blocked session's pending question renderable in
 *       Observe at all?" Answer, proven here as a TRUTH TABLE: a pending AskUserQuestion is renderable in
 *       read-only Observe IFF its tool_use line is ON DISK in the transcript. A LIVE claude.ai-bridge session
 *       BUFFERS its in-flight turn off-disk while blocked, so the pending question is NOT on disk → it CANNOT
 *       be rendered, and getPending() must fall back to an honest notice (never a fabricated question, and
 *       never promising Drive — taking over discards the pending question).
 *   (2) "LOST CONTENT AFTER AN IMAGE" — the mapper does NOT drop content after a SendUserFile; the missing
 *       text was pure in-flight ABSENCE (same root cause as #1), not a mapping bug.
 *   (3) WORKFLOW NOISE — a Workflow tool-call's multi-KB script never renders as a generic tool-call, yet a
 *       FAILED-LAUNCH Workflow (which writes no activity bar) still surfaces as an error row.
 *
 * Zero model cost: pure mappers + getPending + a bounded `claude agents --json` overlay (no turn is started).
 * Part 4 is a REAL-DATA probe over this machine's currently-blocked sessions (SKIPs hermetically if none).
 *
 *   bun run scripts/broker/tests/claude/test-claude-observe-renderability.ts   (exit 0 = all pass)
 */
export {};
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapTranscript, ClaudeObserveConnection } from '../../../../packages/typescript/adapters/claude/src/index.ts';
import type { SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const mkInfo = (cwd: string): SessionInfo => ({ id: 'x', tool: 'claude', title: 't', cwd, status: 'needs-input', attachMode: 'observe' } as any);
const DIR = mkdtempSync(join(tmpdir(), 'ca-renderability-'));
function writeTranscript(name: string, lines: unknown[]): string {
  const p = join(DIR, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const ASK = {
  type: 'assistant', uuid: 'a1',
  message: { id: 'm1', role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [
      { question: 'Add the queue-health guard now?', header: 'Queue guard', multiSelect: false,
        options: [{ label: 'Yes', description: 'add it' }, { label: 'Not now', description: 'later' }] },
    ] } },
  ] },
};
const ANSWER = { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'Yes' }] } };

// ── Part 1: QUESTION RENDERABILITY TRUTH TABLE — renderable IFF the ASK line is on disk ──────────────────
{
  // (1a) PLAIN session, unanswered AskUserQuestion ON DISK → the REAL question renders (read-only).
  const pA = writeTranscript('plain-pending.jsonl', [ASK]);
  const gA = new ClaudeObserveConnection(pA, mkInfo(DIR), 'permission prompt').getPending() as any[];
  check('RENDERABLE: question on disk → getPending surfaces the real read-only question',
    gA.length === 1 && gA[0].type === 'question-request' && gA[0].readOnly === true && gA[0].requestId === 'toolu_q1' && gA[0].questions?.[0]?.question === 'Add the queue-health guard now?');

  // (1b) ANSWERED on disk + still flagged waiting → notice, NEVER the stale/answered question (no fabrication).
  const pB = writeTranscript('plain-answered.jsonl', [ASK, ANSWER]);
  const gB = new ClaudeObserveConnection(pB, mkInfo(DIR), 'permission prompt').getPending() as any[];
  check('answered question on disk → notice, not a re-surfaced answered question', gB.length === 1 && gB[0].requestId === 'observe-block' && !gB.some((m) => m.type === 'question-request'));

  // (1c) BRIDGE-BUFFERED: a real bridge-session shape — bridge-session lines + the in-flight turn TRUNCATED at
  //      a SendUserFile, with the blocking AskUserQuestion held OFF-DISK. THE CORE CASE maintainer hit. The pending
  //      question is genuinely unreachable → honest notice. This is the proof it is NOT renderable in Observe.
  const pC = writeTranscript('bridge-buffered.jsonl', [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'do the picker' } },
    { type: 'bridge-session', bridgeSessionId: 'cse_abc', lastSequenceNum: 0 },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_sf', name: 'SendUserFile', input: { files: ['/tmp/pic.png'], caption: 'the casting board' } },
    ] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sf', content: 'sent' }] }, toolUseResult: { caption: 'the casting board', attachments: [] } },
    // ← the agent then streamed more text + an AskUserQuestion, but the bridge holds them off-disk while blocked
  ]);
  const gC = new ClaudeObserveConnection(pC, mkInfo(DIR), 'permission prompt').getPending() as any[];
  check('CONFIRMED NOT RENDERABLE: bridge-buffered pending question is off-disk → honest notice, no question',
    gC.length === 1 && gC[0].type === 'permission-request' && gC[0].requestId === 'observe-block' && gC[0].readOnly === true && !gC.some((m) => m.type === 'question-request'));
  // the notice must be HONEST and compose cleanly with the app's "Waiting for input: " prefix.
  check('  notice title is the bare reason (no "Waiting for input —" → no stutter under app.js prefix)', gC[0].title === 'permission prompt' && !/^Waiting for input/.test(gC[0].title), JSON.stringify(gC[0].title));
  check('  notice is honest: not "Blocked in terminal", explains off-disk, and that Drive WONT answer it',
    !/Blocked in terminal/.test(gC[0].detail) && /local transcript/.test(gC[0].detail) && /won't answer this pending question/.test(gC[0].detail) && !/Drive to take over and answer here/.test(gC[0].detail));

  // (1d) NOT blocked (no agents --json waiting reason) → nothing pending.
  check('not blocked → getPending empty', (new ClaudeObserveConnection(pC, mkInfo(DIR), undefined).getPending() as any[]).length === 0);
}

// ── Part 2: "LOST CONTENT AFTER AN IMAGE" is NOT a mapping drop ──────────────────────────────────────────
{
  // a real 1x1 PNG so the artifact actually materializes, then assistant TEXT after it.
  const png = join(DIR, 'pic.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'send the board then explain' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sf', name: 'SendUserFile', input: { files: [png], caption: 'board' } }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sf', content: 'sent' }] }, toolUseResult: { caption: 'board', attachments: [{ path: png, isImage: true, media_type: 'image/png', size: statSync(png).size }] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'The picker is updated and pushed. Human-in-the-loop picker ready.' }] } },
  ];
  const msgs = mapTranscript(lines) as any[];
  const artIdx = msgs.findIndex((m) => m.type === 'file-artifact');
  const txtIdx = msgs.findIndex((m) => m.type === 'model-output' && /The picker is updated/.test(m.text));
  check('image (SendUserFile) renders as a file-artifact', artIdx >= 0);
  check('content AFTER the image still renders (no post-artifact drop — the bug-2 root cause was absence, not a drop)', txtIdx >= 0 && txtIdx > artIdx, `art@${artIdx} txt@${txtIdx}`);
}

// ── Part 3: WORKFLOW noise suppressed, but FAILED launch still surfaces (cross-check of the F-A fix) ───────
{
  const ok = mapTranscript([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { description: 'd', script: 'export const meta = {…}\n'.repeat(200) } }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: '{"ok":true}' }] } },
  ]) as any[];
  check('successful Workflow: no tool-call / tool-result row, no script on the wire', !ok.some((m) => (m.type === 'tool-call' || m.type === 'tool-result') && m.toolName === 'Workflow') && !ok.some((m) => JSON.stringify(m).includes('export const meta')));
  const err = mapTranscript([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { description: 'd', script: 'oops' } }] } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', is_error: true, content: '<tool_use_error>Invalid workflow script: Script parse error</tool_use_error>' }] } },
  ]) as any[];
  check('FAILED Workflow launch surfaces as an error row (no silent swallow)', err.some((m) => m.type === 'tool-result' && m.toolName === 'Workflow' && m.isError === true && /Script parse error/.test(String(m.result))));
}

// ── Part 4: REAL-DATA PROBE — classify EVERY currently-blocked session on this machine + assert invariants ──
//    Flags the bug in the wild: for each waiting session it reports whether the pending question is on disk
//    (renderable) or not (the bridge limitation), and asserts getPending() never fabricates a question.
(() => {
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 4000 });
  if (claude.status !== 0) { console.log('SKIP Part 4 real-data probe (no `claude` on PATH)'); return; }
  const cfgDirs = ['.claude', '.claude-mi', '.claude-minimax', '.claude-infini', '.claude-open'].map((d) => join(homedir(), d));
  let waitingSeen = 0;
  for (const cfg of cfgDirs) {
    const projects = join(cfg, 'projects');
    let slugs: string[] = [];
    try { slugs = readdirSync(projects); } catch { continue; }
    // sessionId → transcript path (filename stem == sessionId; depth-1 only, skip <uuid>/subagents files)
    const byId = new Map<string, string>();
    for (const slug of slugs) {
      let files: string[] = [];
      try { files = readdirSync(join(projects, slug)); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) byId.set(f.replace(/\.jsonl$/, ''), join(projects, slug, f));
    }
    let agents: any[] = [];
    try {
      const r = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 4000, maxBuffer: 16 << 20, env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
      if (r.status === 0 && r.stdout) agents = JSON.parse(r.stdout);
    } catch { /* best-effort */ }
    for (const a of Array.isArray(agents) ? agents : []) {
      if (a?.status !== 'waiting') continue;
      const path = byId.get(String(a.sessionId));
      if (!path) continue;
      waitingSeen++;
      // bounded tail read for classification
      let tail = '';
      try { const st = statSync(path); const start = Math.max(0, st.size - 4_000_000); tail = readFileSync(path).subarray(start).toString('utf8'); } catch { /* skip */ }
      const lines = tail.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const asked = new Set<string>(), answered = new Set<string>();
      let isBridge = false;
      for (const o of lines) {
        if (!o) continue;
        if (o.type === 'bridge-session') isBridge = true;
        if (o.type === 'assistant' && Array.isArray(o.message?.content)) for (const b of o.message.content) if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) asked.add(String(b.id));
        if (o.type === 'user' && Array.isArray(o.message?.content)) for (const b of o.message.content) if (b?.type === 'tool_result' && b.tool_use_id) answered.add(String(b.tool_use_id));
      }
      const questionOnDisk = [...asked].some((id) => !answered.has(id));
      const pend = new ClaudeObserveConnection(path, mkInfo(String(a.cwd ?? DIR)), String(a.waitingFor ?? 'blocked')).getPending() as any[];
      const kind = pend[0]?.type === 'question-request' ? 'question' : pend[0]?.requestId === 'observe-block' ? 'notice' : 'none';
      console.log(`    · ${cfg.split('/').pop()}/${String(a.sessionId).slice(0, 8)} bridge=${isBridge} questionOnDisk=${questionOnDisk} waitingFor=${JSON.stringify(a.waitingFor)} → getPending=${kind}`);
      // INVARIANT: getPending renders a question IFF one is on disk; otherwise the honest notice — never a fabrication.
      check(`real waiting session ${String(a.sessionId).slice(0, 8)}: getPending renders a question IFF it is on disk`, (kind === 'question') === questionOnDisk);
      if (!questionOnDisk) check(`  ${String(a.sessionId).slice(0, 8)}: off-disk pending → honest notice (the confirmed limitation)`, kind === 'notice' && !/^Waiting for input/.test(String(pend[0]?.title ?? '')));
    }
  }
  if (waitingSeen === 0) console.log('    (no sessions currently waiting — hermetic parts above carry the proof)');
  else console.log(`    probed ${waitingSeen} waiting session(s)`);
})();

rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
