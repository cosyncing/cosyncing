#!/usr/bin/env bun
/**
 * Where the Flutter test phase actually spends its time.
 *
 * The phase is the largest single piece of `bun run check`, and the obvious
 * levers — more concurrency, sharding across processes — are the ones most
 * likely to make it slower, because what dominates is compiling each test file
 * rather than running the tests in it. This exists so that is a measurement
 * instead of an assumption, before anyone changes how the phase is scheduled.
 *
 *   bun run client:profile-tests [--concurrency N]
 *
 * Reports per-file spans, how much of each is load/compile, and the summed
 * total against the wall clock, which is the real parallelism already achieved.
 */
import { CLIENT_ROOT } from './run-client-command.ts';

interface Event {
  type?: string;
  time?: number;
  test?: { id: number; name?: string; suiteID?: number };
  testID?: number;
  hidden?: boolean;
  suite?: { id: number; path: string };
}

const concurrencyIndex = process.argv.indexOf('--concurrency');
const concurrency = concurrencyIndex === -1
  ? undefined
  : process.argv[concurrencyIndex + 1];

// Spawned here rather than through `runClientCommand`, which inherits stdio:
// the JSON reporter's stdout *is* the measurement and has to be captured.
const startedAt = performance.now();
const child = Bun.spawn(
  [
    'flutter', 'test', '--no-pub', '--reporter', 'json',
    ...(concurrency ? ['--concurrency', concurrency] : []),
  ],
  { cwd: CLIENT_ROOT, env: process.env, stdout: 'pipe', stderr: 'inherit' },
);
const report = await new Response(child.stdout).text();
const exitCode = await child.exited;
const wallMs = performance.now() - startedAt;
const chunks = [report];

const suitePath = new Map<number, string>();
const suiteOfTest = new Map<number, number>();
const testStart = new Map<number, number>();
const loadTests = new Set<number>();
const span = new Map<number, { from: number; to: number }>();
const tests = new Map<number, number>();
const loadMs = new Map<number, number>();

for (const line of chunks.join('').split('\n')) {
  if (!line.startsWith('{')) continue;
  let event: Event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type === 'suite' && event.suite) {
    suitePath.set(event.suite.id, event.suite.path);
  } else if (event.type === 'testStart' && event.test) {
    suiteOfTest.set(event.test.id, event.test.suiteID ?? -1);
    testStart.set(event.test.id, event.time ?? 0);
    // The runner models compiling and loading a file as a hidden "loading …"
    // test, which is exactly the number worth separating out.
    if (event.test.name?.startsWith('loading ')) loadTests.add(event.test.id);
  } else if (event.type === 'testDone' && event.testID !== undefined) {
    const suite = suiteOfTest.get(event.testID);
    if (suite === undefined) continue;
    const from = testStart.get(event.testID) ?? event.time ?? 0;
    const to = event.time ?? from;
    const current = span.get(suite) ?? { from, to };
    span.set(suite, { from: Math.min(current.from, from), to: Math.max(current.to, to) });
    if (loadTests.has(event.testID)) {
      loadMs.set(suite, (loadMs.get(suite) ?? 0) + (to - from));
    } else if (!event.hidden) {
      tests.set(suite, (tests.get(suite) ?? 0) + 1);
    }
  }
}

const rows = [...span.entries()]
  .map(([suite, { from, to }]) => ({
    path: suitePath.get(suite) ?? '<unknown>',
    spanMs: to - from,
    loadMs: loadMs.get(suite) ?? 0,
    tests: tests.get(suite) ?? 0,
  }))
  .sort((left, right) => right.spanMs - left.spanMs);

const summed = rows.reduce((total, row) => total + row.spanMs, 0);
const load = rows.reduce((total, row) => total + row.loadMs, 0);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

console.log(
  `${rows.length} files | summed ${seconds(summed)} | wall ${seconds(wallMs)} `
    + `| effective parallelism ${(summed / wallMs).toFixed(1)}x`,
);
console.log(
  `load/compile ${seconds(load)} = ${Math.round((load / summed) * 100)}% of summed file time`,
);
console.log('\nslowest files (span | tests | load):');
for (const row of rows.slice(0, 15)) {
  const name = row.path.split('/test/').at(-1);
  console.log(
    `  ${seconds(row.spanMs).padStart(7)} ${String(row.tests).padStart(4)}t `
      + `${seconds(row.loadMs).padStart(6)}  ${name}`,
  );
}
process.exit(exitCode);
