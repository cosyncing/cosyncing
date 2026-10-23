/**
 * The test suites: one per CI job, each a feature area.
 *
 *   bun run check                     every suite this host can run
 *   bun run check broker adapters     just those
 *   bun run check client --shard 2/3  one CI shard of a suite
 *
 * A suite is a list of tasks. A task is one command with its own timeout,
 * retried once on failure (a pass on retry is reported FLAKY, not failed).
 * Feature e2e suites are discovered from `e2e/<suite>/**\/*.test.ts` and run
 * with `bun test`; listing them here is unnecessary.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { legacyTasks } from './legacy-tasks.ts';
import { windowsLane } from './lib/windows-lane.ts';

export type SuiteId =
  | 'policy'
  | 'broker'
  | 'adapters'
  | 'packaging'
  | 'client'
  | 'android'
  | 'web'
  | 'windows';

export interface Task {
  /** Unique within its suite; names the log file. */
  id: string;
  run: string[];
  /** Relative to the repository root. */
  cwd?: string;
  /** Wall clock for one attempt. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Never overlaps another serial task of the same run. */
  serial?: boolean;
  /** Deterministic checks (lint, format, policy) are not retried. */
  retry?: boolean;
  /** Expected duration; only balances shards. */
  estimateMs?: number;
}

export interface Suite {
  id: SuiteId;
  title: string;
  /** Hosts the suite can run on. Default: linux and darwin. */
  platforms?: NodeJS.Platform[];
  /** Run once, in order, before any task. A failure skips the suite's tasks. */
  prepare?: Task[];
  tasks: Task[];
  /** Extra environment for each of the suite's tasks. */
  env?: (task: Task) => Record<string, string>;
  /** Runs after the suite's tasks however they ended. Never fails the run. */
  cleanup?: () => void;
}

export const DEFAULT_TIMEOUT_MS = 180_000;

const ROOT = join(import.meta.dir, '..', '..');

function findTestFiles(base: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.test.ts')) found.push(relative(ROOT, path).replaceAll('\\', '/'));
    }
  };
  walk(join(ROOT, base));
  return found.sort();
}

function bunTestTask(file: string, id: string): Task {
  return {
    id,
    // Per-test bound; the task timeout bounds the file.
    run: ['bun', 'test', '--timeout', '120000', `./${file}`],
    timeoutMs: 300_000,
  };
}

/** Feature e2e suites: `e2e/<suite>/**\/*.test.ts`. */
function e2eTasks(suite: SuiteId): Task[] {
  return findTestFiles(`e2e/${suite}`).map((file) =>
    bunTestTask(file, file.slice(`e2e/${suite}/`.length).replace(/\.test\.ts$/, ''))
  );
}

/**
 * Narrow tests that stay beside the code they pin (`*.test.ts` under a package):
 * behaviour an e2e cannot reach, such as a clock-driven policy or a crypto vector.
 */
function narrowTasks(...bases: string[]): Task[] {
  return bases.flatMap(findTestFiles).map((file) =>
    bunTestTask(file, `narrow/${file.replace(/^packages\/typescript\//, '').replace(/\.test\.ts$/, '')}`)
  );
}

/**
 * Test files another suite owns, run again by a platform lane (Windows) under
 * the same task ids they have at home.
 */
