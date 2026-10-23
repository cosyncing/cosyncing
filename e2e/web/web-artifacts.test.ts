/**
 * A file the agent sends shows up on exactly the session that sent it, and the
 * user can keep and download it.
 *
 * Real brokers serve the built Flutter client; the Pi bridge is the agent.
 * Chromium shows what the user sees: the owner's session carries a delivered
 * file, a peer session in the same folder never does, the file survives a
 * broker outage and restart, a failing Files route never takes the Chat action
 * away, an over-limit response never reaches the download path, a transient
 * failure can be retried into exact bytes, and a different broker never shows
 * another broker's file even for the same native session id.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Download, Locator, Page } from 'playwright-core';
import { type Broker, eventually } from '../harness/index.ts';
import { collectBrowserErrors, launchBrowser, newScenarioContext, waitForFlutter } from '../harness/browser.ts';
import { startWebBroker } from '../harness/web-scenario.ts';
import { writeMediaFixtures } from '../harness/media-fixtures.ts';
import { startFakeTokdash } from '../harness/fakes/tokdash.ts';

const REPORT_BYTES = Buffer.from('exact browser download bytes\n', 'utf8');

interface Fixture {
  a: Broker;
  b: Broker;
  ownerId: string;
  peerId: string;
  workspace: string;
  /** Re-register both sessions on A (after a restart). */
  rehelloA(): Promise<void>;
  sameOwnerIdOnB: string;
  dispose(): Promise<void>;
}

