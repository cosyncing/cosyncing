import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Prefix for locally archived Session Detail live-state items.
const String sessionLiveStateViewSettingPrefix =
    'session_live_state_archived_v1:';

/// Durable, client-only view preferences for one Session Detail live surface.
abstract interface class SessionLiveStateViewStore {
  /// Loads archived item fingerprints for [sessionKey].
  Future<Map<String, String>> loadArchived(SessionDetailKey sessionKey);

  /// Replaces archived item fingerprints for [sessionKey].
  Future<void> saveArchived(
    SessionDetailKey sessionKey,
    Map<String, String> archived,
  );
}

/// Drift-backed [SessionLiveStateViewStore] over the shared settings table.
final class DriftSessionLiveStateViewStore
    implements SessionLiveStateViewStore {
  /// Creates the store over [database].
  DriftSessionLiveStateViewStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  String _settingKey(SessionDetailKey key) {
    final identity = jsonEncode([key.tool, key.sessionId]);
    return '$sessionLiveStateViewSettingPrefix'
        '${base64Url.encode(utf8.encode(identity))}';
  }

  @override
  Future<Map<String, String>> loadArchived(SessionDetailKey sessionKey) async {
    final row =
        await (database.select(database.appSettingRows)
              ..where((table) => table.key.equals(_settingKey(sessionKey))))
            .getSingleOrNull();
    final value = row?.value;
    if (value == null || value.isEmpty) return const {};
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map) return const {};
      return Map<String, String>.unmodifiable({
        for (final entry in decoded.entries)
          if (entry.key is String && entry.value is String)
            entry.key as String: entry.value as String,
      });
    } on FormatException {
      return const {};
    }
  }

  @override
  Future<void> saveArchived(
    SessionDetailKey sessionKey,
    Map<String, String> archived,
  ) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _settingKey(sessionKey),
            value: jsonEncode(archived),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for locally persisted Session Detail live-state view preferences.
final sessionLiveStateViewStoreProvider = Provider<SessionLiveStateViewStore>((
  ref,
) {
  return DriftSessionLiveStateViewStore(ref.watch(appDatabaseProvider));
});
