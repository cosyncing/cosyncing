import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Canonical key for local session notification preference in app settings.
const String sessionNotificationEnabledSettingKey =
    'local_session_notifications_enabled';

/// Set once this device has shown the OS permission prompt.
const String sessionNotificationPermissionPromptedSettingKey =
    'local_session_notifications_permission_prompted';

/// Durable abstraction for local session notification settings.
abstract interface class SessionNotificationSettingsStore {
  /// Returns the persisted local notification preference.
  ///
  /// Missing values default to false.
  Future<bool> getLocalNotificationEnabled();

  /// The explicit choice, or null when the user has never chosen (the
  /// first-run card offers the choice exactly then).
  Future<bool?> getLocalNotificationPreference();

  /// Persists the local notification preference.
  Future<void> setLocalNotificationEnabled({required bool enabled});

  /// Whether this device has already shown the OS permission prompt. Android
  /// and Darwin report only "not enabled", so a prompt shown before turns
  /// that into "denied".
  Future<bool> getPermissionPrompted();

  /// Records that the OS permission prompt was shown.
  Future<void> setPermissionPrompted();
}

/// Drift-backed store for local session notification opt-in.
class DriftSessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  /// Creates the drift-backed settings store.
  DriftSessionNotificationSettingsStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> getLocalNotificationEnabled() async =>
      await getLocalNotificationPreference() ?? false;

  @override
  Future<bool?> getLocalNotificationPreference() async {
    final value = await _read(sessionNotificationEnabledSettingKey);
    if (value == null) return null;
    return value.toLowerCase() == 'true';
  }

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) =>
      _write(sessionNotificationEnabledSettingKey, enabled.toString());

  @override
  Future<bool> getPermissionPrompted() async =>
      (await _read(sessionNotificationPermissionPromptedSettingKey)) == 'true';

  @override
  Future<void> setPermissionPrompted() =>
      _write(sessionNotificationPermissionPromptedSettingKey, 'true');

  Future<String?> _read(String key) async {
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(key))).getSingleOrNull();
    return row?.value;
  }

  Future<void> _write(String key, String value) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: key,
            value: value,
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
