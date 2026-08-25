#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WindowsTaskSchedulerServiceProvider } from '../../../packages/typescript/broker/src/installation/windows-task-scheduler-provider.ts';
import { WindowsTaskSchedulerPowerShellBackend } from '../../../packages/typescript/broker/src/installation/windows-task-scheduler-powershell.ts';
import {
  inspectWindowsActiveInstall,
  windowsActiveInstallManifest,
  writeWindowsActiveInstall,
} from '../../../packages/typescript/broker/src/installation/windows-service-install.ts';
import type { InstalledResourceRecord } from '../../../packages/typescript/broker/src/installation/install-state.ts';
import { captureWindowsProcessSnapshot } from '../../../packages/typescript/broker/src/runtime/windows-process.ts';
import { BROKER_LISTEN_HOST, brokerInternalUrl } from '../../../packages/typescript/broker/src/runtime/configuration.ts';
import { inspectOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../../../packages/typescript/broker/src/security/secure-files.ts';
import {
  classifyWindowsScheduledTask,
  classifyWindowsTaskFolders,
  windowsScheduledTaskIdentity,
  windowsTaskSchedulerSddl,
} from '../../../packages/typescript/broker/src/installation/windows-task-scheduler.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 4 probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE4_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE4_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE4_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE4_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 4 probe requires its native Windows runner environment');
}

const backend = new WindowsTaskSchedulerPowerShellBackend();
const stateHome = win32.join(root, 'state');
const sourceRoot = win32.join(root, 'sources');
const webRoot = win32.join(sourceRoot, 'web');
const application = win32.join(sourceRoot, 'cosyncing');
const runtimePath = process.execPath;
const installationId = `phase4-${runId}`;
const observations: Record<string, unknown> = {};
let provider: WindowsTaskSchedulerServiceProvider | undefined;
let receipts: InstalledResourceRecord[] = [];
let initial: Record<string, unknown> | undefined;
let cleanupComplete = false;
let probeFailed = false;

// The staged application binds the way the real broker does: through the product's own listener constant
// and derived internal URL, imported from the candidate tree rather than restated here. A probe that
// hard-coded 127.0.0.1 would prove only that the probe can type it.
const configurationModuleUrl = pathToFileURL(win32.resolve(
  import.meta.dir, '..', '..', '..',
  'packages', 'typescript', 'broker', 'src', 'runtime', 'configuration.ts',
)).href;

function listenerObservationPath(label: string): string {
  return win32.join(stateHome, `${label}.listener.json`);
}

function applicationSource(label: string, failOnce = false): string {
  return `import { existsSync, writeFileSync } from 'node:fs';\n`
    + `import { join } from 'node:path';\n`
    + `const marker = join(process.env.COSYNCING_HOME, '${label}.marker');\n`
    + (failOnce
      ? `if (!existsSync(marker)) { writeFileSync(marker, 'failed-once'); console.error('${label}-failure'); process.exit(23); }\n`
      : '')
    + `const { BROKER_LISTEN_HOST, brokerInternalUrl } = await import(${JSON.stringify(configurationModuleUrl)});\n`
    + `const server = Bun.serve({ hostname: BROKER_LISTEN_HOST, port: 0, fetch: () => new Response('ok') });\n`
    + `writeFileSync(join(process.env.COSYNCING_HOME, '${label}.listener.json'), JSON.stringify({\n`
    + `  hostname: server.hostname, port: server.port, internalUrl: brokerInternalUrl(server.port),\n`
    + `}));\n`
    + `console.log('${label}-ready');\n`
    + `setInterval(() => console.log('${label}-heartbeat'), 1000);\n`;
}

