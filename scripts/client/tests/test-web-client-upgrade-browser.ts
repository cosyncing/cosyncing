#!/usr/bin/env bun
/**
 * Real-browser regression for the pre-c3822fb -> current web-client upgrade.
 *
 * The test compiles the actual historical release in a detached worktree,
 * loads its real service worker in a persistent Chromium profile, switches the
 * origin to the already-built current release, and creates all four supported
 * agent sessions in the expanded tabbed workspace without clearing browser
 * storage.
 *
 *   bun run client:build:web
 *   bun run test:web-client-upgrade
 *   bun run test:web-client-upgrade --old-build-dir /path/to/build/web
 */
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { chromium, type Page } from 'playwright-core';

import { WEB_HANDOFF_DOCUMENT } from '../../../packages/typescript/broker/src/artifacts/web-handoff.ts';
import { BROKER_CONTRACT } from '../../../packages/typescript/protocol/src/index.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const CURRENT_BUILD = join(REPOSITORY_ROOT, 'apps/client/build/web');
const OUTPUT = join(REPOSITORY_ROOT, 'output/web-client-upgrade');
const HISTORICAL_REVISION = 'c3822fb^';
const APP_PATH = '/cosy/';
const BROWSER_ARGS = [
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-features=Vulkan,VizDisplayCompositor',
];

type JsonObject = Record<string, any>;

interface SocketRecord {
  index: number;
  tool: string;
  id: string;
  url: string;
  publishedDriveState: 'driving' | 'observing';
  openedAt: number;
  closedAt: number | null;
}

interface FixtureState {
  activeBuild: 'old' | 'current';
  sessions: JsonObject[];
  sockets: SocketRecord[];
}

interface SocketData {
  tool: string;
  id: string;
  url: string;
  index: number;
}

const argument = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(path, 'utf8')) as JsonObject;

function git(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
  const output = execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });
  return typeof output === 'string' ? output.trim() : '';
}

async function validHistoricalBuild(
  buildDirectory: string,
  sourceCommit: string,
): Promise<boolean> {
  try {
    const identity = await readJson(
      join(buildDirectory, 'cosyncing-build-identity.json'),
    );
    return identity.sourceCommit === sourceCommit
      && identity.dirty === false
      && typeof identity.buildId === 'string'
      && (await Bun.file(join(buildDirectory, 'sw.js')).exists());
  } catch {
    return false;
  }
}

async function historicalBuild(): Promise<{ directory: string; commit: string }> {
  const commit = git(['rev-parse', `${HISTORICAL_REVISION}^{commit}`]);
  const supplied = argument('old-build-dir');
  if (supplied !== undefined) {
    const directory = resolve(supplied);
    assert(
      await validHistoricalBuild(directory, commit),
      `--old-build-dir is not a clean ${commit} web build: ${directory}`,
    );
    return { directory, commit };
  }

  const directory = join(OUTPUT, 'historical', commit, 'web');
  if (await validHistoricalBuild(directory, commit)) {
    return { directory, commit };
  }
  if (await Bun.file(directory).exists()) {
    throw new Error(
      `Refusing to replace an invalid historical build at ${directory}. Remove it and retry.`,
    );
  }

  const worktreeParent = join(OUTPUT, '.worktrees');
  await mkdir(worktreeParent, { recursive: true });
  const worktree = await mkdtemp(join(worktreeParent, 'pre-c3822fb-'));
  // mkdtemp creates the target, while `git worktree add` requires it not to
  // exist. Remove only this just-created, process-owned empty directory.
  await rm(worktree, { recursive: true });
  git(['worktree', 'add', '--detach', worktree, commit], { stdio: 'inherit' });
  try {
    execFileSync('bun', ['run', 'client:build:web'], {
      cwd: worktree,
      stdio: 'inherit',
      env: process.env,
    });
    await mkdir(dirname(directory), { recursive: true });
    await cp(join(worktree, 'apps/client/build/web'), directory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } finally {
    git(['worktree', 'remove', '--force', worktree], { stdio: 'inherit' });
  }
  assert(
    await validHistoricalBuild(directory, commit),
    `historical build did not identify itself as clean ${commit}`,
  );
  return { directory, commit };
}

async function chromiumExecutable(): Promise<string> {
  const explicit = process.env.COSYNCING_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  const shells = (await readdir(cache).catch(() => []))
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));
  if (shells.length === 0) {
    throw new Error('No Chromium headless shell found. Run: npx playwright install chromium-headless-shell');
  }
  return join(
    cache,
    shells[0]!,
    'chrome-headless-shell-linux64/chrome-headless-shell',
  );
}

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function fixtureSession(tool: string, id: string, driving: boolean): JsonObject {
  const openCode = tool === 'opencode';
  return {
    id,
    tool,
    machine: 'upgrade-fixture',
    title: `Upgrade ${tool}`,
    cwd: '/fixture',
    status: 'idle',
    attachMode: openCode ? 'live' : driving ? 'resume' : 'observe',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    control: {
      drive: {
        supported: true,
        state: openCode || driving ? 'driving' : 'observing',
      },
      terminalSync: {
        supported: openCode,
        syncAvailable: openCode,
        active: false,
      },
    },
  };
}

