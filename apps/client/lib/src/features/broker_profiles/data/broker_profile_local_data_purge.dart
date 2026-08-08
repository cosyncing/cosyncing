import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Deletes every broker-bound durable row a profile owns — at every endpoint
/// the profile ever pointed at, plus every legacy bare-id row.
///
/// Profile deletion must remove AUTHORITY, not only display state. Scope-keyed
/// rows are unreadable while the profile row is gone, but they are not inert:
/// a profile re-added later must not recover the deleted profile's Drive
/// provenance, retryable outbox and transfer actions, cached transcripts,
/// drafts, roster identities, attention history, negotiated broker identity,
/// and model preferences. Re-adding a profile is a new trust decision with a
/// new incarnation and starts from nothing.
///
/// Run at BOTH ends of a profile's life:
/// - on deletion, where it is mandatory and atomic — see
///   `BrokerProfileManagerController.deleteProfile`;
/// - on first save of a profile id, where it fences a row written by a request
///   that outlived the deletion it raced — see `DriftBrokerProfileRepository`.
///
/// The deletion path also invokes the draft and roster-snapshot repositories
/// through their own documented cleanup seams. Those calls stay: this purge is
/// the backstop that must hold even when a seam is injected or fails, which is
/// why the two tables appear here as well. Every delete is idempotent.
final class BrokerProfileLocalDataPurge {
  /// Creates the purge over [database].
  const BrokerProfileLocalDataPurge(this.database);

  /// App-local durable database.
  final AppDatabase database;

  /// Settings-table key prefixes whose next `:`-delimited segment is the
  /// percent-ENCODED broker scope key.
  static const _encodedScopeKvPrefixes = [
    'attention_badge_seen_cursor:',
    'session_driving_intent:',
    'session_model_preference:',
  ];

  /// Settings-table key prefixes followed directly by the RAW broker scope
  /// key (nothing after it).
  static const _rawScopeKvPrefixes = [
    'broker_identity:',
    'broker_hello:',
  ];

  /// Removes every durable row [profileId] owns, as one atomic unit.
  ///
  /// Atomic because the tables are not independent: a partial purge that kept
  /// Drive provenance or a retryable transfer would leave exactly the durable
  /// authority this exists to revoke, and the caller could not tell which half
  /// landed. Either the profile keeps all of its local data or it keeps none.
  Future<void> deleteForProfile(String profileId) async {
    await database.transaction(() async {
      await _deleteScopeColumnRows(
        profileId,
        database.sessionOutboxRows,
        database.sessionOutboxRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.sessionTranscriptRows,
        database.sessionTranscriptRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.artifactTransferRows,
        database.artifactTransferRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.sessionDraftRows,
        database.sessionDraftRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.rosterSnapshotRows,
        database.rosterSnapshotRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.attentionEventRows,
        database.attentionEventRows.brokerProfileId,
      );
      await _deleteScopeColumnRows(
        profileId,
        database.attentionCursorRows,
        database.attentionCursorRows.brokerProfileId,
      );
      await _deleteSettingRows(profileId);
    });
  }

  /// Deletes rows of [table] whose scope column belongs to [profileId].
  ///
  /// The owned scopes are resolved in Dart, exactly like the draft cleanup:
  /// the encoded scope key can contain SQL LIKE wildcards, so a pattern match
  /// would over-delete.
  Future<void> _deleteScopeColumnRows(
    String profileId,
    TableInfo<Table, Object?> table,
    GeneratedColumn<String> scopeColumn,
  ) async {
    final query = database.selectOnly(table, distinct: true)
      ..addColumns([scopeColumn]);
    final scopes = await query.map((row) => row.read(scopeColumn)).get();
    final owned = [
      for (final scope in scopes)
        if (scope != null &&
            RosterSource.storageKeyBelongsToProfile(scope, profileId))
          scope,
    ];
    if (owned.isEmpty) return;
    await (database.delete(table)..where((_) => scopeColumn.isIn(owned))).go();
  }

  Future<void> _deleteSettingRows(String profileId) async {
    final keyColumn = database.appSettingRows.key;
    final query = database.selectOnly(database.appSettingRows)
      ..addColumns([keyColumn]);
    final keys = await query.map((row) => row.read(keyColumn)).get();
    final doomed = [
      for (final key in keys)
        if (key != null && _settingKeyBelongsToProfile(key, profileId)) key,
    ];
    if (doomed.isEmpty) return;
    await (database.delete(
      database.appSettingRows,
    )..where((row) => row.key.isIn(doomed))).go();
  }

  /// Whether a settings-table key stores broker-bound state [profileId] owns.
  static bool _settingKeyBelongsToProfile(String key, String profileId) {
    if (key == '$openSessionsSettingKeyPrefix$profileId') return true;
    if (key.startsWith(openSessionMembershipSettingKeyPrefix)) {
      final rest = key.substring(openSessionMembershipSettingKeyPrefix.length);
      final end = rest.indexOf(':');
      final encodedScope = end == -1 ? rest : rest.substring(0, end);
      final scope = _decodeHex(encodedScope);
      return scope != null &&
          RosterSource.storageKeyBelongsToProfile(scope, profileId);
    }
    if (key.startsWith(openSessionsActiveHintSettingKeyPrefix)) {
      final scope = _decodeHex(
        key.substring(openSessionsActiveHintSettingKeyPrefix.length),
      );
      return scope != null &&
          RosterSource.storageKeyBelongsToProfile(scope, profileId);
    }
    if (key.startsWith(openSessionsMigrationSettingKeyPrefix)) {
      final owner = _decodeHex(
        key.substring(openSessionsMigrationSettingKeyPrefix.length),
      );
      // Accept the globally one-shot profile marker and PV1's earlier
      // per-source marker so deleting a profile cleans either representation.
      return owner == profileId ||
          (owner != null &&
              RosterSource.storageKeyBelongsToProfile(owner, profileId));
    }
    for (final prefix in _rawScopeKvPrefixes) {
      if (!key.startsWith(prefix)) continue;
      return RosterSource.storageKeyBelongsToProfile(
        key.substring(prefix.length),
        profileId,
      );
    }
    for (final prefix in _encodedScopeKvPrefixes) {
      if (!key.startsWith(prefix)) continue;
      final rest = key.substring(prefix.length);
      final end = rest.indexOf(':');
      final encodedScope = end == -1 ? rest : rest.substring(0, end);
      final String scope;
      try {
        scope = Uri.decodeComponent(encodedScope);
      } on Object {
        // A key this store did not write; leave it alone.
        return false;
      }
      return RosterSource.storageKeyBelongsToProfile(scope, profileId);
    }
    return false;
  }

  static String? _decodeHex(String encoded) {
    if (encoded.isEmpty || encoded.length.isOdd) return null;
    final bytes = <int>[];
    for (var index = 0; index < encoded.length; index += 2) {
      final byte = int.tryParse(
        encoded.substring(index, index + 2),
        radix: 16,
      );
      if (byte == null) return null;
      bytes.add(byte);
    }
    try {
      return utf8.decode(bytes);
    } on Object {
      return null;
    }
  }
}

/// Provider for profile-deletion cleanup of broker-bound local state.
final brokerProfileLocalDataPurgeProvider =
    Provider<BrokerProfileLocalDataPurge>((ref) {
      return BrokerProfileLocalDataPurge(ref.watch(appDatabaseProvider));
    });
