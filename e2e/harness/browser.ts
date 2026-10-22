/**
 * Real Chromium for the web suite: one browser per test file, one isolated
 * context (own storage, own service workers) per scenario.
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { eventually, scaled } from './wait.ts';

// Flags for WSL2, where the GPU path can leave the compositor without frames.
const BROWSER_ARGS = ['--disable-gpu', '--disable-features=Vulkan,VizDisplayCompositor'];

export function chromiumExecutable(): string {
  const explicit = process.env.COSYNCING_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  const shells = readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  if (shells.length === 0) {
    throw new Error('No Chromium headless shell found. Run: npx playwright install chromium-headless-shell');
  }
  return join(cache, shells[0]!, 'chrome-headless-shell-linux64/chrome-headless-shell');
}

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: chromiumExecutable(), args: BROWSER_ARGS, headless: true });
}

export interface ScenarioContextOptions {
  colorScheme?: 'light' | 'dark';
  viewport?: { width: number; height: number };
}

/** A fresh incognito-like context: nothing is shared with any other scenario. */
export function newScenarioContext(browser: Browser, options: ScenarioContextOptions = {}): Promise<BrowserContext> {
  return browser.newContext({
    acceptDownloads: true,
    reducedMotion: 'reduce',
    colorScheme: options.colorScheme ?? 'light',
    viewport: options.viewport ?? { width: 1280, height: 860 },
  });
}

/** Page errors and console errors, for a "browser console is clean" assertion. */
export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location().url;
    errors.push(location ? `${message.text()} (${location})` : message.text());
  });
  return errors;
}

/** Wait until Flutter has built its semantics tree, switching it on if needed. */
export async function waitForFlutter(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(document.querySelector('flt-semantics-placeholder, flt-semantics')),
    undefined,
    { timeout: scaled(60_000) },
  );
  const placeholder = page.locator('flt-semantics-placeholder');
  if (await placeholder.count()) {
    // Mobile Flutter enables semantics only for a click at the placeholder's
    // center (the gesture sent by TalkBack/VoiceOver). An event at (0, 0)
    // leaves the app painted but inaccessible to role-based locators.
    await placeholder.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('click', {
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
        bubbles: true,
      }));
    });
  }
}

/** Flutter's semantic input receives DOM focus before its editing strategy
 * attaches the input listener. Observe that listener before typing once; focus
 * alone can lose input during the following framework semantics update. */
export async function fillFlutterTextField(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name, exact: true }).click();
  const session = await page.context().newCDPSession(page);
  try {
    await eventually(async () => {
      const { result } = await session.send('Runtime.evaluate', {
        // Earlier Flutter builds expose the filled composer's name through
        // its placeholder; newer builds keep an explicit aria-label.
        expression: `(document.activeElement?.getAttribute('aria-label') || document.activeElement?.getAttribute('placeholder')) === ${JSON.stringify(name)} ? document.activeElement : null`,
      });
      if (!result.objectId) return false;
      try {
        const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
        return listeners.some((listener) => listener.type === 'input');
      } finally {
        await session.send('Runtime.releaseObject', { objectId: result.objectId });
      }
    }, { what: `Flutter input handler for ${name}` });
    await page.locator('input:focus, textarea:focus').fill(value);
  } finally {
    await session.detach();
  }
}

/** The startup shell's state attribute, or null when the shell is gone. */
export const SHELL_STATE = `document.getElementById('cosyncing-startup-shell')?.dataset.state ?? null`;
export const SHELL_GONE = `!document.getElementById('cosyncing-startup-shell')`;

/**
 * Poll a page expression (which may return a promise) until it is truthy.
 * `waitForFunction` does not reliably await promise-returning expressions,
 * and a document swap mid-poll is retried rather than failed.
 */
export async function waitUntil(page: Page, expression: string, options: { timeoutMs?: number; what?: string } = {}): Promise<void> {
  const timeoutMs = scaled(options.timeoutMs ?? 60_000);
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if (await page.evaluate(expression)) return;
      last = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed|navigated|Cannot read properties of null/i.test(message)) throw error;
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.what ?? expression.slice(0, 120)}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