const AGENTS = [
  ['opencode', 'OpenCode', 'http-sse', ['observe', 'resume', 'live']],
  ['codex', 'Codex', 'jsonrpc-stdio', ['live', 'resume', 'observe']],
  ['claude', 'Claude Code', 'sdk-callback', ['observe', 'resume']],
  ['pi', 'Pi', 'jsonrpc-stdio', ['observe', 'resume', 'live']],
].map(([id, displayName, integrationKind, attachModes]) => ({
  id,
  displayName,
  capabilities: {
    integrationKind,
    attachModes,
    supportsObserve: true,
    supportsResume: true,
    supportsLiveAttach: id === 'opencode' || id === 'codex' || id === 'pi',
    supportsNativeArtifact: false,
    supportsNativeFileInput: true,
    supportsModelSwitch: false,
    permissionGranularity: 'per-tool',
  },
  canCreateSession: true,
  canSelectModelAtCreation: false,
  canRenameNative: false,
  canFork: false,
  canClone: false,
  canTranscriptExport: false,
}));

function startFixture(oldBuild: string) {
  let activeBuild: 'old' | 'current' = 'old';
  let sessionSequence = 0;
  let socketSequence = 0;
  const sessions: JsonObject[] = [];
  const sockets: SocketRecord[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    websocket: {
      open(socket) {
        const parameters = new URL(socket.data.url).searchParams;
        const driving = parameters.get('mode') === 'resume';
        const record: SocketRecord = {
          index: socket.data.index,
          tool: socket.data.tool,
          id: socket.data.id,
          url: socket.data.url,
          publishedDriveState: driving || socket.data.tool === 'opencode'
            ? 'driving'
            : 'observing',
          openedAt: Date.now(),
          closedAt: null,
        };
        sockets.push(record);
        const info = fixtureSession(
          socket.data.tool,
          socket.data.id,
          driving || socket.data.tool === 'opencode',
        );
        socket.send(JSON.stringify({
          kind: 'hello',
          broker: { version: '0.1.0', contract: BROKER_CONTRACT },
          clientVersion: '0.1.0',
          compatibility: {
            status: 'compatible',
            readOnly: false,
            reason: 'upgrade fixture',
            broker: BROKER_CONTRACT,
            client: {
              revision: BROKER_CONTRACT.revision,
              minimumBrokerRevision: 0,
              surfaceHash: BROKER_CONTRACT.surfaceHash,
            },
          },
        }));
        socket.send(JSON.stringify({ kind: 'session', info }));
        socket.send(JSON.stringify({
          kind: 'history',
          reset: true,
          messages: [],
          cursor: `upgrade-${socket.data.index}`,
        }));
        socket.send(JSON.stringify({ kind: 'commands', commands: [] }));
        socket.send(JSON.stringify({
          kind: 'options',
          models: [],
          agents: [],
          modes: [],
        }));
      },
      close(socket) {
        const record = sockets.find((candidate) =>
          candidate.index === socket.data.index,
        );
        if (record) record.closedAt = Date.now();
      },
      message() {},
    },
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === '/__fixture/deploy-current'
          && request.method === 'POST') {
        activeBuild = 'current';
        return json({ ok: true });
      }
      if (url.pathname === '/__fixture/state') {
        return json({ activeBuild, sessions, sockets } satisfies FixtureState);
      }
      if (url.pathname === '/api/health') {
        return json({
          ok: true,
          product: 'cosyncing',
          version: '0.1.0',
          contract: BROKER_CONTRACT,
          machine: 'upgrade-fixture',
          healthStatus: 'healthy',
          healthCheckedAt: Date.now(),
        });
      }
      if (url.pathname === '/api/broker/health') {
        return json({
          status: 'healthy',
          checkedAt: Date.now(),
          machine: 'upgrade-fixture',
        });
      }
      if (url.pathname === '/api/agents') return json(AGENTS);
      if (url.pathname === '/api/machines') {
        return json({
          ok: true,
          version: 1,
          machine: 'upgrade-fixture',
          machineId: 'upgrade-fixture',
          generatedAt: Date.now(),
          machines: [],
        });
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        return json({
          sessions,
          machine: 'upgrade-fixture',
          machineId: 'upgrade-fixture',
          generatedAt: Date.now(),
          revision: sessions.length,
        });
      }
      if (url.pathname === '/api/session-roster-deltas') {
        return json({
          revision: sessions.length,
          deltas: [],
          resetRequired: false,
        });
      }
      if (url.pathname === '/api/attention-events') {
        return json({ events: [], nextCursor: 0 });
      }
      if (url.pathname === '/api/schedules') {
        return json({ ok: true, schedules: [] });
      }
      const create = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
      if (create && request.method === 'POST') {
        const tool = decodeURIComponent(create[1]!);
        const id = `${tool}-${++sessionSequence}`;
        const info = fixtureSession(tool, id, false);
        sessions.push(info);
        return json({
          session: info,
          ...(tool === 'opencode' ? {} : { attachMode: 'resume' }),
        });
      }
      const stream = /^\/api\/sessions\/([^/]+)\/([^/]+)\/stream$/.exec(
        url.pathname,
      );
      if (stream) {
        const upgraded = bunServer.upgrade(request, {
          data: {
            tool: decodeURIComponent(stream[1]!),
            id: decodeURIComponent(stream[2]!),
            url: request.url,
            index: ++socketSequence,
          },
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 426 });
      }
      if (url.pathname === '/cosy-handoff') {
        return new Response(WEB_HANDOFF_DOCUMENT, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      if (!url.pathname.startsWith(APP_PATH)) {
        return new Response('not found', { status: 404 });
      }
      const relative = url.pathname.slice(APP_PATH.length) || 'index.html';
      if (relative.split('/').includes('..')) {
        return new Response('bad path', { status: 400 });
      }
      const buildDirectory = activeBuild === 'old' ? oldBuild : CURRENT_BUILD;
      let path = join(buildDirectory, relative);
      let file = Bun.file(path);
      if (!(await file.exists())) {
        if (relative.includes('.')) return new Response('not found', { status: 404 });
        path = join(buildDirectory, 'index.html');
        file = Bun.file(path);
      }
      const noStore = new Set([
        'index.html',
        'flutter_bootstrap.js',
        'flutter_service_worker.js',
        'sw.js',
        'version.json',
        'cosyncing-build-identity.json',
      ]).has(relative);
      return new Response(file, {
        headers: {
          'content-type': MIME[extname(path)] ?? 'application/octet-stream',
          'cache-control': noStore ? 'no-store' : 'max-age=300',
        },
      });
    },
  });
  return server;
}

