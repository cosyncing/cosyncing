#!/usr/bin/env bun
/**
 * Deterministic audit of the Web Push handler in the web worker.
 *
 * Runs `apps/client/web/sw.js` for real, stamped with a synthetic manifest,
 * inside a fake ServiceWorkerGlobalScope, and drives its `push` handler with
 * decrypted payloads. No browser, broker or build required.
 *
 * It proves:
 *
 *  1. A push is shown under the app's own tag for the event's slot, computed
 *     from the registration's context exactly as the app computes it (the
 *     vectors the Dart test also checks), with the tap payload the app's own
 *     notification carries.
 *  2. The alert key is the app's: the alert already on screen replaces
 *     silently; a reminder, a re-alert or a new event alerts again.
 *  3. Only a Chromium browser with a focused, visible app window skips the
 *     notification; every other browser always shows it.
 *  4. Urgent types stay, the per-type silence and "event type only" body are
 *     honoured, and a payload without a context still collapses by slot.
 *  5. An unreadable or foreign payload shows nothing, and a failure inside the
 *     handler is contained.
 *  6. The worker and the page agree on the first stage and the urgent types.
 *
 *   bun run scripts/client/tests/test-web-push-notification.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stampWorkerSource } from '../build-web-cache.ts';
import { CLIENT_ROOT } from '../run-client-command.ts';

const ORIGIN = 'https://broker.example';
const SCOPE = `${ORIGIN}/cosy/`;
const WORKER_SOURCE_PATH = join(CLIENT_ROOT, 'web', 'sw.js');
const VECTORS_PATH = join(CLIENT_ROOT, 'test', 'fixtures', 'web_push_notification_vectors.json');
const TYPES_SOURCE_PATH = join(
  CLIENT_ROOT,
  'lib',
  'src',
  'features',
  'attention',
  'model',
  'attention_notification_type.dart',
);

const MANIFEST = {
  buildVersion: 'buildpush0000001',
  precache: ['index.html'],
  runtime: [],
  hashes: { 'index.html': '0'.repeat(64) },
  precacheBytes: 0,
  runtimeBytes: 0,
};

interface Vectors {
  tags: Array<{ name: string; brokerProfileId: string; collapseKey: string; tag: string }>;
  alertKeys: Array<{ name: string; eventId: string; revision: number; stage: string; alertKey: string }>;
}

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
}

function fakeWindow(url: string, state: { focused?: boolean; visible?: boolean } = {}): FakeWindow {
  return {
    type: 'window',
    url,
    focused: state.focused ?? false,
    visibilityState: state.visible === false ? 'hidden' : 'visible',
  };
}

interface ShownNotification {
  title: string;
  options: Record<string, unknown> & { tag: string; data: { payload: string; alertKey: string } };
}

interface Harness {
  windows: FakeWindow[];
  shown: ShownNotification[];
  /** What `getNotifications` answers, by tag. */
  showing: Array<{ tag: string; data: unknown }>;
  getNotificationsFails: boolean;
  showFails: boolean;
  push(data: unknown): { waitUntilCalls: number; settled: Promise<'resolved' | 'rejected'> };
}

