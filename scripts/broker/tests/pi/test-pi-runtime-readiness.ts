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
import {
  inspectPiRuntimeReadiness,
  PI_DEFAULT_NODE_MINIMUM_VERSION,
} from '../../../../packages/typescript/adapters/pi/src/index.ts';
import { diagnosePiSetup } from '../../../../packages/typescript/adapters/pi/src/diagnostics.ts';
import { createSetupDiagnosisContext } from '../../../../packages/typescript/broker/src/diagnosis-context.ts';
import { agentSummaries, doctorBlockers } from '../../../../packages/typescript/broker/src/setup.ts';
import { agentPreflightLines } from '../../../../packages/typescript/broker/src/setup-presenter.ts';

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

  console.log('PASS: Pi readiness qualifies the effective Node launcher and remains setup-optional');
} finally {
  rmSync(root, { recursive: true, force: true });
}
