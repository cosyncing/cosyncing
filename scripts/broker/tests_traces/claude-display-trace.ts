/**
 * Claude DISPLAY regression (deterministic, no claude, CI-safe) — the hard requirement from
 * legacy issue record §"Model selector / effort / permission level" + §"outdated model selection":
 *   - model, effort, and permission mode must ALWAYS be shown for a synced session (locked, not hidden);
 *   - the app must show the LATEST model, not the initial one (the opus-4.6 → opus-4.8 complaint).
 *
 * Seeds a hooks-synced session whose transcript switches model mid-session (initial sonnet → latest opus) and
 * carries a permission-mode line, opens the real app in Chromium, and asserts the statusline shows the LATEST
 * model + an effort + the permission mode — through the real broker/options frame, not a mapper unit test.
 *
 *   bun run scripts/broker/tests_traces/claude-display-trace.ts
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { claudeSessionId } from '../../../packages/typescript/adapters/claude/src/index.ts';
import { startIsolatedBroker, post, runDriver, pyOpenOnlySession, CHIP_READER, sleep } from './_app-trace-helpers.ts';

function fail(msg: string): never { throw new Error(msg); }

const b = await startIsolatedBroker({ COSYNCING_DEV_MODE: '1' });
try {
  const work = join(b.claudeConfig, 'projects', 'display-fixture');
  const transcriptPath = join(work, 'session.jsonl');
  const id = claudeSessionId(transcriptPath);
  mkdirSync(work, { recursive: true });
  // INITIAL model = sonnet; LATEST model = opus; a permission-mode line. readLatestModel/readLatestPermissionMode
  // read the TAIL, so the display must reflect opus + plan, never the initial sonnet.
  writeFileSync(transcriptPath, [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'start on the thesis edits' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Working on it with Sonnet.' }] } },
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Switched to Opus for the harder reasoning.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  console.log(`hello: ${JSON.stringify(await post(b.base, '/claude/hook/hello', { transcriptPath, sessionUuid: 'display', cwd: work, title: 'thesis edits (synced)' }))}`);
  await sleep(800); // let discovery merge the observe SessionInfo (effort/options) into the adopted hooks row

  const shot = '/tmp/claude-display.png';
  const PY = pyOpenOnlySession(String.raw`
    pg.wait_for_selector("#statusline", state="visible", timeout=15000)
    pg.wait_for_timeout(800)
    out["chips"] = pg.evaluate("""` + CHIP_READER + String.raw`""")
    # picker actionability: the model/mode chips in the composer footer should be LOCKED for answer-only sync
    out["pickers"] = pg.evaluate("""() => {
        const find = (txt) => [...document.querySelectorAll('#composer .cmdchip, #composer button, .pickerchip')].find(e => (e.textContent||'').toLowerCase().includes(txt));
        const m = find('model'); const md = find('mode');
        return { modelPicker: !!m, modelDisabled: m ? (m.disabled === true || m.getAttribute('aria-disabled')==='true' || m.classList.contains('locked') || m.classList.contains('disabled')) : null,
                 modePicker: !!md, modeDisabled: md ? (md.disabled === true || md.getAttribute('aria-disabled')==='true' || md.classList.contains('locked') || md.classList.contains('disabled')) : null };
    }""")
`);
  const res = await runDriver(b.home, b.base, PY, [shot]);
  if (res.skip) { console.log(`SKIP claude display — ${res.skip}`); }
  else if (res.error) { fail(`driver error: ${res.error} (screenshot ${shot})`); }
  else {
    const c = res.chips || {};
    console.log(`statusline chips: ${JSON.stringify(c)}`);
    console.log(`pickers: ${JSON.stringify(res.pickers)}  📸 ${shot}`);
    const model = (c.statusModel || '').toLowerCase();
    const checks: [string, boolean, string][] = [
      ['model is SHOWN (not unknown)', !!c.statusModel && !/unknown/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['model is the LATEST (opus), not the initial (sonnet)', /opus/.test(model) && !/sonnet/.test(model), `statusModel=${JSON.stringify(c.statusModel)}`],
      ['effort is SHOWN', !!c.statusEffort && !/default\s*$/.test((c.statusEffort || '').toLowerCase().replace('effort ', '')), `statusEffort=${JSON.stringify(c.statusEffort)}`],
      ['permission mode is SHOWN (plan, from the transcript)', !!c.statusMode && /plan/i.test(c.statusMode || ''), `statusMode=${JSON.stringify(c.statusMode)}`],
    ];
    let allPass = true;
    for (const [name, ok, detail] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`); if (!ok) allPass = false; }
    if (!allPass) fail('claude display regression FAILED (see ❌; screenshot saved)');
    console.log('PASS claude display — model (LATEST) + effort + permission-mode all shown in the real app statusline.');
  }
} finally {
  b.broker.kill();
  await b.broker.exited.catch(() => null);
  rmSync(b.home, { recursive: true, force: true });
}
