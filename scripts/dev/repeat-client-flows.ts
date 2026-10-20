#!/usr/bin/env bun
/** Repeat selected Flutter journeys without retries, using the CI supervisor.
 * Run from the root after client preparation:
 * PATH=/snap/bin:$PATH bun run scripts/dev/repeat-client-flows.ts --repeat 10 \
 *   test/features/approvals_test.dart --plain-name 'phone question'
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runSupervised, signalSupervisedGroups, testEnvironment } from '../ci/lib/process.ts';

const args = Bun.argv.slice(2);
const repeats = Number(args[1]);
if (args[0] !== '--repeat' || !Number.isInteger(repeats) || repeats < 1 || repeats > 50 || args.length < 3) {
  console.error('Usage: repeat-client-flows.ts --repeat N FILE... [flutter test flags]');
  process.exit(2);
}
const root = resolve(import.meta.dir, '../..');
const output = resolve(process.env.COSYNCING_FLOW_REPEAT_OUTPUT ?? join(root, 'output/repeat-client-flows'));
mkdirSync(output, { recursive: true });
const flutter = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
const command = [flutter, 'test', '--no-pub', ...args.slice(2)];
const results: Record<string, unknown>[] = [];
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      signalSupervisedGroups('SIGKILL');
      return;
    }
    stopping = true;
    signalSupervisedGroups(signal);
    setTimeout(() => signalSupervisedGroups('SIGKILL'), 5_000).unref();
  });
}
for (let iteration = 1; iteration <= repeats; iteration++) {
  const result = await runSupervised(command, {
    cwd: join(root, 'apps/client'),
    env: testEnvironment(),
    timeoutMs: 180_000,
  });
  writeFileSync(join(output, `run-${iteration}.log`), result.output);
  results.push({
    iteration, passed: result.success, durationMs: result.durationMs,
    exitCode: result.exitCode, timedOut: result.timedOut, strays: result.strays,
  });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ command, repeats, results }, null, 2) + '\n');
  console.log(`${result.success ? 'PASS' : 'FAIL'} run ${iteration}/${repeats} (${(result.durationMs / 1000).toFixed(1)}s)`);
  if (!result.success || stopping) {
    console.error(`Evidence: ${output}`);
    process.exit(1);
  }
}
