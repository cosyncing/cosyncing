/**
 * Real-browser adversarial artifact sandbox trace.
 *
 * Starts a tiny test broker that serves the real app in test mode and real ArtifactStore HTML responses.
 * Chromium then loads a hostile HTML artifact and proves the browser engine, not just string tests, enforces:
 * - connect-src 'none' blocks fetch/sendBeacon exfiltration attempts;
 * - non-nonce artifact scripts do not execute;
 * - forged postMessage events from an unregistered nested frame are dropped by the real app listener;
 * - valid bridge form messages from the registered artifact iframe reach the authenticated session socket.
 *
 *   bun run scripts/broker/tests_traces/artifact-sandbox-browser-trace.ts
 *
 * Runs headless by default. On hosts where headless Chromium can't paint the sandboxed artifact iframe
 * (e.g. WSL2, where the artifact-iframe click times out), run headful under a virtual display:
 *   ARTIFACT_TRACE_HEADFUL=1 xvfb-run -a bun run scripts/broker/tests_traces/artifact-sandbox-browser-trace.ts
 */
export {};
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { ArtifactStore } from '../../../packages/typescript/broker/src/artifact-store.ts';

interface Assertion {
  name: string;
  ok: boolean;
  detail?: string;
}

const short = randomBytes(3).toString('hex');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'output', 'traces', runId, 'artifact-sandbox-browser');
const resultPath = join(outDir, 'browser-result.json');
const driverPath = join(outDir, 'browser-driver.py');
const screenshotPath = join(outDir, 'browser.png');
const tracePath = join(outDir, 'trace.json');
const assertions: Assertion[] = [];
mkdirSync(outDir, { recursive: true });

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const session = { tool: 'opencode', id: `sandbox-${short}` };
const cacheRoot = join(tmpdir(), `cosyncing-artifact-sandbox-cache-${short}`);
const store = new ArtifactStore(baseUrl, cacheRoot);
const socketFrames: unknown[] = [];
let exfilHits = 0;

const hostileHtml = `<!doctype html>
<html>
  <body>
    <h1>Hostile artifact</h1>
    <script>
      window.NON_NONCE_SCRIPT_RAN = true;
      parent.postMessage({ type: 'hostile-non-nonce-script-ran' }, '*');
    </script>
    <img src="x" onerror="parent.postMessage({ type: 'hostile-inline-handler-ran' }, '*')">
    <form id="bridge-form"><input name="answer" value="42"><button id="submit">Submit</button></form>
    <button id="bridge-action" data-cosyncing-action="approve" data-cosyncing-value="yes">Approve</button>
  </body>
</html>`;

const artifact = store.putBytes(
  session,
  {
    type: 'file-artifact',
    name: 'hostile.html',
    path: 'output/hostile.html',
    mimeType: 'text/html',
    size: Buffer.byteLength(hostileHtml),
    artifactKey: `hostile-${short}`,
  },
  Buffer.from(hostileHtml),
  'text/html',
  baseUrl,
);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  websocket: {
    message(_ws, message) {
      try {
        socketFrames.push(JSON.parse(String(message)));
      } catch {
        socketFrames.push(String(message));
      }
    },
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/') {
      const html = readFileSync(join(process.cwd(), 'apps/poc-ui/public/index.html'), 'utf8')
        .replace(
          '<script type="module" src="app.js"></script>',
          '<script>window.__COSYNCING_TEST__ = true;</script><script type="module" src="app.js"></script>',
        );
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/app.js') {
      return new Response(Bun.file(join(process.cwd(), 'apps/poc-ui/public/app.js')), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/api/sessions') {
      return Response.json({ machine: 'sandbox-test', sessions: [sessionInfo()] });
    }
    if (url.pathname === '/api/agents') return Response.json([]);
    if (url.pathname === `/api/sessions/${session.tool}/${session.id}/stream`) {
      if (srv.upgrade(req)) return;
      return new Response('upgrade required', { status: 400 });
    }
    const art = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/artifact\/([^/]+)$/);
    if (art) {
      return store.serve(
        decodeURIComponent(art[1]!),
        decodeURIComponent(art[2]!),
        decodeURIComponent(art[3]!),
        url.searchParams.get('expires'),
        url.searchParams.get('sig'),
      );
    }
    if (url.pathname.startsWith('/exfil')) {
      exfilHits++;
      return new Response('exfil hit');
    }
    return new Response('not found', { status: 404 });
  },
});

