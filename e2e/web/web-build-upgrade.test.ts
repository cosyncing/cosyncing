/**
 * Shipping a new web build to people who have the app open.
 *
 * A broker serves the built client; a proxy in front of it serves a "new
 * build" (the same worker stamped with a different version) on demand. Real
 * tabs, a real service worker and real caches show what a user gets: an open
 * tab that declines to move keeps its build whole, and willing tabs move
 * themselves to the new build and return to their exact routes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright-core';
import { type Broker } from '../harness/index.ts';
import { SHELL_GONE, launchBrowser, waitUntil } from '../harness/browser.ts';
import { settledEvaluate, startWebBroker, webScenario } from '../harness/web-scenario.ts';

const BUILD_VERSION = /const BUILD_VERSION = '([^']+)'/;

async function readCurrentVersion(broker: Broker): Promise<string> {
  const source = await (await fetch(`${broker.url}/cosy/sw.js`)).text();
  return BUILD_VERSION.exec(source)![1]!;
}

async function openApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(SHELL_GONE, undefined, { timeout: 90_000 });
  await page.waitForFunction(`navigator.serviceWorker.controller !== null`, undefined, { timeout: 60_000 });
}

/** Ask the page's controlling worker something over a MessageChannel. */
const askWorker = (type: string): string => `new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => resolve(event.data);
  navigator.serviceWorker.controller.postMessage({ type: ${JSON.stringify(type)} }, [channel.port2]);
})`;

const controllerIs = (version: string): string => `(async () => {
  const worker = navigator.serviceWorker.controller;
  if (!worker) return false;
  const identity = await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    worker.postMessage({ type: 'cosyncing-build-identity' }, [channel.port2]);
  });
  return identity ? identity.version === ${JSON.stringify(version)} : false;
})()`;

