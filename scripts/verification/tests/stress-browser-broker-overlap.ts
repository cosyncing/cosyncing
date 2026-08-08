#!/usr/bin/env bun
/** Repeated contention test for the check scheduler's sole bounded overlap. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  loadVerificationGraph,
  sourceFingerprint,
  verificationEnvironment,
} from '../verification-graph.ts';
import { runSupervised } from '../supervised-process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const OUTPUT = join(ROOT, 'output', 'acceptance', 'browser-broker-overlap');
const repeatArg = process.argv[process.argv.indexOf('--repeat') + 1];
const repeat = process.argv.includes('--repeat') ? Number(repeatArg) : 3;
const allowDirty = process.argv.includes('--allow-dirty');
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5) {
  console.error(
    'Usage: bun run test:browser-broker-overlap -- [--repeat 1..5] [--allow-dirty]',
  );
  process.exit(2);
}

const sourceBefore = sourceFingerprint(ROOT);
if (sourceBefore.dirty && !allowDirty) {
  console.error('FAIL browser/broker overlap: source tree must be clean');
  process.exit(1);
}

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });
const environment = verificationEnvironment();
// The broker's optional host-evidence check follows the largest live Codex
// rollout by default. Keep a contention benchmark hermetic: a rollout that is
// actively growing can fail independently of either lane under test.
environment.CODEX_HOME = join(OUTPUT, 'empty-codex-home');
mkdirSync(environment.CODEX_HOME, { recursive: true });
const brokerGate = loadVerificationGraph(ROOT).gates.find(
  (gate) => gate.id === 'broker-deterministic',
);
if (!brokerGate?.subSuites) throw new Error('broker sub-suite inventory is missing');
let failures = 0;
const iterations: Array<{
  iteration: number;
  elapsedMs: number;
  brokerDurationMs: number;
  browserDurationMs: number;
  brokerExitCode: number;
  browserExitCode: number;
  timedOut: number;
  strays: number;
  status: 'pass' | 'fail';
}> = [];

for (let iteration = 1; iteration <= repeat; iteration += 1) {
  const brokerStem = `broker-${iteration}`;
  const browserOut = join(OUTPUT, `browser-${iteration}`);
  for (const previous of [
    join(OUTPUT, `${brokerStem}.json`),
    join(OUTPUT, `${brokerStem}.md`),
    join(OUTPUT, `${brokerStem}-logs`),
    join(OUTPUT, `broker-${iteration}.log`),
    join(OUTPUT, `browser-${iteration}.log`),
    browserOut,
  ]) {
    rmSync(previous, { recursive: true, force: true });
  }
  const started = performance.now();
  const [broker, browser] = await Promise.all([
    runSupervised([
      'bun', 'run', 'test:broker:deterministic',
      '--json', join(OUTPUT, `${brokerStem}.json`),
      '--audit', join(OUTPUT, `${brokerStem}.md`),
      '--logs', join(OUTPUT, `${brokerStem}-logs`),
    ], {
      cwd: ROOT,
      env: environment,
      timeoutMs: 10 * 60_000,
      maxBufferBytes: 32 << 20,
    }),
    runSupervised([
      'bun', 'run', 'test:web-startup-shell:built', '--out', browserOut,
    ], {
      cwd: ROOT,
      env: environment,
      timeoutMs: 5 * 60_000,
      maxBufferBytes: 16 << 20,
    }),
  ]);
  const elapsedMs = Math.round(performance.now() - started);
  for (const [id, result] of [['broker', broker], ['browser', browser]] as const) {
    writeFileSync(
      join(OUTPUT, `${id}-${iteration}.log`),
      `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    );
  }
  const passed = broker.success && !broker.strays
    && browser.success && !browser.strays;
  if (!passed) failures += 1;
  iterations.push({
    iteration,
    elapsedMs,
    brokerDurationMs: broker.durationMs,
    browserDurationMs: browser.durationMs,
    brokerExitCode: broker.exitCode,
    browserExitCode: browser.exitCode,
    timedOut: Number(broker.timedOut) + Number(browser.timedOut),
    strays: Number(broker.strays) + Number(browser.strays),
    status: passed ? 'pass' : 'fail',
  });
  console.log(
    `${passed ? 'PASS' : 'FAIL'} overlap ${iteration}/${repeat} — ${elapsedMs}ms `
      + `broker=${broker.durationMs}ms browser=${browser.durationMs}ms `
      + `exits=${broker.exitCode}/${browser.exitCode} `
      + `timeouts=${Number(broker.timedOut) + Number(browser.timedOut)} `
      + `strays=${Number(broker.strays) + Number(browser.strays)}`,
  );
}

const sourceAfter = sourceFingerprint(ROOT);
const sourceStable = sourceAfter.commit === sourceBefore.commit
  && sourceAfter.dirty === sourceBefore.dirty
  && sourceAfter.sha256 === sourceBefore.sha256;
writeFileSync(
  join(OUTPUT, 'report.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    sourceBefore,
    sourceAfter,
    sourceStable,
    allowDirty,
    brokerSuiteCount: brokerGate.subSuites.length,
    repeat,
    status: failures === 0 && sourceStable ? 'pass' : 'fail',
    iterations,
  }, null, 2)}\n`,
);

if (failures > 0 || !sourceStable) {
  console.error(
    `FAIL browser/broker overlap: ${failures}/${repeat} repetitions failed; `
      + `sourceStable=${sourceStable}`,
  );
  process.exit(1);
}
console.log(
  `PASS ${repeat}/${repeat} browser/broker overlap repetitions `
    + `across all ${brokerGate.subSuites.length} broker suites at ${sourceBefore.commit}`,
);
