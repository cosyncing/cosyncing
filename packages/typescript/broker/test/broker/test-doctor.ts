#!/usr/bin/env bun
/** No-effects doctor, minimum-version matrix, topology, and redaction acceptance. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import * as ts from 'typescript';
import type {
  AgentBackend,
  AgentMinimumVersion,
  AgentSetupDiagnosis,
  SetupCheck,
  SetupDiagnosisContext,
} from '../../../adapter-api/src/index.ts';
import { diagnoseManagedRuntimeFailure } from '../../src/runtime/managed-runtime-state.ts';
import {
  CODEX_MINIMUM_VERSION,
  CODEX_STANDALONE_INSTALL_COMMAND,
  diagnoseCodexSetup,
} from '../../../adapters/codex/src/diagnostics.ts';
import {
  OPENCODE_MINIMUM_VERSION,
  diagnoseOpenCodeSetup,
} from '../../../adapters/opencode/src/diagnostics.ts';
import {
  PI_MINIMUM_VERSION,
  diagnosePiSetup,
} from '../../../adapters/pi/src/diagnostics.ts';
import {
  CLAUDE_MINIMUM_VERSION,
  diagnoseClaudeSetup,
} from '../../../adapters/claude/src/diagnostics.ts';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { runCli } from '../../src/cli/cli.ts';
import {
  translateDoctorTextToChinese,
} from '../../src/cli/cli-i18n.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { loadOrCreateBrokerInstanceId } from '../../src/runtime/broker-instance.ts';
import { ensureInstallationCredentials } from '../../src/security/credentials.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { ensureOwnerOnlyDirectory } from '../../src/security/secure-files.ts';
import { isOwnerOnlyFile } from '../helpers/isolated-broker-fixture.ts';
import {
  codexTuiReadinessCheck,
  collectDoctorReport,
  diagnoseAgents,
  doctorColorEnabled,
  machinePeerCredentialCheck,
  renderDoctorReport,
  type DoctorReport,
} from '../../src/installation/doctor.ts';
import {
  clearManagedRuntimeFailure,
  readManagedRuntimeFailureJournal,
  recordManagedRuntimeFailure,
} from '../../src/runtime/managed-runtime-state.ts';
import {
  SETUP_FAILURE_SCHEMA_VERSION,
  setupFailureDiagnosticPath,
} from '../../src/installation/setup-transaction.ts';
import { inspectRuntimeAssets } from '../../src/runtime/runtime-assets.ts';
import {
  committedInstallState,
  writeInstallState,
} from '../../src/installation/install-state.ts';
import { atomicWriteOwnerOnly } from '../../src/security/secure-files.ts';
import { PI_BRIDGE_EMBEDDED_SOURCE } from '../../../adapters/pi/src/index.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const observedDoctorChecks: SetupCheck[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function checkById(diagnosis: AgentSetupDiagnosis, id: string): SetupCheck {
  observedDoctorChecks.push(...diagnosis.checks);
  const found = diagnosis.checks.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${diagnosis.agent} check ${id}`);
  return found;
}

function observeDoctorReport<T extends DoctorReport>(report: T): T {
  observedDoctorChecks.push(...report.sections.flatMap((section) => section.checks));
  return report;
}

/**
 * Fail closed when a literal summary/remediation branch is added without Chinese copy. Dynamic templates
 * are exercised through the branch fixtures collected in observedDoctorChecks below.
 */
function literalDoctorCopy(): Array<{ file: string; text: string }> {
  const root = join(import.meta.dir, '../../../../..');
  const files = [
    'packages/typescript/broker/src/installation/doctor.ts',
    'packages/typescript/adapter-api/src/index.ts',
    'packages/typescript/adapters/codex/src/diagnostics.ts',
    'packages/typescript/adapters/opencode/src/diagnostics.ts',
    'packages/typescript/adapters/pi/src/diagnostics.ts',
    'packages/typescript/adapters/claude/src/diagnostics.ts',
  ];
  const copy: Array<{ file: string; text: string }> = [];
  const collectLiteralBranches = (file: string, expression: ts.Expression): void => {
    if (ts.isStringLiteralLike(expression)) {
      if (expression.text) copy.push({ file, text: expression.text });
      return;
    }
    if (ts.isParenthesizedExpression(expression)) {
      collectLiteralBranches(file, expression.expression);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      collectLiteralBranches(file, expression.whenTrue);
      collectLiteralBranches(file, expression.whenFalse);
    }
  };
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
          ? node.name.text
          : undefined;
        if (name === 'summary' || name === 'message' || name === 'installMessage') {
          collectLiteralBranches(file, node.initializer);
        }
      }
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'remediation'
        && node.arguments[1]) {
        collectLiteralBranches(file, node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return copy;
}

function displayed(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

interface FakeContextOptions {
  homeDir?: string;
  platform?: string;
  arch?: string;
  windowsMachineArchitecture?: SetupDiagnosisContext['windowsMachineArchitecture'];
  env?: Record<string, string | undefined>;
  executables?: Record<string, string>;
  inspectPath?: SetupDiagnosisContext['inspectPath'];
  readText?: SetupDiagnosisContext['readText'];
  readPackageVersion?: SetupDiagnosisContext['readPackageVersion'];
  runReadOnly?: SetupDiagnosisContext['runReadOnly'];
  fetchJson?: SetupDiagnosisContext['fetchJson'];
  probeTcp?: SetupDiagnosisContext['probeTcp'];
  currentUid?: SetupDiagnosisContext['currentUid'];
}

function fakeContext(options: FakeContextOptions = {}): SetupDiagnosisContext {
  const homeDir = options.homeDir ?? '/fixture/home';
  return {
    effects: 'forbidden',
    platform: options.platform ?? 'linux',
    // Paired with the platform: a darwin fixture is an Apple Silicon Mac, the host that is supported.
    arch: options.arch ?? (options.platform === 'darwin' ? 'arm64' : 'x64'),
    // Windows fixtures must say what MACHINE they are, not only what process: an x64 process on an ARM64
    // machine is a distinct, refused host, and a fixture that omitted this would silently be the
    // unverifiable case rather than the one it meant to describe.
    windowsMachineArchitecture: options.windowsMachineArchitecture
      ?? (() => (options.platform === 'win32' ? 'x64' : 'unknown')),
    homeDir,
    env: options.env ?? {},
    resolveExecutable: (command) => options.executables?.[command],
    inspectPath: options.inspectPath ?? ((path) => ({
      status: 'missing',
      readable: false,
      displayPath: displayed(path, homeDir),
    })),
    readText: options.readText ?? (() => ({ ok: false, reason: 'missing' })),
    readPackageVersion: options.readPackageVersion ?? (() => undefined),
    runReadOnly: options.runReadOnly ?? (async () => ({ status: 'ok', stdout: '', stderr: '' })),
    fetchJson: options.fetchJson ?? (async () => ({ status: 'unreachable' })),
    probeTcp: options.probeTcp ?? (async () => 'closed'),
    listDirectory: () => ({ ok: false, reason: 'missing' } as const),
    processAlive: () => false,
    // Paired with the platform, as arch is: a POSIX fixture has a uid whatever host runs the test.
    currentUid: options.currentUid ?? (() => (options.platform === 'win32' ? undefined : '501')),
    displayPath: (path) => displayed(path, homeDir),
  };
}

type MatrixAgent = 'codex' | 'opencode' | 'pi' | 'claude';

const matrix: Record<MatrixAgent, {
  minimum: AgentMinimumVersion;
  below: string;
  command: string;
}> = {
  codex: { minimum: CODEX_MINIMUM_VERSION, below: '0.144.4', command: 'codex' },
  opencode: { minimum: OPENCODE_MINIMUM_VERSION, below: '1.17.18', command: 'opencode' },
  pi: { minimum: PI_MINIMUM_VERSION, below: '0.78.0', command: 'pi' },
  claude: { minimum: CLAUDE_MINIMUM_VERSION, below: '2.1.206', command: 'claude' },
};

/**
 * Create a fixture directory that is genuinely owner-only on THIS host.
 *
 * `mkdirSync(path, { mode: 0o700 })` is a POSIX-only way of saying "owner-only". On Windows the mode
 * is ignored and the new directory inherits its parent's DACL, which under a user profile or the temp
 * root admits SYSTEM and Administrators. Doctor then reported the directory as not owner-only, and it
 * was RIGHT to: `inspectOwnerOnlyPath` checks the real DACL on win32, and the fixture had not built
 * the state the check describes. The product's own primitive builds it on either platform.
 */
function makeOwnerOnlyDirectory(target: string): void {
  ensureOwnerOnlyDirectory(target);
}

/**
 * The product builds these candidate paths with node:path `join`, so their separator is the HOST's, not the
 * one a fixture author typed. A `path.endsWith('/a/b')` predicate therefore matched nothing on Windows and
 * reported a correct standalone install as missing — the fixture failing, not the product.
 */
function pathEndsWith(path: string, posixSuffix: string): boolean {
  return path.split(/[\\/]/).join('/').endsWith(posixSuffix);
}

function makeFixtureContext(root: string, agent: MatrixAgent, version: string): SetupDiagnosisContext {
  const fixture = join(root, `${agent}-${version.replace(/[^a-zA-Z0-9]/g, '-')}`);
  const home = join(fixture, 'home');
  let binRoot = join(fixture, 'bin');
  let binary = join(binRoot, matrix[agent].command);
  makeOwnerOnlyDirectory(home);
  if (agent === 'pi') {
    const packageRoot = join(fixture, 'node_modules', '@earendil-works', 'pi-coding-agent');
    binRoot = join(packageRoot, 'bin');
    binary = join(binRoot, 'pi');
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version,
    })}\n`);
  } else if (agent === 'codex') {
    binRoot = join(fixture, 'releases', `${version}-fixture`, 'bin');
    binary = join(binRoot, 'codex');
    mkdirSync(binRoot, { recursive: true });
  } else {
    mkdirSync(binRoot, { recursive: true });
  }
  // The file still exists, because discovery legitimately looks for it on disk.
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${agent} ${version}'\n`, { mode: 0o755 });
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
  const real = createSetupDiagnosisContext({
    homeDir: home,
    platform: 'linux',
    env: { PATH: binRoot, HOME: home },
  });
  return {
    ...real,
    // Version fixtures must never depend on a developer's live servers or port allocation.
    fetchJson: async () => ({ status: 'unreachable' }),
    probeTcp: async () => 'closed',
    listDirectory: () => ({ ok: false, reason: 'missing' } as const),
    processAlive: () => false,
    // Resolution and execution are INJECTED rather than performed.
    //
    // These fixtures used to write a `#!/bin/sh` script, chmod it, and let the product spawn it for
    // real. That cannot work on Windows and could not be repaired by writing a `.cmd` instead: the
    // context deliberately declares `platform: 'linux'` so the LINUX diagnosis logic is what gets
    // exercised, and linux resolution does not consult PATHEXT, so a `.cmd` would not be found
    // either. Every version branch therefore degraded to `version-unparsable` on Windows.
    //
    // What these checks are actually about is how the product PARSES a version and which branch it
    // takes — not whether this host can exec a shell script. Injecting the answer tests exactly that,
    // on every platform, and faster. Real spawning on Windows is covered where it belongs: the
    // native adapter probes under scripts/broker/windows, which run real agents through their real
    // `.cmd` shims, and `doctor-real` against installed CLIs.
    resolveExecutable: (command: string) => (command === matrix[agent].command ? binary : undefined),
    runReadOnly: async (executable: string) => (executable === binary
      ? { status: 'ok' as const, exitCode: 0, stdout: `${agent} ${version}\n`, stderr: '' }
      : { status: 'unavailable' as const, stdout: '', stderr: 'not a fixture executable' }),
  };
}

