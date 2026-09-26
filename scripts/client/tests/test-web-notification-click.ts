#!/usr/bin/env bun
/**
 * Deterministic audit of the notification-click router in the web worker.
 *
 * Runs `apps/client/web/sw.js` for real, stamped with a synthetic manifest,
 * inside a fake ServiceWorkerGlobalScope, and drives its `notificationclick`
 * handler against scripted window clients. No browser and no build required.
 *
 * It proves:
 *
 *  1. A click goes to an app window under this scope: the focused one, else a
 *     visible one, else the most recently focused. Windows showing an asset, a
 *     different mount, or another origin are never chosen.
 *  2. The chosen window is focused and handed the notification's payload, even
 *     when the browser refuses the focus.
 *  3. With no app window, the app opens at its scope with the payload in
 *     `?attention=`, encoded so it round-trips exactly.
 *  4. `waitUntil` is registered synchronously and covers the whole routine, and
 *     a failure inside it is contained.
 *  5. The handler closes the notification and touches no cache.
 *  6. The worker and the page agree on the message type and launch parameter.
 *
 *   bun run scripts/client/tests/test-web-notification-click.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stampWorkerSource } from '../build-web-cache.ts';
import { CLIENT_ROOT } from '../run-client-command.ts';

const ORIGIN = 'https://broker.example';
const SCOPE = `${ORIGIN}/cosy/`;
const WORKER_SOURCE_PATH = join(CLIENT_ROOT, 'web', 'sw.js');
const PROTOCOL_SOURCE_PATH = join(
  CLIENT_ROOT,
  'lib',
  'src',
  'platform',
  'notifications',
  'web_notification_protocol.dart',
);

const MANIFEST = {
  buildVersion: 'buildnotify00001',
  precache: ['index.html'],
  runtime: [],
  hashes: { 'index.html': '0'.repeat(64) },
  precacheBytes: 0,
  runtimeBytes: 0,
};

let failures = 0;
let checks = 0;

function check(condition: unknown, description: string): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${description}`);
}

function checkEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`  FAIL ${description}\n    expected ${e}\n    actual   ${a}`);
}

/* ------------------------------------------------------------------ *
 * Fakes.
 * ------------------------------------------------------------------ */

interface FakeWindow {
  type: 'window';
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  refuseFocus?: boolean;
  focusCalls: number;
  messages: unknown[];
  focus(): Promise<FakeWindow>;
  postMessage(message: unknown): void;
}

function fakeWindow(
  url: string,
  state: { focused?: boolean; visible?: boolean; refuseFocus?: boolean } = {},
): FakeWindow {
  const client: FakeWindow = {
    type: 'window',
    url,
    focused: state.focused ?? false,
    visibilityState: state.visible === false ? 'hidden' : 'visible',
    refuseFocus: state.refuseFocus,
    focusCalls: 0,
    messages: [],
    async focus() {
      client.focusCalls += 1;
      if (client.refuseFocus) {
        throw new DOMException('Not allowed to focus a window.', 'InvalidAccessError');
      }
      return client;
    },
    postMessage(message: unknown) {
      client.messages.push(message);
    },
  };
  return client;
}

interface FakeNotification {
  tag: string;
  data: unknown;
  closed: number;
  close(): void;
}

function fakeNotification(payload: unknown, tag = '42'): FakeNotification {
  const notification: FakeNotification = {
    tag,
    data: payload === undefined ? null : { payload },
    closed: 0,
    close() {
      notification.closed += 1;
    },
  };
  return notification;
}

interface Harness {
  windows: FakeWindow[];
  matchAllCalls: unknown[];
  opened: string[];
  cacheAccesses: number;
  matchAllFails: boolean;
  /** What the fake openWindow waits on before it resolves. */
  openWindowGate: Promise<void>;
  click(notification: FakeNotification): {
    waitUntilCalls: number;
    settled: Promise<'resolved' | 'rejected'>;
  };
}

