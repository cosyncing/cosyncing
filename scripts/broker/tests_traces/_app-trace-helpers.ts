/**
 * Shared harness for REAL-APP (Playwright) trace tests. Boots an ISOLATED broker (its own temp HOME so
 * Claude/OpenCode/Codex/Pi discovery never sees the real ~/.claude etc.) and runs a Python-Playwright driver
 * against the served web app, returning the driver's JSON. CI-safe: a {skip} is returned (never a failure)
 * when Python/Playwright/Chromium is unavailable. Used by the per-agent app-answer / display traces.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const ROOT = join(import.meta.dir, '../../..');
export const sleep = (ms: number) => delay(ms);

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('could not allocate a free TCP port');
  const port = addr.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

export interface IsolatedBroker { broker: ReturnType<typeof Bun.spawn>; base: string; port: number; home: string; claudeConfig: string; }

/** Boot an isolated broker. HOME=home is the key isolation: claudeStores()/wrapper discovery use the OS HOME,
 *  so without it the real ~/.claude + ~/bin wrappers leak into the roster. Returns once /api/health is ok. */
export async function startIsolatedBroker(extraEnv: Record<string, string> = {}): Promise<IsolatedBroker> {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-apptrace-'));
  const claudeConfig = join(home, 'claude-config');
  mkdirSync(claudeConfig, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const broker = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(port), COSYNCING_HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, COSYNCING_RESTART_DRY_RUN: '1', COSYNCING_OPENCODE_NO_AUTOSERVE: '1', COSYNCING_CLAUDE_HOOKS: '0', ...extraEnv },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { try { if ((await fetch(`${base}/api/health`)).ok) return { broker, base, port, home, claudeConfig }; } catch {} await delay(150); }
  broker.kill();
  throw new Error(`broker did not become healthy on ${base}`);
}

export async function post(base: string, path: string, body: unknown): Promise<any> {
  try { return await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch { return null; }
}

/** Run a Python-Playwright driver `py` with args; returns its last-line JSON ({skip}/{error}/result).
 *  Dumps raw stdout/stderr to <home>/driver.out for debugging. */
export async function runDriver(home: string, base: string, py: string, args: string[]): Promise<any> {
  const scriptPath = join(home, 'driver.py');
  writeFileSync(scriptPath, py);
  const proc = Bun.spawn(['python3', scriptPath, base, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const raw = (await new Response(proc.stdout).text()).trim();
  const errOut = (await new Response(proc.stderr).text()).trim();
  const exitCode = await proc.exited;
  try { writeFileSync(join(home, 'driver.out'), `STDOUT:\n${raw}\n\nSTDERR:\n${errOut}\n`); } catch {}
  if (exitCode !== 0 && !raw) return { error: `driver exited ${exitCode}: ${errOut.slice(0, 1200)}` };
  const line = raw.split('\n').filter(Boolean).pop() || '{}';
  try {
    const parsed = JSON.parse(line);
    if (exitCode !== 0 && parsed && !parsed.error && !parsed.skip) parsed.error = `driver exited ${exitCode}: ${errOut.slice(0, 1200)}`;
    return parsed;
  } catch {
    return { error: `driver produced no JSON (exit ${exitCode}; see ${join(home, 'driver.out')}). last-line=${line.slice(0, 200)} stderr=${errOut.slice(0, 800)}` };
  }
}

/** Standard Python preamble: import playwright (skip if missing), launch chromium (skip if missing), open
 *  the served app, expand the (isolated) roster's project group and open the only/first session. The driver
 *  body that follows can assume `pg` is on the open session. `EXTRA` lines run after the session opens. */
export function pyOpenOnlySession(bodyAfterOpen: string): string {
  refuseRetiredPocUiTrace();
  return String.raw`
import json, sys
try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print(json.dumps({"skip": "playwright import: " + str(e)})); sys.exit(0)
url = sys.argv[1]
shot = sys.argv[2] if len(sys.argv) > 2 else "/tmp/app-trace.png"
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
        sess = pg.locator("#rosterList .srow").first
        if sess.count() == 0 or not sess.is_visible():
            pg.locator("#rosterList .projectHead").first.click(timeout=10000)
            pg.wait_for_timeout(600)
        sess.click(timeout=15000)
    except Exception as e:
        try: pg.screenshot(path=shot)
        except Exception: pass
        print(json.dumps({"error": "open session: " + str(e)})); b.close(); sys.exit(0)
    pg.wait_for_timeout(900)
` + bodyAfterOpen + String.raw`
    try: pg.screenshot(path=shot)
    except Exception: pass
    b.close()
    print(json.dumps(out))
`;
}

/** A JS-side reusable JS snippet (string) for pg.evaluate that reads the statusline chips. */
export const CHIP_READER = `() => {
  const chip = id => { const e=document.getElementById(id); return (e && e.style.display!=='none') ? e.textContent.trim() : null; };
  return { statusModel: chip('statusModel'), statusEffort: chip('statusEffort'), statusMode: chip('statusMode'), statusActivity: chip('statusActivity'), statusAgent: chip('statusAgent') };
}`;

/**
 * Refuse to run a trace whose browser leg drove the removed `/poc-ui/` mount.
 *
 * The broker answers that path with a plain 404 now, so the navigation succeeds and every selector after it
 * fails against an error page — minutes of broker boot and Playwright timeouts before an assertion failure
 * that says nothing about the cause. Stopping at the door names the cause instead. See RETIRED_POC_UI_TRACES
 * in ./trace-manifest.ts for the full list and the migration these are waiting on.
 *
 * Returns `void`, not `never`, though it never returns: these calls sit at module top level, and a `never`
 * return narrows every statement after them to unreachable, which collapses the rest of each trace to `never`
 * and fails the typecheck.
 */
export function refuseRetiredPocUiTrace(trace: string = process.argv[1] ?? 'this trace'): void {
  console.error(
    `RETIRED: ${trace} drove the PoC UI at /poc-ui/, which the broker no longer serves.\n`
      + 'Retired from the trace manifest rather than migrated: the replacement mount is /cosy/, the Flutter\n'
      + 'client, whose canvas rendering shares none of these DOM selectors and needs a web build\n'
      + '(bun run client:build:web) to drive. Re-author against /cosy/ before restoring this trace.',
  );
  process.exit(2);
}
