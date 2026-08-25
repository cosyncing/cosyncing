#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveInvocation, type SetupDiagnosisContext } from '@cosyncing/adapter-api';
import {
  diagnosePiNodeRuntime,
  inspectPiRuntimeReadiness,
  PI_DEFAULT_NODE_MINIMUM_VERSION,
  PI_MINIMUM_SUPPORTED_VERSION,
  type PiRuntimeHost,
} from '../../../adapters/pi/src/index.ts';
import { diagnosePiSetup } from '../../../adapters/pi/src/diagnostics.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { agentSummaries, doctorBlockers } from '../../src/installation/setup.ts';
import { agentPreflightLines } from '../../src/installation/setup-presenter.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-pi-runtime-'));
const makeExecutable = (path: string, content: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
};

function makeNode(version: string, name: string): string {
  return makeExecutable(join(root, name, 'node'), `#!/bin/sh\nprintf '%s\\n' 'v${version}'\n`);
}

function makePiPackage(name: string, shebang = '#!/usr/bin/env node'): {
  executable: string;
  binDir: string;
} {
  const packageRoot = join(root, name, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const executable = makeExecutable(join(packageRoot, 'dist', 'cli.js'), `${shebang}\n// fixture\n`);
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: '0.84.0',
    engines: { node: `>=${PI_DEFAULT_NODE_MINIMUM_VERSION}` },
  }));
  const binDir = join(root, name, 'bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(executable, join(binDir, 'pi'));
  return { executable, binDir };
}

