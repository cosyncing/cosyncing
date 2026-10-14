/**
 * One browser scenario: a fault-injecting proxy in front of a real broker, an
 * isolated browser context, and a page. Everything is torn down afterwards,
 * pass or fail.
 */
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { type ScenarioContextOptions, newScenarioContext } from './browser.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerOptions, REPO_ROOT, startBroker } from './broker.ts';
import { WebProxy } from './fakes/web-proxy.ts';
import { scaled } from './wait.ts';

export const WEB_BUILD_DIR = join(REPO_ROOT, 'apps/client/build/web');

/** A broker serving the built Flutter client (`bun run client:build:web` first). */
export function startWebBroker(options: BrokerOptions = {}): Promise<Broker> {
  if (!existsSync(join(WEB_BUILD_DIR, 'index.html'))) {
    throw new Error(`No web build at ${WEB_BUILD_DIR}. Run: bun run scripts/client/build-web.ts`);
  }
  const extra = typeof options.env === 'function' ? options.env : () => options.env ?? {};
  return startBroker({
    ...options,
    env: (paths) => ({ ...extra(paths), COSYNCING_WEB_DIR: WEB_BUILD_DIR }),
  });
}

export interface WebScenario {
  proxy: WebProxy;
  context: BrowserContext;
  page: Page;
  /** Console lines the page printed, in order. */
  logs: string[];
}

export async function webScenario(
  browser: Browser,
  broker: Broker,
  options: ScenarioContextOptions,
  run: (scenario: WebScenario) => Promise<void>,
): Promise<void> {
  const proxy = await WebProxy.start(broker.url);
  const context = await newScenarioContext(browser, options);
  try {
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
    context.setDefaultTimeout(scaled(60_000));
    await run({ proxy, context, page, logs });
  } finally {
    await context.close().catch(() => undefined);
    await proxy.stop();
  }
}

/**
 * Evaluate in a page that may be navigating: a context destroyed by a
 * deliberate document swap is retried, anything else is a real failure.
 */
export async function settledEvaluate<T>(page: Page, fn: string | (() => T | Promise<T>), timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + scaled(timeoutMs);
  for (;;) {
    try {
      return await page.evaluate(fn as any);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed|navigated|Target closed/i.test(message) || Date.now() > deadline) throw error;
    }
  }
}
