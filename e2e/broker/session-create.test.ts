/**
 * Creating a session from the app: the agent roster says which agents can create one and which can
 * take a model before the session exists; a create lands in the chosen folder with the chosen model
 * and title, a model or mode the agent no longer offers is refused rather than substituted, and the
 * session keeps its app origin, title and model across a broker restart. A create waits for a
 * broker-managed OpenCode serve that is still starting (or restarting) and then creates exactly once,
 * and fails fast with a typed answer when the serve never comes up.
 *
 * Agents are fakes: a `claude` CLI that records each launch, a `cline` CLI that records each call
 * (plus Cline sessions on disk), an OpenCode server the test controls, a compiled `opencode` whose
 * managed serve the test can hold at boot, and a Pi install whose Node is too old or new enough.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { CLINE_MINIMUM_SUPPORTED_VERSION } from '../../packages/typescript/adapters/cline/src/store.ts';
import {
  BROKER_CONTRACT,
  PRODUCT_IDENTITY,
} from '../../packages/typescript/protocol/src/index.ts';
import { type Broker, type BrokerClient, type FixturePaths, eventually, startBroker } from '../harness/index.ts';
import { type FakeClaudeCli, installFakeClaudeCli, promptTexts } from '../harness/fakes/claude-cli.ts';
import { type FakeCommand, installFakeCommand } from '../harness/fakes/command.ts';
import { type FakeOpencode, installFakeOpencode, opencodeServeEnvironment } from '../harness/fakes/opencode.ts';
import { CATALOG_PROVIDER, type FakeOpenCodeCatalog, startFakeOpenCodeCatalog } from '../harness/fakes/opencode-catalog.ts';

const OPUS_HIGH = { providerID: 'anthropic', modelID: 'opus', reasoningEffort: 'high' };

/** A Pi install whose launcher runs under the `node` on PATH, and that `node` reporting `version`. */
function installFakePi(paths: FixturePaths, nodeVersion: string): string {
  installFakeCommand(paths.bin, 'node', `process.stdout.write('v${nodeVersion}\\n');`);
  const packageRoot = join(paths.root, 'pi-package');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  const cli = join(packageRoot, 'dist', 'cli.js');
  writeFileSync(cli, '#!/usr/bin/env node\n');
  chmodSync(cli, 0o755);
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.84.0',
    engines: { node: '>=22.19.0' },
  }));
  const launcherDirectory = join(paths.root, 'pi-launcher');
  mkdirSync(launcherDirectory, { recursive: true });
  symlinkSync(cli, join(launcherDirectory, 'pi'));
  return join(launcherDirectory, 'pi');
}

interface ClineFixture {
  parentId: string;
  childId: string;
  legacyId: string;
  parentTitle: string;
  childTitle: string;
}

