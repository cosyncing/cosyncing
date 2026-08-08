/**
 * Claude HOOKS-SYNCED full-surface scenario (NO claude, NO model cost) — the answer to "does the new sync
 * path solve ALL the Observe issues, not just permission/question?".
 *
 * A hooks-synced ClaudeHooksConnection = ClaudeObserveConnection (on-disk CONTENT) + the live hook control
 * channel. This test crafts a RICH real-shaped session (streamed text, tool call/result, a running SUBAGENT,
 * a running WORKFLOW, and a bridge-buffered tail whose pending question is held OFF-DISK) and drives a phone
 * (WebSocket) + a simulated in-session hook against the real broker, asserting the phone sees the WHOLE
 * surface — and that the two headline Observe gaps (off-disk live permission + question) are now actionable.
 *
 * Coverage map (the issues maintainer flagged):
 *   A. streamed assistant text / "answer display"   → inherited from Observe (block-level)            [works]
 *   B. tool call + result                            → inherited from Observe                          [works]
 *   C. SUBAGENT activity bar                         → inherited from composed Observe (on-disk tree)  [works]
 *   D. WORKFLOW activity bar                         → inherited from composed Observe (on-disk tree)  [works]
 *   E. live PERMISSION prompt (off-disk)             → CLOSED by the hook: actionable + answerable     [fixed]
 *   F. in-flight QUESTION (off-disk)                 → CLOSED by the hook: actionable + answerable     [fixed]
 *   G. before/after proof: pure Observe on the SAME transcript only yields the honest notice
 *
 *   bun run scripts/broker/tests/claude/test-claude-hooks-surface.ts   (exit 0 = all pass)
 */
export {};
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSessionId, claudeActivityDir, ClaudeObserveConnection } from '../../../../packages/typescript/adapters/claude/src/index.ts';
import type { SessionInfo } from '../../../../packages/typescript/adapter-api/src/index.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const portLease = await reserveLoopbackFixturePort();
const PORT = portLease.port;
const BASE = `http://127.0.0.1:${PORT}`;

// ── craft a rich, real-shaped session on disk (under a projects root — the broker validates the path) ──────
const work = mkdtempSync(join(tmpdir(), 'claude-hooks-surface-'));
const projDir = join(work, 'projects', 'test-proj');
mkdirSync(projDir, { recursive: true });
const transcriptPath = join(projDir, 'session.jsonl');
const id = claudeSessionId(transcriptPath);
const transcript = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'investigate the queue health and dispatch a reviewer' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Let me investigate the queue health.' }] } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'grep -rn queue src' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'src/queue.ts:42: enqueue(job)' }] } },
  { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: { description: 'Review the queue health guard', subagent_type: 'general-purpose' } }] } },
  { type: 'assistant', uuid: 'a4', message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'Reviewer dispatched; launching the audit workflow while it runs.' }] } },
  // bridge-buffered tail: the in-flight turn (a SendUserFile, then a streamed AskUserQuestion) is held
  // OFF-DISK while blocked — exactly the case where Observe can only show an honest notice.
  { type: 'bridge-session', bridgeSessionId: 'cse_surface', lastSequenceNum: 0 },
];
writeFileSync(transcriptPath, transcript.map((l) => JSON.stringify(l)).join('\n') + '\n');

// activity tree beside the transcript: a RUNNING subagent (toolu_A unresolved) + a RUNNING workflow
const sess = claudeActivityDir(transcriptPath);
mkdirSync(join(sess, 'subagents', 'workflows', 'wf_live01'), { recursive: true });
writeFileSync(join(sess, 'subagents', 'agent-A.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the queue health guard', toolUseId: 'toolu_A' }));
writeFileSync(join(sess, 'subagents', 'agent-A.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-06-22T10:00:00.000Z', message: { id: 'sm1', usage: { output_tokens: 120 } } }) + '\n');
writeFileSync(join(sess, 'subagents', 'workflows', 'wf_live01', 'journal.jsonl'), [JSON.stringify({ agentId: 'L1', type: 'started' }), JSON.stringify({ agentId: 'L2', type: 'started' }), JSON.stringify({ agentId: 'L1', type: 'result', result: {} })].join('\n') + '\n');

