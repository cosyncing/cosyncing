#!/usr/bin/env bun
/**
 * cosyncing — Claude live-sync HOOK (in-session side).
 *
 * Installed into the user's Claude settings as a PreToolUse hook (+ optional SessionStart/SessionEnd). When
 * Claude is about to run a tool that needs approval, or asks an AskUserQuestion, this hook relays it to the
 * broker (→ the phone over the encrypted WS), BLOCKS for the user's answer, and returns the decision to
 * Claude — which honors it. No `claude/channel` allowlist required (a hook is the user's own trusted local
 * callback). Proven on claude 2.1.185: docs/protocol/adapter-support.md.
 *
 * Modes (argv[2]): `request` (PreToolUse, default) · `hello` (SessionStart) · `bye` (SessionEnd).
 *
 * Safety / non-intrusiveness:
 *  - Only relays tools that would actually prompt (a sensitive set), and respects the session's
 *    permission_mode (bypassPermissions → never relay; acceptEdits → don't relay edits).
 *  - Fails OPEN to the terminal: if the broker is unreachable, no app is attached, or the wait times out,
 *    it returns NOTHING (exit 0) so Claude's own permission flow takes over (the human at the terminal).
 *    It NEVER auto-allows on failure.
 *
 * Settings:  COSYNCING_BROKER (broker base URL, default http://127.0.0.1:7734),
 *            COSYNCING_HOOK_DEADLINE_MS (max total wait before fail-open; default 280000),
 *            COSYNCING_HOOK_SENSITIVE (comma list overriding the default sensitive tool set).
 */
const BROKER = (process.env.COSYNCING_BROKER ?? 'http://127.0.0.1:7734').replace(/\/$/, '');
// Optional shared secret (only required when the broker is exposed beyond loopback). Baked into the hook
// command env by installClaudeHooks; sent as x-cosyncing-token so the broker authorizes the relay/approve.
const TOKEN = process.env.COSYNCING_TOKEN?.trim() || '';
const DEADLINE_MS = Number(process.env.COSYNCING_HOOK_DEADLINE_MS || '280000');
const MODE = process.argv[2] || 'request';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update']);
const DEFAULT_SENSITIVE = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update', 'WebFetch']);
const SENSITIVE = process.env.COSYNCING_HOOK_SENSITIVE
  ? new Set(process.env.COSYNCING_HOOK_SENSITIVE.split(',').map((s) => s.trim()).filter(Boolean))
  : DEFAULT_SENSITIVE;

const sessionId = (transcriptPath: string) => Buffer.from(transcriptPath, 'utf8').toString('base64url');

async function readStdin(): Promise<any> {
  try { return JSON.parse(await Bun.stdin.text()); } catch { return {}; }
}
async function post(path: string, body: unknown, timeoutMs = 23000): Promise<any | null> {
  try {
    const res = await fetch(`${BROKER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-cosyncing-token': TOKEN } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json().catch(() => ({}));
  } catch { return null; }
}

function permissionDetail(toolName: string, input: any): string {
  if (toolName === 'Bash') return String(input?.command ?? '');
  if (EDIT_TOOLS.has(toolName)) return String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '');
  if (toolName === 'WebFetch') return String(input?.url ?? '');
  try { return JSON.stringify(input).slice(0, 300); } catch { return ''; }
}

/** Emit a PreToolUse decision Claude honors and exit. */
function decide(decision: 'allow' | 'deny', reason: string, updatedInput?: unknown): never {
  const out: any = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
  if (updatedInput !== undefined) out.hookSpecificOutput.updatedInput = updatedInput;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
/** Fail open: return nothing → Claude's own permission flow handles it (the terminal). */
function passthrough(): never { process.exit(0); }

// ── hello / bye ─────────────────────────────────────────────────────────────
if (MODE === 'hello') {
  const p = await readStdin();
  const transcriptPath = String(p?.transcript_path ?? '');
  if (transcriptPath) {
    await post('/claude/hook/hello', {
      transcriptPath,
      sessionUuid: String(p?.session_id ?? ''),
      cwd: p?.cwd ? String(p.cwd) : undefined,
      model: p?.model ? String(p.model) : undefined,
      effort: p?.effort ? String(p.effort) : undefined,
    });
  }
  process.exit(0);
}
if (MODE === 'bye') {
  const p = await readStdin();
  const transcriptPath = String(p?.transcript_path ?? '');
  if (transcriptPath) await post('/claude/hook/bye', { id: sessionId(transcriptPath), reason: String(p?.reason ?? 'SessionEnd') });
  process.exit(0);
}
// Turn-boundary status: UserPromptSubmit → working, Stop → idle (live spinner on the synced session).
if (MODE === 'working' || MODE === 'idle') {
  const p = await readStdin();
  const transcriptPath = String(p?.transcript_path ?? '');
  if (transcriptPath) await post('/claude/hook/status', { id: sessionId(transcriptPath), transcriptPath, state: MODE, cwd: p?.cwd ? String(p.cwd) : undefined });
  process.exit(0);
}

// ── request (PreToolUse) ──────────────────────────────────────────────────────
const p = await readStdin();
const toolName = String(p?.tool_name ?? '');
const toolUseId = String(p?.tool_use_id ?? p?.tool_use?.id ?? '');
const transcriptPath = String(p?.transcript_path ?? '');
const permissionMode = String(p?.permission_mode ?? 'default');
const input = p?.tool_input ?? {};
if (!transcriptPath || !toolUseId) passthrough();

const isQuestion = toolName === 'AskUserQuestion';
// Decide whether this tool would prompt — only relay those (respect the session's permission mode).
if (!isQuestion) {
  if (permissionMode === 'bypassPermissions') passthrough();
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) passthrough();
  if (!SENSITIVE.has(toolName)) passthrough();
}

const id = sessionId(transcriptPath);
const body: any = {
  id, requestId: toolUseId, kind: isQuestion ? 'question' : 'permission',
  toolName, transcriptPath, sessionUuid: String(p?.session_id ?? ''), cwd: p?.cwd ? String(p.cwd) : undefined,
};
if (isQuestion) body.questions = input?.questions;
else { body.title = toolName === 'Bash' ? 'Run command' : `${toolName}`; body.detail = permissionDetail(toolName, input); body.toolInput = input; }

const deadline = Date.now() + DEADLINE_MS;
let everReached = false;
while (Date.now() < deadline) {
  const res = await post('/claude/hook/request', body);
  if (res === null) { // broker unreachable
    if (!everReached) passthrough(); // never reached it → fail open immediately
    await sleep(1000); continue; // transient blip after a good contact → brief retry
  }
  everReached = true;
  if (res.viewers === 0) passthrough(); // no phone watching → let the terminal handle it
  if (res.resolved) {
    if (res.kind === 'answer' && isQuestion) {
      const questions: any[] = Array.isArray(input?.questions) ? input.questions : [];
      const answers: string[][] = Array.isArray(res.answers) ? res.answers : [];
      const map: Record<string, string> = {};
      questions.forEach((q, i) => { if (q?.question) map[q.question] = (answers[i] ?? []).join(', '); });
      decide('allow', 'answered from cosyncing', { questions, answers: map });
    }
    if (res.kind === 'reject') decide('deny', isQuestion ? 'question dismissed from cosyncing' : 'denied from cosyncing');
    // permission decision
    const allow = res.decision === 'approve' || res.decision === 'approve-session';
    decide(allow ? 'allow' : 'deny', `${allow ? 'approved' : 'denied'} from cosyncing`);
  }
  // resolved:false → long-poll returned empty, re-post until the deadline
}
passthrough(); // deadline → fail open to the terminal
