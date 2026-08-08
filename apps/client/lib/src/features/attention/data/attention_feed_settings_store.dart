import 'dart:convert';

import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _attentionFeedEnabledSettingPrefix =
    'attention_feed_enabled_profile:';

/// Repository for per-profile attention feed settings.
///
/// The durable feed is **on by default**: a saved broker profile is polled
/// unless the user explicitly turned its feed off in Settings → Notifications.
/// The feed only fills the local inbox and the unread badge — OS notification
/// *presentation* stays behind its own explicit opt-in
/// (`sessionNotificationSinkProvider` is a no-op until then), so default-on
/// polling never notifies. Opt-in polling shipped first and meant the
/// attention badge never lit for anyone who had not found the setting.
abstract interface class AttentionFeedSettingsStore {
  /// Returns whether the attention feed is enabled for [brokerProfileId].
  ///
  /// Missing values default to true (default-on, explicit opt-out).
  Future<bool> isFeedEnabled(String brokerProfileId);

  /// Persists whether the attention feed is enabled for [brokerProfileId].
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  });

  /// Returns all profile ids whose attention feed was explicitly disabled.
  ///
  /// Callers derive the enabled set as "saved profiles minus this list"; the
  /// store cannot enumerate enabled profiles itself because missing rows are
  /// enabled by default.
  Future<List<String>> listDisabledProfileIds();
}

/// Drift-backed, per-profile attention feed settings.
class DriftAttentionFeedSettingsStore implements AttentionFeedSettingsStore {
  /// Creates a settings store backed by [database].
  const DriftAttentionFeedSettingsStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> isFeedEnabled(String brokerProfileId) async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (row) => row.key.equals(_buildSettingKey(brokerProfileId)),
            ))
            .getSingleOrNull();
    if (row == null) {
      return true;
    }

    return row.value.toLowerCase() == 'true';
  }

  @override
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) {
    if (brokerProfileId.isEmpty) {
      throw ArgumentError.value(
        brokerProfileId,
        'brokerProfileId',
        'must not be empty',
      );
    }
    return database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _buildSettingKey(brokerProfileId),
            value: enabled.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }

  @override
  Future<List<String>> listDisabledProfileIds() async {
    final rows = await database.select(database.appSettingRows).get();
    return rows
        .where(
          (row) =>
              row.key.startsWith(_attentionFeedEnabledSettingPrefix) &&
              row.value.toLowerCase() != 'true',
        )
        .map((row) => row.key)
        .map(_decodeProfileIdFromSettingKey)
        .where((value) => value != null)
        .whereType<String>()
        .toList(growable: false);
  }

  String _buildSettingKey(String brokerProfileId) {
    final encoded = base64Url
        .encode(utf8.encode(brokerProfileId))
        .replaceAll('=', '');
    return '$_attentionFeedEnabledSettingPrefix$encoded';
  }

  String? _decodeProfileIdFromSettingKey(String key) {
    if (!key.startsWith(_attentionFeedEnabledSettingPrefix)) {
      return null;
    }

    final encoded = key.substring(_attentionFeedEnabledSettingPrefix.length);
    if (encoded.isEmpty) {
      return null;
    }
    final padded = _normalizeBase64Padding(encoded);
    try {
      final bytes = base64Url.decode(padded);
      return utf8.decode(bytes);
    } on FormatException {
      return null;
    }
  }

  String _normalizeBase64Padding(String encoded) {
    return switch (encoded.length % 4) {
      2 => '$encoded==',
      3 => '$encoded=',
      _ => encoded,
    };
  }
}

/// Provider for per-profile attention feed settings.
final attentionFeedSettingsStoreProvider = Provider<AttentionFeedSettingsStore>(
  (ref) {
    return DriftAttentionFeedSettingsStore(
      ref.watch(appDatabaseProvider),
    );
  },
);

/// Reconciliation signal after a per-profile feed preference changes.
final attentionFeedSettingsRevisionProvider = StateProvider<int>((_) => 0);
