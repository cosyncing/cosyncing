#!/usr/bin/env bun
/**
 * omp runtime readiness: Bun-flavored gate. Fake bun shims + a fake @oh-my-pi/pi-coding-agent
 * package on POSIX, plus described-Windows launcher fixtures. No broker imports — the adapter
 * package is self-contained (the doctor-context half of the pi readiness test lives in the broker
 * suite; the omp doctor path is exercised through diagnoseOmpSetup's own fixture-free unit surface).
 */
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
import {
  inspectOmpRuntimeReadiness,
  OMP_DEFAULT_BUN_MINIMUM_VERSION,
  OMP_MINIMUM_SUPPORTED_VERSION,
  type OmpRuntimeHost,
} from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-omp-runtime-'));
const makeExecutable = (path: string, content: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
};

function makeBun(version: string, name: string): string {
  return makeExecutable(join(root, name, 'bun'), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
}

function makeOmpPackage(name: string, opts: { version?: string; bunEngine?: string; shebang?: string } = {}): {
  executable: string;
  binDir: string;
} {
  const packageRoot = join(root, name, 'lib', 'node_modules', '@oh-my-pi', 'pi-coding-agent');
  const executable = makeExecutable(join(packageRoot, 'dist', 'cli.js'), `${opts.shebang ?? '#!/usr/bin/env bun'}\n// fixture\n`);
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@oh-my-pi/pi-coding-agent',
    version: opts.version ?? '17.4.2',
    engines: { bun: opts.bunEngine ?? `>=${OMP_DEFAULT_BUN_MINIMUM_VERSION}` },
  }));
  const binDir = join(root, name, 'bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(executable, join(binDir, 'omp'));
  return { executable, binDir };
}

