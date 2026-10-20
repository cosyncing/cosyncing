#!/usr/bin/env bun
/**
 * Capture the built client's compact navigation and update states on fixtures.
 * Run from the repository root after bun run client:build:web.
 * Optional first argument: screenshot directory.
 * COSYNCING_UI_REVIEW_WIDTH controls the viewport (320–600; default 390).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eventually } from '../../e2e/harness/index.ts';
import { launchBrowser, waitForFlutter } from '../../e2e/harness/browser.ts';
import { PiBridgeSession } from '../../e2e/harness/fakes/pi-bridge-driver.ts';
import { startWebBroker } from '../../e2e/harness/web-scenario.ts';

const output = resolve(process.argv[2] ?? 'output/review/mobile-ui');
const width = Number(process.env.COSYNCING_UI_REVIEW_WIDTH ?? 390);
if (!Number.isInteger(width) || width < 320 || width > 600) {
  throw new Error('COSYNCING_UI_REVIEW_WIDTH must be between 320 and 600.');
}
mkdirSync(output, { recursive: true });
const broker = await startWebBroker({ name: 'mobile-ui-review' });
const screenshots: string[] = [];
try {
  const browser = await launchBrowser();
  try {
    const session = await PiBridgeSession.open(broker.client(), {
      cwd: broker.paths.home,
      title: 'Mobile UI review',
      hello: { history: [{ t: 'user', key: 'review', text: 'Review this session layout.' }] },
    });
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
          userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
          colorScheme,
          reducedMotion: 'reduce',
        });
        let releaseCheck: (() => void) | undefined;
        let firstCheck = true;
        let updateAvailable = false;
        try {
          await context.route('https://github.com/cosyncing/cosyncing/releases/**', (route) => route.abort());
          await context.route((url) => url.pathname === '/api/broker/updates', async (route) => {
            const now = new Date().toISOString();
            await route.fulfill({
              status: 200, contentType: 'application/json',
              body: JSON.stringify({ ok: true, inventory: {
                schemaVersion: 1, installationId: 'review-server',
                installationGeneration: 1, updateManagementVersion: 1,
                components: [{
                  component: 'broker', platform: 'linux', arch: 'x64',
                  ownership: 'cosyncing-installer',
                  running: { version: '0.7.2', buildId: '1111111' },
                  canCheck: true, canPlan: true, canApply: true,
                  canCancel: false, requiresRestart: true, blockers: [],
                }],
                busy: { state: 'idle', activeTurns: 0, activeLaunches: 0,
                  pendingApprovals: 0, observedAt: now },
                checkedAt: now,
              } }),
            });
          });
          const page = await context.newPage();
          const diagnostics: string[] = [];
          page.on('console', (message) => diagnostics.push(`[${message.type()}] ${message.text()}`));
          page.on('pageerror', (error) => diagnostics.push(error.message));
          page.on('requestfailed', (request) => diagnostics.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
          page.setDefaultTimeout(15_000);
          async function capture(name: string): Promise<void> {
            const file = `${name}-${colorScheme}.png`;
            await page.screenshot({ path: join(output, file) });
            screenshots.push(file);
          }
          await page.goto(`${broker.url}/cosy/#/sessions/pi/${encodeURIComponent(session.id)}`);
          await waitForFlutter(page);
          await page.getByRole('button', { name: 'Review this session layout.', exact: true }).waitFor();
          await page.getByRole('button', { name: 'Chat', exact: true }).waitFor().catch(async (error) => {
            await capture('session-failed');
            writeFileSync(join(output, `session-failed-${colorScheme}.txt`), [
              ...diagnostics, await page.locator('body').ariaSnapshot(),
            ].join('\n'));
            throw error;
          });
          await capture('session');
          await page.getByRole('button', { name: 'Views and display options', exact: true }).click();
          await page.getByRole('menuitemcheckbox', { name: 'Hide tool calls', exact: true }).waitFor();
          await capture('session-menu');
          await page.keyboard.press('Escape');

          await page.goto(`${broker.url}/cosy/#/settings`);
          await waitForFlutter(page);
          const general = page.getByRole('button', { name: /^General\b/ });
          await general.waitFor();
          await capture('settings');
          await general.click();
          const updates = page.getByRole('button', { name: /^Updates\b/ });
          await updates.waitFor();
          await capture('general-settings');

          await context.route('**/api/broker/updates/check', async (route) => {
            if (firstCheck) {
              firstCheck = false;
              await new Promise<void>((resolve) => { releaseCheck = resolve; });
            }
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                check: {
                  schemaVersion: 1,
                  status: updateAvailable ? 'update-available' : 'current',
                  detailCode: updateAvailable ? 'available' : 'current',
                  components: [{
                    component: 'broker',
                    running: { version: '0.7.2', buildId: 'review' },
                    ...(updateAvailable ? { available: {
                      version: '0.7.3', buildId: '2222222',
                      releaseId: 'rel-0.7.3+2222222',
                    } } : {}),
                    releaseCheckedAt: new Date().toISOString(),
                  }],
                },
              }),
            }).catch(() => undefined);
          });
          await updates.click();
          await eventually(() => releaseCheck !== undefined, { what: 'the fixture update check to start' });
          await page.locator('flt-semantics').getByText('Checking for updates…', { exact: true }).waitFor();
          await capture('updates-checking');
          releaseCheck!();
          await page.getByText('Up to date').waitFor();
          await capture('updates-current');
          updateAvailable = true;
          await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
          await page.getByRole('button', { name: 'Update server', exact: true }).waitFor();
          await capture('updates-available');
          await page.getByRole('checkbox').click();
          await page.getByRole('checkbox', { checked: true }).waitFor();
          await page.getByRole('button', { name: 'Update 1 server', exact: true }).waitFor();
          await capture('updates-selection');
        } finally {
          releaseCheck?.();
          await context.close();
        }
      }
    } finally {
      await session.bye();
    }
  } finally {
    await browser.close();
  }
} finally {
  await broker.stop();
  writeFileSync(join(output, 'report.json'), JSON.stringify({ width, screenshots }, null, 2) + '\n');
}
console.log(`Captured ${screenshots.length} screenshots in ${output}`);
