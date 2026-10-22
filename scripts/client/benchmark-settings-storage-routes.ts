#!/usr/bin/env bun
/**
 * Optional review benchmark; never a timing assertion or a routine CI task.
 * Run from the repository root after building both web clients:
 * bun run scripts/client/benchmark-settings-storage-routes.ts --baseline-web <build/web>
 *   --candidate-web <build/web> --rounds 20 --out output/review/settings-storage-routes/performance/browser.json
 *
 * Uses identical isolated brokers and alternates builds to reduce order bias.
 * Measures visible transcript/tab readiness, including browser-driver latency.
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { startBroker, type Broker } from '../../e2e/harness/broker.ts';
import { PiBridgeSession } from '../../e2e/harness/fakes/pi-bridge-driver.ts';
import {
  fillFlutterTextField,
  launchBrowser,
  newScenarioContext,
  waitForFlutter,
  waitUntil,
} from '../../e2e/harness/browser.ts';

const option = (name: string, fallback: string): string => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? fallback : (Bun.argv[i + 1] ?? fallback);
};
const baseline = option('--baseline-web', '');
if (!baseline) throw new Error('--baseline-web is required');
const candidate = option('--candidate-web', 'apps/client/build/web');
const smoke = Bun.argv.includes('--smoke');
const rounds = Number(option('--rounds', smoke ? '1' : '20'));
if (!Number.isInteger(rounds) || rounds < (smoke ? 1 : 3) || rounds > 100)
  throw new Error('--rounds must be 3..100');
const startupRounds = smoke ? 0 : Number(option('--startup-rounds', String(rounds)));
if (!Number.isInteger(startupRounds) || (!smoke && startupRounds < 3) || startupRounds > 100)
  throw new Error('--startup-rounds must be 3..100');
const out = resolve(
  option(
    '--out',
    'output/review/settings-storage-routes/performance/browser.json'
  )
);
const runtimes = Object.fromEntries(['baseline', 'candidate'].map((name) => {
  const path = resolve(option(`--${name}-runtime`, process.execPath));
  const result = Bun.spawnSync([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`Cannot identify ${name} runtime`);
  return [name, { path, version: result.stdout.toString().trim() }];
}));

async function startBenchmarkBroker(name: string, directory: string, prefix: string) {
  const runtime = runtimes[name]!;
  const broker = await startBroker({
    name: `${prefix}-${name}`,
    sourceDirectory: resolve(option(`--${name}-source`, '.')),
    env: { COSYNCING_WEB_DIR: resolve(directory) },
    setup: (paths) => symlinkSync(runtime.path, join(paths.bin, 'bun')),
  });
  if (process.platform === 'linux' &&
      realpathSync(`/proc/${broker.pid}/exe`) !== realpathSync(runtime.path)) {
    await broker.stop();
    throw new Error(`${name} broker did not use its selected runtime`);
  }
  return broker;
}

const tab = (page: Page, title: string) =>
  page.locator(`[role="group"][aria-label="${title}"]`).first();

async function openRosterSession(page: Page, title: string) {
  // Heartbeats can reorder the roster under a previously hovered label. Its
  // tooltip then covers a neighbouring row's center. Click the row's leading
  // padding, retaining real pointer/actionability checks and transcript waits.
  await page.getByRole('button', { name: title, exact: false }).first()
    .click({ position: { x: 8, y: 8 } });
}

// Record readiness in the page itself. Driver selector waits can observe a
// completed frame later than it appeared, especially during cold startup.
async function observeStartup(page: Page) {
  await page.addInitScript(() => {
    const state = window as Window & { reviewRefreshReadyMs?: number };
    const observer = new MutationObserver(() => {
      const refresh = [...document.querySelectorAll('[role="button"]')].find((button) =>
        (button.getAttribute('aria-label') || button.textContent)?.trim() === 'Refresh');
      if (!refresh) return;
      state.reviewRefreshReadyMs = performance.now();
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true });
  });
}

async function observedStartup(page: Page) {
  const value = await page.evaluate(() =>
    (window as Window & { reviewRefreshReadyMs?: number }).reviewRefreshReadyMs);
  if (value == null) throw new Error('Startup readiness observer did not see Refresh');
  return value;
}

/** Observe the destination's semantic content in-page, avoiding selector-poll
 * delays in the reported ready time. The driver still verifies its own locator. */
