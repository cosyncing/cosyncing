/**
 * Claude subagent + workflow ACTIVITY surfacing tests (the auto-rendered progress cards).
 *
 * buildActivitySnapshot() turns Claude's on-disk sibling tree (subagents/agent-<id>.jsonl + .meta.json,
 * workflows/wf_<id>.json, subagents/workflows/wf_<id>/journal.jsonl) into canonical `agent-activity`
 * frames — with NO model cost (pure filesystem reads) and NO tool-name branching in the UI. This test
 * builds a deterministic FIXTURE covering every branch, then smoke-tests the real session dir if it
 * happens to exist on this machine.
 *
 *   1. parent-spawned subagent (meta has toolUseId) → kind 'subagent', agentsTotal 1, elapsed + tokens.
 *   2. subagent status: running (fresh, unresolved) / done-by-resolved / done-by-idle (stale mtime).
 *   3. completed workflow (wf_*.json) → kind 'workflow', done/total + tokens + children mirror state.
 *   4. live workflow (journal.jsonl, no top-level json) → status running, started/done from the journal.
 *   5. a {agentType:'workflow-subagent'} meta (no toolUseId) is NOT emitted as a standalone subagent.
 *
 *   bun run packages/typescript/adapters/claude/test/test-claude-activity.ts      (exit 0 = all pass)
 */
export {};
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildActivitySnapshot, collectParentActivity, claudeActivityDir, ClaudeActivityWatcher, mapTranscript } from '../src/index.ts';
import type { AgentMessage } from '../../../adapter-api/src/index.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── build a fixture session tree ────────────────────────────────────────────────
const ROOT = join(tmpdir(), 'ca-claude-activity-fixture');
rmSync(ROOT, { recursive: true, force: true });
const transcript = join(ROOT, 'sess.jsonl');
const sess = claudeActivityDir(transcript); // = <ROOT>/sess
check('claudeActivityDir strips .jsonl', sess === join(ROOT, 'sess'), sess);

const sub = join(sess, 'subagents');
const wf = join(sess, 'workflows');
const liveWf = join(sub, 'workflows', 'wf_live01');
mkdirSync(sub, { recursive: true });
mkdirSync(wf, { recursive: true });
mkdirSync(liveWf, { recursive: true });
writeFileSync(transcript, '');

// (1) a parent-spawned subagent: meta + a 2-turn transcript (elapsed 120s, 300 output tokens over 2 msg ids)
writeFileSync(
  join(sub, 'agent-A.meta.json'),
  JSON.stringify({ agentType: 'general-purpose', description: 'Review the observe adapter', toolUseId: 'toolu_A' }),
);
writeFileSync(
  join(sub, 'agent-A.jsonl'),
  [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:00.000Z', message: { id: 'm1', usage: { output_tokens: 100 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:00.000Z', message: { id: 'm1', usage: { output_tokens: 100 } } }), // dup id → must NOT double-count
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:02:00.000Z', message: { id: 'm2', usage: { output_tokens: 200 } } }),
  ].join('\n') + '\n',
);

// W4a: background subagent whose parent tool_result is only the async launch ack. The subagent is quiet
// for 3 minutes while inside an unresolved Bash tool call; it must stay running until a task-notification
// or a much longer in-tool-call stale window.
writeFileSync(
  join(sub, 'agent-B.meta.json'),
  JSON.stringify({ agentType: 'general-purpose', description: 'Background sleep test', toolUseId: 'toolu_B' }),
);
writeFileSync(
  join(sub, 'agent-B.jsonl'),
  [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:00.000Z', message: { id: 'b1', content: [{ type: 'tool_use', id: 'bash_B', name: 'Bash', input: { command: 'sleep 5m' } }] } }),
  ].join('\n') + '\n',
);
{
  const nowSec = Date.now() / 1000;
  utimesSync(join(sub, 'agent-B.jsonl'), nowSec - 180, nowSec - 180);
}