try {
  const oldBun = makeBun('1.3.8', 'bun-old');
  const floorBun = makeBun('1.3.14', 'bun-floor');
  const newerBun = makeBun('1.4.0', 'bun-newer');
  const pathOmp = makeOmpPackage('path-omp');

  const old = inspectOmpRuntimeReadiness({
    PATH: `${dirname(oldBun)}:${pathOmp.binDir}`,
  });
  assert.equal(old.ready, false);
  assert.equal(old.detailCode, 'omp-bun-version-below-minimum');
  assert.equal(old.bunVersion, '1.3.8');
  assert.equal(old.requiredBunVersion, OMP_DEFAULT_BUN_MINIMUM_VERSION);
  assert.match(old.message, /effective interpreter is Bun 1\.3\.8/);

  const floor = inspectOmpRuntimeReadiness({
    PATH: `${dirname(floorBun)}:${pathOmp.binDir}`,
  });
  assert.equal(floor.ready, true);
  assert.equal(floor.detailCode, 'omp-bun-runtime-supported');
  assert.equal(floor.bunVersion, '1.3.14');
  assert.equal(floor.executable, pathOmp.executable, 'PATH symlink must resolve to the package launcher');
  assert.equal(floor.packageVersion, '17.4.2');

  const newer = inspectOmpRuntimeReadiness({
    PATH: `${dirname(newerBun)}:${pathOmp.binDir}`,
  });
  assert.equal(newer.ready, true);

  const oldOmp = makeOmpPackage('old-version-omp', { version: '17.4.1' });
  const oldOmpResult = inspectOmpRuntimeReadiness({
    PATH: `${dirname(newerBun)}:${oldOmp.binDir}`,
  });
  assert.equal(oldOmpResult.ready, false,
    'a POSIX Bun launcher must not pass on Bun compatibility when the omp package is below floor');
  assert.equal(oldOmpResult.detailCode, 'omp-package-version-below-minimum');
  assert.equal(oldOmpResult.packageVersion, '17.4.1');
  assert.match(oldOmpResult.message, new RegExp(OMP_MINIMUM_SUPPORTED_VERSION.replaceAll('.', '\\.')));

  // The installed package's own engines.bun RAISES the floor above the built-in default.
  const strictEngine = makeOmpPackage('strict-engine-omp', { bunEngine: '>=1.4.0' });
  const strict = inspectOmpRuntimeReadiness({
    PATH: `${dirname(floorBun)}:${strictEngine.binDir}`,
  });
  assert.equal(strict.ready, false, 'the package engines.bun floor governs over the built-in default');
  assert.equal(strict.requiredBunVersion, '1.4.0');
  const strictOk = inspectOmpRuntimeReadiness({
    PATH: `${dirname(newerBun)}:${strictEngine.binDir}`,
  });
  assert.equal(strictOk.ready, true);

  // COSYNCING_OMP_BIN with a DIRECT bun shebang binds the interpreter to that exact bun.
  const override = makeExecutable(join(root, 'override', 'omp-custom'), `#!${newerBun}\n// custom fixture\n`);
  const explicit = inspectOmpRuntimeReadiness({
    PATH: '/usr/bin:/bin',
    COSYNCING_OMP_BIN: override,
  }, {
    probeVersionOutput: (invocation) => ({
      output: invocation.originalPath === override ? '17.4.2' : '1.4.0',
    }),
  });
  assert.equal(explicit.ready, true);
  assert.equal(explicit.bunExecutable, newerBun);
  assert.equal(explicit.requiredBunVersion, OMP_DEFAULT_BUN_MINIMUM_VERSION);
  assert.equal(explicit.packageVersion, '17.4.2');

  const unverifiedOverride = inspectOmpRuntimeReadiness({
    PATH: '/usr/bin:/bin',
    COSYNCING_OMP_BIN: override,
  }, {
    probeVersionOutput: (invocation) => ({
      output: invocation.originalPath === override ? 'unrelated Bun tool' : '1.4.0',
    }),
  });
  assert.equal(unverifiedOverride.ready, false,
    'a package-less POSIX Bun launcher must prove it is omp before Bun qualification');
  assert.equal(unverifiedOverride.detailCode, 'omp-posix-identity-unverified');

  const missing = inspectOmpRuntimeReadiness({ PATH: join(root, 'empty') });
  assert.equal(missing.ready, false);
  assert.equal(missing.detailCode, 'omp-binary-missing');

  // A non-Bun shebang is not a supported omp launcher.
  const nodeShebang = makeExecutable(join(root, 'node-shebang', 'omp'), '#!/usr/bin/env node\n// fixture\n');
  const unresolved = inspectOmpRuntimeReadiness({ COSYNCING_OMP_BIN: nodeShebang, PATH: process.env.PATH });
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.detailCode, 'omp-bun-interpreter-unresolved');

  // Native (no-shebang) launchers: the identity comes from the bounded --version answer alone.
  // omp 17.4.2 prints a BARE version (`17.4.2\n`) — no name token — so that exact shape must pass.
  const nativeBin = makeExecutable(join(root, 'native', 'omp'), 'native fixture — no shebang\n');
  const nativeProbe = (output: string | undefined): Partial<OmpRuntimeHost> => ({
    probeVersionOutput: () => (output === undefined ? {} : { output }),
  });
  const nativeBare = inspectOmpRuntimeReadiness(
    { COSYNCING_OMP_BIN: nativeBin, PATH: '' },
    nativeProbe('17.4.2'),
  );
  assert.equal(nativeBare.ready, true, "omp's bare `--version` answer is its identity");
  assert.equal(nativeBare.detailCode, 'omp-native-runtime-ready');
  assert.equal(nativeBare.packageVersion, '17.4.2');

  const nativeNamed = inspectOmpRuntimeReadiness(
    { COSYNCING_OMP_BIN: nativeBin, PATH: '' },
    nativeProbe('oh-my-pi 17.4.2'),
  );
  assert.equal(nativeNamed.ready, true, 'a name-line identity is equally accepted');

  const nativeBelow = inspectOmpRuntimeReadiness(
    { COSYNCING_OMP_BIN: nativeBin, PATH: '' },
    nativeProbe('17.3.9'),
  );
  assert.equal(nativeBelow.ready, false);
  assert.equal(nativeBelow.detailCode, 'omp-native-version-below-minimum');
  assert.equal(nativeBelow.packageVersion, '17.3.9');

  const nativeForeign = inspectOmpRuntimeReadiness(
    { COSYNCING_OMP_BIN: nativeBin, PATH: '' },
    nativeProbe('unrelated-tool 17.4.2'),
  );
  assert.equal(nativeForeign.ready, false, "a version inside another tool's output is not omp");
  assert.equal(nativeForeign.detailCode, 'omp-native-identity-unverified');

  const nativeSilent = inspectOmpRuntimeReadiness(
    { COSYNCING_OMP_BIN: nativeBin, PATH: '' },
    nativeProbe(undefined),
  );
  assert.equal(nativeSilent.ready, false);
  assert.equal(nativeSilent.detailCode, 'omp-native-identity-unverified');

  // -------------------------------------------------------------------------
  // Described Windows launchers: a `.cmd`-style shim with the package installed beside it and the
  // interpreter (`bun.exe`) in the same prefix. Same described-host rule as the pi gate.
  // -------------------------------------------------------------------------
  const BUN_PREFIX = 'C:\\Users\\dev\\.bun\\bin';
  const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
  const SHIM = `${BUN_PREFIX}\\omp.CMD`;
  const BUN_EXE = `${BUN_PREFIX}\\bun.exe`;
  const packageJsonPath = `${BUN_PREFIX}\\node_modules\\@oh-my-pi\\pi-coding-agent\\package.json`;
  const ompPackageJson = (version: unknown = '17.4.2'): string => JSON.stringify({
    name: OMP_PACKAGE,
    version,
    engines: { bun: `>=${OMP_DEFAULT_BUN_MINIMUM_VERSION}` },
  });

  interface DescribedWindowsHost {
    executables?: readonly string[];
    files?: Record<string, string>;
    versions?: Record<string, string>;
  }

  function describeWindowsHost(fixture: DescribedWindowsHost): { host: Partial<OmpRuntimeHost>; probed: string[] } {
    const fold = (path: string): string => path.toLowerCase();
    const executables = new Set((fixture.executables ?? []).map(fold));
    const files = new Map(Object.entries(fixture.files ?? {}).map(([key, value]) => [fold(key), value]));
    const versions = new Map(Object.entries(fixture.versions ?? {}).map(([key, value]) => [fold(key), value]));
    const realCase = new Map<string, string>();
    for (const path of [...(fixture.executables ?? []), ...Object.keys(fixture.files ?? {})]) {
      realCase.set(fold(path), path);
    }
    const probed: string[] = [];
    return {
      probed,
      host: {
        platform: 'win32',
        isExecutableFile: (path) => executables.has(fold(path)),
        canonicalize: (path) => realCase.get(fold(path)) ?? path,
        readLauncherPrefix: (path) => {
          throw new Error(`readiness must not read this launcher's contents: ${path}`);
        },
        readBoundedText: (path, maxBytes) => {
          const text = files.get(fold(path));
          if (text === undefined) return { ok: false, reason: 'missing' };
          if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, reason: 'too-large' };
          return { ok: true, text };
        },
        probeVersionOutput: (invocation) => {
          probed.push(invocation.originalPath);
          const output = versions.get(fold(invocation.originalPath));
          return output === undefined ? {} : { output };
        },
      },
    };
  }

  const windowsEnv = (pathValue: string): NodeJS.ProcessEnv => ({
    Path: pathValue,
    PathExt: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  const PREFIX_ON_PATH = windowsEnv(`C:\\Windows\\System32;${BUN_PREFIX.toLowerCase()}`);

  const supportedShim = describeWindowsHost({
    executables: [SHIM, BUN_EXE],
    files: { [packageJsonPath]: ompPackageJson() },
    versions: { [SHIM]: '17.4.2', [BUN_EXE]: '1.4.0' },
  });
  const shimReady = inspectOmpRuntimeReadiness(PREFIX_ON_PATH, supportedShim.host);
  assert.equal(shimReady.ready, true, 'a Windows shim beside its package is a Bun launcher');
  assert.equal(shimReady.detailCode, 'omp-bun-runtime-supported');
  assert.equal(shimReady.executable, SHIM);
  assert.equal(shimReady.bunExecutable, BUN_EXE);
  assert.equal(shimReady.bunVersion, '1.4.0');
  assert.equal(shimReady.packageVersion, '17.4.2');
  assert.deepEqual(supportedShim.probed, [SHIM, BUN_EXE],
    'the resolved shim is asked what it is, and only then is the interpreter probed');

  const oldPackage = describeWindowsHost({
    executables: [SHIM, BUN_EXE],
    files: { [packageJsonPath]: ompPackageJson('17.0.0') },
    versions: { [SHIM]: '17.0.0', [BUN_EXE]: '1.4.0' },
  });
  const belowFloor = inspectOmpRuntimeReadiness(PREFIX_ON_PATH, oldPackage.host);
  assert.equal(belowFloor.ready, false, 'the adapter floor applies to a batch launcher too');
  assert.equal(belowFloor.detailCode, 'omp-batch-version-below-minimum');
  assert.equal(belowFloor.packageVersion, '17.0.0');
  assert.match(belowFloor.message, new RegExp(OMP_MINIMUM_SUPPORTED_VERSION.replaceAll('.', '\\.')));

  const replacedShim = describeWindowsHost({
    executables: [SHIM, BUN_EXE],
    files: { [packageJsonPath]: ompPackageJson() },
    versions: { [SHIM]: 'other-tool 1.2.3', [BUN_EXE]: '1.4.0' },
  });
  const replaced = inspectOmpRuntimeReadiness(PREFIX_ON_PATH, replacedShim.host);
  assert.equal(replaced.ready, false,
    "a shim replaced beside a legitimate omp installation must not pass on its neighbour's evidence");
  assert.equal(replaced.detailCode, 'omp-batch-identity-mismatch');

  const noPackage = describeWindowsHost({
    executables: [SHIM, BUN_EXE],
    versions: { [SHIM]: '17.4.2', [BUN_EXE]: '1.4.0' },
  });
  const missingPackage = inspectOmpRuntimeReadiness(PREFIX_ON_PATH, noPackage.host);
  assert.equal(missingPackage.ready, false, 'a shim with no package beside it proves no omp identity');
  assert.equal(missingPackage.detailCode, 'omp-package-identity-missing');

  console.log('PASS: omp readiness qualifies the effective Bun launcher on POSIX shebangs, native bare-version executables, and Windows shims');
} finally {
  rmSync(root, { recursive: true, force: true });
}
