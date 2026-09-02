/**
 * Real-browser trace for the file viewer's rendered HTML pane.
 *
 * The pane's badge says "passive preview". The sandbox attribute and
 * `JavaScriptMode.disabled` deliver half of that — no scripts, no forms, no
 * navigation, no popups — and none of the other half. Neither stops SUBRESOURCE
 * loads: `<img>`, `<link rel=stylesheet>`, `@font-face`, `<video>` and
 * `<audio>` all still fetch. Rendering a workspace `.html` an agent wrote, in a
 * repo the reader may not control, would otherwise make their device request
 * attacker-chosen URLs carrying their IP the moment they tap Rendered. What
 * stops it is the Content-Security-Policy `hardenHtmlForPassiveFrame` injects,
 * and only a browser can prove a policy is honoured.
 *
 * A widget test cannot stand in: `canRenderHtmlInPane` is false on Linux, where
 * the Flutter suite runs, so the rendered branch never executes there. This
 * trace runs on web, where it is true.
 *
 * It stands a beacon server beside the fixture broker and opens a workspace
 * page that asks it for a stylesheet, a font and an image, then asserts:
 * - the rendered face requests none of the three;
 * - the same bytes in the same page in an identically sandboxed frame with no
 *   policy request all three — without that control, a frame that simply never
 *   rendered would look like a pass;
 * - the frame grants nothing (`sandbox=""`) and sends no referrer;
 * - the bytes reaching the frame carry the policy.
 *
 * Hits are counted at the beacon server, not from `page.on('request')`:
 * Chromium reports CSP-blocked loads as requests too, so a request event is not
 * evidence a byte left the machine.
 *
 *   bun run client:build:web
 *   bun run scripts/broker/tests_traces/file-viewer-csp-browser-trace.ts
 *
 * The web build must be built with `--base-href /cosy/`, which
 * `client:build:web` does and a bare `flutter build web` does not — without it
 * the bootstrap 404s under `/cosy/` and the app never boots.
 */
export {};
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const REPO = resolve(import.meta.dir, '../../..');
const WEB_BUILD = join(REPO, 'apps/client/build/web');
// 17734, never 7734: 7734 is the packaged production broker a real install uses.
const PORT = 17734;
const BEACON_PORT = 17735;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BEACON = `http://127.0.0.1:${BEACON_PORT}`;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'file-viewer-csp-browser');
const tracePath = join(outDir, 'trace.json');
const assertions: Assertion[] = [];
const findings: Record<string, unknown> = {};
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(WEB_BUILD, 'main.dart.js'))) {
  writeFileSync(
    tracePath,
    JSON.stringify({ runId, skip: 'no web build: run `bun run client:build:web` first' }, null, 2),
  );
  console.log('SKIP no web build at apps/client/build/web — run `bun run client:build:web`');
  process.exit(0);
}

