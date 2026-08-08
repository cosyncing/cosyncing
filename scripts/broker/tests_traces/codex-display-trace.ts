/**
 * Codex DISPLAY + TODO + SUBAGENTS regression (deterministic, no `codex`, CI-safe) — the real-app (Playwright)
 * guard for the recurring Codex backlog complaints:
 *   - SUBAGENTS: Codex spawn_agent/wait_agent children must render as agent-activity bars (the headline gap —
 *     they were hidden entirely; docs/protocol/adapter-support.md said "not yet converted into agent-activity").
 *   - TODO: an update_plan must render as the .tasklist panel (done / in progress / open counts).
 *   - DISPLAY: model + effort + permission-mode (universal category from approval+sandbox) shown in the statusline.
 *
 * Seeds a Codex rollout on disk under the ISOLATED broker's HOME (~/.codex/sessions/...), so the broker's Observe
 * discovery finds it with NO daemon, NO model, NO codex binary. The session is left mid-turn: subagent "Turing"
 * completes (its bar settles) while "Carson" is still running (so a running agent-activity .livebar renders — the
 * app deletes finished bars by design, so a deterministic trace MUST keep one child in flight). Opens the real app
 * in Chromium and asserts the bar, the todo panel, and the statusline through the real broker — not a unit test.
 *
 *   bun run scripts/broker/tests_traces/codex-display-trace.ts
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, CHIP_READER, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

const b = await startIsolatedBroker();
try {
  // Codex SESSIONS_ROOT honours $CODEX_HOME → ~/.codex; HOME=b.home (set by the harness) makes that <home>/.codex.
  const work = join(b.home, 'work', 'geomind');
  mkdirSync(work, { recursive: true });
  const UUID = '019ed111-aaaa-7bbb-8ccc-d0e0f0a0b0c0';
  const sessionsDir = join(b.home, '.codex', 'sessions', '2026', '06', '22');
  mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, `rollout-2026-06-22T12-00-00-${UUID}.jsonl`);

  const T = (s: number) => `2026-06-22T12:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000Z`;
  const lines = [
    { type: 'session_meta', payload: { cwd: work, id: UUID, model_provider: 'openai' } },
    // turn_context feeds the statusline: model + effort + the universal permission category (on-request +
    // workspace-write → "ask-permission"). codexSessionSurface reads turn_context head/tail.
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.4-codex', model_provider: 'openai', reasoning_effort: 'high', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'research the SVG funding claims, then patch the parser', turn_id: 't1' }, timestamp: T(0) },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: T(0) }, // no task_complete → stays "working"
    // update_plan → the .tasklist panel (1 done, 1 in progress, 1 open).
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'plan1', arguments: JSON.stringify({ plan: [{ status: 'completed', step: 'Survey the SVG literature' }, { status: 'in_progress', step: 'Verify the funding claims' }, { status: 'pending', step: 'Patch the parser' }] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'plan1', output: 'ok' } },
    // spawn two subagents; resolve only Turing → Carson stays running so a live agent-activity bar renders.
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'cs1', arguments: JSON.stringify({ agent_type: 'explorer', model: 'gpt-5.4-mini', reasoning_effort: 'high', message: 'verify the QuiverAI funding claim against primary sources' }) }, timestamp: T(10) },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'cs2', arguments: JSON.stringify({ agent_type: 'coder', message: 'patch the SVG parser bug' }) }, timestamp: T(11) },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cs1', output: JSON.stringify({ agent_id: 'kid-A', nickname: 'Turing' }) }, timestamp: T(12) },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cs2', output: JSON.stringify({ agent_id: 'kid-B', nickname: 'Carson' }) }, timestamp: T(13) },
    { type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'cw1', arguments: JSON.stringify({ ids: ['kid-A'], timeout_ms: 120000 }) }, timestamp: T(40) },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'cw1', output: JSON.stringify({ status: { 'kid-A': { completed: 'Funding verified: $8.3M seed led by a16z.' } } }) }, timestamp: T(41) },
  ];
  writeFileSync(rolloutPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // Wait for Observe discovery to surface the seeded rollout (GET /api/sessions discovers live each call).
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    try {
      const data = (await (await fetch(`${b.base}/api/sessions`)).json()) as any;
      const ss: any[] = Array.isArray(data) ? data : (data?.sessions ?? []);
      found = ss.some((s) => s.tool === 'codex' && typeof s.cwd === 'string' && s.cwd.includes('geomind'));
    } catch {}
    if (!found) await sleep(200);
  }
  if (!found) fail('seeded Codex session never appeared in /api/sessions (discovery)');

  const shot = '/tmp/codex-display.png';
  const PY = pyOpenOnlySession(String.raw`
    pg.wait_for_selector("#statusline", state="visible", timeout=15000)
    pg.wait_for_timeout(1000)
    out["chips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    out["bars"] = pg.evaluate("""() => [...document.querySelectorAll('#sessionBars .livebar')].map(el => ({
        kind: [...el.classList].filter(c => c !== 'livebar').join(' '),
        label: (el.querySelector('.label')||{}).textContent || '',
        title: (el.querySelector('.title')||{}).textContent || '',
        detail: (el.querySelector('.detail')||{}).textContent || '',
        text: el.textContent || ''
    }))""")
    out["todo"] = pg.evaluate("""() => { const t=document.querySelector('.tasklist'); if(!t) return null;
        const s=t.querySelector('.tl-summary'); return { present:true, summary:(s?s.textContent:t.textContent).trim() }; }""")
    out["rawSpawnLeak"] = pg.evaluate("""() => {
        const thread = document.getElementById('messages') || document.body;
        const txt = thread.textContent || '';
        return /spawn_agent|wait_agent/.test(txt);
    }""")
`);
  const res = await runDriver(b.home, b.base, PY, [shot]);
  if (res.skip) { console.log(`SKIP codex display — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    const c = res.chips || {};
    const bars = (res.bars || []) as any[];
    const todo = res.todo;
    console.log(`statusline chips: ${JSON.stringify(c)}`);
    console.log(`livebars: ${JSON.stringify(bars)}`);
    console.log(`todo: ${JSON.stringify(todo)}  rawSpawnLeak=${res.rawSpawnLeak}  📸 ${shot}`);
    const model = (c.statusModel || '').toLowerCase();
    const carsonBar = bars.find((bar) => /Carson/.test(bar.text) || /Carson/.test(bar.title));
    const todoSummary = (todo && todo.summary) || '';
    const checks: [string, boolean, string][] = [
      ['model is SHOWN (not unknown)', !!c.statusModel && !/unknown/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['model reflects the Codex model (gpt/codex)', /codex|gpt/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['effort is SHOWN (high)', /high/i.test(c.statusEffort || ''), `statusEffort=${JSON.stringify(c.statusEffort)}`],
      ['permission mode is SHOWN (universal category, not default)', !!c.statusMode && !/mode\s+default\s*$/i.test(c.statusMode || ''), `statusMode=${JSON.stringify(c.statusMode)}`],
      ['a running subagent renders as an agent-activity .livebar', !!carsonBar, `bars=${JSON.stringify(bars)}`],
      ['the subagent bar is labelled a Background agent', !!carsonBar && /Background agent/i.test(carsonBar.label || carsonBar.text), `bar=${JSON.stringify(carsonBar)}`],
      ['the subagent bar carries the role subtitle (coder)', !!carsonBar && /coder/.test(carsonBar.detail || carsonBar.text), `bar=${JSON.stringify(carsonBar)}`],
      ['update_plan renders the .tasklist todo panel', !!todo && todo.present === true, `todo=${JSON.stringify(todo)}`],
      ['todo summary shows 3 tasks (1 done, 1 in progress, 1 open)', /3 tasks/.test(todoSummary) && /1 done/.test(todoSummary) && /1 in progress/.test(todoSummary) && /1 open/.test(todoSummary), `summary=${JSON.stringify(todoSummary)}`],
      ['raw spawn_agent/wait_agent control cards do NOT leak into the thread', res.rawSpawnLeak === false, `rawSpawnLeak=${res.rawSpawnLeak}`],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('codex display/todo/subagent regression FAILED (see ❌; screenshot saved)');
    console.log('PASS codex display — subagent bar + todo panel + model/effort/mode all render in the real app.');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  rmSync(b.home, { recursive: true, force: true });
}
