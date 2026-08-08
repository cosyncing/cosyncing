/**
 * Claude UltraCode/workflow + subagent DISPLAY product trace. Through the full stack (real broker → real
 * Claude adapter; fake `claude` only for the empty `agents --json` overlay — NO model cost): the sibling
 * subagent/workflow tree Claude writes next to a transcript surfaces over the broker WS as the canonical
 * `agent-activity` frames (kind 'workflow' / 'subagent') — a completed workflow as done with phase/agent
 * children, a live workflow (journal, no top-level json) as running. Guards the doc-12 universal-session
 * surface + doc adapters/02-claude-code: NO Claude-specific renderer, NO Claude tool name on the wire.
 *
 * Writes output/traces/<run-id>/claude/ST-CLAUDE-WORKFLOW-ACTIVITY/{trace.json,frames.ndjson}.
 *
 *   bun run scripts/broker/tests_traces/claude-workflow-activity-trace.ts
 */
export {};
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 25000 + Math.floor(Math.random() * 20000));
const BROKER = `http://127.0.0.1:${PORT}`;
const WSBASE = BROKER.replace(/^http/, 'ws');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'claude', 'ST-CLAUDE-WORKFLOW-ACTIVITY');
const framesPath = join(outDir, 'frames.ndjson');
const tracePath = join(outDir, 'trace.json');
const UUID = '0aaaaaaa-0000-4000-8000-wfactivity01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Assertion { name: string; ok: boolean; detail?: string }
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });
function record(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...(obj as Record<string, unknown>) }) + '\n');
}
function check(name: string, ok: boolean, detail = ''): void {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-claude-wf-'));
const configDir = join(tempRoot, 'claude-config');
const workDir = join(tempRoot, 'workspace');
const binDir = join(tempRoot, 'bin');
const fakeClaude = join(binDir, 'claude');
const slugDir = join(configDir, 'projects', 'proj-slug');
const activityDir = join(slugDir, UUID); // = transcript path minus .jsonl
mkdirSync(workDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(join(activityDir, 'workflows'), { recursive: true });
mkdirSync(join(activityDir, 'subagents', 'workflows', 'wf_live01'), { recursive: true });
writeFixture();
writeFakeClaude();

let broker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
try {
  broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HOME: tempRoot, CLAUDE_CONFIG_DIR: configDir, COSYNCING_CLAUDE_BIN: fakeClaude },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  drainBrokerOutput(broker);
  if (!(await waitHealth())) throw new Error(`broker did not start at ${BROKER}`);

  const sessionsBody = await (await fetch(`${BROKER}/api/sessions`)).json();
  const sessions = Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions ?? [];
  const row = sessions.find((s: any) => s.tool === 'claude' && s.cwd === workDir);
  check('session with a workflow tree discovered', !!row, JSON.stringify(row?.id));

  const obs = await attach(row.id);
  const history = await obs.waitFrame((f) => f.kind === 'history', 5000);
  // agent-activity frames may arrive in the history frame and/or as live activity messages — collect both.
  await sleep(400);
  const all = [...(history?.messages ?? []), ...obs.frames.filter((f) => f.kind === 'message').map((f) => f.message)];
  const acts = all.filter((m: any) => m?.type === 'agent-activity');
  check('agent-activity frames surface over the broker WS', acts.length > 0, `count=${acts.length}`);

  const wfDone = acts.find((a: any) => a.kind === 'workflow' && a.status === 'done');
  check('completed workflow → canonical agent-activity kind=workflow, status done', !!wfDone, JSON.stringify({ kind: wfDone?.kind, status: wfDone?.status, title: wfDone?.title }));
  check('  completed workflow title PREFERS wf.summary (Claude-native "Dynamic workflow «…»" render)', wfDone?.title === 'Review changed files across dimensions', JSON.stringify(wfDone?.title));
  check('  workflow carries phase/agent rollup (done/total or children)', !!wfDone && ((wfDone.agentsTotal ?? 0) >= 2 || (Array.isArray(wfDone.children) && wfDone.children.length >= 2)), JSON.stringify({ total: wfDone?.agentsTotal, children: wfDone?.children?.length }));

  // The Workflow tool-call (with its multi-KB script) must be SUPPRESSED on the wire — the bar is the surface.
  const wfToolCall = all.find((m: any) => m?.type === 'tool-call' && m?.toolName === 'Workflow');
  check('Workflow tool-call does NOT leak to the wire (only the activity bar)', !wfToolCall, JSON.stringify(wfToolCall));
  check('  surrounding assistant text still renders (suppression is surgical)', all.some((m: any) => m?.type === 'model-output' && /Launching the workflow/.test(String(m.text ?? ''))));
  check('  the workflow script source never reaches the client', !all.some((m: any) => JSON.stringify(m).includes('export const meta')));

  const wfLive = acts.find((a: any) => a.kind === 'workflow' && a.status === 'running');
  check('live workflow (journal, no top-level json) → kind=workflow, status running ("Background workflow")', !!wfLive, JSON.stringify({ kind: wfLive?.kind, status: wfLive?.status }));

  const sub = acts.find((a: any) => a.kind === 'subagent');
  check('parent-spawned subagent → kind=subagent', !!sub, JSON.stringify({ kind: sub?.kind, title: sub?.title }));

  // No Claude-specific renderer / no native tool name on the wire: every message is a canonical type.
  const CANON = new Set(['agent-activity', 'user-message', 'model-output', 'thinking', 'tool-call', 'tool-result', 'token-count', 'run-summary', 'metadata-update', 'status', 'event', 'permission-request', 'question-request', 'question-resolved', 'permission-resolved', 'file-artifact', 'error', 'goal-update', 'history-reset']);
  const nonCanon = all.filter((m: any) => m && m.type && !CANON.has(m.type)).map((m: any) => m.type);
  check('no non-canonical (Claude-specific) message type leaks to the client', nonCanon.length === 0, nonCanon.join(','));
  obs.close();
} catch (err) {
  check('trace driver completed without exception', false, String(err));
} finally {
  broker?.kill();
  const failed = assertions.filter((a) => !a.ok).length;
  writeFileSync(tracePath, JSON.stringify({
    scenarioIds: ['ST-CLAUDE-WORKFLOW-ACTIVITY'],
    agent: 'claude',
    version: { cosyncing: 'local-source', claude: 'fake-agents-overlay' },
    broker: BROKER,
    configDir,
    steps: [
      'seed a transcript + sibling subagent/workflow tree (completed wf_*.json + live journal + subagent meta)',
      'start broker with a fake claude (empty agents --json overlay)',
      'Observe attach → assert canonical agent-activity frames (kind workflow/subagent) with NO Claude-specific type',
    ],
    output: { frames: framesPath },
    assertions,
    status: failed ? 'fail' : 'pass',
    skipReason: null,
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`\ntrace: ${tracePath}`);
  console.log(`${assertions.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function writeFixture(): void {
  writeFileSync(join(slugDir, `${UUID}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', cwd: workDir, sessionId: UUID, timestamp: '2026-06-18T10:00:00.000Z', message: { role: 'user', content: 'run a workflow' } }),
    // the Workflow tool_use carries its full multi-KB script — it must NOT leak to the wire (the canonical
    // agent-activity bar from the wf_*.json tree is the surface); only the surrounding text should render.
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-18T10:00:01.000Z', message: { id: 'm1', role: 'assistant', content: [
      { type: 'text', text: 'Launching the workflow.' },
      { type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { description: 'review changes', script: 'export const meta = { name: "review-changes" }\n'.repeat(50) } },
    ] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-06-18T10:04:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: '{"confirmed":[]}' }] } }),
  ].join('\n') + '\n');
  // a parent-spawned subagent (meta has toolUseId) + a 2-turn transcript
  const sub = join(activityDir, 'subagents');
  writeFileSync(join(sub, 'agent-A.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the adapter', toolUseId: 'toolu_A' }));
  writeFileSync(join(sub, 'agent-A.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-18T10:00:00.000Z', message: { id: 'm1', usage: { output_tokens: 100 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-18T10:02:00.000Z', message: { id: 'm2', usage: { output_tokens: 200 } } }),
  ].join('\n') + '\n');
  // a completed workflow (top-level wf_*.json)
  writeFileSync(join(activityDir, 'workflows', 'wf_done01.json'), JSON.stringify({
    runId: 'wf_done01', workflowName: 'review-changes', summary: 'Review changed files across dimensions', status: 'completed', durationMs: 377253, totalTokens: 264463, agentCount: 2,
    phases: [{ title: 'Review', detail: 'x' }, { title: 'Verify', detail: 'y' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Review' },
      { type: 'workflow_agent', index: 1, label: 'review:bugs', phaseTitle: 'Review', agentId: 'g1', state: 'done', durationMs: 5000, tokens: 1000 },
      { type: 'workflow_agent', index: 2, label: 'review:perf', phaseTitle: 'Review', agentId: 'g2', state: 'done', durationMs: 2000, tokens: 500 },
    ],
  }));
  // a live workflow: journal with an unresolved agent + NO top-level json → status running
  writeFileSync(join(activityDir, 'subagents', 'workflows', 'wf_live01', 'journal.jsonl'), [
    JSON.stringify({ agentId: 'L1', key: 'a', type: 'started' }),
    JSON.stringify({ agentId: 'L2', key: 'b', type: 'started' }),
    JSON.stringify({ agentId: 'L1', key: 'a', type: 'result', result: {} }),
  ].join('\n') + '\n');
}

function writeFakeClaude(): void {
  writeFileSync(fakeClaude, `#!/usr/bin/env bun
if (process.argv.slice(2).includes('agents')) { console.log('[]'); process.exit(0); }
process.exit(0);
`);
  chmodSync(fakeClaude, 0o755);
}

function drainBrokerOutput(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): void {
  void (async () => {
    for (const stream of [proc.stdout, proc.stderr]) {
      const reader = stream.getReader();
      try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* ended */ }
    }
  })();
}
async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BROKER}/api/health`)).ok) return true; } catch { /* not ready */ }
    await sleep(100);
  }
  return false;
}
type Attach = { frames: any[]; waitFrame: (pred: (f: any) => boolean, ms: number) => Promise<any>; close: () => void };
function attach(sessionId: string, mode?: string): Promise<Attach> {
  return new Promise((resolve, reject) => {
    const query = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const ws = new WebSocket(`${WSBASE}/api/sessions/claude/${encodeURIComponent(sessionId)}/stream${query}`);
    const frames: any[] = [];
    const out: Attach = { frames, waitFrame: (pred, ms) => waitFrame(frames, pred, ms), close: () => { try { ws.close(); } catch {} } };
    ws.onmessage = (e) => { try { const f = JSON.parse(String(e.data)); frames.push(f); record(framesPath, { mode: mode ?? 'observe', frame: f }); } catch {} };
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onopen = () => resolve(out);
  });
}
async function waitFrame(frames: any[], pred: (f: any) => boolean, ms: number): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const f = frames.find(pred);
    if (f) return f;
    if (Date.now() > end) return undefined;
    await sleep(60);
  }
}
