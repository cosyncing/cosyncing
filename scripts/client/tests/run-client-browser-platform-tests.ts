#!/usr/bin/env bun
/**
 * Runs the client's `@TestOn('browser')` Flutter tests in a real Chromium.
 *
 * `client:check` runs `flutter test` on the VM platform, which skips
 * browser-only files entirely, and the other web-browser commands drive the
 * built bundle rather than the Flutter test harness. Without this lane the
 * browser-platform regressions — above all the startup invariant that the
 * first frame cannot precede a settled `BrowserContextMenu` state — would
 * hold only as long as someone remembered to run them by hand.
 *
 * Chromium discovery mirrors the sibling browser suites: an explicit
 * COSYNCING_CHROMIUM_EXECUTABLE wins, otherwise the newest Playwright
 * headless shell is used (verified to drive `flutter test --platform
 * chrome`).
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const CLIENT_ROOT = join(REPOSITORY_ROOT, 'apps/client');

/** Every browser-platform test file this lane owns, repo-relative. */
const BROWSER_PLATFORM_TESTS = [
  'test/src/features/schedules/platform/device_time_zone_web_test.dart',
  'test/src/platform/startup/browser_context_menu_startup_web_test.dart',
];

function chromiumExecutable(): string {
  const explicit = process.env.COSYNCING_CHROMIUM_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const cache = join(process.env.HOME ?? tmpdir(), '.cache/ms-playwright');
  const shells = readdirSync(cache)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort(
      (left, right) =>
        Number(right.split('-')[1]) - Number(left.split('-')[1]),
    );
  if (shells.length === 0) {
    throw new Error(
      'No Chromium headless shell found. '
        + 'Run: npx playwright install chromium-headless-shell',
    );
  }
  return join(
    cache,
    shells[0]!,
    'chrome-headless-shell-linux64/chrome-headless-shell',
  );
}

const child = Bun.spawn(
  ['flutter', 'test', '--platform', 'chrome', ...BROWSER_PLATFORM_TESTS],
  {
    cwd: CLIENT_ROOT,
    env: { ...process.env, CHROME_EXECUTABLE: chromiumExecutable() },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
process.exit(await child.exited);
