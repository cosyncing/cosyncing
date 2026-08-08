import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _remoteWakeEnabledSettingKey = 'attention_remote_wake_enabled';

/// Durable opt-in for provider-routed opaque mobile wakes.
abstract interface class RemoteWakeSettingsStore {
  /// Returns whether remote opaque wake registration is enabled.
  Future<bool> isEnabled();

  /// Persists remote opaque wake consent.
  Future<void> setEnabled({required bool enabled});
}

/// Drift-backed remote wake consent store.
final class DriftRemoteWakeSettingsStore implements RemoteWakeSettingsStore {
  /// Creates a store backed by the app settings table.
  const DriftRemoteWakeSettingsStore(this.database);

  /// App-local database.
  final AppDatabase database;

  @override
  Future<bool> isEnabled() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (row) => row.key.equals(_remoteWakeEnabledSettingKey),
            ))
            .getSingleOrNull();
    return row?.value.toLowerCase() == 'true';
  }

  @override
  Future<void> setEnabled({required bool enabled}) {
    return database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _remoteWakeEnabledSettingKey,
            value: enabled.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Remote wake setting persistence provider.
final remoteWakeSettingsStoreProvider = Provider<RemoteWakeSettingsStore>((
  ref,
) {
  return DriftRemoteWakeSettingsStore(ref.watch(appDatabaseProvider));
});

/// Reconciliation signal after remote wake consent changes.
final remoteWakeSettingsRevisionProvider = StateProvider<int>((_) => 0);
