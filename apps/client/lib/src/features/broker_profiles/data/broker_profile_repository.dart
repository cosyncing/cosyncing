import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';

/// A profile mutation admitted by an incarnation that has been retired.
final class BrokerProfileRetiredException implements Exception {
  /// Creates a retired-write result for [profileId].
  const BrokerProfileRetiredException(this.profileId);

  /// Stable profile id whose expected incarnation no longer exists.
  final String profileId;

  @override
  String toString() => 'Broker profile mutation belongs to a retired row';
}

/// Abstract repository for persisting and retrieving [BrokerProfile]s.
///
/// The in-memory implementation is sufficient for Module B. A Drift-backed
/// implementation will replace it in a later module.
abstract class BrokerProfileRepository {
  /// Returns all saved profiles, ordered by [BrokerProfile.lastUsedAt]
  /// descending (most recently used first).
  Future<List<BrokerProfile>> getAll();

  /// Returns a profile by [id], or `null` if not found.
  Future<BrokerProfile?> getById(String id);

  /// Saves (creates or updates) a profile.
  ///
  /// New profiles must have no incarnation. Updates compare-and-swap the
  /// caller's incarnation against the durable row.
  ///
  /// Returns the canonical saved row. On first save this includes the
  /// repository-assigned incarnation id.
  Future<BrokerProfile> save(BrokerProfile profile);

  /// Deletes the exact profile incarnation.
  ///
  /// Returns `true` if that incarnation was deleted. A missing id or a
  /// replacement incarnation returns `false`.
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  });
}
