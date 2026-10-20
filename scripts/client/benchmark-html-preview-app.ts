#!/usr/bin/env bun
/** Opt-in full Flutter app comparison, never a CI performance gate.
 * Run from the worktree root after preparing both release builds:
 * bun run scripts/client/benchmark-html-preview-app.ts --baseline output/baseline/apps/client/build/web --candidate apps/client/build/web --html /path/to/dashboard.html
 * Observation timers measure CPU, rather than synchronizing UI readiness.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { launchBrowser, newScenarioContext, waitForFlutter } from '../../e2e/harness/browser.ts';
import { eventually, startBroker, type Broker } from '../../e2e/harness/index.ts';
import { startFakeTokdash } from '../../e2e/harness/fakes/tokdash.ts';

const option = (name: string, fallback: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? fallback : Bun.argv[i + 1] ?? fallback; };
const builds = {
  baseline: resolve(option('--baseline', 'output/baseline/apps/client/build/web')),
  candidate: resolve(option('--candidate', 'apps/client/build/web')),
};
const input = resolve(option('--html', 'output/review/html-preview/fixtures/dashboard.html'));
const html = readFileSync(input, 'utf8');
const out = resolve(option('--out', 'output/review/html-preview-app'));
const rounds = Number(option('--rounds', '3'));
const sampleMs = Number(option('--sample-ms', '10000'));
const settleMs = 2000;
const gcDiagnostic = Bun.argv.includes('--gc-diagnostic');
const caseMode = option('--case-mode', '');
const caseRound = Number(option('--case-round', '1'));
if (caseMode && caseMode !== 'baseline' && caseMode !== 'candidate') throw Error('Invalid case mode');
if (!Number.isFinite(sampleMs) || sampleMs < 10000 || !Number.isInteger(rounds) || rounds < 1) throw Error('Use >=10-second windows and positive integer rounds');
mkdirSync(out, { recursive: true });
const rows: Record<string, unknown>[] = [];

async function bounded<T>(work: Promise<T>, label: string, timeoutMs = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function snapshot(cdp: CDPSession) {
  const { processInfo } = await bounded(cdp.send('SystemInfo.getProcessInfo'), 'browser process snapshot');
  let pssMiB = 0, readable = 0;
  for (const p of processInfo) {
    try { pssMiB += Number(readFileSync(`/proc/${p.id}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) / 1024; readable++; }
    catch { /* Report coverage explicitly. */ }
  }
  return { processInfo, pssMiB, readable };
}
async function observe(page: Page, cdp: CDPSession, during?: () => Promise<void>) {
  // Readiness is established by the scenario's document/UI conditions. This
  // unmeasured warm-up excludes transition/ink effects from the CPU window.
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const before = await snapshot(cdp), start = performance.now();
  await Promise.all([new Promise((resolve) => setTimeout(resolve, sampleMs)), during?.()]);
  const after = await snapshot(cdp), elapsedMs = performance.now() - start;
  const old = new Map(before.processInfo.map((p) => [p.id, p.cpuTime]));
  const cpuByProcess = after.processInfo.map(p => ({ type: p.type, id: p.id,
    cpuPercentOneCore: Math.max(0, p.cpuTime - (old.get(p.id) ?? p.cpuTime)) * 100000 / elapsedMs }));
  const cpuPercentOneCore = cpuByProcess.reduce((sum, p) => sum + p.cpuPercentOneCore, 0);
  return { elapsedMs, cpuPercentOneCore, cpuByProcess, pssMiB: after.pssMiB,
    memoryProcessesReadable: after.readable, processes: after.processInfo.length, childFrames: page.frames().length - 1 };
}
async function frames(page: Page) {
  await bounded(page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 'host animation frames');
}
async function rendered(page: Page, mode: 'baseline' | 'candidate') {
  if (mode === 'candidate') {
    await page.getByRole('button', { name: 'Rendered', exact: true }).click();
    return;
  }
  // The frozen baseline merges this control into the file header's semantics
  // after Source opens. At this fixed viewport/scale, click its visible center
  // relative to the adjacent Wrap control. Do not patch the baseline build.
  const wrap = await page.getByRole('button', { name: 'Wrap lines', exact: true }).boundingBox();
  if (!wrap) throw Error('Baseline Source toolbar is absent');
  await page.mouse.click(wrap.x - 40, wrap.y + wrap.height / 2);
}
async function view(page: Page, name: string) {
  await page.getByRole('button', { name: 'Views and display options', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function openPreview(page: Page, interactive: boolean) {
  const start = performance.now();
  await page.getByRole('button', { name: 'Preview file', exact: true }).first().click();
  const child = await readyDocument(page, interactive);
  return { openMs: performance.now() - start, child };
}
async function readyDocument(page: Page, interactive: boolean) {
  await eventually(() => page.frames().length === (interactive ? 3 : 2), { what: 'preview document contexts' });
  const child = page.frames().find((frame) => frame.parentFrame() && (!interactive || frame.parentFrame()!.parentFrame()))!;
  await child.locator('body').waitFor();
  if (interactive) await (await child.waitForFunction('window.previewStats?.ready === true')).dispose();
  await frames(page);
  return child;
}
async function memoryDiagnostic(page: Page, context: BrowserContext, browserCdp: CDPSession) {
  const cdp = await context.newCDPSession(page);
  const capture = async () => {
    const heap = await bounded(cdp.send('Runtime.getHeapUsage'), 'renderer heap');
    const dom = await bounded(cdp.send('Memory.getDOMCounters'), 'renderer DOM');
    const browser = await snapshot(browserCdp);
    return { heap, dom, pssMiB: browser.pssMiB, memoryProcessesReadable: browser.readable,
      processes: browser.processInfo.length, childFrames: page.frames().length - 1 };
  };
  try {
    const before = await capture();
    // Diagnostic only, after every natural observation. Never force GC in the
    // product or substitute these results for the natural memory measurements.
    await bounded(cdp.send('HeapProfiler.collectGarbage'), 'diagnostic GC');
    await frames(page);
    return { before, after: await capture() };
  } finally { await cdp.detach(); }
}
for (const round of caseMode ? [caseRound] : Array.from({ length: rounds }, (_, i) => i + 1)) {
  const order = caseMode ? [caseMode as 'baseline' | 'candidate'] : round % 2 ? ['baseline', 'candidate'] as const : ['candidate', 'baseline'] as const;
  for (const mode of order) {
    if (!caseMode) {
      // Match the functional harness's one-browser-per-process lifetime.
      // Repeated launches in one Bun process lost the DevTools pipe even on
      // the baseline; each case is isolated and attempted exactly once.
      const caseOut = join(out, `${round}-${mode}`);
      const child = Bun.spawn([process.execPath, import.meta.path,
        '--case-mode', mode, '--case-round', String(round), '--rounds', '1',
        '--baseline', builds.baseline, '--candidate', builds.candidate,
        '--html', input, '--out', caseOut, '--sample-ms', String(sampleMs),
        ...(gcDiagnostic ? ['--gc-diagnostic'] : []),
      ], { cwd: process.cwd(), stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      const status = await child.exited;
      if (status !== 0) throw Error(`${round} ${mode} failed (${status}); no retry`);
      const sample = JSON.parse(readFileSync(join(caseOut, 'samples.json'), 'utf8'));
      if (sample.rows.length !== (gcDiagnostic ? 9 : 8)) throw Error(`${round} ${mode} has incomplete phases`);
      rows.push(...sample.rows);
      writeFileSync(join(out, 'samples.json'), JSON.stringify({ ...sample, isolatedCaseProcesses: true, rows }, null, 2));
      continue;
    }
    const root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-html-app-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    writeFileSync(join(workspace, 'dashboard.html'), html);
    const sessionFile = join(root, 'owner.jsonl');
    writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'owner', cwd: workspace })}\n`);
    const tokdash = startFakeTokdash();
    let broker: Broker | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let observedPage: Page | undefined;
    const event = (name: string, detail?: unknown) => appendFileSync(join(out, `${round}-${mode}-events.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), name, detail })}\n`);
    try {
      broker = await startBroker({ name: 'html-app-performance', env: { COSYNCING_WEB_DIR: builds[mode], COSYNCING_FS_REMOTE_ENABLED: '1', COSYNCING_TOKDASH_URL: tokdash.url } });
      browser = await launchBrowser();
      browser.on('disconnected', () => event('browser-disconnected'));
      context = await newScenarioContext(browser, { viewport: { width: 1440, height: 1000 } });
      const response = await broker.client().post('/pi/bridge/hello', { sessionFile, cwd: workspace, title: 'HTML performance',
        history: Array.from({ length: 150 }, (_, i) => ({ t: i % 2 ? 'assistant' : 'user', key: `row-${i}`, text: `Transcript row ${i}: reviewing the self-contained dashboard.` })) });
      if (response.status !== 200) throw Error(`fixture hello ${response.status}`);
      const page = await context.newPage();
      observedPage = page;
      page.on('crash', () => event('page-crash'));
      page.on('pageerror', (error) => event('page-error', String(error)));
      page.on('console', (message) => { if (message.type() === 'error') event('console-error', message.text()); });
      let requests = 0; page.on('request', () => requests++);
      const cdp = await browser.newBrowserCDPSession();
      const began = performance.now();
      await page.goto(`${broker.url}/cosy/#/sessions`, { waitUntil: 'domcontentloaded' });
      await waitForFlutter(page);
      // Wait for the loaded project before opening it. Filling the startup
      // search box can precede restoration of the roster preferences.
      await page.getByRole('button', { name: 'workspace', exact: true }).click();
      // Leave the project header so its hover tooltip cannot cover the session
      // row while Playwright waits for that row to receive pointer events.
      await page.mouse.move(1000, 900);
      await page.getByRole('button', { name: 'HTML performance', exact: false }).first().click();
      await page.getByRole('button', { name: 'Views and display options', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Transcript row 148: reviewing the self-contained dashboard.', exact: true }).waitFor();
      const startupMs = performance.now() - began;
      const browserVersion = browser.version();
      const record = (phase: string, data: object) => { rows.push({ round, mode, phase, ...data, requests }); writeFileSync(join(out, 'samples.json'), JSON.stringify({ cpu: cpus()[0]?.model, os: release(), browserVersion, input, builds, sampleMs, settleMs, gcDiagnostic, rows }, null, 2)); };
      record('no-preview', { startupMs, ...await observe(page, cdp) });
      const navigateStart = performance.now();
      await view(page, 'Files'); await view(page, 'Chat'); await view(page, 'Files');
      await frames(page);
      record('no-preview-navigation', { navigationMs: performance.now() - navigateStart });
      const opened = await openPreview(page, mode === 'candidate');
      let interactionMs: number | null = null;
      if (mode === 'candidate') {
        const start = performance.now();
        await opened.child.locator('#filter').click();
        await (await opened.child.waitForFunction("document.querySelector('#count').textContent === '125 rows'")).dispose();
        interactionMs = performance.now() - start;
      }
      const rendererCdp = gcDiagnostic ? await context.newCDPSession(page) : undefined;
      if (rendererCdp) await bounded(rendererCdp.send('Performance.enable'), 'renderer metrics setup');
      const metricsBefore = rendererCdp ? await bounded(rendererCdp.send('Performance.getMetrics'), 'renderer metrics before') : undefined;
      const visible = await observe(page, cdp);
      const metricsAfter = rendererCdp ? await bounded(rendererCdp.send('Performance.getMetrics'), 'renderer metrics after') : undefined;
      const visibleRendererMetricDeltas = metricsAfter?.metrics.filter(m => m.name.endsWith('Duration')).map(m => ({
        name: m.name, seconds: m.value - (metricsBefore?.metrics.find(old => old.name === m.name)?.value ?? m.value),
      }));
      await rendererCdp?.detach();
      record('visible', { openMs: opened.openMs, interactionMs, ...visible, visibleRendererMetricDeltas });
      await page.screenshot({ path: join(out, `${round}-${mode}-visible.png`) });
      record('visible-scroll', await observe(page, cdp, async () => {
        await page.mouse.move(650, 500);
        const until = performance.now() + sampleMs;
        for (let i = 0; performance.now() < until; i++) { await page.mouse.wheel(0, i % 60 < 30 ? -200 : 200); await frames(page); }
      }));
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await eventually(() => page.frames().length === 1, { what: 'Source context removal' });
      record('hidden', await observe(page, cdp));
      const reopenStart = performance.now();
      await rendered(page, mode);
      await readyDocument(page, mode === 'candidate');
      record('reopen', { reopenMs: performance.now() - reopenStart });
      await broker.client().post('/pi/bridge/events', { id: response.body.id, events: [{ t: 'status', running: false }] });
      const cycles = [];
      for (let i = 0; i < 30; i++) {
        event('cycle-source', i + 1);
        await page.getByRole('button', { name: 'Source', exact: true }).click();
        await eventually(() => page.frames().length === 1, { what: 'cycle cleanup' });
        cycles.push({ cycle: i + 1, childFrames: page.frames().length - 1, pssMiB: (await snapshot(cdp)).pssMiB });
        writeFileSync(join(out, `${round}-${mode}-cycles.json`), JSON.stringify(cycles));
        if (i < 29) {
          event('cycle-rendered', i + 1);
          await rendered(page, mode);
          await readyDocument(page, mode === 'candidate');
          event('cycle-ready', i + 1);
        }
      }
      record('cycles', { cycles, ...await observe(page, cdp) });
      await page.getByRole('button', { name: 'Close', exact: true }).last().click();
      record('closed', await observe(page, cdp));
      if (gcDiagnostic) record('closed-gc-diagnostic', await memoryDiagnostic(page, context, cdp));
      console.log(`${round} ${mode}: completed`);
    } catch (error) {
      event('failure', String(error));
      if (observedPage) {
        const failure = join(out, `${round}-${mode}-failure.txt`);
        writeFileSync(failure, `${String(error)}\nconnected=${browser?.isConnected()} closed=${observedPage.isClosed()}\n`);
        const diagnostics = await Promise.allSettled([
          bounded(observedPage.screenshot({ path: join(out, `${round}-${mode}-failure.png`), timeout: 5000 }), 'failure screenshot', 5000),
          bounded(observedPage.locator('body').ariaSnapshot({ timeout: 5000 }), 'failure semantics', 5000),
        ]);
        appendFileSync(failure, diagnostics.map(result => result.status === 'fulfilled' ? (typeof result.value === 'string' ? result.value : 'screenshot saved') : String(result.reason)).join('\n'));
      }
      throw error;
    } finally {
      // A vanished browser must not prevent fixture teardown. Capture every
      // cleanup result and bound protocol waits even after a browser crash.
      const cleanup = await Promise.allSettled([
        (async () => {
          try { await bounded(context?.close() ?? Promise.resolve(), 'context cleanup', 5000); }
          finally { await bounded(browser?.close() ?? Promise.resolve(), 'browser cleanup', 5000); }
        })(),
        broker?.stop(), tokdash.stop(),
      ]);
      cleanup.forEach((result, index) => { if (result.status === 'rejected') event('cleanup-failure', { index, error: String(result.reason) }); });
      rmSync(root, { recursive: true, force: true });
      const failures = cleanup.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Benchmark cleanup failed');
    }
  }
}
writeFileSync(join(out, 'complete.json'), JSON.stringify({ complete: true, rounds, rows: rows.length }, null, 2));
if (caseMode) process.exit(0);