/** Two brokers; on A an owner session that was sent a file and a peer session in the same folder. */
async function startFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-web-artifacts-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const reportPath = join(workspace, 'report.txt');
  writeFileSync(reportPath, REPORT_BYTES);
  const files = { owner: join(root, 'owner.jsonl'), peer: join(root, 'peer.jsonl') };
  for (const [name, file] of Object.entries(files)) {
    writeFileSync(file, `${JSON.stringify({ type: 'session', id: name, cwd: workspace })}\n`);
  }
  const tokdash = startFakeTokdash();
  const [a, b] = await Promise.all([
    startWebBroker({ name: 'web-art-a', env: { COSYNCING_FS_REMOTE_ENABLED: '1', COSYNCING_TOKDASH_URL: tokdash.url } }),
    startWebBroker({ name: 'web-art-b', env: { COSYNCING_FS_REMOTE_ENABLED: '1', COSYNCING_TOKDASH_URL: tokdash.url } }),
  ]);
  const hello = async (broker: Broker, file: string, title: string, row: string): Promise<string> => {
    const response = await broker.client().post('/pi/bridge/hello', {
      sessionFile: file,
      cwd: workspace,
      title,
      history: [{ t: 'user', key: `${title}-row`, text: row }],
    });
    expect(response.status).toBe(200);
    return String(response.body.id);
  };
  const ownerId = await hello(a, files.owner, 'Artifact owner', 'owner session row');
  const peerId = await hello(a, files.peer, 'Artifact peer', 'peer session row');
  const sameOwnerIdOnB = await hello(b, files.owner, 'Artifact owner', 'owner session row');
  expect(sameOwnerIdOnB).toBe(ownerId);
  const sent = await a.client().post('/pi/bridge/send-file', { id: ownerId, path: reportPath });
  expect(sent.status).toBe(200);
  return {
    a, b, ownerId, peerId, workspace, sameOwnerIdOnB,
    async rehelloA() {
      await hello(a, files.owner, 'Artifact owner', 'owner session row');
      await hello(a, files.peer, 'Artifact peer', 'peer session row');
    },
    async dispose() {
      await Promise.all([a.stop(), b.stop()]);
      await tokdash.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const transcriptDownload = (page: Page): Locator =>
  // Wide layouts keep Chat beside Files, so both have a Download action: scope
  // to the delivered-file card in the transcript.
  page.getByRole('group', { name: /^report\.txt\s+Sent to you\b/ }).getByRole('button', { name: 'Download', exact: true });

const sessionTab = (page: Page, title: string): Locator => page.locator(`[role="group"][aria-label="${title}"]`);

async function openView(page: Page, view: 'Chat' | 'Files'): Promise<void> {
  await page.getByRole('button', { name: 'Views and display options', exact: true }).click();
  await page.getByRole('menuitem', { name: view, exact: true }).click();
}

/**
 * Open a session from the roster, as the user does, and come back to a fresh
 * load of Sessions with its tab mounted from the durable working set. Flutter
 * can replace a semantics node while the roster repaints, so each attempt
 * re-resolves everything.
 */
async function openFromRoster(page: Page, origin: string, title: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await eventually(async () => {
    await page.goto(`${origin}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
    await waitForFlutter(page);
    if (await sessionTab(page, title).count() > 0) return true;
    try {
      const row = page.getByRole('button', { name: title, exact: false });
      if (!(await row.first().isVisible().catch(() => false))) {
        await page.getByRole('textbox', { name: 'Search sessions' }).first().fill(title, { timeout: 5_000 });
        await row.first().waitFor({ state: 'visible', timeout: 5_000 });
      }
      await row.first().click({ force: true, timeout: 5_000 });
      await sessionTab(page, title).first().waitFor({ state: 'attached', timeout: 5_000 });
    } catch {
      // The roster repainted under us: load again and retry.
    }
    return false;
  }, { timeoutMs: 90_000, intervalMs: 50, what: `session ${title} in the working set` });
}

/** Click the working-set tab for a session (the topmost, when a layout shows two). */
async function selectTab(page: Page, title: string): Promise<void> {
  const tabs = sessionTab(page, title);
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  let best = tabs.first();
  let bestY = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const box = await tabs.nth(i).boundingBox();
    if (box && box.y < bestY) { best = tabs.nth(i); bestY = box.y; }
  }
  await best.click();
}

describe('delivered files in the web client', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); });
  afterAll(async () => { await browser?.close(); });

  async function scenario(run: (f: Fixture, page: Page, errors: string[], downloads: Download[]) => Promise<void>): Promise<void> {
    const fixture = await startFixture();
    const context = await newScenarioContext(browser, { viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      const errors = collectBrowserErrors(page);
      const downloads: Download[] = [];
      page.on('download', (download) => downloads.push(download));
      try {
        await run(fixture, page, errors, downloads);
      } catch (error) {
        if (process.env.FILE_PREVIEW_REVIEW === '1') {
          mkdirSync('output/review/file-previews', { recursive: true });
          await page.screenshot({ path: 'output/review/file-previews/failure.png' });
          writeFileSync('output/review/file-previews/failure.txt', `${String(error)}\n${errors.join('\n')}\n${await page.locator('body').ariaSnapshot()}`);
        }
        throw error;
      }
    } finally {
      await context.close().catch(() => undefined);
      await fixture.dispose();
    }
  }

  test.concurrent('HTML is interactive by default, stable while visible, and destroyed by pane lifecycle', async () => {
    await scenario(async (f, page) => {
      writeFileSync(join(f.workspace, 'dashboard.html'), `<!doctype html><title>Dashboard</title>
        <button onclick="count.textContent=++window.clicks">Increment</button><output id="count">0</output>
        <canvas id="chart" width="20" height="20"></canvas><script>
        window.clicks=0; window.ticks=0; window.identity=Math.random();
        setInterval(()=>window.ticks++, 10);
        chart.getContext('2d').fillRect(0,0,20,20); document.body.dataset.ready='yes';
        </script>`);
      await openFromRoster(page, f.a.url, 'Artifact peer');
      await openFromRoster(page, f.a.url, 'Artifact owner');
      expect(page.frames()).toHaveLength(1);
      await openView(page, 'Files');
      await page.getByRole('button', { name: 'Preview file', exact: true }).first().click();
      const child = () => page.frameLocator('iframe').frameLocator('iframe');
      await child().locator('body[data-ready="yes"]').waitFor();
      const frame = page.frames().find((frame) => frame.parentFrame()?.parentFrame())!;
      const identity = await frame.evaluate<number>('window.identity');
      await child().getByRole('button', { name: 'Increment' }).click();
      expect(await child().locator('output').innerText()).toBe('1');
      expect(await frame.evaluate<number>("document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[3]")).toBe(255);
      await page.setViewportSize({ width: 1480, height: 960 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      const sent = await f.a.client().post('/pi/bridge/send-file', { id: f.ownerId, path: join(f.workspace, 'report.txt') });
      expect(sent.status).toBe(200);
      await page.getByRole('button', { name: 'Download', exact: true }).first().waitFor();
      expect(await frame.evaluate<number>('window.identity')).toBe(identity);
      expect(await child().locator('output').innerText()).toBe('1');
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await eventually(() => page.frames().length === 1, { what: 'Source removes all HTML contexts' });
      expect(frame.isDetached()).toBe(true);
      await page.getByRole('button', { name: 'Rendered', exact: true }).click();
      await child().locator('body[data-ready="yes"]').waitFor();
      expect(await child().locator('output').innerText()).toBe('0');
      await selectTab(page, 'Artifact peer');
      await eventually(() => page.frames().length === 1, { what: 'hidden retained session removes frames' });
      await selectTab(page, 'Artifact owner');
      await child().locator('body[data-ready="yes"]').waitFor();
      // Browser visibility delivery is controlled; native lifecycle is exercised
      // through the app driver in file_previews_test.dart.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await eventually(() => page.frames().length === 1, { what: 'background destroys document synchronously' });
      await page.evaluate(() => {
        delete (document as any).hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await child().locator('body[data-ready="yes"]').waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      // The retained iframe is already ready before Flutter handles resize.
      // Wait for the compact workspace control before acting on that layout.
      const showSessions = page.getByRole('button', { name: 'Show sessions', exact: true });
      await showSessions.waitFor();
      await child().locator('body[data-ready="yes"]').waitFor();
      expect(page.frames()).toHaveLength(3);
      await page.getByRole('button', { name: 'Close', exact: true }).last().click();
      await eventually(() => page.frames().length === 1, { what: 'close removes every frame' });
      // Closing persists asynchronously, then publishes its Undo notice.
      // Settle and dismiss it before changing layout and reopening the file.
      const undo = page.getByRole('button', { name: 'Undo', exact: true });
      await undo.waitFor();
      await page.getByRole('button', { name: 'Close', exact: true }).last().click();
      await undo.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await showSessions.waitFor({ state: 'hidden' });
      await openView(page, 'Files');
      await page.getByRole('button', { name: 'Preview file', exact: true }).first().click();
      await child().locator('body[data-ready="yes"]').waitFor();
      await openFromRoster(page, f.b.url, 'Artifact owner');
      expect(page.frames()).toHaveLength(1);
    });
  });

  test.concurrent('HTML policy precedes malformed bytes and isolates embedded and external documents', async () => {
    const requestPrefix = `/${randomUUID()}/`;
    const requests: string[] = [];
    const recorder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      // Only this document's URLs belong to its CSP assertion. Other loopback
      // probes must not contaminate a recorder on a newly allocated port.
      if (path.startsWith(requestPrefix)) requests.push(path);
      return new Response('unexpected resource', { headers: { 'access-control-allow-origin': '*' } });
    } });
    const target = new URL(requestPrefix, recorder.url).toString();
    try {
      for (const probe of [recorder.url, target]) {
        const response = await fetch(probe);
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(requests).toEqual([requestPrefix]);
      requests.length = 0;
      await scenario(async (f, page) => {
        // Executable bytes precede the apparent head; the existing policy and
        // malformed metadata must never precede or relax the containing policy.
        writeFileSync(join(f.workspace, 'attack.xhtml'), `<script>
          window.checks={}; const check=(name, fn)=>{try{fn();checks[name]=false}catch{checks[name]=true}};
          check('parent',()=>parent.document.body); check('top',()=>top.document.body);
          check('storage',()=>localStorage.getItem('token')); check('cookie',()=>document.cookie);
          check('eval',()=>eval('1')); check('worker',()=>new Worker('${target}worker'));
          checks.bridge = !window.webkit?.messageHandlers && !window.flutter_inappwebview;
          fetch('${target}fetch').catch(()=>{}); new WebSocket('${target.replace('http:', 'ws:')}socket');
          </script><html xmlns="http://www.w3.org/1999/xhtml"><head><meta content='broken >'>
          <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'">
          <link rel="stylesheet" href="${target}style"><script src="${target}script"></script></head>
          <body><img src="${target}image"><img src="relative.png"><svg onload="this.dataset.ready='yes'" id="svg"></svg>
          <button onclick="this.textContent='Worked'">Interact</button>
          <button onclick="location.replace('${target}navigate')">Navigate</button>
          <button onclick="top.location.href='${target}top'">Top</button>
          <a href="${target}popup" target="_blank">Popup</a>
          <form action="${target}form"><button>Submit</button></form>
          <script>document.body.dataset.ready='yes'</script></body></html>`);
        await openFromRoster(page, f.a.url, 'Artifact owner');
        await openView(page, 'Files');
        await page.getByRole('button', { name: 'Preview file', exact: true }).first().click();
        const inner = page.frameLocator('iframe').frameLocator('iframe');
        await inner.locator('body[data-ready="yes"]').waitFor();
        const frame = page.frames().find((frame) => frame.parentFrame()?.parentFrame())!;
        expect(await frame.evaluate<Record<string, boolean>>('window.checks')).toEqual({ parent: true, top: true, storage: true, cookie: true, eval: true, worker: true, bridge: true });
        await inner.locator('#svg[data-ready="yes"]').waitFor();
        await inner.getByRole('button', { name: 'Interact' }).click();
        await inner.getByRole('button', { name: 'Worked' }).waitFor();
        await inner.getByRole('button', { name: 'Top' }).click();
        expect(page.url()).toContain('/cosy/');
        await inner.getByRole('link', { name: 'Popup' }).click();
        await inner.getByRole('button', { name: 'Submit' }).click();
        expect(page.context().pages()).toHaveLength(1);
        const wrapper = await page.locator('iframe').evaluate((frame: HTMLIFrameElement) => frame.srcdoc);
        const navigated = page.waitForEvent('framenavigated', { predicate: (changed) => changed === frame });
        await inner.getByRole('button', { name: 'Navigate' }).click();
        await navigated;
        expect(page.url()).toContain('/cosy/');
        expect(requests).toEqual([]);
        // file:// has different privileges and must be tested independently.
        const staged = join(f.workspace, 'staged.html');
        writeFileSync(staged, wrapper);
        const external = await page.context().newPage();
        try {
          await external.goto(pathToFileURL(staged).toString());
          const document = external.frameLocator('iframe');
          await document.getByRole('button', { name: 'Interact' }).click();
          await document.getByRole('button', { name: 'Worked' }).waitFor();
          const child = external.frames()[1]!;
          const nav = external.waitForEvent('framenavigated', { predicate: (changed) => changed === child });
          await document.getByRole('button', { name: 'Navigate' }).click();
          await nav;
          expect(requests).toEqual([]);
        } finally { await external.close(); }
      });
    } finally { recorder.stop(true); }
  });

  test.concurrent('media stays lazy, images and PDFs render, videos play, and close revokes access', async () => {
    await scenario(async (f, page) => {
      writeMediaFixtures(f.workspace);
      const review = async (name: string): Promise<void> => {
        if (process.env.FILE_PREVIEW_REVIEW !== '1') return;
        mkdirSync('output/review/file-previews', { recursive: true });
        await page.screenshot({ path: `output/review/file-previews/${name}.png` });
      };
      const listed = await f.a.client().get(`/api/sessions/pi/${encodeURIComponent(f.ownerId)}/fs`);
      expect(listed.status).toBe(200);
      expect(listed.body.entries.map((entry: any) => entry.name)).toContain('picture.png');
      const mediaRequests: string[] = [];
      const engineRequests: string[] = [];
      const released: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/media-preview')) mediaRequests.push(request.url());
        if (request.url().includes('/assets/packages/pdfrx/')) engineRequests.push(request.url());
        if (request.method() === 'DELETE' && request.url().includes('/api/media-previews/')) released.push(request.url());
      });
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await openView(page, 'Files');
      await review('files-before-preview');
      if (process.env.FILE_PREVIEW_REVIEW === '1') writeFileSync('output/review/file-previews/files-semantics.txt', await page.locator('body').innerText());
      await page.getByRole('button', { name: 'Preview file', exact: true }).nth(3).waitFor();
      expect(mediaRequests).toHaveLength(0);
      expect(engineRequests).toHaveLength(0);
      const preview = async (name: string): Promise<void> => {
        const index = ['clip.webm', 'document.pdf', 'picture.png', 'report.txt'].indexOf(name);
        await page.getByRole('button', { name: 'Preview file', exact: true }).nth(index).click();
      };
      const close = async (count: number): Promise<void> => {
        await page.getByRole('button', { name: 'Close', exact: true }).last().click();
        // Dismiss the close notice before reviewing the next file: its Close
        // button is separate from the next preview's Close button.
        const undo = page.getByRole('button', { name: 'Undo', exact: true });
        await undo.waitFor();
        await page.getByRole('button', { name: 'Close', exact: true }).last().click();
        await undo.waitFor({ state: 'hidden' });
        await eventually(() => released.length === count, { what: 'closed preview capability to be revoked' });
        await eventually(async () => (await fetch(released[count - 1]!)).status === 403, { what: 'closed preview access to stop' });
      };
      await preview('picture.png');
      await page.getByRole('button', { name: 'Fit to view', exact: true }).waitFor();
      await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor();
      expect(engineRequests).toHaveLength(0);
      await review('image-light');
      await close(1);
      await review('after-image-close');

      await preview('document.pdf');
      await page.getByRole('group', { name: /Page 1 of 2$/ }).waitFor();
      await review('pdf-light');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByRole('group', { name: /Page 2 of 2$/ }).waitFor();
      expect(engineRequests.length).toBeGreaterThan(0);
      await review('pdf-dark');
      await close(2);

      await preview('clip.webm');
      await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
      expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true);
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video != null && video.currentTime > 0 && !video.paused;
      });
      // A hovered Flutter tooltip can append the same label to button semantics.
      await page.getByRole('button', { name: /^Pause(?: Pause)?$/ }).click();
      await page.waitForFunction(() => document.querySelector('video')?.paused === true);
      await review('video-dark');
      await close(3);
      await page.waitForFunction(() => document.querySelector('video') === null);
      // Delivered files use the same viewer without reading the workspace path.
      const sent = await f.a.client().post('/pi/bridge/send-file', { id: f.ownerId, path: join(f.workspace, 'picture.png') });
      expect(sent.status).toBe(200);
      await openView(page, 'Chat');
      await page.getByRole('group', { name: /^picture\.png\s+Sent to you\b/ })
        .first().getByRole('button', { name: 'Open file', exact: true }).click();
      await page.getByRole('button', { name: 'Fit to view', exact: true }).waitFor();
      await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor();
      await close(4);

      await page.setViewportSize({ width: 390, height: 844 });
      await openView(page, 'Chat');
      await page.getByRole('group', { name: /^picture\.png\s+Sent to you\b/ })
        .first().getByRole('button', { name: 'Open file', exact: true }).click();
      await page.getByRole('img', { name: 'picture.png', exact: true }).waitFor();
      await review('image-phone-dark');
      await close(5);
      await openView(page, 'Files');
      await preview('document.pdf');
      await page.getByRole('group', { name: /Page 1 of 2$/ }).waitFor();
      await review('pdf-phone-dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByRole('group', { name: /Page 2 of 2$/ }).waitFor();
      await review('pdf-phone-light');
      await close(6);
      expect(await page.getByText('This file could not be previewed.', { exact: false }).count()).toBe(0);
    });
  });

  test.concurrent('the owner session shows its file; a peer session in the same folder never does', async () => {
    await scenario(async (f, page) => {
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await transcriptDownload(page).waitFor();
      await openFromRoster(page, f.a.url, 'Artifact peer');
      // The peer's own transcript has loaded; only then can "no file" mean anything.
      await page.getByText('peer session row').first().waitFor();
      expect(await page.getByRole('button', { name: 'Download', exact: true }).count()).toBe(0);
    });
  });

  test.concurrent('with the broker down the file is still on the owner tab; after a restart and reload there is exactly one', async () => {
    await scenario(async (f, page) => {
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await transcriptDownload(page).waitFor();
      await openFromRoster(page, f.a.url, 'Artifact peer');
      await page.getByText('peer session row').first().waitFor();

      await f.a.stop({ keepState: true });
      await selectTab(page, 'Artifact owner');
      // No broker can replay it: this is the client's own cache.
      await transcriptDownload(page).waitFor();

      await f.a.start();
      await f.rehelloA();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForFlutter(page);
      await transcriptDownload(page).waitFor();
      await openView(page, 'Files');
      await page.getByRole('group', { name: /^File artifacts \(1\)\s+report\.txt/ }).waitFor();
      expect(await page.getByRole('group', { name: /^report\.txt\s+Sent to you\b/ }).count()).toBeGreaterThanOrEqual(1);
    });
  });

  test.concurrent('a failing Files route leaves the Chat download action enabled', async () => {
    await scenario(async (f, page) => {
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await transcriptDownload(page).waitFor();
      let failures = 0;
      await page.route('**/api/sessions/pi/*/fs*', async (route) => {
        failures++;
        await route.fulfill({ status: 503, body: 'fixture workspace failure' });
      });
      await openView(page, 'Files');
      await eventually(() => failures > 0, { what: 'the Files view to hit its failing route' });
      await page.getByRole('group', { name: /^File artifacts \(1\)\s+report\.txt/ })
        .getByRole('button', { name: 'Download', exact: true }).waitFor();
      await transcriptDownload(page).waitFor();
      await openView(page, 'Chat');
      await page.unrouteAll({ behavior: 'wait' });
      await transcriptDownload(page).waitFor();
      expect(await transcriptDownload(page).isEnabled()).toBe(true);
    });
  });

  test.concurrent('an over-limit response never reaches the download path; a transient failure retries into the exact bytes', async () => {
    await scenario(async (f, page, errors, downloads) => {
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await transcriptDownload(page).waitFor();

      // One handler for the whole scenario, steered by a mode: no unrouting while a
      // handler may still be answering. Oversize keeps the signed response and its
      // headers and only advertises more than the client accepts.
      let mode: 'pass' | 'oversize' | 'transient' = 'oversize';
      let oversizedServed!: () => void;
      const served = new Promise<void>((resolve) => { oversizedServed = resolve; });
      let failedOnce = false;
      await page.route('**/api/sessions/pi/*/artifact/*', async (route) => {
        if (mode === 'oversize') {
          const response = await route.fetch();
          await route.fulfill({ response, headers: { ...response.headers(), 'content-length': String(64 * 1024 * 1024 + 1) } });
          oversizedServed();
        } else if (mode === 'transient' && !failedOnce) {
          failedOnce = true;
          await route.fulfill({ status: 503, body: 'transient fixture failure' });
        } else {
          await route.continue();
        }
      });
      await transcriptDownload(page).click();
      await Promise.race([
        served,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the over-limit route was not served')), 30_000).unref()),
      ]);

      // First real fetch fails transiently; the action stays and nothing technical leaks.
      mode = 'transient';
      // The action is absent while the previous attempt is still being handled. Click
      // when it is there, then give that click time to take effect before trying again:
      // a second click on a request in flight is not a retry.
      await eventually(async () => {
        if (failedOnce) return true;
        if (await transcriptDownload(page).count() > 0) {
          await transcriptDownload(page).click({ timeout: 5_000 }).catch(() => undefined);
          await eventually(() => failedOnce, { timeoutMs: 8_000, what: 'the click to request the file' }).catch(() => undefined);
        }
        return failedOnce;
      }, { timeoutMs: 60_000, what: 'the transient failure' });
      await transcriptDownload(page).waitFor();
      const visible = await page.locator('body').innerText();
      expect(visible).not.toContain('transient fixture failure');
      expect(visible).not.toContain('sig=');

      await eventually(async () => {
        if (downloads.length > 0) return true;
        if (await transcriptDownload(page).count() > 0) {
          await transcriptDownload(page).click({ timeout: 5_000 }).catch(() => undefined);
          await eventually(() => downloads.length > 0, { timeoutMs: 8_000, what: 'the click to start a download' }).catch(() => undefined);
        }
        return downloads.length > 0;
      }, { timeoutMs: 60_000, what: 'the download to start' });
      const saved = downloads[0]!;
      expect(readFileSync((await saved.path())!)).toEqual(REPORT_BYTES);
      expect(saved.suggestedFilename()).toBe('report.txt');
      mode = 'pass';
      // Every download this page started: only the good one. Events arrive in
      // order, so an earlier over-limit download would already be listed.
      expect(downloads).toHaveLength(1);

      // Survives a reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForFlutter(page);
      await transcriptDownload(page).waitFor();
      const material = errors.filter((message) => !/favicon|Failed to load resource.*503/i.test(message)
        && !/Failed to load resource.* 502 .*\/api\/tokdash\/report\?/.test(message));
      expect(material).toEqual([]);
    });
  });

  test.concurrent('another broker with the same native session id never shows this broker\'s file', async () => {
    await scenario(async (f, page) => {
      await openFromRoster(page, f.a.url, 'Artifact owner');
      await transcriptDownload(page).waitFor();
      // Flutter web is same-origin to its broker; switching brokers is opening the other /cosy/ mount.
      await openFromRoster(page, f.b.url, 'Artifact owner');
      await page.getByText('owner session row').first().waitFor();
      expect(await page.locator('[role]').filter({ hasText: 'report.txt' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Download', exact: true }).count()).toBe(0);
    });
  });
});
