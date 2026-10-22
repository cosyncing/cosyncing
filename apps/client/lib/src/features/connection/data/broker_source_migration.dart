import 'dart:convert';

import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// Complete registry of source columns. New source-owned stores join this list
/// and the profile purge together; address changes never invoke that purge.
const brokerSourceTables = <String>[
  'session_outbox_rows',
  'session_transcript_rows',
  'artifact_transfer_rows',
  'session_draft_rows',
  'roster_snapshot_rows',
  'attention_event_rows',
  'attention_cursor_rows',
];

/// Exact prefix transformations, with separators included where a key has a
/// suffix. Encodings are the existing stores' formats, not SQL LIKE patterns.
Map<String, String> brokerSourceSettingPrefixes(String from, String to) {
  String hex(String value) => utf8
      .encode(value)
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  String b64(String value) =>
      base64Url.encode(utf8.encode(value)).replaceAll('=', '');
  return {
    for (final prefix in [
      'broker_identity:',
      'broker_hello:',
      'open_file_panes_v1:',
      'storage.cleanup.',
    ])
      '$prefix$from': '$prefix$to',
    'attention_badge_seen_cursor:${Uri.encodeComponent(from)}':
        'attention_badge_seen_cursor:${Uri.encodeComponent(to)}',
    for (final prefix in [
      'session_driving_intent:',
      'session_model_preference:',
      'session_model_default:',
      'session_live_state_archived_v2:',
    ])
      '$prefix${Uri.encodeComponent(from)}:':
          '$prefix${Uri.encodeComponent(to)}:',
    'open_session_v2:${hex(from)}:': 'open_session_v2:${hex(to)}:',
    'open_sessions_active_hint_v2:${hex(from)}':
        'open_sessions_active_hint_v2:${hex(to)}',
    'attention_feed_enabled_profile:${b64(from)}':
        'attention_feed_enabled_profile:${b64(to)}',
  };
}

/// Exact keys match only themselves; session-qualified keys include a colon.
bool brokerSourceSettingMatches(String key, String prefix) =>
    key == prefix || (prefix.endsWith(':') && key.startsWith(prefix));

/// Moves an already verified legacy access binding before network activation.
/// Secret slots remain stable opaque references: no credential copy, deletion
/// or window between two secure stores is required for a route-only migration.
final class BrokerSourceMigration {
  /// Shares database and secure references for restart-safe migration.
  BrokerSourceMigration(this.database, this.routes, this.credentials);

  /// App database containing route metadata and source-owned local state.
  final AppDatabase database;

  /// Versioned route store shared with profile migration and proxy editors.
  final BrokerRouteStore routes;

  /// Broker authentication material; attached only after identity verification.
  final CredentialStore credentials;

  /// Resumes prepared local migrations before providers can restore old scopes.
  /// Missing secure storage leaves the legacy profile usable for local work.
  Future<void> recover() async {
    var cursor = 0;
    for (;;) {
      final rows = await database
          .customSelect(
            'SELECT rowid AS position,* FROM broker_route_migrations WHERE '
            "rowid>? AND state='prepared' AND prepared_payload IS NOT NULL "
            'ORDER BY rowid LIMIT 32',
            variables: [Variable(cursor)],
          )
          .get();
      if (rows.isEmpty) return;
      for (final row in rows) {
        final profile = await DriftBrokerProfileRepository(
          database,
        ).getById(row.read<String>('profile'));
        if (profile == null ||
            profile.incarnationId != row.read<String>('incarnation') ||
            profile.credentialKey !=
                row.readNullable<String>('credential_ref')) {
          continue;
        }
        final verified = BrokerRouteServer.fromJson(
          jsonDecode(row.read<String>('prepared_payload'))
              as Map<String, dynamic>,
        );
        final current = await routes.read(profile.id, profile.incarnationId!);
        if (current?.generation != verified.generation) continue;
        try {
          await bind(profile, verified);
        } on Object {
          // Retain the journal and original scope; an explicit Test can retry.
        }
      }
      cursor = rows.last.read<int>('position');
    }
  }

