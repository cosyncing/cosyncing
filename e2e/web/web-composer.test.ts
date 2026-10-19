/** Phone composer geometry and first-tap sending in the built Flutter client. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Locator, Page } from 'playwright-core';
import { type Broker, eventually } from '../harness/index.ts';
import { launchBrowser, waitForFlutter } from '../harness/browser.ts';
import { PiBridgeSession } from '../harness/fakes/pi-bridge-driver.ts';
import { startWebBroker } from '../harness/web-scenario.ts';

const width = 390;
const height = 844;
const keyboardHeight = 320;

// Headless Chromium has no OS keyboard. Change the visual viewport through
// the same resize event Flutter's mobile engine uses for keyboard insets;
// the layout viewport stays full height, as it does on Android Chrome.
async function keyboard(page: Page, inset: number): Promise<void> {
  await page.evaluate((visibleHeight) => {
    Object.defineProperty(window.visualViewport!, 'height', {
      configurable: true,
      get: () => visibleHeight,
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  }, height - inset);
}

async function expectEditorOffset(field: Locator, originalY: number, inset: number): Promise<void> {
  await eventually(async () => {
    const box = await field.boundingBox();
    return box !== null && Math.abs(box.y - (originalY - inset)) <= 1;
  }, { what: 'the editor to move by the keyboard height exactly once' });
}

describe('phone composer', () => {
  let broker: Broker;
  let browser: Browser;
  beforeAll(async () => {
    broker = await startWebBroker({ name: 'web-composer' });
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
    await broker?.stop();
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keyboard insets and a touch send preserve focus (${colorScheme})`, async () => {
      const pi = await PiBridgeSession.open(broker.client(), {
        cwd: broker.paths.home,
        title: `Phone composer ${colorScheme}`,
        hello: { history: [{ t: 'user', key: 'previous', text: 'Previous phone message' }] },
      });
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
        colorScheme,
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const prompts: Record<string, unknown>[] = [];
        const drafts: Record<string, unknown>[] = [];
        let historyReceived = false;
        page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.kind === 'history') historyReceived = true;
        }));
        page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.kind === 'prompt') prompts.push(frame);
          if (frame.kind === 'draft') drafts.push(frame);
        }));
        await page.goto(`${broker.url}/cosy/#/sessions/pi/${encodeURIComponent(pi.id)}`, { waitUntil: 'domcontentloaded' });
        await eventually(() => historyReceived, { what: 'the session history to arrive' });
        await page.waitForFunction(() => !document.getElementById('cosyncing-startup-shell'));
        // Exercise ordinary canvas touch input before enabling screen-reader
        // semantics, whose DOM buttons intentionally take accessibility focus.
        // These are the centers of the one-line editor and the 40 dp Send
        // target in the phone layout; the inset regression moves them away.
        await page.touchscreen.tap(width / 2, height - 80);
        const field = page.locator('textarea.flt-text-editing');
        await field.waitFor();
        await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
        const prompt = `One touch from ${colorScheme}`;
        await page.keyboard.insertText(prompt);
        await eventually(() => field.inputValue().then((value) => value === prompt), { what: 'the focused draft to contain the typed text' });
        await eventually(() => drafts.some((frame) => frame.text === prompt), { what: 'Flutter to publish the typed draft' });
        const originalY = (await field.boundingBox())!.y;
        for (const inset of [96, keyboardHeight, 0, keyboardHeight]) {
          await keyboard(page, inset);
          await expectEditorOffset(field, originalY, inset);
        }
        const review = process.env.COSYNCING_COMPOSER_REVIEW_DIR;
        if (review) {
          mkdirSync(review, { recursive: true });
          await page.screenshot({
            path: join(review, `phone-keyboard-${colorScheme}.png`),
            clip: { x: 0, y: 0, width, height: height - keyboardHeight },
          });
        }

        // Settle rendering before touching. Waiting for frames between down
        // and up can turn this into a tooltip long-press under parallel load.
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await page.evaluate(() => {
          const state = window as Window & { sendPointerFocus?: string };
          window.addEventListener('pointerdown', () => {
            // Runs after Flutter's pointer-down handlers and focus microtasks,
            // while the browser is still handling this first touch.
            queueMicrotask(() => { state.sendPointerFocus = document.activeElement?.tagName; });
          }, { once: true });
        });
        expect(prompts).toHaveLength(0);
        await page.touchscreen.tap(width - 41, height - keyboardHeight - 33);
        expect(await page.evaluate(() => (window as Window & { sendPointerFocus?: string }).sendPointerFocus)).toBe('TEXTAREA');
        await eventually(() => prompts.length === 1, { what: 'one prompt from the first touch' });
        const command = await pi.nextCommand((item) => item.kind === 'prompt');
        expect(command.text).toBe(`One touch from ${colorScheme}`);
        await pi.events({
          t: 'user', key: command.messageKey, clientKey: command.clientKey,
          text: command.text, sentAt: Date.now(),
        });
        await eventually(() => field.inputValue().then((value) => value === ''), { what: 'the accepted draft to clear' });
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
        await expectEditorOffset(field, originalY, keyboardHeight);

        await page.keyboard.insertText('Next draft stays editable');
        await eventually(() => field.inputValue().then((value) => value === 'Next draft stays editable'), { what: 'typing a follow-up without refocusing' });
        expect(prompts).toHaveLength(1);
        await keyboard(page, 0);
        await expectEditorOffset(field, originalY, 0);
        await waitForFlutter(page);
        await page.getByRole('button', { name: 'Send prompt', exact: true }).waitFor();
      } finally {
        await context.close();
        await pi.bye();
      }
    });
  }
});
