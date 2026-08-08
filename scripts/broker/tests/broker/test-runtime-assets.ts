#!/usr/bin/env bun
/** Embedded-asset, ownership, and empty-directory package acceptance. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CLAUDE_HOOK_LEGACY_MARKER,
  inspectLegacyClaudeHooks,
} from '../../../../packages/typescript/adapters/claude/src/index.ts';
import {
  inspectPiBridgeAsset,
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_LEGACY_MARKER,
} from '../../../../packages/typescript/adapters/pi/src/index.ts';
import { BUILD_INFO, type BuildInfo } from '../../../../packages/typescript/broker/src/build-info.ts';
import { runCli } from '../../../../packages/typescript/broker/src/cli.ts';
import { createSetupDiagnosisContext } from '../../../../packages/typescript/broker/src/diagnosis-context.ts';
import {
  committedInstallState,
  serviceExecutablePath,
} from '../../../../packages/typescript/broker/src/install-state.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../../../packages/typescript/broker/src/configuration.ts';
import { ensureInstallationCredentials } from '../../../../packages/typescript/broker/src/credentials.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/broker/src/product.ts';
import {
  embeddedRuntimeAsset,
  inspectRuntimeAssets,
  resolveFlutterWebRoot,
  RUNTIME_ASSET_MANIFEST,
  serviceFlutterWebRoot,
  type RuntimeAsset,
  type RuntimeAssetReport,
} from '../../../../packages/typescript/broker/src/runtime-assets.ts';
import { brokerRelaunchCommand } from '../../../../packages/typescript/broker/src/service-boundary.ts';
import { browserClientUrl } from '../../../../packages/typescript/broker/src/web-routes.ts';
import {
  brokerServiceLaunchArgv,
  createDurableServiceProvider,
} from '../../../../packages/typescript/broker/src/service-manager.ts';
import {
  captureProcessOutput,
  reserveLoopbackFixturePort,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../helpers/isolated-broker-fixture.ts';
import { verificationEnvironment } from '../../../verification/verification-graph.ts';

const ROOT = join(import.meta.dir, '../../../..');
const CLEAN_ENV = verificationEnvironment();
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(message: string): never {
  throw new Error(message);
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function runProcess(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? CLEAN_ENV,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

interface PackageFixture {
  home: string;
  stateHome: string;
  cache: string;
  claudeConfig: string;
  piAgent: string;
  piBridge: string;
}

function packageFixture(root: string, bridgeContent?: string): PackageFixture {
  const home = join(root, 'home');
  const stateHome = join(home, PRODUCT_IDENTITY.stateDirectoryName);
  const cache = join(home, '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  const claudeConfig = join(home, '.claude');
  const piAgent = join(home, '.pi', 'agent');
  const sessionDirectory = join(piAgent, 'sessions', '--tmp--');
  const piBridge = join(piAgent, 'extensions', 'cosyncing-bridge', 'index.ts');
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  mkdirSync(claudeConfig, { recursive: true });
  writeFileSync(
    join(stateHome, 'install-state.json'),
    `${JSON.stringify(committedInstallState('2026-07-17T00:00:00.000Z'), null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(sessionDirectory, '2026-07-17T00-00-00_fixture.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'fixture', timestamp: '2026-07-17T00:00:00.000Z', cwd: '/tmp' })}\n`,
  );
  if (bridgeContent !== undefined) {
    mkdirSync(join(piAgent, 'extensions', 'cosyncing-bridge'), { recursive: true });
    writeFileSync(piBridge, bridgeContent, { mode: 0o600 });
  }
  return { home, stateHome, cache, claudeConfig, piAgent, piBridge };
}

function packagedEnvironment(fixture: PackageFixture, port: number): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...CLEAN_ENV,
    HOME: fixture.home,
    COSYNCING_HOME: fixture.stateHome,
    COSYNCING_CACHE_DIR: fixture.cache,
    CLAUDE_CONFIG_DIR: fixture.claudeConfig,
    PI_CODING_AGENT_DIR: fixture.piAgent,
    HOST: '127.0.0.1',
    PORT: String(port),
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_CODEX_SYNC_SERVER: '0',
    COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
    // These are deliberately enabled to prove a packaged build ignores the source-only hooks harness.
    COSYNCING_DEV_MODE: '1',
    COSYNCING_CLAUDE_HOOKS: '1',
  };
  delete env.COSYNCING_WEB_DIR;
  delete env.COSYNCING_SERVICE_PROVIDER;
  return env;
}

function configurePackagedFixture(fixture: PackageFixture, port: number): void {
  const internalUrl = `http://127.0.0.1:${port}`;
  writeBrokerConfig({
    ...defaultBrokerConfig(),
    broker: { ...defaultBrokerConfig().broker, port, internalUrl },
  }, fixture.stateHome);
  ensureInstallationCredentials({ home: fixture.stateHome, internalUrl });
}

async function withPackagedBroker(
  binary: string,
  cwd: string,
  fixture: PackageFixture,
  exercise: (base: string) => Promise<void>,
  /** Extra entries the durable service would carry; the default fixture deliberately runs with none. */
  serviceEnvironment: Record<string, string> = {},
): Promise<void> {
  const portLease = await reserveLoopbackFixturePort();
  const port = portLease.port;
  const base = `http://127.0.0.1:${port}`;
  configurePackagedFixture(fixture, port);
  await portLease.release();
  const child = Bun.spawn([binary, 'broker'], {
    cwd,
    env: { ...packagedEnvironment(fixture, port), ...serviceEnvironment },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drained from the start, and unbounded: the checks below read the whole
  // log, and reading the streams only after the exit left nothing draining
  // them while the broker was starting.
  const brokerOutput = captureProcessOutput(child, { maxChars: Infinity });
  let exerciseError: unknown;
  try {
    // Readiness is not one of this suite's assertions, so it gets no
    // wall-clock budget: a packaged broker booting beside other work is slow,
    // not broken.
    await waitForBrokerHealth(child, `${base}/api/health`).catch((error: Error) => {
      throw new Error(`${error.message}\n${brokerOutput.read().trim().slice(-2000)}`);
    });
    await exercise(base);
  } catch (error) {
    exerciseError = error;
  } finally {
    child.kill('SIGTERM');
  }
  const exitCode = await Promise.race([
    child.exited,
    delay(15_000).then(() => fail('compiled broker did not exit after SIGTERM')),
  ]);
  // Awaited: these read the whole log, and the child's exit does not mean its
  // pipes have been drained.
  const logs = await settledProcessOutput(brokerOutput);
  check('compiled empty-directory broker shuts down cleanly', exitCode === 0,
    `exit=${exitCode}, tail=${logs.trim().slice(-180)}`);
  if (exerciseError) throw exerciseError;
  check('compiled broker logs identify cosyncing without source-path failures',
    logs.includes('[cosyncing]') && !/ENOENT.*packages\/(app|adapters)|Cannot find module/i.test(logs),
    logs.trim().slice(-180));
}

async function withSourceBroker(
  fixture: PackageFixture,
  exercise: (base: string) => Promise<void>,
): Promise<void> {
  const portLease = await reserveLoopbackFixturePort();
  const port = portLease.port;
  const base = `http://127.0.0.1:${port}`;
  configurePackagedFixture(fixture, port);
  await portLease.release();
  const child = Bun.spawn(['bun', 'run', 'packages/typescript/broker/src/main.ts'], {
    cwd: ROOT,
    env: packagedEnvironment(fixture, port),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const brokerOutput = captureProcessOutput(child, { maxChars: Infinity });
  let exerciseError: unknown;
  try {
    await waitForBrokerHealth(child, `${base}/api/health`).catch((error: Error) => {
      throw new Error(`${error.message}\n${brokerOutput.read().trim().slice(-2000)}`);
    });
    await exercise(base);
  } catch (error) {
    exerciseError = error;
  } finally {
    child.kill('SIGTERM');
  }
  await Promise.race([
    child.exited,
    delay(15_000).then(() => fail('source broker did not exit after SIGTERM')),
  ]);
  await settledProcessOutput(brokerOutput);
  if (exerciseError) throw exerciseError;
}

// One explicit inventory owns all v1 runtime assets and intentionally excludes Claude hooks.
{
  const required = RUNTIME_ASSET_MANIFEST.filter((asset) => asset.requiredForV1);
  const requiredIds = required.map((asset) => asset.id).sort();
  check('manifest contains exactly the four embedded v1 assets, both service templates included',
    JSON.stringify(requiredIds) === JSON.stringify([
      'pi/cosyncing-bridge/index.ts',
      'service/launchd/cosyncing.plist',
      'service/systemd/cosyncing.service',
      'skill/cosyncing/SKILL.md',
    ]),
    requiredIds.join(','));
  // R9 retired the PoC UI: its unlock prompt was a removable DOM overlay, not an auth boundary. No
  // artifact may embed it again, so the whole manifest — not just the required set — must stay clear of it.
  check('no packaged asset carries the retired PoC UI',
    RUNTIME_ASSET_MANIFEST.every((asset) => !asset.id.includes('poc-ui')
      && !asset.installTarget.includes('poc-ui')),
    RUNTIME_ASSET_MANIFEST.map((asset) => asset.id).join(','));
  check('every required asset has content, byte count, and an exact package hash',
    required.every((asset) => asset.delivery === 'embedded' && typeof asset.content === 'string' &&
      asset.bytes === Buffer.byteLength(asset.content) && asset.sha256 === sha256(asset.content)));
  check('one binary embeds both host service templates and leaves versioned Flutter adjacent',
    RUNTIME_ASSET_MANIFEST.some((asset) => asset.id === 'service/launchd/cosyncing.plist' &&
      asset.delivery === 'embedded' && asset.stage === 'darwin-v1' && asset.requiredForV1) &&
      RUNTIME_ASSET_MANIFEST.some((asset) => asset.id === 'service/systemd/cosyncing.service' &&
        asset.delivery === 'embedded' && asset.stage === 'linux-v1') &&
      RUNTIME_ASSET_MANIFEST.some((asset) => asset.id === 'flutter-web' && asset.delivery === 'adjacent'));
  check('v1 manifest has no Claude hook executable or settings asset',
    RUNTIME_ASSET_MANIFEST.every((asset) => !asset.id.toLowerCase().includes('claude-hook')));

  // The templates carry the WHOLE launch command as one placeholder rather than a single executable plus a
  // hard-coded `broker` argument. A distribution whose launch needs an interpreter in front of the
  // application cannot be expressed by the old shape at all, and a template that still hard-codes the
  // argument list would silently drop the runtime from whichever manager still used it.
  const systemd = embeddedRuntimeAsset('service/systemd/cosyncing.service').content!;
  check('systemd template is embedded, parameterized, and keeps credentials out of argv',
    systemd.includes('Description={{PRODUCT_NAME}} broker') &&
      systemd.includes('ExecStart={{EXEC_START}}') && !systemd.includes('{{EXECUTABLE}}') &&
      systemd.includes('EnvironmentFile={{ENVIRONMENT_FILE}}') && !systemd.includes('COSYNCING_TOKEN='));

  const launchd = embeddedRuntimeAsset('service/launchd/cosyncing.plist').content!;
  check('launchd template is embedded, parameterized, and keeps credentials out of argv',
    launchd.includes('<string>{{LABEL}}</string>') &&
      launchd.includes('{{PROGRAM_ARGUMENTS}}') && !launchd.includes('{{EXECUTABLE}}') &&
      launchd.includes('{{ENVIRONMENT_VARIABLES}}') &&
      launchd.includes('<string>{{STANDARD_OUT_PATH}}</string>') &&
      launchd.includes('<key>RunAtLoad</key>') && !launchd.includes('COSYNCING_TOKEN='));

  // One argv definition, two renderers. If a provider ever built its own command instead of reading this,
  // a Linux and a macOS install of the same package could launch different things.
  check('the service launch argv names the runtime first for a JavaScript install and omits it for a native one',
    JSON.stringify(brokerServiceLaunchArgv({
      executablePath: '/tmp/install/.cosyncing/bin/cosyncing',
      distribution: 'bun-js',
      runtimePath: '/tmp/install/.bun/bin/bun',
    })) === JSON.stringify(['/tmp/install/.bun/bin/bun', '/tmp/install/.cosyncing/bin/cosyncing', 'broker'])
      && JSON.stringify(brokerServiceLaunchArgv({
        executablePath: '/tmp/install/.cosyncing/bin/cosyncing',
        distribution: 'native',
      })) === JSON.stringify(['/tmp/install/.cosyncing/bin/cosyncing', 'broker']));
}

// A source broker refuses the retired PoC mount outright, with no redirect that implies it moved.
{
  const sourceFixture = packageFixture(mkdtempSync(join(tmpdir(), 'cosyncing-source-assets-')));
  try {
    await withSourceBroker(sourceFixture, async (base) => {
      const [index, appJs, bare] = await Promise.all([
        fetch(`${base}/poc-ui/`, { redirect: 'manual' }),
        fetch(`${base}/poc-ui/app.js`, { redirect: 'manual' }),
        fetch(`${base}/poc-ui`, { redirect: 'manual' }),
      ]);
      const body = await index.text();
      check('source broker serves no PoC shell, asset, or redirect at /poc-ui',
        index.status === 404 && appJs.status === 404 && bare.status === 404
          && !bare.headers.get('location')
          && !body.includes(`<title>${PRODUCT_IDENTITY.productName}</title>`),
        `index=${index.status} app=${appJs.status} bare=${bare.status} loc=${bare.headers.get('location')}`);
    });
  } finally {
    rmSync(resolve(sourceFixture.home, '..'), { recursive: true, force: true });
  }
}

// Resolver staging and visible doctor failures are deterministic and directly testable.
{
  const explicit = resolveFlutterWebRoot({
    override: './fixture-web',
    packaged: true,
    executablePath: '/opt/cosyncing/cosyncing',
    version: '1.2.3',
  });
  const adjacent = resolveFlutterWebRoot({
    packaged: true,
    executablePath: '/opt/cosyncing/cosyncing',
    version: '1.2.3',
  });
  const source = resolveFlutterWebRoot({
    packaged: false,
    executablePath: '/unused',
    version: '1.2.3',
    sourceRoot: '/repo/client/build/web',
  });
  check('Flutter resolver separates explicit, packaged-adjacent, and source paths',
    explicit === resolve('./fixture-web') && adjacent === '/opt/cosyncing/cosyncing-web-1.2.3' &&
      source === '/repo/client/build/web');

  const brokerCliSource = readFileSync(join(ROOT, 'packages/typescript/broker/src/cli.ts'), 'utf8');
  const brokerRuntimeSource = readFileSync(join(ROOT, 'packages/typescript/broker/src/runtime.ts'), 'utf8');
  const monorepoClientWebRoot = '../../../../apps/client/build/web';
  check('source broker defaults to the monorepo Flutter web build',
    brokerCliSource.includes(monorepoClientWebRoot) && brokerRuntimeSource.includes(monorepoClientWebRoot));

  const missingId = 'pi/cosyncing-bridge/index.ts' as const;
  const missingManifest = RUNTIME_ASSET_MANIFEST.filter((asset) => asset.id !== missingId);
  const missingReport = inspectRuntimeAssets({ manifest: missingManifest, flutterWebRoot: '/does/not/exist' });
  const missingCheck = missingReport.checks.find((check) => check.id === missingId);
  check('removing one required asset yields a named failing report',
    !missingReport.ok && missingCheck?.status === 'missing' && missingCheck.detail.includes(missingId));

  const tamperedId = 'skill/cosyncing/SKILL.md' as const;
  const tamperedManifest: RuntimeAsset[] = RUNTIME_ASSET_MANIFEST.map((asset) => asset.id === tamperedId
    ? { ...asset, content: `${asset.content}\n<!-- tampered -->` }
    : { ...asset });
  const tamperedReport = inspectRuntimeAssets({ manifest: tamperedManifest });
  check('asset hash drift is a named doctor failure',
    !tamperedReport.ok && tamperedReport.checks.some((item) =>
      item.id === tamperedId && item.status === 'hash-mismatch'));

  // The human render is localized from the language persisted under COSYNCING_HOME, so an empty
  // fixture home keeps this check reading its own English copy rather than the invoking host's choice.
  const realCosyncingHome = process.env.COSYNCING_HOME;
  const cliHome = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-asset-cli-home-'));
  let output = '';
  let doctorCode: number;
  try {
    process.env.COSYNCING_HOME = cliHome;
    doctorCode = await runCli(['doctor'], {
      buildInfo: { ...BUILD_INFO, distribution: 'native' as const, packaged: true },
      inspectRuntimeAssets: (): RuntimeAssetReport => missingReport,
      stdout: { write: (text) => { output += text; } },
      stderr: { write: () => {} },
    });
  } finally {
    if (realCosyncingHome === undefined) delete process.env.COSYNCING_HOME;
    else process.env.COSYNCING_HOME = realCosyncingHome;
    rmSync(cliHome, { recursive: true, force: true });
  }
  check('CLI doctor renders the missing asset and exits nonzero',
    doctorCode === 1 && output.includes('[error]') && output.includes(missingId));

  const relaunch = brokerRelaunchCommand({
    identity: {
      distribution: 'native',
      applicationPath: '/tmp/release/cosyncing',
      packaged: true,
    },
    argv: ['/tmp/release/cosyncing', 'broker'],
  });
  check('packaged restart targets the same executable instead of a repository entry',
    JSON.stringify(relaunch) === JSON.stringify(['/tmp/release/cosyncing', 'broker']));

  // The JavaScript distribution's restart must re-enter Bun PLUS the application. `[<bundle>, 'broker']`
  // would leave the kernel to honour the shebang; `[<bun>, 'broker']` would ask Bun to run a file named
  // `broker`. Either way the broker never comes back, and the failure only shows up on a real restart.
  const jsRelaunch = brokerRelaunchCommand({
    identity: {
      distribution: 'bun-js',
      applicationPath: '/tmp/install/.cosyncing/bin/cosyncing',
      runtimePath: '/tmp/install/.bun/bin/bun',
      packaged: true,
    },
    argv: ['/tmp/install/.bun/bin/bun', '/tmp/install/.cosyncing/bin/cosyncing', 'broker'],
  });
  check('a JavaScript-distribution restart re-enters Bun plus the application, never bare Bun',
    JSON.stringify(jsRelaunch)
      === JSON.stringify(['/tmp/install/.bun/bin/bun', '/tmp/install/.cosyncing/bin/cosyncing', 'broker']));
}

// Hash ownership is authoritative; legacy markers and unrelated content require confirmation.
const ownershipRoot = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-asset-ownership-'));
try {
  const agentDir = join(ownershipRoot, 'agent');
  const bridge = join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
  check('Pi bridge inspection reports a missing target without confirmation',
    inspectPiBridgeAsset(agentDir).status === 'missing' && !inspectPiBridgeAsset(agentDir).requiresConfirmation);
  mkdirSync(join(agentDir, 'extensions', 'cosyncing-bridge'), { recursive: true });
  writeFileSync(bridge, PI_BRIDGE_EMBEDDED_SOURCE);
  const owned = inspectPiBridgeAsset(agentDir);
  check('matching Pi package hash proves ownership',
    owned.status === 'owned' && !owned.requiresConfirmation && owned.actualSha256 === PI_BRIDGE_EMBEDDED_SHA256);
  writeFileSync(bridge, `// ${PI_BRIDGE_LEGACY_MARKER}\n// repo-era local edits\n`);
  const legacy = inspectPiBridgeAsset(agentDir);
  check('legacy Pi marker is secondary evidence that requires confirmation',
    legacy.status === 'legacy-marker' && legacy.requiresConfirmation);
  writeFileSync(bridge, '// user-owned extension\n');
  const unrelated = inspectPiBridgeAsset(agentDir);
  check('unrelated Pi content is preserved as unowned and requires confirmation',
    unrelated.status === 'unowned' && unrelated.requiresConfirmation);

  const claudeSettings = join(ownershipRoot, 'claude', 'settings.json');
  mkdirSync(join(ownershipRoot, 'claude'), { recursive: true });
  writeFileSync(claudeSettings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'user-hook' }] }] } }));
  check('unrelated Claude settings are not classified as package-owned hooks',
    inspectLegacyClaudeHooks(claudeSettings).status === 'absent');
  writeFileSync(claudeSettings, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ command: 'user-hook' }] },
        { hooks: [{ command: `bun /repo/${CLAUDE_HOOK_LEGACY_MARKER}.ts idle` }] },
      ],
    },
  }));
  const legacyClaude = inspectLegacyClaudeHooks(claudeSettings);
  check('legacy Claude marker is counted without exposing commands and requires confirmation',
    legacyClaude.status === 'legacy-marker' && legacyClaude.entryCount === 1 &&
      legacyClaude.requiresConfirmation && !('command' in legacyClaude));
  writeFileSync(claudeSettings, '{not-json');
  check('unreadable Claude settings fail closed for future repair',
    inspectLegacyClaudeHooks(claudeSettings).status === 'unreadable' &&
      inspectLegacyClaudeHooks(claudeSettings).requiresConfirmation);
} finally {
  rmSync(ownershipRoot, { recursive: true, force: true });
}