// W4b/W4d: foreground subagent that ends with final assistant text, and usage grows on one message.id.
writeFileSync(
  join(sub, 'agent-C.meta.json'),
  JSON.stringify({ agentType: 'general-purpose', description: 'Foreground final text and max-token test', toolUseId: 'toolu_C' }),
);
writeFileSync(
  join(sub, 'agent-C.jsonl'),
  [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:00.000Z', message: { id: 'grow', usage: { output_tokens: 4 }, content: [{ type: 'text', text: 'working' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:01.000Z', message: { id: 'grow', usage: { output_tokens: 287 }, content: [{ type: 'text', text: 'still working' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:00:02.000Z', message: { id: 'other', usage: { output_tokens: 86 }, content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n',
);

// (5) a workflow-subagent meta (no toolUseId) — must be SKIPPED as a standalone subagent card
writeFileSync(join(sub, 'agent-W.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
writeFileSync(join(sub, 'agent-W.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:01:00.000Z', message: {} }) + '\n');

// (3) a completed workflow
writeFileSync(
  join(wf, 'wf_done01.json'),
  JSON.stringify({
    runId: 'wf_done01',
    workflowName: 'review-changes',
    status: 'completed',
    durationMs: 377253,
    totalTokens: 264463,
    totalToolCalls: 95,
    agentCount: 2,
    phases: [{ title: 'Review', detail: 'x' }, { title: 'Verify', detail: 'y' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Review' },
      { type: 'workflow_agent', index: 1, label: 'review:bugs', phaseTitle: 'Review', agentId: 'g1', state: 'done', durationMs: 5000, tokens: 1000 },
      { type: 'workflow_agent', index: 2, label: 'review:perf', phaseTitle: 'Review', agentId: 'g2', state: 'error', durationMs: 2000, tokens: 500 },
    ],
  }),
);

// (3b) a completed workflow WITH a `summary` → bar title prefers the human summary (= meta.description),
//      so it reads like Claude Code's native "Dynamic workflow «…»" line instead of the slug name.
writeFileSync(
  join(wf, 'wf_done02.json'),
  JSON.stringify({
    runId: 'wf_done02',
    workflowName: 'claude-workflow-display-audit',
    summary: 'Confirm the Claude adapter emits everything the shipped renderer consumes',
    status: 'completed',
    durationMs: 247389,
    agentCount: 4,
    phases: [{ title: 'Cross-check' }, { title: 'Synthesize' }],
    workflowProgress: [],
  }),
);

// (4) a live workflow: journal with 2 started, 1 result, and NO top-level wf_live01.json
writeFileSync(
  join(liveWf, 'journal.jsonl'),
  [
    JSON.stringify({ agentId: 'L1', key: 'a', type: 'started' }),
    JSON.stringify({ agentId: 'L2', key: 'b', type: 'started' }),
    JSON.stringify({ agentId: 'L1', key: 'a', type: 'result', result: {} }),
  ].join('\n') + '\n',
);

// (4b) a live workflow whose agents ALL resolved but with NO top-level json (crashed before flush) — must
// derive status 'done', NOT linger as a permanently-running bar.
const fullWf = join(sub, 'workflows', 'wf_full01');
mkdirSync(fullWf, { recursive: true });
writeFileSync(
  join(fullWf, 'journal.jsonl'),
  [
    JSON.stringify({ agentId: 'F1', type: 'started' }),
    JSON.stringify({ agentId: 'F2', type: 'started' }),
    JSON.stringify({ agentId: 'F1', type: 'result', result: {} }),
    JSON.stringify({ agentId: 'F2', type: 'result', result: {} }),
  ].join('\n') + '\n',
);

// (4c) ACT-1 regression: an ACTIVELY-running fan-out whose JOURNAL mtime is stale (40 min) but which has a
// FRESH per-agent agent-*.jsonl heartbeat (30 s) — the live card must stay RUNNING. The journal is touched
// only on agent started/result, so it is NOT the heartbeat; the per-agent transcript is.
const activeWf = join(sub, 'workflows', 'wf_active01');
mkdirSync(activeWf, { recursive: true });
writeFileSync(join(activeWf, 'journal.jsonl'), [JSON.stringify({ agentId: 'X1', type: 'started' }), JSON.stringify({ agentId: 'X2', type: 'started' })].join('\n') + '\n');
writeFileSync(join(activeWf, 'agent-x1.jsonl'), JSON.stringify({ type: 'assistant', message: {} }) + '\n');
{
  const nowSec = Date.now() / 1000;
  utimesSync(join(activeWf, 'journal.jsonl'), nowSec - 2400, nowSec - 2400); // journal 40 min stale
  utimesSync(join(activeWf, 'agent-x1.jsonl'), nowSec - 30, nowSec - 30); // agent transcript fresh (30 s)
}

// ── assertions ───────────────────────────────────────────────────────────────────
const NOW_FRESH = Date.now(); // file mtimes are ~now → subagent A NOT idle
const NOW_STALE = Date.now() + 1_000_000_000; // far future → A's mtime is stale → idle → done

const fresh = buildActivitySnapshot(sess, new Set(), NOW_FRESH);
const byKey = new Map(fresh.map((f) => [f.msg.key, f.msg]));

const A = byKey.get('agent:toolu_A');
check('subagent A is emitted (kind subagent)', !!A && A.kind === 'subagent');
check('subagent A title = description, subtitle = agentType', A?.title === 'Review the observe adapter' && A?.subtitle === 'general-purpose');
// RUNNING elapsed is wall-clock since the agent's first event (round 4 — the file span freezes
// during quiet tool calls); the DONE case below keeps the exact file span.
check('subagent A running elapsed = wall-clock since start', A?.elapsedMs === NOW_FRESH - Date.parse('2026-06-16T10:00:00.000Z'), String(A?.elapsedMs));
check('subagent A tokens = 300 (dup message.id not double-counted)', A?.tokens?.output === 300, String(A?.tokens?.output));
check('subagent A agentsTotal 1', A?.agentsTotal === 1);
check('subagent A is RUNNING (unresolved + fresh mtime)', A?.status === 'running', A?.status);

const parentBackground = {
  backgroundToolUseIds: new Set(['toolu_B']),
  notifiedToolUseIds: new Set<string>(),
  backgroundSpawnMs: new Map([['toolu_B', Date.now() - 60_000]]),
};
const bgAck = buildActivitySnapshot(sess, new Set(['toolu_B']), Date.now(), parentBackground);
check('W4: background subagent inside unresolved tool call stays RUNNING despite parent async-launch ack', bgAck.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status === 'running', bgAck.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status);
const bgNotified = buildActivitySnapshot(sess, new Set(['toolu_B']), Date.now(), { ...parentBackground, notifiedToolUseIds: new Set(['toolu_B']) });
check('W4: background subagent becomes DONE after parent task-notification', bgNotified.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status === 'done', bgNotified.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status);

// Round 4: a TaskStop'd agent is DONE immediately (its file just stops mid-flight — no final text,
// no task-notification), and a RUNNING card's elapsed ticks against wall-clock, not the frozen
// file span (the "stuck at 4s" bug).
const bgKilled = buildActivitySnapshot(sess, new Set(['toolu_B']), Date.now(), { ...parentBackground, killedAgentIds: new Set(['B']) });
check('R4: TaskStop kill flips the background subagent to DONE without waiting for staleness', bgKilled.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status === 'done', bgKilled.find((f) => f.msg.key === 'agent:toolu_B')?.msg.status);
const bgRunning = bgAck.find((f) => f.msg.key === 'agent:toolu_B')?.msg as any;
check('R4: running card exposes startedAtMs for client-side ticking', typeof bgRunning?.startedAtMs === 'number' && bgRunning.startedAtMs > 0, String(bgRunning?.startedAtMs));
check('R4: running card elapsed is wall-clock since start (not the frozen file span)', (bgRunning?.elapsedMs ?? 0) > 60_000, String(bgRunning?.elapsedMs));

// R4: collectParentActivity wires spawn-ack (agentId→tool_use_id) + TaskStop result → killed/notified.
{
  const resolvedIds = new Set<string>();
  const background = new Set<string>();
  const notified = new Set<string>();
  const spawnMs = new Map<string, number>();
  const extra = { killedAgentIds: new Set<string>(), agentIdToToolUseId: new Map<string, string>(), stopRequests: new Map<string, string>() };
  const feed = (ln: any) => collectParentActivity(ln, resolvedIds, background, notified, spawnMs, extra);
  feed({ type: 'assistant', timestamp: '2026-06-16T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { description: 'bg', run_in_background: true } }] } });
  feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: abc123def (internal ID)' }] }] } });
  feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: 'abc123def' } }] } });
  feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: 'Successfully killed' }] } });
  check('R4: spawn ack maps agentId → spawning tool_use_id', extra.agentIdToToolUseId.get('abc123def') === 'toolu_spawn');
  check('R4: TaskStop result marks the agent killed', extra.killedAgentIds.has('abc123def'));
  check('R4: the kill resolves the pending-background entry (notified via mapped tool_use_id)', notified.has('toolu_spawn'), JSON.stringify([...notified]));
}
const C = byKey.get('agent:toolu_C');
check('W4: foreground subagent ending with final assistant text is DONE immediately', C?.status === 'done', C?.status);
check('W4: subagent tokens use max output_tokens per message.id (287 + 86 = 373)', C?.tokens?.output === 373, String(C?.tokens?.output));

