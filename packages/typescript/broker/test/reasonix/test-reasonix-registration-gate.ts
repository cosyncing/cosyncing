#!/usr/bin/env bun
/** Reasonix registration, client-floor, and attach-contract gate. */
export {};
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE,
  BROKER_CONTRACT_REVISION,
} from '@cosyncing/protocol';
import { ReasonixAdapter, REASONIX_CAPABILITIES } from '../../../adapters/reasonix/src/index.ts';
import {
  buildReasonixFixtureTree,
  writeFakeReasonixBinary,
} from '../../../adapters/reasonix/test/fixtures/tree.ts';
import {
  captureProcessOutput,
  isolatedBrokerFixtureEnvironment,
  startHealthyFixtureBroker,
} from '../helpers/isolated-broker-fixture.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';

const ROOT = join(import.meta.dir, '../../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-gate-'));
const home = mkdtempSync(join(tmpdir(), 'cosyncing-reasonix-gate-home-'));
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a fixture port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function fixtureEnvironment(port: number): NodeJS.ProcessEnv {
  return isolatedBrokerFixtureEnvironment(fixtureRoot, {
    overrides: {
      HOST: '127.0.0.1',
      PORT: String(port),
      COSYNCING_HOME: home,
      REASONIX_HOME: join(fixtureRoot, 'reasonix-home'),
      COSYNCING_RESTART_DRY_RUN: '1',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CLAUDE_HOOKS: '0',
    },
  });
}