async function enableFlutterSemantics(page: Page): Promise<void> {
  const placeholder = page.locator('flt-semantics-placeholder');
  if (await placeholder.count()) await placeholder.dispatchEvent('click');
}

async function workerIdentity(page: Page): Promise<JsonObject | null> {
  return await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) return null;
    return await new Promise<Record<string, unknown> | null>((resolveIdentity) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolveIdentity(null), 2_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolveIdentity(event.data as Record<string, unknown>);
      };
      navigator.serviceWorker.controller.postMessage(
        { type: 'cosyncing-build-identity' },
        [channel.port2],
      );
    });
  });
}

async function fixtureState(page: Page): Promise<FixtureState> {
  return await page.evaluate(async () =>
    await fetch('/__fixture/state', { cache: 'no-store' }).then(
      (response) => response.json(),
    ) as FixtureState,
  );
}

async function createSession(
  page: Page,
  tool: string,
  displayName: string,
): Promise<{ id: string; socket: SocketRecord }> {
  await page.getByRole('button', { name: /^(New|New session)$/ }).click();
  await page.getByRole('button', { name: /^Agent/ }).click();
  await page.getByRole('menuitem', { name: displayName, exact: true }).click();
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST'
      && url.pathname === `/api/sessions/${tool}`;
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const createResponse = await createResponsePromise;
  assert.equal(createResponse.ok(), true, `${displayName} create request failed`);
  const created = await createResponse.json() as JsonObject;
  const id = created.session?.id as string | undefined;
  assert(id, `${displayName} create response has no session id`);

  await page.waitForFunction(
    async ({ sessionId, agentTool }) => {
      const state = await fetch('/__fixture/state', { cache: 'no-store' }).then(
        (response) => response.json(),
      ) as FixtureState;
      return state.sockets.some((socket) => {
        if (socket.id !== sessionId || socket.closedAt !== null) return false;
        const parameters = new URL(socket.url).searchParams;
        return agentTool === 'opencode'
          ? parameters.get('mode') === null && parameters.get('reason') === null
          : parameters.get('mode') === 'resume'
              && parameters.get('reason') === 'create';
      });
    },
    { sessionId: id, agentTool: tool },
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (agentTool) => {
      const labels = [...document.querySelectorAll('[aria-label]')]
        .map((element) => element.getAttribute('aria-label'));
      return labels.some((label) => label?.includes(`Upgrade ${agentTool}`));
    },
    tool,
    { timeout: 30_000 },
  );
  // The launch page releases its temporary provider lease after the
  // destination frame. Observing the same socket after that frame proves
  // Session Detail has taken ownership rather than briefly painting Drive.
  await page.waitForTimeout(300);

  const state = await fixtureState(page);
  const owned = state.sockets.filter((socket) => socket.id === id);
  assert.equal(owned.length, 1, `${displayName} must own exactly one detail socket`);
  const socket = owned[0]!;
  assert.equal(socket.closedAt, null, `${displayName} socket closed before Detail took over`);
  assert.equal(
    socket.publishedDriveState,
    'driving',
    `${displayName} detail socket must receive the broker's Driving frame`,
  );
  const parameters = new URL(socket.url).searchParams;
  if (tool === 'opencode') {
    assert.equal(parameters.get('mode'), null, 'OpenCode must keep its live attach');
    assert.equal(parameters.get('reason'), null, 'OpenCode must not request create Resume');
  } else {
    assert.equal(parameters.get('mode'), 'resume', `${displayName} must request Drive`);
    assert.equal(parameters.get('reason'), 'create', `${displayName} must carry create authority`);
  }
  return { id, socket };
}