check('workflow-subagent meta is NOT a standalone card', !byKey.has('agent:undefined') && ![...byKey.values()].some((m) => m.subtitle === 'workflow-subagent'));

const D = byKey.get('wf:wf_done01');
check('completed workflow emitted (kind workflow)', !!D && D.kind === 'workflow');
check('completed workflow status done', D?.status === 'done', D?.status);
check('completed workflow name + lastPhase subtitle', D?.title === 'review-changes' && D?.subtitle === 'Verify');
check('completed workflow agentsTotal 2 / agentsDone 1', D?.agentsTotal === 2 && D?.agentsDone === 1, `${D?.agentsDone}/${D?.agentsTotal}`);
check('completed workflow tokens = totalTokens', D?.tokens?.output === 264463 && D?.toolCalls === 95);
check('completed workflow children mirror state', D?.children?.length === 2 && D?.children?.[0]?.status === 'done' && D?.children?.[1]?.status === 'error');

// (3b) summary-bearing workflow → title = summary (not the slug name); no-summary wf still falls back to name.
const D2 = byKey.get('wf:wf_done02');
check('completed workflow title PREFERS wf.summary (Dynamic-workflow render)', D2?.title === 'Confirm the Claude adapter emits everything the shipped renderer consumes', D2?.title);
check('completed workflow without summary FALLS BACK to workflowName', D?.title === 'review-changes', D?.title);
check('completed workflow elapsed from durationMs', D2?.elapsedMs === 247389, String(D2?.elapsedMs));