async function post(path: string, body: unknown): Promise<any> {
  return (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json().catch(() => ({}));
}
async function hookRequest(body: any, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) { const r = await post('/claude/hook/request', body); if (r.viewers === 0 || r.resolved || r.error) return r; await sleep(200); }
  return { resolved: false };
}

// ── G (before): a PURE Observe connection on the SAME transcript can only surface the honest notice ───────
{
  const info = { id, tool: 'claude', title: 't', cwd: work, status: 'needs-input', attachMode: 'observe' } as unknown as SessionInfo;
  const pendingObserve = new ClaudeObserveConnection(transcriptPath, info, 'permission prompt').getPending() as any[];
  check('G(before): pure Observe → ONLY the honest notice for the off-disk pending (the documented gap)',
    pendingObserve.length === 1 && pendingObserve[0].requestId === 'observe-block' && !pendingObserve.some((m) => m.type === 'question-request'),
    JSON.stringify(pendingObserve.map((m) => m.type + ':' + m.requestId)));
}

await portLease.release();
const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: REPO,
  env: isolatedBrokerFixtureEnvironment(work, {
    overrides: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      COSYNCING_MACHINE: 'surface-test',
      COSYNCING_DEV_MODE: '1',
      COSYNCING_BRIDGE_GRACE_MS: '300',
      CLAUDE_CONFIG_DIR: work,
    },
  }),
  stdout: 'pipe',
  stderr: 'pipe',
  stdin: 'ignore',
});
const brokerOutput = captureProcessOutput(broker);
let ws: WebSocket | undefined;
try {
  // Readiness is not one of this suite's assertions, so it gets no wall-clock
  // budget: a broker booting beside other suites is slow, not broken.
  try {
    await waitForBrokerHealth(broker, `${BASE}/api/health`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${brokerOutput.read().trim().slice(-2000)}`);
  }
  check('broker up', true, `:${PORT}`);

  await post('/claude/hook/hello', { transcriptPath, sessionUuid: 'sess-surface', cwd: work, title: 'queue health' });

  // attach the phone and collect ALL frames (history + derived overlays + live)
  const histMsgs: any[] = []; const liveMsgs: any[] = []; let sessionInfo: any;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/claude/${id}/stream`);
  await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 8000); });
  ws.onmessage = (ev) => { let f: any; try { f = JSON.parse(String(ev.data)); } catch { return; } if (f.kind === 'history') histMsgs.push(...(f.messages ?? [])); else if (f.kind === 'message') liveMsgs.push(f.message); else if (f.kind === 'session') sessionInfo = f.info; };
  await sleep(2500); // let history + the 1st activity-watcher sweep land
  const all = () => [...histMsgs, ...liveMsgs];
  const has = (pred: (m: any) => boolean) => all().find(pred);
  const waitFor = async (pred: (m: any) => boolean, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = liveMsgs.find(pred) ?? histMsgs.find(pred); if (m) return m; await sleep(150); } return undefined; };

  // ── A: streamed assistant text / "answer display" ──
  check('A: assistant text renders (answer display)', !!has((m) => m.type === 'model-output' && /investigate the queue health/.test(m.text || '')) && !!has((m) => m.type === 'model-output' && /Reviewer dispatched/.test(m.text || '')), 'both text blocks present');
  // ── B: tool call + result ──
  check('B: Bash tool-call + tool-result render', !!has((m) => m.type === 'tool-call' && m.toolName === 'Bash') && !!has((m) => m.type === 'tool-result' && m.toolName === 'Bash'), '');
  // ── C: subagent activity bar (from the on-disk tree, via composed Observe) ──
  const sub = (await waitFor((m) => m.type === 'agent-activity' && m.kind === 'subagent')) || has((m) => m.type === 'agent-activity' && m.kind === 'subagent');
  check('C: SUBAGENT activity bar flows through the synced connection', !!sub && sub.key === 'agent:toolu_A' && sub.status === 'running', sub ? `${sub.title} (${sub.status})` : 'missing');
  // ── D: workflow activity bar ──
  const wf = (await waitFor((m) => m.type === 'agent-activity' && m.kind === 'workflow')) || has((m) => m.type === 'agent-activity' && m.kind === 'workflow');
  check('D: WORKFLOW activity bar flows through the synced connection', !!wf && wf.status === 'running' && wf.agentsTotal === 2 && wf.agentsDone === 1, wf ? `${wf.key} ${wf.agentsDone}/${wf.agentsTotal}` : 'missing');
  // session shows synced
  check('session shows Synced (terminalSync active, attachMode live)', sessionInfo?.control?.terminalSync?.active === true && sessionInfo?.attachMode === 'live', JSON.stringify(sessionInfo?.control?.terminalSync ?? {}));

  // ── E: live PERMISSION prompt (off-disk) → actionable + answerable ──
  const permP = hookRequest({ id, requestId: 'live-perm', kind: 'permission', toolName: 'Bash', title: 'Run command', detail: 'sudo systemctl restart queue', transcriptPath });
  const permCard = await waitFor((m) => m.type === 'permission-request' && m.requestId === 'live-perm');
  check('E: live permission appears on the phone as an ACTIONABLE card (not the read-only notice)', !!permCard && permCard.readOnly !== true, permCard ? `"${permCard.detail}"` : 'missing');
  ws.send(JSON.stringify({ kind: 'approve', requestId: 'live-perm', decision: 'approve' }));
  check('E: phone approval reaches the (blocked) hook', (await permP).decision === 'approve', '');
  check('E: permission-resolved clears the card', !!(await waitFor((m) => m.type === 'permission-resolved' && m.requestId === 'live-perm')), '');

  // ── F: in-flight QUESTION (off-disk) → actionable, with the REAL options, answerable ──
  const qP = hookRequest({ id, requestId: 'live-q', kind: 'question', transcriptPath, questions: [{ question: 'Add the queue-health guard now?', header: 'Queue guard', options: [{ label: 'Yes, add it' }, { label: 'Not now' }], multiSelect: false }] });
  const qCard = await waitFor((m) => m.type === 'question-request' && m.requestId === 'live-q');
  check('F: the OFF-DISK question now renders the REAL question + options on the phone', !!qCard && qCard.readOnly !== true && qCard.questions?.[0]?.question === 'Add the queue-health guard now?' && qCard.questions?.[0]?.options?.length === 2, qCard ? JSON.stringify(qCard.questions[0].options) : 'missing');
  ws.send(JSON.stringify({ kind: 'answer', requestId: 'live-q', answers: [['Yes, add it']] }));
  const qRes = await qP;
  check('F: phone answer reaches the (blocked) hook', qRes.kind === 'answer' && JSON.stringify(qRes.answers) === JSON.stringify([['Yes, add it']]), JSON.stringify(qRes));
  check('F: question-resolved clears the card', !!(await waitFor((m) => m.type === 'question-resolved' && m.requestId === 'live-q')), '');

  // ── G(after): the synced connection's getPending now yields the ACTIONABLE frames, never the notice ──
  // (proven implicitly above: live-perm + live-q rendered actionable; the "observe-block" notice never appeared)
  check('G(after): synced session never shows the "Blocked in terminal" notice (off-disk gap closed)', !all().some((m) => m.requestId === 'observe-block'), '');
} catch (e) {
  check('no exception', false, String(e));
} finally {
  try { ws?.close(); } catch {}
  // Awaiting the exit is the point: signalling and returning left the broker
  // and its children alive past this process, for the lane to reap.
  try { broker.kill(); await broker.exited; } catch {}
  rmSync(work, { recursive: true, force: true });
}

console.log('\n--- honest remaining gaps (NOT closed by hooks; documented) ---');
console.log('  · streamed text is BLOCK-level (Observe), not token-by-token mid-turn → Tier-2 tmux or a stream-json launch');
console.log('  · sending a NEW prompt to a hooks-synced session is unsupported (use Drive/terminal)');
console.log('  · Claude todos (TodoWrite→task-list-state) are not mapped yet — an Observe gap, independent of sync');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
