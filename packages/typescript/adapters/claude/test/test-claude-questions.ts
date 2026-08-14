/**
 * Claude interactive questions (AskUserQuestion) — Observe read-only surfacing + Drive answer channel.
 * Proves doc-12 Observe 'Questions' row + Drive 'Question input' row for Claude. NO claude, NO model cost
 * (pure mappers + a fake child-proc stdin capture).
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-questions.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapTranscript, ClaudeResumeConnection, ClaudeObserveConnection } from '../src/index.ts';
import type { ClaudeStore } from '../src/index.ts';
import type { AgentMessage, SessionInfo } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ASK = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    id: 'm1',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_q1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which approach?',
              header: 'Approach',
              multiSelect: false,
              options: [
                { label: 'MVP first', description: 'Smallest shippable slice' },
                { label: 'Risk first', description: 'Tackle the unknowns' },
              ],
            },
          ],
        },
      },
    ],
  },
};
const ANSWER_LINE = {
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'MVP first' }] },
};

// ── Part A: Observe / history mapping ──────────────────────────────────────────
{
  const msgs = mapTranscript([ASK, ANSWER_LINE]);
  const q = msgs.find((m: any) => m.type === 'question-request') as any;
  check('AskUserQuestion → question-request (not a generic tool-call) in Observe', !!q && !msgs.some((m: any) => m.type === 'tool-call' && m.toolName === 'AskUserQuestion'));
  check('  question-request is read-only in Observe + carries requestId', q?.readOnly === true && q?.requestId === 'toolu_q1');
  check('  questions/options/multiple mapped from native shape', q?.questions?.[0]?.question === 'Which approach?' && q?.questions?.[0]?.header === 'Approach' && q?.questions?.[0]?.multiple === false && q?.questions?.[0]?.options?.length === 2 && q?.questions?.[0]?.options?.[0]?.label === 'MVP first');
  const resolved = msgs.find((m: any) => m.type === 'question-resolved') as any;
  check('answer tool_result → question-resolved (clears the card), not a tool-result row', resolved?.requestId === 'toolu_q1' && !msgs.some((m: any) => m.type === 'tool-result' && m.callId === 'toolu_q1'));
}

// ── Part A2: malformed AskUserQuestion (Q-3) → generic tool-call, never an orphan question card ──
{
  const MALFORMED = { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bad', name: 'AskUserQuestion', input: { questions: [] } }] } };
  const BAD_ANSWER = { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bad', content: 'x' }] } };
  const msgs = mapTranscript([MALFORMED, BAD_ANSWER]);
  check('malformed AskUserQuestion (no questions) → generic tool-call, not question-request', msgs.some((m: any) => m.type === 'tool-call' && m.callId === 'toolu_bad') && !msgs.some((m: any) => m.type === 'question-request'));
  check('  its answer renders a tool-result, NOT an orphan question-resolved', msgs.some((m: any) => m.type === 'tool-result' && m.callId === 'toolu_bad') && !msgs.some((m: any) => m.type === 'question-resolved'));
}

// ── Part A3: a blocked OBSERVE session surfaces the REAL question (read-only), not just a generic notice ──
//    (maintainer's bug: observe showed "Blocked in terminal — permission prompt" for an AskUserQuestion instead of
//    the actual question. The ASK line is a durable transcript tool_use written when claude asks — verified
//    ~5min before its answer in a real transcript — so getPending() recovers + surfaces it read-only.)
{
  const DIR = mkdtempSync(join(tmpdir(), 'ca-obs-q-'));
  const path = join(DIR, 'sess.jsonl');
  const info: SessionInfo = { id: 'x', tool: 'claude', title: 'obs', cwd: DIR, status: 'needs-input', attachMode: 'observe' } as any;

  // unanswered AskUserQuestion (claude is blocked on it) → getPending surfaces the REAL question, read-only.
  writeFileSync(path, JSON.stringify(ASK) + '\n');
  const pend = new ClaudeObserveConnection(path, info, 'permission prompt').getPending() as any[];
  check('Observe blocked on a question → getPending surfaces the REAL question (read-only), not a generic notice', pend.length === 1 && pend[0].type === 'question-request' && pend[0].readOnly === true && pend[0].requestId === 'toolu_q1' && pend[0].questions?.[0]?.question === 'Which approach?' && !pend.some((p) => p.requestId === 'observe-block'));

  // answered → no pending question → fall back to the generic notice (the genuine-permission / unknown case,
  // OR a claude.ai-bridge session whose in-flight question is buffered off the local transcript).
  writeFileSync(path, JSON.stringify(ASK) + '\n' + JSON.stringify(ANSWER_LINE) + '\n');
  const pend2 = new ClaudeObserveConnection(path, info, 'permission prompt').getPending() as any[];
  check('Observe blocked with NO pending question (e.g. a real permission) → generic read-only notice', pend2.length === 1 && pend2[0].type === 'permission-request' && pend2[0].requestId === 'observe-block' && pend2[0].readOnly === true);
  // The notice must be HONEST: nothing renders because the live turn is held off the local transcript; it must
  // NOT use the old "Blocked in terminal" wording, must NOT promise that Drive answers it (driving discards the
  // pending question), and the title must NOT start with "Waiting for input" (app.js prepends that → stutter).
  check('generic notice is honest (off-disk, Drive WONT answer, no "Blocked in terminal", no title stutter)',
    !/Blocked in terminal/.test(pend2[0].title + pend2[0].detail) &&
    !/^Waiting for input/.test(pend2[0].title) &&
    /local transcript/.test(pend2[0].detail) &&
    /won't answer this pending question/.test(pend2[0].detail) &&
    !/Drive to take over and answer here/.test(pend2[0].detail));

  // not actively blocked (no agents --json waiting reason) → nothing pending.
  check('Observe NOT blocked → getPending empty', (new ClaudeObserveConnection(path, info, undefined).getPending() as any[]).length === 0);
  rmSync(DIR, { recursive: true, force: true });
}

// ── Part B/C/D: Resume Drive actionable question + answer/reject ────────────────
const DIR = mkdtempSync(join(tmpdir(), 'ca-q-'));
const TRANSCRIPT = join(DIR, 'sess.jsonl');
writeFileSync(TRANSCRIPT, '');
const store: ClaudeStore = { configDir: DIR, projectsRoot: join(DIR, 'projects'), bin: 'claude', isDefault: true };
const info: SessionInfo = { id: 'sess', tool: 'claude', title: 'q', cwd: DIR, status: 'idle', attachMode: 'resume' };

async function main(): Promise<void> {
  const conn = new ClaudeResumeConnection(store, TRANSCRIPT, info);
  const msgs: AgentMessage[] = [];
  conn.subscribe((m) => msgs.push(m));

  // A live AskUserQuestion (drive turn) → actionable question-request (no readOnly) + getPending replay.
  (conn as any).emitFinalAssistant({ message: ASK.message });
  const q = msgs.find((m: any) => m.type === 'question-request') as any;
  check('Drive AskUserQuestion → ACTIONABLE question-request (no readOnly)', !!q && q.readOnly === undefined && q.requestId === 'toolu_q1');
  check('  pending question replayed by getPending() for a late tab', (conn.getPending() as any[]).some((p) => p.type === 'question-request' && p.requestId === 'toolu_q1'));

  // answerQuestion writes a tool_result on stdin (native channel, NOT a prompt) + emits question-resolved.
  const stdinWrites: string[] = [];
  (conn as any).proc = { stdin: { write: (s: string) => { stdinWrites.push(s); return true; } } };
  await conn.answerQuestion('toolu_q1', [['Risk first']]);
  const sent = stdinWrites.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) as any[];
  const tr = sent.find((o) => o?.message?.content?.[0]?.type === 'tool_result');
  check('answerQuestion → native tool_result on stdin (not a text prompt)', !!tr && tr.message.content[0].tool_use_id === 'toolu_q1' && /Risk first/.test(String(tr.message.content[0].content)) && !sent.some((o) => o?.message?.content?.[0]?.type === 'text'));
  check('answerQuestion emits question-resolved + clears getPending', msgs.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_q1') && !(conn.getPending() as any[]).some((p) => p.requestId === 'toolu_q1'));

  // rejectQuestion writes an is_error tool_result + resolves.
  (conn as any).pendingQuestionId = 'toolu_q2';
  (conn as any).pendingQuestionCard = { type: 'question-request', requestId: 'toolu_q2', questions: [] };
  const before = stdinWrites.length;
  await conn.rejectQuestion('toolu_q2');
  const rej = stdinWrites.slice(before).map((s) => JSON.parse(s)).find((o) => o?.message?.content?.[0]?.is_error === true);
  check('rejectQuestion → is_error tool_result + question-resolved', !!rej && rej.message.content[0].tool_use_id === 'toolu_q2' && msgs.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_q2'));

  await conn.close();

  // Q-2: answering after the child exited clears the card but does NOT fake a running turn / drop into a dead stdin.
  const conn2 = new ClaudeResumeConnection(store, TRANSCRIPT, info);
  const m2: AgentMessage[] = [];
  conn2.subscribe((m) => m2.push(m));
  (conn2 as any).pendingQuestionId = 'toolu_dead';
  (conn2 as any).pendingQuestionCard = { type: 'question-request', requestId: 'toolu_dead', questions: [] };
  (conn2 as any).proc = undefined; // child already exited
  await conn2.answerQuestion('toolu_dead', [['Yes']]);
  check('answerQuestion after child exit → question-resolved + NO faked running, card cleared', m2.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_dead') && !m2.some((m: any) => m.type === 'status' && m.status === 'running') && !(conn2.getPending() as any[]).some((p) => p.requestId === 'toolu_dead'));
  await conn2.close();

  // ── Part E: control-GATED question (--permission-prompt-tool stdio, the real 2.1.207 drive flow) ──
  // The CLI routes AskUserQuestion through can_use_tool (requires_user_interaction, fires even under
  // auto-allow settings) and blocks the tool. The ONLY answer channel is the control_response's
  // updatedInput.answers — a plain allow self-resolves "The user did not answer the questions." and a
  // tool_result injected afterwards is IGNORED (probed; maintainer's "agent says it does not receive").
  const conn3 = new ClaudeResumeConnection(store, TRANSCRIPT, info);
  const m3: AgentMessage[] = [];
  conn3.subscribe((m) => m3.push(m));
  const w3: string[] = [];
  (conn3 as any).proc = { stdin: { write: (s: string) => { w3.push(s); return true; } } };
  (conn3 as any).emitFinalAssistant({ message: ASK.message }); // tool_use streams first
  (conn3 as any).handleEvent({
    type: 'control_request',
    request_id: 'ctrl_q1',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ASK.message.content[0]!.input, tool_use_id: 'toolu_q1', requires_user_interaction: true },
  });
  check('gated question → NO permission-request card (a question is not an Allow/Deny ask)', !m3.some((m: any) => m.type === 'permission-request'));
  check('gated question → exactly ONE question card (control_request does not duplicate the streamed one)', m3.filter((m: any) => m.type === 'question-request').length === 1);
  await conn3.answerQuestion('toolu_q1', [['Risk first', 'MVP first']]);
  const sent3 = w3.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) as any[];
  const cr = sent3.find((o) => o?.type === 'control_response');
  check('answer rides the control_response (request_id = the gate, allow + updatedInput.answers)',
    !!cr && cr.response?.request_id === 'ctrl_q1' && cr.response?.response?.behavior === 'allow'
    && cr.response?.response?.updatedInput?.answers?.['Which approach?'] === 'Risk first, MVP first'
    && Array.isArray(cr.response?.response?.updatedInput?.questions));
  check('  and NO tool_result is injected (the dead channel the model ignores)', !sent3.some((o) => o?.message?.content?.[0]?.type === 'tool_result'));
  check('  question-resolved + pending cleared', m3.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_q1') && (conn3.getPending() as any[]).length === 0);

  // Reject releases the gate with a PLAIN allow (no answers) → native "did not answer" dismissal.
  (conn3 as any).handleEvent({
    type: 'control_request',
    request_id: 'ctrl_q2',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ASK.message.content[0]!.input, tool_use_id: 'toolu_q2' },
  });
  check('inverted order (gate before tool_use event) still yields the question card', (conn3.getPending() as any[]).some((p) => p.type === 'question-request' && p.requestId === 'toolu_q2'));
  const b3 = w3.length;
  await conn3.rejectQuestion('toolu_q2');
  const rel = w3.slice(b3).map((s) => JSON.parse(s)).find((o) => o?.type === 'control_response');
  check('reject → plain-allow release (no answers key), not a tool_result, resolved', !!rel && rel.response?.request_id === 'ctrl_q2' && rel.response?.response?.behavior === 'allow' && !('answers' in (rel.response?.response?.updatedInput ?? {})) && m3.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_q2'));

  // A result while the question is open (interrupt while gated) resolves the card + drops the stale gate.
  (conn3 as any).handleEvent({
    type: 'control_request',
    request_id: 'ctrl_q3',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ASK.message.content[0]!.input, tool_use_id: 'toolu_q3' },
  });
  (conn3 as any).handleEvent({ type: 'result', is_error: false, result: '' });
  check('result while gated → question-resolved + gate cleared (no stale getPending replay)', m3.some((m: any) => m.type === 'question-resolved' && m.requestId === 'toolu_q3') && (conn3.getPending() as any[]).length === 0 && !(conn3 as any).pendingQuestionControlId);
  await conn3.close();
}

await main().catch((e) => check('test threw', false, String(e)));
rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
