/**
 * D29 — Real-DOM Playwright probe for the Sync Refactor one-button surface.
 *
 * Boots a throwaway broker (dry-run restart, temp home, no managed opencode serve), loads the served web
 * app in a real Chromium via Python Playwright, and asserts the REAL DOM truth the static + component
 * tests assert at the source/shim level:
 *   - NO `#controlMode` (the global control-mode <select> is deleted — D17),
 *   - NO `#drive` and NO `#sync` (collapsed into one button — D1/FU-1),
 *   - EXACTLY ONE `#control` button (the auto-routed control affordance),
 *   - the per-agent `#codexSyncToggle` exists (D23),
 *   - NO v1 `#claudeHooksToggle`, and
 *   - BPC2's embedded shell resolves the locked `cosyncing` product copy without browser errors.
 *
 * Skips cleanly (exit 0) when Python/Playwright/Chromium is unavailable — mirrors conformance.ts so the
 * suite stays CI-safe on machines without a browser. Run: `bun run scripts/broker/tests_traces/sync-refactor-dom-probe.ts`
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { refuseRetiredPocUiTrace } from './_app-trace-helpers.ts';

refuseRetiredPocUiTrace('scripts/broker/tests_traces/sync-refactor-dom-probe.ts');

const ROOT = join(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate a free TCP port');
  const port = addr.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

const home = mkdtempSync(join(tmpdir(), 'cosyncing-dom-probe-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    COSYNCING_HOME: home,
    COSYNCING_RESTART_DRY_RUN: '1',
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_CLAUDE_HOOKS: '0',
  },
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});

function fail(msg: string): never {
  throw new Error(msg);
}

const PY = String.raw`
import json, sys
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print(json.dumps({"skip": "playwright import: " + str(e)})); sys.exit(0)
url = sys.argv[1]
with sync_playwright() as p:
    try:
        b = p.chromium.launch()
    except Exception as e:
        print(json.dumps({"skip": "chromium launch: " + str(e)})); sys.exit(0)
    pg = b.new_page()
    browser_errors = []
    pg.on("console", lambda msg: browser_errors.append("console: " + msg.text) if msg.type == "error" else None)
    pg.on("pageerror", lambda error: browser_errors.append("page: " + str(error)))
    pg.goto(url.rstrip('/') + '/poc-ui/', wait_until="domcontentloaded")  # PoC moved off root → /poc-ui/ (D6)
    try:
        pg.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        pass  # expected: the app keeps a WebSocket and roster polling alive
    pg.wait_for_selector('#control', state='attached', timeout=10000)
    pg.wait_for_timeout(600)
    res = pg.evaluate("""() => ({
        controlMode: document.querySelectorAll('#controlMode').length,
        drive: document.querySelectorAll('#drive').length,
        sync: document.querySelectorAll('#sync').length,
        control: document.querySelectorAll('#control').length,
        codexToggle: document.querySelectorAll('#codexSyncToggle').length,
        claudeToggle: document.querySelectorAll('#claudeHooksToggle').length,
        title: document.title,
        heading: document.querySelector('h1')?.textContent?.trim() || '',
    })""")
    res["browserErrors"] = browser_errors
    try:
        pg.screenshot(path="/tmp/cosyncing-bpc2-poc-review.png", full_page=False, animations="disabled", timeout=5000)
        res["screenshot"] = "/tmp/cosyncing-bpc2-poc-review.png"
    except Exception as error:
        res["screenshot"] = "best-effort failed: " + str(error).splitlines()[0]
    b.close()
    print(json.dumps(res))
`;

try {
  // wait for health
  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; }
    } catch {}
    await delay(150);
  }
  if (!healthy) fail(`broker did not become healthy on ${base}`);

  const scriptPath = join(home, 'probe.py');
  writeFileSync(scriptPath, PY);
  const proc = Bun.spawn(['python3', scriptPath, base], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) fail(`probe driver exited ${exitCode}: ${err.trim().slice(0, 1200)}`);
  const trimmed = out.trim();
  const line = trimmed.split('\n').filter(Boolean).pop() || '{}';
  let res: any;
  try { res = JSON.parse(line); } catch { fail(`probe produced no JSON: ${trimmed}`); }

  if (res.skip) {
    console.log(`SKIP sync-refactor DOM probe — ${res.skip} (DOM truth still covered by test-web-ui-static + test-web-ui-components)`);
  } else {
    const ok = res.controlMode === 0 && res.drive === 0 && res.sync === 0 && res.control === 1 &&
      res.codexToggle === 1 && res.claudeToggle === 0 && res.title === 'cosyncing' &&
      res.heading === 'cosyncing' && Array.isArray(res.browserErrors) && res.browserErrors.length === 0;
    console.log(`real DOM: ${JSON.stringify(res)}`);
    if (!ok) fail(`D29/BPC2 DOM probe mismatch: ${JSON.stringify(res)}`);
    console.log('PASS D29/BPC2 — embedded cosyncing shell, one control button, no Claude v1 hook toggle, no browser errors');
  }
} finally {
  broker.kill();
  await broker.exited.catch(() => null);
  rmSync(home, { recursive: true, force: true });
}