// Compile once, copy only the primary artifact into an otherwise empty directory, and exercise it there.
const packageRoot = mkdtempSync(join(tmpdir(), 'cosyncing-runtime-asset-package-'));
try {
  const buildDirectory = join(packageRoot, 'build');
  const runtimeDirectory = join(packageRoot, 'empty-runtime');
  const builtBinary = join(buildDirectory, PRODUCT_IDENTITY.primaryBinary);
  const runtimeBinary = join(runtimeDirectory, PRODUCT_IDENTITY.primaryBinary);
  mkdirSync(buildDirectory, { recursive: true });
  mkdirSync(runtimeDirectory, { recursive: true });
  const build = await runProcess(['bun', 'run', 'scripts/broker/build-broker.ts', '--outfile', builtBinary]);
  check('compiled broker asset build succeeds', build.exitCode === 0, build.stderr.trim().slice(0, 180));
  copyFileSync(builtBinary, runtimeBinary);
  chmodSync(runtimeBinary, 0o755);
  check('runtime directory starts with only the copied primary artifact',
    JSON.stringify(readdirSync(runtimeDirectory)) === JSON.stringify([PRODUCT_IDENTITY.primaryBinary]));

  const doctorFixture = packageFixture(join(packageRoot, 'doctor-fixture'));
  const doctorBefore = [...readdirSync(doctorFixture.stateHome)].sort();
  const doctor = await runProcess([runtimeBinary, 'doctor', '--json'], {
    cwd: runtimeDirectory,
    env: packagedEnvironment(doctorFixture, 1),
  });
  const doctorJson = JSON.parse(doctor.stdout) as {
    ok?: boolean;
    sections?: Array<{ id?: string; checks?: Array<{ id?: string; status?: string; evidence?: { required?: boolean } }> }>;
  };
  const packageChecks = doctorJson.sections?.find((section) => section.id === 'package')?.checks ?? [];
  check('copied artifact doctor validates every embedded required asset',
    doctor.exitCode === 1 && doctorJson.ok === false &&
      packageChecks.filter((item) => item.status === 'pass' && item.evidence?.required === true).length === 4 &&
      packageChecks.every((item) => !String(item.id).includes('poc-ui')),
    doctor.stderr.trim().slice(0, 180));
  check('packaged doctor is read-only',
    JSON.stringify([...readdirSync(doctorFixture.stateHome)].sort()) === JSON.stringify(doctorBefore));

  const help = await runProcess([runtimeBinary, 'help'], {
    cwd: runtimeDirectory,
    env: packagedEnvironment(doctorFixture, 1),
  });
  check('packaged help exposes no Claude hook command or environment path',
    help.exitCode === 0 && !/claude-hook|COSYNCING_CLAUDE_HOOKS|hooks install/i.test(help.stdout));

  const installFixture = packageFixture(join(packageRoot, 'install-fixture'));
  await withPackagedBroker(runtimeBinary, runtimeDirectory, installFixture, async (base) => {
    const indexResponse = await fetch(`${base}/poc-ui/`, { redirect: 'manual' });
    const appResponse = await fetch(`${base}/poc-ui/app.js`, { redirect: 'manual' });
    const [indexHtml, appJs] = await Promise.all([indexResponse.text(), appResponse.text()]);
    // The executable is the shipping artifact, so this is the load-bearing proof that R9's retirement
    // reached the compiled binary and not just the source tree.
    check('the copied executable embeds no PoC UI and serves nothing at /poc-ui',
      indexResponse.status === 404 && appResponse.status === 404 &&
        !indexResponse.headers.get('location') && !appResponse.headers.get('location') &&
        !indexHtml.includes('<h1>cosyncing</h1>') && !appJs.includes('function initSettingsMenu'),
      `index=${indexResponse.status} app=${appResponse.status}`);

    const roster = await fetch(`${base}/api/sessions`);
    check('packaged broker discovers the isolated Pi fixture',
      roster.ok && (await roster.text()).includes('pi'));
    await delay(100);
    check('packaged Pi bridge installs from embedded bytes with owner-only permissions',
      existsSync(installFixture.piBridge) &&
        sha256(readFileSync(installFixture.piBridge, 'utf8')) === PI_BRIDGE_EMBEDDED_SHA256 &&
        (statSync(installFixture.piBridge).mode & 0o777) === 0o600);

    const hookGet = await fetch(`${base}/api/claude/hooks`);
    const hookPost = await fetch(`${base}/api/claude/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install' }),
    });
    const hookProtocol = await fetch(`${base}/claude/hook/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('packaged HTTP surface returns 404 for hook setup and protocol routes',
      hookGet.status === 404 && hookPost.status === 404 && hookProtocol.status === 404,
      `GET=${hookGet.status}, POST=${hookPost.status}, protocol=${hookProtocol.status}`);
    check('packaged COSYNCING_CLAUDE_HOOKS cannot mutate Claude settings',
      !existsSync(join(installFixture.claudeConfig, 'settings.json')));
    check('packaged runtime creates no repository-relative assets beside the binary',
      JSON.stringify(readdirSync(runtimeDirectory)) === JSON.stringify([PRODUCT_IDENTITY.primaryBinary]));

    // The npm tarball routinely ships without the web sidecar, and the directory beside this binary is
    // proven empty by the check above, so /cosy/ here IS the shipping no-web-build answer. It used to hand
    // the end user "run the monorepo client web build with --base-href", which is a maintainer's
    // instruction about a repository they do not have. The packaged answer names the product, says the app
    // is absent, and gives the one command that reaches a client.
    const noWebApp = await fetch(`${base}/cosy/`);
    const noWebAppBody = await noWebApp.text();
    check('the packaged no-web-build page speaks to an end user, not a monorepo developer',
      noWebApp.status === 404
        && (noWebApp.headers.get('content-type') ?? '').includes('text/plain')
        && noWebAppBody.includes(`${PRODUCT_IDENTITY.productName} is running, but this build includes no web app.`)
        && noWebAppBody.includes(`Run \`${PRODUCT_IDENTITY.primaryBinary} pair\` and scan the QR to pair a client.`)
        && !/monorepo|--base-href|Flutter/i.test(noWebAppBody),
      `status=${noWebApp.status} ct=${noWebApp.headers.get('content-type')} body=${JSON.stringify(noWebAppBody)}`);
    // The other half of the R16 outro property: setup prints this exact URL on a no-web build, so the URL
    // it prints has to be the one that serves that page. Built through the same function the outro uses,
    // so the two cannot drift.
    const printed = await fetch(browserClientUrl(base));
    check('the /cosy URL the outro prints on a no-web build serves that page',
      printed.status === noWebApp.status && (await printed.text()) === noWebAppBody,
      `url=${browserClientUrl(base)} status=${printed.status}`);
    // /app is gone, packaged included: a plain unknown-path 404, never the "no web app" page.
    const retired = await fetch(`${base}/app/`, { redirect: 'manual' });
    const unknown = await fetch(`${base}/nothing-here`, { redirect: 'manual' });
    check('a packaged build serves no /app: it is the same 404 as any unknown path',
      retired.status === unknown.status && !retired.headers.get('location')
        && (await retired.text()) === (await unknown.text()),
      `status=${retired.status} loc=${retired.headers.get('location')}`);
  });

  // The durable service execs the bootstrap copy at <home>/bin/cosyncing, and nothing ever puts a web
  // sidecar beside it. Setup measures the sidecar beside the ACQUISITION executable and tells the operator
  // the app is there, so a service left to resolve for itself answers "no web app" on a host where setup
  // said otherwise. The fix is one environment entry, and the only proof that it works is a copied binary
  // that boots with the entry and actually serves the sidecar it could not have found.
  {
    const acquisitionDirectory = join(packageRoot, 'acquisition');
    const acquisitionBinary = join(acquisitionDirectory, PRODUCT_IDENTITY.primaryBinary);
    const sidecar = join(acquisitionDirectory, `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${BUILD_INFO.version}`);
    mkdirSync(sidecar, { recursive: true });
    copyFileSync(builtBinary, acquisitionBinary);
    chmodSync(acquisitionBinary, 0o755);
    const marker = '<!doctype html><title>sidecar fixture</title><p>packaged web sidecar</p>';
    writeFileSync(join(sidecar, 'index.html'), marker);

    const serviceFixture = packageFixture(join(packageRoot, 'service-web-fixture'));
    const serviceTarget = serviceExecutablePath({
      packaged: true,
      home: serviceFixture.stateHome,
      executablePath: acquisitionBinary,
    });
    const webDir = serviceFlutterWebRoot({
      packaged: true,
      executablePath: acquisitionBinary,
      version: BUILD_INFO.version,
    });
    check('the service target and the web root come from different directories, which is the whole defect',
      webDir === sidecar
        && serviceTarget === join(serviceFixture.stateHome, 'bin', PRODUCT_IDENTITY.primaryBinary)
        && resolveFlutterWebRoot({ packaged: true, executablePath: serviceTarget, version: BUILD_INFO.version }) !== webDir,
      `webDir=${webDir} serviceTarget=${serviceTarget}`);

    const provider = createDurableServiceProvider({
      context: createSetupDiagnosisContext(),
      homeDir: serviceFixture.home,
      stateHome: serviceFixture.stateHome,
      cacheRoot: serviceFixture.cache,
      executablePath: serviceTarget,
      distribution: 'native',
      webDir,
    });
    const environmentFile = provider.expectedEnvironment();
    const carried = /^COSYNCING_WEB_DIR="?(.*?)"?$/m.exec(environmentFile)?.[1];
    check('the receipted service environment file carries the resolved web root',
      carried === webDir, `line=${JSON.stringify(carried)}`);

    // The copied binary lives alone in runtimeDirectory — the check above proved that directory holds
    // nothing but the binary — so anything served at /cosy/ here can only have come from the carried path.
    await withPackagedBroker(runtimeBinary, runtimeDirectory, serviceFixture, async (base) => {
      const app = await fetch(`${base}/cosy/`);
      const body = await app.text();
      check('a packaged service install serves the sidecar the copied binary could not have resolved',
        app.status === 200 && body.includes('packaged web sidecar')
          && !body.includes('includes no web app'),
        `status=${app.status} body=${JSON.stringify(body.slice(0, 120))}`);
    }, { COSYNCING_WEB_DIR: carried ?? '' });
  }

  const userBridge = '// user-owned extension — preserve me\n';
  const preserveFixture = packageFixture(join(packageRoot, 'preserve-fixture'), userBridge);
  await withPackagedBroker(runtimeBinary, runtimeDirectory, preserveFixture, async (base) => {
    const roster = await fetch(`${base}/api/sessions`);
    await roster.arrayBuffer();
    await delay(100);
    check('packaged auto-install preserves an unrelated Pi extension',
      readFileSync(preserveFixture.piBridge, 'utf8') === userBridge);
  });
} finally {
  rmSync(packageRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} runtime-asset checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} runtime-asset checks`);
