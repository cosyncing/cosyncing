#!/usr/bin/env bun
/**
 * Builds the Flutter client's unit-test asset bundle once, before the test
 * shards run.
 *
 * Every `flutter test` in apps/client reads and, when it looks stale, rewrites
 * the same `build/unit_test_assets`. Shards running side by side in one
 * checkout rebuilt it together and once left a shader with only its Vulkan
 * stage, which failed every ink-ripple test, and the bad bundle then survived
 * the retry and later runs. So the bundle is deleted and rebuilt here by one
 * process, by running the smallest client test file.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const client = join(import.meta.dir, '..', '..', 'apps', 'client');

let smallest: { path: string; size: number } | undefined;
const walk = (directory: string): void => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (entry.endsWith('_test.dart') && (!smallest || stat.size < smallest.size)) {
      smallest = { path, size: stat.size };
    }
  }
};
walk(join(client, 'test'));
if (!smallest) throw new Error('flutter-test-assets: apps/client/test has no *_test.dart file');

rmSync(join(client, 'build', 'unit_test_assets'), { recursive: true, force: true });
const file = relative(client, smallest.path).replaceAll('\\', '/');
console.log(`flutter-test-assets: building the bundle with ${file}`);
const result = Bun.spawnSync(['flutter', 'test', '--no-pub', file], {
  cwd: client,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(result.exitCode ?? 1);
