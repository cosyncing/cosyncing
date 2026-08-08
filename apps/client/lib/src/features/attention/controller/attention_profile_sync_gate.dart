import 'dart:async';

/// Serializes fetch/persist/reconcile cycles per broker profile.
///
/// Resident polling and opaque-wake refetch share this gate so they cannot
/// produce out-of-order responses for one profile. Different profiles remain
/// independent. See `docs/architecture/client-ui.md`.
final class AttentionProfileSyncGate {
  final Map<String, Future<void>> _tails = {};

  /// Runs [operation] after every earlier operation for [profileId] finishes.
  Future<T> run<T>(String profileId, Future<T> Function() operation) async {
    final previous = _tails[profileId] ?? Future<void>.value();
    final release = Completer<void>();
    final tail = previous.then((_) => release.future);
    _tails[profileId] = tail;

    await previous;
    try {
      return await operation();
    } finally {
      release.complete();
      if (identical(_tails[profileId], tail)) {
        unawaited(_tails.remove(profileId));
      }
    }
  }
}

/// Process-wide gate shared by default polling and wake-refetch paths.
final sharedAttentionProfileSyncGate = AttentionProfileSyncGate();
