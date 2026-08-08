#!/usr/bin/env bun
/** Canonical Flutter desktop build command for Linux, macOS, and Windows. */
import packageJson from '../../package.json';
import { runClientCommand } from './run-client-command.ts';

export const DESKTOP_BUILD_TARGETS = ['linux', 'macos', 'windows'] as const;
export const DESKTOP_BUILD_MODES = ['debug', 'profile', 'release'] as const;

export type DesktopBuildTarget = (typeof DESKTOP_BUILD_TARGETS)[number];
export type DesktopBuildMode = (typeof DESKTOP_BUILD_MODES)[number];

/**
 * Returns the one supported command shape for a desktop client build.
 *
 * Development builds deliberately keep the `0.0.0-dev` default. Release
 * builds stamp the root package version so the installed app can compare its
 * release identity with the broker that shipped beside it.
 */
export function desktopBuildCommand(
  target: DesktopBuildTarget,
  mode: DesktopBuildMode,
): string[] {
  return [
    'flutter',
    'build',
    target,
    `--${mode}`,
    ...(mode === 'release'
      ? [`--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`]
      : []),
  ];
}

/** Builds one desktop target through the pinned client command runner. */
export async function buildDesktop(
  target: DesktopBuildTarget,
  mode: DesktopBuildMode = 'release',
): Promise<number> {
  return runClientCommand(desktopBuildCommand(target, mode));
}

function isDesktopBuildTarget(value: string): value is DesktopBuildTarget {
  return (DESKTOP_BUILD_TARGETS as readonly string[]).includes(value);
}

function isDesktopBuildMode(value: string): value is DesktopBuildMode {
  return (DESKTOP_BUILD_MODES as readonly string[]).includes(value);
}

function usage(): void {
  console.error(
    'Usage: bun run scripts/client/build-desktop.ts '
      + '--target <linux|macos|windows> [--mode <debug|profile|release>]',
  );
}

function parseArguments(args: string[]): {
  target: DesktopBuildTarget;
  mode: DesktopBuildMode;
} | null {
  let targetValue: string | undefined;
  let modeValue = 'release';

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--target') {
      targetValue = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--target=')) {
      targetValue = argument.slice('--target='.length);
    } else if (argument === '--mode') {
      modeValue = args[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--mode=')) {
      modeValue = argument.slice('--mode='.length);
    } else {
      return null;
    }
  }

  if (
    targetValue == null
    || !isDesktopBuildTarget(targetValue)
    || !isDesktopBuildMode(modeValue)
  ) {
    return null;
  }
  return { target: targetValue, mode: modeValue };
}

if (import.meta.main) {
  const parsed = parseArguments(Bun.argv.slice(2));
  if (parsed == null) {
    usage();
    process.exit(2);
  }
  process.exit(await buildDesktop(parsed.target, parsed.mode));
}
