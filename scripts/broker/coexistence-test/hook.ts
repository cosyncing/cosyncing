#!/usr/bin/env bun
/**
 * Universal spike hook handler for the HOOKS spike (resolves D-A / RQ-6).
 *
 * Claude invokes this for whatever hook event is wired in the test's settings.json. It LOGS the full stdin
 * payload (so we can verify the contract against 2.1.185 empirically, not from the docs) and returns a
 * permission decision per HOOK_MODE.
 *
 * The make-or-break mode is `defer`: BLOCK polling a decision file (simulating a remote phone answering)
 * before returning allow/deny — proving a PreToolUse hook can defer to an async remote decision WITHOUT the
 * channel allowlist. If that works, it is the Tier-1 Claude control path the archived channel could not be.
 *
 * Env (passed inline in the settings hook command):
 *   HOOK_SPIKE_DIR  work dir for hooklog.ndjson + decision-*.json    (default /tmp/hooks-spike)
 *   HOOK_MODE       log-only | allow-expected | deny-all | defer | answer-question   (default log-only)
 *   HOOK_EXPECT     substring of tool_input.command that should be allowed (allow-expected)
 *   HOOK_ANSWER     JSON map {question: chosenLabel} for answer-question mode
 *   HOOK_DEFER_MS   max ms to block in defer mode (default 25000)
 * argv[2] = event label (pretooluse | permissionrequest | notification | ...) — for the log only.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.HOOK_SPIKE_DIR || '/tmp/hooks-spike';
const mode = process.env.HOOK_MODE || 'log-only';
const event = process.argv[2] || 'unknown';
const expect = process.env.HOOK_EXPECT || '';
const deferMs = Number(process.env.HOOK_DEFER_MS || '25000');
const ts = () => new Date().toISOString();
function log(o: Record<string, unknown>): void {
  try { appendFileSync(join(dir, 'hooklog.ndjson'), JSON.stringify({ t: ts(), event, mode, ...o }) + '\n'); } catch {}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const raw = await Bun.stdin.text();
let p: any = {};
try { p = JSON.parse(raw); } catch { log({ phase: 'parse-error', raw: raw.slice(0, 400) }); }

const toolName = p?.tool_name;
const toolUseId = p?.tool_use_id || p?.tool_use?.id || '';
const cmd = p?.tool_input?.command ?? '';
log({
  phase: 'received',
  hook_event_name: p?.hook_event_name,
  tool_name: toolName,
  tool_use_id: toolUseId,
  permission_mode: p?.permission_mode,
  notification_type: p?.notification_type,
  message: p?.message,
  title: p?.title,
  command: typeof cmd === 'string' ? cmd.slice(0, 200) : cmd,
  has_questions: Array.isArray(p?.tool_input?.questions),
  top_keys: p && typeof p === 'object' ? Object.keys(p) : [],
});

function emit(decision: 'allow' | 'deny' | 'ask', reason: string, updatedInput?: unknown): void {
  const out: any = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
  if (updatedInput !== undefined) out.hookSpecificOutput.updatedInput = updatedInput;
  log({ phase: 'decision', decision, reason, hasUpdatedInput: updatedInput !== undefined });
  process.stdout.write(JSON.stringify(out));
}

// Notification / PermissionRequest / other non-PreToolUse events: log only, never decide.
if (event !== 'pretooluse') { process.exit(0); }

if (mode === 'log-only') process.exit(0);

if (mode === 'allow-expected') {
  if (typeof cmd === 'string' && expect && cmd.includes(expect)) emit('allow', `expected command (${expect})`);
  else emit('deny', `unexpected command, scoped approver denies: ${String(cmd).slice(0, 80)}`);
  process.exit(0);
}

if (mode === 'deny-all') { emit('deny', 'deny-all mode'); process.exit(0); }

if (mode === 'answer-question') {
  // The spicy claim: answer an AskUserQuestion by returning allow + updatedInput with an answers map.
  // We build the answers map FROM the received questions (keyed by question text we couldn't know ahead of
  // time), choosing option index HOOK_ANSWER_INDEX so the injected choice is distinguishable from any default.
  if (toolName === 'AskUserQuestion') {
    const idx = Number(process.env.HOOK_ANSWER_INDEX || '0');
    const qs: any[] = Array.isArray(p?.tool_input?.questions) ? p.tool_input.questions : [];
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const opts = Array.isArray(q?.options) ? q.options : [];
      const chosen = opts[idx]?.label ?? opts[0]?.label ?? '';
      if (q?.question) answers[q.question] = chosen;
    }
    log({ phase: 'answer-built', answers });
    emit('allow', 'auto-answer via updatedInput', { questions: qs, answers });
  } else {
    emit('allow', 'non-question tool allowed during answer-question test');
  }
  process.exit(0);
}

if (mode === 'defer') {
  // Block until a remote decision lands (simulating the phone). Two file shapes accepted:
  //   decision-<tool_use_id>.json   (per-request)   OR   decision.json (generic)
  const perReq = join(dir, `decision-${toolUseId}.json`);
  const generic = join(dir, 'decision.json');
  const start = Date.now();
  log({ phase: 'defer-start', waitingFor: [perReq, generic], deferMs });
  while (Date.now() - start < deferMs) {
    const path = existsSync(perReq) ? perReq : existsSync(generic) ? generic : '';
    if (path) {
      let d: any = {};
      try { d = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      const decision = (d.decision === 'deny' ? 'deny' : 'allow') as 'allow' | 'deny';
      log({ phase: 'defer-resolved', waitedMs: Date.now() - start, decision, from: path });
      emit(decision, `deferred remote decision after ${Date.now() - start}ms`);
      process.exit(0);
    }
    await sleep(300);
  }
  log({ phase: 'defer-timeout', waitedMs: Date.now() - start });
  emit('deny', `defer timed out after ${deferMs}ms (no remote decision)`);
  process.exit(0);
}

process.exit(0);