function chromiumExecutable(): string | null {
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  if (!existsSync(cache)) return null;
  const shells = readdirSync(cache)
    .filter((e) => e.startsWith('chromium_headless_shell-'))
    .sort((l, r) => Number(r.split('-')[1]) - Number(l.split('-')[1]));
  if (!shells.length) return null;
  return join(cache, shells[0]!, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

const executablePath = chromiumExecutable();
if (!executablePath || !existsSync(executablePath)) {
  writeFileSync(tracePath, JSON.stringify({ runId, skip: 'no Playwright Chromium installed' }, null, 2));
  console.log('SKIP no Playwright Chromium headless shell installed');
  process.exit(0);
}

// Four subresource kinds, because the policy has to cover all of them and one
// `<img>` would only prove `img-src`. The inline script is the sandbox's job,
// not the policy's, and is here so the two guarantees stay distinguishable.
const BEACON_PAGE = `<html>
<head>
  <title>Coverage</title>
  <link rel="stylesheet" href="${BEACON}/beacon.css">
  <style>@font-face{font-family:B;src:url("${BEACON}/beacon.woff2")}</style>
</head>
<body style="font-family:B,system-ui">
  <h1>Coverage report</h1>
  <img id="i" src="${BEACON}/beacon.png" width="8" height="8">
  <script>fetch("${BEACON}/beacon.json");</script>
</body>
</html>
`;

const hits: string[] = [];

function serveBeacon() {
  return Bun.serve({
    port: BEACON_PORT,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      hits.push(path);
      if (path === '/beacon.css') {
        return new Response('body{outline:1px solid red}', {
          headers: { 'content-type': 'text/css', 'access-control-allow-origin': '*' },
        });
      }
      return new Response('beacon', { headers: { 'access-control-allow-origin': '*' } });
    },
  });
}

function spawnBroker(root: string) {
  return Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: REPO,
    env: isolatedBrokerFixtureEnvironment(root, {
      overrides: {
        PORT: String(PORT),
        HOST: '127.0.0.1',
        COSYNCING_CACHE_DIR: join(root, 'cache'),
        COSYNCING_WEB_DIR: WEB_BUILD,
        COSYNCING_FS_REMOTE_ENABLED: '1',
        COSYNCING_PI_SESSIONS_ROOT: '',
        PI_CODING_AGENT_SESSION_DIR: '',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

// Everything that holds a resource is allocated inside the `try`, so a throw
// anywhere reaches the `finally`. A listening server started at module scope
// keeps the event loop alive: the script would hang on the way out instead of
// exiting non-zero, which is the worst way for a security trace to fail.
let beacon: ReturnType<typeof serveBeacon> | undefined;
let child: ReturnType<typeof spawnBroker> | undefined;
let output: ReturnType<typeof captureProcessOutput> | undefined;
let root: string | undefined;

function check(name: string, ok: boolean, detail?: unknown): void {
  assertions.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
}

/// The centre of the semantics node labelled [label], in page coordinates.
async function semanticCentre(page: Page, label: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((wanted) => {
    for (const node of Array.from(document.querySelectorAll('flt-semantics'))) {
      const element = node as HTMLElement;
      const text = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
      if (text !== wanted) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    return null;
  }, label);
}

/// True once the pane holds a frame.
function framed(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('iframe')));
}

try {
  beacon = serveBeacon();
  root = mkdtempSync(join(tmpdir(), 'file-viewer-csp-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'docs'), { recursive: true });
  writeFileSync(join(workspace, 'docs/coverage.html'), BEACON_PAGE);
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'csp', cwd: workspace })}\n`);
  child = spawnBroker(root);
  output = captureProcessOutput(child);

  await waitForBrokerHealth(child, `${ORIGIN}/api/health`);
  const hello = await fetch(`${ORIGIN}/pi/bridge/hello`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionFile, cwd: workspace, title: 'Coverage' }),
  });
  const sessionId = String(((await hello.json()) as { id: unknown }).id);
  findings.sessionId = sessionId;

  const browser = await chromium.launch({
    executablePath,
    args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-features=Vulkan,VizDisplayCompositor'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requested: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(BEACON)) requested.push(r.url());
  });
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

  // Boot on the roster, then route into the file. A cold deep link lands
  // before the roster resolves, which is a different behaviour than this one.
  await page.goto(`${ORIGIN}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: join(outDir, '01-roster.png') });
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `/sessions/pi/${sessionId}/file?path=docs%2Fcoverage.html`);
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: join(outDir, '02-source.png') });

  // Semantics on, so the Rendered segment can be found by its label. It goes on
  // last: the overlay it installs sits over the canvas and forwards a tap
  // without a raw pointer event, which is enough for this toggle and not for a
  // click anywhere else.
  const placeholder = page.locator('flt-semantics-placeholder');
  if (await placeholder.count()) await placeholder.dispatchEvent('click');
  await page.waitForTimeout(2_500);

  const centre = await semanticCentre(page, 'Rendered');
  findings.renderedCentre = centre;
  if (centre) {
    await page.mouse.click(centre.x, centre.y);
    for (let attempt = 0; attempt < 4 && !(await framed(page)); attempt++) {
      await page.waitForTimeout(2_500);
    }
  }
  check('the Rendered segment is reachable', await framed(page));
  await page.screenshot({ path: join(outDir, '03-rendered.png') });

  const frame = await page.evaluate(() => {
    const element = document.querySelector('iframe');
    if (!element) return null;
    return {
      sandbox: element.getAttribute('sandbox'),
      referrerpolicy: element.getAttribute('referrerpolicy'),
      srcdoc: element.getAttribute('srcdoc') ?? '',
    };
  });
  check('the pane holds a passive frame', frame !== null);
  check('the frame grants nothing', frame?.sandbox === '', frame?.sandbox);
  check('the frame sends no referrer', frame?.referrerpolicy === 'no-referrer');
  check(
    'the bytes reaching the frame carry the policy',
    Boolean(frame?.srcdoc.includes('Content-Security-Policy')) &&
      Boolean(frame?.srcdoc.includes("script-src 'none'")),
    frame?.srcdoc.slice(0, 200),
  );

  // The whole point. Four subresources asked for, none fetched.
  //
  // The wait is the assertion, not politeness: `framed()` returning true says
  // the frame exists, not that it has finished asking for things. Snapshotting
  // straight after it would let three in-flight requests land after the check
  // and pass it for the wrong reason — a false green on exactly the failure
  // this trace exists to catch. Same 4s the control below gets, so the two are
  // measured over comparable windows.
  await page.waitForTimeout(4_000);
  const afterRendered = [...hits];
  check('the rendered face requests nothing', afterRendered.length === 0, afterRendered);

  // The control: same bytes, same page, same sandbox, no policy.
  await page.evaluate((html) => {
    const control = document.createElement('iframe');
    control.setAttribute('sandbox', '');
    control.setAttribute('referrerpolicy', 'no-referrer');
    control.setAttribute('srcdoc', html);
    control.style.cssText = 'position:fixed;left:-9999px;width:200px;height:200px';
    document.body.appendChild(control);
  }, BEACON_PAGE);
  await page.waitForTimeout(4_000);
  const control = hits.filter((h) => !afterRendered.includes(h));
  check('the same bytes without the policy do request', control.length > 0, control);

  findings.beaconHits = hits;
  // Six URLs here against three server hits is the expected shape: Chromium
  // reports the blocked loads as requests. Recorded so the difference stays
  // visible rather than looking like a discrepancy.
  findings.beaconRequestEventsSeenByBrowser = requested;
  findings.console = consoleLines.slice(-20);

  await context.close();
  await browser.close();
} finally {
  beacon?.stop(true);
  if (child && child.exitCode == null) child.kill();
  if (child) await child.exited;
  if (output) writeFileSync(join(outDir, 'broker.log'), await settledProcessOutput(output));
  if (root) rmSync(root, { recursive: true, force: true });
}

const failed = assertions.filter((a) => !a.ok);
writeFileSync(
  tracePath,
  JSON.stringify({ runId, scenario: 'file-viewer-csp-browser', origin: ORIGIN, beacon: BEACON, findings, assertions }, null, 2),
);
for (const a of assertions) console.log(`${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.detail ? ` - ${a.detail}` : ''}`);
console.log(`\ntrace: ${tracePath}`);
if (failed.length) process.exit(1);
