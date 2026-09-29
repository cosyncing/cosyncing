import 'dart:convert';

import 'package:cosyncing_client/src/features/settings/model/conversation_display_preferences.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Durable store boundary for transcript choices.
abstract interface class ConversationDisplayStore {
  /// Loads the persisted choices.
  Future<ConversationDisplayPreferences> read();

  /// Saves a complete preference record.
  Future<void> write(ConversationDisplayPreferences preferences);
}

/// App-local storage; changing display choices makes no broker request.
class DriftConversationDisplayStore implements ConversationDisplayStore {
  /// Creates the store.
  const DriftConversationDisplayStore(this.database);

  /// Shared local settings database.
  final AppDatabase database;
  static const _key = 'conversation_display';

  @override
  Future<ConversationDisplayPreferences> read() async {
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(_key))).getSingleOrNull();
    if (row == null) return const ConversationDisplayPreferences();
    try {
      return ConversationDisplayPreferences.fromJson(
        jsonDecode(row.value) as Map<String, dynamic>,
      );
    } on Object {
      return const ConversationDisplayPreferences();
    }
  }

  @override
  Future<void> write(ConversationDisplayPreferences preferences) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _key,
            value: jsonEncode(preferences.toJson()),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Store seam for tests and the display controller.
final conversationDisplayStoreProvider = Provider<ConversationDisplayStore>(
  (ref) => DriftConversationDisplayStore(ref.watch(appDatabaseProvider)),
);
