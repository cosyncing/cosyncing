import 'dart:convert';

import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Durable visibility defaults, independent assistant policy and overrides.
class ToolVisibilityPreferences {
  /// Creates a preference snapshot.
  const ToolVisibilityPreferences({
    this.hideByDefault = false,
    this.finalAssistantOnly = false,
    this.overrides = const {},
    this.saveFailed = false,
  });

  /// Visibility inherited by sessions without an override.
  final bool hideByDefault;

  /// Whether intermediate assistant messages are omitted.
  final bool finalAssistantOnly;

  /// Broker-qualified session overrides. True means hidden.
  final Map<String, bool> overrides;

  /// The current intent still needs a durable retry.
  final bool saveFailed;

  /// Copies the snapshot with explicit replacements.
  ToolVisibilityPreferences copyWith({
    bool? hideByDefault,
    bool? finalAssistantOnly,
    Map<String, bool>? overrides,
    bool saveFailed = false,
  }) => ToolVisibilityPreferences(
    hideByDefault: hideByDefault ?? this.hideByDefault,
    finalAssistantOnly: finalAssistantOnly ?? this.finalAssistantOnly,
    overrides: overrides ?? this.overrides,
    saveFailed: saveFailed,
  );
}

/// Durable visibility preference serialization and storage.
class ToolVisibilityStore {
  /// Uses the shared local database.
  ToolVisibilityStore(this.database);

  /// Local settings database.
  final AppDatabase database;
  static const _settingKey = 'tool_visibility_v1';

  /// Reads a valid record; missing or malformed records require migration.
  Future<ToolVisibilityPreferences?> read() async {
    final row = await (database.select(
      database.appSettingRows,
    )..where((t) => t.key.equals(_settingKey))).getSingleOrNull();
    if (row == null) return null;
    try {
      final json = jsonDecode(row.value) as Map<String, dynamic>;
      final overrides = json['overrides'];
      return ToolVisibilityPreferences(
        hideByDefault: json['hide'] == true,
        finalAssistantOnly: json['final'] == true,
        overrides: {
          if (overrides is Map)
            for (final entry in overrides.entries)
              if (entry.key is String && entry.value is bool)
                entry.key as String: entry.value as bool,
        },
      );
    } on Object {
      return null;
    }
  }

  /// Atomically writes the complete preference record.
  Future<void> write(ToolVisibilityPreferences value) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _settingKey,
            value: jsonEncode({
              'hide': value.hideByDefault,
              'final': value.finalAssistantOnly,
              'overrides': value.overrides,
            }),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Shared local visibility store.
final toolVisibilityStoreProvider = Provider<ToolVisibilityStore>(
  (ref) => ToolVisibilityStore(ref.watch(appDatabaseProvider)),
);

/// Unambiguous broker and session identity in the persisted override record.
String toolVisibilitySessionKey(String source, String tool, String sessionId) =>
    jsonEncode([source, tool, sessionId]);
