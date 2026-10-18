/**
 * One browser scenario: a fault-injecting proxy in front of a real broker, an
 * isolated browser context, and a page. Everything is torn down afterwards,
 * pass or fail.
 */
import type { Browser, BrowserContext, Page, Request } from 'playwright-core';
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
  const inFlight = trackRequests(context);
  try {
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
    context.setDefaultTimeout(scaled(60_000));
    await run({ proxy, context, page, logs });
  } catch (error) {
    await reportBrowserState(browser, context, proxy, inFlight)
      .catch((reason) => console.error(`[web scenario] browser state not recorded: ${String(reason)}`));
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await proxy.stop();
  }
}

/** Every request the context issued, page or service worker, until it finishes or fails. */
function trackRequests(context: BrowserContext): Map<Request, number> {
  const inFlight = new Map<Request, number>();
  context.on('request', (request) => inFlight.set(request, Date.now()));
  context.on('requestfinished', (request) => inFlight.delete(request));
  context.on('requestfailed', (request) => inFlight.delete(request));
  return inFlight;
}

const NO_ANSWER = Symbol('no answer');
const ANSWER_MS = 5_000;

/** `work`, or NO_ANSWER when it has not settled within ANSWER_MS. */
function answerOf<T>(work: Promise<T>): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof NO_ANSWER>((resolve) => { timer = setTimeout(() => resolve(NO_ANSWER), ANSWER_MS); });
  return Promise.race([work.catch((error) => `failed: ${String(error).split('\n')[0]}`), expiry])
    .finally(() => clearTimeout(timer)) as Promise<T | typeof NO_ANSWER>;
}

function ownerClosed(request: Request): boolean {
  if (request.serviceWorker()) return false;
  try {
    return request.frame().page().isClosed();
  } catch {
    return false;
  }
}

const shown = (value: unknown): string => (value === NO_ANSWER ? `no answer within ${ANSWER_MS} ms` : String(value));

/**
 * What the browser was doing when a scenario failed, printed beside the failure.
 *
 * A navigation whose `load` never fires leaves only "navigating to …" in the
 * call log. This separates the places it can be stuck: the browser connection
 * itself, a renderer that no longer answers, a service worker that never
 * finished activating, a request still in flight (and whether the proxy is the
 * one holding it). Every question has its own short bound and they are asked
 * together; nothing here waits on the app or changes what the scenario asserted.
 */
async function reportBrowserState(browser: Browser, context: BrowserContext, proxy: WebProxy, inFlight: Map<Request, number>): Promise<void> {
  const now = Date.now();
  const lines = ['[web scenario] failed; browser state at that moment:'];
  const connection = answerOf(browser.newBrowserCDPSession()
    .then((session) => session.send('Browser.getVersion').then((version) => version.product).finally(() => void session.detach().catch(() => undefined))));
  const pages = context.pages().map(async (page, index) => {
    const session = await answerOf(context.newCDPSession(page));
    if (session === NO_ANSWER || typeof session === 'string') return [`page ${index} at ${page.url()}: no devtools session (${shown(session)})`];
    const versions = new Map<string, string>();
    session.on('ServiceWorker.workerVersionUpdated', ({ versions: updated }) => {
      for (const v of updated) {
        versions.set(v.versionId, `version ${v.versionId} ${v.status}/${v.runningStatus} controlling ${(v.controlledClients ?? []).length} ${v.scriptURL}`);
      }
    });
    const [renderer, workers] = await Promise.all([
      answerOf(session.send('Runtime.evaluate', {
        expression: `[document.readyState, location.href, navigator.serviceWorker?.controller?.scriptURL ?? 'no controller'].join(' ')`,
        returnByValue: true,
      }).then((result) => result.result.value)),
      answerOf(session.send('ServiceWorker.enable')),
    ]);
    void session.detach().catch(() => undefined);
    return [
      `page ${index} at ${page.url()}: renderer ${shown(renderer)}`,
      ...(versions.size > 0
        ? [...versions.values()].map((v) => `  ${v}`)
        : [`  service workers: ${workers === NO_ANSWER || typeof workers === 'string' ? shown(workers) : 'none reported'}`]),
    ];
  });
  const [browserAnswer, ...pageLines] = await Promise.all([connection, ...pages]);
  lines.push(`browser connection: ${shown(browserAnswer)}`);
  for (const group of pageLines) lines.push(...group);
  for (const [request, since] of inFlight) {
    // A closed page's requests never report an end; they are not part of this state.
    if (ownerClosed(request)) continue;
    const origin = request.serviceWorker() ? 'service worker' : 'page';
    lines.push(`in flight ${now - since} ms (${origin}${request.isNavigationRequest() ? ', navigation' : ''}): ${request.method()} ${request.url()}`);
  }
  for (const { path, ms } of proxy.unanswered()) lines.push(`proxy still answering ${ms} ms: ${path}`);
  lines.push(`proxy received last: ${proxy.requests.slice(-12).join(' ')}`);
  console.error(lines.join('\n'));
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
