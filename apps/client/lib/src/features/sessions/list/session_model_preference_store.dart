import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Durable scope for a model selection across native continue/fork ids.
@immutable
final class SessionModelPreferenceKey {
  /// Creates a model preference scope.
  const SessionModelPreferenceKey({
    required this.brokerProfileId,
    required this.tool,
    required this.lineageId,
  });

  /// Broker scope key (`RosterSource.storageKey`) of the owning broker.
  /// Profile AND endpoint, so a preference for one broker's lineage never
  /// preselects a model for an identically-named lineage on the machine the
  /// profile was later re-pointed at.
  final String brokerProfileId;

  /// Broker adapter id.
  final String tool;

  /// Stable broker-published lineage id, or the session id fallback.
  final String lineageId;

  @override
  bool operator ==(Object other) =>
      other is SessionModelPreferenceKey &&
      other.brokerProfileId == brokerProfileId &&
      other.tool == tool &&
      other.lineageId == lineageId;

  @override
  int get hashCode => Object.hash(brokerProfileId, tool, lineageId);
}

/// Persistence boundary for exact typed model selections.
abstract interface class SessionModelPreferenceStore {
  /// Loads the last exact selection for [key].
  Future<SessionCurrentModel?> load(SessionModelPreferenceKey key);

  /// Saves one exact broker model id and effort selection.
  Future<void> save(
    SessionModelPreferenceKey key,
    SessionCurrentModel model,
  );

  /// Clears a saved selection.
  Future<void> clear(SessionModelPreferenceKey key);

  /// Loads the per-tool fallback that seeds new sessions.
  ///
  /// Unlike the lineage-scoped [load], this scope deliberately crosses
  /// conversation boundaries: it answers "which model was last picked for this
  /// tool on this broker" so a brand-new session can inherit it.
  Future<SessionCurrentModel?> loadToolDefault({
    required String brokerProfileId,
    required String tool,
  });

  /// Saves the per-tool fallback that seeds new sessions.
  Future<void> saveToolDefault({
    required String brokerProfileId,
    required String tool,
    required SessionCurrentModel model,
  });
}

/// Drift-backed preferences over the existing app settings KV table.
final class DriftSessionModelPreferenceStore
    implements SessionModelPreferenceStore {
  /// Creates the store.
  const DriftSessionModelPreferenceStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<SessionCurrentModel?> load(SessionModelPreferenceKey key) =>
      _loadBySettingKey(_settingKey(key));

  @override
  Future<void> save(
    SessionModelPreferenceKey key,
    SessionCurrentModel model,
  ) => _saveBySettingKey(_settingKey(key), model);

  @override
  Future<void> clear(SessionModelPreferenceKey key) async {
    await (database.delete(
      database.appSettingRows,
    )..where((table) => table.key.equals(_settingKey(key)))).go();
  }

  @override
  Future<SessionCurrentModel?> loadToolDefault({
    required String brokerProfileId,
    required String tool,
  }) => _loadBySettingKey(_toolDefaultSettingKey(brokerProfileId, tool));

  @override
  Future<void> saveToolDefault({
    required String brokerProfileId,
    required String tool,
    required SessionCurrentModel model,
  }) => _saveBySettingKey(_toolDefaultSettingKey(brokerProfileId, tool), model);

  Future<SessionCurrentModel?> _loadBySettingKey(String settingKey) async {
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(settingKey))).getSingleOrNull();
    final value = row?.value;
    if (value == null || value.isEmpty) return null;
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map) return null;
      final model = SessionCurrentModel.fromJson(
        decoded.cast<String, dynamic>(),
      );
      if (model.providerID.trim().isEmpty || model.modelID.trim().isEmpty) {
        return null;
      }
      return model;
    } on Object {
      return null;
    }
  }

  Future<void> _saveBySettingKey(
    String settingKey,
    SessionCurrentModel model,
  ) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: settingKey,
            value: jsonEncode(model.toJson()),
            updatedAt: DateTime.now(),
          ),
        );
  }

  static String _settingKey(SessionModelPreferenceKey key) =>
      'session_model_preference:'
      '${Uri.encodeComponent(key.brokerProfileId)}:'
      '${Uri.encodeComponent(key.tool)}:'
      '${Uri.encodeComponent(key.lineageId)}';

  // A distinct prefix, not a sentinel lineage segment: a per-tool default must
  // never collide with — or be cleared alongside — a lineage-scoped row.
  static String _toolDefaultSettingKey(String brokerProfileId, String tool) =>
      'session_model_default:'
      '${Uri.encodeComponent(brokerProfileId)}:'
      '${Uri.encodeComponent(tool)}';
}

/// Provider for lineage-scoped model preferences.
final sessionModelPreferenceStoreProvider =
    Provider<SessionModelPreferenceStore>((ref) {
      return DriftSessionModelPreferenceStore(ref.watch(appDatabaseProvider));
    });
