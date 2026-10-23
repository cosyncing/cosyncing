#!/usr/bin/env bun
/** Canonical Android client build command. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../package.json';
import { runClientCommand } from './run-client-command.ts';

export const ANDROID_BUILD_MODES = ['debug', 'profile', 'release'] as const;
export type AndroidBuildMode = (typeof ANDROID_BUILD_MODES)[number];

/**
 * Returns the supported Android APK command shape.
 *
 * Release artifacts carry the same product version used by web and desktop
 * builds. Development builds retain the 0.0.0-dev sentinel.
 */
export function androidBuildCommand(mode: AndroidBuildMode): string[] {
  return [
    'flutter',
    'build',
    'apk',
    `--${mode}`,
    ...(mode === 'release'
      ? [`--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`]
      : []),
  ];
}

/**
 * Resources referenced only by name from Dart, which release resource
 * shrinking cannot see. `android/app/src/main/res/raw/keep.xml` keeps them;
 * this list proves it did. The notification icon was stripped from every
 * release APK before 0.6, so no notification ever initialized.
 */
export const REQUIRED_ANDROID_RESOURCES = ['drawable/ic_notification'] as const;

/** Required resources absent from an `aapt2 dump resources` listing. */
export function missingAndroidResources(dump: string): string[] {
  return REQUIRED_ANDROID_RESOURCES.filter(
    (resource) => !new RegExp(`\\s${resource.replace('/', '\\/')}(\\s|$)`, 'm').test(dump),
  );
}

export const ANDROID_RELEASE_APK = 'apps/client/build/app/outputs/flutter-apk/app-release.apk';

function findAapt2(): string | null {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const buildTools = join(root, 'build-tools');
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(buildTools, version, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Fails when a built release APK lost a resource Dart loads by name. */
export async function verifyAndroidReleaseResources(apk = ANDROID_RELEASE_APK): Promise<number> {
  const aapt2 = findAapt2();
  if (aapt2 == null) {
    console.error('Cannot verify Android release resources: aapt2 not found (set ANDROID_HOME).');
    return 1;
  }
  const dump = Bun.spawnSync([aapt2, 'dump', 'resources', apk], { stdout: 'pipe', stderr: 'pipe' });
  if (dump.exitCode !== 0) {
    console.error(`aapt2 dump resources failed for ${apk}:\n${dump.stderr.toString()}`);
    return 1;
  }
  const missing = missingAndroidResources(dump.stdout.toString());
  if (missing.length > 0) {
    console.error(
      `Release APK is missing resources Dart loads by name: ${missing.join(', ')}. `
        + 'Keep them in android/app/src/main/res/raw/keep.xml.',
    );
    return 1;
  }
  return 0;
}

export async function buildAndroid(
  mode: AndroidBuildMode = 'release',
): Promise<number> {
  const status = await runClientCommand(androidBuildCommand(mode));
  if (status !== 0 || mode !== 'release') return status;
  return verifyAndroidReleaseResources();
}

function isAndroidBuildMode(value: string): value is AndroidBuildMode {
  return (ANDROID_BUILD_MODES as readonly string[]).includes(value);
}

function parseMode(args: string[]): AndroidBuildMode | null {
  let modeValue = 'release';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--mode') {
      modeValue = args[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--mode=')) {
      modeValue = argument.slice('--mode='.length);
    } else {
      return null;
    }
  }
  return isAndroidBuildMode(modeValue) ? modeValue : null;
}

if (import.meta.main) {
  const mode = parseMode(Bun.argv.slice(2));
  if (mode == null) {
    console.error(
      'Usage: bun run scripts/client/build-android.ts '
        + '[--mode <debug|profile|release>]',
    );
    process.exit(2);
  }
  process.exit(await buildAndroid(mode));
}
