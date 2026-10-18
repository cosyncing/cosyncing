#!/usr/bin/env bun
/**
 * Optional review benchmark; never a timing assertion or a routine CI task.
 * Run from the repository root after building both web clients:
 * bun run scripts/client/benchmark-file-previews.ts --baseline-web <build/web>
 *   --rounds 12 --out output/review/file-previews/navigation.json
 *
 * Uses identical isolated brokers and alternates builds to reduce order bias.
 * Measures visible transcript/tab readiness, including browser-driver latency.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { startBroker, type Broker } from '../../e2e/harness/broker.ts';
import { PiBridgeSession } from '../../e2e/harness/fakes/pi-bridge-driver.ts';
import { launchBrowser, newScenarioContext, waitForFlutter, waitUntil } from '../../e2e/harness/browser.ts';

const option = (name: string, fallback: string): string => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? fallback : Bun.argv[i + 1] ?? fallback;
};
const baseline = option('--baseline-web', '');
if (!baseline) throw new Error('--baseline-web is required');
const rounds = Number(option('--rounds', '12'));
if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) throw new Error('--rounds must be 3..100');
const out = resolve(option('--out', 'output/review/file-previews/navigation.json'));
const tab = (page: Page, title: string) => page.locator(`[role="group"][aria-label="${title}"]`).first();

interface Run {
  name: string;
  broker: Broker;
  context: BrowserContext;
  page: Page;
  drivers: PiBridgeSession[];
  startupMs: number;
  mediaRequests: string[];
  samples: { openMs: number; closeMs: number; visibility: string; order?: number }[];
  bytes: { mainJs: number; precache: number; runtime: number };
}

async function setup(browser: Browser, name: string, directory: string): Promise<Run> {
  const broker = await startBroker({ name: `preview-perf-${name}`, env: { COSYNCING_WEB_DIR: directory } });
  const context = await newScenarioContext(browser, { viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    page.setDefaultTimeout(30_000);
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/media-preview|\/assets\/packages\/pdfrx\//.test(request.url())) mediaRequests.push(request.url());
    });
    const started = performance.now();
    await page.goto(`${broker.url}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
    await waitForFlutter(page);
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    const startupMs = performance.now() - started;
    // Start the fake agents after cold boot: history backfill starts the broker's
    // liveness clock, and a slow browser boot must not expire the fixture agents.
    const drivers: PiBridgeSession[] = [];
    for (const title of ['Preview benchmark anchor', 'Preview benchmark target']) {
      const sessionFile = join(broker.paths.root, `${title}.jsonl`);
      writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: title, cwd })}\n`);
      drivers.push(await PiBridgeSession.open(broker.client(), {
        cwd, title, sessionFile,
        hello: { history: [{ t: 'user', key: title, text: `${title} transcript ready` }] },
      }));
    }
    // Projects start collapsed. With only two fixtures, expand their project
    // directly; search focus can be replaced as the first live roster arrives.
    const project = page.getByRole('button', { name: 'workspace', exact: true });
    await project.waitFor();
    if (await project.getAttribute('aria-expanded') !== 'true') await project.click();
    await page.getByRole('button', { name: 'Preview benchmark anchor', exact: false }).first().click();
    await page.getByText('Preview benchmark anchor transcript ready', { exact: true }).first().waitFor();
    // Wait on installation completion, not a wall-clock delay.
    await waitUntil(page,
      "(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')()",
      { what: 'static worker installation' });
    const manifest = JSON.parse(readFileSync(join(directory, 'cosyncing-cache-manifest.json'), 'utf8'));
    return { name, broker, context, page, drivers, startupMs, mediaRequests, samples: [], bytes: {
      mainJs: readFileSync(join(directory, 'main.dart.js')).length,
      precache: manifest.precacheBytes, runtime: manifest.runtimeBytes,
    } };
  } catch (error) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.${name}.failure.txt`, `${String(error)}\n${await page.locator('body').ariaSnapshot().catch(() => 'No page semantics')}`);
    await context.close();
    await broker.stop();
    throw error;
  }
}

async function sample(run: Run): Promise<Run['samples'][number]> {
  const { page } = run;
  await page.bringToFront();
  const visibility = await page.evaluate(() => document.visibilityState);
  if (visibility !== 'visible') throw new Error('Benchmark page is not visible');
  // A real bridge sends heartbeats. Keep the fakes live before timing UI work,
  // without a timer competing with either build's navigation measurements.
  for (const driver of run.drivers) await driver.events({ t: 'status', running: false });
  const began = performance.now();
  await page.getByRole('button', { name: 'Preview benchmark target', exact: false }).first().click();
  await page.getByText('Preview benchmark target transcript ready', { exact: true }).first().waitFor();
  const opened = performance.now();
  await tab(page, 'Preview benchmark target').getByRole('button', { name: 'Close', exact: true }).click();
  await tab(page, 'Preview benchmark target').waitFor({ state: 'detached' });
  await page.getByText('Preview benchmark anchor transcript ready', { exact: true }).first().waitFor();
  return { openMs: opened - began, closeMs: performance.now() - opened, visibility };
}
const distribution = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const rounded = (value: number) => Math.round(value * 10) / 10;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  // Nearest-rank percentile: with 20 samples p95 is the 19th, not the maximum.
  return {
    medianMs: rounded(median), p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    minMs: rounded(sorted[0]!), maxMs: rounded(sorted.at(-1)!),
  };
};

const browser = await launchBrowser();
const runs: Run[] = [];
try {
  runs.push(await setup(browser, 'baseline', resolve(baseline)));
  runs.push(await setup(browser, 'candidate', resolve('apps/client/build/web')));
  // The other build's cold boot may have crossed the first pair's lease.
  for (const run of runs) {
    for (const driver of run.drivers) {
      await driver.rehello({ history: [{ t: 'user', key: driver.title, text: `${driver.title} transcript ready` }] });
    }
  }
  for (const run of runs) await sample(run); // warm retained session state
  for (let i = 0; i < rounds; i++) {
    for (const [order, run] of (i % 2 ? [...runs].reverse() : runs).entries()) {
      run.samples.push({ ...await sample(run), order });
    }
  }
  const results = runs.map((run) => ({
    name: run.name, startupMs: run.startupMs, bytes: run.bytes,
    open: distribution(run.samples.map((s) => s.openMs)),
    close: distribution(run.samples.map((s) => s.closeMs)),
    mediaRequestsWhileNavigating: run.mediaRequests.length, samples: run.samples,
  }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), rounds, results }, null, 2));
  console.log(JSON.stringify({ out, results: results.map(({ samples, ...result }) => result) }, null, 2));
  if (runs.some((run) => run.mediaRequests.length !== 0)) throw new Error('Session navigation unexpectedly loaded media');
} finally {
  for (const run of runs) {
    await run.context.close().catch(() => undefined);
    await run.broker.stop();
  }
  await browser.close();
}