async function navigateAndObserve(page: Page, hash: string, marker: string, button = false) {
  return page.evaluate(({ hash, marker, button }) => new Promise<number>((resolve, reject) => {
    const began = performance.now();
    const observer = new MutationObserver(inspect);
    const timeout = setTimeout(() => {
      observer.disconnect(); reject(new Error(`Navigation did not expose ${marker}`));
    }, 30_000);
    function inspect() {
      const elements = document.querySelectorAll(button ? '[role="button"]' : 'flt-semantics, span');
      for (const element of elements) {
        const label = (element.getAttribute('aria-label') || element.textContent)?.trim() || '';
        // Flutter can merge a section heading and its description into one
        // semantic label. Match the same visible text as the driver locator.
        if (!label.includes(marker)) continue;
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        observer.disconnect(); clearTimeout(timeout); resolve(performance.now() - began); return;
      }
    }
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    location.hash = hash;
  }), { hash, marker, button });
}

interface Run {
  name: string;
  broker: Broker;
  context: BrowserContext;
  page: Page;
  drivers: PiBridgeSession[];
  startupMs: number;
  startupReadyMs: number;
  sequence: number;
  mediaRequests: string[];
  draftListeners: Set<(text: string) => void>;
  samples: {
    openMs: number;
    closeMs: number;
    generalMs: number;
    storageMs: number;
    generalReadyMs: number;
    storageReadyMs: number;
    typingMs: number;
    streamMs: number;
    visibility: string;
    order?: number;
  }[];
  bytes: { mainJs: number; precache: number; runtime: number };
}

async function setup(
  browser: Browser,
  name: string,
  directory: string
): Promise<Run> {
  const broker = await startBenchmarkBroker(name, directory, 'preview-perf');
  const context = await newScenarioContext(browser, {
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  try {
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    page.setDefaultTimeout(30_000);
    await observeStartup(page);
    const mediaRequests: string[] = [];
    const draftListeners = new Set<(text: string) => void>();
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.kind === 'draft' && typeof frame.text === 'string') {
          for (const listener of [...draftListeners]) listener(frame.text);
        }
      })
    );
    page.on('request', (request) => {
      if (
        /\/api\/media-preview|\/assets\/packages\/pdfrx\//.test(request.url())
      )
        mediaRequests.push(request.url());
    });
    await page.addInitScript(() => {
      const state = window as Window & { reviewLongTasks?: number[] };
      state.reviewLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          state.reviewLongTasks!.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    const started = performance.now();
    await page.goto(`${broker.url}/cosy/#/sessions`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForFlutter(page);
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    const startupMs = performance.now() - started;
    const startupReadyMs = await observedStartup(page);
    // Start the fake agents after cold boot: history backfill starts the broker's
    // liveness clock, and a slow browser boot must not expire the fixture agents.
    const drivers: PiBridgeSession[] = [];
    for (const title of [
      'Preview benchmark anchor',
      'Preview benchmark target',
    ]) {
      const sessionFile = join(broker.paths.root, `${title}.jsonl`);
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ type: 'session', id: title, cwd })}\n`
      );
      drivers.push(
        await PiBridgeSession.open(broker.client(), {
          cwd,
          title,
          sessionFile,
          hello: {
            history: [
              { t: 'user', key: title, text: `${title} transcript ready` },
            ],
          },
        })
      );
    }
    // Projects start collapsed. With only two fixtures, expand their project
    // directly; search focus can be replaced as the first live roster arrives.
    const project = page.getByRole('button', {
      name: 'workspace',
      exact: true,
    });
    await project.waitFor();
    if ((await project.getAttribute('aria-expanded')) !== 'true')
      await project.click();
    await openRosterSession(page, 'Preview benchmark anchor');
    await page
      .getByText('Preview benchmark anchor transcript ready', { exact: true })
      .first()
      .waitFor();
    // Wait on installation completion, not a wall-clock delay.
    await waitUntil(
      page,
      "(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')()",
      { what: 'static worker installation' }
    );
    const manifest = JSON.parse(
      readFileSync(join(directory, 'cosyncing-cache-manifest.json'), 'utf8')
    );
    return {
      name,
      broker,
      context,
      page,
      drivers,
      startupMs,
      startupReadyMs,
      sequence: 0,
      mediaRequests,
      draftListeners,
      samples: [],
      bytes: {
        mainJs: readFileSync(join(directory, 'main.dart.js')).length,
        precache: manifest.precacheBytes,
        runtime: manifest.runtimeBytes,
      },
    };
  } catch (error) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      `${out}.${name}.failure.txt`,
      `${String(error)}\n${await page
        .locator('body')
        .ariaSnapshot()
        .catch(() => 'No page semantics')}`
    );
    await context.close();
    await broker.stop();
    throw error;
  }
}

async function publishDraft<T>(
  run: Run,
  expected: string,
  edit: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onDraft: ((text: string) => void) | undefined;
  const published = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The edited draft did not reach the broker: ${run.name}, round ${run.sequence}, expected ${JSON.stringify(expected)}`
          )
        ),
      15_000
    );
    onDraft = (text: string) => {
      if (text === expected) resolve();
    };
    run.draftListeners.add(onDraft);
  });
  try {
    // Install both rejection handlers before dispatch. A failed browser edit
    // cannot leave a rejected receipt promise or timer behind.
    const [value] = await Promise.all([edit(), published]);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
    if (onDraft) run.draftListeners.delete(onDraft);
  }
}