async function loadWorker(): Promise<Harness> {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const harness: Harness = {
    windows: [],
    matchAllCalls: [],
    opened: [],
    cacheAccesses: 0,
    matchAllFails: false,
    openWindowGate: Promise.resolve(),
    click(notification) {
      const waits: Promise<unknown>[] = [];
      listeners.get('notificationclick')?.({
        notification,
        action: '',
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      });
      const waitUntilCalls = waits.length;
      const settled = Promise.all(waits).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      return { waitUntilCalls, settled };
    },
  };
  const caches = new Proxy(
    {},
    {
      get() {
        harness.cacheAccesses += 1;
        return async () => undefined;
      },
    },
  );
  const scope: Record<string, unknown> = {
    location: { href: `${SCOPE}sw.js` },
    registration: { scope: SCOPE },
    clients: {
      claim: async () => undefined,
      matchAll: async (options: unknown) => {
        harness.matchAllCalls.push(options);
        if (harness.matchAllFails) throw new Error('matchAll failed');
        return [...harness.windows];
      },
      openWindow: async (url: string) => {
        await harness.openWindowGate;
        harness.opened.push(url);
        return null;
      },
    },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      listeners.set(type, handler);
    },
  };
  scope.self = scope;
  const source = stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), MANIFEST);
  // eslint-disable-next-line no-new-func -- executing the real worker source is the point
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'console',
    'crypto',
    `${source}\nreturn true;`,
  );
  const quietConsole = { ...console, warn: () => undefined };
  factory(scope, caches, async () => new Response(''), quietConsole, crypto);
  check(listeners.has('notificationclick'), 'sw.js registers a notificationclick handler');
  return harness;
}

function messagesOf(client: FakeWindow): unknown[] {
  return client.messages;
}

const click = (payload: string) => ({ type: 'cosyncing-notification-click', payload });

/* ------------------------------------------------------------------ *
 * Cases.
 * ------------------------------------------------------------------ */

async function caseFocusedAppWindowWins(): Promise<void> {
  const harness = await loadWorker();
  const visible = fakeWindow(`${SCOPE}#/sessions`, { visible: true });
  const focused = fakeWindow(`${SCOPE}`, { focused: true });
  const asset = fakeWindow(`${SCOPE}icons/pwa-icon-192.png`, { focused: true });
  harness.windows = [asset, visible, focused];
  const notification = fakeNotification('{"eventId":"e1"}');
  const { waitUntilCalls, settled } = harness.click(notification);
  checkEqual(waitUntilCalls, 1, 'waitUntil is registered synchronously');
  checkEqual(await settled, 'resolved', 'the click routine resolves');
  checkEqual(focused.focusCalls, 1, 'the focused app window is focused');
  checkEqual(messagesOf(focused), [click('{"eventId":"e1"}')], 'the focused window gets the payload');
  checkEqual(messagesOf(visible), [], 'a visible window is not chosen over a focused one');
  checkEqual(messagesOf(asset), [], 'a focused asset tab is never chosen');
  checkEqual(harness.opened, [], 'no window is opened when an app window exists');
  checkEqual(notification.closed, 1, 'the clicked notification is closed');
  checkEqual(
    harness.matchAllCalls,
    [{ type: 'window', includeUncontrolled: true }],
    'windows the worker does not control yet are candidates too',
  );
  checkEqual(harness.cacheAccesses, 0, 'routing a click touches no cache');
}

async function caseVisibleBeatsHiddenAndOrderIsKept(): Promise<void> {
  const harness = await loadWorker();
  const hiddenRecent = fakeWindow(`${SCOPE}`, { visible: false });
  const visibleFirst = fakeWindow(`${SCOPE}sessions/codex/abc`, { visible: true });
  const visibleSecond = fakeWindow(`${SCOPE}index.html`, { visible: true });
  harness.windows = [hiddenRecent, visibleFirst, visibleSecond];
  await harness.click(fakeNotification('p')).settled;
  checkEqual(messagesOf(visibleFirst), [click('p')], 'a visible deep-linked app window wins over a hidden one');
  checkEqual(messagesOf(visibleSecond), [], 'within one rank the most recently focused window wins');
  checkEqual(messagesOf(hiddenRecent), [], 'a hidden window loses to a visible one');

  const onlyHidden = await loadWorker();
  const older = fakeWindow(`${SCOPE}`, { visible: false });
  const newer = fakeWindow(`${SCOPE}`, { visible: false });
  onlyHidden.windows = [newer, older];
  await onlyHidden.click(fakeNotification('p')).settled;
  checkEqual(messagesOf(newer), [click('p')], 'with every window hidden the most recent one is used');
  checkEqual(onlyHidden.opened, [], 'a hidden app window is reused rather than opening another');
}

