import { strict as assert } from 'node:assert';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  SessionCreateTemporarilyUnavailableError,
  type AgentMessage,
  type HistorySourceIdentity,
  type SessionConnection,
  type SessionInfo,
} from '@cosyncing/adapter-api';
import { EventEmitter } from 'node:events';
import { KiloAdapter, type KiloAdapterOptions } from '../src/implementation.ts';
import { discoverKiloStore, kiloHistorySourceIdentity, readKiloHistory } from '../src/store.ts';
import { KILO_MEASURED_VERSIONS, kiloVerifiedInvocation } from '../src/version.ts';
import { AttentionPolicy } from '../../../broker/src/attention/attention-policy.ts';
import { AttentionStore } from '../../../broker/src/attention/attention-store.ts';
import { createKiloDatabase } from './fixtures/database.ts';

let passed = 0;
const check = (name: string, condition: unknown, detail = '') => {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-live-'));
// Waits are on conditions, never on durations. `flush` yields the event loop so every synchronously
// handled SSE frame has been applied; `until` waits for an observable effect of asynchronous work.
const flush = async (): Promise<void> => { for (let turn = 0; turn < 4; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
const until = async (what: string, ready: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const startedAt = Date.now();
  while (!ready()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};
const calls: Array<{ url: string; search: string; method: string; body?: any; hasSignal: boolean }> = [];
let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
let globalEventCalls = 0;
let reconciliations = 0;
let releaseCreatedHistory: (() => void) | undefined;
let markCreatedHistoryStarted!: () => void;
const createdHistoryStarted = new Promise<void>((resolve) => { markCreatedHistoryStarted = resolve; });
let blockCreatedHistory = true;
let createdHistoryModel = { providerID: 'fixture', modelID: 'model' };
const encoder = new TextEncoder();
const parent = { id: 'ses_parent', title: 'Parent', directory: root, time: { created: 1, updated: 2 } };
const child = { id: 'ses_child', title: 'Drive root', directory: root, time: { created: 3, updated: 4 } };
const lineageChild = { id: 'ses_lineage_child', title: 'Child', directory: root, parentID: 'ses_parent', time: { created: 3, updated: 4 } };
const diskDirectory = join(root, 'workspace');
const diskSession = { id: 'ses_disk', title: 'Disk live', directory: diskDirectory, time: { created: 5, updated: 6 } };
// The live HTTP history for the disk session, mirroring its SQLite rows — including the image-only
// user row, whose parts carry no text. The durable projection maps no user-message for that row,
// so it reaches `reconcileHistory` as an id the seeded knownUserIds has never heard of.
const diskHistoryBody: unknown[] = [
  {
    info: { id: 'msg-user', role: 'user', sessionID: 'ses_disk' },
    parts: [{ id: 'prt-user', type: 'text', text: 'fixture prompt', messageID: 'msg-user', sessionID: 'ses_disk' }],
  },
  {
    info: { id: 'msg-assistant', role: 'assistant', sessionID: 'ses_disk' },
    parts: [{ id: 'prt-answer', type: 'text', text: 'fixture answer', messageID: 'msg-assistant', sessionID: 'ses_disk' }],
  },
  {
    info: { id: 'msg-image-only', role: 'user', sessionID: 'ses_disk' },
    parts: [{ id: 'prt-image-only', type: 'image', messageID: 'msg-image-only', sessionID: 'ses_disk' }],
  },
];
const oldScopedSession = { id: 'ses_old', title: 'Old idle', directory: diskDirectory, time: { created: 1, updated: 2 } };
const activeScopedSession = { id: 'ses_active', title: 'Old active', directory: diskDirectory, time: { created: 1, updated: 2 } };
const createdOnlySession = { id: 'ses_created_only', title: 'Created only', directory: diskDirectory, time: { created: 2 } };
const activeOnlyDirectory = join(root, 'active-only-workspace');
const activeOnlySession = { id: 'ses_active_only', title: 'Active-only directory', directory: activeOnlyDirectory, time: { created: 1, updated: 2 } };
// Enough hanging directories that the WHOLE-LEG deadline is what stops this,
// not Kilo's own per-request timeouts. Live discovery walks directories eight
// at a time and each request is capped at 3s, so N directories self-terminate
// after ceil(N/8) x 3s no matter what the budget is. At 20 that came to ~9s,
// which was under the old 5s budget and so proved the deadline — and silently
// stopped proving it when the budget moved to 15s, because 9s now arrives
// first. 64 gives ~24s of self-termination against a 15s deadline, so the
// deadline binds; and the ~40-48 calls issued before it fires stay clear of the
// `hangingScopedCalls < length` bound that proves the fan-out was cut short.
const hangingDirectories = Array.from({ length: 64 }, (_, index) => join(root, `hang-workspace-${index}`));
createKiloDatabase(join(root, 'kilo.db'), { id: diskSession.id, title: 'Disk observe' });
const fixtureDatabase = new Database(join(root, 'kilo.db'));
const insertFixtureSession = fixtureDatabase.query(`insert into session
  (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
  values (?, null, ?, ?, ?, null, null, ?, ?, ?, null)`);
insertFixtureSession.run(
  activeOnlySession.id, 'active-only', activeOnlyDirectory, activeOnlySession.title, 'code', 1, 2,
);
insertFixtureSession.run(child.id, 'drive-root', root, child.title, 'code', 3, 4);
for (const [index, directory] of hangingDirectories.entries()) {
  insertFixtureSession.run(`ses_hang_${index}`, `hang-${index}`, directory, `Hang ${index}`, 'code', 1, 2);
}
fixtureDatabase.close();
let status: 'idle' | 'busy' = 'busy';
let failNextCreate = false;
let failNextRename = false;
let brokenNextCreateBody = false;
let oversizedNextRenameBody = false;
let oversizedNextScopedList = false;
let hangScopedLists = false;
let hangingScopedCalls = 0;
let largeHistoryBody = false;
let oversizedSuccessfulPromptBody = false;
let nextMutationAuthStatus: 401 | 403 | undefined;
let failNextPermissionLoad = false;
let createdPermissionPending = false;
let healthStatus = 200;
let healthVersion = '7.4.23';
let nextCreateStatusAfterMutation: number | undefined;
/** The managed serve is gone: every request fails as a refused connection would. */
let serveDown = false;
/** Whether the serve answering is the exact managed host the broker owns. */
let hostOwnedNow = true;
const childPromptHistory: any[] = [];

// The store watch a driven session opens, fired by hand: a check says when the store changed.
const storeListeners = new Set<(event: string, filename: string | null) => void>();
const manualStoreWatch = ((_directory: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
  storeListeners.add(listener);
  const watcher = new EventEmitter() as EventEmitter & { close(): void };
  watcher.close = () => { storeListeners.delete(listener); };
  return watcher;
}) as unknown as NonNullable<KiloAdapterOptions['storeWatch']>;
const storeChanged = (filename: string): void => {
  for (const listener of [...storeListeners]) listener('change', filename);
};

const json = (value: unknown, statusCode = 200) => new Response(JSON.stringify(value), {
  status: statusCode,
  headers: { 'content-type': 'application/json' },
});

const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const parsed = new URL(url);
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (serveDown) throw new TypeError('fixture serve is down');
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ url: parsed.pathname, search: parsed.search, method, ...(body === undefined ? {} : { body }), hasSignal: !!init.signal });
  if (init.signal?.aborted) throw init.signal.reason;
  if (parsed.pathname === '/global/health') {
    const authorization = new Headers(init.headers).get('authorization');
    return authorization === `Basic ${Buffer.from('kilo:fixture-password').toString('base64')}`
      ? json({ healthy: healthStatus < 500, version: healthVersion }, healthStatus)
      : json({ error: 'unauthorized' }, 401);
  }
  if (parsed.pathname === '/global/event') {
    globalEventCalls += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(': ready\n\n'));
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (parsed.pathname === '/session/status') return json(
    hangingDirectories.includes(parsed.searchParams.get('directory') ?? '')
      ? {}
      :
    parsed.searchParams.get('directory') === activeOnlyDirectory
      ? { ses_active_only: { type: 'busy' } }
      : parsed.searchParams.get('directory') === diskDirectory
      ? { ses_disk: { type: 'idle' }, ses_old: { type: 'idle' }, ses_active: { type: 'busy' } }
      : { ses_child: { type: status } },
  );
  if (parsed.pathname === '/permission') {
    if (failNextPermissionLoad) {
      failNextPermissionLoad = false;
      throw new TypeError('fixture permission endpoint unavailable');
    }
    return json([
      { id: 'perm-existing', sessionID: 'ses_child', permission: 'shell', status: 'asked' },
      ...(createdPermissionPending
        ? [{ id: 'perm-created', sessionID: 'ses_created', permission: 'shell', status: 'asked' }]
        : []),
    ]);
  }
  if (parsed.pathname === '/provider') return json({
    connected: ['fixture', 'native-provider', 'later-native-provider'],
    all: [
      { id: 'fixture', models: { model: { name: 'Fixture model' } } },
      { id: 'native-provider', models: { 'native-model': { name: 'Native model' } } },
      { id: 'later-native-provider', models: { 'later-native-model': { name: 'Later native model' } } },
      { id: 'disconnected', models: { unavailable: { name: 'Unavailable model' } } },
    ],
  });
  if (parsed.pathname === '/session' && method === 'GET') {
    const requestedDirectory = parsed.searchParams.get('directory') ?? '';
    if (hangingDirectories.includes(requestedDirectory) && hangScopedLists) {
      hangingScopedCalls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(init.signal?.reason ?? new Error('fixture discovery aborted'));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    if (hangingDirectories.includes(requestedDirectory)) return json([]);
    if (parsed.searchParams.get('directory') === diskDirectory && oversizedNextScopedList) {
      oversizedNextScopedList = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return json(parsed.searchParams.get('directory') === activeOnlyDirectory
      ? [activeOnlySession]
      : parsed.searchParams.get('directory') === diskDirectory
      ? [diskSession, oldScopedSession, activeScopedSession, createdOnlySession]
      : [parent, child, lineageChild]);
  }
  if (parsed.pathname === '/session' && method === 'POST') {
    if (failNextCreate) {
      failNextCreate = false;
      throw new TypeError('fixture create reset');
    }
    if (brokenNextCreateBody) {
      brokenNextCreateBody = false;
      return new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const acceptedSessionId = nextCreateStatusAfterMutation === undefined ? 'ses_created' : 'ses_committed_503';
    const database = new Database(join(root, 'kilo.db'));
    database.query(`insert or ignore into session
      (id, parent_id, slug, directory, title, model, revert, agent, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, null, null, ?, ?, ?, null)`).run(
      acceptedSessionId, acceptedSessionId, root, body?.title ?? 'Created', 'code', 7, 7,
    );
    database.close();
    if (nextCreateStatusAfterMutation !== undefined) {
      const code = nextCreateStatusAfterMutation;
      nextCreateStatusAfterMutation = undefined;
      return json({ error: 'failed after commit' }, code);
    }
    return json({
      id: 'ses_created', title: body?.title ?? 'Created', directory: root, model: body?.model, permission: body?.permission,
    });
  }
  if (parsed.pathname === '/session/ses_created' && method === 'PATCH') {
    if (failNextRename) {
      failNextRename = false;
      throw new TypeError('fixture rename reset');
    }
    if (oversizedNextRenameBody) {
      oversizedNextRenameBody = false;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return json({ id: 'ses_created', title: body?.title ?? 'Created', directory: root });
  }
  if (parsed.pathname === '/session/ses_disk' && method === 'GET') return json(diskSession);
  if (parsed.pathname === '/session/ses_disk' && method === 'PATCH') return json({ ...diskSession, title: body?.title ?? diskSession.title });
  if (parsed.pathname === '/session/ses_disk/message' && method === 'GET') return json(diskHistoryBody);
  if (parsed.pathname === '/session/ses_created' && method === 'GET') return json({
    id: 'ses_created', title: 'Created fixture', directory: root,
  });
  if (parsed.pathname === '/session/ses_created/message' && method === 'GET') {
    if (blockCreatedHistory) {
      markCreatedHistoryStarted();
      await new Promise<void>((resolve) => { releaseCreatedHistory = resolve; });
    }
    return json([{
      info: {
        id: 'assistant-stale-model', role: 'assistant', sessionID: 'ses_created',
        model: createdHistoryModel,
      },
      parts: [],
    }]);
  }
  if (parsed.pathname === '/session/ses_child' && method === 'GET') return json(child);
  if (parsed.pathname === '/session/ses_lineage_child' && method === 'GET') return json(lineageChild);
  if (parsed.pathname === '/session/ses_child/message') return json([{
    info: { id: 'assistant-1', role: 'assistant', error: { data: { message: 'provider refusal\nprivate detail' } } },
    parts: [],
  }, ...childPromptHistory, ...(largeHistoryBody
    ? Array.from({ length: 10 }, (_, index) => ({
        info: { id: `assistant-large-${index}`, role: 'assistant' },
        parts: [{ id: `part-large-${index}`, type: 'text', text: 'x'.repeat(900_000) }],
      }))
    : [])]);
  if (parsed.pathname.endsWith('/permissions/perm-existing') && method === 'POST') {
    if (nextMutationAuthStatus) {
      const code = nextMutationAuthStatus;
      nextMutationAuthStatus = undefined;
      return json({ error: 'authorization lost' }, code);
    }
    return json({ ok: true });
  }
  if (parsed.pathname.endsWith('/prompt_async') && method === 'POST') {
    if (nextMutationAuthStatus) {
      const code = nextMutationAuthStatus;
      nextMutationAuthStatus = undefined;
      return json({ error: 'authorization lost' }, code);
    }
    if (body?.parts?.[0]?.text === 'ambiguous') throw new TypeError('fixture connection reset');
    if (body?.parts?.[0]?.text === 'accepted-then-503') {
      emit({
        type: 'message.updated',
        properties: {
          sessionID: 'ses_child',
          info: { id: body.messageID, sessionID: 'ses_child', role: 'user', time: { created: 8 } },
        },
      });
      emit({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_child',
          part: {
            id: 'part-owned-echo-503', messageID: body.messageID, sessionID: 'ses_child',
            type: 'text', text: body.parts[0].text,
          },
        },
      });
      await flush();
      return json({ error: 'failed after acceptance' }, 503);
    }
    if (oversizedSuccessfulPromptBody) {
      oversizedSuccessfulPromptBody = false;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body?.parts?.[0]?.text === 'now safe' || body?.parts?.[0]?.text === 'second safe') {
      const createdAt = body.parts[0].text === 'now safe' ? 7 : 9;
      const messageEvent = {
        type: 'message.updated',
        properties: {
          sessionID: 'ses_child',
          info: { id: body.messageID, sessionID: 'ses_child', role: 'user', time: { created: createdAt } },
        },
      };
      const part = {
        id: `part-owned-echo-${body.parts[0].text}`, messageID: body.messageID, sessionID: 'ses_child',
        type: 'text', text: body.parts[0].text,
      };
      const partEvent = {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_child',
          part,
        },
      };
      if (body.parts[0].text === 'second safe') {
        emit(partEvent);
        emit(messageEvent);
      } else {
        emit(messageEvent);
        emit(partEvent);
      }
      childPromptHistory.push({ info: messageEvent.properties.info, parts: [part] });
      // The native event bus can publish the echo before prompt_async resolves.
      await flush();
    }
    return json({ ok: true });
  }
  if (parsed.pathname.endsWith('/abort') && method === 'POST') return json({ ok: true });
  return json({ error: 'missing fixture route' }, 404);
}) as typeof fetch;

// An idle event, and the end of the ownership verdict it triggers (a boundary re-recorded or Drive revoked).
async function settleIdle(sessionID: string): Promise<void> {
  const before = reconciliations;
  emit({ type: 'session.idle', properties: { sessionID } });
  await until(`the idle settle of ${sessionID}`, () => reconciliations > before);
}

function emit(event: unknown): void {
  streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

try {
  const fakeKilo = join(root, 'kilo-fixture');
  writeFileSync(fakeKilo, '#!/bin/sh\nprintf "7.4.23\\n"\n');
  chmodSync(fakeKilo, 0o700);
  const boundaries = new Map<string, HistorySourceIdentity>();
  for (const session of await discoverKiloStore({ env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true })) {
    const snapshot = await readKiloHistory(session);
    if (snapshot) boundaries.set(session.id, kiloHistorySourceIdentity(session, snapshot));
  }
  let ownershipChecks = 0;
  const ownershipOptions = {
    isManagedHostOwned: async () => {
      ownershipChecks += 1;
      await Promise.resolve();
      return hostOwnedNow;
    },
    resolveStoredDriveState: (info: { id: string }) => boundaries.get(info.id)
      ? { historyBoundary: boundaries.get(info.id)! }
      : undefined,
    recordStoredDriveBoundary: (info: { id: string; historyBoundary: HistorySourceIdentity }) => {
      boundaries.set(info.id, info.historyBoundary);
      reconciliations += 1;
    },
    revokeStoredDriveEligibility: (info: { id: string }) => { boundaries.delete(info.id); reconciliations += 1; },
    storeWatch: manualStoreWatch,
  };
  const adapter = new KiloAdapter({
    command: fakeKilo,
    env: { PATH: '', KILO_DATA_DIR: root },
    homeDir: root,
    baseUrl: 'http://127.0.0.1:4097',
    serverPassword: 'fixture-password',
    testOnlyEnableUnverifiedDrive: true,
    fetch: fakeFetch,
    ...ownershipOptions,
  });
  const roster = await adapter.discoverSessions();
  check('one asynchronous managed-host proof qualifies the complete Kilo roster',
    ownershipChecks === 1, `checks=${ownershipChecks}`);
  check('candidate Kilo discovery declares the shared external-host budget',
    adapter.discoveryBudgetMs === EXTERNAL_HOST_DISCOVERY_BUDGET_MS);
  const wrongAuth = new KiloAdapter({
    command: fakeKilo, env: { PATH: '', KILO_DATA_DIR: root }, homeDir: root,
    baseUrl: 'http://127.0.0.1:4097', serverPassword: 'wrong-password',
    testOnlyEnableUnverifiedDrive: true, fetch: fakeFetch,
  });
  check('exact health remains unavailable with the wrong managed-server credential',
    !await wrongAuth.isManagedHostReady());
  await assert.rejects(
    wrongAuth.prepareCreateSession(),
    (error: unknown) => error instanceof Error
      && !(error instanceof SessionCreateTemporarilyUnavailableError)
      && /credential was rejected/u.test(error.message),
  );
  check('wrong managed-server authentication is incompatible and never retryable', true);
  // Below the floor is still incompatible, and still never retryable: a server
  // that predates the measured baseline may simply lack what Drive needs.
  healthVersion = '7.4.22';
  await assert.rejects(
    adapter.prepareCreateSession(),
    (error: unknown) => error instanceof Error
      && !(error instanceof SessionCreateTemporarilyUnavailableError)
      && /below the measured floor 7\.4\.23/u.test(error.message),
  );
  check('a managed server below the measured floor is incompatible and never retryable', true);

  // ...but a NEWER server is admitted. Kilo ships through npm and the operator
  // updates it whenever they update anything else; refusing their own server
  // for being ahead of the capture is the failure this floor exists to prevent.
  healthVersion = '7.5.16';
  await adapter.prepareCreateSession();
  check('a managed server newer than the measured baseline is accepted', true);
  healthVersion = '7.4.23';
  healthStatus = 503;
  await assert.rejects(
    adapter.prepareCreateSession(),
    (error: unknown) => error instanceof SessionCreateTemporarilyUnavailableError
      && error.detailCode === 'kilo-server-unavailable',
  );
  healthStatus = 200;
  check('health 503 is classified as retryable create unavailability', true);
  healthStatus = 501;
  await assert.rejects(
    adapter.prepareCreateSession(),
    (error: unknown) => error instanceof Error
      && !(error instanceof SessionCreateTemporarilyUnavailableError)
      && /unexpected status 501/u.test(error.message),
  );
  healthStatus = 200;
  check('health 501 from a wrong listener is incompatible and never retryable', true);
  const unowned = new KiloAdapter({
    command: fakeKilo,
    env: { PATH: '', KILO_DATA_DIR: root },
    homeDir: root,
    baseUrl: 'http://127.0.0.1:4097',
    serverPassword: 'fixture-password',
    testOnlyEnableUnverifiedDrive: true, fetch: fakeFetch,
    isManagedHostOwned: () => false,
  });
  await assert.rejects(
    unowned.prepareCreateSession(),
    (error: unknown) => error instanceof SessionCreateTemporarilyUnavailableError
      && error.detailCode === 'kilo-managed-host-unavailable',
  );
  check('temporary managed-host ownership loss is classified as retryable create unavailability', true);
  // A kilo that cannot drive (missing, or below the floor) is the typed, retryable refusal the
  // broker answers as 503 SESSION_CREATE_TEMPORARILY_UNAVAILABLE, never a plain 500.
  const oldKilo = join(root, 'kilo-below-floor');
  writeFileSync(oldKilo, '#!/bin/sh\nprintf "7.4.22\\n"\n');
  chmodSync(oldKilo, 0o700);
  for (const [label, command, detailCode] of [
    ['missing', join(root, 'no-such-kilo'), 'kilo-binary-missing'],
    ['below the floor', oldKilo, 'kilo-version-unsupported'],
  ] as const) {
    const unverified = new KiloAdapter({
      command, env: { PATH: '', KILO_DATA_DIR: root }, homeDir: root,
      baseUrl: 'http://127.0.0.1:4097', serverPassword: 'fixture-password', fetch: fakeFetch, ...ownershipOptions,
    });
    await assert.rejects(
      unverified.prepareCreateSession(),
      (error: unknown) => error instanceof SessionCreateTemporarilyUnavailableError && error.detailCode === detailCode,
    );
    check(`create with a ${label} kilo is the typed retryable create unavailability (${detailCode})`, true);
  }
  check('API-only Kilo child rows preserve native lineage immediately',
    roster.some((row) => row.id === lineageChild.id && row.origin === 'subagent'
      && row.parentThreadId === 'ses_parent' && row.attachMode === 'observe'
      && row.control?.drive.supported === false));
  await assert.rejects(adapter.attach(lineageChild.id, 'live'), /root|subagent/u);
  const childObserve = await adapter.attach(lineageChild.id, 'observe');
  const childObserveMessages: AgentMessage[] = [];
  childObserve.subscribe((message) => childObserveMessages.push(message));
  check('API-only Kilo children open as Observe-only while the managed host is healthy',
    childObserve.info.origin === 'subagent'
      && childObserve.info.parentThreadId === 'ses_parent'
      && childObserve.info.attachMode === 'observe'
      && childObserve.info.control?.drive.supported === false);
  emit({
    type: 'message.updated',
    properties: {
      sessionID: lineageChild.id,
      info: { id: 'msg_child_native', sessionID: lineageChild.id, role: 'user', time: { created: 8 } },
    },
  });
  emit({
    type: 'message.part.updated',
    properties: {
      sessionID: lineageChild.id,
      part: {
        id: 'part_child_native', messageID: 'msg_child_native', sessionID: lineageChild.id,
        type: 'text', text: 'native child prompt',
      },
    },
  });
  await until('native child prompt', () => childObserveMessages.some((message) => message.type === 'user-message' && message.text === 'native child prompt'));
  check('API-only child Observe streams native user activity without treating it as a foreign writer',
    childObserve.info.attachMode === 'observe'
      && childObserveMessages.some((message) => message.type === 'user-message'
        && message.text === 'native child prompt'));
  // Regression: /global/event is server-wide and every handled branch is session-scoped, so an
  // event this connection cannot positively identify as its own must be dropped. The filter used
  // to be fail-OPEN — a payload exposing none of the probed identity fields was applied to THIS
  // session — so a foreign session.deleted called markUnavailable() here, which aborts the stream
  // and makes every later event a no-op. Proving the stream still works afterwards is what
  // distinguishes the two behaviours.
  emit({ type: 'session.deleted', properties: {} });
  emit({ type: 'session.deleted', properties: { info: { id: 'ses_some_other_session' } } });
  emit({ type: 'session.deleted', properties: { session: { id: 'ses_some_other_session' } } });
  await flush();
  // Against the fail-open filter this throws ERR_INVALID_STATE, because markUnavailable() already
  // aborted the stream. Catch it so the failure reports as this check rather than an unhandled
  // error somewhere later.
  let streamStillOpen = true;
  try {
    emit({
      type: 'message.updated',
      properties: {
        sessionID: lineageChild.id,
        info: { id: 'msg_after_foreign', sessionID: lineageChild.id, role: 'user', time: { created: 9 } },
      },
    });
    emit({
      type: 'message.part.updated',
      properties: {
        sessionID: lineageChild.id,
        part: {
          id: 'part_after_foreign', messageID: 'msg_after_foreign', sessionID: lineageChild.id,
          type: 'text', text: 'still listening',
        },
      },
    });
  } catch {
    streamStillOpen = false;
  }
  await until('the prompt sent after the foreign deletes', () => childObserveMessages.some((message) => message.type === 'user-message' && message.text === 'still listening'));
  check('a foreign or unidentifiable session.deleted cannot retire this session',
    streamStillOpen
      && childObserveMessages.some((message) => message.type === 'user-message'
        && message.text === 'still listening'),
    JSON.stringify(childObserveMessages.filter((m) => m.type === 'user-message').map((m) => m.text)));

  await childObserve.close();
  const mutationCallsBeforeBareObserve = calls.filter((call) =>
    call.method === 'POST' || call.method === 'PATCH').length;
  const bareObserve = await adapter.attach(diskSession.id);
  let bareWriteRefused = false;
  try { await bareObserve.sendPrompt({ text: 'bare attach must stay read-only' }); } catch { bareWriteRefused = true; }
  check('bare Kilo attach is Observe-only and cannot invoke a native mutation',
    bareObserve.info.attachMode === 'observe'
      && bareObserve.info.control?.drive.supported === false
      && bareWriteRefused
      && calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').length
        === mutationCallsBeforeBareObserve);
  await bareObserve.close();
  check('API roster reconciles the point-in-time status endpoint',
    roster.some((row) => row.id === 'ses_child' && row.status === 'working'));
  check('directory-scoped Kilo sessions remain live after discovery refresh',
    roster.some((row) => row.id === diskSession.id && row.title === diskSession.title
      && row.attachMode === 'live' && row.control?.drive.supported === true)
      && calls.some((call) => call.url === '/session'
        && call.search === `?directory=${encodeURIComponent(diskDirectory)}`));
  const cutoffRoster = await adapter.discoverSessions({ updatedAfter: 5 });
  check('directory-scoped live discovery applies the idle cutoff but retains active rows',
    !cutoffRoster.some((row) => row.id === oldScopedSession.id)
      && !cutoffRoster.some((row) => row.id === createdOnlySession.id)
      && cutoffRoster.some((row) => row.id === activeScopedSession.id && row.status === 'working')
      && cutoffRoster.some((row) => row.id === activeOnlySession.id && row.status === 'working'));
  oversizedNextScopedList = true;
  const oversizedRoster = await adapter.discoverSessions();
  check('oversized live session bodies are refused before JSON materialization',
    oversizedRoster.some((row) => row.id === diskSession.id && row.attachMode === 'observe'));
  // The whole-leg deadline is the discovery signal: when it fires, every hanging per-directory
  // request is abandoned and no further directory is started. The fixture fires it itself (after
  // the fan-out is provably in flight) instead of waiting out the 15 s budget.
  hangScopedLists = true;
  hangingScopedCalls = 0;
  const legDeadline = new AbortController();
  const hungDiscovery = adapter.discoverSessions({ signal: legDeadline.signal });
  await until('the fan-out to be in flight', () => hangingScopedCalls >= 4);
  const callsWhenDeadlineFired = hangingScopedCalls;
  legDeadline.abort(new Error('fixture whole-leg deadline'));
  await hungDiscovery;
  hangScopedLists = false;
  check('direct Kilo discovery stops fanning out when its whole-leg deadline fires',
    callsWhenDeadlineFired < hangingDirectories.length && hangingScopedCalls < hangingDirectories.length,
    JSON.stringify({ callsWhenDeadlineFired, hangingScopedCalls }));
  const models = await adapter.listModels!();
  check('Kilo model catalog excludes disconnected providers from the real all/connected shape',
    models.length === 3 && models.some((model) =>
      model.providerID === 'fixture' && model.modelID === 'model' && model.label === 'Fixture model'));
  const created = await adapter.createSession!({
    directory: root,
    title: 'Created fixture',
    model: { providerID: 'fixture', modelID: 'model' },
  });
  check('Kilo create preserves model selection without sending fields rejected by 7.4.23',
    created.attachMode === 'live' && created.control?.drive.supported === true
      && created.control.drive.state === 'observing'
      && created.currentModel?.providerID === 'fixture' && created.currentModel?.label === 'Fixture model'
      && created.currentMode === undefined
      && calls.some((call) => call.url === '/session' && call.method === 'POST'
        && call.hasSignal
        && call.body?.title === 'Created fixture'
        && call.body?.model === undefined && call.body?.permission === undefined));
  const renamed = await adapter.renameSession!(created.id, 'Renamed fixture');
  check('Kilo candidate rename PATCHes the native session without changing identity',
    renamed.id === created.id && renamed.nativeId === created.nativeId && renamed.title === 'Renamed fixture'
      && calls.some((call) => call.url === '/session/ses_created' && call.method === 'PATCH'
        && call.hasSignal
        && call.body?.title === 'Renamed fixture'));
  failNextCreate = true;
  await assert.rejects(
    adapter.createSession!({ directory: root, title: 'Ambiguous create' }),
    /create transport became ambiguous/u,
  );
  failNextRename = true;
  await assert.rejects(
    adapter.renameSession!(created.id, 'Ambiguous rename'),
    /rename transport became ambiguous/u,
  );
  check('create and rename transport failures are bounded and reported as ambiguous',
    calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').slice(-2)
      .every((call) => call.hasSignal));
  const createCallsBeforeCommitted503 = calls.filter((call) => call.url === '/session' && call.method === 'POST').length;
  nextCreateStatusAfterMutation = 503;
  await assert.rejects(
    adapter.createSession!({ directory: root, title: 'Committed before 503' }),
    /may have been accepted before the server failed \(503\)/u,
  );
  const committed503Database = new Database(join(root, 'kilo.db'), { readonly: true });
  const committed503 = committed503Database.query(
    'select id, title from session where id = ?',
  ).get('ses_committed_503') as { id?: string; title?: string } | null;
  committed503Database.close();
  check('create 503 after durable mutation is ambiguous and is never implicitly retried',
    calls.filter((call) => call.url === '/session' && call.method === 'POST').length
      === createCallsBeforeCommitted503 + 1
      && committed503?.id === 'ses_committed_503'
      && committed503.title === 'Committed before 503'
      && !boundaries.has('ses_committed_503'));
  brokenNextCreateBody = true;
  await assert.rejects(
    adapter.createSession!({ directory: root, title: 'Broken create response' }),
    /accepted but returned no bounded stable session identity/u,
  );
  oversizedNextRenameBody = true;
  await assert.rejects(
    adapter.renameSession!(created.id, 'Oversized rename response'),
    /accepted but returned no bounded stable session identity/u,
  );
  check('unusable successful mutation bodies remain ambiguous after native acceptance', true);
  check('Kilo withholds an unmeasured permission mode selector', adapter.listModes === undefined);
  await assert.rejects(
    adapter.createSession!({ directory: root, permissionMode: 'ask' }),
    /permission mode is unavailable/u,
  );

  // P2: an image-only prompt is a user row whose parts carry no text. `live.ts` pushes every user
  // row's id into nativeUserIds unconditionally, but only emits a `user-message` when the text is
  // non-empty — so the durable projection maps no user-message for the row and `prime()`'s
  // knownUserIds never learns its id. On a FRESH attach, claimedUserIds is empty because this
  // process never sent that prompt, so the first history read reads the session's own history as
  // another writer's and revokes Drive. Own-process prompts are masked by claimedUserIds; only a
  // re-attach — a restarted broker replaying its own history — exposes it.
  const imageOnly = await adapter.attach(diskSession.id, 'live');
  let imageOnlyError: unknown;
  try {
    await imageOnly.getHistory();
  } catch (error) {
    imageOnlyError = error;
  }
  check('an image-only prompt in replayed history does not read as a foreign write',
    imageOnlyError === undefined && imageOnly.info.attachMode !== 'observe'
      && boundaries.has(diskSession.id),
    JSON.stringify({
      error: imageOnlyError instanceof Error ? imageOnlyError.message : undefined,
      attachMode: imageOnly.info.attachMode,
      boundaryRetained: boundaries.has(diskSession.id),
    }));
  await imageOnly.close();

  const diskConnection = await adapter.attach(diskSession.id, 'live');
  await assert.rejects(adapter.attach(diskSession.id, 'live'), /already has a Drive owner/u);
  check('a second direct live attach cannot open a rival Kilo writer', true);
  await flush();
  emit({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-disk-native', sessionID: diskSession.id, role: 'assistant',
        model: { providerID: 'native-provider', modelID: 'native-model' },
      },
    },
  });
  await flush();
  const modelRefresh = await adapter.discoverSessions();
  check('native SSE model evidence outranks a stale disk model on refresh',
    modelRefresh.some((row) => row.id === diskSession.id
      && row.currentModel?.providerID === 'native-provider'
      && row.currentModel.modelID === 'native-model'
      && row.currentModel.label === 'Native model'));
  // R3 experiment: does an IN-PLACE growth of an assistant text part — what streaming persistence
  // looks like — read as a rewrite? reconcileDisk remembers every row's JSON encoding
  // unconditionally at beforeMutation (mid-turn) and compares it as an append-only prefix at
  // sessionSettled. If Kilo persists partial text, the same index changes and a healthy session is
  // permanently revoked.
  // `runCommand('stop')` takes the same ownership path (beforeMutation('cancel')) without adding a
  // prompt, so the mid-turn snapshot happens without perturbing prompt-identity assertions later.
  let midTurnSnapshotTaken = true;
  try {
    await diskConnection.runCommand?.('stop');
  } catch {
    midTurnSnapshotTaken = false;
  }
  const growingDatabase = new Database(join(root, 'kilo.db'));
  growingDatabase.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'fixture answer and its streamed continuation' }), 'prt-answer',
  );
  growingDatabase.close();
  await settleIdle(diskSession.id);
  check('an in-place growth of an assistant text part does not revoke Drive',
    diskConnection.info.attachMode !== 'observe' && boundaries.has(diskSession.id),
    JSON.stringify({
      midTurnSnapshotTaken,
      attachMode: diskConnection.info.attachMode,
      boundaryRetained: boundaries.has(diskSession.id),
    }));

  // The same mid-turn read, then the step's own progress to its end: its text grows, its running
  // tool gains its result, and the message completes with its run summary before its final token
  // reading. Kilo writes a message in place until it completes, so none of that is a rewrite, and
  // Drive survives the turn boundary.
  const stepAt = Date.parse('2026-08-23T10:00:40.000Z');
  const stepMessage = (completed: boolean) => JSON.stringify({
    role: 'assistant', parentID: 'msg-user', providerID: 'vllm-fixture', modelID: 'qwen-fixture',
    time: { created: stepAt, ...(completed ? { completed: stepAt + 900 } : {}) },
    ...(completed ? { finish: 'stop' } : {}),
    cost: completed ? 0.1 : 0,
    tokens: completed
      ? { input: 4, output: 1, cache: { read: 0, write: 0 }, total: 5 }
      : { input: 0, output: 0, cache: { read: 0, write: 0 }, total: 0 },
  });
  const stepTool = (status: 'running' | 'completed') => JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call-step',
    state: status === 'completed'
      ? { status, input: { command: 'ls' }, output: 'a.txt', title: 'ls', metadata: { exit: 0 }, time: { start: 1, end: 2 } }
      : { status, input: { command: 'ls' }, time: { start: 1 } },
  });
  const stepDatabase = new Database(join(root, 'kilo.db'));
  stepDatabase.query('insert into message values (?, ?, ?, ?, ?)')
    .run('msg-drive-step', diskSession.id, stepAt, stepAt, stepMessage(false));
  stepDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-step-text', 'msg-drive-step', diskSession.id, stepAt + 100, stepAt + 100,
    JSON.stringify({ type: 'text', text: 'Checking', time: { start: stepAt + 100 } }),
  );
  stepDatabase.query('insert into part values (?, ?, ?, ?, ?, ?)').run(
    'prt-step-tool', 'msg-drive-step', diskSession.id, stepAt + 200, stepAt + 200, stepTool('running'),
  );
  stepDatabase.close();
  let stepSnapshotTaken = true;
  try {
    await diskConnection.runCommand?.('stop');
  } catch {
    stepSnapshotTaken = false;
  }
  const settledStepDatabase = new Database(join(root, 'kilo.db'));
  settledStepDatabase.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'Checking the directory.', time: { start: stepAt + 100, end: stepAt + 300 } }),
    'prt-step-text',
  );
  settledStepDatabase.query('update part set data = ? where id = ?').run(stepTool('completed'), 'prt-step-tool');
  settledStepDatabase.query('update message set data = ? where id = ?').run(stepMessage(true), 'msg-drive-step');
  settledStepDatabase.close();
  await settleIdle(diskSession.id);
  check('a step completing in place after a mid-turn ownership read does not revoke Drive',
    diskConnection.info.attachMode !== 'observe' && boundaries.has(diskSession.id),
    JSON.stringify({
      stepSnapshotTaken,
      attachMode: diskConnection.info.attachMode,
      boundaryRetained: boundaries.has(diskSession.id),
    }));

  const rewrittenDatabase = new Database(join(root, 'kilo.db'));
  rewrittenDatabase.query('update part set data = ? where id = ?').run(
    JSON.stringify({ type: 'text', text: 'foreign replacement' }), 'prt-user',
  );
  rewrittenDatabase.close();
  await settleIdle(diskSession.id);
  check('idle ownership reconciliation demotes immediately after an offline SQLite rewrite',
    diskConnection.info.attachMode === 'observe' && !boundaries.has(diskSession.id));
  await assert.rejects(
    diskConnection.sendPrompt({ text: 'must not write after offline replacement' }),
    /rewritten|replaced|revoked/u,
  );
  check('an offline SQLite content rewrite demotes Drive before its next mutation',
    diskConnection.info.attachMode === 'observe' && !boundaries.has(diskSession.id));
  await diskConnection.close();
  globalEventCalls = 0;

  const conn = await adapter.attach('ses_child', 'live');
  const live: AgentMessage[] = [];
  conn.subscribe((message) => live.push(message));
  await until('late attach seeding', () => conn.info.status === 'needs-input');
  check('late attach seeds needs-input from point-in-time busy and pending state',
    conn.info.status === 'needs-input' && (await conn.getPending!()).some((row) => row.type === 'permission-request'));
  // Every (re)opened event stream re-reads the pending list. A card this connection already sent is not
  // sent again: each client holds it, and a reconnect used to put it in every tab once more.
  const pendingCards = () => live.filter((row) => row.type === 'permission-request' && row.requestId === 'perm-existing').length;
  const liveSeeds = () => live.filter((row) => row.type === 'metadata-update' && row.key === 'sessionInfo'
    && (row.value as Partial<SessionInfo>).status === 'needs-input').length;
  const reopenEventStream = async (what: string): Promise<void> => {
    const seedsBefore = liveSeeds();
    const streamsBefore = globalEventCalls;
    streamController?.close();
    await until(what, () => globalEventCalls > streamsBefore && liveSeeds() > seedsBefore);
  };
  await reopenEventStream('the event stream to reopen and re-read the pending list');
  const cardsAfterFirstReopen = pendingCards();
  await reopenEventStream('the event stream to reopen once more');
  await reopenEventStream('and once more');
  check('a reopened event stream re-sends no pending card this connection already sent',
    cardsAfterFirstReopen <= 1 && pendingCards() === cardsAfterFirstReopen && conn.info.status === 'needs-input',
    `cards=${cardsAfterFirstReopen}->${pendingCards()}`);
  // The attach's own stream and the three reopened here: the count the demotion below must not grow.
  const eventStreamsOpened = globalEventCalls;
  check('...each reopen was one new event stream', eventStreamsOpened === 4, `streams=${eventStreamsOpened}`);
  let busyRefused = false;
  try { await conn.sendPrompt({ text: 'must not overlap' }); } catch { busyRefused = true; }
  check('unmeasured overlapping prompt queue fails closed', busyRefused);
  await conn.respondPermission('perm-existing', 'approve');
  check('successful local permission reply resolves the actionable card immediately',
    live.some((row) => row.type === 'permission-resolved' && row.requestId === 'perm-existing')
      && calls.some((call) => call.url.endsWith('/permissions/perm-existing') && call.hasSignal));

  emit({ type: 'permission.replied', properties: { sessionID: 'ses_child', requestID: 'perm-external', response: 'always' } });
  emit({ type: 'session.error', properties: { sessionID: 'ses_child', error: { data: { message: 'nested provider refusal\nsecret' } } } });
  await until('permission.replied and session.error', () => live.some((row) => row.type === 'permission-resolved' && row.requestId === 'perm-external') && live.some((row) => row.type === 'error' && row.message === 'nested provider refusal'));
  check('Kilo permission.replied maps to resolution and nested provider errors stay specific',
    live.some((row) => row.type === 'permission-resolved' && row.requestId === 'perm-external' && row.decision === 'approve-session')
      && live.some((row) => row.type === 'error' && row.message === 'nested provider refusal'));
  // The serve reports one failure twice — `session.error`, then the assistant message carrying the
  // same error — and re-announces that message as it updates: the transcript shows one row. The
  // reverse order is absorbed the same way.
  const errorRows = (text: string) => live.filter((row) => row.type === 'error' && row.message === text).length;
  const failedInfo = (id: string, text: string) => ({
    id, sessionID: 'ses_child', role: 'assistant', time: { created: 30, completed: 31 }, error: { data: { message: text } },
  });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: failedInfo('msg_failed_turn', 'nested provider refusal\nsecret') } });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: failedInfo('msg_failed_turn', 'nested provider refusal\nsecret') } });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: failedInfo('msg_failed_later', 'model exploded') } });
  emit({ type: 'session.error', properties: { sessionID: 'ses_child', error: { data: { message: 'model exploded' } } } });
  emit({ type: 'session.error', properties: { sessionID: 'ses_child', error: { data: { message: 'quota exhausted' } } } });
  await until('the last reported failure', () => errorRows('quota exhausted') === 1);
  check('a native failure reported by session.error and by its assistant message shows once, in either order',
    errorRows('nested provider refusal') === 1 && errorRows('model exploded') === 1,
    JSON.stringify(live.filter((row) => row.type === 'error')));
  const history = await conn.getHistory();
  check('history and live use the same bounded nested provider error extraction',
    history.some((row) => row.type === 'error' && row.message === 'provider refusal'));
  failNextPermissionLoad = true;
  const historyWithoutPermissions = await conn.getHistory();
  check('pending-permission failure cannot discard a successfully loaded durable transcript',
    historyWithoutPermissions.some((row) => row.type === 'error' && row.message === 'provider refusal')
      && historyWithoutPermissions.every((row) => row.type !== 'permission-request'));
  largeHistoryBody = true;
  const largeHistory = await conn.getHistory();
  largeHistoryBody = false;
  check('live Kilo history accepts a valid response between the metadata and transcript ceilings',
    largeHistory.filter((row) => row.type === 'model-output'
      && row.key?.startsWith('part-large-')).length === 10);
  status = 'idle';
  await settleIdle('ses_child');
  oversizedSuccessfulPromptBody = true;
  await conn.sendPrompt({ text: 'successful prompt with oversized unused body', clientMessageId: 'oversized-success' });
  check('a successful mutation with an oversized unused body stays writable',
    conn.info.attachMode === 'live' && conn.info.control?.drive.supported === true);
  await settleIdle('ses_child');
  await conn.sendPrompt({ text: 'now safe', clientMessageId: 'client-kilo' });
  check('a locally claimed SSE user echo cannot falsely demote Drive',
    conn.info.attachMode === 'live'
      && live.some((row) => row.type === 'user-message'
        && row.text === 'now safe' && row.clientKey === 'client-kilo' && row.sentAt === 7));
  await settleIdle('ses_child');
  await conn.sendPrompt({ text: 'second safe' });
  check('a broker prompt without a client key still claims its native echo',
    conn.info.attachMode === 'live'
      && live.some((row) => row.type === 'user-message'
        && row.text === 'second safe' && row.clientKey === undefined && row.sentAt === 9));
  const stableReplay = await conn.getHistory();
  for (const [text, sentAt] of [['now safe', 7], ['second safe', 9]] as const) {
    const liveRows = live.filter(
      (row): row is Extract<AgentMessage, { type: 'user-message' }> =>
        row.type === 'user-message' && row.text === text,
    );
    const replayRows = stableReplay.filter(
      (row): row is Extract<AgentMessage, { type: 'user-message' }> =>
        row.type === 'user-message' && row.text === text,
    );
    check(`Kilo ${text} user identity is exact-once and stable across live/replay ordering`,
      liveRows.length === 1
        && replayRows.length === 1
        && liveRows[0]?.key === replayRows[0]?.key
        && liveRows[0]?.turnId === replayRows[0]?.turnId
        && liveRows[0]?.sentAt === sentAt
        && replayRows[0]?.sentAt === sentAt,
      JSON.stringify({ liveRows, replayRows }));
  }
  const promptIds = calls
    .filter((call) => call.url.endsWith('/prompt_async'))
    .map((call) => String(call.body?.messageID ?? ''));
  check('idle prompt sends exact caller correlation and model-free body to prompt_async',
    calls.some((call) => call.url.endsWith('/prompt_async') && call.body?.messageID && call.body?.parts?.[0]?.text === 'now safe'));
  check('Kilo prompt IDs use OpenCode native ascending message identity',
    promptIds.length === 3
      && promptIds.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u.test(id))
      && promptIds[0]! < promptIds[1]!,
    JSON.stringify(promptIds));

  // The broker raises "turn finished" / "turn failed" only when a LIVE `running` run-summary is
  // followed by a terminal one under the SAME key. The SSE bus announces the driven prompt's
  // assistant message before it completes and again once `time.completed` is set; both map to the
  // assistant id's run key, so the reply opens as `running` and closes under that key.
  type RunSummaryRow = Extract<AgentMessage, { type: 'run-summary' }>;
  const runRowsOf = (rows: AgentMessage[], key: string): RunSummaryRow[] =>
    rows.filter((row): row is RunSummaryRow => row.type === 'run-summary' && row.key === key);
  const describeRuns = (rows: AgentMessage[]): string => JSON.stringify(
    rows.filter((row): row is RunSummaryRow => row.type === 'run-summary').map((row) => `${row.key}=${row.status}`));
  const replyInfo = {
    id: 'msg_kilo_pair_reply', sessionID: 'ses_child', role: 'assistant', parentID: promptIds[2], time: { created: 10 },
  };
  const replyKey = `kilo:run:${replyInfo.id}`;
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: replyInfo } });
  emit({
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_child',
      part: { id: 'prt_kilo_pair_reply', messageID: replyInfo.id, sessionID: 'ses_child', type: 'text', text: 'paired reply' },
    },
  });
  await until('the running reply', () => runRowsOf(live, replyKey).length === 1);
  check('a driven Kilo reply is announced running live before it completes',
    runRowsOf(live, replyKey).map((row) => row.status).join(',') === 'running', describeRuns(live));
  const completedReply = { ...replyInfo, time: { created: 10, completed: 12 }, finish: 'stop' };
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: completedReply } });
  await until('the done reply', () => runRowsOf(live, replyKey).length === 2);
  const replyRuns = runRowsOf(live, replyKey);
  check('a driven Kilo reply yields exactly one running then exactly one done under the same key',
    replyRuns.length === 2 && replyRuns[0]!.status === 'running' && replyRuns[1]!.status === 'done'
      && live.indexOf(replyRuns[0]!) < live.indexOf(replyRuns[1]!),
    describeRuns(live));
  const attentionRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-attention-'));
  try {
    // The broker's own attention policy, fed every subscriber frame in delivery order, exactly as
    // the Hub's live hook feeds it.
    const attentionStore = new AttentionStore({ path: join(attentionRoot, 'attention-events.json'), onWarning: () => undefined });
    const attentionPolicy = new AttentionPolicy(attentionStore);
    for (const message of live) await attentionPolicy.handleMessage(conn.info, message);
    const runEvents = attentionStore.listEvents()
      .filter((event) => event.kind === 'run-finished' || event.kind === 'run-failed');
    check('the real attention policy raises exactly one turn-finished for the driven reply',
      runEvents.length === 1 && runEvents[0]!.dedupeKey === `run-finished:kilo:ses_child:${replyKey}`,
      JSON.stringify(runEvents.map((event) => event.dedupeKey)));
  } finally {
    rmSync(attentionRoot, { recursive: true, force: true });
  }

  // A tool-using turn is several assistant messages, one per step, each with its own run key. A
  // step that ends by calling tools (`finish: 'tool-calls'`) is followed by the next one, so only
  // the turn's last step may raise "turn finished"; the earlier step closes without an outcome.
  const toolStep = { id: 'msg_kilo_tool_step', sessionID: 'ses_child', role: 'assistant', parentID: promptIds[2], time: { created: 20 } };
  const finalStep = { id: 'msg_kilo_final_step', sessionID: 'ses_child', role: 'assistant', parentID: promptIds[2], time: { created: 22 } };
  const stepsFrom = live.length;
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: toolStep } });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: { ...toolStep, time: { created: 20, completed: 21 }, finish: 'tool-calls' } } });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: finalStep } });
  emit({ type: 'message.updated', properties: { sessionID: 'ses_child', info: { ...finalStep, time: { created: 22, completed: 23 }, finish: 'stop' } } });
  await until('both steps', () => live.slice(stepsFrom).filter((row) => row.type === 'run-summary' && row.status === 'done').length === 2);
  const stepRows = live.slice(stepsFrom);
  const toolTerminal = runRowsOf(stepRows, `kilo:run:${toolStep.id}`).find((row) => row.status === 'done');
  const finalTerminal = runRowsOf(stepRows, `kilo:run:${finalStep.id}`).find((row) => row.status === 'done');
  check('a tool-calling step closes as a step of a turn that goes on; the last step closes the turn',
    toolTerminal?.turnContinues === true && finalTerminal !== undefined && finalTerminal.turnContinues === undefined,
    describeRuns(stepRows));
  const stepsRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-steps-'));
  try {
    const stepStore = new AttentionStore({ path: join(stepsRoot, 'attention-events.json'), onWarning: () => undefined });
    const stepPolicy = new AttentionPolicy(stepStore);
    for (const message of stepRows) await stepPolicy.handleMessage(conn.info, message);
    const stepEvents = stepStore.listEvents().map((event) => event.dedupeKey);
    check('a two-step Kilo turn raises exactly one turn-finished, for its last step',
      stepEvents.length === 1 && stepEvents[0] === `run-finished:kilo:ses_child:kilo:run:${finalStep.id}`,
      JSON.stringify(stepEvents));
  } finally {
    rmSync(stepsRoot, { recursive: true, force: true });
  }

  // Catch-up stays silent: a turn that finished before this connection saw it — the attach-time
  // history's errored `assistant-1`, and the reply above once the server has persisted it — reaches
  // subscribers through history only. A live `running` for either would make attaching notify.
  childPromptHistory.push({ info: completedReply, parts: [] });
  const replayAfterReply = await conn.getHistory();
  check('history replay carries finished Kilo turns without announcing any of them live',
    replayAfterReply.some((row) => row.type === 'run-summary' && row.key === replyKey && row.status === 'done')
      && replayAfterReply.some((row) => row.type === 'run-summary' && row.key === 'kilo:run:assistant-1')
      && runRowsOf(live, 'kilo:run:assistant-1').length === 0
      && live.filter((row) => row.type === 'run-summary' && row.status === 'running').length === 3,
    describeRuns(live));
  await conn.runCommand?.('stop');
  check('stop command maps to a bounded native abort request',
    calls.some((call) => call.url.endsWith('/abort') && call.method === 'POST' && call.hasSignal));
  await settleIdle('ses_child');
  const accepted503CallsBefore = calls.filter((call) => call.url.endsWith('/prompt_async')
    && call.body?.parts?.[0]?.text === 'accepted-then-503').length;
  await assert.rejects(
    conn.sendPrompt({ text: 'accepted-then-503', clientMessageId: 'client-accepted-503' }),
    /may have been accepted before the server failed \(503\)/u,
  );
  check('prompt 503 after a correlated native echo demotes Drive without retrying the accepted mutation',
    conn.info.attachMode === 'observe'
      && conn.info.control?.drive.supported === false
      && live.some((row) => row.type === 'user-message'
        && row.text === 'accepted-then-503' && row.clientKey === 'client-accepted-503')
      && calls.filter((call) => call.url.endsWith('/prompt_async')
        && call.body?.parts?.[0]?.text === 'accepted-then-503').length === accepted503CallsBefore + 1);
  const mutationCallsAfterDemotion = calls.length;
  await assert.rejects(conn.runCommand?.('stop') ?? Promise.resolve(), /read-only|ambiguous|may have been accepted/u);
  await assert.rejects(conn.respondPermission('perm-stale', 'reject'), /read-only|ambiguous|may have been accepted/u);
  await flush();
  check('demotion stops SSE reconnect and refuses every stale mutation',
    globalEventCalls === eventStreamsOpened && calls.length === mutationCallsAfterDemotion);
  await conn.close();

  status = 'idle';
  const restoredModelLookups: Array<{ tool: string; id: string; nativeId?: string }> = [];
  let durableModel = created.currentModel;
  const restartedAdapter = new KiloAdapter({
    command: fakeKilo,
    env: { PATH: '', KILO_DATA_DIR: root },
    homeDir: root,
    baseUrl: 'http://127.0.0.1:4097',
    serverPassword: 'fixture-password',
    testOnlyEnableUnverifiedDrive: true,
    fetch: fakeFetch,
    ...ownershipOptions,
    resolveStoredCurrentModel: (info) => {
      restoredModelLookups.push(info);
      return info.id === created.id ? durableModel : undefined;
    },
    recordNativeCurrentModel: (info) => { durableModel = info.currentModel; },
  });
  const createdConnection = await restartedAdapter.attach(created.id, 'live');
  await createdConnection.sendPrompt({ text: 'created model prompt', clientMessageId: 'created-model' });
  check('broker restart restores the create model until native evidence supersedes it',
    restoredModelLookups.some((info) => info.tool === 'kilo' && info.id === created.id && info.nativeId === created.id)
      && calls.some((call) => call.url.endsWith('/session/ses_created/prompt_async')
        && call.body?.model?.providerID === 'fixture' && call.body?.model?.modelID === 'model'));
  const staleHistory = createdConnection.getHistory();
  await createdHistoryStarted;
  emit({
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant-native-model',
        sessionID: created.id,
        role: 'assistant',
        model: { providerID: 'native-provider', modelID: 'native-model' },
      },
    },
  });
  await flush();
  releaseCreatedHistory?.();
  blockCreatedHistory = false;
  await staleHistory;
  check('native model evidence replaces the provisional durable model hint',
    durableModel?.providerID === 'native-provider' && durableModel.modelID === 'native-model'
      && durableModel.label === 'Native model');
  check('a stale concurrent history response cannot overwrite newer SSE model evidence',
    durableModel?.providerID === 'native-provider' && durableModel.modelID === 'native-model');
  createdHistoryModel = { providerID: 'later-native-provider', modelID: 'later-native-model' };
  await createdConnection.getHistory();
  check('a later fresh history response reconciles model evidence missed during an SSE gap',
    durableModel?.providerID === 'later-native-provider' && durableModel.modelID === 'later-native-model'
      && durableModel.label === 'Later native model');
  await settleIdle(created.id);
  await createdConnection.close();

  const secondRestartedAdapter = new KiloAdapter({
    command: fakeKilo,
    env: { PATH: '', KILO_DATA_DIR: root },
    homeDir: root,
    baseUrl: 'http://127.0.0.1:4097',
    serverPassword: 'fixture-password',
    testOnlyEnableUnverifiedDrive: true,
    fetch: fakeFetch,
    ...ownershipOptions,
    resolveStoredCurrentModel: (info) => info.id === created.id ? durableModel : undefined,
    recordNativeCurrentModel: (info) => { durableModel = info.currentModel; },
  });
  const afterNativeRestart = await secondRestartedAdapter.attach(created.id, 'live');
  await afterNativeRestart.sendPrompt({ text: 'post-native restart prompt', clientMessageId: 'post-native-model' });
  const finalPrompt = calls.filter((call) => call.url.endsWith('/session/ses_created/prompt_async')).at(-1);
  check('later restart never reasserts the stale create model',
    finalPrompt?.body?.model?.providerID === 'later-native-provider'
      && finalPrompt.body.model.modelID === 'later-native-model');
  await settleIdle(created.id);
  await afterNativeRestart.close();

  // The managed serve dies between turns (the supervisor replaces it): Drive is withheld, not revoked,
  // and comes back only once the serve answering is the owned managed host again and the session is
  // unchanged, the guards a fresh attach applies.
  const lossConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const driveStates: string[] = [];
  lossConnection.subscribe((message) => {
    if (message.type !== 'metadata-update' || message.key !== 'sessionInfo') return;
    const state = (message.value as Partial<SessionInfo>).control?.drive?.state;
    if (state) driveStates.push(state);
  });
  serveDown = true;
  streamController?.error(new Error('fixture serve crashed'));
  await until('Drive withheld while the serve is away', () => driveStates.includes('unavailable'));
  const callsDuringLoss = calls.length;
  await assert.rejects(lossConnection.sendPrompt({ text: 'while the serve is away' }), /read-only|unavailable|disconnected|away/iu);
  check('a serve lost between turns withholds Drive and refuses mutations without revoking it',
    calls.length === callsDuringLoss && boundaries.has(created.id));
  hostOwnedNow = false;
  serveDown = false;
  const eventCallsBeforeAnswer = globalEventCalls;
  await until('the answering serve to be asked for proof', () => globalEventCalls >= eventCallsBeforeAnswer + 2);
  await flush();
  check('a serve that answers but is not the owned managed host never restores Drive',
    !driveStates.includes('driving') && boundaries.has(created.id), JSON.stringify(driveStates));
  hostOwnedNow = true;
  await until('Drive back on the owned replacement', () => driveStates.at(-1) === 'driving');
  await lossConnection.sendPrompt({ text: 'after the replacement', clientMessageId: 'after-replacement' });
  check('Drive resumes on the owned replacement once the unchanged session is proved again',
    calls.some((call) => call.url.endsWith('/session/ses_created/prompt_async') && call.body?.parts?.[0]?.text === 'after the replacement'));
  await settleIdle(created.id);
  check('the turn on the replacement settles as this Drive\'s own', boundaries.has(created.id));
  await lossConnection.close();
  // A turn the serve fails with `session.error`, and no `session.idle` after it, is over all the same:
  // a serve lost after it is lost between turns (Drive withheld, then back), never mid-turn (revoked).
  const erroredConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const erroredStates: string[] = [];
  erroredConnection.subscribe((message) => {
    if (message.type !== 'metadata-update' || message.key !== 'sessionInfo') return;
    const state = (message.value as Partial<SessionInfo>).control?.drive?.state;
    if (state) erroredStates.push(state);
  });
  await erroredConnection.sendPrompt({ text: 'a turn the serve fails', clientMessageId: 'failed-without-idle' });
  const settlesBeforeError = reconciliations;
  emit({ type: 'session.error', properties: { sessionID: created.id, error: { data: { message: 'provider refused the turn' } } } });
  await until('the failed turn to settle without an idle', () => reconciliations > settlesBeforeError);
  check('a turn failed by session.error alone settles as this Drive\'s own', boundaries.has(created.id));
  serveDown = true;
  streamController?.error(new Error('fixture serve crashed after a failed turn'));
  await until('Drive withheld after the failed turn', () => erroredStates.includes('unavailable'));
  check('a serve lost after a turn failed without an idle withholds Drive and keeps its eligibility',
    boundaries.has(created.id) && erroredConnection.info.attachMode === 'live', JSON.stringify(erroredStates));
  serveDown = false;
  await until('Drive back after the failed turn', () => erroredStates.at(-1) === 'driving');
  await erroredConnection.close();
  // A serve that never comes back within the window ends the connection, and nothing else: the
  // session's eligibility stands for the next attach to prove against whatever serve answers then.
  const shortWaitAdapter = new KiloAdapter({
    command: fakeKilo,
    env: { PATH: '', KILO_DATA_DIR: root },
    homeDir: root,
    baseUrl: 'http://127.0.0.1:4097',
    serverPassword: 'fixture-password',
    testOnlyEnableUnverifiedDrive: true,
    fetch: fakeFetch,
    ...ownershipOptions,
    serveRecoveryMs: 1_500,
  });
  const abandoned = await shortWaitAdapter.attach(created.id, 'live');
  const abandonedStates: string[] = [];
  abandoned.subscribe((message) => {
    if (message.type !== 'metadata-update' || message.key !== 'sessionInfo') return;
    const state = (message.value as Partial<SessionInfo>).control?.drive?.state;
    if (state) abandonedStates.push(state);
  });
  serveDown = true;
  streamController?.error(new Error('fixture serve crashed for good'));
  const eventCallsWhileDown = globalEventCalls;
  await until('Drive withheld', () => abandonedStates.includes('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  serveDown = false;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  check('a serve that never comes back within the window is given up on, without revoking eligibility',
    boundaries.has(created.id) && globalEventCalls === eventCallsWhileDown && !abandonedStates.includes('driving'),
    `events=${globalEventCalls - eventCallsWhileDown} states=${JSON.stringify(abandonedStates)}`);
  await abandoned.close();
  const afterAbandoned = await shortWaitAdapter.attach(created.id, 'live');
  await afterAbandoned.sendPrompt({ text: 'after the serve came back', clientMessageId: 'after-abandoned' });
  check('the next attach drives once a serve answers again',
    calls.some((call) => call.url.endsWith('/session/ses_created/prompt_async') && call.body?.parts?.[0]?.text === 'after the serve came back'));
  await settleIdle(created.id);
  await afterAbandoned.close();

  const foreignWriterConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const foreignWriterMessages: AgentMessage[] = [];
  foreignWriterConnection.subscribe((message) => foreignWriterMessages.push(message));
  await flush();
  emit({
    type: 'message.updated',
    properties: {
      sessionID: created.id,
      info: { id: 'msg_foreign_writer', sessionID: created.id, role: 'user', time: { created: 8 } },
    },
  });
  await flush();
  const callsAfterForeignWriter = calls.length;
  await assert.rejects(
    foreignWriterConnection.sendPrompt({ text: 'must not overlap foreign writer' }),
    /another writer|read-only/u,
  );
  check('an unclaimed native user event demotes and fences later broker prompts',
    foreignWriterConnection.info.attachMode === 'observe'
      && foreignWriterConnection.info.control?.drive.supported === false
      && foreignWriterMessages.some((message) =>
        message.type === 'error' && /another writer/u.test(message.message))
      && calls.length === callsAfterForeignWriter);
  await foreignWriterConnection.close();

  // Independent rewrite scenario starts from a freshly re-proved app-owned
  // boundary; the prior foreign-writer scenario correctly revoked its copy.
  const rewrittenStored = (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === created.id)!;
  const rewrittenSnapshot = await readKiloHistory(rewrittenStored);
  boundaries.set(created.id, kiloHistorySourceIdentity(rewrittenStored, rewrittenSnapshot!));
  const rewriteConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const rewriteMessages: AgentMessage[] = [];
  rewriteConnection.subscribe((message) => rewriteMessages.push(message));
  await flush();
  emit({
    type: 'session.updated',
    properties: {
      sessionID: created.id,
      info: { id: created.id, sessionID: created.id, revert: { messageID: 'msg_rewrite_boundary' } },
    },
  });
  await flush();
  const callsAfterRewrite = calls.length;
  await assert.rejects(
    rewriteConnection.sendPrompt({ text: 'must not write after rewrite' }),
    /transcript rewrite|read-only/u,
  );
  check('a native revert resets history, demotes, and fences later broker prompts',
    rewriteConnection.info.attachMode === 'observe'
      && rewriteConnection.info.control?.drive.supported === false
      && rewriteMessages.some((message) => message.type === 'history-reset')
      && calls.length === callsAfterRewrite);
  await rewriteConnection.close();

  const latestStored = (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === created.id)!;
  const latestSnapshot = await readKiloHistory(latestStored);
  boundaries.set(created.id, kiloHistorySourceIdentity(latestStored, latestSnapshot!));
  const permissionAuthConnection = await secondRestartedAdapter.attach(created.id, 'live');
  nextMutationAuthStatus = 403;
  await assert.rejects(
    permissionAuthConnection.respondPermission('perm-existing', 'approve'),
    /authentication was rejected/u,
  );
  check('a 403 permission response demotes and revokes the Kilo writer',
    permissionAuthConnection.info.attachMode === 'observe' && !boundaries.has(created.id));
  await permissionAuthConnection.close();

  const authStored = (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === created.id)!;
  const authSnapshot = await readKiloHistory(authStored);
  boundaries.set(created.id, kiloHistorySourceIdentity(authStored, authSnapshot!));
  const promptAuthConnection = await secondRestartedAdapter.attach(created.id, 'live');
  await settleIdle(created.id);
  nextMutationAuthStatus = 401;
  await assert.rejects(promptAuthConnection.sendPrompt({ text: 'auth lost' }), /prompt failed \(401\)/u);
  check('a 401 prompt response demotes and revokes the Kilo writer',
    promptAuthConnection.info.attachMode === 'observe' && !boundaries.has(created.id));
  await promptAuthConnection.close();

  const closeStored = (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === created.id)!;
  const closeSnapshot = await readKiloHistory(closeStored);
  boundaries.set(created.id, kiloHistorySourceIdentity(closeStored, closeSnapshot!));
  createdPermissionPending = true;
  const activeCloseConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const activeCloseMessages: AgentMessage[] = [];
  activeCloseConnection.subscribe((message) => activeCloseMessages.push(message));
  await flush();
  await activeCloseConnection.close();
  check('active close settles permissions externally and revokes durable Drive eligibility',
    !boundaries.has(created.id)
      && activeCloseMessages.some((message) => message.type === 'permission-resolved'
        && message.requestId === 'perm-created' && message.decision === 'external'));
  // A mid-turn mutation's ownership read meets a store another process is using: the serve writes
  // the turn, and every connection that reads records how far it read in the WAL index (`-shm`).
  // Neither is a reason to refuse the mutation, and a store that cannot be read right now is never
  // a reason to give up Drive.
  createdPermissionPending = false;
  const busyStored = (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === created.id)!;
  boundaries.set(created.id, kiloHistorySourceIdentity(busyStored, (await readKiloHistory(busyStored))!));
  const busyConnection = await secondRestartedAdapter.attach(created.id, 'live');
  const busyDatabase = join(root, 'kilo.db');
  const stopFile = join(root, 'busy-store.stop');
  // Another process using the store until `stopFile` appears (or `forMs` elapses), saying when it started.
  const useStore = async (mode: 'commit' | 'read-mark', forMs: number) => {
    rmSync(stopFile, { force: true });
    const child = Bun.spawn(['bun', '-e', `
      const { Database } = require('bun:sqlite');
      const { existsSync, utimesSync } = require('node:fs');
      const database = new Database(${JSON.stringify(busyDatabase)});
      // Unsynced, so the commits come back to back as a busy serve's do, not one per fsync.
      database.exec('pragma journal_mode = WAL; pragma synchronous = OFF;');
      const touch = database.query('update session set time_updated = time_updated + 1 where id = ?');
      touch.run('ses_hang_0');
      console.log('started');
      const until = Date.now() + ${forMs};
      // A reader's write to the WAL index, as the snapshot sees it: a new modification time each time
      // (set explicitly, so two within one clock tick still differ).
      let mark = Date.now() / 1000;
      while (Date.now() < until && !existsSync(${JSON.stringify(stopFile)})) {
        if (${JSON.stringify(mode)} === 'commit') touch.run('ses_hang_0');
        else { mark += 0.000001; utimesSync(${JSON.stringify(`${busyDatabase}-shm`)}, mark, mark); }
      }
      database.close();
    `], { stdout: 'pipe', stderr: 'inherit' });
    const reader = child.stdout.getReader();
    let said = '';
    while (!said.includes('started')) {
      const next = await reader.read();
      if (next.done) throw new Error(`the ${mode} process ended before it started`);
      said += new TextDecoder().decode(next.value);
    }
    return { done: async () => { writeFileSync(stopFile, ''); await child.exited; } };
  };
  const abortsBefore = calls.filter((call) => call.url.endsWith(`/session/${created.id}/abort`)).length;
  const burst = await useStore('commit', 400);
  await busyConnection.runCommand?.('stop');
  await burst.done();
  check('a Stop whose ownership read meets a burst of the serve\'s commits waits them out and is accepted',
    calls.filter((call) => call.url.endsWith(`/session/${created.id}/abort`)).length === abortsBefore + 1
      && busyConnection.info.attachMode === 'live' && boundaries.has(created.id));
  const readMarks = await useStore('read-mark', 10_000);
  const readMarkStarted = Date.now();
  await busyConnection.runCommand?.('stop');
  const readMarkMs = Date.now() - readMarkStarted;
  await readMarks.done();
  check('a reader recording its WAL position during an ownership read is not a torn snapshot',
    calls.filter((call) => call.url.endsWith(`/session/${created.id}/abort`)).length === abortsBefore + 2
      && busyConnection.info.attachMode === 'live' && boundaries.has(created.id) && readMarkMs < 1_500,
    `${readMarkMs} ms`);
  // A store that cannot be read at all right now (here a stray rollback journal) proves nothing
  // either way: the mutation is refused, and Drive stays for the next one.
  writeFileSync(`${busyDatabase}-journal`, '');
  await assert.rejects(busyConnection.runCommand?.('stop') ?? Promise.resolve(), /could not be read; refusing this mutation/u);
  rmSync(`${busyDatabase}-journal`, { force: true });
  check('an unreadable store refuses the mutation and keeps Drive',
    busyConnection.info.attachMode === 'live' && busyConnection.info.control?.drive.supported === true
      && boundaries.has(created.id)
      && calls.filter((call) => call.url.endsWith(`/session/${created.id}/abort`)).length === abortsBefore + 2);
  await busyConnection.runCommand?.('stop');
  check('the next mutation after an unreadable store is accepted',
    calls.filter((call) => call.url.endsWith(`/session/${created.id}/abort`)).length === abortsBefore + 3);
  await busyConnection.close();

  // A rewritten prompt is seen when it lands: the Drive watches the store (fired by hand here), and
  // a prompt never streams, so even the newest one, which the store may still be completing, may
  // not change its text. During this Drive's own turn, the settle read is the check.
  const reseed = async () => {
    const stored = (await discoverKiloStore({
      env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
    })).find((session) => session.id === created.id)!;
    boundaries.set(created.id, kiloHistorySourceIdentity(stored, (await readKiloHistory(stored))!));
  };
  const writeRows = (rows: Array<{ id: string; at: number; data: unknown; parts: Array<{ id: string; data: unknown }> }>) => {
    const database = new Database(join(root, 'kilo.db'));
    for (const row of rows) {
      database.query('insert into message values (?, ?, ?, ?, ?)').run(row.id, created.id, row.at, row.at, JSON.stringify(row.data));
      for (const part of row.parts) {
        database.query('insert into part values (?, ?, ?, ?, ?, ?)').run(part.id, row.id, created.id, row.at, row.at, JSON.stringify(part.data));
      }
    }
    database.close();
  };
  const userRow = (id: string, at: number, text: string) => ({
    id, at, data: { role: 'user', time: { created: at } }, parts: [{ id: `prt-${id}`, data: { type: 'text', text } }],
  });
  // The serve's half of a prompt of this Drive: the turn's rows in the store, and the prompt's echo.
  const servePrompt = async (connection: SessionConnection, text: string, at: number, answered = true): Promise<string> => {
    await connection.sendPrompt({ text });
    const messageID = String(calls.filter((call) => call.url.endsWith(`/session/${created.id}/prompt_async`)).at(-1)!.body.messageID);
    writeRows([userRow(messageID, at, text), ...answered ? [{
      id: `${messageID}-answer`, at: at + 1,
      data: {
        role: 'assistant', parentID: messageID, providerID: 'fixture', modelID: 'model',
        time: { created: at + 1, completed: at + 2 }, finish: 'stop', cost: 0,
        tokens: { input: 1, output: 1, cache: { read: 0, write: 0 }, total: 2 },
      },
      parts: [{ id: `prt-${messageID}-answer`, data: { type: 'text', text: `answer: ${text}`, time: { start: at + 1, end: at + 2 } } }],
    }] : []]);
    emit({ type: 'message.updated', properties: { sessionID: created.id, info: { id: messageID, sessionID: created.id, role: 'user', time: { created: at } } } });
    emit({ type: 'message.part.updated', properties: { sessionID: created.id, part: { id: `prt-${messageID}`, messageID, sessionID: created.id, type: 'text', text } } });
    await flush();
    return messageID;
  };
  const rewritePrompt = (messageID: string, text: string) => {
    const database = new Database(join(root, 'kilo.db'));
    database.query('update part set data = ? where id = ?').run(JSON.stringify({ type: 'text', text }), `prt-${messageID}`);
    database.close();
  };
  const settleFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Later than every row already stored, so each prompt here is the session's newest.
  const watchedAt = Date.now() + 60_000;
  await reseed();
  const earlierDrive = await secondRestartedAdapter.attach(created.id, 'live');
  // Its turn ended before any answer was stored, so the prompt is the session's last row: the one
  // the store may still be completing, which only the prompt's own text can show was rewritten.
  const earlierPrompt = await servePrompt(earlierDrive, 'a prompt to keep', watchedAt, false);
  await settleIdle(created.id);
  await earlierDrive.close();
  // A later Drive knows that prompt only from the store it proved at attach.
  const watched = await secondRestartedAdapter.attach(created.id, 'live');
  const watchedMessages: AgentMessage[] = [];
  watched.subscribe((message) => watchedMessages.push(message));
  storeChanged('kilo.db-wal');
  await settleFor(600);
  check('a store change that rewrites nothing leaves Drive alone',
    watched.info.attachMode === 'live' && boundaries.has(created.id));
  rewritePrompt(earlierPrompt, 'a prompt rewritten in place');
  storeChanged('kilo.db-shm');
  await settleFor(600);
  check('a reader marking its place in -shm is not a store change',
    watched.info.attachMode === 'live' && boundaries.has(created.id));
  const promptsBeforeRewrite = calls.filter((call) => call.url.endsWith('/prompt_async')).length;
  storeChanged('kilo.db-wal');
  await until('the watched rewrite to demote Drive', () => watched.info.attachMode === 'observe');
  check('a rewritten stored prompt demotes Drive for every client when it lands, before any mutation',
    !boundaries.has(created.id)
      && watchedMessages.some((message) => message.type === 'error' && /rewritten or replaced/u.test(message.message))
      && calls.filter((call) => call.url.endsWith('/prompt_async')).length === promptsBeforeRewrite);
  await watched.close();

  await reseed();
  const turnDrive = await secondRestartedAdapter.attach(created.id, 'live');
  const turnPrompt = await servePrompt(turnDrive, 'a prompt rewritten mid-turn', watchedAt + 10_000);
  rewritePrompt(turnPrompt, 'rewritten before the turn settled');
  await settleIdle(created.id);
  check('a prompt of this Drive rewritten before its turn settled is caught by the settle read',
    turnDrive.info.attachMode === 'observe' && !boundaries.has(created.id));
  await turnDrive.close();

  // A terminal writes while no serve answers: the replacement's proof finds the session changed,
  // ends this Drive, and leaves the verdict to a fresh attach, which refuses the changed session.
  await reseed();
  const awayDrive = await secondRestartedAdapter.attach(created.id, 'live');
  const awayStates: string[] = [];
  awayDrive.subscribe((message) => {
    if (message.type !== 'metadata-update' || message.key !== 'sessionInfo') return;
    const state = (message.value as Partial<SessionInfo>).control?.drive?.state;
    if (state) awayStates.push(state);
  });
  serveDown = true;
  streamController?.error(new Error('fixture serve crashed'));
  await until('Drive withheld while the serve is away', () => awayStates.includes('unavailable'));
  writeRows([userRow('msg-terminal-away', watchedAt + 20_000, 'typed while the serve was away')]);
  storeChanged('kilo.db-wal');
  await settleFor(600);
  serveDown = false;
  await until('the replacement to be asked for proof', () => awayDrive.info.attachMode === 'observe');
  check('a session written while its serve was away is not driven again on the replacement',
    !awayStates.includes('driving') && boundaries.has(created.id), JSON.stringify(awayStates));
  await assert.rejects(secondRestartedAdapter.attach(created.id, 'live'), /boundary changed/u);
  check('a fresh attach refuses the session changed while the serve was away', true);
  await awayDrive.close();

  // The database itself replaced by a copy holding the very same rows (a restored backup): not the
  // store this Drive proved, so it is not driven on.
  await reseed();
  const replacedDrive = await secondRestartedAdapter.attach(created.id, 'live');
  const checkpoint = new Database(join(root, 'kilo.db'));
  checkpoint.query('pragma wal_checkpoint(TRUNCATE)').run();
  checkpoint.close();
  copyFileSync(join(root, 'kilo.db'), join(root, 'kilo.db.restored'));
  renameSync(join(root, 'kilo.db.restored'), join(root, 'kilo.db'));
  storeChanged('kilo.db');
  await until('the replaced database to demote Drive', () => replacedDrive.info.attachMode === 'observe');
  check('a database replaced by an identical copy demotes Drive', !boundaries.has(created.id));
  await replacedDrive.close();

  // The roster offers Drive only where an attach would take it, from evidence the discovery pass
  // already has (the session's message count, the database's identity), not a history read per row.
  const diskStored = async () => (await discoverKiloStore({
    env: { KILO_DATA_DIR: root }, homeDir: root, includeUnverifiedChildren: true,
  })).find((session) => session.id === diskSession.id)!;
  const diskDrive = async () => (await secondRestartedAdapter.discoverSessions())
    .find((row) => row.id === diskSession.id)?.control?.drive?.supported;
  boundaries.set(diskSession.id, kiloHistorySourceIdentity(await diskStored(), (await readKiloHistory(await diskStored()))!));
  check('the roster offers Drive for an owned session the store still holds as proved', await diskDrive() === true);
  const renamedDrive = async (title: string) =>
    (await secondRestartedAdapter.renameSession!(diskSession.id, title)).control?.drive?.supported;
  check('...and so does the row its rename returns', await renamedDrive('Renamed while proved') === true);
  const terminalRows = new Database(join(root, 'kilo.db'));
  terminalRows.query('insert into message values (?, ?, ?, ?, ?)').run(
    'msg-terminal-roster', diskSession.id, Date.now() + 120_000, Date.now() + 120_000,
    JSON.stringify({ role: 'user', time: { created: Date.now() + 120_000 } }),
  );
  terminalRows.close();
  check('the roster withholds Drive from an owned session another writer added to', await diskDrive() === false);
  check('...and so does the row its rename returns', await renamedDrive('Renamed after another writer') === false);
  await assert.rejects(secondRestartedAdapter.attach(diskSession.id, 'live'), /boundary changed/u);
  check('...which an attach refuses too', true);
  boundaries.set(diskSession.id, kiloHistorySourceIdentity(await diskStored(), (await readKiloHistory(await diskStored()))!));
  const rosterCheckpoint = new Database(join(root, 'kilo.db'));
  rosterCheckpoint.query('pragma wal_checkpoint(TRUNCATE)').run();
  rosterCheckpoint.close();
  copyFileSync(join(root, 'kilo.db'), join(root, 'kilo.db.restored'));
  renameSync(join(root, 'kilo.db.restored'), join(root, 'kilo.db'));
  check('the roster withholds Drive from an owned session whose database was replaced', await diskDrive() === false);
  check('...and so does the row its rename returns', await renamedDrive('Renamed after a replacement') === false);

  // The updater suppression, at the ONE place this adapter starts a kilo child.
  //
  // This existed only as a claim before: `kiloChildEnv` was applied to the env
  // handed to `discoverKiloStore`, which reads it for `XDG_DATA_HOME` and
  // `KILO_DATA_DIR` path resolution and spawns nothing at all. Every real
  // `kilo` start went through `kiloVerifiedInvocation` with a bare environment.
  // Nothing asserted the variable anywhere, so the gap was invisible.
  const probeRoot = mkdtempSync(join(tmpdir(), 'cosyncing-kilo-env-'));
  try {
    const fakeKilo = join(probeRoot, 'kilo');
    const envLog = join(probeRoot, 'env.txt');
    writeFileSync(fakeKilo, `#!/usr/bin/env bash\n`
      + `printf '%s' "\${KILO_DISABLE_AUTOUPDATE-<unset>}" > ${JSON.stringify(envLog)}\n`
      + `echo "kilo ${KILO_MEASURED_VERSIONS[0]}"\n`, { mode: 0o755 });
    // PATH is left alone: `fakeKilo` is absolute, and narrowing PATH to the
    // temp dir would strand the script's own `#!/usr/bin/env bash`.
    const invocation = await kiloVerifiedInvocation(fakeKilo, process.env);
    check('the measured fake kilo is admitted, so the probe really ran',
      invocation !== undefined);
    check('the kilo version probe starts its child with the in-place updater disabled',
      readFileSync(envLog, 'utf8') === '1',
      `KILO_DISABLE_AUTOUPDATE=${readFileSync(envLog, 'utf8')}`);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
} finally {
  try { streamController?.close(); } catch { /* already cancelled */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, 0 failed`);
