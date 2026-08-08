import 'dart:async';

import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';

/// Serializes profile-owned side effects with durable incarnation admission.
///
/// Repository compare-and-swap protects the profile row itself, but credentials
/// and the active-profile stores live outside that row. Every application
/// mutation that can touch those resources enters this gate before its first
/// side effect. The queue is deliberately global rather than merely keyed by
/// profile id: active selection is a singleton, so two different profile keys
/// can otherwise publish across one another.
final class BrokerProfileMutationGate {
  /// Creates a mutation gate backed by the durable profile repository.
  BrokerProfileMutationGate(this._repository);

  final BrokerProfileRepository _repository;
  Future<void> _tail = Future<void>.value();

  /// Runs [operation] after re-reading the current durable profile.
  ///
  /// Use this for an add-or-update intent whose meaning is to apply to whatever
  /// incarnation is current when the operation reaches admission.
  Future<T> runForCurrent<T>(
    String profileId,
    Future<T> Function(BrokerProfile? current) operation,
  ) {
    return _serialize(() async {
      final current = await _repository.getById(profileId);
      return operation(current);
    });
  }

  /// Runs [operation] only while [expected] is still the durable incarnation.
  ///
  /// A mismatch is retired before any credential or active-profile side effect
  /// can run.
  Future<T> runForProfile<T>(
    BrokerProfile expected,
    Future<T> Function(BrokerProfile current) operation,
  ) {
    return _serialize(() async {
      final current = await _repository.getById(expected.id);
      if (!_sameIncarnation(current, expected)) {
        throw BrokerProfileRetiredException(expected.id);
      }
      return operation(current!);
    });
  }

  /// Runs [operation] only if [profileId] is still absent at admission.
  Future<T> runForMissing<T>(
    String profileId,
    Future<T> Function() operation,
  ) {
    return _serialize(() async {
      if (await _repository.getById(profileId) != null) {
        throw BrokerProfileRetiredException(profileId);
      }
      return operation();
    });
  }

  /// Serializes a global active-selection operation.
  ///
  /// The callback must perform its own durable reads inside this boundary.
  Future<T> runExclusive<T>(Future<T> Function() operation) {
    return _serialize(operation);
  }

  Future<T> _serialize<T>(Future<T> Function() operation) async {
    final previous = _tail;
    final release = Completer<void>();
    _tail = release.future;

    await previous.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    try {
      return await operation();
    } finally {
      release.complete();
    }
  }
}

bool _sameIncarnation(BrokerProfile? current, BrokerProfile expected) {
  if (current == null || current.id != expected.id) return false;
  final expectedIncarnation = expected.incarnationId;
  final currentIncarnation = current.incarnationId;
  if (expectedIncarnation != null || currentIncarnation != null) {
    return expectedIncarnation == currentIncarnation;
  }

  // Saved production rows always have an incarnation. The fallback keeps
  // legacy/test repositories fail-closed across an endpoint replacement.
  return current.baseUri == expected.baseUri &&
      current.createdAt == expected.createdAt;
}
