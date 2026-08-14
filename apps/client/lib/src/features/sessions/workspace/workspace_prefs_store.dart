import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Setting key for the Expanded workspace roster pane width, in logical pixels.
const String workspaceRosterPaneWidthKey = 'workspace.rosterPaneWidth';

/// Setting key for whether the Expanded workspace roster is collapsed.
const String workspaceRosterCollapsedKey = 'workspace.rosterCollapsed';

/// Width restored when a collapsed flag was persisted without a usable width
/// (a half-written or corrupt record). Mirrors the workspace's default split.
const double workspaceDefaultRosterWidth = 320;

/// A restored roster split preference: how wide the roster is, and whether the
/// user closed it.
@immutable
class WorkspaceRosterPrefs {
  /// Creates a roster split preference.
  const WorkspaceRosterPrefs({required this.width, required this.collapsed});

  /// Roster pane width in logical pixels. Meaningful even while [collapsed],
  /// where it is the width to restore when the roster is reopened.
  final double width;

  /// Whether the roster is closed.
  final bool collapsed;

  @override
  bool operator ==(Object other) =>
      other is WorkspaceRosterPrefs &&
      other.width == width &&
      other.collapsed == collapsed;

  @override
  int get hashCode => Object.hash(width, collapsed);

  @override
  String toString() =>
      'WorkspaceRosterPrefs(width: $width, collapsed: $collapsed)';
}

/// Durable store for the Expanded workspace's roster split geometry.
///
/// [loadRoster] returns null when nothing has ever been persisted. That null is
/// load-bearing: it lets the workspace tell a genuine first run — which opens
/// with the roster closed — apart from a user who has since chosen a width.
///
/// Scope is the Expanded size class only; Compact/Medium never read these keys.
abstract interface class WorkspacePrefsStore {
  /// Loads the saved roster split, or null if the user has never set one.
  Future<WorkspaceRosterPrefs?> loadRoster();

  /// Persists the roster split.
  Future<void> saveRoster(WorkspaceRosterPrefs prefs);
}

/// Drift-backed [WorkspacePrefsStore] over the shared app settings KV table.
class DriftWorkspacePrefsStore implements WorkspacePrefsStore {
  /// Creates the store over [database].
  DriftWorkspacePrefsStore(this.database);

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
  Future<WorkspaceRosterPrefs?> loadRoster() async {
    final widthValue = await _read(workspaceRosterPaneWidthKey);
    final collapsedValue = await _read(workspaceRosterCollapsedKey);
    if (widthValue == null && collapsedValue == null) return null;
    final width = double.tryParse(widthValue ?? '');
    return WorkspaceRosterPrefs(
      width: width ?? workspaceDefaultRosterWidth,
      collapsed: collapsedValue == 'true',
    );
  }

  @override
  Future<void> saveRoster(WorkspaceRosterPrefs prefs) async {
    await _write(workspaceRosterPaneWidthKey, prefs.width.toString());
    await _write(
      workspaceRosterCollapsedKey,
      prefs.collapsed ? 'true' : 'false',
    );
  }
}

/// Provider for the durable workspace layout preferences store.
final workspacePrefsStoreProvider = Provider<WorkspacePrefsStore>((ref) {
  return DriftWorkspacePrefsStore(ref.watch(appDatabaseProvider));
});
