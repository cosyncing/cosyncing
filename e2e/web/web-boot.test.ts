/**
 * What a user sees while the web app starts, and what the browser keeps.
 *
 * The built Flutter client is served by a real broker at `/cosy/` and driven
 * in Chromium. A thin proxy between the browser and the broker breaks the
 * network on demand (a bootstrap that never arrives, a 503, a poisoned cache
 * entry, no network at all); every byte still comes from the broker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright-core';
import { type Broker, eventually } from '../harness/index.ts';
import { SHELL_GONE, SHELL_STATE, launchBrowser, waitUntil } from '../harness/browser.ts';
import { startWebBroker, webScenario } from '../harness/web-scenario.ts';

const SHELL = `document.getElementById('cosyncing-startup-shell')`;
/** The failed state and its offer, read in one step: the page may reload between two reads. */
const failedOffer = (page: Page) => eventually(
  () => page.evaluate(`(${SHELL_STATE}) === 'failed' ? { label: ${SHELL}.querySelector('#cosyncing-startup-shell-retry')?.textContent ?? null, text: document.getElementById('cosyncing-startup-shell-status').textContent } : null`) as Promise<{ label: string | null; text: string } | null>,
  { timeoutMs: 60_000, what: 'the failed state' },
);
const waitForShell = (page: Page) => page.waitForFunction(`!!${SHELL}`);
const waitForHandover = (page: Page) => page.waitForFunction(SHELL_GONE, undefined, { timeout: 90_000 });
const waitForState = (page: Page, state: string) =>
  page.waitForFunction(`(${SHELL_STATE}) === ${JSON.stringify(state)}`, undefined, { timeout: 60_000 });
const cacheNames = (page: Page): Promise<string[]> => page.evaluate(`caches.keys()`) as Promise<string[]>;

/** The page is controlled by the app worker and its versioned cache exists. */
async function waitForWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(
    `navigator.serviceWorker.controller !== null`, undefined, { timeout: 60_000 });
  await waitUntil(page, `caches.keys().then((names) => names.some((n) => n.startsWith('cosyncing-app:')))`, { timeoutMs: 60_000 });
}

/**
 * Shorten the startup shell's clocks for this scenario only. The served
 * index.html changes, so the worker's recorded hash of it is rewritten to
 * match; both rewrites fail closed if the contract moves.
 */
async function acceleratedClock(
  broker: Broker,
  proxy: { replace(path: string, fn: (body: string) => string): void },
  slowMs: number,
  failMs: number,
): Promise<void> {
  const speed = (body: string): string => {
    const slow = 'var SLOW_MS = 8000;';
    const fail = 'var FAIL_MS = 25000;';
    if (!body.includes(slow) || !body.includes(fail)) throw new Error('startup clock contract moved');
    return body.replace(slow, `var SLOW_MS = ${slowMs};`).replace(fail, `var FAIL_MS = ${failMs};`);
  };
  const manifest = await (await fetch(`${broker.url}/cosy/cosyncing-cache-manifest.json`)).json() as { hashes: Record<string, string> };
  const index = await (await fetch(`${broker.url}/cosy/index.html`)).text();
  const accelerated = createHash('sha256').update(speed(index)).digest('hex');
  const production = `"index.html": "${manifest.hashes['index.html']}"`;
  proxy.replace('index.html', speed);
  proxy.replace('sw.js', (body) => {
    if (!body.includes(production)) throw new Error('service-worker index hash contract moved');
    return body.replace(production, `"index.html": "${accelerated}"`);
  });
}