async function sample(run: Run): Promise<Run['samples'][number]> {
  const { page } = run;
  const sequence = ++run.sequence;
  await page.bringToFront();
  await page.mouse.move(1400, 24);
  const visibility = await page.evaluate(() => document.visibilityState);
  if (visibility !== 'visible')
    throw new Error('Benchmark page is not visible');
  // A real bridge sends heartbeats. Keep the fakes live before timing UI work,
  // without a timer competing with either build's navigation measurements.
  for (const driver of run.drivers)
    await driver.events({ t: 'status', running: false });
  await run.drivers[0]!.rehello({
    history: [
      {
        t: 'user',
        key: run.drivers[0]!.title,
        text: 'Preview benchmark anchor transcript ready',
      },
    ],
  });
  await page
    .getByText('Preview benchmark anchor transcript ready', { exact: true })
    .first()
    .waitFor();
  const began = performance.now();
  await openRosterSession(page, 'Preview benchmark target');
  await page
    .getByText('Preview benchmark target transcript ready', { exact: true })
    .first()
    .waitFor();
  const opened = performance.now();
  await tab(page, 'Preview benchmark target')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await tab(page, 'Preview benchmark target').waitFor({ state: 'detached' });
  await page
    .getByText('Preview benchmark anchor transcript ready', { exact: true })
    .first()
    .waitFor();
  const closed = performance.now();
  const editor = page.locator('textarea[data-semantics-role="text-field"]');
  const draft = `Benchmark draft ${sequence}`;
  await page.getByRole('button', { name: /^Session status: Synced/ }).waitFor();
  const typingStart = performance.now();
  const typingMs = await publishDraft(run, draft, async () => {
    await fillFlutterTextField(page, 'Send a prompt', draft);
    await editor.evaluate((element, text) => {
      if ((element as HTMLInputElement).value !== text)
        throw new Error('Draft input did not update');
    }, draft);
    // The shared-draft receipt is awaited outside this input latency interval.
    return performance.now() - typingStart;
  });
  const marker = `Stream measurement ${run.name} ${sequence}`;
  const streamStart = performance.now();
  await run.drivers[0]!.events(
    { t: 'status', running: true },
    { t: 'delta', key: `stream-measurement-${sequence}`, delta: marker },
    { t: 'final', key: `stream-measurement-${sequence}`, text: marker },
    { t: 'status', running: false }
  );
  await page.getByText(marker, { exact: true }).first().waitFor();
  const streamMs = performance.now() - streamStart;
  const generalStart = performance.now();
  const generalReadyMs = await navigateAndObserve(
    page, '#/settings/general', 'Read-aloud speed', true,
  );
  await page.getByRole('button', { name: /Read-aloud speed/ }).waitFor();
  const generalMs = performance.now() - generalStart;
  const storageStart = performance.now();
  const storageReadyMs = await navigateAndObserve(
    page, '#/settings/general/storage', 'App data',
  );
  await page.getByText('App data', { exact: false }).waitFor();
  const storageMs = performance.now() - storageStart;
  await page.evaluate((id) => {
    location.hash = `#/sessions/pi/${encodeURIComponent(id)}`;
  }, run.drivers[0]!.id);
  await editor.waitFor();
  await editor.click();
  // The retained composer appears before its saved draft and live session have
  // finished restoring. Editing earlier measures a bootstrap race instead of
  // typing, and the restored draft can overwrite the synthetic keystroke.
  await page.waitForFunction(
    (expected) =>
      (
        document.querySelector(
          'textarea[data-semantics-role="text-field"]'
        ) as HTMLTextAreaElement | null
      )?.value === expected,
    draft
  );
  await page.getByRole('button', { name: /^Session status: Synced/ }).waitFor();
  await publishDraft(run, '', () => fillFlutterTextField(page, 'Send a prompt', ''));
  return {
    openMs: opened - began,
    closeMs: closed - opened,
    generalMs,
    storageMs,
    generalReadyMs,
    storageReadyMs,
    typingMs,
    streamMs,
    visibility,
  };
}
const distribution = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const rounded = (value: number) => Math.round(value * 10) / 10;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  // Nearest-rank percentile: with 20 samples p95 is the 19th, not the maximum.
  return {
    medianMs: rounded(median),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    minMs: rounded(sorted[0]!),
    maxMs: rounded(sorted.at(-1)!),
  };
};

