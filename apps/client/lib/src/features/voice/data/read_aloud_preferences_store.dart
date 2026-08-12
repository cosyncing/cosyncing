import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-setting key for the device-local read-aloud speed multiplier.
const String readAloudRateSettingKey = 'read_aloud_rate';

/// Durable device-local storage for read-aloud preferences.
abstract interface class ReadAloudPreferencesStore {
  /// Persisted rate multiplier, or null when unset.
  Future<String?> getRate();

  /// Persists a supported rate multiplier.
  Future<void> setRate(double rate);
}

/// Drift-backed read-aloud preferences over the shared app settings table.
final class DriftReadAloudPreferencesStore
    implements ReadAloudPreferencesStore {
  /// Creates the store over [database].
  DriftReadAloudPreferencesStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<String?> getRate() async {
    final row =
        await (database.select(
              database.appSettingRows,
            )..where((table) => table.key.equals(readAloudRateSettingKey)))
            .getSingleOrNull();
    return row?.value;
  }

  @override
  Future<void> setRate(double rate) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: readAloudRateSettingKey,
            value: rate.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for durable read-aloud preferences.
final readAloudPreferencesStoreProvider = Provider<ReadAloudPreferencesStore>(
  (ref) => DriftReadAloudPreferencesStore(ref.watch(appDatabaseProvider)),
);