function testFiles(...files: string[]): Task[] {
  return files.map((file) => {
    if (!existsSync(join(ROOT, file))) throw new Error(`suites: no test file ${file}`);
    const id = file.startsWith('e2e/')
      ? file.replace(/^e2e\/[^/]+\//, '').replace(/\.test\.ts$/, '')
      : `narrow/${file.replace(/^packages\/typescript\//, '').replace(/\.test\.ts$/, '')}`;
    return { ...bunTestTask(file, id), serial: true };
  });
}

const FLUTTER_TEST_SHARDS = 3;

/**
 * The client's test files split into `count` lists of similar size.
 *
 * Split by FILE, not with `flutter test --total-shards`: that option divides
 * the tests inside each file, so every shard still compiles every file, and
 * compilation is most of the client's test time. Source size stands in for
 * compile cost.
 */
function flutterTestFiles(count: number): string[][] {
  const base = join(ROOT, 'apps', 'client');
  const files: { path: string; size: number }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        // The stress lane runs nightly (`flutter-stress`), never on a pull request.
        if (path !== join(base, 'test', 'stress')) walk(path);
      } else if (entry.endsWith('_test.dart')) {
        files.push({ path: relative(base, path).replaceAll('\\', '/'), size: stat.size });
      }
    }
  };
  walk(join(base, 'test'));
  const groups = Array.from({ length: count }, () => ({ size: 0, files: [] as string[] }));
  for (const file of files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))) {
    const lightest = groups.reduce((best, group) => (group.size < best.size ? group : best));
    lightest.size += file.size;
    lightest.files.push(file.path);
  }
  return groups.map((group) => group.files.sort());
}
const DART_PACKAGES = [
  'broker_contract',
  'broker_client',
  'broker_client_flutter',
  'broker_crypto',
];

function pick(ids: string[]): Task[] {
  const all = Object.values(legacyTasks).flat();
  return ids.map((id) => {
    const task = all.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`suites: no legacy task ${id}`);
    return { ...task, serial: true };
  });
}

