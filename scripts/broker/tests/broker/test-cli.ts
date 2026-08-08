#!/usr/bin/env bun
/** CLI command, first-run, packaging, and foreground-lifecycle acceptance. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  captureProcessOutput,
  settledProcessOutput,
  waitForBrokerHealth,
  type ProcessOutputCapture,
} from '../helpers/isolated-broker-fixture.ts';
import { runCli, type BrokerRuntimeHandle, type CliDependencies } from '../../../../packages/typescript/broker/src/cli.ts';
import {
  persistedCliLanguage,
  renderUninstallPlan,
  renderUninstallResult,
} from '../../../../packages/typescript/broker/src/cli-i18n.ts';
import {
  BUILD_INFO,
  BUILD_INFO_SCHEMA_VERSION,
  type BuildInfo,
} from '../../../../packages/typescript/broker/src/build-info.ts';
import { committedInstallState } from '../../../../packages/typescript/broker/src/install-state.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../../../packages/typescript/broker/src/configuration.ts';
import { ensureInstallationCredentials } from '../../../../packages/typescript/broker/src/credentials.ts';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/broker/src/product.ts';
import { detectBrokerServiceBoundary } from '../../../../packages/typescript/broker/src/service-boundary.ts';
import { ArtifactStore } from '../../../../packages/typescript/broker/src/artifact-store.ts';
import {
  codexTuiReadinessCheck,
  type DoctorReport,
} from '../../../../packages/typescript/broker/src/doctor.ts';
import type { SetupCheck } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { writeSetupState } from '../../../../packages/typescript/broker/src/setup-state.ts';

const ROOT = join(import.meta.dir, '../../../..');
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function buildInfo(packaged: boolean): Readonly<BuildInfo> {
  return {
    schemaVersion: 2,
    version: '1.2.3',
    commit: 'abc123',
    buildDate: '2026-07-16T00:00:00.000Z',
    target: 'bun-linux-x64',
    // `packaged` is derived from the distribution kind in real builds; the fixture keeps them consistent so
    // a CLI surface that branches on either one sees the same artifact it would in production.
    distribution: packaged ? 'native' : 'source',
    packaged,
    dirty: false,
    schemaVersions: BUILD_INFO.schemaVersions,
    contract: BUILD_INFO.contract,
  };
}

async function callCli(
  args: string[],
  overrides: CliDependencies = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    buildInfo: buildInfo(false),
    inspectInstallState: () => ({
      committed: false,
      path: '/tmp/does-not-exist/install-state.json',
      reason: 'missing',
    }),
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    ...overrides,
  });
  return { code, stdout, stderr };
}

const originalCliHome = process.env.COSYNCING_HOME;
const pureCliHome = mkdtempSync(join(tmpdir(), 'cosyncing-cli-unit-'));
process.env.COSYNCING_HOME = pureCliHome;

// Pure command behavior: importing cli.ts above must not start a listener or write user state.
{
  const help = await callCli(['--help']);
  check('source help uses the locked primary and alias names',
    help.code === 0 && help.stdout.includes('cosyncing broker CLI') && help.stdout.includes('cosy command'));
  const brokerHelp = await callCli(['broker', '--help']);
  check('broker --help stays read-only and bypasses first-run inspection',
    brokerHelp.code === 0 && brokerHelp.stdout.includes('cosyncing broker'));

  const invalid = await callCli(['wat']);
  check('unknown command exits 2 with bounded guidance',
    invalid.code === 2 && invalid.stderr.includes('unknown command') && invalid.stderr.includes("cosyncing help"));

  let aliasedUpgradeCalls = 0;
  const aliasedUpgrade = await callCli(['update', '--yes', '--json'], {
    runUpgrade: async (options) => {
      if (options.yes && options.json && options.manifestUrl === undefined) aliasedUpgradeCalls += 1;
      return { exitCode: 0 };
    },
  });
  check('update dispatches as an exact upgrade alias',
    aliasedUpgrade.code === 0 && aliasedUpgradeCalls === 1
      && help.stdout.includes('(alias: update)'));

  const version = await callCli(['version', '--json']);
  const parsed = JSON.parse(version.stdout);
  check('version --json has the stable, redacted schema',
    version.code === 0 && parsed.schemaVersion === BUILD_INFO_SCHEMA_VERSION && parsed.product === 'cosyncing' &&
      parsed.binary === 'cosyncing' && parsed.alias === 'cosy' && parsed.version === '1.2.3' &&
      parsed.packaged === false && parsed.dirty === false &&
      JSON.stringify(parsed.schemaVersions) === JSON.stringify(BUILD_INFO.schemaVersions) &&
      JSON.stringify(parsed.contract) === JSON.stringify(BUILD_INFO.contract) &&
      !('home' in parsed) && !('environment' in parsed));

  // `packaged` alone cannot answer "may this build install a signed native binary over itself". The
  // distribution kind is the field that can, so it has to be on the public surface — and it has to stay
  // consistent with the boolean derived from it, or two callers reading different fields would disagree.
  const packagedVersion = JSON.parse(
    (await callCli(['version', '--json'], { buildInfo: buildInfo(true) })).stdout,
  );
  check('version --json publishes the distribution kind alongside the derived packaged flag',
    parsed.distribution === 'source' && parsed.packaged === false
      && packagedVersion.distribution === 'native' && packagedVersion.packaged === true);

  let setupCalls = 0;
  const missingOwnershipAck = await callCli(['setup', '--yes'], {
    runSetup: async () => { setupCalls += 1; return { exitCode: 0 }; },
  });
  const acceptedSetup = await callCli([
    'setup',
    '--yes',
    '--accept-managed-runtime-ownership',
    '--enable-systemd-lingering',
  ], {
    runSetup: async (options) => {
      setupCalls += options.acceptManagedRuntimeOwnership
          && options.enableSystemdLingering
          && options.installAgentSkill
        ? 1
        : 100;
      return { exitCode: 0 };
    },
  });
  let optOutSeen = false;
  const optedOutSetup = await callCli([
    'setup',
    '--yes',
    '--accept-managed-runtime-ownership',
    '--no-install-agent-skill',
  ], {
    runSetup: async (options) => {
      optOutSeen = options.installAgentSkill === false;
      return { exitCode: 0 };
    },
  });
  check('non-interactive setup requires explicit ownership acknowledgement and separate lingering consent',
    missingOwnershipAck.code === 2
      && missingOwnershipAck.stderr.includes('managed-runtime-ownership-acknowledgement-required')
      && acceptedSetup.code === 0 && setupCalls === 1
      && optedOutSetup.code === 0 && optOutSeen);

  const restartReport = {
    status: 'restart-required' as const,
    customSocket: false,
    staleCandidatePids: [101, 102, 103, 104, 105, 106, 107, 108],
    staleCandidateCount: 12,
    message: `cosyncing started Codex's shared server. Close and reopen 12 already-running Codex terminal(s) so they join it. Use Resume to keep working in the same threads. New Codex terminals will connect automatically.`,
  };
  const doctorFixture = (
    readiness: Parameters<typeof codexTuiReadinessCheck>[0],
    packageOk = true,
  ): DoctorReport => {
    const packageCheck: SetupCheck = packageOk
      ? {
          id: 'package.skill/cosyncing/SKILL.md',
          status: 'pass',
          detailCode: 'asset-ok',
          summary: 'Packaged asset is verified.',
        }
      : {
          id: 'package.skill/cosyncing/SKILL.md',
          status: 'fail',
          detailCode: 'asset-missing',
          summary: 'Packaged asset is missing.',
          remediation: { kind: 'command', command: 'cosyncing repair', message: 'Repair the package.' },
        };
    const readinessCheck = codexTuiReadinessCheck(readiness);
    return {
      schemaVersion: 1,
      product: 'cosyncing',
      version: '1.2.3',
      effects: 'forbidden',
      ok: packageOk,
      summary: {
        pass: packageOk ? 1 : 0,
        warn: readinessCheck.status === 'warn' ? 1 : 0,
        fail: packageOk ? 0 : 1,
        skip: readinessCheck.status === 'skip' ? 1 : 0,
      },
      minimumVersions: [],
      sections: [
        { id: 'package', title: 'Package', checks: [packageCheck] },
        { id: 'agents', title: 'Coding agents', checks: [readinessCheck] },
      ],
    };
  };
  const doctorWarning = await callCli(['doctor'], {
    inspectRuntimeAssets: () => ({
      schemaVersion: 1,
      ok: true,
      checks: [],
    }),
    collectDoctorReport: async () => doctorFixture(restartReport),
  });
  check(
    'doctor prints terminal readiness as [warning] and exits 0',
    doctorWarning.code === 0 &&
      doctorWarning.stdout.includes('[warning] codex.terminal-readiness:') &&
      doctorWarning.stdout.includes('12 already-running Codex terminals must be reopened'),
    doctorWarning.stdout.trim(),
  );

  const doctorUnknown = await callCli(['doctor', '--json'], {
    inspectRuntimeAssets: () => ({
      schemaVersion: 1,
      ok: true,
      checks: [],
    }),
    collectDoctorReport: async () => doctorFixture(restartReport),
  });
  const doctorJson = JSON.parse(doctorUnknown.stdout) as DoctorReport;
  const readinessJsonCheck = doctorJson.sections.flatMap((section) => section.checks)
    .find((check) => check.id === 'codex.terminal-readiness');
  check(
    'doctor JSON folds Codex readiness into the redacted stable check schema',
    doctorUnknown.code === 0 &&
      doctorUnknown.stdout.includes('"schemaVersion": 1') &&
      readinessJsonCheck?.detailCode === 'terminal-restart-required' &&
      readinessJsonCheck.evidence?.count === 12 &&
      !doctorUnknown.stdout.includes('101') &&
      !doctorUnknown.stdout.includes('codexTerminalSync'),
    doctorUnknown.stdout.trim(),
  );

  const badAssetAndWarning = await callCli(['doctor'], {
    inspectRuntimeAssets: () => ({
      schemaVersion: 1,
      ok: false,
      checks: [{ id: 'skill/cosyncing/SKILL.md', required: true, status: 'missing', detail: 'missing-test-fixture' }],
    }),
    collectDoctorReport: async () => doctorFixture(restartReport, false),
  });
  check(
    'doctor exits 1 for missing assets even when readiness is only a warning',
    badAssetAndWarning.code === 1 && badAssetAndWarning.stdout.includes('[error]'),
  );

  const doctorInconclusive = await callCli(['doctor'], {
    inspectRuntimeAssets: () => ({
      schemaVersion: 1,
      ok: true,
      checks: [],
    }),
    collectDoctorReport: async () => doctorFixture({
      status: 'unknown',
      customSocket: false,
      staleCandidatePids: [],
      message: 'metadata scanner crashed at /private/socket',
    }),
  });
  check(
    'doctor renders inconclusive readiness without raw probe detail',
    doctorInconclusive.code === 0 &&
      doctorInconclusive.stdout.includes('[warning] codex.terminal-readiness: Codex terminal attachment could not be confirmed safely.') &&
      !doctorInconclusive.stdout.includes('/private/socket'),
    doctorInconclusive.stdout.trim(),
  );

  writeSetupState({ language: 'zh-Hans' }, pureCliHome);
  const chineseDoctor = await callCli(['doctor'], {
    inspectRuntimeAssets: () => ({ schemaVersion: 1, ok: true, checks: [] }),
    collectDoctorReport: async () => doctorFixture(restartReport),
  });
  const chineseDoctorJson = await callCli(['doctor', '--json'], {
    inspectRuntimeAssets: () => ({ schemaVersion: 1, ok: true, checks: [] }),
    collectDoctorReport: async () => doctorFixture(restartReport),
  });
  const parsedChineseDoctorJson = JSON.parse(chineseDoctorJson.stdout) as DoctorReport;
  check('human doctor follows setup-state.json.language while doctor --json stays English and schema-identical',
    chineseDoctor.stdout.includes('cosyncing 诊断')
      && chineseDoctor.stdout.includes('软件包')
      && chineseDoctor.stdout.includes('[警告] codex.terminal-readiness:')
      && chineseDoctor.stdout.includes('需要重新打开 12 个正在运行的 Codex 终端')
      && chineseDoctor.stdout.includes('汇总：')
      && parsedChineseDoctorJson.sections[0]?.title === 'Package'
      && parsedChineseDoctorJson.sections[1]?.checks[0]?.summary.includes('12 already-running Codex terminals') === true,
    chineseDoctor.stdout.trim());

  const plan = {
    schemaVersion: 1 as const,
    actions: [{ id: 'binary.remove.broker-binary', target: '/fixture/bin/cosyncing', legacy: false }],
    warnings: [],
    advisories: [{
      detailCode: 'acquisition-package-preserved',
      summary: 'The installed binary will be removed; npm uninstall -g cosyncing remains separate.',
    }],
    purgeInventory: [{ id: 'state', path: '/fixture/state' }],
  };
  const planBefore = JSON.stringify(plan);
  const chinesePlan = renderUninstallPlan(plan, persistedCliLanguage(pureCliHome));
  const result = {
    schemaVersion: 1 as const,
    status: 'complete' as const,
    exitCode: 0 as const,
    detailCode: 'uninstall-complete',
    summary: 'Owned integrations were removed; durable state and artifact cache were preserved. The command stays on PATH; npm uninstall -g cosyncing.',
    actions: ['binary.remove.broker-binary'],
  };
  const resultBefore = JSON.stringify(result);
  const chineseResult = renderUninstallResult(result, {
    purgeData: false,
    acquisitionPackagePreserved: true,
  }, persistedCliLanguage(pureCliHome));
  const copyEditedResult = { ...result, summary: 'English copy changed completely.' };
  const chinesePurgedResult = renderUninstallResult(copyEditedResult, {
    purgeData: true,
    acquisitionPackagePreserved: false,
  }, persistedCliLanguage(pureCliHome));
  check('uninstall terminal copy localizes without changing action ids, targets, plan identity, or result data',
    chinesePlan.includes('卸载计划（1 个自有操作）')
      && chinesePlan.includes('binary.remove.broker-binary: /fixture/bin/cosyncing')
      && chinesePlan.includes('确认前请注意')
      && chinesePlan.includes('清除目录')
      && chineseResult.includes('自有集成已移除')
      && chineseResult.includes('npm uninstall -g cosyncing')
      && chinesePurgedResult === '自有集成和两个已确认的持久目录均已移除。'
      && JSON.stringify(plan) === planBefore
      && JSON.stringify(result) === resultBefore,
    `${chinesePlan.trim()} | ${chineseResult}`);

  writeSetupState({ language: 'unsupported-future-language' }, pureCliHome);
  check('an unknown persisted CLI language falls back to English',
    persistedCliLanguage(pureCliHome) === 'en'
      && renderUninstallPlan(plan, persistedCliLanguage(pureCliHome)).startsWith('Uninstall plan'));
}
if (originalCliHome === undefined) delete process.env.COSYNCING_HOME;
else process.env.COSYNCING_HOME = originalCliHome;
rmSync(pureCliHome, { recursive: true, force: true });

{
  let starts = 0;
  const runtime: BrokerRuntimeHandle = { closed: Promise.resolve(), shutdown: async () => {} };
  const gated = await callCli(['broker'], {
    buildInfo: buildInfo(true),
    startBroker: () => { starts += 1; return runtime; },
  });
  check('missing packaged install state fails before broker construction',
    gated.code === 1 && starts === 0 && gated.stderr.includes("Run 'cosyncing setup'"));

  const packagedBypass = await callCli(['broker', '--dev-bypass-first-run'], {
    buildInfo: buildInfo(true),
    startBroker: () => { starts += 1; return runtime; },
  });
  check('packaged artifacts reject the contributor bypass', packagedBypass.code === 2 && starts === 0);

  let signalsInstalled = 0;
  const sourceBypass = await callCli(['broker', '--dev-bypass-first-run'], {
    startBroker: () => { starts += 1; return runtime; },
    installSignalHandlers: () => {
      signalsInstalled += 1;
      return () => { signalsInstalled -= 1; };
    },
  });
  check('source-only bypass reaches the explicit runtime boundary',
    sourceBypass.code === 0 && starts === 1 && signalsInstalled === 0);

  const committed = await callCli(['broker'], {
    buildInfo: buildInfo(true),
    inspectInstallState: () => ({
      committed: true,
      path: '/tmp/fixture/install-state.json',
      state: committedInstallState('2026-07-16T00:00:00.000Z'),
    }),
    startBroker: () => { starts += 1; return runtime; },
    installSignalHandlers: () => () => {},
  });
  check('committed setup reaches the packaged runtime boundary', committed.code === 0 && starts === 2);
}

{
  const foreground = detectBrokerServiceBoundary({});
  const systemd = detectBrokerServiceBoundary({ COSYNCING_SERVICE_PROVIDER: 'systemd' });
  const launchd = detectBrokerServiceBoundary({ COSYNCING_SERVICE_PROVIDER: 'launchd' });
  // Both durable providers stamp their marker into their own definition (systemd `Environment=`, launchd
  // `EnvironmentVariables`), so a managed broker exits for its manager instead of respawning itself.
  check('restart ownership distinguishes foreground from both managed service providers',
    foreground.restartStrategy === 'self-spawn' && !foreground.managed &&
      systemd.restartStrategy === 'service-manager-exit' && systemd.managed &&
      launchd.restartStrategy === 'service-manager-exit' && launchd.managed);
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') fail('could not allocate a test port');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function runProcess(command: string[], env: Record<string, string> = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
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

// Readiness is not one of this suite's assertions, so it gets no wall-clock
// budget: a broker booting beside other work is slow, not broken.
async function waitForHealth(
  child: { exitCode: number | null; exited: Promise<number> },
  base: string,
  output: ProcessOutputCapture,
): Promise<void> {
  try {
    await waitForBrokerHealth(child, `${base}/api/health`);
  } catch (error) {
    fail(`${(error as Error).message}\n${output.read().trim().slice(-2000)}`);
  }
}

async function listenerClosed(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function exerciseForeground(
  label: string,
  command: string[],
  home: string,
  signal: 'SIGINT' | 'SIGTERM',
  packaged = false,
): Promise<void> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  if (packaged) configurePackagedHome(home, port);
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      COSYNCING_HOME: home,
      COSYNCING_CACHE_DIR: join(home, 'cache'),
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CLAUDE_HOOKS: '0',
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_RESTART_DRY_RUN: '1',
      COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drained from the start, and unbounded: the shutdown line is counted across
  // the whole run, and reading the streams only after the exit left nothing
  // draining them while the broker was starting.
  const output = captureProcessOutput(child, { maxChars: Infinity });
  await waitForHealth(child, base, output);
  child.kill(signal);
  const exitCode = await Promise.race([
    child.exited,
    delay(15_000).then(() => fail(`${label} did not exit after ${signal}`)),
  ]);
  // Awaited: the shutdown line is the LAST thing written, so a sample taken
  // when `exited` resolves is exactly the one that can miss it.
  const logs = await settledProcessOutput(output);
  const shutdownLines = logs.split('\n').filter((line) => line.includes('broker shutdown'));
  check(`${label} ${signal} exits cleanly and closes the listener`,
    exitCode === 0 && await listenerClosed(base) && shutdownLines.length === 1,
    `exit=${exitCode}, shutdownLines=${shutdownLines.length}, tail=${logs.trim().slice(-160)}`);
}

async function exerciseManagedRestart(binary: string, home: string): Promise<void> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = configurePackagedHome(home, port);
  const child = Bun.spawn([binary, 'broker'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      COSYNCING_HOME: home,
      COSYNCING_CACHE_DIR: join(home, 'cache'),
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
      COSYNCING_CLAUDE_HOOKS: '0',
      COSYNCING_CODEX_SYNC_SERVER: '0',
      COSYNCING_SERVICE_PROVIDER: 'systemd',
      COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = captureProcessOutput(child, { maxChars: Infinity });
  await waitForHealth(child, base, output);
  const response = await fetch(`${base}/api/broker/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cosyncing-token': token },
    body: JSON.stringify({ confirmRestart: true }),
  });
  const body = await response.json() as any;
  const exitCode = await Promise.race([
    child.exited,
    delay(15_000).then(() => fail('systemd-owned restart did not exit')),
  ]);
  const logs = await settledProcessOutput(output);
  check('systemd-owned restart exits to the provider without a self-spawn race',
    response.status === 202 && body?.service?.provider === 'systemd' &&
      body?.service?.restartStrategy === 'service-manager-exit' && exitCode === 75 &&
      logs.includes('handing restart to systemd') && await listenerClosed(base),
    `status=${response.status}, exit=${exitCode}, tail=${logs.trim().slice(-160)}`);
}

function configurePackagedHome(home: string, port: number): string {
  const internalUrl = `http://127.0.0.1:${port}`;
  writeBrokerConfig({
    ...defaultBrokerConfig(),
    broker: { ...defaultBrokerConfig().broker, port, internalUrl },
  }, home);
  return ensureInstallationCredentials({ home, internalUrl }).brokerToken;
}

const testRoot = mkdtempSync(join(tmpdir(), 'cosyncing-cli-'));
try {
  const importHome = join(testRoot, 'import-home');
  mkdirSync(importHome, { recursive: true });
  const imported = await runProcess([
    'bun',
    '-e',
    "await import('./packages/typescript/broker/src/cli.ts')",
  ], {
    HOME: importHome,
    COSYNCING_HOME: importHome,
    COSYNCING_CACHE_DIR: join(importHome, 'cache'),
  });
  check('importing the source CLI performs no process, network, or filesystem startup',
    imported.exitCode === 0 && readdirSync(importHome).length === 0,
    imported.stderr.trim());

  const artifactDirectory = join(testRoot, 'artifact');
  mkdirSync(artifactDirectory, { recursive: true });
  const binary = join(artifactDirectory, PRODUCT_IDENTITY.primaryBinary);
  const alias = join(artifactDirectory, PRODUCT_IDENTITY.aliasBinary);
  const build = await runProcess(['bun', 'run', 'scripts/broker/build-broker.ts', '--outfile', binary]);
  check('compiled broker build succeeds', build.exitCode === 0, build.stderr.trim());
  check('cosy is a relative symlink to the primary binary',
    lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === PRODUCT_IDENTITY.primaryBinary);

  const packagedVersion = await runProcess([binary, 'version', '--json']);
  const packagedInfo = JSON.parse(packagedVersion.stdout);
  check('compiled primary binary carries immutable non-0.0.0 build metadata',
    packagedVersion.exitCode === 0 && packagedInfo.packaged === true &&
      packagedInfo.version === BUILD_INFO.version && packagedInfo.version !== '0.0.0' &&
      typeof packagedInfo.commit === 'string' && packagedInfo.commit !== 'development' &&
      typeof packagedInfo.dirty === 'boolean' && Number.isFinite(Date.parse(packagedInfo.buildDate)));

  const aliasVersion = await runProcess([alias, 'version']);
  check('cosy alias executes the same compiled version command',
    aliasVersion.exitCode === 0 && aliasVersion.stdout.startsWith('cosyncing '));
  const aliasHelp = await runProcess([alias, '--help'], {
    HOME: importHome,
    COSYNCING_HOME: importHome,
    COSYNCING_CACHE_DIR: join(importHome, 'cache'),
  });
  check('packaged help names cosy and hides the source-only bypass',
    aliasHelp.exitCode === 0 && aliasHelp.stdout.includes('cosy command') &&
      !aliasHelp.stdout.includes('--dev-bypass-first-run') && readdirSync(importHome).length === 0);

  const emptyHome = join(testRoot, 'unconfigured-home');
  mkdirSync(emptyHome, { recursive: true });
  const before = readdirSync(emptyHome);
  const rejected = await runProcess([binary, 'broker'], {
    HOME: emptyHome,
    COSYNCING_HOME: emptyHome,
    COSYNCING_CACHE_DIR: join(emptyHome, 'cache'),
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  });
  check('unconfigured packaged broker is read-only and exits with setup guidance',
    rejected.exitCode === 1 && rejected.stderr.includes("Run 'cosyncing setup'") &&
      JSON.stringify(readdirSync(emptyHome)) === JSON.stringify(before));

  const exitHome = join(testRoot, 'exit-backstop-home');
  const exitCache = join(testRoot, 'exit-backstop-cache');
  const exportTemp = join(testRoot, 'exit-backstop-export');
  mkdirSync(exitHome, { recursive: true });
  mkdirSync(exportTemp, { recursive: true });
  const exportPath = join(exportTemp, 'review.json');
  writeFileSync(exportPath, '{"redacted":true}\n');
  const seededStore = new ArtifactStore('http://127.0.0.1:7734', exitCache);
  seededStore.putExportAttachment(
    { tool: 'fixture', id: 'exit-backstop' },
    { name: 'review', format: 'json', retentionMs: 60_000 },
    exportPath,
    exportTemp,
  );
  const exitIndexPath = join(exitCache, 'artifacts', 'index.json');
  const seededIndex = JSON.parse(readFileSync(exitIndexPath, 'utf8')) as { records: Array<{ filePath: string }> };
  const seededBlob = seededIndex.records[0]?.filePath;
  const exitPort = await freePort();
  const lastResort = await runProcess([
    'bun',
    '-e',
    "const { startBrokerRuntime } = await import('./packages/typescript/broker/src/main.ts'); startBrokerRuntime(); process.exit(17)",
  ], {
    HOME: exitHome,
    COSYNCING_HOME: exitHome,
    COSYNCING_CACHE_DIR: exitCache,
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    COSYNCING_CLAUDE_HOOKS: '0',
    COSYNCING_CODEX_SYNC_SERVER: '0',
    COSYNCING_TOKDASH_URL: 'http://127.0.0.1:1',
    HOST: '127.0.0.1',
    PORT: String(exitPort),
  });
  const cleanedIndex = JSON.parse(readFileSync(exitIndexPath, 'utf8')) as { records: unknown[] };
  check('process-exit backstop removes R2 export attachments without orderly shutdown',
    lastResort.exitCode === 17 && seededIndex.records.length === 1 && cleanedIndex.records.length === 0 &&
      typeof seededBlob === 'string' && !existsSync(seededBlob),
    `exit=${lastResort.exitCode}, before=${seededIndex.records.length}, after=${cleanedIndex.records.length}`);

  const configuredHome = join(testRoot, 'configured-home');
  mkdirSync(configuredHome, { recursive: true });
  writeFileSync(join(configuredHome, 'install-state.json'), `${JSON.stringify(committedInstallState(), null, 2)}\n`, {
    mode: 0o600,
  });

  await exerciseForeground('source CLI foreground',
    ['bun', 'run', 'packages/typescript/broker/src/cli.ts', 'broker', '--dev-bypass-first-run'],
    configuredHome,
    'SIGINT');
  await exerciseForeground('compiled CLI foreground', [binary, 'broker'], configuredHome, 'SIGTERM', true);
  await exerciseManagedRestart(binary, configuredHome);
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} CLI package-boundary checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} CLI package-boundary checks`);
