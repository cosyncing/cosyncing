import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App setting: the Android update version whose popup was last closed.
const String androidUpdatePromptDismissedSettingKey =
    'android_update_prompt_dismissed_version';

/// Which Android update the user has already been offered and closed.
///
/// One version, not a list: a newer release replaces the older one, so only
/// the latest closed offer can still suppress a popup.
abstract interface class AndroidUpdatePromptStore {
  /// The version whose popup was closed, or null when none was.
  Future<String?> dismissedVersion();

  /// Records that the popup for [version] was closed.
  Future<void> setDismissedVersion(String version);
}

/// Drift-backed [AndroidUpdatePromptStore].
class DriftAndroidUpdatePromptStore implements AndroidUpdatePromptStore {
  /// Creates the store over [database].
  DriftAndroidUpdatePromptStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<String?> dismissedVersion() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) =>
                  table.key.equals(androidUpdatePromptDismissedSettingKey),
            ))
            .getSingleOrNull();
    return row?.value;
  }

  @override
  Future<void> setDismissedVersion(String version) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: androidUpdatePromptDismissedSettingKey,
            value: version,
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Persisted Android update popup store.
final androidUpdatePromptStoreProvider = Provider<AndroidUpdatePromptStore>(
  (ref) => DriftAndroidUpdatePromptStore(ref.watch(appDatabaseProvider)),
);
