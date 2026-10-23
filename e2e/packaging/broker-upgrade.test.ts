/**
 * A signed Windows update through the CLI, real Scheduled Tasks, and real HTTP.
 * All tasks use a fixture-only namespace; all agents, state and ports are isolated.
 * Routine CI builds both versions from this tree. Native acceptance may supply
 * COSYNCING_TEST_BASELINE_APPLICATION and COSYNCING_TEST_BASELINE_RUNTIME to run
 * a released updater: only its public trust key, release URL and task namespace
 * are changed to fixture-owned values, and agent endpoints are disabled.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDefines } from '../../scripts/broker/lib/build-metadata.ts';
import { PRODUCT_IDENTITY } from '../../packages/typescript/protocol/src/index.ts';
import { releaseManifestSigningPayload, type ReleaseManifest } from '../../packages/typescript/broker/src/updates/release-upgrade.ts';
import { desktopClientAssetName } from '../../packages/typescript/broker/src/updates/desktop-client-types.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory } from '../../packages/typescript/broker/src/security/secure-files.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../packages/typescript/broker/src/runtime/configuration.ts';
import { writeZipFixture } from '../../packages/typescript/broker/test/helpers/zip-fixture.ts';
import { captureProcessOutput, isolatedBrokerFixtureEnvironment, reserveLoopbackFixturePort } from '../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { eventually, scaled } from '../harness/index.ts';
import { recordHarnessRoot } from '../../scripts/ci/lib/harness-leaks.ts';

const ROOT = join(import.meta.dir, '../..');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(process.platform !== 'win32')('native Windows signed broker update', () => {
  let root: string;
  let home: string;
  let application: string;
  let runtime: string;
  let env: NodeJS.ProcessEnv;
  let url: string;
  let preload: string;
  let namespace: string;
  let server: ReturnType<typeof Bun.serve>;
  let manifest: ReleaseManifest;
  const assets = new Map<string, Uint8Array>();
  const bundles = new Map<string, Uint8Array>();
  const key = generateKeyPairSync('ed25519');
  const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let runtimeArchive: Uint8Array;
  let clientBytes: Uint8Array;
  let helper: string;
  let isolationPrelude: string;

  async function command(args: string[], options: { app?: string; timeoutMs?: number } = {}) {
    const channel = args[0] === 'update' || args[0] === 'upgrade'
      ? ['--manifest', 'https://fixture.invalid/manifest.json'] : [];
    const child = Bun.spawn([runtime, '--preload', preload, options.app ?? application, ...args, ...channel], {
      cwd: ROOT, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const capture = captureProcessOutput(child, { maxChars: 512_000 });
    let timedOut = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, scaled(options.timeoutMs ?? 90_000));
    try {
      const code = await child.exited;
      await capture.done;
      if (code !== 0 && args[0] === 'setup') {
        // Cleanup removes the interrupted transaction. Retain its last action,
        // not credential contents or rollback snapshots, in the failure log.
        let transaction: Record<string, unknown> | undefined;
        try {
          const journal = JSON.parse(readFileSync(join(home, 'transactions/setup.json'), 'utf8'));
          transaction = { stage: journal.stage, inFlight: journal.inFlight?.id,
            applied: journal.applied?.map((action: { id: string }) => action.id),
            updatedAt: journal.updatedAt, failureCode: journal.failureCode };
        } catch { /* setup may have stopped before creating its journal */ }
        console.error(JSON.stringify({ fixtureSetupFailure: { timedOut, elapsedMs: Date.now() - startedAt,
          lockPresent: existsSync(join(home, 'installation.lock')),
          applicationPresent: existsSync(application), transaction } }));
      }
      if (code !== 0 && (args[0] === 'update' || args[0] === 'upgrade')) {
        let outcome: { status?: string; failure?: { health?: { endpoint?: string } } } | undefined;
        try { outcome = JSON.parse(capture.read()); } catch { /* the assertion retains the CLI output */ }
        if (outcome?.failure?.health?.endpoint === '/api/health'
            || outcome?.status === 'rolled-back' && !outcome.failure) {
          const failedAt = Date.now();
          const recoveredHealth = await eventually(async () => {
            const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
            return response.ok ? await response.json() as { version?: string } : undefined;
          }, { timeoutMs: 30_000, what: 'diagnostic health after failed Windows start' }).catch(() => undefined);
          const log = join(home, 'logs/broker.log');
          console.error(JSON.stringify({ fixtureStartupFailure: { recoveredAfterMs: Date.now() - failedAt,
            observedVersion: recoveredHealth?.version, brokerLog: existsSync(log) ? readFileSync(log, 'utf8').slice(-4000) : '(missing)' } }));
        }
      }
      return { code, output: capture.read() };
    } finally { clearTimeout(timer); }
  }

  async function build(version: string): Promise<Uint8Array> {
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, `import { runCli } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/cli/cli.ts'))};
import { runUpgrade } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/updates/release-upgrade.ts'))};
import { createDurableServiceProvider } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/installation/service-manager.ts'))};
import { inspectSetupEnvironment } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/installation/setup.ts'))};
import { acquireInstallationLock } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/installation/installation-lock.ts'))};
import { NativeWindowsTaskSchedulerExecutor } from ${JSON.stringify(join(ROOT, 'packages/typescript/broker/src/installation/windows-task-scheduler-powershell.ts'))};
import { readFileSync, existsSync } from 'node:fs';
const control = process.env.FIXTURE_UPDATE_CONTROL;
const trace = (phase) => {
  if (process.argv[2] === 'setup') console.error(JSON.stringify({ fixtureSetupPhase: phase, at: new Date().toISOString() }));
};
const execute = NativeWindowsTaskSchedulerExecutor.prototype.execute;
NativeWindowsTaskSchedulerExecutor.prototype.execute = function(operation, input) {
  trace('scheduler:' + operation);
  try { return execute.call(this, operation, input); }
  finally { trace('scheduler:' + operation + ':done'); }
};
process.exitCode = await runCli(process.argv.slice(2), {
  setupOverrides: {
    acquireLock: (options) => {
      trace('lock');
      const lock = acquireInstallationLock(options);
      trace('lock:done');
      return lock;
    },
    inspectEnvironment: async (options) => {
      trace('inspect');
      const context = { ...options.context };
      for (const method of ['fetchJson', 'probeTcp', 'runReadOnly', 'listenerProcess']) {
        if (typeof context[method] !== 'function') continue;
        const original = context[method].bind(context);
        context[method] = async (...args) => {
          trace(method + ':' + args[0]);
          try { return await original(...args); }
          finally { trace(method + ':done'); }
        };
      }
      const result = await inspectSetupEnvironment({ ...options, context });
      trace('inspect:done');
      return result;
    },
    durableServiceProviderFactory: (options) => {
    const provider = createDurableServiceProvider(options);
    const inspect = provider.inspect.bind(provider);
    provider.inspect = async () => {
      const status = await inspect();
      if (status.definition === 'unsafe' || status.definition === 'drifted') {
        try { console.error(JSON.stringify({ fixtureService: status, state: await provider.captureTransactionState?.() })); } catch {}
      }
      return status;
    };
    return provider;
  } },
  upgradeTransaction: (dependencies) => runUpgrade({ ...dependencies,
  ...(control && existsSync(control) && JSON.parse(readFileSync(control, 'utf8')).interrupt ? { faultAfter: 'version-activated' } : {}) }) });`);
    const result = await Bun.build({ entrypoints: [entry], target: 'bun', minify: true,
      define: { ...buildDefines({ identity: { version, commit: version === '0.7.0' ? '1111111' : '2222222',
        buildDate: '2026-10-23T00:00:00.000Z', dirty: false }, distribution: 'bootstrap-js', target: 'universal', release: {} }),
        COSYNCING_RELEASE_KEY_ID: JSON.stringify('fixture-update'),
        COSYNCING_RELEASE_PUBLIC_KEY_PEM: JSON.stringify(publicPem),
        COSYNCING_RELEASE_MANIFEST_URL: JSON.stringify('https://fixture.invalid/manifest.json'),
        COSYNCING_RELEASE_CHANNEL_MANIFEST_URL: JSON.stringify('https://fixture.invalid/manifest.json') },
      plugins: [{ name: 'isolated-windows-task-namespace', setup(build) {
        build.onLoad({ filter: /[/\\]windows-task-scheduler\.ts$/ }, async ({ path }) => ({ loader: 'ts',
          contents: (await Bun.file(path).text()).replace(/export const WINDOWS_TASK_ROOT_PATH = [^;]+;/,
            `export const WINDOWS_TASK_ROOT_PATH = ${JSON.stringify(namespace)};`) }));
      } }],
    });
    if (!result.success) throw new Error(result.logs.join('\n'));
    // Run isolation before the bundled module initializers too: ESM imports
    // execute before an entry module's body and may resolve profile paths.
    return Buffer.from(`${isolationPrelude}\n${await result.outputs[0]!.text()}`);
  }

  function web(version: string): Uint8Array {
    const pack = join(root, 'pack');
    mkdirSync(join(pack, 'app'), { recursive: true });
    writeFileSync(join(pack, 'app', 'index.html'), '<html>native Windows update fixture</html>');
    writeFileSync(join(pack, 'app', 'version.json'), JSON.stringify({ version }));
    const archive = join(root, 'web.tar.gz');
    const result = Bun.spawnSync([join(process.env.SystemRoot!, 'System32/tar.exe'), '-czf', archive, '-C', pack, 'app'], { stderr: 'pipe' });
    if (!result.success) throw new Error(result.stderr.toString());
    return readFileSync(archive);
  }

  function promote(version: string, webVersion = version): void {
    const bundle = bundles.get(version)!;
    const sidecar = web(webVersion);
    const desktop = writeZipFixture([{ name: 'client/cosyncing.exe', data: clientBytes }]);
    const jsName = 'cosyncing-app.js'; const webName = 'cosyncing-web-app.tar.gz';
    const clientName = desktopClientAssetName('windows-x64', version);
    assets.set(jsName, bundle); assets.set(webName, sidecar); assets.set(clientName, desktop);
    const unsigned = { schemaVersion: 1 as const, product: 'cosyncing' as const, version, channel: 'stable' as const,
      sourceCommit: '2222222', publishedAt: '2026-10-23T00:00:00.000Z', artifacts: [],
      contract: { revision: 35, minimumClientRevision: 16, surfaceHash: 'fnv1a32:00000000' },
      jsApp: { name: jsName, target: 'universal', size: bundle.length, sha256: digest(bundle),
        url: `https://fixture.invalid/${jsName}`, provenanceUrl: 'https://fixture.invalid/provenance',
        minimumBunVersion: Bun.version,
        bunRuntime: { version: Bun.version, archives: { 'windows-x64': [{ asset: 'bun-windows-x64.zip',
          size: runtimeArchive.length, sha256: digest(runtimeArchive) }] } } },
      webApp: { name: webName, mount: '/cosy/', size: sidecar.length, sha256: digest(sidecar),
        url: `https://fixture.invalid/${webName}`, buildId: '0'.repeat(16), cacheManifestSha256: '1'.repeat(64),
        mainDartSha256: '2'.repeat(64), directorySha256: '3'.repeat(64), fileCount: 2 },
      desktopClients: { 'windows-x64': { name: clientName, version, size: desktop.length, sha256: digest(desktop),
        url: `https://fixture.invalid/${clientName}` } } };
    manifest = { ...unsigned, signature: { algorithm: 'ed25519', keyId: 'fixture-update',
      value: sign(null, releaseManifestSigningPayload(unsigned as Omit<ReleaseManifest, 'signature'>), key.privateKey).toString('base64') } } as ReleaseManifest;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cosyncing-e2e-windows-upgrade-'));
    recordHarnessRoot(root);
    const runId = process.env.COSYNCING_WINDOWS_BROKER_RUN_ID ?? 'manual';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) throw new Error('invalid native update fixture run id');
    namespace = `\\Cosyncing-Test-${runId}-${randomUUID()}`;
    env = isolatedBrokerFixtureEnvironment(root, { overrides: { FIXTURE_UPDATE_CONTROL: join(root, 'control.json') } });
    home = env.COSYNCING_HOME!;
    runtime = process.env.COSYNCING_TEST_BASELINE_RUNTIME ?? process.execPath;
    env.PATH = [dirname(process.execPath), dirname(runtime), join(process.env.SystemRoot!, 'System32'),
      join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0')].join(';');
    // A Scheduled Task starts with the service's own environment, not its
    // parent's test environment. Pin these in the fixture entry too, so no
    // service restart can discover or adopt a developer's agent host.
    isolationPrelude = `Object.assign(process.env, ${JSON.stringify({
      ...Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
        'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR',
        'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'COSYNCING_OMP_AGENT_DIR',
        'COSYNCING_OMP_SESSIONS_ROOT', 'REASONIX_HOME', 'GROK_HOME', 'CLINE_DIR',
        'CLINE_DATA_DIR', 'KILO_DATA_DIR', 'COSYNCING_CLINE_BIN', 'COSYNCING_KILO_BIN']
        .filter((name) => env[name] !== undefined).map((name) => [name, env[name]])),
      OPENCODE_URL: env.OPENCODE_URL, COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_TOKDASH_URL: env.COSYNCING_TOKDASH_URL, COSYNCING_DSH_BASE_URL: env.COSYNCING_DSH_BASE_URL,
      COSYNCING_KIMI_MANAGED_HOST: '0', COSYNCING_DSH_MANAGED_HOST: '0',
      COSYNCING_CLINE_MANAGED_HOST: '0', COSYNCING_KILO_MANAGED_HOST: '0',
    })});`;
    const lease = await reserveLoopbackFixturePort(); url = `http://127.0.0.1:${lease.port}`;
    writeBrokerConfig({ ...defaultBrokerConfig(), broker: { port: lease.port, machineLabel: 'native-update-fixture' } } as never, home);
    const acquisition = join(root, 'acquisition'); ensureOwnerOnlyDirectory(acquisition);
    helper = join(acquisition, 'cosyncing');
    preload = join(root, 'release-transport.js');
    writeFileSync(preload, '');
    // Only the explicit old-runtime acceptance path needs to transfer an
    // interpreter. Routine CI already runs on the manifest's exact floor.
    runtimeArchive = writeZipFixture([{ name: 'bun-windows-x64/bun.exe',
      data: process.env.COSYNCING_TEST_BASELINE_RUNTIME ? readFileSync(process.execPath) : Buffer.from('unused fixture runtime'), method: 'deflate' }]);
    assets.set('bun-windows-x64.zip', runtimeArchive);
    clientBytes = readFileSync(join(process.env.SystemRoot!, 'System32', 'cmd.exe'));
    for (const version of ['0.7.0', '2.0.0', '3.0.0']) bundles.set(version, await build(version));
    atomicWriteOwnerOnly(helper, bundles.get('0.7.0')!);
    const baseline = process.env.COSYNCING_TEST_BASELINE_APPLICATION;
    if (baseline) {
      const original = readFileSync(baseline, 'utf8');
      const pem = original.match(/-----BEGIN PUBLIC KEY-----(?:\\n|\r?\n)(?:[A-Za-z0-9+/=]+(?:\\n|\r?\n))+-----END PUBLIC KEY-----(?:\\n|\r?\n)?/g);
      if (!pem?.length) throw new Error('released baseline public trust key was not found');
      // No updater implementation is changed. The test owns this copy, its
      // trust root and task namespace, never the original installed file.
      const adjusted = original.replaceAll('\\\\Cosyncing', namespace.replaceAll('\\', '\\\\'))
        .replaceAll("CreateFolder('Cosyncing',", `CreateFolder('${namespace.slice(1)}',`)
        .replaceAll("DeleteFolder('Cosyncing',", `DeleteFolder('${namespace.slice(1)}',`)
        .replaceAll(pem[0]!, pem[0]!.includes('\n') ? publicPem : publicPem.replaceAll('\n', '\\n'))
        .replace(/https:\/\/github\.com\/cosyncing\/cosyncing\/releases\/[^"'`\s]*\/release-manifest\.json/g,
          'https://fixture.invalid/manifest.json');
      const keyId = original.slice(Math.max(0, original.indexOf(pem[0]!) - 300), original.indexOf(pem[0]!))
        .match(/cosyncing-release-[A-Za-z0-9._-]+/)?.[0];
      if (!keyId) throw new Error('released baseline key id was not found');
      atomicWriteOwnerOnly(helper, adjusted.replaceAll(keyId, 'fixture-update')
        .replace(/^(#![^\n]*\n)/, (firstLine) => `${firstLine}${isolationPrelude}\n`));
    }
    const baselineVersion = JSON.parse((await command(['version', '--json'], { app: helper })).output);
    const baselineWeb = join(acquisition, `cosyncing-web-${baselineVersion.version}`);
    atomicWriteOwnerOnly(join(baselineWeb, 'index.html'), '<html>baseline web fixture</html>');
    atomicWriteOwnerOnly(join(baselineWeb, 'version.json'), JSON.stringify({ version: baselineVersion.version }));
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const name = new URL(request.url).pathname.split('/').pop()!;
      if (name === 'manifest.json') return Response.json(manifest);
      const bytes = assets.get(name);
      return bytes ? new Response(Buffer.from(bytes)) : new Response('fixture asset missing', { status: 404 });
    } });
    writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'fixture.invalid' || url.href.startsWith('https://github.com/oven-sh/bun/releases/download/')) {
    return original(${JSON.stringify(server.url.origin)} + url.pathname, init).then(response =>
      new Response(response.body, { status: response.status, headers: response.headers }));
  }
  return original(input, init);
};`);
    promote('2.0.0');
    await lease.release();
    // Setup chooses the actual per-user Windows service, inside the test-only namespace.
    application = join(home, 'bin', 'cosyncing');
    const setup = await command(['setup', '--yes', '--accept-managed-runtime-ownership',
      '--no-install-agent-skill', '--no-install-claude-mod'], { app: helper });
    expect(setup.code, setup.output).toBe(0);
    // The signed installer writes this receipt; setup owns the separate
    // service ledger. Reproduce both halves of an actual standalone install.
    const installedWeb = join(home, 'bin', `cosyncing-web-${baselineVersion.version}`);
    atomicWriteOwnerOnly(join(installedWeb, 'index.html'), '<html>baseline web fixture</html>');
    atomicWriteOwnerOnly(join(installedWeb, 'version.json'), JSON.stringify({ version: baselineVersion.version }));
    atomicWriteOwnerOnly(join(home, 'bootstrap-receipt'), ['schemaVersion=2', 'product=cosyncing',
      `version=${baselineVersion.version}`, 'target=universal', 'distribution=bootstrap-js', 'host=windows-x64',
      `application=${application}`, `webRoot=${installedWeb}`, `runtime=${runtime}`,
      `sha256=${digest(readFileSync(application))}`, ''].join('\n'));
    await eventually(async () => (await fetch(`${url}/api/health`)).ok, { what: 'isolated scheduled broker' });
    const sessions = await (await fetch(`${url}/api/sessions`, { headers: {
      [PRODUCT_IDENTITY.tokenHeader]: readFileSync(join(home, 'secrets/broker-token'), 'utf8').trim(),
    } })).json() as { sessions?: unknown[] } | unknown[];
    const rows = Array.isArray(sessions) ? sessions : sessions.sessions;
    expect(Array.isArray(rows) && rows.length === 0,
      'The isolated service must not discover sessions from an external agent host.').toBe(true);
    const client = join(env.LOCALAPPDATA!, 'cosyncing', 'client'); ensureOwnerOnlyDirectory(client);
    atomicWriteOwnerOnly(join(client, 'cosyncing.exe'), clientBytes, { mode: 0o700 });
    atomicWriteOwnerOnly(join(home, 'client-receipt'), ['schemaVersion=1', 'product=cosyncing', 'host=windows-x64',
      `path=${client}`, `version=${baselineVersion.version}`, `sha256=${'0'.repeat(64)}`,
      `executableSha256=${digest(clientBytes)}`, ''].join('\n'));
  }, scaled(120_000));

  afterAll(async () => {
    let cleanup: Awaited<ReturnType<typeof command>> | undefined;
    try {
      if (application && existsSync(application)) {
        const receipt = join(home, 'bootstrap-receipt');
        runtime = (existsSync(receipt) ? readFileSync(receipt, 'utf8').match(/^runtime=(.+)$/m)?.[1] : undefined)
          ?? runtime;
        rmSync(env.FIXTURE_UPDATE_CONTROL!, { force: true });
        if (existsSync(join(home, 'upgrade-journal.json'))) await command(['update', '--yes', '--json']);
        if (existsSync(receipt)) runtime = readFileSync(receipt, 'utf8').match(/^runtime=(.+)$/m)?.[1] ?? runtime;
        cleanup = await command(['uninstall', '--yes', '--json']);
      }
    } finally {
      server?.stop(true);
      // Scheduled Tasks are not descendants of the test runner. Even a failed
      // uninstall must not leave a fixture service behind. This namespace and
      // command-line prefix belong solely to the root created by this file.
      if (root && namespace) {
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const script = `$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()
try { $folder = $scheduler.GetFolder(${quote(namespace)}) } catch { $folder = $null }
if ($folder) {
  foreach ($child in @($folder.GetFolders(0))) {
    foreach ($task in @($child.GetTasks(1))) { try { $task.Stop(0) } catch {}; $child.DeleteTask($task.Name, 0) }
    $folder.DeleteFolder($child.Name, 0)
  }
  $scheduler.GetFolder('\\').DeleteFolder(${quote(namespace.slice(1))}, 0)
}
Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('bun.exe', 'cosyncing.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf(${quote(root)}, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
        const child = Bun.spawn([join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const capture = captureProcessOutput(child);
        const timer = setTimeout(() => child.kill(), scaled(30_000));
        try { expect(await child.exited, capture.read()).toBe(0); await capture.done; }
        finally { clearTimeout(timer); }
        rmSync(root, { recursive: true, force: true });
      }
    }
    if (cleanup) expect(cleanup.code, cleanup.output).toBe(0);
  }, scaled(120_000));

  test('a recorded running desktop blocks mutation; an unrecorded client permits the signed upgrade', async () => {
    const client = join(env.LOCALAPPDATA!, 'cosyncing', 'client', 'cosyncing.exe');
    const running = Bun.spawn([client, '/d', '/q', '/c', 'echo fixture-ready & set /p fixture_input='], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const capture = captureProcessOutput(running);
    try {
      await eventually(() => capture.read().includes('fixture-ready'), { what: 'running fixture desktop' });
      const blocked = await command(['update', '--yes', '--json']);
      expect(JSON.parse(blocked.output).detailCode, blocked.output).toBe('desktop-client-running');
    } finally {
      running.stdin.end(); await running.exited; await capture.done;
    }
    // The same image name in a different installation must not block ours.
    // This exercises native executable-path attribution, including when the
    // process table is nonempty after the recorded client has exited.
    const otherPath = join(root, 'unrecorded client 日本語', 'cosyncing.exe');
    atomicWriteOwnerOnly(otherPath, clientBytes, { mode: 0o700 });
    const other = Bun.spawn([otherPath, '/d', '/q', '/c', 'echo fixture-ready & set /p fixture_input='], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const otherOutput = captureProcessOutput(other);
    const upgraded = await (async () => {
      try {
        await eventually(() => otherOutput.read().includes('fixture-ready'), { what: 'unrecorded fixture desktop' });
        return await command(['update', '--yes', '--json']);
      } finally {
        other.stdin.end(); await other.exited; await otherOutput.done;
      }
    })();
    expect(upgraded.code, upgraded.output).toBe(0);
    expect(JSON.parse(upgraded.output).desktopClient?.status, upgraded.output).toBe('updated');
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ version: '2.0.0' });
    expect(await (await fetch(`${url}/cosy/version.json`)).json()).toEqual({ version: '2.0.0' });
    expect(await (await fetch(`${url}/cosy/`)).text()).toContain('native Windows update fixture');
    const state = JSON.parse(readFileSync(join(home, 'install-state.json'), 'utf8'));
    expect(state.installer.version).toBe('2.0.0');
    const pointer = JSON.parse(readFileSync(join(home, 'service/windows/active-install.json'), 'utf8'));
    expect(pointer.versionKey).toStartWith('2.0.0-');
    expect(readFileSync(join(home, 'client-receipt'), 'utf8')).toContain('version=2.0.0');
    // Subsequent commands use the runtime the successful upgrade recorded.
    runtime = readFileSync(join(home, 'bootstrap-receipt'), 'utf8').match(/^runtime=(.+)$/m)![1]!;
    const status = await command(['status', '--json']);
    expect(JSON.parse(status.output).service, status.output).toMatchObject({ mode: 'task-scheduler',
      active: 'active', enabled: 'enabled', definition: 'current', environment: 'current' });
  }, scaled(120_000));

  test('a bad candidate web version rolls back to an answering broker and retains the real probe failure', async () => {
    promote('3.0.0', '9.9.9');
    const failed = await command(['update', '--yes', '--json']);
    const outcome = JSON.parse(failed.output);
    expect(outcome.status, failed.output).toBe('rolled-back');
    expect(outcome.failure, failed.output).toMatchObject({ phase: 'verifying-web', rollback: 'complete',
      health: { statusCode: 200, observedVersion: '9.9.9', expectedVersion: '3.0.0' } });
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ version: '2.0.0' });
    expect(await (await fetch(`${url}/cosy/version.json`)).json()).toEqual({ version: '2.0.0' });
    const saved = JSON.parse(readFileSync(join(home, 'logs/last-upgrade-failure.json'), 'utf8'));
    expect(saved).toEqual(outcome.failure);
    expect(existsSync(join(home, 'upgrade-journal.json'))).toBe(false);
    const doctor = await command(['doctor', '--json']);
    expect(doctor.output).toContain('state.last-upgrade-failure');
    expect(doctor.output).toContain('9.9.9');
  }, scaled(120_000));

  test('interruption after Windows activation recovers the prior task and succeeds on a later retry', async () => {
    promote('3.0.0');
    writeFileSync(env.FIXTURE_UPDATE_CONTROL!, JSON.stringify({ interrupt: true }));
    const interrupted = await command(['update', '--yes', '--json']);
    expect(JSON.parse(interrupted.output).detailCode, interrupted.output).toBe('upgrade-interrupted');
    expect(existsSync(join(home, 'upgrade-journal.json'))).toBe(true);
    rmSync(env.FIXTURE_UPDATE_CONTROL!);
    const recovered = await command(['update', '--yes', '--json']);
    expect(JSON.parse(recovered.output).detailCode, recovered.output).toBe('upgrade-interrupted-recovered');
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ version: '2.0.0' });
    const retried = await command(['update', '--yes', '--json']);
    expect(retried.code, retried.output).toBe(0);
    expect(await (await fetch(`${url}/cosy/version.json`)).json()).toEqual({ version: '3.0.0' });
    expect(existsSync(join(home, 'logs/last-upgrade-failure.json'))).toBe(false);
  }, scaled(120_000));
});
