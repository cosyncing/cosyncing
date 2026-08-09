#!/usr/bin/env bun
/**
 * Real Flutter-web regression for exact artifact ownership and actions.
 *
 * Starts two isolated production brokers, serves the current Flutter build
 * from broker A, and drives the actual app in Chromium. It covers the client
 * transcript cache, open-session tab switching, Files/Chat isolation, browser
 * reload, transient retry, exact downloaded bytes, and a live switch to
 * broker B with the same native Pi session id.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
  type ProcessOutputCapture,
} from '../../broker/tests/helpers/isolated-broker-fixture.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const WEB_BUILD = join(REPOSITORY_ROOT, 'apps/client/build/web');
const OUTPUT = join(REPOSITORY_ROOT, 'output/artifact-session-isolation');
const BROWSER_ARGS = [
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-features=Vulkan,VizDisplayCompositor',
];

interface BrokerProcess {
  child: ReturnType<typeof Bun.spawn>;
  output: ProcessOutputCapture;
  origin: string;
}

async function chromiumExecutable(): Promise<string> {
  const explicit = process.env.COSYNCING_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  const shells = readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));
  if (shells.length === 0) {
    throw new Error('No Chromium headless shell found. Run: npx playwright install chromium-headless-shell');
  }
  return join(
    cache,
    shells[0]!,
    'chrome-headless-shell-linux64/chrome-headless-shell',
  );
}

async function startBroker(fixtureRoot: string, port: number): Promise<BrokerProcess> {
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: REPOSITORY_ROOT,
    env: isolatedBrokerFixtureEnvironment(fixtureRoot, {
      overrides: {
        PORT: String(port),
        HOST: '127.0.0.1',
        COSYNCING_CACHE_DIR: join(fixtureRoot, 'artifact-cache'),
        COSYNCING_WEB_DIR: WEB_BUILD,
        COSYNCING_PI_SESSIONS_ROOT: '',
        PI_CODING_AGENT_SESSION_DIR: '',
      },
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = captureProcessOutput(child);
  try {
    await waitForBrokerHealth(child, `${origin}/api/health`);
  } catch (error) {
    child.kill();
    await child.exited;
    const log = await settledProcessOutput(output);
    throw new Error(`${String(error)}\n${log.slice(-2_000)}`);
  }
  return { child, output, origin };
}

async function stopBroker(process: BrokerProcess | undefined): Promise<void> {
  if (!process) return;
  if (process.child.exitCode == null) process.child.kill();
  await process.child.exited;
  await settledProcessOutput(process.output);
}

async function post(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function hello(
  origin: string,
  sessionFile: string,
  cwd: string,
  title: string,
): Promise<string> {
  const response = await post(origin, '/pi/bridge/hello', {
    sessionFile,
    cwd,
    title,
  });
  assert.equal(response.status, 200, `bridge hello failed at ${origin}`);
  return String((await response.json() as { id: unknown }).id);
}

async function enableFlutterSemantics(page: Page): Promise<void> {
  const placeholder = page.locator('flt-semantics-placeholder');
  if (await placeholder.count()) await placeholder.dispatchEvent('click');
}

async function waitForFlutter(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector('flt-semantics-placeholder, flt-semantics')),
    undefined,
    { timeout: 60_000 },
  );
  await enableFlutterSemantics(page);
}

async function waitForArtifact(page: Page): Promise<void> {
  try {
    await page.getByRole('button', { name: 'Download', exact: true }).waitFor({
      timeout: 30_000,
    });
  } catch (error) {
    const labels = await page.locator('[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')).filter(Boolean)
    );
    const roles = await page.locator('[role]').evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        text: element.textContent,
      }))
    );
    const text = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: join(OUTPUT, 'failure.png'), fullPage: true });
    throw new Error(
      `${String(error)}\nURL ${page.url()}\nARIA ${JSON.stringify(labels)}\nROLES ${JSON.stringify(roles)}\nTEXT ${text.slice(0, 4_000)}`,
    );
  }
}

async function openRosterSession(
  page: Page,
  origin: string,
  title: string,
): Promise<void> {
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto(`${origin}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
  await waitForFlutter(page);
  const rowTitle = page.getByRole('button', { name: title, exact: false });
  // A durable compact working set may restore its last detail route after the
  // hash navigation wins. Follow the app's real Back control in that case;
  // waiting on a roster row while still on Detail makes the concurrency gate
  // timing-dependent without exercising a different product path.
  const detailBack = page.getByRole('button', { name: 'Back', exact: true });
  if (await detailBack.isVisible().catch(() => false)) {
    await detailBack.click();
  }
  try {
    await rowTitle.first().waitFor({ timeout: 30_000 });
  } catch (error) {
    const labels = await page.locator('[aria-label]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')).filter(Boolean)
    );
    const roles = await page.locator('[role]').evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        text: element.textContent,
      }))
    );
    const text = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: join(OUTPUT, 'roster-failure.png'), fullPage: true });
    throw new Error(
      `${String(error)}\nURL ${page.url()}\nARIA ${JSON.stringify(labels)}\nROLES ${JSON.stringify(roles)}\nTEXT ${text.slice(0, 4_000)}`,
    );
  }
  await rowTitle.first().click();
  await page.waitForURL((url) => decodeURIComponent(url.hash).includes('/sessions/pi/'), {
    timeout: 10_000,
  });
  // Session Detail records the compact destination in the durable working set.
  // Returning to Sessions after the resize mounts that exact tab in the real
  // expanded workspace.
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
  await waitForFlutter(page);
  await page.waitForTimeout(500);
}

async function openSessionTab(page: Page, title: string): Promise<void> {
  const candidates = page.locator(`[role="group"][aria-label="${title}"]`);
  const count = await candidates.count();
  if (count === 0) {
    const roles = await page.locator('[role]').evaluateAll((elements) =>
      elements.map((element) => ({
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        text: element.textContent,
      }))
    );
    throw new Error(`no open-session tab found for ${title}: ${JSON.stringify(roles)}`);
  }
  let selected = candidates.first();
  let selectedY = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    const box = await candidate.boundingBox();
    if (box && box.y < selectedY) {
      selected = candidate;
      selectedY = box.y;
    }
  }
  await selected.click();
  await page.waitForTimeout(300);
}

async function openView(page: Page, view: 'Chat' | 'Files'): Promise<void> {
  await page.getByRole('button', { name: 'Views and display options', exact: true }).click();
  await page.getByRole('menuitem', { name: view, exact: true }).click();
}

async function newBrowserContext(
  profile: string,
  colorScheme: 'light' | 'dark',
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    executablePath: await chromiumExecutable(),
    args: BROWSER_ARGS,
    headless: true,
    acceptDownloads: true,
    reducedMotion: 'reduce',
    colorScheme,
    viewport: { width: 1440, height: 1000 },
  });
}

assert(Bun.file(join(WEB_BUILD, 'index.html')).size > 0, 'Run bun run client:build:web first');
mkdirSync(OUTPUT, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cosyncing-web-artifact-isolation-'));
const fixtureA = join(root, 'broker-a');
const fixtureB = join(root, 'broker-b');
const workspace = join(root, 'workspace');
const sessionFileOwner = join(root, 'owner.jsonl');
const sessionFilePeer = join(root, 'peer.jsonl');
mkdirSync(workspace, { recursive: true });
writeFileSync(sessionFileOwner, `${JSON.stringify({ type: 'session', id: 'owner', cwd: workspace })}\n`);
writeFileSync(sessionFilePeer, `${JSON.stringify({ type: 'session', id: 'peer', cwd: workspace })}\n`);
const reportPath = join(workspace, 'report.txt');
const reportBytes = Buffer.from('exact browser download bytes\n', 'utf8');
writeFileSync(reportPath, reportBytes);

const leaseA = await reserveLoopbackFixturePort();
const leaseB = await reserveLoopbackFixturePort();
const portA = leaseA.port;
const portB = leaseB.port;
let brokerA: BrokerProcess | undefined;
let brokerB: BrokerProcess | undefined;
let lightContext: BrowserContext | undefined;
let darkContext: BrowserContext | undefined;

try {
  await leaseA.release();
  await leaseB.release();
  brokerA = await startBroker(fixtureA, portA);
  brokerB = await startBroker(fixtureB, portB);
  const ownerId = await hello(
    brokerA.origin,
    sessionFileOwner,
    workspace,
    'Artifact owner',
  );
  const peerId = await hello(
    brokerA.origin,
    sessionFilePeer,
    workspace,
    'Artifact peer',
  );
  const sameOwnerIdOnB = await hello(
    brokerB.origin,
    sessionFileOwner,
    workspace,
    'Artifact owner',
  );
  assert.equal(sameOwnerIdOnB, ownerId, 'broker switch fixture must reuse the native session id');
  const sendResponse = await post(brokerA.origin, '/pi/bridge/send-file', {
    id: ownerId,
    path: reportPath,
  });
  assert.equal(sendResponse.status, 200, 'session-qualified send-file setup failed');
  const roster = await fetch(`${brokerA.origin}/api/sessions`).then((response) => response.json()) as {
    sessions?: Array<{ id?: string; title?: string }>;
  };
  assert(roster.sessions?.some((session) => session.id === ownerId),
    'broker roster did not publish the owner bridge');

  const lightProfile = mkdtempSync(join(root, 'light-profile-'));
  lightContext = await newBrowserContext(lightProfile, 'light');
  const page = lightContext.pages()[0] ?? await lightContext.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await openRosterSession(page, brokerA.origin, 'Artifact owner');
  await waitForArtifact(page);
  await page.waitForTimeout(300);

  // Opening the peer creates the second working-set tab. It must never display
  // the owner's artifact even though both sessions share one cwd.
  await openRosterSession(page, brokerA.origin, 'Artifact peer');
  await page.waitForTimeout(500);
  assert.equal(
    await page.getByRole('button', { name: 'Download', exact: true }).count(),
    0,
    'peer session displayed the owner artifact',
  );

  // Stop the broker before switching tabs. Seeing the file after the actual
  // working-set tab click proves the profile/session-qualified client cache is
  // the source; no WebSocket replay can rescue this assertion.
  await stopBroker(brokerA);
  brokerA = undefined;
  await openSessionTab(page, 'Artifact owner');
  await waitForArtifact(page);

  // Restart the physical process with the same durable state, re-establish
  // each exact bridge, then reload the browser. The broker replay and client
  // reset paths must converge on one owner-only artifact.
  brokerA = await startBroker(fixtureA, portA);
  await hello(brokerA.origin, sessionFileOwner, workspace, 'Artifact owner');
  await hello(brokerA.origin, sessionFilePeer, workspace, 'Artifact peer');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForFlutter(page);
  await waitForArtifact(page);
  // The preceding connection-refused console entries are the expected signal
  // from the deliberate physical outage. Start error accounting again only
  // after the restarted broker has replayed the exact session.
  browserErrors.length = 0;

  // Force the unrelated workspace browser to fail. Returning to Chat must
  // leave the transcript action enabled and intact.
  let workspaceFailures = 0;
  await page.route('**/api/sessions/pi/*/fs*', async (route) => {
    workspaceFailures++;
    await route.fulfill({ status: 503, body: 'fixture workspace failure' });
  });
  await openView(page, 'Files');
  await page.waitForTimeout(1_000);
  assert(workspaceFailures > 0, 'Files view did not exercise its failing broker route');
  await openView(page, 'Chat');
  await page.unroute('**/api/sessions/pi/*/fs*');
  await waitForArtifact(page);

  // The real web client must reject an advertised over-limit response before
  // it enters the in-memory cache or browser download path. Reuse the broker's
  // exact signed response and identity headers, changing only Content-Length.
  let oversizedArtifactRequests = 0;
  let oversizedArtifactDownloaded = false;
  const recordUnexpectedDownload = () => {
    oversizedArtifactDownloaded = true;
  };
  page.on('download', recordUnexpectedDownload);
  await page.route('**/api/sessions/pi/*/artifact/*', async (route) => {
    oversizedArtifactRequests++;
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-length': String(64 * 1024 * 1024 + 1),
      },
    });
  });
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForTimeout(1_000);
  page.off('download', recordUnexpectedDownload);
  await page.unroute('**/api/sessions/pi/*/artifact/*');
  assert(oversizedArtifactRequests > 0,
    'browser over-limit response did not exercise the artifact route');
  assert.equal(oversizedArtifactDownloaded, false,
    'advertised over-limit artifact reached the browser download path');
  await waitForArtifact(page);

  // First fetch fails transiently, leaving the localized action and details
  // affordance in place. The second click uses the real broker reference and
  // must produce the exact bytes through the browser's native download path.
  let rejectArtifactOnce = true;
  await page.route('**/api/sessions/pi/*/artifact/*', async (route) => {
    if (rejectArtifactOnce) {
      rejectArtifactOnce = false;
      await route.fulfill({ status: 503, body: 'transient fixture failure' });
      return;
    }
    await route.continue();
  });
  const downloadButton = page.getByRole('button', {
    name: 'Download',
    exact: true,
  });
  await downloadButton.click();
  await page.waitForTimeout(1_000);
  assert.equal(rejectArtifactOnce, false, 'transient artifact route was not exercised');
  assert.equal(await downloadButton.count(), 1, 'transient failure removed the Chat download action');
  const visibleFailureText = await page.locator('body').innerText();
  assert(!visibleFailureText.includes('transient fixture failure'),
    'technical transport detail leaked outside the details affordance');
  assert(!visibleFailureText.includes('sig='), 'signed artifact credential leaked into visible error text');
  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
  await downloadButton.click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  assert(downloadedPath, 'browser download did not expose a completed path');
  assert.deepEqual(readFileSync(downloadedPath), reportBytes, 'browser downloaded the wrong artifact bytes');
  assert.equal(download.suggestedFilename(), 'report.txt');
  await page.waitForTimeout(300);
  await page.unroute('**/api/sessions/pi/*/artifact/*');

  await page.screenshot({
    path: join(OUTPUT, 'artifact-card-light.png'),
    fullPage: true,
  });

  // Reload once more after the transfer. The transcript and durable transfer
  // ledger must both survive; this is the production browser-cache boundary.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForFlutter(page);
  await waitForArtifact(page);
  await openView(page, 'Files');
  await page.waitForTimeout(500);
  await openView(page, 'Chat');

  // Flutter web is intentionally same-origin: the broker does not grant CORS
  // to another broker's app. Switch through broker B's real /cosy/ mount, as a
  // web user does. Broker B has the identical Pi id but no artifact; the old
  // transcript/card must not cross the physical broker origin.
  await openRosterSession(page, brokerB.origin, 'Artifact owner');
  await page.waitForTimeout(750);
  assert.equal(await page.locator('[role]').filter({ hasText: 'report.txt' }).count(), 0,
    'broker B displayed broker A transcript artifact');
  assert.equal(await page.getByRole('button', { name: 'Download', exact: true }).count(), 0,
    'broker B exposed broker A download action');

  // Fresh dark profile selects same-origin broker A. Capture the same real
  // actionable card in the second supported brightness.
  const darkProfile = mkdtempSync(join(root, 'dark-profile-'));
  darkContext = await newBrowserContext(darkProfile, 'dark');
  const darkPage = darkContext.pages()[0] ?? await darkContext.newPage();
  await openRosterSession(darkPage, brokerA.origin, 'Artifact owner');
  await waitForArtifact(darkPage);
  await darkPage.screenshot({
    path: join(OUTPUT, 'artifact-card-dark.png'),
    fullPage: true,
  });

  const materialErrors = browserErrors.filter((message) =>
    !/favicon|Failed to load resource.*503/i.test(message)
  );
  assert.deepEqual(materialErrors, [], `browser errors: ${materialErrors.join(' | ')}`);
  console.log('PASS real Flutter-web artifact ownership, cache, retry, download, reload, and broker switch');
  console.log(`EVIDENCE ${join(OUTPUT, 'artifact-card-light.png')}`);
  console.log(`EVIDENCE ${join(OUTPUT, 'artifact-card-dark.png')}`);
} finally {
  await lightContext?.close();
  await darkContext?.close();
  await stopBroker(brokerA);
  await stopBroker(brokerB);
  await leaseA.release().catch(() => undefined);
  await leaseB.release().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
