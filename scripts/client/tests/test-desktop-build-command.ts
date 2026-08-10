#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../../../package.json';
import {
  ANDROID_BUILD_MODES,
  androidBuildCommand,
} from '../build-android.ts';
import {
  DESKTOP_BUILD_TARGETS,
  desktopBuildCommand,
} from '../build-desktop.ts';
import { REPOSITORY_ROOT } from '../run-client-command.ts';

let failures = 0;

function check(ok: unknown, message: string): void {
  if (ok) {
    console.log(`PASS ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

const versionDefine =
  `--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`;

for (const target of DESKTOP_BUILD_TARGETS) {
  const release = desktopBuildCommand(target, 'release');
  check(
    release.includes(versionDefine),
    `${target} release build stamps COSYNCING_CLIENT_VERSION`,
  );
  check(
    release.filter((argument) => argument === versionDefine).length === 1,
    `${target} release build stamps the version exactly once`,
  );

  for (const mode of ['debug', 'profile'] as const) {
    const development = desktopBuildCommand(target, mode);
    check(
      !development.some((argument) =>
        argument.startsWith('--dart-define=COSYNCING_CLIENT_VERSION=')),
      `${target} ${mode} build keeps the development sentinel`,
    );
  }
}

for (const mode of ANDROID_BUILD_MODES) {
  const command = androidBuildCommand(mode);
  check(
    command.includes(versionDefine) === (mode === 'release'),
    `android ${mode} build ${mode === 'release' ? 'stamps' : 'omits'} the release version`,
  );
}

for (const relativePath of [
  'scripts/client/platform_build_smoke.sh',
  'scripts/client/voice_validation.sh',
]) {
  const source = await readFile(join(REPOSITORY_ROOT, relativePath), 'utf8');
  check(
    source.includes('build-desktop.ts'),
    `${relativePath} delegates desktop builds to the canonical command`,
  );
  check(
    !/flutter build (linux|macos|windows)/.test(source),
    `${relativePath} does not bypass desktop release stamping`,
  );
}

const clientCheck = await readFile(
  join(REPOSITORY_ROOT, 'scripts/client/check.ts'),
  'utf8',
);
check(
  clientCheck.includes('tests/test-desktop-build-command.ts'),
  'client:check executes the release build command regression',
);

if (failures > 0) process.exit(1);
