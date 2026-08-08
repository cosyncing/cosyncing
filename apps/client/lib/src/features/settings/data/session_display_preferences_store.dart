import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-setting key for the global tool transcript policy.
const String toolDisplayModeSettingKey = 'tool_display_mode';

/// App-setting key for subagent and automated-exec roster visibility.
const String showBackgroundSessionsSettingKey = 'show_background_sessions';

/// App-setting key for IDE-extension roster visibility.
const String showVscodeSessionsSettingKey = 'show_vscode_sessions';

/// App-setting key for the authoritative roster query window.
const String sessionRosterWindowSettingKey = 'session_roster_window_v1';

/// Durable Part 3 display preferences shared by every platform layout.
abstract interface class SessionDisplayPreferencesStore {
  /// Returns the persisted tool display token, if any.
  Future<String?> getToolDisplayMode();

  /// Persists the tool display token.
  Future<void> setToolDisplayMode(String token);

  /// Whether subagent and automated-exec sessions should be visible.
  Future<bool> getShowBackgroundSessions();

  /// Persists background-session visibility.
  Future<void> setShowBackgroundSessions({required bool show});

  /// Whether human-initiated VS Code sessions should be visible.
  Future<bool> getShowVscodeSessions();

  /// Persists VS Code-session visibility.
  Future<void> setShowVscodeSessions({required bool show});

  /// Persisted roster query-window token (`all`, `1d`, `7d`, or `1m`).
  Future<String?> getSessionRosterWindow();

  /// Persists the roster query-window token.
  Future<void> setSessionRosterWindow(String token);
}

/// Drift-backed [SessionDisplayPreferencesStore].
final class DriftSessionDisplayPreferencesStore
    implements SessionDisplayPreferencesStore {
  /// Creates the store over the shared local database.
  DriftSessionDisplayPreferencesStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

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

  @override
  Future<String?> getToolDisplayMode() => _read(toolDisplayModeSettingKey);

  @override
  Future<void> setToolDisplayMode(String token) =>
      _write(toolDisplayModeSettingKey, token);

  @override
  Future<bool> getShowBackgroundSessions() async =>
      await _read(showBackgroundSessionsSettingKey) == 'true';

  @override
  Future<void> setShowBackgroundSessions({required bool show}) =>
      _write(showBackgroundSessionsSettingKey, show.toString());

  @override
  Future<bool> getShowVscodeSessions() async =>
      await _read(showVscodeSessionsSettingKey) != 'false';

  @override
  Future<void> setShowVscodeSessions({required bool show}) =>
      _write(showVscodeSessionsSettingKey, show.toString());

  @override
  Future<String?> getSessionRosterWindow() =>
      _read(sessionRosterWindowSettingKey);

  @override
  Future<void> setSessionRosterWindow(String token) =>
      _write(sessionRosterWindowSettingKey, token);
}

/// Provider for durable session/transcript display preferences.
final sessionDisplayPreferencesStoreProvider =
    Provider<SessionDisplayPreferencesStore>((ref) {
      return DriftSessionDisplayPreferencesStore(
        ref.watch(appDatabaseProvider),
      );
    });