await mkdir(OUTPUT, { recursive: true });
const historical = await historicalBuild();
const oldIdentity = await readJson(
  join(historical.directory, 'cosyncing-build-identity.json'),
);
const currentIdentity = await readJson(
  join(CURRENT_BUILD, 'cosyncing-build-identity.json'),
).catch(() => {
  throw new Error(`No current stamped build at ${CURRENT_BUILD}. Run: bun run client:build:web`);
});
const currentSourceCommit = git(['rev-parse', 'HEAD']);
assert.equal(
  currentIdentity.sourceCommit,
  currentSourceCommit,
  'the current browser fixture must be built from HEAD; rebuild it before running this regression',
);
assert.equal(
  currentIdentity.dirty,
  false,
  'the current browser fixture must come from a clean tree so its executing-bundle identity is exact',
);
assert.notEqual(
  oldIdentity.buildId,
  currentIdentity.buildId,
  'historical and current builds must have distinct cache identities',
);

const server = startFixture(historical.directory);
const origin = server.url.origin;
const base = `${origin}${APP_PATH}`;
const profileParent = join(OUTPUT, '.profiles');
await mkdir(profileParent, { recursive: true });
const profile = await mkdtemp(join(profileParent, 'persistent-'));
const consoleErrors: string[] = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: await chromiumExecutable(),
    args: BROWSER_ARGS,
    headless: true,
    reducedMotion: 'reduce',
    // Expanded is the regression surface: opening a tab used to mount both
    // Session Detail and the resident Observe supervisor before the launch
    // handoff had established its reason-tagged Resume socket.
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url;
      consoleErrors.push(`${message.text()}${location ? ` (${location})` : ''}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('flt-semantics-placeholder', {
    state: 'attached',
    timeout: 60_000,
  });
  await enableFlutterSemantics(page);
  await page.getByRole('button', { name: /^(New|New session)$/ }).waitFor({
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 30_000 },
  );
  const oldWorker = await workerIdentity(page);
  assert.equal(oldWorker?.version, oldIdentity.buildId, 'the old worker controls the warmed profile');
  const oldExecuting = await page.evaluate(
    () => (window as any).cosyncingExecutingClientBuildIdentity ?? null,
  );
  assert.equal(oldExecuting, null, 'the historical Dart bundle predates the new diagnostic');

  await page.evaluate(async () => {
    const response = await fetch('/__fixture/deploy-current', { method: 'POST' });
    if (!response.ok) throw new Error(`deploy fixture failed: ${response.status}`);
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
  await page.waitForFunction(
    async (buildId) => {
      if (!navigator.serviceWorker.controller) return false;
      const identity = await new Promise<Record<string, unknown> | null>((resolveIdentity) => {
        const channel = new MessageChannel();
        const timer = window.setTimeout(() => resolveIdentity(null), 1_000);
        channel.port1.onmessage = (event) => {
          window.clearTimeout(timer);
          resolveIdentity(event.data as Record<string, unknown>);
        };
        navigator.serviceWorker.controller.postMessage(
          { type: 'cosyncing-build-identity' },
          [channel.port2],
        );
      });
      return identity?.version === buildId;
    },
    currentIdentity.buildId,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    (sourceCommit) =>
      (window as any).cosyncingExecutingClientBuildIdentity?.sourceCommit
        === sourceCommit,
    currentIdentity.sourceCommit,
    { timeout: 60_000 },
  );
  await enableFlutterSemantics(page);
  await page.getByRole('button', { name: /^(New|New session)$/ }).waitFor({
    timeout: 30_000,
  });

  const currentWorker = await workerIdentity(page);
  assert.equal(currentWorker?.version, currentIdentity.buildId, 'the current worker owns the tab');
  const executingClient = await page.evaluate(
    () => (window as any).cosyncingExecutingClientBuildIdentity,
  );
  assert.deepEqual(executingClient, {
    schemaVersion: 1,
    product: 'cosyncing',
    version: currentIdentity.version,
    sourceCommit: currentIdentity.sourceCommit,
    dirty: currentIdentity.dirty,
    contract: {
      revision: currentIdentity.contract.revision,
      minimumBrokerRevision: currentIdentity.contract.clientMinimumBrokerRevision,
      surfaceHash: currentIdentity.contract.surfaceHash,
    },
  });

  const results: JsonObject[] = [];
  for (const [tool, displayName] of [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
    ['pi', 'Pi'],
    ['opencode', 'OpenCode'],
  ]) {
    const result = await createSession(page, tool, displayName);
    results.push({
      tool,
      id: result.id,
      socketUrl: result.socket.url,
      socketOpenAtDetailTakeover: result.socket.closedAt === null,
    });
    if (tool === 'codex') {
      await page.screenshot({
        path: join(OUTPUT, 'codex-driving-after-upgrade.png'),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: /^(New|New session)$/ }).waitFor({
      timeout: 30_000,
    });
  }

  const report = {
    schemaVersion: 1,
    historicalRevision: HISTORICAL_REVISION,
    historicalCommit: historical.commit,
    oldWorkerIdentity: oldWorker,
    currentWorkerIdentity: currentWorker,
    executingClientIdentity: executingClient,
    sessions: results,
    consoleErrors,
  };
  await writeFile(
    join(OUTPUT, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`PASS old-build -> current-build browser upgrade (${results.length} agents)`);
} catch (error) {
  console.error('browser console errors:', JSON.stringify(consoleErrors, null, 2));
  const page = context?.pages()[0];
  if (page && !page.isClosed()) {
    console.error('fixture state:', JSON.stringify(await fixtureState(page), null, 2));
    console.error(
      'browser semantic labels:',
      await page.locator('[aria-label]').evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('aria-label')),
      ).catch(() => []),
    );
    console.error(
      'browser body elements:',
      await page.evaluate(() =>
        [...document.body.querySelectorAll('*')]
          .map((element) => element.tagName.toLowerCase())
          .filter((tag, index, tags) => tags.indexOf(tag) === index),
      ).catch(() => []),
    );
    await page.screenshot({
      path: join(OUTPUT, 'failure.png'),
      fullPage: true,
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await context?.close();
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
