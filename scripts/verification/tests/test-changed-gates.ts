#!/usr/bin/env bun
import { join } from 'node:path';
import { gatesForChangedPaths } from '../changed-gates.ts';
import {
  allowsBrowserBrokerOverlap,
  fillSchedulingBatch,
  STRAY_GRACE_MS,
  strayGraceMsFor,
} from '../check-scheduler-policy.ts';
import { loadVerificationGraph } from '../verification-graph.ts';

let checks = 0;

function checkIncludes(path: string, expected: string[]): void {
  checks += 1;
  const selected = gatesForChangedPaths([path]);
  if (!selected || expected.some((id) => !selected.has(id))) {
    throw new Error(`${path} omitted downstream gates: ${expected.filter((id) => !selected?.has(id)).join(', ')}`);
  }
}

function checkCompleteFallback(path: string): void {
  checks += 1;
  if (gatesForChangedPaths([path]) !== null) {
    throw new Error(`${path} must fall back to the complete check`);
  }
}

const app = ['client', 'web-browser', 'web-cache', 'web-update-handoff'];
const client = [
  'dart-broker-client-dependencies',
  'dart-broker-client-analyze',
  'dart-broker-client-test',
];
const clientFlutter = [
  'dart-broker-client-flutter-dependencies',
  'dart-broker-client-flutter-analyze',
  'dart-broker-client-flutter-test',
];

checkIncludes('scripts/ci/check-public-tree.rb', ['public-tree', 'public-tree-policy']);
checkIncludes('scripts/ci/tests/test-public-tree-policy.rb', ['public-tree-policy']);
checkIncludes('packages/dart/broker_contract/lib/model.dart', [
  'dart-broker-contract-dependencies',
  'dart-broker-contract-analyze',
  'dart-broker-contract-test',
  ...client,
  ...clientFlutter,
  ...app,
]);
checkIncludes('packages/dart/broker_client/lib/client.dart', [...client, ...clientFlutter, ...app]);
checkIncludes('packages/dart/broker_client_flutter/lib/store.dart', [...clientFlutter, ...app]);
checkIncludes('packages/dart/broker_crypto/lib/crypto.dart', [
  'dart-broker-crypto-dependencies',
  'dart-broker-crypto-analyze',
  'dart-broker-crypto-test',
  ...app,
]);
checkIncludes('scripts/broker/tests_traces/trace-manifest.ts', [
  'broker-deterministic',
  'trace-manifest',
  'support-matrix',
]);
checkIncludes('scripts/broker/capabilities/manifests/codex.json', [
  'broker-deterministic',
  'capabilities',
  'support-matrix',
]);
checkCompleteFallback('docs/protocol/adapter-support.md');
checkCompleteFallback('.github/workflows/release.yml');

checkCompleteFallback('unknown-root-input.txt');

function checkPolicy(
  description: string,
  expected: boolean,
  candidate: string,
  running: string[],
  concurrency = 4,
): void {
  checks += 1;
  const actual = allowsBrowserBrokerOverlap(candidate, running, concurrency);
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual}`);
  }
}

checkPolicy('browser may not join broker', false, 'web-browser', ['broker-deterministic']);
checkPolicy('broker may not join browser', false, 'broker-deterministic', ['web-browser']);
checkPolicy('a third gate may not join broker', false, 'web-cache', ['broker-deterministic']);
checkPolicy('a third gate may not join browser', false, 'client', ['web-browser']);
checkPolicy(
  'browser may not join broker plus a third gate',
  false,
  'web-browser',
  ['broker-deterministic', 'web-cache'],
);
checkPolicy(
  'broker may not join browser plus a third gate',
  false,
  'broker-deterministic',
  ['web-browser', 'web-cache'],
);
checkPolicy('client may not join broker', false, 'client', ['broker-deterministic']);
checkPolicy('concurrency one disables overlap', false, 'web-browser', ['broker-deterministic'], 1);

checks += 1;
{
  const launchOrder = ['web-browser', 'broker-deterministic'];
  const started = new Set<string>();
  const running = new Set<string>();
  const launched = fillSchedulingBatch(
    launchOrder,
    () => running.size < 2,
    (candidate) => {
      if (started.has(candidate)) return false;
      if (candidate === 'web-browser' && running.size === 0) return false;
      if (candidate === 'broker-deterministic') return running.size === 0;
      return allowsBrowserBrokerOverlap(candidate, running, 2);
    },
    (candidate) => {
      started.add(candidate);
      running.add(candidate);
    },
  );
  if (launched.length !== 1 || launched[0] !== 'broker-deterministic') {
    throw new Error(
      `one scheduling batch did not serialize browser behind broker: ${launched.join(', ')}`,
    );
  }
}

function checkStrayGrace(description: string, expected: number, command: string[]): void {
  checks += 1;
  const actual = strayGraceMsFor(command);
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual} for ${command.join(' ')}`);
  }
}

// The grace is opt-in per gate, so the matcher is read against the real gate commands: a matcher that
// only agrees with a command literal typed here would silently stop covering a gate that was retitled.
{
  const gates = loadVerificationGraph(join(import.meta.dir, '../../..')).gates;
  const gateCommand = (id: string): string[] => {
    const gate = gates.find((item) => item.id === id);
    if (!gate) throw new Error(`missing gate ${id}`);
    return gate.command;
  };
  checkStrayGrace('the browser gate gets the grace', STRAY_GRACE_MS, gateCommand('web-browser'));
  checkStrayGrace('an analyze gate keeps the grace', STRAY_GRACE_MS,
    gateCommand('dart-broker-client-analyze'));
  checkStrayGrace('the broker gate gets no grace', 0, gateCommand('broker-deterministic'));
  checkStrayGrace('the web-cache gate gets no grace', 0, gateCommand('web-cache'));
}
checkStrayGrace('a dart command that is not analyze gets no grace', 0, ['dart', 'test']);
checkStrayGrace('an unrelated bun script gets no grace', 0, ['bun', 'run', 'test:broker-doctor']);

console.log(`PASS ${checks}/${checks} changed-gate and scheduler-policy checks`);