function makeProvider(versionKey: string, owned: readonly InstalledResourceRecord[] = []): WindowsTaskSchedulerServiceProvider {
  return new WindowsTaskSchedulerServiceProvider({
    context: { platform: 'win32' } as never,
    homeDir: process.env.USERPROFILE!,
    stateHome,
    installationId,
    versionKey,
    cacheRoot: win32.join(root, 'cache'),
    executablePath: application,
    acquisitionExecutablePath: application,
    distribution: 'bun-js',
    runtimePath,
    webDir: webRoot,
    environmentEntries: [
      ['HOME', process.env.USERPROFILE!],
      ['PATH', win32.dirname(runtimePath)],
      ['COSYNCING_HOME', stateHome],
      ['COSYNCING_CACHE_DIR', win32.join(root, 'cache')],
      ['COSYNCING_WEB_DIR', webRoot],
    ],
    taskSchedulerReceiptResources: owned,
    backend,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function logText(candidate: WindowsTaskSchedulerServiceProvider): string {
  try { return readFileSync(candidate.paths.logPath, 'utf8'); } catch { return ''; }
}

try {
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>phase4-v1</title>');
  writeFileSync(application, applicationSource('phase4-v1'));
  provider = makeProvider('phase4-v1');
  const preflight = backend.inspect(provider.identity);
  const orphanPrefix = 'cosyncing:task-scheduler:v1:phase4-';
  if (preflight.task?.ownershipMarker?.startsWith(orphanPrefix)) {
    const orphanInstallationId = preflight.task.ownershipMarker.slice('cosyncing:task-scheduler:v1:'.length);
    backend.uninstall({
      identity: windowsScheduledTaskIdentity(orphanInstallationId, provider.identity.sid),
      sidFolderOwned: true,
      sharedFolderCreated: true,
    });
    observations.recoveredPriorProbe = true;
  }
  initial = await provider.captureTransactionState();
  const before = await provider.inspect();
  if (before.definition !== 'missing') throw new Error('Phase 4 task identity is already in use');

  await provider.installDefinition();
  const installed = await provider.inspect();
  if (installed.definition !== 'current' || installed.environment !== 'current'
      || installed.enabled !== 'enabled' || installed.active !== 'inactive') {
    const snapshot = backend.inspect(provider.identity);
    const expectedSddl = windowsTaskSchedulerSddl(provider.identity.sid);
    throw new Error(`first install did not converge: ${JSON.stringify({
      installed,
      folders: classifyWindowsTaskFolders({
        identity: provider.identity, expectedSddl,
        shared: snapshot.shared, sidFolder: snapshot.sidFolder, sidFolderReceiptOwned: true,
      }),
      task: classifyWindowsScheduledTask({
        actual: snapshot.task,
        expectedIdentity: provider.identity,
        expectedDefinition: JSON.parse(provider.expectedDefinition()),
      }),
      taskSddlCurrent: snapshot.task?.taskSddl === expectedSddl,
      canonicalSddl: {
        expected: expectedSddl.replaceAll(provider.identity.sid, '<SID>'),
        shared: snapshot.shared?.sddl?.replaceAll(provider.identity.sid, '<SID>'),
        sidFolder: snapshot.sidFolder?.sddl?.replaceAll(provider.identity.sid, '<SID>'),
        task: snapshot.task?.taskSddl?.replaceAll(provider.identity.sid, '<SID>'),
      },
      filesystem: {
        serviceRoot: inspectOwnerOnlyDirectory(provider.paths.serviceRoot).status,
        versionsRoot: inspectOwnerOnlyDirectory(provider.paths.versionsRoot).status,
        versionRoot: inspectOwnerOnlyDirectory(provider.paths.versionRoot).status,
        webRoot: inspectOwnerOnlyDirectory(provider.paths.webRoot).status,
        bootstrap: inspectOwnerOnlyFile(provider.paths.bootstrapPath).status,
        activeManifest: inspectOwnerOnlyFile(provider.paths.activeManifestPath).status,
        application: inspectOwnerOnlyFile(provider.paths.applicationPath).status,
        environment: inspectOwnerOnlyFile(provider.paths.environmentPath).status,
      },
    })}`);
  }
  receipts = provider.installedResources();
  provider = makeProvider('phase4-v1', receipts);
  await provider.start();
  await waitFor(async () => (await provider!.inspect()).active === 'active', 'task start');
  await waitFor(() => logText(provider!).includes('phase4-v1-ready'), 'service log');
  const bounded = Bun.spawnSync([...provider.logsCommand({ follow: false, lines: 5 })]);
  if (bounded.exitCode !== 0 || !bounded.stdout.toString().includes('phase4-v1-ready')) {
    throw new Error('bounded service logs did not read the broker output');
  }

  // Loopback binding, proven on the native host rather than asserted from the source constant alone: the
  // scheduled service reports what it bound, and Windows' own listener table is then asked whether anything
  // for that port is reachable off the machine.
  const listenerPath = listenerObservationPath('phase4-v1');
  await waitFor(() => existsSync(listenerPath), 'service listener observation');
  const listener = JSON.parse(readFileSync(listenerPath, 'utf8')) as {
    hostname: string; port: number; internalUrl: string;
  };
  if (listener.hostname !== BROKER_LISTEN_HOST || listener.hostname !== '127.0.0.1') {
    throw new Error(`service bound a non-loopback host: ${JSON.stringify(listener)}`);
  }
  if (listener.internalUrl !== brokerInternalUrl(listener.port)
      || listener.internalUrl !== `http://127.0.0.1:${listener.port}`) {
    throw new Error(`derived internal URL is not the loopback origin: ${JSON.stringify(listener)}`);
  }
  const hostSnapshot = captureWindowsProcessSnapshot();
  if (!hostSnapshot?.listenersOk) throw new Error('Windows listener attribution was unavailable');
  const boundAddresses = hostSnapshot.listeners
    .filter((entry) => entry.port === listener.port)
    .map((entry) => entry.address);
  if (boundAddresses.length === 0) throw new Error('Windows did not report the service listener');
  const offMachine = boundAddresses.filter((address) => address !== '127.0.0.1' && address !== '::1');
  if (offMachine.length > 0) {
    throw new Error(`service listener is reachable off loopback: ${offMachine.join(',')}`);
  }
  observations.loopbackBinding = {
    reportedHost: listener.hostname,
    derivedInternalUrl: listener.internalUrl.replace(String(listener.port), '<port>'),
    windowsBoundAddresses: [...new Set(boundAddresses)].sort(),
  };

  // Connectivity is operator-owned: nothing this service installs may name or invoke a provider. Checked
  // against the live registered task, the staged environment, the service log, and the candidate tree.
  const connectivity = /tailscale/i;
  const installedSnapshot = backend.inspect(provider.identity);
  const retiredProvider = win32.resolve(
    import.meta.dir, '..', '..', '..',
    'packages', 'typescript', 'broker', 'src', 'installation', 'tailscale-serve.ts',
  );
  const surfaces = {
    taskXml: installedSnapshot.task?.xml ?? '',
    environment: readFileSync(provider.paths.environmentPath, 'utf8'),
    serviceLog: logText(provider),
  };
  const named = Object.entries(surfaces)
    .filter(([, value]) => connectivity.test(value))
    .map(([name]) => name);
  if (named.length > 0) throw new Error(`connectivity provider named in ${named.join(',')}`);
  if (existsSync(retiredProvider)) throw new Error('the retired connectivity provider module is present');
  if (receipts.some((receipt) => connectivity.test(receipt.id) || connectivity.test(receipt.target))) {
    throw new Error('a service receipt describes an external route');
  }
  observations.noConnectivityProvider = {
    surfacesChecked: Object.keys(surfaces).sort(),
    retiredProviderModulePresent: false,
    routeReceipts: 0,
  };
  await provider.stop();
  await waitFor(async () => (await provider!.inspect()).active === 'inactive', 'task stop');

  await provider.setEnabled(false);
  if ((await provider.inspect()).enabled !== 'disabled') throw new Error('disabled drift was not observed');
  await provider.installDefinition();
  if ((await provider.inspect()).enabled !== 'enabled') throw new Error('disabled drift was not repaired');
  observations.repeatedSetupAndDriftRepair = true;

  const v1Manifest = readFileSync(provider.paths.activeManifestPath);
  const v2Rollback = makeProvider('phase4-v2', receipts);
  const v2State = await v2Rollback.captureTransactionState();
  writeFileSync(application, applicationSource('phase4-v2'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>phase4-v2</title>');
  await v2Rollback.installDefinition();
  if (inspectWindowsActiveInstall(v2Rollback.paths.activeManifestPath).status !== 'ok') {
    throw new Error('upgrade did not write an active manifest');
  }
  await v2Rollback.uninstall();
  writeFileSync(v2Rollback.paths.activeManifestPath, v1Manifest);
  await v2Rollback.restoreTransactionState(v2State);
  writeFileSync(application, applicationSource('phase4-v1'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>phase4-v1</title>');
  provider = makeProvider('phase4-v1', receipts);
  let rollbackStatus = await provider.inspect();
  if (rollbackStatus.enabled !== 'enabled') {
    await provider.setEnabled(true);
    rollbackStatus = await provider.inspect();
  }
  if (rollbackStatus.definition !== 'current') {
    throw new Error(`upgrade rollback did not restore v1: ${JSON.stringify(rollbackStatus)}`);
  }
  observations.upgradeRollback = true;

  writeFileSync(application, applicationSource('phase4-restart', true));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>phase4-restart</title>');
  const priorReceipts = receipts;
  const restartProvider = makeProvider('phase4-restart', priorReceipts);
  await restartProvider.installDefinition();
  receipts = restartProvider.installedResources();
  provider = makeProvider('phase4-restart', receipts);
  await provider.start();
  await waitFor(() => logText(provider!).includes('phase4-restart-failure'), 'first failed action');
  await waitFor(() => logText(provider!).includes('phase4-restart-ready'), 'Task Scheduler failure restart', 90_000);
  await waitFor(async () => (await provider!.inspect()).active === 'active', 'restarted task');
  await provider.stop();
  await waitFor(async () => (await provider!.inspect()).active === 'inactive', 'restarted task stop');
  observations.restartOnFailure = true;

  writeFileSync(provider.paths.activeManifestPath, '{malformed');
  await provider.start();
  await waitFor(() => logText(provider!).includes('fatal-start active-install-unreadable'), 'fatal startup log');
  await provider.stop();
  await waitFor(async () => (await provider!.inspect()).active === 'inactive', 'fatal task stop');
  writeWindowsActiveInstall(
    provider.paths.activeManifestPath,
    windowsActiveInstallManifest(installationId, 'phase4-restart'),
  );
  observations.fatalLog = true;

  await makeProvider('phase4-restart', priorReceipts).finalizeCommitted();
  if (existsSync(win32.join(provider.paths.versionsRoot, 'phase4-v1'))
      || existsSync(win32.join(provider.paths.versionsRoot, 'phase4-v2'))) {
    throw new Error('superseded receipt-owned version was not removed');
  }
  if (inspectWindowsActiveInstall(provider.paths.activeManifestPath).status !== 'ok') {
    throw new Error('committed active version was lost');
  }
  const finalStatus = await provider.inspect();
  if (finalStatus.definition !== 'current' || finalStatus.environment !== 'current') {
    throw new Error(`committed provider is not current: ${JSON.stringify(finalStatus)}`);
  }
  await provider.uninstall();
  const removed = await provider.inspect();
  if (removed.definition !== 'missing' || removed.environment !== 'missing') {
    throw new Error(`uninstall left owned service state: ${JSON.stringify(removed)}`);
  }
  observations.uninstall = true;
  cleanupComplete = true;

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch, sid: 'current-user' },
    runtime: { bun: Bun.version },
    observations,
    result: 'pass',
  })}\n`);
} catch (error) {
  probeFailed = true;
  throw error;
} finally {
  try {
    if (!cleanupComplete && provider && initial) {
      try {
        await provider.restoreTransactionState(initial);
      } catch (error) {
        if (!probeFailed) throw error;
        process.stderr.write(`phase4-cleanup-failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
