import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Setting key: routine, non-fork Take-over confirms are suppressed
/// device-wide. A live fork warning is never suppressible.
const String routineTakeoverWarningSuppressedKey =
    'session_fork_takeover_warning_suppressed';

/// Durable store for session-control UX preferences.
///
/// Currently a single opt-out for routine non-fork takeover confirmation.
/// Fork confirmation remains load-bearing and is always shown.
abstract interface class SessionControlPreferencesStore {
  /// Whether routine non-fork Take-over confirmation is suppressed.
  Future<bool> isRoutineTakeoverWarningSuppressed();

  /// Persists the routine-confirmation suppression choice.
  Future<void> setRoutineTakeoverWarningSuppressed({required bool suppressed});
}

/// Drift-backed [SessionControlPreferencesStore] over the settings table.
class DriftSessionControlPreferencesStore
    implements SessionControlPreferencesStore {
  /// Creates the store over [database].
  DriftSessionControlPreferencesStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> isRoutineTakeoverWarningSuppressed() async {
    final row =
        await (database.select(
              database.appSettingRows,
            )..where(
              (table) => table.key.equals(routineTakeoverWarningSuppressedKey),
            ))
            .getSingleOrNull();
    return row?.value == 'true';
  }

  @override
  Future<void> setRoutineTakeoverWarningSuppressed({
    required bool suppressed,
  }) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: routineTakeoverWarningSuppressedKey,
            value: suppressed ? 'true' : 'false',
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for the durable session-control preferences store.
final sessionControlPreferencesStoreProvider =
    Provider<SessionControlPreferencesStore>((ref) {
      return DriftSessionControlPreferencesStore(
        ref.watch(appDatabaseProvider),
      );
    });
