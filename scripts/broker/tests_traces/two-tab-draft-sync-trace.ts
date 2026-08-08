/**
 * Multi-client draft sync — REAL two-tab trace (issues-part2 item 14, reproduced 2026-07-12).
 *
 * maintainer's report: two PoC tabs on one opencode session did not mirror the composer draft. The wire
 * layer was fine — the split was IDENTITY: tab 1 attached bare while tab 2 carried a sticky
 * `?mode=resume` (recorded because a drive-by-default serve session frame says drive:'driving'), so
 * the tabs held two different Hub owners (`opencode:<id>` vs `opencode:<id>#resume`) and shared no
 * frames. A wire-level draft test can NEVER catch that — both sockets in such a test are attached the
 * same way. This trace therefore drives TWO REAL APP TABS (playwright) through the roster like a user:
 *
 *   D1 both tabs attach the SAME Hub identity (neither WS URL carries mode=resume)
 *   D2 typing in tab 1's composer appears in tab 2's composer (the actual item-14 miss)
 *   D3 a third late-joining tab inherits the draft (replay)
 *
 * Zero model cost: only a draft is typed, nothing is sent. Requirements: `opencode` on PATH +
 * python3-playwright + chromium (else SKIP). Isolated broker + isolated managed serve.
 *
 *   bun run scripts/broker/tests_traces/two-tab-draft-sync-trace.ts
 */
export {};
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { refuseRetiredPocUiTrace } from './_app-trace-helpers.ts';

refuseRetiredPocUiTrace('scripts/broker/tests_traces/two-tab-draft-sync-trace.ts');

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 26000 + Math.floor(Math.random() * 20000));
const OCPORT = PORT + 1;
const BROKER = `http://127.0.0.1:${PORT}`;
const DIR = `/tmp/cosyncing-two-tab-draft-${PORT}`;
mkdirSync(DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
function have(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
if (!have('opencode') || !have('python3')) {
  console.log('SKIP: real `opencode` and python3 are required for this trace.');
  process.exit(0);
}
try { execSync(`python3 -c 'import playwright'`, { stdio: 'ignore' }); } catch {
  console.log('SKIP: python3-playwright is required for this trace.');
  process.exit(0);
}

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPENCODE_URL: `http://127.0.0.1:${OCPORT}`, COSYNCING_CODEX_SYNC_SERVER: '0' },
  stdout: 'pipe',
  stderr: 'pipe',
});
try {
  const healthy = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const r = await fetch(`${BROKER}/api/broker/health`); if (r.ok) return true; } catch {}
      await sleep(500);
    }
    return false;
  })();
  if (!healthy) throw new Error('isolated broker did not start');

  // managed serve boots async — retry create
  let sid = '';
  {
    const end = Date.now() + 45000;
    while (!sid) {
      const r = await fetch(`${BROKER}/api/sessions/opencode`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: DIR, title: 'TWO-TAB-DRAFT-TRACE (safe to delete)' }),
      }).catch(() => undefined);
      if (r?.ok) sid = ((await r.json()) as any)?.session?.id ?? '';
      if (!sid) {
        if (Date.now() > end) throw new Error('create failed (serve never came up)');
        await sleep(1500);
      }
    }
  }

  const py = `
import json
from playwright.sync_api import sync_playwright

HOOK = "(() => { window.__urls=[]; const OW=window.WebSocket; window.WebSocket=new Proxy(OW,{construct(t,a){window.__urls.push(String(a[0])); return new t(...a);}}); })()"
def open_session(pg):
    pg.add_init_script(HOOK)
    pg.goto('${BROKER}/poc-ui/', wait_until='domcontentloaded')
    pg.wait_for_selector('.projectName', timeout=30000)
    pg.wait_for_timeout(800)
    pg.evaluate("()=>{const h=[...document.querySelectorAll('.projectHead')].find(e=>e.textContent.includes('cosyncing-two-tab-draft')); h&&h.click()}")
    pg.wait_for_function("()=>[...document.querySelectorAll('.srow')].some(e=>e.textContent.includes('TWO-TAB-DRAFT-TRACE'))", timeout=15000)
    pg.evaluate("()=>{[...document.querySelectorAll('.srow')].find(e=>e.textContent.includes('TWO-TAB-DRAFT-TRACE')).click()}")
    pg.wait_for_function("()=>{const i=document.querySelector('#input'); return i && !i.disabled}", timeout=20000)

out = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width':1400,'height':900})
    p1 = ctx.new_page(); p2 = ctx.new_page()
    open_session(p1); open_session(p2)
    out['urls1'] = p1.evaluate('()=>window.__urls')
    out['urls2'] = p2.evaluate('()=>window.__urls')
    p1.bring_to_front(); p1.focus('#input')
    p1.type('#input', 'TWO-TAB-DRAFT probe', delay=20)
    p1.wait_for_timeout(2500)
    out['v1'] = p1.evaluate("()=>document.querySelector('#input').value")
    out['v2'] = p2.evaluate("()=>document.querySelector('#input').value")
    p3 = ctx.new_page(); open_session(p3)
    p3.wait_for_timeout(1500)
    out['v3'] = p3.evaluate("()=>document.querySelector('#input').value")
    b.close()
print('RESULT=' + json.dumps(out))
`;
  writeFileSync(`${DIR}/two-tab.py`, py);
  const raw = execSync(`python3 '${DIR}/two-tab.py'`, { timeout: 180000 }).toString();
  const out = JSON.parse((raw.match(/RESULT=(\{.*\})/) ?? [])[1] ?? '{}');
  const sessionUrl = (u: string) => u.includes(`/api/sessions/opencode/`);
  const resumeUrls = [...(out.urls1 ?? []), ...(out.urls2 ?? [])].filter((u: string) => sessionUrl(u) && u.includes('mode=resume'));
  check('D1 both tabs attach the SAME Hub identity (no sticky mode=resume split)', resumeUrls.length === 0, resumeUrls.join(' | ') || 'both bare');
  check('D2 tab-1 draft mirrors into tab-2 composer', !!out.v1 && out.v2 === out.v1, `v1=${JSON.stringify(out.v1)} v2=${JSON.stringify(out.v2)}`);
  check('D3 a late third tab inherits the shared draft (replay)', out.v3 === out.v1, `v3=${JSON.stringify(out.v3)}`);
} catch (error) {
  check('trace ran to completion', false, String(error).slice(0, 300));
} finally {
  broker.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length}/${results.length}` : `\n${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