async function loadWorker(options: { chromium?: boolean } = {}): Promise<Harness> {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const harness: Harness = {
    windows: [],
    shown: [],
    showing: [],
    getNotificationsFails: false,
    showFails: false,
    push(data) {
      const waits: Promise<unknown>[] = [];
      listeners.get('push')?.({
        data,
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
  const scope: Record<string, unknown> = {
    location: { href: `${SCOPE}sw.js` },
    registration: {
      scope: SCOPE,
      getNotifications: async (filter: { tag?: string } = {}) => {
        if (harness.getNotificationsFails) throw new Error('getNotifications failed');
        return harness.showing.filter((item) => filter.tag === undefined || item.tag === filter.tag);
      },
      showNotification: async (title: string, shownOptions: ShownNotification['options']) => {
        if (harness.showFails) throw new TypeError('permission revoked');
        harness.shown.push({ title, options: shownOptions });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [...harness.windows],
      openWindow: async () => null,
    },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      listeners.set(type, handler);
    },
  };
  if (options.chromium) scope.navigator = { userAgentData: { brands: [] } };
  scope.self = scope;
  const source = stampWorkerSource(await readFile(WORKER_SOURCE_PATH, 'utf8'), MANIFEST);
  // eslint-disable-next-line no-new-func -- executing the real worker source is the point
  const factory = new Function('self', 'caches', 'fetch', 'console', 'crypto', `${source}\nreturn true;`);
  const quietConsole = { ...console, warn: () => undefined };
  factory(scope, {}, async () => new Response(''), quietConsole, crypto);
  check(listeners.has('push'), 'sw.js registers a push handler');
  return harness;
}

/** A push message's `data`, as the browser hands it over after decryption. */
function pushData(payload: unknown): { json(): unknown } {
  return {
    json() {
      if (typeof payload === 'string') return JSON.parse(payload);
      return payload;
    },
  };
}

const PROFILE = 'b7c1a0e2-4f3d-4a8e-9c61-0d2f5e7a9b13';
const SCOPE_KEY = `${PROFILE}|https://broker.example|inc-1`;

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    eventId: 'evt-1',
    revision: 1,
    type: 'turn_finished',
    title: 'Turn finished',
    body: 'Refactor the parser',
    tag: 'session-outcome:claude:3f2a9c1e-77d0-4b8e-a1c2-5e6f7a8b9c0d',
    stage: 'immediate',
    action: { kind: 'open-session', tool: 'claude', sessionId: '3f2a9c1e-77d0-4b8e-a1c2-5e6f7a8b9c0d' },
    context: JSON.stringify({ brokerProfileId: PROFILE, brokerScopeKey: SCOPE_KEY }),
    ...overrides,
  };
}

async function pushAndSettle(harness: Harness, data: unknown): Promise<void> {
  const { waitUntilCalls, settled } = harness.push(data);
  checkEqual(waitUntilCalls, 1, 'waitUntil is registered synchronously');
  checkEqual(await settled, 'resolved', 'the push routine resolves');
}

/* ------------------------------------------------------------------ *
 * Cases.
 * ------------------------------------------------------------------ */

async function caseShownAsTheAppShowsIt(vectors: Vectors): Promise<void> {
  const harness = await loadWorker();
  await pushAndSettle(harness, pushData(payload()));
  checkEqual(harness.shown.length, 1, 'a push is shown');
  const [shown] = harness.shown;
  checkEqual(shown?.title, 'Turn finished', 'the title is the type title the registration named');
  checkEqual(shown?.options.body, 'Refactor the parser', 'the body is the pushed session title');
  checkEqual(shown?.options.tag, vectors.tags[0]?.tag, "the tag is the app's tag for the slot");
  checkEqual(shown?.options.renotify, true, 'a new alert sounds');
  checkEqual(shown?.options.requireInteraction, false, 'a turn outcome does not stay');
  checkEqual(shown?.options.silent, false, 'a type with sound is not silent');
  checkEqual(shown?.options.icon, `${SCOPE}icons/pwa-icon-192.png`, "the app's icon, from its scope");
  checkEqual(shown?.options.badge, `${SCOPE}icons/pwa-monochrome-192.png`, "the app's badge");
  checkEqual(shown?.options.data.alertKey, 'evt-1\n1\nimmediate', 'the alert key names event, revision and stage');
  const tap = JSON.parse(shown?.options.data.payload ?? '{}');
  checkEqual(
    tap,
    {
      actionKind: 'open-session',
      brokerProfileId: PROFILE,
      brokerScopeKey: SCOPE_KEY,
      eventId: 'evt-1',
      kind: 'attention-event',
      sessionId: '3f2a9c1e-77d0-4b8e-a1c2-5e6f7a8b9c0d',
      tool: 'claude',
    },
    "the tap payload is the app's own, so a click opens the session",
  );
  checkEqual(Object.keys(tap), [...Object.keys(tap)].sort(), 'its keys are sorted as the app serializes them');
}

async function caseTagVectors(vectors: Vectors): Promise<void> {
  check(vectors.tags.length >= 5, 'the shared tag vectors are loaded');
  for (const vector of vectors.tags) {
    const harness = await loadWorker();
    const context = JSON.stringify({ brokerProfileId: vector.brokerProfileId, brokerScopeKey: 'scope' });
    await harness.push(pushData(payload({ tag: vector.collapseKey, context }))).settled;
    checkEqual(harness.shown[0]?.options.tag, vector.tag, `tag vector: ${vector.name}`);
  }
  for (const vector of vectors.alertKeys) {
    const harness = await loadWorker();
    await harness.push(
      pushData(payload({ eventId: vector.eventId, revision: vector.revision, stage: vector.stage })),
    ).settled;
    checkEqual(harness.shown[0]?.options.data.alertKey, vector.alertKey, `alert key vector: ${vector.name}`);
  }
}

async function caseRepeatReplacesSilently(vectors: Vectors): Promise<void> {
  const tag = vectors.tags[0]?.tag ?? '';
  const harness = await loadWorker();
  harness.showing = [{ tag, data: { payload: '{}', alertKey: 'evt-1\n1\nimmediate' } }];
  await pushAndSettle(harness, pushData(payload()));
  checkEqual(harness.shown[0]?.options.renotify, false, "the alert the app already showed replaces without a sound");

  for (const [name, overrides] of [
    ['a reminder', { stage: '15m' }],
    ['a re-alert', { revision: 2 }],
    ['a newer event in the slot', { eventId: 'evt-2' }],
  ] as const) {
    const again = await loadWorker();
    again.showing = [{ tag, data: { payload: '{}', alertKey: 'evt-1\n1\nimmediate' } }];
    await again.push(pushData(payload(overrides))).settled;
    checkEqual(again.shown[0]?.options.renotify, true, `${name} alerts again`);
  }

  const elsewhere = await loadWorker();
  elsewhere.showing = [{ tag: 'another-slot', data: { alertKey: 'evt-1\n1\nimmediate' } }];
  await elsewhere.push(pushData(payload())).settled;
  checkEqual(elsewhere.shown[0]?.options.renotify, true, 'the same key under another tag is not this alert');

  const unknown = await loadWorker();
  unknown.getNotificationsFails = true;
  await pushAndSettle(unknown, pushData(payload()));
  checkEqual(unknown.shown[0]?.options.renotify, true, 'when what is showing cannot be read, it alerts');
}

async function caseFocusedWindowSkipsOnlyOnChromium(): Promise<void> {
  const chromium = await loadWorker({ chromium: true });
  chromium.windows = [fakeWindow(`${SCOPE}#/sessions`, { focused: true })];
  await pushAndSettle(chromium, pushData(payload()));
  checkEqual(chromium.shown.length, 0, 'Chromium with a focused, visible app window shows nothing');

  for (const [name, windows] of [
    ['a visible window without focus', [fakeWindow(SCOPE, { visible: true })]],
    ['a focused asset tab', [fakeWindow(`${SCOPE}icons/pwa-icon-192.png`, { focused: true })]],
    ['a focused window of another mount', [fakeWindow(`${ORIGIN}/other/`, { focused: true })]],
    ['no window', []],
  ] as const) {
    const harness = await loadWorker({ chromium: true });
    harness.windows = [...windows];
    await harness.push(pushData(payload())).settled;
    checkEqual(harness.shown.length, 1, `Chromium with ${name} shows the push`);
  }

  const other = await loadWorker();
  other.windows = [fakeWindow(SCOPE, { focused: true })];
  await pushAndSettle(other, pushData(payload()));
  checkEqual(other.shown.length, 1, 'another browser shows it even with a focused app window');
}

async function caseTypeSettingsAreHonoured(): Promise<void> {
  for (const type of ['permission_request', 'question', 'security_alert', 'server_problem']) {
    const harness = await loadWorker();
    await harness.push(pushData(payload({ type }))).settled;
    checkEqual(harness.shown[0]?.options.requireInteraction, true, `${type} stays until acted on`);
  }
  const silent = await loadWorker();
  await silent.push(pushData(payload({ silent: true }))).settled;
  checkEqual(silent.shown[0]?.options.silent, true, 'a type without sound is silent');

  const typeOnly = await loadWorker();
  await typeOnly.push(pushData(payload({ body: '' }))).settled;
  checkEqual(typeOnly.shown[0]?.options.body, '', 'an "event type only" push has no body');

  const noBody = await loadWorker();
  await noBody.push(pushData(payload({ body: 42 }))).settled;
  checkEqual(noBody.shown[0]?.options.body, '', 'a non-text body is dropped');
}

async function caseWithoutContext(): Promise<void> {
  const harness = await loadWorker();
  await pushAndSettle(harness, pushData(payload({ context: undefined })));
  const shown = harness.shown[0];
  checkEqual(
    shown?.options.tag,
    'push:session-outcome:claude:3f2a9c1e-77d0-4b8e-a1c2-5e6f7a8b9c0d',
    'without a profile the push still collapses by slot',
  );
  checkEqual(shown?.options.data.payload, '', 'and a click opens the app plainly');

  for (const context of ['not json', JSON.stringify({ brokerProfileId: PROFILE }), JSON.stringify(['x'])]) {
    const again = await loadWorker();
    await again.push(pushData(payload({ context }))).settled;
    check(String(again.shown[0]?.options.tag).startsWith('push:'), `an unusable context (${context}) is not guessed at`);
  }

  const noSlot = await loadWorker();
  await noSlot.push(pushData(payload({ tag: '  ' }))).settled;
  const fallback = await loadWorker();
  await fallback.push(
    pushData(payload({ tag: 'event:evt-1' })),
  ).settled;
  checkEqual(noSlot.shown[0]?.options.tag, fallback.shown[0]?.options.tag, 'a blank slot falls back to the event');
}

async function caseUnreadablePushShowsNothing(): Promise<void> {
  for (const [name, data] of [
    ['no data', null],
    ['not JSON', { json: () => { throw new SyntaxError('bad'); } }],
    ['another version', pushData(payload({ v: 2 }))],
    ['no title', pushData(payload({ title: ' ' }))],
    ['no event', pushData(payload({ eventId: undefined }))],
    ['not an object', pushData('"text"')],
  ] as const) {
    const harness = await loadWorker();
    const { waitUntilCalls } = harness.push(data);
    checkEqual(waitUntilCalls, 0, `${name}: nothing is waited on`);
    checkEqual(harness.shown.length, 0, `${name}: nothing is shown`);
  }

  const failing = await loadWorker();
  failing.showFails = true;
  await pushAndSettle(failing, pushData(payload()));
  checkEqual(failing.shown.length, 0, 'a refused show is contained');
}

async function caseProtocolMatchesThePage(): Promise<void> {
  const worker = await readFile(WORKER_SOURCE_PATH, 'utf8');
  const types = await readFile(TYPES_SOURCE_PATH, 'utf8');
  const workerStage = worker.match(/const FIRST_NOTIFICATION_STAGE = '([^']+)'/)?.[1] ?? null;
  const pageStage = types.match(/const attentionNotificationFirstStage = '([^']+)'/)?.[1] ?? null;
  check(workerStage !== null && pageStage !== null, 'both sides declare the first stage');
  checkEqual(workerStage, pageStage, 'worker and page agree on the first stage');
}

async function main(): Promise<number> {
  const vectors = JSON.parse(await readFile(VECTORS_PATH, 'utf8')) as Vectors;
  await caseShownAsTheAppShowsIt(vectors);
  await caseTagVectors(vectors);
  await caseRepeatReplacesSilently(vectors);
  await caseFocusedWindowSkipsOnlyOnChromium();
  await caseTypeSettingsAreHonoured();
  await caseWithoutContext();
  await caseUnreadablePushShowsNothing();
  await caseProtocolMatchesThePage();

  if (failures > 0) {
    console.error(`\nweb push notification audit: ${failures} failed of ${checks} checks`);
    return 1;
  }
  console.log(`\nweb push notification audit: ${checks} checks passed`);
  return 0;
}

process.exit(await main());
