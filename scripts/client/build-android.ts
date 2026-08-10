#!/usr/bin/env bun
/** Canonical Android client build command. */
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

export async function buildAndroid(
  mode: AndroidBuildMode = 'release',
): Promise<number> {
  return runClientCommand(androidBuildCommand(mode));
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
