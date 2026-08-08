import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Canonical key for local session notification preference in app settings.
const String sessionNotificationEnabledSettingKey =
    'local_session_notifications_enabled';

/// Durable abstraction for local session notification settings.
abstract interface class SessionNotificationSettingsStore {
  /// Returns the persisted local notification preference.
  ///
  /// Missing values default to false.
  Future<bool> getLocalNotificationEnabled();

  /// Persists the local notification preference.
  Future<void> setLocalNotificationEnabled({required bool enabled});
}

/// Drift-backed store for local session notification opt-in.
class DriftSessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  /// Creates the drift-backed settings store.
  DriftSessionNotificationSettingsStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> getLocalNotificationEnabled() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) => table.key.equals(sessionNotificationEnabledSettingKey),
            ))
            .getSingleOrNull();

    if (row == null) {
      return false;
    }

    return row.value.toLowerCase() == 'true';
  }

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: sessionNotificationEnabledSettingKey,
            value: enabled.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for persisted local notification preference settings.
final sessionNotificationSettingsStoreProvider =
    Provider<SessionNotificationSettingsStore>((ref) {
      return DriftSessionNotificationSettingsStore(
        ref.watch(appDatabaseProvider),
      );
    });
