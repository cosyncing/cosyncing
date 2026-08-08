import 'dart:js_interop';

import 'package:broker_contract/broker_contract.dart';

const String _sourceCommit = String.fromEnvironment(
  'COSYNCING_CLIENT_SOURCE_COMMIT',
  defaultValue: 'unknown',
);
const bool _sourceDirty = bool.fromEnvironment(
  'COSYNCING_CLIENT_SOURCE_DIRTY',
  defaultValue: true,
);

@JS('cosyncingExecutingClientBuildIdentity')
external set _executingClientBuildIdentity(JSAny? value);

/// Publishes compile-time provenance for the Dart bundle executing in this tab.
///
/// The service worker reports which cache owns the document. This independent
/// marker is assigned by compiled Dart before `runApp`, so browser diagnostics
/// can prove that a post-update tab is executing the matching client bundle
/// rather than merely being controlled by the matching worker.
void publishExecutingClientBuildIdentity() {
  try {
    _executingClientBuildIdentity = <String, Object?>{
      'schemaVersion': 1,
      'product': 'cosyncing',
      'version': cosyncingClientVersion,
      'sourceCommit': _sourceCommit,
      'dirty': _sourceDirty,
      'contract': <String, Object?>{
        'revision': cosyncingClientContractRevision,
        'minimumBrokerRevision': cosyncingClientMinimumBrokerRevision,
        'surfaceHash': cosyncingClientContractSurfaceHash,
      },
    }.jsify();
  } on Object {
    // Diagnostics must never become a startup dependency.
  }
}
