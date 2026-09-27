#!/usr/bin/env bun
/**
 * Measures transcript scrolling in profile builds, on native and on web.
 *
 *   bun run scripts/client/measure-transcript-scroll.ts --target native \
 *     [--label after] [--scenarios traverse,flings] [--scale 1]
 *   bun run scripts/client/measure-transcript-scroll.ts --target web \
 *     [--label after] [--scenarios traverse,flings] \
 *     [--skip-build | --web-dir <profile web build>]
 *
 * Native runs `integration_test/transcript_scroll_performance_test.dart` as a
 * Linux desktop profile build under `flutter drive`: the production session
 * page over a paging broker fake, with frame timings from the engine and heap
 * from the VM service.
 *
 * Web builds a profile web bundle into `apps/client/build/web-profile`, serves
 * it from an isolated fixture broker (its own temporary port and home, no
 * managed runtimes), opens a long Pi bridge session in headless Chromium, and
 * drives it (see `measure-transcript-scroll-web.ts`). `--web-dir` serves another
 * profile web build instead, such as one of an earlier commit to compare with.
 * TRANSCRIPT_SCROLL_WEB_SHOTS=1 keeps a screenshot of each stage;
 * TRANSCRIPT_SCROLL_WEB_CPU_PROFILE=1 adds a sampled CPU profile of the
 * streaming-at-the-tail scenario to its report.
 *
 * Neither is a gate. Reports go to
 * `output/scroll-analysis/<prefix>-<target>-<label>.json` (`--prefix`, default
 * `transcript-scroll`).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY_ROOT, runClientCommand } from './run-client-command.ts';

const OUTPUT = join(REPOSITORY_ROOT, 'output/scroll-analysis');

interface Options {
  target: 'native' | 'web';
  label: string;
  prefix: string;
  scenarios: string;
  scale: number;
  skipBuild: boolean;
  webDir?: string;
}

function parse(args: string[]): Options | null {
  const options: Options = {
    target: 'native',
    label: 'run',
    prefix: 'transcript-scroll',
    scenarios: 'all',
    scale: 1,
    skipBuild: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = () => args[++index] ?? '';
    if (argument === '--target') {
      const target = value();
      if (target !== 'native' && target !== 'web') return null;
      options.target = target;
    } else if (argument === '--label') {
      options.label = value();
    } else if (argument === '--prefix') {
      options.prefix = value();
    } else if (argument === '--scenarios') {
      options.scenarios = value();
    } else if (argument === '--scale') {
      options.scale = Number(value());
    } else if (argument === '--skip-build') {
      options.skipBuild = true;
    } else if (argument === '--web-dir') {
      options.webDir = value();
      if (!options.webDir) return null;
    } else {
      return null;
    }
  }
  if (!/^[a-z0-9-]+$/.test(options.label) || !/^[a-z0-9-]+$/.test(options.prefix)) return null;
  if (!(options.scale >= 1)) return null;
  return options;
}

async function measureNative(options: Options): Promise<number> {
  const out = join(OUTPUT, `${options.prefix}-native-${options.label}.json`);
  process.env.TRANSCRIPT_SCROLL_OUT = out;
  const code = await runClientCommand([
    'flutter',
    'drive',
    '--profile',
    '-d',
    'linux',
    '--driver=test_driver/transcript_scroll_performance.dart',
    '--target=integration_test/transcript_scroll_performance_test.dart',
    `--dart-define=TRANSCRIPT_SCROLL_SCENARIOS=${options.scenarios}`,
    `--dart-define=TRANSCRIPT_SCROLL_SCALE=${options.scale}`,
  ]);
  if (code === 0) console.log(`wrote ${out}`);
  return code;
}

async function measureWeb(options: Options): Promise<number> {
  const { measureWebTranscriptScroll } = await import(
    './measure-transcript-scroll-web.ts'
  );
  return measureWebTranscriptScroll({
    out: join(OUTPUT, `${options.prefix}-web-${options.label}.json`),
    skipBuild: options.skipBuild,
    webDir: options.webDir,
    scenarios: options.scenarios,
    scale: options.scale,
  });
}

if (import.meta.main) {
  const options = parse(Bun.argv.slice(2));
  if (options == null) {
    console.error(
      'Usage: bun run scripts/client/measure-transcript-scroll.ts '
        + '--target <native|web> [--label <name>] [--prefix <name>] [--scenarios <a,b>] '
        + '[--scale <n>] [--skip-build | --web-dir <dir>]',
    );
    process.exit(2);
  }
  mkdirSync(OUTPUT, { recursive: true });
  process.exit(
    options.target === 'native'
      ? await measureNative(options)
      : await measureWeb(options),
  );
}