/** The cold sample uses fresh browser storage and includes first-run database
 * creation. Warm reload uses the same context and an activated static worker.
 * This does not measure a cold process with an existing app database. */
async function startupCampaign(browser: Browser) {
  if (smoke) return [];
  const fixtures: {
    name: string;
    broker: Broker;
    samples: { coldMs: number; warmMs: number; coldReadyMs: number; warmReadyMs: number; round: number; order: number }[];
  }[] = [];
  try {
    for (const [name, directory] of [
      ['baseline', baseline],
      ['candidate', candidate],
    ] as const) {
      fixtures.push({
        name,
        broker: await startBenchmarkBroker(name, directory, 'startup-perf'),
        samples: [],
      });
    }
    for (let round = 0; round < startupRounds; round++) {
      for (const [order, fixture] of (round % 2 ? [...fixtures].reverse() : fixtures).entries()) {
        const context = await newScenarioContext(browser, {
          viewport: { width: 1440, height: 1000 },
        });
        try {
          const page = await context.newPage();
          await observeStartup(page);
          await page.bringToFront();
          const ready = async () => {
            await waitForFlutter(page);
            await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
          };
          const cold = performance.now();
          await page.goto(`${fixture.broker.url}/cosy/#/sessions`, {
            waitUntil: 'domcontentloaded',
          });
          await ready();
          const coldMs = performance.now() - cold;
          const coldReadyMs = await observedStartup(page);
          await waitUntil(
            page,
            "(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')()",
            { what: 'startup static worker installation' },
          );
          const warm = performance.now();
          await page.reload({ waitUntil: 'domcontentloaded' });
          await ready();
          const warmMs = performance.now() - warm;
          const warmReadyMs = await observedStartup(page);
          fixture.samples.push({ coldMs, warmMs, coldReadyMs, warmReadyMs, round, order });
        } finally {
          await context.close();
        }
      }
    }
    return fixtures.map(({ name, samples }) => ({
      name,
      cold: distribution(samples.map((sample) => sample.coldMs)),
      warm: distribution(samples.map((sample) => sample.warmMs)),
      samples,
    }));
  } finally {
    for (const fixture of fixtures) await fixture.broker.stop();
  }
}