/** Native Cline sessions on disk: a parent with one subagent, and another parent titled by an older broker. */
function writeClineSessions(paths: FixturePaths, cwd: string): ClineFixture {
  const parentId = '1788091200000_brk01';
  const childSuffix = 'agent_1788091200001_brk01';
  const legacyId = '1788091300000_brk02';
  const fixture = {
    parentId,
    childId: `${parentId}__${childSuffix}`,
    legacyId,
    parentTitle: 'Native Cline parent',
    childTitle: 'Cline subagent 1788091200001_brk01',
  };
  const writeParent = (id: string, title: string): string => {
    const directory = join(paths.root, 'cline-data', 'sessions', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${id}.json`), `${JSON.stringify({
      session_id: id, cwd, provider: 'openai-compatible', model: 'fixture/model',
      started_at: '2026-09-01T12:00:00.000Z', status: 'idle', metadata: { title },
    })}\n`);
    writeFileSync(join(directory, `${id}.messages.json`), `${JSON.stringify({
      version: 1, agent: 'lead', sessionId: id,
      origin: { source: 'cli', mode: 'user', sessionId: id, version: '3.0.60' },
      updated_at: '2026-09-01T12:00:01.000Z', messages: [],
    })}\n`);
    return directory;
  };
  const parentDirectory = writeParent(parentId, fixture.parentTitle);
  writeParent(legacyId, 'Native title of the older session');
  writeFileSync(join(parentDirectory, `${childSuffix}.messages.json`), `${JSON.stringify({
    version: 1, agent: 'subagent', taskType: 'subagent_task', sessionId: fixture.childId,
    origin: { source: 'cli', mode: 'subagent', sessionId: fixture.childId, parentThreadId: parentId, subagent: childSuffix, version: '3.0.60' },
    updated_at: '2026-09-01T12:00:02.000Z', messages: [],
  })}\n`);
  return fixture;
}

/** What an older broker left: a version-1 metadata file with a session title and a project name. */
function writeLegacyMetadata(paths: FixturePaths, cline: ClineFixture, projectDirectory: string): void {
  const directory = join(paths.home, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session-metadata.json'), JSON.stringify({
    version: 1,
    sessions: { [`cline\0${cline.legacyId}`]: { title: 'Title from an older broker', updatedAt: 1_000 } },
    projects: { [projectDirectory]: { name: 'Project from an older broker', updatedAt: 2_000 } },
  }));
}

function row(rows: any[], tool: string, id: string): any {
  return rows.find((candidate) => candidate.tool === tool && candidate.id === id);
}

describe('creating a session from the app', () => {
  let broker: Broker;
  let client: BrokerClient;
  let claude: FakeClaudeCli;
  let cline: FakeCommand;
  let opencode: FakeOpenCodeCatalog;
  let clineSessions: ClineFixture;
  let workspace: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'create',
      // Drive (resume) needs an authenticated credential, as the app always has.
      token: true,
      setup: (paths) => {
        workspace = join(paths.home, 'projects', 'chosen-folder');
        mkdirSync(workspace, { recursive: true });
        claude = installFakeClaudeCli(paths.bin);
        cline = installFakeCommand(paths.bin, 'cline', [
          `if (argv.includes('--version')) process.stdout.write(${JSON.stringify(`${CLINE_MINIMUM_SUPPORTED_VERSION}\n`)});`,
          'process.exit(0);',
        ].join('\n'));
        opencode = startFakeOpenCodeCatalog(workspace);
        clineSessions = writeClineSessions(paths, workspace);
        writeLegacyMetadata(paths, clineSessions, workspace);
      },
      env: (paths) => ({
        COSYNCING_CLAUDE_BIN: claude.path,
        COSYNCING_CLINE_BIN: cline.path,
        COSYNCING_PI_BIN: installFakePi(paths, '22.19.0'),
        OPENCODE_URL: opencode.url,
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
    opencode?.stop();
  });

  test('the agent roster says who can create a session and pick its model first, and serves their catalogs', async () => {
    const agents = await client.agents();
    const agent = (id: string) => agents.find((candidate) => candidate.id === id);
    // Claude takes a model before the session exists, but its permission mode only per turn.
    expect(agent('claude')).toMatchObject({ canCreateSession: true, canSelectModelAtCreation: true, canSelectPermissionModeAtCreation: false });
    expect(agent('opencode')).toMatchObject({ canCreateSession: true, canSelectModelAtCreation: true });
    expect(agent('pi')?.canCreateSession).toBe(true); // Node 22.19 is new enough

    const claudeCatalog = await client.get('/api/agents/claude/models');
    expect(claudeCatalog.status).toBe(200);
    expect(claudeCatalog.body.tool).toBe('claude');
    expect(claudeCatalog.body.refreshedAt).toBeNumber();
    // One version-neutral identity per alias: the app never shows "Opus 5" for an alias that moves.
    const opus = claudeCatalog.body.models.filter((model: any) => model.providerID === 'anthropic' && model.modelID === 'opus');
    expect(opus).toHaveLength(1);
    expect(opus[0].label).toBe('Opus');

    const openCodeCatalog = await client.get('/api/agents/opencode/models');
    expect(openCodeCatalog.status).toBe(200);
    expect(openCodeCatalog.body.models.some((model: any) => model.providerID === CATALOG_PROVIDER && model.modelID === 'test-model')).toBe(true);
  });

  test('a Claude session starts in the chosen folder with the chosen title and model, and its first turn runs there', async () => {
    const created = await client.post('/api/sessions/claude', { directory: workspace, title: 'Selected Opus', model: OPUS_HIGH });
    expect(created.status).toBe(200);
    const session = created.body.session;
    expect(session).toMatchObject({ tool: 'claude', cwd: workspace, title: 'Selected Opus', launchSurface: 'app' });
    expect(session.currentModel).toEqual({ ...OPUS_HIGH, label: 'Opus' });

    const stream = await client.attach('claude', session.id, { mode: 'resume' });
    const sent = await stream.sendAndAwait({ kind: 'prompt', text: 'first turn', permissionMode: 'plan' });
    expect(sent.kind).toBe('ack');
    const launch = await eventually(
      () => claude.launches().find((candidate) => promptTexts(candidate).includes('first turn')),
      { what: 'Claude launched for the first turn' },
    );
    expect(launch.cwd).toBe(workspace);
    expect(claude.option(launch, '--model')).toBe('opus');
    expect(claude.option(launch, '--effort')).toBe('high');
    expect(claude.option(launch, '--permission-mode')).toBe('plan');
    stream.close();
  });

  test('a create with the agent’s defaults invents no model; a model it does not offer, or a mode it cannot take, is refused', async () => {
    const defaults = await client.post('/api/sessions/claude', { directory: workspace, title: 'Tool default' });
    expect(defaults.status).toBe(200);
    expect(defaults.body.session.currentModel).toBeUndefined();

    const retired = await client.post('/api/sessions/claude', { directory: workspace, model: { providerID: 'anthropic', modelID: 'retired-alias' } });
    expect(retired.status).toBe(409);
    expect(retired.body.code).toBe('MODEL_SELECTION_UNSUPPORTED');
    const mode = await client.post('/api/sessions/claude', { directory: workspace, permissionMode: 'plan' });
    expect(mode.status).toBe(503);
    expect(mode.body.code).toBe('MODE_CATALOG_UNAVAILABLE');
  });

  test('an OpenCode session is created with creation fields only, keeps the chosen model for its first prompt, and opens live', async () => {
    const model = { providerID: CATALOG_PROVIDER, modelID: 'test-model' };
    const before = opencode.creates.length;
    const created = await client.post('/api/sessions/opencode', { directory: workspace, title: 'Selected OpenCode model', model });
    expect(created.status).toBe(200);
    expect(created.body.session.currentModel).toEqual(model);
    expect(created.body.session.cwd).toBe(workspace);
    // A live-only session is opened in the foreground: the app is told so explicitly.
    expect(created.body.attachMode).toBe('live');
    expect(opencode.creates.slice(before)).toEqual([{ title: 'Selected OpenCode model' }]);

    // An application refusal is answered as it is, after one attempt.
    opencode.failNextCreate(422);
    const refused = await client.post('/api/sessions/opencode', { directory: workspace, title: 'Refused' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('422');
    expect(opencode.creates.slice(before)).toHaveLength(2);
  });

  test('a client one contract revision behind can still create a session', async () => {
    const query = new URLSearchParams({
      contractRevision: String(BROKER_CONTRACT.revision - 1),
      minimumBrokerRevision: String(BROKER_CONTRACT.minimumClientRevision - 1),
      // The surface hash is compared only at equal revisions.
      contractSurfaceHash: 'fnv1a32:previous-revision-client',
      clientVersion: '1.0.0',
    });
    const created = await client.post(`/api/sessions/claude?${query}`, { directory: workspace });
    expect(created.status).toBe(200);
  });

  test('renaming a Cline session or subagent with no native rename stores a broker title, and clearing it restores the native one', async () => {
    const stream = await client.attach('cline', clineSessions.parentId);
    const opened = await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.id === clineSessions.parentId);
    expect(opened.info.title).toBe(clineSessions.parentTitle);
    const callsBefore = cline.calls().length;
    const rename = (id: string, title: string | null) =>
      client.request('PATCH', `/api/sessions/cline/${encodeURIComponent(id)}/rename`, { title });

    const parent = await rename(clineSessions.parentId, 'Broker title for the parent');
    expect(parent.status).toBe(200);
    expect(parent.body).toMatchObject({ title: 'Broker title for the parent', session: { title: 'Broker title for the parent' } });
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === 'Broker title for the parent');
    const child = await rename(clineSessions.childId, 'Broker title for the subagent');
    expect(child.body.session.title).toBe('Broker title for the subagent');

    const renamed = await client.sessions({ refresh: true });
    expect(row(renamed, 'cline', clineSessions.parentId)?.title).toBe('Broker title for the parent');
    expect(row(renamed, 'cline', clineSessions.childId)?.title).toBe('Broker title for the subagent');

    const mark = stream.frames.length;
    expect((await rename(clineSessions.parentId, null)).body.title).toBe(clineSessions.parentTitle);
    await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === clineSessions.parentTitle, { after: mark });
    expect((await rename(clineSessions.childId, null)).body.title).toBe(clineSessions.childTitle);
    const restored = await client.sessions({ refresh: true });
    expect(row(restored, 'cline', clineSessions.parentId)?.title).toBe(clineSessions.parentTitle);
    expect(row(restored, 'cline', clineSessions.childId)?.title).toBe(clineSessions.childTitle);
    expect(cline.calls().slice(callsBefore).filter((call) => call.argv[0] === 'history' && call.argv[1] === 'update')).toEqual([]);
    stream.close();
  });

  test('app origin and broker titles survive a restart, and so do the titles an older broker kept', async () => {
    const created = await client.post('/api/sessions/opencode', { directory: workspace, title: 'Created from the app' });
    expect(created.status).toBe(200);
    expect(created.body.session.launchSurface).toBe('app');
    const id = created.body.session.id;
    const renamed = await client.request('PATCH', `/api/sessions/cline/${encodeURIComponent(clineSessions.childId)}/rename`, { title: 'Kept across restarts' });
    expect(renamed.status).toBe(200);

    await broker.restart();
    const rows = await client.sessions({ refresh: true });
    expect(row(rows, 'opencode', id)).toMatchObject({ title: 'Created from the app', launchSurface: 'app' });
    expect(row(rows, 'cline', clineSessions.childId)?.title).toBe('Kept across restarts');
    expect(row(rows, 'cline', clineSessions.parentId)?.launchSurface).not.toBe('app');
    expect(row(rows, 'cline', clineSessions.legacyId)).toMatchObject({
      title: 'Title from an older broker',
      projectName: 'Project from an older broker',
    });
  });
});

describe('creating a session while the managed OpenCode serve starts', () => {
  let broker: Broker;
  let client: BrokerClient;
  let opencode: FakeOpencode;
  let workspace: string;

  beforeAll(async () => {
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    broker = await startBroker({
      name: 'create-managed',
      setup: (paths) => {
        workspace = paths.home;
        opencode = installFakeOpencode(paths, { installed: '1.17.19', holdServe: true });
      },
      env: (paths) => ({
        ...opencodeServeEnvironment(lease.port),
        // A hang detector, far beyond any boot here: the test releases the serve itself.
        COSYNCING_OPENCODE_STARTUP_TIMEOUT_MS: '60000',
        COSYNCING_PI_BIN: installFakePi(paths, '22.14.0'),
      }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    await broker?.stop({ keepState: true });
    opencode?.cleanup();
    await broker?.stop();
  });

  test('a serve still starting is not offered for new sessions; a create waits for it, then creates once', async () => {
    await eventually(() => opencode.ledger().some((entry) => entry.kind === 'serve-waiting'), { what: 'the managed serve to start booting' });
    const agents = await client.agents();
    expect(agents.find((agent) => agent.id === 'opencode')?.canCreateSession).toBe(false);
    // Pi needs Node 22.19; this one runs under 22.14.
    expect(agents.find((agent) => agent.id === 'pi')?.canCreateSession).toBe(false);

    let settled = false;
    const create = client.post('/api/sessions/opencode', { directory: workspace }).finally(() => { settled = true; });
    // A request sent after the create is answered while the create still waits at the boundary.
    expect((await client.get('/api/health')).status).toBe(200);
    expect(settled).toBe(false);
    opencode.configure({ holdServe: false });
    const created = await create;
    expect(created.status).toBe(200);
    expect(created.body.session.id).toStartWith('ses_fake_created_');
    expect(opencode.ledger().filter((entry) => entry.kind === 'create')).toHaveLength(1);
  });

  test('a create during a serve restart waits through it and lands on the new serve, once', async () => {
    const [first] = opencode.serves();
    opencode.configure({ installed: '1.18.0', holdServe: true });
    const restart = client.post('/api/agent-runtime-updates/opencode/restart', { confirmRestart: true });
    await eventually(() => opencode.ledger().filter((entry) => entry.kind === 'serve-waiting').length === 2, {
      what: 'the replacement serve to start booting',
    });

    let settled = false;
    const create = client.post('/api/sessions/opencode', { directory: workspace }).finally(() => { settled = true; });
    expect((await client.get('/api/health')).status).toBe(200);
    expect(settled).toBe(false);
    opencode.configure({ holdServe: false });
    const [restarted, created] = await Promise.all([restart, create]);
    expect(restarted.status).toBe(200);
    expect(created.status).toBe(200);
    const creates = opencode.ledger().filter((entry) => entry.kind === 'create');
    expect(creates).toHaveLength(2);
    const replacement = opencode.serves().at(-1)!;
    expect(replacement.pid).not.toBe(first!.pid);
    expect(creates.at(-1)!.pid).toBe(replacement.pid);
  });
});

describe('creating a session when the managed OpenCode serve never comes up', () => {
  let broker: Broker;
  let opencode: FakeOpencode;

  beforeAll(async () => {
    const lease = await reserveLoopbackFixturePort();
    await lease.release();
    broker = await startBroker({
      name: 'create-absent',
      setup: (paths) => {
        opencode = installFakeOpencode(paths, { installed: '1.17.19', holdServe: true });
      },
      env: { ...opencodeServeEnvironment(lease.port), COSYNCING_OPENCODE_STARTUP_TIMEOUT_MS: '350' },
    });
  });
  afterAll(async () => {
    await broker?.stop({ keepState: true });
    opencode?.cleanup();
    await broker?.stop();
  });

  test('the create ends with a typed, retryable refusal once the startup deadline passes', async () => {
    const refused = await broker.client().post('/api/sessions/opencode', { directory: broker.paths.home });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({
      code: 'SESSION_CREATE_TEMPORARILY_UNAVAILABLE',
      detailCode: 'opencode-server-connection-unavailable',
      retryable: true,
    });
    expect(refused.body.errorType).toBeUndefined();
    expect(opencode.ledger().filter((entry) => entry.kind === 'create')).toEqual([]);
  });
});