describe('web build upgrade', () => {
  let broker: Broker;
  let browser: Browser;
  beforeAll(async () => {
    broker = await startWebBroker({ name: 'web-upgrade' });
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    await broker?.stop();
  });

  test.concurrent('a tab that declines the move keeps its build whole; the new build arrives on the next visit and the old cache goes', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page }) => {
      const current = await readCurrentVersion(broker);
      const oldCache = `cosyncing-app:/cosy/:${current}`;
      const newCache = 'cosyncing-app:/cosy/:newversion000001';
      await openApp(page, proxy.base);
      // The tab is mid-edit: it refuses, through the app's own handoff hook.
      await page.evaluate(`(window.cosyncingHandoffPrepare = () => Promise.resolve(false), true)`);
      const before = await page.evaluate(`caches.keys()`) as string[];
      expect(before).toContain(oldCache);

      // Deploy: a new worker, and different bytes behind an unversioned
      // runtime URL this page has not needed yet.
      proxy.replace('sw.js', (body) => body.replace(current, 'newversion000001'));
      const manifest = await (await fetch(`${broker.url}/cosy/cosyncing-cache-manifest.json`)).json() as { runtime: string[] };
      const cachedUrls = await page.evaluate(
        `caches.open(${JSON.stringify(oldCache)}).then((c) => c.keys()).then((ks) => ks.map((k) => k.url))`) as string[];
      const skewTarget = manifest.runtime.find((path) => !cachedUrls.includes(proxy.base + path));
      expect(skewTarget).toBeDefined();
      proxy.replace(skewTarget!, () => 'bytes from a different build');
      const skew = await page.evaluate(
        `fetch(${JSON.stringify(skewTarget)}).then((r) => r.text().then((body) => ({ status: r.status, body })))`,
      ) as { status: number; body: string };
      proxy.restore(skewTarget!);
      expect(skew.status).toBe(503);
      expect(skew.body).not.toContain('different build');

      await page.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r && r.update())`);
      await waitUntil(page, `caches.keys().then((names) => names.includes(${JSON.stringify(newCache)}))`, { timeoutMs: 60_000 });
      // The page records the exact moment its handoff hook refuses.
      await page.waitForFunction(`Array.isArray(window.cosyncingHandoffDiagnostics)
        && window.cosyncingHandoffDiagnostics.some((entry) => entry.k === 'round' && entry.d === 'coordinator-busy')`,
        undefined, { timeout: 60_000 });

      const open = await page.evaluate(`(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const bundle = await (await caches.open(${JSON.stringify(oldCache)})).match(new URL('main.dart.js', location.href).href);
        return {
          waiting: !!registration.waiting,
          pathname: location.pathname,
          updateReady: window.cosyncingWebUpdateReady === true,
          handoffFailed: window.cosyncingWebUpdateHandoffFailed === true,
          hasReloadAction: typeof window.cosyncingApplyWebUpdate === 'function',
          names: await caches.keys(),
          oldBundleCached: !!bundle,
        };
      })()`) as any;
      expect(open.waiting).toBe(true);
      expect(open.pathname).toBe('/cosy/');
      expect(open.updateReady && !open.handoffFailed && !open.hasReloadAction).toBe(true);
      expect(open.names).toContain(oldCache);
      expect(open.oldBundleCached).toBe(true);

      await page.close();
      const next = await context.newPage();
      await next.goto(proxy.base);
      await next.waitForFunction(SHELL_GONE, undefined, { timeout: 90_000 });
      await waitUntil(next, `caches.keys().then((names) => names.includes(${JSON.stringify(newCache)}))`, { timeoutMs: 60_000 });
      await waitUntil(next, `caches.keys().then((names) => !names.includes(${JSON.stringify(oldCache)}))`, { timeoutMs: 60_000 });
      const after = await next.evaluate(`caches.keys()`) as string[];
      expect(after.filter((name) => name.startsWith('cosyncing-app:'))).toHaveLength(1);
    });
  });

  test.concurrent('two willing tabs (root and deep link) move to the new build on their own and come back to their exact routes', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page: first }) => {
      const current = await readCurrentVersion(broker);
      const next = 'handoffversion01';
      await openApp(first, proxy.base);
      const second = await context.newPage();
      await openApp(second, `${proxy.base}#/settings`);
      await first.waitForFunction(`location.hash.length > 1`);
      await second.waitForFunction(`location.hash === '#/settings'`);

      // Both tabs hold durable state and agree to be moved.
      const install = `(window.cosyncingHandoffPrepare = () => Promise.resolve(true), true)`;
      await first.evaluate(install);
      await second.evaluate(install);
      const routes = [await first.evaluate(`location.href`) as string, await second.evaluate(`location.href`) as string];
      const history = [await first.evaluate(`history.length`) as number, await second.evaluate(`history.length`) as number];
      const census = await first.evaluate(askWorker('cosyncing-client-census')) as { windows: number };
      const identity = await first.evaluate(askWorker('cosyncing-build-identity')) as { version: string; cacheName: string };
      expect(census.windows).toBe(2);
      expect(identity.version).toBe(current);
      expect(identity.cacheName).toBe(`cosyncing-app:/cosy/:${current}`);

      proxy.replace('sw.js', (body) => body.replace(current, next));
      const handoffsBefore = proxy.requestCount('/cosy-handoff');
      await first.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r && r.update())`);

      // Nobody is asked to close or reload anything: both tabs end up under the new controller.
      await Promise.all([first, second].map((tab) =>
        waitUntil(tab, controllerIs(next), { timeoutMs: 110_000 })));

      expect(proxy.requestCount('/cosy-handoff') - handoffsBefore).toBeGreaterThanOrEqual(2);
      const surfaces = [];
      for (const tab of [first, second]) {
        surfaces.push(await settledEvaluate(tab, `({
          href: location.href,
          failed: window.cosyncingWebUpdateHandoffFailed === true,
          history: history.length,
        })`) as { href: string; failed: boolean; history: number });
      }
      expect(surfaces[0]!.href).toBe(routes[0]!);
      expect(surfaces[1]!.href).toBe(routes[1]!);
      expect(surfaces.some((surface) => surface.failed)).toBe(false);
      // Both legs replace history entries: no handoff URL to go Back onto, no duplicate app entry.
      expect([surfaces[0]!.history, surfaces[1]!.history]).toEqual(history);

      const after = await settledEvaluate(first, askWorker('cosyncing-build-identity') as any) as { version: string; cacheName: string };
      expect(after.cacheName).toBe(`cosyncing-app:/cosy/:${next}`);
      const caches = await settledEvaluate(first, `caches.keys()` as any) as string[];
      expect(caches).not.toContain(`cosyncing-app:/cosy/:${current}`);
      expect(caches.filter((name) => name.startsWith('cosyncing-app:'))).toHaveLength(1);

      // Both legs replaced the entry, so Back has no handoff page to land on: the tabs'
      // navigation history, as the browser itself reports it, never names it.
      for (const tab of [first, second]) {
        const session = await context.newCDPSession(tab);
        const { entries } = await session.send('Page.getNavigationHistory');
        expect(entries.filter((entry) => entry.url.includes('/cosy-handoff'))).toEqual([]);
        await session.detach();
      }
    });
  });
});
