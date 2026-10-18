#!/usr/bin/env bun
/** Packaged JavaScript: platform verdicts, external runtime, web sidecar and service lifecycle. */
import {
  existsSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PRODUCT_IDENTITY } from '../../../../packages/typescript/protocol/src/product.ts';
import {
  SUPPORTED_BROKER_HOSTS,
  brokerHostVerdict,
  isSupportedBrokerProcessTuple,
} from '../../../../packages/typescript/broker/src/installation/supported-hosts.ts';
import {
  classifyWindowsMachine,
  windowsNativeMachineArchitecture,
  windowsPowerShellChildEnvironment,
} from '../../../../packages/typescript/adapter-api/src/host-process.ts';
import { stageWebSidecarDirectory, validateWebBuildShape } from '../../release/package-web-sidecar.ts';
import { writeStampedWebBuild, STAMPED_WEB_FIXTURE_COMMIT } from '../../../../packages/typescript/broker/test/helpers/stamped-web-build.ts';
import { reserveLoopbackFixturePort } from '../../../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import {
  insideSupervisedProcessGroup,
  runSupervised,
} from '../../../ci/lib/process.ts';

const ROOT = resolve(import.meta.dir, '../../../..');
/** The acquisition layout setup copies into its owned installation. */
const PACKAGED_APPLICATION = `bin/${PRODUCT_IDENTITY.primaryBinary}`;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * The ambient environment minus every override the PRODUCT legitimately honors.
 *
 * These assertions are about what the package ships and what it resolves from its own layout, so a developer
 * shell that exports `COSYNCING_WEB_DIR` (this repository's does) must not be able to change the answer.
 */
function hermeticEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  for (const key of ['COSYNCING_WEB_DIR']) {
    if (!(key in overrides)) delete environment[key];
  }
  return environment;
}

/**
 * Every external command, with its own wall time reported.
 *
 * This suite builds a JavaScript bundle and exercises its installed service, so when it runs
 * long the useful question is always WHICH step — a silent five-minute suite forces the next person to
 * bisect it by hand.
 */
async function run(command: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const label = command.slice(0, 3).join(' ');
  const startedAt = performance.now();
  const child = await runSupervised(command, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? hermeticEnvironment(),
    timeoutMs: options.timeoutMs ?? 60_000,
    maxBufferBytes: 8 << 20,
    isolateProcessGroup: !insideSupervisedProcessGroup(),
  });
  console.log(`STAGE ${label} — ${Math.round(performance.now() - startedAt)}ms`);
  return { exitCode: child.exitCode ?? 1, stdout: child.stdout, stderr: child.stderr };
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
const sidecar = `${PRODUCT_IDENTITY.releaseAssetPrefix}-web-${version}`;
const root = mkdtempSync(join(tmpdir(), 'cosyncing-javascript-installation-'));

/**
 * Where the fixture service manager records the broker it started.
 *
 * The lifecycle section deliberately starts that process in its OWN session so the supervisor of the
 * command that launched it cannot sweep it up — which makes stopping it this suite's job, on every exit
 * path, not only the one where uninstall runs.
 */
let servicePidFile: string | undefined;

