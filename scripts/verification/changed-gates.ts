/** Safe path ownership for the opt-in changed repository check. */

export const ALWAYS_CHANGED_GATES = [
  'verification-inventory',
  'diff-hygiene',
  'public-tree',
  'public-tree-policy',
  'source-boundaries',
] as const;

const APP_GATES = [
  'client',
  'web-browser',
  'web-cache',
  'web-update-handoff',
] as const;

const DART_GATES = {
  brokerContract: [
    'dart-broker-contract-dependencies',
    'dart-broker-contract-analyze',
    'dart-broker-contract-test',
  ],
  brokerClient: [
    'dart-broker-client-dependencies',
    'dart-broker-client-analyze',
    'dart-broker-client-test',
  ],
  brokerClientFlutter: [
    'dart-broker-client-flutter-dependencies',
    'dart-broker-client-flutter-analyze',
    'dart-broker-client-flutter-test',
  ],
  brokerCrypto: [
    'dart-broker-crypto-dependencies',
    'dart-broker-crypto-analyze',
    'dart-broker-crypto-test',
  ],
} as const;

/**
 * Maps changed paths to their owning gates and every local Dart consumer.
 *
 * This is the explicit reverse closure of the path dependencies in pubspec:
 * broker_contract -> broker_client -> broker_client_flutter -> app,
 * broker_contract -> broker_client_flutter -> app, and broker_crypto -> app.
 * Unknown or cross-cutting inputs return null so the caller runs every gate.
 */
export function gatesForChangedPaths(paths: string[]): Set<string> | null {
  const selected = new Set<string>(ALWAYS_CHANGED_GATES);
  const add = (...ids: readonly string[]): void => {
    for (const id of ids) selected.add(id);
  };
  for (const path of paths) {
    if (
      path === 'package.json' || path === 'bun.lock' || path === 'tsconfig.json'
      || path.startsWith('scripts/verification/') || path === 'scripts/check.ts'
    ) return null;
    // Workflows are executable release inputs. Broker evidence tests inspect
    // them directly, and future workflow consumers are not safely attributable
    // from the path alone, so changed mode must fall back to complete coverage.
    if (path.startsWith('.github/')) return null;
    if (path.startsWith('scripts/ci/')) {
      add('workflow-policy');
      continue;
    }
    if (path.startsWith('apps/client/') || path.startsWith('scripts/client/')) {
      add(...APP_GATES);
      continue;
    }
    if (path.startsWith('packages/dart/broker_contract/')) {
      add(
        ...DART_GATES.brokerContract,
        ...DART_GATES.brokerClient,
        ...DART_GATES.brokerClientFlutter,
        ...APP_GATES,
      );
      continue;
    }
    if (path.startsWith('packages/dart/broker_client_flutter/')) {
      add(...DART_GATES.brokerClientFlutter, ...APP_GATES);
      continue;
    }
    if (path.startsWith('packages/dart/broker_client/')) {
      add(...DART_GATES.brokerClient, ...DART_GATES.brokerClientFlutter, ...APP_GATES);
      continue;
    }
    if (path.startsWith('packages/dart/broker_crypto/')) {
      add(...DART_GATES.brokerCrypto, ...APP_GATES);
      continue;
    }
    if (path.startsWith('scripts/broker/tests_traces/')) {
      add('broker-deterministic', 'trace-manifest', 'support-matrix');
      continue;
    }
    if (path.startsWith('scripts/broker/capabilities/')) {
      add('broker-deterministic', 'capabilities', 'support-matrix');
      continue;
    }
    if (path.startsWith('packages/typescript/') || path.startsWith('scripts/broker/')) {
      add('broker-deterministic');
      continue;
    }
    if (path.startsWith('contracts/') || path.startsWith('scripts/contracts/')) {
      add('contract', 'contract-history', 'broker-deterministic', 'client');
      continue;
    }
    // Documentation includes generated release claims such as the adapter
    // support matrix. Treat ambiguous prose/Markdown inputs conservatively;
    // skipping them is not safely attributable.
    if (path.startsWith('docs') || path.endsWith('.md')) return null;
    return null;
  }
  return selected;
}
