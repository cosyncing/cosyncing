import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Persisted active-broker selection key used by app startup hydration.
const String activeBrokerProfileSettingKey = 'active_broker_profile_id';

/// Abstraction for storing the selected broker profile id.
abstract interface class ActiveBrokerProfileStore {
  /// Reads the persisted active broker profile id.
  Future<String?> getActiveProfileId();

  /// Persists the active broker profile id.
  Future<void> setActiveProfileId(String? profileId);

  /// Clears the persisted active broker profile id.
  Future<void> clearActiveProfileId();
}

/// Drift-backed implementation for active broker profile id persistence.
class DriftActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  /// Creates a store backed by [database].
  const DriftActiveBrokerProfileStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<String?> getActiveProfileId() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) => table.key.equals(activeBrokerProfileSettingKey),
            ))
            .getSingleOrNull();
    return row?.value;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    if (profileId == null) {
      await clearActiveProfileId();
      return;
    }

    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: activeBrokerProfileSettingKey,
            value: profileId,
            updatedAt: DateTime.now(),
          ),
        );
  }

  @override
  Future<void> clearActiveProfileId() async {
    await (database.delete(
      database.appSettingRows,
    )..where((table) => table.key.equals(activeBrokerProfileSettingKey))).go();
  }
}

/// Provider for persisted app settings needed by connection startup.
final activeBrokerProfileStoreProvider = Provider<ActiveBrokerProfileStore>((
  ref,
) {
  return DriftActiveBrokerProfileStore(ref.watch(appDatabaseProvider));
});