async function diagnoseFixture(agent: MatrixAgent, context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  switch (agent) {
    case 'codex': return diagnoseCodexSetup(context);
    case 'opencode': return diagnoseOpenCodeSetup(context, { baseUrl: 'http://127.0.0.1:1' });
    case 'pi': return diagnosePiSetup(context, {
      inspectBridge: (agentDir) => ({ status: 'missing', path: join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts'), requiresConfirmation: false }),
    });
    case 'claude': return diagnoseClaudeSetup(context, {
      inspectLegacyHooks: (path) => ({ status: 'absent', path, entryCount: 0, requiresConfirmation: false }),
    });
  }
}

const testRoot = mkdtempSync(join(tmpdir(), 'cosyncing-doctor-'));
// `cosyncing doctor` renders in the language persisted under COSYNCING_HOME (default `~/.cosyncing`),
// so an invoking host with a real install would otherwise decide what this file asserts. Point the
// whole file at an empty fixture home; the checks that want a persisted language plant their own.
const realCosyncingHome = process.env.COSYNCING_HOME;
const cliHome = join(testRoot, 'cli-home');
makeOwnerOnlyDirectory(cliHome);
process.env.COSYNCING_HOME = cliHome;
try {
  for (const agent of Object.keys(matrix) as MatrixAgent[]) {
    for (const fixture of [
      { label: 'below', value: matrix[agent].below, status: 'fail', code: 'version-below-minimum' },
      { label: 'unparsable', value: 'not-a-version', status: 'fail', code: 'version-unparsable' },
      { label: 'supported', value: matrix[agent].minimum.version, status: 'pass', code: 'version-supported' },
    ] as const) {
      const diagnosis = await diagnoseFixture(agent, makeFixtureContext(testRoot, agent, fixture.value));
      const version = checkById(diagnosis, `${agent}.version`);
      check(`${agent} fixture reports the exact ${fixture.label} version branch`,
        version.status === fixture.status && version.detailCode === fixture.code &&
          (version.status !== 'fail' || !!version.remediation),
        `${version.status}/${version.detailCode}`);
    }
  }

  let mutationProneVersionRuns = 0;
  const pathVersionCodex = await diagnoseCodexSetup(fakeContext({
    executables: { codex: '/fixture/releases/0.144.5-x86_64-unknown-linux-musl/bin/codex' },
    runReadOnly: async () => {
      mutationProneVersionRuns += 1;
      return { status: 'ok', stdout: '0.144.5', stderr: '' };
    },
  }));
  const packageVersionPi = await diagnosePiSetup(fakeContext({
    executables: { pi: '/fixture/pi/bin/pi' },
    readPackageVersion: () => '0.78.1',
    runReadOnly: async () => {
      mutationProneVersionRuns += 1;
      return { status: 'ok', stdout: '0.78.1', stderr: '' };
    },
  }), {
    inspectBridge: (agentDir) => ({ status: 'missing', path: join(agentDir, 'bridge.ts'), requiresConfirmation: false }),
  });
  check('Codex and Pi versions are read from installed metadata without invoking mutation-prone CLIs',
    mutationProneVersionRuns === 0 &&
      checkById(pathVersionCodex, 'codex.version').status === 'pass' &&
      checkById(packageVersionPi, 'pi.version').status === 'pass');

  const npmOnlyCodex = await diagnoseCodexSetup(fakeContext({
    executables: { codex: '/fixture/node_modules/@openai/codex/bin/codex.js' },
    readPackageVersion: () => '0.146.1',
  }));
  const npmOnlyStandalone = checkById(npmOnlyCodex, 'codex.standalone-install');
  const standaloneCodex = await diagnoseCodexSetup(fakeContext({
    executables: { codex: '/fixture/releases/0.146.1-aarch64-apple-darwin/bin/codex' },
    inspectPath: (path) => pathEndsWith(path, '/packages/standalone/current/bin/codex')
      ? { status: 'file', readable: true, displayPath: path }
      : { status: 'missing', readable: false, displayPath: path },
  }));
  const standaloneReady = checkById(standaloneCodex, 'codex.standalone-install');
  const externalCodex = await diagnoseCodexSetup(fakeContext({
    env: { COSYNCING_CODEX_APP_SERVER_SOCK: '/fixture/external.sock' },
    executables: { codex: '/fixture/node_modules/@openai/codex/bin/codex.js' },
    readPackageVersion: () => '0.146.1',
  }));
  const externalStandalone = checkById(externalCodex, 'codex.standalone-install');
  check('Codex diagnosis distinguishes npm-only, standalone, and explicit external-daemon installations',
    npmOnlyStandalone.status === 'warn'
      && npmOnlyStandalone.detailCode === 'standalone-install-missing'
      && npmOnlyStandalone.remediation?.command === CODEX_STANDALONE_INSTALL_COMMAND
      && npmOnlyStandalone.remediation.message.includes('`cosy setup`')
      && standaloneReady.status === 'pass'
      && standaloneReady.detailCode === 'standalone-install-ready'
      && externalStandalone.status === 'skip'
      && externalStandalone.detailCode === 'standalone-install-external-daemon',
    `${npmOnlyStandalone.status}/${standaloneReady.status}/${externalStandalone.status}`);

  // The same official installer writes `current\bin\codex.exe` on Windows (with `current` as a
  // junction). Checking only the extensionless name told an operator with a correct standalone install
  // to go and install it again — verified against the real 0.149.0 install on the native Windows host.
  const windowsStandalone = await diagnoseCodexSetup(fakeContext({
    platform: 'win32',
    executables: { codex: '/fixture/Programs/OpenAI/Codex/bin/codex.exe' },
    inspectPath: (path) => pathEndsWith(path, '/packages/standalone/current/bin/codex.exe')
      ? { status: 'file', readable: true, displayPath: path }
      : { status: 'missing', readable: false, displayPath: path },
  }));
  const windowsReady = checkById(windowsStandalone, 'codex.standalone-install');
  // And a Windows host with neither name present is still missing — the extension is not a way to pass.
  const windowsAbsent = await diagnoseCodexSetup(fakeContext({
    platform: 'win32',
    executables: { codex: '/fixture/WinGet/Links/codex.exe' },
    readPackageVersion: () => '0.146.1',
    inspectPath: () => ({ status: 'missing', readable: false, displayPath: '/fixture/missing' }),
  }));
  const windowsMissing = checkById(windowsAbsent, 'codex.standalone-install');
  check('A correct Windows standalone install is recognized by its .exe, and its absence still warns',
    windowsReady.status === 'pass'
      && windowsReady.detailCode === 'standalone-install-ready'
      && windowsMissing.status === 'warn'
      && windowsMissing.detailCode === 'standalone-install-missing',
    `${windowsReady.status}/${windowsReady.detailCode} ${windowsMissing.status}/${windowsMissing.detailCode}`);

  // Daemon listener state comes from /proc/net/unix. On darwin that file does not exist, so a present,
  // safe socket must degrade to an explicit skip — never the Linux 'stale' verdict, which would accuse a
  // perfectly healthy daemon of being dead.
  const codexSocketContext = (platform: string): SetupDiagnosisContext => fakeContext({
    platform,
    executables: {
      codex: '/fixture/bin/codex',
      ...(platform === 'darwin' ? { '/bin/ps': '/bin/ps', '/usr/sbin/lsof': '/usr/sbin/lsof' } : {}),
    },
    inspectPath: (path) => (path.endsWith('.sock') || path.includes('app-server')
      ? { status: 'socket', readable: true, displayPath: path }
      : { status: 'missing', readable: false, displayPath: path }),
    // A readable /proc/net/unix that does NOT list the socket is what makes Linux report 'stale'; darwin
    // must not reach this read at all, so the same fixture yields a skip there.
    readText: (path) => (path === '/proc/net/unix'
      ? { ok: true, text: 'Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 12345 /run/other.sock\n' }
      : { ok: false, reason: 'missing' }),
    runReadOnly: async () => ({ status: 'ok', stdout: 'codex-cli 0.144.5', stderr: '' }),
  });
  const darwinCodex = await diagnoseCodexSetup(codexSocketContext('darwin'));
  const linuxCodex = await diagnoseCodexSetup(codexSocketContext('linux'));
  const darwinDaemon = checkById(darwinCodex, 'codex.daemon-status');
  const linuxDaemon = checkById(linuxCodex, 'codex.daemon-status');
  const darwinPresence = checkById(darwinCodex, 'codex.terminal-presence-capability');
  check('Codex daemon-status degrades to an explicit skip on darwin instead of a false stale verdict',
    darwinDaemon.status === 'skip' && darwinDaemon.detailCode === 'daemon-status-platform-unsupported'
      && linuxDaemon.status === 'fail' && linuxDaemon.detailCode === 'daemon-socket-stale',
    `${darwinDaemon.status}:${darwinDaemon.detailCode} vs ${linuxDaemon.status}:${linuxDaemon.detailCode}`);
  check('Codex doctor advertises macOS restore evidence only when ps and lsof are both present',
    darwinPresence.status === 'pass' && darwinPresence.detailCode === 'terminal-presence-capable',
    `${darwinPresence.status}:${darwinPresence.detailCode}`);
  const darwinMissingPresence = checkById(
    await diagnoseCodexSetup(fakeContext({
      platform: 'darwin',
      executables: { codex: '/fixture/bin/codex', '/bin/ps': '/bin/ps' },
    })),
    'codex.terminal-presence-capability',
  );
  check('Codex doctor keeps automatic macOS restoration unavailable when lsof is missing',
    darwinMissingPresence.status === 'warn' &&
      darwinMissingPresence.detailCode === 'terminal-presence-tools-missing' &&
      /automatic Drive restoration stays disabled/i.test(darwinMissingPresence.remediation?.message ?? ''),
    `${darwinMissingPresence.status}:${darwinMissingPresence.detailCode}`);
  const darwinShadowedPresence = checkById(
    await diagnoseCodexSetup(fakeContext({
      platform: 'darwin',
      executables: {
        codex: '/fixture/bin/codex',
        ps: '/fixture/user-writable/ps',
        lsof: '/fixture/user-writable/lsof',
      },
    })),
    'codex.terminal-presence-capability',
  );
  check('Codex doctor rejects PATH-shadowed macOS inspection tools',
    darwinShadowedPresence.status === 'warn' &&
      darwinShadowedPresence.detailCode === 'terminal-presence-tools-missing',
    `${darwinShadowedPresence.status}:${darwinShadowedPresence.detailCode}`);

  const sentinel = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const failureRecord = JSON.stringify({
    schemaVersion: 1,
    failures: {
      codex: {
        detailCode: 'codex-daemon-start-exited',
        recordedAt: '2026-07-17T10:00:00.000Z',
        capturedOutput: `COSYNCING_TOKEN=${sentinel}`,
      },
    },
  });
  const codexFailureContext = fakeContext({
    executables: { codex: '/fixture/bin/codex' },
    readText: (path) => path.endsWith('managed-runtime-failures.json')
      ? { ok: true, text: failureRecord }
      : { ok: false, reason: 'missing' },
    runReadOnly: async () => ({ status: 'ok', stdout: 'codex-cli 0.144.5', stderr: '' }),
  });
  const codexFailure = await diagnoseCodexSetup(codexFailureContext);
  const codexFailureCheck = diagnoseManagedRuntimeFailure(codexFailureContext, 'codex', 'Codex');
  observedDoctorChecks.push(...codexFailure.checks, codexFailureCheck);
  check('broker-owned Codex daemon-start diagnosis is blocking, actionable, and captured output stays private',
    codexFailureCheck.status === 'fail' && !!codexFailureCheck.remediation &&
      !JSON.stringify(codexFailureCheck).includes(sentinel) &&
      !codexFailure.checks.some((item) => item.id === 'codex.managed-start-failure'));

  // A managed EXTERNAL HOST earns the same diagnosis as a managed runtime.
  //
  // Kimi and dsh declare `externalHost.managed` and no `managedRuntime`, and the
  // gate used to require the latter — so a Kimi host that crashed and could not
  // be restarted produced a supervisor warning in the journal and NOTHING in
  // doctor. Driven through `diagnoseAgents` rather than by asserting the
  // predicate, so it is the real wiring under test.
  {
    const hostFailure = JSON.stringify({
      schemaVersion: 1,
      failures: {
        kimi: {
          detailCode: 'host-spawn-failed',
          recordedAt: '2026-08-17T10:00:00.000Z',
          capturedOutput: `COSYNCING_TOKEN=${sentinel}`,
        },
      },
    });
    const hostContext = fakeContext({
      readText: (path) => path.endsWith('managed-runtime-failures.json')
        ? { ok: true, text: hostFailure }
        : { ok: false, reason: 'missing' },
    });
    const stub = (id: string, integration: unknown) => ({
      id,
      displayName: id,
      integration,
      diagnoseSetup: async () => ({
        agent: id,
        displayName: id,
        minimumVersion: { version: '0.0.0', requiredFeature: '', evidenceUrl: '' },
        checks: [],
      }),
    });
    const diagnoses = await diagnoseAgents(hostContext, [
      stub('kimi', { externalHost: { managed: true } }),
      stub('plain', {}),
    ] as never);
    const kimiChecks = diagnoses.find((entry) => entry.agent === 'kimi')?.checks ?? [];
    const plainChecks = diagnoses.find((entry) => entry.agent === 'plain')?.checks ?? [];
    const kimiFailure = kimiChecks.find((item) => item.id === 'kimi.managed-start-failure');
    check('a managed external host whose restart failed produces a blocking, actionable doctor finding',
      kimiChecks.length === 1 && kimiFailure?.status === 'fail' && !!kimiFailure.remediation
        && !JSON.stringify(kimiFailure).includes(sentinel),
      JSON.stringify(kimiFailure));
    check('...and an adapter with no managed host is still not asked about a journal it never writes',
      plainChecks.length === 0, JSON.stringify(plainChecks));
  }

  const opencodeConflict = await diagnoseOpenCodeSetup(fakeContext({
    executables: { opencode: '/fixture/bin/opencode' },
    runReadOnly: async () => ({ status: 'ok', stdout: '1.17.19', stderr: '' }),
    fetchJson: async () => ({ status: 'invalid-response' }),
    probeTcp: async () => 'open',
  }), { baseUrl: 'http://127.0.0.1:4096' });
  const conflict = checkById(opencodeConflict, 'opencode.server');
  check('OpenCode occupied non-server port is a visible failure with safe remediation',
    conflict.status === 'fail' && conflict.detailCode === 'server-port-conflict' && !!conflict.remediation);

  const piCollision = await diagnosePiSetup(fakeContext({
    executables: { pi: '/fixture/bin/pi' },
    readPackageVersion: () => PI_MINIMUM_VERSION.version,
  }), {
    inspectBridge: (agentDir) => ({
      status: 'unowned',
      path: join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts'),
      requiresConfirmation: true,
    }),
  });
  const piBridge = checkById(piCollision, 'pi.bridge-asset');
  check('Pi unowned bridge collision is preserved and visibly blocks replacement',
    piBridge.status === 'fail' && piBridge.detailCode === 'bridge-unowned-collision' &&
      piBridge.evidence?.requiresConfirmation === true && !!piBridge.remediation);

  {
    const userHome = join(testRoot, 'config-v1-doctor');
    const stateHome = join(userHome, '.cosyncing');
    makeOwnerOnlyDirectory(stateHome);
    atomicWriteOwnerOnly(join(stateHome, 'config.json'), `${JSON.stringify({
      schemaVersion: 1,
      broker: {
        host: '127.0.0.1',
        port: 7734,
        machineLabel: 'config-v1-doctor',
        internalUrl: 'http://127.0.0.1:7734',
        advertisedUrl: 'https://legacy.example.test',
      },
      update: { channel: 'stable' },
    })}\n`, { mode: 0o600 });
    const report = observeDoctorReport(await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: fakeContext({ homeDir: userHome }),
      assetReport: inspectRuntimeAssets(),
      adapters: [],
      stateHome,
    }));
    const configSchema = report.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'state.schema.config');
    check('doctor reports config v1 as a supported repair warning rather than corruption',
      configSchema?.status === 'warn'
        && configSchema.detailCode === 'config-v1-migration-required'
        && JSON.stringify(configSchema.remediation).includes('cosyncing repair'),
      JSON.stringify(configSchema));
  }

  {
    const userHome = join(testRoot, 'pi-owned-stale-doctor');
    const stateHome = join(userHome, '.cosyncing');
    const piAgentDir = join(userHome, '.pi', 'agent');
    const bridge = join(piAgentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
    const priorPackaged = `${PI_BRIDGE_EMBEDDED_SOURCE}\n// prior packaged bridge comment\n`;
    makeOwnerOnlyDirectory(stateHome);
    atomicWriteOwnerOnly(bridge, priorPackaged, { mode: 0o600 });
    const install = committedInstallState('2026-07-17T00:00:00.000Z');
    install.resources.push({
      id: 'pi-bridge',
      kind: 'agent-integration',
      target: bridge,
      ownership: {
        proof: 'package-hash',
        installedSha256: createHash('sha256').update(priorPackaged).digest('hex'),
      },
    });
    writeInstallState(install, stateHome);
    const diagnosisAdapter = {
      id: 'pi',
      displayName: 'Pi',
      diagnoseSetup: async () => piCollision,
    } as unknown as AgentBackend;
    const report = observeDoctorReport(await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: fakeContext({
        homeDir: userHome,
        env: { PI_CODING_AGENT_DIR: piAgentDir },
      }),
      assetReport: inspectRuntimeAssets(),
      adapters: [diagnosisAdapter],
      stateHome,
    }));
    const ownedStale = report.sections.flatMap((section) => section.checks)
      .find((candidate) => candidate.id === 'pi.bridge-asset');
    check('doctor reports a receipt-proven stale Pi bridge as an actionable warning, not an unowned collision',
      ownedStale?.status === 'warn'
        && ownedStale.detailCode === 'bridge-owned-stale'
        && ownedStale.remediation?.message.includes('setup or repair') === true,
      `${ownedStale?.status}:${ownedStale?.detailCode}`);
  }

  {
    // THE TWO HOMES, AT THE CALL SITE.
    //
    // The posture function takes the state home and the user home separately;
    // this is the check that DOCTOR hands the right one to each role, which is
    // where the mistake actually happened. Nothing errors when it does not:
    // identities resolved under `~/.cosyncing` name a host no agent has ever
    // used, so they match nothing the diagnosis resolved, a managed host reads
    // as unmanaged, and doctor offers the manual start command the whole posture
    // exists to withhold. Silent by construction, so it needs a test.
    const userHome = join(testRoot, 'managed-host-homes');
    const stateHome = join(userHome, '.cosyncing');
    makeOwnerOnlyDirectory(stateHome);
    const install = committedInstallState('2026-08-17T00:00:00.000Z');
    install.resources.push({
      id: 'service-environment',
      kind: 'environment-file',
      target: join(stateHome, 'broker.env'),
      ownership: { proof: 'receipt' },
    } as never);
    writeInstallState(install, stateHome);
    let handed: readonly string[] | undefined;
    const hostAdapter = {
      id: 'fixture-host',
      displayName: 'Fixture Host',
      integration: { externalHost: { managed: true } },
      // Resolves under whatever home it is GIVEN, exactly as a real adapter
      // does — which is what makes the wrong home observable here.
      managedHostIdentity: ({ homeDir }: { homeDir: string }) => `${homeDir}/.fixture-host`,
      diagnoseSetup: async (context: { managedExternalHostIdentities?: readonly string[] }) => {
        handed = context.managedExternalHostIdentities;
        return { agent: 'fixture-host', displayName: 'Fixture Host', checks: [] };
      },
    } as unknown as AgentBackend;
    await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: fakeContext({ homeDir: userHome }),
      assetReport: inspectRuntimeAssets(),
      adapters: [hostAdapter],
      stateHome,
    });
    check('doctor resolves a managed identity under the USER home, never the state home',
      handed?.includes(`${userHome}/.fixture-host`) === true
        && handed?.some((identity) => identity.startsWith(`${stateHome}/`)) === false,
      JSON.stringify(handed));
  }

  const claudeLegacy = await diagnoseClaudeSetup(fakeContext({
    executables: { claude: '/fixture/bin/claude' },
    runReadOnly: async () => ({ status: 'ok', stdout: '2.1.207', stderr: '' }),
  }), {
    inspectLegacyHooks: (path) => ({ status: 'legacy-marker', path, entryCount: 2, requiresConfirmation: true }),
  });
  const legacyHook = checkById(claudeLegacy, 'claude.legacy-hooks');
  check('legacy Claude hook entries warn about embedded credentials without exposing commands',
    legacyHook.status === 'warn' && legacyHook.detailCode === 'legacy-hooks-marked' &&
      legacyHook.evidence?.entryCount === 2 && !!legacyHook.remediation &&
      !('commandText' in (legacyHook.evidence ?? {})));

  const journalHome = join(testRoot, 'journal-home');
  makeOwnerOnlyDirectory(journalHome);
  recordManagedRuntimeFailure({
    agent: 'codex',
    detailCode: 'codex-daemon-start-exited',
    capturedOutput: `COSYNCING_TOKEN=${sentinel}\nAuthorization: Bearer ${sentinel}`,
    home: journalHome,
    now: () => new Date('2026-07-17T10:00:00.000Z'),
  });
  const rawJournal = readFileSync(join(journalHome, 'logs', 'managed-runtime-failures.json'), 'utf8');
  const stored = readManagedRuntimeFailureJournal(journalHome);
  check('managed-runtime journal is owner-only, bounded, and redacted before persistence',
    isOwnerOnlyFile(join(journalHome, 'logs', 'managed-runtime-failures.json')) &&
      !rawJournal.includes(sentinel) && !!stored.failures.codex?.capturedOutput.includes('[REDACTED'));
  recordManagedRuntimeFailure({
    agent: 'fixture-adapter',
    detailCode: 'fixture-start-exited',
    home: journalHome,
    now: () => new Date('2026-07-17T10:01:00.000Z'),
  });
  clearManagedRuntimeFailure('fixture-adapter', journalHome);
  check('managed-runtime journal accepts future adapter ids and clears one without disturbing another',
    !readManagedRuntimeFailureJournal(journalHome).failures['fixture-adapter'] &&
      readManagedRuntimeFailureJournal(journalHome).failures.codex?.detailCode === 'codex-daemon-start-exited');
  const journalContext = fakeContext({
    homeDir: dirname(journalHome),
    env: { COSYNCING_HOME: journalHome },
    readText: (path) => path.endsWith('managed-runtime-failures.json')
      ? { ok: true, text: rawJournal }
      : { ok: false, reason: 'missing' },
  });
  const redactedCheck = diagnoseManagedRuntimeFailure(journalContext, 'codex', 'Codex');
  const malformedCheck = diagnoseManagedRuntimeFailure(fakeContext({
    env: { COSYNCING_HOME: journalHome },
    readText: () => ({ ok: true, text: JSON.stringify({ schemaVersion: 99, failures: { codex: sentinel } }) }),
  }), 'codex', 'Codex');
  observedDoctorChecks.push(redactedCheck, malformedCheck);
  check('doctor exposes only validated failure metadata, never the captured journal output',
    redactedCheck.status === 'fail' && !JSON.stringify(redactedCheck).includes(sentinel) &&
      !JSON.stringify(redactedCheck).includes('capturedOutput') &&
      malformedCheck.detailCode === 'failure-record-malformed' && !JSON.stringify(malformedCheck).includes(sentinel));
  clearManagedRuntimeFailure('codex', journalHome);
  check('a successful managed start clears only that agent failure',
    !readManagedRuntimeFailureJournal(journalHome).failures.codex);

  const stateHome = join(testRoot, 'configured-home', '.cosyncing');
  const userHome = dirname(stateHome);
  const cacheHome = join(userHome, '.cache', 'cosyncing');
  makeOwnerOnlyDirectory(stateHome);
  const configured = defaultBrokerConfig();
  writeBrokerConfig(configured, stateHome);
  loadOrCreateBrokerInstanceId(stateHome);
  const credentials = ensureInstallationCredentials({
    home: stateHome,
    internalUrl: configured.broker.internalUrl,
  });

  const minimums = [CODEX_MINIMUM_VERSION, OPENCODE_MINIMUM_VERSION, PI_MINIMUM_VERSION, CLAUDE_MINIMUM_VERSION];
  const cleanAdapters = (['codex', 'opencode', 'pi', 'claude'] as const).map((agent, index) => ({
    id: agent,
    displayName: agent === 'claude' ? 'Claude Code' : `${agent[0]?.toUpperCase()}${agent.slice(1)}`,
    diagnoseSetup: async (): Promise<AgentSetupDiagnosis> => ({
      agent,
      displayName: agent,
      minimumVersion: minimums[index]!,
      checks: [{
        id: `${agent}.fixture`,
        status: 'pass',
        detailCode: 'fixture-ready',
        summary: `${agent} fixture is ready.`,
      }],
    }),
  })) as unknown as AgentBackend[];

  const calls: string[] = [];
  const aggregateContext = fakeContext({
    homeDir: userHome,
    env: {
      HOME: userHome,
      COSYNCING_HOME: stateHome,
      COSYNCING_CACHE_DIR: cacheHome,
    },
    executables: { systemctl: '/usr/bin/systemctl', tailscale: '/usr/bin/tailscale' },
    readText: (path) => path === '/proc/sys/kernel/osrelease'
      ? { ok: true, text: '6.8.0-linux' }
      : { ok: false, reason: 'missing' },
    runReadOnly: async (path, args) => {
      calls.push(`run:${basename(path)}:${args.join(' ')}`);
      if (basename(path) === 'systemctl') return { status: 'ok', stdout: 'running\n', stderr: '' };
      if (args[0] === 'status') {
        return { status: 'ok', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'fixture.tailnet.ts.net.' } }), stderr: '' };
      }
      return {
        status: 'ok',
        stdout: JSON.stringify({
          TCP: { '443': { HTTPS: true } },
          Web: {
            'fixture.tailnet.ts.net:443': {
              Handlers: { '/': { Proxy: configured.broker.internalUrl } },
            },
          },
        }),
        stderr: '',
      };
    },
    fetchJson: async (url, headers, timeoutMs, maxBytes) => {
      calls.push(`get:${new URL(url).pathname}`);
      if (url.includes('/api/broker/health')) {
        check('internal health probe authenticates without placing the token in its URL',
          headers?.['x-cosyncing-token'] === credentials.brokerToken && !url.includes(credentials.brokerToken));
        return { status: 'ok', statusCode: 200, json: { status: 'healthy' } };
      }
      if (url.includes('/api/agent-runtime-updates')) {
        return { status: 'ok', statusCode: 200, json: { updates: [] } };
      }
      if (url.includes('/api/agents')) {
        return { status: 'ok', statusCode: 200, json: [
          { id: 'codex', displayName: 'Codex', canCreateSession: true, syncEnabled: true },
          { id: 'opencode', displayName: 'OpenCode', canCreateSession: true },
          { id: 'pi', displayName: 'Pi', canCreateSession: true },
          { id: 'claude', displayName: 'Claude Code', canCreateSession: true },
        ] };
      }
      // A bare `{ ok: true }` used to satisfy the advertised-endpoint check, because that check only
      // looked at the HTTP status. It now requires the full identity, so the fixture must answer as the
      // configured broker — anything less is exactly the foreign endpoint doctor is meant to reject.
      if (new URL(url).pathname === '/api/health') {
        return { status: 'ok', statusCode: 200, json: {
          ok: true,
          product: 'cosyncing',
          machine: defaultBrokerConfig().broker.machineLabel,
        } };
      }
      return { status: 'ok', statusCode: 200, json: { ok: true } };
    },
  });

  const tokenlessPeerCheck = machinePeerCredentialCheck({
    ...aggregateContext,
    env: {
      ...aggregateContext.env,
      COSYNCING_MACHINE_PEERS: JSON.stringify([{ id: 'peer-b', url: 'https://peer-b.example.test' }]),
    },
  });
  const credentialedPeerCheck = machinePeerCredentialCheck({
    ...aggregateContext,
    env: {
      ...aggregateContext.env,
      COSYNCING_MACHINE_PEERS: JSON.stringify([{
        id: 'peer-b',
        url: 'https://peer-b.example.test',
        credential: { kind: 'peer-token', value: 'private-peer-credential' },
      }]),
    },
  });
  check('doctor warns before a tokenless machine peer crosses the revision-16 authentication boundary',
    tokenlessPeerCheck.status === 'warn'
      && tokenlessPeerCheck.detailCode === 'machine-peer-authentication-required'
      && credentialedPeerCheck.status === 'pass'
      && !JSON.stringify([tokenlessPeerCheck, credentialedPeerCheck]).includes('private-peer-credential'));

  function treeSnapshot(root: string): string {
    const rows: string[] = [];
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const target = join(path, entry.name);
        const label = relative(root, target);
        if (entry.isDirectory()) {
          rows.push(`d:${label}:${statSync(target).mode & 0o777}`);
          walk(target);
        } else {
          rows.push(`f:${label}:${statSync(target).mode & 0o777}:${readFileSync(target, 'base64')}`);
        }
      }
    };
    walk(root);
    return rows.sort().join('\n');
  }

  const before = treeSnapshot(userHome);
  const restartReadiness = codexTuiReadinessCheck({
    status: 'restart-required',
    customSocket: true,
    staleCandidatePids: [424_242],
    message: 'secret socket /private/tailnet/app-server.sock',
  });
  observedDoctorChecks.push(restartReadiness);
  const restartReadinessJson = JSON.stringify(restartReadiness);
  check('Codex terminal readiness is folded into a redacted stable check',
    restartReadiness.status === 'warn' &&
      restartReadiness.detailCode === 'terminal-restart-required' &&
      restartReadiness.evidence?.count === 1 &&
      !restartReadinessJson.includes('424242') &&
      !restartReadinessJson.includes('/private/tailnet'));
  const report = observeDoctorReport(await collectDoctorReport({
    buildInfo: BUILD_INFO,
    context: aggregateContext,
    assetReport: inspectRuntimeAssets(),
    adapters: cleanAdapters,
    stateHome,
    codexTuiReadiness: {
      status: 'ok',
      customSocket: false,
      staleCandidatePids: [],
      message: 'fixture-only raw message',
    },
  }));
  const after = treeSnapshot(userHome);
  const reportJson = JSON.stringify(report);
  const requiredGreenIds = [
    'service.systemd-user', 'network.internal-endpoint', 'runtime.managed-updates', 'codex.broker-create-readiness',
    'opencode.broker-create-readiness', 'pi.broker-create-readiness', 'claude.broker-create-readiness',
    'state.schema.broker-instance',
  ];
  const aggregateChecks = report.sections.flatMap((section) => section.checks);
  // Evidence NAMES what went wrong. This used to report only `report.summary`, so a red run said
  // `{"pass":26,"fail":1}` and left the reader to find the one check by hand — which on a host where
  // this suite had never run is the difference between a diagnosis and a guess.
  const aggregateEvidence = JSON.stringify({
    summary: report.summary,
    notPassing: aggregateChecks
      .filter((item) => item.status === 'fail' || item.status === 'warn')
      .map((item) => `${item.id}:${item.status}:${item.detailCode ?? ''}`),
    missingRequired: requiredGreenIds.filter((id) =>
      !aggregateChecks.some((item) => item.id === id && item.status === 'pass')),
  });
  check('full configured doctor is green and covers service, the local broker, health, and runtime updates',
    report.ok && requiredGreenIds
      .every((id) => aggregateChecks.some((item) => item.id === id && item.status === 'pass')),
    aggregateEvidence);
  check('full doctor preserves the filesystem byte-for-byte and invokes read-only probes only',
    before === after && calls.every((call) => call.startsWith('run:') || call.startsWith('get:')),
    calls.join(','));
  check('stable doctor JSON contains no broker, Pi, or omp credential material',
    !reportJson.includes(credentials.brokerToken) && !reportJson.includes(credentials.piIntegration.credential) &&
      !reportJson.includes(credentials.ompIntegration.credential) &&
      !reportJson.includes('fixture.tailnet.ts.net'));

  const serviceBlindContext: SetupDiagnosisContext = {
    ...aggregateContext,
    resolveExecutable(command) {
      if (command === 'codex') return '/opt/node-v22.14.0-darwin-arm64/bin/codex';
      return aggregateContext.resolveExecutable(command);
    },
    async fetchJson(url, headers, timeoutMs, maxBytes) {
      if (new URL(url).pathname === '/api/agents') {
        return { status: 'ok', statusCode: 200, json: [
          { id: 'codex', displayName: 'Codex', canCreateSession: false, syncEnabled: true },
          { id: 'opencode', displayName: 'OpenCode', canCreateSession: false },
          { id: 'pi', displayName: 'Pi', canCreateSession: false },
          { id: 'claude', displayName: 'Claude Code', canCreateSession: false },
        ] };
      }
      return aggregateContext.fetchJson(url, headers, timeoutMs, maxBytes);
    },
  };
  const serviceBlindReport = await collectDoctorReport({
    buildInfo: BUILD_INFO,
    context: serviceBlindContext,
    assetReport: inspectRuntimeAssets(),
    adapters: cleanAdapters,
    stateHome,
    codexTuiReadiness: {
      status: 'daemon-unavailable',
      customSocket: false,
      staleCandidatePids: [],
      message: 'fixture',
    },
  });
  const serviceBlindChecks = serviceBlindReport.sections.flatMap((section) => section.checks);
  const codexServiceReadiness = serviceBlindChecks.find((item) => item.id === 'codex.broker-create-readiness');
  const piServiceReadiness = serviceBlindChecks.find((item) => item.id === 'pi.broker-create-readiness');
  check('doctor separates interactive installation and sync configuration from live broker creation readiness',
    codexServiceReadiness?.status === 'fail'
      && codexServiceReadiness.detailCode === 'broker-session-creation-unavailable'
      && codexServiceReadiness.evidence?.registered === true
      && codexServiceReadiness.evidence?.syncEnabled === true
      && codexServiceReadiness.evidence?.installedInInteractiveShell === true
      && piServiceReadiness?.status === 'skip'
      && piServiceReadiness.detailCode === 'broker-agent-executable-unavailable',
    `${codexServiceReadiness?.status}/${codexServiceReadiness?.detailCode} vs ${piServiceReadiness?.status}/${piServiceReadiness?.detailCode}`);

  // The persisted setup-failure record escalates with its rollback outcome. A completed rollback left the
  // host as it was, so the record is history (warn). An incomplete one means a transaction journal remains
  // and the host may be partially mutated — repair refuses that state, so doctor must not exit healthy.
  {
    const diagnosticPath = setupFailureDiagnosticPath(stateHome);
    const writeRecord = (rollback: 'complete' | 'incomplete') => {
      // Gate-read by readSetupFailureDiagnostic, so it must be owner-only on this host, not merely
      // chmodded 0o600 — a mode Windows ignores, leaving doctor to report no recorded failure at all.
      atomicWriteOwnerOnly(diagnosticPath, JSON.stringify({
        schemaVersion: SETUP_FAILURE_SCHEMA_VERSION,
        recordedAt: '2026-08-05T12:00:00.000Z',
        transactionId: 'fixture-transaction-1',
        stage: 'applying',
        actionId: 'service.install',
        code: 'action-failed',
        detail: 'fixture: service start health check failed',
        rollback,
      }));
    };
    const failureCheck = (r: DoctorReport) => r.sections.flatMap((section) => section.checks)
      .find((item) => item.id === 'state.last-setup-failure');
    const failureDoctor = async () => observeDoctorReport(await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: aggregateContext,
      assetReport: inspectRuntimeAssets(),
      adapters: cleanAdapters,
      stateHome,
      codexTuiReadiness: { status: 'ok', customSocket: false, staleCandidatePids: [], message: 'fixture-only raw message' },
    }));
    ensureOwnerOnlyDirectory(dirname(diagnosticPath));
    writeRecord('complete');
    const rolledBack = await failureDoctor();
    const rolledBackCheck = failureCheck(rolledBack);
    check('a recorded setup failure with completed rollback is a warning that points at setup',
      rolledBackCheck?.status === 'warn' && rolledBack.ok
        && rolledBackCheck.remediation?.kind === 'command' && rolledBackCheck.remediation.command === 'cosyncing setup',
      JSON.stringify(rolledBackCheck));
    writeRecord('incomplete');
    const pending = await failureDoctor();
    const pendingCheck = failureCheck(pending);
    check('an incomplete rollback is a doctor failure with a nonzero result, still remediated by setup',
      pendingCheck?.status === 'fail' && !pending.ok && pending.summary.fail > 0
        && pendingCheck.remediation?.kind === 'command' && pendingCheck.remediation.command === 'cosyncing setup',
      JSON.stringify(pendingCheck));
    rmSync(diagnosticPath);
  }

  const wslContext = fakeContext({
    homeDir: userHome,
    env: {
      HOME: userHome,
      COSYNCING_HOME: stateHome,
      COSYNCING_CACHE_DIR: cacheHome,
      WSL_DISTRO_NAME: 'Ubuntu',
    },
    executables: { tailscale: '/mnt/c/Program Files/Tailscale/tailscale.exe' },
    fetchJson: aggregateContext.fetchJson,
  });
  const wslReport = observeDoctorReport(await collectDoctorReport({
    buildInfo: BUILD_INFO,
    context: wslContext,
    assetReport: inspectRuntimeAssets(),
    adapters: cleanAdapters,
    stateHome,
    codexTuiReadiness: {
      status: 'unsupported',
      customSocket: false,
      staleCandidatePids: [],
      message: 'fixture-only raw message',
    },
  }));
  const wslChecks = wslReport.sections.flatMap((section) => section.checks);
  check('WSL doctor reports the local runtime without inspecting VPN software',
    wslChecks.some((item) => item.detailCode === 'wsl-foreground-only' && item.status === 'warn')
      && !wslChecks.some((item) => item.id.includes('tailscale') || item.id.includes('advertised')));

  // Connectivity is operator-owned on every host, and the native Windows path is the newest one. Doctor may
  // refuse the host, but it must never resolve, run, or report an external connectivity provider while
  // doing so — a Windows row that inspected Tailscale would re-create the ownership this architecture drops.
  {
    const resolved: string[] = [];
    const ran: string[] = [];
    const windowsContext: SetupDiagnosisContext = {
      ...fakeContext({
        homeDir: userHome,
        platform: 'win32',
        env: { HOME: userHome, COSYNCING_HOME: stateHome, COSYNCING_CACHE_DIR: cacheHome },
        executables: {
          'tailscale.exe': 'C:\\Program Files\\Tailscale\\tailscale.exe',
          tailscale: 'C:\\Program Files\\Tailscale\\tailscale.exe',
        },
      }),
      resolveExecutable: (command) => {
        resolved.push(command);
        return command === 'tailscale' || command === 'tailscale.exe'
          ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
          : undefined;
      },
      runReadOnly: async (executable, args) => {
        ran.push([executable, ...args].join(' '));
        return { status: 'unavailable', stdout: '', stderr: '' };
      },
    };
    const windowsReport = observeDoctorReport(await collectDoctorReport({
      buildInfo: BUILD_INFO,
      context: windowsContext,
      assetReport: inspectRuntimeAssets(),
      adapters: cleanAdapters,
      stateHome,
      codexTuiReadiness: {
        status: 'unsupported',
        customSocket: false,
        staleCandidatePids: [],
        message: 'fixture-only raw message',
      },
    }));
    const windowsChecks = windowsReport.sections.flatMap((section) => section.checks);
    const connectivity = /tailscale|serve|advertised|tunnel|vpn|mesh/i;
    check('native Windows x64 is now a supported host rather than a refusal',
      windowsChecks.some((item) => item.id === 'host.platform'
        && item.status === 'pass' && item.detailCode === 'windows-supported'),
      JSON.stringify(windowsChecks.find((item) => item.id === 'host.platform')));

    // The refused Windows shapes, and the property the old refusal was really pinning: a host doctor will
    // not run on must not be probed for external connectivity on the way to saying so. `arm64` here is the
    // MACHINE, which is the only thing that distinguishes an emulated x64 process from a native one.
    const refusedShapes: Array<[string, 'x64' | 'arm64' | 'unknown', string]> = [
      ['x64', 'arm64', 'windows-emulated-x64-not-qualified'],
      ['arm64', 'arm64', 'windows-arm64-not-qualified'],
      ['x64', 'unknown', 'windows-machine-architecture-unverified'],
    ];
    const refusals: string[] = [];
    for (const [processArch, machine, expected] of refusedShapes) {
      const probed: string[] = [];
      const report = observeDoctorReport(await collectDoctorReport({
        buildInfo: BUILD_INFO,
        context: {
          ...fakeContext({
            homeDir: userHome,
            platform: 'win32',
            arch: processArch,
            windowsMachineArchitecture: () => machine,
            env: { HOME: userHome, COSYNCING_HOME: stateHome, COSYNCING_CACHE_DIR: cacheHome },
            executables: {
              'tailscale.exe': 'C:\\Program Files\\Tailscale\\tailscale.exe',
              tailscale: 'C:\\Program Files\\Tailscale\\tailscale.exe',
            },
          }),
          resolveExecutable: (command) => { probed.push(command); return undefined; },
        },
        assetReport: inspectRuntimeAssets(),
        adapters: cleanAdapters,
        stateHome,
        codexTuiReadiness: {
          status: 'unsupported', customSocket: false, staleCandidatePids: [], message: 'fixture-only raw message',
        },
      }));
      const checks = report.sections.flatMap((section) => section.checks);
      const host = checks.find((item) => item.id === 'host.platform');
      const quiet = !checks.some((item) => connectivity.test(item.id)
        || connectivity.test(item.detailCode ?? '') || connectivity.test(item.summary ?? ''))
        && !probed.some((command) => connectivity.test(command));
      refusals.push(`${processArch}/${machine}=${host?.detailCode}${quiet ? '' : ':probed'}`);
      if (host?.status !== 'fail' || host.detailCode !== expected || !quiet) {
        refusals.push(`${processArch}/${machine}:unexpected`);
      }
    }
    check('every unqualified Windows shape is refused without inspecting external connectivity',
      refusals.length === refusedShapes.length && !refusals.some((entry) => entry.includes('unexpected')),
      refusals.join(' | '));
  }

  // macOS honesty: doctor must not call a supported host "not a v1 host", must not report a missing
  // systemd/systemctl, and must not send the operator to journalctl or a lingering policy that has no
  // launchd equivalent.
  const darwinContext = fakeContext({
    homeDir: userHome,
    platform: 'darwin',
    env: { HOME: userHome, COSYNCING_HOME: stateHome, COSYNCING_CACHE_DIR: cacheHome },
    executables: { launchctl: '/bin/launchctl' },
    runReadOnly: async (executable, args) => (executable === '/bin/launchctl' && args[0] === 'print'
      ? { status: 'ok', exitCode: 0, stdout: 'gui/501 = {\n\tstate = running\n}\n', stderr: '' }
      : { status: 'unavailable', stdout: '', stderr: '' }),
    fetchJson: aggregateContext.fetchJson,
  });
  const darwinReport = observeDoctorReport(await collectDoctorReport({
    buildInfo: BUILD_INFO,
    context: darwinContext,
    assetReport: inspectRuntimeAssets(),
    adapters: cleanAdapters,
    stateHome,
    codexTuiReadiness: {
      status: 'unsupported',
      customSocket: false,
      staleCandidatePids: [],
      message: 'fixture-only raw message',
    },
  }));
  const darwinChecks = darwinReport.sections.flatMap((section) => section.checks);
  const darwinHost = darwinChecks.find((item) => item.id === 'host.platform');
  const darwinService = darwinChecks.find((item) => item.id === 'service.launchd-user');
  const darwinRendered = renderDoctorReport(darwinReport);
  check('darwin doctor reports macOS as a supported host, not a fast-follow',
    darwinHost?.status === 'pass' && darwinHost.detailCode === 'macos-supported'
      && !darwinChecks.some((item) => item.detailCode === 'macos-fast-follow'),
    `${darwinHost?.status}:${darwinHost?.detailCode}`);
  check('darwin doctor checks launchctl and never reports systemctl missing or a systemd user manager',
    darwinService?.status === 'pass' && darwinService.detailCode === 'launchd-user-ready'
      && !darwinChecks.some((item) => item.id === 'service.systemd-user')
      && !darwinChecks.some((item) => item.detailCode === 'systemctl-missing'
        || item.detailCode === 'systemd-user-unavailable'),
    JSON.stringify(darwinChecks.filter((item) => item.id.startsWith('service.')).map((item) => `${item.id}:${item.status}:${item.detailCode}`)));
  check('darwin doctor remediation never names journalctl, systemctl, or user lingering',
    !/journalctl|systemctl|loginctl|enable-linger/i.test(darwinRendered)
      && !/journalctl|systemctl|loginctl/i.test(JSON.stringify(darwinReport)),
    darwinRendered.split('\n').filter((line) => /journalctl|systemctl|loginctl/i.test(line)).join(' | '));

  // With launchd selected, the installed-service check inspects the launchd receipt and skips lingering
  // outright instead of failing it as unverifiable.
  const darwinServiceHome = mkdtempSync(join(tmpdir(), 'cosyncing-doctor-darwin-'));
  writeFileSync(
    join(darwinServiceHome, 'setup-state.json'),
    `${JSON.stringify({ schemaVersion: 1, serviceChoice: 'launchd', systemdLingeringRequested: true })}\n`,
    { mode: 0o600 },
  );
  const darwinInstalledReport = observeDoctorReport(await collectDoctorReport({
    buildInfo: BUILD_INFO,
    context: darwinContext,
    assetReport: inspectRuntimeAssets(),
    adapters: [],
    stateHome: darwinServiceHome,
    codexTuiReadiness: { status: 'unsupported', customSocket: false, staleCandidatePids: [], message: 'fixture' },
  }));
  const darwinInstalled = darwinInstalledReport.sections.flatMap((section) => section.checks);
  const brokerService = darwinInstalled.find((item) => item.id === 'service.broker');
  const lingering = darwinInstalled.find((item) => item.id === 'service.systemd-lingering');
  rmSync(darwinServiceHome, { recursive: true, force: true });
  check('a launchd installation is inspected as launchd and its lingering check is skipped, not failed',
    brokerService?.detailCode !== 'broker-service-not-selected'
      && lingering?.status === 'skip' && lingering.detailCode === 'lingering-unsupported-on-launchd',
    `${brokerService?.status}:${brokerService?.detailCode} / ${lingering?.status}:${lingering?.detailCode}`);

  let cliOut = '';
  let cliErr = '';
  const jsonExit = await runCli(['doctor', '--json'], {
    buildInfo: BUILD_INFO,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => report,
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  const cliJson = JSON.parse(cliOut) as DoctorReport;
  check('doctor --json emits the stable full report and a green exit code',
    jsonExit === 0 && cliJson.schemaVersion === 1 && cliJson.effects === 'forbidden' && cliJson.sections.length === 7 && !cliErr);

  cliOut = '';
  const humanExit = await runCli(['doctor'], {
    buildInfo: BUILD_INFO,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => report,
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  check('human doctor output is concise, sectioned, and actionable',
    humanExit === 0 && cliOut.includes('Configuration and state') && cliOut.includes('Managed runtimes') && cliOut.includes('Summary:'));
  const pipedHuman = cliOut;

  // The render above is English because the fixture home persists no language, not because the CLI
  // ignores one. Plant a choice under COSYNCING_HOME and the same invocation must follow it.
  const zhHome = join(testRoot, 'zh-home');
  makeOwnerOnlyDirectory(zhHome);
  writeFileSync(
    join(zhHome, 'setup-state.json'),
    `${JSON.stringify({ schemaVersion: 1, language: 'zh-Hans' })}\n`,
    { mode: 0o600 },
  );
  process.env.COSYNCING_HOME = zhHome;
  cliOut = '';
  const persistedLanguageExit = await runCli(['doctor'], {
    buildInfo: BUILD_INFO,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => report,
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  const persistedLanguageHuman = cliOut;
  process.env.COSYNCING_HOME = cliHome;
  check('the human doctor render follows the language persisted in COSYNCING_HOME',
    persistedLanguageExit === 0 && persistedLanguageHuman.includes('配置和状态')
      && persistedLanguageHuman.includes('托管运行时') && persistedLanguageHuman.includes('汇总：')
      && !persistedLanguageHuman.includes('Configuration and state')
      && !persistedLanguageHuman.includes('Summary:'),
    persistedLanguageHuman.slice(0, 200));

  const chineseHuman = renderDoctorReport(report, { language: 'zh-Hans' });
  const literalMissing = literalDoctorCopy()
    .filter((item) => translateDoctorTextToChinese(item.text) === undefined);
  const dynamicBranchCopy = [
    'The agents cosyncing skill is an older packaged version; setup or repair will refresh it to this build\'s version.',
    'The requested agents cosyncing skill is missing.',
    'The requested agents cosyncing skill is missing and lacks a matching receipt.',
    'The agents cosyncing skill is modified, unsafe, or lacks matching ownership evidence.',
    'The package-owned cosyncing skill is present in the agents discovery root.',
    'The last setup run failed while applying service.install: fixture detail',
    'The last setup run failed while in the applying stage: fixture detail',
  ];
  const observedMissing = observedDoctorChecks
    .filter((item) => !item.detailCode.startsWith('fixture-'))
    .flatMap((item) => [
      ...(translateDoctorTextToChinese(item.summary) === undefined ? [`${item.detailCode}:summary:${item.summary}`] : []),
      ...(item.remediation && translateDoctorTextToChinese(item.remediation.message) === undefined
        ? [`${item.detailCode}:remediation:${item.remediation.message}`]
        : []),
    ]);
  const dynamicMissing = dynamicBranchCopy.filter((text) => translateDoctorTextToChinese(text) === undefined);
  check('Chinese doctor catalog covers every literal branch and every exercised dynamic branch',
    literalMissing.length === 0 && observedMissing.length === 0 && dynamicMissing.length === 0,
    [
      ...literalMissing.map((item) => `${item.file}:${item.text}`),
      ...observedMissing,
      ...dynamicMissing.map((text) => `dynamic:${text}`),
    ].join('\n'));
  const driftAndFallbackReport: DoctorReport = {
    ...report,
    ok: true,
    summary: { pass: 0, warn: 2, fail: 0, skip: 0 },
    sections: [{
      id: 'state',
      title: 'Configuration and state',
      checks: [{
        id: 'state.agent-skill.agents',
        status: 'warn',
        detailCode: 'agent-skill-unowned-drift',
        summary: 'The agents cosyncing skill is modified, unsafe, or lacks matching ownership evidence.',
        remediation: {
          kind: 'manual',
          message: 'Preserve or reconcile the user-managed copy explicitly; repair will not overwrite it.',
        },
      }, {
        id: 'future.branch',
        status: 'warn',
        detailCode: 'future-detail-code',
        summary: 'Future English summary that has no catalog entry.',
        remediation: { kind: 'manual', message: 'Future English remediation that has no catalog entry.' },
      }],
    }],
  };
  const driftAndFallbackChinese = renderDoctorReport(driftAndFallbackReport, { language: 'zh-Hans' });
  check('Chinese doctor renders skill drift accurately and never leaks uncataloged English copy',
    driftAndFallbackChinese.includes('agents cosyncing skill 已被修改、不安全或缺少匹配的归属证据。')
      && driftAndFallbackChinese.includes('请明确保留或修复用户管理的副本；repair 不会覆盖它。')
      && driftAndFallbackChinese.includes('检查 future.branch 返回 future-detail-code。')
      && driftAndFallbackChinese.includes('请根据此检查的错误码处理。')
      && !driftAndFallbackChinese.includes('Future English')
      && !driftAndFallbackChinese.includes('Preserve or reconcile'),
    driftAndFallbackChinese);
  check('Chinese doctor localizes headings, verdicts, summaries, and remediation while preserving check ids and commands',
    chineseHuman.includes('cosyncing 诊断')
      && chineseHuman.includes('配置和状态')
      && chineseHuman.includes('托管运行时')
      && chineseHuman.includes('[正常] state.config: Broker 配置有效。')
      && chineseHuman.includes('汇总：')
      && !chineseHuman.includes('Configuration and state')
      && !chineseHuman.includes('Summary:'),
    chineseHuman.slice(0, 500));

  // Colour is a terminal affordance only. A piped render must stay byte-identical to what it always was,
  // and a coloured render must differ from it by escapes alone.
  const plain = renderDoctorReport(report);
  const colored = renderDoctorReport(report, { color: true });
  const escape = String.fromCharCode(27);
  const stripped = colored.replaceAll(new RegExp(`${escape}\\[\\d+m`, 'g'), '');
  check('piped doctor output carries no escape sequences and matches the uncoloured render',
    !pipedHuman.includes(escape) && !plain.includes(escape) && pipedHuman === plain);
  check('coloured doctor output differs from the plain render by escapes alone',
    colored !== plain && stripped === plain);
  // One check per status, so every branch of the mapping is rendered rather than only the ones a clean
  // fixture happens to produce.
  const paletteReport: DoctorReport = {
    ...report,
    summary: { pass: 1, warn: 1, fail: 1, skip: 1 },
    sections: [{
      id: 'state',
      title: 'Palette',
      checks: (['pass', 'warn', 'fail', 'skip'] as const).map((status) => ({
        id: `palette.${status}`,
        status,
        detailCode: `palette-${status}`,
        summary: `${status} fixture`,
      })),
    }],
  };
  const palette = renderDoctorReport(paletteReport, { color: true });
  check('doctor colours ok green, warnings yellow, errors red, and info blue',
    palette.includes(`${escape}[32m[ok]${escape}[0m`)
      && palette.includes(`${escape}[33m[warning]${escape}[0m`)
      && palette.includes(`${escape}[31m[error]${escape}[0m`)
      && palette.includes(`${escape}[34m[info]${escape}[0m`)
      && palette.includes(`Summary: ${escape}[32m1 passed${escape}[0m, ${escape}[33m1 warnings${escape}[0m, `
        + `${escape}[31m1 failed${escape}[0m, ${escape}[34m1 skipped${escape}[0m.`)
      && renderDoctorReport(paletteReport) === palette.replaceAll(new RegExp(`${escape}\\[\\d+m`, 'g'), ''),
    JSON.stringify(palette));
  check('doctor colour is refused off a TTY, under NO_COLOR, and on a dumb terminal',
    doctorColorEnabled({ env: {}, tty: true })
      && doctorColorEnabled({ env: { NO_COLOR: '' }, tty: true })
      && !doctorColorEnabled({ env: {}, tty: false })
      && !doctorColorEnabled({ env: { NO_COLOR: '1' }, tty: true })
      && !doctorColorEnabled({ env: { TERM: 'dumb' }, tty: true }));

  cliOut = '';
  const forcedExit = await runCli(['doctor'], {
    buildInfo: BUILD_INFO,
    colorize: true,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => report,
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  const forcedHuman = cliOut;
  cliOut = '';
  const machineExit = await runCli(['doctor', '--json'], {
    buildInfo: BUILD_INFO,
    colorize: true,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => report,
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  check('the machine-readable mode stays byte-identical even with colour forced on',
    forcedExit === 0 && machineExit === 0 && forcedHuman.includes(escape)
      && !cliOut.includes(escape) && JSON.parse(cliOut).schemaVersion === 1,
    `human=${forcedHuman.includes(escape)} json=${cliOut.includes(escape)}`);

  cliOut = '';
  cliErr = '';
  const fatalExit = await runCli(['doctor', '--json'], {
    buildInfo: BUILD_INFO,
    inspectRuntimeAssets: () => inspectRuntimeAssets(),
    collectDoctorReport: async () => { throw new Error(sentinel); },
    stdout: { write: (value) => { cliOut += value; } },
    stderr: { write: (value) => { cliErr += value; } },
  });
  check('unexpected doctor errors fail closed without reflecting exception text',
    fatalExit === 1 && JSON.parse(cliOut).detailCode === 'doctor-internal-error' && !cliOut.includes(sentinel) && !cliErr);
} finally {
  if (realCosyncingHome === undefined) delete process.env.COSYNCING_HOME;
  else process.env.COSYNCING_HOME = realCosyncingHome;
  rmSync(testRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} doctor checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} doctor checks`);