try {
  writeBrowserDriver();
  const proc = Bun.spawn(['python3', driverPath, baseUrl, artifact.fetchUrl!, artifact.artifactKey!, resultPath, screenshotPath], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  check('browser driver exits cleanly', code === 0, code === 0 ? '' : `exit=${code}`);
  const result = readJson(resultPath);
  if (result?.skip) {
    console.log(`SKIP artifact sandbox browser trace - ${result.skip}`);
    process.exit(0);
  }
  check('browser driver produced result JSON', !!result?.ok, JSON.stringify(result));
  check('ArtifactStore serves strict CSP to the real browser', !!result?.cspHasStrictDirectives, JSON.stringify(result?.csp));
  check('non-nonce artifact script did not execute in Chromium', result?.nonNonceScriptRan === false && result?.hostileMessages === 0, JSON.stringify(result));
  check('connect-src none blocks fetch exfiltration in Chromium', result?.fetchBlocked === true && exfilHits === 0, JSON.stringify({ result, exfilHits }));
  check('connect-src none prevents sendBeacon exfiltration from reaching the server', exfilHits === 0, JSON.stringify({ result, exfilHits }));
  check(
    'registered artifact bridge forwards a form interaction over the app WebSocket',
    socketFrames.some((f: any) => f?.kind === 'artifact-interaction' && f?.artifactKey === artifact.artifactKey && f?.interaction?.data?.answer === '42'),
    JSON.stringify(socketFrames),
  );
  check(
    'forged nested postMessage is dropped by the real app listener',
    !socketFrames.some((f: any) => f?.kind === 'artifact-interaction' && f?.interaction?.data?.answer === 'forged'),
    JSON.stringify(socketFrames),
  );
} finally {
  server.stop(true);
  rmSync(cacheRoot, { recursive: true, force: true });
}

const failed = assertions.filter((a) => !a.ok);
const trace = {
  runId,
  baseUrl,
  artifact: { artifactKey: artifact.artifactKey, fetchUrl: artifact.fetchUrl },
  output: { result: resultPath, screenshot: screenshotPath },
  socketFrames,
  exfilHits,
  assertions,
};
writeFileSync(tracePath, JSON.stringify(trace, null, 2));
for (const a of assertions) console.log(`${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.detail ? ` - ${a.detail}` : ''}`);
console.log(`\ntrace: ${tracePath}`);
if (failed.length) process.exit(1);

function sessionInfo() {
  return {
    ...session,
    title: 'Artifact sandbox session',
    cwd: process.cwd(),
    status: 'idle',
    updatedAt: Date.now(),
    createdAt: Date.now(),
    attachModes: ['resume'],
    control: {
      drive: { supported: true, state: 'driving' },
      terminalSync: { supported: true, active: false, syncAvailable: false },
    },
  };
}

function check(name: string, ok: boolean, detail?: string): void {
  assertions.push({ name, ok, detail });
}

function readJson(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const openPort = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(openPort));
    });
    s.on('error', reject);
  });
}

