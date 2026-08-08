/**
 * Pi DISPLAY regression (deterministic, CI-safe — NO real `pi`, NO model).
 *
 * Seeds a live Pi bridge session through the real broker bridge wire, opens the real cosyncing
 * app in Chromium, and asserts the statusline model/effort/activity plus relayed model picker rows.
 * It then posts a second native bridge model event and asserts the statusline moves to the latest
 * native model/effort instead of staying pinned to the attach-time values.
 *
 *   bun run scripts/broker/tests_traces/pi-display-trace.ts
 */
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startIsolatedBroker, runDriver, pyOpenOnlySession, CHIP_READER, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pi-display-'));
const WORK = join(root, 'work');
const emptyAgentDir = join(root, 'agent-empty');
mkdirSync(WORK, { recursive: true });
mkdirSync(join(emptyAgentDir, 'sessions'), { recursive: true });
const sessionFile = join(root, 'session_pi-display.jsonl');
writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-display', timestamp: '2026-06-24T00:00:00.000Z', cwd: WORK }) + '\n');

const CURRENT = {
  providerID: 'vllm-hpc',
  modelID: 'qwen3.6-27B-FP8',
  label: 'qwen3.6-27B-FP8',
  reasoning: true,
  reasoningEffort: 'high',
  thinkingLevelMap: { low: true, medium: true, high: true },
};
const ALT = {
  providerID: 'openai',
  modelID: 'gpt-5.3-codex-spark',
  label: 'gpt-5.3-codex-spark',
  reasoning: true,
  thinkingLevelMap: { low: true, high: true },
};

const b = await startIsolatedBroker({ PI_CODING_AGENT_DIR: emptyAgentDir, COSYNCING_PI_SESSIONS_ROOT: '', PI_CODING_AGENT_SESSION_DIR: '' });
const post = (path: string, body: unknown) => fetch(`${b.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  const hello = await (await post('/pi/bridge/hello', {
    sessionFile,
    cwd: WORK,
    title: 'pi display session',
    model: CURRENT,
    thinkingLevel: 'high',
    models: [CURRENT, ALT],
  })).json();
  const id = String(hello?.id ?? '');
  if (!id) fail(`bridge hello returned no id: ${JSON.stringify(hello)}`);

  await post('/pi/bridge/events', { id, events: [
    { t: 'status', running: true },
    { t: 'token', input: 123, output: 45, cost: 0.006 },
    { t: 'model', model: CURRENT, thinkingLevel: 'high', models: [CURRENT, ALT] },
  ] });

  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    try {
      const data = (await (await fetch(`${b.base}/api/sessions`)).json()) as any;
      const ss: any[] = Array.isArray(data) ? data : (data?.sessions ?? []);
      found = ss.some((s) => s.tool === 'pi' && s.id === id);
    } catch {}
    if (!found) await sleep(200);
  }
  if (!found) fail('Pi bridge display session never appeared in /api/sessions');

  const shot = '/tmp/pi-display.png';
  const PY = pyOpenOnlySession(String.raw`
    pg.wait_for_selector("#statusline", state="visible", timeout=15000)
    pg.wait_for_timeout(800)
    out["chips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    pg.click("#modelPick", timeout=10000)
    pg.wait_for_selector("#optmenu .oitem", state="visible", timeout=10000)
    out["modelOptions"] = pg.evaluate("""() => [...document.querySelectorAll('#optmenu .oitem')].map(x => x.textContent.trim())""")
    import urllib.request
    bridge_id = sys.argv[3] if len(sys.argv) > 3 else ""
    req = urllib.request.Request(url + "/pi/bridge/events",
        data=json.dumps({"id": bridge_id, "events": [{"t": "model", "model": {"providerID": "openai", "modelID": "gpt-5.3-codex-spark", "label": "gpt-5.3-codex-spark", "reasoning": True, "thinkingLevelMap": {"low": True, "high": True}}, "thinkingLevel": "low"}]}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST")
    urllib.request.urlopen(req, timeout=5).read()
    pg.wait_for_function("""() => /spark|gpt-5\.3/i.test(document.getElementById('statusModel')?.textContent || '')""", timeout=10000)
    pg.wait_for_function("""() => /low/i.test(document.getElementById('statusEffort')?.textContent || '')""", timeout=10000)
    out["nativeChips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
`);
  const res = await runDriver(b.home, b.base, PY, [shot, id]);
  if (res.skip) { console.log(`SKIP pi display — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    const c = res.chips || {};
    const options = (res.modelOptions || []) as string[];
    const nativeChips = res.nativeChips || {};
    console.log(`statusline chips: ${JSON.stringify(c)}`);
    console.log(`native update chips: ${JSON.stringify(nativeChips)}`);
    console.log(`model options: ${JSON.stringify(options)}  📸 ${shot}`);
    const model = String(c.statusModel || '').toLowerCase();
    const effort = String(c.statusEffort || '').toLowerCase();
    const activity = String(c.statusActivity || '').toLowerCase();
    const nativeModel = String(nativeChips.statusModel || '').toLowerCase();
    const nativeEffort = String(nativeChips.statusEffort || '').toLowerCase();
    const checks: [string, boolean, string][] = [
      ['Pi model is SHOWN in the statusline', /qwen3\.6|qwen/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['Pi effort is SHOWN in the statusline', /high/.test(effort), `statusEffort=${JSON.stringify(c.statusEffort)}`],
      ['Pi activity is SHOWN as active/running', /working|running|active|needs input|idle/.test(activity), `statusActivity=${JSON.stringify(c.statusActivity)}`],
      ['Pi model picker includes the current bridge model', options.some((x) => /qwen3\.6|qwen/i.test(x)), `options=${JSON.stringify(options)}`],
      ['Pi model picker includes another relayed model option', options.some((x) => /spark|gpt-5\.3/i.test(x)), `options=${JSON.stringify(options)}`],
      ['Pi native model update changes the statusline model', /spark|gpt-5\.3/.test(nativeModel), `nativeStatusModel=${JSON.stringify(nativeChips.statusModel)}`],
      ['Pi native thinking-level update changes the statusline effort', /low/.test(nativeEffort), `nativeStatusEffort=${JSON.stringify(nativeChips.statusEffort)}`],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('pi display regression FAILED (see ❌; screenshot saved)');
    console.log('PASS pi display — bridge model/effort/activity/options and latest native model update render in the real app.');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  rmSync(b.home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
