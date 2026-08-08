import 'dart:math';

import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';

/// In-memory implementation of [BrokerProfileRepository].
///
/// Suitable for Module B testing and development. A Drift-backed
/// implementation will replace this in a later module.
class InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final _profiles = <String, BrokerProfile>{};

  @override
  Future<List<BrokerProfile>> getAll() async {
    final list = _profiles.values.toList()
      ..sort((a, b) {
        final aLastUsedAt = a.lastUsedAt;
        final bLastUsedAt = b.lastUsedAt;

        if (aLastUsedAt != null && bLastUsedAt != null) {
          return bLastUsedAt.compareTo(aLastUsedAt);
        }
        if (aLastUsedAt != null) return -1;
        if (bLastUsedAt != null) return 1;
        return b.createdAt.compareTo(a.createdAt);
      });
    return list;
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    return _profiles[id];
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    final existing = _profiles[profile.id];
    if (existing == null && profile.incarnationId != null) {
      throw BrokerProfileRetiredException(profile.id);
    }
    if (existing != null && existing.incarnationId != profile.incarnationId) {
      throw BrokerProfileRetiredException(profile.id);
    }
    final saved = profile.copyWith(
      incarnationId: existing == null
          ? _newIncarnationId()
          : existing.incarnationId,
    );
    _profiles[profile.id] = saved;
    return saved;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    final existing = _profiles[id];
    if (existing?.incarnationId != incarnationId) return false;
    return _profiles.remove(id) != null;
  }

  static String _newIncarnationId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }
}
