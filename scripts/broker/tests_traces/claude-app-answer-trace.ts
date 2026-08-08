/**
 * Claude hooks — REAL-APP answerability regression (deterministic, no claude, CI-safe).
 *
 * The persistent complaint (legacy issue record §"Claude code still not render question/permission"):
 * a question/permission raised in a terminal-owned session could not be answered from the app. Every existing
 * trace proves the BROKER protocol via a WebSocket stub — none drives the REAL app.js DOM. This closes that gap.
 *
 * Boots a throwaway broker, seeds a hooks-SYNCED claude session (rich transcript + subagent + workflow activity
 * + a TodoWrite ledger) and keeps a PERMISSION and a QUESTION pending (re-posting like the real hook). Then loads
 * the REAL web app in Chromium via Playwright, opens the session, and asserts the DOM truth behind the backlog:
 *   - the permission card AND the question card render and are ACTIONABLE (data-pending-input="actionable"),
 *   - the subagent/workflow activity bar (.livebar) + the TodoWrite task-list (.tasklist, ongoing/complete/todo)
 *     render,
 *   - in answer-only sync the composer is READ-ONLY (#composer.readonly), prompt path blocked,
 * then CLICKS "Allow once" on the permission and selects an option + "Submit" on the question, and proves the
 * BROKER RESOLVED BOTH (each hook long-poll returns {resolved:true}) — i.e. q/permission ARE answerable from the
 * app, end to end. A screenshot is saved for the "viewer" aspect.
 *
 * Skips cleanly (exit 0) when Python/Playwright/Chromium is unavailable — mirrors conformance.ts / the D29 probe.
 * The real-claude-TUI + Playwright variant (opt-in, real model) is `claude-app-answer-real-tui-trace.ts`.
 *
 *   bun run scripts/broker/tests_traces/claude-app-answer-trace.ts
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { claudeSessionId, claudeActivityDir } from '../../../packages/typescript/adapters/claude/src/index.ts';
import { refuseRetiredPocUiTrace } from './_app-trace-helpers.ts';

refuseRetiredPocUiTrace('scripts/broker/tests_traces/claude-app-answer-trace.ts');

const ROOT = join(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate a free TCP port');
  const port = addr.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

const home = mkdtempSync(join(tmpdir(), 'cosyncing-app-answer-'));
const cfg = join(home, 'claude-config');                 // CLAUDE_CONFIG_DIR for the broker's transcript validation
const work = join(cfg, 'projects', 'app-answer-fixture'); // transcript MUST live under <CLAUDE_CONFIG_DIR>/projects
const transcriptPath = join(work, 'session.jsonl');
const id = claudeSessionId(transcriptPath);
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const TITLE = 'queue health (synced)';
const denyProof = join(home, 'claude-deny-proof.txt');
const sleep = (ms: number) => delay(ms);
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
async function post(path: string, body: unknown): Promise<any> {
  try { return await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; }
}

// ---- seed the synced session: transcript + activity tree -------------------------------------------
mkdirSync(work, { recursive: true });
writeFileSync(transcriptPath, [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'investigate the queue health and dispatch a reviewer' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Let me investigate the queue health, then run a quick audit.' }] } },
  { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'grep -rn enqueue src' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'src/queue.ts:42: enqueue(job)' }] } },
  { type: 'assistant', uuid: 'a3', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite', input: { todos: [
    { content: 'Investigate queue health', status: 'completed', activeForm: 'Investigating queue health' },
    { content: 'Add the queue-health guard', status: 'in_progress', activeForm: 'Adding the guard' },
    { content: 'Write a regression test', status: 'pending', activeForm: 'Writing the test' },
  ] } }] } },
  { type: 'assistant', uuid: 'a4', message: { id: 'm4', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: { description: 'Review the queue health guard', subagent_type: 'general-purpose' } }] } },
  { type: 'assistant', uuid: 'a5', message: { id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'Reviewer dispatched; launching the audit workflow while it runs.' }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n');

const sess = claudeActivityDir(transcriptPath);
mkdirSync(join(sess, 'subagents', 'workflows', 'wf_live01'), { recursive: true });
writeFileSync(join(sess, 'subagents', 'agent-A.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Review the queue health guard', toolUseId: 'toolu_A' }));
writeFileSync(join(sess, 'subagents', 'agent-A.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-06-22T10:00:00.000Z', message: { id: 'sm1', usage: { output_tokens: 120 } } }) + '\n');
writeFileSync(join(sess, 'subagents', 'workflows', 'wf_live01', 'journal.jsonl'), [
  JSON.stringify({ agentId: 'L1', type: 'started' }), JSON.stringify({ agentId: 'L2', type: 'started' }), JSON.stringify({ agentId: 'L1', type: 'result', result: {} }),
].join('\n') + '\n');

// ---- broker --------------------------------------------------------------------------------------
const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  cwd: ROOT,
  // HOME=home isolates Claude discovery: without it the broker scans the real ~/.claude + ~/bin wrappers
  // (claudeStores uses the OS HOME), leaking maintainer's real sessions into the roster and hiding the fixture.
  env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(port), COSYNCING_HOME: home, CLAUDE_CONFIG_DIR: cfg, COSYNCING_DEV_MODE: '1', COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_CLAUDE_HOOKS: '0' },
  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
});

// keep a permission AND a question pending until the app answers them (re-post like the real hook)
const resolution: Record<string, any> = {};
async function keepPending(requestId: string, body: any, until: number): Promise<void> {
  while (Date.now() < until) {
    const r = await post('/claude/hook/request', { id, requestId, transcriptPath, ...body });
    if (r?.resolved) { resolution[requestId] = r; log(`✓ ${requestId} resolved from the app: ${JSON.stringify(r).slice(0, 160)}`); return; }
    await sleep(r?.viewers === 0 ? 1200 : 300);
  }
  resolution[requestId] = { timeout: true };
}

const PY = String.raw`
import json, sys
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print(json.dumps({"skip": "playwright import: " + str(e)})); sys.exit(0)
url, title, shot = sys.argv[1], sys.argv[2], sys.argv[3]
out = {}
with sync_playwright() as p:
    try:
        b = p.chromium.launch()
    except Exception as e:
        print(json.dumps({"skip": "chromium launch: " + str(e)})); sys.exit(0)
    pg = b.new_page()
    pg.goto(url.rstrip('/') + '/poc-ui/', wait_until="domcontentloaded")  # PoC moved off root → /poc-ui/ (D6)
    pg.wait_for_timeout(1800)
    try:
        # the session lives inside a COLLAPSED .project group, expand it, then open the (only) session.
        # The roster row is .srow (onclick=attach); the title is truncated so match by class, not text.
        sess = pg.locator("#rosterList .srow").first
        if sess.count() == 0 or not sess.is_visible():
            pg.locator("#rosterList .projectHead").first.click(timeout=10000)
            pg.wait_for_timeout(600)
        sess.click(timeout=15000)
    except Exception as e:
        try: pg.screenshot(path=shot)
        except Exception: pass
        print(json.dumps({"error": "open session: " + str(e)})); b.close(); sys.exit(0)
    # wait for the pending cards to replay onto the thread
    try:
        pg.wait_for_selector("[id^='perm-']", timeout=20000)
        pg.wait_for_selector("[id^='q-']", timeout=20000)
        pg.wait_for_function("() => document.querySelectorAll('[id^=perm-]').length >= 2", timeout=20000)
    except Exception as e:
        try: pg.screenshot(path=shot)
        except Exception: pass
        print(json.dumps({"error": "cards never rendered: " + str(e)})); b.close(); sys.exit(0)
    pg.wait_for_timeout(700)
    def facts():
        return pg.evaluate("""() => {
            const perm = [...document.querySelectorAll("[id^='perm-']")].find(x => /queue-worker/.test(x.textContent || ''));
            const deny = [...document.querySelectorAll("[id^='perm-']")].find(x => /deny-proof/.test(x.textContent || ''));
            const q = document.querySelector("[id^='q-']");
            const chip = id => { const e=document.getElementById(id); return (e && e.style.display!=='none') ? e.textContent.trim() : null; };
            const comp = document.querySelector('#composer');
            const tl = document.querySelector('.tasklist .tl-summary');
            return {
              permPresent: !!perm, permState: perm ? perm.dataset.pendingInput : null, permHasAllow: !!(perm && perm.querySelector('.ok')),
              denyPresent: !!deny, denyState: deny ? deny.dataset.pendingInput : null, denyHasDeny: !!(deny && deny.querySelector('.no')),
              qPresent: !!q, qState: q ? q.dataset.pendingInput : null, qOptions: q ? q.querySelectorAll('.qopt').length : 0,
              tasklists: document.querySelectorAll('.tasklist').length, tasklistSummary: tl ? tl.textContent.trim() : null,
              liveBars: document.querySelectorAll('.livebar').length,
              statusModel: chip('statusModel'), statusEffort: chip('statusEffort'), statusMode: chip('statusMode'), statusActivity: chip('statusActivity'),
              composerReadonly: comp ? comp.classList.contains('readonly') : null, composerExists: !!document.querySelector('#composer textarea'),
            };
        }""")
    out["before"] = facts()
    answered = {}
    try:
        pg.locator("[id^='perm-']", has_text="queue-worker").locator(".ok").first.click(timeout=8000); answered["permClicked"] = True
    except Exception as e: answered["permClicked"] = str(e)
    try:
        pg.locator("[id^='q-'] .qopt").first.click(timeout=8000)
        pg.locator("[id^='q-'] .ok").first.click(timeout=8000); answered["qClicked"] = True
    except Exception as e: answered["qClicked"] = str(e)
    try:
        pg.locator("[id^='perm-']", has_text="deny-proof").locator(".no").first.click(timeout=8000); answered["denyClicked"] = True
    except Exception as e: answered["denyClicked"] = str(e)
    out["answered"] = answered
    pg.wait_for_timeout(1500)
    try: pg.screenshot(path=shot)
    except Exception: pass
    b.close()
    print(json.dumps(out))
`;

function fail(msg: string): never { throw new Error(msg); }

try {
  const deadline = Date.now() + 12_000;
  let healthy = false;
  while (Date.now() < deadline) { try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch {} await delay(150); }
  if (!healthy) fail(`broker did not become healthy on ${base}`);

  log(`fixture id=${id}`);
  log(`hello: ${JSON.stringify(await post('/claude/hook/hello', { transcriptPath, sessionUuid: 'app-answer', cwd: work, title: TITLE }))}`);
  const until = Date.now() + 60_000;
  void keepPending('aa-perm', { kind: 'permission', toolName: 'Bash', title: 'Run command', detail: 'sudo systemctl restart queue-worker' }, until);
  void keepPending('aa-deny', { kind: 'permission', toolName: 'Bash', title: 'Run command', detail: `touch ${denyProof}` }, until);
  void keepPending('aa-q', { kind: 'question', questions: [{ question: 'Add the queue-health guard now?', header: 'Queue guard', options: [{ label: 'Yes, add it', description: 'apply the guard this turn' }, { label: 'Not now', description: 'defer to a follow-up' }], multiSelect: false }] }, until);

  const shot = '/tmp/claude-app-answer.png'; // persisted outside `home` so the viewer artifact survives cleanup
  const scriptPath = join(home, 'driver.py');
  writeFileSync(scriptPath, PY);
  const proc = Bun.spawn(['python3', scriptPath, base, TITLE, shot], { stdout: 'pipe', stderr: 'pipe' });
  const raw = (await new Response(proc.stdout).text()).trim();
  const errOut = (await new Response(proc.stderr).text()).trim();
  await proc.exited;
  try { writeFileSync('/tmp/aa-driver.out', `STDOUT:\n${raw}\n\nSTDERR:\n${errOut}\n`); } catch {}
  const line = raw.split('\n').filter(Boolean).pop() || '{}';
  let res: any; try { res = JSON.parse(line); } catch { fail(`driver produced no JSON (see /tmp/aa-driver.out). last-line=${JSON.stringify(line).slice(0, 200)}`); }

  if (res.skip) {
    console.log(`SKIP claude app-answer — ${res.skip} (broker↔app answer path still covered by hooks-e2e WS stub)`);
  } else if (res.error) {
    fail(`driver error: ${res.error} (screenshot: ${shot})`);
  } else {
    const b = res.before || {};
    log(`DOM before answering: ${JSON.stringify(b)}`);
    log(`clicks: ${JSON.stringify(res.answered)}`);
    // give the keepPending loops a moment to observe resolution
    const rd = Date.now() + 6000;
    while (Date.now() < rd && !(resolution['aa-perm']?.resolved && resolution['aa-q']?.resolved && resolution['aa-deny']?.resolved)) await delay(200);
    if (resolution['aa-deny']?.decision && resolution['aa-deny'].decision !== 'reject') writeFileSync(denyProof, 'DENY_WAS_APPROVED');

    const checks: [string, boolean, string][] = [
      ['permission card ACTIONABLE', b.permState === 'actionable' && b.permHasAllow === true, `permState=${b.permState} hasAllow=${b.permHasAllow}`],
      ['deny permission card ACTIONABLE', b.denyState === 'actionable' && b.denyHasDeny === true, `denyState=${b.denyState} denyHasDeny=${b.denyHasDeny}`],
      ['question card ACTIONABLE', b.qState === 'actionable' && b.qOptions >= 2, `qState=${b.qState} options=${b.qOptions}`],
      ['todo task-list renders (ongoing/complete/todo)', b.tasklists >= 1 && /done|progress|open/.test(b.tasklistSummary || ''), `tasklists=${b.tasklists} summary=${JSON.stringify(b.tasklistSummary)}`],
      ['subagent/workflow activity bar renders', b.liveBars >= 1, `liveBars=${b.liveBars}`],
      ['composer is READ-ONLY (answer-only sync)', b.composerReadonly === true, `composerReadonly=${b.composerReadonly}`],
      ['permission ANSWERED from app → broker resolved', resolution['aa-perm']?.resolved === true, JSON.stringify(resolution['aa-perm'])],
      ['deny permission ANSWERED from app → broker resolved as reject', resolution['aa-deny']?.resolved === true && resolution['aa-deny']?.decision === 'reject', JSON.stringify(resolution['aa-deny'])],
      ['denied Claude command did NOT create the proof file', !existsSync(denyProof), denyProof],
      ['question ANSWERED from app → broker resolved', resolution['aa-q']?.resolved === true, JSON.stringify(resolution['aa-q'])],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    console.log(`  ℹ statusline display (hard-checked in claude-display-trace): model=${JSON.stringify(b.statusModel)} effort=${JSON.stringify(b.statusEffort)} mode=${JSON.stringify(b.statusMode)}`);
    console.log(`  📸 viewer screenshot: ${shot}`);
    if (!allPass) fail('claude app-answer regression FAILED (see ❌ above; screenshot saved)');
    console.log('PASS claude app-answer — permission + question rendered ACTIONABLE in the real app DOM, answered with a click, broker resolved both; activity + todo render; composer read-only.');
  }
} finally {
  broker.kill();
  await broker.exited.catch(() => null);
  rmSync(home, { recursive: true, force: true });
}