const L = byKey.get('wf:wf_live01');
check('live workflow emitted from journal (no top-level json)', !!L && L.kind === 'workflow' && L.status === 'running');
check('live workflow started 2 / done 1', L?.agentsTotal === 2 && L?.agentsDone === 1, `${L?.agentsDone}/${L?.agentsTotal}`);
check('live workflow child L1 done, L2 running', L?.children?.find((c) => c.key === 'wfagent:L1')?.status === 'done' && L?.children?.find((c) => c.key === 'wfagent:L2')?.status === 'running');

// (4b) live workflow with every agent resolved → derived 'done' even when fresh (no stuck-running bar)
const Lfull = byKey.get('wf:wf_full01');
check('live workflow with ALL agents resolved → status done (regression: stuck-running)', Lfull?.status === 'done' && Lfull?.agentsTotal === 2 && Lfull?.agentsDone === 2, Lfull?.status);

// done-detection branches
const resolved = buildActivitySnapshot(sess, new Set(['toolu_A']), NOW_FRESH);
check('subagent A is DONE when parent tool_result resolved it', resolved.find((f) => f.msg.key === 'agent:toolu_A')?.msg.status === 'done');
check('subagent A DONE elapsed = exact file span (120000ms)', (resolved.find((f) => f.msg.key === 'agent:toolu_A')?.msg as any)?.elapsedMs === 120_000, String((resolved.find((f) => f.msg.key === 'agent:toolu_A')?.msg as any)?.elapsedMs));
const stale = buildActivitySnapshot(sess, new Set(), NOW_STALE);
check('subagent A is DONE when its file is idle (stale mtime)', stale.find((f) => f.msg.key === 'agent:toolu_A')?.msg.status === 'done');
// ACT-1: an actively-running fan-out (stale journal BUT a fresh per-agent heartbeat) stays RUNNING — the
// journal mtime is not the heartbeat; the per-agent agent-*.jsonl is. This would FAIL under the buggy
// journal-mtime staleness gate (heartbeat=fresh agent file → not stale → running; not all resolved).
const activeNow = buildActivitySnapshot(sess, new Set(), Date.now()).find((f) => f.msg.key === 'wf:wf_active01');
check('ACT-1: active fan-out with fresh agent heartbeat stays RUNNING despite a stale journal', activeNow?.msg.status === 'running', activeNow?.msg.status);
// A workflow with no fresh heartbeat at all (journal-only, long quiet) settles to done so it never lingers
// as a stale running bar on history replay (doc §2.5a); all-resolved is done regardless of mtime.
check('live workflow with no recent heartbeat settles to DONE (no stale running bar on replay)', stale.find((f) => f.msg.key === 'wf:wf_live01')?.msg.status === 'done', stale.find((f) => f.msg.key === 'wf:wf_live01')?.msg.status);
check('live workflow that ALL-resolved is done regardless of mtime', stale.find((f) => f.msg.key === 'wf:wf_full01')?.msg.status === 'done');