function stopFixtureService(): void {
  if (!servicePidFile || !existsSync(servicePidFile)) return;
  const pid = Number.parseInt(readFileSync(servicePidFile, 'utf8').trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(servicePidFile, { force: true });
}

try {
  // A complete, internally consistent stamped web build, so the package can be assembled with its client
  // without a Flutter toolchain. It goes through exactly the closed-set validation the release lane uses.
  const webFixture = join(root, 'web-build');
  await writeStampedWebBuild(webFixture);
  const expectedWebPaths = [...validateWebBuildShape({ buildDirectory: webFixture }).paths].sort();

  const prefix = join(root, 'install-prefix');
  const installedPackage = join(prefix, 'application');
  const stage = installedPackage;
  const applicationPath = join(stage, PACKAGED_APPLICATION);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const staged = await run([
    'bun', 'run', 'scripts/broker/build-broker-bundle.ts',
    '--outfile', applicationPath, '--commit', STAMPED_WEB_FIXTURE_COMMIT,
  ], { timeoutMs: 120_000 });
  if (staged.exitCode !== 0) throw new Error(staged.stderr);
  stageWebSidecarDirectory({
    buildDirectory: webFixture, targetDirectory: join(stage, 'bin', sidecar), paths: expectedWebPaths,
  });
  for (const command of [PRODUCT_IDENTITY.primaryBinary, PRODUCT_IDENTITY.aliasBinary]) {
    symlinkSync(applicationPath, join(prefix, 'bin', command));
  }

  check('the supported broker process tuples are exactly the qualified four',
    isSupportedBrokerProcessTuple('linux', 'x64') && isSupportedBrokerProcessTuple('linux', 'arm64')
      && isSupportedBrokerProcessTuple('darwin', 'arm64') && isSupportedBrokerProcessTuple('win32', 'x64')
      && !isSupportedBrokerProcessTuple('darwin', 'x64') && !isSupportedBrokerProcessTuple('win32', 'arm64'),
    SUPPORTED_BROKER_HOSTS.map((host) => `${host.platform}-${host.arch}`).join(','));

  // ---- The Windows ARM64 boundary, stated as verdicts ---------------------------------------------------
  // Windows ARM64 is NOT refused because no runtime exists for it: Bun has shipped one since 1.3.10. It is
  // refused because nothing in this project has been run on it. The wording says so, and these cases pin
  // both halves of the question — what the process is, and what the machine underneath it is.
  const hostCases: Array<[string, string, 'x64' | 'arm64' | 'other' | 'unknown', string]> = [
    ['win32', 'x64', 'x64', 'supported'],
    ['win32', 'arm64', 'arm64', 'windows-arm64-not-qualified'],
    ['win32', 'x64', 'arm64', 'windows-emulated-x64-not-qualified'],
    ['win32', 'x64', 'unknown', 'windows-machine-architecture-unverified'],
    ['win32', 'x64', 'other', 'windows-machine-architecture-unverified'],
    ['linux', 'arm64', 'unknown', 'supported'],
    ['darwin', 'arm64', 'unknown', 'supported'],
    ['darwin', 'x64', 'unknown', 'host-architecture-unsupported'],
  ];
  const hostOutcomes = hostCases.map(([platform, arch, machine, expected]) => {
    const verdict = brokerHostVerdict({ platform, arch, windowsMachineArchitecture: () => machine });
    const actual = verdict.status === 'supported' ? 'supported' : verdict.code;
    return { label: `${platform}/${arch}/${machine}`, ok: actual === expected, actual };
  });
  check('the host verdict admits Windows x64 and refuses every unqualified Windows shape',
    hostOutcomes.every((outcome) => outcome.ok),
    hostOutcomes.map((outcome) => `${outcome.label}=${outcome.actual}`).join(' | '));
  // The PROVIDER, not only the verdict that consumes it. Every case above injects an architecture string
  // directly, so none of them exercises what the probe does with what the machine actually reports.
  const machineCases: Array<[string, number | undefined, string]> = [
    ['amd64', 0x8664, 'x64'],
    ['arm64', 0xaa64, 'arm64'],
    ['other-machine', 0x01c4, 'other'],
    // IMAGE_FILE_MACHINE_UNKNOWN: the call succeeded and declined to name the machine.
    ['declined', 0x0000, 'unknown'],
    // The call failed, or the library could not be loaded at all.
    ['unreadable', undefined, 'unknown'],
  ];
  const machineOutcomes = machineCases.map(([label, word, expected]) => {
    const actual = classifyWindowsMachine(word);
    return { label, actual, ok: actual === expected };
  });
  check('the native-architecture probe maps every answer and refusal it can receive',
    machineOutcomes.every((outcome) => outcome.ok),
    machineOutcomes.map((outcome) => `${outcome.label}=${outcome.actual}`).join(' | '));
  // A machine that named itself and is not one we have qualified is NOT the same as one that could not
  // be asked. Both refuse the host, but only the second is worth retrying, and an operator reading
  // "unverified" about a machine that answered plainly would go looking for the wrong fault.
  check('a real answer we do not recognise is distinguished from no answer at all',
    classifyWindowsMachine(0x01c4) === 'other' && classifyWindowsMachine(undefined) === 'unknown');
  // End to end through the exported entry point, with the reader injected: proves the seam the physical
  // host exercises is the same one these cases do, rather than a classifier nothing calls.
  check('the probe entry point returns what its injected reader reports',
    windowsNativeMachineArchitecture(() => 0xaa64) === 'arm64'
      && windowsNativeMachineArchitecture(() => 0x8664) === 'x64'
      && windowsNativeMachineArchitecture(() => undefined) === 'unknown');
  // The machine question is answered by calling the kernel export directly. It used to spawn PowerShell
  // to COMPILE C# to reach the same function -- 332ms measured against 0.003ms, and on a host with a cold
  // module-analysis cache it blocked past twenty seconds and refused a supported machine at startup.
  // Pinned in the source, because the cost and the hang are both invisible from a POSIX gate.
  {
    const source = readFileSync(
      join(ROOT, 'packages/typescript/adapter-api/src/host-process.ts'), 'utf8',
    );
    // Comments stripped first. The function's own comment RECORDS that it used to spawn PowerShell,
    // and a scan that reads prose would fail on the sentence explaining why it no longer does.
    const code = source
      .slice(source.indexOf('export function windowsNativeMachineArchitecture'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    check('the machine probe reaches the kernel directly, with no shell and no compiler',
      !/Add-Type|powershell|spawnSync/i.test(code) && code.includes('windowsFfi()'),
      code.slice(0, 0));
  }
  // Task Scheduler registration is the one Windows PowerShell caller left, and 5.1 is named explicitly.
  // A host with PowerShell 7 exports module roots 5.1 cannot use; pinned, the child sees the system store.
  check('every remaining Windows PowerShell child is pinned to the system module store',
    windowsPowerShellChildEnvironment({
      SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
    }).PSModulePath === join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));

  // The refusal has to READ as "not yet", or an operator concludes the platform is impossible rather than
  // unqualified — and the next person to qualify it inherits that impression from our own copy.
  const armVerdict = brokerHostVerdict({
    platform: 'win32', arch: 'arm64', windowsMachineArchitecture: () => 'arm64',
  });
  check('the Windows ARM64 refusal says not yet qualified rather than unavailable',
    armVerdict.status === 'refused'
      && /not yet qualified/i.test(armVerdict.remediation)
      && !/bun/i.test(`${armVerdict.summary} ${armVerdict.remediation}`),
    armVerdict.status === 'refused' ? armVerdict.remediation : 'supported');

  // ---- The application is JavaScript --------------------------------------------------------------------
  const applicationBytes = existsSync(applicationPath) ? readFileSync(applicationPath) : Buffer.alloc(0);
  const firstLine = applicationBytes.subarray(0, 64).toString('utf8').split('\n', 1)[0] ?? '';
  check('the executable entry is plain JavaScript beginning with a Bun shebang',
    firstLine === '#!/usr/bin/env bun'
      && applicationBytes.subarray(0, 4).toString('hex') !== '7f454c46'
      && applicationBytes.byteLength > 100_000,
    `${JSON.stringify(firstLine)} ${applicationBytes.byteLength}B`);
  check('the staged package is executable after installation',
    existsSync(applicationPath) && (Bun.file(applicationPath).size ?? 0) > 0
      && ((readFileSync(applicationPath), true)));

  // ---- The web sidecar ----------------------------------------------------------------------------------
  const shippedSidecar = join(stage, 'bin', sidecar);
  const shippedWebPaths: string[] = [];
  const walkWeb = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walkWeb(join(directory, entry.name), relative);
      else shippedWebPaths.push(relative);
    }
  };
  if (existsSync(shippedSidecar)) walkWeb(shippedSidecar, '');
  check('the package ships the validated /cosy/ web client beside its application',
    existsSync(join(shippedSidecar, 'index.html'))
      && JSON.stringify(shippedWebPaths.sort()) === JSON.stringify(expectedWebPaths)
      && readFileSync(join(shippedSidecar, 'index.html'), 'utf8').includes('<base href="/cosy/">'),
    `${shippedWebPaths.length}/${expectedWebPaths.length} files`);

  const runHome = join(prefix, 'run-home');
  mkdirSync(runHome, { recursive: true });
  const commandEnvironment = hermeticEnvironment({
    HOME: runHome,
    COSYNCING_HOME: join(runHome, '.cosyncing'),
  });
  const primaryVersion = await run(
    [join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary), 'version', '--json'],
    { cwd: prefix, env: commandEnvironment },
  );
  const aliasVersion = await run(
    [join(prefix, 'bin', PRODUCT_IDENTITY.aliasBinary), 'version', '--json'],
    { cwd: prefix, env: commandEnvironment },
  );
  const reported = primaryVersion.exitCode === 0
    ? JSON.parse(primaryVersion.stdout) as Record<string, unknown>
    : {};
  check('the installed cosyncing command runs through the shebang and answers as the packaged build',
    primaryVersion.exitCode === 0
      && reported.product === PRODUCT_IDENTITY.productName
      && reported.version === version
      && reported.commit === STAMPED_WEB_FIXTURE_COMMIT,
    `exit=${primaryVersion.exitCode} ${primaryVersion.stderr.trim().slice(0, 160)}`);
  check('the installed cosy alias answers identically to the primary command',
    aliasVersion.exitCode === 0 && aliasVersion.stdout === primaryVersion.stdout,
    `exit=${aliasVersion.exitCode}`);

  // Build metadata has to be truthful about BOTH facts that used to be one boolean: this is an installed
  // product (`packaged`), and it is the JavaScript distribution (`distribution`), which is what keeps it out
  // of the signed native replacement path. `universal` rather than a host triple, because one JavaScript
  // file has no machine-code binding and must not name a native release artifact.
  check('the installed build reports the JavaScript distribution kind and a universal artifact target',
    reported.packaged === true && reported.distribution === 'bootstrap-js' && reported.target === 'universal',
    `${reported.distribution}/${reported.target}/packaged=${reported.packaged}`);

  // Legacy npm identity must remain readable and refuse signed replacement before touching an install.
  const legacyApplication = join(root, 'legacy', 'cosyncing');
  const legacyBuild = await run([
    'bun', 'run', 'scripts/broker/build-broker-bundle.ts', '--outfile', legacyApplication,
    '--distribution', 'bun-js', '--commit', STAMPED_WEB_FIXTURE_COMMIT,
  ]);
  if (legacyBuild.exitCode !== 0) throw new Error(legacyBuild.stderr);
  const legacyUpgrade = await run([legacyApplication, 'upgrade', '--yes', '--json'], { env: commandEnvironment });
  const legacyResult = JSON.parse(legacyUpgrade.stdout) as { detailCode?: string; summary?: string };
  check('legacy npm ownership refuses replacement and directs explicit installer migration',
    legacyUpgrade.exitCode !== 0 && legacyResult.detailCode === 'upgrade-package-manager-owned'
      && legacyResult.summary?.includes('https://cosyncing.com/#install') === true
      && !existsSync(join(commandEnvironment.COSYNCING_HOME!, 'install-state.json')),
    legacyUpgrade.stderr.trim().slice(0, 160));

  // ---- The installed package serves /cosy/ --------------------------------------------------------------
  //
  // Resolved from the APPLICATION, which in this distribution is not `process.execPath`. If anything went
  // back to deriving the web root from the running executable, this reports the sidecar as absent while the
  // file sits right there in the package.
  const doctor = await run(
    [join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary), 'doctor', '--json'],
    { cwd: prefix, env: commandEnvironment, timeoutMs: 120_000 },
  );
  let webCheck: Record<string, unknown> | undefined;
  let runtimeCheck: Record<string, unknown> | undefined;
  try {
    const report = JSON.parse(doctor.stdout) as {
      sections: Array<{ checks: Array<Record<string, unknown>> }>;
    };
    for (const section of report.sections) {
      for (const item of section.checks) {
        if (item.id === 'package.flutter-web') webCheck = item;
        if (item.id === 'package.runtime') runtimeCheck = item;
      }
    }
  } catch {
    // Reported by the checks below as a missing result rather than swallowed.
  }
  check('the installed package resolves its bundled /cosy/ client from the application, not the runtime',
    webCheck?.status === 'pass' && webCheck?.detailCode === 'asset-ok',
    `${webCheck?.status}/${webCheck?.detailCode}`);
  check('the installed package reports the external Bun runtime it requires',
    runtimeCheck?.status === 'pass' && runtimeCheck?.detailCode === 'runtime-available'
      && typeof (runtimeCheck?.evidence as Record<string, unknown> | undefined)?.runtime === 'string',
    `${runtimeCheck?.status}/${runtimeCheck?.detailCode}`);

  // ---- The runtime an operator can get wrong -------------------------------------------------------------
  //
  // `COSYNCING_BUN_BIN` names a file the operator typed. Structural validation accepts anything the kernel
  // will exec, so these are the states where that is not enough: the file was removed, it is executable but
  // is not Bun, or it is a Bun older than this build's floor. Run against the INSTALLED command, because a
  // unit-level refusal proves nothing about what a real invocation does with it.
  const runtimeProbes: Array<{ label: string; override: string; detailCode: string }> = [];
  const overrideDir = join(prefix, 'runtime-overrides');
  mkdirSync(overrideDir, { recursive: true });
  const writeFakeRuntime = (name: string, script: string): string => {
    const path = join(overrideDir, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  };
  for (const candidate of [
    { label: 'removed', override: join(overrideDir, 'never-installed'), detailCode: 'bun-runtime-override-unusable' },
    { label: 'not Bun', override: writeFakeRuntime('silent', 'exit 0'), detailCode: 'bun-runtime-unrecognized' },
    { label: 'failing', override: writeFakeRuntime('broken', 'exit 3'), detailCode: 'bun-runtime-probe-failed' },
    { label: 'outdated', override: writeFakeRuntime('old-bun', 'echo 1.2.9+aaaaaaaaaa'), detailCode: 'bun-runtime-outdated' },
  ]) {
    const probeHome = join(prefix, `runtime-probe-${candidate.label.replace(/\s+/g, '-')}`);
    mkdirSync(probeHome, { recursive: true });
    const probed = await run(
      [join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary), 'doctor', '--json'],
      {
        cwd: prefix,
        timeoutMs: 120_000,
        env: hermeticEnvironment({
          HOME: probeHome,
          COSYNCING_HOME: join(probeHome, '.cosyncing'),
          COSYNCING_BUN_BIN: candidate.override,
        }),
      },
    );
    let reportedCode: unknown;
    try {
      const report = JSON.parse(probed.stdout) as { sections: Array<{ checks: Array<Record<string, unknown>> }> };
      for (const section of report.sections) {
        for (const item of section.checks) if (item.id === 'package.runtime') reportedCode = item.detailCode;
      }
    } catch { /* reported as a mismatch below */ }
    runtimeProbes.push({ label: candidate.label, override: candidate.override, detailCode: String(reportedCode) });
    check(`doctor names the exact runtime problem when the configured Bun is ${candidate.label}`,
      reportedCode === candidate.detailCode,
      `expected ${candidate.detailCode}, got ${String(reportedCode)}`);
  }

  // Diagnosis surviving a broken runtime is the point of reporting rather than throwing — but setup must
  // still refuse. A unit written with an unproven interpreter reports "installed" and can never start.
  const refusedHome = join(prefix, 'setup-refused-home');
  mkdirSync(refusedHome, { recursive: true });
  const refusedSetup = await run(
    [join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary), 'setup', '--yes', '--accept-managed-runtime-ownership'],
    {
      cwd: prefix,
      timeoutMs: 180_000,
      env: hermeticEnvironment({
        HOME: refusedHome,
        COSYNCING_HOME: join(refusedHome, '.cosyncing'),
        COSYNCING_BUN_BIN: join(overrideDir, 'silent'),
      }),
    },
  );
  check('setup refuses an install whose Bun runtime could not be proven, and installs nothing',
    refusedSetup.exitCode !== 0
      && !existsSync(join(refusedHome, '.cosyncing', 'bin', PRODUCT_IDENTITY.primaryBinary))
      && !existsSync(join(refusedHome, '.config', 'systemd', 'user', 'cosyncing.service')),
    `exit=${refusedSetup.exitCode} ${`${refusedSetup.stdout}${refusedSetup.stderr}`.trim().slice(-200)}`);

  // ---- The decisive lifecycle: JavaScript bundle → setup → service → /cosy → repair → uninstall --------------------
  //
  // Everything above proves one link. This walks the whole chain on the installed package, because the
  // failures this migration can produce — copying Bun instead of the bundle, a unit that omits the
  // interpreter, a sidecar resolved from the runtime — each look fine until the next link needs them.
  //
  // systemd is faked rather than skipped. Skipping would leave the durable path — the one that changed
  // most — untested, and driving the host's real user manager from a test is not an option. The fake
  // shadows `systemctl` on PATH and records what it was asked to do; `XDG_RUNTIME_DIR` and the D-Bus
  // address are pointed at the sandbox as well, so even a lookup that escaped the fake could not reach
  // the host's session.
  if (process.platform === 'linux') {
    const lifecycle = join(root, 'lifecycle');
    const lifecycleHome = join(lifecycle, 'home');
    const stateHome = join(lifecycleHome, '.cosyncing');
    const fakeBin = join(lifecycle, 'bin');
    const systemdState = join(lifecycle, 'systemd-state');
    for (const directory of [lifecycleHome, fakeBin, systemdState, join(lifecycleHome, '.config'), stateHome]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(fakeBin, 'systemctl'), [
      '#!/bin/sh',
      'STATE="$FAKE_SYSTEMD_STATE"',
      'printf "%s\\n" "$*" >> "$STATE/log"',

      '[ "$1" = "--user" ] && shift',
      'case "$1" in',
      '  is-system-running) echo running ;;',
      '  is-enabled) cat "$STATE/enabled" 2>/dev/null || echo not-found ;;',
      '  is-active) cat "$STATE/active" 2>/dev/null || echo inactive ;;',
      '  enable) echo enabled > "$STATE/enabled" ;;',
      '  disable) stop_unit; echo disabled > "$STATE/enabled" ;;',
      '  start|restart) stop_unit; start_unit ;;',
      '  stop) stop_unit ;;',
      '  daemon-reload) : ;;',
      '  *) : ;;',
      'esac',
      'exit 0',
    ].join('\n').replace('case "$1" in', [
      // The unit has to actually RUN. Setup starts the service and health-checks it once before it will
      // commit, so a service manager that only records intent fails a correct install. This reads the same
      // two files systemd would — the unit's ExecStart and its EnvironmentFile — and nothing else, so the
      // argv under test is the argv that was written rather than one this fixture composed.
      'UNIT="$XDG_CONFIG_HOME/systemd/user/cosyncing.service"',
      'start_unit() {',
      '  [ -f "$UNIT" ] || return 0',
      '  ENVFILE=$(sed -n "s/^EnvironmentFile=//p" "$UNIT")',
      '  EXEC=$(sed -n "s/^ExecStart=//p" "$UNIT")',
      '  set -a',
      '  . "$ENVFILE"',
      '  COSYNCING_SERVICE_PROVIDER=systemd',
      '  set +a',
      '  eval "set -- $EXEC"',
      // A new session, so the broker is not swept up when the supervised command that started it exits —
      // and so this fixture, not the process supervisor, is answerable for stopping it.
      '  setsid "$@" >> "$STATE/broker.log" 2>&1 &',
      '  echo $! > "$STATE/pid"',
      '  echo active > "$STATE/active"',
      '}',
      'stop_unit() {',
      '  if [ -f "$STATE/pid" ]; then kill -- "-$(cat "$STATE/pid")" 2>/dev/null; rm -f "$STATE/pid"; fi',
      '  echo inactive > "$STATE/active"',
      '}',
      'case "$1" in',
    ].join('\n')), { mode: 0o755 });
    // Stateful, because setup asks for lingering and then VERIFIES it. A loginctl that always answers "no"
    // makes a correct install fail its own verification and roll back.
    writeFileSync(join(fakeBin, 'loginctl'), [
      '#!/bin/sh',
      'STATE="$FAKE_SYSTEMD_STATE"',
      'printf "loginctl %s\\n" "$*" >> "$STATE/log"',
      'case "$1" in',
      '  enable-linger) echo yes > "$STATE/linger" ;;',
      '  disable-linger) echo no > "$STATE/linger" ;;',
      '  show-user) cat "$STATE/linger" 2>/dev/null || echo no ;;',
      'esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(fakeBin, 'journalctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Configured before setup, so the broker this suite starts cannot collide with a real one on 7734.
    const portLease = await reserveLoopbackFixturePort();
    const lifecyclePort = portLease.port;
    await portLease.release();
    writeFileSync(join(stateHome, 'config.json'), `${JSON.stringify({
      schemaVersion: 2,
      broker: {
        port: lifecyclePort,
        machineLabel: 'javascript-installation-lifecycle',
      },
      update: { channel: 'stable' },
    }, null, 2)}\n`, { mode: 0o600 });

    servicePidFile = join(systemdState, 'pid');
    const lifecycleEnvironment = hermeticEnvironment({
      HOME: lifecycleHome,
      COSYNCING_HOME: stateHome,
      // The fake service manager first, then this suite's own Bun so the package's `#!/usr/bin/env bun`
      // shebang resolves, then the base system. Deliberately not the developer's interactive PATH.
      PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_SYSTEMD_STATE: systemdState,
      XDG_RUNTIME_DIR: join(lifecycle, 'runtime'),
      XDG_CONFIG_HOME: join(lifecycleHome, '.config'),
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/cosyncing-fixture-bus',
      OPENCODE_URL: 'http://127.0.0.1:1',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    });
    mkdirSync(join(lifecycle, 'runtime'), { recursive: true });

    const command = join(prefix, 'bin', PRODUCT_IDENTITY.primaryBinary);
    const setup = await run(
      [command, 'setup', '--yes', '--accept-managed-runtime-ownership'],
      { cwd: prefix, env: lifecycleEnvironment, timeoutMs: 300_000 },
    );
    const installedCopy = join(stateHome, 'bin', PRODUCT_IDENTITY.primaryBinary);
    const packagedApplication = join(installedPackage, PACKAGED_APPLICATION);
    check('setup commits and copies the JavaScript application itself into the state home',
      setup.exitCode === 0
        && existsSync(installedCopy)
        && readFileSync(installedCopy).equals(readFileSync(packagedApplication)),
      `exit=${setup.exitCode} ${`${setup.stdout}${setup.stderr}`.trim().slice(-240)}`);
    if (setup.exitCode !== 0) {
      const diagnostic = join(stateHome, 'logs', 'last-setup-failure.json');
      if (existsSync(diagnostic)) console.error(`SETUP-FAILURE ${readFileSync(diagnostic, 'utf8')}`);
    }

    // The regression that survives every unit test: a bootstrap copy of BUN landing where the application
    // belongs. The bytes above already prove it, and the shebang proves it a second way.
    const copiedHeader = existsSync(installedCopy)
      ? readFileSync(installedCopy).subarray(0, 18).toString('utf8')
      : '';
    check('the copied application is the Bun script, never the Bun executable',
      copiedHeader === '#!/usr/bin/env bun',
      JSON.stringify(copiedHeader));

    const unitPath = join(lifecycleHome, '.config', 'systemd', 'user', 'cosyncing.service');
    const unit = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : '';
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart=')) ?? '';
    const serviceEnvironment = existsSync(join(stateHome, 'service', 'broker.env'))
      ? readFileSync(join(stateHome, 'service', 'broker.env'), 'utf8')
      : '';
    check('the durable unit execs the external Bun and the installed copy, in that order',
      execStart.includes(`"${installedCopy}" "broker"`)
        && /^ExecStart="[^"]+" "/.test(execStart)
        && !execStart.startsWith(`ExecStart="${installedCopy}"`),
      execStart || '<no unit written>');
    check('the service environment carries the packaged web client from the acquisition package',
      serviceEnvironment.includes(`COSYNCING_WEB_DIR="${join(installedPackage, 'bin', sidecar)}"`),
      serviceEnvironment.split('\n').find((line) => line.startsWith('COSYNCING_WEB_DIR=')));

    // The service manager was actually driven, rather than the unit merely written to disk.
    const systemdLog = existsSync(join(systemdState, 'log'))
      ? readFileSync(join(systemdState, 'log'), 'utf8')
      : '';
    check('setup drove the user service manager rather than only writing files',
      systemdLog.includes('daemon-reload') && systemdLog.includes('enable cosyncing.service'),
      systemdLog.trim().split('\n').slice(-3).join(' | '));

    // /cosy/ from the running SERVICE, not from a broker this suite started itself. That distinction is the
    // point: the service exec's the unit's argv, with the unit's restricted PATH and the unit's
    // COSYNCING_WEB_DIR, so a sidecar path that only resolves in an interactive shell fails here.
    let cosyStatus = 0;
    let cosyBody = '';
    try {
      const cosy = await fetch(`http://127.0.0.1:${lifecyclePort}/cosy/`, {
        signal: AbortSignal.timeout(15_000),
      });
      cosyStatus = cosy.status;
      cosyBody = (await cosy.text()).slice(0, 400);
    } catch (error) {
      cosyBody = error instanceof Error ? error.message : String(error);
    }
    check('the durable service serves the packaged /cosy/ client over the configured loopback port',
      cosyStatus === 200 && cosyBody.includes('<base href="/cosy/">'),
      `status=${cosyStatus} ${cosyBody.slice(0, 160)}`);

    // Doctor must agree with the setup that just succeeded. The runtime's directory is on the durable PATH
    // by design, and a doctor that reconstructs its expectation without the runtime reads that directory as
    // "obsolete" — failing every fresh install into a repair loop in which repair finds nothing to change.
    const lifecycleDoctor = await run(
      [command, 'doctor', '--json'],
      { cwd: prefix, env: lifecycleEnvironment, timeoutMs: 120_000 },
    );
    let agentPathVerdict = '<unparseable>';
    try {
      const report = JSON.parse(lifecycleDoctor.stdout) as {
        sections: Array<{ checks: Array<{ id: string; status: string; detailCode?: string }> }>;
      };
      const agentPath = report.sections.flatMap((section) => section.checks)
        .find((candidate) => candidate.id === 'service.agent-executable-path');
      agentPathVerdict = agentPath ? `${agentPath.status}:${agentPath.detailCode}` : '<absent>';
    } catch {
      agentPathVerdict = `<unparseable: ${lifecycleDoctor.stdout.slice(0, 160)}>`;
    }
    check('doctor accepts the durable service PATH of the installation setup just wrote',
      agentPathVerdict === 'pass:service-agent-path-current',
      agentPathVerdict);

    // Repair is the reconciliation an operator runs after the package moves. It must converge without
    // needing a second setup, and without inventing a runtime it could not prove.
    const repair = await run(
      [command, 'repair', '--yes'],
      { cwd: prefix, env: lifecycleEnvironment, timeoutMs: 300_000 },
    );
    check('repair reconciles the installed service without rewriting it into a runtime-less command',
      repair.exitCode === 0
        && readFileSync(unitPath, 'utf8').split('\n')
          .find((line) => line.startsWith('ExecStart=')) === execStart,
      `exit=${repair.exitCode} ${`${repair.stdout}${repair.stderr}`.trim().slice(-200)}`);

    const uninstall = await run(
      [command, 'uninstall', '--yes', '--json'],
      { cwd: prefix, env: lifecycleEnvironment, timeoutMs: 300_000 },
    );
    // What uninstall owns, and — just as load-bearing — what it must not touch. The acquisition package and
    // the operator's Bun were installed by other tools and are theirs to remove.
    let stillServing = true;
    try {
      await fetch(`http://127.0.0.1:${lifecyclePort}/health`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      stillServing = false;
    }
    check('uninstall stops the service it installed rather than leaving the broker running',
      !stillServing && !existsSync(join(systemdState, 'pid')));
    check('uninstall removes the copy and the unit while leaving the acquisition bundle and Bun alone',
      uninstall.exitCode === 0
        && !existsSync(installedCopy)
        && !existsSync(unitPath)
        && existsSync(packagedApplication)
        && existsSync(join(installedPackage, 'bin', sidecar, 'index.html')),
      `exit=${uninstall.exitCode} ${`${uninstall.stdout}${uninstall.stderr}`.trim().slice(-200)}`);
  } else {
    check('the installed-package lifecycle is exercised on the Linux gate host',
      true, `skipped on ${process.platform}; the durable-service lane is systemd`);
  }

} finally {
  stopFixtureService();
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${results.length} JavaScript installation checks failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} JavaScript installation checks`);
