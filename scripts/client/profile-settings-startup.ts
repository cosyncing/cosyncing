#!/usr/bin/env bun
/** Optional diagnostic CPU profiles, not acceptance timings or a CI task.
 * Run from the root after building the two release web clients. Uses isolated
 * fixture brokers and the existing browser launcher; no production state.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { startBroker } from '../../e2e/harness/broker.ts';
import { launchBrowser, newScenarioContext, waitForFlutter, waitUntil } from '../../e2e/harness/browser.ts';

const option = (name: string, fallback = '') => {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? fallback : (Bun.argv[index + 1] ?? fallback);
};
const out = resolve(option('--out', 'output/review/settings-storage-routes/startup-profile'));
if (!option('--baseline-source') || !option('--baseline-web') || !option('--candidate-web')) {
  throw new Error('Provide --baseline-source, --baseline-web and --candidate-web');
}
const storageRounds = Number(option('--storage-rounds', '1'));
if (!Number.isInteger(storageRounds) || storageRounds < 1 || storageRounds > 100) {
  throw new Error('--storage-rounds must be 1..100');
}
mkdirSync(out, { recursive: true });
const browser = await launchBrowser();
const measurements: unknown[] = [];

async function profile(page: Page, name: string, phase: string, action: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    const began = performance.now();
    await action();
    const elapsedMs = performance.now() - began;
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(join(out, `${name}-${phase}.cpuprofile`), JSON.stringify(profile));
    measurements.push({
      name, phase, elapsedMs,
      page: await page.evaluate(() => ({
        refreshReadyMs: (window as Window & { reviewRefreshReadyMs?: number }).reviewRefreshReadyMs,
        databaseCalls: (window as Window & { reviewDatabaseCalls?: unknown[] }).reviewDatabaseCalls,
        resources: performance.getEntriesByType('resource').map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            path: new URL(entry.name).pathname,
            startTime: entry.startTime,
            duration: entry.duration,
            transferSize: resource.transferSize,
            decodedBodySize: resource.decodedBodySize,
          };
        }),
      })),
    });
  } finally {
    await cdp.detach();
  }
}

try {
  for (const name of ['baseline', 'candidate']) {
    const runtime = resolve(option(`--${name}-runtime`, process.execPath));
    const source = resolve(option(`--${name}-source`, '.'));
    const web = resolve(option(`--${name}-web`));
    const broker = await startBroker({
      name: `startup-profile-${name}`,
      sourceDirectory: source,
      env: { COSYNCING_WEB_DIR: web },
      setup: (paths) => symlinkSync(runtime, join(paths.bin, 'bun')),
    });
    try {
      const context = await newScenarioContext(browser, {
        viewport: { width: 1440, height: 1000 },
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        await page.addInitScript(() => {
          const observer = new MutationObserver(() => {
            const refresh = [...document.querySelectorAll('[role="button"]')].find((button) =>
              (button.getAttribute('aria-label') || button.textContent)?.trim() === 'Refresh');
            if (!refresh) return;
            (window as Window & { reviewRefreshReadyMs?: number }).reviewRefreshReadyMs = performance.now();
            observer.disconnect();
          });
          observer.observe(document, { childList: true, subtree: true, attributes: true });
          // Drift web serialization uses [tag, {i, p}], with a legacy
          // [tag, id, payload] variant. Retain
          // statement templates and round-trip timing only, never arguments or
          // returned rows. This hook is diagnostic and never used for timing
          // acceptance. Independent ports may reuse the same request ids.
          const calls: { tag: number; statement?: string; sentAt: number; repliedAt?: number }[] = [];
          (window as Window & { reviewDatabaseCalls?: unknown[] }).reviewDatabaseCalls = calls;
          const pending = new WeakMap<MessagePort, Map<number, typeof calls[number]>>();
          const original = MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
            const message = args[0];
            const requestId = Array.isArray(message) && message[0] === 0
              ? (typeof message[1] === 'number' ? message[1] : message[1]?.i) : undefined;
            const payload = Array.isArray(message)
              ? (typeof message[1] === 'number' ? message[2] : message[1]?.p) : undefined;
            if (typeof requestId === 'number' && Array.isArray(payload) && calls.length < 1000) {
              let requests = pending.get(this);
              if (!requests) {
                requests = new Map();
                pending.set(this, requests);
                this.addEventListener('message', (event: MessageEvent) => {
                  const response = event.data;
                  if (!Array.isArray(response) || ![1, 2, 3, 4].includes(response[0])) return;
                  const responseId = typeof response[1] === 'number' ? response[1]
                    : Array.isArray(response[1]) ? response[1][0] : response[1]?.i;
                  const call = requests!.get(responseId);
                  if (!call) return;
                  call.repliedAt = performance.now();
                  requests!.delete(responseId);
                });
              }
              const call: typeof calls[number] = { tag: payload[0], sentAt: performance.now() };
              if (payload[0] === 3 && typeof payload[2] === 'string') {
                call.statement = payload[2].replace(/\s+/g, ' ').slice(0, 240);
              } else if (payload[0] === 4 && Array.isArray(payload[1])) {
                call.statement = `Batch of ${payload[1].length} statements`;
              }
              calls.push(call);
              requests.set(requestId, call);
            }
            return Reflect.apply(original, this, args);
          };
        });
        const ready = async () => {
          await waitForFlutter(page);
          await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
        };
        await profile(page, name, 'cold', async () => {
          await page.goto(`${broker.url}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
          await ready();
        });
        await waitUntil(page,
          "(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')()",
          { what: 'static worker installation' });
        await profile(page, name, 'warm', async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await ready();
        });
        await page.evaluate(() => { location.hash = '#/settings/general'; });
        await page.getByRole('button', { name: /Read-aloud speed/ }).waitFor();
        for (let round = 0; round < storageRounds; round++) {
          if (round > 0) {
            await page.evaluate(() => { location.hash = '#/settings/general'; });
            await page.getByRole('button', { name: /Read-aloud speed/ }).waitFor();
          }
          await profile(page, name, storageRounds === 1 ? 'storage' : `storage-${round}`, async () => {
            await page.evaluate(() => { location.hash = '#/settings/general/storage'; });
            await page.getByText('App data', { exact: false }).waitFor();
          });
        }
        measurements.push({ name, source, web, runtime });
      } finally {
        await context.close();
      }
    } finally {
      await broker.stop();
    }
  }
} finally {
  writeFileSync(join(out, 'measurements.json'), JSON.stringify({
    measuredAt: new Date().toISOString(),
    measurements,
    limits: [
      'One instrumented startup run and optional repeated Storage entries per build; not performance acceptance.',
      'CPU profiles cover the page main thread, not the database worker or GPU.',
      'Database timings observe the pinned Drift message protocol; no query arguments or response rows are retained.',
      'Storage uses a fresh fixture without session content.',
    ],
  }, null, 2));
  await browser.close();
}