async function caseForeignWindowsAreSkipped(): Promise<void> {
  const harness = await loadWorker();
  const foreign = [
    fakeWindow(`${SCOPE}assets/fonts/MaterialIcons-Regular.otf`, { focused: true }),
    fakeWindow(`${ORIGIN}/other/`, { focused: true }),
    fakeWindow(`${ORIGIN}/cosy`, { focused: true }),
    fakeWindow(`${ORIGIN}/`, { focused: true }),
    fakeWindow('https://elsewhere.example/cosy/', { focused: true }),
  ];
  harness.windows = foreign;
  const payload = '{"a":"x&y=z#w","title":"déjà vu + more"}';
  await harness.click(fakeNotification(payload)).settled;
  checkEqual(harness.opened.length, 1, 'with no app window one window is opened');
  const opened = new URL(harness.opened[0] ?? SCOPE);
  checkEqual(`${opened.origin}${opened.pathname}`, SCOPE, 'the app opens at its own scope');
  checkEqual(opened.searchParams.get('attention'), payload, 'the payload round-trips through ?attention=');
  checkEqual([...opened.searchParams.keys()], ['attention'], 'nothing else is added to the URL');
  for (const window of foreign) {
    checkEqual(window.messages, [], `no message reaches ${window.url}`);
    checkEqual(window.focusCalls, 0, `${window.url} is not focused`);
  }
}

async function caseEmptyPayloadOpensThePlainScope(): Promise<void> {
  const harness = await loadWorker();
  await harness.click(fakeNotification(undefined)).settled;
  checkEqual(harness.opened, [SCOPE], 'a click without a payload opens the plain scope');

  const withWindow = await loadWorker();
  const app = fakeWindow(SCOPE, { focused: true });
  withWindow.windows = [app];
  await withWindow.click(fakeNotification(12345)).settled;
  checkEqual(messagesOf(app), [click('')], 'a non-string payload is handed over as empty');
}

async function caseRefusedFocusStillDelivers(): Promise<void> {
  const harness = await loadWorker();
  const app = fakeWindow(SCOPE, { visible: true, refuseFocus: true });
  harness.windows = [app];
  const { settled } = harness.click(fakeNotification('p'));
  checkEqual(await settled, 'resolved', 'a refused focus does not reject the click');
  checkEqual(app.focusCalls, 1, 'focus was attempted');
  checkEqual(messagesOf(app), [click('p')], 'the payload is still delivered after a refused focus');
}

async function caseWaitUntilCoversOpenWindow(): Promise<void> {
  const harness = await loadWorker();
  let release: () => void = () => undefined;
  harness.openWindowGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { settled } = harness.click(fakeNotification('p'));
  let done = false;
  void settled.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check(!done, 'the waitUntil promise is still pending while openWindow is');
  release();
  checkEqual(await settled, 'resolved', 'the waitUntil promise settles after openWindow');
  checkEqual(harness.opened.length, 1, 'openWindow ran inside the waited routine');
}

async function caseFailureIsContained(): Promise<void> {
  const harness = await loadWorker();
  harness.matchAllFails = true;
  const notification = fakeNotification('p');
  const { settled } = harness.click(notification);
  checkEqual(await settled, 'resolved', 'a failing client lookup does not reject waitUntil');
  checkEqual(notification.closed, 1, 'the notification is closed before the lookup');
}

async function caseProtocolMatchesThePage(): Promise<void> {
  const worker = await readFile(WORKER_SOURCE_PATH, 'utf8');
  const page = await readFile(PROTOCOL_SOURCE_PATH, 'utf8');
  const pick = (source: string, pattern: RegExp) => source.match(pattern)?.[1] ?? null;
  const workerMessage = pick(worker, /const NOTIFICATION_CLICK_MESSAGE = '([^']+)'/);
  const pageMessage = pick(page, /const webNotificationClickMessageType = '([^']+)'/);
  const workerParameter = pick(worker, /const NOTIFICATION_LAUNCH_PARAMETER = '([^']+)'/);
  const pageParameter = pick(page, /const webNotificationLaunchParameter = '([^']+)'/);
  check(workerMessage !== null && pageMessage !== null, 'both sides declare the click message type');
  checkEqual(workerMessage, pageMessage, 'worker and page agree on the click message type');
  check(workerParameter !== null && pageParameter !== null, 'both sides declare the launch parameter');
  checkEqual(workerParameter, pageParameter, 'worker and page agree on the launch parameter');
}

async function main(): Promise<number> {
  await caseFocusedAppWindowWins();
  await caseVisibleBeatsHiddenAndOrderIsKept();
  await caseForeignWindowsAreSkipped();
  await caseEmptyPayloadOpensThePlainScope();
  await caseRefusedFocusStillDelivers();
  await caseWaitUntilCoversOpenWindow();
  await caseFailureIsContained();
  await caseProtocolMatchesThePage();

  if (failures > 0) {
    console.error(`\nweb notification click audit: ${failures} failed of ${checks} checks`);
    return 1;
  }
  console.log(`\nweb notification click audit: ${checks} checks passed`);
  return 0;
}

process.exit(await main());