const browser = await launchBrowser();
const runs: Run[] = [];
try {
  const startup = await startupCampaign(browser);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.startup.json`, JSON.stringify({
    measuredAt: new Date().toISOString(),
    startupRounds,
    runtimes,
    startupWorkload: { cold: 'fresh browser storage, including first-run database creation',
      warm: 'reload with existing database and activated static worker' },
    browser: browser.version(),
    baseline: resolve(baseline),
    candidate: resolve(candidate),
    startup,
  }, null, 2));
  runs.push(await setup(browser, 'baseline', resolve(baseline)));
  runs.push(await setup(browser, 'candidate', resolve(candidate)));
  // The other build's cold boot may have crossed the first pair's lease.
  for (const run of runs) {
    for (const driver of run.drivers) {
      await driver.rehello({
        history: [
          {
            t: 'user',
            key: driver.title,
            text: `${driver.title} transcript ready`,
          },
        ],
      });
    }
  }
  for (const run of runs) await sample(run); // warm retained session state
  for (let i = 0; i < rounds; i++) {
    for (const [order, run] of (i % 2 ? [...runs].reverse() : runs).entries()) {
      run.samples.push({ ...(await sample(run)), order });
    }
  }
  const results = runs.map((run) => ({
    name: run.name,
    startupMs: run.startupMs,
    startupReadyMs: run.startupReadyMs,
    bytes: run.bytes,
    open: distribution(run.samples.map((s) => s.openMs)),
    close: distribution(run.samples.map((s) => s.closeMs)),
    general: distribution(run.samples.map((s) => s.generalMs)),
    storage: distribution(run.samples.map((s) => s.storageMs)),
    typing: distribution(run.samples.map((s) => s.typingMs)),
    stream: distribution(run.samples.map((s) => s.streamMs)),
    mediaRequestsWhileNavigating: run.mediaRequests.length,
    samples: run.samples,
  }));
  mkdirSync(dirname(out), { recursive: true });
  const longTasks = await Promise.all(
    runs.map(async (run) => ({
      name: run.name,
      durations: await run.page.evaluate(
        () =>
          (window as Window & { reviewLongTasks?: number[] }).reviewLongTasks
      ),
    }))
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        smoke,
        rounds,
        startupRounds,
        runtimes,
        startup,
        browser: browser.version(),
        viewport: { width: 1440, height: 1000 },
        baseline: resolve(baseline),
        candidate: resolve(candidate),
        results,
        longTasks,
        limitations: [
          ...(smoke ? ['Driver smoke only; not performance acceptance evidence.'] : []),
          'Cold startup includes first-use schema setup; warm startup reloads the same saved browser state.',
          'Driver latency is included.',
          'No native/mobile, energy, large inventory, background or proxy evidence.',
        ],
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify(
      { out, results: results.map(({ samples, ...result }) => result) },
      null,
      2
    )
  );
  if (runs.some((run) => run.mediaRequests.length !== 0))
    throw new Error('Session navigation unexpectedly loaded media');
} catch (error) {
  for (const run of runs) {
    writeFileSync(
      `${out}.${run.name}.failure.txt`,
      `${String(error)}\n${await run.page
        .locator('body')
        .ariaSnapshot()
        .catch(() => 'No semantics')}`
    );
    writeFileSync(
      `${out}.${run.name}.focus.json`,
      JSON.stringify(
        await run.page.evaluate(() => ({
          active: document.activeElement?.outerHTML,
          editors: Array.from(
            document.querySelectorAll('[role="textbox"],textarea,input')
          ).map((el) => ({
            html: el.outerHTML,
            value: (el as HTMLInputElement).value,
          })),
        })),
        null,
        2
      )
    );
  }
  throw error;
} finally {
  for (const run of runs) {
    await run.context.close().catch(() => undefined);
    await run.broker.stop();
  }
  await browser.close();
}