export const suites: Suite[] = [
  {
    id: 'policy',
    title: 'Repository policy: types, contract, public tree, boundaries, workflows',
    tasks: [
      { id: 'diff-hygiene', run: ['git', 'diff', '--check'], retry: false },
      { id: 'workflows', run: ['bash', 'scripts/ci/audit-workflows.sh'], retry: false },
      { id: 'public-tree', run: ['ruby', 'scripts/ci/check-public-tree.rb'], retry: false },
      { id: 'public-tree-policy', run: ['ruby', 'scripts/ci/tests/test-public-tree-policy.rb'], retry: false },
      { id: 'boundaries', run: ['bash', 'scripts/ci/check-boundaries.sh'], retry: false },
      { id: 'contract', run: ['bash', 'scripts/contracts/check.sh'], retry: false },
      { id: 'contract-history', run: ['bun', 'run', 'scripts/contracts/test-revision-history.ts'], retry: false },
      { id: 'trace-manifest', run: ['bun', 'run', 'scripts/broker/tests_traces/check-trace-manifest.ts'], retry: false },
      { id: 'support-matrix', run: ['bun', 'run', 'scripts/broker/tests_traces/check-support-matrix-coverage.ts'], retry: false },
      ...legacyTasks.policy.map((task) => ({ ...task, retry: false })),
      ...e2eTasks('policy'),
    ],
  },
  {
    id: 'broker',
    title: 'Broker: install, lifecycle, pairing, sessions, history, attention, artifacts',
    tasks: [
      { id: 'capabilities', run: ['bun', 'run', 'packages/typescript/broker/test/capabilities/test-capabilities.ts'] },
      ...legacyTasks.broker,
      ...e2eTasks('broker'),
      ...narrowTasks('packages/typescript/broker', 'packages/typescript/protocol', 'packages/typescript/crypto'),
    ],
  },
  {
    id: 'adapters',
    title: 'Agent adapters and the Claude mod',
    tasks: [
      ...legacyTasks.adapters,
      ...e2eTasks('adapters'),
      ...narrowTasks('packages/typescript/adapters', 'packages/typescript/adapter-api', 'packages/typescript/acp-client'),
    ],
  },
  {
    id: 'packaging',
    title: 'Packaging and release: JavaScript installation, compiled assets, installers, supply chain',
    tasks: [...legacyTasks.packaging, ...e2eTasks('packaging')],
  },
  {
    id: 'client',
    title: 'Flutter client and Dart packages',
    prepare: [
      { id: 'pub-get', run: ['flutter', 'pub', 'get'], cwd: 'apps/client', retry: true },
      ...DART_PACKAGES.map((name) => ({
        id: `pub-get-${name}`,
        run: ['flutter', 'pub', 'get'],
        cwd: `packages/dart/${name}`,
      })),
      { id: 'test-assets', run: ['bun', 'run', 'scripts/ci/flutter-test-assets.ts'], timeoutMs: 600_000 },
    ],
    tasks: [
      {
        id: 'format',
        run: [
          'dart', 'format', '--output=none', '--set-exit-if-changed',
          'lib', 'test', 'tool', 'integration_test', 'test_driver', '../../packages/dart',
        ],
        cwd: 'apps/client',
        retry: false,
        estimateMs: 5_000,
      },
      { id: 'analyze', run: ['flutter', 'analyze', '--no-pub'], cwd: 'apps/client', retry: false, estimateMs: 30_000 },
      ...flutterTestFiles(FLUTTER_TEST_SHARDS).map((files, index) => ({
        id: `flutter-test-${index + 1}-of-${FLUTTER_TEST_SHARDS}`,
        run: ['flutter', 'test', '--no-pub', ...files],
        cwd: 'apps/client',
        timeoutMs: 900_000,
        // Flutter's native-assets manifest is shared by tests in this checkout.
        // Separate hosted shards already have their own checkout.
        serial: true,
        estimateMs: 150_000,
      })),
      // Nightly only: the transcript fuzz, matrix, motion and prefetch stress files (`nightly.yml` sets the
      // variable and a wider fuzz seed range).
      ...(process.env.COSYNCING_CLIENT_STRESS === '1'
        ? [{ id: 'flutter-stress', run: ['flutter', 'test', '--no-pub', 'test/stress'], cwd: 'apps/client', serial: true, timeoutMs: 1_800_000, estimateMs: 120_000 }]
        : []),
      { id: 'desktop-build-command', run: ['bun', 'run', 'scripts/client/tests/test-desktop-build-command.ts'], estimateMs: 2_000 },
      { id: 'release-policy', run: ['bun', 'run', 'scripts/client/tests/test-client-release-policy.ts'], estimateMs: 2_000 },
      ...DART_PACKAGES.flatMap((name) => [
        { id: `${name}-analyze`, run: ['flutter', 'analyze', '--no-pub'], cwd: `packages/dart/${name}`, retry: false, estimateMs: 5_000 },
        { id: `${name}-test`, run: ['flutter', 'test', '--no-pub'], cwd: `packages/dart/${name}`, estimateMs: 15_000 },
      ]),
    ],
  },
  {
    // Native Android needs an SDK/JDK, supplied by the existing Android build
    // job rather than the Flutter test shards. Local full checks include it
    // whenever an Android SDK is configured; release builds stay build-only.
    id: 'android',
    title: 'Android client native JVM scenarios',
    platforms: ['linux', 'darwin', 'win32'],
    prepare: [
      { id: 'pub-get', run: ['flutter', 'pub', 'get'], cwd: 'apps/client' },
      // gradlew and its wrapper jar are gitignored; Flutter writes them when it
      // configures the Android project, so a fresh checkout has neither.
      { id: 'gradle-wrapper', run: ['flutter', 'build', 'apk', '--config-only'], cwd: 'apps/client' },
    ],
    tasks: [{
      id: 'native-jvm',
      retry: false,
      run: [process.platform === 'win32' ? 'android/gradlew.bat' : 'android/gradlew',
        '-p', 'android', ':app:testDebugUnitTest', '--console=plain'],
      cwd: 'apps/client',
      serial: true,
      timeoutMs: 600_000,
      estimateMs: 60_000,
    }],
  },
  {
    id: 'web',
    title: 'Web client in a real browser against fixture brokers',
    prepare: [
      { id: 'pub-get', run: ['flutter', 'pub', 'get'], cwd: 'apps/client' },
      { id: 'build-web', run: ['bun', 'run', 'scripts/client/build-web.ts'], timeoutMs: 600_000 },
    ],
    tasks: [
      // The Flutter `--platform chrome` lane and the service-worker data suites; each e2e file owns its
      // brokers and browser, so everything here runs in parallel.
      { id: 'browser-platform', run: ['bun', 'run', 'scripts/client/tests/run-client-browser-platform-tests.ts'] },
      { id: 'static-cache', run: ['bun', 'run', 'scripts/client/tests/test-web-static-cache.ts'] },
      { id: 'notification-click', run: ['bun', 'run', 'scripts/client/tests/test-web-notification-click.ts'] },
      { id: 'push-notification', run: ['bun', 'run', 'scripts/client/tests/test-web-push-notification.ts'] },
      { id: 'update-handoff', run: ['bun', 'run', 'scripts/client/tests/test-web-update-handoff.ts'] },
      ...e2eTasks('web'),
    ],
  },
  {
    id: 'windows',
    title: 'Broker on Windows: host primitives, secure files, service, installer',
    platforms: ['win32'],
    tasks: [
      ...pick([
        'windows-process', 'windows-dacl', 'windows-service', 'lifecycle', 'state-security',
        'zero-agent-doctor', 'transactional-setup', 'kimi-cross-client-join', 'control-boundaries',
        'route-authorization', 'broker-update-contract', 'real-evidence-schema', 'claude-artifacts',
      ]),
      ...testFiles(
        'e2e/policy/runner.test.ts',
        'e2e/broker/uploads.test.ts',
        'e2e/broker/artifact-limits.test.ts',
        'e2e/broker/diff-references.test.ts',
        'packages/typescript/broker/src/artifacts/upload-staging.test.ts',
        'packages/typescript/broker/src/artifacts/artifact-store.test.ts',
        'e2e/broker/transcript-identity.test.ts',
        'e2e/broker/mutation-idempotency.test.ts',
        'e2e/broker/request-validation.test.ts',
        'packages/typescript/broker/test/sessions/resync-replay.test.ts',
        'packages/typescript/broker/test/sessions/protocol-journal-records.test.ts',
        'e2e/broker/history-paging.test.ts',
        'e2e/broker/history-refresh.test.ts',
        'e2e/broker/history-append-cursors.test.ts',
        'e2e/broker/session-roster.test.ts',
        'packages/typescript/broker/test/roster/publication-races.test.ts',
        'e2e/broker/attention-feed.test.ts',
        'e2e/broker/composer-drafts.test.ts',
        'e2e/broker/status-truth.test.ts',
        'packages/typescript/broker/test/sessions/session-status-fold.test.ts',
        'packages/typescript/broker/test/sessions/session-truth-manifest.test.ts',
        'packages/typescript/adapter-api/test/windows-process-table.test.ts',
        'packages/typescript/adapters/codex/test/windows-presence.test.ts',
      ),
      { id: 'install-ps1', run: ['bun', 'run', 'scripts/broker/tests/release/test-install-ps1.ts'], serial: true, timeoutMs: 300_000 },
      ...e2eTasks('windows'),
    ],
    env: windowsLane.env,
    cleanup: windowsLane.cleanup,
  },
];

for (const suite of suites) {
  const seen = new Set<string>();
  for (const task of [...(suite.prepare ?? []), ...suite.tasks]) {
    if (seen.has(task.id)) {
      throw new Error(`suites: ${suite.id} has two tasks named ${task.id}; delete the legacy task the e2e suite replaces`);
    }
    seen.add(task.id);
  }
}

export function suiteRunsOn(suite: Suite, host: NodeJS.Platform): boolean {
  const supportedHost = (suite.platforms ?? ['linux', 'darwin']).includes(host);
  if (!supportedHost || suite.id !== 'android') return supportedHost;
  const properties = join(ROOT, 'apps', 'client', 'android', 'local.properties');
  const configured = existsSync(properties)
    ? readFileSync(properties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1]?.trim()
      ?.replace(/\\:/g, ':').replace(/\\\\/g, '\\').replace(/\\ /g, ' ')
    : undefined;
  const roots = [configured, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'), join(homedir(), 'Library', 'Android', 'sdk'),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Android', 'Sdk')] : [])];
  return roots.some((root) => root != null && existsSync(join(root, 'platforms')));
}