// (#15) ClaudeActivityWatcher RE-EMITS a running→done transition across sweeps (and nothing when unchanged)
{
  const frames: AgentMessage[] = [];
  const w = new ClaudeActivityWatcher(sess, (m) => frames.push(m), () => true, new Set());
  (w as any).sweep();
  const firstLive = frames.filter((f: any) => f.key === 'wf:wf_live01');
  check('watcher first sweep emits wf_live01 running', firstLive.length >= 1 && (firstLive[firstLive.length - 1] as any).status === 'running');
  const n0 = frames.length;
  (w as any).sweep(); // unchanged → emits nothing new
  check('watcher steady-state sweep emits nothing new', frames.length === n0);
  // complete the run: resolve L2 → all agents done → status flips
  writeFileSync(join(liveWf, 'journal.jsonl'), [
    JSON.stringify({ agentId: 'L1', type: 'started' }),
    JSON.stringify({ agentId: 'L2', type: 'started' }),
    JSON.stringify({ agentId: 'L1', type: 'result', result: {} }),
    JSON.stringify({ agentId: 'L2', type: 'result', result: {} }),
  ].join('\n') + '\n');
  (w as any).sweep();
  const lastLive = frames.filter((f: any) => f.key === 'wf:wf_live01').pop() as any;
  check('watcher re-emits wf_live01 as DONE after the run completes', lastLive?.status === 'done', lastLive?.status);
  (w as any).close?.();
}

// src dedupe key changes only when the source file (size:mtime) or derived status changes
check('every frame carries a non-empty src dedupe key', fresh.every((f) => typeof f.src === 'string' && f.src.length > 0));

rmSync(ROOT, { recursive: true, force: true });