  /// Moves all old source-owned rows after identity/principal verification.
  Future<BrokerProfile> bind(
    BrokerProfile profile,
    BrokerRouteServer verified,
  ) async {
    final identity = verified.sourceIdentity;
    if (identity == null) {
      throw const BrokerRouteException('IDENTITY_NOT_VERIFIED');
    }
    final oldScope = RosterSource.ofProfile(profile).storageKey;
    final next = profile.copyWith(sourceIdentity: identity);
    final newScope = RosterSource.ofProfile(next).storageKey;
    if (oldScope == newScope) return next;
    // A different verified principal is a new boundary, never a migration of
    // authority. The editor must create/confirm a separate access profile.
    if (profile.sourceIdentity != null) {
      throw const BrokerRouteException('PRINCIPAL_CHANGED');
    }
    await database.customStatement(
      'INSERT INTO broker_route_migrations VALUES (?,?,?,?,?,?,?) ON '
      'CONFLICT(profile,incarnation,legacy_scope) DO UPDATE SET '
      "prepared_payload=excluded.prepared_payload WHERE state='prepared' "
      'AND target_scope=excluded.target_scope',
      [
        profile.id,
        profile.incarnationId,
        oldScope,
        newScope,
        profile.credentialKey,
        'prepared',
        jsonEncode(verified.toJson()),
      ],
    );
    if (profile.credentialKey case final key?) {
      final secret = await credentials.readBrokerToken(key);
      if (secret == null || secret.isEmpty) {
        throw BrokerCredentialUnavailableException(profile.id);
      }
    }
    return database.transaction(() async {
      final current = await database
          .customSelect(
            'SELECT incarnation_id, credential_key FROM broker_profile_rows '
            'WHERE id=?',
            variables: [Variable(profile.id)],
          )
          .getSingleOrNull();
      if (current?.readNullable<String>('incarnation_id') !=
              profile.incarnationId ||
          current?.readNullable<String>('credential_key') !=
              profile.credentialKey) {
        throw BrokerProfileRetiredException(profile.id);
      }
      final journal = await database
          .customSelect(
            'SELECT state, target_scope FROM broker_route_migrations WHERE '
            'profile=? AND incarnation=? AND legacy_scope=?',
            variables: [
              Variable(profile.id),
              Variable(profile.incarnationId),
              Variable(oldScope),
            ],
          )
          .getSingle();
      if (journal.read<String>('target_scope') != newScope) {
        throw const BrokerRouteException('MIGRATION_CONFLICT');
      }
      if (journal.read<String>('state') == 'complete') return next;
      for (final table in brokerSourceTables) {
        // The first migration has no target rows. A collision is a deliberate
        // duplicate-merge decision; never use REPLACE on drafts or the outbox.
        final conflict = await database
            .customSelect(
              'SELECT 1 FROM $table WHERE broker_profile_id=? LIMIT 1',
              variables: [Variable(newScope)],
            )
            .getSingleOrNull();
        if (conflict != null) {
          throw const BrokerRouteException('MIGRATION_CONFLICT');
        }
        await database.customStatement(
          'UPDATE $table SET broker_profile_id=? WHERE broker_profile_id=?',
          [newScope, oldScope],
        );
      }
      await database.customStatement(
        'UPDATE roster_snapshot_rows SET endpoint=? WHERE broker_profile_id=?',
        [identity, newScope],
      );
      for (final table in ['managed_device_files', 'device_storage_items']) {
        await database.customStatement(
          'UPDATE $table SET source=? WHERE source=?',
          [newScope, oldScope],
        );
      }
      final prefixes = brokerSourceSettingPrefixes(oldScope, newScope);
      final settings = await database.select(database.appSettingRows).get();
      for (final setting in settings) {
        for (final entry in prefixes.entries) {
          if (!brokerSourceSettingMatches(setting.key, entry.key)) continue;
          final target =
              '${entry.value}${setting.key.substring(entry.key.length)}';
          final conflict = await database
              .customSelect(
                'SELECT 1 FROM app_setting_rows WHERE key=?',
                variables: [Variable(target)],
              )
              .getSingleOrNull();
          if (conflict != null) {
            throw const BrokerRouteException('MIGRATION_CONFLICT');
          }
          await database.customStatement(
            'UPDATE app_setting_rows SET key=? WHERE key=?',
            [target, setting.key],
          );
          break;
        }
      }
      // Updates keeps its finite operation and observations in one JSON row.
      // Retarget only this exact incarnation/access scope, never arbitrary
      // URLs.
      final update = settings.where((s) => s.key == 'updates.v1').firstOrNull;
      if (update != null) {
        final value = jsonDecode(update.value) as Map<String, dynamic>;
        if (value['schemaVersion'] != 1) {
          throw const BrokerRouteException('MIGRATION_CONFLICT');
        }
        final previous = jsonEncode([
          profile.id,
          profile.incarnationId,
          profile.baseUri.toString(),
          profile.credentialKey,
        ]);
        final target = jsonEncode([
          profile.id,
          profile.incarnationId,
          identity,
          profile.credentialKey,
        ]);
        final servers = value['servers'] as Map<String, dynamic>?;
        if (servers?.containsKey(previous) ?? false) {
          if (servers!.containsKey(target)) {
            throw const BrokerRouteException('MIGRATION_CONFLICT');
          }
          servers[target] = servers.remove(previous);
        }
        final operation = value['operation'] as Map<String, dynamic>?;
        for (final step in (operation?['steps'] as List?) ?? const []) {
          if (step is Map && step['scope'] == previous) step['scope'] = target;
        }
        await database.customStatement(
          'UPDATE app_setting_rows SET value=? WHERE key=?',
          [jsonEncode(value), 'updates.v1'],
        );
      }
      await routes.save(verified, expectedGeneration: verified.generation);
      await database.customStatement(
        'UPDATE broker_route_migrations SET '
        "state='complete',prepared_payload=NULL WHERE profile=? AND "
        'incarnation=? AND legacy_scope=?',
        [profile.id, profile.incarnationId, oldScope],
      );
      for (final prefix in prefixes.keys) {
        await database.customStatement(
          'INSERT OR IGNORE INTO broker_retired_setting_prefixes VALUES (?,?)',
          [prefix, profile.id],
        );
      }
      return next;
    });
  }
}
