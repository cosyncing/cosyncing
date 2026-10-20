import 'dart:convert';

import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Chosen quota providers in stable order, private to this broker and device.
final overviewQuotaPreferencesProvider =
    AsyncNotifierProvider<OverviewQuotaPreferences, List<String>>(
      OverviewQuotaPreferences.new,
    );

/// Stores provider choices in the existing local settings table.
class OverviewQuotaPreferences extends AsyncNotifier<List<String>> {
  String? _key;
  int _generation = 0;
  Future<void> _tail = Future<void>.value();

  @override
  Future<List<String>> build() async {
    _generation++;
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    _key = source == null
        ? null
        : 'workspace.quotaProviders.v1:${source.storageKey}';
    if (_key == null) return const [];
    final database = ref.watch(appDatabaseProvider);
    final key = _key!;
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(key))).getSingleOrNull();
    if (row == null) return const [];
    try {
      final value = jsonDecode(row.value);
      return value is List
          ? value
                .whereType<String>()
                .where((id) => id.isNotEmpty)
                .toSet()
                .toList()
          : const [];
    } on FormatException {
      return const [];
    }
  }

  /// Writes a selection once, serializing concurrent saves and fencing sources.
  Future<void> save(List<String> providers) {
    final key = _key;
    final generation = _generation;
    final database = ref.read(appDatabaseProvider);
    final values = providers.toSet().toList();
    final operation = _tail.then((_) async {
      if (key == null || generation != _generation) return;
      await database
          .into(database.appSettingRows)
          .insertOnConflictUpdate(
            AppSettingRowsCompanion.insert(
              key: key,
              value: jsonEncode(values),
              updatedAt: DateTime.now(),
            ),
          );
      if (generation == _generation) state = AsyncData(values);
    });
    _tail = operation.catchError((Object _) {});
    return operation;
  }
}
