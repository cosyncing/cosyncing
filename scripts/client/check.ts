#!/usr/bin/env bun
import { buildReleaseWeb } from './build-web.ts';
import { runClientCommand } from './run-client-command.ts';

// `flutter pub get` runs once, explicitly. Every tool after it would otherwise
// resolve dependencies again on entry — four resolutions per check for one
// unchanged pubspec — so each is told the work is already done.
const commands = [
  ['flutter', 'pub', 'get'],
  ['bun', 'run', '../../scripts/client/tests/test-desktop-build-command.ts'],
  [
    'dart', 'format', '--output=none', '--set-exit-if-changed',
    'lib', 'test', 'tool', 'integration_test', 'test_driver', '../../packages/dart',
  ],
  ['flutter', 'analyze', '--no-pub'],
  ['flutter', 'test', '--no-pub'],
];

for (const command of commands) {
  const exitCode = await runClientCommand(command);
  if (exitCode !== 0) process.exit(exitCode);
}

// The SAME release build `client:build:web` produces, base href and cache stamp
// included. Building it any other way here leaves a differently-shaped artefact
// in build/web — which passes, silently replaces the deployment shape, and
// invalidates anything that reads build/web afterwards.
// `flutter pub get` ran above, and this gate builds the JavaScript release —
// the Wasm dry run only produces compatibility warnings it then discards.
const buildExit = await buildReleaseWeb({ noPub: true, noWasmDryRun: true });
if (buildExit !== 0) process.exit(buildExit);
