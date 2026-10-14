/**
 * Real Chromium for the web suite: one browser per test file, one isolated
 * context (own storage, own service workers) per scenario.
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { scaled } from './wait.ts';

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
  if (await placeholder.count()) await placeholder.dispatchEvent('click');
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