async function stopBroker(broker: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (broker.exitCode === null) broker.kill('SIGTERM');
  const exited = await Promise.race([
    broker.exited.then(() => true).catch(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && broker.exitCode === null) {
    broker.kill('SIGKILL');
    await broker.exited.catch(() => {});
  }
}

async function withBroker<T>(run: (base: string) => Promise<T>): Promise<T> {
  let output!: ReturnType<typeof captureProcessOutput>;
  const started = await startHealthyFixtureBroker({
    reservePort: freePort,
    spawn: (port) => {
      const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
        cwd: ROOT,
        env: fixtureEnvironment(port),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      output = captureProcessOutput(child, { maxChars: 4_000 });
      return child as unknown as { exitCode: number | null; exited: Promise<number> };
    },
    healthUrl: (port) => `http://127.0.0.1:${port}/api/health`,
    capture: () => output,
    stop: (child) => stopBroker(child as unknown as ReturnType<typeof Bun.spawn>),
  });
  try {
    return await run(`http://127.0.0.1:${started.port}`);
  } finally {
    await stopBroker(started.child as unknown as ReturnType<typeof Bun.spawn>);
  }
}

async function agents(base: string, revision?: string): Promise<Array<Record<string, unknown>>> {
  const query = revision === undefined ? '' : `?contractRevision=${encodeURIComponent(revision)}`;
  const response = await fetch(`${base}/api/agents${query}`);
  if (!response.ok) throw new Error(`/api/agents returned ${response.status}`);
  return response.json() as Promise<Array<Record<string, unknown>>>;
}

const tree = buildReasonixFixtureTree();
try {
  const shipped = shippedAdapters().map((adapter) => adapter.id);
  check('Reasonix is shipped exactly once', shipped.filter((id) => id === 'reasonix').length === 1, shipped.join(','));
  check('doctor diagnoses the same unconditional Reasonix adapter',
    defaultDoctorAdapters({}).some((adapter) => adapter.id === 'reasonix'));
  const shippedReasonix = shippedAdapters().find((adapter) => adapter.id === 'reasonix');
  check('the shipped adapter implements its own setup diagnosis', typeof shippedReasonix?.diagnoseSetup === 'function');

  const views = await withBroker(async (base) => ({
    legacy: await agents(base),
    current: await agents(base, String(BROKER_CONTRACT_REVISION)),
    malformed: await agents(base, 'not-a-revision'),
  }));
  for (const [name, rows] of Object.entries(views)) {
    check(`${name} clients receive exactly one Reasonix row`,
      rows.filter((row) => row.id === 'reasonix').length === 1,
      rows.map((row) => String(row.id)).join(','));
  }
  const row = views.current.find((entry) => entry.id === 'reasonix');
  check('the broker serves the declared Reasonix capabilities unchanged',
    JSON.stringify(row?.capabilities) === JSON.stringify(REASONIX_CAPABILITIES),
    JSON.stringify(row?.capabilities));
  check('Reasonix needs no client floor because both wire values are old-decodable',
    shippedReasonix?.minimumClientRevision === undefined
      // `acp-stdio` predates the revision-14 tolerant integration-kind decoder.
      && REASONIX_CAPABILITIES.integrationKind === 'acp-stdio'
      && REASONIX_CAPABILITIES.attachModes.every((mode) => ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode)),
    JSON.stringify(REASONIX_CAPABILITIES));
  check('Reasonix omits a terminal hint until --resume has an exact session-target form',
    (row?.terminalSyncHint ?? null) === null);

  const enBehavior = setupMessages('en').agentBehavior('reasonix');
  const zhBehavior = setupMessages('zh-Hans').agentBehavior('reasonix');
  check('setup explains Reasonix Observe/Create/Resume and no-daemon behavior in both presenters',
    /Observe plus Create\/Resume/.test(enBehavior)
      && /观察、创建和继续/.test(zhBehavior)
      && /没有常驻进程/.test(zhBehavior),
    `${enBehavior} | ${zhBehavior}`);
  const serviceEntries = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('Reasonix has no managed-host service gate',
    !serviceEntries.includes(managedHostGateEnv('reasonix'))
      && shippedReasonix?.integration?.externalHost === undefined);

  const fake = writeFakeReasonixBinary(join(tree.root, 'bin'), tree.id);
  const adapter = new ReasonixAdapter({
    command: fake.path,
    env: {
      ...fake.env,
      REASONIX_HOME: tree.root,
      FAKE_REASONIX_COMMANDS: '1',
    },
  });
  const bare = await adapter.attach(tree.id);
  check('bare attach is Observe and spawns no child', bare.info.attachMode === 'observe' && fake.spawnCount() === 0);
  let bareWriteRejected = false;
  try { await bare.sendPrompt({ text: 'must refuse' }); } catch { bareWriteRejected = true; }
  check('bare Observe refuses writes', bareWriteRejected);
  await bare.close();

  const explicitObserve = await adapter.attach(tree.id, 'observe');
  check('explicit Observe also spawns no child', fake.spawnCount() === 0);
  await explicitObserve.close();
  let undeclaredRefused = false;
  try { await adapter.attach(tree.id, 'live'); } catch { undeclaredRefused = true; }
  check('an undeclared attach mode is refused instead of downgraded', undeclaredRefused);

  const idleAcpMetadata = readFileSync(tree.acpMetadataPath, 'utf8');
  const activeMetadata = JSON.parse(idleAcpMetadata) as Record<string, unknown>;
  activeMetadata.status = { state: 'working' };
  writeFileSync(tree.acpMetadataPath, `${JSON.stringify(activeMetadata)}\n`);
  const activeFake = writeFakeReasonixBinary(join(tree.root, 'bin-active'), tree.id);
  const activeAdapter = new ReasonixAdapter({
    command: activeFake.path,
    env: { ...activeFake.env, REASONIX_HOME: tree.root },
  });
  let activeResumeRefused = false;
  try { await activeAdapter.attach(tree.id, 'resume'); } catch { activeResumeRefused = true; }
  check('Resume refuses a session whose durable ACP status is not idle without spawning a writer',
    activeResumeRefused && activeFake.spawnCount() === 0);
  activeMetadata.status = { state: 'future-active-state' };
  writeFileSync(tree.acpMetadataPath, `${JSON.stringify(activeMetadata)}\n`);
  let unknownResumeRefused = false;
  try { await activeAdapter.attach(tree.id, 'resume'); } catch { unknownResumeRefused = true; }
  check('Resume fails closed on an unknown native status without spawning a writer',
    unknownResumeRefused && activeFake.spawnCount() === 0);
  writeFileSync(tree.acpMetadataPath, idleAcpMetadata);

  const resume = await adapter.attach(tree.id, 'resume');
  check('Resume grants Drive without spawning before command discovery',
    resume.info.control?.drive.state === 'driving' && fake.spawnCount() === 0,
    JSON.stringify(resume.info.control?.drive));
  const commands = await resume.listCommands?.();
  check('runtime command discovery starts one workspace-only ACP child with the stored model',
    fake.spawnCount() === 1
      && commands?.filter((command) => command.name === 'stop' && command.kind === 'action').length === 1
      && commands?.some((command) => command.name === 'review') === true,
    JSON.stringify(commands));
  check('Reasonix keeps existing-session model switching disabled until a native probe proves it',
    REASONIX_CAPABILITIES.supportsModelSwitch === false);
  await resume.sendPrompt({ text: 'start the ACP writer' });
  const spawn = fake.events().find((event) => event.kind === 'spawn');
  check('the first prompt reuses the command-discovery ACP child',
    fake.spawnCount() === 1
      && Array.isArray(spawn?.argv)
      && JSON.stringify(spawn.argv).includes('acp')
      && JSON.stringify(spawn.argv).includes('--workspace-only')
      && JSON.stringify(spawn.argv).includes('provider/model'),
    JSON.stringify(spawn));
  const promptFrames = fake.events().filter((event) => event.kind === 'frame')
    .map((event) => event.frame as { method?: unknown });
  check('the measured prompt route sends no unproved set_config_option request',
    promptFrames.some((frame) => frame.method === 'session/prompt')
      && !promptFrames.some((frame) => frame.method === 'session/set_config_option'),
    JSON.stringify(promptFrames));
  await resume.close();

  const blockedFake = writeFakeReasonixBinary(join(tree.root, 'bin-blocked-load'), tree.id);
  const blockedAdapter = new ReasonixAdapter({
    command: blockedFake.path,
    env: { ...blockedFake.env, REASONIX_HOME: tree.root, FAKE_REASONIX_BLOCK_INITIALIZE: '1' },
  });
  const blocked = await blockedAdapter.attach(tree.id, 'resume');
  const loading = blocked.listCommands?.().then(() => false, () => true) ?? Promise.resolve(false);
  const loadStarted = await waitFor(() => blockedFake.events().some((event) =>
    event.kind === 'frame'
      && typeof event.frame === 'object'
      && event.frame !== null
      && (event.frame as { method?: unknown }).method === 'initialize'));
  (blocked as unknown as { demote(reason: string): void }).demote('fixture foreign write during initialize');
  const loadRejectedPromptly = await Promise.race([
    loading,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  const blockedSpawn = blockedFake.events().find((event) => event.kind === 'spawn');
  const childExited = typeof blockedSpawn?.pid === 'number' && await waitFor(() => {
    try { process.kill(blockedSpawn.pid as number, 0); return false; } catch { return true; }
  }, 1_000);
  check('demotion force-closes an ACP child blocked in initialize',
    loadStarted && loadRejectedPromptly && childExited,
    JSON.stringify({ loadStarted, loadRejectedPromptly, childExited }));
  await blocked.close();

  const delayedLoadFake = writeFakeReasonixBinary(join(tree.root, 'bin-delayed-load'), tree.id);
  const delayedLoadAdapter = new ReasonixAdapter({
    command: delayedLoadFake.path,
    env: { ...delayedLoadFake.env, REASONIX_HOME: tree.root, FAKE_REASONIX_LOAD_DELAY_MS: '200' },
  });
  const delayedLoad = await delayedLoadAdapter.attach(tree.id, 'resume');
  const delayedSend = delayedLoad.sendPrompt({ text: 'must stop before ACP delivery' });
  const delayedLoadStarted = await waitFor(() => delayedLoadFake.events().some((event) =>
    event.kind === 'frame'
      && typeof event.frame === 'object'
      && event.frame !== null
      && (event.frame as { method?: unknown }).method === 'session/load'));
  (delayedLoad as unknown as { cancel(): void }).cancel();
  await delayedSend;
  const delayedFrames = delayedLoadFake.events().filter((event) => event.kind === 'frame')
    .map((event) => event.frame as { method?: unknown });
  check('Stop during session/load prevents the queued prompt from reaching ACP',
    delayedLoadStarted
      && !delayedFrames.some((frame) => frame.method === 'session/prompt'),
    JSON.stringify(delayedFrames));
  await delayedLoad.close();

  const postureFlipFake = writeFakeReasonixBinary(join(tree.root, 'bin-posture-flip'), tree.id);
  const postureFlipAdapter = new ReasonixAdapter({
    command: postureFlipFake.path,
    env: { ...postureFlipFake.env, REASONIX_HOME: tree.root, FAKE_REASONIX_LOAD_DELAY_MS: '200' },
  });
  const postureFlip = await postureFlipAdapter.attach(tree.id, 'resume');
  const postureSend = postureFlip.sendPrompt({ text: 'must not race an external writer' });
  const postureLoadStarted = await waitFor(() => postureFlipFake.events().some((event) =>
    event.kind === 'frame'
      && typeof event.frame === 'object'
      && event.frame !== null
      && (event.frame as { method?: unknown }).method === 'session/load'));
  const externalMetadata = JSON.parse(idleAcpMetadata) as Record<string, unknown>;
  externalMetadata.status = { state: 'working' };
  writeFileSync(tree.acpMetadataPath, `${JSON.stringify(externalMetadata)}\n`);
  let postureRejected = false;
  try { await postureSend; } catch { postureRejected = true; }
  const postureFrames = postureFlipFake.events().filter((event) => event.kind === 'frame')
    .map((event) => event.frame as { method?: unknown });
  check('a native posture flip during session/load prevents the first ACP prompt',
    postureLoadStarted
      && postureRejected
      && !postureFrames.some((frame) => frame.method === 'session/prompt'),
    JSON.stringify(postureFrames));
  await postureFlip.close();
  writeFileSync(tree.acpMetadataPath, idleAcpMetadata);

  const createFake = writeFakeReasonixBinary(join(tree.root, 'bin-create'), 'registration-created-empty');
  const creating = new ReasonixAdapter({
    command: createFake.path,
    env: { ...createFake.env, REASONIX_HOME: tree.root },
  });
  const created = await creating.createSession({
    directory: tree.cwd,
    title: 'must not replace durable title',
    model: { providerID: 'different', modelID: 'spawn-model' },
    permissionMode: 'yolo',
  });
  check('create returns the exact ACP id and requested provisional fields without inventing a durable row',
    created.id === 'registration-created-empty'
      && created.nativeId === 'registration-created-empty'
      && created.title === 'must not replace durable title'
      && created.cwd === tree.cwd
      && created.model === 'different/spawn-model'
      && created.currentMode === 'yolo'
      && created.control?.drive.state === 'observing'
      && (await creating.discoverSessions()).every((row) => row.id !== created.id),
    JSON.stringify(created));
  const createModeFrame = createFake.events().find((event) => event.kind === 'frame'
    && typeof event.frame === 'object'
    && event.frame !== null
    && (event.frame as { method?: unknown }).method === 'session/set_config_option');
  check('create applies and confirms the selected native approval mode on the retained ACP child',
    JSON.stringify((createModeFrame?.frame as { params?: unknown } | undefined)?.params)
      === JSON.stringify({
        sessionId: 'registration-created-empty',
        configId: 'tool_approval',
        value: 'yolo',
      }),
    JSON.stringify(createModeFrame));
  check('the pre-session mode catalog uses the exact measured native vocabulary',
    JSON.stringify((await creating.listModes()).map((mode) => mode.value)) === JSON.stringify(['ask', 'auto', 'yolo']));
  const createdOwner = await creating.attach(created.id, 'resume');
  check('the first Resume adopts the create child instead of spawning or loading another',
    createdOwner === creating.driveConnection(created.id)
      && createFake.spawnCount() === 1
      && !createFake.events().some((event) => event.kind === 'frame'
        && typeof event.frame === 'object'
        && event.frame !== null
        && (event.frame as { method?: unknown }).method === 'session/load'));
  await createdOwner.close();
  check('closing an unmaterialized created owner closes its native ACP session',
    createFake.events().some((event) => event.kind === 'frame'
      && typeof event.frame === 'object'
      && event.frame !== null
      && (event.frame as { method?: unknown }).method === 'session/close'));

  const missingCreateFake = writeFakeReasonixBinary(join(tree.root, 'bin-create-missing'), 'not-in-store');
  const missingCreating = new ReasonixAdapter({
    command: missingCreateFake.path,
    env: { ...missingCreateFake.env, REASONIX_HOME: tree.root },
    pendingCreateTimeoutMs: 40,
  });
  const emptyCreated = await missingCreating.createSession({ directory: tree.cwd });
  const emptyReleased = await waitFor(() => missingCreating.driveConnection(emptyCreated.id) === undefined);
  check('an ACP id with no prompt remains nondurable and its abandoned owner is released',
    emptyCreated.id === 'not-in-store'
      && emptyReleased
      && (await missingCreating.discoverSessions()).every((row) => row.id !== emptyCreated.id));

  const absent = new ReasonixAdapter({ command: 'missing-reasonix-command', env: { PATH: '', REASONIX_HOME: tree.root } });
  let absentRefused = false;
  try { await absent.attach(tree.id, 'resume'); } catch { absentRefused = true; }
  check('Resume without a local Reasonix executable refuses before registering a writer',
    absentRefused && !absent.isDriving(tree.id));

  const prereleaseFake = writeFakeReasonixBinary(join(tree.root, 'bin-prerelease'), tree.id, '1.25.2-beta.1');
  const prerelease = new ReasonixAdapter({
    command: prereleaseFake.path,
    env: { ...prereleaseFake.env, REASONIX_HOME: tree.root },
  });
  let prereleaseRefused = false;
  try { await prerelease.attach(tree.id, 'resume'); } catch { prereleaseRefused = true; }
  check('a prerelease sharing the 1.25.2 numeric core remains Observe-only',
    !prerelease.canCreateSession()
      && prereleaseRefused
      && !prerelease.isDriving(tree.id)
      && prereleaseFake.spawnCount() === 0);
} catch (error) {
  check('registration harness completed', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  tree.cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