const median = (values: number[]) => { const sorted = values.toSorted((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2; };
const summary: Record<string, unknown> = {};
for (const mode of ['baseline', 'candidate']) {
  const phases: Record<string, unknown> = {};
  for (const phase of [...new Set(rows.map(row => String(row.phase)))]) {
    const samples = rows.filter(row => row.mode === mode && row.phase === phase);
    const metrics: Record<string, number> = {};
    for (const key of ['startupMs', 'navigationMs', 'openMs', 'interactionMs', 'reopenMs', 'cpuPercentOneCore', 'pssMiB', 'childFrames']) {
      const values = samples.map(row => row[key]).filter((value): value is number => typeof value === 'number');
      if (values.length) metrics[key] = median(values);
    }
    phases[phase] = metrics;
  }
  summary[mode] = phases;
}
const paired = [];
for (let round = 1; round <= rounds; round++) {
  const get = (mode: string, phase: string, key: string) => Number(rows.find(row => row.round === round && row.mode === mode && row.phase === phase)?.[key]);
  for (const phase of ['visible', 'visible-scroll', 'hidden', 'cycles', 'closed']) {
    const delta = (key: string) =>
      (get('candidate', phase, key) - get('candidate', 'no-preview', key)) -
      (get('baseline', phase, key) - get('baseline', 'no-preview', key));
    paired.push({ round, phase, additionalPssMiB: delta('pssMiB'), additionalCpuPercentOneCore: delta('cpuPercentOneCore') });
  }
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ rounds, sampleMs, settleMs, summary, paired }, null, 2));