function writeBrowserDriver(): void {
  writeFileSync(driverPath, String.raw`
import json
import os
import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    open(sys.argv[4], "w").write(json.dumps({"skip": "playwright import: " + str(e)}))
    raise SystemExit(0)

base_url, artifact_url, artifact_key, result_path, screenshot_path = sys.argv[1:6]
# Default headless (CI). On hosts where headless Chromium can't paint the sandboxed artifact iframe
# (e.g. this WSL2 box — the click on the artifact iframe times out), run headful under a virtual display:
#   ARTIFACT_TRACE_HEADFUL=1 xvfb-run -a bun run scripts/broker/tests_traces/artifact-sandbox-browser-trace.ts
_headful = os.environ.get("ARTIFACT_TRACE_HEADFUL") == "1"

def write(obj):
    open(result_path, "w").write(json.dumps(obj))

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=not _headful)
    except Exception as e:
        write({"skip": "chromium launch: " + str(e)})
        raise SystemExit(0)
    page = browser.new_page()
    page.goto(base_url, wait_until="networkidle")  # this trace runs a self-contained fake server that serves the PoC at / (not the real broker's /poc-ui/), and base_url is reused below for /exfil URLs
    page.evaluate("""async ({artifactUrl, artifactKey}) => {
      const app = window.__COSYNCING_APP__;
      const parts = new URL(artifactUrl).pathname.split('/');
      const session = {
        tool: parts[3],
        id: parts[4],
        title: 'Artifact sandbox session',
        cwd: '/',
        status: 'idle',
        updatedAt: Date.now(),
        attachModes: ['resume'],
        control: {
          drive: { supported: true, state: 'driving' },
          terminalSync: { supported: true, active: false, syncAvailable: false },
        },
      };
      await app.attach(session);
      await new Promise((resolve) => setTimeout(resolve, 120));
      app.render({
        type: 'file-artifact',
        name: 'hostile.html',
        path: 'output/hostile.html',
        mimeType: 'text/html',
        size: 1234,
        artifactKey,
        fetchUrl: artifactUrl,
      }, true);
    }""", {"artifactUrl": artifact_url, "artifactKey": artifact_key})
    page.locator(".artifact button").click()
    iframe_el = page.wait_for_selector(".artifact iframe", timeout=10000)
    frame = iframe_el.content_frame()
    page.evaluate("""() => {
      window.__hostileMessages = [];
      window.addEventListener('message', (event) => {
        if (event.data && String(event.data.type || '').startsWith('hostile-')) window.__hostileMessages.push(event.data);
      });
    }""")
    frame.wait_for_selector("#bridge-form", timeout=10000)
    csp = page.request.get(artifact_url).headers.get("content-security-policy", "")
    non_nonce = frame.evaluate("() => Boolean(window.NON_NONCE_SCRIPT_RAN)")
    fetch_blocked = frame.evaluate("""async (url) => {
      try {
        await fetch(url, { mode: 'no-cors' });
        return false;
      } catch (e) {
        return /content security policy|failed|blocked|violates/i.test(String(e && (e.message || e)));
      }
    }""", base_url + "/exfil/fetch")
    beacon_queued = frame.evaluate("""async (url) => {
      try {
        const accepted = navigator.sendBeacon(url, "x");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return accepted === true;
      } catch (e) {
        return false;
      }
    }""", base_url + "/exfil/beacon")
    frame.locator("#submit").click()
    page.evaluate("""(artifactKey) => {
      const nested = document.createElement('iframe');
      const payload = { type: 'cosyncing-artifact-interaction', artifactKey, interaction: { type: 'form-submit', formId: 'evil', data: { answer: 'forged' } } };
      nested.srcdoc = '<script>parent.postMessage(' + JSON.stringify(payload) + ', "*")<\\/script>';
      document.body.appendChild(nested);
    }""", artifact_key)
    page.wait_for_timeout(600)
    hostile_messages = page.evaluate("() => window.__hostileMessages || []")
    page.screenshot(path=screenshot_path, full_page=True)
    write({
      "ok": True,
      "csp": csp,
      "cspHasStrictDirectives": "default-src 'none'" in csp and "connect-src 'none'" in csp and "script-src 'nonce-" in csp,
      "nonNonceScriptRan": non_nonce,
      "fetchBlocked": fetch_blocked,
      "beaconQueued": beacon_queued,
      "hostileMessages": len(hostile_messages),
    })
    browser.close()
`);
}