describe('web startup', () => {
  let broker: Broker;
  let browser: Browser;
  beforeAll(async () => {
    broker = await startWebBroker({ name: 'web-boot' });
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    await broker?.stop();
  });

  for (const [scheme, canvas] of [['light', 'rgb(242, 245, 244)'], ['dark', 'rgb(11, 14, 20)']] as const) {
    test.concurrent(`${scheme}: the branded shell paints before Flutter, on the app canvas, then hands over without a white flash`, async () => {
      await webScenario(browser, broker, { colorScheme: scheme }, async ({ proxy, page }) => {
        const release = proxy.hold('flutter_bootstrap.js');
        await page.goto(proxy.base, { waitUntil: 'commit' });
        await waitForShell(page);
        const loading = await page.evaluate(`({
          state: ${SHELL}.dataset.state,
          background: getComputedStyle(document.documentElement).backgroundColor,
        })`) as { state: string; background: string };
        expect(loading.state).toBe('booting');
        expect(loading.background).toBe(canvas);

        // Sample the document background across the handover on every frame.
        await page.evaluate(`window.__samples = (async () => {
          const seen = [];
          for (;;) {
            const shell = ${SHELL};
            seen.push({
              shell: !!shell,
              dismissing: shell?.dataset.dismissing ?? null,
              background: getComputedStyle(document.documentElement).backgroundColor,
            });
            if (!shell) return seen;
            await new Promise((r) => requestAnimationFrame(r));
          }
        })(); true`);
        release();
        const samples = await page.evaluate(`window.__samples`) as Array<{ shell: boolean; dismissing: string | null; background: string }>;
        const backgrounds = new Set(samples.map((s) => s.background));
        expect(backgrounds.has('rgb(255, 255, 255)')).toBe(false);
        expect(backgrounds.has('rgba(0, 0, 0, 0)')).toBe(false);
        expect(samples.some((s) => s.dismissing === 'true')).toBe(true);
        expect(await page.evaluate(`!!document.querySelector('flt-glass-pane, flutter-view, flt-scene-host')`) as boolean).toBe(true);
      });
    });
  }

  test.concurrent('a late bootstrap keeps the shell up, says it is slow, and still hands over', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, page }) => {
      await acceleratedClock(broker, proxy, 300, 600_000);
      const release = proxy.hold('flutter_bootstrap.js');
      await page.goto(proxy.base, { waitUntil: 'commit' });
      await waitForState(page, 'slow');
      expect(await page.evaluate(`!!${SHELL}`) as boolean).toBe(true);
      release();
      await waitForHandover(page);
    });
  });

  test.concurrent('a bootstrap that fails to load ends in a plain, bounded failed state with a Retry', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, page, logs }) => {
      proxy.block('flutter_bootstrap.js');
      await page.goto(proxy.base);
      const { label, text } = await failedOffer(page);
      expect(label).toBe('Retry');
      expect(text).not.toMatch(/exception|stack|undefined|null/i);
      expect(logs.some((line) => line.includes('[cosyncing] startup shell:'))).toBe(true);
    });
  });

  test.concurrent('retrying is bounded: the last offer clears cached files, then the shell explains instead of looping', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, page }) => {
      proxy.block('flutter_bootstrap.js');
      await page.goto(proxy.base);
      const labels: Array<string | null> = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        // State and offer are read in one step: the page may reload between two reads.
        const { label } = await failedOffer(page);
        labels.push(label);
        if (label === null) break;
        const before = proxy.requestCount('/cosy/flutter_bootstrap.js');
        // Click after the evaluation returns: the retry reloads the document.
        await page.evaluate(`(setTimeout(() => document.getElementById('cosyncing-startup-shell-retry').click(), 0), true)`);
        // The retry reloads the app: its bootstrap is requested again.
        await eventually(() => proxy.requestCount('/cosy/flutter_bootstrap.js') > before, { what: 'retry reload' });
      }
      expect(labels.length).toBeGreaterThanOrEqual(3);
      expect(labels.at(-1)).toBeNull();
      expect(labels).toContain('Clear cached files and retry');
      const finalText = (await failedOffer(page)).text;
      expect(finalText).toMatch(/Reloading didn/);
    });
  });

  test.concurrent('first visit with nothing cached starts from the network and creates one versioned app cache', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, page }) => {
      await page.goto(proxy.base);
      await waitForShell(page);
      await waitForHandover(page);
      await waitForWorkerControl(page);
      expect((await cacheNames(page)).some((name) => name.startsWith('cosyncing-app:'))).toBe(true);
    });
  });

  test.concurrent('a repeat visit with no network starts Flutter from the cached app, and no broker route is cached', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page }) => {
      await page.goto(proxy.base);
      await waitForHandover(page);
      await waitForWorkerControl(page);
      // The worker fills its runtime set on first use and answers only after the
      // cache write, so a second visit under its control leaves everything it
      // needed cached.
      await page.reload();
      await waitForHandover(page);
      const cached = await page.evaluate(`(async () => {
        const name = (await caches.keys()).find((n) => n.startsWith('cosyncing-app:'));
        return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
      })()`) as string[];
      expect(cached.some((path) => path.endsWith('/main.dart.js'))).toBe(true);
      expect(cached.filter((path) => path.startsWith('/api/'))).toEqual([]);
      await page.close();

      proxy.goOffline();
      const offline = await context.newPage();
      await offline.goto(proxy.base);
      await waitForShell(offline);
      await waitForHandover(offline);
      expect(await offline.evaluate(`!!document.querySelector('flt-glass-pane, flutter-view, flt-scene-host')`) as boolean).toBe(true);
    });
  });

  test.concurrent('a poisoned cached bundle ends in the bounded failed state with a recovery action', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page }) => {
      await page.goto(proxy.base);
      await waitForHandover(page);
      await waitForWorkerControl(page);
      await page.evaluate(`(async () => {
        const name = (await caches.keys()).find((n) => n.startsWith('cosyncing-app:'));
        await (await caches.open(name)).put(
          new URL('main.dart.js', location.href).href,
          new Response('throw new Error("corrupt cached bundle");', { headers: { 'content-type': 'text/javascript' } }),
        );
      })()`);
      await page.close();

      // Only the poisoned visit runs on a short clock: a warm-up under load must not trip it.
      await acceleratedClock(broker, proxy, 300, 4000);
      const next = await context.newPage();
      await next.goto(proxy.base);
      expect((await failedOffer(next)).label).not.toBeNull();
    });
  });

  test.concurrent('recovery clears only this app: a neighbour app and another mount keep their worker and caches', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page }) => {
      const neighbour = await context.newPage();
      await neighbour.goto(`${proxy.origin}/other-app/`);
      await neighbour.evaluate(`navigator.serviceWorker.register('/other-app/sw.js', { scope: '/other-app/' })`);
      await waitUntil(neighbour, `navigator.serviceWorker.getRegistration('/other-app/').then((r) => !!r && !!r.active)`);
      await neighbour.close();

      await page.goto(proxy.base);
      await waitForHandover(page);
      await waitForWorkerControl(page);
      await page.evaluate(`caches.open('cosyncing-app:/staging/cosy/:othermount0001').then(() => true)`);
      const scopes = () => page.evaluate(`navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => r.scope))`) as Promise<string[]>;
      expect(await scopes()).toContain(`${proxy.origin}/other-app/`);

      // The shell's own recovery routine, as the last retry button runs it.
      await page.evaluate(`(async () => {
        const prefix = 'cosyncing-app:' + new URL('./', document.baseURI).pathname + ':';
        const scope = new URL('./', document.baseURI).href;
        await Promise.all((await caches.keys()).map((k) => (k.indexOf(prefix) === 0 ? caches.delete(k) : null)));
        await Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => (r.scope === scope ? r.unregister() : null)));
      })()`);

      const after = await scopes();
      expect(after).toContain(`${proxy.origin}/other-app/`);
      expect(after.some((scope) => scope.endsWith('/cosy/'))).toBe(false);
      const names = await cacheNames(page);
      expect(names).toContain('neighbour-app-cache');
      expect(names).toContain('cosyncing-app:/staging/cosy/:othermount0001');
      expect(names.some((name) => name.startsWith('cosyncing-app:/cosy/:'))).toBe(false);
    });
  });

  test.concurrent('under /cosy/: base href and worker scope are the mount, a deep link refreshes into the shell, and broker calls stay out of the static cache', async () => {
    await webScenario(browser, broker, {}, async ({ proxy, context, page }) => {
      await page.goto(proxy.base);
      await waitForHandover(page);
      await waitUntil(page, `navigator.serviceWorker.getRegistration().then((r) => !!r)`, { timeoutMs: 60_000 });
      expect(await page.evaluate(`document.querySelector('base').href`)).toEndWith('/cosy/');
      expect(await page.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.scope)`)).toEndWith('/cosy/');

      const deep = await context.newPage();
      await deep.goto(`${proxy.base}sessions/codex/example`);
      await waitForShell(deep);
      await deep.close();

      // The app talks to its broker at the origin root, outside the worker's scope.
      const outOfScope = () => [...new Set(proxy.requests.filter((path) => !path.startsWith('/cosy/')))];
      await eventually(() => outOfScope().length > 0, { what: 'a broker request outside /cosy/' });
      const cached = await page.evaluate(`(async () => {
        const paths = [];
        for (const name of await caches.keys()) {
          for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
        }
        return paths;
      })()`) as string[];
      expect(cached.filter((path) => !path.startsWith('/cosy/'))).toEqual([]);
      expect(cached.filter((path) => outOfScope().includes(path))).toEqual([]);
    });
  });
});