try {
  const oldNode = makeNode('22.14.0', 'node-old');
  const goodNode = makeNode('22.19.0', 'node-good');
  const newerNode = makeNode('24.1.0', 'node-newer');
  const pathPi = makePiPackage('path-pi');

  const old = inspectPiRuntimeReadiness({
    PATH: `${dirname(oldNode)}:${pathPi.binDir}`,
  });
  assert.equal(old.ready, false);
  assert.equal(old.detailCode, 'pi-node-version-below-minimum');
  assert.equal(old.nodeVersion, '22.14.0');
  assert.equal(old.requiredNodeVersion, '22.19.0');
  assert.match(old.message, /effective interpreter is Node 22\.14\.0/);

  const floor = inspectPiRuntimeReadiness({
    PATH: `${dirname(goodNode)}:${pathPi.binDir}`,
  });
  assert.equal(floor.ready, true);
  assert.equal(floor.nodeVersion, '22.19.0');
  assert.equal(floor.executable, pathPi.executable, 'PATH symlink must resolve to the package launcher');

  const newer = inspectPiRuntimeReadiness({
    PATH: `${dirname(newerNode)}:${pathPi.binDir}`,
  });
  assert.equal(newer.ready, true);

  const splitEnvPi = makePiPackage('split-env-pi', '#!/usr/bin/env -S node --no-warnings');
  assert.equal(inspectPiRuntimeReadiness({
    PATH: `${dirname(goodNode)}:${splitEnvPi.binDir}`,
  }).ready, true, 'env -S launchers must resolve Node through the effective PATH');

  const override = makeExecutable(join(root, 'override', 'pi-custom'), `#!${goodNode}\n// custom fixture\n`);
  const explicit = inspectPiRuntimeReadiness({
    PATH: '/usr/bin:/bin',
    COSYNCING_PI_BIN: override,
  });
  assert.equal(explicit.ready, true);
  assert.equal(explicit.nodeExecutable, goodNode);
  assert.equal(explicit.requiredNodeVersion, PI_DEFAULT_NODE_MINIMUM_VERSION);

  const nonExecutable = join(root, 'native', 'README.md');
  mkdirSync(dirname(nonExecutable), { recursive: true });
  writeFileSync(nonExecutable, '# not an executable\n');
  const arbitraryFile = inspectPiRuntimeReadiness({ COSYNCING_PI_BIN: nonExecutable, PATH: '' });
  assert.equal(arbitraryFile.ready, false, 'an arbitrary non-executable file is never a usable Pi binary');
  assert.equal(arbitraryFile.detailCode, 'pi-binary-missing');

  const wrongNative = makeExecutable(join(root, 'native-wrong', 'pi'),
    '#!/usr/bin/env bun\nconsole.log("unrelated-tool 0.84.0");\n');
  const wrongIdentity = inspectPiRuntimeReadiness({ COSYNCING_PI_BIN: wrongNative, PATH: process.env.PATH });
  assert.equal(wrongIdentity.ready, false, 'an executable with an unrelated version response is not Pi');
  assert.equal(wrongIdentity.detailCode, 'pi-native-identity-unverified');

  const nativeOverride = makeExecutable(join(root, 'native', 'pi'),
    '#!/usr/bin/env bun\nconsole.log("Pi 0.84.0");\n');
  const native = inspectPiRuntimeReadiness({ COSYNCING_PI_BIN: nativeOverride, PATH: process.env.PATH });
  assert.equal(native.ready, true, 'a native custom Pi executable remains available after bounded identity proof');
  assert.equal(native.detailCode, 'pi-native-runtime-ready');
  assert.equal(native.packageVersion, '0.84.0');

  const doctorContext = createSetupDiagnosisContext({
    homeDir: root,
    platform: 'darwin',
    arch: 'arm64',
    env: {
      HOME: root,
      PATH: `${dirname(oldNode)}:${pathPi.binDir}`,
      COSYNCING_PI_BIN: join(pathPi.binDir, 'pi'),
      PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    },
  });
  const diagnosis = await diagnosePiSetup(doctorContext, {
    inspectBridge: (agentDir) => ({
      status: 'missing',
      path: join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts'),
      requiresConfirmation: false,
    }),
  });
  const nodeCheck = diagnosis.checks.find((check) => check.id === 'pi.node-runtime');
  assert.equal(nodeCheck?.status, 'fail');
  assert.equal(nodeCheck?.detailCode, 'node-runtime-below-minimum');
  assert.match(nodeCheck?.summary ?? '', /Node 22\.14\.0/);
  assert.match(nodeCheck?.remediation?.message ?? '', /22\.19\.0/);

  const doctor = {
    minimumVersions: [{ agent: 'pi', displayName: 'Pi', version: '0.78.1' }],
    sections: [{ id: 'agents', title: 'Agents', checks: diagnosis.checks }],
  } as any;
  const blockers = doctorBlockers(doctor);
  assert.deepEqual(
    blockers,
    [],
    'an unusable optional Pi runtime must be diagnosed without blocking cosyncing setup',
  );
  const setupPi = agentSummaries(doctor).find((agent) => agent.id === 'pi');
  assert.equal(setupPi?.state, 'runtime-unavailable');
  assert.equal(setupPi?.runtimeUnavailable?.installedVersion, '22.14.0');
  assert.equal(setupPi?.runtimeUnavailable?.minimumVersion, '22.19.0');
  const preflight = agentPreflightLines(setupPi ? [setupPi] : []);
  assert.match(preflight, /Runtime unavailable: effective Node 22\.14\.0/);
  assert.match(preflight, /Node 22\.19\.0 or newer is required/);


  // -------------------------------------------------------------------------
  // Windows npm-shim fixtures.
  //
  // Windows resolves `pi` to a `.cmd` shim: no shebang, no symlink into the
  // package, and the package installed beside the shim under the npm prefix.
  // None of that can be built from real files on a POSIX runner, so the host is
  // described instead. Reading a described host is the point rather than a
  // concession: `readLauncherPrefix` throws for every batch launcher below,
  // because the contract is that readiness never reads a `.cmd` file's
  // contents.
  // -------------------------------------------------------------------------

  const NPM_PREFIX = 'C:\\Program Files\\nodejs';
  const ROAMING_PREFIX = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const PI_PACKAGE = '@earendil-works/pi-coding-agent';
  const LEGACY_PI_PACKAGE = '@mariozechner/pi-coding-agent';
  const SHIM = `${NPM_PREFIX}\\pi.CMD`;
  const NODE_EXE = `${NPM_PREFIX}\\node.exe`;

  const packageJsonPath = (name: string, prefix = NPM_PREFIX): string =>
    `${prefix}\\node_modules\\${name.replace('/', '\\')}\\package.json`;

  const piPackageJson = (
    name: string,
    version: unknown = '0.84.2',
    nodeEngine: string | undefined = `>=${PI_DEFAULT_NODE_MINIMUM_VERSION}`,
  ): string => JSON.stringify({
    name,
    version,
    ...(nodeEngine ? { engines: { node: nodeEngine } } : {}),
  });

  interface DescribedWindowsHost {
    /** Paths that exist as executable files. */
    executables?: readonly string[];
    /** Path -> text content, for bounded metadata reads. */
    files?: Record<string, string>;
    /** Launcher head, for genuinely native launchers only. */
    prefixes?: Record<string, string>;
    /** Executable -> combined `--version` output. */
    versions?: Record<string, string>;
    /** Executables whose bounded version probe never answers in time. */
    versionTimeouts?: readonly string[];
  }

  interface ProbeRecord {
    kind: 'native' | 'batch';
    path: string;
    args: readonly string[];
    prefixArgs: readonly string[];
    spawned: string;
  }

  interface DescribedWindowsProbe {
    host: Partial<PiRuntimeHost>;
    probed: ProbeRecord[];
    read: string[];
  }

  function describeWindowsHost(fixture: DescribedWindowsHost): DescribedWindowsProbe {
    const fold = (path: string): string => path.toLowerCase();
    const executables = new Set((fixture.executables ?? []).map(fold));
    const files = new Map(Object.entries(fixture.files ?? {}).map(([key, value]) => [fold(key), value]));
    const prefixes = new Map(Object.entries(fixture.prefixes ?? {}).map(([key, value]) => [fold(key), value]));
    const versions = new Map(Object.entries(fixture.versions ?? {}).map(([key, value]) => [fold(key), value]));
    const versionTimeouts = new Set((fixture.versionTimeouts ?? []).map(fold));
    // NTFS keeps the casing it was created with and matches without it, which is exactly what
    // `realpathSync` reports back on a real host.
    const realCase = new Map<string, string>();
    for (const path of [...(fixture.executables ?? []), ...Object.keys(fixture.files ?? {})]) {
      realCase.set(fold(path), path);
    }
    const probed: ProbeRecord[] = [];
    const read: string[] = [];
    return {
      probed,
      read,
      host: {
        platform: 'win32',
        isExecutableFile: (path) => executables.has(fold(path)),
        canonicalize: (path) => realCase.get(fold(path)) ?? path,
        readLauncherPrefix: (path) => {
          const head = prefixes.get(fold(path));
          if (head === undefined) {
            throw new Error(`readiness must not read this launcher's contents: ${path}`);
          }
          return head;
        },
        readBoundedText: (path, maxBytes) => {
          read.push(path);
          const text = files.get(fold(path));
          if (text === undefined) return { ok: false, reason: 'missing' };
          if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, reason: 'too-large' };
          return { ok: true, text };
        },
        probeVersionOutput: (invocation) => {
          probed.push({
            kind: invocation.kind,
            path: invocation.originalPath,
            args: ['--version'],
            prefixArgs: invocation.prefixArgs,
            spawned: invocation.kind === 'batch' ? invocation.cmdExe : invocation.executable,
          });
          if (versionTimeouts.has(fold(invocation.originalPath))) return { timedOut: true };
          const output = versions.get(fold(invocation.originalPath));
          return output === undefined ? {} : { output };
        },
      },
    };
  }

  // Real Windows env casing: `Path`/`PathExt`, not `PATH`/`PATHEXT`.
  const windowsEnv = (pathValue: string): NodeJS.ProcessEnv => ({
    Path: pathValue,
    PathExt: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  // Lower-cased on purpose: only a case-insensitive resolution finds `pi.CMD` from here.
  const PREFIX_ON_PATH = windowsEnv(`C:\\Windows\\System32;${NPM_PREFIX.toLowerCase()}`);

  const supportedShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
  });
  const shimReady = inspectPiRuntimeReadiness(PREFIX_ON_PATH, supportedShim.host);
  assert.equal(shimReady.ready, true, 'a Windows npm shim is a Node launcher, not a native executable');
  assert.equal(shimReady.detailCode, 'pi-node-runtime-supported');
  assert.equal(shimReady.executable, SHIM, 'case-insensitive PATH/PATHEXT resolution keeps the on-disk casing');
  assert.equal(shimReady.nodeExecutable, NODE_EXE);
  assert.equal(shimReady.nodeVersion, '24.19.0');
  assert.equal(shimReady.requiredNodeVersion, PI_DEFAULT_NODE_MINIMUM_VERSION);
  assert.equal(shimReady.packageVersion, '0.84.2');
  assert.deepEqual(
    supportedShim.probed.map((probe) => probe.path),
    [SHIM, NODE_EXE],
    'the resolved shim is asked what it is, and only then is the interpreter probed',
  );
  const shimProbe = supportedShim.probed[0]!;
  assert.equal(shimProbe.kind, 'batch', 'the shim is probed as the batch launcher it was resolved as');
  assert.deepEqual(shimProbe.args, ['--version'], 'the launcher probe is bounded to --version');
  assert.deepEqual(
    shimProbe.prefixArgs,
    ['/d', '/s', '/v:off', '/c'],
    'the launcher probe travels the shared boundary\'s fixed cmd.exe argv, not a composed string',
  );
  assert.match(shimProbe.spawned, /cmd\.exe$/i, 'cmd.exe is the process spawned for a batch launcher');
  assert.deepEqual(
    supportedShim.read,
    [packageJsonPath(PI_PACKAGE), packageJsonPath(LEGACY_PI_PACKAGE)],
    'both supported package identities are checked, so a second install cannot pass unnoticed',
  );
  assert.ok(
    !supportedShim.read.some((path) => path.toLowerCase() === SHIM.toLowerCase()),
    'the package contract is read from the documented npm layout, never from the batch file',
  );

  const shimInvocation = resolveInvocation(SHIM, {
    env: PREFIX_ON_PATH,
    platform: 'win32',
    isExecutableFile: (path) => path.toLowerCase() === SHIM.toLowerCase(),
    canonicalize: (path) => path,
  });
  assert.equal(shimInvocation?.kind, 'batch', 'the shared resolver is what classifies the shim');
  assert.deepEqual(
    shimInvocation?.kind === 'batch' ? shimInvocation.prefixArgs : undefined,
    ['/d', '/s', '/v:off', '/c'],
    'batch launch stays fixed-argv through cmd.exe',
  );

  const legacyShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(LEGACY_PI_PACKAGE)]: piPackageJson(LEGACY_PI_PACKAGE, '0.80.0') },
    versions: { [SHIM]: '0.80.0', [NODE_EXE]: 'v24.19.0' },
  });
  const legacyReady = inspectPiRuntimeReadiness(PREFIX_ON_PATH, legacyShim.host);
  assert.equal(legacyReady.ready, true, 'the legacy Pi package name is equally supported');
  assert.equal(legacyReady.packageVersion, '0.80.0');

  const ambiguousShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: {
      [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE),
      [packageJsonPath(LEGACY_PI_PACKAGE)]: piPackageJson(LEGACY_PI_PACKAGE, '0.80.0'),
    },
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
  });
  const ambiguous = inspectPiRuntimeReadiness(PREFIX_ON_PATH, ambiguousShim.host);
  assert.equal(ambiguous.ready, false, 'two installed Pi packages leave no single runtime contract');
  assert.equal(ambiguous.detailCode, 'pi-package-identity-ambiguous');

  const noPackage = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
  });
  const missingPackage = inspectPiRuntimeReadiness(PREFIX_ON_PATH, noPackage.host);
  assert.equal(missingPackage.ready, false, 'a shim with no package beside it proves no Pi identity');
  assert.equal(missingPackage.detailCode, 'pi-package-identity-missing');
  assert.equal(missingPackage.executable, SHIM);

  // A busy machine and a broken installation are DIFFERENT facts, and only one of them is fixed by
  // reinstalling Pi. A native Phase 6 lane starting a broker beside this call had session creation
  // refused with the reinstall message on a perfectly good Pi; the launcher had simply not answered
  // within the probe's three seconds.
  const busyShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.84.2') },
    versions: { [NODE_EXE]: 'v24.19.0' },
    versionTimeouts: [SHIM],
  });
  const busy = inspectPiRuntimeReadiness(PREFIX_ON_PATH, busyShim.host);
  assert.equal(busy.ready, false, 'an unanswered version probe cannot qualify a launcher');
  assert.equal(busy.detailCode, 'pi-version-probe-timed-out',
    'a probe that ran out of time is not a launcher that answered wrongly');
  assert.doesNotMatch(String(busy.message), /reinstall/i,
    'a busy host must not be told to reinstall a working Pi');
  assert.equal(busy.packageVersion, '0.84.2',
    'the package was identified before the probe timed out and stays on the evidence');

  // A package beside the shim is evidence about the package, not about the shim. These three say
  // so: each has a perfectly good Pi installation in the npm prefix, and none of them may pass.
  const replacedShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.84.2') },
    versions: { [SHIM]: 'other-tool 1.2.3', [NODE_EXE]: 'v24.19.0' },
  });
  const replaced = inspectPiRuntimeReadiness(PREFIX_ON_PATH, replacedShim.host);
  assert.equal(replaced.ready, false,
    'a shim replaced beside a legitimate Pi installation must not pass on its neighbour\'s evidence');
  assert.equal(replaced.detailCode, 'pi-batch-identity-mismatch');
  assert.match(replaced.message, /1\.2\.3/);
  assert.match(replaced.message, /0\.84\.2/);

  const silentShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [NODE_EXE]: 'v24.19.0' },
  });
  const silent = inspectPiRuntimeReadiness(PREFIX_ON_PATH, silentShim.host);
  assert.equal(silent.ready, false, 'a launcher that answers nothing has proven nothing');
  assert.equal(silent.detailCode, 'pi-batch-version-unverified');

  const noisyShim = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [SHIM]: 'usage: pi [options]', [NODE_EXE]: 'v24.19.0' },
  });
  assert.equal(
    inspectPiRuntimeReadiness(PREFIX_ON_PATH, noisyShim.host).detailCode,
    'pi-batch-version-unverified',
    'an unparsable launcher response is not an identity',
  );

  const oldPi = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.70.0') },
    versions: { [SHIM]: '0.70.0', [NODE_EXE]: 'v24.19.0' },
  });
  const belowPiFloor = inspectPiRuntimeReadiness(PREFIX_ON_PATH, oldPi.host);
  assert.equal(belowPiFloor.ready, false, 'the adapter floor applies to a batch launcher too');
  assert.equal(belowPiFloor.detailCode, 'pi-batch-version-below-minimum');
  assert.equal(belowPiFloor.packageVersion, '0.70.0');
  assert.match(belowPiFloor.message, new RegExp(PI_MINIMUM_SUPPORTED_VERSION.replace(/\./g, '\\.')));

  for (const [label, text] of [
    ['a foreign package occupying the Pi path', piPackageJson('unrelated-tool')],
    ['malformed package metadata', '{"name": "@earendil-works/pi-coding-agent"'],
    ['a non-object package document', '"@earendil-works/pi-coding-agent"'],
    ['package metadata without a string version', piPackageJson(PI_PACKAGE, 84)],
    ['oversized package metadata', JSON.stringify({
      name: PI_PACKAGE,
      version: '0.84.2',
      description: 'x'.repeat(300 * 1024),
    })],
  ] as const) {
    const invalidHost = describeWindowsHost({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: text },
      versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
    });
    const invalid = inspectPiRuntimeReadiness(PREFIX_ON_PATH, invalidHost.host);
    assert.equal(invalid.ready, false, `${label} must fail closed`);
    assert.equal(invalid.detailCode, 'pi-package-metadata-invalid', label);
    assert.equal(invalid.requiredNodeVersion, undefined,
      `${label} must not fall back to the default Node floor`);
  }

  const noEngineHost = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.84.2', undefined) },
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
  });
  const noEngine = inspectPiRuntimeReadiness(PREFIX_ON_PATH, noEngineHost.host);
  assert.equal(noEngine.ready, true);
  assert.equal(noEngine.requiredNodeVersion, PI_DEFAULT_NODE_MINIMUM_VERSION,
    'a package without an engines floor keeps the conservative default');

  const belowFloorHost = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.84.2', '>=22.19.0') },
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v20.11.0' },
  });
  const belowFloor = inspectPiRuntimeReadiness(PREFIX_ON_PATH, belowFloorHost.host);
  assert.equal(belowFloor.ready, false);
  assert.equal(belowFloor.detailCode, 'pi-node-version-below-minimum');
  assert.equal(belowFloor.nodeVersion, '20.11.0');
  assert.equal(belowFloor.requiredNodeVersion, '22.19.0', "the package's own floor is what is enforced");

  const noNodeHost = describeWindowsHost({
    executables: [SHIM],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [SHIM]: '0.84.2' },
  });
  const noNode = inspectPiRuntimeReadiness(PREFIX_ON_PATH, noNodeHost.host);
  assert.equal(noNode.ready, false);
  assert.equal(noNode.detailCode, 'pi-node-interpreter-missing');
  assert.equal(noNode.packageVersion, '0.84.2', 'the package is still identified without an interpreter');

  const roamingShim = `${ROAMING_PREFIX}\\pi.cmd`;
  const roamingHost = describeWindowsHost({
    executables: [roamingShim, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE, ROAMING_PREFIX)]: piPackageJson(PI_PACKAGE) },
    versions: { [roamingShim]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
  });
  const roaming = inspectPiRuntimeReadiness(
    windowsEnv(`${ROAMING_PREFIX};${NPM_PREFIX}`),
    roamingHost.host,
  );
  assert.equal(roaming.ready, true, 'a custom npm prefix without node.exe beside it falls back to PATH Node');
  assert.equal(roaming.executable, roamingShim);
  assert.equal(roaming.nodeExecutable, NODE_EXE);

  const shadowedNode = 'C:\\Windows\\System32\\node.exe';
  const besideWinsHost = describeWindowsHost({
    executables: [SHIM, NODE_EXE, shadowedNode],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0', [shadowedNode]: 'v18.20.0' },
  });
  const besideWins = inspectPiRuntimeReadiness(
    windowsEnv(`C:\\Windows\\System32;${NPM_PREFIX}`),
    besideWinsHost.host,
  );
  assert.equal(besideWins.nodeExecutable, NODE_EXE,
    "npm's shim runs the Node beside it, so an older Node earlier on PATH must not be reported");
  assert.equal(besideWins.nodeVersion, '24.19.0');

  const nativeWindowsPi = 'C:\\tools\\pi.exe';
  const nativeWindowsHost = describeWindowsHost({
    executables: [nativeWindowsPi],
    prefixes: { [nativeWindowsPi]: 'MZ\u0090\u0000\u0003' },
    versions: { [nativeWindowsPi]: 'pi 0.84.2' },
  });
  const nativeWindows = inspectPiRuntimeReadiness(
    { ...windowsEnv('C:\\Windows\\System32'), COSYNCING_PI_BIN: nativeWindowsPi },
    nativeWindowsHost.host,
  );
  assert.equal(nativeWindows.ready, true, 'a genuinely native Windows executable keeps the native branch');
  assert.equal(nativeWindows.detailCode, 'pi-native-runtime-ready');
  assert.equal(nativeWindows.packageVersion, '0.84.2');

  const bareSemverHost = describeWindowsHost({
    executables: [nativeWindowsPi],
    prefixes: { [nativeWindowsPi]: 'MZ\u0090\u0000\u0003' },
    versions: { [nativeWindowsPi]: '0.84.2' },
  });
  const bareSemver = inspectPiRuntimeReadiness(
    { ...windowsEnv('C:\\Windows\\System32'), COSYNCING_PI_BIN: nativeWindowsPi },
    bareSemverHost.host,
  );
  assert.equal(bareSemver.ready, false,
    'native identity is not weakened just because the npm shim path no longer needs it');
  assert.equal(bareSemver.detailCode, 'pi-native-identity-unverified');

  // The whole batch branch is gated on the resolver's kind, which only win32 produces. A POSIX host
  // that happens to hold a `.cmd`-named launcher keeps the shebang branch unchanged.
  const posixDotCmd = makeExecutable(join(root, 'posix-cmd', 'pi.cmd'), '#!/usr/bin/env node\n// fixture\n');
  const posixCmd = inspectPiRuntimeReadiness({
    PATH: `${dirname(goodNode)}:${dirname(posixDotCmd)}`,
    COSYNCING_PI_BIN: posixDotCmd,
  });
  assert.equal(posixCmd.ready, true, 'a .cmd extension is meaningless off Windows');
  assert.equal(posixCmd.detailCode, 'pi-node-runtime-supported');
  assert.equal(posixCmd.nodeExecutable, goodNode);
  assert.equal(posixCmd.requiredNodeVersion, PI_DEFAULT_NODE_MINIMUM_VERSION);

  // Doctor must reach the same verdict from the same layout; it sees only a resolved path.
  const doctorProbeAttempts: string[] = [];
  const windowsDoctorContext = (fixture: DescribedWindowsHost): SetupDiagnosisContext => {
    const fold = (path: string): string => path.toLowerCase();
    const executables = new Set((fixture.executables ?? []).map(fold));
    const files = new Map(Object.entries(fixture.files ?? {}).map(([key, value]) => [fold(key), value]));
    const versions = new Map(Object.entries(fixture.versions ?? {}).map(([key, value]) => [fold(key), value]));
    const versionTimeouts = new Set((fixture.versionTimeouts ?? []).map(fold));
    const env = windowsEnv(`C:\\Windows\\System32;${NPM_PREFIX}`);
    return {
      effects: 'forbidden',
      platform: 'win32',
      arch: 'x64',
      env,
      homeDir: 'C:\\Users\\dev',
      displayPath: (path: string) => path,
      resolveExecutable: (command: string) => resolveInvocation(command, {
        env,
        platform: 'win32',
        isExecutableFile: (path) => executables.has(fold(path)),
        canonicalize: (path) => path,
      })?.originalPath,
      readText: (path: string, maxBytes = 256 * 1024) => {
        const text = files.get(fold(path));
        if (text === undefined) return { ok: false, reason: 'missing' } as const;
        if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, reason: 'too-large' } as const;
        return { ok: true, text } as const;
      },
      runReadOnly: async (executable: string) => {
        doctorProbeAttempts.push(executable);
        if (versionTimeouts.has(fold(executable))) {
          return { status: 'timeout' as const, stdout: '', stderr: '' };
        }
        return { status: 'ok' as const, stdout: versions.get(fold(executable)) ?? '', stderr: '' };
      },
    } as unknown as SetupDiagnosisContext;
  };

  const doctorReady = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
      versions: { [SHIM]: '0.84.2', [NODE_EXE]: 'v24.19.0' },
    }),
    SHIM,
  );
  assert.equal(doctorReady.status, 'pass', 'doctor classifies the shim from the resolved path, not its bytes');
  assert.equal(doctorReady.detailCode, 'node-runtime-supported');
  assert.equal(doctorReady.evidence?.installedVersion, '24.19.0');
  assert.equal(doctorReady.evidence?.minimumVersion, PI_DEFAULT_NODE_MINIMUM_VERSION);

  const doctorNoPackage = await diagnosePiNodeRuntime(
    windowsDoctorContext({ executables: [SHIM, NODE_EXE], versions: { [NODE_EXE]: 'v24.19.0' } }),
    SHIM,
  );
  assert.equal(doctorNoPackage.status, 'fail');
  assert.equal(doctorNoPackage.detailCode, 'node-runtime-package-missing');

  const doctorReplacedShim = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.84.2') },
      versions: { [SHIM]: 'other-tool 1.2.3', [NODE_EXE]: 'v24.19.0' },
    }),
    SHIM,
  );
  assert.equal(doctorReplacedShim.status, 'fail',
    'doctor closes the same boundary readiness does, from the same resolved path');
  assert.equal(doctorReplacedShim.detailCode, 'node-runtime-launcher-package-mismatch');

  const doctorOldPi = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE, '0.70.0') },
      versions: { [SHIM]: '0.70.0', [NODE_EXE]: 'v24.19.0' },
    }),
    SHIM,
  );
  assert.equal(doctorOldPi.status, 'fail');
  assert.equal(doctorOldPi.detailCode, 'node-runtime-launcher-below-minimum');

  /**
   * A busy machine is not a broken installation, and that has to hold on EVERY branch that asks a
   * version question — readiness and doctor, launcher and interpreter. Diagnosing a timeout as a
   * broken install sends an operator to reinstall software that works.
   */
  const busyNodeReadiness = describeWindowsHost({
    executables: [SHIM, NODE_EXE],
    files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
    versions: { [SHIM]: '0.84.2' },
    versionTimeouts: [NODE_EXE],
  });
  const busyNode = inspectPiRuntimeReadiness(PREFIX_ON_PATH, busyNodeReadiness.host);
  assert.equal(busyNode.ready, false, 'an unanswered interpreter probe cannot qualify Node');
  assert.equal(busyNode.detailCode, 'pi-version-probe-timed-out',
    'the effective Node probe classifies a timeout exactly as the launcher probe does');
  assert.doesNotMatch(String(busyNode.message), /repair node/i,
    'a busy host must not be told to repair a working Node');

  doctorProbeAttempts.length = 0;
  const doctorBusyLauncher = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
      versions: { [NODE_EXE]: 'v24.19.0' },
      versionTimeouts: [SHIM],
    }),
    SHIM,
  );
  assert.equal(doctorBusyLauncher.status, 'fail');
  assert.equal(doctorBusyLauncher.detailCode, 'node-runtime-probe-timed-out',
    'doctor tells a busy launcher apart from one that answered wrongly');
  assert.doesNotMatch(String(doctorBusyLauncher.remediation?.message), /reinstall/i);
  assert.equal(doctorProbeAttempts.filter((path) => path === SHIM).length, 2,
    'a timed-out doctor probe is retried exactly once');

  doctorProbeAttempts.length = 0;
  const doctorBusyNode = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [SHIM, NODE_EXE],
      files: { [packageJsonPath(PI_PACKAGE)]: piPackageJson(PI_PACKAGE) },
      versions: { [SHIM]: '0.84.2' },
      versionTimeouts: [NODE_EXE],
    }),
    SHIM,
  );
  assert.equal(doctorBusyNode.status, 'fail');
  assert.equal(doctorBusyNode.detailCode, 'node-runtime-probe-timed-out',
    'the interpreter branch classifies a timeout too');
  assert.equal(doctorProbeAttempts.filter((path) => path === NODE_EXE).length, 2);

  // The native branch asks the same question of a compiled executable, and must answer it the same
  // way: a probe that ran out of time is not an unrecognizable Pi.
  const doctorBusyNative = await diagnosePiNodeRuntime(
    windowsDoctorContext({
      executables: [nativeWindowsPi],
      files: { [nativeWindowsPi]: 'MZ\u0090\u0000\u0003 fixture' },
      versionTimeouts: [nativeWindowsPi],
    }),
    nativeWindowsPi,
  );
  assert.equal(doctorBusyNative.status, 'fail');
  assert.equal(doctorBusyNative.detailCode, 'node-runtime-probe-timed-out',
    'the native doctor branch does not report a busy host as an unverifiable identity');

  console.log(
    'PASS: Pi readiness qualifies the effective Node launcher on POSIX shebangs and Windows npm shims,'
    + ' and remains setup-optional',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