// ── smoke test against a REAL session dir if present (read-only, no cost) ──────────
const REAL = '/home/tester/.claude/projects/-home-tester-Projects-coding-agent-cosyncing/031081b6-0a70-4d71-952c-9d53fd608af0';
if (existsSync(REAL)) {
  let frames;
  try {
    frames = buildActivitySnapshot(REAL, new Set());
  } catch (e) {
    frames = null;
    check('real session dir: buildActivitySnapshot does not throw', false, String(e));
  }
  if (frames) {
    const wellFormed = frames.every(
      (f) =>
        f.msg.type === 'agent-activity' &&
        typeof f.msg.key === 'string' &&
        f.msg.key.length > 0 &&
        (f.msg.kind === 'subagent' || f.msg.kind === 'workflow') &&
        ['running', 'done', 'error'].includes(f.msg.status),
    );
    check('real session dir: parses without throwing', true, `${frames.length} activity frames`);
    check('real session dir: every frame is well-formed', wellFormed);
    check('real session dir: subagent frames have agentsTotal 1', frames.filter((f) => f.msg.kind === 'subagent').every((f) => f.msg.agentsTotal === 1));
    check('real session dir: workflow keys start wf:, subagent keys start agent:', frames.every((f) => f.msg.key.startsWith(f.msg.kind === 'workflow' ? 'wf:' : 'agent:')));
  }
} else {
  console.log('SKIP real-dir smoke (session dir absent on this machine)');
}

// ── Workflow tool noise suppression (the OTHER half of "the bar is the surface"): the Workflow tool_use
//    carries a multi-KB `script` arg + its result is the run's return value — both are the same noise the
//    agent-activity bar already represents, so neither should render as a generic tool-call / tool-result row
//    in the transcript (maintainer's "mostly noise" bug). A non-Workflow tool is unaffected. ──
{
  const wfCall = {
    type: 'assistant',
    uuid: 'wf-a1',
    message: { id: 'wfm1', role: 'assistant', content: [
      { type: 'text', text: 'Launching the audit.' },
      { type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { description: 'Audit adapter', script: 'export const meta = {…}\n'.repeat(300) } },
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } },
    ] },
  };
  const wfResult = {
    type: 'user',
    uuid: 'wf-u1',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_wf', content: '{"confirmedComplete":["…huge…"]}' },
      { type: 'tool_result', tool_use_id: 'toolu_bash', content: 'file.ts' },
    ] },
  };
  const msgs = mapTranscript([wfCall, wfResult]) as any[];
  check('Workflow tool_use does NOT render as a tool-call (script noise suppressed)', !msgs.some((m) => m.type === 'tool-call' && m.toolName === 'Workflow'));
  check('Workflow tool_result does NOT render as a tool-result row', !msgs.some((m) => m.type === 'tool-result' && m.toolName === 'Workflow'));
  check('the surrounding assistant text still renders', msgs.some((m) => m.type === 'model-output' && /Launching the audit/.test(m.text)));
  check('a NON-Workflow tool (Bash) still renders normally', msgs.some((m) => m.type === 'tool-call' && m.toolName === 'Bash') && msgs.some((m) => m.type === 'tool-result' && m.toolName === 'Bash'));
  check('the giant script arg never reaches the wire', !msgs.some((m) => JSON.stringify(m).includes('export const meta')));
}

// A FAILED-LAUNCH Workflow (is_error: bad params / "Script parse error") writes NO sibling wf tree, so the
// activity bar renders nothing — its error result MUST still surface (regression: F-A swallowing it → silence).
{
  const wfErrCall = {
    type: 'assistant',
    uuid: 'wfe-a1',
    message: { id: 'wfem1', role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_wferr', name: 'Workflow', input: { description: 'bad', script: 'oops', run_in_background: true } },
    ] },
  };
  const wfErrResult = {
    type: 'user',
    uuid: 'wfe-u1',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_wferr', is_error: true, content: '<tool_use_error>InputValidationError: unexpected parameter run_in_background</tool_use_error>' },
    ] },
  };
  const msgs = mapTranscript([wfErrCall, wfErrResult]) as any[];
  const err = msgs.find((m: any) => m.type === 'tool-result' && m.toolName === 'Workflow');
  check('FAILED Workflow launch surfaces as an error tool-result (not swallowed)', !!err && err.isError === true, JSON.stringify(err && { isError: err.isError, result: String(err.result).slice(0, 40) }));
  check('  the launch-failure reason reaches the wire', !!err && /unexpected parameter run_in_background/.test(String(err.result)));
  check('  the failed Workflow tool_use itself is still suppressed (no script noise)', !msgs.some((m: any) => m.type === 'tool-call' && m.toolName === 'Workflow'));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
